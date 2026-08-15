# Suhan DSH Forge 工程约束

本仓库用于开发、测试、打包和上架 DeepSeek Harness 插件。DSH 官方协议和 Cordis 生命周期语义优先于本仓库的市场扩展字段。

## AI 必读入口

开发、修改或审核 `plugins/*` 前，必须先阅读 [`standards/README.md`](standards/README.md)，再按其中的任务路由读取相关规范。规范中的 `MUST` / `MUST NOT` 是合并门禁，`SHOULD` 偏离时必须在变更说明中给出理由。发现官方 DSH/Cordis 协议与本仓库规范冲突时，不得自行猜测兼容层；应以官方协议为准，并同步修正规范与验证器。

交付说明必须列出：变更范围、权限变化、生命周期资源、已执行门禁、未执行门禁及原因。不得把“代码已生成”当作“插件已完成”。

## 目录职责

- `plugins/*`：一个目录对应一个可独立安装的 DSH npm 包。
- `apps/*`：市场、审核台等产品应用；不得成为插件运行依赖。
- `packages/*`：插件 SDK、测试工具和注册表客户端。
- `standards/*`：开发、发布、安全和兼容性门禁。

## 插件硬约束

- 使用 TypeScript、ESM 和严格类型检查；公共宿主类型不得用 `any` 逃逸。
- 必须提供 `cordis.patch.yml`，并在 `package.json#dsh.bundle.patch` 中声明。
- Host/Client 共享运行时使用 peer dependency，禁止在浏览器包中重复打入 Cordis、React 或 DSH 平台模块。
- Cordis 注册必须可逆；卸载时释放路由、事件、Agent handle、计时器和样式。
- 运行数据、凭证、`.env`、本地绝对路径不得进入 Git 或发布包。
- 新增网络、文件系统、进程和凭证能力时同步更新 `dsh-marketplace.json#permissions`。
- DSH 处于 developer preview；升级 DSH 或 Cordis 必须更新兼容范围并执行真实安装冒烟。

## 必跑门禁

```bash
pnpm validate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

提交前优先运行聚合命令：

```bash
pnpm check
```

公开上架还必须完成：许可证、仓库地址、维护者、包名所有权、安全扫描和最终 `.tgz` 安装测试。
