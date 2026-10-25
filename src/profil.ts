import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { istNurLesen, sichereDefekt } from "./datei.js";
import { todayKey } from "./time.js";

/**
 * Langzeitgedächtnis über den Nutzer – das «Lernen». KEINE Selbstmodifikation von Code oder Regeln,
 * nur strukturiertes Wissen, das Jarvis pflegt und in jede Antwort einfliessen lässt.
 *
 *   ziele        was der Nutzer erreichen will (mit Zieldatum, Status)
 *   werte        Prinzipien und Prioritäten, an denen Entscheidungen gemessen werden
 *   muster       beobachtete Entscheidungsmuster (nur aus belegten Beobachtungen)
 *   entscheidungen  getroffene Entscheidungen und – später – wie sie ausgingen
 *   fakten       dauerhafte Fakten über den Nutzer, mit Datum; veraltete werden markiert, nicht gelöscht
 *   chronik      verdichtete ältere Entscheidungen je Monat (Details im Archiv data/profil-archiv.jsonl)
 */
export interface Ziel { id: number; text: string; frist?: string; status: "offen" | "erreicht" | "verworfen"; angelegt: string }
export interface Muster { id: number; text: string; belege: string[]; seit: string }
export interface Entscheidung { id: number; datum: string; text: string; ziel?: number; ausgang?: string }
export interface Fakt { id: number; text: string; seit: string /* YYYY-MM-DD */; quelle: "chat" | "verdichtung" | "import"; veraltet?: { seit: string; grund: string } }
export interface Chronik { monat: string /* YYYY-MM */; text: string; entscheidungen: number }

export interface Profil {
  ziele: Ziel[];
  werte: string[];
  muster: Muster[];
  entscheidungen: Entscheidung[];
  fakten: Fakt[];
  chronik: Chronik[];
  /** Tag der letzten Verdichtung: Fakten gehen erst wieder ans Modell, wenn seither einer dazukam */
  letzteVerdichtung?: string;
  /** Höchste je vergebene Entscheidungs-id: die Verdichtung verschiebt Entscheidungen ins Archiv, ihre ids bleiben vergeben */
  entscheidungIdMax?: number;
  /** Höchste je vergebene Fakt-id: zusammengeführte (Archiv) und vergessene Fakten geben ihre id nie wieder frei */
  faktIdMax?: number;
}

/** Fakten bleiben knapp, damit das Systemprompt schlank bleibt */
export const FAKT_MAX_ZEICHEN = 200;

const FILE = "data/profil.json";
/** Sicherung der Datei im alten Format (fakten: string[]), einmalig vor der ersten Umstellung */
const SICHERUNG_ALT = "data/profil.vor-0.17.json";

type Obj = Record<string, unknown>;
const istObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const istTag = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s);
const QUELLEN = new Set(["chat", "verdichtung", "import"]);

/** Gleicher Wortlaut ohne Rücksicht auf Gross-/Kleinschreibung, Leerraum und Schlusspunkt (Duplikate, profil_vergessen) */
export function gleicherText(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  return n(a) === n(b);
}

/**
 * Bringt eine gelesene Profil-Datei ins aktuelle Format, ohne etwas wegzuwerfen:
 * alte `fakten: string[]` werden zu Fakten mit fortlaufender id, `seit = heute`, quelle «import»;
 * fehlende Listen werden leer, unbekannte Schlüssel bleiben erhalten.
 */
export function normalisiereProfil(roh: unknown, heute = todayKey()): Profil {
  const r: Obj = istObj(roh) ? roh : {};
  const liste = <T>(k: string): T[] => (Array.isArray(r[k]) ? (r[k] as T[]) : []);

  const rohFakten = liste<unknown>("fakten");
  // Neu nummerierte Fakten (Altbestand, doppelte ids) nie unter einem festgehaltenen Höchstwert: der könnte im Archiv stehen
  let max = ganzeId(r.faktIdMax);
  for (const f of rohFakten) if (istObj(f) && Number.isInteger(f.id) && (f.id as number) > max) max = f.id as number;
  const vergeben = new Set<number>();
  const fakten: Fakt[] = [];
  for (const f of rohFakten) {
    if (istObj(f)) {
      const text = typeof f.text === "string" ? f.text.trim() : "";
      if (!text) continue;
      const id = Number.isInteger(f.id) && (f.id as number) > 0 && !vergeben.has(f.id as number) ? (f.id as number) : ++max;
      vergeben.add(id);
      const fakt: Fakt = {
        id,
        text,
        seit: istTag(f.seit) ? f.seit.slice(0, 10) : heute,
        quelle: typeof f.quelle === "string" && QUELLEN.has(f.quelle) ? (f.quelle as Fakt["quelle"]) : "import",
      };
      if (istObj(f.veraltet)) fakt.veraltet = { seit: istTag(f.veraltet.seit) ? f.veraltet.seit.slice(0, 10) : heute, grund: String(f.veraltet.grund ?? "") };
      fakten.push(fakt);
    } else if (f !== null && f !== undefined && String(f).trim()) {
      // Altbestand: ein Fakt als blosser Text
      const id = ++max;
      vergeben.add(id);
      fakten.push({ id, text: String(f).trim(), seit: heute, quelle: "import" });
    }
  }

  const chronik: Chronik[] = liste<unknown>("chronik")
    .filter(istObj)
    .map((c) => ({ monat: String(c.monat ?? ""), text: String(c.text ?? ""), entscheidungen: Number(c.entscheidungen) || 0 }));

  const p: Profil = {
    ...(r as Partial<Profil>),
    ziele: liste<Ziel>("ziele"),
    werte: liste<string>("werte"),
    muster: liste<Muster>("muster"),
    entscheidungen: liste<Entscheidung>("entscheidungen"),
    fakten,
    chronik,
  };
  if (!istTag(p.letzteVerdichtung)) delete p.letzteVerdichtung;
  const idMax = hoechsteEntscheidungId(p);
  if (idMax > 0) p.entscheidungIdMax = idMax;
  else delete p.entscheidungIdMax;
  const faktMax = hoechsteFaktId(p);
  if (faktMax > 0) p.faktIdMax = faktMax;
  else delete p.faktIdMax;
  return p;
}

