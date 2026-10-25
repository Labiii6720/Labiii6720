import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { starteDemoDienst, type DemoDienst } from "./hilfen/dashboard-demo.js";

// Gesten-Konsole im echten Browser: Dienst im Temp-Ordner (kein Netz nach aussen), Chromium headless mit Attrappen-Kamera.
// Jede Anfrage an einen fremden Ursprung gilt als Fehler. Ohne Chromium wird übersprungen.
function findeChromium(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM && existsSync(process.env.PLAYWRIGHT_CHROMIUM)) return process.env.PLAYWRIGHT_CHROMIUM;
  const basis = "/opt/pw-browsers";
  if (!existsSync(basis)) return undefined;
  for (const d of readdirSync(basis).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
    const p = join(basis, d, "chrome-linux", "chrome");
    if (existsSync(p)) return p;
  }
  return undefined;
}
const chrome = findeChromium();
const projekt = resolve(import.meta.dirname, "..");
// Das echte Handmodell nur, wenn es im Projekt liegt und stimmt (npm run gesten:modell); der Test lädt nie etwas herunter
const echtesModell = join(projekt, "vendor", "mediapipe", "hand_landmarker.task");
const modellOk = existsSync(echtesModell) && createHash("sha256").update(readFileSync(echtesModell)).digest("hex") === "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1";

const BUNDLE = "/gesture/mp/vision_bundle.mjs";

interface Protokoll { konsole: string[]; seitenfehler: string[]; fremd: string[]; antworten: { url: string; status: number; typ: string }[] }

