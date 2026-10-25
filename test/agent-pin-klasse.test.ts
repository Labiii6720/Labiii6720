import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Befund: pinGeschwaerzt verglich mit dem echten JARVIS_PIN-Wert. Verlauf der Kommandozentrale (GET /api/chat/verlauf),
// Telegram-Echos und späte Antworten zeigten «<PIN>» genau an der Stelle der PIN: Eine Kandidatenliste per Chat, dann
// den Verlauf lesen, ergab die PIN ungezählt (Orakel, an pinPruefen und abuseSignal vorbei). Dazu verstümmelte das
// Muster ohne Ziffergrenzen Uhrzeit, Datum, Beträge und Telefonnummern. Jetzt: nur nach Klasse, nie nach Wert.
// Temp-Ordner, Attrappen, kein Netz.
const temp = mkdtempSync(join(tmpdir(), "jarvis-pin-klasse-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PIN = "4711";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = "pin-klasse-token-nur-attrappe-0123456789";
process.env.WEB_SEARCH = "off";
for (const k of ["RUECKBLICK", "RECHNUNG_ERINNERUNG", "ZIELCHECK", "VERDICHTUNG", "FINANZBERICHT"]) process.env[k] = "off";

/** Texte, die an Telegram gingen (sendMessage) */
const telegram: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Netzaufruf: ${url}`);
  if (url.endsWith("/sendMessage") && typeof init?.body === "string") telegram.push(String((JSON.parse(init.body) as { text?: string }).text ?? ""));
  return new Response(JSON.stringify({ ok: true, result: { message_id: telegram.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { anthropic } = await import("../src/claude.js");
const { config } = await import("../src/config.js");
const agent = await import("../src/agent.js");
const dashboard = await import("../src/dashboard.js");
const { state } = await import("../src/state.js");
const { missbrauchZuruecksetzen } = await import("../src/notfall.js");
const { setzeWarten } = await import("../src/telegram.js");

const client = anthropic();
const origCreate = client.messages.create;
let claudeAntwort = "Notiert, Sir.";
let claudeVerzoegerung = 0;

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
/** Dasselbe mit einer anderen PIN (gleicher Klasse) */
function mitPin<T>(pin: string, f: () => T): T {
  const alt = config.pin;
  config.pin = pin;
  try {
    return f();
  } finally {
    config.pin = alt;
  }
}

beforeEach(() => {
  setzeWarten(async () => {}, () => 0.5);
  missbrauchZuruecksetzen();
  telegram.length = 0;
  claudeAntwort = "Notiert, Sir.";
  claudeVerzoegerung = 0;
  client.messages.create = (async () => {
    if (claudeVerzoegerung) await new Promise((r) => setTimeout(r, claudeVerzoegerung));
    return {
      id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
      content: [{ type: "text", text: claudeAntwort, citations: null }],
    } as Anthropic.Message;
  }) as unknown as typeof client.messages.create;
});
afterEach(() => {
  client.messages.create = origCreate;
  dashboard._chatFrist.ms = 60_000;
  state.paused = false;
  state.notfall = { aktiv: false };
});

describe("pinGeschwaerzt: nach Klasse, nie nach Wert", () => {
  it("die richtige PIN und jeder andere Kandidat sehen gleich aus", () => {
    assert.equal(agent.pinGeschwaerzt("Ist 0815 gut?"), agent.pinGeschwaerzt("Ist 4711 gut?"));
    assert.equal(agent.pinGeschwaerzt("Ist 4711 gut?"), "Ist <PIN> gut?");
    assert.equal(agent.pinGeschwaerzt("k4710 k4711 k4712"), "k<PIN> k<PIN> k<PIN>");
    assert.equal(agent.pinGeschwaerzt("4709/4710/4711/4712"), "<PIN>/<PIN>/<PIN>/<PIN>");
  });

  it("das Ergebnis ist für PIN 4711 und PIN 4712 byte-gleich", () => {
    const kandidaten = Array.from({ length: 400 }, (_, i) => String(4500 + i)).join("x");
    const texte = [kandidaten, "4709/4710/4711/4712", "Die 4 7 1 1 und 47-11, nicht 4 7 1 2", "PIN 4711, 0815 und 47-12"];
    for (const t of texte) assert.equal(mitPin("4711", () => agent.pinGeschwaerzt(t)), mitPin("4712", () => agent.pinGeschwaerzt(t)), t);
    // Auch eine gemischte PIN derselben Länge verrät ihren Wert nicht
    assert.equal(mitPin("ab12", () => agent.pinGeschwaerzt("Code ab12 und ab13")), mitPin("zz99", () => agent.pinGeschwaerzt("Code ab12 und ab13")));
  });

  it("gewöhnliche Zahlen bleiben stehen: Uhrzeit, Datum, Betrag, Telefon-, Bestell- und Sendungsnummer", () => {
    const proben: [string, string][] = [
      ["4711", "Rufen Sie 079 471 12 34 an, Rechnung 47.11 CHF, PLZ 14711"],
      ["4711", "Rufen Sie 044 471 1234 an"],
      ["4711", "Betrag CHF 47.11, Bestellung 847112, Sendungsnummer 99.47.11.03"],
      ["123456", "079 123 45 67"],
      ["1430", "Ihr Termin ist um 14.30 Uhr, Sir."],
      ["2510", "der 25.10.2026"],
      ["1234", "Rechnung Nr. 2026-1234 über CHF 1 234.50"],
      ["0815", "Zug um 08.15"],
      ["2026", "31.3.2026, am 3. November 2026, CHF 2026"],
      ["4711", "Rufen Sie +41 44 471 1234 an, oder 0041 44 471 1234"],
    ];
    for (const [pin, t] of proben) assert.equal(mitPin(pin, () => agent.pinGeschwaerzt(t)), t, `${pin}: ${t}`);
  });

  it("die PIN in PIN-Form wird weiter geschwärzt («Die 4711 gilt», «4 7 1 1», «47-11»)", () => {
    assert.equal(agent.pinGeschwaerzt("Die 4711 gilt, 4 7 1 1 und 47-11."), "Die <PIN> gilt, <PIN> und <PIN>.");
  });

  it("PIN ohne Ziffern: kein Wertvergleich, der Text bleibt", () => {
    assert.equal(mitPin("Kronleuchter", () => agent.pinGeschwaerzt("Das Kronleuchter-Wort")), "Das Kronleuchter-Wort");
  });
});

describe("Verlauf der Kommandozentrale: kein PIN-Orakel", () => {
  it("Kandidatenliste per Chat, dann Verlauf: alle Kandidaten gleich, keine Stelle verrät die PIN", async () => {
    // 300 Kandidaten (unter 2000 Zeichen); 4711 liegt darin
    const kandidaten = Array.from({ length: 300 }, (_, i) => String(4600 + i));
    const r = await chat(`Notiz ${kandidaten.join("x")}`);
    assert.equal(r.statusCode, 200, "ein Satz ist nicht PIN-förmig");
    const nutzer = verlauf().filter((n) => n.rolle === "nutzer").at(-1)!;
    assert.equal(nutzer.text, `Notiz ${kandidaten.map(() => "<PIN>").join("x")}`);
    assert.ok(!/\d/.test(nutzer.text));
    assert.equal(mitPin("4712", () => agent.letzteNachrichten().at(-2)!.text), nutzer.text, "für PIN 4712 byte-gleich");
  });

  it("«k4710 k4711 k4712»: dieselbe Darstellung für alle drei", async () => {
    await chat("Bitte merken k4710 k4711 k4712");
    const nutzer = verlauf().filter((n) => n.rolle === "nutzer").at(-1)!;
    assert.equal(nutzer.text, "Bitte merken k<PIN> k<PIN> k<PIN>");
  });

  it("«Ist 0815 gut?» und «Ist 4711 gut?»: im Verlauf und im Telegram-Echo dieselbe Form", async () => {
    await chat("Ist 0815 gut?");
    const a = verlauf().filter((n) => n.rolle === "nutzer").at(-1)!.text;
    await chat("Ist 4711 gut?");
    const b = verlauf().filter((n) => n.rolle === "nutzer").at(-1)!.text;
    assert.equal(a, b);

    dashboard._chatFrist.ms = 5;
    claudeVerzoegerung = 40;
    for (const t of ["Ist 0815 gut?", "Ist 4711 gut?"]) {
      const spaet = await chat(t);
      assert.equal(spaet.body.queued, true);
    }
    for (let i = 0; i < 100 && telegram.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(telegram.length, 2);
    assert.equal(telegram[0], telegram[1]);
    assert.match(telegram[0]!, /^Zur Frage aus der Zentrale \(«Ist <PIN> gut\?»\):/);
  });
});
