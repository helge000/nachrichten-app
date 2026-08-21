import { Buffer } from 'node:buffer'
import { checkTarget, fetchGuarded, USER_AGENT } from './url-guard.mjs'

export const FEED_PATH = '/feed'

const MAX_BYTES = 8 * 1024 * 1024

class ZuGross extends Error {
  constructor() {
    super('Feed ist zu gross')
  }
}

/**
 * Antwort einlesen und dabei mitzaehlen.
 *
 * Frueher stand hier ein arrayBuffer() mit anschliessender Groessenpruefung -
 * da lag die Datei aber laengst vollstaendig im Speicher. Wer den Proxy auf
 * eine beliebig grosse Datei ansetzt, braucht so nur wenige Anfragen. Jetzt
 * wird schon die angekuendigte Laenge geprueft und beim Lesen abgebrochen,
 * sobald die Grenze faellt.
 */
async function leseBegrenzt(response, maxBytes, abbruch) {
  const angekuendigt = Number(response.headers.get('content-length'))
  if (Number.isFinite(angekuendigt) && angekuendigt > maxBytes) throw new ZuGross()
  if (!response.body) return Buffer.alloc(0)

  const teile = []
  let gelesen = 0
  for await (const stueck of response.body) {
    gelesen += stueck.length
    if (gelesen > maxBytes) {
      abbruch.abort()
      throw new ZuGross()
    }
    teile.push(Buffer.from(stueck))
  }
  return Buffer.concat(teile)
}

/**
 * Minimaler Feed-Proxy: holt ein Podcast-RSS serverseitig und gibt es mit
 * CORS-Header zurueck. Noetig, weil viele Nachrichten-Feeds kein CORS senden.
 */
export async function handleFeedRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const raw = url.searchParams.get('url')

  const send = (status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, {
      'content-type': type,
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    })
    res.end(body)
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': '*'
    })
    return res.end()
  }
  if (req.method !== 'GET') return send(405, 'Nur GET')
  if (!raw) return send(400, 'Parameter "url" fehlt')

  let target
  try {
    target = checkTarget(raw)
  } catch (e) {
    return send(400, e.message)
  }

  // Bricht der Browser ab, muss auch der Upstream-Download aufhoeren.
  const abbruch = new AbortController()
  res.on('close', () => abbruch.abort())

  try {
    const response = await fetchGuarded(target, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: abbruch.signal
    })
    if (!response.ok) return send(response.status, `Feed antwortete mit HTTP ${response.status}`)

    const buffer = await leseBegrenzt(response, MAX_BYTES, abbruch)
    send(200, buffer, response.headers.get('content-type') || 'application/xml; charset=utf-8')
  } catch (e) {
    if (e instanceof ZuGross) return send(502, `Feed ist zu gross (max. ${MAX_BYTES / 1024 / 1024} MB)`)
    if (abbruch.signal.aborted) return
    send(502, `Feed nicht erreichbar: ${e.message || e}`)
  }
}
