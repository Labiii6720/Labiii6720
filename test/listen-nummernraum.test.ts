import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Nummer ab Number.MAX_SAFE_INTEGER (wie createAuftrag in queue.ts): 2^53 + 1 ergibt wieder 2^53, zwei Einträge trügen
// dieselbe id. Zeitpläne, Wachen, Rechnungen und Vorgänge werfen jetzt, bevor etwas angelegt oder gespeichert ist.
const temp = mkdtempSync(join(tmpdir(), "jarvis-listen-nummernraum-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-attrappe-nur-fuer-tests";
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Aufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

const MAX = Number.MAX_SAFE_INTEGER;
const DATEIEN: Record<string, unknown[]> = {
  "zeitplaene.json": [{ id: MAX, name: "n", zeit: "07:00", tage: "mo", auftrag: "a" }],
  "wachen.json": [{ id: MAX, kamera: "einfahrt", frage: "Tor offen?", alle_minuten: 10 }],
  "rechnungen.json": [{ id: MAX, erkanntAm: "2026-10-01T08:00:00.000Z", empfaenger: "EW", waehrung: "CHF", status: "bezahlt", bezahltAm: "2026-10-02" }],
  "vorgaenge.json": [{ id: MAX, auftrag: "alt", status: "fertig", startedAt: "2026-10-01T08:00:00.000Z", steps: 1 }],
};
const INHALT: Record<string, string> = {};
mkdirSync(join(temp, "data"), { recursive: true });
for (const [datei, liste] of Object.entries(DATEIEN)) {
  INHALT[datei] = JSON.stringify(liste);
  writeFileSync(join(temp, "data", datei), INHALT[datei]!);
}
writeFileSync(join(temp, "cameras.json"), JSON.stringify({ einfahrt: { frigate: "einfahrt", beschreibung: "Einfahrt" } }));

const zeitplanMod = await import("../src/zeitplaene.js");
const kameras = await import("../src/cameras.js");
const finanzen = await import("../src/finanzen.js");
const vorgangMod = await import("../src/vorgaenge.js");
const { hooks } = await import("../src/telegram.js");
const { state } = await import("../src/state.js");

const unveraendert = (datei: string) => assert.equal(readFileSync(join(temp, "data", datei), "utf8"), INHALT[datei]);
const ERSCHOEPFT = (datei: string) => new RegExp(`Nummernraum erschöpft, Sir – data/${datei.replace(".", "\\.")} prüfen`);

describe("Nummernraum erschöpft in den Listen", () => {
  it("Zeitpläne: neueZeitplanId wirft, Zähler und Datei unverändert", () => {
    assert.throws(() => zeitplanMod.neueZeitplanId(), ERSCHOEPFT("zeitplaene.json"));
    assert.equal(state.naechsteZeitplanId, undefined);
    assert.deepEqual(zeitplanMod.zeitplaene.map((z) => z.id), [MAX]);
    unveraendert("zeitplaene.json");
  });

  it("Wachen: neueWacheId wirft, Zähler und Datei unverändert", () => {
    assert.throws(() => kameras.neueWacheId(), ERSCHOEPFT("wachen.json"));
    assert.equal(state.naechsteWacheId, undefined);
    assert.deepEqual(kameras.dynamicWachen.map((w) => w.id), [MAX]);
    unveraendert("wachen.json");
  });

  it("Rechnungen: addRechnung wirft, nichts erfasst", () => {
    assert.throws(() => finanzen.addRechnung({ empfaenger: "Neu", waehrung: "CHF" }), ERSCHOEPFT("rechnungen.json"));
    assert.equal(state.naechsteRechnungId, undefined);
    assert.deepEqual(finanzen.rechnungen.map((r) => r.id), [MAX]);
    unveraendert("rechnungen.json");
  });

  it("Vorgänge: startVorgang wirft, nichts gestartet", () => {
    assert.throws(() => vorgangMod.startVorgang("neu", hooks), ERSCHOEPFT("vorgaenge.json"));
    assert.deepEqual(vorgangMod.vorgaenge.map((v) => v.id), [MAX]);
    unveraendert("vorgaenge.json");
  });

  it("state.json bleibt unangetastet", () => {
    assert.equal(existsSync(join(temp, "data", "state.json")), false);
  });
});
