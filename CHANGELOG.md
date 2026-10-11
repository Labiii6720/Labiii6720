# Änderungen

Kurz und nur das Wichtigste. Details stehen im README.

## 0.21
- Werkstatt-Slicer: Mit PrusaSlicer (`PRUSASLICER_PATH`, sonst Suche über apt, `~/.local/bin` und Flatpak zuletzt) und einem exportierten Profil (`SLICER_PROFIL`, `.ini`) slict `cad_drucken` die STL vor dem Upload und schickt G-Code an OctoPrint. Ohne Slicer geht wie bisher die STL, mit Hinweis. Ein fertiger `.gcode` geht direkt. Die Freigabe-Nachricht nennt, ob G-Code oder STL. Scheitert das Slicen, wird nicht gedruckt.
- Neues Werkzeug `cad_slicen` (extern): erzeugt nur `<name>.gcode` im Arbeitsordner und meldet Dauer, Grösse, geschätzte Druckzeit, Filament und Schichten.
- Zeitlimit `SLICER_TIMEOUT_MS` (Standard 10 Minuten). Es läuft nur ein Slicer zugleich, ohne Wiederholen und ohne Geheimnisse in der Umgebung. Der alte G-Code wird vorher gelöscht. Binärer G-Code wird abgelehnt. Fehler nennen die letzten Log-Zeilen.
- Slicer und Drucker nehmen nur Dateien, die wirklich im Arbeitsordner liegen; Verknüpfungen nach aussen werden abgelehnt. `npm run check` hat den neuen Befund «Slicer», der Assistent fragt die drei Schlüssel im Abschnitt `werkstatt` ab.
- Die Freigabe hält fest, ob G-Code oder STL gedruckt wird; ist der Slicer beim Tippen nicht mehr nutzbar, bricht der Druck ab. Notaus oder Notfall während Rendern/Slicen verhindern den Upload, die Datei bleibt liegen; der Upload an OctoPrint prüft das zusätzlich für alle Aufrufer.
- Ein fertiger G-Code ist an die Freigabe gebunden: `cad_drucken` nimmt nur G-Code aus `cad_slicen` (Prüfsumme in `data/slicer-gcode.json`), die Freigabe nennt Herkunft, Angaben und Prüfsumme, und der Upload prüft die Prüfsumme auf genau den hochgeladenen Inhalt.

## 0.20
- Satellit: Entitäten «Lautstärke» (0–100, gespeichert, Start 60), «Nachtmodus» (Lautstärke 30, LED gedimmt, vorherige Lautstärke kommt zurück) und «Ton-Feedback». Kurzer Doppelton beim Wakeword vor dem Zuhören, tieferer Ton bei Fehlern; die Töne erzeugt `esphome/tools/ton.mjs` als `esphome/ton.yaml` (7680 Bytes im Flash).
- Zweiter Satellit im Bad (`jarvis-satellit-bad.yaml`); das Gemeinsame steht in `jarvis-satellit-basis.yaml`, beide Satelliten binden es als Paket ein. Entitätsnamen des ersten bleiben. Antworten und Ansagen laufen über einen internen Media-Player.
- Briefing nach der Dusche: neues Ereignis `briefing_text` liefert das Briefing synchron als Vorlesetext ohne Telegram (`kopie: telegram` optional, nur Heimnetz, Audit `briefing_satellit`). Home Assistant sagt es per `assist_satellite.announce` im Bad an, ohne Satellit wie bisher per Telegram. Ist das Briefing noch nicht fertig, sagt der Satellit nichts an und Jarvis liefert es innerhalb von 10 Minuten per Telegram nach, sonst mit kurzem Hinweis; Notaus und Notfall stoppen die Nachlieferung, das Ereignis `briefing` und die erste Telegram-Kopie. Beispiel-Automationen für Nachtmodus und Lautstärke.
- `briefing_text` weist im Notaus/Notfall ab (keine Briefing-Daten, kein Claude-Aufruf).
- ESPHome: `esphome config` lief bei Node 1 und Satellit nicht durch; `ota` nutzt jetzt `ota_password` (neu in `secrets.yaml`), LED mit `rgb_order`.

## 0.19
- Alexa liest offene Freigaben vor: am Ende des Tagesbriefings nach kurzer Pause (höchstens drei Aufträge mit Nummer und gekürzter Zusammenfassung, Rest gezählt, immer frisch statt aus dem Cache) und direkt mit «frag Butler Jarvis nach offenen Aufträgen» (neuer `FreigabenIntent`, Interaction Model neu einspielen). Telegram-Kopie und Sprachnachricht enthalten den Hinweis als Klartext.
- Per Stimme wird nie etwas freigegeben: Sätze wie «gib Auftrag 12 frei» gehen nicht an Claude, Antwort «Freigaben nehme ich nur per Telegram oder Dashboard entgegen» (Dashboard nur genannt, wenn es mit `JARVIS_EVENT_TOKEN` wirklich läuft). Das Briefing-Modell zählt die Freigaben nicht mehr selbst.
- Nachtstimme: im Fenster `ALEXA_NACHT` (Standard `22:00-06:30`, `off` = aus) und im Nachtmodus spricht Alexa leiser und etwas langsamer. Alle Ausgaben laufen über ein gemeinsames, vollständig escapetes SSML; `npm run check` meldet ein ungültiges Fenster.

