import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

// Freigegeben ist der Stand, den die Freigabe zeigte. Früher lief ein alter extern-Auftrag eines inzwischen sensiblen
// Protokolls mit blossem Tippen, ein Browser-Klick traf eine später per auto geöffnete Seite samt getippter IBAN, ein
// Notfall mitten in einer langen Freigabe hielt die übrigen Teile nicht zurück, saveRechnungen warf ältere offene
// Rechnungen weg, und jeder Neustart mit kaputter Liste legte eine weitere Sicherung an.
const temp = mkdtempSync(join(tmpdir(), "jarvis-freigabe-stand-"));
process.chdir(temp);
// Im Temp-Ordner bleiben bis zum Prozessende (spätes Schreiben landet nie im Projekt), dann aufräumen
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-attrappe-nur-fuer-tests";
process.env.JARVIS_PIN = "4711";

// Bestand vor dem Import (wie nach einem Neustart)
mkdirSync("data");
// Offener Auftrag aus der Zeit, als «tresor» unbekannt bzw. extern war; inzwischen ist es sensibel
writeFileSync("data/auftraege.json", JSON.stringify([
  { id: 1, createdAt: "2026-10-01T08:00:00.000Z", tool: "protokoll_ausfuehren", input: { name: "tresor" }, stufe: "extern", summary: "Protokoll «tresor»: unbekannt", status: "offen", messageId: 50 },
  { id: 2, createdAt: "2026-10-01T08:00:00.000Z", tool: "protokoll_ausfuehren", input: { name: "tresor" }, stufe: "extern", summary: "Protokoll «tresor»: unbekannt", status: "offen" },
]));
writeFileSync("protokolle.json", JSON.stringify({
  tresor: { beschreibung: "Tresor öffnen", stufe: "sensibel", schritte: [{ nachricht: "TRESOR OFFEN" }] },
  licht: { beschreibung: "Licht an", stufe: "extern", schritte: [{ nachricht: "LICHT AN" }] },
}));
// #1 offen und älter, dahinter 299 bezahlte: zusammen genau 300
const rechnungenBestand = [
  { id: 1, erkanntAm: "2026-01-01T00:00:00.000Z", empfaenger: "Steueramt", betrag: 4200, waehrung: "CHF", faellig: "2026-12-31", status: "offen" },
  ...Array.from({ length: 299 }, (_, k) => ({ id: k + 2, erkanntAm: "2026-02-01T00:00:00.000Z", empfaenger: `Laden ${k + 2}`, betrag: 10, waehrung: "CHF", status: "bezahlt", bezahltAm: "2026-02-02" })),
];
writeFileSync("data/rechnungen.json", JSON.stringify(rechnungenBestand));

let naechsteNachricht = 500;
const gesendet: { text: string; knoepfe: boolean }[] = [];
/** Läuft nach dem n-ten sendMessage (z. B. Notfall auslösen) */
let nachSenden: ((n: number) => void) | undefined;
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string; reply_markup?: unknown }) : {};
  if (url.endsWith("/sendMessage")) {
    gesendet.push({ text: body.text ?? "", knoepfe: body.reply_markup !== undefined });
    nachSenden?.(gesendet.length);
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: naechsteNachricht++ } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const queue = await import("../src/queue.js");
const telegram = await import("../src/telegram.js");
const tools = await import("../src/tools.js");
const browser = await import("../src/browser.js");
const { protokolle } = await import("../src/protokolle.js");
const { state } = await import("../src/state.js");
const { runTask } = await import("../src/agent.js");
const { anthropic } = await import("../src/claude.js");
const finanzen = await import("../src/finanzen.js");
const { ladeListe } = await import("../src/datei.js");
telegram.setzeWarten(async () => {}, () => 0.5, async () => {});

const werkzeug = (name: string) => {
  const t = tools.activeTools().find((x) => x.name === name);
  assert.ok(t, `Werkzeug ${name} fehlt`);
  return t;
};
const tippen = (data: string, messageId?: number, nr = 1) =>
  telegram.handleUpdate({ update_id: nr, callback_query: { id: `c${nr}`, data, from: { id: 12345 }, ...(messageId ? { message: { message_id: messageId } } : {}) } });
