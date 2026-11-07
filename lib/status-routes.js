/**
 * 状态 / 里程碑 / 团队服务开关三个只读-轻量写端点，以及 `/status` 的状态源判定。
 *
 * 业务判定在 `team/company-gate.js`（`statusSnapshot`）与 `lib/milestones.js`，宿主注入
 * 工作区解析、遗留账读取与几条端点常量；与其余端点族同一装配形状。
 */
import { join } from 'node:path'
import { bodyError, DECIDE_BODY_LIMIT, messageOf, queryValue, readBody, writeJson } from './http-tools.js'
import { asScalarArray, shapeEnvelope, shapeRecordArray, SHAPERS } from './panel-shaping.js'
import { parseMilestones } from './milestones.js'
import { statusSnapshot, writeScopeWarningsOf } from '../team/company-gate.js'
import { BOARD_DONE_STATUS, BOARD_STATUSES, STATUS_LINE_ORDER, isBoardStatus } from './board-status.js'
import { teamCredentialOf, requestedSession } from './team-routes.js'

/**
 * @param deps - `{ openWorkspaceOf, openWorkspaceSoftly, workspaceSourceWarnings, readRawItems,
 *                 readLedger, requestedWorkspace, LEDGERS, TEAM_PROFILE_BUNDLE,
 *                 TEAM_SERVICE_BODY_LIMIT, TEAM_SERVICE_MISSING, TEAM_TASKS_UNSUPPORTED,
 *                 MILESTONE_FILE }`。
 */
