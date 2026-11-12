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
 *   member_defaults / member_spawn / member_send / member_list / role_manage
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
 *   `.ops/human.json`      **人的话**（一等对象）
 *   `.ops/roles.json`      角色启用开关（按工作区一份）
 *   `.ops/roster.json`     角色下架名单（面板"删除只在包内的角色"）
 *
 * **看板 / 名册两份不在这一层**：任务与成员归 DSH 原生 Agent Teams（`ctx.agentTeams`），
 * 工作区里同名的 `.ops/board.json` / `.members.json` 是历史遗留文件，
 * 本插件没有写者（`lib/ledger-digest.js` 那条摘要 hook 只读它们，给一句"这是历史账"）。
 *
 * 读写纪律（每个写 action 都遵守，实现见 `readLedger` / `commitLedger` / `transact`）：
 *   · 同一文件的读-改-写经文件队列串行；只读 action 不入队，入队会让它等自己的队尾而自锁。
 *   · 写 action 内不再调用同一文件的写 action——非重入。
 *   · 只有结构化「未找到」信号算空状态；其余读取异常一律中止本次写，绝不降级成空文件。
 *   · 冲突抛出点落在真正写盘之前，因此事务边界重跑幂等安全，重跑上限见 `MAX_CAS_ATTEMPTS`。
 *   · 没写进文件就不返回 ok：失败一律 `{ ok: false, error }`，不向调用方抛异常。
 */

import { dirname as dirNameOf, isAbsolute as isAbsolutePath, join as joinPath } from 'node:path'
import { artifactPath, collectionOf, commitLedger, failJson, failureReason, foreignWriterWarnings, formatId, ledgerPath, nextNumber, numbersOf, okJson, optionalText, readLedger, readTextSnapshot, requireEnum, requireText, resolveTarget, transact, workspaceRootOf, writerStamp } from '../lib/ledger-store.js'

/** 幂等闸：**同一个 ctx 只挂一次**（`WeakSet`；见 `apply` 顶部）。 */
const gateMounted = new WeakSet()

export const inject = ['fs', 'tools']

/** 文件覆盖的顶层数据版本，供未来读取方分流。 */
const LEDGER_VERSION = 1

/**
 * **本插件会写的**状态文件名，相对于工作区根（三份，各有唯一的写入口）。
 *
 * 看板 / 名册两份**已经不在这一层**：任务与成员归 DSH 原生 Agent Teams，
 * 工作区里那几个同名的 `.ops/board.json` / `.members.json`
 * 是**历史遗留文件**（本插件没有写者，`lib/ledger-digest.js` 那条摘要 hook 只读它们给历史账），
 * 所以这里连名字都不再登记 —— 一张写盘清单里不该有写不到的东西。
 */
const LEDGER_FILE = {
	human: opsFileOf('human'),
	// 角色清单的**启用开关**（按工作区一份 = "当前团队"）：只记"关掉了哪些"，
	// 缺省全部启用 —— 于是新加的角色天生可用，不需要任何文件同步（见 team-runtime 的 role_manage）。
	roles: opsFileOf('roles'),
	// 默认队友清单的**下架名单**（面板「角色」上"删除"一个只在包内的角色时落这里）：
	// 与 `.ops/roles.json` 同一条取向 —— 只记"下架了哪些"，缺省全在架上。
	roster: opsFileOf('roster'),
	// **成员的停用名单**（HD-006）：原生名册没有"停用/移除"接口，所以"停用"是本插件这一层的视图状态。
	// 写法与 `roles` 那份同一条路（引擎 `transact`/`commitLedger`，读侧见 `lib/member-flags.js`）。
	memberFlags: opsFileOf('memberFlags'),
	// **交接快照**：原生看板按会话（`TeamId = SessionId`），新会话从零开始 —— 这一份是**派生物**，
	// 让"上下文到极限、新开一个会话"之后还看得见上一本账该接着干什么。它**不是**第二本账、
	// **不是**实时看板（活着的那本在原生队伍日志里，读数以 `team_status` 为准）。
	handoff: opsFileOf('handoff'),
}

