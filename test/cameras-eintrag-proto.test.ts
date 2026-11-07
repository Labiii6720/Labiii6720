import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// Eigene Datei: cameras.json wird nur einmal beim Import gelesen, hier mit einer Kamera namens «__proto__» (Handeingriff).
// JSON.parse legt sie als eigenen Schlüssel an; beim Aussortieren ungültiger Kameras darf sie weder still verschwinden
// noch zum Prototyp von cameras werden (sonst gälten «frigate», «beschreibung» oder «wachen» als Kameras).
const temp = mkdtempSync(join(tmpdir(), "jarvis-kamera-proto-"));
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
// Roh geschrieben: JSON.stringify eines Objektliterals mit «__proto__» schriebe den Schlüssel gar nicht erst
writeFileSync(
  join(temp, "cameras.json"),
  '{"__proto__":{"frigate":"proto_cam","beschreibung":"Seltsamer Name","wachen":[{"frage":"Tor offen?","alle_minuten":10}]},' +
    '"garten":null,"hof":{"frigate":"hof_cam","beschreibung":"Innenhof"}}',
);

const echteFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error("unerwarteter Netzaufruf"); }) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const kameras = await import("../src/cameras.js");
console.error = origErr;

describe("cameras.json mit einer Kamera «__proto__»", () => {
  it("cameras behält den normalen Prototyp und erbt keine Kamera-Felder", () => {
    assert.equal(Object.getPrototypeOf(kameras.cameras), Object.prototype);
    for (const feld of ["frigate", "beschreibung", "wachen"]) {
      assert.equal(kameras.cameras[feld], undefined, feld);
      assert.equal(kameras.kameraBekannt(feld), false, feld);
    }
  });

  it("die Kamera bleibt als eigener Eintrag erhalten (wie vor 0.22), nur «garten» fällt weg", () => {
    assert.deepEqual(Object.keys(kameras.cameras), ["__proto__", "hof"]);
    assert.ok(Object.hasOwn(kameras.cameras, "__proto__"));
    assert.equal(kameras.kameraBekannt("__proto__"), true);
    assert.equal(kameras.cameraByFrigateName("proto_cam")?.[0], "__proto__");
    assert.ok(fehler.some((f) => f.includes("«garten»") && f.includes("übersprungen")));
    assert.ok(!fehler.some((f) => f.includes("«__proto__»") && f.includes("übersprungen")));
    assert.equal(kameras.camerasNichtGeladen, false);
  });

  it("ihre Wache aus cameras.json zählt und läuft", () => {
    assert.deepEqual(kameras.allWachen().map((w) => [w.kamera, w.frage]), [["__proto__", "Tor offen?"]]);
    assert.equal(kameras.wacheLaeuft({ kamera: "__proto__", alle_minuten: 10, frage: "Jemand da?" }), true);
    assert.equal(kameras.wacheLaeuft({ kamera: "frigate", alle_minuten: 10, frage: "Jemand da?" }), false);
    assert.match(kameras.describeCameras(), /^__proto__: Seltsamer Name · schauen · 1 Wache\(n\)\nhof: Innenhof · schauen$/);
  });
});
