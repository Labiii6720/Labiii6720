import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befund: Kam der Notaus während der Antwort, hielt runLoop sie zurück (nur pausiertText), aber GET /api/chat/verlauf
// zeigte sie danach als «Jarvis». Ebenso eine Antwort, die Telegram wegen des Notaus nicht mehr sendet.
const temp = mkdtempSync(join(tmpdir(), "jarvis-verlauf-notaus-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = "verlauf-notaus-token-nur-attrappe-0123";

/** Gesendete Telegram-Texte; `beimSenden` darf für einen Text einen Fehler (Status) liefern */
const telegram: string[] = [];
let beimSenden: ((text: string) => number | undefined) | undefined;
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  if (url.endsWith("/sendMessage") && typeof init?.body === "string") {
    const text = String((JSON.parse(init.body) as { text?: string }).text ?? "");
    const fehler = beimSenden?.(text);
    if (fehler) return new Response(JSON.stringify({ ok: false, error_code: fehler, description: "Attrappe" }), { status: fehler, headers: { "content-type": "application/json" } });
    telegram.push(text);
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: telegram.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const agent = await import("../src/agent.js");
const dashboard = await import("../src/dashboard.js");
const telegramMod = await import("../src/telegram.js");
const { state } = await import("../src/state.js");

const client = anthropic();
const origCreate = client.messages.create;
const origHandle = telegramMod.abhaengigkeiten.handleMessage;
const hooks = { onAuftrag: async () => undefined } as unknown as Parameters<typeof agent.handleMessage>[1];
/** Nachrichten des letzten API-Aufrufs */
let gesendetAnApi: Anthropic.MessageParam[] = [];
let antwortText = "";
let pauseImAufruf = false;

const nachricht = (text: string): Anthropic.Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  content: [{ type: "text", text, citations: null }],
} as Anthropic.Message);

async function verlauf(): Promise<any> {
  const res = { statusCode: 200, body: undefined as any, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  dashboard.chatVerlauf({} as never, res as never);
  return res.body;
}
const texte = async () => ((await verlauf()).nachrichten as { text: string }[]).map((m) => m.text);

beforeEach(() => {
  telegramMod.setzeWarten(async () => {}, () => 0.5);
  telegram.length = 0;
  beimSenden = undefined;
  pauseImAufruf = false;
  client.messages.create = (async (p: Anthropic.MessageCreateParams) => {
    gesendetAnApi = structuredClone(p.messages);
    if (pauseImAufruf) state.paused = true; // /pause trifft ein, während die Antwort unterwegs ist
    return nachricht(antwortText);
  }) as unknown as typeof client.messages.create;
});
afterEach(() => {
  client.messages.create = origCreate;
  telegramMod.abhaengigkeiten.handleMessage = origHandle;
  state.paused = false;
  state.notfall = { aktiv: false };
});

describe("Gesprächsverlauf und Notaus", () => {
  it("Notaus während des letzten Aufrufs: die zurückgehaltene Antwort fehlt im Verlauf, auch nach /weiter und Neustart", async () => {
    antwortText = "ZURUECKGEHALTEN-1: Ihre Rechnungen";
    pauseImAufruf = true;
    const r = await agent.handleMessage("[Kommandozentrale] Welche Rechnungen sind offen?", hooks);
    assert.equal(r, agent.pausiertText());

    // Noch im Notaus: kein Verlauf, sondern ein Hinweis
    const imNotaus = await verlauf();
    assert.deepEqual(imNotaus.nachrichten, []);
    assert.equal(imNotaus.pausiert, true);
    assert.match(imNotaus.text, /^Notaus aktiv, Sir\./);

    state.paused = false; // /weiter
    const nachher = await texte();
    assert.ok(nachher.includes("Welche Rechnungen sind offen?"), "die Frage bleibt sichtbar");
    assert.ok(!nachher.some((t) => t.includes("ZURUECKGEHALTEN-1")), "die Antwort nicht");

    // Markierung steht in data/chat.json; ein Neustart (frische Modulinstanz) zeigt sie ebenso wenig
    assert.match(readFileSync(join(temp, "data", "chat.json"), "utf8"), /"zurueckgehalten":true/);
    const frisch = (await import(`../src/agent.js?neustart=${Date.now()}`)) as typeof agent;
    assert.ok(!frisch.letzteNachrichten().some((m) => m.text.includes("ZURUECKGEHALTEN-1")));
  });

  it("die zurückgehaltene Antwort bleibt Claude erhalten, aber ohne das eigene Feld (die API nähme es nicht an)", async () => {
    antwortText = "Weiter geht's, Sir.";
    assert.equal(await agent.handleMessage("Und jetzt?", hooks), "Weiter geht's, Sir.");
    assert.ok(gesendetAnApi.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("ZURUECKGEHALTEN-1")));
    for (const m of gesendetAnApi) assert.deepEqual(Object.keys(m).sort(), ["content", "role"]);
    assert.ok((await texte()).includes("Weiter geht's, Sir."), "gewöhnliche Antworten erscheinen weiter");
  });

  it("Telegram: Notaus nach runLoop, vor dem Senden – die Antwort fehlt auch im Verlauf", async () => {
    antwortText = "ZURUECKGEHALTEN-2: Kontostand";
    telegramMod.abhaengigkeiten.handleMessage = async (text, h, opts) => {
      const antwort = await agent.handleMessage(text, h, opts);
      state.paused = true; // /pause kam, nachdem runLoop fertig war
      return antwort;
    };
    await telegramMod.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 12345 }, text: "Wie steht das Konto?" } });
    assert.deepEqual(telegram, [agent.pausiertText()]);
    state.paused = false;
    const t = await texte();
    assert.ok(t.includes("Wie steht das Konto?"));
    assert.ok(!t.some((x) => x.includes("ZURUECKGEHALTEN-2")));
  });

  it("Telegram: Notaus während des Sendens – nicht zugestellt, und auch nicht im Verlauf", async () => {
    antwortText = "ZURUECKGEHALTEN-3: Termine";
    beimSenden = (text) => {
      if (!text.includes("ZURUECKGEHALTEN-3")) return undefined;
      state.paused = true; // /pause kommt, während Telegram gestört ist
      return 502;
    };
    await telegramMod.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: 12345 }, text: "Was steht morgen an?" } });
    assert.deepEqual(telegram, []);
    state.paused = false;
    const t = await texte();
    assert.ok(t.includes("Was steht morgen an?"));
    assert.ok(!t.some((x) => x.includes("ZURUECKGEHALTEN-3")));
  });
});
