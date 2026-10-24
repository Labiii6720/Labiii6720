import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import { config, opt } from "./config.js";
import { istNurLesen, sicherungVorhanden } from "./datei.js";
import { gesundheit, schwaerze } from "./robust.js";
import { pruefeZeitfenster } from "./setup.js";
import { day, state, stateNichtGeladen, zustandDefekt } from "./state.js";

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
// Schwere Module (googleapis, Playwright, Werkzeugkasten) erst bei Bedarf laden: npm run check und die Prüfung im
// Einrichtungs-Assistenten starten sonst Sekunden langsamer. Im Dienst sind sie ohnehin schon geladen.
const sources = () => import("./sources.js");
// Nur für Tests verkürzbar (JARVIS_CHECK_TIMEOUT_MS); im Betrieb 10 s je Dienst.
const TEST_MS = Number(process.env.JARVIS_CHECK_TIMEOUT_MS);
const PRUEF_MS = TEST_MS > 0 ? TEST_MS : 10_000;

/** Höchstlänge eines Fehlertexts im Befund (pruefe kürzt darauf; listenBefund bleibt darunter). */
const BEFUND_MAX = 140;

async function pruefe(name: string, eingerichtet: boolean, test: () => Promise<string>): Promise<Befund> {
  if (!eingerichtet) return { name, status: "fehlt", info: "nicht eingerichtet" };
  try {
    return { name, status: "ok", info: await test() };
  } catch (e) {
    // Erst schwärzen, dann kürzen: Fehlertexte können URLs mit Zugangsdaten enthalten und gehen per /check nach Telegram.
    return { name, status: "fehler", info: schwaerze(e instanceof Error ? e.message : String(e)).slice(0, BEFUND_MAX) };
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

  // Zuerst: mit unlesbarer state.json startet der Dienst im Notfall, und WHOOP/Gmail wirken bloss «nicht verbunden».
  await lauf("Zustand", true, async () => {
    if (stateNichtGeladen) throw new Error(`data/state.json unlesbar (${zustandDefekt?.ursache ?? "?"}, ${sicherungsVermerk(["data/state.json"])}) – Dienst startet im Notfall; reparieren oder entfernen, neu starten`);
    return existsSync("data/state.json") ? "data/state.json lesbar" : "data/state.json noch nicht angelegt";
  });
  // Unlesbar startet der Dienst still mit leerem Profil, und erst das nächste Speichern (Werkzeug, Verdichtung) scheitert.
  await lauf("Profil", true, async () => {
    const p = await import("./profil.js");
    if (p.profilNichtGeladen) throw new Error(`data/profil.json unlesbar (${sicherungsVermerk(["data/profil.json"])}) – leeres Profil, nichts wird gespeichert; reparieren, neu starten`);
    return existsSync("data/profil.json") ? "data/profil.json lesbar" : "data/profil.json noch nicht angelegt";
  });

  // Genau ein Versuch wie bei allen anderen Prüfungen; sonst wiederholt das SDK Zeitüberschreitungen zweimal (3 × 15 s).
  await lauf("Claude-API", Boolean(opt("ANTHROPIC_API_KEY")), async () => {
    const list = await new Anthropic({ maxRetries: 0 }).models.list({ limit: 50 }, { timeout: TEST_MS > 0 ? PRUEF_MS : 15_000 });
    const ids = list.data.map((m) => m.id);
    const fehlt = [config.claudeModel, config.claudeModelStark, config.claudeModelSehen].filter((m) => !ids.includes(m));
    return fehlt.length ? `erreichbar, aber unbekannte Modelle: ${fehlt.join(", ")}` : `erreichbar, Modelle gültig (${config.claudeModel}, ${config.claudeModelStark}, ${config.claudeModelSehen})`;
  });

  await lauf("Telegram", Boolean(config.telegramToken && config.telegramOwner), async () => {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getMe`, { signal: t(PRUEF_MS) });
    const j = (await res.json()) as { ok: boolean; result?: { username: string } };
    if (!j.ok) throw new Error("Token ungültig");
    return `Bot @${j.result?.username}, Chat ${config.telegramOwner}`;
  });

  await lauf("WHOOP", Boolean(opt("WHOOP_CLIENT_ID")), async () => {
    // Neu anmelden hilft dann nicht: das Auth-Skript speichert nichts (pruefeZustandSpeicherbar)
    if (stateNichtGeladen) throw new Error("state.json unlesbar – erst reparieren, dann npm run whoop:auth");
    if (!state.whoop?.refreshToken) throw new Error("nicht verbunden: npm run whoop:auth");
    const s = await sources();
    // npm run check erneuert keinen Token (WHOOP rotiert ihn, der laufende Dienst hielte sonst einen entwerteten)
    if (istNurLesen() && !s.whoopTokenGueltig() && !day().recovery) return "verbunden (Token abgelaufen, der Dienst erneuert ihn; nicht live geprüft)";
    const r = await s.recoveryToday(PRUEF_MS);
    return r ? `verbunden, Recovery heute ${r.score} %` : "verbunden, Recovery heute noch nicht berechnet";
  });

  await lauf("Google Kalender", Boolean(opt("GOOGLE_KEY_FILE") && opt("GOOGLE_CALENDAR_ID")), async () => {
    if (!existsSync(opt("GOOGLE_KEY_FILE")!)) throw new Error("Schlüsseldatei fehlt");
    const ev = await (await sources()).googleEvents();
    return `lesbar, heute ${ev.length} Termin(e)`;
  });

  await lauf("Outlook-Kalender", Boolean(opt("OUTLOOK_ICS_URL")), async () => `lesbar, heute ${(await (await sources()).outlookEvents()).length} Termin(e) (${config.outlookMode})`);

  await lauf("Gmail", Boolean(config.gmail), async () => {
    if (stateNichtGeladen) throw new Error("state.json unlesbar – erst reparieren, dann npm run google:auth");
    if (!state.google?.refreshToken) throw new Error("nicht verbunden: npm run google:auth");
    const { searchMails } = await import("./gmail.js");
    await searchMails("newer_than:1d", 1);
    return "verbunden";
  });

  await lauf("Home Assistant", Boolean(config.homeAssistant), async () => {
    const res = await fetch(`${config.homeAssistant!.url}/api/`, { headers: { Authorization: `Bearer ${config.homeAssistant!.token}` }, signal: t(PRUEF_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { haState } = await import("./homeassistant.js");
    const presence = config.presenceEntity ? `, ${config.presenceEntity} = ${await haState(config.presenceEntity).catch(() => "?")}` : "";
    return `erreichbar${presence}`;
  });

  await lauf("Frigate", Boolean(config.frigateUrl), async () => {
    const res = await fetch(`${config.frigateUrl}/api/version`, { signal: t(PRUEF_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { cameras } = await import("./cameras.js");
    return `Version ${(await res.text()).trim()}, ${Object.keys(cameras).length} Kamera(s) in cameras.json`;
  });

  await lauf("MQTT", Boolean(config.mqtt), async () => {
    const mqtt = (await import("mqtt")).default;
    await new Promise<void>((ok, err) => {
      const c = mqtt.connect(config.mqtt!.url, { username: config.mqtt!.username, password: config.mqtt!.password, connectTimeout: TEST_MS > 0 ? PRUEF_MS : 8000, reconnectPeriod: 0 });
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
    const { browserPath } = await import("./browser.js");
    const p = browserPath();
    if (!p) throw new Error("kein Chromium gefunden, Seiten gehen nur über seite_lesen");
    return p;
  });

  await lauf("Werkstatt", true, async () => ((await import("./werkstatt.js")).hasOpenscad() ? "OpenSCAD vorhanden" : (() => { throw new Error("OpenSCAD fehlt (apt install openscad)"); })()));
  await lauf("3D-Drucker", Boolean(config.octoprint), async () => {
    const res = await fetch(`${config.octoprint!.url}/api/version`, { headers: { "X-Api-Key": config.octoprint!.key }, signal: t(PRUEF_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return "OctoPrint erreichbar";
  });
  await lauf("Slicer", Boolean(config.slicerPath || config.slicerProfil), async () => (await import("./werkstatt.js")).pruefeSlicer(PRUEF_MS));

  await lauf("Stimme (STT/TTS)", Boolean(config.stt || config.tts), async () => `${config.stt ? "STT " : ""}${config.tts ? "TTS " : ""}eingetragen (nicht live getestet)`);
  await lauf("Alexa-Skill", Boolean(opt("ALEXA_SKILL_ID")), async () => {
    // Gleiche Auswertung wie nachtFenster/istNacht (alexa.ts) – nicht importiert, das lüde Skill, Agent und Telegram.
    const fenster = config.alexaNacht.trim();
    if (pruefeZeitfenster(fenster)) throw new Error(`ALEXA_NACHT «${config.alexaNacht}» ungültig (HH:MM-HH:MM oder off); Nachtstimme nur im Nachtmodus`);
    const [von, bis] = fenster.split("-");
    if (fenster !== "off" && von === bis) throw new Error(`ALEXA_NACHT «${config.alexaNacht}»: Fenster leer (Beginn gleich Ende); Nachtstimme nur im Nachtmodus`);
    const nacht = fenster === "off" ? "nur im Nachtmodus" : `${fenster} und im Nachtmodus`;
    return `Skill-ID gesetzt, leise Nachtstimme ${nacht}; Erreichbarkeit über den Tunnel im Alexa-Test-Tab prüfen`;
  });
  await lauf("Finanzen", true, async () => {
    const f = await import("./finanzen.js");
    if (f.rechnungenNichtGeladen) throw new Error(`data/rechnungen.json unlesbar (${sicherungsVermerk(["data/rechnungen.json"])}), bitte reparieren und neu starten`);
    return `${f.rechnungen.length} Rechnung(en) erfasst`;
  });
  await lauf("Wachen", true, async () => {
    const k = await import("./cameras.js");
    if (k.wachenNichtGeladen) throw new Error(`data/wachen.json unlesbar (${sicherungsVermerk(["data/wachen.json"])}), Wachen aus – bitte reparieren und neu starten`);
    if (k.camerasNichtGeladen) throw new Error("cameras.json unlesbar, Kameras, Meldungen und Wachen aus der Datei sind aus");
    // Wie der Takt in watch.ts (wacheZustand): ohne gültiges «alle_minuten», auf fehlender bzw. verworfener Kamera oder
    // mit ungültigem «nur_wenn» schaut eine Wache nicht hin, zählt also nicht als aktiv. Fehlt beides, zählt sie bei beiden Gründen.
    const zustaende = k.allWachen().map(k.wacheZustand);
    const aktiv = zustaende.filter((z) => z.laeuft).length;
    const ohneTakt = zustaende.filter((z) => z.takt === undefined).length;
    const ohneKamera = zustaende.filter((z) => z.grund === "Kamera fehlt" || z.grund === "Kamera und Intervall fehlen").length;
    const ohneBedingung = zustaende.filter((z) => z.grund === "Bedingung ungültig").length;
    const ohneFrage = zustaende.filter((z) => z.grund === "Frage fehlt").length;
    return `${aktiv} Wache(n) aktiv${ohneTakt ? `, ${ohneTakt} ohne gültiges Intervall (laufen nicht)` : ""}${ohneKamera ? `, ${ohneKamera} auf fehlender Kamera (laufen nicht)` : ""}${ohneBedingung ? `, ${ohneBedingung} mit ungültiger Bedingung «nur_wenn» (laufen nicht)` : ""}${ohneFrage ? `, ${ohneFrage} ohne Frage (laufen nicht)` : ""}`;
  });
  // Listen in data/ nur lesen (untersucheListe: keine Sicherung, kein Log): unlesbar oder mit ungültigen Einträgen, die
  // der Dienst beim Start überspringt. Dazu die beim Laden übersprungenen Einträge in cameras.json, die Jarvis nie ändert.
  await lauf("Listen", true, async () => {
    const d = await import("./datei.js");
    await import("./cameras.js");
    const unlesbar: string[] = [];
    const ungueltig: { name: string; anzahl: number }[] = [];
    const betroffen: string[] = [];
    let eintraege = 0;
    let fehlen = 0;
    for (const l of d.LISTEN) {
      const u = d.untersucheListe(l.datei, l.pruefe);
      eintraege += u.eintraege;
      if (u.zustand === "fehlt") { fehlen++; continue; }
      if (u.zustand === "unlesbar") unlesbar.push(l.name);
      else if (u.verworfen) ungueltig.push({ name: l.name, anzahl: u.verworfen });
      else continue;
      betroffen.push(l.datei);
    }
    const kameras = d.uebersprungenAnzahl("cameras.json");
    if (unlesbar.length || ungueltig.length || kameras) throw new Error(listenBefund(unlesbar, ungueltig, kameras, sicherungsVermerk(betroffen)));
    return `${d.LISTEN.length - fehlen} Listen in data/ lesbar${fehlen ? `, ${fehlen} noch nicht angelegt` : ""}, ${eintraege} gültige Einträge`;
  });
  await lauf("Protokolle", true, async () => `${Object.keys((await import("./protokolle.js")).protokolle).length} Protokoll(e)`);
  await lauf("Sicherheit", true, async () => {
    const warn: string[] = [];
    if (!config.pin) warn.push("keine PIN (JARVIS_PIN)");
    if (config.listenHost !== "127.0.0.1" && !config.eventToken) warn.push("im Heimnetz erreichbar ohne Ereignis-Token");
    if (config.eventsViaTunnel) warn.push("/events und /gesture über den Tunnel offen");
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

/**
 * Sicherungs-Vermerk für unlesbare oder verdorbene Dateien: eine Sicherung nur nennen, wenn sie existiert. npm run check
 * liest nur und legt keine an, und eine Datei ohne Leserechte kann auch der Dienst nicht sichern.
 */
export function sicherungsVermerk(dateien: readonly string[]): string {
  const gesichert = dateien.filter((d) => sicherungVorhanden(d)).length;
  if (dateien.length && gesichert === dateien.length) return dateien.length > 1 ? "Sicherung je .defekt" : "Sicherung .defekt";
  if (gesichert) return "teils gesichert (.defekt)";
  return istNurLesen() ? "ungesichert, nur gelesen" : "ungesichert";
}

/**
 * Befund «Listen» lesbar in BEFUND_MAX Zeichen, statt mitten im Wort abgeschnitten: zuerst mit Anzahl je Liste, sonst nur
 * die Namen, sonst nur die Zahl der Listen. `sicherungText` aus sicherungsVermerk; cameras.json sichert Jarvis nie.
 */
export function listenBefund(unlesbar: string[], ungueltig: { name: string; anzahl: number }[], kameras: number, sicherungText = "Sicherung je .defekt"): string {
  const cam = kameras ? [`cameras.json ${kameras} ungültig (von Hand reparieren)`] : [];
  const sicherung = unlesbar.length || ungueltig.length ? [sicherungText] : [];
  const text = (u: string | undefined, g: string | undefined) =>
    [...(u ? [`unlesbar: ${u}`] : []), ...(g ? [`ungültig: ${g}`] : []), ...sicherung, ...cam].join("; ");
  const anzahl = (n: number) => (n ? `${n} ${n === 1 ? "Liste" : "Listen"}` : undefined);
  const stufen = [
    text(unlesbar.join(", ") || undefined, ungueltig.map((x) => `${x.name} ${x.anzahl}`).join(", ") || undefined),
    text(unlesbar.join(", ") || undefined, ungueltig.map((x) => x.name).join(", ") || undefined),
    text(anzahl(unlesbar.length), anzahl(ungueltig.length)),
  ];
  return stufen.find((t) => t.length <= BEFUND_MAX) ?? stufen.at(-1)!;
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

/**
 * Befunde als Text; die Summenzeile bleibt die letzte Zeile (scripts/check.ts liest sie so). Hat die Gesundheit
 * im laufenden Dienst schon Komponenten gesehen (/check in Telegram), steht ihr Bericht vor der Summenzeile.
 */
export function formatBefund(b: Befund[]): string {
  const icon = { ok: "✅", fehlt: "➖", fehler: "❌" };
  const zeilen = b.map((x) => `${icon[x.status]} ${x.name}: ${x.info}`);
  const n = (s: Befund["status"]) => b.filter((x) => x.status === s).length;
  const bericht = gesundheit.bericht();
  const anhang = bericht ? `\n\nGesundheit der Anbindungen (laufender Betrieb):\n${bericht}` : "";
  return `${zeilen.join("\n")}${anhang}\n\n${n("ok")} ok · ${n("fehlt")} nicht eingerichtet · ${n("fehler")} Fehler`;
}
