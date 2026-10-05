import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { addSystemNote, runTask, type AgentHooks } from "./agent.js";
import { sendText } from "./telegram.js";

/**
 * Vorgänge: grössere Aufträge, die im Hintergrund laufen, mit eigener Historie, starkem Modell
 * und vielen Werkzeugrunden. Der Chat bleibt währenddessen frei. Fortschritt und Ergebnis kommen per Telegram.
 */
export interface Vorgang {
  id: number;
  auftrag: string;
  status: "läuft" | "fertig" | "fehler";
  startedAt: string;
  finishedAt?: string;
  steps: number;
  result?: string;
}

const FILE = "data/vorgaenge.json";
export const vorgaenge: Vorgang[] = (() => {
  try { return JSON.parse(readFileSync(FILE, "utf8")) as Vorgang[]; } catch { return []; }
})();

function save(): void {
  mkdirSync("data", { recursive: true, mode: 0o700 });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(vorgaenge.slice(-100), null, 2), { mode: 0o600 });
  renameSync(`${FILE}.tmp`, FILE);
}

export function startVorgang(auftrag: string, hooks: AgentHooks): Vorgang {
  const v: Vorgang = { id: (vorgaenge.at(-1)?.id ?? 0) + 1, auftrag, status: "läuft", startedAt: new Date().toISOString(), steps: 0 };
  vorgaenge.push(v);
  save();
  const prompt =
    `[Vorgang #${v.id}, läuft im Hintergrund] ${auftrag}\n\n` +
    "Arbeite das vollständig ab: erst verstehen und Risiken nennen, dann Plan, dann Schritt für Schritt mit Werkzeugen umsetzen und die Ergebnisse prüfen. " +
    "Am Ende ein Bericht: Lage, Ergebnis, was offen ist, welche Aufträge auf Freigabe warten, und dein Vorschlag für den nächsten Schritt.";
  void runTask(prompt, hooks, {
    onStep: (step, tool) => {
      v.steps = step;
      if (step % 5 === 0) {
        save();
        sendText(`🧠 Vorgang #${v.id}: Schritt ${step} (${tool})`).catch(() => undefined);
      }
    },
  })
    .then(async (result) => {
      v.status = "fertig";
      v.result = result.slice(0, 4000);
      v.finishedAt = new Date().toISOString();
      save();
      addSystemNote(`Vorgang #${v.id} («${auftrag.slice(0, 80)}») ist fertig: ${v.result.slice(0, 1500)}`);
      await sendText(`✅ Vorgang #${v.id} fertig (${v.steps} Werkzeugschritte)\n\n${result}`);
    })
    .catch(async (e: Error) => {
      v.status = "fehler";
      v.result = e.message;
      v.finishedAt = new Date().toISOString();
      save();
      await sendText(`⚠️ Vorgang #${v.id} abgebrochen: ${e.message}`).catch(() => undefined);
    });
  return v;
}

export function listVorgaenge(): string {
  return (
    vorgaenge
      .slice(-10)
      .map((v) => `#${v.id} ${v.status} · ${v.steps} Schritte · ${v.auftrag.slice(0, 80)}`)
      .join("\n") || "Keine Vorgänge."
  );
}
