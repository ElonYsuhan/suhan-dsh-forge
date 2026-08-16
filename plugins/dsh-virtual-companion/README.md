# @suhan-dsh/virtual-companion

DeepSeek Harness Web 客户端插件：**透明浮空 3D 虚拟人物**，可拖拽到页面任意位置，无操作面板；单击人物即开始由模型主动提问的语音聊天。

> 当前状态：`internal`，仅供隔离开发验证，未公开发布。

## 形态

- **浏览器半**（`src/client/`）
  - `shell.overlay` 条目：全页面透明浮空 3D 人物（只保留“人物”一个模型）
  - 无模型/语音/聊天操作面板；鼠标按住拖动即可移动，单击开始或停止语音聊天
  - 单击后由 Host 调用 DSH 当前默认模型生成开场问题并朗读，随后自动聆听用户语音回答，形成连续语音对话
- **Node 半**（`src/index.ts`）
  - `GET /virtual-companion/health`：健康检查
  - `POST /virtual-companion/opening`：让模型主动生成一句开场问候/问题
  - `POST /virtual-companion/chat`：接收用户语音转写的文字，使用 DSH 当前默认模型生成回复
  - `POST /virtual-companion/tts`：通过开源 `msedge-tts` 客户端调用 Microsoft Edge 神经网络语音合成中文 MP3，返回给浏览器播放
  - 对话历史上限 20 条，仅存于 Host 内存，不落盘

## 配置

- 当前无配置项。模型跟随 DSH Web 当前选择的模型；3D 外观固定为“人物”。
- 语音固定使用默认真人感中文神经网络音色，不提供切换面板。
- 语音输入依赖浏览器 Web Speech API；浏览器不支持时单击会提示并无法开启语音聊天。

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
dsh plugin --profile web add /absolute/path/to/suhan-dsh-forge/artifacts/dsh-virtual-companion/suhan-dsh-virtual-companion-0.1.0.tgz
```

安装或更新后需重启 `dsh web`。

## 验证

- `pnpm --filter @suhan-dsh/virtual-companion test`
- 根目录 `pnpm check`
- 浏览器人工验证：3D 透明浮空人物渲染、拖拽移动、单击开始语音、模型主动提问、语音回答、连续对话、再次单击停止

## 卸载

```bash
dsh plugin --profile web remove @suhan-dsh/virtual-companion
```

卸载会移除 Host 路由、Client slot、Three.js 渲染器、语音识别和语音合成资源；`localStorage` 中的位置偏好默认保留。

## 数据

- 浏览器 `localStorage`：`suhan-dsh-virtual-companion-position`
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
- 浏览器：需支持 WebGL；语音输入依赖 Web Speech API，不支持时无法开启语音聊天；语音播放依赖浏览器 `Audio` 播放能力
