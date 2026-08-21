import { reactive, computed, watch } from 'vue'
import { activeSources, settings, proxiedAudio, needsAudioProxy } from './store.js'
import { resolveSource } from './feed.js'
import {
  castState,
  castLoad,
  castLoadQueue,
  queueSupported,
  castPlayPause,
  castPause,
  castSeek,
  onCast
} from './cast.js'
import { setupRemotePlayback } from './remote.js'
import { log } from './log.js'
import { ansageText, sprich, sprachausgabeVerfuegbar } from './announce.js'

export const player = reactive({
  items: [],
  index: -1,
  playing: false,
  loading: false,
  announcing: false,
  error: '',
  position: 0,
  duration: 0,
  ended: false
})

const audio = new Audio()
audio.preload = 'auto'
// Fallback fuer Geraete ohne Cast-SDK - steuert dasselbe Element.
setupRemotePlayback(audio)

let resolvers = []
let token = 0

export const current = computed(() => (player.index >= 0 ? player.items[player.index] : null))

/** Lokale Wiedergabe: nur bei drohendem Mixed Content ueber den eigenen Server. */
function localAudioUrl(item) {
  // Ein fertig geladener Blob braucht kein Netz - entscheidend im Hintergrund.
  if (item.blobUrl) return item.blobUrl
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
  player.announcing = false
  audio.muted = false
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
  // Alte Blobs freigeben, bevor die Liste ersetzt wird - sonst bleiben sie als
  // verwaiste Object-URLs im Speicher haengen.
  for (const item of player.items) releaseBlob(item)
  const sources = activeSources()
  player.items = sources.map((source) => ({
    id: source.id,
    title: source.title,
    subtitle: '',
    url: '',
    mimeType: '',
    status: 'pending',
    error: '',
    viaProxy: false,
    publishedAt: 0,
    resolvedAt: 0,
    retried: false,
    locked: false,
    blobUrl: '',
    blobBytes: 0,
    downloading: false,
    preloadFailed: false
  }))
  prefetchBytes = 0
  resolvers = sources.map((source, i) =>
    resolveSource(source)
      .then((track) => {
        const item = player.items[i]
        if (!item) return
        // Laeuft diese Folge gerade, bleibt sie unangetastet - sonst wechselte
        // mitten in der Wiedergabe der Titel unter dem laufenden Ton.
        if (item.locked) return
        item.url = track.url
        item.mimeType = track.mimeType
        item.subtitle = track.subtitle
        item.publishedAt = track.publishedAt || 0
        item.status = 'ready'
        item.resolvedAt = Date.now()
      })
      .catch((e) => {
        const item = player.items[i]
        if (!item || item.locked) return
        item.status = 'error'
        item.error = e.message || String(e)
      })
  )
  // Sobald die Feeds aufgeloest sind, im Hintergrund die Dateien holen -
  // solange die App noch im Vordergrund ist und das Netz erlaubt ist.
  Promise.all(resolvers).then(() => prefetchAhead())

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
      await castStart(item)
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
    ansagen(item)
  } catch (e) {
    player.playing = false
    player.error = `Wiedergabe fehlgeschlagen: ${e.message || e}`
    log('player', 'Start abgelehnt', e && e.message ? e.message : e)
  }
  updateMediaSession(item)
  prefetchAhead()
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

// Folgen im Voraus KOMPLETT herunterladen und als Blob vorhalten.
//
// Warum nicht einfach ein paar Bytes vorwaermen: ein Range-Request legt eine
// "206 Partial Content"-Antwort in den HTTP-Cache. Das Audio-Element greift
// spaeter darauf zu und scheitert an der abgeschnittenen Datei (Fehler 4).
//
// Warum ueberhaupt vorab laden: sobald Android das Geraet schlafen legt, sind
// neue Netzverbindungen aus dem Hintergrund heraus blockiert. Eine bereits
// laufende Wiedergabe streamt weiter, aber die naechste Folge laesst sich nicht
// mehr holen - genau dort blieb die App stehen. Ein Blob im Speicher braucht
// kein Netz mehr.
const PREFETCH_AHEAD = 3
const PREFETCH_MAX_BYTES = 90 * 1024 * 1024

