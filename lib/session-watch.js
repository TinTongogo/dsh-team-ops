/**
 * 会话事件监听 —— 补两块缺口（见 `docs/team/specs/上下文连贯性补缺.md`）。
 *
 * 1. **快照事件化**：原生 `team_task_*` 也能改账，而旧实现只在我们的 `board_task` 里写
 *    `.ops/handoff.json` ⇒ 快照会滞后（现场：任务已 completed，摘要还写「进行中」）。
 *    这里订阅 `ctx.on('session/event')`，看到 Lead 会话上的 `team/task` / `team/member`
 *    就防抖重算一次快照。
 * 2. **压缩检查点**：DSH 自动压缩提交 `compaction/summary` 时，把摘要 + 被压事件的原文
 *    落到 `.ops/checkpoints/compaction/…`（派生、可删）——「不丢」的兜底。
 *
 * 纪律：
 *   · 所有订阅与写盘都用 try/catch 包住 —— 监听坏了绝不能影响宿主会话；每类失败只 warn 一次。
 *   · 只写 `session.header.cwd` 这个工作区；拿不到就跳过。
 *   · 事件形状是宿主内部契约：形状不符就跳过（不猜、不抛）。
 */
import { writeCompactionCheckpoint } from './checkpoint.js'
import { recordHandoffFor } from '../team/company-gate.js'
import { memberBackendOf } from '../team/member-backend.js'

/** 同一会话上连续事件合并成一次快照刷新。 */
const HANDFOFF_DEBOUNCE_MS = 250
/** 被压事件原文的渲染上限（写盘前再按文件上限截断一次）。 */
const RENDER_MAX_CHARS = 400 * 1024

/** 工作区：只认会话头里的绝对 cwd。 */
function workspaceOf(session) {
	const cwd = session?.header?.cwd
	return typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : ''
}

/** 活 agent 的队内身份（`{ role, root }`）；不在队内返回 null。 */
function membershipOf(ctx, agent) {
	if (agent === undefined || agent === null) return null
	const service = typeof ctx?.get === 'function' ? ctx.get('agentTeams') : undefined
	try {
		const membership = service?.tryMembership?.(agent)
		return membership !== null && typeof membership === 'object' && typeof membership.role === 'string' ? membership : null
	} catch {
		return null
	}
}

/**
 * 这个会话是不是**真的有团队语境**：成员会话直接算；Lead 会话要求名册里至少有一位队友。
 *
 * 不能只看 `tryMembership`：宿主对任何非子代理的 root agent 都返回 `role:'lead'`
 * （哪怕这个工作区从没组过队）—— 只看它会让插件在任何主会话压缩时都往工作区写盘。
 */
async function teamMembershipOf(ctx, agent) {
	const membership = membershipOf(ctx, agent)
	if (membership === null) return null
	if (membership.role === 'teammate') return membership
	if (membership.role !== 'lead') return null
	const backend = memberBackendOf(ctx)
	if (backend === null || backend.capabilities.list !== true) return null
	try {
		const listed = await backend.list(membership.root ?? agent)
		const rows = listed.ok === true && Array.isArray(listed.rows) ? listed.rows : []
		return rows.some((row) => row?.role === 'teammate') ? membership : null
	} catch {
		return null
	}
}

/** 压缩摘要正文：宿主给的是 `ContentBlock[]`（schema 与 commit 都是），也兼容旧 string。 */
function summaryTextOf(value) {
	if (typeof value === 'string') return value
	if (!Array.isArray(value)) return ''
	return value.map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : '')).join('')
}

/** 把被压掉的会话事件渲染成 Markdown（纯数据，不调模型；超限截断）。 */
function renderShadowed(session, seqs) {
	const lines = []
	let used = 0
	for (const seq of Array.isArray(seqs) ? seqs : []) {
		let event
		try {
			event = session?.eventAt?.(seq)
		} catch {
			event = undefined
		}
		if (event === undefined || event === null) continue
		let body
		try {
			body = JSON.stringify(event.data)
		} catch {
			body = ''
		}
		const line = `### seq ${seq} · ${typeof event.type === 'string' ? event.type : '?'}\n\n\`\`\`json\n${body === undefined ? '' : body}\n\`\`\`\n`
		if (used + line.length > RENDER_MAX_CHARS) {
			lines.push('\n…（被压事件过多，已按上限截断；完整内容见 DSH 会话日志）\n')
			break
		}
		used += line.length
		lines.push(line)
	}
	return lines.join('\n')
}

/**
 * 安装监听。
 * @param ctx - 宿主上下文（需要 `ctx.on`；`agents` / `agentTeams` 都是可选服务）。
 * @returns 注销函数（清订阅与所有定时器）。
 */
