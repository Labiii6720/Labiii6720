import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { Request, Response } from "express";

// Vor dem Import: Temp-Verzeichnis (data/ liegt relativ) und Umgebung; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-events-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });
const TOKEN = "ereignis-token-nur-attrappe-0123456789";
process.env.JARVIS_EVENT_TOKEN = TOKEN;
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";

// Fixture: vorbereitetes Briefing von heute (mit Markdown und Link, damit forSpeech sichtbar wird)
const BRIEFING = "Guten *Morgen*, Sir. Zwei Termine, kein Regen. Details: https://example.invalid/kalender";
const { todayKey } = await import("../src/time.js");
/** Muss brain.ts BRIEFING_VERSION entsprechen (erster Test prüft das), sonst gilt der Cache als Altbestand. */
const FIXTURE_VERSION = 2;
mkdirSync("data", { recursive: true });
writeFileSync("data/state.json", JSON.stringify({
  day: { date: todayKey(), briefing: { text: BRIEFING, builtAt: new Date().toISOString(), v: FIXTURE_VERSION }, briefingDelivered: false },
}));

// fetch-Attrappe: Telegram antwortet ok (die nächsten `fehlschlaege` sendMessage mit 400), alles andere ist ein Fehler im Test
let aufrufe: { url: string; text?: string }[] = [];
let fehlschlaege = 0;
const echteFetch = globalThis.fetch;
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  aufrufe.push({ url, text: body.text });
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  if (url.endsWith("/sendMessage") && fehlschlaege > 0) {
    fehlschlaege--;
    // 400 wird nicht wiederholt: kein echtes Warten auf Backoff im Test
    return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: aufrufe.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const { handleEvent, briefingSatellit, briefingEreignis } = await import("../src/events.js");
const { BRIEFING_VERSION } = await import("../src/brain.js");
const { day, save, state } = await import("../src/state.js");
const { forSpeech } = await import("../src/voice.js");

/** Lässt angestossene Promise-Ketten (Telegram-Kopie im Hintergrund) durchlaufen. */
const durchlaufen = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};
const sendungen = () => aufrufe.filter((a) => a.url.endsWith("/sendMessage"));

interface Antwort { status: number; body: unknown; beendet: boolean }

