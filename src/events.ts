import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { addSystemNote, askWithBudget, handleMessage } from "./agent.js";
import { save, state, type Mode } from "./state.js";
import { briefingTeile, briefingText, briefingVerbinden, briefingVersandLaeuft, type BriefingTeile } from "./brain.js";
import { audit, throttled } from "./audit.js";
import { config } from "./config.js";
import { day } from "./state.js";
import { PIN_EINGABE_TEXT, pinEingabe } from "./pin.js";
import { hooks, sendeAntwort, sendeSpaeter, sendText, sendVoiceReply } from "./telegram.js";
import { onCameraEvent } from "./watch.js";
import { abuseSignal, notfallAktiv } from "./notfall.js";
import { schwaerze } from "./robust.js";
import { withTimeout } from "./time.js";
import { forSpeech } from "./voice.js";

/** Zeitbudget für synchrone Antworten (frage_sync, briefing_text): Standard 25 s, 3 s bis 2 min. */
const budgetMs = (wert: unknown): number => Math.min(Math.max(Number(wert) || 25_000, 3000), 120_000);

/**
 * Briefing für den Satelliten; als Container, damit Tests Quelle und Wartezeit ersetzen können.
 * Nachlieferung: Ist das Briefing beim Abruf nicht fertig, versucht Jarvis es im Hintergrund alle `pauseMs`
 * erneut (höchstens `versuche` Mal) und schickt es dann per Telegram – sonst bliebe es nach «nicht bereit» aus.
 */
export const briefingSatellit = {
  teile: briefingTeile as (opts?: { telegramKopie?: boolean }) => Promise<BriefingTeile>,
  pauseMs: 60_000,
  /** Pause zwischen zwei Versuchen; Tests binden sie an ein Ereignis statt an echte Zeit. */
  warten: (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms)),
  versuche: 10,
  /** laufende Nachlieferung (höchstens eine gleichzeitig) */
  laufend: undefined as Promise<void> | undefined,
  /** Noch laufende erste Telegram-Kopie aus brain.ts (mitWiederholung, bis gut drei Minuten). */
  versandLaeuft: (): Promise<unknown> | undefined => briefingVersandLaeuft(),
};

/** Ereignis «briefing»: Quelle und Sprachnachricht als Container, damit Tests beides ersetzen können. */
export const briefingEreignis = {
  text: briefingText as () => Promise<string>,
  sprache: sendVoiceReply as (text: string) => Promise<void>,
};

/**
 * Echtes Briefing oder nur der Platzhalter «gleich fertig»? brain.ts markiert den Platzhalter mit bereit: false;
 * der Abgleich mit dem Tages-Cache sichert zusätzlich ab (briefingTeile liefert ihn von dort oder hat ihn eben dort abgelegt).
 */
function briefingBereit(teile: BriefingTeile | undefined): teile is BriefingTeile {
  return teile !== undefined && teile.bereit !== false && Boolean(teile.text) && day().briefing?.text === teile.text;
}

/**
 * Wie in Telegram und im Gespräch der Kommandozentrale: was nach der PIN aussieht (pinEingabe; Konsole, Kurzbefehl,
 * Satellit, Home Assistant), geht weder an Claude noch in die Historie; gleiche Antwort, nicht gezählt. true = beantwortet.
 */
function pinAbweisen(text: string, res: Response): boolean {
  if (!pinEingabe(text)) return false;
  audit("pin_eingabe", { kanal: "events" });
  res.status(400).json({ ok: false, error: "pin", text: PIN_EINGABE_TEXT });
  return true;
}

/** Notaus oder Notfall: dann keine Briefing-Daten mehr an Claude oder Telegram. */
const gesperrt = (): boolean => Boolean(state.paused) || notfallAktiv();

/**
 * Holt das Briefing nach und schickt es per Telegram; bricht ab, sobald es anderweitig zugestellt wurde oder
 * Notaus/Notfall greift. Kommt es nicht zustande, meldet Jarvis das – Home Assistant wartet ja auf diese Nachlieferung.
 */
