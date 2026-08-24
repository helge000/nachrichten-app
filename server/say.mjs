import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SAY_PATH = '/say'

// --- Neuronale Stimme (sherpa-onnx mit einem VITS-Modell) -------------------
//
// Klingt wie Piper, kostet aber nur ein 2,4-MB-Binary plus onnxruntime statt
// eines Python-Stapels mit numpy - rund 190 MB weniger. Fehlt sie, gibt es
// keine Ansage: eine robotische Ersatzstimme waere schlechter als keine.
const TTS_DIR = process.env.TTS_DIR || '/opt/tts'
const TTS_BIN = path.join(TTS_DIR, 'bin', 'sherpa-onnx-offline-tts')
const TTS_VOICE = path.join(TTS_DIR, 'voice')

function neuronaleStimmeDa() {
  try {
    return fs.existsSync(TTS_BIN) && fs.existsSync(path.join(TTS_VOICE, 'tokens.txt'))
  } catch (e) {
    return false
  }
}

function modellDatei() {
  const dateien = fs.readdirSync(TTS_VOICE).filter((f) => f.endsWith('.onnx'))
  if (!dateien.length) throw new Error('kein .onnx-Modell gefunden')
  return path.join(TTS_VOICE, dateien[0])
}

// Jede Anfrage startet einen eigenen Prozess, und /say ist offen erreichbar -
// ohne Bremse genuegen ein paar Dutzend Anfragen, um die CPU dichtzumachen.
// Zwei gleichzeitig reichen fuer den Zweck (ein Telefon, ein Chromecast); wer
// darueber hinaus anfragt, wartet kurz und bekommt sonst ein ehrliches
// "ausgelastet" statt einer Antwort in zwei Minuten.
const MAX_GLEICHZEITIG = 2
const MAX_WARTEND = 8
// Eine Ansage ist nach ein bis zwei Sekunden fertig. Haengt der Prozess,
// blockiert er sonst dauerhaft einen der beiden Plaetze.
const MAX_LAUFZEIT_MS = 20000

let laufend = 0
const warteschlange = []

/** Gibt false, wenn schon zu viele warten. */
function platzNehmen() {
  if (laufend < MAX_GLEICHZEITIG) {
    laufend += 1
    return Promise.resolve(true)
  }
  if (warteschlange.length >= MAX_WARTEND) return Promise.resolve(false)
  return new Promise((frei) => warteschlange.push(frei))
}

function platzFreigeben() {
  const naechster = warteschlange.shift()
  // Den Platz direkt weiterreichen, statt ihn erst zurueckzugeben.
  if (naechster) naechster(true)
  else laufend -= 1
}

