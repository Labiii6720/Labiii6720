import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befund: nenntAuftragsdetails prüfte nur den Werkzeugnamen. Nannte Claude aus dem Verlauf (tool_use mit vollem input)
// Empfänger und Betreff eines offenen Auftrags ohne Werkzeugnamen («Die Antwort an Herrn Müller zur Offerte
// Zutrittskontrolle Basel liegt als Nummer 12 bereit»), ging das bei ALEXA_FREIGABEN_DETAILS=off über Amazon in den Raum.
// Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-alexa-freigaben-merkmale-"));
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

globalThis.fetch = (async (eingabe: string | URL | Request) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const { buildSkill, _testOptionen } = await import("../src/alexa.js");
const { config } = await import("../src/config.js");
const { createAuftrag, auftraege, saveAuftraege } = await import("../src/queue.js");
const { state } = await import("../src/state.js");

const client = anthropic();
const origCreate = client.messages.create;
let claudeAntwort = "Gern, Sir.";

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

const ERSETZT = /Einzelheiten zu offenen Aufträgen nenne ich hier nicht/;
let mail = 0;
beforeEach(() => {
  _testOptionen.jetzt = () => new Date(2026, 9, 11, 12, 0);
  claudeAntwort = "Gern, Sir.";
  auftraege.length = 0;
  saveAuftraege();
  mail = createAuftrag({
    tool: "mail_senden",
    input: { an: "m.mueller@kunde.ch", betreff: "Offerte Zutrittskontrolle Basel", text: "Sehr geehrter Herr Müller, anbei unsere Offerte für die Zutrittskontrolle am Standort Basel. Freundliche Grüsse" },
    stufe: "extern",
    summary: "Mail an m.mueller@kunde.ch: Offerte Zutrittskontrolle Basel",
  }).id;
  createAuftrag({ tool: "kalender_termin_erstellen", input: { titel: "Service Videoanlage Rheinfelden", start: "2026-10-27T09:00:00+01:00", ort: "Kraftwerkstrasse 4" }, stufe: "extern", summary: "Termin" });
  createAuftrag({ tool: "geraet_schalten", input: { entity_id: "lock.haustuer_vorne", dienst: "unlock" }, stufe: "sensibel", summary: "Schloss" });
  client.messages.create = (async () => ({
    id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
    content: [{ type: "text", text: claudeAntwort, citations: null }],
  }) as Anthropic.Message) as unknown as typeof client.messages.create;
});
afterEach(() => {
  client.messages.create = origCreate;
  config.alexaFreigabenDetails = false;
  state.paused = false;
});

describe("Alexa ohne Freigaben-Einzelheiten: auch Empfänger, Betreff, Titel und Geräte ohne Werkzeugnamen", () => {
  it("Empfänger und Betreff ohne Werkzeugnamen: Alexa liest nur den Stand vor", async () => {
    claudeAntwort = `Die Antwort an Herrn Müller zur Offerte Zutrittskontrolle Basel liegt als Nummer ${mail} zur Freigabe bereit.`;
    const s = await frage("ob ich Müller schon geantwortet habe");
    assert.match(s, ERSETZT);
    assert.ok(!/Müller|Offerte|Zutrittskontrolle/i.test(s), s);
    assert.match(s, new RegExp(`Nummer ${mail}`));
  });

  it("jedes Merkmal für sich: Name aus der Adresse, Adresse, Domain, Betreff, Titel, Gerät", async () => {
    for (const antwort of [
      "Herr Mueller wartet noch auf Ihre Antwort.",
      "An m.mueller@kunde.ch ist etwas vorbereitet.",
      "Für kunde.ch liegt etwas bereit.",
      "Die Offerte zur Zutrittskontrolle Basel ist bereit.",
      "Der Service Videoanlage in Rheinfelden steht an.",
      "Die Haustür vorne wartet auf Ihr OK.",
    ]) {
      claudeAntwort = antwort;
      assert.match(await frage("was ist mit dem Kunden los"), ERSETZT, antwort);
    }
  });

  it("gewöhnliche Antworten bleiben, auch mit einzelnen Wörtern daraus (Basel, Service, Zutrittskontrolle)", async () => {
    for (const antwort of ["Morgen wird es in Basel sonnig, 18 Grad.", "Der Service ist bis 17 Uhr erreichbar.", "Zutrittskontrolle ist Ihr Fachgebiet, Sir.", "Freundliche Grüsse ausrichten? Gern, Sir."]) {
      claudeAntwort = antwort;
      const s = await frage("wie wird das Wetter");
      assert.doesNotMatch(s, ERSETZT, antwort);
      assert.ok(s.includes(antwort.slice(0, 12)), s);
    }
  });

  it("mit ALEXA_FREIGABEN_DETAILS=on unverändert", async () => {
    config.alexaFreigabenDetails = true;
    claudeAntwort = "Die Antwort an Herrn Müller zur Offerte Zutrittskontrolle Basel wartet.";
    const s = await frage("ob ich Müller schon geantwortet habe");
    assert.doesNotMatch(s, ERSETZT);
    assert.match(s, /Offerte Zutrittskontrolle Basel/);
  });
});
