import { config } from "./config.js";
import { neueEntscheidungId, neuesMusterId, neueZielId, profil, profilFuerPrompt, saveProfil } from "./profil.js";
import type { Tool } from "./tools.js";

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
    run: async () => profilFuerPrompt() || "Noch nichts gelernt.",
  },
  {
    name: "profil_vergessen",
    description: "Löscht einen Eintrag aus dem Profil (Ziel, Wert, Muster, Entscheidung oder Fakt).",
    input_schema: { type: "object", properties: { art: str("ziel, wert, muster, entscheidung oder fakt"), id: num("Nummer bei ziel/muster/entscheidung"), text: str("Wortlaut bei wert/fakt") }, required: ["art"] },
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
      else if (art === "entscheidung") byId(profil.entscheidungen);
      else if (art === "wert") profil.werte = profil.werte.filter((w) => w !== String(i.text));
      else if (art === "fakt") profil.fakten = profil.fakten.filter((f) => f !== String(i.text));
      else throw new Error("Unbekannte Art.");
      saveProfil();
      return "Vergessen.";
    },
  },
];
