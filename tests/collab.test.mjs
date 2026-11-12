#!/usr/bin/env node
/**
 * 协作面（阶段 3–5）：任务包两格检查、交接单读取、效率度量的纯函数与空账路径。
 */
import { beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resetIsolatedHome } from './isolate.mjs'
import { collabMetricsOf, listHandoffNotes, recordHandoffNote, taskPackOf } from '../lib/collab.js'

beforeEach(resetIsolatedHome)

/** 空 fs：任何读都按结构化「未找到」处理（不把"读不到"降级成空文件的那条纪律不变）。 */
const emptyFs = {
	resolve() {
		const error = new Error('ENOENT')
		error.code = 'ENOENT'
		throw error
	},
	stat() {
		throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
	},
	readText() {
		throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
	},
	resolvePath: (path) => path,
}

/** 真文件系统之上的最小 `ctx.fs`（与其余自检同一套：方法名与宿主一一对应）。 */
function makeFs() {
	const pathOf = (target) => (typeof target === 'string' ? target : target?.path)
	return {
		async resolve(path) {
			return { path, displayPath: path }
		},
		async stat(target) {
			try {
				const info = statSync(pathOf(target))
				return { type: info.isDirectory() ? 'directory' : 'file', size: info.size }
			} catch (error) {
				if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
				throw error
			}
		},
		async readText(target) {
			return readFileSync(pathOf(target), 'utf8')
		},
		async writeText(target, data) {
			mkdirSync(dirname(pathOf(target)), { recursive: true })
			writeFileSync(pathOf(target), data)
		},
		processPath(target) {
			return pathOf(target)
		},
	}
}

const exec = { workspace: '/tmp/team-ops-collab-test', agent: { id: 'lead' } }

describe('协作面：任务包、交接单、度量', () => {
	test('任务包两格：缺一格即不完整', () => {
		assert.equal(taskPackOf('').complete, false)
		assert.equal(taskPackOf('产物形态：判断').complete, false)
		assert.equal(taskPackOf('验收判据：跑 npm test').complete, false)
		assert.equal(taskPackOf('产物形态：判断；验收判据：跑 npm test').complete, true)
		assert.equal(taskPackOf('artifactForm: 规格 / acceptance: 看回执').complete, true)
	})

	test('交接单：空账时返回 0 条，不假装有数据', async () => {
		const listed = await listHandoffNotes({ fs: emptyFs, logger: { warn() {} } }, exec)
		assert.equal(listed.ok, true)
		assert.equal(listed.total, 0)
		assert.deepEqual(listed.notes, [])
	})

	test('度量：空任务板 + 空交接单 + 无冲突', async () => {
		const metrics = await collabMetricsOf(
			{ fs: emptyFs, agentTeams: { listTasks: () => [] }, logger: { warn() {} } },
			exec,
		)
		assert.equal(metrics.ok, true)
		assert.deepEqual(metrics.tasks, { total: 0, todo: 0, doing: 0, done: 0 })
		assert.equal(metrics.handoffs.total, 0)
		assert.equal(metrics.conflicts, 0)
		assert.equal(metrics.packMissing, 0)
	})

	test('交接单：写入真的落盘（只增、带 seq 与 writer），读回来是同一份', async () => {
		// 这条补的是**写入路径**：从前只有读与纯函数有用例，`recordHandoffNote` 一次都没被跑过。
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-handoff-'))
		const ctx = { fs: makeFs(), logger: { warn() {} } }
		const writer = { workspace, agent: { id: 'qa-1' } }
		const written = await recordHandoffNote(ctx, writer, { to: 'reviewer', artifact: '测试报告', path: 'docs/qa/report.md', need: '上线前看一遍' })
		assert.equal(written.ok, true)
		assert.equal(written.total, 1)
		assert.equal(written.note.from, 'qa-1', 'from 取的是调用方的 agent id（成员名）')
		assert.equal(written.note.to, 'reviewer', 'to 是接收**角色 id**，不是成员名')
		assert.equal(written.file, join(workspace, '.ops/handoffs.json'))
		const onDisk = JSON.parse(readFileSync(join(workspace, '.ops/handoffs.json'), 'utf8'))
		assert.equal(onDisk.version, 1)
		assert.equal(onDisk.seq, 1, '第一次写入 seq=1')
		assert.equal(onDisk.notes.length, 1)
		assert.deepEqual(Object.keys(onDisk.notes[0]).sort(), ['artifact', 'at', 'from', 'need', 'path', 'to'].sort())
		assert.ok(onDisk.writer !== undefined && onDisk.writer.pid !== undefined, '写者戳要在（并发判断靠它）')
		const listed = await listHandoffNotes(ctx, writer)
		assert.equal(listed.total, 1)
		assert.equal(listed.notes[0].need, '上线前看一遍')
	})

	test('交接单的发出方：按 agent id 反查原生名册，查不到才退回会话 id（不编名字）', async () => {
		// 工具拿到的 `exec.agent.id` 是**会话 id**（`session-…`）：直接写进 `from`，面板上就是一串 UUID，
		// 成员卡按成员名匹配的那一侧也永远对不上。这里核两条路：查得到用名字，查不到如实退回 id。
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-handoff-from-'))
		const roster = { listMembers: () => [{ id: 'session-47773a61', name: 'qa-1' }] }
		const ctx = { fs: makeFs(), get: (name) => (name === 'agentTeams' ? roster : undefined), logger: { warn() {} } }
		const writer = { workspace, agent: { id: 'session-47773a61' } }
		const known = await recordHandoffNote(ctx, writer, { to: 'reviewer', artifact: '测试报告', path: 'docs/qa/report.md', need: '上线前看一遍' })
		assert.equal(known.note.from, 'qa-1', '名册里有这一位 ⇒ from 写成员名，不写会话 id')

		const ctxUnknown = { fs: makeFs(), get: () => ({ listMembers: () => [] }), logger: { warn() {} } }
		const unknown = await recordHandoffNote(ctxUnknown, { workspace, agent: { id: 'session-deadbeef' } }, { to: 'qa', artifact: '规格', path: 'docs/x.md', need: '看一眼' })
		assert.equal(unknown.note.from, 'session-deadbeef', '名册里没有 ⇒ 如实退回 agent id（不编名字）')
	})

	test('度量：交接单已经读过 ⇒ 不再读一次盘（/collab 的"只读一次"）', async () => {
		// 传进来的那一份就是唯一一次读：`emptyFs.readText` 直接抛，任何多余的读都会让这条炸。
		const metrics = await collabMetricsOf(
			{ fs: emptyFs, agentTeams: { listTasks: () => [] }, logger: { warn() {} } },
			exec,
			{ handoffs: { ok: true, notes: [], file: '/tmp/team-ops-collab-test/.ops/handoffs.json', total: 7 } },
		)
		assert.equal(metrics.handoffs.total, 7, '总数照传进来的那一份（不重读）')
		assert.equal(metrics.handoffs.gaps, 0)
	})

	test('度量：任务 description 缺两格 ⇒ packMissing 计数', async () => {
		const rows = [
			{ id: 'task-1', status: '已完成', description: '产物形态：判断；验收判据：跑测试' },
			{ id: 'task-2', status: '进行中', description: '只有描述' },
		]
		const metrics = await collabMetricsOf(
			{ fs: emptyFs, agentTeams: { listTasks: () => rows }, logger: { warn() {} } },
			exec,
		)
		assert.equal(metrics.tasks.total, 2)
		assert.equal(metrics.tasks.done, 1)
		assert.equal(metrics.tasks.doing, 1)
		assert.equal(metrics.packMissing, 1)
	})
})
