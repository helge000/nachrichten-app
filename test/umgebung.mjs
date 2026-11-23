// Nachgebaute Browser-Umgebung fuer die Node-Tests: gerade so viel, dass
// player.js und cast.js laden und sich beobachten lassen. Muss vor diesen
// Modulen importiert werden.

class Speicher {
  constructor() {
    this.daten = new Map()
  }
  getItem(k) {
    return this.daten.has(k) ? this.daten.get(k) : null
  }
  setItem(k, v) {
    this.daten.set(k, String(v))
  }
  removeItem(k) {
    this.daten.delete(k)
  }
}

function ereignisZiel(ziel) {
  const hoerer = new Map()
  ziel.addEventListener = (typ, fn, opt) => {
    if (!hoerer.has(typ)) hoerer.set(typ, [])
    hoerer.get(typ).push({ fn, einmal: !!(opt && opt.once) })
  }
  ziel.removeEventListener = (typ, fn) => {
    hoerer.set(typ, (hoerer.get(typ) || []).filter((h) => h.fn !== fn))
  }
  ziel.ausloesen = (typ, daten = {}) => {
    for (const h of [...(hoerer.get(typ) || [])]) {
      if (h.einmal) ziel.removeEventListener(typ, h.fn)
      h.fn({ type: typ, ...daten })
    }
  }
  return ziel
}

// Jedes Audio-Element merkt sich, was mit ihm geschah.
export const audios = []

class FakeAudio {
  constructor() {
    ereignisZiel(this)
    this._src = ''
    this.paused = true
    this.muted = false
    this.currentTime = 0
    this.duration = NaN
    this.playbackRate = 1
    this.verlauf = []
    audios.push(this)
  }
  get src() {
    return this._src
  }
  set src(wert) {
    this._src = wert
    this.verlauf.push(['src', wert])
  }
  getAttribute(name) {
    return name === 'src' && this._src ? this._src : null
  }
  removeAttribute(name) {
    if (name === 'src') this._src = ''
  }
  load() {}
  play() {
    this.paused = false
    this.verlauf.push(['play', this._src])
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
}

export const dokument = ereignisZiel({
  visibilityState: 'visible',
  head: { appendChild() {} },
  // Vue fragt beim Laden nach einem template-Element.
  createElement: () => ({ setAttribute() {}, style: {} })
})

export function sichtbarkeit(zustand) {
  dokument.visibilityState = zustand
  dokument.ausloesen('visibilitychange')
}

// Downloads haengen, bis der Test sie aufloest - so laesst sich zaehlen, wie
// viele gleichzeitig laufen.
export const downloads = []

globalThis.fetch = (url) =>
  new Promise((aufloesen, ablehnen) => {
    downloads.push({
      url: String(url),
      fertig(bytes = 1000) {
        aufloesen({ ok: true, status: 200, blob: async () => ({ size: bytes }) })
      },
      fehler(grund = 'Netz weg') {
        ablehnen(new Error(grund))
      }
    })
  })

let blobNr = 0
URL.createObjectURL = () => `blob:test/${++blobNr}`
URL.revokeObjectURL = () => {}

// Das Protokoll schreibt jede Zeile auch in die Konsole - im Test nur Laerm.
console.info = () => {}

globalThis.localStorage = new Speicher()
globalThis.sessionStorage = new Speicher()
globalThis.Audio = FakeAudio
globalThis.document = dokument
globalThis.location = new URL('https://nachrichten.test/')
globalThis.window = globalThis
// In Node 21+ ist navigator schreibgeschuetzt vorhanden - dann ueberschreiben.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Node-Test Chrome/150', presentation: {} },
  configurable: true,
  writable: true
})

/** Quellen als feste Audio-URLs: kein Feed, kein XML-Parser noetig. */
export function quellenAnlegen(anzahl) {
  const sources = Array.from({ length: anzahl }, (_, i) => ({
    id: `q${i}`,
    title: `Quelle ${i}`,
    url: `https://cdn.test/folge${i}.mp3`,
    type: 'audio',
    enabled: true
  }))
  localStorage.setItem(
    'nachrichten-app.v1',
    JSON.stringify({ version: 1, sources, announceEpisodes: false, announceEnd: false })
  )
}

/** Alle anstehenden Promise-Ketten durchlaufen lassen. */
export function ruhe() {
  return new Promise((r) => setTimeout(r, 0))
}
