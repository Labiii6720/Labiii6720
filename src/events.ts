import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { addSystemNote, askWithBudget, handleMessage } from "./agent.js";
import { save, state, type Mode } from "./state.js";
import { briefingText } from "./brain.js";
import { audit, throttled } from "./audit.js";
import { config } from "./config.js";
import { day } from "./state.js";
import { hooks, sendText, sendVoiceReply } from "./telegram.js";
import { onCameraEvent } from "./watch.js";
import { abuseSignal } from "./notfall.js";

/**
 * Ereignisse von Home Assistant (oder jedem anderen Gerät im Heimnetz):
 *   POST /events  Authorization: Bearer <JARVIS_EVENT_TOKEN>
 *   { "event": "briefing" }                         → Tagesbriefing per Telegram (und als Sprachnachricht, falls TTS)
 *   { "event": "nachricht", "text": "…" }           → Text 1:1 per Telegram
 *   { "event": "frage", "text": "…" }               → Jarvis bearbeitet den Text mit allen Werkzeugen, Antwort per Telegram
 *   { "event": "frage_sync", "text": "…", "budget": 25000, "kanal": "stimme" }
 *                                                   → Antwort kommt direkt zurück (Gesten-Konsole, Siri-Kurzbefehl); dauert es
 *                                                     länger als budget ms, kommt sie per Telegram nach
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
  const body = (req.body ?? {}) as { event?: string; text?: string; kamera?: string; label?: string; zonen?: string[]; id?: string; budget?: number; kanal?: string; modus?: string };
  const text = String(body.text ?? "").slice(0, 4000);
  try {
    switch (body.event) {
      case "briefing": {
        const already = Boolean(day().briefingDelivered);
        const t = await briefingText(); // schickt beim ersten Mal selbst eine Telegram-Kopie
        if (already) await sendText(`🚿 ${t}`);
        await sendVoiceReply(t);
        break;
      }
      case "nachricht":
        if (!text) throw new Error("text fehlt");
        await sendText(text);
        break;
      case "frage": {
        if (!text) throw new Error("text fehlt");
        res.json({ ok: true, queued: true }); // nicht warten, Jarvis braucht evtl. länger
        const reply = await handleMessage(`[Ereignis aus dem Haus] ${text}`, hooks);
        await sendText(reply);
        return;
      }
      case "frage_sync": {
        if (!text) throw new Error("text fehlt");
        const budget = Math.min(Math.max(Number(body.budget) || 25_000, 3000), 120_000);
        const prefix = body.kanal === "stimme" ? "[Kanal: Stimme, die Antwort wird vorgelesen] " : "[Kurzbefehl] ";
        const reply = await askWithBudget(prefix + text, budget, hooks, async (r) => void (await sendText(`Zu Ihrer Frage von unterwegs («${text.slice(0, 60)}»):\n\n${r}`)));
        if (reply === undefined) res.json({ ok: true, queued: true, reply: `Das braucht einen Moment, ${config.anrede}. Die Antwort kommt per Telegram.` });
        else res.json({ ok: true, reply });
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
