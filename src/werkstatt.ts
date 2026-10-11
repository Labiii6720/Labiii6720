import { anthropic as claude, claudeAufruf, trackUsage } from "./claude.js";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess, type ExecException, type ExecOptions, type SpawnOptions } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, relative, resolve, sep } from "node:path";
import { config } from "./config.js";
import { HttpFehler, mitWiederholung, schwaerze } from "./robust.js";
import { state } from "./state.js";
import { ROOT, safePath, writeFile } from "./workspace.js";

/**
 * Werkstatt: Jarvis entwirft Teile als OpenSCAD-Code (parametrisch, Text), rendert eine Vorschau,
 * schaut sie sich selbst an, slict sie mit PrusaSlicer zu G-Code und kann die Druckdatei an den
 * 3D-Drucker schicken (OctoPrint, mit Freigabe). Ohne Drucker bleibt das Entwerfen und Rendern; die STL kannst du selbst drucken.
 */

type ExecRueckruf = (err: ExecException | null, stdout: string, stderr: string) => void;
export type ExecFn = (cmd: string, opts: ExecOptions, cb: ExecRueckruf) => unknown;
export type SpawnFn = (befehl: string, argumente: string[], opts: SpawnOptions) => ChildProcess;

/** Ersetzbar in Tests: Programmaufruf, Prozessstart, Signale, Zeitgeber, Dateisuche und Uhr. */
export const abhaengigkeiten: {
  exec: ExecFn;
  spawn: SpawnFn;
  signal: (pid: number, sig: NodeJS.Signals) => void;
  erneutAusloesen: (sig: NodeJS.Signals) => void;
  nachZeit: (ms: number, fn: () => void) => () => void;
  existiert: (p: string) => boolean;
  jetzt: () => number;
} = {
  exec: (cmd, opts, cb) => execGruppe(cmd, opts, cb),
  spawn: (befehl, argumente, opts) => spawn(befehl, argumente, opts),
  signal: (pid, sig) => process.kill(pid, sig),
  erneutAusloesen: (sig) => process.kill(process.pid, sig),
  nachZeit: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
  existiert: existsSync,
  jetzt: () => Date.now(),
};

/** Zeit zwischen SIGTERM und SIGKILL an die Prozessgruppe. */
export const GNADENFRIST_MS = 10_000;
const MAXBUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
/** Grösster Wert, den setTimeout annimmt; darüber feuert Node nach 1 ms (TimeoutOverflowWarning). */
const ZEITGEBER_MAX_MS = 2_147_483_647;

// Eigene Prozessgruppen erreicht Strg-C im Terminal nicht, und ein Signal an Jarvis räumt sie nicht ab:
// Solange eine läuft, beendet ein Handler sie bei SIGINT/SIGTERM/SIGHUP und beim Prozessende mit.
const laufendeGruppen = new Set<number>();
const ABBRUCH_SIGNALE = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
let wacheAktiv = false;

function gruppenToeten(): void {
  for (const pid of laufendeGruppen) {
    try {
      abhaengigkeiten.signal(-pid, "SIGKILL");
    } catch {
      // ESRCH: Gruppe schon leer
    }
  }
  laufendeGruppen.clear();
}

const beimSignal = Object.fromEntries(ABBRUCH_SIGNALE.map((sig) => [sig, () => {
  gruppenToeten();
  wacheAus();
  // Hat sonst niemand einen Handler (z. B. npm run check), gilt wieder das Standardverhalten: beenden
  if (process.listenerCount(sig) === 0) abhaengigkeiten.erneutAusloesen(sig);
}])) as Record<(typeof ABBRUCH_SIGNALE)[number], () => void>;

function wacheAn(): void {
  if (wacheAktiv) return;
  wacheAktiv = true;
  for (const sig of ABBRUCH_SIGNALE) process.on(sig, beimSignal[sig]);
  process.on("exit", gruppenToeten);
}

function wacheAus(): void {
  if (!wacheAktiv) return;
  wacheAktiv = false;
  for (const sig of ABBRUCH_SIGNALE) process.removeListener(sig, beimSignal[sig]);
  process.removeListener("exit", gruppenToeten);
}

