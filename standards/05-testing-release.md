# 05 测试、打包与发布规范

## 测试分层

- **TEST-001 (MUST)**：每个行为变更至少有一个在修改前会失败、修改后会通过的测试，或给出无法自动化的可复现验证记录。
- **TEST-002 (MUST)**：单元测试覆盖核心状态转换、边界值和失败路径，不只覆盖成功路径。
- **TEST-003 (MUST)**：契约测试覆盖入口导出、Host/Client wire contract、Cordis 注册/释放、重复初始化/卸载，以及清单引用的文件存在。
- **TEST-004 (MUST)**：涉及路由、文件、进程、网络或凭证时，测试拒绝非法输入、权限边界、超时/取消和敏感信息不泄漏。
- **TEST-005 (MUST)**：涉及 UI 关键流程时提供浏览器测试；若 `quality.browserTests` 为 `false`，必须在发版记录中给出人工流程及结果，不能声称已具备浏览器自动化覆盖。
- **TEST-006 (SHOULD)**：缺陷修复保留回归测试；生命周期问题应测试卸载后无残留回调、计时器、路由、handle 或样式。

## 合并门禁

从仓库根目录运行：

```bash
pnpm validate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

提交前优先运行聚合命令 `pnpm check`。

- **TEST-007 (MUST)**：不得通过跳过测试、放宽类型、删除断言或把测试改成只验证 mock 调用来制造绿灯。
- **TEST-008 (MUST)**：如果受环境限制未运行某门禁，交付说明必须列出命令、阻塞原因和剩余风险；不得写成“全部通过”。

## 打包检查

- **PACK-001 (MUST)**：检查 `pnpm pack --dry-run` 的最终文件清单，而非只检查工作区。包内不得出现 `.env`、凭证、运行数据、缓存、测试产物、本地路径或不需要的源码。
- **PACK-002 (MUST)**：从打包产物验证所有 `main`、`types`、`exports`、bundle patch 和市场清单目标均存在，且消费方无需依赖仓库内文件。
- **PACK-003 (MUST)**：对 Client bundle 检查共享宿主运行时未重复打包，且所有 external 都能由目标 profile 的 loader 提供。

## 发布门禁

- **REL-001 (MUST)**：公开发布前确认许可证、源码仓库、维护者、包名所有权、变更记录和安全扫描；移除 `private: true` 必须是独立、可审查的决定。
- **REL-002 (MUST)**：版本号遵循语义化版本；公共 API、配置、数据 schema、权限或最低宿主版本变化必须在 release note 中列出。
- **REL-003 (MUST)**：DSH/Cordis 仍处 developer preview。升级任一宿主依赖时，更新兼容范围并分别执行全新安装、旧版升级、启用、核心流程、禁用/卸载和重启后的真实冒烟。
- **REL-004 (MUST)**：最终验证对象必须是即将发布的 `.tgz`，安装到隔离环境；不得用工作区链接或源码运行代替发布产物验证。
- **REL-005 (MUST)**：发布失败或安装冒烟失败时停止发布，保留诊断证据；不得用扩大兼容范围或忽略错误绕过。

## 发版记录模板

```text
版本：
兼容范围：DSH / Cordis / Node / profiles
权限变化：network / filesystem / process / secrets
迁移与回滚：
门禁结果：validate / lint / typecheck / test / build / pack:check
.tgz 安装冒烟：全新 / 升级 / 启用 / 核心流程 / 卸载 / 重启
未完成项与风险：
```
