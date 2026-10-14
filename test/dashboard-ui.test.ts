import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { DEMO_IBAN, DEMO_INPUT_MARKE, DEMO_PIN, DEMO_XSS, legeDemoAn, starteDemoDienst, starteFrigateAttrappe, type DemoDienst } from "./hilfen/dashboard-demo.js";

// Kommandozentrale im echten Browser: Dienst mit Demo-Daten im Temp-Ordner (kein Netz nach aussen), Chromium headless.
// Ohne Chromium wird übersprungen (Begründung im skip-Text).
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
const BEREICHE = ["uebersicht", "freigaben", "kosten", "finanzen", "zeitplaene", "kameras", "gespraech", "protokoll", "sicherheit"];

describe("Kommandozentrale im Browser", { skip: chrome ? false : "kein Chromium unter /opt/pw-browsers oder PLAYWRIGHT_CHROMIUM" }, () => {
  let temp = "";
  let frigate: Awaited<ReturnType<typeof starteFrigateAttrappe>> | undefined;
  let dienst: DemoDienst | undefined;
  let browser: Browser | undefined;
  let ctx: BrowserContext;
  let page: Page;
  const probleme: string[] = [];

  /** Seite neu laden und mit dem Demo-Token anmelden */
  async function anmelden(p: Page) {
    await p.goto(dienst!.url + "/dashboard");
    await p.waitForSelector("#dlgAnmelden[open]");
    await p.fill("#anmToken", dienst!.token);
    await p.keyboard.press("Enter");
    await p.waitForSelector("#v-uebersicht .auftraege");
  }
  /** Sofort neu abfragen lassen (statt 5 s zu warten): wie beim Zurückkehren in den Tab */
  const sofort = (p: Page) => p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  before(async () => {
    temp = mkdtempSync(join(tmpdir(), "jarvis-ui-"));
    legeDemoAn(temp);
    frigate = await starteFrigateAttrappe();
    dienst = await starteDemoDienst({ ordner: temp, frigateUrl: frigate.url });
    browser = await chromium.launch({ executablePath: chrome });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, colorScheme: "dark" });
    await ctx.addInitScript(() => {
      const w = window as unknown as { __csp: string[] };
      w.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    page = await ctx.newPage();
    page.setDefaultTimeout(4000);
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") probleme.push(`console ${m.type()}: ${m.text()}`); });
    page.on("pageerror", (e) => probleme.push(`pageerror: ${e.message}`));
    await anmelden(page);
  });

  after(async () => {
    await browser?.close().catch(() => undefined);
    await dienst?.stoppen();
    await frigate?.schliessen();
    if (temp) rmSync(temp, { recursive: true, force: true });
  });

  it("alle neun Bereiche rendern, ohne Konsolenfehler und ohne CSP-Verletzung", async () => {
    for (const b of BEREICHE) {
      await page.evaluate((h) => { location.hash = h; }, b);
      await page.waitForSelector(`#v-${b}:not([hidden]) #h-${b}`, { timeout: 2000 });
      assert.equal(await page.getAttribute(`#tabs a[href="#${b}"]`, "aria-current"), "page", b);
    }
    await page.evaluate(() => { location.hash = "uebersicht"; });
    await page.waitForSelector("#v-uebersicht:not([hidden]) .auftraege");
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp), []);
    assert.deepEqual(probleme, []);
  });

  it("fremde Texte bleiben Text: kein Element, kein Handler; Eingaben, IBAN und Referenz erscheinen nie", async () => {
    const text = await page.textContent("#v-uebersicht");
    assert.ok(text!.includes(DEMO_XSS), "Zusammenfassung als Text sichtbar");
    assert.ok(text!.includes("bis <b>x</b>"), "Ziel-Frist als Text");
    await page.evaluate(() => { location.hash = "freigaben"; });
    await page.waitForSelector("#v-freigaben .verlauf");
    const html = await page.content();
    assert.equal(await page.locator("img[src='x']").count(), 0);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("#main *")].filter((e) => [...e.attributes].some((a) => a.name.startsWith("on"))).length), 0);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("#main b")].filter((e) => e.textContent === "x").length), 0);
    assert.ok(!html.includes(DEMO_INPUT_MARKE), "nie input");
    assert.ok(!html.includes(DEMO_IBAN), "nie IBAN");
    assert.ok(!html.includes("RF18"), "nie Referenz");
    // Aktionen hängen an data-Attributen, Werte aus Daten landen nie in Code
    await page.evaluate(() => { location.hash = "uebersicht"; });
    await page.waitForSelector("#v-uebersicht .auftraege");
    assert.equal(await page.locator('#v-uebersicht button[data-aktion="freigeben"][data-id="201"]').count(), 1);
    assert.equal(await page.locator('#v-uebersicht button[data-aktion="protokoll"][data-name="nacht"]').count(), 1);
  });

  it("PIN-Dialog per Tastatur: Tab bleibt im Dialog, Enter prüft, Fehler im Feld, Esc schliesst, Fokus kehrt zurück", async () => {
    const knopf = page.locator('#v-uebersicht button[data-aktion="freigeben"][data-id="202"]');
    const fokus = () => page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      const d = document.getElementById("dlgPin")!;
      return { wo: !a || a === document.body ? "nichts" : d.contains(a) ? "dialog" : "draussen", id: a?.id ?? "", text: a?.textContent?.trim() ?? "" };
    });
    await knopf.focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector("#dlgPin[open]");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "pinFeld");
    // Tab-Reihenfolge: Feld → Abbrechen → Freigeben, Shift+Tab zurück; nie auf die Seite dahinter
    await page.keyboard.press("Tab");
    assert.deepEqual(await fokus(), { wo: "dialog", id: "", text: "Abbrechen" });
    await page.keyboard.press("Tab");
    assert.equal((await fokus()).id, "pinOk");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal((await fokus()).id, "pinFeld");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      assert.notEqual((await fokus()).wo, "draussen", `Tab ${i + 1} verlässt den Dialog`);
    }
    // Abbrechen per Tastatur: der Auftrag bleibt offen, Fokus zurück auf «Freigeben»
    await page.focus("#pinFeld");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#dlgPin", { state: "hidden" });
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id), "202");
    assert.equal(await knopf.count(), 1, "nichts abgelehnt");

    await page.keyboard.press("Enter");
    await page.waitForSelector("#dlgPin[open]");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "pinFeld");
    await page.keyboard.type("12");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#pinFehler:not([hidden])");
    assert.equal(await page.getAttribute("#pinFeld", "aria-invalid"), "true");
    assert.ok(await page.evaluate(() => (document.getElementById("dlgPin") as HTMLDialogElement).open), "Dialog bleibt offen");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#dlgPin", { state: "hidden" });
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id), "202");
  });

  it("Notaus mit Bestätigung, Weiter nur mit PIN", async () => {
    await page.click("#notausKnopf");
    await page.waitForSelector("#dlgFrage[open]");
    await page.click("#frageOk");
    await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Pausiert", null, { timeout: 3000 });
    await page.click("#notausKnopf");
    await page.waitForSelector("#dlgPin[open]");
    await page.keyboard.type("0000");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#pinFehler:not([hidden])");
    assert.match(await page.textContent("#pinFehler") ?? "", /Falsche PIN/);
    await page.keyboard.type(DEMO_PIN);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Bereit", null, { timeout: 3000 });
  });

  it("Notfall: echte Zahl offener Aufträge, keine Inhalte; nach der Entwarnung wird alles neu aufgebaut", async () => {
    // Notfall-Antwort von /status.json nachgestellt (die Entwarnung gibt es nur in Telegram)
    await page.route("**/status.json", async (route) => {
      const echt = await route.fetch();
      const d = await echt.json();
      await route.fulfill({ response: echt, json: { ...d, notfall: true, pausiert: true, offeneAuftraege: 3, auftraege: [], rechnungen: [], zeitplaene: [], wachen: [], kameras: [], protokolle: [], ziele: [], vorgaenge: [], werte: [] } });
    });
    await sofort(page);
    await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Notfall", null, { timeout: 3000 });
    const text = (await page.textContent("#v-uebersicht")) ?? "";
    assert.match(text, /3 offene Aufträge/);
    assert.match(text, /Inhalte erst nach \/entwarnung/);
    assert.doesNotMatch(text, /Nichts zu tun|Keine offenen/);
    assert.equal(await page.locator("#v-uebersicht .auftrag").count(), 0);
    assert.equal(await page.isVisible("#bandNotfall"), true);
    assert.match((await page.textContent("#zahlFreigaben")) ?? "", /^3/);

    await page.unroute("**/status.json");
    await sofort(page);
    await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Bereit", null, { timeout: 3000 });
    await page.waitForSelector("#v-uebersicht .auftrag", { timeout: 3000 });
    assert.equal(await page.locator("#v-uebersicht .auftrag").count(), 3);
    assert.equal(await page.isVisible("#bandNotfall"), false);
    await page.waitForSelector("#v-uebersicht .kpis .funke", { timeout: 3000 });
  });

  it("Kosten: Säulen per Tastatur mit Tooltip, Zeitraum 7 Tage, Tabellenansicht", async () => {
    await page.evaluate(() => { location.hash = "kosten"; });
    await page.waitForSelector("#v-kosten svg.plot");
    assert.equal(await page.locator("#v-kosten g.gruppe").count(), 30);
    await page.focus("#v-kosten g.gruppe[tabindex='0']");
    await page.keyboard.press("ArrowLeft");
    await page.waitForSelector("#v-kosten .tip.an");
    assert.match((await page.textContent("#v-kosten .tip")) ?? "", /USD.*Aufrufe/s);
    assert.equal(await page.evaluate(() => (document.activeElement as Element | null)?.getAttribute("data-merk")), "kd:28");
    await page.click('#v-kosten [data-tage="7"]');
    await page.waitForFunction(() => document.querySelectorAll("#v-kosten g.gruppe").length === 7, null, { timeout: 3000 });
    await page.click('#v-kosten button[data-aktion="ansicht"]');
    await page.waitForSelector("#v-kosten table caption");
    assert.equal(await page.locator("#v-kosten svg.plot").count(), 0, "Tabelle ersetzt das Diagramm");
    assert.equal(await page.getAttribute('#v-kosten button[data-aktion="ansicht"]', "aria-pressed"), "true");
    await page.click('#v-kosten button[data-aktion="ansicht"]');
    await page.click('#v-kosten [data-tage="30"]');
    await page.waitForFunction(() => document.querySelectorAll("#v-kosten g.gruppe").length === 30, null, { timeout: 3000 });
  });

  it("Finanzen: gruppierte Säulen in CHF, weitere Währung nur in der Tabelle, Bank-Hinweis, nie IBAN", async () => {
    await page.evaluate(() => { location.hash = "finanzen"; });
    await page.waitForSelector("#v-finanzen svg.plot");
    assert.equal(await page.locator("#v-finanzen g.gruppe").count(), 6);
    assert.equal(await page.locator("#v-finanzen path.balken.s2").count() > 0, true);
    const text = (await page.textContent("#v-finanzen")) ?? "";
    assert.match(text, /Zahlungen bereite ich nur vor; auslösen tun Sie in der Bank-App, Sir\./);
    assert.match(text, /Krankenkasse Prämie Oktober/);
    assert.ok(!text.includes(DEMO_IBAN) && !text.includes("RF18"));
    await page.click('#v-finanzen button[data-aktion="ansicht"]');
    await page.waitForSelector("#v-finanzen table");
    assert.match((await page.textContent("#v-finanzen")) ?? "", /Weitere Währungen.*EUR/s);
    await page.click('#v-finanzen button[data-aktion="ansicht"]');
  });

  it("Zeitplan: Prüfung im Browser, Feldfehler vom Server, anlegen, ändern, löschen mit Bestätigung", async () => {
    await page.evaluate(() => { location.hash = "zeitplaene"; });
    await page.waitForSelector("#v-zeitplaene .plan");
    await page.click('#v-zeitplaene button[data-aktion="plan-neu"]');
    await page.waitForSelector("#dlgPlan[open]");
    await page.fill("#pName", "Werkstatt <b>x</b>");
    await page.fill("#pZeit", "24:15");
    await page.fill("#pAuftrag", "Werkzeug wegräumen.");
    await page.click("#planOk");
    await page.waitForSelector("#pZeitF:not([hidden])");
    assert.equal(await page.getAttribute("#pZeit", "aria-invalid"), "true");
    // Feldfehler, die nur der Server kennt, landen am richtigen Feld
    let abgefangen = false;
    await page.route("**/api/zeitplaene", async (r) => {
      if (r.request().method() !== "POST" || abgefangen) return r.fallback();
      abgefangen = true;
      await r.fulfill({ status: 400, json: { ok: false, error: "pruefung", fehler: { name: "Diesen Namen nehme ich nicht, Sir." } } });
    });
    await page.fill("#pZeit", "6:05");
    await page.click("#planOk");
    await page.waitForSelector("#pNameF:not([hidden])");
    assert.match((await page.textContent("#pNameF")) ?? "", /Diesen Namen nehme ich nicht/);
    await page.click("#planOk");
    await page.waitForSelector("#dlgPlan", { state: "hidden" });
    await page.unroute("**/api/zeitplaene");
    await page.waitForFunction(() => [...document.querySelectorAll("#v-zeitplaene .plan .name")].some((e) => e.textContent === "Werkstatt <b>x</b>"), null, { timeout: 3000 });
    assert.equal(await page.locator("#v-zeitplaene .plan .name b").count(), 0, "Name bleibt Text");
    const neu = page.locator("#v-zeitplaene .plan", { hasText: "Werkstatt <b>x</b>" });
    assert.match((await neu.textContent()) ?? "", /06:05/);
    await neu.locator('button[data-aktion="plan-edit"]').click();
    await page.waitForSelector("#dlgPlan[open]");
    assert.equal(await page.inputValue("#pZeit"), "06:05");
    await page.check('input[name="tageArt"][value="taeglich"]', { force: true });
    await page.click("#planOk");
    await page.waitForSelector("#dlgPlan", { state: "hidden" });
    await page.waitForFunction(() => /Täglich/.test([...document.querySelectorAll("#v-zeitplaene .plan")].find((e) => e.textContent?.includes("Werkstatt"))?.textContent ?? ""), null, { timeout: 3000 });
    await page.locator("#v-zeitplaene .plan", { hasText: "Werkstatt" }).locator('button[data-aktion="plan-weg"]').click();
    await page.waitForSelector("#dlgFrage[open]");
    await page.click("#frageOk");
    await page.waitForFunction(() => ![...document.querySelectorAll("#v-zeitplaene .plan .name")].some((e) => e.textContent?.includes("Werkstatt")), null, { timeout: 3000 });
  });

  it("Wachen: cameras.json nur lesend, Kamera-Auswahl aus status.json, Datensparsamkeit, anlegen, löschen", async () => {
    await page.waitForSelector("#v-zeitplaene .wache");
    assert.match((await page.textContent("#v-zeitplaene")) ?? "", /Standbilder an die Claude-API/);
    const fest = page.locator("#v-zeitplaene .wache", { hasText: "Liegt ein Paket" });
    assert.equal(await fest.locator("button").count(), 0);
    assert.match((await fest.textContent()) ?? "", /cameras\.json · nur lesend/);
    await page.click('#v-zeitplaene button[data-aktion="wache-neu"]');
    await page.waitForSelector("#dlgWache[open]");
    assert.deepEqual(await page.$$eval("#wKamera option", (o) => o.map((x) => (x as HTMLOptionElement).value)), ["eingang", "werkstatt"]);
    await page.selectOption("#wKamera", "werkstatt");
    await page.fill("#wFrage", "Brennt die Lötstation noch?");
    await page.fill("#wAlle", "4");
    await page.click("#wacheOk");
    await page.waitForSelector("#wAlleF:not([hidden])");
    await page.fill("#wAlle", "15");
    await page.click("#wacheOk");
    await page.waitForSelector("#dlgWache", { state: "hidden" });
    await page.waitForSelector('#v-zeitplaene .wache:has-text("Brennt die Lötstation noch?")', { timeout: 3000 });
    // Löschen nur nach Bestätigung; «Abbrechen» lässt sie stehen
    const neu = () => page.locator("#v-zeitplaene .wache", { hasText: "Brennt die Lötstation noch?" });
    await neu().locator('button[data-aktion="wache-weg"]').click();
    await page.waitForSelector("#dlgFrage[open]");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#dlgFrage", { state: "hidden" });
    assert.equal(await neu().count(), 1, "nach Abbrechen noch da");
    await neu().locator('button[data-aktion="wache-weg"]').click();
    await page.waitForSelector("#dlgFrage[open]");
    await page.click("#frageOk");
    await page.waitForFunction(() => ![...document.querySelectorAll("#v-zeitplaene .wache")].some((e) => e.textContent?.includes("Brennt die Lötstation")), null, { timeout: 3000 });
    const wachen = await page.evaluate(async (t) => (await (await fetch("/api/wachen", { headers: { Authorization: "Bearer " + t } })).json()) as { wachen: { frage: string }[] }, dienst!.token);
    assert.ok(!wachen.wachen.some((w) => w.frage.includes("Lötstation")), "auch im Server gelöscht");
    assert.equal(await page.locator("#v-zeitplaene .wache", { hasText: "Liegt ein Paket" }).count(), 1, "cameras.json-Wache bleibt");
  });

  it("Kameras: Standbild als Object-URL; im Notfall weg und freigegeben, nach der Entwarnung wieder da", async () => {
    await page.evaluate(() => { location.hash = "kameras"; });
    await page.waitForSelector('#v-kameras img[data-kam="eingang"][src^="blob:"]');
    const alt = await page.getAttribute('#v-kameras img[data-kam="eingang"]', "src");
    await page.click('#v-kameras button[data-name="eingang"]');
    await page.waitForSelector("#dlgBild[open]");
    assert.equal(await page.getAttribute("#bildGross", "src"), alt);
    await page.keyboard.press("Escape");
    await page.route("**/status.json", async (route) => {
      const echt = await route.fetch();
      const d = await echt.json();
      await route.fulfill({ response: echt, json: { ...d, notfall: true, offeneAuftraege: 3, auftraege: [], kameras: [], zeitplaene: [], wachen: [] } });
    });
    await sofort(page);
    await page.waitForFunction(() => !document.querySelector("#v-kameras img") && /Im Notfall gesperrt/.test(document.getElementById("v-kameras")?.textContent ?? ""), null, { timeout: 3000 });
    // Freigegebene Object-URL lädt nicht mehr (img-src erlaubt blob:, fetch dürfte es wegen connect-src ohnehin nicht)
    const freigegeben = await page.evaluate((u) => new Promise<boolean>((ok) => {
      const img = new Image();
      img.addEventListener("load", () => ok(false));
      img.addEventListener("error", () => ok(true));
      img.src = u!;
    }), alt);
    assert.equal(freigegeben, true, "alte Object-URL ist freigegeben");
    await page.unroute("**/status.json");
    await sofort(page);
    await page.waitForSelector('#v-kameras img[data-kam="eingang"][src^="blob:"]', { timeout: 3000 });
    assert.notEqual(await page.getAttribute('#v-kameras img[data-kam="eingang"]', "src"), alt);
  });

  it("Kameras ohne Frigate: Leerzustand mit Hinweis", async () => {
    await page.route("**/api/kamera/**", (r) => r.fulfill({ status: 502, json: { ok: false, error: "Frigate ist nicht eingerichtet (FRIGATE_URL)." } }));
    await page.evaluate(() => { location.hash = "uebersicht"; });
    await page.waitForSelector("#v-uebersicht:not([hidden])");
    await page.evaluate(() => { location.hash = "kameras"; });
    // Altes Bild bleibt stehen, bis es ersetzt wird; erst ohne je ein Bild greift der Leerzustand – deshalb neu laden
    await page.reload();
    await page.waitForSelector("#v-kameras .leer", { timeout: 4000 });
    assert.match((await page.textContent("#v-kameras")) ?? "", /Frigate ist nicht eingerichtet.*FRIGATE_URL/s);
    await page.unroute("**/api/kamera/**");
  });

  it("Gespräch: Antwort als Text, «läuft …» während der Anfrage, Hinweis bei Antwort per Telegram", async () => {
    let freigeben: () => void = () => undefined;
    const warte = new Promise<void>((ok) => { freigeben = ok; });
    let n = 0;
    await page.route("**/api/chat", async (r) => {
      n++;
      if (n === 1) { await warte; await r.fulfill({ json: { ok: true, reply: "Gern, Sir. <img src=x onerror=alert(1)>" } }); }
      else await r.fulfill({ json: { ok: true, reply: "Das braucht länger, die Antwort kommt per Telegram.", queued: true } });
    });
    await page.evaluate(() => { location.hash = "gespraech"; });
    await page.waitForSelector("#chatIn");
    await page.fill("#chatIn", "Wie spät ist es?");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#v-gespraech .msg.laeuft");
    assert.equal(await page.isDisabled('#chatForm button[type="submit"]'), true);
    freigeben();
    await page.waitForSelector("#v-gespraech .msg.jv:not(.laeuft)");
    assert.match((await page.textContent("#v-gespraech .msg.jv .txt")) ?? "", /<img src=x onerror=alert\(1\)>/);
    assert.equal(await page.locator("#v-gespraech img").count(), 0);
    await page.fill("#chatIn", "Und morgen?");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#v-gespraech .msg-hinweis");
    assert.match((await page.textContent("#v-gespraech .msg-hinweis")) ?? "", /per Telegram/);
    await page.unroute("**/api/chat");
  });

  it("Protokoll: Tagesgruppen, Filter nach Ereignis, kaputte Zeilen fallen weg", async () => {
    await page.evaluate(() => { location.hash = "protokoll"; });
    await page.waitForSelector("#v-protokoll .audit");
    const gruppen = await page.$$eval("#v-protokoll .vtag", (e) => e.map((x) => x.textContent ?? ""));
    assert.ok(gruppen[0]!.startsWith("Heute"), gruppen.join());
    assert.ok(gruppen.some((g) => g.startsWith("Gestern")), gruppen.join());
    await page.focus("#protFilter");
    await page.selectOption("#protFilter", "modus");
    await page.waitForFunction(() => document.querySelectorAll("#v-protokoll .audit li").length === 1, null, { timeout: 2000 });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "protFilter", "Fokus bleibt im Filter");
    assert.match((await page.textContent("#v-protokoll .audit li")) ?? "", /modus.*modus: normal · quelle: dashboard/s);
    await page.selectOption("#protFilter", "alle");
    assert.ok(!((await page.textContent("#v-protokoll")) ?? "").includes("kaputte"));
  });

  it("keine horizontale Scrollbar bei 360 px, in allen Bereichen", async () => {
    await page.setViewportSize({ width: 360, height: 740 });
    for (const b of BEREICHE) {
      await page.evaluate((h) => { location.hash = h; }, b);
      await page.waitForSelector(`#v-${b}:not([hidden]) #h-${b}`);
      const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert.ok(sw <= cw, `${b}: ${sw} > ${cw}`);
    }
    await page.setViewportSize({ width: 1280, height: 860 });
  });

  it("401 führt einmal zur Anmeldung, ohne Schleife; Abmelden löscht den Token", async () => {
    let abrufe = 0;
    await page.route("**/status.json", async (route) => { abrufe++; await route.fulfill({ status: 401, json: { ok: false, error: "unauthorized" } }); });
    await sofort(page);
    await page.waitForSelector("#dlgAnmelden[open]");
    const bisher = abrufe;
    await sofort(page);
    await page.waitForTimeout(300);
    assert.equal(abrufe, bisher, "keine weiteren Abfragen ohne Token");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("jarvis.token")), null);
    await page.unroute("**/status.json");
    await page.fill("#anmToken", dienst!.token);
    await page.check("#anmMerken");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#dlgAnmelden", { state: "hidden" });
    assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.token")), dienst!.token);
    await page.evaluate(() => { location.hash = "sicherheit"; });
    await page.click('#v-sicherheit button[data-aktion="abmelden"]');
    await page.waitForSelector("#dlgAnmelden[open]");
    assert.deepEqual(await page.evaluate(() => [sessionStorage.getItem("jarvis.token"), localStorage.getItem("jarvis.token")]), [null, null]);
    assert.equal(await page.locator("#v-uebersicht .auftrag").count(), 0, "Inhalte sind weg");
  });

  /** API-Aufruf aus der Seite heraus (gleicher Ursprung, Bearer-Header wie das UI) */
  const holeApi = (pfad: string, init: { method?: string; body?: unknown } = {}) =>
    page.evaluate(async ([p, t, m, b]) => {
      const r = await fetch(p, { method: m, headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
      return { status: r.status, daten: (await r.json()) as Record<string, unknown> };
    }, [pfad, dienst!.token, init.method ?? "GET", init.body] as const);

  it("Anmeldung: falscher Token bleibt draussen, der richtige öffnet die Kommandozentrale", async () => {
    const antwort = await page.goto(dienst!.url + "/dashboard");
    // Skripte nur vom eigenen Ursprung (Zusage e); der genaue Wortlaut steht in server.test.ts
    const csp = (await antwort!.allHeaders())["content-security-policy"] ?? "";
    assert.match(csp, /script-src 'self';/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
    await page.waitForSelector("#dlgAnmelden[open]");
    await page.fill("#anmToken", "falsch-" + dienst!.token.slice(7));
    await page.keyboard.press("Enter");
    await page.waitForSelector("#anmFehler:not([hidden])");
    assert.match((await page.textContent("#anmFehler")) ?? "", /Diesen Token kenne ich nicht, Sir\./);
    assert.equal(await page.isVisible("#dlgAnmelden"), true);
    assert.equal(await page.locator("#v-uebersicht .auftrag").count(), 0);
    await page.fill("#anmToken", dienst!.token);
    await page.keyboard.press("Enter");
    await page.waitForSelector("#v-uebersicht .auftraege");
    await page.waitForSelector("#dlgAnmelden", { state: "hidden" });
  });

  it("Freigeben eines externen Auftrags ändert den Status – ohne Telegram, ohne Hängen", async () => {
    const start = Date.now();
    await page.click('#v-uebersicht button[data-aktion="freigeben"][data-id="201"]');
    await page.waitForFunction(() => !document.querySelector('#v-uebersicht [data-id="201"]'), null, { timeout: 4500 });
    assert.ok(Date.now() - start < 4500, "Antwort innert der Meldefrist");
    await page.waitForSelector("#toast.an");
    assert.match((await page.textContent("#toast")) ?? "", /#201/);
    const { daten } = await holeApi("/api/auftraege?status=alle&limit=200");
    const a = (daten.auftraege as { id: number; status: string }[]).find((x) => x.id === 201);
    assert.ok(a && a.status !== "offen", `Status ${a?.status}`);
    // Die Historie zeigt den neuen Status, nicht «offen»
    await page.evaluate(() => { location.hash = "freigaben"; });
    await page.waitForSelector("#v-freigaben .verlauf");
    const zeile = page.locator("#v-freigaben tr", { hasText: "E-Mail an den Hauswart" });
    assert.match((await zeile.first().textContent()) ?? "", a!.status === "erledigt" ? /erledigt/ : /Fehler/);
  });

  it("Notfall über die Kommandozentrale: zweistufig, echte Zahl, alles gesperrt; nach der Entwarnung Bilder wieder da", async () => {
    // Vorher: Standbild liegt als Object-URL vor
    await page.evaluate(() => { location.hash = "kameras"; });
    const bild = '#v-kameras img[data-kam="eingang"][src^="blob:"]';
    await page.waitForSelector(bild);
    const alt = await page.getAttribute(bild, "src");
    const offen = ((await holeApi("/api/auftraege?status=offen&limit=200")).daten.auftraege as unknown[]).length;
    assert.ok(offen > 0);

    await page.evaluate(() => { location.hash = "sicherheit"; });
    await page.click('#v-sicherheit button[data-aktion="notfall"]');
    await page.waitForSelector("#dlgFrage[open]");
    await page.click("#frageOk");
    await page.waitForFunction(() => (document.getElementById("dlgFrage") as HTMLDialogElement).open && document.getElementById("frageTitel")?.textContent === "Sicher, Sir?");
    await page.click("#frageOk");
    await sofort(page);
    await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Notfall", null, { timeout: 3000 });
    assert.equal(await page.isVisible("#bandNotfall"), true);
    assert.equal(await page.isDisabled('#v-sicherheit button[data-aktion="weiter"]'), true, "Weiter im Notfall gesperrt");

    // Server: Daten gesperrt, zweiter Auslöser ohne zweiten Alarm
    assert.equal((await holeApi("/api/kosten")).status, 423);
    assert.equal((await holeApi("/api/zeitplaene")).status, 423);
    assert.equal((await holeApi("/api/notaus", { method: "POST", body: { an: false, pin: DEMO_PIN } })).status, 423);
    assert.deepEqual((await holeApi("/api/notfall", { method: "POST", body: { bestaetigt: true } })).daten.schon, true);

    // Übersicht: echte Zahl aus offeneAuftraege, keine Inhalte
    await page.evaluate(() => { location.hash = "uebersicht"; });
    await page.waitForSelector("#v-uebersicht:not([hidden]) #h-uebersicht");
    const text = (await page.textContent("#v-uebersicht")) ?? "";
    assert.match(text, new RegExp(`${offen} offene Aufträge`));
    assert.match(text, /Inhalte erst nach \/entwarnung/);
    assert.equal(await page.locator("#v-uebersicht .auftrag").count(), 0);
    assert.match((await page.textContent("#zahlFreigaben")) ?? "", new RegExp(`^${offen}`));
    for (const b of ["freigaben", "kosten", "finanzen", "zeitplaene", "kameras", "gespraech", "protokoll"]) {
      await page.evaluate((h) => { location.hash = h; }, b);
      await page.waitForSelector(`#v-${b}:not([hidden]) .gesperrt-karte`, { timeout: 2000 });
      assert.match((await page.textContent(`#v-${b}`)) ?? "", /Im Notfall gesperrt/, b);
    }
    assert.equal(await page.locator("#v-kameras img").count(), 0, "keine Bilder im Notfall");
    // Der Bereich Kameras bleibt offen: nach der Entwarnung muss er die Bilder von selbst wieder anlegen
    await page.evaluate(() => { location.hash = "kameras"; });
    await page.waitForSelector("#v-kameras:not([hidden]) .gesperrt-karte");

    // Entwarnung gibt es nur in Telegram: hier Dienst anhalten, state.json zurücksetzen, auf demselben Port neu starten
    const port = dienst!.port;
    await dienst!.stoppen();
    const statePfad = join(temp, "data", "state.json");
    const st = JSON.parse(readFileSync(statePfad, "utf8")) as Record<string, unknown>;
    assert.equal((st.notfall as { aktiv?: boolean } | undefined)?.aktiv, true, "Notfall war gespeichert");
    writeFileSync(statePfad, JSON.stringify({ ...st, notfall: { aktiv: false }, paused: false }), { mode: 0o600 });
    dienst = await starteDemoDienst({ ordner: temp, frigateUrl: frigate!.url, port });
    await sofort(page);
    await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Bereit", null, { timeout: 4000 });
    await page.waitForSelector(bild, { timeout: 4000 });
    assert.notEqual(await page.getAttribute(bild, "src"), alt, "neues Bild nach der Entwarnung");
    assert.equal(await page.isVisible("#bandNotfall"), false);
    await page.evaluate(() => { location.hash = "uebersicht"; });
    await page.waitForSelector("#v-uebersicht .auftrag", { timeout: 3000 });
  });

  it("hell und dunkel: umschaltbar und nach dem Neuladen gemerkt", async () => {
    const zustand = () => page.evaluate(() => ({
      thema: document.documentElement.getAttribute("data-theme"),
      grund: getComputedStyle(document.body).backgroundColor,
      label: document.getElementById("thema")?.getAttribute("aria-label"),
    }));
    const vorher = await zustand();
    assert.equal(vorher.label, "Helles Thema", "Standard dunkel");
    await page.click("#thema");
    const hell = await zustand();
    assert.equal(hell.thema, "light");
    assert.equal(hell.label, "Dunkles Thema");
    assert.notEqual(hell.grund, vorher.grund, "Hintergrund wechselt");
    assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.thema")), "light");
    await page.reload();
    await page.waitForSelector("#v-uebersicht .auftraege");
    assert.deepEqual(await zustand(), hell, "nach dem Neuladen hell");
    await page.click("#thema");
    assert.equal((await zustand()).thema, "dark");
    assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.thema")), "dark");
  });

  it("über alle Abläufe: keine Skriptfehler und keine CSP-Verletzung", async () => {
    // Abgewiesene Anfragen (401/423/502 aus den Attrappen) meldet Chromium als Ladefehler; Skriptfehler nie
    assert.deepEqual(probleme.filter((p) => !/Failed to load resource/.test(p)), []);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp), []);
  });
});
