import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befund: Eine beim Start unlesbare data/chat.json wurde beim ersten Chat-Zug ohne Sicherung überschrieben, der ganze
// alte Verlauf war weg. Jetzt: vor dem ersten Speichern einmal .defekt (600), sonst Speichern gesperrt. Temp-Ordner.
const temp = mkdtempSync(join(tmpdir(), "jarvis-chat-defekt-"));
const gesperrt = mkdtempSync(join(tmpdir(), "jarvis-chat-gesperrt-"));
process.chdir(temp);
process.once("exit", () => {
  rmSync(temp, { recursive: true, force: true });
  rmSync(gesperrt, { recursive: true, force: true });
});

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = "chat-defekt-token-nur-attrappe-0123456";
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

const KAPUTT = '[{"role":"user","content":"ALTER-VERLAUF-WICHTIG"},{"role":"assistant","content":"abgeschnitten';
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "chat.json"), KAPUTT, { mode: 0o600 });

const { anthropic } = await import("../src/claude.js");
const agent = await import("../src/agent.js");
const dashboard = await import("../src/dashboard.js");
const telegram = await import("../src/telegram.js");

const client = anthropic();
client.messages.create = (async () => ({
  id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  content: [{ type: "text", text: "Neu, Sir.", citations: null }],
}) as Anthropic.Message) as unknown as typeof client.messages.create;
const hooks = { onAuftrag: async () => undefined } as unknown as Parameters<typeof agent.handleMessage>[1];

function verlauf(): any {
  const res = { statusCode: 200, body: undefined as any, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  dashboard.chatVerlauf({} as never, res as never);
  return res.body;
}

describe("unlesbare data/chat.json und der erste Chat-Zug", () => {
  it("vor dem ersten Speichern: Hinweis kündigt die Sicherung an, noch nichts geschrieben", () => {
    assert.equal(agent.chatNichtGeladen, true);
    assert.match(agent.chatHinweis()!, /Vor dem ersten Speichern sichere ich sie unter data\/chat\.json\.defekt/);
    assert.equal(existsSync(join(temp, "data", "chat.json.defekt")), false);
  });

  it("ein Chat-Zug: zuerst Sicherung mit dem alten Inhalt (600), danach der neue Verlauf; Hinweis nennt den Ort", async () => {
    assert.equal(await agent.handleMessage("Hallo", hooks), "Neu, Sir.");
    const sicherung = join(temp, "data", "chat.json.defekt");
    assert.equal(readFileSync(sicherung, "utf8"), KAPUTT, "der alte Verlauf liegt in der Sicherung");
    assert.equal(statSync(sicherung).mode & 0o777, 0o600);
    const neu = JSON.parse(readFileSync(join(temp, "data", "chat.json"), "utf8")) as { role: string }[];
    assert.deepEqual(neu.map((m) => m.role), ["user", "assistant"]);

    const v = verlauf();
    assert.equal(v.unlesbar, true);
    assert.equal(v.text, "data/chat.json war beim Start unlesbar, Sir (Sicherung unter data/chat.json.defekt). Der Verlauf beginnt seither neu.");
    assert.ok(!JSON.stringify(v).includes("ALTER-VERLAUF-WICHTIG"));
    assert.ok(telegram.dateiHinweise().includes(`⚠️ ${v.text}`), "auch in Startmeldung und /status");
  });

  it("weitere Züge sichern nicht erneut (die neue Datei ist ja lesbar)", async () => {
    agent.addSystemNote("Test");
    await agent.handleMessage("Noch etwas", hooks);
    assert.deepEqual(readdirSync(join(temp, "data")).filter((n) => n.startsWith("chat.json.defekt")), ["chat.json.defekt"]);
    assert.equal(readFileSync(join(temp, "data", "chat.json.defekt"), "utf8"), KAPUTT);
  });

  it("nicht zu sichern (hier: ein Ordner statt Datei, wie bei EACCES nicht lesbar): Datei bleibt, der Chat läuft weiter", async () => {
    process.chdir(gesperrt);
    mkdirSync(join(gesperrt, "data", "chat.json"), { recursive: true });
    writeFileSync(join(gesperrt, "data", "chat.json", "inhalt"), "ALTER-VERLAUF");
    const frisch = (await import(`../src/agent.js?gesperrt=${Date.now()}`)) as typeof agent;
    assert.equal(frisch.chatNichtGeladen, true);
    assert.equal(await frisch.handleMessage("Hallo", hooks), "Neu, Sir.", "kein Wurf beim Speichern");
    assert.equal(readFileSync(join(gesperrt, "data", "chat.json", "inhalt"), "utf8"), "ALTER-VERLAUF");
    assert.equal(existsSync(join(gesperrt, "data", "chat.json.tmp")), false, "nichts geschrieben");
    assert.match(frisch.chatHinweis()!, /liess sich nicht sichern, Sir\. Ich überschreibe sie nicht; der Verlauf gilt bis zum Neustart nur im Speicher\./);
    // Im Speicher geht das Gespräch weiter
    assert.deepEqual(frisch.letzteNachrichten().map((m) => m.text), ["Hallo", "Neu, Sir."]);
  });
});
