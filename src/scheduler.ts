import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { handleMessage } from "./agent.js";
import { config } from "./config.js";
import { audit } from "./audit.js";
import { hooks, sendeSpaeter } from "./telegram.js";
import { state } from "./state.js";
import { imFenster, todayKey } from "./time.js";
import { faelligIm, saveZeitplaene, zeitplaene } from "./zeitplaene.js";
import { formatRechnung, offeneRechnungen } from "./finanzen.js";
import { profil } from "./profil.js";
import { gesundheit, schwaerze, voruebergehend } from "./robust.js";

const log = (e: unknown) => console.error(e instanceof Error ? schwaerze(e.message) : e);

/** Claude und Telegram sind hier ersetzbar (Tests mit Attrappen); im Betrieb die echten Funktionen. */
export const abhaengigkeiten = { handleMessage, sendeSpaeter };

// ---------- Gemeinsames Muster: erst nach Erfolg als gelaufen markieren ----------

/** Nach einem vorübergehenden Fehler frühestens so viel später erneut versuchen (solange das Fenster offen ist). */
const WIEDERHOLUNG_MS = 5 * 60_000;
/** Zeitpunkt des letzten vorübergehend gescheiterten Versuchs je Lauf (nur im Speicher) */
const letzterFehlversuch = new Map<string, number>();
/** Läufe, die gerade in Arbeit sind – ein Lauf darf nicht zweimal gleichzeitig starten, da lastRun erst nach Erfolg gesetzt wird */
const laufend = new Set<string>();
let offlineGemeldet = false;

/** Rückblick, Rechnungs-Erinnerung und Zielcheck: Tag des letzten Laufs. Persistent, sonst liefe ein Lauf nach einem Neustart im Nachholfenster ein zweites Mal. */
type Routinen = { rueckblick?: string; rechnungen?: string; zielcheck?: string };
const ROUTINEN_DATEI = "data/routinen.json";
const routinen: Routinen = (() => {
  try {
    const roh = JSON.parse(readFileSync(ROUTINEN_DATEI, "utf8")) as unknown;
    if (!roh || typeof roh !== "object") return {};
    const r = roh as Record<string, unknown>;
    const tag = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : undefined);
    return { rueckblick: tag("rueckblick"), rechnungen: tag("rechnungen"), zielcheck: tag("zielcheck") };
  } catch {
    return {};
  }
})();

/** Merkt sich den Lauf für heute und speichert sofort (atomar); scheitert das Speichern, gilt der Merker bis zum Neustart. */
function merkeRoutine(schluessel: keyof Routinen, tag: string): void {
  routinen[schluessel] = tag;
  try {
    mkdirSync("data", { recursive: true, mode: 0o700 });
    writeFileSync(`${ROUTINEN_DATEI}.tmp`, JSON.stringify(routinen, null, 2), { mode: 0o600 });
    renameSync(`${ROUTINEN_DATEI}.tmp`, ROUTINEN_DATEI);
  } catch (e) {
    log(e);
  }
}

/** Ist die Verbindung wieder da, darf die nächste Störung wieder eine Log-Zeile bekommen – auch wenn gerade kein Lauf fällig ist. */
function offlineNachfuehren(): void {
  if (!gesundheit.istOffline()) offlineGemeldet = false;
}

/** Darf dieser Lauf jetzt starten? Nicht, wenn er noch läuft oder der letzte vorübergehende Fehler keine 5 Minuten her ist. */
function bereit(schluessel: string, now: Date): boolean {
  if (laufend.has(schluessel)) return false;
  const t = letzterFehlversuch.get(schluessel);
  return t === undefined || now.getTime() - t >= WIEDERHOLUNG_MS;
}

/** Bei Internetausfall gar nicht erst starten – eine Log-Zeile pro Störung, kein Fehler. */
function wartetWeilOffline(was: string): boolean {
  if (!gesundheit.istOffline()) {
    offlineGemeldet = false;
    return false;
  }
  if (!offlineGemeldet) {
    offlineGemeldet = true;
    console.log(`[scheduler] Verbindung gestört – ${was} wartet, bis sie wieder da ist.`);
  }
  return true;
}

