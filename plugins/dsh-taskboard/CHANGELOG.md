# Changelog

## [0.1.7] - 2026-08-22

### Fixed
- 页面预览与实时预览地址统一：执行中任务的「🌐 页面预览」链接不再落到执行 Agent 自起的 ad-hoc dev server（如 5174），一律解析到看板端口租约的同一 worktree dev server（新任务级 `preview-base` 端点，与 live-preview 同源、心跳续租）；历史/集成后任务仍按主项目解析。
- 交付时报告的 localhost 完整预览地址归一化为相对路径存储（外部 URL 原样保留）；已存数据中的 localhost 地址由客户端 re-base 到统一基地址兜底。
- 执行提示词更新：delivery_ready 只报告相对路径，验证用的 dev server 结束后自行关闭，不再残留第二个端口。

## [0.1.6] - 2026-08-22

### Added
- 任务实时预览（执行中即可看到真实改动效果）：执行中的任务详情新增「实时预览」卡片，看板按端口池 4300–4999 为每个并行任务租用一组连续 10 个端口（xx0 前端 / xx1 API / xx2 Storybook / 其余备用），在任务独立 worktree 中启动 dev server（strictPort，绝不自动换端口），依赖装好后自动给出预览地址。
- 端口租约由看板统一管理并持久化（`port-leases.json`）：启动时检测组内占用、整组空闲才申请，任务结束（交付归档 / 强制关闭 / 删除 / 失败）显式释放并终止 dev server；live-preview 请求心跳续租，超时（约 5 分钟）由惰性 sweep 回收；插件重启后恢复仍在运行的租约、清理残留进程。
- 支持 vite / vitepress（`--port --strictPort`）与 next（`-p`）项目；dev script 不支持的框架给出明确原因；依赖未安装时提示「任务依赖安装中」，装好后自动启动。

### Fixed
- 实时预览探测使用真实墙钟而非注入时钟，避免时钟不推进导致探测死循环。

## [0.1.4] - 2026-08-20

### Added
- 方案确认界面升级为 Markdown 编辑/预览双模：每个字段默认渲染预览（标题/段落/列表/粗体/代码/链接等），可切换到 Markdown 源码编辑；冻结方案查看页同样按 Markdown 渲染。
- 验收预览链接：执行中/待交付/完成后的工作项详情提供「预览改动」，独立页面展示本任务修改的文件列表、着色 diff 与每个文件的完整内容（任务 worktree 未集成时 diff 其基线，集成后 diff 集成提交）。
- 已完成工作项的 run 闸门给出明确错误（「该工作项已完成并集成，无需再次执行」），详情页对已完成 AI 卡片隐藏「继续执行」按钮，避免误触误导性 409。

### Fixed
- 修复工作项在 worktree 或集成提交均不存在时预览返回 409 而不是 500；文件内容页拒绝路径穿越并区分二进制文件。
- 新建想法只填标题不再报「originalRequirement 不能为空」：需求文本以标题兜底，正常进入方案生成流程。
- 统一面向用户的文案：「AI分析」改为「任务方案生成」（按钮 / 提示 / 409 消息 / 文档）。

### Changed
- 新增 DSH 主设置中的「任务看板」设置页（`settings.section`）：可切换已注册项目，并通过现有 `/taskboard/boards/:key/settings` 接口编辑看板环节与工作项类型。
- 抽取 `SettingsForm` 复用看板内设置弹窗与 DSH 设置页的表单逻辑。

## [0.1.5] - 2026-08-22

### Added
- 验收框「🌐 页面预览」链接：执行 Agent 在 `delivery_ready` 时报告改动涉及的可见页面预览地址（相对路径或完整 URL，最多 10 个），验收时直接打开页面查看效果（提示代码合并后生效）。

### Changed
- 审核通过（确认交付）后，自动提交并完成合并集成时任务自动归档到历史任务，不再停留在看板待手动归档。
- 看板新建统一到右上角「＋ 新建工作项」，各列下方不再单独提供新建按钮。
- 详情弹窗加大为两栏布局：上方基础信息与任务名称；下方左侧为描述与方案详情（冻结方案直接内嵌全文渲染，去掉「查看方案」弹窗；待确认项独立卡片展示），右侧上方为审核/交付卡片与全部操作按钮，右侧下方为需求追溯——一页展示全部信息。
- 方案生成中卡片显示醒目脉冲「方案生成中…」进度徽标。
- 「🌐 页面预览」相对路径链接自动解析到项目 dev server 基地址：点击时确保项目已启动（复用运行中的 dev server，否则自动 `pnpm dev` 并探测端口；DSH 插件仓库回退宿主页面），直接打开改动后的真实页面看效果，不再落到 3080 宿主页面。
- 详情弹窗进一步加大、右侧栏加宽、操作按钮保持一排不换行。
- 右侧栏再加宽并压缩按钮内边距，最满操作组合下按钮一排放得下，不再出现横向滚动条。
- 「🌐 页面预览」链接在 dev server 基地址解析完成前显示「解析中」占位、失败显示原因，不再渲染裸相对路径（否则按宿主 3080 origin 打开，落到宿主页面而非改动项目）。
- 启动项目 dev server 时传 `CI=true`：pnpm 11 在无 TTY 下依赖重装默认交互确认并中止（vitepress 等项目永远起不来），CI 下自动跳过确认继续安装。
- 历史任务列表新增「查看详情」：复用详情弹窗只读模式一页展示全部内容——任务方案（冻结方案全文，无冻结内容时按 aiAnalysis 重建）、改动内容（预览改动链接，按集成提交 diff）、页面预览（解析到项目 dev server）与打开会话。

