/**
 * 输入框「提示词增强」自检（A 层严格对齐 WorkBuddy `enhance-prompt`）：
 *   · 双提示词模板 Ur / Wr 与 renderUserPrompt、stripWrappingQuotes 清洗；
 *   · 占位符保护 / 还原 / 机械校验（纯函数）；
 *   · `createPolishService` 的模型调用（注入假 LLM）；
 *   · `/polish` 端点的错误契约。
 *
 * 这里钉的是**行为**：把 Ur/Wr 换回中文分区、重新注入项目上下文、恢复围栏/前缀清洗、
 * 把 409/429/504 写成 200，对应用例当场红。
 * `lib/prompt-context.js` 已移除：A 层严格对齐 WorkBuddy，无项目上下文。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
	buildSystemPrompt,
	cleanEnhancedText,
	createPolishService,
	effectiveDraftContentOf,
	languageFindingsOf,
	leakFindingsOf,
	mechanicalFindingsOf,
	missingNumbersOf,
	protectSegmentsOf,
	renderUserPrompt,
	restoreProtected,
	sessionRouteOf,
	stripZeroWidthOf,
	ENHANCE_SYSTEM_PROMPT,
	ENHANCE_USER_TEMPLATE,
	POLISH_MAX_CHARS,
	POLISH_TARGET_CHARS,
	POLISH_TEMPERATURE,
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

/* ── 纯函数：机械校验（数字 + 占位符；不再有长度比例） ───────────────── */

test('机械校验：原文数字缺失 / 占位符丢失都要报；干净结果零发现；变长不算可疑', () => {
	assert.deepEqual(missingNumbersOf('预算 3000，占 12.5%，再 3000', '预算 3000，占 12.5%'), ['3000'])
	assert.ok(mechanicalFindingsOf({ original: '共 12 个任务，改 3 处', polished: '共 12 个任务' }).some((line) => line.includes('3')))
	assert.ok(mechanicalFindingsOf({ original: 'x', polished: 'x', missingTokens: ['[[P0]]'] }).some((line) => line.includes('[[P0]]')))
	assert.deepEqual(mechanicalFindingsOf({ original: '把这件事交给他。', polished: '把这件事交给他处理，并补上验收口径与产出形式。' }), [], '增强会变长，不算可疑')
})

/* ── 提示词：逐字对齐 WorkBuddy Ur / Wr ─────────────────────────────── */

test('提示词：Ur 逐字（TASK / ANALYSIS / CONSTRAINTS / FORMAT / Examples，无 NEGATIVE 分区）', () => {
	const prompt = buildSystemPrompt()
	assert.equal(prompt, ENHANCE_SYSTEM_PROMPT, 'buildSystemPrompt 必须逐字返回 Ur')
	for (const section of ['TASK:', 'ANALYSIS PROCESS:', 'IMPORTANT CONSTRAINTS:', 'FORMAT:', 'Example:']) {
		assert.ok(prompt.includes(section), '缺段：' + section)
	}
	assert.ok(!prompt.includes('[NEGATIVE RULES]'), '真实 Ur 没有 NEGATIVE RULES 分区')
	assert.ok(!prompt.includes('PLUGIN RULE'), '不得夹带本插件自有规则')
	assert.ok(prompt.includes('Language matching is the highest priority'), '语言一致最高优先级')
	assert.ok(prompt.includes('around 800 characters'), '~800 字符目标由 Ur 给出')
	assert.ok(prompt.includes('Do NOT answer questions'), '不回答原问题')
	assert.ok(prompt.includes('focus on WHAT'), '只描述 WHAT、不解释 HOW')
	assert.ok(prompt.includes('Do NOT suggest specific technologies'), '不主动指定技术栈')
	assert.ok(prompt.includes('A website for my dog') && prompt.includes('genie router'), '两组 few-shot 都在')
	assert.ok(!prompt.includes('project-context') && !prompt.includes('<draft>'), 'system 侧不得有上下文标签')
})

