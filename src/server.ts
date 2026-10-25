import express from "express";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExpressAdapter } from "ask-sdk-express-adapter";
import { config, opt } from "./config.js";
import { buildSkill } from "./alexa.js";
import { morningTick } from "./brain.js";
import { dateiHinweiseMelden, startTelegram } from "./telegram.js";
import { startScheduler } from "./scheduler.js";
import { closeBrowser } from "./browser.js";
import { handleEvent } from "./events.js";
import { startWatch } from "./watch.js";
import { handlePanic } from "./notfall.js";
import {
  auditTail, auftraegeJson, auftragAction, chat, chatVerlauf, DASHBOARD_CSP, dashboardAuth, finanzenJson, geraete, kameraBild, kostenJson, modus, notaus, notfallAusloesen, notfallSperre,
  protokollAction, statusJson, wacheAendern, wacheAnlegen, wacheLoeschen, wachenJson, zeitplaeneJson, zeitplanAendern, zeitplanAnlegen, zeitplanLoeschen,
} from "./dashboard.js";
import { gesundheit, schwaerze } from "./robust.js";
import { type Erwartet, GESTEN_CSP, MEDIAPIPE_DATEIEN, mediapipeOrdner, modellGeprueft, type ModellZustand, modellPfad } from "./gesten.js";
import { vorgaengeNachNeustart } from "./vorgaenge.js";

const app = express();
app.disable("x-powered-by");

/** Heimnetz, Tailscale oder localhost. cloudflared verbindet von 127.0.0.1, deshalb zählen zusätzlich die Tunnel-Header. */
const PRIVATE = /^(::1|::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)|^::1$|^fe80:|^fc|^fd/i;
/** Feste Dateien der Gesten-Konsole (Whitelist, kein express.static); alle ohne Daten. */
const GESTEN_WEB: Record<string, { datei: string; typ: string }> = {
  "/gesture/app.js": { datei: "gesture.js", typ: "text/javascript; charset=utf-8" },
  "/gesture/app.css": { datei: "gesture.css", typ: "text/css; charset=utf-8" },
};
const GESTEN_MODELL = "/gesture/mp/hand_landmarker.task";
/** Zustand des Handmodells als JSON: die Konsole fragt zuerst hier und holt das Modell nur, wenn es da ist (kein 404 in der Konsole) */
const GESTEN_MODELL_ZUSTAND = "/gesture/mp/modell.json";
/**
 * Nur diese Pfade öffnet EVENTS_VIA_TUNNEL=on (die Konsole ist eine Seite ohne Daten, /events verlangt das Token).
 * Die Dateien der Konsole folgen genau ihrer Regel, jeder andere Unterpfad von /gesture bleibt über den Tunnel 404.
 */
const TUNNEL_SCHALTBAR = new Set(["/events", "/gesture", ...Object.keys(GESTEN_WEB), ...Object.keys(MEDIAPIPE_DATEIEN), GESTEN_MODELL, GESTEN_MODELL_ZUSTAND]);
/** Tunnel → 404. Dashboard, /status.json und /api/* bleiben auch mit EVENTS_VIA_TUNNEL=on gesperrt (Leitplanke 6). */
const lanOnly = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const viaTunnel = Boolean(req.headers["cf-connecting-ip"] || req.headers["cf-ray"]);
  // Voller Pfad: unter app.use kürzt Express req.path (aus /gesture wird «/», aus /api/events «/events»)
  const pfad = (req.baseUrl + req.path).replace(/\/+$/, "") || "/";
  const tunnelErlaubt = config.eventsViaTunnel && TUNNEL_SCHALTBAR.has(pfad);
  const ip = req.socket.remoteAddress ?? "";
  if ((viaTunnel && !tunnelErlaubt) || !PRIVATE.test(ip)) return void res.status(404).end();
  next();
};

/** Handler absichern (synchron oder async): ein Fehler wird geschwärzt geloggt und mit 500 beantwortet statt als unbehandelte Rejection. */
const sicher =
  (h: (req: express.Request, res: express.Response) => unknown) =>
  (req: express.Request, res: express.Response): void =>
    // new Promise ruft h sofort (synchron) auf und fängt auch einen synchronen Wurf
    void new Promise((ok) => ok(h(req, res))).catch((e: unknown) => {
      console.error(e instanceof Error ? schwaerze(e.message) : e);
      if (!res.headersSent) res.status(500).json({ ok: false });
    });

