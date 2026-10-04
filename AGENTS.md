# AGENTS.md

给在这个仓库里干活的 AI 的说明书，人看也欢迎。**动手前先读「硬规矩」与「关键机制」两节。**

## 这是什么

DSH-X：DeepSeek Harness（`dsh`）的第三方启动器。仓库叫 DSH-X，`package.json` 里的名字是更早的 `dsh-versions`。它启动的是 dsh 官方原版 Web 界面，自己不重做 dsh 的页面。

```
原生外壳   launcher/（Rust）        DSH.exe / DSH-X.app：托盘、窗口、开机自启、单实例
Node 服务  start.js → server.js     管理页后端 + 版本 / 插件 / 整合包 / 同步的全部业务
管理界面   public/index.html        单页手写 HTML + 原生 JS，无框架、无构建步骤
注入钩子   compat/  perf/           被注入 dsh 进程，修补运行时行为（见下）
```

**零第三方运行时依赖**：所有 import 都是 `node:` 内置或相对路径，没有构建步骤。安装包自带 Node 运行时（打包时下载到 `vendor/`），所以不依赖用户机器环境。

## 怎么跑、怎么验

| 命令 | 干什么 |
|---|---|
| `npm start` | 起管理页（开发入口） |
| `npm run server` | 只起网页服务，不开浏览器 |
| `npm test` | 全部用例（`node --test`，41 个文件、300+ 用例，约 16 秒） |
| `node --test test/packs.test.mjs` | 单个用例文件 |
| `npm run dist` | 打安装包（Windows 需 Rust + Inno Setup 6；macOS 需 Rust + Xcode CLT） |
| `node scripts/make-pack.mjs` | 把 `packs/<名字>/` 打成 `.dspack`（产物在 `release/packs/`） |

- **跑测试别把输出接管道**（`| head`、`| tail` 会把输出缓冲成 0 字节，等于白跑）；要留证据就重定向到文件。
- 没有 lint / 格式化配置，**也别加**：风格靠已有代码和这份文档。
- 改造后已无网络代码，三只"假服务器"（`fake-s3` / `fake-webdav` / `fake-proxy`）随同步与代理一起删了。

## 硬规矩

- **改完不要自动 commit、不要自动 `npm run dist`、不要发版。** 改动留在工作区，等用户明确指令；用户习惯自己按功能拆提交。
- commit message 用**中文**。
- README 中英成对改（`README.md` + `README.en.md`）；**改 README 默认是"砍"不是"加"**——用户会周期性说"写得太多"。
- Release notes 照 dsh 官方风格：一行一条、分 2–4 块、挂 `@贡献者`；不写根因、验证过程、安装说明。QQ 群公告压到 400 字符内（只写用户看得见的变化，下载只留落地页一条链接），存一份到 `release/群公告-<版本>.txt`。
- 注释写**为什么**（这个仓库的风格：每个不显然的决定都带一段解释，很多是踩坑记录），用中文；不写逐行翻译代码的注释。
- `release/release-key.pem` 是发版签名私钥：不进仓库、别提交、别把内容打印到日志；动相关流程时提醒用户备份。

## 目录地图

