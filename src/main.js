import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { setupCast } from './lib/cast.js'
import { setupUpdates } from './lib/update.js'
import { captureGlobalErrors, log } from './lib/log.js'
import { setupSync } from './lib/sync.js'

captureGlobalErrors()
// Woher der Start kommt: "reload" nach einem Update oder Neuladen, und
// wasDiscarded, wenn Android die Seite im Hintergrund verworfen hatte.
const navigation = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null
log('app', 'Start', {
  build: __BUILD_ID__,
  navigation: navigation ? navigation.type : '',
  verworfen: !!document.wasDiscarded,
  sichtbar: document.visibilityState === 'visible'
})
setupCast()
setupUpdates()
setupSync()

// Uebergaenge in den Hintergrund mitschreiben - dort passiert der Fehler.
document.addEventListener('visibilitychange', () => {
  log('app', document.visibilityState === 'hidden' ? 'in den Hintergrund' : 'wieder im Vordergrund')
})
createApp(App).mount('#app')
