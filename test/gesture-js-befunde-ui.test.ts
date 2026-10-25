import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { starteDemoDienst, type DemoDienst } from "./hilfen/dashboard-demo.js";

// Befunde an web/gesture.js im echten Browser: fehlendes MediaPipe-Paket, nur lokale Stimmen, gesprochene PIN,
// Leertaste auf Knöpfen, deutsche Meldungen bei 401/404. /events beantwortet eine Attrappe (page.route), nie der Dienst.
// Spracherkennung und Sprachausgabe sind Attrappen (Init-Skript). Ohne Chromium wird übersprungen.
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

interface Fenster {
  __rec: { starts: number; letzte?: EventTarget };
  __sag: (t: string) => void;
  __ende: () => void;
  __stimmen: { name: string; lang: string; localService: boolean }[];
  __gesprochen: { voice: string | undefined; lang: string; text: string }[];
  __texte: string[];
}

// Als Text, nicht als Funktion: tsx hängt sonst Hilfsfunktionen an, die es im Browser nicht gibt
const ATTRAPPEN = `
(() => {
  const w = window;
  // Spracherkennung: zählt start(), __sag liefert ein Transkript
  w.__rec = { starts: 0 };
  class Rec extends EventTarget {
    constructor() { super(); this.lang = ""; this.interimResults = false; this.maxAlternatives = 1; }
    start() { w.__rec.starts++; w.__rec.letzte = this; }
    stop() {}
  }
  w.SpeechRecognition = Rec;
  w.webkitSpeechRecognition = Rec;
  w.__sag = (t) => {
    const ev = new Event("result");
    ev.results = [[{ transcript: t }]];
    w.__rec.letzte.dispatchEvent(ev);
  };
  w.__ende = () => { if (w.__rec.letzte) w.__rec.letzte.dispatchEvent(new Event("end")); };
  // Sprachausgabe: Stimmenliste steuerbar, speak() protokolliert
  w.__stimmen = [];
  w.__gesprochen = [];
  const synth = new EventTarget();
  synth.getVoices = () => w.__stimmen.slice();
  synth.speak = (u) => { w.__gesprochen.push({ voice: u.voice ? u.voice.name : undefined, lang: u.lang, text: u.text }); };
  synth.cancel = () => {};
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true, writable: true });
  w.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; this.voice = null; this.lang = ""; this.rate = 1; } };
  // Jeder Text, der je in #toast oder #reply stand
  w.__texte = [];
  document.addEventListener("DOMContentLoaded", () => {
    for (const id of ["toast", "reply"]) {
      const el = document.getElementById(id);
      new MutationObserver(() => w.__texte.push(id + ": " + el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    }
  });
})();
`;