async function briefingNachliefern(schonZugestellt: boolean): Promise<void> {
  const s = briefingSatellit;
  if (s.versuche <= 0) return; // 0 = Nachlieferung aus
  /** Versuch, in dem das Briefing bereit war und brain.ts die erste Kopie angestossen hat */
  let bereitIm = 0;
  for (let versuch = 1; versuch <= s.versuche + 1; versuch++) {
    // Ein Durchgang mehr nur, um abzuwarten, ob die zuletzt angestossene Kopie ankam
    const nachlauf = versuch > s.versuche;
    if (nachlauf && !bereitIm) break;
    await s.warten(s.pauseMs);
    if (gesperrt()) {
      audit("briefing_satellit_nachgeliefert", { versuch, abgebrochen: "notaus" });
      return;
    }
    // Vor dem Urteil auf eine noch wiederholte Kopie warten, sonst käme «nicht zustande gekommen» vor dem Briefing
    if (nachlauf && !day().briefingDelivered) {
      await s.versandLaeuft()?.catch(() => undefined);
      if (gesperrt()) {
        audit("briefing_satellit_nachgeliefert", { versuch, abgebrochen: "notaus" });
        return;
      }
    }
    if (!schonZugestellt && day().briefingDelivered) {
      audit("briefing_satellit_nachgeliefert", bereitIm ? { versuch: bereitIm } : { versuch, anderweitig: true });
      return;
    }
    if (nachlauf) break;
    // Erste Kopie verschickt briefingTeile selbst (mit «zugestellt»-Merker), danach wie bei «briefing» die Dusch-Kopie
    const teile = await s.teile({ telegramKopie: true }).catch(() => undefined);
    if (!briefingBereit(teile)) continue;
    if (schonZugestellt) {
      if (gesperrt()) {
        audit("briefing_satellit_nachgeliefert", { versuch, abgebrochen: "notaus" });
        return;
      }
      await sendeSpaeter(`🚿 ${briefingVerbinden(teile)}`, { imNotfallZurueckhalten: true });
      audit("briefing_satellit_nachgeliefert", { versuch });
      return;
    }
    // brain.ts sendet im Hintergrund und setzt «zugestellt» erst nach Erfolg: weiter prüfen, ein Fehlschlag wird im
    // nächsten Durchgang neu angestossen (eine noch laufende Kopie verhindert dort ein Doppel)
    bereitIm ||= versuch;
  }
  audit("briefing_satellit_nachgeliefert", { versuch: s.versuche, bereit: Boolean(bereitIm), zugestellt: false });
  if (gesperrt()) return;
  await sendeSpaeter(
    schonZugestellt
      ? `Die Kopie des Briefings für nach der Dusche ist nicht zustande gekommen, ${config.anrede}. Das von heute früh steht weiter oben.`
      : `Das Briefing ist heute nicht zustande gekommen, ${config.anrede}. Fragen Sie mich später danach, dann versuche ich es erneut.`,
    { imNotfallZurueckhalten: true },
  );
}

/**
 * Ereignisse von Home Assistant (oder jedem anderen Gerät im Heimnetz):
 *   POST /events  Authorization: Bearer <JARVIS_EVENT_TOKEN>
 *   { "event": "briefing" }                         → Tagesbriefing per Telegram (und als Sprachnachricht, falls TTS);
 *                                                     im Notaus/Notfall { ok: false, gesperrt: true } ohne Briefing
 *   { "event": "briefing_text", "kopie": "telegram", "budget": 25000 }
 *                                                   → { ok, bereit, text }: Briefing zum Vorlesen (Satellit im Bad), ohne Telegram;
 *                                                     mit kopie "telegram" zusätzlich als Text an Telegram. Nie über den Tunnel.
 *                                                     Nicht fertig → { ok: false, bereit: false, text: "" }, Nachlieferung per Telegram.
 *                                                     Notaus/Notfall → { ok: false, bereit: false, text: "", gesperrt: true }, kein Abruf.
 *   { "event": "nachricht", "text": "…" }           → Text 1:1 per Telegram (über den Postausgang: im Notfall
 *                                                     zurückgehalten bis /entwarnung, bei Störung nachgereicht)
 *   { "event": "frage", "text": "…" }               → Jarvis bearbeitet den Text mit allen Werkzeugen, Antwort per Telegram
 *                                                     (im Notaus/Notfall keine)
 *   { "event": "frage_sync", "text": "…", "budget": 25000, "kanal": "stimme" }
 *                                                   → Antwort kommt direkt zurück (Gesten-Konsole, Siri-Kurzbefehl); dauert es
 *                                                     länger als budget ms, kommt sie per Telegram nach. Bei frage und
 *                                                     frage_sync gilt: PIN-förmig (pinEingabe) → 400 { ok: false, error: "pin", text },
 *                                                     nie gezählt
 *   { "event": "kontext", "text": "Angekommen: Arbeit", "modus": "fokus" }
 *                                                   → stiller Hinweis fürs Gespräch, optional Modus wechseln (Kurzbefehl-Automationen)
 *   { "event": "kamera", "kamera": "raum", "label": "person", "zonen": [], "id": "…" } → Kamera-Meldung nach den Regeln in cameras.json
 */