const befehl = (text: string, nr = 1) => telegram.handleUpdate({ update_id: nr, message: { message_id: nr, chat: { id: 12345 }, text } });

/** Claude-Attrappe: ein tool_use, danach eine Schlussantwort */
async function claudeRuft(name: string, input: Record<string, unknown>): Promise<void> {
  const client = anthropic();
  const orig = client.messages.create;
  const antworten: Anthropic.Message[] = [
    { id: "m1", type: "message", role: "assistant", model: "attrappe", stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
      content: [{ type: "tool_use", id: "tu_1", name, input }] } as Anthropic.Message,
    { id: "m2", type: "message", role: "assistant", model: "attrappe", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
      content: [{ type: "text", text: "Erledigt, Sir.", citations: null }] } as Anthropic.Message,
  ];
  client.messages.create = (async () => antworten.shift()!) as unknown as typeof client.messages.create;
  try {
    await runTask("Bitte.", telegram.hooks, { history: [] });
  } finally {
    client.messages.create = orig;
  }
}

const neuester = () => queue.auftraege.at(-1)!;
const texte = () => gesendet.map((g) => g.text).join("\n");

afterEach(() => {
  nachSenden = undefined;
  state.paused = false;
  delete state.notfall;
  gesendet.length = 0;
});

describe("Protokoll-Auftrag: ausgeführt wird nur das Protokoll, das die Freigabe nannte", () => {
  const licht = structuredClone(protokolle.licht!);
  afterEach(() => { protokolle.licht = structuredClone(licht); });

  it("alter extern-Auftrag, Protokoll inzwischen sensibel: Tippen führt nichts aus (Telegram)", async () => {
    await tippen("ok:1", 50);
    const a = queue.getAuftrag(1)!;
    assert.equal(a.status, "abgelehnt");
    assert.doesNotMatch(texte(), /TRESOR OFFEN/);
    assert.match(texte(), /inzwischen als sensibel.*neu beantragen/);
    assert.doesNotMatch(a.result ?? "", /TRESOR/);
  });

  it("dasselbe über das Dashboard: ohne PIN nichts ausgeführt", async () => {
    const text = await telegram.approveAuftrag(queue.getAuftrag(2)!);
    assert.match(text, /inzwischen als sensibel/);
    assert.equal(queue.getAuftrag(2)!.status, "abgelehnt");
    assert.doesNotMatch(texte(), /TRESOR OFFEN/);
  });

  it("/protokoll legt den Auftrag mit festgehaltenem Stand an; unverändert läuft er", async () => {
    await befehl("/protokoll licht");
    const a = neuester();
    assert.equal(a.tool, "protokoll_ausfuehren");
    assert.equal(a.input.erwartet_stufe, "extern");
    assert.equal(typeof a.input.erwartet, "string");
    await tippen(`ok:${a.id}`, a.messageId, 2);
    assert.equal(queue.getAuftrag(a.id)!.status, "erledigt");
    assert.match(queue.getAuftrag(a.id)!.result ?? "", /LICHT AN/);
  });

  it("Protokoll von extern auf sensibel verschärft, während der Auftrag offen ist: kein Lauf ohne PIN", async () => {
    await befehl("/protokoll licht");
    const a = neuester();
    protokolle.licht!.stufe = "sensibel";
    await tippen(`ok:${a.id}`, a.messageId, 2);
    assert.equal(queue.getAuftrag(a.id)!.status, "abgelehnt");
    assert.doesNotMatch(queue.getAuftrag(a.id)!.result ?? "", /LICHT AN/);
  });

  it("Schritte inzwischen geändert (gleiche Stufe): nichts ausgeführt, neu beantragen", async () => {
    await befehl("/protokoll licht");
    const a = neuester();
    protokolle.licht!.schritte = [{ nachricht: "ALLES AUF" }];
    await tippen(`ok:${a.id}`, a.messageId, 2);
    const nachher = queue.getAuftrag(a.id)!;
    assert.equal(nachher.status, "fehler");
    assert.match(nachher.result ?? "", /inzwischen geändert.*neu beantragen/);
    assert.doesNotMatch(texte(), /ALLES AUF/);
  });

  it("unbekannter Name über Claude: kein Auftrag, Claude erfährt den Grund", async () => {
    const vorher = queue.auftraege.length;
    assert.throws(() => tools.stufeOf(werkzeug("protokoll_ausfuehren"), { name: "gibtsnicht" }), /gibt es nicht/);
    assert.throws(() => tools.stufeOf(werkzeug("protokoll_ausfuehren"), { name: "constructor" }), /gibt es nicht/);
    await claudeRuft("protokoll_ausfuehren", { name: "gibtsnicht" });
    assert.equal(queue.auftraege.length, vorher);
  });

  it("über Claude angelegt: Auftrag hält den Stand fest, die Freigabe führt ihn aus", async () => {
    await claudeRuft("protokoll_ausfuehren", { name: "licht" });
    const a = neuester();
    assert.equal(a.input.erwartet_stufe, "extern");
    const text = await telegram.approveAuftrag(a);
    assert.match(text, /erledigt.*LICHT AN/s);
  });
});

