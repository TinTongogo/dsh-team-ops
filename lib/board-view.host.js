/**
 * dsh-team-ops · 一人公司团队插件 —— host half（唯一的一行 loader entry）
 *
 * 两件事都搭这一行：
 *   1. 团队能力 —— 在服务就绪后**自己 apply** 那两个引擎（制度层 + 运行时层，见
 *      `mountTeamEngines`）：团队工具与策略段因此随**插件**装载，与"会话选了哪个预设"无关。
 *   2. 状态页 —— 把工作区里的文件（看板 / 成员名册 / 人的话）与本会话的 Agent Teams
 *      数据（名册 / 共享任务板）以 JSON 暴露给同源的浏览器半边（读），并接收人在面板上做的
 *      两个写动作：成员的编辑（含启用/停用）与成员的删除 —— 都只是**转发引擎自己那份实现**
 *      （gate-write.js），宿主不写文件、也不另写判定：
 *   · `.company-gate.board.json`     任务看板（任务状态的唯一真相源）
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
 * 写入边界：只有一处 —— 成员写入口（改一条记录 / 删一条记录）。宿主不写别的文件、不建条目、不删除、不动看板。
 *
 * 路由：GET  <前缀>              → 任务看板
 *        GET  <前缀>/status       → 两行状态（第一行是看板分栏计数；口径同 team_status）
 *   · 仅接受 loopback（Host 为 127.0.0.1 / localhost / [::1]）同源请求；
 *     这是 DNS-rebinding 与跨站读取的护栏，不是身份认证。
 *   · 失败一律返回 JSON，不把内部路径或堆栈回显给浏览器。
 *
 * 配置（composition 行的 config）：
 *   workspace: 必填。文件所在的工作区绝对路径（三个视图 + 成员名册 + 邮箱文件的未读计数）。省略时各端点都返回 503
 *              并说明该配哪个键 —— 本包不猜任何人的工作区。
 */

import { spawn } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'

import { skillScopeOf, skillViewOptions } from './skill-scope.js'
import { MEMBER_FLAGS_FILE, MEMBER_FLAGS_NOTE, disableFindings, readDisabledNames } from './member-flags.js'
import { MEMBER_PRESENT_MAX } from './team-limits.js'
import { join } from 'node:path'

import { apply as runDiagnosis } from './diagnose.js'
import { createSkill, importSkill, importSkillFiles, removeSkill, skillRootLabel } from './skill-write.js'
// 看板五档状态与「收口」那一档：唯一正文在 `lib/board-status.js`（原先本文件自己抄了一份、顺序还与引擎不同）。
import { BOARD_DONE_STATUS, BOARD_STATUSES as BOARD_STATUSES_SHARED } from './board-status.js'
import {
	createRoleInWorkspace,
	editRoleInWorkspace,
	policyForWorkspace,
	removeRoleInWorkspace,
	restoreRoleInWorkspace,
} from './gate-write.js'
// 团队能力的两个半边（制度层 + 运行时层）：由本行**自己 apply**（见 mountTeamEngines 的说明 ——
// 不能再插第二条 loader entry，那会让本包出现多个"客户端来源"而把 DSH 启崩）。
import { apply as applyGateEngine, runtimeBridge as GATE_BRIDGE } from '../team/company-gate.js'
import { apply as applyRuntimeEngine } from '../team/team-runtime.js'
// 状态口径的**唯一一处正文**在引擎里（会话工具 `team_status` 用的是同一份）。
// 面板只负责把文件读进来交给它，**不另写一套判定** —— 否则面板与 `team_status` 迟早各说各话。
// 成员栏守同一条纪律：`memberSnapshot` 是「在场多少 / 破没破线 / 破线那一行理由是什么」的**唯一一处正文**
// —— 会话工具 `member_list` 算的就是它。面板只把文件喂给它，**不复制这套判定、也不自己拼那几个数**，
// 于是两边逐条对得上是结构上就成立的，而不是"我保证一致"。
import { parseMilestones, statusSnapshot, writeScopeWarningsOf } from '../team/company-gate.js'
// 未读邮箱的判定（`unreadCount` / `inboxOf`）只有**运行时那半边**那一处正文：面板与 `member_list`
// 读的是同一份，所以卡上的未读数不可能与工具回执对不上。这里只 import 纯函数，
// 不在宿主半边装载任何运行时钩子（钩子随预设装配，见 team-runtime.js 的 apply）。
// 「默认队友清单」（可叫的角色 + 当前编制状态）与运行时是**同一处正文**：`defaultRosterOf` 现场枚举
// `roles/`，`defaultRosterView` 把清单与名册 join 起来 —— 会话里的 `member_defaults` 调的就是这两个，
// 所以面板上印的清单与它逐条一样，不可能各说各话（宿主不另算"这个角色现在算不算在场"）。
import {
	DEFAULT_ROSTER_EXCLUDED,
	ROLE_ORIGIN_FACET_LABEL,
	avatarOf,
	avatarToneOf,
	customizeRole,
	defaultRosterOf,
	defaultRosterView,
	inboxOf,
	roleDefinitionTextOf,
	roleRecords,
	pruneSkillFromRoles,
	rosterLedgerOf,
	rolesViewOf,
	setMemberDisabled,
	setRoleEnabled,
	unreadCount,
} from '../team/team-runtime.js'

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
 * 由引擎那处 `parseMilestones` 解析（宿主只把文件读成文本，怎么认那张表在引擎里）。
 */
export const MILESTONES_PATH = ROUTE_PATH + '/milestones'

/**
 * 成员端点的子路径：成员栏的读数（`在场 x / 告警线 y` + 成员行 + 破线理由行）。
 *
 * 与 `/status` 同一路子：宿主只负责把名册文件读进来交给引擎，**判定留在引擎那一处**
 * （`memberSnapshot`，会话工具 `member_list` 算的是同一份）—— 所以它不是"第四份视图"，
 * 而是"同一处判定的一扇窗"。由此面板与 `member_list` 逐条对得上是**结构**上的，不是口径承诺。
 */
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
 * 删除只在下架那一支写工作区文件 `.company-gate.roster.json`。
 */
export const ROLES_UPDATE_PATH = ROUTE_PATH + '/roles/update'

export const ROLES_REMOVE_PATH = ROUTE_PATH + '/roles/remove'
export const ROLES_RESTORE_PATH = ROUTE_PATH + '/roles/restore'
/**
 * 角色管理：清单（读）、定义原文（读）、头像文件（读）、开关（写）、复制为自定义（写）。
 *
 * 注意：**面板界面已不再调用这五个端点**（「角色」那一块按人的指令从视图栏撤下）：它们留着，
 * 理由与当年保留 `/members` 一样 —— 会话工具 `role_manage` 与引擎 `setRoleEnabled` /
 * `customizeRole` 是同一份判定，自检也覆盖着；哪天要再长出一块界面，不必重写一遍。
 * 保留不等于放宽边界：它们仍然是"只读 + 两个窄写"（写请求体只接受点名的字段）。
 */
export const ROLES_PATH = ROUTE_PATH + '/roles'
export const ROLE_DEFINITION_PATH = ROUTE_PATH + '/roles/definition'
export const ROLE_AVATAR_PATH = ROUTE_PATH + '/roles/avatar'
export const ROLE_TOGGLE_PATH = ROUTE_PATH + '/roles/toggle'
export const ROLE_CUSTOMIZE_PATH = ROUTE_PATH + '/roles/customize'

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

/**
 * **团队服务那一层的包名**：DSH 把它做成了"可选 bundle"（`@deepseek-ai/dsh-app-boot` 的
 * `OPTIONAL_BUNDLES` 里那四个之一），开关是 `pluginManager.setBundleEnabled(name, enabled)`
 * —— GUI 的插件设置调的就是同一个方法。这一格是常量，面板**不接受调用方给包名**
 * （否则这个端点就成了"任意包开关"）。
 */
export const TEAM_PROFILE_BUNDLE = '@deepseek-ai/dsh-experimental-agent-team-profile'

/** 团队服务那一层的开 / 关 / 查（`ROUTE_PATH` 下的一个端点）。 */
export const TEAM_SERVICE_PATH = ROUTE_PATH + '/team-service'

/** 单次回传的技能条数上限（正常部署远小于它；真超了要在载荷里说明"截断了"）。 */
const SKILL_ROWS_LIMIT = 400
/** 技能正文回传上限：正文可能很长，超过就截断并**明说截断**（不假装那就是全文）。 */
const SKILL_CONTENT_LIMIT = 256 * 1024

/** 写请求体上限：一条决定最多这几个字段，超过就是有人在塞别的东西。 */
const DECIDE_BODY_LIMIT = 8 * 1024
/** 成员编辑的请求体上限：整段提示词可以很长（人设 + 首活），给 64 KB。 */
const MEMBER_BODY_LIMIT = 64 * 1024
/**
 * **技能导入**那条路的请求体上限：拖进来的一批文件是 base64 上传的（4 MB 文件 ⇒ 约 5.4 MB 正文），
 * 64 KB 那条通用上限撑不住。这里给 8 MB —— 比 `lib/skill-write.js` 的 4 MB 文件上限留足 base64 的膨胀。
 */
const SKILL_IMPORT_BODY_LIMIT = 8 * 1024 * 1024
/** 团队服务那个端点只收一个动作名（`{"action":"enable"}`），一条小限额就够。 */
const TEAM_SERVICE_BODY_LIMIT = 4 * 1024
/** 角色自定义头像：认这几个扩展名（引擎那份 `AVATAR_FILE_NAMES` 决定命中哪个）。 */
const AVATAR_TYPES = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' }
/** 头像文件上限：它是给人看的贴图，不该有几 MB。 */
const AVATAR_SIZE_LIMIT = 512 * 1024

/** 取查询串里的一个参数（缺省空串）——只用于 `?role=` 这类短参数。 */
function queryValue(url, name) {
	const query = typeof url === 'string' ? url.split('#')[0].split('?')[1] : undefined
	if (query === undefined || query.length === 0) return ''
	try {
		const raw = new URLSearchParams(query).get(name)
		return raw === null ? '' : raw.trim()
	} catch {
		return ''
	}
}

/** 视图：文件名 + 集合键 + 子路径（审批与共识那两份随它们的制度一并撤下）。 */
export const LEDGERS = {
	board: { file: '.company-gate.board.json', collection: 'tasks', subpath: '' },
}

