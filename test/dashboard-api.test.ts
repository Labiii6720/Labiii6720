import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

// Teil 1 prüft die Handler und reinen Funktionen im eigenen Prozess (Temp-Ordner, Attrappen, injizierte Zeit).
// Teil 2 startet src/server.ts als Kindprozess in einem zweiten Temp-Ordner und prüft die Verdrahtung über HTTP.
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-dashboard-api-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

const TOKEN = "dashboard-token-nur-attrappe-0123456789";
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = TOKEN;
process.env.JARVIS_PIN = "4711";
process.env.FRIGATE_URL = "http://frigate.attrappe";
process.env.ZEITPLAN_NACHHOLEN_MIN = "60";
for (const k of ["RUECKBLICK", "RECHNUNG_ERINNERUNG", "ZIELCHECK", "VERDICHTUNG", "FINANZBERICHT"]) process.env[k] = "off";
for (const k of ["PREIS_INPUT", "PREIS_OUTPUT", "PREIS_CACHE_READ", "PREIS_CACHE_WRITE"]) delete process.env[k];

mkdirSync(join(temp, "data"), { recursive: true });
const langesErgebnis = `Gesendet mit Authorization: Bearer abcdefghijklmnop0123 an https://x.example/?token=geheim123 ${"x".repeat(600)}`;
writeFileSync(
  join(temp, "data", "auftraege.json"),
  JSON.stringify([
    { id: 1, createdAt: "2026-10-01T08:00:00.000Z", tool: "mail_senden", input: { text: "GEHEIMER-MAILTEXT" }, stufe: "extern", summary: "Mail an Bank", status: "erledigt", result: langesErgebnis },
    { id: 2, createdAt: "2026-10-02T08:00:00.000Z", tool: "geraet_schalten", input: { entity_id: "lock.haustuer" }, stufe: "sensibel", summary: "Haustür auf", status: "abgelehnt", result: "falsche PIN" },
    { id: 3, createdAt: "2026-10-03T08:00:00.000Z", tool: "kalender_termin_erstellen", input: { titel: "GEHEIMER-TERMIN" }, stufe: "extern", summary: "Termin <img src=x onerror=alert(1)>", status: "fehler", result: "HTTP 500" },
    { id: 4, createdAt: "2026-10-04T08:00:00.000Z", tool: "mail_senden", input: { text: "GEHEIM" }, stufe: "extern", summary: "läuft", status: "offen", gestartetAm: "2026-10-04T08:01:00.000Z" },
  ]),
);
writeFileSync(join(temp, "data", "usage.json"), JSON.stringify({ "2026-10-10": { calls: 2, input: 1000, output: 200, cacheRead: 3000, cacheWrite: 0 } }));
writeFileSync(
  join(temp, "cameras.json"),
  JSON.stringify({
    einfahrt: { frigate: "einfahrt", beschreibung: "Einfahrt vorne", wachen: [{ frage: "Tor offen?", alle_minuten: 15 }] },
    garten: { frigate: "garten", beschreibung: "Garten" },
  }),
);
writeFileSync(join(temp, "data", "audit.log"), [
  '{"ts":"2026-10-11T08:00:00.000Z","event":"werkzeug","tool":"seite_lesen","input":"https://x.example/?token=geheim123"}',
  "kaputte Zeile {",
  '{"ts":"2026-10-11T08:01:00.000Z","event":"pause","quelle":"telegram"}',
  `{"ts":"2026-10-11T08:02:00.000Z","event":"lang","text":"${"y".repeat(400)}"}`,
  '{"event":"ohne_zeit"}',
].join("\n") + "\n");

/** Netz-Attrappe: Telegram nimmt an (Texte werden gesammelt), alles andere ist ein Fehler. */
let telegram: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (url.startsWith("https://api.telegram.org/bot")) {
    if (url.endsWith("/sendMessage") && typeof init?.body === "string") telegram.push(String((JSON.parse(init.body) as { text?: string }).text ?? ""));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
  }
  throw new Error(`unerwarteter Netzaufruf: ${url}`);
}) as typeof fetch;

const dashboard = await import("../src/dashboard.js");
const { verbrauchVerlauf, kosten } = await import("../src/claude.js");
const { naechsterLauf, pruefeZeitplan, faelligIm, zeitplaene } = await import("../src/zeitplaene.js");
const { pruefeWache, dynamicWachen, cameras } = await import("../src/cameras.js");
const { state } = await import("../src/state.js");
const { config } = await import("../src/config.js");
const { auftraege, createAuftrag, getAuftrag } = await import("../src/queue.js");
const { abhaengigkeiten, setzePinUhr, verteileUpdate } = await import("../src/telegram.js");
const { activeTools } = await import("../src/tools.js");
const { todayKey } = await import("../src/time.js");

type Antwort = { statusCode: number; body: any; weiter: boolean };
function antwort() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    send(b: unknown) { this.body = b; return this; },
    set() { return this; },
    end() { return this; },
  };
}
const anfrage = (teil: Record<string, unknown> = {}) => {
  const kopf = (teil.kopf ?? {}) as Record<string, string>;
  return { params: {}, query: {}, body: {}, header: (n: string) => kopf[n.toLowerCase()], ...teil } as never;
};
/** Ruft einen Handler wie Express auf (auch async) und liefert Status und Body. */
async function rufe(h: (req: never, res: never) => unknown, teil: Record<string, unknown> = {}): Promise<Antwort> {
  const res = antwort();
  await h(anfrage(teil), res as never);
  return { statusCode: res.statusCode, body: res.body, weiter: false };
}
const auditZeilen = () => readFileSync(join(temp, "data", "audit.log"), "utf8").trim().split("\n").flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
const NOTFALL = () => ({ aktiv: true, seit: new Date().toISOString(), grund: "Test" });
/** Lässt fire-and-forget-Meldungen (sendeSpaeter) durchlaufen. */
const ruhe = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  telegram = [];
  state.paused = false;
  state.notfall = { aktiv: false };
});

describe("Auth der Kommandozentrale", () => {
  const pruefe = (kopf: Record<string, string>, query: Record<string, string> = {}) => {
    const res = antwort();
    let weiter = false;
    dashboard.dashboardAuth(anfrage({ kopf, query }), res as never, () => { weiter = true; });
    return { status: res.statusCode, weiter };
  };

  it("ohne Token und mit falschem Token 401", () => {
    assert.deepEqual(pruefe({}), { status: 401, weiter: false });
    assert.deepEqual(pruefe({ authorization: "Bearer falsch" }), { status: 401, weiter: false });
    assert.deepEqual(pruefe({ authorization: `Bearer ${TOKEN.slice(0, -1)}x` }), { status: 401, weiter: false });
  });

  it("Token im Query-Parameter wird nicht mehr angenommen", () => {
    assert.deepEqual(pruefe({}, { token: TOKEN }), { status: 401, weiter: false });
  });

  it("mit gültigem Header weiter", () => {
    assert.deepEqual(pruefe({ authorization: `Bearer ${TOKEN}` }), { status: 200, weiter: true });
  });
});

