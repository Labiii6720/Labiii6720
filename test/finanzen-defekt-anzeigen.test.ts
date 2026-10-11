import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// Eigene Datei: finanzen.ts lädt rechnungen.json nur einmal beim Import, hier kaputt im Temp-Verzeichnis.
// Erinnerung, Wochenbericht, Dashboard, Werkzeug und Selbsttest dürfen daraus keine leere Liste machen.
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-finanzen-anzeigen-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.ZEITPLAN_NACHHOLEN_MIN = "60";
process.env.RECHNUNG_ERINNERUNG = "08:30";
process.env.FINANZBERICHT = "mo 07:45";
process.env.RUECKBLICK = "off";
process.env.ZIELCHECK = "off";
process.env.VERDICHTUNG = "off";

mkdirSync(join(temp, "data"), { recursive: true });
// Bestehende routinen.json: kein Erststart
writeFileSync(join(temp, "data", "routinen.json"), "{}");
const KAPUTT = '[{"id": 1, "empfaenger": "Steueramt", "betrag": 4200, "waehrung": "CHF", "status": "offen", "faellig": "2026-10-13"},';
writeFileSync(join(temp, "data", "rechnungen.json"), KAPUTT);

globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

const origErr = console.error;
const fehlerLog: string[] = [];
console.error = (...a: unknown[]) => { fehlerLog.push(a.map(String).join(" ")); };
const { RECHNUNGEN_UNLESBAR, rechnungenNichtGeladen } = await import("../src/finanzen.js");
const { abhaengigkeiten, finanzberichtTick, rechnungsTick } = await import("../src/scheduler.js");
const { finanzenJson, statusJson } = await import("../src/dashboard.js");
const { toolByName } = await import("../src/tools.js");
const { selbsttest } = await import("../src/check.js");
const { state } = await import("../src/state.js");
console.error = origErr;

/** 12.10.2026 Montag, 13.10.2026 Dienstag (lokale Zeit Europe/Zurich) */
const am = (tag: number, h: number, m: number) => new Date(2026, 9, tag, h, m, 0, 0);
const ROUTINEN = join(temp, "data", "routinen.json");

let gesendet: { text: string; opts?: unknown }[] = [];
let sendFehler: Error | undefined;
abhaengigkeiten.sendeSpaeter = (async (text: string, opts?: unknown) => {
  if (sendFehler) {
    const f = sendFehler;
    sendFehler = undefined;
    throw f;
  }
  gesendet.push({ text, opts });
}) as typeof abhaengigkeiten.sendeSpaeter;

beforeEach(() => {
  gesendet = [];
  sendFehler = undefined;
  state.paused = false;
  state.notfall = { aktiv: false };
});

function antwort() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}

