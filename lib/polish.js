/**
 * 输入框「提示词增强」的宿主半边（纯逻辑 + 模型调用）。
 *
 * 语义（人的口径）：不是改语病的"润色"，而是**把模糊输入结合当前项目的推进情况补成一句
 * 说 得清、可直接执行的请求**——要同时处理两类输入：
 *   · 说出一个需求 ⇒ 补全目标 / 范围 / 期望产出 / 验收口径 / 约束；
 *   · 问「下一步做什么」 ⇒ 基于进展、未决项、下一步记录给出具体的下一步请求（首选 + 备选）。
 *
 * 提示词结构按 `docs/design/design-prompt-enhance-002.md` 重设计：A 层用
 * TASK / ANALYSIS / NEGATIVE RULES / CONSTRAINTS / FORMAT / EXAMPLES 分区（参考 WorkBuddy）；
 * 项目上下文仍在，但作为 `<project-context>` 数据块，且只用于把请求写具体。
 *
 * 三层分工（每层可单测）：
 *   1. **上下文**：`lib/prompt-context.js` 组装 L1 项目快照 / L1 进展待办 / L2 最近对话 / L3 代码线索；
 *   2. **保护与调用**：代码 / 链接 / 路径 / `@引用` / 命令换成占位符（模型碰不到），再调 `ctx.llm`；
 *   3. **机械校验**：数字多重集 + 占位符原样（不花模型；发现只回执，不阻断）。
 *
 * 依赖注入口：`createPolishService({ importLlm })` —— 生产动态 import DSH 的 LLM 包，自检注入假实现
 * （纯 node 测试因此不静态依赖 `@deepseek-ai/*`）。
 */

import { createHash } from 'node:crypto'

import { buildPromptContext } from './prompt-context.js'

/** 一次增强允许的最大字符数（超过就拒：截断会丢意图）。 */
export const POLISH_MAX_CHARS = 4000
/** 端点读体上限。 */
export const POLISH_BODY_LIMIT = 32 * 1024
/** 一次模型调用的总超时（含首包）。 */
export const POLISH_TIMEOUT_MS = 20_000
/** 结果缓存窗口：**3 分钟**（"下一步"依赖的进展会变，缓存太久会给旧建议）。 */
export const POLISH_CACHE_TTL_MS = 3 * 60 * 1000
/** 输出目标（软约束，只进提示词）：约 800 字符，宁可精简。 */
export const POLISH_TARGET_CHARS = 800
/** 参考 WorkBuddy A 层的默认温度。 */
export const POLISH_TEMPERATURE = 0.7
/** 只有标签、没有具体内容的草稿（如「英文需求：」「带引用」）：不进模型。 */
export const POLISH_LABEL_WORDS = ['中文需求', '英文需求', '带引用', '需求', '示例', '测试', '英文', '中文']
const CACHE_MAX = 32

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
 * @param {string} polished - 增强结果（已还原）。
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
 * 机械校验：数字与占位符。
 *
 * 不再查「长度比例」：提示词增强本来就会显著变长（补全目标/范围/验收），按长度判可疑会误报。
 * @param {{ original: string, polished: string, missingTokens: string[] }} input - 原文 / 结果 / 丢失占位符。
 * @returns {string[]} 发现清单（空数组 = 通过）。
 */
export function mechanicalFindingsOf({ original, polished, missingTokens = [] }) {
	const findings = []
	if (missingTokens.length > 0) {
		findings.push(`增强结果漏掉了不可改写的片段（占位符 ${missingTokens.join('、')}）。`)
	}
	const missing = missingNumbersOf(original, polished)
	if (missing.length > 0) findings.push(`原文里的数字在增强结果里找不到：${missing.join('、')}。`)
	return findings
}

/**
 * 草稿里真正可改写的内容：去掉编号、标签词、空白、标点与数字后剩下的码点。
 * 只有标签（「英文需求：」「带引用」）或只有标点 / 数字的草稿返回空串。
 * @param {unknown} text - 草稿。
 * @returns {string} 有效内容。
 */
