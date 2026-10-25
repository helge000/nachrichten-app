# Chromecast: Verbindung kommt nicht zustande (offen, Stand 25.10.2026)

Dieses Dokument fasst zusammen, was am 25.10.2026 am Cast-Pfad geaendert wurde, was dabei
herauskam und was weiterhin offen ist. **Das Problem ist nicht geloest:** Vom Telefon laesst
sich weiterhin keine Uebertragung starten.

## Das Symptom

Seit Freitag, 23.10. (vorher lief es, zuletzt bestaetigt am 18.10.):

- Der Cast-Knopf oeffnet Chromes Geraeteliste, die Lautsprecher stehen darin.
- Das Antippen eines Geraets bewirkt nichts: keine Sitzung, kein Fehler, kein `SESSION_STARTED`.
- In der Lautstaerkeanzeige des Telefons sammeln sich mehrere Eintraege dieser App, keiner davon
  bedienbar.
- Ab der ersten unbeantworteten Anfrage ist die Seite dicht: jede weitere Cast-Anfrage scheitert
  mit `invalid_parameter`, und auch Chromes eigener Dialog (Remote Playback) wird sofort
  abgewiesen ("The prompt was dismissed" nach 0-10 ms).

Umgebung laut Protokoll: Pixel, Chrome 156, installierte PWA (`fenster: installiert`),
Presentation API vorhanden, `nutzeraktiv: true`.

## Was tatsaechlich gefunden und behoben wurde

Diese Fehler waren real, sie standen in den Protokollen, und sie sind weg. Keiner davon war
die Ursache fuer das Symptom oben.

| Commit | Fund |
| --- | --- |
| `b83d576` | **Die App lud sich selbst neu, mitten im Verbinden.** Ein zweiter Tipp nach 2,5 s galt als "Auswahl haengt" - das ist aber ein Mensch, der auf eine Geraeteliste schaut. Jedes Neuladen riss den Dialog weg und liess auf dem Lautsprecher einen Empfaenger ohne Sender zurueck. **Das ist die Quelle der mehrfachen toten Streams.** Dazu: nie zwei Sitzungen, Aufraeumen beim Laden, Empfaenger schaltet sich im Leerlauf nach 30 s selbst ab. |
| `2e50ab7` | Das Aufraeumen haette die Verbindung beendet, die der Nutzer gerade aufbaut. |
| `ed6c3e0` | Eine festgehaltene Auswahl wurde als "Dialog offen" gemeldet statt als das, was sie ist. |
| `980e466` | Aufgeraeumt wird nur, was nachweislich nichts tut (kein Medium **und** kein laufender Spieler). |
| `6d4f99d` | **Der Rueckfall auf die Remote-Playback-API lief nach jedem gescheiterten Cast-Versuch an** - auch nach einem abgebrochenen und bei stehender Sitzung. Zweite Quelle doppelter Streams. Dazu: der Cast-Knopf loeste bei bestehender Remote-Verbindung eine neue Cast-Anfrage aus. |
| `b3a8d53` | Der Merker "gerade gewollt" galt eine Minute lang fuer *jede* Sitzung - damit raeumte nach einem Tipp gar nichts mehr auf. |
| `3ca273d` | Erkennung: bleibt die Auswahl unbeantwortet, sagt die App das, statt stumm zu scheitern. |
| `291d879` | `autoJoinPolicy` nach einem Haenger auf `PAGE_SCOPED` - kein selbsttaetiges Anhaengen an fremde Sitzungen mehr. |
| `180fd82` | **Eine feste Empfaengerwahl ("Eigenen Empfaenger nutzen") blockierte stumm jede Selbstheilung.** Ein einziger Knopfdruck vom 18.10. verhinderte seitdem jeden automatischen Ausweg, ohne eine Spur zu hinterlassen. |
| `0cd5c04` | Erkannt: eine haengende Anfrage blockiert **jeden** Dialog auf der Seite, auch Chromes eigenen. Die Ablehnung "The prompt was dismissed" nach 10 ms ist nicht der Nutzer, sondern Chrome - `remote.js` misst das jetzt. |
| `a4ad609` | Messwerte ins Protokoll: `nutzeraktiv` (User Activation) und der Fenstertyp. |
| `b36dc1b` | `resumeSavedSession: false` nach einem Haenger: frisch starten statt die tote Sitzung fortsetzen. |
| `44eedce` | Die eigene Messung war zu knapp: 8 s ab *Oeffnen* des Dialogs sind kuerzer als das Lesen einer Geraeteliste. Jetzt 25 s (Sperre 35 s). |

Zwei der heutigen Commits haben erst Schaden angerichtet und wurden korrigiert:

