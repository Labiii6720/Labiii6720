import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// Eigene Datei: cameras.json und data/wachen.json werden nur einmal beim Import gelesen. Hier fehlt allen Wachen eine
// brauchbare «frage». Ohne Text (fehlend, Zahl) fallen sie schon beim Laden weg (Eintragsprüfung in datei.ts); als
// Leertext bleiben sie stehen. Ohne Prüfung ginge alle 30 Minuten ein Standbild mit der Frage «undefined» bzw. ohne
// Frage an die API (Leitplanke 9); Kommandozentrale, wachen_anzeigen und Selbsttest dürfen sie nicht als laufend zeigen.
const temp = mkdtempSync(join(tmpdir(), "jarvis-wache-ohne-frage-"));
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
    { id: 1, kamera: "hof", alle_minuten: 30 },
    { id: 2, kamera: "hof", frage: "  ", alle_minuten: 30 },
    { id: 3, kamera: "hof", frage: 7, alle_minuten: 30 },
    { id: 4, kamera: "hof", frage: "", alle_minuten: 30 },
    { id: 5, kamera: "hof", frage: "\n\t", alle_minuten: 30 },
  ]),
);
writeFileSync(join(temp, "cameras.json"), JSON.stringify({ hof: { frigate: "hof_cam", beschreibung: "Hof", wachen: [{ alle_minuten: 30 }, { frage: " ", alle_minuten: 30 }] } }));

const echteFetch = globalThis.fetch;
let netz = 0;
globalThis.fetch = (async () => { netz++; throw new Error("unerwarteter Netzaufruf"); }) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const kameras = await import("../src/cameras.js");
console.error = origErr;
const { wachenJson } = await import("../src/dashboard.js");
const { selbsttest } = await import("../src/check.js");
const tools = await import("../src/tools.js");
const { wachenTick } = await import("../src/watch.js");

type Req = Parameters<typeof wachenJson>[0];
type Res = Parameters<typeof wachenJson>[1];
function antwort() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}
const req = () => ({ params: {}, query: {} }) as unknown as Req;

describe("Wachen ohne «frage»", () => {
  it("wacheZustand: «Frage fehlt», laeuft false", () => {
    const alle = kameras.allWachen();
    assert.equal(alle.length, 4);
    for (const w of alle) {
      assert.deepEqual(kameras.wacheZustand(w), { takt: 30, laeuft: false, grund: "Frage fehlt" });
      assert.equal(kameras.wacheLaeuft(w), false);
    }
  });

  it("beim Laden laut gemeldet: Herkunft, Kamera und Anzahl", () => {
    const text = fehler.join("\n");
    assert.match(text, /cameras\.json: 1 Wache\(n\) bei Kamera «hof» ohne «frage»/);
    assert.match(text, /data\/wachen\.json: 3 Wache\(n\) bei Kamera «hof» ohne «frage»/);
  });

  it("«frage» ohne Text (fehlend, Zahl): beim Laden übersprungen und gezählt, die übrigen bleiben", () => {
    const text = fehler.join("\n");
    assert.match(text, /Wachen: 2 ungültige Einträge übersprungen \(Sicherung unter data\/wachen\.json\.defekt\)/);
    assert.match(text, /cameras\.json: 1 ungültige\(r\) Wachen-Eintrag\/Einträge bei Kamera «hof» übersprungen/);
    assert.deepEqual(kameras.dynamicWachen.map((w) => w.id), [2, 4, 5]);
    assert.equal(kameras.wachenNichtGeladen, false);
  });

  it("der Takt schaut nicht hin: weder Frigate noch Claude", async () => {
    const t = Date.UTC(2026, 9, 15, 10, 0);
    const vorher = netz;
    const meldungen: string[] = [];
    const origE = console.error;
    console.error = (...a: unknown[]) => { meldungen.push(a.map(String).join(" ")); };
    try {
      await wachenTick(t);
      await wachenTick(t + 31 * 60_000);
    } finally {
      console.error = origE;
    }
    assert.equal(netz, vorher);
    assert.ok(meldungen.some((m) => m.includes("Wache bei Kamera «hof» ohne «frage»")), meldungen.join("\n"));
    assert.ok(meldungen.every((m) => !m.includes("undefined")), meldungen.join("\n"));
  });

  it("/api/wachen: laeuft false mit Grund «Frage fehlt»", () => {
    const wa = antwort();
    wachenJson(req(), wa as unknown as Res);
    assert.equal(wa.statusCode, 200);
    const wachen = (wa.body as { wachen: { laeuft: boolean; grund?: string }[] }).wachen;
    assert.equal(wachen.length, 4);
    for (const w of wachen) {
      assert.equal(w.laeuft, false);
      assert.equal(w.grund, "Frage fehlt");
    }
  });

  it("npm run check zählt sie nicht als aktiv und nennt den Grund", async () => {
    const [b] = await selbsttest(["Wachen"]);
    assert.equal(b?.info, "0 Wache(n) aktiv, 4 ohne Frage (laufen nicht)");
  });

  it("wachen_anzeigen nennt «läuft nicht: Frage fehlt»", async () => {
    const t = tools.toolByName("wachen_anzeigen");
    assert.ok(t);
    const ctx = { sendFile: async () => {}, sendPhoto: async () => {}, sendVideo: async () => {} };
    const liste = String(await t.run({}, ctx as never));
    assert.match(liste, /\(läuft nicht: Frage fehlt\)/);
    assert.doesNotMatch(liste, /undefined/);
  });
});
