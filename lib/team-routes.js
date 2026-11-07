/**
 * 团队视图层：`/members` 与 `/team-tasks` 两个只读端点，以及它们共用的一整组辅助。
 *
 * 这一整块原先平铺在 `board-view.host.js` 里，被 `handleStatus` / `handleTeamService` 交叉引用。
 * 现在共享辅助（`teamCredentialOf` / `requestedSession` / `runtimeReadings` / `skillNamesNow` /
 * `teamRosterOf` / `mergeRoster` / 成员与任务行整形、运行时词表）在这里只有一份正文；
 * 宿主通过 `createTeamRoutes()` 注入工作区解析、文件读取与两条团队文案常量。
 */
import { join } from 'node:path'
import { messageOf, queryValue, writeJson } from './http-tools.js'
import { asScalar, asScalarArray, shapeMemberArray, MEMBER_ROWS_LIMIT } from './panel-shaping.js'
import { MEMBER_FLAGS_FILE, MEMBER_FLAGS_NOTE, disableFindings, readDisabledNames } from './member-flags.js'
import { structuredExists } from './checkpoint.js'
import { MEMBER_PRESENT_MAX } from './team-limits.js'
import { skillScopeOf, skillViewOptions } from './skill-scope.js'
import { runtimeBridge as GATE_BRIDGE, writeScopeWarningsOf } from '../team/company-gate.js'
import { BOARD_DONE_STATUS, BOARD_STATUSES, STATUS_LINE_ORDER } from './board-status.js'
import {
	DEFAULT_ROSTER_EXCLUDED,
	ROLE_ORIGIN_FACET_LABEL,
	avatarOf,
	avatarToneOf,
	defaultRosterOf,
	defaultRosterView,
	roleRecords,
	rosterLedgerOf,
} from '../team/team-runtime.js'

/** 宿主注入的依赖（模块单例，与 host 单例一致）。 */
let deps = {}

/**
 * @param injected - `{ openWorkspaceOf, requestedWorkspace, workspaceSourceWarnings,
 *                     TEAM_SERVICE_MISSING, TEAM_TASKS_UNSUPPORTED }`。
 * @returns 端点与共享辅助的引用。
 */
export function createTeamRoutes(injected) {
	deps = injected
	return { handleMembers, handleTeamTasks, teamCredentialOf, requestedSession, shapeTeamRow }
}

/**
 * 成员端点：按原生名册与工作区的停用/角色标记组装成员栏载荷；读不到就如实回 503，不降级成空名册。
 * 导出给面板自检：不经 HTTP 也能走同一条读取与判定路径。
 */
