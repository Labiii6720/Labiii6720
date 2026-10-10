# JARVIS

Drei Etappen in einem Dienst:

- **Etappe 1** – Morgenbriefing per Telegram (`briefing.ts`, jetzt Teil des Dienstes)
- **Etappe 2** – Alexa-Skill mit WHOOP-Cardio und Tagesbriefing (Abschnitte «So läuft dein Morgen» bis 7)
- **Etappe 3** – Interaktiver Jarvis per Telegram mit Werkzeugen und Freigabe-Warteschlange (Abschnitt 8)
- **Etappe 4** – Browser, freie Fragen per Alexa, Sprachnachrichten und selbständige Zeitpläne (Abschnitt 9)
- **Etappe 5** – Erstes eigenes Gerät: ESP32 mit ESPHome, Home Assistant und Ereignisse zurück an Jarvis (Abschnitt 10)
- **Etappe 6** – Gesten- und Sprachkonsole: Handtracking per Webcam, Partikelkugel, Gesten und Sprache an Jarvis (Abschnitt 11)
- **Etappe 7** – Kameras: Frigate als lokaler Rekorder, Jarvis als Auge mit Meldungen, Wachen und Clips (Abschnitt 12)
- **Etappe 8** – Härtung (Abschnitt Sicherheitskonzept) sowie starkes Modell und Vorgänge für grosse Aufgaben (Abschnitt 13)
- **Etappe 9** – Persona (Abschnitt 14) und Jarvis unterwegs über Siri, Uhr, Auto und AirPods (Abschnitt 15)
- **Etappe 10** – Die Seele: Finanzüberblick, Mail-Triage, ehrlicher Berater, Lernen über dich und ein defensives Notfall-Protokoll (Abschnitt 16)
- **Etappe 11** – Der Rest aus dem Film: Protokolle (17), Werkstatt mit 3D-Druck (18) und die Kommandozentrale (19)
- **Etappe 12** – Feinschliff: Selbsttest, Proaktivität (Rechnungen, Rückblick, Zielcheck), Token-Effizienz und die Stimme im Raum (Abschnitt 20)
- **Etappe 13** – Einrichtungs-Assistent und Tests (Abschnitt 1 und Tests)

## So läuft dein Morgen

1. **05:30** klingelt der normale Alexa-Wecker. Sobald du ihn ausschaltest, startet eine Routine den Skill «Butler Jarvis». Er liest deine WHOOP-Recovery und sagt dir dein Cardio: grün = Intervalle, gelb = lockeres Zone 2, rot = Spaziergang oder Pause.
2. **Im Hintergrund** holt der Pi zwischen 05:00 und 10:00 alle 5 Minuten Wetter, Recovery und Workouts. Ab 05:45 bereitet er das Tagesbriefing vor. Hat WHOOP dein Training erkannt, baut er es mit einer kurzen Trainingsbilanz neu.
3. **Nach dem Duschen** sagst du «Alexa, ich bin bereit». Jarvis liest dir deine Termine aus Google und Outlook vor, priorisiert und mit Hinweis auf Überschneidungen. Optional kommt eine Textkopie auf Telegram.

```
Echo ─ Routine ─> Alexa-Cloud ─ HTTPS ─> Cloudflare ─ Tunnel ─> Pi: Jarvis (127.0.0.1:3000)
                                                                ├─ WHOOP API
                                                                ├─ Google Kalender, Outlook-ICS
                                                                ├─ Open-Meteo
                                                                └─ Claude
```

Warum der Pi vorausrechnet: Ein Alexa-Skill muss in rund 8 Sekunden antworten. Das Tagesbriefing liegt deshalb schon fertig bereit, wenn du fragst.

## Was du brauchst

- Raspberry Pi oder Mini-PC mit Node.js 22 oder neuer, der rund um die Uhr läuft
- Echo-Gerät und ein Amazon-Developer-Konto mit **demselben** Login wie dein Echo (kostenlos)
- WHOOP-Konto
- Eine eigene Domain, deren DNS bei Cloudflare liegt (für den Tunnel)
- Aus Etappe 1: Claude-API-Key, optional Google-Dienstkonto und Telegram-Bot

Den Cronjob aus Etappe 1 kannst du entfernen, Jarvis übernimmt das jetzt.

## 1. Installation

Empfohlen ist der Einrichtungs-Assistent. Er fragt jede Einstellung aus `.env.example` ab, erzeugt die Geheimnisse selbst und prüft jede Anbindung sofort:

```bash
# Projektordner auf den Pi kopieren, dann:
cd ~/jarvis
npm ci
npm run setup
```

So läuft er ab:

- Abschnitt für Abschnitt: zuerst die Pflicht (Grundlagen, Claude, Telegram, Sicherheit), dann die optionalen (Alexa, WHOOP, Wetter, Kalender, Gmail, Shopify, Home Assistant, Kameras, Stimme, Werkstatt, Proaktivität). Optionale Abschnitte fragen zuerst «Jetzt einrichten? [j/N]».
- Pro Feld: Enter übernimmt den bestehenden Wert oder den Vorschlag, `-` leert das Feld, Strg-C bricht ab. Ungültige Eingaben (etwa eine Chat-ID mit Buchstaben) weist er mit Begründung ab; nach drei Fehlversuchen bleibt der alte Wert. Pflicht sind nur `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` und `JARVIS_PIN`.
- Bestehende Geheimnisse zeigt er nur maskiert (auch URLs mit Passwort wie `mqtt://user:pass@host`), am Terminal tippst du sie ohne Echo. `JARVIS_EVENT_TOKEN` und `JARVIS_PANIC_TOKEN` erzeugt er bei Enter selbst (24 Zufallsbytes als Hex, dasselbe wie `openssl rand -hex 24`) und zeigt sie genau einmal: gleich in Home Assistant bzw. den Kurzbefehl eintragen.
- Geschrieben wird erst, wenn ein Abschnitt vollständig beantwortet ist. Die `.env` bekommt Rechte 600; eine bestehende `.env` sichert er vorher einmal als `.env.bak` (ebenfalls 600). Lösch die Sicherung, sobald du sie nicht mehr brauchst. Kommentare und Reihenfolge der `.env` bleiben erhalten, eigene Schlüssel landen unten unter `# --- Eigene Einträge ---`.
- Nach jedem Abschnitt laufen die passenden Prüfungen aus dem Selbsttest (Abschnitt 20), zum Schluss der ganze Selbsttest. Bei einem ❌ bietet er an, die Werte nochmals einzugeben.
- Am Ende legt er `data/` und den Arbeitsordner an (Rechte 700), bietet an, `cameras.example.json` und `protokolle.example.json` zu kopieren, und nennt die nächsten Schritte (`npm run whoop:auth`, `npm run google:auth`, Dienst neu starten).

Optionen kommen nach `--`, sonst schluckt npm sie:

```bash
npm run setup -- --abschnitt telegram   # nur einen Abschnitt (Namen zeigt --hilfe)
npm run setup -- --alle                 # optionale Abschnitte ohne Rückfrage durchgehen
npm run setup -- --ohne-pruefung        # keine Prüfungen nach den Abschnitten und am Ende
npm run setup -- --env /pfad/.env --beispiel /pfad/.env.example   # andere Dateien, etwa für Tests
npm run setup -- --hilfe
```

Nichts verlässt den Pi ausser den Prüfaufrufen an die Dienste, die du einrichtest. Der Assistent darf jederzeit nochmals laufen, er ändert nur, was du neu eingibst.

Von Hand geht es weiterhin:

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

## 2. WHOOP verbinden

1. Auf developer.whoop.com im Dashboard eine App anlegen. Als Redirect-URI `http://localhost:3001/callback` eintragen und mindestens die Scopes `read:recovery` und `read:workout` wählen.
2. Client-ID und Secret in `.env` eintragen.
3. Vom PC aus einen SSH-Tunnel zum Pi öffnen und dort die Verbindung starten:
   ```bash
   ssh -L 3001:localhost:3001 DEINUSER@DEIN-PI
   cd ~/jarvis && npm run whoop:auth
   ```
   Die ausgegebene URL im Browser des PCs öffnen und den Zugriff erlauben. Das Token landet in `data/state.json`.
