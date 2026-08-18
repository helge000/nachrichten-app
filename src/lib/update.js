import { reactive } from 'vue'
import { registerSW } from 'virtual:pwa-register'

export const BUILD_ID = __BUILD_ID__

export const updateState = reactive({
  supported: 'serviceWorker' in navigator,
  available: false,
  checking: false,
  lastCheck: null
})

let applyUpdate = null
let registration = null

/** Prueft alle 60 Minuten und immer beim Zurueckkehren in die App. */
const CHECK_INTERVAL = 60 * 60 * 1000

export function setupUpdates() {
  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateState.available = true
    },
    onRegisteredSW(swUrl, registered) {
      registration = registered || null
      if (!registration) return

      // Eine installierte PWA navigiert oft tagelang nicht - ohne Navigation
      // sucht der Browser von sich aus nie nach einer neuen sw.js.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate()
      })
      setInterval(checkForUpdate, CHECK_INTERVAL)
      checkForUpdate()
    }
  })
}

export async function checkForUpdate() {
  if (!registration || updateState.checking) return
  updateState.checking = true
  try {
    await registration.update()
  } catch (e) {
    console.info('Update-Pruefung fehlgeschlagen:', e)
  } finally {
    updateState.checking = false
    updateState.lastCheck = new Date()
  }
}

/** Aktiviert den wartenden Service Worker und laedt die Seite neu. */
export function applyUpdateNow() {
  if (applyUpdate) applyUpdate(true)
}
