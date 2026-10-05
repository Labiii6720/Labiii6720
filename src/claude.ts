import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { config } from "./config.js";

/**
 * Ein Client für alle Aufrufe plus Verbrauchszählung. Jeder API-Aufruf meldet seine Tokens hier an,
 * /kosten in Telegram zeigt Tag und Monat mit einer Kostenschätzung.
 */
let client: Anthropic | undefined;
export const anthropic = () => (client ??= new Anthropic());

export interface Verbrauch { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }
type Usage = Record<string, Verbrauch>; // YYYY-MM-DD → Verbrauch

const FILE = "data/usage.json";
const usage: Usage = (() => {
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
