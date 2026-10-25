import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Befund 1: Bei einer gemischten PIN («ab12») schwärzte pinErsetzen nur ganze Wörter (nach Leerraum getrennt, Ränder
// aus einer festen Liste). «Code:ab12», «PIN=ab12», «<ab12>», «ab12…» und «ab12/xy» blieben stehen: im Echo nach
// Telegram, im Verlauf der Kommandozentrale und in Antworten über Alexa.
// Befund 2: Jede Zahl in PIN-Form aus Notizen und Profil galt als «vom Nutzer»: «2026» aus einem Ziel, «8400» aus einer
// Adresse oder «1042» aus einer Kundennummer erschienen in jeder Antwort als «<PIN>».
// Temp-Ordner, keine Netzaufrufe.
const temp = mkdtempSync(join(tmpdir(), "jarvis-pin-gemischt-rand-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.JARVIS_PIN = "4711";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.WEB_SEARCH = "off";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

const agent = await import("../src/agent.js");
const { config } = await import("../src/config.js");
const { profil } = await import("../src/profil.js");

function mitPin<T>(pin: string, f: () => T): T {
  const alt = config.pin;
  config.pin = pin;
  try {
    return f();
  } finally {
    config.pin = alt;
  }
}

const notizen = (inhalt: string) => {
  mkdirSync("data", { recursive: true });
  writeFileSync("data/notizen.md", inhalt);
};

beforeEach(() => {
  rmSync("data/notizen.md", { force: true });
  agent.resetHistory();
});
afterEach(() => {
  profil.ziele.length = 0;
  profil.fakten.length = 0;
});

describe("gemischte PIN: auch an Satzzeichen und Sonderzeichen geschwärzt", () => {
  const FAELLE: [string, string][] = [
    ["Merk dir Garage Code:ab12", "Merk dir Garage Code:<PIN>"],
    ["PIN=ab12", "PIN=<PIN>"],
    ["<ab12>", "<<PIN>>"],
    ["ab12…", "<PIN>…"],
    ["ab12/xy", "<PIN>/xy"],
    ["Code ab12", "Code <PIN>"],
  ];

  it("pinGeschwaerzt (Echo, Verlauf): «Code:ab12», «PIN=ab12», «<ab12>», «ab12…», «ab12/xy»", () => {
    for (const [ein, aus] of FAELLE) assert.equal(mitPin("ab12", () => agent.pinGeschwaerzt(ein)), aus, ein);
  });

  it("antwortGeschwaerzt: der Satz als Eingabe im Verlauf, Claude wiederholt die PIN mit Satzzeichen", () => {
    const verlauf = [{ role: "user", content: "Merk dir Garage Code:ab12" }];
    for (const antwort of ["Notiert: Code:ab12.", "Notiert (ab12…)", "Ihr Code <ab12>.", "Gespeichert ab12/Garage."]) {
      const r = mitPin("ab12", () => agent.antwortGeschwaerzt(antwort, "<PIN>", verlauf));
      assert.ok(!r.includes("ab12"), `${antwort} → ${r}`);
    }
  });

  it("nie nach dem Wert: dieselbe Klasse sieht für «ab12» und «zz99» gleich aus", () => {
    for (const [ein] of FAELLE) assert.equal(mitPin("ab12", () => agent.pinGeschwaerzt(ein)), mitPin("zz99", () => agent.pinGeschwaerzt(ein)), ein);
  });

  it("Sonderzeichen der PIN gehören zur Klasse («a#12»), längere Folgen bleiben stehen", () => {
    assert.equal(mitPin("a#12", () => agent.pinGeschwaerzt("Tresor:a#12.")), "Tresor:<PIN>.");
    assert.equal(mitPin("ab12", () => agent.pinGeschwaerzt("Modell XB12K, Raum B2")), "Modell XB12K, Raum B2");
  });
});

describe("Zahlen aus Notizen und Profil: nur hinter einem PIN-Wort", () => {
  it("Ziel «bis Ende 2026», Fakt «seit 2019», Adresse 8400 und Kundennummer 1042: Antworten bleiben unverändert", () => {
    profil.ziele.push({ id: 1, text: "Bis Ende 2026 Eigenheim in 8400 Winterthur", status: "offen", angelegt: "2026-01-01" });
    profil.fakten.push({ id: 1, text: "seit 2019 bei Firma X", seit: "2026-01-01", quelle: "chat" });
    notizen("- 2026-10-20: Kundennummer Swisscom 1042\n");
    for (const t of ["Für 2026 sind 3 Termine geplant.", "Sie sind seit 2019 dabei.", "Das Wetter in 8400 Winterthur: sonnig.", "Bestellung 1042 ist unterwegs.", "Bis Ende 2026 bleibt Zeit."]) {
      assert.equal(agent.antwortGeschwaerzt(t, "<PIN>", []), t, t);
    }
  });

  it("Gegenprobe: in den Notizen hinter einem PIN-Wort, dann geschwärzt", () => {
    notizen("- 2026-10-20: Kundennummer Swisscom 1042\n- 2026-10-21: Alarm-PIN 4711\n");
    assert.equal(agent.antwortGeschwaerzt("Die 4711, Kunde 1042.", "<PIN>", []), "Die <PIN>, Kunde 1042.");
  });

  it("Ergebnis von notizen_lesen im Verlauf: dieselbe Regel", () => {
    const verlauf = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "notizen_lesen", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Kundennummer 1042, Ticket 5512, Tresorcode 4711" }] },
    ];
    assert.equal(agent.antwortGeschwaerzt("Ticket 5512 für Kunde 1042, Tresor 4711.", "<PIN>", verlauf), "Ticket 5512 für Kunde 1042, Tresor <PIN>.");
  });

  it("gemischte PIN aus dem Profil: nur hinter einem PIN-Wort", () => {
    profil.fakten.push({ id: 1, text: "Router Modell AX55, WLAN-Kennwort qw12", seit: "2026-01-01", quelle: "chat" });
    assert.equal(mitPin("ab12", () => agent.antwortGeschwaerzt("Ihr AX55 läuft, Kennung qw12.", "<PIN>", [])), "Ihr AX55 läuft, Kennung <PIN>.");
  });
});
