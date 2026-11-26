/**
 * 成员上下文构成的**纯折叠**：把一份会话事件日志折成七类（系统 / 工具 / 用户 / 注入 / 技能 /
 * 助手 / 工具结果）与逐项列表。
 *
 * 为什么单独一个文件：这是本插件里**唯一一份**七类归位与计价算法 —— 详情页端点直接调它，
 * 单测也直接调它。路由那侧只做「取事件 + 分页 + 排序 + 组装回执」，不另写一遍折叠逻辑。
 *
 * 口径（唯一正文是 `docs/design/design-member-context-003.md` §1.3 / §1.4）：
 *   · 表层按 `surfaceOp` 折：`append` 直接入表；非 `append`（压缩 / 剪裁的 `replace`）先摘掉
 *     `seq ∈ [startSeq, endSeq]` 的旧节点，**再把这条 replace 事件自己**当成新节点入表
 *     （它携带的是取代后的摘要消息，确实占着模型可见历史）。
 *   · 单价一律由调用方传进来的 `estimateMessage`（宿主 `tokenMeter.estimateMessage`）算 ——
 *     自己按字符数重算会与宿主差 1–2 token/条，七类合计就对不上 `contextBreakdown`。
 *   · 系统提示**只算最后一条非空**；更早的归「注入内容」（宿主 `contextBreakdown` 同口径）。
 *   · `developer/message`（工具增删通知）也归「注入内容」；未知 `source.kind` 一律归注入、**不丢**。
 *   · 工具段按**最后一个** `request/header` 的 `tools[]` 计价；`×N` 是 `tool/call` 的调用次数
 *     （全量，含结果已被裁掉的调用）。
 *
 * 只做纯计算：不读盘、不取 ctx、不写文件、不发请求。异常输入（非数组 / 缺估计器）直接抛 ——
 * 静默返回全零会让「读不到」冒充「没有」。
 */

