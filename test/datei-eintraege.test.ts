import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

// ladeListe mit Eintragsprüfung (datei.ts): ungültige Einträge fallen weg, die Datei wird einmal gesichert, das Log
// nennt nur die Anzahl, und die gültigen Einträge laufen weiter. Alles in einem eigenen Temp-Ordner.
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-datei-eintraege-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

const d = await import("../src/datei.js");

type Eintrag = { id: number; text: string };
/** Einfache Prüfung für die Tests: id ganzzahlig > 0, text als Text */
const pruefe = (roh: unknown): Eintrag | undefined => {
  if (roh === null || typeof roh !== "object" || Array.isArray(roh)) return undefined;
  const e = roh as Record<string, unknown>;
  return Number.isSafeInteger(e.id) && (e.id as number) > 0 && typeof e.text === "string" ? (roh as Eintrag) : undefined;
};

const DATEI = "data/liste.json";
const GUELTIG = { id: 1, text: "geheim-gueltig" };

let fehler: string[] = [];
const origErr = console.error;
beforeEach(() => {
  rmSync(join(temp, "data"), { recursive: true, force: true });
  mkdirSync(join(temp, "data"), { recursive: true });
  fehler = [];
  console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
});
afterEach(() => { console.error = origErr; });

const schreibe = (inhalt: unknown): string => {
  const text = JSON.stringify(inhalt);
  writeFileSync(join(temp, DATEI), text);
  return text;
};
const sicherungen = (): string[] => readdirSync(join(temp, "data")).filter((n) => n.startsWith("liste.json.defekt")).sort();

