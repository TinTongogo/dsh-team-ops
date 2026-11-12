/**
 * dsh-team-ops · 一人公司团队插件 —— host half（唯一的一行 loader entry）
 *
 * 两件事都搭这一行：
 *   1. 团队能力 —— 在服务就绪后**自己 apply** 那两个引擎（制度层 + 运行时层，见
 *      `mountTeamEngines`）：团队工具与策略段因此随**插件**装载，与"会话选了哪个预设"无关。
 *   2. 状态页 —— 把本会话 **DSH 原生 Agent Teams** 的实时读数（名册 / 共享任务板）与工作区
 *      `.ops/` 里那几份真源（人的话 / 角色开关 / 下架 / 停用 / 交接快照）以 JSON 暴露给同源的
 *      浏览器半边；面板上的写动作只**转发引擎自己那份实现**（gate-write.js），宿主不另写判定。
 *      实时看板与成员不在文件里：`.ops/board.json` / `members.json` 是遗留，只作历史回退。
 *
 * 本文件是 composition 里**本包唯一的一行 loader entry**；`dsh-client-modules` 会用
 * 「该入口模块最近的祖先 package.json」定位本包，因此本包的 `dsh.client` 与
 * `exports["./client"]` 决定浏览器半边从哪来。
 *
 * 为什么只能有一行：`ClientModuleRegistry.resolveSource()` 把每个 loader entry 解析到
 * 它最近的祖先 `package.json`，只要那个包声明了 `dsh.client`，这个 entry 就成为该包的
 * 一个「客户端来源」；`reconcilePackage()` 在 sources.length > 1 时直接抛错并让整棵
 * 插件树装载失败。所以本包**不得**再插入第二条指向本包的 entry —— 启动自诊断因此并进
 * 这一行（diagnose.js 仍独立成文件，只是不再由包内 patch 单独插入）。
 *
 * 路由：前缀下的具名端点是一张**纯表**（见 `routeTable()`）：每条路径由某个
 * `lib/*-routes.js` 模块提供；未命中的 GET 走文件读路径，未匹配的写方法一律 405。
 *   · 仅接受 loopback（Host 为 127.0.0.1 / localhost / [::1]）同源请求；
 *     这是 DNS-rebinding 与跨站读取的护栏，不是身份认证。
 *   · 失败一律返回 JSON，不把内部路径或堆栈回显给浏览器。
 *   · 宿主自己不写任何文件：写动作全部转发引擎（`lib/gate-write.js` 与各端点模块）。
 *
 * 配置（composition 行的 config）：
 *   workspace: 必填。文件所在的工作区绝对路径（各端点据此解析 `.ops/` 与角色根）。省略时各端点都返回 503
 *              并说明该配哪个键 —— 本包不猜任何人的工作区。
 */

import { spawn } from 'node:child_process'

import { opsFileOf } from './ops-files.js'

import { apply as runDiagnosis } from './diagnose.js'
// 团队能力的两个半边（制度层 + 运行时层）：由本行**自己 apply**（见 mountTeamEngines 的说明 ——
// 不能再插第二条 loader entry，那会让本包出现多个"客户端来源"而把 DSH 启崩）。
import { apply as applyGateEngine } from '../team/company-gate.js'
import { apply as applyRuntimeEngine } from '../team/team-runtime.js'
import { installSessionWatch } from './session-watch.js'
import { writeJson } from './http-tools.js'
import { createRolePackRoutes } from './role-pack-routes.js'
import { createSkillRoutes } from './skill-routes.js'
import { createPolishRoutes } from './polish-routes.js'
import { createPolishService } from './polish.js'
import { createRoleRoutes } from './role-routes.js'
import { createMemberWriteRoutes } from './member-write-routes.js'
import { createTeamRoutes, requestedSession, teamCredentialOf } from './team-routes.js'
import { createStatusRoutes } from './status-routes.js'
import { createCollabRoutes } from './collab-routes.js'
import { createOpenRoutes } from './open-routes.js'
import { createWorkspaceIO } from './workspace-io.js'

