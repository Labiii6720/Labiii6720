import { google } from "googleapis";
import ICAL from "ical.js";
import { config, env, opt, TZ } from "./config.js";
import { HttpFehler, mitWiederholung, retryAfterAusHeader, voruebergehend, type WiederholOptionen } from "./robust.js";
import { istNurLesen } from "./datei.js";
import { day, save, state, type Recovery, type Workout } from "./state.js";
import { dayBounds, todayKey } from "./time.js";

/** Nur für Tests: Warten und Zufall des Backoffs injizieren (im Betrieb leer). */
export const _testOptionen: Pick<WiederholOptionen, "warten" | "zufall"> = {};

export interface CalEvent {
  source: "privat" | "arbeit";
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
}

// =====================================================================
// Wetter: Open-Meteo (gratis, ohne API-Key)
// =====================================================================

const WMO: Record<number, string> = {
  0: "klar", 1: "überwiegend klar", 2: "teilweise bewölkt", 3: "bedeckt",
  45: "Nebel", 48: "Nebel mit Reifbildung",
  51: "leichter Niesel", 53: "Niesel", 55: "starker Niesel",
  56: "gefrierender Niesel", 57: "starker gefrierender Niesel",
  61: "leichter Regen", 63: "Regen", 65: "starker Regen",
  66: "gefrierender Regen", 67: "starker gefrierender Regen",
  71: "leichter Schneefall", 73: "Schneefall", 75: "starker Schneefall", 77: "Schneegriesel",
  80: "leichte Regenschauer", 81: "Regenschauer", 82: "heftige Regenschauer",
  85: "Schneeschauer", 86: "starke Schneeschauer",
  95: "Gewitter", 96: "Gewitter mit Hagel", 99: "schweres Gewitter mit Hagel",
};

export interface Weather {
  nowTemp: number | null;
  /** mind. 50 % Regenrisiko in den nächsten zwei Stunden */
  rainSoon: boolean;
  /** Tagesübersicht für Claude */
  summary: string;
}

type Series = (number | null)[];
interface OpenMeteo {
  current: { temperature_2m: number | null };
  hourly: { time: string[]; precipitation_probability: Series };
  daily: {
    weather_code: Series;
    temperature_2m_min: Series;
    temperature_2m_max: Series;
    precipitation_sum: Series;
    precipitation_probability_max: Series;
  };
}

let weatherCache: { at: number; value: Weather } | undefined;

export async function getWeather(maxAgeMinutes = 30): Promise<Weather> {
  if (weatherCache && Date.now() - weatherCache.at < maxAgeMinutes * 60_000) return weatherCache.value;

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: env("LAT"),
    longitude: env("LON"),
    current: "temperature_2m",
    hourly: "precipitation_probability",
    daily: "weather_code,temperature_2m_min,temperature_2m_max,precipitation_sum,precipitation_probability_max",
    timezone: TZ,
    forecast_days: "1",
  }).toString();

  // Lesen ohne Nebenwirkung: zwei Versuche bei Netz-, Zeitlimit- und Serverfehlern
  const { current, hourly: h, daily: d } = await mitWiederholung("wetter.get", async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new HttpFehler(`Open-Meteo HTTP ${res.status}`, res.status, retryAfterAusHeader(res.headers));
    return (await res.json()) as OpenMeteo;
  }, { versuche: 2, komponente: "wetter", ..._testOptionen });

  const hourNow = new Date().getHours();
  const hours = h.time.map((t, i) => ({ hour: Number(t.slice(11, 13)), p: h.precipitation_probability[i] ?? 0 }));
  const rainHours = hours.filter((x) => x.p >= 50).map((x) => `${x.hour} Uhr (${x.p} %)`);
  const code = d.weather_code[0];
  const sky = code == null ? "unbekannt" : (WMO[code] ?? `WMO-Code ${code}`);

  const value: Weather = {
    nowTemp: current.temperature_2m,
    rainSoon: hours.some((x) => x.hour >= hourNow && x.hour <= hourNow + 2 && x.p >= 50),
    summary: [
      `Lage: ${sky}`,
      `Temperatur: ${d.temperature_2m_min[0]} bis ${d.temperature_2m_max[0]} °C`,
      `Niederschlag: ${d.precipitation_sum[0]} mm, Wahrscheinlichkeit max. ${d.precipitation_probability_max[0]} %`,
      `Stunden mit mind. 50 % Regenrisiko: ${rainHours.join(", ") || "keine"}`,
    ].join("\n"),
  };
  weatherCache = { at: Date.now(), value };
  return value;
}

