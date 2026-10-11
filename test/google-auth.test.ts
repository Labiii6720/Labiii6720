import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

// Eigene Datei: Lader und Skript laufen nur einmal beim Import, hier mit unlesbarem state.json im Temp-Verzeichnis
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-google-auth-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

const DATEI = join(temp, "data", "state.json");
const KAPUTT = '{"google": {"refreshToken": "attrappe-google"}, "paused": tr';
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(DATEI, KAPUTT);
// Ohne Zugangsdaten: würde das Skript trotzdem bis oauthClient()/listen() laufen, fiele es hier auf
delete process.env.GOOGLE_OAUTH_CLIENT_ID;
delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;

const fehler: string[] = [];
const ausgaben: string[] = [];
const origErr = console.error;
const origLog = console.log;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
console.log = (...a: unknown[]) => { ausgaben.push(a.map(String).join(" ")); };
try {
  await import("../scripts/google-auth.js");
} finally {
  console.error = origErr;
  console.log = origLog;
}
const exitCode = process.exitCode;
process.exitCode = 0; // sonst gälte die ganze Testdatei als fehlgeschlagen

describe("google:auth bei unlesbarem state.json", () => {
  it("bricht mit exitCode 1 und klarer Meldung ab, bevor ein Browser-Link erscheint", () => {
    assert.equal(exitCode, 1);
    assert.ok(fehler.some((f) => f.includes("data/state.json ist nicht lesbar") && f.includes("kein gültiges JSON")));
    assert.ok(!ausgaben.some((a) => a.includes("Öffne diese URL") || a.includes("verbunden")));
    assert.ok(!fehler.some((f) => f.includes("attrappe-google")), "nie Dateiinhalt protokollieren");
  });

  it("lässt die Datei unangetastet", () => {
    assert.equal(readFileSync(DATEI, "utf8"), KAPUTT);
  });
});
