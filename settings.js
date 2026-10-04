import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { APP_DIR, IS_MAC, IS_WINDOWS, MAC_BUNDLE_ID, appBundle, launcherExecutable, userAppDir } from './platform.js'


const execFileAsync = promisify(execFile)
const ROOT = dirname(fileURLToPath(import.meta.url))
const SETTINGS_DIR = APP_DIR
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json')
const RUN_REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_NAME = 'DSH'
/** macOS 的登录自启：每用户 LaunchAgent，文件在就算开着（登录时 launchd 按它拉起启动器）。 */
const LAUNCH_AGENT = join(homedir(), 'Library', 'LaunchAgents', `${MAC_BUNDLE_ID}.plist`)

/** 管理页端口，默认这个；被别的程序占了可以在设置页改。 */
export const DEFAULT_PORT = 3780

/** 目录不可用时给一句人话，别把 EPERM 原样丢给用户。 */
function describeDirError(dir, error) {
  const code = String(error?.code || '')
  if (code === 'EPERM' || code === 'EACCES') {
    return IS_MAC
      ? `没有权限写这个目录：${dir}；请换一个当前用户能写的普通目录（例如 ~/DSH-X），不要用 /Applications、/System 这类系统目录。`
      : `没有权限写这个目录：${dir}；请换一个当前用户能写的普通目录（例如 D:\\DSH-X），不要用 Program Files、Windows 这类系统目录。`
  }
  if (code === 'ENOTDIR' || code === 'EEXIST') {
    return `这不是一个目录：${dir}`
  }
  return `版本目录不可用：${dir}（${error?.message || error}）`
}

/**
 * 版本目录得真的能写：先建目录，再写一个探针文件。
 * 单靠 mkdir 不够——目录已存在时 recursive mkdir 会静默成功，但里面未必能写文件。
 * 失败在切换目录**之前**抛出，所以 DATA / settings.json 都不会被改坏。
 */
export async function ensureWritableDir(dir) {
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    throw new Error(describeDirError(dir, error))
  }
  const probe = join(dir, '.dsh-write-probe')
  try {
    await writeFile(probe, '')
    await rm(probe, { force: true })
  } catch (error) {
    throw new Error(describeDirError(dir, error))
  }
  return dir
}

/** dsh 的启动 profile（一个 profile 一套插件和数据），默认 web。 */
export const DEFAULT_PROFILE = 'web'

/** Web 绑定方式：loopback（回环，默认）/ lan（局域网，不注入 --host，交给配置层决定）。 */
export const DEFAULT_WEB_BIND = 'loopback'
/**
 * 打开 dsh 页面的方式：
 *
 * - tab：系统默认浏览器的标签页（默认）；
 * - app：用 Chromium 系浏览器的应用窗口打开（Chrome/Edge 的 --app=…，没有地址栏，更像
 *   一个 App）。找不到 Chrome/Edge 就退回标签页，所以这个选项是「尽量」而不是「必须」；
 * - window：装进启动器自己的窗口（原生外壳再开一个 WebView2 窗口承载 dsh 界面），完全不
 *   经过浏览器进程——关窗口、托盘、退出都由启动器自己说了算。它只在原生外壳托管下成立
 *   （外壳设了 DSH_APP_WINDOW=1，并在 stdout 上收约定标记），源码运行（npm start）时选它
 *   会安静地退回标签页，不会开出一个没人管的窗口。
 */
export const OPEN_MODES = ['tab', 'app', 'window']

/**
 * 默认打开方式：**装了内置 WebView2 就默认内嵌窗口**，否则退回系统浏览器标签页。
 *
 * 为什么这么定：这个包特意内置了 557 MB 的 WebView2 固定版运行时，为的就是让 dsh 界面
 * 装进启动器自己的窗口（不经过浏览器进程，关窗口、托盘、退出都由启动器说了算）。
 * 默认还走标签页的话，那份运行时等于白带。
 *
 * 判据用「安装目录里有没有 webview2\msedgewebview2.exe」，与 DSH.exe 的判断一致
 * （见 launcher/main.rs 的 use_bundled_webview2）—— 两边口径必须一样，否则会出现
 * 「设置页显示窗口、实际却回落标签页」这种对不上的状态。
 *
 * 只影响**没设过这一项**的机器：老配置里显式存过 "tab" 的仍按它的来（loadSettings
 * 会把存过的值合进来）。改默认不该悄悄改掉用户已经做过的选择。
 */