/**
 * 名册文件：**不放进 `LEDGERS`**，它走专用端点（`MEMBERS_PATH`）。
 *
 * 为什么不并进那三份：`LEDGERS` 那三份是"界面上的视图"——共用一套整形（`SHAPERS`）、分栏与卡片，
 * 走通用 GET 那条路 `readLedger`。成员栏不是那样的视图：每个数字都由引擎 `memberSnapshot` 出，
 * 宿主不该给它另配一个整形器（那正是"第二套判定"的入口）。所以这里只留文件名与集合键，
 * 供 `/members` 那条只读路径使用。
 */
export const MEMBER_LEDGER = { file: '.company-gate.members.json', collection: 'members' }

/**
 * 邮箱文件：**只用来在成员卡上补一个未读计数**（`mailbox_unread`）。
 *
 * 它读不到**不让成员端点失败**（与看板那一份同一条口径）：未读数是辅料，
 * 名册还在、人还在，就不该因为邮箱文件坏了而整块消失。
 */
export const MAILBOX_LEDGER = { file: '.company-gate.mailbox.json', collection: 'messages' }

/**
 * 成员行进入页面载荷的条数上限。
 *
 * 名册正常是几个到几十个；超过这个数说明有东西在灌这份文件。**截断必须看得见**：载荷同时带上
 * 引擎的 `total`，面板在 `rows` 少于 `total` 时写明"只显示了前 N 行"——不写就等于把截断说成全部。
 * 计数那几个数**不受它影响**（它们是引擎按整本名册算的）。
 */
const MEMBER_ROWS_LIMIT = 200

/**
 * 成员行里**要显式放行**的两个非标量字段的长度上限。
 *
 * `linked.missingIds` 最多也就这么长；给上限是为了让"有人在灌这份文件"
 * 时页面载荷仍然有界（与 `MEMBER_ROWS_LIMIT` 同一条纪律：超了要看得见，不能悄悄涨）。
 */
const MEMBER_BOARD_IDS_LIMIT = 32
const MEMBER_MISSING_IDS_LIMIT = 32

// 看板状态枚举与"收口"那一档：唯一正文在 `lib/board-status.js`（本文件原先自己抄了一份、且顺序与引擎不同）。
const BOARD_STATUSES = BOARD_STATUSES_SHARED
const DONE_STATUS = BOARD_DONE_STATUS
const BOARD_PRIORITIES = ['P0', 'P1', 'P2', 'P3', '—']

/** 只放行 JSON 可承载的标量，其余（对象/数组/函数）一律读作 null。 */
function asScalar(value) {
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
function asScalarArray(value, max) {
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
function shapeRecord(raw) {
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
function shapeRecordArray(value, max) {
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
 * 为什么不写在浏览器半边：这段措辞的**唯一正文**在引擎里（`memberLinkedCell`，会话里
 * `member_list` 的 Markdown 那一格用的就是它），面板与名册工具必须逐字同源。这里只做
 * 「哪一档 → 哪句话」的翻译，与 `dueReadingOf` 同一纪律：**不重算比率、不另设阈值** ——
 * 一旦让前端自己拼 `delivered/assigned`，两处迟早就同一个成员给出不同的数。
 * 四档（第三档带失效编号点名）：
 *   · 看板里没有归属给它的条目（`linked === null`）⇒「未链接（显示最后动笔）」，**绝不印 `0/0`**：
 *     `0/0` 会被读成"链接了、零条交付"，而真相是压根没链接过；
 *   · 看板文件读不到 ⇒「不给数（看板文件读不到）」—— 读不到不是零交付；
 *   · 已链接 ⇒ `已交付 <delivered>/<assigned>`（分母只数**能在看板里查到的**编号）；
 *   · `missing > 0` 时**必须**在同一句里带出「链接失效 n 条：…」（协调器 D1 裁决的硬要求）；
 *     链接的编号**全部查不到**时分母是 0，此时不印 `0/0`（那与"未链接"的空读数长得一样），
 *     改印「有效链接 0 条」。
 * @param linked - 引擎 `memberSnapshot` 每行的派生字段 `linked`（`null` = 未链接）。
 * @returns 可直接上卡的那一句。
 */
function linkedReadingOf(linked) {
	if (linked === null || linked === undefined) return '未链接（显示最后动笔）'
	if (linked.boardUnavailable === true || linked.assigned === null) return '不给数（看板文件读不到）'
	const missing = typeof linked.missing === 'number' ? linked.missing : 0
	const ids = Array.isArray(linked.missingIds) ? linked.missingIds : []
	const stale = missing > 0 ? `链接失效 ${missing} 条：${ids.join('、')}` : ''
	const head = linked.assigned === 0 ? '有效链接 0 条' : `已交付 ${linked.delivered}/${linked.assigned}`
	return stale === '' ? head : `${head}；${stale}`
}

/** 引擎 `linked` 的整形：三个数 + 点名的编号 + 「读不到」标记，键名照抄引擎。 */
function shapeLinked(raw) {
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
 * @param raw - 引擎 `memberSnapshot().rows` 里的一行。
 * @returns 只含标量叶子 + 两个放行字段的记录，或 null（不是对象）。
 */
function shapeMember(raw) {
	const flat = shapeRecord(raw)
	if (flat === null) return null
	flat.linked = shapeLinked(raw.linked)
	flat.linkedText = linkedReadingOf(flat.linked)
	return flat
}

/** 成员行数组：走成员专用整形（放行 `linked`），长度受限，非对象元素丢弃。 */
function shapeMemberArray(value, max) {
	if (!Array.isArray(value)) return []
	const out = []
	for (let i = 0; i < value.length && i < max; i++) {
		const shaped = shapeMember(value[i])
		if (shaped !== null) out.push(shaped)
	}
	return out
}

/** 状态文件共有的顶层标量：seq 与 writer。 */
function shapeEnvelope(parsed) {
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
function shapeTask(raw) {
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
const SHAPERS = { board: shapeTask }

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
	const spec = LEDGERS[key]
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
	if (rest.startsWith(ROUTE_PATH)) rest = rest.slice(ROUTE_PATH.length)
	rest = rest.replace(/^\/+/, '').replace(/\/+$/, '')
	if (rest === '' || rest === 'board') return 'board'
	const keys = Object.keys(LEDGERS)
	for (let i = 0; i < keys.length; i++) {
		if (LEDGERS[keys[i]].subpath !== '' && LEDGERS[keys[i]].subpath === rest) return keys[i]
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
 * 读请求体（带上限）。只给写入口用：读路径不需要 body。
 * @param req - Node 的 IncomingMessage。
 * @param limit - 字节上限。
 * @returns UTF-8 文本；超限抛错。
 */
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		if (typeof req.on !== 'function') {
			resolve('')
			return
		}
		let size = 0
		let exceeded = false
		const chunks = []
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > limit) {
				// **超限不掐连接**（`req.destroy()` 会让浏览器只看到 "TypeError: Failed to fetch"，
				// 人拿不到任何可读原因）。这里把剩下的读完、丢掉内容，最后回一个**正常的 413**。
				exceeded = true
				chunks.length = 0
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => {
			if (exceeded) {
				const error = new Error('请求体过大')
				error.code = 'BODY_TOO_LARGE'
				error.limit = limit
				error.size = size
				reject(error)
				return
			}
			resolve(Buffer.concat(chunks).toString('utf8'))
		})
		req.on('error', reject)
	})
}

/**
 * 读体失败时的统一回执：**超限给 413**（说清上限与收到多少 KB），其余给 400。
 * 只在这一处判定 —— 各端点不再各写一遍。
 */
function bodyError(res, error, limit) {
	if (error !== null && typeof error === 'object' && error.code === 'BODY_TOO_LARGE') {
		const got = Math.round((typeof error.size === 'number' ? error.size : 0) / 1024)
		// **上限取读体时真正用的那个**（`readBody` 把它记在错误上）：调用方传错常量也不会说谎 ——
		// 现场踩过：某个端点用 8 KB 读体、回执却写「上限 64 KB」（3 处，已修）。
		const real = typeof error.limit === 'number' && error.limit > 0 ? error.limit : limit
		writeJson(res, 413, {
			ok: false,
			error: `请求体过大：收到约 ${got} KB，上限 ${Math.round(real / 1024)} KB。技能导入请分批，或改用「新建技能」手写正文。`,
		})
		return
	}
	writeJson(res, 400, { ok: false, error: '请求体不合法：' + messageOf(error) })
}

/** 写一个 JSON 响应；不缓存，不回显内部信息。 */
function writeJson(res, status, value) {
	const body = JSON.stringify(value)
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
	res.end(body)
}

/** 出错时的统一措辞：只给可读原因，不给路径与堆栈。 */
function messageOf(error) {
	if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
	return String(error)
}

/**
 * 宿主 loader entry：挂上文件的只读 API（三份视图 + 状态 + 成员）。
 * @param ctx - 宿主 cordis 上下文（webServer、fs）。
 * @param config - 该 composition 行的 config；读取 `workspace`。
 */
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
					if (pathOnly === TEAM_SERVICE_PATH) {
						await handleTeamService(ctx, req, res)
						return
					}
					if (pathOnly === MILESTONES_PATH) {
						await handleMilestones(ctx, req, res, workspace)
						return
					}
					if (pathOnly === STATUS_PATH) {
						await handleStatus(ctx, req, res, workspace)
						return
					}
					if (pathOnly === MEMBERS_PATH) {
						await handleMembers(ctx, req, res, workspace)
						return
					}
					if (pathOnly === TEAM_TASKS_PATH) {
						await handleTeamTasks(ctx, req, res)
						return
					}
					if (pathOnly === SKILLS_PATH) {
						await handleSkills(ctx, req, res, workspace)
						return
					}
					if (pathOnly === SKILL_DEFINITION_PATH) {
						await handleSkillDefinition(ctx, req, res, workspace)
						return
					}
					if (pathOnly === OPEN_PATH) {
						await handleOpen(ctx, req, res, workspace)
						return
					}
					if (pathOnly === ROLES_PATH) {
						await handleRoles(ctx, req, res, workspace)
						return
					}
					if (pathOnly === ROLE_DEFINITION_PATH) {
						await handleRoleDefinition(ctx, req, res, workspace)
						return
					}
					if (pathOnly === ROLE_AVATAR_PATH) {
						await handleRoleAvatar(ctx, req, res, workspace)
						return
					}
					if (pathOnly === ROLE_TOGGLE_PATH) {
						await handleRoleToggle(ctx, req, res, workspace)
						return
					}
					if (pathOnly === ROLE_CUSTOMIZE_PATH) {
						await handleRoleCustomize(ctx, req, res, workspace)
						return
					}
					if (pathOnly === MEMBER_UPDATE_PATH) {
						await handleMemberWrite(ctx, req, res, workspace, 'update')
						return
					}
					if (pathOnly === MEMBER_DELETE_PATH) {
						await handleMemberWrite(ctx, req, res, workspace, 'delete')
						return
					}
					if (pathOnly === MEMBER_DISABLE_PATH) {
						await handleMemberWrite(ctx, req, res, workspace, 'disable')
						return
					}
					if (pathOnly === MEMBER_RESTORE_PATH) {
						await handleMemberWrite(ctx, req, res, workspace, 'restore')
						return
					}
					if (pathOnly === MEMBER_INTERRUPT_PATH) {
						await handleMemberWrite(ctx, req, res, workspace, 'interrupt')
						return
					}
					if (pathOnly === SKILLS_IMPORT_PATH) {
						await handleSkillWrite(ctx, req, res, workspace, 'import')
						return
					}
					if (pathOnly === SKILLS_CREATE_PATH) {
						await handleSkillWrite(ctx, req, res, workspace, 'create')
						return
					}
					if (pathOnly === SKILLS_REMOVE_PATH) {
						await handleSkillWrite(ctx, req, res, workspace, 'remove')
						return
					}
					if (pathOnly === ROLES_UPDATE_PATH) {
						await handleRoleWrite(ctx, req, res, workspace, 'update')
						return
					}
					if (pathOnly === ROLES_REMOVE_PATH) {
						await handleRoleWrite(ctx, req, res, workspace, 'remove')
						return
					}
					if (pathOnly === ROLES_RESTORE_PATH) {
						await handleRoleWrite(ctx, req, res, workspace, 'restore')
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

/**
 * 读一份文件的**原始条目数组**（不整形，只判"读得到 / 读不到"）。
 *
 * 为什么另开一条读法：状态口径要的是原始字段（`status` / `blockedBy` / `decisions`），
 * 而 `readLedger` 的整形载荷按界面约定只留标量叶子、**不含 `blockedBy` 与 `decisions`**
 * （卡住与"当前状态取 decisions 尾项"都读不到）。把原始数组并进 `readLedger` 的返回值，
 * 会顺带把它泄漏进页面载荷 —— 所以这里单独读、单独用。
 * 成员端点的理由相同：引擎 `memberSnapshot` 要的是文件里那几条成员记录本身。
 * @param spec - `{ file, collection }`（见 `LEDGERS` 与 `MEMBER_LEDGER`）——传 spec 而不是 key，
 *               因为名册文件刻意不在 `LEDGERS` 里（见那边的注释）。
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
 * **面板里叫人**：选一个角色 + 给它一件事 ⇒ 让它去干（`POST { role, task }`）。
 *
 * 口径（人的指令：「选完之后，输入框输入任务，当前任务就让选中角色去干」）：
 *   · 面板**只管两件输入**：`role`（名册里的一个）与 `task`（首活）。职责那句取角色定位（引擎默认），
 *     名字按 `<角色>-<序号>` 现算（引擎默认）—— 面板不另立规矩。
 *   · 门禁、记账、冻结身份段、起持久子会话**全在引擎那一份实现里**（`spawnMember`）：这里不预判、
 *     只把结论原样转达。它说"角色不在名册里 / 这个角色停用了 / 名字被占了"，面板就照印那句话。
 *   · 需要**本会话的 Lead agent** 当父（生人是协调者专属动作，引擎按调用者身份判）：拿不到 Lead
 *     （服务不在 / 会话没成队 / 会话不在）就如实说拿不到，不伪造一个调用者。
 *   · 本会话没加载「一人公司团队」预设时，引擎那边会明说"这条路口只在预设里提供"⇒ 照印。
 * @param ctx - 宿主 ctx（要 `agents` 服务取本会话的 Lead；可选 `agentTeams`）。
 * @param req - 请求（POST）。
 * @param res - 响应。
 * @param fallback - composition 行配的 workspace。
 * @returns {Promise<void>}
 */
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
export async function handleTeamService(ctx, req, res) {
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
			warnings: ['这个部署没有 `pluginManager` 服务（它只在带 profile 的安装里装载）：请到 DSH 的插件 / 能力设置里开 `' + TEAM_PROFILE_BUNDLE + '`。'],
		})
		return
	}
	const readBundle = async () => {
		const rows = await manager.listBundles()
		const found = Array.isArray(rows) ? rows.find((row) => row !== null && typeof row === 'object' && row.name === TEAM_PROFILE_BUNDLE) : undefined
		return found === undefined
			? null
			: {
					name: TEAM_PROFILE_BUNDLE,
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
			body = JSON.parse(await readBody(req, TEAM_SERVICE_BODY_LIMIT))
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
		const result = await manager.setBundleEnabled(TEAM_PROFILE_BUNDLE, action === 'enable')
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
					? 'DSH 安装里没有这个包（这不正常）：跑 `dsh plugin add ' + TEAM_PROFILE_BUNDLE + '`。'
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
 *   · **解析只在引擎那一处**（`parseMilestones`）：宿主只负责读文本；
 *   · 读不出任何一行时如实说"没认出表形"（半行都不臆造）——EPIC 那一档据此只印代号与板上读数。
 * @param ctx - 宿主 ctx（用 `ctx.fs`读文件）。
 * @param req - 请求（GET）。
 * @param res - 响应。
 * @param fallback - composition 行配的 workspace。
 */
export async function handleMilestones(ctx, req, res, fallback) {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		writeJson(res, 405, { ok: false, error: '里程碑清单只支持 GET（本栏只读）' })
		return
	}
	const opened = await openWorkspaceOf(ctx, req, res, fallback)
	if (opened === null) return
	const root = opened.root
	const resolved = opened.resolved
	const absPath = join(root, MILESTONE_FILE)
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
				warnings: [`里程碑清单还没建立（${absPath}）—— 这份清单是 \`phase\` 的取值域与出口准则的唯一落点，按需建立：EPIC 那一档现在只印代号与板上的读数。`, ...workspaceSourceWarnings(resolved)],
			})
			return
		}
		if (info.type !== 'file') {
			writeJson(res, 503, { ok: false, error: '里程碑清单不是常规文件：' + absPath })
			return
		}
		const rows = parseMilestones(await ctx.fs.readText(await ctx.fs.resolve(absPath)))
		if (rows.length === 0) warnings.push(`里程碑清单里没认出任何一行表格（${absPath}）—— 表的形状变了？EPIC 那一档现在只印代号与板上读数，**不臆造阶段名**。`)
		writeJson(res, 200, { ok: true, workspace: root, workspaceSource: resolved.source, path: absPath, exists: true, rows, warnings: [...warnings, ...workspaceSourceWarnings(resolved)] })
	} catch (error) {
		writeJson(res, 503, { ok: false, error: '里程碑清单读不成：' + messageOf(error) })
	}
}