export function installSessionWatch(ctx, dependencies = {}) {
	// 可注入：单测用假实现（默认就是引擎里那份写快照）。
	const recordHandoff = typeof dependencies.recordHandoff === 'function' ? dependencies.recordHandoff : recordHandoffFor
	const warnings = new Set()
	/** 去重表也要有界：长期运行的会话里，异常日志不该无限增长（满了整表清一次，重复一句无害）。 */
	const WARN_ONCE_MAX = 200
	const warnOnce = (message) => {
		if (warnings.has(message)) return
		if (warnings.size >= WARN_ONCE_MAX) warnings.clear()
		warnings.add(message)
		try {
			ctx?.logger?.warn?.(message)
		} catch {
			/* 日志服务坏了也不能影响监听 */
		}
	}
	if (typeof ctx?.on !== 'function') {
		warnOnce('team-ops：宿主没有 `ctx.on`，会话事件监听跳过（快照仍只在 board_task 改动时写）。')
		return () => {}
	}
	/** Lead 会话 → 快照刷新定时器。 */
	const timers = new Map()

	const scheduleHandoff = (session) => {
		const workspace = workspaceOf(session)
		if (workspace === '') return
		const key = session.id
		const previous = timers.get(key)
		if (previous !== undefined) clearTimeout(previous)
		const timer = setTimeout(() => {
			timers.delete(key)
			const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
			let lead
			try {
				lead = agents?.get?.(session.id)
			} catch {
				lead = undefined
			}
			if (lead === undefined || lead === null) return
			void recordHandoff(ctx, lead).catch((error) => {
				warnOnce('team-ops：事件触发的快照刷新失败（快照是派生物，不影响任务）：' + String(error?.message ?? error))
			})
		}, HANDFOFF_DEBOUNCE_MS)
		timers.set(key, timer)
	}

	const writeCompaction = async (session, event) => {
		const workspace = workspaceOf(session)
		if (workspace === '') return
		const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
		let agent
		try {
			agent = agents?.get?.(session.id)
		} catch {
			agent = undefined
		}
		const membership = await teamMembershipOf(ctx, agent)
		// 只给**真的有团队语境**的会话落检查点；普通主会话没有队友时不占盘。
		if (membership === null) return
		const data = event?.data
		if (data === null || typeof data !== 'object') return
		// **渲染放到下一拍**：事件回调节点里不跑 JSON.stringify 大段被压事件（不卡宿主）。
		const timer = setTimeout(() => {
			let rendered = ''
			try {
				rendered = renderShadowed(session, data.shadowedSeqs)
			} catch {
				rendered = ''
			}
			void writeCompactionCheckpoint(workspace, {
				sessionId: typeof session.id === 'string' ? session.id : '',
				compactionId: typeof data.compactionId === 'string' ? data.compactionId : '',
				role: membership.role,
				at: new Date().toISOString(),
				summary: summaryTextOf(data.summary),
				provider: typeof data.provider === 'string' ? data.provider : '',
				model: typeof data.model === 'string' ? data.model : '',
				shadowedRange: data.shadowedRange,
				tokens: typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : undefined,
				rendered,
			}).catch((error) => {
				warnOnce('team-ops：压缩检查点没写成功（不影响会话）：' + String(error?.message ?? error))
			})
		}, 0)
		try {
			if (typeof timer?.unref === 'function') timer.unref()
		} catch {
			/* 浏览环境没有 unref */
		}
	}


	const onEvent = (session, event) => {
		try {
			const type = typeof event?.type === 'string' ? event.type : ''
			// 团队账本事件挂在 **Lead 会话**上（`journal.appendAndFlush(root, "team/task" …)`）。
			if (type === 'team/task' || type === 'team/member') {
				scheduleHandoff(session)
				return
			}
			if (type === 'compaction/summary') {
				void writeCompaction(session, event).catch((error) => {
					warnOnce('team-ops：压缩检查点没写成功（不影响会话）：' + String(error?.message ?? error))
				})
				return
			}

		} catch (error) {
			warnOnce('team-ops：会话事件处理失败（不影响会话）：' + String(error?.message ?? error))
		}
	}

	let off = null
	try {
		off = ctx.on('session/event', onEvent)
	} catch (error) {
		warnOnce('team-ops：订阅 `session/event` 失败（不影响会话）：' + String(error?.message ?? error))
		return () => {}
	}
	return () => {
		for (const timer of timers.values()) clearTimeout(timer)
		timers.clear()
		try {
			if (typeof off === 'function') off()
		} catch {
			/* 注销失败不影响进程退出 */
		}
	}
}