export async function handleMembers(ctx, req, res, fallback) {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		writeJson(res, 405, { ok: false, error: '成员名册只支持 GET' })
		return
	}
	const opened = await deps.openWorkspaceOf(ctx, req, res, fallback)
	if (opened === null) return
	const root = opened.root
	const resolved = opened.resolved
	try {
		// 工作区不存在 / 不是目录与"名册还没建"分开报，理由同其余端点：前者是调用方给了错路径，
		// 后者是正常状态（还没加过人）—— 混在一起会把配错的工作区显示成"未建立"而没人发现。
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
		// **两份遗留文件都不读**（人的决定）：`.ops/members.json` 早没人写；`.ops/board.json` 这一块
		// 本来也只是"读了不用"（只拿 `ok` 决定要不要打一句告警）—— 那一格既不进载荷也不改判据，
		// 于是每次打开面板都白白多读一次盘。真正的「已交付」由 `data.team`（原生名册）× 原生任务算，
		// 看板读数只在 `/status` 的回落分支里用得到。
		// **成员这一块的主表现在只有一个来源**：本会话的原生 Agent Teams 名册（与 `member_list` 同一处正文）。
		// 旧名册文件（`.ops/members.json`）**不再参与**：不读它、不 join 它、不画它的历史编制行。
		const team = teamRosterOf(ctx, requestedSession(req.url))
		// 实时读数叠加（**盘是事实、内存只补活动**，与内置活动面板同一条纪律）：
		//   · `runtime`：活着的 Agent 在跑 ⇒ running，否则按盘上的值；盘上也没有就**不写这个键**
		//     （前端见不到键就一个徽标都不印 —— 读不到不许印成「空闲」）；
				const runtime = await runtimeReadings(ctx, root, team.rows)
		const rows = shapeMemberArray(runtime.rows, MEMBER_ROWS_LIMIT)
		// 下架名单（`.ops/roster.json`）：读失败**不让整个成员端点失败** ——
		// 一份文件读不到不该把"现在有哪些人"一起挡掉；那一栏按"一个都没下架"显示并记一条告警。
		let rosterView = { hidden: [], file: join(root, '.ops', 'roster.json') }
		try {
			rosterView = await rosterLedgerOf(ctx, { workspace: root })
		} catch (error) {
			console.warn('[dsh-team-ops] 读不到角色下架记录，本次「角色」按"一个都没下架"显示：', messageOf(error))
		}
		// **本会话的 Agent 团队名册**（内置 Agent Teams 那一份，与会话工具 `list_agents` 同一处正文）：
		// 名册空不空、本插件起没起过成员，都不影响它 —— 协调者永远在里面。两半边 join 之后
		// 才是这一块真正要画的那张表（`merged`）：团队行在前（含协调者），只有文件的行跟在后面。
		// 名册空不空、本插件起没起过成员，都不影响它 —— 协调者永远在里面。**只有这一份**（没有第二份要 join）。
		const mergedBase = mergeRoster(rows)
		const skillOptions = await skillNamesNow(ctx, requestedSession(req.url), root)
		// **停用名单**（本插件这一层）：读不到就按"一个都没停用"显示（这份名单是**降级安全**的 ——
		// 漏读最坏是多算一个角色槽位，不会放行任何越界动作，见 `lib/member-flags.js`）。
		const disabledNames = readDisabledNames(root)
		const teammateRows = (team.available ? team.rows : []).filter((row) => row?.role === 'teammate')
		// 名字 → 角色那一处约定在薄层（`NL.roleOfName`），角色 id 列表现场枚举（与工具面同一份）。
		const roleIdsNow = roleRecords().map((record) => record.id)
		const roleOfName = (value) => {
			const raw = typeof value === 'string' ? value : ''
			let best = ''
			for (const id of roleIdsNow) {
				const prefix = id + '-'
				if (!raw.startsWith(prefix) || !/^\d+$/.test(raw.slice(prefix.length))) continue
				if (id.length > best.length) best = id
			}
			return best
		}
		const isTeammate = (name) => teammateRows.some((row) => row?.name === name)
		const verbsOf = (row) => {
			const name = typeof row?.name === 'string' ? row.name : ''
			const lead = row?.kind === 'lead'
			const mine = isTeammate(name)
			const off = disabledNames.includes(name)
			const whyNoInterrupt = lead ? '协调者不能打断自己' : mine ? '' : '原生名册里没有这一位（原生起的 agent 不由本插件打断）'
			// 名字 → 角色：**用引擎那一处正文**（`roleOfName`），角色 id 列表现场枚举（`roleRecords`）。
			const finding = !off && mine ? disableFindings({ name, members: teammateRows, disabledNames, roleOfName }) : null
			// **每个 `ok:false` 都带 `why`**（客户端把不能做的也画出来、理由**原样**给用户 —— 藏起来等于让人猜）：
			//   · 不在原生名册里 / 协调者自己、已在停用名单里、引擎那条"至少留 1 位"的判据。
			const whyNotMine = lead ? '协调者不是可停用的队内成员' : '原生名册里没有这一位（原生起的 agent 不由本插件停用）'
			// **「打断」的可用性只看"它现在有没有在跑的那一轮"**（现场：`inactive` 时点了回 `ok:true` +
			// `previousStatus:"inactive"` ⇒ 按钮可点、点了什么也没发生）。四种状态的话**分开说清**，
			// 措辞用面板同一套运行时词表（`running`=跑着 / `inactive`=**无轮次** / `provisioning`=创建中 / `failed`=失败）。
			const runtimeWord = RUNTIME_WORD[row.runtime] ?? '状态读不到'
			const whyInterrupt =
				!mine
					? whyNoInterrupt
					: lead
						? '协调者不能打断自己'
						: row.runtime === RUNTIME_RUNNING
							? ''
							: row.runtime === RUNTIME_INACTIVE
								? '它现在**无轮次**（没在跑任何一轮）—— 没有可打断的轮次'
								: row.runtime === RUNTIME_PROVISIONING
									? '它还在**创建中**（这一轮还没起来）—— 等它跑起来再打断'
									: row.runtime === RUNTIME_FAILED
										? '它是**失败**状态（没有在跑的那一轮）—— 打断对它没有意义'
										: `它的运行时状态读不到（${runtimeWord}）—— 拿不准有没有在跑的那一轮，所以不给打断`
			const whyDisable = !mine ? whyNotMine : off ? '它已经是**停用**状态了 —— 要它重新接活请用「恢复」' : finding === null ? '' : finding
			const whyRestore = !mine ? whyNotMine : off ? '' : '它现在**没有**被停用 —— 不需要恢复'
			return {
				disabled: off,
				verbs: {
					disable: { ok: mine && !off && finding === null, ...(whyDisable === '' ? {} : { why: whyDisable }) },
					restore: { ok: mine && off, ...(whyRestore === '' ? {} : { why: whyRestore }) },
					// **只有 `running` 才给 `interrupt.ok:true`**（其余三种一律 `ok:false` + 理由，客户端画灰 + 原样给理由）
					interrupt: { ok: mine && !lead && row.runtime === RUNTIME_RUNNING, ...(whyInterrupt === '' ? {} : { why: whyInterrupt }) },
				},
			}
		}

		// `roleId`：这一位是哪个角色（按名字约定 `<角色 id>-<序号>` 反读；协调者留空）。
		// 面板要用它把**跨角色交接单**对到人身上 —— `handoff` 工具的 `to` 是**角色 id**，不是成员名。
		const merged = mergedBase.map((row) => ({ ...row, roleId: row.kind === 'lead' ? '' : roleOfName(row.name), ...verbsOf(row) }))
		// **角色那一栏的"编制"读数**（`defaultRosterView` 要的那个形状）：按原生名册现算 ——
		// 一位队友在不在场、算不算"在场"，问的是**本会话的原生名册**（`merged`）与它的运行时读数
		// （`failed` 的不算在场，与 `defaultRosterView` 里那条判据同源）。旧名册文件不再参与。
		const liveMembersValue = {
			members: merged
				.map((row) => ({ name: row.name, role: roleOfName(row.name), status: GATE_BRIDGE.MEMBER_PRESENT_STATUS, runtime: row.runtime }))
				.filter((row) => row.role !== '' && row.name !== ''),
			removed: [],
		}
		// **服务端给动词、客户端不猜**（沿用「角色」卡那套 `removal`）：每一行带 `verbs`，
		// 每个动词给 `ok` 与（不许时的）`why`。判定只用已经算出来的事实，不另起一套规则。
		writeJson(res, 200, {
			ok: true,
			workspace: root,
			workspaceSource: resolved.source,
			// 「团队状态」那一档的计数行：**在场 N（已停用 M）/ 上限 24**。
			// 在场 = 原生名册里的队友（`failed` 的不算）；已停用 = 本插件这一层标成停用的那些；
			// 上限 = 与宿主 `maxMembers` 同值（现场核 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `maxMembers: 24`）。
			counts: {
				present: teammateRows.filter((row) => row?.status !== 'failed').length,
				disabled: disabledNames.filter((name) => isTeammate(name)).length,
				max: MEMBER_PRESENT_MAX,
			},
			// 停用名单那本账的落点（如实标注：**本插件的视图状态，不是原生名册**）。
			memberFlags: { file: join(root, MEMBER_FLAGS_FILE), note: MEMBER_FLAGS_NOTE },
			// 角色弹窗里「专属技能」那一格的可选项：**当前能真实载入的技能**（会话作用域，与「技能」块同一处读法）。
			// **已声明但本机没有的名字不由这里过滤** —— 那是客户端把"角色自己声明的"并进来、并标上「(本机没有)」：
			// 目录按会话漂移，宿主这一层静默丢掉就是丢数据。
			skillOptions: { available: skillOptions.ok, names: skillOptions.names, why: skillOptions.why },
			// 团队那半边：`available === false` 时 `reason` 就是"为什么读不到"，面板照印。
			team: (() => {
				const shaped = team.rows.map(shapeTeamRow).filter((row) => row !== null)
				return { available: team.available, reason: team.reason, rows: shaped.slice(0, MEMBER_ROWS_LIMIT), count: shaped.length }
			})(),
			// join 的结果（**这是宿主这一侧算的唯一一处判定**：按会话 id 优先、退名字匹配）：
			// 每行带 `kind`（lead / teammate / ledger）与 `ledger`（命中的记录行，含制度字段与写动作要的 name）。
			merged: merged.slice(0, MEMBER_ROWS_LIMIT),
			// **默认队友清单**（可叫的角色 + 每个角色现在的编制状态）：现场枚举 `roles/` 里除被排除的
			// 那个之外每一条，与名册 join 之后一起给 —— 与会话里的 `member_defaults` 同一个函数。
			// 名册文件读不到时**照样给清单**（清单是现场枚举，跟文件没关系），状态一律按"还没叫过"回答。
			defaults: (() => {
				const entries = defaultRosterOf(undefined, root)
				// **编制状态的真源也换掉了**（task-40 的同一条纪律）：从前这里读旧名册文件里的成员记录，
				// 那份账没人写 ⇒ 现在按**本会话的原生名册**（`merged`）现算 —— "这一档有谁在场"问的是原生。
				// `roleOfName` 按 `<角色>-<序号>` 那处约定反读（与 `member_list` 同一套），读不出角色的行不用它。
				const view = defaultRosterView(entries, liveMembersValue, rosterView.hidden)
				// 在架的先给（面板默认只画这些），下架的另给一份（面板折成一行"已下架 N（恢复）"）。
				const visible = view.filter((row) => !row.hidden)
				const hiddenRows = view.filter((row) => row.hidden)
				const shape = (row) => ({
					role: row.role,
					title: row.title,
					category: row.category,
					positioning: row.positioning,
					file: row.file,
					avatar: row.avatar,
					avatarTone: row.avatarTone,
					// 出处与"删除那个动作会做什么"：客户端据此决定给哪几个按钮（**不许自己猜**）。
					// **`skills` 是客户端真读的一格**（角色编辑弹窗按 `entry.skills.join(', ')` 预填输入框）：
					// 运行时名册（`defaultRosterOf`）本来就给这一格，宿主这一层不把它筛掉。
					skills: row.skills,
					origin: row.origin,
					// **来源标**（task-38）：中文标签由引擎那张表给，客户端只印
					originLabel: row.originLabel,
					removal: row.removal,
					state: row.state,
					present: row.present,
					archived: row.archived,
					retired: row.retired,
					removed: row.removed,
					nextName: row.nextName,
					label: row.label,
				})
				return {
					available: true,
					excluded: [...DEFAULT_ROSTER_EXCLUDED],
					count: visible.length,
					rows: visible.map(shape),
					hiddenRows: hiddenRows.map(shape),
					// **筛档**（task-38 / task-64）：项目级 / 用户级 / 包内 —— **三个根恒显**（顺序固定），
					// **空档也列、`count` 写 0**。档位是**已知闭集**（就这三个角色根，代码里能列出全集）⇒ 与技能「级别」
					// 下拉（task-62）**完全同口径**：空档被藏起来，人就没法从界面上回答"我把角色放在哪一级会被看到"。
					originFacets: ['workspace', 'user', 'package']
						.map((key) => ({ key, label: row_label_of(key), count: visible.filter((row) => row.origin === key).length })),
					hiddenFile: rosterView.file,
					// 「名册建没建立」这件事已经不属于这一栏了（它说的是旧名册文件）；原生名册可用就是可用。
					available: team.available,
				}
			})(),
			// 引擎自己那几条告警（看板读不到、编号查不到被点名、不是数组…）：原文透出，
			// 仍是只读。少了它，「看板读不到所以不给数」这件事在页面上就只剩卡上那一句话。
			warnings: [...runtime.warnings, ...(team.available ? [] : [team.reason]), ...deps.workspaceSourceWarnings(resolved)],
		})
	} catch (error) {
		console.error('[dsh-team-ops] 成员 API 异常:', error)
		writeJson(res, 500, { ok: false, error: '内部错误' })
	}
}

