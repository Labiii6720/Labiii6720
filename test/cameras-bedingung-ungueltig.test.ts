import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// Eigene Datei: cameras.json und data/wachen.json werden nur einmal beim Import gelesen. Hier stehen Wachen mit
// ungültigem «nur_wenn» («Nacht», null) in cameras.json und data/wachen.json sowie ein «melden» mit ungültiger Bedingung.
// Sie schauen nie hin (watch.ts); Kommandozentrale, wachen_anzeigen und Selbsttest dürfen sie nicht als laufend zeigen.
const temp = mkdtempSync(join(tmpdir(), "jarvis-bedingung-ungueltig-"));
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
    { id: 1, kamera: "hof", frage: "Geheime Frage C?", alle_minuten: 5, nur_wenn: "nachts" },
    { id: 2, kamera: "hof", frage: "Läuft?", alle_minuten: 5, nur_wenn: "abwesend" },
    // Kamera fehlt geht vor der Bedingung (Reihenfolge wie im Takt)
    { id: 3, kamera: "garten", frage: "Garten?", alle_minuten: 5, nur_wenn: "Nacht" },
    // Intervall 0 (Zahl, aber ungültig): bleibt beim Laden stehen, läuft nicht. Fehlt «alle_minuten» ganz, fällt der
    // Eintrag schon beim Laden weg (wachen-eintraege.test.ts)
    { id: 4, kamera: "hof", frage: "Ohne Takt?", alle_minuten: 0, nur_wenn: 7 },
  ]),
);
writeFileSync(
  join(temp, "cameras.json"),
  JSON.stringify({
    hof: {
      frigate: "hof_cam",
      beschreibung: "Innenhof",
      melden: { labels: ["person"], nur_wenn: "Nachts-Rohwert" },
      wachen: [{ frage: "Jemand da?", alle_minuten: 5, nur_wenn: "Nacht" }, { frage: "Tor?", alle_minuten: 5, nur_wenn: null }],
    },
  }),
);

const echteFetch = globalThis.fetch;
let netz = 0;
globalThis.fetch = (async () => { netz++; throw new Error("unerwarteter Netzaufruf"); }) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const kameras = await import("../src/cameras.js");
console.error = origErr;
const { statusJson, wachenJson } = await import("../src/dashboard.js");
const { selbsttest } = await import("../src/check.js");
const tools = await import("../src/tools.js");
const { wachenTick } = await import("../src/watch.js");

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
type W = { id?: number; frage: string; nur_wenn: unknown; laeuft: boolean; grund?: string };

