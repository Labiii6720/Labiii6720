import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/profil.json liegt relativ); nie echte Dienste
const temp = mkdtempSync(join(tmpdir(), "jarvis-profil-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  throw new Error(`unerwarteter Netzaufruf: ${String(eingabe instanceof Request ? eingabe.url : eingabe)}`);
}) as typeof fetch;

const PROFIL = join(temp, "data", "profil.json");
const ALT = {
  ziele: [{ id: 1, text: "Halbmarathon unter 2 h", status: "offen", angelegt: "2026-01-02T08:00:00.000Z" }],
  werte: ["Gesundheit vor Tempo"],
  muster: [],
  entscheidungen: [{ id: 1, datum: "2026-09-01T10:00:00.000Z", text: "Kein Auto gekauft" }],
  fakten: ["Wohnt in Muttenz", "Arbeitet bei einem Sicherheitsunternehmen", "Trinkt Kaffee schwarz"],
  eigenesFeld: "bleibt",
};
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(PROFIL, JSON.stringify(ALT, null, 2), { mode: 0o600 });

const { aktuelleFakten, gleicherText, hoechsteFaktId, neueEntscheidungId, neueFaktId, normalisiereProfil, profil, profilFuerAnzeige, profilFuerPrompt, saveProfil } = await import("../src/profil.js");
const { beraterPrompt, beraterTools } = await import("../src/berater.js");
const { todayKey } = await import("../src/time.js");
const heute = todayKey();

const werkzeug = (name: string) => beraterTools.find((t) => t.name === name)!;
const ctx = { sendFile: async () => {}, sendPhoto: async () => {}, sendVideo: async () => {} };

describe("Migration alter fakten: string[]", () => {
  it("beim Laden: ids fortlaufend, seit = heute, quelle import; übrige Daten unverändert", () => {
    assert.deepEqual(profil.fakten, [
      { id: 1, text: "Wohnt in Muttenz", seit: heute, quelle: "import" },
      { id: 2, text: "Arbeitet bei einem Sicherheitsunternehmen", seit: heute, quelle: "import" },
      { id: 3, text: "Trinkt Kaffee schwarz", seit: heute, quelle: "import" },
    ]);
    assert.deepEqual(profil.chronik, []);
    assert.deepEqual(profil.ziele, ALT.ziele);
    assert.deepEqual(profil.werte, ALT.werte);
    assert.deepEqual(profil.entscheidungen, ALT.entscheidungen);
    assert.equal((profil as unknown as Record<string, unknown>).eigenesFeld, "bleibt");
    assert.equal(neueFaktId(), 4);
  });

  it("die Datei im alten Format wird vor der Umstellung einmal gesichert (0o600-Verzeichnis, Inhalt unverändert)", () => {
    const sicherung = join(temp, "data", "profil.vor-0.17.json");
    assert.ok(existsSync(sicherung));
    assert.deepEqual(JSON.parse(readFileSync(sicherung, "utf8")), ALT);
  });

  it("normalisiereProfil: gemischt, Lücken, doppelte ids, leere Texte, fehlende Listen", () => {
    const p = normalisiereProfil(
      {
        fakten: [
          "Alt eins",
          { id: 7, text: "Neu sieben", seit: "2026-03-12", quelle: "chat" },
          { id: 7, text: "Doppelte id", seit: "kaputt", quelle: "erfunden" },
          "   ",
          null,
          { text: "" },
          { id: 2, text: "Veraltet", seit: "2026-01-01T09:00:00Z", quelle: "verdichtung", veraltet: { seit: "2026-05-01", grund: "umgezogen" } },
          42,
        ],
      },
      "2026-10-11",
    );
    assert.deepEqual(p.fakten, [
      { id: 8, text: "Alt eins", seit: "2026-10-11", quelle: "import" },
      { id: 7, text: "Neu sieben", seit: "2026-03-12", quelle: "chat" },
      { id: 9, text: "Doppelte id", seit: "2026-10-11", quelle: "import" },
      { id: 2, text: "Veraltet", seit: "2026-01-01", quelle: "verdichtung", veraltet: { seit: "2026-05-01", grund: "umgezogen" } },
      { id: 10, text: "42", seit: "2026-10-11", quelle: "import" },
    ]);
    assert.deepEqual([p.ziele, p.werte, p.muster, p.entscheidungen, p.chronik], [[], [], [], [], []]);
    assert.deepEqual(normalisiereProfil(null, "2026-10-11"), { ziele: [], werte: [], muster: [], entscheidungen: [], fakten: [], chronik: [] });
  });

  it("nur Strings: ids 1..n in Reihenfolge", () => {
    const p = normalisiereProfil({ fakten: ["a", "b", "c"] }, "2026-10-11");
    assert.deepEqual(p.fakten.map((f) => [f.id, f.text, f.seit, f.quelle]), [
      [1, "a", "2026-10-11", "import"],
      [2, "b", "2026-10-11", "import"],
      [3, "c", "2026-10-11", "import"],
    ]);
  });
});

