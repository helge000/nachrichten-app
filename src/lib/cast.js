import { reactive } from 'vue'
import { log } from './log.js'

// Google Cast ist optional: ohne SDK (kein Chrome, kein HTTPS) laeuft alles lokal weiter.
const SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'

// Offizielle Konstanten des Cast-SDK. Sie dienen als Rueckfall, weil der Loader
// zwei Skripte zieht: cast.framework kann bereit sein, waehrend der Namensraum
// chrome.cast noch nicht vollstaendig ist. Ohne Rueckfall wandert dann
// "undefined" als App-ID in setOptions und das SDK wirft.
// Eigener Empfaenger (public/receiver.html), registriert in der Google Cast
// Developer Console. Nur damit steht auf dem Fernseher "Nachrichten" statt
// "unbekannte App", und nur damit greifen Hintergrundbild und eigene Anzeige.
const RECEIVER_APP_ID = 'BF0E7317'
const AUTO_JOIN_ORIGIN_SCOPED = 'origin_scoped'
const MAX_INIT_ATTEMPTS = 50

// Die Fehlercodes des Cast-SDK. Chrome zeigt im Dialog nur "error connecting
// device" - der Code darunter sagt, was wirklich los ist.
const ERROR_TEXT = {
  cancel: 'Auswahl abgebrochen',
  timeout: 'Zeitüberschreitung - Gerät antwortet nicht',
  api_not_initialized: 'Cast-SDK war noch nicht bereit',
  invalid_parameter: 'Ungültiger Parameter an das SDK',
  extension_missing: 'Cast-Erweiterung fehlt',
  extension_not_compatible: 'Cast-Erweiterung ist zu alt',
  receiver_unavailable: 'Kein passender Empfänger gefunden',
  session_error: 'Sitzung konnte nicht aufgebaut werden',
  channel_error: 'Verbindung zum Gerät abgebrochen - meist Netzwerk/WLAN',
  load_media_failed: 'Medium konnte nicht geladen werden'
}

export function describeCastError(error) {
  if (!error) return 'Unbekannter Fehler'
  const code = error.code || error.errorCode || ''
  const text = ERROR_TEXT[code]
  const detail = error.description || error.message || ''
  if (text) return detail ? `${text} (${code}: ${detail})` : `${text} (${code})`
  return detail || code || String(error)
}

// Die Bedingungen, die der Cast-Loader auf Android prueft. Ohne sie laedt das
// SDK stillschweigend nicht - deshalb hier sichtbar gemacht.
export const castDiagnostics = reactive({
  isAndroid: false,
  chromeVersion: 0,
  hasPresentationApi: false,
  scriptLoaded: false,
  frameworkLoaded: false,
  chromeCastReady: false,
  appId: ''
})

export const castState = reactive({
  // SDK geladen und einsatzbereit - erst dann erscheint der Cast-Knopf.
  available: false,
  // Warum nicht, falls nicht verfuegbar (fuer die Diagnose in den Einstellungen).
  reason: '',
  // 'NO_DEVICES_AVAILABLE' | 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED'
  deviceState: '',
  connected: false,
  // Letzter Verbindungsfehler im Klartext - fuer die Diagnose.
  lastError: '',
  // Laeuft eine Warteschlange auf dem Empfaenger? Dann schaltet er selbst
  // weiter und die Senderseite haelt sich raus.
  queueActive: false,
  // Welche Datei laeuft dort gerade - damit die Anzeige folgen kann.
  currentContentId: '',
  deviceName: '',
  playing: false,
  currentTime: 0,
  duration: 0
})

let remotePlayer = null
let controller = null
// Merker, ob fuer den aktuellen Track ueberhaupt schon etwas lief. Ohne ihn
// laesst sich "noch nicht geladen" nicht von "fertig abgespielt" unterscheiden.
let mediaLoaded = false
const listeners = { ended: [], connected: [], disconnected: [], trackchange: [] }

