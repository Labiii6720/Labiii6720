import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Gesprächsfeld der Kommandozentrale (POST /api/chat): was nach der PIN aussieht (pinEingabe), geht weder an Claude noch
// in data/chat.json, den Verlauf oder das Telegram-Echo; gleiche Antwort, nicht gezählt. Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-chat-pin-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = "chat-pin-token-nur-attrappe-0123456789";

/** Texte, die an Telegram gingen (sendMessage) */
const telegram: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  if (url.endsWith("/sendMessage") && typeof init?.body === "string") telegram.push(String((JSON.parse(init.body) as { text?: string }).text ?? ""));
  return new Response(JSON.stringify({ ok: true, result: { message_id: telegram.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const dashboard = await import("../src/dashboard.js");
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

function antwort() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}
async function chat(text: string): Promise<{ statusCode: number; body: any }> {
  const res = antwort();
  await dashboard.chat({ body: { text } } as never, res as never);
  return { statusCode: res.statusCode, body: res.body };
}
async function verlauf(): Promise<{ rolle: string; text: string }[]> {
  const res = antwort();
  dashboard.chatVerlauf({} as never, res as never);
  return res.body.nachrichten;
}

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
  dashboard._chatFrist.ms = 60_000;
  state.paused = false;
  state.notfall = { aktiv: false };
});

const PIN_ANTWORT = { ok: false, error: "pin", text: "Das sieht aus wie eine PIN, Sir. Ich schicke es nicht weiter." };

describe("POST /api/chat: PIN-förmige Eingaben gehen nirgends hin", () => {
  it("die PIN selbst: 400 mit dem einen Text, nichts an Claude, nichts in data/chat.json, nichts nach Telegram; nicht gezählt", async () => {
    const r = await chat("4711");
    assert.equal(r.statusCode, 400);
    assert.deepEqual(r.body, PIN_ANTWORT);
    assert.deepEqual(anClaude, []);
    assert.equal(existsSync(CHAT), false, "kein Eintrag in der Historie");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(telegram, []);
    assert.equal(auditZeilen("pin_eingabe").length, 1);
    assert.equal(auditZeilen("abuse_signal").length, 0, "nicht als Missbrauch gezählt");
    assert.ok(!readFileSync(AUDIT, "utf8").includes("4711"), "die PIN steht nicht im Audit");
    assert.deepEqual(await verlauf(), []);
  });

  it("richtige und falsche PIN gleicher Form: genau dieselbe Antwort (kein Orakel), auch zehnmal ohne Notfall", async () => {
    const richtig = await chat("4711");
    for (const t of ["4712", "47 11", "4711.", "!4711", "Meine PIN ist 4712"]) assert.deepEqual(await chat(t), richtig, t);
    for (let i = 0; i < 10; i++) await chat(`000${i}`);
    assert.notEqual(state.notfall?.aktiv, true);
    assert.equal(auditZeilen("abuse_signal").length, 0);
    assert.deepEqual(anClaude, []);
    assert.equal(existsSync(CHAT), false);
  });

  it("Fehltreffer gehen an Claude: Uhrzeit, Betrag, Datum, Telefonnummer, Satz ohne PIN-Wort", async () => {
    for (const t of ["14.30", "12.50", "25.10.2026", "079 123 45 67", "Termin um 1430 mit Müller"]) {
      const r = await chat(t);
      assert.equal(r.statusCode, 200, t);
    }
    assert.equal(anClaude.length, 5);
  });

  it("Antworten und Verlauf ohne PIN-Schwärzung (Zahlen bleiben lesbar), Token weiter geschwärzt", async () => {
    claudeAntwort = "Um 14.30 an der Hauptstrasse 4711, Sir. Bearer abcdefghijklmnop123";
    const r = await chat("Wann und wo ist der Termin?");
    assert.equal(r.body.reply, "Um 14.30 an der Hauptstrasse 4711, Sir. Bearer <token>");
    assert.deepEqual((await verlauf()).at(-1), { rolle: "jarvis", text: "Um 14.30 an der Hauptstrasse 4711, Sir. Bearer <token>" });

    // Dauert die Antwort länger als die Frist, geht sie mit Echo nach Telegram
    dashboard._chatFrist.ms = 5;
    claudeVerzoegerung = 40;
    claudeAntwort = "Später, Sir.";
    const spaet = await chat("Bitte prüfen, ob Bestellung 1042 da ist");
    assert.equal(spaet.body.queued, true);
    for (let i = 0; i < 50 && telegram.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(telegram, ["Zur Frage aus der Zentrale («Bitte prüfen, ob Bestellung 1042 da ist»):\n\nSpäter, Sir."]);
  });
});
