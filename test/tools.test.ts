import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
process.env.FRIGATE_URL = "http://frigate.test:5000";
writeFileSync(join(temp, "cameras.json"), JSON.stringify({ balkon: { beschreibung: "Balkon" } }));
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
const browser = await import("../src/browser.js");
const { zeitplaene } = await import("../src/zeitplaene.js");
const { dynamicWachen } = await import("../src/cameras.js");

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

describe("Browser: nichts verlässt den Pi per Formular ohne Freigabe", () => {
  // Browser-Attrappe: hält fest, was getippt und gedrückt wird; nie ein echter Chromium
  const getippt: { wert: string; enter: boolean }[] = [];
  const feld = { fill: async (v: string) => { getippt.push({ wert: v, enter: false }); }, press: async () => { getippt.at(-1)!.enter = true; }, count: async () => 1 };
  const klick = { first: () => ({ click: async () => {} }) };
  browser.setLauncher(async () => ({
    goto: async () => undefined,
    title: async () => "Testseite",
    url: () => "https://beispiel.test/",
    evaluate: async <T,>() => ({ text: "", links: [] }) as T,
    getByText: () => klick,
    getByRole: () => klick,
    getByLabel: () => ({ first: () => feld }),
    getByPlaceholder: () => ({ first: () => feld }),
    locator: () => ({ first: () => feld }),
    screenshot: async () => Buffer.alloc(0),
    goBack: async () => undefined,
    waitForLoadState: async () => {},
  }));
  const tippen = (input: Record<string, unknown>) => stufeOf(werkzeug("browser_tippen"), input);

  it("kurze Eingabe ohne Enter bleibt auto", () => {
    assert.equal(tippen({ feld: "Suche", text: "Muttenz Basel" }), "auto");
    assert.equal(tippen({ feld: "Suche", text: "x".repeat(60), enter: false }), "auto");
  });

  it("Absenden mit Enter oder langer Text → extern", () => {
    assert.equal(tippen({ feld: "Suche", text: "Muttenz", enter: true }), "extern");
    assert.equal(tippen({ feld: "q", text: "x".repeat(61) }), "extern");
    assert.equal(tippen({ feld: "q", text: "IBAN CH93 0076 2011 6238 5295 7, Rechnung 4711, Notizen: Tresorcode im Keller" }), "extern");
  });

  it("Freigabe-Text nennt Text, Feld und Absenden", () => {
    assert.equal(werkzeug("browser_tippen").summary!({ feld: "Suche", text: "Muttenz", enter: true }), "Im Browser tippen und absenden: «Muttenz» in Suche");
    assert.equal(werkzeug("browser_tippen").summary!({ feld: "q", text: "abc" }), "Im Browser tippen: «abc» in q");
  });

  it("klicken braucht immer Freigabe und zeigt, was ein Formular absenden würde", async () => {
    assert.equal(stufeOf(werkzeug("browser_klicken"), { text: "Weiter" }), "extern");
    await werkzeug("browser_oeffnen").run({ url: "https://beispiel.test/" }, ctx);
    assert.equal(werkzeug("browser_klicken").summary!({ text: "Senden" }), "Im Browser klicken: «Senden»");
    await werkzeug("browser_tippen").run({ feld: "Suche", text: "Muttenz" }, ctx);
    assert.deepEqual(getippt.at(-1), { wert: "Muttenz", enter: false });
    assert.equal(werkzeug("browser_klicken").summary!({ text: "Senden" }), "Im Browser klicken: «Senden»\nKann ein Formular mit diesen Eingaben absenden: Suche: «Muttenz»");
    await werkzeug("browser_oeffnen").run({ url: "https://beispiel.test/neu" }, ctx);
    assert.equal(werkzeug("browser_klicken").summary!({ text: "Senden" }), "Im Browser klicken: «Senden»");
  });
});

