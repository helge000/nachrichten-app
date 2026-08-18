import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { handleFeedRequest } from './server/feed-proxy.mjs'
import { handleAudioRequest } from './server/audio-proxy.mjs'

// Damit /feed und /audio schon beim Entwickeln und in der Vorschau funktionieren.
const feedProxy = {
  name: 'feed-proxy',
  configureServer(server) {
    server.middlewares.use('/feed', handleFeedRequest)
    server.middlewares.use('/audio', handleAudioRequest)
  },
  configurePreviewServer(server) {
    server.middlewares.use('/feed', handleFeedRequest)
    server.middlewares.use('/audio', handleAudioRequest)
  }
}

export default defineConfig({
  plugins: [
    vue(),
    feedProxy,
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'Nachrichten',
        short_name: 'Nachrichten',
        description: 'Deine Nachrichten-Podcasts am Stück abspielen.',
        lang: 'de',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f1115',
        theme_color: '#0f1115',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: '/index.html',
        // Die Proxy-Endpunkte sind keine Seiten - sie duerfen nie die App-Huelle bekommen.
        navigateFallbackDenylist: [/^\/feed/, /^\/audio/],
        runtimeCaching: []
      }
    })
  ],
  server: { host: true }
})
