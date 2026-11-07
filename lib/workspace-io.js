/**
 * 工作区解析与遗留账读取：面板所有端点共用的那一层 IO。
 *
 * 从 `board-view.host.js` 分出来之后，宿主只剩 loader entry、路由常量表、引擎装配与端点装配；
 * 会话回落、写侧边界、同源判定、原始条目读取在这里各只有一份正文。
 * `ROUTE_PATH` / `LEDGERS` 由宿主注入（否则会与宿主形成循环 import）。
 */
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { messageOf, writeJson } from './http-tools.js'
import { SHAPERS, shapeEnvelope } from './panel-shaping.js'
import { BOARD_STATUSES } from './board-status.js'
import { writeScopeWarningsOf } from '../team/company-gate.js'

/** 看板优先级的取值域（与引擎同源；只用于标出"枚举外"的条目）。 */
const BOARD_PRIORITIES = ['P0', 'P1', 'P2', 'P3', '—']

/** 宿主注入的路由常量（模块单例，与 host 单例一致）。 */
let cfg = { ROUTE_PATH: '', LEDGERS: {} }

/**
 * @param injected - `{ ROUTE_PATH, LEDGERS }`。
 * @returns 端点装配与路由分派要用的函数引用。
 */
export function createWorkspaceIO(injected) {
	cfg = injected
	return {
		requestedWorkspace,
		ledgerKeyOf,
		isLoopbackSameOrigin,
		openWorkspaceOf,
		openWorkspaceSoftly,
		workspaceSourceWarnings,
		readRawItems,
		readLedger,
	}
}

