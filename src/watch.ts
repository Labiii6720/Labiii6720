import mqtt from "mqtt";
import { allWachen, bedingungWert, cameraByFrigateName, dynamicWachen, eventSnapshot, look, ruheMinuten, snapshot, wacheZustand, type Wache } from "./cameras.js";
import { config } from "./config.js";
import { isHome } from "./homeassistant.js";
import { notfallAktiv } from "./notfall.js";
import { fehlerDetail, gesundheit, schwaerze, voruebergehend } from "./robust.js";
import { state } from "./state.js";
import { sendPhoto, sendText, sendeSpaeter } from "./telegram.js";
import { minutesOfDay } from "./time.js";

// Fehlertexte können Zugangsdaten enthalten (z. B. fetch mit FRIGATE_URL http://user:pw@…) – vor dem Loggen schwärzen
const log = (e: unknown) => console.error(schwaerze(e instanceof Error ? e.message : String(e)));

/**
 * Notaus oder Notfall? Vor jedem Schritt nach einem langen await erneut prüfen: /pause oder /notfall kann während
 * bedingung/snapshot/look eintreffen, und danach darf kein Kamerabild mehr an die API, an Telegram oder in den Postausgang.
 */
const gestoppt = () => Boolean(state.paused) || notfallAktiv();

/** Gilt die Bedingung gerade? Ungültige Werte gelten nie (nie stillschweigend wie «abwesend»). */
export async function bedingung(b: unknown = "immer"): Promise<boolean> {
  const g = bedingungWert(b);
  if (g === undefined) return false;
  if (g === "immer") return true;
  if (g === "nacht") {
    const m = minutesOfDay();
    return state.mode === "nacht" || m >= 22 * 60 || m < 6 * 60;
  }
  return !(await isHome()); // abwesend
}

