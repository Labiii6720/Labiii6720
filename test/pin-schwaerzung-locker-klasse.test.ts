import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befunde: (1) pinGeschwaerzt liess «47 11», «471 1» und «47–11» stehen, die der Locker selbst als PIN führt; (2) eine
// Zahl daneben («4711 2 mal», «4711 4711», «PIN 4711 0815») verhinderte die Schwärzung; (3) jede Live-Antwort von Claude
// lief nach Klasse durch, Postleitzahl, Jahr und Bestellnummer wurden zu «<PIN>»; (4) «14-16» oder «14 30» als ganze
// Nachricht zählten als PIN-Raten (Notfall nach fünf). Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-pin-locker-klasse-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = "pin-locker-klasse-token-nur-attrappe-0123";
process.env.JARVIS_ANREDE = "Sir";
process.env.JARVIS_FORM = "sie";
process.env.STT_URL = "https://stt.invalid/v1/audio/transcriptions";
process.env.WEB_SEARCH = "off";

let telegram: string[] = [];
let sttText = "";
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (url.startsWith("https://stt.invalid/")) return new Response(JSON.stringify({ text: sttText }), { headers: { "content-type": "application/json" } });
  if (url.startsWith("https://api.telegram.org/file/")) return new Response(new Uint8Array([1, 2, 3]));
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  const method = url.split("/").pop() ?? "";
  if (method === "sendMessage" && typeof init?.body === "string") telegram.push(String((JSON.parse(init.body) as { text?: string }).text ?? ""));
  const result = method === "getFile" ? { file_path: "voice/a.oga" } : { message_id: telegram.length + 1 };
  return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const { config } = await import("../src/config.js");
const agent = await import("../src/agent.js");
const dashboard = await import("../src/dashboard.js");
const { handleUpdate, pinFoermigLocker, pinRatenZaehlen, setzeWarten } = await import("../src/telegram.js");
const { state } = await import("../src/state.js");
const { missbrauchZuruecksetzen } = await import("../src/notfall.js");

const AUDIT = join(temp, "data", "audit.log");
const missbrauch = () => (existsSync(AUDIT) ? readFileSync(AUDIT, "utf8").split("\n").filter((z) => z.includes('"event":"abuse_signal"')).length : 0);

const client = anthropic();
const origCreate = client.messages.create;
let claudeAntwort = "Notiert, Sir.";
let nr = 51_000;

function mitPin<T>(pin: string, f: () => T): T {
  const alt = config.pin;
  config.pin = pin;
  try {
    return f();
  } finally {
    config.pin = alt;
  }
}
function antwort() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}
async function chat(text: string): Promise<{ statusCode: number; body: any }> {
  const res = antwort();
  await dashboard.chat({ body: { text } } as never, res as never);
  return { statusCode: res.statusCode, body: res.body };
}
function verlauf(): { rolle: string; text: string }[] {
  const res = antwort();
  dashboard.chatVerlauf({} as never, res as never);
  return res.body.nachrichten;
}

beforeEach(() => {
  setzeWarten(async () => {}, () => 0.5);
  missbrauchZuruecksetzen();
  telegram = [];
  claudeAntwort = "Notiert, Sir.";
  client.messages.create = (async () => ({
    id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
    content: [{ type: "text", text: claudeAntwort, citations: null }],
  }) as Anthropic.Message) as unknown as typeof client.messages.create;
});
afterEach(() => {
  client.messages.create = origCreate;
  state.paused = false;
  state.notfall = { aktiv: false };
});

/** Fassungen, die der Locker als ganze Eingabe als PIN führt (gesprochen, getippt, mit Trennern) */
const LOCKER_FORMEN = ["4711", "4 7 1 1", "4, 7, 1, 1", "4.7.1.1", "4–7–1–1", "47-11", "47 11", "471 1", "4 711", "47–11", "47 — 11", "4 7 11"];