function emit(event, daten) {
  for (const fn of listeners[event]) {
    try {
      fn(daten)
    } catch (e) {
      console.warn('Cast-Listener fehlgeschlagen:', e)
    }
  }
}

export function onCast(event, fn) {
  listeners[event].push(fn)
}

function attachRemotePlayer() {
  const framework = window.cast.framework
  remotePlayer = new framework.RemotePlayer()
  controller = new framework.RemotePlayerController(remotePlayer)

  controller.addEventListener(framework.RemotePlayerEventType.CURRENT_TIME_CHANGED, () => {
    castState.currentTime = remotePlayer.currentTime || 0
  })
  controller.addEventListener(framework.RemotePlayerEventType.DURATION_CHANGED, () => {
    castState.duration = remotePlayer.duration || 0
  })
  // Der Empfaenger wechselt die Folge selbst - hier erfahren wir davon.
  controller.addEventListener(framework.RemotePlayerEventType.MEDIA_INFO_CHANGED, () => {
    const info = remotePlayer.mediaInfo
    const id = info && info.contentId ? info.contentId : ''
    if (id && id !== castState.currentContentId) {
      castState.currentContentId = id
      log('cast', 'Empfänger spielt neue Folge', id.slice(0, 70))
      emit('trackchange')
    }
  })

  controller.addEventListener(framework.RemotePlayerEventType.PLAYER_STATE_CHANGED, () => {
    const state = remotePlayer.playerState
    castState.playing = state === 'PLAYING'

    if (state === 'PLAYING' || state === 'PAUSED' || state === 'BUFFERING') {
      mediaLoaded = true
      return
    }
    // IDLE heisst nur dann "Folge zu Ende", wenn vorher wirklich etwas lief.
    // Sonst wuerde schon der Ladevorgang als Ende durchgehen.
    if (state === 'IDLE' && mediaLoaded) {
      mediaLoaded = false
      // Bei aktiver Warteschlange schaltet der Empfaenger selbst weiter -
      // dann darf die Senderseite nicht dazwischenfunken.
      if (castState.queueActive) {
        log('cast', 'IDLE bei aktiver Warteschlange - Empfänger macht selbst weiter')
        return
      }
      emit('ended')
    }
  })
}

// Zustaende, in denen wirklich etwas laeuft. IDLE zaehlt nicht dazu: der
// Empfaenger steht dann entweder vor dem ersten Titel oder hinter dem letzten.
const LAEUFT = ['PLAYING', 'PAUSED', 'BUFFERING']

/** Was spielt der Empfaenger gerade? Nur bei uebernommener Sitzung gefragt. */
function empfaengerZustand(current) {
  try {
    const media = current && current.getMediaSession()
    if (!media) return null
    return {
      contentId: (media.media && media.media.contentId) || '',
      zustand: media.playerState || '',
      eintraege: Array.isArray(media.items) ? media.items.length : 0
    }
  } catch (e) {
    return null
  }
}

// Nach SESSION_RESUMED steht der Stand des Empfaengers noch nicht bereit:
// getMediaSession() antwortet erst, wenn der erste Medienstatus angekommen ist,
// im Feld rund eine Viertelsekunde spaeter. Ohne dieses Nachfassen sieht die
// App "da laeuft nichts", startet die Playlist von vorn und reisst dem
// Lautsprecher mitten im Satz die laufende Folge weg.
const UEBERNAHME_TAKT_MS = 150
const UEBERNAHME_MAX_MS = 3000

/**
 * Eine bereits laufende Sitzung uebernehmen, statt sie zu ueberschreiben.
 *
 * Wichtig ist dabei die Warteschlange: dass eine laeuft, weiss nur der
 * Empfaenger - die Senderseite hat beim Neuladen der Seite alles vergessen.
 * Bliebe queueActive auf false, wuerde jeder Titelwechsel des Empfaengers hier
 * als "Folge zu Ende" ankommen und die App faengt an, gegen ihn zu schalten.
 */
