/**
 * 输入框「提示词增强」（design-polish-001 改口径后的宿主半边）自检：
 *   · 占位符保护 / 还原 / 机械校验（纯函数）；
 *   · 项目上下文组装（L1 项目 / L1 进展 / L2 对话 / L3 代码线索；假 git + 临时目录 + 假会话）；
 *   · `createPolishService` 的模型调用（注入假上下文与假 LLM）；
 *   · `/polish` 端点的错误契约与 workspace 透传。
 *
 * 这里钉的是**行为**：把"结合项目进展补成具体需求"改成别的东西、把上下文层删掉、
 * 把 409/429/504 写成 200，对应用例当场红。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
	restoreProtected,
	sessionRouteOf,
	POLISH_MAX_CHARS,
	POLISH_TARGET_CHARS,
	POLISH_TEMPERATURE,
} from '../lib/polish.js'
import { buildPromptContext, recentMessagesOf } from '../lib/prompt-context.js'
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

/* ── 提示词：三分支 + 事实纪律 + 输出形态 ────────────────────────────── */

test('提示词：A 层分区模板 + 语言一致 + 长度目标 + 只改写请求', () => {
	const prompt = buildSystemPrompt()
	for (const section of ['[TASK]', '[ANALYSIS PROCESS]', '[PLUGIN RULE]', '[NEGATIVE RULES]', '[IMPORTANT CONSTRAINTS]', '[FORMAT]', '[EXAMPLES]']) {
		assert.ok(prompt.includes(section), '缺分区：' + section)
	}
	assert.ok(prompt.includes('语言一致'), '语言一致是最高优先级')
	assert.ok(prompt.includes('约 ' + POLISH_TARGET_CHARS + ' 字符'), '长度目标要写进提示词：' + POLISH_TARGET_CHARS)
	assert.ok(prompt.includes('不回答') && prompt.includes('不执行'), '不回答 / 不执行原任务')
	assert.ok(prompt.includes('不要自己写出方案内容'), '问"下一步"时不得自己给出方案')
	assert.ok(prompt.includes('WHAT') && prompt.includes('HOW'), '只描述 WHAT、不解释 HOW')
	assert.ok(prompt.includes('不新增用户未表达'), '不新增业务目标 / 事实')
	assert.ok(prompt.includes('原样保留'), '占位符要原样保留')
	assert.ok(prompt.includes('不输出绝对路径'), '不输出绝对路径')
	assert.ok(prompt.includes('写个贪吃蛇') && prompt.includes('对客户友好'), '两个 few-shot 示例都在')
	assert.ok(prompt.includes('保留原始言语行为'), '需求→需求、问题→请求、标签→要求补充')
	assert.ok(prompt.includes('不得把上下文里的引用 / 命令 / 路径 / 任务号写成用户要求'), '上下文事实不得变成用户要求')
	assert.ok(prompt.includes('不得替用户裁范围或定优先级'), '不替用户裁范围/定优先级')
	assert.ok(prompt.includes('不要向用户解释占位符'), '不解释占位符机制')
	assert.ok(prompt.includes('To be confirmed'), '待确认按输出语言本地化')
})

