import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Befund: Telegram-Knopf «Freigeben» (sensibel) wartet auf die PIN, entschieden wird dann im Dashboard. Die wartende
// PIN-Abfrage darf danach die nächste Chat-Nachricht weder löschen noch verschlucken.
const temp = mkdtempSync(join(tmpdir(), "jarvis-telegram-pin-anderswo-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
process.env.STT_URL = "https://stt.invalid/v1/audio/transcriptions";

let aufrufe: { method: string; text?: string }[] = [];
/** Aufrufe ausserhalb der Bot-API (Sprachdatei laden, STT-Anbieter): dürfen bei verfallener PIN-Abfrage nie kommen */
let fremd: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (!url.startsWith("https://api.telegram.org/bot")) {
    fremd.push(url);
    return new Response("nein", { status: 400 });
  }
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  aufrufe.push({ method: url.split("/").pop() ?? "", text: body.text });
  return new Response(JSON.stringify({ ok: true, result: { message_id: aufrufe.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { abhaengigkeiten, approveAuftrag, denyAuftrag, handleUpdate, postausgangTick, setzeWarten } = await import("../src/telegram.js");
const { createAuftrag, getAuftrag } = await import("../src/queue.js");
const { reminders } = await import("../src/tools.js");
const { missbrauchZuruecksetzen } = await import("../src/notfall.js");

const nachricht = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, text } });
const knopfOk = (id: number) => handleUpdate({ update_id: 1, callback_query: { id: "cb", data: `ok:${id}`, from: { id: 12345 } } });
const knopfNein = (id: number) => handleUpdate({ update_id: 2, callback_query: { id: "cb", data: `nein:${id}`, from: { id: 12345 } } });
const sprache = (id: number) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, voice: { file_id: "datei", duration: 3 } } });
const sensibel = () => createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "PIN" }, stufe: "sensibel", summary: "sensibel" });
const gesendet = () => aufrufe.filter((x) => x.method === "sendMessage").map((x) => x.text ?? "");
const geloescht = () => aufrufe.some((x) => x.method === "deleteMessage");
/** Meldungen ohne Warten (void sendeSpaeter) zustellen lassen */
const ruhe = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); await postausgangTick(); };

const origHandle = abhaengigkeiten.handleMessage;
let claude: string[] = [];
beforeEach(() => {
  setzeWarten(async () => {}, () => 0.5);
  missbrauchZuruecksetzen();
  claude = [];
  fremd = [];
  abhaengigkeiten.handleMessage = async (text: string) => { claude.push(text); return "Sonnig, Sir."; };
});
afterEach(async () => {
  abhaengigkeiten.handleMessage = origHandle;
  reminders.splice(0, reminders.length);
  await ruhe();
});