4. Testen: `npm run try:cardio`

Mehrere Community-Projekte nutzen `http://localhost` als Redirect-URI. Akzeptiert das Dashboard nur HTTPS, kann der Callback auch über deine Tunnel-Domain laufen, das braucht eine kleine Anpassung im Skript.

## 3. Kalender

**Google (privat):** wie in Etappe 1, Dienstkonto mit Nur-Lese-Freigabe, Werte `GOOGLE_KEY_FILE` und `GOOGLE_CALENDAR_ID`.

**Outlook (Arbeit): zuerst mit eurer IT klären.** Dein Arbeitskalender verlässt damit das Firmennetz, landet auf deinem Pi und geht an einen externen KI-Dienst. Ob das erlaubt ist, entscheiden eure Richtlinien. Wenn ja:

1. Outlook im Web → Einstellungen → Kalender → Freigegebene Kalender → *Kalender veröffentlichen*.
2. Berechtigung *Kann sehen, wann ich beschäftigt bin* wählen, veröffentlichen und den **ICS-Link** als `OUTLOOK_ICS_URL` eintragen. Die Bezeichnungen können je nach Version leicht abweichen.
3. `OUTLOOK_MODE=busy` lassen: Claude sieht dann nur belegte Zeiten, keine Titel, Kunden oder Orte.

Der ICS-Link ist ein Geheimnis: Wer ihn hat, sieht deinen Kalender. Im selben Menü kannst du ihn zurücksetzen. Ist das Veröffentlichen gesperrt, ist das die Antwort der IT. Der saubere Weg wäre dann Microsoft Graph mit einer von der IT freigegebenen App.

Testen: `npm run try:briefing`

## 4. Cloudflare Tunnel

1. Im Cloudflare-Dashboard unter *Zero Trust → Networks → Tunnels* einen Tunnel vom Typ *Cloudflared* anlegen und den angezeigten Installationsbefehl auf dem Pi ausführen.
2. Als *Public Hostname* z. B. `jarvis.deinedomain.ch` mit dem Service `http://localhost:3000` eintragen.
3. Über mobile Daten testen: `https://jarvis.deinedomain.ch/health` muss `ok` liefern.

Im Router wird kein Port geöffnet. Die Menünamen bei Cloudflare ändern sich gelegentlich.

## 5. Alexa-Skill anlegen

1. In der Alexa Developer Console (developer.amazon.com) einen Skill anlegen: Name «Butler Jarvis», Sprache Deutsch (DE), Modell *Custom*, Hosting *Provision your own*, Vorlage *Start from scratch*.
2. *Build → Interaction Model → JSON Editor*: Inhalt von `alexa/interaction-model.json` einfügen, speichern und *Build Model* klicken.
3. *Endpoint*: HTTPS, Adresse `https://jarvis.deinedomain.ch/alexa`, Zertifikatsoption *sub-domain of a domain that has a wildcard certificate*.
4. Die Skill-ID (beginnt mit `amzn1.ask.skill.`) als `ALEXA_SKILL_ID` in `.env` eintragen.
5. Im Tab *Test* auf *Development* stellen und «öffne butler jarvis» eintippen.

Im Entwicklermodus läuft der Skill auf den Echos deines eigenen Amazon-Kontos. Veröffentlichen ist nicht nötig.

## 6. Routinen in der Alexa-App

- **Wecker:** «Alexa, stell einen Wecker für 5:30 Uhr jeden Tag».
- **Routine «Jarvis Morgen»:** Auslöser *Wecker* → beim Ausschalten (Zeitfenster z. B. 05:00 bis 07:00). Aktion *Skills → Deine Skills → Butler Jarvis*. Gerät: Echo im Schlafzimmer. Snoozen löst die Routine nicht aus, erst das Ausschalten.
- **Routine «Jarvis Tag»:** Auslöser *Sprache* «ich bin bereit». Aktion wieder *Butler Jarvis*. Gerät: Echo im Bad oder in der Küche.

Beide Routinen starten denselben Skill. Jarvis entscheidet selbst: Solange Cardio heute noch nicht angesagt und kein Workout erfasst ist, kommt Cardio, danach das Tagesbriefing. Direkt geht immer: «Alexa, frag Butler Jarvis nach meinem Tag» oder «… nach meinem Cardio».

## 7. Als Dienst starten

```bash
# In jarvis.service DEINUSER und Pfad anpassen
sudo cp jarvis.service /etc/systemd/system/
sudo systemctl enable --now jarvis
journalctl -u jarvis -f
```

## 8. Interaktiver Jarvis per Telegram

Schreib deinem Bot, und Jarvis antwortet mit Werkzeugen: Kalender, Mails, Code und Websites, Shopify, Smart Home, Websuche, Erinnerungen und Notizen. Es braucht nur `TELEGRAM_BOT_TOKEN` und `TELEGRAM_CHAT_ID` aus Etappe 1; alles andere ist optional und schaltet sich frei, sobald die Werte in `.env` stehen.

### Freigabe-Stufen

Jedes Werkzeug hat eine Stufe. Das ist die Freigabe-Warteschlange aus dem Reel, nur mit Telegram-Buttons statt Touch ID:

| Stufe | Beispiele | Was passiert |
|---|---|---|
| auto | lesen, Wetter, Dateien im Arbeitsordner, Mail-Entwurf, Licht schalten | läuft sofort |
| extern | Mail senden, Termin anlegen, Garage, Shell-Befehl | Jarvis legt einen Auftrag an, du tippst ✅ oder ❌ |
| sensibel | Shop-Preis ändern, Schloss, Alarmanlage | wie extern, zusätzlich fragt Jarvis deine PIN (`JARVIS_PIN`) |

Jarvis sagt dir im Chat, dass ein Auftrag wartet, und meldet nach der Freigabe das Ergebnis. Die PIN-Nachricht löscht er danach aus dem Chat.

Befehle: `/auftraege` offene Freigaben, `/modus normal|fokus|nacht`, `/neu` Gespräch vergessen, `/status`.

### Gmail (lesen, Entwürfe, senden nach Freigabe)

1. Google Cloud Console → *APIs & Dienste*: **Gmail API** aktivieren.
2. *OAuth-Zustimmungsbildschirm*: extern, dich selbst als Testnutzer eintragen.
3. *Anmeldedaten → OAuth-Client-ID* vom Typ **Desktop-App** → Client-ID und Secret als `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` in `.env`.
4. Vom PC aus `ssh -L 3002:localhost:3002 DEINUSER@DEIN-PI`, auf dem Pi `npm run google:auth`, URL im Browser öffnen, erlauben.

Jarvis bekommt nur die Rechte «lesen» und «Entwürfe/Senden». Standard ist der Entwurf in deinem Gmail-Ordner, den du selbst abschickst. `mail_senden` geht nur nach Freigabe.

Achtung: Solange die OAuth-App im Status «Testing» ist, läuft der Zugang nach 7 Tagen ab. Entweder wöchentlich `npm run google:auth` ausführen oder die App auf «In Produktion» stellen (zeigt eine Warnung, ist für den Eigengebrauch meines Wissens trotzdem nutzbar).

### Kalender-Termine anlegen

Das Dienstkonto aus Etappe 1 braucht dafür Schreibrecht: in der Kalender-Freigabe von «Alle Termindetails anzeigen» auf «Änderungen an Terminen vornehmen» stellen.

### Code und Websites

Jarvis arbeitet nur im Arbeitsordner (`JARVIS_WORKSPACE`, Standard `workspace/`). Er schreibt Dateien, liest sie, und schickt dir fertige HTML-Seiten per Telegram aufs Handy. Shell-Befehle laufen im Arbeitsordner mit Timeout, ohne deine Geheimnisse in der Umgebung und mit einer Sperrliste (sudo, ssh, rm -rf /, Pipe nach sh …). Standard `JARVIS_COMMANDS=freigabe`: jeder Befehl ist ein Auftrag. `auto` erst setzen, wenn Jarvis unter einem eigenen Linux-Benutzer läuft.

