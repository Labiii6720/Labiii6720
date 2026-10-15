import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

// README ↔ Verhalten bei ungültigem «melden.nur_wenn» (etwa «Nacht»): Die Meldungen der Kamera bleiben aus, das steht
// aber nur im Log und im Werkzeug kamera_liste. Kommandozentrale (/status.json) und npm run check (Befund «Wachen»)
// zeigen «melden» nicht. Die README darf dort kein «Bedingung ungültig» für Meldungen versprechen.
const projekt = resolve(import.meta.dirname, "..");
const readme = readFileSync(join(projekt, "README.md"), "utf8");
const temp = mkdtempSync(join(tmpdir(), "jarvis-readme-melden-"));
process.chdir(temp);
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });
process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
process.env.TELEGRAM_CHAT_ID = "12345";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.FRIGATE_URL = "http://frigate.attrappe";
process.env.RUECKBLICK = "off";
process.env.RECHNUNG_ERINNERUNG = "off";
process.env.ZIELCHECK = "off";
process.env.VERDICHTUNG = "off";

mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(join(temp, "data", "routinen.json"), "{}");
writeFileSync(
  join(temp, "cameras.json"),
  JSON.stringify({ hof: { frigate: "hof_cam", beschreibung: "Innenhof", melden: { labels: ["person"], nur_wenn: "Nacht" } } }),
);

const echteFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error("unerwarteter Netzaufruf"); }) as typeof fetch;
after(() => { globalThis.fetch = echteFetch; });

const log: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { log.push(a.map(String).join(" ")); };
await import("../src/cameras.js");
console.error = origErr;
const { statusJson } = await import("../src/dashboard.js");
const { selbsttest } = await import("../src/check.js");
const tools = await import("../src/tools.js");

type Req = Parameters<typeof statusJson>[0];
type Res = Parameters<typeof statusJson>[1];

/** Absatz der README, der mit `anfang` beginnt (bis zur nächsten Leerzeile) */
function absatz(anfang: string): string {
  const start = readme.indexOf(anfang);
  assert.ok(start >= 0, `Absatz «${anfang}» in der README gefunden`);
  const ende = readme.indexOf("\n\n", start);
  return readme.slice(start, ende < 0 ? undefined : ende);
}

describe("README: ungültiges «melden.nur_wenn»", () => {
  it("Verhalten: Log und kamera_liste nennen es, Selbsttest und /status.json nicht", async () => {
    assert.match(log.join("\n"), /«melden\.nur_wenn» bei Kamera «hof» ungültig/);
    const liste = tools.toolByName("kamera_liste");
    assert.ok(liste, "Werkzeug kamera_liste aktiv");
    assert.equal(tools.toolByName("kameras"), undefined, "ein Werkzeug «kameras» gibt es nicht");
    const ctx = { sendFile: async () => {}, sendPhoto: async () => {}, sendVideo: async () => {} };
    assert.match(String(await liste.run({}, ctx as never)), /melden \(person, Bedingung ungültig\)/);
    const [b] = await selbsttest(["Wachen"]);
    assert.equal(b?.status, "ok");
    assert.doesNotMatch(b?.info ?? "", /melden|Meldung|Bedingung/, "npm run check zeigt «melden» nicht");
    const st = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(x: unknown) { this.body = x; return this; } };
    statusJson({ params: {}, query: {} } as unknown as Req, st as unknown as Res);
    assert.doesNotMatch(JSON.stringify(st.body), /Bedingung ungültig|nur_wenn|melden/, "Kommandozentrale zeigt «melden» nicht");
  });

  it("Abschnitt 12 verspricht «Bedingung ungültig» für Meldungen nicht in Kommandozentrale oder npm run check", () => {
    const text = absatz("Bedingungen: `immer`");
    // Alte Aussage: «Die Wache schaut nicht hin bzw. die Meldung bleibt aus, …, und Kommandozentrale, `wachen_anzeigen`
    // und `npm run check` zeigen «Bedingung ungültig».» – innerhalb eines Satzes über die Meldung.
    assert.doesNotMatch(text, /Meldung[^.]*(Kommandozentrale|`npm run check`|`wachen_anzeigen`)[^.]*zeig\w*\s+«Bedingung ungültig»/);
    assert.doesNotMatch(text, /Werkzeug `kameras`/, "das Werkzeug heisst kamera_liste");
    // Neue Aussage: wo es für Meldungen tatsächlich steht, und dass Kommandozentrale und Selbsttest es nicht zeigen
    assert.match(text, /`melden\.nur_wenn`[^.]*nur im Log[^.]*`kamera_liste`/);
    assert.match(text, /Kommandozentrale und `npm run check` zeigen `melden` nicht/);
    // Für Wachen gilt die Anzeige weiterhin
    assert.match(text, /Wache mit ungültiger Bedingung schaut nicht hin[^.]*Kommandozentrale[^.]*`wachen_anzeigen`[^.]*`npm run check`/);
  });

  it("Fehlersuche «Keine Meldungen trotz Erkennung» nennt die ungültige Bedingung und den Log-Hinweis", () => {
    const zeile = readme.split("\n").find((z) => z.startsWith("| Keine Meldungen trotz Erkennung |"));
    assert.ok(zeile, "Zeile in der Fehlersuche");
    assert.match(zeile, /`melden\.nur_wenn` nur `immer`, `abwesend` oder `nacht`/);
    assert.match(zeile, /im Log «melden\.nur_wenn … ungültig»/);
  });
});
