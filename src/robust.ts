import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

/**
 * Robustheit: Fehler einordnen, mit Backoff wiederholen, Gesundheit der Anbindungen führen und
 * dauerhafte Störungen einmal melden (Watchdog). Keine Nebenwirkungen ausser Log und Melder.
 */

// ---------- Fehler einordnen ----------

/** HTTP-Fehler mit Status (und Retry-After, falls der Dienst einen nennt), z. B. aus telegram.ts / homeassistant.ts. */
export class HttpFehler extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(msg: string, status: number, retryAfterMs?: number) {
    super(msg);
    this.name = "HttpFehler";
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export type FehlerArt = "netz" | "zeitlimit" | "rate" | "server" | "client" | "auth" | "unbekannt";

const NETZ_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const ZEIT_NAMEN = new Set(["AbortError", "TimeoutError"]);

type Obj = Record<string, unknown>;
const istObj = (x: unknown): x is Obj => typeof x === "object" && x !== null;

/** Fehlercode aus e oder einer Ursache (e.cause, auch verschachtelt, AggregateError.errors). */
function fehlerCode(e: unknown, tiefe = 0): string | undefined {
  if (!istObj(e) || tiefe > 5) return undefined;
  const code = e.code;
  if (typeof code === "string" && code) return code;
  if (Array.isArray(e.errors)) for (const x of e.errors) { const c = fehlerCode(x, tiefe + 1); if (c) return c; }
  return fehlerCode(e.cause, tiefe + 1);
}

function fehlerName(e: unknown, tiefe = 0): string | undefined {
  if (!istObj(e) || tiefe > 5) return undefined;
  if (typeof e.name === "string" && ZEIT_NAMEN.has(e.name)) return e.name;
  return fehlerName(e.cause, tiefe + 1);
}

function httpStatus(e: unknown): number | undefined {
  if (!istObj(e)) return undefined;
  const s = e.status ?? e.statusCode;
  return typeof s === "number" && Number.isFinite(s) ? s : undefined;
}

function artAusStatus(status: number): FehlerArt {
  if (status === 429) return "rate";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500 || status === 408 || status === 425) return "server";
  if (status >= 400) return "client";
  return "unbekannt";
}

export function fehlerArt(e: unknown): FehlerArt {
  // Anthropic-SDK: Unterklassen vor Oberklassen prüfen
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "zeitlimit";
  if (e instanceof Anthropic.APIConnectionError) return "netz";
  if (e instanceof Anthropic.RateLimitError) return "rate";
  if (e instanceof Anthropic.InternalServerError) return "server";
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return "auth";
  if (e instanceof Anthropic.APIUserAbortError) return "unbekannt"; // bewusster Abbruch (Pause), nie wiederholen
  if (e instanceof Anthropic.APIError && typeof e.status === "number") return artAusStatus(e.status);

  const status = httpStatus(e);
  if (status !== undefined) return artAusStatus(status);

  if (fehlerName(e)) return "zeitlimit";
  const code = fehlerCode(e);
  if (code === "UND_ERR_CONNECT_TIMEOUT") return "zeitlimit";
  if (code && NETZ_CODES.has(code)) return "netz";
  if (e instanceof TypeError && /fetch failed|network/i.test(e.message)) return "netz";
  if (e instanceof Error && /\btimeout\b|timed out|zeitlimit|zeitüberschreitung/i.test(e.message)) return "zeitlimit";
  return "unbekannt";
}

/** Lohnt ein neuer Versuch? netz, zeitlimit, rate und server – nie client/auth. */
export function voruebergehend(e: unknown): boolean {
  const art = fehlerArt(e);
  return art === "netz" || art === "zeitlimit" || art === "rate" || art === "server";
}

const nachricht = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e) ?? String(e));