describe("profilFuerPrompt", () => {
  beforeEach(() => {
    profil.fakten = [
      { id: 1, text: "Wohnt in Muttenz", seit: "2026-03-12", quelle: "import" },
      { id: 2, text: "Wohnt in Basel", seit: "2025-01-01", quelle: "import", veraltet: { seit: "2026-03-12", grund: "umgezogen, siehe #1" } },
      { id: 3, text: "Fährt ein E-Bike", seit: "2026-01-05", quelle: "chat" },
    ];
    profil.chronik = [];
  });

  it("Fakten mit Datum, nach seit sortiert; veraltete erscheinen nicht", () => {
    const p = profilFuerPrompt();
    assert.ok(p.includes("Dauerhafte Fakten (seit): 2026-01-05 Fährt ein E-Bike; 2026-03-12 Wohnt in Muttenz"), p);
    assert.ok(!p.includes("Basel"), p);
    assert.ok(!p.includes("Chronik"), "ohne Chronik keine Zeile");
  });

  it("nur die letzten 20 nach seit", () => {
    profil.fakten = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, text: `F${i + 1}`, seit: `2026-01-${String(25 - i).padStart(2, "0")}`, quelle: "chat" as const }));
    const zeile = profilFuerPrompt().split("\n").find((z) => z.startsWith("Dauerhafte Fakten"))!;
    const eintraege = zeile.replace("Dauerhafte Fakten (seit): ", "").split("; ");
    assert.equal(eintraege.length, 20);
    // F25 hat das älteste Datum (01-01) … F6 (01-20): die fünf ältesten (F21–F25) fallen weg
    assert.equal(eintraege[0], "2026-01-06 F20");
    assert.equal(eintraege.at(-1), "2026-01-25 F1");
  });

  it("Chronik: die letzten drei Monate", () => {
    profil.chronik = [
      { monat: "2026-07", text: "Juli-Text", entscheidungen: 2 },
      { monat: "2026-04", text: "April-Text", entscheidungen: 1 },
      { monat: "2026-06", text: "Juni-Text", entscheidungen: 3 },
      { monat: "2026-05", text: "Mai-Text", entscheidungen: 1 },
    ];
    const p = profilFuerPrompt();
    assert.ok(p.includes("Chronik: 2026-05: Mai-Text\nChronik: 2026-06: Juni-Text\nChronik: 2026-07: Juli-Text"), p);
    assert.ok(!p.includes("April"), p);
  });

  it("Berater-Regeln stehen unverändert vor dem Gelernten", () => {
    const b = beraterPrompt();
    assert.ok(b.includes("Du bewertest Entscheidungen und ihren Bezug zu seinen Zielen, nicht seinen Charakter."));
    assert.ok(b.includes("Entscheidungsmuster sprichst du nur an, wenn sie im Profil mit Belegen stehen."));
    assert.ok(b.includes("Dauerhafte Fakten (seit): "));
  });

  it("profil_anzeigen zeigt alle Fakten mit Nummer, veraltete mit Grund", async () => {
    const text = profilFuerAnzeige();
    assert.ok(text.includes("#2 (seit 2025-01-01) Wohnt in Basel [veraltet seit 2026-03-12: umgezogen, siehe #1]"), text);
    assert.equal(await werkzeug("profil_anzeigen").run({}, ctx), text);
  });

  it("aktuelleFakten: ohne veraltete, älteste zuerst", () => {
    assert.deepEqual(aktuelleFakten().map((f) => f.id), [3, 1]);
  });
});

