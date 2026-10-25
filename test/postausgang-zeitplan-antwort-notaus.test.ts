import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befund: Antworten aus Zeitplan, Rückblick, Zielcheck und Vorgang liefen über sendeSpaeter ohne Marke `antwort`. Lagen
// sie wegen einer Störung im Postausgang, schickte postausgangTick sie mitten im Notaus in den womöglich übernommenen
// Chat; ein Notaus während des Versands hielt den Rest nicht zurück. Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-postausgang-zeitplan-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_ANREDE = "Sir";
process.env.JARVIS_FORM = "sie";
process.env.ZEITPLAN_NACHHOLEN_MIN = "60";
process.env.WEB_SEARCH = "off";
for (const k of ["RUECKBLICK", "RECHNUNG_ERINNERUNG", "ZIELCHECK", "VERDICHTUNG", "FINANZBERICHT"]) process.env[k] = "off";

// Bestehende routinen.json: kein Erststart
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "routinen.json"), "{}");

const telegram: string[] = [];
let fehlschlaege = 0;
/** Wird vor dem Zustellen eines Teils aufgerufen (etwa: Notaus trifft während des Versands ein) */
let vorDemSenden: (() => void) | undefined;
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  if (url.endsWith("/sendMessage") && typeof init?.body === "string") {
    vorDemSenden?.();
    if (fehlschlaege > 0) {
      fehlschlaege--;
      return new Response(JSON.stringify({ ok: false, error_code: 502, description: "Bad Gateway" }), { status: 502, headers: { "content-type": "application/json" } });
    }
    telegram.push(String((JSON.parse(init.body) as { text?: string }).text ?? ""));
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: telegram.length + 1 } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const agent = await import("../src/agent.js");
const { postausgangTick, sendeAntwort, sendeSpaeter, setzeWarten } = await import("../src/telegram.js");
const { zeitplanTick } = await import("../src/scheduler.js");
const { zeitplaene } = await import("../src/zeitplaene.js");
const { startVorgang } = await import("../src/vorgaenge.js");
const { hooks } = await import("../src/telegram.js");
const { state } = await import("../src/state.js");
const { gesundheit } = await import("../src/robust.js");

const DATEI = join(temp, "data", "postausgang.json");
const eintraege = () => {
  try {
    return JSON.parse(readFileSync(DATEI, "utf8")) as { text: string; antwort?: true }[];
  } catch {
    return [];
  }
};
const client = anthropic();
const origCreate = client.messages.create;
let claudeText = "";
/** 10.10.2026 Samstag (lokale Zeit) */
const am = (h: number, m: number) => new Date(2026, 9, 10, h, m, 0, 0);

beforeEach(async () => {
  setzeWarten(async () => {}, () => 0.5);
  gesundheit._reset();
  telegram.length = 0;
  fehlschlaege = 0;
  vorDemSenden = undefined;
  zeitplaene.length = 0;
  client.messages.create = (async () => ({
    id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
    content: [{ type: "text", text: claudeText, citations: null }],
  }) as Anthropic.Message) as unknown as typeof client.messages.create;
  // Postausgang leeren
  state.paused = false;
  state.notfall = { aktiv: false };
  await postausgangTick();
  telegram.length = 0;
});
afterEach(() => {
  client.messages.create = origCreate;
  state.paused = false;
  state.notfall = { aktiv: false };
});

describe("Antworten automatischer Läufe im Postausgang: im Notaus zurückgehalten", () => {
  it("Zeitplan-Antwort bei Störung: mit Marke abgelegt, im Notaus nicht nachgereicht, nach /weiter schon", async () => {
    zeitplaene.push({ id: 1, name: "Mails am Morgen", zeit: "08:30", tage: "taeglich", auftrag: "Fass die Mails zusammen" });
    claudeText = "GEHEIM: Mail von der Bank";
    fehlschlaege = 4;
    await zeitplanTick(am(8, 30));
    assert.equal(telegram.length, 0);
    assert.equal(eintraege().length, 1);
    assert.equal(eintraege()[0]!.antwort, true, "Marke antwort");

    state.paused = true; // Notaus über die Kommandozentrale
    await postausgangTick();
    assert.ok(!telegram.some((t) => t.includes("GEHEIM")), telegram.join(" | "));
    assert.equal(eintraege().length, 1, "nicht verworfen");

    state.paused = false; // /weiter
    await postausgangTick();
    assert.equal(telegram.length, 1);
    assert.match(telegram[0]!, /^\(nachgereicht, .*\) 🕒 Mails am Morgen\n\nGEHEIM/);
  });

  it("im Postausgang liegt nur Zurückgestelltes: eine neue Antwort geht im Notaus nicht sofort hinaus", async () => {
    // Eine späte Antwort aus der Zentrale liegt (markiert) im Postausgang
    fehlschlaege = 4;
    await sendeAntwort("ALT: Antwort");
    assert.equal(eintraege()[0]!.antwort, true);
    state.paused = true;
    await sendeSpaeter("NEU: Antwort", { imNotfallZurueckhalten: true, antwort: true });
    assert.deepEqual(telegram, []);
    // Eine gewöhnliche Meldung geht weiterhin
    await sendeSpaeter("⏰ Zahnarzt");
    assert.deepEqual(telegram, ["⏰ Zahnarzt"]);
  });

  it("Notaus während des Versands: der Rest geht weder hinaus noch in den Postausgang, der Verlauf zeigt sie nicht", async () => {
    zeitplaene.push({ id: 2, name: "Termine", zeit: "09:00", tage: "taeglich", auftrag: "Was steht an?" });
    claudeText = `GEHEIM-LANG ${"x".repeat(5000)}`;
    let teile = 0;
    vorDemSenden = () => {
      if (++teile === 1) state.paused = true; // /pause trifft ein, während der erste Teil unterwegs ist
    };
    await zeitplanTick(am(9, 0));
    assert.equal(telegram.length, 1, "nur der erste Teil");
    assert.deepEqual(eintraege(), []);
    state.paused = false;
    assert.ok(!agent.letzteNachrichten(50).some((n) => n.text.includes("GEHEIM-LANG")));
  });

  it("Vorgang: Ergebnis bei Störung mit Marke abgelegt, im Notaus zurückgehalten", async () => {
    claudeText = "GEHEIM-VORGANG: Bericht";
    fehlschlaege = 4;
    startVorgang("Prüfe die Offerten", hooks);
    for (let i = 0; i < 100 && eintraege().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const e = eintraege().find((x) => x.text.includes("GEHEIM-VORGANG"));
    assert.ok(e, JSON.stringify(eintraege()));
    assert.equal(e.antwort, true);
    state.paused = true;
    await postausgangTick();
    assert.ok(!telegram.some((t) => t.includes("GEHEIM-VORGANG")));
    state.paused = false;
    await postausgangTick();
    assert.ok(telegram.some((t) => t.includes("GEHEIM-VORGANG")));
  });
});
