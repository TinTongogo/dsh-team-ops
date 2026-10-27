/**
 * 一人公司团队 —— **制度层**（文件事务 + 任务看板 + 人的话 + 产物校验 + 状态行）。
 *
 * 与 `team-runtime.js` 的分工（两者都由预设 `agent.cordis.yml` 装载，兄弟行、同一预设作用域）：
 *   · 本文件 = **公司制度**：四份文件的读改写事务、任务看板（含 CAS 版本号与执行代能力凭据）、
 *     人的话、产物校验、状态行。**没有任何宿主能力依赖**（只 inject `fs` + `tools`），
 *     因此它就是「同一份文件」的**唯一写入口**。
 *   · `team-runtime.js` = **运行时**：成员面那一层（DSH 原生 Agent Teams 的薄层：叫人 / 发消息 / 等变化）
 *     与制度工具的装配。它 **import 本文件**再往下写，于是两个插件共用同一份 `fileQueues`
 *     （同一文件串行）—— 一个文件只有一个写队列。
 *
 * 装载形状由预设 `agent.cordis.yml` 的一行 `name: './company-gate.js'` 决定：本文件是预设目录里的
 * 相对说明符，因此自包含 —— 只依赖 Node 内建与 `ctx` 提供的服务，不 import 任何包。
 *
 * 对外契约（工具名与命令名逐字固定）：
 *   human_words_record / human_words_list
 *   member_defaults / member_spawn / member_send / member_list / member_wait / role_manage
 *                                       （成员面：全部在 team-runtime.js，走 DSH 原生 Agent Teams）
 *   board_task
 *   check_artifact
 *   team_status
 *   人的决定在文件前端页（lib/board-view.*）；本模块只发工具。
 *
 * **为什么人的话单独一份文件**：其余对象都是 AI 产的（任务、产物），人的贡献只以散落的对话存在，
 * 下一个会话的 AI 读不到；而人最贵的产出就是他的判断。
 * 它**按需建立**：没有记过任何一条时文件根本不存在 —— 这是正常状态，不是「读不到」。
 *
 * 边界：只写工作区内的那三份状态文件及其同目录临时文件；不删文件、不移动工作区文件（唯一的改名是
 * 自身临时文件发布为文件）、不写工作区外任何路径、不读用户技能根、不判断加载器行为、不做清退归档。
 * 跨进程并发只由递交前重读比对事后收窄：比对与改名之间仍有 TOCTOU 窗口，静默丢更新无法消除，
 * 本引擎不引入分布式锁，也不自动合并他方写入，只检出并告警。
 *
 * 状态文件（工作区根下的点文件，**本插件会写的只有三份**）：
 *   `.company-gate.human.json`      **人的话**（一等对象）
 *   `.company-gate.roles.json`      角色启用开关（按工作区一份）
 *   `.company-gate.roster.json`     角色下架名单（面板"删除只在包内的角色"）
 *
 * **看板 / 名册 / 邮箱三份不在这一层**：任务与成员归 DSH 原生 Agent Teams（`ctx.agentTeams`），
 * 工作区里同名的 `.company-gate.board.json` / `.members.json` / `.mailbox.json` 是历史遗留文件，
 * 本插件没有写者（`lib/ledger-digest.js` 那条摘要 hook 只读它们，给一句"这是历史账"）。
 *
 * 读写纪律（每个写 action 都遵守，实现见 `readLedger` / `commitLedger` / `transact`）：
 *   · 同一文件的读-改-写经文件队列串行；只读 action 不入队，入队会让它等自己的队尾而自锁。
 *   · 写 action 内不再调用同一文件的写 action——非重入。
 *   · 只有结构化「未找到」信号算空状态；其余读取异常一律中止本次写，绝不降级成空文件。
 *   · 冲突抛出点落在真正写盘之前，因此事务边界重跑幂等安全，重跑上限见 `MAX_CAS_ATTEMPTS`。
 *   · 没写进文件就不返回 ok：失败一律 `{ ok: false, error }`，不向调用方抛异常。
 */

import { randomUUID } from 'node:crypto'
import { rename as renamePath } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname as dirNameOf, isAbsolute as isAbsolutePath, join as joinPath } from 'node:path'

/** 幂等闸：**同一个 ctx 只挂一次**（`WeakSet`；见 `apply` 顶部）。 */
const gateMounted = new WeakSet()

export const inject = ['fs', 'tools']

/** 文件覆盖的顶层数据版本，供未来读取方分流。 */
const LEDGER_VERSION = 1

/**
 * **本插件会写的**状态文件名，相对于工作区根（三份，各有唯一的写入口）。
 *
 * 看板 / 名册 / 邮箱三份**已经不在这一层**：任务与成员归 DSH 原生 Agent Teams，
 * 工作区里那几个同名的 `.company-gate.board.json` / `.members.json` / `.mailbox.json`
 * 是**历史遗留文件**（本插件没有写者，`lib/ledger-digest.js` 那条摘要 hook 只读它们给历史账），
 * 所以这里连名字都不再登记 —— 一张写盘清单里不该有写不到的东西。
 */
const LEDGER_FILE = {
	human: '.company-gate.human.json',
	// 角色清单的**启用开关**（按工作区一份 = "当前团队"）：只记"关掉了哪些"，
	// 缺省全部启用 —— 于是新加的角色天生可用，不需要任何文件同步（见 team-runtime 的 role_manage）。
	roles: '.company-gate.roles.json',
	// 默认队友清单的**下架名单**（面板「角色」上"删除"一个只在包内的角色时落这里）：
	// 与 `.company-gate.roles.json` 同一条取向 —— 只记"下架了哪些"，缺省全在架上。
	roster: '.company-gate.roster.json',
	// **成员的停用名单**（HD-006）：原生名册没有"停用/移除"接口，所以"停用"是本插件这一层的视图状态。
	// 写法与 `roles` 那份同一条路（引擎 `transact`/`commitLedger`，读侧见 `lib/member-flags.js`）。
	memberFlags: '.company-gate.member-flags.json',
	// **交接快照**：原生看板按会话（`TeamId = SessionId`），新会话从零开始 —— 这一份是**派生物**，
	// 让"上下文到极限、新开一个会话"之后还看得见上一本账该接着干什么。它**不是**第二本账、
	// **不是**实时看板（活着的那本在原生队伍日志里，读数以 `team_status` 为准）。
	handoff: '.company-gate.handoff.json',
}

/** 序号前缀：本插件还在发的编号空间（看板 / 成员那两套随账本一起归原生）。 */
const ID_PREFIX = {
	human: 'HD',
}

/** 序号补齐到三位：人的话 HD-<三位序号>（本插件还在发的只剩这一族）。 */
const ID_DIGITS = 3

// 看板五档的顺序与名字、默认档、收口档、状态行顺序：**唯一正文在 `lib/board-status.js`**
// （原先这四个地方各写一遍、其中两处顺序还不同 —— 同一个会话里工具回执的状态行与每轮注入的状态行对不上）。
import {
	BOARD_DEFAULT_STATUS,
	BOARD_DONE_STATUS,
	BOARD_REJECTED_STATUS,
	BOARD_STATUSES,
	STATUS_LINE_ORDER,
	isBoardStatus,
} from '../lib/board-status.js'
import { MEMBER_PRESENT_MAX, MEMBER_ROLE_MAX, MEMBER_WARN_LINE } from '../lib/team-limits.js'
import { readRoster } from '../lib/roster.js'
import * as NL from './native-layer.js'

// `BOARD_REJECTED_STATUS` / `BOARD_DONE_STATUS` / `BOARD_DEFAULT_STATUS` / `BOARD_STATUSES` /
// `STATUS_LINE_ORDER` / `isBoardStatus` 都由上面那处 import 给（唯一正文在 `lib/board-status.js`）。
/** 已被认领、还没交出的状态：**有开放执行代**就是它。 */
const BOARD_CLAIMED_STATUS = '进行中'


/**
 * 「人的话」的类别：人给的**目标 / 约束 / 偏好 / 否决理由**（人的决定与约束，含口头的、含理由）。
 *
 * 取值只此四类，不许自造：类别是读的时候唯一的筛选维度（`human_words_list kind=…`），
 * 多一个写法就多一种没人筛得到的落点，也把「这条算哪一类」变成每次都要现场裁定的问题。
 */
const HUMAN_KINDS = ['goal', 'constraint', 'preference', 'veto']
/** 类别的中文标签：工具回执与文件表里印这个；枚举值只作筛选与落库用。 */
const HUMAN_KIND_LABEL = { goal: '目标', constraint: '约束', preference: '偏好', veto: '否决理由' }
/**
 * 一句话的长度上限，超出只告警、不阻断登记（与看板「一句话」同一口径）。
 * 上限不是为了好看：这份文件要**压进每个会话开局的注入**，一条散文会把注入挤掉。
 */
const HUMAN_TEXT_MAX_CHARS = 160

/**
 * 成员状态，**只此三种**（基线 §十一.11）：在场 / 归档 / 退役。
 *   · **在场**计入编制（只有它算「同时在场人数」）；
 *   · **归档** = 做完不踢出：会话保留、可被历史寻址、**可以被再次唤醒**；
 *   · **退役** = 显式动作（要原因与「谁顶上」）：进退休名单，**拒绝再被唤醒**。
 * 多一个写法就多一种没人筛得到的落点，所以不许自造。
 */
const MEMBER_PRESENT_STATUS = '在场'
const MEMBER_ARCHIVED_STATUS = '归档'
const MEMBER_RETIRED_STATUS = '退役'
/**
 * **创建失败的行显示成"未到场"**（派生值，不写回文件）：那种行是为了留痕才留在名册里
 * （`runtime: 'failed'` + 一行诊断），人从来没到场过。若照文件里的 `在场` 显示，
 * 「在场 N / 告警线 4」就会把不存在的人算进编制读数（现场踩过：三次创建失败 ⇒ 报"在场 3"）。
 */
export const MEMBER_UNARRIVED_STATUS = '未到场'
/** 运行时状态里的"创建失败"值（与 `team/team-runtime.js` 同源）。 */
const MEMBER_FAILED_RUNTIME = 'failed'
/** 这一行到底有没有到场：创建失败的不算。 */
const hasArrived = (member) => member?.runtime !== MEMBER_FAILED_RUNTIME
// 编制上限的**唯一正文**在 `lib/team-limits.js`（制度层与薄层都要用；放这里会与薄层成环）。
/**
 * 名册「未建立」的说明：**这份文件按需建立**，没加过人时它本来就不存在。
 * 它与「0 个成员」是两件事 —— 把前者读成后者，下一步动作就完全反了。
 */
const MEMBER_UNESTABLISHED_HOW = `这份文件**按需建立**：文件不在是正常状态（还没加过人），但**不等于「0 个成员」**。建法：\`member_spawn\`（名字 + 角色 + 首活）生第一个成员时自动建立。`


/** 事务边界重跑上限：递交前比对冲突时整段重跑，超过即回报并发冲突。 */
const MAX_CAS_ATTEMPTS = 3

/** 文件顶层 `writer` 距现在不超过该毫秒数时，视为「别的进程刚写过」，只告警不合并。 */
const FOREIGN_WRITE_WINDOW_MS = 30_000

/** 单次 `check_artifact` 编号唯一性扫描的同目录文件数上限，超出部分不读并显式告警。 */
const UNIQUENESS_SCAN_MAX = 200

/** 结构化「未找到」信号：只有这些码（或 `stat` 返回 undefined）才算文件不在。 */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR', 'FS_NOT_FOUND'])
/** libuv 的 ENOENT / ENOTDIR 数值形式，供只带 errno 的运行时报错识别。 */
const ABSENT_ERRNOS = new Set([-2, -20])