/** Kurzer, geschwärzter Fehlertext für Log und Gesundheit, z. B. «HTTP 502», «Netz: ECONNREFUSED», «Zeitlimit». */
export function fehlerDetail(e: unknown): string {
  const art = fehlerArt(e);
  const status = e instanceof Anthropic.APIError ? e.status : httpStatus(e);
  let text: string;
  if (art === "netz") text = `Netz: ${fehlerCode(e) ?? nachricht(e)}`;
  else if (art === "zeitlimit") text = `Zeitlimit: ${fehlerCode(e) ?? nachricht(e)}`;
  else if (typeof status === "number") {
    // Status nur einmal: HttpFehler aus telegram.ts/homeassistant.ts tragen ihn schon als «HTTP n» im Text, das SDK als «n {…}».
    const m = nachricht(e);
    text = (m.includes(`HTTP ${status}`) ? m : /^\d{3}\b/.test(m) ? `HTTP ${status}${m.slice(3)}` : `HTTP ${status} ${m}`).replace(/\s+/g, " ").trim();
  } else text = nachricht(e);
  return schwaerze(text).slice(0, 140);
}

// ---------- Schwärzen ----------

/** Entfernt Geheimnisse aus Fehlertexten (Telegram-Token in URLs, Zugangsdaten in URLs, API-Schlüssel, Bearer, token=/key=-Parameter). */
export function schwaerze(text: string): string {
  return text
    .replace(/\bbot\d{5,}:[A-Za-z0-9_-]{10,}/g, "bot<token>")
    .replace(/(\w+:\/\/)[^/@\s]+@/g, "$1<geheim>@")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-<schlüssel>")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 <token>")
    .replace(/([?&](?:token|key|api_key|apikey|access_token|secret|password|pw)=)[^&\s"']+/gi, "$1<geheim>");
}

// ---------- Wiederholen mit Backoff ----------

export interface WiederholOptionen {
  /** Gesamtzahl Versuche, Standard 3 */
  versuche?: number;
  basisMs?: number;
  maxMs?: number;
  faktor?: number;
  /** 0..1, Standard 0.2 (± Anteil) */
  jitter?: number;
  /** Standard: voruebergehend(e) */
  wiederholen?: (e: unknown, versuch: number) => boolean;
  /** injizierbar (Tests), Standard setTimeout */
  warten?: (ms: number) => Promise<void>;
  /** injizierbar (Tests), Standard Math.random */
  zufall?: () => number;
  /** meldet Erfolg/Fehler an die Gesundheit */
  komponente?: Komponente;
}

const RETRY_AFTER_DECKEL_MS = 60_000;

/** Backoff: min(maxMs, basisMs·faktor^(versuch-1)) ± jitter; ein Retry-After des Dienstes hat Vorrang (gedeckelt auf 60 s). */
export function wartezeit(
  versuch: number,
  o: Required<Pick<WiederholOptionen, "basisMs" | "maxMs" | "faktor" | "jitter">>,
  zufall: () => number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(Math.round(retryAfterMs), RETRY_AFTER_DECKEL_MS);
  const basis = Math.min(o.maxMs, o.basisMs * Math.pow(o.faktor, Math.max(0, versuch - 1)));
  const anteil = Math.min(1, Math.max(0, o.jitter));
  const z = Math.min(1, Math.max(0, zufall()));
  return Math.max(0, Math.round(basis * (1 + (z * 2 - 1) * anteil)));
}

/** «Retry-After» in Sekunden oder als HTTP-Datum → Millisekunden. */
export function retryAfterAusHeader(h: Headers | null | undefined): number | undefined {
  const wert = h?.get("retry-after")?.trim();
  if (!wert) return undefined;
  if (/^\d+(\.\d+)?$/.test(wert)) return Math.round(Number(wert) * 1000);
  const t = Date.parse(wert);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, t - Date.now());
}

/** Retry-After aus einem Fehler (HttpFehler.retryAfterMs oder SDK-Fehler mit Headers). */
function retryAfterAusFehler(e: unknown): number | undefined {
  if (e instanceof HttpFehler) return e.retryAfterMs;
  if (!istObj(e)) return undefined;
  if (typeof e.retryAfterMs === "number") return e.retryAfterMs;
  const h = e.headers;
  if (h instanceof Headers) return retryAfterAusHeader(h);
  if (istObj(h)) {
    const roh = h["retry-after"] ?? h["Retry-After"];
    if (typeof roh === "string" || typeof roh === "number") return retryAfterAusHeader(new Headers({ "retry-after": String(roh) }));
  }
  return undefined;
}

// Kein unref: in Skripten (npm run check, try.ts, Setup-Selbsttest) ist dieser Timer das einzige offene Handle, mit unref bräche Node vor dem nächsten Versuch ab.
const schlafen = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Führt fn bis zu `versuche` Mal aus und wirft am Ende den letzten Fehler. Zwischen den Versuchen Backoff mit Jitter.
 * Mit `komponente` wird jeder Versuch an die Gesundheit gemeldet (client-Fehler zählen nicht als Störung: der Dienst hat ja geantwortet).
 */