test('提示词：Wr 逐字（USER INPUT {input} / 语言一致 6 条 / ENHANCEMENT REQUIREMENTS / BAD-GOOD）', () => {
	const tpl = ENHANCE_USER_TEMPLATE
	assert.ok(tpl.includes('{input}'), 'user 模板必须有 {input} 占位')
	assert.ok(tpl.includes('CRITICAL PRIORITY - LANGUAGE CONSISTENCY'), 'user 侧二次强调语言一致')
	assert.ok(tpl.includes('ENHANCEMENT REQUIREMENTS'), 'user 侧增强要求')
	assert.ok(tpl.includes('BAD OUTPUT EXAMPLE') && tpl.includes('GOOD OUTPUT EXAMPLE'), 'BAD/GOOD 输出示例')
	assert.ok(tpl.includes('markdown fences'), '要求不输出 markdown 围栏')
	assert.ok(!tpl.includes('project-context'), 'user 侧不得注入项目上下文')
	const rendered = renderUserPrompt('写个贪吃蛇')
	assert.ok(rendered.includes('写个贪吃蛇'), '草稿替换进 {input}')
	assert.ok(!rendered.includes('{input}'), '{input} 已替换')
	assert.ok(rendered.startsWith('You are a prompt enhancement assistant'), '前缀保持 Wr 原文')
	// 函数式 replace：草稿里的 $& 不能被当成替换语法解释（字符串 replace 会把它换成 {input}）。
	assert.ok(renderUserPrompt('$&').includes('$&'), '$ 模式不被解释')
})

test('输出清洗：逐字对齐 stripWrappingQuotes —— 只剥首尾引号字符，不动围栏 / 前缀', () => {
	assert.equal(cleanEnhancedText('  请实现 A。  '), '请实现 A。')
	assert.equal(cleanEnhancedText('"请实现 A。"'), '请实现 A。', '成对直双引号')
	assert.equal(cleanEnhancedText('“请实现 A。”'), '请实现 A。', '成对弯引号')
	// 真实实现首尾各自独立剥、不要求成对。
	assert.equal(cleanEnhancedText('"请实现 A。'), '请实现 A。', '单边开头引号也剥')
	assert.equal(cleanEnhancedText('请实现 A。"'), '请实现 A。', '单边结尾引号也剥')
	// 不碰代码围栏、不碰前缀、不剥直角引号（这些都不是 WorkBuddy 的清洗逻辑）。
	assert.equal(cleanEnhancedText('```text\n请实现 A。\n```'), '```text\n请实现 A。\n```', '代码围栏保持原样')
	assert.equal(cleanEnhancedText('Enhanced prompt: 请实现 A。'), 'Enhanced prompt: 请实现 A。', '前缀保持原样')
	assert.equal(cleanEnhancedText('「请实现 A。」'), '「请实现 A。」', '直角引号不剥')
	assert.equal(cleanEnhancedText('请保留 `code` 与 12 个数字。'), '请保留 `code` 与 12 个数字。', '正文里的引号 / 数字不许动')
})

test('近空判断：只有标签 / 标点 / 数字的草稿算空；短但具体的草稿放行', () => {
	assert.equal(effectiveDraftContentOf('英文需求：'), '')
	assert.equal(effectiveDraftContentOf('带引用'), '')
	assert.equal(effectiveDraftContentOf('3、英文需求：'), '')
	assert.equal(effectiveDraftContentOf('？？？'), '')
	assert.equal(effectiveDraftContentOf('123'), '')
	assert.equal(effectiveDraftContentOf('写个贪吃蛇'), '写个贪吃蛇', '短但具体，不许误杀')
	assert.equal(effectiveDraftContentOf('英文需求：make it faster'), 'makeitfaster')
})

test('语言 / 泄漏发现：中文进英文出、英文进中文出、占位符与上下文编号都要报', () => {
	assert.ok(languageFindingsOf('英文需求：', 'A long English request with many words and one 待确认: tail. ' + 'x '.repeat(300)).some((line) => line.includes('语言不一致')))
	assert.ok(languageFindingsOf('请把按钮改快一点', 'Make the button faster.').some((line) => line.includes('语言不一致')))
	assert.deepEqual(languageFindingsOf('把按钮改快一点', '请把按钮改快一点，并补上验收口径。'), [], '中文进中文出不报')
	assert.deepEqual(languageFindingsOf('make it faster', 'Make it faster and add a test.'), [], '英文进英文出不报')
	assert.ok(leakFindingsOf({ original: '把结果给我', polished: '结果见 [[P0]]。' }).some((line) => line.includes('占位符')))
	assert.ok(leakFindingsOf({ original: '带引用', polished: '原样保留 @qa 占位符。' }).some((line) => line.includes('保护规则')))
	assert.ok(leakFindingsOf({ original: '改一下', polished: '请处理 task-19 的收尾。' }).some((line) => line.includes('task-19')))
	assert.deepEqual(leakFindingsOf({ original: '看 task-19', polished: '请处理 task-19 的收尾。' }), [], '输入里本来就有的编号不算泄漏')
})

