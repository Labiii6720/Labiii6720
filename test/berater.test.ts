import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/ liegt relativ); nie echte Dienste
const temp = mkdtempSync(join(tmpdir(), "jarvis-berater-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

mkdirSync(join(temp, "data"), { recursive: true });
const PROFIL = join(temp, "data", "profil.json");
const ARCHIV = join(temp, "data", "profil-archiv.jsonl");

const { profil } = await import("../src/profil.js");
const { beraterTools } = await import("../src/berater.js");

const vergessen = beraterTools.find((t) => t.name === "profil_vergessen")!;
const ctx = { sendFile: async () => {}, sendPhoto: async () => {}, sendVideo: async () => {} };
const lauf = {
  datum: "2026-10-01",
  entscheidungen: [
    { id: 5, datum: "2026-06-03T09:00:00.000Z", text: "Kündigung" },
    { id: 6, datum: "2026-05-04T09:00:00.000Z", text: "Mai bleibt" },
  ],
  chronik: [
    { monat: "2026-06", text: "Kündigung beschlossen.", entscheidungen: 1 },
    { monat: "2026-05", text: "Mai-Text", entscheidungen: 1 },
  ],
};
const chronikNeu = () => [
  { monat: "2026-05", text: "Mai-Text", entscheidungen: 1 },
  { monat: "2026-06", text: "Kündigung beschlossen.", entscheidungen: 1 },
];

describe("profil_vergessen chronik: gescheitertes Archiv-Bereinigen lässt sich nachholen", () => {
  it("erster Versuch: Archiv nicht schreibbar → Teilerfolg; zweiter Versuch entfernt die Details", async () => {
    profil.chronik = chronikNeu();
    writeFileSync(ARCHIV, `${JSON.stringify(lauf)}\n`, { mode: 0o600 });
    mkdirSync(`${ARCHIV}.tmp`); // writeFileSync auf .tmp scheitert (EISDIR)
    try {
      const erst = String(await vergessen.run({ art: "chronik", text: "2026-06" }, ctx));
      assert.match(erst, /^Chronik 2026-06 vergessen\. Die Details im Archiv liessen sich nicht entfernen \(.+\)\. Ein erneuter Versuch holt das nach, Sir\.$/);
      assert.deepEqual(profil.chronik.map((c) => c.monat), ["2026-05"]);
      assert.ok(readFileSync(ARCHIV, "utf8").includes("Kündigung"));

      // Ursache noch da: Fehler statt «Nicht gefunden.», Archiv unverändert
      await assert.rejects(vergessen.run({ art: "chronik", text: "2026-06" }, ctx), /Die Details im Archiv liessen sich nicht entfernen/);
      assert.ok(readFileSync(ARCHIV, "utf8").includes("Kündigung"));

      rmSync(`${ARCHIV}.tmp`, { recursive: true });
      assert.equal(await vergessen.run({ art: "chronik", text: " 2026-06 " }, ctx), "Vergessen (Archiv nachgeholt).");
      const neu = JSON.parse(readFileSync(ARCHIV, "utf8").split("\n")[0]!) as typeof lauf;
      assert.deepEqual(neu.entscheidungen.map((e) => e.id), [6]);
      assert.deepEqual(neu.chronik.map((c) => c.monat), ["2026-05"]);
      assert.ok(!readFileSync(ARCHIV, "utf8").includes("Kündigung"));
      assert.deepEqual(profil.chronik.map((c) => c.monat), ["2026-05"]);

      // jetzt wirklich nichts mehr da
      await assert.rejects(vergessen.run({ art: "chronik", text: "2026-06" }, ctx), (e: Error) => e.message === "Nicht gefunden.");
    } finally {
      rmSync(`${ARCHIV}.tmp`, { recursive: true, force: true });
      rmSync(ARCHIV, { force: true });
    }
  });

  it("Speichern des Profils scheitert → Monat bleibt im Profil, Archiv unberührt; zweiter Versuch gelingt ganz", async () => {
    profil.chronik = chronikNeu();
    writeFileSync(ARCHIV, `${JSON.stringify(lauf)}\n`, { mode: 0o600 });
    mkdirSync(`${PROFIL}.tmp`); // saveProfil scheitert (EISDIR)
    try {
      await assert.rejects(vergessen.run({ art: "chronik", text: "2026-06" }, ctx));
      assert.deepEqual(profil.chronik.map((c) => c.monat), ["2026-05", "2026-06"]);
      assert.ok(readFileSync(ARCHIV, "utf8").includes("Kündigung"));

      rmSync(`${PROFIL}.tmp`, { recursive: true });
      assert.equal(await vergessen.run({ art: "chronik", text: "2026-06" }, ctx), "Vergessen.");
      assert.deepEqual(profil.chronik.map((c) => c.monat), ["2026-05"]);
      const datei = JSON.parse(readFileSync(PROFIL, "utf8")) as { chronik: { monat: string }[] };
      assert.deepEqual(datei.chronik.map((c) => c.monat), ["2026-05"]);
      assert.ok(!readFileSync(ARCHIV, "utf8").includes("Kündigung"));
    } finally {
      rmSync(`${PROFIL}.tmp`, { recursive: true, force: true });
      rmSync(ARCHIV, { force: true });
    }
  });

  it("ohne gültigen Monat und ohne Treffer: «Nicht gefunden.», das Archiv wird nicht angefasst", async () => {
    profil.chronik = [];
    writeFileSync(ARCHIV, `${JSON.stringify(lauf)}\n`, { mode: 0o600 });
    try {
      for (const text of [undefined, "", "Juni", "2026-13"]) {
        await assert.rejects(vergessen.run({ art: "chronik", text }, ctx), (e: Error) => e.message === "Nicht gefunden.");
      }
      assert.equal(readFileSync(ARCHIV, "utf8"), `${JSON.stringify(lauf)}\n`);
      await assert.rejects(vergessen.run({ art: "chronik", text: "2026-04" }, ctx), (e: Error) => e.message === "Nicht gefunden.");
    } finally {
      rmSync(ARCHIV, { force: true });
    }
  });
});

describe("ziel_setzen: Frist und Freigabe-Text", () => {
  const ziel = beraterTools.find((t) => t.name === "ziel_setzen")!;

  it("lehnt ungültige Fristen ab und speichert nichts, weder beim Anlegen noch beim Ändern", async () => {
    profil.ziele = [];
    for (const frist of ["2026-02-30", "31.12.2026", "2026-1-5", "morgen"]) {
      await assert.rejects(ziel.run({ text: "Marathon", frist }, ctx), (e: Error) => e.message === "Frist bitte als JJJJ-MM-TT, Sir.");
    }
    assert.equal(profil.ziele.length, 0);

    assert.equal(await ziel.run({ text: "Marathon", frist: "2027-04-30" }, ctx), `Ziel #${profil.ziele[0]!.id} gesetzt.`);
    const id = profil.ziele[0]!.id;
    await assert.rejects(ziel.run({ id, text: "Halbmarathon", frist: "2027-13-01" }, ctx), /JJJJ-MM-TT/);
    assert.equal(profil.ziele[0]!.text, "Marathon");
    assert.equal(profil.ziele[0]!.frist, "2027-04-30");
  });

  it("die summary zeigt Text, Status und Frist", () => {
    const neu = ziel.summary!({ text: "Marathon", frist: "2027-04-30" });
    assert.ok(neu.includes("Marathon") && neu.includes("Status offen") && neu.includes("Frist 2027-04-30"), neu);
    const aendern = ziel.summary!({ id: 3, status: "erreicht", frist: "2027-05-01" });
    assert.ok(aendern.includes("#3 ändern") && aendern.includes("(Text unverändert)") && aendern.includes("Status erreicht") && aendern.includes("Frist 2027-05-01"), aendern);
  });
});