let prefetchBytes = 0

function releaseBlob(item) {
  if (!item || !item.blobUrl) return
  URL.revokeObjectURL(item.blobUrl)
  prefetchBytes = Math.max(0, prefetchBytes - (item.blobBytes || 0))
  item.blobUrl = ''
  item.blobBytes = 0
}

/** Bereits abgespielte Folgen freigeben, damit der Speicher nicht volllaeuft. */
function releasePlayed() {
  for (let i = 0; i < player.index; i++) releaseBlob(player.items[i])
}

async function downloadItem(item) {
  if (!item || item.blobUrl || item.downloading || item.status !== 'ready' || !item.url) return
  // Nicht endlos wiederholen: ohne Netz schlaegt es bei jedem Folgenwechsel
  // erneut fehl und flutet nur das Protokoll.
  if (item.preloadFailed) return
  if (prefetchBytes >= PREFETCH_MAX_BYTES) return

  // Immer ueber den eigenen Proxy: fetch() unterliegt CORS, und die meisten
  // Podcast-Hoster senden dafuer keine Header - anders als beim <audio>-Element.
  const source = settings.audioProxy ? proxiedAudio(item.url) : item.url
  item.downloading = true
  try {
    const response = await fetch(source, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    if (!blob.size) throw new Error('leere Antwort')
    item.blobUrl = URL.createObjectURL(blob)
    item.blobBytes = blob.size
    prefetchBytes += blob.size
    log('player', 'Folge vorgeladen', { titel: item.title, mb: (blob.size / 1048576).toFixed(1) })
  } catch (e) {
    item.preloadFailed = true
    log('player', 'Vorladen fehlgeschlagen', { titel: item.title, grund: e && e.message ? e.message : e })
  } finally {
    item.downloading = false
  }
}

/** Die naechsten Folgen im Voraus holen - nacheinander, um das Netz nicht zu fluten. */
async function prefetchAhead() {
  if (!settings.preloadEpisodes) return
  releasePlayed()
  for (let i = player.index + 1; i <= player.index + PREFETCH_AHEAD && i < player.items.length; i++) {
    await downloadItem(player.items[i])
  }
}

/** Alle abspielbaren Folgen als Cast-Tracks - mit absoluten URLs. */
function castTracks() {
  return player.items
    .filter((i) => i.status === 'ready' && i.url)
    .map((i) => ({ ...i, url: castAudioUrl(i) }))
}

/**
 * Wiedergabe an den Chromecast uebergeben.
 *
 * Bevorzugt als Warteschlange: dann schaltet der Empfaenger selbst weiter und
 * die Wiedergabe laeuft auch dann durch, wenn die Senderseite im Hintergrund
 * gedrosselt wird. Kann der Empfaenger das nicht, bleibt es beim Einzelladen.
 */
async function castStart(startItem, position = 0) {
  const tracks = castTracks()
  const startIndex = Math.max(0, tracks.findIndex((t) => t.id === startItem.id))

  if (queueSupported() && tracks.length > 1) {
    try {
      await castLoadQueue(tracks, startIndex)
      if (position > 1) castSeek(position)
      player.playing = true
      return
    } catch (e) {
      log('player', 'Warteschlange nicht moeglich - einzeln laden', e && e.message ? e.message : e)
    }
  }

  await castLoad({ ...startItem, url: castAudioUrl(startItem) }, true)
  if (position > 1) castSeek(position)
  player.playing = true
}

/**
 * Ansage vor der Folge.
 *
 * Der Ton laeuft dabei bereits - nur stummgeschaltet. Das ist Absicht: ein
 * zweites play() nach der Ansage waere im Hintergrund ein neuer Startversuch
 * und wuerde von Android abgelehnt. So bleibt das Element durchgehend aktiv,
 * und nach der Ansage wird nur an den Anfang zurueckgesprungen.
 */
function ansagen(item) {
  if (!settings.announceEpisodes) return
  // Erst pruefen, dann stummschalten - sonst gibt es ohne Sprachausgabe einen
  // unnoetigen Aussetzer samt Ruecksprung an den Anfang.
  if (!sprachausgabeVerfuegbar()) return
  const text = ansageText(item.title, item.publishedAt)
  if (!text) return

  audio.muted = true
  player.announcing = true

  sprich(text).then(() => {
    player.announcing = false
    try {
      // Zurueck an den Anfang - waehrend der Ansage lief die Folge stumm weiter.
      audio.currentTime = 0
    } catch (e) {
      log('ansage', 'Zuruecksetzen nicht moeglich', e && e.message ? e.message : e)
    }
    audio.muted = false
  })
}

/**
 * Schaltet ohne jeden await weiter. Klappt nur, wenn die naechste Folge schon
 * aufgeloest ist - genau dafuer wird die Playlist beim Start komplett geholt.
 * Gibt false zurueck, wenn der asynchrone Weg noetig ist.
 */
function advanceSync() {
  for (let i = player.index + 1; i < player.items.length; i++) {
    const item = player.items[i]
    if (item.status === 'error') continue
    if (item.status !== 'ready' || !item.url) return false

    token += 1
    player.index = i
    player.position = 0
    player.duration = 0
    player.ended = false
    player.error = ''

    const src = localAudioUrl(item)
    item.viaProxy = src !== item.url
    audio.src = src
    const started = audio.play()
    if (started && started.catch) {
      started.catch((e) => {
        // Erst hier darf ein Promise ins Spiel kommen - play() selbst lief
        // bereits synchron los.
        log('player', 'Hintergrund-Start abgelehnt', e && e.message ? e.message : e)
        player.playing = false
        player.error = `Wiedergabe fehlgeschlagen: ${e && e.message ? e.message : e}`
      })
    }
    player.playing = true
    updateMediaSession(item)
    log('player', 'Naechste Folge gestartet', { index: i, titel: item.title })
    ansagen(item)
    prefetchAhead()
    return true
  }

  // Nichts Abspielbares mehr - sauber beenden.
  if (player.index + 1 >= player.items.length) {
    log('player', 'Playlist zu Ende')
    stop()
    player.ended = true
    return true
  }
  return false
}

/** Eine einzelne Quelle neu aufloesen und sofort weiterspielen. */
async function reresolve(index) {
  const sources = activeSources()
  const item = player.items[index]
  const source = sources.find((s) => s.id === (item && item.id))
  if (!item || !source) return next()

  try {
    const track = await resolveSource(source)
    item.url = track.url
    item.mimeType = track.mimeType
    item.subtitle = track.subtitle
    item.publishedAt = track.publishedAt || 0
    item.status = 'ready'
    item.resolvedAt = Date.now()
    item.viaProxy = false
    const src = localAudioUrl(item)
    item.viaProxy = src !== item.url
    audio.src = src
    await audio.play()
    player.playing = true
    log('player', 'Nach Neuaufloesung gestartet', item.title)
  } catch (e) {
    log('player', 'Neuaufloesung fehlgeschlagen', e && e.message ? e.message : e)
    item.status = 'error'
    item.error = e && e.message ? e.message : String(e)
    next()
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

// Sprungweite fuer vor/zurueck. 30 s ist bei Nachrichten die uebliche Groesse:
// gross genug, um einen Beitrag zu ueberspringen, klein genug zum Nachhoeren.
export const SKIP_SECONDS = 30

/** Relativ springen, sauber begrenzt auf die Folgenlaenge. */
export function skip(offset) {
  if (player.index === -1) return
  const target = Math.max(0, player.position + offset)
  // Kurz vor Schluss stehen bleiben, statt die Folge vorzeitig zu beenden.
  const limited = player.duration > 0 ? Math.min(target, Math.max(0, player.duration - 1)) : target
  log('player', offset > 0 ? 'Vorspulen' : 'Zurueckspulen', {
    von: Math.round(player.position),
    nach: Math.round(limited)
  })
  seek(limited)
  // Beim Casten kommt der neue Stand erst verzoegert zurueck - Anzeige sofort
  // mitziehen, damit der Knopf sich nicht tot anfuehlt.
  player.position = limited
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
  for (const item of player.items) releaseBlob(item)
  prefetchBytes = 0
}

/** Playlist verwerfen, damit der naechste Play-Druck neu aufbaut (nur im Ruhezustand). */
export function invalidate() {
  if (player.index !== -1) return
  player.items = []
  player.error = ''
}

/** Playlist neu aufloesen (neue Folgen abholen). */
/**
 * Neueste Folgen holen.
 *
 * Laeuft gerade etwas, wird die Wiedergabe NICHT unterbrochen: die laufende
 * Folge bleibt stehen, drumherum wird die Liste erneuert. Nur im Ruhezustand
 * wird komplett neu aufgebaut.
 */
export function refresh() {
  const playing = player.playing && current.value ? { ...current.value } : null

  if (!playing) {
    reset()
    player.index = -1
    player.error = ''
    buildPlaylist()
    log('player', 'Playlist neu geholt', { folgen: player.items.length })
    return
  }

  player.error = ''
  buildPlaylist()

  // Die laufende Folge in der neuen Liste wiederfinden und festhalten.
  const index = player.items.findIndex((i) => i.id === playing.id)
  if (index === -1) {
    // Quelle wurde inzwischen entfernt - dann laeuft sie zu Ende und gut.
    log('player', 'Laufende Quelle nicht mehr in der Liste')
    player.index = -1
    return
  }

  const item = player.items[index]
  Object.assign(item, {
    url: playing.url,
    mimeType: playing.mimeType,
    subtitle: playing.subtitle,
    status: 'ready',
    resolvedAt: playing.resolvedAt,
    viaProxy: playing.viaProxy,
    locked: true
  })
  player.index = index
  log('player', 'Playlist erneuert, laufende Folge behalten', { titel: item.title })
}

let lastPositionSync = 0
audio.addEventListener('timeupdate', () => {
  if (!castState.connected) player.position = audio.currentTime || 0
  const now = Date.now()
  if (now - lastPositionSync > 5000) {
    lastPositionSync = now
    updatePositionState()
  }
})
audio.addEventListener('durationchange', () => {
  if (!castState.connected) player.duration = Number.isFinite(audio.duration) ? audio.duration : 0
  updatePositionState()
})
audio.addEventListener('play', () => {
  if (!castState.connected) player.playing = true
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'
})
audio.addEventListener('pause', () => {
  if (!castState.connected) player.playing = false
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'
})
audio.addEventListener('stalled', () => log('player', 'Wiedergabe haengt (stalled)'))
audio.addEventListener('waiting', () => log('player', 'Puffert ...'))
audio.addEventListener('ended', () => {
  if (player.index === -1) return
  log('player', 'Folge zu Ende', { index: player.index })
  // WICHTIG: ohne await weiterschalten. Im Hintergrund verliert Android die
  // Wiedergabe-Erlaubnis, sobald zwischen 'ended' und play() ein Promise
  // liegt - dann bleibt die App einfach stehen.
  if (advanceSync()) return
  log('player', 'Naechste Folge noch nicht aufgeloest - asynchroner Weg')
  next()
})
audio.addEventListener('error', () => {
  // Beim Zuruecksetzen der Quelle feuert der Browser ebenfalls 'error' - dann nichts tun.
  if (player.index === -1 || !audio.getAttribute('src')) return
  const item = current.value
  log('player', 'Audio-Fehler', {
    titel: item ? item.title : '?',
    code: audio.error ? audio.error.code : 0,
    viaProxy: item ? item.viaProxy : false
  })

  // Manche Feeds nennen eine https-URL, die auf http weiterleitet. Das faellt
  // erst beim Laden auf - dann einmal ueber den Audio-Proxy nachfassen.
  if (item && !item.viaProxy && settings.audioProxy) {
    item.viaProxy = true
    audio.src = proxiedAudio(item.url)
    audio.play().catch(() => {})
    return
  }

  // Viele CDN-Links sind signiert und laufen ab (BBC & Co. tragen "Expires").
  // Bei einer langen Playlist kann die letzte Folge deshalb tot sein - dann
  // den Feed einmal neu aufloesen statt die Quelle zu verwerfen.
  if (item && !item.retried && item.resolvedAt && Date.now() - item.resolvedAt > 60000) {
    item.retried = true
    log('player', 'Link vermutlich abgelaufen - Feed wird neu geholt', item.title)
    reresolve(player.index)
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

// Bei aktiver Warteschlange bestimmt der Empfaenger, was laeuft - die Anzeige
// folgt ihm, statt selbst zu schalten.
onCast('trackchange', () => {
  const id = castState.currentContentId
  if (!id) return
  const index = player.items.findIndex((i) => i.url && castAudioUrl(i) === id)
  if (index === -1 || index === player.index) return
  player.index = index
  player.position = 0
  player.ended = false
  log('player', 'Anzeige folgt dem Empfaenger', { index, titel: player.items[index].title })
  updateMediaSession(player.items[index])
})

onCast('connected', () => {
  const item = current.value

  // Nichts am Laufen? Dann jetzt starten. Der Standard-Empfaenger beendet die
  // Sitzung nach wenigen Sekunden wieder, wenn er kein Medium bekommt - genau
  // das sah frueher wie "Verbindung fehlgeschlagen" aus.
  if (!item) {
    log('player', 'Cast verbunden ohne laufende Folge - Playlist wird gestartet')
    toggle()
    return
  }

  const at = player.position
  audio.pause()
  castStart(item, at)
    .catch((e) => {
      const text = e && e.message ? e.message : String(e)
      log('player', 'Uebergabe an Cast fehlgeschlagen', text)
      player.error = `Chromecast: ${text}`
      // Zurueck auf lokale Wiedergabe, statt stumm dazustehen.
      audio.play().catch(() => {})
    })
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
  // Truthiness pruefen, nicht nur die Existenz des Schluessels.
  if (!navigator.mediaSession || typeof window.MediaMetadata !== 'function') return
  navigator.mediaSession.playbackState = 'playing'
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
  // Auch auf dem Sperrbildschirm springen koennen.
  try {
    navigator.mediaSession.setActionHandler('seekbackward', (details) =>
      skip(-((details && details.seekOffset) || SKIP_SECONDS))
    )
    navigator.mediaSession.setActionHandler('seekforward', (details) =>
      skip((details && details.seekOffset) || SKIP_SECONDS)
    )
  } catch (e) {
    // Aeltere Browser kennen diese Aktionen nicht.
  }
  // Android blendet sonst irgendwann die Benachrichtigung aus, weil es die
  // Sitzung fuer verwaist haelt.
  try {
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details && typeof details.seekTime === 'number') seek(details.seekTime)
    })
  } catch (e) {
    // Aeltere Browser kennen 'seekto' nicht.
  }
}

/** Fortschritt an das System melden, damit die Benachrichtigung mitlaeuft. */
function updatePositionState() {
  if (!navigator.mediaSession || !navigator.mediaSession.setPositionState) return
  if (!Number.isFinite(player.duration) || player.duration <= 0) return
  try {
    navigator.mediaSession.setPositionState({
      duration: player.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(player.position, player.duration)
    })
  } catch (e) {
    // Ungueltige Werte waehrend des Ladens - beim naechsten Mal wieder.
  }
}
