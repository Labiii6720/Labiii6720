#!/usr/bin/env node
// Bestätigungstöne des Satelliten als ESPHome-Paket (esphome/ton.yaml), ohne Abhängigkeiten.
// Format wie der I2S-Lautsprecher: 16 kHz, mono, 16 bit PCM little-endian.
//   node esphome/tools/ton.mjs              → YAML auf stdout
//   node esphome/tools/ton.mjs --schreiben  → esphome/ton.yaml neu schreiben
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RATE = 16000;
/** Gesamtgrenze aller Tondaten in Bytes: liegt im Flash, soll klein bleiben. */
export const MAX_BYTES = 8192;

/** Zwei kurze Töne, zusammen 120 ms: aufsteigend = «ich höre», absteigend und tiefer = Fehler. */
export const TOENE = {
  wake: [{ hz: 880, ms: 55 }, { ms: 10 }, { hz: 1320, ms: 55 }],
  fehler: [{ hz: 392, ms: 55 }, { ms: 10 }, { hz: 262, ms: 55 }],
};

/**
 * Tonfolge als 16-bit-Samples. Weiche Rampen am Anfang und Ende jedes Tons, sonst knackt der Lautsprecher.
 * Pegel bewusst unter Vollaussteuerung: die Lautstärke-Entität skaliert danach noch.
 */
export function pcm(folge, { pegel = 0.3, rampeMs = 5 } = {}) {
  const teile = [];
  for (const t of folge) {
    const n = Math.round((t.ms * RATE) / 1000);
    const s = new Int16Array(n);
    if (t.hz) {
      const rampe = Math.max(1, Math.round((rampeMs * RATE) / 1000));
      for (let i = 0; i < n; i++) {
        const huelle = Math.min(1, i / rampe, (n - 1 - i) / rampe);
        s[i] = Math.round(Math.sin((2 * Math.PI * t.hz * i) / RATE) * huelle * pegel * 32767);
      }
    }
    teile.push(s);
  }
  const alle = new Int16Array(teile.reduce((summe, s) => summe + s.length, 0));
  let pos = 0;
  for (const s of teile) {
    alle.set(s, pos);
    pos += s.length;
  }
  return alle;
}

/** Samples als Bytes (little-endian), so wie `speaker.play` sie erwartet. */
export function alsBytes(samples) {
  const b = new Uint8Array(samples.length * 2);
  const sicht = new DataView(b.buffer);
  samples.forEach((wert, i) => sicht.setInt16(i * 2, wert, true));
  return b;
}

export function tonBytes(art) {
  const folge = TOENE[art];
  if (!folge) throw new Error(`unbekannter Ton «${art}»`);
  return alsBytes(pcm(folge));
}

function yamlListe(bytes, einzug) {
  const zeilen = [];
  for (let i = 0; i < bytes.length; i += 32) zeilen.push(einzug + Array.from(bytes.subarray(i, i + 32)).join(", "));
  return `[\n${zeilen.join(",\n")}\n${einzug.slice(2)}]`;
}

/** ESPHome-Paket mit zwei Skripten; die Basis ruft sie nur auf, wenn «Ton-Feedback» an ist. */
export function paketYaml() {
  const skript = (id, art) => {
    const bytes = tonBytes(art);
    return [
      `  - id: ${id}`,
      "    mode: restart",
      "    then:",
      "      - speaker.play:",
      "          id: speaker_out",
      `          data: ${yamlListe(bytes, "            ")}`,
      "      - speaker.finish: speaker_out",
      "      - wait_until:",
      "          condition:",
      "            speaker.is_stopped: speaker_out",
      "          timeout: 1s",
    ].join("\n");
  };
  const gesamt = tonBytes("wake").length + tonBytes("fehler").length;
  if (gesamt > MAX_BYTES) throw new Error(`Tondaten zu gross: ${gesamt} Bytes`);
  return [
    "# Erzeugt von esphome/tools/ton.mjs – nicht von Hand ändern, sondern neu erzeugen:",
    "#   node esphome/tools/ton.mjs --schreiben",
    `# Zwei Tonfolgen (Wakeword, Fehler) à 120 ms, 16 kHz mono 16 bit PCM, zusammen ${gesamt} Bytes.`,
    "script:",
    skript("ton_wake", "wake"),
    skript("ton_fehler", "fehler"),
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const yaml = paketYaml();
  if (process.argv.includes("--schreiben")) {
    const ziel = fileURLToPath(new URL("../ton.yaml", import.meta.url));
    writeFileSync(ziel, yaml);
    console.log(`geschrieben: ${ziel}`);
  } else {
    process.stdout.write(yaml);
  }
}
