import { log } from './log.js'
import { settings, clampAnnounceRate } from './store.js'

const MONATE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
]
const WOCHENTAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']

/**
 * Englische Woerter in einer Schreibweise, die die deutsche Stimme richtig
 * ausspricht.
 *
 * Die Ansage kommt aus einer deutschen Stimme, und die liest englische Woerter
 * nach deutschen Regeln: aus "Now" wurde "noff" (w als f am Wortende), aus
 * "Times" wurde "tiemes". espeak-ng, das die Laute bestimmt, erkennt einen Teil
 * der englischen Woerter selbst und wechselt dafuer die Sprache - "News",
 * "Update", "Business", "Service", "Talk", "Show" klingen deshalb schon richtig
 * und stehen hier bewusst NICHT drin.
 *
 * Aufgenommen ist nur, was nachweislich besser wird. Verglichen wurden die
 * Lautschriften von espeak-ng: einmal das Wort deutsch gelesen, einmal die
 * englische Stimme als Ziel, dazu der Abstand zwischen beiden.
 *
 *   Wort        deutsch gelesen  Ziel        ersetzt durch  ergibt      Abstand
 *   Now         nof              nau         Nau            nau          2 -> 0
 *   Headlines   heeadliines      hedlaınz    Hedleins       hedlaıns     6 -> 1
 *   Times       tiimes           taımz       Teims          taıms        4 -> 1
 *   Live        liive            laıv        Leiv           laıf         3 -> 1
 *   Review      reeviif          rıvjuu      Riwju          rıvjuu       3 -> 1
 *   Roundup     ruunduup         raundap     Raundapp       raundap      3 -> 1
 *   Wire        viire            waır        Waier          vaıə         4 -> 2
 *   Digest      diigest          daıdʒest    Deidschest     daıtʃəst     5 -> 3
 *
 * "Today", "Daily" und "World" fehlen mit Absicht: keine der versuchten
 * Schreibweisen kam dem Ziel naeher als das Wort selbst. Deutsch hat weder
 * das englische w noch dessen langes oe - da ist Schluss.
 */
const AUSSPRACHE = new Map([
  ['now', 'Nau'],
  ['hour', 'Auer'],
  ['hours', 'Auers'],
  ['times', 'Teims'],
  ['live', 'Leiv'],
  ['week', 'Wiek'],
  ['weekly', 'Wiekli'],
  ['headline', 'Hedlein'],
  ['headlines', 'Hedleins'],
  ['review', 'Riwju'],
  ['digest', 'Deidschest'],
  ['roundup', 'Raundapp'],
  ['wire', 'Waier']
])

/**
 * Namen fuer die Sprachausgabe umschreiben.
 *
 * Betrifft nur den gesprochenen Text - angezeigt wird ueberall weiter der
 * Name, den man eingetragen hat.
 */
export function aussprechbar(text) {
  return String(text || '').replace(/\p{L}+/gu, (wort) => AUSSPRACHE.get(wort.toLowerCase()) || wort)
}

/** Kalendertage-Abstand in LOKALER Zeit - nicht in Stunden gerechnet. */
function tagesAbstand(datum, jetzt) {
  const a = new Date(datum.getFullYear(), datum.getMonth(), datum.getDate())
  const b = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate())
  return Math.round((b - a) / 86400000)
}

/**
 * Relativer Tag in Worten. "heute" und "gestern" sind die Faelle, die bei
 * Nachrichten praktisch immer auftreten; alles Aeltere wird konkret benannt,
 * weil "vor fuenf Tagen" beim Hoeren niemand zuordnen kann.
 */
export function relativerTag(datum, jetzt = new Date()) {
  const abstand = tagesAbstand(datum, jetzt)
  if (abstand === 0) return 'heute'
  if (abstand === 1) return 'gestern'
  if (abstand === 2) return 'vorgestern'
  // Innerhalb der letzten Woche reicht der Wochentag.
  if (abstand > 2 && abstand < 7) return `am ${WOCHENTAGE[datum.getDay()]}`
  if (abstand === -1) return 'morgen'
  if (abstand < 0) return `am ${datum.getDate()}. ${MONATE[datum.getMonth()]}`
  return `am ${datum.getDate()}. ${MONATE[datum.getMonth()]}`
}