/** 产物模板要素与追溯标记的检查表，键即 `check_artifact` 的 kind。 */
const ARTIFACT_RULES = {
	story: {
		label: '故事',
		idPattern: /US-[A-Za-z0-9\u4e00-\u9fa5]+-\d+/g,
		idSpec: 'US-<模块>-<序号>',
		elements: [
			{ key: '用户故事', test: (text) => /用户故事|作为[^\n]{0,20}我(希望|想要|需要)/.test(text) },
			{ key: '验收标准', test: (text) => /验收标准|验收条件|AC[：:\s]/.test(text) },
			{ key: '优先级', test: (text) => /优先级|P[0-3](?![\d])/.test(text) },
		],
		trace: { spec: '需求来源或追溯标记（来源／追溯／关联／Refs）', test: (text) => /来源|追溯|关联|Refs?[：:]/i.test(text) },
	},
	testcase: {
		label: '测试用例',
		idPattern: /TC-[A-Za-z0-9\u4e00-\u9fa5]+-\d+-\d+/g,
		idSpec: 'TC-<模块>-<故事号>-<序号>',
		elements: [
			{ key: '前置条件', test: (text) => /前置条件|前置|前提/.test(text) },
			{ key: '测试步骤', test: (text) => /测试步骤|操作步骤|步骤/.test(text) },
			{ key: '预期结果', test: (text) => /预期结果|期望结果|预期/.test(text) },
		],
		trace: { spec: '至少一条 US-<模块>-<序号> 故事编号', test: (text) => /US-[A-Za-z0-9\u4e00-\u9fa5]+-\d+/.test(text) },
	},
	adr: {
		label: '架构决策',
		idPattern: /ADR-\d+/g,
		idSpec: 'ADR-<序号>',
		elements: [
			{ key: '背景', test: (text) => /背景|上下文|Context/i.test(text) },
			{ key: '决策', test: (text) => /决策|决定|Decision/i.test(text) },
			{ key: '后果', test: (text) => /后果|影响|Consequences/i.test(text) },
			{ key: '状态', test: (text) => /状态|Status/i.test(text) },
		],
		trace: { spec: '关联条目编号（US-／T-／ADR-）或关联说明', test: (text) => /US-[A-Za-z0-9\u4e00-\u9fa5]+-\d+|T-\d+|ADR-\d+|关联|来源/.test(text) },
	},
	generic: {
		label: '通用产物',
		idPattern: /\b(?:US|TC|ADR|TM|API|DM|CT|E|T|AP|CV)-[A-Za-z0-9\u4e00-\u9fa5-]+/g,
		idSpec: '任一已登记编号族（US-／TC-／ADR-／TM-／API-／DM-／CT-／E-／T-…）',
		elements: [{ key: '标题层级', test: (text) => /^#{1,6}\s+\S/m.test(text) }],
		trace: { spec: '关联任一编号族的条目', test: (text) => /\b(?:US|TC|ADR|TM|API|DM|CT)-[A-Za-z0-9\u4e00-\u9fa5-]+/.test(text), warnOnly: true },
	},
}

/** `check_artifact` 的只读边界声明。 */
const READ_BOUNDARY = '边界：只读工作区内的产物文件，不写任何文件、不删除、不移动、不读工作区外路径。'

/**
 * `board_task` 的边界声明：任务本体存在**原生队伍**里，本插件不写看板文件；但每次成功改动之后会往工作区
 * 写**一份交接快照**（`LEDGER_FILE.handoff`）—— 边界声明要逐字点名这件事，不能再说"不写工作区里任何文件"
 * （那是一句已经过时的话：读的人会以为看板改动不留任何痕迹）。
 */
const BOARD_BOUNDARY =
	'边界：任务本体是 DSH 原生 Agent Teams 的队伍日志（`ctx.agentTeams`）里的记录，本插件**不写看板 / 名册 / 邮箱文件**；' +
	'每次成功改动之后会往工作区写**一份交接快照** `.company-gate.handoff.json`（跨会话续接用的**派生物**，不是第二本账、也不是实时读数）—— ' +
	'这是本工具在工作区里写的**唯一**一份文件。不写工作区外任何路径，不删文件，不移动工作区文件。'

const WRITE_BOUNDARY_HUMAN =
	'边界：只写工作区内 `.company-gate.human.json` 一份文件；不写工作区外任何路径，不删文件，不移动工作区文件。**这份文件的写入只有协调器（主会话）能做** —— 成员身份调用会被拒（判据见 `coordinatorCheckOf`）：成员只能读人的话（`human_words_list`），要记就回给协调者。跨进程并发只由递交前重读比对事后收窄（TOCTOU 仍在），无法消除静默丢更新；读到别的进程刚写入的文件只检出并告警，不自动合并。'

/**
 * 成员面那几个工具共用的边界声明（`member_spawn` / `member_send`）。
 *
 * **它们一个状态文件都不写**：成员与消息都是 DSH 原生 Agent Teams 的对象（`ctx.agentTeams`），
 * 名册 / 邮箱文件已经不在本插件的写盘清单里（见 `LEDGER_FILE`）。这一条从前写的是"只写
 * `.company-gate.members.json`" —— 成员面迁原生之后那就是一句没做到的话，改成事实。
 */
const WRITE_BOUNDARY_MEMBERS =
	'边界：**不写工作区里的任何状态文件** —— 成员与消息都是 DSH 原生 Agent Teams 的对象（`ctx.agentTeams`），本插件不落名册 / 邮箱文件；不写工作区外任何路径，不删文件，不移动工作区文件。跨进程并发只由递交前重读比对事后收窄（TOCTOU 仍在），无法消除静默丢更新；读到别的进程刚写入的文件只检出并告警，不自动合并。'

/**
 * `role_manage` 那一档的边界声明（它和成员面不是一回事：这一条**真的**写工作区文件）。
 * 同一理由：逐字点名本次真正写的那一份文件，别拿点名别处的边界来声明。
 */
const WRITE_BOUNDARY_ROLES =
	'边界：只写工作区内 `.company-gate.roles.json` 一份文件（角色启用开关；缺省全部启用，只记关掉了哪些）；不写工作区外任何路径，不删文件，不移动工作区文件。**这份文件的写入只有协调器（主会话）能做** —— 成员身份调用会被拒。跨进程并发只由递交前重读比对事后收窄（TOCTOU 仍在），无法消除静默丢更新；读到别的进程刚写入的文件只检出并告警，不自动合并。'

/** 读到别处写入、或编号唯一性没查全时的告警文案由各自的判定函数生成；此常量只放共用措辞。 */
const CAS_NOTE = '本次写为「重读比对 → 写临时文件 → 改名发布」，比对与改名之间仍有窗口。'

// ── 错误与结果 ───────────────────────────────────────────────────────────────

/** 文件读取失败：文件在、但读不出来或读出来不可用。写 action 收到它必须中止。 */
class LedgerReadError extends Error {
	constructor(message) {
		super(message)
		this.name = 'LedgerReadError'
	}
}

/** 递交前重读与快照不一致：另一个写者改动了同一文件。 */
class CasConflictError extends Error {
	constructor(message) {
		super(message)
		this.name = 'CasConflictError'
	}
}

/** 把任意抛出物压成一行可读原因；有结构化码时只报码，避免把外部措辞混进文件错误。 */
function failureReason(error) {
	if (error === null || error === undefined) return '未知错误'
	if (typeof error !== 'object') return String(error)
	if (typeof error.code === 'string' || typeof error.code === 'number') return String(error.code)
	const name = typeof error.name === 'string' ? error.name : 'Error'
	const message = typeof error.message === 'string' ? error.message : ''
	return (message === '' ? name : `${name}: ${message}`).slice(0, 160)
}

/** 统一的读取失败错误：显式中止，且不把失败说成「空文件」。 */
function readFailure(path, error) {
	return new LedgerReadError(
		`读取失败：${path}（原因：${failureReason(error)}）；为避免覆盖既有文件，本次操作已中止，磁盘内容未改动。`,
	)
}

/** 结构化「未找到」判定：只看码与 errno，绝不匹配错误文本。 */
function isAbsentError(error) {
	if (error === null || typeof error !== 'object') return false
	if (typeof error.code === 'string' && ABSENT_CODES.has(error.code)) return true
	return typeof error.errno === 'number' && ABSENT_ERRNOS.has(error.errno)
}

/** 工具回执：成功。 */
function okJson(payload) {
	return JSON.stringify({ ok: true, ...payload })
}

/** 工具回执：失败。没写进文件、或无法确认写没写成功时，只走这里，绝不返回 ok。 */
function failJson(error) {
	const message = error instanceof Error ? error.message : String(error)
	return JSON.stringify({ ok: false, error: message })
}



// ── 参数校验 ─────────────────────────────────────────────────────────────────

/** 取必填非空字符串，缺省或空白即报错。 */
function requireText(value, field) {
	if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} 必填，且必须是非空字符串。`)
	return value.trim()
}

/** 取可选字符串：缺省返回 undefined，给了但不是字符串即报错。 */
function optionalText(value, field) {
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'string') throw new Error(`${field} 必须是字符串。`)
	return value.trim()
}

/** 取枚举值，`fallback` 为 undefined 时该字段必填。 */
function requireEnum(value, allowed, field, fallback) {
	if (value === undefined || value === null) {
		if (fallback !== undefined) return fallback
		throw new Error(`${field} 必填，取值之一：${allowed.join(' / ')}。`)
	}
	if (typeof value !== 'string' || !allowed.includes(value)) {
		throw new Error(`${field} 取值必须是 ${allowed.join(' / ')} 之一，收到 ${JSON.stringify(value)}。`)
	}
	return value
}

// ── 序号与编号 ───────────────────────────────────────────────────────────────

/** 从既有编号里取首段数字：`前缀-数字…` 取其数字段，无法识别返回 null。 */
function idNumber(id) {
	if (typeof id !== 'string') return null
	const matched = /^[A-Z]+-(\d+)/.exec(id)
	if (matched === null) return null
	const value = Number.parseInt(matched[1], 10)
	return Number.isFinite(value) ? value : null
}

/** 渲染编号：前缀 + 补零序号。 */
function formatId(prefix, value) {
	return `${prefix}-${String(value).padStart(ID_DIGITS, '0')}`
}

/**
 * 下一个可用序号：取已记录水位与既有条目编号的最大值加一。
 * 既保证不重用编号，也让水位缺失的文件（条目齐备但水位缺失）能继续递增。
 */
function nextNumber(recorded, numbers) {
	let highest = Number.isInteger(recorded) && recorded >= 0 ? recorded : 0
	for (const value of numbers) if (typeof value === 'number' && value > highest) highest = value
	return highest + 1
}

/** 收集数组里每一项的首段编号数字，供 `nextNumber` 使用。 */
function numbersOf(items) {
	return items.map((item) => idNumber(item?.id))
}

// ── 写者标记与并发告警 ───────────────────────────────────────────────────────

/** 文件顶层写者标记：谁在何时写的，供跨进程只读比对。 */
function writerStamp() {
	return { pid: process.pid, host: hostname(), at: new Date().toISOString() }
}

/** 只检出、不合并：他方写入发生在窗口内时给一条告警。 */
function foreignWriterWarnings(value) {
	const writer = value?.writer
	if (writer === undefined || writer === null || typeof writer !== 'object') return []
	if (writer.pid === process.pid && writer.host === hostname()) return []
	const at = typeof writer.at === 'string' ? Date.parse(writer.at) : Number.NaN
	if (!Number.isFinite(at)) return ['文件顶层 writer 的时间无法解析，未与本地写入者比对时间窗。']
	const age = Date.now() - at
	if (age > FOREIGN_WRITE_WINDOW_MS) return []
	return [
		`文件由另一进程（pid ${String(writer.pid)}@${String(writer.host)}）在 ${Math.max(0, Math.round(age / 1000))} 秒前写入；引擎只检出、不自动合并，冲突以递交前重读比对为准。`,
	]
}

// ── 文件系统读写 ─────────────────────────────────────────────────────────────

/** 本次调用可用的取消信号。 */
function signalOf(exec) {
	return exec !== undefined && exec !== null ? exec.signal : undefined
}

/**
 * 工作区根，三档：
 *   ① `exec.workspace` —— **无会话调用方**（文件前端页那几条写路径）显式给出的绝对路径；
 *   ② 调用会话的工作目录（会话内工具的正常路径）；
 *   ③ 进程工作目录（兜底）。
 * 为什么把它排在②前面：面板那条路没有会话，伪造一个 session 会让沙箱策略那一步去碰真会话
 * 才有的方法；给一个显式字段比伪造会话诚实，也让"这次写哪个工作区"在调用点上看得见。
 */
function workspaceRootOf(exec) {
	const explicit = typeof exec?.workspace === 'string' && exec.workspace.trim() !== '' ? exec.workspace.trim() : undefined
	if (explicit !== undefined) return explicit
	const cwd = exec?.agent?.session?.header?.cwd
	if (typeof cwd === 'string' && cwd.trim() !== '') return cwd
	return process.cwd()
}

/** 解析状态文件的绝对路径：文件名固定相对于工作区根。 */
function ledgerPath(workspace, name) {
	return joinPath(workspace, name)
}

/** 把调用方给的产物路径解析成绝对路径：绝对路径原样使用，相对路径按工作区根解析。 */
function artifactPath(workspace, requested) {
	return isAbsolutePath(requested) ? requested : joinPath(workspace, requested)
}

/** 解析一个绝对路径为目标身份；`opts` 只在带信号时给出。 */
function resolveTarget(ctx, absPath, exec) {
	const signal = signalOf(exec)
	return ctx.fs.resolve(absPath, signal === undefined ? undefined : { signal })
}

/**
 * 目标在宿主/执行世界里的进程路径；后端没提供映射时退回传入的绝对路径。
 * 改名的两端必须来自同一个后端，因此两端都用此函数取值。
 */
function processPathOf(ctx, target, fallback) {
	const mapped = typeof ctx.fs.processPath === 'function' ? ctx.fs.processPath(target) : undefined
	return typeof mapped === 'string' && mapped.length > 0 ? mapped : fallback
}

/**
 * 按调用会话解析本次写入的沙箱策略，交给后端裁定；服务缺失时返回 undefined，
 * 由后端用自己的默认策略裁定 —— 拒绝会显式报错，不会静默通过。
 */
function policyFor(ctx, exec) {
	// 调用方已把策略解析好（无会话的调用方自己决定边界）：原样用它，不再自行解析。
	if (exec?.sandboxPolicy !== undefined && exec?.sandboxPolicy !== null) return exec.sandboxPolicy
	const service = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined
	if (service === undefined || service === null || typeof service.resolve !== 'function') return undefined
	const session = exec?.agent?.session
	return service.resolve(session === undefined ? {} : { session })
}

/**
 * 读文本快照：`{ kind: 'absent' }` 只在结构化「未找到」时产生，其余异常一律抛读取失败。
 * 解析路径本身失败也走同一判定，因此权限类拒绝不会被当成空文件。
 */
async function readTextSnapshot(ctx, absPath, exec) {
	let target
	try {
		target = await resolveTarget(ctx, absPath, exec)
	} catch (error) {
		if (isAbsentError(error)) return { kind: 'absent', path: absPath }
		throw readFailure(absPath, error)
	}
	let info
	try {
		info = await ctx.fs.stat(target, signalOf(exec))
	} catch (error) {
		if (isAbsentError(error)) return { kind: 'absent', path: absPath }
		throw readFailure(absPath, error)
	}
	if (info === undefined) return { kind: 'absent', path: absPath }
	let text
	try {
		text = await ctx.fs.readText(target, signalOf(exec))
	} catch (error) {
		if (isAbsentError(error)) return { kind: 'absent', path: absPath }
		throw readFailure(absPath, error)
	}
	return { kind: 'present', path: absPath, text }
}

/**
 * 读文件：文本快照 + JSON 解析 + 顶层必须是非数组对象。
 * 解析失败或顶层形状不符一律抛读取失败，绝不当作空文件 —— 空状态会掩盖既有条目。
 */
async function readLedger(ctx, absPath, exec) {
	const snapshot = await readTextSnapshot(ctx, absPath, exec)
	if (snapshot.kind === 'absent') return { kind: 'absent', path: absPath, text: '', value: null }
	let value
	try {
		value = JSON.parse(snapshot.text)
	} catch (error) {
		throw readFailure(absPath, error)
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new LedgerReadError(
			`读取失败：${absPath}（原因：顶层不是 JSON 对象）；为避免覆盖既有文件，本次操作已中止，磁盘内容未改动。`,
		)
	}
	return { kind: 'present', path: absPath, text: snapshot.text, value }
}

/** 取文件里的集合字段；形状不符即读取失败，避免把未知结构当作空集合再写回去。 */
function collectionOf(value, absPath, field) {
	const collection = value?.[field]
	if (!Array.isArray(collection)) {
		throw new LedgerReadError(
			`读取失败：${absPath}（原因：${field} 不是数组，结构不符合文件约定）；为避免覆盖既有文件，本次操作已中止，磁盘内容未改动。`,
		)
	}
	return collection
}

/** 临时文件名里的进程内序号（同一进程内不重名；与 pid 一起构成唯一名）。 */
let tempSequence = 0

/**
 * 递交：重读原文与快照比对（不一致即并发冲突），再把新内容写成同目录临时文件并改名发布。
 * 冲突抛出点在写盘之前，所以调用方在事务边界重跑整段是幂等安全的。
 * 返回写进文件后的文本，供调用方核对。
 */
async function commitLedger(ctx, absPath, snapshot, nextValue, exec) {
	const current = await readLedger(ctx, absPath, exec)
	if (current.kind !== snapshot.kind || current.text !== snapshot.text) {
		throw new CasConflictError(
			`并发冲突：${absPath} 在本次读改写期间已被其他写者改动，重读比对不一致。${CAS_NOTE}`,
		)
	}
	const text = `${JSON.stringify(nextValue, null, 2)}\n`
	tempSequence += 1
	const tempPath = `${absPath}.tmp-${process.pid}-${tempSequence}`
	// 临时文件与文件同目录：越界判定与文件一致，改名不跨目录。
	const tempTarget = await resolveTarget(ctx, tempPath, exec)
	const policy = policyFor(ctx, exec)
	await ctx.fs.writeText(tempTarget, text, undefined, signalOf(exec), policy)
	const from = processPathOf(ctx, tempTarget, tempPath)
	const to = processPathOf(ctx, await resolveTarget(ctx, absPath, exec), absPath)
	try {
		await renamePath(from, to)
	} catch (error) {
		throw new Error(
			`写入失败：${absPath}（原因：${failureReason(error)}）；文件未改动，临时文件保留在 ${tempPath}。`,
		)
	}
	return text
}

// ── 按文件的事务队列 ─────────────────────────────────────────────────────────

/** 文件键 → 队尾。同一文件串行，不同文件互不阻塞。 */
const fileQueues = new Map()

/** 把任务挂到该文件的队尾，并返回本次任务自己的 Promise。 */
function enqueueByFile(key, task) {
	const previous = fileQueues.get(key) ?? Promise.resolve()
	const run = previous.then(task, task)
	const tail = run.then(
		() => undefined,
		() => undefined,
	)
	fileQueues.set(key, tail)
	void tail.then(() => {
		if (fileQueues.get(key) === tail) fileQueues.delete(key)
	})
	return run
}

/**
 * 在文件队列内跑一个写事务：整段读-改-写可因递交冲突重跑，上限见 `MAX_CAS_ATTEMPTS`。
 * 重跑前不写任何字节，因此重跑看到的仍是磁盘真实状态。
 */
function transact(ctx, fileKey, exec, handler) {
	return enqueueByFile(fileKey, async () => {
		let conflict = null
		for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
			try {
				return await handler()
			} catch (error) {
				if (!(error instanceof CasConflictError)) throw error
				conflict = error
			}
		}
		throw conflict ?? new CasConflictError(`并发冲突：${fileKey} 重试后仍未落盘。`)
	})
}

// ── 看板 ─────────────────────────────────────────────────────────────────────

/**
 * **里程碑清单的解析**（`docs/team/里程碑.md`）：把那张表读成 `phase` 的取值域。
 *
 * 为什么这解析放在引擎里而不是宿主那半边：`phase` 是引擎的字段、**取值域与出口准则的唯一落点
 * 就是这份清单**（基线 §七 那条）。宿主只负责把文件读成文本，**怎么认这张表在引擎这一处** ——
 * 于是"面板上的 EPIC 卡"与"引擎认的阶段"不可能各说各话。
 *
 * 容忍度（这张表是人手写的，迟早会有人多加一列或省掉反引号）：
 *   · 只认 **表格行**（`|` 开头），表头与分隔行靠"第一格不是一个像编号的取值"挡掉；
 *   · 编号可以带反引号也可以不带；名称 / 出口准则 / 依赖 / 状态四格**缺哪格就留空**
 *     （缺格不是错误，是"这一项没写"）；
 *   · 行内 Markdown 装饰（`**粗体**`、反引号）剥掉，留下的就是人读的那串字。
 * **读不出任何一行不是异常**：清单可能还没建、或者人家用的是别的表形 —— 返回空数组，由调用方
 * 如实说"没读到里程碑清单"，**不臆造阶段名**。
 * @param markdown - `里程碑.md` 全文（任何输入都安全：非字符串按空串算）。
 * @returns `[{ code, name, exit, deps, status }]`（按文件里的顺序）。
 */
export function parseMilestones(markdown) {
	const text = typeof markdown === 'string' ? markdown : ''
	const plain = (value) =>
		String(value ?? '')
			.replace(/\*\*/g, '')
			.replace(/`/g, '')
			.replace(/\s+/g, ' ')
			.trim()
	const rows = []
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim().startsWith('|')) continue
		const cells = line.split('|').slice(1, -1)
		if (cells.length < 2) continue
		const code = plain(cells[0])
		// 表头（`编号`）与分隔行（`:--`）都会在这里被挡掉：编号必须长得像一个编号。
		if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(code)) continue
		rows.push({ code, name: plain(cells[1]), exit: plain(cells[2]), deps: plain(cells[3]), status: plain(cells[4]) })
	}
	return rows
}

