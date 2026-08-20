# Nachrichten

Kleine PWA (Vue 3 + Vite), die deine Nachrichten-Podcasts der Reihe nach abspielt.
Auf der Hauptseite gibt es nur einen grossen Play-Button - alles andere steckt in den Einstellungen.

## Funktionen

- **Ein Knopf**: Play holt aus jedem Feed die neueste Folge und spielt sie in der eingestellten
  Reihenfolge ab. Danach automatisch die naechste.
- **30 Sekunden vor/zurueck** links und rechts vom Play-Knopf - auch ueber den Sperrbildschirm.
  Sauber begrenzt: nie unter 0, und kurz vor Schluss statt ueber das Folgenende hinaus.
- **Neu laden** oben in der Kopfzeile holt die neuesten Folgen. Laeuft gerade etwas, wird die
  Wiedergabe dabei **nicht** unterbrochen - die laufende Folge bleibt, drumherum wird die Liste
  erneuert.
- **Einstellungen**: Quellen anlegen (Name + URL), einzeln aktivieren/deaktivieren, Reihenfolge per
  Drag & Drop (funktioniert auch mit dem Finger auf dem Handy).
- **Zwei Quellentypen**: `RSS-Feed` (neueste Folge wird geholt) oder `Direkte Audio-URL`
  (feste Datei, z. B. ein Livestream-Schnipsel).
- **Persistenz**: alles landet automatisch im `localStorage`; zusaetzlich Export/Import als JSON
  fuer Backup oder Umzug auf ein anderes Geraet.
- **Android**: als PWA installierbar (Standalone, Icon, Splash), Steuerung ueber den Sperrbildschirm
  via Media Session.
- **Chromecast**: optional, ueber zwei Wege. Bevorzugt das Cast-SDK (Chrome + HTTPS); laedt das
  nicht, greift die Remote Playback API des `<audio>`-Elements, die Chrome auf Android mitbringt.
  Sobald einer der beiden Wege ein Geraet meldet, erscheint oben rechts das Cast-Symbol. Unter
  Einstellungen -> Chromecast steht der Live-Zustand samt Diagnose, falls kein Symbol kommt.

  Der Cast-Loader von Google steigt auf Android stillschweigend aus, wenn `navigator.presentation`
  fehlt - genau dafuer ist die Diagnose da.

## Loslegen

```bash
npm install
npm run dev        # Entwicklung, http://localhost:5173 (auch im LAN erreichbar)
npm run serve      # Build + Auslieferung inkl. Feed-Proxy auf http://localhost:5174
```

`npm run serve` (bzw. `npm run build` + `npm start`) startet einen winzigen Node-Server ohne
Abhaengigkeiten, der `dist/` ausliefert und die beiden Proxy-Endpunkte `/feed` und `/audio`
bereitstellt.

## Die zwei Proxys

Beide sind im mitgelieferten Server enthalten (`npm start`), beide sind in den Einstellungen
abschaltbar. `{url}` wird jeweils durch die kodierte Ziel-URL ersetzt; fehlt `{url}`, wird sie
hinten angehaengt.

### `/feed?url=...` - gegen fehlendes CORS

Viele Feeds senden keine CORS-Header, ein Browser darf sie dann nicht laden. Der Proxy holt das XML
serverseitig und gibt es mit `Access-Control-Allow-Origin: *` zurueck (nur http/https, keine internen
Adressen, max. 8 MB). Schlaegt er fehl, versucht die App zusaetzlich den direkten Abruf.

Gemessen an den Beispiel-Feeds:

| Feed | CORS |
| --- | --- |
| tagesschau in 100 Sekunden | spiegelt die Origin -> direkt ladbar |
| BBC (alle Feeds) | `*` -> direkt ladbar |
| Deutschlandfunk | kein Header -> Proxy noetig |
| NPR | nur `https://apps.npr.org` -> Proxy noetig |

### `/audio?url=...` - gegen Mixed Content