/** 序号前缀：本插件还在发的编号空间（看板 / 成员那两套随账本一起归原生）。 */
const ID_PREFIX = {
	human: 'HD',
}

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
import { appendStructured, assertTaskId, clampToBytes, listStructured, readCheckpoint, sessionTagOf, structuredExists, structuredPathOf } from '../lib/checkpoint.js'
import { readRoster } from '../lib/roster.js'
import { migrateWorkspaceSync, opsFileOf } from '../lib/ops-files.js'
import * as NL from './native-layer.js'
import { assignmentGuardOf } from '../lib/assignment.js'

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
 * 成员状态：只保留仍对外的两档（在场 / 退役），经 `runtimeBridge` 给运行时半边用。
 * 「归档 / 未到场」那几档随文件名册一起撤了 —— 实时成员状态现在由 DSH 原生 Agent Teams 给，
 * 本层不再解析名册文件里的状态字段。
 */
const MEMBER_PRESENT_STATUS = '在场'
const MEMBER_RETIRED_STATUS = '退役'
// 编制上限的**唯一正文**在 `lib/team-limits.js`（制度层与薄层都要用；放这里会与薄层成环）。

/** 单次 `check_artifact` 编号唯一性扫描的同目录文件数上限，超出部分不读并显式告警。 */
const UNIQUENESS_SCAN_MAX = 200

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
	'每次成功改动之后会往工作区写**一份交接快照** `.ops/handoff.json`（跨会话续接用的**派生物**，不是第二本账、也不是实时读数）—— ' +
	'这是本工具在工作区里写的**唯一**一份文件。不写工作区外任何路径，不删文件，不移动工作区文件。'

const WRITE_BOUNDARY_HUMAN =
	'边界：只写工作区内 `.ops/human.json` 一份文件；不写工作区外任何路径，不删文件，不移动工作区文件。**这份文件的写入只有协调器（主会话）能做** —— 成员身份调用会被拒（判据见 `coordinatorCheckOf`）：成员只能读人的话（`human_words_list`），要记就回给协调者。跨进程并发只由递交前重读比对事后收窄（TOCTOU 仍在），无法消除静默丢更新；读到别的进程刚写入的文件只检出并告警，不自动合并。'

/**
 * 成员面那几个工具共用的边界声明（`member_spawn` / `member_send`）。
 *
 * **它们一个状态文件都不写**：成员与消息都是 DSH 原生 Agent Teams 的对象（`ctx.agentTeams`），
 * 名册 / 邮箱文件已经不在本插件的写盘清单里（见 `LEDGER_FILE`）。这一条从前写的是"只写
 * `.ops/members.json`" —— 成员面迁原生之后那就是一句没做到的话，改成事实。
 */
const WRITE_BOUNDARY_MEMBERS =
	'边界：**不写工作区里的任何状态文件** —— 成员与消息都是 DSH 原生 Agent Teams 的对象（`ctx.agentTeams`），本插件不落名册 / 邮箱文件；不写工作区外任何路径，不删文件，不移动工作区文件。跨进程并发只由递交前重读比对事后收窄（TOCTOU 仍在），无法消除静默丢更新；读到别的进程刚写入的文件只检出并告警，不自动合并。'

/** `team_checkpoint` 的边界声明：它写的是 docs/team/checkpoints/（追加 + 轮转）。 */
const WRITE_BOUNDARY_CHECKPOINT =
	'边界：只写工作区内 `docs/team/checkpoints/<task>.md`（append-only；超过上限轮转出 `.1.md` / `.2.md`，最旧的会被删）；不写工作区外任何路径，不移动工作区文件。'

/**
 * `role_manage` 那一档的边界声明（它和成员面不是一回事：这一条**真的**写工作区文件）。
 * 同一理由：逐字点名本次真正写的那一份文件，别拿点名别处的边界来声明。
 */
const WRITE_BOUNDARY_ROLES =
	'边界：只写工作区内 `.ops/roles.json` 一份文件（角色启用开关；缺省全部启用，只记关掉了哪些）；不写工作区外任何路径，不删文件，不移动工作区文件。**这份文件的写入只有协调器（主会话）能做** —— 成员身份调用会被拒。跨进程并发只由递交前重读比对事后收窄（TOCTOU 仍在），无法消除静默丢更新；读到别的进程刚写入的文件只检出并告警，不自动合并。'

// ── 看板 ─────────────────────────────────────────────────────────────────────

// 里程碑清单的解析在 `lib/milestones.js`（纯函数，引擎与面板宿主共用）。
// 这里 re-export 只为保留引擎原有的导出面，内部不再有第二份实现。
export { parseMilestones } from '../lib/milestones.js'