// ── 看板条目的运行时语义（**只留下读数要用的那几个派生**） ────────────────────
//
// 任务板已整本迁到 DSH 原生 Agent Teams（`board_task` 走 `ctx.agentTeams`）——CAS 版本号、
// 执行代凭据、依赖门禁这三条机制**都在原生那一侧**，本文件不再实现、也不再写看板文件。
// 这一段剩下的全是**纯函数派生**，只服务两处读数：
//   · `taskAttemptIdOf` / `taskHasOpenAttempt` —— 「这活现在谁在干」（名册读数与面板用）；
//   · `writeScopesOf` / `writeScopeWarningsOf` —— 写盘面重叠提示（只告警，绝不拦）。
// 它们不碰文件系统，可以脱离宿主单测。

/** 任务当前执行代凭据；没有开放执行代时返回 undefined。 */
export function taskAttemptIdOf(task) {
	return typeof task?.attemptId === 'string' && task.attemptId !== '' ? task.attemptId : undefined
}

/** 任务是否**有开放执行代**（已认领、还没交出）。这是「这活有人正在干」的唯一判据。 */
export function taskHasOpenAttempt(task) {
	return taskAttemptIdOf(task) !== undefined && task?.status === BOARD_CLAIMED_STATUS
}

/** 任务的写盘面清单（规范化：去空白、去重、保序）。 */
export function writeScopesOf(task) {
	const scopes = task?.writeScopes
	if (!Array.isArray(scopes)) return []
	const seen = new Set()
	const out = []
	for (const raw of scopes) {
		if (typeof raw !== 'string') continue
		const scope = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '')
		if (scope === '' || seen.has(scope)) continue
		seen.add(scope)
		out.push(scope)
	}
	return out
}

/**
 * 写盘面重叠提示：**只告警，绝不拦**（内置 Agent Teams 同一条口径 —— 重叠是提醒，
 * 不是锁；Bash、formatter 与代码生成器本来就能绕过任何文件版本检查）。
 * 判定：两条**进行中**的任务，一方写盘面是另一方的前缀（含相等）即重叠。
 */
export function writeScopeWarningsOf(tasks, selfId) {
	const active = (tasks ?? []).filter((task) => task?.status === BOARD_CLAIMED_STATUS && typeof task?.id === 'string' && task.id !== selfId)
	const warnings = []
	for (const task of tasks ?? []) {
		if (task === null || typeof task !== 'object' || typeof task.id !== 'string') continue
		if (selfId !== undefined && task.id !== selfId) continue
		const mine = writeScopesOf(task)
		for (const other of active) {
			const theirs = writeScopesOf(other)
			for (const a of mine) {
				const hit = theirs.find((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))
				if (hit !== undefined) {
					warnings.push(`${task.id} 与 ${other.id}（进行中）的写盘面重叠：${a} 与 ${hit}。这只是提醒，不拦任何操作 —— 请 Coordinator 协调 owner，避免同一批文件被两处同时改。`)
				}
			}
		}
	}
	return warnings
}

/**
 * **状态快照**：两行口径的**唯一一处正文**（会话里的 `team_status` 与面板 host 共用同一份）。
 *
 * 入参只有文件内容：`tasks` 传 `undefined` 表示**看板文件读不到**（文件不在、读不成）。
 * 纯函数，不碰文件系统 —— 于是面板不需要另写一套判定，也就不会与 `team_status` 各说各话。
 *
 * 判定条件（口径写死在这里，改这里即改判定条件）：
 *   · 第一行的数 = **看板五个分栏各自的名字与条目数**（待办 / 进行中 / 已完成 / 待验收 / 已打回）；
 *   · **卡住**（只做明细行、不占第一行的数）= `status = 已打回`，**加上**未完成且带 `blockedBy` 的条目。
 * **各档合起来等于看板总条数**：登记的活一件都不能落在这些档之外。读不到时那一个数写 `?`，**不许写成 0**。
 * 输出最多两行：第一行的分栏计数 + 「需要动作」的明细行（卡住）。
 * @param input - `{ tasks, now? }`；`now` 今天只用于告警。
 */
export function statusSnapshot(input) {
	const tasks = input?.tasks
	// 期限判定的基准：调用方传进来（可测）。今天只用于告警，不影响第一行那几个数。
	const now = input?.now
	const byStatus = (status) => (tasks === undefined ? undefined : tasks.filter((task) => task?.status === status))
	// 第一行的每一档都**直接用看板分栏的名字与条目数** —— 一个数对一个可见的栏，
	// 合计等于板子上的总条数。改名（例如把「进行中 + 待验收」并成「推进中」）会让
	// 状态行与分栏**对不上**，读的人第一反应是"这两个数打架"（现场就是这么被打回的）。
	const perStatus = BOARD_STATUSES.map((status) => ({ status, list: byStatus(status) }))
	const stuck =
		tasks === undefined
			? undefined
			: tasks.filter(
					(task) =>
						task?.status === BOARD_REJECTED_STATUS ||
						(task?.status !== BOARD_DONE_STATUS && typeof task?.blockedBy === 'string' && task.blockedBy.trim() !== ''),
				)

	const count = (value) => (value === undefined ? '?' : String(value.length))
	const unread = tasks === undefined || stuck === undefined
	// 明细行最多印几条：印满一屏就不再是「一句话说清现状」，超出的收成「等 N 项」。
	const CAP = 4
	const brief = (list, render) => {
		if (list === undefined) return '（读不到）'
		if (list.length === 0) return '无'
		const head = list.slice(0, CAP).map(render).join(' ／ ')
		return list.length > CAP ? `${head} 等 ${list.length} 项` : head
	}
	const oneLine = (text) => text.replace(/\s+/g, ' ').trim().slice(0, 80)

	// 第一行 = 五个读数，名字与值都取自同一处口径（看板各分栏），**顺序按 STATUS_LINE_ORDER**。
	const byStatusCount = new Map(perStatus.map(({ status, list }) => [status, count(list)]))
	const head = STATUS_LINE_ORDER.map(({ key, label }) => `${label} ${byStatusCount.get(key)}`).join(' · ')
	const lines = [`${head}${unread ? '（带 ? 的是文件读不到，不等于 0）' : ''}`]
	// 「卡住」是**子集**（已打回 ∪ 带阻塞的未完成），不是分栏里的一档 ⇒ 它只做明细行，不进第一行，
	// 免得又一个与分栏对不上的数。
	if (stuck === undefined || stuck.length > 0) {
		lines.push(`卡住：${brief(stuck, (task) => `${task.id} ${oneLine(task.blockedBy ?? '已打回')}`)}`)
	}

	const counts = {}
	for (const { status, list } of perStatus) counts[status] = list === undefined ? null : list.length
	return { counts, markdown: lines.join('\n') }
}