### Shopify

Shopify-Admin → *Einstellungen → Apps und Vertriebskanäle → Apps entwickeln* → App erstellen → Admin-API-Zugriffsbereiche `read_orders`, `read_products`, `write_products` → installieren → Admin-API-Zugriffstoken (`shpat_…`). In `.env`: `SHOPIFY_SHOP` (nur der Teil vor `.myshopify.com`), `SHOPIFY_TOKEN`, bei Bedarf `SHOPIFY_API_VERSION`. Preisänderungen sind Stufe «sensibel».

### Smart Home (Home Assistant)

Profil → *Sicherheit → Langlebige Zugriffstoken* → Token erstellen. In `.env`: `HA_URL` (z. B. `http://homeassistant.local:8123`) und `HA_TOKEN`. `HA_AUTO_DOMAINS` legt fest, was Jarvis ohne Rückfrage schalten darf (Standard: Licht, Schalter, Medien, Lüfter, Szenen, Klima). Schlösser und Alarmanlage sind immer «sensibel», alles andere «extern».

### Beispiele

- «Was steht heute an, und wo überschneidet sich was?»
- «Lies die letzte Mail von Hans und schreib mir einen Antwortentwurf, freundlich, ich schicke selbst.»
- «Bau mir eine Landingpage für mein Produkt, dunkel, eine Seite, und schick sie mir.»
- «Wie viele Bestellungen kamen diese Woche rein?»
- «Mach das Licht im Büro auf 40 Prozent.»
- «Erinner mich um 14 Uhr an den Rückruf.»
- «Merk dir: Rechnungen gehen immer an die Firmenadresse.»

Testen ohne Telegram geht nicht, aber `/status` zeigt dir sofort, welche Werkzeuge aktiv sind.

## 9. Browser, Stimme und Zeitpläne

### Seiten öffnen und Dinge raussuchen

Ohne Installation liest Jarvis Webseiten mit `seite_lesen` (schnell, ohne JavaScript) und sucht mit der Websuche der Claude-API. Für Seiten, die JavaScript brauchen (Fahrpläne, Shops, Portale), bekommt er einen echten Browser:

```bash
sudo apt install chromium        # Raspberry Pi OS / Debian
```

Jarvis findet Chromium selbst; sonst `BROWSER_PATH` setzen. Danach kann er Seiten öffnen, in Suchfelder tippen, klicken, zurück und Screenshots machen, die er selbst anschaut und dir auf Wunsch aufs Handy schickt. Der Browser läuft mit frischem Profil: keine Logins, keine Cookies, keine Downloads. Trotzdem gilt: Jarvis darf nie Logins, Bestellungen oder persönliche Daten in Formulare tippen, das steht in seinen Regeln. Chromium braucht einige hundert MB RAM; auf einem Pi mit 4 GB geht das, ein Mini-PC ist entspannter. Playwright ist auf seine eigene Chromium-Version abgestimmt; das System-Chromium funktioniert meist, bei Problemen `BROWSER_PATH` auf eine andere Chrome/Chromium-Installation zeigen lassen.

Beispiele: «Such mir die nächste Verbindung von Muttenz nach Basel», «Was kostet der Mini-PC X bei Digitec, mach mir einen Screenshot», «Lies diesen Artikel und fass ihn zusammen: …».

### Mit Jarvis reden

**Über Alexa:** «Alexa, frag Butler Jarvis, was heute in Basel los ist» oder nach «Alexa, öffne Butler Jarvis» einfach eine Frage stellen. Jarvis antwortet, wenn er es in gut 6 Sekunden schafft (`ALEXA_BUDGET_MS`), und hält die Sitzung für Rückfragen offen. Dauert es länger, sagt er «Ich schicke dir das Ergebnis per Telegram» und arbeitet weiter. Dafür das Interaction Model aus `alexa/` neu einspielen (FrageIntent).

**Per Sprachnachricht auf Telegram:** Jarvis versteht Sprachnachrichten und antwortet auch als Sprachnachricht, sobald Spracherkennung und Sprachausgabe eingerichtet sind. Beides läuft über OpenAI-kompatible Endpunkte, also entweder die OpenAI-API oder ein lokaler Server mit derselben Schnittstelle (z. B. Whisper-Server für STT, ein TTS-Server für die Stimme):

```
STT_URL=https://api.openai.com/v1/audio/transcriptions
STT_KEY=…
STT_MODEL=whisper-1
TTS_URL=https://api.openai.com/v1/audio/speech
TTS_KEY=…
TTS_MODEL=tts-1
TTS_VOICE=onyx
```

Eine echte Freisprech-Stimme im Raum (Wakeword, Mikrofon, Lautsprecher) bleibt die Etappe danach; Alexa und Telegram decken das Reden bis dahin ab.

### Selbständige Zeitpläne

«Richte mir werktags um 7 eine Zusammenfassung der wichtigsten News zu Zutrittskontrolle ein» – Jarvis legt einen Zeitplan an, erledigt den Auftrag zur Zeit von selbst (mit allen Werkzeugen, inklusive Browser) und schickt das Ergebnis per Telegram. Verwalten mit «Zeig mir meine Zeitpläne» und «Lösch Zeitplan 2». Jeder Zeitplan läuft höchstens einmal pro Tag.

## 10. Erstes eigenes Gerät: Jarvis Node 1

Ein ESP32 mit Temperatur-, Luftfeuchte- und Luftdrucksensor, einem Relais, einem Taster und einer Status-LED. Die Firmware ist ESPHome, also eine YAML-Datei (`esphome/jarvis-node-1.yaml`), kein C++. Das Gerät meldet sich bei Home Assistant, und damit kennt Jarvis es sofort. Als Erstes gehört es ins Bad: Die Luftfeuchte verrät, wann du geduscht hast, und fünf Minuten danach kommt das Tagesbriefing von allein. Damit ist der Morgen aus Abschnitt «So läuft dein Morgen» komplett.

### Einkaufsliste

| Teil | Hinweis |
|---|---|
| ESP32 DevKit (ESP32-WROOM-32, 30 oder 38 Pins) | Standardboard, USB-Anschluss |
| BME280-Modul (3,3 V, I2C) | Temperatur, Luftfeuchte, Luftdruck |
| 1-Kanal-Relaismodul mit Optokoppler | am besten eines, das mit 3,3 V am Eingang schaltet |
| Taster, Breadboard, Steckbrücken, USB-Kabel | zum Aufbauen |
| später: 5-V-Netzteil, Gehäuse | für den festen Einbau |

### Verdrahtung

| ESP32 | geht an |
|---|---|
| 3V3 | BME280 VCC |
| GND | BME280 GND, Relais GND, Taster |
| GPIO21 | BME280 SDA |
| GPIO22 | BME280 SCL |
| GPIO26 | Relais IN |
| GPIO27 | Taster, andere Seite an GND (interner Pull-up ist aktiv) |
| VIN (5 V) | Relais VCC, falls das Modul 5 V braucht |
| GPIO2 | Onboard-LED, nichts anzuschliessen |

Schaltet das Relais verkehrt herum, in der YAML `inverted: false` setzen. Meldet der I2C-Scan im Log `0x77`, die Adresse des BME280 anpassen.

Was das Relais schaltet, bleibt dir überlassen. Fang mit 12 V oder 24 V an. Für 230 V nimm ein Modul und Gehäuse mit passender Zulassung oder ein Shelly in der Dose, das kannst du besser beurteilen als ich.

### Flashen

1. Auf dem PC `pip install esphome` (oder in Home Assistant das Add-on «ESPHome Device Builder»).
2. `esphome/secrets.yaml.example` nach `secrets.yaml` kopieren und ausfüllen. API-Schlüssel erzeugen mit `openssl rand -base64 32`.
3. Board per USB anstecken, dann im Ordner `esphome`: `esphome run jarvis-node-1.yaml`. Ab dem zweiten Mal geht das per WLAN (OTA, verschlüsselt mit dem API-Schlüssel).
4. Im Log tauchen der I2C-Scan und die ersten Messwerte auf.

