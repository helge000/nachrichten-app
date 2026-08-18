import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { setupCast } from './lib/cast.js'

setupCast()
createApp(App).mount('#app')