/**
 * 本会话的 **Agent 团队名册**（`ctx.agentTeams`）—— 与内置 `list_agents` 是同一处正文。
 *
 * 三条边界：
 *   · **要的是"这个会话"的名册**：`listMembers(agent)` 拿一个**活着的**队内 agent 当凭据，
 *     所以我们先按请求里的会话 id 取那个 Lead（`agents.get(sessionId)`）。取不到 = 这个会话
 *     现在不活着（或请求没带 session）⇒ 读不到名册，**如实说读不到**，不假装"没有队友"。
 *   · **服务不在 / 会话没成队**：`ctx.agentTeams` 取不到、或 `listMembers` 抛
 *     （`TEAM_NOT_MEMBER`：这个会话没启用 Agent Teams）⇒ 一样是"读不到"，理由原文带上。
 *   · **一行都不编**：返回的就是服务给的那几行（协调者那一行也在里面），本文件不补行、不排序。
 * @param ctx - 宿主 ctx（`agentTeams` / `agents` 都是可选服务，不进 inject）。
 * @param sessionId - 请求里带的会话 id（面板把当前会话带上）。
 * @returns `{ available, reason, rows }`。
 */
/**
 * 本会话那半边的**凭据**：`?session=` → 活着的 Lead Agent（团队名册与团队任务板都要它）。
 *
 * `listMembers(agent)` / `listTasks(caller)` 收的都是**一个活着的队内 agent**（不是会话 id），
 * 而"这个会话的 Lead"只能按会话 id 从 `ctx.agents` 取 —— 内置那边 `agent.id === agent.session.id`。
 * @param ctx - 宿主 ctx。
 * @param sessionId - 请求里带的会话 id。
 * @param what - 出错措辞里那句"读不到什么"（名册 / 任务板）。
 * @returns `{ ok, teams, lead, reason }`。
 */