/**
 * `/status` 的**数据来源判定**（一处正文）。
 *
 * 为什么要判：本插件的文件看板（`.company-gate.board.json`）在任务板迁到 DSH 原生 Agent Teams
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
	if (typeof credential.teams.listTasks !== 'function') return { kind: 'legacy', rows: [], reason: TEAM_TASKS_UNSUPPORTED }
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
	return `本端点的计数读的是**本插件的文件看板**（${LEDGERS.board.file}）：它**不再承载实时状态**（任务板已迁到 DSH 原生 Agent Teams，这份文件可能已停止更新），所以下面这几个数可能是旧的 —— 实时读数用 team_status。没能读原生那一本账的原因（服务方原文）：${reason}`
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
export async function handleStatus(ctx, req, res, fallback) {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		writeJson(res, 405, { ok: false, error: '状态只支持 GET' })
		return
	}
	const opened = await openWorkspaceOf(ctx, req, res, fallback)
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
		const board = await readRawItems(ctx.fs, root, LEDGERS.board)
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
				if (task.status === DONE_STATUS) continue
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
			warnings: [sourceLine, ...workspaceSourceWarnings(resolved)],
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

/**
 * 引擎那份读数里**它自己写的提示行**（未建立的建法说明 / 破线理由行）。
 *
 * 为什么不在这里另写一份措辞：这些话只有引擎一处正文（`memberSnapshot` 的 `markdown` 尾行），
 * 抄一遍就多了一处会各自漂移的副本 —— 而这两句话正是要在面板上被逐字看到的那两句
 * （「未建立时怎么建」与「破线时为什么需要第 N 个」）。所以取回即用、一个字不改。
 * 形状规则：引擎把提示行都写成 Markdown 引用（`> …`）；客户端收到后用本包那套 Markdown 渲染，
 * 于是面板上那一行与 `member_list` 的 `markdown` 里那一行**是同一串字符**。
 * @param markdown - 引擎 `memberSnapshot().markdown`。
 * @returns 提示行数组（原样带 `>` 前缀）。
 */
function annotationLinesOf(markdown) {
	return String(markdown === null || markdown === undefined ? '' : markdown)
		.split('\n')
		.filter((line) => line.startsWith('>'))
}

/**
 * 成员端点：把名册文件的**原始条目**交给引擎的 `memberSnapshot`，回成员栏要的那几个数。
 *
 * 与 `/status` 完全同一路子，三条口径：
 *   · 读数（`在场 x / 告警线 y`、破没破线、那一行理由）**一律来自引擎**，宿主不算也不改 ——
 *     所以面板上的数与 `member_list` 的数逐条对得上是结构上的，不是"两边都照约定写"；
 *   · 文件**缺文件**时照引擎的「未建立」回答：`established: false`、各计数为 `null`（**不是 0**）。
 *     「还没记过名册」与「记了、里面没人」的下一步动作相反，把前者读成 0 就是让读的人以为记过；
 *   · 文件在而读不成（不是常规文件 / JSON 坏 / 缺 `members` 数组）一律 503，**不降级成空名册**；
 *   · **看板那一份只喂给引擎、不参与本端点的成败**：`linked` 要能对上"链接的是哪些任务",
 *     所以这里按设计 §3.2 多读一份看板（`readRawItems`，同 `handleStatus` 的既有做法）并把原始
 *     条目交给 `memberSnapshot` 的 `boardTasks`；看板读不到时**照引擎的口径回答**（三数为 null +
 *     一条告警），既不改成 0、也不让名册端点跟着失败 —— 两件事的下一步动作不同。
 * 导出是给面板自检用的：自检可以不经过 HTTP 直接调它（也可以像本轮那样经真路由调），
 * 两种走法都是同一条读取与判定路径（与 `readLedger`、`dueReadingOf` 同一理由 ——
 * 自检的期望值不许从实现里抄）。
 */
