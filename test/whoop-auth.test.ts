import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// Eigene Datei: Lader und Skript laufen nur einmal beim Import, hier mit unlesbarem state.json im Temp-Verzeichnis
const temp = mkdtempSync(join(tmpdir(), "jarvis-whoop-auth-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const DATEI = join(temp, "data", "state.json");
const KAPUTT = '{"whoop": {"refreshToken": "attrappe-whoop"}, "paused": tr';
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(DATEI, KAPUTT);
// Ohne Zugangsdaten: würde das Skript trotzdem bis env()/listen() laufen, fiele es hier auf
delete process.env.WHOOP_CLIENT_ID;
delete process.env.WHOOP_CLIENT_SECRET;

// Kein Netz: jeder fetch-Aufruf wäre ein Fehler (Token-Tausch darf gar nicht erst starten)
const origFetch = globalThis.fetch;
let fetchAufrufe = 0;
globalThis.fetch = (async () => { fetchAufrufe++; throw new Error("kein Netz im Test"); }) as typeof fetch;
after(() => { globalThis.fetch = origFetch; });

const fehler: string[] = [];
const ausgaben: string[] = [];
const origErr = console.error;
const origLog = console.log;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
console.log = (...a: unknown[]) => { ausgaben.push(a.map(String).join(" ")); };
try {
  await import("../scripts/whoop-auth.js");
} finally {
  console.error = origErr;
  console.log = origLog;
}
const exitCode = process.exitCode;
process.exitCode = 0; // sonst gälte die ganze Testdatei als fehlgeschlagen

describe("whoop:auth bei unlesbarem state.json", () => {
  it("bricht mit exitCode 1 und klarer Meldung ab, bevor ein Browser-Link erscheint", () => {
    assert.equal(exitCode, 1);
    assert.ok(fehler.some((f) => f.includes("data/state.json ist nicht lesbar") && f.includes("kein gültiges JSON")));
    assert.ok(fehler.some((f) => f.includes("whoop:auth")));
    assert.ok(!ausgaben.some((a) => a.includes("Öffne diese URL") || a.includes("verbunden")));
    assert.ok(![...fehler, ...ausgaben].some((f) => f.includes("attrappe-whoop")), "nie Dateiinhalt protokollieren");
    assert.equal(fetchAufrufe, 0);
  });

  it("lässt die Datei unangetastet", () => {
    assert.equal(readFileSync(DATEI, "utf8"), KAPUTT);
  });
});
