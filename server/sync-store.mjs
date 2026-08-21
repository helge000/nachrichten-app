import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const SYNC_PATH = '/settings'

// Grenzen, damit ein offener Endpunkt niemandem die Platte volllaufen laesst.
// Schlimmster Fall: 50 x 64 KB = 3,2 MB.
const MAX_BYTES = 64 * 1024
const MAX_BUCKETS = 50

// Der Schluessel ist zugleich Kennung und Geheimnis. Die App vergibt ihn mit
// 16 Zeichen aus einem 28er-Alphabet - rund 77 Bit und damit nicht zu
// erraten (siehe schluesselErzeugen in src/lib/sync.js). Gespeichert wird nur
// sein Hash, nie er selbst.
const MIN_KEY_LENGTH = 16
const MAX_KEY_LENGTH = 128

const dataDir = process.env.SYNC_DIR || path.join(process.cwd(), 'data', 'sync')

function ensureDir() {
  fs.mkdirSync(dataDir, { recursive: true })
}

/**
 * Beim Start pruefen, ob wirklich geschrieben werden kann.
 *
 * Der haeufigste Fall: Docker legt ein fehlendes Bind-Mount-Verzeichnis als
 * root an, der Container laeuft aber als "node". Ohne diese Pruefung faellt
 * das erst beim ersten Speicherversuch auf - und dann still.
 */
export function pruefeSchreibrecht() {
  try {
    ensureDir()
    const probe = path.join(dataDir, '.schreibtest')
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return { ok: true, pfad: dataDir }
  } catch (e) {
    return { ok: false, pfad: dataDir, grund: e && e.message ? e.message : String(e) }
  }
}

function bucketFile(key) {
  const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex')
  return path.join(dataDir, `${hash}.json`)
}

function countBuckets() {
  try {
    return fs.readdirSync(dataDir).filter((f) => f.endsWith('.json')).length
  } catch (e) {
    return 0
  }
}

function normalizeKey(raw) {
  // Schreibweise egal, Trennstriche und Leerzeichen ebenfalls.
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]/g, '')
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    let abgebrochen = false
    const teile = []
    req.on('data', (stueck) => {
      if (abgebrochen) return
      size += stueck.length
      if (size > limit) {
        // Nicht die Verbindung kappen - sonst bekommt der Anrufer gar keine
        // Antwort. Rest verwerfen und regulaer mit 413 antworten.
        abgebrochen = true
        req.resume()
        reject(new Error('zu groß'))
        return
      }
      teile.push(stueck)
    })
    req.on('end', () => {
      if (!abgebrochen) resolve(Buffer.concat(teile).toString('utf8'))
    })
    req.on('error', (e) => {
      if (!abgebrochen) reject(e)
    })
  })
}

/**
 * Einstellungen synchronisieren.
 *
 *   GET  /settings   Header X-Sync-Key   -> gespeicherter Stand oder 404
 *   PUT  /settings   Header X-Sync-Key   -> speichert, gibt neuen Stand zurueck
 *   DELETE /settings Header X-Sync-Key   -> loescht den Datensatz
 *
 * Die Revision verhindert, dass zwei Geraete sich gegenseitig ueberschreiben:
 * passt die mitgeschickte Revision nicht, kommt 409 samt Serverfassung zurueck.
 */
