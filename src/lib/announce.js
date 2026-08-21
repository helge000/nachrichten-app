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

// Platzhalter, den der Server beim Abruf durch die dann aktuelle Uhrzeit
// ersetzt. Beim Casten wird die Warteschlange im Voraus gebaut - eine hier
// eingesetzte Zeit waere am Ende der Playlist laengst veraltet.
export const ZEIT_PLATZHALTER = '{zeit}'

const ABSCHLUSS = 'Das waren deine Nachrichten. Es ist jetzt'

/** Abschlussansage mit der Uhrzeit von jetzt - fuer die lokale Wiedergabe. */
export function abschlussText(jetzt = new Date()) {
  return `${ABSCHLUSS} ${uhrzeitGesprochen(jetzt)}.`
}

/**
 * Dieselbe Ansage mit Platzhalter - fuer den Server beim Casten.
 *
 * Das "Uhr" steht nicht mehr hinter dem Platzhalter: es gehoert jetzt zur
 * Zeit, die der Server einsetzt.
 */
export function abschlussVorlage() {
  return `${ABSCHLUSS} ${ZEIT_PLATZHALTER}.`
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
    const wecker = setTimeout(() => beenden('zeitüberschreitung'), MAX_DAUER_MS)
    element.onended = () => beenden('gesprochen')
    element.onerror = () => beenden('nicht abspielbar')
    log('ansage', 'Probe spricht', { text, tempo: rate === undefined ? settings.announceRate : rate })
    element.play().catch((e) => beenden(`nicht möglich: ${e && e.message ? e.message : e}`))
  })
}
