import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { legeDemoAn, starteDemoDienst, type DemoDienst } from "./hilfen/dashboard-demo.js";

// Befund: Kam der Notaus, während ein Verlauf-Abruf lief, übernahm «Gespräch» danach dessen alte Antwort und zeigte
// bis zum nächsten Bereichs-Takt (60 s) den alten Verlauf ohne «Verlauf ruht». Demo-Dienst im Temp-Ordner, kein Netz.
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

const temp = mkdtempSync(join(tmpdir(), "jarvis-verlauf-notaus-ui-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

describe("Gespräch: Notaus während eines Verlauf-Abrufs", { skip: chrome ? false : "kein Chromium unter /opt/pw-browsers oder PLAYWRIGHT_CHROMIUM" }, () => {
  let dienst: DemoDienst | undefined;
  let browser: Browser | undefined;

  before(async () => {
    legeDemoAn(temp);
    writeFileSync(join(temp, "data", "chat.json"), JSON.stringify([
      { role: "user", content: "Frage vor dem Notaus" },
      { role: "assistant", content: [{ type: "text", text: "Antwort vor dem Notaus, Sir." }] },
    ]), { mode: 0o600 });
    dienst = await starteDemoDienst({ ordner: temp });
    browser = await chromium.launch({ executablePath: chrome });
  });
  after(async () => {
    await browser?.close().catch(() => undefined);
    await dienst?.stoppen();
  });

  it("die überholte Antwort wird verworfen und sofort neu geholt: «Verlauf ruht» ohne Warten auf den Takt", async () => {
    const page = await (await browser!.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    page.setDefaultTimeout(5000);
    const fehlerImSkript: string[] = [];
    page.on("pageerror", (e) => fehlerImSkript.push(e.message));
    await page.goto(dienst!.url + "/dashboard#gespraech");
    await page.waitForSelector("#dlgAnmelden[open]");
    await page.fill("#anmToken", dienst!.token);
    await page.keyboard.press("Enter");
    await page.waitForSelector("#v-gespraech .msg.frueher");

    // Nächster Abruf: Antwort des Servers vor dem Notaus, zurückgehalten, bis der Notaus im Dashboard angekommen ist
    let freigeben!: () => void;
    const gehalten = new Promise<void>((ok) => (freigeben = ok));
    let angekommen!: () => void;
    const unterwegs = new Promise<void>((ok) => (angekommen = ok));
    let erster = true;
    await page.route("**/api/chat/verlauf", async (r) => {
      if (!erster) return r.continue();
      erster = false;
      const alt = await r.fetch();
      angekommen();
      await gehalten;
      await r.fulfill({ response: alt });
    });
    await page.evaluate(() => { location.hash = "uebersicht"; });
    await page.waitForSelector("#v-uebersicht:not([hidden]) .auftraege");
    await page.evaluate(() => { location.hash = "gespraech"; });
    await unterwegs;

    const status = await page.evaluate(async (t) => (await fetch("/api/notaus", { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify({ an: true }) })).status, dienst!.token);
    assert.equal(status, 200);
    // Neuer Status sofort statt im 5-s-Takt (startet auch den 60-s-Takt neu, der also nicht hilft)
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Pausiert");
    freigeben();

    await page.waitForFunction(() => (document.querySelector("#v-gespraech .chat")?.textContent ?? "").includes("Notaus aktiv, Sir. Der Verlauf ruht"));
    assert.equal(await page.locator("#v-gespraech .msg.frueher").count(), 0);
    assert.ok(!((await page.textContent("#v-gespraech")) ?? "").includes("Antwort vor dem Notaus"));
    assert.deepEqual(fehlerImSkript, []);
  });
});
