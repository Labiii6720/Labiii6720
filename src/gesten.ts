import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fehlerDetail, HttpFehler, mitWiederholung, retryAfterAusHeader, type WiederholOptionen } from "./robust.js";

/**
 * Gesten-Konsole ohne CDN: MediaPipe kommt aus node_modules (@mediapipe/tasks-vision, exakt gepinnt), das Handmodell
 * einmalig per  npm run gesten:modell  nach vendor/mediapipe/ (nicht versioniert). Der Dienst liefert nur die Dateien
 * der Whitelist aus (server.ts), unter einer strengen CSP.
 */

/** CSP der Konsole und ihrer Dateien. 'wasm-unsafe-eval' erlaubt nur das Übersetzen von WebAssembly, kein eval. */
export const GESTEN_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob: mediastream:; " +
  "connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

export const MODELL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
export const MODELL_SHA256 = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1";
export const MODELL_BYTES = 7_819_105;
/** Relativ zum Arbeitsordner des Dienstes (wie data/) */
export const MODELL_PFAD = join("vendor", "mediapipe", "hand_landmarker.task");

export const modellPfad = (wurzel = process.cwd()): string => resolve(wurzel, MODELL_PFAD);

/** Ordner des Pakets @mediapipe/tasks-vision; undefined, wenn es nicht installiert ist (npm ci vergessen). */
export function mediapipeOrdner(): string | undefined {
  try {
    return dirname(fileURLToPath(import.meta.resolve("@mediapipe/tasks-vision")));
  } catch {
    return undefined;
  }
}

/** Genau diese Paketdateien braucht die Konsole: das Modul und beide WASM-Varianten (SIMD und ohne, je nach Browser). */
export const MEDIAPIPE_DATEIEN: Record<string, { datei: string; typ: string }> = {
  "/gesture/mp/vision_bundle.mjs": { datei: "vision_bundle.mjs", typ: "text/javascript; charset=utf-8" },
  "/gesture/mp/wasm/vision_wasm_internal.js": { datei: "wasm/vision_wasm_internal.js", typ: "text/javascript; charset=utf-8" },
  "/gesture/mp/wasm/vision_wasm_internal.wasm": { datei: "wasm/vision_wasm_internal.wasm", typ: "application/wasm" },
  "/gesture/mp/wasm/vision_wasm_nosimd_internal.js": { datei: "wasm/vision_wasm_nosimd_internal.js", typ: "text/javascript; charset=utf-8" },
  "/gesture/mp/wasm/vision_wasm_nosimd_internal.wasm": { datei: "wasm/vision_wasm_nosimd_internal.wasm", typ: "application/wasm" },
};

export const sha256 = (daten: Uint8Array): string => createHash("sha256").update(daten).digest("hex");

export type ModellZustand = { zustand: "fehlt" } | { zustand: "falsch"; bytes: number } | { zustand: "ok" };
/** Erwartete Grösse und Prüfsumme; nur Tests setzen andere Werte */
export interface Erwartet { bytes: number; sha256: string }
const ERWARTET: Erwartet = { bytes: MODELL_BYTES, sha256: MODELL_SHA256 };

/** Nur lesend: fehlt, falsche Grösse oder Prüfsumme, oder ok. */
export function modellZustand(wurzel?: string, erwartet: Erwartet = ERWARTET): ModellZustand {
  const pfad = modellPfad(wurzel);
  if (!existsSync(pfad)) return { zustand: "fehlt" };
  const daten = readFileSync(pfad);
  if (daten.length !== erwartet.bytes || sha256(daten) !== erwartet.sha256) return { zustand: "falsch", bytes: daten.length };
  return { zustand: "ok" };
}

/** Liest die Antwort, bricht aber ab, sobald sie grösser wird als das Modell. */
async function liesGedeckelt(res: Response, hoechstens: number): Promise<Buffer> {
  if (!res.body) throw new Error("leere Antwort");
  const teile: Uint8Array[] = [];
  let laenge = 0;
  const leser = res.body.getReader();
  for (;;) {
    const { done, value } = await leser.read();
    if (done) break;
    laenge += value.length;
    if (laenge > hoechstens) {
      await leser.cancel().catch(() => undefined);
      throw new Error(`Antwort grösser als ${hoechstens} Bytes`);
    }
    teile.push(value);
  }
  return Buffer.concat(teile);
}

/**
 * Lädt das Handmodell, prüft Grösse und SHA-256 und schreibt es atomar (tmp + rename). Bei einer Abweichung wird nichts
 * gespeichert (eine vorhandene Datei bleibt unberührt). Wirft mit einer klaren Meldung. Nur ein GET, darum mit Wiederholung.
 */
export async function ladeModell(
  wurzel?: string,
  o: Pick<WiederholOptionen, "warten" | "versuche"> & { zeitlimitMs?: number; erwartet?: Erwartet } = {},
): Promise<string> {
  const erwartet = o.erwartet ?? ERWARTET;
  if (modellZustand(wurzel, erwartet).zustand === "ok") return `Handmodell bereits vorhanden und geprüft (${MODELL_PFAD}).`;
  let daten: Buffer;
  try {
    daten = await mitWiederholung(
      "Handmodell",
      async () => {
        const res = await fetch(MODELL_URL, { signal: AbortSignal.timeout(o.zeitlimitMs ?? 120_000) });
        if (!res.ok) throw new HttpFehler(`HTTP ${res.status}`, res.status, retryAfterAusHeader(res.headers));
        return await liesGedeckelt(res, erwartet.bytes);
      },
      { versuche: o.versuche ?? 3, ...(o.warten ? { warten: o.warten } : {}) },
    );
  } catch (e) {
    throw new Error(`Handmodell nicht geladen (${fehlerDetail(e)}). Nichts gespeichert.`);
  }
  if (daten.length !== erwartet.bytes) throw new Error(`Handmodell verworfen: ${daten.length} statt ${erwartet.bytes} Bytes. Nichts gespeichert.`);
  const summe = sha256(daten);
  if (summe !== erwartet.sha256) throw new Error(`Handmodell verworfen: Prüfsumme ${summe.slice(0, 12)}… statt ${erwartet.sha256.slice(0, 12)}…. Nichts gespeichert.`);
  const ziel = modellPfad(wurzel);
  mkdirSync(dirname(ziel), { recursive: true });
  const tmp = `${ziel}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, daten, { mode: 0o644 });
    renameSync(tmp, ziel);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`Handmodell nicht gespeichert: ${e instanceof Error ? e.message : String(e)}`);
  }
  return `Handmodell geladen und geprüft (${MODELL_PFAD}, ${erwartet.bytes} Bytes, SHA-256 ok).`;
}
