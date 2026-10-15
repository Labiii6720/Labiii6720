import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Von Hand eingetragener Postausgang mit Zeitzone («2026-10-15T10:00:00+02:00»): postausgangEintrag nahm ihn an, gab ihn
// aber unverändert weiter, und imNotfallErlaubt verglich ihn als Text mit state.notfall.seit (UTC-ISO). So ging im
// Notfall ein vor der Auslösung fälliger Vorrang-Eintrag hinaus, und ein danach fälliger blieb hängen.
const temp = mkdtempSync(join(tmpdir(), "jarvis-postausgang-ts-"));
process.chdir(temp);
// Im Temp-Ordner bleiben bis zum Prozessende (spätes Schreiben landet nie im Projekt), dann aufräumen
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";

const gesendet: string[] = [];
globalThis.fetch = (async (eingabe: string | URL | Request, init?: RequestInit) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  assert.ok(url.startsWith("https://api.telegram.org/bot"), `unerwarteter Aufruf: ${url}`);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
  if (body.text !== undefined) gesendet.push(body.text);
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

// Notfall seit 09:00 UTC (11:00 Schweizer Zeit). VOR: 10:00+02:00 = 08:00 UTC, also vor der Auslösung fällig (als Text
// aber «grösser»). NACH: 06:30-04:00 = 10:30 UTC, nach der Auslösung fällig (als Text aber «kleiner»).
const SEIT = "2026-10-15T09:00:00.000Z";
const VOR = { ts: "2026-10-15T10:00:00+02:00", text: "vor der Auslösung fällig", vorrang: true };
const NACH = { ts: "2026-10-15T06:30:00-04:00", text: "Alarm nach der Auslösung", vorrang: true };
const GEWOEHNLICH = { ts: "2026-10-15T11:00:00.000Z", text: "gewöhnlich" };
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "postausgang.json"), JSON.stringify([VOR, NACH, GEWOEHNLICH]));
writeFileSync(join(temp, "data", "state.json"), JSON.stringify({ paused: true, notfall: { aktiv: true, seit: SEIT, grund: "Test" } }));

const { postausgangEintrag } = await import("../src/datei.js");
const telegram = await import("../src/telegram.js");
const { state } = await import("../src/state.js");
telegram.setzeWarten(async () => {}, () => 0.5, async () => {});

describe("Postausgang: Zeitstempel mit Zeitzone", () => {
  it("postausgangEintrag normalisiert ts auf UTC-ISO (toISOString)", () => {
    assert.deepEqual(postausgangEintrag({ ts: "2026-10-15T10:00:00+02:00", text: "x" }), { ts: "2026-10-15T08:00:00.000Z", text: "x" });
    assert.deepEqual(postausgangEintrag({ ts: "2026-10-15T10:00:00+02:00", text: "x", vorrang: true }), { ts: "2026-10-15T08:00:00.000Z", text: "x", vorrang: true });
    assert.equal(postausgangEintrag({ ts: "2026-10-15T08:00:00.000Z", text: "x" })!.ts, "2026-10-15T08:00:00.000Z");
  });

  it("im Notfall geht nur der nach der Auslösung fällige Vorrang-Eintrag hinaus; die übrigen warten", async () => {
    assert.equal(state.notfall?.aktiv, true);
    gesendet.length = 0;
    await telegram.postausgangTick();
    assert.deepEqual(gesendet, ["(nachgereicht, 12:30) Alarm nach der Auslösung"]);
    const rest = JSON.parse(readFileSync(join(temp, "data", "postausgang.json"), "utf8")) as { ts: string; text: string }[];
    assert.deepEqual(rest.map((e) => [e.ts, e.text]), [["2026-10-15T08:00:00.000Z", VOR.text], [GEWOEHNLICH.ts, GEWOEHNLICH.text]]);
  });

  it("nach /entwarnung kommt der Rest in Reihenfolge", async () => {
    state.notfall = { aktiv: false };
    state.paused = false;
    gesendet.length = 0;
    await telegram.postausgangTick();
    assert.deepEqual(gesendet, ["(nachgereicht, 10:00) vor der Auslösung fällig", "(nachgereicht, 13:00) gewöhnlich"]);
  });
});
