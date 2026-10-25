import * as Alexa from "ask-sdk-core";
import type { ErrorHandler, HandlerInput, RequestHandler } from "ask-sdk-core";
import { config } from "./config.js";
import { aktuellerFreigabenHinweis, briefingTeile, cardioText, dashboardErreichbar, morningDone } from "./brain.js";
import { antwortGeschwaerzt, askWithBudget, pinGeschwaerzt, zugVerlauf } from "./agent.js";
import { audit } from "./audit.js";
import { offeneAuftraege } from "./queue.js";
import { hooks, pinFoermigLocker, sendeAntwort } from "./telegram.js";
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

/**
 * Freigaben-Hinweis für Alexa: Was Alexa sagt, geht als Text über Amazon (Leitplanke 9). Darum standardmässig
 * nur Anzahl und Nummern; Zusammenfassungen nur mit ALEXA_FREIGABEN_DETAILS=on. Telegram und Satellit bleiben ausführlich.
 */
export const alexaFreigabenHinweis = () => aktuellerFreigabenHinweis({ details: config.alexaFreigabenDetails });

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

/** Nach «Auftrag von/für/bei …» kein Dritter: Pronomen und Zeitangaben («Aufträge von heute», «für mich») */
const KEIN_DRITTER = String.raw`(?:mich|mir|uns|dich|dir|euch|heute|gestern|vorgestern|morgen|übermorgen|vorhin|jetzt|eben|gerade|dies\w*|letzt\w*|vergangen\w*|nächst\w*|heutig\w*|gestrig\w*|woche|warteschlange|freigabe\w*)`;
/**
 * Bezug auf Dritte: «der Auftrag von Müller», «für den Garten», «hat der Kunde …», «hat die Werkstatt Meier», Firma,
 * Lieferant. «hat» mit Subjekt ist nie der Nutzer («habe ich») und nie Jarvis («hast du»).
 */
const DRITTE = new RegExp(
  String.raw`\bauftr[aä]g\w*\s+(?:von|vom|bei|für|der|des)\s+(?:(?:der|die|das|den|dem|des|eine[mnrs]?|ein)\s+)?(?!${KEIN_DRITTER}\b)[a-zäöüß]|\bhat\s+(?!(?:sich|es|noch|schon|jetzt|gerade|heute|bisher)\b)[a-zäöüß]|\bkund\w*|\bfirma\b|\blieferant\w*`,
  "i",
);

/** Fragewort am Anfang, das nach dem eigenen Stand fragt (nicht «wer», «wie lang», «braucht es») */
const FRAGE_STAND = String.raw`^\s*(?:was|welche[mnrs]?|wie\s*viele|gibt\s+es|gibts|lies|les|zeig\w*|sag\w*|nenn\w*|liegt|liegen|steht|stehen|ist|sind|hast\s+du|habe?\s+ich)\b`;
/** Nur «was», «etwas» oder Sachen aus der Warteschlange als Objekt, kein anderes Nomen («dem Angebot», «die Rechnung») */
const SUBJEKT_WARTESCHLANGE = String.raw`^\s*(?:was|welche[mnrs]?(?:\s+(?:auftr[aä]ge|mails?|nachrichten|termine|entw[uü]rfe|sachen|dinge))?|gibt\s+es\s+(?:noch\s+)?(?:etwas|was|nichts))`;
const PRUEFVERB = String.raw`(?:bestätigen|genehmigen|absegnen|abnicken|zustimmen|freigeben)`;
const FUELLWORT = String.raw`(?:\s+(?:noch|heute|jetzt|gerade|eigentlich|bitte|schon|denn|mal))*`;

/**
 * Fragt die Frage nach der eigenen Warteschlange («was wartet auf Freigabe», «lies mir die offenen Freigaben vor»,
 * «welche Aufträge sind offen», «was muss ich freigeben», «was wartet auf mich», «was liegt in der Warteschlange», «was
 * muss ich noch absegnen», «welche Mails warten auf meine Zustimmung», «welche Mails hast du vorbereitet»)? Dann nicht
 * an Claude: Historie und Werkzeugeingaben kennen Empfänger und Inhalt, die Antwort ginge über Amazon
 * (ALEXA_FREIGABEN_DETAILS). Nur eindeutige Fragen: «Freigabe» mit Bezug auf den Nutzer («offene Freigaben», «auf
 * Freigabe»), «Warteschlange» ohne Ort («am Zoll», «beim Arzt»), «wartet auf mich» und Prüfverben nur mit «was»,
 * «etwas» oder Sachen der Warteschlange («Soll ich dem Angebot zustimmen» geht an Claude), alles ohne Bezug auf Dritte
 * (DRITTE). Was durchrutscht, bekommt bei Claude nur Nummern (freigabenNurNummern) und wird geprüft (nenntAuftragsdetails:
 * Werkzeugname und markante Eingaben wie Empfänger und Betreff).
 */
