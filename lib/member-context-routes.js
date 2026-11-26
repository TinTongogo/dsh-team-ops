/**
 * 成员上下文详情端点：`GET /company-board/api/member-context`。
 *
 * 这是「成员卡 → 翻转 → 面板内整页」那个页面的**唯一数据入口**（方案见
 * `docs/design/design-member-context-003.md` §⑧）：
 *   · 用宿主为"读别人的会话"准备的观察面 `sessionQuery.observeSession(member)` 取一份**租约**，
 *     读完在 `finally` 里释放（`Symbol.dispose`；本版宿主没有 `Symbol.asyncDispose` 面）；
 *   · 事件交给 `lib/member-context.js` 的 `foldContext` 折七类 —— **算法只有那一份**，这里不重写；
 *   · 单价一律用宿主 `tokenMeter.estimateMessage`（与 `contextBreakdown` 同一个估计器）。
 *
 * 只读：不写盘、不新增宿主状态、不注册投影键、不驱动成员、不发模型请求。
 *
 * 降级（每档都给判据与文案代号，见 003 §1.7）：
 *   L0 `ready`   租约 + 折叠成功；
 *   L1 `l1`      租约 / 折叠失败，但投影还读得到 ⇒ 只给三段（文案 P8 由页面套）；
 *   L2 `l2`      连 `tokenMeter` 都没有 ⇒ 占用与构成都读不到（P9）；
 *   L3 `l3`      成员没有活着的会话（`agents.get` 空）⇒ 空态页（P10）。
 * 任何一档都不把"读不到"答成 `0`。
 */
import { messageOf, queryValue, writeJson } from './http-tools.js'
import { categoryOfEvent, foldContext, messageOfEvent, pagedOf, sortedToolsOf, survivingSurfaceOf, textOfMessage } from './member-context.js'

/** 每页条数（`tokens.md:168` 的 `--cbv-list-page` 参数；不是 CSS 变量）。 */
export const MEMBER_CONTEXT_PAGE_SIZE = 50

/** L2 的判据文案：`tokenMeter` 缺（与 003 §⑨ P9 逐字一致）。 */
export const CONTEXT_METER_MISSING = '这个部署没有上下文计量服务（token-meter）：占用与构成都读不到。'

/** ② 不在场的判据文案（与 001 §7.4 C6 逐字一致）。 */
export const CONTEXT_ABSENT = '它现在没有活着的会话：没有上下文窗口可读。'

/** 全文的上限（字符，不是字节；v2.2 §12.3.2）。 */
export const SYSTEM_FULL_MAX_CHARS = 200_000

/** 逐项详情的单字段上限（**码点**，v2.4 §1.14；与 `textChars` 同单位）。 */
export const ITEM_MAX_CHARS = 50_000

/** ③ 空态文案（003 §⑨ P10）。 */
export const CONTEXT_NO_SESSION = '它现在没有活着的会话：没有上下文可拆。'

/** 读一个可选服务：取不到就给 undefined（`ctx.get` 自己抛也不带走整个请求）。 */
function serviceOf(ctx, name) {
	try {
		return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
	} catch {
		return undefined
	}
}

