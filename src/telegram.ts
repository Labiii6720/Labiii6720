import { readFileSync } from "node:fs";
import { audit, throttled } from "./audit.js";
import { basename } from "node:path";
import { addSystemNote, handleMessage, resetHistory, runAuftrag } from "./agent.js";
import { config } from "./config.js";
import { getAuftrag, offeneAuftraege, setStatus, type Auftrag } from "./queue.js";
import { save, state, type Mode } from "./state.js";
import { activeTools, reminders, saveReminders } from "./tools.js";
import { forSpeech, speak, transcribe } from "./voice.js";
import { safePath } from "./workspace.js";
import { eventClip } from "./cameras.js";
import { listVorgaenge, startVorgang } from "./vorgaenge.js";
import { verbrauchBericht } from "./claude.js";
import { aufheben, ausloesen, notfallAktiv } from "./notfall.js";
import { createAuftrag } from "./queue.js";
import { protokolle, runProtokoll } from "./protokolle.js";
import { formatBefund, selbsttest } from "./check.js";
import { abuseSignal } from "./notfall.js";

const API = () => `https://api.telegram.org/bot${config.telegramToken}`;
const owner = () => config.telegramOwner ?? "";
const log = (e: unknown) => console.error(e instanceof Error ? e.message : e);

// ---------- Senden ----------

async function api<T = unknown>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`${API()}/${method}`, {
    method: "POST",
    headers: isForm ? undefined : { "Content-Type": "application/json" },
    body: isForm ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(method === "getUpdates" ? 45_000 : 20_000),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
  return json.result;
}

export async function sendText(text: string, extra: Record<string, unknown> = {}): Promise<number | undefined> {
  let messageId: number | undefined;
  for (let i = 0; i < text.length; i += 4000) {
    const r = await api<{ message_id: number }>("sendMessage", { chat_id: owner(), text: text.slice(i, i + 4000), ...extra });
    messageId = r.message_id;
  }
  return messageId;
}

export async function sendFile(path: string, caption?: string): Promise<void> {
  const full = safePath(path);
  const form = new FormData();
  form.append("chat_id", owner());
  if (caption) form.append("caption", caption.slice(0, 1000));
  form.append("document", new Blob([readFileSync(full)]), basename(full));
  await api("sendDocument", form);
}

export async function sendPhoto(image: Buffer, caption?: string, extra: Record<string, unknown> = {}): Promise<void> {
  const form = new FormData();
  form.append("chat_id", owner());
  if (caption) form.append("caption", caption.slice(0, 1000));
  for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  form.append("photo", new Blob([new Uint8Array(image)]), "bild.jpg");
  await api("sendPhoto", form);
}

export async function sendVideo(video: Buffer, caption?: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", owner());
  if (caption) form.append("caption", caption.slice(0, 1000));
  form.append("video", new Blob([new Uint8Array(video)]), "clip.mp4");
  await api("sendVideo", form);
}

async function sendVoice(audio: Buffer): Promise<void> {
  const form = new FormData();
  form.append("chat_id", owner());
  form.append("voice", new Blob([new Uint8Array(audio)]), "jarvis.ogg");
  await api("sendVoice", form);
}

/** Antwort zusätzlich als Sprachnachricht, falls TTS eingerichtet ist */
export async function sendVoiceReply(text: string): Promise<void> {
  if (!config.tts || !config.telegramToken) return;
  await sendVoice(await speak(forSpeech(text))).catch(log);
}

