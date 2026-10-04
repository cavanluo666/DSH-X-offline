import { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { accessSync, appendFileSync, chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { cmpVer, installSpec, parsePnpmProgress, parseVer } from './registry.js'
import {
  bundledPackFiles,
  bundledPluginDir,
  bundledPluginDirs,
  bundledPluginSpec,
  coreVersion,
  hasCore,
  hasCorepackCache,
  inspect as inspectOffline,
  installCoreAsVersion,
  runtimeNodePath,
} from './offline.js'
import pkg from './package.json' with { type: 'json' }
import {
  disableRowId,
  listPlugins,
  ownerOfRow,
  parseFailedRows,
  parseUnresolvedBundles,
  pluginsNamedInFailure,
  setPluginEnabled,
} from './plugins.js'
import { listMcpServers, probeMcpServer, removeMcpServer, saveMcpServer, setMcpEnabled } from './mcp.js'
import { listPatchBackups, restoreProfileBackup, sanitizeProfile, withProfileLock } from './recovery.js'
import {
  listSkills,
  localSkillsEnabled,
  rootDirOf,
  setLocalSkillsEnabled,
  setSkillEnabled,
  skillRoots,
} from './skills.js'
import {
  applyInstall,
  defaultProfileFor,
  describeSource,
  exportPack,
  forgetPack,
  localized,
  packSummary,
  parsePackArchive,
  parsePackDir,
  parsePackSource,
  planInstall,
  readPackState,
  rememberPack,
  uninstallPack,
} from './packs.js'
import {
  autoStartEnabled,
  DEFAULT_PORT,
  DEFAULT_LAUNCH_ID,
  defaultDshHome,
  ensureSettings,
  ensureWritableDir,
  lanBindToggleOn,
  loadSettings,
  loadSettingsSync,
  parseArgs,
  resolveDataDir,
  resolvePort,
  resolveProfile,
  resolveWebBind,
  safeDataDir,
  safeDshHome,
  safeHomeMode,
  resolveDshHome,
  safeInstancePorts,
  safeLaunchPresets,
  safeLang,
  safeOpenMode,
  safeTheme,
  safePanelTransparency,
  safePort,
  safeProfile,
  safeArgs,
  safeWebBind,
  saveSettings,
  setAutoStart,
  VERSION_RE,
} from './settings.js'
import { APP_DIR, IS_MAC, IS_WINDOWS, LAUNCHER_NAME, MAC_APP_NAME, NODE_BINARY, appBundle } from './platform.js'

const execFileAsync = promisify(execFile)

const ROOT = dirname(fileURLToPath(import.meta.url))
let DATA = resolveDataDir()
const PUBLIC = join(ROOT, 'public')
let CONFIG = join(DATA, 'config.json')
const PKG = '@deepseek-ai/dsh'
/** 内置市场插件：离线版从 packages/ 载荷里装，不再从 npm 下载。 */
const MARKET_PKG = 'dshmarket'
/**
 * 内置 dsh 插件：随安装包发在 plugins/ 下，启动时复制到 DSH_HOME 再装进 profile。
 *
 * 这一批按用户机器上**实际在跑的那套环境**定：装了就有免费模型可以直接对话，
 * 不用登录、不用 API Key —— 这正是离线版最该先满足的场景。四件的分工：
 *
 *   - dsh-our-free-model       免登录免费模型（**默认装**，见 FREE_MODEL_PLUGIN；
 *                              它不在这张清单里，走 seedFreeModelPlugins 单独一条路）
 *   - dsh-omniroute-connect    本地路由 / 网关接入
 *   - dsh-workbuddy-connect    接入 WorkBuddy 模型（进入 DSH 后登录）
 *   - dsh-small-model-delegate 小模型委派，省 token
 *   - dsh-whale-widget         余额挂件（早期曾排除在外，用户后来要求一并内置：
 *                              它原来以 link: 指着 D 盘源码，那样离线版就依赖开发机的目录）
 *
 * 不在这里的：dsh-x-sync 随同步引擎一起移除 —— 它唯一的用途就是把数据传到远端。
 */
const BUNDLED_PLUGINS = [
  'dsh-omniroute-connect',
  'dsh-workbuddy-connect',
  'dsh-small-model-delegate',
  'dsh-whale-widget',
]

/**
 * 免费模型插件：它决定「装上能不能直接开聊」，所以单独拎出来默认开。
 *
 * 其余内置插件默认不预置（用户想装再勾「内置插件」开关）：插件挂得越多，
 * dsh 启动越久、出问题的面也越大，而离线版的安装包本来就在手边，随时能加。
 */
const FREE_MODEL_PLUGIN = 'dsh-our-free-model'
const APP_VERSION = String(pkg.version || '0.0.0')
// 管理页端口：环境变量 PORT（开发和测试用）优先，其余看设置；启动时 startServer() 再定最终值
let PORT = resolvePort() || DEFAULT_PORT
/** 配置的端口被别的程序占用时，往后最多试这么多个端口。 */
const PORT_SCAN = 20

/** 探端口上是不是我们自己的管理页——用 /api/ping 的身份标记区分「自己的实例」和「别人的程序」。 */
async function probeManager(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(800),
    })
    if (!res.ok) return false
    const data = await res.json()
    return data?.app === 'dsh-x'
  } catch {
    return false
  }
}
const SPEC_RE = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[a-z0-9._~+-]+)?$/i
const GITHUB_SPEC_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[\w./-]+)?$/
/** 本地路径形态的插件源（内置插件走这条）：只认绝对路径，`file:` 后面必须是盘符或 /。 */
const FILE_SPEC_RE = /^file:(?:[A-Za-z]:[\\/]|\/)[^\0]+$/
const READY_RE = /dsh web:\s+(https?:\/\/[^\s]+)/
const START_TIMEOUT_MS = 120_000
// 启动 profile：设置页可改，startServer() 里按设置定值
let PROFILE_NAME = resolveProfile()
// DSH.exe 命令行上传进来的参数：Rust 启动器原样转发给 start.js，这里拼进 dsh
// 命令行末尾——不再静默忽略。只在经由 start.js 启动时认，免得把测试/开发时
// node 自己的 argv 误当成用户参数。
const CLI_ARGS = /start\.js$/i.test(process.argv[1] || '') ? process.argv.slice(2) : []
// 额外启动参数：用户自己加的 argv，拼在命令行末尾（设置页可改）
let EXTRA_ARGS = composeExtraArgs(loadSettingsSync().args)
// Web 绑定方式：loopback（默认）/ lan。lan 时启动 web 不注入 --host/--port，
// 绑定交给配置层（远程访问插件的「局域网访问」开关写的 profile 补丁块）决定
let WEB_BIND = resolveWebBind()
// 远程访问插件的「局域网访问」开关（读 dsh 的 settings.yaml）：开着时同样不注入
// --host，否则命令行显式 --host 永远压着插件的开关和补丁块（详见 lanBindToggleOn）
let LAN_TOGGLE = false
// 手工钉死端口的实例（键 `版本@profile` → 端口）：没钉的组合每次启动由系统挑一个。
// 和 WEB_BIND 一样是「改完立刻生效」的内存副本，启动时与保存设置时各刷新一次。
let INSTANCE_PORTS = safeInstancePorts(loadSettingsSync().instancePorts)
// 界面语言（zh / en）：settings.json 为准；安装时选的语言写在安装目录 lang.txt，启动时对齐一次
const INSTALL_LANG = join(ROOT, 'lang.txt')
let LANG = safeLang(loadSettingsSync().lang) || installLang() || 'zh'
let THEME = safeTheme(loadSettingsSync().theme)
let PANEL_TRANSPARENCY = safePanelTransparency(loadSettingsSync().panelTransparency)
let REDUCE_MOTION = loadSettingsSync().reduceMotion === true
let HIDE_BACKGROUND = loadSettingsSync().hideBackground === true
let HIDE_BIG_FISH = loadSettingsSync().hideBigFish === true
// dsh 的用户目录（DSH_HOME）：留空用默认 ~/.dsh。用户把 .dsh 挪到别的盘之后，
// 在这里指回去，否则启动器会按默认位置重建一个、dsh 也就跑到那份空数据上去了。
let DSH_HOME_DIR = safeDshHome(loadSettingsSync().dshHome)
// 家目录隔离档位（shared / isolated）：改它要重启才对所有已起实例生效，
// 新起的实例立刻按新档位走（settings 保存时会同步这个变量）。
let DSH_HOME_MODE = safeHomeMode(loadSettingsSync().dshHomeMode)
// 打开 dsh 页面的方式：tab（默认，系统浏览器标签页）/ app（Chromium 应用窗口）/
// window（启动器内嵌窗口；只在被原生外壳拉起时成立，判断见 openRoute）
let OPEN_MODE = safeOpenMode(loadSettingsSync().openMode)
// 是否把 dsh 的 shim 目录写进用户 PATH（默认关，改了要新开终端才生效）
let SYSTEM_PATH = loadSettingsSync().systemPath === true

/** 安装目录里的 lang.txt（安装程序写的），只认 zh / en。 */
function installLang() {
  try {
    return safeLang(readFileSync(INSTALL_LANG, 'utf8'))
  } catch {
    return ''
  }
}
const LOG_DIR = APP_DIR
const LOG_FILE = join(LOG_DIR, 'manager.log')
const LOG_MAX_BYTES = 5 * 1024 * 1024
const NOISY_LOG_RE = /^(?:已安装 \d+\/\d+|已解析 \d+)/

const clients = new Set()
const stateListeners = new Set()
let host = {
  onWake: async () => {},
}
const logs = []
/**
 * 正在跑的 dsh 实例，一个「版本 × profile」组合一个（多开）。
 *
 * 端口不用抢：启动器给会起 web 的 profile 传 `--port 0`，由系统各挑一个，从 dsh 自己
 * 打印的地址里读回来。数据是共享的——同一个 DSH_HOME，多开的实例看见同一批会话与记忆；
 * 插件树按 profile 各是各的。同一个组合再点一次启动只会拿回已经在跑的那个。
 */
const instances = new Map()
// 删除环境与启动不能穿插：启动准备期间还没 child，也要算作占用这份 profile。
const startingProfiles = new Set()
const maintainingProfiles = new Set()
let trayInstalledCache = null

/**
 * 一个实例一个键：`版本@profile`。两边的字符集（VERSION_RE / safeProfile）都不含 @，
 * 拼起来不会歧义；`proc.key` 记的就是它。
 */
function instanceKey(version, profile) {
  return `${version}@${profile}`
}
let installing = null
let installProgress = null
// 插件安装/升级的进度（走 dsh 内部的 pnpm，解析方式和 npm 不同，页面按 kind 分给不同的进度条）
let pluginProgress = null
let pluginProgressName = ''
let pluginBusy = false
let server = null
/** 最近一次启动失败的上下文（错误 + 子进程输出尾巴）。 */
let lastFailure = null
/** 最近一次启动后的页面自检结果（客户端插件包是否都拉得动）。 */
let lastHealth = null
/** 需要在日志里打码的敏感串（如 API key）。 */
let secretValues = []


/** 把 key 之类的敏感串从任意文本里抹掉（dsh 的凭据常出现在子进程输出里）。 */
function redact(text, secrets = []) {
  let out = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('sk-***')
  }
  return out.replace(/\b(sk|ak)-[A-Za-z0-9_-]{8,}/g, '$1-***')
}

function versionDir(version) {
  return join(DATA, 'versions', version)
}

/**
 * 某个 profile 的 DSH_HOME。
 *
 * 两档，由设置里的「家目录隔离」决定（见 settings.js 的 resolveDshHome）：
 *
 *   shared   →  所有 profile 共用 DSH_HOME_DIR（默认 ~/.dsh）。老行为，向后兼容。
 *   isolated →  每个 profile 一份独立家目录（<根>/profiles-home/<profile>），
 *               版本、插件、技能、预设、配置、**会话**全套隔离。
 *
 * 为什么要这个：共享一份 ~/.dsh 时，换版本/换 profile 并不会换掉会话与配置 ——
 * 用户看到的是「我明明装了个干净的新环境，怎么聊天记录还是老的、插件还是那五个」。
 * 那些数据在 ~/.dsh 里本来就跨 profile 共享，只有插件按 profile 分。
 * isolated 模式下每个环境真的是自己的，代价是要各自装一份插件。
 *
 * 不带参数时用当前 PROFILE_NAME —— 绝大多数调用点都在「当前 profile」的上下文里，
 * 让它们保持原来的写法（homeDir()）不用逐个改。
 */
function homeDir(profile = PROFILE_NAME) {
  const root = DSH_HOME_DIR || defaultDshHome()
  return resolveDshHome(root, DSH_HOME_MODE, profile)
}

/**
 * 「有哪些 profile」这份清单所在的位置 —— **永远是家目录根下的 profiles/**，
 * 与隔离档位无关。
 *
 * ★ 这是 homeDir(profile) 与它最容易混的一处：homeDir 回答的是「某个 profile 的
 *   数据家在哪」（隔离模式下是 <根>/profiles-home/<profile>），而 profile 定义本身
 *   （package.json、cordis.patch.yml、node_modules）始终在 <根>/profiles/<profile>。
 *
 *   早先 listProfiles 的默认参数写的是 join(homeDir(), 'profiles')，共享模式下恰好
 *   等于这个位置，看不出问题；一旦默认切到 isolated，它就会去
 *   <根>/profiles-home/<当前 profile>/profiles/ 找一个不存在的目录，
 *   结果是「profile 一个都列不出来」，起实例时报「profile xxx 不存在」。
 */
function profilesRoot() {
  return join(dshHomeRoot(), 'profiles')
}

/**
 * 家目录**根**（不是某个 profile 的家）。
 *
 * 两者要分清，这是隔离模式引入后最容易搞错的一处：
 *   dshHomeRoot()      —— 用户配的那个目录（默认 ~/.dsh）。profile 定义、bundled 插件、
 *                         以及各 profile 的家都挂在它下面。
 *   homeDir(profile)   —— 某个 profile 的 dsh 数据家（DSH_HOME），隔离模式下是
 *                         <根>/profiles-home/<profile>。
 *
 * 凡是「profile 清单 / profile 定义 / bundled 插件」这类**全局**的东西都该用前者；
 * 凡是「dsh 子进程的 DSH_HOME 环境变量」才用后者。
 */
function dshHomeRoot() {
  return DSH_HOME_DIR || defaultDshHome()
}

function managedBin(version) {
  return join(versionDir(version), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function systemNpmRoots() {
  const roots = []
  const seen = new Set()
  const add = (dir) => {
    if (!dir || seen.has(dir)) return
    seen.add(dir)
    roots.push(dir)
  }
  if (process.env.APPDATA) add(join(process.env.APPDATA, 'npm', 'node_modules'))
  if (process.env.LOCALAPPDATA) add(join(process.env.LOCALAPPDATA, 'npm', 'node_modules'))
  if (process.env.npm_config_prefix) add(join(process.env.npm_config_prefix, 'node_modules'))
  for (const key of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    const base = process.env[key]
    if (base) add(join(base, 'nodejs', 'node_modules'))
  }
  add('/usr/local/lib/node_modules')
  // Apple Silicon 上 Homebrew 的前缀
  if (IS_MAC) add('/opt/homebrew/lib/node_modules')
  add(join(homedir(), '.npm-global', 'lib', 'node_modules'))
  return roots
}

function detectSystemDsh() {
  for (const root of systemNpmRoots()) {
    const pkgRoot = join(root, '@deepseek-ai', 'dsh')
    const bin = join(pkgRoot, 'lib', 'bin.js')
    const pkgFile = join(pkgRoot, 'package.json')
    if (!existsSync(bin) || !existsSync(pkgFile)) continue
    try {
      const version = String(JSON.parse(readFileSync(pkgFile, 'utf8')).version || '')
      if (!VERSION_RE.test(version)) continue
      return { version, bin, root: pkgRoot }
    } catch {
      continue
    }
  }
  return null
}

function isManaged(version) {
  return existsSync(managedBin(version))
}

function binPath(version) {
  if (isManaged(version)) return managedBin(version)
  // 有内置载荷时不再回落到系统那份：包自带的 dsh 才是这一版该跑的（版本号恰好相同
  // 的时候也认内置的），否则「内置运行时」就成了摆设。没有内置载荷才用系统的。
  if (hasCore()) return managedBin(version)
  const system = detectSystemDsh()
  if (system?.version === version) return system.bin
  return managedBin(version)
}

function profileManifest(profile = PROFILE_NAME) {
  return join(profileDirOf(profile), 'package.json')
}

/**
 * 确保「安装包自带的 dsh 本体」已经在 versions/ 里就位。
 *
 * 为什么需要这一步：内置载荷放在安装目录的 core/dsh，而启动器认的是
 * <dataDir>/versions/<版本>/node_modules/@deepseek-ai/dsh。改造后只有用户**主动点**
 * 「安装版本」时才会走那条铺设路径 —— 于是默认状态下 versions/ 是空的，启动器只能
 * 找到机器上系统装的那份 dsh，内置本体等于白带（离线版最该用上它）。
 *
 * 所以启动时补一次：有内置载荷、且 versions/ 里还没有同名版本，就铺进去。
 * 幂等（installCoreAsVersion 自己判重），失败只记日志不拦启动 —— 机器上已经有系统
 * dsh 的话仍然能用，只是没享受到「不依赖机器装过什么」这一点。
 */
async function ensureBundledCore() {
  if (!hasCore()) return ''
  const version = coreVersion()
  if (!version || !VERSION_RE.test(version)) return ''
  if (isManaged(version)) return version
  try {
    await mkdir(join(DATA, 'versions'), { recursive: true })
    await installCoreAsVersion(version, versionDir(version))
    // 顺手写进 config 的版本列表**最前面**：listedVersions() 是先 config 后磁盘扫描，
    // 不写这一笔的话，历史 config 里存过的别的版本会排在它前面，
    // launchInstalled() 取 installed[0] 就又不是内置那份了。
    const config = await loadConfig()
    const existing = (config.versions || []).map((item) => (typeof item === 'string' ? item : item.version))
    if (existing[0] !== version) {
      config.versions = [version, ...existing.filter((item) => item !== version)]
      await saveConfig(config)
    }
    pushLog(`内置 dsh ${version} 已铺到版本目录`)
    return version
  } catch (error) {
    pushLog(`铺内置 dsh 失败: ${error instanceof Error ? error.message : error}（将使用机器上已有的 dsh）`)
    return ''
  }
}

function scanInstalled() {
  const found = []
  const root = join(DATA, 'versions')
  if (existsSync(root)) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(managedBin(entry.name))) found.push(entry.name)
      }
    } catch {
      // ignore unreadable versions dir
    }
  }
  // 有内置本体时，**不把系统装的那份列进来**。
  //
  // 为什么：这个包的价值就在于「不依赖机器上装过什么」。把系统那份也列成可选项，用户
  // 会看到两个版本、还可能选中机器上那个旧环境（版本号相同的情况下更难分辨），
  // 而这跟「离线自带运行时」的承诺是矛盾的。内置那份排在唯一位置，干净且确定。
  //
  // 没有内置载荷时（源码运行、或用户自己魔改了包）仍然列出系统那份 —— 那会儿它是唯一能用的。
  if (!hasCore()) {
    const system = detectSystemDsh()
    if (system && !found.includes(system.version)) found.push(system.version)
  }
  return found
}

function listedVersions(config) {
  const onDisk = new Set(scanInstalled())
  const fromConfig = (config.versions || [])
    .map((item) => (typeof item === 'string' ? item : item.version))
    .filter((version) => version && onDisk.has(version))
  const extra = [...onDisk].filter((version) => !fromConfig.includes(version))
  return [...fromConfig, ...extra]
}

function safeVersion(version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error('非法版本号')
  }
  return version
}

/** 保留的版本数：最新的一个 + 最近装的一个（回退用）。 */
const KEEP_VERSIONS = 2

/**
 * 装完新版后该留哪几个：刚装的那个 + 版本号最高的，正在跑的一定留。
 * `versions[0]` 是 install() 刚插到最前面的那个，**不是**「版本号最高的那个」——
 * 用户可以挑一个旧版本装。只按位置取前两个的话，装旧版就会把最新版删掉。
 * `running` 收多开的全部实例（历史调用传单个版本号，一起认）。
 */
export function versionsToKeep(versions, running, limit = KEEP_VERSIONS) {
  if (!versions.length) return new Set()
  const [installed, ...rest] = versions
  const ranked = [...rest].sort((a, b) =>
    cmpVer(parseVer(b) ?? parseVer('0'), parseVer(a) ?? parseVer('0')))
  const keep = new Set([installed, ...ranked.slice(0, Math.max(0, limit - 1))])
  for (const version of [running ?? []].flat()) {
    if (version) keep.add(version)
  }
  return keep
}

/**
 * 自动清理旧版本：设置里默认开着，只有显式关掉才不清理
 * （老配置文件里没这个键 = 开着，行为跟以前一样）。
 */
export function autoCleanEnabled(settings) {
  return settings?.autoCleanVersions !== false
}

/**
 * 装完新版后清理旧版本：只留最新的和上一个，正在运行的除外。
 * 设置里关掉「自动清理旧版本」后一个都不删。
 * @returns 被清理掉的版本号
 */
async function pruneVersions(config) {
  const versions = listedVersions(config)
  if (versions.length <= KEEP_VERSIONS) return []
  if (!autoCleanEnabled(await loadSettings())) {
    pushLog(`自动清理旧版本已关闭，${versions.length} 个已装版本全部保留`)
    return []
  }
  const keep = versionsToKeep(versions, instanceList().map((proc) => proc.version))
  const removed = []
  for (const version of versions) {
    if (keep.has(version)) continue
    if (!isManaged(version)) continue // 系统装的 dsh 不归启动器管
    try {
      await rm(versionDir(version), { recursive: true, force: true })
      removed.push(version)
      pushLog(`清理旧版本 ${version}（保留 ${[...keep].join('、')}）`)
    } catch (error) {
      pushLog(`清理 ${version} 失败：${error instanceof Error ? error.message : error}`)
    }
  }
  if (removed.length) {
    config.versions = listedVersions(config)
    await saveConfig(config)
    for (const version of removed) await dropInstancePorts(version)
  }
  return removed
}

function safeSpec(spec) {
  if (typeof spec !== 'string' || !(SPEC_RE.test(spec) || GITHUB_SPEC_RE.test(spec) || FILE_SPEC_RE.test(spec))) {
    throw new Error('非法插件源')
  }
  return spec
}

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG, 'utf8'))
  } catch {
    return { versions: [] }
  }
}

async function saveConfig(config) {
  trayInstalledCache = null
  await mkdir(DATA, { recursive: true })
  await writeFile(CONFIG, JSON.stringify(config, null, 2))
}

