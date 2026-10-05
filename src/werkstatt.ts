import Anthropic from "@anthropic-ai/sdk";
import { anthropic as claude, trackUsage } from "./claude.js";
import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { config } from "./config.js";
import { ROOT, safePath, writeFile } from "./workspace.js";

/**
 * Werkstatt: Jarvis entwirft Teile als OpenSCAD-Code (parametrisch, Text), rendert eine Vorschau,
 * schaut sie sich selbst an und kann die Druckdatei an den 3D-Drucker schicken (OctoPrint, mit Freigabe).
 * Ohne Drucker bleibt das Entwerfen und Rendern; die STL kannst du selbst drucken.
 */

function openscad(): string | undefined {
  if (config.openscadPath) return existsSync(config.openscadPath) ? config.openscadPath : undefined;
  return ["/usr/bin/openscad", "/usr/local/bin/openscad", "/snap/bin/openscad"].find(existsSync);
}
export const hasOpenscad = () => Boolean(openscad());

function run(cmd: string, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  // Auf einem Server ohne Bildschirm braucht die PNG-Vorschau einen virtuellen X-Server (xvfb).
  const wrapped = !process.env.DISPLAY && existsSync("/usr/bin/xvfb-run") ? `xvfb-run -a ${cmd}` : cmd;
  return new Promise((done) => {
    exec(wrapped, { cwd: ROOT, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      done({ ok: !err, out: [stdout, stderr].filter(Boolean).join("\n").slice(0, 4000) });
    });
  });
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
  const q = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
  const r1 = await run(`${bin} -o ${q(png)} --imgsize=900,700 --viewall --autocenter --colorscheme=Tomorrow ${q(scad)}`, 60_000);
  const r2 = await run(`${bin} -o ${q(stl)} ${q(scad)}`, 120_000);
  if (!existsSync(png)) throw new Error(`Vorschau fehlgeschlagen:\n${r1.out}`);
  return { png: readFileSync(png), stlPath: stl, log: [r1.out, r2.out].filter(Boolean).join("\n") };
}

/** Jarvis schaut sich seine eigene Vorschau an und beschreibt/bewertet sie. */
export async function pruefeVorschau(png: Buffer, auftrag: string): Promise<string> {
  const anthropic = claude();
  const msg = await anthropic.messages.create(
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
  );
  trackUsage(msg);
  return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
}

/** STL an OctoPrint hochladen und optional den Druck starten. */
export async function anDrucker(stlPath: string, starten: boolean): Promise<string> {
  if (!config.octoprint) throw new Error("Kein Drucker eingerichtet (OCTOPRINT_URL, OCTOPRINT_KEY).");
  const stl = safePath(stlPath);
  if (!existsSync(stl)) throw new Error(`STL nicht gefunden: ${stlPath}`);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(readFileSync(stl))]), stl.split("/").pop());
  form.append("select", "true");
  form.append("print", starten ? "true" : "false");
  const res = await fetch(`${config.octoprint.url}/api/files/local`, {
    method: "POST",
    headers: { "X-Api-Key": config.octoprint.key },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`OctoPrint HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return starten ? "An den Drucker geschickt, Druck gestartet." : "An den Drucker geschickt (nicht gestartet).";
}

export { writeFile as schreibeScad };
