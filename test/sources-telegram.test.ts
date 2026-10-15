import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/ liegt relativ) und Umgebung; nie echte Dienste
const temp = mkdtempSync(join(tmpdir(), "jarvis-sources-telegram-"));
process.chdir(temp);
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.LAT = "47.37";
process.env.LON = "8.54";
process.env.WATCHDOG_MINUTEN = "10";
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

// ---------- fetch-Attrappe ----------

type Antwort = Response | Error;
interface Aufruf { url: string; method: string; body: string }

const aufrufe: Aufruf[] = [];
let antworten: Antwort[] = [];
const echteFetch = globalThis.fetch;

const http = (status: number, text = "") => new Response(text, { status });
const tg = (daten: unknown, status = 200) => new Response(JSON.stringify(daten), { status, headers: { "content-type": "application/json" } });
const okAntwort = () => tg({ ok: true, result: { message_id: 7 } });
/** undici-Form: TypeError «fetch failed» mit der Ursache in cause.code */
const netz = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${code}`), { code }) });

globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  aufrufe.push({ url: String(eingabe instanceof Request ? eingabe.url : eingabe), method: init?.method ?? "GET", body: String(init?.body ?? "") });
  const a = antworten.shift();
  if (!a) throw new Error("Attrappe: keine Antwort mehr vorgesehen");
  if (a instanceof Error) throw a;
  return a;
}) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const sources = await import("../src/sources.js");
const { gesundheit, HttpFehler } = await import("../src/robust.js");
const { state } = await import("../src/state.js");

function fangeLogs(): { fehler: string[]; info: string[]; ende: () => void } {
  const fehler: string[] = [];
  const info: string[] = [];
  const log = console.log; const err = console.error;
  console.log = (...a: unknown[]) => { info.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
  return { fehler, info, ende: () => { console.log = log; console.error = err; } };
}

const gewartet: number[] = [];
let logs: ReturnType<typeof fangeLogs>;
beforeEach(() => {
  aufrufe.length = 0;
  antworten = [];
  gewartet.length = 0;
  gesundheit._reset();
  sources._testOptionen.warten = async (ms) => { gewartet.push(ms); };
  sources._testOptionen.zufall = () => 0.5;
  delete state.paused;
  delete state.notfall;
  logs = fangeLogs();
});
afterEach(() => logs.ende());

describe("Briefing an Telegram (sources.sendTelegram)", () => {
  it("Erfolg: ein Aufruf, richtige Nutzlast, Telegram gesund", async () => {
    antworten = [okAntwort()];
    await sources.sendTelegram("Guten Morgen, Sir.");
    assert.equal(aufrufe.length, 1);
    assert.equal(aufrufe[0]!.method, "POST");
    assert.equal(aufrufe[0]!.url, `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`);
    assert.deepEqual(JSON.parse(aufrufe[0]!.body), { chat_id: "12345", text: "Guten Morgen, Sir." });
    assert.deepEqual(gewartet, []);
    assert.equal(gesundheit.zustand("telegram")?.ok, true);
    assert.equal(logs.fehler.length, 0);
  });

  it("502 und Netzfehler werden wiederholt (1 s → 2 s), dritter Versuch klappt", async () => {
    antworten = [http(502, "<html>Bad Gateway</html>"), netz("ECONNRESET"), okAntwort()];
    await sources.sendTelegram("Briefing");
    assert.equal(aufrufe.length, 3);
    assert.deepEqual(gewartet, [1000, 2000]);
    assert.equal(gesundheit.zustand("telegram")?.ok, true);
    // Störung einmal geloggt, Token nie im Log
    assert.equal(logs.fehler.length, 1);
    assert.match(logs.fehler[0]!, /telegram\.sendMessage: Telegram HTTP 502/);
    for (const l of [...logs.fehler, ...logs.info]) assert.doesNotMatch(l, /ABCdefGHIjklMNOpqrSTUvwxYZ/);
  });

  it("429 mit retry_after: genau eine Wiederholung nach der genannten Zeit", async () => {
    antworten = [tg({ ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } }, 429), okAntwort()];
    await sources.sendTelegram("Briefing");
    assert.equal(aufrufe.length, 2);
    assert.deepEqual(gewartet, [3000]);
  });

  it("400 (chat not found): kein zweiter Versuch, HttpFehler mit Status", async () => {
    antworten = [tg({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400), okAntwort()];
    await assert.rejects(sources.sendTelegram("Briefing"), (e: unknown) =>
      e instanceof HttpFehler && e.status === 400 && e.message === "Telegram HTTP 400 (Bad Request: chat not found)");
    assert.equal(aufrufe.length, 1);
    assert.deepEqual(gewartet, []);
  });

  it("dauerhaft gestört: vier Versuche, dann letzter Fehler, Telegram als gestört vermerkt", async () => {
    antworten = [netz("ENOTFOUND"), netz("ENOTFOUND"), http(503), netz("ENOTFOUND"), okAntwort()];
    await assert.rejects(sources.sendTelegram("Briefing"), (e: unknown) => e instanceof TypeError && e.message === "fetch failed");
    assert.equal(aufrufe.length, 4);
    assert.deepEqual(gewartet, [1000, 2000, 4000]);
    const z = gesundheit.zustand("telegram");
    assert.equal(z?.ok, false);
    assert.equal(z?.fehler, 4);
  });

  it("Notfall zwischen den Versuchen (während der Wartezeit): kein weiterer Versuch, letzter echter Fehler", async () => {
    antworten = [http(502), okAntwort()];
    sources._testOptionen.warten = async (ms) => {
      gewartet.push(ms);
      state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    };
    await assert.rejects(sources.sendTelegram("Briefing mit Terminen"), (e: unknown) => e instanceof HttpFehler && e.status === 502);
    assert.equal(aufrufe.length, 1);
    assert.deepEqual(gewartet, [1000]);
  });

  it("Notaus nach einem Fehlversuch: keine Wiederholung", async () => {
    antworten = [http(502), okAntwort()];
    const echt = globalThis.fetch;
    globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
      try { return await echt(...a); } finally { state.paused = true; }
    }) as typeof fetch;
    try {
      await assert.rejects(sources.sendTelegram("Briefing"), (e: unknown) => e instanceof HttpFehler && e.status === 502);
    } finally {
      globalThis.fetch = echt;
    }
    assert.equal(aufrufe.length, 1);
    assert.deepEqual(gewartet, []);
  });

  it("Notaus oder Notfall schon vor dem Start: nichts senden, Fehler (Kopie gilt nicht als zugestellt)", async () => {
    antworten = [okAntwort()];
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    await assert.rejects(sources.sendTelegram("Briefing"), /zurückgehalten/);
    delete state.notfall;
    state.paused = true;
    await assert.rejects(sources.sendTelegram("Briefing"), /zurückgehalten/);
    assert.equal(aufrufe.length, 0);
  });

  it("Notfall vorbei (aktiv: false): Versand normal", async () => {
    antworten = [okAntwort()];
    state.notfall = { aktiv: false, seit: new Date().toISOString(), grund: "Test" };
    await sources.sendTelegram("Briefing");
    assert.equal(aufrufe.length, 1);
  });

  it("ohne Token/Chat-ID: nichts senden, kein Fehler", async () => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      await sources.sendTelegram("Briefing");
      assert.equal(aufrufe.length, 0);
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = token;
    }
  });
});
