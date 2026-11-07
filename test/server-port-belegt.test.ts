import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

// Belegter Port (eine alte Instanz, Grafana auf 3000): Express 5 ruft den listen-Callback auch mit dem Fehler auf.
// Früher meldete der Dienst trotzdem «Jarvis läuft» und lief ohne /alexa, /notfall und Dashboard weiter – systemd sah
// keinen Fehler, und mit der alten Instanz liefen zwei Scheduler. Jetzt beendet er sich mit Code 1.
const projekt = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "jarvis-port-belegt-"));
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
const attrappe = join(temp, "fetch-attrappe.mjs");
// Jeder fetch-Aufruf hinterlässt eine Zeile (synchron, damit auch ein Aufruf kurz vor exit(1) zählt)
const zaehler = join(temp, "fetch-aufrufe.txt");
writeFileSync(
  attrappe,
  `import { appendFileSync } from "node:fs";\n` +
    `globalThis.fetch = async (u) => { appendFileSync(${JSON.stringify(zaehler)}, String(u).split("?")[0] + "\\n"); throw new Error("kein Netz im Test"); };\n`,
);

/** Startet server.ts gegen den belegten Port; liefert Exit-Code (null = lief über die Frist) und Ausgabe. */
const starten = async (port: number, envExtra: Record<string, string> = {}) => {
  const kind = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(attrappe).href, join(projekt, "src/server.ts")], {
    cwd: temp,
    env: { PATH: process.env.PATH ?? "", HOME: temp, PORT: String(port), LISTEN_HOST: "127.0.0.1", ...envExtra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ausgabe = "";
  kind.stdout?.on("data", (d: Buffer) => (ausgabe += d.toString()));
  kind.stderr?.on("data", (d: Buffer) => (ausgabe += d.toString()));
  const wunsch = Number(process.env.JARVIS_TEST_STARTFRIST_MS);
  const frist = Number.isFinite(wunsch) && wunsch > 0 ? wunsch : 30_000;
  const code = await new Promise<number | null>((ok) => {
    const t = setTimeout(() => { kind.kill("SIGKILL"); ok(null); }, frist);
    kind.once("exit", (c) => { clearTimeout(t); ok(c); });
  });
  return { code, ausgabe };
};

const belegen = () =>
  new Promise<{ server: Server; port: number }>((ok, fehler) => {
    const server = createServer();
    server.once("error", fehler);
    server.listen(0, "127.0.0.1", () => {
      const adresse = server.address();
      ok({ server, port: typeof adresse === "object" && adresse ? adresse.port : 0 });
    });
  });

describe("server.ts: belegter Port", () => {
  it("beendet sich mit Code 1 und meldet nie «Jarvis läuft»", async () => {
    const { server, port } = await belegen();
    try {
      const { code, ausgabe } = await starten(port);
      assert.equal(code, 1, `Dienst lief weiter oder endete anders:\n${ausgabe}`);
      assert.doesNotMatch(ausgabe, /Jarvis läuft/);
      assert.match(ausgabe, new RegExp(`Port ${port} auf 127\\.0\\.0\\.1 nicht verfügbar \\(.*EADDRINUSE.*\\)\\. Jarvis beendet sich, Sir\\.`));
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  // Hintergrundläufe (Telegram-Poll, Dateihinweise, Scheduler, Wachen, Morgen-Tick, Watchdog) erst nach dem Port:
  // sonst stösst jeder Neustart-Versuch von systemd (alle 10 s) Telegram und Wetter an, bevor exit(1) greift.
  it("startet bei belegtem Port keine Hintergrundläufe (kein einziger Netzaufruf)", async () => {
    const { server, port } = await belegen();
    try {
      rmSync(zaehler, { force: true });
      const { code, ausgabe } = await starten(port, {
        TELEGRAM_BOT_TOKEN: "123456:test-attrappe",
        TELEGRAM_CHAT_ID: "42",
        FRIGATE_URL: "http://127.0.0.1:9",
        MQTT_URL: "mqtt://127.0.0.1:9",
      });
      assert.equal(code, 1, `Dienst lief weiter oder endete anders:\n${ausgabe}`);
      const aufrufe = existsSync(zaehler) ? readFileSync(zaehler, "utf8").trim() : "";
      assert.equal(aufrufe, "", `Netzaufrufe trotz belegtem Port:\n${aufrufe}`);
      assert.doesNotMatch(ausgabe, /Telegram aktiv/);
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
});
