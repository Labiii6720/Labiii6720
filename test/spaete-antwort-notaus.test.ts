import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Request, Response } from "express";

// Befund: Die späte Antwort (askWithBudget: Kommandozentrale, /events frage_sync, Alexa; dazu das Ereignis «frage»)
// ging trotz Notaus/Notfall nach Telegram, samt Echo der Frage, und lief in den Wiederholungen weiter, wenn der Notaus
// erst während des Versands kam. Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-spaete-antwort-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const TOKEN = "spaete-antwort-token-nur-attrappe-0123456789";
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = TOKEN;
process.env.JARVIS_ANREDE = "Sir";
process.env.JARVIS_FORM = "sie";

/** Zugestellte Texte (sendMessage ok) und alle Versuche */
const telegram: string[] = [];
let versuche = 0;
/** So viele sendMessage-Versuche scheitern zuerst mit 502 */
let fehlschlaege = 0;
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  if (url.endsWith("/sendMessage") && typeof init?.body === "string") {
    versuche++;
    if (fehlschlaege > 0) {
      fehlschlaege--;
      return new Response(JSON.stringify({ ok: false, error_code: 502, description: "Bad Gateway" }), { status: 502, headers: { "content-type": "application/json" } });
    }
    telegram.push(String((JSON.parse(init.body) as { text?: string }).text ?? ""));
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: telegram.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const dashboard = await import("../src/dashboard.js");
const { handleEvent } = await import("../src/events.js");
const { buildSkill } = await import("../src/alexa.js");
const { state } = await import("../src/state.js");
const { config } = await import("../src/config.js");
const { missbrauchZuruecksetzen } = await import("../src/notfall.js");
const { postausgangTick, setzeWarten } = await import("../src/telegram.js");

const client = anthropic();
const origCreate = client.messages.create;
let claudeAntwort = "Ihr Kontostand beträgt 12 345 Franken, Sir.";
let claudeFehler: Error | undefined;
/** Claude antwortet erst, wenn der Test freigibt */
let freigeben: (() => void) | undefined;

const nachricht = (text: string): Anthropic.Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  content: [{ type: "text", text, citations: null }],
} as Anthropic.Message);

