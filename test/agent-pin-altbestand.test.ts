import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

// Altbestand bis 0.23.1: Sätze wie «meine PIN ist 4711» gingen an Claude und in data/chat.json, samt Antwort und
// Werkzeug-Schritten; nur die (entfernte) Ausgabe-Schwärzung hielt sie aus Verlauf und Antworten. Seit 0.24.1 ersetzt
// loadHistory den ganzen Zug (bis vor den nächsten Zugbeginn) durch einen Vermerk und speichert einmal. Jeder Lauf ein
// eigener Kindprozess (loadHistory läuft beim Import), im Temp-Ordner, ohne Netz.
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-agent-pin-altbestand-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const VERMERK = "[Entfernt: sah aus wie eine PIN]";

/** Lädt agent.ts in `dir` (optional nur lesend wie npm run check) und liefert die sichtbaren Nachrichten. */
function lade(dir: string, nurLesen = false): { code: number | null; out: string; err: string; sichtbar: { rolle: string; text: string }[] } {
  const skript = join(dir, "lade.mjs");
  const src = (p: string) => JSON.stringify(pathToFileURL(join(projekt, "src", p)).href);
  writeFileSync(
    skript,
    [
      'globalThis.fetch = async () => { throw new Error("kein Netz im Test"); };',
      nurLesen ? `(await import(${src("datei.ts")})).nurLesen();` : "",
      `const { letzteNachrichten } = await import(${src("agent.ts")});`,
      'console.log("SICHTBAR " + JSON.stringify(letzteNachrichten(20)));',
      "process.exit(0);",
    ].join("\n"),
  );
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), skript], {
    cwd: dir, encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, JARVIS_PIN: "4711" },
  });
  const out = `${r.stdout}${r.stderr}`;
  const zeile = r.stdout.split("\n").find((z) => z.startsWith("SICHTBAR "));
  return { code: r.status, out, err: r.stderr, sichtbar: zeile ? JSON.parse(zeile.slice(9)) : [] };
}