## 0.18
- Finanz-Wochenbericht: wöchentlich um `FINANZBERICHT` (Standard `mo 07:45`, `off` = aus) per Telegram: offen (Summe je Währung, Schweizer Format), überfällig und fällig in 7 Tagen (je höchstens 5), bezahlt letzte Woche, Summe pro Monat der letzten sechs Monate. Ohne Claude, keine Tokens; ohne Rechnungen still; Zahlungen werden nie ausgelöst.
- Sofort mit `/finanzen`, fürs Dashboard als JSON unter `GET /api/finanzen` (nur Heimnetz/Tailscale, Token, ohne IBAN und Referenz). Im Notfall gibt es keine Finanzdaten.
- Rechnungen merken sich beim Abhaken als bezahlt das Datum (`bezahltAm`), damit Zahlungen im richtigen Monat zählen.

## 0.17
- Gedächtnis-Verdichtung: nachts um `VERDICHTUNG` (Standard 03:30, `off` = aus) führt Haiku doppelte Fakten zusammen, markiert überholte mit Grund als veraltet, fasst Notizen älterer Monate je Monat zusammen und alte Entscheidungen (`VERDICHTUNG_TAGE`, Standard 90) in eine Monats-Chronik. Der Vorschlag wird geprüft und bei jedem Verstoss ganz verworfen; nichts wird gelöscht, Originale stehen in `data/profil-archiv.jsonl`. `/verdichten` sofort, `/verdichten vorschau` ändert nichts.
- Fakten mit Datum und Nummer (`seit`, Herkunft, Veraltet-Vermerk), neues Werkzeug `fakt_merken`, `profil_vergessen` auch per Nummer. Alte Profile werden beim Start umgestellt, die alte Datei vorher nach `data/profil.vor-0.17.json` gesichert; eine unlesbare `profil.json` wird nach `data/profil.json.defekt` kopiert und nie überschrieben (Speichern und Verdichtung verweigert). Entscheidungs- und Faktnummern bleiben eindeutig (auch nach Zusammenführen und Vergessen). Ein vergessener Chronik-Monat verschwindet auch aus dem Archiv; `profil_anzeigen` listet alle Chronik-Monate.
- Prompt: «Dauerhafte Fakten (seit): …» mit Datum, veraltete ausgeblendet, Chronik der letzten drei Monate.

## 0.16
- Robustheit: Fehler werden eingeordnet (Netz, Zeitlimit, Rate-Limit, Server, Zugang) und vorübergehende mit Backoff wiederholt – Claude (3 langsame Anläufe über dem SDK), Telegram-Senden (4×), Home Assistant lesen (3×), Frigate, Wetter, Kalender, WHOOP, Shopify-Abfragen, Stimme (2×). Schaltbefehle nur, wenn die Anfrage HA nie erreicht hat; `toggle`, Schritte, `press`, `trigger`, Mails, Shopify-Änderungen und Drucker-Uploads nie.
- Internetausfall: Telegram-Polling mit Backoff bis 60 s (409/401 einmal klar geloggt), Zeitpläne, Rückblick, Rechnungen und Zielcheck gelten erst nach Erfolg als gelaufen und werden im Nachholfenster `ZEITPLAN_NACHHOLEN_MIN` (Standard 60) nachgeholt. Der letzte Lauf steht persistent in `data/routinen.json` – kein Doppellauf nach Neustart im Nachholfenster.
- Postausgang `data/postausgang.json`: nicht zustellbare Meldungen werden nachgereicht («(nachgereicht, 14:32)»). Der Notfall-Alarm und Antworten auf Freigaben gehen mit Vorrang (sofort, bei Störung vorn eingereiht); während eines Notfalls bleibt älterer Inhalt liegen bis zur Entwarnung.
- Notaus greift sofort: `/pause` und `/notfall` warten nicht hinter einer laufenden Anfrage, Werkzeuge einer Antwort, die erst nach dem Notaus eintrifft, laufen nicht mehr, und weder Chat-Antwort noch Vorgangs-Ergebnis gehen danach noch hinaus. Erster Start ohne `data/routinen.json`: was heute schon dran war, gilt als erledigt.
- Zeitpläne: Nach reinen Lesewerkzeugen wird ein vorübergehend gescheiterter Lauf im Nachholfenster wiederholt, nach Werkzeugen mit Wirkung nicht.
- Notfall: nur `/entwarnung` hebt auf, der Pausiert-Hinweis nennt im Notfall `/entwarnung`; ein vor dem Notaus eingereihtes `/weiter` oder `/entwarnung` gilt nicht – auch nicht bei Auslösung über Panik-Endpunkt, Dashboard oder automatisch. Vorgangs-Ergebnisse und Freigabe-Ergebnisse werden im Notfall weder gesendet noch im Postausgang abgelegt.
- Freigaben: Startvermerk `gestartetAm` vor der Ausführung – nach einem Absturz mitten im Werkzeug wird ein Auftrag nicht nochmals ausgeführt, sondern als «Ergebnis unklar» gemeldet.
- Watchdog: Gesundheit je Anbindung (Telegram-Empfang getrennt vom Senden), Meldung nach `WATCHDOG_MINUTEN` (Standard 10) genau einmal, Erholung wird gemeldet, bei Internetausfall eine Sammelmeldung; `/check` und `/status.json` zeigen den Stand. Klare Nutzertexte statt roher Fehler, Geheimnisse werden aus Logs geschwärzt. `npm run check` lädt schwere Module erst bei Bedarf (schnellere Prüfung im Einrichtungs-Assistenten).

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
