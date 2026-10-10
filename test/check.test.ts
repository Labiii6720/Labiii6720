import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// Vor dem Import: Temp-Verzeichnis (data/, cameras.json, protokolle.json werden relativ gelesen) und Attrappen
const temp = mkdtempSync(join(tmpdir(), "jarvis-check-"));
process.chdir(temp);
after(() => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";

// Stummer TCP-Listener: nimmt Verbindungen an, antwortet nie – simuliert eine hängende Claude-API
const stumm = createServer((socket) => socket.on("error", () => {}));
await new Promise<void>((ok) => stumm.listen(0, "127.0.0.1", ok));
after(() => stumm.close());
process.env.ANTHROPIC_API_KEY = "sk-ant-attrappe-nur-fuer-tests";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(stumm.address() as AddressInfo).port}`;

let aufrufe = 0;
const echterFetch = globalThis.fetch;
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  // Das Anthropic-SDK darf nur den stummen Listener erreichen
  if (String(eingabe instanceof Request ? eingabe.url : eingabe).startsWith(process.env.ANTHROPIC_BASE_URL!)) return echterFetch(eingabe, init);
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

  it("Prüfung ohne Netz läuft allein (kein fetch)", async () => {
    aufrufe = 0;
    const b = await selbsttest(["Sicherheit"]);
    assert.equal(b.length, 1);
    assert.equal(b[0].name, "Sicherheit");
    assert.equal(aufrufe, 0);
  });

  it("Claude-API: hängende Verbindung → ein Versuch, fehler nach unter 20 s", { timeout: 25_000 }, async () => {
    const start = Date.now();
    const b = await selbsttest(["Claude-API"]);
    const dauer = Date.now() - start;
    assert.equal(b.length, 1);
    assert.equal(b[0].name, "Claude-API");
    assert.equal(b[0].status, "fehler");
    assert.ok(dauer < 20_000, `Selbsttest brauchte ${dauer} ms (SDK wiederholt den Aufruf?)`);
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
