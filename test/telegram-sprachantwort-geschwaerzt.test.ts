import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Ersatz für test/telegram-antwort-geschwaerzt.test.ts (in 0.24 mit der PIN-Schwärzung entfernt): Der Text für die
// Sprachausgabe (sendVoiceReply → TTS-Anbieter) trägt keine Schlüssel und Tokens (schwaerze). Eine Zahl wird seit 0.24
// nicht mehr geschwärzt. Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-telegram-sprachantwort-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
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

const { abhaengigkeiten, handleUpdate, sendVoiceReply, setzeWarten } = await import("../src/telegram.js");

const GEHEIM = "Schlüssel sk-ant-abcdefghijkl123, Header Bearer abcdefghijklmnop123, Bot bot123456789:ABCdefGHIjklMNOpqr, https://ich:passwort@kamera.local/ und ?token=zugang123";
const geheimDrin = (t: string) => /abcdefghijkl|ABCdefGHI|passwort|zugang123/.test(t);

const origHandle = abhaengigkeiten.handleMessage;
let nr = 5000;
beforeEach(() => {
  setzeWarten(async () => {}, () => 0.5);
  telegram.length = 0;
  ttsTexte.length = 0;
});
afterEach(() => { abhaengigkeiten.handleMessage = origHandle; });

describe("Sprachantwort (TTS) ohne Schlüssel und Tokens", () => {
  it("Sprachnachricht: Antwort von Claude mit Geheimnissen → weder Text noch TTS-Eingabe enthalten sie; Zahlen bleiben", async () => {
    sttText = "Wie lautet der Schlüssel?";
    abhaengigkeiten.handleMessage = async () => `Termin um 14.30, Sir. ${GEHEIM}`;
    await handleUpdate({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, voice: { file_id: "datei", duration: 3 } } });
    assert.equal(ttsTexte.length, 1);
    assert.ok(!geheimDrin(ttsTexte[0]!), ttsTexte[0]);
    assert.match(ttsTexte[0]!, /sk-ant-<schlüssel/, "schwaerze() angewendet, nicht nur forSpeech (das «>» nimmt forSpeech)");
    assert.match(ttsTexte[0]!, /14\.30/);
    assert.ok(!telegram.some(geheimDrin), telegram.join(" | "));
  });

  it("sendVoiceReply schwärzt selbst: auch ein ungeschwärzter Text eines Aufrufers (Briefing, events.ts) geht ohne Geheimnisse zum TTS", async () => {
    await sendVoiceReply(`Guten Morgen, Sir. ${GEHEIM}`);
    assert.equal(ttsTexte.length, 1);
    assert.ok(!geheimDrin(ttsTexte[0]!), ttsTexte[0]);
    assert.match(ttsTexte[0]!, /Bearer <token/);
    assert.match(ttsTexte[0]!, /bot<token/);
  });
});
