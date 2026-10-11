import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/ liegt relativ) und Umgebung; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-alexa-"));
process.chdir(temp);
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_ANREDE = "Sir";
process.env.JARVIS_FORM = "sie";
process.env.JARVIS_EVENT_TOKEN = "attrappe-event-token";
delete process.env.DASHBOARD;
delete process.env.ALEXA_VOICE;
delete process.env.ALEXA_NACHT;
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

// fetch-Attrappe: Telegram antwortet ok, alles andere (Claude, Wetter, …) ist ein Testfehler
const aufrufe: { url: string; body: string }[] = [];
const echteFetch = globalThis.fetch;
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  aufrufe.push({ url, body: String(init?.body ?? "") });
  if (!url.startsWith("https://api.telegram.org/bot")) throw new Error(`unerwarteter Aufruf: ${url}`);
  return new Response(JSON.stringify({ ok: true, result: { message_id: aufrufe.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const alexa = await import("../src/alexa.js");
const { istNacht, nachtFenster, ssml, ssmlEscape, PAUSE, istFreigabeWunsch, buildSkill, _testOptionen } = alexa;
const { freigabenHinweis, kurzFuerStimme, briefingText, HINWEIS_MAX_ZEICHEN } = await import("../src/brain.js");
const { auftraege, saveAuftraege } = await import("../src/queue.js");
type Auftrag = import("../src/queue.js").Auftrag;
const { day, save, state } = await import("../src/state.js");
const { config } = await import("../src/config.js");
const { pruefeZeitfenster } = await import("../src/setup.js");

/** Lokale Uhrzeit (Europe/Zurich, von config gesetzt) an einem festen Tag */
const um = (h: number, m = 0) => new Date(2026, 9, 11, h, m, 0, 0);
const durchlaufen = () => new Promise<void>((r) => setImmediate(r));

const auftrag = (id: number, summary: string, status: Auftrag["status"] = "offen"): Auftrag => ({
  id, summary, status, createdAt: "2026-10-11T06:00:00.000Z", tool: "gmail_senden", input: {}, stufe: "extern",
});

// =====================================================================
describe("istNacht", () => {
  const F = "22:00-06:30";

  it("Fenster über Mitternacht mit Grenzen (Beginn inklusive, Ende exklusive)", () => {
    assert.equal(istNacht(um(21, 59), F, "normal"), false);
    assert.equal(istNacht(um(22, 0), F, "normal"), true);
    assert.equal(istNacht(um(23, 59), F, "normal"), true);
    assert.equal(istNacht(um(0, 0), F, "normal"), true);
    assert.equal(istNacht(um(3, 15), F, "normal"), true);
    assert.equal(istNacht(um(6, 29), F, "normal"), true);
    assert.equal(istNacht(um(6, 30), F, "normal"), false);
    assert.equal(istNacht(um(12, 0), F, "normal"), false);
  });

  it("Fenster am selben Tag", () => {
    assert.equal(istNacht(um(12, 59), "13:00-14:00", "normal"), false);
    assert.equal(istNacht(um(13, 0), "13:00-14:00", "normal"), true);
    assert.equal(istNacht(um(13, 59), "13:00-14:00", "fokus"), true);
    assert.equal(istNacht(um(14, 0), "13:00-14:00", "normal"), false);
  });

  it("off und ungültige Fenster: nie Nacht, ausser im Nachtmodus", () => {
    for (const f of ["off", "OFF", "", "abc", "aus", "22:00", "25:00-06:00", "24:00-06:00", "22:60-06:00", "22:00-06:30-07:00", "22:00 - 06:30", "22:00-6:30"]) {
      assert.equal(istNacht(um(23, 0), f, "normal"), false, `Fenster «${f}»`);
      assert.equal(istNacht(um(12, 0), f, "nacht"), true, `Nachtmodus erzwingt bei «${f}»`);
    }
  });

  it("Nachtmodus erzwingt auch mittags; gleicher Beginn und Ende ist kein Fenster", () => {
    assert.equal(istNacht(um(12, 0), F, "nacht"), true);
    assert.equal(istNacht(um(22, 0), "22:00-22:00", "normal"), false);
  });

  it("nachtFenster: gleiche Form wie die Setup-Prüfung (sonst meldet npm run check etwas anderes, als gilt)", () => {
    assert.deepEqual(nachtFenster(" 22:00-06:30 "), { von: 22 * 60, bis: 6 * 60 + 30 });
    assert.deepEqual(nachtFenster("00:00-23:59"), { von: 0, bis: 23 * 60 + 59 });
    assert.equal(nachtFenster("off"), "off");
    assert.deepEqual(nachtFenster("22:00-22:00"), { von: 1320, bis: 1320 }, "gültige Form, aber leeres Fenster (check meldet es)");
    assert.equal(nachtFenster("OFF"), undefined);
    for (const f of ["22-06", "22:00 - 06:30", "22:00-6:30", "aus", "23:60-01:00", "24:00-01:00", "22:00-06:30-07:00", "OFF", "Off"]) {
      assert.equal(nachtFenster(f), undefined, f);
      assert.ok(pruefeZeitfenster(f.trim()), `Setup lehnt «${f}» ebenfalls ab`);
    }
    for (const f of ["22:00-06:30", "00:00-23:59", "off"]) assert.equal(pruefeZeitfenster(f), undefined, f);
  });

  it("Setup-Prüfung passt zum Standard und zu off", () => {
    assert.equal(pruefeZeitfenster("22:00-06:30"), undefined);
    assert.equal(pruefeZeitfenster("off"), undefined);
    assert.equal(pruefeZeitfenster("13:00-14:00"), undefined);
    for (const f of ["22:00", "24:00-06:00", "22:00-6:30", "22:00-06:30-07:00", "nachts", ""]) assert.ok(pruefeZeitfenster(f), `«${f}» abgelehnt`);
    assert.equal(config.alexaNacht, "22:00-06:30", "Standard ohne .env");
  });
});

describe("npm run check: Alexa-Skill", () => {
  it("meldet ein ungültiges Nachtfenster, nennt das gültige", async () => {
    const { selbsttest } = await import("../src/check.js");
    const vorher = config.alexaNacht;
    process.env.ALEXA_SKILL_ID = "amzn1.ask.skill.00000000-0000-0000-0000-000000000000";
    try {
      config.alexaNacht = "22 Uhr";
      const [falsch] = await selbsttest(["Alexa-Skill"]);
      assert.equal(falsch.status, "fehler");
      assert.match(falsch.info, /ALEXA_NACHT «22 Uhr» ungültig/);
      config.alexaNacht = "22:00-06:30";
      const [gut] = await selbsttest(["Alexa-Skill"]);
      assert.equal(gut.status, "ok");
      assert.match(gut.info, /22:00-06:30 und im Nachtmodus/);
      config.alexaNacht = "off";
      assert.match((await selbsttest(["Alexa-Skill"]))[0].info, /nur im Nachtmodus/);
    } finally {
      config.alexaNacht = vorher;
      delete process.env.ALEXA_SKILL_ID;
    }
  });
});

// =====================================================================
describe("ssml", () => {
  it("escaped alle XML-Sonderzeichen und entfernt Steuerzeichen", () => {
    assert.equal(ssmlEscape(`Tom & "Jerry" <b>it's</b>\u0007`), "Tom &amp; &quot;Jerry&quot; &lt;b&gt;it&apos;s&lt;/b&gt;");
    assert.equal(ssml("A & B", { stimme: null }), "A &amp; B");
  });

  it("entfernt einzelne Surrogate (halbiertes Emoji), ganze Emojis bleiben", () => {
    const s = ssml("a\uD83D", { stimme: null });
    assert.ok(!s.includes("\uD83D"));
    assert.equal(s, "a");
    assert.equal(ssmlEscape("\uDD12b\uD83D"), "b");
    assert.equal(ssmlEscape("Tür 🔒 zu"), "Tür 🔒 zu");
    assert.equal(ssmlEscape("a\uD83Cb\uDF89c🎉"), "abc🎉");
    assert.ok(!/[\uD800-\uDFFF]/.test(ssml("Antwort \uDF89 von Claude", { stimme: "Hans" })), "auch mit Stimme kein einzelnes Surrogat");
    const gekuerzt = kurzFuerStimme(`Bestellung${"x".repeat(48)}🔒🔒🔒`);
    const wohlgeformt = (t: string) => !/[\uD800-\uDFFF]/.test(t.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""));
    assert.ok(wohlgeformt(ssml(gekuerzt, { stimme: null })));
    assert.ok(wohlgeformt(ssml(`Bestellung${"x".repeat(48)}\uD83D…`, { stimme: null })));
  });

  it("Injektion von SSML-Tags bleibt Text", () => {
    const boese = `Licht aus<break time="10s"/><audio src="https://x.ch/a.mp3"/></prosody></voice>`;
    const s = ssml(boese, { leise: true, stimme: "Hans" });
    assert.ok(!s.includes("<audio") && !s.includes("<break") && !s.includes("</prosody></voice></prosody>"));
    assert.equal(s.match(/<prosody/g)?.length, 1);
    assert.equal(s.match(/<\/prosody>/g)?.length, 1);
    assert.ok(s.includes("&lt;audio src=&quot;https://x.ch/a.mp3&quot;/&gt;"));
  });

  it("leise und normal, mit und ohne Stimme (prosody innerhalb von voice)", () => {
    assert.equal(ssml("Gute Nacht.", { stimme: null }), "Gute Nacht.");
    assert.equal(ssml("Gute Nacht.", { leise: true, stimme: null }), '<prosody volume="soft" rate="95%">Gute Nacht.</prosody>');
    assert.equal(ssml("Hallo.", { stimme: "Hans" }), '<voice name="Hans">Hallo.</voice>');
    assert.equal(ssml("Hallo.", { leise: true, stimme: "Hans" }), '<voice name="Hans"><prosody volume="soft" rate="95%">Hallo.</prosody></voice>');
    assert.equal(ssml("Hallo.", { stimme: 'Ha"ns' }), '<voice name="Ha&quot;ns">Hallo.</voice>', "Stimmenname escaped");
  });

  it("Stimme aus ALEXA_VOICE, wenn nicht angegeben", () => {
    const vorher = config.alexaVoice;
    try {
      config.alexaVoice = "Hans";
      assert.equal(ssml("Hallo."), '<voice name="Hans">Hallo.</voice>');
      config.alexaVoice = undefined;
      assert.equal(ssml("Hallo."), "Hallo.");
    } finally {
      config.alexaVoice = vorher;
    }
  });

  it("Teile mit Pause, leere Teile ohne Pause", () => {
    assert.equal(ssml(["Briefing.", "Hinweis."], { stimme: null }), `Briefing.${PAUSE}Hinweis.`);
    assert.equal(ssml(["Briefing.", ""], { stimme: null }), "Briefing.");
    assert.equal(ssml(["<a>", "b&"], { stimme: null }), `&lt;a&gt;${PAUSE}b&amp;`);
  });
});

// =====================================================================
describe("freigabenHinweis", () => {
  it("0 offene (oder nur erledigte) → leer", () => {
    assert.equal(freigabenHinweis([], "Sir"), "");
    assert.equal(freigabenHinweis([auftrag(1, "Mail", "erledigt"), auftrag(2, "Licht", "abgelehnt")], "Sir"), "");
  });

  it("1 Auftrag", () => {
    assert.equal(
      freigabenHinweis([auftrag(7, "Licht Büro aus.")], "Sir"),
      "Ein Auftrag wartet auf Ihre Freigabe, Sir: Nummer 7, Licht Büro aus. Freigeben geht per Telegram oder Dashboard.",
    );
  });

  it("2 Aufträge wie in den Vorgaben", () => {
    assert.equal(
      freigabenHinweis([auftrag(12, "Mail an Müller AG"), auftrag(13, "Licht Büro aus")], "Sir"),
      "Es warten zwei Aufträge auf Ihre Freigabe, Sir: Nummer 12, Mail an Müller AG; Nummer 13, Licht Büro aus. Freigeben geht per Telegram oder Dashboard.",
    );
  });

  it("3 Aufträge: alle genannt, kein Rest", () => {
    const h = freigabenHinweis([auftrag(1, "A"), auftrag(2, "B"), auftrag(3, "C")], "Sir");
    assert.equal(h, "Es warten drei Aufträge auf Ihre Freigabe, Sir: Nummer 1, A; Nummer 2, B; Nummer 3, C. Freigeben geht per Telegram oder Dashboard.");
  });

  it("4 und 5 Aufträge: höchstens drei genannt, Rest gezählt", () => {
    const vier = freigabenHinweis([1, 2, 3, 4].map((n) => auftrag(n, `T${n}`)), "Sir");
    assert.match(vier, /^Es warten vier Aufträge .*Nummer 3, T3, und ein weiterer\. Freigeben/);
    const fuenf = freigabenHinweis([1, 2, 3, 4, 5].map((n) => auftrag(n, `T${n}`)), "Sir");
    assert.match(fuenf, /^Es warten fünf Aufträge .*Nummer 3, T3, und zwei weitere\. Freigeben/);
    assert.ok(!fuenf.includes("Nummer 4") && !fuenf.includes("T5"));
    const viele = freigabenHinweis(Array.from({ length: 15 }, (_, n) => auftrag(n + 1, `T${n + 1}`)), "Sir");
    assert.match(viele, /^Es warten 15 Aufträge .*und zwölf weitere\./);
    const zwanzig = freigabenHinweis(Array.from({ length: 20 }, (_, n) => auftrag(n + 1, `T${n + 1}`)), "Sir");
    assert.match(zwanzig, /^Es warten 20 Aufträge .*und 17 weitere\./);
  });

  it("nur offene zählen, erledigte dazwischen werden übersprungen", () => {
    const h = freigabenHinweis([auftrag(1, "A", "erledigt"), auftrag(2, "B"), auftrag(3, "C", "fehler")], "Sir");
    assert.equal(h, "Ein Auftrag wartet auf Ihre Freigabe, Sir: Nummer 2, B. Freigeben geht per Telegram oder Dashboard.");
  });

  it("Kürzung: höchstens 60 Zeichen, an der Wortgrenze, ohne Markdown und Links", () => {
    const lang = "Mail an die Müller AG wegen der Offerte für die Zutrittskontrolle im dritten Stock und der Videoanlage";
    const k = kurzFuerStimme(lang);
    assert.ok(k.length <= HINWEIS_MAX_ZEICHEN, `${k.length} Zeichen`);
    assert.ok(k.endsWith("…"));
    assert.ok(lang.startsWith(k.slice(0, -1)), "an einer Wortgrenze abgeschnitten");
    assert.ok(!/\s…$/.test(k));
    assert.equal(kurzFuerStimme("**Mail** an https://x.ch/offerte senden."), "Mail an Link senden");
    const genau = "x".repeat(60);
    assert.equal(kurzFuerStimme(genau), genau);
    assert.equal(kurzFuerStimme("y".repeat(61)), `${"y".repeat(59)}…`, "ohne Leerzeichen hart gekürzt");
    const h = freigabenHinweis([auftrag(9, lang)], "Sir");
    assert.ok(h.includes(`Nummer 9, ${k}.`));
  });

  it("Anrede, Du-Form und ohne Dashboard", () => {
    assert.match(freigabenHinweis([auftrag(1, "A")], "Chef"), /Freigabe, Chef: /);
    assert.match(freigabenHinweis([auftrag(1, "A")], "Sir", { form: "du" }), /auf deine Freigabe/);
    assert.match(freigabenHinweis([auftrag(1, "A")], "Sir", { dashboard: false }), /Freigeben geht per Telegram\.$/);
  });

  it("leere Zusammenfassung → nur Nummer", () => {
    assert.match(freigabenHinweis([auftrag(4, "  ")], "Sir"), /Sir: Nummer 4\. Freigeben/);
  });
});

// =====================================================================
describe("istFreigabeWunsch", () => {
  it("Freigabe, Bestätigung oder Ausführung per Stimme wird erkannt", () => {
    for (const t of ["gib Auftrag 12 frei", "gib auftrag zwölf frei", "genehmige Auftrag 3", "Auftrag 5 freigeben", "bestätige die Freigabe",
      "führe den Auftrag aus", "erteile die Freigabe für Nummer 4", "kannst du auftrag 7 freigeben", "ist Auftrag 3 freizugeben",
      "gib alle aufträge frei", "genehmige alle offenen aufträge", "gib nummer siebzehn frei", "führe auftrag nummer 4 aus", "bestätige auftrag 8"]) {
      assert.equal(istFreigabeWunsch(t), true, t);
    }
  });

  it("gewöhnliche Fragen und Lesefragen gehen durch", () => {
    for (const t of ["wie wird das Wetter", "welche Aufträge sind offen", "gibt es offene freigaben", "was muss ich freigeben", "was ist heute in Basel los"]) {
      assert.equal(istFreigabeWunsch(t), false, t);
    }
  });

  it("Fragen zu Kundenaufträgen und Nummern gehen an Claude (Partizipien, Fragen, Dritte)", () => {
    for (const t of ["wann wird mein Auftrag bei Digitec ausgeführt", "bestätige mir die Nummer von Müller AG", "wann führt Digitec meinen Auftrag aus",
      "welche Nummer hat die Firma, die den Auftrag erteilt hat", "ist der Auftrag erlaubt", "hat die müller ag den auftrag bestätigt",
      "hat der kunde den auftrag erteilt", "wer hat den auftrag genehmigt", "ist der auftrag von meier schon freigegeben",
      "gib mir die nummer von müller frei", "wurde der auftrag von schmid bestätigt", "welche aufträge hat der kunde erteilt",
      "bestätige den auftrag von müller"]) {
      assert.equal(istFreigabeWunsch(t), false, t);
    }
  });
});

// =====================================================================
describe("Interaction-Model", () => {
  const roh = readFileSync(join(projekt, "alexa/interaction-model.json"), "utf8");
  const modell = JSON.parse(roh) as { interactionModel: { languageModel: { invocationName: string; intents: { name: string; samples: string[]; slots?: unknown[] }[] } } };
  const intents = modell.interactionModel.languageModel.intents;

  it("bleibt gültiges JSON und enthält FreigabenIntent mit mindestens 6 Beispielsätzen", () => {
    const f = intents.find((i) => i.name === "FreigabenIntent");
    assert.ok(f, "FreigabenIntent fehlt");
    assert.ok(f.samples.length >= 6);
    assert.deepEqual(f.slots ?? [], []);
    for (const s of f.samples) assert.match(s, /^[a-zäöü ]+$/, `Beispielsatz «${s}» nur Kleinbuchstaben ohne Satzzeichen`);
    assert.ok(f.samples.some((s) => /aufträg/.test(s)) && f.samples.some((s) => /freigabe/.test(s)) && f.samples.includes("was wartet auf mich"));
  });

  it("Beispielsätze eindeutig über alle Intents, alle Handler-Intents vorhanden", () => {
    const alle = intents.flatMap((i) => i.samples);
    assert.equal(new Set(alle).size, alle.length, "doppelter Beispielsatz");
    const namen = intents.map((i) => i.name);
    for (const n of ["CardioIntent", "BriefingIntent", "FreigabenIntent", "FrageIntent", "AMAZON.HelpIntent", "AMAZON.FallbackIntent", "AMAZON.StopIntent", "AMAZON.CancelIntent"]) {
      assert.ok(namen.includes(n), n);
    }
    assert.equal(modell.interactionModel.languageModel.invocationName, "butler jarvis");
  });
});

// =====================================================================
describe("Skill-Handler (ohne Netz)", () => {
  const SKILL = "amzn1.ask.skill.00000000-0000-0000-0000-000000000000";
  const skill = buildSkill(SKILL);

  type Antwort = { response: { outputSpeech?: { ssml: string }; reprompt?: { outputSpeech: { ssml: string } }; shouldEndSession?: boolean } };
  const anfrage = (request: Record<string, unknown>, applicationId = SKILL) => ({
    version: "1.0",
    session: { new: true, sessionId: "amzn1.echo-api.session.test", application: { applicationId }, user: { userId: "amzn1.ask.account.test" } },
    context: {
      System: {
        application: { applicationId },
        user: { userId: "amzn1.ask.account.test" },
        device: { deviceId: "amzn1.ask.device.test", supportedInterfaces: {} },
        apiEndpoint: "https://api.eu.amazonalexa.com",
      },
    },
    request: { requestId: "amzn1.echo-api.request.test", timestamp: "2026-10-11T06:00:00Z", locale: "de-DE", ...request },
  });
  const intent = (name: string, slots: Record<string, { name: string; value?: string }> = {}) =>
    anfrage({ type: "IntentRequest", intent: { name, confirmationStatus: "NONE", slots } });
  const rufe = async (env: ReturnType<typeof anfrage>) => (await skill.invoke(env as never)) as unknown as Antwort;
  const sprache = (a: Antwort) => a.response.outputSpeech?.ssml ?? "";

  beforeEach(() => {
    aufrufe.length = 0;
    auftraege.length = 0;
    saveAuftraege();
    state.mode = "normal";
    _testOptionen.jetzt = () => um(12, 0);
    const d = day();
    d.briefing = { text: "Guten Morgen, Sir. Zwei Termine, kein Regen.", builtAt: new Date().toISOString() };
    d.briefingDelivered = false;
    d.cardioDelivered = true;
    save();
  });

  it("FreigabenIntent ohne offene Aufträge", async () => {
    const a = await rufe(intent("FreigabenIntent"));
    assert.equal(sprache(a), "<speak>Nichts wartet auf Sie, Sir.</speak>");
    assert.equal(a.response.shouldEndSession, true);
    assert.equal(aufrufe.length, 0);
  });

  it("FreigabenIntent liest vor, escaped Zusammenfassungen und gibt nichts frei", async () => {
    auftraege.push(auftrag(12, "Mail an Müller & Co"), auftrag(13, `Licht aus<audio src="https://x.ch/a.mp3"/>`), auftrag(14, "Alt", "erledigt"));
    saveAuftraege();
    const vorher = readFileSync("data/auftraege.json", "utf8");
    const s = sprache(await rufe(intent("FreigabenIntent")));
    assert.ok(s.startsWith("<speak>Es warten zwei Aufträge auf Ihre Freigabe, Sir: Nummer 12, Mail an Müller &amp; Co; Nummer 13, Licht aus&lt;audio"));
    assert.ok(!s.includes("<audio"), "kein eingeschleuster Tag");
    assert.ok(s.endsWith("Freigeben geht per Telegram oder Dashboard.</speak>"));
    assert.deepEqual(auftraege.map((x) => x.status), ["offen", "offen", "erledigt"]);
    assert.equal(readFileSync("data/auftraege.json", "utf8"), vorher, "Warteschlange unverändert");
    assert.equal(aufrufe.length, 0);
  });

  it("Nachtstimme: Nachtmodus und Fenster machen leise, mittags normal", async () => {
    assert.ok(!sprache(await rufe(intent("FreigabenIntent"))).includes("<prosody"));
    state.mode = "nacht";
    assert.equal(sprache(await rufe(intent("FreigabenIntent"))), '<speak><prosody volume="soft" rate="95%">Nichts wartet auf Sie, Sir.</prosody></speak>');
    state.mode = "normal";
    _testOptionen.jetzt = () => um(23, 30);
    assert.ok(sprache(await rufe(intent("FreigabenIntent"))).includes('<prosody volume="soft" rate="95%">'));
    _testOptionen.jetzt = () => um(6, 30);
    assert.ok(!sprache(await rufe(intent("FreigabenIntent"))).includes("<prosody"));
  });

  it("Nachfrage (reprompt) läuft ebenfalls leise", async () => {
    state.mode = "nacht";
    const a = await rufe(intent("AMAZON.HelpIntent"));
    assert.ok(a.response.reprompt?.outputSpeech.ssml.includes("<prosody"));
    assert.ok(sprache(a).includes("<prosody"));
  });

  it("Fallback und Hilfe: Freigaben nur per Telegram oder Dashboard", async () => {
    for (const name of ["AMAZON.FallbackIntent", "AMAZON.HelpIntent"]) {
      const a = await rufe(intent(name));
      assert.match(sprache(a), /Freigaben nehme ich nur per Telegram oder Dashboard entgegen, Sir\./, name);
      assert.match(sprache(a), /offene Aufträge/);
      assert.ok(a.response.reprompt, `${name} hält die Sitzung offen`);
    }
    assert.equal(aufrufe.length, 0);
  });

  it("ohne JARVIS_EVENT_TOKEN kein Dashboard: Ablehnung nennt nur Telegram", async () => {
    const tokenVorher = config.eventToken;
    const dashboardVorher = config.dashboard;
    try {
      config.eventToken = undefined;
      config.dashboard = true;
      for (const name of ["AMAZON.FallbackIntent", "AMAZON.HelpIntent"]) {
        assert.match(sprache(await rufe(intent(name))), /Freigaben nehme ich nur per Telegram entgegen, Sir\./, name);
      }
      const s = sprache(await rufe(intent("FrageIntent", { frage: { name: "frage", value: "gib auftrag zwölf frei" } })));
      assert.ok(s.startsWith("<speak>Freigaben nehme ich nur per Telegram entgegen, Sir."), s);
      assert.ok(!s.includes("Dashboard"), s);
    } finally {
      config.eventToken = tokenVorher;
      config.dashboard = dashboardVorher;
    }
    assert.equal(aufrufe.length, 0);
  });

  it("Frage «gib Auftrag 12 frei» geht nicht an Claude und gibt nichts frei", async () => {
    auftraege.push(auftrag(12, "Mail an Müller AG"));
    saveAuftraege();
    const vorher = readFileSync("data/auftraege.json", "utf8");
    const a = await rufe(intent("FrageIntent", { frage: { name: "frage", value: "gib auftrag zwölf frei" } }));
    assert.equal(
      sprache(a),
      `<speak>Freigaben nehme ich nur per Telegram oder Dashboard entgegen, Sir.${PAUSE}Ein Auftrag wartet auf Ihre Freigabe, Sir: Nummer 12, Mail an Müller AG. Freigeben geht per Telegram oder Dashboard.</speak>`,
    );
    assert.equal(a.response.shouldEndSession, true);
    assert.equal(auftraege[0].status, "offen");
    assert.equal(readFileSync("data/auftraege.json", "utf8"), vorher, "Warteschlange unverändert");
    assert.equal(aufrufe.length, 0, "kein Aufruf an Claude oder Telegram");
  });

  it("Freigabe-Wunsch ohne offene Aufträge oder im Notaus: Ablehnung samt Stand, kein Inhalt im Notaus", async () => {
    const leer = sprache(await rufe(intent("FrageIntent", { frage: { name: "frage", value: "ist auftrag drei freizugeben" } })));
    assert.equal(leer, `<speak>Freigaben nehme ich nur per Telegram oder Dashboard entgegen, Sir.${PAUSE}Nichts wartet auf Sie, Sir.</speak>`);
    auftraege.push(auftrag(12, "Mail an Müller AG"));
    saveAuftraege();
    const pausiertVorher = state.paused;
    try {
      state.paused = true;
      const s = sprache(await rufe(intent("FrageIntent", { frage: { name: "frage", value: "gib auftrag zwölf frei" } })));
      assert.match(s, /^<speak>Freigaben nehme ich nur per Telegram oder Dashboard entgegen, Sir\.<break time="400ms"\/>Notaus aktiv, Sir\./);
      assert.ok(!s.includes("Müller"), "im Notaus keine Inhalte");
    } finally {
      state.paused = pausiertVorher;
    }
    assert.equal(auftraege[0].status, "offen");
    assert.equal(aufrufe.length, 0);
  });

  it("Frage ohne Slot: «Ich höre.» mit Nachfrage", async () => {
    const a = await rufe(intent("FrageIntent", { frage: { name: "frage" } }));
    assert.equal(sprache(a), "<speak>Ich höre.</speak>");
    assert.equal(a.response.reprompt?.outputSpeech.ssml, "<speak>Ich höre.</speak>");
  });

  it("Briefing: Pause vor dem Hinweis nur bei Alexa; Telegram-Text ohne SSML", async () => {
    auftraege.push(auftrag(12, "Mail an Müller & Co"), auftrag(13, `Licht <break time="10s"/> aus`));
    saveAuftraege();
    const s = sprache(await rufe(intent("BriefingIntent")));
    assert.ok(s.startsWith(`<speak>Guten Morgen, Sir. Zwei Termine, kein Regen.${PAUSE}Es warten zwei Aufträge`), s);
    assert.equal(s.match(/<break/g)?.length, 1, "nur die eigene Pause");
    assert.ok(s.includes("Licht &lt;break time=&quot;10s&quot;/ aus"), "forSpeech nimmt das >, der Rest ist escaped");

    await durchlaufen();
    await durchlaufen();
    const tg = aufrufe.filter((x) => x.url.endsWith("/sendMessage"));
    assert.equal(tg.length, 1);
    const text = (JSON.parse(tg[0].body) as { text: string }).text;
    assert.equal(text, "Guten Morgen, Sir. Zwei Termine, kein Regen.\n\nEs warten zwei Aufträge auf Ihre Freigabe, Sir: Nummer 12, Mail an Müller & Co; Nummer 13, Licht <break time=\"10s\"/ aus. Freigeben geht per Telegram oder Dashboard.");
    assert.ok(!text.includes(PAUSE) && !text.includes("<speak") && !text.includes("&amp;") && !text.includes("<prosody"));
    assert.equal(day().briefingDelivered, true);
  });

  it("briefingText (Telegram/TTS) ohne offene Aufträge bleibt das reine Briefing", async () => {
    day().briefingDelivered = true;
    assert.equal(await briefingText(), "Guten Morgen, Sir. Zwei Termine, kein Regen.");
    auftraege.push(auftrag(3, "Licht aus"));
    assert.equal(await briefingText(), "Guten Morgen, Sir. Zwei Termine, kein Regen.\n\nEin Auftrag wartet auf Ihre Freigabe, Sir: Nummer 3, Licht aus. Freigeben geht per Telegram oder Dashboard.");
    assert.equal(aufrufe.length, 0, "schon zugestellt: kein Versand");
  });

  it("Launch nach dem Morgenteil: Briefing mit Hinweis; ohne offene Aufträge keine Pause", async () => {
    day().briefingDelivered = true;
    const ohne = sprache(await rufe(anfrage({ type: "LaunchRequest" })));
    assert.equal(ohne, "<speak>Guten Morgen, Sir. Zwei Termine, kein Regen.</speak>");
    auftraege.push(auftrag(5, "Licht aus"));
    const mit = sprache(await rufe(anfrage({ type: "LaunchRequest" })));
    assert.ok(mit.includes(`${PAUSE}Ein Auftrag wartet`));
  });

  it("Stop und SessionEnded", async () => {
    const stop = await rufe(intent("AMAZON.StopIntent"));
    assert.equal(sprache(stop), "<speak>Wie Sie wünschen, Sir.</speak>");
    const ende = await rufe(anfrage({ type: "SessionEndedRequest", reason: "USER_INITIATED" }));
    assert.equal(ende.response.outputSpeech, undefined);
  });

  it("Anfragen eines fremden Skills werden abgewiesen", async () => {
    await assert.rejects(skill.invoke(anfrage({ type: "LaunchRequest" }, "amzn1.ask.skill.fremd") as never));
  });
});
