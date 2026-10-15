import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Bestand aus 0.21: Zeitpläne #1–#3, state.json ohne Zähler naechsteZeitplanId
const temp = mkdtempSync(join(tmpdir(), "jarvis-zeitplaene-bestand-"));
mkdirSync(join(temp, "data"), { recursive: true });
const STATE = join(temp, "data", "state.json");
const ZEITPLAENE = join(temp, "data", "zeitplaene.json");
const plan = (id: number, name: string) => ({ id, name, zeit: "08:00", tage: "taeglich", auftrag: "x", lastRun: "2026-10-01" });
writeFileSync(ZEITPLAENE, JSON.stringify([plan(1, "Wetter"), plan(2, "Kalender"), plan(3, "News")]));
writeFileSync(STATE, JSON.stringify({ mode: "normal" }));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

// Wie `npm run check` neben dem laufenden Dienst: state.js ist geladen, dann setzt der Dienst Notfall und Notaus
const { state } = await import("../src/state.js");
const EXTERN = JSON.stringify({ mode: "normal", paused: true, notfall: { aktiv: true } });
writeFileSync(STATE, EXTERN);
const { neueZeitplanId, saveZeitplaene, zeitplaene } = await import("../src/zeitplaene.js");

describe("Zeitplan-IDs aus einem Bestand ohne Zähler (0.21)", () => {
  it("der Import speichert nichts: ein inzwischen gesetzter Notfall und Notaus bleiben auf der Platte", () => {
    assert.equal(readFileSync(STATE, "utf8"), EXTERN);
    assert.ok(!existsSync(`${STATE}.tmp`));
    assert.equal(state.naechsteZeitplanId, undefined, "der Zähler im Speicher bleibt beim Import unberührt");
  });

  it("Speichern scheitert am Zähler: Fehler an den Aufrufer, Liste und Zähler unverändert", () => {
    writeFileSync(STATE, JSON.stringify({ mode: "normal" }));
    // state.json.tmp als Ordner: writeFileSync in save() scheitert (auch als root)
    mkdirSync(`${STATE}.tmp`);
    const vorher = readFileSync(ZEITPLAENE, "utf8");
    try {
      assert.throws(() => saveZeitplaene());
    } finally {
      rmSync(`${STATE}.tmp`, { recursive: true, force: true });
    }
    assert.equal(readFileSync(ZEITPLAENE, "utf8"), vorher);
    assert.equal(state.naechsteZeitplanId, undefined);
  });

  it("höchste ID löschen, dann neu anlegen: die gelöschte ID wird nicht wieder vergeben, der Zähler liegt vorher auf der Platte", () => {
    // wie zeitplanLoeschen / zeitplan_loeschen: nur splice und speichern, ohne den Zähler anzufassen
    zeitplaene.splice(zeitplaene.findIndex((z) => z.id === 3), 1);
    saveZeitplaene();
    const gespeichert = JSON.parse(readFileSync(STATE, "utf8")) as { naechsteZeitplanId?: number; mode?: string };
    assert.equal(gespeichert.naechsteZeitplanId, 4, "nach einem Neustart fehlte sonst der Zähler, und #3 käme wieder");
    assert.equal(gespeichert.mode, "normal");
    assert.deepEqual((JSON.parse(readFileSync(ZEITPLAENE, "utf8")) as { id: number }[]).map((z) => z.id), [1, 2]);
    const id = neueZeitplanId();
    assert.ok(id > 3, `neue ID ${id} darf die gelöschte #3 nicht treffen`);
    assert.equal(id, 4);
    // und auch nach einem weiteren Löschen der neuesten nicht
    zeitplaene.push({ id, name: "Neu", zeit: "09:00", tage: "taeglich", auftrag: "y" });
    saveZeitplaene();
    zeitplaene.splice(zeitplaene.findIndex((z) => z.id === id), 1);
    saveZeitplaene();
    assert.equal(neueZeitplanId(), 5);
  });
});
