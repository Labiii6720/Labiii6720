import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Request, Response } from "express";

// POST /events (frage_sync aus Konsole, Kurzbefehl, Satellit; frage aus Home Assistant): was nach der PIN aussieht
// (pinEingabe), geht weder an Claude noch in data/chat.json; gleiche Antwort, nie gezählt. Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-events-pin-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const TOKEN = "events-pin-token-nur-attrappe-0123456789";
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = TOKEN;

/** Texte, die an Telegram gingen (sendMessage) */
const telegram: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  if (url.endsWith("/sendMessage") && typeof init?.body === "string") telegram.push(String((JSON.parse(init.body) as { text?: string }).text ?? ""));
  return new Response(JSON.stringify({ ok: true, result: { message_id: telegram.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const { handleEvent } = await import("../src/events.js");
const { state } = await import("../src/state.js");
const { missbrauchZuruecksetzen } = await import("../src/notfall.js");
const { setzeWarten } = await import("../src/telegram.js");

const CHAT = join(temp, "data", "chat.json");
const AUDIT = join(temp, "data", "audit.log");
const auditZeilen = (ereignis: string) => (existsSync(AUDIT) ? readFileSync(AUDIT, "utf8").split("\n").filter((z) => z.includes(`"event":"${ereignis}"`)) : []);

const client = anthropic();
const origCreate = client.messages.create;
/** Was an Claude ging (letzte Nutzernachricht je Aufruf) */
let anClaude: string[] = [];
let claudeAntwort = "Gern, Sir.";
let claudeVerzoegerung = 0;

const nachricht = (text: string): Anthropic.Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  content: [{ type: "text", text, citations: null }],
} as Anthropic.Message);

/** POST /events mit gültigem Token; Express-Anfrage und -Antwort als schlanke Attrappen. */
async function sende(body: unknown): Promise<{ status: number; body: any }> {
  const req = { body, ip: "192.168.1.20", header: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${TOKEN}` : undefined) } as unknown as Request;
  const a = { status: 200, body: undefined as any, beendet: false };
  const res = {
    get headersSent() { return a.beendet; },
    status(c: number) { a.status = c; return res; },
    json(b: unknown) { a.body = b; a.beendet = true; return res; },
    end() { a.beendet = true; return res; },
  } as unknown as Response;
  await handleEvent(req, res);
  return { status: a.status, body: a.body };
}
const ruhe = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

const PIN_ANTWORT = { ok: false, error: "pin", text: "Das sieht aus wie eine PIN, Sir. Ich schicke es nicht weiter." };

beforeEach(() => {
  setzeWarten(async () => {}, () => 0.5);
  missbrauchZuruecksetzen();
  telegram.length = 0;
  anClaude = [];
  claudeAntwort = "Gern, Sir.";
  claudeVerzoegerung = 0;
  client.messages.create = (async (p: Anthropic.MessageCreateParams) => {
    const letzte = p.messages.at(-1)!;
    anClaude.push(typeof letzte.content === "string" ? letzte.content : JSON.stringify(letzte.content));
    if (claudeVerzoegerung) await new Promise((r) => setTimeout(r, claudeVerzoegerung));
    return nachricht(claudeAntwort);
  }) as unknown as typeof client.messages.create;
});
afterEach(() => {
  client.messages.create = origCreate;
  state.paused = false;
  state.notfall = { aktiv: false };
});

describe("POST /events: PIN-förmige Eingaben gehen nie an Claude", () => {
  it("frage_sync getippt und gesprochen (kanal «stimme»), richtig oder falsch: 400 mit demselben Text, nichts an Claude, nicht gezählt", async () => {
    const eingaben: [string, string | undefined][] = [["4711", undefined], ["4711.", undefined], [" 4711! ", "stimme"], ["4712", undefined], ["4 7 1 1", "stimme"], ["meine PIN ist 4711", undefined]];
    for (const [text, kanal] of eingaben) {
      const r = await sende({ event: "frage_sync", text, ...(kanal ? { kanal } : {}) });
      assert.equal(r.status, 400, text);
      assert.deepEqual(r.body, PIN_ANTWORT, text);
    }
    await ruhe();
    assert.deepEqual(anClaude, []);
    assert.equal(existsSync(CHAT), false, "kein Eintrag in der Historie");
    assert.deepEqual(telegram, []);
    assert.equal(auditZeilen("pin_eingabe").length, eingaben.length);
    assert.ok(auditZeilen("pin_eingabe").every((z) => z.includes('"kanal":"events"')));
    assert.equal(auditZeilen("abuse_signal").length, 0, "nie gezählt");
    assert.ok(!readFileSync(AUDIT, "utf8").includes("4711"), "die PIN steht nicht im Audit");
  });

  it("Satellit: zehn gesprochene Zahlen in PIN-Form lösen keinen Notfall aus", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await sende({ event: "frage_sync", text: `40${50 + i}`, kanal: "stimme" });
      assert.equal(r.status, 400);
    }
    await ruhe();
    assert.equal(state.notfall?.aktiv ?? false, false, "kein Notfall");
    assert.equal(state.paused ?? false, false);
    assert.equal(auditZeilen("abuse_signal").length, 0);
  });

  it("frage (Antwort per Telegram): ebenso abgewiesen, nichts an Claude, nichts nach Telegram", async () => {
    for (const text of ["4711?", "4712"]) {
      const r = await sende({ event: "frage", text });
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, PIN_ANTWORT);
    }
    await ruhe();
    assert.deepEqual(anClaude, []);
    assert.equal(existsSync(CHAT), false);
    assert.deepEqual(telegram, []);
  });

  it("Fehltreffer gehen an Claude: Uhrzeit, Betrag, Datum, Telefonnummer, Satz ohne PIN-Wort", async () => {
    for (const text of ["14.30", "12.50", "25.10.2026", "079 123 45 67", "Termin um 1430 mit Müller"]) {
      const r = await sende({ event: "frage_sync", text, kanal: "stimme" });
      assert.equal(r.status, 200, text);
    }
    assert.equal(anClaude.length, 5);
  });

  it("Antworten ohne PIN-Schwärzung, Schlüssel und Token weiter geschwärzt; späte Antwort samt Echo per Telegram", async () => {
    claudeAntwort = "Die Postleitzahl ist 4051. Schlüssel sk-ant-abcdefgh1234 und Bearer abcdefghijkl, Sir.";
    const sofort = await sende({ event: "frage_sync", text: "Welche Postleitzahl hat Basel?" });
    assert.equal(sofort.status, 200);
    assert.equal(sofort.body.reply, "Die Postleitzahl ist 4051. Schlüssel sk-ant-<schlüssel> und Bearer <token>, Sir.");

    claudeVerzoegerung = 4000;
    claudeAntwort = "Bestellung 1042 ist unterwegs, Sir.";
    const spaet = await sende({ event: "frage_sync", text: "Wo ist Bestellung 1042?", budget: 1 });
    assert.equal(spaet.body.queued, true);
    for (let i = 0; i < 600 && telegram.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(telegram, ["Zu Ihrer Frage von unterwegs («Wo ist Bestellung 1042?»):\n\nBestellung 1042 ist unterwegs, Sir."]);
  });

  it("frage aus Home Assistant: Antwort per Telegram, Zugangsdaten geschwärzt", async () => {
    claudeAntwort = "Schlüssel sk-ant-abcdefgh1234 und bot987654321:ZYXwvuTSRqpoNMLkji, Sir.";
    const r = await sende({ event: "frage", text: "Welche Zugangsdaten stehen im Log?" });
    assert.equal(r.body.queued, true);
    for (let i = 0; i < 100 && telegram.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(telegram, ["Schlüssel sk-ant-<schlüssel> und bot<token>, Sir."]);
  });
});