export const DEFAULT_OPEN_MODE = detectDefaultOpenMode()

function detectDefaultOpenMode() {
  try {
    // 源码运行时没有安装目录里的载荷，直接判定「没有内置运行时」→ 标签页
    const root = dirname(fileURLToPath(import.meta.url))
    return existsSync(join(root, 'webview2', 'msedgewebview2.exe')) ? 'window' : 'tab'
  } catch {
    return 'tab'
  }
}

export function safeOpenMode(value) {
  const name = String(value ?? '').trim()
  return OPEN_MODES.includes(name) ? name : DEFAULT_OPEN_MODE
}

/** dsh 用户目录（DSH_HOME）：留空用默认；填了必须是绝对路径。 */
export function safeDshHome(dir) {
  if (dir === undefined || dir === null) return ''
  if (typeof dir !== 'string') throw new Error('dsh 用户目录填一个路径，别填别的')
  const trimmed = dir.trim()
  if (!trimmed) return ''
  if (!isAbsolute(trimmed)) throw new Error('请使用绝对路径（例如 D:\\dsh-home）')
  return resolve(trimmed)
}

/** 没配置时的默认根目录。 */
export function defaultDshHome() {
  return join(homedir(), '.dsh')
}

/**
 * 每个 profile 的家目录怎么算 —— 两档，用户在设置页选。
 *
 *   isolated（默认）：每个 profile 一份独立 DSH_HOME，落在根目录的
 *                     `profiles-home/<profile>/` 下。版本、插件、技能、预设、
 *                     配置、**会话**全套隔离，互不串扰。
 *   shared          ：所有 profile 共用同一个 DSH_HOME（~/.dsh）。会话、记忆、凭据、
 *                     设置全部共享，只有插件按 profile 分。想几个环境看同一批会话的用户
 *                     在设置页切过来。
 *
 * 为什么默认隔离：这是「一个环境就是一套独立环境」该有的样子 —— 建一个新 profile
 * 就是干净的一份，不用先手动把旧数据挪走。共享模式下换 profile 只换了插件，
 * 会话与配置还是同一份，用户看到的是「我明明建了个新环境，怎么聊天记录还是老的」。
 *
 * 代价要说清：隔离模式下每份环境各装一次插件（各占一份空间），且**看不到别的
 * profile 的会话**。想要「几个环境共享一批会话与凭据」的人在设置页切到 shared 即可。
 *
 * （早先默认是 shared，理由是「老用户的 ~/.dsh 里有历史记录，改默认等于让它看起来
 *   丢了」。那是给已发布产品留的退路；这个项目还没发布，所以不存在那个包袱。）
 */
export const HOME_MODES = ['shared', 'isolated']
export const DEFAULT_HOME_MODE = 'isolated'

export function safeHomeMode(value) {
  const name = String(value ?? '').trim().toLowerCase()
  return HOME_MODES.includes(name) ? name : DEFAULT_HOME_MODE
}

/**
 * 某个 profile 实际该用的 DSH_HOME。
 *
 * root 是设置页里那个「dsh 用户目录」（留空则 defaultDshHome()）。shared 模式直接用它；
 * isolated 模式在它下面按 profile 名派生一个子目录 —— 用 profiles-home/ 这一层是为了
 * 和 dsh 自己的 `profiles/`（profile 定义所在处）分开：那是「哪些 profile 存在」的清单，
 * 这里是「每个 profile 的家」。混在一起会让 dsh 把家目录当成一个 profile 去解析。
 *
 * profile 名已由 safeProfile 校验过（只含 [A-Za-z0-9._-]），所以拼路径是安全的；
 * 这里再取一次 basename 是为了防调用方漏了校验塞进带斜杠的值。
 */
export function resolveDshHome(root, mode, profile) {
  const base = safeDshHome(root) || defaultDshHome()
  if (safeHomeMode(mode) === "shared") return base
  const name = String(profile ?? "").trim()
  if (!name) return base
  const safe = name.split(/[\\/]/).pop() || name
  return join(base, "profiles-home", safe)
}

