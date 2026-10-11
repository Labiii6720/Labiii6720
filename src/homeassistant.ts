import { config } from "./config.js";
import { HttpFehler, mitWiederholung, retryAfterAusHeader, type WiederholOptionen } from "./robust.js";

function ha() {
  if (!config.homeAssistant) throw new Error("Home Assistant ist nicht eingerichtet (HA_URL, HA_TOKEN).");
  return config.homeAssistant;
}

/** Nur für Tests: Warten und Zufall des Backoffs injizieren (im Betrieb leer). */
export const _testOptionen: Pick<WiederholOptionen, "warten" | "zufall"> = {};

const BACKOFF = { basisMs: 400, maxMs: 4000, komponente: "homeassistant" as const };

async function anfrage<T>(path: string, body?: unknown): Promise<T> {
  const { url, token } = ha();
  const res = await fetch(`${url}/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new HttpFehler(`Home Assistant HTTP ${res.status} (${path})`, res.status, retryAfterAusHeader(res.headers));
  return (await res.json()) as T;
}

/** Lesen ist nebenwirkungsfrei: bis zu drei Versuche bei Netz-, Zeitlimit- und Serverfehlern. */
function haGet<T>(path: string): Promise<T> {
  return mitWiederholung("ha.get", () => anfrage<T>(path), { versuche: 3, ...BACKOFF, ..._testOptionen });
}

/** Verbindungsfehler, bei denen die Anfrage HA nachweislich nie erreicht hat (Aufbau der Verbindung schlug fehl). */
const NICHT_ZUGESTELLT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

/** Fehlercode aus e, e.cause (verschachtelt) oder AggregateError.errors – undici hängt die Ursache an «fetch failed». */
function ursacheCode(e: unknown, tiefe = 0): string | undefined {
  if (typeof e !== "object" || e === null || tiefe > 5) return undefined;
  const o = e as Record<string, unknown>;
  if (typeof o.code === "string" && o.code) return o.code;
  if (Array.isArray(o.errors)) for (const x of o.errors) { const c = ursacheCode(x, tiefe + 1); if (c) return c; }
  return ursacheCode(o.cause, tiefe + 1);
}

/** Dienste, deren doppelte Ausführung den Zustand verändert (toggle, Schritte, Taster, Auslöser). */
function istIdempotent(service: string): boolean {
  return !(service === "toggle" || service === "press" || service === "trigger"
    || service.startsWith("increase_") || service.startsWith("decrease_") || service.includes("step"));
}

/**
 * Schalten hat eine Nebenwirkung. Wiederholt wird deshalb nur, wenn die Anfrage HA nachweislich nicht erreicht hat
 * (Verbindungsaufbau gescheitert: ECONNREFUSED, ENOTFOUND, EAI_AGAIN, ENETUNREACH, EHOSTUNREACH) – bei Zeitlimit, 5xx
 * oder ECONNRESET kann HA den Befehl bereits ausgeführt haben, ein zweiter Versuch würde ihn verdoppeln. Für toggle,
 * increase_*, decrease_*, *step*, press und trigger ist selbst dieses Restrisiko zu hoch: ein zweiter Versuch kippt
 * den Zustand zurück oder löst doppelt aus. Höchstens zwei Versuche, damit ein Schaltbefehl nie minutenlang nachläuft.
 */
function haPost<T>(path: string, body: unknown, service: string): Promise<T> {
  const wiederholbar = istIdempotent(service);
  return mitWiederholung("ha.post", () => anfrage<T>(path, body), {
    versuche: wiederholbar ? 2 : 1,
    ...BACKOFF,
    ..._testOptionen,
    wiederholen: (e) => wiederholbar && NICHT_ZUGESTELLT.has(ursacheCode(e) ?? ""),
  });
}

interface HaState {
  entity_id: string;
  state: string;
  attributes: { friendly_name?: string; unit_of_measurement?: string };
}

/** Zustände aller Geräte, optional gefiltert nach Text (Name, ID oder Domain). */
export async function haStates(filter?: string): Promise<string> {
  const states = await haGet<HaState[]>("states");
  const f = filter?.toLowerCase();
  const rows = states
    .filter((s) => !f || s.entity_id.toLowerCase().includes(f) || s.attributes.friendly_name?.toLowerCase().includes(f))
    .filter((s) => !/^(update|persistent_notification|tts|conversation|event)\./.test(s.entity_id))
    .slice(0, 80)
    .map((s) => `${s.entity_id} · ${s.attributes.friendly_name ?? ""} · ${s.state}${s.attributes.unit_of_measurement ? " " + s.attributes.unit_of_measurement : ""}`);
  return rows.join("\n") || "Keine passenden Geräte.";
}

/** Dienst aufrufen, z. B. light.turn_on für light.buero. */
export async function haService(entityId: string, service: string, data: Record<string, unknown> = {}): Promise<string> {
  const domain = entityId.split(".")[0];
  if (!domain || !/^[a-z_]+$/.test(domain) || !/^[a-z_]+$/.test(service)) throw new Error("Ungültige entity_id oder Dienst.");
  await haPost(`services/${domain}/${service}`, { entity_id: entityId, ...data }, service);
  return `${service} auf ${entityId} ausgeführt`;
}

export const haDomain = (entityId: string) => entityId.split(".")[0] ?? "";

/** Zustand einer einzelnen Entität, z. B. person.labinot → "home" */
export async function haState(entityId: string): Promise<string> {
  const s = await haGet<HaState>(`states/${entityId}`);
  return s.state;
}

/** Ist jemand zu Hause? Ohne HA_PRESENCE_ENTITY gilt: unbekannt → true. Fehler melden sich über haState an die Gesundheit. */
export async function isHome(): Promise<boolean> {
  if (!config.presenceEntity || !config.homeAssistant) return true;
  try {
    return (await haState(config.presenceEntity)) === "home";
  } catch {
    return true;
  }
}
