#!/usr/bin/env node
/**
 * 英文概览（`README.en.md`）与代码之间的对应关系 —— 同一事实两处，就得配一条机械检查。
 *
 * 为什么要有这一条：中文 README 是正文，英文那份是给评审读的精简页。它抄了两类会漂的事实：
 *   ① **工具清单**（16 个工具的名字与职责）—— 代码里加一个 / 改名一个，英文表不会报错，只会悄悄过期；
 *   ② **角色数**（"19 roles ship with the package"）—— 角色增删时同理。
 * ② 已经用「从 `lib/roster.js` 生成」解决（两份 README 的块都由一份现场枚举渲染）；① 无法生成，
 * 所以用下面的断言把「表 = 源码注册」钉住：多一个、少一个都红。
 *
 * 判据：
 *   ① `README.en.md` 的 `## Tools` 表第一列（反引号里的名字）= 源码里 `textTool({ name: '…' })` 注册的名字集合；
 *   ② 两份 README 的 `ROSTER` 生成块都与现场枚举一致（忘了跑 `npm run roster:write` 会红）。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { checkRoster } from '../lib/roster.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const README_EN = join(ROOT, 'README.en.md')

/**
 * 源码里注册的工具名：`textTool({ name: '…' })`。
 * @returns {Set<string>} 工具名集合。
 */
function registeredTools() {
	const names = new Set()
	for (const dir of ['team', 'lib']) {
		for (const file of readdirSync(join(ROOT, dir))) {
			if (!file.endsWith('.js')) continue
			const source = readFileSync(join(ROOT, dir, file), 'utf8')
			for (const matched of source.matchAll(/textTool\(\{\s*\n?\s*name: '([a-z_]+)'/g)) names.add(matched[1])
		}
	}
	return names
}

/**
 * `README.en.md` 的 `## Tools` 表里第一列的工具名。
 * @returns {Set<string>} 文档里写出来的工具名。
 */
function documentedTools() {
	const lines = readFileSync(README_EN, 'utf8').split('\n')
	const start = lines.findIndex((line) => /^##\s+Tools\b/.test(line))
	assert.notEqual(start, -1, 'README.en.md 里找不到 `## Tools` 一节')
	const names = new Set()
	for (const line of lines.slice(start + 1)) {
		if (/^##\s/.test(line)) break
		const cell = /^\|\s*`([a-z_]+)`\s*\|/.exec(line)
		if (cell !== null) names.add(cell[1])
	}
	return names
}

test('英文工具表与源码注册的工具一一对应（多一个 / 少一个都红）', () => {
	const registered = [...registeredTools()].sort()
	const documented = [...documentedTools()].sort()
	assert.ok(registered.length >= 16, '扫到的已注册工具太少，检查可能失效：' + registered.length)
	const missing = registered.filter((name) => !documented.includes(name))
	const extra = documented.filter((name) => !registered.includes(name))
	assert.deepEqual(
		{ missing, extra },
		{ missing: [], extra: [] },
		'英文工具表与代码对不上 —— 表里缺：' + missing.join(' / ') + '；表里多出：' + extra.join(' / '),
	)
})

test('两份 README 的角色生成块都与现场枚举一致（角色增删后要跑 npm run roster:write）', () => {
	const drifted = checkRoster().filter((target) => !target.ok)
	assert.deepEqual(
		drifted.map((target) => target.label),
		[],
		'这些生成块与现场不一致：' + drifted.map((target) => target.label).join(' / '),
	)
})
