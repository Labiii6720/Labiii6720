import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { DEMO_PIN, DEMO_XSS, legeDemoAn, starteDemoDienst, type DemoDienst } from "./hilfen/dashboard-demo.js";

// Bereich «Gespräch» im Browser: die letzten fünf Nachrichten aus data/chat.json (Demo-Dienst im Temp-Ordner, kein Netz).
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

const temp = mkdtempSync(join(tmpdir(), "jarvis-verlauf-ui-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const verlauf = [
  { role: "user", content: "[Kommandozentrale] Zu alt, Sir" },
  { role: "assistant", content: [{ type: "text", text: "Ebenfalls zu alt." }] },
  { role: "user", content: "Erste sichtbare Frage" },
  { role: "assistant", content: [{ type: "text", text: "Ich prüfe." }, { type: "tool_use", id: "tu_1", name: "wetter", input: { ort: "GEHEIMER-ORT" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "WERKZEUG-ERGEBNIS" }] },
  { role: "assistant", content: [{ type: "text", text: `Antwort mit ${DEMO_XSS} und <b>fett</b>` }] },
  { role: "user", content: "[Systemnotiz] SYSTEMNOTIZ-NIE-ZEIGEN" },
  { role: "user", content: "[Kommandozentrale] Dritte <script>alert(2)</script>" },
  { role: "assistant", content: "Vierte, Sir." },
  { role: "user", content: "Fünfte und letzte" },
];
const SICHTBAR = ["Erste sichtbare Frage", `Antwort mit ${DEMO_XSS} und <b>fett</b>`, "Dritte <script>alert(2)</script>", "Vierte, Sir.", "Fünfte und letzte"];

describe("Gespräch: Verlauf der letzten fünf Nachrichten", { skip: chrome ? false : "kein Chromium unter /opt/pw-browsers oder PLAYWRIGHT_CHROMIUM" }, () => {
  let dienst: DemoDienst | undefined;
  let browser: Browser | undefined;
  let page: Page;
  const probleme: string[] = [];
  const abrufe: string[] = [];
  const texte = () => page.$$eval("#v-gespraech .msg.frueher .txt", (els) => els.map((e) => e.textContent));

  async function anmelden(p: Page, hash = "") {
    await p.goto(dienst!.url + "/dashboard" + hash);
    await p.waitForSelector("#dlgAnmelden[open]");
    await p.fill("#anmToken", dienst!.token);
    await p.keyboard.press("Enter");
  }

  before(async () => {
    legeDemoAn(temp);
    writeFileSync(join(temp, "data", "chat.json"), JSON.stringify(verlauf), { mode: 0o600 });
    dienst = await starteDemoDienst({ ordner: temp });
    browser = await chromium.launch({ executablePath: chrome });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
    page = await ctx.newPage();
    page.setDefaultTimeout(4000);
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") probleme.push(`console ${m.type()}: ${m.text()}`); });
    page.on("pageerror", (e) => probleme.push(`pageerror: ${e.message}`));
    page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/chat/verlauf") abrufe.push(r.url()); });
  });

  after(async () => {
    await browser?.close().catch(() => undefined);
    await dienst?.stoppen();
  });

  it("nach dem Anmelden direkt im Bereich: fünf Nachrichten, älteste zuerst, mit Hinweis", async () => {
    await anmelden(page, "#gespraech");
    await page.waitForSelector("#v-gespraech .msg.frueher");
    assert.deepEqual(await texte(), SICHTBAR);
    assert.deepEqual(await page.$$eval("#v-gespraech .msg.frueher", (els) => els.map((e) => (e.classList.contains("ich") ? "ich" : "jv"))), ["ich", "jv", "ich", "jv", "ich"]);
    assert.equal(await page.textContent("#v-gespraech .chat-quelle"), "Die letzten fünf Nachrichten aus dem Chat.");
    // Ohne Zeit im Verlauf: nur «Sie» bzw. «Jarvis», kein «–»
    assert.deepEqual(await page.$$eval("#v-gespraech .msg.frueher .wer", (els) => els.map((e) => e.textContent)), ["Sie", "Jarvis", "Sie", "Jarvis", "Sie"]);
    // Der Verlauf steht über dem Eingabefeld
    assert.equal(await page.evaluate(() => Boolean(document.getElementById("chatLog")!.compareDocumentPosition(document.getElementById("chatForm")!) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    assert.equal(await page.locator("#v-gespraech .chat-leer").count(), 0, "kein Leertext neben dem Verlauf");
  });

  it("eingeschleustes HTML bleibt Text; Werkzeug-Inhalte und Systemnotizen erscheinen nicht", async () => {
    assert.equal(await page.locator("#v-gespraech img").count(), 0);
    assert.equal(await page.locator("#v-gespraech script").count(), 0);
    assert.equal(await page.locator("#v-gespraech .txt b").count(), 0);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("#v-gespraech *")].filter((e) => [...e.attributes].some((a) => a.name.startsWith("on"))).length), 0);
    const html = await page.content();
    for (const nie of ["GEHEIMER-ORT", "WERKZEUG-ERGEBNIS", "SYSTEMNOTIZ-NIE-ZEIGEN", "Ich prüfe.", "Zu alt", "[Kommandozentrale]"]) assert.ok(!html.includes(nie), nie);
  });

  it("eigene neue Nachrichten hängen sich unten an, der Verlauf bleibt stehen", async () => {
    await page.route("**/api/chat", (r) => r.fulfill({ json: { ok: true, reply: "Neue Antwort, Sir." } }));
    try {
      await page.fill("#chatIn", "Neue Frage");
      await page.keyboard.press("Enter");
      await page.waitForSelector("#v-gespraech .msg.jv:not(.frueher):not(.laeuft)");
    } finally {
      await page.unroute("**/api/chat");
    }
    assert.deepEqual(await texte(), SICHTBAR);
    assert.deepEqual(await page.$$eval("#v-gespraech .msg:not(.frueher) .txt", (els) => els.map((e) => e.textContent)), ["Neue Frage", "Neue Antwort, Sir."]);
    assert.match((await page.textContent("#v-gespraech .msg.ich:not(.frueher) .wer")) ?? "", /^Sie · \d\d:\d\d$/);
  });

  it("die PIN im Gesprächsfeld: der Server nimmt sie nicht an, und sie bleibt auch hier nicht stehen", async () => {
    await page.fill("#chatIn", DEMO_PIN);
    await page.keyboard.press("Enter");
    await page.waitForSelector("#v-gespraech .msg.jv.fehler");
    assert.equal(await page.textContent("#v-gespraech .msg.jv.fehler .txt"), "Die PIN gehört nicht in den Chat, Sir. Nichts gesendet.");
    assert.ok(!(await page.$$eval("#v-gespraech .msg .txt", (els) => els.map((e) => e.textContent))).includes(DEMO_PIN));
    assert.deepEqual(await texte(), SICHTBAR);
    // Die erwartete Abweisung (400) meldet Chromium als Konsolenfehler: genau diese eine, sonst nichts
    const abweisung = probleme.findIndex((p) => p.includes("status of 400"));
    assert.ok(abweisung >= 0);
    probleme.splice(abweisung, 1);
  });

  it("beim erneuten Öffnen des Bereichs neu geladen", async () => {
    const vorher = abrufe.length;
    await page.evaluate(() => { location.hash = "uebersicht"; });
    await page.waitForSelector("#v-uebersicht:not([hidden]) .auftraege");
    await page.evaluate(() => { location.hash = "gespraech"; });
    // Was vor dem Abruf angekommen war, steht danach im Verlauf des Servers: diese Einträge weichen ihm.
    // Die abgewiesene PIN-Eingabe kam nie an: ihr Fehlereintrag bleibt stehen
    await page.waitForFunction(() => document.querySelectorAll("#v-gespraech .msg:not(.frueher)").length === 1);
    assert.equal(await page.textContent("#v-gespraech .msg.jv.fehler:not(.frueher) .txt"), "Die PIN gehört nicht in den Chat, Sir. Nichts gesendet.");
    assert.equal(abrufe.length, vorher + 1, "genau ein neuer Abruf");
    // Die Attrappe hat «Neue Frage» nicht in data/chat.json geschrieben: der Server bleibt die Quelle
    assert.deepEqual(await texte(), SICHTBAR);
    assert.deepEqual(probleme, []);
  });

  it("Notaus: der Verlauf ruht mit Hinweis (im Notaus zurückgehaltene Antworten); nach «Weiter» ist er wieder da", async () => {
    const notaus = (body: unknown) => page.evaluate(async ([t, b]) => (await fetch("/api/notaus", { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify(b) })).status, [dienst!.token, body] as const);
    assert.equal(await notaus({ an: true }), 200);
    // Neuer Status (hier sofort statt im 5-s-Takt): der Bereich holt den Verlauf neu
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(() => (document.querySelector("#v-gespraech .chat")?.textContent ?? "").includes("Notaus aktiv, Sir. Der Verlauf ruht"));
    assert.equal(await page.locator("#v-gespraech .msg.frueher").count(), 0);
    assert.equal(await notaus({ an: false, pin: DEMO_PIN }), 200);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForSelector("#v-gespraech .msg.frueher");
    assert.deepEqual(await texte(), SICHTBAR);
    assert.ok(!((await page.textContent("#v-gespraech .chat")) ?? "").includes("Notaus aktiv"));
    assert.deepEqual(probleme, []);
  });

  it("Notfall: Bereich gesperrt, kein Verlauf im DOM, die API antwortet 423", async () => {
    const r = await page.evaluate(async (t) => (await fetch("/api/notfall", { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify({ bestaetigt: true }) })).status, dienst!.token);
    assert.equal(r, 200);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForSelector("#v-gespraech:not([hidden]) .gesperrt-karte");
    const html = await page.content();
    for (const t of ["Erste sichtbare Frage", "Vierte, Sir.", "Neue Antwort"]) assert.ok(!html.includes(t), t);
    assert.equal(await page.evaluate(async (t) => (await fetch("/api/chat/verlauf", { headers: { Authorization: "Bearer " + t } })).status, dienst!.token), 423);
  });
});
