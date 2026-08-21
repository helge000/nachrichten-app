<script setup>
import { ref } from 'vue'
import draggable from 'vuedraggable'
import {
  settings,
  addSource,
  removeSource,
  exportJson,
  importJson,
  DEFAULT_PROXY,
  DEFAULT_AUDIO_PROXY
} from '../lib/store.js'
import { invalidate } from '../lib/player.js'
import { BUILD_ID, updateState, checkForUpdate, applyUpdateNow } from '../lib/update.js'
import { castState, castDiagnostics } from '../lib/cast.js'
import { remoteState } from '../lib/remote.js'
import { logState, clearLog, logAsText } from '../lib/log.js'
import {
  syncState,
  einrichten,
  beenden,
  holen,
  sichern,
  einrichtungsLink,
  schluesselGueltig
} from '../lib/sync.js'

const schluesselEingabe = ref('')
const zeigeEingabe = ref(false)

const SYNC_TEXT = {
  aus: 'Nicht eingerichtet',
  bereit: 'Eingerichtet',
  laedt: 'Wird übertragen ...',
  gespeichert: 'Auf dem neuesten Stand',
  fehler: 'Fehler'
}

function syncStarten() {
  einrichten()
  sichern()
  flash('Sync eingerichtet - Schlüssel notieren oder Link teilen.')
}

function syncUebernehmen() {
  if (!schluesselGueltig(schluesselEingabe.value)) {
    flash('Der Schlüssel sieht nicht richtig aus.')
    return
  }
  einrichten(schluesselEingabe.value)
  schluesselEingabe.value = ''
  zeigeEingabe.value = false
  holen()
  flash('Schlüssel übernommen - Stand wird geholt.')
}

async function kopiere(text, was) {
  try {
    await navigator.clipboard.writeText(text)
    flash(was + ' kopiert.')
  } catch (e) {
    flash('Kopieren nicht möglich - bitte von Hand abschreiben.')
  }
}
import { serverStimmeVerfuegbar, sprich, ansageText } from '../lib/announce.js'
import { MIN_ANNOUNCE_RATE, MAX_ANNOUNCE_RATE, DEFAULT_ANNOUNCE_RATE } from '../lib/store.js'

const probeLaeuft = ref(false)

// Die Ansage kommt vom eigenen Server, nicht aus dem Browser. Frueher fragte
// diese Seite window.speechSynthesis - auf Geraeten ohne Browser-Stimme liess
// sich die Ansage dann nicht mehr einstellen, obwohl sie einwandfrei lief,
// und die Probe klang nach einer anderen Stimme als die spaetere Wiedergabe.
const stimmeDa = ref(true)
serverStimmeVerfuegbar().then((da) => {
  stimmeDa.value = da
})

async function ansageProbe() {
  probeLaeuft.value = true
  // Mit einem echten Beispiel hoeren, wie es spaeter klingt - ueber denselben
  // Weg und mit demselben Tempo wie die Wiedergabe.
  const gesprochen = await sprich(ansageText('Deutschlandfunk Nachrichten', Date.now()))
  if (!gesprochen) flash('Die Probe ließ sich nicht abspielen.')
  probeLaeuft.value = false
}

async function copyLog() {
  const text = logAsText()
  try {
    await navigator.clipboard.writeText(text)
    flash('Protokoll kopiert.')
  } catch (e) {
    // Ohne Zwischenablage-Rechte: als Datei anbieten.
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'nachrichten-protokoll.txt'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    flash('Protokoll als Datei gespeichert.')
  }
}

const ja = (v) => (v ? 'ja' : 'nein')

const CAST_STATE_TEXT = {
  NO_DEVICES_AVAILABLE: 'Kein Chromecast im Netz gefunden',
  NOT_CONNECTED: 'Gerät gefunden, nicht verbunden',
  CONNECTING: 'Verbindung wird aufgebaut ...',
  CONNECTED: 'Verbunden'
}

defineEmits(['close'])

const form = ref({ title: '', url: '', type: 'rss' })
const message = ref('')
const fileInput = ref(null)