/* ── 会话夹具：`fakeCtx` 取路由用 ──────────────────────────────────── */

/** 假会话：只给 requestHeader（`sessionRouteOf` 取 provider / model 用）。 */
function fakeSession() {
	return {
		requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
	}
}

/* ── 路由解析 ──────────────────────────────────────────────────────── */

test('会话路由：从会话的 requestHeader 里取 provider / model；取不到返回 null', async () => {
	const ctx = { get: () => ({ get: () => ({ requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } }) }) }) }
	assert.deepEqual(await sessionRouteOf(ctx, 's-1'), { provider: 'deepseek-account', model: 'deepseek-flash' })
	assert.equal(await sessionRouteOf(ctx, ''), null)
	assert.equal(await sessionRouteOf({ get: () => undefined }, 's-1'), null)
})

/* ── 服务：假上下文 + 假 LLM 走完整链路 ────────────────────────────── */

/** 假 LLM 模块：增强结果由测试给定。 */
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

/** 假 ctx：sessions（路由 + 最近对话）与 llm（假 prepareCall/stream；`chunks` 可注入流块）。 */
function fakeCtx({ route = { provider: 'deepseek-account', model: 'deepseek-flash' }, chunks = [{ type: 'chunk' }], prepared = null, onStream = null } = {}) {
	return {
		get: (name) => {
			if (name === 'sessions') return route === null ? undefined : { get: () => fakeSession() }
			if (name === 'llm') {
				return {
					prepareCall: async (config) => {
						if (Array.isArray(prepared)) prepared.push(config)
						return {
							config,
							stream: async function* (options) {
								if (typeof onStream === 'function') onStream(options)
								for (const chunk of chunks) yield chunk
							},
						}
					},
				}
			}
			return undefined
		},
	}
}

test('服务：system=Ur、user=Wr({input})；无项目上下文；调用带 temperature 0.7', async () => {
	const prepared = []
	let system = ''
	let userText = ''
	const service = createPolishService({ importLlm: async () => fakeLlmModule('请实现 A。') })
	await service.polish({
		ctx: fakeCtx({ prepared, onStream: (options) => { userText = options.messages[0].content[0].text; system = options.system } }),
		sessionId: 's-1',
		text: '原句',
	})
	assert.equal(prepared.length, 1, 'prepareCall 只调一次')
	assert.equal(prepared[0].temperature, POLISH_TEMPERATURE, 'temperature 0.7 传下去')
	assert.equal(typeof prepared[0].maxTokens, 'number', 'maxTokens 仍在')
	assert.equal(system, ENHANCE_SYSTEM_PROMPT, 'system 逐字是 Ur')
	assert.equal(userText, renderUserPrompt('原句'), 'user 逐字是 Wr 把草稿替换进 {input}')
	assert.ok(!userText.includes('<project-context>') && !userText.includes('<draft>'), 'A 层无项目上下文标签')
	assert.ok(!userText.includes('版本：') && !userText.includes('【项目】'), '不再注入任何项目事实')
})

test('服务：增强结果超过 ~800 目标时在 checks 里提示（不阻断、不截断）；800 不报', async () => {
	const exact = createPolishService({ importLlm: async () => fakeLlmModule('请'.repeat(POLISH_TARGET_CHARS)) })
	const ok = await exact.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '原句' })
	assert.equal(ok.enhanced.length, POLISH_TARGET_CHARS)
	assert.ok(!ok.checks.findings.some((line) => line.includes('超过')), '800 整不报：' + JSON.stringify(ok.checks.findings))

	const over = createPolishService({ importLlm: async () => fakeLlmModule('请'.repeat(POLISH_TARGET_CHARS + 1)) })
	const result = await over.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '原句' })
	assert.ok(result.enhanced.length > POLISH_TARGET_CHARS)
	assert.ok(result.checks.findings.some((line) => line.includes('超过')), '801 要提示：' + JSON.stringify(result.checks.findings))
})

