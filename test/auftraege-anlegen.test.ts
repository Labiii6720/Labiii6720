import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// createAuftrag ganz oder gar nicht: scheitert das Speichern, bleibt kein offener Geister-Auftrag im Speicher (sonst
// zwei freigebbare Aufträge mit derselben Nebenwirkung, wenn Claude es nach «nicht angelegt» nochmals versucht).
// Dazu: Nummern bleiben über ein Ersetzen von data/auftraege.json eindeutig, ein veralteter Freigabe-Knopf gibt nichts
// frei, eine unbekannte Protokoll-Stufe gilt als sensibel, und /protokoll meldet einen Speicherfehler.
const temp = mkdtempSync(join(tmpdir(), "jarvis-auftraege-anlegen-"));
process.chdir(temp);
// Im Temp-Ordner bleiben bis zum Prozessende (spätes Schreiben landet nie im Projekt), dann aufräumen
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-attrappe-nur-fuer-tests";
process.env.JARVIS_PIN = "4711";

let naechsteNachricht = 100;
const gesendet: { method: string; text?: string; knoepfe: boolean }[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string; reply_markup?: unknown }) : {};
  gesendet.push({ method: url.split("/").pop() ?? "", text: body.text, knoepfe: body.reply_markup !== undefined });
  return new Response(JSON.stringify({ ok: true, result: { message_id: naechsteNachricht++ } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;
const texte = () => gesendet.filter((g) => g.method === "sendMessage").map((g) => g.text ?? "");

// 200 alte Aufträge (die Höchstzahl) und Protokolle mit vertippter bzw. fehlender Stufe
const DATEI = join(temp, "data", "auftraege.json");
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(
  DATEI,
  JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i + 1, createdAt: "2026-10-01T08:00:00.000Z", tool: "mail_senden", input: {}, stufe: "extern", summary: `alt ${i + 1}`, status: "erledigt" }))),
);
writeFileSync(
  "protokolle.json",
  JSON.stringify({
    nacht: { beschreibung: "Schlösser zu", stufe: "Sensibel", schritte: [{ nachricht: "zu" }] },
    alarm: { beschreibung: "Alarm scharf", schritte: [{ nachricht: "scharf" }] },
    abwesend: { beschreibung: "Alles aus", stufe: "extern", schritte: [{ nachricht: "aus" }] },
  }),
);

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const queue = await import("../src/queue.js");
const telegram = await import("../src/telegram.js");
const dashboard = await import("../src/dashboard.js");
const { protokolle } = await import("../src/protokolle.js");
const { state } = await import("../src/state.js");
const { reminders } = await import("../src/tools.js");
const { runTask } = await import("../src/agent.js");
const { anthropic } = await import("../src/claude.js");
console.error = origErr;
telegram.setzeWarten(async () => {}, () => 0.5, async () => {});

const TMP = `${DATEI}.tmp`;
/** data/auftraege.json.tmp als Ordner: writeFileSync wirft EISDIR, wie bei voller Karte oder fehlenden Rechten */
function mitSchreibfehler<T>(f: () => T): T {
  mkdirSync(TMP);
  try {
    return f();
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}
const ids = () => queue.auftraege.map((a) => a.id);
const res = () => ({ statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } });

