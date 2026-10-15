import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { config } from "./config.js";
import { gesundheit, mitWiederholung, type WiederholOptionen } from "./robust.js";
import { state } from "./state.js";

/**
 * Ein Client für alle Aufrufe plus Verbrauchszählung. Jeder API-Aufruf meldet seine Tokens hier an,
 * /kosten in Telegram zeigt Tag und Monat mit einer Kostenschätzung.
 */
let client: Anthropic | undefined;
/** maxRetries 2 = SDK-Standard (schnelle Wiederholungen bei 408/409/429/5xx); die langsamen macht claudeAufruf. */
export const anthropic = () => (client ??= new Anthropic({ maxRetries: 2 }));

/**
 * Nur diese Fehler lohnen einen späten zweiten Anlauf; BadRequest, Auth, NotFound und Abbruch nie.
 * Notaus (state.paused) schaltet die Wiederholung ab (beim Fehler und nochmals nach der Wartezeit, siehe claudeAufruf):
 * der Aufrufer erhält den echten, vorübergehenden Fehler, und die Gesundheit verbucht keinen Nutzer-Abbruch als Claude-Störung.
 */
const claudeWiederholen = (e: unknown): boolean =>
  !state.paused && (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.APIConnectionError || e instanceof Anthropic.InternalServerError);

/**
 * Gemeinsame Hülle für alle Claude-Aufrufe: bis zu 3 Versuche mit Backoff 5–30 s (Retry-After der API hat Vorrang),
 * Gesundheit der Komponente «claude» wird geführt. `fn` erhält die Versuchsnummer (1 = erster Anlauf).
 * `test` erlaubt Tests, Warten und Zufall zu injizieren.
 */
export async function claudeAufruf<T>(zweck: string, fn: (versuch: number) => Promise<T>, test: Pick<WiederholOptionen, "warten" | "zufall"> = {}): Promise<T> {
  let echterFehler: unknown;
  // Notaus kann auch während der Wartezeit kommen: vor jedem weiteren Anlauf erneut prüfen. Der Abbruch ist ein
  // APIUserAbortError (wird nicht wiederholt, zählt nicht als Störung) und wird unten durch den echten Fehler ersetzt.
  const abbruch = new Anthropic.APIUserAbortError({ message: "Pausiert (Notaus)" });
  const versuch = async (v: number): Promise<T> => {
    if (v > 1 && state.paused) throw abbruch;
    try {
      return await fn(v);
    } catch (e) {
      echterFehler = e;
      throw e;
    }
  };
  try {
    return await mitWiederholung(`claude.${zweck}`, versuch, { versuche: 3, basisMs: 5000, maxMs: 30000, komponente: "claude", wiederholen: claudeWiederholen, ...test });
  } catch (e) {
    if (e === abbruch) throw echterFehler;
    if (e instanceof Anthropic.AuthenticationError) gesundheit.melde("claude", false, "API-Schlüssel abgelehnt");
    throw e;
  }
}

