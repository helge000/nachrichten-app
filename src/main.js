import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { setupCast } from './lib/cast.js'
import { setupUpdates } from './lib/update.js'
import { captureGlobalErrors, log } from './lib/log.js'

captureGlobalErrors()
log('app', 'Start', { build: __BUILD_ID__ })
setupCast()
setupUpdates()

// Uebergaenge in den Hintergrund mitschreiben - dort passiert der Fehler.
document.addEventListener('visibilitychange', () => {
  log('app', document.visibilityState === 'hidden' ? 'in den Hintergrund' : 'wieder im Vordergrund')
})
createApp(App).mount('#app')
