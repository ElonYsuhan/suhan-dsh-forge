# Changelog

## 0.1.0 (unreleased)

- 新增 DSH Web 虚拟伙伴插件。
- 提供 Three.js 3D 透明浮空人物、拖拽移动、单击语音聊天和双击设置面板。
- 设置面板支持人物角色（贴心伙伴/知性学姐/元气少女/高冷男神/软萌小猫）、聊天背景、六种音色切换和流式实时回复开关。
- 实时优化：新增 `/virtual-companion/chat/stream` SSE 按句流式回复，客户端边生成边朗读，降低聊天等待感。
- 实时优化：SSE 增加 token 增量即时上屏，新增 `GET /virtual-companion/tts/stream` 流式 MP3，`msedge-tts` 边合成边播放，不再等整句音频缓冲完成。
- 置顶优化：虚拟人物浮层固定视口并使用最高 `z-index`，始终保持在 DSH 页面最上层。
- 只保留“人物”一个模型，移除模型切换面板。
- 单击人物后模型主动提问，用户语音回答，形成连续语音对话。
- 语音优化：弃用浏览器低质量 `speechSynthesis`，改为 Host 通过开源 `msedge-tts` 调用 Microsoft Edge 神经网络语音合成中文语音。