export async function mitWiederholung<T>(name: string, fn: (versuch: number) => Promise<T>, o: WiederholOptionen = {}): Promise<T> {
  const versuche = Math.max(1, Math.floor(o.versuche ?? 3));
  const back = { basisMs: o.basisMs ?? 500, maxMs: o.maxMs ?? 8000, faktor: o.faktor ?? 2, jitter: o.jitter ?? 0.2 };
  const wiederholen = o.wiederholen ?? ((e: unknown) => voruebergehend(e));
  const warten = o.warten ?? schlafen;
  const zufall = o.zufall ?? Math.random;
  let letzter: unknown;
  for (let versuch = 1; versuch <= versuche; versuch++) {
    try {
      const ergebnis = await fn(versuch);
      if (o.komponente) gesundheit.melde(o.komponente, true);
      return ergebnis;
    } catch (e) {
      letzter = e;
      // client-Fehler und bewusster Abbruch (Notaus) sind keine Störung des Dienstes
      if (o.komponente && fehlerArt(e) !== "client" && !(e instanceof Anthropic.APIUserAbortError)) gesundheit.melde(o.komponente, false, `${name}: ${fehlerDetail(e)}`);
      if (versuch >= versuche || !wiederholen(e, versuch)) throw e;
      await warten(wartezeit(versuch, back, zufall, retryAfterAusFehler(e)));
    }
  }
  throw letzter;
}

// ---------- Nutzertexte ----------

export type Komponente = "internet" | "claude" | "telegram" | "telegram-empfang" | "homeassistant" | "frigate" | "mqtt" | "whoop" | "wetter" | "kalender" | "gmail" | "shopify" | "stt" | "tts" | "octoprint";

/** Deutsche Namen: Nominativ (Satzanfang), Dativ nach «zu», und der .env-Schlüssel für den Fall «Zugang abgelehnt». */
const NAMEN: Record<Komponente, { nom: string; zu: string; schluessel?: string }> = {
  internet: { nom: "die Internetverbindung", zu: "zum Internet" },
  claude: { nom: "die Claude-API", zu: "zur Claude-API", schluessel: "ANTHROPIC_API_KEY" },
  telegram: { nom: "Telegram", zu: "zu Telegram", schluessel: "TELEGRAM_BOT_TOKEN" },
  // getUpdates getrennt vom Senden: sonst setzt jede gesendete Nachricht eine Empfangsstörung wieder auf ok
  "telegram-empfang": { nom: "der Telegram-Empfang", zu: "zum Telegram-Empfang", schluessel: "TELEGRAM_BOT_TOKEN" },
  homeassistant: { nom: "Home Assistant", zu: "zu Home Assistant", schluessel: "HA_TOKEN" },
  frigate: { nom: "Frigate", zu: "zu Frigate" },
  mqtt: { nom: "der MQTT-Broker", zu: "zum MQTT-Broker", schluessel: "MQTT_USER/MQTT_PASSWORD" },
  whoop: { nom: "WHOOP", zu: "zu WHOOP", schluessel: "WHOOP-Anmeldung (npm run whoop:auth)" },
  wetter: { nom: "der Wetterdienst", zu: "zum Wetterdienst" },
  kalender: { nom: "der Kalender", zu: "zum Kalender" },
  gmail: { nom: "Gmail", zu: "zu Gmail", schluessel: "Google-Anmeldung (npm run google:auth)" },
  shopify: { nom: "Shopify", zu: "zu Shopify", schluessel: "SHOPIFY_TOKEN" },
  stt: { nom: "die Spracherkennung", zu: "zur Spracherkennung", schluessel: "STT_KEY" },
  tts: { nom: "die Sprachausgabe", zu: "zur Sprachausgabe", schluessel: "TTS_KEY" },
  octoprint: { nom: "OctoPrint", zu: "zu OctoPrint", schluessel: "OCTOPRINT_KEY" },
};

