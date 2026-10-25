import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// Eigene Datei: cameras.json wird nur einmal beim Import gelesen, hier mit einer Kamera, die null ist, und Wachen ohne gültiges Intervall
const temp = mkdtempSync(join(tmpdir(), "jarvis-kamera-null-"));
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
// Von Hand bearbeitet: Tippfehler im Feldnamen, also kein «alle_minuten» (fällt beim Laden weg, mit Sicherung); dazu
// Wachen mit ungültigem Intervall als Zahl (bleiben stehen, laufen nicht), auf der verworfenen Kamera «garten» (gültiges
// Intervall) und auf einer Kamera, die es nie gab (ohne gültiges Intervall)
writeFileSync(
  join(temp, "data", "wachen.json"),
  JSON.stringify([
    { id: 1, kamera: "hof", frage: "Geheime Frage A?", alle_minuen: 30 },
    { id: 2, kamera: "garten", frage: "Person im Garten?", alle_minuten: 10 },
    { id: 3, kamera: "toString", frage: "Prototyp ohne Intervall?" },
    { id: 4, kamera: "hof", frage: "Geheime Frage C?", alle_minuten: 0 },
    { id: 5, kamera: "toString", frage: "Prototyp?", alle_minuten: -5 },
  ]),
);
writeFileSync(
  join(temp, "cameras.json"),
  JSON.stringify({
    garten: null,
    keller: 7,
    hof: {
      frigate: "hof_cam",
      beschreibung: "Innenhof",
      wachen: [{ frage: "Geheime Frage B?", alle_minuten: "oft" }, { frage: "Geheime Frage D?", alle_minuten: 0 }, { frage: "Tor offen?", alle_minuten: 10 }, null],
    },
  }),
);

// Kein Netz: keine Wache darf hinschauen, kein Ereignis darf etwas holen
const echteFetch = globalThis.fetch;
let netz = 0;
globalThis.fetch = (async () => { netz++; throw new Error("unerwarteter Netzaufruf"); }) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const kameras = await import("../src/cameras.js");
console.error = origErr;
const { eintragsHinweise } = await import("../src/datei.js");
const { onCameraEvent } = await import("../src/watch.js");
const { statusJson, wachenJson } = await import("../src/dashboard.js");
const { selbsttest } = await import("../src/check.js");
const tools = await import("../src/tools.js");

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

describe("cameras.json mit einer Kamera, die kein Objekt ist", () => {
  it("die Kamera fällt beim Laden weg, die übrigen laufen; camerasNichtGeladen bleibt aus", () => {
    assert.deepEqual(Object.keys(kameras.cameras), ["hof"]);
    assert.equal(kameras.camerasNichtGeladen, false);
    assert.ok(fehler.some((f) => f.includes("cameras.json") && f.includes("«garten»") && f.includes("übersprungen")));
    assert.ok(fehler.some((f) => f.includes("«keller»")));
  });

  it("cameraByFrigateName und describeCameras werfen nicht; gezählt werden nur gültige Wachen", () => {
    assert.equal(kameras.cameraByFrigateName("garten"), undefined);
    assert.equal(kameras.cameraByFrigateName("hof_cam")?.[0], "hof");
    const text = kameras.describeCameras();
    assert.match(text, /^hof: Innenhof · schauen · 2 Wache\(n\)$/);
  });

  it("ein Frigate-Ereignis der verworfenen Kamera bricht nicht ab und holt nichts", async () => {
    assert.equal(await onCameraEvent({ camera: "garten", label: "person" }), false);
    assert.equal(netz, 0);
  });

  it("/status.json antwortet mit 200 und listet nur gültige Kameras", () => {
    const st = antwort();
    statusJson(req(), st as unknown as Res);
    assert.equal(st.statusCode, 200);
    assert.deepEqual((st.body as { kameras: unknown[] }).kameras, [{ name: "hof", beschreibung: "Innenhof" }]);
  });
});