export function istFreigabeFrage(text: string): boolean {
  const t = text.trim();
  // Nur das Stichwort («Freigaben», «offene Freigaben»)
  if (/^(?:(?:meine|offene|wartende)\s+)?freigaben?[\s?.!]*$/i.test(t)) return true;
  if (DRITTE.test(t)) return false;
  const frage = new RegExp(FRAGE_STAND, "i").test(t);
  const freigabe = /\b(?:meine[nr]?|unsere[nr]?|offene[nr]?|wartende[nr]?|ausstehende[nr]?|anstehende[nr]?|neue[nr]?)\s+freigaben?\b|\bauf\s+(?:meine\s+|unsere\s+)?(?:freigabe|zustimmung|bestätigung|genehmigung)\b/i;
  if (frage && freigabe.test(t)) return true;
  // «in der Warteschlange», «meine Warteschlange», aber keine Warteschlange an einem Ort
  const warteschlange = /\b(?:der|die|meine[rn]?|deine[rn]?|ihre[rn]?|unsere[rn]?)\s+warteschlange\b(?!\s+(?:am|an|beim|bei|im|in|vor|von|vom|auf|zu[mr]?|für|der|des)\b)/i;
  if (frage && warteschlange.test(t)) return true;
  // «was wartet (noch) auf mich», «welche Mails warten auf uns»; nicht «wer wartet», «wartet der Bus», kein Ort dazwischen
  const wartetAufMich = new RegExp(String.raw`${SUBJEKT_WARTESCHLANGE}${FUELLWORT}\s+warte[nt]?\b(?:(?!\b(?:im|am|beim|bei|vor|unten|oben|draussen|draußen)\b).)*\bauf\s+(?:mich|uns)\b`, "i");
  if (wartetAufMich.test(t)) return true;
  // «was muss ich (noch) bestätigen», «welche Mails soll ich freigeben», «gibt es etwas zu genehmigen»
  const zuPruefen = new RegExp(
    String.raw`${SUBJEKT_WARTESCHLANGE}(?:\s+(?:muss|müsste|soll|sollte|kann|darf)\s+ich)?${FUELLWORT}\s+(?:zu\s+${PRUEFVERB}|${PRUEFVERB}|abzusegnen|zuzustimmen|freizugeben)\b`,
    "i",
  );
  if (zuPruefen.test(t)) return true;
  const offen = String.raw`(?:offen(?:e[nrs]?)?|wartend\w*|warte[nt]?)`;
  const auftraege = new RegExp(String.raw`\b${offen}\b.*\bauftr[aä]g|\bauftr[aä]g\w*\b.*\b${offen}\b`, "i");
  if (auftraege.test(t)) return true;
  const vorbereitet = /\b(?:mails?|nachrichten?|auftr[aä]g\w*|entw[uü]rfe?|termine?)\b.*\bvorbereitet\b|\bvorbereitet\w*\s+(?:mails?|nachrichten?|auftr[aä]g\w*|entw[uü]rfe?)\b/i;
  if (vorbereitet.test(t)) return true;
  // «was ist schon freigegeben», «welche Aufträge sind freigegeben»
  return new RegExp(String.raw`${SUBJEKT_WARTESCHLANGE}\b.*\bfreigegeben\b`, "i").test(t);
}

/** Für den Vergleich: klein, Umlaute ausgeschrieben («Müller» = «mueller»), alles ausser Buchstaben und Ziffern als ein Leerzeichen */
const normiert = (t: string): string =>
  t.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Teile vor dem @, die keinen Menschen nennen (info@, kontakt@ …) */
const ALLGEMEINE_POSTFAECHER = new Set(["info", "kontakt", "contact", "office", "mail", "email", "hallo", "hello", "support", "admin", "service", "team", "noreply", "sales", "verkauf", "buchhaltung", "empfang", "zentrale"]);

