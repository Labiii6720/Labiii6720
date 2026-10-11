import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hhmm, imFenster, minutesOfDay, todayKey } from "./time.js";

/** Wiederkehrende Aufgaben, die Jarvis von selbst erledigt und per Telegram meldet. */
export interface Zeitplan {
  id: number;
  name: string;
  /** Uhrzeit HH:MM */
  zeit: string;
  /** taeglich, werktags oder Wochentage wie mo,mi,fr */
  tage: string;
  /** Der Auftrag in Worten, so wie du ihn Jarvis im Chat geben würdest */
  auftrag: string;
  lastRun?: string;
  /** Anlagezeitpunkt (ISO), beim ersten Speichern gesetzt – ein Lauf vor der Anlage gilt nicht als verpasst */
  angelegt?: string;
}

const FILE = "data/zeitplaene.json";
export const zeitplaene: Zeitplan[] = (() => {
  try { return JSON.parse(readFileSync(FILE, "utf8")) as Zeitplan[]; } catch { return []; }
})();

/** IDs, die schon gespeichert waren (Stand beim Laden bzw. beim letzten Speichern) – alles andere ist neu angelegt. */
let gespeicherteIds = new Set(zeitplaene.map((z) => z.id));

/**
 * Speichert atomar. Neu angelegte Einträge (ID beim letzten Speichern unbekannt, noch nie gelaufen) bekommen dabei
 * `angelegt`, damit ein Zeitplan, dessen Uhrzeit heute schon vorbei ist, nicht sofort «nachgeholt» wird.
 */
export function saveZeitplaene(jetzt = new Date()): void {
  for (const z of zeitplaene) {
    if (!gespeicherteIds.has(z.id) && z.lastRun === undefined && z.angelegt === undefined) z.angelegt = jetzt.toISOString();
  }
  gespeicherteIds = new Set(zeitplaene.map((z) => z.id));
  mkdirSync("data", { recursive: true, mode: 0o700 });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(zeitplaene, null, 2), { mode: 0o600 });
  renameSync(`${FILE}.tmp`, FILE);
}

const TAGE = ["so", "mo", "di", "mi", "do", "fr", "sa"];

function tagPasst(z: Zeitplan, now: Date): boolean {
  const tag = TAGE[now.getDay()]!;
  const t = z.tage.toLowerCase().replace(/\s/g, "");
  if (t === "werktags" && (tag === "sa" || tag === "so")) return false;
  return t === "taeglich" || t === "täglich" || t === "werktags" || t.split(",").includes(tag);
}

/** Genau zur Minute (Fenster 1 Minute) – bleibt für Kompatibilität. */
export function faelltAn(z: Zeitplan, now: Date): boolean {
  if (!tagPasst(z, now)) return false;
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return hhmm === z.zeit;
}

/** Erst nach der heutigen Uhrzeit angelegt? Dann wurde heute nichts verpasst – der erste Lauf kommt am nächsten passenden Tag. */
function heuteZuSpaetAngelegt(z: Zeitplan, now: Date): boolean {
  if (!z.angelegt) return false;
  const angelegt = new Date(z.angelegt);
  if (Number.isNaN(angelegt.getTime())) return false;
  return todayKey(angelegt) === todayKey(now) && minutesOfDay(angelegt) > hhmm(z.zeit.trim());
}

/**
 * Fällig im Nachholfenster: passender Tag, zeit ≤ jetzt < zeit + fensterMin (Tagesende als Grenze) und heute noch nicht gelaufen.
 * fensterMin 0 = nur zur Minute (kein Nachholen). Ein heute erst nach der Uhrzeit angelegter Zeitplan ist heute nicht fällig.
 */
export function faelligIm(z: Zeitplan, now: Date, fensterMin: number): boolean {
  if (z.lastRun === todayKey(now)) return false;
  if (!tagPasst(z, now)) return false;
  if (heuteZuSpaetAngelegt(z, now)) return false;
  return imFenster(z.zeit, now, fensterMin);
}
