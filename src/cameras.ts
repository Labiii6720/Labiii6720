import Anthropic from "@anthropic-ai/sdk";
import { anthropic as claude, claudeAufruf, trackUsage } from "./claude.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { config } from "./config.js";
import { gesperrtText, gueltigeEintraege, kameraWacheEintrag, ladeListe, vermerkeUebersprungen, wacheEintrag, zahlOderZiffern } from "./datei.js";
import { HttpFehler, mitWiederholung, retryAfterAusHeader, type WiederholOptionen } from "./robust.js";
import { save, state } from "./state.js";

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
  /** Wo die dynamische Wache angelegt wurde; ältere Einträge ohne Angabe stammen aus dem Chat */
  quelle?: "dashboard" | "chat";
}

export interface Camera {
  frigate: string;
  beschreibung: string;
  melden?: Melden;
  wachen?: Omit<Wache, "kamera" | "id">[];
}

/** true, wenn cameras.json vorhanden, aber unlesbar war: dann laufen keine Meldungen und keine Wachen aus der Datei. */
export let camerasNichtGeladen = false;

/**
 * Wachen einer Kamera aus cameras.json, die dieselbe Eintragsprüfung bestehen wie data/wachen.json (kameraWacheEintrag in
 * datei.ts: Objekt, «frage» als Text, «alle_minuten» als Zahl); null, fehlende Kamera oder «wachen» ohne Liste ergeben keine.
 */
function wachenAusDatei(c: unknown): Record<string, unknown>[] {
  const liste = c !== null && typeof c === "object" ? (c as { wachen?: unknown }).wachen : undefined;
  return Array.isArray(liste) ? gueltigeEintraege(liste, kameraWacheEintrag).gueltig : [];
}

/** Ungültige Wachen-Einträge in cameras.json laut melden (nur Kamera und Anzahl, nie Inhalt): sie laufen nicht. Rückgabe: Anzahl. */
function meldeUngueltigeWachen(roh: Record<string, Camera>): number {
  let summe = 0;
  for (const [kamera, c] of Object.entries(roh)) {
    const liste = c !== null && typeof c === "object" ? (c as { wachen?: unknown }).wachen : undefined;
    if (liste === undefined) continue;
    const ungueltig = Array.isArray(liste) ? liste.length - wachenAusDatei(c).length : 1;
    summe += ungueltig;
    if (ungueltig > 0) console.error(`cameras.json: ${ungueltig} ungültige(r) Wachen-Eintrag/Einträge bei Kamera «${kamera}» übersprungen (kein Objekt, «frage» ohne Text oder «alle_minuten» ohne Zahl, bzw. «wachen» keine Liste).`);
  }
  return summe;
}

/**
 * Takt einer Wache in Minuten, oder undefined, wenn «alle_minuten» fehlt oder unbrauchbar ist. Wachen aus cameras.json
 * und von Hand bearbeitete Einträge in data/wachen.json laufen nie durch pruefeWache: Ohne diese Prüfung ergäbe ein
 * Tippfehler («alle_minuen»), null oder Text NaN, die Wache würde nie übersprungen und schickte jede Minute ein
 * Standbild an die API. Zahl oder Ziffernfolge > 0 wie bisher (mindestens 1 Minute), alles andere läuft nicht.
 * Dieselbe Regel gilt für den Takt (watch.ts), die Ladeprüfung und die Anzeige in der Kommandozentrale.
 */
export function taktMinuten(v: unknown): number | undefined {
  const n = zahlOderZiffern(v);
  return n !== undefined && n > 0 ? Math.max(1, n) : undefined;
}

/**
 * Ruhezeit in Minuten nach einer Meldung (Wache: Standard 30, Kamera-Meldung «melden»: Standard 10). Einträge in
 * cameras.json und von Hand bearbeitete in data/wachen.json laufen nie durch pruefeWache: «ruhe_minuten» als Text
 * ("oft"), Objekt oder null ergäbe sonst NaN bzw. 0 – keine Ruhezeit, jedes Ereignis ginge mit Bild an Telegram.
 * Endliche Zahl gilt (negativ heisst keine Ruhezeit, also 0), alles andere ergibt den Standard. Dieselbe Regel gilt
 * für den Takt (watch.ts) und die Anzeige in der Kommandozentrale.
 */
export function ruheMinuten(v: unknown, standard = 30): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : standard;
}

