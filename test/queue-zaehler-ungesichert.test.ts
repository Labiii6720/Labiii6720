import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Unlesbare state.json: save() schreibt still nichts. zaehlerNachziehen durfte darum nicht annehmen, die Untergrenze
// über einem verworfenen Eintrag sei gesichert. Jetzt: im Prozess gilt sie weiter, setStatus wirft nicht, und das Log sagt es.
const temp = mkdtempSync(join(tmpdir(), "jarvis-queue-zaehler-ungesichert-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const DATEI = join(temp, "data", "auftraege.json");
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "state.json"), "{ abgeschnitten");
writeFileSync(
  DATEI,
  JSON.stringify([
    { id: 1, createdAt: "2026-10-01T08:00:00.000Z", tool: "mail_senden", input: {}, stufe: "extern", summary: "gültig", status: "offen" },
    { id: 9, tool: 5 }, // verworfen, höhere Nummer
  ]),
);

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const queue = await import("../src/queue.js");
const { state, stateNichtGeladen } = await import("../src/state.js");
console.error = origErr;

describe("Auftragszähler bei unlesbarer state.json", () => {
  it("setStatus wirft nicht, meldet die ungesicherte Untergrenze einmal, neue Nummer bleibt über der verworfenen", () => {
    assert.equal(stateNichtGeladen, true);
    assert.deepEqual(queue.auftraege.map((a) => a.id), [1]);
    console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
    try {
      assert.doesNotThrow(() => queue.setStatus(queue.getAuftrag(1)!, "abgelehnt"));
      queue.setStatus(queue.getAuftrag(1)!, "abgelehnt");
    } finally {
      console.error = origErr;
    }
    const hinweise = fehler.filter((f) => f.includes("Untergrenze nur im Speicher"));
    assert.equal(hinweise.length, 1, fehler.join("\n"));
    assert.match(hinweise[0]!, /#10/);
    assert.equal(state.naechsteAuftragId, 10);
    assert.equal(readFileSync(join(temp, "data", "state.json"), "utf8"), "{ abgeschnitten", "state.json unberührt");
    const a = queue.createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "neu" });
    assert.equal(a.id, 10);
  });
});
