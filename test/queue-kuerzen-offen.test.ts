import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Kürzen auf 200 Einträge: früher fielen die ältesten weg, egal welcher Status. Ein offener Auftrag verschwand still,
// ein begonnener verlor seinen Vermerk, und setStatus schrieb auf ein Objekt ausserhalb der Liste.
const temp = mkdtempSync(join(tmpdir(), "jarvis-queue-kuerzen-offen-"));
process.chdir(temp);
process.once("exit", () => rmSync(temp, { recursive: true, force: true }));

const DATEI = join(temp, "data", "auftraege.json");
const eintrag = (id: number, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, createdAt: "2026-10-01T08:00:00.000Z", tool: "mail_senden", input: {}, stufe: "extern", summary: `alt ${id}`, status, ...extra });
mkdirSync(join(temp, "data"), { recursive: true });
writeFileSync(
  DATEI,
  JSON.stringify([
    eintrag(1, "offen"),
    eintrag(2, "offen", { gestartetAm: "2026-10-01T08:05:00.000Z" }),
    ...Array.from({ length: 198 }, (_, i) => eintrag(i + 3, "erledigt")),
  ]),
);

const queue = await import("../src/queue.js");
const ids = () => queue.auftraege.map((a) => a.id);
const TMP = `${DATEI}.tmp`;

describe("Kürzen der Auftragsliste", () => {
  it("offener und begonnener ältester Auftrag bleiben, abgeschlossene fallen weg", () => {
    for (let n = 0; n < 6; n++) queue.setStatus(queue.createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: `neu ${n}` }), "erledigt");
    assert.equal(queue.auftraege.length, 200);
    assert.equal(queue.getAuftrag(1)?.status, "offen");
    assert.equal(queue.getAuftrag(2)?.gestartetAm, "2026-10-01T08:05:00.000Z");
    assert.deepEqual(ids().slice(0, 3), [1, 2, 9], "3 bis 8 (erledigt) weggekürzt");
    // setStatus auf den ältesten landet in der Datei
    queue.setStatus(queue.getAuftrag(1)!, "abgelehnt", "nein");
    const inDatei = JSON.parse(readFileSync(DATEI, "utf8")) as { id: number; status: string }[];
    assert.deepEqual(inDatei[0], { ...eintrag(1, "abgelehnt"), result: "nein" });
  });

  it("Speicherfehler: der vorherige Stand kommt vollständig und in derselben Reihenfolge zurück", () => {
    const vorher = queue.auftraege.slice();
    mkdirSync(TMP);
    try {
      assert.throws(() => queue.createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: "scheitert" }), /EISDIR/);
    } finally {
      rmSync(TMP, { recursive: true, force: true });
    }
    assert.equal(queue.auftraege.length, vorher.length);
    queue.auftraege.forEach((a, i) => assert.equal(a, vorher[i]));
  });

  it("viele offene: die Höchstzahl darf überschritten werden, kein offener fällt weg", () => {
    const offen = Array.from({ length: 201 }, (_, n) => queue.createAuftrag({ tool: "mail_senden", input: {}, stufe: "extern", summary: `offen ${n}` }));
    // 201 neue plus der begonnene #2: alle abgeschlossenen sind weg, übrig nur offene
    assert.equal(queue.auftraege.length, 202);
    assert.ok(queue.auftraege.every((a) => a.status === "offen"));
    assert.equal(queue.getAuftrag(2)?.gestartetAm, "2026-10-01T08:05:00.000Z");
    for (const a of offen) assert.equal(queue.getAuftrag(a.id), a);
  });
});
