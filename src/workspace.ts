import { exec } from "node:child_process";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { config } from "./config.js";

export const ROOT = resolve(config.workspace);
mkdirSync(ROOT, { recursive: true });

const vorhanden = (p: string): Stats | undefined => {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
};

const innerhalb = (wurzel: string, p: string): boolean => {
  const rel = relative(wurzel, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Löst einen Pfad auf und stellt sicher, dass er im Arbeitsordner bleibt – lexikalisch und echt (Leitplanken 4, 5, 7):
 * Verknüpfungen aus «git clone» oder Archiven dürften sonst .env, protokolle.json oder src/ erreichen.
 * Geprüft wird der echte Pfad des Ziels bzw. des nächsten vorhandenen Elternordners; ein Ziel, das selbst eine
 * Verknüpfung oder ein harter Link ist, wird immer abgelehnt, auch wenn es im Arbeitsordner bleibt (z. B. Repo-Symlinks,
 * pnpm, cp -l): Ein harter Link ist von aussen nicht unterscheidbar. Die Meldung sagt das, damit es nicht rätselhaft wirkt.
 */
export function safePath(p: string): string {
  const full = resolve(ROOT, p || ".");
  const ausserhalb = () => new Error(`Pfad liegt ausserhalb des Arbeitsordners: ${p}`);
  if (!innerhalb(ROOT, full)) throw ausserhalb();
  let naechster = full;
  while (naechster !== ROOT && !vorhanden(naechster)) naechster = dirname(naechster);
  let echt: string;
  try {
    echt = realpathSync(naechster);
  } catch {
    throw ausserhalb(); // z. B. Verknüpfung ins Leere: Schreiben legte die Datei an ihrem Ziel an
  }
  if (!innerhalb(realpathSync(ROOT), echt)) throw ausserhalb();
  if (full === ROOT) return full;
  const ziel = vorhanden(full);
  if (ziel?.isSymbolicLink()) throw new Error(`Verknüpfungen nehme ich nicht, Sir, auch nicht innerhalb des Arbeitsordners. Eine echte Kopie geht: ${p}`);
  if (ziel?.isFile() && ziel.nlink > 1) throw new Error(`Harter Link, das nehme ich nicht, Sir, auch nicht innerhalb des Arbeitsordners. Eine eigenständige Kopie geht: ${p}`);
  return full;
}

// Gegen das Austauschen zwischen Prüfung und Zugriff: die letzte Stufe nie über eine Verknüpfung öffnen
const OHNE_LINK = constants.O_NOFOLLOW ?? 0;

export function listFiles(p = "."): string {
  const dir = safePath(p);
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== "node_modules" && !e.name.startsWith("."))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.isSymbolicLink() ? `${e.name} (Verknüpfung)` : `${e.name} (${statSync(resolve(dir, e.name)).size} B)`));
  return entries.join("\n") || "(leer)";
}

export function readFile(p: string, maxChars = 20_000): string {
  const fd = openSync(safePath(p), constants.O_RDONLY | OHNE_LINK);
  let text: string;
  try {
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [gekürzt, ${text.length} Zeichen gesamt]` : text;
}

export function writeFile(p: string, content: string): string {
  const full = safePath(p);
  mkdirSync(dirname(full), { recursive: true });
  const fd = openSync(full, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | OHNE_LINK, 0o666);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return `${relative(ROOT, full)} geschrieben (${Buffer.byteLength(content)} B)`;
}

// Befehle, die Jarvis nie ausführt – egal in welcher Stufe
const VERBOTEN = /\bsudo\b|\bsu\b|\brm\s+-[a-z]*r[a-z]*\s+\/|\bmkfs|\bdd\s+if=|\bshutdown\b|\breboot\b|\bsystemctl\b|\bcrontab\b|\|\s*(ba|z)?sh\b|\bnc\b|\bssh\b|\bscp\b|\bchmod\s+[0-7]*7[0-7]*\s+\//;

export function runCommand(cmd: string, timeoutMs = 60_000): Promise<string> {
  if (VERBOTEN.test(cmd)) return Promise.resolve(`Abgelehnt: dieser Befehl ist gesperrt (${cmd.slice(0, 80)})`);
  return new Promise((done) => {
    exec(
      cmd,
      {
        cwd: ROOT,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        // Bewusst keine Geheimnisse aus process.env weitergeben
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: ROOT, LANG: process.env.LANG ?? "C.UTF-8", TZ: process.env.TZ ?? "" },
        shell: "/bin/bash",
      },
      (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join("\n").trim();
        const text = out.length > 8000 ? `${out.slice(0, 8000)}\n… [gekürzt]` : out;
        done(err ? `Exit ${err.code ?? "?"}${err.killed ? " (Timeout)" : ""}\n${text}` : text || "(keine Ausgabe)");
      },
    );
  });
}
