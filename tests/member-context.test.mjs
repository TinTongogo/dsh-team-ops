#!/usr/bin/env node
/**
 * 成员上下文详情（v2）的**数据面自检**：七类折叠 / 三条对账等式 / 降级链 / 分页排序 /
 * 卡面占用的整形与 task-2 的键修正。
 *
 * 两条边界：
 *   · 折叠算法**只有一份**（`lib/member-context.js`），这里直接调它 —— 不另写一份期望算法；
 *   · 详情端点**只做取事件 + 分页 + 排序 + 组装**，所以这里喂真 `handleMemberContext`，
 *     用假 `sessionQuery` / `tokenMeter` / `sessionProjections` / `agents`。
 *
 * 期望数字是**手算的**（简化估计器见 `price`）：这样"归位错了"会当场红，而不是跟着实现一起漂。
 */
// 测试与用户真实目录隔离（见 tests/isolate.mjs）：必须在读取角色/技能根之前。
import './isolate.mjs'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { digestOfMessage, foldContext, pagedOf, sortedToolsOf, survivingEventOf, survivingSurfaceOf } from '../lib/member-context.js'
import {
	CONTEXT_METER_MISSING,
	MEMBER_CONTEXT_PAGE_SIZE,
	cachedOccupancyOf,
	clipTextOf,
	occupancyOf,
	segmentsOf,
	sessionHeaderMapOf,
	usedTokensOf,
} from '../lib/member-context-routes.js'
import { shapeContextOccupancy } from '../lib/panel-shaping.js'

/**
 * 与宿主 `estimateMessage` **同形的简化估计器**：每块角色 4 token、文本每 4 字符 1 token。
 * 用它，期望值可以手算；条目归位错一位，下面的等式与显式数字就会红。
 */
const price = (message) => {
	if (message === null || message === undefined) return 0
	const content = Array.isArray(message.content) ? message.content : []
	if (content.length === 0) return message.role === 'system' || message.role === 'developer' ? 0 : 4
	let total = 4
	for (const block of content) {
		if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') total += Math.ceil(block.text.length / 4)
	}
	return total
}

const textOf = (chars) => [{ type: 'text', text: chars }]

/** 一条 surface 事件（append）。 */
const surface = (seq, type, data, surfaceOp = 'append') => ({ type, seq, time: 0, data, surfaceOp })

/** 一份小日志：7 类各一条 + 一条旧系统提示 + 一条工具增删通知 + 两个工具调用。 */
function fixtureEvents() {
	const tools = [{ name: 'bash', description: 'run' }]
	const events = [
		// 旧系统提示（被后一条取代 ⇒ 归注入，标「旧系统提示」）。
		surface(1, 'system/message', { message: { role: 'system', content: textOf('AAAA'), source: { kind: 'system-prompt' } } }),
		// 最后一条非空系统提示 ⇒ 归系统。
		surface(2, 'system/message', { message: { role: 'system', content: textOf('BBBBBBBB'), source: { kind: 'system-prompt' } } }),
		// request/header：工具 schema 的唯一来源。
		{ type: 'request/header', seq: 3, time: 0, data: { header: { tools } } },
		// 两个 bash 调用 + 一个 read 调用（调用次数与结果无关）。
		{ type: 'tool/call', seq: 4, time: 0, data: { callId: 'c1', name: 'bash' } },
		{ type: 'tool/call', seq: 5, time: 0, data: { callId: 'c2', name: 'bash' } },
		{ type: 'tool/call', seq: 6, time: 0, data: { callId: 'c3', name: 'read' } },
		surface(7, 'user/message', { role: 'user', content: textOf('CCCC'), source: { kind: 'user' } }),
		surface(8, 'user/message', { role: 'user', content: textOf('DDDD'), source: { kind: 'runtime-context' } }),
		surface(9, 'user/message', { role: 'user', content: textOf('EEEE'), source: { kind: 'skill-catalog' } }),
		surface(10, 'developer/message', { message: { role: 'developer', content: textOf('HHHH'), source: { kind: 'tool-registry' } } }),
		surface(11, 'assistant/message', { message: { role: 'assistant', content: textOf('FFFFFFFF'), source: { kind: 'model' } } }),
		surface(12, 'tool/result', { message: { role: 'tool', toolCallId: 'c1', content: textOf('GGGG'), source: { kind: 'tool' } } }),
	]
	return { events, tools }
}

const TOOLS_TOKENS = (tools) => Math.ceil(JSON.stringify(tools).length / 4) + 4

test('foldContext：七类归位与三项合计（期望数字手算）', () => {
	const { events, tools } = fixtureEvents()
	const folded = foldContext(events, { estimateMessage: price })
	// 系统 = 最后一条非空 system（BBBBBBBB = 2 + 4）；旧系统提示 AAAA（1 + 4）归注入。
	// 注入 = 旧系统 5 + runtime-context 5 + developer 5 = 15；用户 5；技能 5；助手 6；工具结果 5。
	assert.deepEqual(folded.categories, {
		system: 6,
		tools: TOOLS_TOKENS(tools),
		user: 5,
		inject: 15,
		skill: 5,
		assistant: 6,
		tool: 5,
	})
	assert.deepEqual(folded.counts, { system: 1, tools: 1, user: 1, inject: 3, skill: 1, assistant: 1, tool: 1 })
	// ①.5 的第三条等式：其余五类之和 = 宿主 messageTokens；这里逐值钉死。
	assert.equal(
		folded.categories.user + folded.categories.inject + folded.categories.skill + folded.categories.assistant + folded.categories.tool,
		36,
		'messageTokens 这一桶 = 5 + 15 + 5 + 6 + 5',
	)
	// 逐工具：schema 单价 + 调用次数（bash 2 次、read 1 次）。
	assert.deepEqual(folded.tools, [{ name: 'bash', tokens: Math.ceil(JSON.stringify(tools[0]).length / 4), calls: 2 }])
	assert.equal(folded.asOfSeq, 12)
})

test('foldContext：注入项带 kind 标签与「旧系统提示 / 工具增删通知」标记，且未知 kind 不丢', () => {
	const { events } = fixtureEvents()
	events.push(surface(13, 'user/message', { role: 'user', content: textOf('IIII'), source: { kind: 'brand-new-producer' } }))
	const folded = foldContext(events, { estimateMessage: price })
	const markers = folded.items.inject.map((item) => item.marker ?? '')
	assert.ok(markers.includes('旧系统提示'), '更早的系统提示要标出来：' + JSON.stringify(markers))
	assert.ok(markers.includes('工具增删通知'), 'developer/message 要标成工具增删通知：' + JSON.stringify(markers))
	const unknown = folded.items.inject.find((item) => item.kind === 'brand-new-producer')
	assert.ok(unknown !== undefined, '未知 source.kind 归注入、不丢（MessageSourceMap 是合并可扩展类型）')
})

test('foldContext：非 append 的 replace 先摘旧节点、再把 replace 事件自己入表', () => {
	const events = [
		surface(1, 'user/message', { role: 'user', content: textOf('AAAA'), source: { kind: 'user' } }),
		surface(2, 'user/message', { role: 'user', content: textOf('BBBB'), source: { kind: 'user' } }),
		// 压缩：把 seq 1–2 换成一条摘要（8 字符 = 2 + 4）。
		surface(3, 'user/message', { role: 'user', content: textOf('CCCCCCCC'), source: { kind: 'user' } }, { op: 'replace', startSeq: 1, endSeq: 2 }),
	]
	const folded = foldContext(events, { estimateMessage: price })
	assert.deepEqual(folded.categories, { system: 0, tools: 0, user: 6, inject: 0, skill: 0, assistant: 0, tool: 0 })
	assert.equal(folded.counts.user, 1, '被取代的两条要摘掉，只剩摘要那一条')
	assert.deepEqual(folded.items.user.map((item) => item.seq), [3])
})

test('foldContext：没有 estimateMessage 直接抛，不静默返回全零', () => {
	assert.throws(() => foldContext([], {}), /estimateMessage/)
	assert.throws(() => foldContext(null, { estimateMessage: price }), /events/)
})

test('sortedToolsOf / pagedOf：三档排序互斥、分页只切片而合计不变', () => {
	const tools = [
		{ name: 'bash', tokens: 570, calls: 172 },
		{ name: 'board_task', tokens: 947, calls: 7 },
		{ name: 'read', tokens: 100, calls: 20 },
	]
	assert.deepEqual(sortedToolsOf(tools, 'size').map((tool) => tool.name), ['board_task', 'bash', 'read'])
	assert.deepEqual(sortedToolsOf(tools, 'count').map((tool) => tool.name), ['bash', 'read', 'board_task'])
	assert.deepEqual(sortedToolsOf(tools, 'name').map((tool) => tool.name), ['bash', 'board_task', 'read'])
	const items = Array.from({ length: 60 }, (_, index) => ({ seq: index }))
	const first = pagedOf(items, 1, 50)
	assert.equal(first.items.length, 50)
	assert.equal(first.shown, 50)
	assert.equal(first.total, 60, '合计始终是全量')
	assert.equal(first.hasMore, true)
	const all = pagedOf(items, 0, 50)
	assert.equal(all.items.length, 60, 'page=0 / 不带 page ⇒ 全量（面板一次读全，前端自己切片）')
})

// ── 卡面占用：occupancyOf 的六态与整形 ─────────────────────────────────────────

function projectionServices(overrides = {}) {
	return {
		tokenMeter: { estimateMessage: price },
		sessionProjections: {
			snapshot: () =>
				overrides.snapshot === undefined
					? {
							asOfSeq: 42,
							values: {
								contextPressure: { pressureTokens: 100, contextWindow: 1000 },
								contextBreakdown: { systemTokens: 10, toolsTokens: 20, messageTokens: 30 },
							},
						}
					: overrides.snapshot(),
		},
	}
}

const ctxOf = (services) => ({ get: (name) => services[name] })

