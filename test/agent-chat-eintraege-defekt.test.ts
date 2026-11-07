import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befund: data/chat.json als Array mit Nicht-Objekt-Einträgen ([null], [1], [{"role":"x"}]) galt als lesbar. Danach
// warf jede Systemnotiz (dropImages) und jeder Chat-Zug (h.map(fuerApi) oder die API), ohne Hinweis. Jetzt wie
// kaputtes JSON: Sicherung .defekt, Hinweis, der Verlauf beginnt neu. Je Fall ein eigener Temp-Ordner.
const ordner: string[] = [];
process.once("exit", () => {
  for (const o of ordner) rmSync(o, { recursive: true, force: true });
});

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = "chat-eintraege-token-nur-attrappe-012345";
process.env.WEB_SEARCH = "off";
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

// Erst in einen Temp-Ordner, dann die Module laden (nie im Projekt)
const start = mkdtempSync(join(tmpdir(), "jarvis-chat-eintraege-"));
ordner.push(start);
process.chdir(start);
const { anthropic } = await import("../src/claude.js");
const client = anthropic();
let anApi: unknown[] = [];
client.messages.create = (async (p: Anthropic.MessageCreateParams) => {
  // Wie die API: jede Nachricht braucht Rolle und Inhalt
  for (const m of p.messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) throw new Error("400 ungültige Nachricht");
  }
  anApi = p.messages;
  return {
    id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
    content: [{ type: "text", text: "Neu, Sir.", citations: null }],
  } as Anthropic.Message;
}) as unknown as typeof client.messages.create;

type Agent = typeof import("../src/agent.js");
async function frischMit(inhalt: string): Promise<{ agent: Agent; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-chat-eintraege-"));
  ordner.push(dir);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "chat.json"), inhalt, { mode: 0o600 });
  process.chdir(dir);
  const agent = (await import(`../src/agent.js?eintraege=${encodeURIComponent(inhalt)}-${Date.now()}`)) as Agent;
  return { agent, dir };
}

describe("chat.json mit Einträgen fremder Form", () => {
  for (const inhalt of ["[null]", "[1]", '[{"role":"x"}]', '[{"role":"user"}]', '[{"role":"user","content":[null]}]']) {
    it(`${inhalt}: Hinweis, Sicherung, Systemnotiz und Chat-Zug laufen`, async () => {
      const { agent, dir } = await frischMit(inhalt);
      assert.equal(agent.chatNichtGeladen, true);
      assert.match(agent.chatHinweis()!, /war beim Start unlesbar/);
      assert.doesNotThrow(() => agent.addSystemNote("Auftrag #1 erledigt."));
      assert.equal(readFileSync(join(dir, "data", "chat.json.defekt"), "utf8"), inhalt, "der alte Inhalt liegt in der Sicherung");
      assert.equal(await agent.handleMessage("Hallo", { onAuftrag: async () => undefined } as never), "Neu, Sir.");
      assert.equal(anApi.length, 2, "Systemnotiz und Frage, nichts vom Altbestand");
      assert.deepEqual(agent.letzteNachrichten(), [{ rolle: "nutzer", text: "Hallo" }, { rolle: "jarvis", text: "Neu, Sir." }]);
    });
  }

  it("gültige Einträge (auch mit eigenen Marken) gelten weiter als lesbar", async () => {
    const gut = JSON.stringify([
      { role: "user", content: "Frage" },
      { role: "assistant", content: [{ type: "text", text: "Antwort" }], zurueckgehalten: true },
    ]);
    const { agent } = await frischMit(gut);
    assert.equal(agent.chatNichtGeladen, false);
    assert.equal(agent.chatHinweis(), undefined);
    assert.deepEqual(agent.letzteNachrichten(), [{ rolle: "nutzer", text: "Frage" }]);
  });
});
