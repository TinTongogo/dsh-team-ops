/**
 * 输入框「提示词增强」的宿主半边（纯逻辑 + 模型调用）。
 *
 * A 层严格对齐 WorkBuddy `enhance-prompt` 子代理的真实实现
 * （`/Applications/WorkBuddy.app/Contents/Resources/app.asar` 里的 `handleEnhancePrompt`）：
 *   · system = `ENHANCE_SYSTEM_PROMPT`（Ur），user = `renderUserPrompt(草稿)`（Wr 的 `{input}` 替换）；
 *   · **无项目上下文**：A 层只改写「用户说什么」，上下文是 B 层的事；
 *   · 结果清洗只做 `stripWrappingQuotes`（trim + 首尾各剥一个引号字符），不碰围栏 / 前缀。
 * 两份模板逐字取自客户端原文，不再做「结构等价重写」。
 *
 * 保留的本插件自有增强（不在 WorkBuddy A 层逻辑内，均为非阻断的回执 / 护栏）：
 *   · 占位符保护（`@` 是结构化引用，对应 WorkBuddy 保留非文本 blocks 的精神）；
 *   · 数字 / 占位符 / 语言 / 泄漏的结果侧机械校验，只进 `checks.findings`；
 *   · 近空草稿前置拦截、4000 字上限、temperature 0.7、3 分钟结果缓存、会话模型路由。
 *
 * 依赖注入口：`createPolishService({ importLlm })` —— 生产动态 import DSH 的 LLM 包，自检注入假实现
 * （纯 node 测试因此不静态依赖 `@deepseek-ai/*`）。
 */

import { createHash } from 'node:crypto'

/** 一次增强允许的最大字符数（超过就拒：截断会丢意图）。 */
export const POLISH_MAX_CHARS = 4000
/** 端点读体上限。 */
export const POLISH_BODY_LIMIT = 32 * 1024
/** 一次模型调用的总超时（含首包）。 */
export const POLISH_TIMEOUT_MS = 20_000
/** 结果缓存窗口：3 分钟（同一草稿不重复花钱；A 层无上下文，结果只随草稿与路由变）。 */
export const POLISH_CACHE_TTL_MS = 3 * 60 * 1000
/** 结果侧长度提示线：约 800 字符（提示词里的 800 目标由 `Ur` 逐字给出，这里只用于回执）。 */
export const POLISH_TARGET_CHARS = 800
/** 本插件自有参数：temperature 0.7（WorkBuddy 真实实现未显式传 temperature）。 */
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
 * 去掉零宽空格（ZWSP, U+200B）。
 * 对齐 WorkBuddy 客户端 `useEnhancePrompt` 的 `normalizeEnhanceText`（`gSe='\u200B'`）：输入框从网页 /
 * 富文本粘贴常带这个不可见字符，留着会让「看起来空」的草稿被判成有内容、白调一次模型，
 * 也会混进改写结果。只清 U+200B —— 参考实现没有扩大到 BOM / ZWJ，这里也不擅自扩大。
 * @param {unknown} text - 输入。
 * @returns {string} 去掉零宽空格后的文本。
 */
export function stripZeroWidthOf(text) {
	return String(text ?? '').replace(/\u200B/g, '')
}

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
	let value = stripZeroWidthOf(text).trim()
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
 * WorkBuddy `enhance-prompt` 子代理的 system prompt（`Ur`），逐字取自客户端 app.asar。
 * 结构：TASK / ANALYSIS PROCESS / IMPORTANT CONSTRAINTS / FORMAT / Examples；**没有**独立的
 * NEGATIVE RULES 分区，DO NOT 清单在 ANALYSIS PROCESS 内。
 */