const istKomponente = (k: string): k is Komponente => Object.hasOwn(NAMEN, k);
const gross = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Name für einen frei formulierten Dienst («Claude-API») oder einen Komponentenschlüssel («claude»). */
function dienstNamen(dienst: string): { nom: string; zu: string; schluessel?: string } {
  const k = dienst.trim().toLowerCase().replace(/[\s_-]/g, "");
  if (istKomponente(k)) return NAMEN[k];
  const alias: Record<string, Komponente> = { telegramempfang: "telegram-empfang", claudeapi: "claude", anthropic: "claude", ha: "homeassistant", frigatenvr: "frigate" };
  if (alias[k]) return NAMEN[alias[k]];
  return { nom: dienst, zu: `zu ${dienst}` };
}

const malText = (n?: number) => (n === undefined ? "mehrfach" : n === 1 ? "einmal" : n === 2 ? "zweimal" : n === 3 ? "dreimal" : `${n}-mal`);

/** Fehlertext für den Nutzer im Jarvis-Ton; nie rohe Geheimnisse. `versuche` = wie oft es probiert wurde (Standard «dreimal»). */
export function nutzerText(e: unknown, dienst: string, versuche = 3): string {
  const n = dienstNamen(dienst);
  const art = fehlerArt(e);
  const status = e instanceof Anthropic.APIError ? e.status : httpStatus(e);
  const noch = `Ich habe es ${malText(versuche)} versucht – bitte in einer Minute nochmals, Sir.`;
  switch (art) {
    case "rate": return `Die Verbindung ${n.zu} hakt gerade (Rate-Limit). ${noch}`;
    case "netz": return `Die Verbindung ${n.zu} ist gerade unterbrochen (Netzfehler). ${noch}`;
    case "zeitlimit": return `Die Verbindung ${n.zu} hakt gerade (Zeitlimit). ${noch}`;
    case "server": return `Die Verbindung ${n.zu} hakt gerade (Serverfehler${status ? ` HTTP ${status}` : ""}). ${noch}`;
    case "auth":
      return n.schluessel
        ? `${gross(n.nom)} lehnt den Zugang ab${status ? ` (HTTP ${status})` : ""}. Bitte ${n.schluessel} prüfen, Sir.`
        : `${gross(n.nom)} lehnt den Zugang ab${status ? ` (HTTP ${status})` : ""}. Bitte die Zugangsdaten prüfen, Sir.`;
    case "client": return `${gross(n.nom)} hat die Anfrage abgewiesen (${fehlerDetail(e)}). Wiederholen hilft hier nicht, Sir.`;
    default: return `Da ging etwas schief: ${schwaerze(nachricht(e)).slice(0, 300)}`;
  }
}

// ---------- Gesundheit und Watchdog ----------

export interface Zustand {
  ok: boolean;
  /** seit wann im aktuellen Zustand (ms) */
  seit: number;
  /** Fehler in Folge */
  fehler: number;
  letzterFehler?: string;
  /** Zeitpunkt des letzten Fehlers dieser Störung (ms) */
  letzterFehlerAm?: number;
  /** Kurzform für Nutzermeldungen, z. B. «HTTP 502», «Netzfehler», «Rate-Limit» (ohne interne Aufrufnamen und Roh-JSON) */
  kurz?: string;
  /** Watchdog hat diese Störung gemeldet */
  gemeldet: boolean;
  letzterOk?: number;
}

const LOG_ABSTAND_MS = 10 * 60_000;
/**
 * Ein Fehler gilt so lange als frisch. Komponenten wie Claude oder Home Assistant werden nur auf Anfrage angesprochen:
 * Nach einem einzelnen Fehlschlag fragt oft niemand mehr, der Zustand bliebe ohne diese Grenze ewig «gestört».
 */
const FRISCH_MS = 15 * 60_000;
/** Ohne Internet-Zustand (kein Polling) gilt die Paarregel Telegram+Claude nur so lange; danach starten Läufe wieder und prüfen selbst. */
const OFFLINE_FRISCH_MS = 5 * 60_000;
const minuten = (ms: number) => Math.max(0, Math.round(ms / 60_000));
const minText = (n: number) => (n === 1 ? "1 Minute" : `${n} Minuten`);
const fehlerAm = (z: Zustand) => z.letzterFehlerAm ?? z.seit;
const frisch = (z: Zustand, jetzt: number) => jetzt - fehlerAm(z) <= FRISCH_MS;