/**
 * Führt einen Lauf aus. Rückgabe true = als gelaufen markieren (Erfolg oder dauerhafter Fehler, der einmal gemeldet wird);
 * false = vorübergehender Fehler, der Lauf bleibt offen und wird im Fenster frühestens nach 5 Minuten erneut versucht.
 */
async function ausfuehren(schluessel: string, titel: string, now: Date, fn: () => Promise<void>): Promise<boolean> {
  laufend.add(schluessel);
  try {
    await fn();
    letzterFehlversuch.delete(schluessel);
    return true;
  } catch (e) {
    log(e);
    if (voruebergehend(e)) {
      letzterFehlversuch.set(schluessel, now.getTime());
      return false;
    }
    letzterFehlversuch.delete(schluessel);
    const grund = schwaerze(e instanceof Error ? e.message : String(e));
    await abhaengigkeiten.sendeSpaeter(`⚠️ ${titel} ist fehlgeschlagen: ${grund}`).catch(log);
    return true;
  } finally {
    laufend.delete(schluessel);
  }
}

/** Prüft jede Minute, ob ein Zeitplan dran ist (auch im Nachholfenster), und lässt Jarvis den Auftrag erledigen. */
export async function zeitplanTick(now = new Date()): Promise<void> {
  offlineNachfuehren();
  if (state.paused) return;
  const today = todayKey(now);
  for (const z of zeitplaene) {
    if (!faelligIm(z, now, config.zeitplanNachholenMin)) continue;
    const schluessel = `zeitplan:${z.id}`;
    if (!bereit(schluessel, now)) continue;
    if (wartetWeilOffline(`Zeitplan «${z.name}»`)) return;
    const fertig = await ausfuehren(schluessel, `Zeitplan «${z.name}»`, now, async () => {
      const reply = await abhaengigkeiten.handleMessage(`[Zeitplan «${z.name}», läuft automatisch] ${z.auftrag}`, hooks);
      await abhaengigkeiten.sendeSpaeter(`🕒 ${z.name}\n\n${reply}`);
    });
    if (fertig) {
      z.lastRun = today;
      saveZeitplaene();
    }
  }
}

/**
 * Täglicher Rückblick: Jarvis schaut auf den Tag zurück, notiert Entscheidungen, belegte Muster und Fortschritt
 * bei den Zielen und schlägt Anpassungen vor (Ziele/Werte landen als Aufträge, du entscheidest morgens).
 * Das ist das Lernen über dich – ohne dass Jarvis an sich selbst herumschraubt.
 */
export async function rueckblickTick(now = new Date()): Promise<void> {
  offlineNachfuehren();
  if (config.rueckblick === "off" || state.paused) return;
  const today = todayKey(now);
  if (routinen.rueckblick === today || !imFenster(config.rueckblick, now, config.zeitplanNachholenMin)) return;
  if (!bereit("rueckblick", now)) return;
  if (wartetWeilOffline("der Rückblick")) return;
  audit("rueckblick", {});
  const prompt =
    "[Tagesrückblick, läuft automatisch] Schau auf das heutige Gespräch zurück. " +
    "1) Notiere getroffene Entscheidungen mit entscheidung_notieren (nur echte, keine Kleinigkeiten). " +
    "2) Gibt es ein belegtes Entscheidungsmuster (mindestens zwei konkrete Belege, auf Entscheidungen bezogen), halte es mit muster_festhalten fest; sonst nicht. " +
    "3) Hat sich etwas an Zielen oder Werten gezeigt, schlag es mit ziel_setzen oder wert_setzen vor (das wird zum Auftrag). " +
    "4) Antworte mir in höchstens vier Sätzen: Was war heute wichtig, was steht morgen an, und ein ehrlicher Hinweis, falls du einen hast.";
  const fertig = await ausfuehren("rueckblick", "Der Rückblick", now, async () => {
    const reply = await abhaengigkeiten.handleMessage(prompt, hooks);
    await abhaengigkeiten.sendeSpaeter(`🌙 Rückblick\n\n${reply}`);
  });
  if (fertig) merkeRoutine("rueckblick", today);
}