export const DEFAULTS = {
  dataDir: '',
  port: DEFAULT_PORT,
  profile: DEFAULT_PROFILE,
  // 钉死端口的实例（键 `版本@profile`）：没钉的组合每次启动由系统挑，见 safeInstancePorts
  instancePorts: {},
  // 旧设置没有启动项时，读取侧会补上内置默认项，首次使用无需先填参数。
  launchPresets: [],
  // 界面语言：zh / en（安装时选的语言写进安装目录的 lang.txt，启动器读一次落到这里）
  lang: '',
  theme: 'system',
  panelTransparency: 0,
  reduceMotion: false,
  hideBackground: false,
  hideBigFish: false,
  // 打开 dsh 页面的方式：tab（默认，系统浏览器标签页）/ app（Chromium 应用窗口）/ window（启动器内嵌窗口）
  openMode: DEFAULT_OPEN_MODE,
  // dsh 的用户目录（DSH_HOME）。留空 = 默认 ~/.dsh；用户把 .dsh 挪到别的盘时在这里指回去
  dshHome: '',
  // 家目录隔离：shared（所有 profile 共用一个 DSH_HOME）/ isolated（每个 profile 一份）
  dshHomeMode: DEFAULT_HOME_MODE,
  // 额外启动参数（一行文本，空格分词，含空格的值用引号包起来）
  args: '',
  // dsh web 的绑定方式：loopback 注入 --host 127.0.0.1（默认）；lan 不注入，
  // 由配置层（远程访问插件的「局域网访问」开关写的 profile 补丁块）决定 0.0.0.0
  webBind: DEFAULT_WEB_BIND,
  autoStart: false,
  // 首次启动是否把内置市场插件装进 profile。改造后市场插件来自内置载荷（packages/），
  // 不再从 npm 下载 —— 名字沿用，语义变成「装不装内置的那一份」。
  seedMarket: true,
  // 预置内置的免费模型插件（plugins/dsh-our-free-model）。**默认开**：
  // 离线版最该先满足的场景就是「装上就能对话」——不登录、不填 API Key。
  // 关掉也能用，只是要自己到插件页装。
  seedFreeModel: true,
  // 预置其余自带插件（plugins/：记忆 dsh-x-memory、小模型委派、余额挂件）。
  // 默认关：挂得越多 dsh 启动越久、出问题的面也越大，想要的用户自己打开。
  seedBundled: false,
  // 启动失败时按错误点名自动禁用问题插件（兼容模式），再重试
  autoDisablePlugins: true,
  // 装完新版本后自动清理更旧的版本（只留最新的和最近装的一个）。
  // 关掉就全部留着：回退时想退到哪个版本都在，代价是每个版本好几百 MB
  autoCleanVersions: true,
  // 把 dsh 的 shim 目录写进用户 PATH（HKCU\Environment），让系统里也能直接用 dsh
  systemPath: false,
  // 用户在更新弹窗里点过「不更新」的版本 { dsh?, self? }：同一个版本不再提示
  skippedUpdate: {},
}

/** 端口校验：1-65535 的整数，别的都当成没填（回默认端口）。 */
export function safePort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口要填 1-65535 之间的整数')
  }
  return port
}

/**
 * 版本号的字符集（registry 里的 tag 名、`data/versions/<版本>` 的目录名都按它收）。
 * 导出是给 `instancePorts` 的键用——那张表的键是「版本@profile」，两边都不能含 @，
 * 拼接才不会有歧义（见 server.js 的 instanceKey）。
 */
export const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/

/** profile 名会变成 ~/.dsh/profiles 下的目录名，只允许目录安全字符。 */
export function safeProfile(value) {
  const name = String(value ?? '').trim()
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(name) || name === '.' || name === '..') {
    throw new Error('profile 名只能用字母、数字、点、下划线、连字符（1-32 个字符）')
  }
  return name
}

/**
 * 每个实例（版本 × profile）手工钉的固定端口，键形如 `0.1.7@web`。
 *
 * 默认每个实例都由系统现挑一个端口（`--port 0`），代价是链接每次启动都变：书签、手机
 * 上存的地址、别的程序里的回调地址都留不住。钉死的组合按下一次的端口起。
 *
 * 脏值直接丢掉（不抛）：这张表是「多几个键也无所谓」的附加信息，为了历史文件里的一条
 * 烂数据让整个设置读不出来不划算。键的两段分别按 VERSION_RE / safeProfile 的形状收，
 * 版本与 profile 都不含 @，所以只用认第一个 @。
 */
