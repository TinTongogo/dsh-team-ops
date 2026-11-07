/**
 * 账本存储层：状态文件的读-改-写原语、按文件事务队列、CAS 递交与路径解析。
 *
 * 从 `team/company-gate.js` 分出来之后，制度层只剩业务工具（人的话 / 角色开关 / 看板转发 /
 * 产物校验）；这一层不认任何业务字段，只保证「读不到不降级成空文件、递交前重读比对、
 * 写临时文件再改名、同一文件串行」。
 */
import { rename as renamePath } from 'node:fs/promises'
import { hostname } from 'node:os'
import { isAbsolute as isAbsolutePath, join as joinPath } from 'node:path'
import { migrateWorkspaceSync } from './ops-files.js'

/** 序号补齐到三位：人的话 HD-<三位序号>（本插件还在发的只剩这一族）。 */
const ID_DIGITS = 3
/** 事务边界重跑上限：递交前比对冲突时整段重跑，超过即回报并发冲突。 */
const MAX_CAS_ATTEMPTS = 3
/** 文件顶层 `writer` 距现在不超过该毫秒数时，视为「别的进程刚写过」，只告警不合并。 */
const FOREIGN_WRITE_WINDOW_MS = 30_000
/** 结构化「未找到」信号：只有这些码（或 `stat` 返回 undefined）才算文件不在。 */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR', 'FS_NOT_FOUND'])
/** libuv 的 ENOENT / ENOTDIR 数值形式，供只带 errno 的运行时报错识别。 */
const ABSENT_ERRNOS = new Set([-2, -20])

/** 读到别处写入、或编号唯一性没查全时的告警文案由各自的判定函数生成；此常量只放共用措辞。 */
const CAS_NOTE = '本次写为「重读比对 → 写临时文件 → 改名发布」，比对与改名之间仍有窗口。'

// ── 错误与结果 ───────────────────────────────────────────────────────────────

/** 文件读取失败：文件在、但读不出来或读出来不可用。写 action 收到它必须中止。 */
export class LedgerReadError extends Error {
	constructor(message) {
		super(message)
		this.name = 'LedgerReadError'
	}
}

/** 递交前重读与快照不一致：另一个写者改动了同一文件。 */
export class CasConflictError extends Error {
	constructor(message) {
		super(message)
		this.name = 'CasConflictError'
	}
}

/** 把任意抛出物压成一行可读原因；有结构化码时只报码，避免把外部措辞混进文件错误。 */
export function failureReason(error) {
	if (error === null || error === undefined) return '未知错误'
	if (typeof error !== 'object') return String(error)
	if (typeof error.code === 'string' || typeof error.code === 'number') return String(error.code)
	const name = typeof error.name === 'string' ? error.name : 'Error'
	const message = typeof error.message === 'string' ? error.message : ''
	return (message === '' ? name : `${name}: ${message}`).slice(0, 160)
}

/** 统一的读取失败错误：显式中止，且不把失败说成「空文件」。 */
export function readFailure(path, error) {
	return new LedgerReadError(
		`读取失败：${path}（原因：${failureReason(error)}）；为避免覆盖既有文件，本次操作已中止，磁盘内容未改动。`,
	)
}

/** 结构化「未找到」判定：只看码与 errno，绝不匹配错误文本。 */
export function isAbsentError(error) {
	if (error === null || typeof error !== 'object') return false
	if (typeof error.code === 'string' && ABSENT_CODES.has(error.code)) return true
	return typeof error.errno === 'number' && ABSENT_ERRNOS.has(error.errno)
}

/** 工具回执：成功。 */
export function okJson(payload) {
	return JSON.stringify({ ok: true, ...payload })
}

/** 工具回执：失败。没写进文件、或无法确认写没写成功时，只走这里，绝不返回 ok。 */
export function failJson(error) {
	const message = error instanceof Error ? error.message : String(error)
	return JSON.stringify({ ok: false, error: message })
}



// ── 参数校验 ─────────────────────────────────────────────────────────────────

