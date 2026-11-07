import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Befund: «/protokoll constructor» nahm einen Namen aus Object.prototype als Protokoll an.
const temp = mkdtempSync(join(tmpdir(), "jarvis-telegram-protokoll-proto-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
writeFileSync(join(temp, "protokolle.json"), JSON.stringify({ nacht: { beschreibung: "Gute Nacht", stufe: "extern", schritte: [{ nachricht: "Nacht" }] } }));

const gesendet: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  if (url.endsWith("/sendMessage")) gesendet.push((JSON.parse(String(init?.body)) as { text: string }).text);
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { handleUpdate } = await import("../src/telegram.js");
const { offeneAuftraege } = await import("../src/queue.js");

const nachricht = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, text } });

describe("/protokoll mit Namen aus Object.prototype", () => {
  for (const [i, name] of ["constructor", "__proto__", "tostring", "hasownproperty"].entries()) {
    it(`«${name}» zeigt die Liste der Protokolle, legt nichts an`, async () => {
      gesendet.length = 0;
      await handleUpdate(nachricht(200 + i, `/protokoll ${name}`));
      assert.deepEqual(gesendet, ["Protokolle: nacht"]);
      assert.equal(offeneAuftraege().length, 0);
    });
  }

  it("ein echtes Protokoll legt weiterhin eine Freigabe an", async () => {
    gesendet.length = 0;
    await handleUpdate(nachricht(210, "/protokoll nacht"));
    assert.equal(offeneAuftraege().length, 1);
    assert.match(gesendet[0] ?? "", /Protokoll «nacht»: Gute Nacht/);
  });
});
