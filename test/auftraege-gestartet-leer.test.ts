import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Von Hand bearbeitete oder verdorbene data/auftraege.json: gestartetAm ist da, aber leer, unlesbar oder kein Text.
// Früher galt «» als gültig und die Freigabe-Pfade prüften auf Wahrheitswert – der Auftrag liess sich erneut ausführen
// (doppelte Nebenwirkung). Jetzt zählt jedes vorhandene gestartetAm als gestartet (Ergebnis unklar).
const temp = mkdtempSync(join(tmpdir(), "jarvis-auftraege-gestartet-"));
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
  return new Response(JSON.stringify({ ok: true, result: { message_id: 40 + gesendet.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const ZEIT = new Date(Date.now() + 3_600_000).toISOString();
const auftrag = (id: number, gestartetAm: unknown) => ({
  id, createdAt: "2026-10-14T08:00:00.000Z", tool: "erinnerung", input: { zeit: ZEIT, text: `Erinnerung ${id}` },
  stufe: "extern", summary: `Erinnerung ${id}`, status: "offen", gestartetAm,
});
// leer, nur Leerzeichen, unlesbar, null, Zahl; dazu ein gültiger Zeitpunkt und ein Auftrag ohne Feld (nie gestartet)
const VERDORBEN = [auftrag(1, ""), auftrag(2, "  "), auftrag(3, "irgendwann"), auftrag(4, null), auftrag(5, 0)];
const GUELTIG = auftrag(6, "2026-10-14T08:01:00.000Z");
const { gestartetAm: _ohne, ...NIE_GESTARTET } = auftrag(7, undefined);
mkdirSync(join(temp, "data"), { recursive: true });
const ORIGINAL = JSON.stringify([...VERDORBEN, GUELTIG, NIE_GESTARTET]);
writeFileSync(join(temp, "data", "auftraege.json"), ORIGINAL);

const vorLaden = Date.now();
const { auftragEintrag } = await import("../src/datei.js");
const telegram = await import("../src/telegram.js");
const queue = await import("../src/queue.js");
const { reminders } = await import("../src/tools.js");
const nachLaden = Date.now();
telegram.setzeWarten(async () => {}, () => 0.5, async () => {});

const unklar = (id: number) => `#${id} wurde bereits gestartet, Ergebnis unklar – bitte prüfen, Sir.`;

describe("auftraege.json: vorhandenes, aber leeres oder unlesbares gestartetAm", () => {
  it("auftragEintrag: jeder vorhandene Wert wird zum Ladezeitpunkt (ISO), gültige bleiben, fehlende fehlen weiter", () => {
    for (const roh of VERDORBEN) {
      const vorher = JSON.stringify(roh);
      const a = auftragEintrag(roh);
      assert.ok(a, JSON.stringify(roh));
      assert.match(a.gestartetAm ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, JSON.stringify(roh));
      assert.equal(JSON.stringify(roh), vorher, "Rohdaten unverändert");
    }
    assert.equal(auftragEintrag(GUELTIG), GUELTIG);
    assert.equal(auftragEintrag(NIE_GESTARTET)?.gestartetAm, undefined);
    assert.ok(!("gestartetAm" in (auftragEintrag(NIE_GESTARTET) ?? {})));
  });

  it("beim Laden: alle sieben geladen, nichts verworfen, die verdorbenen gelten als gestartet", () => {
    assert.equal(queue.auftraegeNichtGeladen, false);
    assert.deepEqual(queue.auftraege.map((a) => a.id), [1, 2, 3, 4, 5, 6, 7]);
    for (const a of queue.auftraege.slice(0, 5)) {
      const t = Date.parse(a.gestartetAm ?? "");
      assert.ok(t >= vorLaden - 1000 && t <= nachLaden + 1000, `#${a.id}: ${a.gestartetAm}`);
    }
    assert.equal(queue.getAuftrag(6)?.gestartetAm, "2026-10-14T08:01:00.000Z");
    assert.equal(queue.getAuftrag(7)?.gestartetAm, undefined);
    assert.equal(readFileSync(join(temp, "data", "auftraege.json"), "utf8"), ORIGINAL, "beim Laden bleibt die Datei unverändert");
  });

  it("Telegram-Knopf und Dashboard führen keinen davon erneut aus: «Ergebnis unklar», Status offen, kein Werkzeug", async () => {
    for (const id of [1, 2, 3, 4, 5, 6]) {
      gesendet.length = 0;
      await telegram.handleUpdate({ update_id: 100 + id, callback_query: { id: `cb${id}`, data: `ok:${id}`, from: { id: 12345 } } });
      assert.ok(gesendet.includes(unklar(id)), `#${id}: ${gesendet.join("\n")}`);
      assert.equal(await telegram.approveAuftrag(queue.getAuftrag(id)!), unklar(id));
      assert.equal(queue.getAuftrag(id)?.status, "offen");
    }
    assert.equal(reminders.length, 0, "keine Erinnerung angelegt: kein Werkzeug lief");
  });

  it("Gegenprobe: der Auftrag ohne gestartetAm läuft genau einmal", async () => {
    gesendet.length = 0;
    await telegram.handleUpdate({ update_id: 200, callback_query: { id: "cb7", data: "ok:7", from: { id: 12345 } } });
    assert.equal(reminders.length, 1);
    assert.equal(queue.getAuftrag(7)?.status, "erledigt");
  });
});
