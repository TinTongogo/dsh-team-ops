/**
 * 状态 / 里程碑 / 团队服务开关三个只读-轻量写端点，以及 `/status` 的状态源判定。
 *
 * 业务判定在 `lib/milestones.js` 与 `lib/board-status.js`，宿主注入
 * 工作区解析、遗留账读取与几条端点常量；与其余端点族同一装配形状。
 */
import { join } from 'node:path'
import { bodyError, DECIDE_BODY_LIMIT, messageOf, queryValue, readBody, writeJson } from './http-tools.js'
import { asScalar, asScalarArray, shapeEnvelope, shapeRecordArray, SHAPERS } from './panel-shaping.js'
import { parseMilestones } from './milestones.js'
import { writeScopeWarningsOf } from '../team/company-gate.js'
import { BOARD_DONE_STATUS, BOARD_STATUSES, STATUS_LINE_ORDER, isBoardStatus } from './board-status.js'
import { teamCredentialOf, requestedSession } from './team-routes.js'

/**
 * @param deps - `{ openWorkspaceOf, openWorkspaceSoftly, workspaceSourceWarnings, requestedWorkspace,
 *                 TEAM_SERVICE_BODY_LIMIT, TEAM_SERVICE_MISSING, TEAM_TASKS_UNSUPPORTED,
 *                 MILESTONE_FILE }`（`readRawItems` / `LEDGERS` 已不再用到：`/status` 只读原生账）。
 */