/**
 * 硬依赖声明。cordis 的 Guard 拒绝未声明的服务属性访问
 * （报 `cannot get property "x" without inject`），所以 apply 里用到的每个
 * 服务都必须在这里点名，不能靠 `ctx.x` 裸取。
 */
export const inject = ['webServer', 'fs']

/** 本插件独占的路由前缀。 */
export const ROUTE_PATH = '/company-board/api'

/** 状态端点的子路径：三行状态（面板首屏就用它，口径与 `team_status` 同源）。 */
export const STATUS_PATH = ROUTE_PATH + '/status'

/**
 * 里程碑清单的只读子路径（「任务看板」那一栏的 **EPIC 档**用它）。
 *
 * 读的是工作区里那份 `docs/team/里程碑.md` —— **`phase` 取值域与出口准则的唯一落点**，
 * 由 `lib/milestones.js` 的 `parseMilestones` 解析（宿主只把文件读成文本）。
 */
export const MILESTONES_PATH = ROUTE_PATH + '/milestones'

/** 成员端点的子路径：成员行、在场数与编制上限的读数（按原生名册与停用标记现算）。 */
export const MEMBERS_PATH = ROUTE_PATH + '/members'

/**
 * 「打开本地目录」的子路径。
 *
 * 为什么要有它：浏览器**不允许**页面直接跳 `file://`（现场实测：`<a href="file://…">` 点了不弹，
 * 只把路径复制走了）。而壳自己就是 Electron 主进程 —— `main.js` 与 `electron-runtime` 都用
 * `shell.openPath(...)` 开本地文件。所以这里走同一条路：主进程 API，不是在页面里造链接。
 *
 * 边界（这个端点会**动**系统，所以卡得比只读端点死）：
 *   · 只接受 POST；请求体只认一个 `path`；
 *   · `path` 必须是**绝对路径**且落在这个工作区之内（等于工作区根，或以 `根/` 开头）——
 *     否则就是"任意路径打开器"，那是给本机任何网页递刀子；
 *   · 目标必须存在且是目录；
 *   · 取不到 electron（例如非 Desktop 形态）⇒ 409 + 说明，不静默。
 */
export const OPEN_PATH = ROUTE_PATH + '/open'

/** 输入框润色的子路径（`POST`，body `{session,text}`；契约见 `lib/polish-routes.js`）。 */
export const POLISH_PATH = ROUTE_PATH + '/polish'

/** 里程碑清单在工作区里的相对路径（`phase` 取值域的唯一落点；面板 EPIC 那一档读它）。 */
export const MILESTONE_FILE = 'docs/team/里程碑.md'

/** 成员编辑 / 删除的子路径（面板卡片上那三个动作里的两个写动作）。 */
export const MEMBER_UPDATE_PATH = ROUTE_PATH + '/members/update'
export const MEMBER_DELETE_PATH = ROUTE_PATH + '/members/delete'
/** 停用 / 恢复一位成员（本插件这一层的视图状态；见 `lib/member-flags.js`）。 */
export const MEMBER_DISABLE_PATH = ROUTE_PATH + '/members/disable'
export const MEMBER_RESTORE_PATH = ROUTE_PATH + '/members/restore'
/** 打断一位成员**当前那一轮**（原生 `interrupt`；收件箱保留、名册与两条上限都不变 —— 角色槽位 / 在场总人数）。 */
export const MEMBER_INTERRUPT_PATH = ROUTE_PATH + '/members/interrupt'

/**
 * 「角色」那一节的增删改（三条写路径）。
 *
 * 与成员那两条同形：宿主只把请求体翻成引擎参数、把引擎的结论原样转达，**判定一处不重写**
 * （id 形状、同名拒绝、包内不可删只能下架、下架记录的事务全在 `team-runtime.js`）。
 * **它们缺省写工作区里的角色根**（`<工作区>/.dsh/team-ops/roles/`）；显式 `scope: "user"` 才落用户角色根（`$DSH_TEAM_OPS_ROLES`，缺省
 * `$DSH_HOME/team-ops/roles`）—— 那是本插件第二处写用户级路径的地方（第一处是装预设）；
 * 删除只在下架那一支写工作区文件 `.ops/roster.json`。
 */
