/**
 * Handmodell der Gesten-Konsole einmalig laden:  npm run gesten:modell
 * Ziel vendor/mediapipe/hand_landmarker.task im Arbeitsordner (nicht versioniert), Grösse und SHA-256 geprüft.
 */
import { ladeModell, ModellOrdnerFehler } from "../src/gesten.js";

try {
  console.log(await ladeModell());
  process.exit(0);
} catch (e) {
  const text = e instanceof Error ? e.message : String(e);
  // Ordner nicht beschreibbar: später nochmals hilft nicht, nur der richtige Benutzer
  console.error(e instanceof ModellOrdnerFehler ? `${text}, Sir.` : `${text} Bitte später nochmals: npm run gesten:modell, Sir.`);
  process.exit(1);
}
