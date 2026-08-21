<script setup>
import { computed } from 'vue'
import { player, current, warmup, toggle, next, previous, seek, skip, refresh, SKIP_SECONDS } from '../lib/player.js'
import { castState, requestCastSession, stopCastSession, describeCastError } from '../lib/cast.js'
import { remoteState, promptRemotePlayback } from '../lib/remote.js'
import { log } from '../lib/log.js'
import { activeSources } from '../lib/store.js'

defineEmits(['settings'])

const hasConfigured = computed(() => activeSources().length > 0)
const isActive = computed(() => player.index !== -1 && !player.ended)
const progress = computed(() => (player.duration > 0 ? (player.position / player.duration) * 100 : 0))
const remaining = computed(() => player.items.filter((_, i) => i > player.index).length)

function reload() {
  log('player', 'Neu laden angestossen')
  refresh()
}

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`
}

function scrub(event) {
  if (!player.duration) return
  const rect = event.currentTarget.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  seek(ratio * player.duration)
}

// Knopf anbieten, sobald einer der beiden Wege da ist.
const canCast = computed(() => castState.available || remoteState.available)
const castConnected = computed(() => castState.connected || remoteState.connected)
const castTarget = computed(() => {
  if (castState.connected) return castState.deviceName || 'Chromecast'
  if (remoteState.connected) return 'Chromecast'
  return ''
})

function castFailed(e) {
  const text = describeCastError(e)
  // Fehler nicht mehr verschlucken - sonst steht man vor "error connecting
  // device" ohne jede Information.
  log('cast', 'Verbindung gescheitert', text)
  castState.lastError = text
  if (text !== 'Auswahl abgebrochen' && !/cancel/i.test(text)) {
    player.error = `Chromecast: ${text}`
  }
}

function toggleCast() {
  if (castState.connected) {
    stopCastSession()
    return
  }
  player.error = ''
  // Cast-SDK bevorzugen, es kann mehr (Warteschlange, Geraetename).
  if (castState.available) {
    requestCastSession().catch((e) => {
      castFailed(e)
      // Zweite Chance ueber den Browser-eigenen Weg, falls vorhanden.
      if (remoteState.available) {
        log('cast', 'Faellt auf Remote Playback zurueck')
        promptRemotePlayback().catch(castFailed)
      }
    })
    return
  }
  promptRemotePlayback().catch(castFailed)
}
</script>

<template>
  <header class="topbar">
    <h1>Nachrichten</h1>
    <div style="display: flex; gap: 4px">
      <button
        class="icon-btn"
        :class="{ spinning: player.loading }"
        title="Neueste Folgen holen"
        @click="reload"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M17.65 6.35A7.96 7.96 0 0012 4a8 8 0 108 8h-2a6 6 0 11-6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
        </svg>
      </button>
      <button
        v-if="canCast"
        class="icon-btn"
        :class="{ active: castConnected }"
        :title="castConnected ? `Verbunden mit ${castTarget}` : 'Auf Chromecast abspielen'"
        @click="toggleCast"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zM21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>
        </svg>
      </button>
      <button class="icon-btn" title="Einstellungen" @click="$emit('settings')">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M19.14 12.94a7.5 7.5 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96a7.3 7.3 0 00-1.63-.94l-.36-2.54a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.49.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 00-.6.22L2.66 8.84a.5.5 0 00.12.64l2.03 1.58a7.5 7.5 0 000 1.88l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.04.24.25.42.49.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z"/>
        </svg>
      </button>
    </div>
  </header>

  <main class="stage">
    <div class="playrow">
      <button
        class="skip-btn"
        :disabled="!isActive"
        :title="`${SKIP_SECONDS} Sekunden zurueck`"
        @click="skip(-SKIP_SECONDS)"
      >
        <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12.5 5V1.5L8 6l4.5 4.5V7a5.5 5.5 0 11-5.5 5.5H5a7.5 7.5 0 107.5-7.5z" />
        </svg>
        <span class="skip-num">{{ SKIP_SECONDS }}</span>
      </button>

      <button
        class="play"
        :class="{ warmup }"
        :disabled="player.loading"
        :title="warmup ? 'Laeuft an ...' : ''"
        @click="toggle"
      >
        <svg v-if="player.playing" width="64" height="64" viewBox="0 0 24 24" fill="currentColor">
          <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
        </svg>
        <svg v-else width="64" height="64" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5.5v13l11-6.5z" />
        </svg>
      </button>

      <button
        class="skip-btn"
        :disabled="!isActive"
        :title="`${SKIP_SECONDS} Sekunden vor`"
        @click="skip(SKIP_SECONDS)"
      >
        <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M11.5 5V1.5L16 6l-4.5 4.5V7A5.5 5.5 0 1017 12.5h2A7.5 7.5 0 1111.5 5z" />
        </svg>
        <span class="skip-num">{{ SKIP_SECONDS }}</span>
      </button>
    </div>

    <p v-if="!hasConfigured" class="muted status">
      Noch keine Podcasts angelegt.<br />
      <button class="btn" style="margin-top: 12px" @click="$emit('settings')">Quellen einrichten</button>
    </p>

    <template v-else-if="isActive && current">
      <div class="now">
        <div class="now-title">{{ current.title }}</div>
        <div class="now-sub muted small">{{ current.subtitle || 'Neueste Folge' }}</div>
      </div>

      <div class="bar" @click="scrub">
        <div class="bar-fill" :style="{ width: progress + '%' }"></div>
      </div>
      <div class="times muted small">
        <span>{{ fmt(player.position) }}</span>
        <span v-if="remaining > 0">noch {{ remaining }} in der Liste</span>
        <span>{{ fmt(player.duration) }}</span>
      </div>

      <div class="transport">
        <button class="icon-btn" title="Zurueck" @click="previous">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6L18 6v12z" /></svg>
        </button>
        <button class="icon-btn" title="Weiter" @click="next">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z" /></svg>
        </button>
      </div>
    </template>

    <p v-else class="muted status">
      {{ player.ended ? 'Alle Folgen abgespielt.' : 'Play druecken - die neuesten Folgen laufen der Reihe nach.' }}
      <br />
      <button v-if="player.ended" class="btn" style="margin-top: 12px" @click="refresh">Neu laden</button>
    </p>

    <p v-if="player.error" class="error small">{{ player.error }}</p>
    <p v-if="castConnected" class="muted small">Laeuft auf {{ castTarget }}</p>
  </main>
</template>

<style scoped>
.stage {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 24px 20px calc(32px + env(safe-area-inset-bottom));
  text-align: center;
}

/*
 * Die drei Knoepfe nebeneinander, in fester Groesse - aber nur, solange sie
 * nebeneinander passen.
 *
 * Volle Groesse braucht 84% der Fensterbreite, die Polsterung der Buehne
 * kommt noch dazu; auf einem Telefon reicht das nicht. Deshalb sind die
 * Groessen nach oben gedeckelt und darunter an die Fensterbreite gebunden -
 * dann schrumpfen alle drei gemeinsam und das Verhaeltnis bleibt gewahrt.
 * Ab rund 520 px Fensterbreite stehen sie in voller Groesse.
 */
.playrow {
  --skip-size: min(120px, 23vw);
  --play-size: min(168px, 35vw);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: min(14px, 1.5vw);
}

.skip-btn {
  position: relative;
  display: grid;
  place-items: center;
  width: var(--skip-size);
  height: var(--skip-size);
  /* Die Zahl im Bogen haengt an der Knopfgroesse, damit sie mitwaechst. */
  font-size: calc(var(--skip-size) / 6);
  border-radius: 50%;
  color: var(--muted);
  transition: transform 0.12s ease, color 0.12s ease;
}
/* Groesse aus dem CSS statt aus den Attributen - sonst waechst nur der Kreis. */
.skip-btn svg { width: 50%; height: 50%; }
.skip-btn:hover:not(:disabled) { background: var(--surface); color: var(--text); }
.skip-btn:active:not(:disabled) { transform: scale(0.92); }
.skip-btn:disabled { opacity: 0.3; cursor: default; }

/* Die Zahl sitzt im Bogen des Pfeils. */
.skip-num {
  position: absolute;
  top: 54%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 1em;
  font-weight: 700;
  letter-spacing: -0.02em;
  pointer-events: none;
}

.spinning svg { animation: spin 0.9s linear infinite; }

.play {
  position: relative;
  width: var(--play-size);
  height: var(--play-size);
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  display: grid;
  place-items: center;
  box-shadow: 0 12px 40px rgba(76, 141, 255, 0.35);
  transition: transform 0.12s ease;
}
.play svg { width: 38%; height: 38%; }
.play:active { transform: scale(0.96); }
/* Waehrend des Anlaufs nicht ausgrauen - der Ring sagt schon, dass etwas laeuft. */
.play:disabled { cursor: default; }
.play:disabled:not(.warmup) { opacity: 0.6; }

/*
 * Anlauf-Ring: ein Bogen, der um den Knopf kreist, dazu ein ruhiges Atmen des
 * Schattens. Der Knopf behaelt dabei sein Symbol - fruehe Fassungen ersetzten
 * es durch einen Spinner, dann sprang die Anzeige bei jedem Puffern.
 */
.play.warmup::before {
  content: '';
  position: absolute;
  inset: calc(var(--play-size) * -0.07);
  border-radius: 50%;
  background: conic-gradient(from 0turn, transparent 0 58%, var(--accent) 78%, transparent 100%);
  /* Nur der Rand bleibt stehen - die Mitte wird ausgestanzt. */
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px));
  animation: warmup-ring 1.1s linear infinite;
  pointer-events: none;
}

.play.warmup { animation: warmup-atmen 1.8s ease-in-out infinite; }

@keyframes warmup-ring { to { transform: rotate(360deg); } }
@keyframes warmup-atmen {
  0%, 100% { box-shadow: 0 12px 40px rgba(76, 141, 255, 0.35); }
  50% { box-shadow: 0 12px 40px rgba(76, 141, 255, 0.6), 0 0 0 8px rgba(76, 141, 255, 0.08); }
}

/* Wer Bewegung abgestellt hat, bekommt den Ring ruhig stehend. */
@media (prefers-reduced-motion: reduce) {
  .play.warmup::before,
  .play.warmup { animation: none; }
  .play.warmup::before { background: conic-gradient(from 0turn, transparent 0 58%, var(--accent) 78%, transparent 100%); }
}

@keyframes spin { to { transform: rotate(360deg); } }

.status { max-width: 320px; margin: 0; }

.now { max-width: 340px; }
.now-title { font-size: 19px; font-weight: 600; }
.now-sub { margin-top: 4px; }

.bar {
  width: min(340px, 100%);
  height: 6px;
  border-radius: 999px;
  background: var(--surface-2);
  cursor: pointer;
}
.bar-fill { height: 100%; border-radius: 999px; background: var(--accent); transition: width 0.2s linear; }

.times { width: min(340px, 100%); display: flex; justify-content: space-between; gap: 12px; margin: -8px 0 0; }

.transport { display: flex; gap: 12px; }

.error { color: var(--danger); max-width: 340px; }
</style>