// ── 看板条目的运行时语义（**只留下读数要用的那几个派生**） ────────────────────
//
// 任务板已整本迁到 DSH 原生 Agent Teams（`board_task` 走 `ctx.agentTeams`）——CAS 版本号、
// 执行代凭据、依赖门禁这三条机制**都在原生那一侧**，本文件不再实现、也不再写看板文件。
// 这一段剩下的全是**纯函数派生**，只服务两处读数：
//   · `taskAttemptIdOf` —— 任务当前执行代凭据（工具回执与面板用）；
//   · `writeScopesOf` / `writeScopeWarningsOf` —— 写盘面重叠提示（只告警，绝不拦）。
// 它们不碰文件系统，可以脱离宿主单测。

/** 任务当前执行代凭据；没有开放执行代时返回 undefined。 */
export function taskAttemptIdOf(task) {
	return typeof task?.attemptId === 'string' && task.attemptId !== '' ? task.attemptId : undefined
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
	let guard = null
	if (fields.owner !== undefined) {
		const before = await NL.boardCall(ctx, caller, 'get', { id })
		if (before.ok === true && before.value !== null && typeof before.value === 'object') {
			previousOwner = typeof before.value.ownerName === 'string' ? before.value.ownerName : ''
			previousOwnerKnown = true
		}
		// **派发前的校验与冲突检测**：重复分配 / 他人误派 / 已完成 / 缺 CAS 一律阻止；其余给风险提示。
		const listed = await NL.boardCall(ctx, caller, 'list', {})
		const allTasks = listed.ok === true && Array.isArray(listed.value) ? listed.value : []
		const teammates = await NL.listTeammates(ctx, caller)
		const members = teammates.ok === true && Array.isArray(teammates.rows)
			? teammates.rows.map((row) => String(row?.name ?? '')).filter((name) => name !== '')
			: null
		guard = assignmentGuardOf({
			task: before.ok === true ? before.value : null,
			targetOwner: fields.owner,
			expectedRevision: args.expected_revision,
			handover: args.handover === true,
			allTasks,
			members,
			id,
		})
		if (guard.ok !== true) {
			return { ok: false, error: guard.conflict.message, conflict: guard.conflict, risks: guard.risks }
		}
	}
	const called = await NL.boardCall(ctx, caller, 'update', fields)
	if (called.ok !== true) return { ok: false, error: boardErrorOf(id, called.reason) }
	// **改派不等于叫它开工**（治根，见 `reassignNoticeOf`）：真换了归属 ⇒ 顺手投递一条最小通知。
	const reassign = await reassignNoticeOf(ctx, exec, caller, { action, id, task: called.value, previousOwner, previousOwnerKnown })
	// 同上：认领 / 收口 / 转派 / 设依赖……**每一次成功改动**都刷新快照（快照是派生物，失败只警告）。
	const handoff = await recordHandoff(ctx, exec)
	// **收口时看一眼检查点**（人的设计：检查点缺失要可见，不阻断）。
	// 原生 `team_task_update` 收口不经过这里 —— 那一路由事件监听在快照里标记（见 `session-watch`）。
	// 检查点按**团队根会话**隔离（原生任务编号只在会话内唯一）：成员收口时也要落到 Lead 那一份。
	const rootAgent = leadAgentOf(ctx, caller)
	const rootSessionId = typeof rootAgent?.id === 'string' ? rootAgent.id : ''
	const checkpoint = action === 'complete' ? await checkpointStateOf(workspaceRootOf(exec), rootSessionId, id) : null
	const warnings = []
	if (handoff.ok !== true) warnings.push(`交接快照没写成功（不影响这次看板改动）：${handoff.reason}`)
	if (checkpoint !== null && checkpoint.present === null) warnings.push(`任务已完成，但**读不到**检查点（原因：${checkpoint.reason ?? '未知'}）—— 这不等于没有；先确认工作区，再补一份更稳。`)
	else if (checkpoint !== null && checkpoint.present !== true) warnings.push(`任务已完成，但没有检查点：先写一个（team_checkpoint action=write task=${id} …）再收口更好交接。`)
	return {
		ok: true,
		task: called.value,
		...(guard === null ? {} : { assignment: guard.assignment, risks: guard.risks }),
		...(reassign === null ? {} : { notified: reassign.notified, ...(reassign.note === undefined ? {} : { notifyNote: reassign.note }) }),
		...(handoff.ok === true ? { handoff: { file: handoff.file, at: handoff.at, counts: handoff.counts } } : {}),
		...(checkpoint === null ? {} : { checkpoint }),
		...(warnings.length === 0 ? {} : { warnings }),
	}
}

