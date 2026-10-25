import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Request, Response } from "express";

// Befund: Eine in der Gesten-Konsole gesprochene (oder im Kurzbefehl getippte) PIN ging über POST /events
// (frage_sync, frage) ungefiltert an Claude und in data/chat.json. Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-events-pin-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const TOKEN = "events-pin-token-nur-attrappe-0123456789";
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = TOKEN;

/** Texte, die an Telegram gingen (sendMessage) */
const telegram: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  if (url.endsWith("/sendMessage") && typeof init?.body === "string") telegram.push(String((JSON.parse(init.body) as { text?: string }).text ?? ""));
  return new Response(JSON.stringify({ ok: true, result: { message_id: telegram.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const { handleEvent } = await import("../src/events.js");
const { state } = await import("../src/state.js");
const { missbrauchZuruecksetzen } = await import("../src/notfall.js");
const { setzeWarten } = await import("../src/telegram.js");

const CHAT = join(temp, "data", "chat.json");
const AUDIT = join(temp, "data", "audit.log");
const auditZeilen = (ereignis: string) => (existsSync(AUDIT) ? readFileSync(AUDIT, "utf8").split("\n").filter((z) => z.includes(`"event":"${ereignis}"`)) : []);

const client = anthropic();
const origCreate = client.messages.create;
/** Was an Claude ging (letzte Nutzernachricht je Aufruf) */
let anClaude: string[] = [];
let claudeAntwort = "Gern, Sir.";
let claudeVerzoegerung = 0;

const nachricht = (text: string): Anthropic.Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  content: [{ type: "text", text, citations: null }],
} as Anthropic.Message);

/** POST /events mit gültigem Token; Express-Anfrage und -Antwort als schlanke Attrappen. */
async function sende(body: unknown): Promise<{ status: number; body: any }> {
  const req = { body, ip: "192.168.1.20", header: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${TOKEN}` : undefined) } as unknown as Request;
  const a = { status: 200, body: undefined as any, beendet: false };
  const res = {
    get headersSent() { return a.beendet; },
    status(c: number) { a.status = c; return res; },
    json(b: unknown) { a.body = b; a.beendet = true; return res; },
    end() { a.beendet = true; return res; },
  } as unknown as Response;
  await handleEvent(req, res);
  return { status: a.status, body: a.body };
}
const ruhe = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

const PIN_ANTWORT = { ok: false, error: "pin", text: "Die PIN gehört nicht in den Chat, Sir. Nichts gesendet." };

beforeEach(() => {
  setzeWarten(async () => {}, () => 0.5);
  missbrauchZuruecksetzen();
  telegram.length = 0;
  anClaude = [];
  claudeAntwort = "Gern, Sir.";
  claudeVerzoegerung = 0;
  client.messages.create = (async (p: Anthropic.MessageCreateParams) => {
    const letzte = p.messages.at(-1)!;
    anClaude.push(typeof letzte.content === "string" ? letzte.content : JSON.stringify(letzte.content));
    if (claudeVerzoegerung) await new Promise((r) => setTimeout(r, claudeVerzoegerung));
    return nachricht(claudeAntwort);
  }) as unknown as typeof client.messages.create;
});
afterEach(() => {
  client.messages.create = origCreate;
  state.paused = false;
  state.notfall = { aktiv: false };
});

describe("POST /events: die PIN geht nie an Claude", () => {
  it("frage_sync aus der Konsole (gesprochen, mit Satzzeichen, mit Leerraum) und als Stimme: 400 pin, nichts an Claude, nichts in data/chat.json", async () => {
    const eingaben: [string, string | undefined][] = [["4711", undefined], ["4711.", undefined], [" 4711! ", "stimme"], ["4712", undefined]];
    for (const [text, kanal] of eingaben) {
      const r = await sende({ event: "frage_sync", text, ...(kanal ? { kanal } : {}) });
      assert.equal(r.status, 400, text);
      assert.deepEqual(r.body, PIN_ANTWORT, text);
    }
    await ruhe();
    assert.deepEqual(anClaude, []);
    assert.equal(existsSync(CHAT), false, "kein Eintrag in der Historie");
    assert.deepEqual(telegram, []);
    assert.equal(auditZeilen("pin_im_chat").length, 4);
    assert.ok(auditZeilen("pin_im_chat").every((z) => z.includes('"quelle":"events"')));
    assert.equal(auditZeilen("abuse_signal").length, 4, "zählt wie in Telegram und in der Kommandozentrale");
    assert.ok(!readFileSync(AUDIT, "utf8").includes("4711"), "die PIN steht nicht im Audit");
  });

  it("frage (Antwort per Telegram): ebenso abgewiesen, nichts an Claude, nichts nach Telegram", async () => {
    const r = await sende({ event: "frage", text: "4711?" });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, PIN_ANTWORT);
    await ruhe();
    assert.deepEqual(anClaude, []);
    assert.equal(existsSync(CHAT), false);
    assert.deepEqual(telegram, []);
  });

  it("ein Satz geht weiter an Claude; kommt die Antwort spät per Telegram, stehen Echo und Antwort ohne PIN", async () => {
    const sofort = await sende({ event: "frage_sync", text: "Wie wird das Wetter?" });
    assert.equal(sofort.status, 200);
    assert.equal(sofort.body.reply, "Gern, Sir.");
    assert.equal(anClaude.length, 1);

    claudeVerzoegerung = 4000;
    claudeAntwort = "Die 4711 merke ich mir nicht, Sir.";
    const spaet = await sende({ event: "frage_sync", text: "Gilt 4711 noch als PIN?", budget: 1 });
    assert.equal(spaet.body.queued, true);
    for (let i = 0; i < 600 && telegram.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(telegram.length, 1);
    assert.match(telegram[0]!, /^Zu Ihrer Frage von unterwegs \(«Gilt <PIN> noch als PIN\?»\):\n\nDie <PIN> merke ich mir nicht, Sir\.$/);
  });
});
