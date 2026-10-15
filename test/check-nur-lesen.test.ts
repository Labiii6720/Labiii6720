import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

// npm run check verspricht «nur lesen»: Früher legte schon der Import von cameras.js (Befunde «Wachen» und «Listen»)
// bzw. finanzen.js (Befund «Finanzen») eine Sicherung data/<datei>.defekt an und schrieb ins Log. Jetzt schaltet
// scripts/check.ts vor dem Laden auf nurLesen: keine Sicherung, kein neuer Ordner, keine Datei.
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-check-nur-lesen-"));
process.chdir(temp);
// Im Temp-Ordner bleiben bis zum Prozessende (spätes Schreiben landet nie im Projekt), dann aufräumen
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const { listenBefund } = await import("../src/check.js");

/** Alle Dateien unter dir mit Inhalt und Änderungszeit (Schnappschuss vor und nach dem Lauf). */
function stand(dir: string): Record<string, string> {
  const aus: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const pfad = join(dir, name);
    const st = statSync(pfad);
    aus[name] = st.isDirectory() ? "<ordner>" : `${readFileSync(pfad, "utf8")}|${st.mtimeMs}`;
  }
  return aus;
}

/** scripts/check.ts als Kindprozess wie npm run check, ohne .env und ohne Zugangsdaten in der Umgebung. */
function check(dir: string, nur?: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(projekt, "scripts", "check.ts"), ...(nur ? ["--nur", nur] : [])], {
    cwd: dir, encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("npm run check: nur lesen", () => {
  it("verdorbene Listen, unlesbare rechnungen.json: Befunde stimmen, keine Sicherung, nichts angelegt oder geändert", () => {
    const dir = mkdtempSync(join(temp, "lauf-"));
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "cameras.json"), JSON.stringify({ hof: { frigate: "hof", beschreibung: "Hof", wachen: [{ frage: "geheim?", alle_minuten: 5 }, null] } }));
    writeFileSync(join(dir, "data", "wachen.json"), JSON.stringify([{ id: 1, kamera: "hof", frage: "geheim-wache?", alle_minuten: 10 }, null]));
    writeFileSync(join(dir, "data", "zeitplaene.json"), JSON.stringify([5]));
    writeFileSync(join(dir, "data", "auftraege.json"), JSON.stringify([null]));
    writeFileSync(join(dir, "data", "rechnungen.json"), '[{"id": 1,');
    const vorher = stand(dir);
    const r = check(dir, "Listen,Wachen,Finanzen");
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(stand(dir), vorher, "kein .defekt, kein neuer Ordner, keine geänderte Datei");
    assert.match(r.out, /❌ Finanzen: data\/rechnungen\.json unlesbar/);
    assert.match(r.out, /✅ Wachen: 2 Wache\(n\) aktiv/);
    assert.match(r.out, /❌ Listen: unlesbar: Rechnungen; ungültig: Zeitpläne 1, Wachen 1, Aufträge 1; Sicherung je \.defekt; cameras\.json 1 ungültig \(von Hand reparieren\)\n/);
    assert.doesNotMatch(r.out, /übersprungen \(Sicherung unter/, "kein Sicherungs-Log");
    assert.doesNotMatch(r.out, /geheim/);
  });

  it("voller Lauf mit unlesbarer state.json und profil.json, zweimal: keine Sicherung, kein workspace/, Hinweis ohne Inhalt", () => {
    // Früher sicherten state.ts und profil.ts weiter (profil.json.defekt-<Zeit> bei jedem Lauf), und workspace/ entstand
    const dir = mkdtempSync(join(temp, "voll-"));
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "state.json"), '{"whoop": {"refreshToken": "geheim-token"');
    writeFileSync(join(dir, "data", "profil.json"), '{"ziele": [{"id": 1, "text": "geheimes Ziel"');
    const vorher = stand(dir);
    for (const lauf of [1, 2]) {
      const r = check(dir);
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(stand(dir), vorher, `Lauf ${lauf}: kein .defekt, kein workspace/, keine geänderte Datei`);
      assert.match(r.out, /Zustand unlesbar \(kein gültiges JSON\) – nur gelesen, keine Sicherung angelegt/);
      assert.match(r.out, /Profil unlesbar – nur gelesen, keine Sicherung angelegt/);
      assert.match(r.out, /✅ Protokolle: /);
      assert.doesNotMatch(r.out, /geheim/);
    }
  });

  it("Profil im alten Format: der Selbsttest legt keine Sicherung profil.vor-0.17.json an", () => {
    const dir = mkdtempSync(join(temp, "alt-"));
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "profil.json"), JSON.stringify({ fakten: ["alter Fakt"] }));
    const vorher = stand(dir);
    const r = check(dir, "Protokolle");
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(stand(dir), vorher);
  });

  it("ohne .env und ohne data/: läuft durch und legt nichts an", () => {
    const dir = mkdtempSync(join(temp, "leer-"));
    const r = check(dir, "Listen,Wachen,Finanzen,Sicherheit");
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readdirSync(dir), [], r.out);
    assert.match(r.out, /✅ Listen: 7 Listen in data\/ lesbar, 0 gültige Einträge/);
  });
});

describe("listenBefund: in 140 Zeichen lesbar statt mitten im Wort abgeschnitten", () => {
  const alle = ["Zeitpläne", "Wachen", "Erinnerungen", "Vorgänge", "Postausgang", "Aufträge", "Rechnungen"];

  it("mit Anzahl, wenn es passt; cameras.json ohne Sicherung", () => {
    assert.equal(listenBefund([], [{ name: "Wachen", anzahl: 2 }], 0), "ungültig: Wachen 2; Sicherung je .defekt");
    assert.equal(listenBefund([], [], 3), "cameras.json 3 ungültig (von Hand reparieren)");
    assert.doesNotMatch(listenBefund([], [], 3), /Sicherung/);
  });

  it("alle sieben mit Anzahl passen; mit cameras.json zu lang: nur noch gezählt, nie über 140", () => {
    const sieben = listenBefund([], alle.map((name) => ({ name, anzahl: 2 })), 0);
    assert.equal(sieben, "ungültig: Zeitpläne 2, Wachen 2, Erinnerungen 2, Vorgänge 2, Postausgang 2, Aufträge 2, Rechnungen 2; Sicherung je .defekt");
    assert.ok(sieben.length <= 140);
    assert.equal(listenBefund([], alle.map((name) => ({ name, anzahl: 12 })), 12), "ungültig: 7 Listen; Sicherung je .defekt; cameras.json 12 ungültig (von Hand reparieren)");
    assert.equal(
      listenBefund(alle.slice(0, 3), alle.slice(3).map((name) => ({ name, anzahl: 123 })), 99),
      "unlesbar: 3 Listen; ungültig: 4 Listen; Sicherung je .defekt; cameras.json 99 ungültig (von Hand reparieren)",
    );
    assert.equal(listenBefund(["Wachen"], [{ name: "Aufträge", anzahl: 1 }], 0), "unlesbar: Wachen; ungültig: Aufträge 1; Sicherung je .defekt");
  });
});
