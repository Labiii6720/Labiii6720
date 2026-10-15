import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/ liegt relativ) und Umgebung; nie echte Dienste
const temp = mkdtempSync(join(tmpdir(), "jarvis-notfall-"));
process.chdir(temp);
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.JARVIS_PANIC_TOKEN = "panik-test-token-0123456789";

/** true: Telegram gestört (Netzfehler), false: Attrappe antwortet ok */
let gestoert = false;
let gesendet: string[] = [];
/** true: Telegram nimmt die Verbindung an und antwortet nicht (bis der Test die Anfrage per Zeitlimit abbricht) */
let haengend = false;
const offen: ((e: unknown) => void)[] = [];
const zeitlimit = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  if (haengend) return new Promise<Response>((_ok, fehler) => offen.push(fehler));
  if (gestoert) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }) });
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  if (body.text) gesendet.push(body.text);
  return new Response(JSON.stringify({ ok: true, result: { message_id: gesendet.length } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { state } = await import("../src/state.js");
const { abhaengigkeiten, postausgangTick, sendeSpaeter, setzeWarten, verteileUpdate } = await import("../src/telegram.js");
const { ausloesen, aufheben, handlePanic, notfallAktiv } = await import("../src/notfall.js");

const POSTAUSGANG = join(temp, "data", "postausgang.json");
const liesPostausgang = (): { text: string }[] => {
  try {
    return JSON.parse(readFileSync(POSTAUSGANG, "utf8")) as { text: string }[];
  } catch {
    return [];
  }
};

beforeEach(async () => {
  gestoert = false;
  haengend = false;
  aufheben();
  await postausgangTick();
  gesendet = [];
  setzeWarten(async () => {}, () => 0.5);
});

describe("Notfall-Alarm", () => {
  it("ohne Störung: Alarm samt Checkliste geht direkt raus, nichts im Postausgang", async () => {
    await ausloesen("Panik-Auslöser vom Gerät.");
    assert.equal(notfallAktiv(), true);
    assert.equal(state.paused, true);
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0], /^🚨 NOTFALL ausgelöst: Panik-Auslöser vom Gerät\./);
    assert.match(gesendet[0], /@BotFather/);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("Telegram gestört: Alarm bleibt im Postausgang und wird nachgereicht", async () => {
    gestoert = true;
    await ausloesen("Ungewöhnlich viele unbefugte Zugriffe (events).");
    assert.equal(notfallAktiv(), true);
    assert.equal(gesendet.length, 0);
    const wartend = liesPostausgang();
    assert.equal(wartend.length, 1);
    assert.match(wartend[0].text, /^🚨 NOTFALL ausgelöst/);
    assert.match(wartend[0].text, /@BotFather/);

    gestoert = false;
    await postausgangTick();
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0], /^\(nachgereicht, \d{2}:\d{2}\) 🚨 NOTFALL ausgelöst/);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("Rückstand im Postausgang: Alarm geht sofort und vor den alten Einträgen raus", async () => {
    gestoert = true;
    await sendeSpaeter("alt 1");
    await sendeSpaeter("alt 2");
    assert.equal(liesPostausgang().length, 2);
    gestoert = false;

    await ausloesen("Panik-Auslöser vom Gerät.");
    assert.equal(gesendet.length, 1, "Alarm darf nicht auf den nächsten Tick warten");
    assert.match(gesendet[0], /^🚨 NOTFALL ausgelöst: Panik-Auslöser vom Gerät\./);
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["alt 1", "alt 2"], "Alarm nicht zusätzlich im Postausgang");
  });

  it("Rückstand und Telegram gestört: Alarm wird nicht verworfen", async () => {
    gestoert = true;
    await sendeSpaeter("alt 1");
    await ausloesen("Manuell über Telegram ausgelöst.");
    const wartend = liesPostausgang();
    assert.equal(wartend.length, 2);
    assert.match(wartend[0].text, /^🚨 NOTFALL ausgelöst: Manuell/, "Alarm vorn, nicht hinter dem Rückstand");
    assert.equal(wartend[1].text, "alt 1");
    assert.equal(gesendet.length, 0);
  });

  it("während des Notfalls reicht der Postausgang nur den Alarm nach, Altes erst nach der Entwarnung", async () => {
    gestoert = true;
    await sendeSpaeter("alter Rückblick");
    await new Promise((r) => setTimeout(r, 5)); // Zeitstempel sicher vor der Auslösung
    await ausloesen("Manuell über Telegram ausgelöst.");
    gestoert = false;

    await postausgangTick();
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0], /^\(nachgereicht, \d{2}:\d{2}\) 🚨 NOTFALL ausgelöst/);
    assert.deepEqual(liesPostausgang().map((e) => e.text), ["alter Rückblick"], "Altes bleibt liegen");

    await postausgangTick();
    assert.equal(gesendet.length, 1, "auch beim nächsten Tick nichts Altes");

    aufheben();
    await postausgangTick();
    assert.equal(gesendet.length, 2);
    assert.match(gesendet[1], /alter Rückblick$/);
    assert.deepEqual(liesPostausgang(), []);
  });
});

