/**
 * 协作面（阶段 3–5）：结构化交接单、任务包两格检查、协作效率度量。
 *
 * 三件事共用一条取向：**信息只走三条路**——看板（状态）、交接单（跨角色）、产物（交付）；
 * 这里只提供可查数据与写入，不新增"过程文档"这条路。
 */
import { runtimeBridge as B } from '../team/company-gate.js'
import { opsFileOf } from './ops-files.js'
import { allRoleContracts, contractConflicts } from './role-contract.js'

/** 结构化交接单的账名（与快照 `handoff.json` 分开）。 */
const HANDOFFS_FILE = opsFileOf('handoffs')
/** 交接单保留条数上限（越界的旧单裁掉）。 */
const HANDOFFS_MAX = 200

/** 可选服务取值：`ctx.get(name)` 优先（宿主 Guard 只放行这一条），取不到再退回直接读属性。 */
function serviceOf(ctx, name) {
	if (typeof ctx?.get === 'function') {
		try {
			const service = ctx.get(name)
			if (service !== undefined) return service
		} catch {
			/* 注册表读不到 ⇒ 试下面那条 */
		}
	}
	try {
		return ctx?.[name]
	} catch {
		return undefined
	}
}

/**
 * 交接单的**发出方**是谁：优先 `exec.agent.name`，其次按 agent id 去原生名册反查成员名。
 *
 * 为什么要反查：工具拿到的 `exec.agent.id` 是**会话 id**（`session-47773a61-…`），不是成员名 ——
 * 直接写进 `from` 的话，面板上印出来是一串 UUID，而成员卡按成员名匹配的那一侧也就永远对不上。
 * 名册查不到（没服务 / 会话不在名册里）就如实退回 agent id，不编一个名字。
 * @param ctx - 宿主上下文。
 * @param exec - 调用方。
 * @returns 成员名或 agent id（都取不到时 `unknown`）。
 */
async function senderLabelOf(ctx, exec) {
	const named = typeof exec?.agent?.name === 'string' ? exec.agent.name.trim() : ''
	if (named !== '') return named
	const agentId = typeof exec?.agent?.id === 'string' ? exec.agent.id.trim() : ''
	if (agentId === '') return 'unknown'
	const service = serviceOf(ctx, 'agentTeams')
	if (typeof service?.listMembers === 'function') {
		try {
			const listed = await service.listMembers(exec.agent)
			const rows = Array.isArray(listed) ? listed : Array.isArray(listed?.value) ? listed.value : []
			const hit = rows.find((row) => row?.id === agentId && typeof row?.name === 'string' && row.name !== '')
			if (hit !== undefined) return hit.name
		} catch {
			/* 名册读不到 ⇒ 退回 agent id（不编名字） */
		}
	}
	return agentId
}

/** 任务包两格的软检查：原生只有 subject/description 四个字段，所以只能查 description 里有没有。 */
const FORM_HINT = /产物形态|artifactForm|artifact_form/
const ACCEPT_HINT = /验收判据|acceptance/

/**
 * 写一条结构化交接单。
 * @param ctx - 宿主上下文。
 * @param exec - 调用方。
 * @param args - `{ to, artifact, path, need, task }`（四项必填；`task` 可选，任务编号，供面板按任务关联）。
 * @returns `{ ok, note, file, total }`。
 */
export async function recordHandoffNote(ctx, exec, args) {
	const to = B.requireText(args?.to, 'to')
	const artifact = B.requireText(args?.artifact, 'artifact')
	const path = B.requireText(args?.path, 'path')
	const need = B.requireText(args?.need, 'need')
	const workspace = B.workspaceRootOf(exec)
	const absPath = B.ledgerPath(workspace, HANDOFFS_FILE)
	const from = await senderLabelOf(ctx, exec)
	const outcome = await B.transact(ctx, absPath, exec, async () => {
		const snapshot = await B.readLedger(ctx, absPath, exec)
		const value = snapshot.kind === 'absent' ? { version: B.LEDGER_VERSION, notes: [] } : snapshot.value
		const notes = Array.isArray(value.notes) ? value.notes : []
		const task = typeof args?.task === 'string' ? args.task.trim() : ''
		const note = { from, to, artifact, path, need, at: new Date().toISOString() }
		if (task !== '') note.task = task
		const next = {
			...value,
			version: B.LEDGER_VERSION,
			seq: Number.isInteger(value.seq) ? value.seq + 1 : 1,
			writer: B.writerStamp(),
			notes: [...notes, note].slice(-HANDOFFS_MAX),
		}
		// 必须真落盘：transact 只串行 + CAS，写回要自己调 commitLedger。
		await B.commitLedger(ctx, absPath, snapshot, next, exec)
		return { note, file: absPath, total: next.notes.length }
	})
	return { ok: true, ...outcome }
}