function countOf(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 读一位成员的上下文占用与三段构成（**唯一实现**：`/members` 的卡面与详情页共用它）。
 *
 * 读法：`agents.get(memberId)` 拿到活着的 Agent → `agent.session` → 一次
 * `sessionProjections.snapshot(session, ['contextPressure', 'contextBreakdown'])`。
 * **不**调 `measure()`、**不** attach / resume、**不**注册投影键。
 *
 * @param ctx - 宿主 ctx。
 * @param agent - `agents.get(memberId)` 的结果（可为 undefined）。
 * @returns `{ state, available, reason, pressureTokens, projectedTokens, contextWindow,
 *            systemTokens, toolsTokens, messageTokens, asOfSeq }`；
 *   `state` ∈ `no-service`（服务缺，卡面整行不画）/ `absent`（没有活着的会话）/
 *   `no-request`（还没跑过请求）/ `no-window`（有用量但容量未知）/ `ready` / `error`。
 */
/** 空占用读数（各字段 null；读不到不补 0）。 */
function emptyOccupancy() {
	return {
		available: false,
		reason: null,
		pressureTokens: null,
		projectedTokens: null,
		contextWindow: null,
		systemTokens: null,
		toolsTokens: null,
		messageTokens: null,
		asOfSeq: null,
	}
}

/**
 * 从一份 **投影快照**（`ProjectionSnapshot`）读出占用与三段。
 *
 * 两个来源共用这一份：活会话走 `sessionProjections.snapshot(agent.session, …)`；
 * 已结束成员走 `lease.projections`（`observeSession(..., { projectionMode: 'all' })` 的
 * prepared 快照）—— 同一套字段、同一套判据（A19/A22 与活会话一致）。
 * @param snapshot - `{ asOfSeq, values: { contextPressure?, contextBreakdown? } }`。
 */
export function occupancyFromSnapshot(snapshot) {
	const values = snapshot !== null && snapshot !== undefined && snapshot.values !== null && snapshot.values !== undefined ? snapshot.values : {}
	const pressure = values.contextPressure !== null && values.contextPressure !== undefined && typeof values.contextPressure === 'object' ? values.contextPressure : {}
	const breakdown = values.contextBreakdown !== null && values.contextBreakdown !== undefined && typeof values.contextBreakdown === 'object' ? values.contextBreakdown : null
	if (breakdown === null) return { ...emptyOccupancy(), state: 'no-service', reason: CONTEXT_METER_MISSING }
	const pressureTokens = countOf(pressure.pressureTokens)
	const projectedTokens = countOf(pressure.projectedTokens)
	const contextWindow = countOf(pressure.contextWindow)
	const occupancy = {
		available: true,
		reason: null,
		pressureTokens,
		projectedTokens,
		contextWindow,
		systemTokens: countOf(breakdown.systemTokens),
		toolsTokens: countOf(breakdown.toolsTokens),
		messageTokens: countOf(breakdown.messageTokens),
		asOfSeq: countOf(snapshot.asOfSeq),
	}
	// ③ 还没跑过请求：两个"已用"口径都缺 ⇒ 不给百分比（也不给 0）。
	if (pressureTokens === null && projectedTokens === null) return { ...occupancy, state: 'no-request' }
	// ④ 有用量、容量未知：不给百分比（页面按"以已用为满"画临时条）。
	if (contextWindow === null) return { ...occupancy, state: 'no-window' }
	return { ...occupancy, state: 'ready' }
}

/**
 * 一位**活着**成员的占用与三段（服务守卫 + 一次同步投影读；已结束成员见 `cachedOccupancyOf`）。
 * @param ctx - 宿主 ctx。
 * @param agent - `agents.get(memberId)` 的结果（可为 undefined）。
 * @returns 同 {@link occupancyFromSnapshot} 的形状 + `source:'live'` / `ended:false`；
 *   服务缺/不在场时给对应 state。
 */
export function occupancyOf(ctx, agent) {
	return { ...liveOccupancyOf(ctx, agent), source: 'live', ended: false }
}

/**
 * 活会话的投影读本体（`occupancyOf` 只负责在它外面盖 `source` / `ended` 两枚标记）。
 * @param ctx - 宿主 ctx。
 * @param agent - `agents.get(memberId)` 的结果（可为 undefined）。
 * @returns 同 {@link occupancyFromSnapshot} 的形状。
 */
function liveOccupancyOf(ctx, agent) {
	const projections = serviceOf(ctx, 'sessionProjections')
	const meter = serviceOf(ctx, 'tokenMeter')
	if (projections === null || projections === undefined || meter === null || meter === undefined) {
		return { ...emptyOccupancy(), state: 'no-service', reason: CONTEXT_METER_MISSING }
	}
	if (agent === null || agent === undefined || agent.session === null || agent.session === undefined) {
		return { ...emptyOccupancy(), state: 'absent', reason: CONTEXT_ABSENT }
	}
	try {
		return occupancyFromSnapshot(projections.snapshot(agent.session, ['contextPressure', 'contextBreakdown']))
	} catch (error) {
		return { ...emptyOccupancy(), state: 'error', reason: messageOf(error) }
	}
}

/** 卡面读缓存要的两把钥匙（与活会话那条路径同一组：先 `contextPressure`、再 `contextBreakdown`）。 */
const CONTEXT_CACHE_KEYS = ['contextPressure', 'contextBreakdown']

/**
 * 一位**已结束**成员的占用与三段：读**持久投影缓存**（`sessionProjectionCache.cachedSnapshot`，
 * 内存表直取、**零 I/O**），不打开会话、不读日志、不冷读（003 v2.5 §1.16）。
 *
 * 缓存只落后于日志、不超前；格式版本 / 生命周期身份 / 单元 `ver`+schema 的对账由宿主那一面做
 * （`cachedSnapshot` 对不上就回 `undefined`）—— 本函数只把"对不上"当成"没有"：
 * 回 `state:'absent'`（卡面据此回落 P19），**不猜一个 0**、也不报错整块。
 * @param ctx - 宿主 ctx。
 * @param header - `sessionQuery.listSessions()` 给的那份**表头**（生命周期身份的唯一见证）。
 * @returns 同 {@link occupancyFromSnapshot} 的形状 + `source:'cache'` / `ended:true`；
 *   缓存 miss / 服务缺失时给 `state:'absent'`。
 */
export function cachedOccupancyOf(ctx, header) {
	const projections = serviceOf(ctx, 'sessionProjections')
	const meter = serviceOf(ctx, 'tokenMeter')
	// 宿主的估计器（token-meter）缺 ⇒ 这个部署本来就没有占用读数（与活会话同一档 `no-service`）。
	if (projections === null || projections === undefined || meter === null || meter === undefined) {
		return { ...emptyOccupancy(), state: 'no-service', reason: CONTEXT_METER_MISSING }
	}
	const cache = serviceOf(ctx, 'sessionProjectionCache')
	if (header === null || header === undefined || cache === null || cache === undefined || typeof cache.cachedSnapshot !== 'function') {
		return { ...emptyOccupancy(), state: 'absent', reason: CONTEXT_ABSENT }
	}
	try {
		const snapshot = cache.cachedSnapshot(header, CONTEXT_CACHE_KEYS)
		// 缺 `contextBreakdown` 的那一份不算命中：三段读不到时给百分比只会是半份读数。
		if (snapshot === null || snapshot === undefined || snapshot.values === null || snapshot.values === undefined || snapshot.values.contextBreakdown === null || snapshot.values.contextBreakdown === undefined) {
			return { ...emptyOccupancy(), state: 'absent', reason: CONTEXT_ABSENT }
		}
		return { ...occupancyFromSnapshot(snapshot), source: 'cache', ended: true }
	} catch {
		// 缓存这一面永远 fail-soft：读坏了就是"这个成员没有可用缓存"，不能把整块成员表带塌。
		return { ...emptyOccupancy(), state: 'absent', reason: CONTEXT_ABSENT }
	}
}

/**
 * 一次 `sessionQuery.listSessions()` 换一张 **会话 id → 表头** 的表（`/members` 全部行共用一次调用）。
 *
 * 为什么只要表头：`cachedSnapshot(meta)` 用表头做生命周期身份（`formatVersion`/`createdAt`/`cwd`/
 * `isSeeded`），**不读日志**（`dsh-session-query/src/index.ts:186-187`）—— 这是"零 I/O"能成立的前提。
 * @param ctx - 宿主 ctx。
 * @returns `Map<id, header>`；服务缺失 / 抛错时 `null`（调用方按"没有表头"回落 P19）。
 */
export async function sessionHeaderMapOf(ctx) {
	const query = serviceOf(ctx, 'sessionQuery')
	if (query === null || query === undefined || typeof query.listSessions !== 'function') return null
	try {
		const records = await query.listSessions()
		const map = new Map()
		for (const record of Array.isArray(records) ? records : []) {
			const header = record !== null && record !== undefined ? record.header : undefined
			const id = header !== null && header !== undefined ? header.id : undefined
			if (typeof id === 'string' && id !== '') map.set(id, header)
		}
		return map
	} catch {
		return null
	}
}

/** 会话末事件的时刻（`asOfTime`）：取 `lease.events` 最后一条的 `time`，转 ISO；读不到给 null。 */
function asOfTimeOf(lease) {
	const events = lease !== null && lease !== undefined && Array.isArray(lease.events) ? lease.events : []
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const time = events[index] !== null && events[index] !== undefined ? events[index].time : undefined
		if (typeof time === 'number' && Number.isFinite(time)) {
			try {
				return new Date(time).toISOString()
			} catch {
				return null
			}
		}
	}
	return null
}

