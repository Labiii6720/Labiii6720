import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Alexa ohne Chat-Verlauf (0.24): Freie Fragen laufen mit leerer Historie, data/chat.json bleibt unberührt. Bei
// ALEXA_FREIGABEN_DETAILS=off erreicht nichts aus Auftrags-Eingaben (Empfänger, Betreff, Text) Claude: weder über den
// Verlauf (tool_use) noch über den Systemprompt (nur Anzahl und Nummern). Ersetzt istFreigabeFrage und
// nenntAuftragsdetails. Attrappe statt Claude, die mitschreibt, was sie bekommt. Temp-Ordner, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-alexa-ohne-verlauf-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_ANREDE = "Sir";
process.env.JARVIS_FORM = "sie";
process.env.WEB_SEARCH = "off";
delete process.env.ALEXA_VOICE;
delete process.env.ALEXA_NACHT;
delete process.env.ALEXA_FREIGABEN_DETAILS;

// Ein Chat-Verlauf mit den Eingaben eines offenen Auftrags (tool_use), vor dem Import geschrieben
const EMPFAENGER = "h.gruetzi@beispielkunde.ch";
const BETREFF = "Angebot Drehkreuz Nordportal";
const MAILTEXT = "Grüezi Herr Grützi, anbei das Angebot fürs Drehkreuz am Nordportal.";
const GEHEIM = /gruetzi|Grützi|beispielkunde|Drehkreuz|Nordportal/i;
mkdirSync("data", { recursive: true, mode: 0o700 });
const CHAT = join(temp, "data", "chat.json");
writeFileSync(CHAT, JSON.stringify([
  { role: "user", content: "Schreib Herrn Grützi wegen des Drehkreuzes" },
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mail_senden", input: { an: EMPFAENGER, betreff: BETREFF, text: MAILTEXT } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Auftrag #1 angelegt (Stufe extern)." }] },
  { role: "assistant", content: [{ type: "text", text: "Die Mail an Herrn Grützi wartet als Nummer 1, Sir." }] },
]), { mode: 0o600 });
const chatVorher = readFileSync(CHAT, "utf8");

