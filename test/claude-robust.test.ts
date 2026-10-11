import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";

const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-claude-"));
process.chdir(temp);
process.env.ANTHROPIC_API_KEY = "sk-ant-test-nur-attrappe";
process.env.WATCHDOG_MINUTEN = "10";
after(() => { process.chdir(projekt); rmSync(temp, { recursive: true, force: true }); });

const { anthropic, claudeAufruf } = await import("../src/claude.js");
const { gesundheit } = await import("../src/robust.js");
const { state } = await import("../src/state.js");

/** SDK-Fehlerobjekte wie in @anthropic-ai/sdk/core/error.js: (status, error, message, headers) */
const kopf = (h: Record<string, string> = {}) => new Headers(h);
const rateLimit = (retryAfter?: string) =>
  new Anthropic.RateLimitError(429, { error: { type: "rate_limit_error", message: "zu viele Anfragen" } }, undefined, kopf(retryAfter ? { "retry-after": retryAfter } : {}));
const serverFehler = () => new Anthropic.InternalServerError(503, { error: { type: "overloaded_error", message: "Overloaded" } }, undefined, kopf());
const badRequest = () => new Anthropic.BadRequestError(400, { error: { type: "invalid_request_error", message: "max_tokens zu gross" } }, undefined, kopf());
const authFehler = () => new Anthropic.AuthenticationError(401, { error: { type: "authentication_error", message: "invalid x-api-key" } }, undefined, kopf());

/** console.log/error abfangen (gesundheit loggt Störungen) */
function fangeLogs(): { fehler: string[]; ende: () => void } {
  const fehler: string[] = [];
  const log = console.log; const err = console.error;
  console.log = () => undefined;
  console.error = (...a: unknown[]) => { fehler.push(a.map(String).join(" ")); };
  return { fehler, ende: () => { console.log = log; console.error = err; } };
}

