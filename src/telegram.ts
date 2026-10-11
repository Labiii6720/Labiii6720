import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { audit, throttled } from "./audit.js";
import { basename } from "node:path";
import { addSystemNote, handleMessage, pausiertText, resetHistory, runAuftrag } from "./agent.js";
import { config } from "./config.js";
import { getAuftrag, offeneAuftraege, saveAuftraege, setStatus, type Auftrag } from "./queue.js";
import { save, state, type Mode } from "./state.js";
import { activeTools, reminders, saveReminders } from "./tools.js";
import { forSpeech, speak, transcribe } from "./voice.js";
import { safePath } from "./workspace.js";
import { eventClip } from "./cameras.js";
import { listVorgaenge, startVorgang } from "./vorgaenge.js";
import { verbrauchBericht } from "./claude.js";
import { aufheben, ausloesen, notfallAktiv } from "./notfall.js";
import { createAuftrag } from "./queue.js";
import { protokolle, runProtokoll } from "./protokolle.js";
import { formatBefund, selbsttest } from "./check.js";
import { abuseSignal } from "./notfall.js";
import { HttpFehler, fehlerArt, fehlerDetail, gesundheit, mitWiederholung, nutzerText, schwaerze, voruebergehend, wartezeit } from "./robust.js";
import { clock } from "./time.js";

const API = () => `https://api.telegram.org/bot${config.telegramToken}`;
/** Claude ist hier ersetzbar (Tests mit Attrappen); im Betrieb die echte Funktion. */
export const abhaengigkeiten = { handleMessage };
const owner = () => config.telegramOwner ?? "";
const log = (e: unknown) => console.error(e instanceof Error ? schwaerze(e.message) : e);

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

function ladePostausgang(): Postausgang[] {
  try {
    const roh = JSON.parse(readFileSync(POSTAUSGANG_FILE, "utf8")) as unknown;
    if (!Array.isArray(roh)) return [];
    return roh.filter((e): e is Postausgang => typeof e === "object" && e !== null && typeof (e as Postausgang).text === "string" && typeof (e as Postausgang).ts === "string");
  } catch {
    return [];
  }
}

const postausgang: Postausgang[] = ladePostausgang();

