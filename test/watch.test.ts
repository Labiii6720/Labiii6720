import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (cameras.json, data/ liegen relativ) und Umgebung; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-watch-"));
process.chdir(temp);
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.FRIGATE_URL = "http://frigate.test:5000/";
process.env.WATCHDOG_MINUTEN = "10";
writeFileSync(
  "cameras.json",
  JSON.stringify({
    hof: {
      frigate: "hof",
      beschreibung: "Innenhof",
      melden: { labels: ["person"], ruhe_minuten: 0 },
      wachen: [{ frage: "Ist jemand im Hof?", alle_minuten: 1, ruhe_minuten: 0 }],
    },
  }),
);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

// ---------- fetch-Attrappe: Frigate liefert Bilder, Telegram je nach Test ok oder Netzfehler ----------

const aufrufe: string[] = [];
let telegramGestoert = false;
let frigateFehler: Error | undefined;
const echteFetch = globalThis.fetch;
const netz = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });

globalThis.fetch = (async (eingabe: string | URL | Request) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (url.startsWith("http://frigate.test:5000/")) {
    aufrufe.push("frigate");
    if (frigateFehler) throw frigateFehler;
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } });
  }
  const m = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(url);
  if (m) {
    aufrufe.push(m[1]!);
    if (telegramGestoert) throw netz();
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`Attrappe: unerwartete URL ${url.replace(/bot[^/]+/, "bot<geschwärzt>")}`);
}) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const cameras = await import("../src/cameras.js");
const telegram = await import("../src/telegram.js");
const { anthropic } = await import("../src/claude.js");
const { gesundheit } = await import("../src/robust.js");
const { onCameraEvent, wachenTick } = await import("../src/watch.js");

// Claude schaut hin: Antwort fest vorgegeben, keine echte API
let claudeAntwort = "JA\nEine Person steht beim Tor.";
(anthropic().messages as unknown as { create: () => Promise<unknown> }).create = async () => ({
  content: [{ type: "text", text: claudeAntwort }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

const postausgang = (): { text: string }[] => {
  try {
    return JSON.parse(readFileSync("data/postausgang.json", "utf8")) as { text: string }[];
  } catch {
    return [];
  }
};

let logEnde: () => void;
beforeEach(() => {
  aufrufe.length = 0;
  gesundheit._reset();
  telegram.setzeWarten(async () => undefined, () => 0.5);
  cameras._testOptionen.warten = async () => undefined;
  cameras._testOptionen.zufall = () => 0.5;
  const log = console.log; const err = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  logEnde = () => { console.log = log; console.error = err; };
});
afterEach(() => logEnde());

let jetzt = Date.now();

describe("Kamera-Ereignis und Wache ohne Störung", () => {
  it("Ereignis mit Bild: genau ein sendPhoto, kein Text, Postausgang bleibt leer", async () => {
    telegramGestoert = false;
    assert.equal(await onCameraEvent({ camera: "hof", label: "person", id: "ev-ok", hasSnapshot: true }), true);
    assert.deepEqual(aufrufe, ["frigate", "sendPhoto"]);
    assert.equal(postausgang().length, 0);
  });

  it("Wache mit JA: genau ein sendPhoto, kein Text", async () => {
    telegramGestoert = false;
    claudeAntwort = "JA\nEine Person steht beim Tor.";
    jetzt += 10 * 60_000;
    await wachenTick(jetzt);
    assert.deepEqual(aufrufe, ["frigate", "sendPhoto"]);
    assert.equal(postausgang().length, 0);
  });
});

describe("Telegram gestört: Bild scheitert, Text landet im Postausgang", () => {
  it("Kamera-Ereignis: nach 4 Bild-Versuchen geht die Beschriftung in den Postausgang", async () => {
    telegramGestoert = true;
    assert.equal(await onCameraEvent({ camera: "hof", label: "person", id: "ev-gestoert", hasSnapshot: true }), true);
    assert.equal(aufrufe.filter((a) => a === "sendPhoto").length, 4);
    const liste = postausgang();
    assert.equal(liste.length, 1);
    assert.match(liste[0]!.text, /^📷 person · hof · \d\d:\d\d$/);
  });

  it("Wache: nach gescheitertem Bild liegt der Treffer-Text im Postausgang", async () => {
    telegramGestoert = true;
    claudeAntwort = "JA. Jemand klettert über den Zaun.";
    jetzt += 10 * 60_000;
    await wachenTick(jetzt);
    assert.equal(aufrufe.filter((a) => a === "sendPhoto").length, 4);
    const liste = postausgang();
    assert.equal(liste.length, 2);
    assert.equal(liste[1]!.text, "👁 hof: Ist jemand im Hof?\nJemand klettert über den Zaun.");
  });

  it("Postausgang reicht beides nach, sobald Telegram wieder geht", async () => {
    telegramGestoert = false;
    await telegram.postausgangTick();
    assert.deepEqual(aufrufe, ["sendMessage", "sendMessage"]);
    assert.equal(postausgang().length, 0);
  });
});

describe("Fehlertexte im Log sind geschwärzt", () => {
  it("Zugangsdaten aus der Frigate-URL erscheinen weder bei Ereignis noch bei Wache im Log", async () => {
    telegramGestoert = false;
    // So wirft Node 22 fetch bei einer URL mit Zugangsdaten: kein Netzfehler, also nicht vorübergehend
    frigateFehler = new TypeError("Request cannot be constructed from a URL that includes credentials: http://admin:geheimPW99@nvr:5000/api/x");
    const zeilen: string[] = [];
    console.error = (...a: unknown[]) => { zeilen.push(a.map(String).join(" ")); };
    try {
      assert.equal(await onCameraEvent({ camera: "hof", label: "person", id: "ev-zugang", hasSnapshot: true }), true);
      jetzt += 10 * 60_000;
      await wachenTick(jetzt);
    } finally {
      frigateFehler = undefined;
    }
    assert.ok(zeilen.length >= 2, "beide Fehler werden geloggt");
    for (const z of zeilen) {
      assert.doesNotMatch(z, /geheimPW99/);
      assert.doesNotMatch(z, /admin:/);
    }
    assert.ok(zeilen.some((z) => z.includes("http://<geheim>@nvr:5000")));
  });
});
