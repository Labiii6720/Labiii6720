import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NextFunction, Request, Response } from "express";
import { askWithBudget } from "./agent.js";
import { audit } from "./audit.js";
import { allWachen, bedingungWert, cameras, camerasNichtGeladen, dynamicWachen, neueWacheId, pruefeWache, ruheMinuten, saveWachen, snapshot, WACHEN_UNLESBAR, wacheZustand, wachenNichtGeladen, type Wache } from "./cameras.js";
import { verbrauchVerlauf } from "./claude.js";
import { config } from "./config.js";
import { finanzUebersicht, offeneRechnungen, RECHNUNGEN_UNLESBAR, rechnungenNichtGeladen, type Rechnung } from "./finanzen.js";
import { haStates } from "./homeassistant.js";
import { ausloesen, notfallAktiv } from "./notfall.js";
import { profil } from "./profil.js";
import { protokollFesthalten, protokolle, protokollGesperrt, runProtokoll } from "./protokolle.js";
import { AUFTRAEGE_UNLESBAR, auftraege, auftraegeNichtGeladen, createAuftrag, getAuftrag, offeneAuftraege, type Auftrag, type Status } from "./queue.js";
import { gesundheit, schwaerze } from "./robust.js";
import { save, state, type Mode } from "./state.js";
import { approveAuftrag, denyAuftrag, hooks, notausAn, notausAus, pinGesperrtText, pinPruefen, pinSperreRest, sendText } from "./telegram.js";
import { vorgaenge, vorgaengeNichtGeladen } from "./vorgaenge.js";
import { naechsterLauf, neueZeitplanId, normaleTage, pruefeZeitplan, saveZeitplaene, ZEITPLAENE_UNLESBAR, zeitplaene, zeitplaeneNichtGeladen, zeitplanZustand, type Zeitplan } from "./zeitplaene.js";

/**
 * Kommandozentrale («der Kern»): Lesen und Handeln über das Dashboard. Nur Heimnetz/Tailscale (lanOnly im Server)
 * und nur mit JARVIS_EVENT_TOKEN. Freigaben laufen über dieselben Funktionen wie in Telegram, inklusive PIN.
 */
export function dashboardAuth(req: Request, res: Response, next: NextFunction): void {
  const token = config.eventToken;
  // Nur der Header: ein ?token= landete in Browser-Verlauf, Proxy- und Server-Logs.
  const given = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  next();
}

/** CSP der Kommandozentrale (Header für /dashboard und die beiden statischen Dateien): nur eigener Ursprung, kein Inline-Code. */
export const DASHBOARD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

/** Antwort auf gesperrte Daten-Endpunkte im Notfall (423 Locked), ohne die Quelle anzufragen. */
const NOTFALL_GESPERRT = { ok: false, error: "notfall", text: "Im Notfall gebe ich keine Daten heraus, Sir. Erst /entwarnung." } as const;

/**
 * Vor jede Daten- und Schreibroute (server.ts): im Notfall 423, ohne den Handler zu erreichen. Ausnahmen bleiben
 * /status.json (zeigt den Notfall), POST /api/notaus (Pause bleibt möglich) und POST /api/notfall.
 */
export function notfallSperre(_req: Request, res: Response, next: NextFunction): void {
  if (notfallAktiv()) return void res.status(423).json(NOTFALL_GESPERRT);
  next();
}

/** Text für Audit-Einträge: Auftragstexte und Fragen nur gekürzt (sie können Inhalte tragen). */
const kurz = (t: unknown, n = 120): string => schwaerze(String(t ?? "")).slice(0, n);

/**
 * Zweite Verteidigung: Einträge ohne «tage» oder «zeit» als Text lässt schon ladeListe (zeitplanEintrag) beim Laden weg.
 * Käme trotzdem einer durch, darf das Dashboard nicht mit 500 ausfallen (sonst «Verbindung gestört» samt Notaus-Anzeige);
 * der Eintrag erscheint ohne nächsten Lauf.
 */
const tageAnzeige = (tage: unknown): string => (typeof tage === "string" ? (normaleTage(tage) ?? tage) : "");
const zeitAnzeige = (zeit: unknown): string => (typeof zeit === "string" ? zeit : "");
/** Dasselbe für von Hand bearbeitete Wachen (data/wachen.json, cameras.json): fehlt «frage», kein 500. */
const frageAnzeige = (frage: unknown): string => (typeof frage === "string" ? frage : "");
/**
 * Und für «name» und «auftrag» eines von Hand bearbeiteten Zeitplans: fehlen sie, kein undefined in der Antwort. Sonst
 * füllte der Bearbeiten-Dialog die Felder mit dem Text «undefined», und ein Speichern übernähme ihn als Name bzw. Auftrag.
 * Ebenso «kamera» einer von Hand bearbeiteten Wache (data/wachen.json): fehlt sie, "" statt eines fehlenden Felds.
 */
