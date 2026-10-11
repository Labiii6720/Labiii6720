import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Vor dem Import: Temp-Verzeichnis und Umgebung; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-agent-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const { runTask } = await import("../src/agent.js");
const { state } = await import("../src/state.js");

const NOTIZEN = join(temp, "data", "notizen.md");
const hooks = { onAuftrag: async () => undefined } as unknown as Parameters<typeof runTask>[1];

/** Antwort mit zwei auto-Werkzeugen (notiz_speichern hat eine Nebenwirkung: Datei schreiben) */
const mitWerkzeugen = (): Anthropic.Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "tool_use", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  content: [
    { type: "text", text: "Ich notiere das.", citations: null },
    { type: "tool_use", id: "tu_1", name: "notiz_speichern", input: { text: "eins" } },
    { type: "tool_use", id: "tu_2", name: "notiz_speichern", input: { text: "zwei" } },
  ],
} as Anthropic.Message);

describe("runLoop: Notaus während eines Claude-Aufrufs", () => {
  const client = anthropic();
  const orig = client.messages.create;
  afterEach(() => {
    client.messages.create = orig;
    state.paused = false;
  });

  it("Notaus kommt während messages.create: keine Werkzeuge, Historie bleibt gültig", async () => {
    let aufrufe = 0;
    client.messages.create = (async () => {
      aufrufe++;
      state.paused = true; // /pause trifft ein, während die Antwort unterwegs ist
      return mitWerkzeugen();
    }) as unknown as typeof client.messages.create;
    const verlauf: Anthropic.MessageParam[] = [];
    const antwort = await runTask("Merk dir eins und zwei.", hooks, { history: verlauf });
    assert.equal(antwort, "Ich bin pausiert (Notaus). In Telegram hebt /weiter das wieder auf.");
    assert.equal(aufrufe, 1);
    assert.equal(existsSync(NOTIZEN), false);
    // jedes tool_use hat ein tool_result (sonst lehnt die API den nächsten Aufruf ab)
    const letzte = verlauf.at(-1)!;
    assert.equal(letzte.role, "user");
    const ergebnisse = letzte.content as Anthropic.ToolResultBlockParam[];
    assert.deepEqual(ergebnisse.map((r) => [r.tool_use_id, r.is_error]), [["tu_1", true], ["tu_2", true]]);
  });

  it("ohne Notaus: Werkzeuge laufen wie bisher", async () => {
    let aufrufe = 0;
    client.messages.create = (async () => {
      aufrufe++;
      if (aufrufe === 1) return mitWerkzeugen();
      return { ...mitWerkzeugen(), stop_reason: "end_turn", content: [{ type: "text", text: "Notiert, Sir.", citations: null }] } as Anthropic.Message;
    }) as unknown as typeof client.messages.create;
    const antwort = await runTask("Merk dir eins und zwei.", hooks, { history: [] });
    assert.equal(antwort, "Notiert, Sir.");
    assert.equal(aufrufe, 2);
    assert.equal(existsSync(NOTIZEN), true);
  });
});
