import { chmodSync, constants, copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Wache } from "./cameras.js";
import type { Vorgang } from "./vorgaenge.js";
import type { Zeitplan } from "./zeitplaene.js";

/**
 * Gemeinsamer Lader für Listen-Dateien in data/ (Zeitpläne, Wachen, Erinnerungen, Postausgang, Vorgänge).
 * Eine fehlende Datei heisst «leer». Jede andere unlesbare Datei setzt `nichtGeladen`: Der Aufrufer darf dann
 * nicht speichern, sonst ersetzte die nächste Änderung den ganzen Bestand. Inhalt geht nie ins Log.
 *
 * Einträge prüft jede Liste hier an einer Stelle (Eintragsprüfungen unten): Was keine gültige Form hat (null, Zahl,
 * Text, fehlende Pflichtfelder, falsche Typen – von Hand bearbeitet oder verdorben), wird beim Laden übersprungen.
 * Die Datei wird dann vor jeder Änderung einmal gesichert (`<datei>.defekt`), die Anzahl geloggt und als Hinweis
 * bereitgestellt (eintragsHinweise: Telegram /status, Startmeldung, npm run check). Die gültigen Einträge laufen
 * normal, und Speichern bleibt erlaubt: die verworfenen Einträge liegen in der Sicherung.
 */
export interface GeladeneListe<T> {
  liste: T[];
  nichtGeladen: boolean;
  /** Beim Laden übersprungene Einträge (0 ohne Eintragsprüfung) */
  verworfen: number;
}

/** Reine Prüfung eines Eintrags: der (ggf. normalisierte) Eintrag oder undefined, wenn er nicht gilt. */
export type Eintragspruefung<T> = (roh: unknown) => T | undefined;

/** Ältere, gleiche Sicherung derselben Datei (`<datei>.defekt` oder `<datei>.defekt-…`), sonst undefined. */
function gleicheSicherung(datei: string): string | undefined {
  try {
    const inhalt = readFileSync(datei);
    const ordner = dirname(datei);
    const praefix = `${basename(datei)}.defekt`;
    for (const name of readdirSync(ordner).sort()) {
      if (name !== praefix && !name.startsWith(`${praefix}-`)) continue;
      const pfad = join(ordner, name);
      try {
        if (readFileSync(pfad).equals(inhalt)) return pfad;
      } catch {
        // kein lesbarer Dateiinhalt (z. B. Ordner): keine passende Sicherung
      }
    }
  } catch {
    // Datei oder Ordner nicht lesbar: dann eben eine neue Sicherung versuchen
  }
  return undefined;
}

/**
 * Kopiert die Datei unter einen freien Namen (0o600); eine ältere Sicherung bleibt unberührt. Mit
 * `gleicheWiederverwenden` gilt eine schon vorhandene Sicherung mit genau diesem Inhalt (ein Neustart ohne Änderung
 * an der Datei legt so nicht bei jedem Start eine weitere Kopie an).
 */
