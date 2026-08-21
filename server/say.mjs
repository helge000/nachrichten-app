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
      abschluss(new Error(`Zeitueberschreitung nach ${MAX_LAUFZEIT_MS / 1000} s`))
    }, MAX_LAUFZEIT_MS)

    kind.stderr.on('data', (d) => (meldung += d.toString()))
    kind.on('error', (e) => abschluss(e))
    kind.on('close', (code) => {
      if (erledigt) return
      try {
        if (code !== 0) throw new Error(meldung.trim().split('\n').pop() || `Code ${code}`)
        const wav = fs.readFileSync(ziel)
        if (wav.length < 45) throw new Error('kein Audio erzeugt')
        abschluss(null, wav)
      } catch (e) {
        abschluss(e)
      }
    })
  })
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

function uhrzeit24(datum) {
  const h = String(datum.getUTCHours()).padStart(2, '0')
  const m = String(datum.getUTCMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/** Platzhalter durch die Ortszeit des anfragenden Geraets ersetzen. */
export function zeitEinsetzen(text, tzOffset, jetzt) {
  if (!text.includes(ZEIT_PLATZHALTER)) return text
  const datum = jetzt || jetztInZone(tzOffset)
  return text.split(ZEIT_PLATZHALTER).join(uhrzeit24(datum))
}
// Dieselbe Ansage wiederholt sich (gleiche Quelle, gleiche Folge), deshalb
// ein kleiner Zwischenspeicher. Ein paar hundert KB, mehr wird es nie.
const CACHE_MAX = 40
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
      return fehler(503, `Ansage nicht moeglich: ${e.message || e}`)
    } finally {
      platzFreigeben()
    }

    if (!mitZeit) {
      cache.set(schluessel, wav)
      // Aeltesten Eintrag verwerfen, wenn es zu viele werden.
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
    }
  }

  res.writeHead(200, {
    'content-type': 'audio/wav',
    'content-length': wav.length,
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    'cache-control': mitZeit ? 'no-store' : 'public, max-age=3600'
  })
  if (req.method === 'HEAD') return res.end()
  res.end(wav)
}

/** Steht die Sprachausgabe bereit? Fuer die Startmeldung. */
export function sprachausgabeVerfuegbar() {
  return Promise.resolve(neuronaleStimmeDa() ? 'neuronal' : '')
}