export function safeInstancePorts(value) {
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [rawKey, rawPort] of Object.entries(value)) {
    const key = String(rawKey)
    const at = key.indexOf('@')
    if (at <= 0 || key.indexOf('@', at + 1) !== -1) continue
    const version = key.slice(0, at)
    const profile = key.slice(at + 1)
    if (!VERSION_RE.test(version)) continue
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(profile) || profile === '.' || profile === '..') continue
    const port = Number(rawPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    out[key] = port
  }
  return out
}

export const DEFAULT_LAUNCH_ID = '0000000000000000'
export const DEFAULT_LAUNCH = { id: DEFAULT_LAUNCH_ID, name: 'DSH', version: 'auto', profile: 'web', port: 0 }

/** 历史设置里的坏启动项直接丢弃；默认入口始终存在，旧用户也无需迁移操作。 */
export function safeLaunchPresets(value) {
  const seen = new Set()
  const presets = (Array.isArray(value) ? value : []).slice(0, 20).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const id = String(item.id ?? '')
    const name = String(item.name ?? '').trim()
    const version = String(item.version ?? '')
    let profile
    try { profile = safeProfile(item.profile) } catch { return [] }
    const port = Number(item.port ?? 0)
    if (!/^[a-f0-9]{16}$/.test(id) || seen.has(id) || !name || name.length > 32
      || !VERSION_RE.test(version) || !Number.isInteger(port) || port < 0 || port > 65535) return []
    seen.add(id)
    return [{ id, name, version, profile, port }]
  })
  const builtin = presets.find((item) => item.id === DEFAULT_LAUNCH_ID) || { ...DEFAULT_LAUNCH }
  if (builtin.name === '默认启动') builtin.name = 'DSH'
  return [builtin, ...presets.filter((item) => item.id !== DEFAULT_LAUNCH_ID)].slice(0, 20)
}

/**
 * 把「额外启动参数」那行文本切成 argv：空白分词，单双引号里的内容原样保留
 * （`--msg "hello world"` → ['--msg', 'hello world']）。未闭合的引号按到行尾处理。
 */
export function parseArgs(text) {
  const out = []
  let current = ''
  let quote = ''
  let quoted = false
  for (const ch of String(text ?? '')) {
    if (quote) {
      if (ch === quote) quote = ''
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      quoted = true
      continue
    }
    if (/\s/.test(ch)) {
      if (current || quoted) out.push(current)
      current = ''
      quoted = false
      continue
    }
    current += ch
  }
  if (current || quoted) out.push(current)
  return out
}

/** 额外启动参数：只留文本，长度收个口（解析在 server.js 里做）。 */
export function safeArgs(value) {
  const text = String(value ?? '').trim()
  if (text.length > 2000) throw new Error('额外启动参数太长了（上限 2000 字符）')
  return text
}

/** 启动 profile：环境变量 DSH_PROFILE 优先（开发和测试用），其次 settings.json。 */
export function resolveProfile() {
  if (process.env.DSH_PROFILE) {
    try {
      return safeProfile(process.env.DSH_PROFILE)
    } catch { /* 环境变量不合法就退回设置 */ }
  }
  try {
    return safeProfile(loadSettingsSync().profile)
  } catch {
    return DEFAULT_PROFILE
  }
}

/** 界面语言：只认 zh / en，其余当没设。 */
export function safeLang(value) {
  const lang = String(value ?? '').trim().toLowerCase()
  return lang === 'en' ? 'en' : lang === 'zh' ? 'zh' : ''
}

/** 页面外观：跟随系统、浅色或深色；历史脏值回到跟随系统。 */
export function safeTheme(value) {
  return value === 'light' || value === 'dark' ? value : 'system'
}

/** 悬浮窗背景透明度，百分比；历史脏值回到默认值。 */
export function safePanelTransparency(value) {
  if (value === null || value === undefined || value === '') return DEFAULTS.panelTransparency
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : DEFAULTS.panelTransparency
}

