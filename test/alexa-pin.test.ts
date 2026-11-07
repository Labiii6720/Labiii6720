import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Alexa FrageIntent: was nach der PIN aussieht (pinEingabe), geht weder an Claude noch in data/chat.json oder nach
// Telegram; Alexa spricht den einen Satz, nie die Eingabe; nie gezählt. Temp-Ordner, Attrappen, kein Netz.
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

const PIN_SSML = "<speak>Das sieht aus wie eine PIN, Sir. Ich schicke es nicht weiter.</speak>";

describe("Alexa FrageIntent: PIN-förmige Fragen gehen nie an Claude", () => {
  it("«4711», «4712», «4 7 1 1», «4712.», «meine PIN ist 4711»: derselbe Satz, nichts an Claude, nichts in data/chat.json, nichts nach Telegram; nicht gezählt", async () => {
    const eingaben = ["4711", "4712", "4 7 1 1", "4712.", "meine PIN ist 4711"];
    for (const t of eingaben) assert.equal(await frage(t), PIN_SSML, t);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(anClaude, 0);
    assert.equal(existsSync(CHAT), false);
    assert.deepEqual(telegram, []);
    assert.equal(auditZeilen("pin_eingabe").length, eingaben.length);
    assert.ok(auditZeilen("pin_eingabe").every((z) => z.includes('"kanal":"alexa"')));
    assert.equal(auditZeilen("abuse_signal").length, 0);
    assert.ok(!readFileSync(AUDIT, "utf8").includes("4711"));
  });

  it("fünf PIN-förmige Alexa-Fragen hintereinander lösen keinen Notfall aus", async () => {
    for (const t of ["1234", "4711", "9 9 9 9", "0000", "47-11"]) assert.equal(await frage(t), PIN_SSML, t);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(Boolean(state.notfall?.aktiv), false, "kein Notfall");
    assert.equal(Boolean(state.paused), false, "kein Notaus");
    assert.equal(anClaude, 0);
    assert.deepEqual(telegram, [], "kein Alarm nach Telegram");
  });

  it("Fehltreffer gehen an Claude: Uhrzeit, Betrag, Datum, Telefonnummer, Satz ohne PIN-Wort", async () => {
    for (const t of ["14.30", "12.50", "25.10.2026", "079 123 45 67", "Termin um 1430 mit Müller"]) assert.notEqual(await frage(t), PIN_SSML, t);
    assert.equal(anClaude, 5);
  });

  it("die rechtzeitige Antwort: Zahlen bleiben lesbar, Schlüssel geschwärzt", async () => {
    claudeAntwort = "Die Postleitzahl von Basel ist 4051, Sir. Schlüssel sk-ant-abcdefghijkl123.";
    const s = await frage("welche Postleitzahl hat Basel");
    assert.equal(anClaude, 1);
    assert.ok(!s.includes("abcdefghijkl"), s);
    assert.match(s, /^<speak>Die Postleitzahl von Basel ist 4051, Sir\. Schlüssel sk-ant-&lt;schlüssel/);
    assert.deepEqual(telegram, []);
  });

  it("die späte Antwort in Telegram samt Echo, der Fehlertext ohne Zugangsdaten", async () => {
    config.alexaBudgetMs = 5;
    claudeVerzoegerung = 40;
    claudeAntwort = "Bestellung 1042 ist unterwegs, Sir.";
    assert.match(await frage("wo ist Bestellung 1042"), /Das Ergebnis kommt per Telegram/);
    await warteAufTelegram();
    assert.deepEqual(telegram, ["Zu deiner Frage per Alexa («wo ist Bestellung 1042»):\n\nBestellung 1042 ist unterwegs, Sir."]);

    telegram.length = 0;
    claudeFehler = new Error("kaputt mit Bearer abcdefghijklmnop123");
    await frage("ob die Zahl noch gilt");
    await warteAufTelegram();
    assert.equal(telegram.length, 1);
    assert.match(telegram[0]!, /Das hat nicht geklappt: kaputt mit Bearer <token>$/);
  });
});
