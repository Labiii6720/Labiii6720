import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Eigene Datei: finanzen.ts lädt rechnungen.json nur einmal beim Import, hier kaputt im Temp-Verzeichnis
const temp = mkdtempSync(join(tmpdir(), "jarvis-telegram-finanzen-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "rechnungen.json"), '[{"id": 1, "empfaenger": "Steueramt", "betrag": 4200, "waehrung": "CHF", "status": "offen"},');

const gesendet: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  if (url.endsWith("/sendMessage")) gesendet.push((JSON.parse(String(init?.body)) as { text: string }).text);
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const origErr = console.error;
console.error = () => undefined;
const { handleUpdate } = await import("../src/telegram.js");
const { rechnungenNichtGeladen } = await import("../src/finanzen.js");
const { state } = await import("../src/state.js");
console.error = origErr;

const nachricht = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, text } });

describe("/finanzen bei unlesbarem data/rechnungen.json", () => {
  it("meldet den Defekt statt «Noch keine Rechnungen erfasst»", async () => {
    assert.equal(rechnungenNichtGeladen, true);
    gesendet.length = 0;
    await handleUpdate(nachricht(1, "/finanzen"));
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0], /rechnungen\.json war beim Start unlesbar, Sir/);
    assert.match(gesendet[0], /erinnere an keine/);
    assert.doesNotMatch(gesendet[0], /Noch keine Rechnungen|Nichts zu berichten/);
  });

  it("im Notfall bleibt es bei der Notfall-Sperre", async () => {
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    state.paused = true;
    try {
      gesendet.length = 0;
      await handleUpdate(nachricht(2, "/finanzen"));
      assert.deepEqual(gesendet, ["Im Notfall gebe ich keine Finanzdaten heraus, Sir. Erst /entwarnung."]);
    } finally {
      state.notfall = { aktiv: false };
      state.paused = false;
    }
  });
});
