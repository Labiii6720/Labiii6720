import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

// Der Dienst selbst muss unterbrochene Vorgänge abschliessen: vorgaengeNachNeustart war definiert, aber nie aufgerufen.
// Ein Absturz mitten in /vorgang hinterliess den Eintrag für immer als «läuft» (/vorgaenge, /status.json, Kontext für Claude).
const projekt = resolve(import.meta.dirname, "..");
const basis = mkdtempSync(join(tmpdir(), "jarvis-server-vorgaenge-"));
process.once("exit", () => rmSync(basis, { recursive: true, force: true }));

const UNTERBROCHEN = "durch Neustart unterbrochen, Ergebnis unklar";
const kinder = new Set<ChildProcess>();
process.once("exit", () => { for (const k of kinder) k.kill("SIGKILL"); });

const freierPort = () =>
  new Promise<number>((ok, fehler) => {
    const s = createServer();
    s.once("error", fehler);
    s.listen(0, "127.0.0.1", () => {
      const adresse = s.address();
      const port = typeof adresse === "object" && adresse ? adresse.port : 0;
      s.close(() => ok(port));
    });
  });

/** Eigener Temp-Ordner mit einer vorgaenge.json, wie sie ein Absturz mitten im Vorgang hinterlässt. */
function ordner(name: string): string {
  const temp = join(basis, name);
  mkdirSync(join(temp, "data"), { recursive: true });
  const jetzt = new Date().toISOString();
  writeFileSync(
    join(temp, "data", "vorgaenge.json"),
    JSON.stringify([
      { id: 1, auftrag: "Längst erledigt", status: "fertig", startedAt: jetzt, finishedAt: jetzt, steps: 3, result: "ok" },
      // vor dem Systemstart begonnen: kann nicht mehr laufen, auch wenn PID 1 lebt
      { id: 2, auftrag: "Server-Bericht vor dem Absturz", status: "läuft", startedAt: "2000-01-01T00:00:00.000Z", steps: 7, pid: 1 },
      // ältere Einträge ohne PID gelten als unterbrochen
      { id: 3, auftrag: "Alter Eintrag ohne PID", status: "läuft", startedAt: jetzt, steps: 2 },
      // ein lebender fremder Prozess (dieser Testlauf) arbeitet ihn noch ab: bleibt «läuft»
      { id: 4, auftrag: "Läuft anderswo weiter", status: "läuft", startedAt: jetzt, steps: 1, pid: process.pid },
    ]),
  );
  return temp;
}

/** fetch-Attrappe: Telegram-sendMessage wird protokolliert, getUpdates hängt, alles andere schlägt fehl (kein Netz). */
function attrappe(temp: string): { datei: string; gesendet: string } {
  const datei = join(temp, "fetch-attrappe.mjs");
  const gesendet = join(temp, "gesendet.jsonl");
  writeFileSync(
    datei,
    `import { appendFileSync } from "node:fs";\n` +
      `globalThis.fetch = async (u, init) => {\n` +
      `  const url = String(u instanceof Request ? u.url : u);\n` +
      `  if (!url.startsWith("https://api.telegram.org/bot")) throw new Error("kein Netz im Test");\n` +
      `  if (url.endsWith("/getUpdates")) return new Promise(() => undefined);\n` +
      `  if (url.endsWith("/sendMessage")) appendFileSync(${JSON.stringify(gesendet)}, JSON.stringify(JSON.parse(String(init?.body ?? "{}")).text ?? "") + "\\n");\n` +
      `  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });\n` +
      `};\n`,
  );
  return { datei, gesendet };
}

