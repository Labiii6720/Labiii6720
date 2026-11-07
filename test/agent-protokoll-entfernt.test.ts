import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Früher meldete stufeVerschaerft ein inzwischen entferntes Protokoll als «inzwischen sensibel»: sicher (nicht
// ausgeführt), aber mit falschem Grund. Jetzt nennt der Text, warum er sich nicht mehr prüfen lässt.
const temp = mkdtempSync(join(tmpdir(), "jarvis-protokoll-entfernt-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-attrappe-nur-fuer-tests";
process.env.JARVIS_PIN = "4711";

mkdirSync("data");
writeFileSync("protokolle.json", JSON.stringify({
  weg: { beschreibung: "Bald entfernt", stufe: "extern", schritte: [{ nachricht: "WEG LIEF" }] },
}));

const gesendet: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  if (url.endsWith("/sendMessage")) gesendet.push(body.text ?? "");
  return new Response(JSON.stringify({ ok: true, result: { message_id: 900 + gesendet.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const queue = await import("../src/queue.js");
const tools = await import("../src/tools.js");
const telegram = await import("../src/telegram.js");
const { protokolle } = await import("../src/protokolle.js");
const { stufeVerschaerft } = await import("../src/agent.js");
telegram.setzeWarten(async () => {}, () => 0.5, async () => {});

const werkzeug = tools.activeTools().find((t) => t.name === "protokoll_ausfuehren")!;

describe("stufeVerschaerft: Protokoll nach dem Anlegen entfernt", () => {
  it("Text nennt den wahren Grund («gibt es nicht»), nicht «sensibel»; nichts ausgeführt", async () => {
    const a = queue.createAuftrag({ tool: werkzeug.name, input: werkzeug.festhalten!({ name: "weg" }), stufe: "extern", summary: "Protokoll «weg»" });
    delete protokolle.weg;
    const text = stufeVerschaerft(a);
    assert.ok(text, "Auftrag darf nicht als unverändert gelten");
    assert.match(text, /gibt es nicht/);
    assert.doesNotMatch(text, /sensibel/);
    assert.match(text, new RegExp(`#${a.id}.*nicht aus.*neu beantragen`));

    const antwort = await telegram.approveAuftrag(a);
    assert.match(antwort, /gibt es nicht/);
    assert.doesNotMatch(antwort, /sensibel/);
    assert.notEqual(queue.getAuftrag(a.id)!.status, "erledigt");
    assert.ok(!gesendet.some((t) => t.includes("WEG LIEF")));
  });
});