/** Steht die Kamera als gültiger Eintrag in cameras.json? Nur eigene Schlüssel, nie «toString» & Co. aus dem Prototyp. */
export function kameraBekannt(name: unknown): boolean {
  return Object.hasOwn(cameras, String(name)) && Boolean(cameras[String(name)]);
}

export const BEDINGUNGEN: readonly Bedingung[] = ["immer", "abwesend", "nacht"];

/**
 * Gültige Bedingung oder undefined. Wachen und «melden» aus cameras.json sowie von Hand bearbeitete (oder unter 0.21
 * ungeprüft gespeicherte) Einträge in data/wachen.json laufen nie durch pruefeWache: null, «Nacht» oder «nachts» fielen
 * sonst auf «abwesend» durch – ohne Präsenz-Entität (isHome() = true) schaute die Wache nie hin, mit ihr stillschweigend
 * nur bei Abwesenheit. Fehlt das Feld, gilt «immer»; alles andere ist ungültig und läuft nicht. Gemeinsame Regel für
 * den Takt (watch.ts), die Ladeprüfung, den Selbsttest, die Kommandozentrale und wachen_anzeigen.
 */
export function bedingungWert(v: unknown): Bedingung | undefined {
  if (v === undefined) return "immer";
  return typeof v === "string" && (BEDINGUNGEN as readonly string[]).includes(v) ? (v as Bedingung) : undefined;
}

export type WacheGrund = "Intervall fehlt" | "Kamera fehlt" | "Kamera und Intervall fehlen" | "Bedingung ungültig" | "Frage fehlt";

/**
 * Hat die Wache eine Frage? Wachen aus cameras.json und von Hand bearbeitete Einträge in data/wachen.json laufen nie
 * durch pruefeWache: Ohne diese Prüfung ginge bei fehlender (oder leerer, nicht-textlicher) «frage» alle paar Minuten
 * ein Standbild mit der Frage «undefined» an die API (Leitplanke 9).
 */
const frageDa = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

/**
 * Läuft eine Wache, und wenn nicht, warum? Gemeinsame Regel für den Takt (watch.ts), den Selbsttest (check.ts), die
 * Kommandozentrale und das Werkzeug wachen_anzeigen: Sie braucht eine Kamera, die in cameras.json steht und beim Laden
 * nicht verworfen wurde, ein gültiges «alle_minuten» (taktMinuten), ein gültiges «nur_wenn» (bedingungWert) und eine
 * nicht leere «frage». Reihenfolge wie im Takt: Kamera und Intervall gehen vor der Bedingung, die Bedingung vor der Frage.
 */
export function wacheZustand(w: Pick<Wache, "kamera" | "alle_minuten" | "nur_wenn" | "frage">): { takt: number | undefined; laeuft: boolean; grund?: WacheGrund } {
  const takt = taktMinuten(w.alle_minuten);
  const kameraDa = kameraBekannt(w.kamera);
  if (!kameraDa || takt === undefined) return { takt, laeuft: false, grund: kameraDa ? "Intervall fehlt" : takt === undefined ? "Kamera und Intervall fehlen" : "Kamera fehlt" };
  if (bedingungWert(w.nur_wenn) === undefined) return { takt, laeuft: false, grund: "Bedingung ungültig" };
  if (!frageDa(w.frage)) return { takt, laeuft: false, grund: "Frage fehlt" };
  return { takt, laeuft: true };
}

/** true, wenn die Wache wirklich hinschaut (siehe wacheZustand). */
export const wacheLaeuft = (w: Pick<Wache, "kamera" | "alle_minuten" | "nur_wenn" | "frage">): boolean => wacheZustand(w).laeuft;

/** Wachen ohne gültiges «alle_minuten» beim Laden melden (nur Herkunft, Kamera und Anzahl, nie die Frage): sie laufen nicht, bleiben aber stehen. */
function meldeOhneTakt(herkunft: string, wachen: { kamera: unknown; w: Record<string, unknown> }[]): void {
  const jeKamera = new Map<string, number>();
  for (const { kamera, w } of wachen) {
    if (taktMinuten(w.alle_minuten) !== undefined) continue;
    const k = typeof kamera === "string" ? kamera : "?";
    jeKamera.set(k, (jeKamera.get(k) ?? 0) + 1);
  }
  for (const [k, n] of jeKamera) console.error(`${herkunft}: ${n} Wache(n) bei Kamera «${k}» ohne gültiges «alle_minuten» – sie schauen nicht hin, bis der Eintrag repariert ist.`);
}