async function starten(temp: string, envExtra: Record<string, string> = {}): Promise<{ kind: ChildProcess; ausgabe: () => string; gesendet: string }> {
  const { datei, gesendet } = attrappe(temp);
  const port = await freierPort();
  const kind = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(datei).href, join(projekt, "src/server.ts")], {
    cwd: temp,
    env: { PATH: process.env.PATH ?? "", HOME: temp, PORT: String(port), LISTEN_HOST: "127.0.0.1", ...envExtra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  kinder.add(kind);
  kind.once("exit", () => kinder.delete(kind));
  let ausgabe = "";
  kind.stdout?.on("data", (d: Buffer) => (ausgabe += d.toString()));
  kind.stderr?.on("data", (d: Buffer) => (ausgabe += d.toString()));
  return { kind, ausgabe: () => ausgabe, gesendet };
}

const wunsch = Number(process.env.JARVIS_TEST_STARTFRIST_MS);
const frist = Number.isFinite(wunsch) && wunsch > 0 ? wunsch : 30_000;

async function bis(bedingung: () => boolean, ausgabe: () => string): Promise<void> {
  const ende = Date.now() + frist;
  while (!bedingung() && Date.now() < ende) await new Promise((r) => setTimeout(r, 50));
  assert.ok(bedingung(), `Bedingung nicht erreicht:\n${ausgabe()}`);
}

function lesen<T>(datei: string): T | undefined {
  try {
    return JSON.parse(readFileSync(datei, "utf8")) as T;
  } catch {
    return undefined;
  }
}

type Eintrag = { id: number; status: string; result?: string; finishedAt?: string };
const status = (temp: string) => lesen<Eintrag[]>(join(temp, "data", "vorgaenge.json")) ?? [];
const notizen = (temp: string) =>
  (lesen<{ content: unknown }[]>(join(temp, "data", "chat.json")) ?? []).map((m) => (typeof m.content === "string" ? m.content : ""));

function beenden(kind: ChildProcess): Promise<void> {
  if (kind.exitCode !== null || kind.signalCode !== null) return Promise.resolve();
  return new Promise((ok) => {
    kind.once("exit", () => ok());
    kind.kill("SIGKILL");
  });
}

function pruefeAbgeschlossen(temp: string): void {
  const liste = status(temp);
  assert.deepEqual(liste.map((v) => v.status), ["fertig", "fehler", "fehler", "läuft"]);
  for (const v of [liste[1]!, liste[2]!]) {
    assert.equal(v.result, UNTERBROCHEN);
    assert.ok(v.finishedAt);
  }
  assert.equal(liste[0]!.result, "ok", "Abgeschlossenes bleibt unberührt");
  const n = notizen(temp);
  assert.ok(n.some((t) => t.startsWith("[Systemnotiz] Vorgang #2 ") && t.includes("nach 7 Schritten") && t.includes("Ergebnis unklar")));
  assert.ok(n.some((t) => t.startsWith("[Systemnotiz] Vorgang #3 ")));
  assert.ok(!n.some((t) => t.includes("Vorgang #4 ") || t.includes("Vorgang #1 ")));
}

describe("server.ts: Vorgänge nach einem Neustart", () => {
  it("ohne Telegram: unterbrochene Vorgänge auf «fehler», gespeichert, Systemnotiz für Claude", async () => {
    const temp = ordner("ohne-telegram");
    const { kind, ausgabe } = await starten(temp);
    try {
      await bis(() => ausgabe().includes("Jarvis läuft"), ausgabe);
      await bis(() => status(temp)[1]?.status === "fehler" && notizen(temp).length >= 2, ausgabe);
      pruefeAbgeschlossen(temp);
    } finally {
      await beenden(kind);
    }
  });

  it("mit Telegram: zusätzlich einmal gemeldet", async () => {
    const temp = ordner("mit-telegram");
    const { kind, ausgabe, gesendet } = await starten(temp, { TELEGRAM_BOT_TOKEN: "123456:test-attrappe", TELEGRAM_CHAT_ID: "42" });
    const texte = () => (existsSync(gesendet) ? readFileSync(gesendet, "utf8").trim().split("\n").filter(Boolean).map((z) => JSON.parse(z) as string) : []);
    try {
      await bis(() => texte().some((t) => t.includes("Neustart unterbrochen")), ausgabe);
      await bis(() => status(temp)[1]?.status === "fehler", ausgabe);
      pruefeAbgeschlossen(temp);
      assert.deepEqual(
        texte().filter((t) => t.includes("Neustart unterbrochen")),
        ["⚠️ Vorgänge #2, #3 wurden durch einen Neustart unterbrochen, Ergebnis unklar – bitte prüfen, Sir."],
      );
    } finally {
      await beenden(kind);
    }
  });
});
