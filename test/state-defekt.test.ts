import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Eigene Datei: der Lader läuft nur einmal beim Import, hier mit abgeschnittenem state.json im Temp-Verzeichnis
const temp = mkdtempSync(join(tmpdir(), "jarvis-state-defekt-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const DATEI = join(temp, "data", "state.json");
const KAPUTT = '{"whoop": {"refreshToken": "attrappe-whoop"}, "google": {"refreshToken": "attrappe-google"}, "paused": tr';
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(DATEI, KAPUTT);

const fehler: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
const zustand = await import("../src/state.js");
console.error = origErr;

describe("state.json unlesbar", () => {
  it("startet im Notfall mit Notaus und meldet es laut, ohne Inhalt zu protokollieren", () => {
    assert.equal(zustand.stateNichtGeladen, true);
    assert.equal(zustand.state.paused, true);
    assert.equal(zustand.state.notfall?.aktiv, true);
    assert.equal(zustand.state.notfall?.grund, "state.json unlesbar");
    assert.ok(fehler.some((f) => f.includes("Zustand unlesbar") && f.includes("state.json.defekt")));
    assert.ok(fehler.every((f) => !f.includes("attrappe")));
  });

  it("legt eine Sicherung .defekt mit 600 an", () => {
    const sicherung = `${DATEI}.defekt`;
    assert.ok(existsSync(sicherung));
    assert.equal(readFileSync(sicherung, "utf8"), KAPUTT);
    assert.equal(statSync(sicherung).mode & 0o777, 0o600);
  });

  it("day() und save() überschreiben die Datei nicht", () => {
    const err: string[] = [];
    console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
    try {
      const d = zustand.day();
      assert.ok(d.date);
      zustand.state.paused = false;
      zustand.save();
      zustand.save();
    } finally {
      console.error = origErr;
    }
    assert.equal(readFileSync(DATEI, "utf8"), KAPUTT);
    assert.ok(!existsSync(`${DATEI}.tmp`));
    assert.equal(err.filter((f) => f.includes("speichere keinen Zustand")).length, 1);
  });
});

describe("state.json unlesbar: Hinweis und Sperre für Auth-Skripte", () => {
  it("zustandsHinweis nennt Ursache, Sicherung, Neustart und «kein Angriff», ohne Inhalt", () => {
    assert.deepEqual(zustand.zustandDefekt, { ursache: "kein gültiges JSON", kopie: "data/state.json.defekt" });
    const h = zustand.zustandsHinweis();
    assert.ok(h);
    assert.match(h, /state\.json war beim Start unlesbar/);
    assert.match(h, /kein gültiges JSON/);
    assert.match(h, /data\/state\.json\.defekt/);
    assert.match(h, /Kein Angriff erkannt/);
    assert.match(h, /speichere keinen Zustand/);
    assert.match(h, /nur bis zum nächsten Neustart/);
    assert.match(h, /Sir\.$/);
    assert.ok(!h.includes("attrappe"));
  });

  it("pruefeZustandSpeicherbar wirft, damit Auth-Skripte keinen Code verbrauchen", () => {
    assert.throws(() => zustand.pruefeZustandSpeicherbar(), /unlesbar/);
  });

  it("ein weiterer Start mit demselben defekten Inhalt legt keine zweite Sicherung an", async () => {
    console.error = () => {};
    const pfad = "../src/state.js?zweiterStart";
    const zweit = (await import(pfad).finally(() => { console.error = origErr; })) as typeof zustand;
    assert.equal(zweit.stateNichtGeladen, true);
    assert.equal(zweit.zustandDefekt?.kopie, "data/state.json.defekt");
    assert.deepEqual(readdirSync(join(temp, "data")).filter((f) => f.startsWith("state.json.defekt")), ["state.json.defekt"]);
  });

  it("geänderter defekter Inhalt bekommt eine eigene Sicherung", async () => {
    const anders = `${KAPUTT}x`;
    writeFileSync(DATEI, anders);
    try {
      console.error = () => {};
      const pfad = "../src/state.js?dritterStart";
      const dritt = (await import(pfad)) as typeof zustand;
      console.error = origErr;
      const kopie = dritt.zustandDefekt?.kopie;
      assert.ok(kopie && kopie.startsWith("data/state.json.defekt-"));
      assert.equal(readFileSync(join(temp, kopie), "utf8"), anders);
      assert.equal(readFileSync(`${DATEI}.defekt`, "utf8"), KAPUTT);
    } finally {
      console.error = origErr;
      writeFileSync(DATEI, KAPUTT);
    }
  });
});

describe("state.json fehlt", () => {
  it("ist kein Defekt: frischer Zustand wird normal gespeichert", async () => {
    // Zweite Instanz des Moduls in eigenem Temp-Verzeichnis über eine Abfrage-Marke
    const temp2 = mkdtempSync(join(tmpdir(), "jarvis-state-leer-"));
    const vorher = process.cwd();
    process.chdir(temp2);
    try {
      const pfad = "../src/state.js?leer"; // Variable: tsc soll die Abfrage-Marke nicht auflösen
      const frisch = (await import(pfad)) as typeof zustand;
      assert.equal(frisch.stateNichtGeladen, false);
      assert.equal(frisch.zustandsHinweis(), undefined);
      assert.doesNotThrow(() => frisch.pruefeZustandSpeicherbar());
      assert.equal(frisch.state.paused, undefined);
      frisch.day();
      assert.ok(existsSync(join(temp2, "data", "state.json")));
      assert.ok(!existsSync(join(temp2, "data", "state.json.defekt")));
    } finally {
      process.chdir(vorher);
      rmSync(temp2, { recursive: true, force: true });
    }
  });
});
