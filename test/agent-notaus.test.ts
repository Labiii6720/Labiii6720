import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Vor dem Import: Temp-Verzeichnis und Umgebung; nie echte Dienste
const temp = mkdtempSync(join(tmpdir(), "jarvis-agent-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const { runTask, pausiertText } = await import("../src/agent.js");
const { state } = await import("../src/state.js");
const { toolByName } = await import("../src/tools.js");

const NOTIZEN = join(temp, "data", "notizen.md");
const hooks = { onAuftrag: async () => undefined } as unknown as Parameters<typeof runTask>[1];

/** Antwort mit zwei auto-Werkzeugen (notiz_speichern hat eine Nebenwirkung: Datei schreiben) */
const mitWerkzeugen = (): Anthropic.Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "tool_use", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  content: [
    { type: "text", text: "Ich notiere das.", citations: null },
    { type: "tool_use", id: "tu_1", name: "notiz_speichern", input: { text: "eins" } },
    { type: "tool_use", id: "tu_2", name: "notiz_speichern", input: { text: "zwei" } },
  ],
} as Anthropic.Message);

describe("runLoop: Notaus während eines Claude-Aufrufs", () => {
  const client = anthropic();
  const orig = client.messages.create;
  afterEach(() => {
    client.messages.create = orig;
    state.paused = false;
    delete state.notfall;
  });

  it("Notaus kommt während messages.create: keine Werkzeuge, Historie bleibt gültig", async () => {
    let aufrufe = 0;
    client.messages.create = (async () => {
      aufrufe++;
      state.paused = true; // /pause trifft ein, während die Antwort unterwegs ist
      return mitWerkzeugen();
    }) as unknown as typeof client.messages.create;
    const verlauf: Anthropic.MessageParam[] = [];
    const antwort = await runTask("Merk dir eins und zwei.", hooks, { history: verlauf });
    assert.equal(antwort, "Ich bin pausiert (Notaus). In Telegram hebt /weiter das wieder auf.");
    assert.equal(aufrufe, 1);
    assert.equal(existsSync(NOTIZEN), false);
    // jedes tool_use hat ein tool_result (sonst lehnt die API den nächsten Aufruf ab)
    const letzte = verlauf.at(-1)!;
    assert.equal(letzte.role, "user");
    const ergebnisse = letzte.content as Anthropic.ToolResultBlockParam[];
    assert.deepEqual(ergebnisse.map((r) => [r.tool_use_id, r.is_error]), [["tu_1", true], ["tu_2", true]]);
  });

  it("Notaus kommt während des letzten Aufrufs (ohne Werkzeuge): Antwort wird nicht herausgegeben", async () => {
    let aufrufe = 0;
    client.messages.create = (async () => {
      aufrufe++;
      state.paused = true; // /notfall trifft ein, während die fertige Antwort unterwegs ist
      return { ...mitWerkzeugen(), stop_reason: "end_turn", content: [{ type: "text", text: "Ihre Rechnungen: geheim.", citations: null }] } as Anthropic.Message;
    }) as unknown as typeof client.messages.create;
    const verlauf: Anthropic.MessageParam[] = [];
    const antwort = await runTask("Welche Rechnungen sind offen?", hooks, { history: verlauf });
    assert.equal(antwort, "Ich bin pausiert (Notaus). In Telegram hebt /weiter das wieder auf.");
    assert.equal(aufrufe, 1);
    assert.doesNotMatch(antwort, /geheim/);
    // Historie bleibt gültig: Nutzer, dann Assistent
    assert.deepEqual(verlauf.map((m) => m.role), ["user", "assistant"]);
  });

  it("Notfall kommt während messages.create: Antwort verweist auf /entwarnung statt /weiter", async () => {
    client.messages.create = (async () => {
      // /notfall setzt beides (notfall.ts): Notaus und Notfall-Status
      state.paused = true;
      state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
      return mitWerkzeugen();
    }) as unknown as typeof client.messages.create;
    const antwort = await runTask("Merk dir eins und zwei.", hooks, { history: [] });
    assert.equal(antwort, "Notfall aktiv, Sir. Aufheben nur mit /entwarnung in Telegram.");
    assert.doesNotMatch(antwort, /\/weiter/);
    assert.equal(existsSync(NOTIZEN), false);
  });

  it("Anfrage im laufenden Notfall: kein Claude-Aufruf, Hinweis auf /entwarnung", async () => {
    let aufrufe = 0;
    client.messages.create = (async () => { aufrufe++; return mitWerkzeugen(); }) as unknown as typeof client.messages.create;
    state.paused = true;
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    const antwort = await runTask("Was steht an?", hooks, { history: [] });
    assert.equal(antwort, pausiertText());
    assert.match(antwort, /\/entwarnung/);
    assert.equal(aufrufe, 0);
    // nach der Entwarnung (Notfall aus, Notaus noch an) gilt wieder der /weiter-Hinweis
    state.notfall = { aktiv: false };
    assert.equal(pausiertText(), "Ich bin pausiert (Notaus). In Telegram hebt /weiter das wieder auf.");
  });

  it("ohne Notaus: Werkzeuge laufen wie bisher", async () => {
    let aufrufe = 0;
    client.messages.create = (async () => {
      aufrufe++;
      if (aufrufe === 1) return mitWerkzeugen();
      return { ...mitWerkzeugen(), stop_reason: "end_turn", content: [{ type: "text", text: "Notiert, Sir.", citations: null }] } as Anthropic.Message;
    }) as unknown as typeof client.messages.create;
    const antwort = await runTask("Merk dir eins und zwei.", hooks, { history: [] });
    assert.equal(antwort, "Notiert, Sir.");
    assert.equal(aufrufe, 2);
    assert.equal(existsSync(NOTIZEN), true);
  });
});

describe("execute: Fehler von Auto-Werkzeugen werden geschwärzt", () => {
  const client = anthropic();
  const orig = client.messages.create;
  const werkzeug = toolByName("notiz_speichern")!;
  const origRun = werkzeug.run;
  afterEach(() => {
    client.messages.create = orig;
    werkzeug.run = origRun;
  });

  it("Zugangsdaten in der Fehlermeldung landen weder im Audit noch im tool_result", async () => {
    werkzeug.run = async () => { throw new Error("fetch failed: http://u:geheim@host:5000/api/events"); };
    let aufrufe = 0;
    client.messages.create = (async () => {
      aufrufe++;
      if (aufrufe === 1) return mitWerkzeugen();
      return { ...mitWerkzeugen(), stop_reason: "end_turn", content: [{ type: "text", text: "Das ging schief, Sir.", citations: null }] } as Anthropic.Message;
    }) as unknown as typeof client.messages.create;
    const verlauf: Anthropic.MessageParam[] = [];
    await runTask("Merk dir eins und zwei.", hooks, { history: verlauf });
    const ergebnisse = verlauf.find((m) => Array.isArray(m.content) && m.content[0]?.type === "tool_result")!.content as Anthropic.ToolResultBlockParam[];
    assert.equal(ergebnisse.length, 2);
    for (const r of ergebnisse) {
      assert.equal(r.is_error, true);
      assert.doesNotMatch(String(r.content), /geheim@/);
      assert.match(String(r.content), /<geheim>@host/);
    }
    const fehlerZeilen = readFileSync(join(temp, "data", "audit.log"), "utf8").split("\n").filter((z) => z.includes('"ok":false'));
    assert.ok(fehlerZeilen.length >= 2);
    for (const z of fehlerZeilen) assert.doesNotMatch(z, /u:geheim/);
  });
});
