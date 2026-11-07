#!/usr/bin/env node
/**
 * 上下文连贯性补缺的自检（设计见 `docs/team/specs/上下文连贯性补缺.md`）。
 *
 * 两块：① 快照事件化（原生 team/task / team/member 改动也会刷新快照）；
 *       ② 检查点（结构化落盘 + 压缩原始转储 + 摘要里的缺失提示）。
 *
 * 这里不拉起 DSH：会话事件、团队服务都用最小假件；写盘是真的（临时工作区）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, test } from 'node:test'

import { appendStructured, assertTaskId, listStructured, readCheckpoint, structuredExists, structuredPathOf, writeCompactionCheckpoint } from '../lib/checkpoint.js'
import { migrateWorkspaceSync } from '../lib/ops-files.js'
import { installSessionWatch } from '../lib/session-watch.js'
import { teamCheckpoint } from '../team/company-gate.js'

const ROOT = resolve(import.meta.dirname, '..')

function workspace() {
	return mkdtempSync(join(tmpdir(), 'team-ops-continuity-'))
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

test('旧布局迁移：`.company-gate.*` → `.ops/*`（前缀去掉；旧文件不残留）', () => {
	const dir = workspace()
	writeFileSync(join(dir, '.company-gate.human.json'), JSON.stringify({ version: 1, words: [] }))
	writeFileSync(join(dir, '.company-gate.handoff.json'), JSON.stringify({ version: 1, tasks: [] }))
	mkdirSync(join(dir, '.company-gate.checkpoints', 'compaction'), { recursive: true })
	writeFileSync(join(dir, '.company-gate.checkpoints', 'compaction', 'x.md'), 'x')
	migrateWorkspaceSync(dir)
	assert.ok(existsSync(join(dir, '.ops', 'human.json')) || existsSync(join(dir, '.ops', 'human.json')))
	assert.ok(existsSync(join(dir, '.ops', 'handoff.json')))
	assert.ok(existsSync(join(dir, '.ops', 'checkpoints', 'compaction', 'x.md')))
	assert.equal(existsSync(join(dir, '.company-gate.human.json')), false)
	assert.equal(existsSync(join(dir, '.company-gate.handoff.json')), false)
	assert.equal(existsSync(join(dir, '.company-gate.checkpoints')), false)
})

// ── 检查点：路径与结构化 ─────────────────────────────────────────────────────

test('检查点：任务编号先过形状；越界路径当场拒', () => {
	const dir = workspace()
	assert.throws(() => assertTaskId('../etc/passwd'), /task-<数字>/)
	assert.throws(() => structuredPathOf(dir, 'task-x'), /task-<数字>/)
	assert.throws(() => structuredPathOf(dir, 'task-1/../../x'), /task-<数字>/)
	assert.equal(structuredPathOf(dir, 'task-1'), join(dir, 'docs', 'team', 'checkpoints', 'task-1.md'))
})

test('结构化检查点：append-only、可读、可列；超过上限轮转', async () => {
	const dir = workspace()
	await appendStructured(dir, 'task-1', { role: 'fe-dev', summary: '第一条', facts: ['事实 A'] })
	await appendStructured(dir, 'task-1', { role: 'fe-dev', summary: '第二条', decisions: ['决定 B'] })
	const path = structuredPathOf(dir, 'task-1')
	const content = await readCheckpoint(path)
	assert.match(content, /第一条/)
	assert.match(content, /第二条/)
	assert.match(content, /事实 A/)
	assert.match(content, /决定 B/)
	assert.equal(await structuredExists(dir, 'task-1'), true)
	const rows = await listStructured(dir)
	assert.deepEqual(rows.map((row) => row.task), ['task-1'])

	// 小上限 ⇒ 轮转出 `.1.md`，主文件只留最新一节
	for (let index = 0; index < 6; index += 1) {
		await appendStructured(dir, 'task-2', { role: 'qa', summary: '第 ' + index + ' 节' }, { maxBytes: 700, rotations: 2 })
	}
	assert.ok(statSync(join(dir, 'docs', 'team', 'checkpoints', 'task-2.1.md')).size > 0, '轮转文件要在')
	assert.ok(!readFileSync(join(dir, 'docs', 'team', 'checkpoints', 'task-2.md'), 'utf8').includes('第 0 节'), '主文件只留最新')
})

test('列表字段超过 20 条：写省略标注，不静默丢', async () => {
	const dir = workspace()
	await appendStructured(dir, 'task-9', { role: 'qa', summary: 'x', facts: Array.from({ length: 25 }, (_, index) => 'F' + index) })
	const text = readFileSync(structuredPathOf(dir, 'task-9'), 'utf8')
	assert.match(text, /只列前 20 条，共 25 条/)
})

test('父目录是符号链接：不会为了校验在工作区外建目录', async () => {
	const dir = workspace()
	const outside = workspace()
	mkdirSync(join(dir, 'docs'), { recursive: true })
	const { symlinkSync } = await import('node:fs')
	symlinkSync(outside, join(dir, 'docs', 'team'), 'dir')
	await assert.rejects(() => appendStructured(dir, 'task-10', { role: 'qa', summary: 'x' }), /工作区外/)
	assert.equal(readdirSync(outside).length, 0, '工作区外不该多出目录')
})

test('压缩检查点：写摘要与被压事件；每会话只留最近 5 份', async () => {
	const dir = workspace()
	for (let index = 0; index < 7; index += 1) {
		await writeCompactionCheckpoint(dir, {
			sessionId: 'sess/one',
			compactionId: 'c-' + index,
			role: 'fe-dev',
			at: '2026-11-05T10:00:0' + index + '.000Z',
			summary: '摘要 ' + index,
			provider: 'deepseek-official',
			model: 'deepseek-flash',
			shadowedRange: { start: 1, end: 2 },
			tokens: 1234,
			rendered: '### seq 1\n\n被压掉的内容',
		})
	}
	const dirPath = join(dir, '.ops/checkpoints', 'compaction', 'sess_one')
	const files = readdirSync(dirPath)
	assert.equal(files.length, 5, '只留 5 份：' + files.join('、'))
	const latest = readFileSync(join(dirPath, files.sort()[files.length - 1]), 'utf8')
	assert.match(latest, /压缩摘要/)
	assert.match(latest, /被压掉的内容/)
	assert.match(latest, /deepseek-official\/deepseek-flash/)
})

// ── 会话事件监听 ─────────────────────────────────────────────────────────────

function fakeWatchCtx({ agent, role, events, members }) {
	const handlers = []
	const services = {
		agents: { get: () => agent },
		agentTeams:
			role === null || role === undefined
				? undefined
				: { tryMembership: () => ({ role }), listMembers: () => (members === undefined ? [{ name: 'lead', role: 'lead' }] : members) },
	}
	return {
		ctx: {
			get: (name) => services[name],
			on: (type, handler) => {
				events.push(type)
				handlers.push(handler)
				return () => {}
			},
			logger: { warn() {} },
		},
		emit: (session, event) => {
			for (const handler of handlers) handler(session, event)
		},
	}
}

test('事件化快照：team/task 连续多次只刷新一次（防抖），用的是 Lead agent', async () => {
	const dir = workspace()
	const leads = []
	const { ctx, emit } = fakeWatchCtx({ agent: { id: 'lead-1' }, role: 'lead', events: [] })
	const dispose = installSessionWatch(ctx, {
		recordHandoff: async (context, agent) => {
			leads.push(agent.id)
		},
	})
	try {
		const session = { id: 'sess-1', header: { cwd: dir } }
		for (let index = 0; index < 5; index += 1) emit(session, { type: 'team/task', data: { task: { id: 'task-' + index } } })
		await sleep(350)
		assert.deepEqual(leads, ['lead-1'], '防抖后只写一次')
		emit(session, { type: 'team/member', data: {} })
		await sleep(350)
		assert.deepEqual(leads, ['lead-1', 'lead-1'], 'member 事件也会刷新')
	} finally {
		dispose()
	}
})

test('压缩事件：队内会话落检查点；非队内会话不落', async () => {
	const dir = workspace()
	const agent = { id: 'lead-1' }
	const session = {
		id: 'sess-1',
		header: { cwd: dir },
		eventAt: (seq) => ({ seq, type: 'assistant/message', data: { text: '被压内容 ' + seq } }),
	}
	const team = fakeWatchCtx({ agent, role: 'teammate', events: [] })
	const teamDispose = installSessionWatch(team.ctx)
	const outsider = fakeWatchCtx({ agent: { id: 'other' }, role: null, events: [] })
	const outsiderDispose = installSessionWatch(outsider.ctx)
	try {
		const event = {
			type: 'compaction/summary',
			data: {
				compactionId: 'c-1',
				summary: [{ type: 'text', text: '这一段被压成摘要' }],
				shadowedRange: { start: 1, end: 2 },
				shadowedSeqs: [1, 2],
				shadowedTokenCount: 999,
				provider: 'deepseek-official',
				model: 'deepseek-flash',
			},
		}
		team.emit(session, event)
		outsider.emit({ ...session, id: 'sess-2' }, { ...event, data: { ...event.data, compactionId: 'c-2' } })
		await sleep(50)
		const dirPath = join(dir, '.ops/checkpoints', 'compaction', 'sess-1')
		const files = readdirSync(dirPath)
		assert.deepEqual(files, ['c-1.md'])
		const text = readFileSync(join(dirPath, 'c-1.md'), 'utf8')
		assert.match(text, /这一段被压成摘要/)
		assert.match(text, /被压内容 1/)
	} finally {
		teamDispose()
		outsiderDispose()
	}
})

test('结构化检查点：同一路径并发写不丢节（同毫秒也不会 ENOENT）', async () => {
	const dir = workspace()
	await Promise.all([
		appendStructured(dir, 'task-7', { role: 'qa', summary: '并发 A', facts: ['A'] }),
		appendStructured(dir, 'task-7', { role: 'qa', summary: '并发 B', facts: ['B'] }),
	])
	const content = await readCheckpoint(structuredPathOf(dir, 'task-7'))
	assert.match(content, /并发 A/)
	assert.match(content, /并发 B/)
})

test('结构化检查点：符号链接目录不能把写入带到工作区外', async () => {
	const dir = workspace()
	const outside = workspace()
	mkdirSync(join(dir, 'docs', 'team'), { recursive: true })
	// docs/team/checkpoints -> 工作区外的目录
	const { symlinkSync } = await import('node:fs')
	symlinkSync(outside, join(dir, 'docs', 'team', 'checkpoints'), 'dir')
	await assert.rejects(() => appendStructured(dir, 'task-8', { role: 'qa', summary: '逃逸' }), /工作区外/)
	assert.equal(readdirSync(outside).length, 0, '工作区外不该出现文件')
})

test('压缩检查点：CJK 正文按字节截断，不超过上限', async () => {
	const dir = workspace()
	await writeCompactionCheckpoint(dir, {
		sessionId: 's',
		compactionId: 'big',
		role: 'qa',
		at: new Date().toISOString(),
		summary: '大'.repeat(200),
		provider: 'p',
		model: 'm',
		shadowedRange: { start: 1, end: 2 },
		tokens: 1,
		rendered: '汉'.repeat(600 * 1024), // 约 1.2MB UTF-8
	})
	const text = readFileSync(join(dir, '.ops/checkpoints', 'compaction', 's', 'big.md'))
	assert.ok(text.length <= 512 * 1024 + 200, '文件按字节截断，实际 ' + text.length)
})

test('压缩检查点：Lead 会话没有队友时不落盘；有队友才落', async () => {
	const dir = workspace()
	const session = { id: 'sess-lead', header: { cwd: dir }, eventAt: (seq) => ({ seq, type: 'assistant/message', data: { text: 'x' } }) }
	const event = { type: 'compaction/summary', data: { compactionId: 'c', summary: [{ type: 'text', text: '摘要' }], shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 1, provider: 'p', model: 'm' } }
	const noTeam = fakeWatchCtx({ agent: { id: 'lead-1' }, role: 'lead', events: [], members: [] })
	const withTeam = fakeWatchCtx({ agent: { id: 'lead-1' }, role: 'lead', events: [], members: [{ name: 'qa-1', role: 'teammate' }] })
	const d1 = installSessionWatch(noTeam.ctx)
	const d2 = installSessionWatch(withTeam.ctx)
	try {
		noTeam.emit(session, event)
		await sleep(50)
		assert.ok(!existsSync(join(dir, '.ops/checkpoints', 'compaction', 'sess-lead')), '没有队友时不该落盘')
		withTeam.emit(session, event)
		await sleep(50)
		assert.ok(existsSync(join(dir, '.ops/checkpoints', 'compaction', 'sess-lead', 'c.md')), '有队友时该落盘')
	} finally {
		d1(); d2()
	}
})

// ── 结构化检查点工具 ─────────────────────────────────────────────────────────

test('team_checkpoint：队内可写/读/列；非队内拒；只写工作区', async () => {
	const dir = workspace()
	const memberCtx = { get: (name) => (name === 'agentTeams' ? { tryMembership: () => ({ role: 'teammate' }) } : undefined) }
	const exec = { agent: { session: { header: { cwd: dir } } } }
	const written = await teamCheckpoint(memberCtx, exec, { action: 'write', task: 'task-1', summary: '一条结论', artifacts: ['docs/x.md'] })
	assert.equal(written.ok, true)
	assert.ok(written.path.startsWith(dir))
	const read = await teamCheckpoint(memberCtx, exec, { action: 'read', task: 'task-1' })
	assert.match(read.content, /一条结论/)
	const list = await teamCheckpoint(memberCtx, exec, { action: 'list' })
	assert.deepEqual(list.rows.map((row) => row.task), ['task-1'])
	await assert.rejects(() => teamCheckpoint(memberCtx, exec, { action: 'write', task: 'task-1', summary: 'x', artifacts: ['../etc/passwd'] }), /工作区相对路径/)
	await assert.rejects(() => teamCheckpoint(memberCtx, exec, { action: 'write', task: 'task-1', summary: 'x', artifacts: ['/etc/hosts'] }), /工作区相对路径/)
	const outsiderCtx = { get: () => undefined }
	const denied = await teamCheckpoint(outsiderCtx, exec, { action: 'write', task: 'task-1', summary: 'x' })
	assert.equal(denied.ok, false)
	assert.match(denied.error, /团队会话/)
})

// ── 摘要里的缺失提示 ─────────────────────────────────────────────────────────

test('摘要：完成的条目没有检查点时给一行可见提示（仍然一行）', () => {
	const dir = workspace()
	mkdirSync(join(dir, '.ops'), { recursive: true })
	writeFileSync(
		join(dir, '.ops/handoff.json'),
		JSON.stringify({
			version: 2,
			seq: 1,
			at: '2026-11-05T05:55:00.000Z',
			sessionId: 'session-old',
			tasks: [{ id: 'task-1', subject: '旧任务', status: 'completed', owner: 'fe-dev' }],
			roles: ['fe-dev'],
			checkpoints: { count: 0, dir: join(dir, 'docs', 'team', 'checkpoints'), missingForCompleted: ['task-1'] },
		}),
	)
	const result = spawnSync(process.execPath, [join(ROOT, 'lib', 'ledger-digest.js'), '--workspace', dir, '--text'], { encoding: 'utf8' })
	assert.equal(result.status, 0)
	const lines = result.stdout.trim().split('\n')
	assert.equal(lines.length, 1, '摘要必须一行：' + result.stdout)
	assert.match(result.stdout, /缺检查点：task-1 已完成/)
})

// ── 检查点追加：日常写是"接着写"，不是把整份读出来重写 ────────────────────────

test('追加：既有内容原样保留，标题只写一次、各节按序累积（空文件也补标题）', async () => {
	const dir = workspace()
	const path = structuredPathOf(dir, 'task-3')
	await appendStructured(dir, 'task-3', { role: 'fe-dev', summary: '第一节' })
	for (let index = 2; index <= 8; index += 1) {
		await appendStructured(dir, 'task-3', { role: 'qa', summary: `第 ${index} 节` })
	}
	const text = await readCheckpoint(path)
	assert.equal((text.match(/^# task-3$/gm) ?? []).length, 1, '标题只在首建时写一次')
	assert.ok(text.includes('第一节'), '首节不能丢')
	for (let index = 2; index <= 8; index += 1) assert.ok(text.includes(`第 ${index} 节`), `第 ${index} 节要在`)
	assert.ok(text.indexOf('第一节') < text.indexOf('第 8 节'), '追加不许把新节插到旧节前面')

	// 空文件按"还没有内容"处理：补一次标题（与首建同口径）。
	const empty = structuredPathOf(dir, 'task-4')
	mkdirSync(join(dir, 'docs', 'team', 'checkpoints'), { recursive: true })
	writeFileSync(empty, '', 'utf8')
	await appendStructured(dir, 'task-4', { summary: '空文件那一节' })
	const emptyText = await readCheckpoint(empty)
	assert.equal((emptyText.match(/^# task-4$/gm) ?? []).length, 1)
	assert.match(emptyText, /空文件那一节/)
})