export async function handleMembers(ctx, req, res, fallback) {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		writeJson(res, 405, { ok: false, error: '成员名册只支持 GET' })
		return
	}
	const opened = await openWorkspaceOf(ctx, req, res, fallback)
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
		// **不再读 `.company-gate.members.json`**（task-40，人的决定）：那一份是旧账（看板/名册归原生之后
		// 再没人写它），面板的「成员」块不该拿它当任何判据 —— 它还在不影响这里的任何读数，只是没人读它。
		// 看板那一份：**只决定「已交付 n/m」那一格能不能给数**，所以它读不到**不让成员端点失败**。
		// 与引擎同一口径：`boardTasks` 传 `undefined` = **看板文件读不到** ⇒ 三数一律 `null`
		// 且引擎自己加一条告警；`[]` 才是"读了、里面没有条目"。在宿主层把读不到改成 `[]`，
		// 就是把"拿不到看板"显示成"零交付" —— 那正是设计 §3.2 点名不许的写法。
		const board = await readRawItems(ctx.fs, root, LEDGERS.board)
		if (!board.ok) {
			console.warn('[dsh-team-ops] 成员端点读不到看板文件，本次「已交付」一格按不给数回答（不是零交付）：', board.error)
		}
		// **成员这一块的主表现在只有一个来源**：本会话的原生 Agent Teams 名册（与 `member_list` 同一处正文）。
		// 旧名册文件（`.company-gate.members.json`）**不再参与**：不读它、不 join 它、不画它的历史编制行。
		const team = teamRosterOf(ctx, requestedSession(req.url))
		// 实时读数叠加（**盘是事实、内存只补活动**，与内置活动面板同一条纪律）：
		//   · `runtime`：活着的 Agent 在跑 ⇒ running，否则按盘上的值；盘上也没有就**不写这个键**
		//     （前端见不到键就一个徽标都不印 —— 读不到不许印成「空闲」）；
		//   · `mailbox_unread`：邮箱文件里的未读条数（判定复用运行时那半边的 `unreadCount`）。
		const runtime = await runtimeReadings(ctx, root, team.rows, board.ok ? board.items : undefined)
		const rows = shapeMemberArray(runtime.rows, MEMBER_ROWS_LIMIT)
		// 下架名单（`.company-gate.roster.json`）：读失败**不让整个成员端点失败** ——
		// 一份文件读不到不该把"现在有哪些人"一起挡掉；那一栏按"一个都没下架"显示并记一条告警。
		let rosterView = { hidden: [], file: join(root, '.company-gate.roster.json') }
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

		const merged = mergedBase.map((row) => ({ ...row, ...verbsOf(row) }))
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
			// 上限 = 与宿主 `maxMembers` 同值（见 `docs/team/verify/编制上限-总人数24.md`）。
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
			warnings: [...runtime.warnings, ...(team.available ? [] : [team.reason]), ...workspaceSourceWarnings(resolved)],
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
function teamCredentialOf(ctx, sessionId, what) {
	const teams = typeof ctx.get === 'function' ? ctx.get('agentTeams') : undefined
	if (teams === undefined || teams === null) return { ok: false, teams: null, lead: null, reason: TEAM_SERVICE_MISSING }
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
const RUNTIME_RUNNING = 'running'
const RUNTIME_INACTIVE = 'inactive'
const RUNTIME_PROVISIONING = 'provisioning'
const RUNTIME_FAILED = 'failed'
const RUNTIME_WORD = { running: '跑着', inactive: '无轮次', provisioning: '创建中', failed: '失败' }

/** 角色来源那一格的中文标签（引擎那张表；缺了按"包内"回落，不编新词）。 */
function row_label_of(key) {
	return ROLE_ORIGIN_FACET_LABEL[key] ?? ROLE_ORIGIN_FACET_LABEL.package
}

/** 这一批被剪掉的角色来自哪个根（全同就点名那个根；两个根都有就说"非包内"）。 */
function pruneRootLabelOf(changed) {
	const sources = [...new Set((Array.isArray(changed) ? changed : []).map((item) => item.source))]
	if (sources.length === 1 && sources[0] === 'workspace') return '**本工作区根**'
	if (sources.length === 1 && sources[0] === 'user') return '**用户根**'
	return '**非包内**'
}

async function skillNamesNow(ctx, sessionId, workspace) {
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

function teamRosterOf(ctx, sessionId) {
	const credential = teamCredentialOf(ctx, sessionId, ' agent 名册')
	if (!credential.ok) return { available: false, reason: credential.reason, rows: [] }
	if (typeof credential.teams.listMembers !== 'function') return { available: false, reason: TEAM_SERVICE_MISSING, rows: [] }
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
		writeJson(res, 200, { ok: true, available: false, reason: TEAM_TASKS_UNSUPPORTED, rows: [], counts: null, warnings: [TEAM_TASKS_UNSUPPORTED] })
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

/** 老版本 Agent Teams（没有 `listTasks`）时那一行措辞（两处共用同一句）。 */
const TEAM_TASKS_UNSUPPORTED =
	'这个部署的 Agent Teams 服务没有 `listTasks`：读不到本会话的团队任务板 —— **读不到不等于"没有任务"**。'

/**
 * 团队任务行里三个数组的**条数上限**（原生对它们没有上限）。
 *
 * **截断必须看得见**（与 `MEMBER_ROWS_LIMIT` 同一条纪律）：行形状由别处的自检逐字钉住，
 * 所以截断的读数**不塞进行里**，而是按行登记在载荷的 `truncations`（`{ id, field, shown, total }`）。
 * 从前这三个数在这里静默砍掉：一条有 20 个依赖的任务只列 16 条，而 `ready` 是原生按**全部**
 * 依赖算的 ⇒ 页面会出现"列出来的依赖都满足，但这条仍是等依赖"这种读不通的话，且找不到原因。
 */
const TEAM_TASK_ARRAY_LIMITS = { blockedBy: 16, writeScopes: 16, writeScopeWarnings: 8 }

/**
 * 一行的**字段级截断读数**（`shown` / `total` 都原样给，绝不静默砍）。
 * @param raw - `listTasks` 给的那一行（未整形）。
 * @param shaped - 同一行整形之后的结果。
 * @returns `{ id, field, shown, total }` 数组；没有截断就是空数组。
 */
function taskTruncationsOf(raw, shaped) {
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
function shapeTeamTask(raw) {
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

/** 团队名册缺席时那一行**唯一的**措辞（面板照印，不另写一份）。 */
const TEAM_SERVICE_MISSING =
	'这个部署没有 Agent Teams 服务（`ctx.agentTeams` 取不到）：读不到本会话的 agent 名册 —— 读不到不等于"会话里没有 agent"。'
	+ '它由 DSH 的一个**可选能力层**提供（`' + TEAM_PROFILE_BUNDLE + '`），面板可以替你打开（就是下面那个按钮 —— '
	+ '和 GUI 里"插件/能力"那个开关是同一件事）。'

/**
 * 团队名册的一行**整形**（只留标量叶子 + 诊断那几条）。
 * @param raw - `listMembers` 给的行。
 * @returns 扁平记录，或 null（非对象）。
 */
function shapeTeamRow(raw) {
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
 * task-40 起**不再 join** 我们的旧名册文件（`.company-gate.members.json`）：那一份早没人写，
 * join 它只会让"这一位在不在册"变成拿旧账当判据（人机器上它是 0 行 ⇒ 所有人都落进"未入册"，语义正好相反）。
 * 现在一名成员就是一行，`kind` 只有 `lead` / `teammate` 两种。
 * @param teamRows - `listMembers` 的行（可为空）。
 * @returns 行数组（`{ key, kind, name, session, runtime, model, provider, context, description, diagnostics }`）。
 */
function mergeRoster(runtimeRows) {
	const merged = []
	for (const live of Array.isArray(runtimeRows) ? runtimeRows : []) {
		// 进来的是**已经叠过实时读数的原生行**（`runtimeReadings` 的产物）：`avatar` / `avatarTone` /
		// `mailbox_unread` 都挂在这一份上 —— 所以这里**不再二次整形**（`shapeTeamRow` 那份固定字段表会
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
			...(live?.mailbox_unread === undefined ? {} : { mailbox_unread: live.mailbox_unread }),
			...(live?.runtime === undefined ? {} : { runtimeLive: live.runtime }),
		})
	}
	return merged
}

/** 取请求里的会话 id（`?session=`）—— 面板把"当前是哪个会话"带上来，团队名册按它拿。 */
function requestedSession(url) {
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
 *   · 未读数是辅料：邮箱文件读不到时**只加一条告警**，名册照常返回（读不到 ≠ 零条未读）。
 *   · 一条都不改引擎的判定：这里不重算 `linked`、不动 `present` —— 那些数仍由 `memberSnapshot` 给。
 * @param ctx - 宿主 ctx（用 `ctx.get('agents')` 取可选服务，不进 `inject`）。
 * @param root - 工作区绝对路径。
 * @param rows - `memberSnapshot` 给的行（原样传入，返回新数组）。
 * @param tasks - 看板条目（用于判邮件的执行代是否已作废）；`undefined` = 看板读不到，此时只按投递状态判未读。
 * @returns `{ rows, warnings }`。
 */
async function runtimeReadings(ctx, root, rows, tasks) {
	const warnings = []
	const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
	const mailbox = await readRawItems(ctx.fs, root, MAILBOX_LEDGER)
	if (!mailbox.ok) {
		warnings.push(`邮箱文件读不到（${mailbox.error}）：本次**不给**未读数 —— 读不到不等于零条未读。`)
	}
	const messages = mailbox.ok ? mailbox.items : undefined
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
		if (messages !== undefined && typeof row?.name === 'string' && row.name !== '') {
			// 判代要喂看板条目：换人接手/重开之后那条消息已经不唤醒任何人，不该继续算成「未读」。
			next.mailbox_unread = unreadCount(inboxOf(messages, row.name), tasks)
		}
		out.push(next)
	}
	return { rows: out, warnings }
}

/**
 * 打开本地目录（Electron 主进程的 `shell.openPath`）。
 *
 * 只开**工作区之内**的目录：这个端点动的是操作系统，不是工作区文件，所以收得比只读端点紧。
 * 取不到 electron（CLI / headless 等形态）时判 409 并说清，让前端退回"只复制路径"。
 */
/**
 * 「技能」块的两条只读端点：清单（`/skills`）与某一条的正文（`/skills/definition`）。
 *
 * 口径三条：
 *   · **不自己扫盘**：技能从哪些根来、同名怎么裁决，全是宿主技能注册表（`ctx.skills`）的事，
 *     本文件只把它的答案整形回传 —— 于是"面板列着的"与"模型能加载的"必然同源。
 *   · **服务不在 = 读不到**（503 + 点名该装哪个包），**不是**"一个技能都没有"：
 *     面板据此只印那一行错误，而不是画一个空目录。
 *   · 项目级技能根**跟工作区走**（`cwd`）：工作区取不到时不硬失败，但要在载荷里说清
 *     "这次是按宿主进程目录解析的"，免得把别人的项目技能看成本会话的。
 * @param ctx - 宿主 ctx（`ctx.get('skills')` 是可选服务：不在 inject 里点名）。
 * @param req - 请求（GET）。
 * @param res - 响应。
 * @param fallback - composition 行配的 workspace。
 */
export async function handleSkills(ctx, req, res, fallback) {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		writeJson(res, 405, { ok: false, error: '技能目录只支持 GET（本栏只读）' })
		return
	}
	const service = skillsServiceOf(ctx)
	if (service === null) {
		writeJson(res, 503, { ok: false, error: SKILLS_SERVICE_MISSING })
		return
	}
	const opened = await openWorkspaceSoftly(ctx, req, res, fallback)
	if (opened === null) return
	const resolved = opened.resolved
	const root = opened.root
	const warnings = opened.warnings
	if (root === null) {
		warnings.push('工作区取不到：本次技能清单按**宿主进程目录**解析项目级技能根（`.dsh/skills` / `.agents/skills`），可能不是你会话的工作区；用户级技能根不受影响。')
	}
	// **读哪一层**：技能目录是 host + 按作用域分层的 —— 本部署里本地技能由**预设那一层**提供
	// （web-app 把宿主那行 `skill-filesystem` 关了），所以要看会话那一层才与模型看到的一致。
	const view = skillScopeOf(ctx, queryValue(req.url, 'session'))
	if (view.layer !== 'session') warnings.push(view.why + '（技能目录是**按会话的作用域**解析的：退层读到的那份可能与你会话里模型看到的不同源。）')
	try {
		const snapshot = await service.snapshot(skillViewOptions(root, view))
		const raw = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.skills) ? snapshot.skills : []
		const rows = []
		for (let i = 0; i < raw.length && rows.length < SKILL_ROWS_LIMIT; i++) {
			const shaped = shapeSkillSummary(raw[i])
			if (shaped !== null) rows.push(shaped)
		}
		// 截断要说出来：不能让人以为目录就这么长。
		if (raw.length > rows.length) warnings.push(`技能目录里共 ${raw.length} 条，这里只回了前 ${rows.length} 条（回传上限 ${SKILL_ROWS_LIMIT}）。`)
		writeJson(res, 200, {
			ok: true,
			workspace: root,
			workspaceSource: resolved.source,
			// **这份清单是从哪一层读到的**：`session` = 与模型同一份；`root-agent` / `global` = 退层读的
			// （面板据此决定空态那句话怎么说 —— 退层空着**不许**说成"一个技能都没有"）。
			layer: view.layer,
			// **本轮扫描是否完成**（宿主注册表自己的 `complete`）：没完成就说"可能还有"，
			// 不把一次没扫完的目录当成最终答案。
			complete: snapshot !== null && typeof snapshot === 'object' && snapshot.complete === true,
			total: raw.length,
			skills: rows,
			// **筛档**：**三个根恒显**（项目级 → 用户级 → 包内，空档也列、`count` 写 0），`other` **只在非空时**出现
			// —— `other` 不是"根"，它是"读到的东西落不进这三个根"那一档，空着就不该占一格。
			//
			// **为什么空档也要列**：① **项目级正是 `skill_define` 缺省写入的位置**，藏起来人就没法从界面上回答
			// "我新建的技能会落到哪"；② 同一页的「角色来源」筛一直是三档恒显（含空档）⇒ 两处口径必须一致；
			// ③ 「全部 (N)」与可见档位的关系要**一眼可核**（空档被藏起来会让人以为"没有项目级这回事"）。
			facets: ['project', 'user', 'package', 'other']
				.map((key) => ({ key, label: SKILL_LEVEL_LABEL[key], count: rows.filter((row) => row.level === key).length }))
				.filter((facet) => facet.key !== 'other' || facet.count > 0),
			// **写哪一级**（新建 / 导入那只浮窗照这份画，缺省 `project`）：标签与路径都从这一处出。
			targets: [
				// 工作区取不到时**不编路径**：给一个如实占位（面板照印；真写的时候那条会自己拒）。
				{ key: 'project', label: '项目级', path: root === null ? '<工作区>/.dsh/skills' : join(root, '.dsh', 'skills'), note: '只这个工作区（**缺省**）' },
				{ key: 'user', label: '用户级', path: skillRootLabel('user'), note: '**跨项目**：所有工作区都看得见（要显式选）' },
			],
			targetDefault: 'project',
			warnings,
		})
	} catch (error) {
		// 注册表自己抛错与"服务不在"分开报：前者是它读不成，后者是这个部署没装。
		writeJson(res, 503, { ok: false, error: '技能目录读不成：' + messageOf(error) })
	}
}

/**
 * 一条技能的**正文**（只读）：按名字现读当前那一份。
 *
 * 「现读」是有意的：技能正文改一个字，下一次打开浮窗就该看到新的 —— 面板不缓存正文，
 * 也不拿清单里的 description 冒充正文。超长会截断，并在 `truncated` 与 `warnings` 里**明说**。
 * @param ctx - 宿主 ctx。
 * @param req - 请求（GET，`?name=` 必填）。
 * @param res - 响应。
 * @param fallback - composition 行配的 workspace。
 */
export async function handleSkillDefinition(ctx, req, res, fallback) {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		writeJson(res, 405, { ok: false, error: '技能正文只支持 GET（本栏只读）' })
		return
	}
	const service = skillsServiceOf(ctx)
	if (service === null) {
		writeJson(res, 503, { ok: false, error: SKILLS_SERVICE_MISSING })
		return
	}
	const name = queryValue(req.url, 'name')
	if (name === '') {
		writeJson(res, 400, { ok: false, error: 'name 必填（技能名，形如 `code-review`）' })
		return
	}
	const opened = await openWorkspaceSoftly(ctx, req, res, fallback)
	if (opened === null) return
	const resolved = opened.resolved
	const root = opened.root
	const warnings = opened.warnings
	if (root === null) {
		warnings.push('工作区取不到：本次按**宿主进程目录**解析项目级技能根，可能不是你会话里的那份技能。')
	}
	// 正文与清单必须落在**同一个视图层**上（否则可能读到另一个同名技能的那一份）。
	const view = skillScopeOf(ctx, queryValue(req.url, 'session'))
	if (view.layer !== 'session') warnings.push(view.why + '（正文是按这一层解析到的；与清单用同一个查询串即可保证两边同一层。）')
	try {
		const definition = await service.get(name, skillViewOptions(root, view))
		if (definition === undefined || definition === null) {
			writeJson(res, 404, { ok: false, error: `技能目录里没有 ${name}：它没被发现（名字拼错？它所在的那个根没被扫到？）。可用名字见技能清单。` })
			return
		}
		const content = typeof definition.content === 'string' ? definition.content : ''
		const truncated = content.length > SKILL_CONTENT_LIMIT
		if (truncated) warnings.push(`这份技能正文共 ${content.length} 字，超过回传上限 ${SKILL_CONTENT_LIMIT}，已截断 —— 完整原文请直接打开那个路径。`)
		const invocation = definition.invocation !== null && typeof definition.invocation === 'object' ? definition.invocation : {}
		writeJson(res, 200, {
			ok: true,
			workspace: root,
			workspaceSource: resolved.source,
			layer: view.layer,
			name: asScalar(definition.name) ?? name,
			description: asScalar(definition.description),
			whenToUse: asScalar(definition.whenToUse),
			source: asScalar(definition.source),
			provider: asScalar(definition.provider),
			path: asScalar(definition.path),
			modelInvocable: invocation.modelInvocable === true,
			userInvocable: invocation.userInvocable === true,
			chars: content.length,
			truncated,
			content: truncated ? content.slice(0, SKILL_CONTENT_LIMIT) : content,
			warnings,
		})
	} catch (error) {
		writeJson(res, 503, { ok: false, error: '技能正文读不成：' + messageOf(error) })
	}
}

/**
 * 技能注册表服务（`ctx.skills`）：这是**可选服务** —— 本部署没装技能支持时取不到。
 * 取不到一律返回 null，由调用方判 503 并点名该装哪个包（**不许**把它当成"技能是空的"）。
 * @param ctx - 宿主 ctx。
 * @returns 注册表服务，或 null。
 */
function skillsServiceOf(ctx) {
	const service = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
	if (service === undefined || service === null) return null
	if (typeof service.snapshot !== 'function' || typeof service.get !== 'function') return null
	return service
}


/** 注册表缺席时那一行**唯一的**措辞（两条端点共用同一句，免得两处各写一份）。 */
const SKILLS_SERVICE_MISSING =
	'这个部署没有技能注册表（`ctx.skills` 取不到）：技能栏读不到目录 —— **读不到不等于"一个技能都没有"**。修法：确认该 profile 里装了 `@deepseek-ai/dsh-skill` 与 `@deepseek-ai/dsh-skill-filesystem`。'

/**
 * 技能清单条目**整形**：只留标量叶子；调用面那两格摊成同级的两个布尔
 * （前端不必再判一遍 `invocation` 的形状；缺那一格按"不可调用"算 —— **读不到不印成可用**）。
 * @param raw - 注册表给的 skill summary。
 * @returns 扁平记录，或 null（非对象）。
 */
/**
 * **技能来源 → 层级**（唯一正文）：面板的筛档、卡上的来源标、写入时那句"写哪一级"都从这一处出，
 * 客户端**不自己判**（这三轮反复栽在"同一处两个说法"上）。
 * 层级：`project`（项目级 `<工作区>/.dsh/skills`）/ `user`（用户级 `~/.dsh/skills`）/ `package`（随包）/ `other`。
 */
const SKILL_LEVEL_LABEL = { project: '项目级', user: '用户级', package: '包内', other: '其他来源' }
function skillLevelOf(source) {
	const value = typeof source === 'string' ? source : ''
	if (value.startsWith('project')) return 'project'
	if (value.startsWith('user')) return 'user'
	if (value === 'bundled' || value.startsWith('package')) return 'package'
	return 'other'
}

function shapeSkillSummary(raw) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
	const invocation = raw.invocation !== null && typeof raw.invocation === 'object' ? raw.invocation : {}
	const source = asScalar(raw.source)
	const level = skillLevelOf(source)
	return {
		name: asScalar(raw.name),
		description: asScalar(raw.description),
		whenToUse: asScalar(raw.whenToUse),
		source,
		// **层级与它的中文标签**（面板筛档与卡上那一枚标都照这两格画，不自己判）
		level,
		levelLabel: SKILL_LEVEL_LABEL[level] ?? level,
		provider: asScalar(raw.provider),
		path: asScalar(raw.path),
		modelInvocable: invocation.modelInvocable === true,
		userInvocable: invocation.userInvocable === true,
	}
}