describe("Speichern und Laden im neuen Format", () => {
  it("Roundtrip: Datei im neuen Format (0o600), neu geladen identisch", async () => {
    profil.fakten = [
      { id: 1, text: "Wohnt in Muttenz", seit: "2026-03-12", quelle: "import" },
      { id: 5, text: "Alt", seit: "2025-01-01", quelle: "chat", veraltet: { seit: "2026-03-12", grund: "überholt" } },
    ];
    profil.chronik = [{ monat: "2026-06", text: "Zwei Anschaffungen verschoben.", entscheidungen: 2 }];
    profil.letzteVerdichtung = "2026-10-10";
    saveProfil();
    assert.equal(statSync(PROFIL).mode & 0o777, 0o600);
    assert.ok(!existsSync(`${PROFIL}.tmp`));
    const roh = JSON.parse(readFileSync(PROFIL, "utf8")) as { fakten: unknown[] };
    assert.ok(roh.fakten.every((f) => typeof f === "object"), "kein String mehr in fakten");
    const neu = (await import(new URL("../src/profil.js?roundtrip=1", import.meta.url).href)) as typeof import("../src/profil.js");
    assert.deepEqual(neu.profil, JSON.parse(JSON.stringify(profil)));
  });

  it("unlesbare Datei: Kopie unter profil.json.defekt, Start mit leerem Profil", async () => {
    const orig = readFileSync(PROFIL, "utf8");
    const origErr = console.error;
    console.error = () => {};
    try {
      writeFileSync(PROFIL, "{ kaputt");
      const neu = (await import(new URL("../src/profil.js?defekt=1", import.meta.url).href)) as typeof import("../src/profil.js");
      assert.deepEqual(neu.profil.fakten, []);
      assert.equal(readFileSync(join(temp, "data", "profil.json.defekt"), "utf8"), "{ kaputt");
      // nicht geladen: Speichern verweigert, die kaputte Datei bleibt
      assert.equal(neu.profilNichtGeladen, true);
      assert.throws(() => neu.saveProfil(), /Profil nicht geladen/);
      assert.equal(readFileSync(PROFIL, "utf8"), "{ kaputt");
    } finally {
      console.error = origErr;
      writeFileSync(PROFIL, orig);
    }
  });

  it("zweiter Defekt: ältere Sicherung bleibt, die neue kommt mit Zeitstempel daneben (0o600), Log nennt sie", async () => {
    const orig = readFileSync(PROFIL, "utf8");
    const origErr = console.error;
    const log: string[] = [];
    console.error = (...a: unknown[]) => { log.push(a.map(String).join(" ")); };
    const data = join(temp, "data");
    const sicherungen = () => readdirSync(data).filter((n) => n.startsWith("profil.json.defekt-")).sort();
    try {
      writeFileSync(join(data, "profil.json.defekt"), "alte Sicherung");
      writeFileSync(PROFIL, '{"ziele":[{"id":1,"text":"Wichtiges Ziel"');
      const a = (await import(new URL("../src/profil.js?defekt=2", import.meta.url).href)) as typeof import("../src/profil.js");
      writeFileSync(PROFIL, '{"werte":["Zweiter Vorfall"');
      const b = (await import(new URL("../src/profil.js?defekt=3", import.meta.url).href)) as typeof import("../src/profil.js");
      assert.equal(a.profilNichtGeladen && b.profilNichtGeladen, true);
      assert.equal(readFileSync(join(data, "profil.json.defekt"), "utf8"), "alte Sicherung");
      const neue = sicherungen();
      assert.equal(neue.length, 2, neue.join(", "));
      const inhalte = neue.map((n) => readFileSync(join(data, n), "utf8"));
      assert.ok(inhalte.includes('{"ziele":[{"id":1,"text":"Wichtiges Ziel"'), inhalte.join(" | "));
      assert.ok(inhalte.includes('{"werte":["Zweiter Vorfall"'), inhalte.join(" | "));
      for (const n of neue) {
        assert.equal(statSync(join(data, n)).mode & 0o777, 0o600);
        assert.ok(log.some((z) => z.includes(`Kopie unter data/${n}`)), log.join("\n"));
      }
      assert.throws(() => b.saveProfil(), /Profil nicht geladen/);
      assert.equal(readFileSync(PROFIL, "utf8"), '{"werte":["Zweiter Vorfall"');
    } finally {
      console.error = origErr;
      for (const n of sicherungen()) rmSync(join(data, n));
      writeFileSync(PROFIL, orig);
    }
  });

  it("Neustart mit unveränderter defekter Datei: keine weitere Kopie (gleiche Sicherung gilt)", async () => {
    const orig = readFileSync(PROFIL, "utf8");
    const origErr = console.error;
    const log: string[] = [];
    console.error = (...a: unknown[]) => { log.push(a.map(String).join(" ")); };
    const data = join(temp, "data");
    const sicherungen = () => readdirSync(data).filter((n) => n.startsWith("profil.json.defekt-")).sort();
    try {
      writeFileSync(join(data, "profil.json.defekt"), "alte Sicherung");
      writeFileSync(PROFIL, '{"ziele":[{"id":7');
      await import(new URL("../src/profil.js?gleich=1", import.meta.url).href);
      await import(new URL("../src/profil.js?gleich=2", import.meta.url).href);
      await import(new URL("../src/profil.js?gleich=3", import.meta.url).href);
      const neue = sicherungen();
      assert.equal(neue.length, 1, neue.join(", "));
      assert.equal(readFileSync(join(data, neue[0]!), "utf8"), '{"ziele":[{"id":7');
      assert.equal(log.filter((z) => z.includes(`Kopie unter data/${neue[0]}`)).length, 3, log.join("\n"));
    } finally {
      console.error = origErr;
      for (const n of sicherungen()) rmSync(join(data, n));
      writeFileSync(PROFIL, orig);
    }
  });

  it("nicht lesbare Datei (kein ENOENT): leeres Profil im Speicher, Speichern verweigert, nichts überschrieben", async () => {
    const zweit = mkdtempSync(join(tmpdir(), "jarvis-profil-eisdir-"));
    const origErr = console.error;
    console.error = () => {};
    try {
      // Ein Verzeichnis statt der Datei: readFileSync scheitert mit EISDIR (als root greift chmod 000 nicht)
      mkdirSync(join(zweit, "data", "profil.json"), { recursive: true });
      writeFileSync(join(zweit, "data", "profil.json", "inhalt"), "echt");
      process.chdir(zweit);
      const neu = (await import(new URL("../src/profil.js?eisdir=1", import.meta.url).href)) as typeof import("../src/profil.js");
      assert.equal(neu.profilNichtGeladen, true);
      assert.deepEqual(neu.profil.ziele, []);
      neu.profil.fakten.push({ id: 1, text: "x", seit: heute, quelle: "chat" });
      assert.throws(() => neu.saveProfil(), /Profil nicht geladen/);
      assert.ok(!existsSync(join(zweit, "data", "profil.json.tmp")));
      assert.equal(readFileSync(join(zweit, "data", "profil.json", "inhalt"), "utf8"), "echt");
    } finally {
      console.error = origErr;
      process.chdir(temp);
      rmSync(zweit, { recursive: true, force: true });
    }
  });

  it("fehlende Datei (ENOENT): leeres Profil, Speichern erlaubt", async () => {
    const zweit = mkdtempSync(join(tmpdir(), "jarvis-profil-neu-"));
    try {
      process.chdir(zweit);
      const neu = (await import(new URL("../src/profil.js?enoent=1", import.meta.url).href)) as typeof import("../src/profil.js");
      assert.equal(neu.profilNichtGeladen, false);
      neu.saveProfil();
      assert.ok(existsSync(join(zweit, "data", "profil.json")));
    } finally {
      process.chdir(temp);
      rmSync(zweit, { recursive: true, force: true });
    }
  });
});