describe("Wachen ohne gültiges «alle_minuten»", () => {
  it("mit ungültiger Zahl: beim Laden gemeldet (Herkunft und Kamera, nie die Frage) und nicht gelöscht", () => {
    assert.ok(fehler.some((f) => f.startsWith("cameras.json: 1 Wache(n) bei Kamera «hof» ohne gültiges «alle_minuten»")), JSON.stringify(fehler));
    assert.ok(fehler.some((f) => f.startsWith("data/wachen.json: 1 Wache(n) bei Kamera «hof» ohne gültiges «alle_minuten»")), JSON.stringify(fehler));
    assert.ok(!fehler.some((f) => f.includes("Geheime Frage") || f.includes("Prototyp")), "kein Dateiinhalt im Log");
    assert.deepEqual(kameras.dynamicWachen.map((w) => w.id), [2, 4, 5]);
    assert.equal(kameras.wachenNichtGeladen, false);
  });

  it("ohne «alle_minuten» als Zahl (Tippfehler, «oft», null): beim Laden übersprungen, gezählt, gesichert, Hinweis ohne Inhalt", () => {
    assert.ok(fehler.some((f) => f.startsWith("Wachen: 2 ungültige Einträge übersprungen (Sicherung unter data/wachen.json.defekt)")), JSON.stringify(fehler));
    assert.ok(fehler.some((f) => f.startsWith("cameras.json: 2 ungültige(r) Wachen-Eintrag/Einträge bei Kamera «hof» übersprungen")), JSON.stringify(fehler));
    assert.ok(existsSync(join(temp, "data", "wachen.json.defekt")));
    const hinweise = eintragsHinweise();
    assert.ok(hinweise.some((h) => h.startsWith("⚠️ cameras.json: 4 ungültige Einträge beim Start übersprungen, Sir.")), hinweise.join("\n"));
    assert.ok(hinweise.some((h) => h.startsWith("⚠️ data/wachen.json: 2 ungültige Einträge beim Start übersprungen, Sir (Sicherung unter data/wachen.json.defekt)")), hinweise.join("\n"));
    assert.ok(!hinweise.some((h) => h.includes("Geheime Frage") || h.includes("Prototyp")));
  });

  it("taktMinuten: Zahl oder Ziffernfolge > 0 (mindestens 1), sonst undefined", () => {
    assert.equal(kameras.taktMinuten(30), 30);
    assert.equal(kameras.taktMinuten(" 15 "), 15);
    assert.equal(kameras.taktMinuten(0.5), 1);
    for (const v of [undefined, null, 0, -5, "oft", "", Number.NaN, Number.POSITIVE_INFINITY, [10]]) assert.equal(kameras.taktMinuten(v), undefined, String(v));
  });

  it("Kommandozentrale: alle_minuten null und laeuft false statt «undefined Minuten»", () => {
    const wa = antwort();
    wachenJson(req(), wa as unknown as Res);
    assert.equal(wa.statusCode, 200);
    const wachen = (wa.body as { wachen: { frage: string; alle_minuten: unknown; laeuft: boolean; grund?: string }[] }).wachen;
    // Auf fehlender oder verworfener Kamera läuft eine Wache nicht (wachenTick überspringt sie); das Intervall bleibt stehen
    assert.deepEqual(wachen.map((w) => [w.frage, w.alle_minuten, w.laeuft, w.grund]), [
      ["Geheime Frage D?", null, false, "Intervall fehlt"],
      ["Tor offen?", 10, true, undefined],
      ["Person im Garten?", 10, false, "Kamera fehlt"],
      ["Geheime Frage C?", null, false, "Intervall fehlt"],
      ["Prototyp?", null, false, "Kamera und Intervall fehlen"],
    ]);
    const st = antwort();
    statusJson(req(), st as unknown as Res);
    assert.deepEqual((st.body as { wachen: { alle_minuten: unknown; laeuft: boolean }[] }).wachen.map((w) => [w.alle_minuten, w.laeuft]), [[null, false], [10, true], [10, false], [null, false], [null, false]]);
  });

  it("npm run check zählt nur laufende Wachen als aktiv und nennt die übrigen (Intervall bzw. Kamera fehlt)", async () => {
    const [b] = await selbsttest(["Wachen"]);
    // «Prototyp?» fehlt beides und zählt bei beiden Gründen
    assert.equal(b?.info, "1 Wache(n) aktiv, 3 ohne gültiges Intervall (laufen nicht), 2 auf fehlender Kamera (laufen nicht)");
  });

  it("wacheZustand und wacheLaeuft: gemeinsame Regel, nur eigene Schlüssel von cameras zählen", () => {
    assert.deepEqual(kameras.wacheZustand({ kamera: "hof", alle_minuten: 10, frage: "Jemand da?" }), { takt: 10, laeuft: true });
    assert.deepEqual(kameras.wacheZustand({ kamera: "garten", alle_minuten: 10, frage: "Jemand da?" }), { takt: 10, laeuft: false, grund: "Kamera fehlt" });
    assert.deepEqual(kameras.wacheZustand({ kamera: "hof", alle_minuten: "oft" as never, frage: "Jemand da?" }), { takt: undefined, laeuft: false, grund: "Intervall fehlt" });
    assert.equal(kameras.wacheLaeuft({ kamera: "toString", alle_minuten: 10, frage: "Jemand da?" }), false);
    assert.equal(kameras.wacheLaeuft({ kamera: "hof", alle_minuten: 10, frage: "Jemand da?" }), true);
  });

  it("wachen_anzeigen nennt die nicht laufenden Wachen, ohne «alle oft min»", async () => {
    const t = tools.toolByName("wachen_anzeigen");
    assert.ok(t);
    const ctx = { sendFile: async () => {}, sendPhoto: async () => {}, sendVideo: async () => {} };
    const zeilen = String(await t.run({}, ctx as never)).split("\n");
    assert.equal(zeilen.length, 5);
    assert.match(zeilen[0]!, /alle \? min \(läuft nicht: Intervall fehlt\)/);
    assert.match(zeilen[1]!, /alle 10 min · Tor offen\?/);
    assert.doesNotMatch(zeilen[1]!, /läuft nicht/);
    assert.match(zeilen[2]!, /^#2 garten · alle 10 min \(läuft nicht: Kamera fehlt\) · Person im Garten\?/);
    assert.match(zeilen[3]!, /^#4 hof · alle \? min \(läuft nicht: Intervall fehlt\)/);
    assert.match(zeilen[4]!, /^#5 toString · alle \? min \(läuft nicht: Kamera und Intervall fehlen\)/);
    assert.ok(!zeilen.some((z) => /oft|undefined/.test(z)));
  });
});
