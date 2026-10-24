import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { audit, throttled } from "./audit.js";
import { basename } from "node:path";
import { addSystemNote, handleMessage, pausiertText, resetHistory, runAuftrag, stufeVerschaerft } from "./agent.js";
import { config } from "./config.js";
import { AUFTRAEGE_UNLESBAR, auftraegeNichtGeladen, getAuftrag, offeneAuftraege, saveAuftraege, setStatus, type Auftrag } from "./queue.js";
import { save, state, zustandsHinweis, type Mode } from "./state.js";
import { activeTools, ERINNERUNGEN_UNLESBAR, erinnerungenNichtGeladen, reminders, saveReminders } from "./tools.js";
import { ZEITPLAENE_UNLESBAR, zeitplaeneNichtGeladen } from "./zeitplaene.js";
import { forSpeech, speak, transcribe } from "./voice.js";
import { safePath } from "./workspace.js";
import { camerasNichtGeladen, eventClip, WACHEN_UNLESBAR, wachenNichtGeladen } from "./cameras.js";
import { listVorgaenge, startVorgang, VORGAENGE_UNLESBAR, vorgaengeNichtGeladen } from "./vorgaenge.js";
import { verbrauchBericht } from "./claude.js";
import { aufheben, ausloesen, notfallAktiv } from "./notfall.js";
import { createAuftrag } from "./queue.js";
import { protokollFesthalten, protokolle, protokollGesperrt, protokollNamens, runProtokoll } from "./protokolle.js";
import { formatBefund, selbsttest } from "./check.js";
import { abuseSignal } from "./notfall.js";
import { HttpFehler, fehlerArt, fehlerDetail, gesundheit, mitWiederholung, nutzerText, schwaerze, voruebergehend, wartezeit } from "./robust.js";
import { clock } from "./time.js";
import { berichtText, verdichteJetzt, vorschauText } from "./verdichtung.js";
import { eintragsHinweise, ladeListe, postausgangEintrag } from "./datei.js";
import { finanzUebersicht, RECHNUNGEN_UNLESBAR, rechnungen, rechnungenNichtGeladen, wochenberichtText } from "./finanzen.js";
import { PROFIL_UNLESBAR, profilNichtGeladen } from "./profil.js";

const API = () => `https://api.telegram.org/bot${config.telegramToken}`;
/** Ohne Token und Chat-ID geht nichts hinaus (sonst Aufrufe an …/botundefined) und nichts in den Postausgang. */
const eingerichtet = (): boolean => Boolean(config.telegramToken && config.telegramOwner);
const nichtEingerichtet = () => new HttpFehler("Telegram nicht eingerichtet (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)", 400);
/** Claude und die Verdichtung sind hier ersetzbar (Tests mit Attrappen); im Betrieb die echten Funktionen. */
export const abhaengigkeiten = { handleMessage, verdichteJetzt };
const owner = () => config.telegramOwner ?? "";
const log = (e: unknown) => console.error(e instanceof Error ? schwaerze(e.message) : e);

/** PIN-Vergleich in konstanter Zeit; über die Hashes, damit auch die Länge nichts verrät. Ohne JARVIS_PIN nie wahr. */
function pinStimmt(eingabe: string | undefined): boolean {
  if (!config.pin || eingabe === undefined) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(eingabe), h(config.pin));
}

/**
 * Zählt eine Eingabe während des PIN-Dialogs als PIN-Versuch? Befehle und Sätze mit Leerzeichen nicht, ausser die
 * PIN selbst sieht so aus. Sonst löste schon fünfmal «/auftraege» in fünf Minuten den Notfall aus.
 */
function pinVersuch(eingabe: string): boolean {
  const pin = config.pin ?? "";
  if (eingabe.startsWith("/") && !pin.startsWith("/")) return false;
  if (/\s/.test(eingabe) && !/\s/.test(pin)) return false;
  return true;
}

// ---------- PIN aus der Kommandozentrale ----------

/** Eigene Sperre fürs Dashboard: nach 3 Fehlversuchen (innert 10 Minuten) 10 Minuten lang keine PIN annehmen. */
const PIN_FEHLVERSUCHE_MAX = 3;
const PIN_SPERRE_MS = 10 * 60_000;
let pinUhr: () => number = () => Date.now();
const pinFehler: number[] = [];
let pinGesperrtBis = 0;

/** Nur für Tests: Uhr der Dashboard-PIN-Sperre ersetzen (ohne Argument: echte Zeit) und den Zähler leeren. */
export function setzePinUhr(uhr?: () => number): void {
  pinUhr = uhr ?? (() => Date.now());
  pinFehler.length = 0;
  pinGesperrtBis = 0;
}

/** Restdauer der Dashboard-PIN-Sperre in ms (0 = keine Sperre). */
export function pinSperreRest(): number {
  return Math.max(0, pinGesperrtBis - pinUhr());
}

export const pinGesperrtText = (): string =>
  `Zu viele falsche PIN-Eingaben, Sir. Die Kommandozentrale nimmt erst in ${Math.max(1, Math.ceil(pinSperreRest() / 60_000))} Minuten wieder eine PIN an.`;

/** Zählt einen Dashboard-Fehlversuch; beim dritten innert 10 Minuten greift die Sperre. */
function dashboardPinFehlversuch(): void {
  const jetzt = pinUhr();
  pinFehler.push(jetzt);
  while (pinFehler.length && jetzt - pinFehler[0]! > PIN_SPERRE_MS) pinFehler.shift();
  if (pinFehler.length >= PIN_FEHLVERSUCHE_MAX) {
    pinFehler.length = 0;
    pinGesperrtBis = jetzt + PIN_SPERRE_MS;
    audit("pin_sperre", { quelle: "dashboard", minuten: PIN_SPERRE_MS / 60_000 });
    void sendeSpaeter("⚠️ Dreimal falsche PIN in der Kommandozentrale. Dort nehme ich zehn Minuten lang keine PIN an, Sir.").catch(log);
  }
}

export type PinErgebnis = "ok" | "falsch" | "gesperrt" | "ohne_pin";

/**
 * PIN-Prüfung für Dashboard-Aktionen ausser Freigaben (z. B. Notaus aufheben). Ein Fehlversuch zählt wie bei sensiblen
 * Freigaben: Audit, abuseSignal (5 in 5 Minuten → Notfall) und Warnung; dazu die eigene Dashboard-Sperre. Während der
 * Sperre wird auch eine richtige PIN abgewiesen (sonst wäre die Sperre ein Orakel). Die PIN selbst geht nirgends hin.
 */
export function pinPruefen(pin: string | undefined, anlass: string): PinErgebnis {
  if (!config.pin) return "ohne_pin";
  if (pinSperreRest() > 0) return "gesperrt";
  if (pinStimmt(pin)) {
    pinFehler.length = 0;
    return "ok";
  }
  audit("pin_falsch", { anlass, quelle: "dashboard" });
  abuseSignal("pin");
  void sendeSpaeter(`⚠️ Falsche PIN in der Kommandozentrale (${anlass}), Sir.`).catch(log);
  dashboardPinFehlversuch();
  return "falsch";
}

// ---------- Notaus (Telegram /pause, /weiter und Kommandozentrale) ----------

export type NotausQuelle = "telegram" | "dashboard";

/**
 * Notaus an. Aus dem Dashboard zusätzlich notausVermerken (ein schon eingereihtes Telegram-/weiter hebt ihn nicht auf)
 * und eine Meldung mit Vorrang, damit der Chat davon weiss.
 */
export function notausAn(quelle: NotausQuelle): void {
  state.paused = true;
  save();
  audit("pause", { quelle });
  if (quelle === "dashboard") {
    notausVermerken();
    void sendeSpaeter("⛔ Notaus über die Kommandozentrale.", { vorrang: true }).catch(log);
  }
}

/** Notaus aus; im Notfall nicht (nur /entwarnung hebt dann auf). Rückgabe: aufgehoben? */
export function notausAus(quelle: NotausQuelle): boolean {
  if (notfallAktiv()) return false;
  state.paused = false;
  save();
  audit("weiter", { quelle });
  if (quelle === "dashboard") void sendeSpaeter("▶️ Weiter über die Kommandozentrale.").catch(log);
  return true;
}

/** Hinweis bei gesperrter Aktion: im Notfall hebt nur /entwarnung auf, nicht /weiter. */
const notausHinweis = (nachsatz = ""): string =>
  notfallAktiv() ? "🚨 Notfall aktiv, Sir. Erst /entwarnung." : `⛔ Notaus aktiv. Erst /weiter${nachsatz}.`;
const NOCHMAL_FREIGEBEN = ", dann nochmal freigeben";

// ---------- Senden ----------

interface TelegramAntwort<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/** Ein Aufruf der Bot-API. Fehler als HttpFehler mit Status (und Retry-After bei 429), damit robust.ts sie einordnen kann. */
async function api<T = unknown>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
  // client-Fehler: kein Wiederholen, keine Störungsmeldung
  if (!eingerichtet()) throw nichtEingerichtet();
  const isForm = body instanceof FormData;
  const res = await fetch(`${API()}/${method}`, {
    method: "POST",
    headers: isForm ? undefined : { "Content-Type": "application/json" },
    body: isForm ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(method === "getUpdates" ? 45_000 : 20_000),
  });
  // Erst lesen, dann parsen: ein Abbruch beim Lesen (Netz, Zeitlimit) bleibt ein Netzfehler und wird wiederholt,
  // nur ein Parsefehler wird zum HttpFehler mit Status.
  const roh = await res.text();
  let json: TelegramAntwort<T> | undefined;
  try {
    json = JSON.parse(roh) as TelegramAntwort<T>;
  } catch {
    json = undefined; // kein JSON (z. B. Proxy-Seite) → Status entscheidet
  }
  if (!json || typeof json !== "object") throw new HttpFehler(`HTTP ${res.status}, keine gültige Antwort (${method})`, res.status);
  if (!res.ok || !json.ok) {
    const status = typeof json.error_code === "number" ? json.error_code : res.status;
    const retryAfter = json.parameters?.retry_after;
    throw new HttpFehler(
      `${json.description ?? `HTTP ${status}`} (${method})`,
      status,
      typeof retryAfter === "number" && retryAfter > 0 ? retryAfter * 1000 : undefined,
    );
  }
  return json.result as T;
}

/** Zeit und Zufall sind injizierbar (Tests); im Betrieb echte Timer. */
let wartenFn: ((ms: number) => Promise<void>) | undefined;
let zufallFn: (() => number) | undefined;
/** Frist, wie lange eine Dashboard-Freigabe höchstens auf ihre Telegram-Meldung wartet (Tests: sofort ablaufen lassen). */
let fristFn: ((ms: number) => Promise<void>) | undefined;
export function setzeWarten(warten?: (ms: number) => Promise<void>, zufall?: () => number, frist?: (ms: number) => Promise<void>): void {
  wartenFn = warten;
  zufallFn = zufall;
  fristFn = frist;
}
const fristAblauf = (ms: number): Promise<void> =>
  fristFn ? fristFn(ms) : new Promise<void>((r) => setTimeout(r, ms).unref());