/**
 * Uhrzeit so schreiben, dass die Sprachausgabe sie richtig liest.
 *
 * Frueher stand hier "19:00" im Text. Die Sprachausgabe phonemisiert ueber
 * espeak-ng, und dessen Zeit-Regel machte daraus "neunzehn Uhr null null";
 * aus "19:15" wurde "neunzehn Uhr eins fuenf" - die Ziffern nach dem
 * Doppelpunkt landen einzeln. Zusammen mit dem angehaengten "Uhr" kam
 * "19 Uhr eins fuenf Uhr" heraus.
 *
 * Deshalb steht der Doppelpunkt gar nicht mehr im Text. Freistehende Zahlen
 * liest die Sprachausgabe zuverlaessig als Zahlwort, und das "Uhr" steckt
 * jetzt in der Zeit selbst statt dahinter:
 *
 *   19:00 -> "19 Uhr"      volle Stunde ohne Minuten
 *   19:15 -> "19 Uhr 15"   gesprochen "neunzehn Uhr fuenfzehn"
 *   19:05 -> "19 Uhr 5"    ohne fuehrende Null, die waere "null fuenf"
 *   01:00 -> "ein Uhr"     als Zahl gelesen waere es "eins Uhr"
 *   00:20 -> "0 Uhr 20"    Mitternacht heisst im 24-Stunden-Format "null Uhr"
 *
 * Immer 24 Stunden, unabhaengig von der Spracheinstellung des Geraets.
 */
export function stundeMinuteGesprochen(stunde, minute) {
  // "ein Uhr", nicht "eins Uhr" - die einzige Stunde mit eigener Form.
  const h = stunde === 1 ? 'ein' : String(stunde)
  return minute === 0 ? `${h} Uhr` : `${h} Uhr ${minute}`
}

export function uhrzeitGesprochen(datum) {
  return stundeMinuteGesprochen(datum.getHours(), datum.getMinutes())
}

/**
 * Ansagetext bauen, z. B.:
 *   "Von Deutschlandfunk Nachrichten, heute um 19 Uhr."
 *
 * Ohne verwertbares Datum bleibt es beim Namen - eine falsche Zeit anzusagen
 * waere schlimmer als gar keine.
 */
export function ansageText(titel, veroeffentlicht, jetzt = new Date()) {
  const name = aussprechbar(String(titel || '').trim())
  if (!name) return ''
  if (!veroeffentlicht) return `Von ${name}.`

  const datum = veroeffentlicht instanceof Date ? veroeffentlicht : new Date(veroeffentlicht)
  if (Number.isNaN(datum.getTime())) return `Von ${name}.`

  return `Von ${name}, ${relativerTag(datum, jetzt)} um ${uhrzeitGesprochen(datum)}.`
}

const ABSCHLUSS = 'Das waren deine Nachrichten. Es ist jetzt'

/** Abschlussansage mit der Uhrzeit von jetzt. */
export function abschlussText(jetzt = new Date()) {
  return `${ABSCHLUSS} ${uhrzeitGesprochen(jetzt)}.`
}

/**
 * Die Ansage spricht der Browser - auf diesem Geraet, nicht auf dem Server.
 *
 * Frueher kam sie als WAV von /say (sherpa-onnx mit einem VITS-Modell). Noetig
 * war das, solange ein Chromecast die Ansage abspielen sollte: ein Lautsprecher
 * kann keine Browser-Stimme abrufen, nur eine Datei. Seit die Ansage nur noch
 * auf dem Geraet laeuft, faellt dieser Grund weg - und mit ihm ein eigener
 * Bauabschnitt im Image samt Stimmmodell.
 *
 * Der bekannte Preis: im Hintergrund bricht die Sprachausgabe mit
 * "synthesis-failed" ab. Deshalb wird dort gar nicht erst angesagt - die Folge
 * startet sofort, siehe ansageMoeglich() in player.js.
 */
function sprachausgabe() {
  return typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis : null
}

// Die Stimmenliste steht nach dem Laden der Seite noch nicht bereit: Chrome
// holt sie nach und meldet das mit 'voiceschanged'. Wer zu frueh fragt, bekommt
// eine leere Liste und haelt das Geraet faelschlich fuer stumm.
const STIMMEN_WARTE_MS = 2000

