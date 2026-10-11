import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/*.json liegt relativ) und Umgebung; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-finanzen-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.ZEITPLAN_NACHHOLEN_MIN = "60";
process.env.FINANZBERICHT = "mo 07:45";
process.env.RUECKBLICK = "off";
process.env.RECHNUNG_ERINNERUNG = "off";
process.env.ZIELCHECK = "off";
process.env.VERDICHTUNG = "off";

/** Telegram-Attrappe: zeichnet gesendete Texte auf; alles andere ist ein Fehler */
let telegramTexte: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (!url.startsWith("https://api.telegram.org/bot")) throw new Error(`unerwarteter Netzaufruf: ${url}`);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  if (url.endsWith("/sendMessage") && body.text !== undefined) telegramTexte.push(body.text);
  return new Response(JSON.stringify({ ok: true, result: { message_id: telegramTexte.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

// Bestehende (leere) routinen.json: kein Erststart, die Tests hängen so nicht vom echten Datum ab
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "routinen.json"), "{}");

const { chf, finanzUebersicht, rechnungen, setzeStatus, summeText, wochenberichtText } = await import("../src/finanzen.js");
type Rechnung = import("../src/finanzen.js").Rechnung;
const { abhaengigkeiten, finanzberichtTick } = await import("../src/scheduler.js");
const { handleUpdate, setzeWarten } = await import("../src/telegram.js");
const { finanzenJson } = await import("../src/dashboard.js");
const { activeTools } = await import("../src/tools.js");
const { state } = await import("../src/state.js");
const { config } = await import("../src/config.js");
const { HttpFehler, gesundheit } = await import("../src/robust.js");
const { todayKey } = await import("../src/time.js");
const setup = await import("../src/setup.js");

setzeWarten(async () => undefined, () => 0.5);

const RECHNUNGEN_DATEI = join(temp, "data", "rechnungen.json");
const ROUTINEN_DATEI = join(temp, "data", "routinen.json");

let gesendet: { text: string; optionen?: unknown }[] = [];
abhaengigkeiten.sendeSpaeter = async (text: string, optionen?: unknown) => { gesendet.push({ text, optionen }); };

const origLog = console.log; const origErr = console.error;
beforeEach(() => {
  gesendet = [];
  telegramTexte = [];
  rechnungen.length = 0;
  state.paused = false;
  state.notfall = { aktiv: false };
  gesundheit._reset();
  abhaengigkeiten.sendeSpaeter = async (text: string, optionen?: unknown) => { gesendet.push({ text, optionen }); };
  console.log = origLog; console.error = origErr;
});

let naechsteId = 1;
function rg(teil: Partial<Rechnung> & Pick<Rechnung, "status">): Rechnung {
  return { id: naechsteId++, erkanntAm: "2026-01-02T09:00:00.000Z", empfaenger: "Firma", waehrung: "CHF", ...teil };
}

/** 15.01.2026 (Donnerstag): heute + 7 = 22.01., letzte Woche ab 09.01., sechs Monate ab 2025-08 (über die Jahresgrenze) */
const JETZT = new Date(2026, 0, 15, 10, 0, 0, 0);

function fixture() {
  naechsteId = 1;
  const r = {
    ueberfaellig: rg({ status: "offen", empfaenger: "Swisscom", betrag: 1234.5, faellig: "2026-01-10" }),
    heute: rg({ status: "offen", empfaenger: "Amazon DE", betrag: 20, waehrung: "EUR", faellig: "2026-01-15" }),
    plusSieben: rg({ status: "offen", empfaenger: "EWB", betrag: 100.25, faellig: "2026-01-22" }),
    plusAcht: rg({ status: "offen", empfaenger: "Sunrise", betrag: 50, faellig: "2026-01-23" }),
    // Silvester 23:30 UTC ist in Zürich schon der 1. Januar
    ohneFrist: rg({ status: "offen", empfaenger: "Verein", betrag: 10, erkanntAm: "2025-12-31T23:30:00.000Z" }),
    ohneBetrag: rg({ status: "offen", empfaenger: "Garage", faellig: "2026-01-20" }),
    bezahltGrenze: rg({ status: "bezahlt", empfaenger: "Miete", betrag: 300, bezahltAm: "2026-01-09" }),
    bezahltAlt: rg({ status: "bezahlt", empfaenger: "Versicherung", betrag: 400, bezahltAm: "2026-01-08" }),
    fallbackFaellig: rg({ status: "bezahlt", empfaenger: "Zahnarzt", betrag: 75.5, faellig: "2025-12-20" }),
    fallbackErkannt: rg({ status: "bezahlt", empfaenger: "Shop", betrag: 99.99, waehrung: "EUR", erkanntAm: "2025-11-05T10:00:00.000Z" }),
    ignoriert: rg({ status: "ignoriert", empfaenger: "Spam", betrag: 999, faellig: "2026-01-05" }),
    zuAlt: rg({ status: "bezahlt", empfaenger: "Alt", betrag: 1000, bezahltAm: "2025-07-31" }),
    langUeberfaellig: rg({ status: "offen", empfaenger: "Steueramt", betrag: 5, faellig: "2025-08-01" }),
    rappenA: rg({ status: "bezahlt", empfaenger: "Kiosk", betrag: 0.1, bezahltAm: "2026-01-15" }),
    rappenB: rg({ status: "bezahlt", empfaenger: "Kiosk", betrag: 0.2, bezahltAm: "2026-01-15" }),
  };
  return { r, liste: Object.values(r) };
}

const ids = (l: Rechnung[]) => l.map((x) => x.id);

describe("finanzUebersicht", () => {
  it("offen, überfällig, fällig bald (Grenzen heute und heute + 7), ohne Frist, ohne Betrag", () => {
    const { r, liste } = fixture();
    const u = finanzUebersicht(JETZT, liste);
    assert.equal(u.stand, "2026-01-15");
    assert.equal(u.offen.anzahl, 7);
    assert.deepEqual(u.offen.summe, { CHF: 1399.75, EUR: 20 });
    assert.deepEqual(ids(u.ueberfaellig), [r.langUeberfaellig.id, r.ueberfaellig.id]);
    assert.deepEqual(ids(u.faelligBald), [r.heute.id, r.ohneBetrag.id, r.plusSieben.id]);
    assert.equal(u.ohneFrist, 1);
    assert.equal(u.unklar, 1);
  });

  it("bezahlt letzte Woche: heute − 6 bis heute, neueste zuerst, ohne bezahltAm nicht", () => {
    const { r, liste } = fixture();
    const u = finanzUebersicht(JETZT, liste);
    assert.deepEqual(ids(u.bezahltLetzteWoche), [r.rappenA.id, r.rappenB.id, r.bezahltGrenze.id]);
  });

  it("proMonat: genau 6 Zeilen über die Jahresgrenze, älteste zuerst, Fallbacks, ignoriert zählt nirgends", () => {
    const { liste } = fixture();
    const u = finanzUebersicht(JETZT, liste);
    assert.deepEqual(u.proMonat.map((m) => m.monat), ["2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01"]);
    assert.deepEqual(u.proMonat[0], { monat: "2025-08", bezahlt: {}, offen: { CHF: 5 }, anzahlBezahlt: 0, anzahlOffen: 1 });
    assert.deepEqual(u.proMonat[1], { monat: "2025-09", bezahlt: {}, offen: {}, anzahlBezahlt: 0, anzahlOffen: 0 });
    // bezahlt ohne bezahltAm und ohne faellig → erkanntAm
    assert.deepEqual(u.proMonat[3], { monat: "2025-11", bezahlt: { EUR: 99.99 }, offen: {}, anzahlBezahlt: 1, anzahlOffen: 0 });
    // bezahlt ohne bezahltAm → faellig
    assert.deepEqual(u.proMonat[4], { monat: "2025-12", bezahlt: { CHF: 75.5 }, offen: {}, anzahlBezahlt: 1, anzahlOffen: 0 });
    // offen ohne Frist → erkanntAm in Schweizer Zeit (1. Januar); Rappen exakt (0.1 + 0.2); ignoriert (999) fehlt
    assert.deepEqual(u.proMonat[5], { monat: "2026-01", bezahlt: { CHF: 700.3 }, offen: { CHF: 1394.75, EUR: 20 }, anzahlBezahlt: 4, anzahlOffen: 6 });
    const alles = JSON.stringify(u.proMonat);
    assert.ok(!alles.includes("999") && !alles.includes("1000"), "ignoriert und zu Altes zählen nicht");
  });

  it("Jahreswechsel im Januar und im Dezember: Monate korrekt fortgezählt", () => {
    assert.deepEqual(finanzUebersicht(new Date(2026, 11, 31, 23, 0), []).proMonat.map((m) => m.monat), ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]);
    assert.deepEqual(finanzUebersicht(new Date(2027, 2, 1, 0, 30), []).proMonat.map((m) => m.monat), ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
  });

  it("bezahltAm am Monatsersten zählt im neuen Monat; ungültige Daten fallen auf den nächsten Wert zurück", () => {
    naechsteId = 100;
    const liste = [
      rg({ status: "bezahlt", betrag: 10, bezahltAm: "2026-01-01", faellig: "2025-12-31" }),
      rg({ status: "offen", betrag: 7, faellig: "31.01.2026", erkanntAm: "2026-01-03T08:00:00.000Z" }),
      rg({ status: "offen", betrag: 3, waehrung: "" }),
    ];
    const u = finanzUebersicht(JETZT, liste);
    assert.deepEqual(u.proMonat[5]!.bezahlt, { CHF: 10 });
    assert.deepEqual(u.proMonat[5]!.offen, { CHF: 10 }, "ungültige Frist → erkanntAm; leere Währung → CHF");
    assert.equal(u.ohneFrist, 2);
  });

  it("ohne Liste: die gespeicherten Rechnungen; Ergebnis sind Kopien", () => {
    naechsteId = 200;
    rechnungen.push(rg({ status: "offen", betrag: 12, faellig: "2026-01-12" }));
    const u = finanzUebersicht(JETZT);
    assert.equal(u.offen.anzahl, 1);
    u.ueberfaellig[0]!.betrag = 0;
    assert.equal(rechnungen[0]!.betrag, 12);
  });
});

describe("setzeStatus", () => {
  it("bezahlt setzt bezahltAm (nur wenn leer), Wechsel weg von bezahlt löscht es, gespeichert wird jedes Mal", () => {
    naechsteId = 300;
    const r = rg({ status: "offen", betrag: 50 });
    rechnungen.push(r);
    setzeStatus(r, "bezahlt", "2026-10-05");
    assert.equal(r.status, "bezahlt");
    assert.equal(r.bezahltAm, "2026-10-05");
    setzeStatus(r, "bezahlt", "2026-10-09");
    assert.equal(r.bezahltAm, "2026-10-05", "bestehendes Datum bleibt");
    assert.equal((JSON.parse(readFileSync(RECHNUNGEN_DATEI, "utf8")) as Rechnung[])[0]!.bezahltAm, "2026-10-05");
    setzeStatus(r, "ignoriert", "2026-10-10");
    assert.equal(r.status, "ignoriert");
    assert.equal(r.bezahltAm, undefined);
    assert.ok(!("bezahltAm" in (JSON.parse(readFileSync(RECHNUNGEN_DATEI, "utf8")) as Rechnung[])[0]!));
    setzeStatus(r, "bezahlt", "2026-10-11");
    assert.equal(r.bezahltAm, "2026-10-11");
    setzeStatus(r, "offen", "2026-10-12");
    assert.equal(r.bezahltAm, undefined);
    r.bezahltAm = "";
    setzeStatus(r, "bezahlt", "2026-10-13");
    assert.equal(r.bezahltAm, "2026-10-13", "leerer Text gilt als leer");
  });

  it("ohne Datum: heute in Schweizer Zeit", () => {
    naechsteId = 310;
    const r = rg({ status: "offen" });
    rechnungen.push(r);
    setzeStatus(r, "bezahlt");
    assert.equal(r.bezahltAm, todayKey());
  });

  it("Werkzeug rechnung_status nutzt setzeStatus, bleibt Stufe auto und kennt nur bezahlt/ignoriert", async () => {
    naechsteId = 320;
    const r = rg({ status: "offen", betrag: 80 });
    rechnungen.push(r);
    const tool = activeTools().find((t) => t.name === "rechnung_status")!;
    assert.equal(tool.stufe, "auto");
    const ctx = {} as Parameters<typeof tool.run>[1];
    assert.equal(await tool.run({ id: r.id, status: "bezahlt" }, ctx), `#${r.id} ist jetzt bezahlt.`);
    assert.equal(r.bezahltAm, todayKey());
    await tool.run({ id: r.id, status: "ignoriert" }, ctx);
    assert.equal(r.bezahltAm, undefined);
    await assert.rejects(tool.run({ id: r.id, status: "offen" }, ctx), /bezahlt oder ignoriert/);
  });
});

describe("chf / summeText", () => {
  it("Schweizer Format: Tausender ', zwei Nachkommastellen", () => {
    assert.equal(chf(1234.5, "CHF"), "1'234.50 CHF");
    assert.equal(chf(1234567.891), "1'234'567.89 CHF");
    assert.equal(chf(0), "0.00 CHF");
    assert.equal(chf(999.999), "1'000.00 CHF");
    assert.equal(chf(-1234.5, "EUR"), "-1'234.50 EUR");
    assert.equal(chf(-0.001), "0.00 CHF");
    assert.equal(chf(Number.NaN), "– CHF");
  });

  it("CHF zuerst, dann alphabetisch; leer → –", () => {
    assert.equal(summeText({ USD: 1, EUR: 20, CHF: 1234.5 }), "1'234.50 CHF · 20.00 EUR · 1.00 USD");
    assert.equal(summeText({}), "–");
  });
});

describe("wochenberichtText", () => {
  it("Kopf, Summen im Schweizer Format, Monatszeilen, Hinweise", () => {
    const { liste } = fixture();
    const t = wochenberichtText(finanzUebersicht(JETZT, liste));
    const zeilen = t.split("\n");
    assert.equal(zeilen[0], "💼 Finanzen, Stand 2026-01-15");
    assert.ok(zeilen.includes("Offen: 7 Rechnungen · 1'399.75 CHF · 20.00 EUR (1 ohne Frist)"), t);
    assert.ok(zeilen.includes("Überfällig (2):"), t);
    assert.ok(zeilen.includes("Fällig in 7 Tagen (3):"), t);
    assert.ok(zeilen.includes("Bezahlt letzte Woche: 3 Rechnungen · 300.30 CHF"), t);
    assert.ok(zeilen.includes("2026-01: bezahlt 700.30 CHF (4) · offen 1'394.75 CHF · 20.00 EUR (6)"), t);
    assert.ok(zeilen.includes("2025-09: –"), t);
    assert.ok(zeilen.includes("2025-08: bezahlt – (0) · offen 5.00 CHF (1)"), t);
    assert.match(t, /1 Rechnung ohne erkannten Betrag/);
    assert.match(t, /Zahlung vorbereiten: «Bereite die Zahlung für #… vor»/);
    assert.match(t, /Bank-App/);
    assert.ok(zeilen.length <= 25, `${zeilen.length} Zeilen`);
  });

  it("höchstens 5 Einträge je Liste, ≤ 25 Zeilen auch mit IBAN und vielen Rechnungen", () => {
    naechsteId = 400;
    const iban = { iban: "CH9300762011623852957", referenz: "21 00000 00003 13947 14300 09017" };
    const liste = [
      ...Array.from({ length: 8 }, (_, i) => rg({ status: "offen", betrag: 1000 + i, faellig: `2026-01-0${i + 1}`, ...iban })),
      ...Array.from({ length: 7 }, (_, i) => rg({ status: "offen", betrag: 10, faellig: `2026-01-${16 + i}`, ...iban })),
      ...Array.from({ length: 6 }, () => rg({ status: "bezahlt", betrag: 1, bezahltAm: "2026-01-14" })),
      rg({ status: "offen", faellig: "2026-01-16" }),
    ];
    const t = wochenberichtText(finanzUebersicht(JETZT, liste));
    const zeilen = t.split("\n");
    assert.ok(zeilen.length <= 25, `${zeilen.length} Zeilen:\n${t}`);
    assert.ok(zeilen.includes("Überfällig (8, die ersten 5):"), t);
    assert.ok(zeilen.includes("Fällig in 7 Tagen (8, die ersten 5):"), t);
    assert.equal(zeilen.filter((z) => z.startsWith("• ")).length, 10);
    assert.ok(zeilen.some((z) => z.startsWith("• #400 ") && z.includes("IBAN CH9300762011623852957")), "IBAN auf derselben Zeile");
    assert.ok(!t.includes("#405"), "sechster überfälliger Eintrag nicht gelistet");
    assert.ok(zeilen.includes("Offen: 16 Rechnungen · 8'098.00 CHF"), t);
  });

  it("ohne unklare Beträge kein Hinweis; ohne offene keine Zahlungs-Zeile", () => {
    naechsteId = 500;
    const t = wochenberichtText(finanzUebersicht(JETZT, [rg({ status: "bezahlt", betrag: 1234.5, bezahltAm: "2026-01-12" })]));
    assert.ok(!t.includes("ohne erkannten Betrag"));
    assert.ok(!t.includes("Zahlung vorbereiten"));
    assert.match(t, /Offen: nichts, Sir\./);
    assert.match(t, /Bezahlt letzte Woche: 1 Rechnung · 1'234.50 CHF/);
  });
});

describe("finanzberichtTick", () => {
  /** 12.10.2026 Montag (lokale Zeit Europe/Zurich) */
  const am = (tag: number, h: number, m: number, monat = 9) => new Date(2026, monat, tag, h, m, 0, 0);
  const eineRechnung = () => { naechsteId = 600; rechnungen.push(rg({ status: "offen", betrag: 89.9, faellig: "2026-10-01" })); };

  it("nur am Wochentag im Fenster, einmal pro Tag, Versand über sendeSpaeter (im Notfall zurückhalten), Audit und Merker", async () => {
    eineRechnung();
    await finanzberichtTick(am(11, 7, 45)); // Sonntag
    await finanzberichtTick(am(12, 7, 44)); // vor der Zeit
    await finanzberichtTick(am(12, 8, 45)); // Fenster (60 min) vorbei
    assert.equal(gesendet.length, 0);
    await finanzberichtTick(am(12, 8, 44)); // nachgeholt im Fenster
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0]!.text, /^💼 Finanzen, Stand 2026-10-12/);
    assert.match(gesendet[0]!.text, /Überfällig \(1\):/);
    assert.deepEqual(gesendet[0]!.optionen, { imNotfallZurueckhalten: true });
    await finanzberichtTick(am(12, 8, 0));
    assert.equal(gesendet.length, 1, "einmal pro Tag");
    assert.equal((JSON.parse(readFileSync(ROUTINEN_DATEI, "utf8")) as { finanzbericht?: string }).finanzbericht, "2026-10-12");
    const audit = readFileSync(join(temp, "data", "audit.log"), "utf8").trim().split("\n").map((z) => JSON.parse(z) as Record<string, unknown>);
    const eintrag = audit.find((e) => e.event === "finanzbericht");
    assert.equal(eintrag?.offen, 1);
    assert.equal(eintrag?.ueberfaellig, 1);
    await finanzberichtTick(am(19, 7, 45)); // nächster Montag wieder
    assert.equal(gesendet.length, 2);
  });

  it("ohne Rechnungen kein Bericht, der Tag ist abgehakt", async () => {
    await finanzberichtTick(am(26, 7, 45));
    assert.equal(gesendet.length, 0);
    eineRechnung();
    await finanzberichtTick(am(26, 7, 50));
    assert.equal(gesendet.length, 0);
  });

  it("Notaus: nichts; nach /weiter im Fenster läuft er", async () => {
    eineRechnung();
    state.paused = true;
    await finanzberichtTick(am(2, 7, 45, 10)); // 2.11.2026 Montag
    assert.equal(gesendet.length, 0);
    state.paused = false;
    await finanzberichtTick(am(2, 7, 50, 10));
    assert.equal(gesendet.length, 1);
  });

  it("off: nichts", async () => {
    eineRechnung();
    const vorher = config.finanzbericht;
    try {
      config.finanzbericht = "off";
      await finanzberichtTick(am(9, 7, 45, 10));
      assert.equal(gesendet.length, 0);
    } finally {
      config.finanzbericht = vorher;
    }
  });

  it("vorübergehender Sendefehler: bleibt offen, frühestens nach 5 Minuten erneut, dann einmal gesendet", async () => {
    eineRechnung();
    console.error = () => undefined;
    let versuche = 0;
    abhaengigkeiten.sendeSpaeter = async (text: string) => { versuche++; if (versuche === 1) throw new HttpFehler("503 Service Unavailable", 503); gesendet.push({ text }); };
    await finanzberichtTick(am(16, 7, 45, 10)); // 16.11.2026 Montag
    await finanzberichtTick(am(16, 7, 47, 10));
    assert.equal(versuche, 1);
    await finanzberichtTick(am(16, 7, 51, 10));
    assert.equal(versuche, 2);
    assert.equal(gesendet.length, 1);
    await finanzberichtTick(am(16, 7, 58, 10));
    assert.equal(versuche, 2);
  });
});

describe("/finanzen in Telegram", () => {
  const befehl = (id: number, text: string) => handleUpdate({ update_id: 70_000 + id, message: { message_id: id, chat: { id: 12345 }, text } });

  it("sendet den Bericht sofort; ohne Rechnungen ein kurzer Satz; im Notfall nichts heraus", async () => {
    naechsteId = 700;
    await befehl(1, "/finanzen");
    assert.deepEqual(telegramTexte, ["Noch keine Rechnungen erfasst, Sir. Nichts zu berichten."]);
    rechnungen.push(rg({ status: "offen", empfaenger: "Swisscom", betrag: 1234.5, faellig: todayKey() }));
    telegramTexte = [];
    await befehl(2, "/finanzen");
    assert.equal(telegramTexte.length, 1);
    assert.match(telegramTexte[0]!, new RegExp(`^💼 Finanzen, Stand ${todayKey()}`));
    assert.match(telegramTexte[0]!, /1'234\.50 CHF/);
    telegramTexte = [];
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    state.paused = true;
    await befehl(3, "/finanzen");
    assert.equal(telegramTexte.length, 1);
    assert.ok(!telegramTexte[0]!.includes("Swisscom") && !telegramTexte[0]!.includes("1'234"), telegramTexte[0]);
    assert.match(telegramTexte[0]!, /Notfall/);
  });

  it("/hilfe nennt /finanzen", async () => {
    await befehl(10, "/hilfe");
    assert.match(telegramTexte[0]!, /\/finanzen – /);
  });
});

describe("GET /api/finanzen", () => {
  function antwort() {
    const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    return res;
  }
  type Req = Parameters<typeof finanzenJson>[0];
  type Res = Parameters<typeof finanzenJson>[1];

  it("Übersicht als JSON, Rechnungen auf id, empfaenger, betrag, waehrung, faellig, bezahltAm, status reduziert", () => {
    naechsteId = 800;
    const heute = todayKey();
    rechnungen.push(
      rg({ status: "offen", empfaenger: "Swisscom", betrag: 50, faellig: "2020-01-01", iban: "CH9300762011623852957", referenz: "123456789", notiz: "geheim", quelle: "msg-1" }),
      rg({ status: "bezahlt", empfaenger: "Miete", betrag: 1500, bezahltAm: heute, iban: "CH9300762011623852957" }),
    );
    const res = antwort();
    finanzenJson({} as Req, res as unknown as Res);
    const b = res.body as Record<string, unknown> & { ueberfaellig: Record<string, unknown>[]; bezahltLetzteWoche: Record<string, unknown>[]; proMonat: unknown[] };
    assert.equal(res.statusCode, 200);
    assert.equal(b.ok, true);
    assert.equal(b.stand, heute);
    assert.equal(b.proMonat.length, 6);
    assert.deepEqual(b.ueberfaellig, [{ id: 800, empfaenger: "Swisscom", betrag: 50, waehrung: "CHF", faellig: "2020-01-01", bezahltAm: undefined, status: "offen" }]);
    assert.deepEqual(Object.keys(b.bezahltLetzteWoche[0]!).sort(), ["betrag", "bezahltAm", "empfaenger", "faellig", "id", "status", "waehrung"]);
    const roh = JSON.stringify(b);
    for (const geheim of ["CH9300762011623852957", "123456789", "geheim", "msg-1"]) assert.ok(!roh.includes(geheim), `${geheim} gehört nicht ins Dashboard`);
  });

  it("im Notfall gesperrt", () => {
    rechnungen.push(rg({ status: "offen", betrag: 1 }));
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    const res = antwort();
    finanzenJson({} as Req, res as unknown as Res);
    assert.equal(res.statusCode, 423);
    assert.deepEqual(res.body, { ok: false, error: "notfall" });
  });

  it("server.ts registriert den Endpunkt nur hinter lanOnly und dashboardAuth", () => {
    const quelle = readFileSync(join(projekt, "src", "server.ts"), "utf8");
    const zeilen = quelle.split("\n").filter((z) => z.includes("/api/finanzen"));
    assert.deepEqual(zeilen.map((z) => z.trim()), ['app.get("/api/finanzen", lanOnly, dashboardAuth, finanzenJson);']);
    const block = quelle.slice(quelle.indexOf("if (config.dashboard && config.eventToken) {"));
    assert.ok(block.indexOf("/api/finanzen") > 0 && block.indexOf("/api/finanzen") < block.indexOf("\n}\n"), "im Dashboard-Block");
  });
});

describe("Leitplanke 2 und Einrichtung", () => {
  it("finanzen.ts spricht mit keinem Dienst (keine Bank-API) und löst nichts aus", () => {
    const quelle = readFileSync(join(projekt, "src", "finanzen.ts"), "utf8");
    assert.ok(!/\bfetch\s*\(|https?:\/\/|from "node:(http|https|net)"/.test(quelle));
  });

  it("FINANZBERICHT im Schema: Wochentag und Uhrzeit oder off", () => {
    const feld = setup.ABSCHNITTE.flatMap((a) => a.felder).find((f) => f.key === "FINANZBERICHT")!;
    assert.equal(feld.standard, "mo 07:45");
    assert.deepEqual(setup.entscheideWert("", undefined, feld), { wert: "mo 07:45" });
    assert.deepEqual(setup.entscheideWert("off", undefined, feld), { wert: "off" });
    assert.deepEqual(setup.entscheideWert("fr 17:30", undefined, feld), { wert: "fr 17:30" });
    assert.ok(setup.entscheideWert("montag 7:45", undefined, feld).fehler);
    assert.ok(setup.ABSCHNITTE.find((a) => a.name === "proaktiv")!.felder.includes(feld));
  });
});
