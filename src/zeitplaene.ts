import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { gesperrtText, ladeListe } from "./datei.js";
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
const geladen = ladeListe<Zeitplan>(FILE, "Zeitpläne");
export const zeitplaene: Zeitplan[] = geladen.liste;
/** true, wenn data/zeitplaene.json vorhanden, aber unlesbar war: keine Zeitpläne, und nichts wird gespeichert. */
export const zeitplaeneNichtGeladen = geladen.nichtGeladen;
export const ZEITPLAENE_UNLESBAR =
  "⚠️ data/zeitplaene.json war beim Start unlesbar, Sir (Sicherung, sofern möglich, unter data/zeitplaene.json.defekt). Die Zeitpläne laufen nicht, und ich ändere keine, bis die Datei repariert ist und ich neu gestartet bin.";

/** Vor jeder Änderung an zeitplaene aufrufen: wirft, solange die Datei beim Start unlesbar war. */
export function pruefeZeitplaeneSchreibbar(): void {
  if (zeitplaeneNichtGeladen) throw new Error(gesperrtText(FILE, "keine Zeitpläne"));
}

/** IDs, die schon gespeichert waren (Stand beim Laden bzw. beim letzten Speichern) – alles andere ist neu angelegt. */
let gespeicherteIds = new Set(zeitplaene.map((z) => z.id));

/**
 * Speichert atomar. Neu angelegte Einträge (ID beim letzten Speichern unbekannt, noch nie gelaufen) bekommen dabei
 * `angelegt`, damit ein Zeitplan, dessen Uhrzeit heute schon vorbei ist, nicht sofort «nachgeholt» wird.
 */
export function saveZeitplaene(jetzt = new Date()): void {
  pruefeZeitplaeneSchreibbar();
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

// ---------- Prüfung (Werkzeug und Kommandozentrale, gleiche Regeln) ----------

export type ZeitplanEingabe = Pick<Zeitplan, "name" | "zeit" | "tage" | "auftrag">;
export type Pruefung<T> = { ok: true; wert: T } | { ok: false; fehler: Record<string, string> };

const WOCHE = ["mo", "di", "mi", "do", "fr", "sa", "so"];

/** Normalisiert «Mo, Mi» → «mo,mi» (Wochenreihenfolge); undefined, wenn die Angabe nicht gilt. */
function normaleTage(roh: string): string | undefined {
  const t = roh.toLowerCase().replace(/\s/g, "");
  if (t === "taeglich" || t === "täglich") return "taeglich";
  if (t === "werktags") return "werktags";
  const teile = t.split(",");
  if (teile.length === 0 || teile.some((x) => !WOCHE.includes(x))) return undefined;
  if (new Set(teile).size !== teile.length) return undefined;
  return WOCHE.filter((x) => teile.includes(x)).join(",");
}

/**
 * Prüft einen Zeitplan, bevor er angelegt oder geändert wird: name 1–60, zeit HH:MM (00:00–23:59), tage taeglich |
 * werktags | Liste aus mo,di,mi,do,fr,sa,so ohne Doppel, auftrag 1–2000 Zeichen. Rein; Fehler je Feld auf Deutsch.
 */
export function pruefeZeitplan(eingabe: unknown): Pruefung<ZeitplanEingabe> {
  const e = (eingabe && typeof eingabe === "object" ? eingabe : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const fehler: Record<string, string> = {};
  const name = text(e.name);
  if (name.length < 1 || name.length > 60) fehler.name = "Name: 1 bis 60 Zeichen, Sir.";
  const zeit = text(e.zeit);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(zeit)) fehler.zeit = "Uhrzeit als HH:MM zwischen 00:00 und 23:59, Sir.";
  const tage = normaleTage(text(e.tage));
  if (!tage) fehler.tage = "Tage: taeglich, werktags oder Wochentage wie mo,mi,fr (ohne Doppel), Sir.";
  const auftrag = text(e.auftrag);
  if (auftrag.length < 1 || auftrag.length > 2000) fehler.auftrag = "Auftrag: 1 bis 2000 Zeichen, Sir.";
  if (Object.keys(fehler).length > 0) return { ok: false, fehler };
  return { ok: true, wert: { name, zeit, tage: tage!, auftrag } };
}

/** Alle Fehlermeldungen in einem Satz (für Werkzeug-Antworten). */
export const pruefungsText = (fehler: Record<string, string>): string => Object.values(fehler).join(" ");

/**
 * Nächster Lauf nach derselben Tageslogik wie faelligIm: passender Tag, heute schon gelaufen, heute zu spät angelegt.
 * Liegt ein Lauf im Nachholfenster noch offen, ist er «jetzt» fällig (der Scheduler holt ihn im nächsten Takt nach).
 * Lokale Zeit wie der Scheduler (TZ Europe/Zurich, config.ts). undefined bei ungültiger Uhrzeit oder Tagesangabe.
 */
export function naechsterLauf(z: Zeitplan, now: Date, fensterMin = 0): Date | undefined {
  const zeit = z.zeit.trim();
  if (!/^\d{1,2}:\d{2}$/.test(zeit)) return undefined;
  const [h, m] = zeit.split(":").map(Number);
  if (h > 23 || m > 59) return undefined;
  if (faelligIm(z, now, fensterMin)) return now;
  const heuteOffen = z.lastRun !== todayKey(now) && !heuteZuSpaetAngelegt(z, now) && hhmm(zeit) > minutesOfDay(now);
  for (let tag = heuteOffen ? 0 : 1; tag <= 7; tag++) {
    const kandidat = new Date(now.getFullYear(), now.getMonth(), now.getDate() + tag, h, m, 0, 0);
    if (tagPasst(z, kandidat)) return kandidat;
  }
  return undefined;
}
