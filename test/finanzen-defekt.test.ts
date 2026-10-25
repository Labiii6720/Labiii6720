import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Eigene Datei: der Lader läuft nur einmal beim Import, hier mit kaputtem rechnungen.json im Temp-Verzeichnis
const temp = mkdtempSync(join(tmpdir(), "jarvis-finanzen-defekt-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const DATEI = join(temp, "data", "rechnungen.json");
const KAPUTT = '[{"id": 1, "empfaenger": "Swisscom", "betrag": 89, "waehrung": "CHF", "status": "bezahlt", "bezahltAm": "2026-09-30"},';
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(DATEI, KAPUTT);

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const finanzen = await import("../src/finanzen.js");
console.error = origErr;

describe("rechnungen.json unlesbar", () => {
  it("startet leer, merkt sich die Sperre und meldet es laut", () => {
    assert.equal(finanzen.rechnungen.length, 0);
    assert.equal(finanzen.rechnungenNichtGeladen, true);
    assert.ok(fehler.some((f) => f.includes("Rechnungen unlesbar") && f.includes("rechnungen.json.defekt")));
  });

  it("legt eine Sicherung .defekt mit 600 an", () => {
    const sicherung = `${DATEI}.defekt`;
    assert.ok(existsSync(sicherung));
    assert.equal(readFileSync(sicherung, "utf8"), KAPUTT);
    assert.equal(statSync(sicherung).mode & 0o777, 0o600);
  });

  it("addRechnung wirft, nimmt nichts in den Speicher und lässt die Datei unverändert", () => {
    assert.throws(() => finanzen.addRechnung({ empfaenger: "Test", waehrung: "CHF", betrag: 10 }), /unlesbar/);
    assert.equal(finanzen.rechnungen.length, 0);
    assert.equal(readFileSync(DATEI, "utf8"), KAPUTT);
  });

  it("saveRechnungen und setzeStatus verweigern ebenfalls", () => {
    assert.throws(() => finanzen.saveRechnungen(), /unlesbar/);
    const r = { id: 1, erkanntAm: "2026-10-01T08:00:00.000Z", empfaenger: "X", waehrung: "CHF", status: "offen" as const };
    assert.throws(() => finanzen.setzeStatus(r, "bezahlt", "2026-10-11"), /unlesbar/);
    assert.equal(r.status, "offen");
    assert.equal(readFileSync(DATEI, "utf8"), KAPUTT);
    assert.ok(!existsSync(`${DATEI}.tmp`));
  });
});
