import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quellenAnlegen, ruhe } from './umgebung.mjs'

// Nachgebautes Cast-SDK: nur, was cast.js beim Start und bei einer Sitzung anfasst.
const kontextHoerer = {}
const geladen = []
let mediaSession = null

const sitzung = {
  getCastDevice: () => ({ friendlyName: 'Küche', label: 'k1', capabilities: [] }),
  getMediaSession: () => mediaSession,
  loadMedia: (request) => {
    geladen.push(request)
    return Promise.resolve()
  },
  endSession() {}
}

const kontext = {
  setOptions() {},
  addEventListener: (typ, fn) => {
    kontextHoerer[typ] = fn
  },
  getCastState: () => 'NOT_CONNECTED',
  getCurrentSession: () => sitzung,
  requestSession: () => Promise.resolve()
}

class Platzhalter {
  constructor(...args) {
    this.args = args
  }
}

globalThis.cast = {
  framework: {
    CastContext: { getInstance: () => kontext },
    CastContextEventType: { CAST_STATE_CHANGED: 'caststate', SESSION_STATE_CHANGED: 'sessionstate' },
    RemotePlayerEventType: {
      CURRENT_TIME_CHANGED: 'a',
      DURATION_CHANGED: 'b',
      MEDIA_INFO_CHANGED: 'c',
      PLAYER_STATE_CHANGED: 'd'
    },
    RemotePlayer: class {},
    RemotePlayerController: class {
      addEventListener() {}
    }
  }
}
globalThis.chrome = {
  cast: {
    AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' },
    media: {
      MediaInfo: Platzhalter,
      LoadRequest: class extends Platzhalter {
        constructor(media) {
          super(media)
          this.media = media
        }
      },
      QueueData: Platzhalter,
      QueueItem: class extends Platzhalter {
        constructor(media) {
          super(media)
          this.media = media
        }
      },
      MusicTrackMediaMetadata: Platzhalter,
      Image: Platzhalter
    }
  }
}

quellenAnlegen(2)
const { player } = await import('../src/lib/player.js')
const { setupCast, castState } = await import('../src/lib/cast.js')
setupCast()

test('Beim Oeffnen uebernommene, ruhende Sitzung spielt nicht von selbst los', async () => {
  // Der Empfaenger ist vom letzten Mal noch geladen, spielt aber nichts.
  mediaSession = { media: { contentId: '' }, playerState: 'IDLE', items: [] }
  kontextHoerer.sessionstate({ sessionState: 'SESSION_RESUMED' })
  await ruhe()

  assert.equal(castState.connected, true)
  assert.equal(castState.deviceName, 'Küche')
  assert.equal(geladen.length, 0, 'nichts an den Lautsprecher geschickt')
  assert.equal(player.index, -1, 'keine Playlist gestartet')
})

test('Play bei uebernommener Sitzung schickt die Folgen an den Lautsprecher', async () => {
  const { play } = await import('../src/lib/player.js')
  await play()
  await ruhe()
  assert.equal(geladen.length, 1)
  assert.equal(geladen[0].queueData.items.length, 3, 'Stille vorweg + zwei Folgen')
})

test('Selbst aufgebaute Verbindung ohne Wiedergabe startet die Playlist', async () => {
  kontextHoerer.sessionstate({ sessionState: 'SESSION_ENDED' })
  const { stop } = await import('../src/lib/player.js')
  stop()
  geladen.length = 0

  kontextHoerer.sessionstate({ sessionState: 'SESSION_STARTED' })
  await ruhe()
  await ruhe()
  assert.equal(geladen.length, 1, 'Tipp auf Cast heisst: hier abspielen')
})
