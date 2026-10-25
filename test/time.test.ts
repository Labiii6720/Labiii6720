import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const temp = mkdtempSync(join(tmpdir(), "jarvis-time-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const { imFenster, hhmm, minutesOfDay } = await import("../src/time.js");

/** Lokale Zeit (TZ Europe/Zurich, gesetzt von config.ts) am 10.10.2026 */
const um = (h: number, m: number, tag = 10) => new Date(2026, 9, tag, h, m, 0, 0);

describe("imFenster", () => {
  it("Fenster beginnt bei ziel, Ende exklusiv", () => {
    assert.equal(imFenster("08:30", um(8, 29), 60), false);
    assert.equal(imFenster("08:30", um(8, 30), 60), true);
    assert.equal(imFenster("08:30", um(9, 0), 60), true);
    assert.equal(imFenster("08:30", um(9, 29), 60), true);
    assert.equal(imFenster("08:30", um(9, 30), 60), false);
    assert.equal(imFenster("08:30", um(12, 0), 60), false);
  });

  it("Fenster 0 oder 1 = nur zur Minute", () => {
    assert.equal(imFenster("08:30", um(8, 30), 0), true);
    assert.equal(imFenster("08:30", um(8, 31), 0), false);
    assert.equal(imFenster("08:30", um(8, 30), 1), true);
    assert.equal(imFenster("08:30", um(8, 31), 1), false);
    assert.equal(imFenster("08:30", um(8, 30), -5), true);
  });

  it("Mitternacht: Fenster endet am Tagesende, kein Übertrag", () => {
    assert.equal(imFenster("23:30", um(23, 30), 60), true);
    assert.equal(imFenster("23:30", um(23, 59), 60), true);
    assert.equal(imFenster("23:30", um(0, 0, 11), 60), false);
    assert.equal(imFenster("23:30", um(0, 29, 11), 60), false);
    assert.equal(imFenster("00:00", um(0, 0), 60), true);
    assert.equal(imFenster("00:00", um(0, 59), 60), true);
    assert.equal(imFenster("00:00", um(1, 0), 60), false);
    assert.equal(imFenster("00:00", um(23, 59), 60), false);
  });

  it("ungültige Zeiten sind nie fällig", () => {
    assert.equal(imFenster("off", um(8, 30), 60), false);
    assert.equal(imFenster("", um(8, 30), 60), false);
    assert.equal(imFenster("25:00", um(8, 30), 60), false);
    assert.equal(imFenster("8:30", um(8, 45), 60), true);
  });

  it("hhmm und minutesOfDay passen zusammen", () => {
    assert.equal(hhmm("08:30"), 510);
    assert.equal(minutesOfDay(um(8, 30)), 510);
  });
});
