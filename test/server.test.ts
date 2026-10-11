import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

// server.ts startet beim Laden (listen, Zeitpläne): deshalb als Kindprozess im Temp-Ordner,
// mit sauberer Umgebung (keine echten Geheimnisse) und einer fetch-Attrappe, die jeden Aufruf nach aussen abweist.
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-server-"));
const TOKEN = "ereignis-token-nur-attrappe-0123456789";
const attrappe = join(temp, "fetch-attrappe.mjs");
writeFileSync(attrappe, 'globalThis.fetch = async () => { throw new Error("kein Netz im Test"); };\n');

const freierPort = () =>
  new Promise<number>((ok, fehler) => {
    const s = createServer();
    s.once("error", fehler);
    s.listen(0, "127.0.0.1", () => {
      const adresse = s.address();
      const port = typeof adresse === "object" && adresse ? adresse.port : 0;
      s.close(() => ok(port));
    });
  });

interface Antwort { status: number }
const anfrage = (port: number, methode: string, pfad: string, kopf: Record<string, string> = {}) =>
  new Promise<Antwort>((ok, fehler) => {
    const r = request({ host: "127.0.0.1", port, method: methode, path: pfad, headers: { "content-type": "application/json", ...kopf } }, (res) => {
      res.resume();
      res.on("end", () => ok({ status: res.statusCode ?? 0 }));
    });
    r.on("error", fehler);
    r.end(methode === "POST" ? "{}" : undefined);
  });

let kind: ChildProcess | undefined;
let port = 0;
let ausgabe = "";

before(async () => {
  port = await freierPort();
  kind = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(attrappe).href, join(projekt, "src/server.ts")], {
    cwd: temp,
    // Bewusst ohne ALEXA_SKILL_ID und ohne Telegram: der Dienst muss trotzdem starten
    env: { PATH: process.env.PATH ?? "", HOME: temp, PORT: String(port), LISTEN_HOST: "127.0.0.1", JARVIS_EVENT_TOKEN: TOKEN, EVENTS_VIA_TUNNEL: "on" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  kind.stdout?.on("data", (d: Buffer) => (ausgabe += d.toString()));
  kind.stderr?.on("data", (d: Buffer) => (ausgabe += d.toString()));
  await new Promise<void>((ok, fehler) => {
    const warte = setInterval(() => {
      if (!ausgabe.includes("Jarvis läuft")) return;
      clearInterval(warte);
      clearTimeout(frist);
      ok();
    }, 20);
    const frist = setTimeout(() => { clearInterval(warte); fehler(new Error(`Server nicht gestartet:\n${ausgabe}`)); }, 4500);
    kind!.once("exit", (code) => { clearInterval(warte); clearTimeout(frist); fehler(new Error(`Server beendet (${code}):\n${ausgabe}`)); });
  });
});

after(() => {
  kind?.removeAllListeners("exit");
  kind?.kill("SIGKILL");
  rmSync(temp, { recursive: true, force: true });
});

describe("server.ts: Start und Netzsperren", () => {
  it("startet ohne ALEXA_SKILL_ID, /alexa bleibt aus", async () => {
    assert.match(ausgabe, /Alexa nicht konfiguriert/);
    assert.equal((await anfrage(port, "GET", "/health")).status, 200);
    assert.equal((await anfrage(port, "POST", "/alexa")).status, 404);
  });

  it("Dashboard und /api/* über den Tunnel → 404, auch mit EVENTS_VIA_TUNNEL=on", async () => {
    const tunnel: Record<string, string>[] = [{ "cf-connecting-ip": "203.0.113.7" }, { "cf-ray": "8a1b2c3d4e5f-ZRH" }];
    const ziele: [string, string][] = [
      ["GET", "/status.json"], ["POST", "/api/auftrag"], ["GET", "/api/finanzen"], ["GET", "/dashboard"],
      ["POST", "/api/chat"], ["GET", "/api/kamera/garten"], ["GET", "/api/audit"],
    ];
    for (const kopf of tunnel) {
      for (const [methode, pfad] of ziele) {
        // Mit gültigem Token: nur die Netzsperre darf hier abweisen
        const { status } = await anfrage(port, methode, pfad, { ...kopf, authorization: `Bearer ${TOKEN}` });
        assert.equal(status, 404, `${methode} ${pfad} mit ${Object.keys(kopf)[0]}`);
      }
    }
  });

  it("aus dem Heimnetz bleibt das Dashboard erreichbar (Token-Prüfung greift)", async () => {
    assert.equal((await anfrage(port, "GET", "/status.json")).status, 401);
    assert.equal((await anfrage(port, "GET", "/api/finanzen")).status, 401);
  });

  it("/events folgt weiterhin EVENTS_VIA_TUNNEL=on (Token-Prüfung statt 404)", async () => {
    assert.equal((await anfrage(port, "POST", "/events", { "cf-ray": "8a1b2c3d4e5f-ZRH" })).status, 401);
    assert.equal((await anfrage(port, "OPTIONS", "/events", { "cf-ray": "8a1b2c3d4e5f-ZRH" })).status, 204);
    assert.equal((await anfrage(port, "GET", "/gesture", { "cf-connecting-ip": "203.0.113.7" })).status, 200);
  });
});
