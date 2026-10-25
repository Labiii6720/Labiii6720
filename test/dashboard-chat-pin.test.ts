import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befund: Das Gesprächsfeld der Kommandozentrale gab eine irrtümlich eingetippte PIN an Claude, in data/chat.json,
// in den Verlauf (GET /api/chat/verlauf) und nach 60 s ins Telegram-Echo. Temp-Ordner, Attrappen, kein Netz.
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

describe("POST /api/chat: die PIN gehört nicht in den Chat", () => {
  it("die PIN selbst: 400, nichts an Claude, nichts in data/chat.json, nichts nach Telegram; gezählt", async () => {
    const r = await chat("4711");
    assert.equal(r.statusCode, 400);
    assert.deepEqual(r.body, { ok: false, error: "pin", text: "Die PIN gehört nicht in den Chat, Sir. Nichts gesendet." });
    assert.deepEqual(anClaude, []);
    assert.equal(existsSync(CHAT), false, "kein Eintrag in der Historie");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(telegram, []);
    assert.equal(auditZeilen("pin_im_chat").length, 1);
    assert.equal(auditZeilen("abuse_signal").length, 1, "zählt wie in Telegram als unbefugter Versuch");
    assert.ok(!readFileSync(AUDIT, "utf8").includes("4711"), "die PIN steht nicht im Audit");
    assert.deepEqual(await verlauf(), []);
  });

  it("eine andere Zahl derselben Art bekommt genau dieselbe Antwort (kein Orakel)", async () => {
    const richtig = await chat("4711");
    const falsch = await chat("123456");
    assert.deepEqual(falsch, richtig);
    assert.deepEqual(anClaude, []);
  });

  it("mit Satzzeichen am Ende («4711.», «4711!», «4711?»): dieselbe Antwort, nichts an Claude, nichts in data/chat.json, gezählt", async () => {
    const richtig = await chat("4711");
    const vorher = auditZeilen("abuse_signal").length;
    for (const t of ["4711.", "4711!", "4711?", "4712. ", "4711 ."]) {
      missbrauchZuruecksetzen(); // fünf in fünf Minuten lösten sonst den Notfall aus (eigener Befund)
      assert.deepEqual(await chat(t), richtig, t);
    }
    assert.notEqual(state.notfall?.aktiv, true);
    assert.deepEqual(anClaude, []);
    assert.equal(existsSync(CHAT), false, "kein Eintrag in der Historie");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(telegram, []);
    assert.equal(auditZeilen("abuse_signal").length - vorher, 5, "jede zählt wie die PIN selbst");
  });

  it("ein Satz mit der PIN geht wie in Telegram an Claude; Verlauf und Telegram-Echo zeigen sie geschwärzt", async () => {
    claudeAntwort = "Die 4711 nenne ich nicht, Sir.";
    const r = await chat("Ist 4711 eine gute PIN?");
    assert.equal(r.statusCode, 200);
    // Auch die rechtzeitige Antwort ohne PIN
    assert.equal(r.body.reply, "Die <PIN> nenne ich nicht, Sir.");
    assert.equal(anClaude.length, 1);
    const n = await verlauf();
    assert.deepEqual(n, [{ rolle: "nutzer", text: "Ist <PIN> eine gute PIN?" }, { rolle: "jarvis", text: "Die <PIN> nenne ich nicht, Sir." }]);

    // Dauert die Antwort länger als die Frist, geht sie mit einem Echo der Frage nach Telegram: ohne PIN
    dashboard._chatFrist.ms = 5;
    claudeVerzoegerung = 40;
    claudeAntwort = "Später, Sir.";
    const spaet = await chat("Bitte prüfen, ob 4711 noch gilt");
    assert.equal(spaet.body.queued, true);
    for (let i = 0; i < 50 && telegram.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(telegram.length, 1);
    assert.match(telegram[0]!, /^Zur Frage aus der Zentrale \(«Bitte prüfen, ob <PIN> noch gilt»\):/);
    assert.ok(!telegram[0]!.includes("4711"));
  });

  it("die rechtzeitige Antwort: wiederholt Claude die PIN, steht in der Kommandozentrale nur der Platzhalter", async () => {
    claudeAntwort = "Die 4711 gilt noch, Sir.";
    const r = await chat("Gilt die Zahl noch?");
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.queued, false);
    assert.equal(r.body.reply, "Die <PIN> gilt noch, Sir.");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(telegram, []);
  });

  it("die späte Antwort nach Telegram: wiederholt Claude die PIN, steht sie dort geschwärzt", async () => {
    dashboard._chatFrist.ms = 5;
    claudeVerzoegerung = 40;
    claudeAntwort = "Ihre PIN 4711 ist notiert, Sir.";
    const r = await chat("Merken Sie sich bitte die Zahl aus meinem Satz 4711");
    assert.equal(r.body.queued, true);
    for (let i = 0; i < 50 && telegram.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(telegram.length, 1);
    assert.match(telegram[0]!, /Ihre PIN <PIN> ist notiert, Sir\.$/);
    assert.ok(!telegram[0]!.includes("4711"), telegram[0]);
  });
});
