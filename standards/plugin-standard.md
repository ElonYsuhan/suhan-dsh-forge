# DSH 插件门禁规范（兼容入口）

本文件保留为旧链接入口。完整规范及任务路由见 [`README.md`](README.md)。

任何插件至少必须满足以下基线：

- `BASE-*`：包结构、TypeScript、ESM、公共入口与宿主依赖；
- `LIFE-*`：Cordis 注册可逆、Host/Client 边界和卸载清理；
- `META-*`：`package.json`、`cordis.patch.yml`、市场元数据与权限声明一致；
- `SEC-*`：最小权限、输入边界、凭证与运行数据保护；
- `TEST-*` / `REL-*`：源码测试、契约测试、构建、包内容和真实安装验证。

提交前运行：

```bash
pnpm check
```

公开上架还必须通过 [`05-testing-release.md`](05-testing-release.md) 的发布清单；`private: true` 或 `UNLICENSED` 的包不得公开发布。
