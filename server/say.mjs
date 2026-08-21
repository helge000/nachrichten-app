import { spawn } from 'node:child_process'

export const SAY_PATH = '/say'

const MAX_TEXT = 300
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
 * Gebraucht wird das nur beim Casten: die Sprachausgabe des Browsers wuerde
 * aus dem Telefon kommen, nicht aus dem Lautsprecher, auf dem die Folge laeuft.
 * Der Chromecast holt sich diese Datei selbst, deshalb muss sie als normales
 * Medium abrufbar sein. WAV (LPCM) spielt jedes Cast-Geraet ab.
 */
export async function handleSayRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const text = (url.searchParams.get('text') || '').trim()
  const geschwindigkeit = wpm(url.searchParams.get('rate'))

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

  const schluessel = `${geschwindigkeit}|${text}`
  let wav = cache.get(schluessel)

  if (!wav) {
    try {
      wav = await synthesize(text, geschwindigkeit)
    } catch (e) {
      return fehler(503, `Ansage nicht moeglich: ${e.message || e}`)
    }
    cache.set(schluessel, wav)
    // Aeltesten Eintrag verwerfen, wenn es zu viele werden.
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  }

  res.writeHead(200, {
    'content-type': 'audio/wav',
    'content-length': wav.length,
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    // Kurzlebig: die Uhrzeit im Text macht die Ansage ohnehin schnell veraltet.
    'cache-control': 'public, max-age=3600'
  })
  if (req.method === 'HEAD') return res.end()
  res.end(wav)
}

/** Steht espeak-ng bereit? Fuer die Startmeldung. */
export function sprachausgabeVerfuegbar() {
  return new Promise((resolve) => {
    const kind = spawn('espeak-ng', ['--version'], { stdio: 'ignore' })
    kind.on('error', () => resolve(false))
    kind.on('close', (code) => resolve(code === 0))
  })
}