export async function handleSyncRequest(req, res) {
  const send = (status, daten) => {
    const koerper = typeof daten === 'string' ? daten : JSON.stringify(daten)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-sync-key, if-match',
      'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS',
      'cache-control': 'no-store'
    })
    res.end(koerper)
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-sync-key, if-match',
      'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS'
    })
    return res.end()
  }

  const key = normalizeKey(req.headers['x-sync-key'])
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
    return send(400, { fehler: 'Ungültiger Sync-Schlüssel' })
  }
  if (!/^[a-z0-9]+$/.test(key)) {
    return send(400, { fehler: 'Sync-Schlüssel enthält unerlaubte Zeichen' })
  }

  try {
    ensureDir()
  } catch (e) {
    console.error('Sync-Verzeichnis nicht anlegbar:', e && e.message ? e.message : e)
    return send(500, { fehler: 'Speicher auf dem Server nicht verfügbar' })
  }
  const datei = bucketFile(key)

  if (req.method === 'GET') {
    if (!fs.existsSync(datei)) return send(404, { fehler: 'Kein gespeicherter Stand' })
    try {
      return send(200, JSON.parse(fs.readFileSync(datei, 'utf8')))
    } catch (e) {
      return send(500, { fehler: 'Gespeicherter Stand ist beschädigt' })
    }
  }

  if (req.method === 'DELETE') {
    try {
      if (fs.existsSync(datei)) fs.unlinkSync(datei)
    } catch (e) {
      console.error('Sync-Datensatz nicht löschbar:', e && e.message ? e.message : e)
      return send(500, { fehler: 'Löschen auf dem Server fehlgeschlagen' })
    }
    return send(200, { geloescht: true })
  }

  if (req.method !== 'PUT') return send(405, { fehler: 'Nur GET, PUT, DELETE' })

  // Neuer Datensatz nur, solange das Kontingent reicht.
  const istNeu = !fs.existsSync(datei)
  if (istNeu && countBuckets() >= MAX_BUCKETS) {
    return send(507, { fehler: 'Keine freien Plätze mehr auf diesem Server' })
  }

  let text
  try {
    text = await readBody(req, MAX_BYTES)
  } catch (e) {
    return send(413, { fehler: `Einstellungen zu groß (max. ${MAX_BYTES / 1024} KB)` })
  }

  let inhalt
  try {
    inhalt = JSON.parse(text)
  } catch (e) {
    return send(400, { fehler: 'Kein gültiges JSON' })
  }
  if (!inhalt || typeof inhalt !== 'object' || Array.isArray(inhalt)) {
    return send(400, { fehler: 'Erwartet wird ein JSON-Objekt' })
  }

  let vorhanden = null
  if (!istNeu) {
    try {
      vorhanden = JSON.parse(fs.readFileSync(datei, 'utf8'))
    } catch (e) {
      vorhanden = null
    }
  }

  const bekannteRevision = Number(req.headers['if-match'] || 0)
  const serverRevision = vorhanden ? Number(vorhanden.rev || 0) : 0
  if (vorhanden && bekannteRevision !== serverRevision) {
    // Ein anderes Geraet war schneller - der Anrufer entscheidet, was gilt.
    return send(409, { fehler: 'Auf einem anderen Gerät geändert', stand: vorhanden })
  }

  const neu = {
    rev: serverRevision + 1,
    updatedAt: new Date().toISOString(),
    settings: inhalt.settings === undefined ? inhalt : inhalt.settings
  }

  // Erst daneben schreiben, dann umbenennen - so bleibt bei einem Absturz
  // nie eine halb geschriebene Datei zurueck.
  //
  // Schlaegt das Schreiben fehl (haeufigster Fall: das Bind-Mount gehoert root,
  // der Container laeuft als "node" - siehe pruefeSchreibrecht), muss das eine
  // Fehlerantwort geben. Ungefangen riss es frueher den ganzen Server mit.
  const temp = `${datei}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(neu), 'utf8')
    fs.renameSync(temp, datei)
  } catch (e) {
    console.error('Sync-Stand nicht speicherbar:', e && e.message ? e.message : e)
    try {
      fs.unlinkSync(temp)
    } catch (auch) {
      // Halbe Datei liegen lassen - sie traegt die .tmp-Endung und wird
      // beim naechsten Versuch ueberschrieben.
    }
    return send(500, { fehler: 'Speichern auf dem Server fehlgeschlagen' })
  }

  return send(200, neu)
}