export const ENHANCE_SYSTEM_PROMPT = `You are a Prompt Engineering Expert specializing in improving user prompts for a development code assistant. When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose. The requests are being made to an AI assistant that specializes in writing code.

	TASK: When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose. The requests are being made to an AI assistant that specializes in writing code.

	ANALYSIS PROCESS:

	Evaluate the original prompt:
	Identify the main objective
	Note any ambiguities or gaps
	Assess the clarity of instructions
	Check for missing context
	Apply these prompt engineering principles:
	Write clear, specific instructions
	Include necessary context
	Set explicit parameters and constraints
	Structure the output format
	Add relevant examples
	Match tone and complexity to the use case
	Remove redundant information
	Create the enhanced version:
	Maintain the original goal
	Incorporate identified improvements
	Ensure clarity and completeness
	Be realistic in the features to add
	Do NOT request guides/how-tos unless the user asks
	Do NOT ask for code snippets
	Do NOT suggest specific technologies unless mentioned in the user's prompt
	Do NOT explain HOW to do things, focus on WHAT
	Do NOT answer questions - expand/rewrite them to be more detailed
	IMPORTANT CONSTRAINTS:
	1. Language matching is the highest priority - You MUST strictly respond in the exact same language as the user's input. If the user writes in Chinese, respond in Chinese; if the user writes in English, respond in English; if the user uses another language, respond in that same language. Do not mix languages unless the user's input itself mixes languages.
	2. Keep the enhanced prompt concise - maximum length should be around 800 characters
	FORMAT: Provide only the enhanced prompt with no additional commentary.

	Example:
	"A website for my dog"

	Enhanced prompt:
	"Design a personalized Next.js website dedicated to showcasing my dog. Include sections such as a photo gallery, a biography detailing the dog's breed, age, and personality traits, and a blog for sharing stories or updates about your dog's adventures. Add a contact form for visitors to reach out with questions or comments. Ensure the website is visually appealing and easy to navigate, with a responsive design that works well on both desktop and mobile devices."

	Example:
	"Convert this to a friendly tone, maintain technical details but reduce bullets in favor of narrative. Remove any jargon like 'genie router'. Use canvas"

	Enhanced prompt:
	"Transform the provided content into a friendly narrative format while preserving all technical details. Minimize bullet points in favor of flowing prose. Eliminate any technical jargon such as 'genie router'. Incorporate the concept of using canvas elements naturally within the narrative structure to enhance the technical explanation."`

/**
 * WorkBuddy `enhance-prompt` 子代理的 user prompt 模板（`Wr`），逐字取自客户端 app.asar。
 * 用户输入替换 `{input}` 后作为 userPrompt 传入；它在用户侧把语言一致规则再强调一遍，
 * 并给出 4 组 EXAMPLES 与 BAD/GOOD 输出示例。
 */
export const ENHANCE_USER_TEMPLATE = `You are a prompt enhancement assistant. Improve the user prompt while preserving its intent and language.

    USER INPUT:
    {input}
    
    TASK:
    Rewrite the user input into a clearer, more specific prompt for the target AI assistant.

    CRITICAL PRIORITY - LANGUAGE CONSISTENCY:
    1. You MUST detect the language of the user input above and write the enhanced prompt in that same language.
    2. If the user writes in Chinese, the enhanced prompt MUST be entirely in Chinese.
    3. If the user writes in English, the enhanced prompt MUST be entirely in English.
    4. If the user writes in any other language, the enhanced prompt MUST use that exact same language.
    5. If the user mixes languages, keep a natural matching mix. Do not translate the user's intent into a single language.
    6. These language rules are behavior instructions only; never include language analysis or language labels in the output.
    
    ENHANCEMENT REQUIREMENTS:
    1. Return only the enhanced prompt text; do not add explanations, prefaces, markdown fences, labels, or analysis.
    2. Do not include language labels or meta notes such as "User input is in Chinese" or "Response must be in Chinese".
    3. Preserve the user's original intent, topic, constraints, and target output type. Do not answer the request.
    4. Always make a substantive enhancement when possible: clarify the task, scope, constraints, and expected output.
    5. If the original prompt is already clear, lightly polish it instead of returning it unchanged.
    6. Keep the enhanced prompt complete and concise. Do not end with an unfinished list, dangling conjunction, or trailing colon.
    7. Do not add unrelated requirements, unsupported facts, or unnecessary sections.

    EXAMPLES:
    User input (Chinese): "\u8BF7\u5E2E\u6211\u89E3\u91CA\u8FD9\u6BB5\u4EE3\u7801\u7684\u529F\u80FD"
    Enhanced prompt: "\u8BF7\u89E3\u91CA\u8FD9\u6BB5\u4EE3\u7801\u7684\u4E3B\u8981\u529F\u80FD\u3001\u6267\u884C\u6D41\u7A0B\u548C\u5173\u952E\u903B\u8F91\uFF0C\u5E76\u6307\u51FA\u53EF\u80FD\u9700\u8981\u6CE8\u610F\u7684\u8FB9\u754C\u60C5\u51B5\u3002"

    User input (English): "Please explain what this code does"
    Enhanced prompt: "Explain what this code does, including its main purpose, key control flow, and any important edge cases."

    User input (Mixed): "\u8FD9\u6BB5\u4EE3\u7801\u6709 bug\uFF0Ccan you help me fix it?"
    Enhanced prompt: "\u8BF7\u5206\u6790\u8FD9\u6BB5\u4EE3\u7801\u4E2D\u7684 bug\uFF0Cexplain the root cause, and provide a minimal fix with necessary verification steps."

    BAD OUTPUT EXAMPLE:
    User input is in Chinese \u2192 Response must be in Chinese.
    \u8BF7\u89E3\u91CA\u8FD9\u6BB5\u4EE3\u7801\u7684\u4E3B\u8981\u529F\u80FD

    GOOD OUTPUT EXAMPLE:
    \u8BF7\u89E3\u91CA\u8FD9\u6BB5\u4EE3\u7801\u7684\u4E3B\u8981\u529F\u80FD\u3001\u6267\u884C\u6D41\u7A0B\u548C\u5173\u952E\u903B\u8F91\uFF0C\u5E76\u6307\u51FA\u53EF\u80FD\u9700\u8981\u6CE8\u610F\u7684\u8FB9\u754C\u60C5\u51B5\u3002`

