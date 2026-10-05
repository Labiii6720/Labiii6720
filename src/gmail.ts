import { google, type gmail_v1 } from "googleapis";
import { config } from "./config.js";
import { state } from "./state.js";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"];
export const GOOGLE_REDIRECT = "http://localhost:3002/callback";

export function oauthClient() {
  if (!config.gmail) throw new Error("Gmail ist nicht eingerichtet (GOOGLE_OAUTH_CLIENT_ID/SECRET).");
  return new google.auth.OAuth2(config.gmail.clientId, config.gmail.clientSecret, GOOGLE_REDIRECT);
}

function gmail(): gmail_v1.Gmail {
  const refreshToken = state.google?.refreshToken;
  if (!refreshToken) throw new Error("Gmail ist nicht verbunden. Führe zuerst scripts/google-auth.ts aus.");
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth });
}

const header = (msg: gmail_v1.Schema$Message, name: string) =>
  msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

/** Reinen Text aus einer Gmail-Nachricht holen (text/plain, sonst notdürftig aus HTML). */
export function extractText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  const decode = (data?: string | null) => (data ? Buffer.from(data, "base64url").toString("utf8") : "");
  const walk = (part: gmail_v1.Schema$MessagePart, want: string): string => {
    if (part.mimeType === want && part.body?.data) return decode(part.body.data);
    for (const p of part.parts ?? []) {
      const t = walk(p, want);
      if (t) return t;
    }
    return "";
  };
  const plain = walk(payload, "text/plain");
  if (plain) return plain;
  const html = walk(payload, "text/html");
  return html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function searchMails(query: string, max = 10): Promise<string> {
  const g = gmail();
  const list = await g.users.messages.list({ userId: "me", q: query, maxResults: Math.min(max, 20) });
  const ids = list.data.messages ?? [];
  if (ids.length === 0) return "Keine Mails gefunden.";
  const rows: string[] = [];
  for (const m of ids) {
    const full = await g.users.messages.get({ userId: "me", id: m.id!, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
    rows.push(`${m.id} · ${header(full.data, "Date").slice(0, 22)} · ${header(full.data, "From")} · ${header(full.data, "Subject")}\n    ${full.data.snippet ?? ""}`);
  }
  return rows.join("\n");
}

export async function readMail(id: string): Promise<string> {
  const { data } = await gmail().users.messages.get({ userId: "me", id, format: "full" });
  const text = extractText(data.payload).slice(0, 6000);
  return `Von: ${header(data, "From")}\nAn: ${header(data, "To")}\nDatum: ${header(data, "Date")}\nBetreff: ${header(data, "Subject")}\n\n${text}`;
}

export interface Outgoing {
  to: string;
  subject: string;
  text: string;
  /** ID der Mail, auf die geantwortet wird */
  replyToId?: string;
}

/** RFC-822-Nachricht als base64url (exportiert für Tests). */
export function buildRaw(mail: Outgoing, reply?: { messageId: string; references: string }): string {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const lines = [
    `To: ${mail.to}`,
    `Subject: =?UTF-8?B?${b64(mail.subject)}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  ];
  if (reply) {
    lines.push(`In-Reply-To: ${reply.messageId}`, `References: ${reply.references}`);
  }
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n${b64(mail.text)}`).toString("base64url");
}

async function prepare(mail: Outgoing): Promise<{ raw: string; threadId?: string }> {
  if (!mail.replyToId) return { raw: buildRaw(mail) };
  const { data } = await gmail().users.messages.get({ userId: "me", id: mail.replyToId, format: "metadata", metadataHeaders: ["Message-ID", "References"] });
  const messageId = header(data, "Message-ID");
  const references = [header(data, "References"), messageId].filter(Boolean).join(" ");
  return { raw: buildRaw(mail, { messageId, references }), threadId: data.threadId ?? undefined };
}

/** Entwurf in deinem Gmail anlegen – nichts geht raus. */
export async function createDraft(mail: Outgoing): Promise<string> {
  const { raw, threadId } = await prepare(mail);
  const { data } = await gmail().users.drafts.create({ userId: "me", requestBody: { message: { raw, threadId } } });
  return `Entwurf ${data.id} angelegt (an ${mail.to}, Betreff «${mail.subject}»)`;
}

/** Senden – läuft nur nach Freigabe. */
export async function sendMail(mail: Outgoing): Promise<string> {
  const { raw, threadId } = await prepare(mail);
  const { data } = await gmail().users.messages.send({ userId: "me", requestBody: { raw, threadId } });
  return `Gesendet an ${mail.to} (ID ${data.id})`;
}