/** 已用 token：与宿主 `context-occupancy.ts` 同一条（`projectedTokens` 优先）。 */
export function usedTokensOf(occupancy) {
	if (occupancy === null || occupancy === undefined) return null
	if (typeof occupancy.projectedTokens === 'number') return occupancy.projectedTokens
	if (typeof occupancy.pressureTokens === 'number') return occupancy.pressureTokens
	return null
}

/** 三段（系统 / 工具 / 消息）：页面顶部 8px 条与 L1 的三行用同一份。 */
export function segmentsOf(occupancy) {
	if (occupancy === null || occupancy === undefined || occupancy.available !== true) return null
	return {
		system: occupancy.systemTokens ?? null,
		tools: occupancy.toolsTokens ?? null,
		messages: occupancy.messageTokens ?? null,
	}
}

/**
 * 分页参数：`page` 缺省 / `0` / `all` ⇒ 全量（面板一次读全，前端自己切片）；
 * 正整数 ⇒ 累计到第 N 页（每类各 50 条）。排序只认 `size` / `count` / `name`。
 * @param url - 请求 URL。
 * @returns `{ page, sort }`。
 */
export function pageOptionsOf(url) {
	const rawPage = queryValue(url, 'page')
	const page = /^\d+$/.test(rawPage) ? Number(rawPage) : 0
	const rawSort = queryValue(url, 'sort')
	const sort = rawSort === 'count' || rawSort === 'name' || rawSort === 'size' ? rawSort : 'size'
	return { page, sort }
}

