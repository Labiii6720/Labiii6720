/**
 * Einrichtungs-Assistent:  npm run setup
 * Führt durch die .env, erzeugt Tokens, prüft jede Anbindung sofort (scripts/check.ts im Kindprozess).
 *
 *   --ohne-pruefung      keine Prüfungen nach den Abschnitten und am Ende
 *   --abschnitt <name>   nur diesen Abschnitt (z. B. telegram)
 *   --alle               optionale Abschnitte ohne Rückfrage durchgehen
 *   --env <pfad>         Ziel (Standard .env), --beispiel <pfad> Vorlage (Standard .env.example)
 *   --hilfe
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ABSCHNITTE, alleSchluessel, anzeigeBestehend, entscheideWert, holeWert, ladeEnv, naechsteSchritte, parseEnv, quoteWert, schreibeEnv, setzeWert,
  type Abschnitt, type EnvZeile, type Feld,
} from "../src/setup.js";

// ---------- Argumente ----------

interface Optionen {
  ohnePruefung: boolean;
  abschnitt?: string;
  alle: boolean;
  env: string;
  beispiel: string;
}

function hilfe(): string {
  return [
    "JARVIS – Einrichtung:  npm run setup [-- Optionen]",
    "  --ohne-pruefung      keine Prüfungen nach den Abschnitten und am Ende",
    "  --abschnitt <name>   nur diesen Abschnitt: " + ABSCHNITTE.map((a) => a.name).join(", "),
    "  --alle               optionale Abschnitte ohne Rückfrage durchgehen",
    "  --env <pfad>         Zieldatei (Standard .env)",
    "  --beispiel <pfad>    Vorlage (Standard .env.example)",
    "  --hilfe              diese Übersicht",
  ].join("\n");
}

function parseArgs(argv: string[]): Optionen | "hilfe" {
  const o: Optionen = { ohnePruefung: false, alle: false, env: ".env", beispiel: ".env.example" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const wert = () => {
      const w = argv[++i];
      if (w === undefined) throw new Error(`Option ${a} braucht einen Wert`);
      return w;
    };
    if (a === "--ohne-pruefung") o.ohnePruefung = true;
    else if (a === "--alle") o.alle = true;
    else if (a === "--abschnitt") o.abschnitt = wert().toLowerCase();
    else if (a === "--env") o.env = wert();
    else if (a === "--beispiel") o.beispiel = wert();
    else if (a === "--hilfe" || a === "-h" || a === "--help") return "hilfe";
    else throw new Error(`Unbekannte Option: ${a} (--hilfe zeigt alle)`);
  }
  if (o.abschnitt && !ABSCHNITTE.some((x) => x.name === o.abschnitt)) {
    throw new Error(`Unbekannter Abschnitt «${o.abschnitt}». Bekannt: ${ABSCHNITTE.map((x) => x.name).join(", ")}`);
  }
  return o;
}

// ---------- Ein- und Ausgabe ----------

const tty = process.stdin.isTTY === true;
let stumm = false;
/** Bei TTY werden Eingaben für Geheimnisse über diesen Ausgang verschluckt (readline echot selbst). */
const ausgang = new Writable({
  write(chunk, _enc, cb) {
    if (!stumm) process.stdout.write(chunk);
    cb();
  },
});
// historySize 0: keine Historie, sonst holt Pfeil-hoch ein stumm eingegebenes Geheimnis sichtbar zurück
const rl = createInterface({ input: process.stdin, output: ausgang, terminal: tty, historySize: 0 });

/** Eigene Zeilen-Warteschlange: gepipte Eingaben kommen auch an, wenn gerade keine Frage offen ist. */
const puffer: string[] = [];
let warter: ((z: string | null) => void) | undefined;
let eingabeZu = false;
rl.on("line", (z) => {
  if (warter) { const w = warter; warter = undefined; w(z); } else puffer.push(z);
});
rl.on("close", () => {
  eingabeZu = true;
  warter?.(null);
  warter = undefined;
});