/** Mit der neuronalen Stimme sprechen. Schreibt in eine temporaere Datei. */
function neuronalSprechen(text, rate) {
  return new Promise((resolve, reject) => {
    // Zufallsteil im Namen: zwei Synthesen koennen in dieselbe Millisekunde
    // fallen, und dann schrieben sie in dieselbe Datei.
    const marke = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const ziel = path.join(os.tmpdir(), `ansage-${process.pid}-${marke}.wav`)
    // length_scale ist die Dauer je Laut: kleiner heisst schneller.
    const tempo = (1 / Math.min(2.5, Math.max(0.5, Number(rate) || 1))).toFixed(3)

    // sherpa-onnx nimmt das letzte Argument als Text. Beginnt der mit "-",
    // haelt der Parser ihn fuer eine Option und die Synthese schlaegt fehl.
    // Ein fuehrendes Leerzeichen nimmt ihm diese Bedeutung und ist fuer die
    // Aussprache folgenlos.
    const argument = text.startsWith('-') ? ` ${text}` : text

    const kind = spawn(
      TTS_BIN,
      [
        `--vits-model=${modellDatei()}`,
        `--vits-tokens=${path.join(TTS_VOICE, 'tokens.txt')}`,
        `--vits-data-dir=${path.join(TTS_VOICE, 'espeak-ng-data')}`,
        `--vits-length-scale=${tempo}`,
        `--output-filename=${ziel}`,
        argument
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )

    let meldung = ''
    let erledigt = false

    // Genau einmal abschliessen - und nicht auf 'close' warten muessen. Das
    // Ereignis kommt erst, wenn auch die stdio-Pipes zu sind; haengt ein
    // Kindeskind daran, bliebe die Anfrage sonst trotz Kill offen.
    const abschluss = (fehler, wav) => {
      if (erledigt) return
      erledigt = true
      clearTimeout(wecker)
      try {
        fs.unlinkSync(ziel)
      } catch (e) {
        // schon weg oder nie entstanden
      }
      if (fehler) reject(fehler)
      else resolve(wav)
    }

    const wecker = setTimeout(() => {
      kind.kill('SIGKILL')
      abschluss(new Error(`Zeitüberschreitung nach ${MAX_LAUFZEIT_MS / 1000} s`))
    }, MAX_LAUFZEIT_MS)

    kind.stderr.on('data', (d) => (meldung += d.toString()))
    kind.on('error', (e) => abschluss(e))
    kind.on('close', (code) => {
      if (erledigt) return
      try {
        if (code !== 0) throw new Error(meldung.trim().split('\n').pop() || `Code ${code}`)
        const wav = fs.readFileSync(ziel)
        if (wav.length < 45) throw new Error('kein Audio erzeugt')
        // Erst das Format, dann Ausklang und Pause - die entstehen dann
        // gleich in der Zielrate.
        abschluss(null, ausklingenLassen(aufAusgabeformat(wav)))
      } catch (e) {
        abschluss(e)
      }
    })
  })
}

// Ausklang und Pause, die an jede Ansage angehaengt werden.
//
// Die Stimme hoert abrupt auf: nach dem letzten Laut bleiben rund 50 ms
// Stille, dann setzt die Folge mit vollem Pegel ein. Dieser uebergangslose
// Wechsel knackt hoerbar. Am Ende der Wiedergabe faellt es nicht auf, weil
// dort nichts mehr folgt - genau so wurde es auch berichtet.
//
// Warum in der Datei und nicht im Player: beim Casten baut der Empfaenger die
// Warteschlange selbst ab, dort hat die App keinen Griff auf den Uebergang.
// In der Datei wirkt die Pause auf beiden Wegen.
const AUSKLANG_MS = 15
const PAUSE_MS = 250

// Ausgabeformat der Ansage: 44,1 kHz, zwei Kanaele.
//
// Die Pause allein hat das Knacken nicht beseitigt. Es kommt vom Formatwechsel:
// die Ansage lief mit der Rate des Sprachmodells (16 kHz mono bei kerstin),
// die Folge danach mit den ueblichen 44,1 kHz stereo. Beides laeuft ueber
// dasselbe Audio-Element, und beim Wechsel richtet das Geraet seinen
// Ausgabekanal neu ein - das knackt. Am Ende der Wiedergabe folgt nichts mehr,
// deshalb war es dort nie zu hoeren.
//
// Die Ansage wird deshalb auf das Format hochgerechnet, in dem Podcasts
// praktisch immer vorliegen. Liefert eine Folge ein anderes Format, wechselt es
// weiterhin - das laesst sich von hier aus nicht wissen.
const ZIEL_RATE = 44100
const ZIEL_KANAELE = 2

/** Kopfdaten einer WAV-Datei lesen - ohne feste 44 Byte anzunehmen. */
function wavKopf(wav) {
  if (wav.length < 12) return null
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null

  let pos = 12
  let format = null
  while (pos + 8 <= wav.length) {
    const kennung = wav.toString('ascii', pos, pos + 4)
    const laenge = wav.readUInt32LE(pos + 4)
    if (kennung === 'fmt ' && pos + 24 <= wav.length) {
      format = {
        kanaele: wav.readUInt16LE(pos + 10),
        rate: wav.readUInt32LE(pos + 12),
        bits: wav.readUInt16LE(pos + 22)
      }
    }
    if (kennung === 'data') {
      if (!format) return null
      return {
        ...format,
        datenStart: pos + 8,
        datenLaenge: Math.min(laenge, wav.length - pos - 8),
        groesseFeld: pos + 4
      }
    }
    pos += 8 + laenge + (laenge % 2)
  }
  return null
}

/**
 * Einen Kanal auf eine andere Abtastrate bringen.
 *
 * Kubische Interpolation nach Catmull-Rom: deutlich glatter als die lineare,
 * die beim Hochrechnen hoerbar dumpf wird, und ohne den Aufwand eines
 * Filterentwurfs. Beim Hochrechnen entsteht kein Aliasing - die neuen Punkte
 * liegen zwischen den alten.
 */
function neuAbtasten(quelle, faktor) {
  const laenge = Math.max(1, Math.round(quelle.length * faktor))
  const ziel = new Int16Array(laenge)
  const holen = (i) => quelle[Math.min(quelle.length - 1, Math.max(0, i))]

  for (let i = 0; i < laenge; i++) {
    const stelle = i / faktor
    const k = Math.floor(stelle)
    const t = stelle - k
    const p0 = holen(k - 1)
    const p1 = holen(k)
    const p2 = holen(k + 1)
    const p3 = holen(k + 2)
    const wert =
      0.5 *
      (2 * p1 +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
    ziel[i] = Math.max(-32768, Math.min(32767, Math.round(wert)))
  }
  return ziel
}

/** 16-Bit-PCM mit dem ueblichen 44-Byte-Kopf zusammensetzen. */
function wavSchreiben(kanaele, rate) {
  const anzahl = kanaele.length
  const bilder = kanaele[0].length
  const daten = Buffer.alloc(bilder * anzahl * 2)
  for (let bild = 0; bild < bilder; bild++) {
    for (let k = 0; k < anzahl; k++) {
      daten.writeInt16LE(kanaele[k][bild], (bild * anzahl + k) * 2)
    }
  }

  const kopf = Buffer.alloc(44)
  kopf.write('RIFF', 0, 'ascii')
  kopf.writeUInt32LE(36 + daten.length, 4)
  kopf.write('WAVE', 8, 'ascii')
  kopf.write('fmt ', 12, 'ascii')
  kopf.writeUInt32LE(16, 16)
  kopf.writeUInt16LE(1, 20) // PCM
  kopf.writeUInt16LE(anzahl, 22)
  kopf.writeUInt32LE(rate, 24)
  kopf.writeUInt32LE(rate * anzahl * 2, 28) // Bytes je Sekunde
  kopf.writeUInt16LE(anzahl * 2, 32) // Bytes je Bild
  kopf.writeUInt16LE(16, 34) // Bits je Probe
  kopf.write('data', 36, 'ascii')
  kopf.writeUInt32LE(daten.length, 40)
  return Buffer.concat([kopf, daten])
}

/**
 * Ansage auf das Ausgabeformat bringen (siehe ZIEL_RATE/ZIEL_KANAELE).
 *
 * Stimmt beides schon, bleibt die Datei, wie sie ist. Was nicht als
 * 16-Bit-PCM zu erkennen ist, wird nicht angefasst.
 */
function aufAusgabeformat(wav) {
  const kopf = wavKopf(wav)
  if (!kopf || kopf.bits !== 16 || !kopf.kanaele || !kopf.rate) return wav
  if (kopf.rate === ZIEL_RATE && kopf.kanaele === ZIEL_KANAELE) return wav

  const proBild = 2 * kopf.kanaele
  const bilder = Math.floor(kopf.datenLaenge / proBild)
  if (!bilder) return wav

  // Erst in einzelne Kanaele zerlegen - interleaved laesst sich nicht rechnen.
  const quelle = []
  for (let k = 0; k < kopf.kanaele; k++) {
    const spur = new Int16Array(bilder)
    for (let bild = 0; bild < bilder; bild++) {
      spur[bild] = wav.readInt16LE(kopf.datenStart + (bild * kopf.kanaele + k) * 2)
    }
    quelle.push(spur)
  }

  const faktor = ZIEL_RATE / kopf.rate
  const gerechnet = quelle.map((spur) => (faktor === 1 ? spur : neuAbtasten(spur, faktor)))

  // Auf die Zielanzahl bringen: mono wird auf beide Seiten gelegt, mehr Kanaele
  // als gebraucht fallen weg.
  const ziel = []
  for (let k = 0; k < ZIEL_KANAELE; k++) ziel.push(gerechnet[k % gerechnet.length])

  return wavSchreiben(ziel, ZIEL_RATE)
}

/**
 * Ansage sanft ausklingen lassen und eine Pause anhaengen.
 *
 * Der Ausklang ist die Versicherung gegen einen Sprung im Signal, die Pause
 * der eigentliche Zweck: zwischen Ansage und Folge soll ein Atemzug liegen.
 * Ist die Datei nicht das erwartete 16-Bit-PCM, bleibt sie unangetastet -
 * eine halb verstandene Datei zu veraendern waere schlimmer als ein Knacken.
 */
function ausklingenLassen(wav) {
  const kopf = wavKopf(wav)
  if (!kopf || kopf.bits !== 16 || !kopf.kanaele || !kopf.rate) return wav

  const proBild = 2 * kopf.kanaele
  const bilder = Math.floor(kopf.datenLaenge / proBild)
  if (!bilder) return wav

  const daten = Buffer.from(wav.subarray(kopf.datenStart, kopf.datenStart + bilder * proBild))

  // Ueber die letzten Millisekunden linear auf null herunterziehen.
  const ausklang = Math.min(bilder, Math.round((kopf.rate * AUSKLANG_MS) / 1000))
  for (let i = 0; i < ausklang; i++) {
    const faktor = (ausklang - i) / ausklang
    const bild = bilder - ausklang + i
    for (let k = 0; k < kopf.kanaele; k++) {
      const stelle = (bild * kopf.kanaele + k) * 2
      daten.writeInt16LE(Math.round(daten.readInt16LE(stelle) * faktor), stelle)
    }
  }

  const stille = Buffer.alloc(Math.round((kopf.rate * PAUSE_MS) / 1000) * proBild)
  const kopfteil = Buffer.from(wav.subarray(0, kopf.datenStart))
  const fertig = Buffer.concat([kopfteil, daten, stille])

  // Groessenangaben nachziehen, sonst spielt die Datei nur den alten Teil.
  fertig.writeUInt32LE(daten.length + stille.length, kopf.groesseFeld)
  fertig.writeUInt32LE(fertig.length - 8, 4)
  return fertig
}

const MAX_TEXT = 300

// Der Sender schickt die Uhrzeit nicht mit, sondern diesen Platzhalter: beim
// Casten steht die Warteschlange lange bevor die letzte Ansage laeuft, eine
// eingebackene Zeit waere dann falsch. Ersetzt wird sie erst beim Abruf.
const ZEIT_PLATZHALTER = '{zeit}'

export function jetztInZone(offsetMinuten) {
  const versatz = Number(offsetMinuten)
  // Ohne brauchbare Angabe die Zeit des Servers nehmen.
  if (!Number.isFinite(versatz) || Math.abs(versatz) > 900) return new Date()
  return new Date(Date.now() - versatz * 60000)
}

/**
 * Uhrzeit so schreiben, dass die Sprachausgabe sie richtig liest.
 *
 * Muss zeichengleich zu stundeMinuteGesprochen in src/lib/announce.js sein -
 * dieselbe Uhrzeit soll aus dem Lautsprecher gleich klingen, egal ob sie hier
 * eingesetzt oder schon vom Sender geschrieben wurde. server/ kommt bewusst
 * ohne Abhaengigkeiten aus, deshalb steht die Regel zweimal da.
 *
 *   19:00 -> "19 Uhr"      volle Stunde ohne Minuten
 *   19:15 -> "19 Uhr 15"   Doppelpunkt und fuehrende Nullen liest espeak-ng
 *   19:05 -> "19 Uhr 5"    sonst einzeln vor ("null fuenf")
 *   01:00 -> "ein Uhr"     als Zahl gelesen waere es "eins Uhr"
 *
 * jetztInZone hat das Datum so verschoben, dass die UTC-Werte die Ortszeit
 * des anfragenden Geraets tragen.
 */
function uhrzeitGesprochen(datum) {
  const stunde = datum.getUTCHours()
  const minute = datum.getUTCMinutes()
  const h = stunde === 1 ? 'ein' : String(stunde)
  return minute === 0 ? `${h} Uhr` : `${h} Uhr ${minute}`
}

/** Platzhalter durch die Ortszeit des anfragenden Geraets ersetzen. */
export function zeitEinsetzen(text, tzOffset, jetzt) {
  if (!text.includes(ZEIT_PLATZHALTER)) return text
  const datum = jetzt || jetztInZone(tzOffset)
  const gesprochen = uhrzeitGesprochen(datum)
  // Das "Uhr" steckt jetzt in der eingesetzten Zeit. Aeltere Fassungen der App
  // schreiben es noch dahinter - und der Chromecast haelt seine Adressen ueber
  // die ganze Warteschlange fest. Deshalb hier beide Formen bedienen, sonst
  // saehe der Empfaenger "19 Uhr Uhr".
  return text
    .split(`${ZEIT_PLATZHALTER} Uhr`)
    .join(gesprochen)
    .split(ZEIT_PLATZHALTER)
    .join(gesprochen)
}
// Dieselbe Ansage wiederholt sich (gleiche Quelle, gleiche Folge), deshalb
// Hoechstens so viel Stille darf vor eine Ansage gesetzt werden. Begrenzt,
// damit ueber die Adresse niemand beliebig grosse Dateien erzeugen kann.
const MAX_VORLAUF_MS = 5000

/**
 * Stille vor die Ansage setzen.
 *
 * Gebraucht fuer Lautsprechergruppen: dort holt das Leitgeraet den Ton und
 * verteilt ihn an die uebrigen, und dafuer laeuft es dem Rest der Gruppe um
 * gut zwei Sekunden voraus. Eine Ansage dauert rund zwei Sekunden - sie ist
 * also vorbei, bevor die anderen Geraete ueberhaupt angefangen haben. Genau so
 * klingt es: die Ansage kommt nur aus einem Lautsprecher, die Folge danach aus
 * allen.
 */
function mitVorlauf(wav, ms) {
  if (!ms) return wav
  const kopf = wavKopf(wav)
  if (!kopf || kopf.bits !== 16 || !kopf.kanaele || !kopf.rate) return wav

  const bilder = Math.round((ms / 1000) * kopf.rate)
  if (bilder <= 0) return wav
  const stille = Buffer.alloc(bilder * kopf.kanaele * 2)
  const daten = wav.subarray(kopf.datenStart, kopf.datenStart + kopf.datenLaenge)
  const neu = Buffer.concat([wav.subarray(0, kopf.datenStart), stille, daten])

  // Beide Laengenfelder mitziehen, sonst haelt der Abspieler die Datei fuer
  // kuerzer als sie ist und schneidet das Ende ab.
  neu.writeUInt32LE(neu.length - 8, 4)
  neu.writeUInt32LE(stille.length + daten.length, kopf.groesseFeld)
  return neu
}

/**
 * Bereichsanfrage auswerten.
 *
 * Der Kopf meldet seit jeher "accept-ranges: bytes", geliefert wurde aber immer
 * die ganze Datei mit Status 200. Cast-Geraete fragen Medien abschnittsweise
 * ab - in der Gruppe tut es das Leitgeraet fuer alle.
 *
 * Rueckgabe: null (nichts zu tun - keine oder eine unverstaendliche Anfrage,
 * die nach RFC 7233 zu ignorieren ist), 'ungueltig' fuer einen verstandenen,
 * aber unerfuellbaren Bereich (416) oder { start, ende }.
 */
function bereich(kopfzeile, laenge) {
  if (!kopfzeile) return null
  const treffer = /^bytes=(\d*)-(\d*)$/.exec(String(kopfzeile).trim())
  if (!treffer) return null

  const [, von, bis] = treffer
  if (von === '' && bis === '') return null

  let start
  let ende
  if (von === '') {
    // "bytes=-500": die letzten 500 Bytes. Null Bytes sind nicht erfuellbar.
    const anzahl = Number(bis)
    if (!Number.isFinite(anzahl) || anzahl <= 0) return 'ungueltig'
    start = Math.max(0, laenge - anzahl)
    ende = laenge - 1
  } else {
    start = Number(von)
    ende = bis === '' ? laenge - 1 : Math.min(Number(bis), laenge - 1)
    // Ende vor Anfang ist kein gueltiger Bereich - also ignorieren, nicht 416.
    if (Number.isFinite(ende) && start > ende && start < laenge) return null
  }
  if (!Number.isFinite(start) || !Number.isFinite(ende)) return null
  if (start >= laenge) return 'ungueltig'
  if (start > ende) return 'ungueltig'
  return { start, ende }
}

// ein Zwischenspeicher. Seit die Ansagen im Ausgabeformat vorliegen, wiegt
// jede rund eine halbe Megabyte (3 s bei 44,1 kHz stereo) statt knapp 100 KB -
// entsprechend weniger Eintraege, damit es bei rund 10 MB bleibt.
const CACHE_MAX = 20
const cache = new Map()

/**
 * Ansage als WAV.
 *
 *   /say?text=Von%20...&rate=1.4
 *
 * Ohne die neuronale Stimme gibt es keine Ansage - die App laeuft dann
 * einfach ohne. Gebraucht wird das nur beim Casten: die Sprachausgabe des Browsers wuerde
 * aus dem Telefon kommen, nicht aus dem Lautsprecher, auf dem die Folge laeuft.
 * Der Chromecast holt sich diese Datei selbst, deshalb muss sie als normales
 * Medium abrufbar sein. WAV (LPCM) spielt jedes Cast-Geraet ab.
 */
export async function handleSayRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  let text = (url.searchParams.get('text') || '').trim()
  const rate = Number(url.searchParams.get('rate')) || 1
  const vorlauf = Math.min(
    MAX_VORLAUF_MS,
    Math.max(0, Math.round(Number(url.searchParams.get('vorlauf')) || 0))
  )

  // "tz" ist der Versatz aus getTimezoneOffset() des Geraets, in Minuten.
  const mitZeit = text.includes(ZEIT_PLATZHALTER)
  if (mitZeit) text = zeitEinsetzen(text, url.searchParams.get('tz'))

  const fehler = (status, meldung) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' })
    res.end(meldung)
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS'
    })
    return res.end()
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return fehler(405, 'Nur GET/HEAD')
  if (!text) return fehler(400, 'Parameter "text" fehlt')
  if (text.length > MAX_TEXT) return fehler(413, `Text zu lang (max. ${MAX_TEXT} Zeichen)`)

  // Ansagen mit Uhrzeit duerfen nicht zwischengespeichert werden.
  const schluessel = `${rate}|${text}`
  let wav = mitZeit ? null : cache.get(schluessel)

  if (!wav) {
    if (!neuronaleStimmeDa()) return fehler(503, 'Keine Sprachausgabe eingerichtet')

    if (!(await platzNehmen())) {
      res.writeHead(503, {
        'content-type': 'text/plain; charset=utf-8',
        'access-control-allow-origin': '*',
        'retry-after': '2'
      })
      return res.end('Sprachausgabe ausgelastet')
    }
    try {
      wav = await neuronalSprechen(text, rate)
    } catch (e) {
      return fehler(503, `Ansage nicht möglich: ${e.message || e}`)
    } finally {
      platzFreigeben()
    }

    if (!mitZeit) {
      cache.set(schluessel, wav)
      // Aeltesten Eintrag verwerfen, wenn es zu viele werden.
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
    }
  }

  // Der Vorlauf kommt erst hier dazu: im Zwischenspeicher liegt die Ansage
  // ohne ihn, damit dieselbe Aufnahme fuer Gruppe und Einzelgeraet reicht.
  const antwort = mitVorlauf(wav, vorlauf)

  const kopfzeilen = {
    'content-type': 'audio/wav',
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    'cache-control': mitZeit ? 'no-store' : 'public, max-age=3600'
  }

  const teil = bereich(req.headers.range, antwort.length)
  if (teil === 'ungueltig') {
    res.writeHead(416, { ...kopfzeilen, 'content-range': `bytes */${antwort.length}` })
    return res.end()
  }
  if (teil) {
    const stueck = antwort.subarray(teil.start, teil.ende + 1)
    res.writeHead(206, {
      ...kopfzeilen,
      'content-length': stueck.length,
      'content-range': `bytes ${teil.start}-${teil.ende}/${antwort.length}`
    })
    if (req.method === 'HEAD') return res.end()
    return res.end(stueck)
  }

  res.writeHead(200, { ...kopfzeilen, 'content-length': antwort.length })
  if (req.method === 'HEAD') return res.end()
  res.end(antwort)
}

/** Steht die Sprachausgabe bereit? Fuer die Startmeldung. */
export function sprachausgabeVerfuegbar() {
  return Promise.resolve(neuronaleStimmeDa() ? 'neuronal' : '')
}
