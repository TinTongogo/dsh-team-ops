/**
 * 输入框润色（design-polish-001）宿主半边的自检：
 *   · 预处理 / 还原 / 解析 / 机械校验（纯函数）；
 *   · `createPolishService` 的模型调用（注入假 LLM 模块，不静态依赖 `@deepseek-ai/*`）；
 *   · `/polish` 端点的错误契约（400 / 409 busy / 409 no-route / 429 / 502 / 504 / 413）。
 *
 * 这里钉的是**行为**：改坏任何一条（比如把占位符还原忘了、把数字校验去掉、把 409 写成 200），
 * 对应用例当场红。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
	buildSystemPrompt,
	createPolishService,
	mechanicalFindingsOf,
	missingNumbersOf,
	parsePolishReply,
	protectSegmentsOf,
	restoreProtected,
	sessionRouteOf,
	POLISH_MAX_CHARS,
} from '../lib/polish.js'
import { createPolishRoutes } from '../lib/polish-routes.js'

/* ── 纯函数：占位符保护 ──────────────────────────────────────────────── */

test('预处理：代码 / 链接 / 路径 / @引用 / 命令都被换成占位符，还原后逐字一致', () => {
	const original = '看 @architect 的 `npm run verify`，链接 https://example.com/a/b，路径 /usr/local/bin/x 和 C:\\tmp\\a.txt，命令 /help'
	const { masked, tokens } = protectSegmentsOf(original)
	assert.ok(!masked.includes('@architect'), '引用要换成占位符')
	assert.ok(!masked.includes('npm run verify'), '行内代码要换成占位符')
	assert.ok(!masked.includes('https://example.com'), '链接要换成占位符')
	assert.ok(tokens.length >= 5, '至少 5 个不可改写片段（实际 ' + tokens.length + '）')
	const restored = restoreProtected(masked, tokens)
	assert.equal(restored.text, original, '原样还原')
	assert.deepEqual(restored.missing, [], '没有丢失的占位符')
})

test('还原：模型弄丢占位符时如实报告，不静默吞掉', () => {
	const { tokens } = protectSegmentsOf('用 @qa 跑一下')
	const restored = restoreProtected('用一下', tokens)
	assert.equal(restored.text, '用一下')
	assert.deepEqual(restored.missing, ['[[P0]]'])
})

/* ── 纯函数：解析模型回复 ────────────────────────────────────────────── */

test('解析：容忍 ```json 围栏与前后杂字；缺字段时按缺省值给', () => {
	const reply = '```json\n{"polished":"更清楚的句子。","language":"zh","scenario":"技术讨论","changes":[{"kind":"冗余","before":"那个","after":""}],"confidence":0.88}\n```'
	const parsed = parsePolishReply(reply)
	assert.equal(parsed.fallback, false)
	assert.equal(parsed.polished, '更清楚的句子。')
	assert.equal(parsed.language, 'zh')
	assert.equal(parsed.changes.length, 1)
	assert.equal(parsed.confidence, 0.88)
})

test('解析：不是 JSON 就退回纯文本（不丢结果、不抛错）', () => {
	const parsed = parsePolishReply('直接给一段润色后的文字。')
	assert.equal(parsed.fallback, true)
	assert.equal(parsed.polished, '直接给一段润色后的文字。')
})

/* ── 纯函数：机械校验 ───────────────────────────────────────────────── */

test('机械校验：原文的数字在结果里找不到 ⇒ 报出来（多重集比较）', () => {
	assert.deepEqual(missingNumbersOf('预算 3000，占 12.5%，再 3000', '预算 3000，占 12.5%'), ['3000'])
	const findings = mechanicalFindingsOf({ original: '共 12 个任务，改 3 处', polished: '共 12 个任务' })
	assert.ok(findings.some((line) => line.includes('3')), '数字 3 丢了要被点名：' + JSON.stringify(findings))
})

test('机械校验：结果过短 / 过长都算可疑；干净的结果没有发现', () => {
	const long = '这是一段足够长的原文，用来比较长度比例是否异常；至少要有四十个字符以上，才会触发长度护栏的判定。'
	assert.equal(long.length >= 40, true, '测试夹具本身要够长：' + long.length)
	assert.ok(mechanicalFindingsOf({ original: long, polished: '短。' }).length > 0, '过短要报')
	assert.ok(mechanicalFindingsOf({ original: long, polished: long + long + long }).length > 0, '过长要报')
	assert.deepEqual(mechanicalFindingsOf({ original: '把这件事交给他。', polished: '把这件事交给他处理。' }), [])
})

/* ── 路由解析 ──────────────────────────────────────────────────────── */