## [0.1.3] - 2026-08-19

### Added
- AI 任务创建流程：只有「创意想法」列支持新建；新建对话框极简化为可选标题 + 想法计划描述，「AI分析」按钮启动只读分析 Agent 会话。
- AI 分析结合当前真实项目（工程指令、技术栈、目录结构与相关代码）生成结构化方案：建议标题 / 需求理解 / 项目现状分析 / 实施方案 / 影响范围 / 待确认项 / 验收标准；禁止虚构与扩大范围，不确定项进入待确认。
- 方案确认页分字段结构化编辑，支持补充需求重新分析（复用分析会话）；确认时冻结为 `frozenPlan`（执行唯一依据）并自动开始开发执行。
- 状态机 `draft → analyzing → pending_confirm → confirmed → executing → completed`；确认前卡片锁定第一列，服务端拒绝流转与执行。
- 非 Git 项目分析回退到项目目录只读分析；执行仍受 Git 前置条件约束，恢复 Git 后可重试，方案保持已确认不丢失。
- 聊天页「＋待办」同样创建想法草稿，需到看板完成 AI 分析确认后执行。

### Fixed
- 修复跨列拖拽在 AI 流程卡片上确认前的流转漏洞（卡片拖拽与服务端 PATCH 双重守卫）。
- 分析会话误写 worktree 的防御：方案确认时对任务 worktree 执行防御性重置，分析期改动不会进入最终任务提交。

## [0.1.2] - 2026-08-15

### Added
- Isolate concurrent tasks in task-owned Git worktrees and serialize only final repository integration.
- Resolve rebase conflicts autonomously in the original task worktree and session, then continue serialized integration without creating a second task.
- Add workspace-scoped paginated task history, durable Git commit references, and direct reopening of retained task sessions.
- Run automatic-mode tasks end-to-end in one Agent turn instead of repeating model startup and repository validation across every board column.
- Remove completed temporary Workspaces/worktrees automatically, allow manual cleanup of legacy retained workspaces, and keep session logs reopenable from history.
- Add delivery constraints for bounded output/concurrency, targeted checks, one final full gate, user-path verification, resource cleanup, and performance regressions.
- Place task worktrees inside the registered project sandbox, exclude them through `.git/info/exclude`, and make the prompt use the exact Session cwd so builds cannot fall back to the main workspace or fail on an out-of-sandbox path.
- Retry a blocked pending Git integration directly without rerunning the Agent task, and show automatic tasks in development instead of leaving them in analysis.
- Keep a last-known-good data backup and recover from a corrupt primary data file.
- Enforce bounded JSON request bodies and validate work-item, parent, status, type, and settings payloads.

### Fixed
- Associate every active task session with its real worktree Workspace instead of leaving it unowned or attaching it to a mismatched parent directory.
- Start isolated tasks safely from dirty main worktrees by capturing an immutable baseline through a temporary Git index without changing or committing user work.
- Preserve taskboard state across refreshes, restarts, upgrades, and reinstall mode changes under `$DSH_HOME/storages/dsh-taskboard`.
- Migrate legacy package-local `datas/boards.json` data non-destructively when it is still available.
- Return actionable Git-workspace precondition errors instead of opaque task-run HTTP 500 responses.
- Recover interrupted task bootstrap workspaces and clean them during deletion or force-close even before session creation completes.
- Allow editing to clear optional parent and iteration fields without leaving stale values.
- Avoid post-unload background state transitions and wait for pending persistence before lifecycle disposal completes.

### Changed
- Remove the manual project creation API and UI; boards now follow the DSH workspace registry only.
- Add keyboard-native task cards, modal focus trapping, Escape close, focus restoration, and visible focus indicators.
- Align DSH peer compatibility with the tested `0.1.0-rc.6` preview runtime and Cordis `4.0.1`.


## [0.1.1] - 2026-08-15

### Changed
- Published `@suhan-dsh/taskboard@0.1.1` to the public npm registry.
- Deprecated `0.1.0` in favor of `0.1.1`; `0.1.1` is the clean published artifact without local tarball publish metadata.

## [0.1.0] - 2026-08-15

### Added
- Initial public release preparation for `@suhan-dsh/taskboard`.
- MIT license, repository metadata, npm public publish configuration.
- Public marketplace status and refined permission declarations.

### Changed
- Removed `private: true` and `UNLICENSED`; switched to public npm package metadata.
- `exports` no longer exposes unpublished `./src/*` paths.
- Published tarball now includes `lib/client.js.map`, `LICENSE`, and `CHANGELOG.md`.
- README installation instructions now support `dsh plugin --profile web add @suhan-dsh/taskboard`.
