import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/postausgang.json liegt relativ) und Umgebung; nie echte Dienste
const temp = mkdtempSync(join(tmpdir(), "jarvis-telegram-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.WATCHDOG_MINUTEN = "10";
process.env.JARVIS_PIN = "4711";

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
const { abhaengigkeiten, annehmen, approveAuftrag, denyAuftrag, handleUpdate, istDringend, naechsterOffset, pollFehlerMelden, pollWartezeit, postausgangTick, remindersTick, sendText, sendeSpaeter, setzeWarten, verteileUpdate } = await import("../src/telegram.js");
const { state } = await import("../src/state.js");
const { reminders } = await import("../src/tools.js");
const { createAuftrag, getAuftrag } = await import("../src/queue.js");
const { config } = await import("../src/config.js");
const { protokolle } = await import("../src/protokolle.js");
const { missbrauchZuruecksetzen } = await import("../src/notfall.js");

const POSTAUSGANG = join(temp, "data", "postausgang.json");
const netzfehler = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
const telegramFehler = (code: number, description: string, retryAfter?: number) => ({
  status: code,
  body: { ok: false, error_code: code, description, ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}) },
});
const okAntwort = (): Antwort => ({ status: 200, body: { ok: true, result: { message_id: 1 } } });
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
  // PIN-förmige Eingaben zählen als Missbrauch: kein Fall soll die übrigen in den Notfall zählen
  missbrauchZuruecksetzen();
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

  it("Abbruch beim Lesen der Antwort (Netz) wird als Netzfehler wiederholt, nicht als HTTP 200", async () => {
    let erster = true;
    globalThis.fetch = (async (eingabe, init) => {
      if (erster) {
        erster = false;
        const abbruch = Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
        const body = new ReadableStream<Uint8Array>({ start(c) { c.error(abbruch); } });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      }
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
    try {
      await sendText("Hallo");
    } finally {
      globalThis.fetch = fetchAttrappe;
    }
    assert.deepEqual(gewartet, [1000]);
    assert.equal(aufrufe.length, 1); // nur der zweite Versuch geht durch die Attrappe
  });

  it("Zeitlimit beim Lesen der Antwort bleibt ein Zeitlimit-Fehler", async () => {
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({ start(c) { c.error(new DOMException("The operation was aborted due to timeout", "TimeoutError")); } });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    try {
      await assert.rejects(sendText("Hallo"), (e: unknown) => !(e instanceof HttpFehler) && (e as Error).name === "TimeoutError");
    } finally {
      globalThis.fetch = fetchAttrappe;
    }
    assert.deepEqual(gewartet, [1000, 2000, 4000]);
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

  it("langer Text, zweiter Teil scheitert: nur der Rest landet im Postausgang, nichts kommt doppelt", async () => {
    const text = "A".repeat(4000) + "B".repeat(100);
    antworten = [okAntwort(), netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter(text);
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["B".repeat(100)]);
    aufrufe = [];
    await postausgangTick();
    assert.equal(aufrufe.length, 1);
    assert.match(aufrufe[0].text ?? "", /^\(nachgereicht, \d{2}:\d{2}\) B{100}$/);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("Nachreichen eines langen Eintrags bricht nach Teil 1 ab: beim nächsten Tick nur der Rest", async () => {
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("A".repeat(4500) + "B".repeat(200));
    aufrufe = [];
    antworten = [okAntwort(), netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await postausgangTick();
    const erster = aufrufe[0].text ?? "";
    assert.equal(erster.length, 4000);
    const restText = liesPostausgang().map((e) => e.text);
    assert.equal(restText.length, 1);
    // zugestellt + liegengeblieben = genau der Originaltext (nach dem Präfix)
    assert.equal(erster.replace(/^\(nachgereicht, \d{2}:\d{2}\) /, "") + restText[0], "A".repeat(4500) + "B".repeat(200));
    aufrufe = [];
    antworten = [];
    await postausgangTick();
    assert.equal(aufrufe.length, 1);
    assert.equal(aufrufe[0].text?.replace(/^\(nachgereicht, \d{2}:\d{2}\) /, ""), restText[0]);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("Watchdog-Melder: gesundheit.tick schickt die Meldung über den Postausgang", async () => {
    gesundheit.setzeMelder(sendeSpaeter);
    const start = Date.now();
    // Dauerstörung: Fehler über die ganze Watchdog-Schwelle (10 Min), der letzte frisch
    gesundheit.melde("homeassistant", false, "HTTP 502", start);
    gesundheit.melde("homeassistant", false, "HTTP 502", start + 10 * 60_000);
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

  it("Notaus zwischen Claude-Antwort und Senden: nur der Pausenhinweis geht raus", async () => {
    abhaengigkeiten.handleMessage = async () => {
      state.paused = true; // /pause trifft ein, nachdem runLoop schon zurückgegeben hat
      return "Ihre Rechnungen: geheim.";
    };
    try {
      await handleUpdate(nachricht("Rechnungen?"));
    } finally {
      state.paused = false;
    }
    const gesendet = aufrufe.filter((a) => a.method === "sendMessage");
    assert.deepEqual(gesendet.map((a) => a.text), ["Ich bin pausiert (Notaus). In Telegram hebt /weiter das wieder auf."]);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("Notfall zwischen Claude-Antwort und Senden: der Hinweis nennt /entwarnung, nicht /weiter", async () => {
    abhaengigkeiten.handleMessage = async () => {
      state.paused = true;
      state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
      return "Ihre Rechnungen: geheim.";
    };
    try {
      await handleUpdate(nachricht("Rechnungen?"));
    } finally {
      state.paused = false;
      state.notfall = { aktiv: false };
    }
    const gesendet = aufrufe.filter((a) => a.method === "sendMessage").map((a) => a.text ?? "");
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0], /\/entwarnung/);
    assert.doesNotMatch(gesendet[0], /\/weiter/);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("lange Antwort, zweiter Teil scheitert: nur der Rest landet im Postausgang", async () => {
    abhaengigkeiten.handleMessage = async () => "A".repeat(4000) + "B".repeat(50);
    let n = 0;
    globalThis.fetch = (async (eingabe, init) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      if (url.endsWith("/sendMessage") && n++ > 0) throw netzfehler();
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
    await handleUpdate(nachricht("Liste bitte"));
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["B".repeat(50)]);
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

describe("remindersTick", () => {
  it("überlappende Ticks schicken dieselbe Erinnerung nur einmal", async () => {
    reminders.splice(0, reminders.length, { at: new Date(Date.now() - 1000).toISOString(), text: "Zahnarzt" });
    let freigeben!: () => void;
    const gesperrt = new Promise<void>((r) => { freigeben = r; });
    globalThis.fetch = (async (eingabe, init) => {
      await gesperrt; // Telegram hängt, bis der zweite Tick gelaufen ist
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
    try {
      const a = remindersTick();
      await remindersTick(); // läuft, während der erste noch sendet
      freigeben();
      await a;
    } finally {
      globalThis.fetch = fetchAttrappe;
    }
    assert.deepEqual(aufrufe.filter((x) => x.method === "sendMessage").map((x) => x.text), ["⏰ Zahnarzt"]);
    assert.equal(reminders.length, 0);
    // nach dem Lauf ist die Sperre wieder offen
    reminders.push({ at: new Date(Date.now() - 1000).toISOString(), text: "Post" });
    await remindersTick();
    assert.equal(aufrufe.at(-1)?.text, "⏰ Post");
  });
});

describe("pollFehlerMelden", () => {
  it("HTTP 409 (zweiter Poller) ist keine Telegram-Störung: keine Watchdog-Schleife", async () => {
    const meldungen: string[] = [];
    gesundheit.setzeMelder(async (t) => { meldungen.push(t); });
    for (let i = 0; i < 5; i++) pollFehlerMelden(new HttpFehler("Conflict: terminated by other getUpdates request (getUpdates)", 409));
    assert.notEqual(gesundheit.zustand("telegram-empfang")?.ok, false);
    assert.notEqual(gesundheit.zustand("telegram")?.ok, false);
    await gesundheit.tick(Date.now() + 11 * 60_000);
    assert.deepEqual(meldungen, []);
  });

  it("Netzfehler: Telegram-Empfang und internet gestört, Senden nicht", () => {
    pollFehlerMelden(netzfehler());
    assert.equal(gesundheit.zustand("telegram-empfang")?.ok, false);
    assert.notEqual(gesundheit.zustand("telegram")?.ok, false);
    assert.equal(gesundheit.zustand("internet")?.ok, false);
  });

  it("502: Telegram-Empfang gestört, internet nicht", () => {
    pollFehlerMelden(new HttpFehler("Bad Gateway (getUpdates)", 502));
    assert.equal(gesundheit.zustand("telegram-empfang")?.ok, false);
    assert.notEqual(gesundheit.zustand("internet")?.ok, false);
  });
});

describe("pollFehlerMelden: Empfang getrennt vom Senden", () => {
  it("Senden klappt, Empfang bleibt gestört: Watchdog meldet den Telegram-Empfang", async () => {
    const meldungen: string[] = [];
    gesundheit.setzeMelder(async (t) => { meldungen.push(t); });
    const t0 = Date.now();
    gesundheit.melde("telegram-empfang", false, "telegram.getUpdates: HTTP 502", t0);
    gesundheit.melde("telegram", true, undefined, t0 + 5 * 60_000);
    gesundheit.melde("telegram-empfang", false, "telegram.getUpdates: HTTP 502", t0 + 10 * 60_000);
    assert.equal(gesundheit.zustand("telegram-empfang")?.ok, false);
    await gesundheit.tick(t0 + 11 * 60_000);
    assert.equal(meldungen.length, 1);
    assert.match(meldungen[0], /^Sir, der Telegram-Empfang antwortet seit 11 Minuten nicht/);
  });
});

describe("verteileUpdate: Notaus wartet nicht auf laufende Anfragen", () => {
  const origHandle = abhaengigkeiten.handleMessage;
  const nachricht = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, text } });
  afterEach(() => {
    abhaengigkeiten.handleMessage = origHandle;
    state.paused = false;
  });

  it("istDringend: nur /pause und /notfall", () => {
    assert.equal(istDringend(nachricht(1, "/pause")), true);
    assert.equal(istDringend(nachricht(1, "  /NOTFALL jetzt")), true);
    assert.equal(istDringend(nachricht(1, "/weiter")), false);
    assert.equal(istDringend(nachricht(1, "pause")), false);
    assert.equal(istDringend({ update_id: 1 }), false);
  });

  it("/pause greift, während eine Anfrage noch hängt; normale Nachrichten bleiben in Reihenfolge", async () => {
    let freigeben!: () => void;
    const haengt = new Promise<void>((r) => { freigeben = r; });
    const reihenfolge: string[] = [];
    abhaengigkeiten.handleMessage = async (text: string) => {
      reihenfolge.push(`start ${text}`);
      if (text === "erste") await haengt;
      reihenfolge.push(`ende ${text}`);
      return `Antwort auf ${text}`;
    };
    const erste = verteileUpdate(nachricht(1, "erste"));
    const zweite = verteileUpdate(nachricht(2, "zweite"));
    for (let i = 0; i < 100 && reihenfolge.length === 0; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(reihenfolge, ["start erste"]); // die erste Anfrage hängt bei Claude
    await verteileUpdate(nachricht(3, "/pause"));
    assert.equal(state.paused, true);
    assert.ok(aufrufe.some((a) => a.method === "sendMessage" && /^⛔ Notaus\./.test(a.text ?? "")));
    assert.deepEqual(reihenfolge, ["start erste"]);
    freigeben();
    await Promise.all([erste, zweite]);
    assert.deepEqual(reihenfolge, ["start erste", "ende erste", "start zweite", "ende zweite"]);
  });
});

describe("Freigabe bei Telegram-Störung: Ausführung und Meldung getrennt", () => {
  const origErr = console.error;
  beforeEach(() => {
    state.paused = false;
    console.error = () => undefined;
  });
  afterEach(() => {
    console.error = origErr;
    globalThis.fetch = fetchAttrappe;
    reminders.splice(0, reminders.length);
  });

  /** sendMessage scheitert dauerhaft mit Netzfehler */
  const sendenKaputt = () => {
    globalThis.fetch = (async (eingabe, init) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      if (url.endsWith("/sendMessage")) {
        aufrufe.push({ method: "sendMessage", text: (JSON.parse(String(init?.body)) as { text?: string }).text });
        throw netzfehler();
      }
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
  };
  const erinnerung = (zeit: string) =>
    createAuftrag({ tool: "erinnerung", input: { zeit, text: "Zahnarzt" }, stufe: "extern", summary: "Erinnerung Zahnarzt" });

  it("Dashboard-Freigabe: Werkzeug lief → «erledigt», kein Wurf, Meldung im Postausgang", async () => {
    sendenKaputt();
    const a = erinnerung(new Date(Date.now() + 3_600_000).toISOString());
    const antwort = await approveAuftrag(a);
    assert.match(antwort, new RegExp(`^✅ #${a.id} erledigt: Erinnerung gesetzt`));
    assert.equal(getAuftrag(a.id)?.status, "erledigt");
    assert.equal(reminders.length, 1); // die Nebenwirkung genau einmal
    assert.equal(aufrufe.filter((x) => x.method === "sendMessage").length, 4); // nur die Erfolgsmeldung, kein ⚠️ hinterher
    assert.deepEqual(liesPostausgang().map((e) => e.text), [`✅ #${a.id} erledigt: ${getAuftrag(a.id)?.result}`]);
    const chat = readFileSync(join(temp, "data", "chat.json"), "utf8");
    assert.ok(chat.includes(`Auftrag #${a.id} (erinnerung) wurde freigegeben und ausgeführt`));
    assert.ok(!chat.includes(`Auftrag #${a.id} (erinnerung) wurde freigegeben, schlug aber fehl`));
  });

  it("Werkzeug scheitert und Telegram auch: «fehler», kein Wurf, Warnung im Postausgang", async () => {
    sendenKaputt();
    const a = erinnerung("kein Datum");
    const antwort = await approveAuftrag(a);
    assert.equal(antwort, `⚠️ #${a.id}: Ungültige Zeit.`);
    assert.equal(getAuftrag(a.id)?.status, "fehler");
    assert.deepEqual(liesPostausgang().map((e) => e.text), [`⚠️ #${a.id} fehlgeschlagen: Ungültige Zeit.`]);
  });

  it("ohne Störung: Erfolgsmeldung geht direkt raus, auch wenn Altes im Postausgang wartet (Vorrang)", async () => {
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("alt");
    aufrufe = [];
    const a = erinnerung(new Date(Date.now() + 3_600_000).toISOString());
    await approveAuftrag(a);
    assert.deepEqual(aufrufe.filter((x) => x.method === "sendMessage").map((x) => x.text), [`✅ #${a.id} erledigt: ${getAuftrag(a.id)?.result}`]);
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["alt"]);
  });
});

describe("sendeSpaeter mit Vorrang", () => {
  it("sendet sofort, obwohl etwas wartet; die Warteschlange bleibt unberührt", async () => {
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("alt");
    aufrufe = [];
    await sendeSpaeter("🚨 Alarm", { vorrang: true });
    assert.deepEqual(aufrufe.map((x) => x.text), ["🚨 Alarm"]);
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["alt"]);
  });

  it("scheitert es, kommt der Text vorn in den Postausgang und wird zuerst nachgereicht", async () => {
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("alt");
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("🚨 Alarm", { vorrang: true });
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["🚨 Alarm", "alt"]);
    aufrufe = [];
    await postausgangTick();
    assert.match(aufrufe[0]?.text ?? "", /^\(nachgereicht, \d{2}:\d{2}\) 🚨 Alarm$/);
  });

  it("voller Postausgang: der Vorrang-Text bleibt, der älteste übrige fliegt raus", async () => {
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    for (let i = 0; i < 100; i++) await sendeSpaeter(`n${i}`);
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("🚨 Alarm", { vorrang: true });
    const inhalt = liesPostausgang().map((e) => e.text);
    assert.equal(inhalt.length, 100);
    assert.equal(inhalt[0], "🚨 Alarm");
    assert.equal(inhalt[1], "n1");
    assert.equal(inhalt[99], "n99");
  });
});

describe("PIN-Abfrage: Notaus und abgelaufenes Warten", () => {
  const origHandle = abhaengigkeiten.handleMessage;
  const nachricht = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, text } });
  const freigabeTippen = (id: number) =>
    handleUpdate({ update_id: 1, callback_query: { id: "cb", data: `ok:${id}`, from: { id: 12345 } } });
  const sensibel = () => createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "PIN" }, stufe: "sensibel", summary: "sensibel" });
  const gesendet = () => aufrufe.filter((x) => x.method === "sendMessage").map((x) => x.text ?? "");
  const origNow = Date.now;
  afterEach(() => {
    abhaengigkeiten.handleMessage = origHandle;
    Date.now = origNow;
    state.paused = false;
    state.notfall = { aktiv: false };
    reminders.splice(0, reminders.length);
  });

  it("/notfall während die PIN erwartet wird: Notfall greift, nichts wird gelöscht", async () => {
    const a = sensibel();
    await freigabeTippen(a.id);
    aufrufe = [];
    await verteileUpdate(nachricht(20, "/notfall"));
    assert.equal(state.notfall?.aktiv, true);
    assert.equal(state.paused, true);
    assert.ok(!aufrufe.some((x) => x.method === "deleteMessage"));
    assert.ok(gesendet().some((t) => t.startsWith("🚨 NOTFALL")));
    assert.equal(getAuftrag(a.id)?.status, "offen");
    // eine danach getippte PIN wird gelöscht, führt aber nichts aus (Notaus)
    aufrufe = [];
    await handleUpdate(nachricht(21, "4711"));
    assert.ok(aufrufe.some((x) => x.method === "deleteMessage"));
    assert.equal(getAuftrag(a.id)?.status, "offen");
    assert.equal(reminders.length, 0);
    // im Notfall verweist der Hinweis auf /entwarnung, nicht auf /weiter
    assert.ok(gesendet().some((t) => t === "🚨 Notfall aktiv, Sir. Erst /entwarnung."));
    assert.ok(!gesendet().some((t) => t.includes("/weiter")));
  });

  it("/pause während die PIN erwartet wird: Notaus greift, Auftrag bleibt offen", async () => {
    const a = sensibel();
    await freigabeTippen(a.id);
    aufrufe = [];
    await verteileUpdate(nachricht(22, "/pause"));
    assert.equal(state.paused, true);
    assert.ok(!aufrufe.some((x) => x.method === "deleteMessage"));
    assert.ok(gesendet().some((t) => /^⛔ Notaus\./.test(t)));
    assert.equal(getAuftrag(a.id)?.status, "offen");
  });

  it("abgelaufen: eine spätere normale Nachricht geht an Claude und wird nicht gelöscht", async () => {
    const a = sensibel();
    await freigabeTippen(a.id);
    const jetzt = origNow();
    Date.now = () => jetzt + 3 * 60 * 60_000;
    let erhalten = "";
    abhaengigkeiten.handleMessage = async (text: string) => { erhalten = text; return "Gern, Sir."; };
    aufrufe = [];
    await handleUpdate(nachricht(23, "Wie wird das Wetter?"));
    assert.equal(erhalten, "Wie wird das Wetter?");
    assert.ok(!aufrufe.some((x) => x.method === "deleteMessage"));
    assert.equal(getAuftrag(a.id)?.status, "offen");
  });

  it("abgelaufen, aber die PIN selbst: gelöscht statt an Claude, Hinweis auf /auftraege", async () => {
    const a = sensibel();
    await freigabeTippen(a.id);
    const jetzt = origNow();
    Date.now = () => jetzt + 3 * 60_000;
    let claudeGefragt = false;
    abhaengigkeiten.handleMessage = async () => { claudeGefragt = true; return ""; };
    aufrufe = [];
    await handleUpdate(nachricht(24, "4711"));
    assert.equal(claudeGefragt, false);
    assert.ok(aufrufe.some((x) => x.method === "deleteMessage"));
    assert.ok(gesendet().some((t) => t === `Zeit abgelaufen. /auftraege zeigt #${a.id} nochmal.`));
    assert.equal(getAuftrag(a.id)?.status, "offen");
  });

  it("rechtzeitig mit richtiger PIN: Auftrag läuft wie bisher", async () => {
    const a = sensibel();
    await freigabeTippen(a.id);
    aufrufe = [];
    await handleUpdate(nachricht(25, "4711"));
    assert.equal(getAuftrag(a.id)?.status, "erledigt");
    assert.ok(gesendet().some((t) => t.startsWith(`✅ #${a.id} erledigt:`)));
  });
});

describe("Notaus-Reihenfolge: ein eingereihtes /weiter oder /entwarnung hebt einen neueren Notaus nicht auf", () => {
  const origHandle = abhaengigkeiten.handleMessage;
  const nachricht = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, text } });
  const gesendet = () => aufrufe.filter((x) => x.method === "sendMessage").map((x) => x.text ?? "");
  afterEach(() => {
    abhaengigkeiten.handleMessage = origHandle;
    state.paused = false;
    state.notfall = { aktiv: false };
  });

  /** Erste Nachricht hängt bei Claude; danach kommen `befehle` in dieser Reihenfolge an. */
  async function mitHaengenderAnfrage(startId: number, befehle: string[]): Promise<void> {
    let freigeben!: () => void;
    const haengt = new Promise<void>((r) => { freigeben = r; });
    let gestartet = false;
    abhaengigkeiten.handleMessage = async () => { gestartet = true; await haengt; return "fertig"; };
    const laeufe = [verteileUpdate(nachricht(startId, "Frage"))];
    for (let i = 0; i < 100 && !gestartet; i++) await new Promise((r) => setImmediate(r));
    assert.equal(gestartet, true);
    for (const [i, b] of befehle.entries()) {
      const lauf = verteileUpdate(nachricht(startId + 1 + i, b));
      laeufe.push(lauf);
      if (istDringend(nachricht(0, b))) await lauf; // vorgezogen: läuft, während die Anfrage noch hängt
    }
    freigeben();
    await Promise.all(laeufe);
  }

  it("/weiter, dann /pause, während eine Anfrage hängt: der Notaus bleibt an", async () => {
    await mitHaengenderAnfrage(1001, ["/weiter", "/pause"]);
    assert.equal(state.paused, true);
    assert.ok(gesendet().includes("/weiter kam vor dem Notaus an und gilt nicht, Sir. Bitte erneut senden."));
    assert.ok(!gesendet().includes("▶️ Weiter geht's."));
  });

  it("/entwarnung, dann /notfall, während eine Anfrage hängt: der Notfall bleibt aktiv", async () => {
    await mitHaengenderAnfrage(1011, ["/entwarnung", "/notfall"]);
    assert.equal(state.notfall?.aktiv, true);
    assert.equal(state.paused, true);
    assert.ok(gesendet().includes("/entwarnung kam vor dem Notaus an und gilt nicht, Sir. Bitte erneut senden."));
  });

  it("ein nach dem /pause getipptes /weiter gilt weiterhin", async () => {
    await mitHaengenderAnfrage(1021, ["/pause", "/weiter"]);
    assert.equal(state.paused, false);
    assert.ok(gesendet().includes("▶️ Weiter geht's."));
  });

  it("/weiter im aktiven Notfall hebt den Notaus nicht auf", async () => {
    await verteileUpdate(nachricht(1031, "/notfall"));
    await verteileUpdate(nachricht(1032, "/weiter"));
    assert.equal(state.notfall?.aktiv, true);
    assert.equal(state.paused, true);
    assert.ok(gesendet().includes("Es läuft ein Notfall, Sir. Erst /entwarnung."));
  });
});

describe("Freigabe: genau einmal ausführen, ohne langes Warten zwischen Prüfung und Ausführung", () => {
  const origErr = console.error;
  beforeEach(() => {
    state.paused = false;
    reminders.splice(0, reminders.length);
    console.error = () => undefined;
  });
  afterEach(() => {
    console.error = origErr;
    globalThis.fetch = fetchAttrappe;
    reminders.splice(0, reminders.length);
  });
  const erinnerung = () =>
    createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "Einmal" }, stufe: "extern", summary: "Erinnerung" });

  it("zwei gleichzeitige Freigaben (Doppelklick): das Werkzeug läuft genau einmal", async () => {
    const a = erinnerung();
    const antworten2 = await Promise.all([approveAuftrag(a), approveAuftrag(a)]);
    assert.equal(reminders.length, 1);
    assert.equal(antworten2.filter((t) => t.startsWith(`✅ #${a.id} erledigt`)).length, 1);
    assert.ok(antworten2.includes(`#${a.id} wird bereits ausgeführt, Sir.`));
    assert.equal(getAuftrag(a.id)?.status, "erledigt");
  });

  it("Ablehnen während der Ausführung wird abgewiesen, der Status bleibt «erledigt»", async () => {
    const a = erinnerung();
    const [ok, nein] = await Promise.all([approveAuftrag(a), denyAuftrag(a)]);
    assert.match(ok, new RegExp(`^✅ #${a.id} erledigt`));
    assert.equal(nein, `#${a.id} wird bereits ausgeführt, Sir.`);
    assert.equal(getAuftrag(a.id)?.status, "erledigt");
    assert.equal(reminders.length, 1);
  });

  it("Telegram hängt beim Entfernen der Knöpfe: ausgeführt wird sofort, nicht erst nach den Wiederholungen", async () => {
    const a = erinnerung();
    a.messageId = 99;
    let freigeben!: () => void;
    const haengt = new Promise<void>((r) => { freigeben = r; });
    globalThis.fetch = (async (eingabe, init) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      if (url.endsWith("/editMessageReplyMarkup")) await haengt;
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
    const antwort = await approveAuftrag(a);
    assert.match(antwort, new RegExp(`^✅ #${a.id} erledigt`));
    assert.equal(reminders.length, 1);
    // ein Notaus danach ändert nichts mehr, eine zweite Freigabe auch nicht
    state.paused = true;
    assert.equal(await approveAuftrag(a), `#${a.id} ist bereits erledigt.`);
    freigeben();
    for (let i = 0; i < 100 && !aufrufe.some((x) => x.method === "editMessageReplyMarkup"); i++) await new Promise((r) => setImmediate(r));
    assert.ok(aufrufe.some((x) => x.method === "editMessageReplyMarkup"));
    assert.equal(reminders.length, 1);
  });

  it("Startvermerk wird vor dem Werkzeug persistent gespeichert", async () => {
    const a = erinnerung();
    let vermerkVorher: string | undefined;
    const vorher = reminders.push;
    reminders.push = function (this: typeof reminders, ...e: (typeof reminders)[number][]) {
      const gespeichert = JSON.parse(readFileSync(join(temp, "data", "auftraege.json"), "utf8")) as { id: number; gestartetAm?: string }[];
      vermerkVorher = gespeichert.find((x) => x.id === a.id)?.gestartetAm;
      return vorher.apply(this, e);
    };
    try {
      assert.match(await approveAuftrag(a), new RegExp(`^✅ #${a.id} erledigt`));
    } finally {
      reminders.push = vorher;
    }
    assert.ok(vermerkVorher, "gestartetAm fehlte in data/auftraege.json, als das Werkzeug lief");
    assert.equal(getAuftrag(a.id)?.gestartetAm, vermerkVorher);
  });

  it("begonnen, aber nie abgeschlossen (Absturz): erneute Freigabe führt nicht nochmals aus", async () => {
    const a = erinnerung();
    a.gestartetAm = new Date().toISOString(); // Stand nach einem Absturz mitten in runAuftrag
    a.messageId = 5; // der Knopf stammt aus der zuletzt gesendeten Freigabe-Nachricht
    const unklar = `#${a.id} wurde bereits gestartet, Ergebnis unklar – bitte prüfen, Sir.`;
    assert.equal(await approveAuftrag(a), unklar);
    aufrufe = [];
    await handleUpdate({ update_id: 777001, callback_query: { id: "cb1", data: `ok:${a.id}`, from: { id: 12345 }, message: { message_id: 5 } } });
    assert.ok(aufrufe.some((x) => x.method === "sendMessage" && x.text === unklar));
    assert.equal(getAuftrag(a.id)?.status, "offen");
    assert.equal(reminders.length, 0);
  });

  it("Notaus vor der Freigabe: nichts läuft, der Auftrag bleibt offen", async () => {
    const a = erinnerung();
    state.paused = true;
    assert.equal(await approveAuftrag(a), "⛔ Notaus aktiv. Erst /weiter.");
    assert.equal(getAuftrag(a.id)?.status, "offen");
    assert.equal(reminders.length, 0);
    state.paused = false;
    await denyAuftrag(a);
  });
});

describe("pollFehlerMelden: eine HTTP-Antwort beweist das Internet", () => {
  it("nach einem Netzausfall beendet 409, 401 oder 502 die Internet-Störung (istOffline false)", () => {
    for (const status of [409, 401, 502]) {
      gesundheit._reset();
      pollFehlerMelden(netzfehler());
      assert.equal(gesundheit.istOffline(), true);
      pollFehlerMelden(new HttpFehler(`HTTP ${status} (getUpdates)`, status));
      assert.equal(gesundheit.zustand("internet")?.ok, true, `Status ${status}`);
      assert.equal(gesundheit.istOffline(), false, `Status ${status}`);
    }
  });
});

describe("Postausgang: Vorrang-Einträge überleben das Kürzen", () => {
  it("voller Postausgang: ein späteres gewöhnliches Ablegen verdrängt den Notfall-Alarm nicht", async () => {
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    for (let i = 0; i < 100; i++) await sendeSpaeter(`n${i}`);
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("🚨 Alarm", { vorrang: true });
    await sendeSpaeter("Watchdog");
    await sendeSpaeter("Erinnerung");
    const inhalt = liesPostausgang().map((e) => e.text);
    assert.equal(inhalt.length, 100);
    assert.equal(inhalt[0], "🚨 Alarm");
    assert.equal(inhalt[1], "n3");
    assert.deepEqual(inhalt.slice(-2), ["Watchdog", "Erinnerung"]);
    aufrufe = [];
    await postausgangTick();
    assert.match(aufrufe[0]?.text ?? "", /^\(nachgereicht, \d{2}:\d{2}\) 🚨 Alarm$/);
  });
});

describe("Offset: eingereihte Updates erst bestätigen, wenn ihre Verarbeitung beginnt", () => {
  const origHandle = abhaengigkeiten.handleMessage;
  const nachricht = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, text } });
  afterEach(() => { abhaengigkeiten.handleMessage = origHandle; });

  it("eine hängende (begonnene) Anfrage ist bestätigt, eine dahinter eingereihte nicht; Wiederholungen laufen nicht doppelt", async () => {
    let freigeben!: () => void;
    const haengt = new Promise<void>((r) => { freigeben = r; });
    const reihenfolge: string[] = [];
    abhaengigkeiten.handleMessage = async (text: string) => {
      reihenfolge.push(text);
      if (text === "erste") await haengt;
      return `Antwort auf ${text}`;
    };
    assert.equal(annehmen([nachricht(5001, "erste")]), 1);
    for (let i = 0; i < 100 && reihenfolge.length === 0; i++) await new Promise((r) => setImmediate(r));
    // begonnen → bestätigt und vermerkt: ein Neustart führt sie nicht ein zweites Mal aus
    assert.equal(naechsterOffset(), 5002);
    // Telegram liefert sie (noch unbestätigt) erneut, dazu eine neue
    assert.equal(annehmen([nachricht(5001, "erste"), nachricht(5002, "zweite")]), 1);
    assert.equal(annehmen([nachricht(5001, "erste"), nachricht(5002, "zweite")]), 0);
    assert.equal(naechsterOffset(), 5002); // eingereiht, nicht begonnen: ein Neustart verliert sie nicht
    freigeben();
    for (let i = 0; i < 200 && naechsterOffset() !== 5003; i++) await new Promise((r) => setImmediate(r));
    assert.equal(naechsterOffset(), 5003);
    assert.deepEqual(reihenfolge, ["erste", "zweite"]);
  });
});

