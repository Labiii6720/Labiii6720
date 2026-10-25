import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer as netServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Gemeinsame Demo-Daten für den UI-Test und die visuelle Abnahme der Kommandozentrale. Alles erfunden (ausser «Labinot»
 * und «Sir»), nur in einem Temp-Ordner. Dateinamen und Felder wie in queue.ts, claude.ts, finanzen.ts, zeitplaene.ts,
 * cameras.ts, protokolle.ts, profil.ts, vorgaenge.ts, audit.ts und state.ts.
 */

const projekt = resolve(import.meta.dirname, "..", "..");

/** Nur für Test und Abnahme – nie in einer echten .env verwenden. */
export const DEMO_TOKEN = "demo-token-kommandozentrale-nur-attrappe-0123456789";
export const DEMO_PIN = "4711";
/** Steht in jeder Auftrags-Eingabe (input): darf nie im Dashboard auftauchen. */
export const DEMO_INPUT_MARKE = "GEHEIMER-INPUT-NIE-ZEIGEN";
/** Steht als IBAN/Referenz in den Rechnungen: darf nie im Dashboard auftauchen. */
export const DEMO_IBAN = "CH93 0076 2011 6238 5295 7";
export const DEMO_XSS = "<img src=x onerror=alert(1)>";

const MIN = 60_000;
const TAG = 86_400_000;
const tagZ = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Europe/Zurich" });
const json = (datei: string, wert: unknown) => writeFileSync(datei, JSON.stringify(wert, null, 2), { mode: 0o600 });

