import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/, workspace/ liegen relativ), Umgebung und Attrappen; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-tools-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

const openscadBin = join(temp, "openscad");
writeFileSync(openscadBin, "");
const slicerBin = join(temp, "prusa-slicer");
writeFileSync(slicerBin, "");
chmodSync(slicerBin, 0o755);
const slicerProfil = join(temp, "profil.ini");
writeFileSync(slicerProfil, "layer_height = 0.2\n");

process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.HA_URL = "http://ha.test:8123/";
process.env.HA_TOKEN = "geheimes-ha-token-attrappe";
process.env.HA_AUTO_DOMAINS = "light,switch,media_player,fan,scene,climate";
process.env.OCTOPRINT_URL = "http://octoprint.test/";
process.env.OCTOPRINT_KEY = "geheimer-octoprint-key";
process.env.OPENSCAD_PATH = openscadBin;
delete process.env.PRUSASLICER_PATH;
delete process.env.SLICER_PROFIL;

// fetch-Attrappe: nur Home Assistant, jeder Aufruf wird festgehalten
const aufrufe: { url: string; body: unknown }[] = [];
const echteFetch = globalThis.fetch;
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe);
  assert.ok(url.startsWith("http://ha.test:8123/"), `unerwarteter Aufruf: ${url}`);
  aufrufe.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
  return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const { activeTools, stufeOf } = await import("../src/tools.js");
const { config } = await import("../src/config.js");

const werkzeug = (name: string) => {
  const t = activeTools().find((x) => x.name === name);
  assert.ok(t, `${name} fehlt`);
  return t;
};
const ctx = { sendFile: async () => {}, sendPhoto: async () => {}, sendVideo: async () => {} };

afterEach(() => { aufrufe.length = 0; });

