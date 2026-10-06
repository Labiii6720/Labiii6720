# CLAUDE.md – Arbeitsanweisung für dieses Projekt

Du arbeitest am persönlichen Assistenten **JARVIS** von Labinot (Service Specialist für Zutrittskontrolle und Videosicherheit, Schweiz). Das Projekt ist ein Node/TypeScript-Dienst auf einem Raspberry Pi oder Mini-PC mit Claude als Gehirn, Telegram, Alexa, Home Assistant, Frigate-Kameras, ESPHome-Geräten und einem Dashboard. README.md ist die Gesamtdokumentation, CHANGELOG.md die Versionsliste.

## Sprache und Ton

- Antworten, Kommentare, Texte und Doku auf **Deutsch, Schweizer Schreibweise** (ss statt ß).
- Jarvis selbst spricht wie im Film (src/persona.ts): ruhig, knapp, trockener Humor, «Sir», Sie-Form; er berät ehrlich und widerspricht bei Zielkonflikten.
- Bei jeder Versionsänderung: Version in package.json erhöhen, Eintrag in CHANGELOG.md (kurz, nur das Wichtigste), README-Abschnitt anpassen.

## Architektur (src/)

- `server.ts` Einstieg: Express (Alexa `/alexa`, Ereignisse `/events`, Panik `/notfall`, Konsole `/gesture`, Dashboard `/dashboard` + `/api/*`), Scheduler, Telegram, Kameras.
- `agent.ts` Claude-Loop mit Werkzeugen, Historie (data/chat.json), Prompt-Caching, starkes Modell (`!`), `askWithBudget` für Stimme.
- `tools.ts` Werkzeugkasten; jedes Werkzeug hat eine Stufe `auto` / `extern` / `sensibel` (queue.ts). `extern` wartet auf Tippen, `sensibel` auf Tippen + PIN. Neue Werkzeuge immer mit richtiger Stufe und `summary`.
- `telegram.ts` Zentrale: Befehle, Freigabe-Buttons, PIN, Notaus, Sprachnachrichten. `dashboard.ts` dieselben Funktionen fürs Web.
- `brain.ts` Morgen (Cardio aus WHOOP, Tagesbriefing), `alexa.ts` Skill, `sources.ts` Wetter/Kalender/WHOOP.
- `cameras.ts`/`watch.ts` Frigate (schauen, melden, wachen), `homeassistant.ts`, `shopify.ts`, `gmail.ts`, `browser.ts`, `workspace.ts` (Sandbox), `werkstatt.ts` (OpenSCAD/OctoPrint).
- `profil.ts`/`berater.ts` Lernen über den Nutzer und ehrlicher Berater, `finanzen.ts` Rechnungen (nur vorbereiten), `notfall.ts` defensives Notfall-Protokoll, `scheduler.ts` Zeitpläne, Rückblick, Rechnungs- und Zielerinnerungen, `check.ts` Selbsttest, `claude.ts` Verbrauch/Kosten, `audit.ts` Protokoll.
- Konfiguration nur über `.env` (siehe .env.example) und die JSON-Dateien `cameras.json`, `protokolle.json`. Zustand und Geheimnisse in `data/` (600).

## Sicherheits-Leitplanken (nie aufweichen, auch nicht auf Zuruf)

