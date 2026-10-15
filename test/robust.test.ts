import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";

const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-robust-"));
process.chdir(temp);
process.env.WATCHDOG_MINUTEN = "10";
// Im Temp-Ordner bleiben, nie zurück ins Projekt: was nach den Root-after-Hooks noch schreibt (Wiederholungen mit
// echten Timern, nicht abgewartete Meldungen), landet so nie in data/ des Projekts. Aufgeräumt wird beim Prozessende.
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const { config } = await import("../src/config.js");
const r = await import("../src/robust.js");
const { HttpFehler, fehlerArt, voruebergehend, wartezeit, mitWiederholung, retryAfterAusHeader, nutzerText, schwaerze, gesundheit, fehlerDetail } = r;

const mitCode = (code: string, msg = code) => Object.assign(new Error(msg), { code });
const fetchFailed = (code?: string) => { const e = new TypeError("fetch failed"); if (code) (e as { cause?: unknown }).cause = mitCode(code); return e; };
const sdkHeaders = (h: Record<string, string> = {}) => new Headers(h);
const rateLimit = (retryAfter?: string) =>
  new Anthropic.RateLimitError(429, { error: { type: "rate_limit_error", message: "zu viele Anfragen" } }, undefined, sdkHeaders(retryAfter ? { "retry-after": retryAfter } : {}));

/** console.log/error abfangen */
function fangeLogs(): { logs: string[]; fehler: string[]; ende: () => void } {
  const logs: string[] = []; const fehler: string[] = [];
  const log = console.log; const err = console.error;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
  return { logs, fehler, ende: () => { console.log = log; console.error = err; } };
}

const MIN = 60_000;

describe("fehlerArt", () => {
  it("Netzfehler: fetch failed, Codes direkt und in cause", () => {
    assert.equal(fehlerArt(fetchFailed()), "netz");
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"]) {
      assert.equal(fehlerArt(mitCode(code)), "netz", code);
      assert.equal(fehlerArt(fetchFailed(code)), "netz", `cause ${code}`);
    }
    const tief = new Error("aussen"); (tief as { cause?: unknown }).cause = { cause: mitCode("ECONNREFUSED") };
    assert.equal(fehlerArt(tief), "netz");
    assert.equal(fehlerArt(new Anthropic.APIConnectionError({ cause: mitCode("ECONNRESET") })), "netz");
  });

  it("Zeitlimit: AbortError, TimeoutError, withTimeout-Text, SDK-Timeout", () => {
    assert.equal(fehlerArt(Object.assign(new Error("abgebrochen"), { name: "AbortError" })), "zeitlimit");
    assert.equal(fehlerArt(Object.assign(new Error("zu lange"), { name: "TimeoutError" })), "zeitlimit");
    assert.equal(fehlerArt(new Error("Timeout nach 10000 ms")), "zeitlimit");
    assert.equal(fehlerArt(new Anthropic.APIConnectionTimeoutError({})), "zeitlimit");
    assert.equal(fehlerArt(fetchFailed("UND_ERR_CONNECT_TIMEOUT")), "zeitlimit");
  });

  it("HTTP-Status: rate, server, auth, client", () => {
    assert.equal(fehlerArt(new HttpFehler("Too Many Requests", 429)), "rate");
    assert.equal(fehlerArt(new HttpFehler("Bad Gateway", 502)), "server");
    assert.equal(fehlerArt(new HttpFehler("Timeout", 408)), "server");
    assert.equal(fehlerArt(new HttpFehler("Too Early", 425)), "server");
    assert.equal(fehlerArt(new HttpFehler("Unauthorized", 401)), "auth");
    assert.equal(fehlerArt(new HttpFehler("Forbidden", 403)), "auth");
    assert.equal(fehlerArt(new HttpFehler("chat not found", 400)), "client");
    assert.equal(fehlerArt(new HttpFehler("Not Found", 404)), "client");
    assert.equal(fehlerArt({ status: 503 }), "server");
    assert.equal(fehlerArt({ statusCode: 429 }), "rate");
  });

  it("Anthropic-Fehlerklassen", () => {
    assert.equal(fehlerArt(rateLimit()), "rate");
    assert.equal(fehlerArt(new Anthropic.InternalServerError(500, { error: { type: "api_error", message: "x" } }, undefined, sdkHeaders())), "server");
    assert.equal(fehlerArt(new Anthropic.AuthenticationError(401, { error: { type: "authentication_error", message: "x" } }, undefined, sdkHeaders())), "auth");
    assert.equal(fehlerArt(new Anthropic.PermissionDeniedError(403, { error: { type: "permission_error", message: "x" } }, undefined, sdkHeaders())), "auth");
    assert.equal(fehlerArt(new Anthropic.BadRequestError(400, { error: { type: "invalid_request_error", message: "x" } }, undefined, sdkHeaders())), "client");
    assert.equal(fehlerArt(new Anthropic.NotFoundError(404, { error: { type: "not_found_error", message: "x" } }, undefined, sdkHeaders())), "client");
    assert.equal(fehlerArt(new Anthropic.APIUserAbortError()), "unbekannt");
  });

  it("unbekannt und voruebergehend", () => {
    assert.equal(fehlerArt(new Error("irgendwas")), "unbekannt");
    assert.equal(fehlerArt("text"), "unbekannt");
    assert.equal(fehlerArt(null), "unbekannt");
    assert.ok(voruebergehend(fetchFailed()));
    assert.ok(voruebergehend(new HttpFehler("x", 503)));
    assert.ok(voruebergehend(rateLimit()));
    assert.ok(voruebergehend(new Error("Timeout nach 5 ms")));
    assert.ok(!voruebergehend(new HttpFehler("x", 400)));
    assert.ok(!voruebergehend(new HttpFehler("x", 401)));
    assert.ok(!voruebergehend(new Error("irgendwas")));
  });
});

