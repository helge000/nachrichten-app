import { reactive } from 'vue'
import { log } from './log.js'

// Google Cast ist optional: ohne SDK (kein Chrome, kein HTTPS) laeuft alles lokal weiter.
const SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'

// Offizielle Konstanten des Cast-SDK. Sie dienen als Rueckfall, weil der Loader
// zwei Skripte zieht: cast.framework kann bereit sein, waehrend der Namensraum
// chrome.cast noch nicht vollstaendig ist. Ohne Rueckfall wandert dann
// "undefined" als App-ID in setOptions und das SDK wirft.
// Eigener Empfaenger (public/receiver.html), registriert in der Google Cast
// Developer Console. Nur damit steht auf dem Fernseher "Nachrichten" statt
// "unbekannte App", und nur damit greifen Hintergrundbild und eigene Anzeige.
const RECEIVER_APP_ID = 'BF0E7317'
const AUTO_JOIN_ORIGIN_SCOPED = 'origin_scoped'
const MAX_INIT_ATTEMPTS = 50

// Die Fehlercodes des Cast-SDK. Chrome zeigt im Dialog nur "error connecting
// device" - der Code darunter sagt, was wirklich los ist.
const ERROR_TEXT = {
  cancel: 'Auswahl abgebrochen',
  timeout: 'Zeitueberschreitung - Geraet antwortet nicht',
  api_not_initialized: 'Cast-SDK war noch nicht bereit',
  invalid_parameter: 'Ungueltiger Parameter an das SDK',
  extension_missing: 'Cast-Erweiterung fehlt',
  extension_not_compatible: 'Cast-Erweiterung ist zu alt',
  receiver_unavailable: 'Kein passender Empfaenger gefunden',
  session_error: 'Sitzung konnte nicht aufgebaut werden',
  channel_error: 'Verbindung zum Geraet abgebrochen - meist Netzwerk/WLAN',
  load_media_failed: 'Medium konnte nicht geladen werden'
}

export function describeCastError(error) {
  if (!error) return 'Unbekannter Fehler'
  const code = error.code || error.errorCode || ''
  const text = ERROR_TEXT[code]
  const detail = error.description || error.message || ''
  if (text) return detail ? `${text} (${code}: ${detail})` : `${text} (${code})`
  return detail || code || String(error)
}

// Die Bedingungen, die der Cast-Loader auf Android prueft. Ohne sie laedt das
// SDK stillschweigend nicht - deshalb hier sichtbar gemacht.
export const castDiagnostics = reactive({
  isAndroid: false,
  chromeVersion: 0,
  hasPresentationApi: false,
  scriptLoaded: false,
  frameworkLoaded: false,
  chromeCastReady: false,
  appId: ''
})