/** Täglich: Rechnungen, die in den nächsten Tagen fällig oder schon überfällig sind. Ohne Claude, nur Daten. */
export async function rechnungsTick(now = new Date()): Promise<void> {
  offlineNachfuehren();
  if (config.rechnungErinnerung === "off" || state.paused) return;
  const today = todayKey(now);
  if (routinen.rechnungen === today || !imFenster(config.rechnungErinnerung, now, config.zeitplanNachholenMin)) return;
  if (!bereit("rechnungen", now)) return;
  const grenze = new Date(now.getTime() + config.rechnungVorlauf * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Europe/Zurich" });
  const faellig = offeneRechnungen().filter((r) => r.faellig && r.faellig <= grenze);
  if (faellig.length === 0) {
    merkeRoutine("rechnungen", today);
    return;
  }
  const ueberfaellig = faellig.filter((r) => r.faellig! < today);
  const text = [
    `💳 Rechnungen: ${faellig.length} fällig bis ${grenze}${ueberfaellig.length ? `, davon ${ueberfaellig.length} überfällig` : ""}`,
    ...faellig.map(formatRechnung),
    "«Bereite die Zahlung für #… vor» liefert die Daten für die Bank-App.",
  ].join("\n");
  audit("rechnungs_erinnerung", { anzahl: faellig.length });
  // Kein Claude nötig; geht Telegram nicht, legt sendeSpaeter den Text in den Postausgang und reicht ihn nach.
  const fertig = await ausfuehren("rechnungen", "Die Rechnungs-Erinnerung", now, () => abhaengigkeiten.sendeSpaeter(text));
  if (fertig) merkeRoutine("rechnungen", today);
}

/** Wöchentlich: Zielcheck – was ist bei jedem Ziel passiert, was ist der nächste konkrete Schritt. */
export async function zielcheckTick(now = new Date()): Promise<void> {
  offlineNachfuehren();
  if (config.zielcheck === "off" || state.paused) return;
  const [tag, zeit = ""] = config.zielcheck.toLowerCase().split(/\s+/);
  const TAGE = ["so", "mo", "di", "mi", "do", "fr", "sa"];
  const today = todayKey(now);
  if (TAGE[now.getDay()] !== tag || routinen.zielcheck === today || !imFenster(zeit, now, config.zeitplanNachholenMin)) return;
  if (!bereit("zielcheck", now)) return;
  const ziele = profil.ziele.filter((z) => z.status === "offen");
  if (ziele.length === 0) {
    merkeRoutine("zielcheck", today);
    return;
  }
  if (wartetWeilOffline("der Zielcheck")) return;
  audit("zielcheck", { ziele: ziele.length });
  const prompt =
    "[Wöchentlicher Zielcheck, läuft automatisch] Geh jedes offene Ziel durch: Was ist diese Woche dafür passiert (aus Gespräch und notierten Entscheidungen)? " +
    "Nenne pro Ziel einen konkreten nächsten Schritt für die kommende Woche. Wo ein Termin hilft, schlag ihn mit kalender_termin_erstellen vor (wird zum Auftrag). " +
    "Sei ehrlich, wenn ein Ziel stillsteht. Höchstens zehn Sätze.";
  const fertig = await ausfuehren("zielcheck", "Der Zielcheck", now, async () => {
    const reply = await abhaengigkeiten.handleMessage(prompt, hooks);
    await abhaengigkeiten.sendeSpaeter(`🎯 Zielcheck\n\n${reply}`);
  });
  if (fertig) merkeRoutine("zielcheck", today);
}

export function startScheduler(): void {
  setInterval(() => zeitplanTick().catch(log), 60_000);
  setInterval(() => rueckblickTick().catch(log), 60_000);
  setInterval(() => rechnungsTick().catch(log), 60_000);
  setInterval(() => zielcheckTick().catch(log), 60_000);
}