export function teamCredentialOf(ctx, sessionId, what) {
	const teams = typeof ctx.get === 'function' ? ctx.get('agentTeams') : undefined
	if (teams === undefined || teams === null) return { ok: false, teams: null, lead: null, reason: deps.TEAM_SERVICE_MISSING }
	const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
	const lead = agents !== undefined && agents !== null && typeof agents.get === 'function' && sessionId !== '' ? agents.get(sessionId) : undefined
	if (lead === undefined || lead === null) {
		return {
			ok: false,
			teams,
			lead: null,
			reason: sessionId === '' ? `请求里没带会话 id：读不到本会话的${what}（它要按会话拿）。` : `会话 ${sessionId} 现在不活着（没有正在跑的 Agent）：读不到它的${what}。`,
		}
	}
	return { ok: true, teams, lead, reason: null }
}

/** 名册那一半：凭据 + `listMembers` + "凭什么读不到"。 */
/**
 * **当前能真实载入的技能名**（角色弹窗那一格的可选项）。
 *
 * 「同一处口径」不是口号：作用域读法只用 `lib/skill-scope.js` 那两个函数（`skillScopeOf` + `skillViewOptions`），
 * 与面板「技能」块（`handleSkills`）**同一对**；这里**不另写一份**作用域判定。
 * 读不到时如实返回 `{ ok: false, why }`，让面板能说"没读到会话层"而不是"一个技能都没有"。
 */
