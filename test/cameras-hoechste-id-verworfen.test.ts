import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Wie bei den Zeitplänen: Eine verworfene Wache (von Hand verdorben) trägt die höchste Nummer, state.json kennt keinen
// Zähler. Früher zählte nur der gültige Bestand, und die nächste neue Wache bekam die Nummer der verworfenen wieder.
const dir = mkdtempSync(join(tmpdir(), "jarvis-cameras-hoechste-id-"));
process.chdir(dir);
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, "data"), { recursive: true });
writeFileSync(join(dir, "cameras.json"), JSON.stringify({ einfahrt: { frigate: "einfahrt", beschreibung: "Einfahrt" } }));
writeFileSync(
  join(dir, "data", "wachen.json"),
  JSON.stringify([
    { id: 3, kamera: "einfahrt", frage: "Tor offen?", alle_minuten: 10 },
    { id: 9, kamera: "einfahrt", alle_minuten: 5 },
  ]),
);
const origErr = console.error;
console.error = () => {};
const kameras = await import("../src/cameras.js");
const { state } = await import("../src/state.js");
console.error = origErr;

describe("Wachen-ID nach verworfenem Eintrag mit höchster Nummer", () => {
  it("der verworfene Eintrag ist weg, die neue ID liegt trotzdem über seiner Nummer", () => {
    assert.equal(kameras.wachenNichtGeladen, false);
    assert.deepEqual(kameras.dynamicWachen.map((w) => w.id), [3]);
    assert.equal(state.naechsteWacheId, undefined);
    assert.equal(kameras.neueWacheId(), 10);
    assert.equal(kameras.neueWacheId(), 11);
  });

  it("Speichern zieht den Zähler über die verworfene Nummer nach", () => {
    delete state.naechsteWacheId;
    kameras.saveWachen();
    assert.equal(state.naechsteWacheId, 10);
    assert.ok(existsSync(join(dir, "data", "state.json")));
    assert.equal(JSON.parse(readFileSync(join(dir, "data", "state.json"), "utf8")).naechsteWacheId, 10);
  });
});