describe("ladeListe mit Eintragsprüfung", () => {
  const faelle: Record<string, unknown> = {
    null: null,
    Zahl: 42,
    Text: "geheim-text",
    Liste: ["geheim"],
    "fehlendes Feld": { id: 2 },
    "falscher Typ": { id: 3, text: 7 },
    "id als Text": { id: "4", text: "geheim-x" },
    "id 0": { id: 0, text: "geheim-y" },
  };
  for (const [titel, eintrag] of Object.entries(faelle)) {
    it(`${titel}: übersprungen, gültiger Eintrag bleibt, Sicherung (600), Log nur mit Anzahl`, () => {
      const inhalt = schreibe([GUELTIG, eintrag]);
      const g = d.ladeListe(DATEI, "Testliste", pruefe);
      assert.equal(g.nichtGeladen, false);
      assert.equal(g.verworfen, 1);
      assert.deepEqual(g.liste, [GUELTIG]);
      assert.deepEqual(sicherungen(), ["liste.json.defekt"]);
      assert.equal(readFileSync(join(temp, DATEI + ".defekt"), "utf8"), inhalt);
      assert.equal(statSync(join(temp, DATEI + ".defekt")).mode & 0o777, 0o600);
      assert.deepEqual(fehler, [`Testliste: 1 ungültiger Eintrag übersprungen (Sicherung unter ${DATEI}.defekt). Die übrigen 1 sind geladen; beim nächsten Speichern fehlen die übersprungenen in ${DATEI}.`]);
      assert.equal(readFileSync(join(temp, DATEI), "utf8"), inhalt, "beim Laden bleibt die Datei unverändert");
    });
  }

  it("gemischte Liste: Reihenfolge der gültigen bleibt, Anzahl stimmt, kein Inhalt im Log oder Hinweis", () => {
    const b = { id: 2, text: "geheim-b" };
    const c = { id: 3, text: "geheim-c" };
    schreibe([null, GUELTIG, 5, "geheim-text", b, { id: 9 }, [], c, { text: "geheim-ohne-id" }]);
    const g = d.ladeListe(DATEI, "Testliste", pruefe);
    assert.deepEqual(g.liste, [GUELTIG, b, c]);
    assert.equal(g.verworfen, 6);
    assert.equal(g.nichtGeladen, false);
    assert.equal(fehler.length, 1);
    assert.match(fehler[0]!, /^Testliste: 6 ungültige Einträge übersprungen/);
    const hinweis = d.eintragsHinweise().find((h) => h.includes(DATEI));
    assert.equal(hinweis, `⚠️ ${DATEI}: 6 ungültige Einträge beim Start übersprungen, Sir (Sicherung unter ${DATEI}.defekt). Die übrigen laufen normal; speichere ich die Liste, fehlen die übersprungenen danach auch in der Datei.`);
    assert.equal(d.uebersprungenAnzahl(DATEI), 6);
    for (const t of [...fehler, ...d.eintragsHinweise()]) assert.doesNotMatch(t, /geheim/);
  });

  it("Sicherung genau einmal: ein zweiter Start mit unveränderter Datei legt keine weitere an, eine geänderte schon", () => {
    const inhalt = schreibe([GUELTIG, null]);
    d.ladeListe(DATEI, "Testliste", pruefe);
    d.ladeListe(DATEI, "Testliste", pruefe);
    assert.deepEqual(sicherungen(), ["liste.json.defekt"]);
    assert.ok(fehler.every((f) => f.includes(`Sicherung unter ${DATEI}.defekt)`)), fehler.join("\n"));
    // Neuer Handeingriff: andere ungültige Einträge → neue Sicherung mit Zeitstempel, die alte bleibt
    const neu = schreibe([GUELTIG, 7]);
    d.ladeListe(DATEI, "Testliste", pruefe);
    const liste = sicherungen();
    assert.equal(liste.length, 2);
    assert.equal(readFileSync(join(temp, "data", liste[0]!), "utf8"), inhalt);
    assert.equal(readFileSync(join(temp, "data", liste[1]!), "utf8"), neu);
    // Und wieder unverändert: die passende (zweite) Sicherung gilt, keine dritte
    fehler = [];
    d.ladeListe(DATEI, "Testliste", pruefe);
    assert.equal(sicherungen().length, 2);
    assert.ok(fehler[0]!.includes(`Sicherung unter data/${liste[1]}`), fehler[0]);
  });

  it("Speichern danach behält die gültigen Einträge; die Sicherung bewahrt die verworfenen", () => {
    const inhalt = schreibe([GUELTIG, null, { id: 2, text: "zwei" }, "x"]);
    const g = d.ladeListe(DATEI, "Testliste", pruefe);
    assert.equal(g.nichtGeladen, false, "Speichern bleibt erlaubt");
    g.liste.push({ id: 3, text: "neu" });
    writeFileSync(join(temp, DATEI), JSON.stringify(g.liste));
    assert.deepEqual(JSON.parse(readFileSync(join(temp, DATEI), "utf8")), [GUELTIG, { id: 2, text: "zwei" }, { id: 3, text: "neu" }]);
    assert.equal(readFileSync(join(temp, DATEI + ".defekt"), "utf8"), inhalt);
    // Nächster Start: alles gültig, kein Hinweis mehr, keine weitere Sicherung
    fehler = [];
    const wieder = d.ladeListe(DATEI, "Testliste", pruefe);
    assert.equal(wieder.verworfen, 0);
    assert.equal(fehler.length, 0);
    assert.equal(d.uebersprungenAnzahl(DATEI), 0);
    assert.ok(!d.eintragsHinweise().some((h) => h.includes(DATEI)));
    assert.deepEqual(sicherungen(), ["liste.json.defekt"]);
  });

  it("nur gültige Einträge: keine Sicherung, kein Log, kein Hinweis", () => {
    schreibe([GUELTIG, { id: 2, text: "" }]);
    const g = d.ladeListe(DATEI, "Testliste", pruefe);
    assert.equal(g.verworfen, 0);
    assert.equal(g.liste.length, 2);
    assert.deepEqual(sicherungen(), []);
    assert.deepEqual(fehler, []);
  });

  it("eine werfende Prüfung zählt als ungültig, statt den Start abzubrechen", () => {
    schreibe([GUELTIG, { id: 2, text: "boom" }]);
    const g = d.ladeListe(DATEI, "Testliste", (roh) => {
      if ((roh as Eintrag).text === "boom") throw new Error("geheim-fehler");
      return pruefe(roh);
    });
    assert.deepEqual(g.liste, [GUELTIG]);
    assert.equal(g.verworfen, 1);
    assert.ok(!fehler.some((f) => f.includes("geheim")));
  });

  it("ganze Datei unlesbar: wie bisher (nichtGeladen, Sicherung, Liste leer), auch mit Prüfung", () => {
    writeFileSync(join(temp, DATEI), '[{"id": 1, "text": "geheim-abgeschnitten"');
    const g = d.ladeListe(DATEI, "Testliste", pruefe);
    assert.equal(g.nichtGeladen, true);
    assert.deepEqual(g.liste, []);
    assert.ok(existsSync(join(temp, DATEI + ".defekt")));
    assert.ok(fehler.some((f) => f.startsWith("Testliste unlesbar – Kopie unter")));
    assert.ok(!fehler.some((f) => f.includes("geheim")));
    // Keine Liste ebenso
    writeFileSync(join(temp, DATEI), '{"id": 1}');
    assert.equal(d.ladeListe(DATEI, "Testliste", pruefe).nichtGeladen, true);
  });

  it("fehlende Datei: leer, ohne Sperre, ohne Sicherung", () => {
    const g = d.ladeListe(DATEI, "Testliste", pruefe);
    assert.deepEqual(g, { liste: [], nichtGeladen: false, verworfen: 0 });
    assert.deepEqual(fehler, []);
  });

  it("ohne Prüfung: wie bisher, jede Liste wird übernommen", () => {
    schreibe([null, 5]);
    const g = d.ladeListe<unknown>(DATEI, "Testliste");
    assert.deepEqual(g.liste, [null, 5]);
    assert.equal(g.verworfen, 0);
    assert.deepEqual(sicherungen(), []);
  });

  it("scheitert die Sicherung, gilt die Datei wie eine unlesbare: sonst verlöre das nächste Speichern die verworfenen", () => {
    // «data» ist hier eine Datei: sichereDefekt kann den Ordner nicht anlegen
    rmSync(join(temp, "data"), { recursive: true, force: true });
    writeFileSync(join(temp, "data"), "kein Ordner");
    try {
      writeFileSync(join(temp, "liste.json"), JSON.stringify([GUELTIG, null]));
      const g = d.ladeListe("liste.json", "Testliste", pruefe);
      assert.equal(g.nichtGeladen, true);
      assert.deepEqual(g.liste, []);
      assert.equal(g.verworfen, 1);
      assert.ok(fehler.some((f) => f.startsWith("Testliste unlesbar (1 ungültiger Eintrag, Sicherung fehlgeschlagen)")), fehler.join("\n"));
      assert.ok(!d.eintragsHinweise().some((h) => h.includes("liste.json:")), "kein Hinweis «übrige laufen normal»");
      assert.ok(!existsSync(join(temp, "liste.json.defekt")));
    } finally {
      rmSync(join(temp, "data"), { force: true });
      rmSync(join(temp, "liste.json"), { force: true });
    }
  });
});