test('occupancyOf：服务缺 / 不在场 / 没请求 / 容量未知 / 正常 / 抛错 六态', () => {
	const agent = { id: 'child-1', session: { id: 'child-1' } }
	// 服务缺：卡面整行不画（no-service + C7 文案）。
	const noService = occupancyOf(ctxOf({}), agent)
	assert.equal(noService.state, 'no-service')
	assert.equal(noService.reason, CONTEXT_METER_MISSING)
	// 不在场：没有活着的会话。
	const absent = occupancyOf(ctxOf(projectionServices()), null)
	assert.equal(absent.state, 'absent')
	assert.equal(absent.available, false)
	// 还没跑过请求：两个已用口径都缺。
	const services = projectionServices({
		snapshot: () => ({ asOfSeq: 3, values: { contextPressure: {}, contextBreakdown: { systemTokens: 10, toolsTokens: 20, messageTokens: 30 } } }),
	})
	assert.equal(occupancyOf(ctxOf(services), agent).state, 'no-request')
	// 有用量、容量未知。
	const noWindow = projectionServices({
		snapshot: () => ({ asOfSeq: 3, values: { contextPressure: { pressureTokens: 100 }, contextBreakdown: {} } }),
	})
	assert.equal(occupancyOf(ctxOf(noWindow), agent).state, 'no-window')
	// 正常：三段 + 已用 + 容量。
	const ready = occupancyOf(ctxOf(projectionServices()), agent)
	assert.equal(ready.state, 'ready')
	assert.equal(ready.available, true)
	assert.equal(usedTokensOf(ready), 100)
	assert.deepEqual(segmentsOf(ready), { system: 10, tools: 20, messages: 30 })
	// 抛错：原因原样给。
	const threw = projectionServices({
		snapshot: () => {
			throw new Error('projection boom')
		},
	})
	const errored = occupancyOf(ctxOf(threw), agent)
	assert.equal(errored.state, 'error')
	assert.match(errored.reason, /projection boom/)
})

test('shapeContextOccupancy：只留标量叶子、缺省 null（不放行任意嵌套结构）', () => {
	const shaped = shapeContextOccupancy({
		state: 'ready',
		available: true,
		reason: null,
		source: 'cache',
		ended: true,
		projectedTokens: 42,
		contextWindow: 'not-a-number',
		systemTokens: 1,
		toolsTokens: 2,
		messageTokens: 3,
		nested: { evil: true },
	})
	assert.equal(shaped.projectedTokens, 42)
	assert.equal(shaped.contextWindow, null, '非有限数读作 null')
	assert.equal(shaped.source, 'cache', 'source 必须走到客户端（卡片据它标「（末次）」）')
	assert.equal(shaped.ended, true)
	assert.equal(shaped.nested, undefined, '没有点名的字段不许透出')
	// 缺 source / ended 的老载荷：不发明，给 null。
	const old = shapeContextOccupancy({ state: 'ready', projectedTokens: 1 })
	assert.equal(old.source, null)
	assert.equal(old.ended, null)
	assert.equal(shapeContextOccupancy(undefined), null)
})

// ── 详情端点：真 handler + 假服务 ─────────────────────────────────────────────

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
		async readText() {
			return ''
		},
	}
}

function freshWorkspace() {
	const workspace = mkdtempSync(join(tmpdir(), 'team-ops-ctx-'))
	mkdirSync(join(workspace, '.ops'), { recursive: true })
	return workspace
}

/** 调详情端点：捕状态与 JSON。 */
async function callContext(ctx, url, fallback = null) {
	const host = await import('../lib/board-view.host.js')
	const captured = { status: 0, body: '' }
	const res = {
		writeHead(status) {
			captured.status = status
		},
		end(body) {
			captured.body = body
		},
	}
	await host.handleMemberContext(ctx, { method: 'GET', url }, res, fallback)
	return { status: captured.status, payload: JSON.parse(captured.body) }
}

function contextCtx({ workspace, events, agent = { id: 'child-1', session: { id: 'child-1' } }, services = {}, observe, withMeter = true, inheritedEventCount = 0, source = 'live', projections = null, lastTime = 1795659233364 } = {}) {
	const calls = { disposed: 0, observed: [] }
	const svc = { ...services }
	svc.agents = svc.agents ?? { get: (id) => (id === 'child-1' ? agent : undefined) }
	if (!withMeter) delete svc.tokenMeter
	else svc.tokenMeter = svc.tokenMeter ?? { estimateMessage: price }
	svc.sessionProjections = svc.sessionProjections ?? projectionServices().sessionProjections
	if (observe !== false) {
		svc.sessionQuery = {
			observeSession: async (id, options) => {
				calls.observed.push({ id, options })
				if (observe !== undefined) return observe(id, options)
				return {
					source,
					cursor: 42,
					inheritedEventCount,
					events,
					...(projections === null ? {} : { projections }),
					[Symbol.dispose]: () => {
						calls.disposed += 1
					},
				}
			},
		}
	}
	const base = {
		fs: makeFs(),
		logger: { warn() {} },
		get: (name) => svc[name],
	}
	return { ctx: base, calls, workspace }
}