function flash(text) {
  message.value = text
  setTimeout(() => {
    if (message.value === text) message.value = ''
  }, 4000)
}

function add() {
  if (!form.value.url.trim()) {
    flash('Bitte eine URL angeben.')
    return
  }
  addSource({ ...form.value })
  form.value = { title: '', url: '', type: 'rss' }
  invalidate()
  flash('Quelle hinzugefügt.')
}

function drop(id) {
  removeSource(id)
  invalidate()
}

function download() {
  const blob = new Blob([exportJson()], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `nachrichten-einstellungen-${stamp}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function upload(event) {
  const file = event.target.files && event.target.files[0]
  if (!file) return
  try {
    const count = importJson(await file.text())
    invalidate()
    flash(`${count} Quelle(n) importiert.`)
  } catch (e) {
    flash(`Import fehlgeschlagen: ${e.message || e}`)
  }
  event.target.value = ''
}
</script>

<template>
  <header class="topbar">
    <button class="icon-btn" title="Zurück" @click="$emit('close')">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 4.5L14 3l-9 9 9 9 1.5-1.5L8 12z" /></svg>
    </button>
    <h1>Einstellungen</h1>
    <span style="width: 44px"></span>
  </header>

  <div class="content">
    <section>
      <h2>Podcasts <span class="muted small">({{ settings.sources.length }})</span></h2>
      <p class="muted small">Reihenfolge per Ziehen am Griff ändern - so wird abgespielt.</p>

      <draggable
        v-model="settings.sources"
        item-key="id"
        handle=".handle"
        :animation="180"
        ghost-class="ghost"
        class="list"
      >
        <template #item="{ element }">
          <div class="row">
            <span class="handle" title="Ziehen zum Sortieren">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 6h2v2H8zm6 0h2v2h-2zM8 11h2v2H8zm6 0h2v2h-2zM8 16h2v2H8zm6 0h2v2h-2z" />
              </svg>
            </span>
            <div class="fields">
              <input v-model="element.title" placeholder="Name (z. B. Tagesschau in 100 Sekunden)" />
              <input v-model="element.url" placeholder="Feed- oder Audio-URL" inputmode="url" />
              <div class="row-options">
                <select v-model="element.type" style="width: auto">
                  <option value="rss">RSS-Feed (neueste Folge)</option>
                  <option value="audio">Direkte Audio-URL</option>
                </select>
                <label class="toggle small">
                  <input type="checkbox" v-model="element.enabled" style="width: auto" />
                  aktiv
                </label>
                <button class="btn danger small" @click="drop(element.id)">Löschen</button>
              </div>
            </div>
          </div>
        </template>
      </draggable>

      <p v-if="!settings.sources.length" class="muted small empty">Noch nichts angelegt.</p>
    </section>

    <section>
      <h2>Hinzufügen</h2>
      <div class="stack">
        <input v-model="form.title" placeholder="Name" />
        <input v-model="form.url" placeholder="https://.../feed.xml" inputmode="url" />
        <select v-model="form.type">
          <option value="rss">RSS-Feed (neueste Folge)</option>
          <option value="audio">Direkte Audio-URL</option>
        </select>
        <button class="btn primary" @click="add">Quelle hinzufügen</button>
      </div>
    </section>

    <section>
      <h2>Feed-Proxy</h2>
      <p class="muted small">
        Die meisten Nachrichten-Feeds senden keine CORS-Header und lassen sich im Browser nicht direkt
        laden. Standard ist der mitgelieferte Proxy <code>{{ DEFAULT_PROXY }}</code> (läuft mit
        <code>npm start</code>). <code>{url}</code> wird durch die Feed-URL ersetzt, sonst wird sie
        angehängt. Leer = immer direkt laden.
      </p>
      <input v-model="settings.corsProxy" :placeholder="DEFAULT_PROXY" inputmode="url" />
      <div class="buttons" style="margin-top: 10px">
        <button class="btn small" @click="settings.corsProxy = DEFAULT_PROXY">Standard</button>
        <button class="btn small" @click="settings.corsProxy = ''">Ohne Proxy</button>
      </div>
    </section>

    <section>
      <h2>Audio-Proxy</h2>
      <p class="muted small">
        Manche Podcasts (z. B. alle BBC-Feeds) liefern ihre Dateien nur über <code>http</code>.
        Läuft die App unter <code>https</code>, blockiert der Browser das als Mixed Content. Dann
        wird die Datei über <code>{{ DEFAULT_AUDIO_PROXY }}</code> geleitet - nur in diesem Fall,
        sonst lädt der Player direkt vom Sender. Leer = nie umleiten.
      </p>
      <input v-model="settings.audioProxy" :placeholder="DEFAULT_AUDIO_PROXY" inputmode="url" />
      <div class="buttons" style="margin-top: 10px">
        <button class="btn small" @click="settings.audioProxy = DEFAULT_AUDIO_PROXY">Standard</button>
        <button class="btn small" @click="settings.audioProxy = ''">Ohne Proxy</button>
      </div>
    </section>

    <section>
      <h2>Geräte-Sync</h2>

      <template v-if="!syncState.aktiv">
        <p class="muted small">
          Speichert die Quellen und Einstellungen auf dem eigenen Server, damit sie einen
          Gerätewechsel oder das Löschen der Browserdaten überstehen - und auf allen Geräten
          gleich sind. Es gibt keine Konten: ein Schlüssel genügt.
        </p>
        <div class="buttons">
          <button class="btn primary" @click="syncStarten">Sync einrichten</button>
          <button class="btn" @click="zeigeEingabe = !zeigeEingabe">Schlüssel eingeben</button>
        </div>
        <div v-if="zeigeEingabe" class="stack" style="margin-top: 10px">
          <input
            v-model="schluesselEingabe"
            placeholder="z. B. k7f2-9xqm-4bwt-p3ld"
            autocapitalize="off"
            autocomplete="off"
            spellcheck="false"
          />
          <button class="btn" @click="syncUebernehmen">Übernehmen</button>
        </div>
      </template>

      <template v-else>
        <p class="small">
          <span class="muted">Status:</span> {{ SYNC_TEXT[syncState.status] }}
          <template v-if="syncState.zuletzt">
            <span class="muted"> - zuletzt {{ syncState.zuletzt.toLocaleTimeString() }}</span>
          </template>
        </p>
        <p v-if="syncState.meldung" class="small note">{{ syncState.meldung }}</p>

        <label class="small muted" style="display: block; margin-top: 10px">Dein Schlüssel</label>
        <div class="schluessel">{{ syncState.key }}</div>
        <p class="muted small">
          Du musst ihn dir nicht merken: er bleibt auf diesem Gerät gespeichert und steckt in
          jedem JSON-Export. Für ein weiteres Gerät den Link öffnen - oder den Schlüssel dort
          unter "Schlüssel eingeben" eintragen.
        </p>
        <div class="buttons">
          <button class="btn" @click="kopiere(syncState.key, 'Schlüssel')">Schlüssel kopieren</button>
          <button class="btn" @click="kopiere(einrichtungsLink(), 'Einrichtungslink')">
            Link für zweites Gerät
          </button>
        </div>
        <div class="buttons" style="margin-top: 10px">
          <button class="btn" @click="holen">Jetzt holen</button>
          <button class="btn" @click="sichern">Jetzt sichern</button>
          <button class="btn danger" @click="beenden">Sync abschalten</button>
        </div>
      </template>
    </section>

    <section>
      <h2>Daten</h2>
      <p class="muted small">
        Alles wird automatisch im Browser gespeichert. Für Backup oder Umzug auf ein anderes Gerät:
      </p>
      <div class="buttons">
        <button class="btn" @click="download">Export (JSON)</button>
        <button class="btn" @click="fileInput.click()">Import (JSON)</button>
        <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="upload" />
      </div>
      <p v-if="message" class="small note">{{ message }}</p>
    </section>

    <section>
      <h2>Chromecast</h2>
      <p v-if="castState.available" class="muted small">
        SDK geladen - der Cast-Knopf steht oben rechts auf der Hauptseite.<br />
        Status: {{ CAST_STATE_TEXT[castState.deviceState] || castState.deviceState || 'unbekannt' }}
        <template v-if="castState.deviceName"> ({{ castState.deviceName }})</template>
      </p>
      <p v-else-if="remoteState.available" class="muted small">
        Cast-SDK nicht verfügbar, aber der Browser kann direkt an ein Gerät übergeben -
        der Knopf oben rechts nutzt diesen Weg.
      </p>
      <p v-else class="muted small">
        Nicht verfügbar, daher kein Cast-Knopf.<br />
        Grund: {{ castState.reason || 'SDK wird noch geladen ...' }}
      </p>

      <p v-if="castState.lastError" class="small err">
        Letzter Fehler: {{ castState.lastError }}
      </p>

      <details class="small" style="margin-top: 10px">
        <summary class="muted">Diagnose</summary>
        <ul class="diag muted">
          <li>Android: {{ ja(castDiagnostics.isAndroid) }}</li>
          <li>Chrome-Version: {{ castDiagnostics.chromeVersion || 'nicht erkannt' }}</li>
          <li>Presentation API: {{ ja(castDiagnostics.hasPresentationApi) }}</li>
          <li>SDK-Skript geladen: {{ ja(castDiagnostics.scriptLoaded) }}</li>
          <li>cast.framework da: {{ ja(castDiagnostics.frameworkLoaded) }}</li>
          <li>chrome.cast vollständig: {{ ja(castDiagnostics.chromeCastReady) }}</li>
          <li>Empfänger-App: {{ castDiagnostics.appId || 'noch nicht gesetzt' }}</li>
          <li>Warteschlange aktiv: {{ ja(castState.queueActive) }}</li>
          <li>Remote Playback: {{ ja(remoteState.supported) }} / Gerät: {{ ja(remoteState.available) }}</li>
        </ul>
      </details>
    </section>

    <section>
      <h2>Ansage</h2>
      <label class="toggle-row">
        <input type="checkbox" v-model="settings.announceEpisodes" style="width: auto" />
        <span>Vor jeder Folge Quelle und Zeit ansagen</span>
      </label>
      <p class="muted small">
        Zum Beispiel: <em>"Von Deutschlandfunk Nachrichten, heute um 19 Uhr."</em>
        Der Zeitpunkt stammt aus dem Feed und wird auf die Zeitzone dieses Geräts umgerechnet,
        immer im 24-Stunden-Format. Zur vollen Stunde bleiben die Minuten weg, sonst heißt es
        "19 Uhr 15". Der Tag wird relativ genannt (heute, gestern, vorgestern,
        danach Wochentag bzw. Datum).
      </p>
      <p v-if="!stimmeDa" class="muted small">
        Auf dem Server ist keine Stimme eingerichtet - die Ansage wird übersprungen.
      </p>

      <template v-else-if="settings.announceEpisodes">
        <div class="rate-row">
          <label for="rate" class="small">Tempo</label>
          <input
            id="rate"
            type="range"
            :min="MIN_ANNOUNCE_RATE"
            :max="MAX_ANNOUNCE_RATE"
            step="0.1"
            v-model.number="settings.announceRate"
            class="slider"
          />
          <span class="rate-value small">{{ settings.announceRate.toFixed(1) }}&times;</span>
        </div>
        <div class="buttons">
          <button class="btn" :disabled="probeLaeuft" @click="ansageProbe">
            {{ probeLaeuft ? 'Spricht ...' : 'Anhören' }}
          </button>
          <button class="btn" @click="settings.announceRate = DEFAULT_ANNOUNCE_RATE">Standard</button>
        </div>
      </template>
    </section>

    <section>
      <h2>Hintergrund-Wiedergabe</h2>
      <label class="toggle-row">
        <input type="checkbox" v-model="settings.preloadEpisodes" style="width: auto" />
        <span>Folgen im Voraus komplett laden</span>
      </label>
      <p class="muted small">
        Legt Android das Gerät schlafen, sind neue Netzverbindungen aus dem Hintergrund heraus
        blockiert - die nächste Folge ließe sich dann nicht mehr holen und die Wiedergabe bliebe
        stehen. Vorab geladene Folgen liegen im Speicher und brauchen kein Netz mehr.
        <br />
        Geladen werden bis zu acht Folgen im Voraus (höchstens 90 MB), über den eigenen
        Audio-Proxy - nur der liefert die nötigen CORS-Header. Ausschalten spart Datenvolumen,
        kostet aber die zuverlässige Wiedergabe bei ausgeschaltetem Bildschirm.
      </p>
    </section>

    <section>
      <h2>Protokoll <span class="muted small">({{ logState.entries.length }})</span></h2>
      <p class="muted small">
        Zeichnet auf, was im Hintergrund und beim Casten passiert - dort, wo die
        Browser-Konsole nichts zeigt. <code>[bg]</code> heißt: passierte, während die App
        im Hintergrund war.
      </p>
      <div class="buttons">
        <button class="btn" @click="copyLog">Kopieren</button>
        <button class="btn" @click="clearLog">Leeren</button>
      </div>
      <div v-if="logState.entries.length" class="logbox small">
        <div v-for="(e, i) in [...logState.entries].reverse()" :key="i" class="logline">
          <span class="muted">{{ e.time }}</span>
          <span v-if="e.hidden" class="bg">[bg]</span>
          <strong>{{ e.scope }}</strong>
          {{ e.message }}
          <span v-if="e.detail" class="muted">| {{ e.detail }}</span>
        </div>
      </div>
      <p v-else class="muted small">Noch nichts aufgezeichnet.</p>
    </section>

    <section>
      <h2>Version</h2>
      <p class="muted small">Stand {{ BUILD_ID }}</p>
      <p v-if="!updateState.supported" class="muted small">
        Kein Service Worker verfügbar - die App läuft ohne Offline-Unterstützung.
      </p>
      <div v-else class="buttons">
        <button class="btn" :disabled="updateState.checking" @click="checkForUpdate">
          {{ updateState.checking ? 'Suche ...' : 'Nach Updates suchen' }}
        </button>
        <button v-if="updateState.available" class="btn primary" @click="applyUpdateNow">
          Jetzt aktualisieren
        </button>
      </div>
      <p v-if="updateState.available" class="small note">
        Neue Version bereit - sie wird eingespielt, sobald nichts mehr läuft.
      </p>
    </section>
  </div>
</template>

<style scoped>
section { margin-top: 24px; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 6px; }

.list { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }

.row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 12px;
}
.ghost { opacity: 0.4; }

.handle {
  display: grid;
  place-items: center;
  min-width: 32px;
  height: 40px;
  color: var(--muted);
  cursor: grab;
  touch-action: none;
}

.fields { flex: 1; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.row-options { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.row-options .btn { margin-left: auto; padding: 8px 12px; }

.toggle { display: flex; align-items: center; gap: 6px; color: var(--muted); }
.toggle-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.rate-row { display: flex; align-items: center; gap: 12px; margin: 12px 0 10px; }
.rate-row label { min-width: 46px; color: var(--muted); }
.slider { flex: 1; width: auto; padding: 0; background: none; border: none; accent-color: var(--accent); }
.rate-value {
  min-width: 40px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

.stack { display: flex; flex-direction: column; gap: 10px; }
.buttons { display: flex; flex-wrap: wrap; gap: 10px; }
.empty { margin-top: 12px; }
.note { color: var(--accent); }
.schluessel {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 19px;
  letter-spacing: 0.08em;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 14px;
  margin: 6px 0 8px;
  user-select: all;
  word-break: break-all;
}
.diag { margin: 8px 0 0; padding-left: 18px; }
.diag li { margin: 2px 0; }
.err { color: var(--danger); }
.logbox {
  margin-top: 10px;
  max-height: 260px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px;
}
.logline {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  padding: 2px 0;
  border-bottom: 1px solid var(--border);
  word-break: break-word;
}
.logline:last-child { border-bottom: none; }
.bg { color: var(--accent); }
code { background: var(--surface-2); padding: 1px 5px; border-radius: 5px; }
</style>
