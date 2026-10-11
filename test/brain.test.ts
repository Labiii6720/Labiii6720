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
const { briefingText, briefingTeile, briefingNeuBauen, briefingAltbestand, BRIEFING_VERSION, aktuellerFreigabenHinweis, dashboardErreichbar, freigabenHinweis, kurzFuerStimme, HINWEIS_MAX_ZEICHEN } = await import("../src/brain.js");
const { config } = await import("../src/config.js");
const { day, save, state } = await import("../src/state.js");
const { auftraege } = await import("../src/queue.js");
type Auftrag = import("../src/queue.js").Auftrag;
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
  delete (d as { briefingVorgelesen?: boolean }).briefingVorgelesen;
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

// =====================================================================
// Steht vor den Freigaben-Tests: deren Notaus-Test lässt einen Telegram-Versand hängen, der weitere Kopien sperrt
describe("Satellit ohne Telegram-Kopie – kein Neubau alle 45 Minuten", () => {
  const vorgelesen = () => (day() as { briefingVorgelesen?: boolean }).briefingVorgelesen;

  it("briefingNeuBauen: veraltet ohne Ansage, nach der Ansage am Satelliten nicht mehr", async () => {
    const d = day();
    const spaeter = Date.parse(d.briefing!.builtAt) + 50 * 60_000;
    d.briefing!.v = BRIEFING_VERSION;
    assert.equal(briefingNeuBauen(d, spaeter), true, "älter als 45 Minuten → neu bauen");

    const t = await briefingTeile({ telegramKopie: false });
    assert.equal(t.text, "Guten Morgen, Sir. Zwei Termine, kein Regen.");
    assert.equal(t.bereit, true);
    await durchlaufen();
    assert.equal(sendungen().length, 0, "keine Telegram-Kopie");
    assert.equal(vorgelesen(), true);
    assert.equal(day().briefingDelivered, false, "Kopie bleibt nachholbar");
    // Über den ganzen Morgen (bis 10:00) kein weiterer Claude-Aufruf
    for (let min = 50; min <= 240; min += 45) {
      assert.equal(briefingNeuBauen(day(), Date.parse(d.briefing!.builtAt) + min * 60_000), false, `nach ${min} min`);
    }
    // Neues Training ändert daran nichts (wie nach der Zustellung)
    d.workout = { id: "w-neu", sport: "Laufen", start: d.briefing!.builtAt, end: d.briefing!.builtAt } as typeof d.workout;
    assert.equal(briefingNeuBauen(d, spaeter), false);
    delete d.workout;

    // Der nächste Abruf mit Kopie (Alexa/briefing) holt die Telegram-Kopie weiterhin nach
    await briefingText();
    await durchlaufen();
    assert.equal(sendungen().length, 1);
    sendungen()[0].antworte(tg({ ok: true, result: { message_id: 7 } }));
    await durchlaufen();
    await durchlaufen();
    assert.equal(day().briefingDelivered, true);
  });

  it("Platzhalter «gleich fertig» zählt nicht als vorgelesen", async () => {
    const err = console.error;
    console.error = () => {};
    const d = day();
    d.briefing = undefined;
    try {
      // Build scheitert sofort (Claude-Attrappe antwortet 400), statt das 6-s-Zeitlimit abzuwarten → Platzhalter
      const p = briefingTeile({ telegramKopie: false });
      for (let i = 0; i < 50 && !offen.some((o) => o.url.includes("anthropic")); i++) {
        await durchlaufen();
        for (const o of offen.splice(0)) {
          if (o.url.includes("anthropic")) { offen.push(o); break; }
          o.antworte(tg({ error: "nicht da" }, 404));
        }
      }
      const claudeAnfrage = offen.find((o) => o.url.includes("anthropic"));
      assert.ok(claudeAnfrage, "Build fragt Claude");
      claudeAnfrage.antworte(tg({ type: "error", error: { type: "invalid_request_error", message: "attrappe" } }, 400));
      const t = await p;
      assert.match(t.text, /gleich fertig/);
      assert.equal(t.bereit, false, "Platzhalter ausdrücklich markiert");
      assert.notEqual(vorgelesen(), true);
      assert.equal(briefingNeuBauen(day()), true, "ohne echtes Briefing weiter bauen");
    } finally {
      console.error = err;
    }
  });

  it("Livebau (kann das Budget des Satelliten überdauern) setzt den Merker nicht", async () => {
    const err = console.error;
    console.error = () => {};
    const d = day();
    d.briefing = undefined;
    try {
      const p = briefingTeile({ telegramKopie: false });
      for (let i = 0; i < 50 && !offen.some((o) => o.url.includes("anthropic")); i++) {
        await durchlaufen();
        for (const o of offen.splice(0)) {
          if (o.url.includes("anthropic")) { offen.push(o); break; }
          o.antworte(tg({ error: "nicht da" }, 404));
        }
      }
      const claudeAnfrage = offen.find((o) => o.url.includes("anthropic"));
      assert.ok(claudeAnfrage, "Build fragt Claude");
      claudeAnfrage.antworte(tg({
        id: "msg_attrappe", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text: "Frisch gebaut, Sir." }], usage: { input_tokens: 10, output_tokens: 5 },
      }));
      const t = await p;
      assert.equal(t.text, "Frisch gebaut, Sir.");
      assert.equal(t.bereit, true);
      await durchlaufen();
      assert.equal(vorgelesen(), undefined, "ob der Aufrufer noch wartete, weiss nur er");
      assert.equal(sendungen().length, 0, "keine Telegram-Kopie");
      // Ein späterer Abruf aus dem Cache (sicher innerhalb des Budgets) setzt ihn dann
      await briefingTeile({ telegramKopie: false });
      assert.equal(vorgelesen(), true);
    } finally {
      console.error = err;
    }
  });

  it("zugestellt verhindert den Neubau wie bisher", () => {
    const d = day();
    d.briefingDelivered = true;
    assert.equal(briefingNeuBauen(d, Date.now() + 3 * 3_600_000), false);
    d.briefingDelivered = false;
    assert.equal(briefingNeuBauen(d, Date.now() + 3 * 3_600_000), true);
    d.briefing = undefined;
    assert.equal(briefingNeuBauen(d), true);
  });
});

