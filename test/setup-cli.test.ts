import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { parseEnv } from "node:util";

const projekt = resolve(import.meta.dirname, "..");
const skript = join(projekt, "scripts", "setup.ts");

interface Lauf { code: number | null; signal: NodeJS.Signals | null; out: string; err: string }

/** Fährt den Assistenten mit gepipten Antworten; keine Prüfungen, keine Netzaufrufe. */
function fahre(dir: string, antworten: string[], extra: string[] = [], sigint = false): Promise<Lauf> {
  return new Promise((fertig) => {
    const kind = spawn(process.execPath, ["--import", "tsx", skript, "--ohne-pruefung", "--alle", "--env", join(dir, ".env"), "--beispiel", join(dir, ".env.example"), ...extra], {
      cwd: projekt, timeout: 60_000, env: { ...process.env, ANTHROPIC_API_KEY: "", TELEGRAM_BOT_TOKEN: "" },
    });
    let out = "";
    let err = "";
    kind.stdout.on("data", (c) => (out += c));
    kind.stderr.on("data", (c) => (err += c));
    kind.on("close", (code, signal) => fertig({ code, signal, out, err }));
    if (sigint) {
      setTimeout(() => kind.kill("SIGINT"), 1500);
    } else {
      kind.stdin.end(antworten.map((a) => a + "\n").join(""));
    }
  });
}

const temp: string[] = [];
after(() => { for (const d of temp) rmSync(d, { recursive: true, force: true }); });

function neuesVerzeichnis(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cli-"));
  temp.push(dir);
  copyFileSync(join(projekt, ".env.example"), join(dir, ".env.example"));
  return dir;
}

const TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
const KEY = "sk-ant-api03-testschluessel-nicht-echt";

/** Antworten erster Lauf: Pflichtwerte, Chat-ID zuerst ungültig, sonst Enter (63 Felder in Reihenfolge der Abschnitte) */
function ersteAntworten(): string[] {
  return [
    "Labinot", "", "", "", "", // grundlagen
    KEY, "", "", "", "", "", // claude
    TOKEN, "abc", "12345", // telegram: Chat-ID erst ungültig
    "9876", "", "", "", "", "", "", // sicherheit: PIN, zwei Tokens erzeugen
    ...Array(50).fill(""), // Rest: Enter (mehr als nötig schadet nicht)
  ];
}

