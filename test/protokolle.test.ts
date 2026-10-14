import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis, Protokolle und Umgebung; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-protokolle-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.HA_URL = "http://ha.test:8123";
process.env.HA_TOKEN = "ha-token-attrappe";
// Kamera-Werkzeuge (wache_loeschen) gibt es nur mit Frigate und cameras.json; Frigate wird nie aufgerufen
process.env.FRIGATE_URL = "http://frigate.test:5000";

const schalte = (entity_id: string, dienst: string) => ({ tool: "geraet_schalten", input: { entity_id, dienst } });
writeFileSync("protokolle.json", JSON.stringify({
  werkstatt: { beschreibung: "Licht und Werkbank an", stufe: "auto", schritte: [schalte("light.werkstatt", "turn_on"), schalte("switch.relais", "turn_on"), { modus: "fokus" }] },
  abwesend: { beschreibung: "Alles aus, Alarm scharf", stufe: "extern", schritte: [schalte("light.wohnzimmer", "turn_off"), schalte("switch.relais", "turn_off"), schalte("alarm_control_panel.haus", "alarm_arm_away"), { modus: "fokus" }] },
  aufwachen: { beschreibung: "Notaus aufheben", stufe: "auto", schritte: [{ aktion: "weiter" }, schalte("light.wohnzimmer", "turn_on")] },
  ruhe: { beschreibung: "Notaus setzen", stufe: "auto", schritte: [{ aktion: "pause" }, schalte("light.wohnzimmer", "turn_off")] },
  aufraeumen: { beschreibung: "Wache und Zeitplan entfernen", stufe: "extern", schritte: [{ tool: "wache_loeschen", input: { id: 3 } }, { tool: "zeitplan_loeschen", input: { id: 5 } }] },
}));
// Bestand für das Aufräum-Protokoll (Ablage wie im Dienst)
writeFileSync("cameras.json", JSON.stringify({ werkstatt: { frigate: "werkstatt", beschreibung: "Werkstatt" } }));
mkdirSync("data", { recursive: true });
writeFileSync("data/wachen.json", JSON.stringify([{ id: 3, kamera: "werkstatt", frage: "Ist der Druck sauber?", alle_minuten: 10, quelle: "chat" }]));
writeFileSync("data/zeitplaene.json", JSON.stringify([{ id: 5, name: "Morgenrunde", zeit: "07:00", tage: "mo-fr", auftrag: "Wetter melden", angelegt: new Date(0).toISOString() }]));

/** Aufgerufene HA-Dienste; vorAntwort läuft beim Aufruf (z. B. /pause trifft ein, während der Schritt wartet) */
const aufrufe: string[] = [];
let vorAntwort: ((nr: number) => void) | undefined;
const echteFetch = globalThis.fetch;
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (!url.startsWith("http://ha.test:8123/")) throw new Error(`unerwarteter Netzaufruf: ${url}`);
  aufrufe.push(url.replace("http://ha.test:8123/api/", ""));
  vorAntwort?.(aufrufe.length);
  return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const { runProtokoll, protokollGesperrt } = await import("../src/protokolle.js");
const { state } = await import("../src/state.js");
const { dynamicWachen } = await import("../src/cameras.js");
const { zeitplaene } = await import("../src/zeitplaene.js");

const ctx = { sendFile: async () => undefined, sendPhoto: async () => undefined, sendVideo: async () => undefined };
const notfall = () => ({ aktiv: true, seit: new Date(0).toISOString(), grund: "Test" });