/** 能进入模型可见表层的事件类型（与宿主 `dsh-session/src/surface.ts` 的集合同源）。 */
export const SURFACE_TYPES = Object.freeze(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/** 七类的固定顺序（页面按这个顺序画，不按大小重排）。 */
export const CONTEXT_CATEGORIES = Object.freeze(['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool'])

/** 逐项预览的字数上限（数据侧截断；CSS 再兜省略号）。 */
export const PREVIEW_CHARS = 80

/** 一条消息的正文预览：只取 text 块，按出现顺序拼接（工具调用 / 推理不进来）。 */
export function textOfMessage(message) {
	if (message === null || message === undefined) return ''
	const content = message.content
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return ''
	let out = ''
	for (const block of content) {
		if (block === null || block === undefined || typeof block !== 'object') continue
		if (block.type === 'text' && typeof block.text === 'string') out += block.text
	}
	return out
}

/** 预览截断（只砍、不说；被砍了多少由调用方在 `preview` 之外自己判，页面不显示）。 */
export function previewOf(value) {
	const text = typeof value === 'string' ? value : ''
	// 按**码点**截（与全文、`chars` 同一单位）：BMP 与外码点行为一致。
	const points = Array.from(text)
	return points.length <= PREVIEW_CHARS ? text : points.slice(0, PREVIEW_CHARS).join('')
}

/**
 * 一条 surface 事件对应的模型可见消息（与宿主 `deriveEventMessage` 同口径）。
 *
 * `user/message` 的 `data` 本身就是 message（`role` / `content` / `source` 都在顶层）；
 * 其余四种的 message 挂在 `data.message` 上。
 * @param event - 日志事件（未校验形状）。
 * @returns 消息对象，或 null（不是 surface 事件 / 没有消息）。
 */
export function messageOfEvent(event) {
	if (event === null || event === undefined || typeof event !== 'object') return null
	const data = event.data
	if (data === null || data === undefined || typeof data !== 'object') return null
	if (event.type === 'user/message') return data
	return data.message !== undefined && data.message !== null ? data.message : null
}

/**
 * 一条 surface 事件的归位键（宿主的 `source.kind`）。
 * `user/message` 的 source 在 `data.source`，其余在 `data.message.source`。
 */
function kindOfEvent(event, message) {
	const direct = event?.data?.source
	if (direct !== null && direct !== undefined && typeof direct === 'object' && typeof direct.kind === 'string') return direct.kind
	const nested = message?.source
	return nested !== null && nested !== undefined && typeof nested === 'object' && typeof nested.kind === 'string' ? nested.kind : ''
}

/** 空消息不占价（宿主 `deriveEventMessage` 对空 system / developer / assistant 返回 null）。 */
function isEmptyMessage(type, message) {
	if (type === 'user/message') return false
	if (message === null || message === undefined) return true
	return Array.isArray(message.content) && message.content.length === 0
}

function seqOf(event) {
	const seq = event?.seq
	return typeof seq === 'number' && Number.isFinite(seq) ? seq : -1
}

/** surface 类型集合的成员判定（与 {@link SURFACE_TYPES} 同一份）。 */
export function isSurfaceType(type) {
	return SURFACE_TYPES.includes(type)
}

/**
 * **存活表层**（v2.4 §1.14 的读取路径）：只按 `surfaceOp` 折叠出「现在还在表层、且 seq → 事件」
 * 的映射，**不算价、不归位、不碰 Δ**（逐项详情只读一条，不需要也不允许付折叠账）。
 *
 * 与 `foldContext` 第 3 步的表层折叠同一条规则（append 入表；replace 先摘 `[startSeq,endSeq]`），
 * 区别只在"不调用 estimateMessage"：这里一个 token 都不算。
 * @param events - 会话事件数组。
 * @returns `{ eventOf, lastSystemSeq, size }`：`eventOf(seq)` 拿存活事件（不在表层给 null）；
 *   `lastSystemSeq` 是最后一条**非空** system 的 seq（归位判据用）。
 */
export function survivingSurfaceOf(events) {
	const alive = new Map()
	const callNames = new Map()
	for (const raw of Array.isArray(events) ? events : []) {
		if (raw === null || raw === undefined || typeof raw !== 'object') continue
		// 工具结果的 `toolName`：只读 `tool/call` 的 callId→name（不读参数内容）。
		if (raw.type === 'tool/call') {
			const data = raw.data !== null && raw.data !== undefined && typeof raw.data === 'object' ? raw.data : {}
			if (typeof data.callId === 'string' && data.callId !== '' && typeof data.name === 'string') callNames.set(data.callId, data.name)
			continue
		}
		if (!isSurfaceType(raw.type) || raw.surfaceOp === undefined || raw.surfaceOp === null) continue
		const op = raw.surfaceOp
		if (op !== 'append' && typeof op === 'object' && typeof op.startSeq === 'number' && typeof op.endSeq === 'number') {
			const start = op.startSeq
			const end = op.endSeq
			for (const seq of alive.keys()) if (seq >= start && seq <= end) alive.delete(seq)
		}
		if (typeof raw.seq === 'number') alive.set(raw.seq, raw)
	}
	let lastSystemSeq = null
	for (const [seq, event] of alive) {
		if (event.type !== 'system/message') continue
		if (textOfMessage(messageOfEvent(event)).trim() !== '') lastSystemSeq = seq
	}
	return {
		eventOf: (seq) => alive.get(seq) ?? null,
		lastSystemSeq,
		size: alive.size,
		toolNameOf: (callId) => (typeof callId === 'string' ? callNames.get(callId) ?? '' : ''),
	}
}

/** 按 seq 找存活 surface 事件的便捷包装（见 {@link survivingSurfaceOf}）。 */
export function survivingEventOf(events, seq) {
	return survivingSurfaceOf(events).eventOf(seq)
}

/**
 * 七类归位（单个事件的类别）：与 `foldContext` 的归位规则同一份（v2.4 §1.14 的 `category`）。
 * @param event - surface 事件。
 * @param lastSystemSeq - 最后一条非空 system 的 seq（旧系统提示归注入）。
 * @returns `'system'|'tools'|'user'|'inject'|'skill'|'assistant'|'tool'`（工具定义没有事件，不给 `tools`）。
 */
export function categoryOfEvent(event, lastSystemSeq) {
	if (event === null || event === undefined) return ''
	if (event.type === 'system/message') return event.seq === lastSystemSeq ? 'system' : 'inject'
	if (event.type === 'developer/message') return 'inject'
	if (event.type === 'assistant/message') return 'assistant'
	if (event.type === 'tool/result') return 'tool'
	if (event.type === 'user/message') {
		const kind = kindOfEvent(event, messageOfEvent(event))
		if (kind === 'user') return 'user'
		if (kind === 'skill-catalog') return 'skill'
		return 'inject'
	}
	return 'inject'
}

/**
 * 一条消息的**构成摘要**（v2.2 §1.12.4；只读块型与字符数，**不进计价**）。
 *
 * 返回的 `blocks` / `chars` / `tools` / `empty` 是契约字段；`toolChanges` 与 `others`
 * 是片段规则第 5、6 条要用的明细（规则表要写出块上的 `toolName` 与未知块型）。
 * @param message - 一条模型可见消息（`content` 为块数组）。
 * @returns 摘要对象。
 */
export function digestOfMessage(message) {
	const content = message !== null && message !== undefined && Array.isArray(message.content) ? message.content : []
	const blocks = { text: 0, reasoning: 0, toolCall: 0, image: 0, toolChange: 0, other: 0 }
	const chars = { text: 0, reasoning: 0 }
	const tools = []
	const toolChanges = []
	const others = []
	for (const block of content) {
		if (block === null || block === undefined || typeof block !== 'object') {
			blocks.other += 1
			continue
		}
		switch (block.type) {
			case 'text':
				blocks.text += 1
				if (typeof block.text === 'string') chars.text += Array.from(block.text).length
				break
			case 'reasoning':
				blocks.reasoning += 1
				// 规则 2：**去空白后非空**才算「推理 ≈N 字符」；N 也按去空白后的码点数算（仅空白块 ⇒ 0 片段）。
				if (typeof block.text === 'string') chars.reasoning += Array.from(block.text.trim()).length
				break
			case 'tool-call': {
				blocks.toolCall += 1
				const name = typeof block.name === 'string' ? block.name : ''
				if (name !== '' && !tools.includes(name) && tools.length < 2) tools.push(name)
				break
			}
			case 'image':
				blocks.image += 1
				break
			case 'tool-addition':
			case 'tool-removal': {
				blocks.toolChange += 1
				if (toolChanges.length < 2) {
					toolChanges.push({ kind: block.type === 'tool-addition' ? 'add' : 'remove', name: typeof block.toolName === 'string' ? block.toolName : '' })
				}
				break
			}
			default: {
				blocks.other += 1
				const type = typeof block.type === 'string' && block.type !== '' ? block.type : 'unknown'
				const hit = others.find((item) => item.type === type)
				if (hit === undefined) others.push({ type, count: 1 })
				else hit.count += 1
			}
		}
	}
	return { blocks, chars, tools, toolChanges, others, empty: content.length === 0 }
}

/** 一条节点 → 载荷项（只放契约字段；内部字段 `message` / `hasText` / `digest` 不外泄）。 */
function itemOf(node, marker) {
	const item = {
		seq: node.seq,
		tokens: node.tokens,
		preview: node.preview,
		kind: node.kind,
		digest: node.digest,
	}
	if (node.toolName !== '') item.toolName = node.toolName
	if (marker !== undefined && marker !== '') item.marker = marker
	return item
}

/**
 * 系统提示项（v2.2 §1.12.2）：预览取**首段** ≤120 字符，`chars` 是整篇原长、`paragraphs` 是段数。
 * 全文不进首屏载荷（走 `part=system-full`）。
 */
function systemItemOf(node) {
	const text = textOfMessage(node.message)
	const paragraphs = text
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph !== '')
	const preview = Array.from(paragraphs[0] ?? '').slice(0, 120).join('')
	return {
		...itemOf(node),
		kind: 'system-prompt',
		preview,
		chars: Array.from(text).length, // 码点数（与全文、A23 同一单位）
		paragraphs: paragraphs.length,
		previewTruncated: true,
	}
}

