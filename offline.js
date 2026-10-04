import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 离线供给层：这是 DSH-X 从「联网启动器」改成「一键安装器」的那一层。
 *
 * 原来的 DSH-X 装 dsh 版本靠 npm、装插件靠 pnpm 去 registry、开市场靠 GitHub，
 * 每一样都要求用户能连上网。改造后这些东西全部随安装包一起发出、装在本机：
 *
 *   core/          内置的 dsh 本体（一个目录，等价于 npm 全局装出来的那个包）
 *   packages/      内置插件（npm 包的发布子集），以 file: 依赖离线装进 profile
 *   packs/         内置整合包（.dspack），插件页就地安装，不联网
 *   corepack/      pnpm 的 corepack 缓存，冷缓存时 corepack 会联网下载 pnpm（实测 65 秒）
 *   node/          便携 Node 运行时（由打包脚本放，本文件只做校验与探针）
 *
 * 本文件只管「东西在哪、装没装、怎么装」，不碰 HTTP 与任何网络 API。凡是需要
 * 判断「这个功能能不能离线做」的地方，都从这里问，不要在业务代码里散落 existsSync。
 */

const ROOT = dirname(fileURLToPath(import.meta.url))

/** 内置载荷的目录名。打包脚本（scripts/pack-common.mjs）按同样的名字摆放。 */
export const CORE_DIR = join(ROOT, 'core')
export const PACKAGES_DIR = join(ROOT, 'packages')
export const PACKS_DIR = join(ROOT, 'packs')
export const COREPACK_DIR = join(ROOT, 'corepack')
export const NODE_DIR = join(ROOT, 'node')

/**
 * 内置 dsh 本体的形状：一个已经解开、可以直接跑的 @deepseek-ai/dsh 包。
 *
 * 用「解开的目录」而不是 npm tarball，是因为解包这一步在装机器上要引入 tar 依赖，
 * 而 tar 在旧 Windows 上未必支持 zstd；打包时解开一次，装机器上就只是拷贝。
 */
export const CORE_PKG_DIR = join(CORE_DIR, 'dsh')

/** 内置 dsh 本体的入口；没有它就等于没有内置本体。 */
export function coreBinPath() {
  return join(CORE_PKG_DIR, 'lib', 'bin.js')
}

/** 内置 dsh 本体的版本号（读它的 package.json）；读不到返回空串。 */
export function coreVersion() {
  try {
    return String(JSON.parse(readFileSync(join(CORE_PKG_DIR, 'package.json'), 'utf8')).version || '')
  } catch {
    return ''
  }
}

/** 有没有内置本体，且它看起来是完整的（入口与清单都在）。 */
export function hasCore() {
  return existsSync(coreBinPath()) && existsSync(join(CORE_PKG_DIR, 'package.json'))
}

/**
 * 内置节点运行时是否可用。
 *
 * 打包后的安装目录里 node/ 是便携运行时；源码运行时（npm start）没有这一份，
 * 这时退回 process.execPath——开发机上本来就有 node，不该因此判定「离线不可用」。
 */
export function runtimeNodePath() {
  const bundled = join(NODE_DIR, process.platform === 'win32' ? 'node.exe' : 'node')
  return existsSync(bundled) ? bundled : process.execPath
}

