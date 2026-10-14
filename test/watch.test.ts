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
const { onCameraEvent, wachenTick } = await import("../src/watch.js");
const { state } = await import("../src/state.js");

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