function sag(text = ""): void {
  process.stdout.write(text + "\n");
}

/** Liest eine Zeile; null = Eingabe beendet (EOF). Bei `geheim` ohne Echo am Terminal. */
async function frage(prompt: string, geheim = false): Promise<string | null> {
  rl.setPrompt(prompt); // readline kennt den Prompt und zeichnet ihn nach Backspace/Pfeiltasten korrekt neu
  // Geheimnis am Terminal: Echo schon vor dem Prompt aus, sonst zeichnet readline einen vorausgetippten Rest sichtbar mit
  if (tty && geheim) { stumm = true; rl.prompt(); process.stdout.write(prompt); }
  else if (tty) rl.prompt();
  else process.stdout.write(prompt);
  let z: string | null;
  const vorab = puffer.length > 0;
  if (vorab) z = puffer.shift()!;
  else if (eingabeZu) z = null;
  else z = await new Promise<string | null>((r) => { warter = r; });
  if (tty && geheim) {
    stumm = false;
    process.stdout.write("\n");
    if (vorab) sag("  (vorab eingegebene Zeile übernommen)");
  } else if (!tty) process.stdout.write("\n"); // gepipte Eingabe echot nicht
  return z;
}

class Abbruch extends Error {}

async function frageOderAbbruch(prompt: string, geheim = false): Promise<string> {
  const z = await frage(prompt, geheim);
  if (z === null) throw new Abbruch("Eingabe beendet");
  return z;
}

/** `endeIstNein`: Eingabe zu Ende (EOF) gilt als Nein statt als Abbruch – für Rückfragen nach dem Speichern. */
async function jaNein(prompt: string, endeIstNein = false): Promise<boolean> {
  const z = endeIstNein ? await frage(`${prompt} [j/N] `) : await frageOderAbbruch(`${prompt} [j/N] `);
  if (z === null) return false;
  const a = z.trim().toLowerCase();
  return a === "j" || a === "ja" || a === "y";
}

// ---------- Felder ----------

/** Fragt ein Feld ab; liefert den neuen Wert oder undefined (Wert behalten). */
async function frageFeld(feld: Feld, bestehend: string | undefined): Promise<string | undefined> {
  if (feld.hinweis) sag(`  ${feld.hinweis}`);
  const anzeige = anzeigeBestehend(feld, bestehend);
  const zusatz = anzeige
    ? `${bestehend === feld.standard ? "Vorschlag" : "bestehend"}: ${anzeige}`
    : feld.erzeugen ? "Enter: erzeugen" : feld.standard ? `Vorschlag: ${feld.standard}` : feld.pflicht ? "Pflicht" : "leer";
  const wahl = feld.wahl ? ` (${feld.wahl.join("/")})` : "";
  // ohne Echo nur bei Geheimnissen, Tokens, maskiert angezeigten Werten und Feldern mit ohneEcho (MQTT_URL: mqtt://user:pass@host);
  // andere URLs sichtbar tippen, damit ein Zahlendreher in der Adresse auffällt
  const geheim = feld.art === "geheim" || feld.art === "token" || feld.ohneEcho === true || (anzeige !== undefined && anzeige !== bestehend);
  for (let versuch = 1; versuch <= 3; versuch++) {
    const eingabe = await frageOderAbbruch(`  ${feld.key} – ${feld.frage}${wahl} [${zusatz}]: `, geheim);
    const e = entscheideWert(eingabe, bestehend, feld);
    let fehler = e.fehler;
    if (!fehler && e.wert !== undefined) {
      try { quoteWert(e.wert); } catch (err) { fehler = (err as Error).message; }
    }
    if (fehler) {
      sag(`  ✗ ${fehler}${versuch < 3 ? ", bitte nochmals." : "."}`);
      continue;
    }
    if (e.erzeugt && e.wert) {
      sag(`  ✓ Erzeugt: ${e.wert}`);
      sag("    Jetzt in Home Assistant bzw. im Kurzbefehl eintragen – ich zeige ihn nicht nochmals an.");
    }
    return e.wert;
  }
  sag(`  Ich behalte den bisherigen Wert von ${feld.key}${bestehend ? "" : " (leer)"}, Sir. Später: npm run setup -- --abschnitt …`);
  return undefined;
}

