import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

/**
 * Einrichtungs-Assistent, Logik ohne Interaktion:  npm run setup  (scripts/setup.ts)
 * Schema der .env, Prüffunktionen, Lesen/Schreiben der .env mit erhaltenen Kommentaren.
 */

export type FeldArt = "text" | "geheim" | "token" | "wahl" | "zahl" | "zeit" | "url" | "pfad" | "host";

export interface Feld {
  /** exakt der Name in .env.example */
  key: string;
  frage: string;
  /** eine Zeile Hilfe: woher der Wert kommt */
  hinweis?: string;
  pflicht?: boolean;
  art: FeldArt;
  wahl?: string[];
  /** Vorschlag, wenn weder .env noch Eingabe einen Wert liefern (identisch zu .env.example) */
  standard?: string;
  /** Fehlertext oder undefined */
  pruefen?: (wert: string) => string | undefined;
  /** art token: leer + Enter erzeugt einen Token */
  erzeugen?: boolean;
  /** am Terminal ohne Echo, obwohl kein Geheimnis: kann eines enthalten */
  ohneEcho?: boolean;
}

export interface Abschnitt {
  /** Kennung für --abschnitt */
  name: string;
  titel: string;
  beschreibung: string;
  /** optional → Rückfrage «Jetzt einrichten?» */
  optional: boolean;
  felder: Feld[];
  /** Befund-Namen aus check.ts, die direkt nach dem Abschnitt laufen */
  checks?: string[];
}

// ---------- Prüffunktionen ----------

export function pruefeApiKey(wert: string): string | undefined {
  return wert.startsWith("sk-ant-") && wert.length >= 20 ? undefined : "muss mit sk-ant- beginnen (Claude Console)";
}

export function pruefeTelegramToken(wert: string): string | undefined {
  return /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(wert) ? undefined : "Form 123456789:ABC… wie von @BotFather erhalten";
}

export function pruefeChatId(wert: string): string | undefined {
  return /^-?\d{5,}$/.test(wert) ? undefined : "Chat-ID ist eine Zahl (z. B. über @userinfobot)";
}

export function pruefePin(wert: string): string | undefined {
  if (wert.length < 4) return "mindestens 4 Zeichen";
  if (/\s/.test(wert)) return "kein Leerraum erlaubt";
  return undefined;
}

export function pruefeUrl(wert: string): string | undefined {
  try {
    const u = new URL(wert);
    return u.protocol === "http:" || u.protocol === "https:" ? undefined : "nur http:// oder https://";
  } catch {
    return "keine gültige URL (http://host:port)";
  }
}

/** Nur HH:MM, kein «off»: für Felder, die der Dienst nicht abschalten kann (BRIEFING_PREP_FROM). */
export function pruefeUhrzeit(wert: string): string | undefined {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(wert) ? undefined : "Form HH:MM";
}

export function pruefeZeit(wert: string): string | undefined {
  return wert === "off" || pruefeUhrzeit(wert) === undefined ? undefined : "Form HH:MM oder off";
}

export function pruefeZielcheck(wert: string): string | undefined {
  return wert === "off" || /^(so|mo|di|mi|do|fr|sa) ([01]\d|2[0-3]):[0-5]\d$/.test(wert) ? undefined : "Form «so 18:00» (so mo di mi do fr sa) oder off";
}

export function pruefeZahl(wert: string): string | undefined {
  return /^\d+$/.test(wert) ? undefined : "ganze Zahl ab 0";
}

export function pruefePort(wert: string): string | undefined {
  const n = /^\d+$/.test(wert) ? Number(wert) : NaN;
  return n >= 1 && n <= 65535 ? undefined : "Port 1–65535";
}

export function pruefeKoordinate(min: number, max: number): (wert: string) => string | undefined {
  return (wert) => {
    const n = /^-?\d+(\.\d+)?$/.test(wert) ? Number(wert) : NaN;
    return Number.isFinite(n) && n >= min && n <= max ? undefined : `Dezimalgrad zwischen ${min} und ${max}`;
  };
}

