import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis, Protokolle und Umgebung; nie echte Dienste, nie zurück ins Projekt
const temp = mkdtempSync(join(tmpdir(), "jarvis-protokolle-verschachtelt-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.HA_URL = "http://ha.test:8123";
process.env.HA_TOKEN = "ha-token-attrappe";

const ruft = (name: string) => ({ tool: "protokoll_ausfuehren", input: { name } });
writeFileSync("protokolle.json", JSON.stringify({
  aussen: { beschreibung: "Harmlos", stufe: "auto", schritte: [ruft("innen"), { nachricht: "fertig" }] },
  innen: { beschreibung: "Haustür auf", stufe: "sensibel", schritte: [{ tool: "geraet_schalten", input: { entity_id: "lock.haustuer", dienst: "unlock" } }] },
  schleife: { beschreibung: "Ruft sich selbst", stufe: "auto", schritte: [ruft("schleife")] },
}));

/** Meldungen beim Laden von protokolle.json */
const meldungen: string[] = [];
const echteError = console.error;
console.error = (...a: unknown[]) => { meldungen.push(a.map(String).join(" ")); };

/** Aufgerufene HA-Dienste */
const aufrufe: string[] = [];
const echteFetch = globalThis.fetch;
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (!url.startsWith("http://ha.test:8123/")) throw new Error(`unerwarteter Netzaufruf: ${url}`);
  aufrufe.push(url.replace("http://ha.test:8123/api/", ""));
  return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; console.error = echteError; });

const { runProtokoll } = await import("../src/protokolle.js");
const { toolByName } = await import("../src/tools.js");
const geladen = [...meldungen];
console.error = echteError;

const ctx = { sendFile: async () => undefined, sendPhoto: async () => undefined, sendVideo: async () => undefined };

describe("Protokolle: keine Verschachtelung", () => {
  afterEach(() => { aufrufe.length = 0; });

  it("auto-Protokoll ruft sensibles Protokoll: nichts geschaltet, Schritt mit ✗, Rest läuft", async () => {
    const out = await runProtokoll("aussen", ctx);
    assert.deepEqual(aufrufe, []);
    assert.match(out, /✗ protokoll_ausfuehren: Ein Protokoll ruft keine anderen Protokolle auf/);
    assert.match(out, /\nfertig$/);
  });

  it("über das Werkzeug (wie Claude es aufruft): das innere sensible Protokoll läuft nicht", async () => {
    const t = toolByName("protokoll_ausfuehren")!;
    const out = await t.run(t.festhalten!({ name: "aussen" }), ctx);
    assert.deepEqual(aufrufe, []);
    assert.match(typeof out === "string" ? out : out.text, /✗ protokoll_ausfuehren/);
  });

  it("selbstaufrufendes Protokoll endet ohne Stapelüberlauf", async () => {
    const out = await runProtokoll("schleife", ctx);
    assert.doesNotMatch(out, /call stack|RangeError/i);
    assert.match(out, /✗ protokoll_ausfuehren: Ein Protokoll ruft keine anderen Protokolle auf/);
    assert.equal(out.split("\n").length, 2);
  });

  it("beim Laden wird die Anzahl gemeldet, ohne Inhalt", () => {
    const m = geladen.filter((z) => z.includes("anderes Protokoll"));
    assert.equal(m.length, 1);
    assert.match(m[0]!, /2 Protokolle rufen/);
    assert.doesNotMatch(m[0]!, /aussen|schleife|haustuer/);
  });
});