describe("pinGeschwaerzt schwärzt jede Fassung des Lockers, auch mitten im Satz", () => {
  it("was pinFoermigLocker als PIN führt, steht in keinem Satz mehr", () => {
    for (const f of LOCKER_FORMEN) {
      assert.notEqual(pinFoermigLocker(f), undefined, `Locker: ${f}`);
      for (const [satz, erwartet] of [
        [`Die PIN ist ${f}`, "Die PIN ist <PIN>"],
        [`PIN ${f} bitte`, "PIN <PIN> bitte"],
        [`PIN: ${f}, danke`, "PIN: <PIN>, danke"],
        [`«${f}» war es`, "«<PIN>» war es"],
      ]) assert.equal(agent.pinGeschwaerzt(satz!), erwartet, satz);
    }
  });

  it("eine Zahl daneben verhindert die Schwärzung nicht", () => {
    const proben: [string, string][] = [
      ["Meine PIN ist 4711 2 mal falsch", "Meine PIN ist <PIN> 2 mal falsch"],
      ["4711 4711", "<PIN> <PIN>"],
      ["PIN 4711 0815", "PIN <PIN> <PIN>"],
      ["Sie schrieben 4711 2x", "Sie schrieben <PIN> 2x"],
      ["Die PIN 4711 12 Mal", "Die PIN <PIN> 12 Mal"],
      ["Meine PIN ist 47 11", "Meine PIN ist <PIN>"],
      ["Ich habe die PIN 47 11 zweimal falsch eingegeben", "Ich habe die PIN <PIN> zweimal falsch eingegeben"],
    ];
    for (const [t, erwartet] of proben) assert.equal(agent.pinGeschwaerzt(t), erwartet, t);
  });

  it("nie nach dem Wert: für PIN 4711 und 4712 byte-gleich, Telefonnummern und Daten bleiben", () => {
    const texte = ["Die PIN ist 47 11, nicht 47–12 oder 471 3", "4711 2 mal, 4712 0815", "Ruf 079 123 45 67 an, am 25.10.2026"];
    for (const t of texte) assert.equal(mitPin("4711", () => agent.pinGeschwaerzt(t)), mitPin("4712", () => agent.pinGeschwaerzt(t)), t);
    assert.equal(agent.pinGeschwaerzt("Ruf 079 123 45 67 oder 044 471 1234 an, am 25.10.2026 um 14.30"), "Ruf 079 123 45 67 oder 044 471 1234 an, am 25.10.2026 um 14.30");
  });

  it("Verlauf der Kommandozentrale: «Code 47 11» erscheint als «Code <PIN>»", () => {
    const n = agent.sichtbareNachrichten([{ role: "user", content: "[Kommandozentrale] Merk dir: Code 47 11 fuer die Garage" }]);
    assert.deepEqual(n, [{ rolle: "nutzer", text: "Merk dir: Code <PIN> fuer die Garage" }]);
  });

  it("Telegram-Sprache «Die PIN ist 47 11»: Echo ohne PIN, Claude bekommt den Satz", async () => {
    sttText = "Die PIN ist 47 11";
    await handleUpdate({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, voice: { file_id: "datei", duration: 3 } } });
    assert.equal(telegram[0], "🎙 Die PIN ist <PIN>");
    assert.ok(!telegram.some((t) => /47\s*11/.test(t)), telegram.join(" | "));
  });
});

