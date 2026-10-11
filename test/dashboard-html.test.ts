import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";

// Führt das Skript aus web/dashboard.html mit einer Attrappen-DOM aus; kein Browser, kein Netz, keine echten Timer.
const html = readFileSync(resolve(import.meta.dirname, "..", "web", "dashboard.html"), "utf8");
const skript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

type Element = { id: string; innerHTML: string; textContent: string; className: string; hidden: boolean; dataset: Record<string, string>; [k: string]: unknown };

function seite() {
  const elemente = new Map<string, Element>();
  const el = (id: string): Element => {
    if (!elemente.has(id)) elemente.set(id, { id, innerHTML: "", textContent: "", className: "", hidden: id === "grid", dataset: {}, focus() {}, appendChild() {} });
    return elemente.get(id)!;
  };
  const abrufe: string[] = [];
  const koerper: unknown[] = [];
  const kontext = vm.createContext({
    document: {
      getElementById: el,
      querySelectorAll: (sel: string) => {
        if (sel !== "#cams img[data-cam]") return [];
        return [...el("cams").innerHTML.matchAll(/<img[^>]*data-cam="([^"]*)"/g)].map((m) => ({ dataset: { cam: m[1] }, src: "" }));
      },
    },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: (url: string, opts?: { body?: string }) => { abrufe.push(url); if (opts?.body) koerper.push(JSON.parse(opts.body)); return new Promise(() => {}); },
    setInterval: () => 0,
    setTimeout: () => 0,
    URL,
    console,
  });
  kontext.window = kontext;
  vm.runInContext(skript, kontext);
  // Klick auf eine Schaltfläche im Raster, wie ihn der Browser an den delegierten Handler meldet.
  const klick = (dataset: Record<string, string>) =>
    (el("grid").onclick as (e: unknown) => void)({ target: { closest: (sel: string) => (sel === "button[data-aktion]" ? { dataset } : null) } });
  return { el, abrufe, koerper, klick, render: (d: unknown) => (kontext as { render: (d: unknown) => void }).render(d) };
}

const basis = {
  zeit: "2026-10-11T08:00:00.000Z", modus: "normal", pausiert: false, notfall: false,
  auftraege: [{ id: 1, tool: "telegram_send", stufe: "extern", summary: "Nachricht senden" }],
  rechnungen: [], vorgaenge: [], zeitplaene: [], wachen: [], protokolle: [], ziele: [], werte: [],
  kameras: [{ name: "einfahrt", beschreibung: "Einfahrt vorne" }],
};
const notfall = { ...basis, notfall: true, offeneAuftraege: 3, auftraege: [], kameras: [] };

describe("Dashboard-Seite: Notfall und Entwarnung", () => {
  it("zeigt im Notfall die echte Anzahl offener Aufträge statt 0", () => {
    const s = seite();
    s.render(notfall);
    assert.equal(String(s.el("qn").textContent), "3");
    assert.match(s.el("queue").innerHTML, /Notfall: 3 offen, Inhalte erst nach \/entwarnung\./);
    assert.doesNotMatch(s.el("queue").innerHTML, /Keine offenen Aufträge/);
    assert.match(s.el("cams").innerHTML, /Im Notfall gesperrt\./);
  });

  it("legt die Kamerabilder nach /entwarnung wieder an", () => {
    const s = seite();
    s.render(basis);
    assert.match(s.el("cams").innerHTML, /data-cam="einfahrt"/);
    assert.equal(s.abrufe.filter((u) => u.includes("/api/kamera/einfahrt")).length, 1);

    s.render(notfall);
    assert.doesNotMatch(s.el("cams").innerHTML, /<img/);

    s.render(basis);
    assert.match(s.el("cams").innerHTML, /data-cam="einfahrt"/);
    assert.equal(s.abrufe.filter((u) => u.includes("/api/kamera/einfahrt")).length, 2);
    assert.equal(String(s.el("qn").textContent), "1");
  });

  it("bleibt im Normalbetrieb ohne Aufträge und Kameras bei den bisherigen Texten", () => {
    const s = seite();
    s.render({ ...basis, auftraege: [], kameras: [] });
    assert.equal(String(s.el("qn").textContent), "0");
    assert.match(s.el("queue").innerHTML, /Keine offenen Aufträge\./);
    assert.match(s.el("cams").innerHTML, /Keine Kameras\./);
  });
});

