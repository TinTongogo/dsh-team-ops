/**
 * **发布脚本的自检**（`scripts/publish-github.mjs`）：只测**能离线测的那部分** ——
 * 要发哪些文件、期望的树 SHA 怎么算、用法错怎么拒。真的往 GitHub 发一次是人的动作，不在这里跑。
 *
 * 两件事必须成立：
 *   · **排除面**：`docs/` 一个文件都不许进公开树（历史里也不许 —— 这里核的是清单，历史由脚本的无父提交保证）；
 *   · **树 SHA 可核对**：脚本算出来的那个 SHA 要等于**用另一条路**（同一台机器上直接 `git read-tree` /
 *     `git rm` / `git write-tree`）算出来的值 —— 否则"推上去的是哪棵树"就没人证明了。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const SCRIPT = 'scripts/publish-github.mjs'
const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
const skipNoGit = hasGit ? false : '这台机器没有 git（发布脚本依赖它）'

/** 独立算一遍"发布树"：不 import 脚本，走 git 原生命令，并拿它跟脚本的输出比。 */
function expectedTreeSha() {
	const dir = mkdtempSync(join(tmpdir(), 'publish-github-test-'))
	mkdirSync(join(dir, '.ops'), { recursive: true })
	const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') }
	try {
		const run = (args) => {
			const result = spawnSync('git', args, { encoding: 'utf8', env })
			assert.equal(result.status, 0, `git ${args.join(' ')} 失败：${result.stderr}`)
			return result.stdout
		}
		run(['read-tree', 'HEAD'])
		run(['rm', '-r', '-q', '--cached', '--ignore-unmatch', 'docs/'])
		return run(['write-tree']).trim()
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

test('发布脚本在，且能被解析', () => {
	assert.ok(existsSync(SCRIPT), '脚本要在：' + SCRIPT)
	const check = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
	assert.equal(check.status, 0, check.stderr)
})

test('--dry-run：只算本地，排除 docs/，树 SHA 与独立算法一致', { skip: skipNoGit }, () => {
	const run = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--from', 'HEAD'], { encoding: 'utf8' })
	assert.equal(run.status, 0, run.stderr)
	const out = `${run.stdout}${run.stderr}`
	const listed = run.stdout
		.split('\n')
		.filter((line) => line.startsWith('  '))
		.map((line) => line.trim())
	assert.ok(listed.length > 0, '试运行要列出要发布的文件：' + out.slice(0, 300))
	assert.ok(!listed.some((path) => path.startsWith('docs/')), 'docs/ 下的文件不许进公开树：' + listed.filter((p) => p.startsWith('docs/')).join('、'))
	const printed = /期望树 SHA：([0-9a-f]{40})/.exec(run.stdout)
	assert.ok(printed !== null, '要印出期望树 SHA：' + out.slice(0, 300))
	assert.equal(printed[1], expectedTreeSha(), '脚本算的树与用 git 原生命令独立算出来的必须一致')
	// 试运行**不许**碰网络：脚本自己的承诺，这里按它的输出核。
	assert.match(run.stdout, /试运行：没有发出任何网络请求/)
})

test('用法错：--repo 不写成 owner/name ⇒ 退出码 2 并说清楚', { skip: skipNoGit }, () => {
	// 缺斜杠 / 多段斜杠都算形状不对（`不是owner/name` 里带了一个斜杠，其实是合法形状）。
	const run = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--repo', 'justname'], { encoding: 'utf8' })
	assert.equal(run.status, 2, '用法错要回 2（收到 ' + run.status + '）')
	assert.match(`${run.stdout}${run.stderr}`, /owner\/name/)
})
