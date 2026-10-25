import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

// GET /api/chat/verlauf: die letzten fünf Nachrichten aus data/chat.json (Handler und reine Funktion, im eigenen Prozess).
// Temp-Ordner, kein Netz; die Verdrahtung über HTTP (401, 423, fehlende Datei) prüft dashboard-api.test.ts.
const temp = mkdtempSync(join(tmpdir(), "jarvis-verlauf-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = "verlauf-token-nur-attrappe-0123456789";
for (const k of ["RUECKBLICK", "RECHNUNG_ERINNERUNG", "ZIELCHECK", "VERDICHTUNG", "FINANZBERICHT"]) process.env[k] = "off";
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

const LANG = "L".repeat(5000);
const verlauf = [
  { role: "user", content: "[Kommandozentrale] Alte Frage eins" },
  { role: "assistant", content: [{ type: "text", text: "Alte Antwort eins" }] },
  { role: "user", content: "Wie ist das Wetter?" },
  { role: "assistant", content: [{ type: "text", text: "Ich schaue nach." }, { type: "tool_use", id: "tu_1", name: "wetter", input: { ort: "GEHEIMER-ORT" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "WERKZEUG-ERGEBNIS 14 Grad" }] }] },
  { role: "assistant", content: [{ type: "text", text: "Vierzehn Grad, Sir. " }, { type: "text", text: "Kein Regen." }] },
  { role: "user", content: "[Systemnotiz] Auftrag #7 (mail_senden) wurde vom Nutzer abgelehnt." },
  { role: "user", content: "[Zeitplan «Morgen», läuft automatisch] Briefing mit GEHEIMEM-AUFTRAG" },
  { role: "assistant", content: [{ type: "text", text: "Briefing: <img src=x onerror=alert(1)>" }] },
  { role: "user", content: "[Kanal: Stimme, die Antwort wird vorgelesen] Mein Schlüssel ist sk-ant-api03-abcdefghijklmnop und Authorization: Bearer abcdefghijklmnop0123" },
  { role: "assistant", content: [{ type: "server_tool_use", id: "st_1", name: "web_search", input: { query: "x" } }, { type: "web_search_tool_result", tool_use_id: "st_1", content: [] }, { type: "text", text: LANG }] },
];
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "chat.json"), JSON.stringify(verlauf));

const dashboard = await import("../src/dashboard.js");
const agent = await import("../src/agent.js");
const { state } = await import("../src/state.js");

function antwort() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    set() { return this; },
    end() { return this; },
  };
}
async function rufe(): Promise<{ statusCode: number; body: any }> {
  const res = antwort();
  await dashboard.chatVerlauf({ params: {}, query: {}, body: {}, header: () => undefined } as never, res as never);
  return { statusCode: res.statusCode, body: res.body };
}

beforeEach(() => {
  state.paused = false;
  state.notfall = { aktiv: false };
});

describe("GET /api/chat/verlauf", () => {
  it("genau die letzten fünf Nachrichten mit Text, älteste zuerst, Rollen nutzer/jarvis", async () => {
    const r = await rufe();
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.unlesbar, undefined, "lesbare Datei: kein Hinweis");
    const n = r.body.nachrichten as { rolle: string; text: string }[];
    assert.equal(n.length, 5);
    assert.deepEqual(n.map((m) => m.rolle), ["nutzer", "jarvis", "jarvis", "nutzer", "jarvis"]);
    assert.equal(n[0]!.text, "Wie ist das Wetter?");
    assert.equal(n[1]!.text, "Vierzehn Grad, Sir. Kein Regen.", "Textblöcke zusammen, ohne den Zwischenschritt «Ich schaue nach.»");
    assert.equal(n[2]!.text, "Briefing: <img src=x onerror=alert(1)>", "Text bleibt roh – die Oberfläche setzt ihn als textContent");
    for (const m of n) assert.deepEqual(Object.keys(m).sort(), ["rolle", "text"]);
  });

  it("keine Werkzeug-Inhalte, Systemnotizen, automatischen Aufträge oder Kanal-Präfixe", async () => {
    const roh = JSON.stringify((await rufe()).body);
    for (const verboten of ["GEHEIMER-ORT", "WERKZEUG-ERGEBNIS", "tool_use", "tool_result", "Ich schaue nach", "Systemnotiz", "abgelehnt", "GEHEIMEM-AUFTRAG", "läuft automatisch", "[Kanal", "[Kommandozentrale]"]) {
      assert.ok(!roh.includes(verboten), verboten);
    }
    const n = (await rufe()).body.nachrichten as { text: string }[];
    assert.match(n[3]!.text, /^Mein Schlüssel ist /, "Präfix sauber entfernt");
  });

  it("geschwärzt und je höchstens 2000 Zeichen", async () => {
    const n = (await rufe()).body.nachrichten as { text: string }[];
    assert.ok(!n[3]!.text.includes("abcdefghijklmnop"), "Geheimnisse geschwärzt");
    assert.match(n[3]!.text, /sk-ant-<schlüssel>/);
    assert.match(n[3]!.text, /Bearer <token>/);
    assert.equal(Array.from(n[4]!.text).length, 2000);
    assert.ok(n[4]!.text.endsWith("…"));
    for (const m of n) assert.ok(Array.from(m.text).length <= 2000);
  });

  it("im Notfall 423, ohne Inhalte", async () => {
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    const r = await rufe();
    assert.equal(r.statusCode, 423);
    assert.equal(r.body.error, "notfall");
    assert.equal(r.body.nachrichten, undefined);
  });

  it("liest nur: die Historie bleibt unverändert, data/ bekommt keine neue Datei", async () => {
    await rufe();
    assert.equal(agent.chatNichtGeladen, false);
    assert.ok(!existsSync(join(temp, "data", "chat.json.tmp")));
  });
});

describe("sichtbareNachrichten (rein)", () => {
  it("kein Array oder fremde Einträge → nichts, kein Wurf", () => {
    for (const roh of [undefined, null, {}, "text", 42]) assert.deepEqual(agent.sichtbareNachrichten(roh), []);
    assert.deepEqual(agent.sichtbareNachrichten([null, 7, "x", { role: "system", content: "s" }, { role: "user" }, { role: "assistant", content: 5 }, { role: "user", content: [null, { type: "text" }] }]), []);
  });

  it("weniger als fünf: alle; leere und nur aus Präfix bestehende Texte fallen weg; n begrenzt", () => {
    const v = [
      { role: "user", content: "[Kommandozentrale]   " },
      { role: "assistant", content: [{ type: "text", text: "  " }] },
      { role: "user", content: "[Ereignis aus dem Haus] Klingel" },
      { role: "assistant", content: "Jemand an der Tür, Sir." },
    ];
    assert.deepEqual(agent.sichtbareNachrichten(v), [{ rolle: "nutzer", text: "Klingel" }, { rolle: "jarvis", text: "Jemand an der Tür, Sir." }]);
    assert.deepEqual(agent.sichtbareNachrichten(v, 1), [{ rolle: "jarvis", text: "Jemand an der Tür, Sir." }]);
  });
});