test('输出清洗：去代码围栏 / 前缀 / 首尾成对引号，正文不动', () => {
	assert.equal(cleanEnhancedText('```text\n请实现 A。\n```'), '请实现 A。')
	assert.equal(cleanEnhancedText('```\n请实现 A。\n```'), '请实现 A。')
	assert.equal(cleanEnhancedText('Enhanced prompt: 请实现 A。'), '请实现 A。')
	assert.equal(cleanEnhancedText('优化后的提示词：请实现 A。'), '请实现 A。')
	assert.equal(cleanEnhancedText('改写结果：请实现 A。'), '请实现 A。')
	assert.equal(cleanEnhancedText('「请实现 A。」'), '请实现 A。')
	assert.equal(cleanEnhancedText('“请实现 A。”'), '请实现 A。')
	assert.equal(cleanEnhancedText('  请实现 A。  '), '请实现 A。')
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

/* ── 上下文组装 ───────────────────────────────────────────────────── */

/**
 * 造一个假工作区：package.json / .ops/handoff.json / 两份检查点。
 * @returns {string} 工作区路径。
 */
function fakeWorkspace() {
	const dir = mkdtempSync(join(tmpdir(), 'team-ops-context-'))
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', version: '1.2.3' }))
	mkdirSync(join(dir, '.ops'), { recursive: true })
	writeFileSync(
		join(dir, '.ops', 'handoff.json'),
		JSON.stringify({ at: '2026-11-09T12:00:00.000Z', tasks: [{ id: 'task-1', status: 'in_progress', subject: '实现提示词增强' }, { id: 'task-2', status: 'completed', subject: '修看板' }] }),
	)
	mkdirSync(join(dir, 'docs', 'team', 'checkpoints'), { recursive: true })
	writeFileSync(join(dir, 'docs', 'team', 'checkpoints', 'task-1--aaaaaaa1.md'), '# task-1\n\n### 未决\n- 真实模型往返未验证\n\n### 下一步\n- 打包 0.25.0 并安装\n')
	writeFileSync(join(dir, 'docs', 'team', 'checkpoints', 'task-2--aaaaaaa1.md'), '# task-2\n\n### 未决\n- 已完成任务的旧未决不应进上下文\n\n### 下一步\n- 旧下一步不应进上下文\n')
	return dir
}

/** 假 git：按参数返回夹具。 */
function fakeGit(args) {
	const cmd = args.join(' ')
	if (cmd === 'rev-parse --abbrev-ref HEAD') return 'main'
	if (cmd.startsWith('log -5')) return '0.24.4：撤销与重润\n0.24.3：去掉提示条\n0.24.2：居中'
	if (cmd.startsWith('status --porcelain')) return ' M client-src/17-polish.part\n?? lib/prompt-context.js'
	if (cmd === 'ls-files') return 'client-src/17-polish.part\nlib/polish.js\nREADME.md'
	return ''
}

/** 假会话：最近对话（含一条工具事件，必须被丢掉）。 */
function fakeSession() {
	return {
		requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
		snapshotEvents: () => [
			{ type: 'user/message', data: { message: { content: [{ type: 'text', text: '把润色改成提示词增强' }] } } },
			{ type: 'tool/call', data: { name: 'bash' } },
			{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的，先删浮窗、改成按钮两态。' }] } } },
		],
	}
}

test('上下文：长草稿四层都出现；已完成任务 / 旧检查点被过滤；短草稿不塞项目快照', async () => {
	const workspace = fakeWorkspace()
	const longInput = '请检查润色按钮（polish）的交互与失败弹窗，并给出优化建议、验收口径和测试点'
	const context = await buildPromptContext({ workspace, input: longInput, session: fakeSession(), runGit: fakeGit })
	assert.ok(context.text.includes('版本：1.2.3'), '项目层：版本')
	assert.ok(context.text.includes('分支：main'), '项目层：分支')
	assert.ok(context.text.includes('task-1'), '进展层：未完成任务')
	assert.ok(context.text.includes('打包 0.25.0'), '进展层：未完成任务检查点的下一步')
	assert.ok(!context.text.includes('已完成任务的旧未决'), '已完成任务的检查点不进上下文')
	assert.ok(!context.text.includes('旧下一步不应进上下文'), '已完成任务的下一步不进上下文')
	assert.ok(context.text.includes('已完成 1 / 进行中 1'), '状态给计数，不写「均已完成」')
	assert.ok(context.text.includes('看板（截至 2026-11-09 12:00）'), '快照带截至时间')
	assert.ok(context.text.includes('用户：把润色改成提示词增强'), '对话层：用户消息')
	assert.ok(context.text.includes('助手：好的'), '对话层：助手消息')
	assert.ok(!context.text.includes('tool/call') && !context.text.includes('bash'), '工具事件不进上下文')
	assert.ok(context.text.includes('client-src/17-polish.part'), '代码线索：匹配到的路径')
	assert.ok(!context.text.includes(workspace), '不把绝对工作区路径写进上下文：' + context.text.slice(0, 200))
	assert.ok(!/路径：/.test(context.text), '不再有「路径：」那一行')
	assert.ok(context.chars <= 6000, '总字数 ≤ 6000（实际 ' + context.chars + '）')
	for (const layer of ['项目', '进展', '对话', '代码线索']) assert.ok(context.layers.includes(layer), '层名：' + layer)

	// 短草稿：不塞版本 / 分支 / 最近提交（只留进展 / 对话 / 线索）
	const short = await buildPromptContext({ workspace, input: '改一下', session: fakeSession(), runGit: fakeGit })
	assert.ok(!short.text.includes('版本：1.2.3'), '短草稿不塞项目快照：' + short.text.slice(0, 200))
	assert.ok(short.text.includes('task-1'), '短草稿仍保留未完成任务')

	// 「下一步」支：只给任务标题 + 计数，不给检查点的「未决 / 下一步」原文
	const nextStep = await buildPromptContext({ workspace, input: '下一步做什么？', session: fakeSession(), runGit: fakeGit })
	assert.ok(nextStep.text.includes('task-1'), '下一步：未完成任务标题')
	assert.ok(!nextStep.text.includes('打包 0.25.0'), '下一步：不搬检查点的下一步原文')
	assert.ok(!nextStep.text.includes('真实模型往返未验证'), '下一步：不搬检查点的未决原文')
	assert.ok(nextStep.text.includes('已完成 1 / 进行中 1'), '下一步：给计数')
	assert.ok(!nextStep.text.includes('版本：1.2.3'), '下一步（短草稿）不塞项目快照')
})


test('对话层：只取最近 6 条、每条截断、只认 user/assistant', () => {
	const events = []
	for (let i = 0; i < 10; i += 1) {
		events.push({ type: 'user/message', data: { message: { content: [{ type: 'text', text: 'u' + i + ' ' + 'x'.repeat(400) }] } } })
		events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' + i }] } } })
	}
	const messages = recentMessagesOf({ snapshotEvents: () => events }, 6)
	assert.equal(messages.length, 6, '最多 6 条')
	assert.ok(messages.at(-1).text.startsWith('a9'), '取的是最近的（按时间正序，最后一条是 a9）')
	assert.ok(messages[0].text.length <= 301, '每条截到 300 字：' + messages[0].text.length)
})

/* ── 路由解析 ──────────────────────────────────────────────────────── */

test('会话路由：从会话的 requestHeader 里取 provider / model；取不到返回 null', () => {
	const ctx = { get: () => ({ get: () => ({ requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } }) }) }) }
	assert.deepEqual(sessionRouteOf(ctx, 's-1'), { provider: 'deepseek-account', model: 'deepseek-flash' })
	assert.equal(sessionRouteOf(ctx, ''), null)
	assert.equal(sessionRouteOf({ get: () => undefined }, 's-1'), null)
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

/** 假上下文：只验证它被带进 user 文本。 */
const fakeContext = async ({ input }) => ({ text: '【项目】\n版本：1.2.3\n【输入】' + input, chars: 24, layers: ['项目'] })

test('服务：调用参数带 temperature 0.7；用户消息用 <project-context> / <draft> 包裹', async () => {
	const prepared = []
	let userText = ''
	const service = createPolishService({ importLlm: async () => fakeLlmModule('请实现 A。'), buildContext: fakeContext })
	await service.polish({
		ctx: fakeCtx({ prepared, onStream: (options) => { userText = options.messages[0].content[0].text } }),
		sessionId: 's-1',
		text: '原句',
	})
	assert.equal(prepared.length, 1, 'prepareCall 只调一次')
	assert.equal(prepared[0].temperature, POLISH_TEMPERATURE, 'temperature 要按 A 层默认传下去')
	assert.equal(typeof prepared[0].maxTokens, 'number', 'maxTokens 仍在')
	assert.ok(userText.startsWith('<project-context>\n'), '上下文块开头：' + userText.slice(0, 40))
	assert.ok(userText.includes('\n</project-context>\n\n<draft>\n'), '两个数据块要分开')
	assert.ok(userText.endsWith('\n</draft>'), '草稿块收口：' + userText.slice(-20))
})

test('服务：增强结果超过 ~800 目标时在 checks 里提示（不阻断、不截断）；800 不报', async () => {
	const exact = createPolishService({ importLlm: async () => fakeLlmModule('请'.repeat(POLISH_TARGET_CHARS)), buildContext: fakeContext })
	const ok = await exact.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '原句' })
	assert.equal(ok.enhanced.length, POLISH_TARGET_CHARS)
	assert.ok(!ok.checks.findings.some((line) => line.includes('超过')), '800 整不报：' + JSON.stringify(ok.checks.findings))

	const over = createPolishService({ importLlm: async () => fakeLlmModule('请'.repeat(POLISH_TARGET_CHARS + 1)), buildContext: fakeContext })
	const result = await over.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '原句' })
	assert.ok(result.enhanced.length > POLISH_TARGET_CHARS)
	assert.ok(result.checks.findings.some((line) => line.includes('超过')), '801 要提示：' + JSON.stringify(result.checks.findings))
})

