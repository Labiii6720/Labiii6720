import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { legeDemoAn, starteDemoDienst, type DemoDienst } from "./hilfen/dashboard-demo.js";

// Befunde zum Bereich «Gespräch» (web/dashboard.js): eigene Einträge beim erneuten Öffnen, Kopfzeile nach Anzahl,
// Wiederholung nach einem Ladefehler. Der Verlauf kommt aus einer Routen-Attrappe; Demo-Dienst im Temp-Ordner, kein Netz.
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

const temp = mkdtempSync(join(tmpdir(), "jarvis-verlauf-anzeige-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

type Nachricht = { rolle: "nutzer" | "jarvis"; text: string };
const ALT: Nachricht[] = [{ rolle: "nutzer", text: "Alte Frage" }, { rolle: "jarvis", text: "Alte Antwort, Sir." }];

describe("Gespräch: Anzeige des Verlaufs", { skip: chrome ? false : "kein Chromium unter /opt/pw-browsers oder PLAYWRIGHT_CHROMIUM" }, () => {
  let dienst: DemoDienst | undefined;
  let browser: Browser | undefined;
  const fehlerImSkript: string[] = [];

  /** Neue Sitzung; der Verlauf kommt aus `antwort` (Status, Nachrichten), jeder Abruf zählt */
  async function sitzung(antwort: (n: number) => { status: number; nachrichten?: Nachricht[] }, mitUhr = false) {
    const ctx: BrowserContext = await browser!.newContext({ viewport: { width: 1280, height: 860 } });
    if (mitUhr) await ctx.clock.install();
    const page: Page = await ctx.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", (e) => fehlerImSkript.push(e.message));
    const zaehler = { abrufe: 0 };
    await page.route("**/api/chat/verlauf", (r) => {
      const a = antwort(++zaehler.abrufe);
      return r.fulfill({ status: a.status, json: a.status === 200 ? { ok: true, nachrichten: a.nachrichten ?? [] } : { ok: false } });
    });
    await page.goto(dienst!.url + "/dashboard#gespraech");
    await page.waitForSelector("#dlgAnmelden[open]");
    await page.fill("#anmToken", dienst!.token);
    await page.keyboard.press("Enter");
    return { ctx, page, zaehler };
  }
  const eigene = (p: Page) => p.$$eval("#v-gespraech .msg:not(.frueher):not(.laeuft) .txt", (els) => els.map((e) => e.textContent));
  const frueher = (p: Page) => p.$$eval("#v-gespraech .msg.frueher .txt", (els) => els.map((e) => e.textContent));
  async function senden(p: Page, text: string, warteAuf: string) {
    await p.fill("#chatIn", text);
    await p.keyboard.press("Enter");
    await p.waitForFunction((t) => [...document.querySelectorAll("#v-gespraech .msg:not(.frueher) .txt")].some((e) => e.textContent === t), warteAuf);
  }
  async function neuOeffnen(p: Page) {
    await p.evaluate(() => { location.hash = "uebersicht"; });
    await p.waitForSelector("#v-uebersicht:not([hidden]) .auftraege");
    await p.evaluate(() => { location.hash = "gespraech"; });
  }

  before(async () => {
    legeDemoAn(temp);
    dienst = await starteDemoDienst({ ordner: temp });
    browser = await chromium.launch({ executablePath: chrome });
  });
  after(async () => {
    await browser?.close().catch(() => undefined);
    await dienst?.stoppen();
  });

  it("erneutes Öffnen: gescheiterte Versände und der Telegram-Hinweis bleiben, Beantwortetes weicht dem Server-Verlauf", async () => {
    let server = [...ALT];
    const { ctx, page } = await sitzung(() => ({ status: 200, nachrichten: server }));
    await page.waitForSelector("#v-gespraech .msg.frueher");
    let chat: { status: number; json: Record<string, unknown> } = { status: 500, json: { ok: false } };
    await page.route("**/api/chat", (r) => r.fulfill(chat));
    await senden(page, "Kaputte Frage", "Das kam nicht an (HTTP 500), Sir.");
    chat = { status: 200, json: { ok: true, queued: true } };
    await senden(page, "Lange Frage", "Das braucht länger, Sir.");
    chat = { status: 200, json: { ok: true, reply: "Gute Antwort, Sir." } };
    await senden(page, "Gute Frage", "Gute Antwort, Sir.");
    // Der Server kennt jetzt die angekommenen Fragen und die Antwort, nicht aber den Fehler und den Hinweis
    server = [...ALT, { rolle: "nutzer", text: "Lange Frage" }, { rolle: "nutzer", text: "Gute Frage" }, { rolle: "jarvis", text: "Gute Antwort, Sir." }];
    await neuOeffnen(page);
    await page.waitForFunction(() => [...document.querySelectorAll("#v-gespraech .msg.frueher .txt")].some((e) => e.textContent === "Gute Antwort, Sir."));
    assert.deepEqual(await frueher(page), ["Alte Frage", "Alte Antwort, Sir.", "Lange Frage", "Gute Frage", "Gute Antwort, Sir."]);
    assert.deepEqual(await eigene(page), ["Kaputte Frage", "Das kam nicht an (HTTP 500), Sir.", "Das braucht länger, Sir."]);
    assert.equal(await page.locator("#v-gespraech .msg.jv.fehler:not(.frueher)").count(), 1);
    assert.equal(await page.textContent("#v-gespraech .msg:not(.frueher) .msg-hinweis"), "Die Antwort kommt per Telegram.");
    await ctx.close();
    assert.deepEqual(fehlerImSkript, []);
  });

  it("Kopfzeile nach Anzahl: zwei Nachrichten, eine Nachricht", async () => {
    let server = [...ALT];
    const { ctx, page } = await sitzung(() => ({ status: 200, nachrichten: server }));
    const kopfzeile = () => page.$eval("#v-gespraech .chat-quelle", (e) => e.textContent);
    await page.waitForSelector("#v-gespraech .msg.frueher");
    assert.equal(await kopfzeile(), "Die letzten zwei Nachrichten aus dem Chat.");
    server = [{ rolle: "jarvis", text: "Einzige, Sir." }];
    await neuOeffnen(page);
    await page.waitForFunction(() => document.querySelectorAll("#v-gespraech .msg.frueher").length === 1);
    assert.equal(await kopfzeile(), "Die letzte Nachricht aus dem Chat.");
    await ctx.close();
    assert.deepEqual(fehlerImSkript, []);
  });

  it("ein Ladefehler wird im nächsten Takt wiederholt, ohne den Bereich neu zu öffnen", async () => {
    const { ctx, page, zaehler } = await sitzung((n) => (n === 1 ? { status: 500 } : { status: 200, nachrichten: ALT }), true);
    await page.waitForFunction(() => (document.querySelector("#v-gespraech .chat")?.textContent ?? "").includes("Den Verlauf konnte ich nicht laden (HTTP 500), Sir."));
    assert.equal(zaehler.abrufe, 1);
    // Bereichs-Takt (60 s): holeBereich lädt den Verlauf erneut
    await page.clock.fastForward(61_000);
    await page.waitForSelector("#v-gespraech .msg.frueher");
    assert.deepEqual(await frueher(page), ["Alte Frage", "Alte Antwort, Sir."]);
    assert.ok(!((await page.textContent("#v-gespraech .chat")) ?? "").includes("nicht laden"));
    assert.equal(zaehler.abrufe, 2);
    await ctx.close();
    assert.deepEqual(fehlerImSkript, []);
  });
});
