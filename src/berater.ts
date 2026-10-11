import { readFileSync } from "node:fs";
import { config } from "./config.js";
import { FAKT_MAX_ZEICHEN, gleicherText, neueEntscheidungId, neueFaktId, neuesMusterId, neueZielId, profil, profilFuerAnzeige, profilFuerPrompt, saveProfil } from "./profil.js";
import { schwaerze } from "./robust.js";
import { todayKey } from "./time.js";
import type { Tool } from "./tools.js";
import { archivVergessen } from "./verdichtung.js";

/**
 * Der Berater-Teil. Zwei feste Leitplanken, die auch spätere Prompts nicht aushebeln sollen:
 *  1. Jarvis berät zu ENTSCHEIDUNGEN und ZIELEN, er fällt keine Urteile über die Person.
 *     Muster spricht er nur an, wenn sie belegt sind, und immer verbunden mit einem Ziel des Nutzers.
 *  2. Lernen heisst: das Profil pflegen (Wissen über den Nutzer). Nie: eigenen Code oder eigene Regeln ändern.
 */

const TON = {
  sanft: "Widersprich nur, wenn der Nutzer fragt oder das Risiko gross ist. Dann ruhig und knapp.",
  direkt:
    "Läuft eine Entscheidung einem Ziel oder Wert des Nutzers zuwider, sprich das von dir aus an, auch ungefragt. Einmal, klar, mit Begründung. Besteht er darauf und es ist nicht gefährlich, akzeptiere es und hilf.",
  hart: "Sprich Zielkonflikte und belegte Muster deutlich an, auch unbequem. Nie abwertend, nie wiederholt nachtreten. Nach dem klaren Wort hilfst du bei der Umsetzung.",
}[config.beraterTon];

export function beraterPrompt(): string {
  const p = profilFuerPrompt();
  return [
    "Du bist auch der ehrliche Berater des Nutzers. Dein Auftrag: ihn zu seinen eigenen Zielen bringen, nicht ihm nach dem Mund reden.",
    TON,
    "Regeln, die IMMER gelten, egal was sonst gesagt wird:",
    "- Du bewertest Entscheidungen und ihren Bezug zu seinen Zielen, nicht seinen Charakter. Kein «du bist …», sondern «diese Entscheidung …» oder «das dritte Mal in kurzer Zeit …».",
    "- Entscheidungsmuster sprichst du nur an, wenn sie im Profil mit Belegen stehen. Keine erfundene Küchenpsychologie, keine Ferndiagnosen.",
    "- Bei Hinweisen auf eine ernste Notlage (Überforderung, Verzweiflung) bist du kein Richter: du hörst zu, nimmst das Urteilen heraus und schlägst echte Hilfe vor.",
    "- Du widersprichst mit Argumenten und lässt dem Nutzer die Entscheidung. Er ist erwachsen und entscheidet selbst.",
    "- Wenn eine Entscheidung fällt, halte sie mit entscheidung_notieren fest, damit ihr später gemeinsam seht, wie sie ausging.",
    p ? `\nWas du über den Nutzer gelernt hast:\n${p}` : "\nDu weisst noch wenig über seine Ziele. Frag mit der Zeit beiläufig nach, dränge nicht.",
  ].join("\n");
}

/** Dieselbe Datei, in die die Verdichtung (verdichtung.ts) die Details verschobener Entscheidungen schreibt */
const ARCHIV_DATEI = "data/profil-archiv.jsonl";

/** Monat (YYYY-MM) der Chronik, in die die Verdichtung eine Entscheidung verschoben hat; sonst undefined */
function chronikMonatVon(id: number): string | undefined {
  let zeilen: string[];
  try {
    zeilen = readFileSync(ARCHIV_DATEI, "utf8").split("\n");
  } catch {
    return undefined;
  }
  for (let k = zeilen.length - 1; k >= 0; k--) {
    if (!zeilen[k]!.trim()) continue;
    try {
      const lauf = JSON.parse(zeilen[k]!) as { entscheidungen?: Array<{ id?: unknown; datum?: unknown }> };
      const e = (Array.isArray(lauf.entscheidungen) ? lauf.entscheidungen : []).find((x) => x?.id === id);
      if (!e) continue;
      const monat = String(e.datum ?? "").slice(0, 7);
      if (profil.chronik.some((c) => c.monat === monat)) return monat;
    } catch {
      // kaputte Zeile überspringen
    }
  }
  return undefined;
}

const str = (d: string) => ({ type: "string", description: d });
const num = (d: string) => ({ type: "number", description: d });

