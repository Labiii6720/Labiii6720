import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NextFunction, Request, Response } from "express";
import { askWithBudget } from "./agent.js";
import { audit } from "./audit.js";
import { cameras, snapshot } from "./cameras.js";
import { config } from "./config.js";
import { offeneRechnungen } from "./finanzen.js";
import { haStates } from "./homeassistant.js";
import { ausloesen, notfallAktiv } from "./notfall.js";
import { profil } from "./profil.js";
import { protokolle, runProtokoll } from "./protokolle.js";
import { createAuftrag, getAuftrag, offeneAuftraege } from "./queue.js";
import { save, state, type Mode } from "./state.js";
import { approveAuftrag, denyAuftrag, hooks, sendText } from "./telegram.js";
import { allWachen } from "./cameras.js";
import { vorgaenge } from "./vorgaenge.js";
import { zeitplaene } from "./zeitplaene.js";

/**
 * Kommandozentrale («der Kern»): Lesen und Handeln über das Dashboard. Nur Heimnetz/Tailscale (lanOnly im Server)
 * und nur mit JARVIS_EVENT_TOKEN. Freigaben laufen über dieselben Funktionen wie in Telegram, inklusive PIN.
 */
export function dashboardAuth(req: Request, res: Response, next: NextFunction): void {
  const token = config.eventToken;
  const given = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "") || String(req.query.token ?? "");
  if (!token || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  next();
}

export function statusJson(_req: Request, res: Response): void {
  res.json({
    ok: true,
    zeit: new Date().toISOString(),
    name: config.name,
    modus: state.mode ?? "normal",
    pausiert: Boolean(state.paused),
    notfall: notfallAktiv(),
    auftraege: offeneAuftraege().map((a) => ({ id: a.id, tool: a.tool, stufe: a.stufe, summary: a.summary, seit: a.createdAt })),
    rechnungen: offeneRechnungen().slice(0, 10).map((r) => ({ id: r.id, empfaenger: r.empfaenger, betrag: r.betrag, waehrung: r.waehrung, faellig: r.faellig })),
    vorgaenge: vorgaenge.slice(-8).map((v) => ({ id: v.id, status: v.status, steps: v.steps, auftrag: v.auftrag.slice(0, 90) })),
    zeitplaene: zeitplaene.map((z) => ({ id: z.id, name: z.name, zeit: z.zeit, tage: z.tage })),
    wachen: allWachen().map((w) => ({ kamera: w.kamera, frage: w.frage.slice(0, 80), alle_minuten: w.alle_minuten })),
    kameras: Object.entries(cameras).map(([k, c]) => ({ name: k, beschreibung: c.beschreibung })),
    protokolle: Object.entries(protokolle).map(([k, p]) => ({ name: k, beschreibung: p.beschreibung, stufe: p.stufe })),
    ziele: profil.ziele.filter((z) => z.status === "offen").map((z) => ({ id: z.id, text: z.text, frist: z.frist })),
    werte: profil.werte,
  });
}

export async function auftragAction(req: Request, res: Response): Promise<void> {
  const { id, aktion, pin } = (req.body ?? {}) as { id?: number; aktion?: string; pin?: string };
  const a = getAuftrag(Number(id));
  if (!a) return void res.status(404).json({ ok: false, error: "Auftrag nicht gefunden" });
  const text = aktion === "ok" ? await approveAuftrag(a, pin) : await denyAuftrag(a);
  res.json({ ok: true, text, status: a.status });
}

export async function chat(req: Request, res: Response): Promise<void> {
  const text = String((req.body ?? {}).text ?? "").slice(0, 4000).trim();
  if (!text) return void res.status(400).json({ ok: false, error: "text fehlt" });
  if (text === "/notfall") {
    await ausloesen("Über die Kommandozentrale ausgelöst.");
    return void res.json({ ok: true, reply: "🚨 Notfall ausgelöst." });
  }
  const reply = await askWithBudget(`[Kommandozentrale] ${text}`, 60_000, hooks, async (r) => void (await sendText(`Zur Frage aus der Zentrale («${text.slice(0, 60)}»):\n\n${r}`)));
  res.json({ ok: true, reply: reply ?? "Das braucht länger, die Antwort kommt per Telegram.", queued: reply === undefined });
}

export async function kameraBild(req: Request, res: Response): Promise<void> {
  const name = String(req.params.name);
  if (!cameras[name]) return void res.status(404).end();
  try {
    const img = await snapshot(name, 480);
    res.set("Content-Type", "image/jpeg").set("Cache-Control", "no-store").send(img);
  } catch (e) {
    res.status(502).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export function auditTail(_req: Request, res: Response): void {
  try {
    const lines = readFileSync("data/audit.log", "utf8").trim().split("\n").slice(-60).reverse();
    res.json({ ok: true, lines });
  } catch {
    res.json({ ok: true, lines: [] });
  }
}

export async function protokollAction(req: Request, res: Response): Promise<void> {
  const name = String((req.body ?? {}).name ?? "");
  const p = protokolle[name];
  if (!p) return void res.status(404).json({ ok: false, error: "Protokoll unbekannt" });
  if (p.stufe === "auto") {
    const out = await runProtokoll(name, hooks);
    audit("protokoll", { name, quelle: "dashboard" });
    return void res.json({ ok: true, text: out });
  }
  const a = createAuftrag({ tool: "protokoll_ausfuehren", input: { name }, stufe: p.stufe, summary: `Protokoll «${name}»: ${p.beschreibung}` });
  await hooks.onAuftrag(a).catch(() => undefined);
  res.json({ ok: true, text: `Auftrag #${a.id} angelegt (${p.stufe}), Freigabe unten in den Aufträgen.` });
}

export async function geraete(req: Request, res: Response): Promise<void> {
  if (!config.homeAssistant) return void res.json({ ok: true, text: "Home Assistant nicht eingerichtet." });
  try {
    res.json({ ok: true, text: await haStates(req.query.filter ? String(req.query.filter) : undefined) });
  } catch (e) {
    res.json({ ok: false, text: e instanceof Error ? e.message : String(e) });
  }
}

export function modus(req: Request, res: Response): void {
  const m = String((req.body ?? {}).modus ?? "");
  if (!["normal", "fokus", "nacht"].includes(m)) return void res.status(400).json({ ok: false });
  state.mode = m as Mode;
  save();
  res.json({ ok: true, modus: m });
}
