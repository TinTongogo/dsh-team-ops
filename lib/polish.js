/**
 * 输入框润色的宿主半边（纯逻辑 + 模型调用）。
 *
 * 为什么在这里而不是客户端：模型调用与「借用当前会话路由」只有宿主拿得到（`ctx.get('llm')` /
 * `ctx.get('sessions')`）；客户端只负责入口与浮窗（发现、对比、采纳），契约见
 * `docs/design/design-polish-001.md` 与 `lib/polish-routes.js`。
 *
 * 三层分工（每一层都可单测）：
 *   1. **预处理**：把代码块 / 行内代码 / 链接 / 路径 / `@引用` / `/命令` 换成不可改写的占位符，
 *      润色后逐字还原 —— 模型再怎么"顺手改"也碰不到这些片段；
 *   2. **模型调用**：`ctx.llm.prepareCall` + `call.stream` + `BlockAssembler`（与 DSH 自带的
 *      session-title 同一条路）；route 借**当前会话**最近一次请求的 provider/model；
 *   3. **机械校验**：数字多重集、占位符原样、长度护栏 —— 不花模型，却是"别改事实"的最后一道闸。
 *
 * 依赖注入口（本文件不静态 import `@deepseek-ai/*`）：`createPolishService({ importLlm })`，
 * 生产用动态 import，自检注入假实现 —— 于是 `npm test` 在纯 node 里也能跑。
 */

import { createHash } from 'node:crypto'

/** 一次润色允许的最大字符数（超过就拒：截断会丢意图）。 */
export const POLISH_MAX_CHARS = 4000
/** 端点读体上限（字符上限之外再留 JSON 包装的余量）。 */
export const POLISH_BODY_LIMIT = 32 * 1024
/** 一次模型调用的总超时（含首包）。 */
export const POLISH_TIMEOUT_MS = 20_000
/** 同一草稿的命中去重窗口。 */
const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 32
/** 结果长度护栏：短于原文这个比例 / 长于这个比例都算可疑。 */
const MIN_RATIO = 0.4
const MAX_RATIO = 2.2

/**
 * 不可改写片段的识别顺序（先长后短：代码块先于行内代码，路径先于命令）。
 * 命中后整体换成 `[[P<n>]]` 占位符；提示词要求模型**逐字保留**占位符。
 */
const PROTECT_PATTERN = new RegExp(
	[
		'```[\\s\\S]*?```',
		'`[^`\\n]+`',
		'https?://[^\\s<>"\'）)\\]}]+',
		'[A-Za-z]:\\\\[^\\s]+',
		'(?:/[A-Za-z0-9_.-]+){2,}/?',
		'(?<![A-Za-z0-9])@[a-z][a-z0-9-]*',
		'(?<![A-Za-z0-9])/[a-z][a-z0-9-]*',
	].join('|'),
	'g',
)

/** 数字（含小数、千分位逗号、百分号）：机械校验的比对单位。 */
const NUMBER_PATTERN = /\d+(?:[.,]\d+)*%?/g

/**
 * 把不可改写片段换成占位符。
 * @param {string} text - 原文。
 * @returns {{ masked: string, tokens: Array<{ id: string, text: string }> }} 占位后的正文与还原表。
 */
export function protectSegmentsOf(text) {
	const source = typeof text === 'string' ? text : ''
	const tokens = []
	const masked = source.replace(PROTECT_PATTERN, (match) => {
		const id = '[[P' + tokens.length + ']]'
		tokens.push({ id, text: match })
		return id
	})
	return { masked, tokens }
}

/**
 * 把占位符还原成原文；返回还原结果与「模型弄丢的占位符」清单。
 * @param {string} text - 模型返回的正文（可能含占位符）。
 * @param {Array<{ id: string, text: string }>} tokens - `protectSegmentsOf` 给的还原表。
 * @returns {{ text: string, missing: string[] }} 还原后的文本与丢失的占位符 id。
 */