const telegram: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  if (url.endsWith("/sendMessage") && typeof init?.body === "string") telegram.push(String((JSON.parse(init.body) as { text?: string }).text ?? ""));
  return new Response(JSON.stringify({ ok: true, result: { message_id: telegram.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const { buildSkill, _testOptionen } = await import("../src/alexa.js");
const { handleMessage, letzteNachrichten } = await import("../src/agent.js");
const { hooks } = await import("../src/telegram.js");
const { config } = await import("../src/config.js");
const { createAuftrag, auftraege, saveAuftraege } = await import("../src/queue.js");
const { state } = await import("../src/state.js");

/** Was die Attrappe bekam: Kopie zur Aufrufzeit (die Historie wächst danach weiter) */
type Aufruf = { system: Anthropic.TextBlockParam[]; tools: unknown[]; messages: Anthropic.MessageParam[]; roh: string };
const client = anthropic();
const origCreate = client.messages.create;
let aufrufe: Aufruf[] = [];
/** Antworten der Reihe nach; die letzte gilt für alle weiteren Aufrufe */
let antworten: Anthropic.ContentBlock[][] = [];
let verzoegerung = 0;

const text = (t: string): Anthropic.ContentBlock[] => [{ type: "text", text: t, citations: null }];

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

let id = 0;
const budgetVorher = config.alexaBudgetMs;
beforeEach(() => {
  _testOptionen.jetzt = () => new Date(2026, 9, 11, 12, 0);
  aufrufe = [];
  telegram.length = 0;
  antworten = [text("Gern, Sir.")];
  verzoegerung = 0;
  auftraege.length = 0;
  saveAuftraege();
  id = createAuftrag({ tool: "mail_senden", input: { an: EMPFAENGER, betreff: BETREFF, text: MAILTEXT }, stufe: "extern", summary: `Mail an ${EMPFAENGER}\nBetreff: ${BETREFF}\n\n${MAILTEXT}` }).id;
  client.messages.create = (async (p: Anthropic.MessageCreateParams) => {
    const roh = JSON.stringify(p);
    const kopie = JSON.parse(roh) as Omit<Aufruf, "roh">;
    aufrufe.push({ ...kopie, roh });
    if (verzoegerung) await new Promise((r) => setTimeout(r, verzoegerung));
    const content = antworten.length > 1 ? antworten.shift()! : antworten[0]!;
    const werkzeug = content.some((b) => b.type === "tool_use");
    return {
      id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: werkzeug ? "tool_use" : "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage, content,
    } as Anthropic.Message;
  }) as unknown as typeof client.messages.create;
});
afterEach(() => {
  client.messages.create = origCreate;
  config.alexaFreigabenDetails = false;
  config.alexaBudgetMs = budgetVorher;
  state.paused = false;
});

describe("Alexa ohne Chat-Verlauf", () => {
  it("Claude bekommt nur die Frage, keine Historie; data/chat.json bleibt unverändert", async () => {
    antworten = [text("Sonnig, 18 Grad, Sir.")];
    assert.equal(await frage("wie wird das Wetter"), "<speak>Sonnig, 18 Grad, Sir.</speak>");
    assert.equal(aufrufe.length, 1);
    assert.deepEqual(aufrufe[0]!.messages, [{ role: "user", content: "wie wird das Wetter" }]);
    assert.equal(readFileSync(CHAT, "utf8"), chatVorher, "Frage und Antwort nicht in data/chat.json");
    assert.ok(!letzteNachrichten(10).some((n) => /Wetter|Sonnig/.test(n.text)), "auch nicht im Verlauf der Zentrale");
  });

  it("ALEXA_FREIGABEN_DETAILS=off: nichts aus den Auftrags-Eingaben erreicht Claude (Systemprompt, Werkzeuge, Historie)", async () => {
    for (const t of ["was wartet auf mich", "ob ich Herrn Grützi schon geantwortet habe", "lies mir die offenen Freigaben vor"]) {
      await frage(t);
    }
    assert.equal(aufrufe.length, 3, "Fragen nach der Warteschlange gehen an Claude (kein Abfangen per Muster mehr)");
    for (const a of aufrufe) {
      const ohneFrage = JSON.stringify({ system: a.system, tools: a.tools, messages: a.messages.slice(1) });
      assert.doesNotMatch(ohneFrage, GEHEIM);
      assert.ok(!ohneFrage.includes("mail_senden"), "kein Werkzeugname eines offenen Auftrags");
      assert.equal(a.messages.length, 1);
      const variabel = a.system[1]!.text;
      assert.match(variabel, new RegExp(`Offene Aufträge: 1 \\(#${id}\\)\\.`));
      assert.match(variabel, /Kanal: Alexa/);
    }
    assert.equal(readFileSync(CHAT, "utf8"), chatVorher);
  });

  it("ALEXA_FREIGABEN_DETAILS=on: Werkzeug und Nummer im Prompt wie im Chat, Historie trotzdem leer, Antwort unverändert", async () => {
    config.alexaFreigabenDetails = true;
    antworten = [text("Nummer 1, die Mail an Herrn Grützi, wartet, Sir.")];
    const s = await frage("was wartet auf mich");
    assert.match(aufrufe[0]!.system[1]!.text, new RegExp(`Offene Aufträge: #${id} mail_senden\\.`));
    assert.doesNotMatch(aufrufe[0]!.system[1]!.text, /Kanal: Alexa/);
    assert.equal(aufrufe[0]!.messages.length, 1);
    assert.equal(s, "<speak>Nummer 1, die Mail an Herrn Grützi, wartet, Sir.</speak>");
  });

  it("Prompt-Caching: fester Systemprompt-Teil und Werkzeuge gleich wie im Chat, mit cache_control", async () => {
    await frage("wie wird das Wetter");
    await handleMessage("wie wird das Wetter", hooks);
    assert.equal(aufrufe.length, 2);
    const [alexa, chat] = aufrufe as [Aufruf, Aufruf];
    assert.deepEqual(alexa.system[0], chat.system[0]);
    assert.deepEqual(alexa.system[0]!.cache_control, { type: "ephemeral" });
    assert.deepEqual(alexa.tools, chat.tools);
    // Gegenprobe: der Chat-Zug trägt den Verlauf mit, die Alexa-Frage fehlt darin
    assert.ok(chat.messages.length > 1);
    assert.match(chat.roh, /Drehkreuz/);
    assert.equal(chat.messages.filter((m) => m.content === "wie wird das Wetter").length, 1, "nur die eigene Frage des Chat-Zugs");
    // Der Chat-Zug speichert wie bisher, ohne die Alexa-Frage
    const gespeichert = JSON.parse(readFileSync(CHAT, "utf8")) as Anthropic.MessageParam[];
    assert.equal(gespeichert.length, JSON.parse(chatVorher).length + 2);
    writeFileSync(CHAT, chatVorher, { mode: 0o600 });
  });

  it("Werkzeug mit Nebenwirkung: landet in der Freigabe-Warteschlange, nichts in data/chat.json", async () => {
    antworten = [
      [{ type: "tool_use", id: "toolu_a", name: "kalender_termin_erstellen", input: { titel: "Zahnarzt", start: "2026-10-27T09:00:00+01:00", ende: "2026-10-27T10:00:00+01:00" } } as Anthropic.ContentBlock],
      text("Der Termin wartet auf Ihre Freigabe, Sir."),
    ];
    const vorher = auftraege.length;
    const s = await frage("trag mir den Zahnarzt am 27. um neun ein");
    assert.equal(s, "<speak>Der Termin wartet auf Ihre Freigabe, Sir.</speak>");
    assert.equal(auftraege.length, vorher + 1);
    const neu = auftraege.at(-1)!;
    assert.equal(neu.tool, "kalender_termin_erstellen");
    assert.equal(neu.stufe, "extern");
    assert.equal(neu.status, "offen");
    assert.ok(telegram.some((t) => t.includes("Zahnarzt")), "Freigabe-Nachricht in Telegram");
    // Der zweite Aufruf trägt nur den eigenen Zug (Frage, tool_use, tool_result)
    assert.equal(aufrufe.length, 2);
    assert.equal(aufrufe[1]!.messages.length, 3);
    assert.doesNotMatch(aufrufe[1]!.roh, GEHEIM);
    assert.equal(readFileSync(CHAT, "utf8"), chatVorher);
  });

  it("späte Antwort: kommt per Telegram samt Echo, data/chat.json bleibt unverändert", async () => {
    config.alexaBudgetMs = 5;
    verzoegerung = 40;
    antworten = [text("Bestellung 1042 ist unterwegs, Sir.")];
    assert.match(await frage("wo ist Bestellung 1042"), /Das Ergebnis kommt per Telegram/);
    for (let i = 0; i < 100 && telegram.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(telegram, ["Zu deiner Frage per Alexa («wo ist Bestellung 1042»):\n\nBestellung 1042 ist unterwegs, Sir."]);
    assert.equal(aufrufe[0]!.messages.length, 1);
    assert.equal(readFileSync(CHAT, "utf8"), chatVorher);
  });

  it("Freigabe-Wunsch geht weiter nicht an Claude; im Notaus kein Claude-Aufruf", async () => {
    const s = await frage(`gib auftrag ${id} frei`);
    assert.match(s, /^<speak>Freigaben nehme ich nur per Telegram/);
    assert.ok(!GEHEIM.test(s), s);
    state.paused = true;
    assert.match(await frage("was wartet auf mich"), /pausiert \(Notaus\)/);
    assert.equal(aufrufe.length, 0);
    assert.equal(auftraege.find((a) => a.id === id)!.status, "offen");
  });
});
