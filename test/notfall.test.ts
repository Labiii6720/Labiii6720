import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/ liegt relativ) und Umgebung; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-notfall-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";

/** true: Telegram gestört (Netzfehler), false: Attrappe antwortet ok */
let gestoert = false;
let gesendet: string[] = [];

globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  if (gestoert) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }) });
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  if (body.text) gesendet.push(body.text);
  return new Response(JSON.stringify({ ok: true, result: { message_id: gesendet.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { state } = await import("../src/state.js");
const { postausgangTick, sendeSpaeter, setzeWarten } = await import("../src/telegram.js");
const { ausloesen, aufheben, notfallAktiv } = await import("../src/notfall.js");

const POSTAUSGANG = join(temp, "data", "postausgang.json");
const liesPostausgang = (): { text: string }[] => {
  try {
    return JSON.parse(readFileSync(POSTAUSGANG, "utf8")) as { text: string }[];
  } catch {
    return [];
  }
};

beforeEach(async () => {
  gestoert = false;
  aufheben();
  await postausgangTick();
  gesendet = [];
  setzeWarten(async () => {}, () => 0.5);
});

describe("Notfall-Alarm", () => {
  it("ohne Störung: Alarm samt Checkliste geht direkt raus, nichts im Postausgang", async () => {
    await ausloesen("Panik-Auslöser vom Gerät.");
    assert.equal(notfallAktiv(), true);
    assert.equal(state.paused, true);
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0], /^🚨 NOTFALL ausgelöst: Panik-Auslöser vom Gerät\./);
    assert.match(gesendet[0], /@BotFather/);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("Telegram gestört: Alarm bleibt im Postausgang und wird nachgereicht", async () => {
    gestoert = true;
    await ausloesen("Ungewöhnlich viele unbefugte Zugriffe (events).");
    assert.equal(notfallAktiv(), true);
    assert.equal(gesendet.length, 0);
    const wartend = liesPostausgang();
    assert.equal(wartend.length, 1);
    assert.match(wartend[0].text, /^🚨 NOTFALL ausgelöst/);
    assert.match(wartend[0].text, /@BotFather/);

    gestoert = false;
    await postausgangTick();
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0], /^\(nachgereicht, \d{2}:\d{2}\) 🚨 NOTFALL ausgelöst/);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("Rückstand im Postausgang: Alarm geht sofort und vor den alten Einträgen raus", async () => {
    gestoert = true;
    await sendeSpaeter("alt 1");
    await sendeSpaeter("alt 2");
    assert.equal(liesPostausgang().length, 2);
    gestoert = false;

    await ausloesen("Panik-Auslöser vom Gerät.");
    assert.equal(gesendet.length, 1, "Alarm darf nicht auf den nächsten Tick warten");
    assert.match(gesendet[0], /^🚨 NOTFALL ausgelöst: Panik-Auslöser vom Gerät\./);
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["alt 1", "alt 2"], "Alarm nicht zusätzlich im Postausgang");
  });

  it("Rückstand und Telegram gestört: Alarm wird nicht verworfen", async () => {
    gestoert = true;
    await sendeSpaeter("alt 1");
    await ausloesen("Manuell über Telegram ausgelöst.");
    const wartend = liesPostausgang();
    assert.equal(wartend.length, 2);
    assert.match(wartend[0].text, /^🚨 NOTFALL ausgelöst: Manuell/, "Alarm vorn, nicht hinter dem Rückstand");
    assert.equal(wartend[1].text, "alt 1");
    assert.equal(gesendet.length, 0);
  });

  it("während des Notfalls reicht der Postausgang nur den Alarm nach, Altes erst nach der Entwarnung", async () => {
    gestoert = true;
    await sendeSpaeter("alter Rückblick");
    await new Promise((r) => setTimeout(r, 5)); // Zeitstempel sicher vor der Auslösung
    await ausloesen("Manuell über Telegram ausgelöst.");
    gestoert = false;

    await postausgangTick();
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0], /^\(nachgereicht, \d{2}:\d{2}\) 🚨 NOTFALL ausgelöst/);
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["alter Rückblick"], "Altes bleibt liegen");

    await postausgangTick();
    assert.equal(gesendet.length, 1, "auch beim nächsten Tick nichts Altes");

    aufheben();
    await postausgangTick();
    assert.equal(gesendet.length, 2);
    assert.match(gesendet[1], /alter Rückblick$/);
    assert.deepEqual(liesPostausgang(), []);
  });
});
