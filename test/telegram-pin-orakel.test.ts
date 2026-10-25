import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Befund: Ohne wartende Abfrage bekam die richtige PIN eine andere Antwort als eine falsche, ohne Zählung. So liess sich
// die PIN über ein übernommenes Konto durchprobieren. Dazu: eine vertippte PIN nach Ablauf der Frist ging an Claude.
const temp = mkdtempSync(join(tmpdir(), "jarvis-telegram-pin-orakel-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
process.env.STT_URL = "https://stt.invalid/v1/audio/transcriptions";

let aufrufe: { method: string; text?: string }[] = [];
/** Was die Spracherkennung liefert; jeder Aufruf dort wird gezählt */
let sttText = "";
let sttAufrufe = 0;
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (url.startsWith("https://stt.invalid/")) {
    sttAufrufe++;
    return new Response(JSON.stringify({ text: sttText }), { headers: { "content-type": "application/json" } });
  }
  if (url.startsWith("https://api.telegram.org/file/")) return new Response(new Uint8Array([1, 2, 3]));
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  const method = url.split("/").pop() ?? "";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  aufrufe.push({ method, text: body.text });
  const result = method === "getFile" ? { file_path: "voice/a.oga" } : { message_id: aufrufe.length };
  return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { abhaengigkeiten, denyAuftrag, handleUpdate, postausgangTick, setzeWarten } = await import("../src/telegram.js");
const { createAuftrag, getAuftrag } = await import("../src/queue.js");
const { reminders } = await import("../src/tools.js");
const { state } = await import("../src/state.js");
const { config } = await import("../src/config.js");
const { missbrauchZuruecksetzen } = await import("../src/notfall.js");

const AUDIT = join(temp, "data", "audit.log");
const missbrauch = () => (existsSync(AUDIT) ? readFileSync(AUDIT, "utf8").split("\n").filter((z) => z.includes('"event":"abuse_signal"')).length : 0);
let nr = 1000;
const nachricht = (text: string) => ({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, text } });
const sprache = () => ({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, voice: { file_id: "datei", duration: 3 } } });
const knopfOk = (id: number) => handleUpdate({ update_id: ++nr, callback_query: { id: "cb", data: `ok:${id}`, from: { id: 12345 } } });
const sensibel = () => createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "PIN" }, stufe: "sensibel", summary: "sensibel" });
const gesendet = () => aufrufe.filter((x) => x.method === "sendMessage").map((x) => x.text ?? "");
const geloescht = () => aufrufe.filter((x) => x.method === "deleteMessage").length;
const ruhe = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); await postausgangTick(); };

/** Eine Eingabe ohne wartende Abfrage: was kam zurück, wurde gelöscht, ging sie an Claude? */
async function antwortAuf(text: string): Promise<{ antwort: string[]; geloescht: number; claude: string[] }> {
  aufrufe = [];
  claude = [];
  await handleUpdate(nachricht(text));
  return { antwort: gesendet(), geloescht: geloescht(), claude };
}

const origNow = Date.now;
const origHandle = abhaengigkeiten.handleMessage;
const origPin = config.pin;
let claude: string[] = [];
beforeEach(() => {
  setzeWarten(async () => {}, () => 0.5);
  missbrauchZuruecksetzen();
  claude = [];
  sttAufrufe = 0;
  abhaengigkeiten.handleMessage = async (text: string) => { claude.push(text); return "Gern, Sir."; };
});
afterEach(async () => {
  Date.now = origNow;
  abhaengigkeiten.handleMessage = origHandle;
  config.pin = origPin;
  reminders.splice(0, reminders.length);
  await ruhe();
  state.notfall = { aktiv: false };
  state.paused = false;
  missbrauchZuruecksetzen();
});

