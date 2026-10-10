import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { parseEnv as nodeParseEnv } from "node:util";
import type { Feld, FeldArt } from "../src/setup.js"; // nur Typen: kein Import vor dem chdir

const projekt = resolve(import.meta.dirname, "..");
const temp: string[] = [];
const neuesTemp = (name: string) => { const d = mkdtempSync(join(tmpdir(), name)); temp.push(d); return d; };
process.chdir(neuesTemp("jarvis-setup-"));
after(() => { process.chdir(projekt); for (const d of temp) rmSync(d, { recursive: true, force: true }); });

const s = await import("../src/setup.js");

/** Knifflige Werte, die exakt wieder herauskommen müssen */
const knifflig: Record<string, string> = {
  LEER: "",
  EINFACH: "abc",
  LEERZEICHEN: "hallo welt",
  RAUTE: "a#b",
  DOPPELT: 'sag "hallo"',
  EINFACH_ANF: "it's",
  BACKSLASH: "C:\\neu\\dir",
  BACKSLASH_N: "a\\nb",
  GLEICH: "a=b=c",
  DOLLAR: "$HOME und ${X}",
  UMLAUT: "Grüezi Zürich äöü",
  FUEHREND: "  vorne",
  NACH: "hinten  ",
  BEIDE_ANF: "a\"b'c",
  ANF_BACKSLASH: "a'b\\c",
  BACKTICK: "a`b",
  ZEILENUMBRUCH: "zeile1\nzeile2",
  URL: "https://x.ch/a?b=1&c=2",
};

