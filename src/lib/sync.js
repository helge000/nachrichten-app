import { reactive, watch } from 'vue'
import { settings, normalizeSettings } from './store.js'
import { log } from './log.js'

const KEY_STORAGE = 'nachrichten-app.synckey'
const REV_STORAGE = 'nachrichten-app.syncrev'
export const SYNC_URL = '/settings'

// Nach einer Aenderung kurz warten, damit Tippen nicht jede Taste hochlaedt.
const PUSH_DELAY = 1500

export const syncState = reactive({
  key: '',
  aktiv: false,
  status: 'aus', // aus | bereit | laedt | gespeichert | fehler
  meldung: '',
  zuletzt: null,
  rev: 0
})

/**
 * Schluessel erzeugen: 128 Bit, in Vierergruppen dargestellt.
 *
 * Der Schluessel ist zugleich Kennung und Geheimnis - es gibt keine Konten.
 * Ohne Vokale, damit versehentlich keine echten Woerter entstehen, und ohne
 * die Verwechslungspaare 0/o und 1/l.
 */
const ALPHABET = '23456789bcdfghjkmnpqrstvwxyz'

export function schluesselErzeugen() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let roh = ''
  for (const b of bytes) roh += ALPHABET[b % ALPHABET.length]
  return roh.match(/.{1,4}/g).join('-')
}

export function normalisiere(roh) {
  return String(roh || '').trim().toLowerCase().replace(/[\s-]/g, '')
}

export function schluesselGueltig(roh) {
  const k = normalisiere(roh)
  return k.length >= 16 && /^[a-z0-9]+$/.test(k)
}

function ladeSchluessel() {
  try {
    return localStorage.getItem(KEY_STORAGE) || ''
  } catch (e) {
    return ''
  }
}

function merkeSchluessel(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key)
    else localStorage.removeItem(KEY_STORAGE)
  } catch (e) {
    log('sync', 'Schluessel konnte nicht gespeichert werden')
  }
}

function merkeRev(rev) {
  syncState.rev = rev
  try {
    localStorage.setItem(REV_STORAGE, String(rev))
  } catch (e) {
    // Ohne gemerkte Revision gibt es beim naechsten Mal einen Konflikt,
    // der sich aber selbst aufloest.
  }
}

/** Nur den Inhalt synchronisieren - der Schluessel selbst gehoert nicht hinein. */
function nutzlast() {
  return {
    version: settings.version,
    corsProxy: settings.corsProxy,
    audioProxy: settings.audioProxy,
    preloadEpisodes: settings.preloadEpisodes,
    announceEpisodes: settings.announceEpisodes,
    announceRate: settings.announceRate,
    sources: settings.sources.map((s) => ({ ...s }))
  }
}

function uebernehmen(daten) {
  const next = normalizeSettings(daten)
  settings.corsProxy = next.corsProxy
  settings.audioProxy = next.audioProxy
  settings.preloadEpisodes = next.preloadEpisodes
  settings.announceEpisodes = next.announceEpisodes
  settings.announceRate = next.announceRate
  settings.sources.splice(0, settings.sources.length, ...next.sources)
}

async function anfrage(methode, koerper, revision) {
  const kopf = { 'x-sync-key': normalisiere(syncState.key) }
  if (koerper) {
    kopf['content-type'] = 'application/json'
    kopf['if-match'] = String(revision === undefined ? syncState.rev : revision)
  }
  const antwort = await fetch(SYNC_URL, {
    method: methode,
    headers: kopf,
    body: koerper ? JSON.stringify({ settings: koerper }) : undefined,
    cache: 'no-store'
  })
  let daten = null
  try {
    daten = await antwort.json()
  } catch (e) {
    daten = null
  }
  return { status: antwort.status, daten }
}

/** Stand vom Server holen und uebernehmen. */
export async function holen({ still = false } = {}) {
  if (!syncState.aktiv) return false
  if (!still) syncState.status = 'laedt'
  try {
    const { status, daten } = await anfrage('GET')
    if (status === 404) {
      syncState.status = 'bereit'
      syncState.meldung = 'Noch nichts gespeichert - beim naechsten Aendern wird gesichert.'
      log('sync', 'Serverseitig noch kein Stand')
      return false
    }
    if (status !== 200 || !daten) throw new Error(`HTTP ${status}`)

    uebernehmen(daten.settings)
    merkeRev(Number(daten.rev) || 0)
    syncState.zuletzt = new Date()
    syncState.status = 'gespeichert'
    syncState.meldung = ''
    log('sync', 'Stand vom Server uebernommen', { rev: syncState.rev })
    return true
  } catch (e) {
    syncState.status = 'fehler'
    syncState.meldung = e && e.message ? e.message : String(e)
    log('sync', 'Holen fehlgeschlagen', syncState.meldung)
    return false
  }
}