/** Sprachnachricht des Nutzers laden */
async function downloadVoice(fileId: string): Promise<Buffer> {
  const file = await api<{ file_path: string }>("getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Telegram-Datei HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const typing = () => api("sendChatAction", { chat_id: owner(), action: "typing" }).catch(() => undefined);

// ---------- Freigaben ----------

function freigabeText(a: Auftrag): string {
  const icon = a.stufe === "sensibel" ? "🔴" : "🟠";
  const pin = a.stufe === "sensibel" ? " · Freigabe mit PIN" : "";
  return `${icon} Auftrag #${a.id} · Stufe ${a.stufe}${pin}\n\n${a.summary}`;
}

async function sendAuftrag(a: Auftrag): Promise<void> {
  const id = await sendText(freigabeText(a), {
    reply_markup: { inline_keyboard: [[{ text: "✅ Freigeben", callback_data: `ok:${a.id}` }, { text: "❌ Ablehnen", callback_data: `nein:${a.id}` }]] },
  });
  if (id) {
    a.messageId = id;
    setStatus(a, a.status);
  }
}

export const hooks = { sendFile, sendPhoto, sendVideo, onAuftrag: sendAuftrag };

async function execute(a: Auftrag): Promise<void> {
  try {
    const result = await runAuftrag(a, hooks);
    setStatus(a, "erledigt", result);
    addSystemNote(`Auftrag #${a.id} (${a.tool}) wurde freigegeben und ausgeführt: ${result}`);
    await sendText(`✅ #${a.id} erledigt: ${result}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(a, "fehler", msg);
    addSystemNote(`Auftrag #${a.id} (${a.tool}) wurde freigegeben, schlug aber fehl: ${msg}`);
    await sendText(`⚠️ #${a.id} fehlgeschlagen: ${msg}`);
  }
}

/** Wartet auf die PIN für einen sensiblen Auftrag */
let pendingPin: { id: number; until: number } | undefined;

/** Freigabe von einer anderen Oberfläche (Dashboard). Sensible Aufträge brauchen die PIN im selben Schritt. */
export async function approveAuftrag(a: Auftrag, pin?: string): Promise<string> {
  if (a.status !== "offen") return `#${a.id} ist bereits ${a.status}.`;
  if (state.paused) return "⛔ Notaus aktiv. Erst /weiter.";
  if (a.stufe === "sensibel") {
    if (!config.pin) return "Für sensible Aufträge fehlt eine PIN (JARVIS_PIN).";
    if (pin !== config.pin) {
      audit("pin_falsch", { id: a.id, tool: a.tool, quelle: "dashboard" });
      return "Falsche PIN.";
    }
  }
  if (a.messageId) await api("editMessageReplyMarkup", { chat_id: owner(), message_id: a.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  await execute(a);
  const nachher = getAuftrag(a.id)!; // execute hat den Status gesetzt
  return nachher.status === "erledigt" ? `✅ #${a.id} erledigt: ${nachher.result ?? ""}` : `⚠️ #${a.id}: ${nachher.result ?? "Fehler"}`;
}

export async function denyAuftrag(a: Auftrag): Promise<string> {
  if (a.status !== "offen") return `#${a.id} ist bereits ${a.status}.`;
  audit("auftrag_abgelehnt", { id: a.id, tool: a.tool, quelle: "dashboard" });
  setStatus(a, "abgelehnt");
  addSystemNote(`Auftrag #${a.id} (${a.tool}) wurde vom Nutzer abgelehnt.`);
  if (a.messageId) await api("editMessageReplyMarkup", { chat_id: owner(), message_id: a.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  await sendText(`❌ #${a.id} abgelehnt (Dashboard).`).catch(() => undefined);
  return `❌ #${a.id} abgelehnt.`;
}

async function onCallback(cb: { id: string; data?: string; message?: { message_id: number } }): Promise<void> {
  await api("answerCallbackQuery", { callback_query_id: cb.id }).catch(log);
  const [action, idStr] = (cb.data ?? "").split(":");
  if (action === "clip") {
    try {
      await sendVideo(await eventClip(idStr ?? ""), `🎬 Clip ${idStr}`);
    } catch (e) {
      await sendText(`Clip noch nicht da oder nicht gefunden (${e instanceof Error ? e.message : String(e)}).`);
    }
    return;
  }
  const a = getAuftrag(Number(idStr));
  if (!a) return void sendText("Diesen Auftrag kenne ich nicht mehr.");
  if (cb.message) await api("editMessageReplyMarkup", { chat_id: owner(), message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(log);
  if (a.status !== "offen") return void sendText(`#${a.id} ist bereits ${a.status}.`);
  if (state.paused && action === "ok") return void sendText("⛔ Notaus aktiv. Erst /weiter, dann nochmal freigeben.");

  if (action === "nein") {
    audit("auftrag_abgelehnt", { id: a.id, tool: a.tool });
    setStatus(a, "abgelehnt");
    addSystemNote(`Auftrag #${a.id} (${a.tool}) wurde vom Nutzer abgelehnt.`);
    return void sendText(`❌ #${a.id} abgelehnt.`);
  }
  if (a.stufe === "sensibel") {
    if (!config.pin) return void sendText("Für sensible Aufträge fehlt eine PIN: JARVIS_PIN in .env setzen.");
    pendingPin = { id: a.id, until: Date.now() + 2 * 60_000 };
    return void sendText(`#${a.id} ist sensibel. PIN bitte, innerhalb von zwei Minuten.`);
  }
  await execute(a);
}

// ---------- Befehle ----------

async function onCommand(cmd: string, arg: string): Promise<void> {
  switch (cmd) {
    case "/start":
    case "/hilfe":
      return void sendText(
        "JARVIS, zu Diensten.\n\n/auftraege – offene Freigaben\n/vorgang <Auftrag> – grosse Aufgabe im Hintergrund, starkes Modell\n/vorgaenge – Stand der Vorgänge\n! vor einer Nachricht – starkes Modell für diese Antwort\n/modus normal|fokus|nacht\n/neu – Gespräch vergessen\n/pause – Notaus, /weiter hebt ihn auf\n/notfall – Angriff: alles sperren und alarmieren\n/protokoll <name> – Nacht, Abwesend, Werkstatt …\n/kosten – Tokenverbrauch heute und Monat\n/check – Selbsttest aller Anbindungen\n/status – was läuft",
      );
    case "/auftraege": {
      const offen = offeneAuftraege();
      if (offen.length === 0) return void sendText("Keine offenen Aufträge.");
      for (const a of offen) await sendAuftrag(a);
      return;
    }
    case "/modus": {
      const m = arg.trim().toLowerCase();
      if (!["normal", "fokus", "nacht"].includes(m)) return void sendText(`Aktueller Modus: ${state.mode ?? "normal"}. Setzen mit /modus normal|fokus|nacht`);
      state.mode = m as Mode;
      save();
      return void sendText(`Modus: ${m}.`);
    }
    case "/neu":
      resetHistory();
      return void sendText("Gespräch vergessen. Clean Slate.");
    case "/vorgang": {
      if (!arg.trim()) return void sendText("Benutzung: /vorgang <Auftrag>. Läuft im Hintergrund mit dem starken Modell; /vorgaenge zeigt den Stand.");
      const v = startVorgang(arg.trim(), hooks);
      return void sendText(`🧠 Vorgang #${v.id} gestartet. Fortschritt und Ergebnis folgen hier, der Chat bleibt währenddessen frei.`);
    }
    case "/vorgaenge":
      return void sendText(listVorgaenge());
    case "/kosten":
      return void sendText(verbrauchBericht());
    case "/protokoll": {
      const name = arg.trim().toLowerCase();
      const p = protokolle[name];
      if (!p) return void sendText(`Protokolle: ${Object.keys(protokolle).join(", ") || "keine (protokolle.json)"}`);
      if (p.stufe === "auto") return void sendText(await runProtokoll(name, hooks));
      const a = createAuftrag({ tool: "protokoll_ausfuehren", input: { name }, stufe: p.stufe, summary: `Protokoll «${name}»: ${p.beschreibung}` });
      return sendAuftrag(a);
    }
    case "/notfall":
      await ausloesen("Manuell über Telegram ausgelöst.");
      return;
    case "/entwarnung":
      if (!notfallAktiv()) return void sendText("Es ist kein Notfall aktiv.");
      aufheben();
      return void sendText("✅ Entwarnung. Notfall aufgehoben, Jarvis läuft wieder. Denk daran, erneuerte Tokens einzutragen.");
    case "/pause":
      state.paused = true;
      save();
      audit("pause", {});
      return void sendText("⛔ Notaus. Keine Werkzeuge, Zeitpläne oder Wachen, bis /weiter kommt. Offene Aufträge bleiben offen.");
    case "/weiter":
      state.paused = false;
      save();
      audit("weiter", {});
      return void sendText("▶️ Weiter geht's.");
    case "/check":
      await sendText("Prüfe alle Anbindungen …");
      return void sendText(formatBefund(await selbsttest()));
    case "/status":
      return void sendText(
        `${notfallAktiv() ? "🚨 NOTFALL AKTIV\n" : state.paused ? "⛔ PAUSIERT\n" : ""}Modus: ${state.mode ?? "normal"}\nOffene Aufträge: ${offeneAuftraege().length}\nErinnerungen: ${reminders.length}\nWerkzeuge: ${activeTools().map((t) => t.name).join(", ")}`,
      );
    default:
      return void sendText("Kenne ich nicht. /hilfe zeigt die Befehle.");
  }
}

// ---------- Eingehende Updates ----------

interface Update {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string; voice?: { file_id: string; duration: number } };
  callback_query?: { id: string; data?: string; from: { id: number }; message?: { message_id: number } };
}

export async function handleUpdate(u: Update): Promise<void> {
  if (u.callback_query) {
    if (String(u.callback_query.from.id) !== owner()) return;
    return onCallback(u.callback_query);
  }
  const m = u.message;
  if (!m || (!m.text && !m.voice)) return;
  if (String(m.chat.id) !== owner()) {
    console.warn(`Nachricht von fremdem Chat ${m.chat.id} ignoriert.`);
    audit("fremder_chat", { chat: m.chat.id });
    abuseSignal("telegram");
    if (throttled(`fremd:${m.chat.id}`)) await sendText(`⚠️ Ein fremder Telegram-Chat (${m.chat.id}) hat mir geschrieben. Ich habe nicht geantwortet.`).catch(log);
    return;
  }

  let spoken = false;
  let text = (m.text ?? "").trim();
  if (m.voice) {
    if (!config.stt) return void sendText("Sprachnachrichten kann ich erst verstehen, wenn STT_URL eingerichtet ist.");
    if (m.voice.duration > 120) return void sendText("Das ist mir zu lang, bitte unter zwei Minuten.");
    await typing();
    try {
      text = await transcribe(await downloadVoice(m.voice.file_id));
    } catch (e) {
      return void sendText(`Konnte die Sprachnachricht nicht verstehen: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!text) return void sendText("Da habe ich nichts verstanden.");
    spoken = true;
    await sendText(`🎙 ${text}`);
  }

  if (pendingPin) {
    const p = pendingPin;
    pendingPin = undefined;
    await api("deleteMessage", { chat_id: owner(), message_id: m.message_id }).catch(() => undefined);
    const a = getAuftrag(p.id);
    if (!a || a.status !== "offen") return void sendText("Dieser Auftrag ist nicht mehr offen.");
    if (Date.now() > p.until) return void sendText(`Zeit abgelaufen. /auftraege zeigt #${a.id} nochmal.`);
    if (text !== config.pin) {
      audit("pin_falsch", { id: a.id, tool: a.tool });
      setStatus(a, "abgelehnt", "falsche PIN");
      return void sendText(`Falsche PIN. #${a.id} abgelehnt.`);
    }
    return execute(a);
  }

  if (text.startsWith("/")) {
    const [cmd, ...rest] = text.split(/\s+/);
    return onCommand(cmd.toLowerCase(), rest.join(" "));
  }

  const ticker = setInterval(typing, 4000);
  await typing();
  try {
    const reply = await handleMessage(text, hooks);
    await sendText(reply);
    if (spoken) await sendVoiceReply(reply);
  } catch (e) {
    log(e);
    await sendText(`Da ging etwas schief: ${e instanceof Error ? e.message : String(e)}`).catch(log);
  } finally {
    clearInterval(ticker);
  }
}

// ---------- Hintergrund ----------

export async function remindersTick(): Promise<void> {
  const now = Date.now();
  const due = reminders.filter((r) => Date.parse(r.at) <= now);
  if (due.length === 0) return;
  for (const r of due) await sendText(`⏰ ${r.text}`).catch(log);
  reminders.splice(0, reminders.length, ...reminders.filter((r) => Date.parse(r.at) > now));
  saveReminders();
}

async function poll(): Promise<void> {
  let offset = 0;
  for (;;) {
    try {
      const updates = await api<Update[]>("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u).catch(log);
      }
    } catch (e) {
      log(e);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/** Startet Telegram, falls Token und Chat-ID gesetzt sind. */
export function startTelegram(): void {
  if (!config.telegramToken || !config.telegramOwner) {
    console.log("Telegram nicht konfiguriert (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID), interaktiver Jarvis aus.");
    return;
  }
  console.log(`Telegram aktiv, Werkzeuge: ${activeTools().map((t) => t.name).join(", ")}`);
  void poll();
  setInterval(() => remindersTick().catch(log), 30_000);
}
