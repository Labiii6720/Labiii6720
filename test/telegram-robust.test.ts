import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/postausgang.json liegt relativ) und Umgebung; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-telegram-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.WATCHDOG_MINUTEN = "10";

type Antwort = { status: number; body: unknown } | Error;
/** Geplante Antworten der Attrappe, in Reihenfolge; danach immer ok */
let antworten: Antwort[] = [];
let aufrufe: { method: string; text?: string }[] = [];
let gewartet: number[] = [];

globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  const method = url.split("/").pop() ?? "";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  aufrufe.push({ method, text: body.text });
  const a = antworten.shift();
  if (a instanceof Error) throw a;
  if (a) return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ ok: true, result: { message_id: aufrufe.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const fetchAttrappe = globalThis.fetch;

const { HttpFehler, gesundheit } = await import("../src/robust.js");
const { abhaengigkeiten, handleUpdate, pollWartezeit, postausgangTick, sendText, sendeSpaeter, setzeWarten } = await import("../src/telegram.js");

const POSTAUSGANG = join(temp, "data", "postausgang.json");
const netzfehler = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
const telegramFehler = (code: number, description: string, retryAfter?: number) => ({
  status: code,
  body: { ok: false, error_code: code, description, ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}) },
});
const liesPostausgang = (): { ts: string; text: string }[] => JSON.parse(readFileSync(POSTAUSGANG, "utf8")) as { ts: string; text: string }[];

/** Alle wartenden Einträge zustellen (Attrappe antwortet ok) */
async function leeren(): Promise<void> {
  antworten = [];
  await postausgangTick();
}

beforeEach(async () => {
  await leeren();
  antworten = [];
  aufrufe = [];
  gewartet = [];
  setzeWarten(async (ms) => { gewartet.push(ms); }, () => 0.5);
  gesundheit._reset();
});

describe("sendText mit Wiederholung", () => {
  it("429 mit retry_after → genau eine Wiederholung nach der angegebenen Zeit", async () => {
    antworten = [telegramFehler(429, "Too Many Requests: retry after 2", 2)];
    const id = await sendText("Guten Morgen, Sir.");
    assert.equal(aufrufe.length, 2);
    assert.deepEqual(gewartet, [2000]);
    assert.equal(typeof id, "number");
    assert.equal(gesundheit.zustand("telegram")?.ok, true);
  });

  it("400 → kein Retry, HttpFehler mit Status und Beschreibung ohne Token", async () => {
    antworten = [telegramFehler(400, "Bad Request: chat not found")];
    await assert.rejects(sendText("Hallo"), (e: unknown) => {
      assert.ok(e instanceof HttpFehler);
      assert.equal(e.status, 400);
      assert.match(e.message, /chat not found/);
      assert.doesNotMatch(e.message, /ABCdef/);
      return true;
    });
    assert.equal(aufrufe.length, 1);
    assert.deepEqual(gewartet, []);
    // der Dienst hat geantwortet → keine Störung
    assert.notEqual(gesundheit.zustand("telegram")?.ok, false);
  });

  it("401 → kein Retry", async () => {
    antworten = [telegramFehler(401, "Unauthorized")];
    await assert.rejects(sendText("Hallo"), (e: unknown) => e instanceof HttpFehler && e.status === 401);
    assert.equal(aufrufe.length, 1);
  });

  it("Netzfehler → 4 Versuche, dann Fehler; Backoff 1 s → 2 → 4", async () => {
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await assert.rejects(sendText("Hallo"), /fetch failed/);
    assert.equal(aufrufe.length, 4);
    assert.deepEqual(gewartet, [1000, 2000, 4000]);
    assert.equal(gesundheit.zustand("telegram")?.ok, false);
  });

  it("5xx wird wiederholt und klappt dann", async () => {
    antworten = [{ status: 502, body: { ok: false, error_code: 502, description: "Bad Gateway" } }];
    await sendText("Hallo");
    assert.equal(aufrufe.length, 2);
  });

  it("keine gültige JSON-Antwort → HttpFehler mit HTTP-Status", async () => {
    globalThis.fetch = (async () => new Response("<html>Gateway</html>", { status: 503 })) as typeof fetch;
    try {
      await assert.rejects(sendText("Hallo"), (e: unknown) => e instanceof HttpFehler && e.status === 503);
    } finally {
      // Attrappe wiederherstellen (siehe oben)
      globalThis.fetch = fetchAttrappe;
    }
    assert.deepEqual(gewartet, [1000, 2000, 4000]);
  });

  it("lange Texte: jeder Teil geht einzeln raus", async () => {
    await sendText("x".repeat(8001));
    assert.equal(aufrufe.length, 3);
    assert.equal(aufrufe[0].text?.length, 4000);
  });
});