export function effectiveDraftContentOf(text) {
	let value = String(text ?? '').trim()
	value = value.replace(/^\s*\d+\s*[、.．)）]\s*/u, '')
	const label = new RegExp(`^(?:${POLISH_LABEL_WORDS.join('|')})\s*[:：]?\s*$`, 'u')
	if (label.test(value)) return ''
	value = value.replace(new RegExp(`^(?:${POLISH_LABEL_WORDS.join('|')})\s*[:：]\s*`, 'u'), '')
	return value.replace(/[\s\p{P}\p{S}\d]/gu, '')
}

/** 统计 CJK 字符数。 */
function cjkCountOf(text) {
	return (String(text ?? '').match(/[\u4e00-\u9fff\u3400-\u4dbf]/gu) ?? []).length
}

/**
 * 语言一致检查（发现只回执，不阻断）。
 * @param {string} original - 用户草稿。
 * @param {string} polished - 增强结果。
 * @returns {string[]} 发现清单。
 */
export function languageFindingsOf(original, polished) {
	const inputCjk = cjkCountOf(original)
	const output = String(polished ?? '')
	const outputCjk = cjkCountOf(output)
	const outputChars = Array.from(output).length
	const findings = []
	if (inputCjk > 0 && outputChars > 0 && outputCjk / outputChars < 0.02) {
		findings.push(`输入是中文，结果几乎没有中文（CJK ${outputCjk}/${outputChars}）：疑似语言不一致。`)
	}
	if (inputCjk === 0 && outputCjk > 0) {
		findings.push(`输入不是中文，结果含 ${outputCjk} 个中文字符：疑似语言不一致。`)
	}
	return findings
}

/**
 * 内部机制泄漏 / 上下文编号越权检查（发现只回执，不阻断）。
 * @param {{ original?: string, polished?: string }} input - 原文与结果。
 * @returns {string[]} 发现清单。
 */
export function leakFindingsOf({ original = '', polished = '' } = {}) {
	const source = String(original ?? '')
	const output = String(polished ?? '')
	const findings = []
	if (/\[\[P\d+\]\]/.test(output)) findings.push('结果残留内部占位符（[[P...]]）。')
	for (const [pattern, message] of [
		[/占位符/g, '结果向用户解释了内部占位符机制。'],
		[/原样保留/g, '结果把内部保护规则写成了用户要求。'],
	]) {
		if (pattern.test(output) && !pattern.test(source)) findings.push(message)
	}
	const idPattern = /\btask-\d+\b|--[0-9a-f]{8}\b/gi
	const inputIds = new Set(source.match(idPattern) ?? [])
	const leaked = [...new Set(output.match(idPattern) ?? [])].filter((id) => !inputIds.has(id))
	if (leaked.length > 0) findings.push(`结果带入了用户没提的项目编号：${leaked.join('、')}（来自上下文 / 检查点）。`)
	return findings
}

/**
 * 提示词增强的系统提示词：三类输入各一套规则 + 事实纪律 + 输出形态。
 * @returns {string} 系统提示词。
 */