/** 把重要日志追加到 manager.log（进度类噪音行丢弃，超过 5MB 轮转一次）。 */
function persistLog(text) {
  if (NOISY_LOG_RE.test(text)) return
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`)
  } catch {
    // 目录/轮转问题不阻塞启动流程
  }
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${text}\n`)
  } catch {
    // 落盘失败不阻塞
  }
}

function pushLog(line) {
  const text = redact(String(line).replace(/\s+$/, ''), secretValues)
  if (!text) return
  logs.push(text)
  if (logs.length > 400) logs.splice(0, logs.length - 400)
  persistLog(text)
  emit('log', { line: text })
}

function emit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(payload)
}

/**
 * 退出前的收尾：停掉跑着的 dsh，再通知开着的页面（浏览器里那些）自己关掉。
 * 托盘退出和 /api/quit 都走这里。
 */
export async function shutdown() {
  await Promise.race([
    stopAll(),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ])
  await notifyShutdown()
}

/**
 * 退出前通知所有开着的管理页，让它们自己关掉——否则托盘退了，浏览器里还留着
 * 一个连不上后端的死页面。等最后这段推出去再让调用方结束进程。
 */
export function notifyShutdown() {
  return new Promise((resolve) => {
    for (const res of clients) {
      try {
        res.write('event: bye\ndata: {}\n\n')
      } catch { /* 这个页面已经断了 */ }
    }
    setTimeout(() => {
      for (const res of clients) {
        try { res.end() } catch { /* already gone */ }
      }
      clients.clear()
      resolve()
    }, 150)
  })
}

/** 所有实例（含正在起 / 正在停的），按启动先后。 */
function instanceList() {
  return [...instances.values()]
}

/** 该版本还有没有任何实例在跑（跑起中或已跑起来，正在停的不算）。 */
function hasLiveInstance(version) {
  return liveInstanceList().some((proc) => proc.version === version)
}

/** 说得上「在跑」的实例：起来中或已经跑起来（正在停的不算）。 */
function liveInstanceList() {
  return instanceList().filter((proc) => proc.status === 'running' || proc.status === 'starting')
}

/** 整个环境的删除/卸载需要停干净；默认选择并不代表多开中只有这一份在跑。 */
async function withIdleProfile(profile, operation) {
  const name = safeProfile(profile)
  if (startingProfiles.has(name) || instanceList().some((proc) => proc.profile === name)) {
    throw new Error(`profile「${name}」仍有实例在运行或启动，请先停止这个环境的全部实例`)
  }
  if (maintainingProfiles.has(name) || pluginBusy) {
    throw new Error('正在修改环境，等操作结束再试')
  }
  maintainingProfiles.add(name)
  pluginBusy = true
  try {
    const dir = profileDirOf(name)
    // 已被外部删掉的环境只清安装记录，不能为了拿锁又创建一份空目录。
    return await (existsSync(dir) ? withProfileLock(dir, operation) : operation())
  } finally {
    pluginBusy = false
    maintainingProfiles.delete(name)
  }
}

/** rm 会连 lock 一起删除；进程内的占用标记补上这段窗口，避免热加载写回已删目录。 */
async function editProfile(profile, operation) {
  const name = safeProfile(profile)
  if (maintainingProfiles.has(name)) throw new Error(`profile「${name}」正在修改，稍后再试`)
  return withProfileLock(profileDirOf(name), operation)
}

/** 托盘只需要知道有没有版本；外部安装变化最多等 15 秒，页面刷新会立即更新。 */
function trayHasInstalled() {
  if (!trayInstalledCache || Date.now() - trayInstalledCache.at >= 15_000) {
    trayInstalledCache = { at: Date.now(), value: scanInstalled().length > 0 }
  }
  return trayInstalledCache.value
}

/** 一个实例对外的那一份（页面、托盘都读这个形状）。 */
function instanceInfo(proc) {
  return {
    version: proc.version,
    profile: proc.profile,
    status: proc.status,
    url: proc.url,
    startedAt: proc.startedAt,
  }
}

/**
 * 只认一个地址的地方（托盘、原生外壳窗口、/api/tray）读这个：最近起来的那个在跑的实例；
 * 一个都没在跑就退回最近的那个。
 */
function primaryInstance() {
  const live = liveInstanceList()
  return live[live.length - 1] || instanceList().at(-1) || null
}

async function snapshot() {
  const config = await loadConfig()
  const installed = listedVersions(config)
  trayInstalledCache = { at: Date.now(), value: installed.length > 0 }
  const all = instanceList()
  return {
    installing,
    installed,
    // 当前 profile（启动下拉的默认值）+ 可选的 profile 列表（模板名 + 磁盘上已有的）
    profile: PROFILE_NAME,
    profiles: listProfiles(),
    // 手工钉死端口的实例（键 `版本@profile` → 端口）：控制页那个端口输入框回显它
    instancePorts: INSTANCE_PORTS,
    launchPresets: safeLaunchPresets((await loadSettings()).launchPresets),
    instances: all.map(instanceInfo),
    versions: installed.map((version) => {
      // 同一个版本的实例可能不止一个（多开下只会有一个，聚合起来更稳）：跑着的优先，
      // 地址给第一个跑起来的那个
      const procs = all.filter((proc) => proc.version === version)
      const live = procs.find((proc) => proc.status === 'running' || proc.status === 'starting')
      const chosen = live || procs[0]
      return {
        version,
        managed: isManaged(version),
        status: chosen ? chosen.status : 'stopped',
        url: chosen?.url ?? null,
      }
    }),
    // 只认一个地址的老地方（托盘、外壳窗口）读 running：多开时它是最近起来的那个在跑的实例
    running: (() => {
      const proc = primaryInstance()
      return proc ? { version: proc.version, status: proc.status, url: proc.url } : null
    })(),
    autoFix: lastAutoFix,
    health: lastHealth,
    dataDir: DATA,
    progress: installProgress,
    pluginProgress,
  }
}

async function applyDataDir(dir) {
  // 先确认真的能写（含已存在但只读的目录），失败就带着人话抛出，DATA 保持不变
  await ensureWritableDir(dir)
  DATA = dir
  CONFIG = join(DATA, 'config.json')
  trayInstalledCache = null
  pushLog(`版本目录 ${DATA}`)
}

/**
 * 离线能力的一句话结论，给页面显示用。
 *
 * 改造后「能装什么」完全由随包的载荷决定，用户看界面时应该能一眼知道本机这一份
 * 带的是什么（本体版本、几个插件、几个整合包），而不是去猜。缺项也如实列出来。
 */
function offlineInfo() {
  const info = inspectOffline()
  return {
    core: info.core,
    coreVersion: info.coreVersion,
    plugins: info.plugins.length,
    pluginNames: info.plugins,
    packs: info.packs,
    corepack: info.corepack,
    nodeBundled: info.nodeBundled,
  }
}

async function publicSettings() {
  const stored = await loadSettings()
  return {
    dataDir: DATA,
    dshHome: homeDir(),
    // 设置里填的原文（空 = 用默认位置）+ 默认位置，页面据此回显与提示
    dshHomeValue: safeDshHome(stored.dshHome),
    dshHomeDefault: defaultDshHome(),
    // 家目录隔离档位 + 当前 profile 实际用的家目录（页面要如实显示「我这个环境在哪」）
    dshHomeMode: DSH_HOME_MODE,
    dshHomeCurrent: homeDir(),
    dshHomeProfiles: Object.fromEntries(listProfiles().map((name) => [name, homeDir(name)])),
    // port 是配置值（重启后生效），listenPort 是当前真正在监听的端口
    port: stored.port ?? DEFAULT_PORT,
    listenPort: PORT,
    portDefault: DEFAULT_PORT,
    autoStart: await autoStartEnabled(),
    seedMarket: stored.seedMarket !== false,
    // 免费模型插件默认预置：离线版装上就该能直接对话
    seedFreeModel: stored.seedFreeModel !== false,
    // 旧键 seedMemory 是这版之前的名字，读一次当作别名；默认关（只有显式 true 才开）
    // 旧键 seedMemory / seedBundled 是这一版之前的两个开关，现在合成一个
    seedBundled: (stored.seedBundled ?? stored.seedMemory) === true,
    seedPlugins: stored.seedFreeModel !== false,
    autoDisablePlugins: stored.autoDisablePlugins !== false,
    autoCleanVersions: autoCleanEnabled(stored),
    // 离线版自带运行时与依赖，界面上不再有下载源/代理/更新源这三组选项
    offline: offlineInfo(),
    openMode: safeOpenMode(stored.openMode),
    // 选了内嵌窗口但当前没有原生外壳（源码运行）时，页面要如实说明会落到标签页
    openModeWindow: openRoute(OPEN_MODE, shellWindowHost()) === 'window',
    openModes: [
      { id: 'tab', label: '浏览器标签页' },
      { id: 'app', label: '应用窗口' },
      { id: 'window', label: '桌面窗口（内嵌）' },
    ],
    systemPath: SYSTEM_PATH,
    systemBinDir: systemBinDir(),
    profile: PROFILE_NAME,
    profiles: listProfiles(),
    launchPresets: safeLaunchPresets(stored.launchPresets),
    // 回显用户填的原文（带引号），不能回显 parse 后的数组，否则含空格的值再存一次就被拆开了
    args: stored.args ?? '',
    lang: LANG,
    theme: THEME,
    panelTransparency: PANEL_TRANSPARENCY,
    reduceMotion: REDUCE_MOTION,
    hideBackground: HIDE_BACKGROUND,
    hideBigFish: HIDE_BIG_FISH,
    // Web 绑定：设置值 + 插件开关是否压着它（页面要如实说明当前生效的是哪一个）
    webBind: WEB_BIND,
    webBindLan: LAN_TOGGLE,
  }
}

/**
 * 给一个实例（版本 × profile）钉死端口，或取消钉（端口填空 / 0）。
 *
 * 只校验「能不能钉」：端口本身合法、没和管理页撞、没和别的组合撞、这份 profile 真的
 * 会起 web（不起 web 的 profile 没有 HTTP 服务，端口对它没有意义——传给它反而会被
 * 它自己的 CLI 打回 unknown option）。端口此刻有没有被别的程序占着不作拦截：那可能是
 * 用户马上要关掉的东西，只是把结论以 busy 回给页面（页面上只说问题）。
 */
async function setInstancePort(version, profile, port) {
  const ver = safeVersion(version)
  const prof = safeProfile(profile)
  const key = instanceKey(ver, prof)
  const map = { ...INSTANCE_PORTS }
  const text = String(port ?? '').trim()
  if (!text || Number(text) === 0) {
    const saved = await saveSettings({ instancePorts: mapWithout(map, key) })
    INSTANCE_PORTS = safeInstancePorts(saved.instancePorts)
    pushLog(`取消固定端口：${key}`)
    await emitState()
    return { key, port: 0, busy: false }
  }
  const value = safePort(text)
  if (!bootsWebApp(prof)) throw new Error(`profile ${prof} 不起 web 应用，端口对它没用`)
  let configured = 0
  try { configured = safePort(loadSettingsSync().port) } catch { configured = DEFAULT_PORT }
  if (value === PORT || value === configured) {
    throw new Error(`端口 ${value} 是管理页自己在用的，换一个`)
  }
  const taken = Object.entries(map).find(([other, otherPort]) => otherPort === value && other !== key)
  if (taken) throw new Error(`端口 ${value} 已经钉给 ${taken[0]} 了，换一个`)
  map[key] = value
  const saved = await saveSettings({ instancePorts: map })
  INSTANCE_PORTS = safeInstancePorts(saved.instancePorts)
  pushLog(`固定端口：${key} → ${value}（下次启动生效）`)
  await emitState()
  const ours = instanceOnPort(value)
  return { key, port: value, busy: !ours && !(await portAvailable(value)) }
}

/** 启动项只是已有实例参数的命名入口；固定端口继续走同一套校验和设置。 */
async function saveLaunchPreset(body) {
  const name = String(body.name ?? '').trim()
  if (!name || name.length > 32) throw new Error('启动项名称请填 1-32 个字符')
  const version = safeVersion(body.version)
  const profile = safeProfile(body.profile)
  if (!listProfiles().includes(profile)) throw new Error(`profile ${profile} 不存在`)
  const portText = String(body.port ?? '').trim()
  const port = portText && portText !== '0' ? safePort(portText) : 0
  const stored = await loadSettings()
  const presets = safeLaunchPresets(stored.launchPresets)
  const id = body.id ? String(body.id) : randomBytes(8).toString('hex')
  const index = presets.findIndex((item) => item.id === id)
  if (body.id && index < 0) throw new Error('这个启动项已不存在，请刷新后重试')
  if (index < 0 && presets.length >= 20) throw new Error('最多保存 20 个启动项')
  if (presets.some((item) => item.id !== id && item.version === version && item.profile === profile)) {
    throw new Error('这个版本与 profile 已有启动项，编辑现有的即可')
  }
  if (port) {
    if (!bootsWebApp(profile)) throw new Error(`profile ${profile} 不起 web 应用，端口对它没用`)
    if (port === PORT || port === safePort(stored.port)) throw new Error(`端口 ${port} 是管理页自己在用的，换一个`)
    if (presets.some((item) => item.id !== id && item.port === port)) throw new Error(`端口 ${port} 已被其他启动项使用，换一个`)
  }
  // 编辑只保存启动项，不提前改正在使用的实例参数；端口在点击启动时再应用。
  const entry = { id, name, version, profile, port }
  if (index >= 0) presets[index] = entry
  else presets.push(entry)
  await saveSettings({ launchPresets: presets })
  await emitState()
  return { ok: true, entry }
}

async function removeLaunchPreset(id) {
  if (id === DEFAULT_LAUNCH_ID) throw new Error('默认启动项不能删除，可以编辑它')
  const stored = await loadSettings()
  const presets = safeLaunchPresets(stored.launchPresets)
  const next = presets.filter((item) => item.id !== id)
  if (next.length === presets.length) throw new Error('这个启动项已不存在，请刷新后重试')
  // 删除快捷入口不改实例端口，避免影响同一组合的手动启动设置。
  await saveSettings({ launchPresets: next })
  await emitState()
  return { ok: true }
}

/** 去掉一个键的副本（不原地改，省得把 map 的引用语义搞混）。 */
function mapWithout(map, key) {
  const out = { ...map }
  delete out[key]
  return out
}

/**
 * 版本卸掉或被自动清理之后，它那几条固定端口就没有意义了：留着既占着端口号，以后
 * 想钉同一个端口还会被「已经钉给 0.1.6@web 了」挡住——而那个版本早就不在了。
 */
async function dropInstancePorts(version) {
  const prefix = `${version}@`
  const kept = Object.fromEntries(Object.entries(INSTANCE_PORTS).filter(([key]) => !key.startsWith(prefix)))
  if (Object.keys(kept).length === Object.keys(INSTANCE_PORTS).length) return
  const saved = await saveSettings({ instancePorts: kept })
  INSTANCE_PORTS = safeInstancePorts(saved.instancePorts)
}

async function saveManagerSettings(body) {
  if (body.dataDir) {
    const dir = safeDataDir(body.dataDir)
    if (dir !== DATA && instances.size) throw new Error('请先停止再改版本目录')
    if (installing) throw new Error('正在安装，稍后再改版本目录')
    await applyDataDir(dir)
  }
  const stored = await saveSettings({
    dataDir: DATA,
    ...('port' in body ? { port: safePort(body.port) } : {}),
    ...('profile' in body ? { profile: safeProfile(body.profile) } : {}),
    ...('args' in body ? { args: safeArgs(body.args) } : {}),
    ...('openMode' in body ? { openMode: safeOpenMode(body.openMode) } : {}),
    ...('systemPath' in body ? { systemPath: body.systemPath === true } : {}),
    ...('dshHome' in body ? { dshHome: safeDshHome(body.dshHome) } : {}),
    ...('dshHomeMode' in body ? { dshHomeMode: safeHomeMode(body.dshHomeMode) } : {}),
    ...('webBind' in body ? { webBind: safeWebBind(body.webBind) } : {}),
    ...('lang' in body ? { lang: safeLang(body.lang) } : {}),
    ...('theme' in body ? { theme: safeTheme(body.theme) } : {}),
    ...('panelTransparency' in body ? { panelTransparency: safePanelTransparency(body.panelTransparency) } : {}),
    ...('reduceMotion' in body ? { reduceMotion: body.reduceMotion === true } : {}),
    ...('hideBackground' in body ? { hideBackground: body.hideBackground === true } : {}),
    ...('hideBigFish' in body ? { hideBigFish: body.hideBigFish === true } : {}),
    ...('autoStart' in body ? { autoStart: Boolean(body.autoStart) } : {}),
    ...('seedMarket' in body ? { seedMarket: body.seedMarket !== false } : {}),
    ...('seedFreeModel' in body ? { seedFreeModel: body.seedFreeModel !== false } : {}),
    // 旧键一并收下，写回统一的 seedFreeModel（旧设置文件里的值不会丢）
    ...('seedBundled' in body ? { seedFreeModel: body.seedBundled !== false } : {}),
    ...('seedMemory' in body ? { seedFreeModel: body.seedMemory !== false } : {}),
    ...('autoDisablePlugins' in body ? { autoDisablePlugins: body.autoDisablePlugins !== false } : {}),
    ...('autoCleanVersions' in body ? { autoCleanVersions: body.autoCleanVersions !== false } : {}),
  })
  if ('autoStart' in body) {
    try {
      await setAutoStart(stored.autoStart)
    } catch (error) {
      pushLog(`开机自启未写入: ${error instanceof Error ? error.message : error}`)
    }
  }
  if ('openMode' in body) {
    OPEN_MODE = safeOpenMode(stored.openMode)
    pushLog(OPEN_MODE === 'app'
      ? '打开方式：应用窗口（找不到 Chrome/Edge 会退回标签页）'
      : OPEN_MODE === 'window'
        ? `打开方式：桌面窗口（${shellWindowHost() ? '启动器内嵌，不经过浏览器' : '当前没有原生外壳，会退回浏览器标签页'}）`
        : '打开方式：系统浏览器标签页')
  }
  if ('systemPath' in body) {
    SYSTEM_PATH = stored.systemPath === true
    const result = applySystemPath(SYSTEM_PATH)
    if (!result.ok) pushLog(`系统 PATH 未改：${result.message}`)
    else if (SYSTEM_PATH) writeDshShims(activeVersion() || '', { dir: result.dir })
  }
  if ('dshHome' in body) {
    const next = safeDshHome(stored.dshHome)
    const home = next || defaultDshHome()
    // 目录不存在就建出来，写不了直接报错——别等到下次启动 dsh 才发现
    if (next) await ensureWritableDir(home)
    if (next !== DSH_HOME_DIR) {
      DSH_HOME_DIR = next
      pushLog(`dsh 用户目录改为 ${home}${next ? '' : '（默认位置）'}；重启 dsh 后生效`)
    }
  }
  if ('dshHomeMode' in body) {
    const mode = safeHomeMode(stored.dshHomeMode)
    if (mode !== DSH_HOME_MODE) {
      DSH_HOME_MODE = mode
      // 隔离模式下每个 profile 的家目录要真的建出来：dsh 第一次启动时会自己建，
      // 但插件预置与 profile 初始化走在我们这边，先建好能少一次「目录不存在」的报错。
      if (mode === 'isolated') {
        for (const name of listProfiles()) {
          try {
            await ensureWritableDir(homeDir(name))
          } catch (error) {
            pushLog(`建 ${name} 的独立家目录失败: ${error instanceof Error ? error.message : error}`)
          }
        }
      }
      pushLog(mode === 'isolated'
        ? '家目录改为「每个环境独立」：各 profile 的会话、配置、插件从此互不相通；重启 dsh 后生效'
        : '家目录改回「所有环境共用」：各 profile 共享会话与配置；重启 dsh 后生效')
    }
  }
  if ('autoCleanVersions' in body) {
    pushLog(stored.autoCleanVersions
      ? '装新版本后自动清理旧版本'
      : '不再自动清理旧版本（已装版本全部保留）')
  }
  // profile 立即生效：插件页、启动参数、npmrc 都读这个变量（已经在跑的 dsh 不受影响）
  EXTRA_ARGS = composeExtraArgs(stored.args)
  WEB_BIND = safeWebBind(stored.webBind)
  LAN_TOGGLE = lanBindToggleOn(homeDir(), PROFILE_NAME)
  INSTANCE_PORTS = safeInstancePorts(stored.instancePorts)
  if (safeLang(stored.lang)) LANG = safeLang(stored.lang)
  THEME = safeTheme(stored.theme)
  PANEL_TRANSPARENCY = safePanelTransparency(stored.panelTransparency)
  REDUCE_MOTION = stored.reduceMotion === true
  HIDE_BACKGROUND = stored.hideBackground === true
  HIDE_BIG_FISH = stored.hideBigFish === true
  if (stored.profile && stored.profile !== PROFILE_NAME) {
    pushLog(`启动 profile 改为 ${stored.profile}`)
    PROFILE_NAME = stored.profile
  }
  if ('seedMarket' in body && stored.seedMarket) {
    const versions = listedVersions(await loadConfig())
    if (versions[0] && !pluginBusy) await seedMarket(versions[0])
  }
  // 打开「内置插件」开关时立刻预置一次，不用等下次启动。
  // seedMemory / seedBundled 是这一版之前的两个键，现在都归到这同一个开关下。
  if (('seedFreeModel' in body || 'seedMemory' in body || 'seedBundled' in body) && stored.seedFreeModel) {
    const versions = listedVersions(await loadConfig())
    if (versions[0] && !pluginBusy) await seedFreeModelPlugins(versions[0])
  }
  await emitState()
  return publicSettings()
}

async function emitState() {
  const snap = await snapshot()
  emit('state', snap)
  for (const listener of stateListeners) {
    try { listener(snap) } catch { /* ignore tray listener errors */ }
  }
}

/**
 * dsh 子进程与 AI 修复命令共用的环境变量（AI 靠这些变量拼出正确的 dsh 命令）。
 * @param options.pnpmDir 这次要让哪个 pnpm 目录排最前（插件操作按 profile 的 store 挑，见 preferredPnpmDir）
 */
