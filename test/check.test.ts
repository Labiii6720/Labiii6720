import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/, cameras.json, protokolle.json werden relativ gelesen) und Attrappen
const temp = mkdtempSync(join(tmpdir(), "jarvis-check-"));
process.chdir(temp);
// Im Temp-Ordner bleiben bis zum Prozessende (spätes Schreiben landet nie im Projekt), dann aufräumen
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";

// Claude-API: kein Netz. Der fetch-Ersatz unten wirft für diese Adresse sofort das, was undici beim
// Zeitlimit des SDK wirft (AbortError) – so verhält sich das SDK wie bei einer hängenden Verbindung, ohne echten Timer.
process.env.ANTHROPIC_API_KEY = "sk-ant-attrappe-nur-fuer-tests";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";

let aufrufe = 0;
let claudeVersuche = 0;
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  if (String(eingabe instanceof Request ? eingabe.url : eingabe).startsWith(process.env.ANTHROPIC_BASE_URL!)) {
    claudeVersuche++;
    throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  }
  aufrufe++;
  // Wie Node/undici bei einer URL mit Zugangsdaten (FRIGATE_URL=http://user:pw@…)
  if (/^\w+:\/\/[^/@\s]+@/.test(String(eingabe))) throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${eingabe}`);
  assert.ok(String(eingabe).startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${eingabe}`);
  return new Response(JSON.stringify({ ok: true, result: { username: "jarvis_test_bot" } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { nurAusArgv, selbsttest } = await import("../src/check.js");

describe("selbsttest(nur)", () => {
  it("Finanzen ohne rechnungen.json: ok mit Anzahl, ohne Netz", async () => {
    aufrufe = 0;
    const b = await selbsttest(["Finanzen"]);
    assert.deepEqual(b, [{ name: "Finanzen", status: "ok", info: "0 Rechnung(en) erfasst" }]);
    assert.equal(aufrufe, 0);
  });

  it("Profil ohne profil.json: ok, noch nicht angelegt, ohne Netz", async () => {
    aufrufe = 0;
    const b = await selbsttest(["Profil"]);
    assert.deepEqual(b, [{ name: "Profil", status: "ok", info: "data/profil.json noch nicht angelegt" }]);
    assert.equal(aufrufe, 0);
  });

  it("Listen ohne Dateien in data/: ok mit Anzahl, ohne Netz und ohne Sicherung", async () => {
    aufrufe = 0;
    const b = await selbsttest(["Listen"]);
    // Früher «7 Listen in data/ lesbar», obwohl keine einzige Datei existierte
    assert.deepEqual(b, [{ name: "Listen", status: "ok", info: "0 Listen in data/ lesbar, 7 noch nicht angelegt, 0 gültige Einträge" }]);
    assert.equal(aufrufe, 0);
  });

  it("Zustand ohne state.json: ok, noch nicht angelegt", async () => {
    assert.deepEqual(await selbsttest(["Zustand"]), [{ name: "Zustand", status: "ok", info: "data/state.json noch nicht angelegt" }]);
  });

  it("nur Telegram: ein Befund, ok, genau ein fetch-Aufruf", async () => {
    aufrufe = 0;
    const b = await selbsttest(["Telegram"]);
    assert.equal(b.length, 1);
    assert.equal(b[0].name, "Telegram");
    assert.equal(b[0].status, "ok");
    assert.ok(b[0].info.includes("jarvis_test_bot"));
    assert.equal(aufrufe, 1);
  });

  it("Gross-/Kleinschreibung egal, unbekannte Namen → fehler", async () => {
    aufrufe = 0;
    const b = await selbsttest(["telegram", "Gibtsnicht"]);
    assert.equal(b.length, 2);
    assert.equal(b[0].name, "Telegram");
    assert.deepEqual(b[1], { name: "Gibtsnicht", status: "fehler", info: "unbekannte Prüfung" });
    assert.equal(aufrufe, 1);
  });

  it("beiBefund wird je Befund sofort und in Reihenfolge gerufen", async () => {
    aufrufe = 0;
    const gemeldet: string[] = [];
    const b = await selbsttest(["Telegram", "Sicherheit"], (x) => gemeldet.push(x.name));
    assert.deepEqual(gemeldet, ["Telegram", "Sicherheit"]);
    assert.deepEqual(b.map((x) => x.name), gemeldet);
    const unbekannt: { name: string; info: string }[] = [];
    await selbsttest(["Sicherheit", "Gibtsnicht"], (x) => unbekannt.push({ name: x.name, info: x.info }));
    assert.deepEqual(unbekannt.map((x) => x.name), ["Sicherheit", "Gibtsnicht"]);
    assert.equal(unbekannt[1].info, "unbekannte Prüfung");
  });

  it("Befund «PIN»: ohne Ziffern Warnung, mit Ziffern ok, ohne PIN «fehlt» – ohne Netz, die PIN steht nie im Befund", async () => {
    const { config } = await import("../src/config.js");
    const vorher = config.pin;
    try {
      aufrufe = 0;
      config.pin = "Sesamoeffne";
      assert.deepEqual(await selbsttest(["PIN"]), [{ name: "PIN", status: "fehler", info: "PIN ohne Ziffern – bitte eine Ziffern-PIN wählen" }]);
      // Nur Sonderzeichen: der Eingangsfilter wirkte gar nicht, dieselbe Warnung
      config.pin = "####";
      assert.deepEqual(await selbsttest(["PIN"]), [{ name: "PIN", status: "fehler", info: "PIN ohne Ziffern – bitte eine Ziffern-PIN wählen" }]);
      config.pin = "4711";
      const ok = await selbsttest(["PIN"]);
      assert.equal(ok[0]!.status, "ok");
      assert.ok(!ok[0]!.info.includes("4711"));
      config.pin = undefined;
      assert.equal((await selbsttest(["PIN"]))[0]!.status, "fehlt");
      assert.equal(aufrufe, 0);
    } finally {
      config.pin = vorher;
    }
  });

  it("Prüfung ohne Netz läuft allein (kein fetch)", async () => {
    aufrufe = 0;
    const b = await selbsttest(["Sicherheit"]);
    assert.equal(b.length, 1);
    assert.equal(b[0].name, "Sicherheit");
    assert.equal(aufrufe, 0);
  });

  it("Claude-API: Zeitlimit → genau ein Verbindungsversuch (maxRetries 0), fehler", async () => {
    aufrufe = 0;
    claudeVersuche = 0;
    const b = await selbsttest(["Claude-API"]);
    assert.equal(b.length, 1);
    assert.equal(b[0].name, "Claude-API");
    assert.equal(b[0].status, "fehler");
    assert.match(b[0].info, /timed out/i);
    assert.equal(claudeVersuche, 1, "SDK wiederholt den Aufruf (maxRetries fehlt?)");
    assert.equal(aufrufe, 0);
  });
});

describe("selbsttest: Alexa-Skill wertet ALEXA_NACHT wie die Laufzeit (nachtFenster/istNacht)", () => {
  it("OFF ungültig, gleiche Grenzen = leeres Fenster, off und echtes Fenster ok; kein fetch", async () => {
    const { config } = await import("../src/config.js");
    const vorher = config.alexaNacht;
    process.env.ALEXA_SKILL_ID = "amzn1.ask.skill.00000000-0000-0000-0000-000000000000";
    aufrufe = 0;
    const pruefe = async (wert: string) => {
      config.alexaNacht = wert;
      const b = await selbsttest(["Alexa-Skill"]);
      assert.equal(b.length, 1);
      return b[0];
    };
    try {
      for (const wert of ["OFF", "Off"]) {
        const b = await pruefe(wert);
        assert.equal(b.status, "fehler", wert);
        assert.match(b.info, new RegExp(`ALEXA_NACHT «${wert}» ungültig`));
      }
      const leer = await pruefe("22:00-22:00");
      assert.equal(leer.status, "fehler");
      assert.match(leer.info, /Fenster leer.*nur im Nachtmodus/);
      assert.doesNotMatch(leer.info, /22:00-22:00 und im Nachtmodus/);
      const aus = await pruefe("off");
      assert.equal(aus.status, "ok");
      assert.match(aus.info, /nur im Nachtmodus/);
      const fenster = await pruefe("22:00-06:30");
      assert.equal(fenster.status, "ok");
      assert.match(fenster.info, /22:00-06:30 und im Nachtmodus/);
      assert.equal(aufrufe, 0);
    } finally {
      config.alexaNacht = vorher;
      delete process.env.ALEXA_SKILL_ID;
    }
  });
});

describe("selbsttest: Fehlertexte geschwärzt (gehen per /check nach Telegram)", () => {
  it("FRIGATE_URL mit Passwort: Befund fehler, Passwort und Benutzer nicht im info", async () => {
    const { config } = await import("../src/config.js");
    const vorher = config.frigateUrl;
    config.frigateUrl = "http://admin:geheimpw123@192.168.1.20:5000";
    aufrufe = 0;
    try {
      const b = await selbsttest(["Frigate"]);
      assert.equal(b.length, 1);
      assert.equal(b[0].status, "fehler");
      assert.equal(aufrufe, 1);
      assert.match(b[0].info, /credentials/);
      assert.doesNotMatch(b[0].info, /geheimpw123/);
      assert.doesNotMatch(b[0].info, /admin:/);
      assert.match(b[0].info, /<geheim>@192\.168\.1\.20/);
    } finally {
      config.frigateUrl = vorher;
    }
  });
});

describe("nurAusArgv", () => {
  it("liest --nur a,b", () => {
    assert.deepEqual(nurAusArgv(["node", "check", "--nur", "Telegram,Frigate"]), ["Telegram", "Frigate"]);
    assert.deepEqual(nurAusArgv(["node", "check", "--nur=Telegram, Frigate"]), ["Telegram", "Frigate"]);
  });
  it("ohne Flag oder leer → undefined", () => {
    assert.equal(nurAusArgv(["node", "check"]), undefined);
    assert.equal(nurAusArgv(["node", "check", "--nur", ""]), undefined);
    assert.equal(nurAusArgv(["node", "check", "--nur"]), undefined);
  });
});
