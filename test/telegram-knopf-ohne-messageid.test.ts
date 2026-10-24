import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

// Zweite Verteidigung in onCallback: Ein Auftrag, dessen Freigabe nie mit Knöpfen gesendet wurde (keine messageId),
// darf über keinen Knopf freigegeben oder abgelehnt werden – der Knopf stand unter einer anderen Nachricht.
const temp = mkdtempSync(join(tmpdir(), "jarvis-telegram-knopf-ohne-mid-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";

let aufrufe: { method: string; text?: string }[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  aufrufe.push({ method: url.split("/").pop() ?? "", text: body.text });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 100 + aufrufe.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { handleUpdate } = await import("../src/telegram.js");
const { createAuftrag, getAuftrag } = await import("../src/queue.js");
const { reminders } = await import("../src/tools.js");

const VERALTET = "Dieser Knopf ist veraltet, Sir. /auftraege zeigt die aktuellen.";
const auftrag = () => createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "Knopf" }, stufe: "extern", summary: "Erinnerung" });
const knopf = (aktion: string, id: number, messageId: number) =>
  handleUpdate({ update_id: Math.floor(Math.random() * 1e9), callback_query: { id: "cb", data: `${aktion}:${id}`, from: { id: 12345 }, message: { message_id: messageId } } });
const gesendet = () => aufrufe.filter((x) => x.method === "sendMessage").map((x) => x.text ?? "");

afterEach(() => {
  aufrufe = [];
  reminders.splice(0, reminders.length);
});

describe("Knopf zu einem Auftrag ohne messageId", () => {
  it("ok:<id> mit message_id 5: veraltet, nichts ausgeführt, Auftrag bleibt offen", async () => {
    const a = auftrag();
    assert.equal(a.messageId, undefined, "onAuftrag nie aufgerufen");
    await knopf("ok", a.id, 5);
    assert.deepEqual(gesendet(), [VERALTET]);
    assert.equal(getAuftrag(a.id)?.status, "offen");
    assert.equal(getAuftrag(a.id)?.gestartetAm, undefined);
    assert.equal(reminders.length, 0);
  });

  it("nein:<id> mit message_id 5: veraltet, nicht abgelehnt", async () => {
    const a = auftrag();
    await knopf("nein", a.id, 5);
    assert.deepEqual(gesendet(), [VERALTET]);
    assert.equal(getAuftrag(a.id)?.status, "offen");
  });

  it("Gegenprobe: Knopf unter der gemerkten Nachricht wirkt", async () => {
    const a = auftrag();
    a.messageId = 5;
    await knopf("nein", a.id, 5);
    assert.equal(getAuftrag(a.id)?.status, "abgelehnt");
    assert.ok(gesendet().includes(`❌ #${a.id} abgelehnt.`));
  });
});