/** Express-Anfrage und -Antwort als schlanke Attrappen; handleEvent nutzt nur header, body, ip, status, json, end. */
async function sende(body: unknown, kopfzeilen: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Promise<Antwort> {
  const kopf = Object.fromEntries(Object.entries(kopfzeilen).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { body, ip: "192.168.1.20", header: (name: string) => kopf[name.toLowerCase()] } as unknown as Request;
  const antwort: Antwort = { status: 200, body: undefined, beendet: false };
  const res = {
    get headersSent() { return antwort.beendet; },
    status(code: number) { antwort.status = code; return res; },
    json(b: unknown) { antwort.body = b; antwort.beendet = true; return res; },
    end() { antwort.beendet = true; return res; },
  } as unknown as Response;
  await handleEvent(req, res);
  await durchlaufen();
  return antwort;
}

const auditZeilen = (): { event: string; [k: string]: unknown }[] => {
  try {
    return readFileSync("data/audit.log", "utf8").trim().split("\n").filter(Boolean).map((z) => JSON.parse(z) as { event: string });
  } catch {
    return [];
  }
};

const echteTeile = briefingSatellit.teile;
const echterVersand = briefingSatellit.versandLaeuft;
const echterEreignisText = briefingEreignis.text;
const echteSprache = briefingEreignis.sprache;
const PLATZHALTER = "Das Briefing ist gleich fertig, Sir. Eine Minute.";

beforeEach(() => {
  aufrufe = [];
  fehlschlaege = 0;
  state.paused = false;
  briefingSatellit.teile = echteTeile;
  briefingSatellit.versandLaeuft = echterVersand;
  briefingEreignis.text = echterEreignisText;
  briefingEreignis.sprache = echteSprache;
  state.notfall = undefined;
  briefingSatellit.pauseMs = 1; // Zeit injiziert: Nachlieferung ohne echte Minute
  briefingSatellit.versuche = 3;
  const d = day();
  d.briefing = { text: BRIEFING, builtAt: new Date().toISOString(), v: BRIEFING_VERSION };
  d.briefingDelivered = false;
  delete d.briefingVorgelesen;
  save();
});

describe("Ereignis briefing_text (Satellit im Bad)", () => {
  it("Fixture passt zur Cache-Version des Briefings", () => {
    assert.equal(FIXTURE_VERSION, BRIEFING_VERSION);
  });

  it("liefert den Vorlesetext synchron, ohne Telegram und ohne «zugestellt»-Merker", async () => {
    const a = await sende({ event: "briefing_text" });
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, { ok: true, bereit: true, text: forSpeech(BRIEFING) });
    const text = (a.body as { text: string }).text;
    assert.ok(!text.includes("*") && !text.includes("https://"), text);
    assert.equal(aufrufe.length, 0, "kein Telegram-Aufruf");
    assert.equal(day().briefingDelivered, false, "Telegram-Kopie wird beim nächsten Abruf nachgeholt");
    const eintrag = auditZeilen().filter((z) => z.event === "briefing_satellit").at(-1);
    assert.ok(eintrag, "Audit briefing_satellit");
    assert.equal(eintrag.kopie, false);
    assert.equal(eintrag.bereit, true);
    assert.ok(!JSON.stringify(eintrag).includes("Termine"), "Audit ohne Briefing-Inhalt");
  });

  it("kopie: telegram beim ersten Mal → genau ein sendMessage (die übliche erste Kopie)", async () => {
    const a = await sende({ event: "briefing_text", kopie: "telegram" });
    assert.equal(a.status, 200);
    assert.equal((a.body as { text: string }).text, forSpeech(BRIEFING));
    assert.equal(sendungen().length, 1);
    assert.equal(sendungen()[0].text, BRIEFING);
    assert.equal(day().briefingDelivered, true);
  });

  it("kopie: telegram, Briefing schon zugestellt → genau ein sendMessage mit Dusch-Kopie", async () => {
    day().briefingDelivered = true;
    save();
    const a = await sende({ event: "briefing_text", kopie: "telegram" });
    assert.equal(a.status, 200);
    assert.equal(sendungen().length, 1);
    assert.equal(sendungen()[0].text, `🚿 ${BRIEFING}`);
  });

  it("unbekannter Wert bei kopie zählt nicht als Telegram-Kopie", async () => {
    const a = await sende({ event: "briefing_text", kopie: "sms" });
    assert.equal(a.status, 200);
    assert.equal(aufrufe.length, 0);
  });

  it("falscher oder fehlender Token → 401 ohne Briefing", async () => {
    const vorher = auditZeilen().filter((z) => z.event === "briefing_satellit").length;
    const fehler = console.error;
    console.error = () => {};
    try {
      const koepfe: Record<string, string>[] = [{ authorization: "Bearer falsch-falsch-falsch-falsch-falsch-1" }, { authorization: `Bearer ${TOKEN}x` }, {}];
      for (const kopf of koepfe) {
        const a = await sende({ event: "briefing_text" }, kopf);
        assert.equal(a.status, 401);
        assert.deepEqual(a.body, { ok: false, error: "unauthorized" });
      }
      // höchstens die gedrosselte Warnung, nie das Briefing
      assert.ok(sendungen().every((s) => !String(s.text).includes("Termine")));
      assert.equal(auditZeilen().filter((z) => z.event === "briefing_satellit").length, vorher);
    } finally {
      console.error = fehler;
    }
  });

  it("über den Cloudflare Tunnel (auch mit EVENTS_VIA_TUNNEL=on) → 404 ohne Briefing", async () => {
    const vorher = auditZeilen().filter((z) => z.event === "briefing_satellit").length;
    const tunnelKoepfe: Record<string, string>[] = [{ "cf-connecting-ip": "203.0.113.7" }, { "cf-ray": "8a1b2c3d4e5f-ZRH" }];
    for (const tunnel of tunnelKoepfe) {
      const a = await sende({ event: "briefing_text", kopie: "telegram" }, { authorization: `Bearer ${TOKEN}`, ...tunnel });
      assert.equal(a.status, 404);
      assert.equal(a.body, undefined);
      assert.ok(a.beendet);
    }
    assert.equal(aufrufe.length, 0);
    assert.equal(auditZeilen().filter((z) => z.event === "briefing_satellit").length, vorher);
    assert.ok(auditZeilen().some((z) => z.event === "briefing_satellit_abgewiesen"));
  });

  it("Briefing nicht fertig (Platzhalter) → leerer Text, bereit false, kein «Eine Minute» und kein sofortiges Telegram", async () => {
    const d = day();
    delete d.briefing;
    save();
    const rufe: (boolean | undefined)[] = [];
    briefingSatellit.versuche = 0; // hier nur die synchrone Antwort
    briefingSatellit.teile = async (o) => { rufe.push(o?.telegramKopie); return { text: PLATZHALTER, hinweis: "" }; };
    const a = await sende({ event: "briefing_text" });
    await briefingSatellit.laufend;
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, { ok: false, bereit: false, text: "", nachlieferung: "telegram" });
    assert.deepEqual(rufe, [false]);
    assert.equal(aufrufe.length, 0, "kein Telegram-Aufruf");
    assert.equal(day().briefingDelivered, false);
    const eintrag = auditZeilen().filter((z) => z.event === "briefing_satellit").at(-1);
    assert.ok(eintrag);
    assert.equal(eintrag.bereit, false);
    assert.equal(eintrag.zeichen, 0);
  });

  it("Zeitbudget überschritten oder Fehler → ebenfalls leerer Text statt Platzhalter", async () => {
    briefingSatellit.versuche = 0;
    briefingSatellit.teile = async () => { throw new Error("Timeout nach 3000 ms"); };
    const a = await sende({ event: "briefing_text", kopie: "telegram" });
    await briefingSatellit.laufend;
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, { ok: false, bereit: false, text: "", nachlieferung: "telegram" });
    assert.equal(aufrufe.length, 0);
  });

  it("Briefing alt (Altbestand) und Neubau scheitert → nicht bereit, obwohl ein Text kommt", async () => {
    briefingSatellit.versuche = 0;
    const d = day();
    d.briefing = { text: "Altes Briefing.", builtAt: "2000-01-01T00:00:00.000Z" };
    save();
    // briefingTeile liefert dann den Platzhalter, nie den alten Cache
    briefingSatellit.teile = async () => ({ text: PLATZHALTER, hinweis: "Ein Auftrag wartet." });
    const a = await sende({ event: "briefing_text" });
    await briefingSatellit.laufend;
    assert.equal((a.body as { bereit: boolean }).bereit, false);
    assert.equal((a.body as { text: string }).text, "");
  });

  it("Nachlieferung: sobald das Briefing fertig ist, kommt es genau einmal per Telegram", async () => {
    const d = day();
    delete d.briefing;
    save();
    let n = 0;
    briefingSatellit.teile = async (o) => {
      n++;
      if (n < 3) return { text: PLATZHALTER, hinweis: "" };
      // inzwischen gebaut (wie morningTick oder der Livebau es ablegen)
      day().briefing = { text: BRIEFING, builtAt: new Date().toISOString(), v: BRIEFING_VERSION };
      return echteTeile(o);
    };
    const a = await sende({ event: "briefing_text" });
    assert.equal((a.body as { bereit: boolean }).bereit, false);
    assert.ok(briefingSatellit.laufend, "Nachlieferung läuft");
    await briefingSatellit.laufend;
    await durchlaufen();
    assert.equal(sendungen().length, 1);
    assert.equal(sendungen()[0].text, BRIEFING);
    assert.equal(day().briefingDelivered, true);
    assert.ok(auditZeilen().some((z) => z.event === "briefing_satellit_nachgeliefert" && z.versuch === 2));
  });

  it("Nachlieferung bei schon zugestelltem Briefing: Dusch-Kopie", async () => {
    const d = day();
    delete d.briefing;
    d.briefingDelivered = true;
    save();
    let n = 0;
    briefingSatellit.teile = async (o) => {
      if (++n < 2) return { text: PLATZHALTER, hinweis: "" };
      day().briefing = { text: BRIEFING, builtAt: new Date().toISOString(), v: BRIEFING_VERSION };
      return echteTeile(o);
    };
    await sende({ event: "briefing_text" });
    await briefingSatellit.laufend;
    await durchlaufen();
    assert.equal(sendungen().length, 1);
    assert.equal(sendungen()[0].text, `🚿 ${BRIEFING}`);
  });

  it("Nachlieferung gibt nach den Versuchen auf, ohne Platzhalter an Telegram", async () => {
    const d = day();
    delete d.briefing;
    save();
    let n = 0;
    briefingSatellit.teile = async () => { n++; return { text: PLATZHALTER, hinweis: "" }; };
    await sende({ event: "briefing_text" });
    await briefingSatellit.laufend;
    await durchlaufen();
    assert.equal(n, 1 + briefingSatellit.versuche);
    // genau ein Hinweis, dass nichts kommt (Home Assistant wartet auf die Nachlieferung), nie der Platzhalter
    assert.equal(sendungen().length, 1);
    assert.match(String(sendungen()[0].text), /nicht zustande gekommen, Sir/);
    assert.ok(!String(sendungen()[0].text).includes("Eine Minute"));
    assert.equal(day().briefingDelivered, false);
    assert.ok(auditZeilen().some((z) => z.event === "briefing_satellit_nachgeliefert" && z.zugestellt === false));
  });

  it("Nachlieferung: scheitert die erste Telegram-Kopie, wird sie erneut angestossen statt als nachgeliefert zu gelten", async () => {
    const d = day();
    delete d.briefing;
    save();
    fehlschlaege = 1;
    let n = 0;
    briefingSatellit.teile = async (o) => {
      if (++n < 2) return { text: PLATZHALTER, hinweis: "" };
      day().briefing = { text: BRIEFING, builtAt: new Date().toISOString(), v: BRIEFING_VERSION };
      return echteTeile(o);
    };
    const fehler = console.error;
    console.error = () => {};
    try {
      await sende({ event: "briefing_text" });
      await briefingSatellit.laufend;
      await durchlaufen();
    } finally {
      console.error = fehler;
    }
    assert.equal(sendungen().length, 2, "ein gescheiterter, ein erfolgreicher Versand");
    assert.ok(sendungen().every((x) => x.text === BRIEFING));
    assert.equal(day().briefingDelivered, true);
    const eintraege = auditZeilen().filter((z) => z.event === "briefing_satellit_nachgeliefert");
    assert.ok(eintraege.at(-1)?.versuch === 1 && eintraege.at(-1)?.zugestellt === undefined, JSON.stringify(eintraege.at(-1)));
  });

  it("Notaus vor dem Abruf: abgewiesen, kein Abruf (kein Livebau bei Claude), keine Kopie, keine Nachlieferung, kein Telegram", async () => {
    const d = day();
    delete d.briefing;
    save();
    state.paused = true;
    const rufe: (boolean | undefined)[] = [];
    briefingSatellit.teile = async (o) => { rufe.push(o?.telegramKopie); return { text: PLATZHALTER, hinweis: "" }; };
    const a = await sende({ event: "briefing_text", kopie: "telegram" });
    assert.equal(briefingSatellit.laufend, undefined, "keine Nachlieferung");
    await durchlaufen();
    assert.deepEqual(a.body, { ok: false, bereit: false, text: "", gesperrt: true });
    assert.deepEqual(rufe, [], "briefingTeile (und damit buildBriefing) nicht aufgerufen");
    assert.equal(sendungen().length, 0);
    assert.ok(auditZeilen().some((z) => z.event === "briefing_satellit_abgewiesen" && z.grund === "notaus"));
  });

  it("Notaus/Notfall mit Briefing im Cache: kein Text heraus, echtes briefingTeile nicht aufgerufen", async () => {
    let n = 0;
    briefingSatellit.teile = async (o) => { n++; return echteTeile(o); };
    state.paused = true;
    const a = await sende({ event: "briefing_text" });
    state.paused = false;
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    const b = await sende({ event: "briefing_text", kopie: "telegram" });
    for (const x of [a, b]) {
      assert.equal(x.status, 200);
      assert.deepEqual(x.body, { ok: false, bereit: false, text: "", gesperrt: true });
    }
    assert.equal(n, 0);
    assert.equal(aufrufe.length, 0);
    assert.equal(day().briefingVorgelesen, undefined);
    assert.equal(briefingSatellit.laufend, undefined);
  });

  it("Notaus während des Abrufs: nichts herausgeben, keine Nachlieferung", async () => {
    briefingSatellit.teile = async () => {
      state.paused = true;
      return { text: BRIEFING, hinweis: "", bereit: true };
    };
    const a = await sende({ event: "briefing_text", kopie: "telegram" });
    assert.deepEqual(a.body, { ok: false, bereit: false, text: "", gesperrt: true });
    assert.equal(briefingSatellit.laufend, undefined);
    assert.equal(sendungen().length, 0);
  });

  it("Nachlieferung: Nachlauf wartet auf die noch wiederholte erste Kopie statt «nicht zustande gekommen» zu melden", async () => {
    const d = day();
    delete d.briefing;
    save();
    let n = 0;
    let versand: Promise<void> | undefined;
    briefingSatellit.teile = async () => {
      if (++n <= briefingSatellit.versuche) return { text: PLATZHALTER, hinweis: "" };
      // erst im letzten regulären Durchgang bereit; die Kopie braucht länger als eine Pause (Backoff bei Telegram)
      day().briefing = { text: BRIEFING, builtAt: new Date().toISOString(), v: BRIEFING_VERSION };
      versand ??= new Promise<void>((r) => setTimeout(() => { day().briefingDelivered = true; save(); r(); }, 30));
      return { text: BRIEFING, hinweis: "", bereit: true };
    };
    let gewartet = 0;
    briefingSatellit.versandLaeuft = () => { if (versand) gewartet++; return versand; };
    await sende({ event: "briefing_text" });
    await briefingSatellit.laufend;
    await durchlaufen();
    assert.equal(gewartet, 1, "auf den laufenden Versand gewartet");
    assert.equal(day().briefingDelivered, true);
    assert.equal(sendungen().length, 0, "keine Fehlmeldung");
    const eintrag = auditZeilen().filter((z) => z.event === "briefing_satellit_nachgeliefert").at(-1);
    assert.ok(eintrag?.versuch === briefingSatellit.versuche && eintrag?.zugestellt === undefined, JSON.stringify(eintrag));
  });

  it("Notaus während der Nachlieferung: kein weiterer Abruf, kein Telegram", async () => {
    const d = day();
    delete d.briefing;
    save();
    briefingSatellit.pauseMs = 50; // Zeit, um den Notaus nach der Antwort auszulösen
    let n = 0;
    briefingSatellit.teile = async () => { n++; return { text: PLATZHALTER, hinweis: "" }; };
    await sende({ event: "briefing_text" });
    assert.ok(briefingSatellit.laufend, "Nachlieferung läuft");
    state.paused = true;
    await briefingSatellit.laufend;
    await durchlaufen();
    assert.equal(n, 1, "teile nur beim synchronen Abruf");
    assert.equal(sendungen().length, 0);
    assert.ok(auditZeilen().some((z) => z.event === "briefing_satellit_nachgeliefert" && z.abgebrochen === "notaus"));
  });

  it("Nachlieferung bricht ab, wenn das Briefing anderweitig zugestellt wurde", async () => {
    const d = day();
    delete d.briefing;
    save();
    let n = 0;
    briefingSatellit.teile = async () => {
      n++;
      day().briefingDelivered = true; // z. B. Fallback «briefing» aus Home Assistant
      return { text: PLATZHALTER, hinweis: "" };
    };
    await sende({ event: "briefing_text" });
    await briefingSatellit.laufend;
    assert.equal(n, 1, "kein weiterer Abruf");
    assert.equal(aufrufe.length, 0);
  });

  it("vorgelesen (auch nach Livebau) → Merker «vorgelesen» gesetzt, kein Neubau alle 45 Minuten", async () => {
    const d = day();
    delete d.briefing;
    save();
    briefingSatellit.versuche = 0;
    briefingSatellit.teile = async () => {
      // wie ein Livebau innerhalb des Budgets: legt das Briefing im Cache ab
      day().briefing = { text: BRIEFING, builtAt: new Date().toISOString(), v: BRIEFING_VERSION };
      return { text: BRIEFING, hinweis: "", bereit: true };
    };
    const a = await sende({ event: "briefing_text" });
    assert.equal((a.body as { bereit: boolean }).bereit, true);
    assert.equal(day().briefingVorgelesen, true);
    assert.equal(day().briefingDelivered, false);
  });

  it("Livebau überdauert das Budget → nicht bereit und kein Merker «vorgelesen»", async () => {
    const d = day();
    delete d.briefing;
    save();
    briefingSatellit.versuche = 0;
    let freigeben!: () => void;
    const gebaut = new Promise<void>((r) => { freigeben = r; });
    briefingSatellit.teile = async () => {
      await gebaut;
      day().briefing = { text: BRIEFING, builtAt: new Date().toISOString(), v: BRIEFING_VERSION };
      return { text: BRIEFING, hinweis: "", bereit: true };
    };
    // Mindestbudget 3 s: kürzer lässt es sich nicht einstellen. Der Zeitlimit-Timer ist unref'd; ohne eigenen
    // Timer hielte nichts die Ereignisschleife am Leben, und node:test bräche den Test ab.
    const wach = setInterval(() => undefined, 500);
    let a: Antwort;
    try {
      a = await sende({ event: "briefing_text", budget: 3000 });
    } finally {
      clearInterval(wach);
    }
    freigeben();
    await durchlaufen();
    assert.deepEqual(a.body, { ok: false, bereit: false, text: "", nachlieferung: "telegram" });
    assert.equal(day().briefingVorgelesen, undefined);
    assert.equal(sendungen().length, 0);
  });

  it("Notaus/Notfall: Ereignis briefing liefert nichts und schickt nichts an Telegram", async () => {
    try {
      state.paused = true;
      const a = await sende({ event: "briefing" });
      assert.deepEqual(a.body, { ok: false, gesperrt: true });
      state.paused = false;
      state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
      const b = await sende({ event: "briefing" });
      assert.deepEqual(b.body, { ok: false, gesperrt: true });
      assert.equal(sendungen().length, 0);
      assert.equal(day().briefingDelivered, false);
    } finally {
      state.paused = false;
      state.notfall = undefined;
    }
  });

  it("Notfall während des Briefing-Baus: Ereignis briefing schickt weder Text- noch Sprachkopie", async () => {
    const d = day();
    d.briefingDelivered = true; // sonst ginge die Dusch-Kopie ohnehin nicht hinaus
    save();
    const sprache: string[] = [];
    briefingEreignis.sprache = async (t) => { sprache.push(t); };
    briefingEreignis.text = async () => {
      // POST /notfall trifft ein, während das Briefing noch live gebaut wird
      state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
      return BRIEFING;
    };
    try {
      const a = await sende({ event: "briefing" });
      assert.deepEqual(a.body, { ok: false, gesperrt: true });
      assert.equal(sendungen().length, 0, "keine Dusch-Kopie");
      assert.equal(sprache.length, 0, "keine Sprachnachricht");
      assert.ok(auditZeilen().some((z) => z.event === "briefing_abgewiesen"));
    } finally {
      state.notfall = undefined;
    }
  });

  it("Notaus während der Dusch-Kopie: Ereignis briefing schickt keine Sprachnachricht mehr", async () => {
    const d = day();
    d.briefingDelivered = true;
    save();
    const sprache: string[] = [];
    briefingEreignis.sprache = async (t) => { sprache.push(t); };
    const echt = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const r = await echt(...args);
      state.paused = true; // Notaus kommt, während die Text-Kopie unterwegs ist
      return r;
    }) as typeof fetch;
    try {
      const a = await sende({ event: "briefing" });
      assert.deepEqual(a.body, { ok: false, gesperrt: true });
      assert.equal(sendungen().length, 1, "Text-Kopie war schon unterwegs");
      assert.equal(sprache.length, 0, "keine Sprachnachricht");
    } finally {
      globalThis.fetch = echt;
      state.paused = false;
    }
  });

  it("Ereignis briefing ohne Sperre: Dusch-Kopie und Sprachnachricht wie bisher", async () => {
    const d = day();
    d.briefingDelivered = true;
    save();
    const sprache: string[] = [];
    briefingEreignis.sprache = async (t) => { sprache.push(t); };
    const a = await sende({ event: "briefing" });
    assert.deepEqual(a.body, { ok: true });
    assert.equal(sendungen().length, 1);
    assert.ok(sendungen()[0].text?.startsWith("🚿 "));
    assert.equal(sprache.length, 1);
  });

  it("Notaus: briefingTeile stösst keine erste Telegram-Kopie an", async () => {
    state.paused = true;
    const t = await echteTeile({ telegramKopie: true });
    await durchlaufen();
    assert.equal(t.bereit, true);
    assert.equal(sendungen().length, 0);
    assert.equal(day().briefingDelivered, false);
  });

  it("bisheriges Ereignis briefing bleibt unverändert (Telegram)", async () => {
    const a = await sende({ event: "briefing" });
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, { ok: true });
    assert.equal(sendungen().length, 1);
  });
});

describe("Route /events", () => {
  it("ist nur mit Token und nur aus dem Heimnetz (lanOnly) eingebunden", () => {
    const server = readFileSync(join(projekt, "src", "server.ts"), "utf8");
    assert.match(server, /if \(config\.eventToken\) \{[\s\S]*?app\.post\("\/events", lanOnly,/);
    assert.match(server, /app\.options\("\/events", lanOnly,/);
  });
});
