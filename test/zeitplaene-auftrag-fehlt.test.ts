import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

// Von Hand bearbeitete data/zeitplaene.json mit einem Eintrag ohne «auftrag» (oder «name»): Früher galt er als fällig, und
// der Scheduler startete täglich einen bezahlten Claude-Lauf mit dem Auftrag «undefined» und meldete «🕒 undefined».
const temp = mkdtempSync(join(tmpdir(), "jarvis-zeitplaene-auftrag-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.ZEITPLAN_NACHHOLEN_MIN = "60";

// Kein Netz im Test
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

// Bestand wie nach einer Handbearbeitung; leere routinen.json: kein Erststart
const ZEITPLAENE_DATEI = join(temp, "data", "zeitplaene.json");
const BESTAND = JSON.stringify([{ id: 1, zeit: "07:00", tage: "taeglich" }], null, 2);
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(ZEITPLAENE_DATEI, BESTAND);
writeFileSync(join(temp, "data", "routinen.json"), "{}");

const { abhaengigkeiten, zeitplanTick } = await import("../src/scheduler.js");
const { faelligIm, faelltAn, naechsterLauf, zeitplaene, zeitplaeneNichtGeladen } = await import("../src/zeitplaene.js");
const { state } = await import("../src/state.js");

type Zeitplan = Parameters<typeof faelligIm>[0];
/** 10.10.2026 ist ein Samstag (lokale Zeit Europe/Zurich) */
const sa = (h: number, m: number) => new Date(2026, 9, 10, h, m, 0, 0);

let prompts: string[] = [];
let gesendet: string[] = [];
abhaengigkeiten.handleMessage = async (text: string) => { prompts.push(text); return "Erledigt, Sir."; };
abhaengigkeiten.sendeSpaeter = async (text: string) => { gesendet.push(text); };

const ohneAuftrag: Record<string, unknown> = {
  "auftrag fehlt": { id: 11, name: "Ohne Auftrag", zeit: "07:00", tage: "taeglich" },
  "auftrag null": { id: 12, name: "Auftrag null", zeit: "07:00", tage: "taeglich", auftrag: null },
  "auftrag Zahl": { id: 13, name: "Auftrag Zahl", zeit: "07:00", tage: "taeglich", auftrag: 5 },
  "auftrag Objekt": { id: 14, name: "Auftrag Objekt", zeit: "07:00", tage: "taeglich", auftrag: { text: "x" } },
  "auftrag leer": { id: 15, name: "Auftrag leer", zeit: "07:00", tage: "taeglich", auftrag: "" },
  "auftrag nur Leerzeichen": { id: 16, name: "Auftrag leer", zeit: "07:00", tage: "taeglich", auftrag: "  \n\t " },
  "weder name noch auftrag": { id: 17, zeit: "07:00", tage: "taeglich" },
};

describe("Zeitplan ohne Auftrag", () => {
  beforeEach(() => { prompts = []; gesendet = []; state.paused = false; });

  for (const [titel, roh] of Object.entries(ohneAuftrag)) {
    it(`${titel}: nie fällig, kein nächster Lauf, kein Absturz`, () => {
      const z = roh as Zeitplan;
      assert.doesNotThrow(() => faelltAn(z, sa(7, 0)));
      assert.equal(faelltAn(z, sa(7, 0)), false);
      assert.equal(faelligIm(z, sa(7, 0), 0), false);
      assert.equal(faelligIm(z, sa(7, 30), 60), false);
      assert.equal(naechsterLauf(z, sa(6, 0), 60), undefined);
      assert.equal(naechsterLauf(z, sa(7, 30), 60), undefined);
      assert.equal(naechsterLauf(z, sa(8, 0), 0), undefined);
    });
  }

  it("mit Auftrag läuft er weiter wie bisher (auch ohne Namen)", () => {
    const z = { id: 18, zeit: "07:00", tage: "taeglich", auftrag: "Sag mir das Wetter" } as unknown as Zeitplan;
    assert.equal(faelltAn(z, sa(7, 0)), true);
    assert.equal(faelligIm(z, sa(7, 30), 60), true);
    assert.equal(naechsterLauf(z, sa(6, 0), 60)!.getTime(), sa(7, 0).getTime());
  });

  it("geladener Bestand ohne name/auftrag: beim Laden übersprungen (Sicherung), die Datei sperrt nicht", () => {
    assert.equal(zeitplaeneNichtGeladen, false, "ein ungültiger Eintrag macht die Datei nicht unlesbar");
    assert.equal(zeitplaene.length, 0);
    assert.equal(readFileSync(`${ZEITPLAENE_DATEI}.defekt`, "utf8"), BESTAND, "der Eintrag liegt in der Sicherung");
  });

  it("zweite Verteidigung: käme ein Eintrag ohne name/auftrag doch in die Liste, startet der Scheduler keinen Claude-Lauf und meldet nichts", async () => {
    const roh = JSON.parse(BESTAND)[0] as Zeitplan;
    zeitplaene.push(roh);
    try {
      for (const [h, m] of [[7, 0], [7, 1], [7, 30], [7, 59]] as const) await zeitplanTick(sa(h, m));
      // Am nächsten Tag ebenso
      await zeitplanTick(new Date(2026, 9, 11, 7, 0, 0, 0));
      assert.deepEqual(prompts, [], "kein Auftrag «undefined» an Claude");
      assert.deepEqual(gesendet, [], "keine Meldung «🕒 undefined»");
      assert.equal(roh.lastRun, undefined, "nichts abgehakt");
      assert.equal(readFileSync(ZEITPLAENE_DATEI, "utf8"), BESTAND, "Bestand bleibt unverändert");
    } finally {
      zeitplaene.splice(zeitplaene.indexOf(roh), 1);
    }
  });

  it("Gegenprobe im selben Takt: ein Eintrag mit Auftrag läuft weiterhin", async () => {
    const roh = JSON.parse(BESTAND)[0] as Zeitplan;
    zeitplaene.push(roh, { id: 2, name: "Wetter", zeit: "07:00", tage: "taeglich", auftrag: "Sag mir das Wetter" });
    try {
      await zeitplanTick(sa(7, 0));
      assert.deepEqual(prompts, ["[Zeitplan «Wetter», läuft automatisch] Sag mir das Wetter"]);
      assert.deepEqual(gesendet, ["🕒 Wetter\n\nErledigt, Sir."]);
    } finally {
      zeitplaene.splice(0);
    }
  });
});
