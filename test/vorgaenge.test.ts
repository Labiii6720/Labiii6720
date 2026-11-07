import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/ liegt relativ) und Umgebung; nie echte Dienste
const temp = mkdtempSync(join(tmpdir(), "jarvis-vorgaenge-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.WATCHDOG_MINUTEN = "10";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_BASE_URL;

/** Telegram gestört (Netzfehler) oder ok; Anthropic antwortet immer mit 400 (kein Retry) */
let telegramGestoert = false;
let gesendet: string[] = [];
/** Löst den Notfall aus, sobald der erste Teil des Vorgang-Ergebnisses gesendet ist (Notfall mitten im Versand) */
let notfallNachErstemTeil = false;
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (url.startsWith("https://api.telegram.org/bot")) {
    if (telegramGestoert) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
    gesendet.push(body.text ?? "");
    if (notfallNachErstemTeil && body.text?.startsWith("✅ Vorgang #")) state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Attrappe" };
    return new Response(JSON.stringify({ ok: true, result: { message_id: gesendet.length } }), { headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Attrappe: abgelehnt" } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const { listVorgaenge, startVorgang, vorgaenge } = await import("../src/vorgaenge.js");
const { postausgangTick, setzeWarten } = await import("../src/telegram.js");
const { gesundheit } = await import("../src/robust.js");
const { state } = await import("../src/state.js");
const { anthropic } = await import("../src/claude.js");

const POSTAUSGANG = join(temp, "data", "postausgang.json");
const VORGAENGE = join(temp, "data", "vorgaenge.json");
const CHAT = join(temp, "data", "chat.json");
/** Systemnotizen zu einem Vorgang aus der gespeicherten Chat-Historie */
const notizenZu = (id: number): string[] =>
  existsSync(CHAT)
    ? (JSON.parse(readFileSync(CHAT, "utf8")) as { content: unknown }[])
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .filter((t) => t.startsWith(`[Systemnotiz] Vorgang #${id} `))
    : [];
const liesPostausgang = (): { text: string }[] => (existsSync(POSTAUSGANG) ? (JSON.parse(readFileSync(POSTAUSGANG, "utf8")) as { text: string }[]) : []);
const hooks = { sendFile: async () => undefined, sendPhoto: async () => undefined, sendVideo: async () => undefined, onAuftrag: async () => undefined };

/** Wartet, bis die Bedingung gilt (der Hintergrundlauf ist nicht awaitbar; Wiederholungen warten über die Attrappe nicht) */
async function bis(bedingung: () => boolean): Promise<void> {
  const ende = Date.now() + 10_000;
  while (!bedingung() && Date.now() < ende) await new Promise((r) => setTimeout(r, 5));
  assert.ok(bedingung(), "Bedingung nicht erreicht");
}

let logs: { fehler: string[]; ende: () => void };
beforeEach(async () => {
  telegramGestoert = false;
  await postausgangTick();
  gesendet = [];
  setzeWarten(async () => undefined, () => 0.5);
  gesundheit._reset();
  const fehler: string[] = [];
  const log = console.log; const err = console.error;
  console.log = () => undefined;
  console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
  logs = { fehler, ende: () => { console.log = log; console.error = err; } };
});
const client = anthropic();
const origCreate = client.messages.create;
/** Claude-Attrappe: antwortet sofort mit einem fertigen Bericht; optional löst sie dabei den Notaus aus */
function claudeAntwortet(text: string, notausWaehrenddessen = false, mitWerkzeug = false): void {
  client.messages.create = (async () => {
    if (notausWaehrenddessen) state.paused = true;
    return {
      id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: mitWerkzeug ? "tool_use" : "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: "text", text, citations: null },
        // unbekanntes Werkzeug: würde ohnehin nichts bewirken; bei Notaus wird es gar nicht erst ausgeführt
        ...(mitWerkzeug ? [{ type: "tool_use", id: "toolu_1", name: "attrappe_gibt_es_nicht", input: {} }] : []),
      ],
    };
  }) as unknown as typeof client.messages.create;
}
afterEach(() => {
  logs.ende();
  state.paused = false;
  state.notfall = { aktiv: false };
  notfallNachErstemTeil = false;
  client.messages.create = origCreate;
});

describe("startVorgang bei Telegram-Störung", () => {
  it("Ergebnis bleibt «fertig» und kommt über den Postausgang nach", async () => {
    claudeAntwortet("Bericht fertig, Sir.");
    telegramGestoert = true;
    const v = startVorgang("Bericht zusammenstellen", hooks);
    await bis(() => liesPostausgang().some((e) => e.text.startsWith(`✅ Vorgang #${v.id} fertig`)));
    assert.equal(v.status, "fertig");
    assert.match(v.result ?? "", /Bericht fertig/);
    const gespeichert = (JSON.parse(readFileSync(VORGAENGE, "utf8")) as { id: number; status: string; result?: string }[]).find((x) => x.id === v.id);
    assert.equal(gespeichert?.status, "fertig");
    assert.equal(gespeichert?.result, v.result);
    assert.ok(!liesPostausgang().some((e) => e.text.includes("abgebrochen")));

    telegramGestoert = false;
    await postausgangTick();
    assert.equal(liesPostausgang().length, 0);
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0]!, new RegExp(`^\\(nachgereicht, \\d\\d:\\d\\d\\) ✅ Vorgang #${v.id} fertig`));
  });

  it("ohne Störung: Ergebnis wie bisher direkt gesendet", async () => {
    claudeAntwortet("Alles geprüft, Sir.");
    const v = startVorgang("Kurz prüfen", hooks);
    await bis(() => gesendet.some((t) => t.startsWith(`✅ Vorgang #${v.id} fertig (0 Werkzeugschritte)`)));
    assert.equal(v.status, "fertig");
    assert.equal(liesPostausgang().length, 0);
  });

  it("Notaus vor dem Senden: kein Ergebnistext nach aussen, nur der Hinweis", async () => {
    claudeAntwortet("Vertraulich: Kontostand 1234.", true);
    const v = startVorgang("Finanzen zusammenfassen", hooks);
    await bis(() => gesendet.some((t) => t === `⏸ Vorgang #${v.id} wegen Notaus angehalten.`));
    assert.ok(!gesendet.some((t) => t.includes("Kontostand") || t.includes("fertig")));
    assert.equal(liesPostausgang().length, 0);
    assert.notEqual(v.status, "fertig");
    assert.ok(!notizenZu(v.id).some((t) => t.includes("ist fertig") || t.includes("Kontostand")));
  });

  it("Notaus mitten im Lauf (tool_use): Vorgang gilt nicht als fertig, Claude erfährt den Abbruch", async () => {
    claudeAntwortet("Ich lege los.", true, true);
    const v = startVorgang("Grosser Bericht", hooks);
    await bis(() => gesendet.some((t) => t === `⏸ Vorgang #${v.id} wegen Notaus angehalten.`));
    assert.equal(v.status, "fehler");
    assert.equal(v.result, "wegen Notaus angehalten");
    assert.ok(v.finishedAt);
    const gespeichert = (JSON.parse(readFileSync(VORGAENGE, "utf8")) as { id: number; status: string }[]).find((x) => x.id === v.id);
    assert.equal(gespeichert?.status, "fehler");
    assert.ok(!listVorgaenge().includes(`#${v.id} fertig`));
    const notizen = notizenZu(v.id);
    assert.ok(!notizen.some((t) => t.includes("ist fertig")));
    assert.ok(notizen.some((t) => t.includes("wegen Notaus angehalten") && t.includes("nicht fertig")));
    assert.ok(!gesendet.some((t) => t.includes(`#${v.id} fertig`) || t.includes("Ich bin pausiert")));
  });

  it("Lauf scheitert → «fehler», Abbruchmeldung landet im Postausgang", async () => {
    telegramGestoert = true;
    const v = startVorgang("Etwas, das scheitert", hooks);
    await bis(() => liesPostausgang().some((e) => e.text.startsWith(`⚠️ Vorgang #${v.id} abgebrochen:`)));
    assert.equal(v.status, "fehler");
    assert.ok(v.finishedAt);
    assert.equal(vorgaenge.find((x) => x.id === v.id)?.status, "fehler");
    assert.ok(!liesPostausgang().some((e) => e.text.includes(`#${v.id} fertig`)));
  });

  it("Notfall während des Versands eines langen Ergebnisses: kein weiterer Teil, nichts im Postausgang", async () => {
    claudeAntwortet(`Langer Bericht: ${"Geheimes Detail. ".repeat(600)}Schluss mit Kontostand 1234.`);
    notfallNachErstemTeil = true;
    const v = startVorgang("Langen Bericht schreiben", hooks);
    await bis(() => v.status === "fertig" && gesendet.some((t) => t.startsWith(`✅ Vorgang #${v.id} fertig`)));
    // dem Versand Zeit für einen (fälschlichen) zweiten Teil lassen
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(gesendet.filter((t) => t.includes("Geheimes Detail")).length, 1, "nur der erste Teil");
    assert.ok(!gesendet.some((t) => t.includes("Kontostand")));
    assert.equal(liesPostausgang().length, 0);
  });

  it("im Notfall wird die Abbruchmeldung weder gesendet noch abgelegt", async () => {
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Attrappe" };
    const v = startVorgang("Etwas, das im Notfall scheitert", hooks);
    await bis(() => v.status === "fehler");
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!gesendet.some((t) => t.includes(`Vorgang #${v.id} abgebrochen`)));
    assert.ok(!liesPostausgang().some((e) => e.text.includes(`Vorgang #${v.id} abgebrochen`)));
  });
});
