import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befund: Der FrageIntent war der einzige Weg zu Claude ohne PIN-Sperre: «Alexa, frag Butler Jarvis 4711» ging an
// Claude und in data/chat.json, ungezählt; die späte Antwort stand samt Frage ungeschwärzt in Telegram (auch der
// Fehlertext). Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-alexa-pin-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_ANREDE = "Sir";
process.env.JARVIS_FORM = "sie";
delete process.env.ALEXA_VOICE;
delete process.env.ALEXA_NACHT;

const telegram: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  if (url.endsWith("/sendMessage") && typeof init?.body === "string") telegram.push(String((JSON.parse(init.body) as { text?: string }).text ?? ""));
  return new Response(JSON.stringify({ ok: true, result: { message_id: telegram.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const { buildSkill, _testOptionen } = await import("../src/alexa.js");
const { state } = await import("../src/state.js");
const { config } = await import("../src/config.js");
const { missbrauchZuruecksetzen } = await import("../src/notfall.js");
const { setzeWarten } = await import("../src/telegram.js");

const CHAT = join(temp, "data", "chat.json");
const AUDIT = join(temp, "data", "audit.log");
const auditZeilen = (ereignis: string) => (existsSync(AUDIT) ? readFileSync(AUDIT, "utf8").split("\n").filter((z) => z.includes(`"event":"${ereignis}"`)) : []);

const client = anthropic();
const origCreate = client.messages.create;
let anClaude = 0;
let claudeAntwort = "Gern, Sir.";
let claudeFehler: Error | undefined;
let claudeVerzoegerung = 0;

const nachricht = (text: string): Anthropic.Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  content: [{ type: "text", text, citations: null }],
} as Anthropic.Message);

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
const warteAufTelegram = async () => { for (let i = 0; i < 100 && telegram.length === 0; i++) await new Promise((r) => setTimeout(r, 10)); };

const budgetVorher = config.alexaBudgetMs;
beforeEach(() => {
  setzeWarten(async () => {}, () => 0.5);
  missbrauchZuruecksetzen();
  _testOptionen.jetzt = () => new Date(2026, 9, 11, 12, 0);
  telegram.length = 0;
  anClaude = 0;
  claudeAntwort = "Gern, Sir.";
  claudeFehler = undefined;
  claudeVerzoegerung = 0;
  client.messages.create = (async () => {
    anClaude++;
    if (claudeVerzoegerung) await new Promise((r) => setTimeout(r, claudeVerzoegerung));
    if (claudeFehler) throw claudeFehler;
    return nachricht(claudeAntwort);
  }) as unknown as typeof client.messages.create;
});
afterEach(() => {
  client.messages.create = origCreate;
  config.alexaBudgetMs = budgetVorher;
  state.paused = false;
  state.notfall = { aktiv: false };
});

describe("Alexa FrageIntent: die PIN geht nie an Claude", () => {
  it("«4711», «4 7 1 1», «4712.»: Hinweis, nichts an Claude, nichts in data/chat.json, nichts nach Telegram; auditiert, nicht gezählt", async () => {
    for (const t of ["4711", "4 7 1 1", "4712."]) {
      missbrauchZuruecksetzen();
      assert.equal(await frage(t), "<speak>Die PIN bitte nie sprechen, Sir. Nichts gesendet.</speak>", t);
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(anClaude, 0);
    assert.equal(existsSync(CHAT), false);
    assert.deepEqual(telegram, []);
    assert.equal(auditZeilen("pin_im_chat").length, 3);
    assert.ok(auditZeilen("pin_im_chat").every((z) => z.includes('"quelle":"alexa"')));
    // Am Echo spricht jeder im Raum: kein Beitrag zum Notfall-Zähler
    assert.equal(auditZeilen("abuse_signal").length, 0);
    assert.ok(!readFileSync(AUDIT, "utf8").includes("4711"));
  });

  it("fünf PIN-förmige Alexa-Fragen hintereinander lösen keinen Notfall aus", async () => {
    // Befund: jeder in Hörweite konnte mit fünf gesprochenen Zahlen Notaus, Werkzeuge aus und «Tokens erneuern» auslösen
    for (const t of ["1234", "4711", "1.2.5.0.", "9 9 9 9", "0000"]) {
      assert.equal(await frage(t), "<speak>Die PIN bitte nie sprechen, Sir. Nichts gesendet.</speak>", t);
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(Boolean(state.notfall?.aktiv), false, "kein Notfall");
    assert.equal(Boolean(state.paused), false, "kein Notaus");
    assert.equal(anClaude, 0);
    assert.deepEqual(telegram, [], "kein Alarm nach Telegram");
  });

  it("die rechtzeitige Antwort ist geschwärzt, bevor Alexa sie vorliest (auch «4*7*1*1»)", async () => {
    // Befund: innerhalb des Budgets ging die Antwort roh über Amazon, nach dem Budget geschwärzt per Telegram.
    // Geschwärzt wird, was der Nutzer selbst in PIN-Form sagte; vorgelesen «PIN» statt «&lt;PIN&gt;»
    claudeAntwort = "Die 4711 gilt noch, Sir. Alt war 4*7*1*1, Schlüssel sk-ant-abcdefghijkl123.";
    const s = await frage("ob die 4711 noch gilt");
    assert.equal(anClaude, 1);
    assert.ok(!/4\D{0,2}7\D{0,2}1\D{0,2}1/.test(s), s);
    assert.ok(!s.includes("abcdefghijkl"), s);
    assert.ok(!s.includes("&lt;PIN&gt;"), s);
    assert.match(s, /^<speak>Die PIN gilt noch, Sir\. Alt war PIN, Schlüssel sk-ant-&lt;schlüssel/);
    assert.deepEqual(telegram, []);
  });

  it("ein Satz mit der PIN geht an Claude; die späte Antwort in Telegram ist samt Echo geschwärzt", async () => {
    config.alexaBudgetMs = 5;
    claudeVerzoegerung = 40;
    claudeAntwort = "Die 4711 gilt noch, Sir.";
    assert.match(await frage("ob die 4711 noch gilt"), /Das Ergebnis kommt per Telegram/);
    await warteAufTelegram();
    assert.equal(anClaude, 1);
    assert.deepEqual(telegram, ["Zu deiner Frage per Alexa («ob die <PIN> noch gilt»):\n\nDie <PIN> gilt noch, Sir."]);
  });

  it("auch der Fehlertext der späten Antwort ist geschwärzt", async () => {
    config.alexaBudgetMs = 5;
    claudeVerzoegerung = 40;
    claudeFehler = new Error("kaputt bei 4 7 1 1");
    await frage("ob die Zahl noch gilt");
    await warteAufTelegram();
    assert.equal(telegram.length, 1);
    assert.ok(!/4\s*7\s*1\s*1/.test(telegram[0]!), telegram[0]);
    assert.match(telegram[0]!, /Das hat nicht geklappt: kaputt bei <PIN>$/);
  });
});
