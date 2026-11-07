import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Vorgangsnummern verworfener Einträge: save() schreibt sie nicht zurück. Ohne Untergrenze in state.json vergab
// startVorgang() sie nach dem nächsten Neustart neu, obwohl «#9» in der .defekt-Sicherung und in Systemnotizen steht.
// Der Neustart ist ein zweiter Prozess im selben Temp-Ordner (der Lader läuft nur einmal je Import).
const temp = mkdtempSync(join(tmpdir(), "jarvis-vorgaenge-nummer-neustart-"));
process.chdir(temp);
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
  throw new Error("kein Netz im Test");
}) as typeof fetch;

const DATEI = join(temp, "data", "vorgaenge.json");
const STATE = join(temp, "data", "state.json");
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(
  DATEI,
  JSON.stringify([
    { id: 9, status: "fertig" }, // von Hand verdorben (ohne auftrag): verworfen
    { id: 5, auftrag: "läuft ohne PID", status: "läuft", startedAt: "2026-10-01T08:00:00.000Z", steps: 2 },
  ]),
);

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const vorgangMod = await import("../src/vorgaenge.js");
console.error = origErr;

const LADER = import.meta.resolve("tsx");
const VORGAENGE = new URL("../src/vorgaenge.ts", import.meta.url).href;
const TELEGRAM = new URL("../src/telegram.ts", import.meta.url).href;

/** Neuer Prozess im selben Ordner, ohne Netz: lädt vorgaenge.json und state.json frisch und startet einen Vorgang. */
function neustartUndStarten(): number {
  const code =
    `globalThis.fetch = async () => { throw new Error("kein Netz im Test"); };` +
    `console.error = () => {};` +
    `const v = await import(${JSON.stringify(VORGAENGE)}); const { hooks } = await import(${JSON.stringify(TELEGRAM)});` +
    `process.stdout.write(String(v.startVorgang("neu", hooks).id)); process.exit(0);`;
  const r = spawnSync(process.execPath, ["--import", LADER, "--input-type=module", "-e", code], { cwd: temp, encoding: "utf8", env: { ...process.env } });
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout.trim());
}

const ids = (): number[] => (JSON.parse(readFileSync(DATEI, "utf8")) as { id: number }[]).map((v) => v.id);
const zaehler = (): number | undefined => (JSON.parse(readFileSync(STATE, "utf8")) as { naechsteVorgangId?: number }).naechsteVorgangId;

describe("Vorgangsnummern über den Neustart", () => {
  it("lädt nur die gültige #5 und meldet die verworfene", () => {
    assert.deepEqual(vorgangMod.vorgaenge.map((v) => v.id), [5]);
    assert.ok(fehler.some((f) => f.includes("Vorgänge") && f.includes("übersprungen")));
  });

  it("merkt sich beim Abschluss nach dem Neustart die Nummer über der verworfenen #9", async () => {
    console.error = () => {};
    try {
      const betroffen = await vorgangMod.vorgaengeNachNeustart();
      assert.deepEqual(betroffen.map((v) => v.id), [5]);
    } finally {
      console.error = origErr;
    }
    assert.deepEqual(ids(), [5]);
    assert.equal(zaehler(), 10);
  });

  it("vergibt nach dem nächsten Neustart #10, nicht die verworfene #9 oder #6", () => {
    assert.equal(neustartUndStarten(), 10);
    assert.deepEqual(ids(), [5, 10]);
    assert.equal(zaehler(), 11);
  });

  it("bleibt eindeutig, wenn vorgaenge.json danach entfernt wurde", () => {
    rmSync(DATEI);
    assert.equal(neustartUndStarten(), 11);
    assert.deepEqual(ids(), [11]);
  });
});
