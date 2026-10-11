import * as Alexa from "ask-sdk-core";
import type { ErrorHandler, HandlerInput, RequestHandler } from "ask-sdk-core";
import { config } from "./config.js";
import { aktuellerFreigabenHinweis, briefingTeile, cardioText, dashboardErreichbar, morningDone } from "./brain.js";
import { askWithBudget } from "./agent.js";
import { hooks, sendText } from "./telegram.js";
import { forSpeech } from "./voice.js";
import { sagt } from "./persona.js";
import { state, type Mode } from "./state.js";
import { minutesOfDay } from "./time.js";
import { schwaerze } from "./robust.js";

/** Nur für Tests: Uhrzeit injizieren (im Betrieb leer = jetzt). */
export const _testOptionen: { jetzt?: () => Date } = {};

// =====================================================================
// SSML: alles aus Daten (Briefing, Auftrags-Zusammenfassungen, Antworten) wird escaped;
// eigene Tags (Pause, Lautstärke, Stimme) setzt nur dieser Code.
// =====================================================================

/** Pause zwischen Briefing und Freigaben-Hinweis */
export const PAUSE = '<break time="400ms"/>';

/**
 * XML-Sonderzeichen escapen; Steuerzeichen und einzelne Surrogate (halbiertes Emoji nach einer Kürzung) entfernen,
 * denn ungültiges XML macht Alexa zum Fehler statt zur Ansage.
 */