describe("Gesten-Konsole im Browser (ohne CDN, strenge CSP)", { skip: chrome ? false : "kein Chromium unter /opt/pw-browsers oder PLAYWRIGHT_CHROMIUM" }, () => {
  const temp = mkdtempSync(join(tmpdir(), "jarvis-gesture-ui-"));
  process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
  let dienst: DemoDienst | undefined;
  let browser: Browser | undefined;
  let ctx: BrowserContext;

  /** Neue Seite mit Protokoll: Konsole (error), Seitenfehler, Anfragen an fremde Ursprünge, Antworten des Dienstes */
  async function seite(): Promise<{ page: Page; log: Protokoll }> {
    const page = await ctx.newPage();
    page.setDefaultTimeout(20_000);
    const log: Protokoll = { konsole: [], seitenfehler: [], fremd: [], antworten: [] };
    page.on("console", (m) => { if (m.type() === "error") log.konsole.push(m.text()); });
    page.on("pageerror", (e) => log.seitenfehler.push(e.message));
    page.on("request", (r) => {
      const u = r.url();
      if (!u.startsWith(dienst!.url + "/") && !/^(data|blob):/.test(u)) log.fremd.push(u);
    });
    page.on("response", (r) => log.antworten.push({ url: r.url().slice(dienst!.url.length), status: r.status(), typ: r.headers()["content-type"] ?? "" }));
    return { page, log };
  }
  const csp = (p: Page) => p.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

  before(async () => {
    mkdirSync(join(temp, "data"), { recursive: true, mode: 0o700 });
    dienst = await starteDemoDienst({ ordner: temp });
    browser = await chromium.launch({ executablePath: chrome, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // Fremde Ursprünge gar nicht erst erreichen (zusätzlich zum Protokoll oben)
    await ctx.route((u) => u.origin !== new URL(dienst!.url).origin, (r) => r.abort("blockedbyclient"));
    await ctx.addInitScript(() => {
      const w = window as unknown as { __csp: string[] };
      w.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
  });

  after(async () => {
    await browser?.close().catch(() => undefined);
    await dienst?.stoppen();
  });

  it("ohne Handmodell: ruhiger Hinweis, Modul vom eigenen Server, keine CSP-Verletzung, nichts nach aussen", async () => {
    const { page, log } = await seite();
    await page.goto(dienst!.url + "/gesture");
    await page.waitForFunction(() => document.getElementById("st")?.textContent === "Handmodell fehlt: npm run gesten:modell");
    assert.equal(await page.getAttribute("#st", "class"), "hinweis");
    // Das Modul ist geladen (sonst gäbe es den Hinweis nicht) und kommt vom eigenen Server
    assert.ok(log.antworten.some((a) => a.url === "/gesture/mp/vision_bundle.mjs" && a.status === 200 && /^text\/javascript/.test(a.typ)), JSON.stringify(log.antworten));
    assert.equal(await page.evaluate(async (url) => typeof ((await import(url)) as { FilesetResolver?: unknown }).FilesetResolver, BUNDLE), "function");
    // Ohne Modell keine Kamera und kein WASM
    assert.ok(!log.antworten.some((a) => a.url.startsWith("/gesture/mp/wasm/")));
    assert.deepEqual(await csp(page), []);
    assert.deepEqual(log.fremd, []);
    assert.deepEqual(log.seitenfehler, []);
    // Einziger Konsoleneintrag: Chromium meldet die 404 des fehlenden Modells
    assert.deepEqual(log.konsole, ["Failed to load resource: the server responded with a status of 404 (Not Found)"]);
    assert.ok(log.antworten.some((a) => a.url === "/gesture/mp/hand_landmarker.task" && a.status === 404));
    // Die Kugel läuft trotzdem
    await page.waitForFunction(() => Number(document.getElementById("fps")?.textContent) > 0);
    await page.close();
  });

  it("WASM lädt unter der CSP vom eigenen Server (application/wasm); ein kleines Test-Modell wird sauber abgewiesen", async () => {
    const { page, log } = await seite();
    await page.goto(dienst!.url + "/gesture");
    await page.waitForFunction(() => document.getElementById("st")?.textContent?.startsWith("Handmodell fehlt") ?? false);
    const ergebnis = await page.evaluate(async (url) => {
      // Im Browser geladen; die Typen interessieren hier nicht
      const m = (await import(url)) as any;
      const vision = await m.FilesetResolver.forVisionTasks("/gesture/mp/wasm");
      try {
        // Zip-Kopf ohne Inhalt: die Engine startet, das Modell ist ungültig
        await m.HandLandmarker.createFromOptions(vision, { baseOptions: { modelAssetBuffer: new Uint8Array([80, 75, 3, 4, 0, 0]), delegate: "CPU" }, runningMode: "VIDEO" });
        return "erstellt";
      } catch (e) {
        return String(e);
      }
    }, BUNDLE);
    assert.match(ergebnis, /zip archive/i, "Fehler kommt aus der Engine, nicht aus der CSP");
    const wasm = log.antworten.filter((a) => a.url.startsWith("/gesture/mp/wasm/"));
    assert.ok(wasm.some((a) => /\.wasm$/.test(a.url) && a.status === 200 && a.typ === "application/wasm"), JSON.stringify(wasm));
    assert.ok(wasm.some((a) => /\.js$/.test(a.url) && a.status === 200 && /^text\/javascript/.test(a.typ)), JSON.stringify(wasm));
    assert.deepEqual(await csp(page), []);
    assert.deepEqual(log.fremd, []);
    assert.deepEqual(log.seitenfehler, []);
    await page.close();
  });

  it("mit echtem Handmodell und Attrappen-Kamera: LIVE, ohne Konsolenfehler, ohne CSP-Verletzung, nichts nach aussen", { skip: modellOk ? false : "kein geprüftes Handmodell im Projekt (npm run gesten:modell)" }, async () => {
    mkdirSync(join(temp, "vendor", "mediapipe"), { recursive: true });
    copyFileSync(echtesModell, join(temp, "vendor", "mediapipe", "hand_landmarker.task"));
    try {
      const { page, log } = await seite();
      await page.goto(dienst!.url + "/gesture");
      await page.waitForFunction(() => /^(LIVE|FEHLER)/.test(document.getElementById("st")?.textContent ?? ""), undefined, { timeout: 60_000 });
      assert.equal(await page.textContent("#st"), "LIVE");
      await page.waitForFunction(() => Number(document.getElementById("fps")?.textContent) > 0);
      assert.ok(log.antworten.some((a) => a.url === "/gesture/mp/hand_landmarker.task" && a.status === 200));
      assert.deepEqual(await csp(page), []);
      assert.deepEqual(log.fremd, []);
      assert.deepEqual(log.seitenfehler, []);
      assert.deepEqual(log.konsole, []);
      await page.close();
    } finally {
      rmSync(join(temp, "vendor"), { recursive: true, force: true });
    }
  });

  it("früheres Adressfeld: ein alter Wert «jarvis.base» wird entfernt, Token und Befehle bleiben", async () => {
    const { page, log } = await seite();
    await page.goto(dienst!.url + "/gesture");
    await page.evaluate(() => { localStorage.setItem("jarvis.base", "http://203.0.113.9:3000"); localStorage.setItem("jarvis.token", "falscher-token"); });
    await page.reload();
    await page.waitForFunction(() => document.getElementById("st")?.textContent?.startsWith("Handmodell fehlt") ?? false);
    assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.base")), null);
    assert.equal(await page.inputValue("#token"), "falscher-token");
    // Kein Feld mehr, über das eine fremde Adresse ins Spiel käme
    assert.equal(await page.locator("#base").count(), 0);
    assert.deepEqual(log.fremd, []);
    await page.close();
  });
});