/**
 * 详情端点本体：取租约 → 折七类 → 分页 / 排序 → 回 JSON。
 * @param ctx - 宿主 ctx。
 * @param req - 请求（只收 GET / HEAD）。
 * @param res - 响应。
 * @param fallback - composition 行里配的工作区（请求没带 `?workspace=` 时用它）。
 */
export async function handleMemberContext(ctx, req, res, fallback) {
	if (req?.method !== 'GET' && req?.method !== 'HEAD') {
		writeJson(res, 405, { ok: false, error: '成员上下文详情只支持 GET（本端点只读）' })
		return
	}
	const member = queryValue(req?.url, 'member')
	if (member === '') {
		writeJson(res, 400, { ok: false, error: '要带 `?member=<成员会话 id>` —— 它是这一位成员自己的会话，不是团队根会话。' })
		return
	}
	const opened = await openWorkspaceOf(ctx, req, res, fallback)
	if (opened === null) return
	const { page, sort } = pageOptionsOf(req?.url)
	const readAt = new Date().toISOString()
	const base = { ok: true, member, session: member, workspace: opened.root, readAt, page: { page, pageSize: MEMBER_CONTEXT_PAGE_SIZE }, sort }

	// 按需分支：全文（v2.2 §12.3）与逐项详情（v2.4 §1.14）。都不预取、与首屏载荷分开。
	const part = queryValue(req?.url, 'part')
	if (part === 'system-full') {
		await handleSystemFull(ctx, res, base, member)
		return
	}
	if (part === 'item') {
		await handleItemDetail(ctx, res, base, member, req?.url)
		return
	}

	let agent
	try {
		const agents = serviceOf(ctx, 'agents')
		agent = agents !== null && agents !== undefined && typeof agents.get === 'function' ? agents.get(member) : undefined
	} catch (error) {
		writeJson(res, 200, { ...base, state: 'l2', reason: messageOf(error), ended: false, occupancy: null, reconcile: null, warnings: [messageOf(error)] })
		return
	}
	const meter = serviceOf(ctx, 'tokenMeter')
	// L2：连 token-meter 都没有 ⇒ 占用与构成都读不到（已结束成员也一样：没有估计器就没有七类价）。
	if (meter === null || meter === undefined) {
		writeJson(res, 200, { ...base, state: 'l2', reason: CONTEXT_METER_MISSING, ended: agent === null || agent === undefined, occupancy: null, reconcile: null, warnings: [CONTEXT_METER_MISSING] })
		return
	}

	// 缺席成员不在这里提前判 L3：`observeSession` 的 **prepared 分支**能读已结束会话
	// （live-preferred；不读宿主日志文件，见 003 §1.13 / A20）。
	const cold = agent === null || agent === undefined
	let occupancy = cold ? { ...emptyOccupancy(), state: 'absent', reason: CONTEXT_ABSENT } : occupancyOf(ctx, agent)
	let lease
	try {
		const query = serviceOf(ctx, 'sessionQuery')
		if (query === null || query === undefined || typeof query.observeSession !== 'function') {
			throw new Error('本部署没有会话观察服务（session-query）：细类读不到。')
		}
		lease = await query.observeSession(member, { projectionMode: cold ? 'all' : 'none' })
		const ended = lease.source === 'prepared' && cold
		// 已结束成员：占用/三段来自 **prepared 租约的投影**（同一套字段、同一套判据）。
		if (lease.source === 'prepared' && lease.projections !== undefined) occupancy = occupancyFromSnapshot(lease.projections)
		const folded = foldContext(lease.events, { estimateMessage: (message) => meter.estimateMessage(message) })
		// 分页只影响渲染多少行；合计与项数始终是全量（`pagedOf` 自己给 shown / total / hasMore）。
		const items = {}
		const totals = {}
		for (const key of ['system', 'user', 'inject', 'skill', 'assistant', 'tool']) {
			const paged = pagedOf(folded.items[key], page, MEMBER_CONTEXT_PAGE_SIZE)
			items[key] = paged.items
			totals[key] = paged.total
		}
		const toolsPaged = pagedOf(sortedToolsOf(folded.tools, sort), page, MEMBER_CONTEXT_PAGE_SIZE)
		totals.tools = toolsPaged.total
		const hasMore =
			toolsPaged.hasMore || ['system', 'user', 'inject', 'skill', 'assistant', 'tool'].some((key) => totals[key] > items[key].length)
		writeJson(res, 200, {
			...base,
			state: 'ready',
			reason: null,
			source: lease.source,
			// 已结束 = prepared **且** agents.get 为空（idle 的活成员是 live，不算 ended，A22）。
			ended,
			// 数据时刻取**租约的 cursor**（这份读数折到哪一刻），不自己数最后一条事件的 seq；
			// `asOfTime` 是末事件的落盘时刻（P4 / P16）。
			asOfSeq: typeof lease.cursor === 'number' ? lease.cursor : typeof folded.asOfSeq === 'number' ? folded.asOfSeq : null,
			asOfTime: asOfTimeOf(lease),
			occupancy,
			segments: segmentsOf(occupancy),
			categories: folded.categories,
			counts: folded.counts,
			// 段头汇总（v2.2 §1.12.4）：与逐项同源、不受分页影响（A17）。
			segmentDigest: folded.segmentDigest,
			// 对账账（v2.1 §⑧）：Δ 只从**同一份** lease.events 折出来，不另开租约、不取模型服务。
			reconcile: folded.reconcile,
			// fork 成员的继承前缀：`seq < inheritedEventCount` 的项在页面上挂「继承」徽标（P13）。
			inheritedEventCount: typeof lease.inheritedEventCount === 'number' ? lease.inheritedEventCount : 0,
			items,
			totals,
			tools: toolsPaged.items,
			page: { page, pageSize: MEMBER_CONTEXT_PAGE_SIZE, hasMore },
			warnings: [],
		})
	} catch (error) {
		const reason = messageOf(error)
		// 缺席成员读不到（notFound / CORRUPT / abort）：L3 + 原因原文（A21；不新增状态码）。
		if (cold) {
			writeJson(res, 200, { ...base, state: 'l3', reason, ended: true, occupancy: null, reconcile: null, warnings: [reason] })
			return
		}
		// L1：细类折不出来，但投影还读得到 ⇒ 只给三段（页面套 P8）。
		if (occupancy.available === true) {
			writeJson(res, 200, {
				...base,
				state: 'l1',
				reason,
				ended: false,
				occupancy,
				segments: segmentsOf(occupancy),
				reconcile: null,
				warnings: [reason],
			})
			return
		}
		// 连投影也没有 ⇒ L2（与 token-meter 缺同形）。
		writeJson(res, 200, { ...base, state: 'l2', reason, ended: false, occupancy: null, reconcile: null, warnings: [reason] })
	} finally {
		// 租约是调用方持有的资源：用完必须释放（本版宿主只有同步 `Symbol.dispose`）。
		try {
			if (lease !== null && lease !== undefined && typeof lease[Symbol.dispose] === 'function') lease[Symbol.dispose]()
		} catch {
			/* 释放失败不影响已经写出的回执 */
		}
	}
}

