import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Die Lader laufen nur einmal beim Import: hier mit abgeschnittenen Listen wie nach einem Stromausfall auf der SD-Karte
const temp = mkdtempSync(join(tmpdir(), "jarvis-listen-defekt-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.FRIGATE_URL = "http://127.0.0.1:9";
process.env.ANTHROPIC_API_KEY = "sk-ant-attrappe-nur-fuer-tests";

let telegramStoert = false;
const gesendet: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  if (telegramStoert) return new Response(JSON.stringify({ ok: false, error_code: 502, description: "Bad Gateway" }), { status: 502 });
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  gesendet.push(body.text ?? "");
  return new Response(JSON.stringify({ ok: true, result: { message_id: gesendet.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const KAPUTT: Record<string, string> = {
  "wachen.json": '[{"id": 1, "kamera": "einfahrt", "frage": "geheim-wache", "alle_min',
  "zeitplaene.json": '[{"id": 1, "name": "geheim-zeitplan", "zeit": "07:00", "tage": "taeglich", "auf',
  "erinnerungen.json": '[{"at": "2026-10-12T08:00:00.000Z", "text": "geheim-erinnerung"',
  "vorgaenge.json": '[{"id": 7, "auftrag": "geheim-vorgang", "status": "fertig", "startedAt": "2026-10-',
  "postausgang.json": '[{"ts": "2026-10-11T06:00:00.000Z", "text": "geheim-postausgang"',
};
mkdirSync(join(temp, "data"), { recursive: true });
for (const [datei, inhalt] of Object.entries(KAPUTT)) writeFileSync(join(temp, "data", datei), inhalt);
// gültige cameras.json, damit die Kamera-Werkzeuge aktiv sind; ihre Wache läuft weiter
writeFileSync(join(temp, "cameras.json"), JSON.stringify({ einfahrt: { frigate: "einfahrt", beschreibung: "Einfahrt", wachen: [{ frage: "Tor offen?", alle_minuten: 10 }] } }));

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const telegram = await import("../src/telegram.js");
const tools = await import("../src/tools.js");
const zeitplanMod = await import("../src/zeitplaene.js");
const vorgangMod = await import("../src/vorgaenge.js");
const kameras = await import("../src/cameras.js");
const { selbsttest } = await import("../src/check.js");
console.error = origErr;

telegram.setzeWarten(async () => {}, () => 0.5, async () => {});
const ctx = { sendFile: async () => {}, sendPhoto: async () => {}, sendVideo: async () => {} };
const werkzeug = (name: string) => {
  const t = tools.toolByName(name);
  assert.ok(t, `Werkzeug ${name} fehlt`);
  return t;
};
const unveraendert = () => {
  for (const [datei, inhalt] of Object.entries(KAPUTT)) assert.equal(readFileSync(join(temp, "data", datei), "utf8"), inhalt, datei);
};

describe("abgeschnittene Listen in data/", () => {
  it("jede Datei wird nach .defekt gesichert (600), das Log nennt keinen Inhalt", () => {
    for (const [datei, inhalt] of Object.entries(KAPUTT)) {
      const sicherung = join(temp, "data", `${datei}.defekt`);
      assert.ok(existsSync(sicherung), sicherung);
      assert.equal(readFileSync(sicherung, "utf8"), inhalt);
      assert.equal(statSync(sicherung).mode & 0o777, 0o600);
    }
    assert.ok(!fehler.some((f) => f.includes("geheim")), "kein Dateiinhalt im Log");
    for (const name of ["Zeitpläne", "Erinnerungen", "Vorgänge", "Postausgang"]) assert.ok(fehler.some((f) => f.startsWith(`${name} unlesbar`)), name);
  });

  it("alle Flags gesetzt, Listen leer", () => {
    assert.equal(zeitplanMod.zeitplaeneNichtGeladen, true);
    assert.equal(tools.erinnerungenNichtGeladen, true);
    assert.equal(vorgangMod.vorgaengeNichtGeladen, true);
    assert.equal(telegram.postausgangNichtGeladen, true);
    assert.equal(kameras.wachenNichtGeladen, true);
    assert.equal(zeitplanMod.zeitplaene.length + tools.reminders.length + vorgangMod.vorgaenge.length, 0);
  });

  it("Zeitpläne: Anlegen und Löschen verweigert, Anzeige sagt es, Speichern wirft", async () => {
    await assert.rejects(werkzeug("zeitplan_erstellen").run({ name: "x", zeit: "07:00", tage: "taeglich", auftrag: "y" }, ctx), /unlesbar/);
    await assert.rejects(werkzeug("zeitplan_loeschen").run({ id: 1 }, ctx), /unlesbar/);
    assert.equal(zeitplanMod.zeitplaene.length, 0);
    assert.equal(await werkzeug("zeitplaene_anzeigen").run({}, ctx), zeitplanMod.ZEITPLAENE_UNLESBAR);
    assert.throws(() => zeitplanMod.saveZeitplaene(), /unlesbar/);
    unveraendert();
  });

  it("Erinnerungen: Anlegen verweigert, nichts im Speicher, Speichern wirft", async () => {
    await assert.rejects(werkzeug("erinnerung").run({ zeit: "2026-10-12T08:00:00Z", text: "x" }, ctx), /unlesbar/);
    assert.equal(tools.reminders.length, 0);
    assert.throws(() => tools.saveReminders(), /unlesbar/);
    unveraendert();
  });

  it("Wachen: erstellen und löschen prüfen vor der Änderung im Speicher, Anzeige warnt zuerst", async () => {
    await assert.rejects(werkzeug("wache_erstellen").run({ kamera: "einfahrt", frage: "Person?", alle_minuten: 5 }, ctx), /unlesbar/);
    assert.equal(kameras.dynamicWachen.length, 0);
    await assert.rejects(werkzeug("wache_loeschen").run({ id: 1 }, ctx), /unlesbar/);
    const anzeige = String(await werkzeug("wachen_anzeigen").run({}, ctx));
    assert.ok(anzeige.startsWith(kameras.WACHEN_UNLESBAR), anzeige);
    assert.ok(anzeige.includes("Tor offen?"));
    unveraendert();
  });

  it("Vorgänge: kein Start, Liste nennt den Grund", () => {
    assert.throws(() => vorgangMod.startVorgang("x", telegram.hooks), /unlesbar/);
    assert.equal(vorgangMod.vorgaenge.length, 0);
    assert.equal(vorgangMod.listVorgaenge(), vorgangMod.VORGAENGE_UNLESBAR);
    unveraendert();
  });

  it("Postausgang: bei Störung bleibt die Meldung im Speicher, die Datei unberührt, später nachgereicht", async () => {
    telegramStoert = true;
    try {
      await telegram.sendeSpaeter("Hausmeldung");
    } finally {
      telegramStoert = false;
    }
    unveraendert();
    gesendet.length = 0;
    await telegram.postausgangTick();
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0]!, /^\(nachgereicht, \d{2}:\d{2}\) Hausmeldung$/);
    unveraendert();
  });

  it("Startmeldung nennt jede betroffene Datei, ohne Inhalt; /check meldet die Wachen als Fehler", async () => {
    const hinweise = telegram.dateiHinweise();
    for (const h of [kameras.WACHEN_UNLESBAR, zeitplanMod.ZEITPLAENE_UNLESBAR, tools.ERINNERUNGEN_UNLESBAR, vorgangMod.VORGAENGE_UNLESBAR, telegram.POSTAUSGANG_UNLESBAR]) assert.ok(hinweise.includes(h));
    gesendet.length = 0;
    await telegram.dateiHinweiseMelden();
    assert.deepEqual(gesendet, hinweise);
    assert.ok(!gesendet.some((t) => t.includes("geheim")));

    const [befund] = await selbsttest(["Wachen"]);
    assert.equal(befund!.status, "fehler");
    assert.match(befund!.info, /wachen\.json unlesbar/);
  });
});
