# Changelog

## 0.1.0 (unreleased)

- 新增 DSH Web 虚拟伙伴插件。
- 提供 Three.js 3D 透明浮空人物、拖拽移动和单击语音聊天。
- 只保留“人物”一个模型，移除模型/语音/聊天操作面板。
- 单击人物后模型主动提问，用户语音回答，形成连续语音对话。
- 语音优化：弃用浏览器低质量 `speechSynthesis`，改为 Host 通过开源 `msedge-tts` 调用 Microsoft Edge 神经网络语音合成中文语音。
