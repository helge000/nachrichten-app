import { log } from './log.js'
import { settings, clampAnnounceRate } from './store.js'

const MONATE = [
  'Januar', 'Februar', 'Maerz', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
]
const WOCHENTAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']

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

/** Immer 24-Stunden-Format, unabhaengig von der Spracheinstellung des Geraets. */
export function uhrzeit24(datum) {
  const h = String(datum.getHours()).padStart(2, '0')
  const m = String(datum.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/**
 * Ansagetext bauen, z. B.:
 *   "Von Deutschlandfunk Nachrichten, heute um 19:00 Uhr."
 *
 * Ohne verwertbares Datum bleibt es beim Namen - eine falsche Zeit anzusagen
 * waere schlimmer als gar keine.
 */
export function ansageText(titel, veroeffentlicht, jetzt = new Date()) {
  const name = String(titel || '').trim()
  if (!name) return ''
  if (!veroeffentlicht) return `Von ${name}.`

  const datum = veroeffentlicht instanceof Date ? veroeffentlicht : new Date(veroeffentlicht)
  if (Number.isNaN(datum.getTime())) return `Von ${name}.`

  return `Von ${name}, ${relativerTag(datum, jetzt)} um ${uhrzeit24(datum)} Uhr.`
}

// Platzhalter, den der Server beim Abruf durch die dann aktuelle Uhrzeit
// ersetzt. Beim Casten wird die Warteschlange im Voraus gebaut - eine hier
// eingesetzte Zeit waere am Ende der Playlist laengst veraltet.
export const ZEIT_PLATZHALTER = '{zeit}'

const ABSCHLUSS = 'Das waren deine Nachrichten. Es ist jetzt'

/** Abschlussansage mit der Uhrzeit von jetzt - fuer die lokale Wiedergabe. */
export function abschlussText(jetzt = new Date()) {
  return `${ABSCHLUSS} ${uhrzeit24(jetzt)} Uhr.`
}

/** Dieselbe Ansage mit Platzhalter - fuer den Server beim Casten. */
export function abschlussVorlage() {
  return `${ABSCHLUSS} ${ZEIT_PLATZHALTER} Uhr.`
}

/**
 * Adresse der Ansage als Audiodatei vom eigenen Server.
 *
 * Die Sprachausgabe des Browsers kommt hier nicht in Frage: beim Casten kaeme
 * sie aus dem Telefon, waehrend die Folge auf dem Lautsprecher laeuft, und im
 * Hintergrund faellt sie mit "synthesis-failed" aus - also genau dort, wo die
 * App am meisten laeuft. Der Ton kommt deshalb immer vom Server.
 */
export function ansageUrl(text, rate) {
  if (!text) return ''
  // Der Zeitversatz erlaubt dem Server, {zeit} in Ortszeit einzusetzen.
  const tz = new Date().getTimezoneOffset()
  const tempo = clampAnnounceRate(rate === undefined ? settings.announceRate : rate)
  const pfad =
    `/say?text=${encodeURIComponent(text)}` +
    `&rate=${encodeURIComponent(tempo)}` +
    `&tz=${encodeURIComponent(tz)}`
  return new URL(pfad, location.href).toString()
}

/**
 * Hat der Server eine Stimme eingerichtet?
 *
 * Ohne sie antwortet /say mit 503 und die App laeuft ohne Ansagen. Gefragt
 * wird mit einem kurzen, festen Text - der liegt danach im Zwischenspeicher
 * des Servers und kostet beim naechsten Mal nichts mehr.
 */
export async function serverStimmeVerfuegbar() {
  try {
    const antwort = await fetch(ansageUrl('Probe', 1), { method: 'HEAD', cache: 'no-store' })
    return antwort.ok
  } catch (e) {
    log('ansage', 'Stimme des Servers nicht erreichbar', e && e.message ? e.message : e)
    return false
  }
}

// Notbremse: liefert der Server keine Antwort, darf die Probe nicht ewig
// haengen bleiben.
const MAX_DAUER_MS = 15000

/** Ansage zur Probe abspielen - ueber denselben Weg wie spaeter die Wiedergabe. */
export function sprich(text, rate) {
  const url = ansageUrl(text, rate)
  if (!url) return Promise.resolve(false)

  return new Promise((fertig) => {
    let erledigt = false
    const beenden = (grund) => {
      if (erledigt) return
      erledigt = true
      clearTimeout(wecker)
      element.pause()
      log('ansage', 'Probe beendet', grund)
      fertig(grund === 'gesprochen')
    }

    const element = new Audio(url)
    const wecker = setTimeout(() => beenden('zeitueberschreitung'), MAX_DAUER_MS)
    element.onended = () => beenden('gesprochen')
    element.onerror = () => beenden('nicht abspielbar')
    log('ansage', 'Probe spricht', { text, tempo: rate === undefined ? settings.announceRate : rate })
    element.play().catch((e) => beenden(`nicht moeglich: ${e && e.message ? e.message : e}`))
  })
}
