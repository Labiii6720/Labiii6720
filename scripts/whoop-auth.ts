/**
 * Einmalig: verbindet Jarvis mit deinem WHOOP-Konto (OAuth 2.0).
 *
 *   npx tsx scripts/whoop-auth.ts
 *
 * Läuft das auf dem Pi ohne Bildschirm, vorher vom PC aus einen SSH-Tunnel öffnen:
 *   ssh -L 3001:localhost:3001 DEINUSER@DEIN-PI
 * und die ausgegebene URL im Browser des PCs öffnen.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { env } from "../src/config.js";
import { storeWhoopTokens, WHOOP_AUTH_URL, WHOOP_TOKEN_URL, type TokenResponse } from "../src/sources.js";

const PORT = 3001;
const REDIRECT_URI = `http://localhost:${PORT}/callback`; // genau so im WHOOP Developer Dashboard eintragen
const SCOPES = "offline read:recovery read:workout"; // nur, was Jarvis braucht
const expectedState = randomBytes(16).toString("hex"); // Schutz gegen untergeschobene Callbacks

const authUrl = new URL(WHOOP_AUTH_URL);
authUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: env("WHOOP_CLIENT_ID"),
  redirect_uri: REDIRECT_URI,
  scope: SCOPES,
  state: expectedState,
})
  .toString()
  .replace(/\+/g, "%20"); // Leerzeichen im Scope als %20, das verstehen alle OAuth-Server

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", REDIRECT_URI);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== expectedState || !code) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Ungültiger Callback (state oder code fehlt).");
    return;
  }
  try {
    const tokenRes = await fetch(WHOOP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: env("WHOOP_CLIENT_ID"),
        client_secret: env("WHOOP_CLIENT_SECRET"),
      }),
    });
    if (!tokenRes.ok) throw new Error(`Token-Tausch fehlgeschlagen: HTTP ${tokenRes.status} ${await tokenRes.text()}`);
    storeWhoopTokens((await tokenRes.json()) as TokenResponse);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("WHOOP ist verbunden. Du kannst das Fenster schliessen.");
    console.log("✅ WHOOP verbunden, Token liegt in data/state.json");
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Fehler, siehe Konsole.");
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Öffne diese URL im Browser und erlaube den Zugriff:\n\n${authUrl}\n`);
});