function sitzungUebernehmen(current, seit = Date.now()) {
  if (!castState.connected) return
  const stand = empfaengerZustand(current)
  if (!stand && Date.now() - seit < UEBERNAHME_MAX_MS) {
    setTimeout(() => sitzungUebernehmen(current, seit), UEBERNAHME_TAKT_MS)
    return
  }

  const laeuft = !!(stand && stand.contentId && LAEUFT.indexOf(stand.zustand) >= 0)
  if (stand) {
    mediaLoaded = LAEUFT.indexOf(stand.zustand) >= 0
    castState.playing = stand.zustand === 'PLAYING'
    castState.currentContentId = stand.contentId
    // Konnte der Empfaenger seine Warteschlange nicht nennen, gilt sie als
    // aktiv: diese App laedt immer eine, und ein faelschlich angenommenes
    // "keine" laesst die Senderseite bei jedem Titelwechsel dazwischenfunken.
    castState.queueActive = laeuft && stand.eintraege !== 1
    log('cast', 'Sitzung übernommen', {
      zustand: stand.zustand,
      eintraege: stand.eintraege,
      warteschlange: castState.queueActive
    })
  } else {
    log('cast', 'Sitzung übernommen - Empfänger meldet nichts Laufendes')
  }
  emit('connected', { uebernommen: true, laeuft })
}

function deviceNameOf(session) {
  try {
    const device = session && session.getCastDevice()
    if (device) log('cast', 'Zielgerät', { name: device.friendlyName, kann: device.capabilities || [] })
    return device ? device.friendlyName : ''
  } catch (e) {
    return ''
  }
}

/**
 * Prueft genau das, was castLoad() wirklich braucht: die Konstruktoren.
 *
 * Frueher wurde hier auf die Konstante DefaultMediaReceiverAppId geprueft.
 * Die fehlt in manchen Chrome-Fassungen (z. B. Chrome 151 auf ChromeOS),
 * obwohl das SDK voll funktionsfaehig ist - dadurch lehnte castLoad() immer ab,
 * der Empfaenger bekam nie ein Medium und beendete die Sitzung nach Sekunden.
 */
function chromeCastReady() {
  const media = window.chrome && window.chrome.cast && window.chrome.cast.media
  return !!(media && typeof media.MediaInfo === 'function' && typeof media.LoadRequest === 'function')
}

let initAttempts = 0

/** Wartet auf einen vollstaendigen chrome.cast-Namensraum und faengt Fehler ab. */
function initialize() {
  if (!window.cast || !window.cast.framework) return

  if (!chromeCastReady() && initAttempts < MAX_INIT_ATTEMPTS) {
    initAttempts += 1
    setTimeout(initialize, 100)
    return
  }
  castDiagnostics.chromeCastReady = chromeCastReady()

  try {
    startCastContext()
  } catch (e) {
    castState.available = false
    castState.reason = `Cast-Initialisierung fehlgeschlagen: ${e.message || e}`
    console.warn(castState.reason, e)
  }
}