const textAnzeige = (text: unknown): string => (typeof text === "string" ? text : "");
/**
 * Intervall einer Wache für die Anzeige, nach derselben Regel wie der Takt (wacheZustand in cameras.ts): ohne gültiges
 * «alle_minuten» (von Hand bearbeitet) läuft sie nicht – dann alle_minuten null und laeuft false statt «undefined
 * Minuten». Ebenso wenig läuft eine Wache auf einer Kamera, die nicht (mehr) in cameras.json steht oder beim Laden
 * verworfen wurde (z. B. «garten»: null); dann bleibt das eingetragene Intervall stehen. Läuft sie nicht, nennt «grund»
 * die Ursache.
 */
const taktAnzeige = (w: Wache): { alle_minuten: number | null; laeuft: boolean; grund?: string } => {
  const { takt, laeuft, grund } = wacheZustand(w);
  return { alle_minuten: takt ?? null, laeuft, ...(grund ? { grund } : {}) };
};
const naechsterLaufSicher = (z: Zeitplan, jetzt: Date): Date | undefined =>
  typeof z.zeit === "string" && typeof z.tage === "string" ? naechsterLauf(z, jetzt, config.zeitplanNachholenMin) : undefined;

export function statusJson(_req: Request, res: Response): void {
  // Im Notfall nur der Zustand: keine Rechnungen, Ziele, Werte, Auftrags- oder Vorgangstexte, Kameras.
  // Leere Listen statt fehlender Felder, damit das Dashboard weiter rendert und nur «NOTFALL» zeigt.
  if (notfallAktiv()) {
    return void res.json({
      ok: true,
      zeit: new Date().toISOString(),
      name: config.name,
      modus: state.mode ?? "normal",
      pausiert: Boolean(state.paused),
      notfall: true,
      offeneAuftraege: offeneAuftraege().length,
      auftraege: [],
      rechnungen: [],
      vorgaenge: [],
      zeitplaene: [],
      wachen: [],
      kameras: [],
      protokolle: [],
      ziele: [],
      werte: [],
      gesundheit: gesundheit.alle(),
    });
  }
  res.json({
    ok: true,
    zeit: new Date().toISOString(),
    name: config.name,
    modus: state.mode ?? "normal",
    pausiert: Boolean(state.paused),
    notfall: notfallAktiv(),
    auftraege: offeneAuftraege().map((a) => ({ id: a.id, tool: a.tool, stufe: a.stufe, summary: a.summary, seit: a.createdAt, gestartetAm: a.gestartetAm })),
    rechnungen: offeneRechnungen().slice(0, 10).map((r) => ({ id: r.id, empfaenger: r.empfaenger, betrag: r.betrag, waehrung: r.waehrung, faellig: r.faellig })),
    // Leere Liste heisst dann nicht «keine offenen Rechnungen»
    rechnungenUnlesbar: rechnungenNichtGeladen,
    auftraegeUnlesbar: auftraegeNichtGeladen,
    wachenUnlesbar: wachenNichtGeladen,
    camerasUnlesbar: camerasNichtGeladen,
    zeitplaeneUnlesbar: zeitplaeneNichtGeladen,
    vorgaengeUnlesbar: vorgaengeNichtGeladen,
    vorgaenge: vorgaenge.slice(-8).map((v) => ({ id: v.id, status: v.status, steps: v.steps, auftrag: v.auftrag.slice(0, 90) })),
    zeitplaene: zeitplaene.map((z) => ({ id: z.id, name: textAnzeige(z.name), zeit: zeitAnzeige(z.zeit), tage: tageAnzeige(z.tage) })),
    wachen: allWachen().map((w) => ({ kamera: textAnzeige(w.kamera), frage: frageAnzeige(w.frage).slice(0, 80), ...taktAnzeige(w) })),
    kameras: Object.entries(cameras).map(([k, c]) => ({ name: k, beschreibung: c?.beschreibung })),
    protokolle: Object.entries(protokolle).map(([k, p]) => ({ name: k, beschreibung: p.beschreibung, stufe: p.stufe })),
    ziele: profil.ziele.filter((z) => z.status === "offen").map((z) => ({ id: z.id, text: z.text, frist: z.frist })),
    werte: profil.werte,
    gesundheit: gesundheit.alle(),
  });
}