// Das Warten auf eine Liste, die leer bleibt, lohnt nur einmal. Ohne diesen
// Merker kostete jede Folge auf einem Geraet ohne Stimmen erneut die vollen
// zwei Sekunden, bevor sie anfaengt. Meldet das Geraet spaeter doch Stimmen,
// greift schon getVoices() davor und der Merker kommt nie zum Zug.
let vergeblichGewartet = null

function stimmen() {
  const synth = sprachausgabe()
  if (!synth) return Promise.resolve([])
  const sofort = synth.getVoices()
  if (sofort.length) return Promise.resolve(sofort)
  if (vergeblichGewartet) return vergeblichGewartet

  vergeblichGewartet = new Promise((fertig) => {
    let erledigt = false
    const antworten = () => {
      if (erledigt) return
      erledigt = true
      clearTimeout(wecker)
      synth.removeEventListener('voiceschanged', antworten)
      fertig(synth.getVoices())
    }
    const wecker = setTimeout(antworten, STIMMEN_WARTE_MS)
    synth.addEventListener('voiceschanged', antworten)
  })
  return vergeblichGewartet
}

/**
 * Sprachkennung einer Stimme, auf eine Form gebracht.
 *
 * Android schreibt sie mit Unterstrich ("de_DE"), der Rest der Welt mit
 * Bindestrich ("de-DE"). Daran ist die Ansage auf dem Telefon gescheitert:
 * 92 Stimmen gemeldet, keine davon als deutsch erkannt, und weil das kein
 * Fehler ist, blieb es einfach still.
 */
function sprache(stimme) {
  return String((stimme && stimme.lang) || '').replace(/_/g, '-')
}

/**
 * Deutsche Stimme aussuchen.
 *
 * Bevorzugt eine lokal installierte: die spricht auch ohne Netz und ohne
 * Verzoegerung. Meldet eine Stimme ihre Sprache gar nicht, bleibt der Name
 * als letzter Anhalt.
 */
function deutscheStimme(liste) {
  const deutsche = liste.filter((v) => /^de(-|$)/i.test(sprache(v)))
  if (!deutsche.length) {
    const nachName = liste.filter((v) => /deutsch|german/i.test(String(v.name || '')))
    if (!nachName.length) return null
    return nachName.find((v) => v.localService) || nachName[0]
  }
  return deutsche.find((v) => v.localService) || deutsche[0]
}

/** Die ersten paar Sprachen, die das Geraet meldet - fuer die Diagnose. */
function sprachenProbe(liste) {
  return [...new Set(liste.map(sprache))].slice(0, 8)
}

/** Kann dieses Geraet deutsch sprechen? Fuer den Hinweis in den Einstellungen. */
export async function stimmeVerfuegbar() {
  if (!sprachausgabe()) return false
  const liste = await stimmen()
  // Eine leere Liste heisst nicht "stumm": manche Browser fuehren ihre Stimmen
  // nicht auf und sprechen trotzdem. Versucht wird es dann, also auch gemeldet.
  if (!liste.length) return true
  return !!deutscheStimme(liste)
}

/** Was meldet das Geraet? Fuer die Diagnose in den Einstellungen. */
export async function stimmenInfo() {
  if (!sprachausgabe()) return { sprachausgabe: false, anzahl: 0, deutsch: '' }
  const liste = await stimmen()
  const stimme = deutscheStimme(liste)
  return {
    sprachausgabe: true,
    anzahl: liste.length,
    deutsch: stimme ? `${stimme.name} (${stimme.lang})` : '',
    sprachen: sprachenProbe(liste).join(', ')
  }
}

// Einmal pro Sitzung, beim ersten Fingertipp: siehe ansageAufwecken().
let geweckt = false

/**
 * Die Sprachausgabe am Fingertipp aufwecken.
 *
 * Chrome spricht nur fuer eine Seite, die der Nutzer angefasst hat. Diese
 * Erlaubnis entsteht im Klick-Handler und ist verbraucht, sobald davor ein
 * await liegt - und genau das steht zwischen dem Druck auf Play und der
 * Ansage: Playlist bauen, Feeds aufloesen. Die erste Ansage kam deshalb nie
 * heraus, ohne dass jemand einen Fehler gesehen haette.
 *
 * Abhilfe ist ein leeres Stueck Sprache, direkt im Klick-Handler. Es ist
 * lautlos und kostet nichts, holt die Erlaubnis aber ab, solange sie gilt;
 * danach darf die Seite fuer den Rest der Sitzung von sich aus sprechen.
 *
 * Muss synchron aus der Ereignisbehandlung heraus aufgerufen werden.
 */
