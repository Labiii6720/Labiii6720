import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/, cameras.json liegen relativ) und Umgebung; nie echte Dienste
const temp = mkdtempSync(join(tmpdir(), "jarvis-dashboard-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.FRIGATE_URL = "http://frigate.attrappe";
process.env.RUECKBLICK = "off";
process.env.RECHNUNG_ERINNERUNG = "off";
process.env.ZIELCHECK = "off";
process.env.VERDICHTUNG = "off";

mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "routinen.json"), "{}");
writeFileSync(join(temp, "cameras.json"), JSON.stringify({ einfahrt: { frigate: "einfahrt", beschreibung: "Einfahrt vorne" } }));
writeFileSync(join(temp, "data", "audit.log"), '{"ts":"2026-10-11T08:00:00.000Z","art":"geheimer_eintrag"}\n');

/** Netz-Attrappe: Frigate liefert ein Bild, Telegram nimmt an; alles andere ist ein Fehler */
let aufrufe: string[] = [];
/** Läuft während eines Abrufs (z. B. Notfall auslösen, solange Frigate oder HA noch antworten) */
let beimAbruf: (() => void) | undefined;
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  aufrufe.push(url);
  await Promise.resolve();
  beimAbruf?.();
  // Wie Node/undici bei einer URL mit Zugangsdaten (FRIGATE_URL=http://user:pw@…)
  if (/^\w+:\/\/[^/@\s]+@/.test(url)) throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`);
  if (url.startsWith("http://frigate.attrappe/")) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { "content-type": "image/jpeg" } });
  if (url.startsWith("http://ha.attrappe/api/states")) return new Response(JSON.stringify([{ entity_id: "lock.haustuer", state: "unlocked", attributes: { friendly_name: "Haustür" } }]), { headers: { "content-type": "application/json" } });
  if (url.startsWith("https://api.telegram.org/bot")) return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
  throw new Error(`unerwarteter Netzaufruf: ${url}`);
}) as typeof fetch;

const { statusJson, kameraBild, auditTail, geraete, protokollAction, zeitplaeneJson, zeitplanAendern, wachenJson } = await import("../src/dashboard.js");
const { zeitplaene } = await import("../src/zeitplaene.js");
const { protokolle } = await import("../src/protokolle.js");
const { reminders } = await import("../src/tools.js");
const { rechnungen } = await import("../src/finanzen.js");
const { profil } = await import("../src/profil.js");
const { auftraege, createAuftrag } = await import("../src/queue.js");
const { state } = await import("../src/state.js");
const { config } = await import("../src/config.js");
const { _testOptionen, dynamicWachen } = await import("../src/cameras.js");
_testOptionen.warten = async () => undefined;
_testOptionen.zufall = () => 0;

type Req = Parameters<typeof statusJson>[0];
type Res = Parameters<typeof statusJson>[1];

function antwort() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    send(b: unknown) { this.body = b; return this; },
    set(k: string, v: string) { this.headers[k] = v; return this; },
    end() { return this; },
  };
}
const req = (teil: Record<string, unknown> = {}) => ({ params: {}, query: {}, ...teil }) as unknown as Req;

const NOTFALL = () => ({ aktiv: true, seit: new Date().toISOString(), grund: "Test" });

rechnungen.push({ id: 1, erkanntAm: "2026-10-01T09:00:00.000Z", empfaenger: "Swisscom", betrag: 89.5, waehrung: "CHF", faellig: "2026-10-20", status: "offen" });
profil.ziele.push({ id: 1, text: "Geheimes Ziel", status: "offen", angelegt: "2026-10-01" });
profil.werte.push("Geheimer Wert");
createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "Mail an Bank: vertraulicher Text" });

beforeEach(() => {
  aufrufe = [];
  beimAbruf = undefined;
  state.paused = false;
  state.notfall = { aktiv: false };
});

describe("Dashboard im Notfall", () => {
  it("ohne Notfall liefert /status.json die Daten wie bisher", () => {
    const res = antwort();
    statusJson(req(), res as unknown as Res);
    const roh = JSON.stringify(res.body);
    for (const text of ["Swisscom", "Geheimes Ziel", "Geheimer Wert", "vertraulicher Text", "Einfahrt vorne"]) assert.ok(roh.includes(text), `${text} fehlt`);
  });

  it("/status.json gibt im Notfall nur den Zustand heraus, Listen leer", () => {
    state.notfall = NOTFALL();
    state.paused = true;
    const res = antwort();
    statusJson(req(), res as unknown as Res);
    const b = res.body as Record<string, unknown>;
    assert.equal(res.statusCode, 200);
    assert.equal(b.ok, true);
    assert.equal(b.notfall, true);
    assert.equal(b.pausiert, true);
    assert.equal(b.offeneAuftraege, 1);
    for (const feld of ["auftraege", "rechnungen", "vorgaenge", "zeitplaene", "wachen", "kameras", "protokolle", "ziele", "werte"]) assert.deepEqual(b[feld], [], `${feld} muss leer sein`);
    assert.ok("gesundheit" in b);
    const roh = JSON.stringify(b);
    for (const text of ["Swisscom", "89.5", "2026-10-20", "Geheimes Ziel", "Geheimer Wert", "vertraulicher Text", "Einfahrt vorne"]) assert.ok(!roh.includes(text), `${text} gehört im Notfall nicht ins Dashboard`);
  });

  it("/api/kamera liefert ohne Notfall ein Bild", async () => {
    const res = antwort();
    await kameraBild(req({ params: { name: "einfahrt" } }) as never, res as never);
    assert.equal(res.statusCode, 200);
    assert.ok(aufrufe.some((u) => u.startsWith("http://frigate.attrappe/")));
  });

  it("/api/kamera schwärzt Zugangsdaten im 502-Fehlertext", async () => {
    const vorher = config.frigateUrl;
    config.frigateUrl = "http://jarvis:GeheimesFrigatePw@frigate.attrappe";
    try {
      const res = antwort();
      await kameraBild(req({ params: { name: "einfahrt" } }) as never, res as never);
      assert.equal(res.statusCode, 502);
      const roh = JSON.stringify(res.body);
      assert.ok(!roh.includes("GeheimesFrigatePw"), "Passwort gehört nicht ins Dashboard");
      assert.ok(!roh.includes("jarvis:"), "Benutzer samt Passwort geschwärzt");
      assert.match(roh, /<geheim>@frigate\.attrappe/);
    } finally {
      config.frigateUrl = vorher;
    }
  });

  it("/api/kamera ist im Notfall gesperrt und fragt Frigate nicht an", async () => {
    state.notfall = NOTFALL();
    const res = antwort();
    await kameraBild(req({ params: { name: "einfahrt" } }) as never, res as never);
    assert.equal(res.statusCode, 423);
    assert.equal((res.body as { error?: string }).error, "notfall");
    assert.deepEqual(aufrufe, []);
  });

  it("/api/kamera: kommt der Notfall während des Frigate-Abrufs, bleibt das Bild hier (423)", async () => {
    beimAbruf = () => { state.notfall = NOTFALL(); };
    const res = antwort();
    await kameraBild(req({ params: { name: "einfahrt" } }) as never, res as never);
    assert.ok(aufrufe.some((u) => u.startsWith("http://frigate.attrappe/")), "Frigate wurde angefragt");
    assert.equal(res.statusCode, 423);
    assert.equal((res.body as { error?: string }).error, "notfall");
    assert.ok(!(res.body instanceof Uint8Array) && !Buffer.isBuffer(res.body), "keine Bilddaten");
    assert.equal(res.headers["Content-Type"], undefined);
  });

  it("/api/geraete: kommt der Notfall während des HA-Abrufs, keine Zustände (423)", async () => {
    const vorher = config.homeAssistant;
    (config as { homeAssistant: unknown }).homeAssistant = { url: "http://ha.attrappe", token: "attrappe" };
    try {
      const ohne = antwort();
      await geraete(req() as never, ohne as never);
      assert.equal(ohne.statusCode, 200);
      assert.match(JSON.stringify(ohne.body), /lock\.haustuer/);

      beimAbruf = () => { state.notfall = NOTFALL(); };
      const res = antwort();
      await geraete(req() as never, res as never);
      assert.ok(aufrufe.some((u) => u.startsWith("http://ha.attrappe/")), "HA wurde angefragt");
      assert.equal(res.statusCode, 423);
      assert.equal((res.body as { error?: string }).error, "notfall");
      assert.ok(!JSON.stringify(res.body).includes("haustuer"), "keine Gerätezustände im Notfall");
    } finally {
      (config as { homeAssistant: unknown }).homeAssistant = vorher;
    }
  });

  it("/api/audit ist im Notfall gesperrt", () => {
    state.notfall = NOTFALL();
    const res = antwort();
    auditTail(req(), res as unknown as Res);
    assert.equal(res.statusCode, 423);
    assert.deepEqual((res.body as { eintraege?: unknown }).eintraege, []);
    assert.ok(!JSON.stringify(res.body).includes("geheimer_eintrag"));
  });

  it("/api/geraete ist im Notfall gesperrt und fragt nichts an", async () => {
    state.notfall = NOTFALL();
    const res = antwort();
    await geraete(req() as never, res as never);
    assert.equal(res.statusCode, 423);
    assert.equal((res.body as { error?: string }).error, "notfall");
    assert.deepEqual(aufrufe, []);
  });
});

describe("Dashboard /api/protokoll im Notaus und Notfall", () => {
  it("antwortet mit 423, führt nichts aus und legt keinen Auftrag an", async () => {
    const zeit = new Date(Date.now() + 3_600_000).toISOString();
    protokolle["testauto"] = { beschreibung: "Test", stufe: "auto", schritte: [{ tool: "erinnerung", input: { zeit, text: "Protokoll" } }] };
    protokolle["testextern"] = { beschreibung: "Test", stufe: "extern", schritte: [{ tool: "erinnerung", input: { zeit, text: "Protokoll" } }] };
    try {
      for (const sperre of [() => { state.paused = true; }, () => { state.notfall = NOTFALL(); }]) {
        for (const name of ["testauto", "testextern"]) {
          state.paused = false;
          state.notfall = { aktiv: false };
          sperre();
          const vorher = auftraege.length;
          const res = antwort();
          await protokollAction(req({ body: { name } }) as never, res as never);
          assert.equal(res.statusCode, 423, `${name} hätte gesperrt sein müssen`);
          assert.equal((res.body as { ok?: boolean }).ok, false);
          // Das Dashboard zeigt `text`; ohne ihn meldete es bei 423 fest «Im Notfall gesperrt … /entwarnung»
          const b = res.body as { error?: string; text?: string };
          assert.equal(typeof b.text, "string", "Ablehnungstext im Feld text");
          if (state.notfall?.aktiv) {
            assert.equal(b.error, "notfall");
            assert.match(b.text!, /entwarnung/);
          } else {
            assert.equal(b.error, "pausiert");
            assert.match(b.text!, /Notaus/);
            assert.ok(!/Notfall|entwarnung/i.test(b.text!), "im reinen Notaus kein Notfall-Text");
          }
          assert.equal(auftraege.length, vorher, "kein Auftrag im Notaus/Notfall");
          assert.equal(reminders.length, 0, "kein Werkzeug lief");
          assert.deepEqual(aufrufe, []);
        }
      }
    } finally {
      delete protokolle["testauto"];
      delete protokolle["testextern"];
    }
  });
});

describe("Dashboard /api/protokoll: Notfall während des Laufs", () => {
  it("auto-Protokoll: kommt der Notfall während eines Schritts, keine Ergebniszeilen (423)", async () => {
    const vorher = config.homeAssistant;
    (config as { homeAssistant: unknown }).homeAssistant = { url: "http://ha.attrappe", token: "attrappe" };
    protokolle["testha"] = { beschreibung: "Test", stufe: "auto", schritte: [{ tool: "geraete_status", input: {} }, { tool: "geraete_status", input: {} }] };
    try {
      const ohne = antwort();
      await protokollAction(req({ body: { name: "testha" } }) as never, ohne as never);
      assert.equal(ohne.statusCode, 200);
      assert.match(JSON.stringify(ohne.body), /Haustür|haustuer/, "ohne Notfall kommen die Zustände an");

      aufrufe = [];
      beimAbruf = () => { state.notfall = NOTFALL(); };
      const res = antwort();
      await protokollAction(req({ body: { name: "testha" } }) as never, res as never);
      assert.equal(aufrufe.filter((u) => u.startsWith("http://ha.attrappe/")).length, 1, "erster Schritt lief, der zweite nicht mehr");
      assert.equal(res.statusCode, 423);
      assert.equal((res.body as { error?: string }).error, "notfall");
      const roh = JSON.stringify(res.body);
      assert.ok(!/Haustür|haustuer|geraete_status/.test(roh), "keine Ergebniszeilen im Notfall");
    } finally {
      delete protokolle["testha"];
      (config as { homeAssistant: unknown }).homeAssistant = vorher;
    }
  });
});

describe("Dashboard /api/protokoll: unbekanntes Protokoll", () => {
  it("antwortet mit 404 und Text im Feld text", async () => {
    const res = antwort();
    await protokollAction(req({ body: { name: "gibtsnicht" } }) as never, res as never);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { ok: false, error: "nicht_gefunden", text: "Dieses Protokoll gibt es nicht, Sir." });
  });
});

describe("Dashboard mit von Hand bearbeiteter data/zeitplaene.json", () => {
  it("Einträge ohne tage oder zeit bringen /status.json und /api/zeitplaene nicht zum Absturz", () => {
    const vorher = zeitplaene.splice(0);
    try {
      // Wie nach einer Handbearbeitung: ladeListe prüft die Einträge nicht
      zeitplaene.push(
        { id: 1, name: "ohne Tage", zeit: "07:00", auftrag: "Briefing" } as never,
        { id: 2, name: "ohne Zeit", tage: "werktags", auftrag: "Briefing" } as never,
        { id: 3, name: "gültig", zeit: "07:00", tage: "So, sa", auftrag: "Briefing" },
      );
      const st = antwort();
      statusJson(req(), st as unknown as Res);
      assert.equal(st.statusCode, 200);
      const sb = st.body as { ok: boolean; zeitplaene: { id: number; zeit: string; tage: string }[] };
      assert.equal(sb.ok, true);
      assert.deepEqual(sb.zeitplaene.map((z) => [z.id, z.zeit, z.tage]), [[1, "07:00", ""], [2, "", "werktags"], [3, "07:00", "sa,so"]]);

      const li = antwort();
      zeitplaeneJson(req(), li as unknown as Res);
      assert.equal(li.statusCode, 200);
      const lb = li.body as { ok: boolean; zeitplaene: { id: number; tage: string; naechsterLauf?: string }[] };
      assert.equal(lb.ok, true);
      assert.equal(lb.zeitplaene.length, 3);
      assert.ok(!("naechsterLauf" in lb.zeitplaene[0]!), "ohne tage kein nächster Lauf");
      assert.ok(!("naechsterLauf" in lb.zeitplaene[1]!), "ohne zeit kein nächster Lauf");
      assert.equal(typeof lb.zeitplaene[2]!.naechsterLauf, "string", "der gültige Eintrag rechnet weiter");
    } finally {
      zeitplaene.splice(0, zeitplaene.length, ...vorher);
    }
  });

  it("Einträge ohne name oder auftrag liefern leere Texte statt undefined (sonst stünde «undefined» im Bearbeiten-Dialog)", () => {
    const vorher = zeitplaene.splice(0);
    try {
      // Wie nach einer Handbearbeitung: name bzw. auftrag fehlen oder sind keine Texte
      zeitplaene.push(
        { id: 11, zeit: "07:00", tage: "werktags" } as never,
        { id: 12, name: "ohne Auftrag", zeit: "07:00", tage: "werktags" } as never,
        { id: 13, name: 42, zeit: "07:00", tage: "werktags", auftrag: null } as never,
        { id: 14, name: "gültig", zeit: "07:00", tage: "werktags", auftrag: "Briefing" },
      );
      const li = antwort();
      zeitplaeneJson(req(), li as unknown as Res);
      assert.equal(li.statusCode, 200);
      const lb = li.body as { zeitplaene: { id: number; name: unknown; auftrag: unknown }[] };
      assert.deepEqual(lb.zeitplaene.map((z) => [z.id, z.name, z.auftrag]), [[11, "", ""], [12, "ohne Auftrag", ""], [13, "", ""], [14, "gültig", "Briefing"]]);
      // Ohne Auftrag läuft er nie (zeitplaene.ts): kein nächster Lauf, der Grund steht dabei; mit Auftrag kein Grund
      const roh = li.body as { zeitplaene: { id: number; naechsterLauf?: string; laeuft?: boolean; grund?: string }[] };
      assert.deepEqual(roh.zeitplaene.map((z) => [z.id, z.laeuft, z.grund, typeof z.naechsterLauf]), [
        [11, false, "Auftrag fehlt", "undefined"], [12, false, "Auftrag fehlt", "undefined"], [13, false, "Auftrag fehlt", "undefined"], [14, undefined, undefined, "string"],
      ]);
      // Über HTTP liesse res.json undefined-Schlüssel weg: beide Felder müssen als Text dastehen
      for (const z of JSON.parse(JSON.stringify(lb)).zeitplaene as Record<string, unknown>[]) {
        assert.equal(typeof z.name, "string", `#${z.id} name`);
        assert.equal(typeof z.auftrag, "string", `#${z.id} auftrag`);
      }

      const st = antwort();
      statusJson(req(), st as unknown as Res);
      assert.equal(st.statusCode, 200);
      const sb = JSON.parse(JSON.stringify(st.body)) as { zeitplaene: { id: number; name: unknown }[] };
      assert.deepEqual(sb.zeitplaene.map((z) => [z.id, z.name]), [[11, ""], [12, "ohne Auftrag"], [13, ""], [14, "gültig"]]);
      assert.ok(!JSON.stringify(sb.zeitplaene).includes("undefined"));
    } finally {
      zeitplaene.splice(0, zeitplaene.length, ...vorher);
    }
  });

  it("ein Eintrag ohne tage lässt sich über das Dashboard reparieren", () => {
    const vorher = zeitplaene.splice(0);
    try {
      zeitplaene.push({ id: 7, name: "ohne Tage", zeit: "07:00", auftrag: "Briefing" } as never);
      const res = antwort();
      zeitplanAendern(req({ params: { id: "7" }, body: { name: "repariert", zeit: "07:00", tage: "werktags", auftrag: "Briefing" } }) as never, res as never);
      assert.equal(res.statusCode, 200);
      assert.equal(zeitplaene[0]!.tage, "werktags");
    } finally {
      zeitplaene.splice(0, zeitplaene.length, ...vorher);
    }
  });
});