/** Verlauf aus der Zeit vor 0.24 (Nutzer-Texte mit PIN, Antworten, Werkzeug-Schritte, Systemnotiz) */
const altbestand = () => [
  { role: "user", content: "meine PIN ist 4711" },
  { role: "assistant", content: [{ type: "text", text: "Notiert, Sir. Die 4711 vergesse ich wieder." }] },
  { role: "user", content: "[Kommandozentrale] 47 11" },
  { role: "assistant", content: [{ type: "text", text: "Verstanden." }] },
  { role: "user", content: "[Kanal: Stimme, die Antwort wird vorgelesen] 4, 7, 1, 1" },
  { role: "assistant", content: [{ type: "text", text: "Gut." }] },
  { role: "user", content: [{ type: "text", text: "Code: 4711" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "notiz", input: { text: "PIN 4711" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "PIN 4711 gespeichert" }] },
  { role: "assistant", content: [{ type: "text", text: "Erledigt." }] },
  { role: "user", content: "[Systemnotiz] Auftrag #3 Code 4711 ausgeführt" },
  { role: "user", content: "Termin um 14.30, Telefon 079 123 45 67", automatisch: true },
  { role: "user", content: "Schick den Code an 079 123 45 67" },
  { role: "assistant", content: [{ type: "text", text: "Gern." }] },
];

describe("loadHistory: Altbestand mit PIN-förmigen Nutzer-Texten", () => {
  it("ganzer Zug mit PIN-förmigem Nutzer-Text ersetzt (Antwort, Werkzeug-Eingabe und -Ergebnis weg), einmal gespeichert; Systemnotizen und andere Züge unberührt", () => {
    const dir = mkdtempSync(join(temp, "bereinigen-"));
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "chat.json"), JSON.stringify(altbestand()), { mode: 0o600 });
    const r = lade(dir);
    assert.equal(r.code, 0, r.out);
    const h = JSON.parse(readFileSync(join(dir, "data", "chat.json"), "utf8")) as { role: string; content: unknown }[];
    const alt = altbestand();
    const v = { role: "user", content: VERMERK };
    // Züge 0–1, 2–3, 4–5 und 6–9 (tool_use/tool_result gehören zum Zug) je ein Vermerk; ab der Systemnotiz unverändert
    assert.deepEqual(h, [v, v, v, v, ...alt.slice(10)]);
    // Ausser der Systemnotiz (nicht vom Nutzer, nie angezeigt) keine Spur der PIN, auch nicht in Antworten und Werkzeug-Schritten
    assert.ok(!JSON.stringify(h.filter((m) => !String(m.content).startsWith("[Systemnotiz]"))).includes("4711"));
    assert.equal(statSync(join(dir, "data", "chat.json")).mode & 0o777, 0o600);
    assert.deepEqual(r.sichtbar.filter((n) => n.rolle === "nutzer").map((n) => n.text), [VERMERK, VERMERK, VERMERK, VERMERK, "Schick den Code an 079 123 45 67"]);
    assert.ok(!r.sichtbar.some((n) => n.text.includes("4711")), "Antwort «Die 4711 vergesse ich wieder» nicht mehr sichtbar");
    assert.deepEqual(r.sichtbar.filter((n) => n.rolle === "jarvis").map((n) => n.text), ["Gern."]);
    assert.doesNotMatch(r.err, /47/, "nichts im Log");
  });

  it("Zug am Ende des Verlaufs und Zug direkt vor einer Systemnotiz: nur bis vor den nächsten Zugbeginn", () => {
    const dir = mkdtempSync(join(temp, "zuggrenze-"));
    mkdirSync(join(dir, "data"));
    const verlauf = [
      { role: "user", content: "Wie spät ist es?" },
      { role: "assistant", content: [{ type: "text", text: "Halb drei, Sir." }] },
      { role: "user", content: "PIN 4711" },
      { role: "user", content: "[Systemnotiz] Auftrag #4 erledigt" },
      { role: "user", content: "meine PIN ist 4711, 4712 war die alte" },
      { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "merken", input: { text: "4711" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "gemerkt: 4711" }] },
    ];
    writeFileSync(join(dir, "data", "chat.json"), JSON.stringify(verlauf), { mode: 0o600 });
    const r = lade(dir);
    assert.equal(r.code, 0, r.out);
    const h = JSON.parse(readFileSync(join(dir, "data", "chat.json"), "utf8")) as unknown[];
    assert.deepEqual(h, [verlauf[0], verlauf[1], { role: "user", content: VERMERK }, verlauf[3], { role: "user", content: VERMERK }]);
  });

  it("Zahl vor der PIN («PIN 12 4711», «Code 1 4711»): Zug ersetzt; Telefonnummer nach «Code» bleibt", () => {
    const dir = mkdtempSync(join(temp, "zahl-davor-"));
    mkdirSync(join(dir, "data"));
    const verlauf = [
      { role: "user", content: "PIN 12 4711" },
      { role: "assistant", content: [{ type: "text", text: "Notiert, 4711." }] },
      { role: "user", content: "Code 1 4711" },
      { role: "assistant", content: [{ type: "text", text: "Gut." }] },
      { role: "user", content: "Code an 079 123 45 67" },
      { role: "assistant", content: [{ type: "text", text: "Gern." }] },
    ];
    writeFileSync(join(dir, "data", "chat.json"), JSON.stringify(verlauf), { mode: 0o600 });
    const r = lade(dir);
    assert.equal(r.code, 0, r.out);
    const h = JSON.parse(readFileSync(join(dir, "data", "chat.json"), "utf8")) as unknown[];
    assert.deepEqual(h, [{ role: "user", content: VERMERK }, { role: "user", content: VERMERK }, verlauf[4], verlauf[5]]);
    assert.ok(!JSON.stringify(h).includes("4711"));
  });

  it("nichts PIN-förmig: Datei nicht neu geschrieben (Inhalt und Zeitstempel gleich)", () => {
    const dir = mkdtempSync(join(temp, "unveraendert-"));
    mkdirSync(join(dir, "data"));
    const roh = JSON.stringify(altbestand().slice(10), null, 2);
    writeFileSync(join(dir, "data", "chat.json"), roh, { mode: 0o600 });
    const vorher = statSync(join(dir, "data", "chat.json")).mtimeMs;
    const r = lade(dir);
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(join(dir, "data", "chat.json"), "utf8"), roh);
    assert.equal(statSync(join(dir, "data", "chat.json")).mtimeMs, vorher);
  });

  it("Nur-lesen-Prozess (npm run check): im Speicher bereinigt, die Datei bleibt unberührt", () => {
    const dir = mkdtempSync(join(temp, "nur-lesen-"));
    mkdirSync(join(dir, "data"));
    const roh = JSON.stringify(altbestand());
    writeFileSync(join(dir, "data", "chat.json"), roh, { mode: 0o600 });
    const r = lade(dir, true);
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(join(dir, "data", "chat.json"), "utf8"), roh);
    assert.equal(r.sichtbar.find((n) => n.rolle === "nutzer")?.text, VERMERK);
  });
});
