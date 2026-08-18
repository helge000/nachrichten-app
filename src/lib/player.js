import { reactive, computed, watch } from 'vue'
import { activeSources, settings, proxiedAudio, needsAudioProxy } from './store.js'
import { resolveSource } from './feed.js'
import { castState, castLoad, castPlayPause, castPause, castSeek, onCast } from './cast.js'

export const player = reactive({
  items: [],
  index: -1,
  playing: false,
  loading: false,
  error: '',
  position: 0,
  duration: 0,
  ended: false
})

const audio = new Audio()
audio.preload = 'auto'

let resolvers = []
let token = 0

export const current = computed(() => (player.index >= 0 ? player.items[player.index] : null))

/** Lokale Wiedergabe: nur bei drohendem Mixed Content ueber den eigenen Server. */
function localAudioUrl(item) {
  return needsAudioProxy(item.url) ? proxiedAudio(item.url) : item.url
}

/**
 * Der Cast-Empfaenger ist selbst eine https-Seite und blockiert http-Medien
 * genauso - dort wird jede http-Datei geproxt. Die URL muss absolut sein,
 * weil sie vom Chromecast-Geraet abgerufen wird, nicht vom Browser.
 */
function castAudioUrl(item) {
  const url = settings.audioProxy && item.url.startsWith('http://') ? proxiedAudio(item.url) : item.url
  return new URL(url, location.href).toString()
}
export const hasSources = computed(() => player.items.length > 0)

function reset() {
  token += 1
  audio.pause()
  audio.removeAttribute('src')
  audio.load()
  player.playing = false
  player.position = 0
  player.duration = 0
  player.ended = false
}

/** Playlist aus den aktiven Quellen aufbauen und alle Folgen parallel aufloesen. */
export function buildPlaylist() {
  const sources = activeSources()
  player.items = sources.map((source) => ({
    id: source.id,
    title: source.title,
    subtitle: '',
    url: '',
    mimeType: '',
    status: 'pending',
    error: '',
    viaProxy: false
  }))
  resolvers = sources.map((source, i) =>
    resolveSource(source)
      .then((track) => {
        const item = player.items[i]
        if (!item) return
        item.url = track.url
        item.mimeType = track.mimeType
        item.subtitle = track.subtitle
        item.status = 'ready'
      })
      .catch((e) => {
        const item = player.items[i]
        if (!item) return
        item.status = 'error'
        item.error = e.message || String(e)
      })
  )
  return player.items.length
}

async function ensureResolved(i) {
  if (resolvers[i]) await resolvers[i]
  return player.items[i]
}

function nextPlayableIndex(from) {
  for (let i = from; i < player.items.length; i++) {
    if (player.items[i].status !== 'error') return i
  }
  return -1
}

async function startAt(i) {
  const myToken = ++token
  if (i < 0 || i >= player.items.length) {
    player.playing = false
    player.ended = true
    return
  }

  player.index = i
  player.loading = true
  player.error = ''
  const item = await ensureResolved(i)
  if (myToken !== token) return
  player.loading = false

  if (!item || item.status !== 'ready') {
    const next = nextPlayableIndex(i + 1)
    if (next === -1) {
      player.playing = false
      player.ended = true
      player.error = item && item.error ? `${item.title}: ${item.error}` : 'Keine abspielbare Folge gefunden.'
      return
    }
    return startAt(next)
  }

  player.position = 0
  player.duration = 0
  player.ended = false

  if (castState.connected) {
    try {
      await castLoad({ ...item, url: castAudioUrl(item) }, true)
      player.playing = true
    } catch (e) {
      player.error = `Cast fehlgeschlagen: ${e.message || e}`
      player.playing = false
    }
    updateMediaSession(item)
    return
  }

  const src = localAudioUrl(item)
  item.viaProxy = src !== item.url
  audio.src = src
  try {
    await audio.play()
    player.playing = true
  } catch (e) {
    player.playing = false
    player.error = `Wiedergabe fehlgeschlagen: ${e.message || e}`
  }
  updateMediaSession(item)
}

