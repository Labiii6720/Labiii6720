import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";

/** Revisionsprotokoll: jede Werkzeugnutzung, Freigabe, Ablehnung und jeder abgewiesene Zugriff – eine JSON-Zeile pro Ereignis. */
export function audit(event: string, data: Record<string, unknown> = {}): void {
  try {
    mkdirSync("data", { recursive: true, mode: 0o700 });
    try {
      if (statSync("data/audit.log").size > 5_000_000) renameSync("data/audit.log", "data/audit.log.1"); // eine Generation behalten
    } catch { /* noch kein Log */ }
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    appendFileSync("data/audit.log", `${line.slice(0, 1500)}\n`, { mode: 0o600 });
  } catch (e) {
    console.error("Audit-Log:", e instanceof Error ? e.message : e);
  }
}

/** Meldet ein Ereignis höchstens einmal pro Stunde (gegen Alarmflut). */
const lastNotice = new Map<string, number>();
export function throttled(key: string, hours = 1): boolean {
  const now = Date.now();
  if (now - (lastNotice.get(key) ?? 0) < hours * 3_600_000) return false;
  lastNotice.set(key, now);
  return true;
}
