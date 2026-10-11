import { chmodSync, constants, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { todayKey } from "./time.js";

/**
 * Finanzüberblick. Jarvis liest Rechnungen aus dem Postfach und behält Fristen und Beträge im Blick.
 * Er bereitet Zahlungen nur vor; ausgelöst werden sie von dir in der Bank-App (ZAHLUNG_NUR_VORBEREITEN).
 */
export interface Rechnung {
  id: number;
  erkanntAm: string;
  quelle?: string; // Gmail-Nachrichten-ID
  empfaenger: string;
  betrag?: number;
  waehrung: string;
  iban?: string;
  referenz?: string; // QR-Referenz / Zahlungszweck
  faellig?: string; // ISO-Datum
  status: "offen" | "bezahlt" | "ignoriert";
  /** YYYY-MM-DD, gesetzt beim Abhaken als bezahlt (Monatssumme, Wochenbericht) */
  bezahltAm?: string;
  notiz?: string;
}

const FILE = "data/rechnungen.json";
/** Unlesbare Rechnungs-Datei wird hierhin kopiert; liegt dort schon eine ältere Sicherung, mit Zeitstempel daneben */
const SICHERUNG_DEFEKT = `${FILE}.defekt`;

/** Kopiert die unlesbare Datei unter einen freien Namen (0o600, eine ältere Sicherung bleibt unberührt). */
function sichereDefekt(): string | undefined {
  try {
    mkdirSync("data", { recursive: true, mode: 0o700 });
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
    console.error("Rechnungs-Sicherung fehlgeschlagen:", e instanceof Error ? e.message : e);
    return undefined;
  }
}

/**
 * true, wenn data/rechnungen.json vorhanden, aber nicht lesbar war (Rechte, kaputtes JSON …). Dann startet Jarvis ohne
 * Rechnungen im Speicher, `saveRechnungen()` verweigert aber das Schreiben: sonst ersetzte das nächste Erfassen oder
 * Abhaken die echte Liste samt bezahltAm durch eine leere.
 */
export let rechnungenNichtGeladen = false;

export const rechnungen: Rechnung[] = (() => {
  let text: string;
  try {
    text = readFileSync(FILE, "utf8");
  } catch (e) {
    // Nur eine fehlende Datei heisst «noch keine Rechnungen»
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    rechnungenNichtGeladen = true;
    console.error(
      `Rechnungen nicht lesbar (${(e as NodeJS.ErrnoException).code ?? "Fehler"}) – Jarvis startet ohne Rechnungen und speichert keine, bis ${FILE} wieder lesbar ist und Jarvis neu startet.`,
    );
    return [];
  }
  try {
    const roh = JSON.parse(text) as unknown;
    if (!Array.isArray(roh)) throw new Error("keine Liste");
    return roh as Rechnung[];
  } catch {
    rechnungenNichtGeladen = true;
    const kopie = sichereDefekt();
    console.error(
      `Rechnungen unlesbar – ${kopie ? `Kopie unter ${kopie}` : "Sicherung fehlgeschlagen"}. Jarvis startet ohne Rechnungen und speichert keine, bis ${FILE} repariert ist und Jarvis neu startet.`,
    );
    return [];
  }
})();

/** Meldung für alle Anzeigen und Erinnerungen, solange die Datei beim Start unlesbar war */
export const RECHNUNGEN_UNLESBAR =
  "⚠️ data/rechnungen.json war beim Start unlesbar, Sir (Sicherung, sofern möglich, unter data/rechnungen.json.defekt). Bis die Datei repariert ist und ich neu gestartet bin, zeige ich keine Rechnungen und erinnere an keine.";

const GESPERRT = `${FILE} war beim Start unlesbar, Sir. Ich speichere keine Rechnungen, bis die Datei repariert ist und ich neu gestartet bin – sonst wäre der Bestand weg.`;

function pruefeSchreibbar(): void {
  if (rechnungenNichtGeladen) throw new Error(GESPERRT);
}

export function saveRechnungen(): void {
  pruefeSchreibbar();
  mkdirSync("data", { recursive: true, mode: 0o700 });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(rechnungen.slice(-300), null, 2), { mode: 0o600 });
  renameSync(`${FILE}.tmp`, FILE);
}