Die Konfiguration ist mit ESPHome 2026.9 geprüft.

### In Home Assistant

Home Assistant findet das Gerät von selbst (Integration ESPHome, API-Schlüssel eingeben). Entitäten: `sensor.jarvis_node_1_temperatur`, `…_luftfeuchte`, `…_luftdruck`, `switch.jarvis_node_1_relais`, `binary_sensor.jarvis_node_1_taster`, `binary_sensor.jarvis_node_1_dusche`.

Der Taster schaltet das Relais lokal, auch ohne WLAN. Langer Druck (2 s) schickt das Ereignis `esphome.jarvis_taster` an Home Assistant.

Jarvis braucht nur `HA_URL` und `HA_TOKEN` aus Abschnitt 8. Danach: «Wie warm ist es im Bad?», «Schalt das Relais an Node 1 ein», «Läuft die Dusche?».

### Ereignisse zurück an Jarvis

Home Assistant kann Jarvis anstossen. Dafür in `.env` ein Geheimnis setzen (`JARVIS_EVENT_TOKEN`, z. B. `openssl rand -hex 24`) und `LISTEN_HOST=0.0.0.0`, damit der Pi im Heimnetz erreichbar ist. Dann `homeassistant/jarvis.yaml` als Paket einbinden (steht oben in der Datei) und `JARVIS-IP` ersetzen. Das Paket bringt zwei Automationen mit:

- Dusche vorbei (05:00 bis 10:00) → Jarvis schickt das Tagesbriefing per Telegram, als Sprachnachricht falls TTS eingerichtet ist.
- Taster lange gedrückt → Jarvis meldet Raumklima und Relais.

Eigene Ereignisse: `{"event": "frage", "text": "…"}` lässt Jarvis mit allen Werkzeugen arbeiten, `{"event": "nachricht", "text": "…"}` schickt einen Text 1:1. So wird aus jedem Sensor ein Auslöser für Jarvis.

### Weitere Geräte

Für jedes weitere Gerät die YAML kopieren, `name` und Pins ändern, fertig. Jarvis kann dir die Datei auch schreiben: «Schreib mir eine ESPHome-Konfiguration für einen ESP32 mit zwei Relais und einem Bewegungsmelder an GPIO33».

## 11. Gesten- und Sprachkonsole

`https://jarvis.deinedomain.ch/gesture` (über den Cloudflare Tunnel, dann erlaubt Chrome die Kamera ohne Umwege) oder im Heimnetz `http://JARVIS-IP:3000/gesture` in Chrome öffnen und die Kamera erlauben. Links das Kamerabild mit dem Handskelett, rechts eine Partikelkugel, die auf deine Finger reagiert. Das Handtracking (MediaPipe) läuft im Browser auf deiner Grafikkarte mit 30 bis 60 Bildern pro Sekunde; es braucht keinen Jarvis und keine KI, darum ist es so schnell.

| Geste | Wirkung |
|---|---|
| Hand öffnen / schliessen | Kugel wächst und schrumpft |
| Daumen und Zeigefinger zusammen, bewegen | Kugel folgt der Hand |
| zwei Hände auseinanderziehen | Kugel dehnt sich |
| Daumen hoch, 1 s halten | schickt Befehl A an Jarvis |
| Faust, 2 s halten | schickt Befehl B an Jarvis |
| Leertaste oder «Sprechen» | du sprichst, Jarvis antwortet im Browser, auch vorgelesen |

Im Feld unten rechts den `JARVIS_EVENT_TOKEN` eintragen (wird nur im Browser gespeichert) und die beiden Befehle anpassen. Jarvis arbeitet mit allen Werkzeugen und antwortet direkt in der Konsole; «Mikro für den Puls» lässt die Kugel zu deiner Stimme pulsieren.

Zwei ehrliche Hinweise: Die Modelle fürs Handtracking kommen beim Laden der Seite von jsDelivr und Google, die Seite braucht also Internet. Und die Spracherkennung nutzt die Web-Speech-API von Chrome, die bei Google läuft; die Sprachausgabe ist die eingebaute Stimme deines Betriebssystems. Wer das lokal will, nimmt die Sprachnachrichten aus Abschnitt 9 mit eigenem STT-Server.

Die Konsole liegt als eine Datei in `web/gesture.html`. Du kannst sie auch auf dem PC mit `python3 -m http.server 8080` starten und oben die Jarvis-Adresse eintragen.

## 12. Kameras: Augen für Jarvis

Die Kameras hängen an **Frigate**, einem lokalen Videorekorder mit Objekterkennung (Personen, Autos, Tiere, Pakete), Zonen, Aufnahmen und Clips. Jarvis greift nur auf Frigate zu. Du fängst mit zwei Kameras an und hängst beliebig viele weitere dran; jede bekommt in `cameras.json` ihre eigenen Funktionen.

### Hardware

- Kameras mit RTSP-Stream, am besten PoE (Reolink, Amcrest, Dahua, Hikvision, auch günstige Tapo-Modelle). Keine reinen Cloud-Kameras.
- Für den Arbeitsplatz geht auch eine USB-Webcam am Frigate-Rechner (Frigate bindet sie über go2rtc ein) oder eine ESP32-CAM, wenn du selbst bauen willst; Bildqualität dann bescheiden.
- Frigate braucht Rechenleistung: ein Intel-Mini-PC (OpenVINO auf der iGPU) oder ein Coral-USB-Stick. Auf dem Raspberry Pi läuft Frigate nur mit Coral vernünftig.
- Kameras in ein eigenes VLAN ohne Internet; sie reden nur mit Frigate.

### Frigate einrichten

Frigate läuft als Docker-Container oder als Home-Assistant-Add-on. `frigate/config.example.yml` ist ein Startpunkt für zwei Kameras mit Aufnahme, Schnappschüssen und MQTT; Adressen und Passwörter ersetzen, Zonen in der Frigate-Oberfläche zeichnen. In Home Assistant die Frigate-Integration hinzufügen, dann gibt es pro Kamera Belegungs-Sensoren wie `binary_sensor.raum_person_occupancy`.

### Jarvis anbinden

In `.env`: `FRIGATE_URL=http://FRIGATE-IP:5000`, für Live-Meldungen `MQTT_URL`, `MQTT_USER`, `MQTT_PASSWORD` (derselbe Broker wie bei Frigate), optional `HA_PRESENCE_ENTITY=person.DEINNAME` für «nur wenn abwesend». Dann `cameras.example.json` nach `cameras.json` kopieren und anpassen:

```json
"raum": {
  "frigate": "raum",
  "beschreibung": "Wohnbereich mit Sofa und Eingang",
  "melden": { "labels": ["person"], "zonen": ["eingang"], "nur_wenn": "abwesend", "ruhe_minuten": 5, "beschreiben": true },
  "wachen": [ { "frage": "Steht die Balkontür offen?", "alle_minuten": 60, "nur_wenn": "nacht" } ]
}
```

Jede Kamera kann vier Dinge, kombinierbar:

| Funktion | Was passiert | Wo konfiguriert |
|---|---|---|
| schauen | «Schau mal auf den Arbeitsplatz»: Jarvis holt ein Standbild, sieht es selbst an und schickt es dir auf Wunsch | immer aktiv |
| melden | Frigate erkennt etwas → Telegram mit Bild und Clip-Button, ohne Claude; Filter nach Label, Zone, Bedingung, Ruhezeit | `melden` |
| wachen | regelmässig ein Standbild mit einer Ja/Nein-Frage prüfen, Meldung nur bei JA: Lötkolben an, Drucker verklebt, Tür offen | `wachen` oder per Chat |
| präsenz | Belegungs-Sensoren für Automationen in Home Assistant | macht Frigate |

Bedingungen: `immer`, `abwesend` (Präsenz-Entität nicht «home») oder `nacht` (Nachtmodus oder 22 bis 6 Uhr). `beschreiben: true` lässt Claude das Bild in einem Satz beschreiben; dafür geht das Bild an die API, sonst bleibt alles lokal.

