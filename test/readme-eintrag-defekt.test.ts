import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

// README ↔ Verhalten bei einem Eintrag, der kein Objekt ist (Handeingriff, etwa null):
// in «wachen» von cameras.json fällt nur dieser Eintrag weg, data/wachen.json und data/zeitplaene.json
// gelten dagegen als ganz unlesbar. Die README darf nicht «nur dieser Eintrag fällt weg» für alle versprechen.
const projekt = resolve(import.meta.dirname, "..");
const readme = readFileSync(join(projekt, "README.md"), "utf8");
const temp = mkdtempSync(join(tmpdir(), "jarvis-readme-eintrag-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.FRIGATE_URL = "http://frigate.attrappe";

mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "wachen.json"), JSON.stringify([{ id: 1, kamera: "garten", frage: "Paket da?", alle_minuten: 30 }, null]));
writeFileSync(join(temp, "data", "zeitplaene.json"), JSON.stringify([{ id: 1, name: "n", zeit: "07:00", tage: "mo", auftrag: "a" }, null]));
writeFileSync(
  join(temp, "cameras.json"),
  JSON.stringify({ garten: { frigate: "garten", beschreibung: "Garten", wachen: [{ frage: "Tor offen?", alle_minuten: 10 }, null] } }),
);

const echteFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error("unerwarteter Netzaufruf"); }) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const origErr = console.error;
console.error = () => {};
const kameras = await import("../src/cameras.js");
const zeitplaene = await import("../src/zeitplaene.js");
console.error = origErr;

/** Absatz der README, der mit `anfang` beginnt (bis zur nächsten Leerzeile) */
function absatz(anfang: string): string {
  const start = readme.indexOf(anfang);
  assert.ok(start >= 0, `Absatz «${anfang}» in der README gefunden`);
  const ende = readme.indexOf("\n\n", start);
  return readme.slice(start, ende < 0 ? undefined : ende);
}

describe("README: Einträge ohne Objekt-Form", () => {
  it("Verhalten: cameras.json überspringt den Eintrag, data/wachen.json und data/zeitplaene.json gelten als unlesbar", () => {
    assert.equal(kameras.camerasNichtGeladen, false, "cameras.json bleibt geladen");
    assert.equal(kameras.wachenNichtGeladen, true, "data/wachen.json gilt als unlesbar");
    assert.equal(zeitplaene.zeitplaeneNichtGeladen, true, "data/zeitplaene.json gilt als unlesbar");
    assert.equal(existsSync(join(temp, "data", "wachen.json.defekt")), true, "Sicherung von wachen.json");
    assert.equal(existsSync(join(temp, "data", "zeitplaene.json.defekt")), true, "Sicherung von zeitplaene.json");
  });

  it("Abschnitt 12 verspricht das Wegfallen einzelner Einträge nur für cameras.json, nicht für data/wachen.json", () => {
    const text = absatz("Von Hand bearbeitet:");
    assert.doesNotMatch(text, /Dasselbe gilt für Wachen-Einträge ohne Objekt-Form\./, "alte, zu pauschale Aussage");
    assert.match(text, /unter `wachen` in `cameras\.json`, die kein Objekt sind/);
    assert.match(text, /`data\/wachen\.json` oder `data\/zeitplaene\.json`[^.]*die ganze Datei unlesbar/);
    assert.match(text, /Speichern ist gesperrt/);
    assert.match(text, /«Unlesbare Dateien»/);
  });

  it("«Unlesbare Dateien» nennt den Eintrag ohne Objekt-Form als Ursache, nur für wachen.json und zeitplaene.json", () => {
    const text = absatz("**Unlesbare Dateien.**");
    assert.match(text, /bei `wachen\.json` und `zeitplaene\.json` auch ein einzelner Eintrag, der kein Objekt ist/);
    assert.doesNotMatch(text, /Kaputtes JSON wird zuerst/, "auch gültiges JSON mit null-Eintrag wird gesichert");
  });
});
