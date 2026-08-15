# 01 插件基线规范

## 包与目录

- **BASE-001 (MUST)**：一个 `plugins/<name>` 目录只承载一个可独立安装的 npm 包，不得依赖 `apps/*` 的源码或运行时。
- **BASE-002 (MUST)**：包必须包含 `package.json`、`src/`、`README.md`、`cordis.patch.yml`、`dsh-marketplace.json`，以及 `tests/` 或 `src/__tests__/` 中至少一项业务语义测试。
- **BASE-003 (MUST)**：源码使用 TypeScript、ESM 和 `strict: true`。公共宿主边界不得使用 `any`、双重断言或关闭严格检查来绕过类型约束；未知输入先用 `unknown`，再验证和收窄。
- **BASE-004 (MUST)**：生成物只能进入约定的构建目录；凭证、`.env`、运行数据、缓存、日志、本地绝对路径和测试临时文件不得提交或打包。
- **BASE-005 (SHOULD)**：Host、Client、共享 wire 类型分别组织。共享目录只能包含可序列化契约和纯函数，不得偷偷引入 Node 或 DOM 运行时。

## `package.json` 基线

- **BASE-006 (MUST)**：声明非空的 `name`、`version`、`description`、`license`、`type: "module"`、`main`、`types`、根 `exports` 和 `files` 白名单。
- **BASE-007 (MUST)**：`files` 必须显式包含运行产物、声明文件、`README.md`、`cordis.patch.yml`、`dsh-marketplace.json`，不得用宽泛目录把源码数据或本地状态带入包。
- **BASE-008 (MUST)**：必须提供 `build`、`lint`、`typecheck`、`test`、`pack:check` 脚本。测试必须针对源码或可追溯的测试构建运行，不能只测试已提交的陈旧产物。
- **BASE-009 (MUST)**：Cordis、React、DSH 宿主模块等共享运行时使用 `peerDependencies`；构建工具和测试工具放入 `devDependencies`。浏览器产物不得再打入共享运行时副本。
- **BASE-010 (MUST)**：包的 `dsh.bundle.patch` 必须指向 `./cordis.patch.yml`。若存在浏览器端，必须声明准确的 `dsh.client.platform` 和实际注入的宿主模块。

## README 最低内容

- **BASE-011 (MUST)**：README 说明插件目的、Host/Client 形态、配置、开发命令、安装、验证、卸载、数据位置和权限原因。
- **BASE-012 (MUST)**：预览版限制、已知兼容范围、迁移或破坏性变化必须显著写明。示例命令不得包含真实凭证、用户目录或不可移植的绝对路径。

## 禁止模式

- 从 `apps/*` 反向引用；
- 在公共宿主类型上使用 `any`；
- 通过深层路径导入另一个插件的运行时实现；
- 把本机 `node_modules`、`lib/` 陈旧产物或运行数据库当成真实来源；
- 只有手工步骤、没有可重复脚本的构建或测试流程。
