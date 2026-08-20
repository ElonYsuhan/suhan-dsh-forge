# Changelog

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
