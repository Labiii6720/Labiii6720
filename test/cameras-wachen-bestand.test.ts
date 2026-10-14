import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

// Bestand aus 0.21: Wachen #1 und #2, state.json ohne Zähler naechsteWacheId
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-wachen-bestand-"));
mkdirSync(join(temp, "data"), { recursive: true });
const STATE = join(temp, "data", "state.json");
const WACHEN = join(temp, "data", "wachen.json");
const wache = (id: number, frage: string) => ({ id, kamera: "garten", frage, alle_minuten: 30, nur_wenn: "immer" });
writeFileSync(WACHEN, JSON.stringify([wache(1, "Ist das Tor offen?"), wache(2, "Liegt ein Paket da?")]));
writeFileSync(STATE, JSON.stringify({ mode: "normal" }));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

// Wie `npm run check` neben dem laufenden Dienst: state.js ist geladen, dann setzt der Dienst Notfall und Notaus
const { state } = await import("../src/state.js");
const EXTERN = JSON.stringify({ mode: "normal", paused: true, notfall: { aktiv: true } });
writeFileSync(STATE, EXTERN);
const { dynamicWachen, neueWacheId, saveWachen } = await import("../src/cameras.js");

describe("Wachen-IDs aus einem Bestand ohne Zähler (0.21)", () => {
  it("der Import speichert nichts: ein inzwischen gesetzter Notfall und Notaus bleiben auf der Platte", () => {
    assert.equal(readFileSync(STATE, "utf8"), EXTERN);
    assert.ok(!existsSync(`${STATE}.tmp`));
    assert.equal(state.naechsteWacheId, undefined, "der Zähler im Speicher bleibt beim Import unberührt");
  });

  it("Speichern scheitert am Zähler: Fehler an den Aufrufer, Liste und Zähler unverändert", () => {
    writeFileSync(STATE, JSON.stringify({ mode: "normal" }));
    // state.json.tmp als Ordner: writeFileSync in save() scheitert (auch als root)
    mkdirSync(`${STATE}.tmp`);
    const vorher = readFileSync(WACHEN, "utf8");
    try {
      assert.throws(() => saveWachen());
    } finally {
      rmSync(`${STATE}.tmp`, { recursive: true, force: true });
    }
    assert.equal(readFileSync(WACHEN, "utf8"), vorher);
    assert.equal(state.naechsteWacheId, undefined);
  });

  it("höchste ID löschen, dann neu anlegen: die gelöschte ID wird nicht wieder vergeben, der Zähler liegt vorher auf der Platte", () => {
    // wie wacheLoeschen / wache_loeschen: nur splice und speichern, ohne den Zähler anzufassen
    dynamicWachen.splice(dynamicWachen.findIndex((w) => w.id === 2), 1);
    saveWachen();
    const gespeichert = JSON.parse(readFileSync(STATE, "utf8")) as { naechsteWacheId?: number; mode?: string };
    assert.equal(gespeichert.naechsteWacheId, 3, "nach einem Neustart fehlte sonst der Zähler, und #2 käme wieder");
    assert.equal(gespeichert.mode, "normal");
    assert.deepEqual((JSON.parse(readFileSync(WACHEN, "utf8")) as { id: number }[]).map((w) => w.id), [1]);
    const id = neueWacheId();
    assert.notEqual(id, 2, "die gelöschte #2 darf nicht wieder vergeben werden");
    assert.equal(id, 3);
  });
});
