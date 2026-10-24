import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Ein verworfener Eintrag (von Hand verdorben) trägt die höchste Nummer, und state.json kennt keinen Zähler: Früher
// zählte nur der gültige Bestand, und der nächste neue Zeitplan bekam die Nummer des verworfenen wieder.
const dir = mkdtempSync(join(tmpdir(), "jarvis-zeitplaene-hoechste-id-"));
process.chdir(dir);
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, "data"), { recursive: true });
writeFileSync(
  join(dir, "data", "zeitplaene.json"),
  JSON.stringify([
    { id: 3, name: "n", zeit: "07:00", tage: "mo", auftrag: "a" },
    { id: 9, name: "verdorben" },
  ]),
);
const origErr = console.error;
console.error = () => {};
const mod = await import("../src/zeitplaene.js");
const { state } = await import("../src/state.js");
console.error = origErr;

describe("Zeitplan-ID nach verworfenem Eintrag mit höchster Nummer", () => {
  it("der verworfene Eintrag ist weg, die neue ID liegt trotzdem über seiner Nummer", () => {
    assert.equal(mod.zeitplaeneNichtGeladen, false);
    assert.deepEqual(mod.zeitplaene.map((z) => z.id), [3]);
    assert.equal(state.naechsteZeitplanId, undefined);
    assert.equal(mod.neueZeitplanId(), 10);
    assert.equal(mod.neueZeitplanId(), 11);
  });

  it("Speichern zieht den Zähler über die verworfene Nummer nach", () => {
    delete state.naechsteZeitplanId;
    mod.saveZeitplaene();
    assert.equal(state.naechsteZeitplanId, 10);
    assert.ok(existsSync(join(dir, "data", "state.json")));
    assert.equal(JSON.parse(readFileSync(join(dir, "data", "state.json"), "utf8")).naechsteZeitplanId, 10);
  });
});