describe("browser_klicken: geklickt wird nur auf der Seite und mit den Eingaben, die die Freigabe nannte", () => {
  const protokoll: string[] = [];
  let url = "about:blank";
  const feld = { first: () => ({ fill: async (v: string) => void protokoll.push(`fill ${v}`), press: async (k: string) => void protokoll.push(`press ${k}`), count: async () => 1 }) };
  const klick = (n: string) => ({ first: () => ({ click: async () => void protokoll.push(`click ${n} auf ${url}`) }) });
  const starten = () => {
    url = "about:blank";
    protokoll.length = 0;
    browser.setLauncher(async () => ({
      goto: async (u: string) => { url = u; }, title: async () => "T", url: () => url, evaluate: async <T,>() => ({ text: "x", links: [] }) as T,
      getByText: (t: string) => klick(t), getByRole: (_r: string, o: { name: string }) => klick(o.name), getByLabel: () => feld, getByPlaceholder: () => feld, locator: () => feld,
      screenshot: async () => Buffer.alloc(0), goBack: async () => undefined, waitForLoadState: async () => undefined,
    }));
  };

  it("nachgestellt: Klick angelegt auf harmlos.test, danach per auto Bankseite geöffnet und IBAN getippt → kein Klick", async () => {
    starten();
    await werkzeug("browser_oeffnen").run({ url: "https://harmlos.test/" }, telegram.hooks);
    await claudeRuft("browser_klicken", { text: "Weiter" });
    const a = neuester();
    assert.equal(a.tool, "browser_klicken");
    assert.equal(a.summary, "Im Browser klicken: «Weiter» auf https://harmlos.test/");
    // danach ohne Freigabe (Stufe auto)
    assert.equal(tools.stufeOf(werkzeug("browser_oeffnen"), { url: "https://bank.test/ueberweisung" }), "auto");
    await werkzeug("browser_oeffnen").run({ url: "https://bank.test/ueberweisung" }, telegram.hooks);
    await werkzeug("browser_tippen").run({ feld: "IBAN", text: "CH9300762011623852957" }, telegram.hooks);
    const text = await telegram.approveAuftrag(a);
    assert.match(text, /anderen Seite.*neu beantragen/);
    assert.equal(queue.getAuftrag(a.id)!.status, "fehler");
    assert.ok(!protokoll.some((z) => z.startsWith("click")), protokoll.join(" | "));
  });

  it("gleiche Seite, aber inzwischen getippt: kein Klick", async () => {
    starten();
    await werkzeug("browser_oeffnen").run({ url: "https://harmlos.test/" }, telegram.hooks);
    await claudeRuft("browser_klicken", { text: "Weiter" });
    const a = neuester();
    await werkzeug("browser_tippen").run({ feld: "IBAN", text: "CH9300762011623852957" }, telegram.hooks);
    const text = await telegram.approveAuftrag(a);
    assert.match(text, /Eingaben.*geändert/);
    assert.ok(!protokoll.some((z) => z.startsWith("click")));
  });

  it("nichts geändert: der freigegebene Klick läuft", async () => {
    starten();
    await werkzeug("browser_oeffnen").run({ url: "https://harmlos.test/" }, telegram.hooks);
    await werkzeug("browser_tippen").run({ feld: "Suche", text: "Muttenz" }, telegram.hooks);
    await claudeRuft("browser_klicken", { text: "Weiter" });
    const a = neuester();
    assert.match(a.summary, /auf https:\/\/harmlos\.test\/\nKann ein Formular mit diesen Eingaben absenden: Suche: «Muttenz»/);
    const text = await telegram.approveAuftrag(a);
    assert.match(text, /erledigt/);
    assert.deepEqual(protokoll.filter((z) => z.startsWith("click")), ["click Weiter auf https://harmlos.test/"]);
  });

  it("alter Auftrag ohne festgehaltenen Stand: kein Klick", async () => {
    starten();
    await werkzeug("browser_oeffnen").run({ url: "https://harmlos.test/" }, telegram.hooks);
    await assert.rejects(werkzeug("browser_klicken").run({ text: "Weiter" }, telegram.hooks), /älteren Version/);
    assert.ok(!protokoll.some((z) => z.startsWith("click")));
  });
});