app.get("/health", (_req, res) => {
  res.send("ok");
});

// Prüft bei jeder Anfrage Amazons Signatur und den Zeitstempel; fremde Skill-IDs weist buildSkill ab.
// Alexa ist optional: ohne Skill-ID bleibt /alexa aus, der Rest des Dienstes läuft.
const skillId = opt("ALEXA_SKILL_ID");
if (skillId) app.post("/alexa", new ExpressAdapter(buildSkill(skillId), true, true).getRequestHandlers());
else console.log("Alexa nicht konfiguriert (ALEXA_SKILL_ID), /alexa aus.");

// Ereignisse aus dem Haus (Home Assistant) und aus der Gesten-Konsole, nur mit Token
if (config.eventToken) {
  const cors = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" });
    next();
  };
  // Token vor dem Body-Parser: Unbefugte erreichen den Parser nie. Abweisen (Audit, abuseSignal, 401) bleibt Sache von handleEvent.
  const tokenZuerst = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = config.eventToken ?? "";
    const given = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (token && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token))) return next();
    sicher(handleEvent)(req, res);
  };
  app.options("/events", lanOnly, cors, (_req, res) => void res.sendStatus(204));
  app.post("/events", lanOnly, cors, tokenZuerst, express.json({ limit: "64kb" }), sicher(handleEvent));
}

// Panik-Auslöser fürs Handy (eigener Token), auch über den Tunnel erreichbar – im Notfall zählt Erreichbarkeit.
// Ohne Body-Parser: handlePanic braucht keinen Body, und ein Parser vor der Token-Prüfung wäre Angriffsfläche aus dem Internet.
if (config.panicToken) app.post("/notfall", sicher(handlePanic));

