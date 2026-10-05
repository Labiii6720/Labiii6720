/**
 * Testet Jarvis ohne Alexa: zeigt den Text, den Alexa vorlesen würde.
 *
 *   npx tsx scripts/try.ts cardio     → Cardio-Ansage (ändert den Tageszustand nicht)
 *   npx tsx scripts/try.ts briefing   → baut das Tagesbriefing neu
 */
import { buildBriefing, cardioText } from "../src/brain.js";

const what = process.argv[2] ?? "cardio";

if (what === "cardio") {
  console.log(await cardioText({ timeoutMs: 15_000, markDelivered: false }));
} else if (what === "briefing") {
  console.log(await buildBriefing());
} else {
  console.error("Benutzung: npx tsx scripts/try.ts cardio|briefing");
  process.exitCode = 1;
}
