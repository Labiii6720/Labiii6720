import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { handleMessage } from "./agent.js";
import { config } from "./config.js";
import { audit } from "./audit.js";
import { hooks, sendeSpaeter } from "./telegram.js";
import { state } from "./state.js";
import { hhmm, imFenster, minutesOfDay, todayKey } from "./time.js";
import { faelligIm, saveZeitplaene, zeitplaene } from "./zeitplaene.js";
import { formatRechnung, offeneRechnungen } from "./finanzen.js";
import { profil } from "./profil.js";
import { gesundheit, schwaerze, voruebergehend } from "./robust.js";
import { berichtText, hatAenderungen, verdichteJetzt, verdichtungLaeuft } from "./verdichtung.js";

const log = (e: unknown) => console.error(e instanceof Error ? schwaerze(e.message) : e);

/** Claude, Telegram und die Verdichtung sind hier ersetzbar (Tests mit Attrappen); im Betrieb die echten Funktionen. */
export const abhaengigkeiten = { handleMessage, sendeSpaeter, verdichteJetzt };

// ---------- Gemeinsames Muster: erst nach Erfolg als gelaufen markieren ----------

/** Nach einem vorübergehenden Fehler frühestens so viel später erneut versuchen (solange das Fenster offen ist). */
const WIEDERHOLUNG_MS = 5 * 60_000;
/** Zeitpunkt des letzten vorübergehend gescheiterten Versuchs je Lauf (nur im Speicher) */
const letzterFehlversuch = new Map<string, number>();
/** Läufe, die gerade in Arbeit sind – ein Lauf darf nicht zweimal gleichzeitig starten, da lastRun erst nach Erfolg gesetzt wird */
const laufend = new Set<string>();
let offlineGemeldet = false;

/** Rückblick, Rechnungs-Erinnerung, Zielcheck und Verdichtung: Tag des letzten Laufs. Persistent, sonst liefe ein Lauf nach einem Neustart im Nachholfenster ein zweites Mal. */
export type Routinen = { rueckblick?: string; rechnungen?: string; zielcheck?: string; verdichtung?: string };
const ROUTINEN_DATEI = "data/routinen.json";
const WOCHENTAGE = ["so", "mo", "di", "mi", "do", "fr", "sa"];

/** ZIELCHECK «so 18:00» → Wochentag und Uhrzeit */
function zielcheckZeit(): { tag: string; zeit: string } {
  const [tag = "", zeit = ""] = config.zielcheck.toLowerCase().split(/\s+/);
  return { tag, zeit };
}

/**
 * Erster Start ohne data/routinen.json (Update auf 0.16): Was heute schon hätte laufen sollen, gilt als erledigt.
 * Die alte Version hat es wahrscheinlich schon geschickt – lieber einmal nichts als doppelt.
 */
export function routinenBeimErststart(now: Date): Routinen {
  const heute = todayKey(now);
  const vorbei = (hm: string) => /^\d{1,2}:\d{2}$/.test(hm.trim()) && hhmm(hm.trim()) <= minutesOfDay(now);
  const r: Routinen = {};
  if (config.rueckblick !== "off" && vorbei(config.rueckblick)) r.rueckblick = heute;
  if (config.rechnungErinnerung !== "off" && vorbei(config.rechnungErinnerung)) r.rechnungen = heute;
  const zc = zielcheckZeit();
  if (config.zielcheck !== "off" && WOCHENTAGE[now.getDay()] === zc.tag && vorbei(zc.zeit)) r.zielcheck = heute;
  return r;
}

const routinen: Routinen = (() => {
  try {
    const roh = JSON.parse(readFileSync(ROUTINEN_DATEI, "utf8")) as unknown;
    if (!roh || typeof roh !== "object") return {};
    const r = roh as Record<string, unknown>;
    const tag = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : undefined);
    return { rueckblick: tag("rueckblick"), rechnungen: tag("rechnungen"), zielcheck: tag("zielcheck"), verdichtung: tag("verdichtung") };
  } catch (e) {
    // Datei fehlt = erster Start; kaputtes JSON = wie bisher alles offen
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") return {};
    // Sofort speichern: nur der allererste Start wertet die Uhrzeit aus. Sonst hielte ein Neustart im Nachholfenster
    // einen vorübergehend gescheiterten Lauf für «schon vorbei» und liesse ihn für den Tag ausfallen.
    const r = routinenBeimErststart(new Date());
    speichereRoutinen(r);
    return r;
  }
})();