// =====================================================================
const auftrag = (id: number, summary: string, extra: Partial<Auftrag> = {}): Auftrag => ({
  id, summary, status: "offen", createdAt: "2026-10-11T06:00:00.000Z", tool: "gmail_senden", input: {}, stufe: "extern", ...extra,
});
const einzelnesSurrogat = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("Freigaben-Hinweis – Notaus, gestartete Aufträge, Emoji", () => {
  it("Notaus: keine Zusammenfassung und kein «Freigeben geht», auch nicht im Briefing", async () => {
    auftraege.splice(0, auftraege.length, auftrag(12, "Mail an Müller AG wegen Offerte"));
    try {
      state.paused = true;
      state.notfall = undefined;
      const h = aktuellerFreigabenHinweis();
      assert.match(h, /Notaus aktiv/);
      assert.match(h, /\/weiter/);
      assert.ok(!h.includes("Müller") && !h.includes("Nummer 12") && !h.includes("Freigeben geht"), h);

      state.notfall = { aktiv: true, seit: "2026-10-11T05:00:00.000Z", grund: "Test" };
      const n = aktuellerFreigabenHinweis();
      assert.match(n, /Notfall aktiv/);
      assert.match(n, /\/entwarnung/);
      assert.ok(!n.includes("Müller") && !n.includes("Freigeben geht"), n);

      const b = await briefingText();
      assert.ok(!b.includes("Müller") && !b.includes("Freigeben geht"), b);

      state.paused = false;
      state.notfall = undefined;
      assert.match(aktuellerFreigabenHinweis(), /Nummer 12, Mail an Müller AG/);
    } finally {
      state.paused = false;
      state.notfall = undefined;
      auftraege.splice(0, auftraege.length);
    }
  });

  it("gestartete Aufträge warten nicht auf Freigabe und werden ohne Inhalt eigens genannt", () => {
    const gestartet = auftrag(12, "Protokoll Werkstatt ausführen", { gestartetAm: "2026-10-11T06:00:00.000Z" });
    const nur = freigabenHinweis([gestartet], "Sir");
    assert.ok(!nur.includes("wartet") && !nur.includes("Freigeben geht") && !nur.includes("Werkstatt"), nur);
    assert.match(nur, /^Nummer 12 ist bereits gestartet oder ohne klares Ergebnis; den Stand zeigt Telegram\.$/);

    const gemischt = freigabenHinweis([gestartet, auftrag(13, "Licht Büro aus"), auftrag(14, "B", { gestartetAm: "x" })], "Sir");
    assert.equal(
      gemischt,
      "Ein Auftrag wartet auf Ihre Freigabe, Sir: Nummer 13, Licht Büro aus. Freigeben geht per Telegram oder Dashboard. " +
        "Die Nummern 12, 14 sind bereits gestartet oder ohne klares Ergebnis; den Stand zeigt Telegram.",
    );
    assert.equal(freigabenHinweis([auftrag(1, "A", { status: "erledigt", gestartetAm: "x" })], "Sir"), "");
  });

  it("gestartete Aufträge: höchstens drei Nummern, Rest gezählt", () => {
    const g = (id: number) => auftrag(id, `Geheim ${id}`, { gestartetAm: "2026-10-11T06:00:00.000Z" });
    assert.equal(
      freigabenHinweis([3, 7, 12, 15, 21].map(g), "Sir"),
      "Die Nummern 3, 7, 12 und zwei weitere sind bereits gestartet oder ohne klares Ergebnis; den Stand zeigt Telegram.",
    );
    assert.equal(
      freigabenHinweis([3, 7, 12, 15].map(g), "Sir"),
      "Die Nummern 3, 7, 12 und eine weitere sind bereits gestartet oder ohne klares Ergebnis; den Stand zeigt Telegram.",
    );
    assert.equal(
      freigabenHinweis([3, 7, 12].map(g), "Sir"),
      "Die Nummern 3, 7, 12 sind bereits gestartet oder ohne klares Ergebnis; den Stand zeigt Telegram.",
    );
    const viele = freigabenHinweis([...Array.from({ length: 15 }, (_, i) => g(i + 1)), auftrag(99, "Licht aus")], "Sir");
    assert.match(viele, /Nummer 99, Licht aus\. Freigeben geht/);
    assert.match(viele, /Die Nummern 1, 2, 3 und zwölf weitere sind bereits gestartet/);
    assert.ok(!/\b4\b|Geheim/.test(viele), viele);
  });

  it("Dashboard nur nennen, wenn es eingebunden ist (DASHBOARD an und JARVIS_EVENT_TOKEN gesetzt)", () => {
    const vorher = { dashboard: config.dashboard, eventToken: config.eventToken };
    auftraege.splice(0, auftraege.length, auftrag(12, "Mail an Müller AG"));
    try {
      config.dashboard = true;
      config.eventToken = undefined;
      assert.equal(dashboardErreichbar(), false);
      const ohneToken = aktuellerFreigabenHinweis();
      assert.ok(ohneToken.endsWith("Freigeben geht per Telegram."), ohneToken);
      assert.ok(!ohneToken.includes("Dashboard"), ohneToken);

      config.eventToken = "attrappe-event-token";
      assert.equal(dashboardErreichbar(), true);
      assert.ok(aktuellerFreigabenHinweis().endsWith("Freigeben geht per Telegram oder Dashboard."));

      config.dashboard = false;
      assert.equal(dashboardErreichbar(), false);
      assert.ok(aktuellerFreigabenHinweis().endsWith("Freigeben geht per Telegram."));
    } finally {
      config.dashboard = vorher.dashboard;
      config.eventToken = vorher.eventToken;
      auftraege.splice(0, auftraege.length);
    }
  });

  it("Kürzung zerschneidet kein Emoji (kein einzelnes Surrogat)", () => {
    const t = "Termin anlegen: «Geburtstagsfeier👨‍👩‍👧Familienessen🎉🎉🎉»";
    for (let max = 10; max <= HINWEIS_MAX_ZEICHEN; max++) {
      const k = kurzFuerStimme(t, max);
      assert.ok(!einzelnesSurrogat.test(k), `max ${max}: ${JSON.stringify(k)}`);
      assert.ok(Array.from(k).length <= max, `max ${max}: zu lang`);
    }
    const lang = `${"🎉".repeat(70)}`;
    const k = kurzFuerStimme(lang);
    assert.ok(!einzelnesSurrogat.test(k));
    assert.equal(k, `${"🎉".repeat(HINWEIS_MAX_ZEICHEN - 1)}…`);
    assert.ok(!einzelnesSurrogat.test(freigabenHinweis([auftrag(3, t)], "Sir")));
  });
});

