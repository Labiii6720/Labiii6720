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

const STUFEN: readonly unknown[] = ["auto", "extern", "sensibel"];

/**
 * Stufe eines Protokolls aus protokolle.json: nur genau auto, extern oder sensibel. Alles andere («Sensibel»,
 * «sensibel », fehlend) gilt als sensibel, also Tippen plus PIN: Ein Tippfehler bei einem Protokoll, das Schlösser oder
 * den Alarm schaltet, darf nie ohne PIN laufen (die PIN prüfen Telegram und Dashboard nur bei genau «sensibel»).
 */
export const protokollStufe = (roh: unknown): Stufe => (STUFEN.includes(roh) ? (roh as Stufe) : "sensibel");

export const protokolle: Record<string, Protokoll> = (() => {
  let roh: unknown;
  try {
    roh = JSON.parse(readFileSync("protokolle.json", "utf8"));
  } catch {
    return {};
  }
  if (!roh || typeof roh !== "object" || Array.isArray(roh)) return {};
  const aus: Record<string, Protokoll> = {};
  let strenger = 0;
  for (const [name, p] of Object.entries(roh as Record<string, unknown>)) {
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    const eintrag = p as Protokoll;
    const stufe = protokollStufe(eintrag.stufe);
    if (stufe !== eintrag.stufe) strenger++;
    aus[name] = { ...eintrag, stufe };
  }
  // Nur die Anzahl, kein Inhalt der Datei
  if (strenger) console.error(`protokolle.json: ${strenger === 1 ? "1 Protokoll" : `${strenger} Protokolle`} ohne gültige Stufe (auto, extern, sensibel) – gilt als sensibel, Freigabe mit PIN.`);
  return aus;
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
        // Das Protokoll ist eine feste, vom Nutzer geschriebene Anweisung und über seine Stufe freigegeben: den Stand
        // zur Ausführungszeit festhalten, sonst lehnen zeitplan_loeschen und wache_loeschen jeden Schritt ab.
        const eingabe = t.festhalten ? t.festhalten({ ...(s.input ?? {}) }) : (s.input ?? {});
        const out = await t.run(eingabe, ctx);
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