describe("Notfall: 423 für Daten- und Schreibrouten, Ausnahmen bleiben offen", () => {
  it("notfallSperre hält jede Route auf, ohne den Handler zu erreichen", () => {
    state.notfall = NOTFALL();
    const res = antwort();
    let weiter = false;
    dashboard.notfallSperre(anfrage(), res as never, () => { weiter = true; });
    assert.equal(res.statusCode, 423);
    assert.equal(res.body.error, "notfall");
    assert.equal(weiter, false);
    state.notfall = { aktiv: false };
    dashboard.notfallSperre(anfrage(), antwort() as never, () => { weiter = true; });
    assert.equal(weiter, true);
  });

  it("auch die Handler selbst antworten im Notfall mit 423 und ändern nichts", async () => {
    state.notfall = NOTFALL();
    state.paused = true;
    const vorher = { z: zeitplaene.length, w: dynamicWachen.length, modus: state.mode };
    const faelle: [string, (req: never, res: never) => unknown, Record<string, unknown>][] = [
      ["auftraege", dashboard.auftraegeJson, {}],
      ["kosten", dashboard.kostenJson, {}],
      ["zeitplaene", dashboard.zeitplaeneJson, {}],
      ["zeitplan anlegen", dashboard.zeitplanAnlegen, { body: { name: "x", zeit: "07:00", tage: "taeglich", auftrag: "y" } }],
      ["zeitplan ändern", dashboard.zeitplanAendern, { params: { id: "1" }, body: {} }],
      ["zeitplan löschen", dashboard.zeitplanLoeschen, { params: { id: "1" } }],
      ["wachen", dashboard.wachenJson, {}],
      ["wache anlegen", dashboard.wacheAnlegen, { body: { kamera: "garten", frage: "x", alle_minuten: 10 } }],
      ["wache ändern", dashboard.wacheAendern, { params: { id: "1" }, body: {} }],
      ["wache löschen", dashboard.wacheLoeschen, { params: { id: "1" } }],
      ["modus", dashboard.modus, { body: { modus: "nacht" } }],
      ["auftrag", dashboard.auftragAction, { body: { id: 4, aktion: "nein" } }],
      ["finanzen", dashboard.finanzenJson, {}],
      ["audit", dashboard.auditTail, {}],
    ];
    for (const [name, h, teil] of faelle) {
      const r = await rufe(h, teil);
      assert.equal(r.statusCode, 423, name);
      assert.equal(r.body.ok, false, name);
      assert.equal(r.body.error, "notfall", name);
    }
    assert.deepEqual({ z: zeitplaene.length, w: dynamicWachen.length, modus: state.mode }, vorher);
    assert.equal(getAuftrag(4)?.status, "offen");
    // Ausnahmen: Status zeigt den Notfall, Notaus an bleibt möglich, aus nicht
    const status = await rufe(dashboard.statusJson);
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.notfall, true);
    assert.equal((await rufe(dashboard.notaus, { body: { an: true } })).statusCode, 200);
    const aus = await rufe(dashboard.notaus, { body: { an: false, pin: "4711" } });
    assert.equal(aus.statusCode, 423);
    assert.equal(aus.body.text, "Erst /entwarnung in Telegram, Sir.");
    assert.equal(state.paused, true);
  });
});

describe("GET /api/auftraege: Freigabe-Historie", () => {
  it("neueste zuerst, nie input, result geschwärzt und auf 300 Zeichen gekürzt", async () => {
    const r = await rufe(dashboard.auftraegeJson, { query: { status: "alle" } });
    assert.equal(r.statusCode, 200);
    const liste = r.body.auftraege as Record<string, unknown>[];
    assert.deepEqual(liste.map((a) => a.id), [...auftraege].map((a) => a.id).sort((x, y) => y - x));
    const roh = JSON.stringify(r.body);
    for (const geheim of ["GEHEIMER-MAILTEXT", "GEHEIMER-TERMIN", "lock.haustuer", "abcdefghijklmnop0123", "geheim123"]) assert.ok(!roh.includes(geheim), geheim);
    for (const a of liste) {
      assert.ok(!("input" in a), "nie input");
      assert.deepEqual(Object.keys(a).filter((k) => !["id", "createdAt", "tool", "stufe", "summary", "status", "gestartetAm", "result"].includes(k)), []);
    }
    const eins = liste.find((a) => a.id === 1)!;
    assert.equal(String(eins.result).length, 300);
    assert.match(String(eins.result), /Bearer <token>/);
    assert.equal(liste.find((a) => a.id === 4)!.gestartetAm, "2026-10-04T08:01:00.000Z");
    assert.equal(liste.find((a) => a.id === 3)!.summary, "Termin <img src=x onerror=alert(1)>", "Text bleibt Text, das UI setzt ihn per textContent");
  });

  it("Filter nach Status und Stufe, Limit 1..200, ungültiger Status 400", async () => {
    assert.deepEqual((await rufe(dashboard.auftraegeJson, { query: { status: "erledigt" } })).body.auftraege.map((a: { id: number }) => a.id), [1]);
    assert.deepEqual((await rufe(dashboard.auftraegeJson, { query: { stufe: "sensibel" } })).body.auftraege.map((a: { id: number }) => a.id), [2]);
    assert.equal((await rufe(dashboard.auftraegeJson, { query: { limit: "1" } })).body.auftraege.length, 1);
    assert.equal((await rufe(dashboard.auftraegeJson, { query: { limit: "0" } })).body.auftraege.length, 1, "unter 1 → 1");
    assert.equal((await rufe(dashboard.auftraegeJson, { query: { limit: "9999" } })).body.auftraege.length, 4, "über 200 → 200");
    const falsch = await rufe(dashboard.auftraegeJson, { query: { status: "<script>" } });
    assert.equal(falsch.statusCode, 400);
    assert.equal((await rufe(dashboard.auftraegeJson, { query: { stufe: "auto" } })).statusCode, 400);
  });
});

