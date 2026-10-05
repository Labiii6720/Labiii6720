import { config } from "./config.js";

/**
 * Spracherkennung und Sprachausgabe über OpenAI-kompatible Endpunkte:
 *   STT_URL  z. B. https://api.openai.com/v1/audio/transcriptions oder ein lokaler Whisper-Server
 *   TTS_URL  z. B. https://api.openai.com/v1/audio/speech oder ein lokaler TTS-Server
 */

export async function transcribe(audio: Buffer, filename = "voice.ogg"): Promise<string> {
  if (!config.stt) throw new Error("Spracherkennung ist nicht eingerichtet (STT_URL).");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)]), filename);
  form.append("model", config.stt.model);
  form.append("language", "de");
  const res = await fetch(config.stt.url, {
    method: "POST",
    headers: config.stt.key ? { Authorization: `Bearer ${config.stt.key}` } : undefined,
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Spracherkennung HTTP ${res.status}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

/** Liefert OGG/Opus, damit Telegram es als Sprachnachricht anzeigt. */
export async function speak(text: string): Promise<Buffer> {
  if (!config.tts) throw new Error("Sprachausgabe ist nicht eingerichtet (TTS_URL).");
  const res = await fetch(config.tts.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(config.tts.key ? { Authorization: `Bearer ${config.tts.key}` } : {}) },
    body: JSON.stringify({ model: config.tts.model, voice: config.tts.voice, input: forSpeech(text).slice(0, 3000), response_format: "opus" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Sprachausgabe HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
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
