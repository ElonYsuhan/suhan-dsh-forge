<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import plugins from 'virtual:dsh-plugins'
import { categoryLabels, filterPlugins, permissionCount } from './catalog'
import type { PluginListing } from './types'

const query = ref('')
const searchInput = ref<HTMLInputElement>()
const activeCategory = ref('all')
const selectedPlugin = shallowRef<PluginListing>()
const dialog = ref<HTMLDialogElement>()
const closeButton = ref<HTMLButtonElement>()
const lastTrigger = shallowRef<HTMLElement>()
const copied = ref(false)

const categories = computed(() => [...new Set(plugins.flatMap(plugin => plugin.categories))])
const visiblePlugins = computed(() => filterPlugins(plugins, query.value, activeCategory.value))
const permissionTotal = computed(() => plugins.reduce((total, plugin) => total + permissionCount(plugin), 0))
const testedTotal = computed(() => plugins.filter(plugin => plugin.quality.unitTests && plugin.quality.contractTests).length)

function openPlugin(plugin: PluginListing, event: MouseEvent) {
  selectedPlugin.value = plugin
  lastTrigger.value = event.currentTarget as HTMLElement
  copied.value = false
  void nextTick(() => {
    dialog.value?.showModal()
    closeButton.value?.focus()
  })
}

function closePlugin() {
  dialog.value?.close()
}

function onDialogClose() {
  selectedPlugin.value = undefined
  lastTrigger.value?.focus()
}

async function copyInstallCommand(plugin: PluginListing) {
  await navigator.clipboard.writeText(`dsh plugin --profile web add ${plugin.packageName}`)
  copied.value = true
}

function qualityCount(plugin: PluginListing) {
  return Object.values(plugin.quality).filter(Boolean).length
}

function focusSearch(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    searchInput.value?.focus()
  }
}

