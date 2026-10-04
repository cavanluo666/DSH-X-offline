import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

/** Windows（pack.mjs）和 macOS（pack-mac.mjs）两套打包共用的部分：拷哪些文件、pnpm 从哪来。 */

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
export const NODE_VERSION = process.env.DSH_NODE_VERSION || '22.19.0'
// 便携目录兜底的那份 pnpm：要读得动现代 profile —— lockfile 9.0、pnpm-workspace.yaml
// 里的设置（后者 pnpm 10.6 起才认）。store 主版本也跟着 pnpm 主版本走（8→v3、10→v10、
// 11/12→v11），8.x 那份拿到 v11 store 的 profile 上会以 ERR_PNPM_UNEXPECTED_STORE 拒绝一切安装。
const PNPM_VERSION = process.env.DSH_PNPM_VERSION || '11.27.1'
export const VENDOR = join(ROOT, 'vendor')
export const NODE_MIRRORS = [
  'https://npmmirror.com/mirrors/node',
  'https://nodejs.org/dist',
]

/** 启动器自己的源码文件（安装目录顶层）。 */
const APP_FILES = [
  'start.js',
  'server.js',
  'registry.js',
  'settings.js',
  'platform.js',
  'plugins.js',
  'recovery.js',
  'packs.js',
  'zip.js',
  'mcp.js',
  'skills.js',
  'version.js',
  'zipfile.js',
  'plugin-tool.js',
  'reserved-profile-boot.mjs',
  'stdio-unblock.cjs',
  'package.json',
  // 离线供给层：判断内置本体/插件/整合包在哪、怎么装，本文件只搬文件，逻辑在它里面
  'offline.js',
]
// 改造中移除的模块（proxy.js / sync.js / pack-market.js）不再进安装包；
// 上面的清单就是权威，别在别处再维护一份。
// 不装进安装包的 public 素材（文件留在仓库里备回滚；要重新启用就从这份名单去掉）
const SKIP_PUBLIC = new Set([
  'head-v2.png', 'accessories-v2.png', 'ear.png',
  // v7 换装（docs/mascot-design/compose-v7.py）后退役的原版素材
  'base.png', 'base-dark.png', 'base-dark-soft.png', 'tuft.svg', 'tuft-dark.svg', 'bow.svg', 'bow-dark.svg',
  // v8 排布（docs/mascot-design/prepare-v8.py）后退役的 v7 均匀倍率版
  'head-v7.png', 'tuft-v7.png', 'bow-v7.png', 'ear-v7.png',
])

export function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: false })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

/**
 * 解 CAB 的可靠工具：优先 7z（完整、稳定），其次系统 bsdtar。
 *
 * 为什么绕开 expand 与裸 tar：
 *   - expand <cab> -F:* 实测只解出开头 2 个文件，557MB 的 CAB 解不全；
 *   - PATH 里的 tar 可能是 Git for Windows 的 GNU tar（不支持 cab）；
 *   - 显式 System32\tar.exe（bsdtar）在 CI 的 Windows runner 上偶发静默失败
 *     （status 0、无输出、目录空），难以定位。
 * 7z 在这三处都验证过：一条命令完整解出 168 个文件。
 */
function findCaber() {
  if (process.platform !== 'win32') return null
  const candidates = [
    join('C:', 'ProgramData', 'chocolatey', 'bin', '7z.exe'),
    join('C:', 'Program Files', '7-Zip', '7z.exe'),
    join('C:', 'Program Files (x86)', '7-Zip', '7z.exe'),
  ]
  for (const p of candidates) if (existsSync(p)) return p
  return null
}

function extractCab(cab, dest) {
  const seven = findCaber()
  if (seven) {
    run(seven, ['x', cab, `-o${dest}`, '-y'])
    return
  }
  // 兜底：系统 bsdtar（Windows 10+ 自带，支持 cab）
  const sysroot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  run(join(sysroot, 'System32', 'tar.exe'), ['-xf', cab, '-C', dest])
}