/** Für das Dashboard reicht das: keine IBAN, keine Referenz, keine Notiz. */
const kurzeRechnung = (r: Rechnung) => ({ id: r.id, empfaenger: r.empfaenger, betrag: r.betrag, waehrung: r.waehrung, faellig: r.faellig, bezahltAm: r.bezahltAm, status: r.status });

/** GET /api/finanzen: Wochenbericht als JSON. Nur lesen, keine Zahlung; im Notfall gesperrt wie alle Daten. */
export function finanzenJson(_req: Request, res: Response): void {
  if (notfallAktiv()) return void res.status(423).json({ ok: false, error: "notfall" });
  // Ohne geladenen Bestand wäre jede Zahl falsch (alles 0): Dienst nicht verfügbar statt leerer Bericht
  if (rechnungenNichtGeladen) return void res.status(503).json({ ok: false, error: "rechnungen_unlesbar", text: RECHNUNGEN_UNLESBAR });
  const u = finanzUebersicht();
  res.json({
    ok: true,
    ...u,
    ueberfaellig: u.ueberfaellig.map(kurzeRechnung),
    faelligBald: u.faelligBald.map(kurzeRechnung),
    bezahltLetzteWoche: u.bezahltLetzteWoche.map(kurzeRechnung),
  });
}

export async function auftragAction(req: Request, res: Response): Promise<void> {
  if (notfallAktiv()) return void res.status(423).json(NOTFALL_GESPERRT);
  const { id, aktion, pin } = (req.body ?? {}) as { id?: number; aktion?: string; pin?: unknown };
  if (aktion !== "ok" && aktion !== "nein") return void res.status(400).json({ ok: false, error: "aktion", text: "Aktion: ok oder nein, Sir." });
  const a = getAuftrag(Number(id));
  if (!a) return void res.status(404).json({ ok: false, error: "Auftrag nicht gefunden" });
  // Gesperrte PIN-Eingabe: abweisen, der Auftrag bleibt offen
  if (aktion === "ok" && a.stufe === "sensibel" && a.status === "offen" && pinSperreRest() > 0) {
    return void res.status(429).json({ ok: false, error: "pin_gesperrt", text: pinGesperrtText(), status: a.status });
  }
  const text = aktion === "ok" ? await approveAuftrag(a, typeof pin === "string" ? pin : undefined) : await denyAuftrag(a);
  if (aktion === "ok") audit("auftrag_freigabe", { id: a.id, tool: a.tool, status: a.status, quelle: "dashboard" });
  res.json({ ok: true, text, status: a.status });
}

export async function chat(req: Request, res: Response): Promise<void> {
  const text = String((req.body ?? {}).text ?? "").slice(0, 4000).trim();
  if (!text) return void res.status(400).json({ ok: false, error: "text fehlt" });
  // Der Chat-Weg bleibt rückwärtskompatibel; das UI nutzt POST /api/notfall.
  if (text === "/notfall") {
    await ausloesen("Über die Kommandozentrale ausgelöst.");
    return void res.json({ ok: true, reply: "🚨 Notfall ausgelöst." });
  }
  if (notfallAktiv()) return void res.status(423).json(NOTFALL_GESPERRT);
  audit("chat", { quelle: "dashboard", zeichen: text.length });
  const reply = await askWithBudget(`[Kommandozentrale] ${text}`, 60_000, hooks, async (r) => void (await sendText(`Zur Frage aus der Zentrale («${text.slice(0, 60)}»):\n\n${r}`)));
  res.json({ ok: true, reply: reply ?? "Das braucht länger, die Antwort kommt per Telegram.", queued: reply === undefined });
}

export async function kameraBild(req: Request, res: Response): Promise<void> {
  if (notfallAktiv()) return void res.status(423).json(NOTFALL_GESPERRT);
  const name = String(req.params.name);
  if (!cameras[name]) return void res.status(404).end();
  try {
    const img = await snapshot(name, 480);
    // Kam der Notfall während des Abrufs (Frigate, mit Wiederholungen Sekunden), bleibt das Bild hier
    if (notfallAktiv()) return void res.status(423).json(NOTFALL_GESPERRT);
    res.set("Content-Type", "image/jpeg").set("Cache-Control", "no-store").send(img);
  } catch (e) {
    // Fehlertexte von fetch enthalten die URL samt Zugangsdaten (FRIGATE_URL mit user:pw@)
    res.status(502).json({ ok: false, error: schwaerze(e instanceof Error ? e.message : String(e)) });
  }
}

export interface AuditEintrag { zeit: string; ereignis: string; info: string }