describe("createAuftrag: gescheitertes Speichern lässt nichts zurück", () => {
  it("wirft EISDIR, kein offener Auftrag, die 200 alten Einträge bleiben vollständig im Speicher", () => {
    const vorher = ids();
    assert.equal(vorher.length, 200);
    assert.throws(() => mitSchreibfehler(() => queue.createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "Mail an Bank" })), /EISDIR/);
    assert.deepEqual(queue.offeneAuftraege(), []);
    assert.deepEqual(ids(), vorher, "kein Geister-Auftrag, nichts weggekürzt");
    const inDatei = JSON.parse(readFileSync(DATEI, "utf8")) as { id: number }[];
    assert.equal(inDatei.length, 200);
    assert.equal(inDatei[0]!.id, 1);
  });

  it("der nächste Versuch legt genau einen Auftrag an; die verbrauchte Nummer kommt nicht wieder", () => {
    const a = queue.createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "Mail an Bank" });
    assert.equal(a.id, 202, "201 war beim gescheiterten Versuch schon vergeben");
    assert.deepEqual(queue.offeneAuftraege().map((x) => x.id), [202]);
    assert.equal(queue.auftraege.length, 200);
    assert.equal(queue.auftraege[0]!.id, 2, "erst jetzt (gespeichert) fällt der älteste weg");
    assert.equal(state.naechsteAuftragId, 203);
    assert.equal((JSON.parse(readFileSync(join(temp, "data", "state.json"), "utf8")) as { naechsteAuftragId: number }).naechsteAuftragId, 203);
    queue.setStatus(a, "abgelehnt");
  });

  it("über Claude: Fehler an Claude (is_error), kein Auftrag im Speicher, keine Freigabe-Nachricht", async () => {
    const client = anthropic();
    const orig = client.messages.create;
    const antworten: Anthropic.Message[] = [
      { id: "m1", type: "message", role: "assistant", model: "attrappe", stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
        content: [{ type: "tool_use", id: "tu_1", name: "zeitplan_erstellen", input: { name: "Morgen", zeit: "07:00", tage: "taeglich", auftrag: "Wetter" } }] } as Anthropic.Message,
      { id: "m2", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
        content: [{ type: "text", text: "Das ging nicht, Sir.", citations: null }] } as Anthropic.Message,
    ];
    client.messages.create = (async () => antworten.shift()!) as unknown as typeof client.messages.create;
    const verlauf: Anthropic.MessageParam[] = [];
    let freigabeGesendet = false;
    const vorher = ids();
    try {
      mkdirSync(TMP);
      await runTask("Richte einen Zeitplan ein.", { onAuftrag: async () => { freigabeGesendet = true; } } as never, { history: verlauf });
    } finally {
      rmSync(TMP, { recursive: true, force: true });
      client.messages.create = orig;
    }
    const ergebnis = (verlauf[2]!.content as Anthropic.ToolResultBlockParam[])[0]!;
    assert.equal(ergebnis.is_error, true);
    assert.match(String(ergebnis.content), /^Fehler: Auftrag nicht angelegt, nichts ausgeführt\./);
    assert.equal(freigabeGesendet, false);
    assert.deepEqual(queue.offeneAuftraege(), []);
    assert.deepEqual(ids(), vorher);
  });

  it("unbekannte Stufe: wirft vor dem Anlegen, nichts im Speicher, Nummer unverbraucht", () => {
    const naechste = state.naechsteAuftragId;
    assert.throws(() => queue.createAuftrag({ tool: "protokoll_ausfuehren", input: {}, stufe: "Sensibel" as never, summary: "x" }), /Unbekannte Stufe/);
    assert.throws(() => queue.createAuftrag({ tool: "protokoll_ausfuehren", input: {}, stufe: undefined as never, summary: "x" }), /Unbekannte Stufe/);
    assert.deepEqual(queue.offeneAuftraege(), []);
    assert.equal(state.naechsteAuftragId, naechste);
  });
});

describe("Nummern bleiben eindeutig, auch wenn data/auftraege.json ersetzt wird", () => {
  it("nach Entfernen der Datei und Neustart vergibt Jarvis keine alte Nummer", async () => {
    const a = queue.createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "vor dem Ersetzen" });
    queue.setStatus(a, "abgelehnt");
    writeFileSync(DATEI, "[]"); // «repariert» durch Ersetzen
    const neu = (await import(new URL("../src/queue.js?neustart=1", import.meta.url).href)) as typeof import("../src/queue.js");
    assert.deepEqual(neu.auftraege, []);
    const b = neu.createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "nach dem Ersetzen" });
    assert.equal(b.id, a.id + 1);
    neu.setStatus(b, "abgelehnt");
  });
});