describe("Entscheidungs-ids nach der Verdichtung", () => {
  it("Chronik leert die Liste: die nächste id ist grösser als jede archivierte", async () => {
    profil.entscheidungen = [
      { id: 1, datum: "2026-03-02T10:00:00.000Z", text: "März" },
      { id: 2, datum: "2026-04-02T10:00:00.000Z", text: "April" },
    ];
    saveProfil();
    assert.equal(profil.entscheidungIdMax, 2);
    // wie wendeAn: Kopie des Profils, Entscheidungen der Chronik-Monate ins Archiv
    const neu = structuredClone(profil);
    const archiviert = neu.entscheidungen.map((e) => e.id);
    neu.entscheidungen = [];
    Object.assign(profil, neu);
    saveProfil();
    assert.equal(neueEntscheidungId(), 3);
    assert.equal(await werkzeug("entscheidung_notieren").run({ text: "Neu" }, ctx), "Entscheidung #3 notiert.");
    assert.ok(profil.entscheidungen.every((e) => !archiviert.includes(e.id)));
  });

  it("auch wenn das Feld beim Ersetzen fehlt, bleibt der Höchstwert im Speicher", () => {
    profil.entscheidungen = [];
    delete profil.entscheidungIdMax;
    assert.equal(neueEntscheidungId(), 4);
    saveProfil();
    assert.equal((JSON.parse(readFileSync(PROFIL, "utf8")) as { entscheidungIdMax?: number }).entscheidungIdMax, 3);
  });

  it("Laden: festgehaltener Höchstwert bleibt, wird an die Liste angeglichen, Unsinn verworfen", async () => {
    assert.equal(normalisiereProfil({ entscheidungen: [], entscheidungIdMax: 7 }).entscheidungIdMax, 7);
    assert.equal(normalisiereProfil({ entscheidungen: [{ id: 9, datum: "2026-01-01", text: "x" }], entscheidungIdMax: 7 }).entscheidungIdMax, 9);
    assert.equal(normalisiereProfil({ entscheidungen: [], entscheidungIdMax: "viel" }).entscheidungIdMax, undefined);
    assert.ok(!("entscheidungIdMax" in normalisiereProfil({ entscheidungIdMax: -1 })));
    assert.ok(!("entscheidungIdMax" in normalisiereProfil({ entscheidungIdMax: 1.5 })));
    assert.ok(!("entscheidungIdMax" in normalisiereProfil({ entscheidungIdMax: "x" })));
    const orig = readFileSync(PROFIL, "utf8");
    try {
      writeFileSync(PROFIL, JSON.stringify({ entscheidungen: [], entscheidungIdMax: 7 }));
      const neu = (await import(new URL("../src/profil.js?idmax=1", import.meta.url).href)) as typeof import("../src/profil.js");
      assert.equal(neu.neueEntscheidungId(), 8);
    } finally {
      writeFileSync(PROFIL, orig);
    }
  });
});