// =====================================================================
// Google Kalender (privat): Dienstkonto, nur lesend
// =====================================================================

function googleCalendar(write = false) {
  const keyFile = opt("GOOGLE_KEY_FILE");
  const calendarId = opt("GOOGLE_CALENDAR_ID");
  if (!keyFile || !calendarId) return undefined;
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: [write ? "https://www.googleapis.com/auth/calendar.events" : "https://www.googleapis.com/auth/calendar.readonly"],
  });
  return { calendar: google.calendar({ version: "v3", auth }), calendarId };
}

export async function googleEvents(range = dayBounds()): Promise<CalEvent[]> {
  const g = googleCalendar();
  if (!g) return [];
  const { calendar, calendarId } = g;
  const { start, end } = range;

  const { data } = await mitWiederholung("kalender.google", () => calendar.events.list({
    calendarId,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    timeZone: TZ,
  }), { versuche: 2, komponente: "kalender", ..._testOptionen });

  return (data.items ?? [])
    .filter((ev) => ev.status !== "cancelled")
    .map((ev) => {
      const s = ev.start?.dateTime;
      const e = ev.end?.dateTime;
      return {
        source: "privat" as const,
        title: ev.summary ?? "(ohne Titel)",
        start: s ? new Date(s) : start,
        end: e ? new Date(e) : s ? new Date(s) : end,
        allDay: !s,
        location: ev.location ?? undefined,
      };
    });
}

// =====================================================================
// Outlook (Arbeit): veröffentlichter ICS-Link
// =====================================================================

export async function outlookEvents(range = dayBounds()): Promise<CalEvent[]> {
  const url = opt("OUTLOOK_ICS_URL");
  if (!url) return [];
  const ics = await mitWiederholung("kalender.outlook", async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new HttpFehler(`Outlook-Kalender HTTP ${res.status}`, res.status, retryAfterAusHeader(res.headers));
    return res.text();
  }, { versuche: 2, komponente: "kalender", ..._testOptionen });
  return eventsForDay(ics, range, config.outlookMode);
}

/** Legt einen Termin im privaten Google-Kalender an (Dienstkonto braucht Schreibrecht). */
export async function createGoogleEvent(ev: { title: string; start: string; end: string; location?: string; description?: string }): Promise<string> {
  const g = googleCalendar(true);
  if (!g) throw new Error("Google Kalender ist nicht eingerichtet.");
  const { data } = await g.calendar.events.insert({
    calendarId: g.calendarId,
    requestBody: {
      summary: ev.title,
      location: ev.location,
      description: ev.description,
      start: { dateTime: ev.start, timeZone: TZ },
      end: { dateTime: ev.end, timeZone: TZ },
    },
  });
  return data.htmlLink ?? data.id ?? "angelegt";
}

/** Termine eines Tages aus einer ICS-Datei, inklusive Serien, Ausnahmen und gelöschten Einzelterminen. */
export function eventsForDay(ics: string, range: { start: Date; end: Date }, mode: "busy" | "details"): CalEvent[] {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const tz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);

  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const comp of root.getAllSubcomponents("vevent")) {
    const ev = new ICAL.Event(comp);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }
  const orphans: ICAL.Event[] = [];
  for (const ex of exceptions) {
    const master = masters.get(ex.uid);
    if (master) master.relateException(ex);
    else orphans.push(ex);
  }

  const out: CalEvent[] = [];
  const add = (item: ICAL.Event, startTime: ICAL.Time, endTime: ICAL.Time) => {
    const c = item.component;
    const free =
      c.getFirstPropertyValue("transp") === "TRANSPARENT" ||
      c.getFirstPropertyValue("status") === "CANCELLED" ||
      c.getFirstPropertyValue("x-microsoft-cdo-busystatus") === "FREE";
    if (free) return;
    const s = startTime.toJSDate();
    const e = endTime.toJSDate();
    if (!(s < range.end && e > range.start)) return; // nicht heute
    const allDay = startTime.isDate;
    out.push({
      source: "arbeit",
      // Datensparsam: im busy-Modus verlassen keine Titel oder Orte deinen Pi
      title: mode === "details" ? item.summary || "(ohne Titel)" : "Arbeitstermin",
      start: allDay ? range.start : s,
      end: allDay ? range.end : e,
      allDay,
      location: mode === "details" ? item.location || undefined : undefined,
    });
  };

  // Etwas über das Tagesende hinaus iterieren, falls eine Ausnahme einen Termin auf heute verschoben hat
  const horizon = new Date(range.end.getTime() + 7 * 86_400_000);
  for (const ev of masters.values()) {
    if (!ev.isRecurring()) {
      add(ev, ev.startDate, ev.endDate);
      continue;
    }
    const it = ev.iterator();
    for (let next = it.next(), n = 0; next && n < 20_000; next = it.next(), n++) {
      if (next.toJSDate() >= horizon) break;
      const occ = ev.getOccurrenceDetails(next);
      add(occ.item, occ.startDate, occ.endDate);
    }
  }
  for (const ex of orphans) add(ex, ex.startDate, ex.endDate);

  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