/**
 * Wie child_process.exec, aber in eigener Prozessgruppe: Beim Zeitlimit traf SIGTERM sonst nur `/bin/sh`
 * (dash ersetzt sich nicht durch den Befehl), PrusaSlicer, AppRun- oder Flatpak-Kinder liefen verwaist weiter.
 * Deshalb geht das Signal an die ganze Gruppe, nach der Gnadenfrist SIGKILL. Der Rückruf kommt erst, wenn
 * alle Prozesse, die die Ausgabe halten, beendet sind – vorher gilt der Lauf nicht als vorbei.
 */
function execGruppe(cmd: string, opts: ExecOptions, cb: ExecRueckruf): void {
  const { spawn: starte, signal, nachZeit } = abhaengigkeiten;
  let kind: ChildProcess;
  try {
    kind = starte("/bin/sh", ["-c", cmd], { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    cb(e as ExecException, "", "");
    return;
  }
  const gruppe = kind.pid;
  if (gruppe) {
    laufendeGruppen.add(gruppe);
    wacheAn();
  }
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
  const puffer = { stdout: "", stderr: "" };
  let abgebrochen: "zeitlimit" | "puffer" | undefined;
  let fertig = false;
  const timer: (() => void)[] = [];
  const anGruppe = (sig: NodeJS.Signals) => {
    if (!kind.pid) return;
    try {
      signal(-kind.pid, sig);
    } catch {
      // ESRCH: Gruppe schon leer
    }
  };
  const abbrechen = (grund: "zeitlimit" | "puffer") => {
    if (abgebrochen || fertig) return;
    abgebrochen = grund;
    anGruppe("SIGTERM");
    timer.push(nachZeit(GNADENFRIST_MS, () => {
      anGruppe("SIGKILL");
      // Hält ein Prozess ausserhalb der Gruppe die Ausgabe offen, nicht ewig warten
      timer.push(nachZeit(GNADENFRIST_MS, () => { kind.stdout?.destroy(); kind.stderr?.destroy(); }));
    }));
  };
  const abschliessen = (err: ExecException | null) => {
    if (fertig) return;
    fertig = true;
    for (const stopp of timer) stopp();
    if (gruppe) laufendeGruppen.delete(gruppe);
    if (!laufendeGruppen.size) wacheAus();
    cb(err, puffer.stdout, puffer.stderr);
  };
  for (const name of ["stdout", "stderr"] as const) {
    const strom = kind[name];
    strom?.setEncoding("utf8");
    strom?.on("data", (teil: string) => {
      if (abgebrochen === "puffer") return;
      puffer[name] += teil;
      if (puffer[name].length > maxBuffer) {
        puffer[name] = puffer[name].slice(0, maxBuffer);
        abbrechen("puffer");
      }
    });
  }
  if (opts.timeout && opts.timeout > 0) timer.push(nachZeit(Math.min(opts.timeout, ZEITGEBER_MAX_MS), () => abbrechen("zeitlimit")));
  kind.on("error", (e) => {
    if (abgebrochen) anGruppe("SIGKILL");
    abschliessen(e as ExecException);
  });
  kind.on("close", (code: number | null, sig: NodeJS.Signals | null) => {
    if (abgebrochen) {
      // Nachzügler, die SIGTERM ignoriert und die Ausgabe schon geschlossen haben
      anGruppe("SIGKILL");
      const err = Object.assign(new Error(`Command failed: ${cmd}`), {
        cmd,
        killed: true,
        code: abgebrochen === "puffer" ? MAXBUFFER_CODE : code,
        signal: sig ?? "SIGTERM",
      });
      abschliessen(err as ExecException);
      return;
    }
    if (code === 0 && !sig) return abschliessen(null);
    abschliessen(Object.assign(new Error(`Command failed: ${cmd}`), { cmd, killed: false, code, signal: sig ?? undefined }) as ExecException);
  });
}

function openscad(): string | undefined {
  if (config.openscadPath) return existsSync(config.openscadPath) ? config.openscadPath : undefined;
  return ["/usr/bin/openscad", "/usr/local/bin/openscad", "/snap/bin/openscad"].find(existsSync);
}
export const hasOpenscad = () => Boolean(openscad());

const q = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;

interface Lauf { ok: boolean; out: string; stdout: string; zeitlimit: boolean; code?: number | string | null }

function ausfuehren(cmd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<Lauf> {
  return new Promise((done) => {
    abhaengigkeiten.exec(cmd, { cwd: ROOT, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join("\n");
      // exec setzt killed bei Zeitlimit; ein Pufferüberlauf tötet den Prozess ebenfalls, ist aber kein Zeitlimit
      const zeitlimit = Boolean(err?.killed) && err?.code !== MAXBUFFER_CODE;
      done({ ok: !err, out, stdout: stdout ?? "", zeitlimit, code: err?.code });
    });
  });
}

function run(cmd: string, timeoutMs: number): Promise<{ ok: boolean; out: string; zeitlimit: boolean }> {
  // Auf einem Server ohne Bildschirm braucht die PNG-Vorschau einen virtuellen X-Server (xvfb).
  const wrapped = !process.env.DISPLAY && existsSync("/usr/bin/xvfb-run") ? `xvfb-run -a ${cmd}` : cmd;
  return ausfuehren(wrapped, timeoutMs).then((r) => ({ ok: r.ok, out: r.out.slice(0, 4000), zeitlimit: r.zeitlimit }));
}

/** Rendert eine .scad-Datei zu PNG (Vorschau) und STL (Druck). */
export async function render(scadPath: string): Promise<{ png: Buffer; stlPath: string; log: string }> {
  const bin = openscad();
  if (!bin) throw new Error("OpenSCAD ist nicht installiert (apt install openscad) oder OPENSCAD_PATH setzen.");
  const scad = safePath(scadPath);
  if (!existsSync(scad)) throw new Error(`Datei nicht gefunden: ${scadPath}`);
  const base = scad.replace(/\.scad$/i, "");
  const png = `${base}.png`;
  const stl = `${base}.stl`;
  // Alte Ausgaben weg: sonst gälten Vorschau oder STL der Vorversion nach einem Fehlschlag als neu (und würden geslict/gedruckt)
  rmSync(png, { force: true });
  rmSync(stl, { force: true });
  const r1 = await run(`${bin} -o ${q(png)} --imgsize=900,700 --viewall --autocenter --colorscheme=Tomorrow ${q(scad)}`, 60_000);
  const r2 = await run(`${bin} -o ${q(stl)} ${q(scad)}`, 120_000);
  if (!existsSync(png)) throw new Error(`Vorschau fehlgeschlagen:\n${r1.out}`);
  if (!r2.ok || !existsSync(stl)) {
    rmSync(stl, { force: true });
    throw new Error(`STL-Export fehlgeschlagen${r2.zeitlimit ? " (OpenSCAD nach 120 s abgebrochen)" : ""}:\n${r2.out}`);
  }
  return { png: readFileSync(png), stlPath: stl, log: [r1.out, r2.out].filter(Boolean).join("\n") };
}

/** Jarvis schaut sich seine eigene Vorschau an und beschreibt/bewertet sie. */
export async function pruefeVorschau(png: Buffer, auftrag: string): Promise<string> {
  const anthropic = claude();
  const msg = await claudeAufruf("werkstatt", () => anthropic.messages.create(
    {
      model: config.claudeModelSehen || config.claudeModel,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
            { type: "text", text: `Das ist die gerenderte Vorschau eines 3D-Teils. Auftrag war: «${auftrag}». Passt das Ergebnis? Nenne in zwei, drei Sätzen, was gut ist und was du am OpenSCAD-Code noch ändern würdest. Deutsch.` },
          ],
        },
      ],
    },
    { timeout: 60_000 },
  ));
  trackUsage(msg);
  return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
}