/** Aktuellen Stand hochladen. Bei Konflikt gewinnt die juengere Fassung. */
export async function sichern() {
  if (!syncState.aktiv) return false
  syncState.status = 'laedt'
  try {
    const { status, daten } = await anfrage('PUT', nutzlast())

    if (status === 409 && daten && daten.stand) {
      // Ein anderes Geraet war schneller. Was hier verdraengt wird, muss
      // nachvollziehbar bleiben - deshalb die Quellen namentlich ins Protokoll,
      // nicht ein abgeschnittener JSON-Block.
      const eigene = nutzlast().sources.map((q) => q.title)
      const vomServer = (daten.stand.settings.sources || []).map((q) => q.title)
      const verloren = eigene.filter((t) => !vomServer.includes(t))
      log('sync', 'Konflikt - Serverstand ist neuer', {
        server: daten.stand.updatedAt,
        verdraengt: eigene.join(', ') || '(leer)',
        nichtMehrEnthalten: verloren.join(', ') || 'nichts'
      })
      uebernehmen(daten.stand.settings)
      merkeRev(Number(daten.stand.rev) || 0)
      syncState.status = 'gespeichert'
      syncState.meldung = 'Auf einem anderen Geraet geaendert - dieser Stand wurde uebernommen.'
      return false
    }

    if (status !== 200 || !daten) throw new Error((daten && daten.fehler) || `HTTP ${status}`)

    merkeRev(Number(daten.rev) || 0)
    syncState.zuletzt = new Date()
    syncState.status = 'gespeichert'
    syncState.meldung = ''
    log('sync', 'Gesichert', { rev: syncState.rev })
    return true
  } catch (e) {
    syncState.status = 'fehler'
    syncState.meldung = e && e.message ? e.message : String(e)
    log('sync', 'Sichern fehlgeschlagen', syncState.meldung)
    return false
  }
}

export function einrichten(key) {
  const k = key || schluesselErzeugen()
  if (!schluesselGueltig(k)) return false
  syncState.key = k
  syncState.aktiv = true
  syncState.status = 'bereit'
  syncState.meldung = ''
  merkeSchluessel(k)
  merkeRev(0)
  log('sync', 'Eingerichtet')
  return true
}

export function beenden() {
  syncState.key = ''
  syncState.aktiv = false
  syncState.status = 'aus'
  syncState.meldung = ''
  merkeSchluessel('')
  merkeRev(0)
  log('sync', 'Abgeschaltet')
}

/** Link, mit dem ein zweites Geraet den Schluessel uebernimmt - ohne Tippen. */
export function einrichtungsLink() {
  if (!syncState.key) return ''
  // Der Teil hinter # wird nie an den Server geschickt.
  return `${location.origin}/#sync=${encodeURIComponent(syncState.key)}`
}

let timer = null

export function setupSync() {
  // Schluessel aus einem Einrichtungslink uebernehmen.
  const treffer = /[#&]sync=([^&]+)/.exec(location.hash || '')
  if (treffer) {
    const ausLink = decodeURIComponent(treffer[1])
    if (schluesselGueltig(ausLink)) {
      einrichten(ausLink)
      log('sync', 'Schluessel aus Einrichtungslink uebernommen')
    }
    // Aus der Adresszeile entfernen, damit er nicht im Verlauf stehen bleibt.
    history.replaceState(null, '', location.pathname + location.search)
  }

  const gemerkt = ladeSchluessel()
  if (gemerkt && !syncState.aktiv) {
    syncState.key = gemerkt
    syncState.aktiv = true
    syncState.status = 'bereit'
    try {
      syncState.rev = Number(localStorage.getItem(REV_STORAGE)) || 0
    } catch (e) {
      syncState.rev = 0
    }
  }

  if (!syncState.aktiv) return

  holen()

  // Aenderungen verzoegert hochladen.
  watch(
    () => JSON.stringify(nutzlast()),
    () => {
      if (!syncState.aktiv || syncState.status === 'laedt') return
      clearTimeout(timer)
      timer = setTimeout(sichern, PUSH_DELAY)
    }
  )

  // Beim Zurueckkehren in die App den neuesten Stand holen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') holen({ still: true })
  })
}
