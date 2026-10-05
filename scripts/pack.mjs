import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { copyFile, cp, mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  NODE_VERSION,
  PKG,
  ROOT,
  VENDOR,
  copyAppFiles,
  copyBundledPackages,
  copyCorepackCache,
  copyDshCore,
  copyNpmModules,
  copyPnpm as copyPnpmModule,
  download,
  downloadNodeFile,
  run,
  unpackWebView2Runtime,
} from './pack-common.mjs'
import { collectArtifacts, writeReleaseManifest } from './release-manifest.mjs'
import { collectComponents, writeSbom } from './release-sbom.mjs'

// macOS 另有一套（.app + dmg），同一个 npm run dist 按当前系统分流
if (process.platform === 'darwin') {
  await import('./pack-mac.mjs')
  process.exit(0)
}

const DIST = `node-v${NODE_VERSION}-win-x64`
const ZIP = `${DIST}.zip`
const ZIP_PATH = join(VENDOR, ZIP)
const EXTRACTED = join(VENDOR, DIST)
const OUT = join(ROOT, 'release', 'DSH')
const SETUP_NAME = 'DSH-Setup'
// Windows 按路径缓存快捷方式图标：同名文件覆盖后，Explorer 仍会显示缓存里的旧位图，
// 升级用户会以为图标没更新。图标文件名带上版本号，路径一变缓存就失效，不用指望用户
// 去清图标缓存。
const ICON_NAME = `dsh-${PKG.version}.ico`
const DESKTOP = join(process.env.USERPROFILE || ROOT, 'Desktop')

async function downloadNode() {
  await mkdir(VENDOR, { recursive: true })
  if (existsSync(join(EXTRACTED, 'node.exe'))) return
  await downloadNodeFile(ZIP, ZIP_PATH)
  run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${ZIP_PATH}' '${VENDOR}'`])
}

async function copyNodeRuntime() {
  await mkdir(join(OUT, 'node'), { recursive: true })
  await copyFile(join(EXTRACTED, 'node.exe'), join(OUT, 'node', 'node.exe'))
  for (const name of ['npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1', 'corepack', 'corepack.cmd']) {
    const src = join(EXTRACTED, name)
    if (existsSync(src)) await copyFile(src, join(OUT, 'node', name))
  }
  await copyNpmModules(join(EXTRACTED, 'node_modules'), join(OUT, 'node'))
  await copyPnpm()
}

