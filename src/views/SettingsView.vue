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

const ja = (v) => (v ? 'ja' : 'nein')

const CAST_STATE_TEXT = {
  NO_DEVICES_AVAILABLE: 'Kein Chromecast im Netz gefunden',
  NOT_CONNECTED: 'Geraet gefunden, nicht verbunden',
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
  flash('Quelle hinzugefuegt.')
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
    <button class="icon-btn" title="Zurueck" @click="$emit('close')">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 4.5L14 3l-9 9 9 9 1.5-1.5L8 12z" /></svg>
    </button>
    <h1>Einstellungen</h1>
    <span style="width: 44px"></span>
  </header>

  <div class="content">
    <section>
      <h2>Podcasts <span class="muted small">({{ settings.sources.length }})</span></h2>
      <p class="muted small">Reihenfolge per Ziehen am Griff aendern - so wird abgespielt.</p>

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
                <button class="btn danger small" @click="drop(element.id)">Loeschen</button>
              </div>
            </div>
          </div>
        </template>
      </draggable>

      <p v-if="!settings.sources.length" class="muted small empty">Noch nichts angelegt.</p>
    </section>

    <section>
      <h2>Hinzufuegen</h2>
      <div class="stack">
        <input v-model="form.title" placeholder="Name" />
        <input v-model="form.url" placeholder="https://.../feed.xml" inputmode="url" />
        <select v-model="form.type">
          <option value="rss">RSS-Feed (neueste Folge)</option>
          <option value="audio">Direkte Audio-URL</option>
        </select>
        <button class="btn primary" @click="add">Quelle hinzufuegen</button>
      </div>
    </section>

    <section>
      <h2>Feed-Proxy</h2>
      <p class="muted small">
        Die meisten Nachrichten-Feeds senden keine CORS-Header und lassen sich im Browser nicht direkt
        laden. Standard ist der mitgelieferte Proxy <code>{{ DEFAULT_PROXY }}</code> (laeuft mit
        <code>npm start</code>). <code>{url}</code> wird durch die Feed-URL ersetzt, sonst wird sie
        angehaengt. Leer = immer direkt laden.
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
        Manche Podcasts (z. B. alle BBC-Feeds) liefern ihre Dateien nur ueber <code>http</code>.
        Laeuft die App unter <code>https</code>, blockiert der Browser das als Mixed Content. Dann
        wird die Datei ueber <code>{{ DEFAULT_AUDIO_PROXY }}</code> geleitet - nur in diesem Fall,
        sonst laedt der Player direkt vom Sender. Leer = nie umleiten.
      </p>
      <input v-model="settings.audioProxy" :placeholder="DEFAULT_AUDIO_PROXY" inputmode="url" />
      <div class="buttons" style="margin-top: 10px">
        <button class="btn small" @click="settings.audioProxy = DEFAULT_AUDIO_PROXY">Standard</button>
        <button class="btn small" @click="settings.audioProxy = ''">Ohne Proxy</button>
      </div>
    </section>

    <section>
      <h2>Daten</h2>
      <p class="muted small">
        Alles wird automatisch im Browser gespeichert. Fuer Backup oder Umzug auf ein anderes Geraet:
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
        Cast-SDK nicht verfuegbar, aber der Browser kann direkt an ein Geraet uebergeben -
        der Knopf oben rechts nutzt diesen Weg.
      </p>
      <p v-else class="muted small">
        Nicht verfuegbar, daher kein Cast-Knopf.<br />
        Grund: {{ castState.reason || 'SDK wird noch geladen ...' }}
      </p>

      <details class="small" style="margin-top: 10px">
        <summary class="muted">Diagnose</summary>
        <ul class="diag muted">
          <li>Android: {{ ja(castDiagnostics.isAndroid) }}</li>
          <li>Chrome-Version: {{ castDiagnostics.chromeVersion || 'nicht erkannt' }}</li>
          <li>Presentation API: {{ ja(castDiagnostics.hasPresentationApi) }}</li>
          <li>SDK-Skript geladen: {{ ja(castDiagnostics.scriptLoaded) }}</li>
          <li>cast.framework da: {{ ja(castDiagnostics.frameworkLoaded) }}</li>
          <li>Remote Playback: {{ ja(remoteState.supported) }} / Geraet: {{ ja(remoteState.available) }}</li>
        </ul>
      </details>
    </section>

    <section>
      <h2>Version</h2>
      <p class="muted small">Stand {{ BUILD_ID }}</p>
      <p v-if="!updateState.supported" class="muted small">
        Kein Service Worker verfuegbar - die App laeuft ohne Offline-Unterstuetzung.
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
        Neue Version bereit - sie wird eingespielt, sobald nichts mehr laeuft.
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

.stack { display: flex; flex-direction: column; gap: 10px; }
.buttons { display: flex; flex-wrap: wrap; gap: 10px; }
.empty { margin-top: 12px; }
.note { color: var(--accent); }
.diag { margin: 8px 0 0; padding-left: 18px; }
.diag li { margin: 2px 0; }
code { background: var(--surface-2); padding: 1px 5px; border-radius: 5px; }
</style>