// ── 任务面：走 DSH 原生 Agent Teams 的任务板（`ctx.agentTeams` 的 tasks 那一组） ──────
//
// 原生任务只有三态（`pending` / `in_progress` / `completed`）与七个动作
// （claim / release / edit / set_dependencies / complete / reopen / reassign / delete），
// CAS 走 `expectedRevision`。服务面的字段是 **camelCase**（`taskId` / `expectedRevision` /
// `blockedBy` / `writeScopes`）—— 工具面那套 snake_case 是内置工具自己转的；我们直连服务，按服务的来。

/** 我们的动作名 → 原生的动作名（名字不同的那一个）。 */
function nativeActionOf(action) {
	return action === 'update' ? 'edit' : action
}

/** 原生没有的那几个动作：写清"用它哪一档代替"，而不是含糊拒绝。 */
const NATIVE_TASK_REFUSALS = {
	submit: '原生任务板没有"交出待验收"这一档（只有 待办 / 进行中 / 已完成）：干完直接 `complete`；需要独立复核就另开一条任务派给复核的角色。',
	accept: '原生任务板没有"验收通过"这一档：复核结论写进回报或另开一条任务记录，任务本身用 `complete` 收口。',
	reject: '原生任务板没有"打回"这一档：把打回理由 `member_send` 给执行者（或 `edit` 任务描述），任务留 `in_progress`。',
	view: '原生任务板不需要另生成视图文件：面板那一档就是视图（端点 `/company-board/api/team-tasks`）。',
}

/**
 * 原生任务编号的形状（读自宿主：``TeamTaskId(`task-${state.nextTaskNumber}`)``）。
 * 拿它既能给调用方一句"正确形状是什么"，也能把"编号写错"与"任务真不存在"分开。
 */
const NATIVE_TASK_ID_RE = /^task-\d+$/

/**
 * 原生能表达的任务状态：**三档**（`pending` / `in_progress` / `completed`）。
 * 中文那三档是同一件事的另一种写法（工具面同时认）；`待验收` / `已打回` / `submitted` / `rejected`
 * 是**本产品文件看板**的制度档，原生没有对应物 —— 它们在这里会被明确拒绝，而不是安静地回 0 条。
 */
const NATIVE_STATUS_FILTERS = {
	pending: 'pending',
	in_progress: 'in_progress',
	completed: 'completed',
	待办: 'pending',
	进行中: 'in_progress',
	已完成: 'completed',
}

/** 编号给错时把"正确形状"补进回执：原生只说 `team task "X" not found`，照着错形状试的人会反复。 */
function boardErrorOf(id, reason) {
	const text = reason ?? '原生任务板没有回原因'
	if (typeof id === 'string' && id !== '' && !NATIVE_TASK_ID_RE.test(id)) {
		return `${text} —— 原生任务编号的形状是 \`task-<n>\`（例如 task-7），不是 T-<序号>；\`id\` 请照 board_task action=query（或 team_task_list）读到的原样传。`
	}
	return text
}

/**
 * **行政面的身份判据**：这个调用者是不是**协调者**（唯一正文；`role_manage` 与 `board_task` 共用）。
 *
 * 为什么要有它：`member_spawn` 有原生兜底（成员身份调用拿到 `only the Team Lead can create teammates`），
 * 而**插件自注册**的那两个行政面没有这把门 —— 成员身份从前能直接改角色开关、直接建/删/转派任务。
 * 门补在 handler 里（那是唯一能落地的位置）：工具面对每个成员都注册（成员得能互相发消息、能抢活），
 * 权限只能在 `execute` 里按"谁在调"判。
 *
 * 两条判据，按可靠性排序：
 *   ① `ctx.agentTeams.tryMembership(agent).role === 'lead'` —— **宿主的答案**。宿主自己就是这么判的
 *      （`tryMembership`：有 `parentSession` 且它指着根会话、而这个 agent 在名册里 ⇒ `teammate`；
 *      根会话 / 没有父会话的活 agent ⇒ `lead`）；
 *   ② 服务那一版拿不到 `tryMembership`（老宿主、假件）时回落：**看会话有没有父会话** ——
 *      有父会话的是子代理（成员），没有的就是主会话（协调者）。这条与宿主的分支同源，但只是回落；
 *      **判不出来时宁拒不放**（行政面拒绝的代价是"找协调者去办"，放行的代价是制度被绕过）。
 * @param ctx - 上下文。
 * @param agent - 调用者（工具 handler 的 `exec.agent`）。
 * @param spec - `{ tool, why }`：工具名（进回执）与"为什么这一档只有协调者能做"（一句话，进回执）。
 * @returns `{ ok: true }`，或 `{ ok: false, reason }`（reason 是给人看的一句话：为什么不行、该找谁）。
 */
export function coordinatorCheckOf(ctx, agent, { tool, why }) {
	if (agent === undefined || agent === null) {
		return { ok: false, reason: `调 ${tool} 需要调用者身份（Agent）：拿不到就不执行。` }
	}
	let role
	const service = typeof ctx?.get === 'function' ? ctx.get('agentTeams') : undefined
	if (service !== null && service !== undefined && typeof service.tryMembership === 'function') {
		try {
			role = service.tryMembership(agent)?.role
		} catch {
			role = undefined // 宿主抛（agent 不是活的队内成员）⇒ 走回落那条，不在这一层编答案
		}
	}
	if (role === undefined) {
		const parentId = agent?.session?.header?.parentSession
		role = typeof parentId === 'string' && parentId !== '' ? 'teammate' : 'lead'
	}
	if (role === 'lead') return { ok: true }
	return {
		ok: false,
		reason:
			`agent "${String(agent?.id ?? '')}" 是**团队成员**，不是协调者：${tool} 不能由它调 —— ${why}。` +
			'这件事回给协调者（`member_send` target `lead`），由它来做：成员之间可以互相发消息、可以抢活，' +
			'但**登记与裁决**（建条 / 转派 / 删条 / 设依赖 / 改字段 / 重开）与**角色清单**只有协调者能动。',
	}
}

/**
 * `board_task` 里**只有协调者能做**的动作（登记与裁决）。
 *
 * 分档的口径来自基线：看板的登记与裁决类写入是协调器那三件专属动作之一；而
 * `claim` / `release` / `complete` / `query` / `get` 是执行者的日常 —— 成员照旧可用
 * （否则"成员能抢活"这句话就落不了地）。
 */
const COORDINATOR_ONLY_TASK_ACTIONS = new Set(['register', 'reassign', 'delete', 'set_dependencies', 'edit', 'update', 'reopen'])

/** `board_task`：把动作转给原生任务板。 */
async function nativeBoardTask(ctx, exec, args) {
	const caller = exec?.agent
	const action = String(args.action ?? '')
	// **按动作分档**：登记与裁决只有协调者能做；执行者的日常（认领 / 释放 / 收口 / 读）不设门。
	if (COORDINATOR_ONLY_TASK_ACTIONS.has(action)) {
		const identity = coordinatorCheckOf(ctx, caller, {
			tool: `board_task action=${action}`,
			why: '登记与裁决（建条 / 转派 / 删条 / 设依赖 / 改字段 / 重开）是协调者的事，不归执行者',
		})
		if (identity.ok !== true) return { ok: false, error: identity.reason }
	}
	if (Object.hasOwn(NATIVE_TASK_REFUSALS, action)) return { ok: false, error: NATIVE_TASK_REFUSALS[action] }
	if (action === 'register') {
		const subject = requireText(args.subject ?? args.description, 'subject')
		const called = await NL.boardCall(ctx, caller, 'create', {
			subject,
			description: optionalText(args.description, 'description') ?? subject,
			blockedBy: Array.isArray(args.blocked_by_tasks) ? args.blocked_by_tasks : [],
			writeScopes: Array.isArray(args.write_scopes) ? args.write_scopes : [],
		})
		if (called.ok !== true) return { ok: false, error: called.reason }
		// **每次成功改动之后顺手写交接快照**（复用既有账本管道）：新会话要能接得上这本账。
		return { ok: true, task: called.value, source: 'DSH 原生 Agent Teams 任务板', ...handoffReceiptOf(await recordHandoff(ctx, exec)) }
	}
	if (action === 'query') {
		const called = await NL.boardCall(ctx, caller, 'list', {})
		if (called.ok !== true) return { ok: false, error: called.reason }
		let rows = Array.isArray(called.value) ? called.value : []
		const wantStatus = optionalText(args.filter_status, 'filter_status')
		if (wantStatus !== undefined) {
			// **枚举外取值给一句可读说明**，而不是回一份没过滤的表或一个 0 条（"0 条"会被读成"没有待办"）。
			const native = NATIVE_STATUS_FILTERS[wantStatus]
			if (native === undefined) {
				return {
					ok: false,
					error: `filter_status 只认 ${Object.keys(NATIVE_STATUS_FILTERS).join(' / ')}（收到 ${JSON.stringify(wantStatus)}）。原生任务只有三档（pending / in_progress / completed）；「待验收」「已打回」是本产品文件看板的制度档，原生没有对应物，所以按它们过滤在这里没有意义。`,
				}
			}
			rows = rows.filter((row) => row?.status === native)
		}
		const wantOwner = optionalText(args.filter_owner, 'filter_owner')
		// 原生任务视图里负责人那一格叫 `ownerName`（不是 `owner`）—— 照着它筛，否则永远筛出空表。
		if (wantOwner !== undefined) rows = rows.filter((row) => (row?.ownerName ?? '') === wantOwner)
		// 「可认领」用**原生算好的那一格**（`ready` = 待办且依赖全部已完成），本文件不再自己推一遍。
		if (args.ready === true) rows = rows.filter((row) => row?.ready === true)
		return { ok: true, count: rows.length, rows, source: 'DSH 原生 Agent Teams 任务板' }
	}
	if (action === 'get') {
		const id = requireText(args.id, 'id')
		const called = await NL.boardCall(ctx, caller, 'get', { id })
		if (called.ok !== true) return { ok: false, error: boardErrorOf(id, called.reason) }
		return { ok: true, task: called.value }
	}
	const id = requireText(args.id, 'id')
	const fields = { taskId: id, action: nativeActionOf(action) }
	if (args.expected_revision !== undefined) fields.expectedRevision = args.expected_revision
	if (args.assignee !== undefined) fields.owner = args.assignee
	if (args.owner !== undefined) fields.owner = args.owner
	if (args.subject !== undefined) fields.subject = args.subject
	if (args.description !== undefined) fields.description = args.description
	if (args.write_scopes !== undefined) fields.writeScopes = args.write_scopes
	if (args.blocked_by_tasks !== undefined) fields.blockedBy = args.blocked_by_tasks
	// **改归属前先读一眼旧归属**：通知只在"真的换了人"时发（改派给同一个人 = 无操作，不发）。
	// 读失败**不挡改动**（读不到就是"不知道旧归属"⇒ 按"要发"处理，宁可多发一条也别让门铃哑掉）。
	let previousOwner = null
	let previousOwnerKnown = false
	if (fields.owner !== undefined) {
		const before = await NL.boardCall(ctx, caller, 'get', { id })
		if (before.ok === true && before.value !== null && typeof before.value === 'object') {
			previousOwner = typeof before.value.ownerName === 'string' ? before.value.ownerName : ''
			previousOwnerKnown = true
		}
	}
	const called = await NL.boardCall(ctx, caller, 'update', fields)
	if (called.ok !== true) return { ok: false, error: boardErrorOf(id, called.reason) }
	// **改派不等于叫它开工**（治根，见 `reassignNoticeOf`）：真换了归属 ⇒ 顺手投递一条最小通知。
	const reassign = await reassignNoticeOf(ctx, exec, caller, { action, id, task: called.value, previousOwner, previousOwnerKnown })
	// 同上：认领 / 收口 / 转派 / 设依赖……**每一次成功改动**都刷新快照（快照是派生物，失败只警告）。
	return {
		ok: true,
		task: called.value,
		...(reassign === null ? {} : { notified: reassign.notified, ...(reassign.note === undefined ? {} : { notifyNote: reassign.note }) }),
		...handoffReceiptOf(await recordHandoff(ctx, exec)),
	}
}

/**
 * **改派之后按一次门铃**（task-48，治根）：`reassign` 只改账，**不会唤醒承接人** ——
 * 宿主那侧是刻意这么定的（它自己的系统提示：`Task readiness never starts an owner`；唯一唤醒路径是消息），
 * 而工具面允许了一个"几乎总是错"的状态（协调器两轮都是"改了派却没人动"）⇒ 定性与修法都在这一处。
 *
 * 三条口径：
 *   · **只在归属真的变化时发**（改派给同一个人 = 无操作，不发）；
 *   · **投递失败不许让改派失败**：改派已经落账，回执里如实写"通知没发出去（原因）"；
 *   · 回执带 `notified`（成员名 / 失败原因），让协调器一眼知道"门铃按过没有"。
 * @returns `null`（这条动作不带 owner）或 `{ notified, note? }`。
 */
async function reassignNoticeOf(ctx, exec, caller, { action, id, task, previousOwner, previousOwnerKnown }) {
	if (action !== 'reassign' && action !== 'edit' && action !== 'update') return null
	const row = task !== null && typeof task === 'object' ? task : null
	const newOwner = row === null ? '' : typeof row.ownerName === 'string' ? row.ownerName : ''
	if (newOwner === '') return null
	if (previousOwnerKnown && previousOwner === newOwner) {
		return { notified: { target: newOwner, ok: true, sent: false }, note: `归属没变（还是 ${newOwner}）—— 没发通知。` }
	}
	const subject = row !== null && typeof row.subject === 'string' ? row.subject : ''
	const content =
		`看板把 \`${id}\` 改派给你（${subject}）：明细见卡上 \`description\`；做完 \`complete\` 回报协调器。`
	const sent = await NL.sendToTeammate(ctx, caller, { target: newOwner, content, signal: exec?.signal })
	if (sent.ok === true) return { notified: { target: newOwner, ok: true, sent: true } }
	return {
		notified: { target: newOwner, ok: false, sent: false, reason: sent.reason },
		note: `改派已落账，但**通知没发出去**（${sent.reason}）—— 要它动请另发 \`member_send\`。`,
	}
}

