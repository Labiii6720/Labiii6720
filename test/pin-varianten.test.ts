import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Request, Response } from "express";

// Befund: Einzeln gesprochene Ziffern («4 7 1 1», «47-11», «4, 7, 1, 1.»), ein vorangestelltes «!» (starkes Modell)
// und Anführungszeichen machten die PIN unkenntlich: sie ging an Claude, in data/chat.json und als Echo nach Telegram,
// und die Schwärzung fing sie nicht. Dazu: beim Ereignis «frage» ging die Antwort ungeschwärzt nach Telegram.
// Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-pin-varianten-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const TOKEN = "pin-varianten-token-nur-attrappe-0123456789";
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = TOKEN;
process.env.JARVIS_ANREDE = "Sir";
process.env.JARVIS_FORM = "sie";
process.env.STT_URL = "https://stt.invalid/v1/audio/transcriptions";

/** Was an Telegram ging (Methode, Text) */
let aufrufe: { method: string; text?: string }[] = [];
let sttText = "";
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (url.startsWith("https://stt.invalid/")) return new Response(JSON.stringify({ text: sttText }), { headers: { "content-type": "application/json" } });
  if (url.startsWith("https://api.telegram.org/file/")) return new Response(new Uint8Array([1, 2, 3]));
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  const method = url.split("/").pop() ?? "";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  aufrufe.push({ method, text: body.text });
  const result = method === "getFile" ? { file_path: "voice/a.oga" } : { message_id: aufrufe.length };
  return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const { pinGeschwaerzt } = await import("../src/agent.js");
const dashboard = await import("../src/dashboard.js");
const { handleEvent } = await import("../src/events.js");
const { handleUpdate, pinFoermigLocker, setzeWarten } = await import("../src/telegram.js");
const { state } = await import("../src/state.js");
const { missbrauchZuruecksetzen } = await import("../src/notfall.js");

const CHAT = join(temp, "data", "chat.json");
const client = anthropic();
const origCreate = client.messages.create;
let anClaude: string[] = [];
let claudeAntwort = "Gern, Sir.";

const nachricht = (text: string): Anthropic.Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  content: [{ type: "text", text, citations: null }],
} as Anthropic.Message);

const gesendet = () => aufrufe.filter((x) => x.method === "sendMessage").map((x) => x.text ?? "");
const chatEnthaelt = (s: string) => existsSync(CHAT) && readFileSync(CHAT, "utf8").includes(s);
let nr = 5000;