/** Eine Audit-Zeile lesbar: Zeit, Ereignis, übrige Felder kurz (geschwärzt, max. 160 Zeichen). Kaputt → undefined. */
export function auditEintrag(zeile: string): AuditEintrag | undefined {
  let roh: unknown;
  try {
    roh = JSON.parse(zeile);
  } catch {
    return undefined;
  }
  if (!roh || typeof roh !== "object" || Array.isArray(roh)) return undefined;
  const { ts, event, ...rest } = roh as Record<string, unknown>;
  if (typeof ts !== "string" || typeof event !== "string") return undefined;
  const info = Object.entries(rest)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
  return { zeit: ts, ereignis: event, info: schwaerze(info).slice(0, 160) };
}

/** Nur die geschwärzten Einträge, keine Rohzeilen: die Oberfläche braucht sie nicht, und ungeschwärzt gehört nichts in den Browser. */
export function auditTail(_req: Request, res: Response): void {
  if (notfallAktiv()) return void res.status(423).json({ ...NOTFALL_GESPERRT, eintraege: [] });
  try {
    const zeilen = readFileSync("data/audit.log", "utf8").trim().split("\n").filter(Boolean).slice(-60).reverse();
    const eintraege = zeilen.map(auditEintrag).filter((e): e is AuditEintrag => e !== undefined);
    res.json({ ok: true, eintraege });
  } catch {
    res.json({ ok: true, eintraege: [] });
  }
}

export async function protokollAction(req: Request, res: Response): Promise<void> {
  const name = String((req.body ?? {}).name ?? "");
  const p = protokolle[name];
  if (!p) return void res.status(404).json({ ok: false, error: "nicht_gefunden", text: "Dieses Protokoll gibt es nicht, Sir." });
  // Text im Feld `text` (wie überall): das Dashboard zeigt ihn an. Ohne ihn meldete es bei 423 fest einen Notfall,
  // auch wenn nur der Notaus aktiv ist (dann gilt «Weiter mit PIN» bzw. /weiter, nicht /entwarnung).
  const gesperrt = protokollGesperrt();
  if (gesperrt) return void res.status(423).json({ ok: false, error: notfallAktiv() ? "notfall" : "pausiert", text: gesperrt });
  if (p.stufe === "auto") {
    const out = await runProtokoll(name, hooks);
    audit("protokoll", { name, quelle: "dashboard" });
    // Wie beim Kamerabild und den Geräten: kam der Notfall während des Laufs, bleiben die Ergebniszeilen
    // (erste Ausgabezeilen der Werkzeuge, z. B. Zustände aus Home Assistant) hier
    if (notfallAktiv()) return void res.status(423).json(NOTFALL_GESPERRT);
    return void res.json({ ok: true, text: out });
  }
  // Neue Aufträge erst nach Reparatur und Neustart: Grund statt allgemeinem 500
  if (auftraegeNichtGeladen) return void res.status(503).json({ ok: false, error: "auftraege_unlesbar", text: AUFTRAEGE_UNLESBAR });
  let a: Auftrag;
  try {
    a = createAuftrag({ tool: "protokoll_ausfuehren", input: protokollFesthalten(name), stufe: p.stufe, summary: `Protokoll «${name}»: ${p.beschreibung}` });
  } catch (e) {
    // Etwa die Speicherkarte voll: createAuftrag hat nichts angelegt; der Grund geschwärzt ins Dashboard
    console.error("Protokoll-Auftrag nicht angelegt:", schwaerze(e instanceof Error ? e.message : String(e)));
    return void res.status(500).json({ ok: false, error: "nicht_angelegt", text: `Protokoll «${name}» nicht angelegt, Sir: ${schwaerze(e instanceof Error ? e.message : String(e))}` });
  }
  audit("auftrag_angelegt", { id: a.id, tool: a.tool, stufe: a.stufe, name, quelle: "dashboard" });
  await hooks.onAuftrag(a).catch(() => undefined);
  res.json({ ok: true, text: `Auftrag #${a.id} angelegt (${p.stufe}), Freigabe unten in den Aufträgen.` });
}

export async function geraete(req: Request, res: Response): Promise<void> {
  if (notfallAktiv()) return void res.status(423).json(NOTFALL_GESPERRT);
  if (!config.homeAssistant) return void res.json({ ok: true, text: "Home Assistant nicht eingerichtet." });
  try {
    const text = await haStates(req.query.filter ? String(req.query.filter) : undefined);
    // Wie beim Kamerabild: ein während des Abrufs ausgelöster Notfall sperrt auch diese Antwort
    if (notfallAktiv()) return void res.status(423).json(NOTFALL_GESPERRT);
    res.json({ ok: true, text });
  } catch (e) {
    if (notfallAktiv()) return void res.status(423).json(NOTFALL_GESPERRT);
    res.json({ ok: false, text: schwaerze(e instanceof Error ? e.message : String(e)) });
  }
}

