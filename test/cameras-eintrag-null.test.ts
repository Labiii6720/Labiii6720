import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

// Eigene Datei: cameras.json wird nur einmal beim Import gelesen, hier mit einer Kamera, die null ist, und Wachen ohne gültiges Intervall
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-kamera-null-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });
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
// Von Hand bearbeitet: Tippfehler im Feldnamen, also kein «alle_minuten»; dazu Wachen auf der verworfenen Kamera «garten»
// (gültiges Intervall) und auf einer Kamera, die es nie gab (ohne Intervall)
writeFileSync(
  join(temp, "data", "wachen.json"),
  JSON.stringify([
    { id: 1, kamera: "hof", frage: "Geheime Frage A?", alle_minuen: 30 },
    { id: 2, kamera: "garten", frage: "Person im Garten?", alle_minuten: 10 },
    { id: 3, kamera: "toString", frage: "Prototyp?" },
  ]),
);
writeFileSync(
  join(temp, "cameras.json"),
  JSON.stringify({
    garten: null,
    keller: 7,
    hof: { frigate: "hof_cam", beschreibung: "Innenhof", wachen: [{ frage: "Geheime Frage B?", alle_minuten: "oft" }, { frage: "Tor offen?", alle_minuten: 10 }, null] },
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
  it("werden beim Laden gemeldet (Herkunft und Kamera, nie die Frage) und nicht gelöscht", () => {
    assert.ok(fehler.some((f) => f.startsWith("cameras.json: 1 Wache(n) bei Kamera «hof» ohne gültiges «alle_minuten»")), JSON.stringify(fehler));
    assert.ok(fehler.some((f) => f.startsWith("data/wachen.json: 1 Wache(n) bei Kamera «hof» ohne gültiges «alle_minuten»")), JSON.stringify(fehler));
    assert.ok(!fehler.some((f) => f.includes("Geheime Frage")), "kein Dateiinhalt im Log");
    assert.equal(kameras.dynamicWachen.length, 3);
    assert.equal(kameras.wachenNichtGeladen, false);
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
      ["Geheime Frage B?", null, false, "Intervall fehlt"],
      ["Tor offen?", 10, true, undefined],
      ["Geheime Frage A?", null, false, "Intervall fehlt"],
      ["Person im Garten?", 10, false, "Kamera fehlt"],
      ["Prototyp?", null, false, "Kamera und Intervall fehlen"],
    ]);
    const st = antwort();
    statusJson(req(), st as unknown as Res);
    assert.deepEqual((st.body as { wachen: { alle_minuten: unknown; laeuft: boolean }[] }).wachen.map((w) => [w.alle_minuten, w.laeuft]), [[null, false], [10, true], [null, false], [10, false], [null, false]]);
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
    assert.match(zeilen[2]!, /alle \? min \(läuft nicht: Intervall fehlt\)/);
    assert.match(zeilen[3]!, /^#2 garten · alle 10 min \(läuft nicht: Kamera fehlt\) · Person im Garten\?/);
    assert.match(zeilen[4]!, /^#3 toString · alle \? min \(läuft nicht: Kamera und Intervall fehlen\)/);
    assert.ok(!zeilen.some((z) => /oft|undefined/.test(z)));
  });
});
