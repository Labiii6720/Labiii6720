import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befund: Eine späte Antwort (oder eine Telegram-Antwort), deren Versand an einer Störung scheiterte, lag ohne Marke im
// Postausgang. postausgangTick prüfte nur den Notfall, nicht den Notaus: im Notaus ging sie samt Echo der Frage nach
// Telegram. Entscheid: Antworten bleiben im Notaus im Postausgang (nichts verworfen) und gehen erst nach /weiter
// hinaus. Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-postausgang-antwort-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_ANREDE = "Sir";
process.env.JARVIS_FORM = "sie";

// Altbestand aus einem früheren Lauf: die Marke muss das Laden überstehen
const DATEI = join(temp, "data", "postausgang.json");
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(DATEI, JSON.stringify([{ ts: "2026-10-25T02:20:00.000Z", text: "Zur Frage von unterwegs («Saldo?»): Alter Saldo, Sir.", antwort: true }]));

const telegram: string[] = [];
let fehlschlaege = 0;
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  if (url.endsWith("/sendMessage") && typeof init?.body === "string") {
    if (fehlschlaege > 0) {
      fehlschlaege--;
      return new Response(JSON.stringify({ ok: false, error_code: 502, description: "Bad Gateway" }), { status: 502, headers: { "content-type": "application/json" } });
    }
    telegram.push(String((JSON.parse(init.body) as { text?: string }).text ?? ""));
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: telegram.length + 1 } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const { handleUpdate, postausgangTick, sendeAntwort, sendeSpaeter, setzeWarten } = await import("../src/telegram.js");
const { state } = await import("../src/state.js");

const client = anthropic();
const origCreate = client.messages.create;
const nachricht = (text: string): Anthropic.Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  content: [{ type: "text", text, citations: null }],
} as Anthropic.Message);
const eintraege = () => JSON.parse(readFileSync(DATEI, "utf8")) as { text: string; antwort?: true }[];
let nr = 9000;

beforeEach(() => {
  setzeWarten(async () => {}, () => 0.5);
  telegram.length = 0;
  fehlschlaege = 0;
});
afterEach(() => {
  client.messages.create = origCreate;
  state.paused = false;
  state.notfall = { aktiv: false };
});

describe("Antwort im Postausgang: im Notaus zurückgehalten, nach /weiter nachgereicht", () => {
  it("Altbestand mit Marke: im Notaus nichts, nach /weiter nachgereicht", async () => {
    state.paused = true;
    await postausgangTick();
    assert.equal(telegram.length, 0);
    assert.equal(eintraege().length, 1);
    assert.equal(eintraege()[0]!.antwort, true);
    state.paused = false;
    await postausgangTick();
    assert.equal(telegram.length, 1);
    assert.match(telegram[0]!, /^\(nachgereicht, .*\) Zur Frage von unterwegs/);
    assert.deepEqual(eintraege(), []);
  });

  it("sendeAntwort scheitert viermal (502), dann Notaus: nichts nach Telegram, Eintrag bleibt; andere Meldungen gehen", async () => {
    fehlschlaege = 4;
    await sendeAntwort("Zur Frage aus der Zentrale («Wie steht das geheime Konto?»):\n\nGeheimer Saldo: 999 Franken, Sir.");
    assert.equal(telegram.length, 0);
    assert.equal(eintraege().length, 1);
    assert.equal(eintraege()[0]!.antwort, true);

    state.paused = true;
    await postausgangTick();
    assert.equal(telegram.length, 0, "im Notaus nichts nachgereicht");
    // Eine gewöhnliche Meldung wartet nicht hinter der zurückgestellten Antwort
    await sendeSpaeter("⏰ Zahnarzt");
    assert.deepEqual(telegram, ["⏰ Zahnarzt"]);
    await postausgangTick();
    assert.equal(telegram.length, 1);
    assert.ok(!telegram.some((t) => t.includes("Geheimer Saldo")));
    assert.equal(eintraege().length, 1, "nicht verworfen");

    state.paused = false;
    await postausgangTick();
    assert.equal(telegram.length, 2);
    assert.match(telegram[1]!, /Geheimer Saldo: 999 Franken/);
    assert.deepEqual(eintraege(), []);
  });

  it("im Notfall bleibt die Antwort bis /entwarnung liegen", async () => {
    fehlschlaege = 4;
    await sendeAntwort("Zur Frage («Saldo?»): 999 Franken, Sir.");
    state.paused = true;
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    await postausgangTick();
    assert.equal(telegram.length, 0);
    state.notfall = { aktiv: false };
    state.paused = false;
    await postausgangTick();
    assert.equal(telegram.length, 1);
  });

  it("Telegram-Chat: Antwort scheitert viermal, dann Notaus → nichts nachgereicht bis /weiter", async () => {
    client.messages.create = (async () => nachricht("Geheimer Saldo: 999 Franken, Sir.")) as unknown as typeof client.messages.create;
    fehlschlaege = 4;
    await handleUpdate({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, text: "Wie steht das Konto?" } });
    assert.equal(telegram.length, 0);
    assert.equal(eintraege()[0]!.antwort, true);
    state.paused = true;
    await postausgangTick();
    assert.equal(telegram.length, 0);
    state.paused = false;
    await postausgangTick();
    assert.equal(telegram.length, 1);
    assert.match(telegram[0]!, /Geheimer Saldo/);
  });
});
