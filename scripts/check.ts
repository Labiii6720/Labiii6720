/** Selbsttest aller Anbindungen:  npm run check   (nur einzelne: npm run check -- --nur Telegram,Frigate) */
import { formatBefund, nurAusArgv, selbsttest } from "../src/check.js";
// Befunde einzeln, sobald sie vorliegen; am Ende nur noch die Zusammenfassung
const befunde = await selbsttest(nurAusArgv(process.argv), (b) => console.log(formatBefund([b]).split("\n")[0]));
console.log("\n" + formatBefund(befunde).split("\n").at(-1));
process.exit(0);
