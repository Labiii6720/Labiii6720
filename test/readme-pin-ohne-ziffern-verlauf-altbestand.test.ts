import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

// README ↔ Verhalten: Zurückgehaltene Antworten aus der Zeit vor 0.23 tragen keine Markierung «zurueckgehalten» und
// erscheinen darum im Verlauf der Kommandozentrale. Die README darf «erscheinen nie» nicht ohne diese Einschränkung sagen.
// (Die PIN ohne Ziffern prüft seit 0.24 test/pin-eingabe.test.ts.)
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

const { sichtbareNachrichten } = await import("../src/agent.js");

/** Punkt der Kommandozentrale, der mit `anfang` beginnt (bis Zeilenende) */
function zeile(anfang: string): string {
  const z = readme.split("\n").find((l) => l.startsWith(anfang));
  assert.ok(z, `Zeile «${anfang}» in der README gefunden`);
  return z;
}

describe("README: Verlauf-Altbestand", () => {
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
});