export const ROLES_UPDATE_PATH = ROUTE_PATH + '/roles/update'

export const ROLES_REMOVE_PATH = ROUTE_PATH + '/roles/remove'
export const ROLES_RESTORE_PATH = ROUTE_PATH + '/roles/restore'
/**
 * 角色管理：清单（读）、定义原文（读）、头像文件（读）、开关（写）、复制为自定义（写）。
 *
 * 注意：**面板界面已不再调用这五个端点**（「角色」那一块按人的指令从视图栏撤下）：它们留着，
 * 理由与当年保留 `/members` 一样 —— 会话工具 `role_manage` 与角色端点（现住在
 * `lib/role-routes.js`）读的是引擎同一份判定，自检也覆盖着；不必重写一遍。
 * 保留不等于放宽边界：它们仍然是"只读 + 两个窄写"（写请求体只接受点名的字段）。
 */
export const ROLES_PATH = ROUTE_PATH + '/roles'
export const ROLE_DEFINITION_PATH = ROUTE_PATH + '/roles/definition'
export const ROLE_AVATAR_PATH = ROUTE_PATH + '/roles/avatar'
export const ROLE_TOGGLE_PATH = ROUTE_PATH + '/roles/toggle'
export const ROLE_CUSTOMIZE_PATH = ROUTE_PATH + '/roles/customize'

/**
 * **角色包**的两个端点：导出（GET）与导入（POST）。
 *
 * 与技能导入同一类：人在面板上点一下，宿主把 `lib/role-pack.js` 的回执原样摆出来。
 * 导入那条路的请求体是**整个包**（JSON 文本或对象），所以限额单独给（限额在 `lib/role-pack-routes.js`）。
 */
export const ROLES_EXPORT_PATH = ROUTE_PATH + '/roles/export'
export const ROLES_IMPORT_PATH = ROUTE_PATH + '/roles/import'

/**
 * 「技能」块：宿主**技能注册表**（`ctx.skills`）的目录与正文。
 *
 * 这一块**不自己扫盘**：技能从哪些根来（项目 `.dsh/skills`、`.agents/skills`、用户
 * `<dshHome>/skills`、自定义目录、随包目录…）、同名怎么裁决、正文存在哪 —— 全是 DSH
 * 技能注册表那一处正文，面板只把它的答案摆出来。于是"面板上列着的"与"模型能加载的"
 * 对得上是结构上的，不是两边各照约定写一遍。
 * 两条是**只读**：目录（`/skills`）与某一条的正文（`/skills/definition`）。
 *
 * 另外三条是**写**（人在面板上点的那一下，唯一实现是 `lib/skill-write.js`）：
 * `/skills/import`（从本机目录或 .md 导入）、`/skills/create`（新建一份）、`/skills/remove`（删掉一份）。
 * 写只落在**可写的两类根**上（用户级 `~/.dsh/skills`、项目级 `<工作区>/.dsh/skills`），
 * 随包发布的技能（`bundled`）与别的 agent 的根（`user-agents`）只读。
 */
export const SKILLS_PATH = ROUTE_PATH + '/skills'
export const SKILL_DEFINITION_PATH = ROUTE_PATH + '/skills/definition'
export const SKILLS_IMPORT_PATH = ROUTE_PATH + '/skills/import'
export const SKILLS_CREATE_PATH = ROUTE_PATH + '/skills/create'
export const SKILLS_REMOVE_PATH = ROUTE_PATH + '/skills/remove'

/**
 * 「任务看板」块里**团队那一半**：本会话 Agent Teams 的共享任务板（`ctx.agentTeams.listTasks`）。
 *
 * 与 `/members` 的团队那一半同一套取法与同一套口径：按 `?session=` 取活着的 Lead 当凭据；
 * 服务不在 / 没带会话 / 会话不活着 / 还没成队 ⇒ `available: false` + `reason`（原文透出），
 * **不假装"没有任务"**，也不影响本插件看板那一半照常显示。
 */
export const TEAM_TASKS_PATH = ROUTE_PATH + '/team-tasks'
export const COLLAB_PATH = ROUTE_PATH + '/collab'