describe("fehlerDetail", () => {
  it("HTTP-Status erscheint genau einmal", () => {
    // HttpFehler aus homeassistant.ts/telegram.ts tragen den Status schon im Text → unverändert
    assert.equal(fehlerDetail(new HttpFehler("Home Assistant HTTP 502 (states)", 502)), "Home Assistant HTTP 502 (states)");
    assert.equal(fehlerDetail(new HttpFehler("HTTP 429 (sendMessage)", 429)), "HTTP 429 (sendMessage)");
    assert.equal(fehlerDetail(new HttpFehler("Outlook-Kalender HTTP 504", 504)), "Outlook-Kalender HTTP 504");
    // SDK-Stil «429 {…}»
    assert.equal(fehlerDetail(rateLimit()), "HTTP 429 {\"error\":{\"type\":\"rate_limit_error\",\"message\":\"zu viele Anfragen\"}}");
    // Status ohne Text und Text ohne Status
    assert.equal(fehlerDetail(new HttpFehler("", 503)), "HTTP 503");
    assert.equal(fehlerDetail(new HttpFehler("Bad Gateway", 502)), "HTTP 502 Bad Gateway");
    assert.equal(fehlerDetail(fetchFailed("ECONNREFUSED")), "Netz: ECONNREFUSED");
  });
});

describe("wartezeit", () => {
  const o = { basisMs: 500, maxMs: 8000, faktor: 2, jitter: 0.2 };
  it("exponentiell mit Deckel, ohne Jitter bei zufall=0.5", () => {
    const mitte = () => 0.5;
    assert.equal(wartezeit(1, o, mitte), 500);
    assert.equal(wartezeit(2, o, mitte), 1000);
    assert.equal(wartezeit(3, o, mitte), 2000);
    assert.equal(wartezeit(5, o, mitte), 8000);
    assert.equal(wartezeit(9, o, mitte), 8000);
  });
  it("Jitter-Bereich ± Anteil", () => {
    assert.equal(wartezeit(2, o, () => 0), 800);
    assert.equal(wartezeit(2, o, () => 1), 1200);
    for (let i = 0; i < 50; i++) {
      const w = wartezeit(2, o, Math.random);
      assert.ok(w >= 800 && w <= 1200, String(w));
    }
    assert.equal(wartezeit(2, { ...o, jitter: 0 }, () => 1), 1000);
  });
  it("Retry-After hat Vorrang, gedeckelt auf 60 s", () => {
    assert.equal(wartezeit(1, o, () => 1, 7000), 7000);
    assert.equal(wartezeit(1, o, () => 1, 120_000), 60_000);
    assert.equal(wartezeit(1, o, () => 0.5, 0), 500);
    assert.equal(wartezeit(1, o, () => 0.5, undefined), 500);
  });
});

describe("retryAfterAusHeader", () => {
  it("Sekunden und HTTP-Datum", () => {
    assert.equal(retryAfterAusHeader(new Headers({ "retry-after": "7" })), 7000);
    assert.equal(retryAfterAusHeader(new Headers({ "Retry-After": "1.5" })), 1500);
    const ms = retryAfterAusHeader(new Headers({ "retry-after": new Date(Date.now() + 30_000).toUTCString() }));
    assert.ok(ms !== undefined && ms > 25_000 && ms <= 30_000, String(ms));
    assert.equal(retryAfterAusHeader(new Headers({ "retry-after": "bald" })), undefined);
    assert.equal(retryAfterAusHeader(new Headers()), undefined);
    assert.equal(retryAfterAusHeader(null), undefined);
    assert.equal(retryAfterAusHeader(undefined), undefined);
  });
});

