import mqtt from "mqtt";
import { allWachen, cameraByFrigateName, cameras, eventSnapshot, look, snapshot, type Bedingung } from "./cameras.js";
import { config } from "./config.js";
import { isHome } from "./homeassistant.js";
import { fehlerDetail, gesundheit, schwaerze, voruebergehend } from "./robust.js";
import { state } from "./state.js";
import { sendPhoto, sendText, sendeSpaeter } from "./telegram.js";
import { minutesOfDay } from "./time.js";

// Fehlertexte können Zugangsdaten enthalten (z. B. fetch mit FRIGATE_URL http://user:pw@…) – vor dem Loggen schwärzen
const log = (e: unknown) => console.error(schwaerze(e instanceof Error ? e.message : String(e)));

/** Gilt die Bedingung gerade? */
export async function bedingung(b: Bedingung = "immer"): Promise<boolean> {
  if (b === "immer") return true;
  if (b === "nacht") {
    const m = minutesOfDay();
    return state.mode === "nacht" || m >= 22 * 60 || m < 6 * 60;
  }
  return !(await isHome()); // abwesend
}

// ---------- Ereignisse (melden) ----------

const lastAlert = new Map<string, number>();
const seenEvents = new Set<string>();

export interface CameraEvent {
  camera: string;
  label: string;
  zones?: string[];
  id?: string;
  hasSnapshot?: boolean;
}

/** Ein Frigate-Ereignis prüfen und ggf. mit Bild melden. Gibt zurück, ob gemeldet wurde. */
export async function onCameraEvent(ev: CameraEvent): Promise<boolean> {
  if (state.paused) return false;
  const found = cameraByFrigateName(ev.camera);
  if (!found) return false;
  const [name, cam] = found;
  const rule = cam.melden;
  if (!rule || !rule.labels.includes(ev.label)) return false;
  if (rule.zonen?.length && !ev.zones?.some((z) => rule.zonen!.includes(z))) return false;
  if (ev.id && seenEvents.has(ev.id)) return false;
  if (!(await bedingung(rule.nur_wenn))) return false;

  const key = `${name}:${ev.label}`;
  const ruhe = (rule.ruhe_minuten ?? 10) * 60_000;
  if (Date.now() - (lastAlert.get(key) ?? 0) < ruhe) return false;
  lastAlert.set(key, Date.now());
  if (ev.id) seenEvents.add(ev.id);
  if (seenEvents.size > 500) seenEvents.clear();

  const time = new Date().toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
  let caption = `📷 ${ev.label} · ${name}${ev.zones?.length ? " · Zone " + ev.zones.join("/") : ""} · ${time}`;
  let image: Buffer | undefined;
  try {
    image = ev.id && ev.hasSnapshot !== false ? await eventSnapshot(ev.id).catch(() => snapshot(name)) : await snapshot(name);
  } catch (e) {
    log(e);
  }
  if (image && rule.beschreiben) {
    const seen = await look(name, "Beschreib in einem Satz, was zu sehen ist.", image).catch(() => undefined);
    if (seen) caption += `\n${seen.text}`;
  }
  const buttons = ev.id ? { reply_markup: { inline_keyboard: [[{ text: "🎬 Clip", callback_data: `clip:${ev.id}` }]] } } : {};
  // Scheitert das Bild trotz Wiederholung (Telegram/Internet weg), geht wenigstens der Text in den Postausgang –
  // eine Erkennung darf nicht spurlos verloren gehen.
  if (image) await sendPhoto(image, caption, buttons).catch(() => sendeSpaeter(caption));
  // Text ohne Bild: mit Clip-Knopf direkt (der Postausgang kennt keine Knöpfe); scheitert das trotz Wiederholung,
  // wird der Text ohne Knopf nachgereicht – ein Clip-Knopf Stunden später hilft ohnehin nicht mehr.
  else if (ev.id) await sendText(caption, buttons).catch(() => sendeSpaeter(caption));
  else await sendeSpaeter(caption);
  return true;
}

