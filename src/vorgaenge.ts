import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { gesperrtText, ladeListe, vorgangEintrag } from "./datei.js";
import { addSystemNote, runTask, type AgentHooks } from "./agent.js";
import { schwaerze } from "./robust.js";
import { state } from "./state.js";
import { sendText, sendeSpaeter } from "./telegram.js";

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
  /** Prozess, in dem der Vorgang läuft: so erkennt ein später geladenes Modul, ob er noch lebt */
  pid?: number;
}

const FILE = "data/vorgaenge.json";
export const UNTERBROCHEN = "durch Neustart unterbrochen, Ergebnis unklar";

/** Lebt der Prozess noch? EPERM heisst: es gibt ihn, er gehört nur einem anderen Benutzer. */
function prozessLebt(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface Umgebung {
  jetzt?: Date;
  /** Systemstart; was davor begann, kann nicht mehr laufen (auch wenn die PID inzwischen neu vergeben ist) */
  bootZeit?: Date;
  eigenePid?: number;
  lebt?: (pid: number) => boolean;
}

/**
 * Setzt Vorgänge, deren Prozess nicht mehr läuft (Neustart, Absturz), auf «fehler» und gibt sie zurück.
 * Nicht einfach alle «läuft»: ein zweiter Prozess (z. B. ein Dienst neben einem Testlauf) könnte einen Vorgang
 * wirklich noch abarbeiten. Ohne PID (ältere Einträge) gilt der Vorgang als unterbrochen.
 */
export function unterbrocheneAbschliessen(liste: Vorgang[], u: Umgebung = {}): Vorgang[] {
  const jetzt = u.jetzt ?? new Date();
  const boot = (u.bootZeit ?? new Date(jetzt.getTime() - uptime() * 1000)).getTime();
  const eigenePid = u.eigenePid ?? process.pid;
  const lebt = u.lebt ?? prozessLebt;
  const betroffen = liste.filter((v) => {
    if (v.status !== "läuft") return false;
    if (typeof v.pid !== "number" || v.pid === eigenePid) return true;
    const start = Date.parse(v.startedAt);
    return (Number.isFinite(start) && start < boot) || !lebt(v.pid);
  });
  for (const v of betroffen) {
    v.status = "fehler";
    v.result = UNTERBROCHEN;
    v.finishedAt = jetzt.toISOString();
  }
  return betroffen;
}

/** Claude und den Nutzer einmal informieren: Teilschritte (Werkzeuge, angelegte Aufträge) können erfolgt sein. */
async function unterbrochenMelden(betroffen: Vorgang[]): Promise<void> {
  if (betroffen.length === 0) return;
  for (const v of betroffen) {
    addSystemNote(`Vorgang #${v.id} («${v.auftrag.slice(0, 80)}») wurde durch einen Neustart unterbrochen (nach ${v.steps} Schritten), Ergebnis unklar. Er läuft nicht weiter.`);
  }
  const ids = betroffen.map((v) => `#${v.id}`).join(", ");
  const text =
    betroffen.length === 1
      ? `⚠️ Vorgang ${ids} wurde durch einen Neustart unterbrochen, Ergebnis unklar – bitte prüfen, Sir.`
      : `⚠️ Vorgänge ${ids} wurden durch einen Neustart unterbrochen, Ergebnis unklar – bitte prüfen, Sir.`;
  await sendeSpaeter(text);
}

// Ohne id, auftrag, startedAt, bekannten status oder steps fällt ein Eintrag beim Laden weg (vorgangEintrag): sonst
// würfen /vorgaenge und /status.json (auftrag.slice), und die nächste ID wäre Unsinn
const geladen = ladeListe(FILE, "Vorgänge", vorgangEintrag);
export const vorgaenge: Vorgang[] = geladen.liste;
/** true, wenn data/vorgaenge.json vorhanden, aber unlesbar war: dann wird nichts gespeichert und kein Vorgang gestartet. */
export const vorgaengeNichtGeladen = geladen.nichtGeladen;
export const VORGAENGE_UNLESBAR =
  "⚠️ data/vorgaenge.json war beim Start unlesbar, Sir (Sicherung, sofern möglich, unter data/vorgaenge.json.defekt). Ich starte keine Vorgänge, bis die Datei repariert ist und ich neu gestartet bin.";

/**
 * Höchste Nummer beim Start, verworfene Einträge eingeschlossen: deren Nummer steht noch in der Sicherung und in
 * Systemnotizen und wird nicht neu vergeben.
 */
const hoechsteVorgangIdBeimStart = vorgaengeNichtGeladen ? 0 : geladen.hoechsteId;

/** Nächste Nummer: über allen vorhandenen (unabhängig von der Reihenfolge in der Datei) und allen beim Start verworfenen. */
function neueVorgangId(): number {
  return vorgaenge.reduce((max, v) => (Number.isSafeInteger(v.id) ? Math.max(max, v.id) : max), Math.max(0, hoechsteVorgangIdBeimStart)) + 1;
}

let nachNeustartErledigt = false;
/** In diesem Prozess gestartet: gehört nie zu den Unterbrochenen, auch wenn der Aufruf erst später kommt (eigene PID). */
const hierGestartet = new Set<Vorgang>();

/**
 * Nur der Dienst ruft das auf (server.ts nach startTelegram), nie beim Import: auch `npm run check` lädt dieses
 * Modul und beendet sich gleich danach – dort ginge die Meldung verloren, und die Diagnose veränderte den Zustand.
 * Erst melden (Systemnotiz, sendeSpaeter legt bei Störung im Postausgang ab), dann speichern: stirbt der Prozess
 * dazwischen, meldet der nächste Start den Vorgang eben noch einmal, statt ihn stillschweigend abzuschliessen.
 */
export async function vorgaengeNachNeustart(u: Umgebung = {}): Promise<Vorgang[]> {
  if (nachNeustartErledigt) return [];
  nachNeustartErledigt = true;
  const betroffen = unterbrocheneAbschliessen(vorgaenge.filter((v) => !hierGestartet.has(v)), u);
  if (betroffen.length === 0) return betroffen;
  try {
    await unterbrochenMelden(betroffen);
  } catch (e) {
    console.error(`Vorgänge: Hinweis auf Unterbruch nicht zustellbar (${schwaerze(e instanceof Error ? e.message : String(e))}).`);
  }
  try { save(); } catch (e) { console.error(`Vorgänge: Abschluss nach Neustart nicht gespeichert (${schwaerze(e instanceof Error ? e.message : String(e))}).`); }
  return betroffen;
}

function save(): void {
  if (vorgaengeNichtGeladen) throw new Error(gesperrtText(FILE, "die Vorgänge"));
  mkdirSync("data", { recursive: true, mode: 0o700 });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(vorgaenge.slice(-100), null, 2), { mode: 0o600 });
  renameSync(`${FILE}.tmp`, FILE);
}