export function createStatusRoutes(deps) {
	/**
	 * 团队服务那一层：**查状态 / 开 / 关**。
	 *
	 * 为什么要有这个端点（人的原话："插件依赖 DSH 团队服务，装上插件不能自动打开团队服务吗？"）：
	 *   · DSH 把团队能力做成了**可选 bundle**（`OPTIONAL_BUNDLES` 里那一个），开关是
	 *     `pluginManager.setBundleEnabled(name, enabled)` —— GUI 里那个开关调的就是它；
	 *   · 所以"能不能自动打开"的答案是**能**。但**不静默开**：那是用户 profile 的能力层，
	 *     插件在背后改配置、用户不知道是谁改的，比"没开"更糟。做法是**显式的动作**（面板上一个按钮），
	 *     调的是同一个方法，结果原样回显（DSH 说"启用了"就是启用了，说警告就照印警告）。
	 *
	 * 约束：包名是**常量**（不接受调用方给包名 —— 否则这个端点就成了"任意包开关"）；
	 * 只接受 `enable` / `disable` 两个动作；`GET` 只查不动。
	 * @param ctx - 宿主 ctx（要 `pluginManager` 服务）。
	 * @param req - 请求（GET 查状态 / POST 开关）。
	 * @param res - 响应。
	 * @returns {Promise<void>}
	 */
	async function handleTeamService(ctx, req, res) {
		const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
		if (method !== 'GET' && method !== 'POST') {
			writeJson(res, 405, { ok: false, error: '只接受 GET（查状态）与 POST（开 / 关）' })
			return
		}
		const manager = typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined
		if (manager === undefined || manager === null) {
			// 没有这个服务：说清"为什么那个按钮也点不了"，并且**不冒充**能做到。
			writeJson(res, 200, {
				ok: true,
				manager: false,
				service: typeof ctx.get === 'function' && ctx.get('agentTeams') !== undefined,
				bundle: null,
				warnings: ['这个部署没有 `pluginManager` 服务（它只在带 profile 的安装里装载）：请到 DSH 的插件 / 能力设置里开 `' + deps.TEAM_PROFILE_BUNDLE + '`。'],
			})
			return
		}
		const readBundle = async () => {
			const rows = await manager.listBundles()
			const found = Array.isArray(rows) ? rows.find((row) => row !== null && typeof row === 'object' && row.name === deps.TEAM_PROFILE_BUNDLE) : undefined
			return found === undefined
				? null
				: {
						name: deps.TEAM_PROFILE_BUNDLE,
						installed: found.installed === true,
						enabled: found.enabled === true,
						version: typeof found.version === 'string' ? found.version : '',
					}
		}
		const serviceOn = () => typeof ctx.get === 'function' && ctx.get('agentTeams') !== undefined
		try {
			const before = await readBundle()
			if (method === 'GET') {
				writeJson(res, 200, { ok: true, manager: true, service: serviceOn(), bundle: before, warnings: [] })
				return
			}
			// POST：body 里那个动作必须是这两个之一（别的值一律拒，别把开关语义交给调用方猜）。
			let body
			try {
				body = JSON.parse(await readBody(req, deps.TEAM_SERVICE_BODY_LIMIT))
			} catch (error) {
				writeJson(res, 400, { ok: false, error: '请求体不合法：' + messageOf(error) })
				return
			}
			const action = body !== null && typeof body === 'object' ? body.action : undefined
			if (action !== 'enable' && action !== 'disable') {
				writeJson(res, 400, { ok: false, error: 'action 只接受 `enable` 或 `disable`' })
				return
			}
			// **不拿"清单里有没有那一行"当前提**：关掉这一层就是**把名字从 `dsh.profile.bundles` 里删掉**，
			// 于是它当然不在 `listBundles()` 里（而包本身随 DSH 安装发布 —— `resolveBundleDir` 先从
			// 安装锚点解析，所以**不需要装**）。所以直接调，把 DSH 的结论原样回显：
			// 它拒绝（not-bundle / 版本不兼容 / 这一层管着管理器本身）就把那条原因照印，别自己先判。
			const result = await manager.setBundleEnabled(deps.TEAM_PROFILE_BUNDLE, action === 'enable')
			const after = await readBundle()
			writeJson(res, 200, {
				ok: true,
				manager: true,
				service: serviceOn(),
				bundle: after,
				changed: result === null || result === undefined ? null : result.changed === true,
				application: result !== null && typeof result === 'object' && typeof result.application === 'string' ? result.application : null,
				warnings: result !== null && typeof result === 'object' && Array.isArray(result.warnings) ? result.warnings.map((line) => asScalar(line)) : [],
			})
		} catch (error) {
			const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
			if (code === 'not-bundle' || code === 'incompatible-version' || code === 'management-required') {
				// 这三条是 DSH 自己会说的"为什么开不了"：照印它的码 + 一句人话，另给出真有救的那一步。
				const hint =
					code === 'not-bundle'
						? 'DSH 安装里没有这个包（这不正常）：跑 `dsh plugin add ' + deps.TEAM_PROFILE_BUNDLE + '`。'
						: code === 'management-required'
							? '这一层管着插件管理器本身，不能在运行中关它。'
							: '版本不兼容：DSH 的插件设置里可以给这个版本加豁免。'
				writeJson(res, 200, { ok: false, manager: true, service: serviceOn(), bundle: null, error: code, warnings: [hint] })
				return
			}
			writeJson(res, 503, { ok: false, manager: true, error: messageOf(error) })
		}
	}

	/**
	 * 里程碑清单（**只读**）：把工作区里那份 `docs/team/里程碑.md` 读成 `phase` 的取值域。
	 *
	 * 三条口径：
	 *   · **文件不在是正常状态**（新工作区本来就没有）：回 `exists: false` + 一行说明，
	 *     **不是 404、也不是"零个里程碑"** —— 那份清单按需建立；
	 *   · **解析只在 `lib/milestones.js` 一处**（`parseMilestones`）：宿主只负责读文本；
	 *   · 读不出任何一行时如实说"没认出表形"（半行都不臆造）——EPIC 那一档据此只印代号与板上读数。
	 * @param ctx - 宿主 ctx（用 `ctx.fs`读文件）。
	 * @param req - 请求（GET）。
	 * @param res - 响应。
	 * @param fallback - composition 行配的 workspace。
	 */
	async function handleMilestones(ctx, req, res, fallback) {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			writeJson(res, 405, { ok: false, error: '里程碑清单只支持 GET（本栏只读）' })
			return
		}
		const opened = await deps.openWorkspaceOf(ctx, req, res, fallback)
		if (opened === null) return
		const root = opened.root
		const resolved = opened.resolved
		const absPath = join(root, deps.MILESTONE_FILE)
		const warnings = []
		try {
			const info = await ctx.fs.stat(await ctx.fs.resolve(absPath))
			if (info === undefined) {
				writeJson(res, 200, {
					ok: true,
					workspace: root,
					workspaceSource: resolved.source,
					path: absPath,
					exists: false,
					rows: [],
					warnings: [`里程碑清单还没建立（${absPath}）—— 这份清单是 \`phase\` 的取值域与出口准则的唯一落点，按需建立：EPIC 那一档现在只印代号与板上的读数。`, ...deps.workspaceSourceWarnings(resolved)],
				})
				return
			}
			if (info.type !== 'file') {
				writeJson(res, 503, { ok: false, error: '里程碑清单不是常规文件：' + absPath })
				return
			}
			const rows = parseMilestones(await ctx.fs.readText(await ctx.fs.resolve(absPath)))
			if (rows.length === 0) warnings.push(`里程碑清单里没认出任何一行表格（${absPath}）—— 表的形状变了？EPIC 那一档现在只印代号与板上读数，**不臆造阶段名**。`)
			writeJson(res, 200, { ok: true, workspace: root, workspaceSource: resolved.source, path: absPath, exists: true, rows, warnings: [...warnings, ...deps.workspaceSourceWarnings(resolved)] })
		} catch (error) {
			writeJson(res, 503, { ok: false, error: '里程碑清单读不成：' + messageOf(error) })
		}
	}

	/**
	 * `/status` 的**数据来源判定**（一处正文）。
	 *
	 * 为什么要判：本插件的文件看板（`.ops/board.json`）在任务板迁到 DSH 原生 Agent Teams
	 * 之后**不再承载实时状态**（可能已停止更新），而这一端点过去照读它，于是同一时刻两本账方向相反
	 * （文件说"全干完了"，原生说"还有待办"）。做法是**按现场能力取数**：能拿到本会话活着的 Lead
	 * 就读原生那一本账，拿不到才回落到遗留文件 —— 并且把**是哪一种**写进载荷（`source` / `sourceLine`）。
	 *
	 * 回落不是"读不到就没有任务"：原生的任务板要一个**活着的会话凭据**（`agents.get(sessionId)`），
	 * 请求里没带会话 id、或那个会话现在没在跑，就拿不到 —— 这时回落，但要说清凭什么回落。
	 * @param ctx - 宿主 ctx。
	 * @param url - 请求 URL（会话 id 从它的查询串里来）。
	 * @returns `{ kind: 'native'|'legacy', rows, reason }`（`legacy` 时 `reason` = 凭什么回落）。
	 */
	function statusSourceOf(ctx, url) {
		const credential = teamCredentialOf(ctx, requestedSession(url), '看板状态')
		if (!credential.ok) return { kind: 'legacy', rows: [], reason: credential.reason }
		if (typeof credential.teams.listTasks !== 'function') return { kind: 'legacy', rows: [], reason: deps.TEAM_TASKS_UNSUPPORTED }
		try {
			const rows = credential.teams.listTasks(credential.lead)
			return { kind: 'native', rows: Array.isArray(rows) ? rows : [], reason: null }
		} catch (error) {
			return { kind: 'legacy', rows: [], reason: `原生任务板读取失败：${messageOf(error)}` }
		}
	}

	/** 「本端点现在读的是哪一种」那一句话（两档写死在这里；端点与自检都读它）。 */
	function statusSourceLine(kind, reason) {
		if (kind === 'native') {
			return '本会话的看板读的是 **DSH 原生 Agent Teams 任务板**（实时；计数按原生三档词给，与 team_status 同源）—— 本插件的文件看板已不再承载实时状态。'
		}
		return `本端点的计数读的是**本插件的文件看板**（${deps.LEDGERS.board.file}）：它**不再承载实时状态**（任务板已迁到 DSH 原生 Agent Teams，这份文件可能已停止更新），所以下面这几个数可能是旧的 —— 实时读数用 team_status。没能读原生那一本账的原因（服务方原文）：${reason}`
	}

	/**
	 * 状态端点：**优先**按本会话原生任务板给出计数，回落时才读遗留文件，并标明是哪一种。
	 *
	 * 三条口径：
	 *   · 原生可用 ⇒ `counts` / `markdown` 按**原生三档词**（`pending` / `in_progress` / `completed`）
	 *     给，与 `team_status` 同源；**不做**"原生状态 → 本插件五栏"的映射（那是发明两套制度的对应）；
	 *   · 原生不可用 ⇒ 照旧把文件条目交给引擎的 `statusSnapshot`，但载荷带 `source: 'legacy'` 与
	 *     那一句来源说明 —— 读的人自己就能判断这份数是不是旧的；
	 *   · 两种情形都给 `native` 那一格：可用时 `{ available: true, total, counts }`，不可用时带原因。
	 * 工作区不存在 / 不是目录与"文件还没建"分开报，理由同其余端点。
	 * 导出是给自检用的（与 `handleTeamTasks` / `handleMembers` 同一理由）。
	 */
	async function handleStatus(ctx, req, res, fallback) {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			writeJson(res, 405, { ok: false, error: '状态只支持 GET' })
			return
		}
		const opened = await deps.openWorkspaceOf(ctx, req, res, fallback)
		if (opened === null) return
		const root = opened.root
		const resolved = opened.resolved
		try {
			const rootTarget = await ctx.fs.resolve(root)
			const rootInfo = await ctx.fs.stat(rootTarget)
			if (rootInfo === undefined) {
				writeJson(res, 404, { ok: false, error: '工作区不存在：' + root })
				return
			}
			if (rootInfo.type !== 'directory') {
				writeJson(res, 400, { ok: false, error: '工作区不是目录：' + root })
				return
			}
			const source = statusSourceOf(ctx, req.url)
			const board = await deps.readRawItems(ctx.fs, root, deps.LEDGERS.board)
			if (!board.ok) {
				writeJson(res, 503, board)
				return
			}
			// 原生那一档：计数**照原生状态词**数（与 `team_status` 同一份口径），不映射进我们那五栏。
			const nativeCounts = { pending: 0, in_progress: 0, completed: 0 }
			for (const row of source.rows) {
				const status = row !== null && typeof row === 'object' ? row.status : undefined
				if (typeof status === 'string' && Object.hasOwn(nativeCounts, status)) nativeCounts[status] += 1
			}
			let counts = nativeCounts
			let markdown = `待办 ${nativeCounts.pending} · 进行中 ${nativeCounts.in_progress} · 已完成 ${nativeCounts.completed}`
			// 「复制产物路径」这个动作要有东西可复制：给未完成条目的 `{编号, 产物}`（只收非空字符串）。
			// **原生那一档这份清单是空的**：原生的任务行里没有"产物"这个字段（它是本插件文件看板的列）
			// —— 空不等于"没有产物"，`sourceLine` 里说明了这份数读的是哪一本账。
			let unfinished = []
			if (source.kind === 'legacy') {
				const snapshot = statusSnapshot({ tasks: board.items, now: new Date().toISOString() })
				counts = snapshot.counts
				markdown = snapshot.markdown
				for (const task of Array.isArray(board.items) ? board.items : []) {
					if (task === null || typeof task !== 'object') continue
					if (task.status === BOARD_DONE_STATUS) continue
					const artifact = typeof task.artifact === 'string' && task.artifact.trim() !== '' ? task.artifact.trim() : null
					if (artifact === null) continue
					unfinished.push({ id: asScalar(task.id), artifact })
				}
			}
			const sourceLine = statusSourceLine(source.kind, source.reason)
			// 「项目路径」这个控件要能点开本地目录：给出工作区根与 `docs`（有就给 docs，没有就给根）。
			// 只 stat 一次，判的是"存在且是目录"，不列目录、不读内容。
			let docsPath = null
			try {
				const docsInfo = await ctx.fs.stat(await ctx.fs.resolve(join(root, 'docs')))
				if (docsInfo !== undefined && docsInfo.type === 'directory') docsPath = join(root, 'docs')
			} catch {
				docsPath = null
			}
			writeJson(res, 200, {
				ok: true,
				workspace: root,
				workspaceSource: resolved.source,
				warnings: [sourceLine, ...deps.workspaceSourceWarnings(resolved)],
				docsPath,
				// 看板读不到才算「这份遗留文件还没有」（其余端点同口径）；它不决定上面那几个数用哪一档。
				absent: board.items === undefined,
				// 「现在读的是哪一种」——这两个字段就是这一条判定的正文，面板与人都照它读。
				source: source.kind,
				sourceLine,
				native:
					source.kind === 'native'
						? { available: true, counts: nativeCounts, total: source.rows.length }
						: { available: false, counts: null, total: null, reason: source.reason },
				counts,
				markdown,
				unfinished,
			})
		} catch (error) {
			console.error('[dsh-team-ops] 状态 API 异常:', error)
			writeJson(res, 500, { ok: false, error: '内部错误' })
		}
	}

	return { handleTeamService, handleMilestones, handleStatus }
}
