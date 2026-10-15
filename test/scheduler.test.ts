import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/*.json liegt relativ) und Umgebung; nie echte Dienste
const temp = mkdtempSync(join(tmpdir(), "jarvis-scheduler-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.WATCHDOG_MINUTEN = "10";
process.env.ZEITPLAN_NACHHOLEN_MIN = "60";
process.env.RUECKBLICK = "22:30";
process.env.RECHNUNG_ERINNERUNG = "08:30";
process.env.RECHNUNG_VORLAUF_TAGE = "3";
process.env.ZIELCHECK = "so 18:00";

// Kein Netz im Test: jeder echte Aufruf wäre ein Fehler
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

// Bestehende (leere) routinen.json: kein Erststart, die Tests hängen so nicht vom echten Datum ab
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "routinen.json"), "{}");

const { LESENDE_WERKZEUGE, abhaengigkeiten, rechnungsTick, routinenBeimErststart, rueckblickTick, zeitplanTick, zielcheckTick } = await import("../src/scheduler.js");
const { zeitplaene } = await import("../src/zeitplaene.js");
const { HttpFehler, gesundheit } = await import("../src/robust.js");
const { imFenster, todayKey } = await import("../src/time.js");
const { faelligIm } = await import("../src/zeitplaene.js");
const { state } = await import("../src/state.js");
const { addRechnung, rechnungen } = await import("../src/finanzen.js");
const { profil } = await import("../src/profil.js");
const { config } = await import("../src/config.js");
const { activeTools } = await import("../src/tools.js");

/** 10.10.2026 Samstag, 11.10.2026 Sonntag, 12.10.2026 Montag (lokale Zeit Europe/Zurich) */
const am = (tag: number, h: number, m: number) => new Date(2026, 9, tag, h, m, 0, 0);
const ZEITPLAENE_DATEI = join(temp, "data", "zeitplaene.json");
const ROUTINEN_DATEI = join(temp, "data", "routinen.json");

let antworten: string[] = [];
let fehler: unknown[] = [];
let prompts: string[] = [];
let gesendet: string[] = [];
let logs: string[] = [];
const origLog = console.log; const origErr = console.error;

/** Attrappe für Claude: wirft den nächsten geplanten Fehler oder liefert die nächste Antwort */
abhaengigkeiten.handleMessage = async (text: string) => {
  prompts.push(text);
  const f = fehler.shift();
  if (f) throw f;
  return antworten.shift() ?? "Erledigt, Sir.";
};
abhaengigkeiten.sendeSpaeter = async (text: string) => { gesendet.push(text); };

const netzfehler = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
const serverfehler = () => new HttpFehler("503 Service Unavailable", 503);
const clientfehler = () => new HttpFehler("400 Bad Request: max_tokens zu gross", 400);
const ueberlastet = () => new HttpFehler("529 Overloaded", 529);
type Opts = { onStep?: (step: number, tool: string) => void };

/** Attrappe wie runLoop: Runde 1 führt `n` Werkzeuge aus (onStep), der claudeAufruf der nächsten Runde scheitert mit `f` */
function nachSchrittenFehler(n: number, f: () => unknown, werkzeuge: string[] = ["erinnerung"]) {
  return async (text: string, _hooks: unknown, opts: Opts = {}) => {
    prompts.push(text);
    for (let i = 1; i <= n; i++) opts.onStep?.(i, werkzeuge[(i - 1) % werkzeuge.length]!);
    throw f();
  };
}

function plan(id: number, zeit: string, tage = "taeglich", lastRun?: string) {
  zeitplaene.length = 0;
  zeitplaene.push({ id, name: `Plan ${id}`, zeit, tage, auftrag: "Sag mir das Wetter", ...(lastRun ? { lastRun } : {}) });
  return zeitplaene[0]!;
}

beforeEach(() => {
  antworten = []; fehler = []; prompts = []; gesendet = []; logs = [];
  zeitplaene.length = 0;
  rechnungen.length = 0;
  profil.ziele.length = 0;
  state.paused = false;
  gesundheit._reset();
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
});
afterEach(() => { console.log = origLog; console.error = origErr; });

describe("imFenster / faelligIm", () => {
  it("Fenstergrenzen: ab der Minute bis vor dem Fensterende", () => {
    assert.equal(imFenster("08:30", am(10, 8, 29), 60), false);
    assert.equal(imFenster("08:30", am(10, 8, 30), 60), true);
    assert.equal(imFenster("08:30", am(10, 9, 29), 60), true);
    assert.equal(imFenster("08:30", am(10, 9, 30), 60), false);
    assert.equal(imFenster("08:30", am(10, 8, 31), 0), false);
    assert.equal(imFenster("off", am(10, 8, 30), 60), false);
  });

  it("Mitternacht: kein Übertrag, Werktage beachtet", () => {
    assert.equal(imFenster("23:30", am(10, 23, 59), 60), true);
    assert.equal(imFenster("23:30", am(11, 0, 5), 60), false);
    const z = { id: 1, name: "x", zeit: "08:30", tage: "werktags", auftrag: "x" };
    assert.equal(faelligIm(z, am(10, 8, 45), 60), false); // Samstag
    assert.equal(faelligIm(z, am(12, 8, 45), 60), true); // Montag
    assert.equal(faelligIm({ ...z, lastRun: todayKey(am(12, 8, 45)) }, am(12, 8, 45), 60), false);
  });
});

