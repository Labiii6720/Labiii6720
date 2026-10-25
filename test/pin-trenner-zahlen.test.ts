import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Request, Response } from "express";

// Befund: Die Trenner-Fassung in pinFoermigLocker zog bei einer Ziffern-PIN alle Trenner zwischen Ziffern zusammen.
// Uhrzeiten, Beträge, Daten und Telefonnummern («14.30», «120.50», «25.10.2026», «079 123 45 67») galten so als PIN:
// gelöscht, nicht an Claude, und jedes Mal abuseSignal("pin") – fünf Antworten auf Rückfragen lösten den Notfall aus.
// Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-pin-trenner-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const TOKEN = "pin-trenner-token-nur-attrappe-0123456789";
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = TOKEN;
process.env.JARVIS_ANREDE = "Sir";
process.env.JARVIS_FORM = "sie";
process.env.STT_URL = "https://stt.invalid/v1/audio/transcriptions";
delete process.env.ALEXA_VOICE;
delete process.env.ALEXA_NACHT;

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
const dashboard = await import("../src/dashboard.js");
const { handleEvent } = await import("../src/events.js");
const { buildSkill, _testOptionen } = await import("../src/alexa.js");
const { handleUpdate, pinFoermigLocker, setzeWarten } = await import("../src/telegram.js");
const { state } = await import("../src/state.js");
const { missbrauchZuruecksetzen } = await import("../src/notfall.js");

const AUDIT = join(temp, "data", "audit.log");
const missbrauch = () => (existsSync(AUDIT) ? readFileSync(AUDIT, "utf8").split("\n").filter((z) => z.includes('"event":"abuse_signal"')).length : 0);

const client = anthropic();
const origCreate = client.messages.create;
let anClaude: string[] = [];

const nachricht = (text: string): Anthropic.Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  content: [{ type: "text", text, citations: null }],
} as Anthropic.Message);

const gesendet = () => aufrufe.filter((x) => x.method === "sendMessage").map((x) => x.text ?? "");
let nr = 7000;

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
const SKILL = "amzn1.ask.skill.00000000-0000-0000-0000-000000000000";
const skill = buildSkill(SKILL);
async function frage(wert: string): Promise<string> {
  const env = {
    version: "1.0",
    session: { new: true, sessionId: "s", application: { applicationId: SKILL }, user: { userId: "u" } },
    context: { System: { application: { applicationId: SKILL }, user: { userId: "u" }, device: { deviceId: "d", supportedInterfaces: {} }, apiEndpoint: "https://api.eu.amazonalexa.com" } },
    request: { type: "IntentRequest", requestId: "r", timestamp: "2026-10-11T06:00:00Z", locale: "de-DE", intent: { name: "FrageIntent", confirmationStatus: "NONE", slots: { frage: { name: "frage", value: wert } } } },
  };
  const a = (await skill.invoke(env as never)) as { response: { outputSpeech?: { ssml: string } } };
  return a.response.outputSpeech?.ssml ?? "";
}
const text = (t: string) => handleUpdate({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, text: t } });

/** Nackte Antworten auf Rückfragen («Um wie viel Uhr?», «Welcher Betrag?», «Welche Nummer?») */
const ZAHLEN = ["14.30", "16.45", "12.50", "120.50", "1250.00", "25.10.2026", "25.10.", "079 123 45 67", "2026-10-25", "12, 13, 14", "1 2 3 4 5 6 7 8 9 0 1 2"];

beforeEach(() => {
  setzeWarten(async () => {}, () => 0.5);
  missbrauchZuruecksetzen();
  _testOptionen.jetzt = () => new Date(2026, 9, 11, 12, 0);
  aufrufe = [];
  anClaude = [];
  client.messages.create = (async (p: Anthropic.MessageCreateParams) => {
    const letzte = p.messages.at(-1)!;
    anClaude.push(typeof letzte.content === "string" ? letzte.content : JSON.stringify(letzte.content));
    return nachricht("Notiert, Sir.");
  }) as unknown as typeof client.messages.create;
});
afterEach(() => {
  client.messages.create = origCreate;
  state.paused = false;
  state.notfall = { aktiv: false };
});

describe("pinFoermigLocker: Trenner nur für gesprochene Ziffern in PIN-Länge", () => {
  it("Uhrzeit, Betrag, Datum und Telefonnummer sind nicht PIN-förmig", () => {
    for (const t of ZAHLEN) assert.equal(pinFoermigLocker(t), undefined, t);
  });

  it("gesprochene Ziffern, «47-11» und «4711.» bleiben PIN-förmig", () => {
    for (const t of ["4 7 1 1", "4, 7, 1, 1.", "4.7.1.1", "4–7–1–1", "47-11", "47 11", "!4 7 1 1", "4711.", "«4711»"]) {
      assert.notEqual(pinFoermigLocker(t), undefined, t);
    }
  });
});

describe("Zahlenantworten gehen auf allen Wegen an Claude und zählen nicht", () => {
  it("Telegram-Text: an Claude, nicht gelöscht, kein abuse_signal", async () => {
    for (const t of ["14.30", "1250.00", "25.10.2026", "079 123 45 67"]) {
      aufrufe = [];
      await text(t);
      assert.equal(aufrufe.filter((x) => x.method === "deleteMessage").length, 0, t);
      assert.deepEqual(gesendet(), ["Notiert, Sir."], t);
    }
    assert.equal(anClaude.length, 4);
    assert.equal(missbrauch(), 0);
  });

  it("Telegram-Sprache «14.30»: Echo und Antwort, nichts gelöscht", async () => {
    sttText = "14.30";
    await handleUpdate({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, voice: { file_id: "datei", duration: 2 } } });
    assert.deepEqual(gesendet(), ["🎙 14.30", "Notiert, Sir."]);
    assert.equal(missbrauch(), 0);
  });

  it("Kommandozentrale, /events frage_sync und Alexa: an Claude, kein 400 pin", async () => {
    for (const t of ["14.30", "1250.00", "25.10.2026", "079 123 45 67"]) {
      const c = await chat(t);
      assert.equal(c.statusCode, 200, `Dashboard ${t}`);
      const e = await ereignis({ event: "frage_sync", text: t });
      assert.equal(e.statusCode, 200, `/events ${t}`);
      assert.notEqual(e.body?.error, "pin", `/events ${t}`);
      assert.doesNotMatch(await frage(t), /PIN bitte nie sprechen/, `Alexa ${t}`);
    }
    assert.equal(anClaude.length, 12);
    assert.equal(missbrauch(), 0);
  });

  it("fünf solche Antworten in Telegram lösen keinen Notfall aus", async () => {
    for (const t of ["14.30", "1250.00", "25.10.2026", "079 123 45 67", "16.45"]) await text(t);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(Boolean(state.notfall?.aktiv), false);
    assert.equal(Boolean(state.paused), false);
    assert.ok(!gesendet().some((x) => x.includes("NOTFALL")));
  });

  it("Gegenprobe: «4 7 1 1» in Telegram wird weiterhin gelöscht und gezählt", async () => {
    await text("4 7 1 1");
    assert.deepEqual(gesendet(), ["Keine Freigabe wartet auf eine PIN, Sir. Nachricht gelöscht."]);
    assert.equal(missbrauch(), 1);
    assert.deepEqual(anClaude, []);
  });
});