| 路径 | 是什么 |
|---|---|
| `start.js` | 入口：端口与日志、被原生外壳拉起时的窗口信号（`__DSH_SHOW__`） |
| `server.js` | 管理页后端 + 全部业务（最大文件）：HTTP 路由、版本管理、插件安装、整合包、启动失败自愈 |
| `settings.js` | 设置读写；`safe*` 一族是校验函数（端口、路径、代理、语言……都从这过） |
| `registry.js` / `version.js` | `installSpec` 把**内置载荷**铺成版本目录（不再访问 registry）、pnpm 进度解析、版本号比较；`describeNpmFailure` 把 pnpm 的收尾报错换成人话 |
| `plugins.js` | 插件开关：直接改 profile 的 `cordis.patch.yml`，不需要 dsh 在跑 |
| `mcp.js` / `skills.js` | MCP server 与技能的读写、探测、开关 |
| `packs.js` | 整合包：`.dspack`（manifest v5 ZIP）的解析 / 检查 / 安装 / 导出 / 回滚 |
| `zip.js` / `zipfile.js` | zip 的写与读（手写，无依赖） |
| `offline.js` | **离线供给层**：内置本体/插件/整合包在哪、装没装、怎么装；不碰任何网络 API |
| `platform.js` | 平台差异集中地（每用户目录、运行时布局、外壳文件名）；**打包脚本必须跟它保持一致** |
| `plugin-tool.js` | 命令行开关插件（dsh 起不来时的救命工具），有可执行位 |
| `stdio-unblock.cjs` | stdout/stderr 阻塞模式修补（`--require` 注入用） |
| `public/` | 管理界面与看板娘素材（`index.html` 是主体） |
| `scripts/` | 打包（`pack.mjs` / `pack-mac.mjs` / `pack-common.mjs` / `dsh-setup.nsi`）、图标（`make-icons.py`）、落地页素材、发版清单与 SBOM |
| `plugins/` `packs/` | 内置插件与内置整合包（见「关键机制」，**两个目录别合并**） |
| `compat/` `perf/` | 注入 dsh 进程的钩子：兼容修补与加速 |
| `launcher/` | Rust 外壳（`main.rs`、托盘 / 窗口）；自更新已移除 |
| `test/` | 用例与假服务器 |
| `docs/` | GitHub Pages 落地页 + 看板娘设计稿（`mascot-design/`） |
| `assets/` | 图标 master（`icon.png` → `make-icons.py` 出全套） |
| `data/` `release/` `vendor/` | 运行时数据与产物，gitignored，可重建，**不用整理** |

**顶层 .js 平铺是有意的，不是没整理**：安装目录也是平铺的——`scripts/pack-common.mjs` 的 `APP_FILES` 按名字把文件原样拷到安装根，`launcher/main.rs` 也在根上找 `start.js`。要把它们收进 `src/` 得同时改四处（`APP_FILES` 与拷贝目标、`platform.js`/`server.js` 的根路径推导、Rust 的查找路径、`dsh-setup.nsi`）并重新打包验证，别只挪文件。

## 关键机制

### 版本、实例与数据

- 每个 dsh 版本装在数据目录（默认 `%APPDATA%\DSH\data`，设置里可改）的 `versions/<版本>/`。
- **一个「版本 × profile」一个实例**，可以同时跑，各占各的端口：默认给会起 web 的 profile 传 `--port 0`，由系统现挑，启动器再从 dsh 打印的地址里读回真实端口。
- 端口也能手工钉死（控制页那个「端口」输入框 → `settings.json` 的 `instancePorts`，键 `版本@profile`）：钉了就传 `--port <它>`，链接每次启动都一样（书签、手机上的地址才留得住）。钉住的组合起不来时（`EADDRINUSE`）报错要点名端口和占用者。**这是 dsh 实例的端口，跟管理页端口（`port`）是两回事，两者不能撞。**
- dsh 本体数据在 `DSH_HOME`（默认 `~/.dsh`，可配），跨版本共享，所以换版本不用重装插件。
- 启动器自己的设置与日志在 `%APPDATA%\DSH`（macOS 为 `~/Library/Application Support/DSH`）。
- **内置本体要在启动时铺进 `versions/`**（`ensureBundledCore`，`startServer()` 里第一件事）。
  内置载荷在安装目录的 `core/dsh`，而启动器认的是 `<dataDir>/versions/<版本>/node_modules/@deepseek-ai/dsh`。
  早先只有用户**主动点**「安装版本」才会铺设，于是默认状态下 `versions/` 是空的，启动器只能
  找到机器上系统装的那份 dsh —— 内置本体等于白带。铺的同时会把它写进 `config.json` 的
  版本列表最前面（`listedVersions` 是先 config 后磁盘扫描，不写就会被历史版本压过去）。
- **有内置载荷时不再列/不再用系统那份 dsh**：`scanInstalled()` 不追加它，`binPath()` 也不回落
  到它。理由是这个包的价值就在「不依赖机器上装过什么」；把系统那份列成可选项，用户会看到
  两个同版本号的条目、还可能选中机器上那个旧环境（版本号恰好相同时尤其难分辨）。
  没有内置载荷时（源码运行）仍然照旧用系统那份 —— 那会儿它是唯一能用的。