describe("Nachprüfung Runde 2: Offset, Neustart, Notaus", () => {
  const origHandle = abhaengigkeiten.handleMessage;
  const nachricht = (id: number, text: string, chat = 12345) => ({ update_id: id, message: { message_id: id, chat: { id: chat }, text } });
  const gesendet = () => aufrufe.filter((x) => x.method === "sendMessage").map((x) => x.text ?? "");
  const origErr = console.error;
  const origWarn = console.warn;
  /** Mikro- und Makroaufgaben abarbeiten, bis die Bedingung gilt (keine echten Timer) */
  const bis = async (bedingung: () => boolean, runden = 20_000) => {
    for (let i = 0; i < runden && !bedingung(); i++) await new Promise((r) => setImmediate(r));
    assert.ok(bedingung(), "Bedingung nicht erreicht");
  };
  let neustarts = 0;
  /** Neustart: das Modul frisch laden (eigener Speicher; data/ bleibt) */
  const neustart = async () => (await import(`../src/telegram.js?neustart=${++neustarts}`)) as typeof import("../src/telegram.js");
  beforeEach(() => {
    console.error = () => undefined;
    console.warn = () => undefined;
  });
  afterEach(() => {
    abhaengigkeiten.handleMessage = origHandle;
    console.error = origErr;
    console.warn = origWarn;
    globalThis.fetch = fetchAttrappe;
    state.paused = false;
    state.notfall = { aktiv: false };
    reminders.splice(0, reminders.length);
  });

  it("Kopf hängt, 100 Nachrichten dahinter: ein danach getipptes /pause kommt trotzdem an", async () => {
    let freigeben!: () => void;
    const haengt = new Promise<void>((r) => { freigeben = r; });
    let anClaude = 0;
    abhaengigkeiten.handleMessage = async (text: string) => {
      anClaude++;
      if (text === "Kopf") await haengt;
      return "ok";
    };
    const alle = [nachricht(7001, "Kopf"), ...Array.from({ length: 100 }, (_, i) => nachricht(7002 + i, `n${i}`)), nachricht(7102, "/pause")];
    // Telegram-Attrappe: höchstens 100 unbestätigte Updates ab dem Offset; ein Offset bestätigt alles darunter endgültig
    let bestaetigtBis = 0;
    for (let runde = 0; runde < 5 && !state.paused; runde++) {
      bestaetigtBis = Math.max(bestaetigtBis, naechsterOffset());
      annehmen(alle.filter((u) => u.update_id >= bestaetigtBis).slice(0, 100));
      await bis(() => anClaude > 0);
    }
    assert.equal(state.paused, true);
    assert.equal(anClaude, 1); // der Kopf hängt noch
    freigeben();
    await bis(() => anClaude === 101);
    await bis(() => naechsterOffset() === 7103);
  });

  it("Fremde Updates laufen sofort: sie halten den Offset nicht und der Missbrauchs-Notfall greift, während der Kopf hängt", async () => {
    let freigeben!: () => void;
    const haengt = new Promise<void>((r) => { freigeben = r; });
    let gestartet = false;
    abhaengigkeiten.handleMessage = async () => { gestartet = true; await haengt; return "ok"; };
    annehmen([nachricht(7201, "Frage")]);
    await bis(() => gestartet);
    annehmen(Array.from({ length: 5 }, (_, i) => nachricht(7202 + i, "hallo", 666)));
    assert.equal(naechsterOffset(), 7207);
    await bis(() => state.notfall?.aktiv === true);
    assert.equal(state.paused, true);
    freigeben();
    // im Notfall nennt der Hinweis /entwarnung (/weiter lehnt dort ab)
    await bis(() => gesendet().includes("Notfall aktiv, Sir. Aufheben nur mit /entwarnung in Telegram."));
  });

  it("/notfall während eine lange Antwort in Teilen rausgeht: kein weiterer Teil, nichts im Postausgang", async () => {
    abhaengigkeiten.handleMessage = async () => "A".repeat(4000) + "B".repeat(4000) + "C";
    globalThis.fetch = (async (eingabe, init) => {
      const antwort = await fetchAttrappe(eingabe, init);
      // der Notfall trifft ein, während der erste Teil unterwegs ist
      if (aufrufe.at(-1)?.text?.startsWith("A")) state.notfall = { aktiv: true, seit: new Date().toISOString() };
      return antwort;
    }) as typeof fetch;
    await handleUpdate(nachricht(7301, "Liste bitte"));
    assert.deepEqual(gesendet(), ["A".repeat(4000)]);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("Neustart während einer Freigabe: der erneut gelieferte Callback führt den Auftrag nicht zweimal aus", async () => {
    const a = createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "Einmal" }, stufe: "extern", summary: "Erinnerung" });
    let freigeben!: () => void;
    const haengt = new Promise<void>((r) => { freigeben = r; });
    let begonnen = false;
    globalThis.fetch = (async (eingabe, init) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      if (url.endsWith("/answerCallbackQuery")) {
        begonnen = true;
        await haengt; // Verarbeitung läuft, da kommt der Neustart
      }
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
    const cb = { update_id: 8001, callback_query: { id: "cb8001", data: `ok:${a.id}`, from: { id: 12345 } } };
    assert.equal(annehmen([cb]), 1);
    await bis(() => begonnen);
    assert.ok(naechsterOffset() > 8001); // begonnen → beim nächsten getUpdates bestätigt
    const datei = join(temp, "data", "telegram-begonnen.json");
    assert.ok((JSON.parse(readFileSync(datei, "utf8")) as number[]).includes(8001));
    assert.equal(statSync(datei).mode & 0o777, 0o600);

    const neu = await neustart();
    assert.equal(neu.naechsterOffset(), 0);
    assert.equal(neu.annehmen([cb]), 0); // schon begonnen: nicht erneut
    assert.equal(neu.naechsterOffset(), 8002);

    freigeben();
    await bis(() => getAuftrag(a.id)?.status === "erledigt");
    await bis(() => gesendet().some((t) => t.startsWith(`✅ #${a.id} erledigt`)));
    assert.equal(reminders.length, 1);
  });

  it("PIN nach einem Neustart erneut geliefert (keine Freigabe wartet): gelöscht, nie an Claude", async () => {
    const neu = await neustart();
    let claudeGefragt = false;
    neu.abhaengigkeiten.handleMessage = async () => { claudeGefragt = true; return "ok"; };
    aufrufe = [];
    assert.equal(neu.annehmen([nachricht(8101, "4711")]), 1);
    await bis(() => gesendet().length > 0);
    assert.equal(claudeGefragt, false);
    assert.ok(aufrufe.some((x) => x.method === "deleteMessage"));
    assert.deepEqual(gesendet(), ["Das sieht aus wie eine PIN, Sir. Ich schicke es nicht weiter."]);
    // ebenso im laufenden Modul ohne wartende Freigabe
    let gefragt = false;
    abhaengigkeiten.handleMessage = async () => { gefragt = true; return "ok"; };
    await handleUpdate(nachricht(8102, "4711"));
    assert.equal(gefragt, false);
  });

  it("update_id nach einer Woche Ruhe neu und kleiner: wird angenommen, /weiter nach /pause gilt", async () => {
    assert.equal(annehmen([nachricht(9000, "/pause")]), 1);
    await bis(() => state.paused === true);
    assert.equal(annehmen([nachricht(17, "/weiter")]), 1);
    await bis(() => state.paused === false);
    assert.ok(gesendet().includes("▶️ Weiter geht's."));
    assert.equal(naechsterOffset(), 18);
  });

  it("Freigabe wartet auf die PIN, /pause, dann /weiter: Notaus aufgehoben, nichts gelöscht", async () => {
    const a = createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "PIN" }, stufe: "sensibel", summary: "sensibel" });
    await handleUpdate({ update_id: 9100, callback_query: { id: "cb", data: `ok:${a.id}`, from: { id: 12345 } } });
    aufrufe = [];
    await verteileUpdate(nachricht(9101, "/pause"));
    await verteileUpdate(nachricht(9102, "/weiter"));
    assert.equal(state.paused, false);
    assert.ok(!aufrufe.some((x) => x.method === "deleteMessage"));
    assert.ok(gesendet().includes("▶️ Weiter geht's."));
    assert.equal(getAuftrag(a.id)?.status, "offen");
  });

  it("Freigabe wartet auf die PIN, /notfall, dann /entwarnung: Notfall aufgehoben", async () => {
    const a = createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "PIN" }, stufe: "sensibel", summary: "sensibel" });
    await handleUpdate({ update_id: 9110, callback_query: { id: "cb", data: `ok:${a.id}`, from: { id: 12345 } } });
    aufrufe = [];
    await verteileUpdate(nachricht(9111, "/notfall"));
    assert.equal(state.notfall?.aktiv, true);
    await verteileUpdate(nachricht(9112, "/entwarnung"));
    assert.equal(state.notfall?.aktiv, false);
    assert.equal(state.paused, false);
    assert.ok(!aufrufe.some((x) => x.method === "deleteMessage"));
    assert.equal(getAuftrag(a.id)?.status, "offen");
  });

  it("zwei gescheiterte Vorrang-Meldungen: in Sendereihenfolge nachgereicht, beide vor gewöhnlichen", async () => {
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("alt");
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("A zuerst", { vorrang: true });
    antworten = [netzfehler(), netzfehler(), netzfehler(), netzfehler()];
    await sendeSpaeter("B danach", { vorrang: true });
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["A zuerst", "B danach", "alt"]);
    aufrufe = [];
    await postausgangTick();
    assert.deepEqual(gesendet().map((t) => t.replace(/^\(nachgereicht, \d{2}:\d{2}\) /, "")), ["A zuerst", "B danach", "alt"]);
  });
});

