import { reactive } from 'vue'

// Google Cast ist optional: ohne SDK (kein Chrome, kein HTTPS) laeuft alles lokal weiter.
const SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'

export const castState = reactive({
  available: false,
  connected: false,
  deviceName: '',
  playing: false,
  currentTime: 0,
  duration: 0
})

let remotePlayer = null
let controller = null
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

  controller.addEventListener(framework.RemotePlayerEventType.IS_PAUSED_CHANGED, () => {
    castState.playing = !remotePlayer.isPaused && remotePlayer.isMediaLoaded
  })
  controller.addEventListener(framework.RemotePlayerEventType.CURRENT_TIME_CHANGED, () => {
    castState.currentTime = remotePlayer.currentTime || 0
  })
  controller.addEventListener(framework.RemotePlayerEventType.DURATION_CHANGED, () => {
    castState.duration = remotePlayer.duration || 0
  })
  controller.addEventListener(framework.RemotePlayerEventType.PLAYER_STATE_CHANGED, () => {
    castState.playing = remotePlayer.playerState === 'PLAYING'
  })
  controller.addEventListener(framework.RemotePlayerEventType.MEDIA_INFO_CHANGED, () => {
    // Ende einer Folge: der Receiver meldet IDLE, sobald nichts mehr laeuft.
    if (!remotePlayer.isMediaLoaded && castState.connected) emit('ended')
  })
}

function initialize() {
  const framework = window.cast.framework
  const context = framework.CastContext.getInstance()
  context.setOptions({
    receiverApplicationId: window.chrome.cast.media.DefaultMediaReceiverAppId,
    autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
  })

  context.addEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
    const state = event.sessionState
    const session = context.getCurrentSession()
    const wasConnected = castState.connected
    castState.connected = state === 'SESSION_STARTED' || state === 'SESSION_RESUMED'
    castState.deviceName = session ? session.getCastDevice().friendlyName : ''
    if (castState.connected && !wasConnected) emit('connected')
    if (!castState.connected && wasConnected) {
      castState.playing = false
      castState.currentTime = 0
      castState.duration = 0
      emit('disconnected')
    }
  })

  attachRemotePlayer()
  castState.available = true
}

export function setupCast() {
  if (window.cast && window.cast.framework) {
    initialize()
    return
  }
  window.__onGCastApiAvailable = (isAvailable) => {
    if (isAvailable) initialize()
  }
  const script = document.createElement('script')
  script.src = SDK_URL
  script.async = true
  script.onerror = () => console.info('Cast-SDK nicht verfuegbar - lokale Wiedergabe.')
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

  const mediaInfo = new window.chrome.cast.media.MediaInfo(track.url, track.mimeType || 'audio/mpeg')
  const metadata = new window.chrome.cast.media.MusicTrackMediaMetadata()
  metadata.title = track.subtitle || track.title
  metadata.artist = track.title
  mediaInfo.metadata = metadata

  const request = new window.chrome.cast.media.LoadRequest(mediaInfo)
  request.autoplay = autoplay
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
