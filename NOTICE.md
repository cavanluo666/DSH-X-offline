# 许可与来源说明（Licensing and Provenance）

本项目是 **[yyh-001/DSH-X](https://github.com/yyh-001/DSH-X)** 的衍生作品。

## 来源

上游项目 **DSH-X** 由 **yyh** 创作，以 **MIT 许可证**发布：

```
MIT License

Copyright (c) 2026 yyh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

上述 MIT 声明按要求完整保留。上游的 MIT 条款允许再许可（sublicense），
因此本衍生作品整体以 **GPL-3.0-or-later** 发布（见 [`LICENSE.gpl`](LICENSE.gpl)）。

## 本衍生作品的许可

```
Copyright (C) 2026 LCH          （本版本的修改）
Copyright (C) 2026 yyh          （原始项目）
```

以 **GNU General Public License v3.0 or later** 发布，完整条款见
[`LICENSE.gpl`](LICENSE.gpl)。SPDX 标识符：`GPL-3.0-or-later`。

## 本版本的主要改动

相对上游 DSH-X，本版本做了这些修改（详见提交历史）：

- 改造为**离线版**：移除全部外网请求（版本拉取、插件市场、自更新、同步、代理），
  自带 Node 运行时、dsh 本体、内置插件与 pnpm 缓存。
- 新增**离线供给层**（`offline.js`）与整合包（`.dspack`）的本地安装 / 导出 / 回滚。
- 启动时把内置本体铺设进 `versions/`（`ensureBundledCore`），并修正
  `shared` / `isolated` 两种家目录隔离模式下的路径推导。
- 修复测试目录错位问题（原先 `test/test/` 的重复副本导致整套用例失败）。

## 内置的第三方组件

本仓库的 `plugins/` 目录内包含若干**第三方插件**，各自保留其原始许可证：

| 插件 | 版权人 / 许可证 |
| --- | --- |
| `dsh-our-free-model` | Copyright (c) 2026 zouyuxuan122 · MIT |
| `dsh-whale-widget` | Copyright (c) 2026 MeteorNOX · MIT |
| `dsh-workbuddy-connect` | Copyright (c) 2026 Corrine Hu · MIT |
| `dsh-omniroute-connect` | MIT |
| `dsh-small-model-delegate` | 见其目录内说明 |

这些 MIT 组件与 GPLv3 兼容，可随本作品一同分发；它们的版权声明不得移除。

其他第三方组件：

- **NSIS**（安装包编译器）采用 [zlib/libpng 许可](https://nsis.sourceforge.io/License)。
- **Rust crate 依赖**见 `launcher/Cargo.lock`；其许可证清单可用
  `node scripts/release-sbom.mjs` 生成 SPDX SBOM 查看。