test('详情端点：L0 七类 + 三段（期望值是手算的，不拿 foldContext 反填）+ 租约用完释放', async () => {
	const workspace = freshWorkspace()
	const { events, tools } = fixtureEvents()
	// 宿主投影三段：写死的现场读数（同一份 fixture 可手算：system 6 / tools 见公式 / 其余 36）。
	// **不**在这里用 foldContext 算一遍去填期望值 —— 那会让等式恒成立（qa 打回项 A14）。
	const TOOLS = TOOLS_TOKENS(tools)
	const projection = {
		snapshot: () => ({
			asOfSeq: 42,
			values: {
				contextPressure: { pressureTokens: 442368, contextWindow: 1048576 },
				contextBreakdown: { systemTokens: 6, toolsTokens: TOOLS, messageTokens: 36 },
			},
		}),
	}
	const { ctx, calls } = contextCtx({ workspace, events, services: { sessionProjections: projection }, inheritedEventCount: 0 })
	const { status, payload } = await callContext(ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&session=sess-1&member=child-1', workspace)
	assert.equal(status, 200, JSON.stringify(payload))
	assert.equal(payload.ok, true)
	assert.equal(payload.state, 'ready')
	assert.equal(payload.source, 'live')
	assert.equal(payload.asOfSeq, 42)
	// 七类：手算的期望（同 `foldContext：七类归位` 那条的字面量）。
	assert.deepEqual(payload.categories, { system: 6, tools: TOOLS, user: 5, inject: 15, skill: 5, assistant: 6, tool: 5 })
	// 三条等式（v2.1）：这份 fixture 没有压缩 ⇒ Δ=0，退化为无条件相等。
	assert.equal(payload.reconcile.delta, 0, '无压缩 ⇒ Δ=0')
	assert.deepEqual(payload.reconcile.claims, [])
	assert.deepEqual(payload.reconcile.unclaimed, [])
	assert.equal(payload.categories.system, 6, '① system = 宿主 systemTokens')
	assert.equal(payload.categories.tools, TOOLS, '② tools = 宿主 toolsTokens')
	assert.equal(
		payload.categories.user + payload.categories.inject + payload.categories.skill + payload.categories.assistant + payload.categories.tool,
		36,
		'③ messages = 宿主 messageTokens + Δ（Δ=0）',
	)
	assert.deepEqual(payload.segments, { system: 6, tools: TOOLS, messages: 36 })
	assert.equal(payload.inheritedEventCount, 0, '没有继承前缀 ⇒ 0（页面不画 P13）')
	assert.equal(calls.disposed, 1, '读完必须释放租约（Symbol.dispose）')
	assert.equal(calls.observed[0].options.projectionMode, 'none', '只折事件、不算投影（省一次折叠）')
	assert.deepEqual(payload.items.user.map((item) => item.seq), [7], '只回 user 那一类，注入/技能不混进来')
})

test('详情端点：reconcile 与 categories 来自**同一次**租约（不另开一次 O(事件数)）', async () => {
	const workspace = freshWorkspace()
	// 一条 compaction/prune → 匹配 replace 的链路：期望 Δ = 5 − 5 = 0，但 claims 要逐项在载荷里。
	const events = [
		surface(1, 'user/message', { role: 'user', content: textOf('AAAA'), source: { kind: 'user' } }),
		{ type: 'compaction/prune', seq: 2, time: 0, data: { shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 5 } },
		surface(3, 'user/message', { role: 'user', content: textOf('CCCCCCCC'), source: { kind: 'user' } }, { op: 'replace', startSeq: 1, endSeq: 1 }),
	]
	const { ctx, calls } = contextCtx({ workspace, events })
	const { payload } = await callContext(ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1')
	assert.equal(calls.observed.length, 1, '对账不许再开一次租约')
	assert.deepEqual(payload.reconcile, {
		delta: 0,
		claims: [{ claimSeq: 2, replaceSeq: 3, claimTokens: 5, removedTokens: 5, shadowedSeqsOutsideRange: 0 }],
		unclaimed: [],
	})
	assert.equal(payload.asOfSeq, 42, '对账与七类共用同一个 lease.cursor')
})

test('详情端点：非 ready 态的 reconcile 为 null（等式只在 ready 判）', async () => {
	const workspace = freshWorkspace()
	const noMeter = contextCtx({ workspace, events: [], withMeter: false })
	const l2 = await callContext(noMeter.ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1')
	assert.equal(l2.payload.state, 'l2')
	assert.equal(l2.payload.reconcile, null)
})

test('详情端点：fork 成员的 inheritedEventCount 原样回传（P13 的判据）', async () => {
	const workspace = freshWorkspace()
	const { events } = fixtureEvents()
	const { ctx } = contextCtx({ workspace, events, inheritedEventCount: 3 })
	const { payload } = await callContext(ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1')
	assert.equal(payload.inheritedEventCount, 3)
})
test('详情端点：排序在服务端（sort=count / name），分页只切片且合计是全量', async () => {
	const workspace = freshWorkspace()
	const { events } = fixtureEvents()
	const { ctx } = contextCtx({ workspace, events })
	const base = '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1'
	const bySize = await callContext(ctx, base + '&sort=size')
	assert.deepEqual(bySize.payload.tools.map((tool) => tool.name), ['bash'])
	const byCount = await callContext(ctx, base + '&sort=count')
	assert.equal(byCount.payload.sort, 'count')
	assert.deepEqual(byCount.payload.totals.tools, 1)
	// 非法排序回落 size（不报错、不猜别的键）。
	const bogus = await callContext(ctx, base + '&sort=whatever')
	assert.equal(bogus.payload.sort, 'size')
	// page=1 与不带 page：这份载荷都不到 50 条，行为一致；`hasMore` 明说还有没有下一页。
	assert.equal(bogus.payload.page.pageSize, MEMBER_CONTEXT_PAGE_SIZE)
	assert.equal(bogus.payload.page.hasMore, false)
})

test('详情端点：L2（tokenMeter 缺）/ L3（没有活着的会话）/ 参数与方法的拒绝', async () => {
	const workspace = freshWorkspace()
	const { events } = fixtureEvents()
	// L2：没有 tokenMeter。
	const noMeter = contextCtx({ workspace, events, withMeter: false })
	const l2 = await callContext(noMeter.ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1')
	assert.equal(l2.status, 200)
	assert.equal(l2.payload.state, 'l2')
	assert.equal(l2.payload.reason, CONTEXT_METER_MISSING)
	// L3：agents.get 空（成员会话结束）**且** prepared 冷读也读不到（notFound / 损坏 / abort）。
	// 缺席成员现在会先走 observeSession 的 prepared 分支（A19）；这里让租约抛错才是 L3。
	const gone = contextCtx({
		workspace,
		events,
		agent: null,
		observe: () => {
			const error = new Error('session query: session "child-1" was not found')
			error.code = 'SESSION_QUERY_NOT_FOUND'
			throw error
		},
	})
	const l3 = await callContext(gone.ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1')
	assert.equal(l3.status, 200)
	assert.equal(l3.payload.state, 'l3')
	assert.equal(l3.payload.ended, true)
	assert.match(l3.payload.reason, /not found/, '原因原文（notFound/CORRUPT/abort）')
	// 没带 member ⇒ 400（不许猜"当前会话"）。
	const noMember = await callContext(gone.ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace))
	assert.equal(noMember.status, 400)
	// 写方法 ⇒ 405。
	const host = await import('../lib/board-view.host.js')
	const captured = { status: 0, body: '' }
	await host.handleMemberContext(gone.ctx, { method: 'POST', url: '/company-board/api/member-context?member=child-1' }, { writeHead: (s) => (captured.status = s), end: (b) => (captured.body = b) }, null)
	assert.equal(captured.status, 405)
})

test('详情端点：L1（租约失败、投影仍可读）只给三段；两样都缺时 L2', async () => {
	const workspace = freshWorkspace()
	const { ctx } = contextCtx({
		workspace,
		events: [],
		observe: () => {
			throw new Error('lease boom')
		},
	})
	const l1 = await callContext(ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1')
	assert.equal(l1.status, 200)
	assert.equal(l1.payload.state, 'l1')
	assert.match(l1.payload.reason, /lease boom/)
	assert.deepEqual(l1.payload.segments, { system: 10, tools: 20, messages: 30 })
	// 投影也读不到（snapshot 抛）⇒ L2。
	const broken = projectionServices({
		snapshot: () => {
			throw new Error('projection boom')
		},
	})
	const { ctx: noProjection } = contextCtx({ workspace, events: [], services: { sessionProjections: broken.sessionProjections }, observe: () => { throw new Error('lease boom') } })
	const l2 = await callContext(noProjection, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1')
	assert.equal(l2.payload.state, 'l2')
})

test('端点常量：client 侧的 MEMBER_CONTEXT_ENDPOINT 与 host 的 MEMBER_CONTEXT_PATH 逐字一致', async () => {
	const host = await import('../lib/board-view.host.js')
	const client = readFileSync('lib/board-view.client.js', 'utf8')
	assert.ok(client.includes("API_PREFIX + '/member-context'"), '客户端要声明同一个路径')
	assert.equal(host.MEMBER_CONTEXT_PATH, host.ROUTE_PATH + '/member-context')
	assert.ok(host.routeTable().has(host.MEMBER_CONTEXT_PATH), '新端点必须登记进 routeTable（否则 404）')
})


// ── task-2：成员行的键是 `id`；实时状态与上下文占用共用同一次 `agents.get` ─────────

test('卡面占用：成员行的键是 id（task-2）+ 实时状态覆盖 + 与详情页共用同一处 occupancyOf', async () => {
	const workspace = freshWorkspace()
	const childSession = { id: 'child-1' }
	const calls = { get: [], snapshot: 0 }
	const services = {
		tokenMeter: { estimateMessage: price },
		sessionProjections: {
			snapshot: () => {
				calls.snapshot += 1
				return {
					asOfSeq: 7,
					values: {
						contextPressure: { pressureTokens: 442368, projectedTokens: 442368, contextWindow: 1048576 },
						contextBreakdown: { systemTokens: 3005, toolsTokens: 14970, messageTokens: 277365 },
					},
				}
			},
		},
		agentTeams: {
			listMembers: () => [
				{ id: 'root-1', name: 'lead', role: 'lead', status: 'running' },
				// **盘上的值是 inactive**；活着的 Agent 说 running ⇒ 实时读数要覆盖它（task-2 的修法之一）。
				{ id: 'child-1', name: 'qa-1', role: 'teammate', status: 'inactive' },
			],
		},
		agents: {
			get: (id) => {
				calls.get.push(id)
				if (id === 'root-1') return { id: 'root-1', status: 'running' }
				if (id === 'child-1') return { id: 'child-1', status: 'running', session: childSession }
				return undefined
			},
		},
	}
	const host = await import('../lib/board-view.host.js')
	const captured = { status: 0, body: '' }
	const res = {
		writeHead(status) {
			captured.status = status
		},
		end(body) {
			captured.body = body
		},
	}
	const ctx = { fs: makeFs(), logger: { warn() {} }, get: (name) => services[name] }
	await host.handleMembers(ctx, { method: 'GET', url: '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=root-1' }, res, workspace)
	assert.equal(captured.status, 200, captured.body)
	const payload = JSON.parse(captured.body)
	const child = payload.merged.find((row) => row.name === 'qa-1')
	assert.ok(child !== undefined, '名册里要有 qa-1：' + JSON.stringify(payload.merged))
	// task-2：`runtimeReadings` 用 `row.id` 取到活着的 Agent ⇒ 运行时状态被实时读数覆盖。
	assert.equal(child.runtime, 'running', '活着的 Agent 说 running ⇒ 覆盖盘上的 inactive')
	// 同一次 `agents.get` 顺路把卡面占用算出来（不再为卡与详情各查一遍）。
	assert.equal(calls.get.filter((id) => id === 'child-1').length, 1, 'child-1 只查一次 agents.get')
	assert.equal(child.contextOccupancy.state, 'ready')
	assert.equal(child.contextOccupancy.projectedTokens, 442368)
	assert.equal(child.contextOccupancy.systemTokens, 3005)
	assert.equal(payload.warnings.some((line) => line.includes('token-meter')), false, '服务在场时不许报 C7')
})

// ── 已结束成员：持久投影缓存（003 v2.5 §1.16；A34–A37）─────────────────────────

/** 一份投影快照（卡片缓存与详情页租约投影共用同一份 ⇒ 同一切口、同一结果）。 */
const CACHE_SNAPSHOT = {
	asOfSeq: 42,
	values: {
		contextPressure: { pressureTokens: 442368, projectedTokens: 442368, contextWindow: 1048576 },
		contextBreakdown: { systemTokens: 3005, toolsTokens: 14970, messageTokens: 277365 },
	},
}

/** 会话表头（`sessionQuery.listSessions()` 给的那一份；生命周期身份 = cachedSnapshot 的入参）。 */
const headerOf = (id) => ({ id, version: 4, createdAt: 1795659233364, cwd: '/w', isSeeded: false })

/** 调 `/members`：捕状态与 JSON（与端点自检同一个入参形状）。 */
async function callMembers(ctx, workspace, session = 'root-1') {
	const host = await import('../lib/board-view.host.js')
	const captured = { status: 0, body: '' }
	const res = {
		writeHead(status) {
			captured.status = status
		},
		end(body) {
			captured.body = body
		},
	}
	await host.handleMembers(ctx, { method: 'GET', url: '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=' + encodeURIComponent(session) }, res, workspace)
	return { status: captured.status, payload: JSON.parse(captured.body) }
}

/**
 * 卡面缓存路径的假宿主：`agents` 里只有协调者活着，队友都已结束；
 * `sessionQuery.listSessions()` 给表头，`sessionProjectionCache.cachedSnapshot()` 给缓存切口。
 */
function cacheCtx({ workspace, members, headers, snapshotOf, roster = null, events = [] }) {
	const calls = { list: 0, observe: 0, cache: [], snapshot: 0, get: [] }
	const services = {
		tokenMeter: { estimateMessage: price },
		sessionProjections: {
			snapshot: () => {
				calls.snapshot += 1
				return CACHE_SNAPSHOT
			},
		},
		agents: {
			get: (id) => {
				calls.get.push(id)
				return id === 'root-1' ? { id: 'root-1', status: 'running' } : undefined
			},
		},
		agentTeams: {
			listMembers: () => roster ?? [{ id: 'root-1', name: 'lead', role: 'lead', status: 'running' }, ...members],
		},
		sessionProjectionCache: {
			cachedSnapshot: (meta, keys) => {
				calls.cache.push({ meta, keys })
				return snapshotOf === undefined ? CACHE_SNAPSHOT : snapshotOf(meta, keys)
			},
		},
		sessionQuery: {
			listSessions: async () => {
				calls.list += 1
				return [...headers].map((header) => ({ header, live: false, persisted: true }))
			},
			observeSession: async () => {
				calls.observe += 1
				return {
					source: 'prepared',
					cursor: CACHE_SNAPSHOT.asOfSeq,
					inheritedEventCount: 0,
					events,
					projections: CACHE_SNAPSHOT,
					[Symbol.dispose]: () => {},
				}
			},
		},
	}
	return { ctx: { fs: makeFs(), logger: { warn() {} }, get: (name) => services[name] }, calls }
}

test('cachedOccupancyOf：命中 ⇒ source=cache / ended=true；miss / 服务缺 / 抛错一律回落（不补 0、不冷读）', () => {
	const header = headerOf('child-1')
	const hit = cachedOccupancyOf(
		ctxOf({
			tokenMeter: { estimateMessage: price },
			sessionProjections: projectionServices().sessionProjections,
			sessionProjectionCache: {
				cachedSnapshot: (meta, keys) => {
					assert.equal(meta, header, '表头原样交给宿主做生命周期身份对账')
					assert.deepEqual(keys, ['contextPressure', 'contextBreakdown'], '只要这两把钥匙')
					return CACHE_SNAPSHOT
				},
			},
		}),
		header,
	)
	assert.equal(hit.state, 'ready')
	assert.equal(hit.available, true)
	assert.equal(hit.source, 'cache')
	assert.equal(hit.ended, true)
	assert.equal(hit.asOfSeq, 42)
	assert.equal(hit.projectedTokens, 442368)
	assert.equal(hit.contextWindow, 1048576)
	assert.equal(hit.systemTokens, 3005)
	assert.equal(usedTokensOf(hit), 442368)
	// 缓存 miss（记录缺失 / 格式版本对不上 ⇒ 宿主回 undefined）⇒ 当作没有：`absent`，卡面回落 P19。
	const miss = cachedOccupancyOf(
		ctxOf({
			tokenMeter: { estimateMessage: price },
			sessionProjections: projectionServices().sessionProjections,
			sessionProjectionCache: { cachedSnapshot: () => undefined },
		}),
		header,
	)
	assert.equal(miss.state, 'absent')
	assert.equal(miss.available, false)
	assert.equal(miss.source, undefined, '没命中就不许标成 cache')
	// 缺 contextBreakdown（只有半份投影）⇒ 同样当作没有（不拿半个读数冒充）。
	const half = cachedOccupancyOf(
		ctxOf({
			tokenMeter: { estimateMessage: price },
			sessionProjections: projectionServices().sessionProjections,
			sessionProjectionCache: { cachedSnapshot: () => ({ asOfSeq: 42, values: { contextPressure: { pressureTokens: 1 } } }) },
		}),
		header,
	)
	assert.equal(half.state, 'absent')
	// 缓存服务缺（老部署）⇒ 回落 P19，不报错整块。
	const noCache = cachedOccupancyOf(ctxOf({ tokenMeter: { estimateMessage: price }, sessionProjections: projectionServices().sessionProjections }), header)
	assert.equal(noCache.state, 'absent')
	// 缓存读抛错 ⇒ fail-soft（A36：卡面不显示 0%、不让整块报错）。
	const threw = cachedOccupancyOf(
		ctxOf({
			tokenMeter: { estimateMessage: price },
			sessionProjections: projectionServices().sessionProjections,
			sessionProjectionCache: {
				cachedSnapshot: () => {
					throw new Error('cache boom')
				},
			},
		}),
		header,
	)
	assert.equal(threw.state, 'absent')
	assert.equal(threw.available, false)
	// tokenMeter 缺 ⇒ 与活会话同一档 `no-service`（卡面整行不画 + C7），不是"已结束"。
	const noMeter = cachedOccupancyOf(ctxOf({ sessionProjections: projectionServices().sessionProjections, sessionProjectionCache: { cachedSnapshot: () => CACHE_SNAPSHOT } }), header)
	assert.equal(noMeter.state, 'no-service')
	assert.equal(noMeter.reason, CONTEXT_METER_MISSING)
})

test('sessionHeaderMapOf：一次 listSessions 换成 id → 表头；服务缺 / 抛错回 null（调用方回落 P19）', async () => {
	const headers = [headerOf('child-1'), headerOf('child-2')]
	const map = await sessionHeaderMapOf(ctxOf({ sessionQuery: { listSessions: async () => headers.map((header) => ({ header, live: false })) } }))
	assert.ok(map instanceof Map)
	assert.equal(map.get('child-1'), headers[0])
	assert.equal(map.get('child-2'), headers[1])
	assert.equal(await sessionHeaderMapOf(ctxOf({})), null, '没有 session-query ⇒ 没有表头')
	assert.equal(
		await sessionHeaderMapOf(
			ctxOf({
				sessionQuery: {
					listSessions: async () => {
						throw new Error('list boom')
					},
				},
			}),
		),
		null,
		'读不到 ⇒ null（不许把"读不到"当成"没有已结束成员"）',
	)
})

test('A34：卡片缓存读数与详情页读数**同一份**（同 asOfSeq ⇒ 逐值相同；详情页不得更旧）', async () => {
	const workspace = freshWorkspace()
	const header = headerOf('child-1')
	const { ctx, calls } = cacheCtx({ workspace, members: [{ id: 'child-1', name: 'qa-1', role: 'teammate', status: 'inactive' }], headers: [headerOf('root-1'), header] })
	const members = await callMembers(ctx, workspace)
	assert.equal(members.status, 200, members.payload.error)
	const cardOcc = members.payload.merged.find((row) => row.name === 'qa-1').contextOccupancy
	// 卡片这一侧：来自缓存切口，不是冷读。
	assert.equal(cardOcc.source, 'cache', '卡面读的是持久投影缓存')
	assert.equal(cardOcc.ended, true)
	assert.equal(cardOcc.state, 'ready')
	assert.equal(calls.observe, 0, '首屏一次 observeSession 都不许有（A35）')
	assert.equal(calls.cache.length, 1, '一位已结束成员查一次缓存')
	assert.equal(calls.cache[0].meta, header, '表头来自 listSessions（生命周期身份的唯一见证）')

	// 详情页这一侧：同一次切口（prepared 租约投影）。
	const { ctx: detailCtx } = (() => {
		const svc = {
			tokenMeter: { estimateMessage: price },
			sessionProjections: projectionServices().sessionProjections,
			agents: { get: () => undefined },
			sessionQuery: {
				observeSession: async () => ({
					source: 'prepared',
					cursor: CACHE_SNAPSHOT.asOfSeq,
					inheritedEventCount: 0,
					events: [],
					projections: CACHE_SNAPSHOT,
					[Symbol.dispose]: () => {},
				}),
			},
		}
		return { ctx: { fs: makeFs(), logger: { warn() {} }, get: (name) => svc[name] } }
	})()
	const detail = await callContext(detailCtx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1')
	assert.equal(detail.payload.ended, true)
	assert.equal(detail.payload.state, 'ready')
	assert.equal(detail.payload.occupancy.asOfSeq, cardOcc.asOfSeq, '两边 asOfSeq 相等（A34 的前提）')
	// 相等 ⇒ 数值逐值相同（同一投影、同一切口）。
	assert.deepEqual(
		{
			pressureTokens: detail.payload.occupancy.pressureTokens,
			projectedTokens: detail.payload.occupancy.projectedTokens,
			contextWindow: detail.payload.occupancy.contextWindow,
			systemTokens: detail.payload.occupancy.systemTokens,
			toolsTokens: detail.payload.occupancy.toolsTokens,
			messageTokens: detail.payload.occupancy.messageTokens,
			asOfSeq: detail.payload.occupancy.asOfSeq,
		},
		{
			pressureTokens: cardOcc.pressureTokens,
			projectedTokens: cardOcc.projectedTokens,
			contextWindow: cardOcc.contextWindow,
			systemTokens: cardOcc.systemTokens,
			toolsTokens: cardOcc.toolsTokens,
			messageTokens: cardOcc.messageTokens,
			asOfSeq: cardOcc.asOfSeq,
		},
		'同一份读数：同 asOfSeq 必须逐值相同',
	)
	// 百分比也同一条算式（卡面客户端与服务端共用口径）。
	const pct = (occ) => Math.min(100, Math.round(((occ.projectedTokens ?? occ.pressureTokens) / occ.contextWindow) * 100))
	assert.equal(pct(cardOcc), pct(detail.payload.occupancy), '两边百分比一致')
})

test('A35：24 位已结束成员首屏 —— 1 次 listSessions + 24 次内存查表，0 次冷读（observeSession / 日志投影读）', async () => {
	const workspace = freshWorkspace()
	const members = Array.from({ length: 24 }, (_, index) => ({ id: 'm' + index, name: 'qa-' + index, role: 'teammate', status: 'inactive' }))
	const headers = [headerOf('root-1'), ...members.map((row) => headerOf(row.id))]
	const { ctx, calls } = cacheCtx({ workspace, members, headers })
	const { status, payload } = await callMembers(ctx, workspace)
	assert.equal(status, 200, payload.error)
	assert.equal(payload.merged.length, 25, '协调者 + 24 位已结束成员')
	const ended = payload.merged.filter((row) => row.name !== 'lead')
	assert.equal(ended.length, 24)
	for (const row of ended) {
		assert.equal(row.contextOccupancy.source, 'cache', row.name + ' 必须走缓存')
		assert.equal(row.contextOccupancy.state, 'ready')
		assert.equal(row.contextOccupancy.projectedTokens, 442368)
	}
	assert.equal(calls.list, 1, '表头只取一次（全部行共用）')
	assert.equal(calls.cache.length, 24, '每位已结束成员查一次内存表')
	assert.equal(calls.observe, 0, 'A35：首屏零冷读（不许有 observeSession / prepared 装载）')
	assert.equal(calls.snapshot, 0, 'A35：活会话的投影读也不该被已结束成员触发')
	assert.ok(calls.get.filter((id) => id !== 'root-1').length === 24, '每位成员一次 agents.get（实时状态与占用共用）')
})

test('A36：缓存 miss ⇒ 卡片那一格回落 P19（absent，不显示 0%、不报错整块）', async () => {
	const workspace = freshWorkspace()
	const header = headerOf('child-1')
	const { ctx, calls } = cacheCtx({
		workspace,
		members: [{ id: 'child-1', name: 'qa-1', role: 'teammate', status: 'inactive' }],
		headers: [headerOf('root-1'), header],
		snapshotOf: () => undefined,
	})
	const { status, payload } = await callMembers(ctx, workspace)
	assert.equal(status, 200, payload.error)
	assert.equal(payload.ok, true, '单行 miss 不许把整块成员表带塌')
	const row = payload.merged.find((item) => item.name === 'qa-1')
	assert.equal(row.contextOccupancy.available, false)
	assert.equal(row.contextOccupancy.state, 'absent')
	assert.equal(row.contextOccupancy.projectedTokens, null, '读不到不是 0')
	assert.equal(row.contextOccupancy.source, null)
	assert.equal(calls.observe, 0, 'miss 也不许改成冷读')
})

test('A37：只读 —— 不新增顶格字段、两次请求读数逐值不变', async () => {
	const workspace = freshWorkspace()
	const header = headerOf('child-1')
	const { ctx, calls } = cacheCtx({ workspace, members: [{ id: 'child-1', name: 'qa-1', role: 'teammate', status: 'inactive' }], headers: [headerOf('root-1'), header] })
	const first = await callMembers(ctx, workspace)
	const second = await callMembers(ctx, workspace)
	assert.equal(first.status, 200)
	// `/members` 顶格字段集合不变（新信息只进 `contextOccupancy` 内）。
	assert.deepEqual(
		Object.keys(first.payload).sort(),
		['ok', 'workspace', 'workspaceSource', 'counts', 'memberFlags', 'skillOptions', 'team', 'merged', 'defaults', 'warnings'].sort(),
		'只新增了 contextOccupancy 内的 source / ended，没有顶格字段',
	)
	assert.deepEqual(
		second.payload.merged.find((row) => row.name === 'qa-1').contextOccupancy,
		first.payload.merged.find((row) => row.name === 'qa-1').contextOccupancy,
		'读缓存前后读数逐值不变（只读，不改账）',
	)
	assert.equal(calls.observe, 0)
})

// ── 对账账（v2.1 §1.3 第 6 步）：claim 生命周期与 Δ 的分解 ─────────────────────

test('reconcile：claim 只对紧邻的下一个事件生效；匹配 replace 记 claims，其余记 unclaimed', () => {
	const events = [
		surface(1, 'user/message', { role: 'user', content: textOf('AAAA'), source: { kind: 'user' } }),
		surface(2, 'user/message', { role: 'user', content: textOf('BBBB'), source: { kind: 'user' } }),
		// 武装 claim（5 token）。
		{ type: 'compaction/prune', seq: 3, time: 0, data: { shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 5 } },
		// 紧邻的匹配 replace：摘掉 seq1（现价 5）⇒ Δ += 5 − 5 = 0。
		surface(4, 'user/message', { role: 'user', content: textOf('CCCCCCCC'), source: { kind: 'user' } }, { op: 'replace', startSeq: 1, endSeq: 1 }),
		// 再武装一次，但下一个事件不是 replace ⇒ claim 作废（宿主 `withoutClaim` 同款）。
		{ type: 'compaction/summary', seq: 5, time: 0, data: { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 5 } },
		{ type: 'turn/start', seq: 6, time: 0, data: { turn: 1 } },
		surface(7, 'user/message', { role: 'user', content: textOf('DDDD'), source: { kind: 'user' } }),
		// 未计量的非系统 replace：宿主零增量 ⇒ Δ += 6 − 5 = 1。
		surface(8, 'user/message', { role: 'user', content: textOf('EEEEEEEE'), source: { kind: 'user' } }, { op: 'replace', startSeq: 7, endSeq: 7 }),
	]
	const folded = foldContext(events, { estimateMessage: price })
	assert.equal(folded.reconcile.delta, 1, '1 来自未计量 replace（6 − 5）；作废 claim 不记账')
	assert.deepEqual(folded.reconcile.claims, [
		{ claimSeq: 3, replaceSeq: 4, claimTokens: 5, removedTokens: 5, shadowedSeqsOutsideRange: 0 },
	])
	assert.deepEqual(folded.reconcile.unclaimed, [{ replaceSeq: 8, newTokens: 6, removedTokens: 5 }])
	// ③a：Δ === Σ(claimTokens − removedTokens) + Σ(newTokens − removedTokens)
	const sumClaims = folded.reconcile.claims.reduce((sum, item) => sum + item.claimTokens - item.removedTokens, 0)
	const sumUnclaimed = folded.reconcile.unclaimed.reduce((sum, item) => sum + item.newTokens - item.removedTokens, 0)
	assert.equal(folded.reconcile.delta, sumClaims + sumUnclaimed)
	// 作废的 claim（seq 5）没有被记进 claims（它后面不是 replace）。
	assert.equal(folded.reconcile.claims.some((item) => item.claimSeq === 5), false)
})

test('reconcile：shadowedSeqs 落在区间外的条数（宿主双重扣减的根因）与 claim 逐项可核', () => {
	const events = [
		surface(1, 'user/message', { role: 'user', content: textOf('AAAA'), source: { kind: 'user' } }),
		surface(2, 'user/message', { role: 'user', content: textOf('BBBB'), source: { kind: 'user' } }),
		// 区间 1..2；shadowedSeqs 里 10 / 11 在区间外（这些条仍留在表层，宿主却按 shadowedTokenCount 扣了）。
		{ type: 'compaction/prune', seq: 3, time: 0, data: { shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2, 10, 11], shadowedTokenCount: 10 } },
		// 匹配 replace：摘掉现价 5 + 5 = 10 ⇒ Δ += 10 − 10 = 0，但 outside=2 要如实记下。
		surface(4, 'user/message', { role: 'user', content: textOf('CCCCCCCC'), source: { kind: 'user' } }, { op: 'replace', startSeq: 1, endSeq: 2 }),
	]
	const folded = foldContext(events, { estimateMessage: price })
	assert.equal(folded.reconcile.claims.length, 1)
	assert.equal(folded.reconcile.claims[0].claimTokens, 10)
	assert.equal(folded.reconcile.claims[0].removedTokens, 10)
	assert.equal(folded.reconcile.claims[0].shadowedSeqsOutsideRange, 2, '区间外的 shadowedSeqs 要能逐项复核')
})

test('无压缩日志：Δ=0，messages 退化为无条件等于宿主 messageTokens', () => {
	// 一份**没有 compaction** 的合成日志：期望值手算（system 6 / 其余 5+6+5 = 16）。
	const events = [
		surface(1, 'system/message', { message: { role: 'system', content: textOf('BBBBBBBB'), source: { kind: 'system-prompt' } } }),
		surface(2, 'user/message', { role: 'user', content: textOf('CCCC'), source: { kind: 'user' } }),
		surface(3, 'assistant/message', { message: { role: 'assistant', content: textOf('FFFFFFFF'), source: { kind: 'model' } } }),
		surface(4, 'tool/result', { message: { role: 'tool', toolCallId: 'c1', content: textOf('GGGG'), source: { kind: 'tool' } } }),
	]
	const folded = foldContext(events, { estimateMessage: price })
	const messages = folded.categories.user + folded.categories.inject + folded.categories.skill + folded.categories.assistant + folded.categories.tool
	assert.equal(folded.reconcile.delta, 0)
	assert.deepEqual(folded.reconcile.claims, [])
	assert.deepEqual(folded.reconcile.unclaimed, [])
	assert.equal(folded.categories.system, 6, '宿主 systemTokens（手算）')
	assert.equal(messages, 16, '宿主 messageTokens（手算）')
	assert.equal(messages, 16 + folded.reconcile.delta, '③ 无压缩时退化为无条件相等')
})

// ── 真实日志夹具（003 §⑩.4）：期望值来自宿主投影的现场读数，不来自被测实现 ────────
//
// 日志本体**不进仓库**（体积），测试按已知路径读本机日志（缺失 / 没有 zstd 时跳过）。
// 三组常数是 003 §⑩.4 写死的宿主现场读数；Δ 的分解（claims 数 / 首条 / 摘要 / 越界）
// 也逐项钉住 —— 否则"算出任意 Δ 都能让等式成立"。

/** 宿主 `estimate.ts` 的逐字实现（只为真实日志夹具；常量与分支同源）。 */
const hostPrice = (() => {
	const CHARS_PER_TOKEN = 4
	const BLOCK_OVERHEAD = 4
	const ROLE_OVERHEAD = 4
	const structural = (block) => {
		if (block.type === 'image') {
			const { offloaded, ...reference } = block
			return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(reference).length / CHARS_PER_TOKEN)
		}
		return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
	}
	return (message) => {
		if (!message) return 0
		const content = Array.isArray(message.content) ? message.content : []
		if (message.role === 'system') {
			if (content.length === 0) return 0
			let chars = 0
			for (const block of content) chars += block.type === 'text' ? (block.text ?? '').length : JSON.stringify(block).length
			return Math.ceil(chars / CHARS_PER_TOKEN) + ROLE_OVERHEAD
		}
		let tokens = ROLE_OVERHEAD
		for (const block of content) {
			if (block.type === 'text' || block.type === 'reasoning') tokens += Math.ceil((block.text ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
			else if (block.type === 'tool-call') tokens += Math.ceil((block.name ?? '').length / CHARS_PER_TOKEN) + Math.ceil((block.arguments ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
			else tokens += structural(block)
		}
		return tokens
	}
})()

/** 本机真实会话日志的候选路径（qa 的 `/tmp/qa/all-*.jsonl` 同源；这里读原始 zstd）。 */
const REAL_LOGS = {
	'09299ab6': join(process.env.HOME ?? '', '.dsh/sessions/--Volumes-ME-aigc-dsh-team-ops--/session-09299ab6-4f2b-42a0-88e9-10bf566d0f90/session.v4.jsonl.zstd'),
	'5b0d654c': join(process.env.HOME ?? '', '.dsh/sessions/--Volumes-ME-aigc-dsh-team-ops--/session-5b0d654c-344e-4a90-9230-02ac8d70360a/session.v4.jsonl.zstd'),
}

/** 解压一份 zstd 会话日志；工具或文件不在时返回 null（测试跳过，不判红）。 */
function readRealLog(key) {
	const file = REAL_LOGS[key]
	if (typeof file !== 'string' || file === '' || !existsSync(file)) return null
	const result = spawnSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
	if (result.error !== undefined || result.status !== 0) return null
	return result.stdout.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

const REAL_EXPECTATIONS = {
	'09299ab6': { system: 3005, tools: 14947, hostMessages: 332953, messages: 349827, delta: 16874, claims: 16, firstClaim: 2645, summaryClaim: 368795, outside: 13 },
	'5b0d654c': { system: 3179, tools: 15178, hostMessages: 245693, messages: 258673, delta: 12980, claims: 11, firstClaim: 7442, summaryClaim: 390448, outside: 10 },
}

for (const [key, expected] of Object.entries(REAL_EXPECTATIONS)) {
	test('真实日志夹具：' + key + ' 七类 / Δ / claims 分解逐项对上宿主现场读数（不循环）', (t) => {
		const events = readRealLog(key)
		if (events === null) {
			t.skip('本机没有这份会话日志或 zstd（日志不进仓库：只在本机/qa 机器上跑）')
			return
		}
		const folded = foldContext(events, { estimateMessage: hostPrice })
		const messages = folded.categories.user + folded.categories.inject + folded.categories.skill + folded.categories.assistant + folded.categories.tool
		// ①② 无条件相等；③ messages === 宿主 messageTokens + Δ（宿主现场读数写死，容差 0）。
		assert.equal(folded.categories.system, expected.system, '① system')
		assert.equal(folded.categories.tools, expected.tools, '② tools')
		assert.equal(messages, expected.messages, '本页 messages（现场读数写死）')
		assert.equal(folded.reconcile.delta, expected.delta, 'Δ')
		assert.equal(messages, expected.hostMessages + folded.reconcile.delta, '③ messages === 宿主 messageTokens + Δ（容差 0）')
		// Δ 的分解：claims 数 / 首条 / 摘要 / 越界 / 自洽（③a）。
		assert.equal(folded.reconcile.claims.length, expected.claims, 'claims 条数')
		assert.equal(folded.reconcile.unclaimed.length, 0, '这两份日志没有未计量 replace')
		assert.equal(folded.reconcile.claims[0].claimTokens, expected.firstClaim, '首条 claim 的 shadowedTokenCount')
		assert.equal(folded.reconcile.claims.at(-1).claimTokens, expected.summaryClaim, '摘要 claim 的 shadowedTokenCount')
		assert.equal(folded.reconcile.claims.at(-1).shadowedSeqsOutsideRange, expected.outside, 'shadowedSeqs 落在区间外的条数')
		const sumClaims = folded.reconcile.claims.reduce((sum, item) => sum + item.claimTokens - item.removedTokens, 0)
		assert.equal(folded.reconcile.delta, sumClaims, '③a Δ === Σ(claimTokens − removedTokens)')
	})
}

// ── 机制级合成夹具：claim 臂的**非零 Δ**（缺口本体；不读本机日志、不依赖环境变量）──
//
// 复验红项：现有合成夹具的 claim 臂 Δ 恒为 0（prune 5/5、5/5、10/10），而真实日志夹具在
// 没有 `~/.dsh/sessions` 时会 skip ⇒ CI 上"claim 臂坏了"也全绿。这里用纯内存的 6 事件
// 最小日志把非零 Δ 的形态钉死（数字来自 qa 的最小复现：1008 / 208 / 800 / 5316 / 4516）。
//
// 手算依据（本文件的 `price` 对单 text 块的定价是 `4 + ceil(len/4)`）：
//   seq1  user len 384  → 100   （随后被 prune claim 摘掉：claims[0] = 100/100，Δ 0）
//   seq2  compaction/prune claim { range 1..1, tokens 100 }
//   seq3  user replace 1..1 len 816 → 208（进表层）
//   seq4  compaction/summary claim { range 3..3, tokens 1008 }
//   seq5  user replace 3..3 len 9984 → 2500；摘掉 seq3 的 208 ⇒ claims[1] = 1008/208，Δ += 800
//   seq6  user append len 11248 → 2816
// 末端 messages = 2500 + 2816 = 5316；宿主复算 = 5316 − 800 = 4516。

/** 构造 qa 给的 6 事件最小日志；`outsideSeq` 给了就往 summary 的 shadowedSeqs 里再放一个越界值。 */
function claimArmFixture(outsideSeq) {
	const summarySeqs = outsideSeq === undefined ? [3] : [3, outsideSeq]
	return [
		surface(1, 'user/message', { role: 'user', content: textOf('A'.repeat(384)), source: { kind: 'user' } }),
		{ type: 'compaction/prune', seq: 2, time: 0, data: { shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 100 } },
		surface(3, 'user/message', { role: 'user', content: textOf('B'.repeat(816)), source: { kind: 'user' } }, { op: 'replace', startSeq: 1, endSeq: 1 }),
		{ type: 'compaction/summary', seq: 4, time: 0, data: { shadowedRange: { start: 3, end: 3 }, shadowedSeqs: summarySeqs, shadowedTokenCount: 1008 } },
		surface(5, 'user/message', { role: 'user', content: textOf('C'.repeat(9984)), source: { kind: 'user' } }, { op: 'replace', startSeq: 3, endSeq: 3 }),
		surface(6, 'user/message', { role: 'user', content: textOf('D'.repeat(11248)), source: { kind: 'user' } }),
	]
}

test('claim 臂非零 Δ（机制级合成，不 skip）：claims[1] 1008/208 ⇒ Δ=800，messages 5316 = host 4516 + 800', () => {
	const folded = foldContext(claimArmFixture(), { estimateMessage: price })
	// claim 臂：第一条是 prune 的 100/100（Δ 0），第二条才是非零 Δ 的 summary 臂。
	assert.equal(folded.reconcile.claims.length, 2)
	assert.deepEqual(folded.reconcile.claims[0], { claimSeq: 2, replaceSeq: 3, claimTokens: 100, removedTokens: 100, shadowedSeqsOutsideRange: 0 })
	assert.deepEqual(folded.reconcile.claims[1], { claimSeq: 4, replaceSeq: 5, claimTokens: 1008, removedTokens: 208, shadowedSeqsOutsideRange: 0 })
	assert.deepEqual(folded.reconcile.unclaimed, [])
	// Δ 咬到具体数：1008 − 208 = 800（不是"大于 0"）。
	assert.equal(folded.reconcile.delta, 800)
	const messages = folded.categories.user + folded.categories.inject + folded.categories.skill + folded.categories.assistant + folded.categories.tool
	assert.equal(messages, 5316, '七类 messages（手算：2500 摘后新增 + 2816 追加）')
	// ③：messages === 宿主现场读数 + Δ（4516 是这份最小复现的宿主 messageTokens 字面量）。
	assert.equal(messages, 4516 + folded.reconcile.delta, '③ messages = host 4516 + Δ 800')
	// ③a 自洽。
	const sumClaims = folded.reconcile.claims.reduce((sum, item) => sum + item.claimTokens - item.removedTokens, 0)
	const sumUnclaimed = folded.reconcile.unclaimed.reduce((sum, item) => sum + item.newTokens - item.removedTokens, 0)
	assert.equal(folded.reconcile.delta, sumClaims + sumUnclaimed)
})

test('claim 臂：shadowedSeqs 的越界计数与 Δ 是两本账（outside=1，Δ 仍 800）', () => {
	// 同形态，只往 summary 的 shadowedSeqs 里加一个**落在区间外**的值（999 ∉ [3,3]）。
	const folded = foldContext(claimArmFixture(999), { estimateMessage: price })
	assert.equal(folded.reconcile.claims.length, 2)
	assert.equal(folded.reconcile.claims[1].claimTokens, 1008)
	assert.equal(folded.reconcile.claims[1].removedTokens, 208)
	assert.equal(folded.reconcile.claims[1].shadowedSeqsOutsideRange, 1, '越界条数单独记，且恰好 1')
	assert.equal(folded.reconcile.delta, 800, '越界计数不参与 Δ：仍 800')
	const messages = folded.categories.user + folded.categories.inject + folded.categories.skill + folded.categories.assistant + folded.categories.tool
	assert.equal(messages, 5316)
	assert.equal(messages, 4516 + folded.reconcile.delta)
})

test('过期 claim：claim 后隔一个非 compaction 事件才 replace ⇒ Δ=0（claim 只对紧邻事件生效）', () => {
	const events = [
		surface(1, 'user/message', { role: 'user', content: textOf('B'.repeat(816)), source: { kind: 'user' } }),
		// 武装一份 1008 的 claim……
		{ type: 'compaction/summary', seq: 2, time: 0, data: { shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 1008 } },
		// ……但下一个事件不是 replace ⇒ claim 作废（宿主 `withoutClaim` 在每个 apply 开头丢掉它）。
		{ type: 'turn/start', seq: 3, time: 0, data: { turn: 1 } },
		// 这条 replace 没有 claim 可配 ⇒ 走"未计量非系统 replace"：Δ = 208 − 208 = 0。
		surface(4, 'user/message', { role: 'user', content: textOf('B'.repeat(816)), source: { kind: 'user' } }, { op: 'replace', startSeq: 1, endSeq: 1 }),
	]
	const folded = foldContext(events, { estimateMessage: price })
	assert.equal(folded.reconcile.claims.length, 0, 'claim 已经作废，不许再被消费')
	assert.deepEqual(folded.reconcile.unclaimed, [{ replaceSeq: 4, newTokens: 208, removedTokens: 208 }])
	assert.equal(folded.reconcile.delta, 0, '过期 claim 若被错误消费会得 800；这里必须是 0')
	const messages = folded.categories.user + folded.categories.inject + folded.categories.skill + folded.categories.assistant + folded.categories.tool
	assert.equal(messages, 208)
	assert.equal(messages, 208 + folded.reconcile.delta)
})

// ── v2.2 数据面（A15/A16/A17）+ v2.2 缺席冷读（A19–A22）+ 全文（A23）─────────────

test('A15：系统提示项给首段预览 / chars / paragraphs / previewTruncated，不再写死占位句', () => {
	const paragraphs = [
		'你是这个团队的「前端开发工程师」。'.repeat(10),
		'第二段：只用于算段数与全文长度。',
		'第三段。',
	]
	const systemText = paragraphs.join('\n\n')
	const events = [
		surface(1, 'system/message', { message: { role: 'system', content: textOf(systemText), source: { kind: 'system-prompt' } } }),
		surface(2, 'user/message', { role: 'user', content: textOf('你好'), source: { kind: 'user' } }),
	]
	const folded = foldContext(events, { estimateMessage: price })
	const item = folded.items.system[0]
	assert.ok(item !== undefined)
	assert.equal(item.preview, Array.from(paragraphs[0]).slice(0, 120).join(''), '预览 = 首段（≤120 字符）')
	assert.equal(item.chars, systemText.length, 'chars = 整篇原长（字符）')
	assert.equal(item.paragraphs, 3, '段数按 /\\n\\s*\\n/ 切非空段')
	assert.equal(item.previewTruncated, true)
	assert.notEqual(item.preview, '整篇系统提示', '不再是占位句')
	assert.equal(item.kind, 'system-prompt')
	// 首屏载荷里没有全文（全文走 part=system-full）。
	assert.equal(item.fullText, undefined)
	// 空段开头也要能取到首个非空段。
	const leadingBlank = foldContext([surface(1, 'system/message', { message: { role: 'system', content: textOf('\n\n  首段在空段之后。\n\n第二段') } })], { estimateMessage: price })
	assert.equal(leadingBlank.items.system[0].preview, '首段在空段之后。')
})

test('A16：digest 规则 6 条逐个命中、组合顺序固定、空推理不出片段、empty 只在零块', () => {
	const cases = [
		// 1) 只有正文
		{ content: [{ type: 'text', text: '我来核对一下这五个文件' }], expect: { blocks: { text: 1, reasoning: 0, toolCall: 0, image: 0, toolChange: 0, other: 0 }, chars: { text: 11, reasoning: 0 }, tools: [], empty: false } },
		// 2) 只有推理（非空）
		{ content: [{ type: 'reasoning', text: '思考了 2311 个字符' }], expect: { chars: { text: 0, reasoning: 12 }, blocks: { text: 0, reasoning: 1, toolCall: 0, image: 0, toolChange: 0, other: 0 }, empty: false } },
		// 2b) 空推理块：只计数、不出片段（chars 不增）
		{ content: [{ type: 'reasoning', text: '   ' }], expect: { chars: { text: 0, reasoning: 0 }, blocks: { text: 0, reasoning: 1, toolCall: 0, image: 0, toolChange: 0, other: 0 }, empty: false } },
		// 3) 两次工具调用（tools 去重最多 2 个）
		{ content: [{ type: 'tool-call', name: 'board_task', arguments: '{}' }, { type: 'tool-call', name: 'bash', arguments: '{}' }, { type: 'tool-call', name: 'bash', arguments: '{}' }], expect: { blocks: { text: 0, reasoning: 0, toolCall: 3, image: 0, toolChange: 0, other: 0 }, tools: ['board_task', 'bash'], empty: false } },
		// 4) 图片
		{ content: [{ type: 'image' }, { type: 'image' }], expect: { blocks: { text: 0, reasoning: 0, toolCall: 0, image: 2, toolChange: 0, other: 0 }, empty: false } },
		// 5) 工具增删（带 toolName，前 2 个）
		{ content: [{ type: 'tool-removal', toolName: 'interrupt_agent' }, { type: 'tool-removal', toolName: 'member_wait' }, { type: 'tool-addition', toolName: 'third' }], expect: { blocks: { text: 0, reasoning: 0, toolCall: 0, image: 0, toolChange: 3, other: 0 }, toolChanges: [{ kind: 'remove', name: 'interrupt_agent' }, { kind: 'remove', name: 'member_wait' }], empty: false } },
		// 6) 未知块型
		{ content: [{ type: 'audio' }, { type: 'audio' }, { type: 'video' }], expect: { blocks: { text: 0, reasoning: 0, toolCall: 0, image: 0, toolChange: 0, other: 3 }, others: [{ type: 'audio', count: 2 }, { type: 'video', count: 1 }], empty: false } },
		// 7) 零块
		{ content: [], expect: { blocks: { text: 0, reasoning: 0, toolCall: 0, image: 0, toolChange: 0, other: 0 }, empty: true } },
	]
	for (const [index, entry] of cases.entries()) {
		const digest = digestOfMessage({ content: entry.content })
		assert.equal(digest.empty, entry.expect.empty, '第 ' + (index + 1) + ' 条 empty')
		for (const key of ['text', 'reasoning', 'toolCall', 'image', 'toolChange', 'other']) {
			assert.equal(digest.blocks[key], entry.expect.blocks[key], '第 ' + (index + 1) + ' 条 blocks.' + key)
		}
		if (entry.expect.chars !== undefined) assert.deepEqual(digest.chars, entry.expect.chars, '第 ' + (index + 1) + ' 条 chars')
		if (entry.expect.tools !== undefined) assert.deepEqual(digest.tools, entry.expect.tools, '第 ' + (index + 1) + ' 条 tools')
		if (entry.expect.toolChanges !== undefined) assert.deepEqual(digest.toolChanges, entry.expect.toolChanges, '第 ' + (index + 1) + ' 条 toolChanges')
		if (entry.expect.others !== undefined) assert.deepEqual(digest.others, entry.expect.others, '第 ' + (index + 1) + ' 条 others')
	}
	// 组合顺序（server 只给结构；片段串在客户端按固定顺序拼 —— 这里锁结构齐备）。
	const combo = digestOfMessage({ content: [{ type: 'text', text: '正文' }, { type: 'reasoning', text: '推理' }, { type: 'tool-call', name: 'bash' }, { type: 'image' }] })
	assert.deepEqual(combo.blocks, { text: 1, reasoning: 1, toolCall: 1, image: 1, toolChange: 0, other: 0 })
	assert.deepEqual(combo.chars, { text: 2, reasoning: 2 })
	assert.deepEqual(combo.tools, ['bash'])
})

test('A17：segmentDigest 三项之和 = 段项数，且不受分页影响', async () => {
	const events = [
		surface(1, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '有正文' }] } }),
		surface(2, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'reasoning', text: '只有推理' }] } }),
		surface(3, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', name: 'bash', arguments: '{}' }] } }),
		surface(4, 'assistant/message', { message: { role: 'assistant', content: [] } }),
	]
	const folded = foldContext(events, { estimateMessage: price })
	assert.deepEqual(folded.segmentDigest.assistant, { withText: 1, noText: 2, empty: 1 })
	assert.equal(folded.segmentDigest.assistant.withText + folded.segmentDigest.assistant.noText + folded.segmentDigest.assistant.empty, folded.items.assistant.length, '三项之和 = 段项数')
	// 端点分页不改变 segmentDigest。
	const workspace = freshWorkspace()
	const { ctx } = contextCtx({ workspace, events })
	const base = '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1'
	const all = await callContext(ctx, base)
	const paged = await callContext(ctx, base + '&page=1')
	assert.deepEqual(paged.payload.segmentDigest, all.payload.segmentDigest, '分页不影响段头汇总')
	assert.equal(paged.payload.segmentDigest.assistant.withText + paged.payload.segmentDigest.assistant.noText + paged.payload.segmentDigest.assistant.empty, 4)
})

test('A19/A22：缺席成员走 prepared 冷读（ended=true、occupancy 来自租约投影）；idle 活成员不算 ended', async () => {
	const workspace = freshWorkspace()
	const { events } = fixtureEvents()
	const preparedProjections = {
		asOfSeq: 41,
		values: {
			contextPressure: { pressureTokens: 442368, projectedTokens: 442368, contextWindow: 1048576 },
			contextBreakdown: { systemTokens: 6, toolsTokens: TOOLS_TOKENS(fixtureEvents().tools), messageTokens: 36 },
		},
	}
	const gone = contextCtx({ workspace, events, agent: null, source: 'prepared', projections: preparedProjections })
	const { payload } = await callContext(gone.ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1')
	assert.equal(payload.state, 'ready')
	assert.equal(payload.source, 'prepared')
	assert.equal(payload.ended, true, 'prepared + agents.get 空 ⇒ ended')
	assert.equal(payload.occupancy.state, 'ready', '占用来自 prepared 租约的投影（同一套判据）')
	assert.equal(payload.occupancy.projectedTokens, 442368)
	assert.equal(payload.categories.system, 6)
	assert.ok(typeof payload.asOfTime === 'string' && payload.asOfTime.includes('T'), 'asOfTime = 末事件时刻（ISO）')
	assert.equal(gone.calls.disposed, 1, '读完释放租约')
	// idle 的活成员：agents.get 非空、source=live ⇒ ended=false（A22）。
	const idle = contextCtx({ workspace, events, source: 'live' })
	const live = await callContext(idle.ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1')
	assert.equal(live.payload.ended, false)
	assert.equal(live.payload.source, 'live')
})

test('A21：notFound / CORRUPT / abort 三种失败都落 L3 + 原因原文（不印 0）', async () => {
	const workspace = freshWorkspace()
	const codes = ['SESSION_QUERY_NOT_FOUND', 'SESSION_QUERY_CORRUPT_SESSION', 'ABORT_ERR']
	for (const code of codes) {
		const failed = contextCtx({
			workspace,
			events: [],
			agent: null,
			observe: () => {
				const error = new Error('冷读失败：' + code)
				error.code = code
				throw error
			},
		})
		const { payload } = await callContext(failed.ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1')
		assert.equal(payload.state, 'l3', code)
		assert.equal(payload.ended, true, code)
		assert.match(payload.reason, new RegExp(code), code + ' 的原因原文要透出')
		assert.equal(payload.occupancy, null)
		assert.equal(payload.reconcile, null)
	}
})

test('A20：实现不直读宿主会话文件（无 .dsh/sessions / jsonl.zstd / zstd）', () => {
	const sources = [readFileSync('lib/member-context.js', 'utf8'), readFileSync('lib/member-context-routes.js', 'utf8')].join('\n')
	for (const needle of ['.dsh/sessions', 'jsonl.zstd', 'zstd']) {
		assert.equal(sources.includes(needle), false, '实现里不许出现：' + needle)
	}
})

// ── A23：全文契约（只读、按需、200k 码点截断）────────────────────────────────

function systemFullCtx(events, options = {}) {
	const workspace = options.workspace
	const { ctx, calls } = contextCtx({ workspace, events, ...options })
	return { ctx, calls }
}

test('A23：全文一次取完、按码点截到 200k；chars 是原长；不截断时长度一致', async () => {
	const workspace = freshWorkspace()
	// 一份 200,050 字符的 system（BMP 字符，便于按码点/长度同时对齐）。
	const text = '前'.repeat(200_050)
	const events = [
		surface(1, 'system/message', { message: { role: 'system', content: textOf(text) } }),
		surface(2, 'user/message', { role: 'user', content: textOf('hi'), source: { kind: 'user' } }),
	]
	const { ctx, calls } = systemFullCtx(events, { workspace })
	const { payload } = await callContext(ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1&part=system-full')
	assert.equal(payload.ok, true)
	assert.equal(payload.chars, 200_050, 'chars 报原长')
	assert.equal(payload.fullTextTruncated, true, 'fullTextTruncated === (chars > 200000)')
	assert.equal(payload.fullText.length, 200_000, '截断时长度 = 200000')
	assert.equal(payload.fullText, '前'.repeat(200_000))
	assert.equal(payload.systemSeq, 1)
	assert.equal(calls.observed.length, 1, '全文只开一次租约')
	assert.equal(calls.disposed, 1)
	// 非 BMP：150k 码点（UTF-16 长度 300k）⇒ 按码点算未超限、不截断，且 `chars` 也是码点数。
	const emoji = '\u{1F600}'.repeat(150_000)
	const nonBmp = systemFullCtx([surface(1, 'system/message', { message: { role: 'system', content: textOf(emoji) } })], { workspace })
	const nonBmpPayload = (await callContext(nonBmp.ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1&part=system-full')).payload
	assert.equal(nonBmpPayload.chars, 150_000, 'chars 按码点（不是 UTF-16 长度 300k）')
	assert.equal(nonBmpPayload.fullTextTruncated, false, '150k 码点未超 200k ⇒ 不截断')
	assert.equal(Array.from(nonBmpPayload.fullText).length, 150_000, '全文按码点计长度一致')
	// 未超上限：不截断、长度一致。
	const small = systemFullCtx([surface(1, 'system/message', { message: { role: 'system', content: textOf('短短的系统提示') } })], { workspace })
	const smallPayload = (await callContext(small.ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1&part=system-full')).payload
	assert.equal(smallPayload.fullTextTruncated, false)
	assert.equal(smallPayload.chars, smallPayload.fullText.length)
})

test('A23：全文读不到保持 ok:true + fullText:null + 原因；取全文不改七类与 Δ', async () => {
	const workspace = freshWorkspace()
	const { events } = fixtureEvents()
	const { ctx } = contextCtx({ workspace, events })
	const base = '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1'
	const before = (await callContext(ctx, base)).payload
	const full = (await callContext(ctx, base + '&part=system-full')).payload
	assert.equal(full.ok, true)
	assert.ok(typeof full.fullText === 'string' && full.fullText.length > 0)
	const after = (await callContext(ctx, base)).payload
	assert.deepEqual(after.categories, before.categories, '全文不参与七类')
	assert.deepEqual(after.reconcile, before.reconcile, '全文不参与 Δ')
	// 会话观察失败：ok:true + fullText:null + fullTextError（首屏预览仍在）。
	const failed = contextCtx({
		workspace,
		events,
		observe: () => {
			throw new Error('读盘失败')
		},
	})
	const bad = (await callContext(failed.ctx, base + '&part=system-full')).payload
	assert.equal(bad.ok, true)
	assert.equal(bad.fullText, null)
	assert.match(bad.fullTextError, /读盘失败/)
})

// ── v2.4 §1.14 逐项按需详情（A26–A29）────────────────────────────────────────

/** 一份带「全部详情形态」的 8 事件日志（含被压缩替换的 seq、非 BMP、秘密参数/schema）。 */
function itemFixture() {
	const secretSchema = 'SECRET-SCHEMA-7'
	const secretArgs = '{"token":"SECRET-ARG-42"}'
	const events = [
		// seq1 用户：BMP 超 50k
		surface(1, 'user/message', { role: 'user', content: textOf('A'.repeat(60_000)), source: { kind: 'user' } }),
		// seq2 助手：正文 + 推理 + 工具调用（参数是秘密）+ 图片
		surface(2, 'assistant/message', {
			message: {
				role: 'assistant',
				content: [
					{ type: 'text', text: 'B'.repeat(60_000) },
					{ type: 'reasoning', text: 'C'.repeat(60_000) },
					{ type: 'tool-call', name: 'bash', arguments: secretArgs },
					{ type: 'image' },
				],
				source: { kind: 'model' },
			},
		}),
		// seq3 工具调用（callId → name）；seq4 工具结果（D 超 50k）
		{ type: 'tool/call', seq: 3, time: 0, data: { callId: 'c1', name: 'bash', arguments: secretArgs } },
		surface(4, 'tool/result', { message: { role: 'tool', toolCallId: 'c1', content: textOf('D'.repeat(60_000)), source: { kind: 'tool' } } }),
		// seq5 将被压缩替换掉的用户消息（之后 ask seq5 ⇒ P27）
		surface(5, 'user/message', { role: 'user', content: textOf('会被替换'), source: { kind: 'user' } }),
		// seq6：replace 摘掉 seq5（同一区间内新节点）
		surface(6, 'user/message', { role: 'user', content: textOf('替换后'), source: { kind: 'user' } }, { op: 'replace', startSeq: 5, endSeq: 5 }),
		// seq7 小消息：不截断
		surface(7, 'user/message', { role: 'user', content: textOf('hello'), source: { kind: 'user' } }),
		// seq8 非 BMP 用户消息：60,000 个 emoji = 120,000 码元 / 60,000 码点
		surface(8, 'user/message', { role: 'user', content: textOf('\u{1F600}'.repeat(60_000)), source: { kind: 'user' } }),
		// seq9 注入：带 kind
		surface(9, 'user/message', { role: 'user', content: textOf('运行时上下文'), source: { kind: 'runtime-context' } }),
		// seq10 系统提示（逐项接口应指回 system-full）
		surface(10, 'system/message', { message: { role: 'system', content: textOf('系统提示正文'), source: { kind: 'system-prompt' } } }),
	]
	// 最后一个 request/header 带 schema（含秘密描述）—— 逐项详情不得回传它。
	events.push({ type: 'request/header', seq: 11, time: 0, data: { header: { tools: [{ name: 'bash', description: secretSchema, inputSchema: { type: 'object' } }] } } })
	return { events, secretSchema, secretArgs }
}

const itemUrl = (workspace, seq) => '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&session=sess-1&member=child-1&part=item&seq=' + String(seq)

test('A26：逐项详情一次请求只开一次租约、不算价；两次请求各取一次（服务端不缓存）', async () => {
	const workspace = freshWorkspace()
	const { events } = itemFixture()
	const meter = { calls: 0, estimateMessage(message) { this.calls += 1; return price(message) } }
	const { ctx, calls } = contextCtx({ workspace, events, services: { tokenMeter: { estimateMessage: (message) => meter.estimateMessage(message) } } })
	const first = await callContext(ctx, itemUrl(workspace, 1))
	assert.equal(first.payload.ok, true)
	assert.equal(calls.observed.length, 1, '一次请求 = 一次 observeSession')
	assert.equal(calls.disposed, 1, '租约用完释放')
	assert.equal(meter.calls, 0, '逐项详情不算价（不调 estimateMessage）')
	const second = await callContext(ctx, itemUrl(workspace, 1))
	assert.equal(second.payload.detail.textChars, first.payload.detail.textChars)
	assert.equal(calls.observed.length, 2, '服务端不缓存（客户端按 (member,seq) 缓存）')
})

test('A27：50k 码点截断一致（BMP / 非 BMP / 推理 / 工具结果）；被压缩替换的 seq ⇒ P27', async () => {
	const workspace = freshWorkspace()
	const { events } = itemFixture()
	const { ctx } = contextCtx({ workspace, events })
	const call = async (seq) => (await callContext(ctx, itemUrl(workspace, seq))).payload
	// 用户（BMP，60k 字符）
	const user = await call(1)
	assert.equal(user.category, 'user')
	assert.equal(user.detail.textChars, 60_000)
	assert.equal(user.detail.textTruncated, true, 'textTruncated === (textChars > 50000)')
	assert.equal(user.detail.text.length, 50_000, 'BMP 截断后 length = 50000')
	assert.equal(user.detail.reasoning, undefined, '用户消息不带 reasoning')
	// 助手：正文 + 推理各 60k 截断；工具调用只给名字与 size；图片计数
	const assistant = await call(2)
	assert.equal(assistant.category, 'assistant')
	assert.equal(assistant.detail.textChars, 60_000)
	assert.equal(assistant.detail.text.length, 50_000)
	assert.equal(assistant.detail.reasoningChars, 60_000)
	assert.equal(assistant.detail.reasoningTruncated, true)
	assert.equal(Array.from(assistant.detail.reasoning).length, 50_000)
	assert.deepEqual(assistant.detail.toolCalls, [{ name: 'bash' }])
	assert.equal(assistant.detail.toolArgsChars, '{"token":"SECRET-ARG-42"}'.length)
	assert.equal(assistant.detail.images, 1)
	// 工具结果：全文 + toolName
	const tool = await call(4)
	assert.equal(tool.category, 'tool')
	assert.equal(tool.detail.textChars, 60_000)
	assert.equal(tool.detail.text.length, 50_000)
	assert.equal(tool.detail.toolName, 'bash')
	// 非 BMP：60,000 个 emoji（120,000 码元）⇒ 按码点截到 50,000
	const emoji = await call(8)
	assert.equal(emoji.detail.textChars, 60_000, 'textChars 按码点（60k emoji = 60k 码点，不是 120k 码元）')
	assert.equal(emoji.detail.textTruncated, true)
	assert.equal(Array.from(emoji.detail.text).length, 50_000, '截断按码点')
	assert.equal(emoji.detail.text.length, 100_000, '非 BMP 下码元长度 = 2 × 码点')
	// 边界档（qa 抓到的漏测）：30k emoji = 60k 码元、30k 码点 ⇒ 未超 50k 码点，**不该**判截断。
	const boundary = clipTextOf('\u{1F600}'.repeat(30_000), 50_000)
	assert.equal(boundary.chars, 30_000, '码元 60k 但码点 30k ⇒ chars 报 30k')
	assert.equal(boundary.truncated, false, '30k 码点 ≤ 50k ⇒ 不截断')
	assert.equal(boundary.text.length, 60_000, '原文不截断时按码元仍是 60k')
	// 未截断：text.length === textChars
	const small = await call(7)
	assert.equal(small.detail.textTruncated, false)
	assert.equal(small.detail.text.length, small.detail.textChars)
	// 被 replace 摘掉的 seq5 ⇒ ok:true + detail:null + P27（不猜、不重算）
	const gone = await call(5)
	assert.equal(gone.ok, true)
	assert.equal(gone.detail, null)
	assert.equal(gone.detailError, '这一项已不在当前表层（被压缩替换），没有可展开的详情。')
	// 系统提示：指回 system-full
	const system = await call(10)
	assert.equal(system.detail, null)
	assert.match(system.detailError, /part=system-full/)
	// 不存在的 seq / 非法 seq
	const missing = await call(9999)
	assert.equal(missing.detail, null)
	assert.equal(missing.detailError, '这一项已不在当前表层（被压缩替换），没有可展开的详情。')
	const bad = (await callContext(ctx, '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1&part=item&seq=abc')).payload
	assert.equal(bad.detail, null)
	assert.match(bad.detailError, /seq/)
})

test('A28：逐项详情不改账（categories / Δ 逐值不变）且默认载荷字段集合不变', async () => {
	const workspace = freshWorkspace()
	const { events } = itemFixture()
	const { ctx } = contextCtx({ workspace, events })
	const base = '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1'
	const before = (await callContext(ctx, base)).payload
	await callContext(ctx, base + '&part=item&seq=2')
	const after = (await callContext(ctx, base)).payload
	assert.deepEqual(after.categories, before.categories, '取详情前后七类逐值不变')
	assert.deepEqual(after.reconcile, before.reconcile, '取详情前后 Δ 逐值不变')
	// 默认载荷字段集合**一个都不许加**（v2.4 §14.5）。
	const expectedKeys = [
		'asOfSeq', 'asOfTime', 'categories', 'counts', 'ended', 'inheritedEventCount', 'items', 'member', 'occupancy', 'ok', 'page', 'readAt',
		'reason', 'reconcile', 'segmentDigest', 'segments', 'session', 'sort', 'source', 'state', 'tools', 'totals', 'warnings', 'workspace',
	].sort()
	assert.deepEqual(Object.keys(before).sort(), expectedKeys, '默认响应字段集合')
	assert.deepEqual(Object.keys(after).sort(), expectedKeys)
})

test('A29：逐项响应不含工具参数 / schema 原文 / 图片二进制；工具定义不在本接口', async () => {
	const workspace = freshWorkspace()
	const { events, secretSchema, secretArgs } = itemFixture()
	const { ctx } = contextCtx({ workspace, events })
	const base = '/company-board/api/member-context?workspace=' + encodeURIComponent(workspace) + '&member=child-1'
	const assistant = (await callContext(ctx, base + '&part=item&seq=2')).payload
	const json = JSON.stringify(assistant)
	assert.equal(json.includes('SECRET-ARG-42'), false, '工具参数内容不外露')
	assert.equal(json.includes('"arguments"'), false, '响应里没有 arguments 字段')
	assert.equal(json.includes(secretSchema), false, 'schema 原文不外露')
	assert.equal(json.includes('inputSchema'), false)
	assert.deepEqual(Object.keys(assistant.detail.toolCalls[0]), ['name'], '工具调用只给名字')
	assert.equal(typeof assistant.detail.toolArgsChars, 'number', '只给参数规模')
	// 工具结果也不带原始消息对象 / 图片二进制。
	const tool = (await callContext(ctx, base + '&part=item&seq=4')).payload
	assert.equal(JSON.stringify(tool).includes('"message"'), false)
	assert.equal(JSON.stringify(tool).includes('"content"'), false)
	// 默认列表载荷也不含 schema 原文（工具段只有 name / tokens / calls）。
	const list = (await callContext(ctx, base)).payload
	assert.equal(JSON.stringify(list).includes(secretSchema), false, '列表载荷不含工具 schema 原文')
	assert.equal(JSON.stringify(list).includes('SECRET-ARG-42'), false)
})

test('存活表层纯函数：nodeOf / survivingEventOf 能按 seq 找节点、replace 后旧 seq 为 null（不调 estimateMessage）', () => {
	const { events } = itemFixture()
	const meter = { calls: 0, estimateMessage(message) { this.calls += 1; return price(message) } }
	const folded = foldContext(events, { estimateMessage: (message) => meter.estimateMessage(message) })
	assert.ok(folded.nodeOf(1) !== null)
	assert.equal(folded.nodeOf(5), null, '被 replace 摘掉的节点不在表层')
	const before = meter.calls
	const surface = survivingSurfaceOf(events)
	assert.equal(surface.eventOf(1).seq, 1)
	assert.equal(surface.eventOf(5), null)
	assert.equal(surface.toolNameOf('c1'), 'bash')
	assert.equal(meter.calls, before, '存活表层扫描不算价')
	assert.equal(survivingEventOf(events, 2).seq, 2)
})