/** pnpm 本体见 pack-common.mjs 的 copyPnpm；这里只写 Windows 的命令行包装。 */
async function copyPnpm() {
  await copyPnpmModule(join(OUT, 'node'), join(EXTRACTED, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  await writeFile(join(OUT, 'node', 'pnpm.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'SET "PNPM_JS=%~dp0node_modules\\pnpm\\bin\\pnpm.cjs"',
    '"%~dp0node.exe" "%PNPM_JS%" %*',
    '',
  ].join('\r\n'))
  await writeFile(join(OUT, 'node', 'pnpm'), [
    '#!/bin/sh',
    'exec "$(dirname "$0")/node.exe" "$(dirname "$0")/node_modules/pnpm/bin/pnpm.cjs" "$@"',
    '',
  ].join('\n'))
  const pnpx = 'pnpx'
  await writeFile(join(OUT, 'node', `${pnpx}.cmd`), [
    '@ECHO off',
    'SETLOCAL',
    '"%~dp0node.exe" "%~dp0node_modules\\pnpm\\bin\\pnpx.cjs" %*',
    '',
  ].join('\r\n'))
}

async function buildLauncher() {
  run('cargo', ['build', '--release', '--bin', 'DSH'], join(ROOT, 'launcher'))
}

/**
 * 离线载荷：核心、内置插件、pnpm 缓存三样。
 *
 * 分出来是为了让「启动器自己的代码」和「随包发的东西」在日志里分得清：
 * 前者出错是代码问题，后者出错多半是打包机没准备好（没装过 dsh、没跑过 pnpm）。
 */
async function assembleOfflinePayload() {
  const { version } = await copyDshCore(OUT)
  await copyBundledPackages(OUT)
  await copyCorepackCache(OUT)
  console.log(`离线载荷就位：dsh ${version}`)
}

async function assemble() {
  rmSync(OUT, { recursive: true, force: true })
  await copyAppFiles(OUT)
  await copyFile(join(ROOT, 'assets', 'dsh.ico'), join(OUT, 'assets', ICON_NAME))
  await copyNodeRuntime()
  await assembleOfflinePayload()
  // ★ WebView2 运行时**故意不放进 stage**。
  //
  // 原因：NSIS 的 `File /r /x "..."` 在递归时不作用于子目录内容 —— `/x "webview2"` 与
  // `/x "webview2\*"` 都实测排不掉（迷你复现：日志里照样 `Descending to: ...\webview2\`）。
  // 结果是 stage 里那份被收一次、NSIS 又从 WEBVIEW2_DIR 收一次，同一个 557 MB 的运行时
  // 进包两遍（实测 Install data 冲到 1.22 GB）。
  //
  // 与其和 /x 的语义较劲，不如让它只有一个来源：stage 里根本没有 webview2/，
  // 由 NSIS 的 WEBVIEW2_DIR 参数统一收。
  // 这里原本要拷 node_modules（装着 systray2）。托盘搬进 DSH.exe 之后启动器不再依赖任何
  // npm 包，只剩 node 内置模块和同目录的自己人，整份拷贝都省了。
  await syncPluginsFromPackages()
  await copyFile(join(ROOT, 'launcher', 'target', 'release', 'DSH.exe'), join(OUT, 'DSH.exe'))
  console.log(`已打包到 ${OUT}`)
}

/**
 * 让安装目录的 `plugins/` 与 `packages/` **内容一致**。
 *
 * 为什么两个目录都要有：`packages/` 是打包脚本专门为「离线载荷」采的（offline.js 读它
 * 给出 file: 路径），`plugins/` 是 copyAppFiles 原样拷的、给插件页与整合包当参照。
 * 两者本该一样，但同步时机不同 —— 完整 `npm run dist` 里一致，而手工重打包
 * （只更新其中一个）就会漂移。
 *
 * 实测踩到过：`packages/` 里新增了 dsh-whale-widget、`plugins/` 里没有，于是
 * `bundledPluginDir()`（读 packages）说「有」、`ensureBundledPlugin`（当时读 plugins）
 * 说「没有」，同一个包两种结论，界面上表现为预置时跳过。
 *
 * 现在以 `packages/` 为准重铺一遍 `plugins/`：它是为这个用途采的、内容更准。
 */
async function syncPluginsFromPackages() {
  const src = join(OUT, 'packages')
  if (!existsSync(src)) return
  const dst = join(OUT, 'plugins')
  rmSync(dst, { recursive: true, force: true })
  await cp(src, dst, { recursive: true })
  const names = readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  console.log(`plugins/ 与 packages/ 已对齐（${names.length} 个：${names.join('、')}）`)
}

/** 找 makensis.exe：环境变量 > 常见安装位置（NSIS 自己的注册表项也认）。 */
function findMakensis() {
  if (process.env.MAKENSIS && existsSync(process.env.MAKENSIS)) return process.env.MAKENSIS
  const candidates = [
    join(process.env.ProgramFiles || '', 'NSIS', 'makensis.exe'),
    join(process.env['ProgramFiles(x86)'] || '', 'NSIS', 'makensis.exe'),
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
  ]
  for (const path of candidates) if (path && existsSync(path)) return path
  // NSIS 在注册表里记了自己的安装位置，认它比猜路径稳
  const fromRegistry = findViaRegistry()
  return fromRegistry || ''
}

function findViaRegistry() {
  for (const hive of ['HKLM', 'HKCU']) {
    const result = spawnSync('reg', ['query', `${hive}\\Software\\NSIS`, '/v', 'InstallDir'], { encoding: 'utf8' })
    if (result.status !== 0) continue
    const match = /InstallDir\s+REG_SZ\s+(.+)/i.exec(result.stdout || '')
    if (!match) continue
    const exe = join(match[1].trim(), 'makensis.exe')
    if (existsSync(exe)) return exe
  }
  return ''
}

async function ensureNsis() {
  const existing = findMakensis()
  if (existing) return existing
  throw new Error(
    '找不到 makensis.exe，无法打安装包。\n' +
    '装一个：choco install nsis   （或到 https://nsis.sourceforge.io/ 下 3.x，装到默认位置）\n' +
    '也可以用 MAKENSIS 环境变量指到它。',
  )
}

/**
 * 保证 .nsi 带 UTF-8 BOM。
 *
 * 两个脚本都吃这个亏，症状还完全不一样：
 *
 *   - `dsh-setup.nsi`：makensis 默认按系统 ANSI 代码页读，中文注释变乱码，直接
 *     `Bad text encoding` 报错退出（一眼能看出是编码问题）。
 *   - `stop-installed.ps1`：Windows PowerShell 5.1 同样按 ANSI 读无 BOM 的 UTF-8，
 *     中文注释变乱码后**引号配对跟着错乱**，报的是 `The string is missing the
 *     terminator` 这种跟编码八竿子打不着的语法错（很难第一眼想到是 BOM）。
 *
 * 为什么不做成「写文件时就带」：编辑器、git checkout、各种工具都可能把它抹掉。
 * 放在编译前是最不容易失守的位置。
 */
async function ensureUtf8Bom(file, why) {
  const bytes = readFileSync(file)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return
  console.log(`给 ${basename(file)} 补 UTF-8 BOM（${why}）`)
  await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]))
}