Manche Podcasts liefern ihre MP3s nur ueber `http` - bei der BBC gilt das fuer *alle* Feeds, und der
Mediaselector leitet auch bei https-Aufruf auf eine http-CDN-URL weiter. Laeuft die App unter https,
versucht Chrome ein Auto-Upgrade und bricht ab, wenn das scheitert. Der Audio-Proxy holt die Datei
serverseitig und liefert sie ueber die eigene (sichere) Herkunft aus.

Er wird **nur benutzt, wenn er gebraucht wird**: https-Seite plus http-Audio. Alles andere laedt
direkt vom Sender, damit nicht jede Folge durch deinen Server laeuft. Faellt eine Datei trotzdem aus
(z. B. https-URL, die auf http weiterleitet), fasst die App einmal ueber den Proxy nach, bevor sie
zur naechsten Quelle springt.

Der Endpunkt streamt statt zu puffern und reicht `Range`-Anfragen durch - Spulen funktioniert also.
Auf `localhost` (http) wird er nie gebraucht.

## Beispiel-Quellen

`beispiel-quellen.json` liegt im Projekt und laesst sich direkt ueber Einstellungen -> Import laden:
Deutschlandfunk Nachrichten, BBC Global News Podcast, Deutschlandfunk Presseschau, NPR News Now.

Weitere Feed-URLs findest du in Podcast-Verzeichnissen. Praktisch ist die iTunes-Such-API, die zu
jedem Podcast die echte Feed-URL nennt:

```sh
curl -s -G https://itunes.apple.com/search \
  --data-urlencode "term=Deutschlandfunk Nachrichten" --data-urlencode "entity=podcast" \
  | python3 -c "import json,sys; [print(r['collectionName'], r['feedUrl']) for r in json.load(sys.stdin)['results']]"
```

## Docker

```bash
cp .env.example .env      # SITE_ADDRESS eintragen
docker compose up -d --build
```

Zwei Container:

- **app** - Multi-Stage-Build, im Laufzeit-Image liegen nur `dist/`, `server/` und `package.json`.
  Kein `node_modules`, kein Build-Werkzeug, laeuft als Benutzer `node`. Der Port ist nur im
  Compose-Netz sichtbar, nicht auf dem Host.
- **caddy** - Reverse Proxy auf 80/443 (inkl. HTTP/3), holt das Zertifikat automatisch.

`SITE_ADDRESS=localhost` nutzt Caddys interne CA, praktisch zum Testen. Mit einer echten Domain
(`SITE_ADDRESS=nachrichten.example.org`, DNS zeigt auf den Host, Ports 80/443 offen) besorgt Caddy
ein Let's-Encrypt-Zertifikat. Das Volume `caddy_data` muss dabei erhalten bleiben - dort liegen die
Zertifikate.

Damit ist auch die HTTPS-Voraussetzung erfuellt, die Chrome fuer die PWA-Installation und fuer
Chromecast verlangt.

### Offene Proxys

`/feed` und `/audio` nehmen jede URL entgegen. Auf einer oeffentlichen Domain kann also jeder, der
die Adresse kennt, Traffic ueber deinen Server ziehen. Im `Caddyfile` steht ein fertiger Block, der
beide Pfade auf private Netze beschraenkt - er ist auskommentiert, weil er auch den Chromecast
aussperrt, sofern der nicht im selben Netz haengt.

## Fehlersuche auf dem Geraet

Unter Einstellungen -> Protokoll zeichnet die App auf, was passiert - auch im Hintergrund und
beim Casten, wo die Browser-Konsole nichts zeigt. Eintraege mit `[bg]` entstanden, waehrend die App
im Hintergrund lief. "Kopieren" legt alles inklusive Geraetekennung in die Zwischenablage (oder als
Datei, wenn die Zwischenablage gesperrt ist).

Das Protokoll ueberlebt ein Neuladen (`sessionStorage`) und fasst 200 Eintraege.

### Chromecast

Zwei Stolpersteine, beide bereits behoben, aber gut zu kennen:

- **Der Standard-Empfaenger beendet die Sitzung**, wenn er nach dem Verbinden kein Medium bekommt.
  Verbindet man, waehrend nichts laeuft, sah das frueher wie "Verbindung fehlgeschlagen" aus.
  Jetzt startet die App in diesem Fall die Playlist.
- **Die Bereitschaftspruefung** muss die Konstruktoren `MediaInfo`/`LoadRequest` testen, nicht die
  Konstante `DefaultMediaReceiverAppId`. Die fehlt z. B. in Chrome 151 auf ChromeOS, obwohl das SDK
  einwandfrei laeuft - eine Pruefung auf die Konstante blockiert dort jedes Casten.

Der Fehlercode des SDK steht unter Einstellungen -> Chromecast im Klartext (`channel_error` =
Netzwerk, `receiver_unavailable` = kein Empfaenger, `cancel` = Auswahl abgebrochen).

### Hintergrund-Wiedergabe

Android entzieht einer Seite im Hintergrund die Wiedergabe-Erlaubnis, sobald zwischen dem
`ended`-Ereignis und dem naechsten `play()` ein Promise liegt. Genau daran blieb die App frueher
stehen. Deshalb schaltet `advanceSync()` in `src/lib/player.js` **ohne jeden await** weiter: URL
setzen, `play()` aufrufen, erst danach darf ein Promise ins Spiel kommen.

Das setzt voraus, dass die naechste Folge bereits aufgeloest ist - darum holt `buildPlaylist()`
alle Feeds gleich beim Start parallel. Zusaetzlich werden die ersten 256 KB der naechsten Folge
vorgewaermt, damit der Verbindungsaufbau steht, bevor umgeschaltet wird.

Ein **kompletter Download** der Playlist waere der falsche Hebel: die vier Beispielquellen wiegen
zusammen rund 22 MB, das verzoegert den Start spuerbar und loest das Problem nicht - der Engpass
war nie die Datenmenge, sondern die Verzoegerung durch das Promise.

Signierte CDN-Links (BBC & Co. tragen `Expires=`) laufen ab. Faellt eine Folge deshalb aus, holt die
App den Feed einmal neu, statt die Quelle zu verwerfen.

## Updates auf dem Handy

Eine installierte PWA aktualisiert sich nicht von allein - sie navigiert oft tagelang nicht, und
ohne Navigation sucht der Browser nie nach einer neuen `sw.js`. Deshalb kuemmert sich die App selbst
darum (`src/lib/update.js`):

- Sie prueft bei jedem Wechsel in den Vordergrund und zusaetzlich stuendlich.
- Findet sie eine neue Version, spielt sie diese ein, **sobald nichts mehr laeuft** - mitten in einer
  Folge waere ein Neuladen aergerlich. Laeuft gerade etwas, wartet das Update bis zur Pause.
- In den Einstellungen stehen der Build-Stand und ein Knopf "Nach Updates suchen".

Damit das greift, muss der Server `index.html`, `sw.js` und das Manifest mit `no-cache` ausliefern -
das tut `server/index.mjs`. Nur `/assets/*` traegt einen Inhalts-Hash im Namen und wird dauerhaft
gecacht. Sitzt ein CDN davor (z. B. Cloudflare), braucht `sw.js` dort eine Regel, die den Cache
umgeht - sonst haengen Updates stundenlang fest.

Der Ablauf nach `docker compose up -d --build`:

1. Neues Image, neues `dist/` mit neuen Asset-Hashes und neuer `sw.js`.
2. Beim naechsten Oeffnen der App prueft sie auf Updates und findet die neue `sw.js`.
3. Sie wird eingespielt, sobald keine Folge laeuft - die App laedt sich dabei einmal neu.

**Einmalig beim Umstieg:** Auf Geraeten, auf denen noch eine Version ohne diese Update-Logik
installiert ist, muss die App einmal komplett geschlossen werden (aus den zuletzt genutzten Apps
wischen) und neu geoeffnet. Danach laeuft es automatisch.