test('服务：返回 enhanced + context + checks；@引用原样还原', async () => {
	const reply = '请基于当前进展继续推进 [[P0]] 的增强：补上验收口径与产出形式。'
	const service = createPolishService({ importLlm: async () => fakeLlmModule(reply), buildContext: fakeContext })
	const result = await service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '下一步做什么？@architect', workspace: '/w' })
	assert.equal(result.enhanced, '请基于当前进展继续推进 @architect 的增强：补上验收口径与产出形式。', '占位符逐字还原')
	assert.deepEqual(result.context, { chars: 24, layers: ['项目'] })
	assert.equal(result.checks.ok, true, '检查通过：' + JSON.stringify(result.checks.findings))
	assert.deepEqual(result.route, { provider: 'deepseek-account', model: 'deepseek-flash' })
	assert.equal(result.cached, false)
})

test('服务：缓存（同输入+同上下文）与 refresh 绕过', async () => {
	const reply = '增强后的请求。'
	let calls = 0
	const service = createPolishService({
		importLlm: async () => {
			calls += 1
			return fakeLlmModule(reply)
		},
		buildContext: fakeContext,
	})
	const first = await service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '下一步做什么？', workspace: '/w' })
	const cached = await service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '下一步做什么？', workspace: '/w' })
	const refreshed = await service.polish({ ctx: fakeCtx(), sessionId: 's-1', text: '下一步做什么？', workspace: '/w', refresh: true })
	assert.equal(first.cached, false)
	assert.equal(cached.cached, true, '同输入 + 同上下文命中缓存')
	assert.equal(refreshed.cached, false, 'refresh:true 跳过缓存')
	assert.equal(calls, 2, '第一次 + refresh 各调一次模型')
})