describe("zeitplanTick", () => {
  it("zur Minute: Auftrag läuft, Antwort geht raus, lastRun erst danach gesetzt und gespeichert", async () => {
    const z = plan(1, "08:30");
    antworten = ["Sonnig, 18 Grad."];
    await zeitplanTick(am(10, 8, 30));
    assert.deepEqual(prompts, ["[Zeitplan «Plan 1», läuft automatisch] Sag mir das Wetter"]);
    assert.deepEqual(gesendet, ["🕒 Plan 1\n\nSonnig, 18 Grad."]);
    assert.equal(z.lastRun, "2026-10-10");
    assert.equal((JSON.parse(readFileSync(ZEITPLAENE_DATEI, "utf8")) as { lastRun?: string }[])[0]?.lastRun, "2026-10-10");
    await zeitplanTick(am(10, 8, 31));
    assert.equal(prompts.length, 1); // heute nicht nochmals
  });

  it("von Hand bearbeitet ohne Namen: Auftrag läuft, Titel «ohne Namen» statt «undefined»", async () => {
    zeitplaene.push({ id: 901, zeit: "08:30", tage: "taeglich", auftrag: "Sag mir das Wetter" } as never);
    antworten = ["Sonnig, 18 Grad."];
    await zeitplanTick(am(10, 8, 30));
    assert.equal(prompts[0], "[Zeitplan «ohne Namen», läuft automatisch] Sag mir das Wetter");
    assert.ok(gesendet[0]?.startsWith("🕒 ohne Namen"), gesendet[0]);
    assert.ok([...prompts, ...gesendet].every((t) => !t.includes("undefined")));
  });

  it("verpasst → im Nachholfenster nachgeholt, danach nicht mehr", async () => {
    plan(2, "08:30");
    await zeitplanTick(am(10, 9, 31));
    assert.equal(prompts.length, 0);
    await zeitplanTick(am(10, 9, 15));
    assert.equal(prompts.length, 1);
  });

  it("davor und am falschen Tag: nichts", async () => {
    plan(3, "08:30", "werktags");
    await zeitplanTick(am(10, 8, 20));
    await zeitplanTick(am(10, 8, 30)); // Samstag
    assert.equal(prompts.length, 0);
    assert.equal(zeitplaene[0]!.lastRun, undefined);
  });

  it("vorübergehender Fehler: lastRun bleibt leer, keine Meldung, Wiederholung erst nach 5 Minuten", async () => {
    const z = plan(4, "08:30");
    fehler = [serverfehler()];
    await zeitplanTick(am(10, 8, 30));
    assert.equal(prompts.length, 1);
    assert.equal(z.lastRun, undefined);
    assert.deepEqual(gesendet, []);
    assert.equal(existsSync(ZEITPLAENE_DATEI) && (JSON.parse(readFileSync(ZEITPLAENE_DATEI, "utf8")) as { id: number }[]).some((p) => p.id === 4), false);
    await zeitplanTick(am(10, 8, 33));
    assert.equal(prompts.length, 1); // noch keine 5 Minuten
    fehler = [netzfehler()];
    await zeitplanTick(am(10, 8, 35));
    assert.equal(prompts.length, 2); // zweiter Versuch, wieder vorübergehend
    assert.equal(z.lastRun, undefined);
    antworten = ["Jetzt ging es."];
    await zeitplanTick(am(10, 8, 40));
    assert.equal(prompts.length, 3);
    assert.equal(z.lastRun, "2026-10-10");
    assert.deepEqual(gesendet, ["🕒 Plan 4\n\nJetzt ging es."]);
  });

  it("vorübergehender Fehler ausserhalb des Fensters: kein weiterer Versuch", async () => {
    const z = plan(5, "08:30");
    fehler = [serverfehler()];
    await zeitplanTick(am(10, 9, 27));
    await zeitplanTick(am(10, 9, 35));
    assert.equal(prompts.length, 1);
    assert.equal(z.lastRun, undefined);
  });

  it("dauerhafter Fehler: als gelaufen markiert, genau eine Meldung ohne Geheimnisse", async () => {
    const z = plan(6, "08:30");
    fehler = [clientfehler()];
    await zeitplanTick(am(10, 8, 30));
    assert.equal(z.lastRun, "2026-10-10");
    assert.deepEqual(gesendet, ["⚠️ Zeitplan «Plan 6» ist fehlgeschlagen: 400 Bad Request: max_tokens zu gross"]);
    await zeitplanTick(am(10, 8, 35));
    assert.equal(prompts.length, 1);
    assert.equal(gesendet.length, 1);

    const z2 = plan(7, "08:30");
    fehler = [new Error("Unerwartet: https://api.telegram.org/bot123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789/sendMessage")];
    await zeitplanTick(am(10, 8, 30));
    assert.equal(z2.lastRun, "2026-10-10");
    assert.equal(gesendet.length, 2);
    assert.match(gesendet[1]!, /bot<token>/);
    assert.doesNotMatch(gesendet[1]!, /ABCdef/);
  });

  it("offline: kein Start, eine Log-Zeile pro Störung, nach Erholung läuft er", async () => {
    const z = plan(8, "08:30");
    gesundheit.melde("internet", false, "Netz: ENOTFOUND");
    logs = [];
    await zeitplanTick(am(10, 8, 30));
    await zeitplanTick(am(10, 8, 31));
    await zeitplanTick(am(10, 8, 32));
    assert.equal(prompts.length, 0);
    assert.equal(z.lastRun, undefined);
    assert.equal(logs.filter((l) => l.includes("[scheduler]")).length, 1);
    gesundheit.melde("internet", true);
    await zeitplanTick(am(10, 8, 40));
    assert.equal(prompts.length, 1);
    assert.equal(z.lastRun, "2026-10-10");
    // neue Störung → neue Log-Zeile
    gesundheit.melde("internet", false, "Netz: ENOTFOUND");
    logs = [];
    plan(9, "08:30");
    await zeitplanTick(am(10, 8, 45));
    assert.equal(logs.filter((l) => l.includes("[scheduler]")).length, 1);
  });

  it("Offline-Merker wird auch dann zurückgesetzt, wenn bei Erholung kein Lauf fällig ist", async () => {
    plan(13, "08:30");
    await zeitplanTick(am(10, 8, 0)); // online, nichts fällig: setzt einen alten Merker zurück
    gesundheit.melde("internet", false, "Netz: ENOTFOUND");
    logs = [];
    await zeitplanTick(am(10, 8, 30));
    assert.equal(logs.filter((l) => l.includes("[scheduler]")).length, 1);
    // Internet wieder da, aber erst nach dem Fenster – nichts fällig, kein Lauf
    gesundheit.melde("internet", true);
    await zeitplanTick(am(10, 10, 0));
    await rechnungsTick(am(10, 10, 0));
    assert.equal(prompts.length, 0);
    // zweite Störung: wieder genau eine Log-Zeile
    gesundheit.melde("internet", false, "Netz: ENOTFOUND");
    logs = [];
    plan(14, "22:30");
    await zeitplanTick(am(10, 22, 30));
    await zeitplanTick(am(10, 22, 31));
    assert.equal(logs.filter((l) => l.includes("[scheduler]")).length, 1);
  });

  it("offline auch, wenn Telegram und Claude beide mit Netzfehlern stehen", async () => {
    plan(10, "08:30");
    gesundheit.melde("telegram", false, "telegram.sendMessage: Netz: ECONNREFUSED");
    gesundheit.melde("claude", false, "claude.messages: Zeitlimit: Request timed out.");
    await zeitplanTick(am(10, 8, 30));
    assert.equal(prompts.length, 0);
  });

  it("laufender Auftrag wird nicht ein zweites Mal gestartet", async () => {
    const z = plan(11, "08:30");
    let fertig!: (s: string) => void;
    abhaengigkeiten.handleMessage = (text: string) => { prompts.push(text); return new Promise<string>((r) => { fertig = r; }); };
    const erster = zeitplanTick(am(10, 8, 30));
    await new Promise((r) => setImmediate(r));
    await zeitplanTick(am(10, 8, 31));
    assert.equal(prompts.length, 1);
    assert.equal(z.lastRun, undefined);
    fertig("Fertig.");
    await erster;
    assert.equal(z.lastRun, "2026-10-10");
    assert.deepEqual(gesendet, ["🕒 Plan 11\n\nFertig."]);
    abhaengigkeiten.handleMessage = async (text: string) => { prompts.push(text); const f = fehler.shift(); if (f) throw f; return antworten.shift() ?? "Erledigt, Sir."; };
  });

  it("Notaus: nichts", async () => {
    plan(12, "08:30");
    state.paused = true;
    await zeitplanTick(am(10, 8, 30));
    assert.equal(prompts.length, 0);
  });

  it("Notaus während des ersten Laufs: kein weiterer Zeitplan, nichts gesendet, beide bleiben offen", async () => {
    zeitplaene.length = 0;
    zeitplaene.push(
      { id: 20, name: "A", zeit: "08:00", tage: "taeglich", auftrag: "a" },
      { id: 21, name: "B", zeit: "08:05", tage: "taeglich", auftrag: "b" },
    );
    const [a, b] = [zeitplaene[0]!, zeitplaene[1]!];
    const vorher = abhaengigkeiten.handleMessage;
    // wie runLoop bei Notaus: kein Fehler, nur der Pausentext
    abhaengigkeiten.handleMessage = async (text: string) => { prompts.push(text); state.paused = true; return "Ich bin pausiert (Notaus). In Telegram hebt /weiter das wieder auf."; };
    try {
      await zeitplanTick(am(10, 8, 30));
    } finally {
      abhaengigkeiten.handleMessage = vorher;
    }
    assert.equal(prompts.length, 1);
    assert.equal(a.lastRun, undefined);
    assert.equal(b.lastRun, undefined);
    assert.deepEqual(gesendet, []);
    // nach /weiter im Fenster: beide laufen sofort (keine 5-Minuten-Sperre)
    state.paused = false;
    await zeitplanTick(am(10, 8, 31));
    assert.equal(prompts.length, 3);
    assert.equal(a.lastRun, "2026-10-10");
    assert.equal(b.lastRun, "2026-10-10");
    assert.deepEqual(gesendet, ["🕒 A\n\nErledigt, Sir.", "🕒 B\n\nErledigt, Sir."]);
  });

  it("Notaus mit Fehler während des Laufs: keine Fehlermeldung, Lauf bleibt offen", async () => {
    const z = plan(22, "08:30");
    const vorher = abhaengigkeiten.handleMessage;
    abhaengigkeiten.handleMessage = async (text: string) => { prompts.push(text); state.paused = true; throw new Error("abgebrochen"); };
    try {
      await zeitplanTick(am(10, 8, 30));
    } finally {
      abhaengigkeiten.handleMessage = vorher;
    }
    assert.equal(z.lastRun, undefined);
    assert.deepEqual(gesendet, []);
  });

  it("Löschen während eines Laufs: der nachrückende Zeitplan läuft im selben Tick (Fenster 0)", async () => {
    zeitplaene.length = 0;
    zeitplaene.push(
      { id: 30, name: "A", zeit: "07:00", tage: "taeglich", auftrag: "a" },
      { id: 31, name: "B", zeit: "07:00", tage: "taeglich", auftrag: "b" },
      { id: 32, name: "C", zeit: "07:00", tage: "taeglich", auftrag: "c" },
    );
    const [b, c] = [zeitplaene[1]!, zeitplaene[2]!];
    const vorher = abhaengigkeiten.handleMessage;
    const fensterVorher = config.zeitplanNachholenMin;
    config.zeitplanNachholenMin = 0;
    // Wie das Dashboard (findIndex + splice): A wird gelöscht, während sein Lauf noch dauert
    abhaengigkeiten.handleMessage = async (text: string) => {
      prompts.push(text);
      if (text.endsWith("] a")) zeitplaene.splice(zeitplaene.findIndex((z) => z.id === 30), 1);
      return "Erledigt, Sir.";
    };
    try {
      await zeitplanTick(am(10, 7, 0));
    } finally {
      abhaengigkeiten.handleMessage = vorher;
      config.zeitplanNachholenMin = fensterVorher;
    }
    assert.deepEqual(prompts, [
      "[Zeitplan «A», läuft automatisch] a",
      "[Zeitplan «B», läuft automatisch] b",
      "[Zeitplan «C», läuft automatisch] c",
    ]);
    assert.equal(b.lastRun, "2026-10-10");
    assert.equal(c.lastRun, "2026-10-10");
    assert.deepEqual(zeitplaene.map((z) => z.id), [31, 32]);
  });

  it("Löschen während eines Laufs: ein schon gelöschter späterer Zeitplan läuft nicht mehr", async () => {
    zeitplaene.length = 0;
    zeitplaene.push(
      { id: 33, name: "A", zeit: "07:00", tage: "taeglich", auftrag: "a" },
      { id: 34, name: "B", zeit: "07:00", tage: "taeglich", auftrag: "b" },
    );
    const vorher = abhaengigkeiten.handleMessage;
    abhaengigkeiten.handleMessage = async (text: string) => {
      prompts.push(text);
      if (text.endsWith("] a")) zeitplaene.splice(zeitplaene.findIndex((z) => z.id === 34), 1);
      return "Erledigt, Sir.";
    };
    try {
      await zeitplanTick(am(10, 7, 0));
    } finally {
      abhaengigkeiten.handleMessage = vorher;
    }
    assert.deepEqual(prompts, ["[Zeitplan «A», läuft automatisch] a"]);
  });
});

