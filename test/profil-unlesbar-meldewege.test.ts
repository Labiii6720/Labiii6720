import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Befund: PROFIL_UNLESBAR war toter Code. Eine abgeschnittene profil.json fehlte in Startmeldung, /status,
// /status.json und npm run check; Jarvis lief still mit leerem Profil. Eigener Prozess: profil.ts lädt nur einmal.
const temp = mkdtempSync(join(tmpdir(), "jarvis-profil-meldewege-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

const INHALT = '{"fakten":[{"id":1,"text":"Geheimer Fakt Muttenz"';
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "profil.json"), INHALT, { mode: 0o600 });

const origErr = console.error;
console.error = () => {};
const { PROFIL_UNLESBAR, profilNichtGeladen } = await import("../src/profil.js");
const { dateiHinweise } = await import("../src/telegram.js");
const { statusJson } = await import("../src/dashboard.js");
const { selbsttest } = await import("../src/check.js");
console.error = origErr;

describe("unlesbare data/profil.json in allen Meldewegen", () => {
  it("Startmeldung und /status: dateiHinweise nennt die Datei, ohne Inhalt", () => {
    assert.equal(profilNichtGeladen, true);
    const hinweise = dateiHinweise();
    assert.ok(hinweise.includes(PROFIL_UNLESBAR));
    assert.ok(hinweise.every((h) => !h.includes("Muttenz")));
  });

  it("/status.json liefert profilUnlesbar", () => {
    let antwort: Record<string, unknown> = {};
    statusJson({} as never, { json: (x: Record<string, unknown>) => void (antwort = x) } as never);
    assert.equal(antwort.profilUnlesbar, true);
    assert.deepEqual(antwort.ziele, []);
  });

  it("npm run check: Befund «Profil» ❌ mit Sicherung, ohne Inhalt; die Datei bleibt unverändert", async () => {
    const [b] = await selbsttest(["Profil"]);
    assert.deepEqual(b, {
      name: "Profil",
      status: "fehler",
      info: "data/profil.json unlesbar (Sicherung .defekt) – leeres Profil, nichts wird gespeichert; reparieren, neu starten",
    });
    assert.ok(b.info.length <= 140);
    assert.equal(readFileSync(join(temp, "data", "profil.json"), "utf8"), INHALT);
  });
});