export function modus(req: Request, res: Response): void {
  if (notfallAktiv()) return void res.status(423).json(NOTFALL_GESPERRT);
  const m = String((req.body ?? {}).modus ?? "");
  if (!["normal", "fokus", "nacht"].includes(m)) return void res.status(400).json({ ok: false });
  state.mode = m as Mode;
  save();
  audit("modus", { modus: m, quelle: "dashboard" });
  res.json({ ok: true, modus: m });
}

// ---------- Freigabe-Historie und Kosten ----------

const STATUS: readonly Status[] = ["offen", "erledigt", "abgelehnt", "fehler"];

/** Zahl aus dem Query-Parameter, auf [min, max] begrenzt; fehlt oder ungültig → Standard. */
function grenze(v: unknown, min: number, max: number, standard: number): number {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : standard;
}

/**
 * GET /api/auftraege?status=&stufe=&limit= – Freigabe-Historie, neueste zuerst. Nie `input` (Mailtexte, Pfade, Inhalte);
 * `result` geschwärzt und auf 300 Zeichen gekürzt.
 */
export function auftraegeJson(req: Request, res: Response): void {
  if (notfallAktiv()) return void res.status(423).json(NOTFALL_GESPERRT);
  const status = String(req.query.status ?? "alle");
  if (status !== "alle" && !STATUS.includes(status as Status)) {
    return void res.status(400).json({ ok: false, error: "status", text: "Status: offen, erledigt, abgelehnt, fehler oder alle, Sir." });
  }
  const stufe = String(req.query.stufe ?? "alle");
  if (!["alle", "extern", "sensibel"].includes(stufe)) return void res.status(400).json({ ok: false, error: "stufe", text: "Stufe: extern, sensibel oder alle, Sir." });
  const limit = grenze(req.query.limit, 1, 200, 100);
  const treffer = auftraege
    .filter((a) => (status === "alle" || a.status === status) && (stufe === "alle" || a.stufe === stufe))
    .sort((x, y) => y.id - x.id);
  res.json({
    ok: true,
    // Leere Liste heisst dann nicht «keine Aufträge»: der Bestand liegt in der unlesbaren Datei
    ...(auftraegeNichtGeladen ? { unlesbar: true, text: AUFTRAEGE_UNLESBAR } : {}),
    gesamt: treffer.length,
    auftraege: treffer.slice(0, limit).map((a) => ({
      id: a.id,
      createdAt: a.createdAt,
      tool: a.tool,
      stufe: a.stufe,
      summary: schwaerze(a.summary),
      status: a.status,
      ...(a.gestartetAm ? { gestartetAm: a.gestartetAm } : {}),
      ...(a.result !== undefined ? { result: schwaerze(a.result).slice(0, 300) } : {}),
    })),
  });
}

/** GET /api/kosten?tage=1..90 (Standard 30): Verlauf lückenlos, Schweizer Datum; Schätzung nach den Preisen in .env. */
export function kostenJson(req: Request, res: Response): void {
  if (notfallAktiv()) return void res.status(423).json(NOTFALL_GESPERRT);
  res.json({ ok: true, ...verbrauchVerlauf(grenze(req.query.tage, 1, 90, 30)) });
}

// ---------- Zeitpläne und Wachen bearbeiten ----------
//
// Leitplanke 1: Das Dashboard ist der Nutzer selbst (Heimnetz/Tailscale + Token); sein Klick ersetzt das Tippen auf
// «Freigeben». Ein Zeitplan löst später nur einen Agentenlauf aus – Werkzeuge mit Nebenwirkung brauchen dabei weiterhin
// ihre eigene Freigabe. Eine Wache schickt Standbilder an die Claude-API (Leitplanke 9): Hinweis in Antwort und UI.

const WACHEN_HINWEIS = "Wachen schicken regelmässig Standbilder an die Claude-API (Haiku), Sir. Nur einrichten, wo Sie das wollen.";

/** Stellt ein Objekt auf eine flache Kopie zurück (auch Felder, die erst danach dazukamen, verschwinden). */
function zuruecksetzen<T extends object>(ziel: T, alt: T): void {
  for (const k of Object.keys(ziel)) if (!(k in alt)) delete (ziel as Record<string, unknown>)[k];
  Object.assign(ziel, alt);
}