/**
 * 读交接单（最近 N 条，默认全部）。
 * @param ctx - 宿主上下文。
 * @param exec - 调用方。
 * @param options - `{ limit }`。
 * @returns `{ ok, notes, file, total }`。
 */
export async function listHandoffNotes(ctx, exec, options = {}) {
	const workspace = B.workspaceRootOf(exec)
	const absPath = B.ledgerPath(workspace, HANDOFFS_FILE)
	const snapshot = await B.readLedger(ctx, absPath, exec)
	const value = snapshot.kind === 'absent' ? { notes: [] } : snapshot.value
	const notes = Array.isArray(value.notes) ? value.notes : []
	const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : notes.length
	return { ok: true, notes: notes.slice(-limit), file: absPath, total: notes.length }
}

/**
 * 任务包两格检查。
 * @param description - 原生任务的 description。
 * @returns `{ hasForm, hasAcceptance, complete }`。
 */
export function taskPackOf(description) {
	const text = String(description ?? '')
	const hasForm = FORM_HINT.test(text)
	const hasAcceptance = ACCEPT_HINT.test(text)
	return { hasForm, hasAcceptance, complete: hasForm && hasAcceptance }
}

/**
 * 协作效率度量：任务三态、交接单数、路径归属冲突数、任务包缺格数。
 * @param ctx - 宿主上下文。
 * @param exec - 调用方。
 * @param options - `{ handoffs }`：调用方**已经读过**的 `listHandoffNotes` 结果；
 *   给了就不再读一次盘（`/collab` 要同时回读数与明细，同一份文件读两遍纯属浪费）。
 * @returns `{ ok, tasks, handoffs, conflicts, packMissing }`。
 */
export async function collabMetricsOf(ctx, exec, options = {}) {
	const tasks = { total: 0, todo: 0, doing: 0, done: 0 }
	const rows = []
	// **读不到就是 `null`，不是零**：面板那一行印"完成 0/0"会被读成"没有任务"。
	let tasksAvailable = false
	let tasksReason = null
	// **先走 `ctx.get('agentTeams')`**：可选服务不进 `inject`，而宿主 ctx 上有 Guard ——
	// 直接读 `ctx.agentTeams` 会抛 `cannot get property "agentTeams" without inject`，
	// 于是 `/collab` 整个回 `ok:false`，面板上那两处交接单永远是空的（现场就这么空了一轮）。
	// 没有 `get` 的 ctx（测试桩、极简宿主）才退回直接读属性；两条都拿不到就是"服务不在"，不是"没有任务"。
	const service = serviceOf(ctx, 'agentTeams')
	const listTasks = typeof service?.listTasks === 'function' ? service.listTasks.bind(service) : undefined
	const caller = exec?.agent
	if (listTasks === undefined) {
		tasksReason = options.reason ?? '这个部署没有 Agent Teams 服务（`ctx.get("agentTeams")` 取不到）'
	} else if (caller === undefined || caller === null) {
		// 原生 `listTasks(caller)` 要一个**活着的本会话 Agent** 当凭据；拿不到就不去猜。
		tasksReason = options.reason ?? '这次读取没有会话凭据（拿不到本会话的 Agent）'
	} else {
		tasksAvailable = true
		const called = await listTasks(caller)
		const list = Array.isArray(called) ? called : Array.isArray(called?.value) ? called.value : []
		for (const row of list) {
			const status = row?.status
			tasks.total += 1
			if (status === '已完成' || status === 'completed') tasks.done += 1
			else if (status === '进行中' || status === 'in_progress') tasks.doing += 1
			else tasks.todo += 1
			rows.push(row)
		}
	}
	const handoffs = options.handoffs === undefined ? await listHandoffNotes(ctx, exec) : options.handoffs
	const packMissing = rows.filter((row) => !taskPackOf(row?.description).complete).length
	const conflicts = contractConflicts(allRoleContracts()).length
	const handoffGaps = handoffs.notes.filter((note) => !note.artifact || !note.path || !note.need).length
	return {
		ok: true,
		tasks: tasksAvailable ? tasks : null,
		...(tasksAvailable ? {} : { tasksReason }),
		handoffs: { total: handoffs.total, gaps: handoffGaps, file: handoffs.file },
		conflicts,
		packMissing,
	}
}