/** 这一批被剪掉的角色来自哪个根（全同就点名那个根；两个根都有就说"非包内"）。 */
/** 「运行时状态」那四个值的**唯一正文**（与客户端 `MEMBER_RUNTIME_WORDS` 同一套词：running=跑着 / inactive=无轮次 / provisioning=创建中 / failed=失败）。 */
export const RUNTIME_RUNNING = 'running'
export const RUNTIME_INACTIVE = 'inactive'
export const RUNTIME_PROVISIONING = 'provisioning'
export const RUNTIME_FAILED = 'failed'
export const RUNTIME_WORD = { running: '跑着', inactive: '无轮次', provisioning: '创建中', failed: '失败' }

/** 角色来源那一格的中文标签（引擎那张表；缺了按"包内"回落，不编新词）。 */
export function row_label_of(key) {
	return ROLE_ORIGIN_FACET_LABEL[key] ?? ROLE_ORIGIN_FACET_LABEL.package
}

export async function skillNamesNow(ctx, sessionId, workspace) {
	const view = skillScopeOf(ctx, sessionId)
	const service = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
	if (service === undefined || service === null || typeof service.snapshot !== 'function') {
		return { ok: false, names: [], why: '本进程取不到技能注册表（`ctx.skills`）—— 这一格的可选项读不到。' }
	}
	try {
		const snapshot = await service.snapshot(skillViewOptions(workspace ?? null, view))
		const raw = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.skills) ? snapshot.skills : []
		const names = raw.map((entry) => (entry !== null && typeof entry === 'object' && typeof entry.name === 'string' ? entry.name : '')).filter((name) => name !== '')
		return { ok: true, names, why: view.why }
	} catch (error) {
		return { ok: false, names: [], why: messageOf(error) }
	}
}

export function teamRosterOf(ctx, sessionId) {
	const credential = teamCredentialOf(ctx, sessionId, ' agent 名册')
	if (!credential.ok) return { available: false, reason: credential.reason, rows: [] }
	if (typeof credential.teams.listMembers !== 'function') return { available: false, reason: deps.TEAM_SERVICE_MISSING, rows: [] }
	try {
		const rows = credential.teams.listMembers(credential.lead)
		return { available: true, reason: null, rows: Array.isArray(rows) ? rows : [] }
	} catch (error) {
		// 措辞：**先说这是什么、再说本会话为什么没有**，最后把原生服务那句原文照引（诊断要用）。
		// 从前写成"这个会话读不到…多半是它还没成队"，读起来像"你的会话出错了" —— 其实只是
		// 本会话没有原生队伍（本插件不建原生队伍），而这一档读的是 DSH 原生那本账。
		return {
			available: false,
			reason:
				`这一档读的是 DSH **原生**的、按会话的团队名册；本会话没有原生成队（本插件不建原生队伍），所以这里没有可读的账。` +
				`本插件的成员名册在下面照常显示。原生服务的原文：${messageOf(error)}`,
			rows: [],
		}
	}
}