export function createStatusRoutes(deps) {
	/**
	 * 智能体团队开关：**查状态 / 开 / 关**（与根会话「模型与推理等级菜单 → 使用智能体团队」同一个开关）。
	 *
	 * 为什么改这里：DSH 新版本把 `@deepseek-ai/dsh-experimental-agent-team-profile` 列入退役清单，
	 * 团队能力改由 base / Web bundle 提供，profile 级的 bundle 开关没有了；开关变成**按 Session 保存**的
	 * `team/mode` 选择，宿主服务暴露 `agentTeams.isEnabled(caller)` 与 `agentTeams.setEnabled(agent, enabled)`。
	 * 于是面板这一枚按钮改成调**同一对方法** —— 不再是"改 profile 的能力层"，也不再需要 `pluginManager`。
	 *
	 * 约束：`setEnabled` 只认**活着的 root Session**（descendant 调用抛 `TEAM_LEAD_REQUIRED`），
	 * 所以凭据按请求里的 `?session=` 取（面板已把会话折到根）；只接受 `enable` / `disable` 两个动作；
	 * `GET` 只查不动；服务本身不在时**不冒充**能开（返回原因，让人去查 profile）。
	 * @param ctx - 宿主 ctx（`agentTeams` / `agents` 都是可选服务）。
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
		const teams = typeof ctx.get === 'function' ? ctx.get('agentTeams') : undefined
		const serviceOn = teams !== undefined && teams !== null
		// 开关只认活着的 root Session：面板那边的 `?session=` 已经折到根，这里不再自己猜。
		const credential = teamCredentialOf(ctx, requestedSession(req.url), '智能体团队开关')
		const enabledNow = () => {
			if (!serviceOn || typeof teams.isEnabled !== 'function' || !credential.ok) return null
			try {
				return teams.isEnabled(credential.lead) === true
			} catch {
				return null
			}
		}
		const stateOf = () => ({
			ok: true,
			service: serviceOn,
			enabled: enabledNow(),
			reason: credential.ok ? null : credential.reason,
			warnings: [],
		})
		if (method === 'GET') {
			writeJson(res, 200, stateOf())
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
		if (!serviceOn) {
			// 服务本身不在：这个按钮变不出服务，只能把原因说清（让人去查 profile 的 base 层）。
			writeJson(res, 200, { ok: false, service: false, enabled: null, error: 'TEAM_SERVICE_MISSING', warnings: [deps.TEAM_SERVICE_MISSING] })
			return
		}
		if (typeof teams.setEnabled !== 'function') {
			writeJson(res, 200, {
				ok: false,
				service: true,
				enabled: enabledNow(),
				error: 'TEAM_MODE_UNSUPPORTED',
				warnings: ['这个部署的 Agent Teams 服务没有 `setEnabled`：面板开不了这个开关，请用根会话的「模型与推理等级菜单 → 使用智能体团队」。'],
			})
			return
		}
		if (!credential.ok) {
			writeJson(res, 200, { ok: false, service: true, enabled: null, error: 'TEAM_SESSION_UNKNOWN', warnings: [credential.reason] })
			return
		}
		try {
			await teams.setEnabled(credential.lead, action === 'enable')
			writeJson(res, 200, { ...stateOf(), changed: true })
		} catch (error) {
			const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
			const hint =
				code === 'TEAM_LEAD_REQUIRED'
					? '只能在根会话上切这个开关：面板要带根会话的 `?session=`。'
					: code === 'TEAM_NOT_ENABLED' || code === 'TEAM_NOT_MEMBER'
						? '这个部署的团队服务没有接受这次切换，请到根会话的「模型与推理等级菜单 → 使用智能体团队」操作。'
						: ''
			writeJson(res, 200, {
				ok: false,
				service: true,
				enabled: enabledNow(),
				error: code !== '' ? code : messageOf(error),
				warnings: hint === '' ? [] : [hint],
			})
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
	 * 任务板已迁到 DSH 原生 Agent Teams：本端点**只读原生那一本账**，不再回落到已废弃的
	 * `.ops/board.json`（那份文件不再承载实时状态，读它只会让人看到一份旧数）。
	 * 原生任务板要一个**活着的会话凭据**（`agents.get(sessionId)`）：拿不到就如实说读不到，
	 * 不拿旧文件冒充。
	 * @param ctx - 宿主 ctx。
	 * @param url - 请求 URL（会话 id 从它的查询串里来）。
	 * @returns `{ kind: 'native'|'unavailable', rows, reason }`。
	 */
	function statusSourceOf(ctx, url) {
		const credential = teamCredentialOf(ctx, requestedSession(url), '看板状态')
		if (!credential.ok) return { kind: 'unavailable', rows: [], reason: credential.reason }
		if (typeof credential.teams.listTasks !== 'function') return { kind: 'unavailable', rows: [], reason: deps.TEAM_TASKS_UNSUPPORTED }
		try {
			const rows = credential.teams.listTasks(credential.lead)
			return { kind: 'native', rows: Array.isArray(rows) ? rows : [], reason: null }
		} catch (error) {
			return { kind: 'unavailable', rows: [], reason: `原生任务板读取失败：${messageOf(error)}` }
		}
	}

	/** 「本端点现在读的是哪一种」那一句话（两档写死在这里；端点与自检都读它）。 */
	function statusSourceLine(kind, reason) {
		if (kind === 'native') {
			return '本会话的看板读的是 **DSH 原生 Agent Teams 任务板**（实时；计数按原生三档词给，与 team_status 同源）。'
		}
		return '读不到本会话的看板：原生的任务板要一个**活着的会话**。'
	}

	/**
	 * 状态端点：**只读本会话原生任务板**（`.ops/board.json` 那条回落已删）。
	 *
	 * 两条口径：
	 *   · 原生可用 ⇒ `counts` / `markdown` 按**原生三档词**（`pending` / `in_progress` / `completed`）
	 *     给，与 `team_status` 同源；**不做**"原生状态 → 本插件五栏"的映射（那是发明两套制度的对应）；
	 *   · 原生不可用 ⇒ `counts` / `markdown` 给 `null` / 空串，`source` 为 `unavailable`，
	 *     `sourceLine` 只说"读不到、凭什么读不到"—— **不读旧文件、不拿旧数冒充**。
	 * 工作区不存在 / 不是目录分开报，理由同其余端点。
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
			// 原生那一档：计数**照原生状态词**数（与 `team_status` 同一份口径），不映射进我们那五栏。
			const nativeCounts = { pending: 0, in_progress: 0, completed: 0 }
			for (const row of source.rows) {
				const status = row !== null && typeof row === 'object' ? row.status : undefined
				if (typeof status === 'string' && Object.hasOwn(nativeCounts, status)) nativeCounts[status] += 1
			}
			const available = source.kind === 'native'
			const counts = available ? nativeCounts : null
			const markdown = available ? `待办 ${nativeCounts.pending} · 进行中 ${nativeCounts.in_progress} · 已完成 ${nativeCounts.completed}` : ''
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
				// 读的是哪一本账：`native` 或 `unavailable`（不再有 legacy 这一档）。
				source: source.kind,
				sourceLine,
				native: available
					? { available: true, counts: nativeCounts, total: source.rows.length }
					: { available: false, counts: null, total: null, reason: source.reason },
				counts,
				markdown,
				unfinished: [],
			})
		} catch (error) {
			console.error('[dsh-team-ops] 状态 API 异常:', error)
			writeJson(res, 500, { ok: false, error: '内部错误' })
		}
	}

	return { handleTeamService, handleMilestones, handleStatus }
}
