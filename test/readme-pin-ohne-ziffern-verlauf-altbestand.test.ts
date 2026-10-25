import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

// README ↔ Verhalten, zwei Befunde:
// 1. Zurückgehaltene Antworten aus der Zeit vor 0.23 tragen keine Markierung «zurueckgehalten» und erscheinen darum im
//    Verlauf der Kommandozentrale. Die README darf «erscheinen nie» nicht ohne diese Einschränkung sagen.
// 2. Bei einer PIN ohne Ziffern ist jedes einzelne Wort ohne Ziffern von 4 bis 12 Zeichen PIN-förmig («Danke»,
//    «Status») und wird von Gesprächsfeld und /events abgewiesen, aber nicht gezählt. Die README nennt das dort.
const projekt = resolve(import.meta.dirname, "..");
const readme = readFileSync(join(projekt, "README.md"), "utf8");
const temp = mkdtempSync(join(tmpdir(), "jarvis-readme-pin-altbestand-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt; aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_PIN = "Sesamoeffne";

const echteFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error("unerwarteter Netzaufruf"); }) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const { pinFoermigLocker } = await import("../src/telegram.js");
const { sichtbareNachrichten } = await import("../src/agent.js");

/** Punkt der Kommandozentrale, der mit `anfang` beginnt (bis Zeilenende) */
function zeile(anfang: string): string {
  const z = readme.split("\n").find((l) => l.startsWith(anfang));
  assert.ok(z, `Zeile «${anfang}» in der README gefunden`);
  return z;
}

describe("README: Verlauf-Altbestand und PIN ohne Ziffern", () => {
  it("Verhalten: eine unmarkierte (alte) zurückgehaltene Antwort erscheint, eine markierte nicht", () => {
    const verlauf = [
      { role: "user", content: "Wie steht es um die Rechnungen?" },
      { role: "assistant", content: [{ type: "text", text: "Alte Antwort aus dem Notaus" }] },
      { role: "user", content: "Und jetzt?" },
      { role: "assistant", content: [{ type: "text", text: "Neue Antwort aus dem Notaus" }], zurueckgehalten: true },
    ];
    const texte = sichtbareNachrichten(verlauf).map((n) => n.text);
    assert.ok(texte.includes("Alte Antwort aus dem Notaus"), "ohne Markierung nicht erkennbar");
    assert.ok(!texte.includes("Neue Antwort aus dem Notaus"));
  });

  it("Gespräch: «erscheinen nie» gilt ab 0.23, Altbestand ohne Markierung, Abhilfe /neu", () => {
    const g = zeile("- **Gespräch:**");
    assert.match(g, /zurückgehalten hat, erscheinen nie, auch nicht nach `\/weiter` \(gilt ab 0\.23;[^)]*keine Markierung[^)]*nicht erkennen[^)]*`\/neu`\)/);
  });

  it("Verhalten: bei einer PIN ohne Ziffern sind «Danke» und «Status» PIN-förmig, Sätze und Wörter mit Ziffer nicht", () => {
    assert.notEqual(pinFoermigLocker("Danke"), undefined);
    assert.notEqual(pinFoermigLocker("Status"), undefined);
    assert.notEqual(pinFoermigLocker("Danke!"), undefined);
    assert.equal(pinFoermigLocker("Danke dir"), undefined);
    assert.equal(pinFoermigLocker("Raum12"), undefined);
    assert.equal(pinFoermigLocker("Ja"), undefined, "kürzer als 4 Zeichen");
  });

  it("Gespräch und Abschnitt 11 nennen den Fall der PIN ohne Ziffern und empfehlen eine PIN mit Ziffern", () => {
    const fall = /bei einer PIN ohne Ziffern jedes einzelne Wort ohne Ziffern von 4 bis 12 Zeichen wie «Danke» oder «Status» – darum besser eine PIN mit Ziffern/;
    const nichtGezaehlt = /gezählt als unbefugter Versuch \(bei einer PIN ohne Ziffern nicht, siehe Abschnitt 8\)/;
    const g = zeile("- **Gespräch:**");
    assert.match(g, fall);
    assert.match(g, nichtGezaehlt);
    const konsole = zeile("Im Feld unten rechts den `JARVIS_EVENT_TOKEN` eintragen");
    assert.match(konsole, fall);
    assert.match(konsole, nichtGezaehlt);
  });
});
