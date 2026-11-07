import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Ganz unlesbare data/auftraege.json (abgeschnitten nach Stromausfall). Früher lud queue.ts still eine leere Liste, und
// der nächste Auftrag überschrieb die Datei samt aller offenen Freigaben. Jetzt wie die übrigen Listen: Sicherung,
// Speichern gesperrt, Hinweis in Startmeldung, /status, /auftraege und /api/auftraege.
const temp = mkdtempSync(join(tmpdir(), "jarvis-auftraege-defekt-"));
process.chdir(temp);
// Im Temp-Ordner bleiben bis zum Prozessende (spätes Schreiben landet nie im Projekt), dann aufräumen
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-attrappe-nur-fuer-tests";

const gesendet: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  if (body.text !== undefined) gesendet.push(body.text);
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const DATEI = join(temp, "data", "auftraege.json");
const KAPUTT = '[{"id": 1, "createdAt": "2026-10-14T08:00:00.000Z", "tool": "mail_senden", "input": {}, "stufe": "extern", "summary": "geheim", "status": "offen"},';
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(DATEI, KAPUTT);
writeFileSync("protokolle.json", JSON.stringify({ abwesend: { beschreibung: "Alles aus", stufe: "extern", schritte: [{ nachricht: "aus" }] } }));

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const queue = await import("../src/queue.js");
const telegram = await import("../src/telegram.js");
const dashboard = await import("../src/dashboard.js");
const { runTask } = await import("../src/agent.js");
const { anthropic } = await import("../src/claude.js");
console.error = origErr;
telegram.setzeWarten(async () => {}, () => 0.5, async () => {});

describe("auftraege.json unlesbar", () => {
  it("startet leer, sperrt das Speichern und sichert die Datei (600)", () => {
    assert.equal(queue.auftraegeNichtGeladen, true);
    assert.deepEqual(queue.auftraege, []);
    assert.equal(readFileSync(`${DATEI}.defekt`, "utf8"), KAPUTT);
    assert.equal(statSync(`${DATEI}.defekt`).mode & 0o777, 0o600);
    assert.ok(fehler.some((f) => f.startsWith("Aufträge unlesbar – Kopie unter data/auftraege.json.defekt")), fehler.join("\n"));
    assert.ok(!fehler.some((f) => f.includes("geheim")), "kein Dateiinhalt im Log");
  });

  it("createAuftrag wirft, nimmt nichts in den Speicher und lässt die Datei unverändert", () => {
    assert.throws(() => queue.createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "neu" }), /auftraege\.json war beim Start unlesbar/);
    assert.deepEqual(queue.auftraege, []);
    assert.throws(() => queue.saveAuftraege(), /unlesbar/);
    assert.equal(readFileSync(DATEI, "utf8"), KAPUTT);
    assert.ok(!existsSync(`${DATEI}.tmp`));
  });

  it("Startmeldung, /status und /auftraege sagen es, statt «keine offenen Aufträge»", async () => {
    assert.ok(telegram.dateiHinweise().includes(queue.AUFTRAEGE_UNLESBAR));
    gesendet.length = 0;
    await telegram.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 12345 }, text: "/auftraege" } });
    assert.deepEqual(gesendet, [queue.AUFTRAEGE_UNLESBAR]);
    gesendet.length = 0;
    await telegram.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: 12345 }, text: "/status" } });
    assert.ok(gesendet[0]!.includes(queue.AUFTRAEGE_UNLESBAR));
  });

  it("/api/auftraege und /status.json melden die unlesbare Datei", () => {
    const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    dashboard.auftraegeJson({ params: {}, query: {} } as never, res as never);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, unlesbar: true, text: queue.AUFTRAEGE_UNLESBAR, gesamt: 0, auftraege: [] });
    const st = { ...res, statusCode: 200, body: undefined as unknown };
    dashboard.statusJson({ params: {}, query: {} } as never, st as never);
    assert.equal((st.body as { auftraegeUnlesbar: boolean }).auftraegeUnlesbar, true);
  });

  it("/protokoll und /api/protokoll nennen den Grund, statt zu schweigen bzw. nur 500 zu melden", async () => {
    gesendet.length = 0;
    await telegram.handleUpdate({ update_id: 3, message: { message_id: 3, chat: { id: 12345 }, text: "/protokoll abwesend" } });
    assert.deepEqual(gesendet, [queue.AUFTRAEGE_UNLESBAR]);
    const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    await dashboard.protokollAction({ body: { name: "abwesend" } } as never, res as never);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { ok: false, error: "auftraege_unlesbar", text: queue.AUFTRAEGE_UNLESBAR });
    assert.deepEqual(queue.auftraege, []);
    assert.equal(readFileSync(DATEI, "utf8"), KAPUTT);
  });

  it("Werkzeug mit Freigabe im Chat: Claude erfährt den Grund, der Lauf bricht nicht ab, nichts angelegt", async () => {
    const client = anthropic();
    const orig = client.messages.create;
    const antworten: Anthropic.Message[] = [
      { id: "m1", type: "message", role: "assistant", model: "attrappe", stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
        content: [{ type: "tool_use", id: "tu_1", name: "zeitplan_erstellen", input: { name: "Morgen", zeit: "07:00", tage: "taeglich", auftrag: "Wetter" } }] } as Anthropic.Message,
      { id: "m2", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
        content: [{ type: "text", text: "Das geht gerade nicht, Sir.", citations: null }] } as Anthropic.Message,
    ];
    client.messages.create = (async () => antworten.shift()!) as unknown as typeof client.messages.create;
    const verlauf: Anthropic.MessageParam[] = [];
    try {
      const antwort = await runTask("Richte einen Zeitplan ein.", { onAuftrag: async () => undefined } as never, { history: verlauf });
      assert.equal(antwort, "Das geht gerade nicht, Sir.");
    } finally {
      client.messages.create = orig;
    }
    const ergebnis = (verlauf[2]!.content as Anthropic.ToolResultBlockParam[])[0]!;
    assert.equal(ergebnis.is_error, true);
    assert.match(String(ergebnis.content), /^Fehler: Auftrag nicht angelegt, nichts ausgeführt\. data\/auftraege\.json war beim Start unlesbar/);
    assert.deepEqual(queue.auftraege, []);
    assert.equal(readFileSync(DATEI, "utf8"), KAPUTT);
  });
});