describe("Nachprüfung Runde 3: Notaus über den Neustart, Notfall während der Freigabe, Kosmetik ohne Warten", () => {
  const origHandle = abhaengigkeiten.handleMessage;
  const nachricht = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, text } });
  const gesendet = () => aufrufe.filter((x) => x.method === "sendMessage").map((x) => x.text ?? "");
  const origErr = console.error;
  const bis = async (bedingung: () => boolean, runden = 20_000) => {
    for (let i = 0; i < runden && !bedingung(); i++) await new Promise((r) => setImmediate(r));
    assert.ok(bedingung(), "Bedingung nicht erreicht");
  };
  let neustarts = 0;
  const neustart = async () => (await import(`../src/telegram.js?neustart-r3=${++neustarts}`)) as typeof import("../src/telegram.js");
  const erinnerung = () =>
    createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "Runde 3" }, stufe: "extern", summary: "Erinnerung" });
  const sendenKaputt = () => {
    globalThis.fetch = (async (eingabe, init) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      if (url.endsWith("/sendMessage")) {
        aufrufe.push({ method: "sendMessage", text: (JSON.parse(String(init?.body)) as { text?: string }).text });
        throw netzfehler();
      }
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
  };
  beforeEach(() => {
    console.error = () => undefined;
    state.paused = false;
    state.notfall = { aktiv: false };
    reminders.splice(0, reminders.length);
  });
  afterEach(() => {
    abhaengigkeiten.handleMessage = origHandle;
    console.error = origErr;
    globalThis.fetch = fetchAttrappe;
    state.paused = false;
    state.notfall = { aktiv: false };
    reminders.splice(0, reminders.length);
  });

  /** Anfrage hängt, dahinter `aufheben` (eingereiht) und `notaus` (vorgezogen, begonnen); dann Neustart mit erneuter Lieferung. */
  async function neustartNachNotaus(startId: number, aufheben: string, notaus: string): Promise<{ freigeben: () => void }> {
    let freigeben!: () => void;
    const haengt = new Promise<void>((r) => { freigeben = r; });
    let gestartet = false;
    abhaengigkeiten.handleMessage = async () => { gestartet = true; await haengt; return "fertig"; };
    annehmen([nachricht(startId, "Frage")]);
    await bis(() => gestartet);
    annehmen([nachricht(startId + 1, aufheben)]);
    annehmen([nachricht(startId + 2, notaus)]);
    await bis(() => state.paused === true);
    assert.equal(naechsterOffset(), startId + 1); // das eingereihte Aufheben hält den Offset
    const neu = await neustart();
    aufrufe = [];
    assert.equal(neu.annehmen([nachricht(startId + 1, aufheben), nachricht(startId + 2, notaus)]), 1);
    await bis(() => gesendet().length > 0);
    return { freigeben };
  }

  it("Neustart: ein vor /pause eingereihtes /weiter hebt den Notaus danach nicht auf", async () => {
    const { freigeben } = await neustartNachNotaus(9501, "/weiter", "/pause");
    assert.equal(state.paused, true);
    assert.deepEqual(gesendet(), ["/weiter kam vor dem Notaus an und gilt nicht, Sir. Bitte erneut senden."]);
    freigeben();
    // auch im alten Modul (Kette läuft noch) gilt es nicht
    await bis(() => gesendet().filter((t) => t.startsWith("/weiter kam vor dem Notaus")).length === 2);
    assert.equal(state.paused, true);
    assert.ok(!gesendet().includes("▶️ Weiter geht's."));
  });

  it("Neustart: ein vor /notfall eingereihtes /entwarnung hebt den Notfall danach nicht auf", async () => {
    const { freigeben } = await neustartNachNotaus(9511, "/entwarnung", "/notfall");
    assert.equal(state.notfall?.aktiv, true);
    assert.equal(state.paused, true);
    assert.deepEqual(gesendet(), ["/entwarnung kam vor dem Notaus an und gilt nicht, Sir. Bitte erneut senden."]);
    freigeben();
    await bis(() => gesendet().filter((t) => t.startsWith("/entwarnung kam vor dem Notaus")).length === 2);
    assert.equal(state.notfall?.aktiv, true);
  });

  it("Neustart: ein nach dem begonnenen /pause getipptes /weiter gilt weiterhin", async () => {
    const pause = nachricht(9521, "/pause");
    annehmen([pause]);
    await bis(() => state.paused === true);
    const neu = await neustart();
    aufrufe = [];
    assert.equal(neu.annehmen([pause, nachricht(9522, "/weiter")]), 1);
    await bis(() => state.paused === false);
    assert.deepEqual(gesendet(), ["▶️ Weiter geht's."]);
  });

  /** Löst den Notfall aus, während das Werkzeug (Erinnerung setzen) läuft. */
  async function mitNotfallImWerkzeug<T>(lauf: () => Promise<T>): Promise<T> {
    const { ausloesen } = await import("../src/notfall.js");
    const vorher = reminders.push;
    reminders.push = function (this: typeof reminders, ...e: (typeof reminders)[number][]) {
      void ausloesen("Test während der Freigabe");
      return vorher.apply(this, e);
    };
    try {
      return await lauf();
    } finally {
      reminders.push = vorher;
    }
  }

  it("Dashboard: Notfall während das Werkzeug läuft → Ergebnis weder in Telegram noch im Postausgang noch in der Antwort", async () => {
    const a = erinnerung();
    const antwort = await mitNotfallImWerkzeug(() => approveAuftrag(a));
    const ergebnis = getAuftrag(a.id)?.result ?? "";
    assert.equal(getAuftrag(a.id)?.status, "erledigt"); // gelaufen: nicht nochmals freigeben
    assert.match(ergebnis, /^Erinnerung gesetzt/);
    assert.equal(antwort, `⏸ #${a.id} lief noch zu Ende; Ergebnis wegen Notfall zurückgehalten, Sir.`);
    await bis(() => gesendet().includes(antwort));
    assert.ok(gesendet().some((t) => t.startsWith("🚨 NOTFALL")));
    assert.ok(!gesendet().some((t) => t.includes(ergebnis)));
    assert.ok(!liesPostausgang().some((e) => e.text.includes(ergebnis)));
  });

  it("Telegram-Knopf: Notfall während das Werkzeug läuft → nur die neutrale Meldung", async () => {
    const a = erinnerung();
    await mitNotfallImWerkzeug(() => handleUpdate({ update_id: 9531, callback_query: { id: "cb9531", data: `ok:${a.id}`, from: { id: 12345 } } }));
    const ergebnis = getAuftrag(a.id)?.result ?? "";
    assert.equal(getAuftrag(a.id)?.status, "erledigt");
    assert.ok(gesendet().includes(`⏸ #${a.id} lief noch zu Ende; Ergebnis wegen Notfall zurückgehalten, Sir.`));
    assert.ok(!gesendet().some((t) => t.includes(ergebnis)));
    assert.ok(!liesPostausgang().some((e) => e.text.includes(ergebnis)));
  });

  it("Notfall während der Sendewiederholungen der Ergebnis-Meldung: kein weiterer Versuch, nichts im Postausgang", async () => {
    sendenKaputt();
    setzeWarten(async () => {
      state.paused = true;
      state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    }, () => 0.5);
    const a = erinnerung();
    await approveAuftrag(a);
    const ergebnis = getAuftrag(a.id)?.result ?? "";
    assert.equal(getAuftrag(a.id)?.status, "erledigt");
    assert.equal(gesendet().length, 1); // nur der erste Versuch, danach keine Wiederholung mehr
    assert.ok(!liesPostausgang().some((e) => e.text.includes(ergebnis)));
  });

  it("sendeSpaeter mit imNotfallZurueckhalten: im Notfall weder gesendet noch abgelegt; der Alarm (ohne Option) geht", async () => {
    state.paused = true;
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    await sendeSpaeter("Daten", { vorrang: true, imNotfallZurueckhalten: true });
    await sendeSpaeter("Daten hinten", { imNotfallZurueckhalten: true });
    assert.deepEqual(gesendet(), []);
    assert.deepEqual(liesPostausgang(), []);
    await sendeSpaeter("🚨 Alarm", { vorrang: true });
    assert.deepEqual(gesendet(), ["🚨 Alarm"]);
  });

  it("Notaus während der Sendewiederholungen einer Antwort: der Rest landet nicht im Postausgang", async () => {
    abhaengigkeiten.handleMessage = async () => "Ihre Rechnungen: geheim.";
    sendenKaputt();
    setzeWarten(async () => { state.paused = true; }, () => 0.5);
    await handleUpdate(nachricht(9541, "Rechnungen?"));
    assert.equal(gesendet().length, 1);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("Claude-Fehler nach /pause: der Pausenhinweis statt «dreimal versucht»", async () => {
    abhaengigkeiten.handleMessage = async () => {
      state.paused = true; // /pause kam während der Anfrage; claudeAufruf bricht ab und wirft den echten Fehler
      throw netzfehler();
    };
    await handleUpdate(nachricht(9551, "Hallo"));
    assert.deepEqual(gesendet(), ["Ich bin pausiert (Notaus). In Telegram hebt /weiter das wieder auf."]);
  });

  it("Claude-Fehler nach /notfall: der Hinweis nennt /entwarnung", async () => {
    abhaengigkeiten.handleMessage = async () => {
      state.paused = true;
      state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
      throw netzfehler();
    };
    await handleUpdate(nachricht(9552, "Hallo"));
    assert.deepEqual(gesendet(), ["Notfall aktiv, Sir. Aufheben nur mit /entwarnung in Telegram."]);
  });

  it("Telegram-Knopf: das Werkzeug läuft, bevor answerCallbackQuery und editMessageReplyMarkup fertig sind", async () => {
    let freigeben!: () => void;
    const haengt = new Promise<void>((r) => { freigeben = r; });
    let haengend = 0;
    globalThis.fetch = (async (eingabe, init) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      if (url.endsWith("/answerCallbackQuery") || url.endsWith("/editMessageReplyMarkup")) {
        haengend++;
        await haengt;
      }
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
    const a = erinnerung();
    a.messageId = 5; // der Knopf stammt aus der zuletzt gesendeten Freigabe-Nachricht
    await handleUpdate({ update_id: 9561, callback_query: { id: "cb9561", data: `ok:${a.id}`, from: { id: 12345 }, message: { message_id: 5 } } });
    assert.equal(haengend, 2); // beide hängen noch
    assert.equal(getAuftrag(a.id)?.status, "erledigt");
    assert.equal(reminders.length, 1);
    assert.ok(gesendet().some((t) => t.startsWith(`✅ #${a.id} erledigt:`)));
    freigeben();
    await bis(() => aufrufe.some((x) => x.method === "editMessageReplyMarkup"));
  });

  it("Dashboard-Freigabe antwortet, während die Ergebnis-Meldung an Telegram noch hängt", async () => {
    let freigeben!: () => void;
    const haengt = new Promise<void>((r) => { freigeben = r; });
    globalThis.fetch = (async (eingabe, init) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      if (url.endsWith("/sendMessage")) await haengt;
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
    setzeWarten(async (ms) => { gewartet.push(ms); }, () => 0.5, async () => undefined); // Frist läuft sofort ab
    const a = erinnerung();
    const antwort = await approveAuftrag(a);
    assert.match(antwort, new RegExp(`^✅ #${a.id} erledigt: Erinnerung gesetzt`));
    assert.equal(gesendet().length, 0); // die Meldung ist noch unterwegs
    freigeben();
    await bis(() => gesendet().some((t) => t.startsWith(`✅ #${a.id} erledigt:`)));
  });
});

describe("/verdichten bei Telegram-Störung: kein Absturz, der Bericht geht nicht verloren", () => {
  const origVerdichte = abhaengigkeiten.verdichteJetzt;
  const origErr = console.error;
  const nachricht = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, text } });
  let unbehandelt: unknown[] = [];
  const merke = (e: unknown) => { unbehandelt.push(e); };
  /** Mikro- und Makroaufgaben abarbeiten: eine verworfene Rejection käme hier als unhandledRejection an */
  const ruhe = async () => { for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r)); };
  /** sendMessage scheitert ab jetzt dauerhaft mit Netzfehler (Telegram fällt während des Modellaufrufs aus) */
  const sendenKaputt = () => {
    globalThis.fetch = (async (eingabe, init) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      if (url.endsWith("/sendMessage")) {
        aufrufe.push({ method: "sendMessage", text: (JSON.parse(String(init?.body)) as { text?: string }).text });
        throw netzfehler();
      }
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
  };
  const bericht = { faktenZusammengefuehrt: 3, faktenVeraltet: 2, notizenVorher: 41, notizenNachher: 12, entscheidungenChronik: 7, chronikMonate: ["2026-07"] };
  beforeEach(() => {
    unbehandelt = [];
    state.paused = false;
    console.error = () => undefined;
    process.on("unhandledRejection", merke);
  });
  afterEach(() => {
    process.off("unhandledRejection", merke);
    abhaengigkeiten.verdichteJetzt = origVerdichte;
    console.error = origErr;
    globalThis.fetch = fetchAttrappe;
    state.paused = false;
  });

  it("Bericht nach erfolgreicher Verdichtung: landet im Postausgang, keine unbehandelte Rejection", async () => {
    abhaengigkeiten.verdichteJetzt = async () => {
      sendenKaputt();
      return { bericht };
    };
    await handleUpdate(nachricht(9601, "/verdichten"));
    await ruhe();
    assert.deepEqual(unbehandelt, []);
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["🧠 Verdichtung: 3 Fakten zusammengeführt, 2 als veraltet markiert, Notizen 41 → 12 Zeilen, 7 Entscheidungen (Juli) in die Chronik."]);
    // kommt Telegram zurück, wird der Bericht nachgereicht
    globalThis.fetch = fetchAttrappe;
    aufrufe = [];
    await postausgangTick();
    assert.match(aufrufe[0]?.text ?? "", /^\(nachgereicht, \d{2}:\d{2}\) 🧠 Verdichtung: 3 Fakten/);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("Vorschau, abgelehnter Vorschlag, nichts zu tun und Ausnahme: Sendefehler werden abgefangen", async () => {
    const eingabe = { fakten: [], notizen: [], entscheidungenAlt: [], muster: [], heute: "2026-10-11", tage: 90 };
    const vorschau = { fakten: { zusammenfuehren: [], veraltet: [] }, notizen: { behalten: [], verdichtet: [] }, chronik: [] };
    const faelle: [string, () => Promise<Awaited<ReturnType<typeof abhaengigkeiten.verdichteJetzt>>>][] = [
      ["/verdichten vorschau", async () => ({ vorschau, eingabe })],
      ["/verdichten", async () => ({ fehler: "Vorschlag abgelehnt: y. Nichts geändert." })],
      ["/verdichten", async () => ({})],
      ["/verdichten", async () => { throw new Error("EACCES: permission denied, open 'data/profil.json'"); }],
    ];
    let id = 9610;
    for (const [befehl, ergebnis] of faelle) {
      globalThis.fetch = fetchAttrappe;
      abhaengigkeiten.verdichteJetzt = async () => {
        sendenKaputt();
        return ergebnis();
      };
      aufrufe = [];
      await handleUpdate(nachricht(++id, befehl));
      await ruhe();
      assert.deepEqual(unbehandelt, [], befehl);
      assert.equal(aufrufe.filter((a) => a.method === "sendMessage").length, 5, befehl); // Ansage + vier Versuche der Antwort
    }
    // Antworten ohne bleibenden Wert (Vorschau, Fehlertexte) gehen nicht in den Postausgang
    assert.deepEqual(liesPostausgang(), []);
  });
});