describe("mitWiederholung", () => {
  const gewartet: number[] = [];
  const warten = async (ms: number) => { gewartet.push(ms); };
  const zufall = () => 0.5;
  beforeEach(() => { gewartet.length = 0; gesundheit._reset(); });

  it("Erfolg nach zwei voruebergehenden Fehlern, warten mit erwarteten Werten", async () => {
    let n = 0;
    const versuche: number[] = [];
    const ergebnis = await mitWiederholung("test", async (v) => {
      versuche.push(v);
      n++;
      if (n === 1) throw fetchFailed("ECONNREFUSED");
      if (n === 2) throw new HttpFehler("Bad Gateway", 502);
      return "ok";
    }, { warten, zufall, basisMs: 1000, maxMs: 15000 });
    assert.equal(ergebnis, "ok");
    assert.deepEqual(versuche, [1, 2, 3]);
    assert.deepEqual(gewartet, [1000, 2000]);
  });

  it("kein Retry bei client/auth", async () => {
    let n = 0;
    await assert.rejects(mitWiederholung("test", async () => { n++; throw new HttpFehler("chat not found", 400); }, { warten, zufall }), /chat not found/);
    assert.equal(n, 1);
    n = 0;
    await assert.rejects(mitWiederholung("test", async () => { n++; throw new HttpFehler("Unauthorized", 401); }, { warten, zufall }), /Unauthorized/);
    assert.equal(n, 1);
    assert.deepEqual(gewartet, []);
  });

  it("Anzahl Versuche eingehalten, letzter Fehler wird geworfen", async () => {
    let n = 0;
    await assert.rejects(mitWiederholung("test", async () => { n++; throw mitCode("ECONNRESET", `Fehler ${n}`); }, { versuche: 4, warten, zufall, basisMs: 100, maxMs: 250 }), /Fehler 4/);
    assert.equal(n, 4);
    assert.deepEqual(gewartet, [100, 200, 250]);
  });

  it("Retry-After aus HttpFehler und aus SDK-Headers hat Vorrang", async () => {
    let n = 0;
    await mitWiederholung("test", async () => { n++; if (n === 1) throw new HttpFehler("Too Many Requests", 429, 7000); return 1; }, { warten, zufall });
    assert.deepEqual(gewartet, [7000]);
    gewartet.length = 0;
    n = 0;
    await mitWiederholung("test", async () => { n++; if (n === 1) throw rateLimit("3"); return 1; }, { warten, zufall });
    assert.deepEqual(gewartet, [3000]);
  });

  it("bewusster Abbruch (Notaus) zählt nicht als Störung", async () => {
    const f = fangeLogs();
    try {
      let n = 0;
      const abbruch = new Anthropic.APIUserAbortError({ message: "Pausiert (Notaus), Anfrage abgebrochen." });
      await assert.rejects(mitWiederholung("claude.chat", async () => {
        n++;
        if (n === 1) throw new Anthropic.InternalServerError(529, { error: { type: "overloaded_error", message: "Overloaded" } }, undefined, sdkHeaders());
        throw abbruch;
      }, { warten, zufall, komponente: "claude" }), (e: unknown) => e === abbruch);
      assert.equal(n, 2);
      const z = gesundheit.zustand("claude");
      assert.equal(z?.ok, false);
      assert.equal(z?.fehler, 1);
      assert.match(z?.letzterFehler ?? "", /HTTP 529/);
      assert.doesNotMatch(z?.letzterFehler ?? "", /Pausiert/);
      assert.doesNotMatch(gesundheit.bericht(), /Pausiert/);
      // Abbruch ohne vorherigen Fehler: Komponente bleibt unberührt
      gesundheit._reset();
      await assert.rejects(mitWiederholung("claude.chat", async () => { throw abbruch; }, { warten, zufall, komponente: "claude" }));
      assert.equal(gesundheit.zustand("claude"), undefined);
    } finally { f.ende(); }
  });

  it("Standard-warten hält die Event-Loop: Skript ohne Server erreicht den zweiten Versuch", () => {
    // Kindprozess: ohne offenen Server wäre der Backoff-Timer das einzige Handle; mit unref bräche Node mit Exit 13 ab.
    const modul = JSON.stringify(join(projekt, "src", "robust.ts"));
    const tsx = pathToFileURL(join(projekt, "node_modules", "tsx", "dist", "loader.mjs")).href;
    const skript = `
      const { mitWiederholung } = await import(${modul});
      let n = 0;
      const ergebnis = await mitWiederholung("skript", async () => {
        n++;
        if (n === 1) throw Object.assign(new Error("EAI_AGAIN"), { code: "EAI_AGAIN" });
        return "ok" + n;
      }, { basisMs: 20, maxMs: 50, jitter: 0 });
      console.log("ERGEBNIS " + ergebnis);
    `;
    const kind = spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", skript], {
      cwd: temp, encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_OPTIONS: "" },
    });
    assert.equal(kind.status, 0, `exit ${kind.status}\n${kind.stderr}`);
    assert.match(kind.stdout, /ERGEBNIS ok2/);
  });

  it("eigene wiederholen-Regel und Gesundheit", async () => {
    const f = fangeLogs();
    try {
      let n = 0;
      await assert.rejects(mitWiederholung("ha.get", async () => { n++; throw new HttpFehler("Bad Gateway", 502); }, { warten, zufall, wiederholen: () => false, komponente: "homeassistant" }));
      assert.equal(n, 1);
      assert.equal(gesundheit.zustand("homeassistant")?.ok, false);
      assert.match(gesundheit.zustand("homeassistant")?.letzterFehler ?? "", /HTTP 502/);
      await mitWiederholung("ha.get", async () => 1, { komponente: "homeassistant" });
      assert.equal(gesundheit.zustand("homeassistant")?.ok, true);
      // client-Fehler sind keine Störung des Dienstes
      await assert.rejects(mitWiederholung("telegram.sendMessage", async () => { throw new HttpFehler("chat not found", 400); }, { warten, komponente: "telegram" }));
      assert.equal(gesundheit.zustand("telegram"), undefined);
    } finally { f.ende(); }
  });
});

