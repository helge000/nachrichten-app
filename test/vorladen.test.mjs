import { test } from 'node:test'
import assert from 'node:assert/strict'
import { audios, downloads, quellenAnlegen, ruhe, sichtbarkeit } from './umgebung.mjs'

quellenAnlegen(6)
const { player, play, PREFETCH_PARALLEL } = await import('../src/lib/player.js')
const audio = audios[0]

function geladeneFolge(d) {
  return decodeURIComponent(d.url).match(/folge(\d+)/)[1]
}

test('Play laedt sofort mehrere Folgen parallel - aber nicht die laufende', async () => {
  await play()
  await ruhe()

  assert.equal(player.index, 0)
  assert.equal(audio.src, 'https://cdn.test/folge0.mp3', 'Folge 0 streamt aus dem Netz')
  assert.equal(downloads.length, PREFETCH_PARALLEL)
  assert.deepEqual(downloads.map(geladeneFolge), ['1', '2', '3'])
})

test('Ein fertiger Download macht Platz fuer den naechsten', async () => {
  downloads[0].fertig()
  await ruhe()
  assert.equal(downloads.length, PREFETCH_PARALLEL + 1)
  assert.equal(geladeneFolge(downloads[3]), '4')
  assert.ok(player.items[1].blobUrl.startsWith('blob:'))
})

test('Folgenwechsel nach "ended" spielt den Blob - synchron, ohne await', async () => {
  const vorher = audio.verlauf.length
  audio.ausloesen('ended')
  // Kein ruhe() dazwischen: play() muss schon im Ereignis selbst gelaufen sein.
  const neu = audio.verlauf.slice(vorher)
  assert.deepEqual(neu.at(-1), ['play', player.items[1].blobUrl])
  assert.equal(player.index, 1)
})

test('Fehlgeschlagene Downloads werden beim Zurueckkommen erneut versucht', async () => {
  sichtbarkeit('hidden')
  downloads[1].fehler()
  downloads[2].fehler()
  await ruhe()
  assert.equal(player.items[2].preloadFailed, true)
  assert.equal(player.items[3].preloadFailed, true)

  const vorher = downloads.length
  sichtbarkeit('visible')
  await ruhe()
  const nachgeholt = downloads.slice(vorher).map(geladeneFolge)
  // Zwei Plaetze sind noch belegt (Folgen 4 und 5) - der freie geht an Folge 2,
  // Folge 3 ist wieder freigegeben und kommt, sobald ein Platz frei wird.
  assert.deepEqual(nachgeholt, ['2'])
  assert.equal(player.items[3].preloadFailed, false)
  downloads.find((d) => geladeneFolge(d) === '4').fertig()
  await ruhe()
  assert.equal(geladeneFolge(downloads.at(-1)), '3')
})

// Offene Downloads abschliessen, sonst haelt der Protokoll-Takt den Prozess
// wach. Als eigener Test, nicht als after(): das laeuft unter Node 18 erst,
// wenn die Ereignisschleife leer ist - und die wartet hier auf die Downloads.
test('Aufraeumen: alle Downloads abschliessen', async () => {
  // Jeder fertige Download stoesst den naechsten an - so lange, bis keiner mehr kommt.
  for (let erledigt = 0; erledigt < downloads.length; erledigt++) {
    downloads[erledigt].fertig()
    await ruhe()
  }
  assert.ok(player.items.every((i) => !i.downloading))
})