export function buildSystemPrompt() {
	return [
		'你是提示词工程专家，服务于一个面向开发任务的 AI 助手。你的唯一工作：',
		'把用户草稿改写为更有效、更可直接执行的提示词，且不改变原意。',
		'',
		'[TASK]',
		'分析并增强【用户输入】，保持核心目标不变。改写结果将交给另一个 AI 助手执行。',
		'',
		'[ANALYSIS PROCESS]',
		'1. 评估原句：主目标 / 歧义与缺口 / 指令清晰度 / 缺失的上下文。',
		'2. 应用原则：清晰具体的指令、必要上下文、显式参数与约束、结构化输出格式、相关示例、语气与复杂度匹配、去除冗余。',
		'3. 生成改写：保留原目标、落实改进、只补充真实可实现的特性，不虚构前提。',
		'',
		'[PLUGIN RULE]（本项目特有）',
		'- 如果用户是在问「下一步做什么 / 给建议」：改写成一条**请求**，请助手基于当前进展给出下一步方案；不要自己写出方案内容，也不要替用户列待办清单或排优先级。',
		'- 【项目事实】只用于让请求更具体（范围 / 术语 / 约束 / 验收口径）；不得把里面的进展、结论、建议写成答案，也不得把里面的引用 / 命令 / 路径 / 任务号写成用户已经提出的要求；用户没说的写「待确认：…」。',
		'- 保留原始言语行为：需求 → 仍是「请修改 / 请实现」；问题 → 请求；只有标签 / 没有具体内容 → 要求用户补充，不要替用户编一个任务。',
		'- 上下文不得改变任务类型、不得替用户裁范围或定优先级。',
		'',
		'[NEGATIVE RULES]',
		'- 不回答原问题、不执行原任务，只把输入扩写为请求。',
		'- 不要求教程 / how-to、不索要代码片段，除非用户明确要求。',
		'- 不主动指定技术栈、框架或库，除非原文已提到。',
		'- 只描述 WHAT（要什么），不解释 HOW（怎么做），把实现决策留给执行方。',
		'- 不新增用户未表达的业务目标或事实性主张。',
		'- 不得把「改一下 X」改写成「给一份 X 的方案」；不得把「下一步做什么」改写成替用户排好优先级的清单。',
		'- 不得把上下文里的引用 / 命令 / 路径 / 任务号写成用户要求。',
		'- 不要向用户解释占位符 / 保护机制；输出里不出现 `[[P0]]`、`占位符`、`原样保留`。',
		'',
		'[IMPORTANT CONSTRAINTS]',
		'1. 语言一致为最高优先级：中文进中文出，英文进英文出；只有原文自身混用语言时才跟着混用。',
		`2. 长度约 ${POLISH_TARGET_CHARS} 字符以内，宁可精简，不堆砌。`,
		'3. [[P0]] 这类占位符代表不可改写片段：**原样保留**。',
		'4. 不输出绝对路径、项目根或本机目录；文件线索只写工作区相对路径，除非用户原话里明确写了绝对路径。',
		'5. 「待确认」按输出语言写：中文用「待确认：」，英文用「To be confirmed:」。',
		'',
		'[FORMAT]',
		'只输出改写后的提示词正文。不要标题、不要前缀、不要解释、不要代码围栏、不要包裹引号。',
		'',
		'[EXAMPLES]',
		'输入：把那个面板改一下',
		'输出：请修改「面板」相关实现（待确认：具体指哪个面板、期望改成什么样、是否涉及样式 / 文案 / 行为），改完后说明验收方式。',
		'',
		'输入：写个贪吃蛇',
		'输出：请实现一个完整可运行的贪吃蛇游戏。要求：基于网格的经典玩法，蛇持续移动，吃到食物后身体增长并加分；食物随机生成且不与蛇身重叠；支持方向键或 WASD 控制，禁止反向移动；包含撞墙与撞到自身的碰撞检测，触发后游戏结束；显示当前分数与最高分，最高分本地保存；提供开始、暂停、重新开始；界面简洁清晰，适配常见屏幕尺寸；生成完整项目文件与必要配置，无外部服务依赖、开箱即用。',
		'',
		'输入：把这段改成对客户友好的说法，别太技术',
		'输出：将下面这段内容改写为面向客户、通俗友好的表达，保持原语言与全部关键信息，去掉专业术语与内部黑话，不改变事实结论，语气克制礼貌，篇幅精简。',
	].join('\n')
}

/**
 * 清洗模型返回：去整体代码围栏 / 常见前缀 / 首尾成对引号，再 trim。
 * 参考 WorkBuddy A 层的 `clean()`；只做格式清理，不改正文内容。
 * @param {unknown} text - 模型原始输出。
 * @returns {string} 清洗后的正文。
 */
export function cleanEnhancedText(text) {
	let cleaned = String(text ?? '').trim()
	// 整体包裹的代码围栏（允许 ``` 或 ```lang）
	if (/^```[^\n]*\n[\s\S]*\n```$/.test(cleaned)) {
		cleaned = cleaned.replace(/^```[^\n]*\n/, '').replace(/\n```$/, '').trim()
	}
	// 常见前缀（参考文档的 clean）
	cleaned = cleaned.replace(/^(?:enhanced prompt|优化后的提示词|改写结果)\s*[:：]\s*/i, '')
	// 首尾成对引号（只剥一层）
	const pairs = [
		['"', '"'],
		["'", "'"],
		['「', '」'],
		['“', '”'],
	]
	for (const [open, close] of pairs) {
		if (cleaned.length >= 2 && cleaned.startsWith(open) && cleaned.endsWith(close)) {
			cleaned = cleaned.slice(1, -1).trim()
			break
		}
	}
	return cleaned.trim()
}