// ---------- Erkennung aus Text (Schweizer Formate) ----------

/** Prüfziffer einer IBAN (mod 97). Hält Fehltreffer aus dem Fliesstext fern. */
export function ibanGueltig(iban: string): boolean {
  const c = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(c)) return false;
  const re = c.slice(4) + c.slice(0, 4);
  const num = re.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of num) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1;
}

const MONATE: Record<string, string> = { januar: "01", februar: "02", märz: "03", maerz: "03", april: "04", mai: "05", juni: "06", juli: "07", august: "08", september: "09", oktober: "10", november: "11", dezember: "12" };

function findeDatum(text: string): string | undefined {
  const t = text.toLowerCase();
  // «fällig bis 31.10.2026», «Zahlbar bis 31. Oktober 2026», «Due date 2026-10-31»
  const ctx = /(fällig|faellig|zahlbar|zahlungsziel|due|payable)[^0-9]{0,20}(\d{1,2})[.\s]+(\d{1,2}|januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)[.\s]+(\d{4})/i.exec(t);
  if (ctx) {
    const tag = ctx[2].padStart(2, "0");
    const mon = /^\d+$/.test(ctx[3]) ? ctx[3].padStart(2, "0") : MONATE[ctx[3]];
    if (mon) return `${ctx[4]}-${mon}-${tag}`;
  }
  const iso = /(fällig|faellig|zahlbar|due)[^0-9]{0,20}(\d{4})-(\d{2})-(\d{2})/i.exec(t);
  if (iso) return `${iso[2]}-${iso[3]}-${iso[4]}`;
  return undefined;
}

