import { config } from "./config.js";

function ha() {
  if (!config.homeAssistant) throw new Error("Home Assistant ist nicht eingerichtet (HA_URL, HA_TOKEN).");
  return config.homeAssistant;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const { url, token } = ha();
  const res = await fetch(`${url}/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Home Assistant HTTP ${res.status} (${path})`);
  return (await res.json()) as T;
}

interface HaState {
  entity_id: string;
  state: string;
  attributes: { friendly_name?: string; unit_of_measurement?: string };
}

/** Zustände aller Geräte, optional gefiltert nach Text (Name, ID oder Domain). */
export async function haStates(filter?: string): Promise<string> {
  const states = await call<HaState[]>("states");
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
  await call(`services/${domain}/${service}`, { entity_id: entityId, ...data });
  return `${service} auf ${entityId} ausgeführt`;
}

export const haDomain = (entityId: string) => entityId.split(".")[0] ?? "";

/** Zustand einer einzelnen Entität, z. B. person.labinot → "home" */
export async function haState(entityId: string): Promise<string> {
  const s = await call<HaState>(`states/${entityId}`);
  return s.state;
}

/** Ist jemand zu Hause? Ohne HA_PRESENCE_ENTITY gilt: unbekannt → true */
export async function isHome(): Promise<boolean> {
  if (!config.presenceEntity || !config.homeAssistant) return true;
  try {
    return (await haState(config.presenceEntity)) === "home";
  } catch {
    return true;
  }
}
