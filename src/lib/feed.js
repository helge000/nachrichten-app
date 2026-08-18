import { proxied, settings } from './store.js'

function text(node, tag) {
  const el = node.querySelector(tag)
  return el ? el.textContent.trim() : ''
}

/** Neueste Folge aus einem Podcast-RSS-Feed heraussuchen. */
export function parseLatestEpisode(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Feed ist kein gueltiges XML')

  const items = Array.from(doc.querySelectorAll('item, entry'))
  if (!items.length) throw new Error('Feed enthaelt keine Folgen')

  const withDate = items.map((item) => {
    const raw = text(item, 'pubDate') || text(item, 'published') || text(item, 'updated')
    const time = raw ? Date.parse(raw) : NaN
    return { item, time: Number.isNaN(time) ? 0 : time }
  })
  // Feeds sind meist schon sortiert; ein stabiler Sort nach Datum schadet nicht.
  withDate.sort((a, b) => b.time - a.time)

  for (const { item } of withDate) {
    const enclosure = item.querySelector('enclosure[url]')
    const link = item.querySelector('link[rel="enclosure"][href]')
    const url = enclosure ? enclosure.getAttribute('url') : link ? link.getAttribute('href') : ''
    if (!url) continue
    const type = enclosure ? enclosure.getAttribute('type') : link ? link.getAttribute('type') : ''
    return {
      url,
      mimeType: type || 'audio/mpeg',
      episodeTitle: text(item, 'title')
    }
  }
  throw new Error('Keine abspielbare Audio-Datei im Feed gefunden')
}

async function get(url, signal) {
  const response = await fetch(url, { signal, redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

/**
 * Feed laden: erst ueber den Proxy (falls konfiguriert), sonst direkt.
 * Faellt der Proxy aus, wird der Direktabruf als Notnagel versucht.
 */
export async function fetchFeed(url, signal) {
  const viaProxy = proxied(url)
  if (viaProxy === url) {
    try {
      return await get(url, signal)
    } catch (e) {
      throw new Error(`Feed nicht erreichbar (${e.message || e})`)
    }
  }
  try {
    return await get(viaProxy, signal)
  } catch (proxyError) {
    try {
      return await get(url, signal)
    } catch {
      throw new Error(`Feed nicht erreichbar (${proxyError.message || proxyError}) - Proxy "${settings.corsProxy}" pruefen`)
    }
  }
}

/** Eine Quelle in einen abspielbaren Track aufloesen. */
export async function resolveSource(source, signal) {
  if (source.type === 'audio') {
    return {
      sourceId: source.id,
      title: source.title,
      subtitle: '',
      url: source.url,
      mimeType: 'audio/mpeg'
    }
  }

  const episode = parseLatestEpisode(await fetchFeed(source.url, signal))
  return {
    sourceId: source.id,
    title: source.title,
    subtitle: episode.episodeTitle,
    url: episode.url,
    mimeType: episode.mimeType
  }
}
