import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Ein begonnener Auftrag (gestartetAm, Absturz mitten im Werkzeug) kann seine Nebenwirkung schon gehabt haben. Früher
// setzte «Ablehnen» ihn auf «abgelehnt» und sagte Claude «vom Nutzer abgelehnt»: Claude hielt die Mail für nicht
// gesendet und schlug sie erneut vor (doppelte Nebenwirkung), und die Historie zeigte «abgelehnt».
const temp = mkdtempSync(join(tmpdir(), "jarvis-auftraege-wegraeumen-"));
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
  return new Response(JSON.stringify({ ok: true, result: { message_id: 70 + gesendet.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const auftrag = (id: number, gestartet: boolean) => ({
  id, createdAt: "2026-10-15T07:00:00.000Z", tool: "mail_senden", input: { an: "bank@beispiel.test", betreff: "Unterlagen", text: "Hallo" },
  stufe: "extern", summary: `Mail an bank@beispiel.test #${id}`, status: "offen",
  ...(gestartet ? { gestartetAm: "2026-10-15T07:01:00.000Z" } : {}),
});
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "auftraege.json"), JSON.stringify([auftrag(1, true), auftrag(2, true), auftrag(3, false), auftrag(4, false)]));

const telegram = await import("../src/telegram.js");
const queue = await import("../src/queue.js");
const dashboard = await import("../src/dashboard.js");
telegram.setzeWarten(async () => {}, () => 0.5, async () => {});

const knopf = (data: string) => telegram.handleUpdate({ update_id: 1, callback_query: { id: "cb", data, from: { id: 12345 } } });
const notizen = (): string[] =>
  (JSON.parse(readFileSync(join(temp, "data", "chat.json"), "utf8")) as { content: unknown }[]).map((m) => String(m.content)).filter((c) => c.startsWith("[Systemnotiz]"));
const audit = () => readFileSync(join(temp, "data", "audit.log"), "utf8");
const res = () => ({ statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } });

describe("Begonnenen Auftrag wegräumen: «fehler, Ergebnis unklar», nie «abgelehnt»", () => {
  it("Telegram «Ablehnen»: Status fehler mit Vermerk, Notiz an Claude ohne «abgelehnt», Antwort sagt es", async () => {
    gesendet.length = 0;
    await knopf("nein:1");
    const a = queue.getAuftrag(1)!;
    assert.equal(a.status, "fehler");
    assert.equal(a.result, telegram.WEGGERAEUMT);
    assert.equal(a.result, "begonnen, Ergebnis unklar – vom Nutzer weggeräumt");
    assert.deepEqual(gesendet, ["🗂 #1 weggeräumt, nicht abgelehnt: Er wurde begonnen, das Ergebnis ist unklar. Bitte selbst prüfen, ob es geschehen ist, Sir."]);
    const notiz = notizen().at(-1)!;
    assert.match(notiz, /Auftrag #1 \(mail_senden\) wurde begonnen, das Ergebnis ist unklar/);
    assert.match(notiz, /Nicht erneut vorschlagen, ohne dass der Nutzer geprüft hat/);
    assert.doesNotMatch(notiz, /abgelehnt/);
    assert.match(audit(), /"auftrag_weggeraeumt".*"id":1.*"quelle":"telegram"/);
    assert.equal(JSON.parse(readFileSync(join(temp, "data", "auftraege.json"), "utf8")).find((x: { id: number }) => x.id === 1).status, "fehler");
  });

  it("Dashboard POST /api/auftrag nein: dasselbe, Antwort mit Status fehler", async () => {
    const r = res();
    await dashboard.auftragAction({ body: { id: 2, aktion: "nein" } } as never, r as never);
    assert.equal(r.statusCode, 200);
    const body = r.body as { ok: boolean; text: string; status: string };
    assert.equal(body.status, "fehler");
    assert.match(body.text, /^🗂 #2 weggeräumt, nicht abgelehnt/);
    assert.equal(queue.getAuftrag(2)?.result, telegram.WEGGERAEUMT);
    assert.match(notizen().at(-1)!, /Auftrag #2 \(mail_senden\) wurde begonnen, das Ergebnis ist unklar/);
    assert.match(audit(), /"auftrag_weggeraeumt".*"id":2.*"quelle":"dashboard"/);
  });

  it("Gegenprobe: nie begonnene Aufträge werden weiterhin abgelehnt", async () => {
    gesendet.length = 0;
    await knopf("nein:3");
    assert.equal(queue.getAuftrag(3)?.status, "abgelehnt");
    assert.deepEqual(gesendet, ["❌ #3 abgelehnt."]);
    assert.match(notizen().at(-1)!, /Auftrag #3 \(mail_senden\) wurde vom Nutzer abgelehnt\./);
    assert.equal(await telegram.denyAuftrag(queue.getAuftrag(4)!), "❌ #4 abgelehnt.");
    assert.equal(queue.getAuftrag(4)?.status, "abgelehnt");
  });
});