/**
 * 把一份事件日志折成七类构成。
 *
 * @param events - 会话事件数组（任意顺序之外都按数组顺序读；正常是日志顺序）。
 * @param options - `{ estimateMessage }`：**必须**是宿主 `tokenMeter.estimateMessage` 那样的
 *   一元函数（消息 → token 数）；缺了直接抛，不返回全零。
 * @returns `{ categories, counts, tools, items, asOfSeq, reconcile }`：
 *   · `categories`：七类的 token 合计（键见 {@link CONTEXT_CATEGORIES}）；
 *   · `counts`：七类的项数（`tools` 是工具 schema 的项数，`system` 最多 1）；
 *   · `tools`：逐工具 `{ name, tokens, calls }`（`tokens` 是该 schema 单独的固定启发式价，
 *     `calls` 是 `tool/call` 的次数）；
 *   · `items`：逐项列表（`system` / `user` / `inject` / `skill` / `assistant` / `tool`），
 *     每项 `{ seq, tokens, preview, kind, marker?, toolName? }`；
 *   · `asOfSeq`：这份折叠对应的日志位置（最后一条事件的 seq；空日志为 -1）；
 *   · `reconcile`：对账账 `{ delta, claims[], unclaimed[] }`（v2.1 §1.3 第 6 步 / §1.5）。
 *     它只读**同一份**事件里的 `compaction/*` 字段，按宿主同一条生命周期配对（claim **只对
 *     紧邻的下一个事件生效**）：宿主账本在压缩路径上会双重扣减，Δ 是这段可逐项复核的差额。
 */