describe("Wachen mit ungültigem «nur_wenn»", () => {
  it("bedingungWert: fehlend → immer, gültig → Wert, alles andere ungültig", () => {
    assert.equal(kameras.bedingungWert(undefined), "immer");
    for (const b of ["immer", "abwesend", "nacht"]) assert.equal(kameras.bedingungWert(b), b);
    for (const b of [null, "Nacht", "nachts", "", 1, {}, ["nacht"]]) assert.equal(kameras.bedingungWert(b), undefined, String(b));
  });

  it("wacheZustand: «Bedingung ungültig», Kamera und Intervall haben Vorrang", () => {
    for (const w of kameras.allWachen().filter((x) => x.id === undefined)) {
      assert.deepEqual(kameras.wacheZustand(w), { takt: 5, laeuft: false, grund: "Bedingung ungültig" });
      assert.equal(kameras.wacheLaeuft(w), false);
    }
    assert.deepEqual(kameras.wacheZustand({ kamera: "hof", alle_minuten: 5, nur_wenn: "nacht", frage: "Jemand da?" }), { takt: 5, laeuft: true });
    assert.deepEqual(kameras.wacheZustand({ kamera: "garten", alle_minuten: 5, nur_wenn: "Nacht" as never, frage: "Jemand da?" }), { takt: 5, laeuft: false, grund: "Kamera fehlt" });
    assert.deepEqual(kameras.wacheZustand({ kamera: "hof", alle_minuten: undefined as never, nur_wenn: null as never, frage: "Jemand da?" }), { takt: undefined, laeuft: false, grund: "Intervall fehlt" });
  });

  it("beim Laden laut gemeldet: Herkunft, Kamera und Anzahl, nie Frage oder Rohwert", () => {
    const text = fehler.join("\n");
    assert.match(text, /cameras\.json: 2 Wache\(n\) bei Kamera «hof» mit ungültigem «nur_wenn»/);
    // id 1 (hof) und id 4 (hof, ohne Takt) sowie id 3 (garten)
    assert.match(text, /data\/wachen\.json: 2 Wache\(n\) bei Kamera «hof» mit ungültigem «nur_wenn»/);
    assert.match(text, /data\/wachen\.json: 1 Wache\(n\) bei Kamera «garten» mit ungültigem «nur_wenn»/);
    assert.match(text, /«melden\.nur_wenn» bei Kamera «hof» ungültig/);
    assert.doesNotMatch(text, /Geheime Frage|Jemand da|Nachts-Rohwert|nachts/);
  });

  it("/api/wachen: kein «immer», nur_wenn null, laeuft false mit Grund", () => {
    const wa = antwort();
    wachenJson(req(), wa as unknown as Res);
    assert.equal(wa.statusCode, 200);
    const wachen = (wa.body as { wachen: W[] }).wachen;
    assert.deepEqual(
      wachen.map((w) => [w.id, w.frage, w.nur_wenn, w.laeuft, w.grund]),
      [
        [undefined, "Jemand da?", null, false, "Bedingung ungültig"],
        [undefined, "Tor?", null, false, "Bedingung ungültig"],
        [1, "Geheime Frage C?", null, false, "Bedingung ungültig"],
        [2, "Läuft?", "abwesend", true, undefined],
        [3, "Garten?", null, false, "Kamera fehlt"],
        [4, "Ohne Takt?", null, false, "Intervall fehlt"],
      ],
    );
    assert.doesNotMatch(JSON.stringify(wa.body), /"immer"/);
    const st = antwort();
    statusJson(req(), st as unknown as Res);
    assert.deepEqual((st.body as { wachen: W[] }).wachen.filter((w) => w.laeuft).map((w) => w.frage), ["Läuft?"]);
  });

  it("wachen_anzeigen nennt den Grund statt «immer»", async () => {
    const t = tools.toolByName("wachen_anzeigen");
    assert.ok(t);
    const ctx = { sendFile: async () => {}, sendPhoto: async () => {}, sendVideo: async () => {} };
    const zeilen = String(await t.run({}, ctx as never)).split("\n");
    assert.equal(zeilen.length, 6);
    assert.match(zeilen[0]!, /Jemand da\? · Bedingung ungültig – schaut nicht hin$/);
    assert.match(zeilen[1]!, /Tor\? · Bedingung ungültig – schaut nicht hin$/);
    assert.match(zeilen[3]!, /#2 hof · alle 5 min · Läuft\? · abwesend$/);
    assert.ok(zeilen.every((z) => !/· immer$/.test(z)), zeilen.join("\n"));
  });

  it("describeCameras: «Bedingung ungültig» statt Rohwert oder «immer»", () => {
    const d = kameras.describeCameras();
    assert.match(d, /melden \(person, Bedingung ungültig\)/);
    assert.doesNotMatch(d, /Nachts-Rohwert/);
  });

  it("npm run check zählt sie nicht als aktiv und nennt den Grund", async () => {
    const [b] = await selbsttest(["Wachen"]);
    assert.equal(b?.info, "1 Wache(n) aktiv, 1 ohne gültiges Intervall (laufen nicht), 1 auf fehlender Kamera (laufen nicht), 3 mit ungültiger Bedingung «nur_wenn» (laufen nicht)");
  });

  it("der Takt schaut bei ungültiger Bedingung nicht hin", async () => {
    // «Läuft?» (abwesend) schaut ohne Präsenz-Entität (isHome() = true) nicht hin; die ungültigen nie: also kein Netzaufruf
    const vorher = netz;
    const origE = console.error;
    console.error = () => {};
    try {
      await wachenTick(Date.UTC(2026, 9, 15, 10, 0));
    } finally {
      console.error = origE;
    }
    assert.equal(netz, vorher);
  });
});