describe("Kosten: verbrauchVerlauf", () => {
  const v = (calls: number, input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({ calls, input, output, cacheRead, cacheWrite });
  const daten = {
    "2025-12-30": v(1, 1_000_000, 0, 0, 0),
    "2026-01-01": v(2, 0, 1_000_000, 0, 0),
    "2026-01-02": v(3, 0, 0, 1_000_000, 0),
    "2026-01-15": v(4, 0, 0, 0, 1_000_000),
    "2026-03-29": v(5),
    "2026-10-25": v(6),
  };

  it("lückenlos über Monats- und Jahresgrenze, älteste zuerst, fehlende Tage mit 0", () => {
    const r = verbrauchVerlauf(7, new Date("2026-01-02T11:00:00Z"), daten);
    assert.deepEqual(r.tage.map((t) => t.datum), ["2025-12-27", "2025-12-28", "2025-12-29", "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"]);
    assert.deepEqual(r.tage.map((t) => t.calls), [0, 0, 0, 1, 0, 2, 3]);
    assert.equal(r.heute.datum, "2026-01-02");
    assert.equal(r.tage[3]!.kostenUsd, 2, "1 Mio. Input zu 2 USD");
    assert.equal(r.tage[5]!.kostenUsd, 10);
    assert.equal(r.tage[6]!.kostenUsd, 0.2);
    // Monat = Kalendermonat von heute, auch Tage nach dem Zeitraum-Ende zählen nicht (nur bis heute vorhanden)
    assert.equal(r.monat.calls, 2 + 3 + 4);
    assert.equal(r.monat.kostenUsd, 10 + 0.2 + 2.5);
    assert.deepEqual(r.preise, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
    // cacheAnteil = cacheRead / (input + cacheRead + cacheWrite) im Zeitraum = 1 / (1 + 1 + 0)
    assert.equal(r.cacheAnteil, 0.5);
    assert.equal(r.tage[0]!.kostenUsd, kosten(v(0)));
  });

  it("Monatswechsel innerhalb des Zeitraums: Monat zählt nur den laufenden", () => {
    const r = verbrauchVerlauf(30, new Date("2026-01-20T12:00:00Z"), daten);
    assert.equal(r.tage.length, 30);
    assert.equal(r.tage[0]!.datum, "2025-12-22");
    assert.equal(r.monat.calls, 2 + 3 + 4);
  });

  it("Zeitzone Europe/Zurich: kurz nach Mitternacht gilt schon der neue Tag", () => {
    const r = verbrauchVerlauf(2, new Date("2025-12-31T23:30:00Z"), daten);
    assert.deepEqual(r.tage.map((t) => t.datum), ["2025-12-31", "2026-01-01"]);
    assert.equal(r.heute.calls, 2);
  });

  it("Sommerzeitwechsel (März und Oktober): kein Tag doppelt oder ausgelassen", () => {
    const maerz = verbrauchVerlauf(4, new Date("2026-03-30T22:30:00Z"), daten); // 31.3. 00:30 Zürich
    assert.deepEqual(maerz.tage.map((t) => t.datum), ["2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"]);
    assert.equal(maerz.tage[1]!.calls, 5);
    const oktober = verbrauchVerlauf(3, new Date("2026-10-26T06:00:00Z"), daten);
    assert.deepEqual(oktober.tage.map((t) => t.datum), ["2026-10-24", "2026-10-25", "2026-10-26"]);
    assert.equal(oktober.tage[1]!.calls, 6);
    const lang = verbrauchVerlauf(90, new Date("2026-11-15T12:00:00Z"), daten);
    assert.equal(new Set(lang.tage.map((t) => t.datum)).size, 90);
  });

  it("Grenzen: 1..90 Tage; ohne Verbrauch cacheAnteil 0", () => {
    assert.equal(verbrauchVerlauf(0, new Date("2026-01-02T12:00:00Z"), daten).tage.length, 1);
    assert.equal(verbrauchVerlauf(500, new Date("2026-01-02T12:00:00Z"), daten).tage.length, 90);
    assert.equal(verbrauchVerlauf(5, new Date("2027-06-01T12:00:00Z"), daten).cacheAnteil, 0);
  });

  it("GET /api/kosten: Standard 30 Tage bis heute, Parameter begrenzt", async () => {
    const r = await rufe(dashboard.kostenJson);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.tage.length, 30);
    assert.equal(r.body.heute.datum, todayKey(new Date()));
    for (const k of ["preise", "monat", "cacheAnteil"]) assert.ok(k in r.body, k);
    assert.equal((await rufe(dashboard.kostenJson, { query: { tage: "7" } })).body.tage.length, 7);
    assert.equal((await rufe(dashboard.kostenJson, { query: { tage: "500" } })).body.tage.length, 90);
    assert.equal((await rufe(dashboard.kostenJson, { query: { tage: "abc" } })).body.tage.length, 30);
  });
});

describe("pruefeZeitplan: Grenzwerte", () => {
  const gut = { name: "Morgen", zeit: "07:00", tage: "taeglich", auftrag: "Briefing" };
  const fehler = (aenderung: Record<string, unknown>) => {
    const p = pruefeZeitplan({ ...gut, ...aenderung });
    return p.ok ? [] : Object.keys(p.fehler);
  };

  it("name 1–60, auftrag 1–2000 (getrimmt)", () => {
    assert.deepEqual(fehler({ name: "" }), ["name"]);
    assert.deepEqual(fehler({ name: "   " }), ["name"]);
    assert.deepEqual(fehler({ name: "n".repeat(60) }), []);
    assert.deepEqual(fehler({ name: "n".repeat(61) }), ["name"]);
    assert.deepEqual(fehler({ auftrag: "a".repeat(2000) }), []);
    assert.deepEqual(fehler({ auftrag: "a".repeat(2001) }), ["auftrag"]);
    assert.deepEqual(fehler({ auftrag: "" }), ["auftrag"]);
    assert.deepEqual(fehler({ name: 5 }), ["name"]);
  });

  it("zeit HH:MM von 00:00 bis 23:59", () => {
    for (const z of ["00:00", "23:59", "07:05", "12:30"]) assert.deepEqual(fehler({ zeit: z }), [], z);
    for (const z of ["24:00", "7:00", "12:60", "12-30", "", "12:3", "ab:cd", "23:59:00"]) assert.deepEqual(fehler({ zeit: z }), ["zeit"], z);
  });

  it("tage: taeglich, werktags oder Wochentage ohne Doppel; normalisiert", () => {
    const wert = (tage: string) => { const p = pruefeZeitplan({ ...gut, tage }); return p.ok ? p.wert.tage : undefined; };
    assert.equal(wert("taeglich"), "taeglich");
    assert.equal(wert("Täglich"), "taeglich");
    assert.equal(wert("werktags"), "werktags");
    assert.equal(wert("Fr, Mo,mi"), "mo,mi,fr");
    assert.equal(wert("so"), "so");
    for (const t of ["mo,mo", "xy", "", "mo,", "mo;di", "montag", "taeglich,mo"]) assert.equal(wert(t), undefined, t);
  });

  it("Fehler je Feld auf Deutsch, alle auf einmal", () => {
    const p = pruefeZeitplan({});
    assert.equal(p.ok, false);
    if (!p.ok) {
      assert.deepEqual(Object.keys(p.fehler).sort(), ["auftrag", "name", "tage", "zeit"]);
      assert.match(p.fehler.zeit!, /HH:MM/);
      assert.match(p.fehler.name!, /Sir/);
    }
    assert.equal(pruefeZeitplan(null).ok, false);
  });

  it("das Werkzeug zeitplan_erstellen nutzt dieselben Regeln", async () => {
    const werkzeug = activeTools().find((t) => t.name === "zeitplan_erstellen")!;
    assert.equal(werkzeug.stufe, "extern", "Stufe bleibt extern");
    const ctx = { sendFile: async () => undefined, sendPhoto: async () => undefined, sendVideo: async () => undefined };
    await assert.rejects(werkzeug.run({ ...gut, zeit: "25:00" }, ctx), /HH:MM/);
    await assert.rejects(werkzeug.run({ ...gut, tage: "mo,mo" }, ctx), /Tage/);
    await assert.rejects(werkzeug.run({ ...gut, name: "n".repeat(61) }, ctx), /Name/);
    const vorher = zeitplaene.length;
    await werkzeug.run({ ...gut, tage: "Mo, Fr" }, ctx);
    assert.equal(zeitplaene.length, vorher + 1);
    assert.equal(zeitplaene.at(-1)!.tage, "mo,fr");
    zeitplaene.pop();
  });
});

describe("naechsterLauf", () => {
  // 9.10.2026 Freitag, 10. Samstag, 11. Sonntag, 12. Montag (lokale Zeit Europe/Zurich)
  const d = (tag: number, h: number, m = 0, monat = 9) => new Date(2026, monat, tag, h, m, 0, 0);
  const plan = (zeit: string, tage: string, mehr: Record<string, string> = {}) => ({ id: 1, name: "T", zeit, tage, auftrag: "x", ...mehr });

  it("heute noch vor uns: heute; schon vorbei: am nächsten passenden Tag", () => {
    assert.deepEqual(naechsterLauf(plan("08:30", "taeglich"), d(10, 8, 0)), d(10, 8, 30));
    assert.deepEqual(naechsterLauf(plan("08:30", "taeglich"), d(10, 9, 45), 60), d(11, 8, 30));
  });

  it("werktags über das Wochenende: Freitagabend und Samstag → Montag", () => {
    assert.deepEqual(naechsterLauf(plan("07:00", "werktags"), d(9, 18, 0)), d(12, 7, 0));
    assert.deepEqual(naechsterLauf(plan("07:00", "werktags"), d(10, 6, 0)), d(12, 7, 0));
    assert.deepEqual(naechsterLauf(plan("07:00", "werktags"), d(12, 6, 59)), d(12, 7, 0));
  });

  it("über Mitternacht: 00:15 nach 23:50 ist morgen", () => {
    assert.deepEqual(naechsterLauf(plan("00:15", "taeglich"), d(10, 23, 50)), d(11, 0, 15));
    assert.deepEqual(naechsterLauf(plan("23:59", "taeglich"), d(10, 23, 58)), d(10, 23, 59));
  });

  it("Wochentage-Liste: nächster passender Tag, auch eine Woche später", () => {
    assert.deepEqual(naechsterLauf(plan("10:00", "sa"), d(12, 9, 0)), d(17, 10, 0));
    assert.deepEqual(naechsterLauf(plan("10:00", "mo"), d(12, 11, 0)), d(19, 10, 0));
  });

  it("heute schon gelaufen oder heute zu spät angelegt: nicht heute", () => {
    const heute = todayKey(d(10, 8, 0));
    assert.deepEqual(naechsterLauf(plan("09:00", "taeglich", { lastRun: heute }), d(10, 8, 0)), d(11, 9, 0));
    assert.deepEqual(naechsterLauf(plan("07:00", "taeglich", { angelegt: d(10, 7, 20).toISOString() }), d(10, 7, 30), 60), d(11, 7, 0));
  });

  it("im Nachholfenster und noch nicht gelaufen: jetzt", () => {
    assert.deepEqual(naechsterLauf(plan("07:00", "taeglich"), d(10, 7, 20), 60), d(10, 7, 20));
  });

  it("Lokalzeit wie der Scheduler: über das Ende der Sommerzeit bleibt es 07:00 in Zürich", () => {
    const n = naechsterLauf(plan("07:00", "taeglich"), d(24, 8, 0));
    assert.equal(n?.toISOString(), "2026-10-25T06:00:00.000Z");
  });

  it("ungültige Uhrzeit oder Tage: undefined", () => {
    assert.equal(naechsterLauf(plan("25:00", "taeglich"), d(10, 8)), undefined);
    assert.equal(naechsterLauf(plan("abc", "taeglich"), d(10, 8)), undefined);
    assert.equal(naechsterLauf(plan("07:00", "nie"), d(10, 8)), undefined);
  });
});

describe("Zeitpläne über das Dashboard", () => {
  afterEach(() => { dashboard._dashboardUhr.jetzt = () => new Date(); });

  it("anlegen, ändern, löschen mit Audit (quelle dashboard); kein sofortiges Nachholen", async () => {
    zeitplaene.length = 0;
    const jetzt = new Date(2026, 9, 10, 7, 20, 0, 0); // Samstag
    dashboard._dashboardUhr.jetzt = () => jetzt;
    const neu = await rufe(dashboard.zeitplanAnlegen, { body: { name: " Morgen ", zeit: "07:00", tage: "taeglich", auftrag: "Briefing vorbereiten" } });
    assert.equal(neu.statusCode, 201);
    assert.equal(neu.body.zeitplan.name, "Morgen");
    const z = zeitplaene.at(-1)!;
    assert.equal(z.angelegt, jetzt.toISOString());
    assert.equal(faelligIm(z, new Date(2026, 9, 10, 7, 21), 60), false, "07:00 ist heute vorbei: nicht nachholen");
    assert.equal(neu.body.zeitplan.naechsterLauf, new Date(2026, 9, 11, 7, 0).toISOString());
    assert.ok(JSON.parse(readFileSync(join(temp, "data", "zeitplaene.json"), "utf8")).some((x: { id: number }) => x.id === z.id), "gespeichert");

    // Ändern: neue Uhrzeit heute schon vorbei → auch nicht sofort
    const spaeter = new Date(2026, 9, 10, 9, 0, 0, 0);
    dashboard._dashboardUhr.jetzt = () => spaeter;
    const geaendert = await rufe(dashboard.zeitplanAendern, { params: { id: String(z.id) }, body: { name: "Morgen", zeit: "08:30", tage: "taeglich", auftrag: "Briefing" } });
    assert.equal(geaendert.statusCode, 200);
    assert.equal(z.zeit, "08:30");
    assert.equal(faelligIm(z, new Date(2026, 9, 10, 9, 1), 60), false, "geänderte, schon vergangene Zeit wird nicht nachgeholt");
    assert.equal(faelligIm(z, new Date(2026, 9, 11, 8, 30), 60), true, "morgen wie gewohnt");

    // Ändern auf eine heute noch kommende Uhrzeit: läuft heute
    await rufe(dashboard.zeitplanAendern, { params: { id: String(z.id) }, body: { name: "Morgen", zeit: "18:00", tage: "taeglich", auftrag: "Briefing" } });
    assert.equal(faelligIm(z, new Date(2026, 9, 10, 18, 0), 60), true);

    // Nur Name/Auftrag geändert: Anlagezeit bleibt (ein offener Nachholer darf weiter laufen)
    const angelegt = z.angelegt;
    dashboard._dashboardUhr.jetzt = () => new Date(2026, 9, 10, 19, 0);
    await rufe(dashboard.zeitplanAendern, { params: { id: String(z.id) }, body: { name: "Abend", zeit: "18:00", tage: "taeglich", auftrag: "Rückblick" } });
    assert.equal(z.angelegt, angelegt);
    assert.equal(z.name, "Abend");

    const liste = await rufe(dashboard.zeitplaeneJson);
    assert.equal(liste.body.zeitplaene.length, 1);
    for (const k of ["id", "name", "zeit", "tage", "auftrag", "angelegt", "naechsterLauf"]) assert.ok(k in liste.body.zeitplaene[0], k);

    const weg = await rufe(dashboard.zeitplanLoeschen, { params: { id: String(z.id) } });
    assert.equal(weg.statusCode, 200);
    assert.equal(zeitplaene.length, 0);

    const ereignisse = auditZeilen().filter((e) => String(e.event).startsWith("zeitplan_"));
    assert.deepEqual(ereignisse.map((e) => e.event), ["zeitplan_angelegt", "zeitplan_geaendert", "zeitplan_geaendert", "zeitplan_geaendert", "zeitplan_geloescht"]);
    assert.ok(ereignisse.every((e) => e.quelle === "dashboard"));
  });

  it("Prüfregeln im Server: 400 mit Fehlern je Feld, nichts gespeichert; unbekannte ID 404", async () => {
    zeitplaene.length = 0;
    const r = await rufe(dashboard.zeitplanAnlegen, { body: { name: "", zeit: "24:00", tage: "mo,mo", auftrag: "a".repeat(2001) } });
    assert.equal(r.statusCode, 400);
    assert.deepEqual(Object.keys(r.body.fehler).sort(), ["auftrag", "name", "tage", "zeit"]);
    assert.equal(zeitplaene.length, 0);
    assert.equal((await rufe(dashboard.zeitplanAendern, { params: { id: "99" }, body: { name: "x", zeit: "07:00", tage: "taeglich", auftrag: "y" } })).statusCode, 404);
    assert.equal((await rufe(dashboard.zeitplanLoeschen, { params: { id: "abc" } })).statusCode, 404);
    await rufe(dashboard.zeitplanAnlegen, { body: { name: "x", zeit: "07:00", tage: "taeglich", auftrag: "y" } });
    const id = String(zeitplaene.at(-1)!.id);
    const falsch = await rufe(dashboard.zeitplanAendern, { params: { id }, body: { name: "x", zeit: "7:00", tage: "taeglich", auftrag: "y" } });
    assert.equal(falsch.statusCode, 400);
    assert.equal(zeitplaene.at(-1)!.zeit, "07:00", "ungültige Änderung ändert nichts");
    zeitplaene.length = 0;
  });
});

describe("pruefeWache: Grenzwerte", () => {
  const gut = { kamera: "garten", frage: "Ist das Tor offen?", alle_minuten: 10 };
  const fehler = (aenderung: Record<string, unknown>) => {
    const p = pruefeWache({ ...gut, ...aenderung });
    return p.ok ? [] : Object.keys(p.fehler);
  };

  it("kamera muss in cameras.json stehen", () => {
    assert.deepEqual(fehler({ kamera: "einfahrt" }), []);
    for (const k of ["keller", "", "__proto__", "toString", 5]) assert.deepEqual(fehler({ kamera: k }), ["kamera"], String(k));
  });

  it("frage 1–300, alle_minuten 5–1440 ganzzahlig", () => {
    assert.deepEqual(fehler({ frage: "f".repeat(300) }), []);
    assert.deepEqual(fehler({ frage: "f".repeat(301) }), ["frage"]);
    assert.deepEqual(fehler({ frage: " " }), ["frage"]);
    for (const n of [5, 1440, "10"]) assert.deepEqual(fehler({ alle_minuten: n }), [], String(n));
    for (const n of [4, 1441, 0, -5, 7.5, "", "zehn", null, undefined]) assert.deepEqual(fehler({ alle_minuten: n }), ["alle_minuten"], String(n));
  });

  it("nur_wenn immer|abwesend|nacht (Standard immer), ruhe_minuten 0–1440 optional", () => {
    const p = pruefeWache(gut);
    assert.ok(p.ok && p.wert.nur_wenn === "immer" && !("ruhe_minuten" in p.wert));
    for (const b of ["immer", "abwesend", "nacht"]) assert.deepEqual(fehler({ nur_wenn: b }), [], b);
    assert.deepEqual(fehler({ nur_wenn: "tags" }), ["nur_wenn"]);
    for (const r of [0, 1440]) assert.deepEqual(fehler({ ruhe_minuten: r }), [], String(r));
    for (const r of [-1, 1441, 2.5]) assert.deepEqual(fehler({ ruhe_minuten: r }), ["ruhe_minuten"], String(r));
  });

  it("das Werkzeug wache_erstellen nutzt dieselben Regeln (Stufe bleibt extern)", async () => {
    const werkzeug = activeTools().find((t) => t.name === "wache_erstellen")!;
    assert.equal(werkzeug.stufe, "extern");
    const ctx = { sendFile: async () => undefined, sendPhoto: async () => undefined, sendVideo: async () => undefined };
    await assert.rejects(werkzeug.run({ ...gut, alle_minuten: 2 }, ctx), /Intervall/);
    await assert.rejects(werkzeug.run({ ...gut, kamera: "keller" }, ctx), /Kamera/);
    await assert.rejects(werkzeug.run({ ...gut, nur_wenn: "immerzu" }, ctx), /Bedingung/);
    const vorher = dynamicWachen.length;
    await werkzeug.run({ ...gut, ruhe_minuten: 0 }, ctx);
    assert.equal(dynamicWachen.length, vorher + 1);
    assert.equal(dynamicWachen.at(-1)!.quelle, "chat");
    assert.equal(dynamicWachen.at(-1)!.ruhe_minuten, 0);
    dynamicWachen.pop();
  });
});

describe("Wachen über das Dashboard", () => {
  it("Liste mit Quellen; cameras.json-Wachen ohne ID und nicht änderbar; Hinweis zur Datensparsamkeit", async () => {
    const r = await rufe(dashboard.wachenJson);
    assert.equal(r.statusCode, 200);
    assert.match(r.body.hinweis, /Standbilder an die Claude-API/);
    assert.deepEqual(r.body.kameras, Object.keys(cameras));
    const ausDatei = r.body.wachen.find((w: { quelle: string }) => w.quelle === "cameras.json");
    assert.deepEqual(ausDatei, { kamera: "einfahrt", frage: "Tor offen?", alle_minuten: 15, nur_wenn: "immer", quelle: "cameras.json", bearbeitbar: false });
  });

  it("anlegen, ändern, löschen nur für dynamische Wachen, mit Audit", async () => {
    dynamicWachen.length = 0;
    const neu = await rufe(dashboard.wacheAnlegen, { body: { kamera: "garten", frage: "Person im Garten?", alle_minuten: 30, nur_wenn: "nacht", ruhe_minuten: 60 } });
    assert.equal(neu.statusCode, 201);
    assert.match(neu.body.hinweis, /Claude-API/);
    assert.deepEqual(neu.body.wache, { id: 1, kamera: "garten", frage: "Person im Garten?", alle_minuten: 30, nur_wenn: "nacht", ruhe_minuten: 60, quelle: "dashboard", bearbeitbar: true });
    const geaendert = await rufe(dashboard.wacheAendern, { params: { id: "1" }, body: { kamera: "einfahrt", frage: "Tor offen?", alle_minuten: 5 } });
    assert.equal(geaendert.statusCode, 200);
    assert.deepEqual(dynamicWachen[0], { id: 1, kamera: "einfahrt", frage: "Tor offen?", alle_minuten: 5, nur_wenn: "immer", quelle: "dashboard" });
    const falsch = await rufe(dashboard.wacheAendern, { params: { id: "1" }, body: { kamera: "einfahrt", frage: "Tor offen?", alle_minuten: 4 } });
    assert.equal(falsch.statusCode, 400);
    assert.deepEqual(Object.keys(falsch.body.fehler), ["alle_minuten"]);
    assert.equal(dynamicWachen[0]!.alle_minuten, 5, "ungültige Änderung ändert nichts");
    assert.deepEqual(JSON.parse(readFileSync(join(temp, "data", "wachen.json"), "utf8")), dynamicWachen);
    assert.equal((await rufe(dashboard.wacheLoeschen, { params: { id: "1" } })).statusCode, 200);
    assert.equal(dynamicWachen.length, 0);
    const ereignisse = auditZeilen().filter((e) => String(e.event).startsWith("wache_"));
    assert.deepEqual(ereignisse.map((e) => e.event), ["wache_angelegt", "wache_geaendert", "wache_geloescht"]);
    assert.ok(ereignisse.every((e) => e.quelle === "dashboard"));
  });

  it("Wachen aus cameras.json lassen sich weder ändern noch löschen", async () => {
    dynamicWachen.length = 0;
    for (const id of ["0", "1", "undefined", "einfahrt"]) {
      assert.equal((await rufe(dashboard.wacheAendern, { params: { id }, body: { kamera: "einfahrt", frage: "x", alle_minuten: 10 } })).statusCode, 404, id);
      assert.equal((await rufe(dashboard.wacheLoeschen, { params: { id } })).statusCode, 404, id);
    }
    assert.equal(cameras.einfahrt!.wachen!.length, 1);
    const fehler = await rufe(dashboard.wacheAnlegen, { body: { kamera: "keller", frage: "", alle_minuten: 1441 } });
    assert.equal(fehler.statusCode, 400);
    assert.deepEqual(Object.keys(fehler.body.fehler).sort(), ["alle_minuten", "frage", "kamera"]);
    assert.equal(dynamicWachen.length, 0);
  });
});

describe("Notaus über das Dashboard", () => {
  afterEach(() => { setzePinUhr(); config.pin = "4711"; });

  it("an ohne PIN: pausiert, Audit quelle dashboard, Meldung an Telegram", async () => {
    const r = await rufe(dashboard.notaus, { body: { an: true } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.pausiert, true);
    assert.equal(state.paused, true);
    await ruhe();
    assert.ok(telegram.includes("⛔ Notaus über die Kommandozentrale."));
    assert.ok(auditZeilen().some((e) => e.event === "pause" && e.quelle === "dashboard"));
    assert.equal((await rufe(dashboard.notaus, { body: {} })).statusCode, 400);
    assert.equal((await rufe(dashboard.notaus, { body: { an: "ja" } })).statusCode, 400);
  });

  it("aus nur mit gültiger PIN; ohne PIN 400, falsche 403, richtige hebt auf", async () => {
    state.paused = true;
    assert.equal((await rufe(dashboard.notaus, { body: { an: false } })).statusCode, 400);
    assert.equal(state.paused, true);
    const falsch = await rufe(dashboard.notaus, { body: { an: false, pin: "0000" } });
    assert.equal(falsch.statusCode, 403);
    assert.equal(state.paused, true);
    await ruhe();
    assert.ok(telegram.some((t) => t.startsWith("⚠️ Falsche PIN in der Kommandozentrale")));
    const eintrag = auditZeilen().filter((e) => e.event === "pin_falsch").at(-1)!;
    assert.equal(eintrag.quelle, "dashboard");
    assert.ok(!JSON.stringify(auditZeilen()).includes("0000"), "die PIN steht nie im Audit");
    telegram = [];
    const richtig = await rufe(dashboard.notaus, { body: { an: false, pin: "4711" } });
    assert.equal(richtig.statusCode, 200);
    assert.equal(state.paused, false);
    await ruhe();
    assert.ok(telegram.includes("▶️ Weiter über die Kommandozentrale."));
    assert.ok(auditZeilen().some((e) => e.event === "weiter" && e.quelle === "dashboard"));
    // ohne Notaus: nichts zu tun, keine PIN-Prüfung
    assert.equal((await rufe(dashboard.notaus, { body: { an: false, pin: "falsch" } })).body.pausiert, false);
  });

  it("ohne JARVIS_PIN: 409 mit Hinweis, Notaus bleibt", async () => {
    state.paused = true;
    config.pin = undefined;
    const r = await rufe(dashboard.notaus, { body: { an: false, pin: "4711" } });
    assert.equal(r.statusCode, 409);
    assert.equal(r.body.text, "Ohne JARVIS_PIN hebe ich den Notaus nur in Telegram auf, Sir.");
    assert.equal(state.paused, true);
  });

  it("Sperre: nach 3 Fehlversuchen 10 Minuten 429, auch für die richtige PIN und sensible Freigaben (Zeit injiziert)", async () => {
    let jetzt = Date.parse("2026-10-11T10:00:00Z");
    setzePinUhr(() => jetzt);
    state.paused = true;
    for (let i = 0; i < 3; i++) {
      jetzt += 1000;
      assert.equal((await rufe(dashboard.notaus, { body: { an: false, pin: `000${i}` } })).statusCode, 403);
    }
    jetzt += 1000;
    const gesperrt = await rufe(dashboard.notaus, { body: { an: false, pin: "4711" } });
    assert.equal(gesperrt.statusCode, 429);
    assert.match(gesperrt.body.text, /Zu viele falsche PIN-Eingaben, Sir\. .* in 10 Minuten/);
    assert.equal(state.paused, true);
    assert.ok(auditZeilen().some((e) => e.event === "pin_sperre" && e.quelle === "dashboard"));

    // Sensibler Auftrag während der Sperre: abgewiesen, aber nicht abgelehnt
    state.paused = false;
    const a = createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "x" }, stufe: "sensibel", summary: "sensibel" });
    const freigabe = await rufe(dashboard.auftragAction, { body: { id: a.id, aktion: "ok", pin: "4711" } });
    assert.equal(freigabe.statusCode, 429);
    assert.equal(getAuftrag(a.id)?.status, "offen");
    const { approveAuftrag } = await import("../src/telegram.js");
    assert.match(await approveAuftrag(a, "4711"), /Zu viele falsche PIN-Eingaben/);
    assert.equal(getAuftrag(a.id)?.status, "offen", "die Sperre lehnt den Auftrag nicht ab");
    state.paused = true;

    jetzt += 9 * 60_000;
    assert.equal((await rufe(dashboard.notaus, { body: { an: false, pin: "4711" } })).statusCode, 429, "nach 9 Minuten noch gesperrt");
    jetzt += 60_000;
    const wieder = await rufe(dashboard.notaus, { body: { an: false, pin: "4711" } });
    assert.equal(wieder.statusCode, 200, "nach 10 Minuten wieder offen");
    assert.equal(state.paused, false);
    assert.equal(state.notfall?.aktiv, false, "drei Fehlversuche lösen noch keinen Notfall aus");
    a.status = "abgelehnt";
  });

  it("Reihenfolge: ein vor dem Dashboard-Notaus eingereihtes Telegram-/weiter hebt ihn nicht auf", async () => {
    const nachricht = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, text } });
    const orig = abhaengigkeiten.handleMessage;
    let freigeben!: () => void;
    const haengt = new Promise<void>((r) => { freigeben = r; });
    let gestartet = false;
    abhaengigkeiten.handleMessage = async () => { gestartet = true; await haengt; return "fertig"; };
    try {
      const laeufe = [verteileUpdate(nachricht(5001, "Frage"))];
      for (let i = 0; i < 100 && !gestartet; i++) await new Promise((r) => setImmediate(r));
      assert.equal(gestartet, true);
      laeufe.push(verteileUpdate(nachricht(5002, "/weiter"))); // eingereiht, wartet hinter der Frage
      assert.equal((await rufe(dashboard.notaus, { body: { an: true } })).statusCode, 200);
      freigeben();
      await Promise.all(laeufe);
      assert.equal(state.paused, true, "das ältere /weiter gilt nicht");
      assert.ok(telegram.includes("/weiter kam vor dem Notaus an und gilt nicht, Sir. Bitte erneut senden."));
      // ein danach getipptes /weiter gilt wie gewohnt
      await verteileUpdate(nachricht(5003, "/weiter"));
      assert.equal(state.paused, false);
      assert.ok(telegram.includes("▶️ Weiter geht's."));
    } finally {
      abhaengigkeiten.handleMessage = orig;
    }
  });
});