/** 取必填非空字符串，缺省或空白即报错。 */
export function requireText(value, field) {
	if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} 必填，且必须是非空字符串。`)
	return value.trim()
}

/** 取可选字符串：缺省返回 undefined，给了但不是字符串即报错。 */
export function optionalText(value, field) {
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'string') throw new Error(`${field} 必须是字符串。`)
	return value.trim()
}

/** 取枚举值，`fallback` 为 undefined 时该字段必填。 */
export function requireEnum(value, allowed, field, fallback) {
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
export function idNumber(id) {
	if (typeof id !== 'string') return null
	const matched = /^[A-Z]+-(\d+)/.exec(id)
	if (matched === null) return null
	const value = Number.parseInt(matched[1], 10)
	return Number.isFinite(value) ? value : null
}

/** 渲染编号：前缀 + 补零序号。 */
export function formatId(prefix, value) {
	return `${prefix}-${String(value).padStart(ID_DIGITS, '0')}`
}

/**
 * 下一个可用序号：取已记录水位与既有条目编号的最大值加一。
 * 既保证不重用编号，也让水位缺失的文件（条目齐备但水位缺失）能继续递增。
 */
export function nextNumber(recorded, numbers) {
	let highest = Number.isInteger(recorded) && recorded >= 0 ? recorded : 0
	for (const value of numbers) if (typeof value === 'number' && value > highest) highest = value
	return highest + 1
}

/** 收集数组里每一项的首段编号数字，供 `nextNumber` 使用。 */
export function numbersOf(items) {
	return items.map((item) => idNumber(item?.id))
}

// ── 写者标记与并发告警 ───────────────────────────────────────────────────────

/** 文件顶层写者标记：谁在何时写的，供跨进程只读比对。 */
export function writerStamp() {
	return { pid: process.pid, host: hostname(), at: new Date().toISOString() }
}

/** 只检出、不合并：他方写入发生在窗口内时给一条告警。 */
export function foreignWriterWarnings(value) {
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
export function signalOf(exec) {
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
export function workspaceRootOf(exec) {
	const explicit = typeof exec?.workspace === 'string' && exec.workspace.trim() !== '' ? exec.workspace.trim() : undefined
	if (explicit !== undefined) return explicit
	const cwd = exec?.agent?.session?.header?.cwd
	if (typeof cwd === 'string' && cwd.trim() !== '') return cwd
	return process.cwd()
}

/** 解析状态文件的绝对路径：文件名固定相对于工作区根。 */
export function ledgerPath(workspace, name) {
	// 旧布局（`.company-gate.*`）在第一次读时顺手迁到 `.ops/`（幂等；只碰这几个固定文件名）。
	migrateWorkspaceSync(workspace)
	return joinPath(workspace, name)
}

/** 把调用方给的产物路径解析成绝对路径：绝对路径原样使用，相对路径按工作区根解析。 */
export function artifactPath(workspace, requested) {
	return isAbsolutePath(requested) ? requested : joinPath(workspace, requested)
}

/** 解析一个绝对路径为目标身份；`opts` 只在带信号时给出。 */
export function resolveTarget(ctx, absPath, exec) {
	const signal = signalOf(exec)
	return ctx.fs.resolve(absPath, signal === undefined ? undefined : { signal })
}

/**
 * 目标在宿主/执行世界里的进程路径；后端没提供映射时退回传入的绝对路径。
 * 改名的两端必须来自同一个后端，因此两端都用此函数取值。
 */
export function processPathOf(ctx, target, fallback) {
	const mapped = typeof ctx.fs.processPath === 'function' ? ctx.fs.processPath(target) : undefined
	return typeof mapped === 'string' && mapped.length > 0 ? mapped : fallback
}

/**
 * 按调用会话解析本次写入的沙箱策略，交给后端裁定；服务缺失时返回 undefined，
 * 由后端用自己的默认策略裁定 —— 拒绝会显式报错，不会静默通过。
 */
export function policyFor(ctx, exec) {
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
export async function readTextSnapshot(ctx, absPath, exec) {
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
export async function readLedger(ctx, absPath, exec) {
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
export function collectionOf(value, absPath, field) {
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
 * 递交：重读**原文**与快照比对（不一致即并发冲突），再把新内容写成同目录临时文件并改名发布。
 * 冲突抛出点在写盘之前，所以调用方在事务边界重跑整段是幂等安全的。
 *
 * 这里只需要原文比对，不需要再 JSON.parse 一遍：`snapshot` 已经是解析过的值，
 * 重读的那一份只要文本逐字相同就说明没有别的写者插进来（跨进程改动也照样被看见）。
 * 返回写进文件后的文本，供调用方核对。
 */
export async function commitLedger(ctx, absPath, snapshot, nextValue, exec) {
	const current = await readTextSnapshot(ctx, absPath, exec)
	const currentText = current.kind === 'present' ? current.text : ''
	const snapshotText = snapshot.kind === 'present' ? snapshot.text : ''
	if (current.kind !== snapshot.kind || currentText !== snapshotText) {
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
export function enqueueByFile(key, task) {
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
export function transact(ctx, fileKey, exec, handler) {
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

