import * as Alexa from "ask-sdk-core";
import type { ErrorHandler, HandlerInput, RequestHandler } from "ask-sdk-core";
import { config } from "./config.js";
import { briefingText, cardioText, morningDone } from "./brain.js";
import { askWithBudget } from "./agent.js";
import { hooks, sendText } from "./telegram.js";
import { forSpeech } from "./voice.js";
import { sagt } from "./persona.js";

function ssml(text: string): string {
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return config.alexaVoice ? `<voice name="${config.alexaVoice}">${safe}</voice>` : safe;
}

const say = (input: HandlerInput, text: string) =>
  input.responseBuilder.speak(ssml(text)).withShouldEndSession(true).getResponse();

const isType = (input: HandlerInput, type: string) => Alexa.getRequestType(input.requestEnvelope) === type;
const isIntent = (input: HandlerInput, ...names: string[]) =>
  isType(input, "IntentRequest") && names.includes(Alexa.getIntentName(input.requestEnvelope));

/** «Alexa, öffne Butler Jarvis» und beide Routinen landen hier: erst Cardio, danach Tagesbriefing. */
const Launch: RequestHandler = {
  canHandle: (i) => isType(i, "LaunchRequest"),
  handle: async (i) => say(i, morningDone() ? await briefingText() : await cardioText()),
};

const Cardio: RequestHandler = {
  canHandle: (i) => isIntent(i, "CardioIntent"),
  handle: async (i) => say(i, await cardioText()),
};

const Briefing: RequestHandler = {
  canHandle: (i) => isIntent(i, "BriefingIntent"),
  handle: async (i) => say(i, await briefingText()),
};

/** Freie Frage: «Alexa, frag Butler Jarvis, was heute in Basel los ist» */
const Frage: RequestHandler = {
  canHandle: (i) => isIntent(i, "FrageIntent"),
  handle: async (i) => {
    const frage = Alexa.getSlotValue(i.requestEnvelope, "frage")?.trim();
    if (!frage) return i.responseBuilder.speak("Ich höre.").reprompt("Ich höre.").getResponse();
    const telegram = Boolean(config.telegramToken && config.telegramOwner);
    const later = async (reply: string) => {
      if (telegram) await sendText(`Zu deiner Frage per Alexa («${frage}»):\n\n${reply}`);
      else console.log("Antwort ohne Telegram-Zustellung:", reply);
    };
    const reply = await askWithBudget(frage, config.alexaBudgetMs, hooks, later);
    if (reply === undefined) {
      return say(i, telegram ? `Das braucht einen Moment, ${config.anrede}. Das Ergebnis kommt per Telegram.` : "Das braucht einen Moment, ich arbeite weiter.");
    }
    return i.responseBuilder.speak(ssml(forSpeech(reply).slice(0, 1500))).reprompt("Noch etwas?").getResponse();
  },
};

const Help: RequestHandler = {
  canHandle: (i) => isIntent(i, "AMAZON.HelpIntent", "AMAZON.FallbackIntent"),
  handle: (i) =>
    i.responseBuilder.speak("Cardio, mein Tag, oder eine Frage. Ich höre.").reprompt("Ich höre.").getResponse(),
};

const Stop: RequestHandler = {
  canHandle: (i) => isIntent(i, "AMAZON.StopIntent", "AMAZON.CancelIntent", "AMAZON.NavigateHomeIntent"),
  handle: (i) => say(i, sagt.bisSpaeter()),
};

const SessionEnded: RequestHandler = {
  canHandle: (i) => isType(i, "SessionEndedRequest"),
  handle: (i) => i.responseBuilder.getResponse(),
};

const Errors: ErrorHandler = {
  canHandle: () => true,
  handle: (i, err) => {
    console.error("Alexa-Fehler:", err);
    return say(i, "Da ist mir etwas misslungen. Das Log weiss mehr.");
  },
};

export function buildSkill(skillId: string) {
  return Alexa.SkillBuilders.custom()
    .addRequestHandlers(Launch, Cardio, Briefing, Frage, Help, Stop, SessionEnded)
    .addErrorHandlers(Errors)
    .withSkillId(skillId) // Anfragen anderer Skills werden abgewiesen
    .create();
}