/**
 * Senden mit Wiederholung: 4 Versuche, 1 s → 15 s, nie bei client/auth (400 «chat not found», 401 Token ungültig).
 * `abbrechen` (Notaus) beendet die Wiederholungen mit dem letzten echten Fehler, auch wenn er während der Wartezeit kam.
 */
function apiRobust<T = unknown>(method: string, body: Record<string, unknown> | FormData, abbrechen?: () => boolean): Promise<T> {
  let letzter: unknown;
  const versuch = async (): Promise<T> => {
    if (letzter !== undefined && abbrechen?.()) throw letzter;
    try {
      return await api<T>(method, body);
    } catch (e) {
      letzter = e;
      throw e;
    }
  };
  return mitWiederholung(`telegram.${method}`, versuch, {
    versuche: 4,
    basisMs: 1000,
    maxMs: 15_000,
    komponente: "telegram",
    warten: wartenFn,
    zufall: zufallFn,
    wiederholen: (e) => voruebergehend(e) && !abbrechen?.(),
  });
}

type Teilversand = { ok: true; messageId?: number } | { ok: false; fehler: unknown; rest: string; abgebrochen?: true };

/**
 * Sendet in 4000er-Teilen und merkt sich, wie weit es kam: scheitert ein Teil, liefert es den Fehler und den Text
 * ab diesem Teil, damit der Postausgang schon zugestellte Teile nicht ein zweites Mal schickt.
 * `abbrechen` wird vor jedem Teil geprüft: ein Notaus während eines langen Versands hält die übrigen Teile zurück.
 */
async function sendeTeile(text: string, extra: Record<string, unknown> = {}, abbrechen?: () => boolean): Promise<Teilversand> {
  let messageId: number | undefined;
  for (let i = 0; i < text.length; i += 4000) {
    if (abbrechen?.()) return { ok: false, fehler: new Error("Notaus"), rest: text.slice(i), abgebrochen: true };
    try {
      const r = await apiRobust<{ message_id: number }>("sendMessage", { chat_id: owner(), text: text.slice(i, i + 4000), ...extra }, abbrechen);
      messageId = r.message_id;
    } catch (fehler) {
      return { ok: false, fehler, rest: text.slice(i) };
    }
  }
  return { ok: true, messageId };
}

export async function sendText(text: string, extra: Record<string, unknown> = {}): Promise<number | undefined> {
  const r = await sendeTeile(text, extra);
  if (!r.ok) throw r.fehler;
  return r.messageId;
}

// ---------- Postausgang ----------

const POSTAUSGANG_FILE = "data/postausgang.json";
const POSTAUSGANG_MAX = 100;

interface Postausgang {
  /** Zeitpunkt, zu dem die Nachricht ursprünglich fällig war (ISO) */
  ts: string;
  text: string;
  /** Notfall-Alarm, Freigabe-Ergebnis: fliegt beim Kürzen nie vor gewöhnlichen Einträgen raus */
  vorrang?: true;
}

// Ungültige Einträge (kein Text, kein lesbarer Zeitpunkt) fallen beim Laden weg, mit Sicherung und Hinweis (postausgangEintrag)
const postausgangGeladen = ladeListe<Postausgang>(POSTAUSGANG_FILE, "Postausgang", postausgangEintrag);
/**
 * true, wenn data/postausgang.json vorhanden, aber unlesbar war (Sicherung .defekt). Anders als bei den übrigen Dateien
 * wirft das Speichern dann nicht – sonst ginge jede Meldung bei einer Störung verloren. Neue Einträge warten nur im
 * Speicher, die Datei bleibt unberührt, bis sie repariert ist und Jarvis neu startet.
 */
export const postausgangNichtGeladen = postausgangGeladen.nichtGeladen;
export const POSTAUSGANG_UNLESBAR =
  "⚠️ data/postausgang.json war beim Start unlesbar, Sir (Sicherung, sofern möglich, unter data/postausgang.json.defekt). Was dort auf Zustellung wartete, kommt nicht; neue Meldungen warten bis zum Neustart nur im Speicher.";

const postausgang: Postausgang[] = postausgangGeladen.liste;

function speicherePostausgang(): void {
  if (postausgangNichtGeladen) return;
  mkdirSync("data", { recursive: true, mode: 0o700 });
  writeFileSync(`${POSTAUSGANG_FILE}.tmp`, JSON.stringify(postausgang, null, 2), { mode: 0o600 });
  renameSync(`${POSTAUSGANG_FILE}.tmp`, POSTAUSGANG_FILE);
}

/**
 * Auf die Höchstzahl kürzen: zuerst die ältesten gewöhnlichen Einträge. Vorrang-Einträge stehen vorn; ohne diese
 * Regel würfe das nächste ablegen() bei vollem Postausgang genau den Notfall-Alarm hinaus.
 */
function kuerzen(): void {
  while (postausgang.length > POSTAUSGANG_MAX) {
    let i = postausgang.findIndex((e) => !e.vorrang);
    if (i < 0) i = postausgang.reduce((alt, e, j) => (e.ts < postausgang[alt].ts ? j : alt), 0); // nur noch Vorrang: den ältesten
    postausgang.splice(i, 1);
  }
}

/** `faellig`: Zeitpunkt des Sendeauftrags, nicht des Scheiterns – sonst gälte eine vor dem Notfall fällige Nachricht als neu. */
function ablegen(text: string, faellig = new Date().toISOString()): void {
  postausgang.push({ ts: faellig, text });
  kuerzen();
  speicherePostausgang();
}

/**
 * Vor die gewöhnlichen Einträge einreihen (Vorrang), aber hinter ältere Vorrang-Einträge: sonst käme ein späteres
 * Freigabe-Ergebnis vor dem Notfall-Alarm an. Bei vollem Postausgang fliegen die ältesten übrigen Einträge raus, nicht dieser.
 */
function voranstellen(text: string, faellig = new Date().toISOString()): void {
  const i = postausgang.findIndex((e) => !e.vorrang);
  postausgang.splice(i < 0 ? postausgang.length : i, 0, { ts: faellig, text, vorrang: true });
  kuerzen();
  speicherePostausgang();
}

/** Im Notfall darf nur hinaus, was mit Vorrang nach der Auslösung fällig wurde (der Alarm, die neutrale Freigabe-Meldung). */
function imNotfallErlaubt(e: Postausgang): boolean {
  return !notfallAktiv() || (e.vorrang === true && e.ts >= (state.notfall?.seit ?? ""));
}

export interface SpaeterOptionen {
  /** Sofort senden, auch wenn etwas im Postausgang wartet; scheitert es, vorn statt hinten einreihen (Notfall, Antworten auf Freigaben). */
  vorrang?: boolean;
  /**
   * Der Text enthält Daten (Werkzeug- oder Vorgangsergebnis): im Notfall weder senden noch ablegen, und ein Notfall
   * während des Versands hält die übrigen Teile zurück. Nie für den Notfall-Alarm selbst setzen.
   */
  imNotfallZurueckhalten?: boolean;
}

/**
 * Sendet den Text; geht es trotz Wiederholung nicht, bleibt er im Postausgang liegen und wird nachgereicht.
 * Wartet bereits etwas im Postausgang, wird der Text hinten angereiht (Reihenfolge bleibt) – ausser mit Vorrang.
 * Nur ein client-Fehler (die Nachricht selbst ist unbrauchbar) wird weitergeworfen – Wiederholen hilft da nicht.
 */
export async function sendeSpaeter(text: string, optionen: SpaeterOptionen = {}): Promise<void> {
  await zustellen(text, optionen);
}

/**
 * Wie sendeSpaeter, meldet aber, ob der Text zugestellt bzw. abgelegt (true) oder im Notfall verworfen wurde (false).
 * Ohne Vorrang geht im Notfall nichts direkt hinaus, auch kein weiterer Teil: es bleibt bis /entwarnung im Postausgang.
 */
async function zustellen(text: string, optionen: SpaeterOptionen): Promise<boolean> {
  // Ohne Telegram weder senden noch ablegen: nachgereicht würde ohnehin nie (postausgangTick läuft nur mit Telegram)
  if (!eingerichtet()) return false;
  const faellig = new Date().toISOString();
  const zurueckhalten = optionen.imNotfallZurueckhalten ? notfallAktiv : undefined;
  if (zurueckhalten?.()) return false;
  if (!optionen.vorrang && (postausgang.length > 0 || notfallAktiv())) {
    ablegen(text, faellig);
    return true;
  }
  const r = await sendeTeile(text, {}, optionen.vorrang ? zurueckhalten : notfallAktiv);
  if (r.ok) return true;
  // Notfall kam während des Versands (auch während der Wiederholungen): Daten bleiben auch dem Postausgang fern
  if (zurueckhalten && (r.abgebrochen || zurueckhalten())) return false;
  if (!r.abgebrochen && fehlerArt(r.fehler) === "client") throw r.fehler;
  // nur der nicht zugestellte Rest; ein Rest ohne Vorrang wartet im Notfall auf /entwarnung (postausgangTick)
  if (optionen.vorrang) voranstellen(r.rest, faellig);
  else ablegen(r.rest, faellig);
  return true;
}

let nachreichenLaeuft = false;

/** Alle 60 s: Liegengebliebenes in Reihenfolge nachreichen, sobald Telegram wieder antwortet. */
export async function postausgangTick(): Promise<void> {
  // Ohne Telegram nichts verwerfen: der Eintrag wartet, bis Token und Chat-ID gesetzt sind
  if (nachreichenLaeuft || postausgang.length === 0 || !eingerichtet()) return;
  nachreichenLaeuft = true;
  try {
    while (postausgang.length > 0) {
      // Im Notfall nur den Alarm (Vorrang, nach der Auslösung fällig). Alles andere wartet auf /entwarnung.
      const e = notfallAktiv() ? postausgang.find(imNotfallErlaubt) : postausgang[0];
      if (!e) break;
      const volltext = `(nachgereicht, ${clock(new Date(e.ts))}) ${e.text}`;
      // Ein Notfall mitten im Nachreichen hält die übrigen Teile eines gewöhnlichen Eintrags zurück.
      const r = await sendeTeile(volltext, {}, () => !imNotfallErlaubt(e));
      if (!r.ok) {
        if (r.abgebrochen || fehlerArt(r.fehler) !== "client") {
          // weiterhin gestört → nächster Tick; schon zugestellte Teile fallen weg (Präfix liegt immer im ersten Teil)
          if (r.rest.length < volltext.length) {
            e.text = r.rest;
            speicherePostausgang();
          }
          break;
        }
        console.error(`Postausgang: Eintrag verworfen (${fehlerDetail(r.fehler)}).`);
      }
      // Den konkreten Eintrag entfernen, nicht blind das erste Element: während des Sendens kann ein
      // nebenläufiges sendeSpaeter bei vollem Postausgang die ältesten Einträge (auch e) gekürzt haben.
      const i = postausgang.indexOf(e);
      if (i >= 0) postausgang.splice(i, 1);
      speicherePostausgang();
    }
  } finally {
    nachreichenLaeuft = false;
  }
}

