import { reactive } from 'vue'

// Google Cast ist optional: ohne SDK (kein Chrome, kein HTTPS) laeuft alles lokal weiter.
const SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'

// Offizielle Konstanten des Cast-SDK. Sie dienen als Rueckfall, weil der Loader
// zwei Skripte zieht: cast.framework kann bereit sein, waehrend der Namensraum
// chrome.cast noch nicht vollstaendig ist. Ohne Rueckfall wandert dann
// "undefined" als App-ID in setOptions und das SDK wirft.
const DEFAULT_RECEIVER_APP_ID = 'CC1AD845'
const AUTO_JOIN_ORIGIN_SCOPED = 'origin_scoped'
const MAX_INIT_ATTEMPTS = 50

// Die Bedingungen, die der Cast-Loader auf Android prueft. Ohne sie laedt das
// SDK stillschweigend nicht - deshalb hier sichtbar gemacht.
export const castDiagnostics = reactive({
  isAndroid: false,
  chromeVersion: 0,
  hasPresentationApi: false,
  scriptLoaded: false,
  frameworkLoaded: false,
  chromeCastReady: false
})

export const castState = reactive({
  // SDK geladen und einsatzbereit - erst dann erscheint der Cast-Knopf.
  available: false,
  // Warum nicht, falls nicht verfuegbar (fuer die Diagnose in den Einstellungen).
  reason: '',
  // 'NO_DEVICES_AVAILABLE' | 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED'
  deviceState: '',
  connected: false,
  deviceName: '',
  playing: false,
  currentTime: 0,
  duration: 0
})

let remotePlayer = null
let controller = null
// Merker, ob fuer den aktuellen Track ueberhaupt schon etwas lief. Ohne ihn
// laesst sich "noch nicht geladen" nicht von "fertig abgespielt" unterscheiden.
let mediaLoaded = false
const listeners = { ended: [], connected: [], disconnected: [] }

function emit(event) {
  for (const fn of listeners[event]) {
    try {
      fn()
    } catch (e) {
      console.warn('Cast-Listener fehlgeschlagen:', e)
    }
  }
}

export function onCast(event, fn) {
  listeners[event].push(fn)
}

function attachRemotePlayer() {
  const framework = window.cast.framework
  remotePlayer = new framework.RemotePlayer()
  controller = new framework.RemotePlayerController(remotePlayer)

  controller.addEventListener(framework.RemotePlayerEventType.CURRENT_TIME_CHANGED, () => {
    castState.currentTime = remotePlayer.currentTime || 0
  })
  controller.addEventListener(framework.RemotePlayerEventType.DURATION_CHANGED, () => {
    castState.duration = remotePlayer.duration || 0
  })
  controller.addEventListener(framework.RemotePlayerEventType.PLAYER_STATE_CHANGED, () => {
    const state = remotePlayer.playerState
    castState.playing = state === 'PLAYING'

    if (state === 'PLAYING' || state === 'PAUSED' || state === 'BUFFERING') {
      mediaLoaded = true
      return
    }
    // IDLE heisst nur dann "Folge zu Ende", wenn vorher wirklich etwas lief.
    // Sonst wuerde schon der Ladevorgang als Ende durchgehen.
    if (state === 'IDLE' && mediaLoaded) {
      mediaLoaded = false
      emit('ended')
    }
  })
}

function deviceNameOf(session) {
  try {
    const device = session && session.getCastDevice()
    return device ? device.friendlyName : ''
  } catch (e) {
    return ''
  }
}

function chromeCastReady() {
  const ns = window.chrome && window.chrome.cast
  return !!(ns && ns.media && ns.media.DefaultMediaReceiverAppId)
}

let initAttempts = 0

/** Wartet auf einen vollstaendigen chrome.cast-Namensraum und faengt Fehler ab. */
function initialize() {
  if (!window.cast || !window.cast.framework) return

  if (!chromeCastReady() && initAttempts < MAX_INIT_ATTEMPTS) {
    initAttempts += 1
    setTimeout(initialize, 100)
    return
  }
  castDiagnostics.chromeCastReady = chromeCastReady()

  try {
    startCastContext()
  } catch (e) {
    castState.available = false
    castState.reason = `Cast-Initialisierung fehlgeschlagen: ${e.message || e}`
    console.warn(castState.reason, e)
  }
}