/**
 * 任务板那一半（`/team-tasks`）：本会话 Agent Teams 的共享任务（`listTasks`）—— **只读**。
 *
 * 为什么只读得这么死：claim / complete / 改依赖 / 改归属都是 `team_task_*` 那套会话工具的活
 * （它们是 CAS + 授权 + 留痕的完整事务），面板插一脚就是在两处实现同一套事务。这一栏只把
 * **同一份视图**（`projectTaskView` 给的那几个字段）摆出来。
 * @param ctx - 宿主 ctx。
 * @param req - 请求（GET，`?session=` 用来找本会话的 Lead）。
 * @param res - 响应。
 */
export async function handleTeamTasks(ctx, req, res) {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		writeJson(res, 405, { ok: false, error: '团队任务板只支持 GET（本栏只读）' })
		return
	}
	const credential = teamCredentialOf(ctx, requestedSession(req.url), '团队任务板')
	if (!credential.ok) {
		// 与团队名册同一条纪律：**200 + available:false + 理由**，不是 503 ——
		// 这一块还有本插件看板那一半要显示，读不到团队那半边不该把整块判失败。
		writeJson(res, 200, { ok: true, available: false, reason: credential.reason, rows: [], counts: null, warnings: [credential.reason] })
		return
	}
	if (typeof credential.teams.listTasks !== 'function') {
		writeJson(res, 200, { ok: true, available: false, reason: deps.TEAM_TASKS_UNSUPPORTED, rows: [], counts: null, warnings: [deps.TEAM_TASKS_UNSUPPORTED] })
		return
	}
	try {
		const raw = credential.teams.listTasks(credential.lead)
		const rawRows = Array.isArray(raw) ? raw : []
		const rows = []
		// 字段级截断的**登记本**：哪些行的哪个数组被砍了、砍到几条、原本几条 —— 一条都不许静默丢。
		const truncations = []
		for (let i = 0; i < rawRows.length && rows.length < MEMBER_ROWS_LIMIT; i++) {
			const shaped = shapeTeamTask(rawRows[i])
			if (shaped === null) continue
			rows.push(shaped)
			truncations.push(...taskTruncationsOf(rawRows[i], shaped))
		}
		// 计数**照原生状态词**数（pending / in_progress / completed 三档）—— 本文件不把它们
		// 映射成我们那五栏（那是两套制度，映射就是发明）。
		const counts = { pending: 0, in_progress: 0, completed: 0 }
		for (const row of rows) if (Object.hasOwn(counts, row.status)) counts[row.status] += 1
		// **检查点有没有**（只读展示；读不到就当没有，不新增告警噪声）。
		// 只有请求带了 workspace 才算得出来（面板按当前会话的工作目录传）。
		const requested = deps.requestedWorkspace(req.url)
		if (requested.kind === 'ok') {
			for (const row of rows) {
				if (typeof row.id !== 'string' || row.id === '') continue
				try {
					row.checkpoint = { present: await structuredExists(requested.value, row.id) }
				} catch {
					// **读不到 ≠ 没有**：面板与回执同一口径，用 null 区分。
					row.checkpoint = { present: null }
				}
			}
		}
		const warnings = []
		if (rawRows.length > rows.length) warnings.push(`团队任务共 ${rawRows.length} 条，这里只回了前 ${rows.length} 条（回传上限 ${MEMBER_ROWS_LIMIT}）。`)
		if (truncations.length > 0) {
			const hit = new Set(truncations.map((entry) => '' + entry.id)).size
			const fields = [...new Set(truncations.map((entry) => entry.field))]
				.map((field) => `${field} 上限 ${TEAM_TASK_ARRAY_LIMITS[field]} 条`)
				.join('、')
			warnings.push(
				`有 ${hit} 条任务的字段被**按条数截断**（原生对这几个数组没有上限，这里是本文件给的上限：${fields}）：逐条的 shown / total 见 truncations —— 面板要按它印明"只列了前 N 条（共 M 条）"；依赖列表被截断时，ready 仍是按**全部**依赖算的，所以会出现"列出来的依赖都满足、这条却还不能开工"的读法。`,
			)
		}
		writeJson(res, 200, { ok: true, available: true, reason: null, rows, counts, total: rawRows.length, truncations, warnings })
	} catch (error) {
		// 同上：说得清"这是什么档、为什么本会话没有"，并照引原生原文（诊断要用），不写成"你出错了"。
		writeJson(res, 200, {
			ok: true,
			available: false,
			reason:
				`这一档读的是 DSH **原生**的、按会话的团队任务板；本会话没有原生成队（本插件不建原生队伍），所以这里没有可读的账。` +
				`本插件的看板就是面板那一档（读的是原生那份账）。原生服务的原文：${messageOf(error)}`,
			rows: [],
			counts: null,
			warnings: [],
		})
	}
}


