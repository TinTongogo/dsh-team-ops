#!/usr/bin/env node
/**
 * **宿主契约探针**：插件依赖的那几个方法在**当前装着的 DSH** 里还在不在。
 *
 * 为什么要有它：宿主升级会静默换掉服务的方法面（0.2.2 就把 `listMembers` / `spawnTeammate` /
 * `sendMessage` / `waitForChange` 从 `TeamService` 拿掉，改到 subagent 体系），插件不会编译报错，
 * 症状只有运行时那一句「读不到」。这条把「升级后先跑它」变成一条命令。
 *
 * 找不到 `app.asar` 时**跳过**（不是红）：别的机器没装 Desktop 版时，这条没有可探的对象。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const ASAR_CANDIDATES = [
	process.env.DSH_APP_ASAR,
	'/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
].filter((value) => typeof value === 'string' && value !== '')

/** 读 asar 里的一个文件（asar 头 + 偏移；不引第三方库）。 */
function createAsarReader(filename) {
	const fd = readFileSync(filename)
	const headerSize = fd.readUInt32LE(4)
	const header = fd.subarray(8, 8 + headerSize)
	const json = JSON.parse(header.subarray(8, 8 + header.readUInt32LE(4)).toString('utf8'))
	const walk = (node, parts) => {
		let current = node
		for (const part of parts) current = current?.files?.[part]
		return current
	}
	return (path) => {
		const entry = walk(json, path.split('/').filter(Boolean))
		if (entry === undefined || entry.files !== undefined) throw new Error('asar 里没有这个文件：' + path)
		const start = 8 + headerSize + Number(entry.offset)
		return fd.subarray(start, start + Number(entry.size)).toString('utf8')
	}
}

const asarPath = ASAR_CANDIDATES.find((candidate) => existsSync(candidate))
const read = asarPath === undefined ? null : createAsarReader(asarPath)
const SKIP = read === null ? '这台机器上找不到 DSH 的 app.asar（用 DSH_APP_ASAR 指定）' : false

test('宿主契约：TeamService 仍有任务四方法与团队开关', { skip: SKIP }, () => {
	const source = read('/dsh/node_modules/@deepseek-ai/dsh-agent-team/src/index.ts')
	for (const method of ['isEnabled(', 'setEnabled(', 'createTask(', 'getTask(', 'listTasks(', 'updateTask(']) {
		assert.ok(source.includes(method), `TeamService 缺 ${method} —— 宿主升级改了成员/任务面，先读 docs/team/native-teams.md`)
	}
})

test('宿主契约：subagent 服务仍有成员面（list/spawn/send/interrupt）', { skip: SKIP }, () => {
	const index = read('/dsh/node_modules/@deepseek-ai/dsh-subagent/src/index.ts')
	const manager = read('/dsh/node_modules/@deepseek-ai/dsh-subagent/src/manager.ts')
	const control = read('/dsh/node_modules/@deepseek-ai/dsh-tool-subagent-control/src/index.ts')
	const names = read('/dsh/node_modules/@deepseek-ai/dsh-subagent/src/names.ts')
	const all = index + '\n' + manager + '\n' + control + '\n' + names
	for (const method of ['listDescendants(', 'startActivation(', 'sendMessage(', 'resolveName(', 'interrupt(']) {
		assert.ok(all.includes(method), `subagent 面缺 ${method} —— 插件的成员后端要跟着改`)
	}
	assert.ok(all.includes("ROOT_AGENT_NAME = 'lead'"), '根成员名约定变了（插件按 `lead` 拼名册）')
})

test('插件声明了宿主最低版本（engines.dsh）', () => {
	const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
	assert.equal(typeof manifest.engines?.dsh, 'string', 'package.json 的 engines.dsh 缺失：宿主升级时不会拦住不兼容的安装')
	assert.ok(manifest.engines.dsh.trim() !== '', 'engines.dsh 不能是空串')
})