// Gesten- und Sprachkonsole (Webcam-Handtracking im Browser). lanOnly auch vor dem Router: sonst beantwortet er
// OPTIONS (200 + Allow) selbst, und die Konsole wäre über den Tunnel aufzählbar (Leitplanke 6).
// Alles kommt vom eigenen Server (MediaPipe aus node_modules, Modell aus vendor/), unter strenger CSP: kein fremder Code im
// Ursprung, der den Token aus localStorage lesen könnte.
app.use("/gesture", lanOnly);
const gestenKopf = (res: express.Response, typ: string) => {
  res.setHeader("Content-Security-Policy", GESTEN_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Type", typ);
};
/** Absoluter Pfad oder undefined → 404 (fehlende Datei, Paket nicht installiert) */
const gestenDatei = (typ: string, pfad: () => string | undefined) => (_req: express.Request, res: express.Response) => {
  const p = pfad();
  if (!p || !existsSync(p)) return void res.status(404).end();
  gestenKopf(res, typ);
  // Pfade nur aus der Whitelist: auch ein Projektordner unter einem Punkt-Ordner (~/.local/…) liefert aus
  res.sendFile(p, { dotfiles: "allow" });
};
const web = (datei: string) => fileURLToPath(new URL(`../web/${datei}`, import.meta.url));
app.get("/gesture", lanOnly, gestenDatei("text/html; charset=utf-8", () => web("gesture.html")));
for (const [pfad, { datei, typ }] of Object.entries(GESTEN_WEB)) app.get(pfad, lanOnly, gestenDatei(typ, () => web(datei)));
const mp = mediapipeOrdner();
if (!mp) console.error("Gesten-Konsole: Paket @mediapipe/tasks-vision fehlt (npm ci), Handtracking aus.");
for (const [pfad, { datei, typ }] of Object.entries(MEDIAPIPE_DATEIEN)) app.get(pfad, lanOnly, gestenDatei(typ, () => (mp ? join(mp, datei) : undefined)));

/**
 * Handmodell geprüft (Grösse und SHA-256), zwischengespeichert nach Datei-Kennung (gesten.ts).
 * Erwartete Werte nur in Tests anders (Symbol im Prozess, per --import gesetzt; nie über Netz oder .env).
 */
const modellStand = (): ModellZustand =>
  modellGeprueft(undefined, (globalThis as Record<symbol, unknown>)[Symbol.for("jarvis.test.modellErwartet")] as Erwartet | undefined, (z) => {
    // Einmal je Dateistand melden, nicht bei jedem Seitenaufruf
    if (z.zustand === "falsch") console.error("Handmodell defekt: löschen, dann npm run gesten:modell");
  });
app.get(GESTEN_MODELL_ZUSTAND, lanOnly, sicher((_req, res) => {
  const { zustand } = modellStand();
  gestenKopf(res, "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify({ vorhanden: zustand !== "fehlt", zustand }));
}));
// Fehlt das Modell (npm run gesten:modell), 404; stimmt es nicht, 409 ohne Inhalt: die Seite zeigt dann einen Hinweis statt einer Engine-Meldung
app.get(GESTEN_MODELL, lanOnly, sicher((req, res) => {
  const { zustand } = modellStand();
  if (zustand === "falsch") {
    gestenKopf(res, "application/octet-stream");
    return void res.status(409).end();
  }
  if (zustand === "fehlt") return void res.status(404).end();
  gestenDatei("application/octet-stream", () => modellPfad())(req, res);
}));

// Kommandozentrale: der Kern. Seite und API nur aus dem Heimnetz/Tailscale (nie über den Tunnel), API zusätzlich mit Token.
if (config.dashboard && config.eventToken) {
  const json = express.json({ limit: "64kb" });
  // lanOnly einmal vor allen Routen der Kommandozentrale: sonst beantwortet der Router OPTIONS (200 + Allow) selbst,
  // ohne lanOnly – über den Tunnel wären Seite und API aufzählbar (Leitplanke 6). Die lanOnly je Route bleiben als zweite Schicht.
  app.use(["/dashboard", "/status.json", "/api"], lanOnly);
  // Nur diese drei festen Dateien (kein express.static auf web/): sie enthalten keine Daten, deshalb ohne Token.
  const statisch = (datei: string, typ: string) => (_req: express.Request, res: express.Response) => {
    res.setHeader("Content-Security-Policy", DASHBOARD_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Type", typ);
    res.sendFile(fileURLToPath(new URL(`../web/${datei}`, import.meta.url)));
  };
  app.get("/dashboard", lanOnly, statisch("dashboard.html", "text/html; charset=utf-8"));
  app.get("/dashboard/app.css", lanOnly, statisch("dashboard.css", "text/css; charset=utf-8"));
  app.get("/dashboard/app.js", lanOnly, statisch("dashboard.js", "text/javascript; charset=utf-8"));

  // API: nie zwischenspeichern; Antworten sind JSON (bzw. das Kamerabild) und nie als Seite deutbar
  const apiKopf = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  };
  // Reihenfolge je Route: Netz, Kopfzeilen, Token, Notfall-Sperre (423), erst dann der Body-Parser
  app.get("/status.json", lanOnly, apiKopf, dashboardAuth, sicher(statusJson));
  app.post("/api/auftrag", lanOnly, apiKopf, dashboardAuth, notfallSperre, json, sicher(auftragAction));
  app.post("/api/chat", lanOnly, apiKopf, dashboardAuth, notfallSperre, json, sicher(chat));
  app.get("/api/chat/verlauf", lanOnly, apiKopf, dashboardAuth, notfallSperre, sicher(chatVerlauf));
  app.post("/api/protokoll", lanOnly, apiKopf, dashboardAuth, notfallSperre, json, sicher(protokollAction));
  app.post("/api/modus", lanOnly, apiKopf, dashboardAuth, notfallSperre, json, sicher(modus));
  app.get("/api/kamera/:name", lanOnly, apiKopf, dashboardAuth, notfallSperre, sicher(kameraBild));
  app.get("/api/geraete", lanOnly, apiKopf, dashboardAuth, notfallSperre, sicher(geraete));
  app.get("/api/audit", lanOnly, apiKopf, dashboardAuth, notfallSperre, sicher(auditTail));
  app.get("/api/finanzen", lanOnly, apiKopf, dashboardAuth, notfallSperre, sicher(finanzenJson));
  app.get("/api/auftraege", lanOnly, apiKopf, dashboardAuth, notfallSperre, sicher(auftraegeJson));
  app.get("/api/kosten", lanOnly, apiKopf, dashboardAuth, notfallSperre, sicher(kostenJson));
  app.get("/api/zeitplaene", lanOnly, apiKopf, dashboardAuth, notfallSperre, sicher(zeitplaeneJson));
  app.post("/api/zeitplaene", lanOnly, apiKopf, dashboardAuth, notfallSperre, json, sicher(zeitplanAnlegen));
  app.put("/api/zeitplaene/:id", lanOnly, apiKopf, dashboardAuth, notfallSperre, json, sicher(zeitplanAendern));
  app.delete("/api/zeitplaene/:id", lanOnly, apiKopf, dashboardAuth, notfallSperre, sicher(zeitplanLoeschen));
  app.get("/api/wachen", lanOnly, apiKopf, dashboardAuth, notfallSperre, sicher(wachenJson));
  app.post("/api/wachen", lanOnly, apiKopf, dashboardAuth, notfallSperre, json, sicher(wacheAnlegen));
  app.put("/api/wachen/:id", lanOnly, apiKopf, dashboardAuth, notfallSperre, json, sicher(wacheAendern));
  app.delete("/api/wachen/:id", lanOnly, apiKopf, dashboardAuth, notfallSperre, sicher(wacheLoeschen));
  // Auch im Notfall erreichbar: Pause bleibt möglich, ein zweiter Auslöser ist harmlos
  app.post("/api/notaus", lanOnly, apiKopf, dashboardAuth, json, sicher(notaus));
  app.post("/api/notfall", lanOnly, apiKopf, dashboardAuth, json, sicher(notfallAusloesen));
}

// Eigener Fehlerhandler (zuletzt registriert): nie Stacktrace oder Pfade an den Aufrufer, auch ohne NODE_ENV=production.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const e = (err ?? {}) as { message?: unknown; status?: unknown; statusCode?: unknown };
  console.error("HTTP-Fehler:", schwaerze(String(e.message ?? err)));
  const code = Number(e.status ?? e.statusCode);
  if (res.headersSent) return void res.end();
  res.status(Number.isInteger(code) && code >= 400 && code < 600 ? code : 500).json({ ok: false });
});