/**
 * `part=system-full`：取最后一条非空 `system/message` 的 text 块拼接，按码点截到 200k。
 *
 * 边界（003 §12.3）：
 *   · **只读**：一次 `observeSession`（live / prepared 同一口径），不碰七类 / Δ / 计价；
 *   · 失败**保持 `ok:true`**（首屏预览仍在）：`fullText:null` + `fullTextError`（原因原文）；
 *   · `chars` 是**原长**；`fullTextTruncated === (chars > 200000)`；不截断时 `fullText.length === chars`。
 * @param ctx - 宿主 ctx。
 * @param res - 响应。
 * @param base - 公共回执字段。
 * @param member - 成员会话 id。
 */
async function handleSystemFull(ctx, res, base, member) {
	const fail = (reason) => writeJson(res, 200, { ...base, fullText: null, chars: null, fullTextTruncated: false, fullTextError: reason, systemSeq: null, source: null, asOfSeq: null, asOfTime: null })
	const query = serviceOf(ctx, 'sessionQuery')
	if (query === null || query === undefined || typeof query.observeSession !== 'function') {
		fail('本部署没有会话观察服务（session-query）：读不到系统提示全文。')
		return
	}
	let lease
	try {
		lease = await query.observeSession(member, { projectionMode: 'none' })
		const events = Array.isArray(lease.events) ? lease.events : []
		// 最后一条**非空** system（与 `contextBreakdown` 的 findLast(tokens > 0) 同口径：这里以"有正文"为准）。
		let systemNode = null
		for (const event of events) {
			if (event === null || event === undefined || event.type !== 'system/message') continue
			const message = event.data !== null && event.data !== undefined ? event.data.message : undefined
			const text = textOfMessage(message)
			if (text.trim() !== '') systemNode = { seq: event.seq, text }
		}
		if (systemNode === null) {
			writeJson(res, 200, {
				...base,
				fullText: null,
				chars: null,
				fullTextTruncated: false,
				fullTextError: '这份会话里没有可读的系统提示消息。',
				systemSeq: null,
				source: lease.source,
				asOfSeq: typeof lease.cursor === 'number' ? lease.cursor : null,
				asOfTime: asOfTimeOf(lease),
			})
			return
		}
		const chars = Array.from(systemNode.text).length // 码点数：与 `fullText` 的按码点截断、A23 同一单位
		const fullTextTruncated = chars > SYSTEM_FULL_MAX_CHARS
		const fullText = fullTextTruncated ? Array.from(systemNode.text).slice(0, SYSTEM_FULL_MAX_CHARS).join('') : systemNode.text
		writeJson(res, 200, {
			...base,
			fullText,
			chars,
			fullTextTruncated,
			systemSeq: systemNode.seq,
			source: lease.source,
			asOfSeq: typeof lease.cursor === 'number' ? lease.cursor : null,
			asOfTime: asOfTimeOf(lease),
		})
	} catch (error) {
		fail(messageOf(error))
	} finally {
		try {
			if (lease !== null && lease !== undefined && typeof lease[Symbol.dispose] === 'function') lease[Symbol.dispose]()
		} catch {
			/* 释放失败不影响已经写出的回执 */
		}
	}
}