describe("PIN ohne wartende Abfrage: die Antwort verrät nicht, welche Eingabe stimmt", () => {
  it("richtige und falsche PIN: dieselbe Antwort, beide gelöscht, keine an Claude", async () => {
    const richtig = await antwortAuf("4711");
    const falsch = await antwortAuf("4712");
    assert.deepEqual(richtig, falsch);
    assert.deepEqual(falsch.antwort, ["Keine Freigabe wartet auf eine PIN, Sir. Nachricht gelöscht."]);
    assert.equal(falsch.geloescht, 1);
    assert.deepEqual(falsch.claude, []);
    // auch andere Längen derselben Art
    assert.deepEqual(await antwortAuf("000000"), richtig);
  });

  it("getippt mit Satzzeichen am Ende («4711.», «4712!», «4711?»): dieselbe Antwort, gelöscht, nie an Claude, gezählt", async () => {
    const richtig = await antwortAuf("4711");
    const vorher = missbrauch();
    for (const t of ["4711.", "4712!", "4711?"]) assert.deepEqual(await antwortAuf(t), richtig, t);
    assert.equal(missbrauch() - vorher, 3);
    assert.ok(!existsSync(join(temp, "data", "chat.json")) || !readFileSync(join(temp, "data", "chat.json"), "utf8").includes("4711"));
  });

  it("fünf PIN-Versuche über den Chat lösen den Notfall aus, auch wenn der letzte stimmt", async () => {
    const vorher = missbrauch();
    for (const versuch of ["0000", "0001", "0002", "0003"]) await antwortAuf(versuch);
    assert.equal(missbrauch() - vorher, 4);
    assert.notEqual(state.notfall?.aktiv, true);
    await antwortAuf("4711");
    assert.equal(missbrauch() - vorher, 5);
    assert.equal(state.notfall?.aktiv, true);
    assert.equal(state.paused, true);
  });

  it("Sätze und kurze Wörter laufen weiter an Claude, ohne Zählung", async () => {
    const vorher = missbrauch();
    for (const t of ["Wie wird das Wetter morgen?", "Danke", "ok", "Termin um 14 Uhr?"]) {
      const r = await antwortAuf(t);
      assert.equal(r.geloescht, 0, t);
      assert.deepEqual(r.claude, [t]);
    }
    assert.equal(missbrauch(), vorher);
  });

  it("nach einer Entscheidung anderswo: richtige und vertippte PIN gleich beantwortet und gezählt", async () => {
    const vorher = missbrauch();
    const ergebnisse: string[][] = [];
    let id = 0;
    for (const pin of ["4711", "4712"]) {
      const a = sensibel();
      id = a.id;
      await knopfOk(a.id);
      await denyAuftrag(getAuftrag(a.id)!);
      await ruhe();
      const r = await antwortAuf(pin);
      assert.equal(r.geloescht, 1);
      assert.deepEqual(r.claude, []);
      ergebnisse.push(r.antwort.map((t) => t.replace(`#${a.id}`, "#N")));
    }
    assert.deepEqual(ergebnisse[0], ergebnisse[1]);
    assert.deepEqual(ergebnisse[1], ["#N ist nicht mehr offen, Sir. Nachricht gelöscht."]);
    assert.ok(id > 0);
    assert.equal(missbrauch() - vorher, 2);
  });

  it("gesprochen: richtige und falsche PIN gleich, kein Echo, nie an Claude, gezählt", async () => {
    const vorher = missbrauch();
    const antworten: string[][] = [];
    for (const pin of ["4711", "4712", "4713."]) {
      sttText = ` ${pin} `;
      aufrufe = [];
      claude = [];
      await handleUpdate(sprache());
      assert.equal(geloescht(), 1, pin);
      assert.ok(!gesendet().some((t) => t.startsWith("🎙")), "kein Echo");
      assert.deepEqual(claude, []);
      antworten.push(gesendet());
    }
    assert.deepEqual(antworten[0], ["Die PIN bitte tippen, Sir, nie sprechen. Sprachnachricht gelöscht."]);
    assert.deepEqual(antworten[1], antworten[0]);
    assert.deepEqual(antworten[2], antworten[0]);
    assert.equal(missbrauch() - vorher, 3);
  });

  it("PIN ohne Ziffern: gleiche Antwort für PIN-förmige Wörter, aber kein Notfall durch fünfmal «Danke»", async () => {
    config.pin = "geheim";
    const richtig = await antwortAuf("geheim");
    const falsch = await antwortAuf("Danke");
    assert.deepEqual(richtig, falsch);
    const vorher = missbrauch();
    for (let i = 0; i < 5; i++) await antwortAuf("Danke");
    assert.equal(missbrauch(), vorher);
    assert.notEqual(state.notfall?.aktiv, true);
    // Zahlen gehen bei einer solchen PIN weiter an Claude
    assert.deepEqual((await antwortAuf("2026")).claude, ["2026"]);
  });
});

