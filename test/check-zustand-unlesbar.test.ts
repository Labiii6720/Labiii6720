import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// npm run check mit unlesbarer state.json: früher kein Befund dazu, und WHOOP/Gmail rieten zu whoop:auth bzw.
// google:auth – die Skripte scheitern dann an pruefeZustandSpeicherbar. Eigene Datei: state.ts lädt nur einmal.
const temp = mkdtempSync(join(tmpdir(), "jarvis-check-zustand-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
mkdirSync(join(temp, "data"));
writeFileSync(join(temp, "data", "state.json"), '{"whoop": {"refreshToken": "attrappe-rt"');
process.env.WHOOP_CLIENT_ID = "attrappe-id";
process.env.WHOOP_CLIENT_SECRET = "attrappe-secret";
process.env.GOOGLE_OAUTH_CLIENT_ID = "attrappe-client";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "attrappe-geheim";

let aufrufe = 0;
globalThis.fetch = (async () => {
  aufrufe++;
  throw new TypeError("fetch failed: kein Netz im Test");
}) as typeof fetch;

// Wie scripts/check.ts: vor dem Laden nur lesen
const { nurLesen } = await import("../src/datei.js");
nurLesen();
const origErr = console.error;
console.error = () => {};
const { selbsttest } = await import("../src/check.js");
console.error = origErr;

describe("npm run check: unlesbare state.json", () => {
  it("Befund Zustand ❌ mit Ursache und Folge, WHOOP und Gmail raten nicht zur Neuanmeldung; nichts angelegt", async () => {
    const b = await selbsttest(["Zustand", "WHOOP", "Gmail"]);
    assert.deepEqual(b.map((x) => [x.name, x.status]), [["Zustand", "fehler"], ["WHOOP", "fehler"], ["Gmail", "fehler"]]);
    assert.equal(b[0].info, "data/state.json unlesbar (kein gültiges JSON, ungesichert, nur gelesen) – Dienst startet im Notfall; reparieren oder entfernen, neu starten");
    assert.ok(b[0].info.length <= 140);
    for (const x of b.slice(1)) {
      assert.doesNotMatch(x.info, /nicht verbunden/);
      assert.match(x.info, /^state\.json unlesbar – erst reparieren, dann npm run (whoop|google):auth$/);
    }
    assert.ok(b.every((x) => !x.info.includes("attrappe")));
    assert.equal(aufrufe, 0);
    assert.deepEqual(readdirSync(join(temp, "data")), ["state.json"], "keine Sicherung im Nur-lesen-Modus");
  });

  it("voller Lauf: Zustand ist der erste Befund", async () => {
    const [erster] = await selbsttest(["Zustand", "Telegram"]);
    assert.equal(erster.name, "Zustand");
  });
});
