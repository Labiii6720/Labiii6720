import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

// Von Hand beschädigte data/zeitplaene.json: gültiges JSON und eine Liste, aber ein Eintrag ist kein gültiger Zeitplan
// (kein Objekt, Pflichtfeld fehlt oder hat den falschen Typ). Früher brach schon der Import ab (z.id auf null) – und mit
// ihm der ganze Dienst samt Telegram und Notaus; danach galt die ganze Datei als unlesbar. Jetzt fällt nur der Eintrag weg.
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

describe("data/zeitplaene.json mit ungültigem Eintrag", () => {
  const faelle: Record<string, unknown[]> = {
    "null allein": [null],
    "null vor einem gültigen Eintrag": [null, GUELTIG],
    "null nach einem gültigen Eintrag": [GUELTIG, null],
    "Zahl": [GUELTIG, 1],
    "Text": [GUELTIG, "x"],
    "Liste": [GUELTIG, []],
    "nur id (Felder fehlen)": [GUELTIG, { id: 4 }],
    "auftrag fehlt": [GUELTIG, { id: 4, name: "n", zeit: "07:00", tage: "mo" }],
    "zeit als Zahl": [GUELTIG, { id: 4, name: "n", zeit: 700, tage: "mo", auftrag: "a" }],
    "id als Text": [GUELTIG, { id: "4", name: "n", zeit: "07:00", tage: "mo", auftrag: "a" }],
    "id 0": [GUELTIG, { id: 0, name: "n", zeit: "07:00", tage: "mo", auftrag: "a" }],
  };
  for (const [titel, liste] of Object.entries(faelle)) {
    it(`${titel}: Import wirft nicht, nur der Eintrag fällt weg (Sicherung, Log ohne Inhalt), Speichern behält die gültigen`, async () => {
      const inhalt = JSON.stringify(liste);
      const { mod, dir, fehler } = await ladeIn(inhalt);
      const datei = join(dir, "data", "zeitplaene.json");
      const gueltig = liste.includes(GUELTIG) ? [GUELTIG] : [];
      assert.equal(mod.zeitplaeneNichtGeladen, false);
      assert.deepEqual(mod.zeitplaene, gueltig);
      const sicherung = `${datei}.defekt`;
      assert.equal(readFileSync(sicherung, "utf8"), inhalt);
      assert.equal(statSync(sicherung).mode & 0o777, 0o600);
      assert.ok(fehler.some((f) => f.startsWith("Zeitpläne: 1 ungültiger Eintrag übersprungen (Sicherung unter data/zeitplaene.json.defekt)")), fehler.join("\n"));
      assert.ok(!fehler.some((f) => f.includes("geheim")), "kein Dateiinhalt im Log");
      assert.ok(!existsSync(join(dir, "data", "state.json")), "beim Import wird nichts gespeichert");
      assert.equal(readFileSync(datei, "utf8"), inhalt, "beim Import bleibt die Datei unverändert");
      process.chdir(dir);
      try {
        assert.doesNotThrow(() => mod.pruefeZeitplaeneSchreibbar());
        mod.saveZeitplaene();
      } finally {
        process.chdir(projekt);
      }
      assert.deepEqual(JSON.parse(readFileSync(datei, "utf8")), gueltig);
      assert.equal(readFileSync(sicherung, "utf8"), inhalt, "die Sicherung bewahrt den verworfenen Eintrag");
      assert.ok(!existsSync(`${datei}.tmp`));
    });
  }

  it("nur gültige Einträge (auch mit ungültigen Werten wie «25:00» oder «montags»): keine Sicherung, Bestand geladen", async () => {
    const wert = { id: 4, name: "", zeit: "25:00", tage: "montags", auftrag: " " };
    const inhalt = JSON.stringify([GUELTIG, wert]);
    const { mod, dir, fehler } = await ladeIn(inhalt);
    assert.equal(mod.zeitplaeneNichtGeladen, false);
    assert.deepEqual(mod.zeitplaene.map((z) => z.id), [3, 4]);
    assert.ok(!existsSync(join(dir, "data", "zeitplaene.json.defekt")));
    assert.ok(!fehler.some((f) => f.includes("übersprungen")));
  });
});