/** Wachen mit ungültigem «nur_wenn» beim Laden melden (nur Herkunft, Kamera und Anzahl, nie Frage oder Rohwert): sie schauen nicht hin. */
function meldeUngueltigeBedingung(herkunft: string, wachen: { kamera: unknown; w: Record<string, unknown> }[]): void {
  const jeKamera = new Map<string, number>();
  for (const { kamera, w } of wachen) {
    if (bedingungWert(w.nur_wenn) !== undefined) continue;
    const k = typeof kamera === "string" ? kamera : "?";
    jeKamera.set(k, (jeKamera.get(k) ?? 0) + 1);
  }
  for (const [k, n] of jeKamera) console.error(`${herkunft}: ${n} Wache(n) bei Kamera «${k}» mit ungültigem «nur_wenn» (erlaubt: immer, abwesend, nacht) – sie schauen nicht hin, bis der Eintrag repariert ist.`);
}

/** Wachen ohne «frage» (fehlend, leer oder kein Text) beim Laden melden (nur Herkunft, Kamera und Anzahl): sie schauen nicht hin. */
function meldeOhneFrage(herkunft: string, wachen: { kamera: unknown; w: Record<string, unknown> }[]): void {
  const jeKamera = new Map<string, number>();
  for (const { kamera, w } of wachen) {
    if (frageDa(w.frage)) continue;
    const k = typeof kamera === "string" ? kamera : "?";
    jeKamera.set(k, (jeKamera.get(k) ?? 0) + 1);
  }
  for (const [k, n] of jeKamera) console.error(`${herkunft}: ${n} Wache(n) bei Kamera «${k}» ohne «frage» – sie schauen nicht hin, bis der Eintrag repariert ist.`);
}

/** «melden» einer Kamera mit ungültigem «nur_wenn» beim Laden melden (nur der Name, nie der Rohwert): ihre Meldungen bleiben aus. */
function meldeUngueltigesMelden(kameras: Record<string, Camera>): void {
  for (const [name, c] of Object.entries(kameras)) {
    const m = (c as { melden?: unknown }).melden;
    if (m === null || typeof m !== "object") continue;
    if (bedingungWert((m as { nur_wenn?: unknown }).nur_wenn) === undefined) console.error(`cameras.json: «melden.nur_wenn» bei Kamera «${name}» ungültig (erlaubt: immer, abwesend, nacht) – ihre Meldungen bleiben aus, bis der Eintrag repariert ist.`);
  }
}

/** Ein Kamera-Eintrag in cameras.json muss ein Objekt sein; null, Zahl, Text oder Liste (Handeingriff) fallen weg. */
const istKameraEintrag = (c: unknown): boolean => c !== null && typeof c === "object" && !Array.isArray(c);

/**
 * Kamera-Einträge ohne Objekt-Form verwerfen und laut melden (nur der Name, nie Inhalt). camerasNichtGeladen bleibt
 * dabei aus: Die übrigen Kameras samt Meldungen und Wachen laufen weiter, wie bei ungültigen Wachen-Einträgen. Ohne
 * diese Prüfung würfen cameraByFrigateName (jedes Frigate-Ereignis), describeCameras und /status.json bei {"garten": null}.
 * Object.fromEntries legt jeden Namen als eigene Eigenschaft an, auch «__proto__» (wie JSON.parse): Eine Zuweisung
 * `gueltig[name] = c` riefe dort den Prototyp-Setter auf – die Kamera verschwände still, und cameras erbte ihre Felder.
 */
function nurGueltigeKameras(roh: Record<string, unknown>): Record<string, Camera> {
  return Object.fromEntries(
    Object.entries(roh).filter(([name, c]) => {
      if (istKameraEintrag(c)) return true;
      console.error(`cameras.json: Kamera «${name}» übersprungen (Eintrag ist kein Objekt) – für sie laufen weder Meldungen noch Wachen.`);
      return false;
    }),
  ) as Record<string, Camera>;
}

/**
 * cameras.json schreibt Jarvis nie: übersprungene Kameras und Wachen nur zählen und als Hinweis bereitstellen (wie die
 * Listen in data/, dort zusätzlich mit Sicherung), damit /status, Startmeldung und npm run check sie nennen.
 */