function speicherePostausgang(): void {
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

function ablegen(text: string): void {
  postausgang.push({ ts: new Date().toISOString(), text });
  kuerzen();
  speicherePostausgang();
}

/**
 * Vor die gewöhnlichen Einträge einreihen (Vorrang), aber hinter ältere Vorrang-Einträge: sonst käme ein späteres
 * Freigabe-Ergebnis vor dem Notfall-Alarm an. Bei vollem Postausgang fliegen die ältesten übrigen Einträge raus, nicht dieser.
 */
function voranstellen(text: string): void {
  const i = postausgang.findIndex((e) => !e.vorrang);
  postausgang.splice(i < 0 ? postausgang.length : i, 0, { ts: new Date().toISOString(), text, vorrang: true });
  kuerzen();
  speicherePostausgang();
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
  const zurueckhalten = optionen.imNotfallZurueckhalten ? notfallAktiv : undefined;
  if (zurueckhalten?.()) return;
  if (postausgang.length > 0 && !optionen.vorrang) return void ablegen(text);
  const r = await sendeTeile(text, {}, zurueckhalten);
  if (r.ok) return;
  // Notfall kam während des Versands (auch während der Wiederholungen): der Rest bleibt auch dem Postausgang fern
  if (r.abgebrochen || zurueckhalten?.()) return;
  if (fehlerArt(r.fehler) === "client") throw r.fehler;
  // nur der nicht zugestellte Rest
  if (optionen.vorrang) voranstellen(r.rest);
  else ablegen(r.rest);
}

let nachreichenLaeuft = false;

/** Alle 60 s: Liegengebliebenes in Reihenfolge nachreichen, sobald Telegram wieder antwortet. */
export async function postausgangTick(): Promise<void> {
  if (nachreichenLaeuft || postausgang.length === 0) return;
  nachreichenLaeuft = true;
  try {
    while (postausgang.length > 0) {
      // Im Notfall nichts Altes herausgeben: nur, was seit der Auslösung abgelegt wurde (der Alarm). Der Rest wartet auf /entwarnung.
      const seit = notfallAktiv() ? (state.notfall?.seit ?? "") : undefined;
      const e = seit === undefined ? postausgang[0] : postausgang.find((x) => x.ts >= seit);
      if (!e) break;
      const volltext = `(nachgereicht, ${clock(new Date(e.ts))}) ${e.text}`;
      const r = await sendeTeile(volltext);
      if (!r.ok) {
        if (fehlerArt(r.fehler) !== "client") {
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

export async function sendFile(path: string, caption?: string): Promise<void> {
  const full = safePath(path);
  const form = new FormData();
  form.append("chat_id", owner());
  if (caption) form.append("caption", caption.slice(0, 1000));
  form.append("document", new Blob([readFileSync(full)]), basename(full));
  await apiRobust("sendDocument", form);
}

export async function sendPhoto(image: Buffer, caption?: string, extra: Record<string, unknown> = {}): Promise<void> {
  const form = new FormData();
  form.append("chat_id", owner());
  if (caption) form.append("caption", caption.slice(0, 1000));
  for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  form.append("photo", new Blob([new Uint8Array(image)]), "bild.jpg");
  await apiRobust("sendPhoto", form);
}

export async function sendVideo(video: Buffer, caption?: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", owner());
  if (caption) form.append("caption", caption.slice(0, 1000));
  form.append("video", new Blob([new Uint8Array(video)]), "clip.mp4");
  await apiRobust("sendVideo", form);
}

async function sendVoice(audio: Buffer): Promise<void> {
  const form = new FormData();
  form.append("chat_id", owner());
  form.append("voice", new Blob([new Uint8Array(audio)]), "jarvis.ogg");
  await apiRobust("sendVoice", form);
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

function freigabeText(a: Auftrag): string {
  const icon = a.stufe === "sensibel" ? "🔴" : "🟠";
  const pin = a.stufe === "sensibel" ? " · Freigabe mit PIN" : "";
  return `${icon} Auftrag #${a.id} · Stufe ${a.stufe}${pin}\n\n${a.summary}`;
}

async function sendAuftrag(a: Auftrag): Promise<void> {
  const id = await sendText(freigabeText(a), {
    reply_markup: { inline_keyboard: [[{ text: "✅ Freigeben", callback_data: `ok:${a.id}` }, { text: "❌ Ablehnen", callback_data: `nein:${a.id}` }]] },
  });
  if (id) {
    a.messageId = id;
    setStatus(a, a.status);
  }
}

export const hooks = { sendFile, sendPhoto, sendVideo, onAuftrag: sendAuftrag };

/** Aufträge, deren Werkzeug gerade läuft: der Status bleibt bis zum Ende «offen», darum braucht es diese Sperre. */
const inArbeit = new Set<number>();
const laeuftBereits = (a: Auftrag) => `#${a.id} wird bereits ausgeführt, Sir.`;
/** Begonnen, aber nie abgeschlossen (Absturz mitten im Werkzeug): nicht nochmals ausführen, die Nebenwirkung kann schon eingetreten sein. */
const ergebnisUnklar = (a: Auftrag) => `#${a.id} wurde bereits gestartet, Ergebnis unklar – bitte prüfen, Sir.`;

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
  if (state.paused) return "⛔ Notaus aktiv. Erst /weiter, dann nochmal freigeben.";
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

/** Wartet auf die PIN für einen sensiblen Auftrag */
let pendingPin: { id: number; until: number } | undefined;

/** Freigabe von einer anderen Oberfläche (Dashboard). Sensible Aufträge brauchen die PIN im selben Schritt. */
export async function approveAuftrag(a: Auftrag, pin?: string): Promise<string> {
  if (a.status !== "offen") return `#${a.id} ist bereits ${a.status}.`;
  if (inArbeit.has(a.id)) return laeuftBereits(a);
  if (a.gestartetAm) return ergebnisUnklar(a);
  if (state.paused) return "⛔ Notaus aktiv. Erst /weiter.";
  if (a.stufe === "sensibel") {
    if (!config.pin) return "Für sensible Aufträge fehlt eine PIN (JARVIS_PIN).";
    if (pin !== config.pin) {
      audit("pin_falsch", { id: a.id, tool: a.tool, quelle: "dashboard" });
      return "Falsche PIN.";
    }
  }
  // Zwischen Prüfung und Ausführung kein await: execute beansprucht den Auftrag synchron.
  if (a.messageId) knoepfeEntfernen(a.messageId);
  const hindernis = await execute(a, DASHBOARD_MELDUNG_FRIST_MS);
  if (hindernis) return hindernis;
  if (notfallAktiv()) return zurueckgehalten(a);
  const nachher = getAuftrag(a.id)!; // execute hat den Status gesetzt
  return nachher.status === "erledigt" ? `✅ #${a.id} erledigt: ${nachher.result ?? ""}` : `⚠️ #${a.id}: ${nachher.result ?? "Fehler"}`;
}

export async function denyAuftrag(a: Auftrag): Promise<string> {
  if (a.status !== "offen") return `#${a.id} ist bereits ${a.status}.`;
  if (inArbeit.has(a.id)) return laeuftBereits(a);
  audit("auftrag_abgelehnt", { id: a.id, tool: a.tool, quelle: "dashboard" });
  setStatus(a, "abgelehnt");
  addSystemNote(`Auftrag #${a.id} (${a.tool}) wurde vom Nutzer abgelehnt.`);
  if (a.messageId) await apiRobust("editMessageReplyMarkup", { chat_id: owner(), message_id: a.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  await sendText(`❌ #${a.id} abgelehnt (Dashboard).`).catch(() => undefined);
  return `❌ #${a.id} abgelehnt.`;
}

async function onCallback(cb: { id: string; data?: string; message?: { message_id: number } }): Promise<void> {
  // Kosmetik ohne Warten: bei gestörtem Senden dauerten die Wiederholungen sonst Minuten, und Kette und Freigabe stünden still.
  void apiRobust("answerCallbackQuery", { callback_query_id: cb.id }).catch(log);
  const [action, idStr] = (cb.data ?? "").split(":");
  if (action === "clip") {
    try {
      await sendVideo(await eventClip(idStr ?? ""), `🎬 Clip ${idStr}`);
    } catch (e) {
      await sendText(`Clip noch nicht da oder nicht gefunden (${schwaerze(e instanceof Error ? e.message : String(e))}).`);
    }
    return;
  }
  const a = getAuftrag(Number(idStr));
  if (!a) return void sendText("Diesen Auftrag kenne ich nicht mehr.");
  if (cb.message) knoepfeEntfernen(cb.message.message_id);
  if (a.status !== "offen") return void sendText(`#${a.id} ist bereits ${a.status}.`);
  if (inArbeit.has(a.id)) return void sendText(laeuftBereits(a));
  if (a.gestartetAm && action === "ok") return void sendText(ergebnisUnklar(a));
  if (state.paused && action === "ok") return void sendText("⛔ Notaus aktiv. Erst /weiter, dann nochmal freigeben.");

  if (action === "nein") {
    audit("auftrag_abgelehnt", { id: a.id, tool: a.tool });
    setStatus(a, "abgelehnt");
    addSystemNote(`Auftrag #${a.id} (${a.tool}) wurde vom Nutzer abgelehnt.`);
    return void sendText(`❌ #${a.id} abgelehnt.`);
  }
  if (a.stufe === "sensibel") {
    if (!config.pin) return void sendText("Für sensible Aufträge fehlt eine PIN: JARVIS_PIN in .env setzen.");
    pendingPin = { id: a.id, until: Date.now() + 2 * 60_000 };
    return void sendText(`#${a.id} ist sensibel. PIN bitte, innerhalb von zwei Minuten.`);
  }
  const hindernis = await execute(a);
  if (hindernis) await sendText(hindernis);
}

// ---------- Befehle ----------

async function onCommand(cmd: string, arg: string): Promise<void> {
  switch (cmd) {
    case "/start":
    case "/hilfe":
      return void sendText(
        "JARVIS, zu Diensten.\n\n/auftraege – offene Freigaben\n/vorgang <Auftrag> – grosse Aufgabe im Hintergrund, starkes Modell\n/vorgaenge – Stand der Vorgänge\n! vor einer Nachricht – starkes Modell für diese Antwort\n/modus normal|fokus|nacht\n/neu – Gespräch vergessen\n/pause – Notaus, /weiter hebt ihn auf\n/notfall – Angriff: alles sperren und alarmieren\n/protokoll <name> – Nacht, Abwesend, Werkstatt …\n/kosten – Tokenverbrauch heute und Monat\n/check – Selbsttest aller Anbindungen\n/status – was läuft",
      );
    case "/auftraege": {
      const offen = offeneAuftraege();
      if (offen.length === 0) return void sendText("Keine offenen Aufträge.");
      for (const a of offen) await sendAuftrag(a);
      return;
    }
    case "/modus": {
      const m = arg.trim().toLowerCase();
      if (!["normal", "fokus", "nacht"].includes(m)) return void sendText(`Aktueller Modus: ${state.mode ?? "normal"}. Setzen mit /modus normal|fokus|nacht`);
      state.mode = m as Mode;
      save();
      return void sendText(`Modus: ${m}.`);
    }
    case "/neu":
      resetHistory();
      return void sendText("Gespräch vergessen. Clean Slate.");
    case "/vorgang": {
      if (!arg.trim()) return void sendText("Benutzung: /vorgang <Auftrag>. Läuft im Hintergrund mit dem starken Modell; /vorgaenge zeigt den Stand.");
      const v = startVorgang(arg.trim(), hooks);
      return void sendText(`🧠 Vorgang #${v.id} gestartet. Fortschritt und Ergebnis folgen hier, der Chat bleibt währenddessen frei.`);
    }
    case "/vorgaenge":
      return void sendText(listVorgaenge());
    case "/kosten":
      return void sendText(verbrauchBericht());
    case "/protokoll": {
      const name = arg.trim().toLowerCase();
      const p = protokolle[name];
      if (!p) return void sendText(`Protokolle: ${Object.keys(protokolle).join(", ") || "keine (protokolle.json)"}`);
      if (p.stufe === "auto") return void sendText(await runProtokoll(name, hooks));
      const a = createAuftrag({ tool: "protokoll_ausfuehren", input: { name }, stufe: p.stufe, summary: `Protokoll «${name}»: ${p.beschreibung}` });
      return sendAuftrag(a);
    }
    case "/notfall":
      await ausloesen("Manuell über Telegram ausgelöst.");
      return;
    case "/entwarnung":
      if (!notfallAktiv()) return void sendText("Es ist kein Notfall aktiv.");
      aufheben();
      return void sendText("✅ Entwarnung. Notfall aufgehoben, Jarvis läuft wieder. Denk daran, erneuerte Tokens einzutragen.");
    case "/pause":
      state.paused = true;
      save();
      audit("pause", {});
      return void sendText("⛔ Notaus. Keine Werkzeuge, Zeitpläne oder Wachen, bis /weiter kommt. Offene Aufträge bleiben offen.");
    case "/weiter":
      // Im Notfall hebt nur /entwarnung den Notaus auf (bewusster Schritt mit Checkliste)
      if (notfallAktiv()) return void sendText("Es läuft ein Notfall, Sir. Erst /entwarnung.");
      state.paused = false;
      save();
      audit("weiter", {});
      return void sendText("▶️ Weiter geht's.");
    case "/check":
      await sendText("Prüfe alle Anbindungen …");
      return void sendText(formatBefund(await selbsttest()));
    case "/status":
      return void sendText(
        `${notfallAktiv() ? "🚨 NOTFALL AKTIV\n" : state.paused ? "⛔ PAUSIERT\n" : ""}Modus: ${state.mode ?? "normal"}\nOffene Aufträge: ${offeneAuftraege().length}\nErinnerungen: ${reminders.length}\nWerkzeuge: ${activeTools().map((t) => t.name).join(", ")}`,
      );
    default:
      return void sendText("Kenne ich nicht. /hilfe zeigt die Befehle.");
  }
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

  let spoken = false;
  let text = (m.text ?? "").trim();
  if (m.voice) {
    if (!config.stt) return void sendText("Sprachnachrichten kann ich erst verstehen, wenn STT_URL eingerichtet ist.");
    if (m.voice.duration > 120) return void sendText("Das ist mir zu lang, bitte unter zwei Minuten.");
    await typing();
    try {
      text = await transcribe(await downloadVoice(m.voice.file_id));
    } catch (e) {
      return void sendText(`Konnte die Sprachnachricht nicht verstehen: ${schwaerze(e instanceof Error ? e.message : String(e))}`);
    }
    if (!text) return void sendText("Da habe ich nichts verstanden.");
    spoken = true;
    await sendText(`🎙 ${text}`);
  }

  // Abgelaufen: nur die PIN selbst wird noch abgefangen (gelöscht statt an Claude), alles andere läuft normal.
  if (pendingPin && Date.now() > pendingPin.until && text !== config.pin) pendingPin = undefined;
  // /weiter bzw. /entwarnung im Notaus ist nie die PIN: die wartende Freigabe verfällt (sie muss nach dem Notaus
  // ohnehin neu kommen), der Befehl läuft normal – sonst würde er gelöscht und der Notaus bliebe stehen.
  const ersterBefehl = text.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (pendingPin && state.paused && AUFHEBEND.has(ersterBefehl)) pendingPin = undefined;
  // /pause und /notfall sind nie die PIN und greifen sofort; eine danach getippte PIN fängt der Notaus-Check unten ab.
  if (pendingPin && !istDringend(u)) {
    const p = pendingPin;
    pendingPin = undefined;
    await apiRobust("deleteMessage", { chat_id: owner(), message_id: m.message_id }).catch(() => undefined);
    const a = getAuftrag(p.id);
    if (!a || a.status !== "offen") return void sendText("Dieser Auftrag ist nicht mehr offen.");
    if (Date.now() > p.until) return void sendText(`Zeit abgelaufen. /auftraege zeigt #${a.id} nochmal.`);
    if (state.paused) return void sendText("⛔ Notaus aktiv. Erst /weiter, dann nochmal freigeben.");
    if (inArbeit.has(a.id)) return void sendText(laeuftBereits(a));
    if (text !== config.pin) {
      audit("pin_falsch", { id: a.id, tool: a.tool });
      setStatus(a, "abgelehnt", "falsche PIN");
      return void sendText(`Falsche PIN. #${a.id} abgelehnt.`);
    }
    const hindernis = await execute(a);
    if (hindernis) await sendText(hindernis);
    return;
  }

  // Die PIN ohne wartende Freigabe (etwa nach einem Neustart erneut geliefert): löschen, nie an Claude und in die Historie.
  if (config.pin && text === config.pin) {
    await apiRobust("deleteMessage", { chat_id: owner(), message_id: m.message_id }).catch(() => undefined);
    audit("pin_ohne_freigabe", {});
    return void sendText("Keine Freigabe wartet auf eine PIN, Sir. Nachricht gelöscht.");
  }

  if (text.startsWith("/")) {
    const [cmd, ...rest] = text.split(/\s+/);
    const befehl = cmd.toLowerCase();
    // Ein /weiter oder /entwarnung, das hinter einer Anfrage wartete, während ein später getipptes /pause oder /notfall
    // vorgezogen wurde, darf den Notaus nicht nachträglich aufheben: der zuletzt gegebene Befehl gilt.
    // Verglichen wird die Ankunftsreihenfolge, nicht die update_id (Telegram wählt sie nach einer Woche Ruhe neu und zufällig).
    if (AUFHEBEND.has(befehl) && ankunftsnummer(u) < letzterDringend) {
      return void sendText(`${befehl} kam vor dem Notaus an und gilt nicht, Sir. Bitte erneut senden.`);
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
    const now = Date.now();
    const due = reminders.filter((r) => Date.parse(r.at) <= now);
    if (due.length === 0) return;
    for (const r of due) await sendeSpaeter(`⏰ ${r.text}`).catch(log);
    reminders.splice(0, reminders.length, ...reminders.filter((r) => Date.parse(r.at) > now));
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
