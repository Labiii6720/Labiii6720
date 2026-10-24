import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { audit, throttled } from "./audit.js";
import { config } from "./config.js";
import { save, state } from "./state.js";
import { fehlerDetail } from "./robust.js";
import { notausVermerken, sendeSpaeter } from "./telegram.js";

/**
 * Notfall-Protokoll (defensiv, legal): isolieren, sperren, alarmieren.
 * KEIN Gegenangriff – das wäre strafbar und träfe meist Unbeteiligte. Stattdessen macht Jarvis sich
 * und seine Zugänge zum toten Briefkasten und sichert Spuren.
 *
 * Auslöser:
 *   - Telegram: /notfall
 *   - POST /notfall  Authorization: Bearer <JARVIS_PANIC_TOKEN>  (Handy-Kurzbefehl, Panik-Taster)
 *   - automatisch: zu viele fremde Zugriffe in kurzer Zeit (siehe watchAbuse)
 */

export interface NotfallStatus {
  aktiv: boolean;
  seit?: string;
  grund?: string;
}

const CHECKLISTE = [
  "SOFORT selbst erledigen (dauert ~5 Minuten):",
  "1. Telegram-Bot-Token bei @BotFather mit /revoke erneuern.",
  "2. Claude-API-Key in der Console löschen.",
  "3. Google: Drittanbieter-Zugriff der Jarvis-App entfernen, Dienstkonto-Schlüssel neu.",
  "4. WHOOP-Client-Secret erneuern. Shopify-App deinstallieren. Home-Assistant-Token löschen.",
  "5. Cloudflare-Tunnel löschen, Alexa-Endpunkt entfernen.",
  "6. Router prüfen, Pi vom Netz, data/ als kompromittiert behandeln.",
  "Details stehen im README unter «Wenn du einen Einbruch vermutest».",
];

/** Schaltet alles scharf ab: Notaus an, Werkzeuge/Zeitpläne/Wachen aus, Alarm + Checkliste. */
export async function ausloesen(grund: string): Promise<void> {
  // Auch wenn der Notfall schon läuft: ein vorher eingereihtes /entwarnung darf diesen Auslöser nicht aufheben.
  notausVermerken();
  if (state.notfall?.aktiv) return;
  state.notfall = { aktiv: true, seit: new Date().toISOString(), grund };
  state.paused = true; // kein Werkzeug läuft mehr, keine Freigabe geht mehr durch
  save();
  audit("NOTFALL", { grund });
  const alarm = `🚨 NOTFALL ausgelöst: ${grund}\n\nIch habe mich stillgelegt: keine Werkzeuge, keine Zeitpläne, keine Wachen, keine Freigaben. Deine Daten gebe ich nicht mehr heraus.\n\n${CHECKLISTE.join("\n")}`;
  // Mit Vorrang: sofort senden, auch wenn der Postausgang voll ist; bei Telegram-Störung vorn einreihen, nicht hinter den Rückstand.
  await sendeSpaeter(alarm, { vorrang: true }).catch((f) => console.error("Notfall-Alarm:", fehlerDetail(f)));
}

/** Hebt den Notfall auf (nur per Telegram, bewusst). */
export function aufheben(): void {
  state.notfall = { aktiv: false };
  state.paused = false;
  save();
  audit("notfall_aufgehoben", {});
}

export const notfallAktiv = () => Boolean(state.notfall?.aktiv);

// ---------- automatische Auslösung bei Angriffsmuster ----------

const treffer: number[] = [];
/** Meldet einen verdächtigen Zugriff (fremder Chat, falscher Token). Zu viele in 5 Minuten lösen den Notfall aus. */
export function abuseSignal(quelle: string): void {
  const now = Date.now();
  treffer.push(now);
  while (treffer.length && now - treffer[0] > 5 * 60_000) treffer.shift();
  audit("abuse_signal", { quelle, fenster: treffer.length });
  if (treffer.length >= 5) {
    treffer.length = 0;
    void ausloesen(`Ungewöhnlich viele unbefugte Zugriffe (${quelle}).`);
  }
}

/** Nur für Tests: das Zählfenster leeren, damit Fälle einer Datei einander nicht in den Notfall zählen. */
export function missbrauchZuruecksetzen(): void {
  treffer.length = 0;
}

/** HTTP-Panikauslöser fürs Handy. */
export async function handlePanic(req: Request, res: Response): Promise<void> {
  const token = config.panicToken;
  const given = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
    // Spur sichern, höchstens einmal pro Minute (der Endpunkt hängt am Tunnel). Bewusst kein abuseSignal und keine
    // Telegram-Meldung: sonst könnte jeder aus dem Internet den Notfall auslösen oder den Chat fluten.
    if (throttled("notfall_abgewiesen", 1 / 60)) audit("notfall_abgewiesen", { ip: String(req.header("cf-connecting-ip") ?? req.ip ?? "") });
    res.status(401).json({ ok: false });
    return;
  }
  // Nicht auf den Alarmversand warten: bei Telegram-Störung dauert er mit Wiederholungen bis ~90 s, der Kurzbefehl
  // liefe in sein Zeitlimit und der Nutzer müsste annehmen, der Notfall sei nicht ausgelöst. ausloesen setzt den
  // Zustand vor dem ersten await, die Antwort spiegelt also, was wirksam ist.
  const alarm = ausloesen("Panik-Auslöser vom Gerät.");
  if (notfallAktiv()) res.json({ ok: true });
  else res.status(500).json({ ok: false });
  await alarm;
}
