# @suhan-dsh/taskboard

DeepSeek Harness Web 客户端插件：**项目级需求追溯看板**，左侧「新会话」下方的「看板」按钮切换右侧主工作台，任务可与聊天页 agent 会话联动执行。

## 形态

- **浏览器半**（`src/client/`）
  - `shell.overlay` 条目：侧栏看板入口 + 右侧全尺寸工作台（项目切换 / 自定义环节列 / 拖拽流转 / 工作项详情与需求追溯时间线 / 执行 / 历史任务 / 看板设置）
  - `conversation.input.left` 条目：聊天页 composer「＋待办」按钮，对话中直接创建待办任务到项目看板
  - 会话联动：工作项详情「执行」下发任务到 agent 会话；点击「打开会话」或左侧任一会话时，关闭看板并切回聊天页
- **Node 半**（`src/index.ts`）
  - `/taskboard` REST：项目看板 CRUD、工作项 CRUD、自定义环节/类型设置、执行
  - **并行执行**：首次执行创建独立 Git worktree、任务分支和完整 Agent + Session（使用 Web profile 当前模型与默认 Agent preset，`cwd`=任务 worktree）；该目录注册为以“原项目 · 任务标题”命名的临时 DSH Workspace，会话始终具有合法项目归属
  - **自动提交与集成**：人工确认交付后由插件生成单任务提交；同一仓库的最终集成在短时互斥锁内先 rebase 最新目标分支，再以 `ff-only` 更新主工作区
  - **冲突编排**：变基冲突保留在原任务 worktree 和原会话中，由同一 Agent 结合仓库功能与测试自主取舍；插件随后继续 rebase 与 `ff-only` 集成，不再派生冲突任务
  - **agent 工具 `taskboard_progress`**：汇报环节完成、阻塞和待交付；看板每 3 秒刷新执行状态
  - 数据落盘 `$DSH_HOME/storages/dsh-taskboard/boards.json`；新任务 worktree 位于项目内 `.dsh-taskboard-worktrees/`，通过 `.git/info/exclude` 排除，确保 Agent 沙箱可写且不污染 Git 状态

## 工作项模型

- 类型：史诗 / 需求 / 任务 / 缺陷（可自定义），`parentId` 构成追溯树
- 环节：默认三列（创意想法 → 开发落地 → 验收提交合并），可自定义；只有「创意想法」列支持新建，其他列不可新建
- 追溯：每个工作项的 `timeline` 记录创建 / 流转 / 执行 / 备注全历史
- AI 创建：看板新建与聊天页「＋待办」都创建想法草稿（`originalRequirement`），必须先经 AI 分析并确认方案才能执行（见下节）
- 删除：卡片在任意状态都可删除；新任务会停止 Agent 并只删除自己的 worktree/分支，旧 checkpoint 任务继续使用兼容回退
- 强制关闭：中断 Agent 并清理任务隔离目录，不修改其他任务或项目主工作区
- 历史：右上角「历史任务」按需分页展示当前工作区归档记录、结果与提交 SHA，并可直接重新打开任务会话；常规 3 秒轮询不携带历史数据

## AI 任务创建流程（先分析、后执行）

看板「创意想法」列的新建按钮和聊天页「＋待办」都进入极简创建：可选标题 + 一个「想法计划描述」文本框。提交后创建草稿（`creationState: draft`），随后自动启动 AI 分析。

AI 分析阶段：

- 插件为草稿创建一个只读分析 Agent 会话（首次分析时复用任务快照 worktree，非 Git 项目回退到项目目录只读分析）。
- Agent 先读工程指令（CLAUDE.md / AGENTS.md 等）与技术栈，再结合真实代码检索需求相关的页面、组件、接口与可复用能力；禁止虚构接口/组件/目录、禁止扩大范围、禁止修改任何文件；无法从代码或需求确定的事项必须写入「待确认项」。
- 分析产出结构化方案并提交看板：建议标题 / 需求理解 / 项目现状分析 / 实施方案 / 影响范围 / 待确认项 / 验收标准。卡片进入「方案待确认」。

方案确认页（分字段结构化编辑）：

- 每个字段可单独修改（标题、需求理解、现状分析、四个列表每行一项）。
- 「补充需求 + 重新分析」把补充内容追加进原始需求并重新启动分析（复用同一分析会话）。
- 确认时方案冻结为 `frozenPlan`（markdown 渲染，执行唯一依据），看板立即自动开始执行。

