import { reactive, watch } from 'vue'

const KEY = 'nachrichten-app.v1'
export const SCHEMA_VERSION = 1

function makeId() {
  return Math.random().toString(36).slice(2, 10)
}

// Mitgelieferter Feed-Proxy (siehe server/feed-proxy.mjs). Noetig, weil die
// meisten Nachrichten-Feeds keine CORS-Header senden. Leer lassen = direkt laden.
export const DEFAULT_PROXY = '/feed?url={url}'

// Mitgelieferter Audio-Proxy (siehe server/audio-proxy.mjs). Wird nur benutzt,
// wenn eine per https ausgelieferte Seite eine http-Audiodatei laden muesste -
// das blockt der Browser als Mixed Content. Leer lassen = nie proxen.
export const DEFAULT_AUDIO_PROXY = '/audio?url={url}'

// Grenzen der Sprechgeschwindigkeit. Unter 0.5 wird es quaelend, ueber 2.5
// verschlucken die meisten Stimmen Silben.
export const MIN_ANNOUNCE_RATE = 0.5
export const MAX_ANNOUNCE_RATE = 2.5
export const DEFAULT_ANNOUNCE_RATE = 1.4

export function clampAnnounceRate(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_ANNOUNCE_RATE
  return Math.min(MAX_ANNOUNCE_RATE, Math.max(MIN_ANNOUNCE_RATE, n))
}

function defaults() {
  return {
    version: SCHEMA_VERSION,
    // {url} wird durch die Feed-URL ersetzt, sonst wird sie angehaengt.
    corsProxy: DEFAULT_PROXY,
    audioProxy: DEFAULT_AUDIO_PROXY,
    // Folgen im Voraus komplett laden. Ohne das bleibt die Wiedergabe stehen,
    // sobald Android das Geraet schlafen legt - dann sind neue Netzverbindungen
    // aus dem Hintergrund heraus blockiert.
    preloadEpisodes: true,
    // Vor jeder Folge Quelle und Zeitpunkt ansagen.
    announceEpisodes: true,
    // Sprechgeschwindigkeit der Ansage. 1 ist die Normalgeschwindigkeit der
    // Stimme; fuer eine kurze Ansage darf es zuegiger sein.
    announceRate: DEFAULT_ANNOUNCE_RATE,
    sources: []
  }
}

export function normalizeSource(raw) {
  return {
    id: raw.id || makeId(),
    title: (raw.title || '').trim() || 'Ohne Titel',
    url: (raw.url || '').trim(),
    // 'rss' = neueste Folge aus dem Feed, 'audio' = feste Audio-URL
    type: raw.type === 'audio' ? 'audio' : 'rss',
    enabled: raw.enabled !== false
  }
}

export function normalizeSettings(raw) {
  const base = defaults()
  if (!raw || typeof raw !== 'object') return base
  return {
    version: SCHEMA_VERSION,
    corsProxy: raw.corsProxy === undefined || raw.corsProxy === null ? DEFAULT_PROXY : String(raw.corsProxy).trim(),
    audioProxy:
      raw.audioProxy === undefined || raw.audioProxy === null ? DEFAULT_AUDIO_PROXY : String(raw.audioProxy).trim(),
    preloadEpisodes: raw.preloadEpisodes === undefined ? true : !!raw.preloadEpisodes,
    announceEpisodes: raw.announceEpisodes === undefined ? true : !!raw.announceEpisodes,
    announceRate:
      raw.announceRate === undefined ? DEFAULT_ANNOUNCE_RATE : clampAnnounceRate(raw.announceRate),
    sources: Array.isArray(raw.sources) ? raw.sources.map(normalizeSource) : []
  }
}

function load() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaults()
    return normalizeSettings(JSON.parse(raw))
  } catch (e) {
    console.warn('Einstellungen konnten nicht geladen werden:', e)
    return defaults()
  }
}

export const settings = reactive(load())

watch(
  settings,
  (value) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(value))
    } catch (e) {
      console.warn('Einstellungen konnten nicht gespeichert werden:', e)
    }
  },
  { deep: true }
)

export function addSource(partial = {}) {
  const source = normalizeSource({ type: 'rss', ...partial })
  settings.sources.push(source)
  return source
}

export function removeSource(id) {
  const index = settings.sources.findIndex((s) => s.id === id)
  if (index !== -1) settings.sources.splice(index, 1)
}

export function activeSources() {
  return settings.sources.filter((s) => s.enabled && s.url)
}

// Der Sync-Schluessel liegt bewusst neben den Einstellungen (er wird nicht
// mitsynchronisiert), gehoert aber ins Backup - sonst waere er nach einem
// Geraeteverlust weg. Direkt aus dem Speicher gelesen, damit store.js nicht
// von sync.js abhaengt.
function syncSchluessel() {
  try {
    return localStorage.getItem('nachrichten-app.synckey') || ''
  } catch (e) {
    return ''
  }
}

export function exportJson() {
  const daten = { ...settings, version: SCHEMA_VERSION }
  const key = syncSchluessel()
  if (key) daten.syncKey = key
  return JSON.stringify(daten, null, 2)
}

export function importJson(text) {
  const parsed = JSON.parse(text)
  // Schluessel aus dem Backup uebernehmen, falls einer drinsteht.
  if (parsed && typeof parsed.syncKey === 'string' && parsed.syncKey.trim()) {
    try {
      localStorage.setItem('nachrichten-app.synckey', parsed.syncKey.trim())
    } catch (e) {
      // Ohne Speicher bleibt der Schluessel eben nur fuer diese Sitzung.
    }
  }
  const next = normalizeSettings(parsed)
  settings.corsProxy = next.corsProxy
  settings.audioProxy = next.audioProxy
  settings.preloadEpisodes = next.preloadEpisodes
  settings.announceEpisodes = next.announceEpisodes
  settings.announceRate = next.announceRate
  settings.sources.splice(0, settings.sources.length, ...next.sources)
  return next.sources.length
}

function applyTemplate(template, url) {
  if (!template) return url
  if (template.includes('{url}')) return template.replace('{url}', encodeURIComponent(url))
  return template + encodeURIComponent(url)
}

export function proxied(url) {
  return applyTemplate(settings.corsProxy, url)
}

export function proxiedAudio(url) {
  return applyTemplate(settings.audioProxy, url)
}

/**
 * Mixed Content: eine ueber https ausgelieferte Seite darf keine http-Audiodatei
 * laden. Nur dann lohnt der Umweg ueber den eigenen Server.
 */
export function needsAudioProxy(url) {
  if (!settings.audioProxy || !url) return false
  if (typeof location === 'undefined') return false
  return location.protocol === 'https:' && url.startsWith('http://')
}
