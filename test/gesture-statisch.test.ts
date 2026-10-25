import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

// Läuft immer, ohne Browser und ohne Dienst: die Zusagen der Gesten-Konsole, die sich am Quelltext prüfen lassen.
// Verhalten im Browser (CSP-Verletzungen, Anfragen nach aussen) prüft test/gesture-ui.test.ts.
const projekt = resolve(import.meta.dirname, "..");
const lies = (p: string) => readFileSync(resolve(projekt, p), "utf8");
const html = lies("web/gesture.html");
const js = lies("web/gesture.js");
const css = lies("web/gesture.css");
const server = lies("src/server.ts");
const gesten = lies("src/gesten.ts");

describe("Gesten-Konsole: statische Zusagen", () => {
  it("gesture.html: kein Inline-Skript, kein <style>, kein style=, keine on…=-Attribute, nichts von aussen", () => {
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, "kein Inline-Skript");
    assert.deepEqual([...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/gi)].map((m) => m[1]), ["/gesture/app.js"]);
    assert.match(html, /<script type="module" src="\/gesture\/app\.js"><\/script>/);
    assert.deepEqual([...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gi)].map((m) => m[1]), ["/gesture/app.css"]);
    for (const m of html.matchAll(/<link\b[^>]*href="([^"]+)"/gi)) assert.ok(["/gesture/app.css", "data:,"].includes(m[1]!), m[1]);
    assert.doesNotMatch(html, /<style/i);
    assert.doesNotMatch(html, /\sstyle=/i);
    assert.doesNotMatch(html, /\son[a-z]+=/i);
    assert.doesNotMatch(html, /http-equiv/i, "CSP kommt als Header");
    assert.doesNotMatch(html, /https?:\/\/|\/\/cdn|jsdelivr|googleapis|unpkg/i, "nichts von aussen");
    assert.doesNotMatch(html, /id="base"/, "kein Adressfeld mehr (nur eigener Ursprung)");
  });

  it("gesture.js: lädt nur vom eigenen Server, sendet nur an /events, kein Code aus Text", () => {
    assert.doesNotMatch(js, /https?:\/\/|jsdelivr|googleapis|unpkg|cdn\./i, "keine fremde Adresse");
    const importe = [...js.matchAll(/^\s*import\b[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.deepEqual(importe, ["/gesture/mp/vision_bundle.mjs"]);
    assert.match(js, /const WASM = "\/gesture\/mp\/wasm";/);
    assert.match(js, /const MODELL = "\/gesture\/mp\/hand_landmarker\.task";/);
    assert.match(js, /modelAssetBuffer/);
    const ziele = [...js.matchAll(/\bfetch\(\s*([^,)]+)/g)].map((m) => m[1]!.trim());
    assert.deepEqual(ziele.sort(), ['"/events"', "MODELL"]);
    assert.doesNotMatch(js, /\bbase\b.*\/events|\$\{base\}/, "kein frei wählbarer Ursprung");
    for (const [muster, was] of [
      [/\.innerHTML\b/, "innerHTML"], [/\.outerHTML\b/, "outerHTML"], [/insertAdjacentHTML/, "insertAdjacentHTML"], [/document\.write/, "document.write"],
      [/\beval\s*\(/, "eval("], [/new\s+Function\b/, "new Function"], [/set(Timeout|Interval)\s*\(\s*["'`]/, "setTimeout mit String"],
      [/\.on[a-z]+\s*=/, "on…-Zuweisung"], [/setAttribute\(\s*["']on/i, "on…-Attribut"], [/\.style\./, "Inline-Stil"],
    ] as const) assert.doesNotMatch(js, muster, was);
    assert.match(js, /status\("Handmodell fehlt: npm run gesten:modell"/, "ruhiger Hinweis ohne Modell");
  });

  it("gesture.js: hält der Dienst die Eingabe für die PIN, steht nur sein Hinweis da (nicht das Transkript, nicht «Fehler: pin»)", () => {
    assert.match(js, /if \(data && data\.error === "pin"\) \{ \$\("reply"\)\.textContent = data\.text \|\|/);
    assert.match(js, /throw new Error\(data\.text \|\| data\.error \|\|/, "sonst der Text des Dienstes statt des Kürzels");
  });

  it("gesture.css lädt nichts von aussen", () => {
    assert.doesNotMatch(css, /@import/i);
    assert.doesNotMatch(css, /url\(/i);
    assert.doesNotMatch(css, /@font-face/i);
  });

  it("CSP der Konsole: genauer Wortlaut, nur 'self', WebAssembly ohne eval", () => {
    // Aus dem Quelltext (src/ nicht laden: config.ts läse die .env im Projekt)
    const ab = gesten.indexOf("export const GESTEN_CSP =");
    assert.ok(ab >= 0);
    const roh = gesten.slice(ab, gesten.indexOf("\n\n", ab));
    const GESTEN_CSP = [...roh.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
    assert.equal(
      GESTEN_CSP,
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob: mediastream:; " +
        "connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    assert.doesNotMatch(GESTEN_CSP, /'unsafe-eval'|'unsafe-inline'|https?:|\*/);
  });

  it("server.ts: feste Routen statt express.static, alles hinter lanOnly", () => {
    assert.doesNotMatch(server, /express\.static\(|serve-static/);
    assert.match(server, /app\.use\("\/gesture", lanOnly\);/);
    for (const route of [/app\.get\("\/gesture", lanOnly,/, /app\.get\(pfad, lanOnly, gestenDatei\(typ, \(\) => web\(datei\)\)\)/, /app\.get\(pfad, lanOnly, gestenDatei\(typ, \(\) => \(mp \?/, /app\.get\(GESTEN_MODELL, lanOnly,/]) {
      assert.match(server, route);
    }
    assert.match(server, /TUNNEL_SCHALTBAR = new Set\(\["\/events", "\/gesture", \.\.\.Object\.keys\(GESTEN_WEB\), \.\.\.Object\.keys\(MEDIAPIPE_DATEIEN\), GESTEN_MODELL\]\)/);
  });

  it("Paket exakt gepinnt, Lockfile mit Prüfsumme, vendor/ nicht versioniert, npm-Skript vorhanden", () => {
    const pkg = JSON.parse(lies("package.json")) as { dependencies: Record<string, string>; scripts: Record<string, string> };
    assert.equal(pkg.dependencies["@mediapipe/tasks-vision"], "0.10.14");
    assert.equal(pkg.scripts["gesten:modell"], "tsx scripts/gesten-modell.ts");
    const lock = JSON.parse(lies("package-lock.json")) as { packages: Record<string, { version?: string; integrity?: string }> };
    const eintrag = lock.packages["node_modules/@mediapipe/tasks-vision"];
    assert.equal(eintrag?.version, "0.10.14");
    assert.match(eintrag?.integrity ?? "", /^sha512-[A-Za-z0-9+/=]{80,}$/);
    assert.match(lies(".gitignore"), /^vendor\/$/m);
    assert.ok(existsSync(resolve(projekt, "scripts/gesten-modell.ts")));
  });
});
