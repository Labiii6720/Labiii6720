import express from "express";
import { fileURLToPath } from "node:url";
import { ExpressAdapter } from "ask-sdk-express-adapter";
import { config, env } from "./config.js";
import { buildSkill } from "./alexa.js";
import { morningTick } from "./brain.js";
import { startTelegram } from "./telegram.js";
import { startScheduler } from "./scheduler.js";
import { closeBrowser } from "./browser.js";
import { handleEvent } from "./events.js";
import { startWatch } from "./watch.js";
import { handlePanic } from "./notfall.js";
import { auditTail, auftragAction, chat, dashboardAuth, geraete, kameraBild, modus, protokollAction, statusJson } from "./dashboard.js";
import { gesundheit, schwaerze } from "./robust.js";

const app = express();
app.disable("x-powered-by");

/** Nur Heimnetz, Tailscale oder localhost – alles, was über den Cloudflare Tunnel kommt, bekommt ein 404. */
const PRIVATE = /^(::1|::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)|^::1$|^fe80:|^fc|^fd/i;
const lanOnly = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const viaTunnel = Boolean(req.headers["cf-connecting-ip"] || req.headers["cf-ray"]);
  const ip = req.socket.remoteAddress ?? "";
  if ((viaTunnel && !config.eventsViaTunnel) || !PRIVATE.test(ip)) return void res.status(404).end();
  next();
};

/** Async-Handler absichern: ein Fehler wird geschwärzt geloggt und mit 500 beantwortet statt als unbehandelte Rejection. */
const sicher =
  (h: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response): void =>
    void h(req, res).catch((e: unknown) => {
      console.error(e instanceof Error ? schwaerze(e.message) : e);
      if (!res.headersSent) res.status(500).json({ ok: false });
    });

app.get("/health", (_req, res) => {
  res.send("ok");
});

// Prüft bei jeder Anfrage Amazons Signatur und den Zeitstempel; fremde Skill-IDs weist buildSkill ab
const adapter = new ExpressAdapter(buildSkill(env("ALEXA_SKILL_ID")), true, true);
app.post("/alexa", adapter.getRequestHandlers());

// Ereignisse aus dem Haus (Home Assistant) und aus der Gesten-Konsole, nur mit Token
if (config.eventToken) {
  const cors = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" });
    next();
  };
  app.options("/events", lanOnly, cors, (_req, res) => void res.sendStatus(204));
  app.post("/events", lanOnly, cors, express.json({ limit: "64kb" }), sicher(handleEvent));
}

// Panik-Auslöser fürs Handy (eigener Token), auch über den Tunnel erreichbar – im Notfall zählt Erreichbarkeit
if (config.panicToken) app.post("/notfall", express.json({ limit: "4kb" }), sicher(handlePanic));

// Gesten- und Sprachkonsole (Webcam-Handtracking im Browser)
app.get("/gesture", lanOnly, (_req, res) => {
  res.sendFile(fileURLToPath(new URL("../web/gesture.html", import.meta.url)));
});

// Kommandozentrale: der Kern. Seite und API nur aus dem Heimnetz/Tailscale, API zusätzlich mit Token.
if (config.dashboard && config.eventToken) {
  const json = express.json({ limit: "64kb" });
  app.get("/dashboard", lanOnly, (_req, res) => res.sendFile(fileURLToPath(new URL("../web/dashboard.html", import.meta.url))));
  app.get("/status.json", lanOnly, dashboardAuth, statusJson);
  app.post("/api/auftrag", lanOnly, dashboardAuth, json, sicher(auftragAction));
  app.post("/api/chat", lanOnly, dashboardAuth, json, sicher(chat));
  app.post("/api/protokoll", lanOnly, dashboardAuth, json, sicher(protokollAction));
  app.post("/api/modus", lanOnly, dashboardAuth, json, modus);
  app.get("/api/kamera/:name", lanOnly, dashboardAuth, sicher(kameraBild));
  app.get("/api/geraete", lanOnly, dashboardAuth, sicher(geraete));
  app.get("/api/audit", lanOnly, dashboardAuth, auditTail);
}

// Standard: nur lokal lauschen (Alexa kommt über den Cloudflare Tunnel). LISTEN_HOST=0.0.0.0 öffnet das Heimnetz für /events.
app.listen(config.port, config.listenHost, () => {
  console.log(`Jarvis läuft auf http://${config.listenHost}:${config.port}${config.eventToken ? " (Ereignisse aktiv)" : ""}`);
});

startTelegram();
if (config.telegramToken && config.telegramOwner) startScheduler();
if (config.frigateUrl && config.telegramToken) startWatch();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void closeBrowser().finally(() => process.exit(0)));
}

// morningTick meldet Fehler je Quelle an die Gesundheit; hier landet nur, was dort durchrutscht
const tick = () => morningTick().catch((e) => console.error("Hintergrund-Fehler:", e instanceof Error ? schwaerze(e.message) : e));
tick();
setInterval(tick, 5 * 60_000);

// Watchdog: dauerhafte Störungen einmal melden, Erholung melden (Meldungen laufen über den Postausgang in telegram.ts)
setInterval(() => gesundheit.tick().catch((e) => console.error("Watchdog:", e instanceof Error ? schwaerze(e.message) : e)), 60_000);
