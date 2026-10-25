import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";

// Handmodell der Gesten-Konsole: Download mit fetch-Attrappe (nie das echte Netz), Prüfsumme, atomares Schreiben, Befund im Selbsttest.
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-gesten-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const g = await import("../src/gesten.js");
const echtesFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = echtesFetch; });

const TEST_MODELL = Buffer.from("kleines Test-Modell für die Gesten-Konsole\n".repeat(50));
const ERWARTET = { bytes: TEST_MODELL.length, sha256: createHash("sha256").update(TEST_MODELL).digest("hex") };
const keinWarten = async () => {};

let n = 0;
/** Eigener Arbeitsordner je Fall */
const ordner = () => { const d = join(temp, `fall-${++n}`); mkdirSync(d); return d; };
const inhalt = (d: string) => (existsSync(join(d, "vendor")) ? readdirSync(join(d, "vendor"), { recursive: true }).map(String).sort() : []);

/** fetch-Attrappe: zählt Aufrufe, prüft die URL und antwortet der Reihe nach */
function attrappe(...antworten: (() => Response | Promise<Response>)[]): { aufrufe: string[] } {
  const aufrufe: string[] = [];
  globalThis.fetch = (async (eingabe: string | URL | Request) => {
    aufrufe.push(String(eingabe instanceof Request ? eingabe.url : eingabe));
    const a = antworten[Math.min(aufrufe.length, antworten.length) - 1]!;
    return a();
  }) as typeof fetch;
  return { aufrufe };
}

