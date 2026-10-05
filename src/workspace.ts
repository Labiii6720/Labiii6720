import { exec } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { config } from "./config.js";

export const ROOT = resolve(config.workspace);
mkdirSync(ROOT, { recursive: true });

/** Löst einen Pfad auf und stellt sicher, dass er im Arbeitsordner bleibt. */
export function safePath(p: string): string {
  const full = resolve(ROOT, p || ".");
  const rel = relative(ROOT, full);
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) throw new Error(`Pfad liegt ausserhalb des Arbeitsordners: ${p}`);
  return full;
}

export function listFiles(p = "."): string {
  const dir = safePath(p);
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== "node_modules" && !e.name.startsWith("."))
    .map((e) => (e.isDirectory() ? `${e.name}/` : `${e.name} (${statSync(resolve(dir, e.name)).size} B)`));
  return entries.join("\n") || "(leer)";
}

export function readFile(p: string, maxChars = 20_000): string {
  const text = readFileSync(safePath(p), "utf8");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [gekürzt, ${text.length} Zeichen gesamt]` : text;
}

export function writeFile(p: string, content: string): string {
  const full = safePath(p);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
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
