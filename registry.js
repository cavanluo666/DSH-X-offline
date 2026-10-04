import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coreVersion, hasCore, installCoreAsVersion, runtimeNodePath } from './offline.js'
import { cmpVer, parseVer } from './version.js'

/**
 * 版本安装与 pnpm 进度解析。
 *
 * 改造前这个文件是启动器的主要联网点：从 npm registry 取 packument、下载 tarball、
 * 必要时现装一份 npm。改造后 dsh 本体由内置载荷供给（见 offline.js），这里只剩两件事：
 *
 *   1. installSpec —— 把内置本体铺成 `versions/<版本>`，不再访问 registry；
 *   2. 进度解析与报错翻译 —— 插件安装仍由 dsh 内部的 pnpm 执行，输出要认得出、
 *      失败要说人话，这部分与网络无关，原样保留。
 *
 * 依赖同样收敛：不再 import proxy.js / settings.js，也就不再牵连出代理与下载源。
 */

const APP_ROOT = dirname(fileURLToPath(import.meta.url))

export { cmpVer, parseVer } from './version.js'

/** 内置运行时的 node；没有自带就退回当前进程的 node（源码运行时）。 */
export function nodeExecutable() {
  return runtimeNodePath()
}

function npmCli(home) {
  return join(home, 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

function npmHomes() {
  // 只看自带运行时：改造后不再从 registry 现装 npm，机器上那份不算数
  return [...new Set([join(APP_ROOT, 'node'), dirname(process.execPath)])]
}

function foundNpm() {
  for (const home of npmHomes()) {
    const cli = npmCli(home)
    if (existsSync(cli)) return { home, cli }
  }
  return null
}

/** npm 报错里说了等于没说的那几句：收尾语、以及跟着 notarget 一起打印的套话。 */
const NPM_NOISE = [
  /A complete log of this run can be found in:/i,
  /In most cases you or one of your dependencies are requesting/i,
  /a package version that doesn't exist\.?$/i,
]

/**
 * npm 装包失败时给用户看什么：**直接用 npm 自己说的话**（去掉 `npm error ` 前缀和光秃秃的
 * `code XXX` 行），只把上面那几句套话滤掉 —— 缺哪个包、哪个源 404，它的报错里本来就写着，
 * 不用我们复述、也不该复述。拿不到真实报错行就返回空串，调用方照旧用最后一行。
 * 完整输出本来就逐行进了启动器日志，所以这里滤掉不影响排查。
 */
export function describeNpmFailure(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines
    .filter((line) => /^(?:npm )?(?:error|ERR!)/i.test(line))
    .map((line) => line.replace(/^(?:npm )?(?:error|ERR!)\s*/i, '').trim())
    .filter((line) => line && !/^code \S+$/i.test(line) && !NPM_NOISE.some((noise) => noise.test(line)))
    .slice(0, 2)
    .join('\n')
}

/**
 * pnpm 的进度行（非 TTY 时用的是 append-only reporter，长这样）：
 *   Packages: +123
 *   Progress: resolved 12, reused 0, downloaded 0, added 0
 * 插件安装/升级走的是 dsh 内部的 pnpm，输出和 npm 那套不一样，这里单独认。
 * 返回同形状的进度，页面用同一个进度条画。
 */
export function parsePnpmProgress(line, state) {
  const packages = /^Packages:\s*\+(\d+)/i.exec(line)
  if (packages) {
    state.total = Number(packages[1])
    return null // 只是报了总数，等 Progress 行再出进度
  }
  const progress = /Progress:\s*resolved (\d+),\s*reused (\d+),\s*downloaded (\d+),\s*added (\d+)/i.exec(line)
  if (!progress) return null
  state.resolved = Number(progress[1])
  state.reused = Number(progress[2])
  state.downloaded = Number(progress[3])
  state.added = Number(progress[4])
  if (state.added) {
    // 已经在写入 node_modules：用「要装多少个」当分母，进度条才是真比例
    return { phase: 'download', done: state.added, total: Math.max(state.total, state.resolved, state.added) }
  }
  // 还在解析依赖图：没有确定的分子分母，交给页面用饱和曲线显示
  return { phase: 'resolve', done: state.resolved }
}

/**
 * 装一个 dsh 版本。
 *
 * 改造后只有一条路：从内置载荷复制。签名保留 `installSpec(root, name, range, onLog)`
 * 的形状，调用方（server.js 的 /api/install）不用改；`name` 与 `range` 用来校验
 * 「用户要的这个版本是不是内置的那个」，对不上就明确报错，而不是去网上悄悄拉一个。
 *
 * 为什么不做「内置版本 + 联网补装其它版本」：本项目的目标就是全程离线，
 * 半联网会让人分不清哪次失败是网络问题、哪次是载荷问题。
 */
export async function installSpec(root, name, range, onLog = () => {}) {
  const log = (line, progress) => onLog(line, progress)
  const version = String(range ?? '').trim()

  if (!hasCore()) {
    throw new Error(
      '内置载荷里没有 dsh 本体（core/dsh）。\n' +
      '离线版只能安装随包发出的那一个版本；开发时请先跑一次打包脚本准备载荷。',
    )
  }
  const bundled = coreVersion()
  if (version && version !== 'latest' && version !== bundled) {
    throw new Error(
      `离线版只带 dsh ${bundled}，装不了 ${version}。\n` +
      '这一版刻意去掉了联网装版本的能力：需要别的版本请用联网版启动器，或换一份带该版本载荷的包。',
    )
  }

  log(`从内置载荷安装 dsh ${bundled}`, { phase: 'download', done: 1, total: 1 })
  await mkdir(root, { recursive: true })
  await installCoreAsVersion(bundled, root)
  log(`dsh ${bundled} 就位`, { phase: 'download', done: 1, total: 1 })
  return { version: bundled, from: 'bundled' }
}

/**
 * 可装版本：离线版没有「可装版本」这回事，只有一个内置版本。
 *
 * 保留这个函数是为了不让调用方分支爆炸（页面上的「安装」按钮仍走同一条路），
 * 但它不再发起任何请求 —— 返回的就是内置那一份的版本号。
 */
export async function availableVersions() {
  const version = coreVersion()
  return hasCore() && version ? { versions: [version], tags: { latest: version } } : { versions: [], tags: {} }
}

/**
 * 插件的「可更新版本」查询。
 *
 * 改造前这里从 registry 拉 packument 判断有没有新版；离线版没有远端可比，
 * 一律抛错让调用方按「已是最新」处理，而不是转圈等一个永远不来的超时。
 */
export async function listPackage() {
  throw new Error('离线版不查询插件远端版本（联网更新检查已移除）')
}

/** 当前 npm registry —— 改造后不再有下载源概念，保留空串以兼容调用点。 */
export function currentRegistry() {
  return ''
}
