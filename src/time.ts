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
