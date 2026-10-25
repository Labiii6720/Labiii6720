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

describe("pinEingabe: Trenner (0.24.1)", () => {
  it("Leerraum jeder Art zählt als ein Leerzeichen; « - » und «, » trennen Gruppen", () => {
    for (const t of ["4  7  1  1", "47\t11", "47\u00a011", "47\u202f11", " 47 \u00a0 11 ", "4, 7, 1, 1", "4, 7, 1, 1.", "47, 11", "4 - 7 - 1 - 1", "47 - 11", "PIN ist 4, 7, 1, 1", "Code:\u00a047\t11", "meine\u00a0PIN\u00a0ist\u00a04711"]) {
      assert.equal(pinEingabe(t), true, JSON.stringify(t));
    }
  });

  it("Punkt, Doppelpunkt und Komma ohne Leerzeichen trennen weiterhin nicht", () => {
    for (const t of ["14.30", "14:30", "12.50", "1,5", "4,7,1,1", "47,11", "14. 30", "47 -- 11", "Code 14.30", "Code 12,50"]) {
      assert.equal(pinEingabe(t), false, t);
    }
  });
});

describe("pinEingabe: PIN-Wort-Fenster nur mit vollständiger Zifferngruppe (0.24.1)", () => {
  it("Teilstück einer längeren Ziffernfolge zählt nicht", () => {
    for (const t of ["Schick den Code an 079 123 45 67", "Code an 079 123 45 67", "Der Code ist 079 123 45 67", "PIN 123 45 67", "Code 0791234567", "Code an 079, 123, 45, 67", "Code an 079 - 123 - 45 - 67"]) {
      assert.equal(pinEingabe(t), false, t);
    }
  });

  it("vollständige Gruppe zählt, auch mit Satzzeichen oder einer zweiten Gruppe im Fenster", () => {
    for (const t of ["Code: 47 11", "PIN ist 4711.", "PIN ist 4711. Danke", "Code 47 - 11", "Code 4, 7, 1, 1", "Der Code für Tür 2 ist 4711", "PIN (47 11)", "PIN 4711 und 0815"]) {
      assert.equal(pinEingabe(t), true, t);
    }
  });

  it("Anfangsstück der Gruppe zählt: PIN gefolgt von einer weiteren Zahl bleibt blockiert", () => {
    for (const t of ["PIN 4711 0815", "Meine PIN ist 4711 2 Mal falsch eingegeben", "meine PIN ist 4711, 4712 war die alte", "PIN 4711 3", "Die PIN ist 4711, 2 Leute kennen sie", "PIN 4711 3 mal falsch", "Code 4711 15 Uhr", "Code\n4711\n2", "PIN 2026 07", "PIN 4711 2", "PIN 4711, 2026", "PIN 47 11 2", "Code 47 - 11 - 3"]) {
      assert.equal(pinEingabe(t), true, JSON.stringify(t));
    }
  });

  it("nie ein mehrwortiges Stück ab einem Wort mitten in der Gruppe", () => {
    for (const t of ["PIN 123 45 67", "Code an 079 123 45 67", "PIN 1 23 45", "Code 123 45 678"]) assert.equal(pinEingabe(t), false, t);
  });

  it("jedes Wort in PIN-Form zählt für sich, auch mit einer Zahl davor in derselben Gruppe", () => {
    for (const t of ["PIN 12 4711", "Code 1 4711", "Code an 079 123 4711", "PIN Tür 2 4711", "Der Code für Tür 2 4711", "Code Karte 1 4711", "PIN: 1 4711", "Code 3, 4711", "PIN 0 - 4711"]) {
      assert.equal(pinEingabe(t), true, t);
    }
  });

  it("Gruppe aus Wörtern mit Rand: jedes Wort normalisiert («PIN 47 -11», «PIN (47) 11»)", () => {
    for (const t of ["PIN 47 -11", "PIN (47) 11", "Code «47» 11", "PIN 47, 11"]) assert.equal(pinEingabe(t), true, t);
    for (const t of ["PIN 47 -- 11", "PIN (14.30) 12"]) assert.equal(pinEingabe(t), false, t);
  });

  it("Wort in PIN-Form mitten in der Gruppe, aber erst nach 20 Zeichen: zählt nicht für sich", () => {
    assert.equal(pinEingabe("PIN 1 23 45 678 901 234 4711"), false);
    assert.equal(pinEingabe("PIN 1 23 45 678 901 23 4711"), true);
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
    // Nur Sonderzeichen: pinEingabe wirkt gar nicht (die normalisierte PIN ist leer), darum dieselbe Warnung
    for (const pin of ["####", "!!!!", "#-#-", "«»«»"]) {
      assert.equal(pinWarnung(pin), "PIN ohne Ziffern – bitte eine Ziffern-PIN wählen", pin);
      config.pin = pin;
      assert.equal(pinEingabe(pin), false, pin);
    }
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
    const proben = ["4711", "4712", "47 11", "47 12", "PIN 4711", "PIN 4712", "4711.", "1430", "PIN 12 4711", "PIN 12 4712", "PIN (47) 11"];
    config.pin = "4711";
    const a = proben.map(pinEingabe);
    config.pin = "4712";
    assert.deepEqual(proben.map(pinEingabe), a);
  });

  it("ein Text für alle Kanäle", () => {
    assert.equal(PIN_EINGABE_TEXT, "Das sieht aus wie eine PIN, Sir. Ich schicke es nicht weiter.");
  });
});