/**
 * Dateien, Bilder, Clips und Sprache sind immer Daten: im Notfall geht nichts davon hinaus, auch nicht, wenn er erst
 * während eines langen Abrufs (Clip, Kamerabild mit Beschreibung) kam. Geprüft unmittelbar vor dem Hochladen und
 * zwischen den Wiederholungen. Der Alarm selbst ist Text und läuft über sendeSpaeter.
 */
const NOTFALL_KEIN_UPLOAD = "Notfall aktiv, nichts gesendet.";
function hochladen(method: string, form: FormData): Promise<unknown> {
  if (notfallAktiv()) return Promise.reject(new Error(NOTFALL_KEIN_UPLOAD));
  return apiRobust(method, form, notfallAktiv);
}

export async function sendFile(path: string, caption?: string): Promise<void> {
  if (notfallAktiv()) throw new Error(NOTFALL_KEIN_UPLOAD);
  const full = safePath(path);
  const form = new FormData();
  form.append("chat_id", owner());
  if (caption) form.append("caption", caption.slice(0, 1000));
  // Nie über eine Verknüpfung lesen: zwischen safePath und dem Lesen könnte die Datei gegen einen Link getauscht sein
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let inhalt: Buffer;
  try {
    inhalt = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  form.append("document", new Blob([new Uint8Array(inhalt)]), basename(full));
  await hochladen("sendDocument", form);
}

export async function sendPhoto(image: Buffer, caption?: string, extra: Record<string, unknown> = {}): Promise<void> {
  const form = new FormData();
  form.append("chat_id", owner());
  if (caption) form.append("caption", caption.slice(0, 1000));
  for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  form.append("photo", new Blob([new Uint8Array(image)]), "bild.jpg");
  await hochladen("sendPhoto", form);
}

export async function sendVideo(video: Buffer, caption?: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", owner());
  if (caption) form.append("caption", caption.slice(0, 1000));
  form.append("video", new Blob([new Uint8Array(video)]), "clip.mp4");
  await hochladen("sendVideo", form);
}

async function sendVoice(audio: Buffer): Promise<void> {
  const form = new FormData();
  form.append("chat_id", owner());
  form.append("voice", new Blob([new Uint8Array(audio)]), "jarvis.ogg");
  await hochladen("sendVoice", form);
}

/** Antwort zusätzlich als Sprachnachricht, falls TTS eingerichtet ist */
export async function sendVoiceReply(text: string): Promise<void> {
  if (!config.tts || !config.telegramToken) return;
  await sendVoice(await speak(forSpeech(text))).catch(log);
}

/** Sprachnachricht des Nutzers laden */
async function downloadVoice(fileId: string): Promise<Buffer> {
  const file = await apiRobust<{ file_path: string }>("getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new HttpFehler(`Telegram-Datei HTTP ${res.status}`, res.status);
  return Buffer.from(await res.arrayBuffer());
}

const typing = () => api("sendChatAction", { chat_id: owner(), action: "typing" }).catch(() => undefined);

// ---------- Freigaben ----------

/** Höchstlänge einer Freigabe-Nachricht samt Kopf (wie sendeTeile; Telegram erlaubt 4096). */
const FREIGABE_TEIL_MAX = 4000;

/**
 * Kopf einer Freigabe-Nachricht, immer von Jarvis erzeugt, nie aus der Zusammenfassung. Bei mehreren Teilen trägt
 * jeder Teil Nummer, Stufe und PIN-Hinweis; der letzte (mit den Knöpfen) verweist auf den Anfang oben.
 */
function freigabeKopf(a: Auftrag, teil?: { nr: number; von: number }): string {
  const sensibel = a.stufe === "sensibel";
  const pin = sensibel ? " · Freigabe mit PIN" : "";
  const letzter = teil !== undefined && teil.nr === teil.von;
  const icon = letzter ? "⬆️" : sensibel ? "🔴" : "🟠";
  const nummer = teil ? ` (Teil ${teil.nr}/${teil.von}${letzter ? ", Anfang oben" : ""})` : "";
  return `${icon} Auftrag #${a.id} · Stufe ${a.stufe}${pin}${nummer}`;
}

/**
 * Freigabe als Nachrichten zu höchstens 4000 Zeichen, jede mit eigenem Kopf. Sonst stünde unter den Knöpfen nur das
 * Ende der Zusammenfassung, und Text von Claude (Befehl, Mail) könnte dort einen eigenen, harmlosen Kopf vortäuschen.
 */
function freigabeTeile(a: Auftrag): string[] {
  const ganz = `${freigabeKopf(a)}\n\n${a.summary}`;
  if (ganz.length <= FREIGABE_TEIL_MAX) return [ganz];
  // Der Kopf wächst mit der Teilzahl: zerlegen, bis jeder Teil samt Kopf passt
  for (let platz = FREIGABE_TEIL_MAX - freigabeKopf(a, { nr: 2, von: 2 }).length - 2; ; platz -= 4) {
    const stuecke: string[] = [];
    for (let i = 0; i < a.summary.length; ) {
      let ende = Math.min(i + platz, a.summary.length);
      // Nie ein Zeichen aus zwei Hälften (Emoji) zerteilen: Telegram wiese die Nachricht ab
      if (ende < a.summary.length && /[\uD800-\uDBFF]/.test(a.summary[ende - 1]!)) ende--;
      stuecke.push(a.summary.slice(i, ende));
      i = ende;
    }
    const teile = stuecke.map((s, k) => `${freigabeKopf(a, { nr: k + 1, von: stuecke.length })}\n\n${s}`);
    if (teile.every((t) => t.length <= FREIGABE_TEIL_MAX)) return teile;
  }
}

/** Neutral, ohne Inhalt: darf auch im Notfall hinaus (wie /auftraege im Notfall). */
const wartetImNotfall = (ids: number[]): string =>
  `🚨 Notfall aktiv. Offene Aufträge: ${ids.length} (${ids.map((id) => `#${id}`).join(", ")}). Inhalte erst nach /entwarnung, Sir.`;

/**
 * Sendet die Freigabe Teil für Teil. Vor jedem Teil und zwischen den Wiederholungen gilt: Notfall aktiv → kein weiterer
 * Teil mit Inhalt (Mailtext, Befehl) in einen womöglich übernommenen Chat, keine Knöpfe, keine messageId. Rückgabe
 * false, wenn deshalb zurückgehalten; mit `melden` geht dann nur die neutrale Meldung hinaus.
 */
async function sendAuftrag(a: Auftrag, melden = true): Promise<boolean> {
  const teile = freigabeTeile(a);
  const knoepfe = {
    reply_markup: { inline_keyboard: [[{ text: "✅ Freigeben", callback_data: `ok:${a.id}` }, { text: "❌ Ablehnen", callback_data: `nein:${a.id}` }]] },
  };
  for (let k = 0; k < teile.length; k++) {
    // Knöpfe nur unter dem letzten Teil: onCallback lässt nur die zuletzt gesendete Nachricht (a.messageId) gelten
    const letzter = k === teile.length - 1;
    const r = await sendeTeile(teile[k]!, letzter ? knoepfe : {}, notfallAktiv);
    if (!r.ok) {
      if (r.abgebrochen || notfallAktiv()) {
        if (melden) {
          // Alle offenen nennen, nicht nur diesen (wie /auftraege im Notfall)
          const ids = offeneAuftraege().map((x) => x.id);
          if (!ids.includes(a.id)) ids.push(a.id);
          await sendText(wartetImNotfall(ids)).catch(log);
        }
        return false;
      }
      throw r.fehler;
    }
    if (letzter && r.messageId) {
      a.messageId = r.messageId;
      setStatus(a, a.status);
    }
  }
  return true;
}

export const hooks = { sendFile, sendPhoto, sendVideo, onAuftrag: async (a: Auftrag): Promise<void> => void (await sendAuftrag(a)) };

/** Aufträge, deren Werkzeug gerade läuft: der Status bleibt bis zum Ende «offen», darum braucht es diese Sperre. */
const inArbeit = new Set<number>();
/** Läuft das Werkzeug dieses Auftrags gerade? Begonnen (gestartetAm) und nicht in Arbeit heisst: Ergebnis unklar. */
export const auftragLaeuft = (id: number): boolean => inArbeit.has(id);
const laeuftBereits = (a: Auftrag) => `#${a.id} wird bereits ausgeführt, Sir.`;
/** Begonnen, aber nie abgeschlossen (Absturz mitten im Werkzeug): nicht nochmals ausführen, die Nebenwirkung kann schon eingetreten sein. */
const ergebnisUnklar = (a: Auftrag) => `#${a.id} wurde bereits gestartet, Ergebnis unklar – bitte prüfen, Sir.`;
/** Status-Text eines begonnenen Auftrags, den der Nutzer wegräumt (Telegram «Ablehnen», Dashboard «nein»). */
export const WEGGERAEUMT = "begonnen, Ergebnis unklar – vom Nutzer weggeräumt";

/**
 * Begonnen heisst: die Nebenwirkung (Mail, Schalten) kann eingetreten sein. Wegräumen setzt darum «fehler» statt
 * «abgelehnt», und Claude erfährt, dass er ihn nicht ungeprüft erneut vorschlagen soll (sonst doppelte Nebenwirkung).
 */
function wegraeumen(a: Auftrag, quelle: "telegram" | "dashboard"): string {
  pinVerwerfen(a.id);
  audit("auftrag_weggeraeumt", { id: a.id, tool: a.tool, quelle });
  setStatus(a, "fehler", WEGGERAEUMT);
  addSystemNote(`Auftrag #${a.id} (${a.tool}) wurde begonnen, das Ergebnis ist unklar; der Nutzer hat ihn weggeräumt. Nicht erneut vorschlagen, ohne dass der Nutzer geprüft hat, ob er ausgeführt wurde.`);
  return `🗂 #${a.id} weggeräumt, nicht abgelehnt: Er wurde begonnen, das Ergebnis ist unklar. Bitte selbst prüfen, ob es geschehen ist, Sir.`;
}

/**
 * Prüft Status und Notaus und beansprucht den Auftrag – synchron, ohne await dazwischen. Sonst führen zwei Freigaben
 * (Dashboard und Telegram-Knopf, Doppelklick) oder eine Freigabe nach einem inzwischen eingetroffenen Notaus doppelt
 * bzw. trotzdem aus. Liefert den Hinderungsgrund oder undefined (beansprucht).
 */
function beanspruche(a: Auftrag): string | undefined {
  const aktuell = getAuftrag(a.id) ?? a;
  if (aktuell.status !== "offen") return `#${a.id} ist bereits ${aktuell.status}.`;
  if (inArbeit.has(a.id)) return laeuftBereits(a);
  if (aktuell.gestartetAm) return ergebnisUnklar(a);
  if (state.paused) return notausHinweis(NOCHMAL_FREIGEBEN);
  // Angelegt als extern, inzwischen sensibel: ein Tippen ohne PIN darf ihn nicht ausführen
  const strenger = stufeVerschaerft(aktuell);
  if (strenger) {
    audit("auftrag_stufe_verschaerft", { id: a.id, tool: a.tool });
    try {
      setStatus(aktuell, "abgelehnt", "Stufe inzwischen sensibel – bitte neu beantragen");
      if (a !== aktuell) a.status = aktuell.status;
      addSystemNote(`Auftrag #${a.id} (${a.tool}) wurde nicht ausgeführt: Er gilt inzwischen als sensibel. Bei Bedarf neu beantragen.`);
    } catch (e) {
      log(e); // Nicht ausgeführt ist er so oder so
    }
    return strenger;
  }
  inArbeit.add(a.id);
  return undefined;
}

/**
 * Ausführung und Meldung getrennt: Ist das Werkzeug gelaufen, bleibt der Auftrag «erledigt», auch wenn Telegram
 * danach streikt – sonst hielte man ihn für gescheitert und gäbe ihn ein zweites Mal frei (doppelte Nebenwirkung).
 * Die Meldung geht mit Vorrang raus und landet bei Störung im Postausgang; execute wirft dadurch nicht.
 * Rückgabe: Hinderungsgrund, falls nicht ausgeführt (läuft schon, nicht mehr offen, Notaus), sonst undefined.
 * `meldungFristMs`: höchstens so lange auf die Meldung warten (Dashboard); ohne Angabe bis zum Ende (Telegram-Kette, Reihenfolge).
 */
async function execute(a: Auftrag, meldungFristMs?: number): Promise<string | undefined> {
  const hindernis = beanspruche(a);
  if (hindernis) return hindernis;
  let meldung = "";
  try {
    // Persistent vor dem Werkzeug: stürzt der Dienst mitten drin ab, führt eine erneute Freigabe es nicht ein zweites Mal aus.
    const gespeichert = getAuftrag(a.id);
    const ziele = gespeichert && gespeichert !== a ? [a, gespeichert] : [a];
    const jetzt = new Date().toISOString();
    for (const z of ziele) z.gestartetAm = jetzt;
    try {
      saveAuftraege();
    } catch (e) {
      // Ohne gespeicherten Startvermerk nicht ausführen: lieber nochmals freigeben als nach einem Absturz doppelt.
      for (const z of ziele) delete z.gestartetAm;
      log(e);
      return `#${a.id} nicht gestartet: Der Auftrag liess sich nicht speichern, Sir.`;
    }
    let result: string | undefined;
    try {
      result = await runAuftrag(a, hooks);
    } catch (e) {
      const msg = schwaerze(e instanceof Error ? e.message : String(e));
      setStatus(a, "fehler", msg);
      addSystemNote(`Auftrag #${a.id} (${a.tool}) wurde freigegeben, schlug aber fehl: ${msg}`);
      meldung = `⚠️ #${a.id} fehlgeschlagen: ${msg}`;
    }
    if (result !== undefined) {
      setStatus(a, "erledigt", result);
      addSystemNote(`Auftrag #${a.id} (${a.tool}) wurde freigegeben und ausgeführt: ${result}`);
      meldung = `✅ #${a.id} erledigt: ${result}`;
    }
  } finally {
    inArbeit.delete(a.id);
  }
  // Notfall kam, während das Werkzeug lief: Ergebnis und Fehlertext bleiben drin (womöglich kompromittierter Chat).
  const versand = (
    notfallAktiv()
      ? sendeSpaeter(zurueckgehalten(a), { vorrang: true })
      : sendeSpaeter(meldung, { vorrang: true, imNotfallZurueckhalten: true })
  ).catch(log);
  if (meldungFristMs === undefined) await versand;
  else await Promise.race([versand, fristAblauf(meldungFristMs)]);
  return undefined;
}

const zurueckgehalten = (a: Auftrag) => `⏸ #${a.id} lief noch zu Ende; Ergebnis wegen Notfall zurückgehalten, Sir.`;
/** Die Dashboard-Antwort wartet höchstens so lange auf die Telegram-Meldung; sie geht danach im Hintergrund weiter. */
const DASHBOARD_MELDUNG_FRIST_MS = 2000;

/** Knöpfe unter der Freigabe-Nachricht entfernen – ohne darauf zu warten: das Senden mit Wiederholung kann Minuten dauern. */
function knoepfeEntfernen(messageId: number): void {
  void apiRobust("editMessageReplyMarkup", { chat_id: owner(), message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
}

/** Frist der PIN-Abfrage, ebenso der Schutz danach (verfallene Abfrage) */
const PIN_FRIST_MS = 2 * 60_000;
/** Wartet auf die PIN für einen sensiblen Auftrag */
let pendingPin: { id: number; until: number } | undefined;
/**
 * Abfrage verfallen (anderswo entschieden oder Frist abgelaufen): Die nächste Nachricht innert einer neuen Frist kann
 * trotzdem die (vertippte, verspätete) PIN sein. Sie gehört weder in den Chat noch an Claude oder zum STT-Anbieter.
 */
let pinVerfallen: { id: number; until: number; grund: "entschieden" | "abgelaufen" } | undefined;
/** Entschieden anderswo (Dashboard): die wartende PIN-Abfrage verfällt, sonst verschluckte sie die nächste Nachricht. */
function pinVerwerfen(id: number): void {
  if (pendingPin?.id !== id) return;
  // Neue Frist ab der Entscheidung, nicht die Restzeit der Abfrage
  pinVerfallen = { id, until: Date.now() + PIN_FRIST_MS, grund: "entschieden" };
  pendingPin = undefined;
}
/**
 * Frist abgelaufen: wie verfallen behandeln, damit eine verspätete (auch vertippte) PIN nicht an Claude geht. Geprüft
 * erst bei der nächsten Nachricht, darum gilt der Schutz ab dem Ablauf, nicht ab jetzt (Stunden später nicht mehr).
 */
function pinAblaufen(): void {
  if (!pendingPin || Date.now() <= pendingPin.until) return;
  pinVerfallen = { id: pendingPin.id, until: pendingPin.until + PIN_FRIST_MS, grund: "abgelaufen" };
  pendingPin = undefined;
}
/** Antwort auf eine PIN-artige Eingabe nach verfallener Abfrage; hängt nie davon ab, ob die Eingabe stimmt. */
function verfallenText(v: NonNullable<typeof pinVerfallen>, sprache: boolean): string {
  const nieSprechen = "Sprachnachricht gelöscht; die PIN bitte nie sprechen.";
  if (v.grund === "abgelaufen" && getAuftrag(v.id)?.status === "offen") {
    return sprache ? `Zeit abgelaufen, Sir. ${nieSprechen} /auftraege zeigt #${v.id} nochmal.` : `Zeit abgelaufen. /auftraege zeigt #${v.id} nochmal.`;
  }
  return `#${v.id} ist nicht mehr offen, Sir. ${sprache ? nieSprechen : "Nachricht gelöscht."}`;
}

/** Sieht die Eingabe nach einer (vertippten) PIN aus? Kein Befehl, kein Satz, kaum länger als die PIN. */
function pinAehnlich(eingabe: string): boolean {
  return eingabe.length > 0 && pinVersuch(eingabe) && eingabe.length <= Math.max(12, (config.pin ?? "").length + 2);
}

/**
 * Könnte die Eingabe die PIN sein? PIN-ähnlich, mindestens 4 Zeichen und von derselben Art (nur Ziffern; mit Ziffern;
 * ohne Ziffern). Die PIN selbst gehört immer dazu. Ohne wartende Abfrage bekommt alles davon dieselbe Antwort und
 * wird gleich gezählt; sonst verriete die Antwort, welche Eingabe die PIN ist.
 */
function pinFoermig(eingabe: string): boolean {
  const pin = config.pin;
  if (!pin || !pinAehnlich(eingabe) || eingabe.length < Math.min(4, pin.length)) return false;
  if (/^\d+$/.test(pin)) return /^\d+$/.test(eingabe);
  return /\d/.test(pin) === /\d/.test(eingabe);
}

/**
 * PIN-förmige Eingabe ohne wartende Abfrage: zählt als Missbrauch (5 in 5 Minuten → Notfall), richtig oder falsch.
 * Nicht bei einer PIN ohne Ziffern: sonst zählte jedes «Danke». Die gleiche Antwort verrät dort trotzdem nichts.
 */
function pinRatenZaehlen(eingabe: string): void {
  if (pinFoermig(eingabe) && /\d/.test(config.pin ?? "")) abuseSignal("pin");
}

/** Freigabe von einer anderen Oberfläche (Dashboard). Sensible Aufträge brauchen die PIN im selben Schritt. */
export async function approveAuftrag(a: Auftrag, pin?: string): Promise<string> {
  if (a.status !== "offen") return `#${a.id} ist bereits ${a.status}.`;
  if (inArbeit.has(a.id)) return laeuftBereits(a);
  if (a.gestartetAm) return ergebnisUnklar(a);
  if (state.paused) return notausHinweis();
  if (a.stufe === "sensibel") {
    if (!config.pin) return "Für sensible Aufträge fehlt eine PIN (JARVIS_PIN).";
    // Dashboard-Sperre: abweisen, ohne den Auftrag abzulehnen (er bleibt offen, auch in Telegram)
    if (pinSperreRest() > 0) return pinGesperrtText();
    if (!pinStimmt(pin)) {
      // Wie in Telegram: eine falsche PIN lehnt den Auftrag ab, sonst liesse sich die PIN durchprobieren.
      audit("pin_falsch", { id: a.id, tool: a.tool, quelle: "dashboard" });
      setStatus(a, "abgelehnt", "falsche PIN");
      pinVerwerfen(a.id);
      abuseSignal("pin");
      if (a.messageId) knoepfeEntfernen(a.messageId);
      void sendeSpaeter(`⚠️ Falsche PIN im Dashboard. #${a.id} abgelehnt, Sir.`).catch(log);
      dashboardPinFehlversuch();
      return `Falsche PIN. #${a.id} abgelehnt.`;
    }
    pinFehler.length = 0;
  }
  // Zwischen Prüfung und Ausführung kein await: execute beansprucht den Auftrag synchron.
  pinVerwerfen(a.id);
  if (a.messageId) knoepfeEntfernen(a.messageId);
  const hindernis = await execute(a, DASHBOARD_MELDUNG_FRIST_MS);
  if (hindernis) return hindernis;
  if (notfallAktiv()) return zurueckgehalten(a);
  const nachher = getAuftrag(a.id) ?? a; // execute hat den Status gesetzt
  return nachher.status === "erledigt" ? `✅ #${a.id} erledigt: ${nachher.result ?? ""}` : `⚠️ #${a.id}: ${nachher.result ?? "Fehler"}`;
}

export async function denyAuftrag(a: Auftrag): Promise<string> {
  if (a.status !== "offen") return `#${a.id} ist bereits ${a.status}.`;
  if (inArbeit.has(a.id)) return laeuftBereits(a);
  if ((getAuftrag(a.id) ?? a).gestartetAm) {
    const text = wegraeumen(a, "dashboard");
    if (a.messageId) knoepfeEntfernen(a.messageId);
    void sendeSpaeter(`${text} (Dashboard)`).catch(log);
    return text;
  }
  audit("auftrag_abgelehnt", { id: a.id, tool: a.tool, quelle: "dashboard" });
  setStatus(a, "abgelehnt");
  pinVerwerfen(a.id);
  addSystemNote(`Auftrag #${a.id} (${a.tool}) wurde vom Nutzer abgelehnt.`);
  // Wie beim Freigeben ohne Warten: bei gestörtem Telegram dauerten die Wiederholungen Minuten, und die Antwort ans
  // Dashboard bliebe so lange aus. Die Meldung geht über den Postausgang, also auch nach einer Störung noch hinaus.
  if (a.messageId) knoepfeEntfernen(a.messageId);
  void sendeSpaeter(`❌ #${a.id} abgelehnt (Dashboard).`).catch(log);
  return `❌ #${a.id} abgelehnt.`;
}

const VERALTETER_KNOPF = "Dieser Knopf ist veraltet, Sir. /auftraege zeigt die aktuellen.";

async function onCallback(cb: { id: string; data?: string; message?: { message_id: number } }): Promise<void> {
  // Kosmetik ohne Warten: bei gestörtem Senden dauerten die Wiederholungen sonst Minuten, und Kette und Freigabe stünden still.
  void apiRobust("answerCallbackQuery", { callback_query_id: cb.id }).catch(log);
  const [action, idStr] = (cb.data ?? "").split(":");
  if (action === "clip") {
    // Notfall: womöglich übernommenes Konto, keine Aufnahmen aus dem Haus
    if (notfallAktiv()) return void await sendText("Im Notfall gebe ich keine Aufnahmen heraus, Sir. Erst /entwarnung.");
    let clip: Buffer;
    try {
      clip = await eventClip(idStr ?? "");
    } catch (e) {
      return void await sendText(`Clip noch nicht da oder nicht gefunden (${schwaerze(e instanceof Error ? e.message : String(e))}).`);
    }
    // Der Download dauert bis zu einer Minute: kam der Notfall inzwischen, bleibt der Clip hier.
    if (notfallAktiv()) return void await sendText("Im Notfall gebe ich keine Aufnahmen heraus, Sir. Erst /entwarnung.");
    try {
      await sendVideo(clip, `🎬 Clip ${idStr}`);
    } catch (e) {
      await sendText(`Clip noch nicht da oder nicht gefunden (${schwaerze(e instanceof Error ? e.message : String(e))}).`);
    }
    return;
  }
  const a = getAuftrag(Number(idStr));
  if (!a) return void await sendText("Diesen Auftrag kenne ich nicht mehr.");
  if (cb.message) knoepfeEntfernen(cb.message.message_id);
  // Knopf unter einer anderen Nachricht als der zuletzt gesendeten Freigabe: veraltet (etwa ein Auftrag mit derselben
  // Nummer vor dem Ersetzen von data/auftraege.json). Nie freigeben, was unter einer anderen Zusammenfassung stand.
  // Ohne gemerkte messageId (Freigabe nie mit Knöpfen gesendet) gilt jeder Knopf als veraltet.
  if (cb.message && cb.message.message_id !== a.messageId) {
    audit("knopf_veraltet", { id: a.id, aktion: action });
    return void await sendText(VERALTETER_KNOPF);
  }
  if (a.status !== "offen") return void await sendText(`#${a.id} ist bereits ${a.status}.`);
  if (inArbeit.has(a.id)) return void await sendText(laeuftBereits(a));
  if (a.gestartetAm && action === "ok") return void await sendText(ergebnisUnklar(a));
  if (state.paused && action === "ok") return void await sendText(notausHinweis(NOCHMAL_FREIGEBEN));

  if (action === "nein") {
    if (a.gestartetAm) return void await sendText(wegraeumen(a, "telegram"));
    audit("auftrag_abgelehnt", { id: a.id, tool: a.tool });
    setStatus(a, "abgelehnt");
    addSystemNote(`Auftrag #${a.id} (${a.tool}) wurde vom Nutzer abgelehnt.`);
    return void await sendText(`❌ #${a.id} abgelehnt.`);
  }
  if (a.stufe === "sensibel") {
    if (!config.pin) return void await sendText("Für sensible Aufträge fehlt eine PIN: JARVIS_PIN in .env setzen.");
    pendingPin = { id: a.id, until: Date.now() + PIN_FRIST_MS };
    pinVerfallen = undefined;
    return void await sendText(`#${a.id} ist sensibel. PIN bitte, innerhalb von zwei Minuten.`);
  }
  const hindernis = await execute(a);
  if (hindernis) await sendText(hindernis);
}

// ---------- Befehle ----------

async function onCommand(cmd: string, arg: string): Promise<void> {
  switch (cmd) {
    case "/start":
    case "/hilfe":
      return void await sendText(
        "JARVIS, zu Diensten.\n\n/auftraege – offene Freigaben\n/vorgang <Auftrag> – grosse Aufgabe im Hintergrund, starkes Modell\n/vorgaenge – Stand der Vorgänge\n! vor einer Nachricht – starkes Modell für diese Antwort\n/modus normal|fokus|nacht\n/neu – Gespräch vergessen\n/pause – Notaus, /weiter hebt ihn auf\n/notfall – Angriff: alles sperren und alarmieren\n/protokoll <name> – Nacht, Abwesend, Werkstatt …\n/kosten – Tokenverbrauch heute und Monat\n/finanzen – Rechnungen: offen, überfällig, bezahlt, pro Monat (Zahlungen nur vorbereitet)\n/verdichten – Gedächtnis jetzt verdichten (/verdichten vorschau ändert nichts)\n/check – Selbsttest aller Anbindungen\n/status – was läuft",
      );
    case "/auftraege": {
      const offen = offeneAuftraege();
      // Leere Liste heisst hier nicht «keine Aufträge»: der Bestand liegt in der unlesbaren Datei
      if (offen.length === 0) return void await sendText(auftraegeNichtGeladen ? AUFTRAEGE_UNLESBAR : "Keine offenen Aufträge.");
      // Notfall: nur Anzahl und Nummern, keine Inhalte (Mailtexte, Termine) in einen womöglich kompromittierten Chat
      if (notfallAktiv()) return void await sendText(wartetImNotfall(offen.map((a) => a.id)));
      for (let k = 0; k < offen.length; k++) {
        // Vor jedem Auftrag erneut: ein Notfall mitten in der Liste hält die übrigen Inhalte zurück
        if (notfallAktiv() || !(await sendAuftrag(offen[k]!, false))) {
          return void await sendText(wartetImNotfall(offen.slice(k).map((a) => a.id)));
        }
      }
      return;
    }
    case "/modus": {
      const m = arg.trim().toLowerCase();
      if (!["normal", "fokus", "nacht"].includes(m)) return void await sendText(`Aktueller Modus: ${state.mode ?? "normal"}. Setzen mit /modus normal|fokus|nacht`);
      state.mode = m as Mode;
      save();
      return void await sendText(`Modus: ${m}.`);
    }
    case "/neu":
      resetHistory();
      return void await sendText("Gespräch vergessen. Clean Slate.");
    case "/vorgang": {
      if (!arg.trim()) return void await sendText("Benutzung: /vorgang <Auftrag>. Läuft im Hintergrund mit dem starken Modell; /vorgaenge zeigt den Stand.");
      // Notaus/Notfall: runLoop bräche sofort ab; kein Eintrag, keine Systemnotiz, keine nachgereichte Anhalte-Meldung.
      if (state.paused) return void await sendText(notausHinweis());
      if (vorgaengeNichtGeladen) return void await sendText(VORGAENGE_UNLESBAR);
      const v = startVorgang(arg.trim(), hooks);
      return void await sendText(`🧠 Vorgang #${v.id} gestartet. Fortschritt und Ergebnis folgen hier, der Chat bleibt währenddessen frei.`);
    }
    case "/vorgaenge":
      if (notfallAktiv()) return void await sendText("Im Notfall gebe ich keine Daten heraus, Sir. Erst /entwarnung.");
      return void await sendText(listVorgaenge());
    case "/kosten":
      return void await sendText(verbrauchBericht());
    case "/finanzen":
      // Notfall: womöglich kompromittierter Chat, keine Finanzdaten herausgeben
      if (notfallAktiv()) return void await sendText("Im Notfall gebe ich keine Finanzdaten heraus, Sir. Erst /entwarnung.");
      // Leere Liste heisst hier nicht «keine Rechnungen»: der Bestand liegt in der unlesbaren Datei.
      if (rechnungenNichtGeladen) return void await sendText(RECHNUNGEN_UNLESBAR);
      if (rechnungen.length === 0) return void await sendText("Noch keine Rechnungen erfasst, Sir. Nichts zu berichten.");
      return void await sendText(wochenberichtText(finanzUebersicht()));
    case "/protokoll": {
      const name = arg.trim().toLowerCase();
      // Nur eigene Einträge: «constructor» oder «__proto__» sind kein Protokoll
      const p = protokollNamens(name);
      if (!p) return void await sendText(`Protokolle: ${Object.keys(protokolle).join(", ") || "keine (protokolle.json)"}`);
      // Notaus: auch kein auto-Protokoll (dessen Werkzeuge liefen sonst an jeder Freigabe vorbei)
      if (state.paused) return void await sendText(notausHinweis());
      // Notfall: auch kein Auftrag für extern/sensibel anlegen
      const gesperrt = protokollGesperrt();
      if (gesperrt) return void await sendText(gesperrt);
      if (p.stufe === "auto") return void await sendText(await runProtokoll(name, hooks));
      // Leere Liste heisst nicht «keine Aufträge»: neue lege ich erst nach Reparatur und Neustart an
      if (auftraegeNichtGeladen) return void await sendText(AUFTRAEGE_UNLESBAR);
      let a: Auftrag;
      try {
        a = createAuftrag({ tool: "protokoll_ausfuehren", input: protokollFesthalten(name), stufe: p.stufe, summary: `Protokoll «${name}»: ${p.beschreibung}` });
      } catch (e) {
        // Etwa die Speicherkarte voll: nichts angelegt (createAuftrag nimmt alles zurück), und der Nutzer erfährt es
        log(e);
        return void await sendText(`Protokoll «${name}» nicht angelegt, Sir: ${schwaerze(e instanceof Error ? e.message : String(e))}`);
      }
      return void await sendAuftrag(a);
    }
    case "/notfall":
      await ausloesen("Manuell über Telegram ausgelöst.");
      return;
    case "/entwarnung":
      if (!notfallAktiv()) return void await sendText("Es ist kein Notfall aktiv.");
      aufheben();
      return void await sendText("✅ Entwarnung. Notfall aufgehoben, Jarvis läuft wieder. Denk daran, erneuerte Tokens einzutragen.");
    case "/pause":
      notausAn("telegram");
      return void await sendText("⛔ Notaus. Keine Werkzeuge, Zeitpläne oder Wachen, bis /weiter kommt. Offene Aufträge bleiben offen.");
    case "/weiter":
      // Im Notfall hebt nur /entwarnung den Notaus auf (bewusster Schritt mit Checkliste)
      if (!notausAus("telegram")) return void await sendText("Es läuft ein Notfall, Sir. Erst /entwarnung.");
      return void await sendText("▶️ Weiter geht's.");
    case "/verdichten":
      return verdichtenBefehl(arg.trim().toLowerCase());
    case "/check":
      // Notfall: der Selbsttest fragt alle Dienste mit womöglich kompromittierten Zugängen ab und nennt Anwesenheit,
      // Recovery, Termine und Chat-ID – nichts davon in einen womöglich übernommenen Chat.
      if (notfallAktiv()) return void await sendText("Im Notfall gebe ich keine Daten heraus, Sir. Erst /entwarnung.");
      await sendText("Prüfe alle Anbindungen …");
      return void await sendText(formatBefund(await selbsttest()));
    case "/status":
      // Notfall: keine Einzelheiten (Werkzeuge, Modus) in einen womöglich kompromittierten Chat
      if (notfallAktiv()) return void await sendText(`🚨 NOTFALL AKTIV\n${dateiHinweise().map((h) => `${h}\n`).join("")}Offene Aufträge: ${offeneAuftraege().length}\nAufheben nur mit /entwarnung.`);
      return void await sendText(
        `${notfallAktiv() ? "🚨 NOTFALL AKTIV\n" : state.paused ? "⛔ PAUSIERT\n" : ""}${dateiHinweise().map((h) => `${h}\n`).join("")}Modus: ${state.mode ?? "normal"}\nOffene Aufträge: ${offeneAuftraege().length}\nErinnerungen: ${reminders.length}\nWerkzeuge: ${activeTools().map((t) => t.name).join(", ")}`,
      );
    default:
      return void await sendText("Kenne ich nicht. /hilfe zeigt die Befehle.");
  }
}

/**
 * /verdichten [vorschau]: sofort verdichten (Bericht als Antwort) oder nur den Vorschlag zeigen.
 * Jedes Senden wird abgewartet und abgefangen: nach dem bis zu minutenlangen Modellaufruf kann Telegram gestört sein,
 * und ein verworfenes Promise würde zur unbehandelten Rejection (Absturz des Dienstes).
 */
async function verdichtenBefehl(arg: string): Promise<void> {
  if (arg && arg !== "vorschau") {
    await sendText("Benutzung: /verdichten oder /verdichten vorschau.");
    return;
  }
  if (state.paused) {
    await sendText(notausHinweis());
    return;
  }
  const vorschau = arg === "vorschau";
  await sendText(vorschau ? "Ich sehe mir an, was sich verdichten liesse …" : "Ich verdichte das Gedächtnis, einen Moment, Sir …");
  let r: Awaited<ReturnType<typeof abhaengigkeiten.verdichteJetzt>>;
  try {
    r = await abhaengigkeiten.verdichteJetzt({ nurVorschau: vorschau });
  } catch (e) {
    log(e);
    if (state.paused) {
      await sendText(pausiertText()).catch(log);
      return;
    }
    const antwort = voruebergehend(e) || fehlerArt(e) === "auth" ? nutzerText(e, "claude") : `Die Verdichtung ist fehlgeschlagen: ${schwaerze(e instanceof Error ? e.message : String(e))}`;
    await sendText(antwort).catch(log);
    return;
  }
  // Notaus oder Notfall kam während des Modellaufrufs: keine Profil-Fakten (Vorschau) und kein Fehlertext mehr in den
  // Chat. Der Bericht enthält nur Zahlen und geht über den Postausgang, der ihn im Notfall zurückhält.
  if (state.paused && !r.bericht) {
    await sendText(pausiertText()).catch(log);
    return;
  }
  if (vorschau && r.vorschau && r.eingabe) {
    // Ein Notaus während des Versands hält die übrigen Teile zurück.
    const v = await sendeTeile(`${vorschauText(r.vorschau, r.eingabe)}${r.fehler ? `\n\n⚠️ So würde ich ihn nicht anwenden – ${r.fehler}` : ""}`, {}, () => Boolean(state.paused));
    if (!v.ok && !v.abgebrochen) log(v.fehler);
    return;
  }
  if (r.fehler) {
    await sendText(`⚠️ ${r.fehler}`).catch(log);
    return;
  }
  // Die Verdichtung ist geschrieben: der Bericht darf bei einer Telegram-Störung nicht verloren gehen → Postausgang.
  if (r.bericht) {
    await sendeSpaeter(berichtText(r.bericht), { imNotfallZurueckhalten: true }).catch(log);
    return;
  }
  await sendText("Nichts zu verdichten, Sir. Das Gedächtnis ist bereits schlank.").catch(log);
}

// ---------- Eingehende Updates ----------

export interface Update {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string; voice?: { file_id: string; duration: number } };
  callback_query?: { id: string; data?: string; from: { id: number }; message?: { message_id: number } };
}

export async function handleUpdate(u: Update): Promise<void> {
  if (u.callback_query) {
    if (String(u.callback_query.from.id) !== owner()) return;
    return onCallback(u.callback_query);
  }
  const m = u.message;
  if (!m || (!m.text && !m.voice)) return;
  if (String(m.chat.id) !== owner()) {
    console.warn(`Nachricht von fremdem Chat ${m.chat.id} ignoriert.`);
    audit("fremder_chat", { chat: m.chat.id });
    abuseSignal("telegram");
    if (throttled(`fremd:${m.chat.id}`)) await sendText(`⚠️ Ein fremder Telegram-Chat (${m.chat.id}) hat mir geschrieben. Ich habe nicht geantwortet.`).catch(log);
    return;
  }
  // synchron beim Aufruf (vor jedem await), damit eingereihte Aufhebe-Befehle es sicher sehen
  if (istDringend(u)) letzterDringend = Math.max(letzterDringend, ankunftsnummer(u));
  // Inzwischen anderswo entschieden (Dashboard, «Ablehnen», gelöscht): die Abfrage verfällt. Ein Satz läuft normal
  // weiter; die PIN selbst oder eine PIN-artige Eingabe fangen die Abschnitte unten ab (verfallen).
  if (pendingPin && getAuftrag(pendingPin.id)?.status !== "offen") pinVerwerfen(pendingPin.id);
  // Abgelaufen verfällt ebenso: eine verspätete, vertippte PIN geht so weder an Claude noch in den Chat.
  pinAblaufen();
  // Gilt nur für die nächste Nachricht innert der Frist; /pause und /notfall laufen daneben und verbrauchen nichts.
  let verfallen: NonNullable<typeof pinVerfallen> | undefined;
  if (pinVerfallen && !istDringend(u)) {
    if (Date.now() <= pinVerfallen.until) verfallen = pinVerfallen;
    pinVerfallen = undefined;
  }

  let spoken = false;
  let text = (m.text ?? "").trim();
  if (m.voice) {
    if (!config.stt) return void await sendText("Sprachnachrichten kann ich erst verstehen, wenn STT_URL eingerichtet ist.");
    // Wartet eine PIN, ist die Sprachnachricht vermutlich die PIN: weder zum STT-Anbieter noch als Echo in den Chat.
    if (pendingPin && Date.now() <= pendingPin.until) {
      const id = pendingPin.id;
      pendingPin = undefined;
      await apiRobust("deleteMessage", { chat_id: owner(), message_id: m.message_id }).catch(() => undefined);
      return void await sendText(`Die PIN bitte tippen, Sir, nie sprechen. #${id} wartet nicht mehr; /auftraege zeigt ihn wieder.`);
    }
    // Abfrage eben verfallen: vermutlich die PIN dafür, also auch nicht zum STT-Anbieter
    if (verfallen !== undefined) {
      await apiRobust("deleteMessage", { chat_id: owner(), message_id: m.message_id }).catch(() => undefined);
      return void await sendText(verfallenText(verfallen, true));
    }
    if (m.voice.duration > 120) return void await sendText("Das ist mir zu lang, bitte unter zwei Minuten.");
    await typing();
    try {
      text = await transcribe(await downloadVoice(m.voice.file_id));
    } catch (e) {
      return void await sendText(`Konnte die Sprachnachricht nicht verstehen: ${schwaerze(e instanceof Error ? e.message : String(e))}`);
    }
    if (!text) return void await sendText("Da habe ich nichts verstanden.");
    spoken = true;
    // Etwas PIN-Förmiges gesprochen (ohne wartende Freigabe), richtig oder falsch: kein Echo, nie an Claude, gleiche
    // Antwort und gleich gezählt. Ein Satzzeichen am Ende (Spracherkennung) ändert daran nichts.
    const gesprochen = [text, text.replace(/[.!?,;:]+$/, "")].find(pinFoermig);
    if (gesprochen !== undefined) {
      pendingPin = undefined;
      await apiRobust("deleteMessage", { chat_id: owner(), message_id: m.message_id }).catch(() => undefined);
      audit("pin_gesprochen", {});
      pinRatenZaehlen(gesprochen);
      return void await sendText("Die PIN bitte tippen, Sir, nie sprechen. Sprachnachricht gelöscht.");
    }
    await sendText(`🎙 ${text}`);
  }

  // /weiter bzw. /entwarnung im Notaus ist nie die PIN: die wartende Freigabe verfällt (sie muss nach dem Notaus
  // ohnehin neu kommen), der Befehl läuft normal – sonst würde er gelöscht und der Notaus bliebe stehen.
  const ersterBefehl = text.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (pendingPin && state.paused && AUFHEBEND.has(ersterBefehl)) pendingPin = undefined;
  // Ein anderer Befehl (etwa /auftraege) ist ebenfalls kein PIN-Versuch: die Freigabe verfällt ohne Ablehnung und
  // ohne Missbrauchszählung, der Befehl läuft normal.
  if (pendingPin && !istDringend(u) && text.startsWith("/") && !pinVersuch(text)) {
    const id = pendingPin.id;
    pendingPin = undefined;
    if (ersterBefehl !== "/auftraege" && getAuftrag(id)?.status === "offen") {
      await sendText(`#${id} wartet nicht mehr auf die PIN, Sir. /auftraege zeigt ihn wieder.`).catch(log);
    }
  }
  // /pause und /notfall sind nie die PIN und greifen sofort; eine danach getippte PIN fängt der Notaus-Check unten ab.
  if (pendingPin && !istDringend(u)) {
    const p = pendingPin;
    pendingPin = undefined;
    await apiRobust("deleteMessage", { chat_id: owner(), message_id: m.message_id }).catch(() => undefined);
    const a = getAuftrag(p.id);
    if (!a || a.status !== "offen") return void await sendText("Dieser Auftrag ist nicht mehr offen.");
    if (Date.now() > p.until) return void await sendText(`Zeit abgelaufen. /auftraege zeigt #${a.id} nochmal.`);
    if (state.paused) return void await sendText(notausHinweis(NOCHMAL_FREIGEBEN));
    if (inArbeit.has(a.id)) return void await sendText(laeuftBereits(a));
    if (!pinStimmt(text)) {
      // Ein Satz statt der PIN: weder ablehnen noch als Missbrauch zählen. Gelöscht bleibt er trotzdem, er könnte
      // eine vertippte PIN enthalten, die weder in den Chat noch an Claude gehört.
      if (!pinVersuch(text)) {
        audit("pin_abgebrochen", { id: a.id, tool: a.tool });
        return void await sendText(`Das war keine PIN, Sir. #${a.id} wartet nicht mehr; /auftraege zeigt ihn wieder.`);
      }
      audit("pin_falsch", { id: a.id, tool: a.tool });
      setStatus(a, "abgelehnt", "falsche PIN");
      // Wie im Dashboard: zählt als Missbrauch, sonst liesse sich die PIN über /protokoll und den Knopf durchprobieren.
      abuseSignal("pin");
      return void await sendText(`Falsche PIN. #${a.id} abgelehnt.`);
    }
    const hindernis = await execute(a);
    if (hindernis) await sendText(hindernis);
    return;
  }

  // Ab hier wartet keine Abfrage. Die Antwort hängt nie davon ab, ob die Eingabe die PIN ist: sonst liesse sich die PIN
  // über den Chat ungezählt durchprobieren, bis die Antwort wechselt.
  // Abfrage eben verfallen und jetzt etwas PIN-Artiges (richtig, vertippt, verspätet): löschen, nie an Claude.
  if (verfallen !== undefined && pinAehnlich(text)) {
    await apiRobust("deleteMessage", { chat_id: owner(), message_id: m.message_id }).catch(() => undefined);
    audit("pin_verfallen", { id: verfallen.id, grund: verfallen.grund });
    pinRatenZaehlen(text);
    return void await sendText(verfallenText(verfallen, false));
  }
  // Ohne Abfrage etwas, das die PIN sein könnte (etwa die PIN nach einem Neustart erneut geliefert): löschen, nie an
  // Claude und in die Historie, gleich gezählt.
  if (pinFoermig(text)) {
    await apiRobust("deleteMessage", { chat_id: owner(), message_id: m.message_id }).catch(() => undefined);
    audit("pin_ohne_freigabe", {});
    pinRatenZaehlen(text);
    return void await sendText("Keine Freigabe wartet auf eine PIN, Sir. Nachricht gelöscht.");
  }

  if (text.startsWith("/")) {
    const [cmd, ...rest] = text.split(/\s+/);
    const befehl = cmd.toLowerCase();
    // Ein /weiter oder /entwarnung, das hinter einer Anfrage wartete, während ein später getipptes /pause oder /notfall
    // vorgezogen wurde, darf den Notaus nicht nachträglich aufheben: der zuletzt gegebene Befehl gilt.
    // Verglichen wird die Ankunftsreihenfolge, nicht die update_id (Telegram wählt sie nach einer Woche Ruhe neu und zufällig).
    if (AUFHEBEND.has(befehl) && ankunftsnummer(u) < letzterDringend) {
      return void await sendText(`${befehl} kam vor dem Notaus an und gilt nicht, Sir. Bitte erneut senden.`);
    }
    return onCommand(befehl, rest.join(" "));
  }

  const ticker = setInterval(typing, 4000);
  await typing();
  try {
    let reply: string;
    try {
      reply = await abhaengigkeiten.handleMessage(text, hooks);
    } catch (e) {
      log(e);
      // Notaus kam während der Claude-Anfrage (claudeAufruf bricht dann die Wiederholungen ab): der Pausenhinweis
      // statt «dreimal versucht – bitte nochmals», denn ein neuer Versuch bringt im Notaus nichts.
      if (state.paused || notfallAktiv()) {
        await sendText(pausiertText()).catch(log);
        return;
      }
      // Vorübergehende Störung oder abgelehnter Schlüssel: klarer Text statt roher Fehlermeldung
      const antwort = voruebergehend(e) || fehlerArt(e) === "auth" ? nutzerText(e, "claude") : `Da ging etwas schief: ${schwaerze(e instanceof Error ? e.message : String(e))}`;
      await sendText(antwort).catch(log);
      return;
    }
    // Notaus kam nach der Rückgabe von runLoop, aber vor dem Senden: keine Antwort mehr in einen womöglich kompromittierten Chat.
    if (state.paused || notfallAktiv()) {
      await sendText(pausiertText()).catch(log);
      return;
    }
    // Die Antwort ist bezahlt und in der Historie: scheitert nur Telegram, bleibt sie im Postausgang statt verloren zu gehen.
    const r = await sendeTeile(reply, {}, () => state.paused || notfallAktiv());
    if (!r.ok) {
      // Notaus während des Versands, auch während der Wiederholungen eines Teils: der Rest geht weder raus
      // noch in den Postausgang (womöglich kompromittierter Chat)
      if (r.abgebrochen || state.paused || notfallAktiv()) return;
      log(r.fehler);
      // client: Nachricht selbst unbrauchbar, Wiederholen hilft nicht; sonst nur den nicht zugestellten Rest ablegen
      if (fehlerArt(r.fehler) !== "client") ablegen(r.rest);
      return;
    }
    if (spoken && !state.paused && !notfallAktiv()) await sendVoiceReply(reply);
  } finally {
    clearInterval(ticker);
  }
}

// ---------- Hintergrund ----------

let erinnerungenLaufen = false;

/**
 * Alle 30 s. Laufsperre: ein Senden mit Wiederholung kann länger als 30 s dauern; ohne Sperre würde der nächste
 * Tick dieselbe (noch nicht entfernte) Erinnerung ein zweites Mal schicken.
 */
export async function remindersTick(): Promise<void> {
  if (erinnerungenLaufen) return;
  erinnerungenLaufen = true;
  try {
    // Notfall: Erinnerungen (Termine, private Notizen) bleiben liegen bis /entwarnung, nichts wird gelöscht.
    if (notfallAktiv()) return;
    const now = Date.now();
    const due = reminders.filter((r) => Date.parse(r.at) <= now);
    if (due.length === 0) return;
    const erledigt = new Set<(typeof reminders)[number]>();
    for (const r of due) {
      if (notfallAktiv()) break;
      // client-Fehler: die Nachricht ist unbrauchbar, Wiederholen hilft nicht → als erledigt verwerfen (wie bisher)
      const ok = await zustellen(`⏰ ${r.text}`, { imNotfallZurueckhalten: true }).catch((e: unknown) => (log(e), true));
      if (ok) erledigt.add(r);
    }
    if (erledigt.size === 0) return;
    reminders.splice(0, reminders.length, ...reminders.filter((r) => !erledigt.has(r)));
    saveReminders();
  } finally {
    erinnerungenLaufen = false;
  }
}

const POLL_BACKOFF = { basisMs: 1000, maxMs: 60_000, faktor: 2, jitter: 0.2 };

/**
 * Wartezeit nach einem fehlgeschlagenen getUpdates (rein, für Tests): 1 s → 2 → 4 → … 60 s mit Jitter.
 * 409 (zweiter Poller mit demselben Token) → 30 s, 401 (Token ungültig) → 5 Minuten; ein Retry-After von Telegram hat Vorrang.
 */
export function pollWartezeit(e: unknown, fehlversuch: number, zufall: () => number = Math.random): number {
  const status = e instanceof HttpFehler ? e.status : undefined;
  if (status === 409) return 30_000;
  if (status === 401) return 300_000;
  return wartezeit(Math.max(1, fehlversuch), POLL_BACKOFF, zufall, e instanceof HttpFehler ? e.retryAfterMs : undefined);
}

/**
 * Fehlgeschlagenes getUpdates an die Gesundheit melden (exportiert für Tests). Kein Log pro Fehlversuch –
 * gesundheit.melde loggt den ersten Fehler und danach höchstens alle 10 Minuten.
 * Gemeldet wird unter «telegram-empfang», getrennt vom Senden («telegram»): sonst setzte jede gesendete Nachricht
 * (auch die Watchdog-Meldung selbst) eine Empfangsstörung wieder auf ok → Störung/Erholung im 11-Minuten-Takt.
 * HTTP 409 (zweiter Poller) zählt gar nicht als Störung; die einmalige Logzeile in poll() genügt dafür.
 * Jede HTTP-Antwort (409, 401, 429, 5xx) beweist, dass das Internet da ist – sonst bliebe istOffline() nach einem
 * Netzausfall hängen, solange Telegram mit Fehlern antwortet, und hielte Zeitpläne und Briefing zurück.
 */
export function pollFehlerMelden(e: unknown): void {
  if (e instanceof HttpFehler) gesundheit.melde("internet", true);
  if (e instanceof HttpFehler && e.status === 409) return;
  const detail = fehlerDetail(e);
  gesundheit.melde("telegram-empfang", false, `telegram.getUpdates: ${detail}`);
  const art = fehlerArt(e);
  if (art === "netz" || art === "zeitlimit") gesundheit.melde("internet", false, detail);
}

const schlafen = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Notaus-Befehle, die nicht hinter einer laufenden Anfrage warten dürfen (z. B. während Claude-Wiederholungen). */
const DRINGEND = new Set(["/pause", "/notfall"]);

export function istDringend(u: Update): boolean {
  const cmd = (u.message?.text ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return DRINGEND.has(cmd);
}

/** Heben den Notaus auf; laufen in der Kette und gelten nicht, wenn ein neueres dringendes Update sie überholt hat. */
const AUFHEBEND = new Set(["/weiter", "/entwarnung"]);

/*
 * Reihenfolge über eine eigene Ankunftsnummer statt über die Grösse der update_id: Telegram wählt die nächste ID
 * nach einer Woche ohne Updates zufällig neu, sie kann dann kleiner sein als alle bisherigen.
 */
let ankunft = 0;
const ankunftVon = new WeakMap<Update, number>();
/** Ankunftsnummer des Updates; vergibt beim ersten Aufruf (Verteilen) die nächste. */
function ankunftsnummer(u: Update): number {
  let n = ankunftVon.get(u);
  if (n === undefined) {
    n = ++ankunft;
    ankunftVon.set(u, n);
  }
  return n;
}
/** Ankunftsnummer des neuesten vorgezogenen /pause bzw. /notfall (vom Besitzer) */
let letzterDringend = 0;

/**
 * Notaus ausserhalb von Telegram (POST /notfall, Dashboard, abuseSignal): alle bis jetzt angekommenen Updates gelten
 * als älter, ein schon eingereihtes /weiter oder /entwarnung hebt ihn also nicht auf. Später getippte gelten weiter.
 */
export function notausVermerken(): void {
  letzterDringend = Math.max(letzterDringend, ankunft + 1);
}

let updateKette: Promise<void> = Promise.resolve();
/**
 * Eingereihte, noch nicht begonnene Updates (update_id → Ankunftsnummer, in Ankunftsreihenfolge). Nur sie hält poll()
 * Telegram gegenüber unbestätigt, damit ein Neustart sie nicht verliert. Begonnene gelten sofort als bestätigt.
 */
const eingereiht = new Map<number, number>();
/** update_id des letzten Updates der letzten Antwort von getUpdates */
let letzteGesehen: number | undefined;
/** Zuletzt angenommene update_ids (Telegram liefert unbestätigte erneut); begrenzt, nur Gleichheit zählt. */
const gesehen = new Set<number>();
const GESEHEN_MAX = 1000;
/**
 * getUpdates liefert höchstens 100 Updates ab dem Offset. Liegen hinter dem ältesten eingereihten schon so viele,
 * bestätigt poll() alle: sonst kämen ein später getipptes /pause oder /notfall nie an, solange der Kopf der Kette hängt.
 */
const OFFSET_SPIELRAUM = 90;

/*
 * Begonnene Updates des Besitzers, auf Platte: Ein Neustart während der Verarbeitung (Telegram hat das Update noch
 * nicht bestätigt bekommen) darf es nicht ein zweites Mal ausführen – doppelte Freigabe, doppelter Claude-Lauf.
 */
const BEGONNEN_FILE = "data/telegram-begonnen.json";
const BEGONNEN_MAX = 200;

function ladeBegonnen(): number[] {
  try {
    const roh = JSON.parse(readFileSync(BEGONNEN_FILE, "utf8")) as unknown;
    return Array.isArray(roh) ? roh.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

const begonnen: number[] = ladeBegonnen();

function merkeBegonnen(id: number): void {
  begonnen.push(id);
  if (begonnen.length > BEGONNEN_MAX) begonnen.splice(0, begonnen.length - BEGONNEN_MAX);
  try {
    mkdirSync("data", { recursive: true, mode: 0o700 });
    writeFileSync(`${BEGONNEN_FILE}.tmp`, JSON.stringify(begonnen), { mode: 0o600 });
    renameSync(`${BEGONNEN_FILE}.tmp`, BEGONNEN_FILE);
  } catch (e) {
    // Lieber verarbeiten als verwerfen; der Schutz vor Doppelausführung fehlt dann nur bei einem Neustart.
    if (throttled("telegram-begonnen")) log(e);
  }
}

function vomBesitzer(u: Update): boolean {
  if (u.callback_query) return String(u.callback_query.from.id) === owner();
  if (u.message) return String(u.message.chat.id) === owner();
  return false;
}

/** Verarbeitung beginnt: synchron auf Platte vermerken und nicht mehr zurückhalten (Bestätigung beim nächsten getUpdates). */
function beginne(u: Update): void {
  eingereiht.delete(u.update_id);
  if (vomBesitzer(u)) merkeBegonnen(u.update_id);
}

/**
 * Updates des Besitzers laufen der Reihe nach (PIN nach Freigabe-Button, Antworten in Reihenfolge). /pause und /notfall
 * laufen sofort daneben, damit der Notaus auch greift, während eine Anfrage noch wartet; ebenso Updates von Fremden
 * (nur Abwehr: abuseSignal zählt sofort, und sie halten den Offset nicht zurück). poll() wartet nicht auf die
 * Verarbeitung, sonst käme ein /pause erst nach der laufenden Anfrage überhaupt an. Absender prüft handleUpdate,
 * ebenso, ob ein eingereihtes /weiter oder /entwarnung von einem neueren Notaus überholt wurde.
 */
export function verteileUpdate(u: Update): Promise<void> {
  const n = ankunftsnummer(u);
  if (istDringend(u) || !vomBesitzer(u)) {
    beginne(u);
    return handleUpdate(u).catch(log);
  }
  eingereiht.set(u.update_id, n);
  const lauf = updateKette
    .then(() => {
      beginne(u);
      return handleUpdate(u);
    })
    .catch(log);
  updateKette = lauf;
  return lauf;
}

/**
 * Offset fürs nächste getUpdates: die update_id des ältesten eingereihten, noch nicht begonnenen Updates, sonst die
 * letzte gesehene + 1. So bestätigt poll() Eingereihtes erst, wenn es begonnen hat – ein Neustart verliert es nicht,
 * Telegram liefert es erneut. Begonnenes ist bestätigt (und auf Platte vermerkt): es läuft höchstens einmal.
 */
export function naechsterOffset(): number {
  const aeltestes = eingereiht.entries().next();
  if (!aeltestes.done) {
    const [id, nr] = aeltestes.value;
    if (ankunft - nr < OFFSET_SPIELRAUM) return id;
  }
  return letzteGesehen !== undefined ? letzteGesehen + 1 : 0;
}

/**
 * Verteilt die neuen Updates einer Antwort. Schon angenommene (noch unbestätigte) und vor einem Neustart schon
 * begonnene überspringt es. Rückgabe: Anzahl neuer.
 */
export function annehmen(updates: Update[]): number {
  let neu = 0;
  for (const u of updates) {
    if (gesehen.has(u.update_id)) continue;
    gesehen.add(u.update_id);
    if (gesehen.size > GESEHEN_MAX) gesehen.delete(gesehen.values().next().value as number);
    if (begonnen.includes(u.update_id)) {
      // Zählt für den Spielraum mit (Telegram liefert es bis zur Bestätigung mit) und für die Notaus-Reihenfolge:
      // ein vor dem Neustart vorgezogenes /pause oder /notfall muss ein davor eingereihtes, erneut geliefertes
      // /weiter oder /entwarnung weiterhin überholen. Dieses läuft erst nach der Schleife (Kette), sieht es also.
      const n = ++ankunft;
      if (vomBesitzer(u) && istDringend(u)) letzterDringend = Math.max(letzterDringend, n);
      continue;
    }
    neu++;
    void verteileUpdate(u);
  }
  if (updates.length > 0) letzteGesehen = updates[updates.length - 1].update_id;
  return neu;
}

async function poll(): Promise<void> {
  let fehlversuche = 0;
  let sonderfallGeloggt = false; // 409/401 nur einmal pro Störung loggen
  for (;;) {
    try {
      const updates = await api<Update[]>("getUpdates", { offset: naechsterOffset(), timeout: 30, allowed_updates: ["message", "callback_query"] });
      fehlversuche = 0;
      sonderfallGeloggt = false;
      gesundheit.melde("telegram-empfang", true);
      gesundheit.melde("internet", true);
      // Nur Bekanntes zurück: Telegram liefert unbestätigte (noch laufende) Updates sofort wieder statt zu warten.
      // Kurz pausieren statt im Kreis zu fragen; ein /pause kommt so trotzdem binnen etwa einer Sekunde an.
      if (annehmen(updates) === 0 && updates.length > 0) await (wartenFn ?? schlafen)(1000);
    } catch (e) {
      fehlversuche++;
      const status = e instanceof HttpFehler ? e.status : undefined;
      if ((status === 409 || status === 401) && !sonderfallGeloggt) {
        sonderfallGeloggt = true;
        console.error(
          status === 409
            ? "Telegram: Ein zweiter Jarvis läuft mit diesem Token (HTTP 409). Ich warte 30 Sekunden und versuche es dann wieder."
            : "Telegram lehnt den Token ab (HTTP 401). Bitte TELEGRAM_BOT_TOKEN prüfen; nächster Versuch in 5 Minuten.",
        );
      }
      pollFehlerMelden(e);
      await (wartenFn ?? schlafen)(pollWartezeit(e, fehlversuche, zufallFn));
    }
  }
}

export const CAMERAS_UNLESBAR =
  "⚠️ cameras.json war beim Start unlesbar, Sir. Kameras, Meldungen und Wachen aus der Datei sind aus, bis sie repariert ist und ich neu gestartet bin.";

/**
 * Hinweise auf beim Start unlesbare Dateien (Zustand zuerst) und auf übersprungene ungültige Einträge (eintragsHinweise,
 * nur Anzahl und Sicherung); ohne Dateiinhalt, dürfen also auch im Notfall hinaus.
 */
export function dateiHinweise(): string[] {
  const zustand = zustandsHinweis();
  return [
    ...(zustand ? [zustand] : []),
    ...(profilNichtGeladen ? [PROFIL_UNLESBAR] : []),
    ...(wachenNichtGeladen ? [WACHEN_UNLESBAR] : []),
    ...(camerasNichtGeladen ? [CAMERAS_UNLESBAR] : []),
    ...(zeitplaeneNichtGeladen ? [ZEITPLAENE_UNLESBAR] : []),
    ...(erinnerungenNichtGeladen ? [ERINNERUNGEN_UNLESBAR] : []),
    ...(vorgaengeNichtGeladen ? [VORGAENGE_UNLESBAR] : []),
    ...(postausgangNichtGeladen ? [POSTAUSGANG_UNLESBAR] : []),
    ...(rechnungenNichtGeladen ? [RECHNUNGEN_UNLESBAR] : []),
    ...(auftraegeNichtGeladen ? [AUFTRAEGE_UNLESBAR] : []),
    ...eintragsHinweise(),
  ];
}

/**
 * Einmal beim Start (server.ts nach startTelegram): jede unlesbare Datei melden. Mit Vorrang, denn sicherheitsrelevante
 * Wachen könnten aus sein; scheitert der Versand, wartet die Meldung vorn im Postausgang.
 */
export async function dateiHinweiseMelden(): Promise<void> {
  for (const h of dateiHinweise()) await sendeSpaeter(h, { vorrang: true }).catch(log);
}

/** Startet Telegram, falls Token und Chat-ID gesetzt sind. */
export function startTelegram(): void {
  if (!config.telegramToken || !config.telegramOwner) {
    console.log("Telegram nicht konfiguriert (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID), interaktiver Jarvis aus.");
    return;
  }
  console.log(`Telegram aktiv, Werkzeuge: ${activeTools().map((t) => t.name).join(", ")}`);
  gesundheit.setzeMelder(sendeSpaeter);
  if (postausgang.length > 0) console.log(`Postausgang: ${postausgang.length} Nachricht(en) warten auf Zustellung.`);
  void poll();
  setInterval(() => remindersTick().catch(log), 30_000);
  setInterval(() => postausgangTick().catch(log), 60_000);
}
