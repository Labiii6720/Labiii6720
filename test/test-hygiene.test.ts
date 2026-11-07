import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

// Testleck: Gingen Testdateien in den Root-after-Hooks zurück ins Projekt (process.chdir(projekt)), landete alles, was
// danach noch schrieb (Telegram-Wiederholungen mit echten Timern, nicht abgewartete sendeSpaeter, Dashboard-Fristen),
// relativ in data/ des Projekts – etwa data/postausgang.json. Jetzt bleibt jede Datei im Temp-Ordner bis zum Prozessende.
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-hygiene-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

describe("Testdateien wechseln nie zurück ins Projekt", () => {
  it("kein process.chdir(projekt) in einer Testdatei", () => {
    const treffer = readdirSync(join(projekt, "test"))
      .filter((n) => n.endsWith(".test.ts") && n !== "test-hygiene.test.ts") // diese Datei nennt das alte Muster nur als Gegenprobe
      .filter((n) => /process\.chdir\(\s*projekt\s*\)/.test(readFileSync(join(projekt, "test", n), "utf8")));
    assert.deepEqual(treffer, []);
  });

  it("jede Datei, die ins Temp wechselt, räumt beim Prozessende auf statt in einem after-Hook zurückzuwechseln", () => {
    const ohne = readdirSync(join(projekt, "test"))
      .filter((n) => n.endsWith(".test.ts"))
      .filter((n) => {
        const q = readFileSync(join(projekt, "test", n), "utf8");
        return /^process\.chdir\(/m.test(q) && !/process\.once\("exit"/.test(q);
      });
    assert.deepEqual(ohne, []);
  });
});

describe("Muster im Kindprozess: spätes Schreiben nach den Root-after-Hooks", () => {
  // Nachgestellt mit einem Schein-Projekt: der Test schreibt 50 ms nach seinem Ende relativ data/postausgang.json
  const lauf = (aufraeumen: string): { projekt: string; code: number | null } => {
    const schein = mkdtempSync(join(temp, "projekt-"));
    const datei = join(schein, "leck.test.mjs");
    writeFileSync(
      datei,
      [
        'import { after, it } from "node:test";',
        'import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        `const projekt = ${JSON.stringify(schein)};`,
        `const temp = mkdtempSync(join(${JSON.stringify(temp)}, "kind-"));`,
        "process.chdir(temp);",
        aufraeumen,
        'it("meldet im Hintergrund", () => { setTimeout(() => { mkdirSync("data", { recursive: true }); writeFileSync("data/postausgang.json", "[]"); }, 50); });',
      ].join("\n"),
    );
    // Ohne NODE_TEST_CONTEXT: sonst liefe das Kind im Unterprozess-Modus dieses Testlaufs statt als eigener Testlauf
    const { NODE_TEST_CONTEXT: _kontext, ...umgebung } = process.env;
    const r = spawnSync(process.execPath, ["--test", datei], { cwd: schein, encoding: "utf8", timeout: 30_000, env: umgebung });
    return { projekt: schein, code: r.status };
  };

  it("altes Muster (after: zurück ins Projekt) schreibt ins Projekt – Gegenprobe", () => {
    const r = lauf("after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });");
    assert.equal(r.code, 0);
    assert.ok(existsSync(join(r.projekt, "data", "postausgang.json")), "das Leck lässt sich nachstellen");
  });

  it("neues Muster (im Temp bleiben, Aufräumen beim Prozessende): nichts im Projekt, Temp weg", () => {
    const r = lauf('process.once("exit", () => rmSync(temp, { recursive: true, force: true }));');
    assert.equal(r.code, 0);
    assert.ok(!existsSync(join(r.projekt, "data")), "kein data/ im Projekt");
    assert.deepEqual(readdirSync(temp).filter((n) => n.startsWith("kind-")), [], "der Temp-Ordner des Kindes ist samt spätem Schreiben weg");
  });
});
