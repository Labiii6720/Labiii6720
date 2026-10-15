import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core";
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
  /** Vertrauliches in Ansage und Toast bringen: Chat-Antwort (#ansage) und Protokoll-Rückmeldung (#toast), beide per route() */
  const GEHEIM_CHAT = "GEHEIME-ANTWORT Kontostand 12'345";
  const GEHEIM_TOAST = "GEHEIMER-TOAST Tresorcode 9876";
  async function geheimesZeigen() {
    await page.route("**/api/chat", (r) => r.fulfill({ json: { ok: true, reply: GEHEIM_CHAT } }));
    await page.route("**/api/protokoll", (r) => r.fulfill({ json: { ok: true, text: GEHEIM_TOAST } }));
    try {
      await page.evaluate(() => { location.hash = "uebersicht"; });
      await page.click('#v-uebersicht button[data-aktion="protokoll"][data-name="werkstatt"]');
      await page.waitForFunction((g) => document.getElementById("toast")?.textContent?.includes(g) ?? false, GEHEIM_TOAST);
      await page.evaluate(() => { location.hash = "gespraech"; });
      await page.waitForSelector("#chatIn");
      await page.fill("#chatIn", "Wie steht das Konto?");
      await page.keyboard.press("Enter");
      await page.waitForFunction((g) => document.getElementById("ansage")?.textContent?.includes(g) ?? false, GEHEIM_CHAT);
    } finally {
      await page.unroute("**/api/chat");
      await page.unroute("**/api/protokoll");
    }
    const html = await page.content();
    assert.ok(html.includes(GEHEIM_CHAT) && html.includes(GEHEIM_TOAST), "Vorbedingung: beides steht im DOM");
  }
  const ohneGeheimes = async (wann: string) => {
    const html = await page.content();
    assert.ok(!html.includes(GEHEIM_CHAT), `${wann}: Chat-Antwort nicht mehr im DOM`);
    assert.ok(!html.includes(GEHEIM_TOAST), `${wann}: Toast-Text nicht mehr im DOM`);
  };

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
    // page.unroute() wartet nicht auf laufende Handler: ein Handler, der gerade route.fetch() abwartet, findet die Anfrage
    // danach schon weitergeleitet und sein fulfill wirft «Route is already handled!» – nach dem Test, als unhandledRejection.
    // Nur diesen Fall schlucken; jeder andere Fehler im Handler bleibt sichtbar.
    const route = page.route.bind(page) as unknown as (url: string, h: (r: Route) => unknown) => Promise<unknown>;
    (page as unknown as { route: typeof route }).route = (url, h) => route(url, async (r) => {
      try { await h(r); } catch (e) { if (!/Route is already handled/.test(String(e))) throw e; }
    });
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
    // Die Rückmeldung kommt nach dem Schliessen des Dialogs in #ansage (die Ansage im Dialog wird beim Schliessen geleert)
    await page.waitForSelector("#dlgPin", { state: "hidden" });
    await page.waitForFunction(() => /Weiter, Sir\./.test(document.getElementById("ansage")?.textContent ?? ""), null, { timeout: 2000 });
    await page.waitForTimeout(100);
    assert.match((await page.textContent("#ansage")) ?? "", /Weiter, Sir\./, "bleibt nach dem close-Ereignis stehen");
  });

  it("Protokolle im Notaus: Knöpfe gesperrt mit Grund; veraltete Ansicht meldet Notaus und /weiter, nie Notfall", async () => {
    await page.evaluate(() => { location.hash = "uebersicht"; });
    const knopf = '#v-uebersicht button[data-aktion="protokoll"][data-name="werkstatt"]';
    await page.waitForSelector(knopf);
    assert.equal((await holeApi("/api/notaus", { method: "POST", body: { an: true } })).status, 200);
    try {
      await sofort(page);
      await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Pausiert", null, { timeout: 3000 });
      await page.waitForSelector(`${knopf}[aria-disabled="true"]`, { timeout: 3000 });
      assert.match((await page.getAttribute(knopf, "aria-description")) ?? "", /Im Notaus laufen keine Protokolle/);
      assert.match((await page.textContent("#v-uebersicht")) ?? "", /Im Notaus laufen keine Protokolle, Sir\./);
      // Ein Klick auf den gesperrten Knopf schickt nichts
      let posts = 0;
      await page.route("**/api/protokoll", (r) => { posts++; return r.continue(); });
      await page.click(knopf, { force: true });
      await page.waitForTimeout(150);
      assert.equal(posts, 0, "gesperrter Knopf sendet nichts");
      await page.unroute("**/api/protokoll");

      // Veraltete Ansicht (Notaus kam eben über Telegram): Knopf noch frei, der Server antwortet 423 ohne Notfall
      await page.route("**/status.json", async (route) => {
        const echt = await route.fetch();
        const d = await echt.json();
        await route.fulfill({ response: echt, json: { ...d, pausiert: false, notfall: false } });
      });
      await sofort(page);
      await page.waitForFunction((k) => { const b = document.querySelector(k); return Boolean(b) && b!.getAttribute("aria-disabled") !== "true"; }, knopf, { timeout: 3000 });
      const antwort = page.waitForResponse("**/api/protokoll");
      await page.click(knopf);
      assert.equal((await antwort).status(), 423);
      await page.waitForFunction(() => document.getElementById("toast")?.textContent?.includes("pausiert (Notaus)") ?? false, null, { timeout: 3000 });
      const toast = (await page.textContent("#toast")) ?? "";
      assert.match(toast, /\/weiter/);
      assert.doesNotMatch(toast, /Im Notfall gesperrt|\/entwarnung/);
      await page.unroute("**/status.json");
    } finally {
      await page.unroute("**/status.json").catch(() => undefined);
      await page.unroute("**/api/protokoll").catch(() => undefined);
      assert.equal((await holeApi("/api/notaus", { method: "POST", body: { an: false, pin: DEMO_PIN } })).status, 200);
    }
    await sofort(page);
    await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Bereit", null, { timeout: 3000 });
    assert.equal(await page.getAttribute(knopf, "aria-disabled"), null, "nach Weiter wieder frei");
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
    assert.equal(await page.isDisabled("#notausKnopf"), true, "Weiter ist im Notfall gesperrt");

    await page.unroute("**/status.json");
    await sofort(page);
    await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Bereit", null, { timeout: 3000 });
    await page.waitForSelector("#v-uebersicht .auftrag", { timeout: 3000 });
    assert.equal(await page.locator("#v-uebersicht .auftrag").count(), 3);
    assert.equal(await page.isVisible("#bandNotfall"), false);
    assert.equal(await page.isDisabled("#notausKnopf"), false);
    await page.waitForSelector("#v-uebersicht .kpis .funke", { timeout: 3000 });
  });

  it("Notfall während eines laufenden Protokolls: der Protokolltext erscheint weder im Toast noch in der Ansage", async () => {
    const GEHEIM = "GEHEIMES-PROTOKOLL Alarmcode 4711";
    await page.evaluate(() => { location.hash = "uebersicht"; });
    const knopf = '#v-uebersicht button[data-aktion="protokoll"][data-name="werkstatt"]';
    await page.waitForSelector(knopf);
    let loslassen: () => void = () => undefined;
    const freigegeben = new Promise<void>((r) => { loslassen = r; });
    let angekommen: () => void = () => undefined;
    const unterwegs = new Promise<void>((r) => { angekommen = r; });
    // Antwort zurückhalten, bis die Kommandozentrale den Notfall sieht
    await page.route("**/api/protokoll", async (r) => { angekommen(); await freigegeben; await r.fulfill({ json: { ok: true, text: GEHEIM } }); });
    try {
      const antwort = page.waitForResponse("**/api/protokoll");
      await page.click(knopf);
      await unterwegs;
      await page.route("**/status.json", async (route) => {
        const echt = await route.fetch();
        const d = await echt.json();
        await route.fulfill({ response: echt, json: { ...d, notfall: true, pausiert: true, offeneAuftraege: 0, auftraege: [], protokolle: [] } });
      });
      await sofort(page);
      await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Notfall", null, { timeout: 3000 });
      loslassen();
      await antwort;
      await page.waitForTimeout(300);
      assert.ok(!((await page.textContent("#toast")) ?? "").includes(GEHEIM), "Protokolltext nicht im Toast");
      assert.ok(!((await page.textContent("#ansage")) ?? "").includes(GEHEIM), "Protokolltext nicht in der Ansage");
      assert.ok(!(await page.content()).includes(GEHEIM), "Protokolltext nirgends im DOM");
    } finally {
      loslassen();
      await page.unroute("**/api/protokoll").catch(() => undefined);
      await page.unroute("**/status.json").catch(() => undefined);
    }
    await sofort(page);
    await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Bereit", null, { timeout: 3000 });
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

  it("Finanzen: die Anzahl neben dem CHF-Betrag behauptet nichts über andere Währungen", async () => {
    // Feste Monatszeilen: Oktober 4 offene CHF + 1 offene EUR (Zählung des Servers über alle Währungen),
    // September nur CHF, August mit Anzahl je Währung (anzahlJe)
    const monate = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
    await page.route("**/api/finanzen", async (r) => {
      const echt = await r.fetch();
      const d = (await echt.json()) as Record<string, unknown>;
      const proMonat = monate.map((monat) => ({ monat, bezahlt: {}, offen: {}, anzahlBezahlt: 0, anzahlOffen: 0 } as Record<string, unknown>));
      proMonat[5] = { monat: "2026-10", bezahlt: { CHF: 120 }, offen: { CHF: 2927, EUR: 289.4 }, anzahlBezahlt: 2, anzahlOffen: 5 };
      proMonat[4] = { monat: "2026-09", bezahlt: { CHF: 80 }, offen: { CHF: 40 }, anzahlBezahlt: 1, anzahlOffen: 1 };
      proMonat[3] = { monat: "2026-08", bezahlt: { CHF: 300, EUR: 118 }, offen: {}, anzahlBezahlt: 3, anzahlOffen: 0, anzahlJe: { bezahlt: { CHF: 2, EUR: 1 }, offen: {} } };
      await r.fulfill({ response: echt, json: { ...d, proMonat } }).catch(() => undefined);
    });
    try {
      await page.evaluate(() => { location.hash = "uebersicht"; });
      await page.waitForSelector("#v-uebersicht:not([hidden])");
      await page.evaluate(() => { location.hash = "finanzen"; });
      // Nur die Attrappe liefert «5 offen (alle Währungen)»; die Demo-Daten zeigen ebenfalls 2’927.00 CHF offen,
      // bis die umgeleitete Antwort da ist, steht also noch das alte Diagramm.
      await page.waitForFunction(() => document.querySelector("#v-finanzen g.gruppe[data-merk='fd:5']")?.getAttribute("aria-label")?.includes("5 offen (alle Währungen)") ?? false, null, { timeout: 3000 });
      assert.match((await page.getAttribute("#v-finanzen g.gruppe[data-merk='fd:5']", "aria-label")) ?? "", /offen 2’927\.00 CHF/);
      const label = (i: number) => page.getAttribute(`#v-finanzen g.gruppe[data-merk='fd:${i}']`, "aria-label");
      assert.match((await label(5)) ?? "", /2 bezahlt · 5 offen \(alle Währungen\)/);
      assert.match((await label(4)) ?? "", /1 bezahlt · 1 offen$/);
      assert.match((await label(3)) ?? "", /2 bezahlt · 0 offen$/, "anzahlJe: nur CHF gezählt");
      await page.focus("#v-finanzen g.gruppe[tabindex='0']");
      await page.waitForSelector("#v-finanzen .tip.an");
      assert.match((await page.textContent("#v-finanzen .tip")) ?? "", /5 offen \(alle Währungen\)/);
      await page.click('#v-finanzen button[data-aktion="ansicht"]');
      await page.waitForSelector("#v-finanzen table");
      const zeile = async (monat: string) => ((await page.locator("#v-finanzen table").first().locator("tr", { hasText: monat }).textContent()) ?? "");
      assert.match(await zeile("Oktober 2026"), /2 \/ 5 \(alle Währungen\)/);
      assert.match(await zeile("September 2026"), /1 \/ 1$/);
      assert.match(await zeile("August 2026"), /2 \/ 0$/);
      await page.click('#v-finanzen button[data-aktion="ansicht"]');
    } finally {
      await page.unroute("**/api/finanzen");
    }
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
    await geheimesZeigen();
    let abrufe = 0;
    await page.route("**/status.json", async (route) => { abrufe++; await route.fulfill({ status: 401, json: { ok: false, error: "unauthorized" } }); });
    await sofort(page);
    await page.waitForSelector("#dlgAnmelden[open]");
    await ohneGeheimes("nach 401");
    const bisher = abrufe;
    await sofort(page);
    await page.waitForTimeout(300);
    assert.equal(abrufe, bisher, "keine weiteren Abfragen ohne Token");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("jarvis.kommandozentrale.token")), null);
    await page.unroute("**/status.json");
    // Ein Wert der Gesten-Konsole unter «jarvis.token» (gleicher Ursprung) bleibt unberührt
    await page.evaluate(() => localStorage.setItem("jarvis.token", "wert-der-gesten-konsole"));
    await page.fill("#anmToken", dienst!.token);
    await page.check("#anmMerken");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#dlgAnmelden", { state: "hidden" });
    assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.kommandozentrale.token")), dienst!.token);
    await geheimesZeigen();
    await page.evaluate(() => { location.hash = "sicherheit"; });
    await page.click('#v-sicherheit button[data-aktion="abmelden"]');
    await page.waitForSelector("#dlgAnmelden[open]");
    await ohneGeheimes("nach dem Abmelden");
    assert.deepEqual(await page.evaluate(() => [sessionStorage.getItem("jarvis.kommandozentrale.token"), localStorage.getItem("jarvis.kommandozentrale.token")]), [null, null]);
    assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.token")), "wert-der-gesten-konsole", "Konsole behält ihren Wert");
    assert.equal(await page.locator("#v-uebersicht .auftrag").count(), 0, "Inhalte sind weg");
    // Die Bestätigung liegt über dem Anmeldedialog und wird im Dialog angesagt
    assert.equal(await page.evaluate(() => document.getElementById("toast")!.matches(":popover-open")), true);
    assert.match((await page.textContent("#toast")) ?? "", /Abgemeldet, Sir/);
    assert.match((await page.textContent("#dlgAnmelden .dlg-ansage")) ?? "", /Abgemeldet, Sir/);
    // Dieselbe Kopie unter «jarvis.token» (Gesten-Konsole oder «merken» im Zwischenstand von 0.22) geht beim Abmelden mit
    await page.evaluate((t) => localStorage.setItem("jarvis.token", t), dienst!.token);
    await page.fill("#anmToken", dienst!.token);
    await page.keyboard.press("Enter");
    await page.waitForSelector("#dlgAnmelden", { state: "hidden" });
    await page.waitForSelector('#v-sicherheit button[data-aktion="abmelden"]');
    await page.click('#v-sicherheit button[data-aktion="abmelden"]');
    await page.waitForSelector("#dlgAnmelden[open]");
    assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.token")), null, "Kopie des Tokens gelöscht");
    assert.match((await page.textContent("#toast")) ?? "", /Der Token ist aus diesem Browser gelöscht/);
    await page.evaluate(() => localStorage.removeItem("jarvis.token"));
  });

  it("Token der Gesten-Konsole («jarvis.token») meldet die Kommandozentrale nicht an", async () => {
    const c2 = await browser!.newContext({ viewport: { width: 1280, height: 860 } });
    try {
      const p = await c2.newPage();
      p.setDefaultTimeout(4000);
      await p.goto(dienst!.url + "/dashboard");
      await p.waitForSelector("#dlgAnmelden[open]");
      await p.evaluate((t) => localStorage.setItem("jarvis.token", t), dienst!.token);
      await p.reload();
      await p.waitForSelector("#dlgAnmelden[open]");
      await p.waitForTimeout(150);
      assert.equal(await p.evaluate(() => (document.getElementById("dlgAnmelden") as HTMLDialogElement).open), true, "kein stilles Anmelden");
      assert.equal(await p.isChecked("#anmMerken"), false, "«merken» nicht vorab angekreuzt");
      await p.fill("#anmToken", dienst!.token);
      await p.keyboard.press("Enter");
      await p.waitForSelector("#v-uebersicht .auftraege");
      assert.deepEqual(await p.evaluate(() => [localStorage.getItem("jarvis.token"), localStorage.getItem("jarvis.kommandozentrale.token"), sessionStorage.getItem("jarvis.kommandozentrale.token") !== null]),
        [dienst!.token, null, true], "ohne «merken» nur sessionStorage; der Wert der Konsole bleibt");
    } finally {
      await c2.close();
    }
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
    // Ohne offenen Dialog sagt die immer vorhandene Region #ansage an; der Toast (geschlossen display:none) ist keine Live-Region
    assert.match((await page.textContent("#ansage")) ?? "", /#201/);
    assert.deepEqual(await page.evaluate(() => [document.getElementById("toast")!.getAttribute("aria-live"), document.getElementById("toast")!.getAttribute("role")]), [null, null]);
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

  it("Zeitpläne vor 0.22 («täglich», «So, sa»): Tage im Formular gewählt, normalisiert gesendet", async () => {
    await page.route("**/api/zeitplaene", async (r) => {
      if (r.request().method() !== "GET") return r.fallback();
      const echt = await r.fetch();
      const d = (await echt.json()) as { zeitplaene: { id: number; tage: string }[] };
      for (const z of d.zeitplaene) { if (z.id === 2) z.tage = "So, sa"; if (z.id === 3) z.tage = "täglich"; }
      // Nach unroute kann Playwright die Anfrage schon weitergereicht haben: dann gilt die echte Antwort
      await r.fulfill({ response: echt, json: d }).catch(() => undefined);
    });
    let gesendet: Record<string, unknown> | undefined;
    await page.route("**/api/zeitplaene/2", async (r) => {
      if (r.request().method() !== "PUT") return r.fallback();
      gesendet = r.request().postDataJSON() as Record<string, unknown>;
      await r.fulfill({ json: { ok: true, text: "Gespeichert, Sir." } });
    });
    await page.evaluate(() => { location.hash = "zeitplaene"; });
    const zeitText = (name: string) => page.evaluate((n) => [...document.querySelectorAll("#v-zeitplaene .plan")].find((e) => e.textContent?.includes(n))?.querySelector(".zeit small")?.textContent, name);
    await page.waitForFunction(() => /Täglich/.test([...document.querySelectorAll("#v-zeitplaene .plan")].find((e) => e.textContent?.includes("NVR-Sicherung"))?.textContent ?? ""), null, { timeout: 3000 });
    assert.equal(await zeitText("NVR-Sicherung"), "Täglich");
    assert.equal(await zeitText("Wochenende"), "Sa, So");
    const formular = () => page.evaluate(() => ({
      art: (document.querySelector('input[name="tageArt"]:checked') as HTMLInputElement | null)?.value,
      tage: [...document.querySelectorAll<HTMLInputElement>("#pTage input:checked")].map((i) => i.value),
    }));
    await page.locator("#v-zeitplaene .plan", { hasText: "NVR-Sicherung" }).locator('button[data-aktion="plan-edit"]').click();
    await page.waitForSelector("#dlgPlan[open]");
    assert.deepEqual(await formular(), { art: "taeglich", tage: ["mo", "di", "mi", "do", "fr", "sa", "so"] });
    await page.click("#dlgPlan [data-schliessen]");
    await page.waitForSelector("#dlgPlan", { state: "hidden" });
    await page.locator("#v-zeitplaene .plan", { hasText: "Wochenende" }).locator('button[data-aktion="plan-edit"]').click();
    await page.waitForSelector("#dlgPlan[open]");
    assert.deepEqual(await formular(), { art: "liste", tage: ["sa", "so"] });
    // Nur den Namen ändern: speichert ohne Tagesfehler, mit den Tagen in der Schreibweise des Servers
    await page.fill("#pName", "Wochenende ruhig");
    // Nach dem Speichern holt die Seite die Liste neu: abwarten, sonst trifft unroute einen laufenden Handler
    const neuGeholt = page.waitForResponse((x) => new URL(x.url()).pathname === "/api/zeitplaene" && x.request().method() === "GET");
    await page.click("#planOk");
    await page.waitForSelector("#dlgPlan", { state: "hidden" });
    await neuGeholt;
    assert.equal(await page.isVisible("#pTageF"), false);
    assert.equal(gesendet?.tage, "sa,so");
    await page.unroute("**/api/zeitplaene/2");
    await page.unroute("**/api/zeitplaene");
  });

  it("Speicherfehler bei offenem Formular: Rückmeldung über dem Dialog sichtbar und im Dialog angesagt", async () => {
    await page.route("**/api/zeitplaene", (r) => (r.request().method() === "POST" ? r.abort("connectionfailed") : r.fallback()));
    try {
      await page.evaluate(() => { location.hash = "zeitplaene"; });
      await page.waitForSelector('#v-zeitplaene button[data-aktion="plan-neu"]:not([disabled])');
      await page.click('#v-zeitplaene button[data-aktion="plan-neu"]');
      await page.waitForSelector("#dlgPlan[open]");
      await page.fill("#pName", "Nie gespeichert");
      await page.fill("#pAuftrag", "Kommt nicht an.");
      await page.click("#planOk");
      await page.waitForSelector("#toast.an");
      await page.waitForTimeout(300); // Einblenden (0.2 s) abwarten
      const lage = await page.evaluate(() => {
        const t = document.getElementById("toast")!;
        const r = t.getBoundingClientRect();
        return { offen: t.matches(":popover-open"), dialog: (document.getElementById("dlgPlan") as HTMLDialogElement).open,
          unten: Math.round(innerHeight - r.bottom), mitte: Math.round(r.left + r.width / 2 - innerWidth / 2), ansage: document.querySelector("#dlgPlan .dlg-ansage")?.textContent };
      });
      assert.equal(lage.offen, true, "Toast in der obersten Ebene (über Dialog und Hintergrund)");
      assert.equal(lage.dialog, true, "Formular bleibt offen");
      assert.ok(Math.abs(lage.unten - 24) <= 2 && Math.abs(lage.mitte) <= 2, `Lage unten Mitte: ${JSON.stringify(lage)}`);
      assert.match((await page.textContent("#toast")) ?? "", /Ich erreiche den Dienst nicht, Sir\./);
      assert.match(lage.ansage ?? "", /Ich erreiche den Dienst nicht, Sir\./);
      // Im Barrierefreiheitsbaum erreichbar (der Rest der Seite ist hinter dem Modal inert)
      const cdp = await ctx.newCDPSession(page);
      try {
        const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: { ignored: boolean; name?: { value: string } }[] };
        assert.ok(nodes.some((n) => !n.ignored && /Ich erreiche den Dienst nicht/.test(n.name?.value ?? "")), "Meldung im Barrierefreiheitsbaum");
      } finally {
        await cdp.detach();
      }
      await page.click("#dlgPlan [data-schliessen]");
      await page.waitForSelector("#dlgPlan", { state: "hidden" });
      // dialog.close() feuert «close» erst in einer späteren Task; darauf warten statt sofort zu lesen
      await page.waitForFunction(() => document.querySelector("#dlgPlan .dlg-ansage")?.textContent === "", undefined, { timeout: 1000 });
      assert.equal(await page.textContent("#dlgPlan .dlg-ansage"), "", "Ansage beim Schliessen geleert");
    } finally {
      await page.unroute("**/api/zeitplaene");
    }
  });

  it("Fokus auf Links der Übersicht übersteht den Neuaufbau (Lage, «Historie ›», «Zeitpläne ›»)", async () => {
    await page.evaluate(() => { location.hash = "uebersicht"; });
    await page.waitForSelector("#v-uebersicht:not([hidden]) .auftraege");
    const faelle: [string, string][] = [
      ['#v-uebersicht .lage-liste a[data-merk="lage:freigaben"]', "fokus"],
      ['#v-uebersicht a[data-merk="u-historie"]', "nacht"],
      ['#v-uebersicht a[data-merk="u-zeitplaene"]', "normal"],
    ];
    for (const [sel, modus] of faelle) {
      await page.focus(sel);
      await page.evaluate((s) => { (document.querySelector(s) as HTMLElement & { __alt?: boolean }).__alt = true; }, sel);
      assert.equal((await holeApi("/api/modus", { method: "POST", body: { modus } })).status, 200);
      await sofort(page);
      await page.waitForSelector(`#v-uebersicht [data-modus="${modus}"][aria-checked="true"]`, { state: "attached", timeout: 3000 });
      const f = await page.evaluate(() => {
        const a = document.activeElement as (HTMLElement & { __alt?: boolean }) | null;
        return { merk: a?.dataset.merk ?? a?.tagName, neu: !a?.__alt };
      });
      assert.deepEqual(f, { merk: await page.getAttribute(sel, "data-merk"), neu: true }, sel);
    }
    // Sprung aus der Lage: das Ziel behält den Fokus auch nach dem nächsten Neuaufbau
    await page.focus('#v-uebersicht .lage-liste a[data-merk="lage:freigaben"]');
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.id === "auftrAnker", null, { timeout: 2000 });
    await page.evaluate(() => { (document.activeElement as HTMLElement & { __alt?: boolean }).__alt = true; });
    assert.equal((await holeApi("/api/modus", { method: "POST", body: { modus: "nacht" } })).status, 200);
    await sofort(page);
    await page.waitForSelector('#v-uebersicht [data-modus="nacht"][aria-checked="true"]', { state: "attached", timeout: 3000 });
    assert.deepEqual(await page.evaluate(() => {
      const a = document.activeElement as (HTMLElement & { __alt?: boolean }) | null;
      return { id: a?.id, neu: !a?.__alt };
    }), { id: "auftrAnker", neu: true });
    assert.equal((await holeApi("/api/modus", { method: "POST", body: { modus: "normal" } })).status, 200);
  });

  it("Verbindungsstörung gilt nur für den sichtbaren Bereich: nach dem Wechsel kein Dauerhinweis", async () => {
    await page.route("**/api/auftraege*", (r) => r.abort("connectionfailed"));
    try {
      await page.evaluate(() => { location.hash = "freigaben"; });
      await page.waitForSelector("#stoerung:not([hidden])", { timeout: 3000 });
      assert.equal(await page.evaluate(() => document.getElementById("main")!.classList.contains("halten")), true);
    } finally {
      await page.unroute("**/api/auftraege*");
    }
    await page.evaluate(() => { location.hash = "sicherheit"; });
    await page.waitForSelector("#v-sicherheit:not([hidden]) #h-sicherheit");
    await sofort(page);
    await page.waitForSelector("#stoerung", { state: "hidden", timeout: 3000 });
    assert.equal(await page.evaluate(() => document.getElementById("main")!.classList.contains("halten")), false);
    // Zurück in Freigaben: die Quelle wird neu geholt, der Hinweis bleibt weg
    await page.evaluate(() => { location.hash = "freigaben"; });
    await page.waitForSelector("#v-freigaben .verlauf");
    assert.equal(await page.isVisible("#stoerung"), false);
  });

  it("Verbindungsstörung wird angesagt: ohne Dialog in #ansage, bei offenem Dialog in dessen Ansage", async () => {
    const dlgAnsage = () => page.evaluate(() => document.querySelector("#dlgPlan .dlg-ansage")?.textContent ?? "");
    const ansage = () => page.evaluate(() => document.getElementById("ansage")?.textContent ?? "");
    // Ohne Dialog: #ansage
    await page.evaluate(() => { location.hash = "zeitplaene"; });
    await page.waitForSelector('#v-zeitplaene button[data-aktion="plan-neu"]:not([disabled])');
    await page.route("**/status.json*", (r) => r.abort("connectionfailed"));
    try {
      await sofort(page);
      await page.waitForSelector("#stoerung:not([hidden])", { timeout: 3000 });
      await page.waitForFunction(() => /Verbindung gestört/.test(document.getElementById("ansage")?.textContent ?? ""), null, { timeout: 2000 });
    } finally {
      await page.unroute("**/status.json*");
    }
    await sofort(page);
    await page.waitForSelector("#stoerung", { state: "hidden", timeout: 3000 });
    assert.match(await ansage(), /Verbindung wieder da/);

    // Mit offenem Dialog: der Kopf ist inert, also in die Ansage des Dialogs – #ansage bleibt leer
    await page.click('#v-zeitplaene button[data-aktion="plan-neu"]');
    await page.waitForSelector("#dlgPlan[open]");
    await page.evaluate(() => { document.getElementById("ansage")!.textContent = ""; });
    try {
      await page.route("**/status.json*", (r) => r.abort("connectionfailed"));
      try {
        await sofort(page);
        await page.waitForSelector("#stoerung:not([hidden])", { state: "attached", timeout: 3000 });
        assert.match(await dlgAnsage(), /Verbindung gestört/);
        assert.equal(await ansage(), "", "nicht zusätzlich in #ansage");
      } finally {
        await page.unroute("**/status.json*");
      }
      await sofort(page);
      await page.waitForSelector("#stoerung", { state: "hidden", timeout: 3000 });
      assert.match(await dlgAnsage(), /Verbindung wieder da/);
      assert.equal(await ansage(), "", "nicht zusätzlich in #ansage");
    } finally {
      await page.click("#dlgPlan [data-schliessen]");
      await page.waitForSelector("#dlgPlan", { state: "hidden" });
    }
  });

  it("Notfall und 401 schliessen offene Dialoge und leeren ihre Felder", async () => {
    const offeneDialoge = () => page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.id));
    const felder = () => page.evaluate(() => ({
      name: (document.getElementById("pName") as HTMLInputElement).value,
      auftrag: (document.getElementById("pAuftrag") as HTMLTextAreaElement).value,
      frage: (document.getElementById("wFrage") as HTMLTextAreaElement).value,
      pin: document.getElementById("pinText")!.textContent,
      bestaetigung: document.getElementById("frageText")!.textContent,
    }));
    const leer = { name: "", auftrag: "", frage: "", pin: "", bestaetigung: "" };
    const planOeffnen = async () => {
      await page.evaluate(() => { location.hash = "zeitplaene"; });
      await page.waitForSelector('#v-zeitplaene button[data-aktion="plan-edit"]');
      await page.locator('#v-zeitplaene button[data-aktion="plan-edit"]').first().click();
      await page.waitForSelector("#dlgPlan[open]");
      assert.notEqual(await page.inputValue("#pAuftrag"), "", "Auftragstext steht im Formular");
    };

    // Notfall bei offenem Zeitplan-Formular (vorher Vertrauliches in Ansage, Toast und Gesprächsverlauf)
    await geheimesZeigen();
    await planOeffnen();
    await page.route("**/status.json", async (route) => {
      const echt = await route.fetch();
      const d = await echt.json();
      await route.fulfill({ response: echt, json: { ...d, notfall: true, pausiert: true, offeneAuftraege: 3, auftraege: [], zeitplaene: [], wachen: [], kameras: [] } });
    });
    try {
      await sofort(page);
      await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Notfall", null, { timeout: 3000 });
      await page.waitForFunction(() => !document.querySelector("dialog[open]"), null, { timeout: 2000 });
      assert.deepEqual(await felder(), leer);
      await ohneGeheimes("im Notfall");
    } finally {
      await page.unroute("**/status.json");
    }
    await sofort(page);
    await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Bereit", null, { timeout: 3000 });

    // 401 bei offenem Formular: nur die Anmeldung bleibt, die Felder sind leer
    await planOeffnen();
    await page.route("**/status.json", (route) => route.fulfill({ status: 401, json: { ok: false, error: "unauthorized" } }));
    try {
      await sofort(page);
      await page.waitForSelector("#dlgAnmelden[open]");
      assert.deepEqual(await offeneDialoge(), ["dlgAnmelden"]);
      assert.deepEqual(await felder(), leer);
    } finally {
      await page.unroute("**/status.json");
    }
    await page.fill("#anmToken", dienst!.token);
    await page.keyboard.press("Enter");
    await page.waitForSelector("#dlgAnmelden", { state: "hidden" });
    await page.evaluate(() => { location.hash = "uebersicht"; });
    await page.waitForSelector("#v-uebersicht .auftraege");
  });

  it("Anmeldedialog bleibt auch nach mehrfachem Esc offen", async () => {
    const c2 = await browser!.newContext({ viewport: { width: 1280, height: 860 } });
    try {
      const p = await c2.newPage();
      p.setDefaultTimeout(4000);
      await p.goto(dienst!.url + "/dashboard");
      await p.waitForSelector("#dlgAnmelden[open]");
      await p.click("#anmToken");
      await p.keyboard.type("x");
      for (let i = 1; i <= 3; i++) {
        await p.keyboard.press("Escape");
        await p.waitForFunction(() => (document.getElementById("dlgAnmelden") as HTMLDialogElement).open && document.activeElement?.id === "anmToken", null, { timeout: 2000 });
        await p.waitForTimeout(50);
        assert.equal(await p.evaluate(() => (document.getElementById("dlgAnmelden") as HTMLDialogElement).open), true, `nach Esc ${i}`);
      }
      // Der Weg hinein bleibt: Token eingeben genügt
      await p.fill("#anmToken", dienst!.token);
      await p.keyboard.press("Enter");
      await p.waitForSelector("#v-uebersicht .auftraege");
      await p.waitForSelector("#dlgAnmelden", { state: "hidden" });
    } finally {
      await c2.close();
    }
  });

  it("Umstellung auf Sommerzeit: «morgen» und «gestern» nach Kalendertag, nicht ±24 h", async () => {
    // Serverzeit über /status.json injiziert (die Seite rechnet mit dem Versatz zur Serverzeit)
    let zeitStatus = "2027-03-27T22:30:00.000Z"; // Sa 27.03.2027, 23:30 MEZ; der Sonntag hat nur 23 Stunden
    await page.route("**/status.json", async (route) => {
      const echt = await route.fetch();
      const d = (await echt.json()) as Record<string, unknown>;
      await route.fulfill({ response: echt, json: { ...d, zeit: zeitStatus } }).catch(() => undefined);
    });
    await page.route("**/api/zeitplaene", async (r) => {
      if (r.request().method() !== "GET") return r.fallback();
      const echt = await r.fetch();
      const d = (await echt.json()) as Record<string, unknown>;
      const plan = (id: number, name: string, tage: string, naechsterLauf: string, lastRun: string) => ({ id, name, zeit: "07:00", tage, auftrag: "Probe.", naechsterLauf, lastRun });
      await r.fulfill({ response: echt, json: { ...d, zeitplaene: [
        plan(91, "Sonntagslauf", "so", "2027-03-28T05:00:00.000Z", "2027-03-27"), // So 07:00 MESZ
        plan(92, "Montagslauf", "mo", "2027-03-29T05:00:00.000Z", "2027-03-26"), // Mo 07:00 MESZ
      ] } }).catch(() => undefined);
    });
    const lauf = (name: string) => page.evaluate((n) => [...document.querySelectorAll("#v-zeitplaene .plan")].find((e) => e.textContent?.includes(n))?.querySelector(".lauf")?.textContent ?? "", name);
    try {
      await page.evaluate(() => { location.hash = "zeitplaene"; });
      await sofort(page);
      await page.waitForFunction(() => /Sonntagslauf/.test(document.getElementById("v-zeitplaene")?.textContent ?? ""), null, { timeout: 4000 });
      await page.waitForFunction(() => /nächster morgen 07:00/.test([...document.querySelectorAll("#v-zeitplaene .plan")].find((e) => e.textContent?.includes("Sonntagslauf"))?.textContent ?? ""), null, { timeout: 3000 });
      assert.equal(await lauf("Sonntagslauf"), "nächster morgen 07:00zuletzt heute");
      assert.equal(await lauf("Montagslauf"), "nächster Mo 29.03. 07:00zuletzt gestern");
      // Mo 29.03.2027, 00:30 MESZ: der Samstag ist vorgestern, nicht gestern
      zeitStatus = "2027-03-28T22:30:00.000Z";
      await sofort(page);
      await page.waitForFunction(() => /zuletzt 27\.03\./.test([...document.querySelectorAll("#v-zeitplaene .plan")].find((e) => e.textContent?.includes("Sonntagslauf"))?.textContent ?? ""), null, { timeout: 3000 });
      assert.equal(await lauf("Montagslauf"), "nächster heute 07:00zuletzt 26.03.");
    } finally {
      await page.unroute("**/api/zeitplaene");
      await page.unroute("**/status.json");
    }
    await sofort(page);
    await page.waitForFunction(() => !/Sonntagslauf/.test(document.getElementById("v-zeitplaene")?.textContent ?? ""), null, { timeout: 4000 });
  });

  it("Tastaturfokus bleibt nach Ablehnen, PIN-Freigabe und Löschen in der Karte, nie auf <body>", async () => {
    // Zusätzliche wartende Aufträge nur in der Anzeige (#301–#303); ihre Antworten kommen aus der Attrappe
    const weg = new Set<number>();
    const extra = [
      { id: 301, tool: "gmail_senden", stufe: "extern", summary: "Probe A" },
      { id: 302, tool: "gmail_senden", stufe: "extern", summary: "Probe B" },
      { id: 303, tool: "geraet_schalten", stufe: "sensibel", summary: "Probe C" },
    ];
    await page.route("**/status.json", async (route) => {
      const echt = await route.fetch();
      const d = (await echt.json()) as { auftraege?: unknown[] } & Record<string, unknown>;
      const neu = extra.filter((a) => !weg.has(a.id)).map((a) => ({ ...a, seit: new Date(Date.now() - 60000).toISOString() }));
      await route.fulfill({ response: echt, json: { ...d, auftraege: [...(d.auftraege ?? []), ...neu] } }).catch(() => undefined);
    });
    await page.route("**/api/auftrag", async (r) => {
      const b = r.request().postDataJSON() as { id: number; aktion: string };
      if (!extra.some((a) => a.id === b.id)) return r.fallback();
      await new Promise((ok) => setTimeout(ok, 400));
      weg.add(b.id);
      await r.fulfill({ json: { ok: true, text: `#${b.id} ${b.aktion === "ok" ? "erledigt" : "abgelehnt"}.` } }).catch(() => undefined);
    });
    const fokus = () => page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return { body: !a || a === document.body, inKarte: Boolean(a?.closest("#auftrAnker")), aktion: a?.dataset.aktion ?? "", id: a?.dataset.id ?? "", gesperrt: a?.getAttribute("aria-disabled") ?? "" };
    });
    try {
      await page.evaluate(() => { location.hash = "uebersicht"; });
      await sofort(page);
      await page.waitForSelector('#v-uebersicht button[data-aktion="ablehnen"][data-id="302"]');
      // Ablehnen per Tastatur: während der Anfrage bleibt der Fokus auf dem (nur als gesperrt markierten) Knopf
      await page.focus('#v-uebersicht button[data-aktion="ablehnen"][data-id="302"]');
      await page.keyboard.press("Enter");
      await page.waitForSelector('#v-uebersicht button[data-aktion="ablehnen"][data-id="302"][aria-disabled="true"]');
      assert.deepEqual(await fokus(), { body: false, inKarte: true, aktion: "ablehnen", id: "302", gesperrt: "true" });
      await page.waitForFunction(() => !document.querySelector('#v-uebersicht [data-id="302"]'), null, { timeout: 4000 });
      assert.deepEqual(await fokus(), { body: false, inKarte: true, aktion: "ablehnen", id: "301", gesperrt: "" }, "Fokus auf dem nächsten Auftrag");
      // Sensibel mit PIN: der Dialog gibt den Fokus zurück, nach dem Neuaufbau liegt er auf dem Nachbarn
      await page.focus('#v-uebersicht button[data-aktion="freigeben"][data-id="303"]');
      await page.keyboard.press("Enter");
      await page.waitForSelector("#dlgPin[open]");
      await page.keyboard.type(DEMO_PIN);
      await page.keyboard.press("Enter");
      await page.waitForSelector("#dlgPin", { state: "hidden" });
      await page.waitForFunction(() => !document.querySelector('#v-uebersicht [data-id="303"]'), null, { timeout: 4000 });
      assert.match((await page.textContent("#ansage")) ?? "", /#303 erledigt\./, "PIN-Freigabe wird angesagt");
      const f = await fokus();
      assert.equal(f.body, false, "nicht auf <body>");
      assert.equal(f.inKarte, true, `in «Offene Aufträge»: ${JSON.stringify(f)}`);
      // Der nächste Tab bleibt in der Karte, statt nach oben zur Lage zu springen
      await page.keyboard.press("Tab");
      assert.equal((await fokus()).inKarte, true, "Tab danach bleibt in der Karte");
    } finally {
      await page.unroute("**/api/auftrag");
      await page.unroute("**/status.json");
    }
    await sofort(page);

    // Zeitplan löschen per Tastatur: Fokus landet im Zeitplan-Bereich, nicht auf <body>
    assert.equal((await holeApi("/api/zeitplaene", { method: "POST", body: { name: "Fokusprobe", zeit: "05:55", tage: "taeglich", auftrag: "Nichts." } })).status, 201);
    await page.evaluate(() => { location.hash = "zeitplaene"; });
    const loeschen = page.locator("#v-zeitplaene .plan", { hasText: "Fokusprobe" }).locator('button[data-aktion="plan-weg"]');
    await loeschen.waitFor();
    await loeschen.focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector("#dlgFrage[open]");
    await page.focus("#frageOk");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => ![...document.querySelectorAll("#v-zeitplaene .plan .name")].some((e) => e.textContent === "Fokusprobe"), null, { timeout: 4000 });
    const z = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return { body: !a || a === document.body, karte: a?.closest(".karte")?.querySelector("h2")?.textContent ?? "", aktion: a?.dataset.aktion ?? "" };
    });
    assert.deepEqual(z, { body: false, karte: "Zeitpläne", aktion: "plan-edit" }, "Fokus auf dem nächsten Zeitplan");
  });

  it("Gespräch: nach «Senden» per Tastatur oder Klick liegt der Fokus im Eingabefeld, nie auf <body>", async () => {
    // Jede Anfrage wartet, bis der Test sie loslässt: so lässt sich der Fokus während «läuft …» prüfen
    const tore: (() => void)[] = [];
    await page.route("**/api/chat", async (r) => {
      await new Promise<void>((ok) => { tore.push(ok); });
      await r.fulfill({ json: { ok: true, reply: "Erledigt, Sir." } }).catch(() => undefined);
    });
    const fokus = () => page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return !a || a === document.body ? "body" : a.id || a.tagName;
    });
    const antworten = () => page.locator("#v-gespraech .msg.jv:not(.laeuft)").count();
    try {
      await page.evaluate(() => { location.hash = "gespraech"; });
      await page.waitForSelector("#v-gespraech:not([hidden]) #chatIn");
      for (const art of ["tastatur", "klick"] as const) {
        const vorher = await antworten();
        await page.fill("#chatIn", "Fokusprobe " + art);
        if (art === "tastatur") {
          await page.focus("#chatIn");
          await page.keyboard.press("Tab");
          assert.equal(await fokus(), "chatSenden", "Vorbedingung: Fokus auf «Senden»");
          await page.keyboard.press("Enter");
        } else {
          await page.click("#chatSenden");
        }
        await page.waitForSelector("#v-gespraech .msg.laeuft");
        assert.equal(await fokus(), "chatIn", `${art}: während der Antwort im Eingabefeld`);
        for (let i = 0; i < 100 && !tore.length; i++) await page.waitForTimeout(20);
        tore.shift()!();
        await page.waitForSelector("#chatSenden:not([disabled])", { timeout: 3000 });
        await page.waitForFunction((n) => document.querySelectorAll("#v-gespraech .msg.jv:not(.laeuft)").length > n, vorher, { timeout: 3000 });
        assert.equal(await fokus(), "chatIn", `${art}: nach der Antwort im Eingabefeld`);
      }
    } finally {
      for (const t of tore) t();
      await page.unroute("**/api/chat");
    }
  });

  it("Gespräch: kommt die Antwort bei offenem Dialog (Notaus-Frage), sagt sie der Dialog an – nicht das inerte #ansage", async () => {
    // Antwort, Antwort per Telegram und Fehler: jede Anfrage wartet, bis der Dialog offen ist
    const faelle = [
      { art: "antwort", antwort: { json: { ok: true, reply: "Die Garage ist zu, Sir." } }, erwartet: /^Jarvis: Die Garage ist zu, Sir\.$/ },
      { art: "telegram", antwort: { json: { ok: true, reply: "", queued: true } }, erwartet: /^Jarvis: Das braucht länger\. Die Antwort kommt per Telegram\.$/ },
      { art: "fehler", antwort: { status: 500, json: { ok: false, error: "intern" } }, erwartet: /^Das kam nicht an \(HTTP 500\), Sir\.$/ },
    ];
    const tore: (() => void)[] = [];
    let jetzt = 0;
    await page.route("**/api/chat", async (r) => {
      const fall = faelle[jetzt]!;
      await new Promise<void>((ok) => { tore.push(ok); });
      await r.fulfill(fall.antwort).catch(() => undefined);
    });
    const lese = () => page.evaluate(() => ({ dialog: document.querySelector("#dlgFrage .dlg-ansage")?.textContent ?? "", seite: document.getElementById("ansage")?.textContent ?? "" }));
    try {
      await page.evaluate(() => { location.hash = "gespraech"; });
      await page.waitForSelector("#v-gespraech:not([hidden]) #chatIn");
      assert.equal(await page.getAttribute("#notausKnopf", "data-aktion"), "notaus", "Vorbedingung: Notaus bedienbar");
      for (const [i, fall] of faelle.entries()) {
        jetzt = i;
        await page.evaluate(() => { document.getElementById("ansage")!.textContent = ""; });
        await page.fill("#chatIn", "Ist die Garage zu? " + fall.art);
        await page.keyboard.press("Enter");
        await page.waitForSelector("#v-gespraech .msg.laeuft");
        for (let k = 0; k < 100 && !tore.length; k++) await page.waitForTimeout(20);
        // Während das Gespräch wartet: Notaus in der Leiste öffnet die Rückfrage (Modal, der Rest der Seite ist inert)
        await page.click("#notausKnopf");
        await page.waitForSelector("#dlgFrage[open]");
        tore.shift()!();
        await page.waitForFunction(() => (document.querySelector("#dlgFrage .dlg-ansage")?.textContent ?? "") !== "", null, { timeout: 3000 });
        const a = await lese();
        assert.match(a.dialog, fall.erwartet, `${fall.art}: ${JSON.stringify(a)}`);
        assert.equal(a.seite, "", `${fall.art}: nicht ins inerte #ansage`);
        // Im Barrierefreiheitsbaum erreichbar, also für den Screenreader hörbar
        const cdp = await ctx.newCDPSession(page);
        try {
          const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: { ignored: boolean; name?: { value: string } }[] };
          const kern = a.dialog.slice(0, 20);
          assert.ok(nodes.some((n) => !n.ignored && (n.name?.value ?? "").includes(kern)), `${fall.art}: Ansage im Barrierefreiheitsbaum`);
        } finally {
          await cdp.detach();
        }
        // Abbrechen: kein Notaus; die Ansage im Dialog wird beim Schliessen geleert
        await page.keyboard.press("Escape");
        await page.waitForSelector("#dlgFrage", { state: "hidden" });
        await page.waitForFunction(() => document.querySelector("#dlgFrage .dlg-ansage")?.textContent === "", null, { timeout: 1000 });
        assert.equal(await page.textContent("#zustandText"), "Bereit", "nichts angehalten");
      }
      // Ohne Dialog bleibt es bei #ansage
      jetzt = 0;
      await page.fill("#chatIn", "Und jetzt?");
      await page.keyboard.press("Enter");
      for (let k = 0; k < 100 && !tore.length; k++) await page.waitForTimeout(20);
      tore.shift()!();
      await page.waitForFunction(() => document.getElementById("ansage")?.textContent === "Jarvis: Die Garage ist zu, Sir.", null, { timeout: 3000 });
    } finally {
      for (const t of tore) t();
      await page.unroute("**/api/chat");
    }
  });

  it("Weiter mit PIN im Bereich Sicherheit per Tastatur: Fokus danach auf «Notaus», nie auf <body>", async () => {
    await page.evaluate(() => { location.hash = "sicherheit"; });
    await page.waitForSelector('#v-sicherheit:not([hidden]) button[data-merk="s-notaus"]:not([disabled])');
    const fokus = () => page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return !a || a === document.body ? "body" : a.dataset.merk || a.id || a.tagName;
    });
    try {
      // Notaus per Tastatur bestätigen
      await page.focus('#v-sicherheit button[data-merk="s-notaus"]');
      await page.keyboard.press("Enter");
      await page.waitForSelector("#dlgFrage[open]");
      await page.focus("#frageOk");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Pausiert", null, { timeout: 3000 });
      // «Mit PIN fortsetzen» per Tastatur; nach dem Fortsetzen ist der Knopf gesperrt
      await page.waitForSelector('#v-sicherheit button[data-merk="s-weiter"]:not([disabled])');
      await page.focus('#v-sicherheit button[data-merk="s-weiter"]');
      await page.keyboard.press("Enter");
      await page.waitForSelector("#dlgPin[open]");
      await page.keyboard.type(DEMO_PIN);
      await page.keyboard.press("Enter");
      await page.waitForSelector("#dlgPin", { state: "hidden" });
      await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Bereit", null, { timeout: 3000 });
      await page.waitForTimeout(100); // close-Ereignis (spätere Task) und Neuaufbau abwarten
      assert.equal(await page.isDisabled('#v-sicherheit button[data-merk="s-weiter"]'), true, "Vorbedingung: Auslöser gesperrt");
      assert.equal(await fokus(), "s-notaus");
      // Auch der nächste Neuaufbau (Status-Abfrage) behält ihn
      await sofort(page);
      await page.waitForTimeout(200);
      assert.equal(await fokus(), "s-notaus");
    } finally {
      const st = await holeApi("/status.json");
      if (st.daten.pausiert) assert.equal((await holeApi("/api/notaus", { method: "POST", body: { an: false, pin: DEMO_PIN } })).status, 200);
    }
  });

  it("Notfall bei Fokus auf «Weiter» in der Leiste (auch aus dem PIN-Dialog): Fokus bleibt dort, nie auf <body>", async () => {
    await page.evaluate(() => { location.hash = "uebersicht"; });
    await page.waitForSelector("#v-uebersicht:not([hidden]) .kopf");
    const fokus = () => page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return !a || a === document.body ? "body" : a.id || a.dataset.merk || a.tagName;
    });
    const notfallAn = () => page.route("**/status.json", async (route) => {
      const echt = await route.fetch();
      const d = await echt.json();
      await route.fulfill({ response: echt, json: { ...d, notfall: true, pausiert: true, offeneAuftraege: 0, auftraege: [] } });
    });
    const notfallAus = async () => {
      await page.unroute("**/status.json");
      await sofort(page);
      await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Pausiert", null, { timeout: 3000 });
    };
    assert.equal((await holeApi("/api/notaus", { method: "POST", body: { an: true } })).status, 200);
    try {
      await sofort(page);
      await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Pausiert", null, { timeout: 3000 });

      // 1. Fokus auf «Weiter», dann kommt der Notfall (Telegram, anderer Tab)
      await page.focus("#notausKnopf");
      assert.equal(await fokus(), "notausKnopf", "Vorbedingung");
      await notfallAn();
      await sofort(page);
      await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Notfall", null, { timeout: 3000 });
      await page.waitForTimeout(100);
      assert.equal(await fokus(), "notausKnopf", "Fokus bleibt auf dem gesperrten Knopf");
      assert.equal(await page.isDisabled("#notausKnopf"), true, "im Notfall gesperrt");
      assert.equal(await page.getAttribute("#notausKnopf", "aria-disabled"), "true");
      // Enter auf dem gesperrten Knopf öffnet keinen PIN-Dialog
      await page.keyboard.press("Enter");
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => (document.getElementById("dlgPin") as HTMLDialogElement).open), false, "kein PIN-Dialog im Notfall");
      // Tab geht vom Knopf aus weiter, nicht vom Seitenanfang
      await page.keyboard.press("Tab");
      assert.notEqual(await fokus(), "body");
      await notfallAus();
      assert.equal(await page.getAttribute("#notausKnopf", "aria-disabled"), null, "nach dem Notfall wieder frei");
      assert.equal(await page.isDisabled("#notausKnopf"), false);

      // 2. PIN-Dialog aus der Leiste offen, dann kommt der Notfall: der Dialog schliesst und gibt den Fokus an «Weiter» zurück
      await page.focus("#notausKnopf");
      await page.keyboard.press("Enter");
      await page.waitForSelector("#dlgPin[open]");
      await notfallAn();
      await sofort(page);
      await page.waitForSelector("#dlgPin", { state: "hidden" });
      await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Notfall", null, { timeout: 3000 });
      await page.waitForTimeout(100); // close-Ereignis (spätere Task) abwarten
      assert.equal(await fokus(), "notausKnopf", "Fokus nach dem Schliessen auf dem gesperrten Knopf, nie auf <body>");
      await notfallAus();
    } finally {
      await page.unroute("**/status.json").catch(() => undefined);
      const st = await holeApi("/status.json");
      if (st.daten.pausiert) assert.equal((await holeApi("/api/notaus", { method: "POST", body: { an: false, pin: DEMO_PIN } })).status, 200);
      await sofort(page);
      await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Bereit", null, { timeout: 3000 });
    }
  });

  it("Toast bei offenem Dialog auf dem Handy: verdeckt die Dialogknöpfe nicht", async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.route("**/api/zeitplaene", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 500, json: { ok: false, error: "intern" } }) : r.fallback()));
    try {
      await page.evaluate(() => { location.hash = "zeitplaene"; });
      await page.waitForSelector('#v-zeitplaene button[data-aktion="plan-neu"]:not([disabled])');
      await page.click('#v-zeitplaene button[data-aktion="plan-neu"]');
      await page.waitForSelector("#dlgPlan[open]");
      await page.fill("#pName", "Nie gespeichert");
      await page.fill("#pAuftrag", "Kommt nicht an.");
      await page.focus("#planOk");
      await page.keyboard.press("Enter");
      await page.waitForSelector("#toast.an");
      await page.waitForTimeout(300); // Einblenden abwarten
      assert.match((await page.textContent("#toast")) ?? "", /Der Zeitplan kam nicht an \(HTTP 500\), Sir\./);
      // Ohne benannte Hilfsfunktionen im Browser-Code (tsx ergänzt sonst __name)
      const lage = await page.evaluate(() => {
        const t = document.getElementById("toast")!.getBoundingClientRect();
        const ueberdeckt = [...document.querySelectorAll("#dlgPlan .dlg-fuss button")]
          .filter((b) => { const k = b.getBoundingClientRect(); return t.left < k.right && t.right > k.left && t.top < k.bottom && t.bottom > k.top; })
          .map((b) => b.textContent?.trim());
        return { toast: [t.left, t.top, t.right, t.bottom], ueberdeckt, fokus: document.activeElement?.id, imBild: t.top >= 0 && t.bottom <= innerHeight };
      });
      assert.equal(lage.fokus, "planOk");
      assert.deepEqual(lage.ueberdeckt, [], `Toast über den Knöpfen: ${JSON.stringify(lage)}`);
      assert.equal(lage.imBild, true);
      await page.click("#dlgPlan [data-schliessen]");
      await page.waitForSelector("#dlgPlan", { state: "hidden" });
      await page.waitForTimeout(100); // close-Ereignis (spätere Task) abwarten
      // Dialog zu, Toast noch sichtbar: er gehört wieder nach unten und verdeckt weder Notaus noch Zustand noch Thema
      const danach = await page.evaluate(() => {
        const el = document.getElementById("toast")!;
        const t = el.getBoundingClientRect();
        const gedeckt = ["notausKnopf", "zustand", "thema"].filter((id) => {
          const k = document.getElementById(id)!.getBoundingClientRect();
          return k.width > 0 && t.left < k.right && t.right > k.left && t.top < k.bottom && t.bottom > k.top;
        });
        return { an: el.classList.contains("an"), toast: [t.left, t.top, t.right, t.bottom], gedeckt, unten: t.top > innerHeight / 2 };
      });
      assert.equal(danach.an, true, "Vorbedingung: der Toast steht noch");
      assert.deepEqual(danach.gedeckt, [], `Toast über der Leiste: ${JSON.stringify(danach)}`);
      assert.equal(danach.unten, true, `Toast wieder unten: ${JSON.stringify(danach)}`);
    } finally {
      await page.unroute("**/api/zeitplaene");
      await page.setViewportSize({ width: 1280, height: 860 });
    }
  });

  it("hängende Status-Abfrage: nach dem Zeitlimit «Verbindung gestört», danach geht es weiter", async () => {
    const haengend: Route[] = [];
    await page.route("**/status.json", (r) => { haengend.push(r); }); // angenommen, nie beantwortet
    try {
      await page.evaluate(() => { location.hash = "uebersicht"; });
      await sofort(page);
      await page.waitForSelector("#stoerung:not([hidden])", { timeout: 25000 });
      assert.equal(await page.evaluate(() => document.getElementById("main")!.classList.contains("halten")), true, "Inhalt gedimmt");
      assert.ok(haengend.length >= 1);
    } finally {
      await page.unroute("**/status.json");
      for (const r of haengend) await r.abort().catch(() => undefined);
    }
    await sofort(page);
    await page.waitForSelector("#stoerung", { state: "hidden", timeout: 4000 });
  });

  it("PIN-Freigabe: falsche PIN und Zeitlimit werden nach dem Schliessen angesagt; Zeitlimit heisst nicht «nicht erreichbar»", async () => {
    await page.evaluate(() => { location.hash = "uebersicht"; });
    const knopf = '#v-uebersicht button[data-aktion="freigeben"][data-id="202"]';
    await page.waitForSelector(knopf);
    const ansage = () => page.evaluate(() => ({ seite: document.getElementById("ansage")!.textContent ?? "", dialog: document.querySelector("#dlgPin .dlg-ansage")!.textContent ?? "" }));
    // Falsche PIN (nachgestellt: der echte Auftrag bleibt offen): Dialog zu, Ablehnung in #ansage
    await page.route("**/api/auftrag", (r) => r.fulfill({ status: 403, json: { ok: false, error: "pin_falsch", text: "Falsche PIN. #202 abgelehnt." } }).catch(() => undefined));
    try {
      await page.click(knopf);
      await page.waitForSelector("#dlgPin[open]");
      await page.keyboard.type("9999");
      await page.keyboard.press("Enter");
      await page.waitForSelector("#dlgPin", { state: "hidden" });
      await page.waitForTimeout(100); // close-Ereignis (spätere Task) abwarten
      const a = await ansage();
      assert.match(a.seite, /Falsche PIN\. #202 abgelehnt\./, JSON.stringify(a));
      assert.equal(a.dialog, "");
    } finally {
      await page.unroute("**/api/auftrag");
    }
    // Zeitlimit einer Aktion (nachgestellt: 120 s → 200 ms, Anfrage hängt): Auftrag läuft weiter, kein «nicht erreichbar»
    const haengend: Route[] = [];
    await page.route("**/api/auftrag", (r) => { haengend.push(r); });
    await page.evaluate(() => {
      const w = AbortSignal as unknown as { timeout: (ms: number) => AbortSignal; __orig?: (ms: number) => AbortSignal };
      w.__orig = w.timeout.bind(AbortSignal);
      w.timeout = (ms: number) => w.__orig!(ms >= 120000 ? 200 : ms);
    });
    try {
      await page.waitForSelector(knopf);
      await page.click(knopf);
      await page.waitForSelector("#dlgPin[open]");
      await page.keyboard.type(DEMO_PIN);
      await page.keyboard.press("Enter");
      await page.waitForSelector("#dlgPin", { state: "hidden", timeout: 3000 });
      await page.waitForTimeout(100);
      const a = await ansage();
      assert.match(a.seite, /Das dauert länger, Sir\. Der Auftrag läuft weiter/, JSON.stringify(a));
      assert.doesNotMatch(a.seite + ((await page.textContent("#toast")) ?? ""), /Ich erreiche den Dienst nicht/);
      assert.ok(haengend.length >= 1);
    } finally {
      await page.evaluate(() => {
        const w = AbortSignal as unknown as { timeout: (ms: number) => AbortSignal; __orig?: (ms: number) => AbortSignal };
        if (w.__orig) { w.timeout = w.__orig; delete w.__orig; }
      });
      await page.unroute("**/api/auftrag");
      for (const r of haengend) await r.abort().catch(() => undefined);
    }
    assert.equal(await page.locator(knopf).count(), 1, "der echte Auftrag #202 ist unberührt");
  });

  it("Notfall: eine vorher gestartete Finanz-Abfrage füllt die Lage nicht wieder", async () => {
    await page.evaluate(() => { location.hash = "uebersicht"; });
    await page.waitForSelector("#v-uebersicht .auftraege");
    await page.waitForFunction(() => /überfällig/.test(document.getElementById("v-uebersicht")?.textContent ?? ""), null, { timeout: 3000 });
    // Finanz-Antworten (200, vor dem Notfall geholt) zurückhalten, bis die Seite den Notfall kennt
    let loslassen: () => void = () => undefined;
    const tor = new Promise<void>((ok) => { loslassen = ok; });
    let gehalten = 0;
    await page.route("**/api/finanzen", async (r) => {
      const echt = await r.fetch();
      gehalten++;
      await tor;
      await r.fulfill({ response: echt }).catch(() => undefined);
    });
    try {
      await sofort(page);
      for (let i = 0; i < 100 && gehalten < 1; i++) await page.waitForTimeout(20);
      assert.ok(gehalten >= 1, "Vorbedingung: eine Finanz-Abfrage läuft vor dem Notfall");
      await page.route("**/status.json", async (route) => {
        const echt = await route.fetch();
        const d = await echt.json();
        await route.fulfill({ response: echt, json: { ...d, notfall: true, pausiert: true, offeneAuftraege: 2, auftraege: [], zeitplaene: [], wachen: [], kameras: [] } }).catch(() => undefined);
      });
      await sofort(page);
      await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Notfall", null, { timeout: 3000 });
      const antworten = page.waitForResponse("**/api/finanzen");
      loslassen();
      await antworten;
      await page.waitForTimeout(300);
      const text = (await page.textContent("#v-uebersicht")) ?? "";
      assert.match(text, /Inhalte erst nach \/entwarnung/);
      assert.doesNotMatch(text, /überfällig|Rechnung/, "keine Finanzen in der Notfall-Übersicht");
      assert.equal(await page.isVisible("#zahlFinanzen"), false);
      // Auch der nächste Neuaufbau (ohne neue Abfrage) zeigt nichts: der Speicher blieb leer
      await page.evaluate(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
      await page.waitForTimeout(100);
      assert.doesNotMatch((await page.textContent("#v-uebersicht")) ?? "", /überfällig/);
    } finally {
      loslassen();
      await page.unroute("**/status.json");
      await page.unroute("**/api/finanzen");
    }
    await sofort(page);
    await page.waitForFunction(() => document.getElementById("zustandText")?.textContent === "Bereit", null, { timeout: 3000 });
    await page.waitForSelector("#v-uebersicht .auftrag", { timeout: 3000 });
  });

  it("Ersatz-Fokus nach dem Löschen liegt im Bild, nie unter der Sticky-Leiste (Handy)", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal((await holeApi("/api/zeitplaene", { method: "POST", body: { name: "Spätprobe", zeit: "23:50", tage: "taeglich", auftrag: "Nichts." } })).status, 201);
    try {
      await page.evaluate(() => { location.hash = "zeitplaene"; });
      const loeschen = page.locator("#v-zeitplaene .plan", { hasText: "Spätprobe" }).locator('button[data-aktion="plan-weg"]');
      await loeschen.waitFor();
      // Platz unter dem Inhalt: sonst begrenzt die kürzer gewordene Seite den Bildlauf und schiebt den Nachbarn zufällig ins Bild
      await page.evaluate(() => { document.getElementById("main")!.style.paddingBottom = "1200px"; });
      await loeschen.focus();
      // «Löschen» knapp (20 px) unter die Leiste scrollen
      const vorher = await page.evaluate(() => {
        const leiste = document.querySelector("header.top")!.getBoundingClientRect().bottom;
        const b = document.activeElement!.getBoundingClientRect();
        window.scrollBy(0, b.top - (leiste + 20));
        return { leiste, top: document.activeElement!.getBoundingClientRect().top };
      });
      assert.ok(Math.abs(vorher.top - (vorher.leiste + 20)) <= 2, `Vorbedingung: Knopf knapp unter der Leiste ${JSON.stringify(vorher)}`);
      await page.keyboard.press("Enter");
      await page.waitForSelector("#dlgFrage[open]");
      await page.focus("#frageOk");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => ![...document.querySelectorAll("#v-zeitplaene .plan .name")].some((e) => e.textContent === "Spätprobe"), null, { timeout: 4000 });
      await page.waitForTimeout(100);
      const f = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        const r = a!.getBoundingClientRect();
        const leiste = document.querySelector("header.top")!.getBoundingClientRect().bottom;
        return { body: !a || a === document.body, karte: a?.closest(".karte")?.querySelector("h2")?.textContent ?? "", top: r.top, bottom: r.bottom, leiste, hoehe: innerHeight };
      });
      assert.equal(f.body, false);
      assert.equal(f.karte, "Zeitpläne", JSON.stringify(f));
      assert.ok(f.top >= f.leiste && f.bottom <= f.hoehe, `Fokus im Bild und nicht unter der Leiste: ${JSON.stringify(f)}`);
    } finally {
      await page.evaluate(() => { document.getElementById("main")!.style.paddingBottom = ""; });
      await page.setViewportSize({ width: 1280, height: 860 });
    }
  });

  it("Wache ohne gültiges Intervall: «?» statt «undefined Minuten», Hinweis, zählt nicht als aktiv, Dialog ohne «null»", async () => {
    // Von Hand bearbeitete Wachen: der Server liefert dann alle_minuten null und laeuft false (taktAnzeige)
    await page.route("**/api/wachen", async (r) => {
      if (r.request().method() !== "GET") return r.fallback();
      const echt = await r.fetch();
      const d = await echt.json();
      await r.fulfill({ response: echt, json: { ...d, wachen: [
        { id: 77, kamera: "werkstatt", frage: "Ohne Takt?", alle_minuten: null, laeuft: false, nur_wenn: "immer", quelle: "chat", bearbeitbar: true },
        { kamera: "eingang", frage: "Fest aus der Datei?", alle_minuten: null, laeuft: false, nur_wenn: "immer", quelle: "cameras.json", bearbeitbar: false },
      ] } });
    });
    try {
      await page.evaluate(() => { location.hash = "zeitplaene"; });
      await sofort(page);
      const w = page.locator("#v-zeitplaene .wache", { hasText: "Ohne Takt?" });
      await w.waitFor({ timeout: 3000 });
      const text = (await page.textContent("#v-zeitplaene")) ?? "";
      assert.doesNotMatch(text, /undefined|null|NaN/);
      assert.equal(((await w.locator(".zeit").textContent()) ?? "").replace("Minuten", "").trim(), "?");
      assert.match((await w.textContent()) ?? "", /läuft nicht: Intervall fehlt/);
      assert.match((await page.locator("#v-zeitplaene .wache", { hasText: "Fest aus der Datei?" }).textContent()) ?? "", /läuft nicht: Intervall fehlt/);
      await w.locator('button[data-aktion="wache-edit"]').click();
      await page.waitForSelector("#dlgWache[open]");
      assert.equal(await page.inputValue("#wAlle"), "", "kein «null» im Feld");
      await page.keyboard.press("Escape");
      await page.waitForSelector("#dlgWache", { state: "hidden" });
      // Übersicht: Wachen, die nicht laufen, gelten nicht als aktiv
      const geholt = page.waitForResponse("**/api/wachen");
      await page.evaluate(() => { location.hash = "uebersicht"; });
      await sofort(page);
      await geholt;
      await page.waitForSelector("#v-uebersicht .naechst");
      await page.waitForTimeout(100);
      assert.doesNotMatch((await page.textContent("#v-uebersicht .naechst")) ?? "", /Wache(n)? aktiv/);
    } finally {
      await page.unroute("**/api/wachen");
    }
    await sofort(page);
  });

  it("Wache auf fehlender Kamera: Grund vom Server («Kamera fehlt»), eingetragenes Intervall statt «?», zählt nicht als aktiv", async () => {
    // Kamera «garten» steht nicht (mehr) in cameras.json: der Server liefert laeuft false und den Grund (wacheZustand)
    await page.route("**/api/wachen", async (r) => {
      if (r.request().method() !== "GET") return r.fallback();
      const echt = await r.fetch();
      const d = await echt.json();
      await r.fulfill({ response: echt, json: { ...d, wachen: [
        { id: 78, kamera: "garten", frage: "Person im Garten?", alle_minuten: 10, laeuft: false, grund: "Kamera fehlt", nur_wenn: "immer", ruhe_minuten: 30, quelle: "chat", bearbeitbar: true },
        { id: 79, kamera: "garten", frage: "Ganz kaputt?", alle_minuten: null, laeuft: false, grund: "Kamera und Intervall fehlen", nur_wenn: "immer", ruhe_minuten: 30, quelle: "chat", bearbeitbar: true },
      ] } });
    });
    try {
      await page.evaluate(() => { location.hash = "zeitplaene"; });
      await sofort(page);
      const w = page.locator("#v-zeitplaene .wache", { hasText: "Person im Garten?" });
      await w.waitFor({ timeout: 3000 });
      assert.equal(((await w.locator(".zeit").textContent()) ?? "").replace("Minuten", "").trim(), "10", "Intervall statt «?»");
      const det = (await w.locator(".det").textContent()) ?? "";
      assert.match(det, /läuft nicht: Kamera fehlt/);
      assert.doesNotMatch(det, /Intervall fehlt/);
      const kaputt = page.locator("#v-zeitplaene .wache", { hasText: "Ganz kaputt?" });
      assert.equal(((await kaputt.locator(".zeit").textContent()) ?? "").replace("Minuten", "").trim(), "?");
      assert.match((await kaputt.locator(".det").textContent()) ?? "", /läuft nicht: Kamera und Intervall fehlen/);
      assert.doesNotMatch((await page.textContent("#v-zeitplaene")) ?? "", /undefined|null|NaN/);
      // Übersicht: keine der beiden gilt als aktiv
      const geholt = page.waitForResponse("**/api/wachen");
      await page.evaluate(() => { location.hash = "uebersicht"; });
      await sofort(page);
      await geholt;
      await page.waitForSelector("#v-uebersicht .naechst");
      await page.waitForTimeout(100);
      assert.doesNotMatch((await page.textContent("#v-uebersicht .naechst")) ?? "", /Wache(n)? aktiv/);
    } finally {
      await page.unroute("**/api/wachen");
    }
    await sofort(page);
  });

  it("Wache mit ungültiger Bedingung: Grund statt «immer» oder «null», Dialog ohne stillschweigendes «immer»", async () => {
    // Von Hand eingetragenes «nur_wenn» wie «Nacht» oder null: der Server liefert nur_wenn null, laeuft false, grund (wacheZustand)
    await page.route("**/api/wachen", async (r) => {
      if (r.request().method() !== "GET") return r.fallback();
      const echt = await r.fetch();
      const d = await echt.json();
      await r.fulfill({ response: echt, json: { ...d, wachen: [
        { id: 80, kamera: "werkstatt", frage: "Bedingung kaputt?", alle_minuten: 10, laeuft: false, grund: "Bedingung ungültig", nur_wenn: null, ruhe_minuten: 30, quelle: "chat", bearbeitbar: true },
      ] } });
    });
    try {
      await page.evaluate(() => { location.hash = "zeitplaene"; });
      await sofort(page);
      const w = page.locator("#v-zeitplaene .wache", { hasText: "Bedingung kaputt?" });
      await w.waitFor({ timeout: 3000 });
      const det = (await w.locator(".det").textContent()) ?? "";
      assert.match(det, /läuft nicht: Bedingung ungültig/);
      assert.doesNotMatch(det, /immer|null|undefined/);
      await w.locator('button[data-aktion="wache-edit"]').click();
      await page.waitForSelector("#dlgWache[open]");
      assert.equal(await page.inputValue("#wWenn"), "", "keine stillschweigende Auswahl «immer»");
      await page.keyboard.press("Escape");
      await page.waitForSelector("#dlgWache", { state: "hidden" });
    } finally {
      await page.unroute("**/api/wachen");
    }
    await sofort(page);
  });

  it("Zeitplan ohne name/auftrag (ältere Antwort): Bearbeiten-Dialog mit leeren Feldern statt «undefined»", async () => {
    await page.route("**/api/zeitplaene", async (r) => {
      if (r.request().method() !== "GET") return r.fallback();
      const echt = await r.fetch();
      const d = await echt.json();
      await r.fulfill({ response: echt, json: { ...d, zeitplaene: [{ id: 91, zeit: "07:30", tage: "werktags" }] } }).catch(() => undefined);
    });
    try {
      await page.evaluate(() => { location.hash = "zeitplaene"; });
      await sofort(page);
      const knopf = page.locator('#v-zeitplaene button[data-aktion="plan-edit"][data-id="91"]');
      await knopf.waitFor({ timeout: 3000 });
      await knopf.click();
      await page.waitForSelector("#dlgPlan[open]");
      assert.equal(await page.inputValue("#pName"), "");
      assert.equal(await page.inputValue("#pAuftrag"), "");
      await page.keyboard.press("Escape");
      await page.waitForSelector("#dlgPlan", { state: "hidden" });
    } finally {
      await page.unroute("**/api/zeitplaene");
    }
    await sofort(page);
  });

  it("Zeitplan ohne Namen: «Zeitplan #2» in Liste, «Als Nächstes», Knöpfen und Löschfrage statt einer leeren Stelle", async () => {
    // Von Hand bearbeitete data/zeitplaene.json ohne name: der Server liefert name "" (textAnzeige); ältere Antworten gar keinen
    const bald = new Date(Date.now() + 30 * 60000).toISOString();
    await page.route("**/api/zeitplaene", async (r) => {
      if (r.request().method() !== "GET") return r.fallback();
      const echt = await r.fetch();
      const d = await echt.json();
      await r.fulfill({ response: echt, json: { ...d, zeitplaene: [
        { id: 2, name: "", zeit: "08:30", tage: "sa,so", auftrag: "", naechsterLauf: bald },
        { id: 3, zeit: "09:00", tage: "werktags", auftrag: "", laeuft: false, grund: "Auftrag fehlt" },
        { id: 4, name: "   ", zeit: "10:00", tage: "taeglich", auftrag: "Probe." },
        { id: 5, name: "Morgenrunde", zeit: "06:00", tage: "taeglich", auftrag: "Probe." },
      ] } }).catch(() => undefined);
    });
    const label = (aktion: string, id: number) => page.getAttribute(`#v-zeitplaene button[data-aktion="${aktion}"][data-id="${id}"]`, "aria-label");
    try {
      await page.evaluate(() => { location.hash = "zeitplaene"; });
      await sofort(page);
      // Auf die Attrappe warten, nicht auf #2: den gibt es auch in den echten Demo-Daten (sonst Wettlauf mit dem ersten Abruf)
      await page.waitForFunction(() => [...document.querySelectorAll("#v-zeitplaene .plan:not(.wache) .name")].some((e) => e.textContent === "Morgenrunde"), null, { timeout: 3000 });
      const namen = await page.$$eval("#v-zeitplaene .plan:not(.wache) .name", (e) => e.map((x) => x.textContent));
      assert.deepEqual(namen, ["Morgenrunde", "Zeitplan #2", "Zeitplan #3", "Zeitplan #4"]);
      assert.equal(await label("plan-edit", 2), "Zeitplan #2 bearbeiten");
      assert.equal(await label("plan-weg", 2), "Zeitplan #2 löschen");
      assert.equal(await label("plan-edit", 3), "Zeitplan #3 bearbeiten");
      assert.equal(await label("plan-weg", 4), "Zeitplan #4 löschen");
      assert.equal(await label("plan-edit", 5), "Zeitplan Morgenrunde bearbeiten", "benannte Zeitpläne wie bisher");
      assert.doesNotMatch((await page.textContent("#v-zeitplaene")) ?? "", /undefined|null/);
      // Ohne Auftrag nennt die Zeile den Grund des Servers statt «nächster –»; die übrigen bleiben beim nächsten Lauf
      const laeufe = await page.$$eval("#v-zeitplaene .plan:not(.wache) .lauf span:first-child", (e) => e.map((x) => x.textContent));
      assert.deepEqual(laeufe.map((t) => (t ?? "").startsWith("läuft nicht")), [false, false, true, false]);
      assert.equal(laeufe[2], "läuft nicht: Auftrag fehlt");
      // Löschfrage nennt den Zeitplan; Abbrechen löscht nichts
      await page.click('#v-zeitplaene button[data-aktion="plan-weg"][data-id="2"]');
      await page.waitForSelector("#dlgFrage[open]");
      assert.equal(await page.textContent("#frageText"), "«Zeitplan #2» läuft danach nicht mehr. Das lässt sich nicht rückgängig machen.");
      await page.keyboard.press("Escape");
      await page.waitForSelector("#dlgFrage", { state: "hidden" });
      // «Als Nächstes» in der Übersicht: der Name neben der Uhrzeit ist nicht leer
      await page.evaluate(() => { location.hash = "uebersicht"; });
      await sofort(page);
      await page.waitForFunction(() => [...document.querySelectorAll("#v-uebersicht .naechst li .haupt b")].some((b) => b.textContent === "Zeitplan #2"), null, { timeout: 3000 });
      assert.equal(await page.locator("#v-uebersicht .naechst li .haupt b:empty").count(), 0);
    } finally {
      await page.unroute("**/api/zeitplaene");
    }
    await sofort(page);
  });

  it("unlesbare data/auftraege.json: Lage, Übersicht und Freigaben sagen es, statt «Nichts zu tun» oder «Noch keine Freigaben»", async () => {
    const TEXT = "⚠️ data/auftraege.json war beim Start unlesbar, Sir (Sicherung …).";
    // So antwortet der Dienst bei unlesbarer Datei: status.auftraegeUnlesbar, leere Liste; /api/auftraege mit unlesbar und text
    await page.route("**/status.json", async (route) => {
      const echt = await route.fetch();
      const d = await echt.json();
      await route.fulfill({ response: echt, json: { ...d, auftraegeUnlesbar: true, auftraege: [] } });
    });
    await page.route("**/api/auftraege*", (r) => r.fulfill({ json: { ok: true, unlesbar: true, text: TEXT, gesamt: 0, auftraege: [] } }));
    try {
      await page.evaluate(() => { location.hash = "uebersicht"; });
      await sofort(page);
      await page.waitForFunction(() => (document.getElementById("auftrAnker")?.textContent ?? "").includes("data/auftraege.json ist unlesbar."), null, { timeout: 3000 });
      const uebersicht = (await page.textContent("#v-uebersicht")) ?? "";
      assert.doesNotMatch(uebersicht, /Nichts zu tun|nichts wartet/);
      assert.match((await page.textContent("#v-uebersicht .lage-liste")) ?? "", /data\/auftraege\.json unlesbar/);
      assert.match((await page.textContent("#v-uebersicht .kpis")) ?? "", /data\/auftraege\.json unlesbar/);
      assert.equal(await page.getAttribute('#v-uebersicht .lage-liste a[data-merk="lage:datei:auftraegeUnlesbar"]', "href"), "#freigaben");
      await page.evaluate(() => { location.hash = "freigaben"; });
      await page.waitForFunction(() => (document.getElementById("v-freigaben")?.textContent ?? "").includes("data/auftraege.json ist unlesbar."), null, { timeout: 3000 });
      const freigaben = (await page.textContent("#v-freigaben")) ?? "";
      assert.doesNotMatch(freigaben, /Noch keine Freigaben/);
      assert.match(freigaben, /data\/auftraege\.json war beim Start unlesbar, Sir/, "Text des Servers, ohne Symbol");
      assert.doesNotMatch(freigaben, /⚠️/);
    } finally {
      await page.unroute("**/status.json");
      await page.unroute("**/api/auftraege*");
    }
    await page.evaluate(() => { location.hash = "uebersicht"; });
    await sofort(page);
    await page.waitForSelector("#v-uebersicht .auftraege", { timeout: 3000 });
  });

  it("über alle Abläufe: keine Skriptfehler und keine CSP-Verletzung", async () => {
    // Abgewiesene Anfragen (401/423/502 aus den Attrappen) meldet Chromium als Ladefehler; Skriptfehler nie
    assert.deepEqual(probleme.filter((p) => !/Failed to load resource/.test(p)), []);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp), []);
  });
});