/**
 * Web 绑定方式：只认 loopback / lan（顺手收下 127.0.0.1 / 0.0.0.0 两种写法），
 * 别的值一律抛错——和端口、profile 一样，显式填错要让用户知道。
 */
export function safeWebBind(value) {
  const mode = String(value ?? '').trim().toLowerCase()
  if (mode === 'loopback' || mode === '127.0.0.1') return 'loopback'
  if (mode === 'lan' || mode === '0.0.0.0') return 'lan'
  throw new Error('Web 绑定只能选 回环(loopback) 或 局域网(lan)')
}

/**
 * 远程访问插件（@linxin666/dsh-remote-web-ui）的「局域网访问」开关有没有开。
 *
 * 插件把开关存在 dsh 的设置文件里（`<dsh home>/settings.yaml` 的
 * `remote-web-ui.lanBind`）。启动器读它只为了一件事：开关开着时启动 web 不再
 * 注入 `--host 127.0.0.1`——命令行显式 --host 在 dsh 里优先于配置层，注入了
 * 回环地址，插件的开关和补丁块就永远赢不了，手机/其他电脑也就连不上。
 *
 * 没有 YAML 依赖，只在这一个文件里找这一个键：定位顶层 `remote-web-ui:` 段，
 * 在它的子行里找 `lanBind:`。读不到、格式不认识、插件没装，都当没开——
 * 启动器不依赖任何第三方插件存在。
 */
export function lanBindToggleOn(home, profile = '') {
  // 0.1.7-rc.1 起 dsh 把设置搬到「当前 profile 的 Cordis 配置」里（旧 settings.yaml 只导入一次），
  // 所以要两处都看：新位置有明确取值就以它为准，没有（还没迁移、或旧版本）再回落到旧文件。
  if (profile) {
    for (const name of ['cordis.yml', 'cordis.yaml']) {
      const value = lanBindFromYaml(readTextIfExists(join(home, 'profiles', profile, name)))
      if (value !== undefined) return value
    }
  }
  return lanBindFromYaml(readTextIfExists(join(home, 'settings.yaml'))) === true
}