test('服务：返回 enhanced + checks（无 context）；@引用原样还原', async () => {
	const reply = '请基于当前进展继续推进 [[P0]] 的增强：补上验收口径与产出形式。'
	const service = createPolishService({ importLlm: async () => fakeLlmModule(reply) })
	const result = await service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '下一步做什么？@architect' })
	assert.equal(result.enhanced, '请基于当前进展继续推进 @architect 的增强：补上验收口径与产出形式。', '占位符逐字还原')
	assert.equal(result.context, undefined, 'A 层无上下文：不再回执 context')
	assert.equal(result.checks.ok, true, '检查通过：' + JSON.stringify(result.checks.findings))
	assert.deepEqual(result.route, { provider: 'deepseek-account', model: 'deepseek-flash' })
	assert.equal(result.cached, false)
})

test('服务：缓存（同输入 + 同路由）与 refresh 绕过', async () => {
	const reply = '增强后的请求。'
	let calls = 0
	const service = createPolishService({
		importLlm: async () => {
			calls += 1
			return fakeLlmModule(reply)
		},
	})
	const first = await service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '下一步做什么？' })
	const cached = await service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '下一步做什么？' })
	const refreshed = await service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '下一步做什么？', refresh: true })
	assert.equal(first.cached, false)
	assert.equal(cached.cached, true, '同输入 + 同路由命中缓存')
	assert.equal(refreshed.cached, false, 'refresh:true 跳过缓存')
	assert.equal(calls, 2, '第一次 + refresh 各调一次模型')
})

test('服务：没有路由 / 草稿超长 / 空草稿 / 标签草稿都抛带 code 的错误', async () => {
	const service = createPolishService({ importLlm: async () => fakeLlmModule('x') })
	await assert.rejects(() => service.polish({ ctx: fakeCtx({ route: null }), sessionId: 's-1', text: '原句' }), (error) => error.code === 'POLISH_NO_ROUTE')
	await assert.rejects(() => service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: 'x'.repeat(POLISH_MAX_CHARS + 1) }), (error) => error.code === 'POLISH_TOO_LONG')
	await assert.rejects(() => service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '   ' }), (error) => error.code === 'POLISH_EMPTY')
	const prepared = []
	await assert.rejects(
		() => service.polish({ ctx: fakeCtx({ prepared }), sessionId: 's-1', text: '英文需求：' }),
		(error) => error.code === 'POLISH_TOO_VAGUE',
	)
	assert.equal(prepared.length, 0, '标签草稿不许调用模型')
})

test('服务：上游 finish/error 块透出原因（不再误报「模型没有返回内容」）', async () => {
	const service = createPolishService({ importLlm: async () => fakeLlmModule('') })
	const chunks = [{ type: 'finish', reason: { kind: 'error', failure: { message: '上游拒绝了这次请求', code: 'UPSTREAM_REJECTED' } } }]
	await assert.rejects(
		() => service.polish({ ctx: fakeCtx({ chunks }), sessionId: 's-1', text: '原句' }),
		(error) => error.code === 'POLISH_UPSTREAM' && error.message.includes('上游拒绝了这次请求'),
	)
})

test('零宽空格：对齐 WorkBuddy normalizeEnhanceText —— 入口清理 / 近空判定 / 服务端不调模型', async () => {
	assert.equal(stripZeroWidthOf('\u200B写个贪吃蛇\u200B'), '写个贪吃蛇')
	assert.equal(stripZeroWidthOf('\u200B\u200B'), '')
	assert.equal(effectiveDraftContentOf('\u200B\u200B'), '', '纯零宽草稿算空')
	assert.equal(effectiveDraftContentOf('\u200B？\u200B'), '', '零宽 + 标点也算空')
	assert.equal(effectiveDraftContentOf('\u200B写个贪吃蛇\u200B'), '写个贪吃蛇', '有内容不许误杀')
	const service = createPolishService({ importLlm: async () => fakeLlmModule('x') })
	const prepared = []
	await assert.rejects(
		() => service.polish({ ctx: fakeCtx({ prepared }), sessionId: 's-1', text: '\u200B\u200B' }),
		(error) => error.code === 'POLISH_EMPTY',
		'纯零宽草稿按空拒绝',
	)
	assert.equal(prepared.length, 0, '纯零宽草稿不许调用模型')
})