// ---------- Prüfungen im Kindprozess ----------

const projekt = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Laufende Prüfung – wird bei Strg-C mit beendet, sonst liefe sie verwaist mit den eben eingegebenen Geheimnissen weiter. */
let laufendesKind: ChildProcess | undefined;
/** Zeitlimit einer Abschnittsprüfung (Vorgabe) */
const ZEITLIMIT_ABSCHNITT_MS = 60_000;
/**
 * Zeitlimit des Abschluss-Selbsttests: alle Prüfungen laufen nacheinander mit eigenem Timeout (Claude-API 15 s ohne
 * SDK-Wiederholungen, Telegram/HA/Frigate/OctoPrint je 10 s, MQTT 8 s). Hängen mehrere Dienste, reichen 60 s nicht für ein Ergebnis.
 */
const ZEITLIMIT_SELBSTTEST_MS = 180_000;

/**
 * Lässt scripts/check.ts mit --nur im Kindprozess laufen (liest die frische .env). Liefert true bei mindestens einem Fehler.
 * `zeitlimitMs`: danach wird das Kind beendet und die Prüfung als abgebrochen gemeldet.
 */
function pruefeImKind(wurzel: string, envPfad: string, nur?: string[], zeitlimitMs = ZEITLIMIT_ABSCHNITT_MS): Promise<boolean> {
  return new Promise((fertig) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of alleSchluessel()) delete env[k];
    const args = ["--import", import.meta.resolve("tsx"), join(projekt, "scripts", "check.ts")];
    // Die eben geschriebene Datei explizit mitgeben (auch bei --env <anderer Name>); config.ts lädt danach nur noch Fehlendes.
    if (existsSync(envPfad)) args.unshift(`--env-file=${envPfad}`);
    if (nur?.length) args.push("--nur", nur.join(","));
    if (tty) stumm = true; // keine Frage offen: Vorausgetipptes (oft das nächste Geheimnis) nicht echoen
    const kind = spawn(process.execPath, args, { cwd: wurzel, env, stdio: ["ignore", "pipe", "pipe"], timeout: zeitlimitMs });
    laufendesKind = kind;
    let fehler = false;
    let rest = "";
    const zeige = (chunk: Buffer) => {
      rest += chunk.toString();
      const teile = rest.split("\n");
      rest = teile.pop() ?? "";
      for (const t of teile) {
        if (t.startsWith("❌")) fehler = true;
        sag(`    ${t}`);
      }
    };
    kind.stdout.on("data", zeige);
    kind.stderr.on("data", zeige);
    kind.on("error", (e) => { stumm = false; sag(`    Prüfung nicht gestartet: ${e.message}`); fertig(true); });
    kind.on("close", (code, signal) => {
      laufendesKind = undefined;
      stumm = false;
      if (rest.trim()) sag(`    ${rest.trim()}`);
      if (signal) { sag(`    Prüfung abgebrochen (Zeitlimit ${zeitlimitMs / 1000} s).`); fehler = true; }
      else if (code !== 0) { sag(`    Prüfung endete mit Code ${code}.`); fehler = true; }
      fertig(fehler);
    });
  });
}

// ---------- Ablauf ----------

function liesState(wurzel: string): { whoop?: unknown; google?: unknown } {
  try {
    return JSON.parse(readFileSync(join(wurzel, "data", "state.json"), "utf8")) as { whoop?: unknown; google?: unknown };
  } catch {
    return {};
  }
}