describe("Antworten von Claude: nur was der Nutzer in PIN-Form schrieb", () => {
  const AUS_WERKZEUGEN = "Bestellung #1042 nach 8001 Zürich, Lieferung bis Ende 2026, Auftrag #1234 wartet. Termin um 1430, 14-16 Uhr.";

  it("Postleitzahl, Jahr, Bestell- und Auftragsnummer bleiben lesbar", () => {
    assert.equal(agent.antwortGeschwaerzt(AUS_WERKZEUGEN, "<PIN>", [{ role: "user", content: "Wo ist meine Bestellung?" }]), AUS_WERKZEUGEN);
  });

  it("die Zahl aus der Eingabe des Nutzers (auch anders geschrieben) und nach «PIN»/«Code» wird geschwärzt", () => {
    const v = [{ role: "user", content: "Merk dir 47 11 für die Garage" }];
    assert.equal(agent.antwortGeschwaerzt("Notiert: 4711 (Garage), Bestellung 1042.", "<PIN>", v), "Notiert: <PIN> (Garage), Bestellung 1042.");
    assert.equal(agent.antwortGeschwaerzt("Ihr Code lautet 0815.", "<PIN>", []), "Ihr Code lautet <PIN>.");
    // Werkzeugergebnisse und Systemnotizen zählen nicht als Eingabe des Nutzers
    const werkzeug = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "Bestellung 1042" }] }, { role: "user", content: "[Systemnotiz] Auftrag #12 erledigt: 8001" }];
    assert.equal(agent.antwortGeschwaerzt("1042 und 8001", "<PIN>", werkzeug), "1042 und 8001");
  });

  it("kein Orakel: eine Kandidatenliste erscheint für PIN 4711 und 4712 gleich, ganz geschwärzt", () => {
    const v = [{ role: "user", content: "Notiz 4709 4710 4711 4712" }];
    const a = "Notiert: 4709, 4710, 4711, 4712.";
    assert.equal(mitPin("4711", () => agent.antwortGeschwaerzt(a, "<PIN>", v)), "Notiert: <PIN>, <PIN>, <PIN>, <PIN>.");
    assert.equal(mitPin("4712", () => agent.antwortGeschwaerzt(a, "<PIN>", v)), mitPin("4711", () => agent.antwortGeschwaerzt(a, "<PIN>", v)));
  });

  it("Telegram-Haupt-Chat, Kommandozentrale und Verlauf zeigen die Zahlen aus Werkzeugen unverändert", async () => {
    claudeAntwort = AUS_WERKZEUGEN;
    await handleUpdate({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, text: "Wo steht meine Bestellung?" } });
    assert.deepEqual(telegram, [AUS_WERKZEUGEN]);
    const r = await chat("Und die Lieferung?");
    assert.equal(r.body.reply, AUS_WERKZEUGEN);
    assert.equal(verlauf().at(-1)!.text, AUS_WERKZEUGEN);
  });
});

describe("Locker: getrennte Gruppen abweisen, aber nicht als PIN-Raten zählen", () => {
  it("«14-16», «14 30», «47 11» werden abgewiesen, zählen aber nicht; «4711» und «4 7 1 1» zählen", () => {
    const vorher = missbrauch();
    for (const t of ["14-16", "14 30", "47 11", "47–11"]) {
      assert.notEqual(pinFoermigLocker(t), undefined, t);
      pinRatenZaehlen(t);
    }
    assert.equal(missbrauch() - vorher, 0);
    pinRatenZaehlen("4711");
    pinRatenZaehlen("4 7 1 1");
    assert.equal(missbrauch() - vorher, 2);
  });

  it("zehnstellige PIN mit Telefonnummer, achtstellige mit ISO-Datum: nicht gezählt", () => {
    const vorher = missbrauch();
    mitPin("0791234567", () => {
      assert.notEqual(pinFoermigLocker("079 123 45 67"), undefined);
      pinRatenZaehlen("079 123 45 67");
    });
    mitPin("20261025", () => {
      assert.notEqual(pinFoermigLocker("2026-10-25"), undefined);
      pinRatenZaehlen("2026-10-25");
    });
    assert.equal(missbrauch() - vorher, 0);
  });

  it("fünf Antworten «14-16» in Telegram: gelöscht, kein Notfall", async () => {
    const vorher = missbrauch();
    for (let i = 0; i < 5; i++) await handleUpdate({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, text: "14-16" } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(Boolean(state.notfall?.aktiv), false);
    assert.equal(Boolean(state.paused), false);
    assert.equal(missbrauch() - vorher, 0);
    assert.ok(telegram.every((t) => t === "Keine Freigabe wartet auf eine PIN, Sir. Nachricht gelöscht."), telegram.join(" | "));
  });
});
