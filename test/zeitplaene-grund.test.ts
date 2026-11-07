import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Zeitpläne mit ungültigem Wert, aber richtigem Typ (von Hand bearbeitet) bleiben stehen und laufen nicht. Doku und
// datei.ts versprachen, dass Kommandozentrale und Werkzeuge sie «mit Grund» zeigen – früher nannte das Dashboard nur
// «Auftrag fehlt», bei Uhrzeit «25:00» oder Tagen «montags» gar nichts, und zeitplaene_anzeigen nie einen Grund.
// Jetzt eine Regel (zeitplanZustand) für Scheduler, Kommandozentrale und Werkzeug.
const temp = mkdtempSync(join(tmpdir(), "jarvis-zeitplaene-grund-"));
process.chdir(temp);
// Im Temp-Ordner bleiben bis zum Prozessende (spätes Schreiben landet nie im Projekt), dann aufräumen
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-attrappe-nur-fuer-tests";
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

const BESTAND = [
  { id: 1, name: "Uhrzeit 25", zeit: "25:00", tage: "taeglich", auftrag: "a" },
  { id: 2, name: "Minute 60", zeit: "07:60", tage: "taeglich", auftrag: "a" },
  { id: 3, name: "montags", zeit: "07:00", tage: "montags", auftrag: "a" },
  { id: 4, name: "doppelt", zeit: "07:00", tage: "mo,mo", auftrag: "a" },
  { id: 5, name: "leer", zeit: "07:00", tage: "werktags", auftrag: " " },
  { id: 6, name: "alles falsch", zeit: "x", tage: "y", auftrag: "" },
  { id: 7, name: "gültig", zeit: "07:00", tage: "Mo, Mi", auftrag: "Wetter" },
];
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "zeitplaene.json"), JSON.stringify(BESTAND));

const { zeitplanZustand, zeitplaene, faelligIm, naechsterLauf } = await import("../src/zeitplaene.js");
const { zeitplaeneJson, _dashboardUhr } = await import("../src/dashboard.js");
const { toolByName } = await import("../src/tools.js");

const ERWARTET: [number, string | undefined][] = [[1, "Uhrzeit ungültig"], [2, "Uhrzeit ungültig"], [3, "Tage ungültig"], [4, "Tage ungültig"], [5, "Auftrag fehlt"], [6, "Uhrzeit ungültig"], [7, undefined]];
/** Montag, 12.10.2026, 07:00 Schweizer Zeit */
const mo = new Date("2026-10-12T05:00:00.000Z");

describe("Zeitpläne mit ungültigem Wert: der Grund steht überall dabei", () => {
  it("alle bleiben geladen (richtiger Typ), keiner wird verworfen", () => {
    assert.deepEqual(zeitplaene.map((z) => z.id), [1, 2, 3, 4, 5, 6, 7]);
  });

  it("zeitplanZustand: Grund nach der Reihenfolge Uhrzeit, Tage, Auftrag", () => {
    assert.deepEqual(zeitplaene.map((z) => [z.id, zeitplanZustand(z).grund]), ERWARTET);
    assert.deepEqual(zeitplanZustand({ zeit: "07:00", tage: "taeglich", auftrag: "x" }), { laeuft: true });
    assert.deepEqual(zeitplanZustand({ zeit: undefined, tage: "taeglich", auftrag: "x" } as never), { laeuft: false, grund: "Uhrzeit ungültig" });
  });

  it("Scheduler folgt derselben Regel: «montags» und «mo,mo» laufen auch am Montag nicht, «Mo, Mi» schon", () => {
    for (const z of zeitplaene) {
      const soll = zeitplanZustand(z).laeuft;
      assert.equal(faelligIm(z, mo, 60), soll, `#${z.id} fällig`);
      assert.equal(naechsterLauf(z, mo, 60) !== undefined, soll, `#${z.id} nächster Lauf`);
    }
  });

  it("Kommandozentrale: /api/zeitplaene liefert laeuft false und den Grund", () => {
    _dashboardUhr.jetzt = () => mo;
    const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    zeitplaeneJson({ params: {}, query: {} } as never, res as never);
    const liste = (res.body as { zeitplaene: { id: number; laeuft?: boolean; grund?: string; naechsterLauf?: string }[] }).zeitplaene;
    assert.deepEqual(liste.map((z) => [z.id, z.grund]), ERWARTET);
    for (const z of liste) {
      if (z.grund) assert.equal(z.laeuft, false, `#${z.id}`);
      else assert.equal(typeof z.naechsterLauf, "string", `#${z.id}`);
    }
  });

  it("Werkzeug zeitplaene_anzeigen nennt den Grund", async () => {
    const t = toolByName("zeitplaene_anzeigen")!;
    const text = String(await t.run({}, { sendFile: async () => {}, sendPhoto: async () => {}, sendVideo: async () => {} }));
    const zeilen = text.split("\n");
    assert.equal(zeilen.length, 7);
    assert.equal(zeilen[0], "#1 Uhrzeit 25 · taeglich 25:00 · a (läuft nicht: Uhrzeit ungültig)");
    assert.equal(zeilen[2], "#3 montags · montags 07:00 · a (läuft nicht: Tage ungültig)");
    assert.equal(zeilen[4], "#5 leer · werktags 07:00 ·   (läuft nicht: Auftrag fehlt)");
    assert.equal(zeilen[6], "#7 gültig · Mo, Mi 07:00 · Wetter");
  });
});