export function pruefeModell(wert: string): string | undefined {
  return wert.startsWith("claude-") ? undefined : "Modellname beginnt mit claude-";
}

export function pruefeHost(wert: string): string | undefined {
  const teile = wert.split(".");
  const ok = teile.length === 4 && teile.every((t) => /^\d{1,3}$/.test(t) && Number(t) <= 255);
  return ok ? undefined : "IPv4-Adresse, z. B. 127.0.0.1 oder 0.0.0.0";
}

export function pruefeWahl(liste: string[]): (wert: string) => string | undefined {
  return (wert) => (liste.includes(wert) ? undefined : `eine von: ${liste.join(", ")}`);
}

export function pruefeSkillId(wert: string): string | undefined {
  return wert.startsWith("amzn1.ask.skill.") ? undefined : "beginnt mit amzn1.ask.skill.";
}

export function pruefeShop(wert: string): string | undefined {
  return /^[a-z0-9-]+(\.myshopify\.com)?$/.test(wert) ? undefined : "Shop-Kennung ohne Protokoll, z. B. mein-shop oder mein-shop.myshopify.com";
}

/** Arbeitsordner: Systemordner und das eigene Home-Verzeichnis sind tabu (dort würde chmod 700 oder die Sandbox stören). */
export function pruefeArbeitsordner(wert: string): string | undefined {
  const ohneTrenner = (p: string) => (p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p);
  const verboten = ["/", "/tmp", "/home", "/usr", "/etc", "/var", homedir()].map((p) => ohneTrenner(resolve(p)));
  return verboten.includes(ohneTrenner(resolve(wert))) ? "Systemordner oder Home-Verzeichnis sind als Arbeitsordner nicht erlaubt" : undefined;
}

// ---------- Schema (deckt jeden Schlüssel aus .env.example genau einmal ab) ----------

const anAus = pruefeWahl(["on", "off"]);