// Hintergrundläufe erst, wenn der Port steht: bei belegtem Port sonst Telegram-Poll, MQTT und Wetter bei jedem
// Neustart-Versuch von systemd angestossen, kurz bevor exit(1) greift.
function hintergrundStarten(): void {
  startTelegram();
  // Vorgänge, die ein Neustart oder Absturz unterbrochen hat: auf «fehler», Systemnotiz, Meldung (ohne Telegram nur Status und Notiz)
  void vorgaengeNachNeustart().catch((e: unknown) => console.error("Vorgänge nach Neustart:", e instanceof Error ? schwaerze(e.message) : e));
  // Unlesbare Dateien (Zustand, Wachen, Kameras, Zeitpläne …) einmal melden; ohne Telegram bleibt es bei console.error und /check
  if (config.telegramToken && config.telegramOwner) void dateiHinweiseMelden();
  if (config.telegramToken && config.telegramOwner) startScheduler();
  if (config.frigateUrl && config.telegramToken) startWatch();

  // morningTick meldet Fehler je Quelle an die Gesundheit; hier landet nur, was dort durchrutscht
  const tick = () => morningTick().catch((e) => console.error("Hintergrund-Fehler:", e instanceof Error ? schwaerze(e.message) : e));
  tick();
  setInterval(tick, 5 * 60_000);

  // Watchdog: dauerhafte Störungen einmal melden, Erholung melden (Meldungen laufen über den Postausgang in telegram.ts)
  setInterval(() => gesundheit.tick().catch((e) => console.error("Watchdog:", e instanceof Error ? schwaerze(e.message) : e)), 60_000);
}

// Standard: nur lokal lauschen (Alexa kommt über den Cloudflare Tunnel). LISTEN_HOST=0.0.0.0 öffnet das Heimnetz für /events.
// Express 5 ruft den Callback auch bei einem Fehler (Port belegt): dann beenden statt still ohne /alexa, /notfall und
// Dashboard weiterzulaufen – systemd (Restart=on-failure) sieht den Fehler, und kein zweiter Scheduler läuft mit.
app.listen(config.port, config.listenHost, (err?: Error) => {
  if (err) {
    console.error(`Port ${config.port} auf ${config.listenHost} nicht verfügbar (${schwaerze(err.message)}). Jarvis beendet sich, Sir.`);
    process.exit(1);
  }
  console.log(`Jarvis läuft auf http://${config.listenHost}:${config.port}${config.eventToken ? " (Ereignisse aktiv)" : ""}`);
  hintergrundStarten();
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void closeBrowser().finally(() => process.exit(0)));
}
