import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

// Layout-Zusagen von web/dashboard.css im echten Chromium: echtes HTML und CSS, Skript blockiert, kein Dienst, kein Netz.
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
const web = resolve(import.meta.dirname, "..", "web");
const html = readFileSync(join(web, "dashboard.html"), "utf8");
const css = readFileSync(join(web, "dashboard.css"), "utf8");
const URSPRUNG = "http://jarvis.test";

describe("Kommandozentrale: Layout aus dashboard.css", { skip: chrome ? false : "kein Chromium unter /opt/pw-browsers oder PLAYWRIGHT_CHROMIUM" }, () => {
  let browser: Browser | undefined;

  before(async () => { browser = await chromium.launch({ executablePath: chrome }); });
  after(async () => { await browser?.close(); });

  /** Nur HTML und CSS ausliefern; alles andere (auch app.js) abweisen, damit nichts nach aussen geht */
  async function seite(breite: number, hoehe = 800): Promise<Page> {
    const ctx = await browser!.newContext({ viewport: { width: breite, height: hoehe }, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
    const p = await ctx.newPage();
    p.setDefaultTimeout(3000);
    await p.route("**/*", (r) => {
      const url = new URL(r.request().url());
      if (url.origin !== URSPRUNG) return r.abort();
      if (url.pathname === "/dashboard") return r.fulfill({ contentType: "text/html; charset=utf-8", body: html });
      if (url.pathname === "/dashboard/app.css") return r.fulfill({ contentType: "text/css; charset=utf-8", body: css });
      return r.abort();
    });
    await p.goto(URSPRUNG + "/dashboard");
    await p.evaluate(() => document.body.classList.remove("abgemeldet"));
    return p;
  }

  it("«Verbindung gestört» verdrängt Notaus und Thema-Knopf nie aus dem Bild", async () => {
    const p = await seite(1280);
    try {
      for (const breite of [360, 390, 420, 700, 701, 760, 920, 921, 1120, 1121, 1280]) {
        await p.setViewportSize({ width: breite, height: 800 });
        const m = await p.evaluate(() => {
          document.getElementById("zustandText")!.textContent = "Verbinde …";
          const datum = document.createElement("span"); datum.className = "datum"; datum.textContent = "Mi., 14.10. ";
          const zeit = document.createElement("b"); zeit.textContent = "18:42";
          document.getElementById("uhr")!.replaceChildren(datum, zeit);
          document.getElementById("stoerung")!.hidden = false;
          // ohne benannte Hilfsfunktionen: tsx würde sie mit __name umhüllen, das im Browser fehlt
          const [notaus, thema, stoer] = ["notausKnopf", "thema", "stoerung"].map((id) => document.getElementById(id)!.getBoundingClientRect());
          const st = document.getElementById("stoerung")!;
          return {
            breite: document.documentElement.clientWidth,
            notaus: notaus!, thema: thema!, stoer: stoer!,
            symbolSichtbar: st.querySelector("svg")!.getBoundingClientRect().width >= 14,
            wortSichtbar: st.scrollWidth <= st.clientWidth + 1 && st.getBoundingClientRect().width > 60,
            wortImText: (st.textContent ?? "").includes("Verbindung gestört"),
          };
        });
        assert.ok(m.notaus.right <= m.breite, `${breite} px: Notaus endet bei ${m.notaus.right} > ${m.breite}`);
        assert.ok(m.notaus.width >= 80, `${breite} px: Notaus behält das Wort (${m.notaus.width} px)`);
        assert.ok(m.thema.right <= m.notaus.left && m.thema.width >= 40, `${breite} px: Thema-Knopf ganz sichtbar`);
        assert.ok(m.stoer.right <= m.thema.left, `${breite} px: Störungsanzeige überlappt nicht`);
        assert.ok(m.symbolSichtbar, `${breite} px: Netz-Symbol sichtbar`);
        assert.ok(m.wortImText, "Wort bleibt im Text (Screenreader)");
        if (breite > 700) assert.ok(m.wortSichtbar, `${breite} px: Wort «Verbindung gestört» vollständig sichtbar`);
        else {
          // Handy: nie nur das gelbe Symbol (DESIGN §2/§9) – sichtbares Kurzwort in Textfarbe, ≥ 11 px, ungekürzt
          const k = await p.evaluate(() => {
            const st = document.getElementById("stoerung")!;
            const nach = getComputedStyle(st, "::after");
            const sym = st.querySelector("svg")!.getBoundingClientRect();
            const r = st.getBoundingClientRect();
            const probe = document.createElement("span"); probe.style.color = "var(--t2)"; document.body.append(probe);
            const t2 = getComputedStyle(probe).color; probe.remove();
            return { inhalt: nach.content, groesse: parseFloat(nach.fontSize), farbe: nach.color, t2, platz: r.right - sym.right, ganz: st.scrollWidth <= st.clientWidth + 1 };
          });
          assert.match(k.inhalt, /^"gestört"/, `${breite} px: Kurzwort «gestört» sichtbar (${k.inhalt})`);
          assert.ok(k.groesse >= 11, `${breite} px: Kurzwort mindestens 11 px (${k.groesse})`);
          assert.equal(k.farbe, k.t2, `${breite} px: Kurzwort in Textfarbe --t2, nicht in warn`);
          assert.ok(k.platz >= 35 && k.ganz, `${breite} px: Kurzwort hat Fläche und ist nicht abgeschnitten (${k.platz} px)`);
        }
        // Die echten Zustandswörter werden auch bei Störung nie gekürzt (nur das kurzlebige «Verbinde …» darf notfalls)
        for (const wort of ["Bereit", "Pausiert", "Notfall"]) {
          const z = await p.evaluate((wort) => {
            const t = document.getElementById("zustandText")!;
            t.textContent = wort;
            return { ganz: t.scrollWidth <= t.clientWidth, notaus: document.getElementById("notausKnopf")!.getBoundingClientRect().right, breite: document.documentElement.clientWidth };
          }, wort);
          assert.ok(z.ganz, `${breite} px: «${wort}» vollständig lesbar`);
          assert.ok(z.notaus <= z.breite, `${breite} px, «${wort}»: Notaus im Bild`);
        }
      }
    } finally { await p.context().close(); }
  });

  it("Handy, hell: «Verbindung gestört» ist lesbar und wird genau einmal vorgelesen", async () => {
    const p = await seite(360);
    try {
      await p.evaluate(() => {
        document.documentElement.dataset.theme = "light";
        document.getElementById("zustandText")!.textContent = "Bereit";
        document.getElementById("stoerung")!.hidden = false;
      });
      const m = await p.evaluate(() => {
        const st = document.getElementById("stoerung")!;
        const nach = getComputedStyle(st, "::after");
        const r = st.getBoundingClientRect();
        return { groesse: parseFloat(nach.fontSize), farbe: nach.color, breite: r.width, notaus: document.getElementById("notausKnopf")!.getBoundingClientRect(), fenster: document.documentElement.clientWidth };
      });
      assert.ok(m.groesse >= 11, `Kurzwort ${m.groesse} px`);
      assert.equal(m.farbe, "rgb(79, 77, 72)", "Kurzwort in --t2 (hell), nicht in warn");
      assert.ok(m.breite >= 15 + 35, `Störungsanzeige ${m.breite} px breit (Symbol + Wort)`);
      assert.ok(m.notaus.left >= 0 && m.notaus.right <= m.fenster && m.notaus.width >= 80, "Notaus vollständig im Bild");
      // Kurzwort hat leeren Alternativtext: Screenreader hören nur «Verbindung gestört», nicht zusätzlich «gestört»
      const aria = await p.locator("#stoerung").ariaSnapshot();
      // Keine eigene Live-Region mehr: angesagt wird der Wechsel über #ansage bzw. die Ansage des offenen Dialogs
      assert.match(aria, /Verbindung gestört\s*$/, aria);
      assert.doesNotMatch(aria, /status|gestört.*gestört/s, aria);
    } finally { await p.context().close(); }
  });

  it("Fokus beim Zurück-Tabben bleibt unter der Sticky-Leiste sichtbar (auch mit Notfall-Band)", async () => {
    for (const [breite, notfall] of [[1440, false], [1440, true], [390, false], [390, true], [360, true]] as const) {
      const p = await seite(breite, 700);
      try {
        await p.evaluate((notfall) => {
          document.getElementById("bandNotfall")!.hidden = !notfall;
          const v = document.getElementById("v-uebersicht")!;
          // ohne benannte Hilfsfunktionen (siehe oben): Lücke, Ziel, Lücke, Danach, Lücke
          v.append(...["", "ziel", "", "danach", ""].map((id, i) => {
            const e = document.createElement(id ? "button" : "div");
            if (id) { e.id = id; e.className = "knopf"; e.textContent = id; } else e.style.height = i === 2 ? "300px" : "1500px";
            return e;
          }));
          // Ziel liegt im Fenster, aber unter der Leiste: ohne scroll-padding hält Chromium es für sichtbar und scrollt nicht
          window.scrollTo(0, document.getElementById("ziel")!.getBoundingClientRect().top + window.scrollY - 20);
          document.getElementById("danach")!.focus({ preventScroll: true });
        }, notfall);
        // Wie beim Nutzer: Shift+Tab zurück aufs Ziel
        await p.keyboard.press("Shift+Tab");
        const m = await p.evaluate(() => ({
          fokus: document.activeElement?.id,
          kopf: document.querySelector("header.top")!.getBoundingClientRect().bottom,
          ziel: document.getElementById("ziel")!.getBoundingClientRect().top,
        }));
        assert.equal(m.fokus, "ziel");
        assert.ok(m.ziel >= m.kopf + 4, `${breite} px${notfall ? " mit Notfall-Band" : ""}: Ziel oben bei ${m.ziel}, Leiste endet bei ${m.kopf}`);
      } finally { await p.context().close(); }
    }
  });

  it("Wochentag-Chips im Zeitplan-Dialog sind auch bei 360 px mindestens 40 px breit", async () => {
    for (const breite of [360, 390, 400, 401, 700]) {
      const p = await seite(breite);
      try {
        const breiten = await p.evaluate(() => {
          const box = document.getElementById("pTage")!;
          for (const t of ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]) {
            const l = document.createElement("label"); l.className = "chip";
            const i = document.createElement("input"); i.type = "checkbox";
            const s = document.createElement("span"); s.textContent = t;
            l.append(i, s); box.append(l);
          }
          (document.getElementById("dlgPlan") as HTMLDialogElement).showModal();
          return [...box.querySelectorAll("label.chip")].map((l) => { const r = l.getBoundingClientRect(); return { w: r.width, h: r.height }; });
        });
        assert.equal(breiten.length, 7);
        for (const b of breiten) assert.ok(b.w >= 40 && b.h >= 40, `${breite} px: Chip ${b.w.toFixed(1)}×${b.h} px`);
      } finally { await p.context().close(); }
    }
  });

  it("Ungültige Auswahlfelder (Wache: Kamera, Bedingung) zeigen die rote Fehlerlinie, im Fokus 2 px ohne Bernsteinring", async () => {
    for (const breite of [390, 1440]) {
      for (const thema of ["light", "dark"]) {
        const p = await seite(breite);
        try {
          const m = await p.evaluate((thema) => {
            document.documentElement.dataset.theme = thema;
            (document.getElementById("dlgWache") as HTMLDialogElement).showModal();
            // wie feldFehler in dashboard.js: .ungueltig an der .feldgr, aria-invalid am Feld; #wWenn ohne Auswahl
            for (const id of ["wKamera", "wWenn", "wAlle"]) {
              const f = document.getElementById(id)!;
              f.closest(".feldgr")!.classList.add("ungueltig");
              f.setAttribute("aria-invalid", "true");
            }
            (document.getElementById("wWenn") as HTMLSelectElement).selectedIndex = -1;
            (document.activeElement as HTMLElement | null)?.blur(); // showModal fokussiert #wKamera – Ruhezustand ohne Fokus messen
            const probe = document.createElement("span"); probe.style.color = "var(--krit-text)"; document.body.append(probe);
            const krit = getComputedStyle(probe).color; probe.remove();
            const ruhe = Object.fromEntries(["wKamera", "wWenn", "wAlle"].map((id) => [id, getComputedStyle(document.getElementById(id)!).boxShadow]));
            const fokus: Record<string, { schatten: string; outline: string }> = {};
            for (const id of ["wKamera", "wWenn", "wAlle"]) {
              const f = document.getElementById(id)!;
              f.focus();
              const s = getComputedStyle(f);
              fokus[id] = { schatten: s.boxShadow, outline: s.outlineStyle };
            }
            return { krit, ruhe, fokus };
          }, thema);
          const art = `${breite} px, ${thema}`;
          for (const id of ["wKamera", "wWenn", "wAlle"]) {
            assert.ok(m.ruhe[id]!.startsWith(m.krit) && /inset$/.test(m.ruhe[id]!) && m.ruhe[id]!.includes(" 1.5px "), `${art}: #${id} ungültig mit 1.5-px-Linie in --krit-text (${m.ruhe[id]})`);
            assert.equal(m.fokus[id]!.outline, "none", `${art}: #${id} im Fokus ohne Bernsteinring`);
            assert.ok(m.fokus[id]!.schatten.startsWith(m.krit) && m.fokus[id]!.schatten.includes(" 2px "), `${art}: #${id} im Fokus 2-px-Linie in --krit-text (${m.fokus[id]!.schatten})`);
          }
          // Hover auf dem ungültigen Auswahlfeld behält die Fehlerlinie
          await p.evaluate(() => (document.activeElement as HTMLElement).blur());
          await p.hover("#wWenn");
          const hover = await p.evaluate(() => getComputedStyle(document.getElementById("wWenn")!).boxShadow);
          assert.ok(hover.startsWith(m.krit) && hover.includes(" 1.5px "), `${art}: #wWenn behält beim Hover die Fehlerlinie (${hover})`);
          // Ohne .ungueltig wieder die normale Linie (Gegenprobe)
          const normal = await p.evaluate(() => {
            document.getElementById("wWenn")!.closest(".feldgr")!.classList.remove("ungueltig");
            const w = document.getElementById("wWenn")!; w.focus();
            const s = getComputedStyle(w); return { schatten: s.boxShadow, outline: s.outlineStyle };
          });
          assert.ok(!normal.schatten.startsWith(m.krit), `${art}: gültiges #wWenn ohne rote Linie (${normal.schatten})`);
          assert.equal(normal.outline, "solid", `${art}: gültiges #wWenn im Fokus mit Bernsteinring`);
        } finally { await p.context().close(); }
      }
    }
  });

  it("Toast nutzt die Fensterbreite (nicht nur die rechte Hälfte) und bleibt unten in der Mitte", async () => {
    const lang = "Abgemeldet, Sir. Der Token ist aus diesem Browser gelöscht.";
    for (const breite of [360, 390, 1280]) {
      for (const popover of [false, true]) {
        const p = await seite(breite);
        try {
          const mass = async (text: string) => p.evaluate(({ text, popover }) => {
            const t = document.getElementById("toast")!;
            if (popover && !t.hasAttribute("popover")) {
              // wie dashboard.js: Popover mit zurückgenommenen UA-Regeln
              t.setAttribute("popover", "manual");
              Object.assign(t.style, { top: "auto", right: "auto", margin: "0", border: "0", color: "inherit", overflow: "visible" });
            }
            t.textContent = text;
            if (popover && !t.matches(":popover-open")) t.showPopover();
            t.classList.add("an");
            const r = t.getBoundingClientRect();
            return { w: r.width, h: r.height, links: r.left, rechts: r.right, unten: innerHeight - r.bottom, mitte: r.left + r.width / 2 - innerWidth / 2, fenster: document.documentElement.clientWidth };
          }, { text, popover });
          const kurz = await mass("Gespeichert, Sir.");
          const l = await mass(lang);
          const art = `${breite} px${popover ? " (Popover)" : ""}`;
          assert.ok(kurz.w < 200, `${art}: kurze Meldung bleibt schmal (${kurz.w} px)`);
          for (const m of [kurz, l]) {
            assert.ok(Math.abs(m.mitte) <= 1, `${art}: mittig (${m.mitte})`);
            assert.ok(Math.abs(m.unten - 24) <= 1, `${art}: 24 px über dem Rand (${m.unten})`);
            assert.ok(m.links >= 16 - 0.5 && m.rechts <= m.fenster - 16 + 0.5, `${art}: 16 px Rand (${m.links}–${m.rechts})`);
          }
          if (breite <= 390) {
            // Auf dem Handy die volle nutzbare Breite statt der halben, höchstens zwei Zeilen
            assert.ok(l.w >= l.fenster - 32 - 0.5, `${art}: lange Meldung ${l.w} px breit, erwartet ${l.fenster - 32}`);
            assert.ok(l.h <= kurz.h + 20, `${art}: lange Meldung höchstens zwei Zeilen (${l.h} px, eine Zeile ${kurz.h} px)`);
          } else {
            assert.ok(Math.abs(l.h - kurz.h) <= 0.5, `${art}: lange Meldung auf einer Zeile (${l.h} px)`);
          }
        } finally { await p.context().close(); }
      }
    }
  });
});