test('会话路由：从会话的 requestHeader 里取 provider / model；取不到返回 null', () => {
	const ctx = {
		get: (name) =>
			name === 'sessions'
				? { get: () => ({ requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } }) }) }
				: undefined,
	}
	assert.deepEqual(sessionRouteOf(ctx, 's-1'), { provider: 'deepseek-account', model: 'deepseek-flash' })
	assert.equal(sessionRouteOf(ctx, ''), null)
	assert.equal(sessionRouteOf({ get: () => undefined }, 's-1'), null)
})

/* ── 服务：假 LLM 走完整链路 ────────────────────────────────────────── */

/** 假 LLM 模块：润色结果由测试给定，BlockAssembler 直接吐出那一段。 */
function fakeLlmModule(reply) {
	return {
		createUserMessage: (input) => ({ role: 'user', content: input.content, source: input.source }),
		BlockAssembler: class {
			push() {}
			blocks() {
				return [{ type: 'text', text: reply }]
			}
		},
	}
}

function fakeCtx({ route = { provider: 'deepseek-account', model: 'deepseek-flash' }, chunks = [{ type: 'chunk' }] } = {}) {
	return {
		get: (name) => {
			if (name === 'sessions') {
				return route === null ? undefined : { get: () => ({ requestHeader: () => ({ config: route }) }) }
			}
			if (name === 'llm') {
				return {
					prepareCall: async (config) => ({
						config,
						stream: async function* () {
							for (const chunk of chunks) yield chunk
						},
					}),
				}
			}
			return undefined
		},
	}
}

test('服务：占位符在结果里还原、机械校验通过、返回契约字段', async () => {
	const reply = JSON.stringify({
		polished: '请看 [[P0]] 跑 [[P1]] 的结果。',
		language: 'zh',
		scenario: '技术讨论',
		changes: [],
		confidence: 0.9,
	})
	const service = createPolishService({ importLlm: async () => fakeLlmModule(reply) })
	const result = await service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '看 @architect `npm test` 这段' })
	assert.equal(result.polished, '请看 @architect 跑 `npm test` 的结果。', '占位符要逐字还原')
	assert.equal(result.language, 'zh')
	assert.equal(result.checks.ok, true, '检查通过：' + JSON.stringify(result.checks.findings))
	assert.deepEqual(result.route, { provider: 'deepseek-account', model: 'deepseek-flash' })
	assert.equal(result.cached, false)
})

test('服务：同一草稿第二次命中缓存（cached=true，不再调模型）', async () => {
	const reply = JSON.stringify({ polished: '更清楚。', language: 'zh', scenario: '', changes: [], confidence: 0.8 })
	let calls = 0
	const module = fakeLlmModule(reply)
	const service = createPolishService({
		importLlm: async () => {
			calls += 1
			return module
		},
	})
	const first = await service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '原句' })
	const second = await service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '原句' })
	assert.equal(first.cached, false)
	assert.equal(second.cached, true)
	assert.equal(calls, 1, '命中缓存就不再 import / 调模型')
})

test('服务：没有路由 / 草稿超长 / 空草稿都抛带 code 的错误', async () => {
	const service = createPolishService({ importLlm: async () => fakeLlmModule('{}') })
	await assert.rejects(() => service.polish({ ctx: fakeCtx({ route: null }), sessionId: 's-1', text: '原句' }), (error) => error.code === 'POLISH_NO_ROUTE')
	await assert.rejects(() => service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: 'x'.repeat(POLISH_MAX_CHARS + 1) }), (error) => error.code === 'POLISH_TOO_LONG')
	await assert.rejects(() => service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '   ' }), (error) => error.code === 'POLISH_EMPTY')
})

/* ── 端点：错误契约 ────────────────────────────────────────────────── */

/** 形状够 `readBody` / `writeJson` 用的假请求。 */
function fakeRequest(body, method = 'POST') {
	return {
		method,
		on(event, listener) {
			if (event === 'data') listener(Buffer.from(body))
			else if (event === 'end') listener()
			return this
		},
	}
}

/** 形状够 `writeJson` 用的假响应。 */
function fakeResponse() {
	return {
		statusCode: 0,
		body: '',
		writeHead(status) {
			this.statusCode = status
		},
		end(body) {
			this.body = body
		},
	}
}

/** 假 service：按需成功或抛指定 code。 */
const okService = {
	polish: async ({ text }) => ({
		polished: '润色：' + text,
		language: 'zh',
		scenario: '日常沟通',
		changes: [],
		confidence: 0.9,
		checks: { ok: true, findings: [] },
		route: { provider: 'p', model: 'm' },
		elapsedMs: 1,
		cached: false,
	}),
}

