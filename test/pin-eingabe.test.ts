import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

// pinEingabe (0.24): eine Regel für alle Kanäle. Nur nach Klasse (Länge, Ziffern), nie nach Wert – ausser bei einer PIN
// ohne Ziffern. Rein, ohne Netz; Temp-Ordner, damit nichts im Projekt entsteht.
const temp = mkdtempSync(join(tmpdir(), "jarvis-pin-eingabe-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));
process.env.JARVIS_PIN = "4711";

const { config } = await import("../src/config.js");
const { pinEingabe, PIN_EINGABE_TEXT } = await import("../src/pin.js");
const { pinWarnung } = await import("../src/setup.js");

const origPin = config.pin;
afterEach(() => { config.pin = origPin; });

describe("pinEingabe: Ziffern-PIN (4711)", () => {
  it("die PIN und jede Zahl derselben Länge, auch in Gruppen, mit «!», Anführungszeichen und Satzzeichen", () => {
    for (const t of ["4711", "4712", "0000", " 4711 ", "4 7 1 1", "47 11", "47-11", "4-7-1-1", "4711.", "4711!", "4711?", "!4711", "! 4711", "«4711»", "\"4711\"", "'4711'", "„4711“", "«4711».", "4 7 1 1."]) {
      assert.equal(pinEingabe(t), true, t);
    }
  });

  it("Fehltreffer gehen durch: Uhrzeit, Betrag, Datum, Telefonnummer, andere Länge, Sätze ohne PIN-Wort", () => {
    for (const t of ["14.30", "14:30", "12.50", "25.10.2026", "079 123 45 67", "471", "47111", "4 7 1", "Termin um 1430 mit Müller", "Ist 4711 gut?", "Danke", "ok", "4,7,1,1", "1.2.5.0"]) {
      assert.equal(pinEingabe(t), false, t);
    }
  });

  it("PIN-Wort im Satz: «meine PIN ist 4711» und Verwandte blockiert", () => {
    for (const t of ["meine PIN ist 4711", "Meine PIN ist 4711, vergiss sie wieder", "PIN: 4711", "PIN:4711", "pin=4711", "Der Code lautet 47 11", "Passwort 4712", "das Kennwort ist «4711».", "Geheimzahl 0815 bitte merken", "Code der Garage ist 4711"]) {
      assert.equal(pinEingabe(t), true, t);
    }
  });

  it("PIN-Wort ohne Zahl in PIN-Form oder zu weit weg: geht durch", () => {
    for (const t of ["Wie ändere ich die PIN?", "PIN um 14.30 ändern", "Der Code hat sich geändert, die neue Nummer kommt am Montag um 1430", "Garagencode 4711", "Pinguin 4711"]) {
      assert.equal(pinEingabe(t), false, t);
    }
  });
});

describe("pinEingabe: gemischte PIN (ab12)", () => {
  it("ein Wort gleicher Länge mit Ziffer und Nicht-Ziffer, nie nach Wert", () => {
    config.pin = "ab12";
    for (const t of ["ab12", "zz99", "1a2b", "AB12.", "«x9y8»", "Code: ab12"]) assert.equal(pinEingabe(t), true, t);
    for (const t of ["abcd", "1234", "ab123", "ab 12", "Raum12", "Ist ab12 gut?"]) assert.equal(pinEingabe(t), false, t);
  });
});

describe("pinEingabe: PIN ohne Ziffern (Wertvergleich, darum die Warnung)", () => {
  it("nur der Wert selbst, gross/klein egal, auch nach einem PIN-Wort; andere Wörter gehen durch", () => {
    config.pin = "Sesamoeffne";
    for (const t of ["Sesamoeffne", "sesamoeffne.", "«SESAMOEFFNE»", "mein Passwort ist sesamoeffne"]) assert.equal(pinEingabe(t), true, t);
    for (const t of ["Danke", "Status", "Sesamoeffner", "2026"]) assert.equal(pinEingabe(t), false, t);
  });

  it("Warnung in Setup und check nur ohne Ziffern", () => {
    assert.equal(pinWarnung("Sesamoeffne"), "PIN ohne Ziffern – bitte eine Ziffern-PIN wählen");
    assert.equal(pinWarnung("4711"), undefined);
    assert.equal(pinWarnung("ab12"), undefined);
  });
});

describe("pinEingabe: Rand der Eingabe, der Wörter und der PIN gleich normalisiert", () => {
  it("PIN nach PIN-Wort mit Klammer, Raute, Bindestrich, Strich", () => {
    for (const t of ["Meine neue PIN (4711) bitte merken", "PIN-4711", "PIN #4711", "Pin (4711)", "PIN —4711", "(4711)"]) {
      assert.equal(pinEingabe(t), true, t);
    }
    for (const t of ["PIN (14.30)", "Code #12.50", "14.30", "12.50"]) assert.equal(pinEingabe(t), false, t);
  });

  it("PIN mit «!», Anführungszeichen oder Satzzeichen am Rand erkennt sich selbst (Klasse, nicht Wert)", () => {
    config.pin = "4711!";
    for (const t of ["4711!", "4712!", "4711", "PIN 4711!", "meine PIN ist 4711!"]) assert.equal(pinEingabe(t), true, t);
    config.pin = "!4711";
    for (const t of ["!4711", "4712"]) assert.equal(pinEingabe(t), true, t);
    for (const pin of ["ab12.", "\"ab12\"", "'ab12", "ab1!", "!ab1", "Jarvis1!"]) {
      config.pin = pin;
      for (const t of [pin, `PIN ${pin}`, `meine PIN ist ${pin}`]) assert.equal(pinEingabe(t), true, `${pin}: ${t}`);
    }
    config.pin = "ab12.";
    assert.equal(pinEingabe("zz99"), true);
  });

  it("PIN ohne Ziffern mit Satzzeichen am Rand: Wert nach Normalisierung", () => {
    for (const pin of ["sesam!", "abc."]) {
      config.pin = pin;
      for (const t of [pin, pin.slice(0, -1), `Passwort ${pin}`]) assert.equal(pinEingabe(t), true, `${pin}: ${t}`);
      assert.equal(pinEingabe("Danke!"), false);
    }
  });
});

describe("pinEingabe: ohne JARVIS_PIN", () => {
  it("immer false", () => {
    config.pin = undefined;
    for (const t of ["4711", "meine PIN ist 4711", "ab12"]) assert.equal(pinEingabe(t), false, t);
  });
});

describe("kein Orakel", () => {
  it("richtige und falsche PIN gleicher Form: dasselbe Ergebnis, für PIN 4711 und 4712", () => {
    const proben = ["4711", "4712", "47 11", "47 12", "PIN 4711", "PIN 4712", "4711.", "1430"];
    config.pin = "4711";
    const a = proben.map(pinEingabe);
    config.pin = "4712";
    assert.deepEqual(proben.map(pinEingabe), a);
  });

  it("ein Text für alle Kanäle", () => {
    assert.equal(PIN_EINGABE_TEXT, "Das sieht aus wie eine PIN, Sir. Ich schicke es nicht weiter.");
  });
});