/**
 * Markante Eingaben eines offenen Auftrags, nicht Allerweltswörter: `roh` (klein, als Teilstring gesucht) Adressen,
 * Domains, URLs, Hosts, entity_id und Pfade; `woerter` (normiert, als ganze Wortfolge gesucht) Namen aus der
 * Mail-Adresse (ab 4 Zeichen), der Teil einer entity_id nach dem Punkt (ab 6), Wortpaare aus kurzen Feldern wie
 * Betreff, Titel, Ort (zusammen ab 12 Zeichen), Wortdreier aus langen Feldern wie dem Mailtext, ein langes Einzelwort.
 */
function auftragsMerkmale(input: unknown): { roh: string[]; woerter: string[] } {
  const roh: string[] = [];
  const woerter: string[] = [];
  const texte: string[] = [];
  const sammeln = (x: unknown, tiefe: number): void => {
    if (texte.length >= 100) return;
    if (typeof x === "string") texte.push(x.slice(0, 4000));
    else if (x && typeof x === "object" && tiefe < 4) for (const v of Object.values(x)) sammeln(v, tiefe + 1);
  };
  sammeln(input, 0);
  for (const wert of texte) {
    for (const stueck of wert.split(/[\s,;<>()"'«»]+/)) {
      const s = stueck.toLowerCase().replace(/^[.:]+|[.:]+$/g, "");
      // Adresse, URL, entity_id, Datei oder Domain; keine Abkürzung («z.B.»), Zahl oder Uhrzeit («14.30»)
      if (s.length < 5 || !/[a-z]/.test(s) || !/@|_|:\/\/|[a-z0-9]\.[a-z]/.test(s)) continue;
      roh.push(s);
      const mail = /^([^@]+)@(.+)$/.exec(s);
      if (mail) {
        roh.push(mail[2]!);
        for (const teil of mail[1]!.split(/[._+-]+/)) if (teil.length >= 4 && !ALLGEMEINE_POSTFAECHER.has(teil) && !/^\d+$/.test(teil)) woerter.push(normiert(teil));
        continue;
      }
      const url = /^[a-z][a-z0-9+.-]*:\/\/(?:www\.)?([^/:?#]+)/.exec(s);
      if (url && url[1]!.includes(".")) roh.push(url[1]!);
      const entity = /^[a-z_]+\.([a-z0-9_]+)$/.exec(s);
      if (entity && entity[1]!.length >= 6) woerter.push(normiert(entity[1]!.replace(/_/g, " ")));
    }
    const w = normiert(wert).split(" ").filter(Boolean);
    if (w.length === 1 && w[0]!.length >= 12) woerter.push(w[0]!);
    const lang = wert.length > 80;
    const n = lang ? 3 : 2;
    for (let i = 0; i + n <= w.length; i++) {
      const folge = w.slice(i, i + n);
      if (folge.some((x) => x.length < (lang ? 4 : 3))) continue;
      const phrase = folge.join(" ");
      if (phrase.length >= 12) woerter.push(phrase);
    }
  }
  return { roh, woerter };
}

/**
 * Nennt die Antwort Einzelheiten offener Aufträge? Werkzeugname («mail_senden», auch mit Leerzeichen) oder markante
 * Eingaben (auftragsMerkmale: Empfänger, Betreff, Titel, Ort, entity_id, URL), auch ohne Werkzeugnamen («die Antwort an
 * Herrn Müller zur Offerte Zutrittskontrolle Basel»). Dann geht sie bei ALEXA_FREIGABEN_DETAILS=off nicht über Amazon;
 * Alexa nennt stattdessen nur den Stand. Die Kanalnotiz allein ist nur eine Anweisung, der Verlauf trägt die Eingaben.
 */
function nenntAuftragsdetails(antwort: string): boolean {
  const t = antwort.toLowerCase();
  const wortweise = ` ${normiert(antwort)} `;
  return offeneAuftraege().some((a) => {
    const name = a.tool.toLowerCase();
    if (t.includes(name) || (name.includes("_") && t.includes(name.replace(/_/g, " ")))) return true;
    const { roh, woerter } = auftragsMerkmale(a.input);
    return roh.some((r) => t.includes(r)) || woerter.some((w) => w && wortweise.includes(` ${w} `));
  });
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

/** Stand der Warteschlange für Alexa: Anzahl und Nummern, im Notaus/Notfall nur der Sperrhinweis. */
const freigabenStand = () => (gesperrt() ? sperrHinweis() : alexaFreigabenHinweis() || nichtsWartet());

const sperrSprechen = (i: HandlerInput) => sprich(i, [`Briefing und Gesundheitswerte ruhen, ${config.anrede}.`, sperrHinweis()]);

/** Briefing, kurze Pause, offene Freigaben (die Telegram-Kopie aus briefingTeile bleibt ausführlich) */
const briefingSprechen = async (i: HandlerInput) => {
  if (gesperrt()) return sperrSprechen(i);
  const t = await briefingTeile();
  return sprich(i, [t.text, alexaFreigabenHinweis()]);
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
  handle: (i) => sprich(i, freigabenStand()),
};

/** Freie Frage: «Alexa, frag Butler Jarvis, was heute in Basel los ist» */
const Frage: RequestHandler = {
  canHandle: (i) => isIntent(i, "FrageIntent"),
  handle: async (i) => {
    const frage = Alexa.getSlotValue(i.requestEnvelope, "frage")?.trim();
    if (!frage) return sprich(i, "Ich höre.", "Ich höre.");
    // Was die PIN sein könnte, geht weder an Claude noch in die Historie oder nach Telegram. Nur auditiert, nicht als
    // Missbrauch gezählt: am Echo spricht jeder im Raum, prüfen lässt sich die PIN hier nicht; fünf gesprochene Zahlen
    // dürfen keinen Notfall auslösen (wie POST /notfall, notfall.ts).
    if (pinFoermigLocker(frage) !== undefined) {
      audit("pin_im_chat", { quelle: "alexa" });
      return sprich(i, `Die PIN bitte nie sprechen, ${config.anrede}. Nichts gesendet.`);
    }
    // Nichts freigeben, aber den Stand nennen; Fragen nach der Warteschlange ebenso nicht an Claude
    if (istFreigabeWunsch(frage)) return sprich(i, [nurSchriftlich(), freigabenStand()]);
    if (istFreigabeFrage(frage)) return sprich(i, freigabenStand());
    const telegram = Boolean(config.telegramToken && config.telegramOwner);
    // Echo und späte Antwort geschwärzt (auch die PIN mitten im Satz); im Notaus/Notfall nichts (askWithBudget, sendeAntwort)
    const echo = pinGeschwaerzt(schwaerze(frage)).slice(0, 60);
    // Vor dem Zug erfasst: auch nach einem /neu während der Antwort zählt die eigene Frage
    const verlauf = zugVerlauf(frage);
    const later = async (reply: string, eintrag?: object) => {
      const r = antwortGeschwaerzt(schwaerze(reply), "<PIN>", verlauf());
      if (telegram) await sendeAntwort(`Zu deiner Frage per Alexa («${echo}»):\n\n${r}`, eintrag);
      else console.log("Antwort ohne Telegram-Zustellung:", r);
    };
    // Ohne Einzelheiten (Standard): Claude sieht zu offenen Aufträgen nur Anzahl und Nummern, samt Kanalnotiz
    const ohneDetails = !config.alexaFreigabenDetails;
    const reply = await askWithBudget(frage, config.alexaBudgetMs, hooks, later, ohneDetails ? { freigabenNurNummern: true } : {});
    if (reply === undefined) {
      return sprich(i, telegram ? `Das braucht einen Moment, ${config.anrede}. Das Ergebnis kommt per Telegram.` : "Das braucht einen Moment, ich arbeite weiter.");
    }
    // Nennt sie trotzdem Einzelheiten offener Aufträge: nicht über Amazon, nur der Stand
    if (ohneDetails && nenntAuftragsdetails(reply)) {
      audit("alexa_antwort_ersetzt", { grund: "freigaben_details" });
      return sprich(i, [`Einzelheiten zu offenen Aufträgen nenne ich hier nicht, ${config.anrede}; sie stehen in Telegram.`, freigabenStand()], "Noch etwas?");
    }
    // Auch die rechtzeitige Antwort geschwärzt (sie geht über Amazon und wird im Raum vorgelesen); die PIN nach forSpeech,
    // damit auch «4*7*1*1» als «4 7 1 1» erkannt wird. Vorgelesen wird «PIN», nicht «kleiner PIN grösser».
    return sprich(i, Array.from(antwortGeschwaerzt(forSpeech(schwaerze(reply)), "PIN", verlauf())).slice(0, 1500).join(""), "Noch etwas?");
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