export function ansageAufwecken() {
  const synth = sprachausgabe()
  if (!synth || geweckt) return
  geweckt = true
  try {
    // resume() fuer den Fall, dass die Warteschlange noch angehalten ist -
    // Chrome laesst sie nach einem cancel() gelegentlich so zurueck.
    synth.resume()
    const leer = new SpeechSynthesisUtterance(' ')
    leer.volume = 0
    synth.speak(leer)
    log('ansage', 'Sprachausgabe geweckt')
  } catch (e) {
    log('ansage', 'Wecken fehlgeschlagen', e && e.message ? e.message : e)
  }
}

// Notbremse: bleibt die Sprachausgabe haengen (im Hintergrund der Normalfall),
// darf die Folge nicht ewig auf sie warten.
const MAX_DAUER_MS = 15000

/**
 * Ansage sprechen. Antwortet, wenn sie durch ist - oder wenn klar ist, dass
 * daraus nichts wird.
 *
 * Die Antwort ist nie eine Ablehnung: der Aufrufer startet danach die Folge,
 * und ob die Ansage zu hoeren war, darf daran nichts aendern.
 */
export function sprich(text, rate) {
  const synth = sprachausgabe()
  if (!text || !synth) return Promise.resolve(false)
  const tempo = clampAnnounceRate(rate === undefined ? settings.announceRate : rate)

  return stimmen().then((liste) => {
    // Nur deutsch ansagen. Meldet das Geraet Stimmen, aber keine deutsche,
    // bleibt es still - eine englische Stimme liest "Von Deutschlandfunk
    // Nachrichten, heute um 19 Uhr" zu Brei. Meldet es gar keine, wird es
    // trotzdem versucht (siehe stimmeVerfuegbar).
    const stimme = deutscheStimme(liste)
    if (!stimme && liste.length) {
      log('ansage', 'Keine deutsche Stimme - Ansage entfällt', {
        stimmen: liste.length,
        sprachen: sprachenProbe(liste)
      })
      return false
    }

    return new Promise((fertig) => {
      let erledigt = false
      const beenden = (grund) => {
        if (erledigt) return
        erledigt = true
        clearTimeout(wecker)
        if (grund !== 'gesprochen' && (synth.speaking || synth.pending)) synth.cancel()
        log('ansage', 'Ansage beendet', grund)
        fertig(grund === 'gesprochen')
      }

      const spruch = new SpeechSynthesisUtterance(text)
      if (stimme) spruch.voice = stimme
      spruch.lang = (stimme && stimme.lang) || 'de-DE'
      spruch.rate = tempo
      spruch.onend = () => beenden('gesprochen')
      spruch.onerror = (e) => beenden(`Fehler: ${(e && e.error) || 'unbekannt'}`)

      const wecker = setTimeout(() => beenden('zeitüberschreitung'), MAX_DAUER_MS)
      const losSprechen = () => {
        log('ansage', 'Ansage spricht', {
          text,
          tempo,
          stimme: (stimme && stimme.name) || 'Voreinstellung des Geräts',
          stimmenImGeraet: liste.length
        })
        synth.speak(spruch)
      }

      // Haengt noch etwas in der Warteschlange, erst raeumen - aber nicht im
      // selben Tick weitersprechen: ein cancel() wirkt in Chrome verzoegert
      // und verschluckt dabei die Ansage, die unmittelbar darauf folgt. Genau
      // deshalb blieb es still, ohne dass ein Fehler kam.
      if (synth.speaking || synth.pending) {
        synth.cancel()
        setTimeout(losSprechen, 120)
      } else {
        losSprechen()
      }
    })
  })
}

/** Laufende Ansage sofort abbrechen (Pause, Stopp, Folgenwechsel). */
export function ansageAbbrechen() {
  const synth = sprachausgabe()
  if (synth) synth.cancel()
}
