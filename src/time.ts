import { TZ } from "./config.js";

/** Datum als YYYY-MM-DD in Schweizer Zeit */
export function todayKey(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Beginn und Ende des heutigen Tages */
export function dayBounds(d = new Date()): { start: Date; end: Date } {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

export function clock(d: Date): string {
  return d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

export function minutesOfDay(d = new Date()): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function hhmm(s: string): number {
  const [h = 0, m = 0] = s.split(":").map(Number);
  return h * 60 + m;
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout nach ${ms} ms`)), ms).unref()),
  ]);
}

/**
 * Liegt `now` im Nachholfenster [ziel, ziel + fensterMin) der Uhrzeit `zielHHMM`?
 * Das Fenster endet spätestens am Tagesende (kein Übertrag auf den nächsten Tag); fensterMin ≤ 1 heisst: nur zur Minute.
 */
export function imFenster(zielHHMM: string, now: Date, fensterMin: number): boolean {
  if (!/^\d{1,2}:\d{2}$/.test(zielHHMM.trim())) return false;
  const ziel = hhmm(zielHHMM.trim());
  if (ziel < 0 || ziel >= 24 * 60) return false;
  const ende = Math.min(ziel + Math.max(1, Math.floor(fensterMin) || 0), 24 * 60);
  const jetzt = minutesOfDay(now);
  return ziel <= jetzt && jetzt < ende;
}