function startCastContext() {
  const framework = window.cast.framework
  const ns = (window.chrome && window.chrome.cast) || {}
  const context = framework.CastContext.getInstance()

  context.setOptions({
    receiverApplicationId:
      (ns.media && ns.media.DefaultMediaReceiverAppId) || DEFAULT_RECEIVER_APP_ID,
    autoJoinPolicy: (ns.AutoJoinPolicy && ns.AutoJoinPolicy.ORIGIN_SCOPED) || AUTO_JOIN_ORIGIN_SCOPED
  })

  // Meldet, ob ueberhaupt ein Empfaenger im Netz gefunden wurde.
  context.addEventListener(framework.CastContextEventType.CAST_STATE_CHANGED, (event) => {
    castState.deviceState = event.castState
  })
  try {
    castState.deviceState = context.getCastState()
  } catch (e) {
    castState.deviceState = ''
  }

  context.addEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
    const state = event.sessionState
    const session = context.getCurrentSession()
    const wasConnected = castState.connected
    castState.connected = state === 'SESSION_STARTED' || state === 'SESSION_RESUMED'
    castState.deviceName = deviceNameOf(session)
    if (castState.connected && !wasConnected) emit('connected')
    if (!castState.connected && wasConnected) {
      mediaLoaded = false
      castState.playing = false
      castState.currentTime = 0
      castState.duration = 0
      emit('disconnected')
    }
  })

  attachRemotePlayer()
  castDiagnostics.frameworkLoaded = true
  castState.available = true
  castState.reason = ''
}

export function setupCast() {
  const ua = navigator.userAgent || ''
  const match = ua.match(/Chrome\/(\d+)/)
  castDiagnostics.isAndroid = ua.indexOf('Android') >= 0
  castDiagnostics.chromeVersion = match ? parseInt(match[1], 10) : 0
  castDiagnostics.hasPresentationApi = !!navigator.presentation

  if (castDiagnostics.isAndroid && !castDiagnostics.hasPresentationApi) {
    castState.reason = 'Presentation API fehlt - das Cast-SDK laedt auf Android nur mit ihr'
  }

  if (window.cast && window.cast.framework) {
    initialize()
    return
  }
  window.__onGCastApiAvailable = (isAvailable, reason) => {
    if (isAvailable) {
      initialize()
      return
    }
    castState.reason = reason || 'Chrome meldet keine Cast-Unterstuetzung'
    console.info('Cast nicht verfuegbar:', castState.reason)
  }
  const script = document.createElement('script')
  script.src = SDK_URL
  script.async = true
  script.onload = () => {
    castDiagnostics.scriptLoaded = true
  }
  script.onerror = () => {
    castState.reason = 'Cast-SDK konnte nicht geladen werden (offline oder blockiert)'
    console.info(castState.reason)
  }
  document.head.appendChild(script)
}

function session() {
  if (!castState.available) return null
  return window.cast.framework.CastContext.getInstance().getCurrentSession()
}

export function requestCastSession() {
  if (!castState.available) return Promise.resolve()
  return window.cast.framework.CastContext.getInstance().requestSession()
}

export function stopCastSession() {
  const current = session()
  if (current) current.endSession(true)
}

export function castLoad(track, autoplay = true) {
  const current = session()
  if (!current) return Promise.reject(new Error('Keine Cast-Verbindung'))
  if (!chromeCastReady()) return Promise.reject(new Error('Cast-SDK ist noch nicht bereit'))

  const mediaInfo = new window.chrome.cast.media.MediaInfo(track.url, track.mimeType || 'audio/mpeg')
  const metadata = new window.chrome.cast.media.MusicTrackMediaMetadata()
  metadata.title = track.subtitle || track.title
  metadata.artist = track.title
  mediaInfo.metadata = metadata

  const request = new window.chrome.cast.media.LoadRequest(mediaInfo)
  request.autoplay = autoplay
  // Neuer Track: der Merker gilt erst wieder, wenn tatsaechlich etwas laeuft.
  mediaLoaded = false
  return current.loadMedia(request)
}

export function castPlayPause() {
  if (controller) controller.playOrPause()
}

export function castPause() {
  if (controller && remotePlayer && !remotePlayer.isPaused) controller.playOrPause()
}

export function castSeek(seconds) {
  if (!controller || !remotePlayer) return
  remotePlayer.currentTime = seconds
  controller.seek()
}