function startCastContext() {
  const framework = window.cast.framework
  const ns = (window.chrome && window.chrome.cast) || {}
  const context = framework.CastContext.getInstance()

  castDiagnostics.appId = RECEIVER_APP_ID
  context.setOptions({
    receiverApplicationId: RECEIVER_APP_ID,
    autoJoinPolicy: (ns.AutoJoinPolicy && ns.AutoJoinPolicy.ORIGIN_SCOPED) || AUTO_JOIN_ORIGIN_SCOPED
  })

  // Meldet, ob ueberhaupt ein Empfaenger im Netz gefunden wurde.
  context.addEventListener(framework.CastContextEventType.CAST_STATE_CHANGED, (event) => {
    castState.deviceState = event.castState
    log('cast', 'Gerätezustand', event.castState)
  })
  try {
    castState.deviceState = context.getCastState()
  } catch (e) {
    castState.deviceState = ''
  }

  context.addEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
    const state = event.sessionState
    const session = context.getCurrentSession()
    const wasConnected = castState.connected
    castState.connected = state === 'SESSION_STARTED' || state === 'SESSION_RESUMED'
    castState.deviceName = deviceNameOf(session)
    log('cast', 'Sitzungszustand', { zustand: state, geraet: castState.deviceName })
    if (state === 'SESSION_ENDED' && !mediaLoaded) {
      // Der Standard-Empfaenger beendet sich, wenn er nach dem Verbinden kein
      // Medium bekommt. Genau das passiert, wenn beim Verbinden nichts laeuft.
      log('cast', 'Sitzung endete ohne Medium - Empfänger lief in den Leerlauf')
    }
    if (state === 'SESSION_STARTED' || state === 'SESSION_START_FAILED') auswahlFreigeben()
    if (castState.connected && !wasConnected) {
      // Eine uebernommene Sitzung lief schon, bevor diese Seite geladen wurde -
      // erst nachsehen, was dort spielt, dann entscheiden.
      if (state === 'SESSION_RESUMED') sitzungUebernehmen(session)
      else emit('connected', { uebernommen: false, laeuft: false })
    }
    if (!castState.connected && wasConnected) {
      mediaLoaded = false
      castState.queueActive = false
      castState.currentContentId = ''
      castState.playing = false
      castState.currentTime = 0
      castState.duration = 0
      emit('disconnected')
    }
  })

  attachRemotePlayer()
  castDiagnostics.frameworkLoaded = true
  castState.available = true
  castState.reason = ''
  log('cast', 'SDK bereit', { appId: castDiagnostics.appId })
}

export function setupCast() {
  const ua = navigator.userAgent || ''
  const match = ua.match(/Chrome\/(\d+)/)
  castDiagnostics.isAndroid = ua.indexOf('Android') >= 0
  castDiagnostics.chromeVersion = match ? parseInt(match[1], 10) : 0
  castDiagnostics.hasPresentationApi = !!navigator.presentation

  if (castDiagnostics.isAndroid && !castDiagnostics.hasPresentationApi) {
    castState.reason = 'Presentation API fehlt - das Cast-SDK lädt auf Android nur mit ihr'
  }

  if (window.cast && window.cast.framework) {
    initialize()
    return
  }
  window.__onGCastApiAvailable = (isAvailable, reason) => {
    if (isAvailable) {
      initialize()
      return
    }
    castState.reason = reason || 'Chrome meldet keine Cast-Unterstützung'
    console.info('Cast nicht verfügbar:', castState.reason)
  }
  const script = document.createElement('script')
  script.src = SDK_URL
  script.async = true
  script.onload = () => {
    castDiagnostics.scriptLoaded = true
  }
  script.onerror = () => {
    castState.reason = 'Cast-SDK konnte nicht geladen werden (offline oder blockiert)'
    console.info(castState.reason)
  }
  document.head.appendChild(script)
}

function session() {
  if (!castState.available) return null
  return window.cast.framework.CastContext.getInstance().getCurrentSession()
}

// Chrome laesst immer nur eine Geraeteauswahl gleichzeitig zu, und eine
// abgebrochene Auswahl kommt nie zurueck: die Presentation API, auf der das
// Cast-SDK auf Android aufsitzt, laesst das Versprechen absichtlich ungeloest,
// damit die Seite nicht erfaehrt, dass der Nutzer den Dialog weggetippt hat.
// Das ist so gewollt und nichts, was sich hier abfangen laesst - die erste
// Anfrage bleibt bis zum Neuladen der Seite haengen und blockiert jede weitere.
//
// Also wird die haengende Auswahl erkannt und der einzige Weg gegangen, der sie
// loest: die Seite neu laden. Genau das hat der Nutzer bisher von Hand getan.
let auswahlLaeuft = false
let auswahlSeit = 0
let auswahlWache = null

