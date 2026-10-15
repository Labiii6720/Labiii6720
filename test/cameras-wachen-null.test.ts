import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

// Eigene Datei: cameras.json wird nur einmal beim Import gelesen, hier mit von Hand verdorbenen Wachen-Einträgen
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-wachen-null-"));
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
// Dynamische Wache aus data/wachen.json: muss trotz kaputter cameras.json-Einträge weiterlaufen
writeFileSync(join(temp, "data", "wachen.json"), JSON.stringify([{ id: 1, kamera: "garten", frage: "Liegt ein Paket da?", alle_minuten: 30 }]));
// Handeingriff: null, Zahl, Liste unter «wachen»; bei «hof» ist «wachen» gar keine Liste
writeFileSync(
  join(temp, "cameras.json"),
  JSON.stringify({
    garten: { frigate: "garten", beschreibung: "Garten", wachen: [{ frage: "Tor offen?", alle_minuten: 10 }, null, 7, ["x"], { id: 9, frage: "Velo da?", alle_minuten: 5 }] },
    hof: { frigate: "hof", beschreibung: "Innenhof", wachen: "kaputt" },
  }),
);

// Kein Netz: Im Test schaut keine Wache hin (Intervall noch nicht erreicht)
const echteFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error("unerwarteter Netzaufruf"); }) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const kameras = await import("../src/cameras.js");
console.error = origErr;
const { wachenTick } = await import("../src/watch.js");
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

describe("cameras.json mit null und anderen Nicht-Objekten unter «wachen»", () => {
  it("allWachen wirft nicht: gültige Wachen aus der Datei (ohne id) und die dynamische bleiben", () => {
    const alle = kameras.allWachen();
    assert.deepEqual(
      alle.map((w) => [w.kamera, w.frage, w.id]),
      [["garten", "Tor offen?", undefined], ["garten", "Velo da?", undefined], ["garten", "Liegt ein Paket da?", 1]],
    );
    assert.equal("id" in alle[1]!, false, "kopiertes «id» aus cameras.json fällt weiter weg");
    assert.equal(kameras.camerasNichtGeladen, false, "Kameras und Meldungen laufen weiter");
  });

  it("meldet die übersprungenen Einträge beim Laden laut, ohne Inhalt", () => {
    assert.ok(fehler.some((f) => f.includes("cameras.json") && f.includes("3 ungültige") && f.includes("garten")));
    assert.ok(fehler.some((f) => f.includes("cameras.json") && f.includes("hof")));
    assert.ok(!fehler.some((f) => f.includes("Tor offen") || f.includes("kaputt")), "kein Dateiinhalt im Log");
  });

  it("wachenTick bricht nicht ab", async () => {
    await assert.doesNotReject(wachenTick(1));
  });

  it("/status.json und /api/wachen antworten mit 200", () => {
    const st = antwort();
    statusJson(req(), st as unknown as Res);
    assert.equal(st.statusCode, 200);
    assert.equal((st.body as { wachen: unknown[] }).wachen.length, 3);
    const wa = antwort();
    wachenJson(req(), wa as unknown as Res);
    assert.equal(wa.statusCode, 200);
    assert.deepEqual((wa.body as { wachen: { bearbeitbar: boolean }[] }).wachen.map((w) => w.bearbeitbar), [false, false, true]);
  });
});