/**
 * Datei im Arbeitsordner (Leitplanke 7): safePath prüft den Pfad, realpath zusätzlich Verknüpfungen,
 * damit keine Datei von ausserhalb über einen Link an Slicer oder Drucker gelangt.
 */
function imArbeitsordner(p: string, art: string): string {
  const voll = safePath(p);
  if (!existsSync(voll)) throw new Error(`${art} nicht gefunden: ${p}`);
  const echt = realpathSync(voll);
  const wurzel = realpathSync(ROOT);
  const rel = relative(wurzel, echt);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || resolve(wurzel, rel) !== echt) throw new Error(`Pfad liegt ausserhalb des Arbeitsordners: ${p}`);
  if (!statSync(echt).isFile()) throw new Error(`${art} ist keine Datei: ${p}`);
  return voll;
}

// ---------- Slicer (PrusaSlicer CLI) ----------

/** Fester Befehl (keine Nutzereingabe), deshalb ungequotet; alle anderen Slicer-Pfade werden gequotet. */
export const FLATPAK_SLICER = "flatpak run --command=prusa-slicer com.prusa3d.PrusaSlicer";
const SLICER_TIMEOUT_STANDARD = 600_000;

/** «~/» = Home des Dienstes, sonst absolut zum Jarvis-Ordner – wie beim Profil. */
const absolut = (p: string) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p));