describe("Gesamtprüfung Runde 1: Notfall gibt nichts heraus, PIN, Sprachnachricht, Absturzschutz", () => {
  const nachricht = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, text } });
  const knopf = (data: string) => ({ update_id: 1, callback_query: { id: "cb", data, from: { id: 12345 } } });
  const sprachnachricht = (id: number) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, voice: { file_id: "datei", duration: 3 } } });
  const gesendet = () => aufrufe.filter((x) => x.method === "sendMessage").map((x) => x.text ?? "");
  const origHandle = abhaengigkeiten.handleMessage;
  const origErr = console.error;
  const origStt = config.stt;
  const notfallAn = () => {
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    state.paused = true;
  };
  const sensibel = () => createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "PIN-Test" }, stufe: "sensibel", summary: "sensibel" });
  /** sendMessage scheitert dauerhaft mit Netzfehler */
  const sendenKaputt = () => {
    globalThis.fetch = (async (eingabe, init) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      if (url.endsWith("/sendMessage")) {
        aufrufe.push({ method: "sendMessage", text: (JSON.parse(String(init?.body)) as { text?: string }).text });
        throw netzfehler();
      }
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
  };
  beforeEach(() => {
    console.error = () => undefined;
    state.paused = false;
    state.notfall = { aktiv: false };
    reminders.splice(0, reminders.length);
  });
  afterEach(async () => {
    abhaengigkeiten.handleMessage = origHandle;
    console.error = origErr;
    globalThis.fetch = fetchAttrappe;
    config.stt = origStt;
    state.paused = false;
    state.notfall = { aktiv: false };
    reminders.splice(0, reminders.length);
    await leeren();
  });

  it("Notfall während der Sendewiederholungen einer gewöhnlichen Meldung: der Rest wartet bis /entwarnung, nur der Alarm geht nach", async () => {
    const { ausloesen, aufheben } = await import("../src/notfall.js");
    sendenKaputt();
    let ausgeloest = false;
    setzeWarten(async () => {
      if (ausgeloest) return;
      ausgeloest = true;
      await ausloesen("Panik während des Versands");
    }, () => 0.5);
    await sendeSpaeter("🕒 Mails: Kündigung von chef@firma.ch");
    assert.equal(ausgeloest, true);
    const wartend = liesPostausgang();
    assert.equal(wartend.length, 2);
    assert.match(wartend[0].text, /^🚨 NOTFALL ausgelöst/);
    assert.equal(wartend[1].text, "🕒 Mails: Kündigung von chef@firma.ch");
    assert.ok(wartend[1].ts <= (state.notfall?.seit ?? ""), "Zeitstempel = Fälligkeit vor der Auslösung, nicht das Scheitern danach");

    globalThis.fetch = fetchAttrappe;
    aufrufe = [];
    await postausgangTick();
    assert.equal(gesendet().length, 1);
    assert.match(gesendet()[0], /^\(nachgereicht, \d{2}:\d{2}\) 🚨 NOTFALL ausgelöst/);
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["🕒 Mails: Kündigung von chef@firma.ch"], "die Meldung wartet");

    aufheben();
    aufrufe = [];
    await postausgangTick();
    assert.match(gesendet()[0] ?? "", /Kündigung von chef@firma\.ch$/);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("im Notfall fällige gewöhnliche Meldung: weder gesendet noch nachgereicht, auch nicht mit Zeitstempel nach der Auslösung", async () => {
    notfallAn();
    await sendeSpaeter("⚠️ Zeitplan-Ergebnis mit Daten");
    assert.deepEqual(gesendet(), []);
    await postausgangTick();
    assert.deepEqual(gesendet(), []);
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["⚠️ Zeitplan-Ergebnis mit Daten"]);
  });

  it("langer Text, Notfall nach dem ersten Teil: kein weiterer Teil, der Rest wartet bis /entwarnung", async () => {
    let teile = 0;
    globalThis.fetch = (async (eingabe, init) => {
      const r = await fetchAttrappe(eingabe, init);
      if (String(eingabe).endsWith("/sendMessage") && ++teile === 1) notfallAn();
      return r;
    }) as typeof fetch;
    await sendeSpaeter("a".repeat(4000) + "b".repeat(100));
    assert.equal(teile, 1);
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["b".repeat(100)]);
  });

  it("Erinnerung im Notfall: nichts geht hinaus, nichts wird gelöscht; nach /entwarnung kommt sie", async () => {
    const { aufheben } = await import("../src/notfall.js");
    reminders.push({ at: new Date(Date.now() - 1000).toISOString(), text: "Arzttermin, privat" });
    notfallAn();
    await remindersTick();
    assert.deepEqual(gesendet(), []);
    assert.equal(reminders.length, 1);
    assert.equal(existsSync(POSTAUSGANG) ? liesPostausgang().length : 0, 0);
    aufheben();
    await remindersTick();
    assert.deepEqual(gesendet(), ["⏰ Arzttermin, privat"]);
    assert.equal(reminders.length, 0);
  });

  it("/auftraege, /vorgaenge und /status im Notfall: nur Anzahl und Nummern, keine Inhalte, keine Knöpfe", async () => {
    const a = createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "Mail an chef@firma.ch | Betreff: Kündigung | Vertraulicher Text" });
    notfallAn();
    aufrufe = [];
    await handleUpdate(nachricht(9701, "/auftraege"));
    await handleUpdate(nachricht(9702, "/vorgaenge"));
    await handleUpdate(nachricht(9703, "/status"));
    const texte = gesendet();
    assert.equal(texte.length, 3);
    assert.match(texte[0], new RegExp(`^🚨 Notfall aktiv\\. Offene Aufträge: \\d+ \\(.*#${a.id}.*\\)`));
    assert.equal(texte[1], "Im Notfall gebe ich keine Daten heraus, Sir. Erst /entwarnung.");
    assert.match(texte[2], /^🚨 NOTFALL AKTIV/);
    for (const t of texte) assert.doesNotMatch(t, /chef@firma|Kündigung|Vertraulich|Werkzeuge:/);
    assert.equal(getAuftrag(a.id)?.status, "offen");
  });

  it("Clip-Knopf im Notfall: kein Abruf bei Frigate, kein Video", async () => {
    notfallAn();
    const fremd: string[] = [];
    globalThis.fetch = (async (eingabe, init) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      if (!url.startsWith("https://api.telegram.org/bot")) fremd.push(url);
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
    aufrufe = [];
    await handleUpdate(knopf("clip:ev123"));
    assert.deepEqual(fremd, []);
    assert.ok(!aufrufe.some((x) => x.method === "sendVideo"));
    assert.deepEqual(gesendet(), ["Im Notfall gebe ich keine Aufnahmen heraus, Sir. Erst /entwarnung."]);
  });

  it("Dashboard: falsche PIN lehnt den Auftrag ab, Durchprobieren geht nicht", async () => {
    const a = sensibel();
    assert.equal(await approveAuftrag(a, "0000"), `Falsche PIN. #${a.id} abgelehnt.`);
    assert.equal(getAuftrag(a.id)?.status, "abgelehnt");
    assert.equal(await approveAuftrag(a, "4711"), `#${a.id} ist bereits abgelehnt.`);
    assert.equal(reminders.length, 0, "nichts ausgeführt");
    // die richtige PIN beim ersten Versuch führt weiterhin aus
    const b = sensibel();
    assert.match(await approveAuftrag(b, "4711"), new RegExp(`^✅ #${b.id} erledigt`));
  });

  it("Sprachnachricht, während eine PIN erwartet wird: kein STT, kein Echo, die Freigabe verfällt", async () => {
    config.stt = { url: "http://stt.test/v1/audio/transcriptions", key: "", model: "whisper-1" };
    const a = sensibel();
    await handleUpdate(knopf(`ok:${a.id}`));
    aufrufe = [];
    let claude = 0;
    abhaengigkeiten.handleMessage = async () => { claude++; return "nein"; };
    await handleUpdate(sprachnachricht(9711));
    assert.ok(!aufrufe.some((x) => x.method === "getFile"), "die Sprachnachricht geht nicht zum STT-Anbieter");
    assert.ok(aufrufe.some((x) => x.method === "deleteMessage"));
    assert.equal(gesendet().length, 1);
    assert.match(gesendet()[0], /^Die PIN bitte tippen, Sir/);
    assert.ok(!gesendet().some((t) => t.startsWith("🎙")));
    assert.equal(getAuftrag(a.id)?.status, "offen");
    assert.equal(reminders.length, 0);
    assert.equal(claude, 0);
  });

  it("gesprochene PIN ohne wartende Freigabe: kein Echo, gelöscht, nie an Claude", async () => {
    config.stt = { url: "http://stt.test/v1/audio/transcriptions", key: "", model: "whisper-1" };
    globalThis.fetch = (async (eingabe, init) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      if (url.startsWith("http://stt.test/")) return new Response(JSON.stringify({ text: " 4711 " }), { headers: { "content-type": "application/json" } });
      if (url.startsWith("https://api.telegram.org/file/")) return new Response(new Uint8Array([1, 2, 3]));
      if (url.endsWith("/getFile")) {
        aufrufe.push({ method: "getFile" });
        return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/a.oga" } }), { headers: { "content-type": "application/json" } });
      }
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
    let claude = 0;
    abhaengigkeiten.handleMessage = async () => { claude++; return "nein"; };
    aufrufe = [];
    await handleUpdate(sprachnachricht(9712));
    assert.ok(aufrufe.some((x) => x.method === "getFile"));
    assert.ok(aufrufe.some((x) => x.method === "deleteMessage"));
    assert.ok(!gesendet().some((t) => t.includes("4711")), "die PIN steht nicht im Chat");
    assert.deepEqual(gesendet(), ["Das sieht aus wie eine PIN, Sir. Ich schicke es nicht weiter."]);
    assert.equal(claude, 0);
  });

  it("/protokoll der Stufe auto im Notaus und im Notfall: kein Werkzeug läuft", async () => {
    protokolle["testauto"] = { beschreibung: "Test", stufe: "auto", schritte: [{ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "Protokoll" } }] };
    try {
      state.paused = true;
      aufrufe = [];
      await handleUpdate(nachricht(9721, "/protokoll testauto"));
      assert.deepEqual(gesendet(), ["⛔ Notaus aktiv. Erst /weiter."]);
      notfallAn();
      aufrufe = [];
      await handleUpdate(nachricht(9722, "/protokoll testauto"));
      assert.deepEqual(gesendet(), ["🚨 Notfall aktiv, Sir. Erst /entwarnung."]);
      assert.equal(reminders.length, 0);
    } finally {
      delete protokolle["testauto"];
    }
  });

  it("/protokoll der Stufe extern im Notfall: kein Auftrag, nur die Ablehnung", async () => {
    protokolle["testextern"] = { beschreibung: "Test", stufe: "extern", schritte: [{ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "Protokoll" } }] };
    try {
      const zaehler = createAuftrag({ tool: "erinnerung", input: {}, stufe: "extern", summary: "Zähler" });
      zaehler.status = "abgelehnt";
      const naechste = zaehler.id + 1;
      notfallAn();
      aufrufe = [];
      await handleUpdate(nachricht(9725, "/protokoll testextern"));
      assert.deepEqual(gesendet(), ["🚨 Notfall aktiv, Sir. Erst /entwarnung."]);
      assert.equal(getAuftrag(naechste), undefined, "im Notfall wird kein Auftrag angelegt");
      assert.equal(reminders.length, 0);
    } finally {
      delete protokolle["testextern"];
    }
  });

  it("Notaus-Hinweise im Notfall nennen /entwarnung, nicht /weiter (Knopf, Dashboard, /verdichten)", async () => {
    const a = createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "x" }, stufe: "extern", summary: "x" });
    notfallAn();
    aufrufe = [];
    await handleUpdate(knopf(`ok:${a.id}`));
    await handleUpdate(nachricht(9731, "/verdichten"));
    const dashboard = await approveAuftrag(a);
    for (const t of [...gesendet(), dashboard]) assert.equal(t, "🚨 Notfall aktiv, Sir. Erst /entwarnung.");
    assert.equal(gesendet().length, 2);
    // ohne Notfall bleibt der Hinweis auf /weiter
    state.notfall = { aktiv: false };
    aufrufe = [];
    await handleUpdate(knopf(`ok:${a.id}`));
    assert.deepEqual(gesendet(), ["⛔ Notaus aktiv. Erst /weiter, dann nochmal freigeben."]);
  });

  it("Telegram-Störung bei einer Befehlsantwort: keine unbehandelte Rejection, der Fehler landet in der Kette", async () => {
    const unbehandelt: unknown[] = [];
    const merke = (e: unknown) => { unbehandelt.push(e); };
    process.on("unhandledRejection", merke);
    try {
      sendenKaputt();
      await verteileUpdate(nachricht(9741, "/status"));
      await verteileUpdate(nachricht(9742, "/gibtsnicht"));
      await handleUpdate(knopf("ok:999999")).then(
        () => assert.fail("der Sendefehler muss beim Aufrufer ankommen"),
        (e: unknown) => assert.match(String(e), /fetch failed/),
      );
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      assert.deepEqual(unbehandelt, []);
      assert.equal(gesendet().length, 12); // je vier Versuche
    } finally {
      process.off("unhandledRejection", merke);
    }
  });
});

