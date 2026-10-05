import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Langzeitgedächtnis über den Nutzer – das «Lernen». KEINE Selbstmodifikation von Code oder Regeln,
 * nur strukturiertes Wissen, das Jarvis pflegt und in jede Antwort einfliessen lässt.
 *
 *   ziele        was der Nutzer erreichen will (mit Zieldatum, Status)
 *   werte        Prinzipien und Prioritäten, an denen Entscheidungen gemessen werden
 *   muster       beobachtete Entscheidungsmuster (nur aus belegten Beobachtungen)
 *   entscheidungen  getroffene Entscheidungen und – später – wie sie ausgingen
 *   fakten       dauerhafte Fakten über den Nutzer, die der Chat nicht neu erfragen soll
 */
export interface Ziel { id: number; text: string; frist?: string; status: "offen" | "erreicht" | "verworfen"; angelegt: string }
export interface Muster { id: number; text: string; belege: string[]; seit: string }
export interface Entscheidung { id: number; datum: string; text: string; ziel?: number; ausgang?: string }

export interface Profil {
  ziele: Ziel[];
  werte: string[];
  muster: Muster[];
  entscheidungen: Entscheidung[];
  fakten: string[];
}

const FILE = "data/profil.json";
const leer: Profil = { ziele: [], werte: [], muster: [], entscheidungen: [], fakten: [] };

export const profil: Profil = (() => {
  try {
    return { ...leer, ...(JSON.parse(readFileSync(FILE, "utf8")) as Partial<Profil>) };
  } catch {
    return structuredClone(leer);
  }
})();

export function saveProfil(): void {
  mkdirSync("data", { recursive: true, mode: 0o700 });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(profil, null, 2), { mode: 0o600 });
  renameSync(`${FILE}.tmp`, FILE);
}

const naechste = (arr: { id: number }[]) => (arr.at(-1)?.id ?? 0) + 1;
export const neueZielId = () => naechste(profil.ziele);
export const neuesMusterId = () => naechste(profil.muster);
export const neueEntscheidungId = () => naechste(profil.entscheidungen);

/** Kompakte Fassung fürs Systemprompt: so weiss Jarvis in jeder Antwort, worauf er den Nutzer hin berät. */
export function profilFuerPrompt(): string {
  const ziele = profil.ziele.filter((z) => z.status === "offen").map((z) => `#${z.id} ${z.text}${z.frist ? ` (bis ${z.frist})` : ""}`);
  const muster = profil.muster.map((m) => `#${m.id} ${m.text}`);
  const letzte = profil.entscheidungen.slice(-6).map((e) => `${e.datum.slice(0, 10)}: ${e.text}${e.ausgang ? ` → ${e.ausgang}` : ""}`);
  const teile = [
    ziele.length ? `Ziele des Nutzers:\n${ziele.join("\n")}` : "",
    profil.werte.length ? `Werte/Prioritäten: ${profil.werte.join("; ")}` : "",
    muster.length ? `Beobachtete Entscheidungsmuster (nur belegt ansprechen, nie als Charakterurteil):\n${muster.join("\n")}` : "",
    letzte.length ? `Letzte Entscheidungen:\n${letzte.join("\n")}` : "",
    profil.fakten.length ? `Dauerhafte Fakten: ${profil.fakten.slice(-20).join("; ")}` : "",
  ].filter(Boolean);
  return teile.join("\n\n");
}
