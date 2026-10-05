import Anthropic from "@anthropic-ai/sdk";
import { anthropic as claude, trackUsage } from "./claude.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { config } from "./config.js";

/**
 * Kameras laufen über Frigate (Erkennung, Aufnahme, Zonen – alles lokal).
 * Jarvis kennt sie aus cameras.json; jede Kamera bekommt dort ihre Funktionen:
 *   schauen   immer möglich: Standbild holen, Claude beschreibt es
 *   melden    Frigate-Ereignisse (Labels, Zonen) → Telegram mit Bild, ohne Claude
 *   wachen    regelmässig ein Standbild mit einer Frage prüfen, melden bei JA
 *   präsenz   macht Frigate selbst (Belegungs-Sensoren in Home Assistant)
 */

export type Bedingung = "immer" | "abwesend" | "nacht";

export interface Melden {
  labels: string[];
  zonen?: string[];
  nur_wenn?: Bedingung;
  ruhe_minuten?: number;
  /** Claude beschreibt das Bild in einem Satz (schickt das Bild an die API) */
  beschreiben?: boolean;
}

export interface Wache {
  id?: number;
  kamera: string;
  frage: string;
  alle_minuten: number;
  nur_wenn?: Bedingung;
  ruhe_minuten?: number;
}

export interface Camera {
  frigate: string;
  beschreibung: string;
  melden?: Melden;
  wachen?: Omit<Wache, "kamera" | "id">[];
}

function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export const cameras: Record<string, Camera> = loadJson("cameras.json", {});
export const hasCameras = () => Boolean(config.frigateUrl) && Object.keys(cameras).length > 0;

export function cameraByFrigateName(name: string): [string, Camera] | undefined {
  return Object.entries(cameras).find(([key, c]) => c.frigate === name || key === name);
}

export function describeCameras(): string {
  return (
    Object.entries(cameras)
      .map(([k, c]) => {
        const f = ["schauen"];
        if (c.melden) f.push(`melden (${c.melden.labels.join(", ")}${c.melden.zonen ? ", Zonen " + c.melden.zonen.join("/") : ""}, ${c.melden.nur_wenn ?? "immer"})`);
        if (c.wachen?.length) f.push(`${c.wachen.length} Wache(n)`);
        return `${k}: ${c.beschreibung} · ${f.join(" · ")}`;
      })
      .join("\n") || "Keine Kameras eingerichtet."
  );
}

// ---------- Frigate ----------

function frigate(): string {
  if (!config.frigateUrl) throw new Error("Frigate ist nicht eingerichtet (FRIGATE_URL).");
  return config.frigateUrl;
}

async function bytes(path: string, timeoutMs = 15_000): Promise<Buffer> {
  const res = await fetch(`${frigate()}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Frigate HTTP ${res.status} (${path.split("?")[0]})`);
  return Buffer.from(await res.arrayBuffer());
}

export const snapshot = (cam: string, height = 720) => bytes(`/api/${cameras[cam]?.frigate ?? cam}/latest.jpg?h=${height}`);
export const eventSnapshot = (id: string) => bytes(`/api/events/${id}/snapshot.jpg`);
export const eventClip = (id: string) => bytes(`/api/events/${id}/clip.mp4`, 60_000);

export interface FrigateEvent {
  id: string;
  camera: string;
  label: string;
  zones: string[];
  start_time: number;
  end_time: number | null;
  has_clip: boolean;
  has_snapshot: boolean;
}

export async function recentEvents(opts: { kamera?: string; stunden?: number; limit?: number } = {}): Promise<FrigateEvent[]> {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 20), after: String(Math.floor(Date.now() / 1000 - (opts.stunden ?? 24) * 3600)) });
  if (opts.kamera) q.set("cameras", cameras[opts.kamera]?.frigate ?? opts.kamera);
  const res = await fetch(`${frigate()}/api/events?${q}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Frigate HTTP ${res.status} (events)`);
  return (await res.json()) as FrigateEvent[];
}

export function formatEvents(list: FrigateEvent[]): string {
  return (
    list
      .map((e) => {
        const t = new Date(e.start_time * 1000).toLocaleString("de-CH", { weekday: "short", hour: "2-digit", minute: "2-digit" });
        const dur = e.end_time ? ` · ${Math.round(e.end_time - e.start_time)} s` : " · läuft";
        return `${e.id} · ${t} · ${e.camera} · ${e.label}${e.zones.length ? " · Zone " + e.zones.join("/") : ""}${dur}${e.has_clip ? " · Clip" : ""}`;
      })
      .join("\n") || "Keine Ereignisse."
  );
}

// ---------- Claude schaut hin ----------

export async function look(cam: string, question: string, image?: Buffer): Promise<{ text: string; image: Buffer }> {
  const c = cameras[cam];
  if (!c) throw new Error(`Kamera «${cam}» kenne ich nicht.`);
  const img = image ?? (await snapshot(cam));
  const anthropic = claude();
  const msg = await anthropic.messages.create(
    {
      model: config.claudeModelSehen || config.claudeModel,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.toString("base64") } },
            { type: "text", text: `Standbild der Kamera «${cam}» (${c.beschreibung}). ${question}\nAntworte knapp und auf Deutsch. Erfinde nichts, was nicht zu sehen ist.` },
          ],
        },
      ],
    },
    { timeout: 60_000 },
  );
  trackUsage(msg);
  return { text: msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim(), image: img };
}

// ---------- Wachen (dynamisch per Werkzeug, zusätzlich zu cameras.json) ----------

const WACHEN_FILE = "data/wachen.json";
export const dynamicWachen: Wache[] = loadJson(WACHEN_FILE, []);

export function saveWachen(): void {
  mkdirSync("data", { recursive: true, mode: 0o700 });
  writeFileSync(`${WACHEN_FILE}.tmp`, JSON.stringify(dynamicWachen, null, 2), { mode: 0o600 });
  renameSync(`${WACHEN_FILE}.tmp`, WACHEN_FILE);
}

/** Alle Wachen: aus cameras.json (ohne ID) und die per Werkzeug angelegten (mit ID). */
export function allWachen(): Wache[] {
  const fromConfig = Object.entries(cameras).flatMap(([kamera, c]) => (c.wachen ?? []).map((w) => ({ ...w, kamera })));
  return [...fromConfig, ...dynamicWachen];
}
