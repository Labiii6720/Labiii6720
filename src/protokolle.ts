import { readFileSync } from "node:fs";
import { pausiertText, resetHistory } from "./agent.js";
import type { Stufe } from "./queue.js";
import { schwaerze } from "./robust.js";
import { save, state, type Mode } from "./state.js";
import { notausVermerken } from "./telegram.js";
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

/**
 * Notaus oder Notfall: dann läuft kein Protokoll, auch keines der Stufe auto. Gibt den Ablehnungstext zurück, sonst undefined.
 * state.notfall direkt gelesen (wie pausiertText), um keinen Importzyklus über notfall.ts zu erzeugen.
 */
export function protokollGesperrt(): string | undefined {
  return state.paused || state.notfall?.aktiv ? pausiertText() : undefined;
}

export async function runProtokoll(name: string, ctx: ToolContext): Promise<string> {
  const p = protokolle[name];
  if (!p) throw new Error(`Protokoll «${name}» gibt es nicht.`);
  const gesperrt = protokollGesperrt();
  if (gesperrt) return `Protokoll «${name}» nicht ausgeführt. ${gesperrt}`;
  const zeilen: string[] = [];
  let abgebrochen = false;
  for (const s of p.schritte) {
    // Vor jedem Schritt neu prüfen: /pause oder /notfall können eintreffen, während ein Schritt auf das Netz wartet.
    if (protokollGesperrt()) {
      zeilen.push("✗ Notaus: übrige Schritte nicht ausgeführt");
      abgebrochen = true;
      break;
    }
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
      } else if (s.aktion === "pause") {
        state.paused = true;
        save();
        // Ein schon eingereihtes /weiter hebt diesen Notaus nicht auf (wie POST /notfall)
        notausVermerken();
        zeilen.push("✓ pause");
      } else if (s.aktion === "weiter") {
        // Im Notfall hebt nur /entwarnung auf; den Notaus selbst hebt nur /weiter auf, nie ein Protokoll.
        if (state.notfall?.aktiv) throw new Error("Notfall aktiv, nur /entwarnung hebt auf");
        if (state.paused) throw new Error("Notaus aktiv, nur /weiter hebt auf");
        zeilen.push("✓ weiter");
      } else if (s.nachricht) {
        zeilen.push(s.nachricht);
      }
    } catch (e) {
      // Fehlertexte gehen nach Telegram, ins Dashboard, in die Historie und an die API: Zugangsdaten in URLs schwärzen
      zeilen.push(`✗ ${s.tool ?? s.aktion ?? "Schritt"}: ${schwaerze(e instanceof Error ? e.message : String(e))}`);
    }
  }
  return `Protokoll «${name}» ${abgebrochen ? "abgebrochen" : "ausgeführt"}:\n${zeilen.join("\n")}`;
}