describe("Löschen von Zeitplänen und Wachen braucht Freigabe", () => {
  it("zeitplan_loeschen → extern, Freigabe-Text nennt den Zeitplan", () => {
    zeitplaene.push({ id: 7, name: "News", zeit: "07:00", tage: "werktags", auftrag: "News zusammenfassen" });
    const t = werkzeug("zeitplan_loeschen");
    assert.equal(stufeOf(t, { id: 7 }), "extern");
    assert.equal(t.summary!({ id: 7 }), "Zeitplan #7 «News» löschen (werktags um 07:00)");
    assert.equal(t.summary!({ id: 99 }), "Zeitplan #99 löschen (nicht gefunden)");
    zeitplaene.length = 0;
  });

  it("wache_loeschen → extern, Freigabe-Text nennt Kamera und Frage", () => {
    dynamicWachen.push({ id: 3, kamera: "balkon", frage: "Steht die Balkontür offen?", alle_minuten: 60 });
    const t = werkzeug("wache_loeschen");
    assert.equal(stufeOf(t, { id: 3 }), "extern");
    assert.equal(t.summary!({ id: 3 }), "Wache #3 löschen: balkon – Steht die Balkontür offen?");
    assert.equal(t.summary!({ id: 4 }), "Wache #4 löschen (nicht gefunden)");
    dynamicWachen.length = 0;
  });

  it("zeitplan_loeschen löscht nur, was die Freigabe nannte", async () => {
    zeitplaene.push({ id: 7, name: "News", zeit: "07:00", tage: "werktags", auftrag: "News zusammenfassen" });
    const t = werkzeug("zeitplan_loeschen");
    const gespeichert = t.festhalten!({ id: 7 });
    assert.deepEqual(gespeichert, { id: 7, erwartet_name: "News", erwartet_zeit: "07:00", erwartet_tage: "werktags", erwartet_auftrag: "News zusammenfassen" });
    // Ohne festgehaltenen Stand (oder bei unbekannter ID) nichts löschen
    await assert.rejects(t.run({ id: 7 }, ctx), /Ich lösche nichts/);
    assert.equal(t.festhalten!({ id: 99 }).erwartet_name, null);
    assert.equal(zeitplaene.length, 1);
    zeitplaene[0]!.name = "Anderes";
    await assert.rejects(t.run(gespeichert, ctx), /heisst inzwischen anders, Sir\. Ich lösche nichts\./);
    assert.equal(zeitplaene.length, 1);
    zeitplaene[0]!.name = "News";
    assert.equal(await t.run(gespeichert, ctx), "Gelöscht.");
    assert.equal(zeitplaene.length, 0);
  });

  it("zeitplan_loeschen löscht nichts, wenn Uhrzeit, Tage oder Auftrag inzwischen anders sind (Name gleich)", async () => {
    zeitplaene.push({ id: 8, name: "Morgen", zeit: "07:00", tage: "Mo, Mi", auftrag: "Briefing" });
    const t = werkzeug("zeitplan_loeschen");
    const gespeichert = t.festhalten!({ id: 8 });
    // Wie PUT /api/zeitplaene/8 in der Kommandozentrale: Objekt bleibt, Felder ändern sich, Name bleibt
    zeitplaene[0]!.zeit = "08:15";
    await assert.rejects(t.run(gespeichert, ctx), /Zeitplan #8 wurde inzwischen geändert, Sir\. Ich lösche nichts\./);
    zeitplaene[0]!.zeit = "07:00";
    zeitplaene[0]!.tage = "taeglich";
    await assert.rejects(t.run(gespeichert, ctx), /inzwischen geändert.*Ich lösche nichts/);
    zeitplaene[0]!.tage = "mo,mi"; // nur anders geschrieben: derselbe Plan
    zeitplaene[0]!.auftrag = "Etwas ganz anderes";
    await assert.rejects(t.run(gespeichert, ctx), /inzwischen geändert.*Ich lösche nichts/);
    assert.equal(zeitplaene.length, 1);
    // Alte Freigabe (nur der Name festgehalten): nichts löschen
    await assert.rejects(t.run({ id: 8, erwartet_name: "Morgen" }, ctx), /älteren Version.*Ich lösche nichts/);
    zeitplaene[0]!.auftrag = "Briefing";
    assert.equal(await t.run(gespeichert, ctx), "Gelöscht.");
    assert.equal(zeitplaene.length, 0);
  });

  it("zeitplan_loeschen: von Hand bearbeiteter Eintrag ohne zeit oder tage lässt sich löschen, nicht «ältere Version»", async () => {
    // So steht es in einer von Hand bearbeiteten data/zeitplaene.json: läuft nie, soll aber per Chat entfernbar sein
    zeitplaene.push({ id: 12, name: "Kaputt", zeit: "07:00", auftrag: "x" } as never, { id: 13, name: "Ohne Zeit", tage: "taeglich", auftrag: "y" } as never);
    const t = werkzeug("zeitplan_loeschen");
    const ohneTage = t.festhalten!({ id: 12 });
    assert.deepEqual(ohneTage, { id: 12, erwartet_name: "Kaputt", erwartet_zeit: "07:00", erwartet_tage: "", erwartet_auftrag: "x" });
    const ohneZeit = t.festhalten!({ id: 13 });
    assert.equal(ohneZeit.erwartet_zeit, "");
    // Die Freigabe benennt das Fehlende, statt «undefined» zu zeigen; die Liste ebenso
    assert.equal(t.summary!({ id: 12 }), "Zeitplan #12 «Kaputt» löschen (ohne Tage um 07:00)");
    assert.equal(t.summary!({ id: 13 }), "Zeitplan #13 «Ohne Zeit» löschen (taeglich um ohne Uhrzeit)");
    zeitplaene.push({ id: 15, auftrag: "leer" } as never);
    assert.equal(t.summary!({ id: 15 }), "Zeitplan #15 «ohne Namen» löschen (ohne Tage um ohne Uhrzeit)");
    const liste = String(await werkzeug("zeitplaene_anzeigen").run({}, ctx));
    assert.doesNotMatch(liste, /undefined/);
    assert.match(liste, /#12 Kaputt · ohne Tage 07:00 · x/);
    assert.equal(await t.run(t.festhalten!({ id: 15 }), ctx), "Gelöscht.");
    assert.equal(await t.run(ohneTage, ctx), "Gelöscht.");
    assert.equal(await t.run(ohneZeit, ctx), "Gelöscht.");
    assert.equal(zeitplaene.length, 0);
    // Wird ein fehlendes Feld inzwischen gesetzt, gilt das weiterhin als Änderung
    zeitplaene.push({ id: 14, name: "Halb", zeit: "07:00", auftrag: "z" } as never);
    const auftrag = t.festhalten!({ id: 14 });
    zeitplaene[0]!.tage = "taeglich";
    await assert.rejects(t.run(auftrag, ctx), /Zeitplan #14 wurde inzwischen geändert, Sir\. Ich lösche nichts\./);
    assert.equal(zeitplaene.length, 1);
    zeitplaene.length = 0;
  });

  it("wache_loeschen: von Hand bearbeiteter Eintrag ohne frage oder kamera lässt sich löschen, nicht «nennt keine Wache»", async () => {
    // So steht es in einer von Hand bearbeiteten data/wachen.json (cameras.ts übernimmt die Einträge ungeprüft)
    dynamicWachen.push({ id: 40, kamera: "balkon", alle_minuten: 60 } as never, { id: 41, frage: "Licht an?", alle_minuten: 60 } as never);
    const t = werkzeug("wache_loeschen");
    const ohneFrage = t.festhalten!({ id: 40 });
    assert.deepEqual(ohneFrage, { id: 40, erwartet_kamera: "balkon", erwartet_frage: "" });
    const ohneKamera = t.festhalten!({ id: 41 });
    assert.deepEqual(ohneKamera, { id: 41, erwartet_kamera: "", erwartet_frage: "Licht an?" });
    // Die Freigabe benennt das Fehlende, statt «undefined» zu zeigen; die Liste ebenso
    assert.equal(t.summary!({ id: 40 }), "Wache #40 löschen: balkon – ohne Frage");
    assert.equal(t.summary!({ id: 41 }), "Wache #41 löschen: ohne Kamera – Licht an?");
    const liste = String(await werkzeug("wachen_anzeigen").run({}, ctx));
    assert.doesNotMatch(liste, /undefined/);
    assert.match(liste, /#40 balkon · alle 60 min \(läuft nicht: Frage fehlt\) · ohne Frage/);
    // Ohne Kamera schaut die Wache nicht hin: die Liste sagt es (gemeinsame Regel wacheZustand)
    assert.match(liste, /#41 ohne Kamera · alle 60 min \(läuft nicht: Kamera fehlt\) · Licht an\?/);
    assert.equal(await t.run(ohneFrage, ctx), "Gelöscht.");
    assert.equal(await t.run(ohneKamera, ctx), "Gelöscht.");
    assert.equal(dynamicWachen.length, 0);
    // Wird ein fehlendes Feld inzwischen gesetzt, gilt das weiterhin als Änderung
    dynamicWachen.push({ id: 42, kamera: "balkon", alle_minuten: 60 } as never);
    const auftrag = t.festhalten!({ id: 42 });
    dynamicWachen[0]!.frage = "Tür offen?";
    await assert.rejects(t.run(auftrag, ctx), { message: "Wache #42 prüft inzwischen etwas anderes, Sir. Ich lösche nichts." });
    assert.equal(dynamicWachen.length, 1);
    dynamicWachen.length = 0;
  });

  it("offene Lösch-Aufträge aus 0.21 (nur {id}) verlangen eine neue Freigabe, statt «nennt keinen» zu melden", async () => {
    zeitplaene.push({ id: 7, name: "News", zeit: "07:00", tage: "werktags", auftrag: "News zusammenfassen" });
    dynamicWachen.push({ id: 3, kamera: "balkon", frage: "Steht die Balkontür offen?", alle_minuten: 60 });
    const plan = werkzeug("zeitplan_loeschen");
    const wache = werkzeug("wache_loeschen");
    await assert.rejects(plan.run({ id: 7 }, ctx), { message: "Die Freigabe für Zeitplan #7 stammt aus einer älteren Version, Sir. Ich lösche nichts – bitte neu beantragen." });
    await assert.rejects(wache.run({ id: 3 }, ctx), { message: "Die Freigabe für Wache #3 stammt aus einer älteren Version, Sir. Ich lösche nichts – bitte neu beantragen." });
    assert.equal(zeitplaene.length, 1);
    assert.equal(dynamicWachen.length, 1);
    zeitplaene.length = 0;
    dynamicWachen.length = 0;
  });

  it("Ziel fehlte beim Anlegen (null) → «nennt keinen», nichts gelöscht", async () => {
    const plan = werkzeug("zeitplan_loeschen");
    const wache = werkzeug("wache_loeschen");
    const planAuftrag = plan.festhalten!({ id: 9 });
    const wacheAuftrag = wache.festhalten!({ id: 9 });
    // Erst nach dem Anlegen des Auftrags taucht ein Eintrag mit dieser Nummer auf
    zeitplaene.push({ id: 9, name: "Spät", zeit: "22:00", tage: "taeglich", auftrag: "x" });
    dynamicWachen.push({ id: 9, kamera: "balkon", frage: "Licht an?", alle_minuten: 60 });
    await assert.rejects(plan.run(planAuftrag, ctx), { message: "Die Freigabe nennt keinen Zeitplan #9, Sir. Ich lösche nichts." });
    await assert.rejects(wache.run(wacheAuftrag, ctx), { message: "Die Freigabe nennt keine Wache #9, Sir. Ich lösche nichts." });
    assert.equal(zeitplaene.length, 1);
    assert.equal(dynamicWachen.length, 1);
    zeitplaene.length = 0;
    dynamicWachen.length = 0;
  });

  it("wache_loeschen löscht nur, was die Freigabe nannte", async () => {
    dynamicWachen.push({ id: 3, kamera: "balkon", frage: "Steht die Balkontür offen?", alle_minuten: 60 });
    const t = werkzeug("wache_loeschen");
    const gespeichert = t.festhalten!({ id: 3 });
    assert.deepEqual(gespeichert, { id: 3, erwartet_kamera: "balkon", erwartet_frage: "Steht die Balkontür offen?" });
    await assert.rejects(t.run({ id: 3 }, ctx), /Ich lösche nichts/);
    dynamicWachen[0]!.frage = "Brennt Licht?";
    await assert.rejects(t.run(gespeichert, ctx), /prüft inzwischen etwas anderes, Sir\. Ich lösche nichts\./);
    assert.equal(dynamicWachen.length, 1);
    dynamicWachen[0]!.frage = "Steht die Balkontür offen?";
    assert.equal(await t.run(gespeichert, ctx), "Gelöscht.");
    assert.equal(dynamicWachen.length, 0);
  });

  it("Werkzeuge vergeben gelöschte IDs nie neu", async () => {
    const { state } = await import("../src/state.js");
    // zeitplan_erstellen gibt es nur mit Telegram (Meldungen); kein Versand in diesem Test
    const vorher = config.telegramToken;
    (config as { telegramToken?: string }).telegramToken = "attrappe";
    const neu = werkzeug("zeitplan_erstellen");
    (config as { telegramToken?: string }).telegramToken = vorher;
    const a = await neu.run({ name: "A", zeit: "07:00", tage: "taeglich", auftrag: "x" }, ctx);
    const idA = Number(/#(\d+)/.exec(String(a))![1]);
    zeitplaene.length = 0; // höchsten Eintrag entfernen
    const b = await neu.run({ name: "B", zeit: "07:00", tage: "taeglich", auftrag: "y" }, ctx);
    assert.equal(Number(/#(\d+)/.exec(String(b))![1]), idA + 1);
    assert.equal(state.naechsteZeitplanId, idA + 2);
    zeitplaene.length = 0;
    const wache = werkzeug("wache_erstellen");
    const w1 = await wache.run({ kamera: "balkon", frage: "Tür offen?", alle_minuten: 30 }, ctx);
    const idW = Number(/#(\d+)/.exec(String(w1))![1]);
    dynamicWachen.length = 0;
    const w2 = await wache.run({ kamera: "balkon", frage: "Licht an?", alle_minuten: 30 }, ctx);
    assert.equal(Number(/#(\d+)/.exec(String(w2))![1]), idW + 1);
    dynamicWachen.length = 0;
  });
});

describe("Freigabe-Text zeigt genau, was angelegt wird", () => {
  const mitTelegram = <T,>(f: () => T): T => {
    const vorher = config.telegramToken;
    (config as { telegramToken?: string }).telegramToken = "attrappe";
    try { return f(); } finally { (config as { telegramToken?: string }).telegramToken = vorher; }
  };

  it("zeitplan_erstellen: der ganze Auftrag steht in der Freigabe, nicht nur der Anfang", () => {
    const t = mitTelegram(() => werkzeug("zeitplan_erstellen"));
    const auftrag = "Fasse meine neuen Mails zusammen. " + "x".repeat(1450) + " VERSTECKT-ENDE";
    assert.equal(auftrag.length > 1400 && auftrag.length <= 2000, true);
    const text = t.summary!({ name: " Morgenmails ", zeit: "07:00", tage: "Mo, Fr", auftrag });
    assert.equal(text, `Zeitplan «Morgenmails» mo,fr um 07:00: ${auftrag}`);
    assert.ok(text.endsWith("VERSTECKT-ENDE"));
    assert.ok(text.length < 4096); // passt in eine Telegram-Nachricht
    assert.match(t.summary!({ name: "", zeit: "25:00", tage: "x", auftrag: "" }), /^Zeitplan \(ungültig\): Name: 1 bis 60 Zeichen/);
  });

  it("wache_erstellen: die ganze Frage samt Bedingung steht in der Freigabe", () => {
    const t = werkzeug("wache_erstellen");
    const frage = "Steht die Balkontür offen? " + "y".repeat(260) + " ENDE";
    assert.equal(frage.length <= 300, true);
    assert.equal(t.summary!({ kamera: "balkon", frage, alle_minuten: 30 }), `Wache auf «balkon» alle 30 min: ${frage}`);
    assert.equal(t.summary!({ kamera: "balkon", frage: "Licht an?", alle_minuten: 30, nur_wenn: "nacht", ruhe_minuten: 60 }), "Wache auf «balkon» alle 30 min (nur nacht, Ruhe 60 min): Licht an?");
    assert.match(t.summary!({ kamera: "garage", frage: "x", alle_minuten: 30 }), /^Wache \(ungültig\): Diese Kamera kenne ich nicht/);
  });
});

describe("Speicherfehler: die Werkzeuge nehmen die Änderung im Speicher zurück", () => {
  // Ein Verzeichnis an der Stelle der .tmp-Datei lässt das atomare Schreiben scheitern (wie ENOSPC/EACCES)
  const sperren = (datei: string) => mkdirSync(`data/${datei}.tmp`, { recursive: true });
  const entsperren = (datei: string) => rmSync(`data/${datei}.tmp`, { recursive: true, force: true });
  afterEach(() => { entsperren("zeitplaene.json"); entsperren("wachen.json"); zeitplaene.length = 0; dynamicWachen.length = 0; });

  it("zeitplan_erstellen: nichts bleibt im Speicher, ein zweiter Versuch legt genau einen an", async () => {
    const vorher = config.telegramToken;
    (config as { telegramToken?: string }).telegramToken = "attrappe";
    const t = werkzeug("zeitplan_erstellen");
    (config as { telegramToken?: string }).telegramToken = vorher;
    sperren("zeitplaene.json");
    await assert.rejects(t.run({ name: "Morgen", zeit: "07:00", tage: "taeglich", auftrag: "Briefing" }, ctx));
    assert.equal(zeitplaene.length, 0);
    entsperren("zeitplaene.json");
    await t.run({ name: "Morgen", zeit: "07:00", tage: "taeglich", auftrag: "Briefing" }, ctx);
    assert.equal(zeitplaene.length, 1);
    assert.equal(JSON.parse(readFileSync("data/zeitplaene.json", "utf8")).length, 1);
  });

  it("zeitplan_loeschen: der Zeitplan bleibt im Speicher, wenn nicht gespeichert werden konnte", async () => {
    zeitplaene.push({ id: 20, name: "A", zeit: "06:00", tage: "taeglich", auftrag: "a" }, { id: 21, name: "B", zeit: "07:00", tage: "werktags", auftrag: "b" });
    const t = werkzeug("zeitplan_loeschen");
    const gespeichert = t.festhalten!({ id: 20 });
    sperren("zeitplaene.json");
    await assert.rejects(t.run(gespeichert, ctx));
    assert.deepEqual(zeitplaene.map((z) => z.id), [20, 21]);
  });

  it("wache_erstellen und wache_loeschen: Stand im Speicher wie vorher", async () => {
    sperren("wachen.json");
    await assert.rejects(werkzeug("wache_erstellen").run({ kamera: "balkon", frage: "Tür offen?", alle_minuten: 30 }, ctx));
    assert.equal(dynamicWachen.length, 0);
    dynamicWachen.push({ id: 30, kamera: "balkon", frage: "Licht an?", alle_minuten: 60 }, { id: 31, kamera: "balkon", frage: "Tür zu?", alle_minuten: 60 });
    const t = werkzeug("wache_loeschen");
    await assert.rejects(t.run(t.festhalten!({ id: 30 }), ctx));
    assert.deepEqual(dynamicWachen.map((w) => w.id), [30, 31]);
  });
});
