import { chmodSync, constants, copyFileSync, mkdirSync, readFileSync } from "node:fs";

/**
 * Gemeinsamer Lader für Listen-Dateien in data/ (Zeitpläne, Erinnerungen, Postausgang, Vorgänge).
 * Eine fehlende Datei heisst «leer». Jede andere unlesbare Datei setzt `nichtGeladen`: Der Aufrufer darf dann
 * nicht speichern, sonst ersetzte die nächste Änderung den ganzen Bestand. Inhalt geht nie ins Log.
 */
export interface GeladeneListe<T> {
  liste: T[];
  nichtGeladen: boolean;
}

/** Kopiert die unlesbare Datei unter einen freien Namen (0o600); eine ältere Sicherung bleibt unberührt. */
export function sichereDefekt(datei: string): string | undefined {
  const ziel = `${datei}.defekt`;
  try {
    mkdirSync("data", { recursive: true, mode: 0o700 });
    const stempel = new Date().toISOString().replace(/[:.]/g, "-");
    for (let n = 0; n < 100; n++) {
      const nach = n === 0 ? ziel : `${ziel}-${stempel}${n > 1 ? `-${n}` : ""}`;
      try {
        copyFileSync(datei, nach, constants.COPYFILE_EXCL);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
      chmodSync(nach, 0o600);
      return nach;
    }
    throw new Error("kein freier Name für die Sicherung");
  } catch (e) {
    console.error(`Sicherung von ${datei} fehlgeschlagen:`, (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : "Fehler"));
    return undefined;
  }
}

/** `name` erscheint im Log («Zeitpläne unlesbar …»). */
export function ladeListe<T>(datei: string, name: string): GeladeneListe<T> {
  let text: string;
  try {
    text = readFileSync(datei, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { liste: [], nichtGeladen: false };
    console.error(
      `${name} nicht lesbar (${(e as NodeJS.ErrnoException).code ?? "Fehler"}) – Jarvis startet ohne ${datei} und speichert die Datei nicht, bis sie wieder lesbar ist und Jarvis neu startet.`,
    );
    return { liste: [], nichtGeladen: true };
  }
  try {
    const roh = JSON.parse(text) as unknown;
    if (!Array.isArray(roh)) throw new Error("keine Liste");
    return { liste: roh as T[], nichtGeladen: false };
  } catch {
    const kopie = sichereDefekt(datei);
    console.error(
      `${name} unlesbar – ${kopie ? `Kopie unter ${kopie}` : "Sicherung fehlgeschlagen"}. Jarvis startet ohne ${datei} und speichert die Datei nicht, bis sie repariert ist und Jarvis neu startet.`,
    );
    return { liste: [], nichtGeladen: true };
  }
}

/** Fehlertext für gesperrtes Speichern (Jarvis-Ton). */
export const gesperrtText = (datei: string, was: string): string =>
  `${datei} war beim Start unlesbar, Sir. Ich ändere ${was} nicht, bis die Datei repariert ist und ich neu gestartet bin – sonst wäre der Bestand weg.`;