const kurz = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function claudeLaeuft(): Promise<void> {
  for (let i = 0; i < 2000 && !freigeben; i++) await kurz(2);
  assert.ok(freigeben, "Claude wurde nicht aufgerufen");
}
function antworten(): void {
  const f = freigeben!;
  freigeben = undefined;
  f();
}
const ruhe = async () => { for (let i = 0; i < 10; i++) { await kurz(5); await new Promise((r) => setImmediate(r)); } };
const notfall = () => {
  state.paused = true;
  state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
};

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
async function chat(text: string): Promise<any> {
  const res = antwort();
  await dashboard.chat({ body: { text } } as never, res as never);
  return res.body;
}
function verlauf(): { rolle: string; text: string }[] {
  const res = antwort();
  dashboard.chatVerlauf({} as never, res as never);
  return res.body.nachrichten;
}
/** POST /events; `lauf` endet erst, wenn auch die Antwort per Telegram durch ist («frage»). */
function ereignisStarten(body: unknown): { res: ReturnType<typeof antwort>; lauf: Promise<void> } {
  const req = { body, ip: "192.168.1.20", header: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${TOKEN}` : undefined) } as unknown as Request;
  const res = antwort();
  return { res, lauf: handleEvent(req, res as unknown as Response) };
}

/** Die Frist (setTimeout.unref) hielte die Ereignisschleife nicht offen, solange Claude wartet */
let halt: ReturnType<typeof setInterval> | undefined;
beforeEach(() => {
  halt = setInterval(() => {}, 1000);
  setzeWarten(async () => {}, () => 0.5);
  missbrauchZuruecksetzen();
  telegram.length = 0;
  versuche = 0;
  fehlschlaege = 0;
  claudeAntwort = "Ihr Kontostand beträgt 12 345 Franken, Sir.";
  claudeFehler = undefined;
  dashboard._chatFrist.ms = 5;
  client.messages.create = (async () => {
    await new Promise<void>((r) => { freigeben = r; });
    if (claudeFehler) throw claudeFehler;
    return nachricht(claudeAntwort);
  }) as unknown as typeof client.messages.create;
});
afterEach(async () => {
  if (freigeben) antworten();
  await ruhe();
  client.messages.create = origCreate;
  dashboard._chatFrist.ms = 60_000;
  state.paused = false;
  state.notfall = { aktiv: false };
  clearInterval(halt);
});

describe("Späte Antwort: im Notaus oder Notfall nichts nach Telegram", () => {
  it("Gegenprobe: ohne Notaus kommt die späte Antwort der Kommandozentrale per Telegram", async () => {
    const r = await chat("Wie steht das Konto?");
    assert.equal(r.queued, true);
    await claudeLaeuft();
    antworten();
    for (let i = 0; i < 100 && telegram.length === 0; i++) await kurz();
    assert.equal(telegram.length, 1);
    assert.match(telegram[0]!, /^Zur Frage aus der Zentrale \(«Wie steht das Konto\?»\):\n\nIhr Kontostand/);
  });

  it("Kommandozentrale: Notfall während der Antwort – weder Echo noch Pausenhinweis noch Antwort", async () => {
    const r = await chat("Wie steht das geheime Konto?");
    assert.equal(r.queued, true);
    await claudeLaeuft();
    notfall();
    antworten();
    await ruhe();
    assert.deepEqual(telegram, []);
    assert.equal(versuche, 0);
  });

  it("Kommandozentrale: Fehler von Claude im Notfall – auch kein «Das hat nicht geklappt»", async () => {
    claudeFehler = new Error("kaputt");
    const r = await chat("Wie steht das geheime Konto?");
    assert.equal(r.queued, true);
    await claudeLaeuft();
    notfall();
    antworten();
    await ruhe();
    assert.deepEqual(telegram, []);
  });

  it("Notaus während der Wiederholungen des Versands: Rest bleibt zurück, nicht im Postausgang, nicht im Verlauf", async () => {
    fehlschlaege = 1;
    claudeAntwort = "Geheimer Saldo: 999 Franken, Sir.";
    // Der Notaus kommt in der Wartezeit vor dem zweiten Versuch
    setzeWarten(async () => { state.paused = true; }, () => 0.5);
    const r = await chat("Wie steht das geheime Konto?");
    assert.equal(r.queued, true);
    await claudeLaeuft();
    antworten();
    for (let i = 0; i < 100 && versuche === 0; i++) await kurz();
    await ruhe();
    assert.equal(state.paused, true);
    assert.equal(versuche, 1, "kein weiterer Versuch nach dem Notaus");
    assert.deepEqual(telegram, []);
    const pa = join(temp, "data", "postausgang.json");
    assert.ok(!existsSync(pa) || !readFileSync(pa, "utf8").includes("Saldo"), "nicht im Postausgang");
    // Nach /weiter: die zurückgehaltene Antwort erscheint nicht im Verlauf
    state.paused = false;
    await postausgangTick();
    assert.deepEqual(telegram, []);
    assert.ok(!verlauf().some((n) => n.text.includes("Saldo")), JSON.stringify(verlauf()));
  });

  it("Ereignis «frage»: Notaus während der Antwort – kein Pausenhinweis, keine Antwort", async () => {
    const { res, lauf } = ereignisStarten({ event: "frage", text: "Wie steht das geheime Konto?" });
    await claudeLaeuft();
    assert.equal(res.body.queued, true);
    state.paused = true;
    antworten();
    await lauf;
    await ruhe();
    assert.deepEqual(telegram, []);
  });

  it("frage_sync: Notfall während der späten Antwort – weder Echo noch Antwort", async () => {
    const { res, lauf } = ereignisStarten({ event: "frage_sync", text: "Wie steht das geheime Konto?", budget: 1 });
    await claudeLaeuft();
    await lauf; // Budget mindestens 3 s
    assert.equal(res.body.queued, true);
    notfall();
    antworten();
    await ruhe();
    assert.deepEqual(telegram, []);
  });

  it("Alexa: Notfall während der späten Antwort – die Frage geht nicht als Echo hinaus", async () => {
    const SKILL = "amzn1.ask.skill.00000000-0000-0000-0000-000000000000";
    const vorher = config.alexaBudgetMs;
    config.alexaBudgetMs = 5;
    try {
      const env = {
        version: "1.0",
        session: { new: true, sessionId: "s", application: { applicationId: SKILL }, user: { userId: "u" } },
        context: { System: { application: { applicationId: SKILL }, user: { userId: "u" }, device: { deviceId: "d", supportedInterfaces: {} }, apiEndpoint: "https://api.eu.amazonalexa.com" } },
        request: { type: "IntentRequest", requestId: "r", timestamp: "2026-10-11T06:00:00Z", locale: "de-DE", intent: { name: "FrageIntent", confirmationStatus: "NONE", slots: { frage: { name: "frage", value: "wie steht das geheime konto" } } } },
      };
      const a = (await buildSkill(SKILL).invoke(env as never)) as { response: { outputSpeech?: { ssml: string } } };
      assert.match(a.response.outputSpeech?.ssml ?? "", /Das Ergebnis kommt per Telegram/);
      await claudeLaeuft();
      notfall();
      antworten();
      await ruhe();
      assert.deepEqual(telegram, []);
    } finally {
      config.alexaBudgetMs = vorher;
    }
  });
});