describe("quoteWert / parseEnv / serialisiereEnv", () => {
  it("Roundtrip mit eigenem Parser und util.parseEnv", () => {
    const zeilen: import("../src/setup.js").EnvZeile[] = [{ art: "kommentar", text: "# Test" }];
    for (const [key, wert] of Object.entries(knifflig)) zeilen.push({ art: "wert", key, wert });
    const text = s.serialisiereEnv(zeilen);
    const eigen = Object.fromEntries(s.parseEnv(text).filter((z) => z.art === "wert").map((z) => [(z as { key: string }).key, (z as { wert: string }).wert]));
    assert.deepEqual(eigen, knifflig);
    assert.deepEqual(nodeParseEnv(text), knifflig);
  });

  it("quoteWert: leer, roh, gequotet", () => {
    assert.equal(s.quoteWert(""), "");
    assert.equal(s.quoteWert("abc"), "abc");
    assert.equal(s.quoteWert("a=b"), "a=b");
    assert.equal(s.quoteWert("a b"), '"a b"');
    assert.equal(s.quoteWert("a#b"), '"a#b"');
    assert.equal(s.quoteWert('a"b'), "'a\"b'");
    assert.equal(s.quoteWert("a\\b"), "'a\\b'");
    assert.equal(s.quoteWert("a\"b'c"), "`a\"b'c`");
    assert.equal(s.quoteWert("x\ny"), '"x\\ny"');
    assert.throws(() => s.quoteWert("a\"b'c`d"), /nicht darstellbar/);
  });

  it("parseEnv liest wie Node: export, Kommentare, Anführungszeichen, mehrzeilig", () => {
    const text = [
      "# Kopf",
      "",
      "export A=1",
      "B=abc # Kommentar",
      "C=\"a#b\" # Kommentar",
      "D='it\"s'",
      "E=`x'y`",
      "F=\"zeile1\\nzeile2\"",
      "G='mehr",
      "zeilig'",
      "H=  leer  ",
      "I=",
      "kein gleichheitszeichen",
      "=abc",
    ].join("\n");
    const z = s.parseEnv(text);
    assert.deepEqual(z[0], { art: "kommentar", text: "# Kopf" });
    assert.deepEqual(z[1], { art: "leer", text: "" });
    assert.deepEqual(z[2], { art: "wert", key: "A", wert: "1" });
    assert.deepEqual(z[3], { art: "wert", key: "B", wert: "abc" });
    assert.deepEqual(z[4], { art: "wert", key: "C", wert: "a#b" });
    assert.deepEqual(z[5], { art: "wert", key: "D", wert: 'it"s' });
    assert.deepEqual(z[6], { art: "wert", key: "E", wert: "x'y" });
    assert.deepEqual(z[7], { art: "wert", key: "F", wert: "zeile1\nzeile2" });
    assert.deepEqual(z[8], { art: "wert", key: "G", wert: "mehr\nzeilig" });
    assert.deepEqual(z[9], { art: "wert", key: "H", wert: "leer" });
    assert.deepEqual(z[10], { art: "wert", key: "I", wert: "" });
    assert.deepEqual(z[11], { art: "kommentar", text: "kein gleichheitszeichen" });
    // ohne Schlüssel: Node ignoriert die Zeile, hier bleibt sie als Text erhalten
    assert.deepEqual(z[12], { art: "kommentar", text: "=abc" });
    assert.equal(z.length, 13);
    assert.deepEqual(nodeParseEnv("=abc\n"), {});
    // Werte stimmen mit Node überein
    const eigen = Object.fromEntries(z.filter((x) => x.art === "wert").map((x) => [(x as { key: string }).key, (x as { wert: string }).wert]));
    assert.deepEqual(eigen, nodeParseEnv(text));
  });

  it("offenes Anführungszeichen verschluckt keine Folgezeilen (wie Node)", () => {
    // kein schliessendes Zeichen bis Dateiende: nur diese Zeile wörtlich, die weiteren Schlüssel bleiben eigene Einträge
    const text = 'A="x\nB=y\n';
    const z = s.parseEnv(text);
    assert.deepEqual(z, [
      { art: "wert", key: "A", wert: '"x' },
      { art: "wert", key: "B", wert: "y" },
    ]);
    assert.deepEqual(Object.fromEntries(z.map((x) => [(x as { key: string }).key, (x as { wert: string }).wert])), nodeParseEnv(text));
    // Tippfehler mitten in der Datei: nachfolgende Geheimnisse landen nicht im kaputten Wert
    const tipp = "TTS_VOICE=\"onyx\nTTS_MODEL=tts-1\nJARVIS_EVENT_TOKEN=abc\nMQTT_PASSWORD=geheim\n";
    const t = s.parseEnv(tipp);
    assert.equal(t.length, 4);
    assert.deepEqual(t[0], { art: "wert", key: "TTS_VOICE", wert: '"onyx' });
    assert.deepEqual(t[3], { art: "wert", key: "MQTT_PASSWORD", wert: "geheim" });
    assert.deepEqual(Object.fromEntries(t.map((x) => [(x as { key: string }).key, (x as { wert: string }).wert])), nodeParseEnv(tipp));
    // schliessendes Zeichen in einer späteren Zeile: mehrzeilig bleibt möglich, wie Node
    const mehr = "A=\"x\nB=y\"\nC=z\n";
    const m = s.parseEnv(mehr);
    assert.deepEqual(m, [
      { art: "wert", key: "A", wert: "x\nB=y" },
      { art: "wert", key: "C", wert: "z" },
    ]);
    assert.deepEqual(Object.fromEntries(m.map((x) => [(x as { key: string }).key, (x as { wert: string }).wert])), nodeParseEnv(mehr));
    // weitere Formen, jeweils Wertemenge wie Node: offenes ", offenes ' über mehrere Zeilen, offenes " mit #
    for (const fall of ['A="ohne ende\nB=2\n', "A='ohne\nB=2\nC=x\n", 'A="x #y\nB=2\n']) {
      const w = s.parseEnv(fall).filter((x) => x.art === "wert");
      assert.deepEqual(Object.fromEntries(w.map((x) => [(x as { key: string }).key, (x as { wert: string }).wert])), nodeParseEnv(fall), fall);
    }
  });

  it("Kommentare und Reihenfolge bleiben erhalten", () => {
    const text = "# oben\nA=1\n\n# mitte\nB=\"x y\"\n";
    assert.equal(s.serialisiereEnv(s.parseEnv(text)), text);
  });
});

