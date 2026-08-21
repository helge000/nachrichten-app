import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SAY_PATH = '/say'

// --- Neuronale Stimme (sherpa-onnx mit einem VITS-Modell) -------------------
//
// Klingt wie Piper, kostet aber nur ein 2,4-MB-Binary plus onnxruntime statt
// eines Python-Stapels mit numpy - rund 190 MB weniger. Fehlt sie, springt
// espeak-ng ein.
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

/** Mit der neuronalen Stimme sprechen. Schreibt in eine temporaere Datei. */
function neuronalSprechen(text, rate) {
  return new Promise((resolve, reject) => {
    const ziel = path.join(os.tmpdir(), `ansage-${process.pid}-${Date.now()}.wav`)
    // length_scale ist die Dauer je Laut: kleiner heisst schneller.
    const tempo = (1 / Math.min(2.5, Math.max(0.5, Number(rate) || 1))).toFixed(3)

    const kind = spawn(
      TTS_BIN,
      [
        `--vits-model=${modellDatei()}`,
        `--vits-tokens=${path.join(TTS_VOICE, 'tokens.txt')}`,
        `--vits-data-dir=${path.join(TTS_VOICE, 'espeak-ng-data')}`,
        `--vits-length-scale=${tempo}`,
        `--output-filename=${ziel}`,
        text
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )

    let meldung = ''
    kind.stderr.on('data', (d) => (meldung += d.toString()))
    kind.on('error', (e) => reject(e))
    kind.on('close', (code) => {
      try {
        if (code !== 0) throw new Error(meldung.trim().split('\n').pop() || `Code ${code}`)
        const wav = fs.readFileSync(ziel)
        if (wav.length < 45) throw new Error('kein Audio erzeugt')
        resolve(wav)
      } catch (e) {
        reject(e)
      } finally {
        try {
          fs.unlinkSync(ziel)
        } catch (e) {
          // schon weg
        }
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
// espeak-ng rechnet in Woertern pro Minute; 175 ist die Normalgeschwindigkeit.
const BASE_WPM = 175
const MIN_WPM = 90
const MAX_WPM = 450

// Dieselbe Ansage wiederholt sich (gleiche Quelle, gleiche Folge), deshalb
// ein kleiner Zwischenspeicher. Ein paar hundert KB, mehr wird es nie.
const CACHE_MAX = 40
const cache = new Map()

function wpm(rate) {
  const n = Number(rate)
  if (!Number.isFinite(n) || n <= 0) return BASE_WPM
  return Math.round(Math.min(MAX_WPM, Math.max(MIN_WPM, BASE_WPM * n)))
}

/** espeak-ng aufrufen - als Argumentliste, nie ueber eine Shell. */
function synthesize(text, geschwindigkeit) {
  return new Promise((resolve, reject) => {
    const kind = spawn(
      'espeak-ng',
      ['-v', 'de', '-s', String(geschwindigkeit), '--stdout', text],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const teile = []
    let fehler = ''
    kind.stdout.on('data', (d) => teile.push(d))
    kind.stderr.on('data', (d) => (fehler += d.toString()))
    kind.on('error', (e) =>
      reject(new Error(e.code === 'ENOENT' ? 'espeak-ng ist nicht installiert' : e.message))
    )
    kind.on('close', (code) => {
      if (code !== 0) return reject(new Error(fehler.trim() || `espeak-ng endete mit ${code}`))
      const wav = Buffer.concat(teile)
      if (wav.length < 45) return reject(new Error('espeak-ng lieferte kein Audio'))
      resolve(wav)
    })
  })
}

/**
 * Ansage als WAV.
 *
 *   /say?text=Von%20...&rate=1.4
 *
 * Gesprochen wird mit der neuronalen Stimme; faellt die aus, mit espeak-ng.
 * Gebraucht wird das nur beim Casten: die Sprachausgabe des Browsers wuerde
 * aus dem Telefon kommen, nicht aus dem Lautsprecher, auf dem die Folge laeuft.
 * Der Chromecast holt sich diese Datei selbst, deshalb muss sie als normales
 * Medium abrufbar sein. WAV (LPCM) spielt jedes Cast-Geraet ab.
 */
export async function handleSayRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  let text = (url.searchParams.get('text') || '').trim()
  const geschwindigkeit = wpm(url.searchParams.get('rate'))

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
  const schluessel = `${geschwindigkeit}|${text}`
  let wav = mitZeit ? null : cache.get(schluessel)

  if (!wav) {
    const rate = Number(url.searchParams.get('rate')) || 1
    try {
      // Erst die gute Stimme, nur zur Not die robotische.
      if (neuronaleStimmeDa()) wav = await neuronalSprechen(text, rate)
      else wav = await synthesize(text, geschwindigkeit)
    } catch (e) {
      try {
        wav = await synthesize(text, geschwindigkeit)
      } catch (e2) {
        return fehler(503, `Ansage nicht moeglich: ${e2.message || e2}`)
      }
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

/** Welche Stimme steht bereit? Fuer die Startmeldung. */
export async function sprachausgabeVerfuegbar() {
  if (neuronaleStimmeDa()) return 'neuronal'
  const espeak = await new Promise((resolve) => {
    const kind = spawn('espeak-ng', ['--version'], { stdio: 'ignore' })
    kind.on('error', () => resolve(false))
    kind.on('close', (code) => resolve(code === 0))
  })
  return espeak ? 'espeak-ng' : ''
}
