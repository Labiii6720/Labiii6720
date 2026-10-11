import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/*.json liegt relativ) und Umgebung; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-scheduler-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });
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

const { abhaengigkeiten, rechnungsTick, rueckblickTick, zeitplanTick, zielcheckTick } = await import("../src/scheduler.js");
const { zeitplaene } = await import("../src/zeitplaene.js");
const { HttpFehler, gesundheit } = await import("../src/robust.js");
const { imFenster, todayKey } = await import("../src/time.js");
const { faelligIm } = await import("../src/zeitplaene.js");
const { state } = await import("../src/state.js");
const { addRechnung, rechnungen } = await import("../src/finanzen.js");
const { profil } = await import("../src/profil.js");

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