/** Haupt-Button: startet die Playlist bzw. schaltet Pause um. */
export async function toggle() {
  if (player.index === -1 || player.ended) {
    // Immer frisch aufbauen: Reihenfolge kann sich geaendert haben und
    // Nachrichten sollen aktuell sein.
    buildPlaylist()
    if (!player.items.length) {
      player.error = 'Keine Quellen aktiviert - bitte in den Einstellungen anlegen.'
      return
    }
    await startAt(0)
    return
  }

  if (castState.connected) {
    castPlayPause()
    return
  }

  if (audio.paused) {
    try {
      await audio.play()
      player.playing = true
    } catch (e) {
      player.error = `Wiedergabe fehlgeschlagen: ${e.message || e}`
    }
  } else {
    audio.pause()
    player.playing = false
  }
}

export function next() {
  const target = nextPlayableIndex(player.index + 1)
  if (target === -1) {
    stop()
    player.ended = true
    return
  }
  startAt(target)
}

export function previous() {
  if (player.position > 3) {
    seek(0)
    return
  }
  for (let i = player.index - 1; i >= 0; i--) {
    if (player.items[i].status !== 'error') return startAt(i)
  }
  seek(0)
}

export function playIndex(i) {
  startAt(i)
}

export function seek(seconds) {
  if (castState.connected) {
    castSeek(seconds)
    return
  }
  if (Number.isFinite(audio.duration)) audio.currentTime = seconds
}

export function stop() {
  reset()
  player.index = -1
}

/** Playlist verwerfen, damit der naechste Play-Druck neu aufbaut (nur im Ruhezustand). */
export function invalidate() {
  if (player.index !== -1) return
  player.items = []
  player.error = ''
}

/** Playlist neu aufloesen (neue Folgen abholen). */
export function refresh() {
  reset()
  player.index = -1
  player.error = ''
  buildPlaylist()
}

audio.addEventListener('timeupdate', () => {
  if (!castState.connected) player.position = audio.currentTime || 0
})
audio.addEventListener('durationchange', () => {
  if (!castState.connected) player.duration = Number.isFinite(audio.duration) ? audio.duration : 0
})
audio.addEventListener('play', () => {
  if (!castState.connected) player.playing = true
})
audio.addEventListener('pause', () => {
  if (!castState.connected) player.playing = false
})
audio.addEventListener('ended', () => {
  if (player.index !== -1) next()
})
audio.addEventListener('error', () => {
  // Beim Zuruecksetzen der Quelle feuert der Browser ebenfalls 'error' - dann nichts tun.
  if (player.index === -1 || !audio.getAttribute('src')) return
  const item = current.value
  // Manche Feeds nennen eine https-URL, die auf http weiterleitet. Das faellt
  // erst beim Laden auf - dann einmal ueber den Audio-Proxy nachfassen.
  if (item && !item.viaProxy && settings.audioProxy) {
    item.viaProxy = true
    audio.src = proxiedAudio(item.url)
    audio.play().catch(() => {})
    return
  }
  if (item) {
    item.status = 'error'
    item.error = 'Audio konnte nicht geladen werden'
  }
  next()
})

// Cast-Statuswerte in den Player spiegeln.
watch(
  () => [castState.currentTime, castState.duration, castState.playing],
  ([time, duration, playing]) => {
    if (!castState.connected) return
    player.position = time
    player.duration = duration
    player.playing = playing
  }
)

onCast('ended', () => {
  if (player.index !== -1) next()
})

onCast('connected', () => {
  const item = current.value
  if (!item) return
  const at = player.position
  audio.pause()
  castLoad({ ...item, url: castAudioUrl(item) }, true)
    .then(() => castSeek(at))
    .catch(() => {})
})

onCast('disconnected', () => {
  const item = current.value
  if (!item) return
  castPause()
  const at = player.position || 0
  audio.src = localAudioUrl(item)
  // Position erst setzen, wenn der Browser die Datei kennt.
  audio.addEventListener('loadedmetadata', () => { audio.currentTime = at }, { once: true })
  player.playing = false
})

function updateMediaSession(item) {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = new window.MediaMetadata({
    title: item.subtitle || item.title,
    artist: item.title,
    album: 'Nachrichten',
    artwork: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  })
  navigator.mediaSession.setActionHandler('play', () => toggle())
  navigator.mediaSession.setActionHandler('pause', () => toggle())
  navigator.mediaSession.setActionHandler('nexttrack', () => next())
  navigator.mediaSession.setActionHandler('previoustrack', () => previous())
}
