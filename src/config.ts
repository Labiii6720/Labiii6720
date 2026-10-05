/** Konfiguration aus .env – wird von allen anderen Modulen zuerst importiert. */
try {
  process.loadEnvFile(); // .env aus dem Arbeitsordner (Node 22+)
} catch {
  // keine .env → Werte müssen in der Umgebung stehen
}

export const TZ = "Europe/Zurich";
process.env.TZ = TZ; // alle Datumsberechnungen in Schweizer Zeit

export function opt(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function env(name: string): string {
  const value = opt(name);
  if (!value) throw new Error(`Fehlende Variable in .env: ${name}`);
  return value;
}

export const config = {
  name: opt("NAME") ?? "Sir",
  /** Wie Jarvis dich anspricht (Film: «Sir») */
  anrede: opt("JARVIS_ANREDE") ?? "Sir",
  /** sie (Butler, wie im Film) oder du */
  form: (opt("JARVIS_FORM") === "du" ? "du" : "sie") as "sie" | "du",
  port: Number(opt("PORT") ?? "3000"),
  claudeModel: opt("CLAUDE_MODEL") ?? "claude-sonnet-5-5",
  /** Stärkeres Modell für schwere Aufgaben: «!»-Präfix im Chat und Vorgänge */
  claudeModelStark: opt("CLAUDE_MODEL_STARK") ?? "claude-opus-5-5",
  /** Günstiges Modell fürs Hinschauen (Kamera-Wachen, Vorschauen); leer = Hauptmodell */
  claudeModelSehen: opt("CLAUDE_MODEL_SEHEN") ?? "claude-haiku-4-5-20251001",
  /** Preise pro Million Tokens für die Kostenschätzung (USD) */
  preise: {
    input: Number(opt("PREIS_INPUT") ?? "2"),
    output: Number(opt("PREIS_OUTPUT") ?? "10"),
    cacheRead: Number(opt("PREIS_CACHE_READ") ?? "0.2"),
    cacheWrite: Number(opt("PREIS_CACHE_WRITE") ?? "2.5"),
  },
  /** Täglicher Rückblick (Lernen aus dem Tag) um HH:MM; off = aus */
  rueckblick: opt("RUECKBLICK") ?? "22:30",
  /** Rechnungs-Erinnerung täglich um HH:MM (off = aus) und Vorlauf in Tagen vor Fälligkeit */
  rechnungErinnerung: opt("RECHNUNG_ERINNERUNG") ?? "08:30",
  rechnungVorlauf: Number(opt("RECHNUNG_VORLAUF_TAGE") ?? "3"),
  /** Wöchentlicher Zielcheck: Wochentag und Uhrzeit, z. B. «so 18:00»; off = aus */
  zielcheck: opt("ZIELCHECK") ?? "so 18:00",
  /** Werkzeugrunden pro Anfrage: normal und für schwere Aufgaben */
  maxLoops: Number(opt("MAX_LOOPS") ?? "10"),
  maxLoopsStark: Number(opt("MAX_LOOPS_STARK") ?? "40"),
  alexaVoice: opt("ALEXA_VOICE"),
  /** busy = Claude sieht nur belegte Zeiten, details = auch Titel und Orte */
  outlookMode: (opt("OUTLOOK_MODE") === "details" ? "details" : "busy") as "busy" | "details",
  /** Ab dieser Uhrzeit wird das Tagesbriefing im Hintergrund vorbereitet */
  briefingPrepFrom: opt("BRIEFING_PREP_FROM") ?? "05:45",

  // ---------- interaktiver Jarvis (Telegram) ----------
  telegramToken: opt("TELEGRAM_BOT_TOKEN"),
  /** Nur dieser Chat darf Jarvis steuern */
  telegramOwner: opt("TELEGRAM_CHAT_ID"),
  /** PIN für Aufträge der Stufe «sensibel» */
  pin: opt("JARVIS_PIN"),
  /** Arbeitsordner für Code und Websites; nur hier darf Jarvis Dateien schreiben */
  workspace: opt("JARVIS_WORKSPACE") ?? "workspace",
  /** auto = Shell-Befehle im Arbeitsordner laufen direkt, freigabe = erst nach deinem OK */
  commands: (opt("JARVIS_COMMANDS") === "auto" ? "auto" : "freigabe") as "auto" | "freigabe",
  /** Websuche über die Claude-API (off, falls die API den Tool-Typ nicht kennt) */
  webSearch: opt("WEB_SEARCH") !== "off",

  homeAssistant: opt("HA_URL") && opt("HA_TOKEN") ? { url: opt("HA_URL")!.replace(/\/$/, ""), token: opt("HA_TOKEN")! } : undefined,
  /** Gerätetypen, die Jarvis ohne Freigabe schalten darf */
  haAutoDomains: (opt("HA_AUTO_DOMAINS") ?? "light,switch,media_player,fan,scene,climate").split(",").map((s) => s.trim()),

  shopify: opt("SHOPIFY_SHOP") && opt("SHOPIFY_TOKEN")
    ? { shop: opt("SHOPIFY_SHOP")!, token: opt("SHOPIFY_TOKEN")!, version: opt("SHOPIFY_API_VERSION") ?? "2026-01" }
    : undefined,

  gmail: opt("GOOGLE_OAUTH_CLIENT_ID") && opt("GOOGLE_OAUTH_CLIENT_SECRET")
    ? { clientId: opt("GOOGLE_OAUTH_CLIENT_ID")!, clientSecret: opt("GOOGLE_OAUTH_CLIENT_SECRET")! }
    : undefined,

  // ---------- Browser, Stimme, Zeitpläne ----------
  /** Pfad zu Chromium/Chrome; leer = automatisch suchen */
  browserPath: opt("BROWSER_PATH"),
  /** Spracherkennung und Sprachausgabe über OpenAI-kompatible Endpunkte (Cloud oder lokal) */
  stt: opt("STT_URL") ? { url: opt("STT_URL")!, key: opt("STT_KEY") ?? "", model: opt("STT_MODEL") ?? "whisper-1" } : undefined,
  tts: opt("TTS_URL") ? { url: opt("TTS_URL")!, key: opt("TTS_KEY") ?? "", model: opt("TTS_MODEL") ?? "tts-1", voice: opt("TTS_VOICE") ?? "onyx" } : undefined,
  /** Wie lange Alexa auf eine Antwort wartet, bevor Jarvis auf Telegram ausweicht (ms) */
  alexaBudgetMs: Number(opt("ALEXA_BUDGET_MS") ?? "6500"),

  // ---------- Ereignisse aus Home Assistant ----------
  /** Geheimnis, mit dem Home Assistant Ereignisse an /events schicken darf; leer = Endpunkt aus */
  eventToken: opt("JARVIS_EVENT_TOKEN"),
  /** 127.0.0.1 = nur lokal; 0.0.0.0 = im Heimnetz erreichbar (für Home Assistant auf einem anderen Gerät) */
  listenHost: opt("LISTEN_HOST") ?? "127.0.0.1",
  /** /events und /gesture auch über den Cloudflare Tunnel erlauben (Standard: nein, nur Heimnetz/Tailscale) */
  eventsViaTunnel: opt("EVENTS_VIA_TUNNEL") === "on",

  // ---------- Kameras ----------
  /** Frigate NVR, z. B. http://192.168.1.20:5000 */
  frigateUrl: opt("FRIGATE_URL")?.replace(/\/$/, ""),
  /** MQTT-Broker für Frigate-Ereignisse, z. B. mqtt://192.168.1.10:1883 */
  mqtt: opt("MQTT_URL") ? { url: opt("MQTT_URL")!, username: opt("MQTT_USER"), password: opt("MQTT_PASSWORD") } : undefined,
  /** Home-Assistant-Entität für «zu Hause», z. B. person.labinot – steuert Kamera-Meldungen «nur wenn abwesend» */
  presenceEntity: opt("HA_PRESENCE_ENTITY"),

  // ---------- Berater, Finanzen, Notfall ----------
  /** Wie deutlich der Berater widerspricht: sanft, direkt, hart */
  beraterTon: (["sanft", "direkt", "hart"].includes(opt("BERATER_TON") ?? "") ? opt("BERATER_TON") : "direkt") as "sanft" | "direkt" | "hart",
  /** Zahlungen nur vorbereiten (nie auslösen) – Standard an, aus Sicherheits- und Haftungsgründen empfohlen */
  zahlungNurVorbereiten: opt("ZAHLUNG_NUR_VORBEREITEN") !== "off",
  /** Geheimnis für POST /notfall (Panik-Auslöser von Handy/Taster); leer = Endpunkt aus */
  panicToken: opt("JARVIS_PANIC_TOKEN"),

  // ---------- Dashboard, Werkstatt ----------
  /** Dashboard unter /dashboard aktiv (nur Heimnetz/Tailscale). Nutzt JARVIS_EVENT_TOKEN. */
  dashboard: opt("DASHBOARD") !== "off",
  /** OpenSCAD zum Rendern von CAD-Vorschauen; leer = automatisch suchen */
  openscadPath: opt("OPENSCAD_PATH"),
  /** 3D-Drucker über OctoPrint: URL und API-Key */
  octoprint: opt("OCTOPRINT_URL") && opt("OCTOPRINT_KEY") ? { url: opt("OCTOPRINT_URL")!.replace(/\/$/, ""), key: opt("OCTOPRINT_KEY")! } : undefined,
};