describe("browser_klicken: gleichzeitig laufende Browser-Schritte (Zeitplan, Vorgang, Chat) überholen die Freigabe nicht", () => {
  // Wie Playwright: page.url() nennt bis zum Commit des goto die alte Seite, der Klick braucht einen Protokoll-Roundtrip.
  // Früher prüfte der Klick den Stand, während ein anderer Schritt mitten im goto oder nach fill() im describePage hing.
  const protokoll: string[] = [];
  let url = "about:blank";
  let felder: Record<string, string> = {};
  /** Hängt goto bzw. evaluate, bis freigeben() kommt – spätestens, wenn geklickt wird, oder nach 200 ms */
  let haengt: { goto: boolean; evaluate: boolean; wirft: boolean } = { goto: false, evaluate: false, wirft: false };
  let freigeben: () => void = () => {};
  let wartet: Promise<void> = Promise.resolve();
  const sperre = () => {
    wartet = new Promise<void>((r) => { freigeben = r; });
    setTimeout(() => freigeben(), 200);
  };
  const feld = (name: string) => ({ first: () => ({ fill: async (v: string) => { felder[name] = v; protokoll.push(`fill ${v}`); }, press: async () => {}, count: async () => 1 }) });
  const klick = (n: string) => ({ first: () => ({ click: async () => {
    freigeben();
    await new Promise((r) => setTimeout(r, 5));
    protokoll.push(`click ${n} auf ${url} mit ${JSON.stringify(felder)}`);
  } }) });
  const starten = () => {
    url = "about:blank";
    felder = {};
    protokoll.length = 0;
    haengt = { goto: false, evaluate: false, wirft: false };
    browser.setLauncher(async () => ({
      goto: async (u: string) => { if (haengt.goto) await wartet; url = u; felder = {}; },
      title: async () => "T", url: () => url,
      evaluate: async <T,>() => {
        if (haengt.evaluate) await wartet;
        if (haengt.wirft) throw new Error("Seite antwortet nicht");
        return { text: "x", links: [] } as T;
      },
      getByText: (t: string) => klick(t), getByRole: (_r: string, o: { name: string }) => klick(o.name), getByLabel: (n: string) => feld(n), getByPlaceholder: (n: string) => feld(n), locator: () => feld("?"),
      screenshot: async () => Buffer.alloc(0), goBack: async () => undefined, waitForLoadState: async () => undefined,
    }));
  };
  const klicks = () => protokoll.filter((z) => z.startsWith("click"));

  it("Fall A: browser_oeffnen hat goto abgeschickt (URL noch alt), dann Freigabe → kein Klick auf der neuen Seite", async () => {
    starten();
    await werkzeug("browser_oeffnen").run({ url: "https://harmlos.test/" }, telegram.hooks);
    await claudeRuft("browser_klicken", { text: "Weiter" });
    const a = neuester();
    assert.equal(a.summary, "Im Browser klicken: «Weiter» auf https://harmlos.test/");
    haengt.goto = true;
    sperre();
    const oeffnen = werkzeug("browser_oeffnen").run({ url: "https://bank.test/zahlung" }, telegram.hooks);
    const text = await telegram.approveAuftrag(a);
    await oeffnen;
    assert.deepEqual(klicks(), [], protokoll.join(" | "));
    assert.match(text, /anderen Seite.*neu beantragen/);
    assert.equal(queue.getAuftrag(a.id)!.status, "fehler");
  });

  it("Fall B: browser_tippen hat fill() ausgeführt, describePage hängt noch, dann Freigabe → kein Klick mit der IBAN", async () => {
    starten();
    await werkzeug("browser_oeffnen").run({ url: "https://harmlos.test/" }, telegram.hooks);
    await claudeRuft("browser_klicken", { text: "Senden" });
    const a = neuester();
    assert.equal(a.summary, "Im Browser klicken: «Senden» auf https://harmlos.test/");
    haengt.evaluate = true;
    sperre();
    const tippen = werkzeug("browser_tippen").run({ feld: "IBAN", text: "CH9300762011623852957" }, telegram.hooks);
    const text = await telegram.approveAuftrag(a);
    await tippen;
    assert.deepEqual(klicks(), [], protokoll.join(" | "));
    assert.match(text, /Eingaben.*geändert/);
  });

  it("fill() ausgeführt, describePage wirft danach: die Eingabe bleibt vermerkt, kein Klick", async () => {
    starten();
    await werkzeug("browser_oeffnen").run({ url: "https://harmlos.test/" }, telegram.hooks);
    await claudeRuft("browser_klicken", { text: "Senden" });
    const a = neuester();
    haengt.wirft = true;
    await assert.rejects(werkzeug("browser_tippen").run({ feld: "IBAN", text: "CH9300762011623852957" }, telegram.hooks), /antwortet nicht/);
    haengt.wirft = false;
    assert.deepEqual(felder, { IBAN: "CH9300762011623852957" });
    assert.match(werkzeug("browser_klicken").summary!({ text: "Senden" }), /Kann ein Formular mit diesen Eingaben absenden: IBAN: «CH9300762011623852957»/);
    const text = await telegram.approveAuftrag(a);
    assert.match(text, /Eingaben.*geändert/);
    assert.deepEqual(klicks(), []);
  });

  it("Gegenprobe: ohne Überschneidung läuft der freigegebene Klick; ein Schritt, der hängt, blockiert danach nicht", async () => {
    starten();
    await werkzeug("browser_oeffnen").run({ url: "https://harmlos.test/" }, telegram.hooks);
    await werkzeug("browser_tippen").run({ feld: "Suche", text: "Muttenz" }, telegram.hooks);
    await claudeRuft("browser_klicken", { text: "Weiter" });
    const a = neuester();
    assert.match(await telegram.approveAuftrag(a), /erledigt/);
    assert.deepEqual(klicks(), ['click Weiter auf https://harmlos.test/ mit {"Suche":"Muttenz"}']);
    // Ein gescheiterter Schritt gibt den Browser wieder frei
    haengt.wirft = true;
    await assert.rejects(werkzeug("browser_lesen").run({}, telegram.hooks), /antwortet nicht/);
    haengt.wirft = false;
    assert.match(String(await werkzeug("browser_lesen").run({}, telegram.hooks)), /URL: https:\/\/harmlos\.test\//);
  });
});

describe("Notfall während einer Freigabe-Nachricht: keine weiteren Teile mit Inhalt", () => {
  const notfall = () => {
    state.notfall = { aktiv: true, seit: new Date().toISOString(), grund: "Test" };
    state.paused = true;
  };

  it("Notfall nach dem ersten Teil: kein weiterer Teil, keine Knöpfe, keine messageId", async () => {
    const a = queue.createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "GEHEIM ".repeat(2000) });
    nachSenden = (n) => { if (n === 1) notfall(); };
    await telegram.hooks.onAuftrag(a);
    assert.ok(gesendet.length >= 1);
    const danach = gesendet.slice(1);
    assert.ok(danach.every((g) => !g.text.includes("GEHEIM")), danach.map((g) => g.text.slice(0, 60)).join(" | "));
    assert.ok(gesendet.every((g) => !g.knoepfe));
    assert.equal(queue.getAuftrag(a.id)!.messageId, undefined);
    assert.match(danach.at(-1)?.text ?? "", new RegExp(`#${a.id}.*Inhalte erst nach /entwarnung`));
    queue.setStatus(a, "abgelehnt");
  });

  it("/auftraege: Notfall nach dem ersten Auftrag hält die übrigen zurück", async () => {
    for (const o of queue.offeneAuftraege()) queue.setStatus(o, "abgelehnt");
    const a = queue.createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "ERSTER Inhalt" });
    const b = queue.createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "ZWEITER Inhalt" });
    nachSenden = (n) => { if (n === 1) notfall(); };
    await befehl("/auftraege");
    assert.doesNotMatch(texte(), /ZWEITER/);
    assert.match(gesendet.at(-1)!.text, new RegExp(`#${b.id}.*Inhalte erst nach /entwarnung`));
    queue.setStatus(a, "abgelehnt");
    queue.setStatus(b, "abgelehnt");
  });
});