/** 某条任务的检查点现状（按团队根会话；形状错了当没有；读不到不编）。 */
async function checkpointStateOf(workspace, sessionId, task) {
	try {
		const present = await structuredExists(workspace, sessionId, task)
		return { task, session: sessionTagOf(sessionId), present, path: structuredPathOf(workspace, sessionId, task) }
	} catch (error) {
		// **读不到 ≠ 没有**：present 用 null 区分，回执文案不许把读不到说成没有。
		return { task, present: null, path: '', reason: failureReason(error) }
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
	return { version: LEDGER_VERSION, seq: 0, note: HANDOFF_NOTE, at: '', sessionId: '', tasks: [], roles: [], members: [], checkpoints: { count: 0, dir: '', missingForCompleted: [] } }
}

/** 任务清单里那一格（只留接手要的四样：编号 / 标题 / 状态 / owner **角色**）。 */
function handoffTaskOf(row, roleOf) {
	const ownerName = typeof row?.ownerName === 'string' ? row.ownerName : ''
	const role = roleOf(ownerName)
	return {
		id: typeof row?.id === 'string' ? row.id : '',
		revision: typeof row?.revision === 'number' ? row.revision : undefined,
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
async function writeHandoffSnapshot(ctx, exec, source = 'tool') {
	const workspace = workspaceRootOf(exec)
	const absPath = ledgerPath(workspace, LEDGER_FILE.handoff)
	// **快照永远记 Lead 的会话**：成员调 `board_task` / `team_checkpoint` 时也会刷快照，
	// 不能把 `sessionId` 短暂改成成员会话（下一次团队事件才写回来 = 一会儿一个值）。
	const agent = leadAgentOf(ctx, exec?.agent)
	const listed = await NL.boardCall(ctx, agent, 'list', {})
	if (listed.ok !== true) return { ok: false, reason: `读不到原生任务板：${listed.reason}` }
	const rows = Array.isArray(listed.value) ? listed.value : []
	// 角色清单从**文档侧那一份真相源**读（`lib/roster.js`），成员名 → 角色用薄层那一处约定（`NL.roleOfName`）——
	// 两处都不另写第二份判定。
	const roleIds = readRoster([], { includeUser: true }).roles.map((role) => role.id)
	const roleOf = (name) => (typeof name === 'string' && name !== '' ? NL.roleOfName(name, roleIds) : '')
	const members = await NL.listTeammates(ctx, agent)
	const rosterRows = members.ok === true ? members.rows : []
	const present = rosterRows.filter((row) => row.role !== 'lead')
	const roles = [...new Set(present.map((row) => roleOf(row.name)).filter((role) => role !== ''))]
	const tasks = rows.map((row) => handoffTaskOf(row, roleOf))
	const sessionId = typeof agent?.id === 'string' ? agent.id : ''
	// **检查点读数**（人的设计）：有多少份结构化检查点、哪些已完成的任务还没有检查点。
	// 按**团队根会话**读：不同会话的 task-1 是两条记录，不能互相冒充检查点。
	// 读不到就当 0（它是派生物；不影响快照本身）。
	let checkpointRows = []
	try {
		checkpointRows = await listStructured(workspace, sessionId)
	} catch {
		checkpointRows = []
	}
	const checkpointTasks = new Set(checkpointRows.map((row) => row.task))
	const missingForCompleted = tasks.filter((task) => task.status === 'completed' && !checkpointTasks.has(task.id)).map((task) => task.id)
	const checkpoints = {
		count: checkpointRows.length,
		dir: 'docs/team/checkpoints',
		missingForCompleted,
	}
	const at = new Date().toISOString()
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
			source,
			schemaVersion: 2,
			tasks,
			roles,
			members: present.map((row) => ({ name: row.name, role: roleOf(row.name), status: row.status })),
			checkpoints,
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
async function recordHandoff(ctx, exec, source = 'tool') {
	try {
		return await writeHandoffSnapshot(ctx, exec, source)
	} catch (error) {
		return { ok: false, reason: failureReason(error) }
	}
}

/** 调用的 agent 若是队友，返回它所属队伍的 Lead；否则原样返回。 */
function leadAgentOf(ctx, agent) {
	const service = typeof ctx?.get === 'function' ? ctx.get('agentTeams') : undefined
	try {
		const membership = service?.tryMembership?.(agent)
		return membership !== null && typeof membership === 'object' && membership.root !== undefined ? membership.root : agent
	} catch {
		return agent
	}
}

/**
 * 给**事件监听**用的入口（`lib/session-watch.js`）：拿一个活着的 Lead 直接重算并写快照。
 *
 * 与工具路径共用同一份 `writeHandoffSnapshot`；失败照样只回 `{ ok: false, reason }`，
 * 由调用方吞掉 —— 快照是派生物，不能影响任何任务操作。
 * @param ctx - 宿主上下文。
 * @param {object} agent - 活着的 Lead（`ctx.agents.get(sessionId)`）。
 * @returns `{ ok: true, file, at, counts }` 或 `{ ok: false, reason }`。
 */
export async function recordHandoffFor(ctx, agent) {
	return await recordHandoff(ctx, { agent }, 'event')
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

/**
 * `team_checkpoint`：压缩 / 收口前的**落点**。
 *
 * 为什么要有它：会话压缩会把早期轮次变成摘要，工具结果只留头尾 —— 细节一旦没落盘就真丢了。
 * 结构化的关键结论（事实 / 决定 / 产物路径 / 未决 / 下一步）由成员主动写；自动压缩的原始转储
 * 由 `lib/session-watch.js` 另写（`.ops/checkpoints/`，派生、可删）。
 *
 * 边界：只在**团队会话**里可用（读得到队内身份）；只写工作区里 `docs/team/checkpoints/`；
 * 任务编号必须形如 `task-<数字>`；append-only、超限轮转。
 */
export async function teamCheckpoint(ctx, exec, args) {
	const agent = exec?.agent
	const service = typeof ctx?.get === 'function' ? ctx.get('agentTeams') : undefined
	// **必须有 agentTeams 服务**：没有服务的环境（离线自检 / 老宿主）不是团队会话，照旧拒。
	// 但**不要求**它一定有 `tryMembership`：宿主各版本暴露的方法不一样，缺这个方法时走下面的回落。
	if (agent === undefined || agent === null || service === null || service === undefined) {
		return { ok: false, error: 'team_checkpoint 只在团队会话里可用：读不到你的队内身份（成员 / 协调者）。' }
	}
	let membership = null
	if (typeof service.tryMembership === 'function') {
		try {
			membership = service.tryMembership(agent) ?? null
		} catch {
			membership = null
		}
	}
	// 回落（与 `coordinatorCheckOf` 同源）：活着的根 agent 在宿主这边可能暂时不在名册快照里
	// （重启 / 会话恢复后常见），但「没有 parentSession」仍然足以判它是协调者；成员则用 parentSession 当根会话。
	let sessionId = typeof membership?.root?.id === 'string' ? membership.root.id : ''
	let role = membership !== null && (membership.role === 'lead' || membership.role === 'teammate') ? membership.role : ''
	if (sessionId === '' || role === '') {
		const parentId = typeof agent.session?.header?.parentSession === 'string' ? agent.session.header.parentSession : ''
		if (parentId !== '') {
			sessionId = parentId
			role = 'teammate'
		} else if (typeof agent.id === 'string' && agent.id !== '') {
			sessionId = agent.id
			role = 'lead'
		} else {
			return { ok: false, error: 'team_checkpoint 只在团队会话里可用：读不到你的队内身份（成员 / 协调者）。' }
		}
	}
	const workspace = workspaceRootOf(exec)
	const action = requireEnum(args.action, ['write', 'list', 'read'], 'action')
	if (action === 'list') {
		return { ok: true, dir: joinPath(workspace, 'docs', 'team', 'checkpoints'), session: sessionTagOf(sessionId), rows: await listStructured(workspace, sessionId) }
	}
	const task = assertTaskId(args.task)
	const path = structuredPathOf(workspace, sessionId, task)
	if (action === 'read') {
		if (!(await structuredExists(workspace, sessionId, task))) return { ok: false, error: `没有 ${task} 的检查点（${path}）。` }
		const content = await readCheckpoint(path)
		return { ok: true, task, session: sessionTagOf(sessionId), path, content: clampToBytes(content, 200 * 1024) }
	}
	// **summary 必填**（设计的口径：一句话结论是这份检查点的头）；产物路径只收工作区相对路径。
	const summary = requireText(args.summary, 'summary')
	for (const artifact of Array.isArray(args.artifacts) ? args.artifacts : []) {
		if (typeof artifact !== 'string' || artifact.trim() === '') continue
		if (isAbsolutePath(artifact.trim()) || artifact.trim().split(/[\\/]/).includes('..')) {
			throw new Error(`artifacts 必须是工作区相对路径（不许绝对路径或 ..）：${artifact}`)
		}
	}
	const written = await appendStructured(workspace, sessionId, task, {
		role,
		summary,
		facts: args.facts,
		decisions: args.decisions,
		artifacts: args.artifacts,
		open: args.open,
		next: args.next,
	})
	// **写完顺手刷新快照**：否则「缺检查点」要等到下一次团队事件才消失（现场就会读成"还没写"）。
	// 失败只影响快照（派生物），不影响这次写入。
	await recordHandoff(ctx, { agent: membership !== null && membership.root !== undefined ? membership.root : agent })
	return { ok: true, task, session: sessionTagOf(sessionId), path: written }
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
				'**派发守卫**：`reassign` 必须写明执行人（`assignee` / `owner`）并带 `expected_revision`；任务已有负责人时，重复分配或他人再派会被**阻止**（`conflict` 回执说明原因），确需转派带 `handover: true`。成功回执带 `assignment`（负责人 / 锁定状态）与 `risks`（依赖、写盘面重叠、成员不在场、负载等潜在风险）。',
				'',
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
						description: '**派活三件套**：**① `register`（建卡）→ ② `reassign`（带 owner）→ ③ `member_send`（把规格发给它）** —— '
							+ '`register` 只是建卡（停在**待办**）、`member_send` 只是**按门铃**（不动状态）、**只有 `reassign` 会把卡推进「进行中」**。'
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
					handover: { type: 'boolean', description: '**显式转派**：任务已有负责人时，改派给别人必须带 `true`。不带则被阻止（`locked_by_other`），避免他人误分配同一任务。' },
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
			name: 'team_checkpoint',
			description: [
				'把一个任务的**关键结论**落成检查点（append-only）：压缩或收口之前，靠它把「事实 / 决定 / 产物路径 / 未决 / 下一步」留在磁盘上。',
				'',
				'为什么要有它：会话压缩会把早期轮次变成摘要、工具结果只留头尾 —— 细节没落盘就真丢了。结构化检查点写在 `docs/team/checkpoints/<task>--<会话短标签>.md`（可提交、人可读；按会话隔离，不同会话的 `task-1` 不会互相覆盖）；自动压缩的原文转储另存在 `.ops/checkpoints/`（派生、可删）。',
				'',
				'用法：收口前（`board_task complete` 之前）写一次；有实质进展的里程碑也写。任务编号是原生的 `task-<数字>`。',
				'`read` 读回正文（≤200KB）；`list` 列出已有检查点。',
				'',
				'参数：action（write / list / read）、task（write / read 必填）、summary（write 必填，一句话结论，≤200 字）、facts / decisions / artifacts / open / next（字符串数组，每个列表最多 20 条；artifacts 只收工作区相对路径）。',
				'',
				WRITE_BOUNDARY_CHECKPOINT,
			].join('\n'),
			parameters: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['write', 'list', 'read'], description: '要做什么：write 追加一节 / list 列出已有 / read 读回正文。' },
					task: { type: 'string', description: '任务编号，形如 task-1（write / read 必填）。' },
					summary: { type: 'string', description: '一句话结论（write 必填；≤200 字，超出截断）。' },
					facts: { type: 'array', items: { type: 'string' }, description: '决定事实（逐条 ≤120 字）。' },
					decisions: { type: 'array', items: { type: 'string' }, description: '决定及其理由。' },
					artifacts: { type: 'array', items: { type: 'string' }, description: '产物路径（工作区相对）。' },
					open: { type: 'array', items: { type: 'string' }, description: '未决问题。' },
					next: { type: 'array', items: { type: 'string' }, description: '下一步。' },
				},
				required: ['action'],
				additionalProperties: false,
			},
			run: (args, exec) => teamCheckpoint(ctx, exec, args),
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