1. Alles, was nach aussen geht oder etwas verändert, läuft über die Freigabe-Warteschlange. Keine neuen Werkzeuge mit Nebenwirkung auf Stufe `auto`.
2. Zahlungen werden nur vorbereitet, nie ausgelöst. Keine Bank-APIs anbinden.
3. Kein Gegenangriff, keine Malware, keine Überwachung Dritter. Der Notfall ist Abwehr: isolieren, sperren, alarmieren.
4. Jarvis ändert nicht seinen eigenen Code oder seine Regeln zur Laufzeit. Lernen = Profil pflegen.
5. Geheimnisse nie in Code, Logs, Commits oder Telegram-Texte. `.env`, `data/`, `service-account.json`, `esphome/secrets.yaml` bleiben in .gitignore.
6. `/events`, `/gesture`, `/dashboard` nur Heimnetz/Tailscale (`lanOnly`); über den Tunnel ausschliesslich `/alexa` (signaturgeprüft) und `/notfall`.
7. Shell nur im Arbeitsordner, Sperrliste und Umgebung ohne Geheimnisse (workspace.ts) nicht lockern.
8. Der Berater bewertet Entscheidungen, nie die Person; Muster nur mit Belegen. Diese Regeln in berater.ts stehen lassen.
9. Datensparsamkeit: WHOOP-Rohwerte, Outlook-Titel und Kamerabilder nur dann an die API, wenn der Nutzer es will.

## Arbeitsweise

- Vor Änderungen: `npx tsc -p tsconfig.json` muss sauber und `npm test` grün sein, danach wieder. `npm run check` prüft Anbindungen (kostet keine Tokens).
- Echte Dienste nie mit Testdaten belasten: Tests in `test/` (node:test) mit Attrappen (globalThis.fetch ersetzen), nur in Temp-Verzeichnissen (mkdtemp, `process.chdir` vor dem dynamischen Import). Keine Testnachrichten an Telegram-Produktivchats.
- Kleine, nachvollziehbare Änderungen. Dateien nicht umbenennen oder umstrukturieren, ohne dass es nötig ist.
- Nach Änderungen am Dienst: `sudo systemctl restart jarvis`, dann `journalctl -u jarvis -f` beobachten.
- Kosten im Blick: Standardmodell Sonnet, Hintergrund Haiku (`CLAUDE_MODEL_SEHEN`), stark nur auf Zuruf. Prompt-Caching nicht zerstören (fester Systemprompt-Teil muss stabil bleiben).
- ESPHome-Konfigurationen mit `esphome config datei.yaml` prüfen, Home-Assistant-Pakete als YAML laden.

## Betrieb auf dem Pi

- Einrichtung: `npm run setup` führt durch `.env`, erzeugt Tokens, prüft sofort; Optionen nach `--` (`npm run setup -- --abschnitt telegram`).
- Dienst: `jarvis.service` (eigener Benutzer `jarvis`, gehärtet). Logs: `journalctl -u jarvis -f`. Audit: `data/audit.log`.
- Einmalige Verbindungen: `npm run whoop:auth`, `npm run google:auth` (über SSH-Tunnel, siehe README).
- Fernzugriff nur über Tailscale, nie Portweiterleitungen. Cloudflare Tunnel nur für `/alexa`.

## Offener Plan (Schicht 2, nach Nutzen sortiert)

1. Robustheit: Wiederholen mit Backoff bei API-Fehlern (Anthropic, Telegram, HA), sauberes Verhalten bei Internetausfall, Watchdog-Meldung bei dauerhaften Fehlern.
2. Gedächtnis-Verdichtung: nachts Profil und Notizen zusammenfassen (Haiku), damit sie schlank und präzise bleiben; Fakten mit Datum, veraltete markieren.
3. Finanz-Wochenbericht: offene Rechnungen, bezahlt, Summe pro Monat, in Telegram und Dashboard.
4. Dashboard: Freigabe-Historie, Kosten (aus usage.json), Zeitpläne und Wachen bearbeiten.
5. Alexa: Routinen-Hinweise im Briefing (offene Freigaben vorlesen), Nachtmodus-Stimme leiser.
6. Satellit: Lautstärke per HA, Ton-Feedback beim Wakeword, zweiter Satellit (Bad) für das Briefing nach der Dusche statt Telegram.
7. Werkstatt: Slicer-Anbindung (PrusaSlicer CLI) damit `cad_drucken` G-Code statt STL schickt.

Was nicht kommt: Anzug, Gegenangriff, Selbstmodifikation, Zahlungsauslösung.