Ohne MQTT geht es auch über Home Assistant: Die Automation «Person im Raum» im Paket `homeassistant/jarvis.yaml` reicht Frigate-Erkennungen an `/events` weiter.

Im Chat: «Was war heute Nacht vor der Tür?», «Zeig mir den Clip von der letzten Person», «Behalte den 3D-Drucker alle 15 Minuten im Auge und sag mir, wenn der Druck misslingt» (legt eine Wache an), «Welche Kameras hast du?».

### Skalieren

Eine neue Kamera heisst: Stream in Frigate eintragen, einen Block in `cameras.json` ergänzen, Jarvis neu starten. Garage mit `labels: ["car", "person"]`, Haustür mit `zonen: ["tuer"]` und `nur_wenn: "immer"`, Werkstatt nur mit Wachen. Die Regeln bleiben gleich, nur die Funktionen pro Kamera ändern sich.

## 13. Modelle und grosse Aufgaben

Jarvis nutzt zwei Modelle: `CLAUDE_MODEL` (Standard Sonnet 5.5) für den Alltag und `CLAUDE_MODEL_STARK` (Standard Opus 5.5) für schwere Aufgaben. Das starke Modell kommt in zwei Fällen zum Einsatz:

- **`!` vor einer Nachricht:** diese eine Antwort mit dem starken Modell, bis zu `MAX_LOOPS_STARK` Werkzeugrunden (Standard 40 statt 10) und längeren Antworten. Beispiel: «! Vergleich die drei Mini-PCs aus meinen Notizen nach Leistung pro Franken».
- **`/vorgang <Auftrag>`:** läuft im Hintergrund mit eigener Historie und dem starken Modell. Der Chat bleibt frei, alle fünf Werkzeugschritte kommt ein Fortschritt, am Ende die Zusammenfassung mit allem, was auf Freigabe wartet. `/vorgaenge` zeigt den Stand. Beispiel: «/vorgang Bau mir eine Landingpage mit fünf Abschnitten, recherchiere vorher drei Konkurrenten, und schick mir das Ergebnis».

Für das härteste Modell: `CLAUDE_MODEL_STARK=claude-fable-5-1`, deutlich teurer, für Ausnahmen. Für sparsamen Alltag: `CLAUDE_MODEL=claude-haiku-4-5-20251001`.

Vorgänge teilen sich den Browser mit dem Chat: Während ein Vorgang surft, besser nicht gleichzeitig Browser-Aufgaben im Chat geben.

## 14. Persona: wie Jarvis spricht und denkt

Eine Datei bestimmt den Charakter für alle Kanäle: `src/persona.ts`. Vorbild ist der J.A.R.V.I.S. aus den Filmen: ruhig, präzise, loyal, trockener britischer Humor, und ehrlich genug zu widersprechen. Dazu eine feste Denkweise vor jeder Antwort: verstehen, Risiko nennen, planen, mit Werkzeugen prüfen, berichten (Lage, Ergebnis, Empfehlung, nächster Schritt), vorausdenken.

Einstellbar in `.env`: `JARVIS_ANREDE` (Standard «Sir») und `JARVIS_FORM=sie|du` (Standard `sie`, wie ein Butler). Wer den Ton ändern will, ändert die Sätze in `persona.ts`; sie gelten sofort für Chat, Alexa, Briefing, Cardio und Vorgänge.

## 15. Jarvis überall: Handy, Uhr, Auto, Ohr

Unterwegs gibt es keinen Echo und keine Webcam, aber dein iPhone, die Uhr und die AirPods. Der Weg dahin ist ein Siri-Kurzbefehl, der mit Jarvis über Tailscale spricht.

### Tailscale: dein privates Netz zu Jarvis

Auf dem Pi `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`, auf dem iPhone die Tailscale-App, beide mit demselben Konto. Der Pi bekommt eine Adresse wie `100.64.x.y` und einen Namen wie `jarvis.tail1234.ts.net`. Jarvis mit `LISTEN_HOST=0.0.0.0` starten; die Heimnetz-Sperre lässt Tailscale-Adressen durch, das Internet nicht. Kein Port, kein Tunnel, nur deine Geräte.

### Siri-Kurzbefehl «Jarvis»

In der Kurzbefehle-App einen neuen Kurzbefehl mit dem Namen **Jarvis** anlegen:

1. **Nach Eingabe fragen**: Frage «Ja, Sir?», Eingabetyp Text. (Über Siri wird die Eingabe diktiert.)
2. **Inhalte der URL abrufen**: URL `http://100.64.x.y:3000/events`, Methode POST, Header `Authorization` = `Bearer DEIN_JARVIS_EVENT_TOKEN` und `Content-Type` = `application/json`, Anfragetext JSON mit `event` = `frage_sync`, `text` = *Bereitgestellte Eingabe*, `kanal` = `stimme`, `budget` = `25000`.
3. **Wörterbuchwert abrufen**: Schlüssel `reply` aus *Inhalte der URL*.
4. **Text sprechen**: *Wörterbuchwert*.

Dann: «Hey Siri, Jarvis.» Siri fragt «Ja, Sir?», du sprichst, die Antwort kommt in die AirPods, über CarPlay oder aus der Uhr; der Kurzbefehl läuft auch auf der Apple Watch. Jarvis weiss dabei, dass vorgelesen wird, und antwortet kurz. Braucht er länger als 25 Sekunden, sagt er das und liefert per Telegram nach, denn Kurzbefehle warten nicht ewig.

Der Kurzbefehl nutzt dasselbe Gespräch wie Telegram, Alexa und die Konsole: Was du unterwegs besprichst, kennt er zu Hause.

### Das Handy als Sensor

Mit Kurzbefehl-Automationen («Sofort ausführen») meldet das iPhone Jarvis, wo du bist und was gerade gilt. Jede Automation ist nur ein **Inhalte der URL abrufen** mit `event` = `kontext`:

| Auslöser | Text | Modus |
|---|---|---|
| Ankunft am Arbeitsort | Angekommen: Arbeit | fokus |
| Ankunft zu Hause | Zu Hause | normal |
| Fokus «Schlafen» ein | Schlafengehen | nacht |
| Fokus «Schlafen» aus | Aufgestanden | normal |
| Verbindung mit CarPlay | Im Auto, nur kurze Antworten | (leer) |

Jarvis merkt sich das als Kontext im Gespräch und schaltet den Modus um. Kamera-Meldungen «nur wenn abwesend» funktionieren mit `HA_PRESENCE_ENTITY` aus Home Assistant; wer kein HA-Tracking hat, kann Ankunft und Verlassen genauso als Kontext senden.

### Android

Siri-Kurzbefehle gibt es dort nicht; dieselben Aufrufe gehen mit Tasker, Automate oder der App «HTTP Shortcuts». Sprachnachrichten in Telegram funktionieren auf beiden Plattformen.

## 16. Finanzen, Berater, Lernen und Notfall

Das ist die Schicht, die Jarvis vom Werkzeug zum Begleiter macht. Vier Dinge, bewusst mit festen Grenzen.

### Finanzüberblick (nur vorbereiten)

Jarvis liest Rechnungen aus dem Postfach, erkennt Empfänger, Betrag, IBAN (mit Prüfziffer), QR-Referenz und Fälligkeit und führt eine Übersicht. Er erinnert dich vor Fristen und stellt dir die Zahlungsdaten zusammen, damit du sie in der Bank-App eingibst oder den QR scannst. **Er löst keine Zahlung aus** (`ZAHLUNG_NUR_VORBEREITEN=on`, Standard). Das ist Absicht: kein Zahlungsverkehr ohne dich, egal was eine Mail behauptet. «Welche Rechnungen sind offen?», «Bereite die Zahlung für #3 vor», «Hak #3 als bezahlt ab».

### Mail-Triage nach deinen Zielen