export async function handleEvent(req: Request, res: Response): Promise<void> {
  const token = config.eventToken;
  const given = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
    audit("events_abgewiesen", { ip: req.ip });
    abuseSignal("events");
    if (throttled("events_abgewiesen")) sendText(`⚠️ Jemand hat /events mit falschem Token aufgerufen (${req.ip}).`).catch(() => undefined);
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const body = (req.body ?? {}) as { event?: string; text?: string; kamera?: string; label?: string; zonen?: string[]; id?: string; budget?: number; kanal?: string; modus?: string; kopie?: string };
  const text = String(body.text ?? "").slice(0, 4000);
  try {
    switch (body.event) {
      case "briefing": {
        // Notaus/Notfall: keine Briefing-Daten an Claude oder Telegram (wie bei briefing_text)
        const abweisen = (): void => {
          audit("briefing_abgewiesen", { grund: "notaus" });
          res.json({ ok: false, gesperrt: true });
        };
        if (gesperrt()) return abweisen();
        const already = Boolean(day().briefingDelivered);
        const t = await briefingEreignis.text(); // schickt beim ersten Mal selbst eine Telegram-Kopie
        // Notaus/Notfall während des Livebaus (bis 6 s) oder der Dusch-Kopie: nichts mehr hinausschicken
        if (gesperrt()) return abweisen();
        if (already) await sendText(`🚿 ${t}`);
        if (gesperrt()) return abweisen();
        await briefingEreignis.sprache(t);
        break;
      }
      case "briefing_text": {
        // Das Briefing enthält Termine und Gesundheitswerte: auch bei EVENTS_VIA_TUNNEL=on nur aus dem Heimnetz
        if (req.header("cf-connecting-ip") || req.header("cf-ray")) {
          audit("briefing_satellit_abgewiesen", { grund: "tunnel" });
          res.status(404).end();
          return;
        }
        // Notaus/Notfall: wie «briefing» abweisen – kein Livebau bei Claude, keine Termine oder Gesundheitswerte heraus
        const abweisen = (): void => {
          audit("briefing_satellit_abgewiesen", { grund: "notaus" });
          res.json({ ok: false, bereit: false, text: "", gesperrt: true });
        };
        if (gesperrt()) return abweisen();
        const kopie = body.kopie === "telegram";
        const schonZugestellt = Boolean(day().briefingDelivered);
        // Ohne Kopie keine Telegram-Nachricht; mit Kopie schickt briefingTeile die erste selbst, danach wie bei «briefing»
        const teile = await withTimeout(briefingSatellit.teile({ telegramKopie: kopie }), budgetMs(body.budget)).catch(() => undefined);
        // Notaus/Notfall während des Abrufs: nichts herausgeben, keine Kopie, keine Nachlieferung
        if (gesperrt()) return abweisen();
        if (!briefingBereit(teile)) {
          // Kein «Eine Minute» ansagen: das wäre für Home Assistant ein Erfolg, und danach käme nichts mehr.
          // Leerer Text lässt die Automation auf Telegram ausweichen; das echte Briefing liefert Jarvis selbst nach.
          briefingSatellit.laufend ??= briefingNachliefern(schonZugestellt)
            .catch((e: unknown) => console.error("Briefing-Nachlieferung:", e instanceof Error ? schwaerze(e.message) : e))
            .finally(() => { briefingSatellit.laufend = undefined; });
          audit("briefing_satellit", { kopie, bereit: false, zeichen: 0 });
          res.json({ ok: false, bereit: false, text: "", nachlieferung: "telegram" });
          return;
        }
        const roh = briefingVerbinden(teile);
        if (!kopie) {
          // Erst hier steht fest, dass Home Assistant das Briefing bekommt (Livebau kann das Budget überdauern)
          const d = day();
          if (!d.briefingVorgelesen) { d.briefingVorgelesen = true; save(); }
        }
        if (kopie && schonZugestellt) {
          // Nicht auf Telegram warten: Home Assistant soll sofort vorlesen können
          void sendeSpaeter(`🚿 ${roh}`, { imNotfallZurueckhalten: true }).catch((e: unknown) => console.error("Briefing-Kopie:", e instanceof Error ? schwaerze(e.message) : e));
        }
        audit("briefing_satellit", { kopie, bereit: true, zeichen: roh.length });
        res.json({ ok: true, bereit: true, text: forSpeech(roh) });
        return;
      }
      case "nachricht":
        if (!text) throw new Error("text fehlt");
        // Über den Postausgang: im Notfall wartet die Hausmeldung bis /entwarnung, bei Störung wird sie nachgereicht
        await sendeSpaeter(text);
        break;
      case "frage": {
        if (!text) throw new Error("text fehlt");
        if (pinAbweisen(text, res)) return;
        res.json({ ok: true, queued: true }); // nicht warten, Jarvis braucht evtl. länger
        let eintrag: object | undefined;
        const reply = await handleMessage(`[Ereignis aus dem Haus] ${text}`, hooks, { onAntwort: (e) => void (eintrag = e) });
        // Wie frage_sync: ohne Token und Schlüssel; im Notaus/Notfall nichts, auch kein Pausenhinweis
        await sendeAntwort(schwaerze(reply), eintrag);
        return;
      }
      case "frage_sync": {
        if (!text) throw new Error("text fehlt");
        if (pinAbweisen(text, res)) return;
        const budget = budgetMs(body.budget);
        const prefix = body.kanal === "stimme" ? "[Kanal: Stimme, die Antwort wird vorgelesen] " : "[Kurzbefehl] ";
        // Echo und Antworten ohne Token und Schlüssel; im Notaus/Notfall nichts davon (askWithBudget, sendeAntwort)
        const echo = schwaerze(text).slice(0, 60);
        const reply = await askWithBudget(prefix + text, budget, hooks, (r, eintrag) => sendeAntwort(`Zu Ihrer Frage von unterwegs («${echo}»):\n\n${schwaerze(r)}`, eintrag));
        if (reply === undefined) res.json({ ok: true, queued: true, reply: `Das braucht einen Moment, ${config.anrede}. Die Antwort kommt per Telegram.` });
        else res.json({ ok: true, reply: schwaerze(reply) });
        return;
      }
      case "kontext": {
        if (!text) throw new Error("text fehlt");
        addSystemNote(`Kontext vom Handy: ${text}`);
        if (body.modus && ["normal", "fokus", "nacht"].includes(body.modus)) {
          state.mode = body.modus as Mode;
          save();
        }
        res.json({ ok: true, modus: state.mode ?? "normal" });
        return;
      }
      case "kamera": {
        if (!body.kamera || !body.label) throw new Error("kamera und label fehlen");
        const gemeldet = await onCameraEvent({ camera: body.kamera, label: body.label, zones: body.zonen, id: body.id });
        res.json({ ok: true, gemeldet });
        return;
      }
      default:
        throw new Error(`unbekanntes Ereignis «${body.event}»`);
    }
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Ereignis-Fehler:", msg);
    if (!res.headersSent) res.status(400).json({ ok: false, error: msg });
  }
}