/**
 * **团队服务那一层的包名**：DSH 把它做成了"可选 bundle"（`@deepseek-ai/dsh-app-boot` 的
 * `OPTIONAL_BUNDLES` 里那四个之一），开关是 `pluginManager.setBundleEnabled(name, enabled)`
 * —— GUI 的插件设置调的就是同一个方法。这一格是常量，面板**不接受调用方给包名**
 * （否则这个端点就成了"任意包开关"）。
 */
export const TEAM_PROFILE_BUNDLE = '@deepseek-ai/dsh-experimental-agent-team-profile'

/** 团队服务那一层的开 / 关 / 查（`ROUTE_PATH` 下的一个端点）。 */
export const TEAM_SERVICE_PATH = ROUTE_PATH + '/team-service'


/** 团队服务那个端点只收一个动作名（`{"action":"enable"}`），一条小限额就够。 */
const TEAM_SERVICE_BODY_LIMIT = 4 * 1024

/** 视图：文件名 + 集合键 + 子路径（审批与共识那两份随它们的制度一并撤下）。 */
export const LEDGERS = {
	board: { file: opsFileOf('board'), collection: 'tasks', subpath: '' },
}


/** 工作区解析与遗留账读取住在 `lib/workspace-io.js`；宿主注入路由常量并保留原有导出面。 */
const workspaceIO = createWorkspaceIO({ ROUTE_PATH, LEDGERS })
export const requestedWorkspace = workspaceIO.requestedWorkspace
export const ledgerKeyOf = workspaceIO.ledgerKeyOf
export const readLedger = workspaceIO.readLedger
const { openWorkspaceOf, openWorkspaceSoftly, workspaceSourceWarnings, isLoopbackSameOrigin, readRawItems } = workspaceIO

// ── loader entry 的其余部分：引擎装配（mountTeamEngines）与路由注册（apply）────────
// 前缀下的具名端点见 {@link routeTable}；工作区解析与遗留账读取已分到 `lib/workspace-io.js`。
/**
 * **团队能力的两半随插件装载**（制度层 `company-gate.js` + 运行时层 `team-runtime.js`）。
 *
 * 人的要求：「我不要预设可不可以？只装插件能力」。第一版是把这两行插进 `cordis.patch.yml`，
 * **现场直接把 DSH 启崩了**：
 *
 *     client-modules: package dsh-team-ops resolves from multiple active Loader sources:
 *       "…/node_modules/dsh-team-ops/team/company-gate.js" …
 *
 * 宿主那套 `ClientModuleRegistry` 按**最近的 `package.json`** 给每条 loader entry 归属：本包声明了
 * `dsh.client`，于是任何指向包内文件的 entry 也算本包的一条"客户端来源"，多一条就 Fatal
 * （`reconcilePackage()`：`sources.length > 1` 直接抛）。**指向同一个包的 entry 只能有一条** ——
 * 所以改成：这条唯一的宿主行**自己**把两个引擎 `apply` 起来。
 *
 * 两个技术点：
 *   ① **服务不等 inject**：引擎要 `tools` / `systemPrompt` / `subagents` / `agents`，而本行的 `inject`
 *      只声明了 `webServer` 与 `fs`（面板不该因为某个服务缺席就整块装不上）。这里用一个"开放的 ctx"
 *      把属性读取转成 `ctx.get(name)`（绕开 cordis Guard 的未声明拒绝），并**轮询等它们就绪**再挂 ——
 *      到点仍缺就记一条告警：面板照常可用，团队工具这一层缺就如实说缺。
 *   ② **幂等**：两个引擎自己带"一进程只挂一次"的闸（见 team-runtime.js / company-gate.js 顶部），
 *      所以即使用户预设根里那份**旧副本**还声明着这两行，也不会重挂一遍（工具名不会撞）。
 *
 * 整个过程**不抛**：这一行崩了会把整棵插件树带崩（面板也没了），所以全部包在 try/catch 里。
 * @param ctx - 本行的 context。
 */
