import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Eigener Prozess: profil.ts liest data/profil.json beim Import, hier ist sie abgeschnitten
const temp = mkdtempSync(join(tmpdir(), "jarvis-profil-unlesbar-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

const PROFIL = join(temp, "data", "profil.json");
const INHALT = '{"fakten":[{"id":1,"text":"Geheimer Fakt Muttenz"';
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(PROFIL, INHALT, { mode: 0o600 });

const origErr = console.error;
console.error = () => {};
const p = await import("../src/profil.js");
console.error = origErr;

describe("Hinweis auf unlesbare data/profil.json", () => {
  it("gibt einen Meldetext her, der Datei und Sicherung nennt, ohne Dateiinhalt", () => {
    assert.equal(p.profilNichtGeladen, true);
    assert.equal(typeof p.PROFIL_UNLESBAR, "string");
    assert.match(p.PROFIL_UNLESBAR, /data\/profil\.json war beim Start unlesbar/);
    assert.match(p.PROFIL_UNLESBAR, /data\/profil\.json\.defekt/);
    assert.match(p.PROFIL_UNLESBAR, /neu gestartet/);
    assert.doesNotMatch(p.PROFIL_UNLESBAR, /Muttenz/);
  });

  it("die genannte Sicherung existiert, und gespeichert wird nichts", () => {
    assert.equal(readFileSync(join(temp, "data", "profil.json.defekt"), "utf8"), INHALT);
    assert.throws(() => p.saveProfil(), /Profil nicht geladen/);
    assert.equal(readFileSync(PROFIL, "utf8"), INHALT);
    assert.equal(existsSync(`${PROFIL}.tmp`), false);
  });
});
