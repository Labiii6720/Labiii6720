import { config } from "./config.js";
import { fehlerArt, HttpFehler, mitWiederholung, retryAfterAusHeader, voruebergehend, type WiederholOptionen } from "./robust.js";

/**
 * Spracherkennung und Sprachausgabe über OpenAI-kompatible Endpunkte:
 *   STT_URL  z. B. https://api.openai.com/v1/audio/transcriptions oder ein lokaler Whisper-Server
 *   TTS_URL  z. B. https://api.openai.com/v1/audio/speech oder ein lokaler TTS-Server
 */

/** Nur für Tests: Warten und Zufall des Backoffs injizieren (im Betrieb leer). */
export const _testOptionen: Pick<WiederholOptionen, "warten" | "zufall"> = {};

/**
 * STT/TTS sind POST, aber ohne Nebenwirkung (reine Umwandlung): ein zweiter Versuch bei Netz-, Rate- und
 * Serverfehlern. Nicht bei Zeitlimit – nach 60 s Warten wäre eine zweite Minute für eine Sprachnachricht zu lang.
 */
const SPRACHE = { versuche: 2, wiederholen: (e: unknown) => voruebergehend(e) && fehlerArt(e) !== "zeitlimit" };

export async function transcribe(audio: Buffer, filename = "voice.ogg"): Promise<string> {
  const stt = config.stt;
  if (!stt) throw new Error("Spracherkennung ist nicht eingerichtet (STT_URL).");
  const data = await mitWiederholung("stt", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)]), filename);
    form.append("model", stt.model);
    form.append("language", "de");
    const res = await fetch(stt.url, {
      method: "POST",
      headers: stt.key ? { Authorization: `Bearer ${stt.key}` } : undefined,
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new HttpFehler(`Spracherkennung HTTP ${res.status}`, res.status, retryAfterAusHeader(res.headers));
    return (await res.json()) as { text?: string };
  }, { ...SPRACHE, komponente: "stt", ..._testOptionen });
  return (data.text ?? "").trim();
}

/** Liefert OGG/Opus, damit Telegram es als Sprachnachricht anzeigt. */
export async function speak(text: string): Promise<Buffer> {
  const tts = config.tts;
  if (!tts) throw new Error("Sprachausgabe ist nicht eingerichtet (TTS_URL).");
  return mitWiederholung("tts", async () => {
    const res = await fetch(tts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(tts.key ? { Authorization: `Bearer ${tts.key}` } : {}) },
      body: JSON.stringify({ model: tts.model, voice: tts.voice, input: forSpeech(text).slice(0, 3000), response_format: "opus" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new HttpFehler(`Sprachausgabe HTTP ${res.status}`, res.status, retryAfterAusHeader(res.headers));
    return Buffer.from(await res.arrayBuffer());
  }, { ...SPRACHE, komponente: "tts", ..._testOptionen });
}

/** Text so umbauen, dass er vorgelesen gut klingt: keine Links, kein Markdown, keine Tabellen. */
export function forSpeech(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "Link")
    .replace(/[*_`#>|]+/g, " ")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
