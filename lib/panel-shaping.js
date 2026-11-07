/**
 * 面板载荷的**纯整形层**：把文件 / 原生读数收敛成"只有标量叶子"的页面载荷。
 *
 * 为什么从 `board-view.host.js` 分出来：这些函数不碰 ctx、不碰文件系统、不认 HTTP，
 * 只做「输入 → 载荷」的收敛（长度上限、放行字段、读数文案）。放在宿主文件里会和路由、
 * 引擎装配、工作区解析挤在一起，改一个上限要看 3000 行；分出来之后边界就是这文件的导出面。
 *
 * 硬纪律：截断只砍、不说 —— 砍掉了什么由调用方在载荷里给出可读读数（`truncations` /
 * `total`），不在这里静默吞。
 */

/**
 * 成员行进入页面载荷的条数上限。
 *
 * 名册正常是几个到几十个；超过这个数说明有东西在灌这份文件。**截断必须看得见**：载荷同时带上
 * 引擎的 `total`，面板在 `rows` 少于 `total` 时写明"只显示了前 N 行"——不写就等于把截断说成全部。
 * 计数那几个数**不受它影响**（它们是引擎按整本名册算的）。
 */
export const MEMBER_ROWS_LIMIT = 200

/**
 * 成员行里**要显式放行**的两个非标量字段的长度上限。
 *
 * `linked.missingIds` 最多也就这么长；给上限是为了让"有人在灌这份文件"
 * 时页面载荷仍然有界（与 `MEMBER_ROWS_LIMIT` 同一条纪律：超了要看得见，不能悄悄涨）。
 */
export const MEMBER_BOARD_IDS_LIMIT = 32
export const MEMBER_MISSING_IDS_LIMIT = 32

/** 只放行 JSON 可承载的标量，其余（对象/数组/函数）一律读作 null。 */
export function asScalar(value) {
	if (value === null || value === undefined) return null
	const type = typeof value
	if (type === 'string' || type === 'number' || type === 'boolean') return value
	return null
}

/**
 * 把任意值收敛成长度受限的标量数组，非数组读作空数组。
 *
 * **截断由调用方负责说出来**：这里只砍、不说 —— 砍掉了什么必须由调用方在它自己的载荷里
 * 给出可读的读数（`handleTeamTasks` 的 `truncations` 就是那处登记本；`length < total` 要看得见）。
 */
export function asScalarArray(value, max) {
	if (!Array.isArray(value)) return []
	const out = []
	for (let i = 0; i < value.length && i < max; i++) {
		const scalar = asScalar(value[i])
		if (scalar !== null) out.push(scalar)
	}
	return out
}

/**
 * 把对象收敛成「只有标量叶子」的扁平记录，键名沿用原样。
 * 用于投票、决定这类结构未知或不稳定的嵌套对象 —— 不枚举其键，因此文件新增
 * 字段时前端自动看得到，而不会因为漏写白名单被静默吞掉。
 */
export function shapeRecord(raw) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
	const out = {}
	const keys = Object.keys(raw)
	for (let i = 0; i < keys.length; i++) {
		const scalar = asScalar(raw[keys[i]])
		if (scalar !== null) out[keys[i]] = scalar
	}
	return out
}

/** 扁平记录数组，长度受限，非对象元素丢弃。 */
export function shapeRecordArray(value, max) {
	if (!Array.isArray(value)) return []
	const out = []
	for (let i = 0; i < value.length && i < max; i++) {
		const shaped = shapeRecord(value[i])
		if (shaped !== null) out.push(shaped)
	}
	return out
}

/**
 * 成员卡右侧计数槽的**读数**：把引擎 `linked` 的判定摊成中文，供界面就地显示。
 *
 * 只做「哪一档 → 哪句话」的翻译：**不重算比率、不另设阈值** ——
 * 一旦让前端自己拼 `delivered/assigned`，面板与工具回执迟早给出不同的数。
 * 四档（第三档带失效编号点名）：
 *   · 看板里没有归属给它的条目（`linked === null`）⇒「未链接（显示最后动笔）」，**绝不印 `0/0`**：
 *     `0/0` 会被读成"链接了、零条交付"，而真相是压根没链接过；
 *   · 看板文件读不到 ⇒「不给数（看板文件读不到）」—— 读不到不是零交付；
 *   · 已链接 ⇒ `已交付 <delivered>/<assigned>`（分母只数**能在看板里查到的**编号）；
 *   · `missing > 0` 时**必须**在同一句里带出「链接失效 n 条：…」（协调器 D1 裁决的硬要求）；
 *     链接的编号**全部查不到**时分母是 0，此时不印 `0/0`（那与"未链接"的空读数长得一样），
 *     改印「有效链接 0 条」。
 * @param linked - 成员行的派生字段 `linked`（`null` = 未链接）。
 * @returns 可直接上卡的那一句。
 */
export function linkedReadingOf(linked) {
	if (linked === null || linked === undefined) return '未链接（显示最后动笔）'
	if (linked.boardUnavailable === true || linked.assigned === null) return '不给数（看板文件读不到）'
	const missing = typeof linked.missing === 'number' ? linked.missing : 0
	const ids = Array.isArray(linked.missingIds) ? linked.missingIds : []
	const stale = missing > 0 ? `链接失效 ${missing} 条：${ids.join('、')}` : ''
	const head = linked.assigned === 0 ? '有效链接 0 条' : `已交付 ${linked.delivered}/${linked.assigned}`
	return stale === '' ? head : `${head}；${stale}`
}

