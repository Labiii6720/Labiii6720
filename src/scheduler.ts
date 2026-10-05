import { handleMessage } from "./agent.js";
import { config } from "./config.js";
import { audit } from "./audit.js";
import { hooks, sendText } from "./telegram.js";
import { state } from "./state.js";
import { todayKey } from "./time.js";
import { faelltAn, saveZeitplaene, zeitplaene } from "./zeitplaene.js";
import { formatRechnung, offeneRechnungen } from "./finanzen.js";
import { profil } from "./profil.js";

const log = (e: unknown) => console.error(e instanceof Error ? e.message : e);

/** Prüft jede Minute, ob ein Zeitplan dran ist, und lässt Jarvis den Auftrag erledigen. */
export async function zeitplanTick(now = new Date()): Promise<void> {
  if (state.paused) return;
  const today = todayKey(now);
  for (const z of zeitplaene) {
    if (z.lastRun === today || !faelltAn(z, now)) continue;
    z.lastRun = today;
    saveZeitplaene();
    try {
      const reply = await handleMessage(`[Zeitplan «${z.name}», läuft automatisch] ${z.auftrag}`, hooks);
      await sendText(`🕒 ${z.name}\n\n${reply}`);
    } catch (e) {
      log(e);
      await sendText(`⚠️ Zeitplan «${z.name}» ist fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`).catch(log);
    }
  }
}

let letzterRueckblick = "";

/**
 * Täglicher Rückblick: Jarvis schaut auf den Tag zurück, notiert Entscheidungen, belegte Muster und Fortschritt
 * bei den Zielen und schlägt Anpassungen vor (Ziele/Werte landen als Aufträge, du entscheidest morgens).
 * Das ist das Lernen über dich – ohne dass Jarvis an sich selbst herumschraubt.
 */
export async function rueckblickTick(now = new Date()): Promise<void> {
  if (config.rueckblick === "off" || state.paused) return;
  const today = todayKey(now);
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (hhmm !== config.rueckblick || letzterRueckblick === today) return;
  letzterRueckblick = today;
  audit("rueckblick", {});
  const prompt =
    "[Tagesrückblick, läuft automatisch] Schau auf das heutige Gespräch zurück. " +
    "1) Notiere getroffene Entscheidungen mit entscheidung_notieren (nur echte, keine Kleinigkeiten). " +
    "2) Gibt es ein belegtes Entscheidungsmuster (mindestens zwei konkrete Belege, auf Entscheidungen bezogen), halte es mit muster_festhalten fest; sonst nicht. " +
    "3) Hat sich etwas an Zielen oder Werten gezeigt, schlag es mit ziel_setzen oder wert_setzen vor (das wird zum Auftrag). " +
    "4) Antworte mir in höchstens vier Sätzen: Was war heute wichtig, was steht morgen an, und ein ehrlicher Hinweis, falls du einen hast.";
  try {
    const reply = await handleMessage(prompt, hooks);
    await sendText(`🌙 Rückblick\n\n${reply}`);
  } catch (e) {
    log(e);
  }
}

const hhmmOf = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
let letzteRechnungsErinnerung = "";
let letzterZielcheck = "";

/** Täglich: Rechnungen, die in den nächsten Tagen fällig oder schon überfällig sind. Ohne Claude, nur Daten. */
export async function rechnungsTick(now = new Date()): Promise<void> {
  if (config.rechnungErinnerung === "off" || state.paused) return;
  const today = todayKey(now);
  if (hhmmOf(now) !== config.rechnungErinnerung || letzteRechnungsErinnerung === today) return;
  letzteRechnungsErinnerung = today;
  const grenze = new Date(now.getTime() + config.rechnungVorlauf * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Europe/Zurich" });
  const faellig = offeneRechnungen().filter((r) => r.faellig && r.faellig <= grenze);
  if (faellig.length === 0) return;
  const ueberfaellig = faellig.filter((r) => r.faellig! < today);
  const text = [
    `💳 Rechnungen: ${faellig.length} fällig bis ${grenze}${ueberfaellig.length ? `, davon ${ueberfaellig.length} überfällig` : ""}`,
    ...faellig.map(formatRechnung),
    "«Bereite die Zahlung für #… vor» liefert die Daten für die Bank-App.",
  ].join("\n");
  audit("rechnungs_erinnerung", { anzahl: faellig.length });
  await sendText(text).catch(log);
}

/** Wöchentlich: Zielcheck – was ist bei jedem Ziel passiert, was ist der nächste konkrete Schritt. */
export async function zielcheckTick(now = new Date()): Promise<void> {
  if (config.zielcheck === "off" || state.paused) return;
  const [tag, zeit] = config.zielcheck.toLowerCase().split(/\s+/);
  const TAGE = ["so", "mo", "di", "mi", "do", "fr", "sa"];
  const today = todayKey(now);
  if (TAGE[now.getDay()] !== tag || hhmmOf(now) !== zeit || letzterZielcheck === today) return;
  letzterZielcheck = today;
  const ziele = profil.ziele.filter((z) => z.status === "offen");
  if (ziele.length === 0) return;
  audit("zielcheck", { ziele: ziele.length });
  const prompt =
    "[Wöchentlicher Zielcheck, läuft automatisch] Geh jedes offene Ziel durch: Was ist diese Woche dafür passiert (aus Gespräch und notierten Entscheidungen)? " +
    "Nenne pro Ziel einen konkreten nächsten Schritt für die kommende Woche. Wo ein Termin hilft, schlag ihn mit kalender_termin_erstellen vor (wird zum Auftrag). " +
    "Sei ehrlich, wenn ein Ziel stillsteht. Höchstens zehn Sätze.";
  try {
    const reply = await handleMessage(prompt, hooks);
    await sendText(`🎯 Zielcheck\n\n${reply}`);
  } catch (e) {
    log(e);
  }
}

export function startScheduler(): void {
  setInterval(() => zeitplanTick().catch(log), 60_000);
  setInterval(() => rueckblickTick().catch(log), 60_000);
  setInterval(() => rechnungsTick().catch(log), 60_000);
  setInterval(() => zielcheckTick().catch(log), 60_000);
}
