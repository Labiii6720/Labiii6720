import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis mit einer vorgaenge.json, wie sie ein Neustart mitten im Vorgang hinterlässt
const temp = mkdtempSync(join(tmpdir(), "jarvis-vorgaenge-neustart-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_BASE_URL;

const gesendet: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (url.startsWith("https://api.telegram.org/bot")) {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
    gesendet.push(body.text ?? "");
    return new Response(JSON.stringify({ ok: true, result: { message_id: gesendet.length } }), { headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const jetzt = new Date().toISOString();
mkdirSync("data", { recursive: true });
const VORGAENGE = join(temp, "data", "vorgaenge.json");
writeFileSync(
  VORGAENGE,
  JSON.stringify([
    { id: 1, auftrag: "Längst erledigt", status: "fertig", startedAt: jetzt, finishedAt: jetzt, steps: 3, result: "ok" },
    { id: 2, auftrag: "Alter Eintrag ohne PID", status: "läuft", startedAt: jetzt, steps: 5 },
    // der Elternprozess lebt: so sieht ein Vorgang aus, den der laufende Dienst gerade abarbeitet (npm run check lädt das Modul mit)
    { id: 3, auftrag: "Läuft im Dienst weiter", status: "läuft", startedAt: jetzt, steps: 2, pid: process.ppid },
    // eigene PID: dieser Prozess hat eben erst begonnen, der Eintrag stammt von einem früheren mit derselben Nummer
    { id: 4, auftrag: "Server-Bericht", status: "läuft", startedAt: jetzt, steps: 7, pid: process.pid },
  ]),
);

const vorher = readFileSync(VORGAENGE, "utf8");

const logFehler = console.error;
console.error = () => undefined;
// Wie `npm run check`: der Selbsttest lädt vorgaenge.ts über protokolle → telegram mit
const { selbsttest } = await import("../src/check.js");
const [protokolle] = await selbsttest(["Protokolle"]);
await new Promise((r) => setImmediate(r));
const nachCheck = readFileSync(VORGAENGE, "utf8");
const gesendetNachCheck = [...gesendet];
const { listVorgaenge, unterbrocheneAbschliessen, vorgaenge, vorgaengeNachNeustart, UNTERBROCHEN } = await import("../src/vorgaenge.js");
const statusNachImport = vorgaenge.map((v) => v.status);
type Vorgang = (typeof vorgaenge)[number];
after(() => { console.error = logFehler; });

const CHAT = join(temp, "data", "chat.json");
const notizen = (): string[] =>
  existsSync(CHAT) ? (JSON.parse(readFileSync(CHAT, "utf8")) as { content: unknown }[]).map((m) => (typeof m.content === "string" ? m.content : "")) : [];

async function bis(bedingung: () => boolean): Promise<void> {
  const ende = Date.now() + 3_000;
  while (!bedingung() && Date.now() < ende) await new Promise((r) => setTimeout(r, 5));
  assert.ok(bedingung(), "Bedingung nicht erreicht");
}

describe("Vorgänge nach einem Neustart", () => {
  it("Import und Selbsttest (npm run check) lassen vorgaenge.json unverändert und melden nichts", () => {
    assert.equal(protokolle?.name, "Protokolle");
    assert.equal(nachCheck, vorher, "die Diagnose verändert den Zustand nicht");
    assert.deepEqual(gesendetNachCheck, []);
    assert.deepEqual(statusNachImport, ["fertig", "läuft", "läuft", "läuft"]);
    assert.deepEqual(notizen(), []);
  });

  it("erst der Dienst schliesst ab: Meldung abgelegt, dann gespeichert", async () => {
    const betroffen = await vorgaengeNachNeustart();
    assert.deepEqual(betroffen.map((v) => v.id), [2, 4]);
    // gemeldet ist bereits beim Speichern, nicht erst später
    assert.equal(gesendet.length, 1);
    assert.deepEqual(await vorgaengeNachNeustart(), [], "nur einmal pro Prozess");
  });

  it("unterbrochene Vorgänge gelten als «fehler», nicht mehr als «läuft», und das ist gespeichert", () => {
    const zu = (id: number) => vorgaenge.find((v) => v.id === id)!;
    for (const id of [2, 4]) {
      assert.equal(zu(id).status, "fehler");
      assert.equal(zu(id).result, UNTERBROCHEN);
      assert.ok(zu(id).finishedAt);
    }
    assert.equal(zu(1).status, "fertig");
    assert.equal(zu(1).result, "ok");
    assert.equal(zu(3).status, "läuft", "ein lebender Prozess arbeitet ihn noch ab");
    const gespeichert = JSON.parse(readFileSync(VORGAENGE, "utf8")) as { id: number; status: string; result?: string }[];
    assert.deepEqual(gespeichert.map((v) => v.status), ["fertig", "fehler", "läuft", "fehler"]);
    assert.equal(gespeichert[1]!.result, UNTERBROCHEN);
    assert.ok(!listVorgaenge().includes("#2 läuft"));
    assert.ok(!listVorgaenge().includes("#4 läuft"));
  });

  it("Nutzer und Claude erfahren es einmal", async () => {
    await bis(() => gesendet.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(gesendet, ["⚠️ Vorgänge #2, #4 wurden durch einen Neustart unterbrochen, Ergebnis unklar – bitte prüfen, Sir."]);
    const n = notizen();
    assert.ok(n.some((t) => t.startsWith("[Systemnotiz] Vorgang #2 ") && t.includes("Neustart unterbrochen") && t.includes("Ergebnis unklar")));
    assert.ok(n.some((t) => t.startsWith("[Systemnotiz] Vorgang #4 ") && t.includes("nach 7 Schritten")));
    assert.ok(!n.some((t) => t.includes("Vorgang #3 ") || t.includes("Vorgang #1 ")));
  });

  it("vor dem Systemstart begonnen: unterbrochen, auch wenn die PID inzwischen neu vergeben ist", () => {
    const jetztZeit = new Date("2026-10-11T12:00:00Z");
    const liste: Vorgang[] = [
      { id: 1, auftrag: "a", status: "läuft", startedAt: "2026-10-11T08:00:00Z", steps: 1, pid: 4242 },
      { id: 2, auftrag: "b", status: "läuft", startedAt: "2026-10-11T11:00:00Z", steps: 1, pid: 4242 },
      { id: 3, auftrag: "c", status: "läuft", startedAt: "2026-10-11T11:00:00Z", steps: 1, pid: 5151 },
      { id: 4, auftrag: "d", status: "fehler", startedAt: "2026-10-11T07:00:00Z", steps: 1, result: "x" },
    ];
    const betroffen = unterbrocheneAbschliessen(liste, {
      jetzt: jetztZeit,
      bootZeit: new Date("2026-10-11T10:00:00Z"),
      eigenePid: 1,
      lebt: (pid) => pid === 4242,
    });
    assert.deepEqual(betroffen.map((v) => v.id), [1, 3]);
    assert.deepEqual(liste.map((v) => v.status), ["fehler", "läuft", "fehler", "fehler"]);
    assert.equal(liste[0]!.finishedAt, jetztZeit.toISOString());
    assert.equal(liste[3]!.result, "x", "Abgeschlossenes bleibt unberührt");
  });
});