export function restoreProtected(text, tokens) {
	const source = typeof text === 'string' ? text : ''
	const missing = []
	let out = source
	for (const token of Array.isArray(tokens) ? tokens : []) {
		if (out.indexOf(token.id) === -1) missing.push(token.id)
		out = out.split(token.id).join(token.text)
	}
	return { text: out, missing }
}

/**
 * 结果里应当出现、但没有出现的数字（多重集比较：原文出现两次、结果只剩一次也算丢）。
 * @param {string} original - 原文（已还原）。
 * @param {string} polished - 润色结果（已还原）。
 * @returns {string[]} 缺失的数字清单。
 */
export function missingNumbersOf(original, polished) {
	const countOf = (value) => {
		const counts = new Map()
		for (const hit of String(value ?? '').match(NUMBER_PATTERN) ?? []) {
			counts.set(hit, (counts.get(hit) ?? 0) + 1)
		}
		return counts
	}
	const have = countOf(polished)
	const missing = []
	for (const [number, needed] of countOf(original)) {
		const got = have.get(number) ?? 0
		if (got < needed) missing.push(number)
	}
	return missing
}

/**
 * 机械校验：数字、占位符、长度护栏。返回人能读懂的一条条发现（空数组 = 通过）。
 * @param {{ original: string, polished: string, missingTokens: string[] }} input - 原文 / 结果 / 丢失占位符。
 * @returns {string[]} 发现清单。
 */
export function mechanicalFindingsOf({ original, polished, missingTokens = [] }) {
	const findings = []
	if (missingTokens.length > 0) {
		findings.push(`润色结果漏掉了不可改写的片段（占位符 ${missingTokens.join('、')}），已按需人工确认。`)
	}
	const missing = missingNumbersOf(original, polished)
	if (missing.length > 0) findings.push(`原文里的数字在润色结果里找不到：${missing.join('、')}。`)
	const before = String(original ?? '').length
	const after = String(polished ?? '').length
	if (before >= 40) {
		const ratio = before === 0 ? 1 : after / before
		if (ratio < MIN_RATIO) findings.push(`润色结果只有原文的 ${Math.round(ratio * 100)}%（过短，可能删掉了信息）。`)
		else if (ratio > MAX_RATIO) findings.push(`润色结果有原文的 ${Math.round(ratio * 100)}%（过长，可能加了原文没有的信息）。`)
	}
	return findings
}

/** 提示词：只改表达不改事实；场景与语言自动识别；占位符逐字保留；只输出 JSON。 */
export function buildSystemPrompt() {
	return [
		'你是文字编辑。任务：在不改变作者意图与关键信息的前提下，让表达更准确、清晰。',
		'',
		'硬约束：',
		'1. 只改表达，不改事实：作者的意图、立场、结论、数字、专有名词、URL、文件路径、命令、代码、引用标记必须逐字保留；不增删信息。',
		'2. 输入里的 [[P0]]、[[P1]] 这类占位符代表不可改写的片段（代码 / 链接 / 路径 / @引用 / 命令）：必须原样保留，位置也不要移动。',
		'3. 修改优先级：歧义 > 冗余 > 语序 > 句子结构完整 > 用词准确 > 标点。',
		'4. 自动判断原文语言与场景（技术讨论 / 正式对外 / 日常沟通），保持原语言；技术场景保留术语与代码，正式场景去掉口语与情绪词，日常场景保留自然语气。',
		'5. 润色结果长度不超过原文的 120%；保留原有段落与换行结构；短文本不要缩水。',
		'6. 拿不准的片段保持原文不动。',
		'7. 只输出 JSON，不要解释、不要寒暄、不要代码块围栏。',
		'',
		'输出 JSON 形状（字段齐全，changes 可为空数组）：',
		'{"polished":"润色后的完整文本","language":"zh 或 en 等","scenario":"技术讨论 / 正式对外 / 日常沟通","changes":[{"kind":"歧义|冗余|语序|用词|标点|结构","before":"原片段","after":"新片段"}],"confidence":0.0}',
		'confidence 是你对"没有改变事实"的把握（0 到 1）。',
	].join('\n')
}

