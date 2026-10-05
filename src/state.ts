import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { NotfallStatus } from "./notfall.js";
import { todayKey } from "./time.js";

const DIR = "data";
const FILE = `${DIR}/state.json`;

export interface Recovery {
  score: number;
  hrv: number;
  rhr: number;
  calibrating: boolean;
  createdAt: string;
}

export interface Workout {
  id: string;
  sport: string;
  start: string;
  end: string;
  strain: number | null;
  avgHr: number | null;
}

export interface DayState {
  date: string;
  recovery?: Recovery;
  workout?: Workout;
  cardioDelivered?: boolean;
  briefing?: { text: string; builtAt: string; workoutId?: string };
  briefingDelivered?: boolean;
}

export type Mode = "normal" | "fokus" | "nacht";

export interface State {
  whoop?: { refreshToken: string; accessToken?: string; expiresAt?: number };
  google?: { refreshToken: string };
  mode?: Mode;
  /** Notaus: keine Werkzeuge, keine Zeitpläne, keine Wachen, bis /weiter */
  paused?: boolean;
  notfall?: NotfallStatus;
  day?: DayState;
}

function load(): State {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as State;
  } catch {
    return {};
  }
}

export const state: State = load();

/** Speichert atomar (nie eine halb geschriebene Datei) und nur für deinen Benutzer lesbar. */
export function save(): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
}

/** Zustand des heutigen Tages; beginnt um Mitternacht automatisch neu. */
export function day(): DayState {
  const date = todayKey();
  let d = state.day;
  if (!d || d.date !== date) {
    d = { date };
    state.day = d;
    save();
  }
  return d;
}