describe("pollWartezeit", () => {
  const mitte = () => 0.5; // kein Jitter
  it("wächst exponentiell 1 s → 2 → 4 … bis 60 s", () => {
    const e = netzfehler();
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => pollWartezeit(e, n, mitte)), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    assert.equal(pollWartezeit(e, 20, mitte), 60000);
  });

  it("Jitter bleibt im Bereich ±20 %", () => {
    const e = new Error("Timeout nach 45000 ms");
    assert.equal(pollWartezeit(e, 3, () => 0), 3200);
    assert.equal(pollWartezeit(e, 3, () => 1), 4800);
    for (let i = 0; i < 20; i++) {
      const w = pollWartezeit(e, 3);
      assert.ok(w >= 3200 && w <= 4800, String(w));
    }
  });

  it("409 → 30 s, 401 → 300 s, unabhängig vom Fehlversuch", () => {
    assert.equal(pollWartezeit(new HttpFehler("Conflict", 409), 1, mitte), 30_000);
    assert.equal(pollWartezeit(new HttpFehler("Conflict", 409), 9, mitte), 30_000);
    assert.equal(pollWartezeit(new HttpFehler("Unauthorized", 401), 1, mitte), 300_000);
  });

  it("Retry-After von Telegram hat Vorrang", () => {
    assert.equal(pollWartezeit(new HttpFehler("Too Many Requests", 429, 7000), 1, mitte), 7000);
  });
});