describe("PIN-Abfrage abgelaufen: eine verspätete, vertippte PIN geht nicht an Claude", () => {
  it("nach 2:10 Minuten «4721»: gelöscht, nicht an Claude, nicht in chat.json, Auftrag bleibt offen", async () => {
    const a = sensibel();
    const start = origNow();
    Date.now = () => start;
    await knopfOk(a.id);
    Date.now = () => start + 130_000;
    const r = await antwortAuf("4721");
    assert.equal(r.geloescht, 1);
    assert.deepEqual(r.claude, []);
    assert.deepEqual(r.antwort, [`Zeit abgelaufen. /auftraege zeigt #${a.id} nochmal.`]);
    assert.ok(!existsSync(join(temp, "data", "chat.json")) || !readFileSync(join(temp, "data", "chat.json"), "utf8").includes("4721"));
    assert.equal(getAuftrag(a.id)?.status, "offen");
    assert.equal(reminders.length, 0);
  });

  it("abgelaufen: richtige und vertippte PIN bekommen dieselbe Antwort", async () => {
    const antworten: string[][] = [];
    for (const pin of ["4711", "4721"]) {
      const a = sensibel();
      const start = origNow();
      Date.now = () => start;
      await knopfOk(a.id);
      Date.now = () => start + 130_000;
      const r = await antwortAuf(pin);
      assert.equal(getAuftrag(a.id)?.status, "offen", "nichts ausgeführt");
      antworten.push(r.antwort.map((t) => t.replace(`#${a.id}`, "#N")));
    }
    assert.deepEqual(antworten[0], antworten[1]);
  });

  it("abgelaufen und dann eine Sprachnachricht: gelöscht, nicht zum STT-Anbieter", async () => {
    const a = sensibel();
    const start = origNow();
    Date.now = () => start;
    await knopfOk(a.id);
    Date.now = () => start + 130_000;
    sttText = "4721";
    aufrufe = [];
    await handleUpdate(sprache());
    assert.equal(sttAufrufe, 0);
    assert.ok(!aufrufe.some((x) => x.method === "getFile"));
    assert.equal(geloescht(), 1);
    assert.deepEqual(claude, []);
    assert.deepEqual(gesendet(), [`Zeit abgelaufen, Sir. Sprachnachricht gelöscht; die PIN bitte nie sprechen. /auftraege zeigt #${a.id} nochmal.`]);
  });

  it("abgelaufen: ein ganzer Satz geht weiter an Claude, nur die nächste Nachricht zählt", async () => {
    const a = sensibel();
    const start = origNow();
    Date.now = () => start;
    await knopfOk(a.id);
    Date.now = () => start + 130_000;
    assert.deepEqual((await antwortAuf("Wie wird das Wetter?")).claude, ["Wie wird das Wetter?"]);
    assert.deepEqual((await antwortAuf("Danke")).claude, ["Danke"]);
  });

  it("im Dashboard bei 1:55 entschieden: die vertippte PIN zehn Sekunden später ist noch geschützt", async () => {
    const a = sensibel();
    const start = origNow();
    Date.now = () => start;
    await knopfOk(a.id);
    Date.now = () => start + 115_000;
    await denyAuftrag(getAuftrag(a.id)!);
    await ruhe();
    Date.now = () => start + 125_000;
    const r = await antwortAuf("4721");
    assert.equal(r.geloescht, 1);
    assert.deepEqual(r.claude, []);
    assert.deepEqual(r.antwort, [`#${a.id} ist nicht mehr offen, Sir. Nachricht gelöscht.`]);
  });

  it("der Schutz gilt zwei Minuten ab Ablauf: Stunden später geht auch ein kurzes Wort wieder an Claude", async () => {
    const a = sensibel();
    const start = origNow();
    Date.now = () => start;
    await knopfOk(a.id);
    Date.now = () => start + 3 * 60 * 60_000;
    assert.deepEqual((await antwortAuf("Danke")).claude, ["Danke"]);
    assert.equal(getAuftrag(a.id)?.status, "offen");
  });
});