/**
 * 端点工厂（与其余 `lib/*-routes.js` 同形）：宿主注入工作区解析，回两个执行面。
 * `occupancyOf` 同时供 `lib/team-routes.js` 的 `/members` 卡面使用 —— **同一份实现**。
 * @param deps - `{ openWorkspaceOf }`。
 */
export function createMemberContextRoutes(deps) {
	openWorkspaceOf = deps.openWorkspaceOf
	return { handleMemberContext }
}

/** 宿主注入的工作区解析（模块单例，与 host 单例一致）。 */
let openWorkspaceOf = async (ctx, req, res, fallback) => {
	writeJson(res, 503, { ok: false, error: '成员上下文端点没有装配工作区解析。' })
	return null
}

/**
 * 按**码点**截断（v2.4 §14.2）：`chars` 报原文长度；截断时 `Array.from(text).length === max`。
 * @param raw - 原文。
 * @param max - 码点上限。
 * @returns `{ text, chars, truncated }`。
 */
export function clipTextOf(raw, max) {
	const source = typeof raw === 'string' ? raw : ''
	// **码点**口径：chars 与本函数的截断、`fullTextTruncated`、A23/A27 全部同一单位。
	// （用 UTF-16 长度会让 30k emoji 被读成 60k 字符而误判截断。）
	const chars = Array.from(source).length
	if (chars <= max) return { text: source, chars, truncated: false }
	return { text: Array.from(source).slice(0, max).join(''), chars, truncated: true }
}