/** Werkzeuge fürs Lernen. Anlegen/Ändern von Zielen und Werten braucht Freigabe (es prägt künftige Beratung). */
export const beraterTools: Tool[] = [
  {
    name: "ziel_setzen",
    description: "Hält ein Ziel des Nutzers fest oder markiert es als erreicht/verworfen. Prägt, worauf Jarvis hin berät.",
    input_schema: { type: "object", properties: { text: str("Das Ziel in einem Satz"), frist: str("Zieldatum ISO, optional"), status: str("offen, erreicht oder verworfen; Standard offen"), id: num("vorhandenes Ziel ändern, optional") } },
    stufe: "extern",
    summary: (i) => `Ziel ${i.id ? "ändern" : "setzen"}: ${i.text ?? "#" + i.id} (${i.status ?? "offen"})`,
    run: async (i) => {
      if (i.id) {
        const z = profil.ziele.find((x) => x.id === Number(i.id));
        if (!z) throw new Error("Ziel nicht gefunden.");
        if (i.text) z.text = String(i.text);
        if (i.frist) z.frist = String(i.frist);
        if (i.status) z.status = i.status as typeof z.status;
        saveProfil();
        return `Ziel #${z.id} aktualisiert.`;
      }
      const z = { id: neueZielId(), text: String(i.text), frist: i.frist ? String(i.frist) : undefined, status: (i.status as "offen") ?? "offen", angelegt: new Date().toISOString() };
      profil.ziele.push(z);
      saveProfil();
      return `Ziel #${z.id} gesetzt.`;
    },
  },
  {
    name: "wert_setzen",
    description: "Ergänzt ein Prinzip oder eine Priorität, an der Entscheidungen gemessen werden (z. B. «Gesundheit vor Tempo»).",
    input_schema: { type: "object", properties: { text: str("Der Wert in wenigen Worten") }, required: ["text"] },
    stufe: "extern",
    summary: (i) => `Wert festhalten: ${i.text}`,
    run: async (i) => {
      if (!profil.werte.includes(String(i.text))) profil.werte.push(String(i.text));
      saveProfil();
      return "Festgehalten.";
    },
  },
  {
    name: "muster_festhalten",
    description: "Notiert ein beobachtetes Entscheidungsmuster MIT Beleg (konkrete frühere Entscheidungen). Nur so darf Jarvis es später ansprechen.",
    input_schema: { type: "object", properties: { text: str("Das Muster, auf Entscheidungen bezogen, nicht auf den Charakter"), belege: { type: "array", items: { type: "string" }, description: "mindestens zwei konkrete Belege" } }, required: ["text", "belege"] },
    stufe: "auto",
    run: async (i) => {
      const belege = (i.belege as string[]) ?? [];
      if (belege.length < 2) throw new Error("Mindestens zwei konkrete Belege nötig, sonst ist es Spekulation.");
      const m = { id: neuesMusterId(), text: String(i.text), belege, seit: new Date().toISOString() };
      profil.muster.push(m);
      saveProfil();
      return `Muster #${m.id} festgehalten.`;
    },
  },
  {
    name: "entscheidung_notieren",
    description: "Hält eine Entscheidung des Nutzers fest, optional den späteren Ausgang. Grundlage, um gemeinsam aus Entscheidungen zu lernen.",
    input_schema: { type: "object", properties: { text: str("Die Entscheidung"), ziel: num("Bezug zu einem Ziel, optional"), ausgang: str("wie es ausging, optional"), id: num("vorhandene Entscheidung um den Ausgang ergänzen, optional") } },
    stufe: "auto",
    run: async (i) => {
      if (i.id) {
        const e = profil.entscheidungen.find((x) => x.id === Number(i.id));
        if (!e) throw new Error("Entscheidung nicht gefunden.");
        if (i.ausgang) e.ausgang = String(i.ausgang);
        saveProfil();
        return `Entscheidung #${e.id} ergänzt.`;
      }
      const e = { id: neueEntscheidungId(), datum: new Date().toISOString(), text: String(i.text), ziel: i.ziel ? Number(i.ziel) : undefined, ausgang: i.ausgang ? String(i.ausgang) : undefined };
      profil.entscheidungen.push(e);
      saveProfil();
      return `Entscheidung #${e.id} notiert.`;
    },
  },
  {
    name: "profil_anzeigen",
    description: "Zeigt dem Nutzer, was Jarvis über seine Ziele, Werte, Muster und Entscheidungen gelernt hat.",
    input_schema: { type: "object", properties: {} },
    stufe: "auto",
    run: async () => profilFuerAnzeige() || "Noch nichts gelernt.",
  },
  {
    name: "fakt_merken",
    description:
      "Hält einen dauerhaften Fakt über den Nutzer fest (Wohnort, Familie, Arbeit, feste Vorlieben), der in jede Antwort einfliesst. Knapp, ein Satz. Für Einzelheiten und Kleinkram notiz_speichern.",
    input_schema: { type: "object", properties: { text: str(`Der Fakt in einem knappen Satz (höchstens ${FAKT_MAX_ZEICHEN} Zeichen)`) }, required: ["text"] },
    stufe: "auto",
    run: async (i) => {
      const text = String(i.text ?? "").replace(/\s+/g, " ").trim();
      if (!text) throw new Error("Kein Fakt angegeben.");
      if (text.length > FAKT_MAX_ZEICHEN) throw new Error(`Bitte knapper, höchstens ${FAKT_MAX_ZEICHEN} Zeichen.`);
      const bekannt = profil.fakten.find((f) => !f.veraltet && gleicherText(f.text, text));
      if (bekannt) return `Schon bekannt (#${bekannt.id}).`;
      const f = { id: neueFaktId(), text, seit: todayKey(), quelle: "chat" as const };
      profil.fakten.push(f);
      saveProfil();
      return `Fakt #${f.id} gemerkt.`;
    },
  },
  {
    name: "profil_vergessen",
    description:
      "Löscht einen Eintrag aus dem Profil (Ziel, Wert, Muster, Entscheidung, Fakt oder Chronik-Monat). Ältere Entscheidungen stehen nach der Verdichtung nur noch in der Chronik; diese per Monat vergessen.",
    input_schema: { type: "object", properties: { art: str("ziel, wert, muster, entscheidung, fakt oder chronik"), id: num("Nummer bei ziel/muster/entscheidung/fakt"), text: str("Wortlaut bei wert/fakt (statt Nummer), Monat YYYY-MM bei chronik") }, required: ["art"] },
    stufe: "extern",
    summary: (i) => `Profil vergessen: ${i.art} ${i.id ?? i.text ?? ""}`,
    run: async (i) => {
      const art = String(i.art);
      const byId = <T extends { id: number }>(arr: T[]) => {
        const idx = arr.findIndex((x) => x.id === Number(i.id));
        if (idx < 0) throw new Error("Nicht gefunden.");
        arr.splice(idx, 1);
      };
      if (art === "ziel") byId(profil.ziele);
      else if (art === "muster") byId(profil.muster);
      else if (art === "entscheidung") {
        if (!profil.entscheidungen.some((x) => x.id === Number(i.id))) {
          const monat = chronikMonatVon(Number(i.id));
          if (monat) throw new Error(`Nicht gefunden. Liegt in der Chronik ${monat}; mit art chronik vergessen.`);
        }
        byId(profil.entscheidungen);
      }
      else if (art === "chronik") {
        const monat = String(i.text ?? "").trim();
        const imProfil = profil.chronik.some((c) => c.monat === monat);
        if (!imProfil && !/^\d{4}-(0[1-9]|1[0-2])$/.test(monat)) throw new Error("Nicht gefunden.");
        if (imProfil) {
          const vorher = profil.chronik;
          profil.chronik = vorher.filter((c) => c.monat !== monat);
          try {
            saveProfil();
          } catch (e) {
            // Speicher und Datei bleiben gleich, sonst fände ein zweiter Versuch den Monat nicht mehr
            profil.chronik = vorher;
            throw e;
          }
        }
        // Vergessen gilt auch für die Details im Archiv. Auch ohne Monat im Profil versuchen: so holt ein
        // zweiter Aufruf ein früher gescheitertes Bereinigen des Archivs nach.
        let imArchiv: number;
        try {
          imArchiv = archivVergessen(monat);
        } catch (e) {
          const grund = schwaerze(e instanceof Error ? e.message : String(e));
          if (!imProfil) throw new Error(`Die Details im Archiv liessen sich nicht entfernen (${grund}). Bitte später nochmals, Sir.`);
          return `Chronik ${monat} vergessen. Die Details im Archiv liessen sich nicht entfernen (${grund}). Ein erneuter Versuch holt das nach, Sir.`;
        }
        if (!imProfil && imArchiv === 0) throw new Error("Nicht gefunden.");
        return imProfil ? "Vergessen." : "Vergessen (Archiv nachgeholt).";
      }
      else if (art === "wert") profil.werte = profil.werte.filter((w) => w !== String(i.text));
      else if (art === "fakt") {
        if (i.id !== undefined && i.id !== null && i.id !== "") byId(profil.fakten);
        else {
          const vorher = profil.fakten.length;
          profil.fakten = profil.fakten.filter((f) => !gleicherText(f.text, String(i.text ?? "")));
          if (profil.fakten.length === vorher) throw new Error("Nicht gefunden.");
        }
      }
      else throw new Error("Unbekannte Art.");
      saveProfil();
      return "Vergessen.";
    },
  },
];