describe("geraet_schalten: Stufe hängt an Dienst und daten, nicht nur an der Domain", () => {
  const stufe = (input: Record<string, unknown>) => stufeOf(werkzeug("geraet_schalten"), input);

  it("gewöhnliches Bedienen in einer Auto-Domain bleibt auto", () => {
    assert.equal(stufe({ entity_id: "light.buero", dienst: "turn_on", daten: { brightness_pct: 40 } }), "auto");
    assert.equal(stufe({ entity_id: "switch.steckdose", dienst: "toggle" }), "auto");
    assert.equal(stufe({ entity_id: "scene.abend", dienst: "turn_on" }), "auto");
    assert.equal(stufe({ entity_id: "climate.wohnzimmer", dienst: "set_temperature", daten: { temperature: 21 } }), "auto");
  });

  it("scene.apply mit Schloss und Alarm in daten → sensibel", () => {
    const input = { entity_id: "scene.x", dienst: "apply", daten: { entities: { "lock.haustuer": "unlocked", "alarm_control_panel.haus": "disarmed" } } };
    assert.equal(stufe(input), "sensibel");
  });

  it("scene.apply/scene.create ohne Sicherheitsgerät → extern, nie auto", () => {
    assert.equal(stufe({ entity_id: "scene.x", dienst: "apply", daten: { entities: { "light.buero": "on" } } }), "extern");
    assert.equal(stufe({ entity_id: "scene.x", dienst: "create", daten: { scene_id: "neu", snapshot_entities: ["light.buero"] } }), "extern");
    assert.equal(stufe({ entity_id: "light.buero", dienst: "reload" }), "extern");
  });

  it("Zielschlüssel in daten → extern; Schloss in daten oder in entity_id → sensibel", () => {
    assert.equal(stufe({ entity_id: "switch.licht", dienst: "turn_on", daten: { entity_id: "switch.heizung" } }), "extern");
    assert.equal(stufe({ entity_id: "light.buero", dienst: "turn_on", daten: { target: { area_id: "keller" } } }), "extern");
    assert.equal(stufe({ entity_id: "switch.licht", dienst: "turn_on", daten: { entity_id: "lock.haustuer" } }), "sensibel");
    assert.equal(stufe({ entity_id: "light.buero,lock.haustuer", dienst: "turn_on" }), "sensibel");
    assert.equal(stufe({ entity_id: "lock.haustuer", dienst: "lock" }), "sensibel");
    assert.equal(stufe({ entity_id: "alarm_control_panel.haus", dienst: "alarm_arm_home" }), "sensibel");
    assert.equal(stufe({ entity_id: "cover.garage", dienst: "open_cover" }), "extern");
  });

  it("Freigabe-Text nennt daten", () => {
    const text = werkzeug("geraet_schalten").summary!({ entity_id: "scene.x", dienst: "apply", daten: { entities: { "lock.haustuer": "unlocked" } } });
    assert.match(text, /^Gerät schalten: apply auf scene\.x mit \{"entities":\{"lock\.haustuer":"unlocked"\}\}$/);
    assert.equal(werkzeug("geraet_schalten").summary!({ entity_id: "light.buero", dienst: "turn_on" }), "Gerät schalten: turn_on auf light.buero");
  });

  it("run: daten darf die freigegebene entity_id nicht überschreiben; nichts geschaltet", async () => {
    const t = werkzeug("geraet_schalten");
    await assert.rejects(t.run({ entity_id: "switch.licht", dienst: "turn_on", daten: { entity_id: "lock.haustuer" } }, ctx), /daten darf kein Ziel setzen \(entity_id\).*Nichts geschaltet, Sir\./);
    await assert.rejects(t.run({ entity_id: "scene.x", dienst: "apply", daten: { entities: { "lock.haustuer": "unlocked" } } }, ctx), /kein Ziel setzen \(entities\)/);
    await assert.rejects(t.run({ entity_id: "light.buero", dienst: "turn_on", daten: ["x"] }, ctx), /daten muss ein Objekt sein/);
    assert.equal(aufrufe.length, 0);
  });

  it("run: gewöhnliches Schalten geht mit genau dieser entity_id an Home Assistant", async () => {
    assert.equal(await werkzeug("geraet_schalten").run({ entity_id: "light.buero", dienst: "turn_on", daten: { brightness_pct: 40 } }, ctx), "turn_on auf light.buero ausgeführt");
    assert.equal(aufrufe.length, 1);
    assert.equal(aufrufe[0]!.url, "http://ha.test:8123/api/services/light/turn_on");
    assert.deepEqual(aufrufe[0]!.body, { entity_id: "light.buero", brightness_pct: 40 });
  });
});

describe("cad_drucken: Freigabe-Text verspricht keinen Start, der nicht kommt", () => {
  afterEach(() => { config.slicerPath = undefined; config.slicerProfil = undefined; });

  it("ohne Slicer: STL wird nur hochgeladen, auch mit starten", () => {
    const input: Record<string, unknown> = { pfad: "cad/kabel.scad", starten: true };
    const text = werkzeug("cad_drucken").summary!(input);
    assert.equal(text, "3D-Druck: cad/kabel.scad → STL (ohne Slicer) (nur hochladen, eine STL startet OctoPrint nicht)");
    assert.doesNotMatch(text, /sofort starten/);
    assert.equal(input.freigegeben_als, "stl");
    assert.equal(werkzeug("cad_drucken").summary!({ pfad: "cad/kabel.stl" }), "3D-Druck: cad/kabel.stl → STL (ohne Slicer)");
  });

  it("mit Slicer: G-Code und «sofort starten» bleiben", () => {
    config.slicerPath = slicerBin;
    config.slicerProfil = slicerProfil;
    const input: Record<string, unknown> = { pfad: "cad/kabel.scad", starten: true };
    assert.equal(werkzeug("cad_drucken").summary!(input), "3D-Druck: cad/kabel.scad → G-Code (vorher mit PrusaSlicer geslict) (sofort starten)");
    assert.equal(input.freigegeben_als, "gcode");
  });
});