/**
 * PRUSASLICER_PATH als absoluter Pfad, nur wenn es eine ausführbare Datei ist: geprüft wird gegen den Jarvis-Ordner,
 * ausgeführt aber in ROOT – ein relativer Pfad meinte sonst zwei verschiedene Dateien, ein Ordner gälte als Slicer.
 */
function eingetragenerSlicer(roh: string): string | undefined {
  const p = absolut(roh);
  if (!abhaengigkeiten.existiert(p)) return undefined;
  try {
    if (!statSync(p).isFile()) return undefined;
    accessSync(p, constants.X_OK);
  } catch {
    return undefined;
  }
  return p;
}

/** Pfad oder Befehl von PrusaSlicer; PRUSASLICER_PATH hat Vorrang, sonst bekannte Orte, Flatpak zuletzt. */
export function slicer(): string | undefined {
  const da = abhaengigkeiten.existiert;
  const eingetragen = config.slicerPath?.trim();
  if (eingetragen) return eingetragenerSlicer(eingetragen);
  const pfad = ["/usr/bin/prusa-slicer", "/usr/local/bin/prusa-slicer", resolve(homedir(), ".local/bin/prusa-slicer"), "/usr/bin/PrusaSlicer"].find(da);
  if (pfad) return pfad;
  const flatpak = ["/usr/bin/flatpak", "/usr/local/bin/flatpak"].some(da);
  // Nur wenn die App wirklich installiert ist (systemweit oder für den Benutzer), sonst wäre jeder Rechner mit Flatpak «eingerichtet»
  const app = ["/var/lib/flatpak/app/com.prusa3d.PrusaSlicer", resolve(homedir(), ".local/share/flatpak/app/com.prusa3d.PrusaSlicer")].some(da);
  return flatpak && app ? FLATPAK_SLICER : undefined;
}

/** Absoluter Profil-Pfad (darf ausserhalb des Arbeitsordners liegen, wird nur gelesen); «~/» = Home des Dienstes. */
function profilPfad(): string | undefined {
  const p = config.slicerProfil?.trim();
  return p ? absolut(p) : undefined;
}

export const hasSlicer = () => {
  const profil = profilPfad();
  return Boolean(slicer() && profil && existsSync(profil) && statSync(profil).isFile());
};

const slicerAufruf = (bin: string) => (bin === FLATPAK_SLICER ? bin : q(bin));

/** Umgebung ohne Geheimnisse: .env liegt in process.env, der Slicer braucht davon nichts. */
function slicerUmgebung(): NodeJS.ProcessEnv {
  const erlaubt = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "DISPLAY", "XDG_RUNTIME_DIR", "XDG_DATA_DIRS", "DBUS_SESSION_BUS_ADDRESS"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of erlaubt) if (process.env[k]) env[k] = process.env[k];
  env.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  return env;
}

function letzteZeilen(out: string, n = 8): string {
  const zeilen = out.split(/\r?\n/).map((z) => z.trimEnd()).filter((z) => z.trim());
  return schwaerze(zeilen.slice(-n).join("\n")).slice(-1200);
}

/** «45 s» oder «3 min 12 s» */
export const dauerText = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

let slicerLaeuft = false;

