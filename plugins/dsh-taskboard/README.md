# @suhan-dsh/taskboard

DeepSeek Harness Web 客户端插件：**项目级需求追溯看板**，左侧「新会话」下方的「看板」按钮切换右侧主工作台，任务可与聊天页 agent 会话联动执行。

## 形态

- **浏览器半**（`src/client/`）
  - `shell.overlay` 条目：侧栏看板入口 + 右侧全尺寸工作台（项目切换 / 自定义环节列 / 拖拽流转 / 工作项详情与需求追溯时间线 / 执行 / 看板设置）
  - `conversation.input.left` 条目：聊天页 composer「＋待办」按钮，对话中直接创建待办任务到项目看板
  - 会话联动：工作项详情「执行」下发任务到 agent 会话；点击「打开会话」或左侧任一会话时，关闭看板并切回聊天页
- **Node 半**（`src/index.ts`）
  - `/taskboard` REST：项目看板 CRUD、工作项 CRUD、自定义环节/类型设置、执行
  - **执行**：工作项首次执行创建一个完整 Agent + Session（使用 Web profile 当前模型与默认 Agent preset，`cwd`=项目路径），后续审核、退回、重试始终复用同一会话
  - **agent 工具 `taskboard_progress`**：汇报环节完成、阻塞、待交付和已提交；看板每 3 秒刷新执行状态
  - 数据落盘 `datas/boards.json`（按 projectKey 分看板，首次访问自动建种子）

## 工作项模型

- 类型：史诗 / 需求 / 任务 / 缺陷（可自定义），`parentId` 构成追溯树
- 环节：默认八阶段（待办 → 分析 → 排期 → 开发 → 测试 → 验收 → 上线 → 完成），可自定义
- 追溯：每个工作项的 `timeline` 记录创建 / 流转 / 执行 / 备注全历史
- 删除：卡片在任意状态都可删除；执行过的任务会先停止 Agent、恢复执行前 Git 基线，再归档关联会话并移出看板
- 强制关闭：首次执行前保存 Git 工作树基线；人工强制关闭时中断 Agent、恢复任务前文件与暂存状态，再归档会话和卡片

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
  → Agent 运行最终检查并只提交本任务代码
  → taskboard_progress(delivered, commitRef)
  → DSH 会话归档 + 卡片归档（会话日志与时间线保留）
```

约束：人工确认最终交付前，Agent 不得创建 Git 提交。若质量检查、改动隔离或提交失败，工作项进入阻塞状态，不会假归档。

强制关闭仅在任务执行期间 `HEAD` 未变化时自动回退；若检测到新提交，会停止回退并保留卡片为失败状态，避免误撤销其他任务或人工提交。

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

```bash
pnpm --filter @suhan-dsh/taskboard build
pnpm --filter @suhan-dsh/taskboard run pack
dsh plugin --profile web add /abs/path/to/suhan-dsh-forge/artifacts/suhan-dsh-taskboard-0.1.0.tgz
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

- 文件：`datas/boards.json`（本地运行状态，不进入 Git 或发布包）
- 迁移：设置 `DSH_TASKBOARD_DATA=<绝对路径>` 覆盖存储位置

## 上架状态

当前包保持 `private: true` 和 `UNLICENSED`，只允许内部安装测试。公开上架前必须确定 npm 包名、源码仓库、维护者与许可证，再解除发布门禁。