// Vor Ablauf dieser Zeit gilt ein zweiter Aufruf als Doppeltippen, danach als
// Zeichen, dass die Auswahl haengt.
const AUSWAHL_HAENGT_MS = 2500

// Notbremse, falls die erste Anfrage nie zurueckkommt: nach dieser Zeit darf
// wieder gefragt werden, statt den Knopf bis zum Neuladen tot zu lassen.
const AUSWAHL_MAX_MS = 30000

function auswahlFreigeben() {
  auswahlLaeuft = false
  auswahlSeit = 0
  if (auswahlWache) {
    clearTimeout(auswahlWache)
    auswahlWache = null
  }
}

export function requestCastSession() {
  if (!castState.available) {
    log('cast', 'requestSession ohne verfügbares SDK abgelehnt')
    return Promise.reject(new Error('Cast-SDK nicht verfügbar'))
  }
  if (auswahlLaeuft) {
    const offenSeit = Date.now() - auswahlSeit
    if (offenSeit < AUSWAHL_HAENGT_MS) {
      log('cast', 'Geräteauswahl läuft bereits - zweiter Aufruf übersprungen', { msOffen: offenSeit })
      return Promise.reject(new Error('Geräteauswahl ist bereits offen'))
    }
    log('cast', 'Geräteauswahl hängt - nur ein Neuladen löst sie', { msOffen: offenSeit })
    return Promise.reject(
      Object.assign(new Error('Geräteauswahl hängt seit dem letzten Versuch'), { steckt: true })
    )
  }
  auswahlLaeuft = true
  auswahlSeit = Date.now()
  auswahlWache = setTimeout(auswahlFreigeben, AUSWAHL_MAX_MS)
  log('cast', 'Geräteauswahl wird geöffnet', { zustand: castState.deviceState })
  return window.cast.framework.CastContext.getInstance()
    .requestSession()
    .then((result) => {
      // Das SDK liefert bei Misserfolg einen Fehlercode statt einer Ablehnung.
      if (result) {
        const text = describeCastError(result)
        log('cast', 'Verbindung fehlgeschlagen', text)
        castState.lastError = text
        throw Object.assign(new Error(text), { castResult: result })
      }
      log('cast', 'Sitzung aufgebaut')
      castState.lastError = ''
      return result
    })
    .catch((e) => {
      const text = e && e.castResult ? describeCastError(e.castResult) : describeCastError(e)
      castState.lastError = text
      log('cast', 'requestSession abgelehnt', text)
      // "invalid_parameter" heisst hier immer: es steht noch eine Auswahl offen,
      // die nie zurueckkommt. Auch dann hilft nur das Neuladen.
      if (/invalid_parameter/i.test(text)) e = Object.assign(e || new Error(text), { steckt: true })
      throw e
    })
    .finally(auswahlFreigeben)
}

/**
 * Meldet das Cast-Ziel sich als Lautsprechergruppe?
 *
 * Nur fuer das Protokoll: der Vorlauf vor einer Ansage gilt inzwischen fuer
 * jedes Cast-Ziel, weil nicht sicher ist, dass eine Gruppe sich auch als solche
 * ausweist. Diese Antwort steht im Protokoll, damit sich das nachsehen laesst.
 */
export function castZielIstGruppe() {
  const current = session()
  if (!current) return false
  try {
    const device = current.getCastDevice()
    const faehigkeiten = (device && device.capabilities) || []
    const ns = (window.chrome && window.chrome.cast) || {}
    const gruppe = (ns.Capability && ns.Capability.MULTIZONE_GROUP) || 'multizone_group'
    if (faehigkeiten.length) return faehigkeiten.indexOf(gruppe) >= 0
  } catch (e) {
    // Faellt unten auf "unbekannt" zurueck.
  }
  // Ohne gemeldete Faehigkeiten laesst sich nichts sagen.
  return false
}