function antwort() {
  return {
    statusCode: 200,
    body: undefined as any,
    headersSent: false,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; },
  };
}
async function chat(text: string): Promise<{ statusCode: number; body: any }> {
  const res = antwort();
  await dashboard.chat({ body: { text } } as never, res as never);
  return { statusCode: res.statusCode, body: res.body };
}
async function ereignis(body: unknown): Promise<{ statusCode: number; body: any }> {
  const req = { body, ip: "192.168.1.20", header: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${TOKEN}` : undefined) } as unknown as Request;
  const res = antwort();
  await handleEvent(req, res as unknown as Response);
  return { statusCode: res.statusCode, body: res.body };
}

const VARIANTEN = ["4 7 1 1", "47 11", "4-7-1-1", "4, 7, 1, 1.", "4–7–1–1", "!4711", "! 4711", "«4711»", "\"4711\"", "„4711“", "!4 7 1 1"];

beforeEach(() => {
  setzeWarten(async () => {}, () => 0.5);
  missbrauchZuruecksetzen();
  aufrufe = [];
  anClaude = [];
  claudeAntwort = "Gern, Sir.";
  client.messages.create = (async (p: Anthropic.MessageCreateParams) => {
    const letzte = p.messages.at(-1)!;
    anClaude.push(typeof letzte.content === "string" ? letzte.content : JSON.stringify(letzte.content));
    return nachricht(claudeAntwort);
  }) as unknown as typeof client.messages.create;
});
afterEach(() => {
  client.messages.create = origCreate;
  state.paused = false;
  state.notfall = { aktiv: false };
});

describe("pinFoermigLocker und pinGeschwaerzt: gesprochene Ziffern, «!» und Anführungszeichen", () => {
  it("erkennt die Varianten als PIN-förmig, Sätze und zu kurze Zahlen nicht", () => {
    for (const t of VARIANTEN) assert.notEqual(pinFoermigLocker(t), undefined, t);
    for (const t of ["Ist 4711 gut?", "4 7 1", "Termin um 14 30", "12.5", "!wie spät ist es", "«Danke»"]) assert.equal(pinFoermigLocker(t), undefined, t);
  });

  it("schwärzt die PIN auch mit Leerraum oder Bindestrich zwischen den Ziffern", () => {
    assert.equal(pinGeschwaerzt("Die 4 7 1 1, die 47-11, die 4, 7, 1, 1 und die 4711."), "Die <PIN>, die <PIN>, die <PIN> und die <PIN>.");
    // Dieselbe Klasse wie der Locker («47 11» gilt dort als PIN): in Texten des Nutzers auch «14 30» und «47 12»
    assert.equal(pinGeschwaerzt("Um 14 30 Uhr, Zimmer 47 12"), "Um <PIN> Uhr, Zimmer <PIN>");
  });
});

describe("Die Varianten gehen auf keinem Weg an Claude", () => {
  it("Telegram-Text: gelöscht, gleiche Antwort, nichts an Claude oder in data/chat.json", async () => {
    for (const t of ["!4711", "47 11", "«4711»", "4-7-1-1"]) {
      missbrauchZuruecksetzen();
      aufrufe = [];
      await handleUpdate({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, text: t } });
      assert.deepEqual(gesendet(), ["Keine Freigabe wartet auf eine PIN, Sir. Nachricht gelöscht."], t);
      assert.equal(aufrufe.filter((x) => x.method === "deleteMessage").length, 1, t);
    }
    assert.deepEqual(anClaude, []);
    assert.equal(existsSync(CHAT), false);
  });

  it("Telegram-Sprache «4 7 1 1»: kein Echo, nichts an Claude", async () => {
    for (const t of ["4 7 1 1", "4, 7, 1, 1.", "47 11"]) {
      missbrauchZuruecksetzen();
      aufrufe = [];
      sttText = t;
      await handleUpdate({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, voice: { file_id: "datei", duration: 3 } } });
      assert.deepEqual(gesendet(), ["Die PIN bitte tippen, Sir, nie sprechen. Sprachnachricht gelöscht."], t);
      assert.ok(!gesendet().some((x) => x.startsWith("🎙")), t);
    }
    assert.deepEqual(anClaude, []);
    assert.equal(existsSync(CHAT), false);
  });

  it("Kommandozentrale: «!4711» und «47-11» → 400 pin", async () => {
    for (const t of ["!4711", "47-11", "„4711“"]) {
      missbrauchZuruecksetzen();
      const r = await chat(t);
      assert.equal(r.statusCode, 400, t);
      assert.equal(r.body.error, "pin", t);
    }
    assert.deepEqual(anClaude, []);
    assert.equal(existsSync(CHAT), false);
  });

  it("/events frage_sync und frage: «4 7 1 1», «!4711», «47-11» → 400 pin", async () => {
    for (const [event, t] of [["frage_sync", "4 7 1 1"], ["frage_sync", "!4711"], ["frage", "47-11"], ["frage", "«4711»"]] as const) {
      missbrauchZuruecksetzen();
      const r = await ereignis({ event, text: t });
      assert.equal(r.statusCode, 400, `${event} ${t}`);
      assert.equal(r.body.error, "pin", `${event} ${t}`);
    }
    assert.deepEqual(anClaude, []);
    assert.equal(existsSync(CHAT), false);
    assert.deepEqual(gesendet(), []);
  });

  it("Verlauf der Kommandozentrale: «47-11» und «4 7 1 1» in Sätzen erscheinen geschwärzt", async () => {
    claudeAntwort = "Ja, 4 7 1 1 gilt noch, Sir.";
    const r = await chat("Gilt 47-11 noch?");
    assert.equal(r.statusCode, 200);
    const res = antwort();
    dashboard.chatVerlauf({} as never, res as never);
    const texte = (res.body.nachrichten as { text: string }[]).map((n) => n.text);
    assert.deepEqual(texte.slice(-2), ["Gilt <PIN> noch?", "Ja, <PIN> gilt noch, Sir."]);
  });
});

describe("Ereignis «frage»: die Antwort geht geschwärzt nach Telegram", () => {
  it("wiederholt Claude die PIN, steht in Telegram «<PIN>»", async () => {
    claudeAntwort = "Die 4711 gilt noch, Sir.";
    const r = await ereignis({ event: "frage", text: "Prüfe, ob 4711 noch gilt" });
    assert.equal(r.body.queued, true);
    assert.equal(anClaude.length, 1);
    assert.deepEqual(gesendet(), ["Die <PIN> gilt noch, Sir."]);
  });

  it("wiederholt Claude Schlüssel oder Token, steht in Telegram nur der Platzhalter", async () => {
    claudeAntwort = "Schlüssel sk-ant-abcdefgh1234, Bearer abcdefghijkl und bot987654321:ZYXwvuTSRqpoNMLkji, Sir.";
    const r = await ereignis({ event: "frage", text: "Welche Zugangsdaten stehen im Log?" });
    assert.equal(r.body.queued, true);
    assert.equal(anClaude.length, 1);
    assert.deepEqual(gesendet(), ["Schlüssel sk-ant-<schlüssel>, Bearer <token> und bot<token>, Sir."]);
    for (const geheim of ["abcdefgh1234", "abcdefghijkl", "ZYXwvuTSRqpoNMLkji"]) assert.ok(!gesendet().some((x) => x.includes(geheim)), geheim);
  });
});
