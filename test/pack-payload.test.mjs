/**
 * 安装包必须带上内置插件（plugins/ 下那一批）与内置整合包。
 *
 * 这条守的是历史上真出过的那类事故：pack 用的是显式清单，新增目录忘了同步就静默少文件
 * （repair.js 当年就这么漏过）。这里真跑一次 copyAppFiles 到临时目录再回读，
 * 而不是只 grep 源码。
 *
 * 断言**动态读 plugins/ 目录**而不是写死一张名单：这份名单本来就会随用户环境变
 * （加插件、换变体），写死的话每次都要跟着改测试，反而失去守住的意义。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { copyAppFiles } from '../scripts/pack-common.mjs'

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))

test('安装包会带上内置插件与内置整合包，且不带上它们的测试', async () => {
  const out = mkdtempSync(join(tmpdir(), 'dsh-pack-payload-'))
  try {
    await copyAppFiles(out)
    const sourcePlugins = readdirSync(join(ROOT_DIR, 'plugins'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
    assert.ok(sourcePlugins.length > 0, 'plugins/ 下应当有内置插件')
    for (const name of sourcePlugins) {
      const base = join(out, 'plugins', name)
      assert.ok(existsSync(join(base, 'package.json')), `${name} 的清单应该在安装包里`)
      assert.ok(existsSync(join(base, 'cordis.patch.yml')), `${name} 的补丁层应该在安装包里`)
      const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'))
      const main = String(pkg.main || 'index.js').replace(/^\.\//, '')
      assert.ok(existsSync(join(base, main)), `${name} 的主体（${main}）应该在安装包里`)
      // 用例与依赖不进用户机器（依赖由装机器上的 pnpm 按 file: 就地装）
      for (const junk of ['test', 'tests', 'node_modules']) {
        assert.ok(!existsSync(join(base, junk)), `${name} 不该带上 ${junk}`)
      }
    }
    // 离线供给层必须随包发：它判断内置本体/插件/整合包在哪、怎么装。
    assert.ok(existsSync(join(out, 'offline.js')), '离线供给层在安装包里')
    // 内置整合包也随包发：插件页的「内置整合包」就地安装，不用联网
    assert.ok(existsSync(join(out, 'packs', 'dsh-x-recommended', 'manifest.json')), '内置整合包在安装包里')
    assert.ok(existsSync(join(out, 'packs', 'dsh-x-recommended', 'README.md')))
    // 启动器源码与静态资源同样在（同一个清单，顺手一起钉住）
    assert.ok(existsSync(join(out, 'server.js')), '启动器源码在')
    assert.ok(existsSync(join(out, 'reserved-profile-boot.mjs')), '起 desktop profile 用的绕行入口在')
    assert.ok(existsSync(join(out, 'public', 'index.html')), '管理页在')
    // 光看文件存在抓不住传递依赖遗漏：在复制后的目录解析整棵服务依赖树。
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./server.js')"], {
      cwd: out,
      env: { ...process.env, APPDATA: join(out, 'test-user'), DSH_VERSIONS_DATA: join(out, 'test-data') },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    })
    assert.equal(result.status, 0, result.error?.message || result.stderr)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
