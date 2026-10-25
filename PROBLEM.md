# Chromecast: Verbindung kam nicht zustande (gelöst, 25.10.2026)

## Symptom (23.–25.10.)

- Der Cast-Knopf öffnet Chromes Geräteliste, die Lautsprecher stehen darin.
- Das Antippen eines Geräts bringt keine Sitzung. Nach bis zu einer halben Minute steht im
  Protokoll `SESSION_START_FAILED`, danach scheitert jede weitere Anfrage mit
  `invalid_parameter`, und auch Chromes eigener Dialog (Remote Playback) wird nach 0–10 ms
  abgewiesen.
- In der Lautstärkeanzeige des Telefons sammeln sich mehrere Einträge der App, keiner davon
  bedienbar.

## Ursache

Hängende **Media-Router-Routen in Chrome**, also im Browser-Prozess und nicht in der Seite.
Solange sie dort stehen, weist Chrome neue Cast-Anfragen dieses Ursprungs ab.

Erzeugt hat sie die App selbst: Ein zweiter Tipp auf den Cast-Knopf 2,5 s nach dem Öffnen
galt als „Auswahl hängt“ und löste `location.reload()` aus. Nach dem Antippen eines Geräts
schließt Chromes Dialog aber, und der Verbindungsaufbau läuft im Hintergrund weiter. Das
Neuladen riss ihn ab und ließ eine Route zurück, bei jedem Versuch eine weitere. Dazu kam ein
automatisches Update, das ebenfalls neu lud, sobald `player.playing` kurz false war.

Ein Neuladen der Seite oder der PWA räumt diese Routen **nicht** weg. Die PWA läuft im
Chrome-Prozess.

## Lösung

**Am Telefon (bestätigt am 25.10.):** Android-Einstellungen → Apps → **Chrome** → *Beenden
erzwingen*. Danach castet die PWA wieder. Die App-Info der PWA selbst reicht nicht.

**Im Code, damit es nicht wiederkommt:**

- `5f9c578`: Die Seite lädt sich nie mehr selbst neu. Ein zweiter Tipp während des Verbindens
  wird nur abgewiesen. Bei `invalid_parameter` nennt die App den Handgriff oben. Remote
  Playback springt nur noch an, wenn das SDK das Gerät gar nicht erreicht hat.
- `eca548c`: Ein Update wird nur eingespielt, wenn die App sichtbar ist, nichts überträgt,
  verbindet, spielt oder ansagt, und das 10 s lang.

## Was sich als falsch herausstellte

Der Zweig `failed-fix` (17 Commits vom 25.10., nur lokal) hat die Ursache bei
Empfänger-Sitzungen auf den Lautsprechern bzw. im Netz gesucht.

- **Netz:** YouTube castet vom selben Telefon auf dieselben Lautsprecher.
- **„Chrome zeigt keinen Dialog“:** Die App war nach dem Antippen bedienbar, weil der Dialog
  nach der Gerätewahl schließt. Das Scheitern kam erst danach.
- **„Standard-Empfänger verhält sich genauso“:** Dieser Test lief auf einer schon verstopften
  Seite und sagt nichts.

## Protokollzeilen, die zählen

```
app: Start | {"navigation":"reload","verworfen":false,...}      wer neu gestartet hat
app: Update wird eingespielt - Seite lädt neu                   Neustart durch Update
cast: Geräteauswahl wird geöffnet | {"appId":...}
cast: Sitzungszustand | {"zustand":"SESSION_STARTED"}           es hat geklappt
cast: Gerät gewählt, Empfänger-Start schlug fehl | {"ms":...}   Start auf dem Gerät scheiterte
cast: requestSession abgelehnt | {"code":"invalid_parameter"}   Chrome verstopft → Chrome beenden
```
