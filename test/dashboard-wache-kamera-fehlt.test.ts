import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// Eigene Datei: cameras.json und data/wachen.json werden nur einmal beim Import gelesen. Hier stehen dynamische Wachen
// auf einer verworfenen Kamera («garten»: null), auf einer aus cameras.json entfernten («carport») und auf Namen aus
// dem Objekt-Prototyp («toString», «__proto__»). wachenTick überspringt sie alle; die Kommandozentrale darf sie nicht
// als laufend zeigen.
const temp = mkdtempSync(join(tmpdir(), "jarvis-wache-kamera-fehlt-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.FRIGATE_URL = "http://frigate.attrappe";
process.env.RUECKBLICK = "off";
process.env.RECHNUNG_ERINNERUNG = "off";
process.env.ZIELCHECK = "off";
process.env.VERDICHTUNG = "off";

mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "routinen.json"), "{}");
writeFileSync(
  join(temp, "data", "wachen.json"),
  JSON.stringify([
    { id: 1, kamera: "garten", frage: "Paket?", alle_minuten: 10 },
    { id: 2, kamera: "hof", frage: "Tor offen?", alle_minuten: 15 },
    { id: 3, kamera: "carport", frage: "Auto da?", alle_minuten: 20 },
    { id: 4, kamera: "toString", frage: "Prototyp?", alle_minuten: 25 },
    // Intervall als Zahl, aber ungültig: bleibt stehen und läuft nicht (fehlt das Feld, fällt der Eintrag beim Laden weg)
    { id: 5, kamera: "garten", frage: "Ohne alles?", alle_minuten: 0 },
    { id: 6, kamera: "hof", frage: "Ohne Takt?", alle_minuten: -1 },
    // Ohne «kamera» als Text: fällt beim Laden weg (Eintragsprüfung in datei.ts)
    { id: 7, frage: "Ohne Kamera?", alle_minuten: 30 },
  ]),
);
writeFileSync(join(temp, "cameras.json"), JSON.stringify({ garten: null, hof: { frigate: "hof_cam", beschreibung: "Innenhof" } }));

const echteFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error("unerwarteter Netzaufruf"); }) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const origErr = console.error;
console.error = () => {};
const kameras = await import("../src/cameras.js");
console.error = origErr;
const { statusJson, wachenJson } = await import("../src/dashboard.js");

type Req = Parameters<typeof statusJson>[0];
type Res = Parameters<typeof statusJson>[1];
function antwort() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}
const req = () => ({ params: {}, query: {} }) as unknown as Req;
type W = { id?: number; kamera?: string; frage: string; alle_minuten: number | null; laeuft: boolean; grund?: string };

describe("Wachen auf einer fehlenden oder verworfenen Kamera", () => {
  it("Ausgangslage: «garten» ist verworfen, die Wachen bleiben in der Liste", () => {
    assert.deepEqual(Object.keys(kameras.cameras), ["hof"]);
    assert.deepEqual(kameras.dynamicWachen.map((w) => w.id), [1, 2, 3, 4, 5, 6]);
    assert.equal(kameras.wachenNichtGeladen, false);
    assert.ok(existsSync(join(temp, "data", "wachen.json.defekt")), "die Wache ohne Kamera liegt in der Sicherung");
  });

  it("/api/wachen: laeuft false und «grund» nennt die Ursache; das Intervall bleibt sichtbar", () => {
    const wa = antwort();
    wachenJson(req(), wa as unknown as Res);
    assert.equal(wa.statusCode, 200);
    const wachen = (wa.body as { wachen: W[] }).wachen;
    assert.deepEqual(
      wachen.map((w) => [w.id, w.alle_minuten, w.laeuft, w.grund]),
      [
        [1, 10, false, "Kamera fehlt"],
        [2, 15, true, undefined],
        [3, 20, false, "Kamera fehlt"],
        [4, 25, false, "Kamera fehlt"],
        [5, null, false, "Kamera und Intervall fehlen"],
        [6, null, false, "Intervall fehlt"],
      ],
    );
    // Eine laufende Wache trägt kein Feld «grund»
    assert.ok(!("grund" in wachen[1]!));
  });

  it("/status.json zählt nur die Wache, die wirklich hinschaut", () => {
    const st = antwort();
    statusJson(req(), st as unknown as Res);
    assert.equal(st.statusCode, 200);
    const wachen = (st.body as { wachen: W[] }).wachen;
    assert.deepEqual(wachen.filter((w) => w.laeuft !== false).map((w) => [w.kamera, w.frage]), [["hof", "Tor offen?"]]);
    assert.equal(wachen.find((w) => w.frage === "Paket?")?.grund, "Kamera fehlt");
  });

  it("Wache ohne «kamera» (von Hand bearbeitet): zweite Verteidigung, kamera \"\" statt eines fehlenden Felds, nirgends «undefined»", (t) => {
    // Beim Laden fällt sie weg; käme sie trotzdem in die Liste, zeigt die Kommandozentrale sie ohne «undefined»
    const ohneKamera = { id: 7, frage: "Ohne Kamera?", alle_minuten: 30 } as unknown as (typeof kameras.dynamicWachen)[number];
    kameras.dynamicWachen.push(ohneKamera);
    t.after(() => { kameras.dynamicWachen.splice(kameras.dynamicWachen.indexOf(ohneKamera), 1); });
    const wa = antwort();
    wachenJson(req(), wa as unknown as Res);
    const w7 = (wa.body as { wachen: W[] }).wachen.find((w) => w.id === 7)!;
    assert.ok("kamera" in w7, "kamera fehlt in /api/wachen");
    assert.equal(w7.kamera, "");
    assert.equal(w7.grund, "Kamera fehlt");
    // Über die Leitung (JSON.stringify liesse undefined weg) bleibt das Feld als Zeichenkette erhalten
    const ueberLeitung = JSON.parse(JSON.stringify(wa.body)) as { wachen: W[] };
    assert.equal(ueberLeitung.wachen.find((w) => w.id === 7)?.kamera, "");
    assert.ok(ueberLeitung.wachen.every((w) => typeof w.kamera === "string"));

    const st = antwort();
    statusJson(req(), st as unknown as Res);
    const s7 = JSON.parse(JSON.stringify(st.body)) as { wachen: W[] };
    assert.equal(s7.wachen.find((w) => w.frage === "Ohne Kamera?")?.kamera, "");
    assert.ok(s7.wachen.every((w) => typeof w.kamera === "string"));
    assert.ok(!JSON.stringify(s7.wachen).includes("undefined"));
  });
});