export function dshEnv(version, options = {}) {
  // ★ 家目录与 profile 都要按**这个实例**算，不能用全局的 PROFILE_NAME。
  //
  //   早先这里写死 homeDir() / PROFILE_NAME，于是同时跑两个 profile 时，两边拿到的是
  //   同一个 DSH_HOME、同一个 profile 名 —— 隔离模式下的「独立家目录」就形同虚设
  //   （多开时更明显：A profile 的实例会读到 B 的会话与配置）。
  //   options.profile 由 spawnDsh 一路传进来（见它的签名与调用点）。
  const profile = safeProfile(options.profile || PROFILE_NAME)
  const home = homeDir(profile)
  const workerCompat = existsSync(WORKER_COMPAT)
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_NODE: process.execPath,
    DSH_BIN: binPath(version),
    DSH_VERSION: version,
    DSH_PROFILE: profile,
    // 只有「必须被 dsh 起的 worker 线程继承」的东西留在这里：worker 的 execArgv 是空的，
    // 命令行参数传不进去，只能靠 NODE_OPTIONS（这里只放文件名，目录靠下面的 NODE_PATH 传）。
    // dsh 自己要的那几个开关（--use-system-ca、--max-http-header-size、--import 钩子）走命令行，
    // 见 spawnDsh：NODE_OPTIONS 会被**所有**子进程继承，agent 在 shell 里跑的 node 万一是老版本，
    // 撞上 --use-system-ca 这种新开关会直接 bad option 退出。
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      workerCompat ? `--require ${basename(WORKER_COMPAT)}` : '',
    ].filter(Boolean).join(' '),
    npm_config_ignore_workspace_root_check: 'true',
    // 离线版不给子进程塞 registry / 代理环境变量：插件全部来自内置载荷的 file: 依赖，
    // pnpm 不该、也连不上任何源。拦下这条路比让它去试一个必然超时的请求干净。
    //
    // 光有 npm_config_offline 不够 —— 实测装完插件 pnpm 还会打一行
    // 「Update available! 12.6.0 → 12.8.1」并做一次供应链校验（「Lockfile passes
    // supply-chain policies (verified 1d ago)」），两者都要联网。所以把这几条也钉上：
    //   update-notifier   关掉版本更新提示（pnpm 12 起走这条）
    //   verify-store-integrity / audit / fund   关掉需要访问 registry 的校验
    //   prefer-offline    宁可失败也不联网补齐（配 offline 一起用）
    // 传成字符串：环境变量没有布尔类型，pnpm 按 'true'/'false' 认。
    npm_config_offline: 'true',
    npm_config_prefer_offline: 'true',
    npm_config_update_notifier: 'false',
    npm_config_verify_store_integrity: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    // 末尾追加两个目录：先是启动器写的 dsh shim（node 写死成启动器自己的），再是版本自己的
    // .bin（里面有 cordis 之类的入口）。追加不插队 —— 用户自己的 dsh 仍然优先。
    PATH: withVersionBin(withBundledRuntime(process.env.PATH || '', options.pnpmDir), join(DATA, '.bin'), versionBinDir(version)),
  }
  if (workerCompat) {
    // NODE_PATH 是分号分隔的，条目本身带空格没关系，正好兜住带空格的安装路径
    env.NODE_PATH = [WORKER_COMPAT_DIR, process.env.NODE_PATH].filter(Boolean).join(delimiter)
  }
  return env
}

/** 某个 PATH 条目里是否已经能直接调到这个命令（Windows 上按 PATHEXT 补后缀猜）。 */
function hasCommand(dir, name) {
  const exts = process.platform === 'win32'
    ? ['', ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : ['']
  return exts.some((ext) => existsSync(join(dir, name + ext)))
}

/**
 * 自带运行时的 PATH 排序（纯函数；目录是否真的存在由调用方判断）。
 *
 * 自带目录默认排最前，但系统 PATH 里**已经有 pnpm** 时例外：store 主版本跟着 pnpm
 * 主版本走（8→v3、10→v10、11/12→v11），而 profile 的 `node_modules/.modules.yaml`
 * 记着当初建它的那次用的是哪个 store。拿错主版本的 pnpm 去动这个 profile，pnpm 会
 * 以 ERR_PNPM_UNEXPECTED_STORE 拒绝一切 add/remove，插件页的卸载、更新全红（#12）。
 * 谁建的 profile 就用谁的 pnpm 最省事 —— 所以插件操作会先按 store 挑一次，把挑中的目录
 * 经 preferredPnpm 传进来（见 pickPnpmDir）；挑不出来才回到「系统的优先」。node/npm 仍用
 * 自带的（插件里的原生模块指望它构建），自带目录整体紧随其后。
 *
 * @param parts 原始 PATH 片段
 * @param dir 自带运行时目录
 * @param preferredPnpm 指定的 pnpm 目录（可以就是 dir）；空 = 按「系统优先」排
 */
export function orderRuntimePaths(parts, dir, preferredPnpm = '') {
  const rest = parts.filter((item) => item !== dir)
  // 用户自己的工具链优先：有 pnpm 的目录排最前（#12 的 store 错配），其次是带 node 的目录。
  // 自带运行时只是兜底 —— agent 在 shell 里跑的 node 应该是用户自己那个，而不是我们的 22.19。
  const pnpmDir = preferredPnpm && hasCommand(preferredPnpm, 'pnpm') ? preferredPnpm : rest.find((item) => hasCommand(item, 'pnpm'))
  const nodeDir = rest.find((item) => hasCommand(item, 'node'))
  const ordered = [pnpmDir, nodeDir, dir, ...rest].filter(Boolean)
  return ordered.filter((item, index) => ordered.indexOf(item) === index)
}

/**
 * profile 的 `.modules.yaml` 记着建它那次用的 store 版本（`v3` / `v10` / `v11`…）；没有就是空串。
 * 两种写法都要认：pnpm 8 写的是无引号 yaml（`storeDir: C:\…\store\v3`），
 * pnpm 10/11 写的是带引号的 JSON（`"storeDir": "C:\\…\\store\\v11"`）。
 */
export function profileStoreVersion(dir) {
  try {
    const text = readFileSync(join(dir, 'node_modules', '.modules.yaml'), 'utf8')
    const found = /"?storeDir"?\s*:\s*("?)([^"\r\n]+)\1/.exec(text)
    return found ? basename(found[2].replace(/\\/g, '/')) : ''
  } catch {
    return ''
  }
}

const pnpmStoreCache = new Map()

/** 问一个 pnpm 目录自己用哪个 store，取末段（v3/v10/v11…）。问不到就是空串；结果按目录缓存。 */
function pnpmStoreVersion(dir) {
  if (!pnpmStoreCache.has(dir)) pnpmStoreCache.set(dir, probeStoreVersion(dir))
  return pnpmStoreCache.get(dir)
}

/**
 * 直接问 pnpm：优先跑它自己的 `bin/pnpm.cjs`（npm 装的布局都长这样，连 node 都不用猜），
 * 否则把该目录顶到 PATH 最前面按命令名找 —— 独立安装器那种 `pnpm.exe` 走这条。
 */
function probeStoreVersion(dir) {
  const cli = join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  const [command, args] = existsSync(cli)
    ? [process.execPath, [cli, 'store', 'path']]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'pnpm', 'store', 'path']]
      : ['pnpm', ['store', 'path']]
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: dir,
      timeout: 20_000,
      windowsHide: true,
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH || ''}` },
    }, (error, stdout) => {
      resolve(error ? '' : basename(String(stdout).trim().replace(/\\/g, '/')))
    })
  })
}

/**
 * 候选里哪个 pnpm 的 store 跟 profile 记的对得上（返回目录）；一个都对不上就返回空串，
 * 调用方回退到「系统的优先」。probe 可换，便于测试。
 */
export async function pickPnpmDir(candidates, wanted, probe = pnpmStoreVersion) {
  if (!wanted) return ''
  for (const dir of candidates) {
    if (await probe(dir) === wanted) return dir
  }
  return ''
}

/** 系统 PATH 里最靠前的那个带 pnpm 的目录。 */
function systemPnpmDir() {
  const parts = String(process.env.PATH || '').split(delimiter).filter(Boolean)
  return parts.find((item) => hasCommand(item, 'pnpm')) || ''
}

/**
 * 这份 profile 的插件操作该让哪个 pnpm 排最前。挑不出来就返回空串（排序回到「系统优先」），
 * 并把手上两边的 store 版本写进日志 —— 否则用户只能看到 pnpm 那句英文错。
 */
async function preferredPnpmDir(profile) {
  const wanted = profileStoreVersion(profileDirOf(profile))
  const system = systemPnpmDir()
  const candidates = [system, join(ROOT, 'node')].filter((dir) => dir && hasCommand(dir, 'pnpm'))
  const picked = await pickPnpmDir(candidates, wanted)
  if (picked) {
    // 只有「跟老规矩不一样」时才值得记一笔：系统那份仍然优先，改用它自己那份才是新行为
    if (picked !== system) pushLog(`[插件] 这个 profile 记的是 store ${wanted}，系统那份 pnpm 对不上，改用 ${picked} 里的`)
    return picked
  }
  if (!wanted || !candidates.length) return ''
  const have = []
  for (const dir of candidates) have.push((await pnpmStoreVersion(dir)) || '?')
  pushLog(`[插件] 这个 profile 记的是 store ${wanted}，机器上的 pnpm 是 ${have.join(' / ')}；若 pnpm 报 ERR_PNPM_UNEXPECTED_STORE 就是这个原因`)
  return ''
}

/**
 * 把便携运行时的目录放到 PATH 最前面。
 *
 * `dsh plugin` 是 pnpm 的透传器，装插件（含首次预装 dshmarket）必须有 pnpm；机器上
 * 有没有全局 pnpm 全看运气，所以安装包自带一份。另外插件里常带原生模块和 postinstall
 * 构建脚本，也指望能就地找到 node/npm。系统里已经有 pnpm 时的排序见 orderRuntimePaths。
 */
/**
 * 当前版本自己的命令行入口目录（node_modules/.bin，里面有 dsh / cordis 这些 shim）。
 * 从 bin 路径往上找 node_modules，兼容「启动器装的版本」和「系统装的 dsh」两种布局。
 */
function versionBinDir(version) {
  let dir = dirname(binPath(version))
  for (let i = 0; i < 5; i += 1) {
    if (basename(dir) === 'node_modules') return join(dir, '.bin')
    if (dir === dirname(dir)) break
    dir = dirname(dir)
  }
  return ''
}

/**
 * 写一份「跟着启动器当前版本走」的 dsh 命令行入口。
 *
 * 为什么不用版本目录里那个 .bin/dsh.cmd：它的 node 取自 PATH，而我们把用户自己的 node
 * 排在了前面（见 orderRuntimePaths），用户那套 node 要是太老就带不动 dsh。这里把启动器
 * 自己的 node 写死，`dsh` 在 shell 里就总是能跑起来，版本也跟着启动器选的那个走。
 */
export function writeDshShims(version, options = {}) {
  const target = options.dir ?? join(DATA, '.bin')
  const bin = options.bin ?? binPath(version)
  if (!existsSync(bin)) return ''
  try {
    mkdirSync(target, { recursive: true })
    const node = process.execPath
    writeFileSync(join(target, 'dsh.cmd'), `@ECHO off\r\n"${node}" "${bin}" %*\r\n`)
    const sh = join(target, 'dsh')
    writeFileSync(sh, `#!/bin/sh\nexec "${node}" "${bin}" "$@"\n`)
    try {
      chmodSync(sh, 0o755)
    } catch { /* Windows 上无所谓 */ }
  } catch {
    return ''
  }
  return target
}

/**
 * 把当前版本的命令行入口追加到 PATH **末尾**：agent 在 shell 里就能直接 `dsh xxx`，
 * 版本跟着启动器选的那个走（pyenv 的 shim 就是这个意思）。
 *
 * 追加而不是插队：用户自己 PATH 上本来就有 dsh 时优先用他的，我们只在后面的位置兜底。
 */
export function withVersionBin(pathValue, ...binDirs) {
  const parts = String(pathValue).split(delimiter).filter(Boolean)
  const add = binDirs.filter((dir) => dir && existsSync(dir) && !parts.includes(dir))
  if (!add.length) return pathValue
  return [...parts, ...add].join(delimiter)
}

/** 系统 PATH 里那份 dsh shim 放哪儿：固定目录，和「版本目录」可配置这件事解耦。 */
export function systemBinDir() {
  return join(APP_DIR, 'bin')
}

/**
 * 在 PATH 字符串里加上/去掉一个目录（纯函数，方便单测）。
 * 加的时候追加在末尾，用户自己已有的命令仍然优先；去掉时清理空项与重复项。
 */
export function pathWithEntry(pathValue, dir, enabled) {
  const parts = String(pathValue || '').split(delimiter).map((item) => item.trim()).filter(Boolean)
  const without = parts.filter((item) => item.toLowerCase() !== String(dir).toLowerCase())
  const next = enabled ? [...without, dir] : without
  return next.join(delimiter)
}

/** 读/写用户级 PATH（Windows：HKCU\Environment，按 REG_EXPAND_SZ 原样写，不展开变量）。 */
function readUserPath() {
  const out = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8', windowsHide: true })
  if (out.status !== 0) return ''
  const line = (out.stdout || '').split(/\r?\n/).find((item) => /\bPath\b\s+REG_/i.test(item))
  if (!line) return ''
  return line.replace(/^.*?REG_(?:EXPAND_)?SZ\s+/i, '').trim()
}