/** 一条消息的块数组（非数组读作空）。 */
function blocksOfMessage(message) {
	return message !== null && message !== undefined && Array.isArray(message.content) ? message.content : []
}

/**
 * 逐项详情的**字段构造**（v2.4 §14.2；只读、不参与计价 / 七类 / Δ）。
 *
 * 安全口径（§14.4 / A29）：
 *   · 助手只给 `toolCalls: [{ name }]` 与 `toolArgsChars`（**参数内容一个字符都不返回**）；
 *   · 工具结果只给结果文本与 `toolName`；图片只给计数；
 *   · 工具定义（schema 原文）不在本接口里 —— 没有事件的类别由路由直接拒绝。
 * @param event - 存活的 surface 事件。
 * @param category - 归位类别。
 * @param extra - `{ marker, kind, toolName }`（注入的标签 / 工具结果的工具名）。
 * @returns 详情对象（字段按类别出现）。
 */
export function itemDetailOf(event, category, extra = {}) {
	const message = messageOfEvent(event)
	const blocks = blocksOfMessage(message)
	const text = clipTextOf(textOfMessage(message), ITEM_MAX_CHARS)
	const detail = { text: text.text, textChars: text.chars, textTruncated: text.truncated }
	if (category === 'assistant') {
		// 推理全文：把 reasoning 块的文本按出现顺序拼接（空推理块不出字符）。
		let reasoningSource = ''
		for (const block of blocks) {
			if (block !== null && block !== undefined && block.type === 'reasoning' && typeof block.text === 'string') reasoningSource += block.text
		}
		const reasoning = clipTextOf(reasoningSource, ITEM_MAX_CHARS)
		detail.reasoning = reasoning.text
		detail.reasoningChars = reasoning.chars
		detail.reasoningTruncated = reasoning.truncated
		const toolCalls = []
		let toolArgsChars = 0
		let images = 0
		for (const block of blocks) {
			if (block === null || block === undefined || typeof block !== 'object') continue
			if (block.type === 'tool-call') {
				toolCalls.push({ name: typeof block.name === 'string' ? block.name : '' })
				if (typeof block.arguments === 'string') toolArgsChars += block.arguments.length
			} else if (block.type === 'image') {
				images += 1
			}
		}
		detail.toolCalls = toolCalls
		detail.toolArgsChars = toolArgsChars
		detail.images = images
		return detail
	}
	if (category === 'inject') {
		if (typeof extra.marker === 'string' && extra.marker !== '') detail.marker = extra.marker
		if (typeof extra.kind === 'string' && extra.kind !== '') detail.kind = extra.kind
		return detail
	}
	if (category === 'tool') {
		if (typeof extra.toolName === 'string' && extra.toolName !== '') detail.toolName = extra.toolName
		return detail
	}
	return detail
}

