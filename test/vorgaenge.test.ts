import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/ liegt relativ) und Umgebung; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-vorgaenge-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.WATCHDOG_MINUTEN = "10";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_BASE_URL;

/** Telegram gestört (Netzfehler) oder ok; Anthropic antwortet immer mit 400 (kein Retry) */
let telegramGestoert = false;
let gesendet: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (url.startsWith("https://api.telegram.org/bot")) {
    if (telegramGestoert) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
    gesendet.push(body.text ?? "");
    return new Response(JSON.stringify({ ok: true, result: { message_id: gesendet.length } }), { headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Attrappe: abgelehnt" } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const { startVorgang, vorgaenge } = await import("../src/vorgaenge.js");
const { postausgangTick, setzeWarten } = await import("../src/telegram.js");
const { gesundheit } = await import("../src/robust.js");
const { state } = await import("../src/state.js");

const POSTAUSGANG = join(temp, "data", "postausgang.json");
const VORGAENGE = join(temp, "data", "vorgaenge.json");
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
afterEach(() => { logs.ende(); state.paused = false; });

describe("startVorgang bei Telegram-Störung", () => {
  it("Ergebnis bleibt «fertig» und kommt über den Postausgang nach", async () => {
    state.paused = true; // runTask antwortet sofort ohne Claude
    telegramGestoert = true;
    const v = startVorgang("Bericht zusammenstellen", hooks);
    await bis(() => liesPostausgang().some((e) => e.text.startsWith(`✅ Vorgang #${v.id} fertig`)));
    assert.equal(v.status, "fertig");
    assert.match(v.result ?? "", /pausiert/);
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
    state.paused = true;
    const v = startVorgang("Kurz prüfen", hooks);
    await bis(() => gesendet.some((t) => t.startsWith(`✅ Vorgang #${v.id} fertig (0 Werkzeugschritte)`)));
    assert.equal(v.status, "fertig");
    assert.equal(liesPostausgang().length, 0);
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
});
