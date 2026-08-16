<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef, type Component } from 'vue'
import PluginListView from './views/PluginListView.vue'
import QualityGateView from './views/QualityGateView.vue'
import { resolveRoute, ROUTES } from './router'

const currentRoute = ref(resolveRoute(window.location.hash))
const currentView = shallowRef<Component>(currentRoute.value === ROUTES.quality ? QualityGateView : PluginListView)

function syncRoute() {
  currentRoute.value = resolveRoute(window.location.hash)
  currentView.value = currentRoute.value === ROUTES.quality ? QualityGateView : PluginListView
}

onMounted(() => {
  window.addEventListener('hashchange', syncRoute)
  const currentPath = window.location.hash.replace(/^#/, '').split('?')[0]
  if (currentPath !== ROUTES.plugins && currentPath !== ROUTES.quality) {
    window.location.replace(`#${ROUTES.plugins}`)
  }
})
onUnmounted(() => window.removeEventListener('hashchange', syncRoute))
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="#/plugins" aria-label="Suhan DSH Forge 首页">
        <span class="brand-mark" aria-hidden="true">S</span>
        <span>
          <strong>Suhan DSH Forge</strong>
          <small>插件管理平台</small>
        </span>
      </a>
      <nav aria-label="主导航">
        <a :class="{ 'nav-active': currentRoute === ROUTES.plugins }" href="#/plugins">插件列表</a>
        <a :class="{ 'nav-active': currentRoute === ROUTES.quality }" href="#/quality">质量门禁</a>
      </nav>
      <span class="forge-status"><i aria-hidden="true"></i> Forge 正常</span>
    </header>

    <div class="module-tabs" role="tablist" aria-label="管理模块">
      <a
        id="plugins-tab"
        :class="{ active: currentRoute === ROUTES.plugins }"
        href="#/plugins"
        role="tab"
        :aria-selected="currentRoute === ROUTES.plugins"
      >插件列表</a>
      <a
        id="quality-tab"
        :class="{ active: currentRoute === ROUTES.quality }"
        href="#/quality"
        role="tab"
        :aria-selected="currentRoute === ROUTES.quality"
      >质量门禁</a>
    </div>

    <main id="main">
      <div
        class="route-view"
        role="tabpanel"
        :aria-labelledby="currentRoute === ROUTES.quality ? 'quality-tab' : 'plugins-tab'"
      >
        <component :is="currentView" :key="currentRoute" />
      </div>
    </main>

    <footer>
      <span>Suhan DSH Forge</span>
      <p>DSH 插件管理与发布平台</p>
      <span>© 2026</span>
    </footer>

  </div>
</template>
