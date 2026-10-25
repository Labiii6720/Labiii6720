import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/**
 * Eingangsfilter für alle Chat-Kanäle (Telegram Text und Sprache, Gespräch der Kommandozentrale, /events frage und
 * frage_sync, Alexa): Sieht die Eingabe nach der PIN aus, geht sie nicht an Claude, nicht in data/chat.json und nicht als
 * Echo zurück. Geprüft wird nur die Klasse (Länge, Ziffern), nie der Wert: sonst liesse sich die PIN über den Chat
 * ungezählt durchprobieren. Darum wird hier auch nichts gezählt. Ausnahme: eine PIN ohne Ziffern (siehe pinWarnung).
 */

/** Die eine Antwort auf jede PIN-förmige Eingabe, in allen Kanälen gleich */
export const PIN_EINGABE_TEXT = "Das sieht aus wie eine PIN, Sir. Ich schicke es nicht weiter.";

/** «PIN», «Code», «Passwort», «Kennwort», «Geheimzahl» als ganzes Wort */
const PIN_WORT = /(?<![\p{L}\d])(?:pin|code|passwort|kennwort|geheimzahl)(?![\p{L}\d])/giu;
/** So weit nach dem PIN-Wort darf die PIN beginnen */
const PIN_WORT_ABSTAND = 20;

/**
 * Am Rand alles ausser Buchstaben und Ziffern weg: Leerraum, «!» (starkes Modell), Anführungszeichen, Klammern, Satzzeichen.
 * Gilt gleich für Eingabe, jedes Wort nach dem PIN-Wort und die PIN selbst.
 */
const normal = (t: string): string => t.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, "");

const gleich = (a: string, b: string): boolean => {
  const h = (s: string) => createHash("sha256").update(s.toLowerCase()).digest();
  return timingSafeEqual(h(a), h(b));
};

/** Leerraum jeder Art (Tab, U+00A0, U+202F, mehrere) zu einem Leerzeichen, vor jeder Prüfung */
const leerraum = (t: string): string => t.replace(/\s+/g, " ");

/**
 * Hat `t` (normalisiert) die Form der PIN? Ziffern-PIN: nur Ziffern, auch in Gruppen getrennt durch Leerzeichen,
 * Bindestrich, « - » oder «, » («4 7 1 1», «47-11», «4, 7, 1, 1» aus der Spracherkennung), zusammen so viele wie die
 * PIN; Punkt, Doppelpunkt und Komma ohne Leerzeichen trennen nicht («14.30», «14:30», «1,5» gehen durch).
 * Gemischte PIN: ein Wort derselben Länge mit Ziffer und Nicht-Ziffer. PIN ohne Ziffern: Vergleich mit dem Wert.
 */
function pinForm(t: string, pin: string): boolean {
  if (/^\d+$/.test(pin)) return /^\d+(?:(?: - |, | |-)\d+)*$/.test(t) && t.replace(/\D/g, "").length === pin.length;
  if (/\d/.test(pin)) return !/\s/.test(t) && Array.from(t).length === Array.from(pin).length && /\d/.test(t) && /\D/.test(t);
  return gleich(t, pin);
}

/** Zifferngruppe als ganzes Wort, Rand wie bei normal(): «47», «47-11», «(4711)», «4,» */
const ZIFFERN_WORT = /^[^\p{L}\d]*\d+(?:-\d+)*[^\p{L}\d]*$/u;

/**
 * Nach einem PIN-Wort: beginnt innert PIN_WORT_ABSTAND Zeichen ein Wort in PIN-Form («PIN: 4711», «Code=ab12»)? Bei einer
 * Ziffern-PIN zählt jedes Wort für sich («PIN Tür 2 4711», «PIN 12 4711»), dazu die Zifferngruppe und ihre Anfangsstücke,
 * wortweise ab dem ERSTEN Wort der Gruppe («PIN ist 47 11», «PIN (47) 11», «PIN 4711 0815»), nie ein mehrwortiges Stück ab
 * der Mitte («Code an 079 123 45 67» geht durch: 3, 6, 8, 10 Ziffern). Eine Gruppe läuft über Ziffernwörter, auch mit
 * « - » dazwischen; jedes Wort normalisiert, verbunden mit einem Leerzeichen.
 */
function nachPinWort(rest: string, pin: string): boolean {
  const woerter = [...rest.matchAll(/\S+/g)].map((w) => ({ ab: w.index, roh: w[0] }));
  if (!/^\d+$/.test(pin)) return woerter.some((w) => w.ab <= PIN_WORT_ABSTAND && pinForm(normal(w.roh), pin));
  const ziffern = (i: number): boolean => i < woerter.length && ZIFFERN_WORT.test(woerter[i]!.roh);
  /** Index des nächsten Ziffernworts derselben Gruppe oder -1 */
  const weiter = (i: number): number => (ziffern(i + 1) ? i + 1 : woerter[i + 1]?.roh === "-" && ziffern(i + 2) ? i + 2 : -1);
  for (let i = 0; i < woerter.length && woerter[i]!.ab <= PIN_WORT_ABSTAND; i++) {
    if (!ziffern(i)) continue;
    let stueck = "";
    let ende = i;
    for (let j = i; j >= 0; j = weiter(j)) {
      ende = j;
      const wort = normal(woerter[j]!.roh);
      if (woerter[j]!.ab <= PIN_WORT_ABSTAND && pinForm(wort, pin)) return true;
      stueck = stueck ? `${stueck} ${wort}` : wort;
      if (pinForm(stueck, pin)) return true;
    }
    i = ende; // mehrwortige Stücke nur ab dem Gruppenanfang
  }
  return false;
}

/**
 * Ist die Eingabe die PIN oder sieht sie so aus? Die PIN wird gleich normalisiert wie die Eingabe («4711!» → «4711»).
 * Ohne JARVIS_PIN nie. Rein: hängt nur von Text und PIN ab.
 */
export function pinEingabe(text: string): boolean {
  const pin = normal(config.pin ?? "");
  if (!pin) return false;
  const eingabe = leerraum(text);
  const t = normal(eingabe);
  if (t && pinForm(t, pin)) return true;
  for (const m of eingabe.matchAll(PIN_WORT)) if (nachPinWort(eingabe.slice(m.index + m[0].length), pin)) return true;
  return false;
}