function writeUserPath(value) {
  const out = spawnSync('reg', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', value, '/f'], { encoding: 'utf8', windowsHide: true })
  return out.status === 0
}

/**
 * 把 dsh 的 shim 目录加进/移出用户 PATH。Windows 走 HKCU\Environment 的 Path；
 * 其他平台不改用户的环境（mac 的 PATH 在 shell 配置里，交给用户自己加）。
 */
export function applySystemPath(enabled) {
  const dir = systemBinDir()
  if (!IS_WINDOWS) {
    return { ok: false, dir, message: `${IS_MAC ? 'macOS' : '当前平台'}需要在 shell 配置里自己加：export PATH="${dir}:$PATH"` }
  }
  const next = pathWithEntry(readUserPath(), dir, enabled)
  if (!writeUserPath(next)) return { ok: false, dir, message: '写用户 PATH 失败（注册表 HKCU\Environment 不可写？）' }
  pushLog(enabled ? `已把 ${dir} 加到用户 PATH（新开的终端生效）` : `已把 ${dir} 从用户 PATH 移除`)
  return { ok: true, dir }
}

export function withBundledRuntime(pathValue, preferredPnpm = '') {
  const dir = join(ROOT, 'node')
  if (!existsSync(join(dir, NODE_BINARY))) return pathValue
  return orderRuntimePaths(String(pathValue).split(delimiter).filter(Boolean), dir, preferredPnpm).join(delimiter)
}

/** 当前 profile 目录。 */
/**
 * 插件安装/升级的进度事件：多带 kind 与插件名，页面据此画插件页自己的进度条。
 * 传 null 表示结束（页面上就是把进度条收起来）。
 */
function emitPluginProgress(state) {
  pluginProgress = state
  emit('progress', state ? { ...state, kind: 'plugin', name: pluginProgressName } : { phase: 'idle', kind: 'plugin' })
}

/**
 * 指名 profile 的目录。实例按启动时那份 profile 定向（插件操作、补丁层、依赖重建
 * 都得落到它自己头上）；不传就是当前 profile，跟老的 profileDir() 一个意思。
 */
function profileDirOf(profile = PROFILE_NAME) {
  // ★ profile 定义目录**永远**是 <家目录根>/profiles/<name>，与隔离档位无关。
  //
  //   别写成 homeDir(name)：那是「这个 profile 的 dsh 数据家」（隔离模式下指
  //   <根>/profiles-home/<name>），profile 自己（package.json、cordis.patch.yml、
  //   node_modules）从来不在那儿。两者混用会把插件装进一个 dsh 根本不看的目录，
  //   表现是「装完了但界面里没有」。
  const name = safeProfile(profile)
  return join(profilesRoot(), name)
}

/** 当前 profile 目录。 */
function profileDir() {
  return profileDirOf(PROFILE_NAME)
}

/**
 * 当前是否按局域网绑定：设置里选了局域网，或远程访问插件的「局域网访问」开关
 * 开着。两者都是用户明确的局域网意图，任一条成立启动器就不再注入 --host。
 * 纯函数（参数缺省取模块状态），方便单测。
 */
export function lanBindActive(webBind = WEB_BIND, toggle = LAN_TOGGLE) {
  return webBind === 'lan' || toggle === true
}

/** 设置页的额外启动参数 + DSH.exe 命令行传来的参数，后者拼在后面（更具体，覆盖前者）。 */
function composeExtraArgs(settingsText) {
  return [...parseArgs(settingsText), ...CLI_ARGS]
}

/** 当前 profile 的用户补丁层：插件开关、MCP 条目、本地技能覆盖都写这里。 */
function patchFile() {
  return join(profileDir(), 'cordis.patch.yml')
}

/** 技能接口的统一载荷：列表 + 两个受管根 + 本地技能总开关状态。 */
function skillsPayload() {
  const roots = skillRoots(homeDir())
  return {
    skills: listSkills(roots),
    roots,
    localSkills: localSkillsEnabled(profileDir()),
  }
}

// ---- 同步：会话记录、附件与插件配置传到远端（S3 兼容对象存储 / WebDAV） ----

/** 同步接口的统一载荷：配置（含密钥，页面要回显）+ 可选项 + 正在跑的进度。 */
function bootsWebApp(profile = PROFILE_NAME) {
  if (profile === 'web') return true
  try {
    const manifest = JSON.parse(readFileSync(profileManifest(profile), 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    return Array.isArray(bundles) && bundles.includes('@deepseek-ai/dsh-web-app')
  } catch {
    return false
  }
}

/**
 * dsh 启动参数。`alongside` = 已经有一个实例在跑（多开），局域网下要另给端口。
 * @param {string} profile 这次启动用的 profile（多开下同一版本可以各用各的）
 * @param {boolean} alongside
 * @param {number} pinned 手工钉死的端口（0 = 没钉，由系统挑）
 */
function bootArgs(profile = PROFILE_NAME, alongside = false, pinned = 0) {
  // 不起 web 的 profile（headless / acp / sdk…）不提供 HTTP 服务，也不认这几个 flag：
  // 参数是透传给 profile 对应 app 的，会被它自己的 commander 打回 `unknown option`
  // 并 exit 1（`dsh headless --no-open` 就是这条），所以只对会起 web 的注入
  if (!bootsWebApp(profile)) return [profile, ...EXTRA_ARGS]
  const port = pinned > 0 ? String(pinned) : '0'
  if (lanBindActive()) {
    // 局域网：--host 不传。CLI 硬禁 --host 0.0.0.0，绑定只能走配置层（远程插件的
    // lan-bind 开关写进 profile 补丁的 webserver 块）；--port 0 也一样会压过配置层，
    // 把插件钉好的端口抹成随机值，所以端口也交给配置层决定。
    // 两个例外，都是「不显式给端口就出事」：多开时配置层里只有一个端口，第二个实例
    // 撞上去就是 EADDRINUSE；用户自己钉了端口，就是要它——这两种情况显式传 --port。
    if (!pinned && !alongside) return [profile, '--no-open', ...EXTRA_ARGS]
    return [profile, '--port', port, '--no-open', ...EXTRA_ARGS]
  }
  // 默认姿势：钉死回环 + 端口（没钉就 --port 0，让 OS 现挑一个；dsh 会把真实地址
  // 打出来，启动器读它，所以顺延也不影响页面拿到链接）。
  // 额外参数放最后：用户可以用它覆盖 --port 之类（启动器是从 dsh 的输出里读真实地址的，
  // 所以换个端口也不影响管理页拿到的链接）
  return [profile, '--host', '127.0.0.1', '--port', port, '--no-open', ...EXTRA_ARGS]
}

/** 这个「版本 × profile」钉死的端口（0 = 没钉，由系统现挑）。 */
function pinnedPort(version, profile) {
  return INSTANCE_PORTS[instanceKey(version, profile)] || 0
}

/** 地址里的端口（认不出来就是 0：这种地址不该让调用方炸掉）。 */
function urlPortOf(url) {
  try {
    return Number(new URL(url).port) || 0
  } catch {
    return 0
  }
}

/** 这个端口上是不是我们自己某个在跑的实例（报错时说得出是谁占着）。 */
function instanceOnPort(port) {
  for (const proc of instanceList()) {
    if (proc.url && urlPortOf(proc.url) === port) return proc
  }
  return null
}

/**
 * 端口现在空不空：先建一个独占的监听再立刻关掉。
 *
 * Windows 上 TIME_WAIT 里的端口也会报占用（libuv 在 Windows 不给 TCP 设 SO_REUSEADDR），
 * 而那多半是刚停掉的实例留下的——所以这个结论只用来「把问题说给用户听」，不作为
 * 拦着不让启动的理由：真绑不上，dsh 自己会失败，那条路照样能把话说清楚。
 */
function portAvailable(port) {
  return new Promise((resolve) => {
    const probe = createNetServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen({ port, host: '127.0.0.1', exclusive: true })
  })
}

/**
 * dsh 绑不上端口时，Node 会抛 `listen EADDRINUSE: address already in use 127.0.0.1:3790`，
 * 这条错误就落在它 stderr 的尾巴里。认出来只为把话说明白：固定端口起不来的头号原因
 * 就是这个，而「启动失败」四个字对用户没有任何帮助。
 * @returns 一句人话，没认出端口冲突就是空串
 */
function describePortConflict(pinned, proc) {
  if (!/EADDRINUSE|address already in use/i.test((proc.tail || []).join('\n'))) return ''
  const who = instanceOnPort(pinned)
  const holder = who ? `${who.version}/${who.profile} 正在用它` : '别的程序占着'
  return `端口 ${pinned} 被占用（${holder}）：换一个端口，或先停掉占着它的东西`
}

/** dsh 子进程的加载钩子：启动加速 + 会话事件词汇兼容（含 worker 线程那份）。 */
const HOOKS = [
  join(ROOT, 'perf', 'register.mjs'),
  join(ROOT, 'compat', 'register.mjs'),
].filter((file) => existsSync(file))

/**
 * worker 线程用 --require 注入（execArgv 被清空，只有 NODE_OPTIONS 能传进去）。
 *
 * 注意 NODE_OPTIONS 是按空格分词的，写绝对路径时只要安装目录带空格（装到
 * `D:\Program Files\DSH` 这种），就会被切成半截路径，node 拿它去 require 直接
 * 起不来——报 `Cannot find module 'D:/Program'`。引号、反斜杠转义都救不了，所以
 * 这里改成把目录放进 NODE_PATH、NODE_OPTIONS 里只写不带空格的裸文件名；
 * NODE_PATH 是分号分隔的，条目带空格没问题。
 */
const WORKER_COMPAT = join(ROOT, 'compat', 'worker-events.cjs')
const WORKER_COMPAT_DIR = dirname(WORKER_COMPAT)

/**
 * dsh 的 CLI 会在参数解析阶段就拒掉的 profile 名（现在只有 `desktop` —— 官方把它留给自家
 * Electron 端），拿 `lib/bin.js` 起它必然当场报错。这个名单上的 profile 改用
 * `reserved-profile-boot.mjs`：它直接调 boot 层的 `runProfile`（官方桌面端走的也是这条路），
 * 而 argv 形状与 CLI 一模一样，所以除入口本身，参数、环境、钩子一个字都不用改。
 */
const CLI_BLOCKED_PROFILES = new Set(['desktop'])
const RESERVED_BOOT = join(ROOT, 'reserved-profile-boot.mjs')

/** 这次该跑哪个入口：普通 profile 用版本目录里的 `lib/bin.js`，保留名换成绕行入口。 */
function bootEntry(version, profile) {
  return CLI_BLOCKED_PROFILES.has(String(profile ?? '').toLowerCase()) ? RESERVED_BOOT : binPath(version)
}

/**
 * 保留名 profile 的「别名目录」名。插件命令走的是官方 CLI（`dsh plugin --profile <名字>`），
 * 而 dsh 只按名字找 profile、没有传路径的入口 —— 所以要在同一个 profiles/ 下给它一个 CLI 认得出的
 * 名字，用目录链接指回原目录：**一份目录两个名字**，不复制（官方桌面端改了插件不会有第二份要同步）、
 * 不依赖 dsh 内部结构（用的是公开的 CLI 参数）。前导点让它不出现在 profile 列表里（listProfiles 也显式跳过）。
 */
export function aliasProfileName(profile) {
  return `.dsh-alias-${String(profile).toLowerCase()}`
}

/**
 * 确保别名存在并指向 profile 目录，返回别名；建不出来就返回空串（调用方回退到原名，让 dsh 自己报那句英文错）。
 * 幂等：已经是链接且指向对就直接返回；那里有别的实体（真目录、指向别处的链接）就不碰它。
 * Windows 用 junction（普通用户可建，不需要管理员/开发者模式），其余平台用目录软链。
 */
export function ensureProfileAlias(profile, root = join(homeDir(), 'profiles')) {
  const target = join(root, safeProfile(profile))
  if (!existsSync(join(target, 'package.json'))) return ''
  const name = aliasProfileName(profile)
  const path = join(root, name)
  try {
    if (lstatSync(path).isSymbolicLink() && realpathSync(path) === realpathSync(target)) return name
    return ''
  } catch { /* 还没有：建一个 */ }
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    return name
  } catch (error) {
    pushLog(`[插件] 建 ${name} 别名失败（${error instanceof Error ? error.message : error}）：这个保留名 profile 的插件操作仍会被 dsh 拒掉`)
    return ''
  }
}

/**
 * 拉起 dsh 时的命令行参数。
 *
 * dsh 自己的开关（系统证书库、请求头上限、两个 ESM 补丁钩子）放这里而不是 NODE_OPTIONS：
 * NODE_OPTIONS 会被 dsh 的所有子进程继承，agent 在 shell 里跑的 node 万一是老版本，
 * 撞上 --use-system-ca 这类新开关就直接 bad option 退出。worker 线程那份 CJS 补丁仍在
 * NODE_OPTIONS 里（worker 的 execArgv 是空的，命令行传不进去），见 dshEnv。
 */
export function dshArgs(version, extra = [], profile = '') {
  const entry = bootEntry(version, profile)
  return [
    '--use-system-ca',
    '--max-http-header-size=131072',
    ...HOOKS.flatMap((file) => ['--import', pathToFileURL(file).href]),
    entry,
    // 换成绕行入口之后版本目录就不在 argv 里了，而它要靠 bin.js 当锚点解析出 dsh 包，
    // 所以把 bin.js 当第一个参数递过去（普通 profile 走的是官方入口，不需要）
    ...(entry === RESERVED_BOOT ? [binPath(version)] : []),
    ...extra,
  ]
}

function spawnDsh(version, extra, profile = '', options = {}) {
  // 这个实例的 profile：显式传的优先，没有才落到当前 profile。
  // cwd 必须是**那个 profile 的家目录** —— dsh 以 cwd 为锚找 .dsh（找不到才看 DSH_HOME），
  // 隔离模式下两者都要指向同一个独立家目录，否则会出现「环境变量指 A、cwd 落在 B」。
  const target = safeProfile(profile || PROFILE_NAME)
  const home = homeDir(target)
  // 先把 dsh 的命令行入口写出来（PATH 里要用到），再拼参数
  writeDshShims(version)
  // 用户开了「加到系统 PATH」的话，稳定目录里那份也跟着当前版本走
  if (SYSTEM_PATH) writeDshShims(version, { dir: systemBinDir() })
  return spawn(process.execPath, dshArgs(version, extra, target), {
    cwd: home,
    env: dshEnv(version, { ...options, profile: target }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

async function ensureProfileNpmrc(profile = PROFILE_NAME) {
  const dir = join(homeDir(), 'profiles', profile)
  await mkdir(dir, { recursive: true })
  const file = join(dir, '.npmrc')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = ''
  }
  const missing = []
  if (!/(^|\n)ignore-workspace-root-check\s*=/.test(text)) missing.push('ignore-workspace-root-check=true')
  // dsh 自己的 profile 模板把 autoInstallPeers: false 写在 pnpm-workspace.yaml 里，
  // 但那只对 pnpm 10.6+ 生效；机器上更老的 pnpm（8/9，多半还是系统那份，见
  // orderRuntimePaths）只读 .npmrc。一旦 pnpm
  // 自动装 peer，它会把所有插件对同一 @deepseek-ai/* 的 peer 区间求交，而求交库里
  // 的 stripSemVerPrerelease 会把预发布号删掉——^0.1.0-rc.8 ∩ ^0.1.2-rc.1 变成
  // `>=0.1.2 <0.2.0-0`，可这些包在 registry 上只有预发布版，于是整个安装在
  // ERR_PNPM_NO_MATCHING_VERSION 上硬失败。补这一行就等于替老 pnpm 认下 dsh 的本意。
  if (!/(^|\n)auto-install-peers\s*=/.test(text)) missing.push('auto-install-peers=false')
  if (!missing.length) return
  const head = text && !text.endsWith('\n') ? `${text}\n` : text
  await writeFile(file, `${head}${missing.join('\n')}\n`)
}

async function installedPlugins() {
  const file = profileManifest()
  if (!existsSync(file)) return []
  try {
    const manifest = JSON.parse(await readFile(file, 'utf8'))
    return Object.keys(manifest.dependencies ?? {}).sort()
  } catch {
    return []
  }
}

/**
 * 跑一条 `dsh plugin …`（透传给 pnpm），输出进日志。
 *
 * profile 与进度出口都能换：整合包要把同一套安装跑在别的 profile 上，进度也要画在
 * 整合包页自己的进度条里（默认是插件页那条）。
 */
async function runPluginCommand(ver, args, label, options = {}) {
  const profile = options.profile || PROFILE_NAME
  const onProgress = options.onProgress || emitPluginProgress
  // 保留名（desktop）：CLI 会拒，改用同一份目录的别名（见 ensureProfileAlias）
  const cliProfile = CLI_BLOCKED_PROFILES.has(profile.toLowerCase()) ? ensureProfileAlias(profile) : ''
  // 先按这份 profile 记的 store 挑 pnpm（#12）：挑得出来就用它，挑不出来按老规矩「系统优先」
  const pnpmDir = await preferredPnpmDir(profile).catch(() => '')
  return new Promise((resolve, reject) => {
    const child = spawnDsh(ver, ['plugin', '--profile', cliProfile || profile, ...args], '', { pnpmDir })
    // 留一份输出尾巴挂在错误上：只报退出码的话调用方没法判断是哪种失败，只能瞎猜着重试
    const tail = []
    // pnpm 的进度：装插件可能几十秒，页面要有条能动的进度条，别只留一句「正在更新…」
    const progressState = { resolved: 0, reused: 0, downloaded: 0, added: 0, total: 0 }
    const keep = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const text = redact(line, secretValues)
        tail.push(text)
        if (tail.length > 40) tail.shift()
        pushLog(`[plugin] ${text}`)
        const progress = parsePnpmProgress(text, progressState)
        if (progress) onProgress(progress)
      }
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else {
        const error = new Error(`${label} 退出码 ${code}`)
        error.tail = tail.slice(-40)
        reject(error)
      }
    })
  })
}

/**
 * 这个失败像是 pnpm 装 peer 撞出来的吗——只有这类才值得换掉 auto-install-peers 重试。
 * 插件声明的 @deepseek-ai/* peer 在 registry 上只有预发布版，pnpm 自动装 peer 会求交
 * 失败或 404。
 */
function looksLikePeerFailure(text) {
  return /ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_PEER_DEP|auto-install-peers|peer dep|no matching version|404 Not Found/i.test(String(text || ''))
}

/**
 * 清掉 node_modules 里悬空的链接（断链），返回清掉的数量。
 *
 * Windows 上 pnpm 用 junction 把 node_modules 里的包指到 .pnpm，dsh 的模块回退也建成
 * junction。目标被删过之后（pnpm 存库清理、外部工具、同步软件）这些链接就悬空了：打开
 * 它会返回一个 libuv 认不出的 Win32 错误码——用户看到的就是 pnpm 报告安装成功、紧接着
 * "UNKNOWN: unknown error, open .../dshmarket/package.json"，退出码 -4094（UV_UNKNOWN）。
 *
 * 悬空的链接没有任何用处，摘掉它下次安装会重新建。注意只摘链接本身，不动目标。
 */
/**
 * 失败像是「这台机器读不了 junction」吗。
 *
 * 有用户的机器上 pnpm 报告装完了、却在回读自己刚建的 junction 时崩掉，报
 * `UNKNOWN: unknown error, open ...node_modules\<pkg>\package.json`，退出码 -4094
 * （libuv 的 UV_UNKNOWN，意思是碰到了一个它没有映射的 Win32 错误码）。那台机器上连
 * 用两个普通真实目录新建的 junction 都读不了——不是链接悬空，是链接根本没法被跟随。
 */
function looksLikeLinkFailure(text) {
  return /unknown error/i.test(String(text || '')) && /node_modules/i.test(String(text || ''))
}

/**
 * 让 pnpm 彻底不用链接：包平铺成真实目录、从存库复制而不是硬链。
 *
 * 这是上面那种机器唯一走得通的路（符号链接要管理员权限或开发者模式，junction 又读不了，
 * 没有第三种链接类型可用）。只在真撞上这个问题时才写，别去动本来正常的机器。
 * .npmrc 不在插件管理器的跟踪范围内，不会被它覆盖。
 */
async function useHoistedLinker(profile = PROFILE_NAME) {
  const file = join(homeDir(), 'profiles', profile, '.npmrc')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = ''
  }
  if (/(^|\n)node-linker\s*=/.test(text)) return false
  const head = text && !text.endsWith('\n') ? `${text}\n` : text
  await writeFile(file, `${head}node-linker=hoisted\npackage-import-method=copy\n`)
  return true
}

function pruneDanglingLinks(dir, depth = 1) {
  let removed = 0
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    let isLink = false
    try {
      isLink = lstatSync(path).isSymbolicLink()
    } catch {
      continue
    }
    if (!isLink) {
      // 带 scope 的包（@local/dsh-preset-advisor 这种）在 scope 目录里，只扫一层会漏掉，
      // 而悬空的恰恰常出现在那儿：dsh 报 cannot resolve 的正是它们。
      if (depth > 0 && entry.name.startsWith('@') && entry.isDirectory()) {
        removed += pruneDanglingLinks(path, depth - 1)
      }
      continue
    }
    try {
      statSync(path)          // 能 stat 到说明链接是通的
      continue
    } catch {
      try {
        unlinkSync(path)
        removed += 1
      } catch { /* 摘不掉就算了，别把安装本身搞挂 */ }
    }
  }
  return removed
}

async function addPlugin(version, spec, { profile = PROFILE_NAME } = {}) {
  profile = safeProfile(profile)
  const ver = safeVersion(version)
  const pkg = safeSpec(spec)
  if (pluginBusy) throw new Error('正在安装插件')
  if (!existsSync(binPath(ver))) throw new Error('找不到官方入口 lib/bin.js')

  pluginBusy = true
  pluginProgressName = pkg
  emitPluginProgress({ phase: 'resolve' })
  await mkdir(homeDir(), { recursive: true })
  await ensureProfileNpmrc(profile)
  const broken = pruneDanglingLinks(join(profileDirOf(profile), 'node_modules'))
  if (broken) pushLog(`先清理了 ${broken} 个悬空的链接（断链会让安装报 unknown error）`)
  pushLog(`安装插件 ${pkg} 到 ${profile} profile`)
  try {
    try {
      await runPluginCommand(ver, ['add', '-w', pkg], `dsh plugin add ${pkg}`, { profile })
    } catch (error) {
      const text = `${error instanceof Error ? error.message : error}\n${(error?.tail || []).join('\n')}`
      if (looksLikePeerFailure(text)) {
        // 插件声明的 @deepseek-ai/* peer 多为运行时注入、registry 上只有 prerelease，
        // pnpm 自动装 peer 会 404；关掉它重试一次（与插件市场同款做法）
        pushLog(`${error instanceof Error ? error.message : error}；改用不自动装 peer 重试`)
        await runPluginCommand(ver, ['add', '-w', pkg, '--config.auto-install-peers=false'], `dsh plugin add ${pkg}`, { profile })
      } else if (looksLikeLinkFailure(text) && await useHoistedLinker(profile)) {
        // 这台机器读不了 junction（见 looksLikeLinkFailure 的说明）。让 pnpm 不用任何
        // 链接重来一次——有用户的机器上正是这两行解决了问题。
        pushLog('这台机器读不了目录链接，改用真实目录（node-linker=hoisted）重试')
        const broken = pruneDanglingLinks(join(profileDirOf(profile), 'node_modules'))
        if (broken) pushLog(`先清理了 ${broken} 个悬空的链接`)
        await runPluginCommand(ver, ['add', '-w', pkg], `dsh plugin add ${pkg}`, { profile })
      } else {
        // 认不出原因就不硬试：装不上就装不上，报出来让人看。
        // 原样重试没有意义——第一次失败的原因第二次还在，只会把终端刷满。
        throw error
      }
    }
    pushLog(`${pkg} 已在 ${profile} profile`)
  } finally {
    pluginBusy = false
    pluginProgressName = ''
    emitPluginProgress(null)
  }
}

// ---- 插件更新：查 registry 上的最新版本，按需升级 profile 里的包 ----
// 升级复用 addPlugin（peer 404、目录链接读不了这两套回退都在里面），装和升走同一条路。
const pluginUpdateCache = { at: 0, data: null, profile: '' }
const PLUGIN_UPDATE_TTL = 60 * 1000
const PLUGIN_UPDATE_CONCURRENCY = 4

/** 跑 dsh plugin 命令用哪个版本：正在跑的优先，其次配置里最新那个装好的。 */
async function pluginCommandVersion() {
  // 多开时按「最近起来的那个」定：插件命令只认一个版本（profile 是共用的）
  const live = primaryInstance()
  if (live?.version) return live.version
  const versions = listedVersions(await loadConfig()).filter((ver) => existsSync(binPath(ver)))
  if (!versions.length) throw new Error('没有可用的 dsh 版本，插件页暂时用不了')
  return versions[0]
}

/**
 * 每个第三方插件在 registry 上的最新版本。官方组件（@deepseek-ai/*）跳过——那些版本由 dsh 决定。
 * 插件多是预发布版，dist-tags.latest 不一定指向最新的那个，所以按版本号比出最大的一个。
 */
async function runProfileInstall(version, options = {}) {
  const profile = options.profile || PROFILE_NAME
  const onProgress = options.onProgress
  const log = options.log || pushLog
  const target = () => join(homeDir(), 'profiles', profile)
  const run = () => runPluginCommand(version, ['install', '--config.auto-install-peers=false'], 'dsh plugin install', { profile, onProgress })
  await mkdir(homeDir(), { recursive: true })
  await ensureProfileNpmrc(profile)
  try {
    await run()
  } catch (error1) {
    const text = `${error1 instanceof Error ? error1.message : error1}\n${(error1?.tail || []).join('\n')}`
    // 和装插件那条路同样的退路：这台机器读不了目录链接时，让 pnpm 改用真实目录再装一遍。
    // 报错长这样：UNKNOWN: unknown error, open ...node_modules\<pkg>\package.json（-4094）
    if (!looksLikeLinkFailure(text) || !(await useHoistedLinker(profile))) throw error1
    log('这台机器读不了目录链接，改用真实目录（node-linker=hoisted）重试')
    const again = pruneDanglingLinks(join(target(), 'node_modules'))
    if (again) log(`先清理了 ${again} 个悬空的链接`)
    await run()
  }
}

/**
 * profile 依赖自愈：dsh 报 `cannot resolve profile bundle "x"` 说明 profile 的
 * node_modules 里那个包不在（没装成，或 pnpm 中途被打断只留了断链），按 dsh 的
 * 提示重装 profile 依赖即可。
 * @returns 是否值得重试启动
 */
async function repairProfileDeps(version, error, profile = PROFILE_NAME) {
  const failure = error?.failure || lastFailure
  const bundles = parseUnresolvedBundles(`${failure?.message || ''}\n${(failure?.tail || []).join('\n')}`)
  if (!bundles.length) return false
  if (pluginBusy) {
    pushLog(`[兼容] profile 里解析不到 ${bundles.join('、')}，但正在装插件，跳过依赖重建`)
    return false
  }
  const broken = pruneDanglingLinks(join(profileDirOf(profile), 'node_modules'))
  if (broken) pushLog(`[兼容] 先清理了 ${broken} 个悬空的链接`)
  pushLog(`[兼容] profile ${profile} 里解析不到 ${bundles.join('、')}，重建 profile 依赖（dsh plugin install）…`)
  pluginBusy = true
  try {
    await runProfileInstall(version, { profile })
    pushLog('[兼容] profile 依赖已重建，重试启动…')
    return true
  } catch (error2) {
    pushLog(`[兼容] 重建 profile 依赖失败：${error2 instanceof Error ? error2.message : error2}`)
    return false
  } finally {
    pluginBusy = false
  }
}

// 这次运行里预装已经失败过。启动失败时的自动修复会重跑启动流程，每次都重试预装的话
// 会把失败信息刷满终端，而失败原因并不会自己消失——留到下次启动再试。
let marketSeedFailed = false
let bundledSeedFailed = false

/**
 * dsh 实际加载哪些插件，看的是 profile 清单里的 dsh.profile.bundles。
 * 「依赖里有 + 目录里有」不等于它会跑起来——装上了却没启用时，插件市场就是不会出现。
 */