// ── 交接快照（跨会话续接的**派生物**） ───────────────────────────────────────
//
// 人的问题：「任务看板只在当前会话中能看到，『我的上下文已到极限』这种情况，新开一个会话工作区任务就
// 不能续接了。」根因不是 bug 而是当初"全切原生"的代价：成员与任务都在 DSH 原生 Agent Teams 里，
// 而原生队伍**按会话**（`TeamId = SessionId`）—— 任务存在会话日志里，新会话那本账**读不到**
// （唯一能读的路径是去动会话日志，那是宿主的地盘，不做）。
//
// 所以这一份是**工作区级的交接快照**：由 `board_task` 每次成功改动之后**顺手写**（上下文到极限是
// **突然**发生的，不能指望"收工前记得写"）。三条口径写死在这里：
//   · 它是**派生物**，不是第二本账 —— 真相仍在原生队伍日志里，这一份只为了让新会话接得上；
//   · 它是**快照**，不是实时看板 —— 文件里自带 `note`，人直接打开也读得懂；实时读数以 `team_status` 为准；
//   · **成员不能跨会话接手**（名册按会话）：快照只记"该叫哪些角色"，新会话要重新 `member_spawn`。

/** 快照文件里自带的那句话（人直接打开这个文件时，第一眼就该看懂它是什么）。 */
const HANDOFF_NOTE =
	'这是**交接快照**，不是实时看板：原生 Agent Teams 的任务板按会话（`TeamId = SessionId`），新会话从零开始；' +
	'实时读数以 `team_status` / `board_task query` 为准。**成员也不能跨会话接手**（名册按会话）—— ' +
	'`roles` 记的是"该叫哪些角色"，新会话要按它重新 `member_spawn role=<id>`（名字会是 `<角色>-1` 这种，不是沿用旧名字）。'

/** 空交接快照。只在本文件确实不在时使用。 */
function emptyHandoffLedger() {
	return { version: LEDGER_VERSION, seq: 0, note: HANDOFF_NOTE, at: '', sessionId: '', tasks: [], roles: [], members: [] }
}

/** 任务清单里那一格（只留接手要的四样：编号 / 标题 / 状态 / owner **角色**）。 */
function handoffTaskOf(row, roleOf) {
	const ownerName = typeof row?.ownerName === 'string' ? row.ownerName : ''
	const role = roleOf(ownerName)
	return {
		id: typeof row?.id === 'string' ? row.id : '',
		subject: typeof row?.subject === 'string' ? row.subject : '',
		status: typeof row?.status === 'string' ? row.status : '',
		// owner 那一格要的是**角色**（新会话是按角色重新叫人的）；反读不出来就原样写成员名，不编。
		owner: role !== '' ? role : ownerName,
	}
}

/**
 * 把当前的原生看板 + 名册压成一份交接快照写进工作区（复用既有账本管道：`transact` / `readLedger` / `commitLedger`）。
 *
 * **只警告不拦**：快照是派生物，写不进去不该让一次已经成功的任务改动变成失败（调用方 `recordHandoff` 兜住）。
 * @returns `{ ok: true, file, at, counts }` 或 `{ ok: false, reason }`。
 */
async function writeHandoffSnapshot(ctx, exec) {
	const workspace = workspaceRootOf(exec)
	const absPath = ledgerPath(workspace, LEDGER_FILE.handoff)
	const listed = await NL.boardCall(ctx, exec?.agent, 'list', {})
	if (listed.ok !== true) return { ok: false, reason: `读不到原生任务板：${listed.reason}` }
	const rows = Array.isArray(listed.value) ? listed.value : []
	// 角色清单从**文档侧那一份真相源**读（`lib/roster.js`），成员名 → 角色用薄层那一处约定（`NL.roleOfName`）——
	// 两处都不另写第二份判定。
	const roleIds = readRoster([], { includeUser: true }).roles.map((role) => role.id)
	const roleOf = (name) => (typeof name === 'string' && name !== '' ? NL.roleOfName(name, roleIds) : '')
	const members = await NL.listTeammates(ctx, exec?.agent)
	const rosterRows = members.ok === true ? members.rows : []
	const present = rosterRows.filter((row) => row.role !== 'lead')
	const roles = [...new Set(present.map((row) => roleOf(row.name)).filter((role) => role !== ''))]
	const tasks = rows.map((row) => handoffTaskOf(row, roleOf))
	const at = new Date().toISOString()
	const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
	const counts = {
		pending: tasks.filter((task) => task.status === 'pending').length,
		inProgress: tasks.filter((task) => task.status === 'in_progress').length,
		completed: tasks.filter((task) => task.status === 'completed').length,
	}
	await transact(ctx, absPath, exec, async () => {
		const snapshot = await readLedger(ctx, absPath, exec)
		const value = snapshot.kind === 'absent' ? emptyHandoffLedger() : snapshot.value
		const next = {
			...value,
			version: LEDGER_VERSION,
			// `seq` 在这里是**快照的版本号**（每写一次 +1），不是编号空间的序号 —— 这个文件里没有编号族。
			seq: (Number.isFinite(value.seq) ? value.seq : 0) + 1,
			note: HANDOFF_NOTE,
			at,
			sessionId,
			tasks,
			roles,
			members: present.map((row) => ({ name: row.name, role: roleOf(row.name), status: row.status })),
		}
		await commitLedger(ctx, absPath, snapshot, next, exec)
	})
	return { ok: true, file: absPath, at, counts }
}

/** **首份**快照的 `note`：在标准那句后面补一句"这里还没有看板活动"，免得读的人以为这是交接。 */
const FIRST_HANDOFF_NOTE =
	HANDOFF_NOTE + ' **本工作区第一次跑团队会话，还没有看板活动** —— 登记第一条任务之后，这里由看板改动自动刷新。'

/**
 * **装载时建立首份快照**（没有那份文件才写）。
 *
 * 为什么要有这一步：快照原先是"**看板改动之后**才写" ⇒ 一个只开过会话、只问过事（`query` / `get`）
 * 的工作区**永远不会有这个文件**（现场：人新开一个工作区，那里什么都没有）。所以装载时先落一份空的。
 *
 * **最关键的一条：文件已存在就绝不动它** —— 否则"新会话一打开"就会把上一次那份交接（可能正是唯一
 * 有价值的那份）覆盖成空的。判断与写入都在同一条 `transact` 队列里，进程内不会两条并发各写一份。
 * @param ctx - 上下文。
 * @param exec - 带 `agent` 的调用方（装载钩子传 `{ agent }`）。
 * @returns `{ ok: true, created: boolean, file }` 或 `{ ok: false, reason }`。
 */
export async function ensureHandoffSnapshot(ctx, exec) {
	const workspace = workspaceRootOf(exec)
	const absPath = ledgerPath(workspace, LEDGER_FILE.handoff)
	try {
		return await transact(ctx, absPath, exec, async () => {
			const snapshot = await readLedger(ctx, absPath, exec)
			// **已存在 ⇒ 什么都不做**（这里是整件事的重点：装载不许覆盖上一次的交接）。
			if (snapshot.kind !== 'absent') return { ok: true, created: false, file: absPath }
			const at = new Date().toISOString()
			const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
			const next = { ...emptyHandoffLedger(), note: FIRST_HANDOFF_NOTE, at, sessionId }
			await commitLedger(ctx, absPath, snapshot, next, exec)
			return { ok: true, created: true, file: absPath, at, sessionId }
		})
	} catch (error) {
		return { ok: false, reason: failureReason(error) }
	}
}

/** 写快照的**兜底**：这是派生物，失败只回一句警告，绝不把一次已经成功的任务改动说成失败。 */
async function recordHandoff(ctx, exec) {
	try {
		return await writeHandoffSnapshot(ctx, exec)
	} catch (error) {
		return { ok: false, reason: failureReason(error) }
	}
}

/** 收到回执里那一格（成功写进快照 ⇒ 给文件路径与时刻；失败 ⇒ 给一行 `warnings`）。 */
function handoffReceiptOf(handoff) {
	return handoff.ok === true
		? { handoff: { file: handoff.file, at: handoff.at, counts: handoff.counts } }
		: { warnings: [`交接快照没写成功（不影响这次看板改动）：${handoff.reason}`] }
}

/** `team_status`：两行 —— 分栏计数用**原生那一档的名字**，卡住的单列一行。 */
async function nativeTeamStatus(ctx, exec) {
	const called = await NL.boardCall(ctx, exec?.agent, 'list', {})
	if (called.ok !== true) return { ok: false, error: `读不到原生任务板：${called.reason}` }
	const rows = Array.isArray(called.value) ? called.value : []
	const countOf = (status) => rows.filter((row) => row?.status === status).length
	const line = `待办 ${countOf('pending')} · 进行中 ${countOf('in_progress')} · 已完成 ${countOf('completed')}`
	// **卡住 = 依赖还没全完成**（不是"写了依赖"就算卡住）：一条依赖已全部完成的待办只是还没人认领，
	// 把它列进「卡住」会同时把它挡在「可认领」之外 —— 两个结论互相打架，人就不知道该不该开工。
	const statusById = new Map(rows.map((row) => [row?.id, row?.status]))
	const stuck = rows
		.filter((row) => row?.status !== 'completed' && Array.isArray(row?.blockedBy) && row.blockedBy.some((id) => statusById.get(id) !== 'completed'))
		.map((row) => `${row.id} 等 ${row.blockedBy.join('、')}`)
	// 「可认领」直接用**原生算好的那一格**（`ready` = 待办且依赖全完成，宿主 `projectTaskView` 给的）。
	const ready = rows.filter((row) => row?.ready === true)
	return { ok: true, line, stuck, ready: ready.map((row) => row.id), source: 'DSH 原生 Agent Teams 任务板' }
}


// ── 人的话（目标 / 约束 / 偏好 / 否决理由）────────────────────────────────────

/**
 * 空「人的话」文件。只在本文件确实不在时使用。
 *
 * 这份文件**按需建立**：没有记过任何一条时文件不存在，是正常状态而非异常 ——
 * 于是「文件不在」与「文件在但读不成」必须分开读：前者是「没记过」，后者是「读不到」。
 */
function emptyHumanLedger() {
	return { version: LEDGER_VERSION, seq: 0, words: [] }
}

/**
 * 记一条的规范性告警。**只说这条记录自己缺什么、以及缺了会怎样**，不改写调用方给的原话。
 * 文件里没有「改一条」的入口（只有记账），所以一处毛病在写下时就该被人看见。
 */
function humanWordWarnings({ text, kind, reason }) {
	const warnings = []
	if (text.length > HUMAN_TEXT_MAX_CHARS) {
		warnings.push(`这一句话长度 ${text.length} 字符，超过 ${HUMAN_TEXT_MAX_CHARS} 字符上限：这份文件要压进每个会话开局的注入，一条散文会把注入挤掉；把长说明写进产物、这里只留那句话本身。`)
	}
	if (kind === 'veto' && (reason === undefined || reason === '')) {
		warnings.push('否决理由没给 reason：这条记录就只剩一个「不许」，下一个会话读不出为什么被否，也就躲不开同一个问题再问一次 —— 那正是这份文件要治的那个毛病。')
	}
	return warnings
}

/**
 * 记一条人说过的话，分配 HD-<三位序号>。
 *
 * **记录人由写入路径决定，不由参数决定**（与其余写入口同一口径）：会话里的工具调用记
 * `agent`（AI 代记），面板那条路径记 `human`（人亲录）。工具参数里没有 `by`，模型改不了这个值。
 * 它记的**不是**「这句话是谁说的」—— 这份文件里的每一句都是人说的，那是它的定义；
 * 它记的是**这一条由谁落的笔**，于是「AI 转述过」与「人自己写的」在文件上可分辨。
 * @param actor - `'agent'`（会话工具路径，缺省）或 `'human'`（面板路径）。取不到就是 `agent`。
 */
export async function recordHumanWords(ctx, exec, args, actor) {
	const text = requireText(args.text, 'text')
	const kind = requireEnum(args.kind, HUMAN_KINDS, 'kind')
	const by = actor === 'human' ? 'human' : 'agent'
	// 空串与不给同义：一条空理由等于没有理由，不留一个空字符串装成"给过理由"。
	const rawReason = optionalText(args.reason, 'reason')
	const reason = rawReason === undefined || rawReason === '' ? undefined : rawReason
	const workspace = workspaceRootOf(exec)
	const absPath = ledgerPath(workspace, LEDGER_FILE.human)
	const warnings = humanWordWarnings({ text, kind, reason })

	return transact(ctx, absPath, exec, async () => {
		const snapshot = await readLedger(ctx, absPath, exec)
		const value = snapshot.kind === 'absent' ? emptyHumanLedger() : snapshot.value
		const words = collectionOf(value, absPath, 'words')
		const number = nextNumber(value.seq, numbersOf(words))
		const id = formatId(ID_PREFIX.human, number)
		// `at` 是**记录时刻**（落库那一刻），不是"人说话的那一刻" —— 两者可以差很远，
		// 名字与实际含义不许互相顶替：要写后者就写进 text，别让读的人把前者当成后者。
		const word = { id, kind, text, ...(reason === undefined ? {} : { reason }), by, at: new Date().toISOString() }
		const next = { ...value, version: LEDGER_VERSION, seq: number, writer: writerStamp(), words: [...words, word] }
		await commitLedger(ctx, absPath, snapshot, next, exec)
		return { id, word, file: absPath, warnings: [...warnings, ...foreignWriterWarnings(value)] }
	})
}