/** 已经挂过团队能力的运行时（`ctx.root`，同一运行时里所有子 ctx 共用它）。
 *  幂等的第一道闸在**这一处**：同一个 ctx/运行时再调一次 `apply` 就是空操作（引擎各自还有第二道）。 */
const teamEnginesMountedAt = new WeakSet()

function mountTeamEngines(ctx) {
	try {
		const key = ctx?.root ?? ctx
		if (key !== null && key !== undefined && teamEnginesMountedAt.has(key)) return
		if (key !== null && key !== undefined) teamEnginesMountedAt.add(key)
	} catch {
		// 假 ctx（不是对象）⇒ 不做这道幂等，交给引擎自己那道
	}
	/** 引擎要的服务；全到才挂。`fs` 本行已声明（进 inject）。 */
	const NEEDED = ['tools', 'systemPrompt', 'subagents', 'agents']
	/** 等服务的时限与轮询间隔（宿主行是并发装配的，早一步取不到不等于没有）。 */
	const WAIT_MS = 20_000
	const STEP_MS = 250
	const started = Date.now()

	/** 读一个服务，读不到就给 undefined（不吃 Guard 的异常）。 */
	const serviceOf = (name) => {
		try {
			return typeof ctx.get === 'function' ? ctx.get(name) : undefined
		} catch {
			return undefined
		}
	}

	/**
	 * **开放的 ctx**：属性读取先走 `ctx.get(name)`，于是引擎里 `ctx.tools.register(...)` 这类写法
	 * 不必进本行的 `inject` 也能拿到服务（Guard 只拦未声明的**属性**访问）。方法/自身字段（`get` /
	 * `effect` / `on` / `logger` / `fs` 等）照旧直取。
	 */
	const openCtx = new Proxy(ctx, {
		get: (target, key) => {
			if (typeof key !== 'string' || key in OPEN_PASSTHROUGH) return Reflect.get(target, key)
			const direct = serviceOf(key)
			return direct === undefined ? Reflect.get(target, key) : direct
		},
	})
	// 直取白名单：本行自己声明的服务与 cordis 的那几个方法/字段。
	const OPEN_PASSTHROUGH = new Set(['get', 'effect', 'on', 'off', 'inject', 'logger', 'fs', 'reflect', 'scope', 'root', 'dispose', 'extend', 'set', 'provide'])

	/** 放弃等之后置位：**只告警一次**、并停掉定时器（否则每 250ms 重复告警、表永不消失）。 */
	let gaveUp = false
	const attempt = () => {
		if (gaveUp) return false
		const missing = NEEDED.filter((name) => serviceOf(name) === undefined)
		if (missing.length === 0) return true
		if (Date.now() - started < WAIT_MS) return false
		gaveUp = true
		try {
			console.warn(`[dsh-team-ops] 团队能力那两半没挂上：等 ${missing.join('、')} 超过 ${WAIT_MS / 1000} 秒仍未就绪。面板与文件端点照常可用；团队工具这一层本进程缺席。`)
		} catch {}
		return false
	}

	const timer = setInterval(() => {
		let mounted = false
		try {
			mounted = attempt()
		} catch {
			mounted = false
		}
		// 放弃等（或已挂上）就停表：不给"每 250ms 一句告警"留下可能，也不拖住进程退出。
		if (!mounted) {
			if (gaveUp) clearInterval(timer)
			return
		}
		clearInterval(timer)
		try {
			applyGateEngine(openCtx)
		} catch (error) {
			try {
				console.warn('[dsh-team-ops] 制度层（company-gate）挂载失败：', error)
			} catch {}
		}
		try {
			applyRuntimeEngine(openCtx, { memberProvider: 'spawn' })
		} catch (error) {
			try {
				console.warn('[dsh-team-ops] 运行时层（team-runtime）挂载失败：', error)
			} catch {}
		}
	}, STEP_MS)
	// 第一次可能服务已就绪 ⇒ 别白等 250ms。
	try {
		if (attempt()) {
			clearInterval(timer)
			applyGateEngine(openCtx)
			applyRuntimeEngine(openCtx, { memberProvider: 'spawn' })
			return
		}
	} catch (error) {
		try {
			console.warn('[dsh-team-ops] 团队能力挂载（首次尝试）失败：', error)
		} catch {}
	}
	// `unref`：这个轮询绝不该**拖住进程退出**（测试里尤其明显）。
	try {
		if (typeof timer?.unref === 'function') timer.unref()
	} catch {}
	try {
		if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(timer), 'team-ops: 团队能力挂载轮询')
	} catch {}
}

