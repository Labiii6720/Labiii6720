import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befund: Fragen nach der Warteschlange, die istFreigabeFrage nicht erkannte, gingen an Claude. Dessen variabler
// Systemprompt nannte «Offene Aufträge: #12 mail_senden», die Antwort ging über Amazon – ALEXA_FREIGABEN_DETAILS=off
// liess sich so umgehen. Jetzt: Kanalnotiz mit nur Anzahl und Nummern, Antwort mit Werkzeugname wird ersetzt.
// Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-alexa-freigaben-kanal-"));
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
const { buildSkill, istFreigabeFrage, _testOptionen } = await import("../src/alexa.js");
const { config } = await import("../src/config.js");
const { createAuftrag, auftraege, saveAuftraege } = await import("../src/queue.js");
const { state } = await import("../src/state.js");

const client = anthropic();
const origCreate = client.messages.create;
let claudeAntwort = "Gern, Sir.";
let systeme: string[] = [];

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
beforeEach(() => {
  _testOptionen.jetzt = () => new Date(2026, 9, 11, 12, 0);
  systeme = [];
  claudeAntwort = "Gern, Sir.";
  auftraege.length = 0;
  saveAuftraege();
  id = createAuftrag({ tool: "mail_senden", input: { an: "mueller@example.ch" }, stufe: "extern", summary: "Mail an Müller AG: Offerte" }).id;
  client.messages.create = (async (p: Anthropic.MessageCreateParams) => {
    systeme.push((p.system as Anthropic.TextBlockParam[]).map((b) => b.text).join("\n"));
    return {
      id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
      content: [{ type: "text", text: claudeAntwort, citations: null }],
    } as Anthropic.Message;
  }) as unknown as typeof client.messages.create;
});
afterEach(() => {
  client.messages.create = origCreate;
  config.alexaFreigabenDetails = false;
  state.paused = false;
});

describe("Alexa ohne Freigaben-Einzelheiten: Claude sieht nur Nummern, die Antwort wird geprüft", () => {
  it("Frage zu einem Dritten geht an Claude, der variable Promptteil nennt nur Anzahl und Nummer samt Kanalnotiz", async () => {
    await frage("ist der Auftrag für Müller noch offen");
    assert.equal(systeme.length, 1);
    const [fest, variabel] = [systeme[0]!.split("\n").slice(0, -2).join("\n"), systeme[0]!.split("\n").slice(-2).join("\n")];
    assert.ok(!variabel.includes("mail_senden"), variabel);
    assert.match(variabel, new RegExp(`Offene Aufträge: 1 \\(#${id}\\)\\.`));
    assert.match(variabel, /Kanal: Alexa/);
    assert.ok(fest.length > 0);
  });

  it("nennt Claude trotzdem das Werkzeug, liest Alexa nur den Stand vor", async () => {
    claudeAntwort = `Ja, Nummer ${id}, mail_senden an mueller@example.ch mit der Offerte, wartet.`;
    const s = await frage("ist der Auftrag für Müller noch offen");
    assert.ok(!/mail|mueller|Offerte/i.test(s), s);
    assert.match(s, /Einzelheiten zu offenen Aufträgen nenne ich hier nicht/);
    assert.match(s, new RegExp(`Nummer ${id}`));
  });

  it("mit ALEXA_FREIGABEN_DETAILS=on bleibt alles wie bisher (Werkzeug im Prompt, Antwort unverändert)", async () => {
    config.alexaFreigabenDetails = true;
    claudeAntwort = "Ja, die Mail an Müller wartet (mail_senden).";
    const s = await frage("ist der Auftrag für Müller noch offen");
    assert.match(systeme[0]!, new RegExp(`Offene Aufträge: #${id} mail_senden\\.`));
    assert.match(s, /mail.senden/);
  });

  it("gewöhnliche Fragen bleiben unberührt", async () => {
    claudeAntwort = "Sonnig, 18 Grad, Sir.";
    assert.equal(await frage("wie wird das Wetter"), "<speak>Sonnig, 18 Grad, Sir.</speak>");
  });
});

// Befund: istFreigabeFrage griff zu breit (blosses «Freigabe» oder «Warteschlange», «wartet … auf uns», «soll ich …
// zustimmen», «Zustimmung»): gewöhnliche Fragen und Berater-Fragen bekamen nur «Nichts wartet auf Sie» statt Claude.
const KEINE_FREIGABE_FRAGEN = [
  "Wie lang ist die Warteschlange am Zoll in Basel", "Braucht es für den Umbau die Zustimmung der Gemeinde",
  "Sollte ich dem Kaufvertrag zustimmen", "Wer wartet heute Abend im Restaurant auf uns", "Ist die Freigabe für den Gotthard wieder offen",
  "Muss ich die Steuererklärung bestätigen", "Wie viele offene Aufträge hat die Werkstatt Meier", "Soll ich dem Angebot zustimmen",
  "Kann ich der Offerte zustimmen", "Muss ich die Rechnung bestätigen", "Soll ich den neuen Vertrag genehmigen",
  "Welche Zustimmung braucht ein Baugesuch in Basel", "Wartet der Bus auf uns", "Was steht in der Warteschlange beim Arzt",
  "Was wartet im Restaurant auf uns",
];

describe("istFreigabeFrage: nur eindeutige Fragen nach der eigenen Warteschlange", () => {
  it("gewöhnliche Fragen und Entscheidungsfragen an den Berater werden nicht abgefangen", () => {
    for (const t of KEINE_FREIGABE_FRAGEN) assert.equal(istFreigabeFrage(t), false, t);
  });

  it("sie gehen an Claude, Alexa liest dessen Antwort vor (nicht den Freigaben-Stand)", async () => {
    claudeAntwort = "Das hängt vom Kleingedruckten ab, Sir.";
    for (const t of KEINE_FREIGABE_FRAGEN) {
      const vorher = systeme.length;
      const s = await frage(t);
      assert.equal(systeme.length, vorher + 1, t);
      assert.equal(s, "<speak>Das hängt vom Kleingedruckten ab, Sir.</speak>", t);
    }
  });

  it("Gegenprobe: eindeutige Fragen nach der Warteschlange bekommen weiter nur den Stand", async () => {
    for (const t of ["was wartet auf mich", "was liegt in der Warteschlange", "Welche Mails warten auf meine Zustimmung", "was muss ich noch bestätigen",
      "welche Mails soll ich freigeben", "gibt es offene Freigaben", "Freigaben"]) {
      assert.equal(istFreigabeFrage(t), true, t);
      const s = await frage(t);
      assert.match(s, new RegExp(`Nummer ${id}`), t);
    }
    assert.equal(systeme.length, 0);
  });
});