async function registeredBundles(profile = PROFILE_NAME) {
  try {
    const manifest = JSON.parse(await readFile(profileManifest(profile), 'utf8'))
    const list = manifest?.dsh?.profile?.bundles
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 把包装进 dsh.profile.bundles——dsh 插件管理器点「启用」写的就是这里。
 *
 * profile 可指定：隔离模式下每个 profile 的家目录不同，起别的 profile 时不能
 * 往当前 profile 的清单里写（那会让 B 的插件出现在 A 的 bundle 列表里）。
 */
async function registerBundle(name, profile = PROFILE_NAME) {
  const file = profileManifest(profile)
  let manifest
  try {
    manifest = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // 清单还没有或读不动：这一步只是补启用，不在这里造文件
    return false
  }
  if (!manifest || typeof manifest !== 'object') return false
  const dsh = typeof manifest.dsh === 'object' && manifest.dsh ? manifest.dsh : (manifest.dsh = {})
  // 变量名别叫 profile：它和形参（profile 名）撞了，会把上面的 profileManifest(profile)
  // 之后的引用全指向这个对象。
  const profileSection = typeof dsh.profile === 'object' && dsh.profile ? dsh.profile : (dsh.profile = {})
  const bundles = Array.isArray(profileSection.bundles) ? profileSection.bundles : (profileSection.bundles = [])
  if (bundles.includes(name)) return false
  bundles.push(name)
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return true
}

async function seedMarket(version, profile = PROFILE_NAME) {
  const settings = await loadSettings()
  if (settings.seedMarket === false) return
  if (marketSeedFailed) return
  const plugins = await installedPlugins()
  // 三条都成立才算装好了，少一条都要修：
  // 1) 清单里有——pnpm 中途失败或被杀毒软件拦下时，清单里留了名字却只有一个空壳目录
  //    （正是 "unknown error, open ...dshmarket\package.json" 那种）；
  // 2) 文件真的在——只看清单会把空壳当成装好了，那个坏目录就永远修不回来；
  // 3) 在 dsh.profile.bundles 里——少了这条，包是装上了但 dsh 不会加载它，市场不出现，
  //    而前两条都成立，于是预装再也不会重试（这个缺口让市场一直缺席）。
  const listed = plugins.includes(MARKET_PKG)
  const onDisk = existsSync(join(profileDirOf(profile), 'node_modules', MARKET_PKG, 'package.json'))
  const bundled = (await registeredBundles(profile)).includes(MARKET_PKG)
  if (listed && onDisk && bundled) return
  // 离线版的市场插件来自内置载荷（packages/dshmarket），不再从 npm 装。
  // 载荷里没有这一份就等于「本包不带市场」——这是正常配置，不是失败，安静跳过。
  const spec = bundledPluginSpec(MARKET_PKG)
  if (!spec) {
    pushLog(`内置载荷里没有 ${MARKET_PKG}，跳过预装（本包不带市场插件）`)
    return
  }
  try {
    // 只有「包不在」才真的需要跑 pnpm；包在、只是没启用的话补一句启用就够了，
    // 不必每次都去跑一遍注定失败的安装
    if (!listed || !onDisk) await addPlugin(version, spec, { profile })
    if (await registerBundle(MARKET_PKG, profile)) {
      pushLog(`已把 ${MARKET_PKG} 加入 profile 的 bundle 列表，重启后市场就会出现`)
    }
  } catch (error) {
    marketSeedFailed = true
    pushLog(`预装 dshmarket 失败: ${error instanceof Error ? error.message : error}（本次运行不再重试，可在插件页手动安装）`)
  }
}

/**
 * 安装包自带插件的落地位置：<该 profile 的 DSH_HOME>/bundled/<包名>。
 *
 * 按 profile 算：隔离模式下每个 profile 有自己的家目录，插件副本也跟着各存一份
 * （profile 的 file: 依赖指向的是这份副本，指错家就会断链）。
 */
function bundledPluginPath(name, profile = PROFILE_NAME) {
  return join(homeDir(profile), 'bundled', name)
}

/**
 * 把内置插件复制到该 profile 的 DSH_HOME/bundled/（版本不同才复制），
 * 返回目标路径；内置载荷里没有则 null。
 *
 * ★ 插件源是**安装目录的 packages/**，不是仓库里的 plugins/。
 *
 *   打包时 `copyBundledPackages` 把仓库的 plugins/<包名> 采一份到安装目录的
 *   packages/ 下（只留发布子集：去掉 test/ 与 node_modules/），offline.js 的
 *   bundledPluginDir() / bundledPluginSpec() 读的也是它。这里早先写的是
 *   `join(ROOT, 'plugins', name)` —— 在仓库里跑源码时恰好能读到，安装后的机器上
 *   plugins/ 也在（copyAppFiles 会把整个 plugins/ 拷过去），于是两份目录并存、
 *   看起来都能用；但打包脚本同步这两份的时机只在完整 `npm run dist` 里一致，
 *   手工重打包（只更新其中一份）就会漂移 —— 实测踩到过：packages/ 里有
 *   dsh-whale-widget，plugins/ 里没有，于是 `ensureBundledPlugin` 报「内置载荷里没有」，
 *   而 `bundledPluginSpec` 却能给出路径，一个包两种结论。
 *
 *   现在以 packages/ 为准（它是为「离线载荷」这个用途专门采的），
 *   源码运行时（没有 packages/）回落到 plugins/ —— 那时它就是唯一的一份。
 */
async function ensureBundledPlugin(name, profile = PROFILE_NAME) {
  const source = bundledPluginDir(name) || join(ROOT, 'plugins', name)
  if (!existsSync(join(source, 'package.json'))) return null
  const target = bundledPluginPath(name, profile)
  const sourceVersion = readPackageVersion(source)
  const targetVersion = readPackageVersion(target)
  if (sourceVersion !== targetVersion) {
    await rm(target, { recursive: true, force: true })
    await cp(source, target, {
      recursive: true,
      filter: (src) => !['test', 'node_modules'].includes(basename(src)) && !basename(src).startsWith('.'),
    })
    pushLog(`内置插件已${targetVersion ? '更新到' : '就位'} ${name}${sourceVersion ? ` ${sourceVersion}` : ''}`)
  }
  return target
}

/** 整合包里把依赖版本写成 `bundled`（或 `bundled:<包名>`）的，指向安装包自带的那份。 */
function bundledDependencyNames(pack) {
  const deps = pack?.fields?.dependencies
  if (!deps) return []
  return Object.entries(deps)
    .filter(([name, spec]) => spec === 'bundled' || spec === `bundled:${name}`)
    .map(([name]) => name)
}

/** 把 `bundled` 依赖改写成 `file:` 绝对路径（路径是确定的，同步也能改，检查阶段就能显示对）。 */
function resolveBundledDependencies(pack) {
  for (const name of bundledDependencyNames(pack)) {
    const spec = `file:${bundledPluginPath(name)}`
    pack.fields.dependencies[name] = spec
    // planInstall 用的是解析时算好的 installSpecs（line: specs: pack.installSpecs || fields.dependencies），
    // 只改 fields 不生效——两份一起改。
    if (pack.installSpecs) pack.installSpecs[name] = spec
  }
  return pack
}

/**
 * 预置内置插件（默认全装）。
 *
 * 为什么这批默认装而不是让用户自己开：离线版最该先满足的场景就是「装完即用」——
 * 免费模型直接能对话（不登录、不填 API Key），omniroute / workbuddy / 小模型委派
 * 也都在位。挂得多的代价（dsh 启动稍慢、出问题面稍大）由「内置插件」开关兜底：
 * 不想要的用户在设置页关掉即可。
 *
 * 判据与 seedMarket 同一套：清单里有、文件真在、bundle 里启用了，
 * 三条都成立才算装好 —— 少一条都要修（pnpm 中途失败会留下空壳目录，而空壳在
 * 清单里是存在的）。
 *
 * 为什么每件单独 try：一件失败不该拖垮其余的。免费模型排第一，因为它最要紧。
 */
async function seedFreeModelPlugins(version, profile = PROFILE_NAME) {
  const settings = await loadSettings()
  if (settings.seedFreeModel === false) return
  if (bundledSeedFailed) return

  // ★ 这里**不再**「profile 不存在就跳过」。
  //
  //   早先是 `if (!existsSync(profileManifest())) return`，理由是「首次启动时 profile
  //   还没建出来（dsh 自己会建），等下次启动再做」。那个假设只在共享家目录下勉强成立：
  //   ~/.dsh/profiles/web 早就存在，所以看不出问题。
  //
  //   隔离模式把它变成实打实的 bug：每个 profile 一份新家目录，**第一次**启动时
  //   profile 确实不存在 → 整个预置被跳过 → 起来是个没插件的空环境；用户关掉再开
  //   （第二次）才看到插件。这正是「第一次没插件、第二次才有」的来历。
  //
  //   正确顺序是先让 profile 就位、再往里装。profile 的骨架由 dsh 自己建 —— 我们
  //   借 `dsh plugin add` 这一步触发它（它内部会初始化 profile 再装包），
  //   下面逐件 addPlugin 天然就是这个顺序，不必额外造骨架文件（造的话还得跟
  //   dsh 各版本的模板保持同步，那是给自己找维护负担）。
  const dir = profileDirOf(profile)
  for (const name of [FREE_MODEL_PLUGIN, ...BUNDLED_PLUGINS]) {
    try {
      const target = await ensureBundledPlugin(name, profile)
      if (!target) {
        pushLog(`内置载荷里没有 ${name}，跳过预置`)
        continue
      }
      const manifestFile = join(dir, 'package.json')
      let listed = false
      try {
        const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
        listed = name in (manifest.dependencies ?? {})
      } catch {
        // profile 还没初始化：当成「没装」，下一步 addPlugin 会把它建出来再装
      }
      const onDisk = existsSync(join(dir, 'node_modules', name, 'package.json'))
      const bundled = (await registeredBundles(profile)).includes(name)
      if (listed && onDisk && bundled) continue
      if (!listed || !onDisk) await addPlugin(version, `file:${target}`, { profile })
      if (await registerBundle(name, profile)) {
        pushLog(`已把 ${name} 加入 profile 的 bundle 列表，重启后它就会出现`)
      }
    } catch (error) {
      // 单件失败不拖垮其余的：其余内置插件照旧走
      pushLog(`预置 ${name} 失败: ${error instanceof Error ? error.message : error}（可在插件页手动安装）`)
    }
  }
}

/** 读一个目录下 package.json 的版本号（读不到给 null）。 */
function readPackageVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

// ---- 整合包：把一批插件 + 一套配置一次装进一个 profile ----
//
// 与插件页的分工：插件页管「一个包」，整合包页管「一套环境」——一次写进 package.json 的
// 依赖与层栈、补丁层、用户级文件，再走同一条 `dsh plugin install` 把依赖装齐。格式用的是
// 生态里的 .dspack（DSH-PackForge），详情见 packs.js。
//
// 装进新 profile 是默认姿势：dsh 一次只跑一个 profile，新环境与现有插件互不污染，
// 装完在插件页切过去就行。每一步都可能失败（下载、解包、写文件、pnpm），所以每次安装
// 之前先备份被覆盖的文件，失败自动回滚。

/** 整合包的进度：走 SSE 的 progress 事件，靠 kind 与插件页那条区分开。 */
let packProgress = null
let packProgressName = ''
/** 检查过的包先放这儿，安装时不用再读一遍（页面刷新也还在）。 */
const packInspectCache = new Map()
/** 检查过的包最多留多久（inbox 里的临时文件）。 */
const PACK_INBOX_TTL = 6 * 60 * 60 * 1000
/** 最近一次导出的文件：只允许「在文件夹里显示」我们自己的产物。 */
let lastExportPath = ''

function packsDir() {
  return join(DATA, 'packs')
}

function packInboxDir() {
  return join(packsDir(), 'inbox')
}

function newPackToken() {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

function emitPackProgress(state) {
  packProgress = state
  emit('progress', state ? { ...state, kind: 'pack', name: packProgressName } : { phase: 'idle', kind: 'pack' })
}

/**
 * 把一个「来源」变成手边可读的包。
 *
 * 改造前这里会按来源类型去下载（直链、GitHub Release、市场条目）；改造后只剩本地两条路：
 *
 *   - `dir`：作者本地调试用的一堆文件，直接解析；
 *   - `file`：.dspack / .zip，读进来解析。
 *
 * 内置整合包在 userData 里也是一条本地路径（打包时放进 packs/），所以走的同样是这条。
 * 返回值里的 `file` 必须是个真实文件路径：安装那一步会拿它当缓存直接 readFile。
 */
async function openPackSource(source, { token = '', onProgress } = {}) {
  onProgress?.({ phase: 'fetch', done: 0, total: 0 })
  let parsed
  if (source && typeof source === 'object') {
    if (source.kind === 'dir') parsed = source
    else if (source.kind === 'file') parsed = source
    else throw new Error('离线版只能从本机文件或目录读取整合包')
  } else {
    parsed = parsePackSource(source)
  }

  if (parsed.kind === 'dir') {
    const pack = parsePackDir(parsed.path)
    return { pack, file: parsed.path, source: describeSource(parsed), token }
  }

  const file = parsed.path
  const info = statSync(file)
  if (info.size > 64 * 1024 * 1024) {
    throw new Error(`整合包太大（${Math.round(info.size / 1048576)} MB）：正常只装清单与配置`)
  }
  onProgress?.({ phase: 'fetch', done: info.size, total: info.size })
  const pack = parsePackArchive(await readFile(file))
  return { pack, file, source: describeSource(parsed), token }
}

/**
 * 检查阶段的载荷：把包摘要 + 目标 profile + 安装计划一起给页面。
 *
 * 页面据此显示「会写哪些文件、会覆盖什么、装到哪个 profile」，用户确认了才动手。
 * 纯本地计算（planInstall 只算不写），所以检查这一步真的是只读的。
 */
function packPlanPayload(pack, profile = '') {
  const target = safeProfile(profile || defaultProfileFor(pack))
  const base = { pack: packSummary(pack), target: { profile: target } }
  try {
    resolveBundledDependencies(pack)
    const plan = planInstall(pack, { home: dshHomeRoot(), profile: target, hostProfile: PROFILE_NAME })
    return {
      ...base,
      ok: pack.ok && plan.ok,
      target: { profile: target, createsProfile: plan.createsProfile, profileDir: plan.profileDir },
      plan: {
        notes: plan.notes,
        warnings: plan.warnings,
        errors: plan.errors,
        writes: plan.writes.map((write) => ({ rel: write.rel, kind: write.kind || '', note: write.note || '' })),
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...base, ok: false, plan: { notes: [], warnings: pack.warnings, errors: [...pack.errors, message], writes: [] } }
  }
}

/**
 * 清理检查整合包时落下的临时文件。
 *
 * 改造前检查会把下载来的包放进 inbox 缓存；现在就地读用户给的路径，没有副本要清 ——
 * 但历史版本可能留下过 inbox 目录，这里顺手把过期的删掉，别让它一直占着磁盘。
 */
async function prunePackInbox() {
  const dir = packInboxDir()
  if (!existsSync(dir)) return
  try {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name)
      try {
        if (Date.now() - statSync(file).mtimeMs > PACK_INBOX_TTL) await rm(file, { force: true })
      } catch { /* 单个文件出问题不影响其余 */ }
    }
  } catch { /* 目录读不了就算了，它只是个缓存 */ }
}

/** 整合包页的载荷：已装的包、可切换的 profile、市场地址。 */
function packsPayload() {
  const state = readPackState(DATA)
  const profilesRoot = join(homeDir(), 'profiles')
  const cards = []
  for (const profile of listProfiles()) {
    let plugins = []
    try {
      plugins = listPlugins(join(profilesRoot, safeProfile(profile))).plugins
    } catch {
      continue
    }
    // 空 profile（dsh 自带模板、刚建还没装东西的）不发卡：列出来全是空盒子
    if (!plugins.length) continue
    const thirdParty = plugins.filter((plugin) => !plugin.official)
    const records = state.packs.filter((record) => record.profile === profile)
    const latest = records.length ? records[records.length - 1] : null
    cards.push({
      profile,
      // 卡片标题就是 profile 名（dsh 和插件页的 profile 切换器都这么叫它）
      name: profile,
      pluginCount: plugins.length,
      officialCount: plugins.length - thirdParty.length,
      // 整包开关说的是「这个环境里的插件」，官方组件不参与
      enabled: thirdParty.some((plugin) => plugin.enabled),
      toggleable: thirdParty.some((plugin) => plugin.toggleable),
      plugins,
      // 来源：装过整合包就带上包的信息与安装记录；手动拼的 profile 记录为空
      records,
      source: latest?.source || '',
      installedAt: latest?.installedAt || '',
      packName: latest ? (latest.displayName || latest.name) : '',
      packVersion: latest?.version || '',
      createdProfile: records.some((record) => record.createdProfile === true),
      template: TEMPLATE_PROFILES.includes(profile),
    })
  }
  // 当前 profile 排最前，其余按插件数量从多到少
  cards.sort((a, b) => {
    if (a.profile === PROFILE_NAME) return -1
    if (b.profile === PROFILE_NAME) return 1
    return b.pluginCount - a.pluginCount
  })
  return {
    packs: cards,
    profile: PROFILE_NAME,
    // 整合包页的 home 指的是「profile 清单所在的家」（页面拿它拼路径显示），
    // 不是 dsh 的 DSH_HOME —— 隔离模式下两者不同。
    home: dshHomeRoot(),
    profiles: listProfiles(),
    // 社区市场索引在 GitHub 上，联网功能已移除：页面据此那一栏显示成离线不可用
    marketUrl: '',
    offline: true,
    busy: pluginBusy,
    progress: packProgress,
    builtin: builtinPack(),
  }
}

/**
 * 随安装包发的那份整合包（安装目录 packs/ 下第一份带 manifest.json 的目录）。
 *
 * 页面拿它画「内置整合包」那一栏：点一下就按本地目录走检查 → 安装，不联网、
 * 也不用去 Release 里找 .dspack。仓库里改了 packs/ 重新打包即生效。
 */
function builtinPack() {
  const root = join(ROOT, 'packs')
  let names = []
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return null
  }
  for (const name of names) {
    try {
      const manifest = JSON.parse(readFileSync(join(root, name, 'manifest.json'), 'utf8'))
      const display = manifest.displayName
      const displayName = typeof display === 'string'
        ? display
        : (display?.['zh-CN'] || display?.['en-US'] || manifest.name || name)
      return {
        path: join(root, name),
        name: String(manifest.name || name),
        displayName: String(displayName),
        version: String(manifest.version || ''),
        description: typeof manifest.description === 'string' ? manifest.description : '',
        profileName: String(manifest.profileName || ''),
        pluginCount: Array.isArray(manifest.bundles) ? manifest.bundles.length : 0,
      }
    } catch {
      // 不是整合包目录，看下一个
    }
  }
  return null
}

/**
 * 网络失败的说明：undici 只会给一句 `fetch failed`，真正的原因藏在 error.cause 里。
 *
 * 国内最常见的两种断法「看起来一模一样、其实完全不同」，光看 fetch failed 猜不到该做什么：
 * - raw.githubusercontent.com（市场索引在那儿）的 **DNS 被污染**：解析成 0.0.0.0 / 空地址，
 *   请求还没出门就失败（实测 cause 是 ENOENT，秒回）；
 * - github.com（release 资产那儿）**443 连不上**：解析正常，但一路等到超时（约 21 秒）。
 * 所以这里把域名、原因和出路都写进错误里，页面直接显示给用户看。
 */
function describeFetchError(error, url = '') {
  // 代理和直连都没通（proxy.js 拼的错误）：代理那头也按同一套词汇表讲一遍，
  // 否则「走代理没通」这句会被下面的 ECONNRESET 分支吃掉，用户根本看不到
  if (error?.proxyError) {
    return `走代理没通（${describeFetchError(error.proxyError, error.proxyUrl || '')}），直连也没通`
  }
  const cause = error?.cause
  const code = String(cause?.code || cause?.errno || '').toUpperCase()
  const causeMessage = String(cause?.message || '')
  const host = (() => {
    try {
      return new URL(String(url)).host
    } catch {
      return ''
    }
  })()
  if (code === 'ENOENT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `${host || '域名'} 解析不出来（DNS 返回了空地址，通常是 DNS 被污染）`
  }
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT'].includes(code)) {
    return `连不上 ${host || '目标'}（${code}）`
  }
  if (/certificate|self.signed|CERT_|TLS|SSL/i.test(causeMessage)) {
    return `${host || '目标'} 的证书校验不过（${causeMessage}）`
  }
  const detail = error?.message || '请求失败'
  return `${host ? `${host}：` : ''}${detail}${code ? `（${code}）` : ''}`
}

/**
 * 连不上时的第二条出路：现在是不是在走代理、走的哪个。
 * 代理开着却连不上，第一件该看的就是它——比「换下载源」更可能是原因（见 proxy.js 开头）。
 */
async function install(version) {
  const ver = safeVersion(version)
  if (installing) throw new Error(`正在安装 ${installing}`)
  const config = await loadConfig()
  if (listedVersions(config).includes(ver) || existsSync(binPath(ver))) {
    if (!listedVersions(config).includes(ver)) {
      config.versions = [ver, ...listedVersions(config)]
      await saveConfig(config)
      await emitState()
    }
    return
  }

  installing = ver
  installProgress = { phase: 'resolve' }
  await emitState()
  emit('progress', installProgress)
  const dir = versionDir(ver)
  await mkdir(dir, { recursive: true })
  pushLog(`安装 ${PKG}@${ver}`)
  try {
    await installSpec(dir, PKG, ver, (line, progress) => {
      // 「已安装 N/N」「已解析 N」只是进度，进度条那边（progress 事件）已经在显示了；
      // 再打进终端就是刷屏——装 700 多个包能刷出上百行。
      if (line && !NOISY_LOG_RE.test(line)) pushLog(line)
      if (progress) {
        installProgress = progress
        emit('progress', progress)
      }
    })
    if (!existsSync(binPath(ver))) throw new Error('安装完成但找不到 lib/bin.js')
    await mkdir(homeDir(), { recursive: true })
    config.versions = [ver, ...listedVersions(config).filter((item) => item !== ver)]
    await saveConfig(config)
    pushLog(`${ver} 安装完成`)
    await seedMarket(ver)
    await seedFreeModelPlugins(ver)
    // 装完新版顺手清掉更旧的（保留最新 + 最近装的一个，正在跑的除外）
    await pruneVersions(config)
  } catch (error) {
    if (!listedVersions(config).includes(ver)) {
      await rm(dir, { recursive: true, force: true })
    }
    throw error
  } finally {
    installing = null
    installProgress = null
    emit('progress', { phase: 'idle' })
    await emitState()
  }
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

function attachProcess(version, profile, child) {
  const key = instanceKey(version, profile)
  const proc = {
    key,
    version,
    profile,
    child,
    status: 'starting',
    url: null,
    tail: [],
    exit: null,
    startedAt: Date.now(),
  }
  instances.set(key, proc)
  // 一个组合一个实例，日志里要能看出是哪一行是哪台在说话（多开时尤其）
  const tag = `[${version}/${profile}] `
  const onChunk = (buf) => {
    const text = buf.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        proc.tail.push(line)
        if (proc.tail.length > 200) proc.tail.shift()
      }
      pushLog(`${tag}${line}`)
      const match = line.match(READY_RE)
      if (match && proc.status === 'starting') {
        proc.url = match[1]
        proc.status = 'running'
        emitState()
      }
    }
  }
  child.stdout.on('data', onChunk)
  child.stderr.on('data', onChunk)
  child.on('exit', (code, signal) => {
    proc.exit = { code, signal }
    pushLog(`${tag}已退出 code=${code ?? '-'} signal=${signal ?? '-'}`)
    if (instances.get(key)?.child === child) {
      instances.delete(key)
      lastHealth = null
    }
    emitState()
  })
  return proc
}

