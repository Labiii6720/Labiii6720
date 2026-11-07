import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

// Audit «auftrag_freigabe» nur, wenn das «ok» aus dem Dashboard den Auftrag tatsächlich abschliesst.
const temp = mkdtempSync(join(tmpdir(), "jarvis-dashboard-audit-freigabe-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.JARVIS_EVENT_TOKEN = "dashboard-token-nur-attrappe-0123456789";
process.env.JARVIS_PIN = "4711";
for (const k of ["RUECKBLICK", "RECHNUNG_ERINNERUNG", "ZIELCHECK", "VERDICHTUNG", "FINANZBERICHT"]) process.env[k] = "off";

mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(
  join(temp, "data", "auftraege.json"),
  JSON.stringify([
    { id: 1, createdAt: "2026-10-01T08:00:00.000Z", tool: "mail_senden", input: {}, stufe: "extern", summary: "schon erledigt", status: "erledigt", result: "ok" },
    { id: 2, createdAt: "2026-10-02T08:00:00.000Z", tool: "mail_senden", input: {}, stufe: "extern", summary: "Ergebnis unklar", status: "offen", gestartetAm: "2026-10-02T08:01:00.000Z" },
  ]),
);

globalThis.fetch = (async (eingabe: string | URL | Request) => {
  const url = String(eingabe instanceof Request ? eingabe.url : eingabe);
  if (url.startsWith("https://api.telegram.org/bot")) {
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
  }
  throw new Error(`unerwarteter Netzaufruf: ${url}`);
}) as typeof fetch;

const dashboard = await import("../src/dashboard.js");
const { state } = await import("../src/state.js");
const { createAuftrag, getAuftrag } = await import("../src/queue.js");

function antwort() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}
async function ok(id: number) {
  const res = antwort();
  await dashboard.auftragAction({ body: { id, aktion: "ok" } } as never, res as never);
  return res;
}
const freigaben = (id: number) => {
  let roh = "";
  try {
    roh = readFileSync(join(temp, "data", "audit.log"), "utf8");
  } catch {
    return [];
  }
  return roh.trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.event === "auftrag_freigabe" && e.id === id);
};
const ruhe = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  state.paused = false;
  state.notfall = { aktiv: false };
});

describe("Audit auftrag_freigabe nur bei abgeschlossener Freigabe", () => {
  it("«ok» auf einen schon erledigten Auftrag: kein Eintrag", async () => {
    const r = await ok(1);
    assert.match(r.body.text, /ist bereits erledigt/);
    assert.deepEqual(freigaben(1), []);
  });

  it("«ok» bei unklarem Ergebnis (gestartetAm): kein Eintrag, Auftrag bleibt offen", async () => {
    const r = await ok(2);
    assert.equal(getAuftrag(2)?.status, "offen");
    assert.equal(r.body.status, "offen");
    assert.deepEqual(freigaben(2), []);
  });

  it("«ok» unter Notaus: kein Eintrag; danach freigegeben genau ein Eintrag, ein zweites «ok» keinen weiteren", async () => {
    const a = createAuftrag({ tool: "erinnerung", input: { zeit: new Date(Date.now() + 3_600_000).toISOString(), text: "x" }, stufe: "extern", summary: "Erinnerung" });
    state.paused = true;
    await ok(a.id);
    assert.equal(getAuftrag(a.id)?.status, "offen");
    assert.deepEqual(freigaben(a.id), []);

    state.paused = false;
    const erst = await ok(a.id);
    await ruhe();
    assert.notEqual(erst.body.status, "offen");
    assert.equal(freigaben(a.id).length, 1);
    assert.equal(freigaben(a.id)[0]!.status, erst.body.status);

    const zweit = await ok(a.id);
    assert.match(zweit.body.text, /ist bereits/);
    assert.equal(freigaben(a.id).length, 1, "kein zweiter Eintrag");
  });
});
