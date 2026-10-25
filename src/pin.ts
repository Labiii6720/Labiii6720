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

/**
 * Hat `t` (normalisiert) die Form der PIN? Ziffern-PIN: nur Ziffern, auch in Gruppen mit Leerzeichen oder Bindestrich
 * («4 7 1 1», «47-11»), zusammen so viele wie die PIN; Punkt und Doppelpunkt trennen nicht («14.30» geht durch).
 * Gemischte PIN: ein Wort derselben Länge mit Ziffer und Nicht-Ziffer. PIN ohne Ziffern: Vergleich mit dem Wert.
 */
function pinForm(t: string, pin: string): boolean {
  if (/^\d+$/.test(pin)) return /^\d+(?:[ -]\d+)*$/.test(t) && t.replace(/\D/g, "").length === pin.length;
  if (/\d/.test(pin)) return !/\s/.test(t) && Array.from(t).length === Array.from(pin).length && /\d/.test(t) && /\D/.test(t);
  return gleich(t, pin);
}

/**
 * Nach einem PIN-Wort: beginnt innert PIN_WORT_ABSTAND Zeichen ein Wort in PIN-Form («PIN: 4711», «Code=ab12»)? Bei einer
 * Ziffern-PIN zählen folgende Gruppen dazu («PIN ist 47 11»).
 */
function nachPinWort(rest: string, pin: string): boolean {
  const woerter = [...rest.matchAll(/\S+/g)].map((w) => ({ ab: w.index, t: normal(w[0]) }));
  for (let i = 0; i < woerter.length && woerter[i]!.ab <= PIN_WORT_ABSTAND; i++) {
    let kandidat = woerter[i]!.t;
    for (let j = i; ; kandidat += ` ${woerter[++j]!.t}`) {
      if (pinForm(kandidat, pin)) return true;
      if (j + 1 >= woerter.length || !/^\d+(?:-\d+)*$/.test(woerter[j]!.t)) break;
    }
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
  const t = normal(text);
  if (t && pinForm(t, pin)) return true;
  for (const m of text.matchAll(PIN_WORT)) if (nachPinWort(text.slice(m.index + m[0].length), pin)) return true;
  return false;
}