async function waitUntilReady(proc, version) {
  const started = Date.now()
  const label = `${version}/${proc.profile}`
  while (proc.status === 'starting') {
    if (instances.get(proc.key) !== proc) throw new Error(`${label} 启动失败`)
    if (Date.now() - started > START_TIMEOUT_MS) {
      killTree(proc.child.pid)
      throw new Error(`${label} 启动超时`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (!proc.url) throw new Error(`${version} 启动失败`)
  return { url: proc.url }
}

/**
 * 页面自检：按浏览器的方式抓一次 app 页面（token 换 cookie），把页面引用的所有
 * 客户端插件包请求一遍。dsh 进程活着不等于页面打得开——实例切换后浏览器里的旧
 * 页面会一直报「bundle script failed to load」，这一步用来区分"实例有问题"和
 * "你看的是旧页面"。
 * @returns {{origin: string, total: number, ok: number, failed: Array<{url: string, status: number, error?: string}>}}
 */
export async function checkWebPage(origin, token) {
  const base = String(origin).replace(/\/+$/, '')
  const first = await fetch(`${base}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  })
  const cookie = (first.headers.getSetCookie?.() || []).map((item) => item.split(';')[0]).join('; ')
  const headers = cookie ? { cookie } : {}
  const page = await fetch(`${base}/`, { headers, signal: AbortSignal.timeout(15000) })
  const html = await page.text()
  const urls = pageBundleUrls(html)
  const failed = []
  let ok = 0
  for (const url of urls) {
    try {
      const res = await fetch(`${base}${url}`, { headers, signal: AbortSignal.timeout(30000) })
      await res.arrayBuffer()
      if (res.status === 200) ok += 1
      else failed.push({ url, status: res.status })
    } catch (error) {
      failed.push({ url, status: 0, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { origin: base, total: urls.length, ok, failed }
}

/**
 * 从 app 页面 HTML 里挑出客户端插件包的地址。
 *
 * dsh 0.1.7 起页面里写的是**相对地址**（`plugins/…`，没有前导斜杠），0.1.6 及以前是
 * `/plugins/…`。只认绝对地址的话，0.1.7 上会一条都抓不到，然后自检报「0 个全部正常」——
 * 既没检到东西、又盖住了真正的加载失败（issue #24 的附带发现）。两种都认，统一成绝对路径。
 * @returns {string[]} 去重后的绝对路径
 */
export function pageBundleUrls(html) {
  const urls = new Set()
  for (const match of String(html).matchAll(/(?:^|["'\s(=,])(\.?\/?plugins\/[^"'\s<>)]+)/gm)) {
    const raw = match[1].replaceAll('&amp;', '&')
    urls.add(raw.startsWith('/') ? raw : `/${raw.replace(/^\.\//, '')}`)
  }
  return [...urls]
}

/** 启动成功后异步自检并把结论写进状态（失败不影响运行中的实例）。 */
async function selfCheckPage(url, version) {
  const match = /^http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/.exec(String(url || ''))
  if (!match) return
  try {
    const result = await checkWebPage(`http://127.0.0.1:${match[1]}`, match[2])
    lastHealth = {
      at: Date.now(),
      version,
      url,
      total: result.total,
      ok: result.ok,
      failed: result.failed.slice(0, 8),
    }
    if (result.total === 0) {
      // 一条都没抓到＝这次自检没得出结论，别写成「0 个全部正常」骗自己（dsh 换过引用方式）
      pushLog('页面自检：没在页面里找到客户端插件包引用（dsh 可能换了引用方式），这次没得出结论')
    } else if (result.failed.length) {
      pushLog(`页面自检：${result.ok}/${result.total} 个客户端插件包正常，${result.failed.length} 个失败`)
      for (const item of result.failed.slice(0, 5)) pushLog(`[自检] HTTP ${item.status || '-'} ${item.url.slice(0, 160)}`)
    } else {
      pushLog(`页面自检：${result.total} 个客户端插件包全部正常`)
    }
    await emitState()
  } catch (error) {
    pushLog(`页面自检没跑成：${error instanceof Error ? error.message : error}`)
  }
}

/** 起一个 web 子进程并等到它打印就绪 URL；失败时把子进程输出尾巴留给 AI 当证据。 */
async function bootOnce(ver, prof) {
  // ★ homeDir(prof)：隔离模式下每个 profile 一份独立家目录，这里必须按**要启动的那个**
  //   profile 建目录。早先写的是 homeDir()（= 当前 profile），起别的 profile 时
  //   建的是别人的家、而要用的那个还不存在。
  await mkdir(homeDir(prof), { recursive: true })
  // 预置（内置插件、以及随包的市场插件）。
  //
  // ★ 判据曾经是 `prof === PROFILE_NAME`（只给「当前 profile」预置），在共享家目录下
  //   看不出问题 —— 反正大家共用一份 profiles/web。但隔离模式下每个 profile 有自己
  //   的家目录，起 B 而不给它预置，B 就是一个空环境，用户得切来切去才凑齐。
  //   现在按**要启动的这个 profile** 走：它有自己的家，就该有自己那套插件。
  //
  //   重复调用是安全的：seedFreeModelPlugins 的三条判据（清单里有 / 文件在 /
  //   bundle 里启用了）本来就是幂等的，装好的直接跳过，不会重复跑 pnpm。
  await seedMarket(ver, prof)
  await seedFreeModelPlugins(ver, prof)
  const alongside = instances.size > 0
  const pinned = pinnedPort(ver, prof)
  if (pinned && !(await portAvailable(pinned))) {
    // 只说问题、不拦着：占着它的可能是用户马上要关掉的东西，也可能只是 Windows 的
    // TIME_WAIT。真起不来时下面那条 catch 会把话说清楚。
    pushLog(`固定端口 ${pinned} 现在被占用，这次启动多半会失败`)
  }
  pushLog(`启动 ${ver} · profile ${prof}${lanBindActive() ? ' · Web 绑定 局域网(0.0.0.0，由配置层决定)' : ''}${pinned ? ` · 固定端口 ${pinned}` : ''}${alongside ? '（与已在跑的实例并存）' : ''}`)
  const child = spawnDsh(ver, bootArgs(prof, alongside, pinned), prof)
  const proc = attachProcess(ver, prof, child)
  await emitState()
  try {
    const result = await waitUntilReady(proc, ver)
    // 钉了端口却没落到上面（额外参数里另有 --port，或 dsh 自己顺延了）：如实说一句，
    // 否则用户以为存下来的地址还有效
    if (pinned && urlPortOf(result.url) !== pinned) {
      pushLog(`固定端口 ${pinned} 没拿到，这次落在 ${result.url}`)
    }
    lastHealth = null
    await emitState()
    void selfCheckPage(result.url, ver)
    return result
  } catch (error) {
    const conflict = pinned ? describePortConflict(pinned, proc) : ''
    const failure = {
      at: Date.now(),
      version: ver,
      message: conflict || (error instanceof Error ? error.message : String(error)),
      exit: proc.exit,
      tail: (proc.tail || []).slice(-120),
    }
    lastFailure = failure
    if (conflict) {
      // 端口冲突时说清是哪个端口、谁占着——这正是固定端口最可能出的岔子
      const wrapped = new Error(conflict)
      wrapped.failure = failure
      throw wrapped
    }
    try {
      error.failure = failure
    } catch {
      // 非 Error 对象就算了
    }
    throw error
  }
}

/**
 * 启动某个「版本 × profile」。多开：已经在跑的那个组合不会被动，新组合在旁边另起一个
 * （同一组合重复点启动只会拿回已经在跑的那个）。
 */
async function startNow(version, profile = PROFILE_NAME) {
  const ver = safeVersion(version)
  const prof = safeProfile(profile)
  // 保留名（desktop）也能起：入口换成 RESERVED_BOOT，见 CLI_BLOCKED_PROFILES
  if (!listProfiles().includes(prof)) {
    throw new Error(`profile ${prof} 不存在（先用自带模板名起一次，或把装好的 profile 目录放进 .dsh/profiles）`)
  }
  const existing = instances.get(instanceKey(ver, prof))
  if (existing?.status === 'running' && existing.url) {
    return { url: existing.url }
  }
  if (existing?.status === 'starting') {
    return waitUntilReady(existing, ver)
  }
  const config = await loadConfig()
  if (!listedVersions(config).includes(ver)) throw new Error(`${ver} 未安装`)
  if (!existsSync(binPath(ver))) throw new Error('找不到官方入口 lib/bin.js')
  return bootOnce(ver, prof)
}

/** 一次启动尝试里最多按错误自动禁用几个插件（避免连环禁用不可收拾）。 */
const MAX_AUTO_DISABLE = 3
/** 最近一次按错误自动禁用的插件（管理页显示 + 一键恢复）。 */
let lastAutoFix = null
/** 最近一次「安全启动」（整份补丁层备份 + 摘掉第三方 bundle），管理页显示 + 一键还原。 */
let lastRecovery = null

/** 管理页的恢复档载荷：最近一次结果 + profile 里现存的补丁层备份。 */
function recoveryPayload(profile = PROFILE_NAME) {
  return { profile, last: lastRecovery?.profile === profile ? lastRecovery : null, backups: listPatchBackups(profileDirOf(profile)) }
}

/**
 * 这个 dsh 版本会不会自己隔离「可选插件启动失败」——0.1.7-rc.1 起会
 * （release notes：可选插件启动失败时其余插件仍可运行，只有必需插件失败才退出；
 * 并把分类诊断写进日志文件、在插件页给出启停入口）。
 * 那种版本上启动器不该再按 stdout 正则去改用户的补丁层：既多余，也可能误伤。
 */
export function dshToleratesOptionalFailures(version) {
  const parsed = parseVer(version)
  const since = parseVer('0.1.7-rc.1')
  return Boolean(parsed) && Boolean(since) && cmpVer(parsed, since) >= 0
}

/**
 * 兼容模式：启动输出点名了某个插件行加载失败时，把该行写进补丁层禁用。
 * 只信任错误的原始输出（failed to import loader entry <行> (<包>)），官方组件不动。
 * @returns 是否改动了配置（改动后上层立刻重试启动）。
 */
async function autoDisableFailedPlugins(error, already, profile = PROFILE_NAME) {
  const settings = await loadSettings()
  if (settings.autoDisablePlugins === false) return false
  // 补丁层写在出事那份 profile 自己头上：多开下别的 profile 正跑着，不能改错文件
  const dir = profileDirOf(profile)
  const failure = error?.failure || lastFailure
  // 新版本 dsh 自己扛得住可选插件失败，启动器就别替它做决定（原因见 dshToleratesOptionalFailures）
  const version = failure?.version || primaryInstance()?.version || ''
  if (dshToleratesOptionalFailures(version)) {
    pushLog(`[兼容] ${version} 的 dsh 会自己隔离出问题的可选插件，本次不自动禁用；失败原因看它自己的插件页/日志`)
    return false
  }
  const text = `${failure?.message || ''}\n${(failure?.tail || []).join('\n')}`

  // 禁掉一个加载行并记账；返回是否真的动手了（没改动就别重试，免得打转）
  const tryDisable = async (id, name, note) => {
    try {
      // 改补丁层前拿 profile 写独占：与「安全启动」/还原互斥，别互相踩
      const result = await withProfileLock(dir, () => disableRowId(dir, id))
      if (!result.changed) return false
      pushLog(`[兼容] ${note}，已写入 cordis.patch.yml 禁用「${id}」，重试启动…`)
      already.add(id)
      // name 会原样显示在「启动时自动禁用了：…」里，note 只进日志
      lastAutoFix = {
        at: Date.now(),
        version: failure?.version || null,
        plugins: [...(lastAutoFix?.plugins || []), { name, id }],
      }
      await emitState()
      return true
    } catch (error2) {
      pushLog(`[兼容] 自动禁用「${id}」失败：${error2 instanceof Error ? error2.message : error2}`)
      return false
    }
  }

  // 一、报错直接点名了某个加载行
  for (const row of parseFailedRows(text)) {
    if (already.has(row.id)) continue
    if (/^@deepseek-ai\//.test(row.pkg)) continue
    const owner = ownerOfRow(dir, row.id)
    if (owner && /^@deepseek-ai\//.test(owner)) continue
    if (await tryDisable(row.id, row.pkg, `${row.pkg} 的加载行「${row.id}」加载失败`)) return true
  }

  // 二、形状解析没命中时换个方向：顶层命中的可能是个核心 loader，出问题的插件藏在
  //     cause 里（见 pluginsNamedInFailure 的说明）。拿已装插件的名字去报错里找，
  //     按出现顺序一个个试，每次只禁一个再重试。
  for (const plugin of pluginsNamedInFailure(dir, text)) {
    const id = plugin.ids.find((rowId) => !already.has(rowId))
    if (!id) continue
    if (await tryDisable(id, plugin.name, `报错点名了 ${plugin.name}`)) return true
  }
  return false
}

/**
 * 启动失败 → 自动修复 → 重试（兼容模式），直到成功或无法再修。
 * 先试禁用出问题的插件行，再试重建 profile 依赖（两者各只做一次，避免打转）。
 * 修复全部落在这次启动的 profile 自己头上（多开下别的 profile 不能被顺手改掉）。
 */
async function startWithRepair(version, profile = PROFILE_NAME) {
  lastAutoFix = null
  const autoDisabled = new Set()
  let depsRepaired = false
  let lastError
  // 每次启动都补齐 profile 的 .npmrc：插件市场的安装也会走这个文件，
  // 早于任何一次 add 就有这行，市场里点安装才不会撞上 peer 求交那个坑。
  // 只对当前 profile 做——起别的 profile 不动它的文件，人家可能就是故意留空的
  if (profile === PROFILE_NAME) await ensureProfileNpmrc(profile).catch(() => {})
  for (;;) {
    try {
      return await startNow(version, profile)
    } catch (error) {
      lastError = error
      pushLog(`启动失败：${error instanceof Error ? error.message : error}`)
      if (autoDisabled.size < MAX_AUTO_DISABLE && await autoDisableFailedPlugins(error, autoDisabled, profile)) {
        continue
      }
      if (!depsRepaired && await repairProfileDeps(version, error, profile)) {
        depsRepaired = true
        continue
      }
      break
    }
  }
  throw lastError
}

let startChain = Promise.resolve()

async function start(version, profile) {
  const run = startChain.then(async () => {
    const name = safeProfile(profile || PROFILE_NAME)
    if (maintainingProfiles.has(name)) throw new Error(`profile「${name}」正在修改，稍后再启动`)
    startingProfiles.add(name)
    try {
      return await startWithRepair(version, name)
    } finally {
      startingProfiles.delete(name)
    }
  })
  startChain = run.then(() => {}, () => {})
  return run
}

export async function launchInstalled() {
  const live = primaryInstance()
  if (live?.status === 'running' && live.url) {
    return { version: live.version, url: live.url }
  }
  if (live?.status === 'starting') {
    const result = await start(live.version)
    return { version: live.version, url: result.url }
  }
  const installed = listedVersions(await loadConfig())
  if (!installed.length) return { version: null, url: null }
  const version = installed[0]
  const result = await start(version)
  return { version, url: result.url }
}

/**
 * 重启：多开下把在跑的实例都重启一遍（每个还用它自己的版本和 profile），一个都没跑就起一个。
 * 某个起不来不拦着后面的，但错误要往上抛——页面得知道有实例没回来。
 */
export async function restartInstalled() {
  const targets = instanceList().map((proc) => ({ version: proc.version, profile: proc.profile }))
  if (!targets.length) return launchInstalled()
  await stop()
  let last = null
  let failure = null
  for (const { version, profile } of targets) {
    try {
      const result = await start(version, profile)
      last = { version, profile, url: result.url }
    } catch (error) {
      failure = failure || error
    }
  }
  if (failure) throw failure
  return last
}

export function onState(listener) {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

export function setHost(next) {
  host = { ...host, ...next }
}

/**
 * dsh 自带的 profile 模板名（见 @deepseek-ai/dsh-app-boot 的 PROFILE_TEMPLATES）：
 * 这些名字首次使用时 dsh 会自动初始化。其余名字必须先在磁盘上存在（目录里有
 * package.json），否则 dsh 会直接拒绝启动——所以设置页只让人从可用列表里挑。
 */
const TEMPLATE_PROFILES = ['web', 'headless', 'acp', 'sdk', 'sdk-minimal']

/**
 * 可切换的 profile：磁盘上已初始化的 + dsh 自带模板名 + 当前值。
 * 前导点开头的目录是启动器自己的内部目录（保留名 profile 的别名，见 ensureProfileAlias），不算 profile。
 */
export function listProfiles(root = profilesRoot()) {
  const names = new Set(TEMPLATE_PROFILES)
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      if (existsSync(join(root, entry.name, 'package.json'))) names.add(entry.name)
    }
  } catch { /* 还没有 profiles 目录 */ }
  if (PROFILE_NAME) names.add(PROFILE_NAME)
  return [...names].sort()
}

/**
 * 弹系统「选择文件夹」对话框，返回选中的绝对路径（取消/失败就返回空串）。
 *
 * 页面里的 `<input type="file" webkitdirectory>` 只能拿到相对路径，浏览器也不给绝对路径，
 * 所以目录选择必须由管理页所在的本机进程来做。
 */
function pickDirectory() {
  if (IS_MAC) return pickDirectoryMac()
  if (!IS_WINDOWS) throw new Error('只有 Windows 和 macOS 支持目录选择')
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = '选择 dsh 版本目录'",
    '$d.ShowNewFolderButton = $true',
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
  ].join('; ')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-STA', '-NoProfile', '-Command', script],
      { windowsHide: true, timeout: 5 * 60 * 1000, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(String(stdout || '').trim())
      },
    )
  })
}

/** AppleScript 里用户点「取消」的错误号：不算失败，当作没选。 */
const APPLESCRIPT_USER_CANCELED = '-128'

/**
 * 弹系统的文件对话框（选一个整合包 / 选导出到哪），返回绝对路径，取消返回空串。
 *
 * 和目录选择同一套做法：页面拿不到本机绝对路径，只能由管理页所在进程来弹。
 * 注入到 PowerShell / AppleScript 里的字符串先把单引号去掉——它们都是单引号包裹的。
 */
function pickFileWin({ save, defaultName, filter }) {
  const cleanName = String(defaultName || '').replace(/'/g, '')
  const cleanFilter = String(filter || '').replace(/'/g, '')
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    save
      ? `$d = New-Object System.Windows.Forms.SaveFileDialog; $d.FileName = '${cleanName}'; $d.OverwritePrompt = $true`
      : '$d = New-Object System.Windows.Forms.OpenFileDialog',
    `$d.Filter = '${cleanFilter}'`,
    save ? "$d.Title = '导出整合包'" : "$d.Title = '选择整合包'",
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
  ].join('; ')
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-STA', '-NoProfile', '-Command', script], { windowsHide: true, timeout: 10 * 60 * 1000, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(String(stdout || '').trim())
    })
  })
}

function pickFileMac({ save, defaultName }) {
  const cleanName = String(defaultName || '').replace(/["\\]/g, '')
  const script = save
    ? `activate\nPOSIX path of (choose file name with prompt "导出整合包" default name "${cleanName}")`
    : 'activate\nPOSIX path of (choose file with prompt "选择整合包")'
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 10 * 60 * 1000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        if (String(stderr || '').includes(`(${APPLESCRIPT_USER_CANCELED})`)) resolve('')
        else reject(error)
        return
      }
      resolve(String(stdout || '').trim().replace(/(.)\/+$/, '$1'))
    })
  })
}

const PACK_FILE_FILTER_DSPACK = '整合包 (*.dspack)|*.dspack|ZIP 压缩包 (*.zip)|*.zip|所有文件 (*.*)|*.*'

function pickPackFile({ save = false, defaultName = '' } = {}) {
  if (IS_MAC) return pickFileMac({ save, defaultName })
  if (!IS_WINDOWS) throw new Error('只有 Windows 和 macOS 支持文件选择')
  return pickFileWin({ save, defaultName, filter: PACK_FILE_FILTER_DSPACK })
}

/**
 * 在文件管理器里定位一个文件。
 *
 * 只放行启动器自己的产物（刚导出的包、inbox 里的临时文件）——这个接口没有鉴权，
 * 做成「能打开任意路径」等于给本机开了个文件管理器后门。
 */
function revealPath(target) {
  const value = String(target || '')
  if (!value) throw new Error('先给一个路径')
  if (!existsSync(value)) throw new Error('这个路径不存在')
  const allowed = value === lastExportPath || value === packsDir() || value.startsWith(`${packsDir()}${sep}`)
  if (!allowed) throw new Error('只支持显示整合包自己的文件')
  if (IS_MAC) execFile('open', ['-R', value], { windowsHide: true })
  else if (IS_WINDOWS) execFile('explorer', [`/select,${value}`], { windowsHide: true })
  else execFile('xdg-open', [dirname(value)], { windowsHide: true })
}

/** macOS 的目录选择走 AppleScript 的 choose folder（系统自带，不需要额外权限）。 */
function pickDirectoryMac() {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      // activate 把对话框带到最前，否则它可能躲在管理页窗口后面
      ['-e', 'activate', '-e', 'POSIX path of (choose folder with prompt "选择 dsh 版本目录")'],
      { timeout: 5 * 60 * 1000, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          if (String(stderr || '').includes(`(${APPLESCRIPT_USER_CANCELED})`)) resolve('')
          else reject(error)
          return
        }
        // POSIX path 带尾斜杠，去掉和其它地方的目录写法保持一致
        resolve(String(stdout || '').trim().replace(/(.)\/+$/, '$1'))
      },
    )
  })
}

/**
 * 选一个文件（导出 zip 时用来定路径，导入时用来挑包）。
 * save = true 走「保存」对话框（可以是个还不存在的文件名），否则走「打开」对话框。
 */
function pickFile({ save = false, name = '' } = {}) {
  if (IS_MAC) {
    const what = save ? 'choose file name with prompt "选择保存位置"' : 'choose file with prompt "选择 ZIP 文件"'
    return new Promise((resolve, reject) => {
      execFile(
        'osascript',
        ['-e', 'activate', '-e', 'POSIX path of (' + what + (save && name ? ` default name "${name}"` : '') + ')'],
        { timeout: 5 * 60 * 1000, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) {
            if (String(stderr || '').includes(`(${APPLESCRIPT_USER_CANCELED})`)) resolve('')
            else reject(error)
            return
          }
          resolve(String(stdout || '').trim().replace(/(.)\/+$/, '$1'))
        },
      )
    })
  }
  if (!IS_WINDOWS) throw new Error('只有 Windows 和 macOS 支持文件选择，这里请手填路径')
  const dialog = save ? 'SaveFileDialog' : 'OpenFileDialog'
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    `$f = New-Object System.Windows.Forms.${dialog}`,
    "$f.Filter = 'ZIP 文件 (*.zip)|*.zip|所有文件 (*.*)|*.*'",
    save ? "$f.FileName = '" + String(name || 'dsh-backup.zip').replace(/'/g, "''") + "'" : '',
    "$f.Title = '" + (save ? '导出到哪个 ZIP 文件' : '选择要导入的 ZIP 文件') + "'",
    "$f.OverwritePrompt = $true",
    "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.FileName) }",
  ].filter(Boolean).join('; ')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-STA', '-NoProfile', '-Command', script],
      { windowsHide: true, timeout: 5 * 60 * 1000, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(String(stdout || '').trim())
      },
    )
  })
}

/** 允许当作"本机"的主机名——打开本机页面、判断请求来源都用它。 */const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 严格解析成本机 http(s) 地址；不是就抛错（前缀正则挡不住 `/?&calc` 这种尾巴）。 */
function assertLocalUrl(target) {
  let parsed
  try {
    parsed = new URL(String(target))
  } catch {
    throw new Error('只能打开本机地址')
  }
  if (!/^https?:$/.test(parsed.protocol) || !LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('只能打开本机地址')
  }
  return parsed.href
}

/**
 * 交给系统默认程序打开。
 *
 * Windows 走 `cmd /c start`，而 cmd 会把这行**再解析一遍**：URL 里的 `&` 是语句
 * 分隔符、`|<>^()%"` 各有含义，于是 `http://127.0.0.1:1/?&calc` 能直接跑起任意命令
 * （Node 只给含空格的参数加引号，而 URL 里通常没有空格）。所以这里只放行 cmd 会
 * 原样看待的字符——够用（本机地址就是 `http://127.0.0.1:端口/路径?k=v`），
 * 其余一律拒绝，比在字符串上做转义可靠。
 */
