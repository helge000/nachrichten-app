<script setup>
import { computed, ref, watch } from 'vue'
import MainView from './views/MainView.vue'
import SettingsView from './views/SettingsView.vue'
import { player } from './lib/player.js'
import { castState } from './lib/cast.js'
import { remoteState } from './lib/remote.js'
import { updateState, applyUpdateNow } from './lib/update.js'

const view = ref('main')

// Neue Version einspielen, sobald es nicht stoert. Einspielen heisst neu laden,
// und das darf weder im Hintergrund passieren noch bei stehender Uebertragung:
// beim Casten ist player.playing bei jedem Folgenwechsel kurz false, und ein
// Neuladen mitten im Verbindungsaufbau hinterlaesst in Chrome eine Route, die
// nie mehr antwortet. Deshalb muss die Ruhe auch eine Weile anhalten.
const UPDATE_RUHE_MS = 10000

const sichtbar = ref(document.visibilityState === 'visible')
document.addEventListener('visibilitychange', () => {
  sichtbar.value = document.visibilityState === 'visible'
})

const updateStoertNicht = computed(
  () =>
    updateState.available &&
    sichtbar.value &&
    !castState.connected &&
    !castState.auswahlOffen &&
    castState.deviceState !== 'CONNECTING' &&
    !remoteState.connected &&
    !remoteState.connecting &&
    !player.playing &&
    !player.announcing &&
    !player.loading
)

let updateUhr = null
watch(
  updateStoertNicht,
  (frei) => {
    clearTimeout(updateUhr)
    updateUhr = null
    if (!frei) return
    updateUhr = setTimeout(() => {
      if (updateStoertNicht.value) applyUpdateNow()
    }, UPDATE_RUHE_MS)
  },
  { immediate: true }
)
</script>

<template>
  <div class="app">
    <MainView v-if="view === 'main'" @settings="view = 'settings'" />
    <SettingsView v-else @close="view = 'main'" />
  </div>
</template>