export function stopCastSession() {
  const current = session()
  if (current) current.endSession(true)
}

// Bild fuer Chromecast-Geraete mit Bildschirm. Ohne ein Bild zeigt der
// Empfaenger bei reinem Ton nur eine leere Flaeche - und blendet nach einer
// Weile den Bildschirmschoner ein.
export const CAST_BILD = '/cast/background.png'
const CAST_BILD_BREITE = 1280
const CAST_BILD_HOEHE = 720

function absolut(pfad) {
  return new URL(pfad, location.href).toString()
}

/** Baut ein MediaInfo-Objekt inklusive Metadaten fuer den Empfaenger. */
function buildMediaInfo(track) {
  const media = window.chrome.cast.media
  const info = new media.MediaInfo(track.url, track.mimeType || 'audio/mpeg')
  if (typeof media.MusicTrackMediaMetadata === 'function') {
    const metadata = new media.MusicTrackMediaMetadata()
    metadata.title = track.subtitle || track.title
    metadata.artist = track.title
    metadata.albumName = 'Nachrichten'
    if (typeof media.Image === 'function') {
      const bild = new media.Image(absolut(CAST_BILD))
      bild.width = CAST_BILD_BREITE
      bild.height = CAST_BILD_HOEHE
      metadata.images = [bild]
    }
    info.metadata = metadata
  }
  return info
}

export function queueSupported() {
  const media = window.chrome && window.chrome.cast && window.chrome.cast.media
  // CastSession kennt kein queueLoad - die Warteschlange reist als queueData
  // in einem ganz normalen LoadRequest mit.
  return !!(media && typeof media.QueueData === 'function' && typeof media.QueueItem === 'function')
}

/**
 * Die komplette Playlist als Warteschlange an den Empfaenger uebergeben.
 *
 * Entscheidend fuer den Hintergrund: der Chromecast schaltet die Warteschlange
 * selbst weiter. Vorher musste die Senderseite bei jedem Folgenende eingreifen -
 * und genau die wird von Chrome im Hintergrund gedrosselt, weil beim Casten
 * lokal kein Ton laeuft und die Seite damit ihre Ausnahme verliert.
 */
// Ordnet jede Datei in der Warteschlange ihrer Folge zu - Ansagen zeigen auf
// die Folge, die sie ankuendigen. Damit folgt die Anzeige auch dann korrekt,
// wenn der Empfaenger selbst weiterschaltet.
//
// Gemerkt wird die id der Quelle, nicht ihre Position. Die Warteschlange
// enthaelt nur aufgeloeste Folgen, die Playlist des Players dagegen auch
// fehlerhafte und noch wartende - sobald eine davon dabei war, verschoben
// sich die Positionen gegeneinander und die Anzeige zeigte die falsche Folge.
const inhaltZuFolge = new Map()

export function folgenIdZuInhalt(contentId) {
  return inhaltZuFolge.get(contentId) || ''
}

