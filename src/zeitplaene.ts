import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

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
}

const FILE = "data/zeitplaene.json";
export const zeitplaene: Zeitplan[] = (() => {
  try { return JSON.parse(readFileSync(FILE, "utf8")) as Zeitplan[]; } catch { return []; }
})();

export function saveZeitplaene(): void {
  mkdirSync("data", { recursive: true, mode: 0o700 });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(zeitplaene, null, 2), { mode: 0o600 });
  renameSync(`${FILE}.tmp`, FILE);
}

const TAGE = ["so", "mo", "di", "mi", "do", "fr", "sa"];

export function faelltAn(z: Zeitplan, now: Date): boolean {
  const tag = TAGE[now.getDay()]!;
  const t = z.tage.toLowerCase().replace(/\s/g, "");
  if (t === "werktags" && (tag === "sa" || tag === "so")) return false;
  if (t !== "taeglich" && t !== "täglich" && t !== "werktags" && !t.split(",").includes(tag)) return false;
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return hhmm === z.zeit;
}
