import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleFeedRequest, FEED_PATH } from './feed-proxy.mjs'
import { handleAudioRequest, AUDIO_PATH } from './audio-proxy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const port = Number(process.env.PORT || 5174)
const host = process.env.HOST || '0.0.0.0'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

function serveFile(res, file, urlPath) {
  const stream = fs.createReadStream(file)
  const type = TYPES[path.extname(file)] || 'application/octet-stream'
  // Nur Dateien unter /assets/ tragen einen Inhalts-Hash im Namen und duerfen
  // dauerhaft gecacht werden. index.html, sw.js, registerSW.js, das Manifest
  // und die Icons behalten ihren Namen - werden sie lange gecacht, bekommen
  // Nutzer Aenderungen nie zu sehen.
  const hashed = urlPath.startsWith('/assets/')
  res.writeHead(200, {
    'content-type': type,
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache'
  })
  stream.pipe(res)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  if (url.pathname === FEED_PATH) return handleFeedRequest(req, res)
  if (url.pathname === AUDIO_PATH) return handleAudioRequest(req, res)

  const requested = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  const file = path.join(root, requested)
  if (file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    return serveFile(res, file, url.pathname)
  }

  const index = path.join(root, 'index.html')
  if (!fs.existsSync(index)) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('dist/ fehlt - bitte zuerst "npm run build" ausfuehren.')
    return
  }
  serveFile(res, index, '/index.html')
})

server.listen(port, host, () => {
  console.log(`Nachrichten laeuft auf http://localhost:${port}`)
  console.log(`  Feed-Proxy:  ${FEED_PATH}?url=...`)
  console.log(`  Audio-Proxy: ${AUDIO_PATH}?url=...`)
})