/** 一个会话的工作目录：`header.cwd` 是绝对路径且非空才算数（子会话单独排除，见下）。 */
function cwdOfSession(session) {
	const cwd = session === null || typeof session !== 'object' ? undefined : session.header?.cwd
	return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** 根会话（没有 `parentSession`）：成员子会话与它共用工作目录，按"人在看哪个会话"看，根会话才是那个。 */
function rootSessionsOf(ctx) {
	try {
		const service = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
		const rows = service !== undefined && typeof service.list === 'function' ? service.list() : []
		return (rows ?? []).filter((session) => session?.header?.parentSession === undefined && cwdOfSession(session) !== undefined)
	} catch (error) {
		console.warn('[dsh-team-ops] 读会话清单失败（不影响其它回落）：', messageOf(error))
		return []
	}
}

/**
 * 视图栏没报到自己的会话、注册表里又有多个工作区时的**推断级回落**（只有两级，且都点名来源）。
 *
 * 为什么允许推断：会话 id 是渲染端的事实，宿主没有"我正在看哪个会话"的通道 ——
 * 硬报错会让整块面板在这种部署里完全不可用。两级都取"最可能正在被看"的那个会话：
 *   ① **唯一一个在跑的根会话**（人在说话时最常命中；多于一个在跑就不猜）；
 *   ② 否则**最近创建的那个根会话**（在浏览器里刚打开/刚用过的那个，按 `header.createdAt` 取最新）。
 * 推断结果一律经 `workspaceSource` 与警告写进载荷，**不冒充"当前会话的工作区"**。
 * @param ctx - 宿主 ctx（`agents` / `sessions` 都走 `ctx.get`，不进 `inject`）。
 * @returns `{ root, source }`，或 null（推断不出来）。
 */
function sessionInferredWorkspace(ctx) {
	try {
		const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
		const running = (agents !== undefined && typeof agents.list === 'function' ? agents.list() : []).filter(
			(agent) => agent?.status === 'running' && agent.session?.header?.parentSession === undefined && cwdOfSession(agent.session) !== undefined,
		)
		const runningCwds = [...new Set(running.map((agent) => cwdOfSession(agent.session)))]
		if (runningCwds.length === 1) return { root: runningCwds[0], source: 'agent-running' }
	} catch (error) {
		console.warn('[dsh-team-ops] 读 Agent 清单失败（回落到下一级）：', messageOf(error))
	}
	const newest = rootSessionsOf(ctx).reduce((latest, session) => {
		if (latest === null) return session
		return (session.header?.createdAt ?? 0) > (latest.header?.createdAt ?? 0) ? session : latest
	}, null)
	if (newest !== null) return { root: cwdOfSession(newest), source: 'session-recent' }
	return null
}

/**
 * 请求没带 `workspace` 时用的回落，从"确定的"到"推断的"四级：
 *   ① `config` —— 该 composition 行配了 `config.workspace`；
 *   ② `registry-single` —— 工作区注册表里**恰好一个**工作区；
 *   ③ `agent-running` / `session-recent` —— **唯一在跑的根会话** / **最近创建的根会话**（见 `sessionInferredWorkspace`）；
 *   ④ 都没有 ⇒ 503（**不编造工作区**）。
 *
 * 为什么要这些级：视图栏是**按会话**渲染的，浏览器半边取"当前会话的工作目录"；
 * 那一格取不到时（会话刚建、宿主 store 形状变了、页面还没换到新版模块）以前直接 503。
 * 每一级都**必须在载荷里说明**（`workspaceSource` + 一条警告），否则读的人会把
 * "回落/推断出来的工作区"当成"当前会话的工作区" —— 那比报错更坏。
 * @param ctx - 宿主 ctx（可选服务都走 `ctx.get`，不进 `inject`）。
 * @param configured - composition 行 `config.workspace` 的值（可为 null）。
 * @returns `{ root, source, candidates }`：`source ∈ request / config / registry-single / agent-running / session-recent / none`。
 */
async function fallbackWorkspaceOf(ctx, configured) {
	if (typeof configured === 'string' && configured !== '') return { root: configured, source: 'config', candidates: 1 }
	let paths = []
	try {
		const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
		const rows = registry !== undefined && typeof registry.list === 'function' ? registry.list() : []
		paths = [...new Set((rows ?? []).map((row) => (row === null || typeof row !== 'object' ? undefined : row.path)).filter((path) => typeof path === 'string' && path !== ''))]
	} catch (error) {
		console.warn('[dsh-team-ops] 读工作区注册表失败（本次按「没有可读工作区」回答）：', messageOf(error))
		return { root: null, source: 'none', candidates: 0 }
	}
	if (paths.length === 1) return { root: paths[0], source: 'registry-single', candidates: 1 }
	const inferred = sessionInferredWorkspace(ctx)
	if (inferred !== null && typeof inferred.root === 'string' && inferred.root !== '') return { root: inferred.root, source: inferred.source, candidates: paths.length }
	return { root: null, source: 'none', candidates: paths.length }
}

/**
 * 本次工作区是怎么定下来的 —— 回落时**必须**随载荷说明（`workspaceSource`）。
 * 面板的元信息行照印它，于是"这一栏读的是当前会话的工作区"与"读的是唯一工作区"不会被混为一谈。
 * @param resolved - {@link fallbackWorkspaceOf} 的结果。
 * @returns 警告文案数组（按请求带的和按配置来的都不产生警告）。
 */
function workspaceSourceWarnings(resolved) {
	if (resolved.source === 'registry-single') {
		return ['本次工作区是**按唯一工作区回落**的（请求里没带 workspace 参数，composition 行也没配）：视图栏没能取到当前会话的工作目录。读到的是这个工作区的文件 —— 若当前会话其实在别的工作区，刷新页面或给那一行配 config.workspace。']
	}
	if (resolved.source === 'agent-running') {
		return ['本次工作区是**按「唯一在跑的会话」推断**的（视图栏没报到自己的会话，注册表里又有多个工作区）：读到的是那个会话工作目录下的文件。刷新页面让视图栏重新取一次；若这不是你要看的会话，就在该 composition 行配 config.workspace。']
	}
	if (resolved.source === 'session-recent') {
		return ['本次工作区是**按「最近创建的会话」推断**的（视图栏没报到自己的会话，注册表里又有多个工作区，且没有唯一在跑的会话）：读到的是那个会话工作目录下的文件。刷新页面让视图栏重新取一次；若这不是你要看的会话，就在该 composition 行配 config.workspace。']
	}
	if (resolved.source === 'config') return ['本次工作区取自该 composition 行的 config.workspace（请求里没带 workspace 参数）。']
	return []
}

/** 三种"取不到工作区"各自的说明——分别说清下一步该配什么/点什么，不合并成一句话。 */
function noWorkspaceMessage(candidates) {
	return candidates > 1
		? `没有可读的工作区：请求里没带 workspace 参数，composition 行也没配 config.workspace，注册表里有 ${candidates} 个工作区，而**会话这一侧也没给出可推断的线索**（没有唯一在跑的会话，也没有可用的会话清单）—— **不编造**。修法：刷新页面让视图栏报到它自己的会话；或在该 composition 行配 config.workspace。`
		: '没有可读的工作区：请求里没带 workspace 参数，该 composition 行也没配 config.workspace，工作区注册表里也没有可回落的工作区。修法：打开一个会话让视图栏取到它的工作目录，或在该 composition 行配 config.workspace。'
}

/**
 * 从请求的查询串里取请求方声明的工作区。
 *
 * 视图栏是按会话渲染的，切换会话时浏览器半边会把当前会话的工作目录带上 ⇒ 这里按请求读，
 * 而不是只认 composition 行里那一个常量，前端页才能跟着工作区实时变。
 * 只做形态校验（绝对路径、无 NUL、存在且是目录）；读取面很窄 —— 任何情况下都只读该目录下
 * 三个固定文件名（见 LEDGERS），不列目录、不读别的文件。
 * @param url - 请求 URL。
 * @returns `{ kind: 'absent' }` 未带参数、`{ kind: 'ok', value }` 可用、`{ kind: 'bad', error }` 形态不合法。
 */
export function requestedWorkspace(url) {
	const query = typeof url === 'string' ? url.split('#')[0].split('?')[1] : undefined
	if (query === undefined || query.length === 0) return { kind: 'absent' }
	let raw
	try {
		raw = new URLSearchParams(query).get('workspace')
	} catch (error) {
		return { kind: 'bad', error: '查询串解析失败：' + messageOf(error) }
	}
	if (raw === null) return { kind: 'absent' }
	const value = raw.trim()
	if (value.length === 0) return { kind: 'bad', error: 'workspace 参数为空' }
	if (value.indexOf('\u0000') !== -1) return { kind: 'bad', error: 'workspace 参数含 NUL' }
	if (!value.startsWith('/')) return { kind: 'bad', error: 'workspace 必须是绝对路径：' + value }
	return { kind: 'ok', value }
}

/**
 * 一个路径的**规范化形态**（拿不到就原样返回）：两侧都用同一个函数算，才比得起来。
 * @param ctx - 宿主 ctx（`fs.resolve`）。
 * @param value - 待规范化的路径。
 * @returns 规范化后的字符串。
 */
async function canonicalPathOf(ctx, value) {
	try {
		const target = await ctx.fs.resolve(value)
		// 宿主的 `resolve` 返回的是**不透明目标**（`{ path }` 那种），字符串要用 `processPath` 取；
		// 拿目标的字符串化去比，两边永远不相等（现场就是这么踩的：同一路径比不中）。
		if (typeof ctx.fs.processPath === 'function') {
			const path = ctx.fs.processPath(target)
			if (typeof path === 'string' && path !== '') return path
		}
		if (typeof target === 'string' && target !== '') return target
		const fallback = target !== null && typeof target === 'object' ? target.path : undefined
		return typeof fallback === 'string' && fallback !== '' ? fallback : value
	} catch (error) {
		return value
	}
}

/**
 * 当前**已知的工作区**集合：composition 行配的那个 + 工作区注册表里的 + 每个 Agent 会话的工作目录。
 * 注册表与 agents 都是可选服务（走 `ctx.get`，不进 `inject`）。
 * @param ctx - 宿主 ctx。
 * @param configured - composition 行 `config.workspace`（可为 null）。
 * @returns `Set<string>`；**一个都枚举不到**时返回 `null`（调用方据此决定放行与说明）。
 */
async function knownWorkspacesOf(ctx, configured) {
	const found = new Set()
	let enumerated = false
	// 同一个工作区可能以两种形态出现（注册表里的写法与宿主的规范化写法，macOS 上还会差一个 `/private` 前缀）
	// ⇒ 两种都收进清单，避免"同一路径比不中"把合法写入挡掉；任意**其他**路径仍然进不来。
	const remember = async (value) => {
		if (typeof value !== 'string' || value === '') return
		const trimmed = value.replace(/\/+$/, '') === '' ? value : value.replace(/\/+$/, '')
		found.add(trimmed)
		found.add(await canonicalPathOf(ctx, trimmed))
		// **真实路径形态也要收**：同一个工作区可能以符号链接的样子出现在请求里（注册表里记的是另一种形态），
		// 现场实测过：用链接路径发写请求会被当成"不在已知清单里"拒掉 —— 那是误伤，不是防护。
		try {
			const real = realpathSync(trimmed)
			if (typeof real === 'string' && real !== '') found.add(real)
		} catch (error) {
			// 路径不存在（可能刚被删）：不收这一形态，也不报错。
		}
		enumerated = true
	}
	if (typeof configured === 'string' && configured !== '') await remember(configured)
	try {
		const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
		const rows = registry !== undefined && typeof registry.list === 'function' ? registry.list() : []
		for (const row of rows ?? []) {
			const path = row === null || typeof row !== 'object' ? undefined : row.path
			if (typeof path !== 'string' || path === '') continue
			await remember(path)
		}
	} catch (error) {
		console.warn('[dsh-team-ops] 读工作区注册表失败（写侧边界按"枚举不到"处理）：', messageOf(error))
	}
	try {
		const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
		const live = agents !== undefined && typeof agents.list === 'function' ? agents.list() : []
		for (const agent of live ?? []) {
			const cwd = cwdOfSession(agent === null || typeof agent !== 'object' ? undefined : agent.session)
			if (typeof cwd !== 'string' || cwd === '') continue
			await remember(cwd)
		}
	} catch (error) {
		console.warn('[dsh-team-ops] 读 Agent 清单失败（写侧边界按"枚举不到"处理）：', messageOf(error))
	}
	return enumerated ? found : null
}

/**
 * **写侧的工作区边界**。
 *
 * 读侧只读工作区里三个固定文件名（见 {@link LEDGERS}），所以"按请求给路径"是可以的；
 * 写侧会真的落盘 —— 如果边界也跟着请求走，那就不是栅栏，而是自我授权：任何能发本机请求的进程
 * 都能把写盘根搬到任意目录。于是写端点比读端点多一条判定：
 *
 *   ① 形态与存在性：绝对路径、存在、是目录（与读侧同一套，`fs.resolve` + `fs.stat`）；
 *   ② 归属：必须是**已知工作区**（composition 配置 / 工作区注册表 / 某个 Agent 会话的工作目录）；
 *   ③ **枚举不到任何已知工作区**（宿主没那些服务）时**不拦**，但要在回执里如实说明 ——
 *      不能把"我判不了"说成"你的路径非法"（本产品的口径：读不到不许说成没有）。
 *
 * @param ctx - 宿主 ctx。
 * @param root - 请求声明的工作区。
 * @param configured - composition 行 `config.workspace`。
 * @param source - 这个工作区是怎么定下来的（`request` / 回落级别）。
 * @returns `null` 放行；否则 `{ status, error }` 与一条可选的 `warning`。
 */
async function writableWorkspaceFinding(ctx, root, configured, source) {
	let target
	try {
		target = await ctx.fs.resolve(root)
		const info = await ctx.fs.stat(target)
		if (info === undefined) return { status: 404, error: '工作区不存在：' + root }
		if (info.type !== 'directory') return { status: 400, error: '工作区不是目录：' + root }
	} catch (error) {
		return { status: 400, error: '读不到这个工作区：' + messageOf(error) }
	}
	const known = await knownWorkspacesOf(ctx, configured)
	if (known === null) {
		return { warning: '本次没能枚举到已知工作区（宿主没有工作区注册表/Agent 清单）：写侧边界只做了形态校验。' }
	}
	if (known.has(await canonicalPathOf(ctx, root))) return null
	// 请求侧也带一次真实路径形态（与上游 `remember` 收的形态对齐：链接 ↔ 真身互为别名）。
	try {
		const real = realpathSync(root)
		if (typeof real === 'string' && real !== '' && known.has(real)) return null
	} catch (error) {
		// 取不到真实路径（不存在等）：后面的形态判定已经覆盖，这里不额外放行。
	}
	const list = [...known].join('、')
	return {
		status: 403,
		error:
			`写回执只允许落在**已知工作区**里：这次请求指向 ${root}，当前已知的工作区是 ${list === '' ? '（一个都没有）' : list}。` +
			`视图栏是按会话渲染的，它会把当前会话的工作目录带上来${source === 'request' ? '' : '（本次是回落的，不是请求带的）'}；` +
			`这个参数若被外部进程伪造，写盘面就跟着请求走 —— 所以这里拒掉。`,
	}
}

/**
 * 端点的公共开头（**这一处正文，十来个端点共用**）。
 *
 * 从前每个端点各写一遍这八到十行：请求里的 workspace → 配置值 → 四级回落 → 定不下来就 503。
 * 各写一遍的代价是"改口径要改十来处"（写侧边界那一轮就是如此），于是收成这一处。
 *
 * @param ctx - 宿主 ctx。
 * @param req - 请求（读 `?workspace=`）。
 * @param res - 响应：定不下来时**已经写好回执**。
 * @param fallback - composition 行 `config.workspace`。
 * @param options.writable - true = 连写侧边界一起过（不通过时已回执）；缺省只做读侧那几步。
 * @param options.missing - 定不下来时的 503 文案；缺省用通用的 `noWorkspaceMessage`。
 * @returns `{ root, source, resolved }`；`null` 表示"已经回过执，调用方直接 return"。
 */
async function openWorkspaceOf(ctx, req, res, fallback, options = {}) {
	const requested = requestedWorkspace(req.url)
	if (requested.kind === 'bad') {
		writeJson(res, 400, { ok: false, error: requested.error })
		return null
	}
	const resolved = requested.kind === 'ok' ? { root: requested.value, source: 'request', candidates: 1 } : await fallbackWorkspaceOf(ctx, fallback)
	const root = resolved.root
	if (root === null) {
		writeJson(res, 503, { ok: false, error: options.missing ?? noWorkspaceMessage(resolved.candidates) })
		return null
	}
	if (options.writable === true) {
		const boundary = await writableWorkspaceFinding(ctx, root, fallback, resolved.source)
		if (boundary !== null && boundary.error !== undefined) {
			writeJson(res, boundary.status, { ok: false, error: boundary.error })
			return null
		}
	}
	return { root, source: resolved.source, resolved }
}

/**
 * 容错版的开头：**工作区定不下来也继续**（技能 / 角色那几处如此 —— 那时按宿主进程目录解析，
 * 并在 `warnings` 里如实说明"这可能不是你会话里的那一份"）。定不下来是事实，不是错误。
 * @returns `{ resolved, root, warnings }`；请求形态不合法时 `null`（已回执 400）。
 */
async function openWorkspaceSoftly(ctx, req, res, fallback) {
	const requested = requestedWorkspace(req.url)
	if (requested.kind === 'bad') {
		writeJson(res, 400, { ok: false, error: requested.error })
		return null
	}
	const resolved = requested.kind === 'ok' ? { root: requested.value, source: 'request', candidates: 1 } : await fallbackWorkspaceOf(ctx, fallback)
	return { resolved, root: resolved.root, warnings: workspaceSourceWarnings(resolved) }
}

/** 从请求 URL 判定要读哪份文件；未知子路径返回 null。 */
export function ledgerKeyOf(url) {
	const path = typeof url === 'string' ? url.split('?')[0].split('#')[0] : ''
	let rest = path
	if (rest.startsWith(cfg.ROUTE_PATH)) rest = rest.slice(cfg.ROUTE_PATH.length)
	rest = rest.replace(/^\/+/, '').replace(/\/+$/, '')
	if (rest === '' || rest === 'board') return 'board'
	const keys = Object.keys(cfg.LEDGERS)
	for (let i = 0; i < keys.length; i++) {
		if (cfg.LEDGERS[keys[i]].subpath !== '' && cfg.LEDGERS[keys[i]].subpath === rest) return keys[i]
	}
	return null
}

/**
 * 判定请求是否来自 loopback 同源页面。
 * 与 dsh-better-sidebar / dsh-dream-skin 同款信任栅栏：Host 头必须是 loopback
 * 地址，`Sec-Fetch-Site` 不得是 cross-site，若带 Origin 则必须与 Host 一致。
 * @param req - Node 的 IncomingMessage。
 * @returns 可信时为 true。
 */
function isLoopbackSameOrigin(req) {
	if (req === null || req === undefined || req.headers === null || req.headers === undefined) return false
	const host = typeof req.headers.host === 'string' ? req.headers.host : undefined
	if (host === undefined || host.length === 0) return false
	let hostname = host
	const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host)
	if (bracketed !== null) {
		hostname = bracketed[1]
	} else {
		const firstColon = host.indexOf(':')
		if (firstColon !== -1 && firstColon === host.lastIndexOf(':')) hostname = host.slice(0, firstColon)
	}
	const lowered = hostname.toLowerCase()
	if (lowered !== '127.0.0.1' && lowered !== 'localhost' && lowered !== '::1') return false
	if (req.headers['sec-fetch-site'] === 'cross-site') return false
	const origin = req.headers.origin
	if (origin === undefined) return true
	try {
		return new URL(origin).host === host
	} catch {
		return false
	}
}

