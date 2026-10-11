import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/ liegt relativ) und Umgebung; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-brain-"));
process.chdir(temp);
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.LAT = "47.37";
process.env.LON = "8.54";
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

// fetch-Attrappe: jede Anfrage wartet, bis der Test sie mit einer Antwort freigibt
interface Offen { url: string; body: string; antworte: (r: Response) => void }
const offen: Offen[] = [];
const echteFetch = globalThis.fetch;
globalThis.fetch = ((eingabe: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((antworte) => {
    offen.push({ url: String(eingabe instanceof Request ? eingabe.url : eingabe), body: String(init?.body ?? ""), antworte });
  })) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const tg = (daten: unknown, status = 200) =>
  new Response(JSON.stringify(daten), { status, headers: { "content-type": "application/json" } });

const sources = await import("../src/sources.js");
sources._testOptionen.warten = async () => {};
sources._testOptionen.zufall = () => 0.5;
const { briefingText } = await import("../src/brain.js");
const { day, save } = await import("../src/state.js");
const { gesundheit } = await import("../src/robust.js");

/** Lässt alle anstehenden Mikro- und Makroaufgaben (Promise-Ketten) durchlaufen. */
const durchlaufen = () => new Promise<void>((r) => setImmediate(r));
const sendungen = () => offen.filter((o) => o.url.endsWith("/sendMessage"));

beforeEach(() => {
  offen.length = 0;
  gesundheit._reset();
  const d = day();
  d.briefing = { text: "Guten Morgen, Sir. Zwei Termine, kein Regen.", builtAt: new Date().toISOString() };
  d.briefingDelivered = false;
  save();
});

describe("briefingText – Telegram-Versand", () => {
  it("zwei schnelle Aufrufe bei hängendem Versand → genau ein sendMessage", async () => {
    const [a, b] = await Promise.all([briefingText(), briefingText()]);
    assert.equal(a, b);
    await durchlaufen();
    assert.equal(sendungen().length, 1);
    assert.equal(day().briefingDelivered, false);

    // Dritter Aufruf, während der erste Versand noch läuft: ebenfalls kein zweiter Versand
    await briefingText();
    await durchlaufen();
    assert.equal(sendungen().length, 1);

    sendungen()[0].antworte(tg({ ok: true, result: { message_id: 1 } }));
    await durchlaufen();
    await durchlaufen();
    assert.equal(day().briefingDelivered, true);

    // Zugestellt: kein weiterer Versand
    await briefingText();
    await durchlaufen();
    assert.equal(sendungen().length, 1);
  });

  it("gescheiterter Versand gibt den Merker frei und wird beim nächsten Aufruf nachgeholt", async () => {
    const err = console.error;
    console.error = () => {};
    try {
      await briefingText();
      await durchlaufen();
      assert.equal(sendungen().length, 1);
      // 400 ist ein Client-Fehler: keine Wiederholung, Versand endgültig gescheitert
      sendungen()[0].antworte(tg({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400));
      await durchlaufen();
      await durchlaufen();
      assert.equal(day().briefingDelivered, false);

      await briefingText();
      await durchlaufen();
      assert.equal(sendungen().length, 2);
      sendungen()[1].antworte(tg({ ok: true, result: { message_id: 2 } }));
      await durchlaufen();
      await durchlaufen();
      assert.equal(day().briefingDelivered, true);
      assert.ok(!JSON.stringify(sendungen().map((s) => s.body)).includes("ABCdef"), "Token nie im Text");
    } finally {
      console.error = err;
    }
  });
});
