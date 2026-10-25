/**
 * Handmodell der Gesten-Konsole einmalig laden:  npm run gesten:modell
 * Ziel vendor/mediapipe/hand_landmarker.task im Arbeitsordner (nicht versioniert), Grösse und SHA-256 geprüft.
 */
import { ladeModell } from "../src/gesten.js";

try {
  console.log(await ladeModell());
  process.exit(0);
} catch (e) {
  console.error(`${e instanceof Error ? e.message : String(e)} Bitte später nochmals: npm run gesten:modell, Sir.`);
  process.exit(1);
}