- **默认打开方式是条件化的**（`settings.js` 的 `DEFAULT_OPEN_MODE`）：安装目录里有
  `webview2\msedgewebview2.exe` 就默认 `window`（内嵌窗口），否则回落 `tab`（系统浏览器）。
  口径必须和 `launcher/main.rs` 的 `use_bundled_webview2` 一致，否则会出现「设置页显示内嵌
  窗口、实际却开在浏览器里」这种对不上的状态。只影响没设过这一项的机器 —— 老配置里显式
  存过 `tab` 的仍按它的来。

### profile

dsh 的环境隔离单位。模板名（web / headless / acp / sdk / …）会自动初始化，自定义名必须先有 `package.json`，否则 dsh 拒绝启动。启动器提供切换与开关；插件开关就是往 `cordis.patch.yml` 写 `- id: <行> / disabled: true`，删掉该块即恢复。

### 家目录隔离（shared / isolated）

设置里的「环境隔离」决定**每个 profile 的家目录怎么算**（`settings.js` 的 `resolveDshHome`）：

| 档位 | 每个 profile 的 `DSH_HOME` | 隔离范围 |
| --- | --- | --- |
| `isolated`（**默认**） | `<根>/profiles-home/<profile>` | 版本、插件、技能、预设、配置、**会话**全套各一份 |
| `shared` | `<根>`（大家共用） | 只有插件按 profile 分，会话/配置/凭据共享 |

**★ 两个路径概念必须分清，这是隔离模式最容易搞错的地方：**

- `dshHomeRoot()` —— 用户配的那个目录（默认 `~/.dsh`）。**全局**的东西挂在它下面：
  profile 定义（`<根>/profiles/<name>`，见 `profilesRoot()`）、内置插件副本（`<根>/bundled/`）。
- `homeDir(profile)` —— 某个 profile 的 **dsh 数据家**，就是传给 dsh 子进程的 `DSH_HOME`。
  隔离模式下是 `<根>/profiles-home/<profile>`。

写代码时凡是「profile 清单 / profile 定义 / bundled 插件 / 整合包落盘」一律用前者；
只有「给 dsh 子进程设 `DSH_HOME`、以及 `bundled` 副本该存哪」才用后者。
早先多处默认参数写成 `join(homeDir(), 'profiles')`，共享模式下恰好等于正确位置，
默认一改 isolated 就全错：`listProfiles` 一个都列不出来（报「profile xxx 不存在」）、
插件装进 dsh 不看的目录、整合包写错家。**改这类默认参数前先想清用的是哪个概念。**

**预置插件的时机**：`seedFreeModelPlugins` **不能**再写「profile 不存在就跳过」——
隔离模式下每个 profile 首次都是新家，跳过就等于「第一次启动没插件、第二次才有」。
profile 骨架由 `dsh plugin add` 自己初始化（实测它会打印
`dsh: initialized profile <名> at ...`），所以逐件 add 天然就是「先建后装」的顺序，
不必自己造骨架文件（造了还得跟 dsh 各版本的模板同步，那是给自己找维护负担）。
另外`bootOnce` 里不要再用 `prof === PROFILE_NAME` 限制预置范围：每个 profile 有自己的家，
起哪个就该给哪个装。

恢复档（`recovery.js`，官方 desktop `sanitizeProfile` 的同款语义）：`POST /api/recover` 把补丁层**改名**成 `cordis.patch.yml.bak-<时间戳>`（备份即改名、不解析补丁内容），再按侧车记录摘掉清单里非 `@deepseek-ai/*` 的 bundle；`POST /api/recover/restore` 把备份改回来、现役补丁先挪到新备份、并按侧车放回被摘的 bundle。改补丁层/清单前都过 `withProfileLock`（profile 目录里一个存 PID 的 `lock` 文件，`wx` 独占创建、属主僵死才清理）——与官方锁同名同语义。这是逐行自动禁用都失效时的最后手段；清单 JSON 坏掉时只告警、补丁层照样移走（救援优先，官方是整单失败）。