describe("Abbruch nach Werkzeugschritten: nie den ganzen Lauf wiederholen", () => {
  it("Zeitplan: vorübergehender Fehler nach einem Werkzeug → abgehakt, eine Meldung, kein zweiter Lauf", async () => {
    const z = plan(30, "08:30");
    const vorher = abhaengigkeiten.handleMessage;
    abhaengigkeiten.handleMessage = nachSchrittenFehler(2, ueberlastet);
    try {
      await zeitplanTick(am(10, 8, 30));
      assert.equal(prompts.length, 1);
      assert.equal(z.lastRun, "2026-10-10");
      assert.equal((JSON.parse(readFileSync(ZEITPLAENE_DATEI, "utf8")) as { id: number; lastRun?: string }[]).find((p) => p.id === 30)?.lastRun, "2026-10-10");
      assert.deepEqual(gesendet, ["⚠️ Zeitplan «Plan 30» brach nach 2 Werkzeugschritten ab (Verbindung). Ich wiederhole ihn nicht, um nichts doppelt auszuführen, Sir."]);
      await zeitplanTick(am(10, 8, 36));
      await zeitplanTick(am(10, 8, 45));
      assert.equal(prompts.length, 1);
      assert.equal(gesendet.length, 1);
    } finally {
      abhaengigkeiten.handleMessage = vorher;
    }
  });

  it("ohne Werkzeugschritt bleibt es beim Nachholen (nichts gewirkt)", async () => {
    const z = plan(31, "08:30");
    const vorher = abhaengigkeiten.handleMessage;
    abhaengigkeiten.handleMessage = nachSchrittenFehler(0, ueberlastet);
    try {
      await zeitplanTick(am(10, 8, 30));
    } finally {
      abhaengigkeiten.handleMessage = vorher;
    }
    assert.equal(z.lastRun, undefined);
    assert.deepEqual(gesendet, []);
    await zeitplanTick(am(10, 8, 35));
    assert.equal(prompts.length, 2);
    assert.equal(z.lastRun, "2026-10-10");
  });

  it("Rückblick und Zielcheck: onStep wird durchgereicht, nach einem Schritt kein zweiter Lauf", async () => {
    const vorher = abhaengigkeiten.handleMessage;
    abhaengigkeiten.handleMessage = nachSchrittenFehler(1, netzfehler);
    profil.ziele.push({ id: 30, text: "Marathon", status: "offen", angelegt: "2026-10-01" });
    try {
      await rueckblickTick(am(21, 22, 30));
      await rueckblickTick(am(21, 22, 40));
      assert.equal(prompts.length, 1);
      assert.deepEqual(gesendet, ["⚠️ Der Rückblick brach nach 1 Werkzeugschritt ab (Verbindung). Ich wiederhole ihn nicht, um nichts doppelt auszuführen, Sir."]);
      assert.equal((JSON.parse(readFileSync(ROUTINEN_DATEI, "utf8")) as { rueckblick?: string }).rueckblick, "2026-10-21");

      const sonntag = new Date(2026, 10, 8, 18, 0, 0, 0); // 8.11.2026 Sonntag
      await zielcheckTick(sonntag);
      await zielcheckTick(new Date(2026, 10, 8, 18, 10, 0, 0));
      assert.equal(prompts.length, 2);
      assert.equal(gesendet.length, 2);
      assert.match(gesendet[1]!, /^⚠️ Der Zielcheck brach nach 1 Werkzeugschritt ab/);
    } finally {
      abhaengigkeiten.handleMessage = vorher;
    }
  });

  it("Notaus nach einem Werkzeugschritt: abgehakt statt nach /weiter erneut", async () => {
    const z = plan(32, "08:30");
    const vorher = abhaengigkeiten.handleMessage;
    abhaengigkeiten.handleMessage = async (text: string, _hooks: unknown, opts: Opts = {}) => {
      prompts.push(text);
      opts.onStep?.(1, "notiz_speichern");
      state.paused = true;
      return "Ich bin pausiert (Notaus).";
    };
    try {
      await zeitplanTick(am(10, 8, 30));
    } finally {
      abhaengigkeiten.handleMessage = vorher;
    }
    assert.equal(z.lastRun, "2026-10-10");
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0]!, /brach nach 1 Werkzeugschritt ab \(Notaus\)/);
    state.paused = false;
    await zeitplanTick(am(10, 8, 31));
    assert.equal(prompts.length, 1);
  });

  it("nur lesende Werkzeuge (Wetter, Kalender): vorübergehender Fehler → bleibt offen und wird im Fenster nachgeholt", async () => {
    const z = plan(33, "07:00");
    const vorher = abhaengigkeiten.handleMessage;
    abhaengigkeiten.handleMessage = nachSchrittenFehler(2, ueberlastet, ["wetter", "kalender_termine"]);
    try {
      await zeitplanTick(am(10, 7, 0));
    } finally {
      abhaengigkeiten.handleMessage = vorher;
    }
    assert.equal(prompts.length, 1);
    assert.equal(z.lastRun, undefined);
    assert.deepEqual(gesendet, []);
    await zeitplanTick(am(10, 7, 3));
    assert.equal(prompts.length, 1); // noch keine 5 Minuten
    antworten = ["Sonnig, zwei Termine."];
    await zeitplanTick(am(10, 7, 5));
    assert.equal(prompts.length, 2);
    assert.equal(z.lastRun, "2026-10-10");
    assert.deepEqual(gesendet, ["🕒 Plan 33\n\nSonnig, zwei Termine."]);
  });

  it("lesend und schreibend gemischt: abgehakt, gezählt wird nur der schreibende Schritt", async () => {
    const z = plan(34, "08:30");
    const vorher = abhaengigkeiten.handleMessage;
    abhaengigkeiten.handleMessage = nachSchrittenFehler(3, netzfehler, ["wetter", "notiz_speichern", "geraete_status"]);
    try {
      await zeitplanTick(am(10, 8, 30));
      await zeitplanTick(am(10, 8, 40));
    } finally {
      abhaengigkeiten.handleMessage = vorher;
    }
    assert.equal(prompts.length, 1);
    assert.equal(z.lastRun, "2026-10-10");
    assert.deepEqual(gesendet, ["⚠️ Zeitplan «Plan 34» brach nach 1 Werkzeugschritt ab (Verbindung). Ich wiederhole ihn nicht, um nichts doppelt auszuführen, Sir."]);
  });

  it("Freigabe-Auftrag, unbekanntes Werkzeug oder eingabeabhängige Stufe zählen als Nebenwirkung", async () => {
    for (const [id, werkzeug] of [[35, "kalender_termin_erstellen"], [36, "gibt_es_nicht"], [37, "seite_lesen"], [38, "kamera_schauen"]] as const) {
      const z = plan(id, "08:30");
      const vorher = abhaengigkeiten.handleMessage;
      abhaengigkeiten.handleMessage = nachSchrittenFehler(1, serverfehler, [werkzeug]);
      try {
        await zeitplanTick(am(10, 8, 30));
      } finally {
        abhaengigkeiten.handleMessage = vorher;
      }
      assert.equal(z.lastRun, "2026-10-10", werkzeug);
    }
    assert.equal(gesendet.length, 4);
  });

  it("Rückblick: nur gelesen, dann Netzfehler → nach 5 Minuten erneut", async () => {
    const vorher = abhaengigkeiten.handleMessage;
    abhaengigkeiten.handleMessage = nachSchrittenFehler(1, netzfehler, ["notizen_lesen"]);
    try {
      await rueckblickTick(am(22, 22, 30));
    } finally {
      abhaengigkeiten.handleMessage = vorher;
    }
    assert.deepEqual(gesendet, []);
    await rueckblickTick(am(22, 22, 35));
    assert.equal(prompts.length, 2);
    assert.deepEqual(gesendet, ["🌙 Rückblick\n\nErledigt, Sir."]);
  });

  it("Notaus nach nur lesendem Schritt: nichts gemeldet, Lauf bleibt für nach /weiter offen", async () => {
    const z = plan(39, "08:30");
    const vorher = abhaengigkeiten.handleMessage;
    abhaengigkeiten.handleMessage = async (text: string, _hooks: unknown, opts: Opts = {}) => {
      prompts.push(text);
      opts.onStep?.(1, "wetter");
      state.paused = true;
      return "Ich bin pausiert (Notaus).";
    };
    try {
      await zeitplanTick(am(10, 8, 30));
    } finally {
      abhaengigkeiten.handleMessage = vorher;
    }
    assert.equal(z.lastRun, undefined);
    assert.deepEqual(gesendet, []);
    state.paused = false;
    await zeitplanTick(am(10, 8, 31));
    assert.equal(prompts.length, 2);
    assert.equal(z.lastRun, "2026-10-10");
  });

  it("jedes lesende Werkzeug hat eine feste Stufe auto (sonst legt es Aufträge an und muss gezählt werden)", () => {
    const k = config as unknown as Record<string, unknown>;
    const vorher = { gmail: k.gmail, shopify: k.shopify, homeAssistant: k.homeAssistant };
    try {
      // Nur zum Auflisten; es wird nichts aufgerufen
      k.gmail = { clientId: "x", clientSecret: "y" };
      k.shopify = { shop: "x", token: "y", version: "2026-01" };
      k.homeAssistant = { url: "http://ha.invalid", token: "y" };
      const werkzeuge = new Map(activeTools().map((t) => [t.name, t]));
      let geprueft = 0;
      for (const name of LESENDE_WERKZEUGE) {
        const t = werkzeuge.get(name);
        if (!t) continue; // z. B. Kamera-Werkzeuge ohne cameras.json
        geprueft++;
        assert.equal(t.stufe, "auto", name);
      }
      assert.ok(geprueft >= 15, `nur ${geprueft} geprüft`);
    } finally {
      Object.assign(k, vorher);
    }
  });
});

