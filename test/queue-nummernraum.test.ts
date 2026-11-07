import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Nummer ab Number.MAX_SAFE_INTEGER: 2^53 + 1 ergibt wieder 2^53, zwei Aufträge trugen dieselbe id und fielen beim nächsten
// Start beide weg. Jetzt wirft createAuftrag, bevor etwas angelegt oder gespeichert ist.
const temp = mkdtempSync(join(tmpdir(), "jarvis-queue-nummernraum-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const DATEI = join(temp, "data", "auftraege.json");
const INHALT = JSON.stringify([
  { id: Number.MAX_SAFE_INTEGER, createdAt: "2026-10-01T08:00:00.000Z", tool: "mail_senden", input: {}, stufe: "extern", summary: "verdorben", status: "erledigt" },
]);
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(DATEI, INHALT);

const queue = await import("../src/queue.js");
const { state } = await import("../src/state.js");

describe("Nummernraum erschöpft", () => {
  it("createAuftrag wirft, nichts im Speicher, Datei und Zähler unverändert", () => {
    const zaehler = state.naechsteAuftragId;
    for (let n = 0; n < 2; n++) {
      assert.throws(() => queue.createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "neu" }), /Nummernraum erschöpft, Sir – data\/auftraege\.json prüfen/);
    }
    assert.deepEqual(queue.auftraege.map((a) => a.id), [Number.MAX_SAFE_INTEGER]);
    assert.deepEqual(queue.offeneAuftraege(), []);
    assert.equal(readFileSync(DATEI, "utf8"), INHALT);
    assert.equal(state.naechsteAuftragId, zaehler);
  });
});