状态流：`draft → analyzing → pending_confirm → confirmed → executing → completed`。方案确认前卡片锁定在第一列，服务端同样拒绝流转与执行（`run` 返回 409）。旧数据（无 `originalRequirement`）不受影响，继续走直接创建/执行路径。

## 执行与审核工作流

创建工作项时选择执行方式（AI 创建流程由确认页自动开始执行，无需手工选择）：

- **小任务 · AI 单轮交付**：一个 Agent turn 内完成必要分析、实现、针对性测试和一次最终门禁，环节完成记录写入卡片时间线，卡片保持在「开发落地」列。完成后调用 `delivery_ready`，卡片进入「验收提交合并」列等待人工确认最终交付。
- **重大任务 · 每环节人工审核**：Agent 每完成一个环节便暂停。人工可在看板批准并进入下一环节，或退回原会话修订。

流水线推进规则：

- 任务执行不跳过任何看板环节；执行开始时卡片从「创意想法」进入「开发落地」，每完成一个环节即调用 `taskboard_progress` 记录时间线。小任务在同一 Agent 轮内连续完成全部环节后调用 `delivery_ready` 进入「验收提交合并」；重大任务则在每个环节后暂停等待人工审核，批准后推进。
- 工作项进入「验收提交合并」列后保留在看板上，不自动删除或归档；如需归档可手动删除卡片。

执行生命周期：

```text
创建想法草稿（仅「创意想法」列 / 聊天页「＋待办」）
  → AI 分析（只读会话结合真实项目产出结构化方案）
  → 分字段确认，方案冻结为 frozenPlan
  → 执行（创建并关联唯一 DSH 会话，严格按冻结方案开发）
  → 环节产出
      ├─ 小任务：单轮端到端完成
      └─ 重大任务：人工批准 / 退回
  → 交付物就绪
  → 人工确认最终交付
  → 插件自动暂存任务 worktree 的全部变化并创建单任务提交
  → 仓库级集成锁内 rebase 最新目标分支 + ff-only 集成
      ├─ 成功：清理临时 Workspace/worktree，保留可打开的 DSH 会话日志 + 卡片进入历史任务
      └─ 冲突：原会话自主解决 → 插件 rebase --continue → ff-only 集成
```

约束：Agent 全程不得创建 Git 提交、切换分支或操作项目主工作区。小任务禁止逐列空转、重复全仓扫描、重复全量门禁、无界日志/并发和遗留 watcher；必须验证主要用户路径、错误路径、资源释放及工程完整门禁。若质量检查、改动隔离或自动提交失败，工作项进入阻塞状态，不会假归档。即使没有文件变化，插件也会生成一条空审计提交，使历史任务与 Git 记录一一对应。

## 并行与 Git 前置条件

- 启动新任务时项目必须位于正常分支；主工作区可以有未提交改动。插件通过临时 Git index 生成只读基线提交，不修改用户工作区、不改变暂存区，也不替用户提交代码。
- 不同任务的 Agent 和文件写入完全隔离；只有最终集成会短暂串行。
- 实际任务目录位于原项目可写边界内，提示词与 Session `cwd` 始终指向同一 worktree；Agent 严禁切回主工作区。
- 活动任务会话绑定到以“原项目 · 任务标题”命名的临时 DSH Workspace；成功集成后自动分离并清理 Workspace/worktree/任务分支，但不归档 Session 日志，因此历史面板仍可恢复聊天记录。旧版本遗留的临时工作区可在历史任务中手动清理。
- 代码冲突保留在原任务的 rebase 现场，由原 Agent 编辑冲突文件并验证；Git 暂存、`rebase --continue` 和最终 `ff-only` 仍由插件执行。
- 若用户切换目标分支或主工作区存在未提交改动，任务保持阻塞且保留现场，绝不覆盖用户改动；恢复目标分支与干净状态后可继续交付。

## 构建

```bash
pnpm install
pnpm --filter @suhan-dsh/taskboard typecheck
pnpm --filter @suhan-dsh/taskboard test
pnpm --filter @suhan-dsh/taskboard build
pnpm --filter @suhan-dsh/taskboard pack:check
```

## 一键发版

确认 `package.json#version` 已是目标版本且 Git 工作区干净，然后在当前插件目录执行：

```bash
pnpm release
```

也可以从仓库根目录执行 `pnpm --filter @suhan-dsh/taskboard release`。