async function abschnittDurchlaufen(a: Abschnitt, zeilen: EnvZeile[], o: Optionen, schreiben: () => void, wurzel: string, envPfad: string): Promise<void> {
  sag();
  sag(`── ${a.titel} ──`);
  sag(a.beschreibung);
  if (a.optional && !o.alle && !o.abschnitt) {
    if (!(await jaNein("Jetzt einrichten?"))) { sag("  Übersprungen."); return; }
  }
  for (;;) {
    const neu = new Map<string, string>(); // erst nach vollständiger Eingabe schreiben
    for (const feld of a.felder) {
      const wert = await frageFeld(feld, holeWert(zeilen, feld.key));
      if (wert !== undefined) neu.set(feld.key, wert);
    }
    for (const [k, v] of neu) setzeWert(zeilen, k, v);
    schreiben();
    sag(`  Gespeichert (${a.titel}).`);
    if (o.ohnePruefung || !a.checks?.length) return;
    ordnerAnlegen(wurzel, zeilen); // vor dem Kind, sonst legt es den Arbeitsordner mit umask-Rechten an
    sag("  Prüfe …");
    const fehler = await pruefeImKind(wurzel, envPfad, a.checks);
    if (!fehler) return;
    if (!(await jaNein("  Werte dieses Abschnitts nochmals eingeben?", true))) return;
  }
}

/** Von diesem Lauf angelegte Ordner: deren Rechte dürfen auch ausserhalb des Projekts nachgezogen werden. */
const selbstAngelegt = new Set<string>();

/**
 * data/ und Arbeitsordner mit 0o700. Bestehende eigene Ordner mit offeneren Rechten werden nur nachgezogen, wenn sie (nach Auflösen
 * von Symlinks) im Projekt liegen oder von diesem Lauf stammen – ein fremder Pfad (/tmp, Home, Freigabe) bekommt nur einen Hinweis.
 * Mehrfach aufrufbar.
 */
