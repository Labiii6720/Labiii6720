import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (workspace/ liegt relativ) und Umgebung; nie echte Dienste
const temp = mkdtempSync(join(tmpdir(), "jarvis-workspace-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
delete process.env.JARVIS_WORKSPACE;

// fetch-Attrappe: jeder Aufruf wird festgehalten; ein Upload darf hier nie stattfinden
const aufrufe: string[] = [];
const echteFetch = globalThis.fetch;
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  aufrufe.push(String(eingabe));
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const { listFiles, readFile, ROOT, safePath, writeFile } = await import("../src/workspace.js");
const { activeTools } = await import("../src/tools.js");
const { sendFile } = await import("../src/telegram.js");

const ws = (p: string) => join(ROOT, p);
const GEHEIM = "ANTHROPIC_API_KEY=sk-ant-geheim-attrappe\n";
// Dateien ausserhalb des Arbeitsordners, wie .env, protokolle.json und src/ im Jarvis-Ordner
writeFileSync(join(temp, ".env"), GEHEIM);
writeFileSync(join(temp, "protokolle.json"), "{}\n");
mkdirSync(join(temp, "src"), { recursive: true });

describe("Arbeitsordner: Verknüpfungen nach aussen (Leitplanken 4, 5, 7)", () => {
  mkdirSync(ws("repo"), { recursive: true });
  symlinkSync(join(temp, ".env"), ws("repo/a"));
  symlinkSync(join(temp, "protokolle.json"), ws("repo/b"));
  symlinkSync(join(temp, "src"), ws("repo/code"));
  symlinkSync(join(temp, "neu-draussen.txt"), ws("repo/leer"));

  it("datei_lesen über eine Verknüpfung nach aussen → abgelehnt, nichts gelesen", () => {
    assert.throws(() => readFile("repo/a"), (e: Error) => {
      assert.match(e.message, /ausserhalb des Arbeitsordners/);
      assert.doesNotMatch(e.message, /sk-ant-geheim/);
      return true;
    });
    assert.throws(() => readFile("repo/code/agent.ts"), /ausserhalb des Arbeitsordners/);
  });

  it("datei_schreiben über Verknüpfung, verknüpften Ordner oder Verknüpfung ins Leere → abgelehnt, nichts verändert", () => {
    assert.throws(() => writeFile("repo/b", '{"x":{"stufe":"auto"}}'), /ausserhalb des Arbeitsordners/);
    assert.equal(readFileSync(join(temp, "protokolle.json"), "utf8"), "{}\n");
    assert.throws(() => writeFile("repo/code/agent.ts", "boese"), /ausserhalb des Arbeitsordners/);
    assert.throws(() => writeFile("repo/code/neu/tief/x.ts", "boese"), /ausserhalb des Arbeitsordners/);
    assert.equal(existsSync(join(temp, "src", "agent.ts")), false);
    assert.equal(existsSync(join(temp, "src", "neu")), false);
    assert.throws(() => writeFile("repo/leer", "boese"), /ausserhalb des Arbeitsordners/);
    assert.equal(existsSync(join(temp, "neu-draussen.txt")), false);
  });

  it("dateien_auflisten in einem verknüpften Ordner → abgelehnt; Verknüpfungen werden nur benannt", () => {
    assert.throws(() => listFiles("repo/code"), /ausserhalb des Arbeitsordners/);
    const liste = listFiles("repo");
    assert.match(liste, /^a \(Verknüpfung\)$/m);
    assert.match(liste, /^leer \(Verknüpfung\)$/m);
  });

  it("datei_senden über eine Verknüpfung nach aussen → abgelehnt, kein Upload", async () => {
    const ctx = { sendFile, sendPhoto: async () => {}, sendVideo: async () => {} };
    const senden = activeTools().find((t) => t.name === "datei_senden");
    assert.ok(senden, "datei_senden fehlt");
    await assert.rejects(senden.run({ pfad: "repo/a" }, ctx), /ausserhalb des Arbeitsordners/);
    await assert.rejects(sendFile("repo/code/agent.ts"), /ausserhalb des Arbeitsordners/);
    assert.deepEqual(aufrufe, []);
  });

  it("Verknüpfung innerhalb und harter Link → ebenfalls abgelehnt", () => {
    writeFileSync(ws("ziel.txt"), "innen\n");
    symlinkSync(ws("ziel.txt"), ws("innen-link.txt"));
    assert.throws(() => readFile("innen-link.txt"), /Verknüpfungen nehme ich nicht, Sir/);
    assert.throws(() => writeFile("innen-link.txt", "x"), /Verknüpfungen nehme ich nicht, Sir/);
    linkSync(join(temp, ".env"), ws("hart.txt"));
    assert.throws(() => readFile("hart.txt"), /Harter Link/);
    assert.throws(() => writeFile("hart.txt", "x"), /Harter Link/);
    assert.equal(readFileSync(join(temp, ".env"), "utf8"), GEHEIM);
  });

  it("Ablehnung erklärt sich: auch innerhalb des Arbeitsordners, Kopie statt Link", () => {
    writeFileSync(ws("original.txt"), "innen\n");
    linkSync(ws("original.txt"), ws("hart-innen.txt"));
    assert.throws(() => readFile("hart-innen.txt"), /Harter Link.*auch nicht innerhalb des Arbeitsordners.*Kopie/);
    assert.throws(() => readFile("innen-link.txt"), /Verknüpfungen.*auch nicht innerhalb des Arbeitsordners.*Kopie/);
    assert.equal(readFileSync(ws("original.txt"), "utf8"), "innen\n");
  });

  it("gewöhnliche Dateien und neue Unterordner funktionieren weiter; ../ bleibt gesperrt", () => {
    assert.match(writeFile("site/neu/index.html", "<h1>Hallo</h1>"), /site\/neu\/index\.html geschrieben \(14 B\)/);
    assert.equal(readFile("site/neu/index.html"), "<h1>Hallo</h1>");
    assert.match(writeFile("site/neu/index.html", "kurz"), /\(4 B\)/);
    assert.equal(readFile("site/neu/index.html"), "kurz");
    assert.match(listFiles("site/neu"), /index\.html \(4 B\)/);
    assert.equal(safePath("."), ROOT);
    assert.throws(() => readFile("../.env"), /ausserhalb des Arbeitsordners/);
    assert.throws(() => readFile(join(temp, ".env")), /ausserhalb des Arbeitsordners/);
  });
});