test('服务：没有路由 / 草稿超长 / 空草稿 / 标签草稿都抛带 code 的错误', async () => {
	const service = createPolishService({ importLlm: async () => fakeLlmModule('x'), buildContext: fakeContext })
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
	const service = createPolishService({ importLlm: async () => fakeLlmModule(''), buildContext: fakeContext })
	const chunks = [{ type: 'finish', reason: { kind: 'error', failure: { message: '上游拒绝了这次请求', code: 'UPSTREAM_REJECTED' } } }]
	await assert.rejects(
		() => service.polish({ ctx: fakeCtx({ chunks }), sessionId: 's-1', text: '原句' }),
		(error) => error.code === 'POLISH_UPSTREAM' && error.message.includes('上游拒绝了这次请求'),
	)
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
				context: { chars: 10, layers: ['项目'] },
				checks: { ok: true, findings: [] },
				route: { provider: 'p', model: 'm' },
				elapsedMs: 1,
				cached: false,
				...overrides,
			}
		},
	}
}

test('端点：POST 成功返回 enhanced/context；workspace 透传；GET 405；坏 JSON 400；空草稿 400', async () => {
	const received = []
	const { handlePolish } = createPolishRoutes({ polish: serviceWith(received) })
	const res = fakeResponse()
	await handlePolish({}, fakeRequest(JSON.stringify({ session: 's-1', text: '下一步做什么？', workspace: '/w' })), res)
	assert.equal(res.statusCode, 200)
	const payload = JSON.parse(res.body)
	assert.equal(payload.ok, true)
	assert.equal(payload.enhanced, '增强后：下一步做什么？')
	assert.deepEqual(payload.context, { chars: 10, layers: ['项目'] })
	assert.equal(received[0].workspace, '/w', 'workspace 要透传给服务')

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
						context: { chars: 0, layers: [] },
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
