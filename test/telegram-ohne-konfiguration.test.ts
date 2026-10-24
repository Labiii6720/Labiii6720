import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Befund: Ohne TELEGRAM_* gingen Meldungen an api.telegram.org/botundefined bzw. sammelten sich im Postausgang.
const temp = mkdtempSync(join(tmpdir(), "jarvis-telegram-ohne-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
process.env.JARVIS_PIN = "4711";

let aufrufe = 0;
globalThis.fetch = (async () => {
  aufrufe++;
  throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }) });
}) as typeof fetch;

const { denyAuftrag, notausAn, notausAus, pinPruefen, postausgangTick, sendText, sendeSpaeter, setzeWarten } = await import("../src/telegram.js");
const { createAuftrag } = await import("../src/queue.js");
const { state } = await import("../src/state.js");
setzeWarten(async () => {}, () => 0.5);

const POSTAUSGANG = join(temp, "data", "postausgang.json");
const ruhe = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

describe("Telegram nicht eingerichtet", () => {
  it("sendeSpaeter: kein Netzaufruf, kein Postausgang", async () => {
    await sendeSpaeter("Guten Morgen, Sir.");
    await sendeSpaeter("Wichtig", { vorrang: true });
    await postausgangTick();
    assert.equal(aufrufe, 0);
    assert.equal(existsSync(POSTAUSGANG), false);
  });

  it("sendText wirft ohne Netzaufruf", async () => {
    await assert.rejects(sendText("Hallo"), /nicht eingerichtet/);
    assert.equal(aufrufe, 0);
  });

  it("Dashboard-Aktionen (Ablehnen, Notaus, falsche PIN) senden nichts und legen nichts ab", async () => {
    const a = createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "x" }, stufe: "extern", summary: "x" });
    a.messageId = 7; // auch Knöpfe entfernen geht nicht hinaus
    assert.equal(await denyAuftrag(a), `❌ #${a.id} abgelehnt.`);
    notausAn("dashboard");
    assert.equal(notausAus("dashboard"), true);
    assert.equal(pinPruefen("0000", "Test"), "falsch");
    await ruhe();
    state.paused = false;
    assert.equal(aufrufe, 0);
    assert.equal(existsSync(POSTAUSGANG), false);
  });
});