describe("rueckblickTick", () => {
  it("im Fenster einmal pro Tag, Meldung über sendeSpaeter", async () => {
    antworten = ["Ein ruhiger Tag, Sir."];
    await rueckblickTick(am(10, 22, 29));
    assert.equal(prompts.length, 0);
    await rueckblickTick(am(10, 22, 45));
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /^\[Tagesrückblick, läuft automatisch\]/);
    assert.deepEqual(gesendet, ["🌙 Rückblick\n\nEin ruhiger Tag, Sir."]);
    await rueckblickTick(am(10, 23, 0));
    assert.equal(prompts.length, 1);
  });

  it("vorübergehender Fehler: bleibt offen, nach 5 Minuten erneut; dauerhafter Fehler: eine Meldung, dann Ruhe", async () => {
    fehler = [netzfehler()];
    await rueckblickTick(am(11, 22, 30));
    assert.equal(prompts.length, 1);
    assert.deepEqual(gesendet, []);
    await rueckblickTick(am(11, 22, 33));
    assert.equal(prompts.length, 1);
    await rueckblickTick(am(11, 22, 36));
    assert.equal(prompts.length, 2);
    assert.deepEqual(gesendet, ["🌙 Rückblick\n\nErledigt, Sir."]);

    fehler = [clientfehler()];
    await rueckblickTick(am(12, 22, 30));
    assert.equal(prompts.length, 3);
    assert.equal(gesendet[1], "⚠️ Der Rückblick ist fehlgeschlagen: 400 Bad Request: max_tokens zu gross");
    await rueckblickTick(am(12, 22, 36));
    assert.equal(prompts.length, 3);
  });

  it("offline: wartet", async () => {
    gesundheit.melde("internet", false);
    await rueckblickTick(am(13, 22, 30));
    assert.equal(prompts.length, 0);
    gesundheit.melde("internet", true);
    await rueckblickTick(am(13, 22, 40));
    assert.equal(prompts.length, 1);
  });

  it("Notaus während des Laufs: Pausentext wird nicht gesendet, Rückblick bleibt offen", async () => {
    const vorher = abhaengigkeiten.handleMessage;
    abhaengigkeiten.handleMessage = async (text: string) => { prompts.push(text); state.paused = true; return "Ich bin pausiert (Notaus)."; };
    try {
      await rueckblickTick(am(20, 22, 30));
    } finally {
      abhaengigkeiten.handleMessage = vorher;
    }
    assert.deepEqual(gesendet, []);
    state.paused = false;
    await rueckblickTick(am(20, 22, 31));
    assert.equal(prompts.length, 2);
    assert.deepEqual(gesendet, ["🌙 Rückblick\n\nErledigt, Sir."]);
  });
});