/**
 * 团队任务行里三个数组的**条数上限**（原生对它们没有上限）。
 *
 * **截断必须看得见**（与 `MEMBER_ROWS_LIMIT` 同一条纪律）：行形状由别处的自检逐字钉住，
 * 所以截断的读数**不塞进行里**，而是按行登记在载荷的 `truncations`（`{ id, field, shown, total }`）。
 * 从前这三个数在这里静默砍掉：一条有 20 个依赖的任务只列 16 条，而 `ready` 是原生按**全部**
 * 依赖算的 ⇒ 页面会出现"列出来的依赖都满足，但这条仍是等依赖"这种读不通的话，且找不到原因。
 */
export const TEAM_TASK_ARRAY_LIMITS = { blockedBy: 16, writeScopes: 16, writeScopeWarnings: 8 }

/**
 * 一行的**字段级截断读数**（`shown` / `total` 都原样给，绝不静默砍）。
 * @param raw - `listTasks` 给的那一行（未整形）。
 * @param shaped - 同一行整形之后的结果。
 * @returns `{ id, field, shown, total }` 数组；没有截断就是空数组。
 */
export function taskTruncationsOf(raw, shaped) {
	const out = []
	for (const [field, limit] of Object.entries(TEAM_TASK_ARRAY_LIMITS)) {
		const source = raw !== null && typeof raw === 'object' && Array.isArray(raw[field]) ? raw[field] : []
		const shown = Array.isArray(shaped[field]) ? shaped[field].length : 0
		// `shown < total` 才算截断：非标量元素也被 `asScalarArray` 读作 null 丢掉，那同样是"少了"。
		if (shown < source.length) out.push({ id: shaped.id, field, shown, total: source.length, limit })
	}
	return out
}

/**
 * 团队任务视图的**整形**（`projectTaskView` 给的那几个字段，只留标量叶子 + 两个数组）。
 * 三个数组按 {@link TEAM_TASK_ARRAY_LIMITS} 取前若干条，被取掉的部分登记进载荷的 `truncations`。
 * @param raw - `listTasks` 给的任务视图。
 * @returns 扁平记录，或 null（非对象）。
 */
export function shapeTeamTask(raw) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
	return {
		id: asScalar(raw.id),
		revision: asScalar(raw.revision),
		subject: asScalar(raw.subject),
		description: asScalar(raw.description),
		status: asScalar(raw.status),
		ownerName: asScalar(raw.ownerName),
		ready: raw.ready === true,
		blockedBy: asScalarArray(raw.blockedBy, TEAM_TASK_ARRAY_LIMITS.blockedBy),
		writeScopes: asScalarArray(raw.writeScopes, TEAM_TASK_ARRAY_LIMITS.writeScopes),
		writeScopeWarnings: asScalarArray(raw.writeScopeWarnings, TEAM_TASK_ARRAY_LIMITS.writeScopeWarnings),
	}
}


/**
 * 团队名册的一行**整形**（只留标量叶子 + 诊断那几条）。
 * @param raw - `listMembers` 给的行。
 * @returns 扁平记录，或 null（非对象）。
 */
export function shapeTeamRow(raw) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
	return {
		id: asScalar(raw.id),
		name: asScalar(raw.name),
		role: asScalar(raw.role),
		status: asScalar(raw.status),
		description: asScalar(raw.description),
		provider: asScalar(raw.provider),
		context: asScalar(raw.context),
		model: asScalar(raw.model),
		diagnostics: asScalarArray(raw.diagnostics, 8),
	}
}