export async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status} ${url}`)
  await pipeline(res.body, createWriteStream(dest))
}

/** 依次试各个镜像下载 node 发行包的某个文件。 */
export async function downloadNodeFile(file, dest) {
  let last
  for (const mirror of NODE_MIRRORS) {
    const url = `${mirror}/v${NODE_VERSION}/${file}`
    try {
      console.log(`下载 ${url}`)
      await download(url, dest)
      return
    } catch (error) {
      last = error
    }
  }
  throw last
}

/** 把启动器的源码和静态资源拷进 out（node 运行时和原生外壳由各平台自己放）。 */
export async function copyAppFiles(out) {
  await mkdir(join(out, 'public'), { recursive: true })
  await mkdir(join(out, 'assets'), { recursive: true })
  for (const file of APP_FILES) {
    await copyFile(join(ROOT, file), join(out, file))
  }
  await cp(join(ROOT, 'public'), join(out, 'public'), {
    recursive: true,
    filter: (src) => !SKIP_PUBLIC.has(basename(src)),
  })
  await cp(join(ROOT, 'assets'), join(out, 'assets'), { recursive: true })
  await cp(join(ROOT, 'perf'), join(out, 'perf'), { recursive: true })
  await cp(join(ROOT, 'compat'), join(out, 'compat'), { recursive: true })
  // 内置 dsh 插件：装进安装目录的 plugins/，server.js 首次启动时复制到 DSH_HOME 并预置到 profile。
  // test/ 与 node_modules/ 不进安装包（用例是给仓库看的，node_modules 由 profile 那边装）。
  await cp(join(ROOT, 'plugins'), join(out, 'plugins'), {
    recursive: true,
    filter: (src) => !['test', 'node_modules'].includes(basename(src)) && !basename(src).startsWith('.'),
  })
  // 内置整合包（packs/）：随安装包发，插件页的「内置整合包」就地安装，不用联网去 Release 拿
  await cp(join(ROOT, 'packs'), join(out, 'packs'), { recursive: true })
}

/** 把 npm、corepack 从解压好的 node 发行包拷进 nodeDir/node_modules。 */
export async function copyNpmModules(modulesSrc, nodeDir) {
  await mkdir(join(nodeDir, 'node_modules'), { recursive: true })
  await cp(join(modulesSrc, 'npm'), join(nodeDir, 'node_modules', 'npm'), { recursive: true })
  const corepack = join(modulesSrc, 'corepack')
  if (existsSync(corepack)) {
    await cp(corepack, join(nodeDir, 'node_modules', 'corepack'), { recursive: true })
  }
}

/**
 * `dsh plugin` 是 pnpm 的透传器，PATH 上没有 pnpm 就完全装不了插件（含开机预装
 * dshmarket）。机器上有没有全局 pnpm 全看运气，所以便携目录自带一个，启动器再
 * 把它加进子进程 PATH。命令行包装（pnpm / pnpm.cmd）由各平台自己写。
 *
 * npmCli 是用来装 pnpm 的 npm-cli.js；pnpm 是纯 JS 包，在哪个平台装出来都一样。
 */
export async function copyPnpm(nodeDir, npmCli) {
  const target = join(nodeDir, 'node_modules', 'pnpm')
  if (pnpmVersionOf(target) === PNPM_VERSION) return
  const staging = join(VENDOR, 'pnpm')
  const staged = join(staging, 'node_modules', 'pnpm')
  if (pnpmVersionOf(staged) !== PNPM_VERSION) {
    console.log(`下载 pnpm@${PNPM_VERSION}`)
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'package.json'), JSON.stringify({
      name: 'pnpm-bootstrap',
      private: true,
      dependencies: { pnpm: PNPM_VERSION },
    }, null, 2))
    await rm(staged, { recursive: true, force: true })
    run(process.execPath, [npmCli, 'install',
      '--registry=https://registry.npmmirror.com', '--no-audit', '--no-fund'], staging)
  }
  // 整目录替换：合并拷贝会把上一个版本的残留文件（pnpm 11 起 dist 是分块的）留在里面
  await rm(target, { recursive: true, force: true })
  await cp(staged, target, { recursive: true })
}

/**
 * 目录里那份 pnpm 的版本，没有或读不出来就是空串。判定看版本号、不看文件在不在 ——
 * 否则换了版本常量，缓存里那份旧的还会被继续发出去。
 */
function pnpmVersionOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || ''
  } catch {
    return ''
  }
}

// ---- 离线载荷：这一节是「一键安装器化的 DSH-X」与原来最大的区别 ----
//
// 原来的安装包只管启动器自己：dsh 本体、插件、pnpm 都要用户机器上网去取。
// 改造后这三样随包发出，装机器上全程不联网。三者的来源与理由：
//
//   core/dsh      dsh 本体：从本机已装的那一份采集（它本来就是自包含的 npm 包布局：
//                 lib/ 加自己的 node_modules/，实测 `node <dir>/lib/bin.js --version`
//                 直接可用，不需要 npm 参与）。
//   packages/     内置插件：从 plugins/ 采集「发布子集」——去掉 test/ 与 node_modules/，
//                 装机器上以 file: 依赖装进 profile，pnpm 不解析依赖也就零下载。
//   corepack/     pnpm 的 corepack 缓存：corepack 冷缓存时会联网下载 pnpm（实测 65 秒），
//                 把缓存带上才是真离线。

/** 采集 dsh 本体的来源：环境变量优先，其次常见的全局安装位置。 */
export function findDshSource() {
  const candidates = [
    process.env.DSH_CORE_SOURCE,
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    join(process.env.LOCALAPPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
  ].filter(Boolean)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'lib', 'bin.js')) && existsSync(join(dir, 'package.json'))) return dir
  }
  return ''
}

/**
 * 把 dsh 本体采进 core/dsh。
 *
 * 采集而不是下载：dsh 本体 450 MB 量级，从 registry 拉 tarball 再解开，既慢又要处理
 * 平台相关的 optionalDependencies；本机这一份已经是装好的成品，直接拷就是最稳的。
 * 代价是打包机器上得先装过一次 dsh —— 对开发机来说本来就是常态。
 */
export async function copyDshCore(out, log = console.log) {
  const source = findDshSource()
  if (!source) {
    throw new Error(
      '找不到本机的 dsh 本体，无法生成离线载荷。\n' +
      '先装一次：npm i -g @deepseek-ai/dsh\n' +
      '或用 DSH_CORE_SOURCE 指到一个已装好的 @deepseek-ai/dsh 目录。',
    )
  }
  const target = join(out, 'core', 'dsh')
  const version = readPackageVersion(source)
  log(`采集 dsh 本体 ${version} ← ${source}`)
  await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: true })
  return { version, source, target }
}

/**
 * 把内置插件采进 packages/。
 *
 * 只保留发布子集（package.json、lib/、cordis.patch.yml、README 这些），
 * test/ 与 node_modules/ 不进包：前者是给仓库看的，后者由装机器上的 pnpm 按 file:
 * 依赖就地装 —— 而那时 pnpm 手里已经有 corepack 缓存，零下载。
 */
export async function copyBundledPackages(out, log = console.log) {
  const names = []
  let entries = []
  try {
    entries = await readdir(join(ROOT, 'plugins'), { withFileTypes: true })
  } catch {
    return names
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const source = join(ROOT, 'plugins', entry.name)
    if (!existsSync(join(source, 'package.json'))) continue
    const target = join(out, 'packages', entry.name)
    await mkdir(target, { recursive: true })
    await cp(source, target, {
      recursive: true,
      filter: (src) => !['test', 'node_modules'].includes(basename(src)) && !basename(src).startsWith('.'),
    })
    names.push(entry.name)
    log(`采集内置插件 ${entry.name} ${readPackageVersion(source)}`)
  }
  return names
}

/**
 * 把 pnpm 的 corepack 缓存采进 corepack/。
 *
 * 来源是本机已有的 COREPACK_HOME（默认 %LOCALAPPDATA%\node\corepack）。没有缓存就
 * 明确报错而不是静默跳过 —— 少了它，装机器上第一次装插件会去联网下 pnpm，
 * 「全程离线」当场破功，而这种破功在打包阶段是看不出来的。
 */
export async function copyCorepackCache(out, log = console.log) {
  const candidates = [
    process.env.COREPACK_HOME,
    join(process.env.LOCALAPPDATA || '', 'node', 'corepack'),
    join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'node', 'corepack'),
  ].filter(Boolean)
  const source = candidates.find((dir) => existsSync(join(dir, 'v1')) || existsSync(join(dir, 'lastKnownGood.json')))
  if (!source) {
    log('警告：本机没有 corepack 缓存，装机器上首次装插件可能联网下载 pnpm')
    log('      先在本机跑一次任意 pnpm 命令（例如 pnpm --version）把缓存建出来，再打包')
    return ''
  }
  const target = join(out, 'corepack')
  log(`采集 pnpm 缓存 ← ${source}`)
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await cp(source, target, { recursive: true })
  return target
}

function readPackageVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || ''
  } catch {
    return ''
  }
}

// ---- 内置 WebView2 固定版本运行时 ----
//
// 为什么带一份：Windows 11 与较新的 Win10 一般预装了 Evergreen WebView2，但旧镜像、
// LTSC、被精简过的系统上未必有。缺了它 DSH.exe 的内嵌窗口建不出来，界面只能退回
// 系统浏览器 —— 而「桌面窗口承载 dsh 界面」正是离线版承诺的开箱体验之一。
//
// 代价是实打实的体积（实测 CAB 243.5 MB / 解开 557.4 MB / 168 个文件），所以做成
// **可选**：不设 DSH_WEBVIEW2 就跳过，安装包里不带，DSH.exe 自动回落系统那份。

/** 固定版本运行时的默认版本号与下载地址（社区归档，内容就是微软官方发布的 CAB）。 */
export const WEBVIEW2_VERSION = process.env.DSH_WEBVIEW2_VERSION || '133.0.3065.92'
const WEBVIEW2_ARCHIVE = 'https://github.com/westinyang/WebView2RuntimeArchive/releases/download'
const WEBVIEW2_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'

/** CAB 里的那一层 `Microsoft.WebView2.FixedVersionRuntime.<版本>.<arch>`。 */
export function webview2InnerDir(dir) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^Microsoft\.WebView2\.FixedVersionRuntime\./i.test(entry.name))
    return entries.length ? join(dir, entries[0].name) : ''
  } catch {
    return ''
  }
}

/**
 * 在 dir 里递归找 msedgewebview2.exe，返回它所在的目录。
 *
 * 剥层的兜底：webview2InnerDir 依赖「CAB 里那层版本目录」这个固定结构，但不同
 * 解包工具（expand / tar / 7z）对 CAB 的目录结构还原可能不一致。与其赌结构，
 * 不如直接找 exe，把「它所在的目录」当作运行时根。
 */
function findWebView2Root(dir, depth = 0) {
  if (depth > 4) return ''
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'msedgewebview2.exe' && entry.isFile()) return dir
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const found = findWebView2Root(join(dir, entry.name), depth + 1)
      if (found) return found
    }
  } catch {
    // 换下一条路径
  }
  return ''
}

/**
 * 把 WebView2 固定版本运行时采进 <out>/webview2/，摊平成最终布局
 * （也就是让 `webview2\msedgewebview2.exe` 直接成立）。
 *
 * 摊平放在打包期而不是安装期：CAB 里那层版本目录名带版本号，让 NSIS 去猜既脆又难查；
 * 打包时剥掉一次，安装程序就只是「把一份目录解到目标位置」这么简单。
 *
 * 判定用的是 msedgewebview2.exe 而不是目录是否存在 —— 只拷了一半的运行时会让
 * WebView2 以一个更难懂的错失败，宁可当成没有。
 */
export async function copyWebView2Runtime(out, log = console.log) {
  if (!process.env.DSH_WEBVIEW2) return ''
  const cab = process.env.DSH_WEBVIEW2
  if (!existsSync(cab)) throw new Error(`DSH_WEBVIEW2 指的文件不存在：${cab}`)

  const stamp = join(VENDOR, `webview2-${WEBVIEW2_VERSION}-${WEBVIEW2_ARCH}`)
  const exe = join(stamp, 'msedgewebview2.exe')
  if (!existsSync(exe)) {
    // 缓存按版本号认：换了版本常量，缓存里那份旧的不会被继续发出去
    await rm(stamp, { recursive: true, force: true })
    await mkdir(stamp, { recursive: true })
    log(`展开 WebView2 运行时 ${WEBVIEW2_VERSION}（约 557 MB，需要一会儿）…`)
    if (/.cab$/i.test(cab)) {
      // 用 7z（优先）或系统 bsdtar 解 CAB，见 extractCab() 的注释
      extractCab(cab, stamp)
    } else {
      run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${cab}' '${stamp}'`])
    }
    // 摊平：把 msedgewebview2.exe 所在的目录内容搬到 stamp 根（剥掉那层版本目录）。
    // 用 findWebView2Root 递归定位，而不是赌「CAB 里一定有某层固定名字的目录」——
    // 不同解包工具对 CAB 目录结构的还原并不一致。
    const root = findWebView2Root(stamp)
    if (root && root !== stamp) {
      for (const entry of await readdir(root)) {
        await cp(join(root, entry), join(stamp, entry), { recursive: true })
      }
      await rm(root, { recursive: true, force: true })
    }
    if (!existsSync(exe)) throw new Error('展开后的 WebView2 运行时里找不到 msedgewebview2.exe')
  } else {
    log(`复用已展开的 WebView2 运行时 ← ${stamp}`)
  }

  const target = join(out, 'webview2')
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await cp(stamp, target, { recursive: true })
  log(`内置 WebView2 运行时 ${WEBVIEW2_VERSION} 就位（${WEBVIEW2_ARCH}）`)
  return target
}

