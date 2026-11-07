import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Befund: Notfall während des Versands einer Freigabe → die neutrale Meldung nannte nur diesen Auftrag.
const temp = mkdtempSync(join(tmpdir(), "jarvis-telegram-notfall-freigabe-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";

const gesendet: string[] = [];
/** Beim ersten Freigabe-Versand löst die Attrappe den Notfall aus und antwortet mit einem Netzfehler */
let notfallBeimVersand = false;
const { state } = await import("../src/state.js");
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  const text = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }).text : undefined;
  if (notfallBeimVersand && text?.includes("Stufe")) {
    notfallBeimVersand = false;
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    state.paused = true;
    throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }) });
  }
  if (text) gesendet.push(text);
  return new Response(JSON.stringify({ ok: true, result: { message_id: gesendet.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { hooks, setzeWarten } = await import("../src/telegram.js");
const { createAuftrag } = await import("../src/queue.js");
setzeWarten(async () => {}, () => 0.5);

const auftrag = (text: string) =>
  createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text }, stufe: "extern", summary: `Erinnerung: ${text}` });

describe("Notfall während der Freigabe-Nachricht", () => {
  it("die neutrale Meldung nennt alle offenen Aufträge, ohne Inhalt", async () => {
    const a = auftrag("Zahnarzt");
    const b = auftrag("Steuern");
    notfallBeimVersand = true;
    try {
      await hooks.onAuftrag(b);
      assert.deepEqual(gesendet, [`🚨 Notfall aktiv. Offene Aufträge: 2 (#${a.id}, #${b.id}). Inhalte erst nach /entwarnung, Sir.`]);
    } finally {
      state.notfall = { aktiv: false };
      state.paused = false;
    }
  });
});