describe("scripts/setup.ts (End-zu-End)", () => {
  it("erster Lauf: Pflichtwerte, erzeugte Tokens, Rechte, Kommentare, ungültige Chat-ID abgewiesen", async () => {
    const dir = neuesVerzeichnis();
    const lauf = await fahre(dir, ersteAntworten());
    assert.equal(lauf.code, 0, lauf.out + lauf.err);
    assert.equal(lauf.err, "");
    const env = join(dir, ".env");
    assert.equal(statSync(env).mode & 0o777, 0o600);
    const text = readFileSync(env, "utf8");
    const werte = parseEnv(text);
    assert.equal(werte.ANTHROPIC_API_KEY, KEY);
    assert.equal(werte.TELEGRAM_BOT_TOKEN, TOKEN);
    assert.equal(werte.TELEGRAM_CHAT_ID, "12345");
    assert.equal(werte.JARVIS_PIN, "9876");
    assert.equal(werte.NAME, "Labinot");
    assert.equal(werte.PORT, "3000");
    assert.equal(werte.ZIELCHECK, "so 18:00");
    assert.match(werte.JARVIS_EVENT_TOKEN ?? "", /^[0-9a-f]{48}$/);
    assert.match(werte.JARVIS_PANIC_TOKEN ?? "", /^[0-9a-f]{48}$/);
    assert.notEqual(werte.JARVIS_EVENT_TOKEN, werte.JARVIS_PANIC_TOKEN);
    assert.ok(text.startsWith("# --- JARVIS: Konfiguration ---"), "Kommentare erhalten");
    assert.ok(text.includes("# --- Etappe 7: Kameras ---"));
    assert.ok(/Chat-ID ist eine Zahl/.test(lauf.out), "ungültige Chat-ID gemeldet");
    assert.ok(lauf.out.includes(`Erzeugt: ${werte.JARVIS_EVENT_TOKEN}`), "erzeugter Token einmal angezeigt");
    assert.ok(!lauf.out.includes(KEY) && !lauf.out.includes(TOKEN) && !lauf.out.includes("9876"), "Geheimnisse nicht in der Konsole");
    assert.ok(existsSync(join(dir, "data")) && (statSync(join(dir, "data")).mode & 0o777) === 0o700);
    assert.ok(existsSync(join(dir, "workspace")) && (statSync(join(dir, "workspace")).mode & 0o777) === 0o700);
    assert.ok(!existsSync(`${env}.bak`), "erster Lauf: keine Sicherung");
    assert.ok(!existsSync(`${env}.tmp`));

    // zweiter Lauf: nur Enter → Werte bleiben, Sicherung entsteht
    const zweiter = await fahre(dir, Array(80).fill(""));
    assert.equal(zweiter.code, 0, zweiter.out + zweiter.err);
    assert.ok(/Bestehende \.env gefunden: \d+ Wert/.test(zweiter.out));
    const werte2 = parseEnv(readFileSync(env, "utf8"));
    assert.deepEqual(werte2, werte);
    assert.ok(existsSync(`${env}.bak`));
    assert.equal(statSync(`${env}.bak`).mode & 0o777, 0o600);
    assert.deepEqual(parseEnv(readFileSync(`${env}.bak`, "utf8")), werte);
    assert.ok(zweiter.out.includes(".env.bak"), "Hinweis auf Sicherung");
    assert.ok(!zweiter.out.includes(werte.JARVIS_EVENT_TOKEN ?? "?"), "bestehender Token nur maskiert");
  });

  it("--abschnitt ändert nur einen Abschnitt, «-» leert", async () => {
    const dir = neuesVerzeichnis();
    const erster = await fahre(dir, ersteAntworten());
    assert.equal(erster.code, 0, erster.out + erster.err);
    const lauf = await fahre(dir, ["", "", "-", "4321", ""], ["--abschnitt", "grundlagen"]);
    assert.equal(lauf.code, 0, lauf.out + lauf.err);
    const werte = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
    assert.equal(werte.JARVIS_FORM, "");
    assert.equal(werte.PORT, "4321");
    assert.equal(werte.TELEGRAM_CHAT_ID, "12345", "andere Abschnitte unberührt");
    assert.ok(!lauf.out.includes("── Telegram ──"));
  });

  it("Eingabe endet vorzeitig: Exit 1, kein Stacktrace, nur fertige Abschnitte geschrieben", async () => {
    const dir = neuesVerzeichnis();
    const lauf = await fahre(dir, ["Labinot", "", "", "", "", KEY]);
    assert.equal(lauf.code, 1);
    assert.ok(!/\n\s+at /.test(lauf.out + lauf.err), "kein Stacktrace");
    const werte = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
    assert.equal(werte.NAME, "Labinot");
    assert.equal(werte.ANTHROPIC_API_KEY, "", "halber Abschnitt nicht geschrieben");
  });

  it("Strg-C (SIGINT): Exit 1, kein Stacktrace", async () => {
    const dir = neuesVerzeichnis();
    const lauf = await fahre(dir, [], [], true);
    assert.equal(lauf.code, 1, `code=${lauf.code} signal=${lauf.signal}`);
    assert.equal(lauf.signal, null);
    assert.ok(lauf.out.includes("Abgebrochen"));
    assert.ok(!/\n\s+at /.test(lauf.out + lauf.err), "kein Stacktrace");
  });

  it("--hilfe und unbekannte Option", async () => {
    const dir = neuesVerzeichnis();
    const h = await fahre(dir, [], ["--hilfe"]);
    assert.equal(h.code, 0);
    assert.ok(h.out.includes("--abschnitt"));
    const u = await fahre(dir, [], ["--quatsch"]);
    assert.equal(u.code, 1);
    assert.ok(u.out.includes("Unbekannte Option"));
  });
});
