import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Freigabe-Warteschlange. Jedes Werkzeug hat eine Stufe:
 *   auto      läuft sofort (nur lesen oder im Arbeitsordner)
 *   extern    verlässt den Pi oder verändert etwas → Auftrag, wartet auf dein OK
 *   sensibel  Geld, Schlösser, Zugänge → Auftrag, wartet auf OK plus PIN
 */
export type Stufe = "auto" | "extern" | "sensibel";
export type Status = "offen" | "erledigt" | "abgelehnt" | "fehler";

export interface Auftrag {
  id: number;
  createdAt: string;
  tool: string;
  input: Record<string, unknown>;
  stufe: Exclude<Stufe, "auto">;
  /** Was passieren würde, in einem Satz – kommt so in die Telegram-Nachricht */
  summary: string;
  status: Status;
  result?: string;
  messageId?: number;
}

const FILE = "data/auftraege.json";

function load(): Auftrag[] {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Auftrag[];
  } catch {
    return [];
  }
}

export const auftraege: Auftrag[] = load();

export function saveAuftraege(): void {
  mkdirSync("data", { recursive: true, mode: 0o700 });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(auftraege, null, 2), { mode: 0o600 });
  renameSync(`${FILE}.tmp`, FILE);
}

export function createAuftrag(a: Omit<Auftrag, "id" | "createdAt" | "status">): Auftrag {
  const id = (auftraege.at(-1)?.id ?? 0) + 1;
  const auftrag: Auftrag = { id, createdAt: new Date().toISOString(), status: "offen", ...a };
  auftraege.push(auftrag);
  if (auftraege.length > 200) auftraege.splice(0, auftraege.length - 200);
  saveAuftraege();
  return auftrag;
}

export function getAuftrag(id: number): Auftrag | undefined {
  return auftraege.find((a) => a.id === id);
}

export function offeneAuftraege(): Auftrag[] {
  return auftraege.filter((a) => a.status === "offen");
}

export function setStatus(a: Auftrag, status: Status, result?: string): void {
  a.status = status;
  if (result !== undefined) a.result = result.slice(0, 2000);
  saveAuftraege();
}