export function apply(ctx, config) {
	// 团队能力（制度层 + 运行时层）也搭这一条 entry：**不新增 loader entry**（理由见 mountTeamEngines）。
	mountTeamEngines(ctx)

	// **会话事件监听**（人的设计：快照事件化 + 压缩检查点；见 `docs/team/specs/上下文连贯性补缺.md`）。
	// 与引擎解耦：即使引擎挂载晚到，事件也可能先来（比如另一个会话改了任务板）⇒ 立刻装、随插件注销。
	try {
		ctx.effect(() => installSessionWatch(ctx), 'team-ops: 会话事件（快照刷新 / 压缩检查点）')
	} catch (error) {
		try {
			console.warn('[dsh-team-ops] 会话事件监听没装上（不影响面板与工具）：', error)
		} catch {}
	}

	// 启动自诊断搭同一条 entry 的车（本包只能有一条，理由见文件头）。
	// 包在 try 里：自诊断是只读增强，它自己抛错绝不能把这一行带崩、连带整棵插件树。
	try {
		runDiagnosis(ctx)
	} catch (error) {
		try {
			console.error('[dsh-team-ops] 启动自诊断抛错（已隔离，不影响文件端点）：', error)
		} catch {}
	}

	const row = config !== undefined && config !== null ? config : {}
	const workspace = typeof row.workspace === 'string' && row.workspace.trim() !== '' ? row.workspace.trim() : null

	if (workspace === null) {
		console.warn('[dsh-team-ops] 文件前端页未在 composition 行里配置 workspace：各栏按请求带的 workspace 工作（前端按当前会话的工作目录传），只有请求也不带它时那些端点才返回 503。要用固定工作区，就在那一行的 config.workspace 里给绝对路径。')
	}

	const routes = routeTable()

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'prefix',
				path: ROUTE_PATH,
				handler: async (req, res) => {
					if (!isLoopbackSameOrigin(req)) {
						writeJson(res, 403, { ok: false, error: '仅接受本机同源请求' })
						return
					}
					const pathOnly = typeof req.url === 'string' ? req.url.split('?')[0].split('#')[0] : ''
					const route = routes.get(pathOnly)
					if (route !== undefined) {
						await route[0](ctx, req, res, workspace, route[1])
						return
					}
					// 兜底：上面那些具名端点之外的路由。**这条分支不许删** —— 删掉之后带着写方法打过来的
					// 请求会直接落进下面的读路径，被当成一次读答成 200（写方法被静默接受比回错码更坏）。
					// 措辞里**不许引用任何路径常量**：原来那句拼了一个全仓不存在的标识符，未匹配的 POST
					// 当场抛 ReferenceError（宿主侧就成了一次 500），而它本该是一句可读的 405。
					if (req.method !== 'GET' && req.method !== 'HEAD') {
						writeJson(res, 405, {
							ok: false,
							error: '这个前缀下没有能处理该方法的端点：未匹配的写请求一律回 405 —— 读端点只收 GET / HEAD；写动作（登记 / 认领 / 收口、成员与角色、技能）在会话工具 `board_task` / `member_*` / `role_manage` 上，不在这条 HTTP 面上。',
						})
						return
					}
					const key = ledgerKeyOf(req.url)
					if (key === null) {
						writeJson(res, 404, { ok: false, error: '未知文件：只支持 board' })
						return
					}
					const opened = await openWorkspaceOf(ctx, req, res, workspace)
					if (opened === null) return
					const root = opened.root
					const resolved = opened.resolved
					try {
						// 先验工作区本身：目录不存在是调用方给了错路径（不是「还没有文件」），
						// 得跟「目录在、状态文件还没建」分开报，否则前者会被显示成空态而没人发现。
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
						// 期限判定的基准就在**这一处**取：每个请求现取一次时刻，交给同一条读取路径。
						// 不传它，「到期主动找人」就只到会话侧为止，面板上那些期限是静的。
						const now = new Date().toISOString()
						const payload = await readLedger(ctx.fs, root, key, now)
						writeJson(
							res,
							payload.ok ? 200 : 503,
							payload.ok ? { ...payload, workspace: root, workspaceSource: resolved.source, warnings: [...(Array.isArray(payload.warnings) ? payload.warnings : []), ...workspaceSourceWarnings(resolved)] } : payload,
						)
					} catch (error) {
						console.error('[dsh-team-ops] 文件 API 异常:', error)
						writeJson(res, 500, { ok: false, error: '内部错误' })
					}
				},
			}),
		'dsh-team-ops: 只读 API',
	)
}



