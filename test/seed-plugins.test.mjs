/**
 * 内置插件（plugins/ 下那一批）的两条落地路径：
 *
 * 1. 预置：启动器把安装包自带的那些复制到 $DSH_HOME/bundled/，再按 `file:` 装进当前 profile
 *    （「内置插件」开关，**默认开**；旧键 seedMemory / seedBundled 当别名读）；
 * 2. 内置整合包：推荐包（packs/dsh-x-recommended）里那条 `"…": "bundled"` 依赖，
 *    安装时解析成同一批 file: 路径。
 *
 * 这批是按用户机器上实际在跑的那套环境定的：免费模型（默认装，能直接开聊）、
 * omniroute、workbuddy、小模型委派。不在其中的两件及其原因见 server.js 的
 * BUNDLED_PLUGINS 注释（同步插件随同步引擎移除；鲸鱼记账按用户要求排除）。
 *
 * 两条都跑真服务（假 dsh 入口）——复制、写清单、注册 bundle 都是启动器自己的代码，
 * 只有 pnpm 那一步被假入口挡掉，正是这里要验的边界。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGINS_ROOT = fileURLToPath(new URL('../plugins', import.meta.url))
const PACK_DIR = fileURLToPath(new URL('../packs/dsh-x-recommended', import.meta.url))
// 与 server.js 的两个常量对齐：BUNDLED_PLUGINS 加上单独一条路的 FREE_MODEL_PLUGIN。
// 部署时它们一起被预置（见 seedFreeModelPlugins），所以这里也合在一张表里。
const BUNDLED = [
  'dsh-our-free-model',
  'dsh-omniroute-connect',
  'dsh-workbuddy-connect',
  'dsh-small-model-delegate',
  'dsh-whale-widget',
]

async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** 起一套隔离的管理页（同 packs-api 的套路：临时 APPDATA / 数据目录 / dsh 家目录 + 假 dsh 入口）。 */
async function startManager() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-seed-plugins-'))
  const appData = join(root, 'appdata')
  const appDir = join(appData, 'DSH')
  const dataDir = join(root, 'data')
  const home = join(root, 'dsh-home')
  mkdirSync(appDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  const port = await freePort()
  writeFileSync(join(appDir, 'settings.json'), JSON.stringify({
    dataDir,
    dshHome: home, dshHomeMode: 'shared',
    port,
    autoStart: false,
    seedMarket: false,
    seedFreeModel: false,
  }, null, 2))
  // 假 dsh：版本目录里放一份能解析的入口，plugin 命令跑它就够了
  const fakeBin = join(dataDir, 'versions', '9.9.9', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(join(fakeBin, '..'), { recursive: true })
  writeFileSync(fakeBin, 'process.exit(0)\n')
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ versions: ['9.9.9'] }, null, 2))
  // 当前 profile 的清单：registerBundle 要有东西可写
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } },
  }, null, 2))

  process.env.APPDATA = appData
  process.env.DSH_VERSIONS_DATA = dataDir
  process.env.PORT = String(port)
  const server = await import('../server.js')
  const origin = await server.startServer()
  const call = async (path, body) => {
    const res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body ?? {}),
    })
    return { status: res.status, data: await res.json() }
  }
  return { root, home, dataDir, profileDir, call, get: async (path) => {
    const res = await fetch(`${origin}${path}`, { headers: { origin } })
    return { status: res.status, data: await res.json() }
  }, stop: () => server.stopAll() }
}

