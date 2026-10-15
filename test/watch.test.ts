import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
// Wächter: läuft ein Test erst nach den Root-after-Hooks (echtes fetch, Projekt als Arbeitsverzeichnis), scheitert er laut,
// statt echte Dienste anzufragen oder data/postausgang.json im Projekt zu schreiben
let wurzelBeendet = false;
after(() => { wurzelBeendet = true; process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

// ---------- fetch-Attrappe: Frigate liefert Bilder, Telegram je nach Test ok oder Netzfehler ----------

const aufrufe: string[] = [];
let telegramGestoert = false;
let frigateFehler: Error | undefined;
let beiTelegram: ((methode: string) => void) | undefined;
let beiFrigate: ((nummer: number) => void) | undefined;
const echteFetch = globalThis.fetch;
const netz = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });

globalThis.fetch = (async (eingabe: string | URL | Request) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (url.startsWith("http://frigate.test:5000/")) {
    aufrufe.push("frigate");
    beiFrigate?.(aufrufe.filter((a) => a === "frigate").length);
    if (frigateFehler) throw frigateFehler;
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } });
  }
  const m = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(url);
  if (m) {
    aufrufe.push(m[1]!);
    beiTelegram?.(m[1]!);
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
const { onCameraEvent, wachenTick, bedingung } = await import("../src/watch.js");
const { state } = await import("../src/state.js");
const { config } = await import("../src/config.js");
// Ab hier kein Top-Level-await mehr: Suiten nach einem await würden erst registriert, wenn node:test die Root-Ebene
// womöglich schon abgeschlossen hat (Root-after-Hooks gelaufen, echtes fetch, Projekt als Arbeitsverzeichnis)

// Claude schaut hin: Antwort fest vorgegeben, keine echte API
let claudeAntwort = "JA\nEine Person steht beim Tor.";
let beiClaude: (() => void) | undefined;
let claudeAufrufe = 0;
// Welche Fragen gingen an die API (Text des Auftrags, ohne Bild)
const claudeFragen: string[] = [];
type Auftrag = { messages?: { content?: { type: string; text?: string }[] }[] };
(anthropic().messages as unknown as { create: (a: Auftrag) => Promise<unknown> }).create = async (a: Auftrag) => {
  claudeAufrufe++;
  claudeFragen.push((a.messages ?? []).flatMap((m) => m.content ?? []).map((b) => b.text ?? "").join(" "));
  beiClaude?.();
  return { content: [{ type: "text", text: claudeAntwort }], usage: { input_tokens: 1, output_tokens: 1 } };
};

const postausgang = (): { text: string }[] => {
  try {
    return JSON.parse(readFileSync("data/postausgang.json", "utf8")) as { text: string }[];
  } catch {
    return [];
  }
};

const tempEcht = realpathSync(temp);
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
  // Wächter zuletzt, damit afterEach die Konsole sicher zurückgibt
  assert.equal(wurzelBeendet, false, "Test läuft nach den Root-after-Hooks (Top-Level-await zwischen describe-Blöcken?)");
  assert.equal(process.cwd(), tempEcht, "Arbeitsverzeichnis ist nicht das Temp-Verzeichnis");
  assert.notEqual(globalThis.fetch, echteFetch, "echtes fetch aktiv statt der Attrappe");
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

describe("Notaus und Notfall während laufender Wache oder Meldung", () => {
  const zweiteWache = { kamera: "hof", frage: "Steht das Tor offen?", alle_minuten: 1, ruhe_minuten: 0 };
  beforeEach(() => {
    telegramGestoert = false;
    claudeAntwort = "JA\nEine Person steht beim Tor.";
    claudeAufrufe = 0;
    assert.equal(postausgang().length, 0);
  });
  afterEach(() => {
    beiClaude = undefined;
    beiTelegram = undefined;
    beiFrigate = undefined;
    telegramGestoert = false;
    state.paused = false;
    state.notfall = { aktiv: false };
    const i = cameras.dynamicWachen.indexOf(zweiteWache);
    if (i >= 0) cameras.dynamicWachen.splice(i, 1);
    delete cameras.cameras.hof!.melden!.beschreiben;
  });

  it("/pause während look(): kein Bild an Telegram, kein Postausgang, die zweite Wache läuft nicht mehr", async () => {
    cameras.dynamicWachen.push(zweiteWache);
    beiClaude = () => { state.paused = true; };
    jetzt += 10 * 60_000;
    await wachenTick(jetzt);
    assert.equal(claudeAufrufe, 1, "nur die erste Wache hat ein Bild an die API geschickt");
    assert.deepEqual(aufrufe, ["frigate"]);
    assert.equal(postausgang().length, 0);
  });

  it("Ohne Notaus laufen beide Wachen (Gegenprobe)", async () => {
    cameras.dynamicWachen.push(zweiteWache);
    jetzt += 10 * 60_000;
    await wachenTick(jetzt);
    assert.equal(claudeAufrufe, 2);
    assert.deepEqual(aufrufe, ["frigate", "sendPhoto", "frigate", "sendPhoto"]);
  });

  it("/notfall während des gescheiterten Bildversands einer Wache: Text geht nicht in den Postausgang", async () => {
    telegramGestoert = true;
    beiTelegram = () => { state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" }; state.paused = true; };
    jetzt += 10 * 60_000;
    await wachenTick(jetzt);
    assert.equal(postausgang().length, 0);
  });

  it("/notfall während look() einer Kamera-Meldung: kein sendPhoto, kein Postausgang, nicht gemeldet", async () => {
    cameras.cameras.hof!.melden!.beschreiben = true;
    beiClaude = () => { state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" }; state.paused = true; };
    assert.equal(await onCameraEvent({ camera: "hof", label: "person", id: "ev-notfall", hasSnapshot: true }), false);
    assert.equal(claudeAufrufe, 1);
    assert.deepEqual(aufrufe, ["frigate"]);
    assert.equal(postausgang().length, 0);
  });

  it("/pause während des Schnappschusses einer Kamera-Meldung: nichts geht hinaus", async () => {
    frigateFehler = undefined;
    // Der Schnappschuss selbst läuft noch, danach greift der Notaus
    const echt = globalThis.fetch;
    globalThis.fetch = (async (e: string | URL | Request, i?: RequestInit) => {
      const r = await echt(e, i);
      if (String(e instanceof Request ? e.url : e).startsWith("http://frigate.test:5000/")) state.paused = true;
      return r;
    }) as typeof fetch;
    try {
      assert.equal(await onCameraEvent({ camera: "hof", label: "person", id: "ev-pause", hasSnapshot: true }), false);
    } finally {
      globalThis.fetch = echt;
    }
    assert.deepEqual(aufrufe, ["frigate"]);
    assert.equal(postausgang().length, 0);
  });

  it("/pause während des gescheiterten Bildversands einer Kamera-Meldung: kein Postausgang-Eintrag", async () => {
    telegramGestoert = true;
    beiTelegram = () => { state.paused = true; };
    await onCameraEvent({ camera: "hof", label: "person", id: "ev-pause-senden", hasSnapshot: true });
    assert.equal(postausgang().length, 0);
  });

  it("/notfall während des Frigate-Abrufs einer Wache: kein Bild an die API, nichts an Telegram, kein Postausgang", async () => {
    cameras.dynamicWachen.push(zweiteWache);
    beiFrigate = () => { state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" }; state.paused = true; };
    jetzt += 10 * 60_000;
    await wachenTick(jetzt);
    assert.equal(claudeAufrufe, 0, "das Standbild geht nicht mehr an Claude");
    assert.deepEqual(aufrufe, ["frigate"], "kein sendPhoto, die zweite Wache holt kein Bild mehr");
    assert.equal(postausgang().length, 0);
  });

  it("/pause während des Frigate-Abrufs einer Wache: kein Bild an die API, nichts an Telegram, kein Postausgang", async () => {
    beiFrigate = () => { state.paused = true; };
    jetzt += 10 * 60_000;
    await wachenTick(jetzt);
    assert.equal(claudeAufrufe, 0);
    assert.deepEqual(aufrufe, ["frigate"]);
    assert.equal(postausgang().length, 0);
  });
});

describe("Wache gelöscht, während der Tick noch läuft", () => {
  // Dynamische Wachen tragen eine ID (wie aus Kommandozentrale oder wache_anlegen)
  const wacheA = { id: 901, kamera: "hof", frage: "Liegt ein Paket vor der Tür?", alle_minuten: 1, ruhe_minuten: 0 };
  const wacheB = { id: 902, kamera: "hof", frage: "Brennt im Hof Licht?", alle_minuten: 1, ruhe_minuten: 0 };
  const entfernen = (w: object) => {
    const i = cameras.dynamicWachen.indexOf(w as (typeof cameras.dynamicWachen)[number]);
    if (i >= 0) cameras.dynamicWachen.splice(i, 1);
  };
  beforeEach(() => {
    telegramGestoert = false;
    claudeAntwort = "JA\nEine Person steht beim Tor.";
    claudeAufrufe = 0;
    cameras.dynamicWachen.push(wacheA, wacheB);
  });
  afterEach(() => {
    beiClaude = undefined;
    beiFrigate = undefined;
    entfernen(wacheA);
    entfernen(wacheB);
  });

  it("eine schon gelöschte spätere Wache schickt kein Bild mehr an die API und meldet nichts", async () => {
    // Während die erste Wache (cameras.json) hinschaut, löscht der Nutzer Wache B
    beiClaude = () => { if (claudeAufrufe === 1) entfernen(wacheB); };
    jetzt += 10 * 60_000;
    await wachenTick(jetzt);
    assert.equal(claudeAufrufe, 2, "nur die Wache aus cameras.json und Wache A schauen hin");
    assert.deepEqual(aufrufe, ["frigate", "sendPhoto", "frigate", "sendPhoto"]);
    assert.equal(postausgang().length, 0);
  });

  it("während look() gelöschte Wache: keine Meldung an Telegram, kein Postausgang", async () => {
    // Wache A wird gelöscht, während ihr eigenes Bild geprüft wird; B läuft danach normal
    beiClaude = () => { if (claudeAufrufe === 2) entfernen(wacheA); };
    jetzt += 10 * 60_000;
    await wachenTick(jetzt);
    assert.equal(claudeAufrufe, 3);
    assert.deepEqual(aufrufe, ["frigate", "sendPhoto", "frigate", "frigate", "sendPhoto"]);
    assert.equal(postausgang().length, 0);
  });

  it("während des Frigate-Abrufs gelöschte Wache: ihr Bild geht nicht an die API, keine Meldung, kein Postausgang", async () => {
    // Abruf 1 = Wache aus cameras.json, Abruf 2 = Wache A: genau dann löscht der Nutzer A; B läuft danach normal
    beiFrigate = (n) => { if (n === 2) entfernen(wacheA); };
    claudeFragen.length = 0;
    jetzt += 10 * 60_000;
    await wachenTick(jetzt);
    assert.equal(claudeFragen.filter((f) => f.includes(wacheA.frage)).length, 0, "kein Bild der gelöschten Wache an Claude");
    assert.equal(claudeAufrufe, 2, "nur die Wache aus cameras.json und Wache B schauen hin");
    assert.deepEqual(aufrufe, ["frigate", "sendPhoto", "frigate", "frigate", "sendPhoto"]);
    assert.equal(postausgang().length, 0);
  });

  it("einzige laufende Wache während des Frigate-Abrufs gelöscht: kein einziger Claude-Aufruf", async () => {
    // Erster Takt: die Wache aus cameras.json, A und B laufen normal; einen halben Takt später ist nur die neue Wache dran
    const takt = jetzt + 10 * 60_000;
    jetzt = takt;
    await wachenTick(takt);
    aufrufe.length = 0;
    claudeAufrufe = 0;
    const neu = { id: 903, kamera: "hof", frage: "Ist die Garage offen?", alle_minuten: 1, ruhe_minuten: 0 };
    cameras.dynamicWachen.push(neu);
    beiFrigate = () => entfernen(neu);
    try {
      await wachenTick(takt + 30_000); // alle_minuten: die übrigen Wachen sind noch nicht wieder dran
    } finally {
      entfernen(neu);
    }
    assert.equal(claudeAufrufe, 0, "das Standbild der gelöschten Wache geht nicht an Claude");
    assert.deepEqual(aufrufe, ["frigate"], "kein sendPhoto");
    assert.equal(postausgang().length, 0);
  });

  it("Gegenprobe ohne Löschen: alle drei Wachen melden", async () => {
    jetzt += 10 * 60_000;
    await wachenTick(jetzt);
    assert.equal(claudeAufrufe, 3);
    assert.equal(aufrufe.filter((a) => a === "sendPhoto").length, 3);
  });
});

describe("Wache aus cameras.json mit kopiertem Feld «id»", () => {
  // Der Nutzer kopiert eine Wache aus data/wachen.json (samt "id") nach cameras.json – sie muss weiterhin hinschauen
  const kopiert = { id: 3, frage: "Steht ein Velo vor dem Tor?", alle_minuten: 1, ruhe_minuten: 0 };
  const liste = () => cameras.cameras.hof!.wachen! as unknown as object[];
  beforeEach(() => {
    telegramGestoert = false;
    claudeAntwort = "JA\nEin Velo lehnt am Tor.";
    claudeAufrufe = 0;
    liste().push(kopiert);
  });
  afterEach(() => {
    const i = liste().indexOf(kopiert);
    if (i >= 0) liste().splice(i, 1);
  });

  it("allWachen liefert sie ohne ID: Kommandozentrale und Werkzeuge führen sie als cameras.json, nicht bearbeitbar", () => {
    const w = cameras.allWachen().find((x) => x.frage === kopiert.frage);
    assert.ok(w, "Wache ist in allWachen()");
    assert.equal("id" in w, false, "kein Feld «id»");
    assert.equal(w.kamera, "hof");
    assert.equal(kopiert.id, 3, "cameras.json selbst bleibt unverändert");
  });

  it("schaut bei jedem Takt hin und meldet wie jede andere Wache aus cameras.json", async () => {
    jetzt += 10 * 60_000;
    await wachenTick(jetzt);
    assert.equal(claudeAufrufe, 2, "beide Wachen aus cameras.json schauen hin");
    assert.deepEqual(aufrufe, ["frigate", "sendPhoto", "frigate", "sendPhoto"]);
    assert.equal(postausgang().length, 0);
  });

  it("gilt auch nicht als gelöscht, wenn eine dynamische Wache mit derselben ID existiert und gelöscht wird", async () => {
    const dyn = { id: 3, kamera: "hof", frage: "Liegt Schnee im Hof?", alle_minuten: 1, ruhe_minuten: 0 };
    cameras.dynamicWachen.push(dyn);
    // Während die erste Wache hinschaut, löscht der Nutzer die dynamische Wache 3
    beiClaude = () => {
      if (claudeAufrufe === 1) cameras.dynamicWachen.splice(cameras.dynamicWachen.indexOf(dyn), 1);
    };
    try {
      jetzt += 10 * 60_000;
      await wachenTick(jetzt);
    } finally {
      beiClaude = undefined;
      const i = cameras.dynamicWachen.indexOf(dyn);
      if (i >= 0) cameras.dynamicWachen.splice(i, 1);
    }
    assert.equal(claudeAufrufe, 2, "beide Wachen aus cameras.json schauen hin, die gelöschte dynamische nicht");
    assert.deepEqual(aufrufe, ["frigate", "sendPhoto", "frigate", "sendPhoto"]);
    assert.equal(postausgang().length, 0);
  });
});

describe("Wache ohne gültiges «alle_minuten» (cameras.json oder von Hand in data/wachen.json)", () => {
  // Laufen nie durch pruefeWache: fehlendes Feld (Tippfehler), null, Text, 0 oder negativ ergäben sonst NaN bzw. jede Minute ein Bild
  const ohne = { frage: "Ist die Kellertür zu?", alle_minuen: 30, ruhe_minuten: 0 };
  const dynamisch = [
    { id: 951, kamera: "hof", frage: "Steht ein Auto in der Einfahrt?", alle_minuten: null, ruhe_minuten: 0 },
    { id: 952, kamera: "hof", frage: "Brennt das Gartenlicht?", alle_minuten: "oft", ruhe_minuten: 0 },
    { id: 953, kamera: "hof", frage: "Liegt Laub auf dem Weg?", alle_minuten: 0, ruhe_minuten: 0 },
    { id: 954, kamera: "hof", frage: "Ist der Briefkasten voll?", alle_minuten: -5, ruhe_minuten: 0 },
    { id: 955, kamera: "hof", frage: "Regnet es?", ruhe_minuten: 0 },
  ];
  const liste = () => cameras.cameras.hof!.wachen! as unknown as object[];
  const ungueltig = [ohne.frage, ...dynamisch.map((w) => w.frage)];
  beforeEach(() => {
    telegramGestoert = false;
    claudeAntwort = "NEIN\nNichts Auffälliges.";
    claudeAufrufe = 0;
    claudeFragen.length = 0;
    liste().push(ohne);
    cameras.dynamicWachen.push(...(dynamisch as unknown as (typeof cameras.dynamicWachen)[number][]));
  });
  afterEach(() => {
    const i = liste().indexOf(ohne);
    if (i >= 0) liste().splice(i, 1);
    for (const w of dynamisch) {
      const j = cameras.dynamicWachen.indexOf(w as unknown as (typeof cameras.dynamicWachen)[number]);
      if (j >= 0) cameras.dynamicWachen.splice(j, 1);
    }
  });

  it("zwei Takte im Abstand von 60 s: nur die gültige Wache holt ein Standbild, keine ungültige schickt eines an die API", async () => {
    const zeilen: string[] = [];
    console.error = (...a: unknown[]) => { zeilen.push(a.map(String).join(" ")); };
    jetzt += 10 * 60_000;
    await wachenTick(jetzt);
    jetzt += 60_000;
    await wachenTick(jetzt);
    // Nur die Wache aus cameras.json mit alle_minuten: 1 läuft, je einmal pro Takt
    assert.equal(aufrufe.filter((a) => a === "frigate").length, 2, "Standbilder nur für die gültige Wache");
    assert.equal(claudeAufrufe, 2);
    for (const f of ungueltig) assert.equal(claudeFragen.filter((q) => q.includes(f)).length, 0, `kein Bild für «${f}» an Claude`);
    // Einmal pro ungültiger Wache gemeldet, nicht pro Takt, und ohne Frage-Text. Die Wache aus cameras.json ohne
    // «alle_minuten» lässt schon die Eintragsprüfung weg (kameraWacheEintrag): sie erscheint gar nicht erst im Takt.
    assert.equal(zeilen.filter((z) => z.includes("ohne gültiges «alle_minuten»")).length, dynamisch.length);
    assert.ok(!cameras.allWachen().some((w) => w.frage === ohne.frage), "ohne «alle_minuten» nicht in allWachen");
    for (const f of ungueltig) assert.ok(!zeilen.some((z) => z.includes(f)), "kein Frage-Text im Log");
  });

  it("Gegenprobe: Ziffernfolge wie «1» (von Hand) läuft weiterhin wie bisher", async () => {
    const text = { id: 956, kamera: "hof", frage: "Ist das Garagentor zu?", alle_minuten: "1", ruhe_minuten: 0 };
    cameras.dynamicWachen.push(text as unknown as (typeof cameras.dynamicWachen)[number]);
    try {
      jetzt += 10 * 60_000;
      await wachenTick(jetzt);
    } finally {
      cameras.dynamicWachen.splice(cameras.dynamicWachen.indexOf(text as unknown as (typeof cameras.dynamicWachen)[number]), 1);
    }
    assert.equal(claudeFragen.filter((q) => q.includes(text.frage)).length, 1);
    assert.equal(aufrufe.filter((a) => a === "frigate").length, 2);
  });
});

describe("Wache mit ungültiger «ruhe_minuten» (cameras.json oder von Hand in data/wachen.json)", () => {
  // Laufen nie durch pruefeWache: Text oder Objekt ergäben NaN, null 0 – jedes JA ginge bei jedem Takt mit Bild hinaus.
  // Wie die Anzeige der Kommandozentrale gilt dann die Standard-Ruhezeit von 30 Minuten.
  const kaputt = [
    { id: 971, kamera: "hof", frage: "Steht die Gartentür offen?", alle_minuten: 1, ruhe_minuten: "oft" },
    { id: 972, kamera: "hof", frage: "Liegt Werkzeug im Hof?", alle_minuten: 1, ruhe_minuten: { min: 5 } },
    { id: 973, kamera: "hof", frage: "Ist das Velo angeschlossen?", alle_minuten: 1, ruhe_minuten: null },
  ];
  const ausJson = { frage: "Brennt die Hoflampe?", alle_minuten: 1, ruhe_minuten: "lang" };
  const liste = () => cameras.cameras.hof!.wachen! as unknown as object[];
  const fragen = [...kaputt.map((w) => w.frage), ausJson.frage];
  // Wie viele Meldungen gingen je Frage an Telegram (Beschriftung beginnt mit «👁 hof: <Frage>»)
  let meldungen: string[] = [];
  beforeEach(() => {
    telegramGestoert = false;
    claudeAntwort = "JA\nDa ist etwas.";
    claudeAufrufe = 0;
    claudeFragen.length = 0;
    meldungen = [];
    liste().push(ausJson);
    cameras.dynamicWachen.push(...(kaputt as unknown as (typeof cameras.dynamicWachen)[number][]));
  });
  afterEach(() => {
    const i = liste().indexOf(ausJson);
    if (i >= 0) liste().splice(i, 1);
    for (const w of kaputt) {
      const j = cameras.dynamicWachen.indexOf(w as unknown as (typeof cameras.dynamicWachen)[number]);
      if (j >= 0) cameras.dynamicWachen.splice(j, 1);
    }
  });

  it("zwei JA im Abstand von 60 s: je Wache nur eine Meldung, nach 30 Minuten wieder eine", async () => {
    // sendPhoto zählen je Frage: die Beschriftung steht im FormData-Feld «caption»
    const echt = globalThis.fetch;
    globalThis.fetch = (async (e: string | URL | Request, i?: RequestInit) => {
      const body = i?.body;
      if (body instanceof FormData && typeof body.get("caption") === "string") meldungen.push(body.get("caption") as string);
      return echt(e, i);
    }) as typeof fetch;
    const zaehle = (f: string) => meldungen.filter((m) => m.startsWith(`👁 hof: ${f}`)).length;
    try {
      jetzt += 10 * 60_000;
      await wachenTick(jetzt);
      for (const f of fragen) assert.equal(zaehle(f), 1, `erstes JA meldet «${f}»`);
      jetzt += 60_000;
      await wachenTick(jetzt);
      // Alle Wachen schauen erneut hin (Takt 1 Min), melden aber nicht: Ruhezeit 30 Min statt NaN bzw. 0
      for (const f of fragen) assert.equal(claudeFragen.filter((q) => q.includes(f)).length, 2, `«${f}» schaut zweimal hin`);
      for (const f of fragen) assert.equal(zaehle(f), 1, `zweites JA nach 60 s meldet «${f}» nicht erneut`);
      // Gegenprobe in derselben Runde: die Wache mit ruhe_minuten 0 meldet bei jedem JA
      assert.equal(zaehle("Ist jemand im Hof?"), 2);
      jetzt += 30 * 60_000;
      await wachenTick(jetzt);
      for (const f of fragen) assert.equal(zaehle(f), 2, `nach Ablauf der Ruhezeit meldet «${f}» wieder`);
    } finally {
      globalThis.fetch = echt;
    }
    assert.equal(postausgang().length, 0);
  });
});

describe("ruheMinuten: dieselbe Regel wie die Anzeige der Kommandozentrale", () => {
  it("endliche Zahl gilt (negativ = 0), alles andere ergibt den Standard 30", async () => {
    const { ruheMinuten } = await import("../src/watch.js");
    assert.equal(ruheMinuten(0), 0);
    assert.equal(ruheMinuten(45), 45);
    assert.equal(ruheMinuten(-5), 0);
    for (const v of [undefined, null, "oft", "45", {}, [], Number.NaN, Number.POSITIVE_INFINITY, true]) assert.equal(ruheMinuten(v), 30, `ungültig: ${String(v)}`);
  });

  it("eigener Standard (Kamera-Meldungen: 10)", async () => {
    const { ruheMinuten } = await import("../src/watch.js");
    assert.equal(ruheMinuten("oft", 10), 10);
    assert.equal(ruheMinuten(undefined, 10), 10);
    assert.equal(ruheMinuten(3, 10), 3);
  });
});

describe("Kamera-Meldung mit ungültiger «melden.ruhe_minuten» in cameras.json", () => {
  // Text oder Objekt ergäben NaN: dann ginge jedes neue Frigate-Ereignis hinaus. Es gilt der Standard von 10 Minuten.
  const melden = () => cameras.cameras.hof!.melden! as unknown as { labels: string[]; ruhe_minuten: unknown };
  let vorher: unknown;
  beforeEach(() => {
    telegramGestoert = false;
    vorher = melden().ruhe_minuten;
    // Eigenes Label: die Ruhezeit gilt je Kamera und Label, frühere Tests haben «person» schon gemeldet
    melden().labels.push("katze", "hund");
  });
  afterEach(() => {
    melden().ruhe_minuten = vorher;
    melden().labels = melden().labels.filter((l) => l !== "katze" && l !== "hund");
  });

  it("zwei Ereignisse kurz nacheinander mit ruhe_minuten \"oft\": nur eine Meldung", async () => {
    melden().ruhe_minuten = "oft";
    assert.equal(await onCameraEvent({ camera: "hof", label: "katze", id: "ev-oft-1", hasSnapshot: true }), true);
    assert.equal(await onCameraEvent({ camera: "hof", label: "katze", id: "ev-oft-2", hasSnapshot: true }), false);
    assert.equal(aufrufe.filter((a) => a === "sendPhoto").length, 1);
    assert.equal(postausgang().length, 0);
  });

  it("Gegenprobe: ruhe_minuten 0 meldet beide", async () => {
    melden().ruhe_minuten = 0;
    assert.equal(await onCameraEvent({ camera: "hof", label: "hund", id: "ev-null-1", hasSnapshot: true }), true);
    assert.equal(await onCameraEvent({ camera: "hof", label: "hund", id: "ev-null-2", hasSnapshot: true }), true);
    assert.equal(aufrufe.filter((a) => a === "sendPhoto").length, 2);
  });
});

describe("Ungültiges «nur_wenn» (cameras.json oder von Hand bzw. unter 0.21 ungeprüft in data/wachen.json)", () => {
  // Laufen nie durch pruefeWache: null, «Nacht» oder «nachts» fielen sonst auf «abwesend» durch – ohne Präsenz-Entität
  // schaute die Wache nie hin (und galt trotzdem als aktiv), mit ihr stillschweigend nur bei Abwesenheit.
  type W = (typeof cameras.dynamicWachen)[number];
  const ausJson = [
    { frage: "Jemand am Zaun?", alle_minuten: 1, ruhe_minuten: 0, nur_wenn: "Nacht" },
    { frage: "Steht das Hoftor offen?", alle_minuten: 1, ruhe_minuten: 0, nur_wenn: null },
  ];
  const dynamisch = [
    { id: 981, kamera: "hof", frage: "Liegt ein Paket im Hof?", alle_minuten: 1, ruhe_minuten: 0, nur_wenn: "nachts" },
    { id: 982, kamera: "hof", frage: "Brennt das Hoflicht?", alle_minuten: 1, ruhe_minuten: 0, nur_wenn: 5 },
    { id: 983, kamera: "hof", frage: "Ist die Kellertür offen?", alle_minuten: 1, ruhe_minuten: 0, nur_wenn: { wert: "nacht" } },
  ];
  const ungueltig = [...ausJson, ...dynamisch].map((w) => w.frage);
  const liste = () => cameras.cameras.hof!.wachen! as unknown as object[];
  const melden = () => cameras.cameras.hof!.melden! as unknown as { labels: string[]; nur_wenn?: unknown };
  // Präsenz über Home Assistant (Attrappe): «not_home» heisst abwesend
  let haZustand: string | undefined;
  let haAufrufe = 0;
  const echt = globalThis.fetch;
  const vorher = { ha: config.homeAssistant, praesenz: config.presenceEntity };
  let zeilen: string[] = [];
  beforeEach(() => {
    telegramGestoert = false;
    claudeAntwort = "JA\nDa ist etwas.";
    claudeAufrufe = 0;
    claudeFragen.length = 0;
    haAufrufe = 0;
    zeilen = [];
    console.error = (...a: unknown[]) => { zeilen.push(a.map(String).join(" ")); };
    liste().push(...ausJson);
    cameras.dynamicWachen.push(...(dynamisch as unknown as W[]));
    globalThis.fetch = (async (e: string | URL | Request, i?: RequestInit) => {
      const url = String(e instanceof Request ? e.url : e);
      if (url.startsWith("http://ha.test:8123/")) {
        haAufrufe++;
        return new Response(JSON.stringify({ entity_id: "person.labinot", state: haZustand }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return echt(e, i);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = echt;
    config.homeAssistant = vorher.ha;
    config.presenceEntity = vorher.praesenz;
    haZustand = undefined;
    for (const w of ausJson) {
      const i = liste().indexOf(w);
      if (i >= 0) liste().splice(i, 1);
    }
    for (const w of dynamisch) {
      const j = cameras.dynamicWachen.indexOf(w as unknown as W);
      if (j >= 0) cameras.dynamicWachen.splice(j, 1);
    }
    delete melden().nur_wenn;
    melden().labels = melden().labels.filter((l) => l !== "fuchs" && l !== "dachs");
  });
  const abwesend = () => {
    config.homeAssistant = { url: "http://ha.test:8123", token: "nur-attrappe" };
    config.presenceEntity = "person.labinot";
    haZustand = "not_home";
  };

  it("bedingung: ungültige Werte gelten nie, auch nicht bei Abwesenheit; fehlend = immer", async () => {
    abwesend();
    for (const v of [null, "Nacht", "nachts", "ABWESEND", "", 5, {}, [], true]) assert.equal(await bedingung(v), false, `ungültig: ${JSON.stringify(v)}`);
    // Gegenprobe: gültige Werte wie bisher
    assert.equal(await bedingung(undefined), true);
    assert.equal(await bedingung("immer"), true);
    assert.equal(await bedingung("abwesend"), true);
  });

  it("Takt bei Abwesenheit: keine ungültige Wache schickt ein Bild an die API oder meldet (früher: wie «abwesend»)", async () => {
    abwesend();
    jetzt += 10 * 60_000;
    await wachenTick(jetzt);
    for (const f of ungueltig) assert.equal(claudeFragen.filter((q) => q.includes(f)).length, 0, `kein Bild für «${f}» an Claude`);
    // Nur die gültige Wache aus cameras.json schaut hin
    assert.equal(claudeAufrufe, 1);
    assert.deepEqual(aufrufe, ["frigate", "sendPhoto"]);
    assert.equal(postausgang().length, 0);
  });

  it("Gegenprobe: «abwesend» schaut bei Abwesenheit hin und meldet", async () => {
    abwesend();
    const gueltig = { id: 984, kamera: "hof", frage: "Ist die Garage offen?", alle_minuten: 1, ruhe_minuten: 0, nur_wenn: "abwesend" };
    cameras.dynamicWachen.push(gueltig as unknown as W);
    try {
      jetzt += 10 * 60_000;
      await wachenTick(jetzt);
    } finally {
      cameras.dynamicWachen.splice(cameras.dynamicWachen.indexOf(gueltig as unknown as W), 1);
    }
    assert.equal(claudeFragen.filter((q) => q.includes(gueltig.frage)).length, 1);
    assert.ok(haAufrufe >= 1, "Präsenz wurde abgefragt");
  });

  it("ohne Präsenz-Entität: zwei Takte, jede ungültige Wache einmal laut gemeldet (ohne Frage-Text), nie ein Bild", async () => {
    // Für jeden Test neue Wachen-Schlüssel: die Meldung kommt einmal je Wache, nicht pro Takt
    const frisch = [
      { id: 985, kamera: "hof", frage: "Steht ein Velo im Hof?", alle_minuten: 1, ruhe_minuten: 0, nur_wenn: null },
      { id: 986, kamera: "hof", frage: "Ist das Fenster offen?", alle_minuten: 1, ruhe_minuten: 0, nur_wenn: "Nacht" },
    ];
    cameras.dynamicWachen.push(...(frisch as unknown as W[]));
    try {
      jetzt += 10 * 60_000;
      await wachenTick(jetzt);
      jetzt += 60_000;
      await wachenTick(jetzt);
    } finally {
      for (const w of frisch) cameras.dynamicWachen.splice(cameras.dynamicWachen.indexOf(w as unknown as W), 1);
    }
    const alle = [...ungueltig, ...frisch.map((w) => w.frage)];
    for (const f of alle) assert.equal(claudeFragen.filter((q) => q.includes(f)).length, 0, `kein Bild für «${f}» an Claude`);
    assert.equal(aufrufe.filter((a) => a === "frigate").length, 2, "Standbilder nur für die gültige Wache");
    // Die Wachen aus den vorigen Tests sind schon gemeldet: hier nur die beiden neuen, je genau einmal
    assert.equal(zeilen.filter((z) => z.includes("ungültigem «nur_wenn»")).length, frisch.length);
    for (const f of alle) assert.ok(!zeilen.some((z) => z.includes(f)), "kein Frage-Text im Log");
    assert.equal(haAufrufe, 0);
  });

  it("melden mit ungültigem «nur_wenn» bei Abwesenheit: keine Meldung, einmal laut gemeldet", async () => {
    abwesend();
    melden().labels.push("fuchs", "dachs");
    melden().nur_wenn = "Nacht";
    assert.equal(await onCameraEvent({ camera: "hof", label: "fuchs", id: "ev-nurwenn-1", hasSnapshot: true }), false);
    melden().nur_wenn = null;
    assert.equal(await onCameraEvent({ camera: "hof", label: "fuchs", id: "ev-nurwenn-2", hasSnapshot: true }), false);
    assert.deepEqual(aufrufe, [], "kein Schnappschuss, nichts an Telegram");
    assert.equal(zeilen.filter((z) => z.includes("«melden.nur_wenn» bei Kamera «hof» ungültig")).length, 1);
    // Gegenprobe: «abwesend» meldet bei Abwesenheit
    melden().nur_wenn = "abwesend";
    assert.equal(await onCameraEvent({ camera: "hof", label: "dachs", id: "ev-nurwenn-3", hasSnapshot: true }), true);
    assert.deepEqual(aufrufe, ["frigate", "sendPhoto"]);
  });
});

describe("Testdatei selbst: kein Top-Level-await nach dem ersten describe-Block", () => {
  it("alle Importe stehen vor der ersten Suite (sonst laufen spätere Suiten nach den Root-after-Hooks)", () => {
    const quelle = readFileSync(join(projekt, "test", "watch.test.ts"), "utf8");
    const start = quelle.search(/^describe\(/m);
    assert.ok(start > 0, "erste Suite gefunden");
    // Top-Level-Anweisungen stehen in Spalte 0; alles innerhalb von describe/it ist eingerückt
    // Texte in Anführungszeichen (Suiten-Titel) zählen nicht
    const spaeter = quelle.slice(start).split("\n").filter((z) => /^\S/.test(z) && /\bawait\b/.test(z.replace(/"(?:[^"\\]|\\.)*"/g, '""')));
    assert.deepEqual(spaeter, [], "Top-Level-await nach der ersten Suite");
  });
});
