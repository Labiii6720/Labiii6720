import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

// Läuft immer, ohne Browser: die Schutzzusagen der Kommandozentrale, die sich am Quelltext prüfen lassen.
// Das Verhalten im Browser (Notfall, XSS, PIN per Tastatur, CSP-Verletzungen) prüft test/dashboard-ui.test.ts.
const web = resolve(import.meta.dirname, "..", "web");
const html = readFileSync(resolve(web, "dashboard.html"), "utf8");
const css = readFileSync(resolve(web, "dashboard.css"), "utf8");
const js = readFileSync(resolve(web, "dashboard.js"), "utf8");

describe("Kommandozentrale: statische Schutzzusagen", () => {
  it("dashboard.js baut kein HTML aus Text und führt keinen Text als Code aus", () => {
    for (const [muster, was] of [
      [/\.innerHTML\b/, "innerHTML"],
      [/\.outerHTML\b/, "outerHTML"],
      [/insertAdjacentHTML/, "insertAdjacentHTML"],
      [/document\.write/, "document.write"],
      [/\beval\s*\(/, "eval("],
      [/new\s+Function\b/, "new Function"],
      [/set(Timeout|Interval)\s*\(\s*["'`]/, "setTimeout/setInterval mit String"],
      [/createContextualFragment|DOMParser/, "HTML-Parser"],
    ] as const) assert.doesNotMatch(js, muster, was);
  });

  it("dashboard.js bindet Aktionen über data-Attribute und Delegation, nie über on…-Eigenschaften", () => {
    assert.doesNotMatch(js, /\.on(click|change|submit|keydown|input|load|error)\s*=/, "keine on…-Zuweisung");
    assert.doesNotMatch(js, /setAttribute\(\s*["']on/i, "kein on…-Attribut");
    assert.match(js, /data-aktion/);
    assert.match(js, /document\.addEventListener\("click"/);
  });

  it("dashboard.js schickt den Token nur als Bearer-Header, nie in der URL", () => {
    assert.match(js, /Authorization: "Bearer " \+ token/);
    assert.doesNotMatch(js, /[?&]token=/);
  });

  it("Token-Schlüssel kollidiert nicht mit der Gesten-Konsole (gleicher Ursprung, «jarvis.» + Feld-ID)", () => {
    const gesture = readFileSync(resolve(web, "gesture.html"), "utf8");
    const key = js.match(/const TOKEN_KEY = "([^"]+)"/)?.[1];
    assert.ok(key, "TOKEN_KEY gefunden");
    const liste = gesture.match(/for \(const id of \[([^\]]+)\]\)[^\n]*\n[^\n]*localStorage\.getItem\("jarvis\." \+ id\)/)?.[1];
    assert.ok(liste, "Feldliste der Gesten-Konsole gefunden");
    const ids = [...liste!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(ids.includes("token"));
    for (const id of ids) assert.notEqual(key, "jarvis." + id, id);
    assert.notEqual(key, "jarvis.thema");
    // Den Token der Konsole weder lesen noch löschen
    assert.doesNotMatch(js, /(getItem|removeItem|lies|entferne)\(\s*(["']localStorage["'],\s*)?["']jarvis\.token["']/);
    assert.doesNotMatch(js, /localStorage["'],\s*ALT_SITZUNG/);
  });

  it("dashboard.html: kein Inline-Skript, kein style=, keine on…=-Attribute, nichts von aussen", () => {
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, "kein Inline-Skript");
    assert.deepEqual([...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/gi)].map((m) => m[1]), ["/dashboard/app.js"]);
    assert.deepEqual([...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gi)].map((m) => m[1]), ["/dashboard/app.css"]);
    for (const m of html.matchAll(/<link\b[^>]*href="([^"]+)"/gi)) assert.ok(["/dashboard/app.css", "data:,"].includes(m[1]!), m[1]);
    assert.doesNotMatch(html, /<style/i);
    assert.doesNotMatch(html, /\sstyle=/i);
    assert.doesNotMatch(html, /\son[a-z]+=/i);
    assert.doesNotMatch(html, /http-equiv/i, "keine Meta-CSP (die CSP kommt als Header)");
    assert.doesNotMatch(html, /https?:\/\//i, "nichts von aussen");
    assert.match(html, /<html lang="de">/);
  });

  it("dashboard.css lädt nichts von aussen", () => {
    assert.doesNotMatch(css, /@import/i);
    assert.doesNotMatch(css, /url\(\s*["']?(https?:)?\/\//i);
    assert.doesNotMatch(css, /@font-face/i, "keine Webfonts");
  });

  it("dashboard.css hat beide Themen und respektiert reduzierte Bewegung", () => {
    assert.match(css, /@media \(prefers-color-scheme: light\)/);
    assert.match(css, /:root\[data-theme="light"\]/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });
});
