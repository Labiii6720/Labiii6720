import { chmodSync, constants, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { istNurLesen } from "./datei.js";
import type { NotfallStatus } from "./notfall.js";
import { todayKey } from "./time.js";

const DIR = "data";
const FILE = `${DIR}/state.json`;
/** Unlesbare state.json wird hierhin kopiert; liegt dort schon eine ältere Sicherung, mit Zeitstempel daneben */
const SICHERUNG_DEFEKT = `${FILE}.defekt`;

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
  briefing?: {
    text: string;
    builtAt: string;
    workoutId?: string;
    /** Versionsmarke des Caches (brain.ts BRIEFING_VERSION) */
    v?: number;
  };
  briefingDelivered?: boolean;
  /** Briefing am Satelliten (Bad) ohne Telegram-Kopie vorgelesen: morningTick baut nicht mehr neu */
  briefingVorgelesen?: boolean;
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
  /** Nächste freie Zeitplan-ID (zeitplaene.ts); gelöschte werden nie neu vergeben. */
  naechsteZeitplanId?: number;
  /** Nächste freie Wachen-ID (cameras.ts); gelöschte werden nie neu vergeben. */
  naechsteWacheId?: number;
  /**
   * Untergrenze für neue Auftragsnummern (queue.ts): nach jedem Anlegen die nächste Nummer, dazu beim Start die über
   * verworfenen Einträgen. Hält die Nummern auch dann eindeutig, wenn data/auftraege.json entfernt oder ersetzt wurde.
   */
  naechsteAuftragId?: number;
}

/** Vorhandene Sicherung mit genau diesem Inhalt (jeder Prozessstart – Dienst, check, setup, Auth-Skripte – lädt neu). */
function gleicheSicherung(inhalt: Buffer): string | undefined {
  const name = SICHERUNG_DEFEKT.slice(DIR.length + 1);
  for (const f of readdirSync(DIR).filter((f) => f === name || f.startsWith(`${name}-`)).sort()) {
    try {
      if (readFileSync(`${DIR}/${f}`).equals(inhalt)) return `${DIR}/${f}`;
    } catch {
      // unlesbare Sicherung: nicht als Treffer zählen
    }
  }
  return undefined;
}

/**
 * Kopiert die unlesbare Datei unter einen freien Namen (0o600, eine ältere Sicherung bleibt unberührt). Liegt derselbe
 * Inhalt schon gesichert vor, wird keine weitere Kopie angelegt.
 */