const CMD_SAFE_URL = /^[A-Za-z0-9\-._~:/?#\[\]@$'*,;=+]+$/

/**
 * Chromium 系浏览器（支持 --app= 应用窗口）的常见安装位置。
 * 顺序即优先级：先用户的 Chrome，再 Edge（Windows 自带，兜底最稳）。
 * DSH_CHROMIUM 可以指定一个，方便用便携版或专门指定某个浏览器。
 */
export function chromiumCandidates(env = process.env, platform = process.platform) {
  if (env.DSH_CHROMIUM) return [env.DSH_CHROMIUM]
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  if (platform !== 'win32') return ['google-chrome', 'chromium', 'microsoft-edge']
  return [
    join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean)
}

/** 找到可用的 Chromium 就返回它的路径，否则空串（调用方退回默认浏览器）。 */
export function findChromiumBrowser(env = process.env, platform = process.platform) {
  return chromiumCandidates(env, platform).find((file) => Boolean(file) && existsSync(file)) || ''
}

/** 应用窗口的参数：--app=<url> 打开的是没有地址栏、没有标签栏的独立窗口。 */
export function appWindowArgs(url) {
  return [`--app=${String(url)}`]
}

/** 用 Chromium 的应用窗口打开网址；找不到浏览器返回 false，交给调用方兜底。 */
function openInAppWindow(url) {
  const browser = findChromiumBrowser()
  if (!browser) return false
  try {
    execFile(browser, appWindowArgs(url), { windowsHide: true })
    pushLog(`用应用窗口打开：${basename(browser)}`)
    return true
  } catch (error) {
    pushLog(`应用窗口没打开（${error instanceof Error ? error.message : error}），改用默认浏览器`)
    return false
  }
}

/**
 * 内嵌窗口模式：本进程是被 DSH.exe / DSH-X.app 的原生外壳拉起来的（它设了
 * DSH_APP_WINDOW=1），它在 stdout 上收这一行约定标记（和 __DSH_SHOW__ 一个路子），
 * 收到就把地址装进它自己创建的窗口里。不经过浏览器进程——这正是这个模式存在的理由：
 * app 模式借的还是浏览器（只是没有地址栏），window 模式的窗口完全归启动器所有，
 * 关窗口 / 托盘 / 退出都由它说了算。
 */
const OPEN_SIGNAL = '__DSH_OPEN__'

/** 本进程是不是由原生外壳（DSH.exe / DSH-X.app）托管：只有它能开内嵌窗口。 */
function shellWindowHost() {
  return process.env.DSH_APP_WINDOW === '1'
}

/**
 * 这个地址该由谁打开：'window'（启动器内嵌窗口）还是 'browser'（系统浏览器）。
 * 纯函数，便于测试；两个条件缺一不可——设置里选了 window，且真的有个外壳在收标记
 * （源码运行 npm start 时没有外壳，选 window 也只会安静地退回浏览器）。
 */
export function openRoute(mode, shellWindow) {
  return mode === 'window' && shellWindow ? 'window' : 'browser'
}

/**
 * 交给系统默认程序打开。openMode 为 app 时优先用 Chromium 的应用窗口（更像个 App、
 * 没有地址栏），找不到 Chrome/Edge 就安静退回默认浏览器；为 window 时交给原生外壳
 * 自己的窗口（不经过浏览器进程）。
 *
 * Windows 走 `cmd /c start`，而 cmd 会把这行**再解析一遍**：URL 里的 `&` 是语句
 * 分隔符、`|<>^()%"` 各有含义，于是 `http://127.0.0.1:1/?&calc` 能直接跑起任意命令
 * （Node 只给含空格的参数加引号，而 URL 里通常没有空格）。所以这里只放行 cmd 会
 * 原样看待的字符——够用（本机地址就是 `http://127.0.0.1:端口/路径?k=v`），
 * 其余一律拒绝，比在字符串上做转义可靠。
 */
function openExternal(target, mode = OPEN_MODE) {
  const url = String(target)
  // 内嵌窗口：地址交给原生外壳自己的窗口，连浏览器进程都不起（见 OPEN_SIGNAL）
  if (openRoute(mode, shellWindowHost()) === 'window') {
    process.stdout.write(`${OPEN_SIGNAL} ${url}\n`)
    return
  }
  if (mode === 'app' && /^https?:/i.test(url)) {
    if (openInAppWindow(url)) return
    pushLog('没找到 Chrome/Edge，改用系统默认浏览器打开')
  }
  if (process.platform === 'win32') {
    if (!CMD_SAFE_URL.test(url)) throw new Error('地址里含不能安全打开的字符')
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true })
    return
  }
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])
}

function openLocalUrl(target) {
  openExternal(assertLocalUrl(target))
}

/**
 * 请求是不是来自本机。带 Origin 的只有浏览器：别的网页往 127.0.0.1 发跨站 POST 时
 * 会带上自己的 Origin（file:// 页面则是 `null`），而这个管理页没有任何鉴权，不挡的话
 * 任意网页都能让启动器装插件、起进程、开链接。托盘 / curl / 本机脚本不带 Origin。
 */
function sameSiteRequest(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return LOCAL_HOSTS.has(parsed.hostname.toLowerCase()) && (!parsed.port || Number(parsed.port) === PORT)
  } catch {
    return false
  }
}

/** Host 头是不是我们自己（DNS rebinding 的请求里写的是攻击者的域名）。 */
function isLocalHostHeader(host) {
  if (!host) return true
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(host).trim().toLowerCase())
  if (!match) return false
  if (!LOCAL_HOSTS.has(match[1])) return false
  return !match[2] || Number(match[2]) === PORT
}

export { pruneDanglingLinks, pruneVersions, snapshot, stop }

/**
 * 停止实例：版本 + profile 都给就停那一个组合；只给版本就停那个版本的全部
 * （同版本可能用不同 profile 各跑着一份）；都没给就全停（托盘的「停止」是这条）。
 * 指名了一个没在跑的组合不算错，什么都不做——多开下页面和状态本来就可能差一拍。
 */
async function stop(version, profile = '') {
  const wantedVersion = typeof version === 'string' && version && VERSION_RE.test(version) ? version : ''
  let wantedProfile = ''
  if (wantedVersion && typeof profile === 'string' && profile) {
    try { wantedProfile = safeProfile(profile) } catch { wantedProfile = '' }
  }
  const targets = !wantedVersion
    ? instanceList()
    : wantedProfile
      ? [instances.get(instanceKey(wantedVersion, wantedProfile))].filter(Boolean)
      : instanceList().filter((proc) => proc.version === wantedVersion)
  if (!targets.length) return
  for (const proc of targets) proc.status = 'stopping'
  await emitState()
  await Promise.all(targets.map(async (proc) => {
    const closed = new Promise((resolve) => proc.child.once('close', resolve))
    killTree(proc.child.pid)
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))])
    if (instances.get(proc.key)?.child === proc.child) instances.delete(proc.key)
  }))
  await emitState()
}

async function uninstallSystem(ver) {
  const system = detectSystemDsh()
  if (!system || system.version !== ver) throw new Error(`${ver} 未安装`)
  pushLog(`卸载系统 ${ver}`)
  await rm(system.root, { recursive: true, force: true })
  const prefix = dirname(dirname(dirname(system.root)))
  if (!IS_WINDOWS) {
    // POSIX 的全局包在 <prefix>/lib/node_modules，命令是 <prefix>/bin/dsh 这个符号链接。
    // 包删掉之后它就悬空了，existsSync 会跟着链接判成不存在，所以用 lstat；也只删链接，
    // 同名的普通文件不是 npm 装的，不碰。
    const link = join(dirname(prefix), 'bin', 'dsh')
    try {
      if (lstatSync(link).isSymbolicLink()) await rm(link, { force: true })
    } catch {
      // 没有就算了
    }
    return
  }
  for (const name of ['dsh', 'dsh.cmd', 'dsh.ps1']) {
    const file = join(prefix, name)
    if (existsSync(file)) await rm(file, { force: true })
  }
}

async function uninstall(version) {
  const ver = safeVersion(version)
  // 这个版本可能有多个 profile 的实例在跑，任何一个在都不能卸
  if (instanceList().some((proc) => proc.version === ver)) throw new Error('请先停止再移除')
  const config = await loadConfig()
  const versions = listedVersions(config)
  if (!versions.includes(ver)) throw new Error(`${ver} 未安装`)
  if (isManaged(ver)) {
    pushLog(`移除 ${ver}`)
    await rm(versionDir(ver), { recursive: true, force: true })
  }
  const system = detectSystemDsh()
  if (system?.version === ver) await uninstallSystem(ver)
  config.versions = versions.filter((item) => item !== ver)
  await saveConfig(config)
  await dropInstancePorts(ver)
  await emitState()
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** MCP 检测同时跑几台；stdio 探测要起真进程，别一次全放出去。 */
const PROBE_CONCURRENCY = 3
/** 检测超时：默认 20s，允许页面调，夹在 2s - 120s 之间。 */
function probeTimeout(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return 20000
  return Math.min(120000, Math.max(2000, Math.round(ms)))
}

/**
 * 探测用的环境：把启动器自带的 node/npx 放到 PATH 最前，但**不**继承 NODE_OPTIONS——
 * 那是启动器给 dsh 自己挂的加载钩子，塞给被测的 MCP 程序只会添乱。
 */
function probeEnv() {
  const env = { ...process.env, PATH: withBundledRuntime(process.env.PATH || '') }
  delete env.NODE_OPTIONS
  return env
}

/**
 * MCP 状态检测：对每台服务器真起一次进程 / 真连一次端点，走 MCP initialize 握手。
 * 结果只回给页面，不落盘——它是"现在这一下通不通"，不是配置的一部分。
 */
async function probeMcpServers(targets, timeoutMs, onResult) {
  const results = new Array(targets.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= targets.length) return
      const server = targets[index]
      const result = server.broken
        ? {
          serverName: server.serverName,
          transport: server.transport,
          ok: false,
          stage: 'broken',
          detail: server.error || '条目损坏，无法检测',
          ms: 0,
        }
        : await probeMcpServer(server, { timeoutMs, env: probeEnv(), cwd: profileDir(), clientName: `dsh-x ${APP_VERSION}` })
      results[index] = result
      onResult?.(result)
    }
  })
  await Promise.all(workers)
  return results
}

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  res.writeHead(status, {
    'content-type': type,
    'content-length': payload.length,
    'cache-control': 'no-store',
    connection: 'close',
    ...headers,
  })
  res.end(payload)
}