describe("schwaerze", () => {
  it("Telegram-Token, API-Schlüssel, Bearer, Parameter", () => {
    assert.equal(schwaerze("fetch https://api.telegram.org/bot123456789:AAHfz-abcDEF_ghij1234567890/sendMessage failed"), "fetch https://api.telegram.org/bot<token>/sendMessage failed");
    assert.equal(schwaerze("key sk-ant-api03-abcdefghijklmnop"), "key sk-ant-<schlüssel>");
    assert.equal(schwaerze("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer <token>");
    assert.equal(schwaerze("http://x/?a=1&token=geheim123&b=2"), "http://x/?a=1&token=<geheim>&b=2");
    assert.equal(schwaerze("HTTP 502 Bad Gateway"), "HTTP 502 Bad Gateway");
  });
});

describe("nutzerText", () => {
  it("Textbausteine je Fehlerart, Jarvis-Ton", () => {
    assert.equal(nutzerText(rateLimit(), "Claude-API"), "Die Verbindung zur Claude-API hakt gerade (Rate-Limit). Ich habe es dreimal versucht – bitte in einer Minute nochmals, Sir.");
    assert.equal(nutzerText(new HttpFehler("x", 429), "claude", 4), "Die Verbindung zur Claude-API hakt gerade (Rate-Limit). Ich habe es 4-mal versucht – bitte in einer Minute nochmals, Sir.");
    assert.match(nutzerText(fetchFailed("ENOTFOUND"), "claude"), /^Die Verbindung zur Claude-API ist gerade unterbrochen \(Netzfehler\)\./);
    assert.match(nutzerText(new Error("Timeout nach 10 ms"), "homeassistant"), /^Die Verbindung zu Home Assistant hakt gerade \(Zeitlimit\)\./);
    assert.match(nutzerText(new HttpFehler("Bad Gateway", 502), "homeassistant"), /Serverfehler HTTP 502/);
    assert.equal(nutzerText(new Anthropic.AuthenticationError(401, { error: { type: "authentication_error", message: "invalid x-api-key" } }, undefined, sdkHeaders()), "claude"), "Die Claude-API lehnt den Zugang ab (HTTP 401). Bitte ANTHROPIC_API_KEY prüfen, Sir.");
    assert.match(nutzerText(new HttpFehler("Bad Request: chat not found", 400), "telegram"), /^Telegram hat die Anfrage abgewiesen \(HTTP 400 Bad Request: chat not found\)\. Wiederholen hilft hier nicht, Sir\.$/);
    assert.match(nutzerText(new Error("Kaputt"), "claude"), /^Da ging etwas schief: Kaputt$/);
  });
  it("schwärzt Geheimnisse", () => {
    const t = nutzerText(new Error("https://api.telegram.org/bot123456789:AAHfz-abcDEF_ghij1234567890/x"), "telegram");
    assert.ok(!t.includes("AAHfz"), t);
    assert.ok(t.includes("bot<token>"));
  });
});

describe("gesundheit", () => {
  let f: ReturnType<typeof fangeLogs>;
  const gesendet: string[] = [];
  beforeEach(() => { gesundheit._reset(); gesendet.length = 0; f = fangeLogs(); });
  afterEach(() => f.ende());

  it("erste Störung loggt einmal, dann höchstens alle 10 Minuten; Erholung geloggt", () => {
    const t0 = 1_000_000;
    gesundheit.melde("homeassistant", false, "HTTP 502", t0);
    gesundheit.melde("homeassistant", false, "HTTP 502", t0 + 3_000);
    gesundheit.melde("homeassistant", false, "HTTP 502", t0 + 5 * MIN);
    assert.equal(f.fehler.length, 1);
    assert.match(f.fehler[0]!, /Home Assistant: Störung \(HTTP 502\)/);
    gesundheit.melde("homeassistant", false, "HTTP 503", t0 + 11 * MIN);
    assert.equal(f.fehler.length, 2);
    assert.match(f.fehler[1]!, /weiterhin gestört seit 11 Minuten, 4 Fehler \(HTTP 503\)/);
    const z = gesundheit.zustand("homeassistant")!;
    assert.equal(z.ok, false); assert.equal(z.seit, t0); assert.equal(z.fehler, 4); assert.equal(z.letzterFehler, "HTTP 503"); assert.equal(z.gemeldet, false);
    gesundheit.melde("homeassistant", true, undefined, t0 + 25 * MIN);
    assert.equal(f.logs.length, 1);
    assert.match(f.logs[0]!, /Home Assistant wieder da \(nach 25 Minuten\)/);
    const o = gesundheit.zustand("homeassistant")!;
    assert.equal(o.ok, true); assert.equal(o.fehler, 0); assert.equal(o.letzterOk, t0 + 25 * MIN); assert.equal(o.letzterFehler, undefined);
    // Erfolg ohne Störung loggt nichts
    gesundheit.melde("claude", true, undefined, t0);
    assert.equal(f.logs.length, 1);
  });

  it("detail wird geschwärzt und gekürzt", () => {
    gesundheit.melde("telegram", false, `https://api.telegram.org/bot123456789:AAHfz-abcDEF_ghij1234567890/x ${"y".repeat(200)}`, 1000);
    const d = gesundheit.zustand("telegram")!.letzterFehler!;
    assert.ok(!d.includes("AAHfz")); assert.ok(d.includes("bot<token>")); assert.ok(d.length <= 140);
    assert.ok(!f.fehler[0]!.includes("AAHfz"));
  });

  it("bericht und alle", () => {
    gesundheit.melde("claude", true, undefined, 0);
    gesundheit.melde("homeassistant", false, "HTTP 502", 0);
    assert.equal(gesundheit.bericht(12 * MIN), "✅ claude\n❌ homeassistant seit 12 Min: HTTP 502");
    assert.deepEqual(Object.keys(gesundheit.alle()), ["claude", "homeassistant"]);
    assert.equal(gesundheit.alle().homeassistant!.ok, false);
    assert.equal(gesundheit.bericht(), gesundheit.bericht(Date.now()));
  });

  it("istOffline", () => {
    assert.equal(gesundheit.istOffline(0), false);
    gesundheit.melde("telegram", false, "Netz: ECONNREFUSED", 0);
    assert.equal(gesundheit.istOffline(0), false);
    gesundheit.melde("claude", false, "claude.messages: HTTP 500", 0);
    assert.equal(gesundheit.istOffline(0), false);
    gesundheit.melde("claude", false, "claude.messages: Zeitlimit: Request timed out.", 0);
    assert.equal(gesundheit.istOffline(0), true);
    assert.equal(gesundheit.istOffline(5 * MIN), true);
    gesundheit.melde("claude", true, undefined, 0);
    assert.equal(gesundheit.istOffline(0), false);
    gesundheit.melde("internet", false, undefined, 0);
    assert.equal(gesundheit.istOffline(0), true);
    assert.equal(gesundheit.istOffline(), true);
    gesundheit.melde("internet", true, undefined, 0);
    assert.equal(gesundheit.istOffline(0), false);
    assert.equal(gesundheit.istOffline(), false);
  });

  it("istOffline: veraltete Sende- und Claude-Fehler sperren nicht ewig", () => {
    const t0 = 7_000_000;
    gesundheit.melde("telegram", false, "telegram.sendPhoto: Netz: ENOTFOUND", t0);
    gesundheit.melde("claude", false, "claude.sehen: Netz: Connection error.", t0);
    assert.equal(gesundheit.istOffline(t0 + MIN), true);
    // ohne Polling (kein Internet-Zustand) gilt die Paarregel nur kurz
    assert.equal(gesundheit.istOffline(t0 + 6 * MIN), false);
    assert.equal(gesundheit.istOffline(t0 + 180 * MIN), false);
    // erneuter frischer Fehler sperrt wieder
    gesundheit.melde("telegram", false, "telegram.sendMessage: Netz: ENOTFOUND", t0 + 179 * MIN);
    gesundheit.melde("claude", false, "claude.messages: Netz: Connection error.", t0 + 179 * MIN);
    assert.equal(gesundheit.istOffline(t0 + 180 * MIN), true);
  });

  it("istOffline: Polling meldet Internet und Empfang ok → nicht offline, trotz alter Sende-/Claude-Fehler", () => {
    const t0 = 7_000_000;
    gesundheit.melde("telegram", false, "telegram.sendPhoto: Netz: ENOTFOUND", t0);
    gesundheit.melde("claude", false, "claude.sehen: Netz: Connection error.", t0);
    gesundheit.melde("telegram-empfang", false, "telegram.getUpdates: Netz: ENOTFOUND", t0);
    gesundheit.melde("internet", false, "Netz: ENOTFOUND", t0);
    assert.equal(gesundheit.istOffline(t0 + MIN), true);
    gesundheit.melde("telegram-empfang", true, undefined, t0 + 5 * MIN);
    gesundheit.melde("internet", true, undefined, t0 + 5 * MIN);
    assert.equal(gesundheit.istOffline(t0 + 5 * MIN), false);
    assert.equal(gesundheit.istOffline(t0 + 20 * MIN), false);
    // Sende- und Claude-Zustand sind weiterhin gestört (sie heilen erst beim nächsten Aufruf) – das darf nicht sperren
    assert.equal(gesundheit.zustand("telegram")!.ok, false);
    assert.equal(gesundheit.zustand("claude")!.ok, false);
    // Polling meldet erneut Netzfehler → offline
    gesundheit.melde("internet", false, "Netz: ENOTFOUND", t0 + 30 * MIN);
    assert.equal(gesundheit.istOffline(t0 + 30 * MIN), true);
  });

  it("Watchdog meldet erst ab Schwelle und genau einmal, Erholung einmal", async () => {
    gesundheit.setzeMelder(async (t) => { gesendet.push(t); });
    const t0 = 5_000_000;
    gesundheit.melde("homeassistant", false, "HTTP 502", t0);
    gesundheit.melde("homeassistant", false, "HTTP 502", t0 + 5 * MIN);
    await gesundheit.tick(t0 + 9 * MIN);
    assert.deepEqual(gesendet, []);
    gesundheit.melde("homeassistant", false, "HTTP 502", t0 + 11 * MIN);
    assert.equal(gesundheit.zustand("homeassistant")!.gemeldet, false);
    await gesundheit.tick(t0 + 12 * MIN);
    assert.deepEqual(gesendet, ["Sir, Home Assistant antwortet seit 12 Minuten nicht (HTTP 502). Ich versuche es weiter."]);
    assert.equal(gesundheit.zustand("homeassistant")!.gemeldet, true);
    gesundheit.melde("homeassistant", false, "HTTP 502", t0 + 13 * MIN);
    await gesundheit.tick(t0 + 14 * MIN);
    await gesundheit.tick(t0 + 20 * MIN);
    assert.equal(gesendet.length, 1);
    gesundheit.melde("homeassistant", true, undefined, t0 + 25 * MIN);
    assert.equal(gesundheit.zustand("homeassistant")!.gemeldet, false);
    await gesundheit.tick(t0 + 26 * MIN);
    await gesundheit.tick(t0 + 27 * MIN);
    assert.deepEqual(gesendet.slice(1), ["Home Assistant ist wieder erreichbar (Ausfall 25 Minuten)."]);
  });

  it("ohne Meldung keine Erholungsmeldung; kurze Störung bleibt still", async () => {
    gesundheit.setzeMelder(async (t) => { gesendet.push(t); });
    gesundheit.melde("claude", false, "HTTP 529", 0);
    gesundheit.melde("claude", true, undefined, 3 * MIN);
    await gesundheit.tick(4 * MIN);
    assert.deepEqual(gesendet, []);
  });

  it("Internet-Sammelmeldung unterdrückt Einzelmeldungen", async () => {
    gesundheit.setzeMelder(async (t) => { gesendet.push(t); });
    for (const t of [0, 5 * MIN, 10 * MIN, 15 * MIN]) {
      gesundheit.melde("internet", false, undefined, t);
      gesundheit.melde("claude", false, "Netz: ENOTFOUND", t);
      gesundheit.melde("homeassistant", false, "ha.get: Netz: EHOSTUNREACH", t);
    }
    await gesundheit.tick(15 * MIN);
    assert.deepEqual(gesendet, ["Sir, die Internetverbindung ist seit 15 Minuten gestört."]);
    gesundheit.melde("internet", false, undefined, 20 * MIN);
    gesundheit.melde("homeassistant", false, "ha.get: Netz: EHOSTUNREACH", 20 * MIN);
    await gesundheit.tick(20 * MIN);
    assert.equal(gesendet.length, 1);
    assert.equal(gesundheit.zustand("claude")!.gemeldet, false);
    gesundheit.melde("homeassistant", false, "ha.get: Netz: EHOSTUNREACH", 30 * MIN);
    gesundheit.melde("internet", true, undefined, 30 * MIN);
    gesundheit.melde("claude", true, undefined, 30 * MIN);
    await gesundheit.tick(31 * MIN);
    assert.deepEqual(gesendet.slice(1), [
      "Die Internetverbindung ist wieder da (Ausfall 30 Minuten).",
      "Sir, Home Assistant antwortet seit 31 Minuten nicht (Netzfehler). Ich versuche es weiter.",
    ]);
  });

  it("nach Internetausfall keine Einzelmeldung für Netzfehler aus der Ausfallzeit", async () => {
    gesundheit.setzeMelder(async (t) => { gesendet.push(t); });
    // 20 Minuten ohne Internet: Polling meldet internet, der Postausgang scheitert jede Minute an Telegram
    for (let m = 0; m <= 20; m++) {
      gesundheit.melde("internet", false, "Netz: ENOTFOUND", m * MIN);
      gesundheit.melde("telegram", false, "telegram.sendMessage: Netz: ENOTFOUND", m * MIN);
      gesundheit.melde("wetter", false, "wetter.get: Zeitlimit: The operation was aborted due to timeout", m * MIN);
      gesundheit.melde("claude", false, "claude.messages: HTTP 500", m * MIN);
    }
    await gesundheit.tick(20 * MIN);
    assert.deepEqual(gesendet, ["Sir, die Internetverbindung ist seit 20 Minuten gestört."]);
    // Polling: Internet wieder da; der Watchdog-Tick kommt vor dem nächsten Sendeversuch
    gesundheit.melde("internet", true, undefined, 20 * MIN + 30_000);
    await gesundheit.tick(21 * MIN);
    assert.deepEqual(gesendet.slice(1), [
      "Die Internetverbindung ist wieder da (Ausfall 21 Minuten).",
      // HTTP 500 ist kein Netzfehler: eigene Störung, nach der Erholung gemeldet
      "Sir, die Claude-API antwortet seit 21 Minuten nicht (HTTP 500). Ich versuche es weiter.",
    ]);
    assert.equal(gesundheit.zustand("telegram")!.gemeldet, false);
    assert.equal(gesundheit.zustand("wetter")!.gemeldet, false);
    // Postausgang klappt: keine Erholungsmeldung für Telegram (nie einzeln gemeldet)
    gesundheit.melde("telegram", true, undefined, 21 * MIN + 10_000);
    await gesundheit.tick(22 * MIN);
    await gesundheit.tick(23 * MIN);
    assert.equal(gesendet.length, 3);
    assert.ok(!gesendet.some((t) => /Telegram|Wetterdienst/.test(t)), gesendet.join("\n"));
    // Scheitert eine Komponente auch nach der Erholung weiter, ist das eine eigene Störung
    gesundheit.melde("wetter", false, "wetter.get: Zeitlimit: The operation was aborted due to timeout", 24 * MIN);
    await gesundheit.tick(24 * MIN);
    assert.deepEqual(gesendet.slice(3), ["Sir, der Wetterdienst antwortet seit 24 Minuten nicht (Zeitlimit). Ich versuche es weiter."]);
  });

  it("Melder-Fehler lässt gemeldet auf false, nächster Tick versucht erneut", async () => {
    let kaputt = true;
    gesundheit.setzeMelder(async (t) => { if (kaputt) throw new Error("Telegram weg"); gesendet.push(t); });
    gesundheit.melde("claude", false, "HTTP 500", 0);
    gesundheit.melde("claude", false, "HTTP 500", 10 * MIN);
    await gesundheit.tick(11 * MIN);
    assert.deepEqual(gesendet, []);
    assert.equal(gesundheit.zustand("claude")!.gemeldet, false);
    kaputt = false;
    await gesundheit.tick(12 * MIN);
    assert.deepEqual(gesendet, ["Sir, die Claude-API antwortet seit 12 Minuten nicht (HTTP 500). Ich versuche es weiter."]);
    assert.equal(gesundheit.zustand("claude")!.gemeldet, true);
    // Erholungsmeldung wird bei Melder-Fehler ebenfalls nachgeholt
    kaputt = true;
    gesundheit.melde("claude", true, undefined, 20 * MIN);
    await gesundheit.tick(21 * MIN);
    assert.equal(gesendet.length, 1);
    kaputt = false;
    await gesundheit.tick(22 * MIN);
    assert.equal(gesendet[1], "Die Claude-API ist wieder erreichbar (Ausfall 20 Minuten).");
  });

  it("einzelner Fehlschlag ohne weitere Versuche ist keine Dauerstörung", async () => {
    gesundheit.setzeMelder(async (t) => { gesendet.push(t); });
    const t0 = 7_000_000;
    gesundheit.melde("homeassistant", false, "ha.get: Home Assistant HTTP 502 (states)", t0);
    gesundheit.melde("homeassistant", false, "ha.get: Home Assistant HTTP 502 (states)", t0 + 1_000);
    await gesundheit.tick(t0 + 10 * MIN);
    await gesundheit.tick(t0 + 30 * MIN);
    assert.deepEqual(gesendet, []);
    assert.equal(gesundheit.bericht(t0 + 240 * MIN), "❌ homeassistant seit 240 Min: ha.get: Home Assistant HTTP 502 (states) (letzter Versuch vor 240 Min)");
    // Neuer Einzelfehler Stunden später beginnt eine neue Störung statt «seit 240 Minuten»
    f.fehler.length = 0;
    gesundheit.melde("homeassistant", false, "ha.get: Home Assistant HTTP 503 (states)", t0 + 240 * MIN);
    assert.equal(gesundheit.zustand("homeassistant")!.seit, t0 + 240 * MIN);
    assert.equal(gesundheit.zustand("homeassistant")!.fehler, 1);
    assert.match(f.fehler[0]!, /Home Assistant: Störung/);
    await gesundheit.tick(t0 + 241 * MIN);
    assert.deepEqual(gesendet, []);
    // Dauerhafte Fehler über die Schwelle werden weiterhin gemeldet
    gesundheit.melde("homeassistant", false, "ha.get: Home Assistant HTTP 503 (states)", t0 + 245 * MIN);
    gesundheit.melde("homeassistant", false, "ha.get: Home Assistant HTTP 503 (states)", t0 + 250 * MIN);
    await gesundheit.tick(t0 + 251 * MIN);
    assert.deepEqual(gesendet, ["Sir, Home Assistant antwortet seit 11 Minuten nicht (HTTP 503). Ich versuche es weiter."]);
  });

  it("Watchdog-Meldung ohne Aufrufnamen und Roh-JSON, letzterFehler bleibt ausführlich", async () => {
    gesundheit.setzeMelder(async (t) => { gesendet.push(t); });
    const ueberlastet = new Anthropic.InternalServerError(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, sdkHeaders());
    const fall = async (k: "claude" | "homeassistant" | "telegram" | "shopify" | "mqtt", e: unknown, name: string) => {
      // genau das Detail, das mitWiederholung meldet: «name: fehlerDetail(e)»
      for (const t of [0, 5 * MIN, 11 * MIN]) gesundheit.melde(k, false, `${name}: ${fehlerDetail(e)}`, t);
    };
    await fall("claude", ueberlastet, "claude.chat");
    await fall("homeassistant", new HttpFehler("Home Assistant HTTP 502 (states)", 502), "ha.get");
    await fall("telegram", new HttpFehler("Telegram HTTP 429: Too Many Requests: retry after 5", 429, 5000), "telegram.getUpdates");
    await fall("shopify", Object.assign(new Error("connect ECONNREFUSED 10.0.0.2:443"), { code: "ECONNREFUSED" }), "shopify.get");
    gesundheit.melde("mqtt", false, "Verbindung verloren", 0);
    gesundheit.melde("mqtt", false, "Verbindung verloren", 11 * MIN);
    assert.match(gesundheit.zustand("claude")!.letzterFehler!, /^claude\.chat: HTTP 529/);
    await gesundheit.tick(12 * MIN);
    assert.deepEqual(gesendet, [
      "Sir, die Claude-API antwortet seit 12 Minuten nicht (HTTP 529). Ich versuche es weiter.",
      "Sir, Home Assistant antwortet seit 12 Minuten nicht (HTTP 502). Ich versuche es weiter.",
      "Sir, der MQTT-Broker antwortet seit 12 Minuten nicht (Verbindung verloren). Ich versuche es weiter.",
      "Sir, Shopify antwortet seit 12 Minuten nicht (Netzfehler). Ich versuche es weiter.",
      "Sir, Telegram antwortet seit 12 Minuten nicht (Rate-Limit). Ich versuche es weiter.",
    ]);
    for (const t of gesendet) assert.doesNotMatch(t, /claude\.chat|ha\.get|telegram\.|shopify\.|\{/);
  });

  it("Einzahl bei 1 Minute", async () => {
    gesundheit.setzeMelder(async (t) => { gesendet.push(t); });
    const alt = config.watchdogMinuten;
    config.watchdogMinuten = 1;
    try {
      gesundheit.melde("internet", false, undefined, 0);
      gesundheit.melde("internet", false, undefined, MIN);
      await gesundheit.tick(70_000);
      gesundheit.melde("internet", true, undefined, 80_000);
      gesundheit.melde("claude", false, "HTTP 500", 2 * MIN);
      gesundheit.melde("claude", false, "HTTP 500", 3 * MIN);
      await gesundheit.tick(3 * MIN);
      gesundheit.melde("claude", true, undefined, 4 * MIN);
      await gesundheit.tick(4 * MIN);
      assert.deepEqual(gesendet, [
        "Sir, die Internetverbindung ist seit 1 Minute gestört.",
        "Die Internetverbindung ist wieder da (Ausfall 1 Minute).",
        "Sir, die Claude-API antwortet seit 1 Minute nicht (HTTP 500). Ich versuche es weiter.",
        "Die Claude-API ist wieder erreichbar (Ausfall 2 Minuten).",
      ]);
      assert.ok(f.logs.some((l) => /wieder da \(nach 1 Minute\)/.test(l)), f.logs.join("\n"));
    } finally { config.watchdogMinuten = alt; }
  });

  it("ohne Melder oder mit WATCHDOG_MINUTEN=0 passiert nichts", async () => {
    gesundheit.melde("claude", false, "HTTP 500", 0);
    await gesundheit.tick(60 * MIN);
    assert.equal(gesundheit.zustand("claude")!.gemeldet, false);
    gesundheit.setzeMelder(async (t) => { gesendet.push(t); });
    const alt = config.watchdogMinuten;
    config.watchdogMinuten = 0;
    try {
      await gesundheit.tick(60 * MIN);
      assert.deepEqual(gesendet, []);
      assert.equal(gesundheit.zustand("claude")!.gemeldet, false);
    } finally { config.watchdogMinuten = alt; }
    assert.equal(alt, 10);
  });
});
