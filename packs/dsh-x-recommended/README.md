# DSH-X 推荐整合包

DSH-X 挑出来的一套开箱可用插件。**装它 = 得到一个独立 profile**（默认名 `dshx`），和现有环境互不打扰；装完在插件页切过去、重启 dsh 即可。

这份包随安装包一起发出（`packs/dsh-x-recommended`），插件页的「内置整合包」那一栏点一下就装，**全程不联网**。

## 里面有什么

| 插件 | 干什么 | 为什么选它 |
|---|---|---|
| [`dsh-config-manager`](https://github.com/xiajiajun516/dsh-config-manager) | 配置的备份 / 恢复 / 导出 / 导入 / 迁移 / 多机同步：设置、插件清单、MCP server、技能、Agent 预设、工作区，凭据可选且加密；通道支持本地目录与 ZIP | 这类插件里覆盖最全、维护最活跃（月下载一万多），有独立的设置页入口 |
| [`dsh-x-memory`](https://github.com/yyh-001/DSH-X) | 文件式长期记忆：一条事实一个 Markdown 文件 + `MEMORY.md` 索引，按工作区分开存放，会话开始时把索引注入上下文；模型用六个 `memory_*` 工具读写，设置页里能直接看、改、删 | DSH-X 自带的那件（随安装包发，清单里写 `bundled`，不需要联网装）；文件就是记忆本体，随时可看可改可进 git |

> 一句话：记忆在本地、配置可迁移。自带的那件随安装包发（`bundled`），不依赖 npm 与网络。

## 怎么装

**本地文件**：把 `.dspack` 拖进插件页的「整合包」区（或点安装选文件）；内置的那份直接在「内置整合包」那一栏点。

装之前会先把「要装什么、要改哪些文件、什么不会装（凭据 / `.npmrc` / 整机设置一律不落盘）」列给你看，确认了才动手；装失败会自动回滚。

> 这一版去掉了「直链」与「GitHub 仓库」两种装法：它们都要联网去取 Release 资产，与「全程离线」冲突。要装别处的包，先在本机把 `.dspack` 存下来，再选本地文件。

## 想往里加插件

改 `manifest.json` 两个地方就行：`dependencies` 加一行「包名 → 版本」，`bundles` 加一行包名（`bundles` 决定 dsh 会不会加载它——包自身必须声明 `dsh.bundle`，否则 dsh 起不来）。版本建议钉 `^x.y.z`，别写 `latest`。

`dsh-x-memory` 用的是另一种写法：`"dsh-x-memory": "bundled"`。它表示「安装包自带这件插件」——安装时启动器把 `<安装目录>/plugins/dsh-x-memory` 复制到 `$DSH_HOME/bundled/` 再按 `file:` 路径装进 profile，所以不需要联网、也不怕卸载启动器之后断链。

## 自己打包

```sh
node scripts/make-pack.mjs packs/dsh-x-recommended     # 产出 release/packs/<name>-<version>.dspack
```