/**
 * 角色清单（**读**）：当前团队有哪些角色、各自启用与否。
 *
 * 角色的真相源是角色目录（引擎现场枚举），启用状态在当前工作区的 `.company-gate.roles.json`。
 * 这个端点比成员端点简单：**不需要工作区**就能读清单（角色是全局的），但"哪些启用"是**按工作区**的
 * —— 所以工作区取不到时也照答，只是把 `workspaceSource` 与警告一并给出（面板据此说明"读的是哪个团队的开关"）。
 * @param ctx - 宿主 ctx。
 * @param req - 请求（GET）。
 * @param res - 响应。
 * @param fallback - composition 行配的 workspace。
 */
export async function handleRoles(ctx, req, res, fallback) {
	if (req.method !== 'GET') {
		writeJson(res, 405, { ok: false, error: '角色清单只支持 GET' })
		return
	}
	const opened = await openWorkspaceSoftly(ctx, req, res, fallback)
	if (opened === null) return
	const resolved = opened.resolved
	try {
		// 工作区定不下来时用配置值/进程工作区兜底读"停用名单"（读不到就按"一个都没停用"，
		// 并在 warnings 里如实说 —— 不假装这是某个团队的开关）。
		const exec = resolved.root === null ? { workspace: fallback ?? undefined } : { workspace: resolved.root }
		const view = await rolesViewOf(ctx, exec)
		const warnings = workspaceSourceWarnings(resolved)
		writeJson(res, 200, {
			ok: true,
			workspace: resolved.root,
			workspaceSource: resolved.source,
			counts: { all: view.roles.length, enabled: view.roles.filter((role) => role.enabled).length, disabled: view.disabled.length },
			roles: view.roles,
			references: view.reference,
			staleDisabled: view.staleDisabled,
			roots: view.roots,
			file: view.file,
			warnings,
		})
	} catch (error) {
		writeJson(res, 503, { ok: false, error: messageOf(error) })
	}
}