/**
 * 下载固定版本运行时的 CAB 到 vendor/（DSH_WEBVIEW2_DOWNLOAD=1 时）。
 *
 * 单独一个开关而不是打包时自动下：243 MB 的东西不该在一次 `npm run dist` 里
 * 悄悄从网上拉，用户得知道自己在做什么。
 */
export async function downloadWebView2Runtime(log = console.log) {
  await mkdir(VENDOR, { recursive: true })
  const dest = join(VENDOR, `Microsoft.WebView2.FixedVersionRuntime.${WEBVIEW2_VERSION}.${WEBVIEW2_ARCH}.cab`)
  if (existsSync(dest)) return dest
  const url = `${WEBVIEW2_ARCHIVE}/${WEBVIEW2_VERSION}/Microsoft.WebView2.FixedVersionRuntime.${WEBVIEW2_VERSION}.${WEBVIEW2_ARCH}.cab`
  log(`下载 WebView2 运行时 ${WEBVIEW2_VERSION}（约 243 MB）…`)
  await download(url, dest)
  return dest
}

/**
 * 把 WebView2 运行时**摊平**到一个目录（`msedgewebview2.exe` 直接在目录下），返回该目录路径。
 *
 * 与 copyWebView2Runtime 的区别：它把结果拷进 <out>/webview2（进 stage）；这里只做
 * 「下载/展开 + 剥层 + 缓存」，返回目录，让调用方决定怎么收（buildInstaller 把目录
 * 路径作为 WEBVIEW2_DIR 交给 NSIS 的 File /r 分支）。
 *
 * 为什么不直接沿用 copyWebView2Runtime 再传 stage 路径给 NSIS：stage 里的 webview2
 * 会被第 1 步的 File /r 收一遍、又被 WEBVIEW2_DIR 的 File /r 再收一遍（实测 /x 在
 * /r 递归时排不掉子目录），同一个 557 MB 进包两次。所以 stage 里必须没有它，只能
 * 从单独目录收。
 */