/** 渲染「人的话」Markdown 表；单元格里的竖线转义，避免表格错列。 */
function renderHumanTable(words) {
	const header = '| 编号 | 类别 | 人说的话 | 理由 | 记录人 | 记录时间 |'
	const divider = '| --- | --- | --- | --- | --- | --- |'
	const cell = (value) => String(value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
	const rows = words.map(
		(word) =>
			`| ${cell(word.id)} | ${cell(HUMAN_KIND_LABEL[word.kind] ?? word.kind)} | ${cell(word.text)} | ${cell(word.reason)} | ${cell(word.by)} | ${cell(word.at)} |`,
	)
	const body = rows.length === 0 ? ['| — | — | （本筛选下没有记录） | — | — | — |'] : rows
	return [header, divider, ...body].join('\n')
}

/**
 * 列出人说过的话；按类筛选是可选的；只读，不入队。
 *
 * 「读不到」分两档，且**两档不许互相顶替**：
 *   · 文件不在（结构化「未找到」）⇒ 按空文件回答，并在告警里写明这是**按需建立**的正常状态；
 *   · 文件在但读不成 / JSON 坏 / `words` 不是数组 ⇒ 引擎按既有口径抛读取失败，工具回
 *     `{ok:false}`。**不降级成空文件** —— 那会把「读不到」说成「人没说过」。
 * `kind` 给了空串等同于不给（未筛选）；给了枚举外的取值当场拒收，不静默收下 ——
 * 静默收下的后果是筛出来的集合悄悄少了一批，而调用方以为筛过了。
 */
async function listHumanWords(ctx, exec, args) {
	const requested = optionalText(args.kind, 'kind')
	const kind = requested === undefined || requested === '' ? undefined : requireEnum(requested, HUMAN_KINDS, 'kind')
	const workspace = workspaceRootOf(exec)
	const absPath = ledgerPath(workspace, LEDGER_FILE.human)
	const snapshot = await readLedger(ctx, absPath, exec)
	const warnings = foreignWriterWarnings(snapshot.kind === 'absent' ? null : snapshot.value)
	if (snapshot.kind === 'absent') {
		warnings.push(`人的话记录尚未建立：${absPath}；当前按空文件回答 —— 这份文件按需建立，没记过任何一条时它本来就不存在（这不等于「读不到」）。`)
	}
	const words = snapshot.kind === 'absent' ? [] : collectionOf(snapshot.value, absPath, 'words')
	const matched = words.filter((word) => kind === undefined || word?.kind === kind)
	return {
		file: absPath,
		total: words.length,
		matched: matched.length,
		kind: kind ?? 'all',
		words: matched,
		markdown: renderHumanTable(matched),
		warnings,
	}
}

// ── 成员名册（基线 §十一.11） ────────────────────────────────────────────────
//
// **成员 = 可续聊的子代理 + 文件里的一条身份**，两样缺一不可：只有子代理没有文件 ⇒ 下次谁也找
// 不着它；只有文件没有子代理 ⇒ 名册上挂着一个不存在的人。所以本节字段就围这两样转：
// `id`（`MB-<序号>`）与 `session`（宿主子代理的持久会话 id，**与编号分开存、不许混用**）。
//
// 名册只记**事实**：谁、这次戴哪顶帽子（角色技能）、在干什么、会话 id 多少、什么状态、最后动静
// 什么时候。它**不做调度**：成员唤醒走宿主现成的 `send_message`，本引擎不造投递通道；
// 「做完归档不删」「退役是显式动作」也只是写状态，不销毁会话、不删条目。

/**
 * 看板条目的状态索引：`编号 → 状态`。
 *
 * 只在 `memberSnapshot` 内用于把归属派生出来的编号落到看板实际上 —— **这是"成员链接了哪些
 * 任务"的唯一一处判定**。明确**不**做的事：不按 `board.owner`（那是角色名）去对齐成员，
 * 不从 `task` 自由文本里抓编号 —— 两条都已由设计点名否掉（会把活算错人头）。
 *
 * @param boardTasks - 看板文件里的条目数组；**undefined 表示看板文件读不到**（不是"空看板"）。
 * @returns 编号到状态的映射；读不到时返回 null（与"读了、是空的"区分开）。
 */
function boardStatusIndex(boardTasks) {
	if (!Array.isArray(boardTasks)) return null
	const index = new Map()
	for (const task of boardTasks) {
		if (task === null || typeof task !== 'object') continue
		if (typeof task.id !== 'string') continue
		index.set(task.id, task.status)
	}
	return index
}

/**
 * 一名成员的交付读数（派生，**不是**文件字段）。
 *
 * 判定条件（写死在这里，改这里即改判定条件；口径由协调器于 T-039 D1 裁决 = 按设计 §3.2）：
 *   · `assigned` = **能在看板文件里查到的** 归属条目数 —— 分母必须是**真实存在的任务**；
 *   · `delivered` = 其中在看板文件里 `status === '已完成'` 的条数（它是 `assigned` 的子集）；
 *   · `missing` = 查不到的编号的条数，`missingIds` 把它们**点名**出来。
 *     **`missing` 不进分子、也不进分母**：把查不到的编号算成工作量，等于让"打错编号 / 忘了改字段"
 *     显示成"这个人交付率下降"—— 那是拿坏数据惩罚成员。悬空链接**不靠分母暴露、靠点名暴露**：
 *     只要 `missing > 0`，Markdown 那一格与回执的 `warnings` 都**必须**同时出现「链接失效 n 条：…」，
 *     不许只出一个比率把坏链接藏起来（判定即 `missing > 0`，两处同源）。
 * 看板文件读不到（`statusById === null`）时三个数**一律记 null 且不给数**：
 * 拿不到看板 ≠ 零交付，把它算成 0 会让人以为"干完的活没了"。
 *
 * @param ids - 归属派生出来的编号。
 * @param statusById - `boardStatusIndex` 的结果；null = 看板文件读不到。
 */
function memberLinkedOf(ids, statusById) {
	if (statusById === null) {
		return { assigned: null, delivered: null, missing: null, missingIds: null, boardUnavailable: true }
	}
	const missingIds = ids.filter((id) => !statusById.has(id))
	const found = ids.filter((id) => statusById.has(id))
	return {
		assigned: found.length,
		delivered: found.filter((id) => statusById.get(id) === BOARD_DONE_STATUS).length,
		missing: missingIds.length,
		missingIds,
		boardUnavailable: false,
	}
}

/**
 * 成员在看板上的编号集合 —— **派生，只有一条路**：看板上归属给它的条目
 * （`assignee === 成员名`，以及 `assignee` 缺失但 `owner === 成员名` 的）。
 *
 * 这一路随认领 / 转派 / 收口自动变，不需要谁在派发那一刻手抄一遍编号；**名册里不存链接**
 * （存两份就会漂）。空集即**未链接**，由 `memberLinkedOf` 判存在性。
 */
function memberBoardIdsOf(member, boardTasks) {
	const name = typeof member?.name === 'string' && member.name.trim() !== '' ? member.name.trim() : undefined
	const derived = []
	if (name !== undefined && Array.isArray(boardTasks)) {
		for (const task of boardTasks) {
			if (task === null || typeof task !== 'object' || typeof task.id !== 'string') continue
			const owned = task.assignee === name || (task.assignee === undefined && task.owner === name)
			if (owned && !derived.includes(task.id)) derived.push(task.id)
		}
	}
	return { ids: derived, derivedIds: derived }
}

/**
 * 「谁在干什么」的**唯一一处判定**：看板上开着执行代、且归属（`assignee`）等于成员名的条目。
 *
 * 为什么要派生而不是让运行时往名册里再写一笔：写两处就有两处会漂 —— 认领、转派、收口、
 * 退役释活都会换归属或作废执行代，靠"记得改名册"必然漏。于是名册里那个手写的 `task` 字段
 * 降级成"派活时的意图指针"，只在没有执行代时显示；面板、`member_list` 与 Markdown 表读的都是这一处。
 * @param boardTasks - 看板条目；不给或不是数组时返回空 Map。
 * @returns `Map<成员名, 看板条目>`。
 */
export function openAttemptsByMember(boardTasks) {
	const byMember = new Map()
	for (const task of Array.isArray(boardTasks) ? boardTasks : []) {
		if (!taskHasOpenAttempt(task)) continue
		const name = typeof task?.assignee === 'string' && task.assignee !== '' ? task.assignee : undefined
		if (name === undefined || byMember.has(name)) continue
		byMember.set(name, task)
	}
	return byMember
}

/**
 * 破线理由行：取**在场成员里编号最大**的那条 `line_reason`。
 *
 * 为什么记在人身上而不是文件顶层：破线是**加人那一刻**发生的，理由天然属于「加进来的那一个」，
 * 记在人身上就不可能出现两个人各说一份。取不到返回空串 —— 字段在、可以为空
 * （基线：破线不拦，但要有理由位）。
 */
function memberLineReason(members) {
	const carriers = members.filter((member) => member?.status === MEMBER_PRESENT_STATUS && typeof member?.line_reason === 'string' && member.line_reason !== '')
	if (carriers.length === 0) return ''
	return carriers.reduce((latest, member) => ((idNumber(member.id) ?? 0) > (idNumber(latest.id) ?? 0) ? member : latest)).line_reason
}

/**
 * 「已交付」一格的文案：三档**逐字可判**，与 `memberSnapshot` 的 JSON 数逐条同源。
 *   · 未链接（看板里没有归属给它的条目）⇒ 印「未链接（显示最后动笔）」，**绝不印 `0/0`**：
 *     `0/0` 会被读成"链接了、零条交付"，而真相是这个成员压根没链接过任何任务。
 *   · 看板文件读不到 ⇒ 印「不给数（看板文件读不到）」，**不印 0** —— 读不到不是零交付。
 *   · 已链接 ⇒ `已交付 <delivered>/<assigned>`（`assigned` 只数**在看板里查得到的**编号）。
 * **`missing > 0` 时必须同时带出「链接失效 n 条：…」**（协调器 D1 裁决的硬要求）：坏链接
 * 不进分母，就只剩这一个暴露口，不许被一个漂亮的比率盖住。链接的编号**全部查不到**时
 * 分母是 0，此时**不印 `0/0`**（那与"未链接"的空读数长得一样），改印「有效链接 0 条」。
 */
function memberLinkedCell(member) {
	const linked = member?.linked
	if (linked === null || linked === undefined) return '未链接（显示最后动笔）'
	if (linked.boardUnavailable === true || linked.assigned === null) return '不给数（看板文件读不到）'
	const stale = linked.missing > 0 ? `链接失效 ${linked.missing} 条：${linked.missingIds.join('、')}` : ''
	const head = linked.assigned === 0 ? '有效链接 0 条' : `已交付 ${linked.delivered}/${linked.assigned}`
	return stale === '' ? head : `${head}；${stale}`
}

/** 「看板编号」一格的文案：归属派生出来的编号；空集即未链接。 */
function memberBoardIdsCell(linked) {
	const ids = linked !== null && linked !== undefined && Array.isArray(linked.ids) ? linked.ids : []
	if (ids.length === 0) return '—'
	return ids.join('、')
}

/**
 * 渲染成员 Markdown 表；单元格里的竖线转义，避免表格错列。
 *
 * `看板编号`、`已交付` 与 `linked` **一一对应**：面板（JSON）与
 * 会话里（Markdown）读的是同一份派生，本表不另算任何数。
 */
function renderMemberTable(members) {
	const header = '| 成员 | 名称 | 角色技能 | 运行时 | 当前任务 | 看板编号 | 已交付 | 子会话 id | 编制状态 | 最后活动 | 退役原因 → 接手人 |'
	const divider = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
	const cell = (value) => String(value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
	const rows = members.map((member) => {
		const retired =
			member?.status === MEMBER_RETIRED_STATUS
				? `${member.retire_reason ?? '（未写原因）'} → ${member.replaced_by ?? '（未写接手人）'}`
				: '—'
		return `| ${cell(member?.id)} | ${cell(member?.name)} | ${cell(member?.role)} | ${cell(memberRuntimeCell(member))} | ${cell(member?.attemptTask ?? member?.task)} | ${cell(memberBoardIdsCell(member))} | ${cell(memberLinkedCell(member))} | ${cell(member?.session)} | ${cell(member?.status)} | ${cell(member?.last_active_at)} | ${cell(retired)} |`
	})
	const body = rows.length === 0 ? ['| — | — | — | （本筛选下没有成员） | — | — | — | — | — | — | — |'] : rows
	return [header, divider, ...body].join('\n')
}

/**
 * 「运行时」一格的文案：状态 + 未读邮箱 + 执行代，**缺哪样就不印哪样**。
 *
 * 口径：`runtime` 由运行时那半边读写（`running` / `inactive` / `provisioning` / `failed`）；
 * 名册里没有这个字段时印 `—` —— 那是「运行时没写过」（老文件，或本会话没装运行时那半边），
 * **不是「空闲」**：把读不到说成空闲，会让人以为这个成员随时能接活。
 */
function memberRuntimeCell(member) {
	const parts = []
	if (typeof member?.runtime === 'string' && member.runtime !== '') parts.push(member.runtime)
	const unread = Number.isInteger(member?.mailbox_unread) && member.mailbox_unread > 0 ? member.mailbox_unread : 0
	if (unread > 0) parts.push(`未读 ${unread}`)
	if (Number.isInteger(member?.attempt) && member.attempt > 0 && typeof member?.attemptId === 'string') parts.push(`执行代 #${member.attempt}`)
	return parts.length === 0 ? '—' : parts.join(' · ')
}

/**
 * 这个角色的**主成员**名字：在场成员里最早来的那一位；没有在场的就取最早的归档成员；都没有就是 `undefined`。
 *
 * 主成员是这一档的常驻成员（主线活优先派给它，它上下文里有工作区的全貌；副成员接边角活，
 * 复用同一位成员比每次新建省一次冷启动）。**派生**而不落字段：不必迁移，也不会出现"两个主成员"。
 * @param members - 名册行数组。
 * @param role - 角色 id；`undefined` 时按全部行算（只用来判定"某一行是不是它那一档的主成员"）。
 * @returns 成员名或 undefined。
 */
export function rolePrimaryName(members, role) {
	const rows = (Array.isArray(members) ? members : []).filter(
		(row) => row !== null && typeof row === 'object' && row.runtime !== 'failed' && (role === undefined || row.role === role),
	)
	const first = rows.filter((row) => row.status === MEMBER_PRESENT_STATUS)
	const pool = first.length > 0 ? first : rows.filter((row) => row.status === MEMBER_ARCHIVED_STATUS)
	if (pool.length === 0) return undefined
	// "最早来的"按**成员编号**排（`MB-<序号>` 单调递增，是名册里唯一天生有序的字段）；
	// 编号缺失或形状不对的行排在最后，不参与争夺主成员。
	const rankOf = (row) => {
		const matched = typeof row.id === 'string' ? /^MB-(\d+)$/.exec(row.id) : null
		return matched === null ? Number.MAX_SAFE_INTEGER : Number(matched[1])
	}
	let best
	for (const row of pool) {
		if (typeof row.name !== 'string' || row.name === '') continue
		if (best === undefined || rankOf(row) < rankOf(best)) best = row
	}
	return best?.name
}

export function memberSnapshot(input) {
	const members = input?.members
	const warnLine = Number.isInteger(input?.warnLine) && input.warnLine >= 0 ? input.warnLine : MEMBER_WARN_LINE
	const status = input?.status
	const boardTasksInput = input?.boardTasks
	const statusById = boardStatusIndex(boardTasksInput)
	if (members === undefined) {
		return {
			established: false,
			present: null,
			archived: null,
			retired: null,
			total: null,
			warnLine,
			overLine: null,
			reasonLine: '',
			rows: [],
			warnings: [],
			markdown: [`**在场 ? / 告警线 ${warnLine}**`, `> 名册文件尚未建立 —— ${MEMBER_UNESTABLISHED_HOW}`].join('\n'),
		}
	}
	// **每个角色的"主成员"**：在场的成员里最早来的那一位（没有在场的就取最早的归档成员）。
	// 口径的理由：主成员是这一档的**常驻成员** —— 主线活优先派给它，上下文里有工作区的全貌；
	// 用"最早来的一位"而不是新存一个字段：不必迁移，也不会出现"两个主成员"或"没有人是主成员"。
	const primaryName = rolePrimaryName(members, undefined)
	const countOf = (value) => members.filter((member) => member?.status === value && hasArrived(member)).length
	const present = countOf(MEMBER_PRESENT_STATUS)
	const overLine = present > warnLine
	const reasonLine = memberLineReason(members)
	const lines = [`**在场 ${present} / 告警线 ${warnLine}**`]
	if (overLine) {
		lines.push(
			`> 破线理由：${reasonLine === '' ? `（未写理由行 —— 加人时用 member_spawn 的 line_reason 补记一行「为什么需要第 ${present} 个」）` : reasonLine}`,
		)
	}
	// 派生 `linked`：看板归属（assignee === 成员名）；
	// 两路都空 ⇒ `null`（未链接，卡右侧显示最后动笔，**不是 `0/0`**）。键在但不是数组
	// （手改过文件）⇒ 按未链接处理并告警，不把读不出的字段当零条。
	const warnings = []
	const linkedOf = (member) => {
		const { ids } = memberBoardIdsOf(member, boardTasksInput)
		if (ids.length === 0) return null
		return memberLinkedOf(ids, statusById)
	}
	const selected = status === undefined ? members : members.filter((member) => member?.status === status)
	const openByMember = openAttemptsByMember(boardTasksInput)
	const rows = selected.map((member) => {
		const open = typeof member?.name === 'string' ? openByMember.get(member.name) : undefined
		return {
			...member,
			// **`status` 保持文件里的原值**（它是"枚举外状态"那条检查的输入，不许被显示值覆盖）；
			// 另给一个显示用的派生值：创建失败的行显示「未到场」（文件里仍写 `在场` —— 那是名字占位那一笔的记录）。
			statusWord: hasArrived(member) ? member.status : MEMBER_UNARRIVED_STATUS,
			// **主成员标记**（面板上要有别）：同一角色里最早来的那位在场成员。
			primary: typeof member?.name === 'string' && rolePrimaryName(members, member.role) === member.name,
			linked: linkedOf(member),
			...(open === undefined
				? {}
				: {
						attemptTask: open.id,
						attempt: Number.isInteger(open.attempt) ? open.attempt : 0,
						...(taskAttemptIdOf(open) === undefined ? {} : { attemptId: taskAttemptIdOf(open) }),
					}),
		}
	})
	if (statusById === null) {
		const linkedCount = rows.filter((row) => row.linked !== null).length
	}
	for (const row of rows) {
		if (row.linked === null || row.linked.missing === null || row.linked.missing === 0) continue
		warnings.push(`成员 ${row.id} 的链接里有 ${row.linked.missing} 个编号在看板文件里查不到：${row.linked.missingIds.join('、')}；**点名列出**、不静默丢弃（卡上显示「链接失效 ${row.linked.missing} 条」）。`)
	}
	return {
		established: true,
		present,
		archived: countOf(MEMBER_ARCHIVED_STATUS),
		retired: countOf(MEMBER_RETIRED_STATUS),
		total: members.length,
		warnLine,
		overLine,
		reasonLine,
		rows,
		warnings,
		markdown: [...lines, renderMemberTable(rows)].join('\n'),
	}
}




// ── 产物校验 ─────────────────────────────────────────────────────────────────

/** 用规则里的正则收集文本中出现的编号（去重）。 */
function idsIn(text, pattern) {
	const matched = text.match(pattern)
	if (matched === null) return []
	return [...new Set(matched)]
}

/**
 * 该行是否在「声明」编号：Markdown 标题行，或带「编号／ID」标注的行。
 * 表格行与正文里的编号只是引用（索引、关联、清单总览都会列别人的编号），不算声明。
 */
function isDeclarationLine(line) {
	return /^#{1,6}\s/.test(line) || /(编号|ID|Id)\s*[:：]/.test(line)
}

/** 该文件声明过哪些编号，按出现顺序去重。 */
function declaredIds(text, pattern) {
	const declared = []
	for (const line of text.split(/\r?\n/)) {
		if (!isDeclarationLine(line)) continue
		for (const id of idsIn(line, pattern)) if (!declared.includes(id)) declared.push(id)
	}
	return declared
}

/** 编号唯一性：扫描同目录的 Markdown，检出以声明形式重复的编号；引用不算重复。 */
async function uniquenessFindings(ctx, ownAbsPath, ids, kind, pattern) {
	const violations = []
	const warnings = []
	const directory = dirNameOf(ownAbsPath)
	let entries
	try {
		entries = await ctx.fs.listDir(await resolveTarget(ctx, directory, undefined), undefined)
	} catch (error) {
		warnings.push(`编号唯一性未校验：无法列出同目录（原因：${failureReason(error)}），本项结论为「未校验」。`)
		return { violations, warnings }
	}
	const siblings = entries.filter((entry) => entry?.type === 'file' && /\.md$/i.test(entry.name))
	if (siblings.length > UNIQUENESS_SCAN_MAX) {
		warnings.push(`同目录有 ${siblings.length} 个 Markdown 文件，本次只扫描前 ${UNIQUENESS_SCAN_MAX} 个，编号唯一性未全量校验。`)
	}
	for (const sibling of siblings.slice(0, UNIQUENESS_SCAN_MAX)) {
		const path = joinPath(directory, sibling.name)
		if (path === ownAbsPath) continue
		let text
		try {
			const snapshot = await readTextSnapshot(ctx, path, undefined)
			if (snapshot.kind !== 'present') continue
			text = snapshot.text
		} catch (error) {
			warnings.push(`编号唯一性未全量校验：${path} 读取失败（原因：${failureReason(error)}）。`)
			continue
		}
		const siblingDeclared = declaredIds(text, pattern)
		for (const id of ids) {
			if (siblingDeclared.includes(id)) {
				violations.push(`编号 ${id} 在同目录的 ${sibling.name} 里也以标题或「编号：」标注声明，违反编号唯一（对照范围：同目录 Markdown 的编号声明，未被读到的文件见 warnings）。`)
			}
		}
	}
	if (kind === 'generic' && ids.length > 1) {
		warnings.push(`通用产物里出现多个编号 ${ids.join(' / ')}，请确认哪个是本产物的编号。`)
	}
	return { violations, warnings }
}

/** 校验一个产物文件：编号唯一、故事追溯、模板要素齐全。 */
async function checkArtifact(ctx, exec, args) {
	const kind = requireEnum(args.kind, Object.keys(ARTIFACT_RULES), 'kind', 'generic')
	const requested = requireText(args.path, 'path')
	const workspace = workspaceRootOf(exec)
	const absPath = artifactPath(workspace, requested)
	const rule = ARTIFACT_RULES[kind]
	const snapshot = await readTextSnapshot(ctx, absPath, exec)
	if (snapshot.kind === 'absent') throw new Error(`产物未找到：${absPath}（kind=${kind}）。`)
	const text = snapshot.text
	const violations = []
	const warnings = []

	const mentions = idsIn(text, rule.idPattern)
	const declared = declaredIds(text, rule.idPattern)
	const ids = declared.length > 0 ? declared : mentions
	if (mentions.length === 0) violations.push(`模板要素：未找到符合 ${rule.idSpec} 的编号。`)
	if (declared.length === 0 && mentions.length > 0) {
		warnings.push('未发现标题或「编号：」标注形式的编号声明；编号唯一性按正文里首次出现的编号，对照同目录文件声明过的编号。')
	}

	for (const element of rule.elements) {
		if (!element.test(text)) violations.push(`模板要素：缺少「${element.key}」。`)
	}

	const traceOk = rule.trace.test(text)
	if (!traceOk) {
		const message = `故事追溯：缺少 ${rule.trace.spec}。`
		if (rule.trace.warnOnly) warnings.push(message)
		else violations.push(message)
	}

	const unique = await uniquenessFindings(ctx, absPath, ids, kind, rule.idPattern)
	violations.push(...unique.violations)
	warnings.push(...unique.warnings)

	return { path: absPath, kind, id: ids.length > 0 ? ids[0] : null, ids, violations, warnings }
}

// ── 工具装配 ─────────────────────────────────────────────────────────────────

/**
 * 统一的工具定义：参数 schema 用原始 JSON Schema（注册表直接投影给模型），
 * 输出声明为字符串，`execute` 把动作结果序列化成 JSON 字符串。
 * 一切失败都在这里转成 `{ ok: false, error }`，不向调用方抛异常。
 */
function textTool(options) {
	return {
		name: options.name,
		description: options.description,
		parameters: options.parameters,
		output: {
			schema: { type: 'string', description: 'JSON 字符串：成功形如 {"ok":true,...}，失败形如 {"ok":false,"error":"原因"}。' },
			render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
		},
		async execute(args, exec) {
			try {
				return okJson(await options.run(args ?? {}, exec ?? {}))
			} catch (error) {
				return failJson(error)
			}
		},
	}
}

/** 登记全部工具。apply 必须是同步函数，异步只发生在各 handler 内。 */
export function apply(ctx) {
	// **一进程只挂一次**（幂等，理由同 team-runtime.js 顶部那段）：旧预设副本 + 插件宿主行
	// 两条路都可能来挂同一份制度层 ⇒ 第二次直接返回。
	try {
		const key = ctx?.root ?? ctx
		if (gateMounted.has(key)) {
			ctx.logger?.info?.('team-ops 制度层：这个运行时里已经挂过一次，跳过（幂等）。')
			return
		}
		gateMounted.add(key)
	} catch {
		// 同上
	}

	ctx.tools.register(
		textTool({
			name: 'human_words_record',
			description: [
				'记一条人说过的话，成为一等对象：**人的决定与约束** —— 目标 / 约束 / 偏好 / 否决理由（含口头的、含理由）。返回编号 HD-<三位序号>。',
				'',
				'为什么要有它：系统里其余对象都是 AI 产的（任务、决策包、产物、轮次），人的判断只以散落的对话存在，下一个会话的 AI 读不到；人最贵的产出就是他的判断。',
				'**开局注入**（`lib/ledger-digest.js` 那条 hook）会把这份文件压成一段带进每个新会话与每次提示词提交 —— 于是下一个会话不必靠人重说，同一个问题也就不必再问一遍。',
				'',
				'类别取值只此四类，写别的取值当场拒收、不许自造：goal 目标 / constraint 约束 / preference 偏好 / veto 否决理由。',
				'text 写**人说过的那句话本身**：能逐字就逐字；做不到就在 text 里自带「转述」两个字，别让读的人以为那是原话。',
				'reason 可选；但 `veto` 不给 reason 会告警 —— 只剩一个「不许」的记录，下一个会话读不出为什么被否。',
				'**记录人不可填**：本工具落的记录一律记 `agent`（AI 代记），只有人在面板上点的才记 `human` —— 由写入路径决定，没有可填的 `by` 参数。',
				'记录时刻 `at` 是**落库那一刻**，不是人说话的那一刻；两者可以差很远，要写后者就写进 text。',
				'',
				'参数：text（必填，人说过的那句话）、kind（必填，四类之一）、reason（可选，为什么）。',
				'',
				WRITE_BOUNDARY_HUMAN,
			].join('\n'),
			parameters: {
				type: 'object',
				properties: {
					text: { type: 'string', description: `人说过的那句话本身（≤${HUMAN_TEXT_MAX_CHARS} 字符为宜，超出只告警）；转述请在句子里自带「转述」字样。` },
					kind: { type: 'string', enum: HUMAN_KINDS, description: '算哪一类：goal 目标 / constraint 约束 / preference 偏好 / veto 否决理由。' },
					reason: { type: 'string', description: '为什么（可选）；否决理由不给会在回执里告警。' },
				},
				required: ['text', 'kind'],
				additionalProperties: false,
			},
			run: (args, exec) => {
				// **协调器专属**：描述里那句"这份文件的写入应由协调器（主会话）发起"从前只是一句话，
				// 现在它是这道门（判据的唯一正文在 `coordinatorCheckOf`）。成员只能读人的话
				// （`human_words_list`），要记就回给协调者 —— 别让它替人记判断。
				const identity = coordinatorCheckOf(ctx, exec?.agent, {
					tool: 'human_words_record',
					why: '「人的话」是人的判断本身，只有协调者（主会话）能代记',
				})
				if (identity.ok !== true) return { ok: false, error: identity.reason }
				return recordHumanWords(ctx, exec, args)
			},
		}),
	)

	ctx.tools.register(
		textTool({
			name: 'human_words_list',
			description: [
				'列出人说过的话（目标 / 约束 / 偏好 / 否决理由），并渲染 Markdown 表。',
				'',
				'读它的人有两种用途：接下这单活之前先看人已经定过什么（免得把已经说过的再问一遍），以及核对人说过的话有没有被记下来。',
				'参数：kind（可选，按类筛：goal 目标 / constraint 约束 / preference 偏好 / veto 否决理由；不给即全量，给空串等同于不给）。',
				'文件读不到时 warnings 里照实写：文件不在是**按需建立**的正常状态（没记过任何一条），文件在而读不成则是**读不到** —— 后者不降级成空文件，工具直接返回失败，因为「读不到」不等于「人没说过」。',
				'只读：不修改文件，也不参与文件事务队列。',
				'',
				READ_BOUNDARY,
			].join('\n'),
			parameters: {
				type: 'object',
				properties: {
					kind: { type: 'string', enum: HUMAN_KINDS, description: '按类筛（可选）：goal 目标 / constraint 约束 / preference 偏好 / veto 否决理由；不给即全量。' },
				},
				additionalProperties: false,
			},
			run: (args, exec) => listHumanWords(ctx, exec, args),
		}),
	)




	ctx.tools.register(
		textTool({
			name: 'team_status',
			description: [
				'一条命令回答「现在到哪了」：**最多两行**，给人看的。人问状态时用这个，不要去人肉读任务板。',
				'',
				'输出形如：',
				'  待办 6 · 进行中 0 · 已完成 9',
				'  卡住：task-3 等 task-1、task-2',
				'',
				'读的是 **DSH 原生 Agent Teams 的任务板**（`ctx.agentTeams.listTasks`）。第一行的三个名字**直接用原生分栏的名字**（待办 / 进行中 / 已完成）—— 不许另起名字（把"进行中 + 已完成"并成"推进中"之类会让两个数打架）。',
				'**卡住**＝未完成、且**依赖尚未全部完成**的任务（依赖已完成的待办不算卡住 —— 它只是还没人认领），只做明细行、不进第一行。',
				'**可认领**直接用原生算好的 `ready` 那一格，本工具不再自己推一遍。读不到时说清读不到（读不到不等于 0 条）。',
				'',
				READ_BOUNDARY,
			].join('\n'),
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			run: (_args, exec) => nativeTeamStatus(ctx, exec),
		}),
	)

	ctx.tools.register(
		textTool({
			name: 'board_task',
			description: [
				'共享任务看板 —— **建在 DSH 原生 Agent Teams 里**（`ctx.agentTeams` 的 `createTask` / `updateTask` / `listTasks`），与内置 `team_task_*` 是同一本账。',
				'',
				'动作：`register`（建）/ `query` / `get` / `claim` / `release` / `complete` / `reopen` / `reassign` / `edit` / `set_dependencies` / `delete`（`update` 是 `edit` 的别名）。**所有会改归属或状态的动作都要带 `expected_revision`**（先 `get` 或 `query` 读一次）—— 版本对不上就是"有人先改过"，重读再改。',
				'**原生只有三态**：待办 / 进行中 / 已完成。`submit` / `accept` / `reject` / `view` 这四档原生没有，本工具会**如实拒绝**并指出该用哪一档（干完直接 `complete`；独立复核另开一条任务派给复核的角色）。',
				'依赖用 `blocked_by_tasks`（任务编号数组，元素形如 `task-3`，环会被拒）；`write_scopes` 是**提示性**的写盘面，重叠只告警不拦。',
				'**原生没有的字段一个都不收**：优先级 / 阶段 / 产物路径 / 备注 / 执行代凭据 / 强制删除 / 保留归属都是旧文件看板的东西，要写就写进 `description`（原生只有 `subject` / `description` / `blockedBy` / `writeScopes` 四个可写字段）。',
				'',
				'**看板编号是系统坐标，不进给人看的文档**：`task-<序号>` 这类号属于回报与看板，交付文档的标题与正文里一律不出现（口径见基线「交付文档怎么写」）。',
				'',
				BOARD_BOUNDARY,
			].join('\n'),
			parameters: {
				type: 'object',
				properties: {
					action: {
						type: 'string',
						enum: ['register', 'query', 'get', 'claim', 'release', 'complete', 'reopen', 'reassign', 'edit', 'update', 'set_dependencies', 'delete', 'submit', 'accept', 'reject', 'view'],
						description: '**派活三件套（缺一就会"活干了卡没动"）**：**① `register`（建卡）→ ② `reassign`（带 owner）→ ③ `member_send`（把规格发给它）** —— '
							+ '三步缺一不可：`register` 只是建卡（停在**待办**）、`member_send` 只是**按门铃**（不动状态）、**只有 `reassign` 会把卡推进「进行中」**。'
							+ '**改归属不等于叫它开工**：`reassign` 会顺手给新 owner 投递一条最小通知（任务号 + 主题 + "做完 `complete` 回报"），但**它不保证对方马上动** —— 要它动，另发 `member_send`。'
							+ 'register 登记 / query 查询 / get 读一条 / **claim 认领（成员可用：只认领协调器在消息里点到自己的那一条、且它还没被指派；原生把归属记成调用者本人）** / release 释放回板 / complete 收口完成（只有进行中能收）/ reopen 重开回待办 / '
							+ '**reassign 转派（仅协调者；它同时把状态推进「进行中」—— 这是与 `member_send` 分工的关键）** / edit（别名 update）改 subject / description / write_scopes / set_dependencies 设依赖 / delete 留痕删除。'
							+ 'submit / accept / reject / view 原生没有这四档，会如实拒绝并指出该用哪一档。',
					},
					id: { type: 'string', description: '任务编号，形如 `task-<n>`（原生编号空间：`task-7`）。register / query 之外的动作必填；写错形状时回执会给出正确形状。' },
					expected_revision: { type: 'integer', description: 'CAS 前置条件：你手上这条任务的版本号（query / get 读到的 revision）。会改归属或状态的动作必填；对不上即拒绝。' },
					assignee: { type: 'string', description: '归属成员名：**reassign（转派）用**。claim 的归属由原生记成调用者本人（原生不读这个字段），要换人请认领后用 reassign。**改归属不等于叫它开工**（reassign 会顺手通知新 owner，但那只是按门铃）—— 要它动，另发 `member_send`。' },
					subject: { type: 'string', description: '一句话说清是什么（≤200 字符，原生上限）；register 必填（可与 description 同义二选一），edit 可改。' },
					description: { type: 'string', description: '任务的完整说明（原生上限 16384 字符）：目标、背景、产物落点、验收判据都写这里 —— 原生没有单独的 note / artifact / priority / phase 字段。' },
					owner: { type: 'string', description: '显示的负责人（成员名）：**reassign 用**（`assignee` 是同义字段）。**改归属不等于叫它开工**；要它动，另发 `member_send`。' },
					blocked_by_tasks: { type: 'array', items: { type: 'string' }, description: '依赖的任务编号（DAG，元素形如 `task-3`）：依赖未完成不能 claim；set_dependencies 传 [] 即清空。' },
					write_scopes: { type: 'array', items: { type: 'string' }, description: '工作区相对路径前缀（如 src/app.ts、src/）：**提示性**的写盘面，重叠只告警不拦；edit 可改。' },
					filter_status: { type: 'string', enum: ['待办', '进行中', '已完成', 'pending', 'in_progress', 'completed'], description: 'query：按状态过滤（中英都认，只有原生这三档）。「待验收」「已打回」原生没有，传了会被明确拒绝。' },
					filter_owner: { type: 'string', description: 'query：按负责人过滤（原生那一格叫 `ownerName`，取成员名）。' },
					ready: { type: 'boolean', description: 'query：true 只列**原生判为可认领**的那些（原生 `ready` 字段：待办且依赖全部已完成）。' },
				},
				required: ['action'],
				additionalProperties: false,
			},
			run: (args, exec) => nativeBoardTask(ctx, exec, args),
		}),
	)

	ctx.tools.register(
		textTool({
			name: 'check_artifact',
			description: [
				'校验一个产物文件是否合规，返回 violations（阻断）与 warnings（提示）。',
				'',
				'三项检查：① 编号唯一 —— 编号要符合该 kind 的规格，且不在同目录其他 Markdown 里以「标题或编号标注」形式重复声明（表格与正文里的引用不算重复声明）；② 故事追溯 —— 按 kind 要求声明来源或关联条目；③ 模板要素齐全 —— 该 kind 的必备要素齐备。',
				'参数：path（必填，工作区相对路径或绝对路径）、kind（story 用户故事 / testcase 测试用例 / adr 架构决策 / generic 通用产物，缺省 generic）。',
				'检查标准逐 kind 写明：story 要 US-<模块>-<序号>、用户故事、验收标准、优先级与来源/追溯标记；testcase 要 TC-<模块>-<故事号>-<序号>、前置条件、测试步骤、预期结果与至少一条 US- 编号；adr 要 ADR-<序号>、背景、决策、后果、状态与关联编号；generic 要可识别编号与至少一个标题，追溯缺失只告警。',
				'读不到的同目录文件会被记入 warnings 并标注「未校验」：本工具不把未校验当作合规。',
				'',
				READ_BOUNDARY,
			].join('\n'),
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '产物文件路径，工作区相对或绝对。' },
					kind: { type: 'string', enum: Object.keys(ARTIFACT_RULES), default: 'generic', description: '产物类型：story / testcase / adr / generic，缺省 generic。' },
				},
				required: ['path'],
				additionalProperties: false,
			},
			run: (args, exec) => checkArtifact(ctx, exec, args),
		}),
	)

}