describe("gesten.ts: Handmodell laden", () => {
  it("richtige Prüfsumme: Datei atomar im Arbeitsordner, kein tmp, Zustand ok; zweiter Lauf lädt nichts", async () => {
    const d = ordner();
    const f = attrappe(() => new Response(TEST_MODELL));
    const text = await g.ladeModell(d, { erwartet: ERWARTET, warten: keinWarten });
    assert.match(text, /geladen und geprüft/);
    assert.deepEqual(f.aufrufe, [g.MODELL_URL]);
    assert.deepEqual(readFileSync(g.modellPfad(d)), TEST_MODELL);
    assert.deepEqual(inhalt(d), ["mediapipe", join("mediapipe", "hand_landmarker.task")]);
    assert.deepEqual(g.modellZustand(d, ERWARTET), { zustand: "ok" });
    assert.match(await g.ladeModell(d, { erwartet: ERWARTET }), /bereits vorhanden/);
    assert.equal(f.aufrufe.length, 1, "kein zweiter Download");
  });

  it("falsche Prüfsumme: verworfen, nichts behalten (auch kein Ordner, kein tmp)", async () => {
    const d = ordner();
    const falsch = Buffer.from(TEST_MODELL);
    falsch[0] = falsch[0]! ^ 1;
    attrappe(() => new Response(falsch));
    await assert.rejects(g.ladeModell(d, { erwartet: ERWARTET, warten: keinWarten }), /verworfen: Prüfsumme .* Nichts gespeichert/);
    assert.deepEqual(inhalt(d), []);
    assert.deepEqual(g.modellZustand(d, ERWARTET), { zustand: "fehlt" });
  });

  it("falsche Grösse und zu grosse Antwort: verworfen; ein vorhandenes falsches Modell bleibt unberührt", async () => {
    const d = ordner();
    mkdirSync(join(d, "vendor", "mediapipe"), { recursive: true });
    writeFileSync(g.modellPfad(d), "alt");
    attrappe(() => new Response(TEST_MODELL.subarray(1)));
    await assert.rejects(g.ladeModell(d, { erwartet: ERWARTET, warten: keinWarten }), new RegExp(`${TEST_MODELL.length - 1} statt ${TEST_MODELL.length} Bytes`));
    attrappe(() => new Response(Buffer.concat([TEST_MODELL, Buffer.from("x")])));
    await assert.rejects(g.ladeModell(d, { erwartet: ERWARTET, warten: keinWarten }), /grösser als/);
    assert.equal(readFileSync(g.modellPfad(d), "utf8"), "alt");
    assert.deepEqual(inhalt(d), ["mediapipe", join("mediapipe", "hand_landmarker.task")], "kein tmp liegen geblieben");
    assert.deepEqual(g.modellZustand(d, ERWARTET), { zustand: "falsch", bytes: 3 });
  });

  it("Netzfehler: drei Versuche mit Backoff (injiziert), dann klare Meldung, nichts gespeichert", async () => {
    const d = ordner();
    const gewartet: number[] = [];
    const f = attrappe(() => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }) }); });
    await assert.rejects(
      g.ladeModell(d, { erwartet: ERWARTET, warten: async (ms) => { gewartet.push(ms); } }),
      (e: Error) => /Handmodell nicht geladen \(Netz: ENOTFOUND\)\. Nichts gespeichert\./.test(e.message),
    );
    assert.equal(f.aufrufe.length, 3);
    assert.equal(gewartet.length, 2);
    assert.deepEqual(inhalt(d), []);
  });

  it("HTTP 503 wird wiederholt, HTTP 404 nicht", async () => {
    const d = ordner();
    const f = attrappe(() => new Response("weg", { status: 503 }), () => new Response(TEST_MODELL));
    await g.ladeModell(d, { erwartet: ERWARTET, warten: keinWarten });
    assert.equal(f.aufrufe.length, 2);
    assert.deepEqual(g.modellZustand(d, ERWARTET), { zustand: "ok" });

    const d2 = ordner();
    const f2 = attrappe(() => new Response("nicht da", { status: 404 }));
    await assert.rejects(g.ladeModell(d2, { erwartet: ERWARTET, warten: keinWarten }), /nicht geladen \(HTTP 404\)/);
    assert.equal(f2.aufrufe.length, 1);
    assert.deepEqual(inhalt(d2), []);
  });

  it("liegengebliebene tmp-Dateien früherer Abbrüche (andere PID) sind nach erfolgreichem Laden weg, Fremdes bleibt", async () => {
    const d = ordner();
    mkdirSync(join(d, "vendor", "mediapipe"), { recursive: true });
    writeFileSync(`${g.modellPfad(d)}.tmp-999999`, "halb");
    writeFileSync(join(d, "vendor", "mediapipe", "notiz.txt"), "bleibt");
    attrappe(() => new Response(TEST_MODELL));
    await g.ladeModell(d, { erwartet: ERWARTET, warten: keinWarten });
    assert.deepEqual(inhalt(d), ["mediapipe", join("mediapipe", "hand_landmarker.task"), join("mediapipe", "notiz.txt")]);
    assert.deepEqual(readFileSync(g.modellPfad(d)), TEST_MODELL);
  });

  it("Ordner nicht beschreibbar (Datei «vendor» im Weg): kein Download, klare Meldung mit Benutzer jarvis, nichts verändert", async () => {
    const d = ordner();
    writeFileSync(join(d, "vendor"), "im Weg");
    const f = attrappe(() => new Response(TEST_MODELL));
    await assert.rejects(g.ladeModell(d, { erwartet: ERWARTET, warten: keinWarten }), (e: Error) => {
      assert.ok(e instanceof g.ModellOrdnerFehler, String(e));
      assert.equal(
        e.message,
        `Handmodell: ${join(d, "vendor", "mediapipe")} nicht beschreibbar (ENOTDIR). Als Benutzer jarvis ausführen: sudo -u jarvis npm run gesten:modell`,
      );
      return true;
    });
    assert.equal(f.aufrufe.length, 0, "erst prüfen, dann 7,8 MB laden");
    assert.equal(readFileSync(join(d, "vendor"), "utf8"), "im Weg");
  });

  it("modellGeprueft: prüft je Dateistand einmal, ein neues Modell (rename) wird neu geprüft, fehlt → fehlt", () => {
    const d = ordner();
    const neu: string[] = [];
    const pruefe = () => g.modellGeprueft(d, ERWARTET, (z) => neu.push(z.zustand)).zustand;
    assert.equal(pruefe(), "fehlt");
    mkdirSync(join(d, "vendor", "mediapipe"), { recursive: true });
    writeFileSync(g.modellPfad(d), "kaputt");
    assert.equal(pruefe(), "falsch");
    assert.equal(pruefe(), "falsch");
    assert.deepEqual(neu, ["falsch"], "einmal je Dateistand");
    writeFileSync(`${g.modellPfad(d)}.neu`, TEST_MODELL);
    renameSync(`${g.modellPfad(d)}.neu`, g.modellPfad(d));
    assert.equal(pruefe(), "ok");
    assert.equal(pruefe(), "ok");
    assert.deepEqual(neu, ["falsch", "ok"]);
    rmSync(g.modellPfad(d));
    assert.equal(pruefe(), "fehlt");
  });

  it("Konstanten: genau das gepinnte Modell", () => {
    assert.equal(g.MODELL_URL, "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task");
    assert.equal(g.MODELL_SHA256, "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1");
    assert.equal(g.MODELL_BYTES, 7819105);
    assert.equal(g.MODELL_PFAD, join("vendor", "mediapipe", "hand_landmarker.task"));
  });
});

