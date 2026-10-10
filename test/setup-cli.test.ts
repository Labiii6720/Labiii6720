import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { parseEnv } from "node:util";

const projekt = resolve(import.meta.dirname, "..");
const skript = join(projekt, "scripts", "setup.ts");

interface Lauf { code: number | null; signal: NodeJS.Signals | null; out: string; err: string }

/** Fährt den Assistenten mit gepipten Antworten; keine Prüfungen, keine Netzaufrufe. */
function fahre(dir: string, antworten: string[], extra: string[] = [], sigint = false): Promise<Lauf> {
  return fahreRoh(dir, antworten, ["--ohne-pruefung", "--alle", "--env", join(dir, ".env"), ...extra], sigint);
}

/** Wie fahre, aber mit freier Argumentliste (Vorlage immer die Kopie im Temp-Verzeichnis). */
function fahreRoh(dir: string, antworten: string[], argumente: string[], sigint = false): Promise<Lauf> {
  return new Promise((fertig) => {
    const kind = spawn(process.execPath, ["--import", "tsx", skript, "--beispiel", join(dir, ".env.example"), ...argumente], {
      cwd: projekt, timeout: 60_000, env: { ...process.env, ANTHROPIC_API_KEY: "", TELEGRAM_BOT_TOKEN: "" },
    });
    let out = "";
    let err = "";
    kind.stdout.on("data", (c) => (out += c));
    kind.stderr.on("data", (c) => (err += c));
    kind.on("close", (code, signal) => fertig({ code, signal, out, err }));
    if (sigint) {
      // Signal erst, wenn die erste Frage steht: dann ist der SIGINT-Handler sicher installiert (auch auf langsamem Pi).
      let gesendet = false;
      const senden = (): void => { if (!gesendet) { gesendet = true; kind.kill("SIGINT"); } };
      const ersatz = setTimeout(senden, 20_000);
      kind.stdout.on("data", () => { if (out.includes("NAME – Ihr Name")) senden(); });
      kind.on("close", () => clearTimeout(ersatz));
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
const PIN = "zz99"; // bewusst mit Nicht-Hex-Zeichen: kein erzeugter Token kann diese Folge enthalten

/** Antworten erster Lauf: Pflichtwerte, Chat-ID zuerst ungültig, sonst Enter (63 Felder in Reihenfolge der Abschnitte) */
function ersteAntworten(): string[] {
  return [
    "Labinot", "", "", "", "", // grundlagen
    KEY, "", "", "", "", "", // claude
    TOKEN, "abc", "12345", // telegram: Chat-ID erst ungültig
    PIN, "", "", "", "", "", "", // sicherheit: PIN, zwei Tokens erzeugen
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
    assert.equal(werte.JARVIS_PIN, PIN);
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
    assert.ok(!lauf.out.includes(KEY) && !lauf.out.includes(TOKEN) && !lauf.out.includes(PIN), "Geheimnisse nicht in der Konsole");
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

  it("Bestehende .env: gezählt werden nur die Werte der Datei, nicht die Vorlage", async () => {
    const dir = neuesVerzeichnis();
    writeFileSync(join(dir, ".env"), "PORT=4000\n", { mode: 0o600 });
    const lauf = await fahre(dir, ["", "", "", "", ""], ["--abschnitt", "grundlagen"]);
    assert.equal(lauf.code, 0, lauf.out + lauf.err);
    assert.ok(lauf.out.includes("Bestehende .env gefunden: 1 Wert(e)"), lauf.out);
    assert.equal(parseEnv(readFileSync(join(dir, ".env"), "utf8")).PORT, "4000");
  });

  it("Pipe-Ende nach vollständigem Abschnitt: Exit 0, Vorlagen nur auf «j» kopiert", async () => {
    const dir = neuesVerzeichnis();
    for (const n of ["cameras.example.json", "protokolle.example.json"]) copyFileSync(join(projekt, n), join(dir, n));
    const sicherheit = ["1234", "", "", "", "", "", ""]; // genau die 7 Felder, keine Antwort übrig
    const lauf = await fahre(dir, sicherheit, ["--abschnitt", "sicherheit"]);
    assert.equal(lauf.code, 0, lauf.out + lauf.err);
    assert.ok(!lauf.out.includes("Eingabe beendet"), lauf.out);
    assert.ok(!existsSync(join(dir, "cameras.json")) && !existsSync(join(dir, "protokolle.json")), "EOF gilt als Nein");
    // mit «j» für cameras.json wird kopiert; die zweite Rückfrage endet wieder am Pipe-Ende
    const zweiter = await fahre(dir, [...sicherheit, "j"], ["--abschnitt", "sicherheit"]);
    assert.equal(zweiter.code, 0, zweiter.out + zweiter.err);
    assert.ok(existsSync(join(dir, "cameras.json")));
    assert.ok(!existsSync(join(dir, "protokolle.json")));
  });

  it("Prüfung im Kind liest die --env-Datei und findet den Arbeitsordner mit Rechten 700 vor", async () => {
    const dir = neuesVerzeichnis();
    const env = join(dir, "jarvis.env");
    // Abschnitt Sicherheit mit aktiver Prüfung: läuft ohne Netz (keine Dienste eingerichtet)
    const lauf = await fahreRoh(dir, ["1234", "", "", "", "", "", ""], ["--abschnitt", "sicherheit", "--env", env]);
    assert.equal(lauf.code, 0, lauf.out + lauf.err);
    assert.ok(lauf.out.includes("✅ Sicherheit"), lauf.out);
    assert.ok(!existsSync(join(dir, ".env")), "nur die angegebene Datei wird geschrieben");
    assert.equal(parseEnv(readFileSync(env, "utf8")).JARVIS_PIN, "1234");
    assert.ok(!lauf.out.includes("1234"), "PIN nicht in der Konsole");
    assert.equal(statSync(join(dir, "data")).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "workspace")).mode & 0o777, 0o700, "Arbeitsordner vor dem Kindprozess mit 700 angelegt");
  });

  it("Prüfung meldet Fehler, Rückfrage endet am Pipe-Ende: kein Abbruch, Exit 0", async () => {
    const dir = neuesVerzeichnis();
    const lauf = await fahreRoh(dir, ["1234", "", "", "auto", "", "", ""], ["--abschnitt", "sicherheit", "--env", join(dir, ".env")]);
    assert.equal(lauf.code, 0, lauf.out + lauf.err);
    assert.ok(lauf.out.includes("❌ Sicherheit"), lauf.out);
    assert.ok(lauf.out.includes("nochmals eingeben?"), lauf.out);
    assert.ok(!lauf.out.includes("Eingabe beendet"), lauf.out);
    assert.equal(parseEnv(readFileSync(join(dir, ".env"), "utf8")).JARVIS_COMMANDS, "auto", "Abschnitt bleibt gespeichert");
  });

  it("bestehender Arbeitsordner mit offenen Rechten wird auf 700 nachgezogen", async () => {
    const dir = neuesVerzeichnis();
    mkdirSync(join(dir, "workspace"), { mode: 0o755 });
    const lauf = await fahre(dir, ["", "", "", "", ""], ["--abschnitt", "grundlagen"]);
    assert.equal(lauf.code, 0, lauf.out + lauf.err);
    assert.equal(statSync(join(dir, "workspace")).mode & 0o777, 0o700);
    assert.ok(lauf.out.includes("Rechte auf 700 gesetzt"), lauf.out);
  });

  it("bestehender Arbeitsordner ausserhalb des Projekts behält seine Rechte, nur Hinweis", async () => {
    const dir = neuesVerzeichnis();
    const fremd = mkdtempSync(join(tmpdir(), "jarvis-fremd-"));
    temp.push(fremd);
    const ordner = join(fremd, "geteilt");
    mkdirSync(ordner);
    chmodSync(ordner, 0o755);
    writeFileSync(join(dir, ".env"), `JARVIS_WORKSPACE=${ordner}\n`, { mode: 0o600 });
    const lauf = await fahre(dir, ["", "", "", "", ""], ["--abschnitt", "grundlagen"]);
    assert.equal(lauf.code, 0, lauf.out + lauf.err);
    assert.equal(statSync(ordner).mode & 0o777, 0o755, "fremder Ordner unverändert");
    assert.ok(lauf.out.includes(`nicht angepasst`) && lauf.out.includes(`chmod 700 ${ordner}`), lauf.out);
    assert.ok(!lauf.out.includes("Rechte auf 700 gesetzt"), lauf.out);
    assert.equal(statSync(join(dir, "data")).mode & 0o777, 0o700, "data/ im Projekt weiterhin 700");
  });

  it("Symlink im Projekt auf fremden Ordner: Rechte des Linkziels bleiben, nur Hinweis", async () => {
    const dir = neuesVerzeichnis();
    const fremd = mkdtempSync(join(tmpdir(), "jarvis-fremd-"));
    temp.push(fremd);
    const ordner = join(fremd, "geteilt");
    mkdirSync(ordner);
    chmodSync(ordner, 0o755);
    symlinkSync(ordner, join(dir, "workspace")); // JARVIS_WORKSPACE bleibt «workspace» (relativ, im Projekt)
    const lauf = await fahre(dir, ["", "", "", "", ""], ["--abschnitt", "grundlagen"]);
    assert.equal(lauf.code, 0, lauf.out + lauf.err);
    assert.equal(statSync(ordner).mode & 0o777, 0o755, "Linkziel unverändert");
    assert.ok(lauf.out.includes("nicht angepasst") && lauf.out.includes("chmod 700 "), lauf.out);
    assert.ok(!lauf.out.includes("Rechte auf 700 gesetzt"), lauf.out);
    assert.equal(statSync(join(dir, "data")).mode & 0o777, 0o700, "data/ im Projekt weiterhin 700");
  });

  it("--env gleich --beispiel: Abbruch vor der ersten Frage, Vorlage unverändert", async () => {
    const dir = neuesVerzeichnis();
    const vorlage = join(dir, ".env.example");
    const vorher = readFileSync(vorlage, "utf8");
    const lauf = await fahreRoh(dir, ["Labinot", "", "", "", ""], ["--ohne-pruefung", "--abschnitt", "grundlagen", "--env", vorlage]);
    assert.equal(lauf.code, 1, lauf.out + lauf.err);
    assert.ok(lauf.out.includes("Ziel und Vorlage sind dieselbe Datei"), lauf.out);
    assert.ok(!lauf.out.includes("NAME – Ihr Name"), "keine Frage gestellt");
    assert.ok(!/\n\s+at /.test(lauf.out + lauf.err), "kein Stacktrace");
    assert.equal(readFileSync(vorlage, "utf8"), vorher, "Vorlage unverändert");
    assert.ok(!existsSync(`${vorlage}.bak`) && !existsSync(`${vorlage}.tmp`));
  });

  it("--env mit anderem Namen: Hinweis, dass .gitignore die Datei nicht erfasst", async () => {
    const dir = neuesVerzeichnis();
    const lauf = await fahre(dir, ["", "", "", "", ""], ["--abschnitt", "grundlagen", "--env", join(dir, "jarvis.env")]);
    assert.equal(lauf.code, 0, lauf.out + lauf.err);
    assert.ok(lauf.out.includes("jarvis.env und jarvis.env.bak sind nicht von .gitignore erfasst"), lauf.out);
    const standard = await fahre(dir, ["", "", "", "", ""], ["--abschnitt", "grundlagen"]);
    assert.ok(!standard.out.includes("nicht von .gitignore erfasst"), "bei .env kein Hinweis");
  });

  it("fehlender Zielordner von --env: klare Meldung vor der ersten Frage", async () => {
    const dir = neuesVerzeichnis();
    const ziel = join(dir, "gibtsnicht");
    const lauf = await fahre(dir, ["Labinot", "", "", "", ""], ["--abschnitt", "grundlagen", "--env", join(ziel, ".env")]);
    assert.equal(lauf.code, 1, lauf.out + lauf.err);
    assert.ok(lauf.out.includes(`Fehler: Zielordner fehlt: ${ziel}`), lauf.out);
    assert.ok(!lauf.out.includes("NAME – Ihr Name"), "keine Frage gestellt, Eingaben gehen nicht verloren");
    assert.ok(!lauf.out.includes(".env.tmp"), "keine interne Temp-Datei in der Meldung");
    assert.ok(!/\n\s+at /.test(lauf.out + lauf.err), "kein Stacktrace");
    assert.ok(!existsSync(ziel));
  });

  it("Strg-C während einer Prüfung beendet auch den Kindprozess", { skip: process.platform !== "linux" && "liest /proc" }, async () => {
    // Attrappe statt Home Assistant: nimmt Verbindungen an und antwortet nie, die Prüfung hinge 10 s
    const sockets = new Set<Socket>();
    const server = createServer((s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const dir = neuesVerzeichnis();
      const env = join(dir, ".env");
      const kennung = `--env-file=${env}`; // steht nur in der Befehlszeile des Prüf-Kindes
      const lebt = (): boolean => readdirSync("/proc").some((pid) => {
        if (!/^\d+$/.test(pid)) return false;
        try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(kennung); } catch { return false; }
      });
      const lauf = await new Promise<Lauf & { kindLief: boolean }>((fertig) => {
        const kind = spawn(process.execPath, ["--import", "tsx", skript, "--beispiel", join(dir, ".env.example"), "--abschnitt", "homeassistant", "--env", env], {
          cwd: projekt, timeout: 60_000, env: { ...process.env, ANTHROPIC_API_KEY: "", TELEGRAM_BOT_TOKEN: "" },
        });
        let out = "";
        let err = "";
        let kindLief = false;
        kind.stdout.on("data", (c) => (out += c));
        kind.stderr.on("data", (c) => (err += c));
        kind.on("close", (code, signal) => fertig({ code, signal, out, err, kindLief }));
        kind.stdin.write(["http://127.0.0.1:" + port, "token-attrappe", "", ""].map((a) => a + "\n").join("")); // Pipe offen lassen
        // Strg-C erst, wenn die Prüfung läuft (Verbindung zur Attrappe steht); Ersatz nach 20 s, damit nichts hängt
        const warten = setInterval(() => {
          if (sockets.size === 0) return;
          clearInterval(warten);
          clearTimeout(ersatz);
          kindLief = lebt();
          kind.kill("SIGINT");
        }, 50);
        const ersatz = setTimeout(() => { clearInterval(warten); kind.kill("SIGINT"); }, 20_000);
        kind.on("close", () => { clearInterval(warten); clearTimeout(ersatz); });
      });
      assert.equal(lauf.code, 1, `code=${lauf.code} signal=${lauf.signal}\n${lauf.out}${lauf.err}`);
      assert.ok(lauf.out.includes("Abgebrochen"), lauf.out);
      assert.ok(lauf.kindLief, "Prüfung lief, als Strg-C kam");
      // das Prüf-Kind muss kurz nach dem Assistenten verschwunden sein (ohne kill liefe es bis zum 10-s-Zeitlimit der Attrappe)
      const frist = Date.now() + 2000;
      while (lebt() && Date.now() < frist) await new Promise((r) => setTimeout(r, 50));
      assert.ok(!lebt(), "Kindprozess der Prüfung läuft nach Strg-C weiter");
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("MQTT_URL mit Passwort wird als bestehender Wert nur maskiert angezeigt", async () => {
    const dir = neuesVerzeichnis();
    const url = "mqtt://frigate:streng-geheim@192.168.1.10:1883";
    writeFileSync(join(dir, ".env"), `MQTT_URL=${url}\n`, { mode: 0o600 });
    const lauf = await fahre(dir, ["", "", "", ""], ["--abschnitt", "kameras"]);
    assert.equal(lauf.code, 0, lauf.out + lauf.err);
    assert.ok(lauf.out.includes("MQTT_URL – MQTT-URL [bestehend: mqtt…83]"), lauf.out);
    assert.ok(!lauf.out.includes("streng-geheim"), "Passwort nicht in der Konsole");
    assert.equal(parseEnv(readFileSync(join(dir, ".env"), "utf8")).MQTT_URL, url, "Enter behält den Wert");
  });

  it("nicht darstellbarer Bestandswert: Abbruch vor der ersten Frage, Schlüssel genannt, nichts geschrieben", async () => {
    const dir = neuesVerzeichnis();
    const env = join(dir, ".env");
    const wert = "a\"b'c`d"; // Node liest ihn roh; der Assistent kann ihn nicht zurückschreiben (alle drei Quote-Zeichen)
    const text = `PORT=4000\nEIGENER=${wert}\n`;
    writeFileSync(env, text, { mode: 0o600 });
    assert.equal(parseEnv(text).EIGENER, wert);
    const lauf = await fahre(dir, ["", "", "", "", ""], ["--abschnitt", "grundlagen"]);
    assert.equal(lauf.code, 1, lauf.out + lauf.err);
    assert.ok(lauf.out.includes(`Fehler: EIGENER in ${env}: `) && lauf.out.includes("nicht darstellbar"), lauf.out);
    assert.ok(!lauf.out.includes("NAME – Ihr Name"), "keine Frage gestellt, Eingaben gehen nicht verloren");
    assert.ok(!lauf.out.includes(wert), "Wert selbst nicht in der Konsole");
    assert.ok(!/\n\s+at /.test(lauf.out + lauf.err), "kein Stacktrace");
    assert.equal(readFileSync(env, "utf8"), text, "Datei unverändert");
    assert.ok(!existsSync(`${env}.bak`) && !existsSync(`${env}.tmp`));
  });

  it("Selbsttest am Ende liefert Befunde, auch wenn mehrere Dienste hängen", async () => {
    // Attrappe statt Home Assistant und Frigate: nimmt Verbindungen an und antwortet nie (je 10 s Zeitlimit im Selbsttest)
    const sockets = new Set<Socket>();
    const server = createServer((s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const dir = neuesVerzeichnis();
      const env = join(dir, ".env");
      writeFileSync(env, `HA_URL=http://127.0.0.1:${port}\nHA_TOKEN=token-attrappe\nFRIGATE_URL=http://127.0.0.1:${port}\n`, { mode: 0o600 });
      // Abschnitt ohne eigene Prüfung: nur der Abschluss-Selbsttest läuft
      const lauf = await fahreRoh(dir, ["", "", "", "", ""], ["--abschnitt", "proaktiv", "--env", env]);
      assert.equal(lauf.code, 0, lauf.out + lauf.err);
      const selbsttest = lauf.out.slice(lauf.out.indexOf("── Selbsttest ──"));
      assert.ok(selbsttest.includes("❌ Home Assistant"), selbsttest);
      assert.ok(selbsttest.includes("❌ Frigate"), selbsttest);
      assert.ok(!selbsttest.includes("Prüfung abgebrochen"), selbsttest);
      assert.ok(/\d+ ok · \d+ nicht eingerichtet · \d+ Fehler/.test(selbsttest), "Zusammenfassung vorhanden");
      assert.ok(!lauf.out.includes("token-attrappe"), "Token nicht in der Konsole");
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
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