/**
 * `part=item&seq=`：单条存活 surface 事件的完整详情（v2.4 §1.14）。
 *
 * 读取路径：一次 `observeSession`（live / prepared 同 §1.13）→ 只按 `surfaceOp` 折叠出存活表层
 * （**不算价**）→ 找 `seq` → 按类别取字段。失败一律 `ok:true + detail:null + detailError`（读不到 ≠ 没有）。
 * @param ctx - 宿主 ctx。
 * @param res - 响应。
 * @param base - 公共回执字段。
 * @param member - 成员会话 id。
 * @param url - 请求 URL（取 `seq`）。
 */
async function handleItemDetail(ctx, res, base, member, url) {
	const write = (payload) => writeJson(res, 200, { ...base, seq: null, category: null, detail: null, ...payload })
	const rawSeq = queryValue(url, 'seq')
	if (!/^\d+$/.test(rawSeq)) {
		write({ detailError: '要带 `&seq=<事件 seq>`（整数）。' })
		return
	}
	const seq = Number(rawSeq)
	const query = serviceOf(ctx, 'sessionQuery')
	if (query === null || query === undefined || typeof query.observeSession !== 'function') {
		write({ seq, detailError: '本部署没有会话观察服务（session-query）：读不到这一项的详情。' })
		return
	}
	let lease
	try {
		lease = await query.observeSession(member, { projectionMode: 'none' })
		const surface = survivingSurfaceOf(lease.events)
		const event = surface.eventOf(seq)
		if (event === null) {
			write({
				seq,
				detailError: '这一项已不在当前表层（被压缩替换），没有可展开的详情。',
				asOfSeq: typeof lease.cursor === 'number' ? lease.cursor : null,
				asOfTime: asOfTimeOf(lease),
				source: lease.source,
			})
			return
		}
		const category = categoryOfEvent(event, surface.lastSystemSeq)
		if (category === 'system') {
			write({
				seq,
				category,
				detailError: '系统提示词请用「查看全文」（part=system-full）取；逐项详情不重复提供。',
				asOfSeq: typeof lease.cursor === 'number' ? lease.cursor : null,
				asOfTime: asOfTimeOf(lease),
				source: lease.source,
			})
			return
		}
		const message = messageOfEvent(event)
		const kind = event !== null && event.data !== null && event.data !== undefined && event.data.source !== null && event.data.source !== undefined && typeof event.data.source.kind === 'string'
			? event.data.source.kind
			: message !== null && message !== undefined && message.source !== null && message.source !== undefined && typeof message.source.kind === 'string'
				? message.source.kind
				: ''
		let marker = ''
		if (event.type === 'developer/message') marker = '工具增删通知'
		else if (event.type === 'system/message' && event.seq !== surface.lastSystemSeq) marker = '旧系统提示'
		const toolCallId = message !== null && message !== undefined && typeof message.toolCallId === 'string' ? message.toolCallId : ''
		const detail = itemDetailOf(event, category, { marker, kind, toolName: toolCallId === '' ? '' : surface.toolNameOf(toolCallId) })
		write({
			seq,
			category,
			detail,
			asOfSeq: typeof lease.cursor === 'number' ? lease.cursor : null,
			asOfTime: asOfTimeOf(lease),
			source: lease.source,
		})
	} catch (error) {
		write({ seq, detailError: messageOf(error) })
	} finally {
		try {
			if (lease !== null && lease !== undefined && typeof lease[Symbol.dispose] === 'function') lease[Symbol.dispose]()
		} catch {
			/* 释放失败不影响已经写出的回执 */
		}
	}
}