/** Kurzform eines Fehlerdetails für den Nutzer: Status oder Fehlerart statt «ha.get: Home Assistant HTTP 502 (states)». */
function kurzForm(text: string): string | undefined {
  const http = /\bHTTP (\d{3})\b/.exec(text);
  if (http) return http[1] === "429" ? "Rate-Limit" : `HTTP ${http[1]}`;
  if (/(^|: )Netz: /.test(text)) return "Netzfehler";
  if (/(^|: )Zeitlimit\b/.test(text)) return "Zeitlimit";
  // Freie, eigene Texte («API-Schlüssel abgelehnt», «Verbindung verloren») ohne internen Aufrufnamen; alles Technische bleibt im Log
  const rest = text.replace(/^[a-z]\w*(\.[\w-]+)+: /i, "");
  return rest.length <= 60 && !/[{}\/:<>]/.test(rest) ? rest : undefined;
}

let zustaende = new Map<Komponente, Zustand>();
let letztesLog = new Map<Komponente, number>();
/** Erholungen gemeldeter Störungen, die der Melder noch zustellen muss */
let erholungen: { k: Komponente; dauerMin: number }[] = [];
let melder: ((text: string) => Promise<void>) | undefined;

export const gesundheit = {
  /**
   * Meldet das Ergebnis eines Versuchs. Log nur beim ersten Fehler einer Störung und danach höchstens alle 10 Minuten;
   * Erholung wird geloggt. `detail` wird geschwärzt und auf 140 Zeichen gekürzt.
   */
  melde(k: Komponente, ok: boolean, detail?: string, jetzt = Date.now()): void {
    let z = zustaende.get(k);
    if (!z) { z = { ok: true, seit: jetzt, fehler: 0, gemeldet: false }; zustaende.set(k, z); }
    const name = NAMEN[k]?.nom ?? k;
    if (ok) {
      if (!z.ok) {
        const dauer = minuten(jetzt - z.seit);
        console.log(`[gesundheit] ${gross(name)} wieder da (nach ${minText(dauer)}).`);
        if (z.gemeldet) erholungen.push({ k, dauerMin: dauer });
        z.ok = true;
        z.seit = jetzt;
        z.gemeldet = false;
        delete z.letzterFehler;
        delete z.letzterFehlerAm;
        delete z.kurz;
      }
      z.fehler = 0;
      z.letzterOk = jetzt;
      return;
    }
    const text = detail ? schwaerze(detail).replace(/\s+/g, " ").trim().slice(0, 140) : undefined;
    // Alte, nie gemeldete Störung ohne Versuche seither: neuer Fehler beginnt eine neue Störung (sonst sofort «seit 240 Minuten»)
    const neu = z.ok || (!z.gemeldet && !frisch(z, jetzt));
    if (text) { z.letzterFehler = text; z.kurz = kurzForm(text); }
    else if (neu) { delete z.letzterFehler; delete z.kurz; }
    z.letzterFehlerAm = jetzt;
    if (neu) {
      z.ok = false;
      z.seit = jetzt;
      z.fehler = 1;
      z.gemeldet = false;
      letztesLog.set(k, jetzt);
      console.error(`[gesundheit] ${gross(name)}: Störung${text ? ` (${text})` : ""}.`);
      return;
    }
    z.fehler++;
    if (jetzt - (letztesLog.get(k) ?? 0) >= LOG_ABSTAND_MS) {
      letztesLog.set(k, jetzt);
      console.error(`[gesundheit] ${gross(name)} weiterhin gestört seit ${minText(minuten(jetzt - z.seit))}, ${z.fehler} Fehler${text ? ` (${text})` : ""}.`);
    }
  },

  zustand(k: Komponente): Zustand | undefined {
    const z = zustaende.get(k);
    return z ? { ...z } : undefined;
  },

  alle(): Record<string, Zustand> {
    const out: Record<string, Zustand> = {};
    for (const k of [...zustaende.keys()].sort()) out[k] = { ...zustaende.get(k)! };
    return out;
  },

  /**
   * Eine Zeile pro Komponente: «✅ claude» oder «❌ homeassistant seit 12 Min: HTTP 502»; liegt der letzte Fehler
   * länger zurück (seither kein Versuch), steht das dabei: «… (letzter Versuch vor 240 Min)».
   */
  bericht(jetzt = Date.now()): string {
    return [...zustaende.keys()].sort().map((k) => {
      const z = zustaende.get(k)!;
      if (z.ok) return `✅ ${k}`;
      const alt = frisch(z, jetzt) ? "" : ` (letzter Versuch vor ${minuten(jetzt - fehlerAm(z))} Min)`;
      return `❌ ${k} seit ${minuten(jetzt - z.seit)} Min${z.letzterFehler ? `: ${z.letzterFehler}` : ""}${alt}`;
    }).join("\n");
  },

  /**
   * Internet gestört, oder Telegram (Senden oder Empfang) und Claude beide mit frischen Netz-/Zeitlimit-Fehlern.
   * Den Internet-Zustand führt das Telegram-Polling laufend nach; liegt er vor, entscheidet er allein. «telegram» (Senden)
   * und «claude» heilen nur durch einen erfolgreichen Aufruf – genau die Läufe, die istOffline() zurückhält. Ohne
   * diese Regeln bliebe Jarvis nach einem einzelnen Fehlschlag verklemmt.
   */
  istOffline(jetzt = Date.now()): boolean {
    const internet = zustaende.get("internet");
    if (internet) return !internet.ok;
    const netzartig = (k: Komponente) => {
      const z = zustaende.get(k);
      return !!z && !z.ok && jetzt - fehlerAm(z) <= OFFLINE_FRISCH_MS && /\b(Netz|Zeitlimit)\b/.test(z.letzterFehler ?? "");
    };
    return (netzartig("telegram") || netzartig("telegram-empfang")) && netzartig("claude");
  },

  /** Sendefunktion für Watchdog-Meldungen (telegram.ts: sendeSpaeter, der Postausgang). */
  setzeMelder(fn: (text: string) => Promise<void>): void {
    melder = fn;
  },

  /**
   * Watchdog: Störungen ab config.watchdogMinuten genau einmal melden, Erholung gemeldeter Störungen melden.
   * Internet-Störung → eine Sammelmeldung, Einzelmeldungen bleiben solange aus. Scheitert der Melder, bleibt
   * `gemeldet` false und es wird beim nächsten Tick erneut versucht.
   */
  async tick(jetzt = Date.now()): Promise<void> {
    const schwelle = config.watchdogMinuten;
    if (!melder || !(schwelle > 0)) return;
    const senden = melder;

    const offen = erholungen;
    erholungen = [];
    for (const e of offen) {
      const text = e.k === "internet"
        ? `Die Internetverbindung ist wieder da (Ausfall ${minText(e.dauerMin)}).`
        : `${gross(NAMEN[e.k].nom)} ist wieder erreichbar (Ausfall ${minText(e.dauerMin)}).`;
      try { await senden(text); } catch { erholungen.push(e); }
    }

    // Reif nur, wenn Fehler wirklich über die ganze Schwelle auftraten und der letzte frisch ist – ein einzelner
    // Fehlschlag ohne weitere Versuche ist keine Dauerstörung.
    const reif = (z: Zustand) => !z.ok && !z.gemeldet && frisch(z, jetzt) && fehlerAm(z) - z.seit >= schwelle * 60_000;
    const internet = zustaende.get("internet");
    if (internet && !internet.ok && frisch(internet, jetzt)) {
      if (reif(internet)) {
        internet.gemeldet = true;
        try { await senden(`Sir, die Internetverbindung ist seit ${minText(minuten(jetzt - internet.seit))} gestört.`); } catch { internet.gemeldet = false; }
      }
      return; // Einzelmeldungen unterdrücken, solange das Internet weg ist
    }
    for (const k of [...zustaende.keys()].sort()) {
      if (k === "internet") continue;
      const z = zustaende.get(k)!;
      if (!reif(z)) continue;
      z.gemeldet = true;
      // Nur die Kurzform («HTTP 502»); Aufrufnamen und Roh-JSON aus letzterFehler gehören in Log und /check
      const text = `Sir, ${NAMEN[k].nom} antwortet seit ${minText(minuten(jetzt - z.seit))} nicht${z.kurz ? ` (${z.kurz})` : ""}. Ich versuche es weiter.`;
      try { await senden(text); } catch { z.gemeldet = false; }
    }
  },

  /** nur für Tests */
  _reset(): void {
    zustaende = new Map();
    letztesLog = new Map();
    erholungen = [];
    melder = undefined;
  },
};