/** Legt die Demo-Daten in `ordner` an (data/ mit 0700). `jetzt` steuert alle relativen Zeiten. */
export function legeDemoAn(ordner: string, jetzt: Date = new Date()): void {
  const data = join(ordner, "data");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const vor = (ms: number) => new Date(jetzt.getTime() - ms).toISOString();
  const tagIn = (tage: number) => tagZ(new Date(jetzt.getTime() + tage * TAG));
  const input = (extra: Record<string, unknown> = {}) => ({ notiz: DEMO_INPUT_MARKE, ...extra });

  // Aufträge: drei offen (extern, sensibel, einer läuft), Historie mit allen Status; einer mit eingeschleustem HTML
  const roh: [number, number, string, "extern" | "sensibel", string, "offen" | "erledigt" | "abgelehnt" | "fehler", string?][] = [
    [190, 2 * TAG + 300 * MIN, "browser_oeffnen", "extern", "Fahrplan SBB Bern–Zürich für morgen 06:30 suchen", "abgelehnt"],
    [191, 2 * TAG + 120 * MIN, "geraet_schalten", "extern", "Wohnzimmerlicht auf 30 % (light.wohnzimmer)", "erledigt", "light.wohnzimmer → on, brightness 30 %"],
    [192, 2 * TAG + 30 * MIN, "gmail_senden", "extern", "Bestellung bei einem Elektronikhändler bestätigen", "fehler", "Gmail: 429 Too Many Requests – nicht wiederholt (Nebenwirkung)."],
    [193, TAG + 400 * MIN, "shell", "sensibel", "git pull im Arbeitsordner «esphome-satellit»", "erledigt", "Already up to date."],
    [194, TAG + 200 * MIN, "kalender_eintragen", "extern", "Termin «Zahnarzt» am Donnerstag 07:30", "abgelehnt"],
    [195, TAG + 60 * MIN, "protokoll_ausfuehren", "sensibel", "Protokoll «nacht»: abschliessen, Alarm scharf, Licht aus", "erledigt", "3 von 3 Schritten ausgeführt."],
    [196, 300 * MIN, "gmail_senden", "extern", `Antwort an Hauswart ${DEMO_XSS} mit Terminvorschlag`, "erledigt", `Gesendet. ${DEMO_XSS} Message-ID 18f3…`],
    [197, 230 * MIN, "shell", "sensibel", "npm run build im Arbeitsordner «angebot-garage»", "fehler", "Exit 1: Cannot find module './vorlage.js' (Zeile 12)."],
    [198, 150 * MIN, "zeitplan_erstellen", "extern", "Zeitplan «NVR-Sicherung prüfen» Mo und Do 21:00", "erledigt", "Zeitplan #3 angelegt."],
    [199, 95 * MIN, "geraet_schalten", "extern", "Werkstattlicht ausschalten (light.werkstatt)", "erledigt", "light.werkstatt → off"],
  ];
  const auftraege = [
    ...roh.map(([id, ms, tool, stufe, summary, status, result]) => ({ id, createdAt: vor(ms), tool, input: input(), stufe, summary, status, ...(result ? { result } : {}) })),
    { id: 200, createdAt: vor(14 * MIN), tool: "shopify_lager", input: input({ menge: 12 }), stufe: "extern", summary: "Shopify: Lagerbestand «PoE-Injektor 30 W» von 4 auf 12 setzen", status: "offen", gestartetAm: vor(3 * MIN) },
    { id: 201, createdAt: vor(11 * MIN), tool: "gmail_senden", input: input({ an: "hauswart@beispiel.invalid" }), stufe: "extern", summary: `E-Mail an den Hauswart: Termin Heizungsablesung bestätigen ${DEMO_XSS}`, status: "offen" },
    { id: 202, createdAt: vor(4 * MIN), tool: "geraet_schalten", input: input({ entity: "lock.haustuer" }), stufe: "sensibel", summary: "Haustür für 5 Minuten entriegeln (lock.haustuer)", status: "offen" },
  ];
  json(join(data, "auftraege.json"), auftraege);

  // Verbrauch: 40 Tage bis heute (über den Monatswechsel), deterministisch
  const usage: Record<string, { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }> = {};
  for (let i = 39; i >= 0; i--) {
    const f = 0.6 + ((i * 37) % 11) / 10;
    usage[tagZ(new Date(jetzt.getTime() - i * TAG))] = {
      calls: Math.round(20 + f * 25), input: Math.round(40_000 * f), output: Math.round(18_000 * f), cacheRead: Math.round(260_000 * f), cacheWrite: Math.round(30_000 * f),
    };
  }
  json(join(data, "usage.json"), usage);

  // Rechnungen: CHF und EUR, überfällig, bald fällig, bezahlt; IBAN/Referenz dürfen nie ins Dashboard
  const rechnung = (id: number, empfaenger: string, betrag: number, waehrung: string, faellig: string, status: "offen" | "bezahlt", bezahltAm?: string) => ({
    id, erkanntAm: vor(20 * TAG), quelle: `demo-${id}`, empfaenger, betrag, waehrung, iban: DEMO_IBAN, referenz: `RF18 5390 0754 7034 ${id}`, faellig, status, ...(bezahltAm ? { bezahltAm } : {}),
  });
  json(join(data, "rechnungen.json"), [
    rechnung(38, "Krankenkasse Prämie Oktober", 412.5, "CHF", tagIn(-11), "offen"),
    rechnung(41, "Internet Oktober", 79.9, "CHF", tagIn(-6), "offen"),
    rechnung(43, "Garage – Service", 1284.6, "CHF", tagIn(3), "offen"),
    rechnung(44, "Steuerverwaltung – Rate 4", 1150, "CHF", tagIn(5), "offen"),
    rechnung(46, "Elektronik-Versand", 289.4, "EUR", tagIn(4), "offen"),
    rechnung(40, "Mobilfunk", 64.9, "CHF", tagIn(-5), "bezahlt", tagIn(-5)),
    rechnung(42, "Nebenkosten 2025/26", 640, "CHF", tagIn(-3), "bezahlt", tagIn(-3)),
    rechnung(30, "Versicherung Hausrat", 318.2, "CHF", tagIn(-40), "bezahlt", tagIn(-41)),
    rechnung(25, "Werkzeughandel", 118, "EUR", tagIn(-70), "bezahlt", tagIn(-72)),
  ]);

  json(join(data, "zeitplaene.json"), [
    { id: 1, name: "Morgenbriefing", zeit: "06:45", tage: "werktags", auftrag: "Briefing mit Wetter, Kalender und offenen Freigaben vorlesen.", lastRun: tagIn(-1), angelegt: vor(30 * TAG) },
    { id: 2, name: "Wochenende gemütlich", zeit: "08:30", tage: "sa,so", auftrag: "Kurzes Briefing ohne Arbeitstermine.", angelegt: vor(20 * TAG) },
    { id: 3, name: "NVR-Sicherung prüfen", zeit: "21:00", tage: "mo,do", auftrag: "Prüfe, ob die nächtliche Sicherung des NVR durchgelaufen ist, und melde nur Abweichungen.", angelegt: vor(150 * MIN) },
  ]);

  json(join(ordner, "cameras.json"), {
    eingang: { frigate: "eingang", beschreibung: "Hauseingang aussen, Briefkasten", wachen: [{ frage: "Liegt ein Paket vor der Tür?", alle_minuten: 30, nur_wenn: "abwesend", ruhe_minuten: 120 }] },
    werkstatt: { frigate: "werkstatt", beschreibung: "Werkbank und 3D-Drucker" },
  });
  json(join(data, "wachen.json"), [
    { id: 1, kamera: "werkstatt", frage: "Hat sich das Druckteil vom Bett gelöst?", alle_minuten: 10, nur_wenn: "immer", ruhe_minuten: 30, quelle: "chat" },
    { id: 2, kamera: "eingang", frage: "Steht jemand länger als eine Minute vor der Tür?", alle_minuten: 20, nur_wenn: "nacht", quelle: "dashboard" },
  ]);

  json(join(ordner, "protokolle.json"), {
    nacht: { beschreibung: "Abschliessen, Licht aus, Alarm scharf, Modus Nacht", stufe: "sensibel", schritte: [{ modus: "nacht" }] },
    abwesend: { beschreibung: "Alles aus, Alarm scharf, Kameras melden", stufe: "extern", schritte: [{ nachricht: "Abwesend." }] },
    werkstatt: { beschreibung: "Licht und Werkbank an, Fokus", stufe: "auto", schritte: [{ modus: "fokus" }] },
  });

  json(join(data, "profil.json"), {
    ziele: [
      { id: 1, text: "Herstellerzertifizierung Videomanagement abschliessen", frist: tagIn(65), status: "offen", angelegt: vor(40 * TAG) },
      { id: 2, text: "10 km unter 50 Minuten", frist: "<b>x</b>", status: "offen", angelegt: vor(10 * TAG) },
    ],
    werte: ["Ehrlich vor bequem"], muster: [], entscheidungen: [], fakten: [], chronik: [],
  });

  json(join(data, "vorgaenge.json"), [
    { id: 57, auftrag: "Hauswart wegen Heizungsablesung antworten", status: "fertig", startedAt: vor(40 * MIN), finishedAt: vor(38 * MIN), steps: 2, result: "Entwurf als Auftrag #201." },
    { id: 58, auftrag: "Angebot Kamera-Nachrüstung Garage zusammenstellen", status: "fehler", startedAt: vor(5 * 60 * MIN), finishedAt: vor(4 * 60 * MIN), steps: 4, result: "Vorlage fehlt." },
  ]);

  const audit = [
    { ts: vor(TAG + 200 * MIN), event: "zeitplan_angelegt", id: 3, name: "NVR-Sicherung prüfen", zeit: "21:00", tage: "mo,do", quelle: "dashboard" },
    { ts: vor(TAG + 60 * MIN), event: "pause", quelle: "telegram" },
    { ts: vor(TAG + 50 * MIN), event: "weiter", quelle: "telegram" },
    { ts: vor(95 * MIN), event: "auftrag_freigabe", id: 199, tool: "geraet_schalten", status: "erledigt", quelle: "telegram" },
    { ts: vor(60 * MIN), event: "modus", modus: "normal", quelle: "dashboard" },
    { ts: vor(14 * MIN), event: "auftrag_angelegt", id: 200, tool: "shopify_lager", stufe: "extern" },
    { ts: vor(11 * MIN), event: "auftrag_angelegt", id: 201, tool: "gmail_senden", stufe: "extern", hinweis: DEMO_XSS },
    { ts: vor(4 * MIN), event: "auftrag_angelegt", id: 202, tool: "geraet_schalten", stufe: "sensibel" },
  ];
  writeFileSync(join(data, "audit.log"), audit.map((z) => JSON.stringify(z)).join("\n") + "\n{kaputte Zeile\n", { mode: 0o600 });

  json(join(data, "state.json"), { mode: "normal", paused: false });
}