/**
 * 读一份文件的**原始条目数组**（不整形，只判"读得到 / 读不到"）。
 *
 * 为什么另开一条读法：状态口径要的是原始字段（`status` / `blockedBy` / `decisions`），
 * 而 `readLedger` 的整形载荷按界面约定只留标量叶子、**不含 `blockedBy` 与 `decisions`**
 * （卡住与"当前状态取 decisions 尾项"都读不到）。把原始数组并进 `readLedger` 的返回值，
 * 会顺带把它泄漏进页面载荷 —— 所以这里单独读、单独用。
 * @param spec - `{ file, collection }` —— 传 spec 而不是 key，调用方自己决定读哪一份。
 * @returns `{ ok: true, items }`；`items === undefined` 表示**这份文件读不到**（文件不在）。
 *          读不成（不是常规文件 / JSON 坏 / 缺集合）返回 `{ ok: false, error }`。
 */
async function readRawItems(fs, workspace, spec) {
	const absPath = join(workspace, spec.file)
	try {
		const target = await fs.resolve(absPath)
		const info = await fs.stat(target)
		if (info === undefined) return { ok: true, items: undefined }
		if (info.type !== 'file') return { ok: false, error: '文件不是常规文件：' + absPath }
		const text = await fs.readText(target)
		let parsed = null
		try {
			parsed = JSON.parse(text)
		} catch (parseError) {
			return { ok: false, error: '文件 JSON 解析失败：' + messageOf(parseError) }
		}
		if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed[spec.collection])) {
			return { ok: false, error: `文件缺少 ${spec.collection} 数组：` + absPath }
		}
		// `removed` 是同一份文件里的第二个数组（删除留痕）：成员块的「默认队友状态」要用它 ——
		// 没这一格就读不出"这个名字被删过"（会把它算成"没叫过"，那是另一回事）。
		return { ok: true, items: parsed[spec.collection], ...(Array.isArray(parsed.removed) ? { removed: parsed.removed } : {}) }
	} catch (error) {
		return { ok: false, error: '读取文件失败：' + messageOf(error) }
	}
}

