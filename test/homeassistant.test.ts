import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-ha-"));
process.chdir(temp);
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.HA_URL = "http://ha.test:8123/";
process.env.HA_TOKEN = "geheimes-ha-token-attrappe";
process.env.HA_PRESENCE_ENTITY = "person.test";
process.env.WATCHDOG_MINUTEN = "10";
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

const { haStates, haService, haState, isHome, _testOptionen } = await import("../src/homeassistant.js");
const { gesundheit, HttpFehler } = await import("../src/robust.js");

// ---------- Attrappen ----------

type Antwort = Response | Error;
interface Aufruf { url: string; method: string; body?: string; auth?: string }

const aufrufe: Aufruf[] = [];
let antworten: Antwort[] = [];
const echteFetch = globalThis.fetch;

const json = (daten: unknown, status = 200) => new Response(JSON.stringify(daten), { status, headers: { "content-type": "application/json" } });
const http = (status: number, text = "") => new Response(text, { status });
/** undici-Form: TypeError «fetch failed» mit der Ursache in cause.code */
const netz = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${code}`), { code }) });
const zeitlimit = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const h = new Headers(init?.headers);
  aufrufe.push({ url: String(eingabe), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined, auth: h.get("authorization") ?? undefined });
  const a = antworten.shift();
  if (!a) throw new Error("Attrappe: keine Antwort mehr vorgesehen");
  if (a instanceof Error) throw a;
  return a;
}) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

/** console.log/error abfangen (gesundheit loggt Störungen) */
function fangeLogs(): { fehler: string[]; ende: () => void } {
  const fehler: string[] = [];
  const log = console.log; const err = console.error;
  console.log = () => undefined;
  console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
  return { fehler, ende: () => { console.log = log; console.error = err; } };
}

const gewartet: number[] = [];
let logs: ReturnType<typeof fangeLogs>;
beforeEach(() => {
  aufrufe.length = 0;
  antworten = [];
  gewartet.length = 0;
  gesundheit._reset();
  _testOptionen.warten = async (ms) => { gewartet.push(ms); };
  _testOptionen.zufall = () => 0.5;
  logs = fangeLogs();
});
afterEach(() => logs.ende());

const zustaende = [
  { entity_id: "light.buero", state: "on", attributes: { friendly_name: "Büro" } },
  { entity_id: "sensor.temp", state: "21.5", attributes: { friendly_name: "Temperatur", unit_of_measurement: "°C" } },
  { entity_id: "update.core", state: "off", attributes: {} },
];

// ---------- GET ----------

describe("Home Assistant GET", () => {
  it("503 wird wiederholt, zweiter Versuch liefert die Zustände", async () => {
    antworten = [http(503, "Service Unavailable"), json(zustaende)];
    const text = await haStates();
    assert.equal(aufrufe.length, 2);
    assert.equal(aufrufe[0]!.method, "GET");
    assert.equal(aufrufe[0]!.url, "http://ha.test:8123/api/states");
    assert.deepEqual(gewartet, [400]);
    assert.match(text, /light\.buero · Büro · on/);
    assert.match(text, /sensor\.temp · Temperatur · 21\.5 °C/);
    assert.doesNotMatch(text, /update\.core/);
    assert.equal(gesundheit.zustand("homeassistant")?.ok, true);
    assert.equal(logs.fehler.length, 1);
    assert.match(logs.fehler[0]!, /Home Assistant: Störung \(ha\.get: Home Assistant HTTP 503 \(states\)\)/);
  });

  it("dauerhaft 503: drei Versuche mit Backoff 400, 800 ms, dann HttpFehler mit Status", async () => {
    antworten = [http(503), http(503), http(503)];
    await assert.rejects(haState("person.test"), (e: unknown) => e instanceof HttpFehler && e.status === 503 && /Home Assistant HTTP 503 \(states\/person\.test\)/.test(e.message));
    assert.equal(aufrufe.length, 3);
    assert.deepEqual(gewartet, [400, 800]);
    const z = gesundheit.zustand("homeassistant");
    assert.equal(z?.ok, false);
    assert.equal(z?.fehler, 3);
  });

  it("Netzfehler und Zeitlimit werden wiederholt, Retry-After hat Vorrang", async () => {
    antworten = [netz("ECONNRESET"), zeitlimit(), new Response("", { status: 503, headers: { "retry-after": "2" } })];
    await assert.rejects(haState("person.test"));
    assert.equal(aufrufe.length, 3);
    assert.deepEqual(gewartet, [400, 800]);
    antworten = [new Response("", { status: 503, headers: { "retry-after": "2" } }), json({ entity_id: "person.test", state: "home", attributes: {} })];
    gewartet.length = 0;
    assert.equal(await haState("person.test"), "home");
    assert.deepEqual(gewartet, [2000]);
  });

  it("404 (Client-Fehler) wird nicht wiederholt und zählt nicht als Störung", async () => {
    antworten = [http(404, "Not Found")];
    await assert.rejects(haState("sensor.gibtsnicht"), (e: unknown) => e instanceof HttpFehler && e.status === 404);
    assert.equal(aufrufe.length, 1);
    assert.deepEqual(gewartet, []);
    assert.equal(gesundheit.zustand("homeassistant"), undefined);
  });

  it("Token steht im Header, nie in Fehlertext oder Gesundheit", async () => {
    antworten = [http(502), http(502), http(502)];
    await assert.rejects(haState("person.test"), (e: Error) => !e.message.includes(process.env.HA_TOKEN!));
    assert.equal(aufrufe[0]!.auth, `Bearer ${process.env.HA_TOKEN}`);
    assert.doesNotMatch(gesundheit.zustand("homeassistant")?.letzterFehler ?? "", /geheimes-ha-token/);
    for (const f of logs.fehler) assert.doesNotMatch(f, /geheimes-ha-token/);
  });
});

// ---------- POST ----------

describe("Home Assistant POST (Dienste)", () => {
  it("light.turn_on bei ECONNREFUSED genau einmal wiederholt", async () => {
    antworten = [netz("ECONNREFUSED"), json([])];
    const text = await haService("light.buero", "turn_on", { brightness: 128 });
    assert.equal(text, "turn_on auf light.buero ausgeführt");
    assert.equal(aufrufe.length, 2);
    assert.equal(aufrufe[0]!.method, "POST");
    assert.equal(aufrufe[0]!.url, "http://ha.test:8123/api/services/light/turn_on");
    assert.deepEqual(JSON.parse(aufrufe[1]!.body!), { entity_id: "light.buero", brightness: 128 });
    assert.deepEqual(gewartet, [400]);
    assert.equal(gesundheit.zustand("homeassistant")?.ok, true);
  });

  it("höchstens zwei Versuche, auch wenn HA weiter unerreichbar bleibt", async () => {
    antworten = [netz("ENOTFOUND"), netz("ENOTFOUND"), json([])];
    await assert.rejects(haService("light.buero", "turn_off"), (e: Error) => /fetch failed/.test(e.message));
    assert.equal(aufrufe.length, 2);
    assert.deepEqual(gewartet, [400]);
    assert.equal(gesundheit.zustand("homeassistant")?.ok, false);
  });

  it("AggregateError-Ursache (IPv4+IPv6) wird erkannt", async () => {
    const agg = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new AggregateError([Object.assign(new Error("connect ECONNREFUSED ::1"), { code: "ECONNREFUSED" })], "connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    antworten = [agg, json([])];
    await haService("switch.steckdose", "turn_on");
    assert.equal(aufrufe.length, 2);
  });

  it("Zeitlimit: kein zweiter Versuch – HA könnte den Befehl bereits ausgeführt haben", async () => {
    antworten = [zeitlimit(), json([])];
    await assert.rejects(haService("light.buero", "turn_on"), (e: unknown) => e instanceof DOMException && e.name === "TimeoutError");
    assert.equal(aufrufe.length, 1);
    assert.deepEqual(gewartet, []);
    assert.equal(gesundheit.zustand("homeassistant")?.ok, false);
  });

  it("ECONNRESET und 5xx: kein zweiter Versuch", async () => {
    antworten = [netz("ECONNRESET"), json([])];
    await assert.rejects(haService("light.buero", "turn_on"));
    assert.equal(aufrufe.length, 1);
    aufrufe.length = 0;
    antworten = [http(502, "Bad Gateway"), json([])];
    await assert.rejects(haService("light.buero", "turn_on"), (e: unknown) => e instanceof HttpFehler && e.status === 502);
    assert.equal(aufrufe.length, 1);
    assert.deepEqual(gewartet, []);
  });

  it("toggle, press, trigger, increase_*, decrease_*, *step* werden nie wiederholt", async () => {
    const faelle: [string, string][] = [
      ["light.buero", "toggle"], ["button.klingel", "press"], ["automation.nacht", "trigger"],
      ["fan.bad", "increase_speed"], ["fan.bad", "decrease_speed"], ["media_player.wohnzimmer", "volume_step"], ["cover.rollo", "step_up"],
    ];
    for (const [entity, dienst] of faelle) {
      aufrufe.length = 0;
      antworten = [netz("ECONNREFUSED"), json([])];
      await assert.rejects(haService(entity, dienst), `${dienst} hätte nicht wiederholt werden dürfen`);
      assert.equal(aufrufe.length, 1, dienst);
    }
    assert.deepEqual(gewartet, []);
  });

  it("ungültiger Dienst wird vor dem Aufruf abgewiesen", async () => {
    await assert.rejects(haService("light.buero", "turn-on"), /Ungültige entity_id oder Dienst/);
    assert.equal(aufrufe.length, 0);
  });
});

// ---------- isHome ----------

describe("isHome", () => {
  it("home / not_home", async () => {
    antworten = [json({ entity_id: "person.test", state: "home", attributes: {} })];
    assert.equal(await isHome(), true);
    antworten = [json({ entity_id: "person.test", state: "not_home", attributes: {} })];
    assert.equal(await isHome(), false);
  });

  it("bleibt bei Störung fehlertolerant (true) und meldet an die Gesundheit", async () => {
    antworten = [netz("ECONNREFUSED"), netz("ECONNREFUSED"), netz("ECONNREFUSED")];
    assert.equal(await isHome(), true);
    assert.equal(aufrufe.length, 3);
    const z = gesundheit.zustand("homeassistant");
    assert.equal(z?.ok, false);
    assert.match(z?.letzterFehler ?? "", /Netz: ECONNREFUSED/);
    assert.equal(logs.fehler.length, 1);
  });
});
