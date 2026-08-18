<script setup>
import { ref } from 'vue'
import MainView from './views/MainView.vue'
import SettingsView from './views/SettingsView.vue'

const view = ref('main')
</script>

<template>
  <div class="app">
    <MainView v-if="view === 'main'" @settings="view = 'settings'" />
    <SettingsView v-else @close="view = 'main'" />
  </div>
</template>