## Auf dem Handy installieren

1. `docker compose up -d` (oder `npm run serve` ohne Docker).
2. Die Seite im Chrome auf dem Android-Geraet oeffnen - Menue -> "App installieren".

Fuer die Installation als PWA und fuer Chromecast verlangt Chrome eine sichere Herkunft: `localhost`
geht immer, im Netzwerk braucht es HTTPS - genau dafuer ist der Caddy-Stack da.

## Aufbau

```
src/
  App.vue              Umschalter Hauptseite <-> Einstellungen
  views/MainView.vue   Play-Button, Titel, Fortschritt, Cast-Knopf
  views/SettingsView.vue  Quellenliste (Drag & Drop), Proxy, Import/Export
  lib/store.js         Einstellungen + localStorage + JSON Import/Export
  lib/feed.js          RSS/Atom -> neueste Folge
  lib/player.js        Playlist, Wiedergabe, Auto-Weiterschaltung, Media Session
  lib/cast.js          Chromecast ueber das Cast-SDK
  lib/remote.js        Chromecast ueber die Remote Playback API (Fallback)
  lib/update.js        Update-Pruefung und kontrolliertes Neuladen
  lib/log.js           Protokoll, das auf dem Geraet selbst sichtbar ist
Dockerfile             Multi-Stage-Build, Laufzeit ohne node_modules
docker-compose.yml     app + caddy
Caddyfile              Reverse Proxy, automatisches HTTPS
server/
  index.mjs            statischer Server fuer dist/
  feed-proxy.mjs       /feed?url=...  (RSS holen, CORS-Header setzen)
  audio-proxy.mjs      /audio?url=... (MP3 streamen, Range durchreichen)
  url-guard.mjs        Schutz vor SSRF, geprueftes Folgen von Weiterleitungen
```

## Deployment (GitLab CI)

`.gitlab-ci.yml` enthaelt zwei Stages:

1. **build** - `npm ci && npm run build` auf Node 20, prueft danach, dass `index.html`, `sw.js` und
   `manifest.webmanifest` erzeugt wurden. Artefakt sind `dist/`, `server/` und `package.json`
   (`server/` hat keine Abhaengigkeiten, auf dem Zielhost ist also kein `npm install` noetig).
2. **deploy** - laedt das Artefakt per `rsync` ueber SSH auf den Zielhost. Laeuft nur auf dem
   Default-Branch.

Benoetigte CI/CD-Variablen:

| Variable | Pflicht | Beispiel / Hinweis |
| --- | --- | --- |
| `SSH_PRIVATE_KEY` | ja | Typ **File**, privater Deploy-Key (Typ *Variable* geht auch) |
| `SSH_KNOWN_HOSTS` | empfohlen | Ausgabe von `ssh-keyscan -p 22 host`; fehlt sie, wird der Hostschluessel ungeprueft uebernommen |
| `DEPLOY_HOST` | ja | `nachrichten.example.org` |
| `DEPLOY_USER` | ja | `deploy` |
| `DEPLOY_PATH` | ja | `/srv/nachrichten` (nicht `/`, dort laeuft `rsync --delete`) |
| `SSH_PORT` | nein | Standard `22` |
| `DEPLOY_RESTART` | nein | z. B. `sudo systemctl restart nachrichten` |

Auf dem Zielhost startet die App mit `node server/index.mjs` aus `DEPLOY_PATH` heraus, z. B. als
systemd-Unit:

```ini
[Service]
WorkingDirectory=/srv/nachrichten
Environment=PORT=5174
ExecStart=/usr/bin/node server/index.mjs
Restart=always
```

## Hinweis zu Node

Gebaut und getestet mit Node 18. In `package.json` sind `lru-cache` und `serialize-javascript` per
`overrides` auf Node-18-taugliche Versionen gepinnt (die neueren Versionen brauchen Node 20+).
Mit Node 20+ koennen die `overrides` entfallen.
