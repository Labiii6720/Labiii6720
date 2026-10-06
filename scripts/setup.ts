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
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ABSCHNITTE, alleSchluessel, entscheideWert, holeWert, ladeEnv, maskiere, naechsteSchritte, quoteWert, schreibeEnv, setzeWert,
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
const rl = createInterface({ input: process.stdin, output: ausgang, terminal: tty });

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
  process.stdout.write(prompt);
  if (tty && geheim) stumm = true;
  let z: string | null;
  if (puffer.length) z = puffer.shift()!;
  else if (eingabeZu) z = null;
  else z = await new Promise<string | null>((r) => { warter = r; });
  if (tty && geheim) { stumm = false; process.stdout.write("\n"); }
  else if (!tty) process.stdout.write("\n"); // gepipte Eingabe echot nicht
  return z;
}

class Abbruch extends Error {}

async function frageOderAbbruch(prompt: string, geheim = false): Promise<string> {
  const z = await frage(prompt, geheim);
  if (z === null) throw new Abbruch("Eingabe beendet");
  return z;
}

async function jaNein(prompt: string): Promise<boolean> {
  const a = (await frageOderAbbruch(`${prompt} [j/N] `)).trim().toLowerCase();
  return a === "j" || a === "ja" || a === "y";
}

// ---------- Felder ----------

function anzeigeBestehend(feld: Feld, wert: string | undefined): string | undefined {
  if (!wert) return undefined;
  return feld.art === "geheim" || feld.art === "token" ? maskiere(wert) : wert;
}

/** Fragt ein Feld ab; liefert den neuen Wert oder undefined (Wert behalten). */
async function frageFeld(feld: Feld, bestehend: string | undefined): Promise<string | undefined> {
  if (feld.hinweis) sag(`  ${feld.hinweis}`);
  const anzeige = anzeigeBestehend(feld, bestehend);
  const zusatz = anzeige
    ? `${bestehend === feld.standard ? "Vorschlag" : "bestehend"}: ${anzeige}`
    : feld.erzeugen ? "Enter: erzeugen" : feld.standard ? `Vorschlag: ${feld.standard}` : feld.pflicht ? "Pflicht" : "leer";
  const wahl = feld.wahl ? ` (${feld.wahl.join("/")})` : "";
  for (let versuch = 1; versuch <= 3; versuch++) {
    const eingabe = await frageOderAbbruch(`  ${feld.key} – ${feld.frage}${wahl} [${zusatz}]: `, feld.art === "geheim" || feld.art === "token");
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

/** Lässt scripts/check.ts mit --nur im Kindprozess laufen (liest die frische .env). Liefert true bei mindestens einem Fehler. */
function pruefeImKind(wurzel: string, nur?: string[]): Promise<boolean> {
  return new Promise((fertig) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of alleSchluessel()) delete env[k];
    const args = ["--import", import.meta.resolve("tsx"), join(projekt, "scripts", "check.ts")];
    if (nur?.length) args.push("--nur", nur.join(","));
    const kind = spawn(process.execPath, args, { cwd: wurzel, env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
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
    kind.on("error", (e) => { sag(`    Prüfung nicht gestartet: ${e.message}`); fertig(true); });
    kind.on("close", (code, signal) => {
      if (rest.trim()) sag(`    ${rest.trim()}`);
      if (signal) { sag("    Prüfung abgebrochen (Zeitlimit 60 s)."); fehler = true; }
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

async function abschnittDurchlaufen(a: Abschnitt, zeilen: EnvZeile[], o: Optionen, schreiben: () => void, wurzel: string): Promise<void> {
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
    sag("  Prüfe …");
    const fehler = await pruefeImKind(wurzel, a.checks);
    if (!fehler) return;
    if (!(await jaNein("  Werte dieses Abschnitts nochmals eingeben?"))) return;
  }
}

function ordnerAnlegen(wurzel: string, zeilen: EnvZeile[]): void {
  const ws = holeWert(zeilen, "JARVIS_WORKSPACE") || "workspace";
  for (const p of [join(wurzel, "data"), isAbsolute(ws) ? ws : join(wurzel, ws)]) {
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true, mode: 0o700 });
      sag(`  Ordner angelegt: ${p}`);
    }
  }
}

async function beispieleAnbieten(wurzel: string): Promise<void> {
  for (const name of ["cameras.json", "protokolle.json"]) {
    const ziel = join(wurzel, name);
    const vorlage = join(wurzel, name.replace(".json", ".example.json"));
    if (existsSync(ziel) || !existsSync(vorlage)) continue;
    if (await jaNein(`  ${name} fehlt. Vorlage ${name.replace(".json", ".example.json")} kopieren?`)) {
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
  const zeilen = ladeEnv(beispielPfad, envPfad);
  if (existsSync(envPfad)) {
    const gesetzt = zeilen.filter((z) => z.art === "wert" && z.wert !== "").length;
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
    await abschnittDurchlaufen(a, zeilen, o, schreiben, wurzel);
  }

  sag();
  ordnerAnlegen(wurzel, zeilen);
  await beispieleAnbieten(wurzel);

  if (!o.ohnePruefung) {
    sag();
    sag("── Selbsttest ──");
    await pruefeImKind(wurzel);
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
