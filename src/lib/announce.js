import { log } from './log.js'

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

export function sprachausgabeVerfuegbar() {
  return typeof window !== 'undefined' && !!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function'
}

// Notbremse: meldet der Browser das Ende der Ansage nicht (im Hintergrund
// kommt das vor), darf die Wiedergabe trotzdem nicht haengen bleiben.
const MAX_DAUER_MS = 15000

/** Text vorlesen. Loest immer auf - auch bei Fehler oder Zeitueberschreitung. */
export function sprich(text, sprache = 'de-DE') {
  if (!text || !sprachausgabeVerfuegbar()) return Promise.resolve(false)

  return new Promise((fertig) => {
    let erledigt = false
    const beenden = (grund) => {
      if (erledigt) return
      erledigt = true
      clearTimeout(wecker)
      log('ansage', 'beendet', grund)
      fertig(grund === 'gesprochen')
    }

    const wecker = setTimeout(() => {
      try {
        window.speechSynthesis.cancel()
      } catch (e) {
        // Manche Browser werfen beim Abbrechen - dann eben nicht.
      }
      beenden('zeitueberschreitung')
    }, MAX_DAUER_MS)

    try {
      window.speechSynthesis.cancel()
      const spruch = new window.SpeechSynthesisUtterance(text)
      spruch.lang = sprache
      spruch.rate = 1.05
      spruch.onend = () => beenden('gesprochen')
      spruch.onerror = (e) => beenden(`fehler: ${(e && e.error) || 'unbekannt'}`)
      log('ansage', 'spricht', text)
      window.speechSynthesis.speak(spruch)
    } catch (e) {
      beenden(`nicht moeglich: ${e && e.message ? e.message : e}`)
    }
  })
}