脚本会依次执行全量门禁与漏洞审计、生成并校验 tgz、发布 npm、创建本地 `taskboard-v<version>` Git 标签、把当前 DSH web profile 从开发链接切换为 npm 固定版本，最后重启并检查 `/taskboard/boards`。npm 已存在完全相同的版本包时会安全跳过重复发布，可用于继续完成中断后的本地安装步骤。

构建工具 `scripts/tsdown.client.ts` / `scripts/platform.ts` 复用自
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT），
产出的 `lib/client.js` 为 `window.__ModuleLoader__.load({ id, factory })` 格式。

## 安装到 DSH web profile

### 从 npm 公开安装

```bash
dsh plugin --profile web add @suhan-dsh/taskboard
```

### 从本地构建产物安装

```bash
pnpm --filter @suhan-dsh/taskboard build
pnpm --filter @suhan-dsh/taskboard run pack
dsh plugin --profile web add /abs/path/to/suhan-dsh-forge/artifacts/dsh-taskboard/suhan-dsh-taskboard-0.1.2.tgz
```

插件包已通过 `package.json#dsh.bundle.patch` 声明 `cordis.patch.yml`。若当前 DSH 预览版未自动挂载 bundle，可在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- id: taskboard
  name: '@suhan-dsh/taskboard'
```

重启 `dsh web` 后左侧出现「看板」按钮。

安装或更新插件后需要重启 `dsh web`，Host 才会加载新的 Node 半状态机。

### macOS 启动时报 `EMFILE`

如果 `dsh web` 输出地址后立即报 `Error: EMFILE: too many open files, watch`，说明 macOS 的目录事件监听通道不可用。可在 DSH 用户环境文件 `~/.dsh/.env` 中启用 Chokidar 轮询后端：

```dotenv
CHOKIDAR_USEPOLLING=1
```

这只改变 DSH 配置文件与凭据文件的变更检测方式，不改变 Agent、会话或任务执行逻辑。修改后重启 `dsh web`。

## 数据

- 文件：`$DSH_HOME/storages/dsh-taskboard/boards.json`（默认 `$DSH_HOME=~/.dsh`，不随插件升级或重装删除）
- 任务隔离目录：新任务使用 `<Git 根>/.dsh-taskboard-worktrees/`，并自动写入仓库本地 `.git/info/exclude`；旧任务继续兼容 `$DSH_HOME/storages/dsh-taskboard/worktrees/`。成功、删除、强制关闭或历史手动清理时释放，运行中和待解决冲突保留。
- 数据损坏恢复：每次原子写入前保留 `boards.json.bak`；主文件结构损坏时自动读取最近一份有效备份，原文件不删除
- 旧版迁移：稳定文件不存在且旧包目录仍存在时，Host 会读取一次 `datas/boards.json` 并复制到稳定目录；旧文件保留，不自动删除
- 自定义：设置 `DSH_TASKBOARD_DATA=<绝对路径>` 覆盖存储位置；显式覆盖时不读取旧默认路径

### 从 0.1.1 升级

`0.1.1` 把数据写在 npm 包目录，包管理器升级时可能先替换该目录。请在安装 `0.1.2` 前执行一次备份迁移；命令只在目标文件尚不存在时复制，不覆盖已有稳定数据：

```bash
mkdir -p "${DSH_HOME:-$HOME/.dsh}/storages/dsh-taskboard"
test -e "${DSH_HOME:-$HOME/.dsh}/storages/dsh-taskboard/boards.json" || \
  cp "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/@suhan-dsh/taskboard/datas/boards.json" \
     "${DSH_HOME:-$HOME/.dsh}/storages/dsh-taskboard/boards.json"
dsh plugin --profile web add @suhan-dsh/taskboard@0.1.2
```

全新安装会直接创建稳定数据目录，不需要迁移。刷新页面、重启 DSH、升级、卸载后重装都不会清空该目录。

卸载插件只停止 Agent handle，不主动删除历史看板数据。运行中任务的 worktree 会保留，以便重新安装后恢复或人工处理。

## 上架状态

- npm 包：`@suhan-dsh/taskboard`（MIT，`publishConfig.access: public`）
- 源码仓库：<https://github.com/ElonYsuhan/suhan-dsh-forge>
- 市场状态：`dsh-marketplace.json#status` 为 `public`；待收录至 awesome-dsh-plugin 后可在 dshmarket 浏览、搜索和一键安装。
- 权限声明：网络仅本地 `/taskboard` 路由；文件系统限看板数据、任务 worktree 与最终串行集成；进程仅以参数数组运行声明的 Git 命令；不读取或保存 secrets。
