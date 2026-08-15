# Suhan DSH Forge

面向 DeepSeek Harness 的插件工厂与可视化插件平台。

## 插件平台

```bash
pnpm dev:marketplace
```

平台位于 `apps/marketplace`，构建时会自动扫描 `plugins/*` 的包信息和 `dsh-marketplace.json`，支持搜索、分类筛选、权限与质量信息展示。

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件开发、验证、测试和打包工作区。

## 工作区

- `plugins/*`：可安装的 DSH/Cordis 插件。
- `scripts/validate-plugins.mjs`：所有插件共享的结构与发布门禁。
- `standards/`：本仓库在 DSH 官方协议之上的质量规范。

首个迁入插件为 `plugins/dsh-taskboard`。迁移保留了原工作区当前源码与本地数据，但 `datas/*.json` 被明确排除在 Git 和 npm 发布包之外。

## 常用命令

```bash
pnpm install
pnpm validate
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
pnpm check
```

只检查一个插件：

```bash
pnpm --filter @suhan-dsh/taskboard typecheck
pnpm --filter @suhan-dsh/taskboard test
pnpm --filter @suhan-dsh/taskboard build
```

## 本地安装

```bash
pnpm --filter @suhan-dsh/taskboard build
pnpm --filter @suhan-dsh/taskboard run pack
dsh plugin --profile web add /absolute/path/to/suhan-dsh-forge/artifacts/suhan-dsh-taskboard-0.1.0.tgz
```

当前已验证兼容本机 DSH `0.1.0-rc.6`：隔离 profile 安装后 bundle 自动挂载，真实 `/taskboard/boards` 路由返回成功。

DSH 仍处于 developer preview。每次升级 DSH 版本后，必须重新运行完整 `pnpm check` 和真实 profile 安装冒烟测试。
