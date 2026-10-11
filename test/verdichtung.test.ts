import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/ liegt relativ) und Umgebung; nie echte Dienste
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-verdichtung-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.WATCHDOG_MINUTEN = "10";
process.env.ZEITPLAN_NACHHOLEN_MIN = "60";
process.env.VERDICHTUNG = "03:30";
process.env.VERDICHTUNG_TAGE = "90";

/** Nur die Telegram-Bot-API ist als Attrappe erreichbar (antwortet immer ok); alles andere wäre ein Fehler */
let telegram: { method: string; text?: string }[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (!url.startsWith("https://api.telegram.org/bot")) throw new Error(`unerwarteter Netzaufruf: ${url}`);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  telegram.push({ method: url.split("/").pop() ?? "", text: body.text });
  return new Response(JSON.stringify({ ok: true, result: { message_id: telegram.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

// Bestehende (leere) routinen.json: kein Erststart
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "routinen.json"), "{}");

const v = await import("../src/verdichtung.js");
const { profil, saveProfil } = await import("../src/profil.js");
type Profil = import("../src/profil.js").Profil;
type Vorschlag = import("../src/verdichtung.js").VerdichtungVorschlag;
const { abhaengigkeiten, verdichtungTick } = await import("../src/scheduler.js");
const { state } = await import("../src/state.js");
const { config } = await import("../src/config.js");
const { HttpFehler, gesundheit } = await import("../src/robust.js");
const tg = await import("../src/telegram.js");
const { anthropic } = await import("../src/claude.js");

const HEUTE = "2026-10-11";
const PROFIL = join(temp, "data", "profil.json");
const NOTIZEN = join(temp, "data", "notizen.md");
const ARCHIV = join(temp, "data", "profil-archiv.jsonl");
const ROUTINEN = join(temp, "data", "routinen.json");
const AUDIT = join(temp, "data", "audit.log");

function basis(): Profil {
  return {
    ziele: [{ id: 1, text: "Halbmarathon unter 2 h", status: "offen", angelegt: "2026-01-02T08:00:00.000Z" }],
    werte: ["Gesundheit vor Tempo"],
    muster: [{ id: 1, text: "Verschiebt grössere Anschaffungen", belege: ["Auto 2026-06", "Ferien 2026-05"], seit: "2026-06-21T20:00:00.000Z" }],
    entscheidungen: [
      { id: 1, datum: "2026-06-03T10:00:00.000Z", text: "Kein neues Auto", ausgang: "Velo reicht" },
      { id: 2, datum: "2026-06-20T18:00:00.000Z", text: "Erste-Hilfe-Kurs gebucht" },
      { id: 3, datum: "2026-05-10T09:00:00.000Z", text: "Ferien verschoben" },
      { id: 4, datum: "2026-07-20T09:00:00.000Z", text: "Neues Velo-Schloss" },
      { id: 5, datum: "2026-10-01T09:00:00.000Z", text: "Kamera Garage montiert" },
    ],
    fakten: [
      { id: 1, text: "Wohnt in Basel", seit: "2025-02-01", quelle: "import" },
      { id: 2, text: "Wohnt in Muttenz", seit: "2026-03-12", quelle: "chat" },
      { id: 3, text: "Trinkt Kaffee schwarz", seit: "2025-05-01", quelle: "import" },
      { id: 4, text: "Mag Kaffee ohne Zucker", seit: "2025-06-01", quelle: "chat" },
      { id: 5, text: "Fährt ein E-Bike", seit: "2026-01-05", quelle: "chat" },
      { id: 6, text: "Arbeitet als Service Specialist", seit: "2025-01-01", quelle: "import" },
    ],
    chronik: [],
  };
}

const NOTIZ_ZEILEN = [
  "- 2026-04 (verdichtet): Winterreifen montiert",
  "- 2026-05-03: Reifendruck 2.4 bar",
  "- 2026-05-20: Code Garage geändert",
  "Freitext ohne Datum",
  "- 2026-08-15: Velo-Service bei Müller",
  "- 2026-08-01: Lea Geburtstag am 3. März",
  "- 2026-09-05: Kamera Einfahrt neu ausgerichtet",
  "- 2026-10-02: Ganz neue Notiz",
];
const NOTIZEN_TEXT = `${NOTIZ_ZEILEN.join("\n")}\n`;

function gueltig(): Vorschlag {
  return {
    fakten: {
      zusammenfuehren: [{ ids: [3, 4], text: "Trinkt Kaffee schwarz, ohne Zucker" }],
      veraltet: [{ id: 1, grund: "widerspricht #2 vom 2026-03-12" }],
    },
    notizen: {
      behalten: [],
      verdichtet: [
        { monat: "2026-05", text: "Reifendruck 2.4 bar; Garagencode geändert" },
        { monat: "2026-08", text: "Velo-Service bei Müller; Lea hat am 3. März Geburtstag" },
      ],
    },
    chronik: [
      { monat: "2026-06", text: "Auf ein neues Auto verzichtet (Velo reicht), Erste-Hilfe-Kurs gebucht.", entscheidungen: 2 },
      { monat: "2026-05", text: "Ferien verschoben.", entscheidungen: 1 },
    ],
  };
}

/** Profil im Speicher (dasselbe Objekt, das alle Module halten) auf einen Stand setzen */
function setzeProfil(p: Profil): void {
  for (const k of Object.keys(profil)) delete (profil as unknown as Record<string, unknown>)[k];
  Object.assign(profil, structuredClone(p));
}

// ---------- baueEingabe ----------

describe("baueEingabe", () => {
  it("Notizen: nur ganze Monate älter als 30 Tage, älteste zuerst; verdichtete und undatierte Zeilen bleiben draussen", () => {
    const e = v.baueEingabe(basis(), NOTIZEN_TEXT, HEUTE, 90);
    assert.deepEqual(e.notizen, ["- 2026-05-03: Reifendruck 2.4 bar", "- 2026-05-20: Code Garage geändert", "- 2026-08-01: Lea Geburtstag am 3. März", "- 2026-08-15: Velo-Service bei Müller"]);
    // 2026-09-05 ist zwar älter als 30 Tage, aber der September ist noch nicht ganz vorbei
    assert.ok(!e.notizen.some((z) => z.includes("2026-09")));
  });

  it("Entscheidungen: nur ganze Monate älter als `tage`, nach Datum", () => {
    assert.deepEqual(v.baueEingabe(basis(), "", HEUTE, 90).entscheidungenAlt.map((x) => x.id), [3, 1, 2]);
    // 30 Tage: Juli und August gelten auch als alt
    assert.deepEqual(v.baueEingabe(basis(), "", HEUTE, 30).entscheidungenAlt.map((x) => x.id), [3, 1, 2, 4]);
    // 400 Tage: noch nichts
    assert.deepEqual(v.baueEingabe(basis(), "", HEUTE, 400).entscheidungenAlt, []);
  });

  it("Fakten: alle aktuellen, ohne veraltete; nur wenn mindestens zwei und seit der letzten Verdichtung einer dazukam", () => {
    const p = basis();
    p.fakten[4]!.veraltet = { seit: "2026-09-01", grund: "verkauft" };
    assert.deepEqual(v.baueEingabe(p, "", HEUTE, 90).fakten.map((f) => f.id), [6, 1, 3, 4, 2]);
    p.letzteVerdichtung = "2026-10-01";
    assert.deepEqual(v.baueEingabe(p, "", HEUTE, 90).fakten, [], "nichts Neues seit der letzten Verdichtung");
    p.fakten.push({ id: 7, text: "Hat eine Tochter namens Lea", seit: "2026-10-05", quelle: "chat" });
    assert.equal(v.baueEingabe(p, "", HEUTE, 90).fakten.length, 6);
    const einer = basis();
    einer.fakten = [einer.fakten[0]!];
    assert.deepEqual(v.baueEingabe(einer, "", HEUTE, 90).fakten, [], "ein einzelner Fakt: nichts zusammenzuführen");
  });

  it("Muster nur als Kontext, und nur wenn es etwas zu tun gibt; leere Eingabe erkannt", () => {
    const p = basis();
    assert.deepEqual(v.baueEingabe(p, NOTIZEN_TEXT, HEUTE, 90).muster.map((m) => m.id), [1]);
    p.fakten = [];
    p.entscheidungen = [];
    const leer = v.baueEingabe(p, "- 2026-10-01: neu\n", HEUTE, 90);
    assert.ok(v.istLeer(leer));
    assert.deepEqual(leer.muster, []);
    assert.ok(!v.istLeer(v.baueEingabe(basis(), "", HEUTE, 90)));
  });

  it("Begrenzung auf ~24 000 Zeichen: älteste Notizen zuerst, der Rest bleibt für die nächste Nacht", () => {
    const zeilen: string[] = [];
    for (let i = 0; i < 400; i++) {
      const tag = String((i % 28) + 1).padStart(2, "0");
      const monat = String(1 + Math.floor(i / 70)).padStart(2, "0"); // Januar bis Juni
      zeilen.push(`- 2026-${monat}-${tag}: Notiz ${i} ${"x".repeat(80)}`);
    }
    const p = basis();
    p.fakten = [];
    p.entscheidungen = [];
    const e = v.baueEingabe(p, [...zeilen].reverse().join("\n"), HEUTE, 90);
    const summe = e.notizen.reduce((s, z) => s + z.length + 1, 0);
    assert.ok(summe <= v.EINGABE_MAX_ZEICHEN, `${summe}`);
    assert.ok(e.notizen.length > 100 && e.notizen.length < 400, `${e.notizen.length}`);
    const sortiert = [...zeilen].sort((a, b) => a.slice(2, 12).localeCompare(b.slice(2, 12)));
    assert.equal(e.notizen[0]!.slice(2, 12), sortiert[0]!.slice(2, 12));
    assert.ok(e.notizen.every((z, i) => i === 0 || z.slice(2, 12) >= e.notizen[i - 1]!.slice(2, 12)), "älteste zuerst");
    // Gesamte Nachricht ans Modell bleibt in der Grössenordnung der Grenze
    assert.ok(v.eingabeText(e).length < v.EINGABE_MAX_ZEICHEN + 2000);
  });

  it("Begrenzung bei vielen Fakten: die neuesten gehen mit, in der Eingabe wieder älteste zuerst", () => {
    const p = basis();
    p.fakten = [];
    for (let i = 1; i <= 80; i++) {
      const tag = `2025-${String(1 + Math.floor((i - 1) / 28)).padStart(2, "0")}-${String(((i - 1) % 28) + 1).padStart(2, "0")}`;
      p.fakten.push({ id: i, text: `Fakt ${i} ${"y".repeat(180)}`, seit: tag, quelle: "chat" });
    }
    p.fakten.push({ id: 81, text: "Wohnt jetzt in Basel", seit: "2026-10-05", quelle: "chat" });
    p.letzteVerdichtung = "2026-10-01";
    const e = v.baueEingabe(p, "", HEUTE, 90);
    const summe = e.fakten.reduce((s, f) => s + JSON.stringify({ id: f.id, seit: f.seit, text: f.text }).length + 1, 0);
    assert.ok(summe <= v.EINGABE_MAX_ZEICHEN / 2, `${summe}`);
    assert.ok(e.fakten.length > 10 && e.fakten.length < 81, `${e.fakten.length}`);
    assert.equal(e.fakten.at(-1)?.id, 81, "der neueste Fakt steht in der Eingabe");
    assert.ok(!e.fakten.some((f) => f.id === 1), "die ältesten fallen weg");
    assert.ok(e.fakten.every((f, i) => i === 0 || f.seit >= e.fakten[i - 1]!.seit), "älteste zuerst");
    // lückenlos: die neuesten n
    const ids = e.fakten.map((f) => f.id);
    assert.deepEqual(ids, Array.from({ length: ids.length }, (_, i) => 81 - ids.length + 1 + i));
  });

  it("Fakten erst ab vier: bei zwei oder drei ist keine Zusammenführung zulässig; Notizen und Entscheidungen gehen trotzdem mit", () => {
    for (const n of [2, 3]) {
      const p = basis();
      p.fakten = p.fakten.slice(0, n);
      const e = v.baueEingabe(p, NOTIZEN_TEXT, HEUTE, 90);
      assert.deepEqual(e.fakten, [], `${n} Fakten`);
      assert.equal(e.notizen.length, 4, `${n} Fakten: Notizen`);
      assert.deepEqual(e.entscheidungenAlt.map((x) => x.id), [3, 1, 2], `${n} Fakten: Entscheidungen`);
      assert.ok(v.eingabeText(e).includes("(keine – nichts zusammenführen oder markieren)"));
    }
    const vier = basis();
    vier.fakten = vier.fakten.slice(0, 4);
    const e = v.baueEingabe(vier, "", HEUTE, 90);
    assert.deepEqual(e.fakten.map((f) => f.id), [1, 3, 4, 2]);
    // Zusammenführung von zwei aus vier ist zulässig (genau die Hälfte)
    const x: Vorschlag = { fakten: { zusammenfuehren: [{ ids: [3, 4], text: "Trinkt Kaffee schwarz, ohne Zucker" }], veraltet: [] }, notizen: { behalten: [], verdichtet: [] }, chronik: [] };
    assert.deepEqual(v.pruefeVorschlag(x, e), []);
  });

  it("Eingabe nennt die erlaubte Höchstzahl an Fakt-ids", () => {
    const e = v.baueEingabe(basis(), "", HEUTE, 90);
    assert.equal(e.fakten.length, 6);
    assert.match(v.eingabeText(e), /höchstens 3 ids insgesamt anfassen/);
  });

  it("höchstens sechs Monate Notizen und sechs Monate Entscheidungen pro Lauf, älteste zuerst; der Rest folgt", () => {
    const p = basis();
    p.fakten = [];
    p.entscheidungen = [];
    const zeilen: string[] = [];
    // 2024-01 bis 2025-12: 24 Monate kurze Notizen und Entscheidungen, weit unter der Zeichengrenze
    for (let m = 0; m < 24; m++) {
      const monat = `${2024 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`;
      zeilen.push(`- ${monat}-10: Notiz ${m}`, `- ${monat}-20: Notiz ${m}b`);
      p.entscheidungen.push({ id: m + 1, datum: `${monat}-15T10:00:00.000Z`, text: `Entscheidung ${m}` });
    }
    const e = v.baueEingabe(p, [...zeilen].reverse().join("\n"), HEUTE, 90);
    const monate = (l: string[]) => [...new Set(l)];
    assert.deepEqual(monate(e.notizen.map((z) => z.slice(2, 9))), ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05", "2024-06"]);
    assert.equal(e.notizen.length, 12, "ganze Monate");
    assert.deepEqual(monate(e.entscheidungenAlt.map((x) => String(x.datum).slice(0, 7))), ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05", "2024-06"]);
    assert.equal(v.MONATE_MAX, 6);
    // Vorschlag mit voller Länge je Monat bleibt deutlich unter max_tokens (grob 3 Zeichen je Token)
    assert.ok(v.MONATE_MAX * (600 + 800) < v.ANTWORT_MAX_TOKENS * 3);
  });
});

// ---------- parseVorschlag ----------

describe("parseVorschlag", () => {
  it("reines JSON und JSON im ```json-Zaun mit Text drumherum", () => {
    const g = gueltig();
    const roh = JSON.stringify({ fakten: g.fakten, notizen: { verdichtet: g.notizen.verdichtet }, chronik: g.chronik });
    assert.deepEqual(v.parseVorschlag(roh), g);
    assert.deepEqual(v.parseVorschlag(`Hier mein Vorschlag:\n\`\`\`json\n${roh}\n\`\`\`\nGern geschehen.`), g);
    assert.deepEqual(v.parseVorschlag(`Vorschlag: ${roh} – Ende`), g);
  });

  it("fehlende Abschnitte gelten als leer, unbekannte Felder fallen weg", () => {
    assert.deepEqual(v.parseVorschlag('{"chronik":[{"monat":"2026-06","text":"x","extra":1}],"quatsch":true}'), {
      fakten: { zusammenfuehren: [], veraltet: [] },
      notizen: { behalten: [], verdichtet: [] },
      chronik: [{ monat: "2026-06", text: "x", entscheidungen: 0 }],
    });
  });

  it("Formfehler werfen", () => {
    const faelle = [
      "Kein JSON hier",
      "{ kaputt: ",
      "[1, 2]",
      '{"fakten":[]}',
      '{"fakten":{"zusammenfuehren":{}}}',
      '{"fakten":{"zusammenfuehren":[{"ids":["1",2],"text":"x"}]}}',
      '{"fakten":{"zusammenfuehren":[{"ids":[1.5,2],"text":"x"}]}}',
      '{"fakten":{"zusammenfuehren":[{"ids":[1,2]}]}}',
      '{"fakten":{"veraltet":[{"id":1,"grund":5}]}}',
      '{"notizen":{"verdichtet":[{"monat":2026,"text":"x"}]}}',
      '{"notizen":{"behalten":[1]}}',
      '{"chronik":["x"]}',
      '{"chronik":[{"monat":"2026-06","text":"x","entscheidungen":"2"}]}',
    ];
    for (const f of faelle) assert.throws(() => v.parseVorschlag(f), /Formfehler/, f);
  });
});

// ---------- pruefeVorschlag ----------

describe("pruefeVorschlag", () => {
  const e = v.baueEingabe(basis(), NOTIZEN_TEXT, HEUTE, 90);
  const mit = (aendern: (x: Vorschlag) => void): string[] => {
    const x = gueltig();
    aendern(x);
    return v.pruefeVorschlag(x, e);
  };

  it("gültiger und leerer Vorschlag: keine Verstösse", () => {
    assert.deepEqual(v.pruefeVorschlag(gueltig(), e), []);
    assert.deepEqual(v.pruefeVorschlag(v.parseVorschlag("{}"), e), []);
  });

  it("unbekannte ids", () => {
    assert.deepEqual(mit((x) => (x.fakten.zusammenfuehren[0]!.ids = [3, 99])), ["unbekannte Fakt-id 99"]);
    assert.deepEqual(mit((x) => (x.fakten.veraltet[0]!.id = 42)), ["unbekannte Fakt-id 42"]);
  });

  it("id in mehreren Gruppen (auch zusammenführen und veraltet zugleich)", () => {
    assert.deepEqual(mit((x) => x.fakten.veraltet.push({ id: 3, grund: "widerspricht #4" })), ["Fakt-id 3 mehrfach verwendet"]);
    assert.deepEqual(mit((x) => (x.fakten.zusammenfuehren[0]!.ids = [3, 3])), ["Zusammenführung 1: weniger als zwei Fakten", "Fakt-id 3 mehrfach verwendet"]);
  });

  it("Gruppe mit nur einem Fakt (Umformulieren ist kein Zusammenführen)", () => {
    assert.deepEqual(mit((x) => (x.fakten.zusammenfuehren[0]!.ids = [3])), ["Zusammenführung 1: weniger als zwei Fakten"]);
  });

  it("leerer oder zu langer Text", () => {
    assert.deepEqual(mit((x) => (x.fakten.zusammenfuehren[0]!.text = "  ")), ["Zusammenführung 1: leerer Text"]);
    assert.deepEqual(mit((x) => (x.fakten.zusammenfuehren[0]!.text = "x".repeat(201))), ["Zusammenführung 1: Text zu lang (201 > 200 Zeichen)"]);
    assert.deepEqual(mit((x) => (x.fakten.veraltet[0]!.grund = "")), ["Veraltet #1 (Grund): leerer Text"]);
    assert.deepEqual(mit((x) => (x.chronik[0]!.text = "")), ["Chronik 2026-06: leerer Text"]);
    assert.deepEqual(mit((x) => (x.notizen.verdichtet[0]!.text = "y".repeat(601))), ["Notiz 2026-05: Text zu lang (601 > 600 Zeichen)"]);
  });

  it("mehr als die Hälfte der Fakten in einem Lauf (genau die Hälfte ist erlaubt)", () => {
    // gültig: 3 von 6
    assert.deepEqual(mit(() => {}), []);
    assert.deepEqual(mit((x) => x.fakten.zusammenfuehren.push({ ids: [5, 6], text: "zu viel" })), ["zu viele Fakten auf einmal: 5 von 6 (höchstens die Hälfte)"]);
    // ohne Fakten in der Eingabe ist jede Fakt-Änderung zu viel
    const ohneFakten = { ...e, fakten: [] };
    assert.deepEqual(v.pruefeVorschlag({ ...v.parseVorschlag("{}"), fakten: { zusammenfuehren: [], veraltet: [{ id: 1, grund: "x" }] } }, ohneFakten), [
      "unbekannte Fakt-id 1",
      "zu viele Fakten auf einmal: 1 von 0 (höchstens die Hälfte)",
    ]);
  });

  it("Chronik-Monat ohne passende Entscheidungen, falsche Form, doppelt", () => {
    assert.deepEqual(mit((x) => x.chronik.push({ monat: "2026-07", text: "zu neu", entscheidungen: 1 })), ["Chronik-Monat 2026-07 ohne passende Entscheidungen"]);
    assert.deepEqual(mit((x) => (x.chronik[0]!.monat = "Juni")), ["Chronik-Monat «Juni» hat nicht die Form YYYY-MM"]);
    assert.deepEqual(mit((x) => x.chronik.push({ monat: "2026-06", text: "nochmals", entscheidungen: 2 })), ["Chronik-Monat 2026-06 doppelt"]);
  });

  it("verdichtete Notiz mit Monat, der in den Eingabezeilen nicht vorkommt", () => {
    assert.deepEqual(mit((x) => x.notizen.verdichtet.push({ monat: "2026-09", text: "erfunden" })), ["verdichtete Notiz für 2026-09: Monat kommt in den Notizen nicht vor"]);
    assert.deepEqual(mit((x) => x.notizen.verdichtet.push({ monat: "2026-04", text: "schon verdichtet" })), ["verdichtete Notiz für 2026-04: Monat kommt in den Notizen nicht vor"]);
    assert.deepEqual(mit((x) => x.notizen.verdichtet.push({ monat: "2026-05", text: "doppelt" })), ["verdichtete Notiz für 2026-05 doppelt"]);
  });
});

// ---------- wendeAn ----------

describe("wendeAn", () => {
  const e = v.baueEingabe(basis(), NOTIZEN_TEXT, HEUTE, 90);
  const vorschlag = () => {
    const x = gueltig();
    x.notizen.behalten = NOTIZ_ZEILEN.filter((z) => !e.notizen.includes(z));
    return x;
  };

  it("rein: das übergebene Profil bleibt unverändert", () => {
    const p = basis();
    v.wendeAn(p, NOTIZEN_TEXT, vorschlag(), HEUTE, e);
    assert.deepEqual(p, basis());
  });

  it("Zusammenführen: neuer Fakt mit ältestem seit, quelle verdichtung, an der Stelle des ersten; Originale im Archiv", () => {
    const r = v.wendeAn(basis(), NOTIZEN_TEXT, vorschlag(), HEUTE, e);
    assert.deepEqual(r.profil.fakten.map((f) => f.id), [1, 2, 7, 5, 6]);
    assert.deepEqual(r.profil.fakten[2], { id: 7, text: "Trinkt Kaffee schwarz, ohne Zucker", seit: "2025-05-01", quelle: "verdichtung" });
    assert.deepEqual(r.archiv.fakten, [
      { id: 3, text: "Trinkt Kaffee schwarz", seit: "2025-05-01", quelle: "import", ersetztDurch: 7 },
      { id: 4, text: "Mag Kaffee ohne Zucker", seit: "2025-06-01", quelle: "chat", ersetztDurch: 7 },
    ]);
  });

  it("veraltet: markiert, nicht gelöscht", () => {
    const r = v.wendeAn(basis(), NOTIZEN_TEXT, vorschlag(), HEUTE, e);
    assert.deepEqual(r.profil.fakten[0], { id: 1, text: "Wohnt in Basel", seit: "2025-02-01", quelle: "import", veraltet: { seit: HEUTE, grund: "widerspricht #2 vom 2026-03-12" } });
    assert.deepEqual(r.archiv.veraltet, [{ id: 1, text: "Wohnt in Basel", grund: "widerspricht #2 vom 2026-03-12" }]);
  });

  it("Chronik: alte Entscheidungen je Monat, Anzahl aus den Daten, Details im Archiv; neuere bleiben", () => {
    const x = vorschlag();
    x.chronik[0]!.entscheidungen = 99; // Zahl des Modells zählt nicht
    const r = v.wendeAn(basis(), NOTIZEN_TEXT, x, HEUTE, e);
    assert.deepEqual(r.profil.entscheidungen.map((d) => d.id), [4, 5]);
    assert.deepEqual(r.profil.chronik, [
      { monat: "2026-05", text: "Ferien verschoben.", entscheidungen: 1 },
      { monat: "2026-06", text: "Auf ein neues Auto verzichtet (Velo reicht), Erste-Hilfe-Kurs gebucht.", entscheidungen: 2 },
    ]);
    assert.deepEqual(r.archiv.entscheidungen.map((d) => d.id).sort(), [1, 2, 3]);
    assert.equal(r.archiv.entscheidungen.find((d) => d.id === 1)?.ausgang, "Velo reicht");
  });

  it("Chronik: ein schon vorhandener Monat wird ergänzt", () => {
    const p = basis();
    p.chronik = [{ monat: "2026-06", text: "Bisher.", entscheidungen: 1 }];
    const r = v.wendeAn(p, NOTIZEN_TEXT, vorschlag(), HEUTE, e);
    assert.deepEqual(r.profil.chronik.find((c) => c.monat === "2026-06"), { monat: "2026-06", text: "Bisher. Auf ein neues Auto verzichtet (Velo reicht), Erste-Hilfe-Kurs gebucht.", entscheidungen: 3 });
  });

  it("Notizen: behalten unverändert an ihrer Stelle, verdichtete Zeilen statt der Originale, Originale im Archiv", () => {
    const r = v.wendeAn(basis(), NOTIZEN_TEXT, vorschlag(), HEUTE, e);
    assert.equal(
      r.notizen,
      [
        "- 2026-04 (verdichtet): Winterreifen montiert",
        "- 2026-05 (verdichtet): Reifendruck 2.4 bar; Garagencode geändert",
        "- 2026-08 (verdichtet): Velo-Service bei Müller; Lea hat am 3. März Geburtstag",
        "Freitext ohne Datum",
        "- 2026-09-05: Kamera Einfahrt neu ausgerichtet",
        "- 2026-10-02: Ganz neue Notiz",
        "",
      ].join("\n"),
    );
    assert.deepEqual([...r.archiv.notizen].sort(), [...e.notizen].sort());
    assert.deepEqual(r.bericht, { faktenZusammengefuehrt: 2, faktenVeraltet: 1, notizenVorher: 8, notizenNachher: 6, entscheidungenChronik: 3, chronikMonate: ["2026-06", "2026-05"], notizenVerdichtet: 4 });
    assert.equal(r.profil.letzteVerdichtung, HEUTE);
  });

  it("nichts geht verloren: jeder Fakt, jede Entscheidung und jede Notiz steht danach im Profil oder im Archiv", () => {
    const p = basis();
    const r = v.wendeAn(p, NOTIZEN_TEXT, vorschlag(), HEUTE, e);
    for (const f of p.fakten) assert.ok(r.profil.fakten.some((x) => x.id === f.id && x.text === f.text) || r.archiv.fakten.some((x) => x.id === f.id && x.text === f.text), f.text);
    for (const d of p.entscheidungen) assert.ok(r.profil.entscheidungen.some((x) => x.id === d.id) || r.archiv.entscheidungen.some((x) => x.id === d.id), d.text);
    for (const z of NOTIZ_ZEILEN) assert.ok(r.notizen.split("\n").includes(z) || r.archiv.notizen.includes(z), z);
  });

  it("ohne Eintrag für einen Monat bleiben dessen Notizzeilen stehen; leerer Vorschlag ändert die Notizen nicht", () => {
    const x = vorschlag();
    x.notizen.verdichtet = x.notizen.verdichtet.filter((n) => n.monat === "2026-05");
    const r = v.wendeAn(basis(), NOTIZEN_TEXT, x, HEUTE, e);
    assert.ok(r.notizen.includes("- 2026-08-01: Lea Geburtstag am 3. März") && r.notizen.includes("- 2026-08-15: Velo-Service bei Müller"));
    assert.ok(!r.notizen.includes("- 2026-08 (verdichtet)"));
    const leer = v.wendeAn(basis(), NOTIZEN_TEXT, v.parseVorschlag("{}"), HEUTE, e);
    assert.equal(leer.notizen, NOTIZEN_TEXT);
    assert.deepEqual(leer.bericht, { faktenZusammengefuehrt: 0, faktenVeraltet: 0, notizenVorher: 8, notizenNachher: 8, entscheidungenChronik: 0 });
    assert.equal(v.hatAenderungen(leer.bericht), false);
  });

  it("mit Eingabe: nur, was in der Eingabe war (unbekannte Fakten und neuere Entscheidungen bleiben unberührt)", () => {
    const p = basis();
    p.fakten.push({ id: 8, text: "Neu während des Laufs", seit: HEUTE, quelle: "chat" });
    p.entscheidungen.push({ id: 6, datum: "2026-06-30T10:00:00.000Z", text: "Nachgetragen, nicht in der Eingabe" });
    const x = vorschlag();
    x.fakten.zusammenfuehren.push({ ids: [5, 8], text: "nicht erlaubt" });
    const r = v.wendeAn(p, NOTIZEN_TEXT, x, HEUTE, e);
    assert.ok(r.profil.fakten.some((f) => f.id === 8) && r.profil.fakten.some((f) => f.id === 5));
    assert.ok(r.profil.entscheidungen.some((d) => d.id === 6));
    assert.equal(r.profil.chronik.find((c) => c.monat === "2026-06")?.entscheidungen, 2);
  });

  it("Chronik nimmt alle Entscheidungen: höchste id bleibt gemerkt, auch über Speichern/Laden", async () => {
    const { normalisiereProfil } = await import("../src/profil.js");
    const p = basis();
    p.entscheidungen = [
      { id: 1, datum: "2026-05-02T10:00:00.000Z", text: "A" },
      { id: 2, datum: "2026-05-20T10:00:00.000Z", text: "B" },
    ];
    const e2 = v.baueEingabe(p, "", HEUTE, 90);
    const x = v.parseVorschlag('{"chronik":[{"monat":"2026-05","text":"A und B.","entscheidungen":2}]}');
    const r = v.wendeAn(p, "", x, HEUTE, e2);
    assert.deepEqual(r.profil.entscheidungen, []);
    assert.equal((r.profil as import("../src/verdichtung.js").ProfilMitIdMax).entscheidungIdMax, 2);
    const geladen = normalisiereProfil(JSON.parse(JSON.stringify(r.profil)), HEUTE) as import("../src/verdichtung.js").ProfilMitIdMax;
    assert.equal(geladen.entscheidungIdMax, 2);
    assert.deepEqual(r.archiv.entscheidungen.map((d) => d.id), [1, 2]);

    // ein früher gemerkter höherer Wert bleibt
    const q = { ...structuredClone(p), entscheidungIdMax: 7 };
    assert.equal((v.wendeAn(q, "", x, HEUTE, e2).profil as import("../src/verdichtung.js").ProfilMitIdMax).entscheidungIdMax, 7);
    // ohne Chronik kein neues Feld
    assert.equal("entscheidungIdMax" in v.wendeAn(p, "", v.parseVorschlag("{}"), HEUTE, e2).profil, false);
  });

  it("Notizen mit Leerzeilen und Überschriften: Gliederung bleibt, gezählt werden Zeilen mit Inhalt", () => {
    const text = "# Notizen\n\n- 2026-08-01: Lea Geburtstag am 3. März\n- 2026-08-15: Velo-Service bei Müller\n\n## Werkstatt\n\n- 2026-10-01: neu\n";
    const p = basis();
    const e2 = v.baueEingabe(p, text, HEUTE, 90);
    const x = v.parseVorschlag('{"notizen":{"verdichtet":[{"monat":"2026-08","text":"Lea 3. März; Velo-Service bei Müller"}]}}');
    x.notizen.behalten = ["# Notizen", "## Werkstatt", "- 2026-10-01: neu"];
    const r = v.wendeAn(p, text, x, HEUTE, e2);
    assert.equal(r.notizen, "# Notizen\n\n- 2026-08 (verdichtet): Lea 3. März; Velo-Service bei Müller\n\n## Werkstatt\n\n- 2026-10-01: neu\n");
    assert.deepEqual(r.archiv.notizen, ["- 2026-08-01: Lea Geburtstag am 3. März", "- 2026-08-15: Velo-Service bei Müller"]);
    assert.equal(r.bericht.notizenVorher, 5);
    assert.equal(r.bericht.notizenNachher, 4);
    assert.equal(r.bericht.notizenVerdichtet, 2);
  });

  it("Notiz 1:1 verdichtet (gleiche Zeilenzahl): trotzdem als Änderung gemeldet", () => {
    const text = "- 2026-07-02: Bohrer 6mm gekauft\n- 2026-10-01: neu\n";
    const p = basis();
    p.fakten = [];
    p.entscheidungen = [];
    const e2 = v.baueEingabe(p, text, HEUTE, 90);
    const x = v.parseVorschlag('{"notizen":{"verdichtet":[{"monat":"2026-07","text":"Bohrer 6 mm gekauft"}]}}');
    x.notizen.behalten = ["- 2026-10-01: neu"];
    const r = v.wendeAn(p, text, x, HEUTE, e2);
    assert.equal(r.notizen, "- 2026-07 (verdichtet): Bohrer 6 mm gekauft\n- 2026-10-01: neu\n");
    assert.deepEqual(r.bericht, { faktenZusammengefuehrt: 0, faktenVeraltet: 0, notizenVorher: 2, notizenNachher: 2, entscheidungenChronik: 0, notizenVerdichtet: 1 });
    assert.equal(v.hatAenderungen(r.bericht), true);
    assert.equal(v.berichtText(r.bericht), "🧠 Verdichtung: Notizen 2 → 2 Zeilen (1 verdichtet).");
  });
});

describe("berichtText", () => {
  it("wie vorgegeben, Einzahl und nichts zu tun", () => {
    assert.equal(
      v.berichtText({ faktenZusammengefuehrt: 3, faktenVeraltet: 2, notizenVorher: 41, notizenNachher: 12, entscheidungenChronik: 7, chronikMonate: ["2026-07"] }),
      "🧠 Verdichtung: 3 Fakten zusammengeführt, 2 als veraltet markiert, Notizen 41 → 12 Zeilen, 7 Entscheidungen (Juli) in die Chronik.",
    );
    assert.equal(
      v.berichtText({ faktenZusammengefuehrt: 0, faktenVeraltet: 1, notizenVorher: 5, notizenNachher: 5, entscheidungenChronik: 1, chronikMonate: ["2025-12", "2026-01"] }),
      "🧠 Verdichtung: 1 als veraltet markiert, 1 Entscheidung (Dezember 2025, Januar 2026) in die Chronik.",
    );
    assert.match(v.berichtText({ faktenZusammengefuehrt: 0, faktenVeraltet: 0, notizenVorher: 3, notizenNachher: 3, entscheidungenChronik: 0 }), /nichts zu ändern, Sir/);
  });
});

describe("vorschauText", () => {
  it("Einzahl und Mehrzahl bei Zeilen und Entscheidungen", () => {
    const e = v.baueEingabe(basis(), "- 2026-07-04: Einzige Notiz im Juli\n- 2026-08-01: a\n- 2026-08-02: b\n", HEUTE, 90);
    const x: Vorschlag = {
      fakten: { zusammenfuehren: [], veraltet: [] },
      notizen: { behalten: [], verdichtet: [{ monat: "2026-07", text: "Eine Notiz" }, { monat: "2026-08", text: "Zwei Notizen" }] },
      chronik: [{ monat: "2026-05", text: "Ferien verschoben.", entscheidungen: 1 }, { monat: "2026-06", text: "Zwei.", entscheidungen: 2 }],
    };
    const text = v.vorschauText(x, e);
    assert.ok(text.includes("• 2026-07 (1 Zeile): Eine Notiz"), text);
    assert.ok(text.includes("• 2026-08 (2 Zeilen): Zwei Notizen"), text);
    assert.ok(text.includes("• 2026-05 (1 Entscheidung): Ferien verschoben."), text);
    assert.ok(text.includes("• 2026-06 (2 Entscheidungen): Zwei."), text);
  });
});

// ---------- verdichteJetzt ----------

describe("verdichteJetzt", () => {
  let fragen: { system: string; user: string }[] = [];
  const antwortet = (text: string) => async (system: string, user: string) => {
    fragen.push({ system, user });
    return text;
  };
  const datei = (pfad: string) => (existsSync(pfad) ? readFileSync(pfad, "utf8") : undefined);

  beforeEach(() => {
    fragen = [];
    state.paused = false;
    setzeProfil(basis());
    saveProfil();
    writeFileSync(NOTIZEN, NOTIZEN_TEXT, { mode: 0o600 });
    rmSync(ARCHIV, { force: true });
  });
  afterEach(() => { state.paused = false; });

  it("gültiger Vorschlag: Profil, Notizen und Archiv geschrieben (0o600), Bericht zurück, audit", async () => {
    const r = await v.verdichteJetzt({ heute: HEUTE, frage: antwortet(`\`\`\`json\n${JSON.stringify(gueltig())}\n\`\`\``) });
    assert.equal(r.fehler, undefined);
    assert.deepEqual(r.bericht, { faktenZusammengefuehrt: 2, faktenVeraltet: 1, notizenVorher: 8, notizenNachher: 6, entscheidungenChronik: 3, chronikMonate: ["2026-06", "2026-05"], notizenVerdichtet: 4 });
    assert.equal(fragen.length, 1);
    assert.match(fragen[0]!.system, /Nichts erfinden/);
    assert.ok(fragen[0]!.user.includes("Wohnt in Muttenz") && fragen[0]!.user.includes("- 2026-05-03: Reifendruck 2.4 bar"));
    assert.ok(!fragen[0]!.user.includes("Ganz neue Notiz"), "neue Notizen gehen nicht ans Modell");

    const gespeichert = JSON.parse(readFileSync(PROFIL, "utf8")) as Profil;
    assert.deepEqual(gespeichert.fakten.map((f) => f.id), [1, 2, 7, 5, 6]);
    assert.ok(gespeichert.fakten[0]!.veraltet);
    assert.equal(gespeichert.chronik.length, 2);
    assert.equal(gespeichert.letzteVerdichtung, HEUTE);
    assert.deepEqual(profil.fakten.map((f) => f.id), [1, 2, 7, 5, 6], "auch im Speicher");
    assert.ok(readFileSync(NOTIZEN, "utf8").includes("- 2026-05 (verdichtet): Reifendruck 2.4 bar; Garagencode geändert"));
    assert.equal(statSync(NOTIZEN).mode & 0o777, 0o600);
    assert.ok(!existsSync(`${NOTIZEN}.tmp`) && !existsSync(`${PROFIL}.tmp`));

    const zeilen = readFileSync(ARCHIV, "utf8").trim().split("\n");
    assert.equal(zeilen.length, 1);
    const archiv = JSON.parse(zeilen[0]!) as { ts: string; datum: string; fakten: unknown[]; notizen: string[]; entscheidungen: unknown[]; bericht: unknown };
    assert.equal(archiv.datum, HEUTE);
    assert.ok(!Number.isNaN(Date.parse(archiv.ts)));
    assert.equal(archiv.fakten.length, 2);
    assert.equal(archiv.notizen.length, 4);
    assert.equal(archiv.entscheidungen.length, 3);
    assert.deepEqual(archiv.bericht, r.bericht);
    assert.equal(statSync(ARCHIV).mode & 0o777, 0o600);
    assert.match(readFileSync(AUDIT, "utf8"), /"event":"verdichtung","faktenZusammengefuehrt":2/);

    // Zweiter Lauf am selben Tag: Fakten sind schon verdichtet, Notizen und Entscheidungen auch → kein Modellaufruf
    const zweiter = await v.verdichteJetzt({ heute: HEUTE, frage: antwortet("{}") });
    assert.deepEqual(zweiter, {});
    assert.equal(fragen.length, 1);
  });

  it("ungültiger Vorschlag: nichts geändert, Fehler mit Grund, audit verdichtung_abgelehnt", async () => {
    const profilVorher = readFileSync(PROFIL, "utf8");
    const x = gueltig();
    x.fakten.veraltet.push({ id: 99, grund: "erfunden" });
    const r = await v.verdichteJetzt({ heute: HEUTE, frage: antwortet(JSON.stringify(x)) });
    assert.match(r.fehler ?? "", /Vorschlag abgelehnt: unbekannte Fakt-id 99.*Nichts geändert/);
    assert.equal(r.bericht, undefined);
    assert.equal(readFileSync(PROFIL, "utf8"), profilVorher);
    assert.equal(readFileSync(NOTIZEN, "utf8"), NOTIZEN_TEXT);
    assert.equal(datei(ARCHIV), undefined);
    assert.deepEqual(profil, JSON.parse(profilVorher));
    assert.match(readFileSync(AUDIT, "utf8"), /"event":"verdichtung_abgelehnt","gruende":\["unbekannte Fakt-id 99",/);
  });

  it("unbrauchbare Antwort: nichts geändert, Fehler zurück", async () => {
    const profilVorher = readFileSync(PROFIL, "utf8");
    const r = await v.verdichteJetzt({ heute: HEUTE, frage: antwortet("Tut mir leid, das kann ich nicht.") });
    assert.match(r.fehler ?? "", /unbrauchbar.*keine JSON-Antwort/);
    assert.equal(readFileSync(PROFIL, "utf8"), profilVorher);
    assert.equal(readFileSync(NOTIZEN, "utf8"), NOTIZEN_TEXT);
    assert.equal(datei(ARCHIV), undefined);
  });

  it("nurVorschau: Vorschlag zurück, nichts geschrieben; lesbare Vorschau", async () => {
    const profilVorher = readFileSync(PROFIL, "utf8");
    const r = await v.verdichteJetzt({ heute: HEUTE, nurVorschau: true, frage: antwortet(JSON.stringify(gueltig())) });
    assert.equal(r.fehler, undefined);
    assert.equal(r.bericht, undefined);
    assert.ok(r.vorschau && r.eingabe);
    assert.equal(readFileSync(PROFIL, "utf8"), profilVorher);
    assert.equal(readFileSync(NOTIZEN, "utf8"), NOTIZEN_TEXT);
    assert.equal(datei(ARCHIV), undefined);
    const text = v.vorschauText(r.vorschau, r.eingabe);
    assert.ok(text.includes("#3 «Trinkt Kaffee schwarz» + #4 «Mag Kaffee ohne Zucker»\n  → «Trinkt Kaffee schwarz, ohne Zucker»"), text);
    assert.ok(text.includes("#1 «Wohnt in Basel» – widerspricht #2 vom 2026-03-12"), text);
    assert.ok(text.includes("2026-05 (2 Zeilen): Reifendruck"), text);
    assert.ok(text.includes("2026-06 (2 Entscheidungen):"), text);
  });

  it("nurVorschau mit ungültigem Vorschlag: Vorschau und Grund, trotzdem nichts geschrieben", async () => {
    const x = gueltig();
    x.chronik.push({ monat: "2026-09", text: "zu neu", entscheidungen: 1 });
    const r = await v.verdichteJetzt({ heute: HEUTE, nurVorschau: true, frage: antwortet(JSON.stringify(x)) });
    assert.ok(r.vorschau);
    assert.match(r.fehler ?? "", /2026-09 ohne passende Entscheidungen/);
    assert.equal(datei(ARCHIV), undefined);
  });

  it("leere Eingabe: kein Modellaufruf, kein Bericht, nichts geschrieben", async () => {
    const p = basis();
    p.fakten = [];
    p.entscheidungen = [];
    setzeProfil(p);
    writeFileSync(NOTIZEN, "- 2026-10-01: neu\n");
    const r = await v.verdichteJetzt({ heute: HEUTE, frage: antwortet("{}") });
    assert.deepEqual(r, {});
    assert.equal(fragen.length, 0);
    assert.equal(datei(ARCHIV), undefined);
  });

  it("während des Aufrufs dazugekommene Notiz und neuer Fakt bleiben erhalten", async () => {
    const r = await v.verdichteJetzt({
      heute: HEUTE,
      frage: async () => {
        writeFileSync(NOTIZEN, `${NOTIZEN_TEXT}- 2026-10-11: Während der Verdichtung notiert\n`);
        profil.fakten.push({ id: 8, text: "Neu im Chat", seit: HEUTE, quelle: "chat" });
        return JSON.stringify(gueltig());
      },
    });
    assert.ok(r.bericht);
    assert.ok(readFileSync(NOTIZEN, "utf8").includes("- 2026-10-11: Während der Verdichtung notiert"));
    assert.ok(profil.fakten.some((f) => f.id === 8));
    // neue id für den zusammengeführten Fakt liegt hinter der neuen 8
    assert.ok(profil.fakten.some((f) => f.id === 9 && f.quelle === "verdichtung"));
  });

  it("Notaus während des Aufrufs: nichts angewendet", async () => {
    const profilVorher = readFileSync(PROFIL, "utf8");
    const r = await v.verdichteJetzt({
      heute: HEUTE,
      frage: async () => {
        state.paused = true;
        return JSON.stringify(gueltig());
      },
    });
    assert.match(r.fehler ?? "", /Notaus/);
    assert.equal(readFileSync(PROFIL, "utf8"), profilVorher);
    assert.equal(datei(ARCHIV), undefined);
    // im Notaus startet gar keine Verdichtung
    const r2 = await v.verdichteJetzt({ heute: HEUTE, frage: antwortet("{}") });
    assert.match(r2.fehler ?? "", /Notaus/);
  });

  it("Modellfehler wird geworfen, nichts geändert; zweiter Start während eines Laufs abgewiesen", async () => {
    await assert.rejects(v.verdichteJetzt({ heute: HEUTE, frage: async () => { throw new HttpFehler("529 Overloaded", 529); } }), /Overloaded/);
    assert.equal(datei(ARCHIV), undefined);
    assert.equal(v.verdichtungLaeuft(), false);

    let freigeben!: (s: string) => void;
    const erster = v.verdichteJetzt({ heute: HEUTE, frage: () => new Promise<string>((r) => (freigeben = r)) });
    assert.equal(v.verdichtungLaeuft(), true);
    assert.deepEqual(await v.verdichteJetzt({ heute: HEUTE, frage: antwortet("{}") }), { fehler: "Die Verdichtung läuft bereits." });
    freigeben("{}");
    const r = await erster;
    assert.deepEqual(r.bericht, { faktenZusammengefuehrt: 0, faktenVeraltet: 0, notizenVorher: 8, notizenNachher: 8, entscheidungenChronik: 0 });
    assert.equal(v.verdichtungLaeuft(), false);
    assert.equal(readFileSync(ARCHIV, "utf8").trim().split("\n").length, 1, "eine Archiv-Zeile pro Lauf");
  });

  it("drei Fakten mit Dublette: Fakten gehen nicht ans Modell, Notizen und Chronik werden trotzdem verdichtet", async () => {
    const p = basis();
    p.fakten = [
      { id: 1, text: "Wohnt in Muttenz", seit: "2026-03-12", quelle: "chat" },
      { id: 2, text: "Wohnt in Muttenz BL", seit: "2026-04-01", quelle: "chat" },
      { id: 3, text: "Hat eine Tochter", seit: "2026-05-01", quelle: "chat" },
    ];
    setzeProfil(p);
    saveProfil();
    const x = gueltig();
    x.fakten = { zusammenfuehren: [], veraltet: [] };
    const r = await v.verdichteJetzt({ heute: HEUTE, frage: antwortet(JSON.stringify(x)) });
    assert.equal(r.fehler, undefined);
    assert.ok(fragen[0]!.user.includes("(keine – nichts zusammenführen oder markieren)"));
    assert.ok(!fragen[0]!.user.includes("Wohnt in Muttenz"));
    assert.equal(r.bericht?.notizenVerdichtet, 4);
    assert.equal(r.bericht?.entscheidungenChronik, 3);
    assert.deepEqual(profil.fakten.map((f) => f.id), [1, 2, 3]);
    assert.equal(profil.letzteVerdichtung, HEUTE);
  });

  it("Standard-Modellaufruf: gekappte Antwort (max_tokens) wird klar gemeldet statt als Formfehler; nichts geändert", async () => {
    const client = anthropic();
    const orig = client.messages.create;
    const antwort = (stop: "max_tokens" | "end_turn", text: string) => ({
      id: "msg_1", type: "message", role: "assistant", model: "attrappe", stop_reason: stop, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text, citations: null }],
    });
    const anfragen: { max_tokens: number; model: string }[] = [];
    try {
      client.messages.create = (async (body: { max_tokens: number; model: string }) => {
        anfragen.push(body);
        return antwort("max_tokens", '{"notizen":{"verdichtet":[{"monat":"2026-05","text":"abgeschn');
      }) as unknown as typeof client.messages.create;
      const profilVorher = readFileSync(PROFIL, "utf8");
      await assert.rejects(v.verdichteJetzt({ heute: HEUTE }), /Antwort gekappt \(4000 Token erreicht\), Eingabe zu gross/);
      assert.equal(anfragen.length, 1, "nicht wiederholt");
      assert.equal(anfragen[0]!.max_tokens, v.ANTWORT_MAX_TOKENS);
      assert.equal(anfragen[0]!.model, config.claudeModelSehen);
      assert.equal(readFileSync(PROFIL, "utf8"), profilVorher);
      assert.equal(readFileSync(NOTIZEN, "utf8"), NOTIZEN_TEXT);
      assert.equal(datei(ARCHIV), undefined);
      assert.equal(v.verdichtungLaeuft(), false);

      // vollständige Antwort: normal angewendet
      client.messages.create = (async () => antwort("end_turn", JSON.stringify(gueltig()))) as unknown as typeof client.messages.create;
      const r = await v.verdichteJetzt({ heute: HEUTE });
      assert.equal(r.fehler, undefined);
      assert.equal(r.bericht?.faktenZusammengefuehrt, 2);
    } finally {
      client.messages.create = orig;
    }
  });

  it("Notizen mit Leerzeilen: Datei behält ihre Gliederung", async () => {
    const mitLeer = `# Notizen\n\n${NOTIZ_ZEILEN.slice(0, 4).join("\n")}\n\n${NOTIZ_ZEILEN.slice(4).join("\n")}\n`;
    writeFileSync(NOTIZEN, mitLeer, { mode: 0o600 });
    const r = await v.verdichteJetzt({ heute: HEUTE, frage: antwortet(JSON.stringify(gueltig())) });
    assert.equal(r.fehler, undefined);
    assert.equal(
      readFileSync(NOTIZEN, "utf8"),
      [
        "# Notizen",
        "",
        "- 2026-04 (verdichtet): Winterreifen montiert",
        "- 2026-05 (verdichtet): Reifendruck 2.4 bar; Garagencode geändert",
        "- 2026-08 (verdichtet): Velo-Service bei Müller; Lea hat am 3. März Geburtstag",
        "Freitext ohne Datum",
        "",
        "- 2026-09-05: Kamera Einfahrt neu ausgerichtet",
        "- 2026-10-02: Ganz neue Notiz",
        "",
      ].join("\n"),
    );
    assert.deepEqual(r.bericht, { faktenZusammengefuehrt: 2, faktenVeraltet: 1, notizenVorher: 9, notizenNachher: 7, entscheidungenChronik: 3, chronikMonate: ["2026-06", "2026-05"], notizenVerdichtet: 4 });
  });
});

// ---------- Tick ----------

describe("verdichtungTick", () => {
  /** 1.–20.10.2026, lokale Zeit Europe/Zurich; jeder Test nimmt einen eigenen Tag */
  const am = (tag: number, h: number, m: number) => new Date(2026, 9, tag, h, m, 0, 0);
  const tagKey = (tag: number) => `2026-10-${String(tag).padStart(2, "0")}`;
  let aufrufe: { heute?: string }[] = [];
  let ergebnisse: (Awaited<ReturnType<typeof v.verdichteJetzt>> | Error)[] = [];
  let gesendet: string[] = [];
  const origVerdichte = abhaengigkeiten.verdichteJetzt;
  const origSende = abhaengigkeiten.sendeSpaeter;
  const origErr = console.error;
  const origLog = console.log;
  const routinen = () => (JSON.parse(readFileSync(ROUTINEN, "utf8")) as { verdichtung?: string }).verdichtung;
  const bericht = { faktenZusammengefuehrt: 2, faktenVeraltet: 0, notizenVorher: 10, notizenNachher: 4, entscheidungenChronik: 0 };

  beforeEach(() => {
    aufrufe = [];
    ergebnisse = [];
    gesendet = [];
    state.paused = false;
    gesundheit._reset();
    console.error = () => {};
    console.log = () => {};
    abhaengigkeiten.verdichteJetzt = async (opts = {}) => {
      aufrufe.push({ heute: opts.heute });
      const r = ergebnisse.shift() ?? {};
      if (r instanceof Error) throw r;
      return r;
    };
    abhaengigkeiten.sendeSpaeter = async (text: string) => void gesendet.push(text);
  });
  afterEach(() => {
    abhaengigkeiten.verdichteJetzt = origVerdichte;
    abhaengigkeiten.sendeSpaeter = origSende;
    console.error = origErr;
    console.log = origLog;
    state.paused = false;
  });

  it("Fenster: vorher nichts, ab 03:30 einmal; Bericht geht raus, erst danach gemerkt; am selben Tag nicht nochmals", async () => {
    ergebnisse = [{ bericht }];
    await verdichtungTick(am(1, 3, 29));
    assert.equal(aufrufe.length, 0);
    await verdichtungTick(am(1, 3, 30));
    assert.deepEqual(aufrufe, [{ heute: tagKey(1) }]);
    assert.deepEqual(gesendet, ["🧠 Verdichtung: 2 Fakten zusammengeführt, Notizen 10 → 4 Zeilen."]);
    assert.equal(routinen(), tagKey(1));
    await verdichtungTick(am(1, 3, 45));
    await verdichtungTick(am(1, 4, 0));
    assert.equal(aufrufe.length, 1);
  });

  it("verpasst: im Nachholfenster nachgeholt, danach nicht mehr", async () => {
    await verdichtungTick(am(2, 4, 30));
    assert.equal(aufrufe.length, 0);
    await verdichtungTick(am(2, 4, 29));
    assert.equal(aufrufe.length, 1);
  });

  it("nichts zu tun oder nichts geändert: still, aber für heute erledigt", async () => {
    ergebnisse = [{}];
    await verdichtungTick(am(3, 3, 30));
    assert.deepEqual(gesendet, []);
    assert.equal(routinen(), tagKey(3));
    ergebnisse = [{ bericht: { faktenZusammengefuehrt: 0, faktenVeraltet: 0, notizenVorher: 3, notizenNachher: 3, entscheidungenChronik: 0 } }];
    await verdichtungTick(am(4, 3, 30));
    assert.deepEqual(gesendet, []);
    assert.equal(routinen(), tagKey(4));
  });

  it("paused oder off: startet nicht", async () => {
    state.paused = true;
    await verdichtungTick(am(5, 3, 30));
    assert.equal(aufrufe.length, 0);
    state.paused = false;
    const vorher = config.verdichtung;
    try {
      config.verdichtung = "off";
      await verdichtungTick(am(5, 3, 31));
      assert.equal(aufrufe.length, 0);
    } finally {
      config.verdichtung = vorher;
    }
    assert.notEqual(routinen(), tagKey(5));
  });

  it("Notaus während des Laufs: nichts gemeldet, nicht gemerkt", async () => {
    abhaengigkeiten.verdichteJetzt = async () => {
      aufrufe.push({});
      state.paused = true;
      return { fehler: "Notaus aktiv, nichts geändert." };
    };
    await verdichtungTick(am(6, 3, 30));
    assert.equal(aufrufe.length, 1);
    assert.deepEqual(gesendet, []);
    assert.notEqual(routinen(), tagKey(6));
  });

  it("vorübergehender Fehler: still, nicht gemerkt, nach 5 Minuten im Fenster erneut", async () => {
    ergebnisse = [new HttpFehler("529 Overloaded", 529), { bericht }];
    await verdichtungTick(am(7, 3, 30));
    assert.deepEqual(gesendet, []);
    assert.notEqual(routinen(), tagKey(7));
    await verdichtungTick(am(7, 3, 33));
    assert.equal(aufrufe.length, 1, "Wartezeit 5 Minuten");
    await verdichtungTick(am(7, 3, 35));
    assert.equal(aufrufe.length, 2);
    assert.equal(gesendet.length, 1);
    assert.equal(routinen(), tagKey(7));
  });

  it("dauerhafter Fehler: eine Meldung (geschwärzt), für heute erledigt", async () => {
    ergebnisse = [new HttpFehler("400 Bad Request (https://x.example/?token=geheim123)", 400)];
    await verdichtungTick(am(8, 3, 30));
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0]!, /^⚠️ Die nächtliche Verdichtung ist ausgefallen: 400 Bad Request/);
    assert.doesNotMatch(gesendet[0]!, /geheim123/);
    assert.equal(routinen(), tagKey(8));
    await verdichtungTick(am(8, 3, 40));
    assert.equal(aufrufe.length, 1);
  });

  it("abgelehnter Vorschlag: eine Meldung mit Grund, für heute erledigt", async () => {
    ergebnisse = [{ fehler: "Vorschlag abgelehnt: unbekannte Fakt-id 99. Nichts geändert." }];
    await verdichtungTick(am(9, 3, 30));
    assert.deepEqual(gesendet, ["⚠️ Die nächtliche Verdichtung ist ausgefallen: Vorschlag abgelehnt: unbekannte Fakt-id 99. Nichts geändert."]);
    assert.equal(routinen(), tagKey(9));
  });

  it("offline: wartet; läuft gerade /verdichten: nächste Minute", async () => {
    gesundheit.melde("internet", false, "Netz: ENOTFOUND");
    await verdichtungTick(am(10, 3, 30));
    assert.equal(aufrufe.length, 0);
    gesundheit.melde("internet", true);

    // eine echte, hängende Verdichtung (per /verdichten gestartet) blockiert den Tick
    setzeProfil(basis());
    writeFileSync(NOTIZEN, NOTIZEN_TEXT);
    let freigeben!: (s: string) => void;
    const laufend = v.verdichteJetzt({ heute: HEUTE, nurVorschau: true, frage: () => new Promise<string>((r) => (freigeben = r)) });
    await verdichtungTick(am(10, 3, 31));
    assert.equal(aufrufe.length, 0);
    freigeben("{}");
    await laufend;
    await verdichtungTick(am(10, 3, 32));
    assert.equal(aufrufe.length, 1);
    assert.equal(routinen(), tagKey(10));
  });
});

// ---------- Telegram /verdichten ----------

describe("Telegram /verdichten", () => {
  let nr = 100;
  const befehl = (text: string) => tg.handleUpdate({ update_id: ++nr, message: { message_id: nr, chat: { id: 12345 }, text } });
  const gesendet = () => telegram.filter((x) => x.method === "sendMessage").map((x) => x.text ?? "");
  const orig = tg.abhaengigkeiten.verdichteJetzt;
  let optionen: unknown[] = [];
  const origErr = console.error;

  beforeEach(() => {
    telegram = [];
    optionen = [];
    state.paused = false;
    console.error = () => {};
  });
  afterEach(() => {
    tg.abhaengigkeiten.verdichteJetzt = orig;
    console.error = origErr;
    state.paused = false;
  });

  it("/verdichten: Bericht als Antwort", async () => {
    tg.abhaengigkeiten.verdichteJetzt = async (o = {}) => {
      optionen.push(o);
      return { bericht: { faktenZusammengefuehrt: 3, faktenVeraltet: 2, notizenVorher: 41, notizenNachher: 12, entscheidungenChronik: 7, chronikMonate: ["2026-07"] } };
    };
    await befehl("/verdichten");
    assert.deepEqual(optionen, [{ nurVorschau: false }]);
    assert.equal(gesendet().at(-1), "🧠 Verdichtung: 3 Fakten zusammengeführt, 2 als veraltet markiert, Notizen 41 → 12 Zeilen, 7 Entscheidungen (Juli) in die Chronik.");
  });

  it("/verdichten vorschau: Vorschlag lesbar, mit Grund, falls er abgelehnt würde", async () => {
    const e = v.baueEingabe(basis(), NOTIZEN_TEXT, HEUTE, 90);
    tg.abhaengigkeiten.verdichteJetzt = async (o = {}) => {
      optionen.push(o);
      return { vorschau: gueltig(), eingabe: e, fehler: "Vorschlag abgelehnt: x. Nichts geändert." };
    };
    await befehl("/verdichten Vorschau");
    assert.deepEqual(optionen, [{ nurVorschau: true }]);
    const text = gesendet().at(-1)!;
    assert.ok(text.startsWith("🧠 Vorschau der Verdichtung (noch nichts geändert):"), text);
    assert.ok(text.includes("So würde ich ihn nicht anwenden – Vorschlag abgelehnt: x."), text);
  });

  it("nichts zu tun, Fehler, Modellfehler, Notaus und falsches Argument", async () => {
    tg.abhaengigkeiten.verdichteJetzt = async () => ({});
    await befehl("/verdichten");
    assert.match(gesendet().at(-1)!, /Nichts zu verdichten, Sir/);
    tg.abhaengigkeiten.verdichteJetzt = async () => ({ fehler: "Vorschlag abgelehnt: y. Nichts geändert." });
    await befehl("/verdichten");
    assert.equal(gesendet().at(-1), "⚠️ Vorschlag abgelehnt: y. Nichts geändert.");
    tg.abhaengigkeiten.verdichteJetzt = async () => { throw new Error("EACCES: permission denied, open 'data/profil.json'"); };
    await befehl("/verdichten");
    assert.match(gesendet().at(-1)!, /^Die Verdichtung ist fehlgeschlagen: EACCES/);
    let gerufen = false;
    tg.abhaengigkeiten.verdichteJetzt = async () => { gerufen = true; return {}; };
    state.paused = true;
    await befehl("/verdichten");
    assert.match(gesendet().at(-1)!, /Notaus aktiv/);
    state.paused = false;
    await befehl("/verdichten jetzt");
    assert.match(gesendet().at(-1)!, /Benutzung: \/verdichten/);
    assert.equal(gerufen, false);
  });

  it("/hilfe nennt /verdichten", async () => {
    await befehl("/hilfe");
    assert.match(gesendet().at(-1)!, /\/verdichten – Gedächtnis jetzt verdichten/);
  });
});
