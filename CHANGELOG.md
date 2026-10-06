# Änderungen

Kurz und nur das Wichtigste. Details stehen im README.

## 0.15
- Einrichtungs-Assistent `npm run setup`: führt Abschnitt für Abschnitt durch die `.env`, erzeugt Tokens (wie `openssl rand -hex 24`), sichert die alte Datei als `.env.bak` und prüft jede Anbindung sofort.
- Selbsttest einzeln: `npm run check -- --nur Telegram,Frigate`.
- Test-Infrastruktur `npm test` (Node-Testläufer, Attrappen statt echter Dienste) mit ersten Tests für Assistent und Selbsttest.

## 0.14.1
- CLAUDE.md für die Weiterarbeit in Claude Code: Architektur, Leitplanken, Arbeitsweise, offener Plan.

## 0.14
- Selbsttest aller Anbindungen: `npm run check` und `/check` (grün/fehlt/rot), inkl. Sicherheits-Check. Kostet keine Tokens.
- Proaktiv: tägliche Rechnungs-Erinnerung vor Fälligkeit, wöchentlicher Zielcheck, Tagesrückblick (Lernen über dich).
- Token-Effizienz: Hintergrundarbeit nutzt das günstige Modell, Gesprächsverlauf wird auch nach Grösse gekürzt (zusätzlich zum bestehenden Prompt-Caching und `/kosten`).
- Stimme im Raum: ESP32-S3-Satellit mit lokalem Wakeword «Hey Jarvis» und Home-Assistant-Integration, die die Sprach-Pipeline an Jarvis weiterreicht.

## 0.13
- Kommandozentrale unter /dashboard: Aufträge freigeben (mit PIN), Rechnungen, Protokolle, Ziele, Vorgänge, Kamerabilder, Chat, Audit und Notfall-Knopf – nur Heimnetz/Tailscale und tokengeschützt.
- Protokolle (benannte Abläufe wie Nacht, Abwesend, Werkstatt, Clean Slate) in `protokolle.json`, mit eigener Freigabe-Stufe; `/protokoll <name>`.
- Werkstatt: 3D-Teile als OpenSCAD entwerfen, rendern, selbst ansehen, per OctoPrint drucken (mit PIN).
- Klarstellung Notfall: nur Abwehr (isolieren, sperren, alarmieren), kein Zurückhacken.

## 0.12
- Finanzüberblick: Rechnungen aus Mails erkennen (Betrag, IBAN mit Prüfziffer, Referenz, Fälligkeit), Fristen im Blick, Zahlung vorbereiten – aber nie auslösen (du zahlst in der Bank-App).
- Mail-Triage nach Dringlichkeit und deinen Zielen.
- Ehrlicher Berater: misst Entscheidungen an deinen Zielen, widerspricht direkt bei Konflikt – bewertet Entscheidungen, nicht den Charakter; Muster nur mit Belegen.
- Lernen über dich in `data/profil.json` (Ziele, Werte, Muster, Entscheidungen) – kein Selbstumbau von Code/Regeln.
- Notfall-Protokoll (`/notfall`, Panik-Endpunkt, Auto-Auslösung bei Angriffsmuster): isolieren, alarmieren, Spuren sichern. Kein Zurückhacken (illegal und wirkungslos).

## 0.11
- Jarvis unterwegs: Siri-Kurzbefehl über Tailscale (iPhone, Apple Watch, CarPlay, AirPods); Antworten für Stimme gekürzt, zu lange Antworten kommen per Telegram nach.
- `frage_sync` mit Zeitbudget und Kanal «stimme»; neues Ereignis `kontext` (Ort, Fokus, Auto) setzt Modus und Gesprächskontext.

