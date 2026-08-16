# @suhan-dsh/virtual-companion

DeepSeek Harness Web 客户端插件：**可拖拽 3D 虚拟伙伴**，可出现在 DSH Web 任意位置，支持模型切换、鼠标悬浮互动和语音聊天。

> 当前状态：`internal`，仅供隔离开发验证，未公开发布。

## 形态

- **浏览器半**（`src/client/`）
  - `shell.overlay` 条目：全页面浮动 3D 伙伴
  - 拖拽位置与当前模型保存到 `localStorage`
  - 鼠标悬浮时播放动画/气泡反馈
  - 语音聊天：浏览器 `SpeechRecognition` 转文字，`speechSynthesis` 朗读回复；不支持时回退文字输入
- **Node 半**（`src/index.ts`）
  - `GET /virtual-companion/health`：健康检查
  - `POST /virtual-companion/chat`：接收文字，使用 DSH 当前默认模型生成回复
  - 对话历史上限 20 条，仅存于 Host 内存，不落盘

## 配置

当前无配置项。默认模型跟随 DSH Web 当前选择的模型。

## 开发命令

```bash
pnpm --filter @suhan-dsh/virtual-companion install
pnpm --filter @suhan-dsh/virtual-companion typecheck
pnpm --filter @suhan-dsh/virtual-companion test
pnpm --filter @suhan-dsh/virtual-companion build
pnpm --filter @suhan-dsh/virtual-companion pack:check
```

## 安装

```bash
pnpm --filter @suhan-dsh/virtual-companion build
pnpm --filter @suhan-dsh/virtual-companion run pack
dsh plugin --profile web add /absolute/path/to/suhan-dsh-forge/artifacts/suhan-dsh-virtual-companion-0.1.0.tgz
```

安装或更新后需重启 `dsh web`。

## 验证

- `pnpm --filter @suhan-dsh/virtual-companion test`
- 根目录 `pnpm check`
- 浏览器人工验证：3D 渲染、模型切换、拖拽、悬浮互动、语音聊天与文字回退

## 卸载

```bash
dsh plugin --profile web remove @suhan-dsh/virtual-companion
```

卸载会移除 Host 路由、Client slot、Three.js 渲染器和语音会话资源；`localStorage` 中的位置/模型偏好默认保留。

## 数据

- 浏览器 `localStorage`：`suhan-dsh-virtual-companion-position`、`suhan-dsh-virtual-companion-model`
- Host 内存：最近 20 条聊天消息，服务重启即清空
- 不读取、不写入文件系统，不保存 secrets

## 权限

- `network`：仅本地 `/virtual-companion` HTTP 路由前缀
- `filesystem`：无
- `process`：无
- `secrets`：无

## 兼容范围

- DSH：`>=0.1.0-rc.6 <0.2.0`
- Node.js：`^22.19.0 || >=24.0.0`
- Profile：`web`
- 浏览器：需支持 WebGL 与 Web Speech API（语音输入不支持时自动回退文字输入）