/** Frigate-Attrappe (127.0.0.1, Port 0): liefert für jedes Standbild ein kleines gültiges JPEG. */
export async function starteFrigateAttrappe(): Promise<{ port: number; url: string; abrufe: string[]; schliessen: () => Promise<void> }> {
  // kleines graues 16:9-JPEG (160×90), gültig für jeden Browser
  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//" +
      "2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCABaAKADASIAAhEBAxEB/8QA" +
      "HwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK" +
      "FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG" +
      "x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC" +
      "AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE" +
      "hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDJoptFMQ6i" +
      "m0UAOoptFADqKbRQA6im0UAOoptFADqKbRQA6im0UAOoptFADqKbRQAlFJRQAtFJRQAtWPs3+3+lVq0KAIPs3+3+lH2b/b/Sp6KAIPs3+3+lH2b/AG/0qeig" +
      "CD7N/t/pR9m/2/0qeigCD7N/t/pR9m/2/wBKnooAg+zf7f6VAw2sR6HFXqoyf6xvqaAEopKKAFopKKAEoptFADqKbRQA6tGsytOgAooooAKKKKACiiigAooo" +
      "oAKoSf61/wDeNX6z5f8AWv8A7xoASim0UAOoptFACUUlFAC0UlFAC1qVlVq0AFFFFABRRRQAUUUUAFFFFABWdL/rX/3jWjWbL/rn/wB40ANopKKAFopKKAEo" +
      "ptFADqKbRQA6tasetigAooooAKKKKACiiigAooooAKy5v9c/+8a1Kypv9c/+8f50AJRTaKAHUU2igBKKSigBaKSigBaf50v/AD0f/vo1HRQBJ50v/PR/++jR" +
      "50v/AD0f/vo1HRQBJ50v/PR/++jR50v/AD0f/vo1HRQBJ50v/PR/++jR50v/AD0f/vo1HRQBJ50v/PR/++jR50v/AD0f/vo1HRQBJ50v/PR/++jTSSTk8k02" +
      "igBaKSigBaKSigD/2Q==",
    "base64",
  );
  const abrufe: string[] = [];
  const server = httpServer((req, res) => {
    abrufe.push(req.url ?? "");
    if (/^\/api\/[^/]+\/latest\.jpg/.test(req.url ?? "")) {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": jpeg.length });
      res.end(jpeg);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("[]");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const adresse = server.address();
  const port = typeof adresse === "object" && adresse ? adresse.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    abrufe,
    schliessen: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

export const freierPort = () =>
  new Promise<number>((ok, fehler) => {
    const s = netServer();
    s.once("error", fehler);
    s.listen(0, "127.0.0.1", () => {
      const adresse = s.address();
      const port = typeof adresse === "object" && adresse ? adresse.port : 0;
      s.close(() => ok(port));
    });
  });

export interface DemoDienst { port: number; url: string; token: string; ausgabe: () => string; stoppen: () => Promise<void> }

/**
 * Startet src/server.ts als Kindprozess im Demo-Ordner: ohne .env des Projekts, ohne Telegram-, Claude- oder
 * Google-Schlüssel. Eine fetch-Attrappe lässt nur die Frigate-Attrappe durch; zusätzlich zeigt der Proxy ins Leere.
 */
export async function starteDemoDienst(o: { ordner: string; frigateUrl?: string; port?: number; startFristMs?: number }): Promise<DemoDienst> {
  const port = o.port ?? (await freierPort());
  const erlaubt = o.frigateUrl ? new URL(o.frigateUrl).origin : "";
  const attrappe = join(o.ordner, "fetch-attrappe.mjs");
  writeFileSync(
    attrappe,
    `const echt = globalThis.fetch;\nconst erlaubt = ${JSON.stringify(erlaubt)};\n` +
      `globalThis.fetch = async (eingabe, init) => {\n` +
      `  const url = new URL(typeof eingabe === "string" || eingabe instanceof URL ? String(eingabe) : eingabe.url);\n` +
      `  if (erlaubt && url.origin === erlaubt) return echt(eingabe, init);\n` +
      `  throw new TypeError("fetch failed: kein Netz in der Demo");\n};\n`,
  );
  const kind: ChildProcess = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(attrappe).href, join(projekt, "src/server.ts")], {
    cwd: o.ordner,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: o.ordner,
      PORT: String(port),
      LISTEN_HOST: "127.0.0.1",
      JARVIS_EVENT_TOKEN: DEMO_TOKEN,
      JARVIS_PIN: DEMO_PIN,
      ...(o.frigateUrl ? { FRIGATE_URL: o.frigateUrl } : {}),
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ausgabe = "";
  kind.stdout?.on("data", (d: Buffer) => (ausgabe += d.toString()));
  kind.stderr?.on("data", (d: Buffer) => (ausgabe += d.toString()));
  // Nur Obergrenze: kalter tsx-Cache, parallele Testdateien oder der Pi brauchen deutlich mehr als einige Sekunden
  const wunsch = Number(process.env.JARVIS_TEST_STARTFRIST_MS);
  const startfrist = o.startFristMs ?? (Number.isFinite(wunsch) && wunsch > 0 ? wunsch : 30_000);
  await new Promise<void>((ok, fehler) => {
    const warte = setInterval(() => {
      if (!ausgabe.includes("Jarvis läuft")) return;
      clearInterval(warte);
      clearTimeout(frist);
      kind.removeAllListeners("exit");
      ok();
    }, 20);
    const frist = setTimeout(() => {
      clearInterval(warte);
      kind.removeAllListeners("exit");
      kind.kill("SIGKILL");
      fehler(new Error(`Demo-Dienst nicht gestartet:\n${ausgabe}`));
    }, startfrist);
    kind.once("exit", (code) => { clearInterval(warte); clearTimeout(frist); fehler(new Error(`Demo-Dienst beendet (${code}):\n${ausgabe}`)); });
  });
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    token: DEMO_TOKEN,
    ausgabe: () => ausgabe,
    stoppen: () =>
      new Promise<void>((ok) => {
        if (kind.exitCode !== null || kind.signalCode !== null) return ok();
        kind.once("exit", () => ok());
        kind.kill("SIGKILL");
      }),
  };
}
