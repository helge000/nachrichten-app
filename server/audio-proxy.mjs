import { Readable } from 'node:stream'
import { checkTarget, fetchGuarded, USER_AGENT, NichtErlaubt } from './url-guard.mjs'

export const AUDIO_PATH = '/audio'

// Header, die 1:1 vom Podcast-Server durchgereicht werden. Vor allem
// Accept-Ranges/Content-Range sind wichtig, sonst kann man nicht spulen.
const PASSTHROUGH = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified'
]

/**
 * Streamt eine Audio-Datei ueber den eigenen Server.
 *
 * Zweck: Viele Podcasts (z. B. alle BBC-Feeds) liefern ihre MP3s nur ueber
 * http. Eine per https ausgelieferte Seite darf die nicht laden - Chrome
 * versucht ein Upgrade auf https und bricht ab, wenn das scheitert.
 * Hier laeuft der Abruf serverseitig, der Browser bekommt alles ueber https.
 *
 * Anders als der Feed-Proxy wird nichts gepuffert, sondern durchgereicht -
 * eine Folge kann 50 MB und mehr haben.
 */
export async function handleAudioRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const raw = url.searchParams.get('url')

  const fail = (status, message) => {
    if (res.headersSent) return res.end()
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' })
    res.end(message)
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'range'
    })
    return res.end()
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Nur GET/HEAD')
  if (!raw) return fail(400, 'Parameter "url" fehlt')

  let target
  try {
    target = checkTarget(raw)
  } catch (e) {
    return fail(400, e.message)
  }

  // Bricht der Browser ab (naechster Track, Tab zu), stoppt auch der Upstream-Download.
  const controller = new AbortController()
  res.on('close', () => controller.abort())

  const headers = { 'user-agent': USER_AGENT, accept: 'audio/*, */*' }
  if (req.headers.range) headers.range = req.headers.range

  let upstream
  try {
    upstream = await fetchGuarded(target, { method: req.method, headers, signal: controller.signal })
  } catch (e) {
    if (controller.signal.aborted) return
    // Ein abgelehntes Ziel ist ein Fehler des Anrufers, kein Ausfall der
    // Gegenstelle - das faellt beim Weiterleiten erst hier auf.
    if (e instanceof NichtErlaubt) return fail(400, e.message)
    return fail(502, `Audio nicht erreichbar: ${e.message || e}`)
  }

  if (upstream.status >= 400) return fail(upstream.status, `Audio-Server antwortete mit HTTP ${upstream.status}`)

  const out = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
  for (const name of PASSTHROUGH) {
    const value = upstream.headers.get(name)
    if (value) out[name] = value
  }
  // Ohne Accept-Ranges springt der Player nicht - die meisten CDNs koennen es.
  if (!out['accept-ranges'] && upstream.status === 200) out['accept-ranges'] = 'bytes'

  res.writeHead(upstream.status, out)

  if (req.method === 'HEAD' || !upstream.body) return res.end()

  const body = Readable.fromWeb(upstream.body)
  body.on('error', () => res.destroy())
  body.pipe(res)
}
