import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import { browserPath } from "./browser.js";
import { cameras } from "./cameras.js";
import { config, opt } from "./config.js";
import { haState } from "./homeassistant.js";
import { protokolle } from "./protokolle.js";
import { googleEvents, outlookEvents, recoveryToday } from "./sources.js";
import { state } from "./state.js";
import { hasOpenscad } from "./werkstatt.js";

/**
 * Selbsttest: prüft jede eingerichtete Anbindung mit einem echten, billigen Aufruf und sagt klar,
 * was läuft, was fehlt und was kaputt ist. Nutzt keine Tokens (Claude: nur die Modellliste).
 *
 *   npm run check        auf dem Pi
 *   /check               in Telegram
 */
export interface Befund {
  name: string;
  status: "ok" | "fehlt" | "fehler";
  info: string;
}

const t = (ms: number) => AbortSignal.timeout(ms);

async function pruefe(name: string, eingerichtet: boolean, test: () => Promise<string>): Promise<Befund> {
  if (!eingerichtet) return { name, status: "fehlt", info: "nicht eingerichtet" };
  try {
    return { name, status: "ok", info: await test() };
  } catch (e) {
    return { name, status: "fehler", info: (e instanceof Error ? e.message : String(e)).slice(0, 140) };
  }
}

/**
 * `nur`: nur die Befunde mit diesen Namen laufen (Gross-/Kleinschreibung egal); unbekannte Namen → Befund «fehler».
 * `beiBefund`: wird je Befund sofort gerufen, damit fertige Ergebnisse auch bei einem Zeitlimit sichtbar bleiben.
 */