/** Steuerzeichen (auch C1 und Unicode-Zeilentrenner) und Zeichen, die G-Code-Zeilen oder M486-Namen aufbrechen. */
const UNSICHERER_NAME = /[\x00-\x1f\x7f-\x9f\u2028\u2029"\\;]/;
/** Name mit sichtbar maskierten Steuerzeichen; JSON.stringify liesse C1 und U+2028/2029 roh stehen. */
const namensAnzeige = (name: string) =>
  JSON.stringify(name).replace(/[\x7f-\x9f\u2028\u2029]/g, (z) => `\\u${z.charCodeAt(0).toString(16).padStart(4, "0")}`).slice(0, 120);

/**
 * Slict eine STL aus dem Arbeitsordner mit dem exportierten PrusaSlicer-Profil zu `<name>.gcode` daneben.
 * Kein automatisches Wiederholen: ein Fehlschlag liegt fast immer am Modell oder Profil, nicht am Zufall.
 */
export async function slice(stlPath: string): Promise<{ gcodePath: string; log: string; dauerMs: number; sha256: string }> {
  const bin = slicer();
  if (!bin) throw new Error("PrusaSlicer nicht gefunden oder nicht ausführbar: installieren (apt, AppImage oder Flatpak) oder PRUSASLICER_PATH auf das Programm (nicht den Ordner) setzen.");
  const profil = profilPfad();
  if (!profil) throw new Error("Kein Slicer-Profil (SLICER_PROFIL): in PrusaSlicer «Datei → Export → Konfiguration exportieren» und den Pfad der .ini eintragen.");
  if (!existsSync(profil) || !statSync(profil).isFile()) throw new Error(`Slicer-Profil nicht gefunden: ${profil} (SLICER_PROFIL prüfen).`);
  if (!/\.stl$/i.test(stlPath)) throw new Error(`Slicen geht nur mit einer .stl-Datei: ${stlPath}`);
  const stl = imArbeitsordner(stlPath, "STL");
  // PrusaSlicer übernimmt den Dateinamen als Objektnamen ungefiltert in den G-Code («; printing object …», M486):
  // ein Zeilenumbruch darin wären eigene Maschinenbefehle, die als echte Slicer-Ausgabe gälten
  const rel = relative(ROOT, stl);
  if (UNSICHERER_NAME.test(rel)) throw new Error(`Dateiname mit Steuer- oder Sonderzeichen (${namensAnzeige(rel)}): bitte umbenennen, Sir. Er landet sonst im G-Code.`);
  const gcode = stl.replace(/\.stl$/i, ".gcode");
  if (slicerLaeuft) throw new Error("Der Slicer läuft bereits. Bitte warten, bis er fertig ist.");
  slicerLaeuft = true;
  try {
    // Alte Ausgabe weg, sonst gälte ein früherer G-Code nach einem stillen Fehlschlag als neu
    rmSync(gcode, { force: true });
    const timeoutMs = Math.min(ZEITGEBER_MAX_MS, config.slicerTimeoutMs > 0 ? config.slicerTimeoutMs : SLICER_TIMEOUT_STANDARD);
    const start = abhaengigkeiten.jetzt();
    const r = await ausfuehren(`${slicerAufruf(bin)} --export-gcode --load ${q(profil)} --output ${q(gcode)} ${q(stl)}`, timeoutMs, slicerUmgebung());
    const dauerMs = Math.max(0, abhaengigkeiten.jetzt() - start);
    const rest = letzteZeilen(r.out);
    const anhang = rest ? `\n${rest}` : "";
    if (r.zeitlimit) {
      rmSync(gcode, { force: true });
      throw new Error(`Slicen abgebrochen: PrusaSlicer war nach ${dauerText(timeoutMs)} nicht fertig (SLICER_TIMEOUT_MS). Grosse Teile brauchen auf dem Pi lange – Zeitlimit erhöhen oder das Teil vereinfachen.${anhang}`);
    }
    // Abgelehnte Ausgabe nie liegen lassen: cad_drucken schickt einen .gcode sonst ungeprüft an den Drucker
    if (!r.ok) {
      rmSync(gcode, { force: true });
      throw new Error(`Slicen fehlgeschlagen (Exit ${r.code ?? "?"}).${anhang}`);
    }
    if (!existsSync(gcode)) throw new Error(`PrusaSlicer meldet Erfolg, aber ${relative(ROOT, gcode)} fehlt.${anhang}`);
    if (istBinaerGcode(gcode)) {
      rmSync(gcode, { force: true });
      throw new Error("PrusaSlicer hat binären G-Code erzeugt (Profil: «Binary G-code» an); OctoPrint versteht den nicht. Im Profil ausschalten und neu exportieren.");
    }
    // Herkunft hier eintragen, nicht beim Aufrufer: so gilt jeder Weg über slice() als echte Slicer-Ausgabe, kein anderer
    const inhalt = readFileSync(gcode);
    const hash = pruefsumme(inhalt);
    merkeHerkunft({ pfad: relative(ROOT, gcode), sha256: hash, bytes: inhalt.length, erzeugt: new Date(abhaengigkeiten.jetzt()).toISOString() });
    return { gcodePath: gcode, log: r.out.trim().slice(-4000), dauerMs, sha256: hash };
  } finally {
    slicerLaeuft = false;
  }
}

// ---------- G-Code: Herkunft ----------
// G-Code sind rohe Maschinenbefehle (Heizer, Wartezeiten, Firmware). An den Drucker geht nur, was PrusaSlicer hier
// erzeugt hat – nie eine Datei, die ein Werkzeug sonst geschrieben hat. Erkannt wird das am Inhalt (sha256).

const GCODE_HERKUNFT = "data/slicer-gcode.json";
const HERKUNFT_MAX = 500;
interface GcodeHerkunft { pfad: string; sha256: string; bytes: number; erzeugt: string }

/** sha256 als Hex – dieselbe Prüfsumme für Herkunft, Freigabe und Upload. */
export const pruefsumme = (inhalt: Buffer) => createHash("sha256").update(inhalt).digest("hex");

function gcodeHerkunft(): GcodeHerkunft[] {
  try {
    const daten: unknown = JSON.parse(readFileSync(GCODE_HERKUNFT, "utf8"));
    return Array.isArray(daten) ? daten.filter((e): e is GcodeHerkunft => typeof e?.sha256 === "string") : [];
  } catch {
    return [];
  }
}

function merkeHerkunft(eintrag: GcodeHerkunft): void {
  const liste = gcodeHerkunft().filter((e) => !(e.pfad === eintrag.pfad && e.sha256 === eintrag.sha256));
  liste.push(eintrag);
  mkdirSync("data", { recursive: true, mode: 0o700 });
  writeFileSync(`${GCODE_HERKUNFT}.tmp`, JSON.stringify(liste.slice(-HERKUNFT_MAX), null, 2), { mode: 0o600 });
  renameSync(`${GCODE_HERKUNFT}.tmp`, GCODE_HERKUNFT);
}

/** Stammt ein G-Code mit dieser Prüfsumme aus slice()? */
export const vomSlicer = (hash: string) => gcodeHerkunft().some((e) => e.sha256 === hash);

function istBinaerGcode(p: string): boolean {
  const fd = openSync(p, "r");
  try {
    const kopf = Buffer.alloc(4);
    return readSync(fd, kopf, 0, 4, 0) === 4 && kopf.toString("latin1") === "GCDE";
  } finally {
    closeSync(fd);
  }
}

const KOPF_BYTES = 64 * 1024;
const FUSS_BYTES = 512 * 1024;

function zahlenSumme(text: string): number | undefined {
  const teile = text.split(/[,;]/).map((t) => Number(t.trim())).filter((n) => Number.isFinite(n));
  if (!teile.length) return undefined;
  return Math.round(teile.reduce((a, b) => a + b, 0) * 100) / 100;
}

/**
 * Druckzeit, Filament und Schichten aus den PrusaSlicer-Kommentaren. Fehlt etwas (anderer Slicer, alte Version,
 * gekürzte Datei), bleibt das Feld leer – nie ein Fehler. Liest nur Kopf und Fuss; Schichten werden gestreamt gezählt.
 */
export function gcodeInfo(gcodePath: string): { druckzeit?: string; filamentG?: number; schichten?: number } {
  let fd: number;
  try {
    fd = openSync(gcodePath, "r");
  } catch {
    return {};
  }
  try {
    const groesse = statSync(gcodePath).size;
    const lies = (pos: number, laenge: number) => {
      const buf = Buffer.alloc(Math.max(0, Math.min(laenge, groesse - pos)));
      const n = buf.length ? readSync(fd, buf, 0, buf.length, pos) : 0;
      return buf.subarray(0, n);
    };
    const kopf = lies(0, KOPF_BYTES);
    if (kopf.subarray(0, 4).toString("latin1") === "GCDE") return {};
    const fussStart = Math.max(0, groesse - FUSS_BYTES);
    const text = fussStart > kopf.length ? `${kopf.toString("utf8")}\n${lies(fussStart, FUSS_BYTES).toString("utf8")}` : lies(0, groesse).toString("utf8");

    const info: { druckzeit?: string; filamentG?: number; schichten?: number } = {};
    const zeit = /^;[ \t]*estimated printing time \(normal mode\)[ \t]*=[ \t]*(\S[^\n]*?)[ \t\r]*$/m.exec(text) ?? /^;[ \t]*estimated printing time[^=\n]*=[ \t]*(\S[^\n]*?)[ \t\r]*$/m.exec(text);
    if (zeit?.[1]) info.druckzeit = zeit[1].slice(0, 40);
    const filament = /^;[ \t]*total filament used \[g\][ \t]*=[ \t]*(\S[^\n]*?)[ \t\r]*$/m.exec(text) ?? /^;[ \t]*filament used \[g\][ \t]*=[ \t]*(\S[^\n]*?)[ \t\r]*$/m.exec(text);
    const gramm = filament?.[1] ? zahlenSumme(filament[1]) : undefined;
    if (gramm !== undefined) info.filamentG = gramm;
    const total = /^;[ \t]*total layers? count[ \t]*=[ \t]*(\d+)[ \t\r]*$/m.exec(text);
    const schichten = total?.[1] ? Number(total[1]) : zaehleSchichten(fd, groesse);
    if (schichten) info.schichten = schichten;
    return info;
  } catch {
    return {};
  } finally {
    closeSync(fd);
  }
}

/** Zählt «;LAYER_CHANGE» in Blöcken, damit grosse G-Codes nicht ganz in den Speicher müssen. */
function zaehleSchichten(fd: number, groesse: number): number {
  const muster = Buffer.from("\n;LAYER_CHANGE");
  const block = 1024 * 1024;
  const buf = Buffer.alloc(block + muster.length);
  let uebertrag = 0;
  let anzahl = 0;
  // Erste Zeile ohne vorangehenden Zeilenumbruch
  const anfang = Buffer.alloc(muster.length - 1);
  if (readSync(fd, anfang, 0, anfang.length, 0) === anfang.length && anfang.equals(muster.subarray(1))) anzahl++;
  for (let pos = 0; pos < groesse; pos += block) {
    const n = readSync(fd, buf, uebertrag, block, pos);
    const sicht = buf.subarray(0, uebertrag + n);
    for (let i = sicht.indexOf(muster); i >= 0; i = sicht.indexOf(muster, i + 1)) anzahl++;
    // Ende des Blocks behalten, damit ein Muster über die Grenze gefunden wird – aber nicht doppelt
    const behalten = Math.min(muster.length - 1, sicht.length);
    sicht.copy(buf, 0, sicht.length - behalten);
    uebertrag = behalten;
  }
  return anzahl;
}

/** Kurztext für Rückmeldungen: «2.4 MB, Druckzeit 1h 2m 3s, Filament 12.3 g, 120 Schichten». */
export function gcodeZusammenfassung(gcodePath: string): string {
  let mb: number | undefined;
  try {
    mb = statSync(gcodePath).size / (1024 * 1024);
  } catch {
    // Datei fehlt (z. B. von einem zweiten Slicen ersetzt): Grösse weglassen statt Fehler
  }
  const i = gcodeInfo(gcodePath);
  return [
    mb === undefined ? "" : mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(mb * 1024))} KB`,
    i.druckzeit ? `Druckzeit ca. ${i.druckzeit}` : "",
    i.filamentG !== undefined ? `Filament ${i.filamentG} g` : "",
    i.schichten ? `${i.schichten} Schichten` : "",
  ].filter(Boolean).join(", ");
}

/** Für den Selbsttest: Slicer gefunden, `--help` läuft, Profil vorhanden. */
export async function pruefeSlicer(timeoutMs: number): Promise<string> {
  const bin = slicer();
  if (!bin) throw new Error(config.slicerPath ? `PrusaSlicer nicht gefunden oder nicht ausführbar: ${config.slicerPath} (muss auf das Programm zeigen, nicht auf den Ordner)` : "PrusaSlicer nicht gefunden (PRUSASLICER_PATH setzen)");
  const r = await ausfuehren(`${slicerAufruf(bin)} --help`, timeoutMs, slicerUmgebung());
  if (r.zeitlimit) throw new Error(`PrusaSlicer reagiert nicht (--help nach ${Math.round(timeoutMs / 1000)} s abgebrochen)`);
  // Nur die Versionszeile von --help zählt; Shell- und Loader-Fehler enthalten den Programmpfad und dürfen nicht als Kennung gelten
  const kennung = /^(?:PrusaSlicer|Slic3r)[- ]\d[^\s]*/m.exec(r.stdout)?.[0];
  const rest = () => letzteZeilen(r.out, 2).replace(/\n/g, " ").slice(0, 80);
  if (!kennung && !r.ok) throw new Error(`PrusaSlicer startet nicht (Exit ${r.code ?? "?"}): ${rest()}`);
  if (!kennung) throw new Error(`Der gefundene Slicer meldet sich bei --help nicht als PrusaSlicer (keine Versionszeile): ${rest()}`);
  const profil = profilPfad();
  if (!profil) throw new Error(`${kennung} läuft, aber SLICER_PROFIL fehlt (ohne Profil kein Slicen)`);
  if (!existsSync(profil)) throw new Error(`${kennung} läuft, aber Profil nicht gefunden: ${basename(profil)}`);
  if (!statSync(profil).isFile()) throw new Error(`${kennung} läuft, aber das Profil ist keine Datei: ${basename(profil)} (SLICER_PROFIL muss auf die exportierte .ini zeigen)`);
  return `${kennung} läuft, Profil ${basename(profil)}`;
}

// ---------- Drucker (OctoPrint) ----------

const DRUCKDATEI = /\.(stl|gcode)$/i;

/**
 * STL oder G-Code an OctoPrint hochladen und optional den Druck starten. Der Upload wird nie wiederholt: bei Zeitlimit oder
 * Serverfehler kann die Datei bereits angekommen und der Druck gestartet sein – ein zweiter Versuch druckt doppelt.
 * Der Aufruf läuft trotzdem durch `mitWiederholung` (ein Versuch), damit die Gesundheit von OctoPrint geführt wird.
 * G-Code geht nur mit der Prüfsumme der Freigabe; geprüft wird genau der Buffer, der hochgeladen wird.
 */
export async function anDrucker(pfad: string, starten: boolean, erwarteterSha256?: string): Promise<string> {
  const octoprint = config.octoprint;
  if (!octoprint) throw new Error("Kein Drucker eingerichtet (OCTOPRINT_URL, OCTOPRINT_KEY).");
  if (!DRUCKDATEI.test(pfad)) throw new Error(`An den Drucker gehen nur .stl oder .gcode: ${pfad}`);
  const datei = imArbeitsordner(pfad, "Druckdatei");
  const typ = /\.gcode$/i.test(datei) ? "G-Code" : "STL";
  const inhalt = readFileSync(datei);
  // Auch ein .gcode von anderswo: binären G-Code würde OctoPrint als Text an den Drucker schicken
  if (typ === "G-Code" && inhalt.subarray(0, 4).toString("latin1") === "GCDE") throw new Error(`${relative(ROOT, datei)} ist binärer G-Code; OctoPrint versteht den nicht. Nichts an den Drucker geschickt, Sir. Im Slicer-Profil «Binary G-code» ausschalten und neu slicen.`);
  if (typ === "G-Code" && !erwarteterSha256) throw new Error("G-Code ohne Prüfsumme der Freigabe: nichts an den Drucker geschickt, Sir.");
  if (erwarteterSha256 && pruefsumme(inhalt) !== erwarteterSha256) throw new Error("Die Datei hat sich seit der Freigabe geändert: nichts an den Drucker geschickt, Sir.");
  // G-Code kann zig MB haben: Zeitlimit mit der Grösse (mind. 60 s, ca. 256 KB/s), Wiederholen bleibt aus
  const zeitMs = Math.max(60_000, Math.ceil(inhalt.length / (256 * 1024)) * 1000);
  // Letzte Sperre für alle Aufrufer (auch Protokolle): Notaus oder Notfall seit dem Start → kein Upload
  if (state.paused || state.notfall?.aktiv) throw new Error(`Notaus aktiv: nichts an den Drucker geschickt, Sir. ${relative(ROOT, datei)} bleibt im Arbeitsordner.`);
  // OctoPrint druckt nur G-Code: eine STL wird nie mit Druckstart hochgeladen, sonst meldete Jarvis einen Druck, der nicht läuft
  const druckStarten = starten && typ === "G-Code";
  await mitWiederholung("octoprint.upload", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(inhalt)]), basename(datei));
    form.append("select", "true");
    form.append("print", druckStarten ? "true" : "false");
    const res = await fetch(`${octoprint.url}/api/files/local`, {
      method: "POST",
      headers: { "X-Api-Key": octoprint.key },
      body: form,
      signal: AbortSignal.timeout(zeitMs),
    });
    if (!res.ok) throw new HttpFehler(`OctoPrint HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
  }, { versuche: 1, komponente: "octoprint" });
  if (druckStarten) return `${typ} an den Drucker geschickt, Druck gestartet.`;
  if (starten) return `${typ} an den Drucker geschickt, aber nicht gestartet: Eine STL kann OctoPrint nicht direkt drucken. Bitte in OctoPrint slicen oder PRUSASLICER_PATH und SLICER_PROFIL einrichten, Sir.`;
  return `${typ} an den Drucker geschickt (nicht gestartet).`;
}

export { writeFile as schreibeScad };