describe("rechnungsTick", () => {
  it("ohne fällige Rechnungen nichts; mit fälligen eine Meldung, nachgeholt im Fenster", async () => {
    await rechnungsTick(am(10, 8, 30));
    assert.deepEqual(gesendet, []);
    addRechnung({ empfaenger: "Swisscom", betrag: 89.9, waehrung: "CHF", faellig: "2026-10-12" });
    await rechnungsTick(am(10, 8, 31));
    assert.deepEqual(gesendet, []); // heute schon geprüft
    await rechnungsTick(am(11, 8, 50));
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0]!, /^💳 Rechnungen: 1 fällig bis 2026-10-14/);
    assert.match(gesendet[0]!, /Swisscom/);
    await rechnungsTick(am(11, 9, 0));
    assert.equal(gesendet.length, 1);
  });

  it("vorübergehender Sendefehler: bleibt offen und wird nach 5 Minuten erneut versucht", async () => {
    addRechnung({ empfaenger: "Sunrise", betrag: 50, waehrung: "CHF", faellig: "2026-10-01" });
    let versuche = 0;
    abhaengigkeiten.sendeSpaeter = async (text: string) => { versuche++; if (versuche === 1) throw serverfehler(); gesendet.push(text); };
    await rechnungsTick(am(12, 8, 30));
    await rechnungsTick(am(12, 8, 32));
    assert.equal(versuche, 1);
    await rechnungsTick(am(12, 8, 36));
    assert.equal(versuche, 2);
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0]!, /überfällig/);
    abhaengigkeiten.sendeSpaeter = async (text: string) => { gesendet.push(text); };
  });
});

describe("zielcheckTick", () => {
  it("nur am Wochentag im Fenster, ohne offene Ziele nichts, mit Zielen ein Lauf", async () => {
    profil.ziele.push({ id: 1, text: "Marathon", status: "offen", angelegt: "2026-10-01" });
    await zielcheckTick(am(10, 18, 0)); // Samstag
    await zielcheckTick(am(11, 17, 59));
    assert.equal(prompts.length, 0);
    await zielcheckTick(am(11, 18, 20));
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /^\[Wöchentlicher Zielcheck/);
    assert.deepEqual(gesendet, ["🎯 Zielcheck\n\nErledigt, Sir."]);
    await zielcheckTick(am(11, 18, 30));
    assert.equal(prompts.length, 1);
  });

  it("vorübergehender Fehler → später erneut; ohne Ziele wird der Tag abgehakt", async () => {
    profil.ziele.push({ id: 2, text: "Werkstatt aufräumen", status: "offen", angelegt: "2026-10-01" });
    fehler = [serverfehler()];
    await zielcheckTick(am(18, 18, 0)); // 18.10.2026 Sonntag
    assert.equal(prompts.length, 1);
    assert.deepEqual(gesendet, []);
    await zielcheckTick(am(18, 18, 2));
    assert.equal(prompts.length, 1);
    await zielcheckTick(am(18, 18, 6));
    assert.equal(prompts.length, 2);
    assert.equal(gesendet.length, 1);

    profil.ziele.length = 0;
    await zielcheckTick(am(25, 18, 0)); // 25.10.2026 Sonntag
    assert.equal(prompts.length, 2);
    profil.ziele.push({ id: 3, text: "x", status: "offen", angelegt: "2026-10-01" });
    await zielcheckTick(am(25, 18, 5));
    assert.equal(prompts.length, 2); // heute schon abgehakt
  });
});