/** Frigate-Nachricht aus MQTT (frigate/events) in ein Kamera-Ereignis übersetzen; null = nicht relevant */
export function parseFrigateMessage(payload: string): CameraEvent | null {
  const msg = JSON.parse(payload) as { type: string; before?: { current_zones?: string[] }; after?: { id: string; camera: string; label: string; current_zones?: string[]; entered_zones?: string[]; has_snapshot?: boolean } };
  const a = msg.after;
  if (!a) return null;
  const zonesNow = a.current_zones ?? [];
  const zonesBefore = msg.before?.current_zones ?? [];
  const enteredZone = zonesNow.some((z) => !zonesBefore.includes(z));
  if (msg.type !== "new" && !(msg.type === "update" && enteredZone)) return null;
  return { camera: a.camera, label: a.label, zones: a.entered_zones?.length ? a.entered_zones : zonesNow, id: a.id, hasSnapshot: a.has_snapshot };
}

/** Das Wenige, das die Ereignisverarbeitung vom MQTT-Client braucht (damit Tests eine Attrappe anhängen können). */
export interface MqttClientLike {
  on(event: "connect", cb: () => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
  on(event: "offline" | "reconnect", cb: () => void): unknown;
  on(event: "message", cb: (topic: string, payload: Buffer) => void): unknown;
  subscribe(topic: string): unknown;
}

/** MQTT-Fehlertexte können die Broker-URL samt Zugangsdaten enthalten – schwaerze() nimmt den Nutzerteil, hier zusätzlich das rohe Passwort. */
function mqttDetail(e: unknown): string {
  let text = fehlerDetail(e);
  const pw = config.mqtt?.password;
  if (pw && pw.length >= 4) text = text.split(pw).join("<geheim>");
  return text;
}

/**
 * Hängt die Ereignisverarbeitung an einen MQTT-Client. Verbindungsfehler laufen nur über die Gesundheit
 * (eine Logzeile pro Störung, nicht pro Wiederholungsversuch alle 5 s); `connect` meldet die Erholung.
 */
export function bindeMqtt(client: MqttClientLike): void {
  client.on("connect", () => {
    client.subscribe("frigate/events");
    gesundheit.melde("mqtt", true);
    console.log("MQTT verbunden, Frigate-Ereignisse aktiv");
  });
  client.on("error", (e) => gesundheit.melde("mqtt", false, mqttDetail(e)));
  client.on("offline", () => gesundheit.melde("mqtt", false, "Verbindung verloren"));
  client.on("reconnect", () => gesundheit.melde("mqtt", false, "Verbindung wird neu aufgebaut"));
  client.on("message", (_topic, payload) => {
    try {
      const ev = parseFrigateMessage(payload.toString());
      if (ev) void onCameraEvent(ev).catch(log);
    } catch (e) {
      log(e);
    }
  });
}

export function startMqtt(): void {
  if (!config.mqtt) return;
  bindeMqtt(mqtt.connect(config.mqtt.url, { username: config.mqtt.username, password: config.mqtt.password, reconnectPeriod: 5000 }));
}

// ---------- Wachen (regelmässig hinschauen) ----------

const lastRun = new Map<string, number>();
const lastHit = new Map<string, number>();

export async function wachenTick(now = Date.now()): Promise<void> {
  if (!config.frigateUrl || state.paused) return;
  for (const w of allWachen()) {
    const key = `${w.kamera}|${w.frage}`;
    if (!cameras[w.kamera]) continue;
    if (now - (lastRun.get(key) ?? 0) < Math.max(1, w.alle_minuten) * 60_000) continue;
    lastRun.set(key, now);
    if (!(await bedingung(w.nur_wenn))) continue;
    try {
      const r = await look(w.kamera, `${w.frage}\nErste Zeile: nur JA oder NEIN. Zweite Zeile: ein Satz Begründung.`);
      const ja = /^\s*ja\b/i.test(r.text);
      if (!ja) continue;
      const ruhe = (w.ruhe_minuten ?? 30) * 60_000;
      if (now - (lastHit.get(key) ?? 0) < ruhe) continue;
      lastHit.set(key, now);
      const text = `👁 ${w.kamera}: ${w.frage}\n${r.text.replace(/^\s*ja\b[.:,\s-]*/i, "").trim()}`;
      // lastHit ist schon gesetzt (Ruhezeit) – scheitert das Bild, muss der Text deshalb über den Postausgang nachkommen
      await sendPhoto(r.image, text).catch(() => sendeSpaeter(text));
    } catch (e) {
      // Vorübergehende Störungen (Frigate, Claude, Telegram) loggt bereits die Gesundheit – sonst eine Zeile pro Wache und Minute
      if (!voruebergehend(e)) log(e);
    }
  }
}

export function startWatch(): void {
  startMqtt();
  setInterval(() => wachenTick().catch(log), 60_000);
}