const boese = `x"'><img src=x onerror=alert(1)>`;
const alleFelder = ["queue", "bills", "protos", "goals", "ops", "cams"];

describe("Dashboard-Seite: fremde Werte (XSS)", () => {
  it("maskiert eine eingeschleuste Ziel-Frist", () => {
    const s = seite();
    s.render({ ...basis, ziele: [{ id: 7, text: "Fit bleiben", frist: "2026-12-31<img src=x onerror=alert(1)>" }] });
    const h = s.el("goals").innerHTML;
    assert.doesNotMatch(h, /<img/);
    assert.match(h, /\(bis 2026-12-31&lt;img src=x onerror=alert\(1\)&gt;\)/);
  });

  it("lässt in keinem Feld Tags oder Inline-Handler durch und maskiert Anführungszeichen", () => {
    const s = seite();
    s.render({
      ...basis,
      auftraege: [{ id: boese, tool: "mail_senden", stufe: boese, summary: boese }],
      rechnungen: [{ id: boese, empfaenger: boese, betrag: 12.5, waehrung: boese, faellig: boese }],
      protokolle: [{ name: boese, stufe: boese, beschreibung: boese }],
      ziele: [{ id: boese, text: boese, frist: boese }],
      vorgaenge: [{ id: boese, status: boese, steps: boese, auftrag: boese }],
      zeitplaene: [{ name: boese, tage: boese, zeit: boese }],
      wachen: [{ kamera: boese, alle_minuten: boese, frage: boese }],
      kameras: [{ name: boese, beschreibung: boese }],
    });
    for (const id of alleFelder) {
      const h = s.el(id).innerHTML;
      assert.ok(h.length > 0, id);
      assert.doesNotMatch(h, /<img src=x/, id);
      const tags = h.match(/<[a-z][^>]*>/gi) ?? [];
      // Attributwerte ausblenden: maskierter Text darin ist harmlos, gefährlich wäre nur ein echter Attributname on…=.
      assert.ok(tags.every((t) => !/\son\w+=/i.test(t.replace(/"[^"]*"/g, '""'))), `${id}: Inline-Handler in ${tags.join(" ")}`);
      assert.doesNotMatch(h, /x"'/, id);
      assert.match(h, /x&quot;&#39;&gt;&lt;img/, id);
    }
  });

  it("bindet Freigeben, Ablehnen und Protokoll über data-Attribute statt onclick an", async () => {
    const s = seite();
    s.render({ ...basis, protokolle: [{ name: "Haus 'zu'", stufe: "extern", beschreibung: "alles zu" }] });
    assert.match(s.el("queue").innerHTML, /data-aktion="freigeben" data-id="1" data-stufe="extern"/);
    assert.match(s.el("protos").innerHTML, /data-aktion="protokoll" data-name="Haus &#39;zu&#39;"/);

    s.klick({ aktion: "freigeben", id: "1", stufe: "extern" });
    s.klick({ aktion: "ablehnen", id: "2" });
    s.klick({ aktion: "protokoll", name: "Haus 'zu'" });
    assert.deepEqual(s.koerper, [{ id: 1, aktion: "ok" }, { id: 2, aktion: "nein" }, { name: "Haus 'zu'" }]);
    assert.equal(s.abrufe.filter((u) => u === "/api/auftrag").length, 2);
    assert.equal(s.abrufe.filter((u) => u === "/api/protokoll").length, 1);
  });

  it("hat eine CSP, die nur genau dieses Skript erlaubt", () => {
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1] ?? "";
    assert.ok(csp, "CSP-Meta fehlt");
    const hash = createHash("sha256").update(skript, "utf8").digest("base64");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.ok(csp.includes(`script-src 'sha256-${hash}'`), "Skript-Hash in der CSP stimmt nicht: nach Änderungen am Skript neu setzen");
    assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
    // Die CSP muss vor dem Skript stehen, sonst gilt sie nicht.
    assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<script>"));
    assert.doesNotMatch(html, /\son(click|error|load|keydown)=/i);
  });
});