function findeBetrag(text: string): number | undefined {
  // «CHF 1'234.50», «Total 1 234,50 CHF», «Betrag: 89.00», «89.-»
  // Rappen sind die 2 Stellen nach dem LETZTEN . oder , – Hochkomma, Leerzeichen und der jeweils andere Separator sind Tausendertrenner.
  const m = /(?:chf|fr\.?|total|betrag|rechnungsbetrag|amount|eur|€)[:\s]*([0-9][0-9'’.,\s]*[0-9]|[0-9])(?:\s*(?:\.|,)\s*-)?/i.exec(text);
  if (!m) return undefined;
  const roh = m[1].replace(/\s/g, "");
  const sepMatch = roh.match(/[.,](\d{2})$/);          // echte Dezimalstelle am Ende?
  const rappen = sepMatch ? sepMatch[1] : "00";
  const ganzTeil = sepMatch ? roh.slice(0, sepMatch.index) : roh;
  const ganz = ganzTeil.replace(/[.,'’]/g, "");          // alle Trenner raus
  const n = Number(`${ganz}.${rappen}`);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface Erkannt {
  betrag?: number;
  waehrung: string;
  iban?: string;
  referenz?: string;
  faellig?: string;
}

/** Zieht Betrag, IBAN, Referenz und Fälligkeit aus Rechnungstext. Nur ein Vorschlag; prüfen bleibt am Nutzer. */
export function erkenneRechnung(text: string): Erkannt {
  const ibanMatch = text.toUpperCase().match(/\b(CH|LI)\d{2}(?:[ ]?[A-Z0-9]){12,27}\b/g) ?? [];
  const iban = ibanMatch.map((x) => x.replace(/\s+/g, "")).find(ibanGueltig);
  const ref = /(referenz|reference|zahlungszweck|mitteilung)[:\s]*([0-9 ]{8,40})/i.exec(text);
  return {
    betrag: findeBetrag(text),
    waehrung: /\beur\b|€/i.test(text) ? "EUR" : "CHF",
    iban,
    referenz: ref ? ref[2].replace(/\s+/g, " ").trim() : undefined,
    faellig: findeDatum(text),
  };
}

// ---------- Verwaltung ----------

export function addRechnung(r: Omit<Rechnung, "id" | "erkanntAm" | "status"> & { status?: Rechnung["status"] }): Rechnung {
  pruefeSchreibbar(); // vor dem push: sonst stünde im Speicher eine Rechnung, die nie gespeichert wird
  const rechnung: Rechnung = { id: (rechnungen.at(-1)?.id ?? 0) + 1, erkanntAm: new Date().toISOString(), status: "offen", ...r };
  rechnungen.push(rechnung);
  saveRechnungen();
  return rechnung;
}

export function offeneRechnungen(): Rechnung[] {
  return rechnungen.filter((r) => r.status === "offen").sort((a, b) => (a.faellig ?? "9999").localeCompare(b.faellig ?? "9999"));
}

export function formatRechnung(r: Rechnung): string {
  const betrag = r.betrag != null ? `${r.betrag.toFixed(2)} ${r.waehrung}` : "Betrag unklar";
  return `#${r.id} · ${r.empfaenger} · ${betrag}${r.faellig ? ` · fällig ${r.faellig}` : ""}${r.iban ? `\n   IBAN ${r.iban}` : ""}${r.referenz ? ` · Ref ${r.referenz}` : ""} · ${r.status}`;
}

/**
 * Setzt den Status und pflegt bezahltAm: beim Abhaken als bezahlt das Datum (ein schon gesetztes bleibt), beim Wechsel
 * weg von bezahlt wird es gelöscht. Speichert sofort. Hakt nur ab – gezahlt wird ausschliesslich in der Bank-App.
 */
export function setzeStatus(r: Rechnung, status: Rechnung["status"], heute = todayKey()): void {
  pruefeSchreibbar();
  r.status = status;
  if (status !== "bezahlt") delete r.bezahltAm;
  else if (!r.bezahltAm) r.bezahltAm = heute;
  saveRechnungen();
}

// ---------- Auswertung (Wochenbericht, Dashboard) ----------

/** Summe je Währung, z. B. { CHF: 1234.5, EUR: 20 } */
export interface Summe {
  [waehrung: string]: number;
}

export interface MonatsZeile {
  /** YYYY-MM */
  monat: string;
  bezahlt: Summe;
  offen: Summe;
  anzahlBezahlt: number;
  anzahlOffen: number;
}

export interface FinanzUebersicht {
  /** YYYY-MM-DD */
  stand: string;
  offen: { anzahl: number; summe: Summe };
  /** offen, faellig < heute */
  ueberfaellig: Rechnung[];
  /** offen, heute ≤ faellig ≤ heute + 7 Tage */
  faelligBald: Rechnung[];
  /** offen ohne Fälligkeit */
  ohneFrist: number;
  /** offen ohne Betrag */
  unklar: number;
  /** bezahltAm in den letzten 7 Tagen (inkl. heute) */
  bezahltLetzteWoche: Rechnung[];
  /** letzte 6 Monate inkl. aktuellem, älteste zuerst */
  proMonat: MonatsZeile[];
}

const hatBetrag = (r: Rechnung): r is Rechnung & { betrag: number } => typeof r.betrag === "number" && Number.isFinite(r.betrag);
const waehrungVon = (r: Rechnung): string => (typeof r.waehrung === "string" && r.waehrung.trim() ? r.waehrung.trim().toUpperCase() : "CHF");

/** YYYY-MM-DD in Schweizer Zeit; erkanntAm ist ein UTC-Zeitstempel und kann kurz vor Mitternacht im Vortag liegen. */
function tagVon(wert: unknown): string | undefined {
  if (typeof wert !== "string" || !wert) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(wert)) return wert;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(wert)) return undefined;
  const d = new Date(wert);
  return Number.isNaN(d.getTime()) ? undefined : todayKey(d);
}

/** Kalenderrechnung auf dem Datumsschlüssel (UTC), unabhängig von Sommerzeit */
function plusTage(tag: string, n: number): string {
  const [j, m, t] = tag.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(j, m - 1, t + n)).toISOString().slice(0, 10);
}

function plusMonate(tag: string, n: number): string {
  const [j, m] = tag.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(j, m - 1 + n, 1)).toISOString().slice(0, 7);
}

/** Summiert in Rappen, damit 0.1 + 0.2 nicht 0.30000000000000004 ergibt. */
class Summierer {
  private rappen = new Map<string, number>();
  add(r: Rechnung): void {
    if (!hatBetrag(r)) return;
    const w = waehrungVon(r);
    this.rappen.set(w, (this.rappen.get(w) ?? 0) + Math.round(r.betrag * 100));
  }
  summe(): Summe {
    const s: Summe = {};
    for (const [w, rp] of this.rappen) s[w] = rp / 100;
    return s;
  }
}

const nachFaelligkeit = (a: Rechnung, b: Rechnung) => (tagVon(a.faellig) ?? "9999").localeCompare(tagVon(b.faellig) ?? "9999") || a.id - b.id;

/**
 * Überblick für Wochenbericht und Dashboard. Reine Funktion: `now` und die Liste sind injizierbar.
 * Monatszuordnung: bezahlt → bezahltAm (sonst faellig, sonst erkanntAm), offen → faellig (sonst erkanntAm); ignoriert zählt nirgends.
 */
export function finanzUebersicht(now: Date = new Date(), liste: Rechnung[] = rechnungen): FinanzUebersicht {
  const heute = todayKey(now);
  const inSiebenTagen = plusTage(heute, 7);
  const vorSechsTagen = plusTage(heute, -6);
  const offene = liste.filter((r) => r.status === "offen");
  const offenSumme = new Summierer();
  for (const r of offene) offenSumme.add(r);

  const monate = Array.from({ length: 6 }, (_, i) => plusMonate(heute, i - 5));
  const proMonat = monate.map(() => ({ bezahlt: new Summierer(), offen: new Summierer(), anzahlBezahlt: 0, anzahlOffen: 0 }));
  for (const r of liste) {
    let tag: string | undefined;
    if (r.status === "bezahlt") tag = tagVon(r.bezahltAm) ?? tagVon(r.faellig) ?? tagVon(r.erkanntAm);
    else if (r.status === "offen") tag = tagVon(r.faellig) ?? tagVon(r.erkanntAm);
    const i = tag ? monate.indexOf(tag.slice(0, 7)) : -1;
    if (i < 0) continue;
    const zeile = proMonat[i]!;
    if (r.status === "bezahlt") {
      zeile.bezahlt.add(r);
      zeile.anzahlBezahlt++;
    } else {
      zeile.offen.add(r);
      zeile.anzahlOffen++;
    }
  }

  const kopie = (r: Rechnung): Rechnung => ({ ...r });
  return {
    stand: heute,
    offen: { anzahl: offene.length, summe: offenSumme.summe() },
    ueberfaellig: offene.filter((r) => { const f = tagVon(r.faellig); return f !== undefined && f < heute; }).sort(nachFaelligkeit).map(kopie),
    faelligBald: offene.filter((r) => { const f = tagVon(r.faellig); return f !== undefined && f >= heute && f <= inSiebenTagen; }).sort(nachFaelligkeit).map(kopie),
    ohneFrist: offene.filter((r) => tagVon(r.faellig) === undefined).length,
    unklar: offene.filter((r) => !hatBetrag(r)).length,
    bezahltLetzteWoche: liste
      .filter((r) => { const b = tagVon(r.bezahltAm); return r.status === "bezahlt" && b !== undefined && b >= vorSechsTagen && b <= heute; })
      .sort((a, b) => (tagVon(b.bezahltAm) ?? "").localeCompare(tagVon(a.bezahltAm) ?? "") || a.id - b.id)
      .map(kopie),
    proMonat: proMonat.map((z, i) => ({ monat: monate[i]!, bezahlt: z.bezahlt.summe(), offen: z.offen.summe(), anzahlBezahlt: z.anzahlBezahlt, anzahlOffen: z.anzahlOffen })),
  };
}

/** Schweizer Zahlenformat: 1'234.50 CHF */
export function chf(n: number, waehrung = "CHF"): string {
  if (!Number.isFinite(n)) return `– ${waehrung}`;
  const rappen = Math.round(Math.abs(n) * 100);
  const ganz = Math.floor(rappen / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${n < 0 && rappen > 0 ? "-" : ""}${ganz}.${String(rappen % 100).padStart(2, "0")} ${waehrung}`;
}

/** Summe je Währung, CHF zuerst; leer → «–» */
export function summeText(s: Summe): string {
  const w = Object.keys(s).sort((a, b) => (a === "CHF" ? -1 : b === "CHF" ? 1 : a.localeCompare(b)));
  return w.length ? w.map((x) => chf(s[x]!, x)).join(" · ") : "–";
}

const LISTE_MAX = 5;
const einzeilig = (r: Rechnung) => `• ${formatRechnung(r).replace(/\n\s*/g, " · ")}`;

function listenBlock(titel: string, liste: Rechnung[]): string[] {
  if (liste.length === 0) return [];
  const kopf = liste.length > LISTE_MAX ? `${titel} (${liste.length}, die ersten ${LISTE_MAX}):` : `${titel} (${liste.length}):`;
  return [kopf, ...liste.slice(0, LISTE_MAX).map(einzeilig)];
}

/** Wochenbericht für Telegram: kompakt, höchstens 25 Zeilen. Bereitet Zahlungen nur vor, löst nie etwas aus. */
export function wochenberichtText(u: FinanzUebersicht): string {
  const rechnung = (n: number) => `${n} Rechnung${n === 1 ? "" : "en"}`;
  const bezahltSumme = new Summierer();
  for (const r of u.bezahltLetzteWoche) bezahltSumme.add(r);
  const zeilen = [
    `💼 Finanzen, Stand ${u.stand}`,
    u.offen.anzahl
      ? `Offen: ${rechnung(u.offen.anzahl)} · ${summeText(u.offen.summe)}${u.ohneFrist ? ` (${u.ohneFrist} ohne Frist)` : ""}`
      : "Offen: nichts, Sir.",
    ...listenBlock("Überfällig", u.ueberfaellig),
    ...listenBlock("Fällig in 7 Tagen", u.faelligBald),
    u.bezahltLetzteWoche.length
      ? `Bezahlt letzte Woche: ${rechnung(u.bezahltLetzteWoche.length)} · ${summeText(bezahltSumme.summe())}`
      : "Bezahlt letzte Woche: keine.",
    "Pro Monat:",
    ...u.proMonat.map((m) =>
      m.anzahlBezahlt || m.anzahlOffen
        ? `${m.monat}: bezahlt ${summeText(m.bezahlt)} (${m.anzahlBezahlt}) · offen ${summeText(m.offen)} (${m.anzahlOffen})`
        : `${m.monat}: –`,
    ),
  ];
  if (u.unklar > 0) zeilen.push(`⚠️ ${rechnung(u.unklar)} ohne erkannten Betrag – die Summen sind unvollständig. Bitte in der Rechnung prüfen, Sir.`);
  if (u.offen.anzahl > 0) zeilen.push("Zahlung vorbereiten: «Bereite die Zahlung für #… vor». Auslösen müssen Sie selbst, in der Bank-App.");
  return zeilen.join("\n");
}