describe("Postausgang", () => {
  it("Senden scheitert → Eintrag in data/postausgang.json (0600), sendeSpaeter wirft nicht", async () => {
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("⏰ Zahnarzt um 15 Uhr, Sir.");
    assert.equal(aufrufe.length, 4);
    const inhalt = liesPostausgang();
    assert.equal(inhalt.length, 1);
    assert.equal(inhalt[0].text, "⏰ Zahnarzt um 15 Uhr, Sir.");
    assert.ok(Number.isFinite(Date.parse(inhalt[0].ts)));
    assert.equal(statSync(POSTAUSGANG).mode & 0o777, 0o600);
  });

  it("solange etwas wartet, reiht sich Neues hinten an (kein Sendeversuch)", async () => {
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("erste");
    aufrufe = [];
    await sendeSpaeter("zweite");
    assert.equal(aufrufe.length, 0);
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["erste", "zweite"]);
  });

  it("postausgangTick reicht in Reihenfolge nach (Präfix mit Uhrzeit) und leert die Datei", async () => {
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("erste");
    await sendeSpaeter("zweite");
    aufrufe = [];
    antworten = [];
    await postausgangTick();
    assert.equal(aufrufe.length, 2);
    assert.match(aufrufe[0].text ?? "", /^\(nachgereicht, \d{2}:\d{2}\) erste$/);
    assert.match(aufrufe[1].text ?? "", /^\(nachgereicht, \d{2}:\d{2}\) zweite$/);
    assert.deepEqual(liesPostausgang(), []);
    // danach wird direkt gesendet
    aufrufe = [];
    await sendeSpaeter("dritte");
    assert.equal(aufrufe.length, 1);
    assert.equal(aufrufe[0].text, "dritte");
  });

  it("bleibt Telegram gestört, bleibt alles liegen; der Tick wirft nicht", async () => {
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("erste");
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await postausgangTick();
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["erste"]);
  });

  it("client-Fehler: sendeSpaeter wirft und legt nichts ab; im Tick wird der Eintrag verworfen", async () => {
    antworten = [telegramFehler(400, "Bad Request: message is too long")];
    await assert.rejects(sendeSpaeter("kaputt"), (e: unknown) => e instanceof HttpFehler && e.status === 400);
    assert.deepEqual(liesPostausgang(), []);

    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("erste");
    await sendeSpaeter("zweite");
    const fehler = console.error;
    const geloggt: string[] = [];
    console.error = (...a: unknown[]) => { geloggt.push(a.map(String).join(" ")); };
    try {
      antworten = [telegramFehler(400, "Bad Request: message is too long")];
      await postausgangTick();
    } finally {
      console.error = fehler;
    }
    assert.deepEqual(liesPostausgang(), []);
    assert.ok(geloggt.some((z) => z.includes("Postausgang") && z.includes("HTTP 400")));
  });

  it("Begrenzung: höchstens 100 Einträge, die ältesten fliegen raus", async () => {
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("n0");
    for (let i = 1; i <= 110; i++) await sendeSpaeter(`n${i}`);
    const inhalt = liesPostausgang();
    assert.equal(inhalt.length, 100);
    assert.equal(inhalt[0].text, "n11");
    assert.equal(inhalt[99].text, "n110");
  });

  it("Nachreichen bei vollem Postausgang: nebenläufiges sendeSpaeter verwirft keine fremde Nachricht", async () => {
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    for (let i = 0; i < 100; i++) await sendeSpaeter(`n${i}`);
    assert.equal(liesPostausgang().length, 100);
    aufrufe = [];
    // Während der erste Eintrag unterwegs ist, meldet sich eine Wache: der Postausgang ist voll, der älteste
    // Eintrag (genau der gerade gesendete) fliegt raus – die nächste Nachricht darf dadurch nicht verloren gehen.
    let erster = true;
    globalThis.fetch = (async (eingabe, init) => {
      if (erster) {
        erster = false;
        await sendeSpaeter("neu");
        assert.equal(liesPostausgang().length, 100);
      }
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
    try {
      await postausgangTick();
    } finally {
      globalThis.fetch = fetchAttrappe;
    }
    const texte = aufrufe.map((a) => (a.text ?? "").replace(/^\(nachgereicht, \d{2}:\d{2}\) /, ""));
    const erwartet = [...Array.from({ length: 100 }, (_, i) => `n${i}`), "neu"];
    assert.deepEqual(texte, erwartet);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("Watchdog-Melder: gesundheit.tick schickt die Meldung über den Postausgang", async () => {
    gesundheit.setzeMelder(sendeSpaeter);
    const start = Date.now();
    gesundheit.melde("homeassistant", false, "HTTP 502", start);
    aufrufe = [];
    await gesundheit.tick(start + 11 * 60_000);
    assert.equal(aufrufe.length, 1);
    assert.match(aufrufe[0].text ?? "", /^Sir, Home Assistant antwortet seit 11 Minuten nicht \(HTTP 502\)\. Ich versuche es weiter\.$/);
  });
});

describe("handleUpdate: Antwort von Claude und Telegram-Sendefehler", () => {
  const nachricht = (text: string) => ({ update_id: 1, message: { message_id: 7, chat: { id: 12345 }, text } });
  const origHandle = abhaengigkeiten.handleMessage;
  const origErr = console.error;
  let geloggt: string[] = [];
  beforeEach(() => {
    geloggt = [];
    console.error = (...a: unknown[]) => { geloggt.push(a.map(String).join(" ")); };
  });
  afterEach(() => {
    abhaengigkeiten.handleMessage = origHandle;
    console.error = origErr;
    globalThis.fetch = fetchAttrappe;
  });

  /** sendMessage scheitert mit Netzfehler, alles andere (sendChatAction) klappt */
  const nurSendenKaputt = () => {
    globalThis.fetch = (async (eingabe, init) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      if (url.endsWith("/sendMessage")) {
        aufrufe.push({ method: "sendMessage", text: (JSON.parse(String(init?.body)) as { text?: string }).text });
        throw netzfehler();
      }
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
  };

  it("ohne Störung: Antwort geht direkt raus, nichts im Postausgang", async () => {
    abhaengigkeiten.handleMessage = async () => "Guten Morgen, Sir.";
    await handleUpdate(nachricht("Hallo"));
    const gesendet = aufrufe.filter((a) => a.method === "sendMessage");
    assert.deepEqual(gesendet.map((a) => a.text), ["Guten Morgen, Sir."]);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("Telegram scheitert nach der Antwort: Antwort landet im Postausgang, kein Claude-Fehlertext", async () => {
    abhaengigkeiten.handleMessage = async () => "Guten Morgen, Sir.";
    nurSendenKaputt();
    await handleUpdate(nachricht("Hallo"));
    const gesendet = aufrufe.filter((a) => a.method === "sendMessage");
    assert.equal(gesendet.length, 4); // vier Versuche für die Antwort selbst
    assert.ok(gesendet.every((a) => a.text === "Guten Morgen, Sir."));
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["Guten Morgen, Sir."]);
    assert.ok(!geloggt.some((z) => z.includes("Claude-API")));
    // kommt Telegram zurück, wird die Antwort nachgereicht
    globalThis.fetch = fetchAttrappe;
    aufrufe = [];
    await postausgangTick();
    assert.match(aufrufe[0]?.text ?? "", /^\(nachgereicht, \d{2}:\d{2}\) Guten Morgen, Sir\.$/);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("Claude scheitert vorübergehend: klarer Text über die Claude-API, nichts im Postausgang", async () => {
    abhaengigkeiten.handleMessage = async () => { throw netzfehler(); };
    await handleUpdate(nachricht("Hallo"));
    const gesendet = aufrufe.filter((a) => a.method === "sendMessage");
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0].text ?? "", /^Die Verbindung zur Claude-API ist gerade unterbrochen \(Netzfehler\)\. Ich habe es dreimal versucht/);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("client-Fehler beim Senden: Antwort wird nicht abgelegt", async () => {
    abhaengigkeiten.handleMessage = async () => "x".repeat(10);
    globalThis.fetch = (async (eingabe, init) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      if (url.endsWith("/sendMessage")) antworten = [telegramFehler(400, "Bad Request: message is too long")];
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
    await handleUpdate(nachricht("Hallo"));
    assert.equal(aufrufe.filter((a) => a.method === "sendMessage").length, 1);
    assert.deepEqual(liesPostausgang(), []);
  });
});
