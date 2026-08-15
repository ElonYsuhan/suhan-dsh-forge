# datas

任务看板本地运行数据目录。

- `boards.json` — 旧版本包目录数据，仅作为非破坏迁移源；新数据不再默认写入此处
- 当前默认路径：`$DSH_HOME/storages/dsh-taskboard/boards.json`
- 路径可配置：设置环境变量 `DSH_TASKBOARD_DATA` 指向其他文件
- `*.json` 是本地状态，不进入 Git，也不会被打入 npm/tgz 发布包。