describe("Neustart im Nachholfenster", () => {
  /** Frische Modulinstanz des Schedulers (wie nach einem Neustart); die Abhängigkeiten bleiben dieselben. */
  async function neuGestartet(n: number) {
    const pfad = new URL(`../src/scheduler.js?neustart=${n}`, import.meta.url).href;
    const modul = (await import(pfad)) as typeof import("../src/scheduler.js");
    modul.abhaengigkeiten.handleMessage = abhaengigkeiten.handleMessage;
    modul.abhaengigkeiten.sendeSpaeter = abhaengigkeiten.sendeSpaeter;
    return modul;
  }

  it("Rückblick läuft nach einem Neustart im Fenster nicht ein zweites Mal", async () => {
    await rueckblickTick(am(14, 22, 30));
    assert.equal(prompts.length, 1);
    assert.equal((JSON.parse(readFileSync(ROUTINEN_DATEI, "utf8")) as { rueckblick?: string }).rueckblick, "2026-10-14");
    const neu = await neuGestartet(1);
    await neu.rueckblickTick(am(14, 22, 50));
    assert.equal(prompts.length, 1);
    assert.equal(gesendet.length, 1);
    await neu.rueckblickTick(am(15, 22, 40)); // am nächsten Tag wieder
    assert.equal(prompts.length, 2);
  });

  it("Rechnungs-Erinnerung und Zielcheck ebenso", async () => {
    addRechnung({ empfaenger: "Swisscom", betrag: 89.9, waehrung: "CHF", faellig: "2026-10-16" });
    await rechnungsTick(am(15, 8, 30));
    assert.equal(gesendet.length, 1);
    profil.ziele.push({ id: 4, text: "Marathon", status: "offen", angelegt: "2026-10-01" });
    const sonntag = new Date(2026, 10, 1, 18, 0, 0, 0); // 1.11.2026 Sonntag
    await zielcheckTick(sonntag);
    assert.equal(prompts.length, 1);
    const gespeichert = JSON.parse(readFileSync(ROUTINEN_DATEI, "utf8")) as { rechnungen?: string; zielcheck?: string };
    assert.equal(gespeichert.rechnungen, "2026-10-15");
    assert.equal(gespeichert.zielcheck, "2026-11-01");

    const neu = await neuGestartet(2);
    await neu.rechnungsTick(am(15, 8, 50));
    await neu.zielcheckTick(new Date(2026, 10, 1, 18, 20, 0, 0));
    assert.equal(gesendet.length, 2);
    assert.equal(prompts.length, 1);
  });

  it("vorübergehender Fehler wird nicht gespeichert: nach Neustart im Fenster erneut versucht", async () => {
    fehler = [serverfehler()];
    await rueckblickTick(am(16, 22, 30));
    assert.equal(prompts.length, 1);
    assert.notEqual((JSON.parse(readFileSync(ROUTINEN_DATEI, "utf8")) as { rueckblick?: string }).rueckblick, "2026-10-16");
    const neu = await neuGestartet(3);
    await neu.rueckblickTick(am(16, 22, 32));
    assert.equal(prompts.length, 2);
    assert.deepEqual(gesendet, ["🌙 Rückblick\n\nErledigt, Sir."]);
  });
});

describe("Erster Start ohne routinen.json (Update auf 0.16)", () => {
  it("Ergebnis wird sofort gespeichert: ein Neustart danach wertet die Uhrzeit nicht erneut aus", async () => {
    const rueckblickVorher = config.rueckblick;
    try {
      rmSync(ROUTINEN_DATEI, { force: true });
      // Erster Start vor der Zielzeit (hier: Rückblick aus Sicht dieses Starts noch nicht dran)
      config.rueckblick = "off";
      const erster = (await import(new URL("../src/scheduler.js?erststart=1", import.meta.url).href)) as typeof import("../src/scheduler.js");
      assert.equal(existsSync(ROUTINEN_DATEI), true);
      assert.equal(statSync(ROUTINEN_DATEI).mode & 0o777, 0o600);
      assert.equal((JSON.parse(readFileSync(ROUTINEN_DATEI, "utf8")) as { rueckblick?: string }).rueckblick, undefined);

      // Neustart, nachdem die Zielzeit (00:00) vorbei ist und der Lauf vorübergehend scheiterte: er bleibt offen
      config.rueckblick = "00:00";
      const heute = todayKey(new Date());
      const [j, m, t] = heute.split("-").map(Number) as [number, number, number];
      const imFensterHeute = new Date(j, m - 1, t, 0, 10, 0, 0);
      erster.abhaengigkeiten.handleMessage = abhaengigkeiten.handleMessage;
      erster.abhaengigkeiten.sendeSpaeter = abhaengigkeiten.sendeSpaeter;
      fehler = [netzfehler()];
      await erster.rueckblickTick(imFensterHeute);
      assert.equal(prompts.length, 1);
      const zweiter = (await import(new URL("../src/scheduler.js?erststart=2", import.meta.url).href)) as typeof import("../src/scheduler.js");
      zweiter.abhaengigkeiten.handleMessage = abhaengigkeiten.handleMessage;
      zweiter.abhaengigkeiten.sendeSpaeter = abhaengigkeiten.sendeSpaeter;
      await zweiter.rueckblickTick(new Date(imFensterHeute.getTime() + 2 * 60_000));
      assert.equal(prompts.length, 2);
      assert.deepEqual(gesendet, ["🌙 Rückblick\n\nErledigt, Sir."]);
    } finally {
      config.rueckblick = rueckblickVorher;
    }
  });

  it("heute schon vorbei → als erledigt, noch nicht dran → offen", () => {
    // Montag 12.10. 09:00: Rechnung (08:30) vorbei, Rückblick (22:30) noch nicht, Zielcheck nicht heute
    assert.deepEqual(routinenBeimErststart(am(12, 9, 0)), { rechnungen: "2026-10-12" });
    // Montag 08:29: noch nichts vorbei
    assert.deepEqual(routinenBeimErststart(am(12, 8, 29)), {});
    // Sonntag 11.10. 23:00: alles vorbei, auch der Zielcheck (so 18:00)
    assert.deepEqual(routinenBeimErststart(am(11, 23, 0)), { rueckblick: "2026-10-11", rechnungen: "2026-10-11", zielcheck: "2026-10-11" });
    // Sonntag 17:59: Zielcheck noch offen
    assert.deepEqual(routinenBeimErststart(am(11, 17, 59)), { rechnungen: "2026-10-11" });
  });
});