// =====================================================================
// WHOOP API v2 (OAuth 2.0, nur lesend)
// =====================================================================

const WHOOP_API = "https://api.prod.whoop.com/developer";
export const WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export function storeWhoopTokens(t: TokenResponse, previousRefreshToken?: string): void {
  const refreshToken = t.refresh_token ?? previousRefreshToken;
  if (!refreshToken) throw new Error("WHOOP hat keinen Refresh-Token geliefert (Scope «offline» fehlt?).");
  state.whoop = { refreshToken, accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
  save();
}

let refreshing: Promise<string> | undefined;

/** true, wenn der gespeicherte WHOOP-Zugangstoken noch mindestens eine Minute gilt (kein Refresh nötig). */
export function whoopTokenGueltig(): boolean {
  const w = state.whoop;
  return Boolean(w?.accessToken && w.expiresAt && Date.now() < w.expiresAt - 60_000);
}

/** Meldung, wenn ein nur lesender Prozess (npm run check) den Token erneuern müsste. */
export const WHOOP_NUR_LESEN = "WHOOP-Token abgelaufen; nur gelesen, ich erneuere ihn nicht (das macht der Dienst).";

async function whoopToken(): Promise<string> {
  const w = state.whoop;
  if (!w?.refreshToken) throw new Error("WHOOP ist nicht verbunden. Führe zuerst scripts/whoop-auth.ts aus.");
  if (whoopTokenGueltig()) return w.accessToken!;
  // WHOOP rotiert den Refresh-Token: Erneuerte ihn npm run check, hielte der laufende Dienst den alten, entwerteten
  // im Speicher und schriebe ihn zurück – WHOOP wäre getrennt (npm run whoop:auth)
  if (istNurLesen()) throw new Error(WHOOP_NUR_LESEN);
  // WHOOP rotiert Refresh-Tokens: nie zwei Refreshes gleichzeitig starten
  refreshing ??= refreshWhoopToken(w.refreshToken).finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

async function refreshWhoopToken(refreshToken: string): Promise<string> {
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env("WHOOP_CLIENT_ID"),
      client_secret: env("WHOOP_CLIENT_SECRET"),
      scope: "offline",
    }),
    signal: AbortSignal.timeout(8000),
  });
  // Kein zweiter Versuch: WHOOP rotiert den Refresh-Token, eine Wiederholung könnte den frischen Token entwerten
  if (!res.ok) throw new HttpFehler(`WHOOP-Token-Refresh fehlgeschlagen (HTTP ${res.status}), evtl. neu verbinden.`, res.status);
  const tokens = (await res.json()) as TokenResponse;
  storeWhoopTokens(tokens, refreshToken);
  return tokens.access_token;
}

