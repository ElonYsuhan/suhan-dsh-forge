# @suhan-dsh/virtual-companion

DeepSeek Harness Web 客户端插件：**可拖拽 3D 虚拟伙伴**，可出现在 DSH Web 任意位置，支持模型切换、透明浮空效果、鼠标悬浮互动和多风格语音聊天。

> 当前状态：`internal`，仅供隔离开发验证，未公开发布。

## 形态

- **浏览器半**（`src/client/`）
  - `shell.overlay` 条目：全页面透明浮空 3D 伙伴（无背景卡片/边框，直接悬浮在页面上）
  - 拖拽位置、当前模型和语音风格保存到 `localStorage`
  - 鼠标悬浮时播放动画/气泡反馈
  - 语音聊天：浏览器 `SpeechRecognition` 转文字，客户端请求 Host 合成并播放高自然度神经网络语音；支持自然、高冷、萝莉、御姐、少年、磁性等语音风格；不支持语音输入时回退文字输入
- **Node 半**（`src/index.ts`）
  - `GET /virtual-companion/health`：健康检查
  - `POST /virtual-companion/chat`：接收文字，使用 DSH 当前默认模型生成回复
  - `POST /virtual-companion/tts`：通过开源 `msedge-tts` 客户端调用 Microsoft Edge 神经网络语音合成中文 MP3，返回给浏览器播放
  - 对话历史上限 20 条，仅存于 Host 内存，不落盘

## 配置

- 模型跟随 DSH Web 当前选择的模型；3D 外观可在浮层内切换。
- 语音风格在聊天面板中切换，选项包括自然、高冷、萝莉、御姐、少年、磁性。
- 语音由 Host 通过开源 `msedge-tts` 客户端调用 Microsoft Edge 神经网络语音合成；客户端只负责播放 MP3，不再依赖浏览器本地的 `speechSynthesis` 音色。

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
- 浏览器人工验证：3D 透明浮空渲染、模型切换、拖拽、悬浮互动、语音风格切换、语音聊天与文字回退

## 卸载

```bash
dsh plugin --profile web remove @suhan-dsh/virtual-companion
```

卸载会移除 Host 路由、Client slot、Three.js 渲染器、语音识别和语音合成资源；`localStorage` 中的位置/模型/语音风格偏好默认保留。

## 数据

- 浏览器 `localStorage`：`suhan-dsh-virtual-companion-position`、`suhan-dsh-virtual-companion-model`、`suhan-dsh-virtual-companion-voice`
- Host 内存：最近 20 条聊天消息，服务重启即清空
- 不读取、不写入文件系统，不保存 secrets

## 权限

- `network`：本地 `/virtual-companion` HTTP 路由前缀；Host 向 Microsoft Edge Read Aloud TTS WebSocket（`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`）发起语音合成请求
- `filesystem`：无
- `process`：无
- `secrets`：无

## 兼容范围

- DSH：`>=0.1.0-rc.6 <0.2.0`
- Node.js：`^22.19.0 || >=24.0.0`
- Profile：`web`
- 浏览器：需支持 WebGL；语音输入依赖 Web Speech API，不支持时自动回退文字输入；语音播放依赖浏览器 `Audio` 播放能力