/**
 * 一个角色的技能原文（**读**）：面板的「查看 / 复制」用它。
 *
 * 只从现场名册那两条根里读（引擎的 `roleDefinitionTextOf` 里面判），**不接受任意路径** ——
 * 于是这个端点不可能被用来读工作区之外的任何文件。
 * @param ctx - 宿主 ctx。
 * @param req - 请求（GET，`?role=<id>`）。
 * @param res - 响应。
 * @param fallback - composition 行配的 workspace。
 */
export async function handleRoleDefinition(ctx, req, res, fallback) {
	if (req.method !== 'GET') {
		writeJson(res, 405, { ok: false, error: '角色技能原文只支持 GET' })
		return
	}
	const wanted = queryValue(req.url, 'role')
	if (wanted === '') {
		writeJson(res, 400, { ok: false, error: 'role 必填：要看哪个角色的技能原文' })
		return
	}
	try {
		writeJson(res, 200, { ok: true, ...roleDefinitionTextOf(ctx, { workspace: typeof fallback === 'string' ? fallback : undefined }, wanted) })
	} catch (error) {
		writeJson(res, 404, { ok: false, error: messageOf(error) })
	}
}

/**
 * 一个角色的自定义头像文件（**读**）：角色目录里的 `avatar.svg|png|webp|jpg|jpeg`。
 *
 * 只认现场名册里那条记录所在目录下的那五个文件名（`roleRecords` 已经把命中文件名记下了），
 * 路径不由请求拼出来 —— 请求里只有角色 id。读不到就 404（面板退回 emoji 圆底，不报错）。
 * @param ctx - 宿主 ctx。
 * @param req - 请求（GET，`?role=<id>`）。
 * @param res - 响应。
 */
export async function handleRoleAvatar(ctx, req, res) {
	if (req.method !== 'GET') {
		writeJson(res, 405, { ok: false, error: '头像只支持 GET' })
		return
	}
	const wanted = queryValue(req.url, 'role')
	if (wanted === '') {
		writeJson(res, 400, { ok: false, error: 'role 必填' })
		return
	}
	try {
		const record = roleRecords().find((item) => item.id === wanted && item.avatarFile !== null)
		if (record === undefined) {
			writeJson(res, 404, { ok: false, error: `角色 ${wanted} 没有自定义头像文件（角色目录里放 avatar.png/svg/webp/jpg 即可）` })
			return
		}
		const file = join(record.dir, record.avatarFile)
		// 路径**不是**从请求拼出来的：请求里只有角色 id，文件名来自引擎那次的现场枚举。
		// 读文件用 `node:fs`（不经 `ctx.fs` 的读契约）：读的是本插件自己的用户根/包内技能目录。
		const info = statSync(file)
		if (!info.isFile()) {
			writeJson(res, 404, { ok: false, error: '头像文件读不到' })
			return
		}
		if (info.size > AVATAR_SIZE_LIMIT) {
			writeJson(res, 413, { ok: false, error: `头像文件超过 ${Math.round(AVATAR_SIZE_LIMIT / 1024)} KB，请压一下` })
			return
		}
		const bytes = readFileSync(file)
		res.writeHead(200, { 'content-type': AVATAR_TYPES[record.avatarFile.split('.').pop().toLowerCase()] ?? 'application/octet-stream', 'content-length': String(bytes.length), 'cache-control': 'no-store' })
		res.end(bytes)
	} catch (error) {
		writeJson(res, 404, { ok: false, error: messageOf(error) })
	}
}

/**
 * 开 / 关一个角色（**写**）：`POST { role, enabled }`。语义全在引擎那份 `setRoleEnabled` 里
 * （停用 = 不能派新成员 + 不参与自动续领；已在场的成员不受影响）。
 * @param ctx - 宿主 ctx。
 * @param req - 请求（POST，JSON 体 `{ role, enabled }`）。
 * @param res - 响应。
 * @param fallback - composition 行配的 workspace。
 */
export async function handleRoleToggle(ctx, req, res, fallback) {
	if (req.method !== 'POST') {
		writeJson(res, 405, { ok: false, error: '角色开关只支持 POST' })
		return
	}
	const opened = await openWorkspaceOf(ctx, req, res, fallback, { writable: true })
	if (opened === null) return
	const resolved = opened.resolved
	let body
	try {
		body = JSON.parse(await readBody(req, DECIDE_BODY_LIMIT))
	} catch (error) {
		bodyError(res, error, DECIDE_BODY_LIMIT)
		return
	}
	try {
		const done = await setRoleEnabled(ctx, { workspace: resolved.root, sandboxPolicy: policyForWorkspace(ctx, resolved.root) }, { role: body?.role, enabled: body?.enabled === true })
		writeJson(res, 200, { ok: true, workspace: resolved.root, workspaceSource: resolved.source, ...done, actor: 'human' })
	} catch (error) {
		writeJson(res, 409, { ok: false, error: messageOf(error) })
	}
}

/**
 * 「复制为自定义」（**写**）：把包内角色复制进**角色根**（缺省本工作区；`scope: "user"` 才是用户级角色根），供人自由改。
 *
 * 这一步写的是本插件自己的**角色根**（缺省 `<工作区>/.dsh/team-ops/roles/<id>/ROLE.md`，`scope: "user"` 才是 `~/.dsh/team-ops/roles/`），
 * 不是工作区文件 —— 所以它不走 `gate-write.js`，而是直接转发引擎那份 `customizeRole`（判定仍在引擎里：
 * id 形状、重名往后加序号、不覆盖任何既有目录）。回执里那对字段（`promptRoster: 'stale'` +
 * `promptRosterNote`）要按事实读：**工具面立刻可用**（`member_defaults` / `member_spawn` 现枚举），
 * 旧了的只是**注入到系统提示里那份「可叫的队友」清单**这颗快照。
 * @param ctx - 宿主 ctx。
 * @param req - 请求（POST，JSON 体 `{ role, id? }`）。
 * @param res - 响应。
 * @param fallback - composition 行配的 workspace。
 */
export async function handleRoleCustomize(ctx, req, res, fallback) {
	if (req.method !== 'POST') {
		writeJson(res, 405, { ok: false, error: '复制为自定义只支持 POST' })
		return
	}
	let body
	try {
		body = JSON.parse(await readBody(req, DECIDE_BODY_LIMIT))
	} catch (error) {
		bodyError(res, error, DECIDE_BODY_LIMIT)
		return
	}
	// 工作区**按请求给**（与其余角色端点同一条：`?workspace=` 优先、其次 composition 行的 fallback）——
	// 作用域缺省就是"本工作区"，解析不到工作区时那一支会如实拒绝（而不是悄悄落到 `process.cwd()`）。
	const opened = await openWorkspaceOf(ctx, req, res, fallback)
	if (opened === null) return
	try {
		const done = customizeRole(
			ctx,
			{ workspace: opened.root },
			// 复制为自定义也认作用域（缺省工作区根）：不给人留一条"只能往全局塞"的路。
			{ role: body?.role, id: body?.id, ...(Object.hasOwn(body ?? {}, 'scope') ? { scope: body.scope } : {}) },
		)
		writeJson(res, 200, { ok: true, ...done, actor: 'human' })
	} catch (error) {
		writeJson(res, 409, { ok: false, error: messageOf(error) })
	}
}