/** 老版本 Agent Teams（没有 `listTasks`）时那一行措辞（两处共用同一句）。 */
const TEAM_TASKS_UNSUPPORTED =
	'这个部署的 Agent Teams 服务没有 `listTasks`：读不到本会话的团队任务板 —— **读不到不等于"没有任务"**。'

/** 团队名册缺席时那一行**唯一的**措辞（面板照印，不另写一份）。 */
const TEAM_SERVICE_MISSING =
	'这个部署没有 Agent Teams 服务（`ctx.agentTeams` 取不到）：读不到本会话的 agent 名册 —— 读不到不等于"会话里没有 agent"。'
	+ '它随 DSH 的 base profile 提供（旧版是一个可选能力层 `' + TEAM_PROFILE_BUNDLE + '`，新版本已并入 base 并退役该 bundle）：'
	+ '面板这边开不了它 —— 请确认这个 profile 的 `dsh.profile.bundles` 含 base 一层。'

/** 状态/里程碑/团队服务开关住在 `lib/status-routes.js`；宿主只装配依赖并保留导出面。 */
const statusRoutes = createStatusRoutes({
	openWorkspaceOf,
	openWorkspaceSoftly,
	workspaceSourceWarnings,
	readRawItems,
	readLedger,
	requestedWorkspace,
	LEDGERS,
	TEAM_PROFILE_BUNDLE,
	TEAM_SERVICE_BODY_LIMIT,
	TEAM_SERVICE_MISSING,
	TEAM_TASKS_UNSUPPORTED,
	MILESTONE_FILE,
})
export const handleTeamService = statusRoutes.handleTeamService
export const handleMilestones = statusRoutes.handleMilestones
export const handleStatus = statusRoutes.handleStatus

/** 打开目录住在 `lib/open-routes.js`；宿主只装配依赖并保留导出面。 */
const openRoutes = createOpenRoutes({ openWorkspaceOf })
export const nativeOpenSpec = openRoutes.nativeOpenSpec
export const handleOpen = openRoutes.handleOpen

/** 协作读数住在 `lib/collab-routes.js`；面板「任务看板」块用它显示效率一行。 */
const collabRoutes = createCollabRoutes({ openWorkspaceOf, teamCredentialOf, requestedSession })
export const handleCollab = collabRoutes.handleCollab

/** 团队视图住在 `lib/team-routes.js`；宿主只装配依赖并保留原有导出面。 */
const teamRoutes = createTeamRoutes({
	openWorkspaceOf,
	requestedWorkspace,
	workspaceSourceWarnings,
	TEAM_SERVICE_MISSING,
	TEAM_TASKS_UNSUPPORTED,
})
export const handleMembers = teamRoutes.handleMembers
export const handleTeamTasks = teamRoutes.handleTeamTasks

/** 成员写端点住在 `lib/member-write-routes.js`；宿主只装配依赖并保留原有导出面。 */
const memberWriteRoutes = createMemberWriteRoutes({
	openWorkspaceOf,
	teamCredentialOf,
	requestedSession,
	paths: { disable: MEMBER_DISABLE_PATH, restore: MEMBER_RESTORE_PATH, interrupt: MEMBER_INTERRUPT_PATH },
})
export const handleMemberWrite = memberWriteRoutes.handleMemberWrite

