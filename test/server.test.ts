import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// Erwartetes Handmodell nur für diesen Test: Inhalt «attrappe» gilt als geprüft (der echte Wert bleibt unberührt)
const MODELL_ERWARTET = { bytes: 8, sha256: createHash("sha256").update("attrappe").digest("hex") };
writeFileSync(
  attrappe,
  'globalThis.fetch = async () => { throw new Error("kein Netz im Test"); };\n' +
    `globalThis[Symbol.for("jarvis.test.modellErwartet")] = ${JSON.stringify(MODELL_ERWARTET)};\n`,
);

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

const PANIK = "panik-token-nur-attrappe-0123456789";

interface Antwort { status: number; text: string; kopf: Record<string, string | string[] | undefined> }
const anfrage = (port: number, methode: string, pfad: string, kopf: Record<string, string> = {}, inhalt?: string) =>
  new Promise<Antwort>((ok, fehler) => {
    const r = request({ host: "127.0.0.1", port, method: methode, path: pfad, headers: { "content-type": "application/json", ...kopf } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => (text += d));
      res.on("end", () => ok({ status: res.statusCode ?? 0, text, kopf: res.headers }));
    });
    r.on("error", fehler);
    r.end(inhalt ?? (methode === "POST" ? "{}" : undefined));
  });

let kind: ChildProcess | undefined;
let port = 0;
let ausgabe = "";
const startfristWunsch = Number(process.env.JARVIS_TEST_STARTFRIST_MS);
const startfrist = Number.isFinite(startfristWunsch) && startfristWunsch > 0 ? startfristWunsch : 30_000;