/** ID aus dem Pfad; nur Ziffern, sonst undefined. */
const pfadId = (req: Request): number | undefined => (/^\d{1,9}$/.test(String(req.params.id ?? "")) ? Number(req.params.id) : undefined);

/**
 * Läuft ein Zeitplan nicht (von Hand bearbeitet: Uhrzeit «25:00», Tage «montags», leerer Auftrag), nennt die Anzeige den
 * Grund nach derselben Regel wie der Scheduler (zeitplanZustand in zeitplaene.ts): laeuft false und grund.
 */
const zeitplanJson = (z: Zeitplan, jetzt: Date) => {
  const n = naechsterLaufSicher(z, jetzt);
  const { grund } = zeitplanZustand(z);
  return { id: z.id, name: textAnzeige(z.name), zeit: zeitAnzeige(z.zeit), tage: tageAnzeige(z.tage), auftrag: textAnzeige(z.auftrag), ...(z.lastRun ? { lastRun: z.lastRun } : {}), ...(z.angelegt ? { angelegt: z.angelegt } : {}), ...(n ? { naechsterLauf: n.toISOString() } : {}), ...(grund ? { laeuft: false, grund } : {}) };
};

const zeitplanAudit = (z: Zeitplan) => ({ id: z.id, name: kurz(z.name, 60), zeit: z.zeit, tage: z.tage, auftrag: kurz(z.auftrag), quelle: "dashboard" });

/** Nur für Tests: Uhr für Zeitpläne (Anlegen, Ändern, nächster Lauf). */
export const _dashboardUhr = { jetzt: () => new Date() };

export function zeitplaeneJson(_req: Request, res: Response): void {
  if (notfallAktiv()) return void res.status(423).json(NOTFALL_GESPERRT);
  const jetzt = _dashboardUhr.jetzt();
  res.json({ ok: true, unlesbar: zeitplaeneNichtGeladen, ...(zeitplaeneNichtGeladen ? { text: ZEITPLAENE_UNLESBAR } : {}), zeitplaene: zeitplaene.map((z) => zeitplanJson(z, jetzt)) });
}

/** Gemeinsame Vorprüfung der Schreibrouten; true = Antwort ist schon gesendet. */
function zeitplanGesperrt(res: Response): boolean {
  if (notfallAktiv()) res.status(423).json(NOTFALL_GESPERRT);
  else if (zeitplaeneNichtGeladen) res.status(503).json({ ok: false, error: "zeitplaene_unlesbar", text: ZEITPLAENE_UNLESBAR });
  else return false;
  return true;
}

export function zeitplanAnlegen(req: Request, res: Response): void {
  if (zeitplanGesperrt(res)) return;
  const p = pruefeZeitplan(req.body);
  if (!p.ok) return void res.status(400).json({ ok: false, error: "pruefung", fehler: p.fehler });
  const jetzt = _dashboardUhr.jetzt();
  const z: Zeitplan = { id: neueZeitplanId(), ...p.wert, angelegt: jetzt.toISOString() };
  zeitplaene.push(z);
  try {
    saveZeitplaene(jetzt);
  } catch (e) {
    // Nicht gespeichert heisst nicht angelegt: sonst liefe der Plan bis zum Neustart, und ein zweiter Versuch legte ihn doppelt an.
    zeitplaene.splice(zeitplaene.indexOf(z), 1);
    throw e;
  }
  audit("zeitplan_angelegt", zeitplanAudit(z));
  res.status(201).json({ ok: true, text: `Zeitplan #${z.id} «${z.name}» eingerichtet, Sir.`, zeitplan: zeitplanJson(z, jetzt) });
}

export function zeitplanAendern(req: Request, res: Response): void {
  if (zeitplanGesperrt(res)) return;
  const id = pfadId(req);
  const z = id === undefined ? undefined : zeitplaene.find((x) => x.id === id);
  if (!z) return void res.status(404).json({ ok: false, error: "nicht_gefunden", text: "Diesen Zeitplan gibt es nicht, Sir." });
  const p = pruefeZeitplan(req.body);
  if (!p.ok) return void res.status(400).json({ ok: false, error: "pruefung", fehler: p.fehler });
  const jetzt = _dashboardUhr.jetzt();
  // Gespeicherte Tage normalisiert vergleichen: «So, sa» und «sa,so» sind derselbe Termin
  const termin = p.wert.zeit !== z.zeit || p.wert.tage !== tageAnzeige(z.tage);
  const alt = { ...z };
  Object.assign(z, p.wert);
  // Wie beim Anlegen: eine heute schon vergangene neue Uhrzeit wird nicht sofort nachgeholt (faelligIm: heute zu spät
  // angelegt). lastRun bleibt, damit ein heute schon gelaufener Plan nicht ein zweites Mal läuft.
  if (termin) z.angelegt = jetzt.toISOString();
  try {
    saveZeitplaene(jetzt);
  } catch (e) {
    zuruecksetzen(z, alt);
    throw e;
  }
  audit("zeitplan_geaendert", zeitplanAudit(z));
  res.json({ ok: true, text: `Zeitplan #${z.id} geändert, Sir.`, zeitplan: zeitplanJson(z, jetzt) });
}