/**
 * 取当前会话最近一次请求的模型路由（provider / model）。
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

/**
 * 取会话对象（上下文组装要它拿最近对话）。
 * @param {object} ctx - 宿主 ctx。
 * @param {string} sessionId - 会话 id。
 * @returns {object | undefined} 会话对象。
 */
function sessionOf(ctx, sessionId) {
	try {
		const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined
		return sessions !== null && typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
	} catch {
		return undefined
	}
}

/** 输出 token 上限：增强会补内容，给足但封顶，防止长篇发挥。 */
function maxTokensOf(masked) {
	const estimate = Math.ceil(String(masked ?? '').length / 2) * 2
	return Math.max(512, Math.min(2048, estimate + 500))
}

/**
 * 创建提示词增强服务（生产默认动态 import DSH 的 LLM 包；自检注入假实现）。
 * @param {{ importLlm?: () => Promise<{ createUserMessage: Function, BlockAssembler: Function }>, buildContext?: Function }} deps - 依赖注入。
 * @returns {{ polish: Function }} 服务。
 */
export function createPolishService(deps = {}) {
	const importLlm = typeof deps.importLlm === 'function' ? deps.importLlm : () => import('@deepseek-ai/dsh-llm')
	const buildContext = typeof deps.buildContext === 'function' ? deps.buildContext : buildPromptContext
	const cache = new Map()

	/** 去掉过期缓存并把大小压回上限。 */
	const pruneCache = (now) => {
		for (const [key, entry] of cache) {
			if (now - entry.at > POLISH_CACHE_TTL_MS) cache.delete(key)
		}
		while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
	}

	/**
	 * 增强一段输入。
	 * @param {{ ctx: object, sessionId: string, text: string, workspace?: string, signal?: AbortSignal, refresh?: boolean }} input - 请求；
	 *   `refresh: true` 跳过结果缓存（真的再调一次模型）。
	 * @returns {Promise<object>} 契约里的 200 字段（不含 HTTP 状态码）。
	 * @throws {Error & { code?: string }} `POLISH_NO_ROUTE` / `POLISH_EMPTY` / `POLISH_TOO_LONG` / 上游错误。
	 */
	async function polish({ ctx, sessionId, text, workspace = '', signal, refresh = false }) {
		const started = Date.now()
		const original = String(text ?? '').trim()
		if (original === '') throw Object.assign(new Error('草稿为空'), { code: 'POLISH_EMPTY' })
		if (effectiveDraftContentOf(original) === '') {
			throw Object.assign(new Error('草稿只有标签，没有可改写的具体内容：先写清要改什么。'), { code: 'POLISH_TOO_VAGUE' })
		}
		if (original.length > POLISH_MAX_CHARS) throw Object.assign(new Error('草稿超过 ' + POLISH_MAX_CHARS + ' 字上限'), { code: 'POLISH_TOO_LONG' })
		const route = sessionRouteOf(ctx, sessionId)
		if (route === null) throw Object.assign(new Error('本会话还没有可用的模型路由：先发一条消息再试。'), { code: 'POLISH_NO_ROUTE' })

		const session = sessionOf(ctx, sessionId)
		const context = await buildContext({ workspace, input: original, session })
		const contextDigest = createHash('sha256').update(context.text).digest('hex').slice(0, 16)
		const cacheKey = createHash('sha256').update(route.provider + '\n' + route.model + '\n' + contextDigest + '\n' + original).digest('hex')
		const now = Date.now()
		pruneCache(now)
		const hit = refresh === true ? undefined : cache.get(cacheKey)
		if (hit !== undefined && now - hit.at <= POLISH_CACHE_TTL_MS) {
			return { ...hit.value, elapsedMs: Date.now() - started, cached: true }
		}

		const { masked, tokens } = protectSegmentsOf(original)
		const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
		if (llm === null || llm === undefined || typeof llm.prepareCall !== 'function') {
			throw Object.assign(new Error('这个部署没有可用的 `llm` 服务：提示词增强需要模型。'), { code: 'POLISH_NO_LLM' })
		}

		const mod = await importLlm()
		const { createUserMessage, BlockAssembler } = mod ?? {}
		if (typeof createUserMessage !== 'function' || typeof BlockAssembler !== 'function') {
			throw Object.assign(new Error('宿主 LLM 模块形状不对（缺 createUserMessage / BlockAssembler）'), { code: 'POLISH_LLM_SHAPE' })
		}

		// 外部文本（检查点 / 对话 / 草稿）里的同名标签要洗掉，避免提前闭合数据块。
		const tagSafe = (value) => String(value ?? '').replace(/<\/?(?:project-context|draft)>/gi, '［标签已移除］')
		const userText =
			'<project-context>\n' +
			(context.text === '' ? '（没有可用事实）' : tagSafe(context.text)) +
			'\n</project-context>\n\n' +
			'<draft>\n' +
			tagSafe(masked) +
			'\n</draft>'
		const call = await llm.prepareCall(
			{ provider: route.provider, model: route.model, maxTokens: maxTokensOf(masked), temperature: POLISH_TEMPERATURE },
			signal,
			(controls, model) => {
				const effort = model !== null && model !== undefined && typeof model === 'object' ? model?.reasoning?.efforts?.[0]?.id : undefined
				return typeof effort === 'string' && effort !== '' ? { ...controls, reasoningEffort: effort } : controls
			},
		)
		const messages = [createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'dsh-team-ops-enhance' } })]
		const assembler = new BlockAssembler()
		let upstreamFailure = null
		for await (const chunk of call.stream({ ...call.config, messages, system: buildSystemPrompt(), sessionId, purpose: 'team-ops-enhance', signal })) {
			// dsh-llm 把 adapter 抛出的错误转成 `finish`/`error` 块而不是 throw；不接住的话，
			// 上游拒绝会被下面误报成「模型没有返回内容」。
			if (
				chunk !== null && typeof chunk === 'object' && chunk.type === 'finish' &&
				chunk.reason !== null && typeof chunk.reason === 'object' && chunk.reason.kind === 'error'
			) {
				upstreamFailure = chunk.reason.failure
			}
			assembler.push(chunk)
		}
		const blocks = typeof assembler.blocks === 'function' ? assembler.blocks() : []
		const raw = blocks
			.filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
			.map((block) => block.text)
			.join('')
			.trim()
		if (raw === '') {
			if (upstreamFailure !== null && upstreamFailure !== undefined) {
				const detail = typeof upstreamFailure?.message === 'string' && upstreamFailure.message !== ''
					? upstreamFailure.message
					: (typeof upstreamFailure?.code === 'string' ? upstreamFailure.code : '未知上游错误')
				throw Object.assign(new Error('上游模型调用失败：' + detail), { code: 'POLISH_UPSTREAM' })
			}
			throw Object.assign(new Error('模型没有返回内容'), { code: 'POLISH_EMPTY_RESPONSE' })
		}
		const cleaned = cleanEnhancedText(raw)
		const restored = restoreProtected(cleaned, tokens)
		const findings = mechanicalFindingsOf({ original, polished: restored.text, missingTokens: restored.missing })
		findings.push(...languageFindingsOf(original, restored.text))
		findings.push(...leakFindingsOf({ original, polished: restored.text }))
		if (restored.text.length > POLISH_TARGET_CHARS) {
			findings.push(`增强结果 ${restored.text.length} 字符，超过 ~${POLISH_TARGET_CHARS} 的目标（未截断，必要时可手动精简）。`)
		}
		const value = {
			enhanced: restored.text,
			context: { chars: context.chars, layers: context.layers },
			checks: { ok: findings.length === 0, findings },
			route,
		}
		cache.set(cacheKey, { at: Date.now(), value })
		return { ...value, elapsedMs: Date.now() - started, cached: false }
	}

	return { polish }
}
