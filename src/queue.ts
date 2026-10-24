import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { auftragEintrag, gesperrtText, ladeListe } from "./datei.js";
import { save, state, zustandWirdGespeichert } from "./state.js";

/**
 * Freigabe-Warteschlange. Jedes Werkzeug hat eine Stufe:
 *   auto      läuft sofort (nur lesen oder im Arbeitsordner)
 *   extern    verlässt den Pi oder verändert etwas → Auftrag, wartet auf dein OK
 *   sensibel  Geld, Schlösser, Zugänge → Auftrag, wartet auf OK plus PIN
 */
export type Stufe = "auto" | "extern" | "sensibel";
export type Status = "offen" | "erledigt" | "abgelehnt" | "fehler";

export interface Auftrag {
  id: number;
  createdAt: string;
  tool: string;
  input: Record<string, unknown>;
  stufe: Exclude<Stufe, "auto">;
  /** Was passieren würde, in einem Satz – kommt so in die Telegram-Nachricht */
  summary: string;
  status: Status;
  result?: string;
  messageId?: number;
  /** ISO-Zeit, zu der die Ausführung begann. Bleibt der Status danach «offen» (Absturz mitten im Werkzeug), ist das Ergebnis unklar. */
  gestartetAm?: string;
}

const FILE = "data/auftraege.json";

/**
 * Einträge prüft ladeListe (auftragEintrag in datei.ts): ein null oder ein Eintrag ohne Pflichtfelder fällt beim Laden
 * weg (Sicherung .defekt, Hinweis), statt /status.json, /api/auftraege, /auftraege und jede Freigabe abstürzen zu lassen.
 * Eine ganz unlesbare Datei überschreibt Jarvis nicht mehr still mit dem nächsten Auftrag: Sicherung, Hinweis, und
 * bis zum Neustart werden keine Aufträge angelegt oder geändert.
 */
const geladen = ladeListe<Auftrag>(FILE, "Aufträge", auftragEintrag);
export const auftraege: Auftrag[] = geladen.liste;
/** true, wenn data/auftraege.json vorhanden, aber unlesbar war: keine Aufträge, nichts wird gespeichert. */
export const auftraegeNichtGeladen = geladen.nichtGeladen;
export const AUFTRAEGE_UNLESBAR =
  "⚠️ data/auftraege.json war beim Start unlesbar, Sir (Sicherung, sofern möglich, unter data/auftraege.json.defekt). Frühere Freigaben kenne ich nicht, und neue Aufträge lege ich erst an, wenn die Datei repariert ist und ich neu gestartet bin.";

/** Vor jeder Änderung an auftraege: wirft, solange die Datei beim Start unlesbar war. */
export function pruefeAuftraegeSchreibbar(): void {
  if (auftraegeNichtGeladen) throw new Error(gesperrtText(FILE, "die Aufträge"));
}

/**
 * Höchste Nummer in der Datei beim Start, verworfene Einträge eingeschlossen. Ein alter Telegram-Knopf «ok:<id>» eines
 * verworfenen Auftrags darf nie einen neuen Auftrag mit derselben Nummer freigeben.
 */
const hoechsteIdBeimStart = geladen.hoechsteId;
const hoechsteGueltigeId = (): number => auftraege.reduce((max, a) => Math.max(max, a.id), 0);

/**
 * Altbestand ohne Zähler (vor 0.22): Untergrenze gleich beim Start in state.json, nicht erst beim ersten neuen Auftrag.
 * Sonst begänne eine danach entfernte oder durch [] ersetzte auftraege.json wieder bei #1, und ein alter Knopf «ok:<id>»
 * träfe einen neuen Auftrag. Ein Fehler beim Speichern hält den Start nicht auf (der Zähler gilt dann im Prozess).
 */
if (!auftraegeNichtGeladen && zustandWirdGespeichert() && hoechsteIdBeimStart > 0 && Number.isSafeInteger(hoechsteIdBeimStart + 1)) {
  const gemerkt = state.naechsteAuftragId;
  if (!(Number.isSafeInteger(gemerkt) && gemerkt! > hoechsteIdBeimStart)) {
    state.naechsteAuftragId = hoechsteIdBeimStart + 1;
    try {
      save();
    } catch (e) {
      console.error("Auftragszähler nicht in state.json gesichert:", (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : e));
    }
  }
}

let untergrenzeUngesichertGemeldet = false;

/**
 * Trugen verworfene Einträge höhere Nummern als alle gültigen, stehen sie nach dem nächsten Speichern nur noch in der
 * Sicherung. Darum vorher die Untergrenze in state.json festhalten (einmal; danach steht ein höherer Auftrag in der
 * Datei). Scheitert das Schreiben, wirft es, bevor die Liste geschrieben ist. Wird state.json gar nicht gespeichert
 * (beim Start unlesbar), gilt die Untergrenze nur im Prozess: einmal melden, nicht werfen – sonst scheiterte setStatus
 * nach einem schon gelaufenen Werkzeug.
 */
