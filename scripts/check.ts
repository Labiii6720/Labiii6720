/** Selbsttest aller Anbindungen:  npm run check   (nur einzelne: npm run check -- --nur Telegram,Frigate) */
import { formatBefund, nurAusArgv, selbsttest } from "../src/check.js";
console.log(formatBefund(await selbsttest(nurAusArgv(process.argv))));
process.exit(0);
