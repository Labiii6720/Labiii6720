import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/, cameras.json, workspace/ liegen relativ) und Umgebung; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-uebrige-"));
process.chdir(temp);
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.FRIGATE_URL = "http://frigate.test:5000/";
process.env.OCTOPRINT_URL = "http://octoprint.test/";
process.env.OCTOPRINT_KEY = "geheimer-octoprint-key";
process.env.SHOPIFY_SHOP = "testshop";
process.env.SHOPIFY_TOKEN = "shpat_geheim";
process.env.STT_URL = "http://stt.test/v1/audio/transcriptions";
process.env.TTS_URL = "http://tts.test/v1/audio/speech";
process.env.LAT = "47.37";
process.env.LON = "8.54";
process.env.OUTLOOK_ICS_URL = "https://outlook.test/kalender.ics";
process.env.WATCHDOG_MINUTEN = "10";
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

// ---------- fetch-Attrappe ----------

type Antwort = Response | Error;
interface Aufruf { url: string; method: string }

const aufrufe: Aufruf[] = [];
let antworten: Antwort[] = [];
const echteFetch = globalThis.fetch;

const http = (status: number, text = "", headers: Record<string, string> = {}) => new Response(text, { status, headers });
const json = (daten: unknown, status = 200) => new Response(JSON.stringify(daten), { status, headers: { "content-type": "application/json" } });
const bild = () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } });
/** undici-Form: TypeError «fetch failed» mit der Ursache in cause.code */
const netz = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${code}`), { code }) });
const zeitlimit = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
/** Header kommen mit 200, der Body bricht mittendrin ab (undici: TypeError «terminated» mit cause.code, oder Zeitlimit) */
const abgebrochen = (grund: string | Error) => new Response(new ReadableStream<Uint8Array>({
  start(c) {
    c.enqueue(new Uint8Array([0xff, 0xd8]));
    c.error(typeof grund === "string" ? Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code: grund }) }) : grund);
  },
}), { status: 200 });

globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  aufrufe.push({ url: String(eingabe instanceof Request ? eingabe.url : eingabe), method: init?.method ?? "GET" });
  const a = antworten.shift();
  if (!a) throw new Error("Attrappe: keine Antwort mehr vorgesehen");
  if (a instanceof Error) throw a;
  return a;
}) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const cameras = await import("../src/cameras.js");
const werkstatt = await import("../src/werkstatt.js");
const shopify = await import("../src/shopify.js");
const voice = await import("../src/voice.js");
const sources = await import("../src/sources.js");
const { bindeMqtt } = await import("../src/watch.js");
type MqttClientLike = import("../src/watch.js").MqttClientLike;
const { formatBefund } = await import("../src/check.js");
const { gesundheit, HttpFehler } = await import("../src/robust.js");

/** console.log/error abfangen (gesundheit loggt Störungen) */
function fangeLogs(): { fehler: string[]; info: string[]; ende: () => void } {
  const fehler: string[] = [];
  const info: string[] = [];
  const log = console.log; const err = console.error;
  console.log = (...a: unknown[]) => { info.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
  return { fehler, info, ende: () => { console.log = log; console.error = err; } };
}

const gewartet: number[] = [];
let logs: ReturnType<typeof fangeLogs>;
beforeEach(() => {
  aufrufe.length = 0;
  antworten = [];
  gewartet.length = 0;
  gesundheit._reset();
  for (const m of [cameras, shopify, voice, sources]) {
    m._testOptionen.warten = async (ms) => { gewartet.push(ms); };
    m._testOptionen.zufall = () => 0.5;
  }
  logs = fangeLogs();
});
afterEach(() => logs.ende());

// ---------- Frigate ----------

describe("Frigate GET", () => {
  it("503 wird genau einmal wiederholt, zweiter Versuch liefert das Bild", async () => {
    antworten = [http(503, "Service Unavailable"), bild()];
    const b = await cameras.snapshot("hof");
    assert.equal(b.length, 3);
    assert.equal(aufrufe.length, 2);
    assert.equal(aufrufe[0]!.method, "GET");
    assert.equal(aufrufe[0]!.url, "http://frigate.test:5000/api/hof/latest.jpg?h=720");
    assert.deepEqual(gewartet, [500]);
    assert.equal(gesundheit.zustand("frigate")?.ok, true);
    assert.equal(logs.fehler.length, 1);
    assert.match(logs.fehler[0]!, /Frigate: Störung \(frigate\.get: Frigate HTTP 503 \(\/api\/hof\/latest\.jpg\)\)/);
  });

  it("dauerhaft 503: zwei Versuche, dann HttpFehler mit Status und bisherigem Text", async () => {
    antworten = [http(503), http(503), bild()];
    await assert.rejects(cameras.snapshot("hof"), (e: unknown) => e instanceof HttpFehler && e.status === 503 && e.message === "Frigate HTTP 503 (/api/hof/latest.jpg)");
    assert.equal(aufrufe.length, 2);
    assert.deepEqual(gewartet, [500]);
    const z = gesundheit.zustand("frigate");
    assert.equal(z?.ok, false);
    assert.equal(z?.fehler, 2);
  });

  it("Netzfehler wird wiederholt, 404 nicht (zählt nicht als Störung)", async () => {
    antworten = [netz("ECONNREFUSED"), bild()];
    await cameras.eventSnapshot("1234.5");
    assert.equal(aufrufe.length, 2);
    aufrufe.length = 0;
    antworten = [http(404, "Not Found")];
    await assert.rejects(cameras.eventSnapshot("gibtsnicht"), (e: unknown) => e instanceof HttpFehler && e.status === 404);
    assert.equal(aufrufe.length, 1);
    assert.deepEqual(gewartet, [500]);
  });

  it("Ereignisliste: Wiederholung mit Label «events»", async () => {
    antworten = [http(502), http(502)];
    await assert.rejects(cameras.recentEvents({ stunden: 1 }), (e: unknown) => e instanceof HttpFehler && e.status === 502 && e.message === "Frigate HTTP 502 (events)");
    assert.equal(aufrufe.length, 2);
    antworten = [json([{ id: "1", camera: "hof", label: "person", zones: [], start_time: 1, end_time: null, has_clip: false, has_snapshot: true }])];
    const list = await cameras.recentEvents();
    assert.equal(list.length, 1);
    assert.equal(gesundheit.zustand("frigate")?.ok, true);
  });

  it("Abbruch beim Body-Download (UND_ERR_SOCKET) wird wiederholt und an die Gesundheit gemeldet", async () => {
    antworten = [abgebrochen("UND_ERR_SOCKET"), abgebrochen("UND_ERR_SOCKET")];
    await assert.rejects(cameras.eventClip("1234.5"), (e: unknown) => e instanceof TypeError && e.message === "terminated");
    assert.equal(aufrufe.length, 2);
    assert.equal(aufrufe[0]!.url, "http://frigate.test:5000/api/events/1234.5/clip.mp4");
    assert.deepEqual(gewartet, [500]);
    const z = gesundheit.zustand("frigate");
    assert.equal(z?.ok, false);
    assert.equal(z?.fehler, 2);
    // zweiter Versuch klappt: Inhalt vollständig, Gesundheit wieder ok
    aufrufe.length = 0;
    gewartet.length = 0;
    antworten = [abgebrochen("UND_ERR_SOCKET"), bild()];
    const b = await cameras.snapshot("hof");
    assert.equal(b.length, 3);
    assert.equal(aufrufe.length, 2);
    assert.deepEqual(gewartet, [500]);
    assert.equal(gesundheit.zustand("frigate")?.ok, true);
  });

  it("Zeitlimit beim Body der Ereignisliste wird wiederholt", async () => {
    antworten = [abgebrochen(zeitlimit()), json([])];
    const list = await cameras.recentEvents();
    assert.deepEqual(list, []);
    assert.equal(aufrufe.length, 2);
    assert.deepEqual(gewartet, [500]);
    assert.equal(gesundheit.zustand("frigate")?.ok, true);
    assert.equal(logs.fehler.length, 1);
  });
});

// ---------- OctoPrint ----------

describe("OctoPrint-Upload", () => {
  it("wird bei 503 nicht wiederholt, meldet aber an die Gesundheit", async () => {
    mkdirSync(join(temp, "workspace"), { recursive: true });
    writeFileSync(join(temp, "workspace", "teil.stl"), "solid teil\nendsolid teil\n");
    antworten = [http(503, "Service Unavailable"), http(201, "{}")];
    await assert.rejects(werkstatt.anDrucker("teil.stl", true), (e: unknown) => e instanceof HttpFehler && e.status === 503 && /OctoPrint HTTP 503: Service Unavailable/.test(e.message));
    assert.equal(aufrufe.length, 1);
    assert.equal(aufrufe[0]!.method, "POST");
    assert.equal(aufrufe[0]!.url, "http://octoprint.test/api/files/local");
    assert.deepEqual(gewartet, []);
    assert.equal(gesundheit.zustand("octoprint")?.ok, false);
    aufrufe.length = 0;
    antworten = [netz("ECONNREFUSED")];
    await assert.rejects(werkstatt.anDrucker("teil.stl", false), /fetch failed/);
    assert.equal(aufrufe.length, 1);
    for (const f of logs.fehler) assert.doesNotMatch(f, /geheimer-octoprint-key/);
  });

  it("Erfolg: ein Aufruf, Gesundheit ok", async () => {
    mkdirSync(join(temp, "workspace"), { recursive: true });
    writeFileSync(join(temp, "workspace", "teil.stl"), "solid teil\nendsolid teil\n");
    antworten = [http(201, "{}")];
    assert.equal(await werkstatt.anDrucker("teil.stl", false), "STL an den Drucker geschickt (nicht gestartet).");
    assert.equal(aufrufe.length, 1);
    assert.equal(gesundheit.zustand("octoprint")?.ok, true);
  });
});

// ---------- Shopify ----------

describe("Shopify", () => {
  it("Lese-Query wird bei 503 einmal wiederholt", async () => {
    antworten = [http(503), json({ data: { orders: { nodes: [] } } })];
    assert.equal(await shopify.recentOrders(1), "Keine Bestellungen.");
    assert.equal(aufrufe.length, 2);
    assert.equal(aufrufe[0]!.url, "https://testshop.myshopify.com/admin/api/2026-01/graphql.json");
    assert.deepEqual(gewartet, [500]);
    assert.equal(gesundheit.zustand("shopify")?.ok, true);
  });

  it("Retry-After bei 429 hat Vorrang", async () => {
    antworten = [http(429, "", { "retry-after": "3" }), json({ data: { products: { nodes: [] } } })];
    assert.equal(await shopify.searchProducts("x"), "Keine Produkte.");
    assert.deepEqual(gewartet, [3000]);
  });

  it("Mutation wird nie wiederholt", async () => {
    antworten = [http(503), json({ data: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } } })];
    await assert.rejects(shopify.updatePrice("gid://shopify/Product/1", "gid://shopify/ProductVariant/1", "9.90"), (e: unknown) => e instanceof HttpFehler && e.status === 503);
    assert.equal(aufrufe.length, 1);
    assert.deepEqual(gewartet, []);
    assert.equal(gesundheit.zustand("shopify")?.ok, false);
  });

  it("GraphQL-Fehler (Antwort 200) wird nicht wiederholt", async () => {
    antworten = [json({ errors: [{ message: "Field 'x' doesn't exist" }] })];
    await assert.rejects(shopify.recentOrders(1), /Shopify: Field 'x'/);
    assert.equal(aufrufe.length, 1);
  });

  const gedrosselt = (kosten?: unknown) => json({
    errors: [{ message: "Throttled", extensions: { code: "THROTTLED", documentation: "https://shopify.dev/api/usage/rate-limits" } }],
    ...(kosten ? { extensions: { cost: kosten } } : {}),
  });

  it("THROTTLED (Antwort 200) wird bei Lese-Queries einmal wiederholt, Wartezeit aus throttleStatus", async () => {
    antworten = [
      gedrosselt({ requestedQueryCost: 152, actualQueryCost: null, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 2, restoreRate: 50 } }),
      json({ data: { orders: { nodes: [] } } }),
    ];
    assert.equal(await shopify.recentOrders(1), "Keine Bestellungen.");
    assert.equal(aufrufe.length, 2);
    assert.deepEqual(gewartet, [3000]);
    assert.equal(gesundheit.zustand("shopify")?.ok, true);
  });

  it("THROTTLED ohne Kostenangaben: 1 s warten; dauerhaft → HttpFehler 429, zählt als Störung", async () => {
    antworten = [gedrosselt(), gedrosselt()];
    await assert.rejects(shopify.searchProducts("x"), (e: unknown) => e instanceof HttpFehler && e.status === 429 && e.message === "Shopify gedrosselt");
    assert.equal(aufrufe.length, 2);
    assert.deepEqual(gewartet, [1000]);
    assert.equal(gesundheit.zustand("shopify")?.ok, false);
  });

  it("THROTTLED bei einer Mutation wird nicht wiederholt", async () => {
    antworten = [gedrosselt(), json({ data: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } } })];
    await assert.rejects(shopify.updatePrice("gid://shopify/Product/1", "gid://shopify/ProductVariant/1", "9.90"), (e: unknown) => e instanceof HttpFehler && e.status === 429);
    assert.equal(aufrufe.length, 1);
    assert.deepEqual(gewartet, []);
  });

  it("drosselWartezeit: Grenzfälle", () => {
    assert.equal(shopify.drosselWartezeit(), 1000);
    assert.equal(shopify.drosselWartezeit({ requestedQueryCost: 10, throttleStatus: { currentlyAvailable: 50, restoreRate: 50 } }), 1000);
    assert.equal(shopify.drosselWartezeit({ requestedQueryCost: 101, throttleStatus: { currentlyAvailable: 0, restoreRate: 0 } }), 1000);
    assert.equal(shopify.drosselWartezeit({ requestedQueryCost: 101, throttleStatus: { currentlyAvailable: 0, restoreRate: 100 } }), 1010);
  });
});

// ---------- Stimme ----------

describe("Spracherkennung und Sprachausgabe", () => {
  it("STT: 502 wird einmal wiederholt", async () => {
    antworten = [http(502), json({ text: " Guten Morgen, Jarvis. " })];
    assert.equal(await voice.transcribe(Buffer.from("ogg")), "Guten Morgen, Jarvis.");
    assert.equal(aufrufe.length, 2);
    assert.equal(aufrufe[0]!.method, "POST");
    assert.deepEqual(gewartet, [500]);
    assert.equal(gesundheit.zustand("stt")?.ok, true);
  });

  it("STT: Zeitlimit wird nicht wiederholt (eine zweite Minute Warten hilft niemandem)", async () => {
    antworten = [zeitlimit(), json({ text: "x" })];
    await assert.rejects(voice.transcribe(Buffer.from("ogg")), (e: unknown) => e instanceof DOMException && e.name === "TimeoutError");
    assert.equal(aufrufe.length, 1);
    assert.deepEqual(gewartet, []);
  });

  it("TTS: Netzfehler wird wiederholt, 400 nicht", async () => {
    antworten = [netz("ECONNRESET"), new Response(new Uint8Array([1, 2, 3]), { status: 200 })];
    assert.equal((await voice.speak("Guten Abend, Sir.")).length, 3);
    assert.equal(aufrufe.length, 2);
    aufrufe.length = 0;
    antworten = [http(400, "Bad Request")];
    await assert.rejects(voice.speak("x"), (e: unknown) => e instanceof HttpFehler && e.status === 400);
    assert.equal(aufrufe.length, 1);
  });
});

// ---------- Wetter und Kalender ----------

describe("Wetter und Outlook-Kalender", () => {
  const wetter = {
    current: { temperature_2m: 12.3 },
    hourly: { time: ["2026-10-10T07:00", "2026-10-10T08:00"], precipitation_probability: [10, 60] },
    daily: { weather_code: [3], temperature_2m_min: [8], temperature_2m_max: [15], precipitation_sum: [1.2], precipitation_probability_max: [60] },
  };

  it("Open-Meteo: 503 wird einmal wiederholt, Ergebnis landet im Cache", async () => {
    antworten = [http(503), json(wetter)];
    const w = await sources.getWeather(0);
    assert.equal(w.nowTemp, 12.3);
    assert.match(w.summary, /Lage: bedeckt/);
    assert.equal(aufrufe.length, 2);
    assert.match(aufrufe[0]!.url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
    assert.deepEqual(gewartet, [500]);
    assert.equal(gesundheit.zustand("wetter")?.ok, true);
    // Cache: kein weiterer Aufruf
    await sources.getWeather();
    assert.equal(aufrufe.length, 2);
  });

  it("Outlook-ICS: zweimal 504, dann Fehler mit bisherigem Text, Kalender gestört", async () => {
    antworten = [http(504), http(504)];
    await assert.rejects(sources.outlookEvents(), (e: unknown) => e instanceof HttpFehler && e.message === "Outlook-Kalender HTTP 504");
    assert.equal(aufrufe.length, 2);
    assert.equal(gesundheit.zustand("kalender")?.ok, false);
    aufrufe.length = 0;
    antworten = [http(200, "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:test\r\nEND:VCALENDAR\r\n")];
    assert.deepEqual(await sources.outlookEvents(), []);
    assert.equal(gesundheit.zustand("kalender")?.ok, true);
    assert.equal(logs.info.filter((l) => /Kalender wieder da/.test(l)).length, 1);
  });
});

// ---------- MQTT ----------

class MqttAttrappe implements MqttClientLike {
  handler = new Map<string, ((...a: never[]) => void)[]>();
  abos: string[] = [];
  on(event: string, cb: (...a: never[]) => void): this {
    this.handler.set(event, [...(this.handler.get(event) ?? []), cb]);
    return this;
  }
  subscribe(topic: string): void { this.abos.push(topic); }
  emit(event: string, ...a: unknown[]): void { for (const cb of this.handler.get(event) ?? []) (cb as (...x: unknown[]) => void)(...a); }
}

describe("MQTT (Frigate-Ereignisse)", () => {
  it("50 Fehler und Wiederverbindungen: eine Logzeile, Gesundheit gestört, connect → wieder da", () => {
    const c = new MqttAttrappe();
    bindeMqtt(c);
    for (let i = 0; i < 50; i++) {
      c.emit("error", Object.assign(new Error("connect ECONNREFUSED 192.168.1.10:1883"), { code: "ECONNREFUSED" }));
      c.emit("offline");
      c.emit("reconnect");
    }
    assert.equal(logs.fehler.length, 1);
    assert.match(logs.fehler[0]!, /MQTT-Broker: Störung \(Netz: ECONNREFUSED\)/);
    const z = gesundheit.zustand("mqtt");
    assert.equal(z?.ok, false);
    assert.equal(z?.fehler, 150);
    c.emit("connect");
    assert.deepEqual(c.abos, ["frigate/events"]);
    assert.equal(gesundheit.zustand("mqtt")?.ok, true);
    assert.equal(logs.info.length, 2); // «wieder da» + «MQTT verbunden»
    assert.match(logs.info[1]!, /MQTT verbunden/);
  });

  it("Zugangsdaten tauchen nie im Log auf", () => {
    const c = new MqttAttrappe();
    bindeMqtt(c);
    c.emit("error", new Error("Connection refused: Not authorized (mqtt://jarvis:streng-geheim@broker)"));
    assert.equal(logs.fehler.length, 1);
    assert.doesNotMatch(logs.fehler[0]!, /streng-geheim/);
    assert.doesNotMatch(gesundheit.zustand("mqtt")?.letzterFehler ?? "", /streng-geheim/);
    assert.match(gesundheit.zustand("mqtt")?.letzterFehler ?? "", /mqtt:\/\/<geheim>@broker/);
  });
});

// ---------- /check ----------

describe("formatBefund mit Gesundheitsbericht", () => {
  const befunde = [{ name: "Telegram", status: "ok" as const, info: "Bot @test" }, { name: "Frigate", status: "fehler" as const, info: "HTTP 503" }];

  it("ohne gemeldete Komponenten unverändert", () => {
    assert.equal(formatBefund(befunde), "✅ Telegram: Bot @test\n❌ Frigate: HTTP 503\n\n1 ok · 0 nicht eingerichtet · 1 Fehler");
  });

  it("mit Störung: Bericht vor der Summenzeile, Summenzeile bleibt letzte Zeile", () => {
    gesundheit.melde("frigate", false, "frigate.get: HTTP 503");
    gesundheit.melde("telegram", true);
    const text = formatBefund(befunde);
    const zeilen = text.split("\n");
    assert.equal(zeilen.at(-1), "1 ok · 0 nicht eingerichtet · 1 Fehler");
    assert.match(text, /Gesundheit der Anbindungen \(laufender Betrieb\):\n❌ frigate seit 0 Min: frigate\.get: HTTP 503\n✅ telegram\n/);
  });
});