async function exportLogs() {
  const chunks = []
  for (const path of [`${LOG_FILE}.1`, LOG_FILE]) {
    try {
      chunks.push(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return redact(chunks.length ? chunks.join('') : logs.join('\n'), secretValues)
}

async function handleApi(req, res, url) {
  // 身份标记：端口被占用时我们要能分辨那是自己的另一个实例还是别人的程序
  if (url.pathname === '/api/ping') {
    send(res, 200, { app: 'dsh-x', version: APP_VERSION, port: PORT })
    return
  }
  // 改状态的请求只认本机来源（浏览器会带 Origin，本机程序不会）
  if (req.method !== 'GET' && !sameSiteRequest(req)) {
    send(res, 403, { error: '跨站请求被拒绝' })
    return
  }
  // 改造后不再有「远端版本列表」：可装的只有内置载荷里的那一个版本。
  // 保留这个端点是为了让老页面不报 404 —— 它现在回答的是离线事实。
  if (req.method === 'GET' && url.pathname === '/api/remote') {
    const info = offlineInfo()
    send(res, 200, {
      package: PKG,
      source: 'bundled',
      offline: true,
      tags: info.coreVersion ? { latest: info.coreVersion } : {},
      versions: info.coreVersion ? [info.coreVersion] : [],
      latest: info.coreVersion || null,
    })
    return
  }
  // 自更新已移除：离线版不从 GitHub 下载安装包。
  if (req.method === 'GET' && url.pathname === '/api/self') {
    send(res, 200, { current: APP_VERSION, latest: null, update: false, url: '', offline: true })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/pending') {
    send(res, 200, { update: null, offline: true })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/tray') {
    // 给 DSH.exe 的原生托盘读状态。纯文本 key=value，省得那边为了三行状态写 JSON 解析。
    const running = primaryInstance()
    send(res, 200, [
      `status=${running?.status || 'stopped'}`,
      `url=${running?.url || ''}`,
      `installed=${trayHasInstalled() ? 1 : 0}`,
      `lang=${LANG}`,
      // 托盘照着它决定「打开 DSH」是叫内嵌窗口还是丢给系统浏览器
      `openmode=${OPEN_MODE}`,
      // 本次是不是由原生外壳托管：外壳缺失时窗口模式不成立，托盘据此退回浏览器
      `shell=${shellWindowHost() ? 1 : 0}`,
    ].join('\n'), 'text/plain; charset=utf-8')
    return
  }
  // 更新日志来自 GitHub release feed，联网功能已移除；页面据此隐藏「查看更新内容」。
  if (req.method === 'GET' && url.pathname === '/api/changelog') {
    send(res, 200, { found: false, url: '', offline: true })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    send(res, 200, await publicSettings())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/logs/export') {
    res.setHeader('content-disposition', 'attachment; filename="dsh-x-logs.txt"')
    send(res, 200, await exportLogs(), 'text/plain; charset=utf-8')
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    send(res, 200, await snapshot())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/plugins') {
    // 浏览插件的 profile 与启动默认值分开；查看另一份配置不能偷偷改变启动行为。
    const profile = safeProfile(url.searchParams.get('profile') || PROFILE_NAME)
    send(res, 200, { ...packsPayload(), ...listPlugins(profileDirOf(profile)), profile, autoFix: lastAutoFix, recovery: recoveryPayload(profile) })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/recover') {
    const profile = safeProfile(url.searchParams.get('profile') || PROFILE_NAME)
    send(res, 200, recoveryPayload(profile))
    return
  }
  // 插件更新检查要从 registry 拉远端版本，联网功能已移除：一律回答「没有可更新的」，
  // 而不是抛错让页面弹红——离线版的插件升级靠换一份带新载荷的安装包。
  if (req.method === 'GET' && url.pathname === '/api/plugins/updates') {
    const profile = safeProfile(url.searchParams.get('profile') || PROFILE_NAME)
    send(res, 200, { updates: [], checked: 0, offline: true, profile })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/packs') {
    send(res, 200, packsPayload())
    return
  }
  // 社区市场索引在 GitHub 上，联网功能已移除。离线版的整合包来自内置载荷与本地文件，
  // 端点保留并回答空列表，页面上那部分入口会显示成「离线版不可用」。
  if (req.method === 'GET' && url.pathname === '/api/packs/market') {
    send(res, 200, { ok: true, entries: [], offline: true })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/packs/market/stats') {
    send(res, 200, { ok: true, entries: [], offline: true })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    res.write(`event: log\ndata: ${JSON.stringify({ lines: logs.slice(-120) })}\n\n`)
    res.write(`event: state\ndata: ${JSON.stringify(await snapshot())}\n\n`)
    if (installProgress) res.write(`event: progress\ndata: ${JSON.stringify(installProgress)}\n\n`)
    if (pluginProgress) res.write(`event: progress\ndata: ${JSON.stringify({ ...pluginProgress, kind: 'plugin', name: pluginProgressName })}\n\n`)
    // 整合包：检查和安装都可能几十秒（下载 + 解包 + pnpm），刷新页面要能接着显示
    if (packProgress) res.write(`event: progress\ndata: ${JSON.stringify({ ...packProgress, kind: 'pack', name: packProgressName })}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  const body = req.method === 'POST' ? await readJson(req) : {}
  // 更新提示已随自更新一起移除，这里只回一句「没有待跳过的更新」。
  if (req.method === 'POST' && url.pathname === '/api/pending/skip') {
    send(res, 200, { skippedUpdate: (await loadSettings()).skippedUpdate || {} })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/self/download') {
    // 第一步：下载。进度走 selfUpdate 事件，页面显示进度条
    try {
      send(res, 200, await downloadSelfUpdate())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`更新下载失败：${message}`)
      send(res, 500, { error: message })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/self/install') {
    // 第二步：用户点确认之后才走这里。先回页面，再收尾退出，把位子让给助手
    try {
      // 不在这里退出：安装程序会提示关闭正在运行的启动器，它自己会处理
      send(res, 200, await installSelfUpdate())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`更新安装失败：${message}`)
      send(res, 500, { error: message })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/restart') {
    send(res, 200, await restartInstalled())
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/quit') {
    // 托盘的「退出」走这里：先把响应发出去，再收尾退出，否则调用方只会看到连接被掐断
    send(res, 200, { ok: true })
    shutdown().finally(() => process.exit(0))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/install') {
    await install(body.version)
    send(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/start') {
    send(res, 200, await start(body.version, body.profile))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/instance-port') {
    send(res, 200, await setInstancePort(body.version, body.profile, body.port))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/launch-presets') {
    send(res, 200, await saveLaunchPreset(body))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/launch-presets/remove') {
    send(res, 200, await removeLaunchPreset(String(body.id ?? '')))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/launch') {
    send(res, 200, await launchInstalled())
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    await stop(body.version, body.profile)
    send(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/uninstall') {
    await uninstall(body.version)
    send(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    send(res, 200, await saveManagerSettings(body))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/proxy/test') {
    send(res, 200, await testNetwork())
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/recover') {
    // 安全启动：把补丁层整体移出启动路径（备份即改名），清单里只留官方 bundle。
    // 这是逐行自动禁用都失效时的最后手段；备份路径要回给页面，方便一键还原。
    try {
      const profile = body.profile ? String(body.profile) : PROFILE_NAME
      const dir = profileDirOf(profile)
      if (maintainingProfiles.has(profile)) throw new Error(`profile「${profile}」正在修改，稍后再试`)
      const result = await sanitizeProfile(dir)
      lastRecovery = { at: Date.now(), profile, backup: result.backup, dropped: result.dropped, warning: result.warning || null }
      pushLog(`[恢复] 安全启动（${profile}）：补丁层${result.backup ? `已备份到 ${basename(result.backup)}` : '本来就没有'}，摘掉第三方 bundle ${result.dropped.length} 个${result.dropped.length ? `（${result.dropped.join('、')}）` : ''}${result.warning ? `；${result.warning}` : ''}`)
      send(res, 200, { ok: true, ...packsPayload(), ...result, ...listPlugins(dir), profile, autoFix: lastAutoFix, recovery: recoveryPayload(profile) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`[恢复] 安全启动失败：${message}`)
      send(res, 500, { error: message })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/recover/restore') {
    try {
      const profile = body.profile ? String(body.profile) : PROFILE_NAME
      const dir = profileDirOf(profile)
      if (maintainingProfiles.has(profile)) throw new Error(`profile「${profile}」正在修改，稍后再试`)
      const result = await restoreProfileBackup(dir, body.backup)
      lastRecovery = null
      pushLog(`[恢复] 已还原补丁层 ${result.restored}${result.movedAside ? `（还原前的补丁挪到了 ${basename(result.movedAside)}）` : ''}${result.restoredBundles.length ? `，放回 bundle ${result.restoredBundles.length} 个` : ''}`)
      send(res, 200, { ok: true, ...packsPayload(), ...result, ...listPlugins(dir), profile, autoFix: lastAutoFix, recovery: recoveryPayload(profile) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`[恢复] 还原失败：${message}`)
      send(res, 500, { error: message })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/plugins/toggle') {
    const name = String(body.name || '')
    const enabled = body.enabled !== false
    // 整合包卡片可能装在别的 profile 上，切换插件时得能指定目标（不传就是当前 profile）
    const profile = safeProfile(String(body.profile || PROFILE_NAME))
    const target = profileDirOf(profile)
    const result = await editProfile(profile, () => setPluginEnabled(target, name, enabled))
    const where = body.profile && String(body.profile) !== PROFILE_NAME ? `（profile ${body.profile}）` : ''
    pushLog(`插件 ${name} → ${enabled ? '启用' : '禁用'}${where}${result.changed ? '' : '（无变化）'}`)
    send(res, 200, { ok: true, changed: result.changed, ...packsPayload(), ...listPlugins(target), profile, autoFix: lastAutoFix, recovery: recoveryPayload(profile) })
    return
  }
  // 插件在线更新已移除：离线版没有远端可拉，插件升级靠换一份带新载荷的安装包。
  // 端点保留并明确回答原因，页面据此把那几个按钮显示成不可用。
  if (req.method === 'POST' && url.pathname === '/api/plugins/update') {
    const profile = safeProfile(String(body.profile || PROFILE_NAME))
    send(res, 200, {
      ok: false,
      offline: true,
      reason: '离线版不做在线更新：插件来自安装包内置载荷，升级请安装新版本的安装包',
      done: [],
      failed: [],
      ...listPlugins(profileDirOf(profile)),
      profile,
      autoFix: lastAutoFix,
      recovery: recoveryPayload(profile),
    })
    return
  }
  // ---- 整合包：检查 / 安装 / 卸载 / 导出 ----

  if (req.method === 'POST' && url.pathname === '/api/packs/inspect') {
    const token = String(body.token || '') || newPackToken()
    const source = body.market
      ? { kind: 'market', id: String(body.market.id || ''), url: String(body.market.downloadUrl || ''), sha256: String(body.market.sha256 || ''), size: Number(body.market.size) || 0, name: String(body.market.name || '') }
      : String(body.source || '')
    packProgressName = body.market ? String(body.market.displayName || body.market.name || '') : String(body.source || '')
    emitPackProgress({ phase: 'fetch', done: 0, total: 0 })
    try {
      const opened = await openPackSource(source, { token, onProgress: (state) => emitPackProgress(state) })
      // 检查会往 inbox 落一份包，顺手清掉过期的：一次会话里检查很多个也不会把磁盘堆满
      void prunePackInbox()
      if (opened.token) {
        packInspectCache.set(opened.token, { file: opened.file, source: opened.source, raw: source, at: Date.now() })
      }
      const payload = { ok: true, token: opened.token, source: opened.source, bytes: opened.bytes || 0, ...packPlanPayload(opened.pack, String(body.profile || '')) }
      pushLog(`整合包检查：${payload.pack.displayName || payload.pack.name} ${payload.pack.version}（${payload.pack.bundles.length} 层、${payload.pack.dependencies.length} 个依赖）${payload.ok ? '' : '，有问题'}`)
      send(res, 200, payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`整合包检查失败：${message}`)
      send(res, 400, { ok: false, error: message })
    } finally {
      packProgressName = ''
      emitPackProgress(null)
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/install') {
    if (pluginBusy) {
      send(res, 400, { error: '正在装插件或整合包，等它结束再试' })
      return
    }
    const token = String(body.token || '')
    const cached = token ? packInspectCache.get(token) : null
    // 缓存里的 source 是给人看的描述（「目录：…」「链接：…」），重开源要用检查时那份原始输入
    const source = cached ? (cached.raw ?? cached.source) : (body.market
      ? { kind: 'market', id: String(body.market.id || ''), url: String(body.market.downloadUrl || ''), sha256: String(body.market.sha256 || ''), size: Number(body.market.size) || 0, name: String(body.market.name || '') }
      : String(body.source || ''))
    if (!cached && !body.source && !body.market) {
      send(res, 400, { error: token ? '这次检查的临时文件已经过期了，回到上一步重新检查一次再装' : '先检查一次整合包，再点安装' })
      return
    }
    pluginBusy = true
    let opened = null
    try {
      // 缓存里那条只在它真的是个文件时可用：从本地目录检查出来的包，缓存里记的是目录，
      // 直接 readFile 会 EISDIR（安装时重新解析一次目录才是对的，本地调试还会改动文件）。
      const cachedFile = cached?.file && existsSync(cached.file) && statSync(cached.file).isFile() ? cached.file : null
      opened = cachedFile
        ? { pack: parsePackArchive(await readFile(cachedFile)), file: cachedFile, source: cached.source, token }
        : await openPackSource(source, { token: token || newPackToken(), onProgress: (state) => emitPackProgress(state) })
      const pack = opened.pack
      packProgressName = pack.displayName || pack.fields.name
      if (!pack.ok) throw new Error(pack.errors.join('；'))
      const profile = safeProfile(String(body.profile || '') || defaultProfileFor(pack))
      // `bundled` 依赖先把安装包自带的那份复制到 DSH_HOME，再落成 file: 路径
      for (const name of bundledDependencyNames(pack)) {
        if (!(await ensureBundledPlugin(name))) throw new Error(`整合包依赖 ${name} 写的是 bundled，但安装包里没有这个插件`)
      }
      resolveBundledDependencies(pack)
      const plan = planInstall(pack, { home: dshHomeRoot(), profile, hostProfile: PROFILE_NAME })
      if (!plan.ok) throw new Error(plan.errors.join('；'))
      const version = await pluginCommandVersion()
      pushLog(`安装整合包 ${pack.fields.name} ${pack.fields.version} → profile ${profile}（${plan.writes.length} 个文件）`)
      emitPackProgress({ phase: 'write', done: 0, total: plan.writes.length })
      const result = await applyInstall(plan, {
        home: dshHomeRoot(),
        dataDir: DATA,
        pack,
        source: opened.source,
        runInstall: async (target) => {
          emitPackProgress({ phase: 'install', step: 'resolve', done: 0, total: 0 })
          await runProfileInstall(version, {
            profile: target,
            // pnpm 自己的相位放进 step：页面上「下载依赖」和「下载整合包」是两件事
            onProgress: (state) => emitPackProgress({ phase: 'install', step: state.phase, done: state.done, total: state.total }),
            log: pushLog,
          })
        },
        log: pushLog,
      })
      emitPackProgress({ phase: 'done', done: plan.writes.length, total: plan.writes.length })
      rememberPack(DATA, result.record)
      if (token) packInspectCache.delete(token)
      pushLog(`整合包 ${result.record.name} 已装进 profile「${profile}」（重启 dsh 后生效）`)
      send(res, 200, {
        ok: true,
        installed: result.record,
        plan: { notes: plan.notes, warnings: plan.warnings, writes: plan.writes.map((write) => write.rel) },
        ...packsPayload(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`整合包安装失败：${message}`)
      send(res, 400, { ok: false, error: message })
    } finally {
      pluginBusy = false
      packProgressName = ''
      emitPackProgress(null)
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/toggle') {
    const profile = String(body.profile || '')
    const enabled = body.enabled !== false
    if (!profile) {
      send(res, 400, { error: '要说清是哪个 profile' })
      return
    }
    const target = join(homeDir(), 'profiles', safeProfile(profile))
    const plugins = listPlugins(target).plugins
    if (!plugins.length) {
      send(res, 404, { error: `profile「${profile}」里没有已安装的插件` })
      return
    }
    // 卡片代表一整个 profile：开关管的是这个环境里所有第三方插件（官方组件不提供开关）
    const packages = plugins.filter((plugin) => !plugin.official).map((plugin) => plugin.name)
    let changed = 0
    const failed = []
    await editProfile(profile, () => {
      for (const item of packages) {
        try {
          if (setPluginEnabled(target, item, enabled).changed) changed += 1
        } catch (error) {
          failed.push(`${item}：${error instanceof Error ? error.message : error}`)
        }
      }
    })
    pushLog(`profile ${profile} 的插件 → ${enabled ? '启用' : '禁用'}（${changed} 个有变化${failed.length ? `，${failed.length} 个不支持：${failed.join('；')}` : ''}）`)
    send(res, 200, { ok: true, changed, failed, ...listPlugins(profileDir()), ...packsPayload(), autoFix: lastAutoFix, recovery: recoveryPayload() })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/update') {
    const profile = body.profile ? safeProfile(String(body.profile)) : ''
    if (!profile) {
      send(res, 400, { error: '要说清是哪个 profile' })
      return
    }
    // 使用明确的目标环境，浏览 Profile 不再写入全局启动设置。
    if (pluginBusy) {
      send(res, 400, { error: '正在装插件或整合包，等它结束再试' })
      return
    }
    // 在线更新要连 registry 比版本，联网功能已移除。这里如实回答「没有可更新的」，
    // 并把已有的插件列表原样带回，页面刷新后不会显示成出错。
    send(res, 200, {
      ok: false,
      offline: true,
      reason: '离线版不做在线更新：插件来自安装包内置载荷，升级请安装新版本的安装包',
      updated: 0,
      failed: [],
      unchanged: listPlugins(profileDirOf(profile)).plugins.filter((plugin) => !plugin.official).map((plugin) => plugin.name),
      ...packsPayload(),
      ...listPlugins(profileDirOf(profile)),
      profile,
      autoFix: lastAutoFix,
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/remove-profile') {
    // 手动拼出来的 profile 没有安装记录，撤不掉「安装时改过的文件」，只能整个删掉
    const profile = String(body.profile || '')
    if (!profile) {
      send(res, 400, { error: '要说清是哪个 profile' })
      return
    }
    if (profile === PROFILE_NAME) {
      send(res, 400, { error: `profile「${profile}」是启动器正在用的那个，先在插件页换一个 profile 再删` })
      return
    }
    if (TEMPLATE_PROFILES.includes(profile)) {
      send(res, 400, { error: `「${profile}」是 dsh 自带的 profile 模板，不能删` })
      return
    }
    const target = join(homeDir(), 'profiles', safeProfile(profile))
    if (!existsSync(target)) {
      send(res, 404, { error: `profile「${profile}」的目录不在` })
      return
    }
    try {
      await withIdleProfile(profile, () => rm(target, { recursive: true, force: true }))
      pushLog(`已删掉整个 profile「${profile}」`)
      send(res, 200, { ok: true, ...listPlugins(profileDir()), ...packsPayload(), autoFix: lastAutoFix, recovery: recoveryPayload() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`删 profile「${profile}」失败：${message}`)
      send(res, 400, { error: message })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/uninstall') {
    const name = String(body.name || '')
    const profile = String(body.profile || '')
    const record = readPackState(DATA).packs.find((item) => item.name === name && item.profile === profile)
    if (!record) {
      send(res, 404, { error: `没有「${name} 装在 ${profile}」这条安装记录` })
      return
    }
    if (pluginBusy) {
      send(res, 400, { error: '正在装插件或整合包，等它结束再试' })
      return
    }
    // 删目录这件事先判掉：允许的话才动手卸载，否则会留下「文件还原了、目录没删」的半截状态
    if (body.removeProfile === true) {
      if (!record.createdProfile) {
        send(res, 400, { error: '这个 profile 在装整合包之前就在，不敢整个删掉；可以手动清理这个目录' })
        return
      }
      if (record.profile === PROFILE_NAME) {
        send(res, 400, { error: `profile「${record.profile}」是启动器正在用的那个，先在插件页换一个 profile 再删` })
        return
      }
    }
    try {
      const completed = await withIdleProfile(profile, async () => {
        const lines = []
        const profilePath = join(homeDir(), 'profiles', profile)
        // profile 目录已经被手动删掉时不硬还原——那等于把空目录重新变出一堆配置文件，更吓人
        const gone = !existsSync(profilePath)
        const result = gone
          ? { ok: true, restored: 0 }
          : uninstallPack(record, { home: dshHomeRoot(), log: (line) => { lines.push(line); pushLog(`[整合包] ${line}`) } })
        if (gone) lines.push(`profile 目录「${profilePath}」已经不在了，只清掉安装记录，不再还原文件`)
        let removedProfile = false
        if (body.removeProfile === true) {
          await rm(join(homeDir(), 'profiles', record.profile), { recursive: true, force: true })
          removedProfile = true
          pushLog(`[整合包] 已删掉整个 profile「${record.profile}」`)
        }
        // 目录删成功才撤销安装记录；失败时至少还有记录可供用户重试。
        forgetPack(DATA, name, profile)
        pushLog(`整合包 ${name} 已从 profile「${profile}」卸下（还原 ${result.restored} 个文件${removedProfile ? '，并删除 profile 目录' : ''}）`)
        if (record.createdProfile && !removedProfile) {
          lines.push(`这个 profile 是整合包建的，包新建的文件已删掉；node_modules 里装过的插件还在，想清干净可以在整合包页勾「同时删掉整个 profile 目录」`)
        }
        return { restored: result.restored, lines, removedProfile }
      })
      send(res, 200, { ok: true, ...completed, ...packsPayload() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`整合包卸载失败：${message}`)
      send(res, 400, { error: message })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/export') {
    try {
      const profile = safeProfile(String(body.profile || '') || PROFILE_NAME)
      const profilePath = join(homeDir(), 'profiles', profile)
      if (!existsSync(join(profilePath, 'package.json'))) throw new Error(`profile「${profile}」里没有 package.json，没有可导出的东西`)
      const name = String(body.name || '').trim() || profile
      const version = String(body.version || '').trim() || '1.0.0'
      if (!/^[0-9A-Za-z._+-]{1,24}$/.test(version)) throw new Error('版本号只能用字母、数字和 . _ + - （不超过 24 个字符）')
      const target = String(body.path || '') || await pickPackFile({ save: true, defaultName: `${name}-${version}.dspack` })
      if (!target) {
        send(res, 200, { ok: false, canceled: true })
        return
      }
      const out = exportPack({
        profileDir: profilePath,
        home: dshHomeRoot(),
        name,
        version,
        displayName: String(body.displayName || '').trim(),
        includeHome: body.includeHome === true,
      })
      await writeFile(target, out.buffer)
      lastExportPath = target
      pushLog(`已导出整合包：${target}（${out.bundles.length} 层、${Object.keys(out.dependencies).length} 个依赖${out.homeFiles.length ? `、${out.homeFiles.length} 个用户级文件` : ''}）`)
      send(res, 200, {
        ok: true,
        path: target,
        bytes: out.buffer.length,
        bundles: out.bundles,
        dependencies: out.dependencies,
        homeFiles: out.homeFiles,
        skipped: out.skipped,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`导出整合包失败：${message}`)
      send(res, 400, { error: message })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/pick-file') {
    try {
      const path = await pickPackFile({ save: false })
      send(res, 200, { path })
    } catch (error) {
      send(res, 200, { path: '', error: error?.message || String(error) })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/reveal') {
    try {
      revealPath(String(body.path || ''))
      send(res, 200, { ok: true })
    } catch (error) {
      send(res, 400, { error: error?.message || String(error) })
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/mcp') {
    send(res, 200, { ...listMcpServers(patchFile()), profile: PROFILE_NAME })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/mcp/save') {
    const result = await editProfile(PROFILE_NAME, () => saveMcpServer(patchFile(), body))
    const extras = [
      result.repaired ? '覆盖了损坏区块' : '',
      ...(result.warnings || []),
    ].filter(Boolean)
    pushLog(`MCP 服务器 ${body.serverName} 已保存（${body.transport === 'streamable-http' ? 'http' : 'stdio'}）${extras.length ? ` · ${extras.join('；')}` : ''}`)
    send(res, 200, {
      ok: true,
      warnings: result.warnings || [],
      repaired: result.repaired === true,
      ...listMcpServers(patchFile()),
      profile: PROFILE_NAME,
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/mcp/probe') {
    // 真起进程 / 真连端点：一次一台或指定的几台，结果按入参顺序返回
    const { servers } = listMcpServers(patchFile())
    const wanted = Array.isArray(body.serverNames) && body.serverNames.length
      ? new Set(body.serverNames.map((name) => String(name)))
      : null
    const targets = servers.filter((server) => !wanted || wanted.has(server.serverName))
    if (!targets.length) {
      send(res, 200, { ok: true, results: [] })
      return
    }
    pushLog(`开始检测 ${targets.length} 个 MCP 服务器（会真起进程/连端点）…`)
    const results = await probeMcpServers(targets, probeTimeout(body.timeoutMs))
    const passed = results.filter((item) => item.ok).length
    const failed = results.filter((item) => !item.ok)
    pushLog(`MCP 检测完成：${passed} 台在线${failed.length ? `，${failed.length} 台有问题（${failed.map((item) => `${item.serverName}:${item.stage}`).join('、')}）` : ''}`)
    send(res, 200, { ok: true, results })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/mcp/toggle') {
    const name = String(body.serverName || '')
    const result = await editProfile(PROFILE_NAME, () => setMcpEnabled(patchFile(), name, body.enabled !== false))
    pushLog(`MCP 服务器 ${name} → ${body.enabled !== false ? '启用' : '停用'}${result.changed ? '' : '（无变化）'}`)
    send(res, 200, { ok: true, changed: result.changed, ...listMcpServers(patchFile()), profile: PROFILE_NAME })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/mcp/remove') {
    const name = String(body.serverName || '')
    await editProfile(PROFILE_NAME, () => removeMcpServer(patchFile(), name))
    pushLog(`MCP 服务器 ${name} 已删除`)
    send(res, 200, { ok: true, ...listMcpServers(patchFile()), profile: PROFILE_NAME })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    send(res, 200, { ...skillsPayload(), profile: PROFILE_NAME })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/skills/toggle') {
    const root = rootDirOf(skillRoots(homeDir()), body.root)
    setSkillEnabled(root, String(body.path || ''), body.enabled !== false)
    pushLog(`技能 ${body.path} → ${body.enabled !== false ? '启用' : '停用'}`)
    send(res, 200, { ok: true, ...skillsPayload(), profile: PROFILE_NAME })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/skills/open-folder') {
    // 在资源管理器里打开技能根目录（默认 ~/.dsh/skills）；目录不存在就顺手建好
    const dir = rootDirOf(skillRoots(homeDir()), body.root || 'dsh')
    await mkdir(dir, { recursive: true })
    const opener = process.platform === 'win32' ? 'explorer.exe'
      : process.platform === 'darwin' ? 'open' : 'xdg-open'
    // 不能加 windowsHide：它会把「隐藏启动」的状态传给 explorer，文件夹窗口就弹不出来了
    execFile(opener, [dir], (error) => {
      // explorer.exe 成功时也会返回退出码 1，只把真正的启动失败（ENOENT 之类）写进日志
      if (error && typeof error.code === 'string') pushLog(`打开技能目录失败：${error.message}`)
    })
    pushLog(`已打开技能目录 ${dir}`)
    send(res, 200, { ok: true, dir })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/skills/local') {
    const enabled = body.enabled !== false
    await editProfile(PROFILE_NAME, () => setLocalSkillsEnabled(profileDir(), enabled))
    pushLog(`本地技能加载 → ${enabled ? '启用' : '恢复默认'}${enabled ? '' : '（清除覆盖）'}`)
    send(res, 200, { ok: true, ...skillsPayload(), profile: PROFILE_NAME })
    return
  }
  // ---- 同步：已整体移除 ----
  // 同步的唯一用途是把会话/附件/插件配置传到 S3、WebDAV 或别的机器，本质上要联网。
  // 端点保留并统一回答「离线版没有这个功能」，比让页面收到 404 更好排查。
  if (url.pathname === '/api/sync' || url.pathname.startsWith('/api/sync/')) {
    send(res, 200, {
      ok: false,
      offline: true,
      reason: '离线版没有同步功能：数据只留在本机',
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/wake') {
    await host.onWake?.()
    send(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/pick-dir') {
    try {
      send(res, 200, { path: await pickDirectory() })
    } catch (error) {
      pushLog(`目录选择失败: ${error?.message || error}`)
      send(res, 200, { path: '', error: error?.message || String(error) })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/pick-file') {
    try {
      send(res, 200, { path: await pickFile({ save: body.save === true, name: String(body.name || '') }) })
    } catch (error) {
      pushLog(`文件选择失败: ${error?.message || error}`)
      send(res, 200, { path: '', error: error?.message || String(error) })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/open') {
    openLocalUrl(body.url)
    send(res, 200, { ok: true })
    return
  }
  send(res, 404, { error: 'not found' })
}

function mime(path) {
  if (path.endsWith('.css')) return 'text/css'
  if (path.endsWith('.js')) return 'text/javascript'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.ico')) return 'image/x-icon'
  return 'text/html'
}

function isTextFile(file) {
  return /\.(html|css|js|svg|json|txt|map)$/i.test(file)
}

export async function startServer() {
  if (server) return Promise.resolve(`http://127.0.0.1:${PORT}`)
  await ensureSettings()
  // 设置页改过端口 / profile 的话，这里拿到的就是新值（PORT 环境变量仍然优先，测试用）
  if (!process.env.PORT) PORT = resolvePort()
  PROFILE_NAME = resolveProfile()
  EXTRA_ARGS = composeExtraArgs((await loadSettings()).args)
  WEB_BIND = resolveWebBind()
  // 远程插件的「局域网访问」开关：开着时启动 web 不注入 --host（每次起管理器读一次）
  LAN_TOGGLE = lanBindToggleOn(homeDir(), PROFILE_NAME)
  if (CLI_ARGS.length) pushLog(`DSH.exe 传入启动参数：${CLI_ARGS.join(' ')}`)
  const stored = await loadSettings()
  // 钉死端口的实例表：启动、重启都读它（页面改这张表走 /api/instance-port）
  INSTANCE_PORTS = safeInstancePorts(stored.instancePorts)
  // 安装/升级时选过语言就以它为准，否则用设置里存的
  const fromInstall = installLang()
  const storedLang = safeLang(stored.lang)
  if (fromInstall && fromInstall !== storedLang) await saveSettings({ lang: fromInstall })
  LANG = fromInstall || storedLang || 'zh'
  LANG = LANG === 'en' ? 'en' : 'zh'
  THEME = safeTheme(stored.theme)
  PANEL_TRANSPARENCY = safePanelTransparency(stored.panelTransparency)
  REDUCE_MOTION = stored.reduceMotion === true
  HIDE_BACKGROUND = stored.hideBackground === true
  HIDE_BIG_FISH = stored.hideBigFish === true
  DATA = resolveDataDir()
  CONFIG = join(DATA, 'config.json')
  await mkdir(DATA, { recursive: true })
  // 先把内置的 dsh 本体铺好：下面的 scanInstalled / listedVersions 才认得它，
  // 「默认启动」也才会落到内置那份上，而不是机器上系统装的那份。
  await ensureBundledCore()
  // 检查过但一直没装的整合包会留在 inbox 里，启动时清一次过期的（DATA 可能刚改过）
  void prunePackInbox()
  // 默认 16KB 的请求头上限会被浏览器里堆积的 cookie 顶爆（HTTP 431），放宽到 128KB
  const handler = async (req, res) => {
    try {
      // Host 必须是本机：恶意域名解析到 127.0.0.1（DNS rebinding）时浏览器带的是那个
      // 域名，浏览器会把它当同源，GET 接口（含 dsh 的 token、日志）就能被读走
      if (!isLocalHostHeader(req.headers.host)) {
        send(res, 403, 'forbidden', 'text/plain; charset=utf-8')
        return
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url)
        return
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      const path = join(PUBLIC, file)
      if (!path.startsWith(PUBLIC) || !existsSync(path)) {
        send(res, 404, 'not found', 'text/plain; charset=utf-8')
        return
      }
      const type = mime(path)
      // 首页嵌着即时设置，仍不缓存；静态资源允许条件重用，源码修改和升级都能立即生效。
      const headers = {}
      if (file !== 'index.html') {
        const info = statSync(path)
        headers['cache-control'] = 'no-cache'
        headers.etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`
      }
      const matches = String(req.headers['if-none-match'] || '').split(',').map((value) => value.trim())
      if (headers.etag && ['GET', 'HEAD'].includes(req.method) && (matches.includes(headers.etag) || matches.includes('*'))) {
        res.writeHead(304, headers)
        res.end()
        return
      }
      if (isTextFile(file)) {
        let body = await readFile(path, 'utf8')
        if (file === 'index.html') {
          body = body.replaceAll('__APP_VERSION__', APP_VERSION).replaceAll('__APP_LANG__', LANG).replaceAll('__APP_THEME__', THEME).replaceAll('__APP_PANEL_TRANSPARENCY__', String(PANEL_TRANSPARENCY)).replaceAll('__APP_REDUCE_MOTION__', String(REDUCE_MOTION)).replaceAll('__APP_HIDE_BACKGROUND__', String(HIDE_BACKGROUND)).replaceAll('__APP_HIDE_BIG_FISH__', String(HIDE_BIG_FISH))
        }
        send(res, 200, body, `${type}; charset=utf-8`, headers)
        return
      }
      send(res, 200, await readFile(path), type, headers)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`错误: ${message}`)
      send(res, 500, { error: message })
    }
  }

  // 端口顺延：配置的端口被**别的程序**占了就往后试（最多 PORT_SCAN 个），被自己的
  // 另一个实例占着则抛 EALREADY，让 start.js 去把它唤醒——双击图标不该起出第二个管理器。
  const preferred = PORT
  let lastError = null
  for (let offset = 0; offset < PORT_SCAN; offset += 1) {
    const candidate = preferred + offset
    if (candidate > 65535) break
    const attempt = createServer({ maxHeaderSize: 128 * 1024 }, handler)
    try {
      await new Promise((resolve, reject) => {
        attempt.once('error', reject)
        attempt.listen(candidate, '127.0.0.1', () => {
          attempt.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      attempt.close()
      if (error?.code !== 'EADDRINUSE') throw error
      lastError = error
      if (await probeManager(candidate)) {
        const busy = new Error(`管理页已经在 ${candidate} 端口上跑着`)
        busy.code = 'EALREADY'
        busy.port = candidate
        throw busy
      }
      pushLog(`端口 ${candidate} 被别的程序占用，试下一个`)
      continue
    }
    attempt.on('error', (error) => pushLog(`管理服务出错: ${error?.message || error}`))
    server = attempt
    PORT = candidate
    if (offset > 0) pushLog(`管理页改用端口 ${PORT}（${preferred} 起被占用）`)
    pushLog(`DSH 管理器 http://127.0.0.1:${PORT}`)
    pushLog(`版本目录 ${DATA}`)
    pushLog(`DSH_HOME ${homeDir()}`)
    const system = detectSystemDsh()
    if (system) pushLog(`发现系统已安装 ${system.version}`)
    console.log(`dsh-versions: http://127.0.0.1:${PORT}`)
    console.log(`dsh-versions data: ${DATA}`)
    console.log(`dsh-versions home: ${homeDir()}`)
    return `http://127.0.0.1:${PORT}`
  }
  throw lastError ?? new Error('没有可用端口')
}

export async function stopAll() {
  for (const proc of instanceList()) killTree(proc.child.pid)
  instances.clear()
  for (const res of clients) {
    try { res.end() } catch { /* already gone */ }
  }
  clients.clear()
  const httpServer = server
  server = null
  if (!httpServer) return
  if (typeof httpServer.closeAllConnections === 'function') {
    httpServer.closeAllConnections()
  }
  await Promise.race([
    new Promise((resolve) => httpServer.close(() => resolve())),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ])
}

if (/server\.js$/i.test(process.argv[1] || '')) {
  startServer().catch((error) => {
    console.error(error)
    process.exit(1)
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopAll().finally(() => process.exit(0))
    })
  }
/**
 * 退出前的收尾：停掉跑着的 dsh，再通知开着的页面（浏览器里那些）自己关掉。
 * 托盘退出和 /api/quit 都走这里。
 */
}