describe("Neustart mitten im Lauf: Startvermerk statt zweitem Lauf", () => {
  const liesRoutinen = () => JSON.parse(readFileSync(ROUTINEN_DATEI, "utf8")) as { rueckblick?: string; zielcheck?: string; begonnen?: Record<string, string> };
  const standard = abhaengigkeiten.handleMessage;
  /** Attrappe: ein Werkzeug mit Nebenwirkung wirkt, dann «stirbt» der Prozess (die Antwort kommt nie). Läuft in einer eigenen Modulinstanz, damit die Sperre «laufend» keine anderen Tests blockiert. */
  const wirktUndHaengt = (werkzeug: string) => (text: string, _hooks: unknown, opts: Opts = {}) => {
    prompts.push(text);
    opts.onStep?.(1, werkzeug);
    return new Promise<string>(() => {});
  };
  async function neuGestartet(n: number) {
    const modul = (await import(new URL(`../src/scheduler.js?mitten=${n}`, import.meta.url).href)) as typeof import("../src/scheduler.js");
    modul.abhaengigkeiten.handleMessage = abhaengigkeiten.handleMessage;
    modul.abhaengigkeiten.sendeSpaeter = abhaengigkeiten.sendeSpaeter;
    return modul;
  }

  it("Zeitplan: Vermerk vor dem Lauf, nach Neustart abgehakt und einmal gemeldet, nichts erneut ausgeführt", async () => {
    const z = plan(50, "08:00");
    abhaengigkeiten.handleMessage = wirktUndHaengt("rechnung_erfassen");
    try {
      const vorNeustart = await neuGestartet(10);
      void vorNeustart.zeitplanTick(am(19, 8, 0));
      await new Promise((r) => setImmediate(r));
    } finally {
      abhaengigkeiten.handleMessage = standard;
    }
    assert.equal(prompts.length, 1);
    assert.equal(liesRoutinen().begonnen?.["zeitplan:50"], "2026-10-19");
    assert.equal(z.lastRun, undefined);

    const neu = await neuGestartet(1);
    await neu.zeitplanTick(am(19, 8, 1));
    assert.equal(prompts.length, 1); // kein zweiter Lauf
    assert.equal(z.lastRun, "2026-10-19");
    assert.equal((JSON.parse(readFileSync(ZEITPLAENE_DATEI, "utf8")) as { id: number; lastRun?: string }[]).find((p) => p.id === 50)?.lastRun, "2026-10-19");
    assert.equal(liesRoutinen().begonnen?.["zeitplan:50"], undefined);
    assert.deepEqual(gesendet, ["⚠️ Zeitplan «Plan 50» wurde durch einen Neustart unterbrochen, das Ergebnis ist unklar. Ich wiederhole ihn nicht, um nichts doppelt auszuführen – bitte prüfen Sie es, Sir."]);
    await neu.zeitplanTick(am(19, 8, 10));
    assert.equal(prompts.length, 1);
    assert.equal(gesendet.length, 1);
    // am nächsten Tag wieder normal
    await neu.zeitplanTick(am(20, 8, 0));
    assert.equal(prompts.length, 2);
    assert.deepEqual(gesendet.slice(1), ["🕒 Plan 50\n\nErledigt, Sir."]);
    assert.equal(liesRoutinen().begonnen?.["zeitplan:50"], undefined);
  });

  it("Rückblick und Zielcheck: nach Neustart mitten im Lauf keine doppelten Einträge", async () => {
    profil.ziele.push({ id: 50, text: "Marathon", status: "offen", angelegt: "2026-10-01" });
    try {
      // Vortag: ein alter Vermerk; der nächste Prozess meldet ihn beim ersten Tick (mit Datum) und löscht ihn erst dann
      abhaengigkeiten.handleMessage = wirktUndHaengt("entscheidung_notieren");
      const vortag = await neuGestartet(11);
      void vortag.rueckblickTick(new Date(2026, 10, 14, 22, 30, 0, 0));
      await new Promise((r) => setImmediate(r));
      assert.equal(liesRoutinen().begonnen?.rueckblick, "2026-11-14");

      const vorNeustart = await neuGestartet(12);
      void vorNeustart.zielcheckTick(new Date(2026, 10, 15, 18, 0, 0, 0)); // 15.11.2026 Sonntag
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(liesRoutinen().begonnen, { zielcheck: "2026-11-15" });
      assert.equal(liesRoutinen().rueckblick, "2026-11-14");
      assert.deepEqual(gesendet, ["⚠️ Der Rückblick vom 14.11.2026 wurde durch einen Neustart unterbrochen, das Ergebnis ist unklar. Ich wiederhole ihn nicht, um nichts doppelt auszuführen – bitte prüfen Sie es, Sir."]);
      gesendet = [];
      abhaengigkeiten.handleMessage = wirktUndHaengt("muster_festhalten");
      vorNeustart.abhaengigkeiten.handleMessage = abhaengigkeiten.handleMessage;
      void vorNeustart.rueckblickTick(new Date(2026, 10, 15, 22, 30, 0, 0));
      await new Promise((r) => setImmediate(r));
    } finally {
      abhaengigkeiten.handleMessage = standard;
    }
    assert.equal(prompts.length, 3);
    assert.deepEqual(liesRoutinen().begonnen, { zielcheck: "2026-11-15", rueckblick: "2026-11-15" });

    const neu = await neuGestartet(2);
    await neu.zielcheckTick(new Date(2026, 10, 15, 18, 20, 0, 0));
    await neu.rueckblickTick(new Date(2026, 10, 15, 22, 40, 0, 0));
    await neu.rueckblickTick(new Date(2026, 10, 15, 22, 50, 0, 0));
    assert.equal(prompts.length, 3);
    assert.equal(gesendet.length, 2);
    assert.match(gesendet[0]!, /^⚠️ Der Zielcheck wurde durch einen Neustart unterbrochen/);
    assert.match(gesendet[1]!, /^⚠️ Der Rückblick wurde durch einen Neustart unterbrochen/);
    const r = liesRoutinen();
    assert.equal(r.rueckblick, "2026-11-15");
    assert.equal(r.zielcheck, "2026-11-15");
    assert.deepEqual(r.begonnen, {});
  });

  it("offen gehalten (vorübergehender Fehler ohne Wirkung) → Vermerk entfernt, Neustart darf nachholen", async () => {
    const z = plan(51, "08:00");
    fehler = [serverfehler()];
    await zeitplanTick(am(24, 8, 0));
    assert.equal(z.lastRun, undefined);
    assert.equal(liesRoutinen().begonnen?.["zeitplan:51"], undefined);
    const neu = await neuGestartet(3);
    await neu.zeitplanTick(am(24, 8, 2));
    assert.equal(prompts.length, 2);
    assert.equal(z.lastRun, "2026-10-24");
    assert.deepEqual(gesendet, ["🕒 Plan 51\n\nErledigt, Sir."]);
  });

  const unterbrochen = (titel: string) =>
    `⚠️ ${titel} wurde durch einen Neustart unterbrochen, das Ergebnis ist unklar. Ich wiederhole ihn nicht, um nichts doppelt auszuführen – bitte prüfen Sie es, Sir.`;

  it("Dienst erst nach dem Nachholfenster wieder da: Vermerke beim ersten Tick gemeldet und abgehakt, nichts ausgeführt", async () => {
    const z = plan(70, "07:00");
    writeFileSync(ROUTINEN_DATEI, JSON.stringify({ begonnen: { "zeitplan:70": "2026-10-28", rueckblick: "2026-10-28" } }));
    const neu = await neuGestartet(20);
    await neu.zeitplanTick(am(28, 8, 30)); // 07:00 + 60 min vorbei
    assert.equal(prompts.length, 0);
    assert.deepEqual(gesendet, [unterbrochen("Zeitplan «Plan 70»"), unterbrochen("Der Rückblick")]);
    assert.equal(z.lastRun, "2026-10-28");
    assert.equal((JSON.parse(readFileSync(ZEITPLAENE_DATEI, "utf8")) as { id: number; lastRun?: string }[]).find((p) => p.id === 70)?.lastRun, "2026-10-28");
    assert.equal(liesRoutinen().rueckblick, "2026-10-28");
    assert.deepEqual(liesRoutinen().begonnen, {});
    // einmal gemeldet, nicht wiederholt – auch nicht im Fenster des Rückblicks
    await neu.zeitplanTick(am(28, 8, 31));
    await neu.rueckblickTick(am(28, 22, 30));
    await neu.zielcheckTick(am(28, 22, 31));
    assert.equal(prompts.length, 0);
    assert.equal(gesendet.length, 2);
    // am nächsten Tag wieder normal
    await neu.zeitplanTick(am(29, 7, 0));
    assert.equal(prompts.length, 1);
    assert.equal(z.lastRun, "2026-10-29");
  });

  it("Vermerk vom Vortag: mit Datum gemeldet, der heutige Lauf startet trotzdem; Erledigtes und Gelöschtes", async () => {
    const z = plan(71, "07:00");
    zeitplaene.push({ id: 72, name: "Plan 72", zeit: "07:00", tage: "taeglich", auftrag: "x", lastRun: "2026-10-28" });
    // 72: schon abgehakt, nur der Vermerk blieb stehen → still weg; 99: Zeitplan inzwischen gelöscht → trotzdem melden
    writeFileSync(ROUTINEN_DATEI, JSON.stringify({ begonnen: { "zeitplan:71": "2026-10-28", "zeitplan:72": "2026-10-28", "zeitplan:99": "2026-10-28" } }));
    const neu = await neuGestartet(21);
    await neu.zeitplanTick(am(29, 7, 5));
    assert.equal(gesendet[0], unterbrochen("Zeitplan «Plan 71» vom 28.10.2026"));
    assert.equal(gesendet[1], unterbrochen("Zeitplan #99 vom 28.10.2026"));
    assert.equal(gesendet.length, 4);
    assert.deepEqual(gesendet.slice(2), ["🕒 Plan 71\n\nErledigt, Sir.", "🕒 Plan 72\n\nErledigt, Sir."]);
    assert.equal(prompts.length, 2);
    assert.equal(z.lastRun, "2026-10-29");
    assert.deepEqual(liesRoutinen().begonnen, {});
  });

  it("Startvermerk lässt sich nicht speichern: Lauf startet nicht, nach 5 Minuten erneut", async () => {
    const z = plan(73, "08:00");
    writeFileSync(ROUTINEN_DATEI, "{}");
    const neu = await neuGestartet(22);
    // routinen.json.tmp als Verzeichnis: writeFileSync scheitert (EISDIR) wie bei voller oder schreibgeschützter Platte
    const sperre = `${ROUTINEN_DATEI}.tmp`;
    mkdirSync(sperre);
    try {
      await neu.zeitplanTick(am(30, 8, 0));
      assert.equal(prompts.length, 0);
      assert.equal(z.lastRun, undefined);
      assert.ok(logs.some((l) => l.includes("Startvermerk für Zeitplan «Plan 73» nicht gespeichert")));
      assert.equal(liesRoutinen().begonnen, undefined);
      await neu.zeitplanTick(am(30, 8, 3));
      assert.equal(prompts.length, 0); // noch keine 5 Minuten
    } finally {
      rmSync(sperre, { recursive: true, force: true });
    }
    await neu.zeitplanTick(am(30, 8, 5));
    assert.equal(prompts.length, 1);
    assert.equal(z.lastRun, "2026-10-30");
    // kein falsches «unterbrochen» aus einem Vermerk, der nur im Speicher stand
    assert.deepEqual(gesendet, ["🕒 Plan 73\n\nErledigt, Sir."]);
    assert.deepEqual(liesRoutinen().begonnen, {});
  });

  it("Rückblick: ohne gespeicherten Startvermerk kein Claude-Aufruf", async () => {
    writeFileSync(ROUTINEN_DATEI, "{}");
    const neu = await neuGestartet(23);
    const sperre = `${ROUTINEN_DATEI}.tmp`;
    mkdirSync(sperre);
    try {
      await neu.rueckblickTick(am(30, 22, 30));
      assert.equal(prompts.length, 0);
      assert.deepEqual(gesendet, []);
    } finally {
      rmSync(sperre, { recursive: true, force: true });
    }
    await neu.rueckblickTick(am(30, 22, 35));
    assert.equal(prompts.length, 1);
    assert.equal(liesRoutinen().rueckblick, "2026-10-30");
  });
});