export function zeitplanLoeschen(req: Request, res: Response): void {
  if (zeitplanGesperrt(res)) return;
  const id = pfadId(req);
  const i = id === undefined ? -1 : zeitplaene.findIndex((x) => x.id === id);
  if (i < 0) return void res.status(404).json({ ok: false, error: "nicht_gefunden", text: "Diesen Zeitplan gibt es nicht, Sir." });
  const [z] = zeitplaene.splice(i, 1);
  try {
    saveZeitplaene(_dashboardUhr.jetzt());
  } catch (e) {
    // Sonst wäre er bis zum Neustart weg und danach wieder da
    zeitplaene.splice(i, 0, z!);
    throw e;
  }
  audit("zeitplan_geloescht", zeitplanAudit(z!));
  res.json({ ok: true, text: `Zeitplan #${z!.id} gelöscht, Sir.` });
}

// ruhe_minuten: immer der wirksame Wert wie im Takt (ruheMinuten), also auch der Standard 30 statt eines fehlenden Felds.
// nur_wenn: die wirksame Bedingung (bedingungWert); ungültig (null, «Nacht» …) → null, laeuft false, grund «Bedingung ungültig»
const wacheJson = (w: Wache) =>
  w.id === undefined
    ? { kamera: textAnzeige(w.kamera), frage: frageAnzeige(w.frage), ...taktAnzeige(w), nur_wenn: bedingungWert(w.nur_wenn) ?? null, ruhe_minuten: ruheMinuten(w.ruhe_minuten), quelle: "cameras.json", bearbeitbar: false }
    : { id: w.id, kamera: textAnzeige(w.kamera), frage: frageAnzeige(w.frage), ...taktAnzeige(w), nur_wenn: bedingungWert(w.nur_wenn) ?? null, ruhe_minuten: ruheMinuten(w.ruhe_minuten), quelle: w.quelle ?? "chat", bearbeitbar: true };

const wacheAudit = (w: Wache) => ({ id: w.id, kamera: kurz(w.kamera, 60), alle_minuten: w.alle_minuten, nur_wenn: bedingungWert(w.nur_wenn) ?? null, frage: kurz(w.frage), quelle: "dashboard" });

export function wachenJson(_req: Request, res: Response): void {
  if (notfallAktiv()) return void res.status(423).json(NOTFALL_GESPERRT);
  res.json({
    ok: true,
    hinweis: WACHEN_HINWEIS,
    unlesbar: wachenNichtGeladen,
    ...(wachenNichtGeladen ? { text: WACHEN_UNLESBAR } : {}),
    kameras: Object.keys(cameras),
    wachen: allWachen().map(wacheJson),
  });
}

function wacheGesperrt(res: Response): boolean {
  if (notfallAktiv()) res.status(423).json(NOTFALL_GESPERRT);
  else if (wachenNichtGeladen) res.status(503).json({ ok: false, error: "wachen_unlesbar", text: WACHEN_UNLESBAR });
  else return false;
  return true;
}

const WACHE_NICHT_GEFUNDEN = { ok: false, error: "nicht_gefunden", text: "Diese Wache gibt es hier nicht, Sir. Wachen aus cameras.json ändern Sie in der Datei." } as const;

export function wacheAnlegen(req: Request, res: Response): void {
  if (wacheGesperrt(res)) return;
  const p = pruefeWache(req.body);
  if (!p.ok) return void res.status(400).json({ ok: false, error: "pruefung", fehler: p.fehler });
  const w: Wache = { id: neueWacheId(), ...p.wert, quelle: "dashboard" };
  dynamicWachen.push(w);
  try {
    saveWachen();
  } catch (e) {
    dynamicWachen.splice(dynamicWachen.indexOf(w), 1);
    throw e;
  }
  audit("wache_angelegt", wacheAudit(w));
  res.status(201).json({ ok: true, text: `Wache #${w.id} auf «${w.kamera}» eingerichtet, Sir.`, hinweis: WACHEN_HINWEIS, wache: wacheJson(w) });
}