async function whoopGet<T>(path: string, timeoutMs = 8000): Promise<T> {
  const token = await whoopToken();
  return mitWiederholung("whoop.get", async () => {
    const res = await fetch(`${WHOOP_API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new HttpFehler(`WHOOP HTTP ${res.status} (${path.split("?")[0]})`, res.status, retryAfterAusHeader(res.headers));
    return (await res.json()) as T;
  }, { versuche: 2, komponente: "whoop", ..._testOptionen });
}

interface RecoveryRecord {
  created_at: string;
  score_state: "SCORED" | "PENDING_SCORE" | "UNSCORABLE";
  score?: { recovery_score: number; resting_heart_rate: number; hrv_rmssd_milli: number; user_calibrating: boolean };
}

/** Heutige Recovery, sobald WHOOP sie fertig berechnet hat, sonst null. */
export async function recoveryToday(timeoutMs?: number): Promise<Recovery | null> {
  const d = day();
  if (d.recovery) return d.recovery;
  const { records } = await whoopGet<{ records: RecoveryRecord[] }>("/v2/recovery?limit=1", timeoutMs);
  const r = records[0];
  if (!r || r.score_state !== "SCORED" || !r.score || todayKey(new Date(r.created_at)) !== d.date) return null;
  d.recovery = {
    score: Math.round(r.score.recovery_score),
    hrv: Math.round(r.score.hrv_rmssd_milli),
    rhr: Math.round(r.score.resting_heart_rate),
    calibrating: r.score.user_calibrating,
    createdAt: r.created_at,
  };
  save();
  return d.recovery;
}

interface WorkoutRecord {
  id: string;
  start: string;
  end: string;
  sport_name: string;
  score_state: string;
  score?: { strain: number; average_heart_rate: number };
}

/** Letztes abgeschlossenes und bewertetes Workout von heute, sonst null. */
export async function latestWorkoutToday(): Promise<Workout | null> {
  const { start } = dayBounds();
  const { records } = await whoopGet<{ records: WorkoutRecord[] }>(
    `/v2/activity/workout?limit=5&start=${encodeURIComponent(start.toISOString())}`,
  );
  const w = records.find((r) => r.score_state === "SCORED" && new Date(r.end) <= new Date());
  return w
    ? { id: w.id, sport: w.sport_name, start: w.start, end: w.end, strain: w.score?.strain ?? null, avgHr: w.score?.average_heart_rate ?? null }
    : null;
}

// =====================================================================
// Telegram (optional): Briefing zusätzlich als Text
// =====================================================================

interface TelegramAntwort {
  ok?: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/** Notaus oder Notfall: dann geht keine Briefing-Kopie mehr hinaus (der Chat könnte übernommen sein). */
const gesperrt = (): boolean => Boolean(state.paused) || Boolean(state.notfall?.aktiv);

/**
 * Briefing an Telegram: wie telegram.ts vier Versuche (1 s → 15 s), nie bei client/auth; Fehler als HttpFehler mit Status und Retry-After.
 * Notaus/Notfall wird vor jedem Versuch geprüft, auch nach der Wartezeit: dann Abbruch mit dem letzten echten Fehler, nichts zugestellt.
 */
export async function sendTelegram(text: string): Promise<void> {
  const token = opt("TELEGRAM_BOT_TOKEN");
  const chatId = opt("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return;
  if (gesperrt()) throw new Error("Notaus oder Notfall aktiv: Briefing-Kopie zurückgehalten.");
  let letzter: unknown;
  await mitWiederholung("telegram.sendMessage", async () => {
    if (letzter !== undefined && gesperrt()) throw letzter;
    try {
      await briefingSenden(token, chatId, text);
    } catch (e) {
      letzter = e;
      throw e;
    }
  }, {
    versuche: 4, basisMs: 1000, maxMs: 15_000, komponente: "telegram", ..._testOptionen,
    wiederholen: (e) => voruebergehend(e) && !gesperrt(),
  });
}

async function briefingSenden(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(8000),
  });
  let json: TelegramAntwort | undefined;
  try {
    json = (await res.json()) as TelegramAntwort;
  } catch {
    json = undefined; // kein JSON (z. B. Proxy-Seite) → Status entscheidet
  }
  if (!json || typeof json !== "object") {
    if (!res.ok) throw new HttpFehler(`Telegram HTTP ${res.status}`, res.status, retryAfterAusHeader(res.headers));
    return;
  }
  if (!res.ok || !json.ok) {
    const status = typeof json.error_code === "number" ? json.error_code : res.status;
    const retryAfter = json.parameters?.retry_after;
    throw new HttpFehler(
      `Telegram HTTP ${status}${json.description ? ` (${json.description})` : ""}`,
      status,
      typeof retryAfter === "number" && retryAfter > 0 ? retryAfter * 1000 : undefined,
    );
  }
}