describe("POST /api/notfall", () => {
  it("ohne Bestätigung 400; mit Bestätigung ausgelöst, Audit quelle dashboard; zweiter Aufruf ohne zweiten Alarm", async () => {
    assert.equal((await rufe(dashboard.notfallAusloesen, { body: {} })).statusCode, 400);
    assert.equal((await rufe(dashboard.notfallAusloesen, { body: { bestaetigt: "ja" } })).statusCode, 400);
    assert.equal(state.notfall?.aktiv, false);
    const r = await rufe(dashboard.notfallAusloesen, { body: { bestaetigt: true } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ok, true);
    assert.equal(state.notfall?.aktiv, true);
    assert.equal(state.paused, true);
    assert.equal(state.notfall?.grund, "Über die Kommandozentrale ausgelöst.");
    assert.ok(auditZeilen().some((e) => e.event === "notfall_ausgeloest" && e.quelle === "dashboard"));
    const zweiter = await rufe(dashboard.notfallAusloesen, { body: { bestaetigt: true } });
    assert.deepEqual([zweiter.statusCode, zweiter.body.ok, zweiter.body.schon], [200, true, true]);
    await ruhe();
    assert.equal(telegram.filter((t) => t.startsWith("🚨 NOTFALL ausgelöst")).length, 1, "genau ein Alarm");
  });
});

describe("GET /api/audit", () => {
  it("liefert lines und geparste Einträge; kaputte Zeilen übersprungen, Info geschwärzt und gekürzt", async () => {
    const r = await rufe(dashboard.auditTail);
    assert.equal(r.statusCode, 200);
    assert.ok(Array.isArray(r.body.lines));
    const e = r.body.eintraege as { zeit: string; ereignis: string; info: string }[];
    assert.ok(e.length >= 3);
    assert.ok(e.every((x) => typeof x.zeit === "string" && typeof x.ereignis === "string" && typeof x.info === "string"));
    assert.ok(!e.some((x) => x.ereignis === "ohne_zeit"));
    const werkzeug = e.find((x) => x.ereignis === "werkzeug")!;
    assert.match(werkzeug.info, /token=<geheim>/);
    assert.ok(!JSON.stringify(e).includes("geheim123"));
    assert.equal(e.find((x) => x.ereignis === "lang")!.info.length, 160);
    // neueste zuerst
    assert.ok(e[0]!.zeit >= e[e.length - 1]!.zeit);
  });
});

// ---------- Teil 2: Verdrahtung in server.ts über HTTP ----------

describe("server.ts: Routen der Kommandozentrale über HTTP", () => {
  const temp2 = mkdtempSync(join(tmpdir(), "jarvis-dashboard-http-"));
  const attrappe = join(temp2, "fetch-attrappe.mjs");
  writeFileSync(attrappe, 'globalThis.fetch = async () => { throw new Error("kein Netz im Test"); };\n');
  mkdirSync(join(temp2, "data"), { recursive: true });
  writeFileSync(join(temp2, "cameras.json"), JSON.stringify({ garten: { frigate: "garten", beschreibung: "Garten" } }));
  let kind: ChildProcess | undefined;
  let port = 0;
  let ausgabe = "";

  interface HttpAntwort { status: number; text: string; kopf: Record<string, string | string[] | undefined> }
  const http = (methode: string, pfad: string, kopf: Record<string, string> = {}, inhalt?: unknown) =>
    new Promise<HttpAntwort>((ok, fehler) => {
      const r = request({ host: "127.0.0.1", port, method: methode, path: pfad, headers: { "content-type": "application/json", ...kopf } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (text += d));
        res.on("end", () => ok({ status: res.statusCode ?? 0, text, kopf: res.headers }));
      });
      r.on("error", fehler);
      r.end(inhalt === undefined ? undefined : JSON.stringify(inhalt));
    });
  const mitToken = { authorization: `Bearer ${TOKEN}` };

  before(async () => {
    port = await new Promise<number>((ok, fehler) => {
      const s = createServer();
      s.once("error", fehler);
      s.listen(0, "127.0.0.1", () => {
        const a = s.address();
        const p = typeof a === "object" && a ? a.port : 0;
        s.close(() => ok(p));
      });
    });
    kind = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(attrappe).href, join(projekt, "src/server.ts")], {
      cwd: temp2,
      env: { PATH: process.env.PATH ?? "", HOME: temp2, PORT: String(port), LISTEN_HOST: "127.0.0.1", JARVIS_EVENT_TOKEN: TOKEN, JARVIS_PIN: "4711" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    kind.stdout?.on("data", (d: Buffer) => (ausgabe += d.toString()));
    kind.stderr?.on("data", (d: Buffer) => (ausgabe += d.toString()));
    await new Promise<void>((ok, fehler) => {
      const warte = setInterval(() => {
        if (!ausgabe.includes("Jarvis läuft")) return;
        clearInterval(warte);
        clearTimeout(frist);
        ok();
      }, 20);
      const frist = setTimeout(() => { clearInterval(warte); fehler(new Error(`Server nicht gestartet:\n${ausgabe}`)); }, 4500);
      kind!.once("exit", (code) => { clearInterval(warte); clearTimeout(frist); fehler(new Error(`Server beendet (${code}):\n${ausgabe}`)); });
    });
  });

  after(() => {
    kind?.removeAllListeners("exit");
    kind?.kill("SIGKILL");
    rmSync(temp2, { recursive: true, force: true });
  });

  const datenRouten: [string, string, unknown?][] = [
    ["GET", "/api/auftraege"], ["GET", "/api/kosten"], ["GET", "/api/zeitplaene"], ["POST", "/api/zeitplaene", { name: "x", zeit: "07:00", tage: "taeglich", auftrag: "y" }],
    ["PUT", "/api/zeitplaene/1", {}], ["DELETE", "/api/zeitplaene/1"], ["GET", "/api/wachen"], ["POST", "/api/wachen", { kamera: "garten", frage: "x", alle_minuten: 10 }],
    ["PUT", "/api/wachen/1", {}], ["DELETE", "/api/wachen/1"], ["POST", "/api/chat", { text: "Hallo" }], ["POST", "/api/modus", { modus: "nacht" }],
    ["POST", "/api/auftrag", { id: 1, aktion: "nein" }], ["GET", "/api/audit"], ["GET", "/api/finanzen"], ["GET", "/api/kamera/garten"],
    ["POST", "/api/protokoll", { name: "x" }], ["GET", "/api/geraete"],
  ];

  it("Auth: ohne Token, mit falschem Token und mit Query-Token 401", async () => {
    for (const [methode, pfad, inhalt] of [...datenRouten, ["POST", "/api/notaus", { an: true }], ["POST", "/api/notfall", { bestaetigt: true }], ["GET", "/status.json"]] as [string, string, unknown?][]) {
      assert.equal((await http(methode, pfad, {}, inhalt)).status, 401, `${methode} ${pfad} ohne Token`);
      assert.equal((await http(methode, pfad, { authorization: "Bearer falsch" }, inhalt)).status, 401, `${methode} ${pfad} falsch`);
      const trenner = pfad.includes("?") ? "&" : "?";
      assert.equal((await http(methode, `${pfad}${trenner}token=${TOKEN}`, {}, inhalt)).status, 401, `${methode} ${pfad} Query-Token`);
    }
    const r = await http("GET", "/api/kosten?tage=7", mitToken);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).tage.length, 7);
    assert.equal(r.kopf["cache-control"], "no-store");
  });

  it("/dashboard/app.js und app.css nur hinter lanOnly, mit CSP", async () => {
    for (const pfad of ["/dashboard/app.js", "/dashboard/app.css", "/dashboard"]) {
      assert.equal((await http("GET", pfad, { "cf-connecting-ip": "203.0.113.7" })).status, 404, pfad);
      assert.equal((await http("GET", pfad, { "cf-ray": "8a1b2c3d4e5f-ZRH" })).status, 404, pfad);
      const r = await http("GET", pfad);
      assert.equal(r.status, 200, pfad);
      assert.match(String(r.kopf["content-security-policy"]), /^default-src 'none'; script-src 'self'; style-src 'self';/);
    }
  });

  it("Ablauf: anlegen über HTTP, Prüfung 400, dann Notfall → 423 überall, Ausnahmen offen", async () => {
    const neu = await http("POST", "/api/zeitplaene", mitToken, { name: "Morgen", zeit: "07:00", tage: "werktags", auftrag: "Briefing" });
    assert.equal(neu.status, 201);
    const falsch = await http("POST", "/api/wachen", mitToken, { kamera: "keller", frage: "x", alle_minuten: 2 });
    assert.equal(falsch.status, 400);
    assert.deepEqual(Object.keys(JSON.parse(falsch.text).fehler).sort(), ["alle_minuten", "kamera"]);
    assert.equal((await http("POST", "/api/notfall", mitToken, {})).status, 400);

    const ausgeloest = await http("POST", "/api/notfall", mitToken, { bestaetigt: true });
    assert.equal(ausgeloest.status, 200);
    for (const [methode, pfad, inhalt] of datenRouten) {
      const r = await http(methode, pfad, mitToken, inhalt);
      assert.equal(r.status, 423, `${methode} ${pfad}`);
      assert.equal(JSON.parse(r.text).error, "notfall", `${methode} ${pfad}`);
    }
    const status = await http("GET", "/status.json", mitToken);
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.text).notfall, true);
    assert.equal((await http("POST", "/api/notaus", mitToken, { an: true })).status, 200);
    const aus = await http("POST", "/api/notaus", mitToken, { an: false, pin: "4711" });
    assert.equal(aus.status, 423);
    assert.equal(JSON.parse(aus.text).text, "Erst /entwarnung in Telegram, Sir.");
    const nochmal = await http("POST", "/api/notfall", mitToken, { bestaetigt: true });
    assert.deepEqual(JSON.parse(nochmal.text), { ok: true, schon: true, text: "🚨 Der Notfall läuft bereits, Sir." });
  });
});
