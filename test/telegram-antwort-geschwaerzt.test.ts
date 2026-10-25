import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befund: Im direkten Telegram-Chat gingen die Claude-Antwort, das 🎙-Echo der Transkription und der TTS-Text roh
// hinaus (ohne schwaerze und pinGeschwaerzt). Die gemeinsame Historie kann aus anderen Kanälen eine PIN im Satz oder
// ein Token enthalten. Die Historie selbst bleibt unverändert. Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-telegram-geschwaerzt-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_ANREDE = "Sir";
process.env.JARVIS_FORM = "sie";
process.env.STT_URL = "https://stt.invalid/v1/audio/transcriptions";
process.env.TTS_URL = "https://tts.invalid/v1/audio/speech";

const telegram: string[] = [];
const ttsTexte: string[] = [];
let sttText = "";
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (url.startsWith("https://stt.invalid/")) return new Response(JSON.stringify({ text: sttText }), { headers: { "content-type": "application/json" } });
  if (url.startsWith("https://tts.invalid/")) {
    ttsTexte.push(String((JSON.parse(String(init?.body)) as { input?: string }).input ?? ""));
    return new Response(new Uint8Array([1, 2, 3]));
  }
  if (url.startsWith("https://api.telegram.org/file/")) return new Response(new Uint8Array([1, 2, 3]));
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  const method = url.split("/").pop() ?? "";
  if (method === "sendMessage" && typeof init?.body === "string") telegram.push(String((JSON.parse(init.body) as { text?: string }).text ?? ""));
  const result = method === "getFile" ? { file_path: "voice/a.oga" } : { message_id: telegram.length + 1 };
  return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const { handleUpdate, setzeWarten } = await import("../src/telegram.js");

const client = anthropic();
const anClaude: string[] = [];
let claudeAntwort = "";
client.messages.create = (async (p: Anthropic.MessageCreateParams) => {
  const letzte = p.messages.at(-1)!;
  anClaude.push(typeof letzte.content === "string" ? letzte.content : JSON.stringify(letzte.content));
  return {
    id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
    content: [{ type: "text", text: claudeAntwort, citations: null }],
  } as Anthropic.Message;
}) as unknown as typeof client.messages.create;

const CHAT = join(temp, "data", "chat.json");
let nr = 3000;

beforeEach(() => {
  setzeWarten(async () => {}, () => 0.5);
  telegram.length = 0;
  ttsTexte.length = 0;
  anClaude.length = 0;
});

describe("Telegram-Chat: Antwort, 🎙-Echo und Sprachantwort gehen geschwärzt hinaus", () => {
  it("Text: PIN und Bearer-Token in der Antwort → «<PIN>», «Bearer <token>»; die Historie bleibt unverändert", async () => {
    // Die PIN stand vorher in einem Satz des Nutzers (etwa aus der Zentrale) in der gemeinsamen Historie
    claudeAntwort = "Notiert, Sir.";
    await handleUpdate({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, text: "Merk dir 4711 für die Garage" } });
    telegram.length = 0;
    claudeAntwort = "Sie nannten 4711, Sir. Header: Bearer abcdefghijklmnop123";
    await handleUpdate({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, text: "Welche Zahl nannte ich in der Zentrale?" } });
    assert.deepEqual(telegram, ["Sie nannten <PIN>, Sir. Header: Bearer <token>"]);
    assert.ok(readFileSync(CHAT, "utf8").includes("Sie nannten 4711, Sir."), "Historie unverändert");
  });

  it("Sprache: Echo der Transkription und TTS-Text geschwärzt, Claude bekommt den Satz unverändert", async () => {
    sttText = "Meine PIN ist 4711, vergiss sie wieder";
    claudeAntwort = "Vergessen, Sir. Die 4711 sage ich nie wieder, Schlüssel sk-ant-abcdefghijkl123.";
    await handleUpdate({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, voice: { file_id: "datei", duration: 3 } } });
    assert.equal(telegram[0], "🎙 Meine PIN ist <PIN>, vergiss sie wieder");
    assert.match(telegram[1]!, /^Vergessen, Sir\. Die <PIN> sage ich nie wieder/);
    assert.ok(!telegram.some((t) => t.includes("4711") || t.includes("abcdefghijkl")), telegram.join(" | "));
    assert.equal(ttsTexte.length, 1);
    assert.ok(!ttsTexte[0]!.includes("4711") && !ttsTexte[0]!.includes("abcdefghijkl"), ttsTexte[0]);
    assert.ok(anClaude.some((t) => t.includes("Meine PIN ist 4711")), "an Claude unverändert");
  });
});