export async function unpackWebView2Runtime(log = console.log) {
  let cab = process.env.DSH_WEBVIEW2 || ''
  if (!cab && process.env.DSH_WEBVIEW2_DOWNLOAD === '1') {
    cab = await downloadWebView2Runtime(log)
  }
  if (!cab) return ''

  const stamp = join(VENDOR, `webview2-${WEBVIEW2_VERSION}-${WEBVIEW2_ARCH}`)
  const exe = join(stamp, 'msedgewebview2.exe')
  if (!existsSync(exe)) {
    await rm(stamp, { recursive: true, force: true })
    await mkdir(stamp, { recursive: true })
    log(`展开 WebView2 运行时 ${WEBVIEW2_VERSION}（约 557 MB，需要一会儿）…`)
    if (/.cab$/i.test(cab)) {
      // 用 7z（优先）或系统 bsdtar 解 CAB，见 extractCab() 的注释
      extractCab(cab, stamp)
    } else {
      run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${cab}' '${stamp}'`])
    }
    // 摊平：把 msedgewebview2.exe 所在的目录内容搬到 stamp 根（剥掉那层版本目录）。
    // 用 findWebView2Root 递归定位，而不是赌「CAB 里一定有某层固定名字的目录」——
    // 不同解包工具对 CAB 目录结构的还原并不一致。
    const root = findWebView2Root(stamp)
    if (root && root !== stamp) {
      for (const entry of await readdir(root)) {
        await cp(join(root, entry), join(stamp, entry), { recursive: true })
      }
      await rm(root, { recursive: true, force: true })
    }
    if (!existsSync(exe)) throw new Error('展开后的 WebView2 运行时里找不到 msedgewebview2.exe')
  } else {
    log(`复用已展开的 WebView2 运行时 ← ${stamp}`)
  }
  return stamp
}