const ganzeId = (x: unknown): number => (Number.isInteger(x) && (x as number) > 0 ? (x as number) : 0);

/** Grösste bekannte Entscheidungs-id: festgehaltener Höchstwert oder grösste id in der Liste */
function hoechsteEntscheidungId(p: Profil): number {
  return p.entscheidungen.reduce((m, e) => Math.max(m, ganzeId(e?.id)), ganzeId(p.entscheidungIdMax));
}

/** Grösste bekannte Fakt-id: festgehaltener Höchstwert oder grösste id in der Liste (auch für die Verdichtung) */
export function hoechsteFaktId(p: Pick<Profil, "fakten" | "faktIdMax">): number {
  return p.fakten.reduce((m, f) => Math.max(m, ganzeId(f?.id)), ganzeId(p.faktIdMax));
}

function sichere(nach: string): void {
  if (istNurLesen()) return; // npm run check: die Umstellung (und ihre Sicherung) macht erst der Dienst
  try {
    mkdirSync("data", { recursive: true, mode: 0o700 });
    if (!existsSync(nach)) copyFileSync(FILE, nach);
  } catch (e) {
    console.error("Profil-Sicherung:", e instanceof Error ? e.message : e);
  }
}

/**
 * true, wenn data/profil.json vorhanden, aber nicht lesbar war (Rechte, kaputtes JSON …). Dann startet Jarvis mit leerem
 * Profil im Speicher, `saveProfil()` verweigert aber das Schreiben: sonst ersetzte das nächste Speichern
 * (Werkzeug oder nächtliche Verdichtung) das echte Profil durch ein leeres.
 */
export let profilNichtGeladen = false;

/** Hinweis für Startmeldung, /status, Dashboard und npm run check, solange profilNichtGeladen gilt (ohne Dateiinhalt) */
export const PROFIL_UNLESBAR =
  "⚠️ data/profil.json war beim Start unlesbar, Sir (Sicherung, sofern möglich, unter data/profil.json.defekt). Ich arbeite mit leerem Profil und speichere nichts daran, bis die Datei repariert ist und ich neu gestartet bin.";

export const profil: Profil = (() => {
  let text: string;
  try {
    text = readFileSync(FILE, "utf8");
  } catch (e) {
    // Nur eine fehlende Datei heisst «noch kein Profil»
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return normalisiereProfil({});
    profilNichtGeladen = true;
    console.error(
      `Profil nicht lesbar (${(e as NodeJS.ErrnoException).code ?? "Fehler"}) – Jarvis startet mit leerem Profil und speichert es nicht, bis ${FILE} wieder lesbar ist und Jarvis neu startet.`,
    );
    return normalisiereProfil({});
  }
  try {
    const roh = JSON.parse(text) as unknown;
    // Vor der ersten Umstellung das alte Format aufheben: geht bei der Migration etwas schief, ist nichts verloren
    if (!istObj(roh)) throw new Error("kein Objekt");
    if (Array.isArray(roh.fakten) && roh.fakten.some((f) => !istObj(f))) sichere(SICHERUNG_ALT);
    return normalisiereProfil(roh);
  } catch {
    profilNichtGeladen = true;
    if (istNurLesen()) {
      console.error(`Profil unlesbar – nur gelesen, keine Sicherung angelegt. Der Dienst startet damit mit leerem Profil, bis ${FILE} repariert ist.`);
      return normalisiereProfil({});
    }
    // Unter data/profil.json.defekt (belegt: mit Zeitstempel daneben); derselbe Inhalt wird nicht bei jedem Start neu kopiert
    const kopie = sichereDefekt(FILE, { gleicheWiederverwenden: true });
    console.error(
      `Profil unlesbar – ${kopie ? `Kopie unter ${kopie}` : "Sicherung fehlgeschlagen"}. Jarvis startet mit leerem Profil und speichert es nicht, bis ${FILE} repariert ist und Jarvis neu startet.`,
    );
    return normalisiereProfil({});
  }
})();

