/** Selbsttest aller Anbindungen:  npm run check   (nur einzelne: npm run check -- --nur Telegram,Frigate) */
import { nurLesen } from "../src/datei.js";

// Vor dem Laden der Module: Listen nur lesen (keine Sicherung .defekt, kein Log). Der Selbsttest ändert nichts in data/;
// Sicherungen legt nur der Dienst beim Start an. Darum check.js erst danach, dynamisch.
nurLesen();
const { formatBefund, nurAusArgv, selbsttest } = await import("../src/check.js");
// Befunde einzeln, sobald sie vorliegen; am Ende nur noch die Zusammenfassung
const befunde = await selbsttest(nurAusArgv(process.argv), (b) => console.log(formatBefund([b]).split("\n")[0]));
console.log("\n" + formatBefund(befunde).split("\n").at(-1));
process.exit(0);