describe("ladeEnv / setzeWert / holeWert", () => {
  it("ohne .env: Struktur und Werte aus der Vorlage", () => {
    const dir = neuesTemp("jarvis-lade-");
    const z = s.ladeEnv(join(projekt, ".env.example"), join(dir, ".env"));
    assert.equal(s.holeWert(z, "PORT"), "3000");
    assert.equal(s.holeWert(z, "ANTHROPIC_API_KEY"), "");
    assert.equal(s.holeWert(z, "GIBTSNICHT"), undefined);
  });

  it("mit .env: bestehende Werte gewinnen, eigene Einträge bleiben", () => {
    const dir = neuesTemp("jarvis-lade-");
    const env = join(dir, ".env");
    writeFileSync(env, "PORT=4000\nMEIN_EIGENER=ja\nTELEGRAM_CHAT_ID=12345\n");
    const z = s.ladeEnv(join(projekt, ".env.example"), env);
    assert.equal(s.holeWert(z, "PORT"), "4000");
    assert.equal(s.holeWert(z, "TELEGRAM_CHAT_ID"), "12345");
    assert.equal(s.holeWert(z, "NAME"), "Labinot");
    assert.equal(s.holeWert(z, "MEIN_EIGENER"), "ja");
    const text = s.serialisiereEnv(z);
    assert.ok(text.includes("# --- Eigene Einträge ---\nMEIN_EIGENER=ja"));
    assert.ok(text.startsWith("# --- JARVIS: Konfiguration ---"));
    // Reihenfolge der Vorlage bleibt: NAME vor PORT vor TELEGRAM_CHAT_ID
    assert.ok(text.indexOf("NAME=") < text.indexOf("PORT=") && text.indexOf("PORT=") < text.indexOf("TELEGRAM_CHAT_ID="));
  });

  it("mit .env: Werte nach einer Zeile mit offenem Anführungszeichen bleiben erhalten", () => {
    const dir = neuesTemp("jarvis-lade-");
    const env = join(dir, ".env");
    writeFileSync(env, 'JARVIS_PIN="abc\nTELEGRAM_CHAT_ID=12345\nHA_URL=http://x\n');
    const z = s.ladeEnv(join(projekt, ".env.example"), env);
    assert.equal(s.holeWert(z, "JARVIS_PIN"), '"abc');
    assert.equal(s.holeWert(z, "TELEGRAM_CHAT_ID"), "12345");
    assert.equal(s.holeWert(z, "HA_URL"), "http://x");
  });

  it("setzeWert hängt fehlende Schlüssel an", () => {
    const z = s.parseEnv("A=1\n");
    s.setzeWert(z, "A", "2");
    s.setzeWert(z, "B", "3");
    assert.equal(s.serialisiereEnv(z), "A=2\nB=3\n");
  });
});

describe("schreibeEnv", () => {
  it("Rechte 0o600, .bak beim zweiten Schreiben, atomar", () => {
    const dir = neuesTemp("jarvis-schreib-");
    const pfad = join(dir, ".env");
    const z = s.parseEnv("A=1\n");
    assert.deepEqual(s.schreibeEnv(pfad, z), {});
    assert.equal(statSync(pfad).mode & 0o777, 0o600);
    assert.equal(readFileSync(pfad, "utf8"), "A=1\n");
    s.setzeWert(z, "A", "2");
    const r = s.schreibeEnv(pfad, z);
    assert.equal(r.sicherung, `${pfad}.bak`);
    assert.equal(readFileSync(r.sicherung!, "utf8"), "A=1\n");
    assert.equal(statSync(r.sicherung!).mode & 0o777, 0o600);
    assert.equal(readFileSync(pfad, "utf8"), "A=2\n");
    s.setzeWert(z, "A", "3");
    assert.deepEqual(s.schreibeEnv(pfad, z, { ohneSicherung: true }), {});
    assert.equal(readFileSync(`${pfad}.bak`, "utf8"), "A=1\n", "Sicherung bleibt mit ohneSicherung unangetastet");
    assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp")), "keine .tmp-Datei übrig");
  });
});

describe("erzeugeToken / maskiere", () => {
  it("48 Hex-Zeichen, zwei Aufrufe verschieden", () => {
    const a = s.erzeugeToken();
    const b = s.erzeugeToken();
    assert.match(a, /^[0-9a-f]{48}$/);
    assert.notEqual(a, b);
    assert.match(s.erzeugeToken(8), /^[0-9a-f]{16}$/);
  });

  it("maskiere", () => {
    assert.equal(s.maskiere(""), "••••");
    assert.equal(s.maskiere("12345678"), "••••");
    assert.equal(s.maskiere("123456789"), "••••");
    assert.equal(s.maskiere("123456789012"), "••••");
    assert.equal(s.maskiere("1234567890123"), "1234…23");
    assert.equal(s.maskiere("sk-ant-geheimerSchluessel"), "sk-a…el");
  });
});