/* ── 端点 ──────────────────────────────────────────────────────────── */

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

/** 假 service：记录入参，返回契约字段。 */
function serviceWith(received, overrides = {}) {
	return {
		polish: async (args) => {
			received.push(args)
			return {
				enhanced: '增强后：' + args.text,
				checks: { ok: true, findings: [] },
				route: { provider: 'p', model: 'm' },
				elapsedMs: 1,
				cached: false,
				...overrides,
			}
		},
	}
}

test('端点：POST 成功返回 enhanced/checks；不透传 workspace；GET 405；坏 JSON 400；空草稿 400', async () => {
	const received = []
	const { handlePolish } = createPolishRoutes({ polish: serviceWith(received) })
	const res = fakeResponse()
	await handlePolish({}, fakeRequest(JSON.stringify({ session: 's-1', text: '下一步做什么？', workspace: '/w' })), res)
	assert.equal(res.statusCode, 200)
	const payload = JSON.parse(res.body)
	assert.equal(payload.ok, true)
	assert.equal(payload.enhanced, '增强后：下一步做什么？')
	assert.equal(received[0].sessionId, 's-1')
	assert.equal(received[0].text, '下一步做什么？')
	assert.equal(received[0].workspace, undefined, 'A 层无上下文：请求体里的 workspace 被忽略，不透传给服务')

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
	const thrower = (code) => ({
		polish: async () => {
			throw Object.assign(new Error('假失败'), { code })
		},
	})
	for (const [code, status, reason] of [
		['POLISH_NO_ROUTE', 409, 'no-route'],
		['POLISH_TOO_VAGUE', 400, 'too-vague'],
		['POLISH_TIMEOUT', 504, 'timeout'],
		['POLISH_UPSTREAM', 502, 'upstream'],
		['SOMETHING_ELSE', 502, 'upstream'],
	]) {
		const res = fakeResponse()
		await createPolishRoutes({ polish: thrower(code) }).handlePolish({}, fakeRequest(JSON.stringify({ session: 's-1', text: '原句' })), res)
		assert.equal(res.statusCode, status, code + ' 要回 ' + status)
		assert.equal(JSON.parse(res.body).reason, reason)
	}
	const tooLarge = fakeResponse()
	const huge = JSON.stringify({ session: 's-1', text: 'x'.repeat(64 * 1024) })
	await createPolishRoutes({ polish: serviceWith([]) }).handlePolish({}, fakeRequest(huge), tooLarge)
	assert.equal(tooLarge.statusCode, 413)
})

test('端点：并发 1（同一会话第二次回 busy）与每分钟 6 次限流', async () => {
	let release = null
	const slowService = {
		polish: async () =>
			new Promise((resolve) => {
				release = () =>
					resolve({
						enhanced: 'x',
						checks: { ok: true, findings: [] },
						route: { provider: 'p', model: 'm' },
						elapsedMs: 1,
						cached: false,
					})
			}),
	}
	const { handlePolish } = createPolishRoutes({ polish: slowService })
	const first = handlePolish({}, fakeRequest(JSON.stringify({ session: 'busy-1', text: '原句' })), fakeResponse())
	await new Promise((resolve) => setTimeout(resolve, 5))
	const second = fakeResponse()
	await handlePolish({}, fakeRequest(JSON.stringify({ session: 'busy-1', text: '原句' })), second)
	assert.equal(second.statusCode, 409, '正在增强时再点回 409 busy')
	assert.equal(JSON.parse(second.body).reason, 'busy')
	release()
	await first

	const fast = createPolishRoutes({ polish: serviceWith([]) }).handlePolish
	let last = null
	for (let i = 0; i < 7; i += 1) {
		last = fakeResponse()
		await fast({}, fakeRequest(JSON.stringify({ session: 'rate-1', text: '第 ' + i + ' 次' })), last)
	}
	assert.equal(last.statusCode, 429, '第 7 次要被限流')
	assert.equal(JSON.parse(last.body).reason, 'rate-limited')
})

test('宿主路由表：/polish 已登记', async () => {
	const host = await import('../lib/board-view.host.js')
	const routes = host.routeTable()
	assert.ok(routes.has(host.POLISH_PATH), 'POLISH_PATH 要登记在 routeTable()')
	assert.equal(typeof routes.get(host.POLISH_PATH)[0], 'function', 'handler 是函数')
})
