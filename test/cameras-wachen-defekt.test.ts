import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

// Eigene Datei: die Lader laufen nur einmal beim Import, hier mit abgeschnittener wachen.json und kaputter cameras.json
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-wachen-defekt-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

const DATEI = join(temp, "data", "wachen.json");
// wie nach Stromausfall auf der SD-Karte: zwei Wachen, Ende fehlt
const KAPUTT = '[{"id": 1, "kamera": "einfahrt", "frage": "Tor offen?", "alle_minuten": 10}, {"id": 2, "kamera": "garten", "frage": "Person im Garten?", "alle_min';
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(DATEI, KAPUTT);
writeFileSync(join(temp, "cameras.json"), '{"einfahrt": {"frigate": "einfahrt", "beschreibung": "geheim-inhalt"');

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const kameras = await import("../src/cameras.js");
console.error = origErr;

describe("wachen.json unlesbar", () => {
  it("startet leer, merkt sich die Sperre und meldet es laut, ohne Inhalt", () => {
    assert.equal(kameras.dynamicWachen.length, 0);
    assert.equal(kameras.wachenNichtGeladen, true);
    assert.ok(fehler.some((f) => f.includes("Wachen unlesbar") && f.includes("wachen.json.defekt")));
    assert.ok(!fehler.some((f) => f.includes("Tor offen") || f.includes("geheim-inhalt")), "kein Dateiinhalt im Log");
    assert.match(kameras.WACHEN_UNLESBAR, /Sir/);
  });

  it("legt eine Sicherung .defekt mit 600 an", () => {
    const sicherung = `${DATEI}.defekt`;
    assert.ok(existsSync(sicherung));
    assert.equal(readFileSync(sicherung, "utf8"), KAPUTT);
    assert.equal(statSync(sicherung).mode & 0o777, 0o600);
  });

  it("saveWachen und pruefeWachenSchreibbar verweigern, die Datei bleibt unverändert", () => {
    assert.throws(() => kameras.pruefeWachenSchreibbar(), /unlesbar/);
    kameras.dynamicWachen.push({ id: 1, kamera: "einfahrt", frage: "neu", alle_minuten: 5 });
    try {
      assert.throws(() => kameras.saveWachen(), /unlesbar/);
    } finally {
      kameras.dynamicWachen.length = 0;
    }
    assert.equal(readFileSync(DATEI, "utf8"), KAPUTT);
    assert.ok(!existsSync(`${DATEI}.tmp`));
  });

  it("kaputte cameras.json wird gemeldet und als leer behandelt", () => {
    assert.equal(kameras.camerasNichtGeladen, true);
    assert.deepEqual(Object.keys(kameras.cameras), []);
    assert.ok(fehler.some((f) => f.includes("cameras.json unlesbar")));
  });
});

describe("wachen.json: weitere Fälle (frischer Import im eigenen Ordner)", () => {
  async function ladeIn(vorbereiten: (dir: string) => void): Promise<{ mod: typeof kameras; fehler: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-wachen-fall-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    vorbereiten(dir);
    const f: string[] = [];
    const vorher = process.cwd();
    process.chdir(dir);
    console.error = (...a: unknown[]) => { f.push(a.map(String).join(" ")); };
    try {
      // Query-String erzwingt eine frische Modulinstanz mit eigenem Lader
      const mod = (await import(`../src/cameras.js?fall=${encodeURIComponent(dir)}`)) as typeof kameras;
      return { mod, fehler: f };
    } finally {
      console.error = origErr;
      process.chdir(vorher);
    }
  }

  it("fehlende Datei heisst leer, ohne Sperre", async () => {
    const { mod, fehler: f } = await ladeIn(() => {});
    assert.equal(mod.wachenNichtGeladen, false);
    assert.equal(mod.camerasNichtGeladen, false);
    assert.equal(mod.dynamicWachen.length, 0);
    assert.equal(f.length, 0);
  });

  it("gültiges JSON, aber keine Liste, sperrt ebenfalls", async () => {
    const { mod } = await ladeIn((dir) => {
      mkdirSync(join(dir, "data"));
      writeFileSync(join(dir, "data", "wachen.json"), '{"id": 1}');
    });
    assert.equal(mod.wachenNichtGeladen, true);
    assert.throws(() => mod.saveWachen(), /unlesbar/);
  });

  it("ohne Leserechte: Sperre ohne Sicherung", { skip: process.getuid?.() === 0 ? "als root immer lesbar" : false }, async () => {
    const { mod } = await ladeIn((dir) => {
      mkdirSync(join(dir, "data"));
      writeFileSync(join(dir, "data", "wachen.json"), "[]");
      chmodSync(join(dir, "data", "wachen.json"), 0o000);
    });
    assert.equal(mod.wachenNichtGeladen, true);
    assert.throws(() => mod.saveWachen(), /unlesbar/);
  });

  it("gültige Datei lädt und speichert normal", async () => {
    let dir = "";
    const { mod } = await ladeIn((d) => {
      dir = d;
      mkdirSync(join(d, "data"));
      writeFileSync(join(d, "data", "wachen.json"), JSON.stringify([{ id: 3, kamera: "x", frage: "?", alle_minuten: 5 }]));
    });
    assert.equal(mod.wachenNichtGeladen, false);
    assert.equal(mod.dynamicWachen.length, 1);
    const vorher = process.cwd();
    process.chdir(dir);
    try {
      mod.saveWachen();
    } finally {
      process.chdir(vorher);
    }
    assert.equal(JSON.parse(readFileSync(join(dir, "data", "wachen.json"), "utf8"))[0].id, 3);
  });
});
