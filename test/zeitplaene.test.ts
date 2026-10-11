import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-zeitplaene-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

const { faelligIm, faelltAn, saveZeitplaene, zeitplaene } = await import("../src/zeitplaene.js");
const { todayKey } = await import("../src/time.js");

/** 10.10.2026 ist ein Samstag, 12.10.2026 ein Montag (lokale Zeit Europe/Zurich) */
const sa = (h: number, m: number) => new Date(2026, 9, 10, h, m, 0, 0);
const so = (h: number, m: number) => new Date(2026, 9, 11, h, m, 0, 0);
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

describe("neu angelegter Zeitplan", () => {
  /** Wie zeitplan_erstellen in tools.ts: anhängen, sofort speichern */
  const anlegen = (id: number, zeit: string, jetzt: Date, tage = "taeglich") => {
    zeitplaene.push({ id, name: `Plan ${id}`, zeit, tage, auftrag: "x" });
    saveZeitplaene(jetzt);
    return zeitplaene.at(-1)!;
  };

  it("Uhrzeit heute schon vorbei: kein sofortiger Lauf, erster Lauf am nächsten Tag", () => {
    zeitplaene.length = 0;
    const z = anlegen(1, "07:00", sa(7, 20));
    assert.equal(z.angelegt, sa(7, 20).toISOString());
    assert.equal(faelligIm(z, sa(7, 21), 60), false);
    assert.equal(faelligIm(z, sa(7, 59), 60), false);
    assert.equal(faelligIm(z, so(7, 0), 60), true);
    assert.equal(faelligIm(z, so(7, 30), 60), true);
  });

  it("Uhrzeit heute noch vor uns (oder genau jetzt): läuft heute wie gewohnt, auch im Nachholfenster", () => {
    zeitplaene.length = 0;
    const z = anlegen(1, "14:00", sa(13, 50));
    assert.equal(faelligIm(z, sa(14, 0), 60), true);
    assert.equal(faelligIm(z, sa(14, 30), 60), true);
    const genau = anlegen(2, "15:00", new Date(2026, 9, 10, 15, 0, 30, 0));
    assert.equal(faelligIm(genau, sa(15, 0), 60), true);
  });

  it("bereits gespeicherte Einträge bekommen später kein Anlagedatum (Nachholen nach Störung bleibt)", () => {
    zeitplaene.length = 0;
    const alt = anlegen(1, "08:00", sa(6, 0));
    const angelegt = alt.angelegt;
    // Lauf um 08:00 vorübergehend gescheitert, ein anderer Eintrag wird um 08:20 angelegt und gespeichert
    anlegen(2, "09:00", sa(8, 20));
    assert.equal(alt.angelegt, angelegt);
    assert.equal(faelligIm(alt, sa(8, 25), 60), true);
    // schon gelaufene Einträge werden nicht gestempelt
    zeitplaene.push({ id: 3, name: "Plan 3", zeit: "07:00", tage: "taeglich", auftrag: "x", lastRun: "2026-10-09" });
    saveZeitplaene(sa(8, 30));
    assert.equal(zeitplaene.at(-1)!.angelegt, undefined);
  });

  it("wiederverwendete ID nach dem Löschen gilt als neu", () => {
    zeitplaene.length = 0;
    anlegen(1, "08:00", sa(6, 0));
    zeitplaene.length = 0;
    saveZeitplaene(sa(9, 0));
    const neu = anlegen(1, "08:00", sa(9, 10));
    assert.equal(neu.angelegt, sa(9, 10).toISOString());
    assert.equal(faelligIm(neu, sa(9, 11), 120), false);
  });
});