describe("Prüffunktionen", () => {
  const ok = (f: (w: string) => string | undefined, ...w: string[]) => w.forEach((x) => assert.equal(f(x), undefined, `gültig erwartet: ${x}`));
  const nok = (f: (w: string) => string | undefined, ...w: string[]) => w.forEach((x) => assert.equal(typeof f(x), "string", `ungültig erwartet: ${x}`));

  it("pruefeApiKey", () => { ok(s.pruefeApiKey, "sk-ant-api03-abcdefghijklmnop"); nok(s.pruefeApiKey, "sk-ant-kurz", "abc-ant-api03-abcdefghijklmnop", ""); });
  it("pruefeTelegramToken", () => { ok(s.pruefeTelegramToken, "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789"); nok(s.pruefeTelegramToken, "12345:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789", "123456789:kurz", "abc"); });
  it("pruefeChatId", () => { ok(s.pruefeChatId, "12345", "-1001234567890"); nok(s.pruefeChatId, "abc", "1234", "12a45"); });
  it("pruefePin", () => { ok(s.pruefePin, "1234", "ab cd".replace(" ", "")); nok(s.pruefePin, "123", "12 34", "ab\tcd"); });
  it("pruefeUrl", () => { ok(s.pruefeUrl, "http://192.168.1.10:8123", "https://x.ch/pfad"); nok(s.pruefeUrl, "192.168.1.10", "ftp://x", "mqtt://x:1883", ""); });
  it("pruefeZeit", () => { ok(s.pruefeZeit, "00:00", "23:59", "05:45", "off"); nok(s.pruefeZeit, "24:00", "7:30", "12:60", "on", ""); });
  it("pruefeUhrzeit (kein off)", () => { ok(s.pruefeUhrzeit, "00:00", "23:59", "05:45"); nok(s.pruefeUhrzeit, "off", "24:00", "7:30", "12:60", ""); });
  it("BRIEFING_PREP_FROM kennt kein off, die Zeitpläne schon", () => {
    const feld = (key: string) => s.ABSCHNITTE.flatMap((a) => a.felder).find((f) => f.key === key)!;
    assert.equal(feld("BRIEFING_PREP_FROM").pruefen, s.pruefeUhrzeit);
    assert.equal(typeof s.entscheideWert("off", undefined, feld("BRIEFING_PREP_FROM")).fehler, "string");
    for (const key of ["RUECKBLICK", "RECHNUNG_ERINNERUNG", "ZIELCHECK"]) assert.deepEqual(s.entscheideWert("off", undefined, feld(key)), { wert: "off" });
  });
  it("pruefeZielcheck", () => { ok(s.pruefeZielcheck, "so 18:00", "mo 06:30", "off"); nok(s.pruefeZielcheck, "sonntag 18:00", "so 24:00", "so", "18:00"); });
  it("pruefeZahl", () => { ok(s.pruefeZahl, "0", "10", "6500"); nok(s.pruefeZahl, "-1", "1.5", "abc", ""); });
  it("pruefePort", () => { ok(s.pruefePort, "1", "3000", "65535"); nok(s.pruefePort, "0", "65536", "abc", "-3"); });
  it("pruefeKoordinate", () => { const lat = s.pruefeKoordinate(-90, 90); ok(lat, "47.52", "-90", "0", "90"); nok(lat, "91", "-90.5", "abc", "47,52"); });
  it("pruefeModell", () => { ok(s.pruefeModell, "claude-sonnet-5-5"); nok(s.pruefeModell, "gpt-4", "sonnet"); });
  it("pruefeHost", () => { ok(s.pruefeHost, "127.0.0.1", "0.0.0.0", "192.168.1.5"); nok(s.pruefeHost, "localhost", "256.0.0.1", "1.2.3", "::1"); });
  it("pruefeWahl", () => { const w = s.pruefeWahl(["on", "off"]); ok(w, "on", "off"); nok(w, "ON", "ja", ""); });
  it("pruefeSkillId", () => { ok(s.pruefeSkillId, "amzn1.ask.skill.1234-abcd"); nok(s.pruefeSkillId, "1234-abcd", "amzn1.ask.1234"); });
  it("pruefeShop", () => { ok(s.pruefeShop, "mein-shop", "mein-shop.myshopify.com"); nok(s.pruefeShop, "https://mein-shop.myshopify.com", "Mein Shop", "shop.example.com"); });
  it("pruefeArbeitsordner", () => {
    ok(s.pruefeArbeitsordner, "workspace", "/home/pi/jarvis/workspace", join(homedir(), "jarvis", "workspace"));
    nok(s.pruefeArbeitsordner, "/tmp", "/tmp/", "/", "/home", "/usr", "/etc", "/var", homedir(), homedir() + "/", "/tmp/../tmp");
    assert.equal(s.pruefeArbeitsordner("/tmp"), "Systemordner oder Home-Verzeichnis sind als Arbeitsordner nicht erlaubt");
  });
});

