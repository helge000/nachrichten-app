<script setup>
import { ref, watch } from 'vue'
import MainView from './views/MainView.vue'
import SettingsView from './views/SettingsView.vue'
import { player } from './lib/player.js'
import { updateState, applyUpdateNow } from './lib/update.js'

const view = ref('main')

// Neue Version einspielen, sobald es nicht stoert - also nicht mitten in einer
// laufenden Folge. Laeuft gerade etwas, wartet das Update bis zur Pause.
watch(
  () => [updateState.available, player.playing],
  ([available, playing]) => {
    if (available && !playing) applyUpdateNow()
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
