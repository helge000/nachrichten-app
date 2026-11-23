import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Die Hauptseite ohne Browser pruefen: Vorlage und Stilblock aus der .vue-Datei.
// Anlass: Beim Entfernen der Merkfunktion ging die Regel .stage mit verloren,
// und der Play-Knopf rutschte aus der Mitte an den oberen Rand.
const quelle = readFileSync(new URL('../src/views/MainView.vue', import.meta.url), 'utf8')
const vorlage = quelle.slice(quelle.indexOf('<template>'), quelle.lastIndexOf('</template>'))
const stil = quelle.slice(quelle.indexOf('<style scoped>'), quelle.indexOf('</style>'))

/** Deklarationen einer Regel, deren Selektor genau so lautet. */
function regel(selektor) {
  const muster = new RegExp(`(^|\\n)\\s*${selektor.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`)
  const treffer = stil.match(muster)
  if (!treffer) return null
  const werte = {}
  for (const zeile of treffer[2].split(';')) {
    const [name, ...rest] = zeile.split(':')
    if (name.trim()) werte[name.trim()] = rest.join(':').trim()
  }
  return werte
}

test('Die Buehne zentriert ihren Inhalt waagrecht und senkrecht', () => {
  assert.match(vorlage, /<main class="stage">/)
  const stage = regel('.stage')
  assert.ok(stage, 'Regel .stage fehlt')
  assert.equal(stage.display, 'flex')
  assert.equal(stage['flex-direction'], 'column')
  assert.equal(stage['align-items'], 'center')
  assert.equal(stage['justify-content'], 'center')
  // Ohne flex: 1 ist die Buehne nur so hoch wie ihr Inhalt - dann zentriert
  // justify-content nichts, und der Knopf klebt oben.
  assert.equal(stage.flex, '1')
})

test('Die Knopfreihe mit dem Play-Knopf ist ebenfalls zentriert', () => {
  assert.match(vorlage, /<div class="playrow">[\s\S]*class="play"/)
  const reihe = regel('.playrow')
  assert.ok(reihe, 'Regel .playrow fehlt')
  assert.equal(reihe.display, 'flex')
  assert.equal(reihe['justify-content'], 'center')
  assert.equal(reihe['align-items'], 'center')
})

test('Jede Layout-Klasse der Vorlage hat eine Regel im Stilblock', () => {
  for (const klasse of ['stage', 'playrow', 'play', 'skip-btn', 'now', 'bar', 'times', 'transport']) {
    assert.match(vorlage, new RegExp(`class="[^"]*\\b${klasse}\\b`), `.${klasse} nicht in der Vorlage`)
    assert.ok(regel(`.${klasse}`), `Regel .${klasse} fehlt im Stilblock`)
  }
})