describe("entscheideWert", () => {
  const feld = (extra: Partial<import("../src/setup.js").Feld> = {}): import("../src/setup.js").Feld => ({ key: "X", frage: "x", art: "text", ...extra });

  it("Enter behält bestehenden Wert, sonst Standard, sonst leer", () => {
    assert.deepEqual(s.entscheideWert("", "alt", feld({ standard: "std" })), { wert: "alt" });
    assert.deepEqual(s.entscheideWert("  ", undefined, feld({ standard: "std" })), { wert: "std" });
    assert.deepEqual(s.entscheideWert("", "", feld()), { wert: "" });
  });

  it("«-» leert, bei Pflicht Fehler", () => {
    assert.deepEqual(s.entscheideWert("-", "alt", feld()), { wert: "" });
    assert.match(s.entscheideWert("-", "alt", feld({ pflicht: true })).fehler ?? "", /Pflicht/);
    assert.match(s.entscheideWert("", undefined, feld({ pflicht: true })).fehler ?? "", /Pflicht/);
  });

  it("Eingabe wird geprüft und getrimmt", () => {
    assert.deepEqual(s.entscheideWert(" 12345 ", undefined, feld({ pruefen: s.pruefeChatId })), { wert: "12345" });
    assert.equal(typeof s.entscheideWert("abc", undefined, feld({ pruefen: s.pruefeChatId })).fehler, "string");
  });

  it("Erzeugen bei leerem Token-Feld, bestehender Token bleibt", () => {
    const e = s.entscheideWert("", undefined, feld({ art: "token", erzeugen: true }));
    assert.equal(e.erzeugt, true);
    assert.match(e.wert ?? "", /^[0-9a-f]{48}$/);
    assert.deepEqual(s.entscheideWert("", "bestehend-token", feld({ art: "token", erzeugen: true })), { wert: "bestehend-token" });
    assert.deepEqual(s.entscheideWert("-", "bestehend-token", feld({ art: "token", erzeugen: true })), { wert: "" });
  });
});