export interface Verbrauch { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export type Usage = Record<string, Verbrauch>; // YYYY-MM-DD → Verbrauch

const FILE = "data/usage.json";
/** Verbrauch je Tag (Schweizer Datum), Stand im Speicher; nur lesen – geschrieben wird über trackUsage. */
export const usage: Usage = (() => {
  try { return JSON.parse(readFileSync(FILE, "utf8")) as Usage; } catch { return {}; }
})();

let dirty = false;
function persist(): void {
  if (!dirty) return;
  dirty = false;
  try {
    mkdirSync("data", { recursive: true, mode: 0o700 });
    writeFileSync(`${FILE}.tmp`, JSON.stringify(usage), { mode: 0o600 });
    renameSync(`${FILE}.tmp`, FILE);
  } catch (e) {
    console.error("usage.json:", e instanceof Error ? e.message : e);
  }
}
setInterval(persist, 30_000).unref();

const heute = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Zurich" });

export function trackUsage(msg: { usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } }): void {
  const u = msg.usage;
  if (!u) return;
  const d = (usage[heute()] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  d.calls++;
  d.input += u.input_tokens ?? 0;
  d.output += u.output_tokens ?? 0;
  d.cacheRead += u.cache_read_input_tokens ?? 0;
  d.cacheWrite += u.cache_creation_input_tokens ?? 0;
  dirty = true;
}

/** Schätzung in USD nach den Preisen in .env (Standard: Sonnet-Preise); Franken etwa gleich. */
export function kosten(v: Verbrauch): number {
  const p = config.preise;
  return (v.input * p.input + v.output * p.output + v.cacheRead * p.cacheRead + v.cacheWrite * p.cacheWrite) / 1_000_000;
}

export function verbrauchBericht(): string {
  persist();
  const tag = usage[heute()] ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const monat = Object.entries(usage)
    .filter(([d]) => d.startsWith(heute().slice(0, 7)))
    .reduce((acc, [, v]) => ({ calls: acc.calls + v.calls, input: acc.input + v.input, output: acc.output + v.output, cacheRead: acc.cacheRead + v.cacheRead, cacheWrite: acc.cacheWrite + v.cacheWrite }), { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const zeile = (n: string, v: Verbrauch) => `${n}: ${v.calls} Aufrufe · ${(v.input / 1000).toFixed(1)}k ein · ${(v.output / 1000).toFixed(1)}k aus · ${(v.cacheRead / 1000).toFixed(1)}k aus Cache · ca. ${kosten(v).toFixed(2)} $`;
  return `${zeile("Heute", tag)}\n${zeile("Monat", monat)}\n(Schätzung nach den Preisen in .env; der echte Betrag steht in der Claude Console.)`;
}

export interface VerbrauchTag extends Verbrauch { datum: string; kostenUsd: number }

export interface VerbrauchVerlauf {
  preise: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** lückenlos, älteste zuerst, letzter Eintrag = heute */
  tage: VerbrauchTag[];
  heute: VerbrauchTag;
  /** Kalendermonat von heute (unabhängig vom Zeitraum) */
  monat: Verbrauch & { kostenUsd: number };
  /** cacheRead / (input + cacheRead + cacheWrite) über den Zeitraum, 0 ohne Verbrauch */
  cacheAnteil: number;
}

const leer = (): Verbrauch => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const summe = (a: Verbrauch, b: Partial<Verbrauch>): Verbrauch => ({
  calls: a.calls + (Number(b.calls) || 0),
  input: a.input + (Number(b.input) || 0),
  output: a.output + (Number(b.output) || 0),
  cacheRead: a.cacheRead + (Number(b.cacheRead) || 0),
  cacheWrite: a.cacheWrite + (Number(b.cacheWrite) || 0),
});
const usd = (v: Verbrauch) => Math.round(kosten(v) * 1e6) / 1e6;

/**
 * Verlauf der letzten `tage` Tage (1–90) bis einschliesslich `heute`, Schweizer Datum. Fehlende Tage kommen mit 0.
 * Gerechnet wird auf dem Kalenderdatum (UTC-Mittag als Anker), damit Sommerzeitwechsel keinen Tag doppeln oder auslassen.
 */
export function verbrauchVerlauf(tage: number, heute: Date = new Date(), daten: Usage = usage): VerbrauchVerlauf {
  const roh = Math.floor(Number(tage));
  const n = Number.isFinite(roh) ? Math.min(90, Math.max(1, roh)) : 30;
  const heuteKey = heute.toLocaleDateString("en-CA", { timeZone: "Europe/Zurich" });
  const [j, m, t] = heuteKey.split("-").map(Number);
  const liste: VerbrauchTag[] = [];
  let zeitraum = leer();
  for (let i = n - 1; i >= 0; i--) {
    const datum = new Date(Date.UTC(j, m - 1, t - i, 12)).toISOString().slice(0, 10);
    const v = summe(leer(), daten[datum] ?? {});
    zeitraum = summe(zeitraum, v);
    liste.push({ datum, ...v, kostenUsd: usd(v) });
  }
  const monatV = Object.entries(daten)
    .filter(([d]) => d.startsWith(heuteKey.slice(0, 7)))
    .reduce((acc, [, v]) => summe(acc, v), leer());
  const nenner = zeitraum.input + zeitraum.cacheRead + zeitraum.cacheWrite;
  return {
    preise: { ...config.preise },
    tage: liste,
    heute: liste[liste.length - 1]!,
    monat: { ...monatV, kostenUsd: usd(monatV) },
    cacheAnteil: nenner > 0 ? Math.round((zeitraum.cacheRead / nenner) * 1e4) / 1e4 : 0,
  };
}
