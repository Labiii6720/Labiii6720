import { readFileSync } from "node:fs";
import { resetHistory } from "./agent.js";
import type { Stufe } from "./queue.js";
import { save, state, type Mode } from "./state.js";
import { toolByName, type ToolContext } from "./tools.js";

/**
 * Protokolle: benannte Abläufe wie im Film («House Party», «Clean Slate»), bei dir «Nacht», «Abwesend», «Werkstatt».
 * Definiert in protokolle.json. Ein Protokoll hat EINE Stufe für den ganzen Ablauf: auto läuft sofort,
 * extern braucht ein Tippen, sensibel Tippen plus PIN. Die Schritte nutzen die normalen Werkzeuge.
 */
export interface Schritt {
  /** Werkzeug aus dem Werkzeugkasten, mit Eingabe */
  tool?: string;
  input?: Record<string, unknown>;
  /** Modus setzen */
  modus?: Mode;
  /** Sonderaktionen */
  aktion?: "neu" | "pause" | "weiter";
  /** Text als Ergebniszeile */
  nachricht?: string;
}

export interface Protokoll {
  beschreibung: string;
  stufe: Stufe;
  schritte: Schritt[];
}

export const protokolle: Record<string, Protokoll> = (() => {
  try {
    return JSON.parse(readFileSync("protokolle.json", "utf8")) as Record<string, Protokoll>;
  } catch {
    return {};
  }
})();

export function describeProtokolle(): string {
  return (
    Object.entries(protokolle)
      .map(([k, p]) => `${k}: ${p.beschreibung} (${p.stufe}, ${p.schritte.length} Schritte)`)
      .join("\n") || "Keine Protokolle definiert (protokolle.json)."
  );
}

export async function runProtokoll(name: string, ctx: ToolContext): Promise<string> {
  const p = protokolle[name];
  if (!p) throw new Error(`Protokoll «${name}» gibt es nicht.`);
  const zeilen: string[] = [];
  for (const s of p.schritte) {
    try {
      if (s.tool) {
        const t = toolByName(s.tool);
        if (!t) throw new Error(`Werkzeug ${s.tool} nicht verfügbar`);
        const out = await t.run(s.input ?? {}, ctx);
        zeilen.push(`✓ ${s.tool}: ${(typeof out === "string" ? out : out.text).split("\n")[0].slice(0, 120)}`);
      } else if (s.modus) {
        state.mode = s.modus;
        save();
        zeilen.push(`✓ Modus ${s.modus}`);
      } else if (s.aktion === "neu") {
        resetHistory();
        zeilen.push("✓ Gespräch vergessen");
      } else if (s.aktion === "pause" || s.aktion === "weiter") {
        state.paused = s.aktion === "pause";
        save();
        zeilen.push(`✓ ${s.aktion}`);
      } else if (s.nachricht) {
        zeilen.push(s.nachricht);
      }
    } catch (e) {
      zeilen.push(`✗ ${s.tool ?? s.aktion ?? "Schritt"}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return `Protokoll «${name}» ausgeführt:\n${zeilen.join("\n")}`;
}
