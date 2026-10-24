import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Befund: Das Dashboard konnte «läuft gerade» nicht von «begonnen, Ergebnis unklar» (nach Absturz) unterscheiden.
const temp = mkdtempSync(join(tmpdir(), "jarvis-telegram-auftrag-laeuft-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";

globalThis.fetch = (async (eingabe: string | URL | Request) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { approveAuftrag, auftragLaeuft, hooks, setzeWarten } = await import("../src/telegram.js");
const { createAuftrag, getAuftrag } = await import("../src/queue.js");
setzeWarten(async () => {}, () => 0.5, async () => {});

describe("auftragLaeuft", () => {
  it("wahr nur, solange das Werkzeug läuft; begonnen ohne Lauf (Absturz) ist nicht «läuft»", async () => {
    let fertig!: () => void;
    const haengt = new Promise<void>((r) => { fertig = r; });
    const orig = hooks.sendFile;
    hooks.sendFile = async () => { await haengt; };
    try {
      const a = createAuftrag({ tool: "datei_senden", input: { pfad: "seite.html" }, stufe: "extern", summary: "Datei senden" });
      assert.equal(auftragLaeuft(a.id), false);
      const lauf = approveAuftrag(a);
      for (let i = 0; i < 50 && !getAuftrag(a.id)?.gestartetAm; i++) await new Promise((r) => setImmediate(r));
      assert.ok(getAuftrag(a.id)?.gestartetAm);
      assert.equal(auftragLaeuft(a.id), true);
      fertig();
      await lauf;
      assert.equal(auftragLaeuft(a.id), false);
      assert.equal(getAuftrag(a.id)?.status, "erledigt");

      // nach einem Absturz: offen mit gestartetAm, aber nicht in Arbeit
      const b = createAuftrag({ tool: "datei_senden", input: { pfad: "b.html" }, stufe: "extern", summary: "b" });
      b.gestartetAm = new Date().toISOString();
      assert.equal(auftragLaeuft(b.id), false);
    } finally {
      hooks.sendFile = orig;
    }
  });
});