describe("gesture.js: Befunde im Browser", { skip: chrome ? false : "kein Chromium unter /opt/pw-browsers oder PLAYWRIGHT_CHROMIUM" }, () => {
  const temp = mkdtempSync(join(tmpdir(), "jarvis-gesture-befunde-"));
  process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
  let dienst: DemoDienst | undefined;
  let browser: Browser | undefined;
  let ctx: BrowserContext;

  before(async () => {
    mkdirSync(join(temp, "data"), { recursive: true, mode: 0o700 });
    dienst = await starteDemoDienst({ ordner: temp });
    browser = await chromium.launch({ executablePath: chrome, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.route((u) => u.origin !== new URL(dienst!.url).origin, (r) => r.abort("blockedbyclient"));
    await ctx.addInitScript({ content: ATTRAPPEN });
  });

  after(async () => {
    await browser?.close().catch(() => undefined);
    await dienst?.stoppen();
  });

  /** Seite bereit (Modul lief: ohne Handmodell steht der Hinweis), Token gesetzt. */
  async function seite(): Promise<{ page: Page; fehler: string[] }> {
    const page = await ctx.newPage();
    page.setDefaultTimeout(20_000);
    const fehler: string[] = [];
    page.on("pageerror", (e) => fehler.push(e.message));
    await page.goto(dienst!.url + "/gesture");
    await page.waitForFunction(() => document.getElementById("st")?.textContent?.startsWith("Handmodell fehlt") ?? false);
    await page.fill("#token", "test-token-nur-attrappe");
    return { page, fehler };
  }
  const antwort = (page: Page, status: number, body: unknown, typ = "application/json") =>
    page.route("**/events", (r) => r.fulfill({ status, contentType: typ, body: typeof body === "string" ? body : JSON.stringify(body) }));
  const sage = async (page: Page, t: string) => {
    await page.click("#talk");
    await page.evaluate((x) => (window as unknown as Fenster).__sag(x), t);
  };
  const lies = <K extends keyof Fenster>(page: Page, k: K) => page.evaluate((x) => (window as unknown as Record<string, unknown>)[x], k) as Promise<Fenster[K]>;

  it("Befund 1: fehlt das MediaPipe-Paket, steht ein Hinweis da und die Kugel läuft", async () => {
    const page = await ctx.newPage();
    const fehler: string[] = [];
    page.on("pageerror", (e) => fehler.push(e.message));
    await page.route("**/gesture/mp/vision_bundle.mjs", (r) => r.fulfill({ status: 404, body: "" }));
    await page.goto(dienst!.url + "/gesture");
    await page.waitForFunction(() => document.getElementById("st")?.textContent === "MediaPipe fehlt: npm ci, dann Jarvis neu starten", undefined, { timeout: 20_000 });
    assert.equal(await page.getAttribute("#st", "class"), "hinweis");
    await page.waitForFunction(() => Number(document.getElementById("fps")?.textContent) > 0, undefined, { timeout: 20_000 });
    assert.deepEqual(fehler, []);
    await page.close();
  });

  it("Befund 2: nur lokale deutsche Stimmen; Googles Netzstimme oder leere Liste → nur Text", async () => {
    const { page, fehler } = await seite();
    await antwort(page, 200, { ok: true, reply: "Um neun Uhr der Kunde in Bern, Sir." });
    await page.evaluate(() => { (window as unknown as Fenster).__stimmen = [{ name: "Google Deutsch", lang: "de-DE", localService: false }]; });
    await sage(page, "Was steht heute an?");
    await page.waitForFunction(() => document.getElementById("reply")?.textContent?.includes("Bern") ?? false);
    assert.deepEqual(await lies(page, "__gesprochen"), [], "nie an die Netzstimme");
    assert.equal(await page.textContent("#toast"), "KEINE LOKALE DEUTSCHE STIMME – NUR TEXT");

    // Leere Liste (vor voiceschanged): ebenfalls nicht vorlesen, Chrome soll keine Stimme selbst wählen
    await page.evaluate(() => { const x = window as unknown as Fenster; x.__stimmen = []; x.__ende(); });
    await sage(page, "Und morgen?");
    await page.waitForFunction(() => document.getElementById("reply")?.textContent?.includes("Und morgen?") && document.getElementById("jv")?.textContent === "VERBUNDEN");
    assert.deepEqual(await lies(page, "__gesprochen"), []);

    // Lokale Stimme vorhanden: die wird genommen, de-CH vor de-DE, Google bleibt aussen vor
    await page.evaluate(() => {
      const x = window as unknown as Fenster;
      x.__stimmen = [
        { name: "Google Deutsch", lang: "de-DE", localService: false },
        { name: "Anna", lang: "de-DE", localService: true },
        { name: "Google Schweiz", lang: "de-CH", localService: false },
        { name: "Leni", lang: "de-CH", localService: true },
      ];
      x.__ende();
    });
    await sage(page, "Und übermorgen?");
    await page.waitForFunction(() => (window as unknown as Fenster).__gesprochen.length === 1);
    assert.deepEqual((await lies(page, "__gesprochen")).map((g) => [g.voice, g.lang]), [["Leni", "de-CH"]]);
    assert.deepEqual(fehler, []);
    await page.close();
  });

  it("Befund 3: eine gesprochene PIN steht weder im Toast noch in der Antwortzeile", async () => {
    const { page, fehler } = await seite();
    let freigeben!: () => void;
    const warten = new Promise<void>((r) => { freigeben = r; });
    await page.route("**/events", async (r) => {
      await warten;
      await r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "pin", text: "Die PIN gehört nicht in den Chat, Sir. Nichts gesendet." }) });
    });
    const anfrage = page.waitForRequest("**/events");
    await sage(page, "4 7 1 1");
    await anfrage;
    // Während der Dienst noch prüft: nichts mit Ziffern sichtbar
    assert.equal(await page.textContent("#toast"), "» …");
    assert.equal(await page.textContent("#reply"), "› …");
    freigeben();
    await page.waitForFunction(() => document.getElementById("reply")?.textContent === "Die PIN gehört nicht in den Chat, Sir. Nichts gesendet.");
    const texte = await lies(page, "__texte");
    assert.ok(texte.length > 0);
    assert.deepEqual(texte.filter((t) => /\d/.test(t)), [], JSON.stringify(texte));

    // Gegenprobe: ein gewöhnlicher Satz erscheint wie gewohnt (auch mit Zahlen darin)
    await page.unroute("**/events");
    await antwort(page, 200, { ok: true, reply: "Erledigt, Sir." });
    await page.evaluate(() => (window as unknown as Fenster).__ende());
    await sage(page, "Wecker auf 6 Uhr 30");
    await page.waitForFunction(() => document.getElementById("reply")?.textContent === "› Wecker auf 6 Uhr 30\n\nErledigt, Sir.");
    assert.ok((await lies(page, "__texte")).includes("toast: » Wecker auf 6 Uhr 30"));
    assert.deepEqual(fehler, []);
    await page.close();
  });

  it("Befund 4: Leertaste auf einem Knopf löst den Knopf aus, nicht die Erkennung; Wiederholung startet nicht neu", async () => {
    const { page, fehler } = await seite();
    await page.focus("#mic");
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.getElementById("mic")?.classList.contains("on") ?? false);
    assert.equal((await lies(page, "__rec")).starts, 0);

    // Ohne Fokus auf einem Element: Leertaste spricht; gehaltene Taste (repeat) startet nicht erneut
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.down("Space");
    assert.equal((await lies(page, "__rec")).starts, 1);
    await page.evaluate(() => (window as unknown as Fenster).__ende());
    await page.keyboard.down("Space"); // Tastenwiederholung
    await page.keyboard.up("Space");
    assert.equal((await lies(page, "__rec")).starts, 1);
    assert.deepEqual(fehler, []);
    await page.close();
  });

  it("Befund 5: falsches Token und abgeschaltete Ereignisse → deutsche Meldung, keine rohe Kennung", async () => {
    const { page, fehler } = await seite();
    await antwort(page, 401, { ok: false, error: "unauthorized" });
    await sage(page, "Licht aus");
    await page.waitForFunction(() => document.getElementById("jv")?.textContent === "FEHLER");
    assert.equal(await page.textContent("#reply"), "Token stimmt nicht, Sir.");

    await page.unroute("**/events");
    await antwort(page, 404, "<!DOCTYPE html><html><body><pre>Cannot POST /events</pre></body></html>", "text/html; charset=utf-8");
    await page.evaluate(() => (window as unknown as Fenster).__ende());
    await sage(page, "Licht an");
    await page.waitForFunction(() => document.getElementById("reply")?.textContent !== "› Licht an");
    assert.equal(await page.textContent("#reply"), "Ereignisse sind aus (JARVIS_EVENT_TOKEN fehlt), Sir.");
    assert.equal(await page.textContent("#jv"), "FEHLER");

    // Andere Fehler bleiben wie bisher: Text des Dienstes, sonst HTTP-Status
    await page.unroute("**/events");
    await antwort(page, 502, "Bad Gateway", "text/plain");
    await page.evaluate(() => (window as unknown as Fenster).__ende());
    await sage(page, "Licht halb");
    await page.waitForFunction(() => document.getElementById("reply")?.textContent === "Fehler: HTTP 502");
    const texte = await lies(page, "__texte");
    assert.deepEqual(texte.filter((t) => /unauthorized|SyntaxError|JSON/.test(t)), [], JSON.stringify(texte));
    assert.deepEqual(fehler, []);
    await page.close();
  });
});
