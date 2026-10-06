import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/, cameras.json, protokolle.json werden relativ gelesen) und Attrappen
const temp = mkdtempSync(join(tmpdir(), "jarvis-check-"));
process.chdir(temp);
after(() => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";

let aufrufe = 0;
globalThis.fetch = (async (eingabe: string | URL | Request) => {
  aufrufe++;
  assert.ok(String(eingabe).startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${eingabe}`);
  return new Response(JSON.stringify({ ok: true, result: { username: "jarvis_test_bot" } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { nurAusArgv, selbsttest } = await import("../src/check.js");

describe("selbsttest(nur)", () => {
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

  it("Prüfung ohne Netz läuft allein (kein fetch)", async () => {
    aufrufe = 0;
    const b = await selbsttest(["Sicherheit"]);
    assert.equal(b.length, 1);
    assert.equal(b[0].name, "Sicherheit");
    assert.equal(aufrufe, 0);
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
