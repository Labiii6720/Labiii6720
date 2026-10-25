import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Rechnungsnummern verworfener Einträge: saveRechnungen() schreibt sie nicht zurück. Ohne Untergrenze in state.json
// vergab addRechnung() sie nach dem Neustart neu, und «#9» traf dann eine andere Rechnung. Der Neustart ist ein
// zweiter Prozess im selben Temp-Ordner (der Lader läuft nur einmal je Import).
const temp = mkdtempSync(join(tmpdir(), "jarvis-finanzen-nummer-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const DATEI = join(temp, "data", "rechnungen.json");
const STATE = join(temp, "data", "state.json");
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(
  DATEI,
  JSON.stringify([
    { id: 3, erkanntAm: "2026-10-01T08:00:00.000Z", empfaenger: "Swisscom", betrag: 89, waehrung: "CHF", status: "offen" },
    { id: 9, erkanntAm: "2026-10-02T08:00:00.000Z", betrag: 120, waehrung: "CHF", status: "offen" }, // ohne Empfänger: verworfen
  ]),
);

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const finanzen = await import("../src/finanzen.js");
console.error = origErr;

const LADER = import.meta.resolve("tsx");
const FINANZEN = new URL("../src/finanzen.ts", import.meta.url).href;

/** Neuer Prozess im selben Ordner: lädt rechnungen.json und state.json frisch und erfasst eine Rechnung. */
function neustartUndErfassen(): number {
  const code = `const f = await import(${JSON.stringify(FINANZEN)}); process.stdout.write(String(f.addRechnung({ empfaenger: "Neu", waehrung: "CHF", betrag: 10 }).id));`;
  const r = spawnSync(process.execPath, ["--import", LADER, "--input-type=module", "-e", code], { cwd: temp, encoding: "utf8", env: { ...process.env } });
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout.trim());
}

describe("Rechnungsnummern über den Neustart", () => {
  it("lädt nur die gültige #3 und meldet die verworfene", () => {
    assert.deepEqual(finanzen.rechnungen.map((r) => r.id), [3]);
    assert.ok(fehler.some((f) => f.includes("Rechnungen") && f.includes("übersprungen")));
  });

  it("merkt sich beim Speichern die Nummer über der verworfenen #9", () => {
    finanzen.setzeStatus(finanzen.rechnungen[0]!, "bezahlt", "2026-10-20");
    assert.deepEqual((JSON.parse(readFileSync(DATEI, "utf8")) as { id: number }[]).map((r) => r.id), [3]);
    assert.equal((JSON.parse(readFileSync(STATE, "utf8")) as { naechsteRechnungId?: number }).naechsteRechnungId, 10);
  });

  it("vergibt nach dem Neustart #10, nicht die verworfene #9 oder #4", () => {
    assert.equal(neustartUndErfassen(), 10);
    assert.deepEqual((JSON.parse(readFileSync(DATEI, "utf8")) as { id: number }[]).map((r) => r.id), [3, 10]);
    assert.equal((JSON.parse(readFileSync(STATE, "utf8")) as { naechsteRechnungId?: number }).naechsteRechnungId, 11);
  });

  it("bleibt eindeutig, wenn rechnungen.json danach entfernt wurde", () => {
    rmSync(DATEI);
    assert.equal(neustartUndErfassen(), 11);
    assert.ok(existsSync(DATEI));
  });
});