export const ABSCHNITTE: Abschnitt[] = [
  {
    name: "grundlagen",
    titel: "Grundlagen",
    beschreibung: "Name, Anrede und der Port des Dienstes. Braucht nichts weiter.",
    optional: false,
    felder: [
      { key: "NAME", frage: "Ihr Name", art: "text", standard: "Labinot" },
      { key: "JARVIS_ANREDE", frage: "Anrede durch Jarvis", hinweis: "wie im Film: Sir", art: "text", standard: "Sir" },
      { key: "JARVIS_FORM", frage: "Sie oder du", art: "wahl", wahl: ["sie", "du"], standard: "sie", pruefen: pruefeWahl(["sie", "du"]) },
      { key: "PORT", frage: "Port des Dienstes", art: "zahl", standard: "3000", pruefen: pruefePort },
      { key: "LISTEN_HOST", frage: "Lauschadresse", hinweis: "127.0.0.1 = nur lokal, 0.0.0.0 = im Heimnetz erreichbar (Home Assistant auf anderem Gerät)", art: "host", standard: "127.0.0.1", pruefen: pruefeHost },
    ],
  },
  {
    name: "claude",
    titel: "Claude (das Gehirn)",
    beschreibung: "Ohne API-Key läuft nichts. Modelle und Werkzeugrunden sind optional; leer = Standard.",
    optional: false,
    felder: [
      { key: "ANTHROPIC_API_KEY", frage: "API-Key", hinweis: "Claude Console → API Keys, beginnt mit sk-ant-", art: "geheim", pflicht: true, pruefen: pruefeApiKey },
      { key: "CLAUDE_MODEL", frage: "Standardmodell", hinweis: "leer = claude-sonnet-5-5", art: "text", pruefen: pruefeModell },
      { key: "CLAUDE_MODEL_STARK", frage: "Starkes Modell für «!» und Vorgänge", hinweis: "leer = claude-opus-5-5", art: "text", pruefen: pruefeModell },
      { key: "CLAUDE_MODEL_SEHEN", frage: "Günstiges Modell für Hintergrundarbeit", hinweis: "Kamera-Wachen, kurze Blicke", art: "text", standard: "claude-haiku-4-5-20251001", pruefen: pruefeModell },
      { key: "MAX_LOOPS", frage: "Werkzeugrunden pro Anfrage", art: "zahl", standard: "10", pruefen: pruefeZahl },
      { key: "MAX_LOOPS_STARK", frage: "Werkzeugrunden für schwere Aufgaben", art: "zahl", standard: "40", pruefen: pruefeZahl },
    ],
    checks: ["Claude-API"],
  },
  {
    name: "telegram",
    titel: "Telegram",
    beschreibung: "Die Zentrale: Befehle, Freigaben, PIN, Notaus. Braucht einen Bot von @BotFather und Ihre Chat-ID.",
    optional: false,
    felder: [
      { key: "TELEGRAM_BOT_TOKEN", frage: "Bot-Token", hinweis: "von @BotFather (/newbot)", art: "geheim", pflicht: true, pruefen: pruefeTelegramToken },
      { key: "TELEGRAM_CHAT_ID", frage: "Ihre Chat-ID", hinweis: "z. B. über @userinfobot; nur dieser Chat darf Jarvis steuern", art: "text", pflicht: true, pruefen: pruefeChatId },
    ],
    checks: ["Telegram"],
  },
  {
    name: "sicherheit",
    titel: "Sicherheit",
    beschreibung: "PIN für sensible Aufträge, Geheimnisse für /events und /notfall, Freigabe-Regeln. Tokens erzeuge ich auf Wunsch.",
    optional: false,
    felder: [
      { key: "JARVIS_PIN", frage: "PIN für sensible Aufträge", hinweis: "mindestens 4 Zeichen, kein Leerraum", art: "geheim", pflicht: true, pruefen: pruefePin },
      { key: "JARVIS_EVENT_TOKEN", frage: "Ereignis-Token für POST /events", hinweis: "Enter = bestehenden Token behalten, sonst erzeugen (wie openssl rand -hex 24); «-» = Endpunkt aus; neu erzeugen: erst «-», dann nochmals npm run setup -- --abschnitt sicherheit", art: "token", erzeugen: true },
      { key: "JARVIS_PANIC_TOKEN", frage: "Panik-Token für POST /notfall", hinweis: "Enter = bestehenden Token behalten, sonst erzeugen; «-» = Endpunkt aus; neu erzeugen: erst «-», dann nochmals npm run setup -- --abschnitt sicherheit", art: "token", erzeugen: true },
      { key: "JARVIS_COMMANDS", frage: "Shell-Befehle", hinweis: "freigabe = jeder Befehl braucht Ihr OK (empfohlen), auto = läuft direkt", art: "wahl", wahl: ["freigabe", "auto"], standard: "freigabe", pruefen: pruefeWahl(["freigabe", "auto"]) },
      { key: "EVENTS_VIA_TUNNEL", frage: "/events und /gesture auch über den Tunnel", hinweis: "off empfohlen (nur Heimnetz/Tailscale)", art: "wahl", wahl: ["off", "on"], standard: "off", pruefen: anAus },
      { key: "DASHBOARD", frage: "Dashboard unter /dashboard", hinweis: "nur Heimnetz/Tailscale, nutzt JARVIS_EVENT_TOKEN", art: "wahl", wahl: ["on", "off"], standard: "on", pruefen: anAus },
      { key: "ZAHLUNG_NUR_VORBEREITEN", frage: "Zahlungen nur vorbereiten, nie auslösen", hinweis: "on empfohlen", art: "wahl", wahl: ["on", "off"], standard: "on", pruefen: anAus },
    ],
    checks: ["Sicherheit"],
  },
  {
    name: "alexa",
    titel: "Alexa",
    beschreibung: "Jarvis per Sprache über einen eigenen Alexa-Skill. Braucht die Skill-ID aus der Developer Console und den Tunnel.",
    optional: true,
    felder: [
      { key: "ALEXA_SKILL_ID", frage: "Skill-ID", hinweis: "Developer Console, beginnt mit amzn1.ask.skill.", art: "text", pruefen: pruefeSkillId },
      { key: "ALEXA_VOICE", frage: "Andere Stimme", hinweis: "z. B. Hans; leer = Alexa-Stimme", art: "text" },
      { key: "ALEXA_BUDGET_MS", frage: "Wartezeit von Alexa auf eine Antwort (ms)", art: "zahl", standard: "6500", pruefen: pruefeZahl },
    ],
    checks: ["Alexa-Skill"],
  },
  {
    name: "whoop",
    titel: "WHOOP",
    beschreibung: "Recovery und Training fürs Morgenbriefing. Braucht eine App im WHOOP Developer Dashboard; verbunden wird danach mit npm run whoop:auth.",
    optional: true,
    felder: [
      { key: "WHOOP_CLIENT_ID", frage: "Client-ID", art: "text" },
      { key: "WHOOP_CLIENT_SECRET", frage: "Client-Secret", art: "geheim" },
    ],
    checks: ["WHOOP"],
  },
  {
    name: "wetter",
    titel: "Wetter",
    beschreibung: "Standort fürs Wetter im Briefing, in Dezimalgrad.",
    optional: true,
    felder: [
      { key: "LAT", frage: "Breitengrad", art: "zahl", standard: "47.52", pruefen: pruefeKoordinate(-90, 90) },
      { key: "LON", frage: "Längengrad", art: "zahl", standard: "7.65", pruefen: pruefeKoordinate(-180, 180) },
    ],
  },
  {
    name: "kalender",
    titel: "Kalender",
    beschreibung: "Google Kalender privat (Dienstkonto) und Outlook Arbeit (ICS-Link, erst nach Freigabe durch die IT).",
    optional: true,
    felder: [
      { key: "GOOGLE_KEY_FILE", frage: "Pfad zur Dienstkonto-Schlüsseldatei", hinweis: "z. B. service-account.json", art: "pfad" },
      { key: "GOOGLE_CALENDAR_ID", frage: "Kalender-ID", hinweis: "Google Kalender → Einstellungen, mit dem Dienstkonto geteilt", art: "text" },
      // geheim: wer den Link kennt, liest den Kalender – darum maskiert und ohne Echo
      { key: "OUTLOOK_ICS_URL", frage: "Outlook ICS-Link", hinweis: "nur mit Freigabe der IT; Eingabe wird nicht angezeigt", art: "geheim", pruefen: pruefeUrl },
      { key: "OUTLOOK_MODE", frage: "Outlook-Sichtbarkeit", hinweis: "busy = nur belegte Zeiten (empfohlen), details = auch Titel", art: "wahl", wahl: ["busy", "details"], standard: "busy", pruefen: pruefeWahl(["busy", "details"]) },
      { key: "BRIEFING_PREP_FROM", frage: "Briefing ab dieser Uhrzeit vorbereiten", hinweis: "HH:MM, z. B. 05:45", art: "zeit", standard: "05:45", pruefen: pruefeUhrzeit },
    ],
    checks: ["Google Kalender", "Outlook-Kalender"],
  },
  {
    name: "gmail",
    titel: "Gmail",
    beschreibung: "Mails lesen und Entwürfe vorbereiten. Braucht einen OAuth-Client (Desktop-App); verbunden wird danach mit npm run google:auth.",
    optional: true,
    felder: [
      { key: "GOOGLE_OAUTH_CLIENT_ID", frage: "OAuth Client-ID", art: "text" },
      { key: "GOOGLE_OAUTH_CLIENT_SECRET", frage: "OAuth Client-Secret", art: "geheim" },
    ],
    checks: ["Gmail"],
  },
  {
    name: "shopify",
    titel: "Shopify",
    beschreibung: "Bestellungen und Lager im Blick. Braucht eine Custom App im Shop-Admin.",
    optional: true,
    felder: [
      { key: "SHOPIFY_SHOP", frage: "Shop-Kennung", hinweis: "mein-shop oder mein-shop.myshopify.com", art: "text", pruefen: pruefeShop },
      { key: "SHOPIFY_TOKEN", frage: "Admin-API-Token", art: "geheim" },
      { key: "SHOPIFY_API_VERSION", frage: "API-Version", art: "text", standard: "2026-01" },
    ],
    checks: ["Shopify"],
  },
  {
    name: "homeassistant",
    titel: "Home Assistant",
    beschreibung: "Geräte schalten, Zustände lesen, Anwesenheit. Braucht einen langlebigen Zugriffstoken.",
    optional: true,
    felder: [
      { key: "HA_URL", frage: "URL", hinweis: "z. B. http://192.168.1.10:8123", art: "url", pruefen: pruefeUrl },
      { key: "HA_TOKEN", frage: "Zugriffstoken", hinweis: "Profil → langlebige Zugriffstoken", art: "geheim" },
      { key: "HA_AUTO_DOMAINS", frage: "Gerätetypen ohne Freigabe", hinweis: "kommagetrennt", art: "text", standard: "light,switch,media_player,fan,scene,climate" },
      { key: "HA_PRESENCE_ENTITY", frage: "Entität für «zu Hause»", hinweis: "z. B. person.labinot", art: "text" },
    ],
    checks: ["Home Assistant"],
  },
  {
    name: "kameras",
    titel: "Kameras",
    beschreibung: "Frigate zum Schauen, Melden und Wachen; MQTT optional für Live-Meldungen.",
    optional: true,
    felder: [
      { key: "FRIGATE_URL", frage: "Frigate-URL", hinweis: "z. B. http://192.168.1.20:5000", art: "url", pruefen: pruefeUrl },
      { key: "MQTT_URL", frage: "MQTT-URL", hinweis: "z. B. mqtt://192.168.1.10:1883; leer = über Home Assistant", art: "url", ohneEcho: true },
      { key: "MQTT_USER", frage: "MQTT-Benutzer", art: "text" },
      { key: "MQTT_PASSWORD", frage: "MQTT-Passwort", art: "geheim" },
    ],
    checks: ["Frigate", "MQTT"],
  },
  {
    name: "stimme",
    titel: "Stimme",
    beschreibung: "Sprachnachrichten verstehen und sprechen, OpenAI-kompatibel (Cloud oder lokal).",
    optional: true,
    felder: [
      { key: "STT_URL", frage: "Spracherkennung URL", hinweis: "z. B. https://api.openai.com/v1", art: "url", pruefen: pruefeUrl },
      { key: "STT_KEY", frage: "Spracherkennung Key", art: "geheim" },
      { key: "STT_MODEL", frage: "Spracherkennung Modell", art: "text", standard: "whisper-1" },
      { key: "TTS_URL", frage: "Sprachausgabe URL", art: "url", pruefen: pruefeUrl },
      { key: "TTS_KEY", frage: "Sprachausgabe Key", art: "geheim" },
      { key: "TTS_MODEL", frage: "Sprachausgabe Modell", art: "text", standard: "tts-1" },
      { key: "TTS_VOICE", frage: "Sprachausgabe Stimme", art: "text", standard: "onyx" },
    ],
    checks: ["Stimme (STT/TTS)"],
  },
  {
    name: "werkstatt",
    titel: "Werkstatt und Browser",
    beschreibung: "Browser, OpenSCAD, 3D-Drucker (OctoPrint), Arbeitsordner und Websuche.",
    optional: true,
    felder: [
      { key: "BROWSER_PATH", frage: "Pfad zu Chromium", hinweis: "leer = automatisch suchen", art: "pfad" },
      { key: "OPENSCAD_PATH", frage: "Pfad zu OpenSCAD", hinweis: "leer = automatisch suchen", art: "pfad" },
      { key: "OCTOPRINT_URL", frage: "OctoPrint-URL", art: "url", pruefen: pruefeUrl },
      { key: "OCTOPRINT_KEY", frage: "OctoPrint API-Key", art: "geheim" },
      { key: "JARVIS_WORKSPACE", frage: "Arbeitsordner für Code und Websites", art: "pfad", standard: "workspace", pruefen: pruefeArbeitsordner },
      { key: "WEB_SEARCH", frage: "Websuche über die Claude-API", art: "wahl", wahl: ["on", "off"], standard: "on", pruefen: anAus },
    ],
    checks: ["Browser", "Werkstatt", "3D-Drucker"],
  },
  {
    name: "proaktiv",
    titel: "Proaktivität",
    beschreibung: "Rückblick, Rechnungs- und Zielerinnerungen, Ton des Beraters.",
    optional: true,
    felder: [
      { key: "RUECKBLICK", frage: "Täglicher Rückblick um", hinweis: "HH:MM oder off", art: "zeit", standard: "22:30", pruefen: pruefeZeit },
      { key: "RECHNUNG_ERINNERUNG", frage: "Rechnungs-Erinnerung täglich um", hinweis: "HH:MM oder off", art: "zeit", standard: "08:30", pruefen: pruefeZeit },
      { key: "RECHNUNG_VORLAUF_TAGE", frage: "Vorlauf in Tagen vor Fälligkeit", art: "zahl", standard: "3", pruefen: pruefeZahl },
      { key: "ZIELCHECK", frage: "Wöchentlicher Zielcheck", hinweis: "z. B. so 18:00 oder off", art: "zeit", standard: "so 18:00", pruefen: pruefeZielcheck },
      { key: "BERATER_TON", frage: "Ton des Beraters", art: "wahl", wahl: ["sanft", "direkt", "hart"], standard: "direkt", pruefen: pruefeWahl(["sanft", "direkt", "hart"]) },
    ],
  },
];