describe("claudeAufruf", () => {
  const gewartet: number[] = [];
  const warten = async (ms: number) => { gewartet.push(ms); };
  const zufall = () => 0.5;
  let logs: ReturnType<typeof fangeLogs>;
  beforeEach(() => { gewartet.length = 0; gesundheit._reset(); logs = fangeLogs(); });
  afterEach(() => logs.ende());

  it("Client mit explizitem maxRetries 2", () => {
    assert.equal(anthropic().maxRetries, 2);
  });

  it("RateLimitError: wartet laut Retry-After und wiederholt, Erfolg meldet Gesundheit ok", async () => {
    let n = 0;
    const versuche: number[] = [];
    const ergebnis = await claudeAufruf("chat", async (v) => {
      versuche.push(v);
      n++;
      if (n === 1) throw rateLimit("2");
      return "antwort";
    }, { warten, zufall });
    assert.equal(ergebnis, "antwort");
    assert.deepEqual(versuche, [1, 2]);
    assert.deepEqual(gewartet, [2000]);
    assert.equal(gesundheit.zustand("claude")?.ok, true);
    assert.equal(logs.fehler.length, 1); // erste Störung einmal geloggt
    assert.match(logs.fehler[0]!, /Claude-API: Störung \(claude\.chat: HTTP 429/);
  });

  it("ohne Retry-After: Backoff 5 s, 10 s – höchstens drei Versuche, letzter Fehler fliegt", async () => {
    let n = 0;
    await assert.rejects(claudeAufruf("chat", async () => { n++; throw rateLimit(); }, { warten, zufall }), (e: unknown) => e instanceof Anthropic.RateLimitError);
    assert.equal(n, 3);
    assert.deepEqual(gewartet, [5000, 10000]);
    const z = gesundheit.zustand("claude");
    assert.equal(z?.ok, false);
    assert.equal(z?.fehler, 3);
    assert.match(z?.letzterFehler ?? "", /HTTP 429/);
  });

  it("InternalServerError und Verbindungsfehler werden wiederholt, Zeitlimit auch", async () => {
    let n = 0;
    const ergebnis = await claudeAufruf("sehen", async () => {
      n++;
      if (n === 1) throw serverFehler();
      if (n === 2) throw new Anthropic.APIConnectionTimeoutError({});
      return n;
    }, { warten, zufall });
    assert.equal(ergebnis, 3);
    assert.deepEqual(gewartet, [5000, 10000]);
    n = 0;
    await claudeAufruf("sehen", async () => { n++; if (n === 1) throw new Anthropic.APIConnectionError({ cause: new Error("ECONNRESET") }); return "ok"; }, { warten, zufall });
    assert.equal(n, 2);
  });

  it("BadRequestError: kein Retry, keine Störung der Komponente", async () => {
    let n = 0;
    await assert.rejects(claudeAufruf("chat", async () => { n++; throw badRequest(); }, { warten, zufall }), /max_tokens zu gross/);
    assert.equal(n, 1);
    assert.deepEqual(gewartet, []);
    assert.equal(gesundheit.zustand("claude"), undefined);
    assert.deepEqual(logs.fehler, []);
  });

  it("NotFound und Abbruch: kein Retry", async () => {
    let n = 0;
    await assert.rejects(claudeAufruf("chat", async () => { n++; throw new Anthropic.NotFoundError(404, { error: { type: "not_found_error", message: "model" } }, undefined, kopf()); }, { warten, zufall }));
    await assert.rejects(claudeAufruf("chat", async () => { n++; throw new Anthropic.APIUserAbortError({ message: "Pausiert" }); }, { warten, zufall }), /Pausiert/);
    assert.equal(n, 2);
    assert.deepEqual(gewartet, []);
    // Abbruch ist keine Störung der Claude-API
    assert.equal(gesundheit.zustand("claude")?.ok ?? true, true);
    assert.doesNotMatch(gesundheit.bericht(), /Pausiert/);
  });

  it("AuthenticationError: kein Retry, Gesundheit meldet «API-Schlüssel abgelehnt»", async () => {
    let n = 0;
    await assert.rejects(claudeAufruf("chat", async () => { n++; throw authFehler(); }, { warten, zufall }), (e: unknown) => e instanceof Anthropic.AuthenticationError);
    assert.equal(n, 1);
    assert.deepEqual(gewartet, []);
    const z = gesundheit.zustand("claude");
    assert.equal(z?.ok, false);
    assert.equal(z?.letzterFehler, "API-Schlüssel abgelehnt");
    assert.match(gesundheit.bericht(), /❌ claude .*API-Schlüssel abgelehnt/);
    // Fehlertexte enthalten nie den Schlüssel
    for (const zeile of logs.fehler) assert.doesNotMatch(zeile, /sk-ant-test/);
  });

  it("Notaus während der Wartezeit: kein zweiter Versuch, echter Fehler bleibt, Gesundheit ohne «Pausiert»", async () => {
    let n = 0;
    try {
      await assert.rejects(claudeAufruf("chat", async () => {
        n++;
        state.paused = true; // Notaus kommt nach dem ersten Fehlversuch
        throw rateLimit();
      }, { warten, zufall }), (e: unknown) => e instanceof Anthropic.RateLimitError);
    } finally {
      state.paused = false;
    }
    assert.equal(n, 1);
    assert.deepEqual(gewartet, []);
    const z = gesundheit.zustand("claude");
    assert.equal(z?.ok, false);
    assert.equal(z?.fehler, 1);
    assert.match(z?.letzterFehler ?? "", /HTTP 429/);
    assert.doesNotMatch(z?.letzterFehler ?? "", /Pausiert/);
    assert.doesNotMatch(gesundheit.bericht(), /Pausiert/);
  });

  it("Notaus kommt erst in der Backoff-Wartezeit: kein weiterer Versuch, echter Fehler fliegt", async () => {
    let n = 0;
    const wartenMitNotaus = async (ms: number) => { gewartet.push(ms); state.paused = true; };
    try {
      await assert.rejects(claudeAufruf("chat", async () => { n++; throw serverFehler(); }, { warten: wartenMitNotaus, zufall }),
        (e: unknown) => e instanceof Anthropic.InternalServerError);
    } finally {
      state.paused = false;
    }
    assert.equal(n, 1); // nach dem Warten kein zweiter messages.create
    assert.deepEqual(gewartet, [5000]);
    const z = gesundheit.zustand("claude");
    assert.equal(z?.fehler, 1); // der Abbruch zählt nicht als Störung
    assert.match(z?.letzterFehler ?? "", /HTTP 503/);
    assert.doesNotMatch(gesundheit.bericht(), /Pausiert/);
  });

  it("ohne Notaus läuft der zweite Anlauf nach der Wartezeit normal", async () => {
    let n = 0;
    const ergebnis = await claudeAufruf("chat", async () => { n++; if (n === 1) throw serverFehler(); return "ok"; }, { warten, zufall });
    assert.equal(ergebnis, "ok");
    assert.equal(n, 2);
    assert.equal(state.paused, false);
  });

  it("Versuchsnummer wird an fn durchgereicht", async () => {
    const gesehen: number[] = [];
    await claudeAufruf("chat", async (v) => { gesehen.push(v); if (v < 3) throw serverFehler(); return "ok"; }, { warten, zufall });
    assert.deepEqual(gesehen, [1, 2, 3]);
  });
});