## 0.10
- Persona in `src/persona.ts`: Jarvis spricht und denkt wie im Film (ruhig, präzise, trockener Humor, widerspricht wenn nötig) – gilt für Chat, Alexa, Briefing, Cardio, Vorgänge.
- Anrede «Sir» und Sie-Form als Standard, umschaltbar mit `JARVIS_ANREDE` und `JARVIS_FORM`.
- Feste Texte (Alexa, Telegram-Befehle, Cardio) an den Ton angepasst.

## 0.9.1
- CHANGELOG.md hinzugefügt; ab jetzt wird jede Version hier und im Chat kurz beschrieben.

## 0.9
- Starkes Modell auf Zuruf: `!` vor einer Nachricht (Standard Opus 5.5, bis 40 Werkzeugrunden).
- `/vorgang`: grosse Aufgaben laufen im Hintergrund mit eigener Historie, Fortschritt und Ergebnis per Telegram; `/vorgaenge` zeigt den Stand.
- Loop-Limits und Modelle in `.env` einstellbar.

## 0.8.1
- Prompt Caching für Werkzeugdefinitionen und festen Systemprompt (Chat-Kosten grob halbiert).

## 0.8
- Härtung: `/events` und `/gesture` nur noch aus dem Heimnetz, URL-Wächter gegen Datenabfluss, Zeitpläne und Wachen anlegen braucht Freigabe.
- Notaus `/pause` und `/weiter`, Alarm bei fremden Chats und falschen Tokens, Revisionsprotokoll `data/audit.log`.
- Gehärtete `jarvis.service` (eigener Benutzer, nur `data/` und `workspace/` beschreibbar).
- Sicherheitskonzept im README: Bedrohungsmodell, Checkliste, Widerrufsplan.

## 0.7
- Kameras über Frigate: `cameras.json` mit Funktionen pro Kamera (schauen, melden, wachen).
- Meldungen mit Bild und Clip-Button, Bedingungen (immer, abwesend, nacht), Ruhezeiten; Wachen mit Ja/Nein-Fragen.
- Werkzeuge `kamera_*` und `wache_*`, MQTT-Anbindung, Beispiel-Frigate-Konfiguration.

## 0.6
- Gesten- und Sprachkonsole unter `/gesture`: Handtracking per Webcam, Partikelkugel, Gesten senden Befehle, Sprechen und Vorlesen im Browser.
- `frage_sync` für direkte Antworten an die Konsole.

## 0.5
- Erstes eigenes Gerät «Jarvis Node 1» (ESP32, ESPHome): Temperatur, Luftfeuchte, Luftdruck, Relais, Taster, Dusch-Erkennung.
- Rückkanal `/events`: Home Assistant kann Jarvis anstossen; Briefing nach der Dusche automatisch.
- Home-Assistant-Paket mit Automationen.

## 0.4
- Echter Browser (Chromium): Seiten öffnen, tippen, klicken, Screenshots; `seite_lesen` ohne Browser.
- Freie Fragen per Alexa mit Zeitbudget und Übergabe an Telegram.
- Sprachnachrichten auf Telegram (STT/TTS über OpenAI-kompatible Endpunkte).
- Zeitpläne: wiederkehrende Aufgaben, die Jarvis allein erledigt.

## 0.3
- Interaktiver Jarvis per Telegram mit Werkzeugen: Mails und Kalender, Code und Websites, Shopify, Smart Home, Websuche, Erinnerungen, Notizen.
- Freigabe-Warteschlange mit Stufen auto/extern/sensibel, Buttons und PIN; Modi normal/fokus/nacht.

## 0.2
- Alexa-Skill «Butler Jarvis»: Cardio aus der WHOOP-Recovery nach dem Wecker, Tagesbriefing nach dem Duschen.
- Outlook-Arbeitskalender als ICS (standardmässig nur belegte Zeiten), WHOOP-Anbindung, Cloudflare Tunnel, systemd-Dienst.

## 0.1
- Morgenbriefing per Telegram: Wetter und Google-Kalender, von Claude formuliert, per Cronjob.
