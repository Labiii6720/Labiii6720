import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Eigener Prozess (eigene Testdatei): profil.ts liest die Datei beim Import, hier ist sie kaputt
const temp = mkdtempSync(join(tmpdir(), "jarvis-verdichtung-defekt-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

const PROFIL = join(temp, "data", "profil.json");
const NOTIZEN = join(temp, "data", "notizen.md");
const ARCHIV = join(temp, "data", "profil-archiv.jsonl");
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(PROFIL, '{"fakten":["Wohnt in Muttenz"', { mode: 0o600 });
writeFileSync(NOTIZEN, "- 2026-03-01: alte Notiz\n- 2026-03-02: noch eine\n", { mode: 0o600 });

const origErr = console.error;
console.error = () => {};
const { profilNichtGeladen } = await import("../src/profil.js");
const v = await import("../src/verdichtung.js");
console.error = origErr;

describe("verdichteJetzt bei nicht geladenem Profil", () => {
  it("bricht früh ab: kein Modellaufruf, keine Archivzeile, Dateien unverändert", async () => {
    assert.equal(profilNichtGeladen, true);
    let fragen = 0;
    const r = await v.verdichteJetzt({ heute: "2026-10-11", frage: async () => { fragen++; return "{}"; } });
    assert.deepEqual(r, { fehler: "Profil nicht geladen, nichts geändert." });
    assert.equal(fragen, 0);
    assert.equal(existsSync(ARCHIV), false);
    assert.equal(readFileSync(PROFIL, "utf8"), '{"fakten":["Wohnt in Muttenz"');
    assert.equal(readFileSync(NOTIZEN, "utf8"), "- 2026-03-01: alte Notiz\n- 2026-03-02: noch eine\n");
    assert.equal(v.verdichtungLaeuft(), false);
  });

  it("auch die Vorschau fragt das Modell nicht", async () => {
    let fragen = 0;
    const r = await v.verdichteJetzt({ heute: "2026-10-11", nurVorschau: true, frage: async () => { fragen++; return "{}"; } });
    assert.equal(r.fehler, "Profil nicht geladen, nichts geändert.");
    assert.equal(fragen, 0);
  });
});