describe("Schema ↔ .env.example", () => {
  const beispiel = s.parseEnv(readFileSync(join(projekt, ".env.example"), "utf8")).filter((z) => z.art === "wert") as { key: string; wert: string }[];

  it("jeder Schlüssel genau einmal, in beide Richtungen", () => {
    const schema = s.alleSchluessel();
    assert.deepEqual([...schema].sort(), [...new Set(schema)].sort(), "Schlüssel im Schema doppelt");
    const inBeispiel = beispiel.map((z) => z.key);
    assert.deepEqual([...inBeispiel].sort(), [...new Set(inBeispiel)].sort(), "Schlüssel in .env.example doppelt");
    assert.deepEqual([...schema].sort(), [...inBeispiel].sort());
  });

  it("Standardwerte identisch mit .env.example", () => {
    for (const a of s.ABSCHNITTE) {
      for (const f of a.felder) {
        const b = beispiel.find((z) => z.key === f.key)!;
        assert.equal(f.standard ?? "", b.wert, `Standard von ${f.key}`);
      }
    }
  });

  it("Pflicht nur bei den vier Grundwerten, Abschnittsnamen eindeutig, Checks bekannt", () => {
    const pflicht = s.ABSCHNITTE.flatMap((a) => a.felder.filter((f) => f.pflicht).map((f) => f.key)).sort();
    assert.deepEqual(pflicht, ["ANTHROPIC_API_KEY", "JARVIS_PIN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
    const namen = s.ABSCHNITTE.map((a) => a.name);
    assert.deepEqual([...namen].sort(), [...new Set(namen)].sort());
    assert.ok(namen.every((n) => /^[a-z]+$/.test(n)));
    const bekannt = ["Claude-API", "Telegram", "WHOOP", "Google Kalender", "Outlook-Kalender", "Gmail", "Home Assistant", "Frigate", "MQTT", "Shopify", "Browser", "Werkstatt", "3D-Drucker", "Stimme (STT/TTS)", "Alexa-Skill", "Protokolle", "Sicherheit"];
    for (const a of s.ABSCHNITTE) for (const c of a.checks ?? []) assert.ok(bekannt.includes(c), `unbekannter Check ${c} in ${a.name}`);
    for (const a of s.ABSCHNITTE) for (const f of a.felder) if (f.art === "wahl") assert.ok(f.wahl?.length && f.pruefen, `wahl ohne Liste/Prüfung: ${f.key}`);
    const felder = s.ABSCHNITTE.flatMap((a) => a.felder);
    assert.equal(felder.find((f) => f.key === "JARVIS_WORKSPACE")?.pruefen, s.pruefeArbeitsordner, "Arbeitsordner wird geprüft");
    assert.equal(felder.find((f) => f.key === "MQTT_URL")?.ohneEcho, true, "MQTT_URL ohne Echo (kann user:pass enthalten)");
    assert.deepEqual(felder.filter((f) => f.ohneEcho).map((f) => f.key), ["MQTT_URL"]);
  });

  it("Hinweis der erzeugbaren Tokens stimmt in beiden Zuständen (Enter behält, sonst erzeugt)", () => {
    const felder = s.ABSCHNITTE.flatMap((a) => a.felder).filter((f) => f.erzeugen);
    assert.deepEqual(felder.map((f) => f.key), ["JARVIS_EVENT_TOKEN", "JARVIS_PANIC_TOKEN"]);
    for (const f of felder) {
      assert.equal(f.art, "token");
      assert.match(f.hinweis ?? "", /behalten/, `${f.key}: Hinweis muss sagen, dass Enter einen bestehenden Token behält`);
      assert.match(f.hinweis ?? "", /erzeugen/, `${f.key}: Hinweis nennt das Erzeugen`);
      assert.match(f.hinweis ?? "", /«-»/, `${f.key}: Hinweis nennt das Leeren`);
      assert.doesNotMatch(f.hinweis ?? "", /^Enter = erzeugen/, `${f.key}: Enter erzeugt nur ohne bestehenden Wert`);
    }
  });

  it("Geheimnisse haben art geheim oder token (maskiert, ohne Echo)", () => {
    const felder = s.ABSCHNITTE.flatMap((a) => a.felder);
    // Capability-URL: wer den Link kennt, liest den Kalender ohne Anmeldung
    const outlook = felder.find((f) => f.key === "OUTLOOK_ICS_URL")!;
    assert.equal(outlook.art, "geheim");
    assert.equal(outlook.pruefen, s.pruefeUrl, "URL-Prüfung bleibt");
    assert.equal(outlook.pruefen?.("https://outlook.office365.com/owa/calendar/x/y/calendar.ics"), undefined);
    assert.ok(outlook.pruefen?.("kein-link"));
    // Namenskonvention: alles, was wie ein Zugangsgeheimnis heisst, ist geheim/token
    for (const f of felder) {
      if (/(_TOKEN|_SECRET|_KEY|_PASSWORD|_PIN)$/.test(f.key)) assert.ok(f.art === "geheim" || f.art === "token", `${f.key} ist ${f.art}, nicht geheim/token`);
    }
  });
});

describe("anzeigeBestehend", () => {
  const feld = (art: FeldArt): Feld => ({ key: "X", frage: "x", art });

  it("leer → undefined", () => {
    assert.equal(s.anzeigeBestehend(feld("text"), undefined), undefined);
    assert.equal(s.anzeigeBestehend(feld("geheim"), ""), undefined);
  });

  it("geheim und token nur maskiert", () => {
    const geheim = "https://outlook.office365.com/owa/calendar/geheimeKennung/calendar.ics";
    const anzeige = s.anzeigeBestehend(feld("geheim"), geheim)!;
    assert.equal(anzeige, s.maskiere(geheim));
    assert.ok(!anzeige.includes("geheimeKennung"));
    assert.equal(s.anzeigeBestehend(feld("token"), "0123456789abcdef"), "0123…ef");
  });

  it("URL mit Passwort maskiert, ohne Passwort unverändert", () => {
    const mitPasswort = "mqtt://frigate:streng-geheim@192.168.1.10:1883";
    const anzeige = s.anzeigeBestehend(feld("url"), mitPasswort)!;
    assert.equal(anzeige, s.maskiere(mitPasswort));
    assert.ok(!anzeige.includes("streng-geheim"));
    assert.equal(s.anzeigeBestehend(feld("url"), "mqtt://192.168.1.10:1883"), "mqtt://192.168.1.10:1883");
    assert.equal(s.anzeigeBestehend(feld("url"), "http://192.168.1.10:8123"), "http://192.168.1.10:8123");
    assert.equal(s.anzeigeBestehend(feld("url"), "mqtts://nurbenutzer@host"), "mqtts://nurbenutzer@host");
  });

  it("gewöhnliche Werte unverändert", () => {
    assert.equal(s.anzeigeBestehend(feld("text"), "Labinot"), "Labinot");
    assert.equal(s.anzeigeBestehend(feld("zahl"), "3000"), "3000");
    assert.equal(s.anzeigeBestehend(feld("pfad"), "service-account.json"), "service-account.json");
  });
});

describe("naechsteSchritte", () => {
  it("Hinweise je nach Stand", () => {
    const z = s.parseEnv("ANTHROPIC_API_KEY=sk-ant-x\nWHOOP_CLIENT_ID=w\nGOOGLE_OAUTH_CLIENT_ID=g\n");
    const alles = s.naechsteSchritte(z, {}, "/x/.env.bak");
    assert.ok(alles.some((t) => t.includes("whoop:auth")));
    assert.ok(alles.some((t) => t.includes("google:auth")));
    assert.ok(alles.some((t) => t.includes("systemctl restart jarvis")));
    assert.ok(alles.some((t) => t.includes("/x/.env.bak")));
    assert.ok(!alles.some((t) => t.includes("ANTHROPIC_API_KEY")));
    const verbunden = s.naechsteSchritte(z, { whoop: { refreshToken: "r" }, google: { refreshToken: "r" } });
    assert.ok(!verbunden.some((t) => t.includes("whoop:auth") || t.includes("google:auth") || t.includes(".bak")));
    const leer = s.naechsteSchritte(s.parseEnv("ANTHROPIC_API_KEY=\n"), {});
    assert.ok(leer.some((t) => t.includes("ANTHROPIC_API_KEY")));
    assert.ok(!existsSync("/x/.env.bak"));
  });
});

describe(".gitignore deckt Sicherung und Temp-Datei der .env ab", () => {
  const gitignore = join(projekt, ".gitignore");
  const eintraege = readFileSync(gitignore, "utf8").split("\n").map((z) => z.trim()).filter((z) => z && !z.startsWith("#"));
  const geheim = [".env", ".env.bak", ".env.tmp"]; // .env sowie das, was schreibeEnv daneben anlegt

  it("Einträge stehen wörtlich in .gitignore, .env.example nicht", () => {
    for (const name of geheim) assert.ok(eintraege.includes(name), `${name} fehlt in .gitignore`);
    assert.ok(!eintraege.includes(".env.example"), ".env.example darf nicht ignoriert werden");
  });

  it("git check-ignore bestätigt es (übersprungen ohne git oder Repository)", (t) => {
    const pruefe = (name: string) => spawnSync("git", ["check-ignore", "-q", "--no-index", name], { cwd: projekt, stdio: "ignore" });
    const probe = pruefe(".env");
    if (probe.error || probe.status === null || probe.status >= 128) { t.skip("git oder Repository nicht verfügbar"); return; }
    for (const name of geheim) assert.equal(pruefe(name).status, 0, `${name} wird von git nicht ignoriert`);
    assert.equal(pruefe(".env.example").status, 1, ".env.example darf nicht ignoriert werden");
  });
});
