import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Früher: neue Vorgangsnummer = Nummer des letzten Eintrags + 1. Stand ein höherer weiter vorne (Handeingriff) oder trug
// ein verworfener die höchste Nummer, kam eine Nummer doppelt. Jetzt: über allen vorhandenen und allen verworfenen.
const temp = mkdtempSync(join(tmpdir(), "jarvis-vorgaenge-reihenfolge-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-attrappe-nur-fuer-tests";
// Claude antwortet nicht (runTask scheitert im Hintergrund); hier zählt nur die Nummer
globalThis.fetch = (async () => {
  throw new Error("kein Netz im Test");
}) as typeof fetch;

mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(
  join(temp, "data", "vorgaenge.json"),
  JSON.stringify([
    { id: 12, auftrag: "hoch", status: "fertig", startedAt: "2026-10-01T08:00:00.000Z", steps: 1 },
    { id: 4, auftrag: "tief", status: "fertig", startedAt: "2026-10-02T08:00:00.000Z", steps: 1 },
    { id: 20, status: "fertig" },
  ]),
);
const origErr = console.error;
console.error = () => {};
const vorgangMod = await import("../src/vorgaenge.js");
const { hooks } = await import("../src/telegram.js");
console.error = origErr;

describe("Vorgangsnummer unabhängig von der Reihenfolge", () => {
  it("über dem höchsten vorhandenen und dem verworfenen Eintrag", () => {
    assert.deepEqual(vorgangMod.vorgaenge.map((v) => v.id), [12, 4]);
    console.error = () => {};
    try {
      assert.equal(vorgangMod.startVorgang("neu", hooks).id, 21);
      assert.equal(vorgangMod.startVorgang("noch einer", hooks).id, 22);
    } finally {
      console.error = origErr;
    }
  });
});