// =====================================================================
describe("Briefing-Cache aus älterer Version (vor 0.19)", () => {
  const ALT = "Guten Morgen, Sir. Zwei Freigaben warten.";
  const vorStart = new Date(Date.now() - 3_600_000).toISOString();

  /** Beantwortet anstehende Anfragen: Claude mit neuem Briefing, alles andere (Wetter) mit 404. */
  async function beantworte(neu: string): Promise<void> {
    for (let i = 0; i < 50; i++) {
      await durchlaufen();
      for (const o of offen.splice(0)) {
        if (o.url.includes("anthropic")) {
          o.antworte(tg({
            id: "msg_attrappe", type: "message", role: "assistant", model: "claude-attrappe",
            content: [{ type: "text", text: neu }], stop_reason: "end_turn", stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }));
        } else if (o.url.endsWith("/sendMessage")) {
          offen.push(o); // Telegram bleibt hängen, damit der Versand zählbar ist
          return;
        } else {
          o.antworte(tg({ error: "nicht da" }, 404));
        }
      }
    }
  }

  it("briefingAltbestand: Marke, Prozessstart und unlesbares Datum", () => {
    const start = Date.parse("2026-10-11T06:00:00.000Z");
    assert.equal(briefingAltbestand({ text: ALT, builtAt: "2026-10-11T05:30:00.000Z" }, start), true);
    assert.equal(briefingAltbestand({ text: ALT, builtAt: "kaputt" }, start), true);
    assert.equal(briefingAltbestand({ text: "neu", builtAt: "2026-10-11T05:30:00.000Z", v: BRIEFING_VERSION }, start), false);
    assert.equal(briefingAltbestand({ text: "neu", builtAt: "2026-10-11T06:10:00.000Z" }, start), false);
    assert.equal(briefingAltbestand({ text: ALT, builtAt: "2026-10-11T05:30:00.000Z", v: 1 }, start), true);
  });

  it("bereits zugestellt: altes Briefing wird neu gebaut, keine doppelte Freigaben-Zählung, kein zweiter Versand", async () => {
    const err = console.error;
    console.error = () => {};
    const d = day();
    d.briefing = { text: ALT, builtAt: vorStart };
    d.briefingDelivered = true;
    auftraege.splice(0, auftraege.length, auftrag(3, "Licht aus"));
    try {
      const p = briefingText();
      await beantworte("Guten Morgen, Sir. Drei Termine, kein Regen.");
      const b = await p;
      assert.ok(!b.includes("Zwei Freigaben"), b);
      assert.ok(b.startsWith("Guten Morgen, Sir. Drei Termine, kein Regen.\n\nEin Auftrag wartet"), b);
      assert.equal(day().briefing?.v, BRIEFING_VERSION);
      await durchlaufen();
      assert.equal(sendungen().length, 0);
    } finally {
      console.error = err;
      auftraege.splice(0, auftraege.length);
    }
  });

  it("frisches Briefing mit Versionsmarke bleibt im Cache, auch wenn vor dem Start gebaut", async () => {
    const d = day();
    const neu = { text: "Guten Morgen, Sir. Aus dem Cache.", builtAt: vorStart, v: BRIEFING_VERSION };
    d.briefing = neu;
    d.briefingDelivered = true;
    assert.equal(await briefingText(), "Guten Morgen, Sir. Aus dem Cache.");
    await durchlaufen();
    assert.equal(offen.length, 0, "keine Anfrage an Claude");
  });
});
