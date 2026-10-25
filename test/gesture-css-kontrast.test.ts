import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

// Kontrast der Gesten-Konsole am Quelltext von web/gesture.css: kleine Schrift (10–11 px) braucht 4,5:1 (WCAG AA).
const css = readFileSync(resolve(import.meta.dirname, "..", "web", "gesture.css"), "utf8");
const root = Object.fromEntries([...(css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "").matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const kanal = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: Rgb) => 0.2126 * kanal(r) + 0.7152 * kanal(g) + 0.0722 * kanal(b);
const kontrast = (a: Rgb, b: Rgb) => { const [h, d] = [lum(a), lum(b)].sort((x, y) => y - x); return (h! + 0.05) / (d! + 0.05); };
/** Halbtransparente Fläche über einem Grund (wie .panel über der Kugel) */
const ueber = (oben: Rgb, alpha: number, grund: Rgb): Rgb => oben.map((c, i) => Math.round(c * alpha + grund[i]! * (1 - alpha))) as Rgb;

/** Farbstopps des Kugel-Verlaufs (.orb), var(--panel) aufgelöst */
function kugelStopps(): Rgb[] {
  const regel = css.match(/\.orb\s*\{[^}]*radial-gradient\(([^;]*)\);/)?.[1] ?? "";
  const stopps = [...regel.matchAll(/(#[0-9a-f]{6}|var\(--([a-z-]+)\))\s+\d+%/gi)].map((m) => (m[2] ? root[m[2]]! : m[1]!));
  assert.ok(stopps.length >= 3, `Verlauf gelesen: ${regel}`);
  return stopps.map(rgb);
}

describe("Gesten-Konsole: Kontrast der Beschriftungen (gesture.css)", () => {
  it("--dim erreicht 4,5:1 auf Panel, Kugel (alle Verlaufsstopps, auch unter dem Panel) und Kamera-Schwarz", () => {
    assert.ok(root.dim && root.panel, "Farben aus :root gelesen");
    const dim = rgb(root.dim!);
    const panelRgba = css.match(/\.panel\s*\{[^}]*background:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    assert.ok(panelRgba, "Panel-Hintergrund gelesen");
    const panelFarbe = [1, 2, 3].map((i) => Number(panelRgba![i])) as Rgb;
    const alpha = Number(panelRgba![4]);
    const gruende: [string, Rgb][] = [
      ["--panel", rgb(root.panel!)],
      ["Kamera #000 (.cam .tag)", [0, 0, 0]],
      ...kugelStopps().map((s, i): [string, Rgb] => [`Kugel Stopp ${i} (.hud .sub)`, s]),
      ...kugelStopps().map((s, i): [string, Rgb] => [`Panel über Kugel Stopp ${i} (.panel label)`, ueber(panelFarbe, alpha, s)]),
    ];
    for (const [name, grund] of gruende) {
      const k = kontrast(dim, grund);
      assert.ok(k >= 4.5, `--dim ${root.dim} auf ${name}: ${k.toFixed(2)}:1 < 4,5:1`);
    }
  });

  it("Zustandsfarben im HUD (live, off, hinweis) erreichen 4,5:1 auf dem hellsten Kugelstopp", () => {
    const hinweis = css.match(/\.hud \.row b\.hinweis\s*\{\s*color:\s*(#[0-9a-f]{6})/i)?.[1];
    assert.ok(hinweis, "Hinweisfarbe gelesen");
    const hellster = kugelStopps().sort((a, b) => lum(b) - lum(a))[0]!;
    for (const [name, farbe] of [["--ok", root.ok], ["--warn", root.warn], ["hinweis", hinweis]] as const) {
      assert.ok(farbe, name);
      const k = kontrast(rgb(farbe), hellster);
      assert.ok(k >= 4.5, `${name} ${farbe}: ${k.toFixed(2)}:1`);
    }
  });
});