describe("Gesamtprüfung Runde 2: /check, PIN-Durchprobieren, Notfall während Modellaufruf und Download", () => {
  const nachricht = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, text } });
  const knopf = (data: string) => ({ update_id: 1, callback_query: { id: "cb", data, from: { id: 12345 } } });
  const gesendet = () => aufrufe.filter((x) => x.method === "sendMessage").map((x) => x.text ?? "");
  const origHandle = abhaengigkeiten.handleMessage;
  const origVerdichte = abhaengigkeiten.verdichteJetzt;
  const origErr = console.error;
  const origFrigate = config.frigateUrl;
  const notfallAn = () => {
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    state.paused = true;
  };
  /** Zeichnet Aufrufe ausserhalb von Telegram auf (Dienste, Frigate); `vorher` darf eingreifen */
  const fremdAufzeichnen = (vorher?: (url: string) => Promise<Response | undefined>) => {
    const fremd: string[] = [];
    globalThis.fetch = (async (eingabe, init) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      if (!url.startsWith("https://api.telegram.org/bot")) {
        fremd.push(url);
        const r = await vorher?.(url);
        if (r) return r;
        throw new Error(`unerwarteter Aufruf: ${url}`);
      }
      return fetchAttrappe(eingabe, init);
    }) as typeof fetch;
    return fremd;
  };
  beforeEach(() => {
    console.error = () => undefined;
    state.paused = false;
    state.notfall = { aktiv: false };
    reminders.splice(0, reminders.length);
  });
  afterEach(async () => {
    abhaengigkeiten.handleMessage = origHandle;
    abhaengigkeiten.verdichteJetzt = origVerdichte;
    console.error = origErr;
    globalThis.fetch = fetchAttrappe;
    config.frigateUrl = origFrigate;
    state.paused = false;
    state.notfall = { aktiv: false };
    reminders.splice(0, reminders.length);
    await leeren();
  });

  it("/check im Notfall: kein Selbsttest, kein Aufruf an Dienste, nur der Sperrtext", async () => {
    notfallAn();
    const fremd = fremdAufzeichnen();
    aufrufe = [];
    await handleUpdate(nachricht(9801, "/check"));
    assert.deepEqual(fremd, []);
    assert.deepEqual(gesendet(), ["Im Notfall gebe ich keine Daten heraus, Sir. Erst /entwarnung."]);
  });

  it("falsche PIN über Telegram zählt als Missbrauch: spätestens die fünfte löst den Notfall aus", async () => {
    abhaengigkeiten.handleMessage = async () => { assert.fail("die PIN-Eingabe geht nie an Claude"); };
    let versuche = 0;
    while (!state.notfall?.aktiv && versuche < 5) {
      versuche++;
      const a = createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "PIN" }, stufe: "sensibel", summary: "sensibel" });
      await handleUpdate(knopf(`ok:${a.id}`));
      aufrufe = [];
      await handleUpdate(nachricht(9810 + versuche, "0000"));
      assert.equal(getAuftrag(a.id)?.status, "abgelehnt");
      assert.ok(gesendet().includes(`Falsche PIN. #${a.id} abgelehnt.`));
    }
    assert.equal(state.notfall?.aktiv, true, "fünf falsche PINs in fünf Minuten lösen den Notfall aus");
    assert.equal(state.paused, true);
    assert.equal(reminders.length, 0, "nichts ausgeführt");
  });

  it("/verdichten vorschau, Notfall während des Modellaufrufs: keine Profil-Fakten im Chat", async () => {
    const { ausloesen } = await import("../src/notfall.js");
    const eingabe = {
      fakten: [{ id: 3, text: "Garagencode 4711", seit: "2026-09-01", quelle: "chat" as const }, { id: 4, text: "Garagencode ist 4711, Tresor 9988", seit: "2026-09-02", quelle: "chat" as const }],
      notizen: [], entscheidungenAlt: [], muster: [], heute: "2026-10-11", tage: 90,
    };
    const vorschau = { fakten: { zusammenfuehren: [{ ids: [3, 4], text: "Garagencode 4711, Tresor 9988" }], veraltet: [] }, notizen: { behalten: [], verdichtet: [] }, chronik: [] };
    abhaengigkeiten.verdichteJetzt = async () => {
      await ausloesen("Panik während der Verdichtung");
      return { vorschau, eingabe };
    };
    aufrufe = [];
    await handleUpdate(nachricht(9821, "/verdichten vorschau"));
    const texte = gesendet();
    for (const t of texte) assert.doesNotMatch(t, /Garagencode|Tresor|4711|9988|Vorschau/);
    assert.ok(texte.some((t) => /^🚨 NOTFALL ausgelöst/.test(t)));
    assert.equal(texte.at(-1), "Notfall aktiv, Sir. Aufheben nur mit /entwarnung in Telegram.");
  });

  it("/verdichten vorschau ohne Notfall: die Vorschau kommt weiterhin", async () => {
    const eingabe = { fakten: [{ id: 1, text: "Wohnt in Basel", seit: "2026-09-01", quelle: "chat" as const }], notizen: [], entscheidungenAlt: [], muster: [], heute: "2026-10-11", tage: 90 };
    const vorschau = { fakten: { zusammenfuehren: [], veraltet: [{ id: 1, grund: "umgezogen" }] }, notizen: { behalten: [], verdichtet: [] }, chronik: [] };
    abhaengigkeiten.verdichteJetzt = async () => ({ vorschau, eingabe });
    aufrufe = [];
    await handleUpdate(nachricht(9822, "/verdichten vorschau"));
    assert.ok(gesendet().some((t) => t.includes("Wohnt in Basel")));
  });

  it("Clip-Knopf: Notfall während des Downloads bei Frigate → kein Video, nur die Ablehnung", async () => {
    const { ausloesen } = await import("../src/notfall.js");
    config.frigateUrl = "http://frigate.test";
    const fremd = fremdAufzeichnen(async (url) => {
      if (!url.startsWith("http://frigate.test/")) return undefined;
      await ausloesen("Panik während des Clip-Downloads");
      return new Response(new Uint8Array([0, 0, 0, 24]));
    });
    aufrufe = [];
    await handleUpdate(knopf("clip:ev77"));
    assert.deepEqual(fremd, ["http://frigate.test/api/events/ev77/clip.mp4"]);
    assert.ok(!aufrufe.some((x) => x.method === "sendVideo"));
    assert.equal(gesendet().at(-1), "Im Notfall gebe ich keine Aufnahmen heraus, Sir. Erst /entwarnung.");
  });

  it("Werkzeug-Hüllen (kamera_clip, kamera_schauen, datei_senden): im Notfall kein Upload an Telegram", async () => {
    const { hooks } = await import("../src/telegram.js");
    notfallAn();
    aufrufe = [];
    await assert.rejects(hooks.sendVideo(Buffer.from([1, 2, 3]), "🎬 ev1"), /Notfall aktiv, nichts gesendet/);
    await assert.rejects(hooks.sendPhoto(Buffer.from([1, 2, 3]), "📷 Garten"), /Notfall aktiv, nichts gesendet/);
    await assert.rejects(hooks.sendFile("bericht.txt", "Bericht"), /Notfall aktiv, nichts gesendet/);
    assert.deepEqual(aufrufe, []);
  });

  it("Werkzeug kamera_clip: Notfall während des Frigate-Abrufs → kein sendVideo", async () => {
    const { ausloesen } = await import("../src/notfall.js");
    const { hooks } = await import("../src/telegram.js");
    const { eventClip } = await import("../src/cameras.js");
    config.frigateUrl = "http://frigate.test";
    fremdAufzeichnen(async (url) => {
      if (!url.startsWith("http://frigate.test/")) return undefined;
      await ausloesen("Panik während kamera_clip");
      return new Response(new Uint8Array([0, 0, 0, 24]));
    });
    aufrufe = [];
    // wie tools.ts kamera_clip: ctx.sendVideo(await eventClip(id), …)
    await assert.rejects(async () => hooks.sendVideo(await eventClip("ev88"), "🎬 ev88"), /Notfall aktiv/);
    assert.ok(!aufrufe.some((x) => x.method === "sendVideo"));
  });
});

