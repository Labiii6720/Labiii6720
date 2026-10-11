import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/, cameras.json liegen relativ) und Umgebung; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-dashboard-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.FRIGATE_URL = "http://frigate.attrappe";
process.env.RUECKBLICK = "off";
process.env.RECHNUNG_ERINNERUNG = "off";
process.env.ZIELCHECK = "off";
process.env.VERDICHTUNG = "off";

mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "routinen.json"), "{}");
writeFileSync(join(temp, "cameras.json"), JSON.stringify({ einfahrt: { frigate: "einfahrt", beschreibung: "Einfahrt vorne" } }));
writeFileSync(join(temp, "data", "audit.log"), '{"ts":"2026-10-11T08:00:00.000Z","art":"geheimer_eintrag"}\n');

/** Netz-Attrappe: Frigate liefert ein Bild, Telegram nimmt an; alles andere ist ein Fehler */
let aufrufe: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  aufrufe.push(url);
  // Wie Node/undici bei einer URL mit Zugangsdaten (FRIGATE_URL=http://user:pw@…)
  if (/^\w+:\/\/[^/@\s]+@/.test(url)) throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`);
  if (url.startsWith("http://frigate.attrappe/")) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { "content-type": "image/jpeg" } });
  if (url.startsWith("https://api.telegram.org/bot")) return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
  throw new Error(`unerwarteter Netzaufruf: ${url}`);
}) as typeof fetch;

const { statusJson, kameraBild, auditTail, geraete, protokollAction } = await import("../src/dashboard.js");
const { protokolle } = await import("../src/protokolle.js");
const { reminders } = await import("../src/tools.js");
const { rechnungen } = await import("../src/finanzen.js");
const { profil } = await import("../src/profil.js");
const { auftraege, createAuftrag } = await import("../src/queue.js");
const { state } = await import("../src/state.js");
const { config } = await import("../src/config.js");
const { _testOptionen } = await import("../src/cameras.js");
_testOptionen.warten = async () => undefined;
_testOptionen.zufall = () => 0;

type Req = Parameters<typeof statusJson>[0];
type Res = Parameters<typeof statusJson>[1];

function antwort() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    send(b: unknown) { this.body = b; return this; },
    set(k: string, v: string) { this.headers[k] = v; return this; },
    end() { return this; },
  };
}
const req = (teil: Record<string, unknown> = {}) => ({ params: {}, query: {}, ...teil }) as unknown as Req;

const NOTFALL = () => ({ aktiv: true, seit: new Date().toISOString(), grund: "Test" });

rechnungen.push({ id: 1, erkanntAm: "2026-10-01T09:00:00.000Z", empfaenger: "Swisscom", betrag: 89.5, waehrung: "CHF", faellig: "2026-10-20", status: "offen" });
profil.ziele.push({ id: 1, text: "Geheimes Ziel", status: "offen", angelegt: "2026-10-01" });
profil.werte.push("Geheimer Wert");
createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "Mail an Bank: vertraulicher Text" });

beforeEach(() => {
  aufrufe = [];
  state.paused = false;
  state.notfall = { aktiv: false };
});

describe("Dashboard im Notfall", () => {
  it("ohne Notfall liefert /status.json die Daten wie bisher", () => {
    const res = antwort();
    statusJson(req(), res as unknown as Res);
    const roh = JSON.stringify(res.body);
    for (const text of ["Swisscom", "Geheimes Ziel", "Geheimer Wert", "vertraulicher Text", "Einfahrt vorne"]) assert.ok(roh.includes(text), `${text} fehlt`);
  });

  it("/status.json gibt im Notfall nur den Zustand heraus, Listen leer", () => {
    state.notfall = NOTFALL();
    state.paused = true;
    const res = antwort();
    statusJson(req(), res as unknown as Res);
    const b = res.body as Record<string, unknown>;
    assert.equal(res.statusCode, 200);
    assert.equal(b.ok, true);
    assert.equal(b.notfall, true);
    assert.equal(b.pausiert, true);
    assert.equal(b.offeneAuftraege, 1);
    for (const feld of ["auftraege", "rechnungen", "vorgaenge", "zeitplaene", "wachen", "kameras", "protokolle", "ziele", "werte"]) assert.deepEqual(b[feld], [], `${feld} muss leer sein`);
    assert.ok("gesundheit" in b);
    const roh = JSON.stringify(b);
    for (const text of ["Swisscom", "89.5", "2026-10-20", "Geheimes Ziel", "Geheimer Wert", "vertraulicher Text", "Einfahrt vorne"]) assert.ok(!roh.includes(text), `${text} gehört im Notfall nicht ins Dashboard`);
  });

  it("/api/kamera liefert ohne Notfall ein Bild", async () => {
    const res = antwort();
    await kameraBild(req({ params: { name: "einfahrt" } }) as never, res as never);
    assert.equal(res.statusCode, 200);
    assert.ok(aufrufe.some((u) => u.startsWith("http://frigate.attrappe/")));
  });

  it("/api/kamera schwärzt Zugangsdaten im 502-Fehlertext", async () => {
    const vorher = config.frigateUrl;
    config.frigateUrl = "http://jarvis:GeheimesFrigatePw@frigate.attrappe";
    try {
      const res = antwort();
      await kameraBild(req({ params: { name: "einfahrt" } }) as never, res as never);
      assert.equal(res.statusCode, 502);
      const roh = JSON.stringify(res.body);
      assert.ok(!roh.includes("GeheimesFrigatePw"), "Passwort gehört nicht ins Dashboard");
      assert.ok(!roh.includes("jarvis:"), "Benutzer samt Passwort geschwärzt");
      assert.match(roh, /<geheim>@frigate\.attrappe/);
    } finally {
      config.frigateUrl = vorher;
    }
  });

  it("/api/kamera ist im Notfall gesperrt und fragt Frigate nicht an", async () => {
    state.notfall = NOTFALL();
    const res = antwort();
    await kameraBild(req({ params: { name: "einfahrt" } }) as never, res as never);
    assert.equal(res.statusCode, 423);
    assert.equal((res.body as { error?: string }).error, "notfall");
    assert.deepEqual(aufrufe, []);
  });

  it("/api/audit ist im Notfall gesperrt", () => {
    state.notfall = NOTFALL();
    const res = antwort();
    auditTail(req(), res as unknown as Res);
    assert.equal(res.statusCode, 423);
    assert.deepEqual((res.body as { lines?: unknown }).lines, []);
    assert.ok(!JSON.stringify(res.body).includes("geheimer_eintrag"));
  });

  it("/api/geraete ist im Notfall gesperrt und fragt nichts an", async () => {
    state.notfall = NOTFALL();
    const res = antwort();
    await geraete(req() as never, res as never);
    assert.equal(res.statusCode, 423);
    assert.equal((res.body as { error?: string }).error, "notfall");
    assert.deepEqual(aufrufe, []);
  });
});

describe("Dashboard /api/protokoll im Notaus und Notfall", () => {
  it("antwortet mit 423, führt nichts aus und legt keinen Auftrag an", async () => {
    const zeit = new Date(Date.now() + 3_600_000).toISOString();
    protokolle["testauto"] = { beschreibung: "Test", stufe: "auto", schritte: [{ tool: "erinnerung", input: { zeit, text: "Protokoll" } }] };
    protokolle["testextern"] = { beschreibung: "Test", stufe: "extern", schritte: [{ tool: "erinnerung", input: { zeit, text: "Protokoll" } }] };
    try {
      for (const sperre of [() => { state.paused = true; }, () => { state.notfall = NOTFALL(); }]) {
        for (const name of ["testauto", "testextern"]) {
          state.paused = false;
          state.notfall = { aktiv: false };
          sperre();
          const vorher = auftraege.length;
          const res = antwort();
          await protokollAction(req({ body: { name } }) as never, res as never);
          assert.equal(res.statusCode, 423, `${name} hätte gesperrt sein müssen`);
          assert.equal((res.body as { ok?: boolean }).ok, false);
          assert.equal(auftraege.length, vorher, "kein Auftrag im Notaus/Notfall");
          assert.equal(reminders.length, 0, "kein Werkzeug lief");
          assert.deepEqual(aufrufe, []);
        }
      }
    } finally {
      delete protokolle["testauto"];
      delete protokolle["testextern"];
    }
  });
});