function ladeKameras(): Record<string, Camera> {
  vermerkeUebersprungen("cameras.json", 0, false);
  try {
    const roh = JSON.parse(readFileSync("cameras.json", "utf8")) as unknown;
    if (!roh || typeof roh !== "object" || Array.isArray(roh)) throw new Error("kein Objekt");
    const kameras = nurGueltigeKameras(roh as Record<string, unknown>);
    const ohneKamera = Object.keys(roh).length - Object.keys(kameras).length;
    vermerkeUebersprungen("cameras.json", ohneKamera + meldeUngueltigeWachen(kameras), false);
    const ausDatei = Object.entries(kameras).flatMap(([kamera, c]) => wachenAusDatei(c).map((w) => ({ kamera, w })));
    meldeOhneTakt("cameras.json", ausDatei);
    meldeUngueltigeBedingung("cameras.json", ausDatei);
    meldeOhneFrage("cameras.json", ausDatei);
    meldeUngueltigesMelden(kameras);
    return kameras;
  } catch (e) {
    // Fehlende Datei heisst «keine Kameras»; alles andere laut melden (Inhalt nie ins Log)
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    camerasNichtGeladen = true;
    console.error(`cameras.json unlesbar (${(e as NodeJS.ErrnoException).code ?? "ungültiges JSON"}) – Jarvis startet ohne Kameras, Meldungen und Wachen aus der Datei sind aus.`);
    return {};
  }
}

export const cameras: Record<string, Camera> = ladeKameras();
export const hasCameras = () => Boolean(config.frigateUrl) && Object.keys(cameras).length > 0;

export function cameraByFrigateName(name: string): [string, Camera] | undefined {
  return Object.entries(cameras).find(([key, c]) => c.frigate === name || key === name);
}