/** 技能端点族住在 `lib/skill-routes.js`；宿主只装配依赖并保留原有导出面。 */
const skillRoutes = createSkillRoutes({ openWorkspaceOf, openWorkspaceSoftly })
export const handleSkills = skillRoutes.handleSkills
export const handleSkillDefinition = skillRoutes.handleSkillDefinition
export const invalidateSkillCatalog = skillRoutes.invalidateSkillCatalog
export const handleSkillWrite = skillRoutes.handleSkillWrite

/** 角色端点族住在 `lib/role-routes.js`；宿主只装配依赖并保留原有导出面。 */
const roleRoutes = createRoleRoutes({ openWorkspaceOf, openWorkspaceSoftly, workspaceSourceWarnings })
export const handleRoles = roleRoutes.handleRoles
export const handleRoleDefinition = roleRoutes.handleRoleDefinition
export const handleRoleAvatar = roleRoutes.handleRoleAvatar
export const handleRoleToggle = roleRoutes.handleRoleToggle
export const handleRoleCustomize = roleRoutes.handleRoleCustomize
export const handleRoleWrite = roleRoutes.handleRoleWrite

/** 角色包端点住在 `lib/role-pack-routes.js`；宿主只装配依赖并保留原有的导出面。 */
const rolePackRoutes = createRolePackRoutes({ openWorkspaceOf, openWorkspaceSoftly })
export const handleRoleExport = rolePackRoutes.handleRoleExport
export const handleRoleImport = rolePackRoutes.handleRoleImport

/** 润色端点住在 `lib/polish-routes.js`（模型调用在 `lib/polish.js`）；宿主只装配依赖并保留导出面。 */
const polishRoutes = createPolishRoutes({ polish: createPolishService() })
export const handlePolish = polishRoutes.handlePolish

/**
 * 前缀下的具名端点**纯表**：路径 → `[handler, action?]`。
 * 抽成可导出的函数是为了让自检查真实登记关系（不再扫源码文本）；`apply` 里只调一次。
 */
export function routeTable() {
	return new Map([
		[TEAM_SERVICE_PATH, [handleTeamService]],
		[MILESTONES_PATH, [handleMilestones]],
		[STATUS_PATH, [handleStatus]],
		[MEMBERS_PATH, [handleMembers]],
		[TEAM_TASKS_PATH, [handleTeamTasks]],
		[COLLAB_PATH, [handleCollab]],
		[SKILLS_PATH, [handleSkills]],
		[SKILL_DEFINITION_PATH, [handleSkillDefinition]],
		[OPEN_PATH, [handleOpen]],
		[ROLES_PATH, [handleRoles]],
		[ROLE_DEFINITION_PATH, [handleRoleDefinition]],
		[ROLE_AVATAR_PATH, [handleRoleAvatar]],
		[ROLE_TOGGLE_PATH, [handleRoleToggle]],
		[ROLE_CUSTOMIZE_PATH, [handleRoleCustomize]],
		[ROLES_EXPORT_PATH, [handleRoleExport]],
		[ROLES_IMPORT_PATH, [handleRoleImport]],
		[MEMBER_UPDATE_PATH, [handleMemberWrite, 'update']],
		[MEMBER_DELETE_PATH, [handleMemberWrite, 'delete']],
		[MEMBER_DISABLE_PATH, [handleMemberWrite, 'disable']],
		[MEMBER_RESTORE_PATH, [handleMemberWrite, 'restore']],
		[MEMBER_INTERRUPT_PATH, [handleMemberWrite, 'interrupt']],
		[SKILLS_IMPORT_PATH, [handleSkillWrite, 'import']],
		[SKILLS_CREATE_PATH, [handleSkillWrite, 'create']],
		[SKILLS_REMOVE_PATH, [handleSkillWrite, 'remove']],
		[ROLES_UPDATE_PATH, [handleRoleWrite, 'update']],
		[ROLES_REMOVE_PATH, [handleRoleWrite, 'remove']],
		[ROLES_RESTORE_PATH, [handleRoleWrite, 'restore']],
		[POLISH_PATH, [handlePolish]],
	])
}