export function ssmlEscape(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Text (oder mehrere Teile, getrennt durch eine kurze Pause) als SSML-Inhalt ohne `<speak>` (ergänzt ask-sdk).
 * leise: Nachtstimme. stimme: undefined = ALEXA_VOICE, null oder leer = Alexa-Stimme.
 */
export function ssml(text: string | string[], opts: { leise?: boolean; stimme?: string | null } = {}): string {
  const teile = (Array.isArray(text) ? text : [text]).map((t) => t.trim()).filter(Boolean).map(ssmlEscape);
  let inhalt = teile.join(PAUSE);
  if (opts.leise) inhalt = `<prosody volume="soft" rate="95%">${inhalt}</prosody>`;
  const stimme = opts.stimme === undefined ? config.alexaVoice : opts.stimme;
  return stimme ? `<voice name="${ssmlEscape(stimme)}">${inhalt}</voice>` : inhalt;
}

// =====================================================================
// Nachtstimme: im Nachtmodus oder im Fenster ALEXA_NACHT (z. B. 22:00-06:30, über Mitternacht) leiser
// =====================================================================

/**
 * «HH:MM-HH:MM» in Minuten seit Mitternacht; «off» = aus; undefined = ungültig. Gleiche Form wie pruefeZeitfenster (setup.ts)
 * und npm run check: nur kleines «off», sonst gilt hier etwas anderes, als check meldet. Gleiche Grenzen meldet
 * npm run check als leeres Fenster (istNacht: kein Fenster).
 */
export function nachtFenster(fenster: string): { von: number; bis: number } | "off" | undefined {
  const f = fenster.trim();
  if (f === "off") return "off";
  const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(f);
  if (!m) return undefined;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  return { von: h1 * 60 + m1, bis: h2 * 60 + m2 };
}

/** Wahr im Nachtmodus oder wenn `now` im Fenster liegt (Beginn inklusive, Ende exklusive; gleicher Beginn und Ende = kein Fenster). */
export function istNacht(now: Date, fenster: string, modus: Mode): boolean {
  if (modus === "nacht") return true;
  const f = nachtFenster(fenster);
  if (!f || f === "off" || f.von === f.bis) return false;
  const m = minutesOfDay(now);
  return f.von < f.bis ? m >= f.von && m < f.bis : m >= f.von || m < f.bis;
}

let fensterGewarnt = false;
function leiseJetzt(): boolean {
  if (!fensterGewarnt && nachtFenster(config.alexaNacht) === undefined) {
    fensterGewarnt = true;
    console.warn(`ALEXA_NACHT «${config.alexaNacht}» ist ungültig (Form HH:MM-HH:MM oder off); Nachtfenster aus, Nachtmodus wirkt weiter.`);
  }
  return istNacht(_testOptionen.jetzt?.() ?? new Date(), config.alexaNacht, state.mode ?? "normal");
}

/** Gemeinsamer Ausgang aller Antworten: SSML, Nachtstimme; mit `nachfrage` bleibt die Sitzung offen. */
function sprich(input: HandlerInput, text: string | string[], nachfrage?: string) {
  const leise = leiseJetzt();
  const antwort = input.responseBuilder.speak(ssml(text, { leise }));
  return nachfrage
    ? antwort.reprompt(ssml(nachfrage, { leise })).getResponse()
    : antwort.withShouldEndSession(true).getResponse();
}

// =====================================================================
// Freigaben: per Stimme wird nur vorgelesen, nie freigegeben (Leitplanke 1)
// =====================================================================

const nurSchriftlich = () =>
  `Freigaben nehme ich nur per Telegram${dashboardErreichbar() ? " oder Dashboard" : ""} entgegen, ${config.anrede}.`;

const nichtsWartet = () => `Nichts wartet auf ${config.form === "du" ? "dich" : "Sie"}, ${config.anrede}.`;

const ZAHL = String.raw`(?:\d+|[a-zäöü]*(?:zehn|zig)|eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|elf|zwölf)(?![a-zäöü\d])`;

/**
 * Will die Frage einen Auftrag der Warteschlange freigeben, bestätigen oder ausführen? Dann gar nicht erst an Claude.
 * Nur Befehls- und Grundformen (gib … frei, genehmige, bestätige, führe … aus), keine Partizipien («bestätigt», «freigegeben»),
 * damit Fragen zu Kundenaufträgen («hat Müller den Auftrag bestätigt») an Claude gehen. Objekt: «Freigabe», Auftrag oder Nummer
 * mit Zahl, oder «den/alle Aufträge» ohne Bezug auf Dritte («den Auftrag von Müller»).
 */
export function istFreigabeWunsch(text: string): boolean {
  const verb =
    /\bfrei(?:zu)?geben\b|\bfrei\s+geben\b|\bg(?:ib|ebe?)\b.*\bfrei\b|\bgenehmigen?\b|\bbestätigen?\b|\berteilen?\b|\berlauben?\b|\baus(?:zu)?führen\b|\bführe?\b.*\baus\b/i;
  const objekt = new RegExp(
    String.raw`\bfreigaben?\b|\b(?:auftrag|nummer)\s+(?:nr\.?\s*|nummer\s+)?#?${ZAHL}|\b(?:den|diesen|alle|die)\s+(?:offenen?\s+|wartenden?\s+)?auftr[aä]g(?:e|en)?\b(?!\s+(?:von|vom|bei|für|der|des)\b)`,
    "i",
  );
  return verb.test(text) && objekt.test(text);
}

// =====================================================================
// Handler
// =====================================================================

const isType = (input: HandlerInput, type: string) => Alexa.getRequestType(input.requestEnvelope) === type;
const isIntent = (input: HandlerInput, ...names: string[]) =>
  isType(input, "IntentRequest") && names.includes(Alexa.getIntentName(input.requestEnvelope));

/** Notaus oder Notfall: /alexa ist über den Tunnel erreichbar, also keine Termine, keine Gesundheitswerte, kein Claude-Aufruf. */
const gesperrt = () => Boolean(state.paused) || Boolean(state.notfall?.aktiv);

/** Statt Briefing oder Cardio nur der Sperrhinweis (gleicher Wortlaut wie aktuellerFreigabenHinweis im Notaus/Notfall). */
const sperrHinweis = () =>
  state.paused
    ? aktuellerFreigabenHinweis()
    : `Notfall aktiv, ${config.anrede}. Freigaben ruhen; aufheben nur mit /entwarnung in Telegram.`;

const sperrSprechen = (i: HandlerInput) => sprich(i, [`Briefing und Gesundheitswerte ruhen, ${config.anrede}.`, sperrHinweis()]);

/** Briefing, kurze Pause, offene Freigaben */
const briefingSprechen = async (i: HandlerInput) => {
  if (gesperrt()) return sperrSprechen(i);
  const t = await briefingTeile();
  return sprich(i, [t.text, t.hinweis]);
};

/** «Alexa, öffne Butler Jarvis» und beide Routinen landen hier: erst Cardio, danach Tagesbriefing. */
const Launch: RequestHandler = {
  canHandle: (i) => isType(i, "LaunchRequest"),
  handle: async (i) => {
    if (gesperrt()) return sperrSprechen(i);
    return morningDone() ? briefingSprechen(i) : sprich(i, await cardioText());
  },
};

const Cardio: RequestHandler = {
  canHandle: (i) => isIntent(i, "CardioIntent"),
  handle: async (i) => (gesperrt() ? sperrSprechen(i) : sprich(i, await cardioText())),
};

const Briefing: RequestHandler = {
  canHandle: (i) => isIntent(i, "BriefingIntent"),
  handle: briefingSprechen,
};

/** «Alexa, frag Butler Jarvis nach offenen Aufträgen»: nur vorlesen. */
const Freigaben: RequestHandler = {
  canHandle: (i) => isIntent(i, "FreigabenIntent"),
  handle: (i) => sprich(i, aktuellerFreigabenHinweis() || nichtsWartet()),
};

/** Freie Frage: «Alexa, frag Butler Jarvis, was heute in Basel los ist» */
const Frage: RequestHandler = {
  canHandle: (i) => isIntent(i, "FrageIntent"),
  handle: async (i) => {
    const frage = Alexa.getSlotValue(i.requestEnvelope, "frage")?.trim();
    if (!frage) return sprich(i, "Ich höre.", "Ich höre.");
    // Nichts freigeben, aber den Stand nennen (im Notaus/Notfall nur dessen Hinweis)
    if (istFreigabeWunsch(frage)) return sprich(i, [nurSchriftlich(), aktuellerFreigabenHinweis() || nichtsWartet()]);
    const telegram = Boolean(config.telegramToken && config.telegramOwner);
    const later = async (reply: string) => {
      if (telegram) await sendText(`Zu deiner Frage per Alexa («${frage}»):\n\n${reply}`);
      else console.log("Antwort ohne Telegram-Zustellung:", reply);
    };
    const reply = await askWithBudget(frage, config.alexaBudgetMs, hooks, later);
    if (reply === undefined) {
      return sprich(i, telegram ? `Das braucht einen Moment, ${config.anrede}. Das Ergebnis kommt per Telegram.` : "Das braucht einen Moment, ich arbeite weiter.");
    }
    return sprich(i, Array.from(forSpeech(reply)).slice(0, 1500).join(""), "Noch etwas?");
  },
};

const hilfe = () => `Cardio, mein Tag, offene Aufträge oder eine Frage. ${nurSchriftlich()} Ich höre.`;

const Help: RequestHandler = {
  canHandle: (i) => isIntent(i, "AMAZON.HelpIntent"),
  handle: (i) => sprich(i, hilfe(), "Ich höre."),
};

/** Unverstandenes, etwa «gib Auftrag 12 frei»: Hilfe samt Hinweis, dass Freigaben nur schriftlich gehen. */
const Fallback: RequestHandler = {
  canHandle: (i) => isIntent(i, "AMAZON.FallbackIntent"),
  handle: (i) => sprich(i, `Das habe ich nicht verstanden. ${hilfe()}`, "Ich höre."),
};

const Stop: RequestHandler = {
  canHandle: (i) => isIntent(i, "AMAZON.StopIntent", "AMAZON.CancelIntent", "AMAZON.NavigateHomeIntent"),
  handle: (i) => sprich(i, sagt.bisSpaeter()),
};

const SessionEnded: RequestHandler = {
  canHandle: (i) => isType(i, "SessionEndedRequest"),
  handle: (i) => i.responseBuilder.getResponse(),
};

const Errors: ErrorHandler = {
  canHandle: () => true,
  handle: (i, err) => {
    console.error("Alexa-Fehler:", schwaerze(err.stack ?? err.message));
    return sprich(i, "Da ist mir etwas misslungen. Das Log weiss mehr.");
  },
};

export function buildSkill(skillId: string) {
  return Alexa.SkillBuilders.custom()
    .addRequestHandlers(Launch, Cardio, Briefing, Freigaben, Frage, Help, Fallback, Stop, SessionEnded)
    .addErrorHandlers(Errors)
    .withSkillId(skillId) // Anfragen anderer Skills werden abgewiesen
    .create();
}