/** Schreibt den Stand atomar (tmp + rename, 0o600); scheitert das Speichern, gilt der Stand bis zum Neustart. */
function speichereRoutinen(r: Routinen): void {
  try {
    mkdirSync("data", { recursive: true, mode: 0o700 });
    writeFileSync(`${ROUTINEN_DATEI}.tmp`, JSON.stringify(r, null, 2), { mode: 0o600 });
    renameSync(`${ROUTINEN_DATEI}.tmp`, ROUTINEN_DATEI);
  } catch (e) {
    log(e);
  }
}

/** Merkt sich den Lauf für heute und speichert sofort. */
function merkeRoutine(schluessel: keyof Routinen, tag: string): void {
  routinen[schluessel] = tag;
  speichereRoutinen(routinen);
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

const schritteText = (n: number) => `${n} Werkzeugschritt${n === 1 ? "" : "en"}`;

/**
 * Werkzeuge, die nur lesen: feste Stufe `auto`, keine Datei, kein Auftrag, nichts an den Nutzer. Ein Lauf, der nur diese
 * benutzt hat, darf nach einem vorübergehenden Fehler wiederholt werden. Alles andere (auch unbekannte Namen, Werkzeuge mit
 * eingabeabhängiger Stufe wie seite_lesen oder mit Senden-Option wie kamera_schauen) zählt als Nebenwirkung – im Zweifel sicher.
 */
export const LESENDE_WERKZEUGE: ReadonlySet<string> = new Set([
  "wetter",
  "whoop_recovery",
  "notizen_lesen",
  "kalender_termine",
  "mails_suchen",
  "mail_lesen",
  "mail_triage",
  "dateien_auflisten",
  "datei_lesen",
  "shop_bestellungen",
  "shop_produkte",
  "geraete_status",
  "zeitplaene_anzeigen",
  "kamera_liste",
  "kamera_ereignisse",
  "wachen_anzeigen",
  "rechnungen_offen",
  "zahlung_vorbereiten",
  "protokolle_anzeigen",
  "profil_anzeigen",
]);

/**
 * Führt einen Lauf aus. Rückgabe true = als gelaufen markieren (Erfolg oder dauerhafter Fehler, der einmal gemeldet wird);
 * false = vorübergehender Fehler, der Lauf bleibt offen und wird im Fenster frühestens nach 5 Minuten erneut versucht.
 * Gibt `fn` false zurück, kam der Notaus dazwischen: nichts gemeldet, Lauf bleibt offen und darf nach /weiter sofort (im Fenster) starten.
 * Ausnahme in beiden Fällen: Hat schon ein Werkzeug mit Nebenwirkung gewirkt (`zaehle` ausserhalb von LESENDE_WERKZEUGE),
 * wird nicht wiederholt – ein Neustart des ganzen Laufs würde Erinnerungen, Rechnungen, Notizen oder Freigabe-Aufträge
 * doppelt anlegen. Abhaken und einmal melden. Reine Lesewerkzeuge halten den Lauf offen.
 */
async function ausfuehren(
  schluessel: string,
  titel: string,
  now: Date,
  fn: (zaehle: (schritt: number, werkzeug?: string) => void) => Promise<boolean | void>,
): Promise<boolean> {
  laufend.add(schluessel);
  let schritte = 0;
  const zaehle = (_schritt: number, werkzeug?: string) => {
    if (werkzeug !== undefined && LESENDE_WERKZEUGE.has(werkzeug)) return;
    schritte++;
  };
  const abbruchMelden = async (grund: string) => {
    letzterFehlversuch.delete(schluessel);
    await abhaengigkeiten
      .sendeSpaeter(`⚠️ ${titel} brach nach ${schritteText(schritte)} ab (${grund}). Ich wiederhole ihn nicht, um nichts doppelt auszuführen, Sir.`)
      .catch(log);
    return true;
  };
  try {
    const ergebnis = await fn(zaehle);
    if (ergebnis === false && schritte > 0) return await abbruchMelden("Notaus");
    letzterFehlversuch.delete(schluessel);
    return ergebnis !== false;
  } catch (e) {
    log(e);
    if (state.paused) {
      if (schritte > 0) return await abbruchMelden("Notaus");
      // Notaus während des Laufs: kein «fehlgeschlagen» melden und nicht abhaken – der Lauf bleibt für nach /weiter offen.
      return false;
    }
    if (voruebergehend(e)) {
      if (schritte > 0) return await abbruchMelden("Verbindung");
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
    // Jeder Lauf dauert; kommt währenddessen /pause oder der Notfall, startet kein weiterer Zeitplan mehr.
    if (state.paused) return;
    if (!faelligIm(z, now, config.zeitplanNachholenMin)) continue;
    const schluessel = `zeitplan:${z.id}`;
    if (!bereit(schluessel, now)) continue;
    if (wartetWeilOffline(`Zeitplan «${z.name}»`)) return;
    const fertig = await ausfuehren(schluessel, `Zeitplan «${z.name}»`, now, async (zaehle) => {
      const reply = await abhaengigkeiten.handleMessage(`[Zeitplan «${z.name}», läuft automatisch] ${z.auftrag}`, hooks, { onStep: zaehle });
      // Notaus während des Laufs: die Antwort wäre nur «Ich bin pausiert …» – nicht senden, nicht abhaken.
      if (state.paused) return false;
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
  const fertig = await ausfuehren("rueckblick", "Der Rückblick", now, async (zaehle) => {
    const reply = await abhaengigkeiten.handleMessage(prompt, hooks, { onStep: zaehle });
    if (state.paused) return false;
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
  const { tag, zeit } = zielcheckZeit();
  const today = todayKey(now);
  if (WOCHENTAGE[now.getDay()] !== tag || routinen.zielcheck === today || !imFenster(zeit, now, config.zeitplanNachholenMin)) return;
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
  const fertig = await ausfuehren("zielcheck", "Der Zielcheck", now, async (zaehle) => {
    const reply = await abhaengigkeiten.handleMessage(prompt, hooks, { onStep: zaehle });
    if (state.paused) return false;
    await abhaengigkeiten.sendeSpaeter(`🎯 Zielcheck\n\n${reply}`);
  });
  if (fertig) merkeRoutine("zielcheck", today);
}

/**
 * Nachts: Gedächtnis-Verdichtung (Haiku). Erfolg mit Änderungen → kurzer Bericht; nichts geändert → still.
 * Dauerhafter Fehler oder abgelehnter Vorschlag → eine Meldung, der Lauf gilt für heute als erledigt;
 * vorübergehender Fehler → still, im Fenster später erneut, sonst in der nächsten Nacht.
 */
export async function verdichtungTick(now = new Date()): Promise<void> {
  offlineNachfuehren();
  if (config.verdichtung === "off" || state.paused) return;
  const today = todayKey(now);
  if (routinen.verdichtung === today || !imFenster(config.verdichtung, now, config.zeitplanNachholenMin)) return;
  // Läuft gerade /verdichten, nächste Minute erneut versuchen
  if (!bereit("verdichtung", now) || verdichtungLaeuft()) return;
  if (wartetWeilOffline("die Verdichtung")) return;
  const ausgefallen = (grund: string) => abhaengigkeiten.sendeSpaeter(`⚠️ Die nächtliche Verdichtung ist ausgefallen: ${grund}`);
  const fertig = await ausfuehren("verdichtung", "Die nächtliche Verdichtung", now, async () => {
    let r: Awaited<ReturnType<typeof verdichteJetzt>>;
    try {
      r = await abhaengigkeiten.verdichteJetzt({ heute: today });
    } catch (e) {
      // Vorübergehend oder Notaus: ausfuehren hält den Lauf still offen
      if (state.paused || voruebergehend(e)) throw e;
      log(e);
      await ausgefallen(schwaerze(e instanceof Error ? e.message : String(e)));
      return;
    }
    if (state.paused) return false;
    if (r.fehler) {
      await ausgefallen(schwaerze(r.fehler));
      return;
    }
    if (r.bericht && hatAenderungen(r.bericht)) await abhaengigkeiten.sendeSpaeter(berichtText(r.bericht));
  });
  if (fertig) merkeRoutine("verdichtung", today);
}

export function startScheduler(): void {
  setInterval(() => zeitplanTick().catch(log), 60_000);
  setInterval(() => rueckblickTick().catch(log), 60_000);
  setInterval(() => rechnungsTick().catch(log), 60_000);
  setInterval(() => zielcheckTick().catch(log), 60_000);
  setInterval(() => verdichtungTick().catch(log), 60_000);
}
