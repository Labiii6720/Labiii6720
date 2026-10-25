import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befund: antwortGeschwaerzt schwärzte nur Ziffern, die der Nutzer in der aktuellen Historie schrieb, oder die gleich
// hinter dem ganzen Wort «PIN»/«Code» standen. Kannte Claude die PIN aus den Notizen (notiz_speichern), dem Profil oder
// einer inzwischen geleerten Historie (/neu während einer langen Antwort), ging sie ungeschwärzt hinaus: über Alexa in
// den Raum, nach Telegram, in die Kommandozentrale. Ebenso «Der Garagencode lautet 4711» und «PIN: Mai 4711».
// Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-pin-gedaechtnis-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_ANREDE = "Sir";
process.env.JARVIS_FORM = "sie";
process.env.WEB_SEARCH = "off";
delete process.env.ALEXA_VOICE;
delete process.env.ALEXA_NACHT;
delete process.env.ALEXA_FREIGABEN_DETAILS;

const telegram: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  if (url.endsWith("/sendMessage") && typeof init?.body === "string") telegram.push(String((JSON.parse(init.body) as { text?: string }).text ?? ""));
  return new Response(JSON.stringify({ ok: true, result: { message_id: telegram.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const agent = await import("../src/agent.js");
const { profil } = await import("../src/profil.js");
const { anthropic } = await import("../src/claude.js");
const dashboard = await import("../src/dashboard.js");
const { buildSkill, _testOptionen } = await import("../src/alexa.js");
const { setzeWarten } = await import("../src/telegram.js");
const { state } = await import("../src/state.js");

const NOTIZEN = "data/notizen.md";
const notizen = (inhalt: string) => {
  mkdirSync("data", { recursive: true });
  writeFileSync(NOTIZEN, inhalt);
};

const client = anthropic();
const origCreate = client.messages.create;
let claudeAntwort = "Gern, Sir.";
/** Gesetzt: Claude antwortet erst, wenn der Test freigibt */
let warten = false;
let freigeben: (() => void) | undefined;
const kurz = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const SKILL = "amzn1.ask.skill.00000000-0000-0000-0000-000000000000";
const skill = buildSkill(SKILL);
async function alexaFrage(wert: string): Promise<string> {
  const env = {
    version: "1.0",
    session: { new: true, sessionId: "s", application: { applicationId: SKILL }, user: { userId: "u" } },
    context: { System: { application: { applicationId: SKILL }, user: { userId: "u" }, device: { deviceId: "d", supportedInterfaces: {} }, apiEndpoint: "https://api.eu.amazonalexa.com" } },
    request: { type: "IntentRequest", requestId: "r", timestamp: "2026-10-11T06:00:00Z", locale: "de-DE", intent: { name: "FrageIntent", confirmationStatus: "NONE", slots: { frage: { name: "frage", value: wert } } } },
  };
  const a = (await skill.invoke(env as never)) as { response: { outputSpeech?: { ssml: string } } };
  return a.response.outputSpeech?.ssml ?? "";
}

let halt: ReturnType<typeof setInterval> | undefined;
beforeEach(() => {
  halt = setInterval(() => {}, 1000);
  setzeWarten(async () => {}, () => 0.5);
  _testOptionen.jetzt = () => new Date(2026, 9, 11, 12, 0);
  telegram.length = 0;
  claudeAntwort = "Gern, Sir.";
  warten = false;
  rmSync(NOTIZEN, { force: true });
  agent.resetHistory();
  client.messages.create = (async () => {
    if (warten) await new Promise<void>((r) => { freigeben = r; });
    return {
      id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
      content: [{ type: "text", text: claudeAntwort, citations: null }],
    } as Anthropic.Message;
  }) as unknown as typeof client.messages.create;
});
afterEach(async () => {
  if (freigeben) { const f = freigeben; freigeben = undefined; f(); }
  for (let i = 0; i < 10; i++) await kurz();
  client.messages.create = origCreate;
  dashboard._chatFrist.ms = 60_000;
  profil.fakten.length = 0;
  state.paused = false;
  clearInterval(halt);
});

describe("Antworten von Claude: die PIN auch aus Notizen, Profil und geleerter Historie geschwärzt", () => {
  it("Notizen (notiz_speichern): leere Historie, die Zahl aus data/notizen.md erscheint geschwärzt", () => {
    const antwort = "In Ihren Notizen steht: Garagentor 4711, Sir.";
    assert.equal(agent.antwortGeschwaerzt(antwort, "<PIN>", []), antwort, "Gegenprobe ohne Notizen");
    notizen("- 2026-10-20: Garagentor-Code 4711\n");
    assert.equal(agent.antwortGeschwaerzt(antwort, "<PIN>", []), "In Ihren Notizen steht: Garagentor <PIN>, Sir.");
    // Zahlen, die nicht vom Nutzer stammen, bleiben lesbar
    assert.equal(agent.antwortGeschwaerzt("Bestellung 1042 kommt am Montag.", "<PIN>", []), "Bestellung 1042 kommt am Montag.");
  });

  it("Ergebnis von notizen_lesen in der Historie zählt, das eines anderen Werkzeugs nicht", () => {
    const verlauf = [
      { role: "user", content: "Was steht in meinen Notizen?" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "notizen_lesen", input: {} }, { type: "tool_use", id: "t2", name: "shopify_bestellungen", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "- 2026-10-20: Garagentor-Code 4711" }, { type: "tool_result", tool_use_id: "t2", content: "Bestellung 1042" }] },
    ];
    assert.equal(agent.antwortGeschwaerzt("Garagentor 4711, Bestellung 1042.", "<PIN>", verlauf), "Garagentor <PIN>, Bestellung 1042.");
  });

  it("Profil-Fakten zählen wie Eingaben des Nutzers", () => {
    profil.fakten.push({ id: 1, text: "Garagentor öffnet mit Code 4711", seit: "2026-10-20", quelle: "chat" });
    assert.equal(agent.antwortGeschwaerzt("Ihr Garagentor öffnet mit 4711.", "<PIN>", []), "Ihr Garagentor öffnet mit <PIN>.");
  });

  it("PIN-Wort auch zusammengesetzt, mit Wörtern dazwischen und vor einem Monat", () => {
    for (const [ein, aus] of [
      ["Der Code der Alarmanlage ist 4711, Sir.", "Der Code der Alarmanlage ist <PIN>, Sir."],
      ["Der Garagencode lautet 4711.", "Der Garagencode lautet <PIN>."],
      ["PIN: Mai 4711", "PIN: Mai <PIN>"],
      ["Die Alarm-PIN ist 4711.", "Die Alarm-PIN ist <PIN>."],
    ]) {
      assert.equal(agent.antwortGeschwaerzt(ein!, "<PIN>", []), aus, ein);
    }
    // Gegenprobe: Beträge, Jahre und Nummern ohne PIN-Wort bleiben
    for (const t of ["Die Rechnung vom Mai 2026 beträgt CHF 1042.", "Ihr Auftrag 1042 ist unterwegs.", "Die Anzahl beträgt 1042.", "Der Pinguin wiegt 1042 Gramm."]) {
      assert.equal(agent.antwortGeschwaerzt(t, "<PIN>", []), t, t);
    }
  });

  it("zugVerlauf: ein /neu zwischen Frage und Antwort leert nicht, wogegen geschwärzt wird", () => {
    const verlauf = agent.zugVerlauf("Merk dir bitte: Garagentor 4711");
    agent.resetHistory();
    assert.equal(agent.antwortGeschwaerzt("Notiert, Sir: Garagentor 4711.", "<PIN>"), "Notiert, Sir: Garagentor 4711.", "Gegenprobe: Historie leer");
    assert.equal(agent.antwortGeschwaerzt("Notiert, Sir: Garagentor 4711.", "<PIN>", verlauf()), "Notiert, Sir: Garagentor <PIN>.");
  });

  it("Kommandozentrale: /neu während der Antwort, die späte Antwort per Telegram bleibt geschwärzt", async () => {
    warten = true;
    dashboard._chatFrist.ms = 5;
    claudeAntwort = "Notiert, Sir: Garagentor 4711.";
    const res = { body: undefined as any, statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    await dashboard.chat({ body: { text: "Merk dir bitte: Garagentor 4711" } } as never, res as never);
    assert.equal(res.body.queued, true);
    for (let i = 0; i < 2000 && !freigeben; i++) await kurz(2);
    assert.ok(freigeben, "Claude wurde nicht aufgerufen");
    agent.resetHistory(); // /neu aus Telegram, während Claude noch arbeitet
    const f = freigeben!;
    freigeben = undefined;
    f();
    for (let i = 0; i < 200 && telegram.length === 0; i++) await kurz();
    assert.equal(telegram.length, 1);
    assert.ok(!telegram[0]!.includes("4711"), telegram[0]);
    assert.match(telegram[0]!, /Garagentor <PIN>\.$/);
  });

  it("Alexa: Notizen vorgelesen, leere Historie – im Raum nur «PIN», nicht die Zahl", async () => {
    notizen("- 2026-10-20: Garagentor-Code 4711\n");
    claudeAntwort = "In Ihren Notizen steht Garagentor 4711, Sir.";
    const s = await alexaFrage("was steht in meinen Notizen");
    assert.ok(!s.includes("4711"), s);
    assert.match(s, /Garagentor PIN/);
  });
});
