import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befund: Kam der Notfall während des Versands (Zeitplan, Rückblick, Zielcheck), verwarf sendeSpaeter die Antwort, sie
// blieb aber unmarkiert in der Historie – nach /entwarnung zeigte sie der Verlauf der Kommandozentrale doch.
const temp = mkdtempSync(join(tmpdir(), "jarvis-scheduler-notfall-verlauf-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.ZEITPLAN_NACHHOLEN_MIN = "60";
process.env.RUECKBLICK = "22:30";
process.env.ZIELCHECK = "so 18:00";

// Kein Netz im Test: Claude ist unten ersetzt, Telegram über abhaengigkeiten.sendeSpaeter
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

// Bestehende routinen.json: kein Erststart
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "routinen.json"), "{}");

const { anthropic } = await import("../src/claude.js");
const agent = await import("../src/agent.js");
const { abhaengigkeiten, rueckblickTick, zeitplanTick, zielcheckTick } = await import("../src/scheduler.js");
const { zeitplaene } = await import("../src/zeitplaene.js");
const { state } = await import("../src/state.js");
const { profil } = await import("../src/profil.js");
const { gesundheit } = await import("../src/robust.js");

/** 10.10.2026 Samstag, 11.10.2026 Sonntag (lokale Zeit) */
const am = (tag: number, h: number, m: number) => new Date(2026, 9, tag, h, m, 0, 0);

const client = anthropic();
const origCreate = client.messages.create;
const origSende = abhaengigkeiten.sendeSpaeter;
const origHandle = abhaengigkeiten.handleMessage;
let antwortText = "";
let gesendet: string[] = [];
const sichtbar = () => agent.letzteNachrichten(50).map((m) => m.text);

const nachricht = (text: string): Anthropic.Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  content: [{ type: "text", text, citations: null }],
} as Anthropic.Message);

/** Telegram-Attrappe: der Notfall wird ausgelöst, während der Text unterwegs ist; Rückgabe wie zustellen (verworfen) */
const notfallImVersand = (rueckgabe: boolean | void) => async (text: string) => {
  gesendet.push(text);
  state.paused = true;
  state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
  return rueckgabe;
};

const entwarnung = () => {
  state.paused = false;
  state.notfall = { aktiv: false };
};

beforeEach(() => {
  entwarnung();
  gesendet = [];
  zeitplaene.length = 0;
  profil.ziele.length = 0;
  gesundheit._reset();
  client.messages.create = (async () => nachricht(antwortText)) as unknown as typeof client.messages.create;
});
afterEach(() => {
  client.messages.create = origCreate;
  abhaengigkeiten.sendeSpaeter = origSende;
  abhaengigkeiten.handleMessage = origHandle;
  entwarnung();
});

describe("Scheduler: im Notfall verworfene Antworten bleiben aus dem Verlauf", () => {
  it("Zeitplan: Notfall während des Versands (verworfen) → nach /entwarnung nicht im Verlauf", async () => {
    zeitplaene.push({ id: 1, name: "Mails", zeit: "08:30", tage: "taeglich", auftrag: "Fass die Mails zusammen" });
    antwortText = "GEHEIM-ZEITPLAN: Mail von der Bank";
    abhaengigkeiten.sendeSpaeter = notfallImVersand(false);
    await zeitplanTick(am(10, 8, 30));
    assert.equal(gesendet.length, 1, "der Versand wurde versucht");
    entwarnung();
    assert.ok(!sichtbar().some((t) => t.includes("GEHEIM-ZEITPLAN")), "verworfene Antwort erscheint nicht");
  });

  it("Rückblick: ohne Rückmeldung von sendeSpaeter zählt der Notfall nach dem Versand", async () => {
    antwortText = "GEHEIM-RUECKBLICK: heute viel erledigt";
    abhaengigkeiten.sendeSpaeter = notfallImVersand(undefined);
    await rueckblickTick(am(10, 22, 30));
    assert.equal(gesendet.length, 1);
    entwarnung();
    assert.ok(!sichtbar().some((t) => t.includes("GEHEIM-RUECKBLICK")));
  });

  it("Zielcheck: Notfall während des Versands → nicht im Verlauf", async () => {
    profil.ziele.push({ id: 1, text: "Halbmarathon", status: "offen" } as never);
    antwortText = "GEHEIM-ZIELCHECK: Training steht still";
    abhaengigkeiten.sendeSpaeter = notfallImVersand(false);
    await zielcheckTick(am(11, 18, 0));
    assert.equal(gesendet.length, 1);
    entwarnung();
    assert.ok(!sichtbar().some((t) => t.includes("GEHEIM-ZIELCHECK")));
  });

  it("Notaus nach der Antwort, vor dem Senden: nichts gesendet, nach /weiter nicht im Verlauf", async () => {
    zeitplaene.push({ id: 2, name: "Termine", zeit: "09:00", tage: "taeglich", auftrag: "Was steht an?" });
    antwortText = "GEHEIM-VOR-VERSAND: Termin beim Anwalt";
    abhaengigkeiten.sendeSpaeter = async (text: string) => void gesendet.push(text);
    abhaengigkeiten.handleMessage = async (...a: Parameters<typeof origHandle>) => {
      const r = await origHandle(...a);
      state.paused = true; // /pause trifft ein, nachdem runLoop fertig ist
      return r;
    };
    await zeitplanTick(am(10, 9, 0));
    assert.deepEqual(gesendet, []);
    entwarnung();
    assert.ok(!sichtbar().some((t) => t.includes("GEHEIM-VOR-VERSAND")));
  });

  it("zugestellt (true) ohne Notfall bzw. Notfall erst danach: die Antwort bleibt sichtbar", async () => {
    zeitplaene.push({ id: 3, name: "Wetter", zeit: "10:00", tage: "taeglich", auftrag: "Wetter?" });
    antwortText = "SICHTBAR: Sonnig, 18 Grad.";
    abhaengigkeiten.sendeSpaeter = notfallImVersand(true);
    await zeitplanTick(am(10, 10, 0));
    entwarnung();
    assert.ok(sichtbar().some((t) => t.includes("SICHTBAR: Sonnig")), "zugestellte Antwort bleibt im Verlauf");
  });
});
