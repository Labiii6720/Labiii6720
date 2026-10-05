/** Selbsttest aller Anbindungen:  npm run check */
import { formatBefund, selbsttest } from "../src/check.js";
console.log(formatBefund(await selbsttest()));
process.exit(0);