export async function selbsttest(nur?: string[], beiBefund?: (b: Befund) => void): Promise<Befund[]> {
  const b: Befund[] = [];
  const gewuenscht = nur?.length ? new Set(nur.map((n) => n.trim().toLowerCase())) : undefined;
  const bekannt = new Set<string>();
  const lauf = async (name: string, eingerichtet: boolean, test: () => Promise<string>) => {
    bekannt.add(name.toLowerCase());
    if (gewuenscht && !gewuenscht.has(name.toLowerCase())) return;
    const befund = await pruefe(name, eingerichtet, test);
    b.push(befund);
    beiBefund?.(befund);
  };

  // Genau ein Versuch wie bei allen anderen Prüfungen; sonst wiederholt das SDK Zeitüberschreitungen zweimal (3 × 15 s).
  await lauf("Claude-API", Boolean(opt("ANTHROPIC_API_KEY")), async () => {
    const list = await new Anthropic({ maxRetries: 0 }).models.list({ limit: 50 }, { timeout: 15_000 });
    const ids = list.data.map((m) => m.id);
    const fehlt = [config.claudeModel, config.claudeModelStark, config.claudeModelSehen].filter((m) => !ids.includes(m));
    return fehlt.length ? `erreichbar, aber unbekannte Modelle: ${fehlt.join(", ")}` : `erreichbar, Modelle gültig (${config.claudeModel}, ${config.claudeModelStark}, ${config.claudeModelSehen})`;
  });

  await lauf("Telegram", Boolean(config.telegramToken && config.telegramOwner), async () => {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getMe`, { signal: t(10_000) });
    const j = (await res.json()) as { ok: boolean; result?: { username: string } };
    if (!j.ok) throw new Error("Token ungültig");
    return `Bot @${j.result?.username}, Chat ${config.telegramOwner}`;
  });

  await lauf("WHOOP", Boolean(opt("WHOOP_CLIENT_ID")), async () => {
    if (!state.whoop?.refreshToken) throw new Error("nicht verbunden: npm run whoop:auth");
    const r = await recoveryToday(10_000);
    return r ? `verbunden, Recovery heute ${r.score} %` : "verbunden, Recovery heute noch nicht berechnet";
  });

  await lauf("Google Kalender", Boolean(opt("GOOGLE_KEY_FILE") && opt("GOOGLE_CALENDAR_ID")), async () => {
    if (!existsSync(opt("GOOGLE_KEY_FILE")!)) throw new Error("Schlüsseldatei fehlt");
    const ev = await googleEvents();
    return `lesbar, heute ${ev.length} Termin(e)`;
  });

  await lauf("Outlook-Kalender", Boolean(opt("OUTLOOK_ICS_URL")), async () => `lesbar, heute ${(await outlookEvents()).length} Termin(e) (${config.outlookMode})`);

  await lauf("Gmail", Boolean(config.gmail), async () => {
    if (!state.google?.refreshToken) throw new Error("nicht verbunden: npm run google:auth");
    const { searchMails } = await import("./gmail.js");
    await searchMails("newer_than:1d", 1);
    return "verbunden";
  });

  await lauf("Home Assistant", Boolean(config.homeAssistant), async () => {
    const res = await fetch(`${config.homeAssistant!.url}/api/`, { headers: { Authorization: `Bearer ${config.homeAssistant!.token}` }, signal: t(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const presence = config.presenceEntity ? `, ${config.presenceEntity} = ${await haState(config.presenceEntity).catch(() => "?")}` : "";
    return `erreichbar${presence}`;
  });

  await lauf("Frigate", Boolean(config.frigateUrl), async () => {
    const res = await fetch(`${config.frigateUrl}/api/version`, { signal: t(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return `Version ${(await res.text()).trim()}, ${Object.keys(cameras).length} Kamera(s) in cameras.json`;
  });

  await lauf("MQTT", Boolean(config.mqtt), async () => {
    const mqtt = (await import("mqtt")).default;
    await new Promise<void>((ok, err) => {
      const c = mqtt.connect(config.mqtt!.url, { username: config.mqtt!.username, password: config.mqtt!.password, connectTimeout: 8000, reconnectPeriod: 0 });
      c.once("connect", () => { c.end(true); ok(); });
      c.once("error", (e) => { c.end(true); err(e); });
    });
    return "verbunden";
  });

  await lauf("Shopify", Boolean(config.shopify), async () => {
    const { recentOrders } = await import("./shopify.js");
    await recentOrders(1);
    return `erreichbar (${config.shopify!.shop}, API ${config.shopify!.version})`;
  });

  await lauf("Browser", true, async () => {
    const p = browserPath();
    if (!p) throw new Error("kein Chromium gefunden, Seiten gehen nur über seite_lesen");
    return p;
  });

  await lauf("Werkstatt", true, async () => (hasOpenscad() ? "OpenSCAD vorhanden" : (() => { throw new Error("OpenSCAD fehlt (apt install openscad)"); })()));
  await lauf("3D-Drucker", Boolean(config.octoprint), async () => {
    const res = await fetch(`${config.octoprint!.url}/api/version`, { headers: { "X-Api-Key": config.octoprint!.key }, signal: t(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return "OctoPrint erreichbar";
  });

  await lauf("Stimme (STT/TTS)", Boolean(config.stt || config.tts), async () => `${config.stt ? "STT " : ""}${config.tts ? "TTS " : ""}eingetragen (nicht live getestet)`);
  await lauf("Alexa-Skill", Boolean(opt("ALEXA_SKILL_ID")), async () => `Skill-ID gesetzt; Erreichbarkeit über den Tunnel im Alexa-Test-Tab prüfen`);
  await lauf("Protokolle", true, async () => `${Object.keys(protokolle).length} Protokoll(e)`);
  await lauf("Sicherheit", true, async () => {
    const warn: string[] = [];
    if (!config.pin) warn.push("keine PIN (JARVIS_PIN)");
    if (config.listenHost !== "127.0.0.1" && !config.eventToken) warn.push("im Heimnetz erreichbar ohne Ereignis-Token");
    if (config.eventsViaTunnel) warn.push("/events über den Tunnel offen");
    if (config.commands === "auto") warn.push("Shell-Befehle laufen ohne Freigabe");
    if (!config.panicToken) warn.push("kein Panik-Token");
    if (warn.length) throw new Error(warn.join("; "));
    return "PIN, Token, Heimnetz-Sperre, Freigaben aktiv";
  });

  for (const name of nur ?? []) {
    if (bekannt.has(name.trim().toLowerCase())) continue;
    const befund: Befund = { name: name.trim(), status: "fehler", info: "unbekannte Prüfung" };
    b.push(befund);
    beiBefund?.(befund);
  }
  return b;
}

/** Liest `--nur a,b` (oder `--nur=a,b`) aus argv; ohne Flag undefined. */
export function nurAusArgv(argv: string[]): string[] | undefined {
  let roh: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--nur") roh = argv[i + 1];
    else if (argv[i].startsWith("--nur=")) roh = argv[i].slice(6);
  }
  const namen = roh?.split(",").map((n) => n.trim()).filter(Boolean);
  return namen?.length ? namen : undefined;
}

export function formatBefund(b: Befund[]): string {
  const icon = { ok: "✅", fehlt: "➖", fehler: "❌" };
  const zeilen = b.map((x) => `${icon[x.status]} ${x.name}: ${x.info}`);
  const n = (s: Befund["status"]) => b.filter((x) => x.status === s).length;
  return `${zeilen.join("\n")}\n\n${n("ok")} ok · ${n("fehlt")} nicht eingerichtet · ${n("fehler")} Fehler`;
}