// ── 对运行时那半边的公开面（`team-runtime.js` 唯一允许 import 的东西） ──────────
//
// 为什么不把这些符号一个个 `export`：那会把「谁可以碰文件事务」变成一件靠自觉的事。
// 这里给出一张**点名的清单**，而且只列**运行时真正用到的那些** —— 模块外的插件拿不到
// 各工具的 handler、校验分支与渲染细节；两张清单的差集就是"半边之间的缝"。
//
// 最要紧的一条：清单里的 `transact` 与 `commitLedger` 是**同一个模块实例**里那一份
// （两个插件在同一预设作用域里 import 同一个文件 URL），因此**一个状态文件只有一个写队列**。
// 这条不能靠约定，靠模块单例 —— 所以运行时那半边**必须** import 本模块，不许自己再写一套 IO。
//
// 两组（**只放运行时真在用的**；旧的"文件看板引擎"整簇删掉之后，看板动作与派生不再进这份清单）：
//   · **文件事务**：读、写、递交、按文件串行、路径与工作区解析、写者标记；
//   · **工具装配与判据**：`textTool`（让两边的工具形状完全一致）、`coordinatorCheckOf`（行政面的门）。
export const runtimeBridge = {
	LEDGER_FILE,
	LEDGER_VERSION,
	MEMBER_PRESENT_MAX,
	MEMBER_PRESENT_STATUS,
	MEMBER_RETIRED_STATUS,
	MEMBER_ROLE_MAX,
	MEMBER_WARN_LINE,
	READ_BOUNDARY,
	WRITE_BOUNDARY_MEMBERS,
	WRITE_BOUNDARY_ROLES,
	collectionOf,
	commitLedger,
	coordinatorCheckOf,
	ensureHandoffSnapshot,
	foreignWriterWarnings,
	ledgerPath,
	optionalText,
	readLedger,
	requireText,
	taskAttemptIdOf,
	textTool,
	transact,
	workspaceRootOf,
	writerStamp,
}
