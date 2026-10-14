import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-zeitplaene-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

const { faelligIm, faelltAn, naechsterLauf, saveZeitplaene, zeitplaene } = await import("../src/zeitplaene.js");
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

describe("naechsterLauf an der Sommerzeit-Umstellung", () => {
  // 28.03.2027 (Sonntag): in Europe/Zurich springt die Uhr von 01:59 auf 03:00, 02:00–02:59 gibt es nicht
  const umst = (h: number, m: number) => new Date(2027, 2, 28, h, m, 0, 0);
  const z = plan("02:30", "so");

  it("Uhrzeit in der Lücke: angezeigt wird 03:00, wann der Scheduler (Fenster 60) wirklich startet", () => {
    const lauf = naechsterLauf(z, umst(1, 0), 60)!;
    assert.equal(lauf.getTime(), umst(3, 0).getTime());
    assert.equal(lauf.getHours(), 3);
    assert.equal(lauf.getMinutes(), 0);
    assert.equal(faelligIm(z, lauf, 60), true);
    assert.equal(faelligIm(z, new Date(lauf.getTime() - 60_000), 60), false);
  });

  it("Fenster zu kurz für die Lücke: an diesem Tag kein Lauf, erst am nächsten Sonntag", () => {
    for (const fenster of [0, 1, 30]) {
      const lauf = naechsterLauf(z, umst(1, 0), fenster)!;
      assert.equal(lauf.getTime(), new Date(2027, 3, 4, 2, 30, 0, 0).getTime(), `Fenster ${fenster}`);
      assert.equal(faelligIm(z, umst(3, 0), fenster), false);
    }
  });

  it("ausserhalb der Lücke unverändert", () => {
    assert.equal(naechsterLauf(plan("03:30", "so"), umst(1, 0), 60)!.getTime(), umst(3, 30).getTime());
    assert.equal(naechsterLauf(plan("01:30", "so"), umst(1, 0), 0)!.getTime(), umst(1, 30).getTime());
  });
});

describe("naechsterLauf an der Rückstellung auf Winterzeit", () => {
  // 25.10.2026 (Sonntag): in Europe/Zurich läuft 02:00–02:59 zweimal, erst MESZ (00:00Z–00:59Z), dann MEZ (01:00Z–01:59Z)
  const utc = (h: number, m: number) => new Date(Date.UTC(2026, 9, 25, h, m, 0, 0));
  const neu = (zeit: string, angelegt?: Date) => ({ ...plan(zeit, "taeglich"), ...(angelegt ? { angelegt: angelegt.toISOString() } : {}) });

  /** Erster Minuten-Takt ab `now`, in dem der Scheduler (faelligIm) läuft, bis `bis`; sonst undefined. */
  const simuliere = (z: Zeitplan, now: Date, fenster: number, bis: Date): Date | undefined => {
    for (let t = now.getTime(); t < bis.getTime(); t += 60_000) if (faelligIm(z, new Date(t), fenster)) return new Date(t);
    return undefined;
  };
  type Zeitplan = Parameters<typeof faelligIm>[0];

  it("02:30, im zweiten 02:20 angelegt: Lauf im zweiten Durchgang, nicht eine Stunde zurück", () => {
    const now = utc(1, 20);
    for (const fenster of [0, 60]) {
      const z = neu("02:30", now);
      const lauf = naechsterLauf(z, now, fenster)!;
      assert.equal(lauf.toISOString(), utc(1, 30).toISOString(), `Fenster ${fenster}`);
      assert.equal(lauf.getHours(), 2);
      assert.equal(lauf.getMinutes(), 30);
      assert.equal(simuliere(z, now, fenster, utc(3, 0))?.toISOString(), lauf.toISOString(), `Fenster ${fenster}`);
    }
  });

  it("02:00 im ersten 02:20 noch offen: Fenster 0 läuft beim zweiten 02:00, Fenster 60 sofort", () => {
    const now = utc(0, 20);
    const z = neu("02:00");
    assert.equal(naechsterLauf(z, now, 0)!.toISOString(), utc(1, 0).toISOString());
    assert.equal(simuliere(z, now, 0, utc(3, 0))?.toISOString(), utc(1, 0).toISOString());
    assert.equal(naechsterLauf(z, now, 60)!.getTime(), now.getTime());
    assert.equal(simuliere(z, now, 60, utc(3, 0))?.toISOString(), now.toISOString());
  });

  it("heute schon im ersten Durchgang gelaufen: kein zweiter Lauf, nächster am Montag", () => {
    const z = { ...neu("02:30"), lastRun: todayKey(utc(0, 30)) };
    assert.equal(naechsterLauf(z, utc(1, 20), 0)!.getTime(), new Date(2026, 9, 26, 2, 30, 0, 0).getTime());
  });

  it("stimmt rund um die Umstellung mit der Minuten-Simulation des Schedulers überein", () => {
    const bis = utc(3, 0); // 04:00 MEZ: danach läuft keiner dieser Zeitpläne mehr am selben Tag
    for (let t = utc(23, 30).getTime() - 86_400_000; t <= utc(2, 30).getTime(); t += 30 * 60_000) {
      const now = new Date(t);
      for (const zeit of ["01:30", "02:00", "02:30", "02:59", "03:00"]) {
        for (const fenster of [0, 60]) {
          for (const angelegt of [undefined, now]) {
            const z = neu(zeit, angelegt);
            const erwartet = simuliere(z, now, fenster, bis);
            const lauf = naechsterLauf(z, now, fenster)!;
            const [h, m] = zeit.split(":").map(Number);
            const text = `${now.toISOString()} ${zeit} Fenster ${fenster}${angelegt ? " angelegt" : ""}`;
            assert.equal(lauf.toISOString(), (erwartet ?? new Date(2026, 9, 26, h, m, 0, 0)).toISOString(), text);
          }
        }
      }
    }
  });
});