function ordnerAnlegen(wurzel: string, zeilen: EnvZeile[]): void {
  const ws = holeWert(zeilen, "JARVIS_WORKSPACE") || "workspace";
  for (const p of [join(wurzel, "data"), isAbsolute(ws) ? ws : join(wurzel, ws)]) {
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true, mode: 0o700 });
      selbstAngelegt.add(realpathSync(p));
      sag(`  Ordner angelegt: ${p}`);
      continue;
    }
    try {
      const st = statSync(p);
      if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) === 0) continue;
      // echte Pfade: ein Symlink im Projekt auf eine Freigabe ausserhalb zählt als fremd (chmod folgt dem Link)
      const echt = realpathSync(p);
      if (echt.startsWith(realpathSync(wurzel) + sep) || selbstAngelegt.has(echt)) {
        chmodSync(p, 0o700);
        sag(`  Rechte auf 700 gesetzt: ${p}`);
      } else {
        sag(`  Rechte von ${p} nicht angepasst (liegt ausserhalb des Projekts), Sir. Bitte selbst prüfen: chmod 700 ${p}`);
      }
    } catch (e) {
      sag(`  Rechte von ${p} nicht gesetzt: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function beispieleAnbieten(wurzel: string): Promise<void> {
  for (const name of ["cameras.json", "protokolle.json"]) {
    const ziel = join(wurzel, name);
    const vorlage = join(wurzel, name.replace(".json", ".example.json"));
    if (existsSync(ziel) || !existsSync(vorlage)) continue;
    if (await jaNein(`  ${name} fehlt. Vorlage ${name.replace(".json", ".example.json")} kopieren?`, true)) {
      copyFileSync(vorlage, ziel);
      sag(`  Kopiert: ${ziel} – bitte anpassen.`);
    }
  }
}

async function haupt(o: Optionen): Promise<void> {
  const envPfad = resolve(o.env);
  const beispielPfad = resolve(o.beispiel);
  const wurzel = dirname(envPfad);

  sag("JARVIS – Einrichtung");
  sag("Guten Tag, Sir. Ich führe Sie durch die Konfiguration.");
  sag(`  • Gespeichert wird in ${envPfad} (Rechte 600); eine bestehende Datei sichere ich vorher als .env.bak.`);
  sag("  • Nichts verlässt diesen Rechner – ausser den Prüfaufrufen an die Dienste, die Sie einrichten.");
  sag("  • Enter = bestehenden Wert oder Vorschlag übernehmen, «-» = Wert leeren, Strg-C = abbrechen.");
  sag("  • Geschrieben wird erst, wenn ein Abschnitt vollständig beantwortet ist.");

  if (!existsSync(beispielPfad)) throw new Error(`Vorlage fehlt: ${beispielPfad}`);
  if (!existsSync(wurzel) || !statSync(wurzel).isDirectory()) throw new Error(`Zielordner fehlt: ${wurzel}`);
  if (envPfad === beispielPfad || (existsSync(envPfad) && realpathSync(envPfad) === realpathSync(beispielPfad))) {
    throw new Error("Ziel und Vorlage sind dieselbe Datei – bitte --env .env verwenden (die Vorlage ist versioniert)");
  }
  if (basename(envPfad) !== ".env") sag(`  Hinweis: ${basename(envPfad)} und ${basename(envPfad)}.bak sind nicht von .gitignore erfasst – nicht committen.`);
  const zeilen = ladeEnv(beispielPfad, envPfad);
  // Bestandswerte sofort prüfen: ein nicht darstellbarer Wert fiele sonst erst beim Schreiben auf – nach allen Fragen des Abschnitts
  for (const z of zeilen) {
    if (z.art !== "wert") continue;
    try { quoteWert(z.wert); } catch (e) { throw new Error(`${z.key} in ${envPfad}: ${(e as Error).message} – bitte von Hand anpassen`); }
  }
  if (existsSync(envPfad)) {
    const gesetzt = parseEnv(readFileSync(envPfad, "utf8")).filter((z) => z.art === "wert" && z.wert !== "").length; // nur die Datei, nicht die Vorlage
    sag(`  Bestehende .env gefunden: ${gesetzt} Wert(e) gesetzt. Enter behält sie.`);
  } else {
    sag("  Keine .env vorhanden – ich baue sie aus der Vorlage auf.");
  }

  let sicherung: string | undefined;
  let geschrieben = false;
  const schreiben = () => {
    const r = schreibeEnv(envPfad, zeilen, { ohneSicherung: geschrieben });
    if (r.sicherung) sicherung = r.sicherung;
    geschrieben = true;
  };

  for (const a of ABSCHNITTE) {
    if (o.abschnitt && a.name !== o.abschnitt) continue;
    await abschnittDurchlaufen(a, zeilen, o, schreiben, wurzel, envPfad);
  }

  sag();
  ordnerAnlegen(wurzel, zeilen);
  await beispieleAnbieten(wurzel);

  if (!o.ohnePruefung) {
    sag();
    sag("── Selbsttest ──");
    await pruefeImKind(wurzel, envPfad, undefined, ZEITLIMIT_SELBSTTEST_MS);
  }

  sag();
  sag("── Nächste Schritte ──");
  for (const s of naechsteSchritte(zeilen, liesState(wurzel), sicherung)) sag(`  • ${s}`);
  sag();
  sag("Die Einrichtung ist abgeschlossen, Sir.");
}

function abbrechen(grund: string): void {
  sag();
  sag(`${grund} Die .env enthält nur vollständig beantwortete Abschnitte, Sir.`);
  laufendesKind?.kill("SIGTERM");
  rl.close();
  process.exit(1);
}

process.on("SIGINT", () => abbrechen("Abgebrochen."));
rl.on("SIGINT", () => abbrechen("Abgebrochen."));

try {
  const o = parseArgs(process.argv.slice(2));
  if (o === "hilfe") {
    sag(hilfe());
    rl.close();
    process.exit(0);
  }
  await haupt(o);
  rl.close();
  process.exit(0);
} catch (e) {
  if (e instanceof Abbruch) abbrechen("Eingabe beendet.");
  sag(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
  rl.close();
  process.exit(1);
}
