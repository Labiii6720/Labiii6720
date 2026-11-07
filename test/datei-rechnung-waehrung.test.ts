import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Von Hand bearbeitete data/rechnungen.json ohne gültige «waehrung»: Früher liess rechnungEintrag den Eintrag roh
// durch, und Telegram, rechnungen_offen und Dashboard zeigten «12.00 undefined». Jetzt gilt dieselbe Regel wie in den
// Summen (waehrungVon): fehlt sie oder ist sie kein Text, CHF; sonst getrimmt in Grossbuchstaben.
const temp = mkdtempSync(join(tmpdir(), "jarvis-rechnung-waehrung-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
mkdirSync(join(temp, "data"), { recursive: true });
const ROH = [
  { id: 1, empfaenger: "Ohne", status: "offen", betrag: 12 },
  { id: 2, empfaenger: "Zahl", status: "offen", betrag: 12, waehrung: 12 },
  { id: 3, empfaenger: "Klein", status: "offen", betrag: 12, waehrung: " eur " },
  { id: 4, empfaenger: "Leer", status: "offen", betrag: 12, waehrung: "  " },
  { id: 5, empfaenger: "Richtig", status: "offen", betrag: 12, waehrung: "CHF" },
];
writeFileSync(join(temp, "data", "rechnungen.json"), JSON.stringify(ROH));

const { rechnungEintrag } = await import("../src/datei.js");
const finanzen = await import("../src/finanzen.js");

describe("rechnungEintrag: waehrung normalisiert", () => {
  it("fehlt / Zahl / « eur » / leer → CHF / CHF / EUR / CHF; gültige bleibt dasselbe Objekt", () => {
    assert.deepEqual(ROH.map((r) => rechnungEintrag(r)?.waehrung), ["CHF", "CHF", "EUR", "CHF", "CHF"]);
    assert.equal(rechnungEintrag(ROH[4]), ROH[4]);
    assert.equal((ROH[0] as { waehrung?: unknown }).waehrung, undefined, "der rohe Eintrag bleibt unverändert");
  });

  it("beim Laden nichts verworfen, nichts gesperrt; formatRechnung ohne «undefined»", () => {
    assert.equal(finanzen.rechnungenNichtGeladen, false);
    assert.deepEqual(finanzen.rechnungen.map((r) => r.waehrung), ["CHF", "CHF", "EUR", "CHF", "CHF"]);
    for (const r of finanzen.rechnungen) assert.doesNotMatch(finanzen.formatRechnung(r), /undefined/);
    assert.match(finanzen.formatRechnung(finanzen.rechnungen[0]!), /12\.00 CHF/);
    assert.match(finanzen.formatRechnung(finanzen.rechnungen[2]!), /12\.00 EUR/);
  });
});
