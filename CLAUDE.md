# Nachrichten-App

Kleine PWA (Vue 3 + Vite), die Nachrichten-Podcasts der Reihe nach abspielt, mit Chromecast-
Unterstuetzung. Server in `server/index.mjs`, App-Logik in `src/lib/` (Cast: `src/lib/cast.js`,
Protokoll: `src/lib/log.js`). Funktionen siehe `README.md`.

## Befehle

- `npm run dev`: Vite-Entwicklungsserver
- `npm run build`: Build nach `dist/`
- `npm run serve`: Build und Server starten

## Deploy

`git push origin main` (GitHub) deployt automatisch auf nachrichten.helgenberger.net, aber mit
**rund 6 Minuten Verzug**: Ein GitLab-Projekt spiegelt das Repo und faehrt `.gitlab-ci.yml`
(rsync per SSH). Wer direkt nach dem Push nachsieht, sieht noch den alten Stand; das heisst
nicht, dass die Pipeline haengt.

Nicht annehmen, sondern pruefen, welcher Stand ausgeliefert wird. Die Build-Kennung steht im
Bundle und auch in den Einstellungen der App:

```sh
B=$(curl -sS https://nachrichten.helgenberger.net/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1)
curl -sS "https://nachrichten.helgenberger.net/$B" | grep -o '2026-[0-9-]* [0-9:]*' | head -1
```

## Commits

Commits sind GPG-signiert. Aus einem Tool-Aufruf heraus schlaegt `git commit` mit
"gpg: signing failed" fehl, solange der GPG-Agent gesperrt ist (pinentry hat kein tty).

- Commit-Nachricht vorher in eine Datei schreiben, damit ein neuer Versuch ein einziger Befehl ist.
- Wenn es fehlschlaegt: den Nutzer bitten, den Schluessel zu entsperren (oder
  `! git commit -F <pfad>` auszufuehren), dann denselben Aufruf wiederholen.
- **Nie** auf `--no-gpg-sign` ausweichen.

## Chromecast

### Testen

Cast-Verhalten laesst sich in der Entwicklungsumgebung nur bis zur Logik pruefen (Node-Tests
gegen ein nachgebautes Cast-SDK, Build, ausgeliefertes Bundle). Es gibt dort keinen Browser mit
Cast und kein Netz zu den Lautsprechern. Der echte Test laeuft auf dem Telefon des Nutzers
(Pixel, ausschliesslich die installierte PWA).

- Cast-Arbeit endet deshalb mit "deployt und logisch geprueft", nie mit "verifiziert".
- Der Beleg kommt aus dem App-Protokoll (Einstellungen → Protokoll). Das ist das beste
  Diagnosewerkzeug des Projekts: Bisher stand jede gefundene Ursache dort, oft in einer
  einzigen Zeile mit Zeitstempel. Beispiel: "The prompt was dismissed" nach 0 ms heisst,
  Chrome hat abgewiesen, nicht der Nutzer.
- Dem Nutzer genau sagen, welche Protokollzeilen die offene Frage entscheiden (z. B.
  `SESSION_STARTED`, `nutzeraktiv`, `fortsetzen`), statt allgemein um einen Test zu bitten.

### Haenger: zuerst Chrome beenden

Symptom: Die Cast-Liste erscheint, Antippen scheitert, `invalid_parameter`, unbedienbare
Eintraege in der Lautstaerkeanzeige. Ursache sind haengende Media-Router-Routen in **Chrome**.

- Abhilfe: Android → Apps → **Chrome** → Beenden erzwingen. Die App-Info der PWA reicht nicht,
  denn die PWA laeuft im Chrome-Prozess.
- Diesen Handgriff bei Cast-Haengern **zuerst** vorschlagen und testen lassen, bevor Code
  geaendert wird. (Am 2026-10-25 gingen 17 Commits an Netz- und Empfaenger-Thesen verloren,
  bevor das getestet wurde.)
- **Nie** `location.reload()` in den Cast-Pfad einbauen: Neuladen erzeugt solche Routen,
  statt sie zu raeumen.
