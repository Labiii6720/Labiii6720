import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Altbestand aus 0.21: Aufträge bis #57, aber kein naechsteAuftragId in state.json. Früher begann eine danach entfernte
// oder durch [] ersetzte auftraege.json wieder bei #1. Jetzt steht die Untergrenze gleich beim Start in state.json.
const temp = mkdtempSync(join(tmpdir(), "jarvis-queue-altbestand-zaehler-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const DATEI = join(temp, "data", "auftraege.json");
const STATE = join(temp, "data", "state.json");
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(STATE, JSON.stringify({ mode: "normal" }));
writeFileSync(
  DATEI,
  JSON.stringify(Array.from({ length: 57 }, (_, i) => ({ id: i + 1, createdAt: "2026-10-01T08:00:00.000Z", tool: "mail_senden", input: {}, stufe: "extern", summary: `alt ${i + 1}`, status: "erledigt" }))),
);

await import("../src/queue.js");
const { state } = await import("../src/state.js");

describe("Altbestand ohne Auftragszähler", () => {
  it("nach dem Start steht naechsteAuftragId 58 in state.json, übrige Felder bleiben", () => {
    assert.equal(state.naechsteAuftragId, 58);
    assert.deepEqual(JSON.parse(readFileSync(STATE, "utf8")), { mode: "normal", naechsteAuftragId: 58 });
  });

  it("auftraege.json durch [] ersetzt, Neustart: kein #1, sondern #58", async () => {
    writeFileSync(DATEI, "[]");
    const neu = (await import(new URL("../src/queue.js?neustart=1", import.meta.url).href)) as typeof import("../src/queue.js");
    assert.deepEqual(neu.auftraege, []);
    assert.equal(neu.createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "neu" }).id, 58);
  });
});