/** Einmal pro Schlüssel laut melden (nie Frage-Text oder Rohwert), danach still: sonst eine Logzeile pro Takt oder Ereignis. */
const ungueltigGemeldet = new Set<string>();
function einmalMelden(schluessel: string, text: string): void {
  if (ungueltigGemeldet.has(schluessel)) return;
  ungueltigGemeldet.add(schluessel);
  console.error(text);
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
  if (gestoppt()) return false;
  const found = cameraByFrigateName(ev.camera);
  if (!found) return false;
  const [name, cam] = found;
  const rule = cam.melden;
  if (!rule || !rule.labels.includes(ev.label)) return false;
  if (rule.zonen?.length && !ev.zones?.some((z) => rule.zonen!.includes(z))) return false;
  if (ev.id && seenEvents.has(ev.id)) return false;
  if (bedingungWert(rule.nur_wenn) === undefined) {
    einmalMelden(`melden|${name}`, `cameras.json: «melden.nur_wenn» bei Kamera «${name}» ungültig (erlaubt: immer, abwesend, nacht) – ihre Meldungen bleiben aus, bis der Eintrag repariert ist.`);
    return false;
  }
  if (!(await bedingung(rule.nur_wenn))) return false;
  if (gestoppt()) return false;

  const key = `${name}:${ev.label}`;
  // Text oder Objekt in cameras.json ergäben sonst NaN, und jedes neue Ereignis ginge hinaus: Standard 10 Minuten
  const ruhe = ruheMinuten(rule.ruhe_minuten, 10) * 60_000;
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
  if (gestoppt()) return false;
  if (image && rule.beschreiben) {
    const seen = await look(name, "Beschreib in einem Satz, was zu sehen ist.", image).catch(() => undefined);
    if (seen) caption += `\n${seen.text}`;
    if (gestoppt()) return false;
  }
  const buttons = ev.id ? { reply_markup: { inline_keyboard: [[{ text: "🎬 Clip", callback_data: `clip:${ev.id}` }]] } } : {};
  // Scheitert das Bild trotz Wiederholung (Telegram/Internet weg), geht wenigstens der Text in den Postausgang –
  // eine Erkennung darf nicht spurlos verloren gehen. Ausser der Notaus kam während der Sendeversuche: dann nichts nachreichen.
  const ausweichen = () => (gestoppt() ? undefined : sendeSpaeter(caption));
  if (image) await sendPhoto(image, caption, buttons).catch(ausweichen);
  // Text ohne Bild: mit Clip-Knopf direkt (der Postausgang kennt keine Knöpfe); scheitert das trotz Wiederholung,
  // wird der Text ohne Knopf nachgereicht – ein Clip-Knopf Stunden später hilft ohnehin nicht mehr.
  else if (ev.id) await sendText(caption, buttons).catch(ausweichen);
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

/** Regel für die Ruhezeit nach einer Meldung; liegt in cameras.ts (gemeinsam mit der Kommandozentrale), hier weiter erreichbar. */
export { ruheMinuten };

export async function wachenTick(now = Date.now()): Promise<void> {
  if (!config.frigateUrl || gestoppt()) return;
  /**
   * Wurde die Wache gelöscht (Kommandozentrale oder freigegebenes wache_loeschen), während der Tick auf bedingung/snapshot/look
   * wartete? allWachen() ist eine Momentaufnahme mit denselben Objekten wie dynamicWachen – fehlt ein beim Tick-Start
   * dynamisches Objekt dort, geht kein Bild mehr an die API (wie zeitplanTick bei gelöschten Zeitplänen).
   * Nur die beim Start dynamischen Objekte zählen: Wachen aus cameras.json sind jedes Mal neue Objekte und dürfen
   * nie als gelöscht gelten, auch wenn dort (etwa aus data/wachen.json kopiert) ein Feld «id» steht.
   */
  const dynamisch = new Set<Wache>(dynamicWachen);
  const geloescht = (w: Wache) => dynamisch.has(w) && !dynamicWachen.includes(w);
  for (const w of allWachen()) {
    // Kommt während einer Wache /pause oder /notfall, läuft keine weitere mehr (kein neues Bild an die API)
    if (gestoppt()) return;
    if (geloescht(w)) continue;
    const key = `${w.kamera}|${w.frage}`;
    // Gemeinsame Regel (wacheZustand): Kamera fehlt oder verworfen → still überspringen, ohne Intervall → einmal melden
    const { takt, grund } = wacheZustand(w);
    if (grund === "Kamera fehlt" || grund === "Kamera und Intervall fehlen") continue;
    if (takt === undefined) {
      // Einmal laut melden (ohne Frage-Text), dann still überspringen – kein Bild an die API
      einmalMelden(key, `Wache bei Kamera «${w.kamera}» ohne gültiges «alle_minuten» – sie schaut nicht hin, bis der Eintrag repariert ist.`);
      continue;
    }
    if (bedingungWert(w.nur_wenn) === undefined) {
      // Ungültiges «nur_wenn» (null, «Nacht» …): nie stillschweigend wie «abwesend» – einmal melden, dann still überspringen
      einmalMelden(`${key}|nur_wenn`, `Wache bei Kamera «${w.kamera}» mit ungültigem «nur_wenn» (erlaubt: immer, abwesend, nacht) – sie schaut nicht hin, bis der Eintrag repariert ist.`);
      continue;
    }
    if (grund === "Frage fehlt") {
      // Ohne Frage ginge «undefined» mit dem Standbild an die API – einmal melden (ohne Frage-Inhalt), dann still überspringen
      einmalMelden(`${w.kamera}|frage|${String(w.alle_minuten)}`, `Wache bei Kamera «${w.kamera}» ohne «frage» – sie schaut nicht hin, bis der Eintrag repariert ist.`);
      continue;
    }
    if (now - (lastRun.get(key) ?? 0) < takt * 60_000) continue;
    lastRun.set(key, now);
    if (!(await bedingung(w.nur_wenn))) continue;
    if (gestoppt()) return;
    if (geloescht(w)) continue;
    try {
      // Standbild selbst holen und danach erneut prüfen: Der Frigate-Abruf dauert (Zeitlimit, Wiederholungen), und
      // claudeAufruf prüft beim ersten Versuch weder Notaus noch Notfall – ein inzwischen gestopptes oder gelöschtes
      // Wachen-Bild darf nicht mehr an die API (wie onCameraEvent: erst snapshot, dann gestoppt, dann look mit Bild)
      const bild = await snapshot(w.kamera);
      if (gestoppt()) return;
      if (geloescht(w)) continue;
      const r = await look(w.kamera, `${w.frage}\nErste Zeile: nur JA oder NEIN. Zweite Zeile: ein Satz Begründung.`, bild);
      const ja = /^\s*ja\b/i.test(r.text);
      if (gestoppt()) return;
      // Während look() gelöscht: keine Meldung mehr für eine Wache, die der Nutzer nicht mehr will
      if (!ja || geloescht(w)) continue;
      const ruhe = ruheMinuten(w.ruhe_minuten) * 60_000;
      if (now - (lastHit.get(key) ?? 0) < ruhe) continue;
      lastHit.set(key, now);
      const text = `👁 ${w.kamera}: ${w.frage}\n${r.text.replace(/^\s*ja\b[.:,\s-]*/i, "").trim()}`;
      // lastHit ist schon gesetzt (Ruhezeit) – scheitert das Bild, muss der Text deshalb über den Postausgang nachkommen
      await sendPhoto(r.image, text).catch(() => (gestoppt() ? undefined : sendeSpaeter(text)));
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
