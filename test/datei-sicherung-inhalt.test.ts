import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// npm run check nannte «Sicherung .defekt», sobald irgendeine alte Sicherung herumlag, auch wenn die Datei seither
// erneut verdorben war und der jetzige Inhalt nirgends gesichert ist. Jetzt zählt nur eine Sicherung mit genau diesem Inhalt.
const temp = mkdtempSync(join(tmpdir(), "jarvis-sicherung-inhalt-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const datei = await import("../src/datei.js");
datei.nurLesen(); // wie scripts/check.ts; dieser Prozess speichert nichts
const { sicherungsVermerk } = await import("../src/check.js");

describe("sicherungVorhanden vergleicht den Inhalt", () => {
  const dir = mkdtempSync(join(temp, "data-"));
  const p = (n: string) => join(dir, n);
  mkdirSync(dir, { recursive: true });

  it("alte .defekt mit anderem Inhalt → ungesichert, nur gelesen", () => {
    writeFileSync(p("rechnungen.json"), '[{"id": 2,');
    writeFileSync(p("rechnungen.json.defekt"), '[{"id": 1,');
    assert.equal(datei.sicherungVorhanden(p("rechnungen.json")), false);
    assert.equal(sicherungsVermerk([p("rechnungen.json")]), "ungesichert, nur gelesen");
  });

  it("gleicher Inhalt (auch unter .defekt-<Zeit>) → Sicherung .defekt", () => {
    writeFileSync(p("rechnungen.json.defekt-2026-10-15T08-00-00-000Z"), '[{"id": 2,');
    assert.equal(datei.sicherungVorhanden(p("rechnungen.json")), true);
    assert.equal(sicherungsVermerk([p("rechnungen.json")]), "Sicherung .defekt");
  });

  it("Datei fehlt → keine Sicherung des jetzigen Stands", () => {
    writeFileSync(p("wachen.json.defekt"), "x");
    assert.equal(datei.sicherungVorhanden(p("wachen.json")), false);
  });
});
