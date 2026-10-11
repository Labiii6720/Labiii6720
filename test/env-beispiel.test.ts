import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { parseEnv } from "node:util";

// Reine Quelltext-Prüfung: nichts aus src/ wird geladen, kein Dienst berührt.
const projekt = resolve(import.meta.dirname, "..");
const beispiel = readFileSync(join(projekt, ".env.example"), "utf8");

function tsDateien(ordner: string): string[] {
  return readdirSync(ordner, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
}

/** Alle per opt("…")/env("…") gelesenen Schlüssel aus src/ und scripts/ */
function gelesen(): Set<string> {
  const schluessel = new Set<string>();
  for (const datei of [...tsDateien(join(projekt, "src")), ...tsDateien(join(projekt, "scripts"))]) {
    for (const m of readFileSync(datei, "utf8").matchAll(/\b(?:opt|env)\("([A-Z][A-Z0-9_]*)"\)/g)) schluessel.add(m[1]);
  }
  return schluessel;
}

/** Schlüssel steht in .env.example, als Wert oder als auskommentierte Vorlage («# KEY=…») */
const erwaehnt = (key: string) => new RegExp(`^(?:#\\s*)?${key}=`, "m").test(beispiel);

describe(".env.example ↔ gelesene Schlüssel", () => {
  it("jeder per opt()/env() gelesene Schlüssel steht in .env.example", () => {
    const alle = gelesen();
    assert.ok(alle.size > 50, "Suche findet die Schlüssel (Muster noch passend)");
    const fehlend = [...alle].filter((k) => !erwaehnt(k)).sort();
    assert.deepEqual(fehlend, [], `fehlen in .env.example: ${fehlend.join(", ")}`);
  });

  it("Preise für /kosten: auskommentiert, Standardwerte wie in config.ts, keine aktiven Werte", () => {
    const config = readFileSync(join(projekt, "src", "config.ts"), "utf8");
    const aktiv = parseEnv(beispiel);
    for (const key of ["PREIS_INPUT", "PREIS_OUTPUT", "PREIS_CACHE_READ", "PREIS_CACHE_WRITE"]) {
      const standard = config.match(new RegExp(`opt\\("${key}"\\) \\?\\? "([^"]+)"`))?.[1];
      assert.ok(standard, `${key}: Standard in config.ts gefunden`);
      assert.match(beispiel, new RegExp(`^# ${key}=${standard.replace(/\./g, "\\.")}$`, "m"), `${key}: Vorlage mit Standard ${standard}`);
      assert.equal(aktiv[key], undefined, `${key} bleibt auskommentiert (Setup-Schema kennt ihn nicht)`);
    }
  });
});