export function sichereDefekt(datei: string, optionen: { gleicheWiederverwenden?: boolean } = {}): string | undefined {
  if (optionen.gleicheWiederverwenden) {
    const vorhanden = gleicheSicherung(datei);
    if (vorhanden) return vorhanden;
  }
  const ziel = `${datei}.defekt`;
  try {
    mkdirSync("data", { recursive: true, mode: 0o700 });
    const stempel = new Date().toISOString().replace(/[:.]/g, "-");
    for (let n = 0; n < 100; n++) {
      const nach = n === 0 ? ziel : `${ziel}-${stempel}${n > 1 ? `-${n}` : ""}`;
      try {
        copyFileSync(datei, nach, constants.COPYFILE_EXCL);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
      chmodSync(nach, 0o600);
      return nach;
    }
    throw new Error("kein freier Name für die Sicherung");
  } catch (e) {
    console.error(`Sicherung von ${datei} fehlgeschlagen:`, (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : "Fehler"));
    return undefined;
  }
}

/** Rein: gültige (ggf. normalisierte) Einträge und die Anzahl der verworfenen. Eine werfende Prüfung zählt als ungültig. */
export function gueltigeEintraege<T>(roh: readonly unknown[], pruefe: Eintragspruefung<T>): { gueltig: T[]; verworfen: number } {
  const gueltig: T[] = [];
  for (const eintrag of roh) {
    let wert: T | undefined;
    try {
      wert = pruefe(eintrag);
    } catch {
      wert = undefined;
    }
    if (wert !== undefined) gueltig.push(wert);
  }
  return { gueltig, verworfen: roh.length - gueltig.length };
}

type Gelesen = { zustand: "fehlt" } | { zustand: "nicht_lesbar"; code: string } | { zustand: "kaputt" } | { zustand: "ok"; roh: unknown[] };

function leseListe(datei: string): Gelesen {
  let text: string;
  try {
    text = readFileSync(datei, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "Fehler";
    return code === "ENOENT" ? { zustand: "fehlt" } : { zustand: "nicht_lesbar", code };
  }
  try {
    const roh = JSON.parse(text) as unknown;
    return Array.isArray(roh) ? { zustand: "ok", roh } : { zustand: "kaputt" };
  } catch {
    return { zustand: "kaputt" };
  }
}

// ---------- Hinweise auf übersprungene Einträge ----------

/** Übersprungene Einträge je Datei (letzter Ladevorgang); `sicherung: false` = Jarvis schreibt die Datei nie (cameras.json). */
const uebersprungen = new Map<string, { anzahl: number; sicherung: string | false }>();

const anzahlText = (n: number): string => (n === 1 ? "1 ungültiger Eintrag" : `${n} ungültige Einträge`);

/** Merkt sich die Anzahl übersprungener Einträge für die Hinweise (0 löscht den Vermerk). Nie Inhalt. */
export function vermerkeUebersprungen(datei: string, anzahl: number, sicherung: string | false): void {
  if (anzahl > 0) uebersprungen.set(datei, { anzahl, sicherung });
  else uebersprungen.delete(datei);
}

/** Anzahl der beim letzten Laden übersprungenen Einträge dieser Datei (0, wenn keine). */
export const uebersprungenAnzahl = (datei: string): number => uebersprungen.get(datei)?.anzahl ?? 0;

/**
 * Hinweise für Telegram (/status, Startmeldung über dateiHinweise) und den Selbsttest: je Datei die Anzahl der beim
 * Start übersprungenen Einträge und die Sicherung, nie der Inhalt. Gilt bis zum nächsten Neustart.
 */
export function eintragsHinweise(): string[] {
  return [...uebersprungen].map(([datei, u]) =>
    u.sicherung === false
      ? `⚠️ ${datei}: ${anzahlText(u.anzahl)} beim Start übersprungen, Sir. Die übrigen laufen normal; die Datei selbst ändere ich nicht, bitte von Hand reparieren.`
      : `⚠️ ${datei}: ${anzahlText(u.anzahl)} beim Start übersprungen, Sir (Sicherung unter ${u.sicherung}). Die übrigen laufen normal; speichere ich die Liste, fehlen die übersprungenen danach auch in der Datei.`,
  );
}

/**
 * `name` erscheint im Log («Zeitpläne unlesbar …»). Mit `pruefe` fallen ungültige Einträge weg (siehe oben). Scheitert
 * dabei die Sicherung, gilt die Datei wie eine unlesbare (nichtGeladen, Speichern gesperrt): sonst verlöre die nächste
 * Änderung die übersprungenen Einträge endgültig.
 */
export function ladeListe<T>(datei: string, name: string, pruefe?: Eintragspruefung<T>): GeladeneListe<T> {
  if (pruefe) vermerkeUebersprungen(datei, 0, false);
  const gelesen = leseListe(datei);
  if (gelesen.zustand === "fehlt") return { liste: [], nichtGeladen: false, verworfen: 0 };
  if (gelesen.zustand === "nicht_lesbar") {
    console.error(`${name} nicht lesbar (${gelesen.code}) – Jarvis startet ohne ${datei} und speichert die Datei nicht, bis sie wieder lesbar ist und Jarvis neu startet.`);
    return { liste: [], nichtGeladen: true, verworfen: 0 };
  }
  if (gelesen.zustand === "kaputt") {
    const kopie = sichereDefekt(datei);
    console.error(
      `${name} unlesbar – ${kopie ? `Kopie unter ${kopie}` : "Sicherung fehlgeschlagen"}. Jarvis startet ohne ${datei} und speichert die Datei nicht, bis sie repariert ist und Jarvis neu startet.`,
    );
    return { liste: [], nichtGeladen: true, verworfen: 0 };
  }
  if (!pruefe) return { liste: gelesen.roh as T[], nichtGeladen: false, verworfen: 0 };
  const { gueltig, verworfen } = gueltigeEintraege(gelesen.roh, pruefe);
  if (verworfen === 0) return { liste: gueltig, nichtGeladen: false, verworfen: 0 };
  const kopie = sichereDefekt(datei, { gleicheWiederverwenden: true });
  if (!kopie) {
    console.error(
      `${name} unlesbar (${anzahlText(verworfen)}, Sicherung fehlgeschlagen) – Jarvis startet ohne ${datei} und speichert die Datei nicht, bis sie repariert ist und Jarvis neu startet.`,
    );
    return { liste: [], nichtGeladen: true, verworfen };
  }
  console.error(
    `${name}: ${anzahlText(verworfen)} übersprungen (Sicherung unter ${kopie}). Die übrigen ${gueltig.length} sind geladen; beim nächsten Speichern fehlen die übersprungenen in ${datei}.`,
  );
  vermerkeUebersprungen(datei, verworfen, kopie);
  return { liste: gueltig, nichtGeladen: false, verworfen };
}

/**
 * Nur lesen, nichts sichern, nichts loggen (npm run check): Zustand der Datei und wie viele Einträge die Prüfung
 * verwerfen würde. Im laufenden Dienst zeigt das den Stand der Datei jetzt, nicht beim Start.
 */
export function untersucheListe(datei: string, pruefe: Eintragspruefung<unknown>): { zustand: "fehlt" | "unlesbar" | "ok"; eintraege: number; verworfen: number } {
  const gelesen = leseListe(datei);
  if (gelesen.zustand === "fehlt") return { zustand: "fehlt", eintraege: 0, verworfen: 0 };
  if (gelesen.zustand !== "ok") return { zustand: "unlesbar", eintraege: 0, verworfen: 0 };
  const { gueltig, verworfen } = gueltigeEintraege(gelesen.roh, pruefe);
  return { zustand: "ok", eintraege: gueltig.length, verworfen };
}

/** Fehlertext für gesperrtes Speichern (Jarvis-Ton). */
export const gesperrtText = (datei: string, was: string): string =>
  `${datei} war beim Start unlesbar, Sir. Ich ändere ${was} nicht, bis die Datei repariert ist und ich neu gestartet bin – sonst wäre der Bestand weg.`;

// ---------- Eintragsprüfungen (eine Stelle für alle Listen) ----------
//
// Geprüft werden Form und Typen der Felder, ohne die der Code abstürzt oder «undefined» zeigt. Ungültige Werte mit
// richtigem Typ (Uhrzeit «25:00», Tage «montags», unbekannte Kamera, Intervall 0, leere Frage, falsches «nur_wenn»)
// bleiben stehen: Scheduler und Wachen-Takt lassen sie nicht laufen, und Kommandozentrale und Werkzeuge zeigen sie mit
// Grund, damit man sie dort ändern oder löschen kann. Optionale Felder prüfen die Nutzer selbst (zweite Verteidigung).

const istObjekt = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const istText = (v: unknown): v is string => typeof v === "string";
const istId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const istZeitpunkt = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

/** Zahl oder Ziffernfolge («15», «7.5») als Zahl, sonst undefined. Grundlage von taktMinuten (cameras.ts). */
export function zahlOderZiffern(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** data/zeitplaene.json: id ganzzahlig > 0, name, zeit, tage und auftrag als Text. */
export function zeitplanEintrag(roh: unknown): Zeitplan | undefined {
  if (!istObjekt(roh) || !istId(roh.id)) return undefined;
  if (!istText(roh.name) || !istText(roh.zeit) || !istText(roh.tage) || !istText(roh.auftrag)) return undefined;
  return roh as unknown as Zeitplan;
}

/** Gemeinsamer Teil der Wachen (data/wachen.json und «wachen» in cameras.json): frage als Text, alle_minuten als Zahl. */
function wacheKern(roh: unknown): Record<string, unknown> | undefined {
  if (!istObjekt(roh) || !istText(roh.frage)) return undefined;
  const alle = zahlOderZiffern(roh.alle_minuten);
  if (alle === undefined) return undefined;
  // Ziffernfolge («15») wie bisher als Takt gelten lassen, aber als Zahl weiterreichen
  return alle === roh.alle_minuten ? roh : { ...roh, alle_minuten: alle };
}

/** data/wachen.json: id ganzzahlig > 0, kamera und frage als Text, alle_minuten als Zahl; nur_wenn und ruhe_minuten optional. */
export function wacheEintrag(roh: unknown): Wache | undefined {
  if (!istObjekt(roh) || !istId(roh.id) || !istText(roh.kamera)) return undefined;
  return wacheKern(roh) as Wache | undefined;
}

/** «wachen» einer Kamera in cameras.json: wie wacheEintrag, aber ohne id und kamera (die Kamera ist der Schlüssel). */
export function kameraWacheEintrag(roh: unknown): Record<string, unknown> | undefined {
  return wacheKern(roh);
}

/** data/erinnerungen.json: at als lesbarer Zeitpunkt, text als Text (sonst «⏰ undefined» oder nie fällig). */
export function erinnerungEintrag(roh: unknown): { at: string; text: string } | undefined {
  if (!istObjekt(roh) || !istZeitpunkt(roh.at) || !istText(roh.text)) return undefined;
  return roh as { at: string; text: string };
}

const VORGANG_STATUS: readonly unknown[] = ["läuft", "fertig", "fehler"];

/** data/vorgaenge.json: id ganzzahlig > 0, auftrag und startedAt als Text, status bekannt, steps als Zahl. */
export function vorgangEintrag(roh: unknown): Vorgang | undefined {
  if (!istObjekt(roh) || !istId(roh.id) || !istText(roh.auftrag) || !istText(roh.startedAt)) return undefined;
  if (!VORGANG_STATUS.includes(roh.status) || typeof roh.steps !== "number" || !Number.isFinite(roh.steps)) return undefined;
  return roh as unknown as Vorgang;
}

/**
 * data/postausgang.json: ts als lesbarer Zeitpunkt (sonst wirft clock() beim Nachreichen, und der ganze Postausgang
 * stünde still), text als Text; «vorrang» zählt nur als true.
 */
export function postausgangEintrag(roh: unknown): { ts: string; text: string; vorrang?: true } | undefined {
  if (!istObjekt(roh) || !istZeitpunkt(roh.ts) || !istText(roh.text)) return undefined;
  return roh.vorrang === true ? { ts: roh.ts, text: roh.text, vorrang: true } : { ts: roh.ts, text: roh.text };
}

/** Alle Listen mit ihrer Prüfung (Selbsttest). Die Module laden mit denselben Pfaden und Prüfungen. */
export const LISTEN: readonly { datei: string; name: string; pruefe: Eintragspruefung<unknown> }[] = [
  { datei: "data/zeitplaene.json", name: "Zeitpläne", pruefe: zeitplanEintrag },
  { datei: "data/wachen.json", name: "Wachen", pruefe: wacheEintrag },
  { datei: "data/erinnerungen.json", name: "Erinnerungen", pruefe: erinnerungEintrag },
  { datei: "data/vorgaenge.json", name: "Vorgänge", pruefe: vorgangEintrag },
  { datei: "data/postausgang.json", name: "Postausgang", pruefe: postausgangEintrag },
];