/** 内置 pnpm 的命令行入口（离线装插件必须用它）。 */
export function pnpmCliPath() {
  const cli = join(NODE_DIR, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  return existsSync(cli) ? cli : ''
}

/** corepack 缓存是不是已经在位；corepack 冷缓存会联网下载 pnpm。 */
export function hasCorepackCache() {
  return existsSync(join(COREPACK_DIR, 'v1')) || existsSync(join(COREPACK_DIR, 'lastKnownGood.json'))
}

/**
 * 内置插件清单：packages/ 下每个子目录就是一个可离线安装的插件包。
 * 目录名即包名（npm 包的目录名本来就和包名一致）。
 */
export function bundledPluginDirs() {
  try {
    return readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** 某一个内置插件的目录；不在内置清单里返回空串。 */
export function bundledPluginDir(name) {
  const dir = join(PACKAGES_DIR, String(name ?? ''))
  return existsSync(join(dir, 'package.json')) ? dir : ''
}

/** 内置整合包（.dspack 文件）的路径清单。 */
export function bundledPackFiles() {
  try {
    return readdirSync(PACKS_DIR)
      .filter((name) => name.toLowerCase().endsWith('.dspack'))
      .map((name) => join(PACKS_DIR, name))
      .sort()
  } catch {
    return []
  }
}

/**
 * 把一个目录里的插件包以 file: 依赖装进 profile 时用的 spec。
 *
 * pnpm 要正斜杠；这也是实测「零下载装完」的那个写法（见 README 的离线一节）。
 * 反斜杠会被 pnpm 当成转义字符，装不上。
 */
export function fileSpec(dir) {
  return `file:${String(dir).replace(/\\/g, '/')}`
}

/** 内置插件的 file: spec；名称不在内置清单里返回空串。 */
export function bundledPluginSpec(name) {
  const dir = bundledPluginDir(name)
  return dir ? fileSpec(dir) : ''
}

/**
 * 把内置 dsh 本体复制成「一个版本」。
 *
 * DSH-X 的版本布局是 `<dataDir>/versions/<版本>/node_modules/@deepseek-ai/dsh`，
 * 和 npm 装出来的形状一样 —— 所以内置本体只要按这个形状放进去，就和其他版本
 * 完全等价，启动、插件、恢复这些逻辑一行都不用改。
 *
 * 已存在且入口在，就当成装好了直接返回（幂等）；否则整目录替换，避免留下
 * 上一次的半份文件。
 */
export async function installCoreAsVersion(version, versionDir) {
  if (!hasCore()) throw new Error('内置载荷里没有 dsh 本体（core/dsh），无法离线安装')
  const target = join(versionDir, 'node_modules', '@deepseek-ai', 'dsh')
  if (isCompleteInstall(target)) return target

  // ★ 复制到临时目录，完成后整体改名过去。
  //
  // 为什么不能直接 cp 到 target：450 MB / 两万多个文件要拷十几秒，而判断「装好了」
  // 只能靠目标目录里的某个文件。直接拷的话，中间任何时刻那个标志文件先落地、别的还没到，
  // 读它的人就会拿到半份安装 —— 实测踩到过：bin.js 已在、package.json 还没到，
  // dsh 启动时报 `ENOENT: .../dsh/package.json`，重启一次又好了（那时拷完了），
  // 是最难查的那种「偶发」。
  //
  // 改成先拷到 <target>.tmp-<pid>、写完再 rename：同一卷上 rename 是原子的，
  // 于是 target 只有「不存在」和「完整」两种状态，没有中间态。
  const staging = '`${target}.tmp-${process.pid}`'
  await rm(staging, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  try {
    await cp(CORE_PKG_DIR, staging, { recursive: true })
    if (!isCompleteInstall(staging)) {
      throw new Error('复制出来的 dsh 本体不完整（缺 lib/bin.js 或 package.json）')
    }
    // 版本目录自己的 package.json：npm 装出来的那份也有，别的逻辑（比如探测）
    // 会读它来判断这个目录是个安装；不带 BOM，dsh 用 JSON.parse 直接读。
    await writeFile(join(versionDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-version',
      private: true,
      version: '0.0.0',
    }, null, 2)}\n`)
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return target
}

/**
 * 一个目录算不算「完整可用的 dsh 安装」。
 *
 * 两个文件都要在：`lib/bin.js` 是入口，`package.json` 是 dsh 自己启动时要读的清单
 * （缺了它报 ENOENT）。只看入口不够 —— 那正是上面那个竞态的由来。
 */
function isCompleteInstall(dir) {
  return existsSync(join(dir, 'lib', 'bin.js')) && existsSync(join(dir, 'package.json'))
}

/**
 * 内置载荷的整体自检：给界面和日志一句话结论，说明「离线能力到底齐不齐」。
 *
 * 缺哪一项都不该让启动器崩 —— 源码运行时本来就没有 core/ 与 node/，这时报告
 * 「没有内置本体」是正常信息，调用方据此决定要不要退回联网路径。
 */
export function inspect() {
  const version = coreVersion()
  const plugins = bundledPluginDirs()
  return {
    root: ROOT,
    core: hasCore(),
    coreVersion: version,
    plugins,
    packs: bundledPackFiles().length,
    corepack: hasCorepackCache(),
    node: NODE_DIR,
    nodeBundled: existsSync(join(NODE_DIR, process.platform === 'win32' ? 'node.exe' : 'node')),
  }
}