describe("Werkzeuge fakt_merken und profil_vergessen", () => {
  beforeEach(() => {
    profil.fakten = [
      { id: 1, text: "Wohnt in Muttenz", seit: "2026-03-12", quelle: "import" },
      { id: 4, text: "Trinkt Kaffee schwarz", seit: "2026-04-01", quelle: "chat" },
    ];
  });

  it("fakt_merken: Stufe auto, legt Fakt mit seit = heute, quelle chat an und speichert", async () => {
    const t = werkzeug("fakt_merken");
    assert.equal(t.stufe, "auto");
    // frühere Tests haben schon höhere ids vergeben: die neue liegt über allem, was je vergeben war
    const id = neueFaktId();
    assert.ok(id >= 5, `id ${id}`);
    assert.equal(await t.run({ text: "  Hat  eine Tochter\n namens Lea " }, ctx), `Fakt #${id} gemerkt.`);
    assert.deepEqual(profil.fakten.at(-1), { id, text: "Hat eine Tochter namens Lea", seit: heute, quelle: "chat" });
    const datei = JSON.parse(readFileSync(PROFIL, "utf8")) as { fakten: { id: number }[]; faktIdMax?: number };
    assert.equal(datei.fakten.at(-1)?.id, id);
    assert.equal(datei.faktIdMax, id);
  });

  it("fakt_merken: Duplikate per Textvergleich, leer und zu lang abgewiesen", async () => {
    const t = werkzeug("fakt_merken");
    assert.equal(await t.run({ text: "wohnt in muttenz." }, ctx), "Schon bekannt (#1).");
    assert.equal(profil.fakten.length, 2);
    await assert.rejects(t.run({ text: "   " }, ctx), /Kein Fakt/);
    await assert.rejects(t.run({ text: "x".repeat(201) }, ctx), /höchstens 200 Zeichen/);
    // ein veralteter gleicher Fakt hindert nicht daran, ihn neu (mit neuem Datum) festzuhalten
    profil.fakten[0]!.veraltet = { seit: "2026-05-01", grund: "umgezogen" };
    // die id des im vorigen Test gemerkten (und hier verworfenen) Fakts kommt nicht wieder
    const bisher = profil.faktIdMax ?? 0;
    assert.ok(bisher >= 5, `faktIdMax ${bisher}`);
    assert.equal(await t.run({ text: "Wohnt in Muttenz" }, ctx), `Fakt #${bisher + 1} gemerkt.`);
  });

  it("profil_vergessen: Fakt per id oder per Text; unbekannt → Fehler", async () => {
    const t = werkzeug("profil_vergessen");
    assert.equal(t.stufe, "extern");
    assert.equal(await t.run({ art: "fakt", id: 4 }, ctx), "Vergessen.");
    assert.deepEqual(profil.fakten.map((f) => f.id), [1]);
    assert.equal(await t.run({ art: "fakt", text: "Wohnt in Muttenz" }, ctx), "Vergessen.");
    assert.deepEqual(profil.fakten, []);
    await assert.rejects(t.run({ art: "fakt", id: 99 }, ctx), /Nicht gefunden/);
    await assert.rejects(t.run({ art: "fakt", text: "gibt es nicht" }, ctx), /Nicht gefunden/);
  });

  it("profil_vergessen: Chronik-Monat entfernen, danach nicht mehr im Prompt; unbekannter Monat → Fehler", async () => {
    const t = werkzeug("profil_vergessen");
    profil.chronik = [
      { monat: "2026-05", text: "Mai-Text", entscheidungen: 1 },
      { monat: "2026-06", text: "Kündigung im Juni beschlossen.", entscheidungen: 2 },
    ];
    assert.ok(profilFuerPrompt().includes("Chronik: 2026-06: Kündigung im Juni beschlossen."));
    assert.equal(await t.run({ art: "chronik", text: " 2026-06 " }, ctx), "Vergessen.");
    assert.deepEqual(profil.chronik.map((c) => c.monat), ["2026-05"]);
    assert.ok(!profilFuerPrompt().includes("Kündigung"), profilFuerPrompt());
    const datei = JSON.parse(readFileSync(PROFIL, "utf8")) as { chronik: { monat: string }[] };
    assert.deepEqual(datei.chronik.map((c) => c.monat), ["2026-05"]);
    await assert.rejects(t.run({ art: "chronik", text: "2026-06" }, ctx), /Nicht gefunden/);
    await assert.rejects(t.run({ art: "chronik" }, ctx), /Nicht gefunden/);
    assert.match(String((t.input_schema.properties.art as { description?: string }).description), /chronik/);
  });

  it("profil_vergessen: Chronik-Monat auch aus dem Archiv entfernt (Entscheidungen und Chronik-Text), anderes bleibt", async () => {
    const t = werkzeug("profil_vergessen");
    const archiv = join(temp, "data", "profil-archiv.jsonl");
    profil.chronik = [
      { monat: "2026-05", text: "Mai-Text", entscheidungen: 1 },
      { monat: "2026-06", text: "Kündigung beschlossen.", entscheidungen: 1 },
    ];
    const lauf = {
      datum: "2026-10-01",
      fakten: [{ id: 2, text: "bleibt", seit: "2026-01-01", quelle: "chat", ersetztDurch: 9 }],
      entscheidungen: [
        { id: 5, datum: "2026-06-03T09:00:00.000Z", text: "Kündigung" },
        { id: 6, datum: "2026-05-04T09:00:00.000Z", text: "Mai bleibt" },
      ],
      chronik: [
        { monat: "2026-06", text: "Kündigung beschlossen.", entscheidungen: 1 },
        { monat: "2026-05", text: "Mai-Text", entscheidungen: 1 },
      ],
    };
    try {
      writeFileSync(archiv, `${JSON.stringify(lauf)}\n{ kaputt\n`, { mode: 0o600 });
      assert.equal(await t.run({ art: "chronik", text: "2026-06" }, ctx), "Vergessen.");
      const zeilen = readFileSync(archiv, "utf8").split("\n");
      assert.equal(zeilen[1], "{ kaputt");
      const neu = JSON.parse(zeilen[0]!) as typeof lauf;
      assert.deepEqual(neu.entscheidungen.map((e) => e.id), [6]);
      assert.deepEqual(neu.chronik.map((c) => c.monat), ["2026-05"]);
      assert.deepEqual(neu.fakten, lauf.fakten);
      assert.ok(!readFileSync(archiv, "utf8").includes("Kündigung"));
      assert.equal(statSync(archiv).mode & 0o777, 0o600);
      assert.deepEqual(profil.chronik.map((c) => c.monat), ["2026-05"]);
    } finally {
      rmSync(archiv, { force: true });
    }
  });

  it("profil_anzeigen: alle Chronik-Monate, auch ältere als die letzten drei im Prompt", () => {
    profil.chronik = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"].map((monat, i) => ({ monat, text: `Text ${monat}`, entscheidungen: i + 1 }));
    assert.ok(!profilFuerPrompt().includes("Text 2026-01"));
    const text = profilFuerAnzeige();
    assert.ok(text.includes("Chronik (alle Monate, zum Vergessen per Monat):\n2026-01 (1 Entscheidung): Text 2026-01\n2026-02 (2 Entscheidungen): Text 2026-02"), text);
    assert.ok(text.includes("2026-05 (5 Entscheidungen): Text 2026-05"), text);
    assert.ok(!text.includes("(1 Entscheidungen)"), text);
    profil.chronik = [];
    assert.ok(!profilFuerAnzeige().includes("Chronik (alle Monate"));
  });

  it("profil_vergessen: verschobene Entscheidung → Hinweis auf den Chronik-Monat, nichts gelöscht", async () => {
    const t = werkzeug("profil_vergessen");
    const archiv = join(temp, "data", "profil-archiv.jsonl");
    profil.entscheidungen = [{ id: 9, datum: "2026-09-20T10:00:00.000Z", text: "Neu" }];
    profil.chronik = [{ monat: "2026-06", text: "Kündigung beschlossen.", entscheidungen: 1 }];
    try {
      writeFileSync(
        archiv,
        `${JSON.stringify({ datum: "2026-10-01", entscheidungen: [{ id: 5, datum: "2026-06-03T09:00:00.000Z", text: "Kündigung" }], chronik: [] })}\n{ kaputt\n`,
        { mode: 0o600 },
      );
      await assert.rejects(t.run({ art: "entscheidung", id: 5 }, ctx), /Liegt in der Chronik 2026-06; mit art chronik vergessen/);
      assert.equal(profil.chronik.length, 1);
      assert.equal(profil.entscheidungen.length, 1);
      // ohne Chronik-Monat (schon vergessen) oder ohne Archiv: schlicht nicht gefunden
      profil.chronik = [];
      await assert.rejects(t.run({ art: "entscheidung", id: 5 }, ctx), (e: Error) => e.message === "Nicht gefunden.");
      rmSync(archiv);
      await assert.rejects(t.run({ art: "entscheidung", id: 5 }, ctx), (e: Error) => e.message === "Nicht gefunden.");
      // vorhandene Entscheidungen weiterhin per id löschbar
      assert.equal(await t.run({ art: "entscheidung", id: 9 }, ctx), "Vergessen.");
      assert.deepEqual(profil.entscheidungen, []);
    } finally {
      rmSync(archiv, { force: true });
    }
  });

  it("nach Zusammenführen und Vergessen des Ersatzes: keine id kommt wieder (weder Ersatz noch Archiv-Original)", async () => {
    const merken = werkzeug("fakt_merken");
    const vergessen = werkzeug("profil_vergessen");
    const basis = neueFaktId() - 1;
    profil.fakten = Array.from({ length: 6 }, (_, i) => ({ id: basis + i + 1, text: `F${i + 1}`, seit: "2026-01-01", quelle: "chat" as const }));
    saveProfil();
    // wie wendeAn + Object.assign: #5 und #6 → Ersatz #7, die Originale liegen im Archiv
    const [o5, o6] = [basis + 5, basis + 6];
    const ersatz = basis + 7;
    const neu = structuredClone(profil);
    neu.fakten = [...neu.fakten.filter((f) => f.id !== o5 && f.id !== o6), { id: ersatz, text: "F5 und F6", seit: "2026-01-01", quelle: "verdichtung" }];
    Object.assign(profil, neu);
    saveProfil();
    assert.equal(profil.faktIdMax, ersatz);
    // Ersatz und zwei weitere vergessen: die höchste vorhandene id fällt auf basis + 3
    for (const id of [ersatz, basis + 4, basis + 3]) assert.equal(await vergessen.run({ art: "fakt", id }, ctx), "Vergessen.");
    assert.equal(Math.max(...profil.fakten.map((f) => f.id)), basis + 2);
    const antwort = await merken.run({ text: "Fährt Velo" }, ctx);
    assert.equal(antwort, `Fakt #${ersatz + 1} gemerkt.`);
    for (const alt of [o5, o6, ersatz, basis + 3, basis + 4]) assert.ok(!antwort.includes(`#${alt} `), antwort);
    // auch über einen Neustart hinweg (Feld in der Datei)
    const geladen = (await import(new URL("../src/profil.js?faktidmax=1", import.meta.url).href)) as typeof import("../src/profil.js");
    assert.equal(geladen.profil.faktIdMax, ersatz + 1);
    assert.equal(geladen.neueFaktId(), ersatz + 2);
  });

  it("auch wenn das Feld beim Ersetzen fehlt, bleibt der Fakt-Höchstwert im Speicher", () => {
    const vorher = neueFaktId();
    profil.fakten = [{ id: 1, text: "Wohnt in Muttenz", seit: "2026-03-12", quelle: "import" }];
    delete profil.faktIdMax;
    assert.equal(neueFaktId(), vorher);
    saveProfil();
    assert.equal((JSON.parse(readFileSync(PROFIL, "utf8")) as { faktIdMax?: number }).faktIdMax, vorher - 1);
  });

  it("Laden: Fakt-Höchstwert bleibt, wird an die Liste angeglichen, Unsinn verworfen; hoechsteFaktId", () => {
    assert.equal(normalisiereProfil({ fakten: [], faktIdMax: 7 }).faktIdMax, 7);
    assert.equal(normalisiereProfil({ fakten: [{ id: 9, text: "x" }], faktIdMax: 7 }).faktIdMax, 9);
    assert.equal(normalisiereProfil({ fakten: ["a", "b"] }).faktIdMax, 2);
    // neu nummerierte Fakten (Altbestand, doppelte id) beginnen über dem festgehaltenen Höchstwert
    const p = normalisiereProfil({ fakten: ["a", { id: 2, text: "b" }, { id: 2, text: "c" }], faktIdMax: 7 });
    assert.deepEqual(p.fakten.map((f) => f.id), [8, 2, 9]);
    assert.equal(p.faktIdMax, 9);
    for (const unsinn of [-1, 1.5, "x", null]) assert.ok(!("faktIdMax" in normalisiereProfil({ faktIdMax: unsinn })), String(unsinn));
    assert.equal(hoechsteFaktId({ fakten: [{ id: 3, text: "x", seit: "2026-01-01", quelle: "chat" }], faktIdMax: 8 }), 8);
    assert.equal(hoechsteFaktId({ fakten: [{ id: 3, text: "x", seit: "2026-01-01", quelle: "chat" }] }), 3);
    assert.equal(hoechsteFaktId({ fakten: [] }), 0);
  });

  it("gleicherText: Gross/Klein, Leerraum, Schlusspunkt", () => {
    assert.ok(gleicherText("Wohnt  in Muttenz.", "wohnt in muttenz"));
    assert.ok(!gleicherText("Wohnt in Muttenz", "Wohnt in Basel"));
  });
});