/**
 * 打安装包。
 *
 * 改造前这里是「Inno 内层引擎 + Rust 外壳内嵌它」两层：网页安装界面由 DSH-Setup.exe
 * （Rust）画，真正的文件复制交给它解出来的 Inno 引擎。现在换成 NSIS 一层搞定：
 * makensis 直接把 release/DSH/ 收进一个 exe，不需要中间引擎，也不需要 cargo 再编一遍
 * 外壳。（网页安装界面那条路随之一并撤掉——它依赖的 installer-engine.iss 不再参与打包。）
 */
async function buildInstaller() {
  const makensis = await ensureNsis()
  const script = join(ROOT, 'scripts', 'dsh-setup.nsi')

  // 内置的 WebView2 固定版本运行时：DSH_WEBVIEW2 指到 CAB 或已解开的目录才带，
  // 不带也能装（DSH.exe 回落系统那份 Evergreen）。体积代价见 README 的「打包」一节。
  //
  // ★ 必须先把 CAB 展开成摊平目录、再把目录交给 NSIS：直接把 CAB 路径给 WEBVIEW2_DIR，
  //   NSIS 会走 expand.exe 分支，而那条路在 CI runner 上不可靠（expand 对 243MB 的 CAB
  //   或特殊路径会静默失败），结果是 webview2 根本没进包、安装包仍是「瘦版」。
  //   摊平成目录后走 File /r 分支，只把同一份 557MB 收进包一次。
  const webview2 = await unpackWebView2Runtime()
  if (webview2) {
    console.log(`内置 WebView2 运行时 ← ${webview2}`)
  } else {
    console.log('不带 WebView2 运行时（设 DSH_WEBVIEW2=<cab 或目录> 可内置；DSH_WEBVIEW2_DOWNLOAD=1 会自动下载）')
  }

  await mkdir(join(ROOT, 'release'), { recursive: true })
  await ensureUtf8Bom(script, 'makensis 不认无 BOM 的 UTF-8')
  await ensureUtf8Bom(join(ROOT, 'scripts', 'stop-installed.ps1'), 'Windows PowerShell 5.1 按 ANSI 读无 BOM 的 UTF-8')
  // ★ 参数顺序有硬性要求：makensis 的 /D 定义必须排在**脚本文件名之前**，
  //   否则全部 /D 不生效、脚本退回 !ifndef 里的默认值 —— 表现为安装包版本号是
  //   0.0.0、WEBVIEW2_DIR 为空因而「这一份不带 WebView2 运行时」（瘦版 127MB）。
  //   这个坑很隐蔽：STAGE_DIR 的默认值 ..\release\DSH 恰好等于正确路径，
  //   所以除了 WebView2 缺失之外看不出别的异常，查了很久才定位到顺序上。
  const defines = [
    '-V4', // 让预处理期的 !echo 进入日志，便于诊断 /D 是否生效
    `/DAPP_VERSION=${PKG.version}`,
    `/DSTAGE_DIR=${join(ROOT, 'release', 'DSH')}`,
  ]
  if (webview2) defines.push(`/DWEBVIEW2_DIR=${webview2}`)
  console.log('编译安装包（NSIS）')
  run(makensis, [...defines, script])

  const setup = join(ROOT, 'release', `${SETUP_NAME}.exe`)
  if (!existsSync(setup)) throw new Error(`没有生成 ${setup}`)
  console.log(`安装包: ${setup}`)
  if (process.env.DSH_NO_DESKTOP_COPY !== '1') {
    const desktop = join(DESKTOP, `${SETUP_NAME}.exe`)
    await copyFile(setup, desktop)
    console.log(`已复制到桌面: ${desktop}`)
  }
}

// 发布资产：先出 SBOM，再出覆盖「安装包 + SBOM」的发布清单（有私钥时顺带签名）。
// 没配密钥也不该让打包失败，所以这里只提示。
async function buildReleaseArtifacts() {
  const releaseDir = join(ROOT, 'release')
  const { path: sbomPath } = writeSbom({ releaseDir, version: PKG.version })
  console.log(`SBOM: ${sbomPath}`)
  const artifacts = collectArtifacts(releaseDir, [`${SETUP_NAME}.exe`, basename(sbomPath)])
  const { manifest, signed } = writeReleaseManifest({
    releaseDir,
    version: PKG.version,
    artifacts,
    components: collectComponents({ nodeDir: join(releaseDir, 'DSH', 'node') }),
  })
  const where = manifest.tag ? `tag ${manifest.tag}` : '没有 tag'
  console.log(`发布清单: release/release-manifest.json（${where}${manifest.dirty ? '，有未提交改动' : ''}）`)
  console.log(signed ? '已用 release/release-key.pem 签名' : '未签名：没有 release/release-key.pem（node scripts/release-manifest.mjs keygen 生成）')
}

await downloadNode()
await buildLauncher()
await assemble()
await buildInstaller()
await buildReleaseArtifacts()
