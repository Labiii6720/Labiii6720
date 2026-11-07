import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Über 300 Rechnungen fielen früher die abgeschlossenen nach ihrer Position im Array weg (Erfassungsdatum), nicht nach
// bezahltAm: eine im Januar erfasste, gestern bezahlte Rechnung verschwand beim nächsten Erfassen sofort aus Datei und
// Speicher, Wochenbericht und Monatssumme zählten sie nicht. Bei mehr als 300 offenen fiel jede eben abgehakte weg.
const temp = mkdtempSync(join(tmpdir(), "jarvis-finanzen-kuerzen-"));
process.chdir(temp);
// Im Temp-Ordner bleiben bis zum Prozessende (spätes Schreiben landet nie im Projekt), dann aufräumen
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

const { todayKey } = await import("../src/time.js");
/** Datumsschlüssel n Tage von heute (negativ: zurück) */
const tag = (n: number): string => todayKey(new Date(Date.now() + n * 86_400_000));
const GESTERN = tag(-1);

// #1 im Januar erfasst, gestern bezahlt; #2–#299 vor 400 Tagen bezahlt, #300 vor 900 Tagen: zusammen genau 300
mkdirSync("data");
writeFileSync("data/rechnungen.json", JSON.stringify([
  { id: 1, erkanntAm: "2026-01-05T09:00:00.000Z", empfaenger: "Steueramt", betrag: 4200, waehrung: "CHF", status: "bezahlt", bezahltAm: GESTERN },
  ...Array.from({ length: 299 }, (_, k) => {
    const id = k + 2;
    const vor = id === 300 ? -900 : -400;
    return { id, erkanntAm: `${tag(vor - 1)}T08:00:00.000Z`, empfaenger: `Laden ${id}`, betrag: 10, waehrung: "CHF", status: "bezahlt", bezahltAm: tag(vor) };
  }),
]));

const finanzen = await import("../src/finanzen.js");
type Rechnung = import("../src/finanzen.js").Rechnung;
const datei = () => JSON.parse(readFileSync("data/rechnungen.json", "utf8")) as Rechnung[];
const bezahltIm = (monat: string) => finanzen.finanzUebersicht().proMonat.find((m) => m.monat === monat)?.bezahlt;

describe("Rechnungen über 300: gekürzt wird nach Abschlussdatum, eben bezahlte bleiben", () => {
  it("früh erfasst, gestern bezahlt, danach eine neue erfasst: zählt weiter im Wochenbericht und in der Monatssumme", () => {
    assert.equal(finanzen.rechnungen.length, 300);
    const neu = finanzen.addRechnung({ empfaenger: "Garage", betrag: 80, waehrung: "CHF" });
    assert.equal(neu.id, 301);
    const ids = datei().map((r) => r.id);
    assert.equal(ids.length, 300);
    assert.ok(ids.includes(1), "die eben bezahlte bleibt in der Datei");
    // Weg ist die mit dem ältesten Abschluss (#300), nicht die vorderste (#2)
    assert.ok(!ids.includes(300));
    assert.ok(ids.includes(2));
    assert.deepEqual(finanzen.rechnungen.map((r) => r.id), ids);
    const u = finanzen.finanzUebersicht();
    assert.deepEqual(u.bezahltLetzteWoche.map((r) => r.id), [1]);
    assert.deepEqual(bezahltIm(GESTERN.slice(0, 7)), { CHF: 4200 });
  });

  it("mehr als 300 offene: eine eben abgehakte Rechnung verschwindet nicht, sondern zählt als bezahlt", () => {
    const offene: Rechnung[] = Array.from({ length: 301 }, (_, k) => ({ id: 1001 + k, erkanntAm: "2026-03-01T08:00:00.000Z", empfaenger: `Offen ${k}`, betrag: 50, waehrung: "CHF", status: "offen" }));
    finanzen.rechnungen.splice(0, finanzen.rechnungen.length, ...offene);
    const r = finanzen.rechnungen.find((x) => x.id === 1005)!;
    finanzen.setzeStatus(r, "bezahlt");
    assert.equal(r.bezahltAm, todayKey());
    assert.ok(finanzen.rechnungen.some((x) => x.id === 1005 && x.status === "bezahlt"));
    assert.ok(datei().some((x) => x.id === 1005 && x.status === "bezahlt"));
    assert.deepEqual(finanzen.finanzUebersicht().bezahltLetzteWoche.map((x) => x.id), [1005]);
    // Offene bleiben ohnehin alle
    assert.equal(datei().filter((x) => x.status === "offen").length, 300);
  });

  it("alte abgeschlossene fallen weiterhin weg, die ältesten zuerst, ignorierte nach Erfassungsdatum", () => {
    // #1502 steht vorne (früh erfasst), wurde aber zuletzt abgeschlossen
    const liste: Rechnung[] = [
      ...Array.from({ length: 299 }, (_, k): Rechnung => ({ id: 2001 + k, erkanntAm: "2026-03-01T08:00:00.000Z", empfaenger: `Offen ${k}`, waehrung: "CHF", status: "offen" })),
      { id: 1502, erkanntAm: `${tag(-1000)}T08:00:00.000Z`, empfaenger: "Früh erfasst, spät bezahlt", waehrung: "CHF", status: "bezahlt", bezahltAm: tag(-250) },
      { id: 1500, erkanntAm: `${tag(-300)}T08:00:00.000Z`, empfaenger: "Alt bezahlt", waehrung: "CHF", status: "bezahlt", bezahltAm: tag(-300) },
      { id: 1501, erkanntAm: `${tag(-700)}T08:00:00.000Z`, empfaenger: "Alt ignoriert", waehrung: "CHF", status: "ignoriert" },
    ];
    finanzen.rechnungen.splice(0, finanzen.rechnungen.length, ...liste);
    finanzen.saveRechnungen();
    const ids = datei().map((r) => r.id);
    assert.equal(ids.length, 300);
    // 302 → 300: weg sind die ignorierte (vor 700 Tagen) und die vor 300 Tagen bezahlte; die vor 250 Tagen bezahlte bleibt
    assert.ok(!ids.includes(1501));
    assert.ok(!ids.includes(1500));
    assert.ok(ids.includes(1502));
  });
});
