import { reactive } from 'vue'

const MAX_ENTRIES = 200
const KEY = 'nachrichten-app.log'

/**
 * Protokoll, das auf dem Geraet selbst sichtbar ist.
 *
 * Auf Android laesst sich die Konsole nur per USB-Debugging auslesen, und
 * Fehler aus dem Hintergrund oder aus dem Cast-SDK gehen dabei oft verloren.
 * Deshalb landen sie hier - sichtbar unter Einstellungen -> Protokoll und
 * per Knopfdruck kopierbar.
 */
export const logState = reactive({
  entries: [],
  enabled: true
})

function persist() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(logState.entries.slice(-MAX_ENTRIES)))
  } catch (e) {
    // Speicher voll oder gesperrt - das Protokoll ist dann nur fluechtig.
  }
}

function restore() {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (raw) logState.entries = JSON.parse(raw)
  } catch (e) {
    logState.entries = []
  }
}
restore()

function stamp() {
  const d = new Date()
  const p = (n, l = 2) => String(n).padStart(l, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function shorten(value) {
  if (value instanceof Error) return value.message || String(value)
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch (e) {
    return String(value)
  }
}

export function log(scope, message, detail) {
  if (!logState.enabled) return
  const entry = {
    time: stamp(),
    scope,
    message,
    detail: detail === undefined ? '' : shorten(detail),
    // Im Hintergrund passieren die interessanten Dinge - Zustand mitschreiben.
    hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }
  logState.entries.push(entry)
  if (logState.entries.length > MAX_ENTRIES) logState.entries.splice(0, logState.entries.length - MAX_ENTRIES)
  persist()
  console.info(`[${entry.scope}] ${entry.message}`, detail === undefined ? '' : detail)
}

export function clearLog() {
  logState.entries = []
  persist()
}

export function logAsText() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const head = `Nachrichten-Protokoll\n${new Date().toISOString()}\n${ua}\n\n`
  return (
    head +
    logState.entries
      .map((e) => `${e.time} ${e.hidden ? '[bg] ' : ''}${e.scope}: ${e.message}${e.detail ? ' | ' + e.detail : ''}`)
      .join('\n')
  )
}

/** Faengt auch Fehler ein, die sonst nur in der Konsole landen wuerden. */
export function captureGlobalErrors() {
  window.addEventListener('error', (event) => {
    log('fehler', event.message || 'Unbekannter Fehler', {
      quelle: `${event.filename || '?'}:${event.lineno || 0}`
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    log('fehler', 'Nicht behandelte Promise-Ablehnung', shorten(reason && reason.message ? reason.message : reason))
  })
}