/**
 * **这一块要画的那张表**：本会话的原生 Agent Teams 名册，逐行整形（协调者第一，顺序照服务给的）。
 *
 * task-40 起**不再 join** 我们的旧名册文件（`.ops/members.json`）：那一份早没人写，
 * join 它只会让"这一位在不在册"变成拿旧账当判据（人机器上它是 0 行 ⇒ 所有人都落进"未入册"，语义正好相反）。
 * 现在一名成员就是一行，`kind` 只有 `lead` / `teammate` 两种。
 * @param teamRows - `listMembers` 的行（可为空）。
 * @returns 行数组（`{ key, kind, name, session, runtime, model, provider, context, description, diagnostics }`）。
 */
export function mergeRoster(runtimeRows) {
	const merged = []
	for (const live of Array.isArray(runtimeRows) ? runtimeRows : []) {
		// 进来的是**已经叠过实时读数的原生行**（`runtimeReadings` 的产物）：`avatar` / `avatarTone`
		// 都挂在这一份上 —— 所以这里**不再二次整形**（`shapeTeamRow` 那份固定字段表会
		// 把它们丢掉；第一版就是这么丢的，字段契约那条用例当场抓到）。
		const id = asScalar(live?.id)
		const name = asScalar(live?.name)
		merged.push({
			key: 'team:' + (id !== null ? '' + id : '' + name),
			kind: asScalar(live?.role) === 'lead' ? 'lead' : 'teammate',
			name: name === null ? '' : name,
			session: id === null ? '' : id,
			runtime: asScalar(live?.status) === null ? '' : '' + asScalar(live?.status),
			model: asScalar(live?.model) === null ? '' : asScalar(live?.model),
			provider: asScalar(live?.provider) === null ? '' : asScalar(live?.provider),
			context: asScalar(live?.context) === null ? '' : asScalar(live?.context),
			description: asScalar(live?.description) === null ? '' : asScalar(live?.description),
			diagnostics: asScalarArray(live?.diagnostics, 8),
			// 实时读数与头像（由 `runtimeReadings` 现算）—— 原样带过去
			...(live?.avatar === undefined ? {} : { avatar: live.avatar }),
			...(live?.avatarTone === undefined ? {} : { avatarTone: live.avatarTone }),
			...(live?.runtime === undefined ? {} : { runtimeLive: live.runtime }),
		})
	}
	return merged
}

/** 取请求里的会话 id（`?session=`）—— 面板把"当前是哪个会话"带上来，团队名册按它拿。 */
export function requestedSession(url) {
	const value = queryValue(url, 'session')
	return typeof value === 'string' ? value : ''
}

/**
 * 成员行的**实时读数**叠加：运行时状态（取活着的 Agent）+ 未读邮箱（取邮箱文件）。
 *
 * 三条口径：
 *   · 实时状态只**覆盖**不发明：活着的 Agent 在跑 ⇒ `running`；活着但没在跑 ⇒ `inactive`；
 *     **一个活的都没有**时保留盘上那个值（可能是 provisioning / failed）；盘上也没有 ⇒ 不写这个键。
 *     于是「名册里没有这个字段」（老文件、没装运行时）在前端表现为**一个徽标都不印**，
 *     而不是被读成「空闲」。
 *   · 一条都不改成员行的既有判定：这里不重算 `linked`、不动 `present`，只叠加运行时状态。
 * @param ctx - 宿主 ctx（用 `ctx.get('agents')` 取可选服务，不进 `inject`）。
 * @param root - 工作区绝对路径。
 * @param rows - 成员行（原样传入，返回新数组）。
 * @param tasks - 看板条目（用于判邮件的执行代是否已作废）；`undefined` = 看板读不到，此时只按投递状态判未读。
 * @returns `{ rows, warnings }`。
 */
export async function runtimeReadings(ctx, root, rows) {
	const warnings = []
	const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
	const out = []
	for (const row of Array.isArray(rows) ? rows : []) {
		const next = { ...row }
		if (agents !== undefined && typeof agents.get === 'function' && typeof row?.session === 'string' && row.session !== '') {
			const live = agents.get(row.session)
			if (live !== undefined && live !== null) next.runtime = live.status === 'running' ? 'running' : 'inactive'
		}
		// 头像：**映射只有引擎那一处正文**（`avatarOf`），宿主只把它按角色查一次挂上行；
		// 未收录的自定义角色也会拿到一个确定的 emoji 与色调（不是空白）。
		next.avatar = avatarOf(row?.role)
		next.avatarTone = avatarToneOf(row?.role)
		out.push(next)
	}
	return { rows: out, warnings }
}