export function foldContext(events, options) {
	if (!Array.isArray(events)) throw new TypeError('member-context: events 必须是数组')
	const estimateMessage = options === null || options === undefined ? undefined : options.estimateMessage
	if (typeof estimateMessage !== 'function') throw new TypeError('member-context: 需要 estimateMessage 函数（宿主 tokenMeter.estimateMessage）')

	const nodes = []
	const calls = new Map()
	const callNames = new Map()
	let lastTools = null
	let lastSeq = -1
	// 对账账（v2.1）：claim 由 `compaction/*` 武装，**只对紧邻的下一个事件生效**（宿主
	// `breakdown-projection.ts` 的 `withoutClaim` 在每个事件开头丢掉未消费的 claim）。
	let claim = null
	const claims = []
	const unclaimed = []
	let delta = 0

	for (const raw of events) {
		if (raw === null || raw === undefined || typeof raw !== 'object') continue
		const seq = seqOf(raw)
		if (seq > lastSeq) lastSeq = seq
		// 对账账：先取走已武装的 claim —— 任何非 compaction 事件都会让它失效（只生效一次）。
		const isCompaction = raw.type === 'compaction/summary' || raw.type === 'compaction/prune'
		const armed = claim
		if (!isCompaction) claim = null
		if (isCompaction) {
			const data = raw.data !== null && raw.data !== undefined && typeof raw.data === 'object' ? raw.data : {}
			const range = data.shadowedRange !== null && data.shadowedRange !== undefined && typeof data.shadowedRange === 'object' ? data.shadowedRange : {}
			const start = typeof range.start === 'number' ? range.start : null
			const end = typeof range.end === 'number' ? range.end : null
			const tokens = typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : null
			if (start !== null && end !== null && tokens !== null) {
				const shadowed = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
				// `shadowedSeqs` 里落在 `[start, end]` **之外**的条数：宿主按区间摘节点、却按
				// shadowedTokenCount 扣价 ⇒ 这些条被扣了两次，正是两份红日志的 13 / 10。
				let outside = 0
				for (const value of shadowed) if (typeof value === 'number' && (value < start || value > end)) outside += 1
				claim = { atSeq: seq, start, end, tokens, shadowedSeqsOutsideRange: outside }
			}
			continue
		}
		// 工具调用次数：**全量**按 name 计（结果被裁掉的调用也算）。
		if (raw.type === 'tool/call') {
			const data = raw.data !== null && raw.data !== undefined && typeof raw.data === 'object' ? raw.data : {}
			const name = typeof data.name === 'string' && data.name !== '' ? data.name : '?'
			const callId = typeof data.callId === 'string' ? data.callId : ''
			calls.set(name, (calls.get(name) ?? 0) + 1)
			if (callId !== '') callNames.set(callId, name)
			continue
		}
		// 工具 schema：取**最后一个** request/header 的 tools[]（没有 tools 字段就当没给）。
		if (raw.type === 'request/header') {
			const header = raw.data !== null && raw.data !== undefined && typeof raw.data === 'object' ? raw.data.header : undefined
			if (header !== null && header !== undefined && typeof header === 'object' && Array.isArray(header.tools)) lastTools = header.tools
			continue
		}
		if (!SURFACE_TYPES.includes(raw.type)) continue
		if (raw.surfaceOp === undefined || raw.surfaceOp === null) continue
		const op = raw.surfaceOp
		const message = messageOfEvent(raw)
		const empty = isEmptyMessage(raw.type, message)
		const tokens = empty ? 0 : Number(estimateMessage(message))
		if (!Number.isFinite(tokens) || tokens < 0) continue
		// 非 append（压缩 / 剪裁的 replace）：先摘掉被取代的那一段旧节点，并记下它们的价之和
		// —— 对账账要用它算 Δ（宿主扣的是 claim.shadowedTokenCount，不是这批节点的现价）。
		let removedTokens = 0
		if (op !== 'append' && typeof op === 'object' && typeof op.startSeq === 'number' && typeof op.endSeq === 'number') {
			const start = op.startSeq
			const end = op.endSeq
			for (let i = nodes.length - 1; i >= 0; i--) {
				if (nodes[i].seq >= start && nodes[i].seq <= end) {
					removedTokens += nodes[i].tokens
					nodes.splice(i, 1)
				}
			}
		}
		// 对账账（只为 §1.5 的第 ③ 条等式；不参与七类归位）：
		//   · claim 匹配的非系统 replace ⇒ Δ += claimTokens − 本次实际摘掉之和（两份红日志的 16874 / 12980）；
		//   · 单节点系统改写 ⇒ 不记账（两边都按"旧系统价换成新系统价"，差值自然抵消）；
		//   · 未计量的非系统 replace ⇒ 宿主零增量 ⇒ Δ += 新节点价 − 本次实际摘掉之和。
		if (op !== 'append' && typeof op === 'object') {
			const isSystem = raw.type === 'system/message'
			const matched = armed !== null && armed.start === op.startSeq && armed.end === op.endSeq
			if (matched && !isSystem) {
				delta += armed.tokens - removedTokens
				claims.push({
					claimSeq: armed.atSeq,
					replaceSeq: seq,
					claimTokens: armed.tokens,
					removedTokens,
					shadowedSeqsOutsideRange: armed.shadowedSeqsOutsideRange,
				})
			} else if (!isSystem) {
				delta += tokens - removedTokens
				unclaimed.push({ replaceSeq: seq, newTokens: tokens, removedTokens })
			}
		}
		const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
		const messageText = textOfMessage(message)
		// **空消息也入表**（tokens 0）：v2.2 的规则要求「每个 surface 节点」都有摘要，
		// 零块的记 `空消息`；它们不占价（宿主对空 system/developer/assistant 也返回 null）。
		nodes.push({
			seq,
			type: raw.type,
			kind: kindOfEvent(raw, message),
			tokens,
			preview: previewOf(messageText),
			toolName: toolCallId === '' ? '' : callNames.get(toolCallId) ?? '',
			message,
			hasText: messageText.trim() !== '',
			digest: digestOfMessage(message),
		})
	}

	// 系统提示只算最后一条非空（宿主 `contextBreakdown` 就是 `findLast(tokens > 0)`）。
	let lastSystem = null
	for (const node of nodes) if (node.type === 'system/message' && node.tokens > 0) lastSystem = node

	const categories = { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 }
	const counts = { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 }
	const items = { system: [], user: [], inject: [], skill: [], assistant: [], tool: [] }
	// 段头汇总（v2.2 §1.12.4）：与逐项同源（同一批节点），不受分页影响。
	const segmentDigest = { system: { withText: 0, noText: 0, empty: 0 }, user: { withText: 0, noText: 0, empty: 0 }, inject: { withText: 0, noText: 0, empty: 0 }, skill: { withText: 0, noText: 0, empty: 0 }, assistant: { withText: 0, noText: 0, empty: 0 }, tool: { withText: 0, noText: 0, empty: 0 } }
	/** 段头统计：有正文 / 仅推理-工具 / 零块（三者之和 = 该段项数，A17）。 */
	const statOf = (node) => (node.digest.empty === true ? 'empty' : node.hasText === true ? 'withText' : 'noText')

	for (const node of nodes) {
		if (node.type === 'system/message') {
			if (node === lastSystem) {
				node.category = 'system'
				categories.system += node.tokens
				counts.system = 1
				items.system.push(systemItemOf(node))
				segmentDigest.system[statOf(node)] += 1
			} else {
				// 被取代 / 更早的系统提示：宿主也算在 messageTokens 里 ⇒ 归注入（空系统提示只记 0 价，不标"旧"）。
				node.marker = node.tokens > 0 ? '旧系统提示' : ''
				node.category = 'inject'
				categories.inject += node.tokens
				counts.inject += 1
				items.inject.push(itemOf(node, node.tokens > 0 ? '旧系统提示' : ''))
				segmentDigest.inject[statOf(node)] += 1
			}
			continue
		}
		if (node.type === 'developer/message') {
			node.marker = '工具增删通知'
			node.category = 'inject'
			categories.inject += node.tokens
			counts.inject += 1
			items.inject.push(itemOf(node, '工具增删通知'))
			segmentDigest.inject[statOf(node)] += 1
			continue
		}
		if (node.type === 'assistant/message') {
			node.category = 'assistant'
			categories.assistant += node.tokens
			counts.assistant += 1
			items.assistant.push(itemOf(node))
			segmentDigest.assistant[statOf(node)] += 1
			continue
		}
		if (node.type === 'tool/result') {
			node.category = 'tool'
			categories.tool += node.tokens
			counts.tool += 1
			items.tool.push(itemOf(node))
			segmentDigest.tool[statOf(node)] += 1
			continue
		}
		// 剩下 user/message：按 source.kind 分「用户消息 / 技能注入 / 注入内容（未知 kind 不丢）」。
		if (node.kind === 'user') {
			node.category = 'user'
			categories.user += node.tokens
			counts.user += 1
			items.user.push(itemOf(node))
			segmentDigest.user[statOf(node)] += 1
		} else if (node.kind === 'skill-catalog') {
			node.category = 'skill'
			categories.skill += node.tokens
			counts.skill += 1
			items.skill.push(itemOf(node))
			segmentDigest.skill[statOf(node)] += 1
		} else {
			node.category = 'inject'
			categories.inject += node.tokens
			counts.inject += 1
			items.inject.push(itemOf(node))
			segmentDigest.inject[statOf(node)] += 1
		}
	}

	// 工具段：单价 = ceil(JSON.stringify(tool).length / 4)；合计 = 同一式子对整份 tools[] 再加 4。
	// 两者差的是 JSON 结构框（约 +15 token），页脚 P6 说明这一点，不配平。
	const toolList = Array.isArray(lastTools)
		? lastTools
				.map((tool) => {
					if (tool === null || tool === undefined || typeof tool !== 'object') return null
					const name = typeof tool.name === 'string' ? tool.name : ''
					return { name, tokens: Math.ceil(JSON.stringify(tool).length / 4), calls: calls.get(name) ?? 0 }
				})
				.filter((tool) => tool !== null)
		: []
	categories.tools = Array.isArray(lastTools) && lastTools.length > 0 ? Math.ceil(JSON.stringify(lastTools).length / 4) + 4 : 0
	counts.tools = toolList.length

	// 按 seq 找存活节点的纯索（v2.4 §1.14：路由取单条详情用；不序列化、不进默认载荷）。
	const bySeq = new Map()
	for (const node of nodes) bySeq.set(node.seq, node)
	return {
		categories,
		counts,
		tools: toolList,
		items,
		segmentDigest,
		asOfSeq: lastSeq,
		reconcile: { delta, claims, unclaimed },
		nodeOf: (targetSeq) => bySeq.get(targetSeq) ?? null,
	}
}

