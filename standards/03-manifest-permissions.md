# 03 清单、兼容性与权限规范

插件有三个相互约束的清单：`package.json` 描述 npm 与 DSH 装载，`cordis.patch.yml` 描述 profile 挂载，`dsh-marketplace.json` 描述市场、兼容性、权限和质量声明。三者必须与实现一致。

## `cordis.patch.yml`

- **META-001 (MUST)**：patch 必须能由声明的 profile 挂载，插件 `name` 与 `package.json#name` 完全一致，`id` 在目标 profile 内稳定且唯一。
- **META-002 (MUST)**：patch 只表达安装所需的最小变更；不得覆盖无关 profile 配置，不得嵌入本地路径、凭证或环境特有值。
- **META-003 (MUST)**：变更 patch 结构或 id 时必须提供升级/卸载说明，并执行旧版本升级与全新安装两条冒烟路径。

## 市场元数据

- **META-004 (MUST)**：`schemaVersion` 使用仓库支持的版本；中英文 `displayName` 和 `summary` 均为非空字符串，内容与当前实现一致。
- **META-005 (MUST)**：`categories`、`tags` 使用可检索、非夸张的词；不得声明尚未交付的能力。
- **META-006 (MUST)**：`compatibility.dsh`、`compatibility.node` 和 `compatibility.profiles` 必须是实际测试范围，不得用无上界范围代替兼容性证据。
- **META-007 (MUST)**：`quality.unitTests`、`contractTests`、`browserTests` 只能在对应测试存在且纳入门禁时为 `true`。
- **META-008 (MUST)**：`status` 必须反映真实发布阶段。内部包保持 `internal`、`private: true` 和不可公开发布的许可证状态；转公开前完成发布清单。

## 权限模型

`permissions` 固定包含四个数组；没有权限时使用空数组，不得省略：

- `network`：每个远端域名/本地路由前缀、用途、方向；
- `filesystem`：读写范围、数据类型、保留策略；
- `process`：可执行程序或动作、参数边界、用途；
- `secrets`：凭证类型、用途和存储方，绝不写入真实值。

- **PERM-001 (MUST)**：实际能力与权限声明双向一致：有能力必声明，已删除的能力同步移除声明。
- **PERM-002 (MUST)**：声明必须具体到可审查范围；“需要网络”“访问文件”等笼统文字不合格。
- **PERM-003 (MUST)**：新增或扩大权限必须在变更说明中单独列出理由、数据流、失败模式和降权方案，并增加相应安全测试。
- **PERM-004 (MUST)**：Client 不得直接持有 secrets；Host 返回给 Client 的错误和对象必须先移除凭证、路径及内部堆栈等敏感信息。

## 一致性审查

审核时从实现反向枚举 import、路由、文件操作、子进程、环境变量和凭证，再与三个清单逐项核对。只从清单正向阅读不足以证明权限完整。
