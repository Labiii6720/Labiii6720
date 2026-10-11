import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-zeitplaene-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

const { faelligIm, faelltAn } = await import("../src/zeitplaene.js");
const { todayKey } = await import("../src/time.js");

/** 10.10.2026 ist ein Samstag, 12.10.2026 ein Montag (lokale Zeit Europe/Zurich) */
const sa = (h: number, m: number) => new Date(2026, 9, 10, h, m, 0, 0);
const mo = (h: number, m: number) => new Date(2026, 9, 12, h, m, 0, 0);
const plan = (zeit: string, tage: string, lastRun?: string) => ({ id: 1, name: "Test", zeit, tage, auftrag: "x", ...(lastRun ? { lastRun } : {}) });

describe("faelligIm", () => {
  it("im Fenster fällig, davor und danach nicht", () => {
    const z = plan("08:30", "taeglich");
    assert.equal(faelligIm(z, sa(8, 29), 60), false);
    assert.equal(faelligIm(z, sa(8, 30), 60), true);
    assert.equal(faelligIm(z, sa(9, 15), 60), true);
    assert.equal(faelligIm(z, sa(9, 30), 60), false);
  });

  it("Fenster 0 = nur zur Minute (wie faelltAn)", () => {
    const z = plan("08:30", "täglich");
    assert.equal(faelligIm(z, sa(8, 30), 0), true);
    assert.equal(faelligIm(z, sa(8, 31), 0), false);
    assert.equal(faelltAn(z, sa(8, 30)), true);
    assert.equal(faelltAn(z, sa(8, 31)), false);
  });

  it("Werktage und Wochentage", () => {
    assert.equal(faelligIm(plan("08:30", "werktags"), sa(8, 45), 60), false);
    assert.equal(faelligIm(plan("08:30", "werktags"), mo(8, 45), 60), true);
    assert.equal(faelligIm(plan("08:30", "mo, mi"), mo(8, 45), 60), true);
    assert.equal(faelligIm(plan("08:30", "sa"), sa(8, 45), 60), true);
    assert.equal(faelligIm(plan("08:30", "di,fr"), mo(8, 45), 60), false);
    assert.equal(faelltAn(plan("08:30", "werktags"), sa(8, 30)), false);
    assert.equal(faelltAn(plan("08:30", "Mo,Mi"), mo(8, 30)), true);
  });

  it("heute schon gelaufen → nicht fällig; gestern gelaufen → fällig", () => {
    const heute = todayKey(sa(9, 0));
    assert.equal(faelligIm(plan("08:30", "taeglich", heute), sa(9, 0), 60), false);
    assert.equal(faelligIm(plan("08:30", "taeglich", "2026-10-09"), sa(9, 0), 60), true);
  });

  it("Mitternacht: kein Übertrag auf den nächsten Tag", () => {
    const z = plan("23:30", "taeglich");
    assert.equal(faelligIm(z, sa(23, 59), 60), true);
    assert.equal(faelligIm(z, new Date(2026, 9, 11, 0, 10, 0, 0), 60), false);
  });
});