function zaehlerNachziehen(): void {
  if (hoechsteIdBeimStart <= hoechsteGueltigeId()) return;
  const mindestens = hoechsteIdBeimStart + 1;
  const gemerkt = state.naechsteAuftragId;
  if (Number.isSafeInteger(gemerkt) && gemerkt! >= mindestens) return;
  state.naechsteAuftragId = mindestens;
  if (!zustandWirdGespeichert()) {
    if (!untergrenzeUngesichertGemeldet) {
      untergrenzeUngesichertGemeldet = true;
      console.error(`Auftragsnummern ab #${mindestens}: Untergrenze nur im Speicher, state.json wird nicht gespeichert. Verworfene Nummern stehen danach nur in data/auftraege.json.defekt.`);
    }
    return;
  }
  try {
    save();
  } catch (e) {
    if (gemerkt === undefined) delete state.naechsteAuftragId;
    else state.naechsteAuftragId = gemerkt;
    throw e;
  }
}

/** Nächste Nummer: über allen gültigen, allen beim Start verworfenen und der gemerkten Untergrenze. */
function neueAuftragId(): number {
  const gemerkt = state.naechsteAuftragId;
  return Math.max(hoechsteGueltigeId() + 1, hoechsteIdBeimStart + 1, Number.isSafeInteger(gemerkt) ? gemerkt! : 1);
}

export function saveAuftraege(): void {
  pruefeAuftraegeSchreibbar();
  zaehlerNachziehen();
  mkdirSync("data", { recursive: true, mode: 0o700 });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(auftraege, null, 2), { mode: 0o600 });
  renameSync(`${FILE}.tmp`, FILE);
}

const AUFTRAG_STUFEN: readonly unknown[] = ["extern", "sensibel"];

/**
 * Legt einen Auftrag an, ganz oder gar nicht: Scheitert das Speichern (ENOSPC, EACCES …), steht danach nichts im
 * Speicher. Sonst bliebe ein offener, freigebbarer Auftrag zurück, während der Aufrufer «nicht angelegt» meldet – ein
 * zweiter Versuch ergäbe zwei Aufträge mit derselben Nebenwirkung.
 * Die nächste Nummer steht vorher in state.json: Wird data/auftraege.json entfernt oder ersetzt, vergibt Jarvis keine
 * Nummer erneut, und ein alter Freigabe-Knopf «ok:<id>» trifft keinen neuen Auftrag.
 */
export function createAuftrag(a: Omit<Auftrag, "id" | "createdAt" | "status">): Auftrag {
  pruefeAuftraegeSchreibbar();
  // Nur extern|sensibel (wie auftragEintrag beim Laden): «Sensibel» oder eine fehlende Stufe liefe sonst ohne PIN
  if (!AUFTRAG_STUFEN.includes(a.stufe)) throw new Error(`Unbekannte Stufe «${String(a.stufe).slice(0, 20)}»: Auftrag nicht angelegt. Erlaubt sind extern und sensibel.`);
  const auftrag: Auftrag = { id: neueAuftragId(), createdAt: new Date().toISOString(), status: "offen", ...a };
  // Über 2^53 wären Nummern nicht mehr eindeutig (zwei Aufträge mit derselben id) und fielen beim nächsten Start weg
  if (!Number.isSafeInteger(auftrag.id)) throw new Error("Nummernraum erschöpft, Sir – data/auftraege.json prüfen. Auftrag nicht angelegt.");
  const gemerkt = state.naechsteAuftragId;
  state.naechsteAuftragId = auftrag.id + 1;
  try {
    save();
  } catch (e) {
    if (gemerkt === undefined) delete state.naechsteAuftragId;
    else state.naechsteAuftragId = gemerkt;
    throw e;
  }
  const vorher = auftraege.slice();
  auftraege.push(auftrag);
  kuerzen();
  try {
    saveAuftraege();
  } catch (e) {
    // Zurück auf den Stand davor; die Nummer bleibt verbraucht (eine Lücke schadet nicht)
    auftraege.splice(0, auftraege.length, ...vorher);
    throw e;
  }
  return auftrag;
}

const HOECHSTZAHL = 200;

/**
 * Älteste abgeschlossene Einträge weg, bis höchstens 200 übrig sind. Offene bleiben immer, auch begonnene (gestartetAm,
 * Ergebnis unklar) und gerade laufende: sonst verschwände eine Freigabe still, und setStatus schriebe auf ein Objekt,
 * das nicht mehr in der Liste steht. Bei vielen offenen darf die Liste länger werden.
 */
function kuerzen(): void {
  let zuViel = auftraege.length - HOECHSTZAHL;
  if (zuViel <= 0) return;
  for (let i = 0; i < auftraege.length && zuViel > 0; ) {
    if (auftraege[i]!.status !== "offen") {
      auftraege.splice(i, 1);
      zuViel--;
    } else i++;
  }
}

export function getAuftrag(id: number): Auftrag | undefined {
  return auftraege.find((a) => a.id === id);
}

export function offeneAuftraege(): Auftrag[] {
  return auftraege.filter((a) => a.status === "offen");
}

export function setStatus(a: Auftrag, status: Status, result?: string): void {
  a.status = status;
  if (result !== undefined) a.result = result.slice(0, 2000);
  saveAuftraege();
}