/**
 * 面板那两个成员写动作（编辑 / 删除）：**这是拒绝面，不是写面** —— 它一处文件都不写。
 *
 * 成员面已经整面撤掉：成员是 DSH 原生 Agent Teams 的队友，而原生名册只有"成员在不在"与 `failed`
 * 两种事实（`TeamService` 只给 spawnTeammate / sendMessage / 任务那一组），没有"改提示词 /
 * 删成员"这两种动作。所以两条路由**保留**下来只做一件事：对旧客户端、对直接 POST 的人，
 * 如实拒绝并指路（"不用的队友不再派活即可；要打断当前那一轮用内置 `interrupt_agent`"）。
 *
 * 保留而不删路由的理由：**回执比 404 有用**。删掉路由，人拿到的是一句"没有这个端点"，
 * 既不知道能力搬去哪了，也分不出"我拼错了"与"这个功能没了"。
 *
 * 仍然只接受 POST（与其余写端点同一条纪律：改状态的动作不接受 GET —— 免得被预取或图片标签
 * 顺手触发）；参数 `ctx` / `req` / `fallback` 保留，因为路由那张表按同一个签名转发。
 * @param ctx - 宿主 ctx（本函数不读，保留签名）。
 * @param req - 请求（POST，JSON 体）。
 * @param res - 响应。
 * @param fallback - composition 行配的 workspace（可为 null）。
 * @param action - `update` 改记录 / `delete` 删记录。
 */
export async function handleMemberWrite(ctx, req, res, fallback, action) {
	// **四个动词分两类**（这一处是唯一正文）：
	//   · `disable` / `restore`：本插件这一层的**视图状态**（`.company-gate.member-flags.json`），
	//     走引擎的 `setMemberDisabled`（账本管道 + "同角色至少留 1 位"那道判定都在引擎里）；
	//   · `interrupt`：原生 `interrupt`，**只断当前那一轮**（收件箱保留、名册与两条上限不变）；
	//   · `update` / `delete`（老客户端的路由）：**如实拒绝并指路** —— 原生名册确实没有"改记录 / 删成员"，
	//     但这几句必须把**现在真能做的三个动词**说清楚，不能留一句和现实打架的话。
	if (req.method !== 'POST') {
		writeJson(res, 405, { ok: false, error: '这个动作只支持 POST' })
		return
	}
	if (action !== 'disable' && action !== 'restore' && action !== 'interrupt') {
		writeJson(res, 200, {
			ok: false,
			error:
				`本插件不能${action === 'delete' ? '删除成员' : '改成员记录'}：成员就是 DSH 原生 Agent Teams 的队友，原生名册没有这几种动作。` +
				'现在能做的三个动词是：**停用**（不再派活、**不占角色槽位**，可恢复）、**恢复**、**打断当前那一轮** —— ' +
				`面板「成员」每张卡上就有；直接调是 POST \`${MEMBER_DISABLE_PATH}\` / \`${MEMBER_RESTORE_PATH}\` / \`${MEMBER_INTERRUPT_PATH}\`。`,
		})
		return
	}
	let body
	try {
		body = JSON.parse(await readBody(req, DECIDE_BODY_LIMIT))
	} catch (error) {
		bodyError(res, error, DECIDE_BODY_LIMIT)
		return
	}
	const name = typeof body?.name === 'string' ? body.name.trim() : ''
	if (name === '') {
		writeJson(res, 400, { ok: false, error: 'name 必填：要点名是哪一位成员。' })
		return
	}
	const opened = await openWorkspaceOf(ctx, req, res, fallback, { writable: action !== 'interrupt' })
	if (opened === null) return
	const resolved = opened.resolved
	if (action === 'interrupt') {
		const credential = teamCredentialOf(ctx, requestedSession(req.url), ' 打断')
		if (!credential.ok) {
			writeJson(res, 503, { ok: false, error: credential.reason })
			return
		}
		if (typeof credential.teams.interrupt !== 'function') {
			writeJson(res, 503, { ok: false, error: '这个部署的原生团队服务没有 `interrupt`（打断）这一档。' })
			return
		}
		try {
			const done = credential.teams.interrupt(credential.lead, name)
			writeJson(res, 200, {
				ok: true,
				workspace: resolved.root,
				workspaceSource: resolved.source,
				name,
				previousStatus: done?.previousStatus ?? 'unknown',
				// **只断当前那一轮**：这三句要在回执里说全（收件箱 / 名册 / 两条上限都不动）。
				note: '只打断了它**当前那一轮**：收件箱里的消息保留、**原生名册行**与两条上限（角色槽位 ≤3、在场总人数 ≤24，含停用者与 `failed`）都不变 —— 下次 `member_send` 唤醒它照旧接着干。',
				actor: 'human',
			})
		} catch (error) {
			writeJson(res, 409, { ok: false, error: messageOf(error) })
		}
		return
	}
	// **凭据必须在这里解析**（与 `interrupt` 用同一个 `teamCredentialOf`，不另写判定）：
	// 这条端点路上没有 `exec.agent`（引擎那条路的 `exec` 来自会话工具调用），而原生 `listMembers`
	// 要的是"确切的活着的 Lead Agent" ⇒ 宿主解析好放进 `exec.lead` 再交给引擎。
	const credential = teamCredentialOf(ctx, requestedSession(req.url), ' 停用/恢复')
	if (!credential.ok) {
		writeJson(res, 503, { ok: false, error: credential.reason })
		return
	}
	try {
		const done = await setMemberDisabled(ctx, { workspace: resolved.root, sandboxPolicy: policyForWorkspace(ctx, resolved.root), lead: credential.lead }, { name, disabled: action === 'disable' })
		writeJson(res, 200, {
			ok: true,
			workspace: resolved.root,
			workspaceSource: resolved.source,
			...done,
			// **如实说**：停用是本插件这一层的视图状态，原生名册里那个人**仍然在**。
			note: done.disabled
				? '已标成**停用**（本插件的视图状态）：**本插件不再派活给它**（不占角色槽位、不被自动复用、`member_send` 会拒）；**它在宿主原生界面里仍然可以打开对话** —— 「停用」只在本插件的调度层生效，宿主没有移除 / 停用成员的接口。随时可以恢复。'
				: '已**恢复**：重新占这一档的角色槽位、也能重新接活（恢复不设任何上限）。',
			actor: 'human',
		})
	} catch (error) {
		writeJson(res, 409, { ok: false, error: messageOf(error) })
	}
}

/**
 * 「角色」那三条写路径的实现：翻译请求体 → 转发引擎 → 原样转达结论。
 *
 * 字段白名单（与成员那两条同一条纪律：只点名接受那几个字段，其余一概不看）：
 *   · `update`（添加 / 修改）：`role` 缺 = **添加**（`id` / `title` / `category` / `positioning` /
 *     `body`）；给了 `role` = **修改**（`title` / `category` / `positioning`，至少一格）；
 *   · `remove`：`role`（要删/要下架哪一个）；
 *   · `restore`：`role`（把下架的恢复上架）。
 * @param ctx - 宿主上下文。
 * @param req - 请求。
 * @param res - 响应。
 * @param fallback - 请求未带 workspace 时用的 composition 行配置值。
 * @param action - `'update' | 'remove' | 'restore'`。
 */
/**
 * 技能的三个写动作（人在面板上点的那一下）：
 *   · `import`：`root`（`user` / `project`，缺省 `user`）+ **两种输入形状之一**：
 *     `source`（本机路径：一个含 `SKILL.md` 的目录，或一个 `.md` 文件；相对路径按当前工作区解析）
 *     或 `files`（`[{path, dataBase64}]`：浏览器拖进来/选中的那批文件，面板的拖拽区走这条）⇒ 写进那个根；
 *   · `create`：`root` + `name` + `description` + `body` ⇒ 新建 `<root>/<name>/SKILL.md`；
 *   · `remove`：`root` + `name` ⇒ 删掉 `<root>/<name>` 那一棵目录。
 *
 * **只增不改**：目标已存在一律拒绝（不覆盖别人的东西）。判定与 fs 都在 `lib/skill-write.js`
 * （唯一实现）—— 本函数只做"取参数、转发、把结论原样回显"。
 * `project` 根需要工作区；`user` 根不需要（所以缺工作区只在 project 那一支报错）。
 * @param req - 请求。
 * @param res - 响应。
 * @param fallback - 请求未带 workspace 时用的 composition 行配置值。
 * @param action - `'import' | 'create' | 'remove'`。
 */
export async function handleSkillWrite(ctx, req, res, fallback, action) {
	if (req.method !== 'POST') {
		writeJson(res, 405, { ok: false, error: `技能写入口只支持 POST（${action}）` })
		return
	}
	let body
	try {
		body = JSON.parse(await readBody(req, SKILL_IMPORT_BODY_LIMIT))
	} catch (error) {
		bodyError(res, error, SKILL_IMPORT_BODY_LIMIT)
		return
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		writeJson(res, 400, { ok: false, error: '请求体必须是一个对象' })
		return
	}
	const root = typeof body.root === 'string' && body.root.trim() !== '' ? body.root.trim() : 'user'
	if (root !== 'user' && root !== 'project') {
		writeJson(res, 400, { ok: false, error: `root 只支持 user / project（收到 ${root}）；随包发布的技能与别的 agent 的根只读` })
		return
	}
	// `project` 根要工作区：请求带的优先，其次 composition 行的配置值。
	let workspace = null
	if (root === 'project') {
		const opened = await openWorkspaceOf(ctx, req, res, fallback, {
			writable: true,
			missing: '项目级技能根要工作区：请求里带 ?workspace=<绝对路径>，或在 composition 行里配 workspace。',
		})
		if (opened === null) return
		workspace = opened.root
	}
	const outcome =
		action === 'import'
			? // 两条输入形状（同一套判定与落盘）：`source` = 本机路径（宿主侧复制），
				// `files` = 浏览器拖进来/选中的那批文件（`{path, dataBase64}`，面板的拖拽区走这条）。
				Array.isArray(body.files)
				? importSkillFiles({ kind: root, workspace, name: typeof body.name === 'string' ? body.name : '', files: body.files })
				: importSkill({ kind: root, workspace, source: typeof body.source === 'string' ? body.source : '' })
			: action === 'create'
				? createSkill({ kind: root, workspace, name: typeof body.name === 'string' ? body.name : '', description: typeof body.description === 'string' ? body.description : '', body: typeof body.body === 'string' ? body.body : '' })
				: removeSkill({ kind: root, workspace, name: typeof body.name === 'string' ? body.name : '' })
	if (outcome.ok !== true) {
		writeJson(res, 400, { ok: false, error: outcome.reason })
		return
	}
	// **删技能时同步剪角色那一行**（HD-007 的第二件）：只在**人主动删掉一个技能**这个动作之后做，
	// 且**只按这个名字**剪 —— 绝不按"本会话目录里没有"来删（技能目录按会话变，那样会剪掉别的会话里还有用的声明）。
	let skillPrune = null
	if (action === 'remove') {
		try {
			const pruned = await pruneSkillFromRoles(ctx, { workspace }, typeof body.name === 'string' ? body.name : '')
			skillPrune = {
				changed: pruned.changed,
				packageRoles: pruned.packageRoles,
				scanned: pruned.scanned,
				// 一句给人看的话：**改了哪几个、还有哪几个包内的仍声明它**（不许只回一句"已同步"）。
				note:
					pruned.changed.length === 0 && pruned.packageRoles.length === 0
						? '没有角色声明这个技能：一个文件都没动。'
						: [
								// **按真实来源说是哪个根**（工作区根 / 用户根）—— 从前这里把两种一律叫"用户根"，
								// 现场报错过一次：工作区根里的角色被说成了用户根（改动逻辑没变，只是标签错了）。
								pruned.changed.length === 0
									? '工作区根与用户根里都没有角色声明它（没改任何文件）'
									: `已从这些${pruneRootLabelOf(pruned.changed)}角色里剪掉：${pruned.changed.map((item) => `${item.role}（${item.source === 'workspace' ? '本工作区根' : '用户根'}）`).join('、')}`,
								pruned.packageRoles.length === 0
									? '包内角色里也没有人声明它'
									: `**包内角色仍声明它**（包内只读、不改发布面）：${pruned.packageRoles.map((item) => item.role).join('、')} —— 想连它们一起去掉，就在面板上「改」一份到用户根再删那一行`,
							].join('；'),
			}
		} catch (error) {
			// 剪不动不该把"技能已经删掉了"说成失败：如实附一条说明。
			skillPrune = { changed: [], packageRoles: [], scanned: 0, error: messageOf(error) }
		}
	}
	writeJson(res, 200, {
		ok: true,
		action,
		id: outcome.id,
		root: outcome.root,
		path: outcome.path,
		rootLabel: skillRootLabel(root),
		...(skillPrune === null ? {} : { skillPrune }),
	})
}