describe("Notfall: Daten aus Erinnerung, Zeitplan, Rückblick und Zielcheck gehen nicht hinaus", () => {
  it("alle vier senden mit imNotfallZurueckhalten", async () => {
    const optionen: unknown[] = [];
    abhaengigkeiten.sendeSpaeter = async (text: string, o?: unknown) => { gesendet.push(text); optionen.push(o); };
    try {
      plan(60, "08:00");
      await zeitplanTick(am(26, 8, 0));
      await rueckblickTick(am(26, 22, 30));
      addRechnung({ empfaenger: "Swisscom", betrag: 89.9, waehrung: "CHF", faellig: "2026-10-27", iban: "CH9300762011623852957" });
      await rechnungsTick(am(26, 8, 30));
      profil.ziele.push({ id: 60, text: "Marathon", status: "offen", angelegt: "2026-10-01" });
      await zielcheckTick(new Date(2026, 10, 22, 18, 0, 0, 0)); // 22.11.2026 Sonntag
    } finally {
      abhaengigkeiten.sendeSpaeter = async (text: string) => { gesendet.push(text); };
    }
    assert.equal(gesendet.length, 4);
    assert.deepEqual(optionen, Array(4).fill({ imNotfallZurueckhalten: true }));
  });

  it("Rechnungs-Erinnerung: Notfall während der Wiederholungspause → keine IBAN an Telegram, nichts im Postausgang", async () => {
    const { sendeSpaeter, setzeWarten } = await import("../src/telegram.js");
    const fetchVorher = globalThis.fetch;
    const sendeVorher = abhaengigkeiten.sendeSpaeter;
    const texte: string[] = [];
    let aufrufe = 0;
    globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
      const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
      assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
      texte.push(typeof init?.body === "string" ? ((JSON.parse(init.body) as { text?: string }).text ?? "") : "");
      aufrufe++;
      if (aufrufe === 1) return new Response(JSON.stringify({ ok: false, error_code: 500, description: "Internal Server Error" }), { status: 500, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: true, result: { message_id: aufrufe } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    // Während der injizierten Wartezeit löst der Notfall aus
    setzeWarten(async () => { state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" }; }, () => 0.5);
    abhaengigkeiten.sendeSpaeter = sendeSpaeter;
    try {
      addRechnung({ empfaenger: "Sunrise", betrag: 50, waehrung: "CHF", faellig: "2026-10-28", iban: "CH9300762011623852957", referenz: "RF18539007547034" });
      await rechnungsTick(am(27, 8, 30));
    } finally {
      globalThis.fetch = fetchVorher;
      abhaengigkeiten.sendeSpaeter = sendeVorher;
      setzeWarten();
      state.notfall = { aktiv: false };
    }
    assert.equal(aufrufe, 1); // kein zweiter sendMessage
    assert.match(texte[0]!, /^💳 Rechnungen/);
    const postausgang = join(temp, "data", "postausgang.json");
    const liegt = existsSync(postausgang) ? (JSON.parse(readFileSync(postausgang, "utf8")) as { text: string }[]) : [];
    assert.deepEqual(liegt, []);
  });
});