/**
 * 把用户草稿替换进 `Wr` 的 `{input}`（对齐客户端 `renderUserPrompt`）。
 * 用函数式 replace：草稿里若含 `$&` / `$'` 等替换模式，不会被当成替换语法解释。
 * @param {string} draft - 用户草稿（已做占位符保护）。
 * @returns {string} userPrompt。
 */
export function renderUserPrompt(draft) {
	return ENHANCE_USER_TEMPLATE.replace('{input}', () => String(draft ?? ''))
}

/**
 * 系统提示词：逐字返回 WorkBuddy `enhance-prompt` 的 `Ur`。
 * @returns {string} 系统提示词。
 */
export function buildSystemPrompt() {
	return ENHANCE_SYSTEM_PROMPT
}

/**
 * 结果清洗：逐字对齐 WorkBuddy `stripWrappingQuotes` —— trim 后首尾各剥一个引号字符，
 * **不要求成对**（单边也剥）；不碰代码围栏、不去 `Enhanced prompt:` 前缀、不剥「」。
 * 引号集合与客户端原文一致（直引号 + 弯引号），不含直角引号。
 * @param {unknown} text - 模型原始输出。
 * @returns {string} 清洗后的正文。
 */
export function cleanEnhancedText(text) {
	return String(text ?? '').trim().replace(/^["'"\u201C\u201D\u2018\u2019]|["'"\u201C\u201D\u2018']$/g, '')
}

/** 一条模型选择是否形状可用（provider / model 都是非空字符串）。 */
function isSelectionOf(value) {
	return value !== null && value !== undefined && typeof value === 'object' && typeof value.provider === 'string' && value.provider !== '' && typeof value.model === 'string' && value.model !== ''
}

/** 两条选择是否**同一条路由**（provider + model；reasoningEffort 不参与路由是否变化的判定）。 */
function sameRouteOf(left, right) {
	return isSelectionOf(left) && isSelectionOf(right) && left.provider === right.provider && left.model === right.model
}

/**
 * 把一条候选选择过宿主的 `llm.resolveCallConfig` 校验（与宿主命令层同一条）。
 *
 * 读不到 `llm` / 没有 `resolveCallConfig` 时**放行**（离线自检 / 老宿主）：拿不到校验面就不假装校验过。
 * @param ctx - 宿主 ctx。
 * @param candidate - `{ provider, model }`。
 * @param source - 来源名（只进诊断，不进用户文案）。
 * @param failures - 收集失败原因（只列来源与原因，不打印凭据）。
 * @returns `{ provider, model } | null`。
 */
async function validateRouteOf(ctx, candidate, source, failures) {
	if (!isSelectionOf(candidate)) return null
	const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
	if (llm !== null && llm !== undefined && typeof llm.resolveCallConfig === 'function') {
		try {
			await llm.resolveCallConfig({ provider: candidate.provider, model: candidate.model })
		} catch (error) {
			failures.push(source + '：' + (error !== null && error !== undefined && typeof error.message === 'string' ? error.message : '校验失败'))
			return null
		}
	}
	return { provider: candidate.provider, model: candidate.model }
}

/**
 * 取当前会话的模型路由（`provider` / `model`）—— **四级兜底，顺序固定**（003 §1.15）：
 *
 *   ① 会话记录的选择：`sessionProjections.snapshot(session, ['modelSelection'])` 的
 *      `{ lastUsed, next }`；`next = pending ?? lastUsed`。`next` 与 `lastUsed` 不同 ⇒ 这是
 *      **还没发消息的显式选择（pending）**，校验失败就**直接报错、不降级**（否则会偷偷换模型骗人）；
 *      相同（含都为空）⇒ 只是"上次实际用的"，不可用才继续往下。
 *   ② `agents.get(id).model.current()`（记录的选择 ?? Agent options）；
 *   ③ `session.requestHeader().config`（上次请求；**历史**，排在当前选择之后）；
 *   ④ `ctx.agentDefaultModel.currentSelection()`（账号默认）；
 *   ⑤ 全取不到 ⇒ `null`（调用方抛 `POLISH_NO_ROUTE`）。
 *
 * 显式传入的 `provider`/`model`（请求体，成对才生效）优先于 ①；由 {@link polishRouteOf} 处理。
 * 每一级都过 `llm.resolveCallConfig`；第 ① 级的 pending 失败**不往下走**。
 * @param ctx - 宿主 ctx。
 * @param sessionId - 会话 id。
 * @returns `Promise<{ provider: string, model: string } | null>`。
 */
export async function sessionRouteOf(ctx, sessionId) {
	if (typeof sessionId !== 'string' || sessionId === '') return null
	const failures = []
	const serviceOf = (name) => {
		try {
			return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
		} catch {
			return undefined
		}
	}
	const sessions = serviceOf('sessions')
	const session = sessions !== null && sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined

	// ① 会话记录的选择（输入框选模型会追加 model/selection，跟有没有发过消息无关 —— 这是修 bug 的那一级）。
	try {
		const projections = serviceOf('sessionProjections')
		if (projections !== null && projections !== undefined && typeof projections.snapshot === 'function' && session !== undefined) {
			const snapshot = projections.snapshot(session, ['modelSelection'])
			const selection = snapshot !== null && snapshot !== undefined && snapshot.values !== null && snapshot.values !== undefined ? snapshot.values.modelSelection : undefined
			if (selection !== null && selection !== undefined && typeof selection === 'object') {
				const lastUsed = isSelectionOf(selection.lastUsed) ? selection.lastUsed : null
				const next = isSelectionOf(selection.next) ? selection.next : lastUsed
				const pending = next !== null && !sameRouteOf(next, lastUsed)
				if (pending) {
					// pending：人刚选了模型、还没发消息。**不可用就报错，不降级**。
					return await validateRouteOf(ctx, next, '会话选择（尚未发消息）', failures)
				}
				if (lastUsed !== null) {
					const route = await validateRouteOf(ctx, lastUsed, '会话上次使用的模型', failures)
					if (route !== null) return route
				}
			}
		}
	} catch (error) {
		failures.push('会话选择：' + (error !== null && error !== undefined && typeof error.message === 'string' ? error.message : '读取失败'))
	}

	// ② Agent 的当前选择（记录的选择 ?? Agent options；会把部署默认混进来，所以排在 ① 之后）。
	try {
		const agents = serviceOf('agents')
		const agent = agents !== null && agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
		const model = agent !== null && agent !== undefined && agent.model !== null && agent.model !== undefined ? agent.model : undefined
		const current = model !== null && model !== undefined && typeof model.current === 'function' ? model.current() : undefined
		if (isSelectionOf(current)) {
			const route = await validateRouteOf(ctx, current, 'Agent 当前模型', failures)
			if (route !== null) return route
		}
	} catch (error) {
		failures.push('Agent 当前模型：' + (error !== null && error !== undefined && typeof error.message === 'string' ? error.message : '读取失败'))
	}

	// ③ 上次请求用的路由（现状；发过消息才有）。
	try {
		const header = session !== null && session !== undefined && typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
		const config = header !== null && header !== undefined && typeof header === 'object' ? header.config : undefined
		if (config !== null && config !== undefined && typeof config === 'object') {
			const route = await validateRouteOf(ctx, { provider: config.provider, model: config.model }, '上次请求的模型', failures)
			if (route !== null) return route
		}
	} catch (error) {
		failures.push('上次请求的模型：' + (error !== null && error !== undefined && typeof error.message === 'string' ? error.message : '读取失败'))
	}

	// ④ 账号默认模型（什么都没有记录时）。
	try {
		const defaults = serviceOf('agentDefaultModel')
		const selection = defaults !== null && defaults !== undefined && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : undefined
		if (isSelectionOf(selection)) {
			const route = await validateRouteOf(ctx, selection, '账号默认模型', failures)
			if (route !== null) return route
		}
	} catch (error) {
		failures.push('账号默认模型：' + (error !== null && error !== undefined && typeof error.message === 'string' ? error.message : '读取失败'))
	}

	// ⑤ 全取不到：把来源与原因挂在错误上（诊断用；**不打印凭据**）。调用方只回固定文案。
	void failures
	return null
}

/**
 * 解析一次润色的模型路由：请求体显式 `provider`/`model`（**成对才生效**）优先于会话记录。
 *
 * 显式值校验失败 ⇒ 直接报错、不降级（与 pending 同一条纪律）。
 * @param ctx - 宿主 ctx。
 * @param sessionId - 会话 id。
 * @param explicit - `{ provider?, model? }`（请求体）。
 * @returns `Promise<{ provider, model } | null>`。
 */
export async function polishRouteOf(ctx, sessionId, explicit) {
	const candidate = explicit !== null && explicit !== undefined && typeof explicit.provider === 'string' && explicit.provider !== '' && typeof explicit.model === 'string' && explicit.model !== ''
		? { provider: explicit.provider, model: explicit.model }
		: null
	if (candidate !== null) {
		const failures = []
		return validateRouteOf(ctx, candidate, '请求指定的模型', failures)
	}
	return sessionRouteOf(ctx, sessionId)
}

/** 输出 token 上限：增强会补内容，给足但封顶，防止长篇发挥。 */
function maxTokensOf(masked) {
	const estimate = Math.ceil(String(masked ?? '').length / 2) * 2
	return Math.max(512, Math.min(2048, estimate + 500))
}

/**
 * 创建提示词增强服务（生产默认动态 import DSH 的 LLM 包；自检注入假实现）。
 * @param {{ importLlm?: () => Promise<{ createUserMessage: Function, BlockAssembler: Function }> }} deps - 依赖注入。
 * @returns {{ polish: Function }} 服务。
 */
export function createPolishService(deps = {}) {
	const importLlm = typeof deps.importLlm === 'function' ? deps.importLlm : () => import('@deepseek-ai/dsh-llm')
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
	 * @param {{ ctx: object, sessionId: string, text: string, signal?: AbortSignal, refresh?: boolean }} input - 请求；
	 *   `refresh: true` 跳过结果缓存（真的再调一次模型）。
	 * @returns {Promise<object>} 契约里的 200 字段（不含 HTTP 状态码）。
	 * @throws {Error & { code?: string }} `POLISH_NO_ROUTE` / `POLISH_EMPTY` / `POLISH_TOO_LONG` / 上游错误。
	 */
	async function polish({ ctx, sessionId, text, signal, refresh = false, provider, model }) {
		const started = Date.now()
		// 入口先清零宽：对齐 WorkBuddy 客户端 `normalizeEnhanceText` 的 `split('\u200B').join('')`
		// （本插件的模型调用在宿主侧 `polish()`，而不是客户端 fetch 之前）。撤回用的原始草稿
		// 仍在客户端 `setOriginal(textNow)` 里，含零宽也照原样恢复。
		const original = stripZeroWidthOf(text).trim()
		if (original === '') throw Object.assign(new Error('草稿为空'), { code: 'POLISH_EMPTY' })
		if (effectiveDraftContentOf(original) === '') {
			throw Object.assign(new Error('草稿只有标签，没有可改写的具体内容：先写清要改什么。'), { code: 'POLISH_TOO_VAGUE' })
		}
		if (original.length > POLISH_MAX_CHARS) throw Object.assign(new Error('草稿超过 ' + POLISH_MAX_CHARS + ' 字上限'), { code: 'POLISH_TOO_LONG' })
		const route = await polishRouteOf(ctx, sessionId, { provider, model })
		if (route === null) throw Object.assign(new Error('取不到可用的模型：本会话没有记录过选择，也没有默认模型。请在输入框里选一次模型再试。'), { code: 'POLISH_NO_ROUTE' })

		const cacheKey = createHash('sha256').update(route.provider + '\n' + route.model + '\n' + original).digest('hex')
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

		// A 层无项目上下文：userPrompt 就是 Wr 模板把草稿替换进 {input}，system 是 Ur。
		const userText = renderUserPrompt(masked)
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
			checks: { ok: findings.length === 0, findings },
			route,
		}
		cache.set(cacheKey, { at: Date.now(), value })
		return { ...value, elapsedMs: Date.now() - started, cached: false }
	}

	return { polish }
}
