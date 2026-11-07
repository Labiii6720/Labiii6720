import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Start mit von Hand verdorbenen Listen in data/: gültiges JSON, aber einzelne Einträge sind keine gültigen Einträge
// (null, Zahl, Text, fehlende Pflichtfelder, falsche Typen). Der Import darf nicht werfen, die gültigen Einträge laufen,
// und jede betroffene Datei erscheint mit Anzahl (nie Inhalt) in Startmeldung, /status und npm run check.
const temp = mkdtempSync(join(tmpdir(), "jarvis-listen-eintraege-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.FRIGATE_URL = "http://127.0.0.1:9";
process.env.ANTHROPIC_API_KEY = "sk-ant-attrappe-nur-fuer-tests";

const gesendet: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  if (body.text !== undefined) gesendet.push(body.text);
  return new Response(JSON.stringify({ ok: true, result: { message_id: gesendet.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const ZEITPLAN = { id: 1, name: "geheim-zeitplan", zeit: "07:00", tage: "taeglich", auftrag: "geheim-auftrag" };
const WACHE = { id: 1, kamera: "einfahrt", frage: "geheim-wache?", alle_minuten: 10 };
const ZUKUNFT = { at: "2099-01-01T08:00:00.000Z", text: "geheim-zukunft" };
const FAELLIG = { at: "2020-01-01T08:00:00.000Z", text: "geheim-faellig" };
const VORGANG = { id: 7, auftrag: "geheim-vorgang", status: "fertig", startedAt: "2026-10-10T08:00:00.000Z", steps: 3 };
const POST = { ts: "2026-10-11T06:00:00.000Z", text: "geheim-postausgang" };

const LISTEN: Record<string, { name: string; inhalt: unknown[]; verworfen: number }> = {
  "zeitplaene.json": { name: "Zeitpläne", inhalt: [ZEITPLAN, null, { id: 2, name: "geheim-ohne-auftrag", zeit: "08:00", tage: "mo" }], verworfen: 2 },
  "wachen.json": { name: "Wachen", inhalt: [WACHE, 5, { id: 2, kamera: "einfahrt", alle_minuten: 5 }], verworfen: 2 },
  "erinnerungen.json": { name: "Erinnerungen", inhalt: [ZUKUNFT, FAELLIG, { at: "morgen", text: "geheim-kaputt" }, "geheim-text"], verworfen: 2 },
  "vorgaenge.json": { name: "Vorgänge", inhalt: [VORGANG, { id: 8, status: "fertig" }, null], verworfen: 2 },
  "postausgang.json": { name: "Postausgang", inhalt: [POST, { ts: "kaputt", text: "geheim-ts" }, 3], verworfen: 2 },
};
const ORIGINAL: Record<string, string> = {};
mkdirSync(join(temp, "data"), { recursive: true });
for (const [datei, l] of Object.entries(LISTEN)) {
  ORIGINAL[datei] = JSON.stringify(l.inhalt, null, 2);
  writeFileSync(join(temp, "data", datei), ORIGINAL[datei]!);
}
writeFileSync(join(temp, "cameras.json"), JSON.stringify({ einfahrt: { frigate: "einfahrt", beschreibung: "Einfahrt" } }));

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const telegram = await import("../src/telegram.js");
const tools = await import("../src/tools.js");
const zeitplanMod = await import("../src/zeitplaene.js");
const vorgangMod = await import("../src/vorgaenge.js");
const kameras = await import("../src/cameras.js");
const { statusJson } = await import("../src/dashboard.js");
const { selbsttest } = await import("../src/check.js");
console.error = origErr;

telegram.setzeWarten(async () => {}, () => 0.5, async () => {});
const ctx = { sendFile: async () => {}, sendPhoto: async () => {}, sendVideo: async () => {} };
const werkzeug = (name: string) => {
  const t = tools.toolByName(name);
  assert.ok(t, `Werkzeug ${name} fehlt`);
  return t;
};
const lies = (datei: string): unknown => JSON.parse(readFileSync(join(temp, "data", datei), "utf8"));
const ohneGeheimes = (texte: string[]) => assert.ok(!texte.some((t) => t.includes("geheim")), texte.filter((t) => t.includes("geheim")).join("\n"));

describe("Listen in data/ mit ungültigen Einträgen beim Start", () => {
  it("Import wirft nicht, keine Datei gesperrt, die gültigen Einträge sind geladen", () => {
    assert.equal(zeitplanMod.zeitplaeneNichtGeladen, false);
    assert.equal(kameras.wachenNichtGeladen, false);
    assert.equal(tools.erinnerungenNichtGeladen, false);
    assert.equal(vorgangMod.vorgaengeNichtGeladen, false);
    assert.equal(telegram.postausgangNichtGeladen, false);
    assert.deepEqual(zeitplanMod.zeitplaene, [ZEITPLAN]);
    assert.deepEqual(kameras.dynamicWachen, [WACHE]);
    assert.deepEqual(tools.reminders, [ZUKUNFT, FAELLIG]);
    assert.deepEqual(vorgangMod.vorgaenge, [VORGANG]);
  });

  it("jede Datei ist vor jeder Änderung gesichert (600), das Log nennt nur Name und Anzahl", () => {
    for (const [datei, l] of Object.entries(LISTEN)) {
      const sicherung = join(temp, "data", `${datei}.defekt`);
      assert.equal(readFileSync(sicherung, "utf8"), ORIGINAL[datei], datei);
      assert.equal(statSync(sicherung).mode & 0o777, 0o600);
      assert.ok(fehler.some((f) => f.startsWith(`${l.name}: ${l.verworfen} ungültige Einträge übersprungen (Sicherung unter data/${datei}.defekt)`)), `${datei}\n${fehler.join("\n")}`);
      assert.equal(readFileSync(join(temp, "data", datei), "utf8"), ORIGINAL[datei], "beim Start bleibt die Datei unverändert");
    }
    ohneGeheimes(fehler);
  });

  it("dateiHinweise nennt jede Datei mit Anzahl und Sicherung; die Startmeldung schickt genau diese, ohne Inhalt", async () => {
    const hinweise = telegram.dateiHinweise();
    for (const [datei, l] of Object.entries(LISTEN)) {
      assert.ok(hinweise.some((h) => h.startsWith(`⚠️ data/${datei}: ${l.verworfen} ungültige Einträge beim Start übersprungen, Sir (Sicherung unter data/${datei}.defekt)`)), datei);
    }
    assert.equal(hinweise.length, Object.keys(LISTEN).length, "keine Unlesbar-Hinweise, kein Hinweis für die gültige cameras.json");
    gesendet.length = 0;
    await telegram.dateiHinweiseMelden();
    assert.deepEqual(gesendet, hinweise);
    ohneGeheimes(gesendet);
  });

  it("/status zeigt die Hinweise", async () => {
    gesendet.length = 0;
    await telegram.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 12345 }, text: "/status" } });
    assert.equal(gesendet.length, 1);
    for (const datei of Object.keys(LISTEN)) assert.ok(gesendet[0]!.includes(`data/${datei}: 2 ungültige Einträge`), datei);
    assert.match(gesendet[0]!, /Erinnerungen: 2\n/);
    ohneGeheimes(gesendet);
  });

  it("npm run check: Befund «Listen» nennt jede Datei mit Anzahl", async () => {
    const [b] = await selbsttest(["Listen"]);
    assert.equal(b?.status, "fehler");
    assert.equal(b!.info, "ungültig: Zeitpläne 2, Wachen 2, Erinnerungen 2, Vorgänge 2, Postausgang 2; Sicherung je .defekt");
    assert.doesNotMatch(b!.info, /geheim/);
  });

  it("die Nutzer laufen: Anzeigen, Vorgänge und /status.json ohne Absturz und ohne «undefined»", async () => {
    const texte = [
      String(await werkzeug("zeitplaene_anzeigen").run({}, ctx)),
      String(await werkzeug("wachen_anzeigen").run({}, ctx)),
      vorgangMod.listVorgaenge(),
    ];
    for (const t of texte) assert.doesNotMatch(t, /undefined/);
    assert.match(texte[0]!, /^#1 geheim-zeitplan · taeglich 07:00 · geheim-auftrag$/);
    assert.match(texte[1]!, /^#1 einfahrt · alle 10 min · geheim-wache\? · immer$/);
    assert.match(texte[2]!, /^#7 fertig · 3 Schritte · geheim-vorgang$/);
    const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    statusJson({ params: {}, query: {} } as never, res as never);
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.body as { vorgaenge: { id: number }[] }).vorgaenge.map((v) => v.id), [7]);
  });

  it("Postausgang: der gültige Eintrag wird nachgereicht, danach ist die Datei leer, die Sicherung bleibt", async () => {
    gesendet.length = 0;
    await telegram.postausgangTick();
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0]!, /^\(nachgereicht, \d{2}:\d{2}\) geheim-postausgang$/);
    assert.deepEqual(lies("postausgang.json"), []);
    assert.equal(readFileSync(join(temp, "data", "postausgang.json.defekt"), "utf8"), ORIGINAL["postausgang.json"]);
  });

  it("Erinnerungen: die fällige kommt, Speichern behält die übrige gültige", async () => {
    gesendet.length = 0;
    await telegram.remindersTick();
    assert.deepEqual(gesendet, ["⏰ geheim-faellig"]);
    assert.deepEqual(lies("erinnerungen.json"), [ZUKUNFT]);
    // Anlegen bleibt erlaubt
    await werkzeug("erinnerung").run({ zeit: "2099-02-01T08:00:00Z", text: "neu" }, ctx);
    assert.deepEqual(lies("erinnerungen.json"), [ZUKUNFT, { at: "2099-02-01T08:00:00.000Z", text: "neu" }]);
    assert.equal(readFileSync(join(temp, "data", "erinnerungen.json.defekt"), "utf8"), ORIGINAL["erinnerungen.json"]);
  });

  it("Zeitpläne und Wachen: Speichern bleibt erlaubt und behält die gültigen", () => {
    zeitplanMod.saveZeitplaene();
    assert.deepEqual(lies("zeitplaene.json"), [ZEITPLAN]);
    kameras.saveWachen();
    assert.deepEqual(lies("wachen.json"), [WACHE]);
    for (const datei of ["zeitplaene.json", "wachen.json"]) {
      assert.equal(readFileSync(join(temp, "data", `${datei}.defekt`), "utf8"), ORIGINAL[datei], "die Sicherung bewahrt die verworfenen");
    }
    // Neue IDs überspringen auch die verworfenen: höchste Nummer in der Datei (verworfene eingeschlossen) + 1
    assert.equal(zeitplanMod.neueZeitplanId(), 3);
    assert.equal(kameras.neueWacheId(), 3);
  });
});
