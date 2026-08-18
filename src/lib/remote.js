import { reactive } from 'vue'

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

  remote.watchAvailability((available) => {
    remoteState.available = available
  }).catch(() => {
    // Manche Browser verweigern die Ueberwachung - Knopf trotzdem anbieten.
    remoteState.available = true
  })
}

export function promptRemotePlayback() {
  if (!element || !remoteState.supported) return Promise.resolve()
  return element.remote.prompt()
}
