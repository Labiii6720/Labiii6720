import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

// Zustandsfarben und schmales Layout von web/gesture.css im echten Chromium: echtes HTML und CSS, Skript blockiert, kein Dienst, kein Netz.
// Ohne Chromium wird übersprungen.
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
const web = resolve(import.meta.dirname, "..", "web");
const html = readFileSync(join(web, "gesture.html"), "utf8");
const css = readFileSync(join(web, "gesture.css"), "utf8");
const URSPRUNG = "http://jarvis.test";
const HINWEIS = "Handmodell fehlt: npm run gesten:modell";

describe("Gesten-Konsole: HUD-Farben und Layout aus gesture.css", { skip: chrome ? false : "kein Chromium unter /opt/pw-browsers oder PLAYWRIGHT_CHROMIUM" }, () => {
  let browser: Browser | undefined;

  before(async () => { browser = await chromium.launch({ executablePath: chrome }); });
  after(async () => { await browser?.close(); });

  /** Nur HTML und CSS ausliefern; app.js und alles andere abweisen */
  async function seite(breite: number, hoehe: number): Promise<Page> {
    const ctx = await browser!.newContext({ viewport: { width: breite, height: hoehe }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    p.setDefaultTimeout(3000);
    await p.route("**/*", (r) => {
      const url = new URL(r.request().url());
      if (url.origin !== URSPRUNG) return r.abort();
      if (url.pathname === "/gesture") return r.fulfill({ contentType: "text/html; charset=utf-8", body: html });
      if (url.pathname === "/gesture/app.css") return r.fulfill({ contentType: "text/css; charset=utf-8", body: css });
      return r.abort();
    });
    await p.goto(URSPRUNG + "/gesture");
    return p;
  }

  it("Zustandsklassen färben #st und #jv (hinweis, live, off), ohne Klasse weiss", async () => {
    const p = await seite(1280, 800);
    try {
      // ohne benannte Hilfsfunktionen: tsx würde sie mit __name umhüllen, das im Browser fehlt
      const farben = await p.evaluate(() => {
        const probe = document.createElement("span"); document.body.append(probe);
        const [ok, warn] = ["--ok", "--warn"].map((v) => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; });
        probe.remove();
        const [stHinweis, stLive, stOff, stOhne, jvOff, jvLive, jvOhne] = ([["st", "hinweis"], ["st", "live"], ["st", "off"], ["st", ""], ["jv", "off"], ["jv", "live"], ["jv", ""]] as const)
          .map(([id, klasse]) => { const e = document.getElementById(id)!; e.className = klasse; return getComputedStyle(e).color; });
        return { ok, warn, stHinweis, stLive, stOff, stOhne, jvOff, jvLive, jvOhne, hands: getComputedStyle(document.getElementById("hands")!).color };
      });
      assert.equal(farben.stHinweis, "rgb(255, 212, 184)", "#st.hinweis");
      assert.equal(farben.stLive, farben.ok, "#st.live in --ok");
      assert.equal(farben.stOff, farben.warn, "#st.off in --warn");
      assert.equal(farben.jvOff, farben.warn, "#jv.off in --warn");
      assert.equal(farben.jvLive, farben.ok, "#jv.live in --ok");
      assert.notEqual(farben.warn, "rgb(255, 255, 255)");
      for (const w of [farben.stOhne, farben.jvOhne, farben.hands]) assert.equal(w, "rgb(255, 255, 255)", "ohne Zustand weiss");
    } finally { await p.context().close(); }
  });

  it("schmal (360×740 u. a.): Panel verdeckt weder Modell-Hinweis noch HUD-Zeilen, kein waagrechtes Scrollen", async () => {
    for (const [breite, hoehe] of [[360, 740], [390, 844], [740, 360], [900, 700]] as const) {
      const p = await seite(breite, hoehe);
      try {
        const m = await p.evaluate((hinweis) => {
          const st = document.getElementById("st")!;
          st.textContent = hinweis; st.className = "hinweis";
          const [panel, ...hud] = [document.querySelector(".panel")!, document.querySelector(".hud h1")!, document.querySelector(".hud .sub")!, st, ...document.querySelectorAll(".hud .row")]
            .map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });
          return {
            panel: panel!, hud,
            scroll: document.documentElement.scrollWidth, fenster: document.documentElement.clientWidth,
          };
        }, HINWEIS);
        const art = `${breite}×${hoehe}`;
        assert.ok(m.scroll <= m.fenster, `${art}: kein waagrechtes Scrollen (${m.scroll} > ${m.fenster})`);
        for (const [i, r] of m.hud.entries()) {
          const ueberlappt = r.bottom > m.panel.top && r.top < m.panel.bottom && r.right > m.panel.left && r.left < m.panel.right;
          assert.ok(!ueberlappt, `${art}: HUD-Element ${i} (${r.top}–${r.bottom}) liegt unter dem Panel (${m.panel.top}–${m.panel.bottom})`);
          assert.ok(r.left >= 0 && r.right <= m.fenster, `${art}: HUD-Element ${i} im Bild`);
        }
        assert.ok(m.panel.left >= 0 && m.panel.right <= m.fenster, `${art}: Panel im Bild`);
      } finally { await p.context().close(); }
    }
  });

  it("breit (1280×800): Kamera und Kugel nebeneinander, Panel unten rechts, HUD oben links frei", async () => {
    const p = await seite(1280, 800);
    try {
      const m = await p.evaluate(() => {
        const [cam, orb, panel, hud] = [".cam", ".orb", ".panel", ".hud"].map((s) => document.querySelector(s)!.getBoundingClientRect().toJSON() as DOMRect);
        return { cam: cam!, orb: orb!, panel: panel!, hud: hud!, hoehe: document.documentElement.scrollHeight };
      });
      assert.equal(m.cam.top, m.orb.top, "nebeneinander");
      assert.ok(m.cam.right <= m.orb.left + 1);
      assert.ok(m.hoehe <= 800, "kein Scrollen auf dem Desktop");
      assert.ok(Math.abs(m.panel.right - (m.orb.right - 16)) <= 1 && Math.abs(m.panel.bottom - (m.orb.bottom - 16)) <= 1, "Panel unten rechts");
      assert.ok(m.hud.bottom < m.panel.top, "HUD über dem Panel frei");
    } finally { await p.context().close(); }
  });
});
