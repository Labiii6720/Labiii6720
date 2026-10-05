/**
 * Einmalig: verbindet Jarvis mit deinem Gmail (OAuth 2.0, nur lesen und Entwürfe/Senden).
 *
 *   npx tsx scripts/google-auth.ts
 *
 * Auf dem Pi ohne Bildschirm vorher vom PC aus: ssh -L 3002:localhost:3002 DEINUSER@DEIN-PI
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { GMAIL_SCOPES, GOOGLE_REDIRECT, oauthClient } from "../src/gmail.js";
import { save, state } from "../src/state.js";

const client = oauthClient();
const expectedState = randomBytes(16).toString("hex");
const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: GMAIL_SCOPES, state: expectedState });

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", GOOGLE_REDIRECT);
  if (u.pathname !== "/callback") return void res.writeHead(404).end();
  const code = u.searchParams.get("code");
  if (u.searchParams.get("state") !== expectedState || !code) {
    return void res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Ungültiger Callback.");
  }
  try {
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) throw new Error("Kein Refresh-Token erhalten. In der Google-Kontoverwaltung den Zugriff der App entfernen und nochmal versuchen.");
    state.google = { refreshToken: tokens.refresh_token };
    save();
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Gmail ist verbunden. Du kannst das Fenster schliessen.");
    console.log("✅ Gmail verbunden, Token liegt in data/state.json");
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Fehler, siehe Konsole.");
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(3002, "127.0.0.1", () => console.log(`Öffne diese URL im Browser und erlaube den Zugriff:\n\n${url}\n`));