export function wacheAendern(req: Request, res: Response): void {
  if (wacheGesperrt(res)) return;
  const id = pfadId(req);
  const w = id === undefined ? undefined : dynamicWachen.find((x) => x.id === id);
  if (!w) return void res.status(404).json(WACHE_NICHT_GEFUNDEN);
  const p = pruefeWache(req.body);
  if (!p.ok) return void res.status(400).json({ ok: false, error: "pruefung", fehler: p.fehler });
  const alt = { ...w };
  delete w.ruhe_minuten; // nicht mitgegeben = Standard
  Object.assign(w, p.wert);
  try {
    saveWachen();
  } catch (e) {
    zuruecksetzen(w, alt);
    throw e;
  }
  audit("wache_geaendert", wacheAudit(w));
  res.json({ ok: true, text: `Wache #${w.id} geändert, Sir.`, hinweis: WACHEN_HINWEIS, wache: wacheJson(w) });
}

export function wacheLoeschen(req: Request, res: Response): void {
  if (wacheGesperrt(res)) return;
  const id = pfadId(req);
  const i = id === undefined ? -1 : dynamicWachen.findIndex((x) => x.id === id);
  if (i < 0) return void res.status(404).json(WACHE_NICHT_GEFUNDEN);
  const [w] = dynamicWachen.splice(i, 1);
  try {
    saveWachen();
  } catch (e) {
    dynamicWachen.splice(i, 0, w!);
    throw e;
  }
  audit("wache_geloescht", wacheAudit(w!));
  res.json({ ok: true, text: `Wache #${w!.id} gelöscht, Sir.` });
}

// ---------- Notaus und Notfall ----------

/**
 * POST /api/notaus {an:true} → wie /pause (ohne PIN, auch im Notfall). {an:false, pin} → wie /weiter, nur mit gültiger
 * PIN und unter der Dashboard-Sperre; im Notfall nie (Entwarnung nur in Telegram, mit Checkliste).
 */
export function notaus(req: Request, res: Response): void {
  const { an, pin } = (req.body ?? {}) as { an?: unknown; pin?: unknown };
  if (typeof an !== "boolean") return void res.status(400).json({ ok: false, error: "an", text: "an: true oder false, Sir." });
  if (an) {
    notausAn("dashboard");
    return void res.json({ ok: true, pausiert: true, text: "⛔ Notaus aktiv, Sir. Keine Werkzeuge, Zeitpläne oder Wachen, bis Sie ihn aufheben." });
  }
  if (notfallAktiv()) return void res.status(423).json({ ok: false, error: "notfall", text: "Erst /entwarnung in Telegram, Sir." });
  if (!state.paused) return void res.json({ ok: true, pausiert: false, text: "Es ist kein Notaus aktiv, Sir." });
  if (!config.pin) return void res.status(409).json({ ok: false, error: "ohne_pin", text: "Ohne JARVIS_PIN hebe ich den Notaus nur in Telegram auf, Sir." });
  if (typeof pin !== "string" || pin === "") return void res.status(400).json({ ok: false, error: "pin", text: "Die PIN fehlt, Sir." });
  const ergebnis = pinPruefen(pin, "notaus_aufheben");
  if (ergebnis === "gesperrt") return void res.status(429).json({ ok: false, error: "pin_gesperrt", text: pinGesperrtText() });
  if (ergebnis !== "ok") return void res.status(403).json({ ok: false, error: "pin_falsch", text: "Falsche PIN, Sir. Der Notaus bleibt." });
  if (!notausAus("dashboard")) return void res.status(423).json({ ok: false, error: "notfall", text: "Erst /entwarnung in Telegram, Sir." });
  res.json({ ok: true, pausiert: false, text: "▶️ Weiter, Sir." });
}

/** POST /api/notfall {bestaetigt:true}: Notfall auslösen. Läuft er schon, kein zweiter Alarm. */
export async function notfallAusloesen(req: Request, res: Response): Promise<void> {
  if ((req.body ?? {}).bestaetigt !== true) return void res.status(400).json({ ok: false, error: "bestaetigt", text: "Bitte ausdrücklich bestätigen, Sir." });
  if (notfallAktiv()) return void res.json({ ok: true, schon: true, text: "🚨 Der Notfall läuft bereits, Sir." });
  audit("notfall_ausgeloest", { quelle: "dashboard" });
  // Nicht auf den Alarmversand warten (bei Telegram-Störung bis ~90 s); ausloesen setzt den Zustand vor dem ersten await.
  const alarm = ausloesen("Über die Kommandozentrale ausgelöst.");
  res.json({ ok: true, text: "🚨 Notfall ausgelöst. Die Checkliste kommt per Telegram, Sir." });
  await alarm;
}