describe("Rechnungen über 300: offene fallen beim Speichern nie weg", () => {
  it("#1 offen, dahinter 299 bezahlte; nach addRechnung stehen #1 und die neue offen in der Datei", () => {
    assert.equal(finanzen.rechnungen.length, 300);
    const neu = finanzen.addRechnung({ empfaenger: "Garage", betrag: 80, waehrung: "CHF" });
    assert.equal(neu.id, 301);
    const datei = JSON.parse(readFileSync("data/rechnungen.json", "utf8")) as { id: number; status: string }[];
    assert.deepEqual(datei.filter((r) => r.status === "offen").map((r) => r.id), [1, 301]);
    assert.equal(datei.length, 300);
    // Speicher und Datei gleich (keine Rechnung nur im Speicher, die nach dem Neustart fehlt)
    assert.deepEqual(finanzen.rechnungen.map((r) => r.id), datei.map((r) => r.id));
    const geladen = ladeListe<{ id: number; status: string }>("data/rechnungen.json", "Rechnungen");
    assert.ok(geladen.liste.some((r) => r.id === 1 && r.status === "offen"));
  });

  it("weitere neue Rechnungen: es fallen nur bezahlte weg, #1 und die höchste Nummer bleiben", () => {
    for (let k = 0; k < 3; k++) finanzen.addRechnung({ empfaenger: `Offen ${k}`, waehrung: "CHF" });
    const datei = JSON.parse(readFileSync("data/rechnungen.json", "utf8")) as { id: number; status: string }[];
    assert.equal(datei.length, 300);
    assert.ok(datei.some((r) => r.id === 304));
    assert.ok(datei.some((r) => r.id === 1));
  });
});

describe("Kaputte Liste: jeder Start legt höchstens eine Sicherung an", () => {
  it("dreimal laden mit derselben abgeschnittenen Datei → genau eine .defekt", () => {
    writeFileSync("data/probe-liste.json", '[{"id": 1, "name": "abgeschn');
    for (let k = 0; k < 3; k++) assert.equal(ladeListe("data/probe-liste.json", "Probe").nichtGeladen, true);
    assert.deepEqual(readdirSync("data").filter((n) => n.startsWith("probe-liste.json.defekt")), ["probe-liste.json.defekt"]);
    // anderer kaputter Inhalt: eigene Sicherung, die ältere bleibt
    writeFileSync("data/probe-liste.json", "[{");
    ladeListe("data/probe-liste.json", "Probe");
    assert.equal(readdirSync("data").filter((n) => n.startsWith("probe-liste.json.defekt")).length, 2);
  });
});