export function startVorgang(auftrag: string, hooks: AgentHooks): Vorgang {
  // Vor dem push: sonst liefe ein Vorgang, den keine Datei kennt
  if (vorgaengeNichtGeladen) throw new Error(VORGAENGE_UNLESBAR);
  const id = neueVorgangId();
  if (!Number.isSafeInteger(id)) throw new Error("Nummernraum erschöpft, Sir – data/vorgaenge.json prüfen.");
  const v: Vorgang = { id, auftrag, status: "läuft", startedAt: new Date().toISOString(), steps: 0, pid: process.pid };
  vorgaenge.push(v);
  hierGestartet.add(v);
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
    // Zweites Argument von then statt angehängtem .catch: ein Sendefehler darf das Ergebnis nicht als «fehler» überschreiben.
    // Gesendet wird über den Postausgang – ist Telegram gestört, kommt die Meldung nach.
    .then(
      async (result) => {
        // Notaus während des Vorgangs: runLoop liefert dann pausiertText() statt eines Ergebnisses. Der Vorgang ist
        // abgebrochen, nicht fertig – sonst halten /vorgaenge und Claude ihn für erledigt. Kein Ergebnistext nach aussen.
        if (state.paused) {
          v.status = "fehler";
          v.result = "wegen Notaus angehalten";
          v.finishedAt = new Date().toISOString();
          save();
          addSystemNote(`Vorgang #${v.id} («${auftrag.slice(0, 80)}») wurde wegen Notaus angehalten (nach ${v.steps} Schritten), nicht fertig.`);
          await sendeSpaeter(`⏸ Vorgang #${v.id} wegen Notaus angehalten.`).catch(() => undefined);
          return;
        }
        v.status = "fertig";
        v.result = result.slice(0, 4000);
        v.finishedAt = new Date().toISOString();
        save();
        addSystemNote(`Vorgang #${v.id} («${auftrag.slice(0, 80)}») ist fertig: ${v.result.slice(0, 1500)}`);
        await sendeSpaeter(`✅ Vorgang #${v.id} fertig (${v.steps} Werkzeugschritte)\n\n${result}`, { imNotfallZurueckhalten: true }).catch((e: unknown) =>
          console.error(`Vorgang #${v.id}: Ergebnis nicht zustellbar (${schwaerze(e instanceof Error ? e.message : String(e))}).`),
        );
      },
      async (e: unknown) => {
        const meldung = e instanceof Error ? e.message : String(e);
        v.status = "fehler";
        v.result = meldung;
        v.finishedAt = new Date().toISOString();
        save();
        await sendeSpaeter(`⚠️ Vorgang #${v.id} abgebrochen: ${schwaerze(meldung)}`, { imNotfallZurueckhalten: true }).catch(() => undefined);
      },
    )
    // nur noch Unvorhergesehenes (z. B. save() bei voller Platte) – nie als unbehandelte Ablehnung den Dienst beenden
    .catch((e: unknown) => console.error(`Vorgang #${v.id}: ${schwaerze(e instanceof Error ? e.message : String(e))}`));
  return v;
}

export function listVorgaenge(): string {
  if (vorgaengeNichtGeladen) return VORGAENGE_UNLESBAR;
  return (
    vorgaenge
      .slice(-10)
      .map((v) => `#${v.id} ${v.status} · ${v.steps} Schritte · ${v.auftrag.slice(0, 80)}`)
      .join("\n") || "Keine Vorgänge."
  );
}