test('内置插件与内置整合包', async (t) => {
  const manager = await startManager()
  t.after(() => {
    manager.stop()
    rmSync(manager.root, { recursive: true, force: true })
  })
  const bundledDir = join(manager.home, 'bundled')
  const versions = Object.fromEntries(BUNDLED.map((name) => [
    name,
    JSON.parse(readFileSync(join(PLUGINS_ROOT, name, 'package.json'), 'utf8')).version,
  ]))

  await t.test('默认关：设置里没写过这个键时，状态里是 false', async () => {
    const res = await manager.get('/api/settings')
    assert.equal(res.data.seedBundled, false, '内置插件默认应该是关闭的')
  })

  await t.test('旧键 seedMemory 还认：关掉就什么都不做', async () => {
    const res = await manager.call('/api/settings', { seedMemory: false })
    assert.equal(res.status, 200)
    assert.equal(res.data.seedBundled, false, '旧键当作别名写进新键')
    assert.ok(!existsSync(bundledDir), '关掉就不该复制')
  })

  await t.test('打开开关：内置的那批复制到 DSH_HOME 并写进 profile 的 bundles', async () => {
    // 旧的 seedBundled / seedMemory 两个键现在都归到 seedFreeModel 这一个开关下
    const res = await manager.call('/api/settings', { seedBundled: true })
    assert.equal(res.status, 200)
    assert.equal(res.data.seedPlugins, true, '打开后统一读 seedPlugins')
    for (const name of BUNDLED) {
      assert.ok(existsSync(join(bundledDir, name, 'package.json')), `${name} 复制到了 DSH_HOME/bundled`)
      const pkg = JSON.parse(readFileSync(join(bundledDir, name, 'package.json'), 'utf8'))
      assert.equal(pkg.version, versions[name])
      // 主体的位置各包不同（有的是 index.js，有的是 lib/index.js）：按 package.json 的
      // main 字段判，别把某一个包的具体布局钉死在这里。
      const main = String(pkg.main || 'index.js').replace(/^\.\//, '')
      assert.ok(existsSync(join(bundledDir, name, main)), `${name} 的主体在（${main}）`)
      assert.ok(existsSync(join(bundledDir, name, 'cordis.patch.yml')), `${name} 的补丁层在`)
      // 用例与 tests/ 都不该进用户机器（按 files 字段裁剪过）
      for (const junk of ['test', 'tests', 'node_modules']) {
        assert.ok(!existsSync(join(bundledDir, name, junk)), `${name} 不该带上 ${junk}`)
      }
    }
    const manifest = JSON.parse(readFileSync(join(manager.profileDir, 'package.json'), 'utf8'))
    for (const name of BUNDLED) {
      assert.ok(manifest.dsh.profile.bundles.includes(name), `bundle 列表里要有 ${name}，否则 dsh 不加载`)
    }
  })

  await t.test('重复打开不重复登记', async () => {
    const res = await manager.call('/api/settings', { seedFreeModel: true })
    assert.equal(res.status, 200)
    const manifest = JSON.parse(readFileSync(join(manager.profileDir, 'package.json'), 'utf8'))
    for (const name of BUNDLED) {
      assert.equal(manifest.dsh.profile.bundles.filter((item) => item === name).length, 1)
    }
  })

  await t.test('内置整合包：bundled 依赖解析成 DSH_HOME 下那份的 file: 路径', async () => {
    const packs = await manager.get('/api/packs')
    assert.equal(packs.data.builtin?.name, 'dsh-x-recommended', '/api/packs 要带上内置整合包的信息')
    assert.ok(packs.data.builtin.path.endsWith('dsh-x-recommended'))

    const inspect = await manager.call('/api/packs/inspect', { source: PACK_DIR })
    assert.equal(inspect.status, 200, inspect.data.error)
    assert.equal(inspect.data.ok, true, JSON.stringify(inspect.data.plan?.errors))
    assert.equal(inspect.data.pack.name, 'dsh-x-recommended')
    const install = await manager.call('/api/packs/install', { token: inspect.data.token, profile: 'dshx' })
    assert.equal(install.status, 200, install.data.error)
    const manifest = JSON.parse(readFileSync(join(manager.home, 'profiles', 'dshx', 'package.json'), 'utf8'))
    // 以**整合包配方**为准列 bundled 依赖，而不是拿 BUNDLED 硬套：配方是可以单独调的
    // （有的内置插件不在这份「推荐环境」里），测试不该把两者钉死成同一份清单。
    const recipe = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8'))
    const bundledNames = Object.entries(recipe.dependencies)
      .filter(([, spec]) => spec === 'bundled')
      .map(([name]) => name)
    assert.ok(bundledNames.length > 0, '推荐包至少要有一条 bundled 依赖，否则这条用例没验到东西')
    for (const name of bundledNames) {
      assert.ok(BUNDLED.includes(name), `${name} 写的是 bundled，就必须真的在内置插件里`)
      assert.equal(manifest.dependencies[name], `file:${join(bundledDir, name)}`, `${name} 的 bundled 依赖要落成绝对路径`)
      assert.ok(manifest.dsh.profile.bundles.includes(name))
    }
    assert.match(manifest.dependencies['dsh-config-manager'], /^\^/, '生态插件仍然按版本从 npm 装')
  })
})