/** Minimale Express-Attrappen für den Panik-Endpunkt */
function anfrage(authorization?: string) {
  return { header: (n: string) => (n.toLowerCase() === "authorization" ? authorization : undefined) } as unknown as import("express").Request;
}
function antwort() {
  const r = { status: 200, body: undefined as unknown, gesendet: false };
  const res = {
    status(code: number) {
      r.status = code;
      return res;
    },
    json(b: unknown) {
      r.body = b;
      r.gesendet = true;
      return res;
    },
  };
  return { r, res: res as unknown as import("express").Response };
}
const leerlauf = () => new Promise((fertig) => setImmediate(fertig));

describe("Panik-Endpunkt", () => {
  it("antwortet sofort, auch wenn Telegram hängt; der Alarm geht danach raus", async () => {
    haengend = true;
    const { r, res } = antwort();
    const lauf = handlePanic(anfrage("Bearer panik-test-token-0123456789"), res);
    await leerlauf();
    assert.equal(r.gesendet, true, "Antwort darf nicht auf den Alarmversand warten");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(notfallAktiv(), true);
    assert.equal(state.paused, true);
    assert.equal(offen.length, 1, "Alarmversand läuft noch");
    assert.equal(gesendet.length, 0);

    // Erster Versuch läuft ins Zeitlimit, die Wiederholung kommt durch
    haengend = false;
    offen.shift()?.(zeitlimit());
    await lauf;
    assert.equal(gesendet.length, 1);
    assert.match(gesendet[0], /^🚨 NOTFALL ausgelöst: Panik-Auslöser vom Gerät\./);
    assert.deepEqual(liesPostausgang(), []);
  });

  it("falscher Token: 401, kein Notfall, nichts gesendet", async () => {
    const { r, res } = antwort();
    await handlePanic(anfrage("Bearer falsch-falsch-falsch-falsch"), res);
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { ok: false });
    assert.equal(notfallAktiv(), false);
    assert.equal(gesendet.length, 0);
    // Spur im Audit, gedrosselt: ein zweiter Fehlversuch in derselben Minute schreibt keine weitere Zeile
    await handlePanic(anfrage("Bearer falsch-falsch-falsch-falsch"), antwort().res);
    const zeilen = readFileSync(join(temp, "data", "audit.log"), "utf8").split("\n").filter((z) => z.includes("notfall_abgewiesen"));
    assert.equal(zeilen.length, 1);
    assert.ok(!zeilen[0]!.includes("falsch-falsch"), "kein Token im Audit");
  });

  it("bereits aktiver Notfall: Antwort ok, kein zweiter Alarm", async () => {
    await ausloesen("Manuell über Telegram ausgelöst.");
    assert.equal(gesendet.length, 1);
    const { r, res } = antwort();
    await handlePanic(anfrage("Bearer panik-test-token-0123456789"), res);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(gesendet.length, 1);
  });
});

describe("Notaus-Reihenfolge bei Auslösung ausserhalb von Telegram", () => {
  const nachricht = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: 12345 }, text } });

  /** Erste Nachricht hängt bei Claude, dahinter wird /entwarnung eingereiht; dann `ausloesen` direkt (Panik, Dashboard, abuseSignal). */
  async function entwarnungVorAusloesen(startId: number, vorher: () => Promise<void>): Promise<void> {
    const orig = abhaengigkeiten.handleMessage;
    let freigeben!: () => void;
    const haengt = new Promise<void>((r) => { freigeben = r; });
    let gestartet = false;
    abhaengigkeiten.handleMessage = async () => { gestartet = true; await haengt; return "fertig"; };
    try {
      await vorher();
      const frage = verteileUpdate(nachricht(startId, "Frage"));
      for (let i = 0; i < 100 && !gestartet; i++) await leerlauf();
      assert.equal(gestartet, true);
      const entwarnung = verteileUpdate(nachricht(startId + 1, "/entwarnung"));
      await ausloesen("Panik-Auslöser vom Gerät.");
      freigeben();
      await Promise.all([frage, entwarnung]);
    } finally {
      abhaengigkeiten.handleMessage = orig;
    }
  }

  it("ein vor dem Panik-Auslöser eingereihtes /entwarnung hebt den Notfall nicht auf", async () => {
    await entwarnungVorAusloesen(5001, async () => {});
    assert.equal(notfallAktiv(), true);
    assert.equal(state.paused, true);
    assert.ok(gesendet.includes("/entwarnung kam vor dem Notaus an und gilt nicht, Sir. Bitte erneut senden."));
    assert.ok(!gesendet.some((t) => t.startsWith("✅ Entwarnung.")));
  });

  it("auch wenn der Notfall schon aktiv war, gilt der erneute Auslöser", async () => {
    await entwarnungVorAusloesen(5011, () => ausloesen("Manuell über Telegram ausgelöst."));
    assert.equal(notfallAktiv(), true);
    assert.equal(state.paused, true);
    assert.ok(gesendet.includes("/entwarnung kam vor dem Notaus an und gilt nicht, Sir. Bitte erneut senden."));
  });

  it("ein nach dem Auslöser getipptes /entwarnung gilt weiterhin", async () => {
    await ausloesen("Panik-Auslöser vom Gerät.");
    await verteileUpdate(nachricht(5021, "/entwarnung"));
    assert.equal(notfallAktiv(), false);
    assert.equal(state.paused, false);
    assert.ok(gesendet.some((t) => t.startsWith("✅ Entwarnung.")));
  });
});
