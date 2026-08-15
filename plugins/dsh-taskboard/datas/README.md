# datas

任务看板本地运行数据目录。

- `boards.json` — 看板文档（首次访问由 Host 端自动创建）
- 路径可配置：设置环境变量 `DSH_TASKBOARD_DATA` 指向其他文件即可迁移
- `*.json` 是本地状态，不进入 Git，也不会被打入 npm/tgz 发布包。
