import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

// Läuft immer, ohne Browser: die Befunde an web/gesture.js, soweit sie sich am Quelltext prüfen lassen.
// Das Verhalten im Browser prüft test/gesture-js-befunde-ui.test.ts.
const js = readFileSync(resolve(import.meta.dirname, "..", "web/gesture.js"), "utf8");
const speak = js.slice(js.indexOf("function speak("), js.indexOf("\n}\n", js.indexOf("function speak(")));

describe("gesture.js: Befunde (statisch)", () => {
  it("MediaPipe nur dynamisch geladen, mit Hinweis statt Stillstand", () => {
    assert.doesNotMatch(js, /^\s*import\s*[{*\w]/m, "kein statischer Import");
    assert.match(js, /mp = await import\(BUNDLE\);\s*\} catch \{\s*status\("MediaPipe fehlt: npm ci, dann Jarvis neu starten", "hinweis"\);\s*return;/);
  });

  it("Sprachausgabe nur mit lokaler Stimme (localService), nie voice=null mit Sprache", () => {
    assert.ok(speak.length > 0);
    assert.match(speak, /\.filter\(\(v\) => v\.localService === true\)/);
    assert.match(speak, /if \(!stimme\) \{[^}]*toast\("KEINE LOKALE DEUTSCHE STIMME – NUR TEXT"\)[^}]*\}\s*return;/);
    assert.doesNotMatch(speak, /\|\|\s*null/, "kein Rückfall auf die Wahl des Browsers");
    assert.doesNotMatch(speak, /"de-DE"/, "keine Sprache ohne Stimme");
    assert.match(speak, /u\.voice = stimme;/);
  });

  it("gesprochene PIN: weder im Toast noch in der Antwortzeile", () => {
    assert.match(js, /toast\(pinVerdacht\(t\) \? "» …" : "» " \+ t\)/);
    assert.match(js, /const frage = "› " \+ \(pinVerdacht\(text\) \? "…" : text\);/);
    assert.doesNotMatch(js, /textContent = "› " \+ text\b/);
  });

  it("Leertaste: nicht auf Knöpfen und Feldern, nicht bei Tastenwiederholung", () => {
    assert.match(js, /if \(e\.code !== "Space" \|\| e\.repeat\) return;/);
    assert.match(js, /closest\("button, input, textarea, select, \[contenteditable\]"\)\) return;/);
  });

  it("401 und fehlendes /events: deutsche Meldung, JSON-Fehler abgefangen", () => {
    assert.match(js, /await res\.json\(\)\.catch\(\(\) => null\)/);
    assert.match(js, /res\.status === 401\) return hinweis\("Token stimmt nicht, Sir\."\)/);
    assert.match(js, /res\.status === 404 && !data\) return hinweis\("Ereignisse sind aus \(JARVIS_EVENT_TOKEN fehlt\), Sir\."\)/);
  });
});