describe("PIN-Abfrage, wenn der Auftrag anderswo entschieden wurde", () => {
  it("im Dashboard abgelehnt: der nächste Satz geht an Claude und wird nicht gelöscht", async () => {
    const a = sensibel();
    await knopfOk(a.id);
    assert.equal(await denyAuftrag(getAuftrag(a.id)!), `❌ #${a.id} abgelehnt.`);
    await ruhe();
    aufrufe = [];
    await handleUpdate(nachricht(101, "Wie wird das Wetter morgen?"));
    assert.equal(geloescht(), false);
    assert.deepEqual(claude, ["Wie wird das Wetter morgen?"]);
    assert.ok(!gesendet().includes("Dieser Auftrag ist nicht mehr offen."));
  });

  it("im Dashboard mit PIN freigegeben: der nächste Satz geht an Claude", async () => {
    const a = sensibel();
    await knopfOk(a.id);
    assert.match(await approveAuftrag(getAuftrag(a.id)!, "4711"), new RegExp(`^✅ #${a.id} erledigt`));
    await ruhe();
    aufrufe = [];
    await handleUpdate(nachricht(102, "Wie wird das Wetter morgen?"));
    assert.equal(geloescht(), false);
    assert.deepEqual(claude, ["Wie wird das Wetter morgen?"]);
  });

  it("im Dashboard mit falscher PIN abgelehnt: der nächste Satz geht an Claude", async () => {
    const a = sensibel();
    await knopfOk(a.id);
    assert.equal(await approveAuftrag(getAuftrag(a.id)!, "0000"), `Falsche PIN. #${a.id} abgelehnt.`);
    await ruhe();
    aufrufe = [];
    await handleUpdate(nachricht(103, "Wie wird das Wetter morgen?"));
    assert.equal(geloescht(), false);
    assert.deepEqual(claude, ["Wie wird das Wetter morgen?"]);
  });

  it("die PIN selbst nach der Dashboard-Entscheidung: gelöscht, nie an Claude, nichts ausgeführt", async () => {
    const a = sensibel();
    await knopfOk(a.id);
    await denyAuftrag(getAuftrag(a.id)!);
    await ruhe();
    aufrufe = [];
    await handleUpdate(nachricht(104, "4711"));
    assert.equal(geloescht(), true);
    assert.deepEqual(claude, []);
    // dieselbe Antwort wie für eine vertippte PIN: sie verrät nicht, welche Eingabe stimmt
    assert.deepEqual(gesendet(), [`#${a.id} ist nicht mehr offen, Sir. Nachricht gelöscht.`]);
    assert.equal(getAuftrag(a.id)?.status, "abgelehnt");
    assert.equal(reminders.length, 0);
  });

  it("vertippte PIN nach Ablehnung im Dashboard: gelöscht, nie an Claude, Auftrag bleibt abgelehnt", async () => {
    const a = sensibel();
    await knopfOk(a.id);
    await denyAuftrag(getAuftrag(a.id)!);
    await ruhe();
    aufrufe = [];
    await handleUpdate(nachricht(106, "4712"));
    assert.equal(geloescht(), true);
    assert.deepEqual(claude, []);
    assert.deepEqual(gesendet(), [`#${a.id} ist nicht mehr offen, Sir. Nachricht gelöscht.`]);
    assert.equal(getAuftrag(a.id)?.status, "abgelehnt");
  });

  it("vertippte PIN nach Freigabe im Dashboard: gelöscht, nie an Claude", async () => {
    const a = sensibel();
    await knopfOk(a.id);
    assert.match(await approveAuftrag(getAuftrag(a.id)!, "4711"), new RegExp(`^✅ #${a.id} erledigt`));
    await ruhe();
    aufrufe = [];
    await handleUpdate(nachricht(107, "4712"));
    assert.equal(geloescht(), true);
    assert.deepEqual(claude, []);
    assert.deepEqual(gesendet(), [`#${a.id} ist nicht mehr offen, Sir. Nachricht gelöscht.`]);
  });

  it("vertippte PIN nach «Ablehnen» in Telegram: gelöscht, nie an Claude", async () => {
    const a = sensibel();
    await knopfOk(a.id);
    await knopfNein(a.id);
    assert.equal(getAuftrag(a.id)?.status, "abgelehnt");
    aufrufe = [];
    await handleUpdate(nachricht(108, "4712"));
    assert.equal(geloescht(), true);
    assert.deepEqual(claude, []);
    assert.deepEqual(gesendet(), [`#${a.id} ist nicht mehr offen, Sir. Nachricht gelöscht.`]);
  });

  it("Sprachnachricht nach der Dashboard-Entscheidung: gelöscht, weder geladen noch zum STT-Anbieter", async () => {
    const a = sensibel();
    await knopfOk(a.id);
    await denyAuftrag(getAuftrag(a.id)!);
    await ruhe();
    aufrufe = [];
    await handleUpdate(sprache(109));
    assert.equal(geloescht(), true);
    assert.deepEqual(fremd, []);
    assert.ok(!aufrufe.some((x) => x.method === "getFile"));
    assert.deepEqual(claude, []);
    assert.deepEqual(gesendet(), [`#${a.id} ist nicht mehr offen, Sir. Sprachnachricht gelöscht; die PIN bitte nie sprechen.`]);
  });

  it("nur die nächste Nachricht zählt: danach läuft auch ein kurzes Wort wieder an Claude", async () => {
    const a = sensibel();
    await knopfOk(a.id);
    await denyAuftrag(getAuftrag(a.id)!);
    await ruhe();
    await handleUpdate(nachricht(110, "Wie wird das Wetter morgen?"));
    aufrufe = [];
    await handleUpdate(nachricht(111, "Danke"));
    assert.equal(geloescht(), false);
    assert.deepEqual(claude, ["Wie wird das Wetter morgen?", "Danke"]);
  });

  it("ohne Dashboard bleibt es beim Bisherigen: die PIN führt aus", async () => {
    const a = sensibel();
    await knopfOk(a.id);
    aufrufe = [];
    await handleUpdate(nachricht(105, "4711"));
    assert.equal(getAuftrag(a.id)?.status, "erledigt");
    assert.deepEqual(claude, []);
  });
});