describe("Protokolle: Notaus und Notfall", () => {
  afterEach(() => {
    aufrufe.length = 0;
    vorAntwort = undefined;
    state.paused = false;
    delete state.notfall;
    delete state.mode;
  });

  it("ohne Notaus laufen alle Schritte", async () => {
    const out = await runProtokoll("werkstatt", ctx);
    assert.deepEqual(aufrufe, ["services/light/turn_on", "services/switch/turn_on"]);
    assert.equal(state.mode, "fokus");
    assert.match(out, /ausgeführt/);
    assert.equal(protokollGesperrt(), undefined);
  });

  it("Notfall aktiv: ein auto-Protokoll schaltet nichts", async () => {
    state.paused = true;
    state.notfall = notfall();
    const out = await runProtokoll("werkstatt", ctx);
    assert.deepEqual(aufrufe, []);
    assert.equal(state.mode, undefined);
    assert.match(out, /nicht ausgeführt/);
    assert.match(out, /entwarnung/);
    assert.ok(protokollGesperrt());
  });

  it("Notaus aktiv: ein auto-Protokoll schaltet nichts", async () => {
    state.paused = true;
    const out = await runProtokoll("werkstatt", ctx);
    assert.deepEqual(aufrufe, []);
    assert.match(out, /nicht ausgeführt/);
  });

  it("Notfall ohne gesetzten Notaus sperrt trotzdem", async () => {
    state.notfall = notfall();
    await runProtokoll("werkstatt", ctx);
    assert.deepEqual(aufrufe, []);
  });

  it("«weiter» hebt einen Notfall nicht auf", async () => {
    state.paused = true;
    state.notfall = notfall();
    await runProtokoll("aufwachen", ctx);
    assert.equal(state.paused, true);
    assert.equal(state.notfall?.aktiv, true);
    assert.deepEqual(aufrufe, []);
  });

  it("«weiter» hebt auch einen gewöhnlichen Notaus nicht auf (nur /weiter)", async () => {
    state.paused = true;
    await runProtokoll("aufwachen", ctx);
    assert.equal(state.paused, true);
    assert.deepEqual(aufrufe, []);
  });

  it("/pause während eines Schritts: die restlichen Schritte laufen nicht", async () => {
    vorAntwort = (nr) => { if (nr === 1) state.paused = true; };
    const out = await runProtokoll("abwesend", ctx);
    assert.deepEqual(aufrufe, ["services/light/turn_off"]);
    assert.equal(state.mode, undefined);
    assert.match(out, /abgebrochen/);
    assert.match(out, /✗ Notaus: übrige Schritte nicht ausgeführt/);
  });

  it("/notfall während eines Schritts: die restlichen Schritte laufen nicht", async () => {
    vorAntwort = (nr) => { if (nr === 1) state.notfall = notfall(); };
    await runProtokoll("abwesend", ctx);
    assert.deepEqual(aufrufe, ["services/light/turn_off"]);
  });

  it("Schritt «pause» setzt den Notaus, danach schaltet nichts mehr", async () => {
    const out = await runProtokoll("ruhe", ctx);
    assert.equal(state.paused, true);
    assert.deepEqual(aufrufe, []);
    assert.match(out, /✓ pause/);
  });

  it("Fehlertext eines Schritts mit Zugangsdaten in der URL wird geschwärzt", async () => {
    vorAntwort = () => { throw new TypeError("Request cannot be constructed from a URL that includes credentials: http://u:pw-geheim@ha.test:8123/api/services/light/turn_on"); };
    const out = await runProtokoll("werkstatt", ctx);
    assert.match(out, /✗ geraet_schalten: /);
    assert.match(out, /<geheim>@ha\.test/);
    assert.doesNotMatch(out, /pw-geheim/);
    assert.doesNotMatch(out, /u:pw/);
  });
});

describe("Protokolle: Löschschritte aus protokolle.json", () => {
  it("wache_loeschen und zeitplan_loeschen mit blosser ID löschen (Stand zur Ausführungszeit)", async () => {
    assert.equal(dynamicWachen.length, 1);
    assert.equal(zeitplaene.length, 1);
    const out = await runProtokoll("aufraeumen", ctx);
    assert.match(out, /✓ wache_loeschen: Gelöscht\./);
    assert.match(out, /✓ zeitplan_loeschen: Gelöscht\./);
    assert.doesNotMatch(out, /✗/);
    assert.equal(dynamicWachen.length, 0);
    assert.equal(zeitplaene.length, 0);
    assert.deepEqual(JSON.parse(readFileSync("data/wachen.json", "utf8")), []);
    assert.deepEqual(JSON.parse(readFileSync("data/zeitplaene.json", "utf8")), []);
  });

  it("nicht vorhandene Wache: Schritt schlägt fehl, nichts gelöscht", async () => {
    const out = await runProtokoll("aufraeumen", ctx);
    assert.match(out, /✗ wache_loeschen: Wache nicht gefunden/);
    assert.match(out, /✗ zeitplan_loeschen: Zeitplan nicht gefunden/);
  });
});