function sichereDefekt(): string | undefined {
  try {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const vorhanden = gleicheSicherung(readFileSync(FILE));
    if (vorhanden) return vorhanden;
    const stempel = new Date().toISOString().replace(/[:.]/g, "-");
    for (let n = 0; n < 100; n++) {
      const nach = n === 0 ? SICHERUNG_DEFEKT : `${SICHERUNG_DEFEKT}-${stempel}${n > 1 ? `-${n}` : ""}`;
      try {
        // EXCL: nie eine vorhandene Sicherung überschreiben, auch nicht bei gleichzeitigem Start
        copyFileSync(FILE, nach, constants.COPYFILE_EXCL);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
      chmodSync(nach, 0o600);
      return nach;
    }
    throw new Error("kein freier Name für die Sicherung");
  } catch (e) {
    // Nur Code/Meldung des Dateisystems, nie Dateiinhalt (Tokens)
    console.error("Zustands-Sicherung fehlgeschlagen:", (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : e));
    return undefined;
  }
}

/**
 * true, wenn data/state.json vorhanden, aber nicht lesbar war (Rechte, abgeschnittene Datei, SD-Karte …). Jarvis startet
 * dann im Notfall (Notaus an), und `save()` schreibt nichts: sonst ersetzte der nächste `day()`-Aufruf die Datei samt
 * WHOOP- und Google-Tokens durch {day:…}, und ein vorher aktiver Notfall oder Notaus wäre stillschweigend aufgehoben.
 */
export let stateNichtGeladen = false;

/** Ursache und Sicherungskopie, wenn `stateNichtGeladen` gilt (nie Dateiinhalt). */
export let zustandDefekt: { ursache: string; kopie?: string } | undefined;

function load(): State {
  let text: string;
  try {
    text = readFileSync(FILE, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    return sichererStart((e as NodeJS.ErrnoException).code ?? "Lesefehler");
  }
  try {
    const wert: unknown = JSON.parse(text);
    if (wert && typeof wert === "object" && !Array.isArray(wert)) return wert as State;
    return sichererStart("kein Objekt");
  } catch {
    return sichererStart("kein gültiges JSON");
  }
}

/**
 * Unlesbarer Zustand: wir wissen nicht, ob Notfall oder Notaus lief, also gilt der strengste Fall.
 * Nur lesen (npm run check): keine Sicherung, nur der Hinweis; sichern tut der Dienst beim Start.
 */
function sichererStart(ursache: string): State {
  stateNichtGeladen = true;
  if (istNurLesen()) {
    zustandDefekt = { ursache };
    console.error(`Zustand unlesbar (${ursache}) – nur gelesen, keine Sicherung angelegt. Der Dienst startet damit im Notfall, bis ${FILE} repariert ist.`);
  } else {
    const kopie = sichereDefekt();
    zustandDefekt = { ursache, ...(kopie ? { kopie } : {}) };
    console.error(
      `Zustand unlesbar (${ursache}) – ${kopie ? `Kopie unter ${kopie}` : "Sicherung fehlgeschlagen"}. Jarvis startet im Notfall und speichert keinen Zustand, bis ${FILE} repariert ist und Jarvis neu startet.`,
    );
  }
  return {
    paused: true,
    notfall: { aktiv: true, seit: new Date().toISOString(), grund: "state.json unlesbar" },
  };
}

export const state: State = load();

/**
 * Hinweis für den Nutzer (Telegram beim Start, /status, /entwarnung, /check), solange `stateNichtGeladen` gilt; sonst
 * undefined. Sagt ausdrücklich, dass kein Angriff erkannt wurde, damit niemand grundlos die Notfall-Checkliste abarbeitet.
 */
export function zustandsHinweis(): string | undefined {
  if (!zustandDefekt) return undefined;
  const { ursache, kopie } = zustandDefekt;
  const rechte = ursache === "EACCES" || ursache === "EPERM";
  return [
    `⚠️ ${FILE} war beim Start unlesbar (${ursache}; ${kopie ? `Kopie unter ${kopie}` : "Sicherung fehlgeschlagen"}).`,
    "Kein Angriff erkannt, nur der Zustand fehlt. Ich bin vorsorglich im Notfall und speichere keinen Zustand (Modus, Notaus, Tokens, Tageszustand), bis die Datei repariert ist und ich neu gestartet bin.",
    rechte
      ? `Vermutlich gehört die Datei nicht dem Dienst-Benutzer (etwa nach sudo): sudo chown jarvis: ${FILE}, dann neu starten.`
      : `Datei reparieren oder entfernen, neu starten, danach npm run whoop:auth und npm run google:auth.`,
    "/entwarnung hebt den Notfall nur bis zum nächsten Neustart auf, Sir.",
  ].join("\n");
}

/**
 * Für die Auth-Skripte vor dem Token-Tausch: wirft, solange nichts gespeichert wird. Sonst wäre der einmalige
 * Autorisierungscode verbraucht und der Token nach Prozessende verloren, obwohl «verbunden» gemeldet wurde.
 */
export function pruefeZustandSpeicherbar(): void {
  if (stateNichtGeladen) throw new Error(`${FILE} ist unlesbar, ich speichere keinen Zustand. Erst die Datei reparieren oder entfernen.`);
}

let sperreGemeldet = false;

/**
 * Speichert atomar (nie eine halb geschriebene Datei) und nur für deinen Benutzer lesbar.
 * War state.json beim Start unlesbar, wird nichts geschrieben (nur gemeldet, nicht geworfen: Aufrufer wie der
 * Notfall-Alarm sollen weiterlaufen, der Zustand im Speicher bleibt gültig).
 * Nur lesen (npm run check): nie schreiben. Sonst ersetzte der Selbsttest mit seinem Stand vom Prozessstart, was der
 * laufende Dienst inzwischen gespeichert hat (Notfall, Notaus, Auftragszähler, WHOOP-Token).
 */
export function save(): void {
  if (istNurLesen()) return;
  if (stateNichtGeladen) {
    if (!sperreGemeldet) {
      sperreGemeldet = true;
      console.error(`${FILE} war beim Start unlesbar – ich speichere keinen Zustand, bis die Datei repariert ist und Jarvis neu startet.`);
    }
    return;
  }
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
