import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Unlesbare data/chat.json beim Start: der Verlauf ist leer, mit Hinweis statt 500; ihr Inhalt erscheint nirgends.
const temp = mkdtempSync(join(tmpdir(), "jarvis-verlauf-defekt-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = "verlauf-token-nur-attrappe-0123456789";
globalThis.fetch = (async () => { throw new Error("kein Netz im Test"); }) as typeof fetch;

const KAPUTT = '[{"role":"user","content":"GEHEIMER-INHALT" ';
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "chat.json"), KAPUTT);

const dashboard = await import("../src/dashboard.js");
const agent = await import("../src/agent.js");

describe("GET /api/chat/verlauf mit unlesbarer data/chat.json", () => {
  it("200 mit leerer Liste und Hinweis, kein Dateiinhalt", async () => {
    const res = { statusCode: 200, body: undefined as any, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    await dashboard.chatVerlauf({} as never, res as never);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.nachrichten, []);
    assert.equal(res.body.unlesbar, true);
    assert.match(res.body.text, /data\/chat\.json war beim Start unlesbar, Sir/);
    assert.ok(!JSON.stringify(res.body).includes("GEHEIMER-INHALT"));
    assert.equal(agent.chatNichtGeladen, true);
    // Nur gelesen: die Datei liegt unverändert da
    assert.equal(readFileSync(join(temp, "data", "chat.json"), "utf8"), KAPUTT);
  });

  it("gültiges JSON, aber kein Array (von Hand bearbeitet): ebenfalls leer und als unlesbar gemeldet", async () => {
    writeFileSync(join(temp, "data", "chat.json"), JSON.stringify({ role: "user", content: "GEHEIMER-INHALT" }));
    // Eigene Modulinstanz: agent.ts liest die Datei beim Laden
    const frisch = (await import(`../src/agent.js?kein-array=${Date.now()}`)) as typeof agent;
    assert.equal(frisch.chatNichtGeladen, true);
    assert.deepEqual(frisch.letzteNachrichten(), []);
  });

  it("fehlende Datei: leer, ohne Hinweis", async () => {
    rmSync(join(temp, "data", "chat.json"));
    const frisch = (await import(`../src/agent.js?fehlt=${Date.now()}`)) as typeof agent;
    assert.equal(frisch.chatNichtGeladen, false);
    assert.deepEqual(frisch.letzteNachrichten(), []);
  });
});
