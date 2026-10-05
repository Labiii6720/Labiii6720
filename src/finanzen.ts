import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

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
  notiz?: string;
}

const FILE = "data/rechnungen.json";
export const rechnungen: Rechnung[] = (() => {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Rechnung[];
  } catch {
    return [];
  }
})();

export function saveRechnungen(): void {
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