onMounted(() => window.addEventListener('keydown', focusSearch))
onUnmounted(() => window.removeEventListener('keydown', focusSearch))
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="#main" aria-label="Suhan DSH Forge 首页">
        <span class="brand-mark" aria-hidden="true">S</span>
        <span>
          <strong>Suhan DSH Forge</strong>
          <small>插件管理平台</small>
        </span>
      </a>
      <nav aria-label="主导航">
        <a class="nav-active" href="#plugins">插件列表</a>
        <a href="#standards">质量门禁</a>
      </nav>
      <span class="forge-status"><i aria-hidden="true"></i> Forge 正常</span>
    </header>

    <main id="main">
      <section class="page-head" aria-labelledby="page-title">
        <div>
          <p class="eyebrow">DEEPSEEK HARNESS · 插件管理</p>
          <h1 id="page-title">插件管理平台</h1>
          <p class="lead">统一查看、筛选和安装经过 Forge 门禁的 DSH 插件。</p>
        </div>
        <a class="primary-link" href="#plugins">浏览插件</a>
      </section>

      <section class="metrics" aria-label="平台概览">
        <div><strong>{{ plugins.length.toString().padStart(2, '0') }}</strong><span>在库插件</span></div>
        <div><strong>{{ testedTotal.toString().padStart(2, '0') }}</strong><span>通过核心测试</span></div>
        <div><strong>{{ permissionTotal.toString().padStart(2, '0') }}</strong><span>透明能力声明</span></div>
        <div><strong>RC.6</strong><span>DSH 基准版本</span></div>
      </section>

      <section id="plugins" class="catalog" aria-labelledby="catalog-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">PLUGIN CATALOG</p>
            <h2 id="catalog-title">插件列表</h2>
          </div>
          <p>展示已通过结构校验、类型检查、自动测试与安装冒烟门禁的插件。</p>
        </div>

        <div class="catalog-tools">
          <label class="search-box">
            <span class="sr-only">搜索插件</span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
            <input ref="searchInput" v-model="query" type="search" aria-label="搜索插件" placeholder="搜索名称、能力或标签…" autocomplete="off">
            <kbd>⌘ K</kbd>
          </label>
          <div class="categories" aria-label="按分类筛选">
            <button :class="{ active: activeCategory === 'all' }" type="button" @click="activeCategory = 'all'">全部</button>
            <button
              v-for="category in categories"
              :key="category"
              :class="{ active: activeCategory === category }"
              type="button"
              @click="activeCategory = category"
            >{{ categoryLabels[category] ?? category }}</button>
          </div>
        </div>

        <p class="result-count" aria-live="polite">找到 {{ visiblePlugins.length }} 个插件</p>

        <ul v-if="visiblePlugins.length" class="plugin-grid">
          <li v-for="plugin in visiblePlugins" :key="plugin.id">
            <article class="plugin-card">
              <div class="card-topline">
                <span class="package-name">{{ plugin.packageName }}</span>
                <span class="status"><i aria-hidden="true"></i>{{ ['published', 'public'].includes(plugin.status) ? '已发布' : '内部精选' }}</span>
              </div>
              <div class="plugin-symbol" aria-hidden="true">{{ plugin.displayName['en-US']?.slice(0, 1) ?? 'D' }}</div>
              <h3>{{ plugin.displayName['zh-CN'] }}</h3>
              <p class="summary">{{ plugin.summary['zh-CN'] }}</p>
              <ul class="tags" aria-label="插件标签">
                <li v-for="tag in plugin.tags.slice(0, 3)" :key="tag">{{ tag }}</li>
              </ul>
              <div class="card-footer">
                <span>v{{ plugin.version }}</span>
                <span>{{ qualityCount(plugin) }}/3 质量项</span>
                <button type="button" @click="openPlugin(plugin, $event)">查看详情</button>
              </div>
            </article>
          </li>
        </ul>
        <div v-else class="empty-state">
          <span aria-hidden="true">⌁</span>
          <h3>没有找到匹配的插件</h3>
          <p>换一个关键词，或查看全部分类。</p>
          <button type="button" @click="query = ''; activeCategory = 'all'">清除筛选</button>
        </div>
      </section>

      <section id="standards" class="standards" aria-labelledby="standards-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">QUALITY GATES</p>
            <h2 id="standards-title">质量门禁</h2>
          </div>
          <p>插件上架前需依次通过以下检查，确保可安装、可验证、可追溯。</p>
        </div>
        <ol class="standards-list">
          <li><span>01</span><div><strong>结构校验</strong><p>Manifest、Cordis Patch 与权限声明完整。</p></div></li>
          <li><span>02</span><div><strong>静态质量</strong><p>严格 TypeScript、源码规则与依赖边界。</p></div></li>
          <li><span>03</span><div><strong>自动测试</strong><p>单元、契约与关键工作流均可复现。</p></div></li>
          <li><span>04</span><div><strong>真实装载</strong><p>打包后在隔离 DSH 环境完成安装冒烟。</p></div></li>
        </ol>
      </section>
    </main>

    <footer>
      <span>Suhan DSH Forge</span>
      <p>DSH 插件管理与发布平台</p>
      <span>© 2026</span>
    </footer>

    <dialog ref="dialog" class="detail-dialog" aria-labelledby="detail-title" @close="onDialogClose">
      <template v-if="selectedPlugin">
        <button ref="closeButton" class="dialog-close" type="button" aria-label="关闭插件详情" @click="closePlugin">×</button>
        <p class="eyebrow">插件详情 · {{ selectedPlugin.packageName }}</p>
        <h2 id="detail-title">{{ selectedPlugin.displayName['zh-CN'] }}</h2>
        <p class="dialog-summary">{{ selectedPlugin.summary['zh-CN'] }}</p>
        <div class="detail-block">
          <h3>兼容范围</h3>
          <dl>
            <div><dt>DSH</dt><dd>{{ selectedPlugin.compatibility.dsh }}</dd></div>
            <div><dt>Node.js</dt><dd>{{ selectedPlugin.compatibility.node }}</dd></div>
            <div><dt>Profile</dt><dd>{{ selectedPlugin.compatibility.profiles.join(', ') }}</dd></div>
          </dl>
        </div>
        <div class="detail-block">
          <h3>能力声明</h3>
          <ul class="permission-list">
            <li v-for="item in selectedPlugin.permissions.network" :key="item"><span>网络</span>{{ item }}</li>
            <li v-for="item in selectedPlugin.permissions.filesystem" :key="item"><span>文件</span>{{ item }}</li>
            <li v-for="item in selectedPlugin.permissions.process" :key="item"><span>进程</span>{{ item }}</li>
          </ul>
        </div>
        <div class="install-box">
          <code>dsh plugin --profile web add {{ selectedPlugin.packageName }}</code>
          <button type="button" @click="copyInstallCommand(selectedPlugin)">{{ copied ? '已复制' : '复制命令' }}</button>
        </div>
        <p class="copy-status" aria-live="polite">{{ copied ? '安装命令已复制到剪贴板。' : '' }}</p>
      </template>
    </dialog>
  </div>
</template>
