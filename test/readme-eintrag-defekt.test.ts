import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

// README ↔ Verhalten bei einem ungültigen Eintrag (Handeingriff, etwa null): in «wachen» von cameras.json,
// data/wachen.json und data/zeitplaene.json fällt nur dieser Eintrag weg (bei den Listen in data/ mit Sicherung),
// die übrigen laufen. Ganz unlesbar ist eine Datei nur noch bei kaputtem JSON, falschen Rechten oder ohne Liste.
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
const { eintragsHinweise } = await import("../src/datei.js");

/** Absatz der README, der mit `anfang` beginnt (bis zur nächsten Leerzeile) */
function absatz(anfang: string): string {
  const start = readme.indexOf(anfang);
  assert.ok(start >= 0, `Absatz «${anfang}» in der README gefunden`);
  const ende = readme.indexOf("\n\n", start);
  return readme.slice(start, ende < 0 ? undefined : ende);
}

describe("README: ungültige Einträge", () => {
  it("Verhalten: überall fällt nur der Eintrag weg; data/wachen.json und data/zeitplaene.json mit Sicherung, ohne Sperre", () => {
    assert.equal(kameras.camerasNichtGeladen, false, "cameras.json bleibt geladen");
    assert.deepEqual(kameras.allWachen().map((w) => w.frage), ["Tor offen?", "Paket da?"]);
    assert.equal(kameras.wachenNichtGeladen, false, "data/wachen.json sperrt nicht");
    assert.equal(zeitplaene.zeitplaeneNichtGeladen, false, "data/zeitplaene.json sperrt nicht");
    assert.deepEqual(zeitplaene.zeitplaene.map((z) => z.id), [1]);
    assert.equal(existsSync(join(temp, "data", "wachen.json.defekt")), true, "Sicherung von wachen.json");
    assert.equal(existsSync(join(temp, "data", "zeitplaene.json.defekt")), true, "Sicherung von zeitplaene.json");
    assert.equal(existsSync(join(temp, "cameras.json.defekt")), false, "cameras.json wird nie gesichert (Jarvis ändert sie nicht)");
    const hinweise = eintragsHinweise();
    for (const datei of ["cameras.json", "data/wachen.json", "data/zeitplaene.json"]) {
      assert.ok(hinweise.some((h) => h.startsWith(`⚠️ ${datei}: 1 ungültiger Eintrag beim Start übersprungen`)), datei);
    }
  });

  it("Abschnitt 12 verspricht das Wegfallen einzelner Einträge für cameras.json und data/wachen.json, ohne Sperre", () => {
    const text = absatz("Von Hand bearbeitet:");
    assert.doesNotMatch(text, /die ganze Datei unlesbar/, "alte Aussage (Sperre bei einem Eintrag)");
    assert.match(text, /unter `wachen` in `cameras\.json` prüft Jarvis wie die in `data\/wachen\.json`/);
    assert.match(text, /nur dieser Eintrag, die übrigen Wachen laufen weiter/);
    assert.match(text, /«Ungültige Einträge» in Abschnitt 20/);
  });

  it("«Unlesbare Dateien» nennt keinen einzelnen Eintrag mehr als Ursache; «Ungültige Einträge» beschreibt Sicherung und Speichern", () => {
    const unlesbar = absatz("**Unlesbare Dateien.**");
    assert.doesNotMatch(unlesbar, /ein einzelner Eintrag/);
    const ungueltig = absatz("**Ungültige Einträge.**");
    assert.match(ungueltig, /überspringt Jarvis nur diesen Eintrag/);
    assert.match(ungueltig, /`<datei>\.defekt`/);
    assert.match(ungueltig, /Speichern bleibt erlaubt/);
    assert.match(ungueltig, /nie den Inhalt/);
    assert.match(ungueltig, /Scheitert die Sicherung, gilt die Datei wie eine unlesbare/);
    assert.match(ungueltig, /«Listen»/);
  });
});