describe("Freigabe-Knopf: nur unter der zuletzt gesendeten Nachricht", () => {
  const knopf = (data: string, messageId?: number) =>
    telegram.handleUpdate({ update_id: 1, callback_query: { id: "cb", data, from: { id: 12345 }, ...(messageId === undefined ? {} : { message: { message_id: messageId } }) } });
  const erinnerung = () =>
    queue.createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "Knopf" }, stufe: "extern", summary: "Erinnerung" });

  it("veralteter Knopf gibt nichts frei; der aktuelle schon", async () => {
    reminders.splice(0, reminders.length);
    const a = erinnerung();
    await telegram.hooks.onAuftrag(a);
    assert.equal(typeof a.messageId, "number");
    gesendet.length = 0;
    await knopf(`ok:${a.id}`, a.messageId! - 7);
    assert.deepEqual(texte(), ["Dieser Knopf ist veraltet, Sir. /auftraege zeigt die aktuellen."]);
    assert.equal(queue.getAuftrag(a.id)?.status, "offen");
    assert.equal(reminders.length, 0);
    // Auch Ablehnen über einen veralteten Knopf ändert nichts
    await knopf(`nein:${a.id}`, a.messageId! - 7);
    assert.equal(queue.getAuftrag(a.id)?.status, "offen");
    await knopf(`ok:${a.id}`, a.messageId!);
    assert.equal(queue.getAuftrag(a.id)?.status, "erledigt");
    assert.equal(reminders.length, 1);
    reminders.splice(0, reminders.length);
  });

  it("lange Zusammenfassung: Knöpfe nur unter dem letzten Teil, und genau der gilt", async () => {
    const a = queue.createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "lang" }, stufe: "extern", summary: "x".repeat(5000) });
    gesendet.length = 0;
    await telegram.hooks.onAuftrag(a);
    const teile = gesendet.filter((g) => g.method === "sendMessage");
    assert.equal(teile.length, 2);
    assert.deepEqual(teile.map((t) => t.knoepfe), [false, true]);
    assert.equal(teile.map((t) => t.text).join(""), `🟠 Auftrag #${a.id} · Stufe extern\n\n${"x".repeat(5000)}`);
    await knopf(`nein:${a.id}`, a.messageId!);
    assert.equal(queue.getAuftrag(a.id)?.status, "abgelehnt");
  });
});

describe("Protokolle: Stufe geprüft, Speicherfehler gemeldet", () => {
  it("«Sensibel» und fehlende Stufe gelten als sensibel (PIN); Log nennt nur die Anzahl", () => {
    assert.equal(protokolle.nacht!.stufe, "sensibel");
    assert.equal(protokolle.alarm!.stufe, "sensibel");
    assert.equal(protokolle.abwesend!.stufe, "extern");
    assert.ok(fehler.some((f) => f.startsWith("protokolle.json: 2 Protokolle ohne gültige Stufe")), fehler.join("\n"));
    assert.ok(!fehler.some((f) => f.includes("Schlösser") || f.includes("nacht")), "kein Dateiinhalt im Log");
  });

  it("/api/protokoll legt einen sensiblen Auftrag an, der ohne PIN nicht läuft", async () => {
    const r = res();
    await dashboard.protokollAction({ body: { name: "nacht" } } as never, r as never);
    assert.equal(r.statusCode, 200);
    const a = queue.offeneAuftraege().at(-1)!;
    assert.equal(a.stufe, "sensibel");
    assert.equal(await telegram.approveAuftrag(a), "Falsche PIN. #" + a.id + " abgelehnt.");
  });

  it("/protokoll in Telegram bei Speicherfehler: Meldung statt Schweigen, kein Auftrag", async () => {
    const vorher = ids();
    gesendet.length = 0;
    mkdirSync(TMP);
    try {
      await telegram.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: 12345 }, text: "/protokoll abwesend" } });
    } finally {
      rmSync(TMP, { recursive: true, force: true });
    }
    assert.equal(texte().length, 1);
    assert.match(texte()[0]!, /^Protokoll «abwesend» nicht angelegt, Sir: .*EISDIR/);
    assert.deepEqual(ids(), vorher);
  });

  it("/api/protokoll bei Speicherfehler: 500 mit Grund, kein Auftrag", async () => {
    const vorher = ids();
    const r = res();
    const origErr2 = console.error;
    console.error = () => {};
    mkdirSync(TMP);
    try {
      await dashboard.protokollAction({ body: { name: "abwesend" } } as never, r as never);
    } finally {
      rmSync(TMP, { recursive: true, force: true });
      console.error = origErr2;
    }
    assert.equal(r.statusCode, 500);
    assert.match((r.body as { text: string }).text, /^Protokoll «abwesend» nicht angelegt, Sir: .*EISDIR/);
    assert.deepEqual(ids(), vorher);
    assert.ok(!existsSync(TMP));
  });
});