export function castLoadQueue(tracks, startIndex = 0, abschlussUrl = '') {
  const current = session()
  if (!current) return Promise.reject(new Error('Keine Cast-Verbindung'))
  if (!chromeCastReady()) return Promise.reject(new Error('Cast-SDK ist noch nicht bereit'))
  if (!queueSupported()) return Promise.reject(new Error('Warteschlange wird nicht unterstützt'))
  if (!tracks.length) return Promise.reject(new Error('Leere Warteschlange'))

  const media = window.chrome.cast.media
  inhaltZuFolge.clear()

  const items = []
  let startEintrag = 0

  tracks.forEach((track, folgenIndex) => {
    if (folgenIndex === startIndex) startEintrag = items.length

    // Ansage vor die Folge haengen. Sie traegt bewusst dieselben Metadaten,
    // damit die Anzeige auf dem Fernseher nicht kurz umspringt.
    if (track.ansageUrl) {
      const ansage = new media.QueueItem(
        buildMediaInfo({ ...track, url: track.ansageUrl, mimeType: 'audio/wav' })
      )
      ansage.autoplay = true
      ansage.preloadTime = 3
      items.push(ansage)
      inhaltZuFolge.set(track.ansageUrl, track.id)
    }

    const eintrag = new media.QueueItem(buildMediaInfo(track))
    eintrag.autoplay = true
    // Kein Vorlauf durch den Empfaenger - die Dateien liegen beim Sender.
    eintrag.preloadTime = 5
    items.push(eintrag)
    inhaltZuFolge.set(track.url, track.id)
  })

  // Abschlussansage ans Ende. Ihre Uhrzeit setzt der Server erst beim Abruf
  // ein - bis hierher kann die Playlist eine Stunde gelaufen sein.
  if (abschlussUrl) {
    const letzter = tracks[tracks.length - 1]
    const abschluss = new media.QueueItem(
      buildMediaInfo({
        ...letzter,
        url: abschlussUrl,
        mimeType: 'audio/wav',
        title: 'Nachrichten',
        subtitle: 'Ende der Wiedergabe'
      })
    )
    abschluss.autoplay = true
    abschluss.preloadTime = 3
    items.push(abschluss)
    inhaltZuFolge.set(abschlussUrl, letzter.id)
  }

  const start = Math.max(0, Math.min(startEintrag, items.length - 1))

  // Der Empfaenger bekommt das erste Stueck als Medium und die ganze Liste als
  // queueData daneben - so schaltet er selbst weiter.
  const request = new media.LoadRequest(items[start].media)
  request.queueData = new media.QueueData()
  request.queueData.items = items
  request.queueData.startIndex = start
  if (media.RepeatMode) request.queueData.repeatMode = media.RepeatMode.OFF
  request.autoplay = true

  mediaLoaded = false
  log('cast', 'Warteschlange wird geladen', {
    eintraege: items.length,
    folgen: tracks.length,
    start
  })
  return current.loadMedia(request).then(
    (r) => {
      castState.queueActive = true
      log('cast', 'Warteschlange geladen - Empfänger schaltet selbst weiter')
      return r
    },
    (e) => {
      log('cast', 'Warteschlange fehlgeschlagen', describeCastError(e))
      throw e
    }
  )
}

export function castLoad(track, autoplay = true) {
  const current = session()
  if (!current) return Promise.reject(new Error('Keine Cast-Verbindung'))
  if (!chromeCastReady()) return Promise.reject(new Error('Cast-SDK ist noch nicht bereit'))

  const media = window.chrome.cast.media
  const request = new media.LoadRequest(buildMediaInfo(track))
  request.autoplay = autoplay
  // Neuer Track: der Merker gilt erst wieder, wenn tatsaechlich etwas laeuft.
  mediaLoaded = false
  castState.queueActive = false
  // Ohne Warteschlange gibt es nichts zuzuordnen. Die Eintraege der letzten
  // Warteschlange blieben sonst stehen und wiesen die Anzeige auf eine Folge,
  // die gar nicht mehr laeuft.
  inhaltZuFolge.clear()
  log('cast', 'Medium wird geladen', { url: String(track.url).slice(0, 80) })
  return current.loadMedia(request).then(
    (r) => {
      log('cast', 'Medium geladen')
      return r
    },
    (e) => {
      log('cast', 'Laden fehlgeschlagen', describeCastError(e))
      throw e
    }
  )
}

export function castPlayPause() {
  if (controller) controller.playOrPause()
}

export function castPause() {
  if (controller && remotePlayer && !remotePlayer.isPaused) controller.playOrPause()
}

export function castSeek(seconds) {
  if (!controller || !remotePlayer) return
  remotePlayer.currentTime = seconds
  controller.seek()
}
