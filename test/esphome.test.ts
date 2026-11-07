import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { MAX_BYTES, RATE, TOENE, alsBytes, paketYaml, pcm, tonBytes } from "../esphome/tools/ton.mjs";

// Nur Dateien lesen und das Ton-Skript rechnen lassen: kein Netz, kein Schreiben im Projekt
const projekt = resolve(import.meta.dirname, "..");
const lies = (...teile: string[]) => readFileSync(join(projekt, ...teile), "utf8");
const ohneKommentare = (yaml: string) => yaml.split("\n").filter((z) => !/^\s*#/.test(z)).join("\n");

/** Abschnitt eines Top-Level-Schlüssels (bis zum nächsten Top-Level-Schlüssel). */
function abschnitt(yaml: string, schluessel: string): string {
  const zeilen = ohneKommentare(yaml).split("\n");
  const start = zeilen.findIndex((z) => z.startsWith(`${schluessel}:`));
  assert.ok(start >= 0, `Abschnitt ${schluessel} fehlt`);
  const ende = zeilen.findIndex((z, i) => i > start && /^[a-z_0-9]+:/.test(z));
  return zeilen.slice(start, ende < 0 ? undefined : ende).join("\n");
}

const nulldurchgaenge = (s: Int16Array) => s.reduce((n, wert, i) => (i > 0 && (s[i - 1] < 0) !== (wert < 0) ? n + 1 : n), 0);

describe("esphome/tools/ton.mjs – Bestätigungstöne", () => {
  it("120 ms je Ton, 16 kHz mono 16 bit: 3840 Bytes, zusammen unter 8 KB", () => {
    assert.equal(RATE, 16000);
    for (const art of ["wake", "fehler"] as const) {
      const ms = TOENE[art].reduce((summe, t) => summe + t.ms, 0);
      assert.equal(ms, 120, art);
      assert.equal(tonBytes(art).length, (120 * RATE * 2) / 1000, art);
    }
    assert.ok(tonBytes("wake").length + tonBytes("fehler").length <= MAX_BYTES);
    assert.ok(MAX_BYTES <= 8192);
  });

  it("Wertebereich: unter Vollaussteuerung, ohne Knacken an den Rändern, zwei Töne mit Pause", () => {
    for (const art of ["wake", "fehler"] as const) {
      const s = pcm(TOENE[art]);
      const spitze = s.reduce((m, w) => Math.max(m, Math.abs(w)), 0);
      assert.ok(spitze > 0.2 * 32767 && spitze <= Math.ceil(0.3 * 32767), `${art}: Spitze ${spitze}`);
      assert.equal(s[0], 0);
      assert.equal(s[s.length - 1], 0);
      // Pause zwischen den Tönen (10 ms nach 55 ms) ist still
      const pause = s.subarray(Math.round(0.055 * RATE), Math.round(0.065 * RATE));
      assert.ok(pause.length > 100 && pause.every((w) => w === 0), art);
    }
  });

  it("Fehlerton ist tiefer als der Wakeword-Ton, der Wakeword-Ton steigt an", () => {
    const wake = pcm(TOENE.wake);
    const fehler = pcm(TOENE.fehler);
    assert.ok(nulldurchgaenge(fehler) < nulldurchgaenge(wake) / 2);
    const haelfte = Math.round(0.06 * RATE);
    assert.ok(nulldurchgaenge(wake.subarray(haelfte)) > nulldurchgaenge(wake.subarray(0, haelfte)));
  });

  it("Bytes sind little-endian und im Bereich 0–255", () => {
    const b = alsBytes(Int16Array.from([1, -1, 32767, -32768]));
    assert.deepEqual(Array.from(b), [1, 0, 255, 255, 255, 127, 0, 128]);
    assert.ok(tonBytes("wake").every((x) => Number.isInteger(x) && x >= 0 && x <= 255));
    assert.throws(() => tonBytes("gibtsnicht" as "wake"), /unbekannter Ton/);
  });

  it("esphome/ton.yaml ist aktuell (gleich der Ausgabe des Skripts) und enthält dieselben Bytes", () => {
    const datei = lies("esphome", "ton.yaml");
    assert.equal(datei, paketYaml(), "neu erzeugen: node esphome/tools/ton.mjs --schreiben");
    const listen = [...datei.matchAll(/data: \[([\s\S]*?)\]/g)].map((m) => m[1].split(",").map((x) => Number(x.trim())));
    assert.equal(listen.length, 2);
    assert.deepEqual(listen[0], Array.from(tonBytes("wake")));
    assert.deepEqual(listen[1], Array.from(tonBytes("fehler")));
    assert.match(datei, /- id: ton_wake[\s\S]*speaker\.play:[\s\S]*- id: ton_fehler[\s\S]*speaker\.play:/);
  });

  it("Aufruf ohne Optionen gibt das YAML auf stdout aus und schreibt nichts", () => {
    const r = spawnSync(process.execPath, [join(projekt, "esphome", "tools", "ton.mjs")], { encoding: "utf8", timeout: 4000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, paketYaml());
  });
});

describe("ESPHome-Satelliten", () => {
  const basis = lies("esphome", "jarvis-satellit-basis.yaml");
  const erster = lies("esphome", "jarvis-satellit.yaml");
  const bad = lies("esphome", "jarvis-satellit-bad.yaml");

  it("beide Satelliten bestehen nur aus substitutions und packages (Basis per !include)", () => {
    for (const [datei, name, anzeige] of [[erster, "jarvis-satellit", "Jarvis Satellit"], [bad, "jarvis-satellit-bad", "Jarvis Satellit Bad"]] as const) {
      const oben = ohneKommentare(datei).split("\n").filter((z) => /^[a-z_0-9]+:/.test(z)).map((z) => z.split(":")[0]);
      assert.deepEqual(oben, ["substitutions", "packages"]);
      assert.match(datei, /^packages:\n {2}basis: !include jarvis-satellit-basis\.yaml$/m);
      assert.match(datei, new RegExp(`^ {2}name: ${name}$`, "m"));
      assert.match(datei, new RegExp(`^ {2}friendly_name: ${anzeige}$`, "m"));
    }
  });

  it("Basis: Name aus den Substitutionen, Ton-Paket eingebunden", () => {
    assert.match(basis, /^ {2}name: \$\{name\}$/m);
    assert.match(basis, /^ {2}friendly_name: \$\{friendly_name\}$/m);
    assert.match(abschnitt(basis, "packages"), /ton: !include ton\.yaml/);
  });

  it("Entitätsnamen des ersten Satelliten bleiben (Ring, Verbunden, Neustart)", () => {
    assert.match(abschnitt(basis, "light"), /name: Ring\n/);
    assert.match(abschnitt(basis, "binary_sensor"), /platform: status\n\s+name: Verbunden/);
    assert.match(abschnitt(basis, "button"), /platform: restart\n\s+name: Neustart/);
  });

  it("Lautstärke: number 0–100, Schritt 5, gespeichert, Start 60, setzt die Lautstärke", () => {
    const n = abschnitt(basis, "number");
    for (const muster of [/platform: template/, /name: Lautstärke/, /min_value: 0\n/, /max_value: 100\n/, /step: 5\n/, /restore_value: true/, /initial_value: 60\n/, /optimistic: true/, /set_action:[\s\S]*media_player\.volume_set:/]) {
      assert.match(n, muster);
    }
  });

  it("Nachtmodus und Ton-Feedback als gespeicherte Schalter; Nachtmodus setzt 30 und dimmt die LED", () => {
    const s = abschnitt(basis, "switch");
    assert.match(s, /name: Nachtmodus[\s\S]*?restore_mode: RESTORE_DEFAULT_OFF[\s\S]*?turn_on_action:[\s\S]*?value: 30\n/);
    assert.match(s, /name: Ton-Feedback[\s\S]*?restore_mode: RESTORE_DEFAULT_ON/);
    assert.match(abschnitt(basis, "voice_assistant"), /brightness: !lambda .*id\(nachtmodus\)\.state/);
  });

  it("Nachtmodus dimmt auch den Puls beim Zuhören; on_error beendet den Puls", () => {
    // Der Puls-Effekt setzt die Helligkeit bei jedem Takt selbst auf max_brightness (Standard 100 %)
    const l = abschnitt(basis, "light");
    assert.match(l, /- pulse:\n\s+name: pulse\n/);
    assert.match(l, /- pulse:\n\s+name: pulse_nacht\n(\s+[a-z_]+: .+\n)*?\s+max_brightness: \$\{nacht_helligkeit\}/);
    assert.match(abschnitt(basis, "substitutions"), /nacht_helligkeit: "0\.(0\d|1\d|2\d)"/);
    const va = abschnitt(basis, "voice_assistant");
    const zuhoeren = va.slice(va.indexOf("on_listening:"), va.indexOf("on_stt_end:"));
    assert.match(zuhoeren, /effect: !lambda 'return id\(nachtmodus\)\.state \? "pulse_nacht" : "pulse";'/);
    assert.ok(!/effect: pulse\s*$/m.test(zuhoeren), "kein fester Puls mit voller Helligkeit");
    const fehler = va.slice(va.indexOf("on_error:"));
    assert.match(fehler, /^ {4}- light\.turn_on:\n(?: {8}.*\n)*? {8}effect: none\n/m);
  });

  it("Nachtmodus wirkt nur bei echtem Wechsel: kein Überschreiben beim Start oder bei doppeltem Einschalten", () => {
    // ESPHome löst turn_on_action/turn_off_action beim Wiederherstellen und bei jedem turn_on aus
    assert.match(abschnitt(basis, "globals"), /- id: nacht_aktiv\n\s+type: bool\n\s+restore_value: true\n\s+initial_value: "false"/);
    const s = abschnitt(basis, "switch");
    const an = s.slice(s.indexOf("turn_on_action:"), s.indexOf("turn_off_action:"));
    const aus = s.slice(s.indexOf("turn_off_action:"), s.indexOf("- platform: template", s.indexOf("turn_off_action:")));
    assert.match(an, /^ {6}- if:\n {10}condition:\n {12}lambda: "return !id\(nacht_aktiv\);"\n {10}then:\n/m);
    assert.match(an, /then:[\s\S]*id\(lautstaerke_tag\) = std::isnan\(jetzt\) \? 60\.0f : jetzt;[\s\S]*id\(nacht_aktiv\) = true;[\s\S]*number\.set:[\s\S]*value: 30\n/);
    assert.match(aus, /^ {6}- if:\n {10}condition:\n {12}lambda: "return id\(nacht_aktiv\);"\n {10}then:\n/m);
    assert.match(aus, /then:[\s\S]*id\(nacht_aktiv\) = false;[\s\S]*number\.set:[\s\S]*id\(lautstaerke_tag\)/);
    // Nichts ausserhalb der Bedingungen: jede Aktion steht direkt unter dem if
    for (const block of [an, aus]) assert.equal((block.match(/^ {6}- /gm) ?? []).length, 1);
  });

  it("Wakeword: erst der Ton (abschaltbar), dann voice_assistant.start; Fehlerton bei on_error", () => {
    const w = abschnitt(basis, "micro_wake_word");
    assert.match(w, /model: hey_jarvis/);
    assert.match(w, /on_wake_word_detected:[\s\S]*switch\.is_on: ton_feedback[\s\S]*script\.execute: ton_wake[\s\S]*script\.wait: ton_wake[\s\S]*voice_assistant\.start:/);
    const va = abschnitt(basis, "voice_assistant");
    assert.match(va, /on_error:[\s\S]*switch\.is_on: ton_feedback[\s\S]*script\.execute: ton_fehler/);
    // Ansagen (assist_satellite.announce) brauchen den Media-Player am Sprachassistenten
    assert.match(va, /media_player: medien/);
    assert.match(abschnitt(basis, "media_player"), /platform: speaker[\s\S]*id: medien[\s\S]*speaker: speaker_out/);
    assert.match(abschnitt(basis, "speaker"), /id: speaker_out[\s\S]*sample_rate: 16000[\s\S]*bits_per_sample: 16bit[\s\S]*channel: mono/);
  });

  it("keine Geheimnisse im YAML: Schlüssel, Passwörter und WLAN nur über !secret, alle in secrets.yaml.example", () => {
    const beispiel = lies("esphome", "secrets.yaml.example");
    const dateien = ["jarvis-satellit-basis.yaml", "jarvis-satellit.yaml", "jarvis-satellit-bad.yaml", "jarvis-node-1.yaml", "ton.yaml"];
    for (const name of dateien) {
      const yaml = ohneKommentare(lies("esphome", name));
      for (const z of yaml.split("\n").filter((x) => /^\s*(key|password|ssid|api_key|ota_password|wifi_password):/.test(x))) {
        if (/^\s*ssid: "\$\{friendly_name\} Setup"$/.test(z)) continue; // Name des Notfall-Hotspots, kein Geheimnis
        assert.match(z, /: !secret [a-z_]+\s*(#.*)?$/, `${name}: ${z.trim()}`);
      }
      for (const m of yaml.matchAll(/!secret ([a-z_]+)/g)) assert.match(beispiel, new RegExp(`^${m[1]}:`, "m"), `${m[1]} fehlt in secrets.yaml.example`);
    }
    assert.match(lies(".gitignore"), /^esphome\/secrets\.yaml$/m);
  });
});

describe("Home-Assistant-Paket", () => {
  const ha = lies("homeassistant", "jarvis.yaml");

  it("rest_command.jarvis_briefing_text: POST /events mit Token aus secrets", () => {
    const rc = abschnitt(ha, "rest_command");
    const block = rc.slice(rc.indexOf("  jarvis_briefing_text:"));
    assert.match(block, /url: "http:\/\/JARVIS-IP:3000\/events"/);
    assert.match(block, /method: POST/);
    assert.match(block, /Authorization: !secret jarvis_auth/);
    assert.match(block, /payload: '\{"event": "briefing_text"\}'/);
    // jeder rest_command mit Token aus secrets, nirgends ein Token im Klartext
    const befehle = (rc.match(/^ {2}[a-z_]+:$/gm) ?? []).length;
    assert.equal((rc.match(/Authorization: !secret jarvis_auth/g) ?? []).length, befehle);
    assert.ok(!/Bearer\s+[A-Za-z0-9]/.test(ohneKommentare(ha)));
  });

  it("Briefing nach der Dusche: Satellit im Bad per announce, sonst Telegram", () => {
    const start = ha.indexOf('alias: "Jarvis: Briefing nach der Dusche"');
    const auto = ha.slice(start, ha.indexOf("- alias:", start + 10));
    assert.match(auto, /binary_sensor\.jarvis_satellit_bad_verbunden/);
    assert.match(auto, /action: rest_command\.jarvis_briefing_text\n\s+response_variable: antwort\n\s+continue_on_error: true/);
    assert.match(auto, /action: assist_satellite\.announce\n\s+target:\n\s+entity_id: "\{\{ satellit \}\}"\n\s+data:\n\s+message: "\{\{ antwort\.content\.text \}\}"/);
    // Satelliten-Entität über das Gerät des Verbunden-Sensors ermitteln, nicht raten (ESPHome hängt «…_assist_satellite» an)
    const ohne = ohneKommentare(auto);
    assert.match(ohne, /- variables:\n\s+satellit: >-\n[^\n]*device_id\('binary_sensor\.jarvis_satellit_bad_verbunden'\)[^\n]*\n[^\n]*device_entities\(geraet\)[^\n]*select\('match', 'assist_satellite\[\.\]'\) \| first \| default\('', true\)/);
    assert.match(ohne, /value_template: "\{\{ satellit != '' and states\(satellit\) not in \['unavailable', 'unknown'\] \}\}"/);
    assert.ok(ohne.indexOf("- variables:") < ohne.indexOf("- if:"), "Variable vor der Bedingung");
    assert.ok(!/assist_satellite\.jarvis_satellit_bad\b/.test(ohne), "keine geratene Satelliten-ID");
    // Fallback zweimal: Satellit nicht erreichbar, oder Jarvis liefert keinen Text
    assert.equal((auto.match(/action: rest_command\.jarvis_event\n\s+data:\n\s+event: briefing/g) ?? []).length, 2);
    // Kündigt Jarvis die Nachlieferung per Telegram an, kein zweites Briefing über «briefing»
    assert.match(ohne, /value_template: "\{\{ not \(antwort is defined and antwort\.status \| default\(0\) == 200 and antwort\.content\.nachlieferung \| default\(''\) == 'telegram'\) \}\}"\n\s+then:\n\s+- action: rest_command\.jarvis_event/);
  });

  it("Beispiel-Automationen Nachtmodus (22:00/06:30) und Lautstärke tagsüber 60", () => {
    assert.match(ha, /alias: "Jarvis: Satellit Nachtmodus"[\s\S]*at: "22:00:00"[\s\S]*at: "06:30:00"[\s\S]*switch\.jarvis_satellit_bad_nachtmodus/);
    assert.match(ha, /alias: "Jarvis: Lautstärke tagsüber 60"[\s\S]*number\.set_value[\s\S]*number\.jarvis_satellit_bad_lautstarke[\s\S]*value: 60/);
  });
});