/** Höchste je gesehene Entscheidungs-id, auch wenn das Feld im Profil beim Ersetzen verloren ginge */
let entscheidungIdBekannt = hoechsteEntscheidungId(profil);
function merkeEntscheidungIdMax(): number {
  entscheidungIdBekannt = Math.max(entscheidungIdBekannt, hoechsteEntscheidungId(profil));
  return entscheidungIdBekannt;
}

/** Dasselbe für Fakten: nach Vergessen des höchsten Fakts darf seine id (oder eine archivierte) nicht wiederkommen */
let faktIdBekannt = hoechsteFaktId(profil);
function merkeFaktIdMax(): number {
  faktIdBekannt = Math.max(faktIdBekannt, hoechsteFaktId(profil));
  return faktIdBekannt;
}

export function saveProfil(): void {
  if (profilNichtGeladen) throw new Error(`Profil nicht geladen (${FILE} unlesbar), nichts gespeichert. Datei prüfen und Jarvis neu starten.`);
  const idMax = merkeEntscheidungIdMax();
  if (idMax > 0) profil.entscheidungIdMax = idMax;
  const faktMax = merkeFaktIdMax();
  if (faktMax > 0) profil.faktIdMax = faktMax;
  mkdirSync("data", { recursive: true, mode: 0o700 });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(profil, null, 2), { mode: 0o600 });
  renameSync(`${FILE}.tmp`, FILE);
}

const naechste = (arr: { id: number }[]) => (arr.at(-1)?.id ?? 0) + 1;
export const neueZielId = () => naechste(profil.ziele);
export const neuesMusterId = () => naechste(profil.muster);
/** Nie eine id, die schon einmal vergeben war (auch nicht eine, die die Verdichtung ins Archiv verschoben hat) */
export const neueEntscheidungId = () => Math.max(naechste(profil.entscheidungen), merkeEntscheidungIdMax() + 1);
/** Fakten werden bei der Verdichtung umsortiert und ins Archiv verschoben: höchste je vergebene id + 1, nicht die letzte */
export const neueFaktId = () => merkeFaktIdMax() + 1;

/** Aktuelle (nicht veraltete) Fakten, älteste zuerst nach `seit` */
export function aktuelleFakten(p: Profil = profil): Fakt[] {
  return p.fakten.filter((f) => !f.veraltet).sort((a, b) => a.seit.localeCompare(b.seit) || a.id - b.id);
}

/** Kompakte Fassung fürs Systemprompt: so weiss Jarvis in jeder Antwort, worauf er den Nutzer hin berät. */
export function profilFuerPrompt(): string {
  const ziele = profil.ziele.filter((z) => z.status === "offen").map((z) => `#${z.id} ${z.text}${z.frist ? ` (bis ${z.frist})` : ""}`);
  const muster = profil.muster.map((m) => `#${m.id} ${m.text}`);
  const letzte = profil.entscheidungen.slice(-6).map((e) => `${e.datum.slice(0, 10)}: ${e.text}${e.ausgang ? ` → ${e.ausgang}` : ""}`);
  const fakten = aktuelleFakten().slice(-20).map((f) => `${f.seit} ${f.text}`);
  const chronik = [...profil.chronik].sort((a, b) => a.monat.localeCompare(b.monat)).slice(-3).map((c) => `Chronik: ${c.monat}: ${c.text}`);
  const teile = [
    ziele.length ? `Ziele des Nutzers:\n${ziele.join("\n")}` : "",
    profil.werte.length ? `Werte/Prioritäten: ${profil.werte.join("; ")}` : "",
    muster.length ? `Beobachtete Entscheidungsmuster (nur belegt ansprechen, nie als Charakterurteil):\n${muster.join("\n")}` : "",
    letzte.length ? `Letzte Entscheidungen:\n${letzte.join("\n")}` : "",
    chronik.length ? chronik.join("\n") : "",
    fakten.length ? `Dauerhafte Fakten (seit): ${fakten.join("; ")}` : "",
  ].filter(Boolean);
  return teile.join("\n\n");
}

/** Für profil_anzeigen: wie im Prompt, dazu alle Fakten mit Nummer (zum Vergessen per id), die veralteten mit Grund und die ganze Chronik. */
export function profilFuerAnzeige(): string {
  const basis = profilFuerPrompt();
  const fakten = profil.fakten.map((f) => `#${f.id} (seit ${f.seit}) ${f.text}${f.veraltet ? ` [veraltet seit ${f.veraltet.seit}: ${f.veraltet.grund}]` : ""}`);
  const chronik = [...profil.chronik].sort((a, b) => a.monat.localeCompare(b.monat)).map((c) => `${c.monat} (${c.entscheidungen} ${c.entscheidungen === 1 ? "Entscheidung" : "Entscheidungen"}): ${c.text}`);
  return [
    basis,
    fakten.length ? `Fakten mit Nummer:\n${fakten.join("\n")}` : "",
    chronik.length ? `Chronik (alle Monate, zum Vergessen per Monat):\n${chronik.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