/**
 * 读取并整形一份文件。
 *
 * 导出是给面板自检用的：自检要拿同一份文件走与端点完全相同的那条读取与整形路径，
 * 而不是去读实现里的常量。
 * @param fs - 宿主 `fs` 服务。
 * @param workspace - 文件所在的工作区绝对路径。
 * @param key - 'board'（审批与共识随制度一并撤下后只剩这一份）。
 * @returns 只含标量的载荷，或 `{ ok: false, error }`。
 */
export async function readLedger(fs, workspace, key) {
	const spec = cfg.LEDGERS[key]
	const absPath = join(workspace, spec.file)
	try {
		const target = await fs.resolve(absPath)
		const info = await fs.stat(target)
		// 文件不存在是**正常状态**（还没人建过文件的工作区），不是读失败：如实回一份空文件，
		// 由前端显示空态。其余情况（不是常规文件、解析失败、读不到）才判失败。
		if (info === undefined) {
			return { ok: true, absent: true, ledger: key, path: absPath, bytes: null, seq: null, writer: null, total: 0, counts: {}, outOfEnum: [], items: [] }
		}
		if (info.type !== 'file') return { ok: false, error: '文件不是常规文件：' + absPath }
		const text = await fs.readText(target)
		let parsed = null
		try {
			parsed = JSON.parse(text)
		} catch (parseError) {
			return { ok: false, error: '文件 JSON 解析失败：' + messageOf(parseError) }
		}
		if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed[spec.collection])) {
			return { ok: false, error: `文件缺少 ${spec.collection} 数组：` + absPath }
		}
		const shaper = SHAPERS[key]
		const items = []
		const rawItems = parsed[spec.collection]
		for (let i = 0; i < rawItems.length; i++) {
			const shaped = shaper(rawItems[i])
			if (shaped !== null) items.push(shaped)
		}
		// 写盘面重叠是**提示**（引擎口径：只告警、绝不拦），逐条挂在它自己那张卡上：
		// 判定在 `writeScopeWarningsOf` 一处，宿主不另算 —— 与 `dueText`、`linkedText` 同一条纪律。
		if (key === 'board') {
			for (const item of items) {
				if (item === null || typeof item.id !== 'string') continue
				item.writeScopeWarnings = writeScopeWarningsOf(rawItems, item.id)
			}
		}
		const counts = {}
		const outOfEnum = []
		for (let i = 0; i < items.length; i++) {
			const item = items[i]
			const statusKey = item.status === null ? '(无状态)' : item.status
			counts[statusKey] = (counts[statusKey] || 0) + 1
			if (key !== 'board') continue
			if (BOARD_STATUSES.indexOf(statusKey) === -1) outOfEnum.push(item.id)
			else if (item.priority !== null && BOARD_PRIORITIES.indexOf(item.priority) === -1) outOfEnum.push(item.id)
		}
		const envelope = shapeEnvelope(parsed)
		return {
			ok: true,
			ledger: key,
			path: typeof target.displayPath === 'string' ? target.displayPath : absPath,
			bytes: typeof info.size === 'number' ? info.size : null,
			seq: envelope.seq,
			writer: envelope.writer,
			total: items.length,
			counts,
			outOfEnum,
			items,
		}
	} catch (error) {
		return { ok: false, error: messageOf(error) }
	}
}