describe("untersucheListe (npm run check): nur lesen", () => {
  it("zählt gültige und ungültige Einträge, ohne Sicherung, ohne Log", () => {
    schreibe([GUELTIG, null, { id: 2 }]);
    assert.deepEqual(d.untersucheListe(DATEI, pruefe), { zustand: "ok", eintraege: 1, verworfen: 2 });
    assert.deepEqual(sicherungen(), []);
    assert.deepEqual(fehler, []);
  });

  it("fehlt bzw. unlesbar", () => {
    assert.deepEqual(d.untersucheListe(DATEI, pruefe), { zustand: "fehlt", eintraege: 0, verworfen: 0 });
    writeFileSync(join(temp, DATEI), "[");
    assert.deepEqual(d.untersucheListe(DATEI, pruefe), { zustand: "unlesbar", eintraege: 0, verworfen: 0 });
    assert.deepEqual(sicherungen(), []);
  });
});

describe("Eintragsprüfungen der Listen", () => {
  it("Zeitplan: id ganzzahlig > 0, name/zeit/tage/auftrag als Text; ungültige Werte mit richtigem Typ bleiben", () => {
    const z = { id: 1, name: "n", zeit: "07:00", tage: "mo", auftrag: "a" };
    assert.equal(d.zeitplanEintrag(z), z);
    assert.ok(d.zeitplanEintrag({ ...z, zeit: "25:00", tage: "montags", name: "", auftrag: " " }));
    for (const kaputt of [null, 1, "x", [], { ...z, id: 0 }, { ...z, id: 1.5 }, { ...z, id: "1" }, { ...z, name: undefined }, { ...z, zeit: 700 }, { ...z, tage: null }, { ...z, auftrag: {} }]) {
      assert.equal(d.zeitplanEintrag(kaputt), undefined, JSON.stringify(kaputt));
    }
  });

  it("Wache: id, kamera und frage als Text, alle_minuten als Zahl (Ziffernfolge wird Zahl); nur_wenn/ruhe_minuten frei", () => {
    const w = { id: 1, kamera: "hof", frage: "Tor?", alle_minuten: 5 };
    assert.equal(d.wacheEintrag(w), w);
    assert.deepEqual(d.wacheEintrag({ ...w, alle_minuten: " 15 " }), { ...w, alle_minuten: 15 });
    assert.ok(d.wacheEintrag({ ...w, alle_minuten: 0, frage: " ", kamera: "gibtsnicht", nur_wenn: "Nacht", ruhe_minuten: "oft" }));
    for (const kaputt of [null, 1, "x", [], { ...w, id: undefined }, { ...w, id: -1 }, { ...w, kamera: undefined }, { ...w, kamera: 5 }, { ...w, frage: undefined }, { ...w, frage: 7 }, { ...w, alle_minuten: undefined }, { ...w, alle_minuten: null }, { ...w, alle_minuten: "oft" }]) {
      assert.equal(d.wacheEintrag(kaputt), undefined, JSON.stringify(kaputt));
    }
    // In cameras.json: ohne id und kamera (die Kamera ist der Schlüssel)
    assert.ok(d.kameraWacheEintrag({ frage: "Tor?", alle_minuten: 5 }));
    assert.equal(d.kameraWacheEintrag({ frage: "Tor?" }), undefined);
    assert.equal(d.kameraWacheEintrag({ alle_minuten: 5 }), undefined);
  });

  it("Erinnerung: at als lesbarer Zeitpunkt, text als Text", () => {
    const e = { at: "2026-10-15T08:00:00.000Z", text: "Zahnarzt" };
    assert.equal(d.erinnerungEintrag(e), e);
    for (const kaputt of [null, "x", { at: "morgen", text: "t" }, { at: 5, text: "t" }, { at: e.at }, { at: e.at, text: 5 }]) {
      assert.equal(d.erinnerungEintrag(kaputt), undefined, JSON.stringify(kaputt));
    }
  });

  it("Vorgang: id, auftrag, startedAt, bekannter status, steps als Zahl", () => {
    const v = { id: 1, auftrag: "a", status: "fertig", startedAt: "2026-10-15T08:00:00.000Z", steps: 3 };
    assert.equal(d.vorgangEintrag(v), v);
    for (const kaputt of [null, 7, { ...v, id: "1" }, { ...v, auftrag: undefined }, { ...v, status: "kaputt" }, { ...v, startedAt: 5 }, { ...v, steps: "3" }, { ...v, steps: undefined }]) {
      assert.equal(d.vorgangEintrag(kaputt), undefined, JSON.stringify(kaputt));
    }
  });

  it("Postausgang: ts als lesbarer Zeitpunkt, text als Text; vorrang nur als true", () => {
    const p = { ts: "2026-10-15T08:00:00.000Z", text: "t" };
    assert.deepEqual(d.postausgangEintrag(p), p);
    assert.deepEqual(d.postausgangEintrag({ ...p, vorrang: true }), { ...p, vorrang: true });
    assert.deepEqual(d.postausgangEintrag({ ...p, vorrang: "ja", extra: 1 }), p);
    for (const kaputt of [null, "x", { ts: "gestern", text: "t" }, { ts: p.ts }, { ts: p.ts, text: null }]) {
      assert.equal(d.postausgangEintrag(kaputt), undefined, JSON.stringify(kaputt));
    }
  });

  it("LISTEN nennt jede Liste in data/ mit ihrer Prüfung", () => {
    assert.deepEqual(d.LISTEN.map((l) => [l.datei, l.pruefe]), [
      ["data/zeitplaene.json", d.zeitplanEintrag],
      ["data/wachen.json", d.wacheEintrag],
      ["data/erinnerungen.json", d.erinnerungEintrag],
      ["data/vorgaenge.json", d.vorgangEintrag],
      ["data/postausgang.json", d.postausgangEintrag],
    ]);
  });
});