/** 读文件，读不到给空串（配置缺失是常态，不该抛）。 */
function readTextIfExists(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 在 YAML 文本里找「提到 remote-web-ui 的那一段」里的 lanBind。
 * 段可以在顶层（旧 settings.yaml 的形状），也可以是嵌套的插件条目（新 profile 配置的形状）；
 * 段内允许隔着别的键。找不到返回 undefined（＝这份文件没说），false 才是明确说「关」。
 */
export function lanBindFromYaml(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line)) continue
    if (!/remote-web-ui/i.test(line)) continue
    if (!/:\s*(?:\{.*)?$/.test(line)) continue
    // 同一行写成流式映射的情况：{ lanBind: true }
    const inline = /lanBind\s*:\s*([^,}\s]+)/.exec(line)
    if (inline) return /^(?:true|yes|on|1)$/i.test(inline[1].replace(/^['"]|['"]$/g, ''))
    const indent = line.length - line.trimStart().length
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]
      if (!next.trim() || /^\s*#/.test(next)) continue
      const nextIndent = next.length - next.trimStart().length
      // 缩进回落到这一段之外（或更浅）说明段结束了；数组项不算出段
      if (nextIndent <= indent && !/^\s*-\s/.test(next)) break
      const match = /^\s*lanBind\s*:\s*(.+?)\s*$/.exec(next)
      if (match) return /^(?:true|yes|on|1)$/i.test(match[1].replace(/^['"]|['"]$/g, ''))
    }
  }
  return undefined
}

/** 管理页端口：环境变量 PORT（开发和测试用）优先，其次 settings.json。 */
export function resolvePort() {
  const fromEnv = Number(process.env.PORT || 0)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  try {
    return safePort(loadSettingsSync().port)
  } catch {
    return DEFAULT_PORT
  }
}

/** Web 绑定方式：设置文件里的脏值退回默认（回环），和端口、profile 一个口径。 */
export function resolveWebBind() {
  try {
    return safeWebBind(loadSettingsSync().webBind)
  } catch {
    return DEFAULT_WEB_BIND
  }
}

function hasInstall(dir) {
  return existsSync(join(dir, 'config.json')) || existsSync(join(dir, 'versions'))
}

export function safeDataDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('版本目录不能为空')
  const trimmed = dir.trim()
  // 先判再 resolve：resolve 会把相对路径按当前工作目录补齐，补完就永远是绝对路径，
  // 倒过来判等于没有这条校验——用户在设置页填个 dsh-data 会安静地落到启动器所在目录
  if (!isAbsolute(trimmed)) throw new Error('请使用绝对路径')
  return resolve(trimmed)
}

export function fallbackDataDir() {
  const local = join(ROOT, 'data')
  if (hasInstall(local)) return local
  const userDir = userAppDir()
  if (userDir) {
    const roaming = join(userDir, 'data')
    if (hasInstall(roaming)) return roaming
    // 装好的启动器（有原生外壳）一律放每用户目录；macOS 的安装目录在 .app 包里，更是写不得
    if (launcherExecutable()) return roaming
  }
  return local
}

function mergeStoredSettings(stored) {
  const merged = { ...DEFAULTS, ...stored }
  if (!('hideBackground' in stored) && 'disableBackgroundAnimation' in stored) {
    merged.hideBackground = stored.disableBackgroundAnimation === true
  }
  delete merged.disableBackgroundAnimation
  return merged
}

export function loadSettingsSync() {
  try {
    return mergeStoredSettings(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

export async function loadSettings() {
  try {
    return mergeStoredSettings(JSON.parse(await readFile(SETTINGS_FILE, 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

/** 跳过记录只留非空版本号，别让历史文件里的脏值影响更新提示。 */
function normalizeSkippedUpdate(value) {
  const out = {}
  for (const key of ['dsh', 'self']) {
    const version = value && typeof value === 'object' ? value[key] : ''
    if (typeof version === 'string' && version.trim()) out[key] = version.trim()
  }
  return out
}

export async function saveSettings(patch) {
  const current = await loadSettings()
  const merged = { ...current, ...patch }
  if (merged.dataDir) merged.dataDir = safeDataDir(merged.dataDir)
  // 历史文件里的脏端口值顺手修回默认；显式改端口时才把错误抛给调用方
  try {
    merged.port = safePort(merged.port)
  } catch {
    merged.port = DEFAULT_PORT
  }
  if ('port' in patch) merged.port = safePort(patch.port)
  // 同端口：脏值顺手修回默认，显式改 profile 时才把错误抛给调用方
  try {
    merged.profile = safeProfile(merged.profile)
  } catch {
    merged.profile = DEFAULT_PROFILE
  }
  if ('profile' in patch) merged.profile = safeProfile(patch.profile)
  merged.args = 'args' in patch ? safeArgs(patch.args) : safeArgs(merged.args)
  merged.instancePorts = safeInstancePorts('instancePorts' in patch ? patch.instancePorts : merged.instancePorts)
  merged.launchPresets = safeLaunchPresets(merged.launchPresets)
  merged.lang = 'lang' in patch ? safeLang(patch.lang) : safeLang(merged.lang)
  merged.theme = safeTheme(merged.theme)
  merged.panelTransparency = safePanelTransparency(merged.panelTransparency)
  merged.reduceMotion = merged.reduceMotion === true
  merged.hideBackground = merged.hideBackground === true
  merged.hideBigFish = merged.hideBigFish === true
  // 同 webBind：脏值顺手修回默认（回环），显式改绑定方式时才把错误抛给调用方
  try {
    merged.webBind = safeWebBind(merged.webBind)
  } catch {
    merged.webBind = DEFAULT_WEB_BIND
  }
  if ('webBind' in patch) merged.webBind = safeWebBind(patch.webBind)
  merged.openMode = safeOpenMode(merged.openMode)
  if ('openMode' in patch) merged.openMode = safeOpenMode(patch.openMode)
  merged.dshHomeMode = safeHomeMode(merged.dshHomeMode)
  if ('dshHomeMode' in patch) merged.dshHomeMode = safeHomeMode(patch.dshHomeMode)
  merged.autoStart = Boolean(merged.autoStart)
  merged.seedMarket = merged.seedMarket !== false
  // 默认开：只有显式关掉才不开（离线版装上就该能直接对话）
  merged.seedFreeModel = merged.seedFreeModel !== false
  // 旧键 seedMemory（这版之前的名字）当作别名读一次
  if (!('seedBundled' in patch) && 'seedMemory' in patch) merged.seedBundled = patch.seedMemory
  // 默认关：只有显式 true 才开（!== false 会让缺省值也变成开）
  merged.seedBundled = merged.seedBundled === true
  merged.autoDisablePlugins = merged.autoDisablePlugins !== false
  merged.autoCleanVersions = merged.autoCleanVersions !== false
  merged.skippedUpdate = normalizeSkippedUpdate(merged.skippedUpdate)
  // 改造后同步引擎已移除，历史设置里 S3/WebDAV/目录/ZIP 与同步范围的残留字段一并清掉，
  // 否则它们会一直躺在 settings.json 里，看起来像还能用。
  for (const key of [
    'aiRepair', 'aiModel', 'aiBaseURL', 'aiApiKey', 'aiMaxRounds', 'aiAllowDestructive',
    's3', 'webdav', 'folder', 'zip', 'sync',
    'downloadSource', 'updateSource', 'proxyMode', 'proxyUrl', 'updateSourceMigrated',
  ]) {
    delete merged[key]
  }
  await mkdir(SETTINGS_DIR, { recursive: true })
  await writeFile(SETTINGS_FILE, JSON.stringify(merged, null, 2))
  return merged
}

export function inferDataDir() {
  if (process.env.DSH_VERSIONS_DATA) return process.env.DSH_VERSIONS_DATA
  return fallbackDataDir()
}

export function resolveDataDir() {
  const settings = loadSettingsSync()
  if (settings.dataDir) return safeDataDir(settings.dataDir)
  return inferDataDir()
}

export async function ensureSettings() {
  const stored = await loadSettings()
  const dataDir = stored.dataDir ? safeDataDir(stored.dataDir) : inferDataDir()
  const patch = {}
  if (stored.dataDir !== dataDir) patch.dataDir = dataDir
  if (!Object.keys(patch).length) return stored
  return saveSettings(patch)
}

/** 登录自启要执行的 argv：装好的走原生外壳，源码运行就直接 node start.js。 */
function launchArgs() {
  const exe = launcherExecutable()
  // macOS 走 open 而不是直接执行包里的二进制：LaunchServices 负责单实例和把应用带到前台
  if (IS_MAC && exe) return ['/usr/bin/open', '-a', appBundle()]
  if (exe) return [exe]
  return [process.execPath, join(ROOT, 'start.js')]
}

export function launchCommand() {
  return launchArgs().map((arg) => `"${arg}"`).join(' ')
}

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** LaunchAgent 的 plist：只在登录时跑一次（RunAtLoad），不设 KeepAlive——用户退出了就别再拉起来。 */
export function launchAgentPlist(args = launchArgs(), cwd = ROOT) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(MAC_BUNDLE_ID)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((arg) => `    <string>${escapeXml(arg)}</string>`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${escapeXml(cwd)}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

function runReg(args) {
  return execFileAsync('reg.exe', args, { windowsHide: true, encoding: 'utf8' })
}

export async function autoStartEnabled() {
  if (IS_MAC) return existsSync(LAUNCH_AGENT)
  if (!IS_WINDOWS) return false
  try {
    await runReg(['query', RUN_REG, '/v', RUN_NAME])
    return true
  } catch {
    return false
  }
}

export async function setAutoStart(enabled) {
  if (IS_MAC) {
    // 只写/删文件，不 launchctl load：load 会立刻再拉起一个启动器，而这里要的只是「下次登录时」
    if (enabled) {
      await mkdir(dirname(LAUNCH_AGENT), { recursive: true })
      await writeFile(LAUNCH_AGENT, launchAgentPlist())
    } else {
      await rm(LAUNCH_AGENT, { force: true })
    }
    return
  }
  if (!IS_WINDOWS) {
    if (enabled) throw new Error('开机自启目前只支持 Windows 和 macOS')
    return
  }
  const on = await autoStartEnabled()
  if (on === Boolean(enabled)) return
  if (enabled) {
    await runReg(['add', RUN_REG, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', launchCommand(), '/f'])
    return
  }
  try {
    await runReg(['delete', RUN_REG, '/v', RUN_NAME, '/f'])
  } catch {
    // already off
  }
}