/** Alle Schlüssel des Schemas in Reihenfolge der Abschnitte */
export function alleSchluessel(): string[] {
  return ABSCHNITTE.flatMap((a) => a.felder.map((f) => f.key));
}

// ---------- .env lesen und schreiben (Kommentare und Reihenfolge bleiben erhalten) ----------

export type EnvZeile = { art: "kommentar" | "leer"; text: string } | { art: "wert"; key: string; wert: string };

/**
 * Liest wie Nodes util.parseEnv: `export KEY=`, einfache/doppelte Anführungszeichen und Backticks,
 * `#`-Kommentare, mehrzeilige Werte in Anführungszeichen. In doppelten Anführungszeichen wird nur `\n` zum Zeilenumbruch.
 */
export function parseEnv(text: string): EnvZeile[] {
  const zeilen = text.split(/\r?\n/);
  if (zeilen.length && zeilen[zeilen.length - 1] === "") zeilen.pop();
  const aus: EnvZeile[] = [];
  for (let i = 0; i < zeilen.length; i++) {
    const roh = zeilen[i];
    const z = roh.trim();
    if (z === "") { aus.push({ art: "leer", text: roh }); continue; }
    const gleich = z.indexOf("=");
    if (z.startsWith("#") || gleich < 0) { aus.push({ art: "kommentar", text: roh }); continue; }
    const key = z.slice(0, gleich).replace(/^export\s+/, "").trim();
    // ohne Schlüssel (`=abc`): Node ignoriert die Zeile; hier bleibt sie als Text erhalten, zählt aber nicht als Wert
    if (key === "") { aus.push({ art: "kommentar", text: roh }); continue; }
    let rest = z.slice(gleich + 1).trim();
    const q = rest[0];
    if (q === '"' || q === "'" || q === "`") {
      // mehrzeilig: erst vorausschauen, Folgezeilen nur übernehmen, wenn ein schliessendes Zeichen existiert
      let kandidat = rest;
      let ende = kandidat.indexOf(q, 1);
      let j = i;
      while (ende < 0 && j + 1 < zeilen.length) {
        kandidat += "\n" + zeilen[++j];
        ende = kandidat.indexOf(q, 1);
      }
      if (ende >= 0) {
        i = j;
        const inner = kandidat.slice(1, ende);
        aus.push({ art: "wert", key, wert: q === '"' ? inner.replace(/\\n/g, "\n") : inner });
        continue;
      }
      // kein schliessendes Zeichen bis Dateiende: nur diese Zeile wörtlich, wie Node; Folgezeilen bleiben eigene Schlüssel
      aus.push({ art: "wert", key, wert: rest });
      continue;
    }
    const hash = rest.indexOf("#");
    aus.push({ art: "wert", key, wert: (hash >= 0 ? rest.slice(0, hash) : rest).trim() });
  }
  return aus;
}