- `83696e3` leitete den Cast-Knopf dauerhaft auf Chromes Weg um. Der uebertraegt das
  `<audio>`-Element - ohne laufende Quelle hat er nichts anzubieten und schliesst den Dialog
  sofort. Fuer den Nutzer war damit **das Cast-Menue ganz verschwunden**. Korrigiert in
  `f97eac1`: nur noch mit laufender Quelle, und ein Fehlschlag verwirft den Merker sofort.
- `44eedce` deckte beim Testen auf, dass die 25-s-Erkennung nie gefeuert haette, weil die
  20-s-Sperre sie vorher geloescht haette.

## Was gemessen und damit ausgeschlossen ist

- **User Activation:** `nutzeraktiv: true` beim Oeffnen der Auswahl. Der Fingertipp kommt
  vollstaendig beim SDK an.
- **Fenstertyp / Chrome-Version:** `installiert`, Chrome 156, Presentation API vorhanden. Der
  Dialog erscheint ja auch - um 11:31:10 steht sogar ein `cancel`, also eine Liste, die der
  Nutzer weggetippt hat.
- **Die Empfaenger-App:** Mit dem Standard-Empfaenger `CC1AD845` verhaelt es sich genauso. An
  einer fremden App-ID kann keiner der alten Empfaenger haengenbleiben.
- **TLS/Server:** Die Zertifikatskette (ECDSA, Let's Encrypt `YE2` -> `Root YE` -> ISRG Root X2
  -> X1) validiert auch gegen ISRG Root X1 allein; TLS 1.2 mit
  `ECDHE-ECDSA-AES128-GCM-SHA256` steht bereit. Ein Cast-Geraet mit altem Wurzelspeicher kann
  den Server erreichen.
- **Code-Regression:** Zwischen dem letzten funktionierenden Test (18.10.) und dem Ausfall
  (23.10.) wurde nichts deployt. Der letzte Deploy davor war vom 18.10., 17:58.

## Was offen ist

Es bleibt eine Erklaerung, die zu allen Beobachtungen passt und die diese App nicht loesen kann:

**Auf den Lautsprechern laufen Empfaenger-Sitzungen ohne Sender** (entstanden durch das
Selbstneuladen, siehe `b83d576`). Beim Antippen eines Geraets haengt sich Chrome an so eine
Sitzung, statt neu zu starten, und dieses Anhaengen kommt nie zurueck. Eine Senderseite kann
diese Sitzungen nicht beenden: sie bekommt kein Sitzungsobjekt in die Hand.

Weggeraeumt werden sie nur am Geraet:

1. Google-Home-App -> Lautsprecher -> Uebertragung beenden, oder
2. einmal etwas anderes dorthin uebertragen (YouTube genuegt) - ein Start ersetzt die laufende
   Empfaenger-App, oder
3. den Lautsprecher kurz stromlos machen.

**Der entscheidende Test steht aus:** YouTube auf demselben Telefon auf denselben Lautsprecher
casten.

- Geht es dort → das Problem liegt doch in dieser App oder ihrem Empfaenger, und der Ansatz
  muss neu gesucht werden.
- Geht es dort auch nicht → das Telefon erreicht diese Geraete derzeit nicht (Netz, WLAN-Band,
  Gastnetz, AP-Isolation, Router-Aenderung am Freitag). Dann liegt es an nichts, was in diesem
  Repo steht. Dazu passt, dass die Geraete trotzdem **gelistet** werden: diese Liste kommt ueber
  das Google-Konto, die Verbindung dagegen ueber das lokale Netz.

## Wenn die Aenderungen zurueck sollen

Alle heutigen Aenderungen betreffen nur den Cast-Pfad und die beiden Ansichten. Der Stand von
gestern:

```
git revert --no-commit 2d29201..HEAD && git commit
```

Was dabei zurueckkaeme: das Selbstneuladen mitten im Verbinden, der parallele zweite
Uebertragungsweg und die fehlende Aufraeumlogik - also genau die Mechanik, die die toten Streams
erzeugt hat. Die Diagnose im Protokoll (`nutzeraktiv`, `fenstertyp`, Messung der Ablehnungen)
ginge ebenfalls verloren.

## Protokollzeilen, die beim naechsten Versuch zaehlen

```
cast: Umgebung | {"fenster":...,"chrome":...}        Umfeld
cast: Geräteauswahl wird geöffnet | {"nutzeraktiv":true,...}   Anfrage ging sauber raus
cast: Sitzungszustand | {"zustand":"SESSION_STARTED"}          es hat geklappt
cast: Keine Antwort auf die Geräteauswahl | {...}              25 s ohne Lebenszeichen
cast: Chromes Geräteliste abgelehnt | {"ms":0,...}             Chrome wies ab, nicht der Nutzer
cast: Übernommene Sitzung ohne Medium - wird beendet           Aufraeumen hat gegriffen
```