/**
 * 解析模型回复：容忍 ```json 围栏与前后杂字；解析失败退回纯文本。
 * @param {string} raw - 模型原文。
 * @returns {{ polished: string, language: string, scenario: string, changes: Array<object>, confidence: number, fallback: boolean }}
 */
export function parsePolishReply(raw) {
	const source = typeof raw === 'string' ? raw : ''
	const fallback = (text) => ({ polished: text, language: '', scenario: '', changes: [], confidence: 0, fallback: true })
	const unfenced = source.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?\s*```\s*$/, '').trim()
	const start = unfenced.indexOf('{')
	const end = unfenced.lastIndexOf('}')
	if (start === -1 || end <= start) {
		const plain = unfenced.trim()
		return plain === '' ? fallback(source.trim()) : { ...fallback(plain), fallback: true }
	}
	try {
		const parsed = JSON.parse(unfenced.slice(start, end + 1))
		if (parsed === null || typeof parsed !== 'object' || typeof parsed.polished !== 'string' || parsed.polished.trim() === '') {
			return fallback(unfenced)
		}
		const changes = Array.isArray(parsed.changes)
			? parsed.changes
					.filter((row) => row !== null && typeof row === 'object')
					.slice(0, 12)
					.map((row) => ({
						kind: typeof row.kind === 'string' ? row.kind.slice(0, 12) : '',
						before: typeof row.before === 'string' ? row.before.slice(0, 240) : '',
						after: typeof row.after === 'string' ? row.after.slice(0, 240) : '',
					}))
			: []
		const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : 0
		return {
			polished: parsed.polished,
			language: typeof parsed.language === 'string' ? parsed.language.slice(0, 16) : '',
			scenario: typeof parsed.scenario === 'string' ? parsed.scenario.slice(0, 24) : '',
			changes,
			confidence,
			fallback: false,
		}
	} catch {
		return fallback(unfenced)
	}
}

/**
 * 取当前会话最近一次请求的模型路由（provider / model）。
 *
 * 为什么不读插件配置：会话已经用哪条路由，润色就借哪条 —— 与用户发消息同一模型，才谈得上
 * "同一套表达习惯"；取不到（会话还没发过消息）就如实拒绝，不猜一个模型。
 * @param {object} ctx - 宿主 ctx。
 * @param {string} sessionId - 会话 id。
 * @returns {{ provider: string, model: string } | null}
 */
export function sessionRouteOf(ctx, sessionId) {
	try {
		if (typeof sessionId !== 'string' || sessionId === '') return null
		const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined
		const session = sessions !== null && typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
		const header = session !== null && session !== undefined && typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
		const config = header !== null && header !== undefined && typeof header === 'object' ? header.config : undefined
		if (config === null || config === undefined || typeof config !== 'object') return null
		if (typeof config.provider !== 'string' || config.provider === '') return null
		if (typeof config.model !== 'string' || config.model === '') return null
		return { provider: config.provider, model: config.model }
	} catch {
		return null
	}
}

/** 输出 token 上限：按字符粗估，短文本给最小值，防止模型"长篇发挥"。 */
function maxTokensOf(masked) {
	const estimate = Math.ceil(String(masked ?? '').length / 2) * 2
	return Math.max(256, Math.min(4096, estimate + 400))
}

/**
 * 创建润色服务（生产默认动态 import DSH 的 LLM 包；自检注入假实现）。
 * @param {{ importLlm?: () => Promise<{ createUserMessage: Function, BlockAssembler: Function }> }} deps - 依赖注入。
 * @returns {{ polish: Function }} 服务。
 */
export function createPolishService(deps = {}) {
	const importLlm = typeof deps.importLlm === 'function' ? deps.importLlm : () => import('@deepseek-ai/dsh-llm')
	const cache = new Map()

	/** 去掉过期缓存并把大小压回上限。 */
	const pruneCache = (now) => {
		for (const [key, entry] of cache) {
			if (now - entry.at > CACHE_TTL_MS) cache.delete(key)
		}
		while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
	}

	/**
	 * 润色一段草稿。
	 * @param {{ ctx: object, sessionId: string, text: string, signal?: AbortSignal }} input - 请求。
	 * @returns {Promise<object>} 契约里的 200 字段（不含 HTTP 状态码）。
	 * @throws {Error & { code?: string }} `POLISH_NO_ROUTE` / 上游错误。
	 */
	async function polish({ ctx, sessionId, text, signal }) {
		const started = Date.now()
		const original = String(text ?? '').trim()
		if (original === '') throw Object.assign(new Error('草稿为空'), { code: 'POLISH_EMPTY' })
		if (original.length > POLISH_MAX_CHARS) throw Object.assign(new Error('草稿超过 ' + POLISH_MAX_CHARS + ' 字上限'), { code: 'POLISH_TOO_LONG' })
		const route = sessionRouteOf(ctx, sessionId)
		if (route === null) throw Object.assign(new Error('本会话还没有可用的模型路由：先发一条消息再试。'), { code: 'POLISH_NO_ROUTE' })

		const cacheKey = createHash('sha256').update(route.provider + '\n' + route.model + '\n' + original).digest('hex')
		const now = Date.now()
		pruneCache(now)
		const hit = cache.get(cacheKey)
		if (hit !== undefined && now - hit.at <= CACHE_TTL_MS) {
			return { ...hit.value, elapsedMs: Date.now() - started, cached: true }
		}

		const { masked, tokens } = protectSegmentsOf(original)
		const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
		if (llm === null || llm === undefined || typeof llm.prepareCall !== 'function') {
			throw Object.assign(new Error('这个部署没有可用的 `llm` 服务：润色需要模型。'), { code: 'POLISH_NO_LLM' })
		}

		const mod = await importLlm()
		const { createUserMessage, BlockAssembler } = mod ?? {}
		if (typeof createUserMessage !== 'function' || typeof BlockAssembler !== 'function') {
			throw Object.assign(new Error('宿主 LLM 模块形状不对（缺 createUserMessage / BlockAssembler）'), { code: 'POLISH_LLM_SHAPE' })
		}

		const call = await llm.prepareCall(
			{ provider: route.provider, model: route.model, maxTokens: maxTokensOf(masked) },
			signal,
			(controls, model) => {
				const effort = model !== null && model !== undefined && typeof model === 'object' ? model?.reasoning?.efforts?.[0]?.id : undefined
				return typeof effort === 'string' && effort !== '' ? { ...controls, reasoningEffort: effort } : controls
			},
		)
		const messages = [createUserMessage({ content: [{ type: 'text', text: masked }], source: { kind: 'dsh-team-ops-polish' } })]
		const assembler = new BlockAssembler()
		for await (const chunk of call.stream({ ...call.config, messages, system: buildSystemPrompt(), sessionId, purpose: 'team-ops-polish', signal })) {
			assembler.push(chunk)
		}
		const blocks = typeof assembler.blocks === 'function' ? assembler.blocks() : []
		const raw = blocks
			.filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
			.map((block) => block.text)
			.join('')
		const parsed = parsePolishReply(raw)
		const restored = restoreProtected(parsed.polished, tokens)
		const findings = mechanicalFindingsOf({ original, polished: restored.text, missingTokens: restored.missing })
		const value = {
			polished: restored.text,
			language: parsed.language,
			scenario: parsed.scenario,
			changes: parsed.changes,
			confidence: parsed.confidence,
			checks: { ok: findings.length === 0, findings },
			route,
		}
		cache.set(cacheKey, { at: Date.now(), value })
		return { ...value, elapsedMs: Date.now() - started, cached: false }
	}

	return { polish }
}