describe("unlesbares data/rechnungen.json: kein stilles «nichts fällig»", () => {
  it("Vorbedingung: Datei als unlesbar erkannt", () => {
    assert.equal(rechnungenNichtGeladen, true);
    assert.match(RECHNUNGEN_UNLESBAR, /war beim Start unlesbar, Sir/);
  });

  it("Rechnungs-Erinnerung meldet den Defekt einmal am Tag, im Notfall zurückgehalten", async () => {
    await rechnungsTick(am(12, 8, 30));
    assert.equal(gesendet.length, 1);
    assert.equal(gesendet[0].text, RECHNUNGEN_UNLESBAR);
    assert.deepEqual(gesendet[0].opts, { imNotfallZurueckhalten: true });
    assert.equal((JSON.parse(readFileSync(ROUTINEN, "utf8")) as { rechnungen?: string }).rechnungen, "2026-10-12");
    await rechnungsTick(am(12, 8, 40));
    assert.equal(gesendet.length, 1, "nur einmal am Tag");
  });

  it("Rechnungs-Erinnerung hakt nach gescheitertem Senden nicht ab und versucht es später erneut", async () => {
    const stumm = console.error;
    console.error = () => undefined;
    try {
      sendFehler = new Error("Postausgang voll");
      await rechnungsTick(am(13, 8, 30));
      assert.equal(gesendet.length, 0);
      assert.notEqual((JSON.parse(readFileSync(ROUTINEN, "utf8")) as { rechnungen?: string }).rechnungen, "2026-10-13");
      await rechnungsTick(am(13, 8, 32));
      assert.equal(gesendet.length, 0, "frühestens nach 5 Minuten erneut");
      await rechnungsTick(am(13, 8, 36));
      assert.equal(gesendet.length, 1);
      assert.equal(gesendet[0].text, RECHNUNGEN_UNLESBAR);
      assert.equal((JSON.parse(readFileSync(ROUTINEN, "utf8")) as { rechnungen?: string }).rechnungen, "2026-10-13");
    } finally {
      console.error = stumm;
    }
  });

  it("Finanz-Wochenbericht meldet den Defekt statt still abzuhaken", async () => {
    await finanzberichtTick(am(12, 7, 45));
    assert.equal(gesendet.length, 1);
    assert.equal(gesendet[0].text, RECHNUNGEN_UNLESBAR);
    assert.deepEqual(gesendet[0].opts, { imNotfallZurueckhalten: true });
    assert.equal((JSON.parse(readFileSync(ROUTINEN, "utf8")) as { finanzbericht?: string }).finanzbericht, "2026-10-12");
    await finanzberichtTick(am(12, 7, 50));
    assert.equal(gesendet.length, 1);
  });

  it("im Notaus meldet keiner der beiden Läufe etwas", async () => {
    state.paused = true;
    await rechnungsTick(am(19, 8, 30));
    await finanzberichtTick(am(19, 7, 45));
    assert.deepEqual(gesendet, []);
  });

  it("Dashboard /api/finanzen antwortet mit 503 und dem Hinweis", () => {
    const res = antwort();
    finanzenJson({} as never, res as never);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { ok: false, error: "rechnungen_unlesbar", text: RECHNUNGEN_UNLESBAR });
  });

  it("Dashboard /api/finanzen bleibt im Notfall bei 423", () => {
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    const res = antwort();
    finanzenJson({} as never, res as never);
    assert.equal(res.statusCode, 423);
  });

  it("Dashboard /status.json kennzeichnet die leere Rechnungsliste", () => {
    const res = antwort();
    statusJson({} as never, res as never);
    const b = res.body as { rechnungen: unknown[]; rechnungenUnlesbar?: boolean };
    assert.deepEqual(b.rechnungen, []);
    assert.equal(b.rechnungenUnlesbar, true);
  });

  it("Werkzeug rechnungen_offen meldet den Defekt statt «Keine offenen Rechnungen.»", async () => {
    const t = toolByName("rechnungen_offen");
    assert.ok(t);
    const ctx = { sendFile: async () => {}, sendPhoto: async () => {}, sendVideo: async () => {} } as never;
    assert.equal(await t.run({}, ctx), RECHNUNGEN_UNLESBAR);
    await assert.rejects(toolByName("zahlung_vorbereiten")!.run({ id: 1 }, ctx), /war beim Start unlesbar/);
    await assert.rejects(toolByName("rechnung_status")!.run({ id: 1, status: "bezahlt" }, ctx), /war beim Start unlesbar/);
    assert.equal(readFileSync(join(temp, "data", "rechnungen.json"), "utf8"), KAPUTT);
  });

  it("Selbsttest: Befund «Finanzen» ist ein Fehler mit Reparatur-Hinweis", async () => {
    const [b] = await selbsttest(["Finanzen"]);
    assert.equal(b.name, "Finanzen");
    assert.equal(b.status, "fehler");
    assert.equal(b.info, "data/rechnungen.json unlesbar (Sicherung .defekt), bitte reparieren und neu starten");
  });
});