### 内置插件与内置整合包（两个目录，别合并）

- `plugins/<包名>/` 是**插件实现**（npm 包：`dsh-x-memory`）。启动器首次启动把它们复制到 `$DSH_HOME/bundled/<包名>/`，再以 `file:` 依赖装进 profile（`BUNDLED_PLUGINS` 常量 + `ensureBundledPlugin`）。复制到 DSH_HOME 而不是直接指向安装目录，是为了卸载启动器后依赖不断链。
- 打包时 `plugins/` 还会被采一份到安装目录的 `packages/`（`copyBundledPackages`），那是**离线安装插件的源**：`offline.js` 的 `bundledPluginSpec()` 给出 `file:` 绝对路径，pnpm 零下载装进 profile。
- `packs/dsh-x-recommended/` 是**整合包配方**（`manifest.json` + `dspack.json` + README），**不含代码**；依赖里 `"dsh-x-memory": "bundled"` 会被解析成 `file:$DSH_HOME/bundled/dsh-x-memory`。
- 为什么不能合并：`.dspack` 只认 `overrides/`、`home/`、`profiles/` 与几个根文件，插件源码放进去会被当"不属于整合包"跳过（`packs.js` 的解析）；反过来 `plugins/` 下每个子目录都被当成一个 npm 包。实现只存一份，配方用引用指过来。
- 改了内置插件的代码：**版本号必须跟着变**（复制逻辑按版本判断），而且要重新打包才会更新到用户机器上。

### 注入进 dsh 的钩子（compat / perf）

- `compat/register.mjs`、`perf/register.mjs` 由启动器注入；worker 线程注入的是 `compat/worker-events.cjs`（worker 的 execArgv 是空的，只能靠 NODE_OPTIONS）。
- NODE_OPTIONS 里**只写裸文件名**，目录靠 NODE_PATH 传——NODE_OPTIONS 按空格分词，安装目录带空格会被拆坏。
- dsh 自己的 Node 开关（系统证书库、请求头上限、两个 ESM 补丁钩子）走**命令行参数**，不塞 NODE_OPTIONS：后者会被 dsh 的所有子进程继承，agent 在 shell 里跑的 node 可能是老版本。
- 改会话事件词汇表（`SESSION_TYPES`）要**两处同步**：主线程的 `compat/session-events.mjs` 与 worker 的 `compat/worker-events.cjs` 各有一份副本。

### 打包与安装布局

- `APP_FILES`（`scripts/pack-common.mjs`）= 安装目录里的启动器源码清单；`copyAppFiles` 把它们平铺拷到安装根（macOS 是 `DSH-X.app/Contents/Resources/app/`）。
- 安装目录里还有 `node/`（自带运行时）、`public/`、`assets/`、`compat/`、`perf/`、`plugins/`、`packs/`、`lang.txt`（安装语言）。
- Rust 外壳由 `cargo build` 出 `DSH.exe`，图标走 `build.rs`；Windows 安装包由 **NSIS**（`scripts/dsh-setup.nsi`，`makensis` 编译）打。
- **Rust 工具链必须用 MSVC**（`stable-x86_64-pc-windows-msvc` + VS Build Tools 的 C++ 工作负载），别用 GNU：
  实测 GNU 那条编不过 `cargo build --release` —— 链接阶段 `dlltool.exe` 以 `CreateProcess` 失败（Rust
  自带的 self-contained dlltool 内部还要拉别的 GNU 程序，缺件），最终报 `dlltool could not create
  import library`。**只跑 `cargo check` 看不出来**（它不链接），一上 `--release` 才炸 —— 所以别拿
  `cargo check` 绿了当「Rust 改动没问题」的凭据。另外 `vcvars64.bat` 要先过一遍，MSVC 链接器才在 PATH 上。