`mail_triage` liest ungelesene Mails, fasst jede in einem Satz zusammen und sortiert in JETZT, BALD, KANN WARTEN, mit Blick darauf, ob eine Mail auf eines deiner Ziele einzahlt. Rechnungen markiert er zum Erfassen, Termine schlägt er vor. Lesen und Sortieren laufen frei, Senden und Termine anlegen über Freigabe.

### Der ehrliche Berater

Jarvis misst Entscheidungen an **deinen** Zielen und Werten und widerspricht, wenn etwas dagegenläuft. Der Ton ist `BERATER_TON` (sanft, direkt, hart; bei dir direkt): er spricht Zielkonflikte von sich aus an, einmal, mit Begründung, und lässt dir die Entscheidung. Zwei feste Grenzen, die auch spätere Änderungen nicht aufweichen sollen:

- **Er bewertet Entscheidungen, nicht deinen Charakter.** Kein «du bist …», sondern «diese Entscheidung …». Muster («das dritte Mal in kurzer Zeit») spricht er nur an, wenn sie im Profil mit mindestens zwei konkreten Belegen stehen, nie als Ferndiagnose.
- **Bei echter Not ist er kein Richter**, sondern hört zu und schlägt echte Hilfe vor.

So bleibt er ein Sparringspartner, der dich zu deinen Zielen bringt, und kippt nicht in ein Gerät, das dich abwertet.

### Lernen (Profil, keine Selbstmodifikation)

Jarvis führt ein Langzeitgedächtnis über dich in `data/profil.json`: Ziele, Werte, beobachtete Entscheidungsmuster (mit Belegen), getroffene Entscheidungen und wie sie ausgingen, dauerhafte Fakten. Das fliesst in jede Antwort ein, dadurch wird er mit der Zeit persönlicher und besser. «Zeig mir, was du über mich gelernt hast» (`profil_anzeigen`), «Vergiss Ziel 2».

