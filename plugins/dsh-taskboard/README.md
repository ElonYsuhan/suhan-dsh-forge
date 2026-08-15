# @suhan-dsh/taskboard

DeepSeek Harness Web 客户端插件：**项目级需求追溯看板**，左侧「新会话」下方的「看板」按钮切换右侧主工作台，任务可与聊天页 agent 会话联动执行。

## 形态

- **浏览器半**（`src/client/`）
  - `shell.overlay` 条目：侧栏看板入口 + 右侧全尺寸工作台（项目切换 / 自定义环节列 / 拖拽流转 / 工作项详情与需求追溯时间线 / 执行 / 历史任务 / 看板设置）
  - `conversation.input.left` 条目：聊天页 composer「＋待办」按钮，对话中直接创建待办任务到项目看板
  - 会话联动：工作项详情「执行」下发任务到 agent 会话；点击「打开会话」或左侧任一会话时，关闭看板并切回聊天页
- **Node 半**（`src/index.ts`）
  - `/taskboard` REST：项目看板 CRUD、工作项 CRUD、自定义环节/类型设置、执行
  - **并行执行**：首次执行创建独立 Git worktree、任务分支和完整 Agent + Session（使用 Web profile 当前模型与默认 Agent preset，`cwd`=任务 worktree）；不同任务不共享文件目录
  - **自动提交与集成**：人工确认交付后由插件生成单任务提交；同一仓库的最终集成在短时互斥锁内先 rebase 最新目标分支，再以 `ff-only` 更新主工作区
  - **冲突编排**：无法自动集成时保留源提交和分支、归档原任务，并自动创建关联的「处理集成冲突」任务
  - **agent 工具 `taskboard_progress`**：汇报环节完成、阻塞和待交付；看板每 3 秒刷新执行状态
  - 数据落盘 `$DSH_HOME/storages/dsh-taskboard/boards.json`；任务 worktree 位于同一运行数据目录的 `worktrees/`

## 工作项模型

- 类型：史诗 / 需求 / 任务 / 缺陷（可自定义），`parentId` 构成追溯树
- 环节：默认八阶段（待办 → 分析 → 排期 → 开发 → 测试 → 验收 → 上线 → 完成），可自定义
- 追溯：每个工作项的 `timeline` 记录创建 / 流转 / 执行 / 备注全历史
- 删除：卡片在任意状态都可删除；新任务会停止 Agent 并只删除自己的 worktree/分支，旧 checkpoint 任务继续使用兼容回退
- 强制关闭：中断 Agent 并清理任务隔离目录，不修改其他任务或项目主工作区
- 历史：右上角「历史任务」按需分页展示当前工作区归档记录，包括结果、提交 SHA 和冲突任务关联；常规 3 秒轮询不携带历史数据

## 执行与审核工作流

创建工作项时选择执行方式：

- **小任务 · AI 自主推进**：每个 Agent turn 最多结算一个环节；当前 turn 完全停稳后才自动流转，并由插件另发下一环节的新 turn。全部环节完成后仍必须等待人工确认最终交付。
- **重大任务 · 每环节人工审核**：Agent 每完成一个环节便暂停。人工可在看板批准并进入下一环节，或退回原会话修订。

执行生命周期：

```text
创建工作项
  → 执行（创建并关联唯一 DSH 会话）
  → 环节产出
      ├─ 小任务：自动推进
      └─ 重大任务：人工批准 / 退回
  → 交付物就绪
  → 人工确认最终交付
  → 插件自动暂存任务 worktree 的全部变化并创建单任务提交
  → 仓库级集成锁内 rebase 最新目标分支 + ff-only 集成
      ├─ 成功：DSH 会话归档 + 卡片进入历史任务
      └─ 冲突：保留源提交/分支 + 自动创建冲突处理任务
```

约束：Agent 全程不得创建 Git 提交、切换分支或操作项目主工作区。若质量检查、改动隔离或自动提交失败，工作项进入阻塞状态，不会假归档。即使没有文件变化，插件也会生成一条空审计提交，使历史任务与 Git 记录一一对应。

## 并行与 Git 前置条件

- 启动新任务时项目必须位于正常分支且主工作区干净；否则拒绝启动，要求先提交或 stash 人工改动。
- 不同任务的 Agent 和文件写入完全隔离；只有最终集成会短暂串行。
- 集成时若用户切换目标分支、修改主工作区或其他进程推进分支，插件停止自动集成并创建冲突处理任务，绝不覆盖现场。
- 冲突处理任务基于最新目标分支创建新 worktree，并按指令使用 `git cherry-pick --no-commit <sourceCommit>` 重放变化；解决后仍由插件统一提交。

## 构建

```bash
pnpm install
pnpm --filter @suhan-dsh/taskboard typecheck
pnpm --filter @suhan-dsh/taskboard test
pnpm --filter @suhan-dsh/taskboard build
pnpm --filter @suhan-dsh/taskboard pack:check
```

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
dsh plugin --profile web add /abs/path/to/suhan-dsh-forge/artifacts/suhan-dsh-taskboard-0.1.2.tgz
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
- 任务隔离目录：`$DSH_HOME/storages/dsh-taskboard/worktrees/`（运行时创建；成功、删除或强制关闭后清理，冲突时保留源 Git 分支）
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