- **`.nsi` 必须是带 BOM 的 UTF-8**：makensis 默认按系统 ANSI 代码页读脚本，脚本里的中文注释会让它直接 `Bad text encoding` 退出。`pack.mjs` 的 `ensureNsiUtf8Bom` 在编译前补一次——编辑器、git checkout 都可能把 BOM 抹掉，而报错跟编码八竿子打不着。
- **内置 WebView2 固定版运行时**（可选，`DSH_WEBVIEW2` 指到 CAB 或已摊平的目录才带）：
  - 为什么带：Win10 旧镜像、LTSC、精简系统上未必预装 Evergreen WebView2，缺了它 `DSH.exe` 的内嵌窗口建不出来，界面只能退回系统浏览器（`launcher/main.rs` 的 `create_dsh_window` 返回 None 时就是这条路）。
  - 怎么生效：`DSH.exe` 启动时把 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 指到 `<安装目录>\webview2`（`main.rs` 的 `use_bundled_webview2`）。**必须在建任何 WebView 之前设**——加载器只在首次初始化时读它，所以在 `main()` 最前面而不是建窗函数里。用户自己设过这个变量就不覆盖（那是明确意图）。
  - 体积代价（实测）：官方 CAB 243.5 MB → 解开 **557.4 MB / 168 个文件**；整包因此从约 60 MB 涨到 **183 MB**（LZMA solid，压缩比 32.8%）。所以做成可选。
  - CAB 里套了一层 `Microsoft.WebView2.FixedVersionRuntime.<版本>.<arch>\`：`pack-common.mjs` 的 `copyWebView2Runtime` 在打包期摊平（安装期不用猜版本号），`dsh-setup.nsi` 的 CAB 分支另有 `FindFirst` 剥层兜底，两条路都落到 `webview2\msedgewebview2.exe`。
  - **它故意不进 `release/DSH/`（stage）**：NSIS 的 `File /r /x "..."` 在递归时**不作用于子目录内容**，`/x "webview2"` 和 `/x "webview2\*"` 都实测排不掉（迷你复现里日志照样 `Descending to: ...\webview2\`）。如果 stage 里也有一份，就会主收集一次、WebView2 段再收一次，同一个 557 MB 进包两遍（实测 Install data 冲到 **1.22 GB**，装完反而不对）。所以让它只有一个来源：stage 里没有，由 NSIS 的 `/DWEBVIEW2_DIR` 统一收。
  - 判断「收重了没有」看编译输出的 `Install data`：应当是 **stage + webview2 之和**（当前约 1.19 GB）。数字明显偏大就是重复了。
  - 验证方式：官方托管 SDK 的 `CoreWebView2Environment.CreateAsync(运行时目录, ...)` 能拿到 `BrowserVersionString` 就说明这份运行时可用（要 STA 线程 + 旁边有 `WebView2Loader.dll`，后者由宿主程序带、不属于运行时）。
- **安装范围（仅为我 / 为所有用户）用 NSIS 自带的 `MultiUser.nsh`**，别自己写权限判断：
  - 它负责提权、并在两种模式间切好 `$INSTDIR` 与注册表根（`SHELL_CONTEXT` → HKCU 或 HKLM）。
    所有注册表写入用 `SHELL_CONTEXT`，**不要写死 HKCU**，否则「为所有用户」装的机器上
    「应用和功能」看不到它（那份在 HKLM）。卸载器同样靠 `un.onInit` 里的 `MULTIUSER_UNINIT` 定位。
  - **不要定义 `MULTIUSER_INSTALLMODE_INSTDIR` / `_INSTDIR_REGISTRY_*`**：那两个宏会让 MultiUser
    在 `.onInit` 里**覆盖** `$INSTDIR`，而且不区分「用户是否已经用 /D= 指定过」。后果是
    `/S /CurrentUser /D=D:\somewhere` 静默装到 `%LOCALAPPDATA%\Programs\<AppName>`，退出码还是 0，
    看起来像成功（最小复现实测）。默认目录要自己在 `.onInit` 里「只在 `$INSTDIR == ""` 时」设。
  - **`$COMMONPROGRAMS` / `$COMMONDESKTOP` 这两个变量不存在**：NSIS 编译期只给
    `unknown variable/constant ... detected, ignoring`，然后把它当**字面量**拼进路径 ——
    装完快捷方式落在一个叫 `COMMONPROGRAMS` 的假目录里。公共位置要用 `SetShellVarContext all`
    把 `$SMPROGRAMS` / `$DESKTOP` 的解析目标整体切过去（切完记得 `current` 切回来）。
- 安装包是**一层**（NSIS 直接收 `release/DSH/`），不再是「Rust 外壳 + Inno 内层引擎」两层。`launcher/installer.rs`、`scripts/dsh-setup.iss`、`scripts/installer-engine.iss` 都不再参与打包，留着只为回滚参考；网页安装界面那条路随之撤掉。
- 发版产物：Windows 的 `DSH-Setup.exe` 和 mac 的 dmg 要一起传；清单、签名、SBOM 见 README 的「打包」一节。自更新链路已移除（离线版不发外网请求）。

### 网络与子进程环境

- **不要重新引入外网请求。** 这一版的全部价值就在"离线"：装机器上一个请求都不该发出去。真需要联网的东西，先回到产品层面想清楚要不要做，别顺手加个 fetch。
- 给 dsh 子进程的 PATH 末尾追加运行时的 `.bin` 与写死 node 的 shim，但**用户自己的 pnpm 优先**（见 `orderRuntimePaths`）。store 主版本跟着 pnpm 主版本走（8→v3 / 10→v10 / 11、12→v11），拿错版本去动 profile 会 `ERR_PNPM_UNEXPECTED_STORE`，所以**插件命令**会先按 profile 的 `node_modules/.modules.yaml` 记的 store 挑一次 pnpm（`preferredPnpmDir`/`pickPnpmDir`，挑不出来才回退「系统优先」，并把两边的 store 版本写进日志）。便携兜底那份是 pnpm 11.27.1，版本钉在 `pack-common.mjs` 的 `PNPM_VERSION`，打包时按版本号校验缓存（`vendor/pnpm`）。
- dsh CLI 在参数解析阶段就拒掉保留 profile 名（`desktop`，官方留给自家 Electron 端），两个入口各有一套绕法（`CLI_BLOCKED_PROFILES`）：
  - **启动**：入口换成 `reserved-profile-boot.mjs`（直接调 boot 层，argv 形状与 CLI 一致）。
  - **插件命令**：CLI 只按名字找 profile，所以给原件在同目录建一个目录链接别名（`.dsh-alias-desktop` → `desktop`，`ensureProfileAlias`，Windows 用 junction），命令改指别名 —— 一份目录两个名字，不复制也不漂移。别名以点开头，`listProfiles` 会跳过，界面里只看得到 `desktop`。
  - 两者的理由与边界：真名 `desktop` 永远留给官方桌面端（别去改它的目录内容），启动器只是换入口/换名字去用同一份数据。
- 离线版不给 dsh 子进程传 registry / 代理环境变量：插件全部来自内置载荷的 `file:` 依赖，pnpm 连不上任何源才是期望状态。

## 改代码时容易踩的

- **Node 22.19：注册过 ESM 钩子后 `error.stack` 变成只读**（`writable: false`）。dsh 的 app-boot 会写 `error.stack = ...`，一写就抛 `TypeError`，把原始错误码顶掉。`compat/session-events.mjs` 已把它包进 try/catch，**别去掉**。
- **插件 import 失败会让 dsh 秒退**（插件树的单点故障）。涉及 profile 依赖、补丁层的改动要格外保守，改完用 `plugin-tool.js list` 或真启动一次验证。
- **Windows 的 junction**：pnpm 用 junction 指向 `.pnpm`，目标被删就悬空，读目录会报 `UNKNOWN ... -4094`；还有一类机器根本读不了 junction。两条退路都在 `server.js`（清理悬空链接、让 pnpm 不用链接），清理时要扫进 `@scope` 一层。
- 管理页端口每次启动可能变（被占用会顺延）：旧链接 401、旧标签页里"插件包加载失败"都是正常现象，不用"修"。
- cookie 堆到 16 KB 会让全站 `HTTP 431`：给 cookie 加内容前先算总量。
- 测试输出别接管道（会说第二遍，因为真有人踩）。
- `data/`、`release/`、`vendor/` 里的东西可以随便清（都是产物），但 `release/release-key.pem` 除外。