describe("scripts/gesten-modell.ts im Kindprozess (fetch-Attrappe)", () => {
  const lauf = (attrappeQuelle: string, vorbereiten?: (d: string) => void) => {
    const d = ordner();
    vorbereiten?.(d);
    const datei = join(d, "attrappe.mjs");
    writeFileSync(datei, attrappeQuelle);
    const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(datei).href, join(projekt, "scripts", "gesten-modell.ts")], {
      cwd: d, encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "", HOME: d },
    });
    return { ...r, d };
  };

  it("HTTP 404: Exit 1, Meldung mit Hinweis, nichts gespeichert", () => {
    const r = lauf('globalThis.fetch = async () => new Response("nicht da", { status: 404 });\n');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Handmodell nicht geladen \(HTTP 404\)\. Nichts gespeichert\. Bitte später nochmals: npm run gesten:modell, Sir\./);
    assert.ok(!existsSync(join(r.d, "vendor")));
  });

  it("Ordner nicht beschreibbar: Exit 1, Hinweis auf Benutzer jarvis, kein «später nochmals», kein Download", () => {
    const r = lauf('globalThis.fetch = async () => { throw new Error("kein Download erwartet"); };\n', (d) => writeFileSync(join(d, "vendor"), "x"));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /nicht beschreibbar \(ENOTDIR\)\. Als Benutzer jarvis ausführen: sudo -u jarvis npm run gesten:modell, Sir\./);
    assert.doesNotMatch(r.stderr, /später nochmals/);
    assert.doesNotMatch(r.stderr, /kein Download erwartet/);
    assert.equal(readFileSync(join(r.d, "vendor"), "utf8"), "x");
  });

  it("falscher Inhalt: Exit 1, verworfen", () => {
    const r = lauf('globalThis.fetch = async () => new Response("kein Modell");\n');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /verworfen: 11 statt 7819105 Bytes/);
    assert.ok(!existsSync(join(r.d, "vendor")));
  });
});

describe("Selbsttest: Befund «Gesten-Modell» (nur lesend)", () => {
  it("fehlt → ➖ mit Hinweis, falsche Datei → ❌, nichts verändert", async () => {
    const { selbsttest } = await import("../src/check.js");
    const [fehlt] = await selbsttest(["Gesten-Modell"]);
    assert.deepEqual(fehlt, { name: "Gesten-Modell", status: "fehlt", info: "Handmodell fehlt: npm run gesten:modell" });
    mkdirSync(join(temp, "vendor", "mediapipe"), { recursive: true });
    writeFileSync(g.modellPfad(), "kaputt");
    const [falsch] = await selbsttest(["Gesten-Modell"]);
    assert.equal(falsch!.status, "fehler");
    assert.match(falsch!.info, /Prüfsumme falsch \(6 Bytes\).*npm run gesten:modell/);
    assert.equal(readFileSync(g.modellPfad(), "utf8"), "kaputt", "nur gelesen");
    rmSync(join(temp, "vendor"), { recursive: true, force: true });
  });

  const echt = join(projekt, g.MODELL_PFAD);
  it("echtes Modell (falls im Projekt geladen) → ✅", { skip: existsSync(echt) ? false : "kein Handmodell im Projekt (npm run gesten:modell)" }, async () => {
    mkdirSync(join(temp, "vendor", "mediapipe"), { recursive: true });
    copyFileSync(echt, g.modellPfad());
    const { selbsttest } = await import("../src/check.js");
    const [ok] = await selbsttest(["Gesten-Modell"]);
    assert.equal(ok!.status, "ok", ok!.info);
    rmSync(join(temp, "vendor"), { recursive: true, force: true });
  });
});
