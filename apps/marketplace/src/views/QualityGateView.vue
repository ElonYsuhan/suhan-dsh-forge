<script setup lang="ts">
</script>

<template>
  <section class="page-head" aria-labelledby="quality-page-title">
    <div>
      <p class="eyebrow">DEEPSEEK HARNESS · 质量管理</p>
      <h1 id="quality-page-title">质量门禁</h1>
      <p class="lead">插件上架前需依次通过以下检查，确保可安装、可验证、可追溯。</p>
    </div>
    <a class="primary-link" href="#/plugins">浏览插件</a>
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
</template>