/**
 * 工具段的排序（服务端与测试用；页面侧的同一条规则写在客户端片段里 —— 浏览器拿不到本文件）。
 * @param tools - `foldContext` 给的逐工具行。
 * @param sort - `size`（schema token 降序，默认）/ `count`（调用次数降序）/ `name`（名字升序）。
 * @returns 新数组，不改入参。
 */
export function sortedToolsOf(tools, sort) {
	const list = Array.isArray(tools) ? tools.slice() : []
	const byName = (a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? ''))
	if (sort === 'name') return list.sort(byName)
	const key = sort === 'count' ? 'calls' : 'tokens'
	return list.sort((a, b) => {
		const left = typeof a?.[key] === 'number' ? a[key] : 0
		const right = typeof b?.[key] === 'number' ? b[key] : 0
		return right - left || byName(a, b)
	})
}

/**
 * 一页切片（每类各自分页，互不影响；合计与项数始终是全量）。
 * @param items - 全量项。
 * @param page - 1 起的页码；`0` / `all` / 非正数 ⇒ 全量（面板一次读全，前端自己切片）。
 * @param pageSize - 每页条数。
 * @returns `{ items, shown, total, hasMore }`。
 */
export function pagedOf(items, page, pageSize) {
	const list = Array.isArray(items) ? items : []
	const size = typeof pageSize === 'number' && pageSize > 0 ? Math.floor(pageSize) : 50
	const all = !(typeof page === 'number' && page > 0)
	if (all) return { items: list, shown: list.length, total: list.length, hasMore: false }
	const end = page * size
	return { items: list.slice(0, end), shown: Math.min(end, list.length), total: list.length, hasMore: end < list.length }
}