describe("Dashboard mit von Hand bearbeiteten Wachen", () => {
  it("eine Wache ohne frage bringt /status.json und /api/wachen nicht zum Absturz", () => {
    const vorher = dynamicWachen.splice(0);
    try {
      // Wie nach einer Handbearbeitung von data/wachen.json: dynamicWachen prüft die Einträge nicht
      dynamicWachen.push({ id: 3, kamera: "einfahrt", alle_minuten: 30 } as never);
      const st = antwort();
      statusJson(req(), st as unknown as Res);
      assert.equal(st.statusCode, 200);
      const sb = st.body as { ok: boolean; wachen: { kamera: string; frage: string; alle_minuten: number }[] };
      assert.equal(sb.ok, true);
      assert.deepEqual(sb.wachen.find((w) => w.alle_minuten === 30), { kamera: "einfahrt", frage: "", alle_minuten: 30, laeuft: false, grund: "Frage fehlt" });

      const li = antwort();
      wachenJson(req(), li as unknown as Res);
      assert.equal(li.statusCode, 200);
      const lb = li.body as { ok: boolean; wachen: { id?: number; frage: string }[] };
      assert.equal(lb.ok, true);
      assert.equal(lb.wachen.find((w) => w.id === 3)?.frage, "");
    } finally {
      dynamicWachen.splice(0, dynamicWachen.length, ...vorher);
    }
  });
});