describe("Gesamtprüfung Runde 3: nur echte PIN-Versuche zählen, /vorgang im Notaus", () => {
  const nachricht = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, text } });
  const knopf = (data: string) => ({ update_id: 1, callback_query: { id: "cb", data, from: { id: 12345 } } });
  const gesendet = () => aufrufe.filter((x) => x.method === "sendMessage").map((x) => x.text ?? "");
  const sensibel = () => createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "PIN" }, stufe: "sensibel", summary: "sensibel" });
  const AUDIT = join(temp, "data", "audit.log");
  const missbrauchsSignale = () => (existsSync(AUDIT) ? readFileSync(AUDIT, "utf8").split("\n").filter((z) => z.includes('"event":"abuse_signal"')).length : 0);
  const VORGAENGE = join(temp, "data", "vorgaenge.json");
  const vorgangsAnzahl = () => (existsSync(VORGAENGE) ? (JSON.parse(readFileSync(VORGAENGE, "utf8")) as unknown[]).length : 0);
  const origHandle = abhaengigkeiten.handleMessage;
  const origErr = console.error;
  beforeEach(() => {
    console.error = () => undefined;
    state.paused = false;
    state.notfall = { aktiv: false };
    reminders.splice(0, reminders.length);
  });
  afterEach(async () => {
    abhaengigkeiten.handleMessage = origHandle;
    console.error = origErr;
    state.paused = false;
    state.notfall = { aktiv: false };
    reminders.splice(0, reminders.length);
    await leeren();
  });

  it("fünfmal /auftraege während der PIN-Abfrage: kein Missbrauch, kein Notfall, der Befehl läuft", async () => {
    abhaengigkeiten.handleMessage = async () => { assert.fail("ein Befehl geht nicht an Claude"); };
    const vorher = missbrauchsSignale();
    for (let i = 0; i < 5; i++) {
      const a = sensibel();
      await handleUpdate(knopf(`ok:${a.id}`));
      aufrufe = [];
      await handleUpdate(nachricht(9901 + i, "/auftraege"));
      assert.equal(getAuftrag(a.id)?.status, "offen", "nicht abgelehnt");
      assert.ok(!aufrufe.some((x) => x.method === "deleteMessage"), "der Befehl wird nicht gelöscht");
      assert.ok(!gesendet().some((t) => t.startsWith("Falsche PIN")));
      assert.ok(gesendet().some((t) => t.includes(`Auftrag #${a.id}`)), "/auftraege zeigt den Auftrag wieder");
    }
    assert.equal(missbrauchsSignale(), vorher);
    assert.notEqual(state.notfall?.aktiv, true);
    assert.equal(state.paused, false);
    assert.equal(reminders.length, 0, "nichts ausgeführt");
  });

  it("anderer Befehl während der PIN-Abfrage: Hinweis, Befehl läuft, eine spätere PIN führt nichts aus", async () => {
    const a = sensibel();
    await handleUpdate(knopf(`ok:${a.id}`));
    aufrufe = [];
    await handleUpdate(nachricht(9911, "/modus fokus"));
    assert.deepEqual(gesendet(), [`#${a.id} wartet nicht mehr auf die PIN, Sir. /auftraege zeigt ihn wieder.`, "Modus: fokus."]);
    assert.equal(getAuftrag(a.id)?.status, "offen");
    state.mode = "normal";
    // die Freigabe wartet nicht mehr: die PIN wird gelöscht, nichts läuft
    aufrufe = [];
    await handleUpdate(nachricht(9912, "4711"));
    assert.deepEqual(gesendet(), ["Das sieht aus wie eine PIN, Sir. Ich schicke es nicht weiter."]);
    assert.equal(getAuftrag(a.id)?.status, "offen");
    assert.equal(reminders.length, 0);
  });

  it("ein Satz statt der PIN: gelöscht, nie an Claude, nicht abgelehnt, kein Missbrauch", async () => {
    abhaengigkeiten.handleMessage = async () => { assert.fail("geht nicht an Claude"); };
    const vorher = missbrauchsSignale();
    const a = sensibel();
    await handleUpdate(knopf(`ok:${a.id}`));
    aufrufe = [];
    await handleUpdate(nachricht(9921, "Wie wird das Wetter?"));
    assert.ok(aufrufe.some((x) => x.method === "deleteMessage"));
    assert.deepEqual(gesendet(), [`Das war keine PIN, Sir. #${a.id} wartet nicht mehr; /auftraege zeigt ihn wieder.`]);
    assert.equal(getAuftrag(a.id)?.status, "offen");
    assert.equal(missbrauchsSignale(), vorher);
  });

  it("eine falsche PIN-artige Eingabe zählt weiterhin als Missbrauch und lehnt ab", async () => {
    const vorher = missbrauchsSignale();
    const a = sensibel();
    await handleUpdate(knopf(`ok:${a.id}`));
    aufrufe = [];
    await handleUpdate(nachricht(9931, "nein"));
    assert.equal(getAuftrag(a.id)?.status, "abgelehnt");
    assert.ok(gesendet().includes(`Falsche PIN. #${a.id} abgelehnt.`));
    assert.equal(missbrauchsSignale(), vorher + 1);
  });

  it("/vorgang im Notaus und im Notfall: kein Vorgang, keine «gestartet»-Meldung, nur der Hinweis", async () => {
    const vorher = vorgangsAnzahl();
    state.paused = true;
    aufrufe = [];
    await handleUpdate(nachricht(9941, "/vorgang Website bauen"));
    assert.deepEqual(gesendet(), ["⛔ Notaus aktiv. Erst /weiter."]);
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    aufrufe = [];
    await handleUpdate(nachricht(9942, "/vorgang Website bauen"));
    assert.deepEqual(gesendet(), ["🚨 Notfall aktiv, Sir. Erst /entwarnung."]);
    assert.equal(vorgangsAnzahl(), vorher, "kein Eintrag in data/vorgaenge.json");
  });
});
