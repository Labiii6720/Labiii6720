import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befunde zum Verlauf der Kommandozentrale (sichtbareNachrichten):
// 1. Beim Limit der Werkzeugrunden fehlte die ausgegebene Antwort (sie trägt tool_use) – nur die Frage stand da.
// 2. Ereignisse aus Home Assistant erschienen als Nachricht des Nutzers («Sie»).
// 3. Ein Zeitplan-Lauf mit «]» im Namen erschien als Nachricht des Nutzers.
// Temp-Ordner, Claude-Attrappe, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-verlauf-befunde-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = "verlauf-befunde-token-nur-attrappe-01234";
process.env.MAX_LOOPS = "2";
process.env.WEB_SEARCH = "off";
for (const k of ["RUECKBLICK", "RECHNUNG_ERINNERUNG", "ZIELCHECK", "VERDICHTUNG", "FINANZBERICHT"]) process.env[k] = "off";
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const agent = await import("../src/agent.js");

const client = anthropic();
const origCreate = client.messages.create;
const hooks = { onAuftrag: async () => undefined } as unknown as Parameters<typeof agent.handleMessage>[1];
/** Was an die API ging (alle Nachrichten des letzten Aufrufs) */
let anApi: Anthropic.MessageParam[] = [];

const msg = (content: unknown[], stop: string): Anthropic.Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  content,
} as Anthropic.Message);

function claude(antwort: () => Anthropic.Message) {
  client.messages.create = (async (p: Anthropic.MessageCreateParams) => {
    anApi = structuredClone(p.messages);
    return antwort();
  }) as unknown as typeof client.messages.create;
}
afterEach(() => {
  client.messages.create = origCreate;
  agent.resetHistory();
});

describe("Limit der Werkzeugrunden: die ausgegebene Antwort steht im Verlauf", () => {
  it("Frage und Zwischenstand mit Limit-Hinweis, nicht nur die Frage", async () => {
    let n = 0;
    claude(() => msg([{ type: "text", text: `Zwischenstand ${++n}, Sir.`, citations: null }, { type: "tool_use", id: `tu_${n}`, name: "gibt_es_nicht", input: {} }], "tool_use"));
    const reply = await agent.handleMessage("Frage X", hooks);
    assert.equal(reply, "Zwischenstand 2, Sir.\n\n(Limit von 2 Werkzeugrunden erreicht, Zwischenstand.)");
    assert.deepEqual(agent.letzteNachrichten(), [
      { rolle: "nutzer", text: "Frage X" },
      { rolle: "jarvis", text: "Zwischenstand 2, Sir.\n\n(Limit der Werkzeugrunden erreicht, Zwischenstand.)" },
    ], "der erste Zwischenschritt bleibt verborgen, die ausgegebene Antwort nicht");
  });

  it("die Marke geht nicht an die API, bleibt aber in data/chat.json", async () => {
    let n = 0;
    claude(() => msg([{ type: "tool_use", id: `tu_${++n}`, name: "gibt_es_nicht", input: {} }], "tool_use"));
    await agent.handleMessage("Frage Y", hooks);
    claude(() => msg([{ type: "text", text: "Fertig, Sir.", citations: null }], "end_turn"));
    await agent.handleMessage("Weiter", hooks);
    assert.ok(!JSON.stringify(anApi).includes("ausgegeben"), "keine unbekannten Felder an die API");
    assert.ok(readFileSync(join(temp, "data", "chat.json"), "utf8").includes('"ausgegeben":true'));
    // Ohne Text: nur der Hinweis
    assert.deepEqual(agent.letzteNachrichten().slice(0, 2), [{ rolle: "nutzer", text: "Frage Y" }, { rolle: "jarvis", text: "(Limit der Werkzeugrunden erreicht, Zwischenstand.)" }]);
  });

  it("eine tool_use-Antwort ohne Marke bleibt verborgen (wie bisher)", () => {
    const v = [
      { role: "user", content: "Frage Z" },
      { role: "assistant", content: [{ type: "text", text: "Zwischenschritt" }, { type: "tool_use", id: "tu_1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
    ];
    assert.deepEqual(agent.sichtbareNachrichten(v), [{ rolle: "nutzer", text: "Frage Z" }]);
  });
});

describe("Ereignisse aus dem Haus", () => {
  it("erscheinen als «haus», nicht als Nachricht des Nutzers; Präfix weg", () => {
    const v = [
      { role: "user", content: "[Ereignis aus dem Haus] Waschmaschine fertig, Strom 0 W" },
      { role: "assistant", content: [{ type: "text", text: "Die Wäsche wartet, Sir." }] },
      { role: "user", content: "[Kommandozentrale] Danke" },
    ];
    assert.deepEqual(agent.sichtbareNachrichten(v), [
      { rolle: "haus", text: "Waschmaschine fertig, Strom 0 W" },
      { rolle: "jarvis", text: "Die Wäsche wartet, Sir." },
      { rolle: "nutzer", text: "Danke" },
    ]);
  });
});

describe("Automatische Läufe", () => {
  it("Zeitplan mit «]» im Namen (Altbestand ohne Marke): nicht im Verlauf", () => {
    const v = [
      { role: "user", content: "[Zeitplan «Bericht [Büro]», läuft automatisch] Mails sichten" },
      { role: "user", content: "[Zeitplan «a]b]c», läuft automatisch] x" },
      { role: "user", content: "[Tagesrückblick, läuft automatisch] Schau zurück" },
      { role: "user", content: "[Wöchentlicher Zielcheck, läuft automatisch] Ziele" },
      { role: "assistant", content: [{ type: "text", text: "Drei neue Mails, Sir." }] },
    ];
    assert.deepEqual(agent.sichtbareNachrichten(v), [{ rolle: "jarvis", text: "Drei neue Mails, Sir." }]);
  });

  it("RunOptions.automatisch: der Auftrag ist markiert, nicht im Verlauf und ohne Marke an der API", async () => {
    claude(() => msg([{ type: "text", text: "Erledigt, Sir.", citations: null }], "end_turn"));
    await agent.handleMessage("Mails sichten ohne Präfix", hooks, { automatisch: true });
    assert.deepEqual(agent.letzteNachrichten(), [{ rolle: "jarvis", text: "Erledigt, Sir." }]);
    assert.ok(!JSON.stringify(anApi).includes("automatisch"), "keine unbekannten Felder an die API");
    assert.equal(anApi.at(-1)!.content, "Mails sichten ohne Präfix");
    // Ohne die Option bleibt es eine Nachricht des Nutzers
    await agent.handleMessage("Frage vom Nutzer", hooks);
    assert.deepEqual(agent.letzteNachrichten().slice(-2), [{ rolle: "nutzer", text: "Frage vom Nutzer" }, { rolle: "jarvis", text: "Erledigt, Sir." }]);
  });
});