export async function handleRoleWrite(ctx, req, res, fallback, action) {
	if (req.method !== 'POST') {
		writeJson(res, 405, { ok: false, error: `角色增删改只支持 POST（${action}）` })
		return
	}
	const opened = await openWorkspaceOf(ctx, req, res, fallback, { writable: true })
	if (opened === null) return
	const root = opened.root
	const resolved = opened.resolved
	let body
	try {
		body = JSON.parse(await readBody(req, MEMBER_BODY_LIMIT))
	} catch (error) {
		bodyError(res, error, MEMBER_BODY_LIMIT)
		return
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		writeJson(res, 400, { ok: false, error: '请求体必须是一个对象' })
		return
	}
	const role = typeof body.role === 'string' ? body.role.trim() : ''
	if (action === 'update' && role === '' && (typeof body.id !== 'string' || body.id.trim() === '')) {
		writeJson(res, 400, { ok: false, error: '添加角色要 id（lower-kebab-case）；改一个已有角色要 role。' })
		return
	}
	if (action !== 'update' && role === '') {
		writeJson(res, 400, { ok: false, error: 'role 必填：要点名删/恢复哪一个角色' })
		return
	}
	try {
		const result =
			action === 'remove'
				? await removeRoleInWorkspace(ctx, root, { role })
				: action === 'restore'
					? await restoreRoleInWorkspace(ctx, root, { role })
					: role === ''
						? createRoleInWorkspace(ctx, root, {
								id: body.id,
								// **作用域**（HD-008）：缺省工作区根；`user` 必须显式给（引擎里那些判定与措辞都在一处）。
								...(Object.hasOwn(body, 'scope') ? { scope: body.scope } : {}),
								...(Object.hasOwn(body, 'title') ? { title: body.title } : {}),
								...(Object.hasOwn(body, 'category') ? { category: body.category } : {}),
								positioning: body.positioning,
								...(Object.hasOwn(body, 'body') ? { body: body.body } : {}),
								// **专属技能**（可选，逗号分隔）：给了就写进 `skills:` 那一行；空串表示"没有专属技能"。
								...(Object.hasOwn(body, 'skills') ? { skills: body.skills } : {}),
							})
						: await editRoleInWorkspace(ctx, root, {
								role,
								...(Object.hasOwn(body, 'scope') ? { scope: body.scope } : {}),
								...(Object.hasOwn(body, 'title') ? { title: body.title } : {}),
								...(Object.hasOwn(body, 'category') ? { category: body.category } : {}),
								...(Object.hasOwn(body, 'positioning') ? { positioning: body.positioning } : {}),
								...(Object.hasOwn(body, 'skills') ? { skills: body.skills } : {}),
							})
		writeJson(res, 200, { ok: true, workspace: root, workspaceSource: resolved.source, action, ...result })
	} catch (error) {
		// 引擎的拒绝（id 形状不对 / 同名已存在 / 要改的角色不在名册里 / 改的那一格全空）是
		// **调用方能改的错**，原样回 409 并把引擎给的说明带给操作者。
		writeJson(res, 409, { ok: false, error: messageOf(error) })
	}
}

/**
 * 一个平台"打开目录"的命令规格（**纯函数**，自检直接测它）。
 *
 * 为什么用平台命令而不是 Electron 的 `shell`：**DSH 自己就是这么开的** ——
 * `@deepseek-ai/dsh-native-command` 在 macOS 走 `open`、Linux 走 `xdg-open`、
 * Windows 交给 Explorer（它自己的注释写了理由：Windows 那边只有 Explorer 的双击
 * 关联解析是可靠的）。而宿主半边是 profile 平面上的普通 Node 模块，
 * `import('electron')` 在这里取不到 —— 现场实测就是 409「取不到 Electron 的 shell」。
 * @param target - 要打开的绝对路径（目录）。
 * @param platform - `process.platform`；测试用参数。
 * @returns `{ command, args }`。
 */
export function nativeOpenSpec(target, platform = process.platform) {
	if (platform === 'darwin') return { command: 'open', args: [target] }
	if (platform === 'win32') return { command: 'explorer.exe', args: [target] }
	return { command: 'xdg-open', args: [target] }
}

/**
 * 打开一个本地目录：**官方接缝优先 → 平台命令兜底 → Electron 殿后**，三级都失败才报错。
 *
 * 三级各自留下失败原因、一起写进回执：现场看到的是"哪几条都试过、各为什么不行"，
 * 而不是一句"打不开"。spawn 走 detached + unref —— 打开这个动作是**交给系统**的，
 * 本进程不等它、也不因它退出而受影响。
 * @param ctx - 宿主 ctx（`sessionController` 走 `ctx.get`，不进 `inject`）。
 * @param target - 已校验过（在工作区内、存在且是目录）的绝对路径。
 * @returns `{ ok: true, via }` 或 `{ ok: false, failures }`。
 */
async function openDirectory(ctx, target) {
	const failures = []
	// ① DSH 自己的宿主服务（存在就用它）：`@deepseek-ai/dsh-api-session-controller` 的 openPath，
	//    它内部已经处理了平台差异与 WSL 的路径翻译。
	try {
		const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
		if (controller !== undefined && typeof controller.openPath === 'function') {
			await controller.openPath(target)
			return { ok: true, via: 'sessionController.openPath' }
		}
	} catch (error) {
		failures.push(`sessionController.openPath 失败：${messageOf(error)}`)
	}
	// ② 平台命令（与 DSH 自己那条路一致）。
	const spec = nativeOpenSpec(target)
	try {
		await new Promise((resolve, reject) => {
			const child = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore' })
			child.once('error', reject)
			child.once('spawn', () => {
				child.unref()
				resolve(undefined)
			})
		})
		return { ok: true, via: spec.command }
	} catch (error) {
		failures.push(`${spec.command} 失败：${messageOf(error)}`)
	}
	// ③ Electron 的 shell（某些形态下这条路通；失败只记一行，不声张）。
	try {
		const electron = await import('electron')
		const shell = electron.shell ?? (electron.default === undefined ? undefined : electron.default.shell)
		if (shell !== undefined && typeof shell.openPath === 'function') {
			const failure = await shell.openPath(target)
			if (typeof failure !== 'string' || failure === '') return { ok: true, via: 'electron.shell.openPath' }
			failures.push(`electron.shell.openPath 失败：${failure}`)
		} else {
			failures.push('electron.shell.openPath 不可用（这个运行形态取不到 Electron 的 shell）')
		}
	} catch (error) {
		failures.push(`electron 取不到：${messageOf(error)}`)
	}
	return { ok: false, failures }
}

export async function handleOpen(ctx, req, res, fallback) {
	if (req.method !== 'POST') {
		writeJson(res, 405, { ok: false, error: '打开目录只支持 POST' })
		return
	}
	const opened = await openWorkspaceOf(ctx, req, res, fallback)
	if (opened === null) return
	const root = opened.root
	const resolved = opened.resolved
	let body
	try {
		body = JSON.parse(await readBody(req, DECIDE_BODY_LIMIT))
	} catch (error) {
		bodyError(res, error, DECIDE_BODY_LIMIT)
		return
	}
	const target = body === null || typeof body !== 'object' || typeof body.path !== 'string' ? '' : body.path.trim()
	if (target === '' || target.indexOf('\0') !== -1 || !target.startsWith('/')) {
		writeJson(res, 400, { ok: false, error: 'path 必须是绝对路径' })
		return
	}
	// 只开工作区之内的目录：等于根，或在 `根/` 之下。越界一律拒（不做"猜你要开哪个"）。
	if (target !== root && !target.startsWith(root.endsWith('/') ? root : root + '/')) {
		writeJson(res, 403, { ok: false, error: '只能打开当前工作区之内的目录' })
		return
	}
	try {
		const info = await ctx.fs.stat(await ctx.fs.resolve(target))
		if (info === undefined) {
			writeJson(res, 404, { ok: false, error: '目录不存在：' + target })
			return
		}
		if (info.type !== 'directory') {
			writeJson(res, 400, { ok: false, error: '不是目录：' + target })
			return
		}
		const opened = await openDirectory(ctx, target)
		if (!opened.ok) {
			writeJson(res, 409, { ok: false, error: `主进程没能打开这个目录：${opened.failures.join('；')}。请改用复制路径。` })
			return
		}
		writeJson(res, 200, { ok: true, path: target, via: opened.via })
	} catch (error) {
		console.error('[dsh-team-ops] 打开目录异常:', error)
		writeJson(res, 500, { ok: false, error: '内部错误' })
	}
}

