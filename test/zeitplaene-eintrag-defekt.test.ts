import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

// Von Hand beschädigte data/zeitplaene.json: gültiges JSON und eine Liste, aber ein Eintrag ist kein Objekt.
// Früher brach schon der Import ab (z.id auf null) – und mit ihm der ganze Dienst samt Telegram und Notaus.
const projekt = resolve(import.meta.dirname, "..");
const origErr = console.error;
after(() => { console.error = origErr; process.chdir(projekt); });

type Modul = typeof import("../src/zeitplaene.js");

async function ladeIn(inhalt: string): Promise<{ mod: Modul; dir: string; fehler: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-zeitplaene-eintrag-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "zeitplaene.json"), inhalt);
  const fehler: string[] = [];
  const vorher = process.cwd();
  process.chdir(dir);
  console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
  try {
    // Query-String erzwingt eine frische Modulinstanz mit eigenem Lader
    const mod = (await import(`../src/zeitplaene.js?fall=${encodeURIComponent(dir)}`)) as Modul;
    return { mod, dir, fehler };
  } finally {
    console.error = origErr;
    process.chdir(vorher);
  }
}

const GUELTIG = { id: 3, name: "geheim-name", zeit: "07:00", tage: "mo", auftrag: "geheim-auftrag" };

describe("data/zeitplaene.json mit Nicht-Objekt-Eintrag", () => {
  const faelle: Record<string, unknown[]> = {
    "null allein": [null],
    "null vor einem gültigen Eintrag": [null, GUELTIG],
    "null nach einem gültigen Eintrag": [GUELTIG, null],
    "Zahl": [1],
    "Text": ["x"],
    "Liste": [[]],
  };
  for (const [titel, liste] of Object.entries(faelle)) {
    it(`${titel}: Import wirft nicht, Datei gilt als unlesbar (Sicherung, Sperre, nichts gespeichert)`, async () => {
      const inhalt = JSON.stringify(liste);
      const { mod, dir, fehler } = await ladeIn(inhalt);
      const datei = join(dir, "data", "zeitplaene.json");
      assert.equal(mod.zeitplaeneNichtGeladen, true);
      assert.equal(mod.zeitplaene.length, 0);
      const sicherung = `${datei}.defekt`;
      assert.ok(existsSync(sicherung), "Sicherung .defekt fehlt");
      assert.equal(readFileSync(sicherung, "utf8"), inhalt);
      assert.equal(statSync(sicherung).mode & 0o777, 0o600);
      assert.ok(fehler.some((f) => f.startsWith("Zeitpläne unlesbar")), fehler.join("\n"));
      assert.ok(!fehler.some((f) => f.includes("geheim")), "kein Dateiinhalt im Log");
      assert.ok(!existsSync(join(dir, "data", "state.json")), "beim Import wird nichts gespeichert");
      process.chdir(dir);
      try {
        assert.throws(() => mod.pruefeZeitplaeneSchreibbar(), /unlesbar/);
        assert.throws(() => mod.saveZeitplaene(), /unlesbar/);
      } finally {
        process.chdir(projekt);
      }
      assert.equal(readFileSync(datei, "utf8"), inhalt, "Bestand bleibt unverändert");
      assert.ok(!existsSync(`${datei}.tmp`));
      assert.ok(!existsSync(join(dir, "data", "state.json")));
    });
  }

  it("nur Objekte (auch mit fehlenden Feldern): kein Defekt, Bestand geladen", async () => {
    const inhalt = JSON.stringify([GUELTIG, { id: 4 }]);
    const { mod, dir } = await ladeIn(inhalt);
    assert.equal(mod.zeitplaeneNichtGeladen, false);
    assert.deepEqual(mod.zeitplaene.map((z) => z.id), [3, 4]);
    assert.ok(!existsSync(join(dir, "data", "zeitplaene.json.defekt")));
  });
});
