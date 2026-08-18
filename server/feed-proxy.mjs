import { Buffer } from 'node:buffer'
import { checkTarget, fetchGuarded, USER_AGENT } from './url-guard.mjs'

export const FEED_PATH = '/feed'

const MAX_BYTES = 8 * 1024 * 1024

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

  try {
    const response = await fetchGuarded(target, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml, */*' }
    })
    if (!response.ok) return send(response.status, `Feed antwortete mit HTTP ${response.status}`)

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_BYTES) return send(502, 'Feed ist zu gross')
    send(200, buffer, response.headers.get('content-type') || 'application/xml; charset=utf-8')
  } catch (e) {
    send(502, `Feed nicht erreichbar: ${e.message || e}`)
  }
}