/**
 * Schreibweise, die Nodes Parser exakt zurückliest: leer → ``; ohne Sonderzeichen roh; sonst doppelt gequotet
 * (nur Zeilenumbruch wird zu `\n`; ein `"` oder `\` ist dort nicht darstellbar, weil Node keine Escapes kennt),
 * dann einfach gequotet (wörtlich), dann Backticks (wörtlich).
 */
export function quoteWert(wert: string): string {
  if (wert === "") return "";
  if (!/[\s#"'\\$`]/.test(wert)) return wert;
  if (!wert.includes('"') && !wert.includes("\\")) return `"${wert.replace(/\r?\n/g, "\\n")}"`;
  if (!wert.includes("'")) return `'${wert}'`;
  if (!wert.includes("`")) return `\`${wert}\``;
  throw new Error("Wert nicht darstellbar: enthält \", ' und ` zugleich");
}

export function serialisiereEnv(zeilen: EnvZeile[]): string {
  return zeilen.map((z) => (z.art === "wert" ? `${z.key}=${quoteWert(z.wert)}` : z.text)).join("\n") + "\n";
}

/** Struktur aus .env.example; vorhandene Werte aus .env gewinnen; nur in .env bekannte Schlüssel werden am Ende angehängt. */
export function ladeEnv(beispielPfad: string, envPfad: string): EnvZeile[] {
  const zeilen = parseEnv(readFileSync(beispielPfad, "utf8"));
  if (!existsSync(envPfad)) return zeilen;
  const vorhanden = parseEnv(readFileSync(envPfad, "utf8")).filter((z): z is Extract<EnvZeile, { art: "wert" }> => z.art === "wert");
  const bekannt = new Set(zeilen.filter((z) => z.art === "wert").map((z) => (z as { key: string }).key));
  for (const v of vorhanden) {
    if (bekannt.has(v.key)) {
      setzeWert(zeilen, v.key, v.wert);
      continue;
    }
    if (!zeilen.some((z) => z.art === "kommentar" && z.text === "# --- Eigene Einträge ---")) {
      zeilen.push({ art: "leer", text: "" }, { art: "kommentar", text: "# --- Eigene Einträge ---" });
    }
    zeilen.push({ art: "wert", key: v.key, wert: v.wert });
    bekannt.add(v.key);
  }
  return zeilen;
}

export function setzeWert(zeilen: EnvZeile[], key: string, wert: string): void {
  const z = zeilen.find((x) => x.art === "wert" && x.key === key);
  if (z && z.art === "wert") z.wert = wert;
  else zeilen.push({ art: "wert", key, wert });
}

export function holeWert(zeilen: EnvZeile[], key: string): string | undefined {
  const z = zeilen.find((x) => x.art === "wert" && x.key === key);
  return z && z.art === "wert" ? z.wert : undefined;
}

/**
 * Bestehende Datei zuerst nach `<pfad>.bak` sichern (0o600), dann atomar schreiben (tmp + rename, 0o600).
 * `ohneSicherung` lässt eine bereits in diesem Lauf angelegte Sicherung unangetastet.
 */
export function schreibeEnv(pfad: string, zeilen: EnvZeile[], optionen: { ohneSicherung?: boolean } = {}): { sicherung?: string } {
  const text = serialisiereEnv(zeilen); // vor dem Sichern: ein nicht darstellbarer Wert darf nichts anfassen
  let sicherung: string | undefined;
  if (existsSync(pfad) && !optionen.ohneSicherung) {
    sicherung = `${pfad}.bak`;
    copyFileSync(pfad, sicherung);
    chmodSync(sicherung, 0o600);
  }
  const tmp = `${pfad}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, pfad);
  chmodSync(pfad, 0o600);
  return sicherung ? { sicherung } : {};
}

/** Entspricht `openssl rand -hex 24` */
export function erzeugeToken(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

export function maskiere(wert: string): string {
  // Kurze Geheimnisse (PINs, kurze Passwörter) ganz verbergen; nur lange Schlüssel zeigen Anfang und Ende zur Wiedererkennung.
  return wert.length <= 12 ? "••••" : `${wert.slice(0, 4)}…${wert.slice(-2)}`;
}

/** Bestehenden Wert für die Konsole aufbereiten: Geheimnisse, Tokens und URLs mit Passwort (mqtt://user:pass@host) nur maskiert. */
export function anzeigeBestehend(feld: Feld, wert: string | undefined): string | undefined {
  if (!wert) return undefined;
  if (feld.art === "geheim" || feld.art === "token") return maskiere(wert);
  try {
    if (new URL(wert).password) return maskiere(wert);
  } catch {
    // keine URL
  }
  return wert;
}

/**
 * Eingabe getrimmt; '' → bestehend, sonst erzeugter Token (art token mit erzeugen) oder Standard;
 * '-' → bewusst leeren; sonst pruefen(). Pflichtfeld ohne Wert → Fehler.
 */
export function entscheideWert(eingabe: string, bestehend: string | undefined, feld: Feld): { wert?: string; fehler?: string; erzeugt?: boolean } {
  const e = eingabe.trim();
  if (e === "-") return feld.pflicht ? { fehler: "Pflichtwert, kann nicht geleert werden" } : { wert: "" };
  if (e === "") {
    if (bestehend) return { wert: bestehend };
    if (feld.erzeugen) return { wert: erzeugeToken(), erzeugt: true };
    if (feld.standard) return { wert: feld.standard };
    return feld.pflicht ? { fehler: "Pflichtwert, bitte eingeben" } : { wert: "" };
  }
  const fehler = feld.pruefen?.(e);
  return fehler ? { fehler } : { wert: e };
}

/** Hinweise nach der Einrichtung; `state` ist der Inhalt von data/state.json (Tokens aus whoop:auth / google:auth). */
export function naechsteSchritte(zeilen: EnvZeile[], state: { whoop?: unknown; google?: unknown }, sicherung?: string): string[] {
  const s: string[] = [];
  if (!holeWert(zeilen, "ANTHROPIC_API_KEY")) s.push("ANTHROPIC_API_KEY fehlt noch – ohne Key startet Jarvis nicht (npm run setup -- --abschnitt claude).");
  if (holeWert(zeilen, "WHOOP_CLIENT_ID") && !state.whoop) s.push("WHOOP verbinden: npm run whoop:auth");
  if (holeWert(zeilen, "GOOGLE_OAUTH_CLIENT_ID") && !state.google) s.push("Gmail verbinden: npm run google:auth");
  s.push("Dienst neu starten: sudo systemctl restart jarvis, dann journalctl -u jarvis -f beobachten.");
  if (sicherung) s.push(`Die alte Konfiguration liegt in ${sicherung} – löschen, sobald nicht mehr nötig.`);
  return s;
}
