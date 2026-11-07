import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

// Von Hand verdorbene data/auftraege.json und data/rechnungen.json: gültiges JSON, aber einzelne Einträge sind null,
// Zahlen oder ohne Pflichtfelder. Früher warfen /status.json, /api/auftraege, /api/finanzen, /status und jede Freigabe
// (a.status auf null). Jetzt fallen nur diese Einträge weg (Sicherung, Hinweis), und keine Auftragsnummer aus der
// Sicherung wird neu vergeben (alte Telegram-Knöpfe «ok:<id>» träfen sonst einen neuen Auftrag).
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-auftraege-rechnungen-"));
process.chdir(temp);
// Im Temp-Ordner bleiben bis zum Prozessende (spätes Schreiben landet nie im Projekt), dann aufräumen
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-attrappe-nur-fuer-tests";

const gesendet: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  if (body.text !== undefined) gesendet.push(body.text);
  return new Response(JSON.stringify({ ok: true, result: { message_id: 40 + gesendet.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const AUFTRAG = { id: 3, createdAt: "2026-10-14T08:00:00.000Z", tool: "mail_senden", input: { an: "geheim@example.org" }, stufe: "extern", summary: "geheim-mail", status: "offen" };
const AUFTRAEGE = [AUFTRAG, null, 7, { id: 9, tool: "geheim-tool", status: "offen" }];
const RECHNUNG = { id: 2, erkanntAm: "2026-10-01T08:00:00.000Z", empfaenger: "geheim-Swisscom", betrag: 89, waehrung: "CHF", status: "offen", faellig: "2026-10-30" };
const RECHNUNGEN = [RECHNUNG, null, { id: 5, empfaenger: "geheim-x", waehrung: "CHF", status: "offen", betrag: "89" }, { id: 4, empfaenger: "geheim-y", waehrung: "CHF", status: "offen", faellig: 20261030 }];
const ORIGINAL = { auftraege: JSON.stringify(AUFTRAEGE), rechnungen: JSON.stringify(RECHNUNGEN) };
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "auftraege.json"), ORIGINAL.auftraege);
writeFileSync(join(temp, "data", "rechnungen.json"), ORIGINAL.rechnungen);

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const telegram = await import("../src/telegram.js");
const queue = await import("../src/queue.js");
const finanzen = await import("../src/finanzen.js");
const dashboard = await import("../src/dashboard.js");
const { selbsttest } = await import("../src/check.js");
const { state } = await import("../src/state.js");
console.error = origErr;
telegram.setzeWarten(async () => {}, () => 0.5, async () => {});

type Antwort = { statusCode: number; body: unknown; status(c: number): Antwort; json(b: unknown): Antwort };
const antwort = (): Antwort => ({ statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const ohneGeheimes = (texte: string[]) => assert.ok(!texte.some((t) => t.includes("geheim-tool") || t.includes("geheim-x") || t.includes("geheim-y")), texte.join("\n"));

describe("auftraege.json und rechnungen.json mit ungültigen Einträgen", () => {
  it("Import wirft nicht, nichts gesperrt, nur die gültigen sind geladen", () => {
    assert.equal(queue.auftraegeNichtGeladen, false);
    assert.equal(finanzen.rechnungenNichtGeladen, false);
    assert.deepEqual(queue.auftraege, [AUFTRAG]);
    assert.deepEqual(finanzen.rechnungen, [RECHNUNG]);
  });

  it("beide Dateien gesichert (600), Log nur mit Anzahl, Hinweise in dateiHinweise", () => {
    for (const [datei, inhalt] of [["auftraege.json", ORIGINAL.auftraege], ["rechnungen.json", ORIGINAL.rechnungen]] as const) {
      const sicherung = join(temp, "data", `${datei}.defekt`);
      assert.equal(readFileSync(sicherung, "utf8"), inhalt, datei);
      assert.equal(statSync(sicherung).mode & 0o777, 0o600);
      assert.equal(readFileSync(join(temp, "data", datei), "utf8"), inhalt, "beim Start bleibt die Datei unverändert");
    }
    assert.ok(fehler.some((f) => f.startsWith("Aufträge: 3 ungültige Einträge übersprungen (Sicherung unter data/auftraege.json.defekt)")), fehler.join("\n"));
    assert.ok(fehler.some((f) => f.startsWith("Rechnungen: 3 ungültige Einträge übersprungen (Sicherung unter data/rechnungen.json.defekt)")), fehler.join("\n"));
    ohneGeheimes(fehler);
    const hinweise = telegram.dateiHinweise();
    assert.ok(hinweise.some((h) => h.startsWith("⚠️ data/auftraege.json: 3 ungültige Einträge beim Start übersprungen, Sir (Sicherung unter data/auftraege.json.defekt)")));
    assert.ok(hinweise.some((h) => h.startsWith("⚠️ data/rechnungen.json: 3 ungültige Einträge beim Start übersprungen, Sir (Sicherung unter data/rechnungen.json.defekt)")));
  });

  it("/status.json, /api/auftraege und /api/finanzen antworten mit 200", () => {
    const st = antwort();
    dashboard.statusJson({ params: {}, query: {} } as never, st as never);
    assert.equal(st.statusCode, 200);
    const sb = st.body as { auftraege: { id: number }[]; rechnungen: { id: number }[]; auftraegeUnlesbar: boolean };
    assert.deepEqual(sb.auftraege.map((a) => a.id), [3]);
    assert.deepEqual(sb.rechnungen.map((r) => r.id), [2]);
    assert.equal(sb.auftraegeUnlesbar, false);
    const au = antwort();
    dashboard.auftraegeJson({ params: {}, query: {} } as never, au as never);
    assert.equal(au.statusCode, 200);
    assert.deepEqual((au.body as { auftraege: { id: number }[] }).auftraege.map((a) => a.id), [3]);
    assert.equal((au.body as { unlesbar?: boolean }).unlesbar, undefined);
    const fi = antwort();
    dashboard.finanzenJson({ params: {}, query: {} } as never, fi as never);
    assert.equal(fi.statusCode, 200);
    assert.deepEqual((fi.body as { offen: { anzahl: number } }).offen.anzahl, 1);
  });

  it("npm run check: Befund «Listen» nennt Aufträge und Rechnungen mit Anzahl", async () => {
    const [b] = await selbsttest(["Listen"]);
    assert.equal(b?.status, "fehler");
    assert.equal(b!.info, "ungültig: Aufträge 3, Rechnungen 3; Sicherung je .defekt");
  });

  it("/status, /auftraege und /finanzen laufen", async () => {
    gesendet.length = 0;
    await telegram.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 12345 }, text: "/status" } });
    assert.match(gesendet[0]!, /data\/auftraege\.json: 3 ungültige Einträge/);
    assert.match(gesendet[0]!, /Offene Aufträge: 1\n/);
    gesendet.length = 0;
    await telegram.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: 12345 }, text: "/auftraege" } });
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0]!, /^🟠 Auftrag #3 · Stufe extern/);
    gesendet.length = 0;
    await telegram.handleUpdate({ update_id: 3, message: { message_id: 3, chat: { id: 12345 }, text: "/finanzen" } });
    assert.match(gesendet[0]!, /Offen: 1 Rechnung/);
    ohneGeheimes(gesendet);
  });

  it("Freigabe-Knopf «Ablehnen» läuft; die Sicherung bewahrt die verworfenen Einträge", async () => {
    gesendet.length = 0;
    await telegram.handleUpdate({ update_id: 4, callback_query: { id: "cb", data: "nein:3", from: { id: 12345 } } });
    assert.ok(gesendet.includes("❌ #3 abgelehnt."), gesendet.join("\n"));
    const gespeichert = JSON.parse(readFileSync(join(temp, "data", "auftraege.json"), "utf8")) as { id: number; status: string }[];
    assert.deepEqual(gespeichert.map((a) => [a.id, a.status]), [[3, "abgelehnt"]]);
    assert.equal(readFileSync(join(temp, "data", "auftraege.json.defekt"), "utf8"), ORIGINAL.auftraege);
  });

  it("vor dem Speichern hält state.json die Untergrenze fest: nach einem Neustart bekommt der nächste Auftrag nicht #4 (oder #9), sondern #10", () => {
    assert.equal(state.naechsteAuftragId, 10);
    assert.equal((JSON.parse(readFileSync(join(temp, "data", "state.json"), "utf8")) as { naechsteAuftragId?: number }).naechsteAuftragId, 10);
    // Neustart: frischer Prozess im selben Ordner; die verworfenen Einträge stehen nur noch in der Sicherung
    const code = `const q = await import(${JSON.stringify(pathToFileURL(join(projekt, "src", "queue.ts")).href)}); console.log(q.createAuftrag({ tool: "t", input: {}, stufe: "extern", summary: "s" }).id);`;
    const kind = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code], { cwd: temp, encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    assert.equal(kind.status, 0, kind.stderr);
    assert.equal(kind.stdout.trim(), "10");
  });

  it("eine neue Rechnung bekommt keine Nummer aus der Sicherung (höchste verworfene: 5)", () => {
    const r = finanzen.addRechnung({ empfaenger: "Test", waehrung: "CHF", betrag: 10 });
    assert.equal(r.id, 6);
    const gespeichert = JSON.parse(readFileSync(join(temp, "data", "rechnungen.json"), "utf8")) as { id: number }[];
    assert.deepEqual(gespeichert.map((x) => x.id), [2, 6]);
    assert.equal(readFileSync(join(temp, "data", "rechnungen.json.defekt"), "utf8"), ORIGINAL.rechnungen);
  });
});