export function describeCameras(): string {
  return (
    Object.entries(cameras)
      .map(([k, c]) => {
        const f = ["schauen"];
        if (c.melden) f.push(`melden (${c.melden.labels.join(", ")}${c.melden.zonen ? ", Zonen " + c.melden.zonen.join("/") : ""}, ${bedingungWert(c.melden.nur_wenn) ?? "Bedingung ungültig"})`);
        // Nur gültige Einträge zählen (wie allWachen); übersprungene Einträge laufen nicht
        const wachen = wachenAusDatei(c).length;
        if (wachen) f.push(`${wachen} Wache(n)`);
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

/** Nur für Tests: Warten und Zufall des Backoffs injizieren (im Betrieb leer). */
export const _testOptionen: Pick<WiederholOptionen, "warten" | "zufall"> = {};

/**
 * Frigate-GET ist nebenwirkungsfrei: zwei Versuche bei Netz-, Zeitlimit- und Serverfehlern.
 * Der Body wird innerhalb des Versuchs gelesen: Das Zeitlimit gilt auch für den Download, und ein Abbruch
 * mittendrin (z. B. clip.mp4 bei schwachem WLAN) soll wiederholt und an die Gesundheit gemeldet werden.
 */
async function frigateGet<T>(path: string, timeoutMs: number, lesen: (res: Response) => Promise<T>, label = path.split("?")[0]): Promise<T> {
  return mitWiederholung("frigate.get", async () => {
    const res = await fetch(`${frigate()}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new HttpFehler(`Frigate HTTP ${res.status} (${label})`, res.status, retryAfterAusHeader(res.headers));
    return lesen(res);
  }, { versuche: 2, komponente: "frigate", ..._testOptionen });
}

async function bytes(path: string, timeoutMs = 15_000): Promise<Buffer> {
  return frigateGet(path, timeoutMs, async (res) => Buffer.from(await res.arrayBuffer()));
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
  return frigateGet(`/api/events?${q}`, 15_000, async (res) => (await res.json()) as FrigateEvent[], "events");
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
  const msg = await claudeAufruf("sehen", () => anthropic.messages.create(
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
  ));
  trackUsage(msg);
  return { text: msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim(), image: img };
}

// ---------- Wachen (dynamisch per Werkzeug, zusätzlich zu cameras.json) ----------

const WACHEN_FILE = "data/wachen.json";

/**
 * Per Werkzeug oder Kommandozentrale angelegte Wachen. Einträge prüft ladeListe (wacheEintrag in datei.ts): ohne
 * Objekt-Form, id, kamera und frage als Text oder alle_minuten als Zahl fallen sie beim Laden weg (Sicherung .defekt,
 * Hinweis) – sonst bräche schon der erste Zugriff auf w.id oder w.kamera ab (Start, Ticks, Anzeigen). Ungültige Werte
 * (Intervall 0, leere Frage, falsches «nur_wenn», unbekannte Kamera) bleiben stehen, laufen nicht und werden gemeldet.
 */
const wachenGeladen = ladeListe(WACHEN_FILE, "Wachen", wacheEintrag);
export const dynamicWachen: Wache[] = wachenGeladen.liste;

/**
 * true, wenn data/wachen.json vorhanden, aber unlesbar war (Rechte, abgeschnittenes JSON …). Dann laufen die
 * per Werkzeug angelegten Wachen nicht, und `saveWachen()` verweigert das Schreiben: sonst ersetzte die nächste
 * neue Wache den ganzen Bestand. Übersprungene Einträge sperren nicht.
 */
export const wachenNichtGeladen = wachenGeladen.nichtGeladen;

/** Meldung für Anzeigen, Selbsttest und Werkzeuge, solange die Datei beim Start unlesbar war */
export const WACHEN_UNLESBAR =
  "⚠️ data/wachen.json war beim Start unlesbar, Sir (Sicherung, sofern möglich, unter data/wachen.json.defekt). Die dort angelegten Wachen laufen nicht, und ich ändere keine, bis die Datei repariert ist und ich neu gestartet bin.";

{
  // Ohne gültiges Intervall, mit ungültiger Bedingung oder leerer Frage läuft eine Wache nicht (watch.ts); melden, aber nichts löschen
  const eintraege = dynamicWachen.map((w) => ({ kamera: w.kamera, w: w as unknown as Record<string, unknown> }));
  meldeOhneTakt(WACHEN_FILE, eintraege);
  meldeUngueltigeBedingung(WACHEN_FILE, eintraege);
  meldeOhneFrage(WACHEN_FILE, eintraege);
}

/** Gültige IDs der per Werkzeug angelegten Wachen (zweite Verteidigung: zur Laufzeit angelegte haben immer eine). */
function wachenIds(): number[] {
  return dynamicWachen.flatMap((w) => (Number.isSafeInteger(w?.id) ? [w.id as number] : []));
}

/**
 * Höchste ID im Bestand beim Start (0 ohne Bestand), verworfene Einträge eingeschlossen (wachenGeladen.hoechsteId): Ihre
 * Nummer steht noch in der Sicherung und in alten Freigaben und wird nicht neu vergeben. Beim Import wird bewusst nichts gespeichert: cameras.js laden auch
 * `npm run check` und das Setup, und ein save() dort schriebe den beim Prozessstart gelesenen Zustand zurück – ein
 * inzwischen vom Dienst ausgelöster Notfall oder Notaus wäre auf der Platte weg.
 */
const hoechsteWacheIdBeimStart = wachenNichtGeladen ? 0 : Math.max(wachenGeladen.hoechsteId, 0, ...wachenIds());

/**
 * Ein Bestand aus 0.21 hat keinen Zähler in state.json, und die Löschpfade rücken ihn nicht vor. Darum zieht jedes
 * Speichern der Wachen den Zähler zuerst auf mindestens höchste Start-ID + 1 nach und speichert ihn, bevor die Liste
 * geschrieben wird: Nach dem Löschen der Wache mit der höchsten ID bekommt keine neue Wache diese ID wieder, auch nicht
 * nach einem Neustart. Scheitert das Speichern, bleibt der Zähler wie er war, und der Fehler geht an den Aufrufer
 * (der die Änderung an der Liste zurücknimmt).
 */
function wachenZaehlerNachziehen(): void {
  if (hoechsteWacheIdBeimStart === 0) return;
  const mindestens = hoechsteWacheIdBeimStart + 1;
  const gemerkt = state.naechsteWacheId;
  if (Number.isSafeInteger(gemerkt) && gemerkt! >= mindestens) return;
  state.naechsteWacheId = mindestens;
  try {
    save();
  } catch (e) {
    if (gemerkt === undefined) delete state.naechsteWacheId;
    else state.naechsteWacheId = gemerkt;
    throw e;
  }
}

/** Vor jeder Änderung an dynamicWachen aufrufen: wirft, solange data/wachen.json beim Start unlesbar war. */
export function pruefeWachenSchreibbar(): void {
  if (wachenNichtGeladen) throw new Error(gesperrtText(WACHEN_FILE, "die Wachen"));
}

export function saveWachen(): void {
  pruefeWachenSchreibbar();
  wachenZaehlerNachziehen();
  mkdirSync("data", { recursive: true, mode: 0o700 });
  writeFileSync(`${WACHEN_FILE}.tmp`, JSON.stringify(dynamicWachen, null, 2), { mode: 0o600 });
  renameSync(`${WACHEN_FILE}.tmp`, WACHEN_FILE);
}

/** Neue Wachen-ID, die nie zuvor vergeben war (wie neueZeitplanId in zeitplaene.ts). */
export function neueWacheId(): number {
  const gemerkt = state.naechsteWacheId;
  const vorhanden = wachenIds().map((id) => id + 1);
  const id = Math.max(1, hoechsteWacheIdBeimStart + 1, Number.isSafeInteger(gemerkt) ? gemerkt! : 1, ...vorhanden);
  if (!Number.isSafeInteger(id)) throw new Error("Nummernraum erschöpft, Sir – data/wachen.json prüfen.");
  state.naechsteWacheId = id + 1;
  save();
  return id;
}

/**
 * Alle Wachen: aus cameras.json (ohne ID) und die per Werkzeug angelegten (mit ID). Ein «id» in cameras.json (etwa aus
 * data/wachen.json kopiert) fällt weg: sonst gälte die Wache in Kommandozentrale und Werkzeugen als bearbeitbar.
 * Einträge in cameras.json ohne gültige Form fallen weg (beim Laden gemeldet).
 */
export function allWachen(): Wache[] {
  // Nur geprüfte Einträge: ein null (Handeingriff) liesse sonst die Destrukturierung werfen, und damit stünden alle
  // Wachen still (wachenTick), /status.json und /api/wachen antworteten mit 500
  const fromConfig = Object.entries(cameras).flatMap(([kamera, c]) =>
    wachenAusDatei(c).map((w) => {
      const { id: _id, ...rest } = w;
      return { ...rest, kamera } as Wache;
    }),
  );
  return [...fromConfig, ...dynamicWachen];
}

// ---------- Prüfung (Werkzeug und Kommandozentrale, gleiche Regeln) ----------

export type WacheEingabe = Pick<Wache, "kamera" | "frage" | "alle_minuten" | "nur_wenn" | "ruhe_minuten">;

/** Ganze Zahl in [min, max] (auch als Ziffernfolge im Text), sonst undefined. */
function ganzzahl(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/**
 * Prüft eine Wache, bevor sie angelegt oder geändert wird: kamera muss in cameras.json stehen, frage 1–300 Zeichen,
 * alle_minuten 5–1440, nur_wenn immer|abwesend|nacht (Standard immer), ruhe_minuten 0–1440 (optional). Rein.
 */
export function pruefeWache(eingabe: unknown, bekannt: Record<string, unknown> = cameras): { ok: true; wert: WacheEingabe } | { ok: false; fehler: Record<string, string> } {
  const e = (eingabe && typeof eingabe === "object" ? eingabe : {}) as Record<string, unknown>;
  const fehler: Record<string, string> = {};
  const kamera = typeof e.kamera === "string" ? e.kamera.trim() : "";
  if (!kamera || !Object.hasOwn(bekannt, kamera)) fehler.kamera = "Diese Kamera kenne ich nicht, Sir.";
  const frage = typeof e.frage === "string" ? e.frage.trim() : "";
  if (frage.length < 1 || frage.length > 300) fehler.frage = "Frage: 1 bis 300 Zeichen, Sir.";
  const alle = ganzzahl(e.alle_minuten, 5, 1440);
  if (alle === undefined) fehler.alle_minuten = "Intervall: ganze Minuten von 5 bis 1440, Sir.";
  const nurWenn = e.nur_wenn === undefined || e.nur_wenn === null || e.nur_wenn === "" ? "immer" : e.nur_wenn;
  if (!BEDINGUNGEN.includes(nurWenn as Bedingung)) fehler.nur_wenn = "Bedingung: immer, abwesend oder nacht, Sir.";
  let ruhe: number | undefined;
  if (e.ruhe_minuten !== undefined && e.ruhe_minuten !== null && e.ruhe_minuten !== "") {
    ruhe = ganzzahl(e.ruhe_minuten, 0, 1440);
    if (ruhe === undefined) fehler.ruhe_minuten = "Ruhezeit: ganze Minuten von 0 bis 1440, Sir.";
  }
  if (Object.keys(fehler).length > 0) return { ok: false, fehler };
  return { ok: true, wert: { kamera, frage, alle_minuten: alle!, nur_wenn: nurWenn as Bedingung, ...(ruhe !== undefined ? { ruhe_minuten: ruhe } : {}) } };
}
