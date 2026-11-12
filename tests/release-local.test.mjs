#!/usr/bin/env node
/**
 * `scripts/release-local.mjs` 的自检：只测 `--dry-run` 与错误分支，**不真的发布**。
 *
 * 真实发布要写 profile / 掉 pnpm install，不能在测试里跑；这里钉住"计划里四步齐全、dry-run 不写文件、
 * profile 缺依赖时明确失败"。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const ROOT = resolve(import.meta.dirname, '..')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

/** 造一个临时 profile（依赖可选）。 */
function profileWith(dependency) {
	const base = mkdtempSync(join(tmpdir(), 'team-ops-release-'))
	const profile = join(base, 'profile')
	mkdirSync(profile)
	writeFileSync(
		join(profile, 'package.json'),
		JSON.stringify({ name: 'probe-profile', private: true, dependencies: dependency === undefined ? {} : { 'dsh-team-ops': dependency } }, null, 2) + '\n',
		'utf8',
	)
	return { base, profile }
}

function runRelease(args) {
	return spawnSync(process.execPath, [join(ROOT, 'scripts', 'release-local.mjs'), ...args], { encoding: 'utf8' })
}

test('release:local --dry-run：打印四步计划，且不写任何文件', () => {
	const { base, profile } = profileWith('file:/tmp/old-dsh-team-ops.tgz')
	const tarballDir = join(base, 'team-ops')
	try {
		const run = runRelease(['--dry-run', '--profile', profile, '--tarball-dir', tarballDir])
		assert.equal(run.status, 0, run.stderr)
		const out = run.stdout
		assert.ok(out.includes('dsh-team-ops-' + VERSION + '.tgz'), '计划里要有当前版本的 tarball 名：' + out)
		assert.ok(out.includes('npm pack'), '第一步：打包')
		assert.ok(out.includes('pnpm.mjs install'), '第三步：DSH 自带 pnpm 11 安装')
		assert.ok(out.includes('version == ' + VERSION), '第四步：核对安装副本版本')
		assert.ok(out.includes('未写任何文件'), 'dry-run 要明确说不写')
		assert.equal(existsSync(tarballDir), false, 'dry-run 不许创建 tarball 目录')
		assert.equal(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies['dsh-team-ops'], 'file:/tmp/old-dsh-team-ops.tgz', 'dry-run 不许改 profile 依赖')
	} finally {
		rmSync(base, { recursive: true, force: true })
	}
})

test('release:local：profile 没有 dsh-team-ops 依赖 ⇒ 明确失败并指出先按 README 装', () => {
	const { base, profile } = profileWith(undefined)
	try {
		const run = runRelease(['--dry-run', '--profile', profile, '--tarball-dir', join(base, 'team-ops')])
		assert.equal(run.status, 1, '缺依赖要非零退出')
		assert.match(run.stderr, /dependencies 里没有 dsh-team-ops/, run.stderr)
		assert.match(run.stderr, /README「装」/, '要指路先装一次')
	} finally {
		rmSync(base, { recursive: true, force: true })
	}
})