Wichtig und bewusst: Lernen heisst Wissen über dich pflegen. Jarvis ändert **nicht** seinen eigenen Code oder seine eigenen Regeln. Ein System mit Zugriff auf Geld, Mail und Haus, das sich selbst umschreibt, würde jede Freigabe-Logik aushebeln, das wäre genau das Sicherheitsrisiko, das wir vermeiden. Weiterentwicklung am Code machst du (gern mit Jarvis' Hilfe im Arbeitsordner), dann liest du den Diff und startest neu.

### Notfall-Protokoll (defensiv, legal)

Auslöser: `/notfall` in Telegram, der Panik-Endpunkt `POST /notfall` fürs Handy (eigener Token `JARVIS_PANIC_TOKEN`), oder automatisch bei fünf unbefugten Zugriffen in fünf Minuten (fremde Chats, falsche Tokens). Dann macht Jarvis Folgendes:

1. **Isolieren:** Notaus an. Keine Werkzeuge, keine Zeitpläne, keine Wachen, keine Freigaben. Jarvis gibt keine Daten mehr heraus.
2. **Alarmieren:** sofortige Telegram-Nachricht mit dem Grund und der Checkliste zum Sperren aller Schlüssel.
3. **Spuren:** alles steht in `data/audit.log`.

`/entwarnung` hebt den Notfall auf, bewusst nur über Telegram.

**Kein Zurückhacken.** Du hattest das erwähnt, und ich baue es ausdrücklich nicht: Ein Gegenangriff ist in der Schweiz strafbar (unbefugter Zugriff, Art. 143bis StGB), trifft fast immer eine gekaperte Zwischenmaschine statt des Täters, und macht aus dir juristisch den Angreifer. Der wirksame und legale Weg ist der obige: sofort isolieren, Schlüssel sperren, Beweise sichern, anzeigen. Das schützt dich wirklich, das Zurückhacken nicht.

Richte den Panik-Auslöser als zweiten Siri-Kurzbefehl «Notfall Jarvis» ein (wie der Jarvis-Kurzbefehl, aber URL `…/notfall`, ohne Antworttext). So sperrst du alles mit einem Satz, auch wenn du nur das Handy hast.

## 17. Protokolle: benannte Abläufe

Wie «House Party» oder «Clean Slate» im Film, bei dir als `protokolle.json`: ein Name, eine Freigabe-Stufe für den ganzen Ablauf, und Schritte aus den normalen Werkzeugen. Mitgeliefert (`protokolle.example.json` nach `protokolle.json` kopieren und an deine Geräte anpassen):

- **nacht** (sensibel): abschliessen, Alarm scharf, Licht aus, Modus Nacht.
- **abwesend** (extern): alles aus, Alarm scharf, Fokus.
- **werkstatt** (auto): Licht und Werkbank an, Fokus.
- **clean_slate** (extern): Gespräch vergessen, von vorne.

Auslösen per Chat («Protokoll Nacht», Jarvis erkennt es), mit `/protokoll nacht`, oder im Dashboard. Die Stufe entscheidet: auto läuft sofort, extern braucht ein Tippen, sensibel zusätzlich die PIN. Neue Protokolle schreibst du in die JSON (oder lässt sie dir von Jarvis schreiben) und startest neu.

## 18. Werkstatt: 3D-Teile entwerfen und drucken

Jarvis entwirft Teile als OpenSCAD-Code (parametrisch, also Masse als Variablen), rendert eine Vorschau als Bild, schaut sie sich selbst an und schickt sie dir aufs Handy. Mit einem Drucker über OctoPrint kann er die STL nach Freigabe mit PIN auch hinschicken; ohne Drucker druckst du die STL selbst.

Einrichten: `sudo apt install openscad` (auf einem Server ohne Bildschirm zusätzlich `xvfb`, für die Bildvorschau). Optional `OCTOPRINT_URL` und `OCTOPRINT_KEY`. Dann: «Entwirf mir einen Kabelhalter, 30 mm breit, mit Schlitz oben», «Mach ihn 5 mm höher und render neu», «Schick ihn an den Drucker». Die .scad- und .stl-Dateien liegen im Arbeitsordner.

Getestet mit OpenSCAD 2026: ein parametrischer Halter wurde als STL und PNG erzeugt.

## 19. Kommandozentrale: der Kern

Das Dashboard aus dem Reel, unter `http://JARVIS-IP:3000/dashboard` (nur Heimnetz/Tailscale, Token = `JARVIS_EVENT_TOKEN`, `DASHBOARD=on`). Auf einer Seite: Status und Modus, offene Aufträge mit Freigeben/Ablehnen (sensible mit PIN direkt im Browser), offene Rechnungen, Protokolle zum Antippen, Ziele, laufende Vorgänge, Zeitpläne und Wachen, Live-Standbilder der Kameras, ein Chat mit Jarvis, das Audit-Protokoll und ein Notfall-Knopf.

Alles läuft über dieselben geprüften Wege wie Telegram: Freigaben, PIN, Notaus. Die Seite ist nur aus dem Heimnetz erreichbar, jede API-Antwort zusätzlich tokengeschützt; über den Tunnel gibt es sie nicht. Unterwegs rufst du sie über Tailscale auf.

Damit ist der Kern aus dem Film komplett: der Ort, an dem du siehst, was Jarvis tut, und mit einem Tippen entscheidest.

## 20. Proaktivität, Selbsttest und Stimme im Raum

### Selbsttest

`npm run check` auf dem Pi oder `/check` in Telegram prüft jede eingerichtete Anbindung mit einem echten, billigen Aufruf und sagt, was läuft (✅), was fehlt (➖) und was kaputt ist (❌): Claude-Modelle gültig, Telegram, WHOOP, beide Kalender, Gmail, Home Assistant, Frigate, MQTT, Shopify, Browser, Werkstatt, Drucker, Stimme, Alexa, und ein Sicherheits-Check (PIN, Token, Heimnetz-Sperre, Freigaben, Panik-Token). Das ist dein erster Griff nach jeder Einrichtung und bei jeder Störung. Es kostet keine Tokens.

Nur einzelne Anbindungen: `npm run check -- --nur Telegram,Frigate` (Namen wie in der Ausgabe, Gross-/Kleinschreibung egal; ein unbekannter Name erscheint als ❌ «unbekannte Prüfung»). Die anderen Prüfungen laufen dann gar nicht, also auch ohne Netzaufruf. So prüft der Einrichtungs-Assistent nach jedem Abschnitt.

### Jarvis meldet sich von selbst

- **Rechnungen** (`RECHNUNG_ERINNERUNG`, Vorlauf `RECHNUNG_VORLAUF_TAGE`): täglich ein Hinweis auf alles, was in den nächsten Tagen fällig oder schon überfällig ist, mit den Zahlungsdaten. Ohne Claude, nur Daten.
- **Abend-/Tagesrückblick** (`RUECKBLICK`): Jarvis schaut auf den Tag, notiert echte Entscheidungen, hält belegte Muster fest und sagt dir in wenigen Sätzen, was wichtig war und was ansteht. Das ist das Lernen über dich.
- **Zielcheck wöchentlich** (`ZIELCHECK`, z. B. `so 18:00`): jedes Ziel durchgehen, konkreter nächster Schritt, ehrlich auch wenn etwas stillsteht; hilfreiche Termine kommen als Freigabe.

Alle drei respektieren Notaus und Notfall und laufen je höchstens einmal am Tag.

### Tokens effizient

Jarvis ist auf Sparsamkeit gebaut, ohne an Qualität zu verlieren: fester Systemprompt und Werkzeugdefinitionen werden zwischengespeichert (Cache-Lesen kostet etwa ein Zehntel), der Gesprächsverlauf wird nach Länge **und** Grösse gekürzt, Hintergrundarbeit (Kamera-Wachen, kurze Blicke) nutzt das günstige Modell `CLAUDE_MODEL_SEHEN`, und `/kosten` zeigt Verbrauch und geschätzte Kosten für Tag und Monat. Das starke Modell kommt nur bei `!` und `/vorgang`. Setz zusätzlich ein Ausgabenlimit in der Claude Console.

### Stimme im Raum: «Hey Jarvis»

Der zweite Bausatz, `esphome/jarvis-satellit.yaml`, ist ein kleiner Sprachlautsprecher wie ein Echo, nur mit deinem Jarvis dahinter. Das Wakeword «Hey Jarvis» läuft lokal auf dem Chip; sagst du es, hört der Ring auf zu pulsieren, du sprichst, und Jarvis antwortet aus dem Lautsprecher.

Hardware (rund 20 bis 30 Franken): ESP32-S3-DevKitC-1 (mit PSRAM), ein I2S-Mikrofon INMP441, ein I2S-Verstärker MAX98357A mit kleinem Lautsprecher, eine WS2812-LED. Verdrahtung steht oben in der YAML.

So läuft die Sprache zusammen:

1. Satellit flashen (wie Node 1: `secrets.yaml` ausfüllen, `esphome run jarvis-satellit.yaml`). Beim ersten Mal lädt ESPHome das «Hey Jarvis»-Modell automatisch.
2. In Home Assistant erscheint der Satellit über die ESPHome-Integration.
3. Jarvis als Gesprächs-Agent einbinden: den Ordner `homeassistant/custom_components/jarvis_conversation` nach `config/custom_components/` kopieren, Home Assistant neu starten, dann unter *Geräte & Dienste → Integration hinzufügen → Jarvis* die Adresse (`http://JARVIS-IP:3000`) und das `JARVIS_EVENT_TOKEN` eintragen.
4. Unter *Einstellungen → Sprachassistenten* einen Assistenten anlegen: Konversationsagent *Jarvis*, als Sprachausgabe eine deutsche Stimme (Home Assistant Cloud oder ein lokaler Piper-Server), als Spracheingabe Whisper. Diesen Assistenten dem Satelliten zuweisen.

Damit spricht der Raum mit demselben Jarvis wie Telegram, Alexa und die Zentrale: dasselbe Gespräch, dieselben Werkzeuge, dieselben Freigaben. Die Spracherkennung und die Stimme kannst du über Piper/Whisper komplett lokal betreiben; dann verlässt nur noch die eigentliche Frage das Haus Richtung Claude.

## Tests

`npm test` fährt die Tests in `test/` mit Nodes eingebautem Testläufer (`node --test`, dank tsx direkt aus TypeScript). Sie brauchen weder `.env` noch Netz: echte Dienste werden nie angesprochen, Aufrufe nach aussen bekommen Attrappen (`globalThis.fetch` wird ersetzt und zählt die Aufrufe), geschrieben wird nur in Temp-Verzeichnisse, die am Ende wieder verschwinden.

Heute abgedeckt: die `.env`-Verarbeitung des Assistenten (Roundtrip gegen Nodes eigenen Parser `util.parseEnv`, Kommentare und Reihenfolge, Rechte, `.env.bak`), alle Prüffunktionen, das Schema gegen `.env.example` (jeder Schlüssel genau einmal, in beide Richtungen), der Assistent End-zu-End mit gepipten Antworten, und `npm run check -- --nur`.

Vor und nach jeder Änderung am Code: `npm run typecheck` muss sauber und `npm test` grün sein. Neue Anbindungen bekommen Tests mit Attrappen, nie mit echten Zugängen.

## Sicherheitskonzept

Ziel ist nicht «unhackbar», das gibt es nicht. Ziel ist: Wer eine Schicht durchbricht, bekommt wenig, und du merkst es. Das Konzept folgt deinem Berufsalltag: Zonen, kleinste Rechte, Freigabe, Protokoll, Rückfallplan.

### Bedrohungsmodell

| Angriff | Was ihn aufhält |
|---|---|
| Angreifer aus dem Internet | Kein offener Port. Über den Cloudflare Tunnel erreicht nur `/alexa` den Pi, und dort wird jede Anfrage auf Amazons Signatur, Zeitstempel und deine Skill-ID geprüft. `/events` und `/gesture` antworten von aussen mit 404 (`EVENTS_VIA_TUNNEL=off`, Standard). |
| Gestohlene Geheimnisse (`.env`, `data/`) | Eigener Systembenutzer ohne Login, Dateirechte 600, gehärteter Dienst, Festplattenverschlüsselung, Widerrufsplan unten. Die Tokens in `data/state.json` sind die Kronjuwelen: Gmail und WHOOP verlangen bei Verlust nur einen Klick zum Widerruf. |
| Eingeschleuste Anweisungen in Mails, Webseiten, Terminen | Inhalte sind für Jarvis Daten. Alles, was nach aussen geht (Mail senden, Preise, Geräte, lange Adressen mit eingebetteten Daten, dauerhafte Zeitpläne und Wachen), wird zum Auftrag und wartet auf dein Tippen. Der schlimmste Fall ist ein Vorschlag, den du ablehnst. |
| Übernahme deines Telegram-Kontos | Nur deine Chat-ID, PIN für sensible Aufträge, Notaus `/pause`, Alarm bei fremden Chats. Dazu auf deiner Seite: Telegram-Zweifaktor und Passcode-Sperre. |
| Dienste in der Cloud (Anthropic, Google, Amazon) | Datensparsamkeit: WHOOP-Rohwerte, Outlook-Titel und Kamerabilder gehen nur dann an die API, wenn du es ausdrücklich willst. Laut Anthropics API-Bedingungen werden Eingaben standardmässig nicht zum Training genutzt; prüf das selbst und bleib bei der API, nicht bei einem Abo-Login. |
| Jemand mit physischem Zugang zum Pi | Verschlüsselte Platte, kein Autologin, Backups verschlüsselt. |
| Kaputte Abhängigkeit (Supply Chain) | `npm ci` mit Lockfile, `npm audit` monatlich, bekannter Befund node-forge dokumentiert, Chromium ohne Profil. |

### Schutzschichten

- **Zugänge:** Signierte Alexa-Anfragen, Token für `/events`, Heimnetz-Sperre für alles ausser `/alexa`, Dienst lauscht standardmässig nur auf 127.0.0.1.
- **Identitäten:** Nur deine Telegram-Chat-ID. Dienstkonto nur lesend. Gmail nur lesen und Entwürfe. WHOOP nur Recovery und Workouts. Shopify-Token mit minimalen Rechten. Home-Assistant-Token von einem eigenen, nicht-administrativen HA-Benutzer.
- **Netz:** Kameras und IoT in VLANs ohne Internet, Firewall-Regel nur HA → Jarvis Port 3000. Fernzugriff nur über Tailscale, nie über Portweiterleitungen.
- **Anwendung:** Drei Freigabe-Stufen, PIN, URL-Wächter gegen Datenabfluss, Persistenz braucht Freigabe, Shell nur im Arbeitsordner mit Sperrliste, Timeout und Umgebung ohne Geheimnisse, Ausgaben gekürzt.
- **Daten:** Alles Private in `data/` mit 600, Screenshots nur im laufenden Zug, Gespräch kürzbar mit `/neu`, Backups verschlüsselt.
- **Betrieb:** Eigener Benutzer, systemd-Härtung (`ProtectSystem=strict`, nur `data/` und `workspace/` beschreibbar, keine Capabilities), automatische Updates, SSH nur mit Schlüssel.
- **Erkennung:** `data/audit.log` protokolliert jede Werkzeugnutzung, jeden Auftrag, jede Ablehnung, falsche PINs, fremde Chats und abgewiesene Token. Alarm per Telegram bei fremden Chats und falschen Tokens.
- **Notaus:** `/pause` stoppt Werkzeuge, Zeitpläne und Wachen sofort; `sudo systemctl stop jarvis` stoppt alles.

### Checkliste für maximalen Schutz

1. Jarvis unter eigenem Benutzer mit der gehärteten `jarvis.service` betreiben (Anleitung oben in der Datei).
2. Platte verschlüsseln (Mini-PC: LUKS bei der Installation; Pi: zumindest `data/` auf einem verschlüsselten Datenträger).
3. SSH nur mit Schlüssel, `ufw` an: nur SSH aus dem Heimnetz, Port 3000 nur von der HA-Adresse.
4. `LISTEN_HOST=0.0.0.0` nur, wenn Home Assistant auf einem anderen Gerät läuft; `EVENTS_VIA_TUNNEL` auf `off` lassen. Für die Gestenkonsole unterwegs Tailscale Serve nutzen, das liefert https nur für deine Geräte.
5. Ausgabenlimit in der Claude Console. API-Key, Telegram-Token und Tokens vierteljährlich erneuern.
6. Telegram: Zweifaktor und Passcode aktivieren, PIN nie im Chat stehen lassen (Jarvis löscht sie).
7. Nur anschliessen, was du brauchst. Dein Arbeitskalender bleibt draussen, bis die IT zustimmt.
8. Statt deinem Haupt-Gmail ein **Assistenten-Postfach**: eine eigene Adresse, an die du per Filter nur weiterleitest, was Jarvis sehen soll (Rechnungen, Shop, Newsletter). Dein privates Postfach kennt er dann gar nicht.
9. Shopify: solange keine Preisänderungen nötig sind, nur Lese-Rechte vergeben.
10. Monatlich `npm audit`, wöchentlich ein Blick in `data/audit.log`.
11. Backups von `data/` verschlüsselt (z. B. `age` oder `gpg`) auf NAS oder externen Datenträger.

### Wenn du einen Einbruch vermutest

In dieser Reihenfolge, alles dauert zusammen keine zehn Minuten:

1. `/pause` in Telegram, dann `sudo systemctl stop jarvis`.
2. Telegram-Bot-Token bei @BotFather mit `/revoke` erneuern.
3. Claude-API-Key in der Console löschen.
4. Google: unter myaccount.google.com → Sicherheit → Drittanbieter-Apps den Zugriff der Jarvis-App entfernen; Dienstkonto-Schlüssel in der Cloud Console löschen und neu erzeugen.
5. WHOOP: im Developer-Dashboard das Client-Secret erneuern oder die App löschen.
6. Shopify: Custom App deinstallieren. Home Assistant: langlebigen Token löschen. Outlook: veröffentlichten Kalenderlink zurücksetzen.
7. Cloudflare: Tunnel löschen. Alexa: Endpunkt im Skill entfernen.
8. `data/` als kompromittiert betrachten, Pi neu aufsetzen, `.env` und `data/` nur aus einem Backup von vor dem Vorfall, Tokens trotzdem alle neu.
9. `data/audit.log` sichern und anschauen: Welche Werkzeuge liefen, welche Aufträge wurden freigegeben?

## Fehlersuche

| Symptom | Was tun |
|---|---|
| Alexa sagt, es gab ein Problem mit dem Skill | `journalctl -u jarvis -f` beobachten und nochmal fragen |
| Im Log «verification failed» bei echten Anfragen | Uhrzeit des Pi prüfen (Zeitstempel-Check), `timedatectl` |
| Recovery kommt nicht | WHOOP-App öffnen, damit sie synchronisiert; `npm run try:cardio` |
| WHOOP-Refresh schlägt fehl | `npm run whoop:auth` erneut. WHOOP tauscht den Refresh-Token bei jeder Erneuerung aus, nutze ihn also nur in einer Jarvis-Instanz |
| Briefing fehlt oder ist veraltet | `npm run try:briefing` |
| Routine startet den Skill nicht | Test-Tab auf *Development*, Echo und Developer-Konto mit demselben Amazon-Login |
| Jarvis antwortet nicht auf Telegram | `journalctl -u jarvis -f`: steht dort «Telegram nicht konfiguriert», fehlen Token oder Chat-ID. Schreibst du vom falschen Konto, wird die Nachricht ignoriert |
| Fehler «web_search» von der API | `WEB_SEARCH=off` setzen |
| Gmail 401 oder «invalid_grant» | Token abgelaufen (Testmodus, 7 Tage): `npm run google:auth` |
| Shopify «unsupported version» | `SHOPIFY_API_VERSION` auf eine aktuelle Version setzen |
| «Kein Browser gefunden» | `sudo apt install chromium` oder `BROWSER_PATH` setzen; ohne Browser bleibt `seite_lesen` |
| Alexa versteht die Frage nicht | Satz mit «frag Butler Jarvis …» beginnen; das Interaction Model mit dem FrageIntent neu einspielen und bauen |
| Sprachnachricht wird nicht verstanden | `STT_URL`/`STT_KEY` prüfen; `journalctl -u jarvis -f` zeigt die Antwort des Servers |
| Node 1 taucht nicht in Home Assistant auf | WLAN-Daten in `secrets.yaml` prüfen; der Notfall-Hotspot «Jarvis Node 1 Setup» erscheint, wenn das WLAN nicht erreichbar ist |
| Sensor liefert `nan` | I2C-Adresse (0x76/0x77) und SDA/SCL vertauscht? Log zeigt den Scan |
| Home Assistant erreicht Jarvis nicht | `LISTEN_HOST=0.0.0.0`, Token in beiden Dateien gleich, `curl http://JARVIS-IP:3000/health` vom HA-Gerät aus |
| Konsole: «LADE MODELL…» bleibt stehen | Internet für den ersten Aufruf nötig; Konsole in Chrome öffnen; Seite über http://JARVIS-IP oder localhost, nicht per file:// |
| Konsole: Kamera verweigert | Chrome gibt die Kamera nur über https oder localhost frei: die Tunnel-Adresse nutzen, die Datei lokal auf dem PC starten, oder die Heimnetz-Adresse unter chrome://flags/#unsafely-treat-insecure-origin-as-secure eintragen |
| Kamera-Werkzeuge fehlen in /status | `FRIGATE_URL` gesetzt und `cameras.json` mit mindestens einer Kamera vorhanden? |
| Keine Meldungen trotz Erkennung | Label in `melden.labels`, Zone stimmt mit Frigate überein, Bedingung `abwesend` prüft `HA_PRESENCE_ENTITY`; MQTT-Zugang im Log («MQTT verbunden») |
| Clip-Button liefert nichts | Frigate schreibt den Clip erst nach Ende des Ereignisses; kurz warten und nochmal tippen |