before(async () => {
  port = await freierPort();
  kind = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(attrappe).href, join(projekt, "src/server.ts")], {
    cwd: temp,
    // Bewusst ohne ALEXA_SKILL_ID und ohne Telegram: der Dienst muss trotzdem starten
    env: { PATH: process.env.PATH ?? "", HOME: temp, PORT: String(port), LISTEN_HOST: "127.0.0.1", JARVIS_EVENT_TOKEN: TOKEN, JARVIS_PANIC_TOKEN: PANIK, EVENTS_VIA_TUNNEL: "on" },
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
    // Nur Obergrenze: kalter tsx-Cache, parallele Testdateien oder der Pi brauchen deutlich mehr als 4,5 s
    const frist = setTimeout(() => {
      clearInterval(warte);
      kind?.removeAllListeners("exit");
      kind?.kill("SIGKILL");
      fehler(new Error(`Server nicht gestartet:\n${ausgabe}`));
    }, startfrist);
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
      ["POST", "/api/chat"], ["GET", "/api/chat/verlauf"], ["GET", "/api/kamera/garten"], ["GET", "/api/audit"],
      ["GET", "/dashboard/app.js"], ["GET", "/dashboard/app.css"], ["GET", "/api/auftraege"], ["GET", "/api/kosten"],
      ["GET", "/api/zeitplaene"], ["POST", "/api/zeitplaene"], ["PUT", "/api/zeitplaene/1"], ["DELETE", "/api/zeitplaene/1"],
      ["GET", "/api/wachen"], ["POST", "/api/wachen"], ["PUT", "/api/wachen/1"], ["DELETE", "/api/wachen/1"],
      ["POST", "/api/notaus"], ["POST", "/api/notfall"],
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

  it("/dashboard, app.css, app.js aus dem Heimnetz: CSP als Header mit genauem Wortlaut, Sicherheits-Header, richtiger Typ", async () => {
    const CSP =
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
    const routen: [string, RegExp][] = [
      ["/dashboard", /^text\/html; charset=utf-8$/i],
      ["/dashboard/app.css", /^text\/css; charset=utf-8$/i],
      ["/dashboard/app.js", /^text\/javascript; charset=utf-8$/i],
    ];
    for (const [pfad, typ] of routen) {
      // Ohne Token: die Dateien enthalten keine Daten
      const r = await anfrage(port, "GET", pfad);
      assert.equal(r.status, 200, pfad);
      assert.equal(r.kopf["content-security-policy"], CSP, pfad);
      assert.equal(r.kopf["x-content-type-options"], "nosniff", pfad);
      assert.equal(r.kopf["referrer-policy"], "no-referrer", pfad);
      assert.equal(r.kopf["x-frame-options"], "DENY", pfad);
      assert.match(String(r.kopf["content-type"]), typ, pfad);
      assert.ok(r.text.length > 0, pfad);
    }
    const seite = await anfrage(port, "GET", "/dashboard");
    assert.doesNotMatch(seite.text, /http-equiv/i, "keine Meta-CSP mehr");
    assert.doesNotMatch(seite.text, /<script(?![^>]*\ssrc=)[^>]*>/i, "kein Inline-Skript");
  });

  it("nur die drei festen Dateien: web/ ist nicht als Ordner erreichbar", async () => {
    for (const pfad of ["/dashboard/gesture.html", "/dashboard/dashboard.js", "/dashboard/../web/dashboard.js", "/web/dashboard.js", "/dashboard.js"]) {
      assert.equal((await anfrage(port, "GET", pfad)).status, 404, pfad);
    }
  });

  it("API mit Token: Cache-Control no-store", async () => {
    const r = await anfrage(port, "GET", "/api/kosten", { authorization: `Bearer ${TOKEN}` });
    assert.equal(r.status, 200);
    assert.equal(r.kopf["cache-control"], "no-store");
    assert.equal(r.kopf["x-content-type-options"], "nosniff");
    assert.equal((await anfrage(port, "GET", "/status.json")).kopf["cache-control"], "no-store");
  });

  it("/events folgt weiterhin EVENTS_VIA_TUNNEL=on (Token-Prüfung statt 404)", async () => {
    assert.equal((await anfrage(port, "POST", "/events", { "cf-ray": "8a1b2c3d4e5f-ZRH" })).status, 401);
    assert.equal((await anfrage(port, "OPTIONS", "/events", { "cf-ray": "8a1b2c3d4e5f-ZRH" })).status, 204);
    assert.equal((await anfrage(port, "GET", "/gesture", { "cf-connecting-ip": "203.0.113.7" })).status, 200);
    // lanOnly vor dem Router (app.use) prüft den vollen Pfad: die Konsole bleibt mit on über den Tunnel offen
    assert.equal((await anfrage(port, "GET", "/gesture", { "cf-ray": "8a1b2c3d4e5f-ZRH" })).status, 200);
    assert.equal((await anfrage(port, "OPTIONS", "/gesture", { "cf-ray": "8a1b2c3d4e5f-ZRH" })).status, 200);
    // … aber nur sie: Unterpfade und die Kommandozentrale nicht
    assert.equal((await anfrage(port, "GET", "/gesture/x", { "cf-ray": "8a1b2c3d4e5f-ZRH" })).status, 404);
    assert.equal((await anfrage(port, "OPTIONS", "/api/zeitplaene", { "cf-ray": "8a1b2c3d4e5f-ZRH" })).status, 404);
  });

  it("ungültiges JSON an /notfall über den Tunnel: 401 ohne Stacktrace, Parser läuft nicht vor dem Token", async () => {
    const r = await anfrage(port, "POST", "/notfall", { "cf-ray": "8a1b2c3d4e5f-ZRH" }, "{");
    assert.equal(r.status, 401);
    assert.doesNotMatch(r.text, /SyntaxError|node_modules|at parse|<pre>/);
    assert.doesNotMatch(r.text, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("ungültiges JSON an /events ohne Token: 401 statt Parser-Fehler, ohne Stacktrace", async () => {
    const r = await anfrage(port, "POST", "/events", { "cf-ray": "8a1b2c3d4e5f-ZRH" }, "{");
    assert.equal(r.status, 401);
    assert.doesNotMatch(r.text, /SyntaxError|node_modules|at parse|<pre>/);
  });

  it("ungültiges JSON an /events mit Token: 400 als JSON, ohne Stacktrace (eigener Fehlerhandler)", async () => {
    const r = await anfrage(port, "POST", "/events", { authorization: `Bearer ${TOKEN}` }, "{");
    assert.equal(r.status, 400);
    assert.deepEqual(JSON.parse(r.text), { ok: false });
    assert.doesNotMatch(r.text, /SyntaxError|node_modules|at parse/);
  });

  it("ungültiges JSON an /api/* mit Token aus dem Heimnetz: ebenfalls ohne Stacktrace", async () => {
    const r = await anfrage(port, "POST", "/api/chat", { authorization: `Bearer ${TOKEN}` }, "{");
    assert.doesNotMatch(r.text, /SyntaxError|node_modules|at parse/);
  });
});

describe("server.ts: Gesten-Konsole ohne CDN (feste Dateien, CSP, Netzregel)", () => {
  const CSP =
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src data:; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
  const DATEIEN: [string, RegExp][] = [
    ["/gesture", /^text\/html; charset=utf-8$/i],
    ["/gesture/app.js", /^text\/javascript; charset=utf-8$/i],
    ["/gesture/app.css", /^text\/css; charset=utf-8$/i],
    ["/gesture/mp/vision_bundle.mjs", /^text\/javascript; charset=utf-8$/i],
    ["/gesture/mp/wasm/vision_wasm_internal.js", /^text\/javascript; charset=utf-8$/i],
    ["/gesture/mp/wasm/vision_wasm_internal.wasm", /^application\/wasm$/i],
    ["/gesture/mp/wasm/vision_wasm_nosimd_internal.js", /^text\/javascript; charset=utf-8$/i],
    ["/gesture/mp/wasm/vision_wasm_nosimd_internal.wasm", /^application\/wasm$/i],
  ];
  const MODELL = "/gesture/mp/hand_landmarker.task";

  it("Whitelist aus dem Heimnetz: 200, richtiger Typ, CSP mit genauem Wortlaut, nosniff, no-referrer, DENY", async () => {
    for (const [pfad, typ] of DATEIEN) {
      const r = await anfrage(port, "GET", pfad);
      assert.equal(r.status, 200, pfad);
      assert.match(String(r.kopf["content-type"]), typ, pfad);
      assert.equal(r.kopf["content-security-policy"], CSP, pfad);
      assert.equal(r.kopf["x-content-type-options"], "nosniff", pfad);
      assert.equal(r.kopf["referrer-policy"], "no-referrer", pfad);
      assert.equal(r.kopf["x-frame-options"], "DENY", pfad);
      assert.ok(r.text.length > 0, pfad);
    }
    const seite = await anfrage(port, "GET", "/gesture");
    assert.doesNotMatch(seite.text, /<script(?![^>]*\ssrc=)[^>]*>/i, "kein Inline-Skript");
    assert.doesNotMatch(seite.text, /https?:\/\//i, "nichts von aussen");
  });

  it("Handmodell: ohne Datei 404, mit geprüfter Datei im Arbeitsordner 200 (application/octet-stream)", async () => {
    assert.equal((await anfrage(port, "GET", MODELL)).status, 404);
    mkdirSync(join(temp, "vendor", "mediapipe"), { recursive: true });
    writeFileSync(join(temp, "vendor", "mediapipe", "hand_landmarker.task"), "attrappe");
    try {
      const r = await anfrage(port, "GET", MODELL);
      assert.equal(r.status, 200);
      assert.equal(r.text, "attrappe");
      assert.equal(r.kopf["content-type"], "application/octet-stream");
      assert.equal(r.kopf["content-security-policy"], CSP);
      // über den Tunnel nur, weil EVENTS_VIA_TUNNEL=on die Konsole öffnet
      assert.equal((await anfrage(port, "GET", MODELL, { "cf-ray": "8a1b2c3d4e5f-ZRH" })).status, 200);
    } finally {
      rmSync(join(temp, "vendor"), { recursive: true, force: true });
    }
    assert.equal((await anfrage(port, "GET", MODELL)).status, 404);
  });

  it("Handmodell mit falscher Prüfsumme: 409 ohne Inhalt (mit CSP), einmal geloggt, nie ausgeliefert", async () => {
    mkdirSync(join(temp, "vendor", "mediapipe"), { recursive: true });
    // gleiche Grösse wie erwartet, anderer Inhalt: nur die Prüfsumme verrät es
    writeFileSync(join(temp, "vendor", "mediapipe", "hand_landmarker.task"), "verdorbn");
    try {
      const vorher = ausgabe.split("Handmodell defekt").length;
      for (let i = 0; i < 3; i++) {
        const r = await anfrage(port, "GET", MODELL);
        assert.equal(r.status, 409);
        assert.equal(r.text, "");
        assert.equal(r.kopf["content-security-policy"], CSP);
        assert.equal(r.kopf["x-content-type-options"], "nosniff");
      }
      const z = await anfrage(port, "GET", "/gesture/mp/modell.json");
      assert.deepEqual(JSON.parse(z.text), { vorhanden: true, zustand: "falsch" });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(ausgabe.split("Handmodell defekt: löschen, dann npm run gesten:modell").length - 1, 1, "einmal je Dateistand");
      assert.equal(ausgabe.split("Handmodell defekt").length - vorher, 1);
      assert.doesNotMatch(ausgabe, /verdorbn/);
    } finally {
      rmSync(join(temp, "vendor"), { recursive: true, force: true });
    }
  });

  it("Zustand des Handmodells: /gesture/mp/modell.json 200 mit vorhanden false/true, CSP, JSON, auch über den Tunnel", async () => {
    const pfad = "/gesture/mp/modell.json";
    const ohne = await anfrage(port, "GET", pfad);
    assert.equal(ohne.status, 200);
    assert.deepEqual(JSON.parse(ohne.text), { vorhanden: false, zustand: "fehlt" });
    assert.match(String(ohne.kopf["content-type"]), /^application\/json; charset=utf-8$/i);
    assert.equal(ohne.kopf["content-security-policy"], CSP);
    assert.equal(ohne.kopf["cache-control"], "no-cache");
    mkdirSync(join(temp, "vendor", "mediapipe"), { recursive: true });
    writeFileSync(join(temp, "vendor", "mediapipe", "hand_landmarker.task"), "attrappe");
    try {
      const mit = await anfrage(port, "GET", pfad);
      assert.equal(mit.status, 200);
      assert.deepEqual(JSON.parse(mit.text), { vorhanden: true, zustand: "ok" });
      // EVENTS_VIA_TUNNEL=on öffnet ihn wie die übrigen Dateien der Konsole
      assert.equal((await anfrage(port, "GET", pfad, { "cf-ray": "8a1b2c3d4e5f-ZRH" })).status, 200);
    } finally {
      rmSync(join(temp, "vendor"), { recursive: true, force: true });
    }
    assert.deepEqual(JSON.parse((await anfrage(port, "GET", pfad)).text), { vorhanden: false, zustand: "fehlt" });
  });

  it("nichts ausserhalb der Whitelist: kein Ordner von node_modules, vendor oder web", async () => {
    mkdirSync(join(temp, "vendor", "mediapipe"), { recursive: true });
    writeFileSync(join(temp, "vendor", "mediapipe", "anderes.task"), "x");
    try {
      for (const pfad of [
        "/gesture/mp/vision_bundle.cjs", "/gesture/mp/vision_bundle.mjs.map", "/gesture/mp/vision_bundle_mjs.js.map", "/gesture/mp/package.json",
        "/gesture/mp/wasm/", "/gesture/mp/wasm/x.wasm", "/gesture/mp/anderes.task", "/gesture/mp/%2e%2e/package.json", "/gesture/mp/../../package.json",
        "/gesture/gesture.js", "/gesture/gesture.html", "/gesture/dashboard.js", "/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs",
        "/vendor/mediapipe/hand_landmarker.task", "/vendor/mediapipe/anderes.task", "/gesture/mp/wasm/vision_wasm_internal.wasm.map",
      ]) {
        assert.equal((await anfrage(port, "GET", pfad)).status, 404, pfad);
      }
    } finally {
      rmSync(join(temp, "vendor"), { recursive: true, force: true });
    }
  });

  it("EVENTS_VIA_TUNNEL=on: die Dateien der Konsole folgen genau ihrer Regel, jeder andere Unterpfad bleibt 404", async () => {
    for (const kopf of [{ "cf-ray": "8a1b2c3d4e5f-ZRH" }, { "cf-connecting-ip": "203.0.113.7" }] as Record<string, string>[]) {
      for (const [pfad] of DATEIEN) assert.equal((await anfrage(port, "GET", pfad, kopf)).status, 200, `${pfad} über den Tunnel`);
      for (const pfad of ["/gesture/mp", "/gesture/mp/", "/gesture/mp/wasm", "/gesture/x", "/gesture/mp/vision_bundle.cjs"]) {
        assert.equal((await anfrage(port, "GET", pfad, kopf)).status, 404, `${pfad} über den Tunnel`);
        assert.equal((await anfrage(port, "OPTIONS", pfad, kopf)).status, 404, `OPTIONS ${pfad} über den Tunnel`);
      }
    }
  });
});