/** `linked` 的整形：三个数 + 点名的编号 + 「读不到」标记。 */
export function shapeLinked(raw) {
	if (raw === null || raw === undefined) return null
	if (typeof raw !== 'object' || Array.isArray(raw)) return null
	const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
	return {
		assigned: count(raw.assigned),
		delivered: count(raw.delivered),
		missing: count(raw.missing),
		missingIds: asScalarArray(raw.missingIds, MEMBER_MISSING_IDS_LIMIT),
		boardUnavailable: typeof raw.boardUnavailable === 'boolean' ? raw.boardUnavailable : null,
	}
}

/**
 * 成员行的整形：通用的 `shapeRecord` **再加两个显式放行的字段**。
 *
 * 为什么不能只用 `shapeRecord`：它按界面约定只留**标量叶子**（对象与数组一律读作 null），
 *
 * 为什么只放行这两个、不去改通用的 `shapeRecord`：那个整形器是给"结构未知"的嵌套对象用的
 * （例如文件里的 `history`），在那里放行数组等于给任意嵌套结构开一个口子，
 * 顺着成员行漏进整页载荷。放行面按字段点名收口，是这两个字段自己的事。
 *
 * 外加一格**摊好的读数** `linkedText`（同 `dueText` 那个用法）：面板直接把它
 * 印在卡上，于是"卡上那个比率"与"JSON 里那几个数"不可能对不上。
 * @param raw - `/members` 载荷里的一行成员记录。
 * @returns 只含标量叶子 + 两个放行字段的记录，或 null（不是对象）。
 */
export function shapeMember(raw) {
	const flat = shapeRecord(raw)
	if (flat === null) return null
	flat.linked = shapeLinked(raw.linked)
	flat.linkedText = linkedReadingOf(flat.linked)
	return flat
}

/** 成员行数组：走成员专用整形（放行 `linked`），长度受限，非对象元素丢弃。 */
export function shapeMemberArray(value, max) {
	if (!Array.isArray(value)) return []
	const out = []
	for (let i = 0; i < value.length && i < max; i++) {
		const shaped = shapeMember(value[i])
		if (shaped !== null) out.push(shaped)
	}
	return out
}

/** 状态文件共有的顶层标量：seq 与 writer。 */
export function shapeEnvelope(parsed) {
	const rawWriter = parsed.writer
	const writer = rawWriter !== null && typeof rawWriter === 'object'
		? { at: asScalar(rawWriter.at), pid: asScalar(rawWriter.pid), host: asScalar(rawWriter.host) }
		: null
	return {
		seq: typeof parsed.seq === 'number' ? parsed.seq : null,
		writer,
	}
}

/**
 * 看板条目：只摘前端需要的叶子字段 **＋ 运行时机制那几个**。
 *
 * 后加的这一组（`revision` / `assignee` / `attempt` / `attemptId` / `blockedByTasks` /
 * `writeScopes` / `acceptance`）不是装饰：没有它们，面板上就看不到"这条活第几版、谁在干、
 * 哪一代、依赖谁、要动哪些文件" —— 而那几个数正是机制落地之后**人最需要盯**的东西
 * （工具回执里有、面板上看不见，等于只有模型知道）。
 * `writeScopeWarnings` 由调用方按整板算好挂上来（判定在引擎 `writeScopeWarningsOf` 一处）。
 */
export function shapeTask(raw) {
	if (raw === null || typeof raw !== 'object') return null
	return {
		id: asScalar(raw.id),
		revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : null,
		assignee: asScalar(raw.assignee),
		attempt: Number.isInteger(raw.attempt) && raw.attempt >= 0 ? raw.attempt : null,
		attemptId: asScalar(raw.attemptId),
		blockedByTasks: asScalarArray(raw.blockedByTaskIds, 32),
		writeScopes: asScalarArray(raw.writeScopes, 32),
		acceptance: shapeRecord(raw.acceptance),
		description: asScalar(raw.description),
		owner: asScalar(raw.owner),
		priority: asScalar(raw.priority),
		phase: asScalar(raw.phase),
		status: asScalar(raw.status),
		artifact: asScalar(raw.artifact),
		grade: asScalar(raw.grade),
		note: asScalar(raw.note),
		// 卡片要就地显示「卡在：…」，所以整形载荷带上它 —— 界面对它的用法就是"把这条挂在卡上"。
		// 少了这个字段，人只能靠面板顶上那一行汇总去找哪张卡卡住了，而那行汇总已被现场否掉。
		blockedBy: asScalar(raw.blockedBy),
		createdAt: asScalar(raw.createdAt),
		updatedAt: asScalar(raw.updatedAt),
	}
}

/** 各文件的整形器（只余看板那一份：审批与共识随制度一并撤下）。 */
export const SHAPERS = { board: shapeTask }

/** 从成员读数的 Markdown 里取提示行（`> …`），原样交给客户端渲染，不另写一份措辞。 */
export function annotationLinesOf(markdown) {
	return String(markdown === null || markdown === undefined ? '' : markdown)
		.split('\n')
		.filter((line) => line.startsWith('>'))
}

