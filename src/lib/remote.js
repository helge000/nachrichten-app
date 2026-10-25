import { reactive } from 'vue'
import { log } from './log.js'

/**
 * Fallback ohne Cast-SDK: die Remote Playback API steckt direkt im
 * <audio>-Element und wird von Chrome auf Android unterstuetzt. Chrome zeigt
 * dabei seine eigene Geraeteauswahl; die Wiedergabe laeuft danach auf dem
 * Chromecast, gesteuert weiterhin ueber dasselbe Element. Ende, Pause und
 * Fortschritt melden sich wie gewohnt - der Player braucht keine Sonderlocke.
 */
export const remoteState = reactive({
  supported: false,
  available: false,
  connected: false,
  connecting: false
})

let element = null

export function setupRemotePlayback(audio) {
  element = audio
  const remote = audio.remote
  if (!remote || typeof remote.watchAvailability !== 'function') return

  remoteState.supported = true

  remote.addEventListener('connecting', () => {
    remoteState.connecting = true
  })
  remote.addEventListener('connect', () => {
    remoteState.connecting = false
    remoteState.connected = true
  })
  remote.addEventListener('disconnect', () => {
    remoteState.connecting = false
    remoteState.connected = false
  })

  verfuegbarkeitBeobachten()
}

function verfuegbarkeitBeobachten() {
  element.remote
    .watchAvailability((available) => {
      remoteState.available = available
    })
    .catch(() => {
      // Manche Browser verweigern die Ueberwachung - Knopf trotzdem anbieten.
      remoteState.available = true
    })
}

// So lange darf Chrome fuer das Trennen brauchen, bevor sein Dialog kommt.
// Kurz genug, dass die Erlaubnis aus dem Fingertipp fuer prompt() noch gilt.
const TRENNEN_MS = 1000

/**
 * Eine Uebertragung ueber diesen Weg beenden - das Gegenstueck zu
 * stopCastSession().
 *
 * Die API kennt kein disconnect(). Laut Spezifikation muss der Browser aber
 * trennen, sobald disableRemotePlayback gesetzt wird; danach wird es wieder
 * freigegeben, und die Verfuegbarkeit muss neu beobachtet werden, denn das
 * Abschalten verwirft die Beobachter. Trennt Chrome trotzdem nicht, oeffnet
 * sich sein Dialog, der dort "Uebertragung beenden" anbietet.
 *
 * Wie beim Cast-SDK wird vorher angehalten - sonst spielt die Folge nach dem
 * Trennen aus dem Telefonlautsprecher weiter. Muss aus dem Klick-Handler
 * heraus aufgerufen werden.
 */
export function stopRemotePlayback() {
  if (!element || !(remoteState.connected || remoteState.connecting)) return Promise.resolve()
  log('cast', 'Remote Playback wird getrennt')
  element.pause()
  return new Promise((fertig) => {
    const uhr = setTimeout(fertig, TRENNEN_MS)
    element.remote.addEventListener(
      'disconnect',
      () => {
        clearTimeout(uhr)
        fertig()
      },
      { once: true }
    )
    element.disableRemotePlayback = true
  }).then(() => {
    element.disableRemotePlayback = false
    verfuegbarkeitBeobachten()
    if (!remoteState.connected && !remoteState.connecting) return
    log('cast', 'Remote Playback trennt nicht von selbst - Chromes Dialog wird geöffnet')
    return element.remote.prompt()
  })
}

export function promptRemotePlayback() {
  if (!element || !remoteState.supported) return Promise.resolve()
  return element.remote.prompt()
}
