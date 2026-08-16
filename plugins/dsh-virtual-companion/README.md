# @suhan-dsh/virtual-companion

DeepSeek Harness Web 客户端插件：**始终置顶的高清立绘虚拟伙伴**，可拖拽到页面任意位置；单击人物即开始由模型主动提问的语音聊天，双击人物打开设置面板。

> 当前状态：`internal`，仅供隔离开发验证，未公开发布。

## 形态

- **浏览器半**（`src/client/`）
  - `shell.overlay` 条目：始终置顶的全页面立绘虚拟伙伴（打包在插件内的 PNG 立绘，说话时轻轻浮动）
  - 鼠标按住拖动即可移动，单击开始或停止语音聊天，双击打开设置面板
  - 设置面板支持人物角色、背景信息、女声音色和流式实时回复
  - 聊天时右上角显示 🤔，不显示说话文字；说话时人物轻轻浮动，说完恢复
  - 单击后由 Host 调用 DSH 当前默认模型生成开场问题并朗读，随后自动聆听用户语音回答，形成连续语音对话
- **Node 半**（`src/index.ts`）
  - `GET /virtual-companion/health`：健康检查
  - `POST /virtual-companion/opening`：让模型主动生成一句开场问候/问题
  - `POST /virtual-companion/chat`：接收用户语音转写的文字，使用 DSH 当前默认模型生成回复
  - `POST /virtual-companion/chat/stream`：SSE 流式返回 token 增量与按句切分的回复，客户端不展示说话文字，语音按句朗读
  - `POST /virtual-companion/tts`：通过开源 `msedge-tts` 客户端调用 Microsoft Edge 神经网络语音合成中文 MP3，返回给浏览器播放
  - `GET /virtual-companion/tts/stream`：`msedge-tts` 流式 MP3 输出，浏览器边合成边播放，避免等整句音频生成完再开始
  - 对话历史上限 20 条，仅存于 Host 内存，不落盘

## 配置

- 双击人物打开设置面板，设置保存在浏览器 `localStorage`，下次打开自动生效。
- 人物角色：内置贴心伙伴、知性学姐、元气少女、高冷御姐、软萌小猫，角色只影响 Host 端系统提示词。
- 人物形象：插件内置高清立绘，无需选择。
- 背景信息：文本框由用户自己填写，会作为当前场景背景信息随聊天请求发送给模型。
- 音色：甜美、温柔、可爱、御姐、知性、元气六种 Edge 神经网络中文女声音色，区别明显。
- 流式实时回复：开启后 SSE 先回传 token 增量用于低延迟推进，再按句返回完整句子；音频通过 `msedge-tts` 流式输出，边合成边播放，显著降低等待感；聊天状态以右上角 🤔 为主，不显示说话文字。
- 模型跟随 DSH Web 当前选择的模型；外观固定为插件内置立绘。
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
- 浏览器人工验证：人物始终置顶、立绘渲染、拖拽移动、单击开始语音、双击打开设置、切换角色/音色/背景信息/实时开关、说话轻轻浮动并恢复、右上角 🤔、模型主动提问、语音回答、连续对话、再次单击停止

## 卸载

```bash
dsh plugin --profile web remove @suhan-dsh/virtual-companion
```

卸载会移除 Host 路由、Client slot、Three.js 渲染器、语音识别和语音合成资源；`localStorage` 中的位置与设置默认保留。

## 数据

- 浏览器 `localStorage`：`suhan-dsh-virtual-companion-position`、`suhan-dsh-virtual-companion-settings`
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
