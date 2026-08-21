import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { handleFeedRequest } from './server/feed-proxy.mjs'
import { handleAudioRequest } from './server/audio-proxy.mjs'
import { handleSyncRequest } from './server/sync-store.mjs'
import { handleSayRequest } from './server/say.mjs'

// Damit /feed und /audio schon beim Entwickeln und in der Vorschau funktionieren.
const ENDPUNKTE = [
  ['/feed', handleFeedRequest],
  ['/audio', handleAudioRequest],
  ['/settings', handleSyncRequest],
  ['/say', handleSayRequest]
]

/**
 * Dieselbe Absicherung wie bearbeite() in server/index.mjs.
 *
 * Die Handler sind async, und Connect verwirft ihren Rueckgabewert. Wirft
 * einer - etwa der Sync-Speicher bei einem nicht schreibbaren Verzeichnis -,
 * wird daraus eine unbehandelte Promise-Ablehnung und Node beendet den
 * Dev-Server mitten in der Arbeit.
 */
function abgesichert(handler) {
  return (req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((e) => {
        console.error(`Fehler in ${req.method} ${req.url}:`, e)
        if (res.headersSent) return res.destroy()
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Interner Fehler')
      })
  }
}

function einhaengen(server) {
  for (const [pfad, handler] of ENDPUNKTE) server.middlewares.use(pfad, abgesichert(handler))
}

const feedProxy = {
  name: 'feed-proxy',
  configureServer: einhaengen,
  configurePreviewServer: einhaengen
}

export default defineConfig({
  plugins: [
    vue(),
    feedProxy,
    VitePWA({
      // 'prompt' statt 'autoUpdate': die App entscheidet selbst, wann sie neu
      // laedt - mitten in einer laufenden Folge waere das aergerlich.
      registerType: 'prompt',
      injectRegister: null,
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
        // Nur fuer den Upload in die Google Cast Console - die App braucht das
        // Bild nie, es soll also auch nicht bei jeder Installation mitkommen.
        globIgnores: ['**/cast/cast.png'],
        navigateFallback: '/index.html',
        // Die Proxy-Endpunkte sind keine Seiten - sie duerfen nie die App-Huelle bekommen.
        navigateFallbackDenylist: [/^\/feed/, /^\/audio/, /^\/settings/, /^\/say/],
        runtimeCaching: []
      }
    })
  ],
  define: {
    // Wird bei jedem Build neu gesetzt und in den Einstellungen angezeigt.
    __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' '))
  },
  server: { host: true }
})
