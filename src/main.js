import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { setupCast } from './lib/cast.js'
import { setupUpdates } from './lib/update.js'

setupCast()
setupUpdates()
createApp(App).mount('#app')