test('端点：POST 成功返回契约字段；GET 405；坏 JSON 400；空草稿 400', async () => {
	const { handlePolish } = createPolishRoutes({ polish: okService })
	const res = fakeResponse()
	await handlePolish({}, fakeRequest(JSON.stringify({ session: 's-1', text: '原句' })), res)
	assert.equal(res.statusCode, 200)
	const payload = JSON.parse(res.body)
	assert.equal(payload.ok, true)
	assert.equal(payload.polished, '润色：原句')
	assert.deepEqual(payload.route, { provider: 'p', model: 'm' })
	assert.equal(typeof payload.checks.ok, 'boolean')

	const wrongMethod = fakeResponse()
	await handlePolish({}, fakeRequest('{}', 'GET'), wrongMethod)
	assert.equal(wrongMethod.statusCode, 405)

	const badJson = fakeResponse()
	await handlePolish({}, fakeRequest('{oops'), badJson)
	assert.equal(badJson.statusCode, 400)

	const emptyText = fakeResponse()
	await handlePolish({}, fakeRequest(JSON.stringify({ session: 's-1', text: '  ' })), emptyText)
	assert.equal(emptyText.statusCode, 400)
})

test('端点：no-route 409 / timeout 504 / upstream 502 / 超大请求体 413', async () => {
	const routesOf = (polish) => createPolishRoutes({ polish })
	const thrower = (code) => ({
		polish: async () => {
			throw Object.assign(new Error('假失败'), { code })
		},
	})
	for (const [code, status, reason] of [
		['POLISH_NO_ROUTE', 409, 'no-route'],
		['POLISH_TIMEOUT', 504, 'timeout'],
		['SOMETHING_ELSE', 502, 'upstream'],
	]) {
		const res = fakeResponse()
		await routesOf(thrower(code)).handlePolish({}, fakeRequest(JSON.stringify({ session: 's-1', text: '原句' })), res)
		assert.equal(res.statusCode, status, code + ' 要回 ' + status)
		assert.equal(JSON.parse(res.body).reason, reason)
	}
	const tooLarge = fakeResponse()
	const huge = JSON.stringify({ session: 's-1', text: 'x'.repeat(64 * 1024) })
	await routesOf(okService).handlePolish({}, fakeRequest(huge), tooLarge)
	assert.equal(tooLarge.statusCode, 413)
})

test('端点：并发 1（同一会话第二次回 busy）与每分钟 6 次限流', async () => {
	let release = null
	const slowService = {
		polish: async () =>
			new Promise((resolve) => {
				release = () => resolve({ polished: 'x', language: '', scenario: '', changes: [], confidence: 1, checks: { ok: true, findings: [] }, route: { provider: 'p', model: 'm' }, elapsedMs: 1, cached: false })
			}),
	}
	const { handlePolish } = createPolishRoutes({ polish: slowService })
	const first = handlePolish({}, fakeRequest(JSON.stringify({ session: 'busy-1', text: '原句' })), fakeResponse())
	await new Promise((resolve) => setTimeout(resolve, 5))
	const second = fakeResponse()
	await handlePolish({}, fakeRequest(JSON.stringify({ session: 'busy-1', text: '原句' })), second)
	assert.equal(second.statusCode, 409, '正在润色时再点回 409 busy')
	assert.equal(JSON.parse(second.body).reason, 'busy')
	release()
	await first

	const fast = createPolishRoutes({ polish: okService }).handlePolish
	let last = null
	for (let i = 0; i < 7; i += 1) {
		last = fakeResponse()
		await fast({}, fakeRequest(JSON.stringify({ session: 'rate-1', text: '第 ' + i + ' 次' })), last)
	}
	assert.equal(last.statusCode, 429, '第 7 次要被限流')
	assert.equal(JSON.parse(last.body).reason, 'rate-limited')
})

/* ── 提示词与路由表 ────────────────────────────────────────────────── */

test('提示词：写清"只改表达不改事实 / 占位符逐字保留 / 只输出 JSON"', () => {
	const prompt = buildSystemPrompt()
	assert.ok(prompt.includes('只改表达，不改事实'), '事实保真要写进提示词')
	assert.ok(prompt.includes('占位符'), '占位符规则要写进提示词')
	assert.ok(prompt.includes('只输出 JSON'), '输出契约要写进提示词')
	assert.ok(prompt.includes('[[P0]]'), '占位符形状要举例')
})

test('宿主路由表：/polish 已登记', async () => {
	const host = await import('../lib/board-view.host.js')
	const routes = host.routeTable()
	assert.ok(routes.has(host.POLISH_PATH), 'POLISH_PATH 要登记在 routeTable()')
	assert.equal(typeof routes.get(host.POLISH_PATH)[0], 'function', 'handler 是函数')
})