export const castState = reactive({
  // SDK geladen und einsatzbereit - erst dann erscheint der Cast-Knopf.
  available: false,
  // Warum nicht, falls nicht verfuegbar (fuer die Diagnose in den Einstellungen).
  reason: '',
  // 'NO_DEVICES_AVAILABLE' | 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED'
  deviceState: '',
  connected: false,
  // Letzter Verbindungsfehler im Klartext - fuer die Diagnose.
  lastError: '',
  // Laeuft eine Warteschlange auf dem Empfaenger? Dann schaltet er selbst
  // weiter und die Senderseite haelt sich raus.
  queueActive: false,
  // Welche Datei laeuft dort gerade - damit die Anzeige folgen kann.
  currentContentId: '',
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
const listeners = { ended: [], connected: [], disconnected: [], trackchange: [] }

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
  // Der Empfaenger wechselt die Folge selbst - hier erfahren wir davon.
  controller.addEventListener(framework.RemotePlayerEventType.MEDIA_INFO_CHANGED, () => {
    const info = remotePlayer.mediaInfo
    const id = info && info.contentId ? info.contentId : ''
    if (id && id !== castState.currentContentId) {
      castState.currentContentId = id
      log('cast', 'Empfaenger spielt neue Folge', id.slice(0, 70))
      emit('trackchange')
    }
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
      // Bei aktiver Warteschlange schaltet der Empfaenger selbst weiter -
      // dann darf die Senderseite nicht dazwischenfunken.
      if (castState.queueActive) {
        log('cast', 'IDLE bei aktiver Warteschlange - Empfaenger macht selbst weiter')
        return
      }
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

/**
 * Prueft genau das, was castLoad() wirklich braucht: die Konstruktoren.
 *
 * Frueher wurde hier auf die Konstante DefaultMediaReceiverAppId geprueft.
 * Die fehlt in manchen Chrome-Fassungen (z. B. Chrome 151 auf ChromeOS),
 * obwohl das SDK voll funktionsfaehig ist - dadurch lehnte castLoad() immer ab,
 * der Empfaenger bekam nie ein Medium und beendete die Sitzung nach Sekunden.
 */
function chromeCastReady() {
  const media = window.chrome && window.chrome.cast && window.chrome.cast.media
  return !!(media && typeof media.MediaInfo === 'function' && typeof media.LoadRequest === 'function')
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

  castDiagnostics.appId = RECEIVER_APP_ID
  context.setOptions({
    receiverApplicationId: RECEIVER_APP_ID,
    autoJoinPolicy: (ns.AutoJoinPolicy && ns.AutoJoinPolicy.ORIGIN_SCOPED) || AUTO_JOIN_ORIGIN_SCOPED
  })

  // Meldet, ob ueberhaupt ein Empfaenger im Netz gefunden wurde.
  context.addEventListener(framework.CastContextEventType.CAST_STATE_CHANGED, (event) => {
    castState.deviceState = event.castState
    log('cast', 'Geraetezustand', event.castState)
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
    log('cast', 'Sitzungszustand', { zustand: state, geraet: castState.deviceName })
    if (state === 'SESSION_ENDED' && !mediaLoaded) {
      // Der Standard-Empfaenger beendet sich, wenn er nach dem Verbinden kein
      // Medium bekommt. Genau das passiert, wenn beim Verbinden nichts laeuft.
      log('cast', 'Sitzung endete ohne Medium - Empfaenger lief in den Leerlauf')
    }
    if (castState.connected && !wasConnected) emit('connected')
    if (!castState.connected && wasConnected) {
      mediaLoaded = false
      castState.queueActive = false
      castState.currentContentId = ''
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
  log('cast', 'SDK bereit', { appId: castDiagnostics.appId })
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
  if (!castState.available) {
    log('cast', 'requestSession ohne verfuegbares SDK abgelehnt')
    return Promise.reject(new Error('Cast-SDK nicht verfuegbar'))
  }
  log('cast', 'Geraeteauswahl wird geoeffnet', { zustand: castState.deviceState })
  return window.cast.framework.CastContext.getInstance()
    .requestSession()
    .then((result) => {
      // Das SDK liefert bei Misserfolg einen Fehlercode statt einer Ablehnung.
      if (result) {
        const text = describeCastError(result)
        log('cast', 'Verbindung fehlgeschlagen', text)
        castState.lastError = text
        throw Object.assign(new Error(text), { castResult: result })
      }
      log('cast', 'Sitzung aufgebaut')
      castState.lastError = ''
      return result
    })
    .catch((e) => {
      const text = e && e.castResult ? describeCastError(e.castResult) : describeCastError(e)
      castState.lastError = text
      log('cast', 'requestSession abgelehnt', text)
      throw e
    })
}

export function stopCastSession() {
  const current = session()
  if (current) current.endSession(true)
}

// Bild fuer Chromecast-Geraete mit Bildschirm. Ohne ein Bild zeigt der
// Empfaenger bei reinem Ton nur eine leere Flaeche - und blendet nach einer
// Weile den Bildschirmschoner ein.
export const CAST_BILD = '/cast/background.png'
const CAST_BILD_BREITE = 1280
const CAST_BILD_HOEHE = 720

function absolut(pfad) {
  return new URL(pfad, location.href).toString()
}

/** Baut ein MediaInfo-Objekt inklusive Metadaten fuer den Empfaenger. */
function buildMediaInfo(track) {
  const media = window.chrome.cast.media
  const info = new media.MediaInfo(track.url, track.mimeType || 'audio/mpeg')
  if (typeof media.MusicTrackMediaMetadata === 'function') {
    const metadata = new media.MusicTrackMediaMetadata()
    metadata.title = track.subtitle || track.title
    metadata.artist = track.title
    metadata.albumName = 'Nachrichten'
    if (typeof media.Image === 'function') {
      const bild = new media.Image(absolut(CAST_BILD))
      bild.width = CAST_BILD_BREITE
      bild.height = CAST_BILD_HOEHE
      metadata.images = [bild]
    }
    info.metadata = metadata
  }
  return info
}

export function queueSupported() {
  const media = window.chrome && window.chrome.cast && window.chrome.cast.media
  return !!(media && typeof media.QueueLoadRequest === 'function' && typeof media.QueueItem === 'function')
}

/**
 * Die komplette Playlist als Warteschlange an den Empfaenger uebergeben.
 *
 * Entscheidend fuer den Hintergrund: der Chromecast schaltet die Warteschlange
 * selbst weiter. Vorher musste die Senderseite bei jedem Folgenende eingreifen -
 * und genau die wird von Chrome im Hintergrund gedrosselt, weil beim Casten
 * lokal kein Ton laeuft und die Seite damit ihre Ausnahme verliert.
 */
export function castLoadQueue(tracks, startIndex = 0) {
  const current = session()
  if (!current) return Promise.reject(new Error('Keine Cast-Verbindung'))
  if (!chromeCastReady()) return Promise.reject(new Error('Cast-SDK ist noch nicht bereit'))
  if (!queueSupported()) return Promise.reject(new Error('Warteschlange wird nicht unterstuetzt'))
  if (!tracks.length) return Promise.reject(new Error('Leere Warteschlange'))

  const media = window.chrome.cast.media
  const items = tracks.map((track) => {
    const item = new media.QueueItem(buildMediaInfo(track))
    item.autoplay = true
    // Kein Vorlauf durch den Empfaenger - die Dateien liegen beim Sender.
    item.preloadTime = 5
    return item
  })

  const request = new media.QueueLoadRequest(items)
  request.startIndex = Math.max(0, Math.min(startIndex, items.length - 1))
  if (media.RepeatMode) request.repeatMode = media.RepeatMode.OFF

  mediaLoaded = false
  log('cast', 'Warteschlange wird geladen', { folgen: items.length, start: request.startIndex })
  return current.queueLoad(request).then(
    (r) => {
      castState.queueActive = true
      log('cast', 'Warteschlange geladen - Empfaenger schaltet selbst weiter')
      return r
    },
    (e) => {
      log('cast', 'Warteschlange fehlgeschlagen', describeCastError(e))
      throw e
    }
  )
}

export function castLoad(track, autoplay = true) {
  const current = session()
  if (!current) return Promise.reject(new Error('Keine Cast-Verbindung'))
  if (!chromeCastReady()) return Promise.reject(new Error('Cast-SDK ist noch nicht bereit'))

  const media = window.chrome.cast.media
  const request = new media.LoadRequest(buildMediaInfo(track))
  request.autoplay = autoplay
  // Neuer Track: der Merker gilt erst wieder, wenn tatsaechlich etwas laeuft.
  mediaLoaded = false
  castState.queueActive = false
  log('cast', 'Medium wird geladen', { url: String(track.url).slice(0, 80) })
  return current.loadMedia(request).then(
    (r) => {
      log('cast', 'Medium geladen')
      return r
    },
    (e) => {
      log('cast', 'Laden fehlgeschlagen', describeCastError(e))
      throw e
    }
  )
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
