/**
 * 一人公司团队插件 · 自检（`node --test tests/`）
 *
 * 这份自检**不依赖 DSH 宿主**：它用一份最小假 ctx（真文件系统 + 假子代理/假 Agent 注册表）
 * 驱动两个半边 —— 制度层（`company-gate.js`）与运行时层（`team-runtime.js`）。
 * 于是"文件会拒什么"这件事可以在 CI 里跑，而不是只能靠人反复重启应用去观察。
 *
 * 覆盖的判据（每条都对应文档里的一句话）：
 * · 名册：编号空间、名字永久占位、角色名册校验、成员不能生人；
 * · 邮箱：落盘即成功、投递回执（source 标签 → 已读）、过代邮件不投递、队列上限；
 * · 看板：CAS 版本号、依赖门禁与环检测、执行代凭据（迟到结果被拒）、
 * 留痕删除、写盘面重叠告警、例外任务的批准闸；
 * · 调度：空闲自动续领（角色匹配）、观察到 idle 边即 park（不自动重试）、冷恢复只放行一次。
 */

// **测试与用户真实目录隔离**：这一行必须在读取引擎之前 —— 见 `tests/isolate.mjs`（它设临时 `DSH_HOME` /
// `DSH_TEAM_OPS_ROLES`）。隔离只做这一处，不靠每条用例各自记得设。
import { ISOLATION_PREFIX, resetIsolatedHome } from './isolate.mjs'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, statSync, writeFileSync } from 'node:fs'

/**
 * **语料**：`team/BASELINE.md` + `team/rules/*.md`。
 *
 * 为什么要有它：BASELINE 现在是**两层** —— 正文只留**规则 / 动作**级，长表 / 举例 / 现场教训 / 理由搬进
 * `team/rules/*.md`（按需读）。**规则一条没少**，只是位置变了 ⇒ 凡"钉规则原文"的断言应当核**语料**；
 * 只有"这条正文不许在 BASELINE 里抄第二份"这类**结构性**断言才继续只读 BASELINE。
 */
function baselineCorpusOf() {
	const files = [
		'team/BASELINE.md',
		...readdirSync('team/rules')
			.filter((name) => name.endsWith('.md'))
			.map((name) => 'team/rules/' + name),
	]
	return files.map((file) => readFileSync(file, 'utf8')).join('\n')
}
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'

// **每个用例从一个干净的用户根开始**：用例之间不许看见对方写进用户根的
// 角色/技能（"单跑绿、合起来红"的两个成因都是它）。
beforeEach(resetIsolatedHome)

// **哨兵**：测试进程的用户根必须落在隔离 home 里 —— 去掉 `tests/isolate.mjs` 里那两行赋值，
// 这条就当场红（不给"忘了设根"任何复活的机会）。
test('哨兵：测试进程的用户根落在临时目录里（不许碰用户真实目录）', async () => {
	const { userRolesRoot } = await import('../lib/roster.js')
	const { skillRootOf } = await import('../lib/skill-write.js')
	assert.ok(userRolesRoot().startsWith(ISOLATION_PREFIX), `角色根必须落在隔离 home 里，实际是 ${userRolesRoot()}`)
	assert.ok(skillRootOf('user', '<工作区>').startsWith(ISOLATION_PREFIX), `用户技能根同理，实际是 ${skillRootOf('user', '<工作区>')}`)
})


const gate = await import('../team/company-gate.js')
const runtime = await import('../team/team-runtime.js')

// ── 假宿主 ───────────────────────────────────────────────────────────────────

/** 真文件系统之上的最小 `ctx.fs`：只用 Node 内建，与宿主那套方法名一一对应。 */
function makeFs() {
	/** 宿主的 `resolve` 返回的是**不透明目标**，其余方法都吃它 —— 桩里用 `{ path }` 表示同一件事。 */
	const pathOf = (target) => (typeof target === 'string' ? target : target?.path)
	return {
		async resolve(path) {
			return { path, displayPath: path }
		},
		async stat(target) {
			try {
				const info = statSync(pathOf(target))
				return { type: info.isDirectory() ? 'directory' : 'file', size: info.size }
			} catch (error) {
				if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
				throw error
			}
		},
		async readText(target) {
			return readFileSync(pathOf(target), 'utf8')
		},
		async writeText(target, data) {
			writeFileSync(pathOf(target), data)
		},
		processPath(target) {
			return pathOf(target)
		},
	}
}

const DELIVER_SYMBOL = Symbol.for('dsh.subagent.deliverPrompt')

/**
 * 照宿主 schema 校验队伍载荷的**形状** —— 消息正文与首活提示词都必须是**内容块数组**
 * （`AT:1121` 的 `contentBlockSchema`，`AT:1179` 的 `content: z.array(contentBlockSchema)`；
 * 提示词那一侧同一条约定 —— 宿主 `spawn_teammate` 传的是 `prompt: [ …块 ]`，`AT:274`）。
 *
 * 为什么非加不可：旧假件只校验 `signal`，于是"把字符串当块数组传"这件事**一条都不红**；
 * 真宿主那边写路径也不校验，字符串被原样落进队伍日志，等回放到 `parsePersisted` 才炸成
 * `persisted Agent Teams <事件类型> payload is invalid`（`AT:1239-1245`），
 * 而队伍日志是整条一起回放的 —— 一条坏事件污染整条日志（现场症状：`member_send` 恒失败）。
 * 这里抛的**就是宿主那句话**，好让变异自证的红色输出与现场一致。
 *
 * 提示词那条路真宿主不抛这句（它会 `[...prompt]` 把字符串摊成单个字符，静默变味）——
 * 假件对两条路用同一句话，是为了让"形状不对"这件事只有一个、认得出的红色信号。
 */
function assertTeamPayloadShape(payload) {
	const invalid = () => {
		throw new Error('persisted Agent Teams team/message/queued payload is invalid')
	}
	if (!Array.isArray(payload)) invalid()
	for (const block of payload) {
		if (block === null || typeof block !== 'object' || Array.isArray(block)) invalid()
		if (block.type !== 'text' || typeof block.text !== 'string') invalid()
	}
}

/**
 * 一份最小 ctx：注册表、子代理接缝、Agent 注册表、事件钩子都记在闭包里，
 * 于是测试可以主动"发一条状态边"或"往某个会话塞一条带 source 的消息"。
 */
/** 原生 `TeamService` 的假桩：形状照它的公开方法（少一个都会让薄层走到"服务不在"那条路）。 */
/**
 * 原生 `TeamService` 的假桩：形状与**契约**都照它的公开方法（少一个都会让薄层走到"服务不在"那条路）。
 *
 * 三处按宿主原文校验 `signal`（`AT:49` / `AT:547` / `AT:771`）—— 这正是旧假件缺的那条契约：
 * 插件不传 `signal` 时真宿主当场抛，而旧假件只 `push`，于是自检一条都不红。
 * 任务视图也照宿主 `projectTaskView` 的形状：负责人那一格叫 `ownerName`，`ready` 是**原生算的**。
 */
function nativeTeamStub() {
	const members = []
	const tasks = new Map()
	const calls = { spawn: [], send: [], wait: [], task: [] }
	const lifecycle = new AbortController()
	let seq = 0
	const ownerNameOf = (ownerId) =>
		ownerId === undefined ? undefined : ownerId === 'session-lead' ? 'lead' : members.find((member) => member.id === ownerId)?.name
	/** 照宿主 `projectTaskView`：`ready` = 待办且依赖全部已完成（不在假件里自己发明一套口径）。 */
	const viewOf = (task) => ({
		id: task.id,
		revision: task.revision,
		subject: task.subject,
		description: task.description,
		status: task.status,
		blockedBy: [...task.blockedBy],
		writeScopes: [...task.writeScopes],
		...(task.ownerId === undefined ? {} : { ownerName: ownerNameOf(task.ownerId) }),
		ready: task.status === 'pending' && task.blockedBy.every((id) => tasks.get(id)?.status === 'completed'),
		writeScopeWarnings: [],
	})
	return {
		members,
		calls,
		service: {
			// **像真层一样挑调用者**（现场：`listMembers(undefined)` 去读 `undefined.id` 抛 TypeError）——
			// 从前这个假件不挑，于是"HTTP 端点那条路上 `exec.agent` 是 undefined"这整类错一条用例都没抓到。
			listMembers: (caller) => {
				if (caller === undefined || caller === null) throw new TypeError("Cannot read properties of undefined (reading 'id')")
				return [{ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' }, ...members]
			},
			// 照宿主 `tryMembership` 的两条分支：**有父会话 = 子代理（teammate）**、根会话 = lead。
			// 行政面的身份判据（`coordinatorCheckOf`）优先读它，读不到才回落看父会话。
			tryMembership(agent) {
				const parentId = agent?.session?.header?.parentSession
				if (typeof parentId === 'string' && parentId !== '') return { id: agent?.id ?? '', role: 'teammate', name: agent?.id ?? '' }
				return { id: agent?.id ?? '', role: 'lead', name: 'lead' }
			},
			async spawnTeammate(caller, request) {
				// 宿主 `spawnAdmitted` 原文：`const signal = AbortSignal.any([request.signal, this.lifecycle.signal]); signal.throwIfAborted();`
				const signal = AbortSignal.any([request.signal, lifecycle.signal])
				signal.throwIfAborted()
				// 首活提示词必须是块数组（宿主 `spawn_teammate` 就是这么传的；字符串会被摊成单个字符）。
				assertTeamPayloadShape(request.prompt)
				calls.spawn.push(request)
				const row = { id: request.name, name: request.name, role: 'teammate', status: 'idle', description: request.description }
				members.push(row)
				return row
			},
			async sendMessage(caller, request) {
				// 宿主 `mailbox.send` 原文：`signal: AbortSignal.any([request.signal, this.lifecycle.signal])`
				const signal = AbortSignal.any([request.signal, lifecycle.signal])
				signal.throwIfAborted()
				// 消息正文必须是块数组：这是 `team/message/queued` 那份 schema 的硬要求。
				assertTeamPayloadShape(request.content)
				calls.send.push(request)
				return { messageId: 'm-' + String(++seq), delivered: true }
			},
			async createTask(caller, request) {
				const created = {
					id: 'task-' + String(++seq),
					revision: 1,
					subject: request.subject,
					description: request.description,
					status: 'pending',
					blockedBy: Array.isArray(request.blockedBy) ? [...request.blockedBy] : [],
					writeScopes: Array.isArray(request.writeScopes) ? [...request.writeScopes] : [],
				}
				tasks.set(created.id, created)
				calls.task.push(['create', created])
				return viewOf(created)
			},
			getTask: (caller, id) => {
				const found = tasks.get(id)
				if (found === undefined) throw new Error(`team task "${id}" not found`)
				return viewOf(found)
			},
			listTasks: () => [...tasks.values()].map((task) => viewOf(task)),
			// **照原生的状态机实现**（读自宿主 `tasks.update`）：三态、只有 in_progress 能 complete、
			// edit/set_dependencies/reassign 要 owner、CAS 走 expectedRevision。假桩不照做，用例就是空的。
			async updateTask(caller, request) {
				const current = tasks.get(request.taskId)
				if (current === undefined) throw new Error(`team task "${request.taskId}" not found`)
				// **严格校验**（照真服务）：不传也算对不上 —— 宽松的假桩会让"过期被拒"的用例被别的
				// 原因挡住而假绿（自证时抓到过：抽掉版本号传递，用例照样过）。
				if (request.expectedRevision !== current.revision) {
					throw new Error(`team task "${request.taskId}" revision mismatch`)
				}
				if (current.status === 'deleted') throw new Error('task is deleted')
				let next
				switch (request.action) {
					case 'claim':
						if (current.status !== 'pending') throw new Error('only a pending task can be claimed')
						// **归属是调用者本人**：原生不读 `request.owner`（要换人请认领后用 reassign）。
						next = { ...current, status: 'in_progress', ownerId: caller?.id ?? 'someone' }
						break
					case 'release':
						if (current.status !== 'in_progress') throw new Error('only an in-progress task can be released')
						next = { ...current, status: 'pending', ownerId: undefined }
						break
					case 'complete':
						if (current.status !== 'in_progress') throw new Error('only an in-progress task can complete')
						next = { ...current, status: 'completed' }
						break
					case 'reopen':
						next = { ...current, status: 'pending', ownerId: undefined }
						break
					case 'reassign':
						next =
							request.owner === undefined
								? { ...current, ownerId: undefined }
								: { ...current, ownerId: members.find((member) => member.name === request.owner)?.id ?? request.owner }
						break
					case 'edit':
						next = {
							...current,
							...(request.subject === undefined ? {} : { subject: request.subject }),
							...(request.description === undefined ? {} : { description: request.description }),
							...(request.writeScopes === undefined ? {} : { writeScopes: [...request.writeScopes] }),
						}
						break
					case 'set_dependencies':
						if (request.blockedBy === undefined) throw new Error('set_dependencies requires blocked_by')
						for (const dep of request.blockedBy) {
							if (dep === current.id) throw new Error('task depends on itself')
							const target = tasks.get(dep)
							if (target !== undefined && Array.isArray(target.blockedBy) && target.blockedBy.includes(current.id)) throw new Error('dependency cycle')
						}
						next = { ...current, blockedBy: [...request.blockedBy] }
						break
					case 'delete':
						next = { ...current, status: 'deleted' }
						break
					default:
						throw new Error(`unknown action "${String(request.action)}"`)
				}
				next.revision = current.revision + 1
				next.id = current.id
				tasks.set(next.id, next)
				calls.task.push(['update', request])
				return viewOf(next)
			},
			async waitForChange(caller, timeoutMs, signal) {
				// 宿主 `activity.wait` 第一句就是 `signal.throwIfAborted();`
				signal.throwIfAborted()
				calls.wait.push({ caller, timeoutMs, signal })
				return { changed: false, reason: 'timeout' }
			},
		},
	}
}

function makeHost(workspace) {
	const registered = new Map()
	const handlers = new Map()
	const spawned = []
	const deliveries = []
	const interrupts = []
	const agents = []
	const ctx = {
		fs: makeFs(),
		logger: { info() {}, warn() {} },
		tools: {
			register(definition) {
				registered.set(definition.name, definition)
				return () => registered.delete(definition.name)
			},
			get(name) {
				return registered.get(name)
			},
		},
		systemPrompt: {
			section() {
				return () => {}
			},
			getSectionOrder() {
				return 600
			},
		},
		subagents: {
			async startContinuable(spec) {
				// **照真宿主那套"无损 JSON"校验做白名单**（现场踩过：`request.signal` 是个 AbortSignal，
				// 宿主的描述符校验会拒它并把成员建成失败，而假桩当时只 push、不做校验 ⇒ 139 条全绿却建不出人）。
				// 判据用**白名单**：只许 JSON 原生值（null / 布尔 / 有限数 / 字符串）；
				// "JSON 往返前后一致"查不出来 —— AbortSignal 的可枚举键本来就是 0。
				const assertLossless = (value, path) => {
					if (value === null) return
					const t = typeof value
					if (t === 'boolean' || t === 'string') return
					if (t === 'number') {
						assert.ok(Number.isFinite(value) && !Object.is(value, -0), path + ' 不是有限数')
						return
					}
					if (t === 'undefined') assert.fail(path + ' 是 undefined（宿主拒收）')
					if (Array.isArray(value)) {
						value.forEach((item, index) => assertLossless(item, path + '[' + index + ']'))
						return
					}
					if (t === 'object') {
						const proto = Object.getPrototypeOf(value)
						assert.ok(proto === Object.prototype || proto === null, path + ' 的原型不是纯对象：' + (proto?.constructor?.name ?? 'null'))
						for (const key of Object.keys(value)) assertLossless(value[key], path + '.' + key)
						return
					}
					assert.fail(path + ' 是 ' + t + '（宿主只收 JSON 原生值）')
				}
				// 真宿主只把这些字段并进描述符；`request.signal` 不在其中，但**放进去本身就是错的用法**
				// （宿主自己的调用只把 signal 放顶层）——这里连"位置"一起钉住。
				assert.ok(typeof spec.label === 'string' && spec.label !== '', 'label 必须放在**顶层**（宿主读 spec.label；放进 request 会被当成 undefined 拒掉）')
				assert.equal(spec.request.signal, undefined, 'request 里不许放 signal（只放顶层）')
				assert.equal(spec.request.label, undefined, 'label 也不许放在 request 里（宿主读顶层那一个）')
				assertLossless(spec.label, 'label')
				assertLossless(spec.provider, 'provider')
				assertLossless(spec.request.persona, 'request.persona')
				assertLossless(spec.request.toolFilter, 'request.toolFilter')
				// **传了 `childId` 就回显它**：真宿主用传进来的那个 id 续起一个 continuable 会话
				// （"可续聊"就是这条）；假桩若总是新生一个 id，就测不出"续的是原来那个人"。
				const childId = typeof spec.childId === 'string' && spec.childId !== '' ? spec.childId : `child-${spawned.length + 1}`
				spawned.push({ spec, childId })
				return { childId, messageId: `initial-${spawned.length}` }
			},
			async sendMessage(sender, targetId, content) {
				deliveries.push({ path: 'sendMessage', senderId: sender?.id, targetId, content })
				return `inbox-send-${deliveries.length}`
			},
			async queuePrompt(parent, childId, content) {
				deliveries.push({ path: 'queuePrompt', senderId: parent?.id, targetId: childId, content })
				return `inbox-queue-${deliveries.length}`
			},
			async interrupt(targetId, authority) {
				interrupts.push({ targetId, authority })
			},
			async [DELIVER_SYMBOL](parent, childId, content, source, signal, delivery) {
				deliveries.push({ path: 'deliverPrompt', senderId: parent?.id, targetId: childId, content, source, delivery })
				return `inbox-deliver-${deliveries.length}`
			},
		},
		agents: {
			list() {
				return [...agents]
			},
			get(id) {
				return agents.find((agent) => agent.id === id)
			},
		},
		on(name, handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler])
			return () => {}
		},
		effect(callback) {
			return callback()
		},
		get() {
			return undefined
		},
	}
	return {
		ctx,
		registered,
		handlers,
		spawned,
		deliveries,
		interrupts,
		agents,
		/** 派发一个事件：参数**原样转发**（`session/event` 是两个参数：会话 + 事件）。 */
		emit(name, ...payload) {
			for (const handler of handlers.get(name) ?? []) handler(...payload)
		},
	}
}

/** 一个会话/Agent 桩：`workspaceRootOf` 只读 `session.header.cwd`。 */
function makeAgent(workspace, id, { parentSession, status = 'idle' } = {}) {
	const session = { header: { id, cwd: workspace, ...(parentSession === undefined ? {} : { parentSession }) } }
	return { id, session, status }
}

/** 安装两个半边（与预设里的两行一一对应）。 */
function install() {
	const workspace = mkdtempSync(join(tmpdir(), 'team-ops-'))
	const host = makeHost(workspace)
	// 原生队伍那一层：这一刀之后成员面全部走它（薄层 `team/native-layer.js`）。
	const native = nativeTeamStub()
	const baseGet = host.ctx.get.bind(host.ctx)
	host.ctx.get = (name) => (name === 'agentTeams' ? native.service : baseGet(name))
	const lead = makeAgent(workspace, 'session-lead')
	// 协调者的会话是活的：投递授权方必须是"确切的活着的父 Agent"，
	// 测试里把它放进注册表，才走得到真实投递那条路。
	host.agents.push(lead)
	gate.apply(host.ctx)
	runtime.apply(host.ctx)
	// 调用方的取消信号：真宿主每次工具执行都给一个（`exec.signal`），假 exec 也得给 ——
	// 成员面那三条路在原生那一侧无条件解引用它，没有它就恒失败（见下面「宿主契约」那一组）。
	return { workspace, host, lead, native, exec: { agent: lead, signal: new AbortController().signal } }
}

/** 调一个已注册的工具并解析回执（失败也是合法回执：`{ ok: false, error }`）。 */
async function call(host, name, args, exec) {
	const definition = host.registered.get(name)
	assert.ok(definition, `工具 ${name} 应当已注册`)
	return JSON.parse(await definition.execute(args ?? {}, exec))
}

/** 读回一份文件（文件不在时抛，好让断言消息直白）。 */
function ledger(workspace, name) {
	return JSON.parse(readFileSync(join(workspace, name), 'utf8'))
}

/**
 * 等一个后台链路跑完（钩子与投递回执都是 fire-and-forget）。
 * 用真定时器而不是 `setTimeout(0)`：链路里有真文件 I/O，microtask 轮次等不到它。
 */
async function flush(times = 3) {
	for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

// ── 角色名册 ─────────────────────────────────────────────────────────────────

describe('角色名册（角色定位的载体，清单现场枚举）', () => {
	test('名册 = team/roles/ 下带 ROLE.md 的目录（技能层已删，只有角色一类）', () => {
		const roles = runtime.roleCatalog()
		// **不写死个数**：包内是发布面，用户角色根里还可能有本机自己的角色（本体就搬过去了）。
		// 判据用"包内 roles/ 现场枚举"为准 —— 这样本机 20、别人机器 19 都不会假红。
		const packaged = readdirSync('team/roles').filter((name) => existsSync(join('team/roles', name, 'ROLE.md')))
		// **运行时名册 = 包内 ∪ 用户角色根**（同名时用户根胜）⇒ 只能断言"包含包内那批"，
		// 不能拿包内个数去等号（本机用户根里有角色时就会多出来 —— 本体已经搬过去了）。
		for (const id of packaged) assert.ok(roles.includes(id), `运行时名册缺包内角色：${id}`)
		assert.ok(packaged.length >= 19, `包内角色不该少于 19 个，实际 ${packaged.length}`)
		assert.ok(roles.includes('fe-dev') && roles.includes('reviewer') && roles.includes('architect'))
		assert.ok(!roles.includes('team-playbooks'), '技能层那一类（当年叫规范入口）已经不在名册里了')
		assert.deepEqual(roles, [...roles].sort(), '名册按名升序（回执可逐字比对）')
	})
})




// ── 看板 ─────────────────────────────────────────────────────────────────────







// ── 任务面：走 DSH 原生 Agent Teams 的任务板 ──────────────────────────────────

describe('任务面（原生）：三态、CAS、依赖门禁、team_status 与分栏对得上', () => {
	let env
	beforeEach(() => {
		env = install()
	})
	const board = (args) => call(env.host, 'board_task', args, env.exec)

	test('register 建的是原生的任务（字段按服务面的 camelCase），query/get 读得到', async () => {
		const created = await board({ action: 'register', subject: '做一件小事', description: '细节', blocked_by_tasks: [], write_scopes: ['docs/x.md'] })
		assert.equal(created.ok, true, JSON.stringify(created).slice(0, 200))
		assert.match(created.source, /原生/, '要说清建在哪本账上：' + created.source)
		const sent = env.native.calls.task[0][1]
		assert.equal(sent.subject, '做一件小事')
		assert.deepEqual(sent.writeScopes, ['docs/x.md'], '服务面是 camelCase：writeScopes')
		assert.deepEqual(created.task.blockedBy, [])
		const listed = await board({ action: 'query' })
		assert.equal(listed.count, 1)
		const got = await board({ action: 'get', id: created.task.id })
		assert.equal(got.task.subject, '做一件小事')
	})

	test('CAS：认领要版本号，过期即拒；认领后任务是进行中', async () => {
		const created = await board({ action: 'register', subject: 'a', description: 'a' })
		const claimed = await board({ action: 'claim', id: created.task.id, expected_revision: 1, assignee: 'revi-1' })
		assert.equal(claimed.ok, true, JSON.stringify(claimed).slice(0, 200))
		assert.equal(claimed.task.status, 'in_progress')
		// **原生不读 claim 的 assignee**：归属记成调用者本人（协调者这一行显示 `lead`），要用别的人请 reassign。
		assert.equal(claimed.task.ownerName, 'lead', '视图里负责人那一格是 ownerName：' + JSON.stringify(claimed.task))
		assert.equal(claimed.task.revision, 2, '原生每次变更 revision +1')
		const stale = await board({ action: 'claim', id: created.task.id, expected_revision: 1, assignee: 'revi-2' })
		assert.equal(stale.ok, false, '拿过期版本改要被拒：' + JSON.stringify(stale).slice(0, 160))
	})

	test('三态迁移：只有进行中能 complete；完成后 reopen 回到待办', async () => {
		const created = await board({ action: 'register', subject: 'b', description: 'b' })
		const early = await board({ action: 'complete', id: created.task.id, expected_revision: 1 })
		assert.equal(early.ok, false, '还没认领就收口 ⇒ 原生拒：' + JSON.stringify(early).slice(0, 160))
		await board({ action: 'claim', id: created.task.id, expected_revision: 1, assignee: 'revi-1' })
		const done = await board({ action: 'complete', id: created.task.id, expected_revision: 2 })
		assert.equal(done.task.status, 'completed')
		const back = await board({ action: 'reopen', id: created.task.id, expected_revision: 3 })
		assert.equal(back.task.status, 'pending')
	})

	test('依赖：set_dependencies 写 blockedBy；成环当场拒（否则整条链永远不可认领）', async () => {
		const first = await board({ action: 'register', subject: '先做', description: '先做' })
		const second = await board({ action: 'register', subject: '后做', description: '后做' })
		const dep = await board({ action: 'set_dependencies', id: second.task.id, expected_revision: 1, blocked_by_tasks: [first.task.id] })
		assert.equal(dep.ok, true, JSON.stringify(dep).slice(0, 200))
		assert.deepEqual(dep.task.blockedBy, [first.task.id])
		const cycle = await board({ action: 'set_dependencies', id: first.task.id, expected_revision: 1, blocked_by_tasks: [second.task.id] })
		assert.equal(cycle.ok, false, '成环要被拒：' + JSON.stringify(cycle).slice(0, 160))
	})

	test('原生没有的三档（submit / accept / reject）如实拒绝，并指出该用哪一档', async () => {
		const created = await board({ action: 'register', subject: 'c', description: 'c' })
		for (const action of ['submit', 'accept', 'reject']) {
			const refused = await board({ action, id: created.task.id, expected_revision: 1 })
			assert.equal(refused.ok, false, action + ' 要被拒')
			assert.match(refused.error, /原生任务板没有/, refused.error)
			assert.match(refused.error, /complete|member_send|另开一条/, '要指出去哪：' + refused.error)
		}
		const view = await board({ action: 'view' })
		assert.equal(view.ok, false)
		assert.match(view.error, /面板那一档就是视图/)
	})

	test('team_status：分栏用原生那三档；卡住只看依赖是否完成，可认领用原生那一格', async () => {
		const a = await board({ action: 'register', subject: 'a', description: 'a' })
		const b = await board({ action: 'register', subject: 'b', description: 'b' })
		const c = await board({ action: 'register', subject: 'c', description: 'c' })
		await board({ action: 'claim', id: a.task.id, expected_revision: 1 })
		await board({ action: 'complete', id: a.task.id, expected_revision: 2 })
		await board({ action: 'set_dependencies', id: b.task.id, expected_revision: 1, blocked_by_tasks: [a.task.id] })
		const status = await call(env.host, 'team_status', {}, env.exec)
		assert.equal(status.ok, true, JSON.stringify(status).slice(0, 200))
		assert.equal(status.line, '待办 2 · 进行中 0 · 已完成 1', '分栏用原生那三档的名字：' + status.line)
		// 依赖已全部完成 ⇒ **不是卡住**（旧实现只看"写了依赖没有"，会把它同时排除在可认领之外）
		assert.deepEqual(status.stuck, [], '依赖已完成的待办不算卡住：' + JSON.stringify(status.stuck))
		assert.ok(status.ready.includes(b.task.id), '依赖已完成的待办要进「可认领」（原生 ready 就在那一行数据里）：' + JSON.stringify(status.ready))
		// 依赖真的没完成时，仍要单列出来
		await board({ action: 'set_dependencies', id: c.task.id, expected_revision: 1, blocked_by_tasks: [b.task.id] })
		const again = await call(env.host, 'team_status', {}, env.exec)
		assert.deepEqual(again.stuck, [c.task.id + ' 等 ' + b.task.id], '依赖未完成要单列一行：' + JSON.stringify(again.stuck))
		assert.ok(!again.ready.includes(c.task.id), '等依赖的不进可认领')
	})

	test('服务不在：如实说读不到原生任务板，不假装"没有任务"', async () => {
		env.host.ctx.get = () => undefined
		const listed = await board({ action: 'query' })
		assert.equal(listed.ok, false)
		assert.match(listed.error, /ctx\.agentTeams/)
		const status = await call(env.host, 'team_status', {}, env.exec)
		assert.equal(status.ok, false)
		assert.match(status.error, /ctx\.agentTeams/)
	})
})


// ── 成员面：走 DSH 原生 Agent Teams ──────────────────────────────────────────

describe('成员面（原生）：同角色先复用、名字读得出角色、两条硬上限', () => {
	let env
	beforeEach(() => {
		env = install()
	})

	test('只给 role：新建一位原生队友，名字按 <角色 id>-<序号>，身份段走提示词', async () => {
		const made = await call(env.host, 'member_spawn', { role: 'reviewer', prompt: '首活：复核 X' }, env.exec)
		assert.equal(made.ok, true, JSON.stringify(made).slice(0, 200))
		assert.equal(made.action, 'spawned')
		assert.equal(made.name, 'reviewer-1', '名字按角色+序号自动取')
		const request = env.native.calls.spawn[0]
		assert.equal(request.name, 'reviewer-1')
		// 首活提示词走**块数组**（宿主 schema 的硬要求）；正文本身不变，只是换了外壳。
		assert.deepEqual(request.prompt.map((block) => block.type), ['text'], 'prompt 必须是内容块数组：' + JSON.stringify(request.prompt))
		const promptText = request.prompt.map((block) => block.text).join('\n')
		assert.ok(promptText.includes('team/roles/reviewer/ROLE.md'), '身份段按**路径**引用角色定义：' + promptText.slice(0, 140))
		assert.ok(promptText.includes('team/BASELINE.md'), '也要指向基线')
		assert.ok(promptText.includes('首活：复核 X'), '本职活接在身份段后面')
		// **装备那一行必须在身份段里**（迁移到原生那条路时漏过一次）。reviewer 没声明常驻技能 ⇒
		// 走"空的那一支"：既要如实说没有**常驻**的，又要把会话里那份技能目录指出来（否则会被读成
		// "没技能可用"——现场就是这么走偏的）。
		assert.ok(promptText.includes('没有常驻的专属技能'), '空装备那一支要如实说：' + promptText.slice(0, 300))
		assert.ok(promptText.includes('available_skills'), '要指出会话里那份技能目录：' + promptText.slice(0, 300))
		assert.ok(/先调 \`skill\` 载入它/.test(promptText), '要给"动手前先载入"的动作：' + promptText.slice(0, 300))
		// 描述 = 显示名 + 定位句（现场见过「评审员：」这种冒号后面空着的描述 —— 那是读错了记录里的字段名）
		assert.ok(/^评审员：\S/.test(String(env.native.calls.spawn[0].description)), '描述要带定位句、不许空着：' + String(env.native.calls.spawn[0].description))
		assert.equal(Object.hasOwn(request, 'persona'), false, '原生没有 persona 字段，不许传')
		// 回执里要把"新建的是原生队友"说出来（不是我们自建名册里的行）
		assert.match(made.voice, /原生队友/)
	})

	test('声明了常驻技能的角色：身份段列出装备名，并给出"动手前先载入"的动作', async () => {
		// 角色的 `ROLE.md` 里写着 `skills: ui-ux-pro-max, ui-styling, …` ⇒ 首活提示词要说出这些名字
		// （它们是**常驻**作业程序），并把目录那条路（`<available_skills>`）也指出来。
		const made = await call(env.host, 'member_spawn', { role: 'ux-designer', prompt: '首活：做 X' }, env.exec)
		assert.equal(made.ok, true, JSON.stringify(made).slice(0, 200))
		const prompt = env.native.calls.spawn[0].prompt
		const promptText = Array.isArray(prompt) ? prompt.map((block) => block.text ?? '').join('') : String(prompt)
		assert.ok(promptText.includes('ui-ux-pro-max'), '常驻作业程序要列出来：' + promptText.slice(0, 320))
		assert.ok(/先调 \`skill\` 把它们载入/.test(promptText), '要给动作：' + promptText.slice(0, 320))
		assert.ok(promptText.includes('available_skills'), '也要指出目录里其他技能可按需载入')
	})

	test('同角色再来一次：复用那一位并把活派给它，不再新建', async () => {
		await call(env.host, 'member_spawn', { role: 'reviewer', prompt: '第一件活' }, env.exec)
		const again = await call(env.host, 'member_spawn', { role: 'reviewer', prompt: '第二件活' }, env.exec)
		assert.equal(again.ok, true, JSON.stringify(again).slice(0, 200))
		assert.equal(again.action, 'reused', '这一档已经有能接活的就该复用：' + JSON.stringify(again).slice(0, 200))
		assert.equal(again.name, 'reviewer-1')
		assert.equal(env.native.calls.spawn.length, 1, '复用的时候不许再建人')
		// 复用派活的正文 = **装备那一行 + 这次的首活**（原生成员的提示词是出生时写死的，没有"改成员"的接口，
		// 所以每次派活都把装备再教一遍 —— 这处修复之前建出来的成员靠这一行重新知道自己的装备）。
		const reused = env.native.calls.send[0]
		assert.equal(reused.target, 'reviewer-1')
		assert.deepEqual(reused.signal, env.exec.signal, 'signal 原样透传')
		assert.deepEqual(reused.content.map((block) => block.type), ['text'], '正文走块数组：' + JSON.stringify(reused.content))
		assert.ok(reused.content[0].text.includes('第二件活'), '派过去的正文里有这次的首活：' + reused.content[0].text.slice(0, 200))
		assert.ok(/没有常驻的专属技能|常驻的作业程序/.test(reused.content[0].text), '装备那一行也要带上：' + reused.content[0].text.slice(0, 200))
		assert.match(again.voice, /没有新建/)
	})

	test('两条硬上限：同角色到 3 就拒，写 line_reason 才放行', async () => {
		for (const prompt of ['a', 'b', 'c']) await call(env.host, 'member_spawn', { role: 'qa', prompt, reuse: false }, env.exec)
		const blocked = await call(env.host, 'member_spawn', { role: 'qa', prompt: 'd', reuse: false }, env.exec)
		assert.equal(blocked.ok, false, JSON.stringify(blocked).slice(0, 200))
		assert.match(blocked.error, /已经有 3 位成员（上限 3）/, blocked.error)
		assert.match(blocked.error, /qa-1/, '要把这一档现有的人点出来：' + blocked.error.slice(0, 160))
		const allowed = await call(env.host, 'member_spawn', { role: 'qa', prompt: 'd', reuse: false, line_reason: '这一档要并行两路' }, env.exec)
		assert.equal(allowed.ok, true, JSON.stringify(allowed).slice(0, 200))
	})

	test('member_list 读的是原生名册，角色按名字反读（读不出的不猜）', async () => {
		await call(env.host, 'member_spawn', { role: 'architect', prompt: 'x', reuse: false }, env.exec)
		env.native.members.push({ id: 'odd', name: 'someone-else', role: 'teammate', status: 'idle' })
		const listed = await call(env.host, 'member_list', {}, env.exec)
		assert.equal(listed.ok, true, JSON.stringify(listed).slice(0, 200))
		assert.match(listed.source, /原生/, '要说清读的是哪一处正文：' + listed.source)
		const byName = Object.fromEntries(listed.rows.map((row) => [row.name, row]))
		assert.equal(byName.lead.role, 'lead')
		assert.equal(byName['architect-1'].roleId, 'architect', '名字里读得出角色')
		assert.equal(byName['someone-else'].roleId, '', '读不出角色的不猜')
		assert.match(byName['someone-else'].note, /读不出角色/)
	})

	test('member_send 走原生 sendMessage（失败如实说，不假装送到）', async () => {
		const sent = await call(env.host, 'member_send', { target: 'reviewer-1', message: '接着干' }, env.exec)
		assert.equal(sent.ok, true, JSON.stringify(sent).slice(0, 200))
		assert.deepEqual(env.native.calls.send[0], { target: 'reviewer-1', content: [{ type: 'text', text: '接着干' }], signal: env.exec.signal })
		// 服务不在：如实说走不了原生
		env.host.ctx.get = (name) => (name === 'agentTeams' ? undefined : undefined)
		const none = await call(env.host, 'member_send', { target: 'reviewer-1', message: 'x' }, env.exec)
		assert.equal(none.ok, false)
		assert.match(none.error, /ctx\.agentTeams/)
	})

	test('member_defaults / member_wait 也走原生：编制读原生名册、等待走 waitForChange', async () => {
		await call(env.host, 'member_spawn', { role: 'architect', prompt: 'x', reuse: false }, env.exec)
		const defaults = await call(env.host, 'member_defaults', {}, env.exec)
		assert.equal(defaults.ok, true, JSON.stringify(defaults).slice(0, 200))
		assert.match(defaults.source, /原生/, '编制那一列要读原生名册：' + String(defaults.source))
		const architect = defaults.rows.find((row) => row.role === 'architect')
		assert.deepEqual(architect.teammates.map((row) => row.name), ['architect-1'], '这一档现在有谁要列出来')
		// member_wait：走原生的 waitForChange（假桩回 timeout），不再是"等我们自己的 waiter"
		const waited = await call(env.host, 'member_wait', { timeout_ms: 10000 }, env.exec)
		assert.equal(waited.ok, true, JSON.stringify(waited).slice(0, 200))
		assert.equal(waited.change.reason, 'timeout', '要真的问到原生：' + JSON.stringify(waited.change))
	})

	test('角色不在名册里：当场拒，并把现场枚举出来的角色列出来', async () => {
		const bad = await call(env.host, 'member_spawn', { role: 'not-a-role', prompt: 'x' }, env.exec)
		assert.equal(bad.ok, false)
		assert.match(bad.error, /角色名册里没有/, bad.error)
		assert.match(bad.error, /reviewer/, '要把名册列出来：' + bad.error.slice(0, 200))
	})
})


// ── 热路径 ───────────────────────────────────────────────────────────────────



// ── 装得上吗：启动自诊断的「两个半边都在」这一项 ─────────────────────────────

describe('文件状态注入：钩子随插件装载之后的噪声纪律', () => {
	// 钩子随插件装载 ⇒ 它在**每个会话**里都会跑。所以"什么时候说话"必须是条纪律：
	// · 一份团队文件都没有的工作区：**只在 SessionStart 说一次**"说一句话就能开始"，提示词那次**一个字都不注入**；
	// · 有团队文件：照常注入摘要。
	// 否则在"根本没用团队"的工作区里，每次提示词都喷四行 —— 而那里谁也不会去建看板文件。
	const runHook = (dir, event) => {
		const result = spawnSync('node', ['lib/ledger-digest.js', '--workspace', dir], {
			cwd: process.cwd(),
			input: JSON.stringify({ hook_event_name: event }),
			encoding: 'utf8',
		})
		return { stdout: result.stdout ?? '', status: result.status }
	}
	const fresh = mkdtempSync(join(tmpdir(), 'digest-fresh-'))
	const started = runHook(fresh, 'SessionStart')
	assert.equal(started.status, 0, '任何情况下都退 0（退 2 才会拦下人的提示词）')
	assert.ok(started.stdout.includes('这是新工作区'), '会话开始那一次给那几句开局提示：' + started.stdout.slice(0, 80))
	const prompted = runHook(fresh, 'UserPromptSubmit')
	assert.equal(prompted.stdout, '', '同一个新工作区，提示词那次**什么都不注入**（实际：' + prompted.stdout.slice(0, 120) + '）')
	const used = mkdtempSync(join(tmpdir(), 'digest-used-'))
	writeFileSync(join(used, '.company-gate.board.json'), JSON.stringify({ version: 1, seq: 0, tasks: [] }))
	const withTeam = runHook(used, 'UserPromptSubmit')
	assert.ok(withTeam.stdout.includes('【门禁文件摘要】'), '有团队文件的工作区照常注入摘要')
	// 团队状态已经是宿主原生的（成员与任务在原生 Agent Teams 里）⇒ 那三份文件按设计不再写：
	// 这时**不许喊"读不到"**（把"按设计没有"说成故障），要印一行指路。
	const nativeOnly = mkdtempSync(join(tmpdir(), 'digest-native-'))
	writeFileSync(join(nativeOnly, '.company-gate.human.json'), JSON.stringify({ version: 1, entries: [] }))
	const pointed = runHook(nativeOnly, 'UserPromptSubmit')
	assert.ok(pointed.stdout.includes('团队状态：在 DSH 原生 Agent Teams'), '要指路到原生那一层：' + pointed.stdout.slice(0, 200))
	assert.ok(!pointed.stdout.includes('看板：读不到'), '不许把"按设计不写"说成读不到：' + pointed.stdout.slice(0, 200))
	assert.ok(!pointed.stdout.includes('名册：读不到'), '同上')
})

describe('写侧沙箱策略：边界不比部署默认更宽，且六个转发口都得喂给它', () => {
	// 这处判定原先**零断言**：把三目反过来（部署默认 read-only 时放宽成 workspace-write）139 条一条不红。
	test('矩阵：服务缺席 / read-only / workspace-write / danger-full-access', async () => {
		const { policyForWorkspace } = await import('../lib/gate-write.js')
		// ① 服务缺席 ⇒ undefined（交给后端默认裁定，不假装"我定好了"）
		assert.equal(policyForWorkspace({ get: () => undefined }, '/tmp/ws'), undefined, '没有策略服务就交出去')
		assert.equal(policyForWorkspace({ get: () => ({}) }, '/tmp/ws'), undefined, '服务在但没有 resolve 也交出去')
		// 假桩要**忠实**：真服务按入参定边界（给了 mode 就认它，见 policyForWorkspace 的说明），
		// 固定回显一个模式会让"代码到底传了什么"测不出来。
		const makeService = (defaultMode) => {
			const calls = []
			return {
				calls,
				resolve: (input) => {
					calls.push(input)
					return { mode: input !== null && input !== undefined && input.mode !== undefined ? input.mode : defaultMode }
				},
			}
		}
		// ② 部署默认 read-only ⇒ **保持 read-only**（不替人放宽）
		const readOnly = makeService('read-only')
		const policy = policyForWorkspace({ get: (name) => (name === 'sandboxPolicy' ? readOnly : undefined) }, '/tmp/ws')
		assert.equal(policy.mode, 'read-only', 'read-only 不许被放宽：' + JSON.stringify(policy))
		assert.equal(readOnly.calls.length, 2, '先问默认、再按工作区定')
		assert.deepEqual(readOnly.calls[0], {}, '第一次是不带参数问部署默认')
		assert.equal(readOnly.calls[1].mode, 'read-only', '第二次要把 mode 明说（不说就会去碰会话分支）')
		assert.equal(readOnly.calls[1].session.header.cwd, '/tmp/ws', '边界挪到本次请求的工作区')
		// ③ 部署默认 workspace-write ⇒ 按工作区给 workspace-write
		const wsWrite = makeService('workspace-write')
		assert.equal(policyForWorkspace({ get: () => wsWrite }, '/tmp/ws').mode, 'workspace-write')
		// ④ 部署默认 danger-full-access ⇒ **收窄**成 workspace-write（这次写入不需要更宽）
		const full = makeService('danger-full-access')
		assert.equal(policyForWorkspace({ get: () => full }, '/tmp/ws').mode, 'workspace-write', '不许跟着默认放宽到全盘')
		assert.equal(full.calls[1].mode, 'workspace-write', '要传进 workspace-write，而不是把默认值原样带下去')
		// ⑤ 默认读不到（null）⇒ 也按 workspace-write（不猜成更宽）
		// 默认读不到时要**明说 mode**（给了 mode 才认），所以这个假桩也照入参回显：不带 mode 时回 null。
		const none = { resolve: (input) => (input !== null && input !== undefined && input.mode !== undefined ? { mode: input.mode } : null) }
		assert.equal(policyForWorkspace({ get: () => none }, '/tmp/ws').mode, 'workspace-write')
	})

	test('四个角色转发口都要把策略喂给引擎（少一个就是"这次写入没有边界"）', () => {
		const src = readFileSync('lib/gate-write.js', 'utf8')
		// 成员那两个转发口已经整面撤掉（成员归原生）；留在这一档的只有角色那四条。
		const exports = ['createRoleInWorkspace', 'editRoleInWorkspace', 'removeRoleInWorkspace', 'restoreRoleInWorkspace']
		// 名字拆开拼：这段自检也要能在"全仓零命中"的判据下过。
		for (const dead of ['updateMember' + 'InWorkspace', 'deleteMember' + 'InWorkspace']) {
			assert.ok(!src.includes(dead), '成员写面撤掉之后不该再有转发：' + dead)
		}
		for (const name of exports) {
			const at = src.indexOf('export ' + (src.includes('export async function ' + name) ? 'async function ' + name : 'function ' + name))
			assert.ok(at > 0, name + ' 要在')
			const body = src.slice(at, src.indexOf('\n}', at))
			assert.ok(/policyForWorkspace\(ctx, workspace\)/.test(body), name + ' 必须把策略交给引擎：' + body.slice(0, 120))
		}
	})
})

describe('技能写入口的边界判定：直接测那几处纯判定（原先只有间接覆盖）', () => {
	// 这三条路径（用户级根、项目级根、越界）原先只在端点用例里被**间接**走到：
	// 越界、形状、根不认这几处判定一旦被改松，端点用例可能照样绿。
	test('技能根：只认 user / project；project 没工作区就是 null；路径拼装是唯一正文', async () => {
		const { skillRootOf, skillRootLabel } = await import('../lib/skill-write.js')
		const home = process.env.DSH_HOME
		try {
			process.env.DSH_HOME = '/tmp/dsh-home-probe'
			assert.equal(skillRootOf('user', '/w'), '/tmp/dsh-home-probe/skills')
			assert.equal(skillRootOf('project', '/w'), '/w/.dsh/skills')
			assert.equal(skillRootOf('project', ' '), null, '项目级根没有工作区就是 null，不猜进程目录')
			assert.equal(skillRootOf('package', '/w'), null, '只认 user / project')
			assert.match(skillRootLabel('user'), /用户级/)
			assert.match(skillRootLabel('project'), /项目技能根/)
		} finally {
			if (home === undefined) delete process.env.DSH_HOME
			else process.env.DSH_HOME = home
		}
	})

	test('技能名形状：lower-kebab-case、长度上限；空/大写/下划线/中文都拒', async () => {
		const { skillIdFindings } = await import('../lib/skill-write.js')
		assert.deepEqual(skillIdFindings('my-playbook'), [], '合法形状应当没有 findings')
		assert.deepEqual(skillIdFindings('qa2-play-book'), [])
		assert.ok(skillIdFindings('').length > 0)
		assert.ok(skillIdFindings(' ').length > 0)
		assert.ok(skillIdFindings('My-Playbook').length > 0, '大写不收')
		assert.ok(skillIdFindings('my_playbook').length > 0, '下划线不收')
		assert.ok(skillIdFindings('技能').length > 0, '中文不收')
		assert.ok(skillIdFindings('a'.repeat(61)).length > 0, '超长要拒')
	})

	test('符号链接：写落点以**真实路径**守住信任根（越界拒、指向根内放行）', async () => {
		// 现场实测过的那处越界：把 `<工作区>/.dsh/skills` 做成指向别处的链接，
		// 写技能就会跟着链接落到工作区之外，而回执还写着 workspace=<工作区>。
		const { createSkill } = await import('../lib/skill-write.js')
		const outside = mkdtempSync(join(tmpdir(), 'skill-link-out-'))
		const ws = mkdtempSync(join(tmpdir(), 'skill-link-ws-'))
		mkdirSync(join(ws, '.dsh'), { recursive: true })
		symlinkSync(outside, join(ws, '.dsh', 'skills'))
		const escaped = createSkill({ kind: 'project', workspace: ws, name: 'through-link', description: 'd', body: 'b' })
		assert.equal(escaped.ok, false, '经由链接出界要拒：' + JSON.stringify(escaped).slice(0, 160))
		assert.match(escaped.reason, /写落点越界/, '理由要说清是落点越界：' + escaped.reason)
		assert.equal(readdirSync(outside).length, 0, '被拒之后外面一个字节都不许落')
		// 反向：链接指向工作区**内部**（真实路径仍在根内）⇒ 照旧放行，不许误伤
		const ws2 = mkdtempSync(join(tmpdir(), 'skill-link-ok-'))
		mkdirSync(join(ws2, 'real-skills'), { recursive: true })
		mkdirSync(join(ws2, '.dsh'), { recursive: true })
		symlinkSync(join(ws2, 'real-skills'), join(ws2, '.dsh', 'skills'))
		const inline = createSkill({ kind: 'project', workspace: ws2, name: 'inline-link', description: 'd', body: 'b' })
		assert.equal(inline.ok, true, '指回根内的链接不该被拒：' + JSON.stringify(inline).slice(0, 160))
	})

	test('压缩包：说清"不解压 + 该怎么做"，不落进通用文案', async () => {
		const { importSkill, importSkillFiles, importSourceOf } = await import('../lib/skill-write.js')
		// ① 从本机路径给一个 .zip
		const single = importSkill({ kind: 'user', source: '/tmp/some-skill.zip' })
		assert.equal(single.ok, false, '压缩包要拒')
		assert.match(single.reason, /压缩包/, '要认出它是压缩包：' + single.reason)
		assert.match(single.reason, /先解开|拖/, '要给出下一步动作：' + single.reason)
		// ② 拖进来的那批文件里带着压缩包
		const dropped = importSkillFiles({ kind: 'user', files: [{ path: 'my-skill.zip', dataBase64: Buffer.from('PK').toString('base64') }] })
		assert.equal(dropped.ok, false)
		assert.match(dropped.reason, /压缩包/, '拖进来那条路也要认：' + dropped.reason)
		// ③ 目录 / .md 照旧走原来的判定（别把好路径也拦了）
		assert.equal(importSourceOf('/tmp/not-there-at-all', '/w').ok, false, '不存在的路径照旧拒')
	})

	test('删除：越界与形状不合一律在**碰到文件之前**就拒（不删任何东西）', async () => {
		const { removeSkill, skillRootOf } = await import('../lib/skill-write.js')
		const home = mkdtempSync(join(tmpdir(), 'skill-bound-'))
		const previous = process.env.DSH_HOME
		process.env.DSH_HOME = home
		try {
			const root = skillRootOf('user', '')
			mkdirSync(join(root, 'keep-me'), { recursive: true })
			writeFileSync(join(root, 'keep-me', 'SKILL.md'), '# 留着\n')
			// 形状不合（带分隔符的"名字"）：拒
			const escape = removeSkill({ kind: 'user', name: '../keep-me' })
			assert.equal(escape.ok, false, '越界的名字要拒：' + JSON.stringify(escape))
			assert.ok(existsSync(join(root, 'keep-me')), '被拒之后那一棵必须还在')
			assert.equal(removeSkill({ kind: 'user', name: 'KEEP-ME' }).ok, false, '大写名字拒')
			assert.ok(existsSync(join(root, 'keep-me')), '还在')
			// 合法名字 + 确实存在 ⇒ 删
			const gone = removeSkill({ kind: 'user', name: 'keep-me' })
			assert.equal(gone.ok, true, JSON.stringify(gone))
			assert.equal(existsSync(join(root, 'keep-me')), false, '合法删除要真的删掉')
			// 不存在 ⇒ 如实说"不存在"，不当成成功
			assert.equal(removeSkill({ kind: 'user', name: 'never-there' }).ok, false)
		} finally {
			if (previous === undefined) delete process.env.DSH_HOME
			else process.env.DSH_HOME = previous
		}
	})
})

describe('装载日志印版本：升级之后"到底升没升上去"要能一眼答出来', () => {
	test('启动日志里有 v<包内版本>，且与 package.json 那一格一致', async () => {
		// 为什么值得钉：升级是人手动做的（pnpm install / 同步文件），做完之后必须能一眼确认哪一版在跑；
		// 从前那句装载日志只说角色数与成员提供方，升级前后长得一模一样。
		const { readFileSync } = await import('node:fs')
		const declared = JSON.parse(readFileSync('package.json', 'utf8')).version
		const src = readFileSync('team/team-runtime.js', 'utf8')
		assert.match(src, /本插件自己的版本号/, '要有那处读版本号的正文')
		assert.match(src, /运行时已装载（v\$\{pluginVersionOf\(\)\}/, '装载日志要印出它：' + src.slice(0, 60))
		assert.match(src, /读不到/, '读不到版本时如实说读不到，不编一个')
		assert.equal(typeof declared, 'string')
		assert.ok(/^\d+\.\d+\.\d+$/.test(declared), '版本号形状：' + declared)
	})
})

describe('薄的角色感知层：按角色复用/新建、两条上限、身份走提示词（对着原生接口的形状测）', () => {
	// 原生的 `TeamService` 只有：spawnTeammate / sendMessage / createTask / getTask / listTasks / updateTask
	// 而且成员行上**没有角色字段** —— 所以"哪一档有谁"只能靠取名约定读出来。这一层就是补这件事的。
	const fakeNative = ({ members = [] } = {}) => {
		const calls = { spawn: [], send: [] }
		const rows = members.map((row) => ({ id: row.name, role: 'teammate', status: 'idle', ...row }))
		return {
			calls,
			service: {
				listMembers: () => rows,
				spawnTeammate: async (caller, request) => {
					assertTeamPayloadShape(request.prompt)
					calls.spawn.push(request)
					rows.push({ id: request.name, name: request.name, role: 'teammate', status: 'idle', description: request.description })
					return { id: request.name, name: request.name, role: 'teammate', status: 'idle' }
				},
				sendMessage: async (caller, request) => {
					assertTeamPayloadShape(request.content)
					calls.send.push(request)
					return { messageId: 'm-1', delivered: true }
				},
			},
		}
	}
	const ctxWith = (service) => ({ get: (name) => (name === 'agentTeams' ? service : undefined) })
	const lead = { id: 'sess-1' }
	const roleIds = ['ux-designer', 'fe-dev', 'data-eng']
	// 编制上限那一组要用到更多角色（本组原来的 `roleIds` 只认三个 —— 有一处用例正是要测「读不出来」）。
	const wideRoleIds = [
		'architect', 'be-dev', 'qa', 'reviewer', 'ai-algo', 'analyst', 'security', 'content', 'devops', 'ux-designer', 'fe-dev', 'data-eng',
	]

	test('名字里读得出角色；用过的号不复用；下一个名字按空缺取', async () => {
		const layer = await import('../team/native-layer.js')
		assert.equal(layer.roleOfName('ux-designer-3', roleIds), 'ux-designer')
		assert.equal(layer.roleOfName('data-eng-2', roleIds), 'data-eng', '最长前缀优先：不能被 data 骗到')
		assert.equal(layer.roleOfName('reviewer-1', roleIds), '', '不认的角色返回空串，不猜')
		assert.equal(layer.roleOfName('ux-designer-x', roleIds), '', '号不是数字就不算成员名')
		assert.equal(layer.nextMemberNameFor('ux-designer', ['ux-designer-1', 'ux-designer-3']), 'ux-designer-2', '空出来的号可以补，但已用过的号不复用')
	})

	test('复用优先：这一档有位能接活的就派活给它，不再新建', async () => {
		const layer = await import('../team/native-layer.js')
		const native = fakeNative({ members: [{ name: 'ux-designer-1' }, { name: 'fe-dev-1' }] })
		const reused = await layer.spawnOrReuseTeammate(ctxWith(native.service), lead, {
			role: 'ux-designer',
			roleIds,
			reuse: true,
			reuseName: undefined,
			description: 'x',
			prompt: 'y',
			provider: 'spawn',
		})
		assert.equal(reused.ok, true, JSON.stringify(reused))
		assert.equal(reused.action, 'reused', '有位能用就该复用：' + JSON.stringify(reused))
		assert.equal(reused.name, 'ux-designer-1')
		assert.equal(native.calls.spawn.length, 0, '复用的时候不许再建人')
		// 派活走原生 sendMessage
		const sent = await layer.sendToTeammate(ctxWith(native.service), lead, { target: 'ux-designer-1', content: '接着干 T-2' })
		assert.equal(sent.ok, true)
		assert.deepEqual(native.calls.send[0], { target: 'ux-designer-1', content: [{ type: 'text', text: '接着干 T-2' }] })
	})

	test('新建：身份段走提示词（原生没有 persona 字段），名字按角色+序号', async () => {
		const layer = await import('../team/native-layer.js')
		const native = fakeNative({ members: [{ name: 'ux-designer-1' }, { name: 'ux-designer-2' }] })
		const made = await layer.spawnOrReuseTeammate(ctxWith(native.service), lead, {
			role: 'ux-designer',
			roleIds,
			title: '体验设计',
			duty: '对交互与视觉负责',
			roleFile: 'team/roles/ux-designer/ROLE.md',
			baselineFile: 'team/BASELINE.md',
			description: '体验设计',
			prompt: '首活：做 X',
			provider: 'spawn',
		})
		assert.equal(made.action, 'spawned', JSON.stringify(made))
		assert.equal(made.name, 'ux-designer-3', '序号接着已有名册排')
		const request = native.calls.spawn[0]
		assert.equal(request.name, 'ux-designer-3')
		assert.deepEqual(request.prompt.map((block) => block.type), ['text'], 'prompt 必须是内容块数组：' + JSON.stringify(request.prompt))
		const promptText = request.prompt.map((block) => block.text).join('\n')
		assert.ok(promptText.includes('team/roles/ux-designer/ROLE.md'), '身份段要按**路径**引用角色定义：' + promptText.slice(0, 120))
		assert.ok(promptText.includes('team/BASELINE.md'), '也要指向基线')
		assert.ok(promptText.includes('首活：做 X'), '本职活接在身份段后面')
		assert.equal(Object.hasOwn(request, 'persona'), false, '原生没有 persona 字段，不许传')
	})

	test('同角色上限拦在这里：≤3 位（写理由放行；failed 不占名额）', async () => {
		const layer = await import('../team/native-layer.js')
		const three = fakeNative({ members: [{ name: 'ux-designer-1' }, { name: 'ux-designer-2' }, { name: 'ux-designer-3' }] })
		const blocked = await layer.spawnOrReuseTeammate(ctxWith(three.service), lead, { role: 'ux-designer', roleIds, description: 'x', prompt: 'y', provider: 'spawn' })
		assert.equal(blocked.ok, false, JSON.stringify(blocked))
		assert.equal(blocked.action, 'over-cap')
		assert.match(blocked.reason, /已经有 3 位成员（上限 3）/, blocked.reason)
		assert.match(blocked.reason, /ux-designer-1/, '要点出这一档现有的人：' + blocked.reason.slice(0, 160))
		// 写理由放行
		const allowed = await layer.spawnOrReuseTeammate(ctxWith(three.service), lead, { role: 'ux-designer', roleIds, description: 'x', prompt: 'y', provider: 'spawn', lineReason: '这一档要并行两路：移动端与桌面端' })
		assert.equal(allowed.action, 'spawned', JSON.stringify(allowed))
		// failed 的不算名额
		const withFailed = fakeNative({ members: [{ name: 'ux-designer-1' }, { name: 'ux-designer-2', status: 'failed' }, { name: 'ux-designer-3' }] })
		const ok = await layer.spawnOrReuseTeammate(ctxWith(withFailed.service), lead, { role: 'ux-designer', roleIds, description: 'x', prompt: 'y', provider: 'spawn' })
		assert.equal(ok.action, 'spawned', 'failed 的不占名额：' + JSON.stringify(ok))
	})

	test('编制上限（HD-005）：在场 8 个角色、共 16 位 ⇒ **第 9 个角色的第 1 位必须放行**（旧规则的堵点）', async () => {
		// 人的原话：「在总人数不超过 24 的前提下，需要能创建其他角色的成员（角色种类不再单独设限）。」
		// HD-004 那条"角色种类 ≤8"会在"种类满 8、总数远不到 24"时卡住新角色（16 位时第 9 个角色建不出来）——
		// 这一条就是 HD-005 的分水岭。
		const layer = await import('../team/native-layer.js')
		const { MEMBER_PRESENT_MAX, MEMBER_ROLE_MAX } = await import('../lib/team-limits.js')
		assert.equal(MEMBER_ROLE_MAX, 3, '同角色上限保留')
		assert.equal(MEMBER_PRESENT_MAX, 24, '在场总人数上限 24（显式上限）')
		const eightRoles = ['architect', 'be-dev', 'qa', 'reviewer', 'ai-algo', 'analyst', 'security', 'content']
		// 8 个角色 × 2 位 = 16 位
		const memberRows = eightRoles.flatMap((role) => [{ name: `${role}-1` }, { name: `${role}-2` }])
		const native = fakeNative({ members: memberRows })
		const ninthKindFirst = await layer.spawnOrReuseTeammate(ctxWith(native.service), lead, {
			role: 'devops',
			roleIds: wideRoleIds,
			reuse: false,
			description: 'x',
			prompt: 'y',
			provider: 'spawn',
		})
		assert.equal(ninthKindFirst.ok, true, '第 9 个角色不许再被种类数拦住：' + JSON.stringify(ninthKindFirst))
		assert.equal(ninthKindFirst.action, 'spawned', '总数 16「远不到 24」就该放行：' + JSON.stringify(ninthKindFirst))
		assert.equal(native.calls.spawn.length, 1, '真建了一位')
	})

	test('在场 8 位只占 4 个角色 ⇒ 第 9 位照旧能建出来（同角色第 3 位）', async () => {
		const layer = await import('../team/native-layer.js')
		const memberRows = [
			{ name: 'architect-1' },
			{ name: 'architect-2' },
			{ name: 'be-dev-1' },
			{ name: 'be-dev-2' },
			{ name: 'qa-1' },
			{ name: 'qa-2' },
			{ name: 'reviewer-1' },
			{ name: 'reviewer-2' },
		]
		const native = fakeNative({ members: memberRows })
		const ninth = await layer.spawnOrReuseTeammate(ctxWith(native.service), lead, {
			role: 'architect',
			roleIds: wideRoleIds,
			reuse: false,
			description: 'x',
			prompt: 'y',
			provider: 'spawn',
		})
		assert.equal(ninth.ok, true, '第 9 位不许再被总人数拦住：' + JSON.stringify(ninth))
		assert.equal(ninth.action, 'spawned', '同角色第 3 位（上限 3）该建得出来：' + JSON.stringify(ninth))
	})

	test('在场总数到 24 ⇒ 第 25 位拒（措辞说清"总人数上限 24"）；同角色第 4 位照旧拒；line_reason 均可越过', async () => {
		const layer = await import('../team/native-layer.js')
		// 24 位：8 个角色 × 3 位（正好是两条规则的乘积）
		const eightRoles = ['architect', 'be-dev', 'qa', 'reviewer', 'ai-algo', 'analyst', 'security', 'content']
		const rows24 = eightRoles.flatMap((role) => [{ name: `${role}-1`, role: 'teammate', status: 'idle' }, { name: `${role}-2`, role: 'teammate', status: 'idle' }, { name: `${role}-3`, role: 'teammate', status: 'idle' }])
		const overTotal = layer.memberCapFindings({ role: 'devops', members: rows24, roleIds: wideRoleIds })
		assert.match(String(overTotal), /在场总人数上限 24/, '拒建措辞要说清是总数上限：' + String(overTotal).slice(0, 160))
		// 同角色第 4 位（总数只有 3 位时）照旧拒
		const threeSame = [{ name: 'qa-1', role: 'teammate', status: 'idle' }, { name: 'qa-2', role: 'teammate', status: 'idle' }, { name: 'qa-3', role: 'teammate', status: 'idle' }]
		const overRole = layer.memberCapFindings({ role: 'qa', members: threeSame, roleIds: wideRoleIds })
		assert.match(String(overRole), /已经有 3 位成员（上限 3）/, '同角色那条照旧：' + String(overRole).slice(0, 120))
		assert.equal(layer.memberCapFindings({ role: 'qa', members: threeSame, roleIds: wideRoleIds, lineReason: '这一档要并行两路' }), null, '写了 line_reason 就放行')
		assert.equal(layer.memberCapFindings({ role: 'devops', members: rows24, roleIds: wideRoleIds, lineReason: '这一单确实需要运维本职' }), null, '总数那条也可用 line_reason 越过')
		// **总数那条含 `failed`**（复核凿出来的真错 —— 宿主那道硬拒按 `state.members.length` 算，不按 phase 过滤）：
		// 23 位在用 + 1 位 failed（宿主眼里 24 行）⇒ 必须由**我们**先拒，不能放行到宿主那里抛 `TEAM_MEMBER_LIMIT`。
		const withFailed = rows24.map((row, index) => (index === 0 ? { ...row, status: 'failed' } : row))
		assert.equal(withFailed.length, 24, '夹具就是 24 行（1 位 failed）')
		const overWithFailed = layer.memberCapFindings({ role: 'devops', members: withFailed, roleIds: wideRoleIds })
		assert.match(String(overWithFailed), /在场总人数上限 24/, '含 failed 也要数：' + String(overWithFailed).slice(0, 140))
		assert.match(String(overWithFailed), /含已失败的成员/, '措辞要说清含 failed：' + String(overWithFailed).slice(0, 140))
		assert.match(String(overWithFailed), /其中 1 位是 failed/, '要点出其中有几位 failed：' + String(overWithFailed).slice(0, 160))
		// **同角色那条不动**（`failed` 不算"还能干活的人"）：两位在岗 + 一位 failed ⇒ 这一档还能再加一位
		const qaMixed = [
			{ name: 'qa-1', role: 'teammate', status: 'idle' },
			{ name: 'qa-2', role: 'teammate', status: 'idle' },
			{ name: 'qa-3', role: 'teammate', status: 'failed' },
		]
		assert.equal(layer.memberCapFindings({ role: 'qa', members: qaMixed, roleIds: wideRoleIds }), null, '同角色那条照旧排除 failed（那是"这一档还能不能干活"的口径）')
	})

	test('名字反读不出角色的行：不再受"种类"限制（那条已删），但照旧计入总人数', async () => {
		const layer = await import('../team/native-layer.js')
		// 8 个读不出角色的名字（从前 = 8 类种类 ⇒ 新角色拒）⇒ 现在放行
		const eightOdd = Array.from({ length: 8 }, (unused, index) => ({ name: `乱名-${index + 1}` }))
		const native = fakeNative({ members: eightOdd })
		const allowed = await layer.spawnOrReuseTeammate(ctxWith(native.service), lead, {
			role: 'architect',
			roleIds: wideRoleIds,
			reuse: false,
			description: 'x',
			prompt: 'y',
			provider: 'spawn',
		})
		assert.equal(allowed.action, 'spawned', '种类那条删掉之后，读不出角色的名字不再拦新角色：' + JSON.stringify(allowed))
		// 但它们照旧算人数：24 个这种名字 ⇒ 第 25 位拒
		const odd24 = Array.from({ length: 24 }, (unused, index) => ({ name: `乱名-${index + 1}`, role: 'teammate', status: 'idle' }))
		assert.match(String(layer.memberCapFindings({ role: 'architect', members: odd24, roleIds: wideRoleIds })), /在场总人数上限 24/, '读不出角色的名字也占人数')
	})

	test('停用不占名额（HD-006）：这一档第 3 位被停用之后 ⇒ 第 4 位能建出来', async () => {
		const layer = await import('../team/native-layer.js')
		const three = [
			{ name: 'qa-1', role: 'teammate', status: 'idle' },
			{ name: 'qa-2', role: 'teammate', status: 'idle' },
			{ name: 'qa-3', role: 'teammate', status: 'idle' },
		]
		// 三位都在 ⇒ 第 4 位拒（同角色上限）
		const full = layer.memberCapFindings({ role: 'qa', members: three, roleIds: wideRoleIds })
		assert.match(String(full), /已经有 3 位成员（上限 3）/, String(full).slice(0, 120))
		// **停用一位之后** ⇒ 名额空出来，第 4 位能建（这正是"停旧的、建新的换干净上下文"那条路）
		const afterDisable = layer.memberCapFindings({ role: 'qa', members: three, roleIds: wideRoleIds, disabledNames: ['qa-1'] })
		assert.equal(afterDisable, null, '停用者不占名额：' + String(afterDisable))
		const native = fakeNative({ members: three })
		const fourth = await layer.spawnOrReuseTeammate(ctxWith(native.service), lead, {
			role: 'qa',
			roleIds: wideRoleIds,
			reuse: false,
			disabledNames: ['qa-1'],
			description: 'x',
			prompt: 'y',
			provider: 'spawn',
		})
		assert.equal(fourth.action, 'spawned', '第 4 位该建得出来：' + JSON.stringify(fourth))
		assert.equal(fourth.name, 'qa-4', '名字按空缺取')
	})

	test('至少留 1 位：停用某档最后一位未停用者 ⇒ 拒（只有 1 位时同理）', async () => {
		const { disableFindings } = await import('../lib/member-flags.js')
		const roleOfName = (value) => (/^qa-\d+$/.test(String(value)) ? 'qa' : /^revi-\d+$/.test(String(value)) ? 'reviewer' : '')
		const rows = [{ name: 'qa-1', role: 'teammate', status: 'idle' }, { name: 'qa-2', role: 'teammate', status: 'idle' }, { name: 'revi-1', role: 'teammate', status: 'idle' }]
		// 这一档有两位未停用 ⇒ 停一位可以
		assert.equal(disableFindings({ name: 'qa-1', members: rows, disabledNames: [], roleOfName }), null)
		// 已经停了一位 ⇒ 再停最后一位就拒（措辞要说清"至少留 1 位"）
		const last = disableFindings({ name: 'qa-2', members: rows, disabledNames: ['qa-1'], roleOfName })
		assert.match(String(last), /至少留 1 位/, String(last))
		assert.match(String(last), /qa-2/, '要点名是哪一位：' + String(last).slice(0, 120))
		// 某档只有 1 位 ⇒ 停它同样拒
		assert.match(String(disableFindings({ name: 'revi-1', members: rows, disabledNames: [], roleOfName })), /至少留 1 位/)
		// failed 的不算"还能干活的人"：只剩一位 failed 时，停那位在岗的也要拒
		const withFailed = [{ name: 'qa-1', role: 'teammate', status: 'idle' }, { name: 'qa-2', role: 'teammate', status: 'failed' }]
		assert.match(String(disableFindings({ name: 'qa-1', members: withFailed, disabledNames: [], roleOfName })), /至少留 1 位/, 'failed 的不算能干活的人')
	})

	test('复用跳过停用者：第 1 位停用之后 member_spawn 建第 2 位，而不是唤醒停用的那位', async () => {
		const layer = await import('../team/native-layer.js')
		const native = fakeNative({ members: [{ name: 'qa-1' }] })
		// 没停用 ⇒ 复用那一位
		const reused = await layer.spawnOrReuseTeammate(ctxWith(native.service), lead, { role: 'qa', roleIds: wideRoleIds, reuse: true, description: 'x', prompt: 'y', provider: 'spawn' })
		assert.equal(reused.action, 'reused', JSON.stringify(reused))
		// 停用 qa-1 ⇒ 复用跳过它，新建 qa-2
		const fresh = await layer.spawnOrReuseTeammate(ctxWith(native.service), lead, { role: 'qa', roleIds: wideRoleIds, reuse: true, disabledNames: ['qa-1'], description: 'x', prompt: 'y', provider: 'spawn' })
		assert.equal(fresh.action, 'spawned', '停用者不许被复用：' + JSON.stringify(fresh))
		assert.equal(fresh.name, 'qa-2', '新建的是下一位')
	})

	test('member_send 给停用者 ⇒ 拒（现场跑工具）；写进名单之后 `member_list` 也标出来', async () => {
		const env = install()
		try {
			await call(env.host, 'member_spawn', { role: 'qa', prompt: 'a', reuse: false }, env.exec)
			env.native.members.push({ id: 'qa-2', name: 'qa-2', role: 'teammate', status: 'idle' })
			// 直接把 qa-1 写进停用名单（走的是与面板同一个文件；写侧的完整路径在面板那组用例里钉）
			writeFileSync(
				join(env.workspace, '.company-gate.member-flags.json'),
				JSON.stringify({ version: 1, seq: 1, note: '本插件的视图状态', disabled: ['qa-1'], updated_at: '2026-10-13T00:00:00.000Z' }),
			)
			// ① 派活 ⇒ 拒，并指路"先恢复再派活"
			const refused = await call(env.host, 'member_send', { target: 'qa-1', message: '接着干' }, env.exec)
			assert.equal(refused.ok, false, JSON.stringify(refused))
			assert.match(refused.error, /停用/, refused.error)
			assert.match(refused.error, /恢复/, '要说清怎么恢复：' + refused.error)
			// ② 名单里另一位照常派得出去
			const fine = await call(env.host, 'member_send', { target: 'qa-2', message: '接着干' }, env.exec)
			assert.equal(fine.ok, true, JSON.stringify(fine))
			// ③ `member_list` 要标出"停用"（协调者据此知道为什么派不出去）
			const listed = await call(env.host, 'member_list', {}, env.exec)
			const row = listed.rows.find((item) => item.name === 'qa-1')
			assert.equal(row?.disabled, true, '名册行要标停用：' + JSON.stringify(row))
			// 口径（task-57）：**本插件不再派活给它** + **它在宿主原生界面里仍然可以打开对话**（只在本插件生效）
			assert.match(String(row?.disabledNote), /本插件不再派活给它/, String(row?.disabledNote))
			assert.match(String(row?.disabledNote), /宿主原生界面里仍然可以打开对话/, String(row?.disabledNote))
			// ④ 恢复（把名单写空）⇒ 派活照旧
			writeFileSync(join(env.workspace, '.company-gate.member-flags.json'), JSON.stringify({ version: 1, seq: 2, note: 'x', disabled: [], updated_at: 'x' }))
			const back = await call(env.host, 'member_send', { target: 'qa-1', message: '接着干' }, env.exec)
			assert.equal(back.ok, true, '恢复之后照旧能派活：' + JSON.stringify(back))
		} finally {
			env.restore?.()
		}
	})

	test('打断不改名册、不动名额（假原生层验：只转发 interrupt，其它一律没碰）', async () => {
		const calls = { interrupt: [] }
		const rows = [{ id: 'qa-1', name: 'qa-1', role: 'teammate', status: 'idle' }]
		const service = {
			listMembers: () => rows,
			spawnTeammate: async () => {
				throw new Error('打断不该建人')
			},
			interrupt: (caller, name) => {
				calls.interrupt.push({ caller, name })
				return { previousStatus: 'running' }
			},
		}
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-interrupt-'))
		const leadAgent = { id: 'sess-1' }
		const ctx = {
			fs: makeFs(),
			get: (name) =>
				name === 'agentTeams'
					? service
					: name === 'agents'
						? { get: (id) => (id === 'sess-1' ? leadAgent : undefined), list: () => [leadAgent] }
						: name === 'workspaceRegistry'
							? { list: () => [{ id: 'w1', path: workspace }] }
							: undefined,
			logger: { warn() {} },
		}
		const { handleMemberWrite, MEMBER_INTERRUPT_PATH } = await import('../lib/board-view.host.js')
		const { res, captured } = makeRes()
		const payload = Buffer.from(JSON.stringify({ name: 'qa-1' }), 'utf8')
		const req = {
			method: 'POST',
			url: `${MEMBER_INTERRUPT_PATH}?workspace=${encodeURIComponent(workspace)}&session=sess-1`,
			on(event, handler) {
				if (event === 'data') handler(payload)
				if (event === 'end') handler()
			},
		}
		await handleMemberWrite(ctx, req, res, null, 'interrupt')
		const body = JSON.parse(captured.body)
		assert.equal(body.ok, true, captured.body)
		assert.equal(body.previousStatus, 'running', '要如实回报打断前的状态')
		assert.match(body.note, /收件箱/, '要说清收件箱保留：' + body.note)
		// task-61：三词口径 —— 打断的回执要写「原生名册行」与**两条上限**（不再用泛指的"名额"）
		assert.match(body.note, /\*\*原生名册行\*\*与两条上限（角色槽位 ≤3、在场总人数 ≤24，含停用者与 `failed`）都不变/, '要说清名册与两条上限不变：' + body.note)
		assert.equal(calls.interrupt.length, 1, '只转发了一次 interrupt')
		assert.equal(rows.length, 1, '名册一个字节都没变')
		assert.ok(!existsSync(join(workspace, '.company-gate.member-flags.json')), '打断不写停用名单')
	})

	test('删技能同步剪角色（HD-007）：用户根直接剪；包内只列名单、一个字节都不改', async () => {
		const { pruneSkillFromRoles } = await import('../team/team-runtime.js')
		const { userRolesRoot } = await import('../lib/roster.js')
		const userRoot = userRolesRoot()
		assert.ok(userRoot !== null && userRoot.includes(tmpdir()), '隔离纪律：用户角色根必须是临时目录（实际 ' + String(userRoot) + '）')
		// 造一个**用户根**角色（声明了两个技能）+ 一个**包内**角色也声明它（借包内真角色不方便 ⇒ 用一个自造的包根目录）
		const roleFile = (root, id, skills) => {
			const dir = join(root, id)
			mkdirSync(dir, { recursive: true })
			writeFileSync(
				join(dir, 'ROLE.md'),
				`---\nkind: role\nname: ${id}\ncategory: 质量\ndescription: Use when 探针。\nskills: ${skills}\n---\n\n# ${id}（${id}）\n\n探针。\n`,
			)
			return join(dir, 'ROLE.md')
		}
		const userFile = roleFile(userRoot, 'probe-skill-role', 'qa-playbooks, gone-skill')
		const packageRoot = mkdtempSync(join(tmpdir(), 'probe-package-roles-'))
		const packageFile = roleFile(packageRoot, 'probe-package-role', 'qa-playbooks')
		// 直接对**两个根**调（包根用参数传进去：`roleRecords(roots)` 就是这么设计的）
		const outcome = await pruneSkillFromRoles(null, {}, 'qa-playbooks')
		// 上面那次扫的是**真实两个根**：用户根那一个会被剪；`probe-package-role` 不在真实包根里 ⇒ 不会出现在名单里
		assert.ok(outcome.changed.some((item) => item.role === 'probe-skill-role'), '用户根角色要被剪：' + JSON.stringify(outcome.changed))
		const after = readFileSync(userFile, 'utf8')
		assert.match(after, /^skills: gone-skill$/m, '只剩没被删的那个：' + after.slice(0, 200))
		assert.ok(!after.includes('qa-playbooks'), '被删的技能名要剪掉')
		// **包内角色**（另一个根）不在这一轮扫描面里 —— 这个函数只扫 `roleRootRecords()` 那两个根，
		// 所以"包内只列名单"这条要用**包根真的在场**来验：把包根接进 `roleRecords` 的写法在下面那条用例里。
		assert.equal(readFileSync(packageFile, 'utf8').includes('qa-playbooks'), true, '包根那个文件一个字都没动')
		// 幂等：再剪一次 ⇒ 没有任何角色还声明它（用户根那位已经剪过）
		const again = await pruneSkillFromRoles(null, {}, 'qa-playbooks')
		assert.equal(again.changed.filter((item) => item.role === 'probe-skill-role').length, 0, '剪过的不再动')
	})

	test('删技能的回执**按真实来源说根**：工作区根里的角色不许被说成"用户根"（task-36 现场那条）', async () => {
		const { userRolesRoot } = await import('../lib/roster.js')
		const userRoot = userRolesRoot()
		assert.ok(String(userRoot).includes(tmpdir()), '隔离纪律：用户角色根必须在临时目录里')
		const env = install()
		try {
			// 一个**工作区根**角色 + 一个**用户根**角色，都声明同一个技能；技能本身真建在 project 根下
			const mk = (root, id) => {
				mkdirSync(join(root, id), { recursive: true })
				writeFileSync(join(root, id, 'ROLE.md'), `---\nkind: role\nname: ${id}\ncategory: 质量\ndescription: Use when 探针。\nskills: probe-skill\n---\n\n# ${id}\n\n探针。\n`)
				return join(root, id, 'ROLE.md')
			}
			const wsFile = mk(join(env.workspace, '.dsh', 'team-ops', 'roles'), 'probe-ws-role')
			const userFile = mk(userRoot, 'probe-user-role')
			mkdirSync(join(env.workspace, '.dsh', 'skills', 'probe-skill'), { recursive: true })
			writeFileSync(join(env.workspace, '.dsh', 'skills', 'probe-skill', 'SKILL.md'), '---\nname: probe-skill\ndescription: d\n---\n\n# probe-skill\n')
			// **走真 handler**（面板那条删除路径）：回执里的 note 就是给人看的那句
			const { handleSkillWrite } = await import('../lib/board-view.host.js')
			const captured = {}
			const res = { writeHead: (status) => { captured.status = status }, end: (body) => { captured.body = body } }
			const payloadBody = Buffer.from(JSON.stringify({ root: 'project', name: 'probe-skill' }), 'utf8')
			const req = {
				method: 'POST',
				url: `/company-board/api/skills/remove?workspace=${encodeURIComponent(env.workspace)}`,
				on(event, handler) {
					if (event === 'data') handler(payloadBody)
					if (event === 'end') handler()
				},
			}
			await handleSkillWrite({ fs: makeFs(), logger: { warn() {} }, get: () => undefined }, req, res, null, 'remove')
			const payload = JSON.parse(captured.body)
			assert.equal(payload.ok, true, JSON.stringify(payload).slice(0, 200))
			const prune = payload.skillPrune
			assert.ok(Array.isArray(prune.changed) && prune.changed.length === 2, '两个根各剪一位：' + JSON.stringify(prune.changed))
			// ① 引擎那一层带**真实来源**
			assert.equal(prune.changed.find((item) => item.role === 'probe-ws-role')?.source, 'workspace')
			assert.equal(prune.changed.find((item) => item.role === 'probe-user-role')?.source, 'user')
			// ② **回执那句按来源分说**：两位的标签各按自己的根来（混合 ⇒ 统称"非包内"+逐条带根）
			assert.match(String(prune.note), /非包内/, '两个根混着时统称"非包内"：' + prune.note)
			assert.match(String(prune.note), /probe-ws-role（本工作区根）/, '工作区根那位要标"本工作区根"：' + prune.note)
			assert.match(String(prune.note), /probe-user-role（用户根）/, '用户根那位要标"用户根"：' + prune.note)
			// ③ **只有工作区根那份时，Note 里不许出现"用户根"**（现场那条错就是这么来的）
			mkdirSync(join(env.workspace, '.dsh', 'skills', 'probe-skill'), { recursive: true })
			writeFileSync(join(env.workspace, '.dsh', 'skills', 'probe-skill', 'SKILL.md'), '---\nname: probe-skill\ndescription: d\n---\n\n# x\n')
			// 让用户根那位不再声明它（只留工作区那位）
			writeFileSync(userFile, '---\nkind: role\nname: probe-user-role\ndescription: Use when 探针。\n---\n\n# 探针\n')
			writeFileSync(wsFile, '---\nkind: role\nname: probe-ws-role\ncategory: 质量\ndescription: Use when 探针。\nskills: probe-skill\n---\n\n# 探针\n')
			const captured2 = {}
			const res2 = { writeHead: (status) => { captured2.status = status }, end: (body) => { captured2.body = body } }
			const body2 = Buffer.from(JSON.stringify({ root: 'project', name: 'probe-skill' }), 'utf8')
			await handleSkillWrite(
				{ fs: makeFs(), logger: { warn() {} }, get: () => undefined },
				{ method: 'POST', url: `/company-board/api/skills/remove?workspace=${encodeURIComponent(env.workspace)}`, on(e, h) { if (e === 'data') h(body2); if (e === 'end') h() } },
				res2,
				null,
				'remove',
			)
			const prune2 = JSON.parse(captured2.body).skillPrune
			assert.match(String(prune2.note), /已从这些\*\*本工作区根\*\*角色里剪掉/, '只剩工作区根那位 ⇒ 标签就是"本工作区根"：' + prune2.note)
			assert.ok(!String(prune2.note).includes('用户根'), '**不许**把工作区根的角色说成用户根：' + prune2.note)
		} finally {
			env.restore?.()
		}
	})

	test('删一个没有任何角色声明的技能 ⇒ 无副作用（回执如实说"没有角色声明它"）', async () => {
		const { pruneSkillFromRoles } = await import('../team/team-runtime.js')
		const outcome = await pruneSkillFromRoles(null, {}, 'no-such-skill-anywhere')
		assert.deepEqual(outcome.changed, [], '一个文件都不该动')
		assert.deepEqual(outcome.packageRoles, [])
		assert.ok(outcome.scanned > 0, '要真的扫过名册（scanned = ' + outcome.scanned + '）')
	})

	test('包内角色仍声明它 ⇒ 只列名单（发布面一个字节都不动）；用户根那位同一次里被剪', async () => {
		const { pruneSkillFromRoles } = await import('../team/team-runtime.js')
		const { userRolesRoot } = await import('../lib/roster.js')
		// **用真包内角色**：`design` 被包内 `ux-designer` 声明（发布面只读）—— 拿它当"包内仍声明"的那一档。
		const packageFile = 'team/roles/ux-designer/ROLE.md'
		const before = readFileSync(packageFile, 'utf8')
		assert.match(before, /^skills: .*\bdesign\b.*$/m, '夹具前提：包内 ux-designer 声明了 design')
		// 同一次里再造一个**用户根**角色也声明它 ⇒ 两种分支在同一次调用里各自走到
		const userRoot = userRolesRoot()
		const dir = join(userRoot, 'probe-mixed-role')
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'ROLE.md'), '---\nkind: role\nname: probe-mixed-role\ncategory: 设计\ndescription: Use when 探针。\nskills: design, slides\n---\n\n# 探针\n\n探针。\n')
		const outcome = await pruneSkillFromRoles(null, {}, 'design')
		// ① 用户根那位：剪掉 design，留下 slides
		assert.ok(outcome.changed.some((item) => item.role === 'probe-mixed-role'), '用户根角色要被剪：' + JSON.stringify(outcome.changed.map((i) => i.role)))
		assert.match(readFileSync(join(dir, 'ROLE.md'), 'utf8'), /^skills: slides$/m, '只剪被删的那个')
		// ② 包内那位：进名单、且**文件逐字不变**
		assert.ok(outcome.packageRoles.some((item) => item.role === 'ux-designer'), '包内角色要点名列出：' + JSON.stringify(outcome.packageRoles))
		assert.equal(readFileSync(packageFile, 'utf8'), before, '包内文件必须逐字不变')
		// ③ 源码级那条边界（与行为断言互为补强）：只有 `source === 'user'` 那一支会写盘
		const source = readFileSync('team/team-runtime.js', 'utf8')
		const body = source.slice(source.indexOf('export async function pruneSkillFromRoles'))
		const fn = body.slice(0, body.indexOf('\n}\n'))
		assert.match(fn, /record\.source !== 'user'/, '包内那一支要先拦下')
		assert.ok(!/writeRoleDefinition[\s\S]{0,80}package/.test(fn), '包内那一支不许有任何写盘')
	})

	test('服务不在：如实说"走不了原生"，不假装能派活', async () => {
		const layer = await import('../team/native-layer.js')
		const none = await layer.spawnOrReuseTeammate(ctxWith(undefined), lead, { role: 'ux-designer', roleIds, description: 'x', prompt: 'y', provider: 'spawn' })
		assert.equal(none.ok, false)
		assert.equal(none.action, 'unavailable')
		assert.match(none.reason, /ctx\.agentTeams/)
	})
})

describe('账本文件是符号链接时的写落点（现场实测过，用一个用例钉住）', () => {
	test('写的是"临时文件 + rename"⇒ 替换的是链接本身，工作区之外一个字节都不落', async () => {
		// 为什么值得钉：账本写入走的是 rename，而 POSIX 的 rename **替换链接本身、不跟随**。
		// 成员名册那条路已经随功能删掉了（成员现在是原生队友），但**这个写入器还在用**
		// （人的话那一份走同一个 transact）—— 所以把这条不变量挂到它身上继续钉：
		// 把 `<工作区>/.company-gate.human.json` 做成指向别处的链接，结果是"链接被换成普通文件"，
		// 而不是"写到外面去了"。有人为了"原子写"改成先 writeText 到目标路径，这条就会红。
		const env = install()
		const outside = mkdtempSync(join(tmpdir(), 'ledger-link-out-'))
		const outsideFile = join(outside, 'kicked.json')
		const before = JSON.stringify({ version: 1, words: [{ id: 'HD-001', kind: 'goal', text: '外面那份' }] })
		writeFileSync(outsideFile, before)
		symlinkSync(outsideFile, join(env.workspace, '.company-gate.human.json'))
		const recorded = await call(env.host, 'human_words_record', { text: '人的一句判断', kind: 'goal' }, env.exec)
		assert.equal(recorded.ok, true, JSON.stringify(recorded).slice(0, 200))
		assert.equal(readFileSync(outsideFile, 'utf8'), before, '工作区之外那个文件**不许**被改')
		const inside = JSON.parse(readFileSync(join(env.workspace, '.company-gate.human.json'), 'utf8'))
		assert.equal(inside.words.length, 2, '工作区内那一份要真的写入（外面那条 + 新记的那条）')
	})
})

describe('看板五档状态只有一个正文', () => {
	test('顺序一致（待验收在已完成之前）；宿主侧三处不再各自抄一份；面板那份抄写与共用模块逐字相同', async () => {
		const shared = await import('../lib/board-status.js')
		// 顺序按**流程**排：待办 → 进行中 → 待验收 → 已完成 → 已打回。
		// 现场症状：同一个会话里，工具回执的状态行是「已完成」在前、每轮注入的状态行是「待验收」在前，
		// 人读到的是两份对不上的读数。
		assert.deepEqual(shared.BOARD_STATUSES, ['待办', '进行中', '待验收', '已完成', '已打回'], '顺序按流程：待验收是"还没收口"那一档')
		assert.deepEqual(shared.STATUS_LINE_ORDER.map((row) => row.label), shared.BOARD_STATUSES, '状态行的名字与顺序跟分栏同源')
		// 宿主侧三处：不许再各写一份（要 import 共用模块）
		for (const file of ['team/company-gate.js', 'lib/board-view.host.js', 'lib/ledger-digest.js']) {
			const src = readFileSync(file, 'utf8')
			assert.ok(!/const BOARD_STATUSES = \['待办'/.test(src), file + ' 不许再抄一份状态枚举')
			assert.ok(src.includes('board-status.js'), file + ' 要引用共用模块')
		}
		// 客户端是单文件懒加载模块、没有相对导入面 ⇒ 它那份是**抄写**，由这条钉住逐字一致
		const client = readFileSync('lib/board-view.client.js', 'utf8')
		const matched = client.match(/statusOrder:\s*\[([^\]]*)\]/)
		assert.ok(matched !== null, '面板的分栏顺序要能取出来')
		const clientOrder = matched[1]
			.split(',')
			.map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
			.filter((item) => item !== '')
		assert.deepEqual(clientOrder, shared.BOARD_STATUSES, '面板分栏顺序必须与共用模块一致：' + JSON.stringify(clientOrder))
	})
})

describe('注入摘要：看板 / 名册 / 邮箱那三行彻底拿掉（人的口径 HD-003）', () => {
	const runHook = (dir, event) => {
		const result = spawnSync('node', ['lib/ledger-digest.js', '--workspace', dir], {
			cwd: process.cwd(),
			input: JSON.stringify({ hook_event_name: event }),
			encoding: 'utf8',
		})
		return result.stdout ?? ''
	}
	test('三份旧账都在（还带破线与未读）⇒ 一行都不许出现；实时那一行仍在', () => {
		const dir = mkdtempSync(join(tmpdir(), 'digest-legacy-'))
		writeFileSync(
			join(dir, '.company-gate.members.json'),
			JSON.stringify({
				version: 1,
				seq: 5,
				members: [
					{ id: 'MB-001', name: 'a-1', role: 'architect', status: '在场', runtime: 'inactive', line_reason: '这一轮需要第 5 个' },
					...Array.from({ length: 4 }, (unused, index) => ({ id: 'MB-10' + index, name: 'revi-' + (index + 1), role: 'reviewer', status: '在场', runtime: 'inactive' })),
				],
			}),
		)
		writeFileSync(
			join(dir, '.company-gate.mailbox.json'),
			JSON.stringify({ version: 1, seq: 0, messages: [{ id: 'MSG-001', from: 'lead', to: 'r-9', at: '2026-10-09T00:00:00.000Z', text: '这是一条没被读过的活' }] }),
		)
		writeFileSync(join(dir, '.company-gate.board.json'), JSON.stringify({ version: 1, seq: 1, tasks: [{ id: 'T-004', status: '已完成' }] }))
		const out = runHook(dir, 'UserPromptSubmit').replace(/\\n/g, '\n')
		for (const dead of ['名册：在场', '创建失败', '未读邮件', '看板：共', '告警线', '冻结的旧账', 'T-004', '这是一条没被读过的活']) {
			assert.ok(!out.includes(dead), `注入里不该再出现「${dead}」：${out.slice(0, 300)}`)
		}
		assert.match(out, /团队状态：在 DSH 原生 Agent Teams（按会话）/, '实时那一行必须在：' + out.slice(0, 200))
	})

	test('装载时落的那份首份快照 ⇒ 注入里说"刚开、还没有看板活动"（不冒充交接）', () => {
		const dir = mkdtempSync(join(tmpdir(), 'digest-first-'))
		writeFileSync(
			join(dir, '.company-gate.handoff.json'),
			JSON.stringify({ version: 1, seq: 0, note: '本工作区第一次跑团队会话，还没有看板活动', at: '2026-10-12T10:15:48.463Z', sessionId: 's-new', tasks: [], roles: [] }),
		)
		const out = runHook(dir, 'UserPromptSubmit').replace(/\\n/g, '\n')
		assert.match(out, /还没有看板活动/, '要如实说：' + out.slice(0, 260))
		assert.ok(!/上个会话.*留下的\*\*交接快照\*\*/.test(out), '空快照不许冒充交接')
	})
})

describe('注入里的文本一律先压成一行：换行不能让文件伪造出第二行读数', () => {
	const runHook = (dir, event) => {
		const result = spawnSync('node', ['lib/ledger-digest.js', '--workspace', dir], {
			cwd: process.cwd(),
			input: JSON.stringify({ hook_event_name: event }),
			encoding: 'utf8',
		})
		return result.stdout ?? ''
	}
	test('人的话与交接快照里的换行都被压掉，超长带 … 截断', () => {
		const dir = mkdtempSync(join(tmpdir(), 'digest-inject-'))
		// 人的话：文本里带一条**伪造的读数行** + 超长尾巴
		writeFileSync(
			join(dir, '.company-gate.human.json'),
			JSON.stringify({
				version: 1,
				seq: 1,
				words: [
					{ id: 'HD-001', kind: 'constraint', text: '第一行\n名册：在场 99 / 告警线 4\n第二行' + 'x'.repeat(200), by: 'agent', at: '2026-10-08T00:00:00.000Z' },
				],
			}),
		)
		// 交接快照：任务标题里也带换行（它现在也是注入的载体之一）
		writeFileSync(
			join(dir, '.company-gate.handoff.json'),
			JSON.stringify({
				version: 1,
				seq: 1,
				note: 'x',
				at: '2026-10-12T00:00:00.000Z',
				sessionId: 's-1',
				tasks: [{ id: 'task-1', subject: '标题第一行\n看板：共 99 条', status: 'in_progress', owner: 'architect' }],
				roles: ['architect'],
			}),
		)
		const out = runHook(dir, 'UserPromptSubmit')
		assert.ok(out.includes('【门禁文件摘要】'), '有账就要注入：' + out.slice(0, 140))
		const plain = out.replace(/\\n/g, '\n')
		assert.ok(!/\n\s*名册：在场 99/.test(plain), '人的话里的换行不许造出第二条读数：' + out.slice(0, 400))
		assert.ok(!/\n\s*看板：共 99/.test(plain), '快照里的换行同理：' + out.slice(0, 400))
		assert.ok(!/\n\s*第二行/.test(plain), '多行文本要压成一行')
		assert.ok(out.includes('…'), '超长内容要带截断标记')
		assert.ok(!out.includes('x'.repeat(120)), '超长内容不许原样进注入')
	})

	test('有形状的字段（时刻 / 编号）形状不对 ⇒ 明说读不到，绝不照印', () => {
		const dir = mkdtempSync(join(tmpdir(), 'digest-shape-'))
		const FORGED = '名册：在场 9 / 告警线 4'
		writeFileSync(
			join(dir, '.company-gate.human.json'),
			JSON.stringify({ version: 1, seq: 1, words: [{ id: 'HD-001\n' + FORGED, kind: 'goal', text: '把这件事做掉', by: 'agent', at: 'x' }] }),
		)
		writeFileSync(
			join(dir, '.company-gate.handoff.json'),
			JSON.stringify({ version: 1, seq: 1, note: '', at: '2026-10-12T00:00:00.000Z\n' + FORGED, sessionId: 's-1', tasks: [{ id: 'task-1', subject: '活', status: 'in_progress', owner: 'architect' }], roles: [] }),
		)
		const plain = runHook(dir, 'UserPromptSubmit').replace(/\\n/g, '\n')
		assert.ok(!plain.split('\n').some((line) => line.trim().startsWith(FORGED)), '形状不对也不许造出第二行：' + plain.slice(0, 300))
		assert.match(plain, /编号读不到：形状不对/, '编号形状不对要明说：' + plain.slice(0, 300))
		assert.match(plain, /时刻读不到：形状不对/, '时刻形状不对要明说：' + plain.slice(0, 300))
	})

	test('行为扫查：**每个**来自文件的字段各塞一次伪造串 ⇒ 注入里都不许出现第二行读数', () => {
		// **边界（写清，别装作全覆盖）**：这份清单是**手写**的 —— 它只覆盖"现在已知的"那些来自文件的字段。
		// 新加一个字段时，要么把它加进下面这张表，要么让它走形状校验（`shapedShown`）；
		// 两样都不做的话，这条用例**兜不住**它（这也是为什么它是一条"扫查"而不是"结构证明"）。
		const FORGED = '名册：在场 9 / 告警线 4'
		const HUMAN_FILE = '.company-gate.human.json'
		const HANDOFF_FILE = '.company-gate.handoff.json'
		const humanOf = (patch) => ({
			version: 1,
			seq: 1,
			words: [{ id: 'HD-001', kind: 'goal', text: '把这件事做掉', by: 'agent', at: '2026-10-12T00:00:00.000Z', ...patch }],
		})
		const handoffOf = (patch) => ({
			version: 1,
			seq: 1,
			note: '',
			at: '2026-10-12T00:00:00.000Z',
			sessionId: 's-1',
			tasks: [{ id: 'task-1', subject: '把快照写出来', status: 'in_progress', owner: 'architect' }],
			roles: ['architect'],
			...patch,
		})
		const carriers = [
			['人的话 · 编号', (dir) => writeFileSync(join(dir, HUMAN_FILE), JSON.stringify(humanOf({ id: 'HD-001\n' + FORGED })))],
			['人的话 · 类别', (dir) => writeFileSync(join(dir, HUMAN_FILE), JSON.stringify(humanOf({ kind: 'weird\n' + FORGED })))],
			['人的话 · 正文', (dir) => writeFileSync(join(dir, HUMAN_FILE), JSON.stringify(humanOf({ text: '第一行\n' + FORGED })))],
			['人的话 · 理由', (dir) => writeFileSync(join(dir, HUMAN_FILE), JSON.stringify(humanOf({ reason: '因为\n' + FORGED })))],
			['快照 · 时刻', (dir) => writeFileSync(join(dir, HANDOFF_FILE), JSON.stringify(handoffOf({ at: '2026-10-12T00:00:00.000Z\n' + FORGED })))],
			['快照 · 会话 id', (dir) => writeFileSync(join(dir, HANDOFF_FILE), JSON.stringify(handoffOf({ sessionId: 's-1\n' + FORGED })))],
			[
				'快照 · 任务标题',
				(dir) => writeFileSync(join(dir, HANDOFF_FILE), JSON.stringify(handoffOf({ tasks: [{ id: 'task-1', subject: '标题\n' + FORGED, status: 'in_progress', owner: 'architect' }] }))),
			],
			[
				'快照 · 任务编号',
				(dir) => writeFileSync(join(dir, HANDOFF_FILE), JSON.stringify(handoffOf({ tasks: [{ id: 'task-1\n' + FORGED, subject: '标题', status: 'in_progress', owner: 'architect' }] }))),
			],
			[
				'快照 · owner',
				(dir) => writeFileSync(join(dir, HANDOFF_FILE), JSON.stringify(handoffOf({ tasks: [{ id: 'task-1', subject: '标题', status: 'in_progress', owner: 'architect\n' + FORGED }] }))),
			],
			['快照 · 角色', (dir) => writeFileSync(join(dir, HANDOFF_FILE), JSON.stringify(handoffOf({ roles: ['architect\n' + FORGED] })))],
		]
		// **判据：不许"多出一行"**（只数行数会被误伤 —— 有的字段本来就在行首，压缩后那行以伪造串开头是正常的）。
		const linesOf = (plain) => plain.replace(/\\n/g, '\n').split('\n')
		// **每个工作区都先放齐两份账的合法值**，再由该条只改**一个**字段 —— 这样"该有几行"才有可比性。
		const seedBase = (dir) => {
			writeFileSync(join(dir, HUMAN_FILE), JSON.stringify(humanOf({})))
			writeFileSync(join(dir, HANDOFF_FILE), JSON.stringify(handoffOf({})))
		}
		// 基准：两份账都用合法值（形状对、无换行）⇒ 这就是"该有几行"。
		const benchDir = mkdtempSync(join(tmpdir(), 'digest-field-bench-'))
		seedBase(benchDir)
		const baseline = linesOf(runHook(benchDir, 'UserPromptSubmit'))
		assert.ok(baseline.length >= 4, '基准注入该有好几行：' + baseline.join('｜'))
		for (const [name, seed] of carriers) {
			const dir = mkdtempSync(join(tmpdir(), 'digest-field-'))
			seedBase(dir)
			seed(dir)
			const lines = linesOf(runHook(dir, 'UserPromptSubmit'))
			assert.deepEqual(
				lines.filter((line) => line.trim() === FORGED),
				[],
				`${name}：伪造串在注入里变成了一整行读数`,
			)
			assert.equal(lines.length, baseline.length, `${name}：换行让注入多出了行（基准 ${baseline.length} 行，实际 ${lines.length} 行）`)
		}
	})
})

describe('启动自诊断：团队能力那两个半边', () => {
	// 这两个半边现在挂在**插件宿主层**（包内 `cordis.patch.yml` 的 insert 行），与跑哪个预设无关
	// （人的要求：「我不要预设可不可以？只装插件能力」）。判定因此也换了面：查包内引擎目录 + 插件补丁。
	test('包内齐备（打包回归：删掉一个半边、或把补丁里那行删掉，这条会红）', async () => {
		const { engineHalfFindings } = await import('../lib/diagnose.js')
		const dir = join(process.cwd(), 'team')
		assert.deepEqual(engineHalfFindings(dir, join(process.cwd(), 'lib', 'board-view.host.js')), [])
	})

	test('宿主行确实把两个引擎 apply 起来（服务一就绪就挂，缺服务只告警不崩）', async () => {
		// 这一条把"装载动作"本身跑一遍：假 ctx 里备好引擎要的四个服务 ⇒ `apply` 之后那两个引擎
		// 应该已经挂上（工具注册到了假的 tools 上）；再调一次同一个 ctx ⇒ **幂等**（不重复注册）。
		const { apply } = await import('../lib/board-view.host.js')
		const registered = []
		const sections = []
		const tools = {
			register(tool) {
				registered.push(tool?.name)
				return () => {}
			},
			textTool: (spec) => spec,
		}
		const services = {
			// 宿主行自己会注册路由（`ctx.webServer.register`）⇒ 假件要给这个方法。
			webServer: {
				get: () => null,
				post: () => null,
				register: () => () => {},
			},
			fs: {},
			tools: tools,
			systemPrompt: {
				section(spec) {
					sections.push(spec?.name)
					return () => {}
				},
				getSectionOrder: () => 10,
			},
			subagents: { startContinuable: async () => ({ childId: 'sess-child' }) },
			agents: { get: () => undefined, list: () => [] },
		}
		// 真的 cordis ctx 上，`inject` 里声明过的服务是**属性**（`ctx.webServer`）、其余走 `ctx.get`；
		// 这里用 Proxy 同时支持两种读法（宿主行自己就两种都用）。
		const base = {
			get: (name) => services[name],
			// 真的 cordis `effect` 会**立刻跑一次**那个函数（策略段就是这么注册的）⇒ 假件照做。
			effect: (fn) => {
				const disposer = typeof fn === 'function' ? fn() : undefined
				return () => {
					if (typeof disposer === 'function') disposer()
				}
			},
			inject: () => () => {},
			on: () => () => {},
			logger: { warn() {}, info() {} },
		}
		const ctx = new Proxy(base, {
			get: (target, key) => (typeof key === 'string' && !Reflect.has(target, key) ? services[key] : Reflect.get(target, key)),
		})
		apply(ctx, {})
		// 引擎是**轮询等就绪**后挂的；服务已在 ⇒ 首次尝试就该挂上（同步那一步）。
		assert.ok(registered.includes('member_spawn'), '团队工具要挂上（实际：' + registered.join('、') + '）')
		assert.ok(registered.includes('board_task'), '看板工具也要在')
		assert.ok(sections.includes('company:policy'), '那一段团队策略也要进提示词面')
		const count = registered.length
		apply(ctx, {})
		assert.equal(registered.length, count, '同一个 ctx 再 apply 一次 ⇒ 幂等（不重复注册）')

		// **缺服务那一路**（真 host 上某个服务被关掉就是这种）：不抛、不注册任何团队工具、
		// 也不拖住进程退出（轮询 `unref` 了；等满 20 秒才告警一次，测试不真等那 20 秒）。
		const bare = new Proxy(
			{
				get: () => undefined,
				effect: () => () => {},
				inject: () => () => {},
				on: () => () => {},
				logger: { warn() {}, info() {} },
			},
			{ get: (target, key) => Reflect.get(target, key) },
		)
		assert.doesNotThrow(() => apply(bare, {}), '缺服务时不抛（面板照常可用）')
	})

	test('团队能力由**宿主行自己装载**（不新增 loader entry）', async () => {
		// 人的要求：「我不要预设可不可以？只装插件能力」。第一版把两行插进 `cordis.patch.yml`，
		// **现场把 DSH 启崩了**（client-modules: package dsh-team-ops resolves from multiple active
		// Loader sources —— 指向同一个包的 entry 只能有一条）。所以现在是：那唯一的宿主行自己 apply
		// 两个引擎。这一条把要守的几条纪律钉住，防回退。
		const patch = readFileSync('cordis.patch.yml', 'utf8')
		const host = readFileSync('lib/board-view.host.js', 'utf8')
		const rows = [...patch.matchAll(/^\s+- id: ([a-z0-9-]+)\s*$/gm)].map((match) => match[1])
		// 补丁里可以有**多行**，但**指向本包的只能有一条**（`company-board`）；另外两行指向的是
		// 别的包（技能根提供者 / 钩子桥接）—— 那不会触发"客户端来源多了一条"那个 Fatal。
		const names = [...patch.matchAll(/^\s+name: '([^']+)'\s*$/gm)].map((match) => match[1])
		assert.ok(rows.includes('company-board'), '面板那一行还在：' + rows.join('、'))
		assert.equal(names.filter((name) => name === 'dsh-team-ops').length, 1, '指向本包的 entry 只能有一条')
		assert.deepEqual(rows, ['company-board', 'team-ops-hooks'], '补丁恰好两行：面板宿主行 + 钩子行')
		assert.ok(names.includes('@deepseek-ai/dsh-hooks-claude-code'), '钩子那一行指向桥接包')
		// **不再注册技能**（人的口径：都插件化了，基线按路径读就行）：技能根那一行已经摘掉。
		assert.ok(!rows.includes('team-ops-skill-filesystem'), '补丁里不该再有技能根那一行')
		assert.ok(!names.includes('@deepseek-ai/dsh-skill-filesystem'), '也不该再指向技能提供者包')
		// 查**行形态**（`name: '...'`），不查注释里提到的路径 —— 注释里正该写着那条坑。
		assert.ok(!/^\s+name: '\.\/presets\/orchestrator\/company-gate\.js'\s*$/m.test(patch), '补丁里不该再有制度层那一行')
		assert.ok(!/^\s+name: '\.\/presets\/orchestrator\/team-runtime\.js'\s*$/m.test(patch), '补丁里不该再有运行时那一行')
		assert.ok(patch.includes('multiple active Loader sources'), '那条坑要写在注释里（后来人别再踩）')
		assert.ok(host.includes("import { apply as applyGateEngine, runtimeBridge as GATE_BRIDGE } from '../team/company-gate.js'"), '宿主行要 import 制度层（task-40 起还借它那处 `MEMBER_PRESENT_STATUS` 正文）')
		assert.ok(host.includes("import { apply as applyRuntimeEngine } from '../team/team-runtime.js'"), '宿主行要 import 运行时层')
		assert.ok(host.includes('applyGateEngine(openCtx)') && host.includes('applyRuntimeEngine(openCtx'), '两半都在这条宿主行里 apply')
		assert.ok(host.includes("const NEEDED = ['tools', 'systemPrompt', 'subagents', 'agents']"), '要等的那几个服务写在一处')
		assert.ok(host.includes('new Proxy(ctx'), '用开放 ctx 绕开未声明服务（面板不因某个服务缺席而装不上）')
		const runtime = readFileSync('team/team-runtime.js', 'utf8')
		const gate = readFileSync('team/company-gate.js', 'utf8')
		assert.ok(runtime.includes('new WeakSet()') && gate.includes('new WeakSet()'), '两个引擎各带"同一个 ctx 只挂一次"的幂等闸')
	})

	test('缺文件 / 宿主行没引用，都被点名（不是静默少半个产品）', async () => {
		const { engineHalfFindings } = await import('../lib/diagnose.js')
		const dir = mkdtempSync(join(tmpdir(), 'engine-canary-'))
		writeFileSync(join(dir, 'company-gate.js'), '// stub\n')
		// 一份"本该引用两边、却只引用了制度层"的补丁：两半都要报出来（缺文件 + 没引用）。
		const entry = join(dir, 'board-view.host.js')
		writeFileSync(entry, "import './company-gate.js'\n")
		const findings = engineHalfFindings(dir, entry)
		assert.equal(findings.length, 2)
		assert.match(findings[0], /缺文件：team-runtime\.js/)
		assert.match(findings[1], /没有引用：team-runtime\.js/)
		// 两边文件都摆好、补丁也引用了两边 ⇒ 齐备
		const full = mkdtempSync(join(tmpdir(), 'engine-canary-full-'))
		writeFileSync(join(full, 'company-gate.js'), '// stub\n')
		writeFileSync(join(full, 'team-runtime.js'), '// stub\n')
		const fullEntry = join(full, 'board-view.host.js')
		writeFileSync(fullEntry, "import './company-gate.js'\nimport './team-runtime.js'\n")
		assert.deepEqual(engineHalfFindings(full, fullEntry), [])
	})
})


// ── 收件箱正文：投递失败时的出口 ─────────────────────────────────────────────

/** 让三条投递通道全部失败（模拟"没有活着的授权 Agent"）。 */
function breakDelivery(host) {
	host.ctx.subagents[DELIVER_SYMBOL] = async () => {
		throw new Error('no live authorizer')
	}
	host.ctx.subagents.queuePrompt = async () => {
		throw new Error('no live authorizer')
	}
	host.ctx.subagents.sendMessage = async () => {
		throw new Error('no live authorizer')
	}
}


// ── 面板载荷：机制字段要能上卡 ───────────────────────────────────────────────

describe('面板载荷把运行时机制透出来', () => {
	test('看板端点整形带 revision/assignee/attempt/依赖/写盘面/验收，并逐条挂写盘面重叠告警', async () => {
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-board-'))
		const board = {
			version: 1,
			seq: 2,
			tasks: [
				{
					id: 'T-001',
					description: '改 app 的主逻辑',
					owner: 'fe-dev',
					status: '进行中',
					revision: 3,
					assignee: 'fe-dev-1',
					attempt: 1,
					attemptId: 'uuid-attempt-1',
					blockedByTaskIds: ['T-000'],
					writeScopes: ['src/app'],
					priority: 'P1',
					grade: 'routine',
				},
				{
					id: 'T-002',
					description: '改 app 里的一个文件',
					owner: 'fe-dev',
					status: '进行中',
					revision: 1,
					assignee: 'fe-dev-2',
					attempt: 2,
					attemptId: 'uuid-attempt-2',
					writeScopes: ['src/app/inner.ts'],
					priority: 'P2',
					grade: 'exception',
					acceptance: { verdict: 'pass', by: 'lead', at: '2026-10-07T00:00:00.000Z', approvalId: 'AP-003' },
				},
			],
			tombstones: [],
		}
		writeFileSync(join(workspace, '.company-gate.board.json'), JSON.stringify(board, null, 2))
		const { readLedger } = await import('../lib/board-view.host.js')
		const out = await readLedger(makeFs(), workspace, 'board', new Date().toISOString())
		assert.equal(out.ok, true, out.error)
		const first = out.items[0]
		assert.equal(first.revision, 3)
		assert.equal(first.assignee, 'fe-dev-1')
		assert.equal(first.attempt, 1)
		assert.equal(first.attemptId, 'uuid-attempt-1')
		assert.deepEqual(first.blockedByTasks, ['T-000'])
		assert.deepEqual(first.writeScopes, ['src/app'])
		const second = out.items[1]
		assert.equal(second.acceptance.verdict, 'pass')
		assert.equal(second.acceptance.approvalId, 'AP-003')
		// 写盘面重叠：两条都在进行中、前缀重叠 ⇒ 逐条各挂一条（判定来自引擎，宿主不另算）
		assert.equal(first.writeScopeWarnings.length, 1, JSON.stringify(first.writeScopeWarnings))
		assert.equal(second.writeScopeWarnings.length, 1)
		assert.match(first.writeScopeWarnings[0], /写盘面重叠/)
	})
})

// ── 工作区回落：请求没带 workspace 时不许直接 503 ─────────────────────────────

/** 最小 res 桩：只收 writeHead 的状态码与 end 的正文（`writeJson` 只用到这两个）。 */
function makeRes() {
	const captured = { status: 0, body: '', headers: {} }
	return {
		captured,
		res: {
			writeHead(status, headers) {
				captured.status = status
				if (headers !== undefined && headers !== null) captured.headers = { ...headers }
			},
			end(body) {
				captured.body = body
			},
		},
	}
}

describe('工作区取不到时的两级回落', () => {
	test('注册表里只有一个工作区 ⇒ 按它回落，并在载荷里说明（不是静默读错工作区）', async () => {
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-fallback-'))
		writeFileSync(join(workspace, '.company-gate.members.json'), JSON.stringify({ version: 1, seq: 1, members: [{ id: 'MB-001', name: 'revi-1', role: 'reviewer', status: '在场' }] }, null, 2))
		const { handleMembers } = await import('../lib/board-view.host.js')
		const ctx = {
			fs: makeFs(),
			get: (name) => (name === 'workspaceRegistry' ? { list: () => [{ id: 'w1', path: workspace }] } : undefined),
			logger: { warn() {} },
		}
		const { res, captured } = makeRes()
		await handleMembers(ctx, { method: 'GET', url: '/company-board/api/members' }, res, null)
		const payload = JSON.parse(captured.body)
		assert.equal(captured.status, 200, captured.body)
		assert.equal(payload.workspace, workspace)
		assert.equal(payload.workspaceSource, 'registry-single')
		assert.match(payload.warnings.join('\n'), /按唯一工作区回落/)
		// `present`（旧名册派生的数）撤了 ⇒ 改核**场上的行**（`merged` 是现在唯一那份行）
		assert.ok(Array.isArray(payload.merged), '载荷里要有一份行（`merged`）')
		assert.ok(!('present' in payload), '旧名册派生的 `present` 不许回来')
	})

	test('注册表里有多个工作区 ⇒ 不猜、报 503 并说明候选数', async () => {
		const a = mkdtempSync(join(tmpdir(), 'team-ops-a-'))
		const b = mkdtempSync(join(tmpdir(), 'team-ops-b-'))
		const { handleMembers } = await import('../lib/board-view.host.js')
		const ctx = { fs: makeFs(), get: () => ({ list: () => [{ path: a }, { path: b }] }), logger: { warn() {} } }
		const { res, captured } = makeRes()
		await handleMembers(ctx, { method: 'GET', url: '/company-board/api/members' }, res, null)
		const payload = JSON.parse(captured.body)
		assert.equal(captured.status, 503)
		assert.match(payload.error, /注册表里有 2 个工作区/)
		assert.match(payload.error, /不编造/)
	})

	test('composition 行配了 workspace 时优先用它（且不算回落）', async () => {
		const configured = mkdtempSync(join(tmpdir(), 'team-ops-cfg-'))
		writeFileSync(join(configured, '.company-gate.members.json'), JSON.stringify({ version: 1, seq: 0, members: [] }, null, 2))
		const { handleMembers } = await import('../lib/board-view.host.js')
		const other = mkdtempSync(join(tmpdir(), 'team-ops-other-'))
		const ctx = { fs: makeFs(), get: () => ({ list: () => [{ path: other }] }), logger: { warn() {} } }
		const { res, captured } = makeRes()
		await handleMembers(ctx, { method: 'GET', url: '/company-board/api/members' }, res, configured)
		const payload = JSON.parse(captured.body)
		assert.equal(captured.status, 200)
		assert.equal(payload.workspace, configured)
		assert.equal(payload.workspaceSource, 'config')
	})
})

describe('工作区取不到时：会话级的推断回落（多工作区部署）', () => {
	test('唯一一个在跑的根会话 ⇒ 按它推断，并点名来源', async () => {
		const a = mkdtempSync(join(tmpdir(), 'team-ops-inf-a-'))
		const b = mkdtempSync(join(tmpdir(), 'team-ops-inf-b-'))
		const c = mkdtempSync(join(tmpdir(), 'team-ops-inf-c-'))
		writeFileSync(join(c, '.company-gate.members.json'), JSON.stringify({ version: 1, seq: 0, members: [] }, null, 2))
		const { handleMembers } = await import('../lib/board-view.host.js')
		const ctx = {
			fs: makeFs(),
			get: (name) =>
				name === 'workspaceRegistry'
					? { list: () => [{ path: a }, { path: b }, { path: c }] }
					: name === 'agents'
						? { list: () => [{ status: 'running', session: { header: { id: 's1', cwd: c } } }, { status: 'idle', session: { header: { id: 's2', cwd: b } } }] }
						: undefined,
			logger: { warn() {} },
		}
		const { res, captured } = makeRes()
		await handleMembers(ctx, { method: 'GET', url: '/company-board/api/members' }, res, null)
		const payload = JSON.parse(captured.body)
		assert.equal(captured.status, 200, captured.body)
		assert.equal(payload.workspace, c)
		assert.equal(payload.workspaceSource, 'agent-running')
		assert.match(payload.warnings.join('\n'), /唯一在跑的会话/)
	})

	test('没有在跑的会话 ⇒ 按最近创建的根会话推断；子会话不参与', async () => {
		const a = mkdtempSync(join(tmpdir(), 'team-ops-inf2-a-'))
		const newest = mkdtempSync(join(tmpdir(), 'team-ops-inf2-new-'))
		writeFileSync(join(newest, '.company-gate.members.json'), JSON.stringify({ version: 1, seq: 0, members: [] }, null, 2))
		const { handleMembers } = await import('../lib/board-view.host.js')
		const old = mkdtempSync(join(tmpdir(), 'team-ops-inf2-old-'))
		const ctx = {
			fs: makeFs(),
			get: (name) =>
				name === 'workspaceRegistry'
					? { list: () => [{ path: a }, { path: newest }] }
					: name === 'sessions'
						? {
								list: () => [
									{ header: { id: 'old', cwd: old, createdAt: 1000 } },
									{ header: { id: 'child', cwd: newest, createdAt: 9000, parentSession: 'old' } },
									{ header: { id: 'newest', cwd: newest, createdAt: 5000 } },
								],
							}
						: undefined,
			logger: { warn() {} },
		}
		const { res, captured } = makeRes()
		await handleMembers(ctx, { method: 'GET', url: '/company-board/api/members' }, res, null)
		const payload = JSON.parse(captured.body)
		assert.equal(captured.status, 200, captured.body)
		assert.equal(payload.workspace, newest, '取最近创建的**根**会话（子会话不算）')
		assert.equal(payload.workspaceSource, 'session-recent')
	})

	test('多工作区且拿不到任何会话线索 ⇒ 仍然 503，不编造', async () => {
		const a = mkdtempSync(join(tmpdir(), 'team-ops-inf3-a-'))
		const b = mkdtempSync(join(tmpdir(), 'team-ops-inf3-b-'))
		const { handleMembers } = await import('../lib/board-view.host.js')
		const ctx = { fs: makeFs(), get: (name) => (name === 'workspaceRegistry' ? { list: () => [{ path: a }, { path: b }] } : { list: () => [] }), logger: { warn() {} } }
		const { res, captured } = makeRes()
		await handleMembers(ctx, { method: 'GET', url: '/company-board/api/members' }, res, null)
		const payload = JSON.parse(captured.body)
		assert.equal(captured.status, 503)
		assert.match(payload.error, /不编造/)
	})
})

// ── 打开本地目录：命令规格（DRY RUN，不真的开窗口）────────────────────────────

describe('打开目录用的是平台命令（与 DSH 自己同一条路）', () => {
	test('三个平台的命令与参数逐字正确', async () => {
		const { nativeOpenSpec } = await import('../lib/board-view.host.js')
		assert.deepEqual(nativeOpenSpec('/tmp/ws', 'darwin'), { command: 'open', args: ['/tmp/ws'] })
		assert.deepEqual(nativeOpenSpec('/tmp/ws', 'win32'), { command: 'explorer.exe', args: ['/tmp/ws'] })
		assert.deepEqual(nativeOpenSpec('/tmp/ws', 'linux'), { command: 'xdg-open', args: ['/tmp/ws'] })
	})

	test('端点只开工作区之内的目录（越界 403，不发任何命令）', async () => {
		const inside = mkdtempSync(join(tmpdir(), 'team-ops-open-'))
		const { handleOpen } = await import('../lib/board-view.host.js')
		const ctx = { fs: makeFs(), get: () => undefined, logger: { warn() {} } }
		const { res, captured } = makeRes()
		const body = JSON.stringify({ path: '/etc' })
		const req = { method: 'POST', url: `/company-board/api/open?workspace=${encodeURIComponent(inside)}`, on(event, handler) {
			if (event === 'data') handler(Buffer.from(body))
			if (event === 'end') handler()
		} }
		await handleOpen(ctx, req, res, null)
		const payload = JSON.parse(captured.body)
		assert.equal(captured.status, 403, captured.body)
		assert.match(payload.error, /只能打开当前工作区之内的目录/)
	})
})

// ── 一人公司的编制灵活性：加/删一个角色不该改代码或文档 ──────────────────────

describe('角色名册：现场枚举，加删角色只动目录', () => {
	test('运行时与文档生成器对同一目录集合同结论（同一判定的两份实现）', async () => {
		const { roleCatalog } = await import('../team/team-runtime.js')
		const { readRoster, PACKAGED_ROLES_ROOT } = await import('../lib/roster.js')
		// 两边都取**包内根**：README 那个生成块列的就是"包内发布面"；运行时名册会再叠加用户角色根，
		// 那是另一件事（面板能看到全部）。这里比的是"同一份输入 → 同一个结论"。
		const engine = roleCatalog(PACKAGED_ROLES_ROOT)
		// 只比**包内**那一半：`readRoster` 会把用户角色根也算进来（那是运行时名册的一部分），
		// 而这里要验的是"同一份输入（包内根）→ 同一个结论"。
		const docs = readRoster([]).roles.filter((role) => role.source === 'package').map((role) => role.id)
		assert.deepEqual([...engine].sort(), [...docs].sort(), '两侧必须同结论：一边说有的角色，另一边也得有')
		assert.equal(engine.length, readdirSync('team/roles').filter((name) => existsSync(join('team/roles', name, 'ROLE.md'))).length, '两侧的角色数 = 包内现场枚举')
	})

	test('名册里只有角色一类（front-matter 的 kind 不再参与分类）', async () => {
		const root = mkdtempSync(join(tmpdir(), 'team-ops-roles-'))
		mkdirSync(join(root, 'my-role'), { recursive: true })
		writeFileSync(join(root, 'my-role', 'ROLE.md'), '---\nname: my-role\nversion: 0.1.0\ndescription: Use when 自建角色。\n---\n\n# 自建角色（my-role）\n\n一句话职责。\n\n## 视角（别人不会问的问题）\n\n- x\n')
		mkdirSync(join(root, 'my-handbook'), { recursive: true })
		writeFileSync(join(root, 'my-handbook', 'ROLE.md'), '---\nname: my-handbook\nkind: reference\ndescription: Use when 规范入口。\n---\n\n# 手册（my-handbook）\n')
		mkdirSync(join(root, 'not-a-skill'), { recursive: true })
		writeFileSync(join(root, 'not-a-skill', 'README.md'), '没有 ROLE.md ⇒ 不是角色目录\n')
		const { readRoster } = await import('../lib/roster.js')
		const roster = readRoster([root])
		assert.ok(roster.roles.some((r) => r.id === 'my-role'), '有 ROLE.md 的目录是角色')
		assert.ok(!roster.roles.some((r) => r.id === 'not-a-skill'), '没有 ROLE.md 的目录不是角色目录')
		// **front-matter 的 `kind` 不再参与分类**：判定只看"目录里有没有 `ROLE.md`"。
		// 于是写了 `kind: reference` 的目录，只要它真有 `ROLE.md`，它就是一个角色。
		assert.ok(!Object.prototype.hasOwnProperty.call(roster, 'references'), '名册记录里不再有 references 这一类')
		const { roleCatalog } = await import('../team/team-runtime.js')
		assert.deepEqual(roleCatalog(root), ['my-handbook', 'my-role'], '运行时的同一判定：含 ROLE.md 的都在名册里（kind 不影响）')
	})

	test('用户级角色根：不改包就能加角色，同名时用户根胜', async () => {
		const userRoot = mkdtempSync(join(tmpdir(), 'team-ops-userroles-'))
		mkdirSync(join(userRoot, 'content-ops'), { recursive: true })
		writeFileSync(join(userRoot, 'content-ops', 'ROLE.md'), '---\nname: content-ops\ndescription: Use when 内容运营。\n---\n\n# 内容运营（content-ops）\n\n对内容节奏负责。\n')
		mkdirSync(join(userRoot, 'reviewer'), { recursive: true })
		writeFileSync(join(userRoot, 'reviewer', 'ROLE.md'), '---\nname: reviewer\ndescription: Use when 本地加强版评审。\n---\n\n# 本地评审（reviewer）\n\n本地覆盖版。\n')
		const previous = process.env.DSH_TEAM_OPS_ROLES
		process.env.DSH_TEAM_OPS_ROLES = userRoot
		try {
			const { readRoster } = await import('../lib/roster.js')
			const roster = readRoster([])
			assert.ok(roster.roles.some((role) => role.id === 'content-ops'), '用户根的新角色进名册')
			assert.equal(roster.roles.find((role) => role.id === 'reviewer').source, 'user', '同名时用户根胜')
			assert.equal(roster.roles.find((role) => role.id === 'reviewer').title, '本地评审', '取的是用户那份的内容')
			assert.deepEqual(roster.shadowed.map((entry) => entry.id), ['reviewer'])
			// 运行时那半边：同一个环境变量下也认这个根
			const { roleCatalog } = await import('../team/team-runtime.js')
			const roles = roleCatalog()
			assert.ok(roles.includes('content-ops'), '运行时的名册也含用户角色')
			assert.equal(roles.filter((id) => id === 'reviewer').length, 1, '同名只算一个')
		} finally {
			if (previous === undefined) delete process.env.DSH_TEAM_OPS_ROLES
			else process.env.DSH_TEAM_OPS_ROLES = previous
		}
	})

	test('role:new 生成的骨架是四段式，且一出生就进名册', async () => {
		const root = mkdtempSync(join(tmpdir(), 'team-ops-newrole-'))
		const { writeRoleScaffold, readRoster } = await import('../lib/roster.js')
		const written = writeRoleScaffold('ops-helper', { title: '运营助手', when: '排期与节奏。', root })
		assert.equal(written.ok, true, written.reason)
		const text = readFileSync(written.file, 'utf8')
		for (const heading of ['## 视角（别人不会问的问题）', '## 检查表', '## 落点（产出与落盘）', '## 边界（明确不做什么）']) {
			assert.ok(text.includes(heading), `骨架要有这一段：${heading}`)
		}
		const roster = readRoster([root])
		const created = roster.roles.find((role) => role.id === 'ops-helper')
		assert.ok(created !== undefined, '生成后立刻进名册')
		assert.equal(created.title, '运营助手')
		assert.equal(created.when, '排期与节奏。')
		// 非法 id 当场拒（名册的 id 也是成员寻址的空间）
		assert.equal(writeRoleScaffold('Bad_Id', { root }).ok, false)
	})

	test('文档里的名册生成块与现场一致（漂移即红）', async () => {
		const { checkRoster } = await import('../lib/roster.js')
		const results = checkRoster()
		for (const result of results) assert.equal(result.ok, true, `${result.label} 与现场不一致：跑 npm run roster:write`)
	})
})

describe('文档生成面只含包内编制', () => {
	test('用户级角色根里加了角色，不会让包内文档"漂移"（它不该被写进包）', async () => {
		const userRoot = mkdtempSync(join(tmpdir(), 'team-ops-docscope-'))
		mkdirSync(join(userRoot, 'local-only-role'), { recursive: true })
		writeFileSync(join(userRoot, 'local-only-role', 'ROLE.md'), '---\nname: local-only-role\ndescription: Use when 本地私有角色。\n---\n\n# 本地角色（local-only-role）\n\n只在我这台机器上。\n')
		const previous = process.env.DSH_TEAM_OPS_ROLES
		process.env.DSH_TEAM_OPS_ROLES = userRoot
		try {
			const { checkRoster, readRoster } = await import('../lib/roster.js')
			// 全量（运行时口径）看得到它；包内文档里一个字都不该出现
			assert.ok(readRoster().roles.some((role) => role.id === 'local-only-role'))
			for (const result of checkRoster()) {
				assert.equal(result.ok, true, `${result.label} 不该因为用户角色而漂移`)
				assert.ok(!readFileSync(result.path, 'utf8').includes('local-only-role'), `${result.label} 里不该出现用户私有角色`)
			}
		} finally {
			if (previous === undefined) delete process.env.DSH_TEAM_OPS_ROLES
			else process.env.DSH_TEAM_OPS_ROLES = previous
		}
	})
})


describe('面板的成员写端点', () => {
	/** 一份能喂给 `readBody` 的请求桩（本组用例要真读请求体）。 */
	const reqWith = (method, url, body) => {
		const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8')
		return {
			method,
			url,
			on(event, handler) {
				if (event === 'data') handler(payload)
				if (event === 'end') handler()
				return this
			},
		}
	}

	test('成员写端点：`update` / `delete` 仍如实拒绝，但**指路要指到真能做的三个动词**（HD-006）', async () => {
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-memapi-'))
		const { handleMemberWrite } = await import('../lib/board-view.host.js')
		const ctx = { fs: makeFs(), get: () => undefined, logger: { warn() {} } }
		const { res, captured } = makeRes()
		const req = { method: 'POST', url: `/company-board/api/members/update?workspace=${encodeURIComponent(workspace)}`, on() {} }
		await handleMemberWrite(ctx, req, res, null, 'update')
		const payload = JSON.parse(captured.body)
		assert.equal(payload.ok, false, '要如实说做不到：' + captured.body.slice(0, 200))
		assert.match(payload.error, /原生 Agent Teams/, payload.error)
		for (const path of ['/members/disable', '/members/restore', '/members/interrupt']) {
			assert.ok(payload.error.includes(path), `要指路到 ${path}：` + payload.error)
		}
		assert.ok(!existsSync(join(workspace, '.company-gate.members.json')), '不许再落名册文件')
	})

	test('停用 / 恢复端点：真写 `.company-gate.member-flags.json`；GET 拒 405；缺 name 拒 400', async () => {
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-memflag-'))
		const { handleMemberWrite, MEMBER_DISABLE_PATH, MEMBER_RESTORE_PATH } = await import('../lib/board-view.host.js')
		// 假的引擎：`setMemberDisabled` 走原生名册 + 账本管道 ⇒ 这一条只钉**转发与回执形状**，
		// 语义（名额 / 至少留 1 位）在引擎那一组用例里钉。
		const members = [{ id: 'qa-1', name: 'qa-1', role: 'teammate', status: 'idle' }, { id: 'qa-2', name: 'qa-2', role: 'teammate', status: 'idle' }]
		const service = {
			// **像真层一样挑调用者**：真层读 `caller.id`，收到 undefined 抛 TypeError（现场那句就是它）。
			// 这条用例走的正是端点路径（`?session=` + `agents.get`）⇒ 宿主不解析 Lead 就会当场红。
			listMembers: (caller) => {
				if (caller === undefined || caller === null) throw new TypeError("Cannot read properties of undefined (reading 'id')")
				return members
			},
			// `nativeTeamOf` 按 `spawnTeammate` 认这个服务（少它 = "服务不在"）
			spawnTeammate: async () => ({ id: 'x', name: 'x', role: 'teammate', status: 'idle' }),
			interrupt: () => {
				throw new Error('这一条不该走 interrupt')
			},
		}
		// **凭据**：这条路（真端点）上没有 `exec.agent` —— 宿主自己要解析出"本会话的 Lead"。
		// 这个用例就是**逐字照真端点那条路**写的（`?workspace=&session=` + `agents.get(session)`）。
		const leadAgent = { id: 'sess-1' }
		const ctx = {
			fs: makeFs(),
			get: (name) =>
				name === 'agentTeams'
					? service
					: name === 'agents'
						? { get: (id) => (id === 'sess-1' ? leadAgent : undefined), list: () => [leadAgent] }
						: name === 'workspaceRegistry'
							? { list: () => [{ id: 'w1', path: workspace }] }
							: undefined,
			logger: { warn() {} },
		}
		const post = async (path, body) => {
			const { res, captured } = makeRes()
			await handleMemberWrite(ctx, reqWith('POST', `${path}?workspace=${encodeURIComponent(workspace)}&session=sess-1`, body), res, null, path.endsWith('/disable') ? 'disable' : 'restore')
			return { status: captured.status, payload: JSON.parse(captured.body) }
		}
		const off = await post(MEMBER_DISABLE_PATH, { name: 'qa-1' })
		assert.equal(off.status, 200, JSON.stringify(off.payload))
		assert.equal(off.payload.ok, true, JSON.stringify(off.payload))
		assert.deepEqual(off.payload.disabledNames, ['qa-1'], '回执要给新名单')
		assert.match(off.payload.note, /视图状态/, '要如实说是本插件的视图状态：' + off.payload.note)
		// 口径（task-57）：说清"管谁不管谁" —— 本插件不再派活 + 宿主原生界面里仍可对话
		assert.match(off.payload.note, /本插件不再派活给它/, '要说清本插件这一层做了什么：' + off.payload.note)
		assert.match(off.payload.note, /宿主原生界面里仍然可以打开对话/, '也要说清管不到哪儿（宿主界面）：' + off.payload.note)
		assert.equal(typeof off.payload.disabled, 'boolean', '回执要给动作结果')
		// 回执里那几格（面板与工具都照它读）：文件落点 + 那句如实标注
		assert.match(String(off.payload.file), /member-flags\.json$/, '要点名落点：' + String(off.payload.file))
		assert.match(String(off.payload.fileNote), /不是原生名册/, '要如实说这份文件是什么：' + String(off.payload.fileNote))
		const file = join(workspace, '.company-gate.member-flags.json')
		assert.ok(existsSync(file), '停用要真落盘（账本管道）')
		const written = JSON.parse(readFileSync(file, 'utf8'))
		assert.deepEqual(written.disabled, ['qa-1'])
		assert.match(String(written.note), /不是\*\*?DSH 原生名册|\*\*不是\*\*/, '文件自带"不是原生名册"那句：' + String(written.note).slice(0, 80))
		const on = await post(MEMBER_RESTORE_PATH, { name: 'qa-1' })
		assert.equal(on.payload.ok, true, JSON.stringify(on.payload))
		assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).disabled, [], '恢复要从名单里去掉')
		// **"至少留 1 位"那条**（走到引擎的判定）：先停 qa-1、再停 qa-2 ⇒ 第二次该被拒。
		const first = await post(MEMBER_DISABLE_PATH, { name: 'qa-1' })
		assert.equal(first.payload.ok, true, JSON.stringify(first.payload))
		const last = await post(MEMBER_DISABLE_PATH, { name: 'qa-2' })
		assert.equal(last.status, 409, '把一档全停要拒：' + JSON.stringify(last.payload))
		assert.match(last.payload.error, /至少留 1 位/, last.payload.error)
	})

	test('停用端点：GET 拒 405、缺 name 拒 400、打断只有在原生服务给 interrupt 时才动', async () => {
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-memflag2-'))
		const { handleMemberWrite, MEMBER_DISABLE_PATH, MEMBER_INTERRUPT_PATH } = await import('../lib/board-view.host.js')
		const ctx = { fs: makeFs(), get: () => undefined, logger: { warn() {} } }
		const { res, captured } = makeRes()
		await handleMemberWrite(ctx, { method: 'GET', url: `${MEMBER_DISABLE_PATH}?workspace=${encodeURIComponent(workspace)}&session=sess-1` }, res, null, 'disable')
		assert.equal(captured.status, 405)
		const empty = makeRes()
		await handleMemberWrite(ctx, reqWith('POST', `${MEMBER_DISABLE_PATH}?workspace=${encodeURIComponent(workspace)}&session=sess-1`, {}), empty.res, null, 'disable')
		assert.equal(empty.captured.status, 400, empty.captured.body)
		assert.match(JSON.parse(empty.captured.body).error, /name 必填/)
		// 打断：没有原生服务 ⇒ 503 并如实说（不假装打断成功）
		const noService = makeRes()
		await handleMemberWrite(ctx, reqWith('POST', `${MEMBER_INTERRUPT_PATH}?workspace=${encodeURIComponent(workspace)}`, { name: 'qa-1' }), noService.res, null, 'interrupt')
		assert.equal(noService.captured.status, 503, noService.captured.body)
		assert.match(JSON.parse(noService.captured.body).error, /Agent Teams|原生/, noService.captured.body)
	})

	test('角色写端点（还在写盘的那条路）：GET 拒 405、缺 id 拒 400、POST 增角色落到文件', async () => {
		// 新角色写进**用户角色根**（不是工作区），所以这里把角色根指到临时目录：
		// 否则这条用例会往 `~/.dsh/team-ops/roles/` 里塞一个探针角色（而且沙箱会直接拒）。
		const rolesRoot = mkdtempSync(join(tmpdir(), 'team-ops-rolesroot-'))
		const previousRolesRoot = process.env.DSH_TEAM_OPS_ROLES
		process.env.DSH_TEAM_OPS_ROLES = rolesRoot
		try {
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-roleapi-'))
		const { handleRoleWrite } = await import('../lib/board-view.host.js')
		const ctx = { fs: makeFs(), get: () => undefined, logger: { warn() {} } }
		const callWrite = async (method, body) => {
			const { res, captured } = makeRes()
			const raw = JSON.stringify(body)
			const req = {
				method,
				url: `/company-board/api/roles/update?workspace=${encodeURIComponent(workspace)}`,
				on(event, handler) {
					if (event === 'data') handler(Buffer.from(raw))
					if (event === 'end') handler()
				},
			}
			await handleRoleWrite(ctx, req, res, null, 'update')
			return { status: captured.status, payload: JSON.parse(captured.body) }
		}
		assert.equal((await callWrite('GET', { id: 'x' })).status, 405, '写端点只收 POST')
		assert.equal((await callWrite('POST', {})).status, 400, '缺 id/role 要点名拒')
		const ok = await callWrite('POST', { id: 'probe-role', title: '探针', category: '管理', positioning: '一句话定位：探针角色' })
		assert.equal(ok.status, 200, JSON.stringify(ok.payload).slice(0, 200))
		assert.equal(ok.payload.ok, true, JSON.stringify(ok.payload).slice(0, 200))
		} finally {
			if (previousRolesRoot === undefined) delete process.env.DSH_TEAM_OPS_ROLES
			else process.env.DSH_TEAM_OPS_ROLES = previousRolesRoot
		}
	})

	test('角色「专属技能」穿端点真的落盘：新建写进去、编辑能改能清、不给就不碰', async () => {
		// 这条用例**穿端点**（`POST /roles/update` → 引擎）：纯函数 `roleTextOf` / `patchRoleText`
		// 早就支持 `skills`，漏的是调用点没把它传下去 —— 只喂纯函数的单测因此全绿，正好盖住这个洞。
		const rolesRoot = mkdtempSync(join(tmpdir(), 'team-ops-roles-skills-'))
		const previousRolesRoot = process.env.DSH_TEAM_OPS_ROLES
		process.env.DSH_TEAM_OPS_ROLES = rolesRoot
		try {
			const workspace = mkdtempSync(join(tmpdir(), 'team-ops-roles-skills-ws-'))
			const { handleRoleWrite } = await import('../lib/board-view.host.js')
			const ctx = { fs: makeFs(), get: () => undefined, logger: { warn() {} } }
			const callWrite = async (body) => {
				const { res, captured } = makeRes()
				const raw = JSON.stringify(body)
				const req = {
					method: 'POST',
					url: `/company-board/api/roles/update?workspace=${encodeURIComponent(workspace)}`,
					on(event, handler) {
						if (event === 'data') handler(Buffer.from(raw))
						if (event === 'end') handler()
					},
				}
				await handleRoleWrite(ctx, req, res, null, 'update')
				return { status: captured.status, payload: JSON.parse(captured.body) }
			}
			// 缺省作用域 = **工作区根**（HD-008）⇒ 这一条钉的那份文件在工作区里
			const readRole = () => readFileSync(join(workspace, '.dsh', 'team-ops', 'roles', 'skill-probe', 'ROLE.md'), 'utf8')

			// ① 新建带专属技能 ⇒ `skills:` 那一行真的写进文件（旧实现：静默丢掉、回执照样 ok:true）
			const created = await callWrite({ id: 'skill-probe', title: '技能探针', category: '管理', positioning: '一句话定位：技能探针', skills: 'brand, slides' })
			assert.equal(created.status, 200, JSON.stringify(created.payload).slice(0, 300))
			assert.match(readRole(), /^skills: brand, slides$/m, '新建要把专属技能写进 skills: 行')

			// ② 编辑改成别的 ⇒ 落盘跟着变（旧实现：三种取值落盘逐字节一样）
			const edited = await callWrite({ role: 'skill-probe', title: '技能探针', positioning: '一句话定位：技能探针', skills: 'office-xlsx' })
			assert.equal(edited.status, 200, JSON.stringify(edited.payload).slice(0, 300))
			assert.match(readRole(), /^skills: office-xlsx$/m, '编辑要能改这一行')

			// ③ 编辑给空串 ⇒ 那一行删掉（"这个角色没有专属技能"）
			const cleared = await callWrite({ role: 'skill-probe', title: '技能探针', positioning: '一句话定位：技能探针', skills: '' })
			assert.equal(cleared.status, 200, JSON.stringify(cleared.payload).slice(0, 300))
			assert.ok(!/^skills:/m.test(readRole()), '空串＝清掉那一行')

			// ④ **不给 skills ⇒ 一个字都不碰**（面板没带这一格时，不许把人家声明的技能抹掉）
			const restored = await callWrite({ role: 'skill-probe', title: '技能探针', positioning: '一句话定位：技能探针', skills: 'brand' })
			assert.equal(restored.status, 200, JSON.stringify(restored.payload).slice(0, 300))
			const renamed = await callWrite({ role: 'skill-probe', title: '技能探针二号', positioning: '一句话定位：技能探针' })
			assert.equal(renamed.status, 200, JSON.stringify(renamed.payload).slice(0, 300))
			assert.match(readRole(), /^skills: brand$/m, '没给 skills 就不许动这一行')
			assert.match(readRole(), /^# 技能探针二号（skill-probe）$/m, '同一次调用里给出来的那几格照旧要落')

			// ⑤ 只给 skills 这一格也算"给了一格"（不再被"至少给一格"那条闸拦下）
			const skillsOnly = await callWrite({ role: 'skill-probe', skills: 'qa-playbooks' })
			assert.equal(skillsOnly.status, 200, JSON.stringify(skillsOnly.payload).slice(0, 300))
			assert.match(readRole(), /^skills: qa-playbooks$/m)
		} finally {
			if (previousRolesRoot === undefined) delete process.env.DSH_TEAM_OPS_ROLES
			else process.env.DSH_TEAM_OPS_ROLES = previousRolesRoot
		}
	})
})


describe('里程碑清单：phase 取值域的解析与只读端点', () => {
	const makeCtx = () => ({ fs: makeFs(), get: () => undefined, logger: { warn() {} } })

	test('解析：表头与分隔行挡掉、缺格留空、Markdown 装饰剥掉、认不出就空数组', () => {
		const { parseMilestones } = gate
		const text = [
			'# 里程碑清单（可交付节点）',
			'',
			'| 编号 | 名称 | 出口准则 | 依赖 | 状态 |',
			'|:--|:--|:--|:--|:--|',
			'| `M-1` | **能力评估交付** | 评估报告落盘 `docs/team/reports/x.md` | — | 已达成 |',
			'| M-2 | 高优先缺陷修复 | 逐条修完 | M-1 | 进行中 |',
			'| `M-3` | 只有三格 | 出口准则在这 |', // 缺后两格：留空，不当错误
			'',
			'> 取值说明：phase 取本清单的节点编号（形如 `M-1`）。',
		].join('\n')
		const rows = parseMilestones(text)
		assert.deepEqual(rows.map((row) => row.code), ['M-1', 'M-2', 'M-3'], '表头与分隔行不进结果')
		assert.equal(rows[0].name, '能力评估交付', '粗体剥掉')
		assert.equal(rows[0].exit, '评估报告落盘 docs/team/reports/x.md', '行内代码剥掉')
		assert.equal(rows[0].status, '已达成')
		assert.deepEqual([rows[2].deps, rows[2].status], ['', ''], '缺格留空')
		assert.deepEqual(parseMilestones('看起来不像一张表\n随便几句话'), [], '认不出就是空数组，不臆造')
		assert.deepEqual(parseMilestones(undefined), [], '非字符串也安全')
	})

	test('端点：清单在 ⇒ 解析后的行；不在 ⇒ exists:false + 一句说明（不是 404、也不是"零个里程碑"）', async () => {
		const { handleMilestones, MILESTONE_FILE } = await import('../lib/board-view.host.js')
		const read = async (root) => {
			const { res, captured } = makeRes()
			await handleMilestones(makeCtx(), { method: 'GET', url: `/company-board/api/milestones?workspace=${encodeURIComponent(root)}` }, res, null)
			return { status: captured.status, payload: JSON.parse(captured.body) }
		}
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-milestones-'))
		const absent = await read(workspace)
		assert.equal(absent.status, 200, JSON.stringify(absent.payload))
		assert.equal(absent.payload.exists, false)
		assert.deepEqual(absent.payload.rows, [])
		assert.equal(absent.payload.path, join(workspace, MILESTONE_FILE))
		assert.match(absent.payload.warnings[0], /还没建立/)
		// 建一份清单再读：行数与内容都对得上（同一个解析）。
		mkdirSync(join(workspace, 'docs/team'), { recursive: true })
		writeFileSync(join(workspace, MILESTONE_FILE), '| 编号 | 名称 | 出口准则 | 依赖 | 状态 |\n|:--|:--|:--|:--|:--|\n| `M-9` | 第九批 | 出口 | — | 进行中 |\n')
		const present = await read(workspace)
		assert.equal(present.status, 200)
		assert.equal(present.payload.exists, true)
		assert.deepEqual(present.payload.rows.map((row) => [row.code, row.name, row.status]), [['M-9', '第九批', '进行中']])
		// 文件在但一行都没认出来：如实告警，不臆造。
		writeFileSync(join(workspace, MILESTONE_FILE), '这文件被人改成散文了\n')
		const unrecognized = await read(workspace)
		assert.equal(unrecognized.status, 200)
		assert.deepEqual(unrecognized.payload.rows, [])
		assert.ok(unrecognized.payload.warnings.some((line) => line.includes('没认出任何一行表格')), JSON.stringify(unrecognized.payload.warnings))
		// 500/503 之外的形态：POST 一律 405（只读）。
		const { res, captured } = makeRes()
		await handleMilestones(makeCtx(), { method: 'POST', url: `/company-board/api/milestones?workspace=${encodeURIComponent(workspace)}` }, res, null)
		assert.equal(captured.status, 405)
	})
})

describe('技能的写入口（面板「技能」块那三个动作）', () => {
	// 写只落在**可写的两类根**上：用户级 `$DSH_HOME/skills` 与项目级 `<工作区>/.dsh/skills`。
	// 判定与 fs 的唯一实现是 `lib/skill-write.js`，这里走的是真端点（转发 + 回显）。
	const makeRes = () => ({ captured: { status: null, body: '' }, res: null })
	const responder = (captured) => ({ writeHead(status) { captured.status = status }, end(body) { captured.body = body ?? '' } })
	const makeReq = (method, url, body) => ({
		method,
		url,
		on(event, handler) {
			if (body === undefined) return
			if (event === 'data') handler(Buffer.from(JSON.stringify(body)))
			if (event === 'end') handler()
		},
	})
	/** 每个用例一个自己的 DSH_HOME（用户级技能根），跑完还原。 */
	const withHome = async (fn) => {
		const home = mkdtempSync(join(tmpdir(), 'team-ops-skillhome-'))
		const previous = process.env.DSH_HOME
		process.env.DSH_HOME = home
		try {
			await fn(home)
		} finally {
			if (previous === undefined) delete process.env.DSH_HOME
			else process.env.DSH_HOME = previous
		}
	}
	const write = async (action, body, url = '/company-board/api/skills/' + action, registered = []) => {
		const { handleSkillWrite } = await import('../lib/board-view.host.js')
		const { captured, res } = makeRes()
		// 假 ctx 照真宿主提供这两样：`fs`（写侧与读侧同一套存在性判定要用）与工作区注册表
		// （写侧边界要求"请求给的路径必须是已知工作区"—— 不给注册表就等于把合法路径挡掉）。
		const ctx = {
			fs: makeFs(),
			get: (name) => (name === 'workspaceRegistry' ? { list: () => registered.map((path, index) => ({ id: 'w' + index, path })) } : undefined),
		}
		await handleSkillWrite(ctx, makeReq('POST', url, body), responder(captured), null, action)
		return { status: captured.status, payload: JSON.parse(captured.body), res }
	}

	test('新建：落 SKILL.md（带 front-matter）；重名拒绝；只认 POST', async () => {
		await withHome(async (home) => {
			const made = await write('create', { root: 'user', name: 'qa-playbook', description: 'Use when 测。', body: '# QA 手册\n\n正文。' })
			assert.equal(made.status, 200, made.payload.error)
			assert.equal(made.payload.root, join(home, 'skills'))
			const file = join(home, 'skills', 'qa-playbook', 'SKILL.md')
			assert.ok(existsSync(file), 'SKILL.md 要落盘')
			const text = readFileSync(file, 'utf8')
			assert.match(text, /^---\nname: qa-playbook\nversion: 1\.0\.0\ndescription: Use when 测。\n---\n/, 'front-matter 的形状')
			assert.ok(text.includes('# QA 手册'), '正文在')
			// **只增不改**：重名一律拒绝
			const again = await write('create', { root: 'user', name: 'qa-playbook', description: 'x', body: 'y' })
			assert.equal(again.status, 400)
			assert.match(again.payload.error, /已存在/)
			// 形状不对 / 空正文
			assert.equal((await write('create', { root: 'user', name: 'Bad Name', body: 'x' })).status, 400)
			assert.equal((await write('create', { root: 'user', name: 'ok-name', body: ' ' })).status, 400)
			// 只认 POST（GET 走同一条函数）
			const { handleSkillWrite } = await import('../lib/board-view.host.js')
			const { captured } = makeRes()
			await handleSkillWrite({}, { method: 'GET', url: '/company-board/api/skills/create', on() {} }, responder(captured), null, 'create')
			assert.equal(captured.status, 405)
		})
	})

	test('导入：从本机目录复制（跳过点文件）、单文件落成 SKILL.md、重名拒绝、体量超限拒绝', async () => {
		await withHome(async (home) => {
			const src = mkdtempSync(join(tmpdir(), 'team-ops-skillsrc-'))
			mkdirSync(join(src, 'my-playbook', 'references'), { recursive: true })
			writeFileSync(join(src, 'my-playbook', 'SKILL.md'), '---\nname: my-playbook\n---\n\n# 我的手册\n')
			writeFileSync(join(src, 'my-playbook', 'references', 'deep.md'), '细节\n')
			writeFileSync(join(src, 'my-playbook', '.DS_Store'), 'junk\n')
			const made = await write('import', { root: 'user', source: join(src, 'my-playbook') })
			assert.equal(made.status, 200, made.payload.error)
			assert.equal(made.payload.id, 'my-playbook')
			assert.ok(existsSync(join(home, 'skills', 'my-playbook', 'references', 'deep.md')), '整棵目录复制过来')
			assert.ok(!existsSync(join(home, 'skills', 'my-playbook', '.DS_Store')), '点文件不带过来')
			// 单文件 ⇒ 落成 `<name>/SKILL.md`
			writeFileSync(join(src, 'one-off.md'), '# 单文件\n')
			const single = await write('import', { root: 'user', source: join(src, 'one-off.md') })
			assert.equal(single.status, 200, single.payload.error)
			assert.ok(existsSync(join(home, 'skills', 'one-off', 'SKILL.md')))
			// 来源读不到 / 不像技能 / 重名
			assert.equal((await write('import', { root: 'user', source: join(src, 'nope') })).status, 400)
			mkdirSync(join(src, 'not-a-skill'))
			const notSkill = await write('import', { root: 'user', source: join(src, 'not-a-skill') })
			assert.equal(notSkill.status, 400)
			assert.match(notSkill.payload.error, /没有 SKILL\.md/)
			assert.equal((await write('import', { root: 'user', source: join(src, 'my-playbook') })).status, 400)
		})
	})

	test('请求体超限：回一个**能读的 413**，不掐连接（整文件夹导入曾因此只看到 "Failed to fetch"）', async () => {
		await withHome(async (home) => {
			// ① 通用上限（64 KB）被超：从前 `readBody` 会 `req.destroy()` ⇒ 浏览器只看到 TypeError: Failed to fetch。
			// 现在读干净、回 413 + 一句人能照做的中文。
			const { handleRoleWrite } = await import('../lib/board-view.host.js')
			const big = { id: 'x', prompt: 'a'.repeat(70 * 1024) }
			const { captured, res } = makeRes()
			// 假 ctx 照真宿主给 `fs` 与工作区注册表：写侧边界（请求给的工作区必须是已知工作区）在**读体之前**判，
			// 少给这两样就会先撞在边界上、看不到 413。
			const boundaryCtx = {
				fs: makeFs(),
				logger: { warn() {} },
				get: (name) => (name === 'workspaceRegistry' ? { list: () => [{ id: 'w1', path: home }] } : undefined),
			}
			await handleRoleWrite(boundaryCtx, makeReq('POST', '/company-board/api/roles/update?workspace=' + encodeURIComponent(home), big), responder(captured), null, 'update')
			assert.equal(captured.status, 413, '超限要回 413（别掐连接）：' + captured.body)
			const payload = JSON.parse(captured.body)
			assert.match(payload.error, /请求体过大/, payload.error)
			assert.match(payload.error, /上限 64 KB/, '上限要说出来：' + payload.error)
			// ② 技能导入那条路有**自己的大上限**（4 MB 文件 ⇒ base64 约 5.4 MB，64 KB 撑不住）
			const host = readFileSync('lib/board-view.host.js', 'utf8')
			assert.match(host, /const SKILL_IMPORT_BODY_LIMIT = 8 \* 1024 \* 1024/, '导入的请求体上限 8 MB')
			assert.match(host, /body = JSON\.parse\(await readBody\(req, SKILL_IMPORT_BODY_LIMIT\)\)/, '导入那条读体用这个大上限')
			assert.match(host, /bodyError\(res, error, SKILL_IMPORT_BODY_LIMIT\)/, '导入超限也走同一个回执')
			// ③ 读体的实现里**不许再掐连接**（那正是"失败到没有原因"的来源）——只扫代码行，注释里提到它不算。
			const codeLines = host.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
			assert.ok(!codeLines.some((line) => line.includes('req.destroy()')), '读体不许掐连接')
			assert.match(host, /error\.code = 'BODY_TOO_LARGE'/, '超限要给一个可判别的错误码')
		})
	})

	test('拖进来的一批文件（拖拽那条通道）：文件夹取 front-matter 的 name、单个 SKILL.md 取给的名字、越界与缺 SKILL.md 都拒', async () => {
		await withHome(async (home) => {
			const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
			const skill = '---\nname: my-dropped-skill\ndescription: Use when 拖进来的。\n---\n\n# 拖进来的\n\n正文。\n'
			// ① 拖一个文件夹（每条路径以文件夹名开头 ⇒ 宿主去掉公共前缀）
			const folder = await write('import', {
				root: 'user',
				name: 'dropped-folder',
				files: [
					{ path: 'dropped-folder/SKILL.md', dataBase64: b64(skill) },
					{ path: 'dropped-folder/references/deep.md', dataBase64: b64('细节\n') },
				],
			})
			assert.equal(folder.status, 200, folder.payload.error)
			assert.equal(folder.payload.id, 'my-dropped-skill', '技能名取 SKILL.md 里 front-matter 的 name')
			assert.ok(existsSync(join(home, 'skills', 'my-dropped-skill', 'references', 'deep.md')), '整批落盘')
			const written = readFileSync(join(home, 'skills', 'my-dropped-skill', 'SKILL.md'), 'utf8')
			assert.ok(written.includes('# 拖进来的'), '内容原样')
			// ② 单个 SKILL.md（没有 front-matter ⇒ 用面板算出来的那个名字）
			const single = await write('import', { root: 'user', name: 'plain-one', files: [{ path: 'SKILL.md', dataBase64: b64('# 无 front-matter\n') }] })
			assert.equal(single.status, 200, single.payload.error)
			assert.equal(single.payload.id, 'plain-one')
			// ③ 没有 SKILL.md / 越界 / 名字用不了 / 一批为空
			const noSkill = await write('import', { root: 'user', name: 'x', files: [{ path: 'x/README.md', dataBase64: b64('x') }] })
			assert.equal(noSkill.status, 400)
			assert.match(noSkill.payload.error, /没有 SKILL\.md/)
			const traversal = await write('import', { root: 'user', name: 'x', files: [{ path: '../evil/SKILL.md', dataBase64: b64(skill) }] })
			assert.equal(traversal.status, 400)
			assert.match(traversal.payload.error, /越界/)
			const empty = await write('import', { root: 'user', files: [] })
			assert.equal(empty.status, 400)
			assert.match(empty.payload.error, /没拿到文件/)
			// ④ 路径那条通道**照旧**能用（两条输入形状并存）
			const src = mkdtempSync(join(tmpdir(), 'team-ops-skillsrc3-'))
			mkdirSync(join(src, 'by-path'), { recursive: true })
			writeFileSync(join(src, 'by-path', 'SKILL.md'), '# 从路径来的\n')
			const byPath = await write('import', { root: 'user', source: join(src, 'by-path') })
			assert.equal(byPath.status, 200, byPath.payload.error)
			assert.ok(existsSync(join(home, 'skills', 'by-path', 'SKILL.md')))
		})
	})

	test('项目级根：要工作区（否则 503），给了就落在 <工作区>/.dsh/skills', async () => {
		await withHome(async () => {
			const workspace = mkdtempSync(join(tmpdir(), 'team-ops-skillws-'))
			const src = mkdtempSync(join(tmpdir(), 'team-ops-skillsrc2-'))
			mkdirSync(join(src, 'proj-skill'), { recursive: true })
			writeFileSync(join(src, 'proj-skill', 'SKILL.md'), '# 项目技能\n')
			const noWs = await write('import', { root: 'project', source: join(src, 'proj-skill') })
			assert.equal(noWs.status, 503, noWs.payload.error)
			const withWs = await write('import', { root: 'project', source: join(src, 'proj-skill') }, `/company-board/api/skills/import?workspace=${encodeURIComponent(workspace)}`, [workspace])
			assert.equal(withWs.status, 200, withWs.payload.error)
			assert.ok(existsSync(join(workspace, '.dsh', 'skills', 'proj-skill', 'SKILL.md')), '落在项目根')
		})
	})

	test('删除：只删可写根里的那一棵；越界与只读根一律拒绝', async () => {
		await withHome(async (home) => {
			await write('create', { root: 'user', name: 'bye-skill', body: '# 再见\n' })
			assert.ok(existsSync(join(home, 'skills', 'bye-skill')))
			const removed = await write('remove', { root: 'user', name: 'bye-skill' })
			assert.equal(removed.status, 200, removed.payload.error)
			assert.ok(!existsSync(join(home, 'skills', 'bye-skill')), '目录没了')
			// 不存在 / 越界 / 只读根
			assert.equal((await write('remove', { root: 'user', name: 'bye-skill' })).status, 400)
			assert.equal((await write('remove', { root: 'user', name: '../evil' })).status, 400)
			const readonly = await write('remove', { root: 'bundled', name: 'whatever' })
			assert.equal(readonly.status, 400)
			assert.match(readonly.payload.error, /只支持 user \/ project|技能根不认/)
		})
	})
})

describe('面板的角色端点', () => {
	const makeCtx = () => ({ fs: makeFs(), get: () => undefined, logger: { warn() {} } })
	/** 造一个请求；`url` 里带 workspace，body 为 JSON。 */
	const makeReq = (method, url, body) => ({
		method,
		url,
		on(event, handler) {
			if (body === undefined) return
			if (event === 'data') handler(Buffer.from(JSON.stringify(body)))
			if (event === 'end') handler()
		},
	})

	test('GET /roles ⇒ 包内那批角色都在 + 计数对得上；POST ⇒ 405', async () => {
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-rolesapi-'))
		const { handleRoles } = await import('../lib/board-view.host.js')
		const { res, captured } = makeRes()
		await handleRoles(makeCtx(), makeReq('GET', `/company-board/api/roles?workspace=${encodeURIComponent(workspace)}`), res, null)
		const payload = JSON.parse(captured.body)
		assert.equal(captured.status, 200, captured.body)
		// **不写死个数**：名册 = 包内那批 ∪ 用户角色根里那些。写死 20 就会在"用户根里多一个/少一个"时假红
		//（本机刚把 `ontology` 归档到角色根之外 ⇒ 20 变 19，这条当场红）。判据用"包内那批一个不少"。
		const packaged = readdirSync('team/roles').filter((name) => existsSync(join('team/roles', name, 'ROLE.md')))
		assert.equal(payload.roles.length, payload.counts.all, '计数与卡片数要对得上：' + captured.body.slice(0, 120))
		for (const id of packaged) assert.ok(payload.roles.some((role) => role.id === id), '包内角色缺了：' + id)
		assert.ok(payload.roles.length >= packaged.length, '名册不该少于包内那批')
		assert.equal(payload.counts.disabled, 0)
		assert.equal(payload.roles.find((role) => role.id === 'reviewer').title, '评审员')
		assert.equal(payload.roles.find((role) => role.id === 'reviewer').category, '质量')
		const { res: res2, captured: cap2 } = makeRes()
		await handleRoles(makeCtx(), makeReq('POST', '/company-board/api/roles'), res2, null)
		assert.equal(cap2.status, 405)
	})

	test('角色定义原文：正常读到；缺 role 400；未知 / 越权角色 404（路径不由请求拼）', async () => {
		const { handleRoleDefinition } = await import('../lib/board-view.host.js')
		const read = async (query) => {
			const { res, captured } = makeRes()
			await handleRoleDefinition(makeCtx(), makeReq('GET', `/company-board/api/roles/definition${query}`), res, null)
			return { status: captured.status, payload: JSON.parse(captured.body) }
		}
		const ok = await read('?role=reviewer')
		assert.equal(ok.status, 200, JSON.stringify(ok.payload).slice(0, 120))
		assert.match(ok.payload.text, /^---\nkind: role\nname: reviewer/m)
		assert.equal((await read('')).status, 400)
		assert.equal((await read('?role=../../etc/passwd')).status, 404)
	})

	test('写侧边界：请求给的工作区必须是已知工作区（不在清单里一律拒，且不留一个字节）', async () => {
		// 读侧只读工作区里三个固定文件名，所以"路径按请求给"可以；写侧会落盘 —— 边界若也跟着请求走，
		// 就不是栅栏而是自我授权。这条用例钉住：不在已知清单里的路径，写端点一律拒。
		const { handleRoleWrite } = await import('../lib/board-view.host.js')
		const known = mkdtempSync(join(tmpdir(), 'team-ops-bound-known-'))
		const other = mkdtempSync(join(tmpdir(), 'team-ops-bound-other-'))
		const ctx = {
			fs: makeFs(),
			logger: { warn() {} },
			get: (name) => (name === 'workspaceRegistry' ? { list: () => [{ id: 'w1', path: known }] } : undefined),
		}
		const post = async (workspace) => {
			const { res, captured } = makeRes()
			await handleRoleWrite(
				ctx,
				makeReq('POST', `/company-board/api/roles/update?workspace=${encodeURIComponent(workspace)}`, { id: 'probe-role', positioning: '一句话定位' }),
				res,
				null,
				'update',
			)
			return { status: captured.status, payload: JSON.parse(captured.body) }
		}
		const outside = await post(other)
		assert.equal(outside.status, 403, '不在已知清单里的工作区要被拒：' + JSON.stringify(outside.payload).slice(0, 200))
		assert.ok(!existsSync(join(other, '.company-gate.roles.json')), '被拒的请求不许在工作区里落任何文件')
		assert.equal((await post(join(other, '不存在'))).status, 404, '不存在的路径照实报 404（别混进 403）')
		const filePath = join(other, 'a-file.txt')
		writeFileSync(filePath, 'x')
		assert.equal((await post(filePath)).status, 400, '不是目录 ⇒ 400')
		// 已知的那个照旧放行：工作区里还没有名册文件 ⇒ 由引擎报错，不是被边界拦
		const inside = await post(known)
		assert.notEqual(inside.status, 403, '已知工作区不许被边界拒：' + JSON.stringify(inside.payload).slice(0, 200))
		// **链接形式的 workspace**：真身在已知清单里 ⇒ 要放行（按路径字符串比会误伤，现场实测过）；
		// 链接指向清单之外的目录 ⇒ 仍然拒（别名不是通行证）。
		const holder = mkdtempSync(join(tmpdir(), 'team-ops-alias-'))
		const alias = join(holder, 'ws-link')
		symlinkSync(known, alias)
		const aliasOk = await post(alias)
		assert.notEqual(aliasOk.status, 403, '真身在清单里的链接要放行：' + JSON.stringify(aliasOk.payload).slice(0, 160))
		const stray = mkdtempSync(join(tmpdir(), 'team-ops-alias-out-'))
		const strayAlias = join(holder, 'ws-link2')
		symlinkSync(stray, strayAlias)
		assert.equal((await post(strayAlias)).status, 403, '链接到清单之外的目录仍然要拒')

		// **枚举不到任何已知工作区**时不许拦（否则宿主少一个服务就变成"你的路径非法"）
		const blind = { fs: makeFs(), logger: { warn() {} }, get: () => undefined }
		const { res: res3, captured: cap3 } = makeRes()
		await handleRoleWrite(blind, makeReq('POST', `/company-board/api/roles/update?workspace=${encodeURIComponent(other)}`, { id: 'probe-role', positioning: '一句话定位' }), res3, null, 'update')
		assert.notEqual(cap3.status, 403, '判不了的时候不许当成非法：' + cap3.body.slice(0, 160))
	})

	test('开关：POST 落到工作区文件；坏角色 409', async () => {
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-roletoggle-'))
		const { handleRoleToggle } = await import('../lib/board-view.host.js')
		const post = async (body) => {
			const { res, captured } = makeRes()
			await handleRoleToggle(makeCtx(), makeReq('POST', `/company-board/api/roles/toggle?workspace=${encodeURIComponent(workspace)}`, body), res, null)
			return { status: captured.status, payload: JSON.parse(captured.body) }
		}
		const off = await post({ role: 'legal', enabled: false })
		assert.equal(off.status, 200, JSON.stringify(off.payload))
		assert.equal(off.payload.enabled, false)
		assert.equal(off.payload.actor, 'human', '面板这条写路径的决定人固定为 human')
		assert.deepEqual(JSON.parse(readFileSync(join(workspace, '.company-gate.roles.json'), 'utf8')).disabled, ['legal'])
		const bad = await post({ role: 'nope', enabled: false })
		assert.equal(bad.status, 409)
		assert.match(bad.payload.error, /不在现场名册里/)
	})

	test('复制为自定义：缺省落**工作区**角色根（显式 scope=user 才落用户根）；重名往后加序号', async () => {
		const userRoot = mkdtempSync(join(tmpdir(), 'team-ops-rolecustom-'))
		const previous = process.env.DSH_TEAM_OPS_ROLES
		process.env.DSH_TEAM_OPS_ROLES = userRoot
		try {
			const { handleRoleCustomize } = await import('../lib/board-view.host.js')
			const workspace = mkdtempSync(join(tmpdir(), 'team-ops-rolecustom-ws-'))
			const post = async (body = { role: 'architect' }) => {
				const { res, captured } = makeRes()
				await handleRoleCustomize(makeCtx(), makeReq('POST', `/company-board/api/roles/customize?workspace=${encodeURIComponent(workspace)}`, body), res, null)
				return { status: captured.status, payload: JSON.parse(captured.body) }
			}
			const first = await post()
			assert.equal(first.status, 200, JSON.stringify(first.payload))
			assert.equal(first.payload.id, 'architect-custom')
			// 字段名收干净：不再用把「能不能用」挂在重启上的 `restartRequired`，改说"注入清单这颗快照旧了"
			assert.equal(first.payload.promptRoster, 'stale')
			assert.match(first.payload.promptRosterNote, /立刻可用/)
			assert.match(first.payload.promptRosterNote, /装载时的快照/)
			assert.match(first.payload.file, /architect-custom\/ROLE\.md$/, '角色定义落在角色根，文件名是 ROLE.md')
			assert.equal(first.payload.scope, 'workspace', '缺省作用域是工作区：' + JSON.stringify(first.payload.scope))
			assert.match(String(first.payload.file), /\.dsh\/team-ops\/roles\//, '缺省落工作区角色根：' + String(first.payload.file))
			assert.match(readFileSync(first.payload.file, 'utf8'), /derived_from: architect/)
			const second = await post()
			assert.equal(second.payload.id, 'architect-custom-2')
			// **显式 scope=user 才落用户根**（同名序号只在那个根里看）
			const inUser = await post({ role: 'architect', scope: 'user' })
			assert.equal(inUser.status, 200, JSON.stringify(inUser.payload))
			assert.equal(inUser.payload.scope, 'user')
			assert.equal(inUser.payload.id, 'architect-custom', '用户根里还没有它 ⇒ 序号从头开始')
			assert.match(String(inUser.payload.file), new RegExp(String(userRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
		} finally {
			if (previous === undefined) delete process.env.DSH_TEAM_OPS_ROLES
			else process.env.DSH_TEAM_OPS_ROLES = previous
		}
	})

	test('POST /roles/update|remove|restore：添加缺省写**工作区**根（显式 scope=user 才写用户根）、包内只能下架、动词由服务端给', async () => {
		const root = mkdtempSync(join(tmpdir(), 'team-ops-roleswrite-'))
		const previous = process.env.DSH_TEAM_OPS_ROLES
		process.env.DSH_TEAM_OPS_ROLES = root
		try {
			const workspace = mkdtempSync(join(tmpdir(), 'team-ops-roleswrite-ws-'))
			const { handleRoleWrite } = await import('../lib/board-view.host.js')
			const post = async (path, body) => {
				const { res, captured } = makeRes()
				await handleRoleWrite(makeCtx(), makeReq('POST', `/company-board/api${path}?workspace=${encodeURIComponent(workspace)}`, body), res, null, path.replace('/roles/', ''))
				return { status: captured.status, payload: JSON.parse(captured.body) }
			}
			// ① 添加：写用户角色根里的 `ROLE.md`。
			const created = await post('/roles/update', { id: 'data-label', title: '数据标注', category: '数据', positioning: '对标注质量与一致性负责。' })
			assert.equal(created.status, 200, JSON.stringify(created.payload))
			assert.equal(created.payload.role, 'data-label')
			// 字段名说的是"注入清单这颗快照旧了"，**不是**"工具面不能用"：`member_defaults` / `member_spawn`
			// 现枚举，建完立刻可用。
			assert.equal(created.payload.promptRoster, 'stale', '引擎回执带 promptRoster: stale')
			assert.match(created.payload.promptRosterNote, /立刻可用/)
			assert.match(created.payload.promptRosterNote, /不影响/)
			// **缺省落工作区根**（HD-008）：文件在 `<工作区>/.dsh/team-ops/roles/`，**不在**用户根
			assert.equal(readFileSync(join(workspace, '.dsh', 'team-ops', 'roles', 'data-label', 'ROLE.md'), 'utf8').includes('name: data-label'), true)
			assert.ok(!existsSync(join(root, 'data-label')), '缺省不许写用户根')
			assert.equal(created.payload.scope, 'workspace')
			assert.match(String(created.payload.scopeLine), /只有这个工作区看得见/)
			// **显式 scope=user 才写用户根**（同一个 id：两个作用域互不覆盖）
			const inUser = await post('/roles/update', { id: 'data-label', title: '全局那份', positioning: '全局。', scope: 'user' })
			assert.equal(inUser.status, 200, JSON.stringify(inUser.payload))
			assert.equal(inUser.payload.scope, 'user')
			assert.equal(readFileSync(join(root, 'data-label', 'ROLE.md'), 'utf8').includes('name: data-label'), true, '显式 user ⇒ 落用户根')
			// ② 缺 id 又缺 role：400（说清要哪一个）。
			const bad = await post('/roles/update', { title: 'x' })
			assert.equal(bad.status, 400)
			assert.match(bad.payload.error, /要 id/)
			// ③ 同名再添加：409 + 引擎的原文（要改请用修改）。
			const dup = await post('/roles/update', { id: 'data-label', positioning: 'y' })
			assert.equal(dup.status, 409)
			assert.match(dup.payload.error, /已经在本工作区的角色根里/)
			// ④ 修改：给 role 就是改，改的是那三格。
			const edited = await post('/roles/update', { role: 'data-label', title: '数据标注员' })
			assert.equal(edited.status, 200, JSON.stringify(edited.payload))
			assert.equal(edited.payload.shadowed, false)
			// **就地改**：工作区那份改了；同一 id 的用户根那份**不受影响**（两个作用域互不覆盖）
			assert.ok(readFileSync(join(workspace, '.dsh', 'team-ops', 'roles', 'data-label', 'ROLE.md'), 'utf8').includes('# 数据标注员（data-label）'))
			assert.ok(!readFileSync(join(root, 'data-label', 'ROLE.md'), 'utf8').includes('# 数据标注员（data-label）'), '用户根那份不许被这次修改动到')
			// ⑤ 删一个只在包内的角色：下架（工作区文件），回执说 `hide`。
			const hidden = await post('/roles/remove', { role: 'ceo' })
			assert.equal(hidden.status, 200, JSON.stringify(hidden.payload))
			assert.equal(hidden.payload.mode, 'hide')
			assert.deepEqual(hidden.payload.hidden, ['ceo'])
			assert.equal(existsSync(join(runtime.roleDefinitionOf('ceo').file)), true, '包内文件不动')
			// ⑥ 缺 role 的删：400。
			const noRole = await post('/roles/remove', {})
			assert.equal(noRole.status, 400)
			// ⑦ 恢复上架。
			const restored = await post('/roles/restore', { role: 'ceo' })
			assert.equal(restored.status, 200)
			assert.deepEqual(restored.payload.hidden, [])
			// ⑧ GET 一律 405（改状态的动作用 POST）。
			const { res, captured } = makeRes()
			await handleRoleWrite(makeCtx(), makeReq('GET', `/company-board/api/roles/update?workspace=${encodeURIComponent(workspace)}`), res, null, 'update')
			assert.equal(captured.status, 405)
		} finally {
			if (previous === undefined) delete process.env.DSH_TEAM_OPS_ROLES
			else process.env.DSH_TEAM_OPS_ROLES = previous
		}
	})

	test('头像：角色目录里放了 avatar.svg 就照原样给字节；没有就 404', async () => {
		const userRoot = mkdtempSync(join(tmpdir(), 'team-ops-roleavatar-'))
		mkdirSync(join(userRoot, 'painted'), { recursive: true })
		writeFileSync(join(userRoot, 'painted', 'ROLE.md'), '---\nname: painted\nversion: 1.0.0\ncategory: 设计\ndescription: Use when 贴图试验。\n---\n\n# 画师（painted）\n\n给测试用。\n')
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#333"/></svg>'
		writeFileSync(join(userRoot, 'painted', 'avatar.svg'), svg)
		const previous = process.env.DSH_TEAM_OPS_ROLES
		process.env.DSH_TEAM_OPS_ROLES = userRoot
		try {
			const { handleRoleAvatar } = await import('../lib/board-view.host.js')
			const read = async (role) => {
				const { res, captured } = makeRes()
				captured.headers = {}
				await handleRoleAvatar(makeCtx(), makeReq('GET', `/company-board/api/roles/avatar?role=${encodeURIComponent(role)}`), res, null)
				return captured
			}
			const hit = await read('painted')
			assert.equal(hit.status, 200, hit.body)
			assert.equal(hit.headers['content-type'], 'image/svg+xml')
			assert.equal(Buffer.from(hit.body).toString('utf8'), svg, '字节原样给，不重编码')
			const miss = await read('reviewer')
			assert.equal(miss.status, 404)
		} finally {
			if (previous === undefined) delete process.env.DSH_TEAM_OPS_ROLES
			else process.env.DSH_TEAM_OPS_ROLES = previous
		}
	})
})


// ── 视图栏五块：座位契约、跨半边端点对齐、跨半边字段契约、技能目录只读面 ────────────
//
// 这一栏是**一个席位、五块**（成员 / 技能 / 任务看板 / 审批文件 / 共识轮次）。
// 四件最容易在"改一边忘另一边"时静默坏掉的事，各一条自检盯着：
// ① 席位还挂着、块表里那两块还在、且**没有**再长出「角色」那一块；
// ② 客户端那几个端点常量与 host half 导出的路径**逐字相等**（错一个字符就是 404，那一块全空）；
// ③ 页面读过的每个字段名，端点载荷里真的都在（少一个就是"那一格永远是空的"，不报错）；
// ④ 技能那一块的两条只读端点：服务不在是"读不到"（503 点名），不是"一个技能都没有"。

describe('一个浮层只有一条滚动条', () => {
	// 人的现场：输入框那个角色选择框里**两根滚动条**。根因是外层浮层与内层列表各自 `overflow-y:auto`。
	// 同一类毛病还有浮窗里的 `.cbv-pre`（成员提示词 / 技能正文那块）在已经会滚的 `.cbv-modal-body` 里又滚。
	// 规矩就一条：**滚动发生在包含头部（搜索框 / 弹窗标题）的那一层**，里面任何块都不自己滚。
	test('选择框：滚的是浮层，列表不滚', () => {
		const source = readFileSync('lib/board-view.client.js', 'utf8')
		assert.match(source, /\.cbv-rolepick-pop\{[^}]*overflow-y:auto/, '外层浮层是那条滚动容器（搜索框要吸顶就得挂在这一层）')
		assert.match(source, /\.cbv-rolepick-pop\{[^}]*max-height:min\(46vh,360px\)/, '浮层自己限高')
		assert.match(source, /\.cbv-picker\{margin-top:2px\}/, '内层列表不设 max-height / overflow')
		assert.ok(!/\.cbv-picker\{[^}]*overflow/.test(source), '内层列表不该再有 overflow')
		assert.ok(!/\.cbv-picker\{[^}]*max-height/.test(source), '内层列表不该再有限高')
	})

	test('浮窗：滚的是主体，里面的块不滚', () => {
		const source = readFileSync('lib/board-view.client.js', 'utf8')
		assert.match(source, /\.cbv-modal-body\{overflow-y:auto/, '浮窗主体是那条滚动容器')
		assert.ok(!/\.cbv-pre\{[^}]*overflow/.test(source), '`.cbv-pre`（提示词 / 技能正文）不该自己滚')
	})

	test('角色选择框里的列表渲染成一列（不是两个滚动容器）', () => {
		const source = readFileSync('lib/board-view.client.js', 'utf8')
		// 结构上也钉住：列表是浮层的**直接子块**，中间没有别的滚动容器。
		assert.match(source, /className: 'cbv-picker'/, '列表那个类还在（否则这条契约没意义）')
	})
})

describe('视图栏五块：席位、块表与端点对齐', () => {
	/** 客户端源码（静态面）：席位与块表都写在里面，不引第二份。 */
	const clientSource = () => readFileSync('lib/board-view.client.js', 'utf8')

	/** 客户端里 `const NAME = 'literal'` 的字面量。 */
	const literalOf = (source, name) => {
		const match = source.match(new RegExp(`const ${name} = '([^']*)'`))
		assert.ok(match !== null, `客户端里找不到 ${name} 的字面量`)
		return match[1]
	}

	/** 客户端里 `const NAME = <别的常量> + '<后缀>'` 的后缀。 */
	const suffixOf = (source, name) => {
		const match = source.match(new RegExp(`const ${name} = \\w+ \\+ '([^']*)'`))
		assert.ok(match !== null, `客户端里找不到 ${name} 的拼装式`)
		return match[1]
	}

	test('席位：只注册 conversation.view 那一栏；块表 = 成员/技能/三份文件，且角色那一块不再有', () => {
		const source = clientSource()
		assert.match(source, /ctx\.slots\.inject\('conversation\.view',/, '视图栏那一席还在')
		assert.ok(!source.includes("slots.inject('settings.section'"), '设置页那一席已按人的指令撤下（不两处出现同一份卡片）')
		// 块表：两块非文件 + 三份文件（SPECS 的 ledger 就是那三个）。
		assert.match(source, /const MEMBERS_BLOCK = \{ ledger: 'members', label: '成员', spec: null \}/)
		assert.match(source, /const SKILLS_BLOCK = \{ ledger: 'skills', label: '技能', spec: null \}/)
		assert.match(source, /const BLOCKS = \[MEMBERS_BLOCK, SKILLS_BLOCK\]\.concat\(SPECS\.map/)
		assert.ok(!source.includes('ROLES_BLOCK'), '「角色」那一块已经撤下（工具面 role_manage 仍在）')
		assert.match(source, /block\.ledger === 'members'[\s\S]{0,220}?block\.ledger === 'skills'[\s\S]{0,240}?block\.ledger === 'board'[\s\S]{0,220}?el\(TaskBoardView/, '五块按块表分派渲染（看板那一块走两个来源的 TaskBoardView）')
		// 包的客户端依赖：只要 ui-conversation（不再需要声明 settings 槽的那个包）。
		const injected = JSON.parse(readFileSync('package.json', 'utf8')).dsh.client.inject
		assert.deepEqual(injected, ['@deepseek-ai/dsh-client-ui-conversation'])
	})

	test('看板的栏：宽度固定（不再等分挤压）且整排横向可滑', () => {
		// 这一条钉的是**人的两条要求**（它们是纯 CSS，渲染自检看不见）：
		// ① 栏宽固定到可读的宽度（`flex:0 0 min(360px,92%)`）——等分会在窄栏里把每栏压成竖条；
		// ② 板子整排横滑（`.cbv-board` 上 `overflow-x:auto`）——原来写的是 `overflow-x:hidden`，
		// 放不下的栏直接看不见、也滑不到。
		const source = clientSource()
		assert.match(source, /\.cbv-board\{[^}]*overflow-x:auto/, '板子那一行要横向可滑')
		// 而且**要看得见**：macOS 覆盖式滚动条默认不显示，窄栏里第 4 栏被切断却没有任何提示。
		assert.match(source, /\.cbv-board\{-?[^}]*scrollbar-width:thin/, '横滚条要显式给出宽度')
		assert.match(source, /\.cbv-board::-webkit-scrollbar\{height:9px\}/, 'webkit 下也要给一条细的（不给色相）')
		assert.ok(!/\.cbv-board::-webkit-scrollbar-thumb\{[^}]*#[0-9a-f]/.test(source), '滚动条不许写死颜色')
		// 筛选行**定高**：两档的内容不一样（团队那档只有 chip，里程碑那档多一个下拉 + 搜索框），
		// 高度由内容撑时切换就会让 chip 上下跳（现场原话："切换还是感觉按钮上下浮动"）。
		assert.match(source, /\.cbv-flt-bar\{[^}]*flex-wrap:nowrap[^}]*height:34px/, '筛选行要定高、不换行')
		// **而且不许被压**（`flex:none`）：它在 `.cbv-view` 那条 flex 列里，`height` 不是硬下限 ——
		// 现场：团队那一档的 chip 被下面 `flex:1 1 auto` 的看板挤到只剩底部一两个像素。
		assert.match(source, /\.cbv-flt-bar\{[^}]*flex:none[^}]*height:34px/, '筛选行不许被压（flex:none）')
		// **状态行（名册路径 / 注解 / 告警）一律占满整行**：它们跟块标题是同级的读数列，
		// 不许并到标题那一行上（现场报过「名册 <路径>…」与「成员」在同一行）。
		for (const cls of ['cbv-pane-note', 'cbv-pane-meta', 'cbv-pane-warn']) {
			assert.match(source, new RegExp('\\.' + cls + '\\{[^}]*min-width:100%'), cls + ' 横向上要占满整行')
			// **不许用 `flex-basis:100%`**：在列方向它等于"占满高度"，会把整块撑出一大片空白（现场踩过）。
			assert.ok(!new RegExp('\\.' + cls + '\\{[^}]*flex-basis:100%').test(source), cls + ' 不许用 flex-basis:100%')
		}
		// **弹窗里的「确定 / 保存」与「取消」同一套样式**（人的指令：两边保持一致）——
		// 编辑弹窗的「保存」、技能写入口的「确定」、角色弹窗非删除那档，都不许再用 `--primary`（主按钮强调态）。
		// 破坏性动作（删除 / 下架）保留 `--bad`：那不是"确定"，是另一件事，要有别。
		assert.ok(!/className: 'cbv-btn cbv-btn--primary', key: 'save'/.test(source), '编辑弹窗的「保存」与「取消」同款')
		assert.ok(!/className: 'cbv-btn cbv-btn--primary', key: 'ok'/.test(source), '技能写入口的「确定」与「取消」同款')
		assert.match(source, /kind === 'remove' \? 'cbv-btn--bad' : ''/, '角色弹窗非删除那档不再用主按钮强调态')
		// 成员面整面撤掉之后，成员那一枚「删除确认」连弹窗一起没了：破坏性标记只该出现在角色那一档上
		// （上面那条）。这里正面钉"它没回来"。
		assert.ok(!source.includes('confirmDelete'), '成员删除确认那条路已经撤掉')
		assert.ok(!source.includes("key: 'delete'"), '卡上不该再有点删除的地方（成员那一栏只读）')

		// **按钮不许用没有样式的类**：导入 / 新建弹窗的底排曾经写成 `cbv-act` / `cbv-act--primary`，
		// 而这两个类**没有任何 CSS 规则** ⇒ 那两枚是浏览器默认按钮，跟弹窗格格不入。
		assert.ok(!/'cbv-act['"]/.test(source) && !source.includes('cbv-act--primary'), '底排按钮要走全仓通用的 cbv-btn（别再冒出没样式的类）')
		for (const cls of ["className: 'cbv-btn'", "className: 'cbv-btn cbv-btn--primary'"]) {
			assert.ok(source.includes(cls), '缺这个按钮类：' + cls)
		}
		// 但**里面那一簇 chip 不许被压缩**：窄面板时被挤成 0 宽 = 人看不到「里程碑 / 团队任务板」（现场报过）。
		assert.match(source, /\.cbv-flt-bar > \.cbv-badges\{flex:0 0 auto/, '来源分档那一簇 chip 不许被压缩')
		// 导入弹窗收窄（人的指令）+ 拖拽区高度翻倍（原来的两行 padding 撑出来约 88px ⇒ 现在下限 176px）。
		// **窄弹窗只有一处正文**：一个 `.cbv-modal--narrow` 类，写入口（导入 / 新建技能）与角色弹窗共用
		assert.match(source, /\.cbv-modal--narrow\{width:min\(520px,92vw\)/, '窄弹窗宽度只有这一处正文')
		assert.ok(source.includes("cbv-modal cbv-modal--skills cbv-modal--narrow"), '写入口两个弹窗都挂这个类（导入 / 新建同宽）')
		assert.ok(source.includes("narrow ? ' cbv-modal--narrow' : ''"), '共享外壳要按 narrow 开关挂类')
		// 带 `narrow: true` 的弹窗：**只剩角色那一个**（成员删除确认随成员写面一起撤掉了）。
		assert.equal((source.match(/narrow: true/g) ?? []).length, 1, '撤面之后只剩角色弹窗要显式 narrow: true')
		// 宽度不许再挂在属性取值上（否则切到另一种模式就变宽）
		assert.ok(!/data-skill-dialog="import"\]\{width/.test(source), '宽度不许挂在某个具体的 data 取值上')
		assert.match(source, /\.cbv-drop\{[^}]*min-height:176px/, '拖拽区高度下限翻倍')
		assert.match(source, /\.cbv-drop\{[^}]*justify-content:center/, '三行在拖拽区里居中')
		// 浮窗里那行键位提示**必须是一行**（现场：被限宽折成两行，"Esc 关"掉到下一行）。
		assert.match(source, /\.cbv-modal-keys\{[^}]*white-space:nowrap/, '键位提示不换行')
		assert.ok(!/\.cbv-modal-keys\{[^}]*max-width:52%/.test(source), '不再用 52% 把它折断')
		assert.match(source, /\.cbv-flt-chip\{[^}]*height:24px/, 'chip 定高')
		assert.match(source, /\.cbv-input,\.cbv-select\{[^}]*height:26px/, '输入框 / 下拉定高')
		assert.match(source, /\.cbv-col\{[^}]*flex:0 0 min\(360px,92%\)/, '栏宽固定（不再 flex:1 1 0 等分）')
		assert.ok(!/\.cbv-board\{[^}]*overflow-x:hidden/.test(source), '不该再写死 overflow-x:hidden')
	})

	test('头像：引擎只给图标名，几何在客户端，且**不上色**（认不出的才照字面画）', async () => {
		// 人的指令：「emoji 头像能否改成不带色彩的开源图标」。这一条钉三件事：
		// ① 引擎那一处只有**名字**（没有 emoji、没有 SVG 字符串）；
		// ② 每个名字在客户端都有几何（漏一个就画不出来）；
		// ③ 图标只用 `currentColor` 描边，不带任何写死的颜色值。
		const { ROLE_AVATAR_ICONS, AVATAR_ICON_FALLBACK, AVATAR_TONES } = await import('../team/team-runtime.js')
		const names = Object.values(ROLE_AVATAR_ICONS)
		assert.ok(Object.keys(ROLE_AVATAR_ICONS).length >= 19, '角色表还在（本体搬走之后至少 19 个）')
		assert.ok(AVATAR_TONES.length === 6)
		// ① 名字都是 ASCII 标识（emoji 一律不该再出现在这张表里）
		for (const [role, name] of Object.entries(ROLE_AVATAR_ICONS)) {
			assert.match(name, /^[a-z][a-z-]*$/, `${role} 的图标名应为小写标识（实际 ${name}）`)
		}
		assert.match(AVATAR_ICON_FALLBACK, /^[a-z][a-z-]*$/)
		// ② 客户端那张几何表要覆盖引擎可能给出的每一个名字（含兜底那一个）
		const source = clientSource()
		const table = source.slice(source.indexOf('const AVATAR_ICONS ='), source.indexOf('const avatarIconOf ='))
		for (const name of new Set([...names, AVATAR_ICON_FALLBACK])) {
			assert.ok(new RegExp(`\\n\\t\\t\\t\\t${name}: \\[`).test(table), `客户端缺少 ${name} 的几何`)
		}
		// ③ 描边 SVG 只认 `currentColor`：整段渲染器里不许写死颜色 / 不许用 fill 上色
		const renderer = source.slice(source.indexOf('const avatarIconOf ='), source.indexOf('const avatarIconOf =') + 1600)
		assert.ok(renderer.includes("stroke: 'currentColor'"), '描边取 currentColor')
		assert.ok(renderer.includes("fill: 'none'"), '不填色')
		assert.ok(!/#[0-9a-fA-F]{3,6}/.test(renderer), '不许写死颜色值')
		assert.ok(!renderer.includes('rgb('), '不许写死颜色值')
	})

	test('三块共用同一套样式骨架（块 / 头 / 筛选行 / 卡 / 滚动区五样）', () => {
		// 这一条钉的是"「成员」「技能」「任务看板」看起来得是同一个东西"（纯 CSS 与类名，
		// 渲染自检看不见）：五样各自**只有一处实现**，三块都用它，不许再各写一套。
		const source = clientSource()
		// ① 块的根：三块都是 `.cbv-view`
		// 尾随 `(?![\w-])` 是必须的：`cbv-view-head` 也含 `cbv-view` 这个子串，但它不是"块的根"。
		const roots = [...source.matchAll(/className: '([^']*cbv-view(?![\w-])[^']*)'/g)].map((match) => match[1])
		assert.ok(roots.length >= 3, `至少三块用同一个块根（实际 ${roots.length}）`)
		assert.ok(roots.every((value) => value.split(' ').includes('cbv-view')), roots.join(' / '))
		// ② 头与标题：三块 + 「角色」那一节都是 `.cbv-view-head` / `.cbv-view-title`
		assert.ok((source.match(/className: 'cbv-view-head'/g) ?? []).length >= 4, '头那一行四处共用')
		assert.ok((source.match(/className: 'cbv-view-title'/g) ?? []).length >= 4, '标题四处共用')
		assert.ok(!/cbv-(mp|sk)-head/.test(source), '不再有各写一套的头')
		assert.ok(!/cbv-(mp|sk)-title/.test(source), '不再有各写一套的标题')
		// ②′ **不许撞上 markdown 那条 `.cbv-block`**（那是围栏代码块的样式）：它只准有一条定义。
		assert.equal((source.split('.cbv-block{').length - 1), 1, 'markdown 的 `.cbv-block` 只该有一条，别被块骨架顶掉')
		// ③ 筛选行：三块 + 看板视图内部都是同一个 `.cbv-flt-bar`；旧的 `.cbv-filters` 撤下
		assert.ok((source.match(/className: 'cbv-flt-bar'/g) ?? []).length >= 4, '筛选行四处共用')
		assert.ok(!/cbv-filters/.test(source), '旧的 `.cbv-filters` 不再出现')
		// ④ 卡片：四类卡（成员 / 技能 / 可叫的角色 / 看板）都带 `.cbv-box`，几何只有一处
		for (const name of ['cbv-mp-card', 'cbv-sk-card', 'cbv-roster-card']) {
			assert.match(source, new RegExp(`cbv-box ${name}`), `${name} 要用共用几何`)
		}
		assert.match(source, /'\.cbv-box\{[^}]*border-radius:10px/, '共用那条要有圆角')
		// 四类卡**同一个底**（都在共用的 `.cbv-box` 里）：原来只有看板卡挂 `--cbv-a1`、其余三类挂
		// `bg-layer-1`（浅色主题下就是 #fff ⇒ 等于没有底），于是"看板卡改过来了、另外两个没改"。
		assert.match(source, /\.cbv-box\{[^}]*background:var\(--cbv-a1\)/, '四类卡共用同一个底')
		for (const name of ['cbv-mp-card', 'cbv-sk-card', 'cbv-roster-card', 'cbv-card']) {
			const rule = new RegExp(`\\.${name}\\{([^}]*)\\}`).exec(source)
			assert.ok(rule !== null, `${name} 要有规则`)
			assert.ok(!/background:/.test(rule[1]), `${name} 不许再自己给底色（那正是"三块各一套"的来源）`)
		}
		// ⑤ 滚动区：`.cbv-scroll` 一处实现、成员与技能都用它（看板按栏滚，那是它的形态）
		assert.ok((source.match(/className: 'cbv-scroll'/g) ?? []).length >= 2, '成员与技能共用滚动区')
		assert.ok(!/cbv-mp-scroll/.test(source), '旧的 `.cbv-mp-scroll` 不再出现')
	})

	test('配色：材质中性，强调色**只在标签上**（用的是主题自己的状态色）', () => {
		// 人的指令变过一次，这一条把**新的**口径钉住：
		// · 一开始："不要颜色，只要留透明度" ⇒ 面板全中性；
		// · 后来："任务看板里的标签加一些强调色，不然就是一片白的标签" ⇒ **强调只给标签**，
		// 而且用主题自己的三个状态色 token（这套主题里带色相的 token 只有 warn / success / error；
		// `brand-primary` 在这个主题里是黑 / 白，等于没色）。
		const source = clientSource()
		const ruleLines = source.split('\n').filter((line) => /^\s*'\.cbv-/.test(line))
		const hue = /--dsw-alias-(state-warn|state-success|state-error)-primary|color-mix\(/
		// ① 用到色相的规则，选择器必须是"标签 / 那一句要动作的告警"——别的规则一律不许带色相。
		// （拖拽区只用**边框**上那个令牌，底色仍是中性的 `--cbv-a*` ⇒ 不进这份色相清单。）
		const ALLOWED = [
			'cbv-chip--st-',
			'cbv-chip--p0',
			'cbv-chip--p1',
			'cbv-chip--exception',
			'cbv-chip--ok',
			'cbv-badge--ok',
			'cbv-note--danger',
			'cbv-a1:',
			'cbv-a2:',
			'cbv-a3:',
			'cbv-a4:',
			'cbv-a5:',
		]
		const offenders = ruleLines.filter((line) => hue.test(line) && !ALLOWED.some((ok) => line.includes(ok)))
		assert.deepEqual(offenders, [], '色相只许出现在标签（状态 / 优先级 / 例外）与「卡在」那一句上')
		// ①′ **浮窗也是半透明的**（人的指令：「弹窗要透明，不然和其他栏的样式不协调」）：
		// 用本体菜单/浮层那一层材质（`--dsw-specific-menu` + `--dsw-menu-backdrop-filter`），
		// 只有开关滑块还挂着一层不透明底（那是它的形态）。算过对比度：浅色 15.8~18.3:1、深色 11.3~12.2:1。
		assert.match(
			source,
			/\.cbv-modal\{background:var\(--dsw-specific-menu/,
			'浮窗底走本体那层"浮层表面"（半透明）',
		)
		assert.match(source, /\.cbv-modal\{[^}]*backdrop-filter:var\(--dsw-menu-backdrop-filter/, '浮窗要带本体那层模糊（半透明不糊字）')
		assert.match(source, /\.cbv-modal\{[^}]*background:var\(--dsw-specific-menu,var\(--dsw-alias-bg-layer-1\)\)/, '取不到主题那层时要有兜底底')
		// 成员开关（`.cbv-switch*`）随成员写面整面撤掉之后，**不透明底一条都不该剩**：
		// 从前唯一那一条就是开关滑块（浮窗那一条只是把不透明底当**兜底**写在 `var()` 的第二参数里，不算）。
		const opaqueRules = ruleLines.filter((line) => /background:var\(--dsw-alias-bg-layer-[12]\)/.test(line))
		assert.deepEqual(opaqueRules, [], '成员开关撤掉之后不该再有滑块的不透明底：' + opaqueRules.join(' | '))
		assert.ok(!source.includes('cbv-switch-knob'), '那枚滑块不该回来')

		// ② 卡片 / 输入框 / 栏这些**材质**仍是中性的（底色走那五档透明度，描边走 border-l2）
		assert.match(source, /\.cbv-box\{[^}]*background:var\(--cbv-a1\)/, '卡片底仍是中性透明度')
		assert.match(source, /\.cbv-input,\.cbv-select\{[^}]*background:var\(--cbv-a1\)/, '输入框底仍是中性透明度')
		assert.match(source, /\.cbv-col\{[^}]*border:1px solid var\(--dsw-alias-border-l2\)/, '栏仍是中性描边')
		// ③ 三个状态色各就各位：待验收=warn、已完成=success、已打回=error；进行中与待办保持中性。
		assert.match(source, /\.cbv-chip--st-verify\{background:color-mix\(in srgb, var\(--dsw-alias-state-warn-primary\)/, '待验收用琥珀')
		assert.match(source, /\.cbv-chip--st-done\{background:color-mix\(in srgb, var\(--dsw-alias-state-success-primary\)/, '已完成用绿')
		assert.match(source, /\.cbv-chip--st-rejected\{background:color-mix\(in srgb, var\(--dsw-alias-state-error-primary\)/, '已打回用红')
		for (const name of ['todo', 'doing']) {
			const rule = new RegExp(`\\.cbv-chip--st-${name}\\{([^}]*)\\}`).exec(source)
			assert.ok(rule !== null, `${name} 要有规则`)
			assert.ok(!/state-(warn|success|error)/.test(rule[1]), `${name} 不上色（"还没动 / 正在动"不是告警）`)
		}
		// ④ 优先级**只给最高两档**上色（满屏强调等于没有强调）
		assert.match(source, /BOARD_PRIORITY_CLASS = \{ P0: 'cbv-chip--p0', P1: 'cbv-chip--p1' \}/)
		// ④′ **墨色**：文字色不是色相本身，而是"色相与主题中性字色混 50%"（浅色主题往深走、深色往亮走）。
		// 实测：直接用色相当文字色，浅色主题下 amber/green 在自己那层淡底上只有 1.68 / 1.75:1（看不清）；
		// 混过之后 warn / ok / err 两套主题都是 4.9~7.6:1。三个墨色变量必须定义在 `.cbv-root` 里
		// （CSS 变量定义在规则里才有效 —— 裸写一条 `'--x:…'` 是无效 CSS，这里也钉一下）。
		for (const ink of ['--cbv-warn-ink', '--cbv-ok-ink', '--cbv-bad-ink']) {
			assert.ok(source.includes(`${ink}:color-mix(in srgb, var(--dsw-alias-state-`), `${ink} 要有定义`)
			assert.ok(source.includes(`${ink}:color-mix`), `${ink} 要有值`)
		}
		const rootRule = /'\.cbv-root\{([^']*)'/.exec(source)
		assert.ok(rootRule !== null, '` .cbv-root` 那条在')
		for (const ink of ['--cbv-warn-ink', '--cbv-ok-ink', '--cbv-bad-ink']) {
			assert.ok(rootRule[1].includes(ink + ':'), `${ink} 必须定义在 .cbv-root 里（不能裸写）`)
		}
		assert.equal((source.match(/^\s*'--cbv-/gm) ?? []).length, 0, 'CSS 变量不许裸写（没有选择器的声明是无效的）')

		// ⑤ 五档透明度仍是"材质"的基础，且真的被用上
		for (const level of ['--cbv-a1', '--cbv-a2', '--cbv-a3', '--cbv-a4', '--cbv-a5']) {
			assert.ok(source.includes(`${level}:color-mix(`), `${level} 要有定义`)
		}
		// ⑥ CSS 花括号配平（样式是一整块字符串塞进 <style>，少一个括号会把整块吃掉）
		let balance = 0
		for (const line of source.split('\n')) {
			const trimmed = line.trim()
			if (!trimmed.startsWith("'") && !trimmed.startsWith('`')) continue
			if (!/[.#@]/.test(trimmed)) continue
			balance += (trimmed.match(/\{/g) ?? []).length - (trimmed.match(/\}/g) ?? []).length
		}
		assert.equal(balance, 0, `样式字符串的括号不配平（差 ${balance}）—— 少一个括号会把整块样式吃掉`)
	})

	test('详情浮窗的键盘：↑ ↓ 本栏内翻页、← → 切换分栏、Esc 关', () => {
		// 人的指定：「方向键上下是详情内翻页，左右是详情内切换分栏。现在左右变成了翻页。」
		// 这条是纯行为（要按一下才知道）⇒ 源码守接线，按键的行为在 `panel-blocks` 里真按（两侧都按了）。
		const source = clientSource()
		assert.ok(source.includes('function useDetailModal(detail, onClose, onStep, onColumnStep)'), '钩子收四个参数')
		// ↑ ↓ 走 `onStep`（与那两个按钮同一件事）
		assert.ok(source.includes("event.key === 'ArrowUp') handlers.current.onStep(-1)"), '↑ = 栏内上一条')
		assert.ok(source.includes("event.key === 'ArrowDown') handlers.current.onStep(1)"), '↓ = 栏内下一条')
		// ← → 走 `onColumnStep`
		assert.equal(
			(source.match(/event\.key === 'Arrow(Right|Left)'\) \(handlers\.current\.onColumnStep \?\? handlers\.current\.onStep\)/g) ?? []).length,
			2,
			'← → 走 onColumnStep（没给才退回栏内翻）',
		)
		// 两档都把 columnStep 接进浮窗，各有一份实现
		assert.equal((source.match(/\(offset\) => columnStep\(offset\)/g) ?? []).length, 2, '两档都接了 columnStep')
		assert.equal((source.match(/const columnStep = \(offset\) => \{/g) ?? []).length, 2, '两档各有一份 columnStep')
		// **浮窗标题里带"是哪一栏"**：否则"换栏"与"翻页"看起来一模一样（现场就是这么误判的）
		assert.ok(source.includes('labelOfColumn(columns, current)'), '看板那一档把栏名递进浮窗')
		assert.ok(source.includes("labelOfColumn(TEAM_TASK_COLUMNS, detailRow, 'status')"), '团队那一档把栏名递进浮窗')
		assert.equal((source.match(/groupLabel === undefined \|\| groupLabel === '' \? '' : groupLabel \+ '　·　'/g) ?? []).length, 2, '两支浮窗标题都带上栏名')
		// 提示只在浮窗里（两支各一行），文案按新键盘写
		assert.equal((source.match(/className: 'cbv-modal-keys'/g) ?? []).length, 2, '两支浮窗各有一行键位提示')
		assert.ok(source.includes('`↑ ↓` 本栏内翻页 · `← →` 切换分栏 · `Esc` 关'), '提示按新键盘写')
		assert.ok(!source.includes('`上一条 / 下一条` 在本栏内翻'), '旧的那句不留')
		// **看板底部那一整行撤了**（人的指令：不要显示）
		assert.ok(!source.includes('点卡片看**详情**（键盘：浮窗里有提示）'), '底部那句整行撤了')
	})

	test('浮窗里的控件与说明：一处一条样式（文本框不再被 .cbv-input 压成单行）', () => {
		// 现场两条：①「补充正文那一栏应该是文本框，不是输入框」（它原来挂着 `.cbv-input`，
		// 而那条规则为了固定筛选行高度加了 `height:26px` ⇒ rows=5 被压成一行）；
		// ② 弹窗里说明的写法**五处五个样**。这一条把两件事各钉成一条规则：
		const source = clientSource()
		// ① 多行文本框只有一条样式，且不依赖 `.cbv-input`；`.cbv-mp-area`（曾经挂在那儿、**从未定义**）不再出现。
		assert.equal((source.match(/'\.cbv-mp-textarea\{/g) ?? []).length, 1, '多行文本框只有一条样式')
		assert.ok(!source.includes('cbv-mp-area'), '那个没定义的类不再出现')
		assert.ok(!/className: 'cbv-input cbv-mp-area'/.test(source), '文本框不许再挂 .cbv-input')
		assert.match(source, /\.cbv-mp-textarea\{[^}]*resize:vertical/, '允许纵向拉伸（多行框的常识）')
		assert.ok(!/\.cbv-mp-textarea\{[^}]*height:26px/.test(source), '文本框不许被定成单行高度')
		// ② 说明**一类**：`.cbv-mp-field-note` 有定义、且弹窗里的说明都走它（纯文字不再套字段容器）
		assert.match(source, /\.cbv-mp-field-note\{font-size:12px/, '说明那一类有样式')
		assert.ok(!/className: 'cbv-mp-field', key: '[a-z-]+' \}, '/.test(source), '纯文字不该再套 .cbv-mp-field（那是字段容器）')
		assert.match(source, /const note = \(value, key\) =>/, '说明的渲染只有一处实现')
	})

	test('选择框照本体：搜索框一条样式、列表摊平、组标题 11px、唯一那处强调色是本体输入语言', () => {
		// 人给了一张本体「专家」选择框的现场图：「只需要这个样式，不需要多余的废话。」
		// 于是这里钉四件事：① 搜索框是**一条**自己的样式（照本体那个搜索框）；② 列表**摊平**（不做内层盒子）；
		// ③ 组标题参数照本体（11px / padding 6px 8px）；④ 面板里**唯一**用到色相的"非标签"处是输入框的聚焦环
		// —— 那是本体的输入语言（`--dsw-alias-state-business-primary`），有且只有这一处。
		const source = clientSource()
		assert.equal((source.match(/'\.cbv-rolepick-search\{/g) ?? []).length, 1, '搜索框一条样式')
		assert.match(source, /\.cbv-rolepick-search:focus\{border-color:var\(--dsw-alias-state-business-primary\)\}/, '聚焦环用主题的输入语言')
		// 列表摊平（不描边、不铺底）**且不自己滚** —— 滚动只留外层浮层，否则一个浮层里两条滚动条。
		assert.match(source, /\.cbv-picker\{margin-top:2px\}/, '列表摊平（不描边、不铺底、不自己滚）')
		// 浮层收小（人的指令：「弹窗太大，不够精致」）
		assert.match(source, /\.cbv-rolepick-pop\{[^}]*width:min\(300px,70vw\)/, '浮层收窄到 300px')
		assert.match(source, /\.cbv-rolepick-pop\{[^}]*max-height:min\(46vh,360px\)/, '浮层高度收紧')
		assert.match(source, /\.cbv-rolepick-pop\{[^}]*padding:6px\}/, '内边距收紧')
		// 聚焦环：圆角更小、边框更宽（人的指令）—— 后来又要 2px，再抬高一档
		assert.match(source, /\.cbv-rolepick-search\{[^}]*border:2px solid transparent/, '搜索框边框 2px')
		assert.match(source, /\.cbv-rolepick-search\{[^}]*border-radius:var\(--dsw-radius-xs\)/, '聚焦环圆角用最小的那一档（4px）')
		// **吸顶 + 高一点**（人的指令：「输入框吸顶，输入框高度再高一点」）
		assert.match(source, /\.cbv-rolepick-head\{position:sticky;top:0/, '搜索框那一层吸顶')
		assert.match(source, /\.cbv-rolepick-head\{[^}]*margin:-6px -6px 2px/, '负外边距盖住浮层内边距（行不从上面那条缝透出来）')
		assert.match(source, /\.cbv-rolepick-search\{[^}]*height:32px/, '搜索框高 32px（原来靠 padding 撑着，偏矮）')
		assert.match(source, /\.cbv-rolepick-search\{[^}]*font-size:13px/, '字也大一档')
		// 按钮：无底色 + 悬停才有底色 + 一枚图标（人的指令）
		assert.match(source, /\.cbv-composer-btn\{[^}]*background:0 0/, '「角色」按钮无底色')
		assert.match(source, /\.cbv-composer-btn:hover:not\(:disabled\)\{background:var\(--dsw-alias-interactive-bg-hover/, '悬停才显示底色')
		assert.ok(!/cbv-composer-btn--armed|cbv-composer-btn--primary/.test(source), '按钮不再因"选中了角色"换样子')
		assert.ok(!/\.cbv-picker\{[^}]*border:1px solid/.test(source), '列表不再有自己的盒子')
		assert.match(source, /\.cbv-picker-head\{font-size:11px;line-height:15px/, '组标题参数照本体')
		assert.match(source, /\.cbv-picker-row \.cbv-mp-avatar\{width:26px;height:26px;border-radius:50%\}/, '行里的头像圆形（照本体，收紧到 26px）')
		// 用到本体验证色（`--dsw-alias-state-business-primary`）的规则：**三组**，逐组列明 ——
		// ① 输入类那一组（聚焦环）；② 选择框里的搜索框；③ **技能导入的拖拽区**（人的指令：默认天蓝色虚线）。
		// 每次新增一处都要在这里登记：这条断言的作用是"破例必须被数出来"，不是"永远只有两处"。
		const businessRules = source
			.split('\n')
			.filter((line) => line.includes('--dsw-alias-state-business-primary') && /^\s*'\.cbv-/.test(line))
		assert.equal(businessRules.length, 3, '用到本体验证色的规则：3 条（输入类 / 搜索框 / 拖拽区虚线）：' + businessRules.join(' | '))
		assert.ok(
			businessRules.every((line) => /\.cbv-input|\.cbv-select|\.cbv-mp-textarea|\.cbv-rolepick-search|\.cbv-drop/.test(line)),
			'只许出现在这三组上：' + businessRules.join(' | '),
		)
	})

	test('点名规矩：正文只在工具面一处，基线不再重复（按指针引它）', async () => {
		// 人的判断（随这次改动）：面板那枚"让它去干"的按钮是**多此一举** —— 本体的发送键就够了；
		// 又一轮判断（基线瘦身）：这条**只在工具面有一份正文**，基线只许给指针 —— 抄第二份就是两处会漂。
		const { teamPolicyText } = await import('../team/team-runtime.js')
		const policy = teamPolicyText()
		const baseline = readFileSync('team/BASELINE.md', 'utf8')
		for (const line of ['点名', '不要自己代劳', '出现多个 `@` ⇒ 各派一份', '`member_send`']) {
			assert.ok(policy.includes(line), '工具面缺：' + line)
		}
		assert.ok(policy.includes('`member_spawn role=<id>`'), '工具面给出那个动作')
		assert.ok(baseline.includes('点名规矩'), '基线要**提到**这一条（指针），而不是装作没有')
		assert.ok(!baseline.includes('不要自己代劳'), '基线不再抄第二份正文')
		assert.ok(!baseline.includes('出现多个 `@` ⇒ 各派一份'), '基线不再抄第二份正文')
	})

	test('基线做到**角色无关**：角色专属细则不在基线里，且有那句"角色名只是当前由谁"的软引用', async () => {
		// 人的口径：「基线还有没有优化的空间，同时做到角色无关。」
		// 可判形式：**加/删一个角色，基线一个字都不用改**。
		const baseline = baselineCorpusOf()
		// ① 三处角色专属细则必须已经搬走（各自回到涉事角色的「落点」段）
		for (const moved of ['docs/review/', 'docs/qa/ai-eval/', '定价与报价定稿一律由人拍板', '注释只写代码本身的事']) {
			assert.ok(!baseline.includes(moved), '基线里不该再有角色专属细则：' + moved)
		}
		// ② 软引用条款（这是"删角色不用改基线"的依据）
		assert.ok(baseline.includes('只表示"当前由谁承接这个动作"'), '缺软引用条款')
		assert.ok(baseline.includes('本文件一个字都不用改'), '要写明"不用改基线"')
		// ③ 那三处细则确实落到了该管的角色定义里（不然就是搬丢了）
		const want = {
			reviewer: '评审产物归本角色',
			qa: '评审产物不归本角色',
			'ai-algo': 'AI 评测集这一链的分归',
			finance: '「定价」这一题的正文由本角色出',
			sales: '「对外报价与折扣承诺」这一题的正文由本角色出',
		}
		for (const [role, line] of Object.entries(want)) {
			assert.ok(readFileSync(join('team/roles', role, 'ROLE.md'), 'utf8').includes(line), role + ' 的落点段缺：' + line)
		}
		// ④ 代码角色的检查表：性能陷阱 + 结构（这两条故意不进基线 —— 进了就不"角色无关"了）
		for (const role of ['be-dev', 'fe-dev', 'data-eng', 'ai-algo']) {
			const text = readFileSync(join('team/roles', role, 'ROLE.md'), 'utf8')
			assert.ok(text.includes('性能陷阱逐条自查过'), role + ' 缺性能陷阱那一条')
			assert.ok(text.includes('结构与重复审过'), role + ' 缺结构那一条')
			assert.ok(text.includes('不为模式而模式'), role + ' 要点明"不为模式而模式"')
		}
		// ⑤ 新增的四句共同判据在基线里（第一性原理 / 模糊先问清 / 动手前先审 / 不留临时修复）
		for (const line of ['选型与设计先答"不这么做会怎样"', '问题本身模糊', '动手前先审', '交付物里不许留临时修复', '要么找到根因彻底解决']) {
			assert.ok(baseline.includes(line), '基线缺：' + line)
		}
	})

	test('交付文档与"人指出一处之后"：两条规则都在基线里，且各自带着判定条件', async () => {
		// 人的现场（一份现象说明书）：AI 连续 9 份交付文档的头部都插了内部编号 / 协作坐标 / 口径声明，
		// 且被指出一处后只清了那一份。根因在我们这边：我们规定了"给系统看的状态文件"与"给流程看的剧本"，
		// **唯独没规定"给人看的交付文档"**（`grep 首行|抬头|元信息|读者` 在基线 + 20 份 ROLE.md 里零命中）。
		const baseline = baselineCorpusOf()
		// ① 交付文档怎么写：四类不写 + 必要信息放文末 + 三类别混 + 可核的判定条件
		for (const line of ['交付物是什么、怎么写', '第一行是标题，第二行起就是读者要的内容', '内部编号', '协作坐标', '流程引用', '适用范围与口径声明', '放**文末**']) {
			assert.ok(baseline.includes(line), '基线缺：' + line)
		}
		assert.ok(baseline.includes('三类产物写法不同，别混'), '三类产物要点名分开（现象说明书第七条正是这个）')
		// **交付物的定义**（人的原话：「架构师的交付物是架构文档、程序员的是代码，不是一堆我做了什么的文档」）：
		// 判据一句话 + 三类形态 + "记账不是交付物" + 两个角色的对照例子。
		for (const line of ['交付物 = 下游能直接拿去用的那件东西本身', '别人能不能直接用它', '程序员交的是可运行的改动', '不是《我改了什么》', '**不是交付物**', 'ADR、需求规格、任务分解单、接口契约']) {
			assert.ok(baseline.includes(line), '基线缺交付物定义里的：' + line)
		}
		// **与外部格式要求（"回复以交付物开头"）怎么对齐**：四行对照表 + 判定条件
		for (const line of ['与「回复以交付物开头」这类外部格式要求怎么对齐', '指针就是交付物', '不要把产物贴进回复', '那一刻没有交付物可交', '回执就是那一刻的交付物']) {
			assert.ok(baseline.includes(line), '基线缺对齐表里的：' + line)
		}
		// 策略段也要说清"回报第一行 = 那条指针"（否则"交付物在前"会被读成"把产物贴进回复"）
		const { teamPolicyText: policyOf } = await import('../team/team-runtime.js')
		assert.ok(policyOf().includes('回报的第一行就是那条指针'), '策略段要写明第一行就是指针')

		// 每个角色的「落点」段都要先声明"这一节是交付物本身、交付记录是记账"（19 份对齐过）
		const roles = readdirSync('team/roles').filter((name) => existsSync(join('team/roles', name, 'ROLE.md')))
		assert.ok(roles.length >= 19, '名册至少 19 个角色（本体已移出包）')
		for (const role of roles) {
			const text = readFileSync(join('team/roles', role, 'ROLE.md'), 'utf8')
			assert.ok(
				text.includes('这一节列的是交付物本身') && text.includes('是**记账**（过程与读数），**不是交付物**'),
				role + ' 的「落点」段缺交付物口径那一行',
			)
		}
		assert.ok(baseline.includes('判定条件（可当场核）'), '这条必须带判定条件，否则又一次"只写原则"')
		// ② 人指出一处之后怎么办：先判一处还是一类 + 同类一起扫 + 落成规则
		assert.ok(baseline.includes('人指出一处之后怎么办'), '缺"反馈泛化"那一条')
		assert.ok(baseline.includes('**同类一起扫**'), '要点明同类一起扫')
		assert.ok(baseline.includes('判定条件 + 现场命令 + 原始输出'), '扫描口径要给三件套')
		assert.ok(baseline.includes('别等人第二次说'), '写清"不等第二次"')
		// ③ 工具面与策略段各有一句最短的（"看板编号是系统坐标，不进给人看的文档"）
		const gate = readFileSync('team/company-gate.js', 'utf8')
		assert.ok(gate.includes('看板编号是系统坐标，不进给人看的文档'), 'board_task 描述里要有这一句')
		const { teamPolicyText } = await import('../team/team-runtime.js')
		const policy = teamPolicyText()
		assert.ok(policy.includes('指针放在回报里，不写进产物'), '策略段要有对应半句')
	})

	test('按需组建：判据只在工具面一处，基线不再重复', async () => {
		// 人的口径：统一到"自决、按需组建"；基线瘦身之后，**这条的正文只在工具面那一份**，
		// 基线只许给指针（抄第二份就有两处会漂）。
		const { teamPolicyText } = await import('../team/team-runtime.js')
		const policy = teamPolicyText()
		const baseline = readFileSync('team/BASELINE.md', 'utf8')
		// ① 工具面：不再有"只在明确要求时造人"；有"协调器自决"与那三条判据
		assert.ok(!policy.includes('只在用户明确要求'), '工具面不该再要求"用户明确要求才造人"')
		assert.ok(policy.includes('协调器自决'), '工具面要写明自决')
		assert.ok(policy.includes('必须记账'), '自决的前提是记账')
		assert.ok(!policy.includes('两段都讲"只在明确要求时造人"'), '那句注解也要跟着改（不能再自相矛盾）')
		// ② 三条判据**逐字在工具面那一份里**（这条的正文明文只此一处）
		// 称呼统一成「人」（不再用「用户」当第三方称呼）
		for (const line of ['活能拆成**互不重叠的并行块**', '独立复核', '单会话做不完', '人说别叫人就不叫']) {
			assert.ok(policy.includes(line), '工具面缺判据：' + line)
		}
		assert.ok(policy.includes('member_spawn role='), '叫人是**一个动作**：落到工具名上')
		// ③ 基线**只给指针**：它要提到"按需组建 / 点名规矩在策略段与工具描述里"，但不抄正文
		assert.ok(baseline.includes('按需组建'), '基线要提到这一条（指针）')
		assert.ok(!baseline.includes('活能拆成**互不重叠的并行块**'), '基线不再抄第二份判据')
		// 告警线的**取值**（= 4）只在策略段 / 工具描述里；基线连取值都不重复，只把它当话题名点到
		assert.ok(baseline.includes('告警线'), '基线要点到这个话题（指针）')
		assert.ok(!baseline.includes('告警线 = 4') && !baseline.includes('告警线 = **4**'), '基线不重复那个取值')
	})

	test('专属技能与团队规则是两回事（规则不写进角色的 skills）', async () => {
		// 人的口径（两轮）：① 技能是角色专属的；② 都插件化了，技能层与"规范入口"一起删掉，
		// 团队规则改成一份 `team/BASELINE.md`（按路径读）。这一条把三处口径钉在一起，免得又写回"把规则当角色技能"：
		const { rolePersonaOf, patchRoleText } = await import('../team/team-runtime.js')
		// 技能层删掉之后，"基线入口"这个特殊名字**在引擎里已经不存在**了 ⇒ 这里只当历史名字用，
		// 由下面第 ④ 条（包内 20 份 ROLE.md 不许声明它）兜着。
		const ROLE_SKILL_EXCLUDED = 'team-playbooks'
		const role = { id: 'qa', title: '测试工程师', category: '质量', file: 'roles/qa/ROLE.md', skills: [] }
		// 这一行现在有两种写法（有装备 / 无装备），但**都不能读成"你没有技能可用"**：技能池是按 agent 注入的。
		const lineOf = (text) => (text.split('\n').find((line) => line.includes('专属技能') || line.includes('常驻的作业程序')) ?? '')
		// ①-b 声明了专属技能：名字要印出来，而且要说明"做这类事之前先载入它"（不是给你看一眼的名单）
		const withSkills = rolePersonaOf(
			{ id: 'ux-designer', title: '体验设计', category: '设计', file: 'roles/ux-designer/ROLE.md', skills: ['ui-ux-pro-max', 'ui-styling'] },
			{ name: 'ux-1' },
		)
		const skillsLineText = lineOf(withSkills)
		assert.ok(skillsLineText.includes('ui-ux-pro-max') && skillsLineText.includes('ui-styling'), '装备要印出来：' + skillsLineText)
		assert.ok(skillsLineText.includes('skill'), '要告诉成员怎么用（调 skill 载入）：' + skillsLineText)
		assert.ok(skillsLineText.includes('先调'), '要说明是"动手之前"，不是可选参考：' + skillsLineText)
		assert.ok(!skillsLineText.includes('没有专属技能'), '声明了就不许再说"没有"：' + skillsLineText)

		// ① 没有专属技能：明说"没有"，并把基线指向**文件路径**（它不再注册成技能）
		const none = lineOf(rolePersonaOf(role, { name: 'qa-1' }))
		assert.ok(none.includes('没有常驻的专属技能'), '要说清"没有的是常驻装备"，不是"没有技能可用"：' + none)
		assert.ok(none.includes('available_skills'), '要指出会话里那份技能目录照样可用：' + none)
		assert.ok(none.includes('skill') && none.includes('先调'), '要给出动作：先调 skill 载入：' + none)
		assert.ok(none.includes('team/BASELINE.md'), '给的是规则文件的路径：' + none)
		assert.ok(!none.includes('技能工具'), '不再让人按技能名加载（技能层已删）')
		// ② 有专属技能：只列专属的那些
		const some = lineOf(rolePersonaOf({ ...role, skills: ['qa-playbooks', 'perf-baseline'] }, { name: 'qa-2' }))
		assert.ok(some.includes('qa-playbooks') && some.includes('perf-baseline'), some)
		// ④ 包内 20 份 ROLE.md **一个都不该**声明它（2026-10 清过一轮这种错位）
		const { readdirSync } = await import('node:fs')
		for (const id of readdirSync('team/roles')) {
			const text = (await import('node:fs')).readFileSync(`team/roles/${id}/ROLE.md`, 'utf8')
			assert.ok(!/^skills:.*team-playbooks/m.test(text), `${id} 的 ROLE.md 不该把基线当角色技能`)
		}
		// ⑤ 面板改技能：给了就写、给空串就删掉那一行、不给就一个字不碰
		const base = '---\nkind: role\nname: x\nversion: 1.0.0\ncategory: 测试\ndescription: Use when 测。\n---\n\n# X（x）\n\n测。\n'
		assert.ok(!/^skills:/m.test(patchRoleText(base, { id: 'x', title: 'X' })), '不给 skills ⇒ 不写这一行')
		const added = patchRoleText(base, { id: 'x', skills: 'qa-playbooks, perf-baseline' })
		assert.match(added, /^skills: qa-playbooks, perf-baseline$/m, '给了就写（剔掉空项）')
		assert.match(added, /^category: 测试$/m, '别的行不动')
		assert.match(added, /^description: Use when 测。$/m, '别的行不动')
		assert.ok(!/^toolset:/m.test(added), '锚换到 front-matter 收尾之后，补技能不许写回一个没人读的键')
		assert.ok(!/^skills:/m.test(patchRoleText(added, { id: 'x', skills: '' })), '给空串 ⇒ 删掉那一行')
		// （那条"只写基线入口就等于没有"的断言随技能层一起删了：team-playbooks 现在只是一个普通名字。）
		// ⑥ 引擎模板与面板都不该再把它写死 / 新增那一格在
		const engineText = readFileSync('team/team-runtime.js', 'utf8')
		assert.ok(!/'skills: team-playbooks'/.test(engineText), '引擎模板里不该再有写死的 skills 行')
		assert.ok(readFileSync('lib/board-view.client.js', 'utf8').includes("'data-roster-field': 'skills'"), '面板有"专属技能"那一格')
	})
		// ①-a **这个字段不许再变成纯装饰**：包内角色里至少有一个声明了专属技能。
		// 从前 19 份 ROLE.md 一个都没写 ⇒ 每位成员的身份段里都是"本角色没有专属技能" ⇒ 技能栏里那些
		// 现成的作业程序（ui-ux-pro-max / ui-styling …）从来没被角色用过，人看到的就是"有技能却不用"。
		const declared = readdirSync('team/roles', { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => `team/roles/${entry.name}/ROLE.md`)
			.filter((file) => /^skills:\s*\S/m.test(readFileSync(file, 'utf8')))
		assert.ok(declared.length >= 1, '包内至少要有一个角色声明了专属技能（否则成员永远被告知"没有专属技能"）')


	test('角色定义不再声明五个没有消费者的格子（toolset / tools_extra / tools_off / model / reasoning）', async () => {
		// **为什么删**：这五个键解析出来之后**谁都不读** —— 成员的工具面与模型由宿主原生 `spawnTeammate` 定，
		// 它的 request 只有 `name` / `description` / `prompt` / `context` / `provider` / `signal`。
		// 声明了却没有闸看它，读的人会以为"我的工具面被限住了 / 我跑在那个模型上"—— 那是假承诺。
		const banned = ['toolset', 'tools_extra', 'tools_off', 'model', 'reasoning']
		const declaredKeys = (text) => banned.filter((key) => new RegExp(`^${key}:`, 'm').test(text))
		// ① 包内每一份 ROLE.md 都不许再声明
		for (const id of readdirSync('team/roles')) {
			const file = `team/roles/${id}/ROLE.md`
			assert.deepEqual(declaredKeys(readFileSync(file, 'utf8')), [], `${file} 不该再声明这五个键`)
		}
		const { roleRecords, roleTextOf } = await import('../team/team-runtime.js')
		const { roleScaffold } = await import('../lib/roster.js')
		// ② 解析出来的角色记录里没有这五个字段
		for (const record of roleRecords()) {
			for (const key of ['toolset', 'model', 'reasoning', 'toolsExtra', 'toolsOff']) {
				assert.ok(!Object.hasOwn(record, key), `角色记录不该带 ${key}`)
			}
		}
		// ③ 两处骨架（面板改角色 / 新角色模板）都不写这五个键
		const skeleton = roleTextOf({ id: 'x', title: 'X', category: '测试', positioning: '对 X 负责。', skills: 'perf-baseline' })
		assert.deepEqual(declaredKeys(skeleton), [], 'roleTextOf 骨架')
		assert.deepEqual(declaredKeys(roleScaffold('x', 'X', '测。')), [], 'roleScaffold 骨架')
		// ④ 解析侧也不再读这五个键（把它们加回解析里 ⇒ 这一条当场红）
		const engine = readFileSync('team/team-runtime.js', 'utf8') + readFileSync('lib/roster.js', 'utf8')
		for (const key of ['toolset', 'tools_extra', 'tools_off', 'toolsExtra', 'toolsOff']) {
			assert.ok(!engine.includes(`meta.${key}`), `解析侧不该再读 ${key}`)
		}
		assert.ok(!/meta\.(model|reasoning)\b/.test(engine), '解析侧不该再读 model / reasoning')
	})


	test('端点：成员与技能两组的常量与 host half 的导出路径逐字相等', async () => {
		const source = clientSource()
		const host = await import('../lib/board-view.host.js')
		assert.equal(literalOf(source, 'API_PREFIX'), host.ROUTE_PATH, '前缀必须同一个')
		assert.equal(host.ROUTE_PATH + suffixOf(source, 'MEMBERS_ENDPOINT'), host.MEMBERS_PATH)
		// 成员那两条写端点：**客户端已经整面撤掉**（宿主侧保留为防御性拒绝，常量仍在 host）——
		// 所以这里反过来钉"客户端不再有这两个常量"，免得那个写面又悄悄回来。
		assert.ok(!source.includes('MEMBER_UPDATE_ENDPOINT') && !source.includes('MEMBER_DELETE_ENDPOINT'), '成员写面撤掉后客户端不该再有这两个端点常量')
		assert.equal(host.MEMBER_UPDATE_PATH, host.MEMBERS_PATH + '/update', 'host 那两条路由常量仍在（拒绝面）')
		assert.equal(host.MEMBER_DELETE_PATH, host.MEMBERS_PATH + '/delete')
		assert.equal(host.ROUTE_PATH + suffixOf(source, 'SKILLS_ENDPOINT'), host.SKILLS_PATH)
		assert.equal(host.SKILLS_PATH + suffixOf(source, 'SKILL_DEFINITION_ENDPOINT'), host.SKILL_DEFINITION_PATH)
		// 任务看板的团队那一半（跨半边路径错一个字符就是 404，那一档会静默变成"读不到"）。
		assert.equal(host.ROUTE_PATH + suffixOf(source, 'TEAM_TASKS_ENDPOINT'), host.TEAM_TASKS_PATH)
		// 「角色」那三条写路径（同上：错一个字符就是 404，而按钮看起来"没反应"）。
		assert.equal(host.ROUTE_PATH + suffixOf(source, 'ROLES_UPDATE_ENDPOINT'), host.ROLES_UPDATE_PATH)
		assert.equal(host.ROUTE_PATH + suffixOf(source, 'ROLES_REMOVE_ENDPOINT'), host.ROLES_REMOVE_PATH)
		assert.equal(host.ROUTE_PATH + suffixOf(source, 'ROLES_RESTORE_ENDPOINT'), host.ROLES_RESTORE_PATH)
	})

	test('字段契约：成员块读过的每个字段，端点载荷里都在（含看板派生的当前任务与实时读数）', async () => {
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-members-block-'))
		writeFileSync(
			join(workspace, '.company-gate.members.json'),
			JSON.stringify(
				{
					version: 1,
					seq: 3,
					members: [
						{
							id: 'MB-001',
							name: 'reviewer-1',
							role: 'reviewer',
							description: '独立复核交付物',
							prompt: '复核 docs/plan.md 并产出 docs/review.md',
							persona: '你是复核员。',
							task: '复核 T-001',
							session: 'sess-0000000000000001',
							status: '在场',
							last_active_at: '2026-10-07T02:00:00.000Z',
							updated_at: '2026-10-07T02:00:00.000Z',
							enabled: true,
							// 盘上的运行时读数：本会话没有活着的 Agent 时**保留这个值**（实时状态只覆盖不发明）。
							runtime: 'inactive',
							line_reason: '这一轮为什么需要第 1 个',
						},
						// 第二个成员是**退役**的：`retire_reason` / `replaced_by` 只由 `member_retire` 写上。
						{ id: 'MB-002', name: 'be-1', role: 'be-dev', status: '退役', retire_reason: '这一批活干完了', replaced_by: 'be-2', enabled: false },
					],
				},
				null,
				2,
			),
		)
		writeFileSync(
			join(workspace, '.company-gate.board.json'),
			JSON.stringify(
				{ version: 1, seq: 4, tasks: [{ id: 'T-001', description: '复核', owner: 'reviewer', status: '进行中', revision: 1, assignee: 'revi-1', attempt: 1, attemptId: 'uuid-attempt-1', priority: 'P1' }], tombstones: [] },
				null,
				2,
			),
		)
		writeFileSync(join(workspace, '.company-gate.mailbox.json'), JSON.stringify({ version: 1, seq: 1, messages: [] }, null, 2))

		const { handleMembers } = await import('../lib/board-view.host.js')
		// **行只从原生名册来**（task-40）：给一个最小可用的 `agentTeams` 假件（一位协调者 + 一位队友），
		// 否则 `merged` 是空的，"字段契约"这条就没东西可核。
		const teamRows = [
			{ id: 'session-lead', name: 'lead', role: 'lead', status: 'running', model: 'deepseek-flash', diagnostics: [] },
			{ id: 'child-1', name: 'reviewer-1', role: 'teammate', status: 'inactive', description: '独立复核交付物', provider: 'deepseek', context: 'fresh', model: 'deepseek-flash', diagnostics: [] },
		]
		const services = { agentTeams: { listMembers: () => teamRows }, agents: { get: (id) => (id === 'session-lead' ? { id } : undefined) } }
		const ctx = { fs: makeFs(), get: (name) => services[name], logger: { warn() {} } }
		const read = async (root) => {
			const { res, captured } = makeRes()
			await handleMembers(ctx, { method: 'GET', url: `/company-board/api/members?workspace=${encodeURIComponent(root)}&session=session-lead` }, res, null)
			return { status: captured.status, payload: JSON.parse(captured.body) }
		}
		const ok = await read(workspace)
		assert.equal(ok.status, 200, JSON.stringify(ok.payload))
		// **task-40 起载荷里只有一份行**（原生名册那一份 `merged`）：`rows`（旧名册整形行）与
		// `established` / `total` / `annotations` / `markdown` 那些旧账派生的字段一并撤掉了。
		assert.equal(ok.payload.rows, undefined, '不再回旧名册那份整形行')
		assert.equal(ok.payload.established, undefined, '不再回"名册建没建立"（说的是旧文件）')
		assert.equal(ok.payload.total, undefined)

		// 成员块读过哪些字段：从 MembersView 的函数体里**两半都抓**——
		// · `row.<字段>` 读的是 join 之后那一份（`merged`：身份 / 运行时 / 团队给的模型与职责）；
		// · `ledger.<字段>` 读的是文件那一份（`rows`：制度三态 / 未读 / 链接 / 提示词 / 编号）。
		// 用行的并集而不是第一行：有几格本来就只有某类行才有（比如 `retire_reason` 只在退役那张卡上读、
		// `attemptTask` 只在开着执行代的那一行上派生）；这些字段少一个，对应那张卡上就是空白。
		const source = clientSource()
		const start = source.indexOf('function MembersView(props)')
		const end = source.indexOf('/** 一个视图 = 一份文件', start)
		assert.ok(start > 0 && end > start, 'MembersView 的正文范围要能定位（这段自检靠它抓字段名）')
		const body = source.slice(start, end)
		// 字段名允许驼峰（`matchedBy` / `mailbox_unread` 都要抓全）：字符类带上大写，别截成 `matched`。
		const mergedFields = [...new Set([...body.matchAll(/\brow\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]))].sort()
		const ledgerFields = [...new Set([...body.matchAll(/\bledger\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]))].sort()
		assert.ok(mergedFields.length >= 8, `抓到的字段太少（${mergedFields.length} 个）`)
		// **页面一个 `ledger.<字段>` 都不许再有**（task-40）：旧名册文件的读取路径整条断开 ——
		// 留着一个 `ledger.xxx` 就等于留着一处"读旧账"的入口（这条断言就是那道闸）。
		assert.deepEqual(ledgerFields, [], `客户端不许再读 ledger.*（旧名册文件）：${ledgerFields.join('、')}`)
		const mergedPayloadFields = new Set(ok.payload.merged.flatMap((item) => Object.keys(item)))
		const missingMerged = mergedFields.filter((field) => !mergedPayloadFields.has(field))
		assert.deepEqual(missingMerged, [], `merged 里没有这些字段：${missingMerged.join('、')}（页面要的：${mergedFields.join('、')}）`)

		// 「角色」那一节读的是**第三份**载荷（`defaults.rows`）：同一套契约，另立一处。
		const rosterStart = source.indexOf('const rosterSectionOf = (data, actions) => {')
		assert.ok(rosterStart > 0, 'rosterSectionOf 要能定位')
		const rosterBody = source.slice(rosterStart, source.indexOf('function MembersView(props)', rosterStart))
		const dialogStart = source.indexOf('const rosterDialogOf = () => {')
		assert.ok(dialogStart > rosterStart, '角色弹窗要能定位')
		// 边界取"**下一条同层函数**"，不再指某个具体名字：原先指 `deleteDialogOf`（成员删除弹窗），
		// 成员写面撤掉之后那个名字没了 ⇒ `indexOf` 回 -1、`slice(start, -1)` 会把**文件剩下的全部**
		// 当成弹窗体（现场抓出 `createReader` / `isDirectory` / `isFile` 这些根本不属于名册行的字段）。
		// 找不到下一条同层函数就**当场红**，不许安静地切片。
		const nextSection = source.slice(dialogStart + 1).search(/\n\t\tfunction [A-Za-z_$][\w$]*\(/)
		assert.ok(nextSection > 0, '角色弹窗的下一条同层函数要能定位（否则切片会越界）')
		const dialogBody = source.slice(dialogStart, dialogStart + 1 + nextSection)
		// **输入框工具行那一席**（`RoleComposerEntry`）读的也是**同一份名册行**（`defaults.rows`，
		// 它自己按 `?workspace&session` 取 `/members`）⇒ 与上面两段一起算进"名册字段"。
		const pickerStart = source.indexOf('function RoleComposerEntry(props) {')
		assert.ok(pickerStart > 0, '输入框那一席要能定位')
		const pickerEnd = source.indexOf('function MembersView(props)', pickerStart)
		assert.ok(pickerEnd > pickerStart, '它的正文范围要能定位')
		const pickerBody = source.slice(pickerStart, pickerEnd)
		const rosterFields = [
			...new Set([
				...[...rosterBody.matchAll(/\brow\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]),
				...[...dialogBody.matchAll(/\bentry\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]),
				...[...pickerBody.matchAll(/\bentry\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]),
			]),
		].sort()
		assert.ok(rosterFields.length >= 5, `抓到的清单字段太少（${rosterFields.length} 个）`)
		const defaultsRows = ok.payload.defaults.rows
		// 每一行都带**出处**与**删除那个动作的形态**（客户端据此挑动词，不许自己猜）：
		// 这个工作区里的角色全来自包内 ⇒ 一律 `package` + `hide`（下架，不是删除）。
		assert.ok(defaultsRows.every((row) => row.origin === 'package' && row.removal === 'hide'), JSON.stringify(defaultsRows[0]))
		assert.deepEqual(ok.payload.defaults.hiddenRows, [], '没下架过任何一个')
		assert.ok(Array.isArray(defaultsRows) && defaultsRows.length > 0, '载荷里要有 defaults.rows')
		const defaultsFields = new Set(defaultsRows.flatMap((item) => Object.keys(item)))
		const missingRoster = rosterFields.filter((field) => !defaultsFields.has(field))
		assert.deepEqual(missingRoster, [], `defaults.rows 里没有这些字段：${missingRoster.join('、')}`)
		// 清单就是名册减去被排除的角色（**同一个现场**，不硬写条数）。
		const expected = runtime.roleCatalog().filter((id) => id !== 'ontology')
		assert.deepEqual(defaultsRows.map((row) => row.role), expected)
		assert.deepEqual(ok.payload.defaults.excluded, ['ontology'])
		// 状态那一格（task-40 起的**唯一**来源）：**原生名册**里有 `reviewer-1` ⇒ reviewer 那一档是在场。
		// 角色靠 `<角色>-<序号>` 那处命名约定反读（与 `member_list` / `member_spawn` 同一套）——
		// 名字不合约定的成员（例如自定义名 `revi-1`）**不计入任何角色的编制**，这是"旧名册撤掉"的直接后果。
		const reviewerRow = defaultsRows.find((row) => row.role === 'reviewer')
		assert.equal(reviewerRow.state, 'present')
		assert.deepEqual(reviewerRow.present, ['reviewer-1'])
		// 默认名按**角色 id** 派生：`reviewer-1` 已经在场 ⇒ 下一个是 `reviewer-2`。
		assert.equal(reviewerRow.nextName, 'reviewer-2')
		// 工作区里没有任何角色根/名册文件也不影响这一栏（清单是现场枚举）——
		// 「名册建没建立」那个读数（`established`）说的是旧文件，随旧账一起撤了。
		const rosterBare = mkdtempSync(join(tmpdir(), 'team-ops-roster-bare-'))
		const bareRead = await read(rosterBare)
		assert.equal(bareRead.status, 200)
		assert.equal(bareRead.payload.defaults.established, undefined, '不再回旧名册的"建没建立"')
		assert.equal(bareRead.payload.defaults.rows.length, expected.length)
		// 编制读数的来源是**本会话的原生名册**（session 级，不按工作区分）⇒ 换工作区也一样看得到它。
		assert.deepEqual(
			bareRead.payload.defaults.rows.filter((row) => row.state === 'present').map((row) => row.role),
			['reviewer'],
			'在場只跟原生名册走：' + JSON.stringify(bareRead.payload.defaults.rows.filter((row) => row.state === 'present').map((row) => row.role)),
		)

		// 未读数那一格的两条口径（都与"把它印成 0"相反）：
		// ① 邮箱文件**还没建立**（文件不在）是正常状态：不写 `mailbox_unread`，也**不告警**；
		// ② 邮箱文件**在但读不成**：同样不写这个键，但**必须告警** —— 读不到不许静默。
		// 这两条核的是**行**上的那一格（现在只有 `merged` 这一份行）。
		const bare = mkdtempSync(join(tmpdir(), 'team-ops-members-block-bare-'))
		const notBuilt = await read(bare)
		assert.equal(notBuilt.status, 200, JSON.stringify(notBuilt.payload))
		assert.equal(Object.hasOwn(notBuilt.payload.merged[1], 'mailbox_unread'), false, '邮箱文件还没建立时不许写「未读 0」')
		assert.ok(!notBuilt.payload.warnings.some((line) => line.includes('邮箱文件读不到')), '文件不在是正常状态，不该告警')
		const broken = mkdtempSync(join(tmpdir(), 'team-ops-members-block-broken-'))
		writeFileSync(join(broken, '.company-gate.mailbox.json'), '{ 这不是 JSON')
		const unreadable = await read(broken)
		assert.equal(unreadable.status, 200, JSON.stringify(unreadable.payload))
		assert.equal(Object.hasOwn(unreadable.payload.merged[1], 'mailbox_unread'), false, '邮箱读不到时不许写「未读 0」')
		assert.ok(unreadable.payload.warnings.some((line) => line.includes('邮箱文件读不到')), '读不成要说出来，不许静默')
	})

	test('"停用"的话四处同口径（task-57）：本插件不再派活 + 宿主原生界面里仍可对话（含 README）', () => {
		// 人报的现场：停用的成员在**宿主原生界面**里照样能点开对话 ⇒ 这不是能修的 bug，是**边界**。
		// 于是口径统一成一句：**只在本插件生效**、**宿主界面里仍可对话**。四处都要有这半句。
		const rt = readFileSync('team/team-runtime.js', 'utf8')
		const host = readFileSync('lib/board-view.host.js', 'utf8')
		const client = readFileSync('lib/board-view.client.js', 'utf8')
		const readme = readFileSync('README.md', 'utf8')
		// 四处的判定条件：**文案里必须同时出现这两半句**（按句核，不看"全篇出现过某个词"）
		const sites = [
			// **两半都要**（task-59 补强：只要求"宿主界面"那一半时，把"本插件不再派活"那半换掉 0 红）
			['member_send 拒绝文案', rt, /「\$\{target\}」已被\*\*停用\*\*[\s\S]{0,400}?\*\*本插件不再派活给它\*\*[\s\S]{0,200}?宿主原生界面里仍然可以打开对话/],
			['member_list 的 disabledNote', rt, /disabledNote: '[^']*本插件不再派活给它[^']*宿主原生界面里仍然可以打开对话/],
			['停用回执 note', host, /已标成\*\*停用\*\*[\s\S]{0,400}?宿主原生界面里仍然可以打开对话/],
			['面板整栏那句', client, /「停用」只在本插件的调度层生效[\s\S]{0,200}?宿主原生界面里仍然可以打开对话/],
			['README 停用一节', readme, /「停用」只在本插件的调度层生效[\s\S]{0,200}?宿主原生界面里仍然可以打开对话/],
		]
		for (const [what, text, pattern] of sites) {
			assert.match(text, pattern, `${what} 要同时说清"本插件不再派活"与"宿主原生界面里仍可对话"`)
		}
		// 旧的含糊写法**0 命中**（判定条件写在同一处注释里）
		assert.ok(!/不再接活/.test(rt.replace(/grep[^\n]*不再接活[^\n]*/g, '')), 'team-runtime 里不许再有"不再接活"这种含糊写法')
		// 已停用徽标也要带同一口径（title 悬停给全句）
		assert.match(client, /它在宿主原生界面里仍然可以打开对话/, '已停用徽标要给同一句口径')
	})

	test('三词口径扫尾（task-61）：`team/**`、`lib/**`、`README.md` 里不再出现泛指的「名额」', () => {
		// 三词 = `角色槽位`（同角色未停用且非 failed，≤3，**停用腾它**）/ `在场总人数`（名册行数，含 failed 含停用，≤24，
		// **停用腾不了它**）/ `原生名册行`（只增不减，谁也腾不了，只能开新会话）。**泛指的"名额"不许再出现** ——
		// 它不指明是哪一条，正是 2.2.3 要消掉的那种含糊。
		const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = join(dir, entry.name)
			return entry.isDirectory() ? walk(path) : [path]
		})
		// BASELINE 单独核（它在 `team/` 下，但它那条**判定条件**里"名额"是"不许再用"的引用 ⇒ 允许出现一次，见下）
		const files = [...walk('team'), ...walk('lib'), 'README.md']
			.filter((path) => path.endsWith('.js') || path.endsWith('.md'))
			.filter((path) => path !== 'team/BASELINE.md')
		assert.ok(files.length > 10, '扫的文件数看着不对：' + files.length)
		const offenders = files.filter((path) => readFileSync(path, 'utf8').includes('名额'))
		assert.deepEqual(offenders, [], '这些文件里还有泛指的「名额」（要写成角色槽位 / 在场总人数 / 原生名册行）：' + offenders.join('、'))
		// 正面钉法：三词各自真的要在这批文本里出现（不是"全篇没有旧词"就算过）
		const all = files.map((path) => readFileSync(path, 'utf8')).join('\n')
		for (const term of ['角色槽位', '在场总人数', '原生名册行']) {
			assert.ok(all.includes(term), `三词之一没在这批文本里出现：${term}`)
		}
		// BASELINE 里唯一允许出现"名额"的地方 = 那条**判定条件**（"不许再用"的引用），不是正文用词
		const baseline = baselineCorpusOf()
		const hits = baseline.split('名额').length - 1
		assert.equal(hits, 1, 'BASELINE 里"名额"只许出现在那条判定条件里（实际 ' + hits + ' 处）')
		assert.ok(baseline.includes('**不许**再用"名额"这种不指明是哪一条的写法'), '那条判定条件要逐字在')
	})

	test('**五处"停用的话"平铺钉住**（task-60）：整句逐段，中段任一子句被换 ⇒ 红', () => {
		// 方法（写在这里防复发）：**文本确定的断言就整句逐字钉**；这里用"把整句切成连续片段、逐段要求命中"的写法 ——
		// 切成片段仍然覆盖**整句**（片段之间无缝隙）：中段任一子句被换掉，必然打断相邻片段 ⇒ 红。
		//
		// **变异前必须先确认原句存在**（协调者本轮踩过的坑）：探针脚本若不做存在性守卫，会把"锚点没找到"
		// 误读成"没钉住"，得出假结论。本文件的变异脚本一律先 `assert.ok(src.includes(old))` 再改。
		const rt = readFileSync('team/team-runtime.js', 'utf8')
		const host = readFileSync('lib/board-view.host.js', 'utf8')
		const client = readFileSync('lib/board-view.client.js', 'utf8')
		const readme = readFileSync('README.md', 'utf8')

		const SITES = [
			[
				'① member_send 拒绝文案（整句）',
				rt,
				[
					'error: `「${target}」已被**停用**（本插件的视图状态）：',
					'**本插件不再派活给它**（不占角色槽位、不被自动复用）；',
					'**它在宿主原生界面里仍然可以打开对话** —— 「停用」只在本插件的调度层生效，不是把这个人从原生名册里拿掉。',
					'先恢复再派活：面板「成员」那一张卡上的「恢复」，或 POST',
				],
			],
			[
				'② member_list 的 disabledNote（整句）',
				rt,
				[
					"disabledNote: '本插件已把它标成停用：**本插件不再派活给它**（不占角色槽位、不被自动复用、`member_send` 会拒）；",
					'**它在宿主原生界面里仍然可以打开对话**；面板上可恢复',
				],
			],
			[
				'③ 停用回执（整句，两个分支）',
				host,
				[
					"? '已标成**停用**（本插件的视图状态）：**本插件不再派活给它**（不占角色槽位、不被自动复用、`member_send` 会拒）；",
					'**它在宿主原生界面里仍然可以打开对话** —— 「停用」只在本插件的调度层生效，宿主没有移除 / 停用成员的接口。随时可以恢复。',
					": '已**恢复**：重新占这一档的角色槽位、也能重新接活（恢复不设任何上限）。'",
				],
			],
			[
				'④ 面板整栏那句 + 已停用徽标 title',
				client,
				[
					"'**停用**（**本插件不再派活给它**、不占角色槽位，随时可恢复）、**恢复**、**打断**（只断当前那一轮，收件箱保留、两条上限都不变；",
					"title: '本插件不再派活给它（不占角色槽位）；它在宿主原生界面里仍然可以打开对话',",
					'**「停用」只在本插件的调度层生效 —— 被停用的人在宿主原生界面里仍然可以打开对话**（宿主没有移除 / 停用成员的接口）；同一档**至少留 1 位**未停用。',
				],
			],
			[
				'⑤ README 停用一节（整句）',
				readme,
				[
					'**「停用」只在本插件的调度层生效**：被停用的人在**宿主原生界面里仍然可以打开对话**',
					'（宿主没有移除 / 停用成员的接口，**原生名册行只增不减**）—— 要把一个人从会话里彻底隔离，只能**开新会话**。',
					'**本插件不再派活给它**、**不占角色槽位**',
				],
			],
		]
		for (const [what, text, fragments] of SITES) {
			for (const fragment of fragments) {
				assert.ok(text.includes(fragment), `${what} 缺了这一截（整句是切段钉的，中段改了就该红）：${fragment.slice(0, 50)}`)
			}
		}

		// **术语口径**：这五处用的必须是 `角色槽位`（三词之一），旧含糊词（`编制名额` / 孤零零的 `名额`）不许回。
		// 断言**只覆盖这五处**（不是整个文件）：文件里别处的旧词属于"顺手核一遍同类"的**报告**范围，不在本单动正文。
		for (const [what, text, fragments] of SITES) {
			const joined = fragments.join('')
			assert.ok(!joined.includes('编制名额'), `${what} 不许出现旧含糊词「编制名额」`)
			assert.ok(!/不占同角色名额|不占名额/.test(joined), `${what} 要说清是"角色槽位"而不是含糊的"名额"`)
		}
		// 正面钉法：这五处里"槽位/总人数/名册行"三个词按需出现（不是只靠"没有旧词"）
		assert.ok(SITES[0][2].join('').includes('不占角色槽位'), '拒绝文案要写"不占角色槽位"')
		assert.ok(SITES[4][2].join('').includes('原生名册行只增不减'), 'README 要用「原生名册行」')
		assert.ok(SITES[3][2].join('').includes('两条上限都不变'), '面板要用"两条上限"而不是"名额"')
		// 三个术语各自在运行期文本里出现（正面钉法：不许只靠"没有旧词"）
		assert.ok(rt.includes('角色槽位'), '运行期文本要用「角色槽位」这个词')
	})

	test('**规则清单**（task-71 拆层验收 / task-75 升到逐句）：BASELINE 拆两层后，**61 条编号规则的每一句本体**都不丢', () => {
		// 本单把 BASELINE 拆成两层：**正文只留规则/动作**，长表 / 举例 / 现场教训 / 理由进 `team/rules/*.md`。
		// 这份清单 = **拆层前** BASELINE 里每一个**编号条目**的标志性开头（56 条，逐节覆盖）。
		// 核的判据：该短语在**语料**（BASELINE + rules/*）里**仍然存在** —— 位置可以变，规则不许丢。
		const strip = (text) => String(text).replace(/\*\*/g, '').replace(/`/g, '')
		const RULES = [
			["一、作用域与角色 §1", [{ text: "本基线只在本团队的会话里生效（团队能力随插件装载，与\"选了哪个预设\"无关）", inBaseline: true }]],
			["一、作用域与角色 §1", [{ text: "层级（三档，从高到低）： 工作区 AGENTS.md > 本基线 > 角色 ROLE.md —— 本基线的定位是默认宪法（没被覆盖时按它办）； 工作区 AGENTS.md 明确覆盖某一处时以它为准，且那处覆盖关系要在 AGENTS.md 里点名（写清\"覆盖本基线哪一条\"）", inBaseline: true }]],
			["一、作用域与角色 §1", [{ text: "判定条件（可当场核）：AGENTS.md 里若要覆盖，必须出现 覆盖本基线 字样并点名条号（§<节>.<条>）；只写\"以本文件为准\"而不点名 ⇒ 不合格（那会让\"谁说了算\"重新变成两说）", inBaseline: true }]],
			["一、作用域与角色 §2", [{ text: "协调器 = 主会话（lead），它不是名册里的一个角色；名册里的都是被叫起来的成员", inBaseline: true }]],
			["一、作用域与角色 §2", [{ text: "只有协调器能做的三件事：① 看板的登记与裁决类写入、名册写入（member_spawn / member_list）；② 向人提问；③ 收口上报（各动作名见 board_task 的参数表）", inBaseline: true }]],
			["一、作用域与角色 §2", [{ text: "向人提问一律由协调器发出：成员（含校验成员与执行角色）只提交\"问题包 / 决策包正文\"给协调器，由协调器发出； 成员不直接向人提问（这一条与 §四 3b 同口径）", inBaseline: true }]],
			["一、作用域与角色 §3", [{ text: "执行角色做其余部分：干活、把结论与产物落文件、如实申报没拿到的输入", inBaseline: true }]],
			["一、作用域与角色 §3", [{ text: "不代发起轮次、不代人投票、不代替协调器收口、不改别人的看板条目", inBaseline: true }]],
			["一、作用域与角色 §4", [{ text: "本文件里出现的角色名，只表示\"当前由谁承接这个动作\"：角色清单现场枚举（见下一节），某角色被删掉或被停用时，这些动作交给承接它的角色即可 —— 本文件一个字都不用改", inBaseline: true }]],
			["二、怎么派活 §1", [{ text: "所有外部任务经协调器进来；角色不直接对外承诺、不自行开新方向，跨角色的事回传给协调器转派", inBaseline: true }]],
			["二、怎么派活 §1b", [{ text: "动手前先报规模（三档，判据是\"这件事要写下来的东西有多少\"，不是\"我感觉多难\"）： ① 小任务 —— 一句话能说清做什么与怎么算成 ⇒ 直接做，做完回报； ② 小改动 —— 动一处、但要交代清楚改哪里与改成什么样 ⇒ 在派活消息里用自然语言写清（不在看板条目里写小作文）； ③ 需要书面设计 —— 触发条件：手上没有已批规格时，命中以下任一：跨角色 / 跨轮（一次做不完、要分几段） / 改口径（改的是既定判据或方向） / 不可逆取舍 ⇒ 先出设计文档再动手（需求侧用 US- 与验收标准、 技术决策用 ADR，校验器 check_artifact 现成可用），人批准后才开工（§三 5c 的闸门）", inBaseline: true }]],
			["二、怎么派活 §1b", [{ text: "「多个文件」只是信号，不单独触发 ③ —— 它提醒你看一眼影响面；真正把你推进 ③ 的是上面那四条", inBaseline: true }]],
			["二、怎么派活 §1b", [{ text: "规模在一单中途变大 ⇒ 立刻停下、报人、按新的档位重走 —— 不许\"做着做着就变大了\"", inBaseline: true }]],
			["二、怎么派活 §1b", [{ text: "判据的实质是\"动手前要不要写一份给人看的东西\"：已经有一份被批准的规格时 （人给的清单、复核对照表、已批的设计文档）⇒ 按它直接做，不因\"多文件 / 改口径\"再回到 ③ 档补文档； 反过来，没有那份东西、又是跨角色 / 跨轮 / 改口径 / 不可逆取舍之一 ⇒ 先补规格再动手", inBaseline: true }]],
			["二、怎么派活 §1b", [{ text: "判定条件（可当场核）：grep -n '只是信号，不单独触发' team/BASELINE.md team/team-runtime.js —— 两处都要有； 且两处都不许再出现\"多文件 …即第③档\"这类把文件数当判据的写法", inBaseline: true }]],
			["二、怎么派活 §2", [{ text: "先登记，再派人：任务登记走 board_task（真相源 = DSH 原生 Agent Teams 的队伍日志，按会话；.company-gate.board.json 是迁移前的遗留文件，不再更新，别拿它当账）；长文详表落 docs/team/tasks/<任务号>.md；任务号由协调器分配，开发与经营侧同一张看板", inBaseline: true }]],
			["二、怎么派活 §3", [{ text: "拆单：需求拆解（可交付节点 + 出口准则 + 依赖顺序）之后，先由 architect 把每个节点拆成开发任务并成单，再交协调器派发", inBaseline: true }]],
			["二、怎么派活 §4", [{ text: "任务包用 5W2H，七项必须齐（这是派活的规范，不许套到产物上）：", inBaseline: true }]],
			["二、怎么派活 §4b", [{ text: "每一档都有一位主成员（这一档最早来的那位在场成员；面板卡片上有「主成员」徽标）：", inBaseline: true }, { text: "主线活优先派给它 —— 它上下文里有工作区的全貌，复用不付冷启动；边角活给同角色的第二位成员", inBaseline: false }]],
			["二、怎么派活 §4b", [{ text: "只有这两条同时成立才值得新建一位：这条活自包含，且它读的东西与主线几乎不重叠", inBaseline: false }]],
			["二、怎么派活 §4b", [{ text: "每次新建都要付一次完整冷启动（系统提示、角色定义、协作纪律都要重新加载，且没有缓存命中）， 所以\"一任务一成员、干完就退役\"通常是最贵的一种用法", inBaseline: false }]],
			["二、怎么派活 §4b", [{ text: "三条上限，三个词，全篇只许这么叫（混用就会被读成同一件事）： - 角色槽位 = 同一角色里未停用且非 failed 的人数，上限 3 ⇒ 停用腾的是它； - 在场总人数 = 名册行数（含 failed、含停用者），上限 24 ⇒ 停用腾不了它（宿主的硬拒按 state.members.length 数全部名册行；24 是独立硬上限，宿主那份 profile 的 maxMembers 已覆盖成同值 ——「3 位 × 8 角色」只是历史来源一句话，不再是判据：角色种类现场枚举、可增可减）； - 原生名册行 = 只增不减（宿主没有移除接口）⇒ 谁也腾不了它；要一份干净名册只能开新会话", inBaseline: true }]],
			["二、怎么派活 §4b", [{ text: "到顶就拒新建；line_reason 只能越过插件的软上限（角色槽位 3 位），越不过宿主的硬上限（在场总人数 24） （拦而不封、理由留痕）", inBaseline: true }]],
			["二、怎么派活 §4b", [{ text: "撞线时的正确动作是派给现有的那几位（member_list 里读得到）；不用的队友不再派活即可", inBaseline: true }]],
			["二、怎么派活 §4b", [{ text: "\"停旧建新\"只在角色槽位满时有用（本插件这一层判的）——在场总人数满时无效：那时停用腾不了在场总人数， 唯一的路是开新会话（或先把总人数降下来）", inBaseline: true }]],
			["二、怎么派活 §4b", [{ text: "两条边界：同一档至少留 1 位未停用（把一档全停会被拒）；被停用的人在原生名册里仍然在， 所以\"停用\"是本插件这一层的视图状态，不是原生事实 —— 面板与回执都这么写", inBaseline: true }]],
			["二、怎么派活 §4b", [{ text: "打断只断它当前那一轮（收件箱保留、两条上限都不变）", inBaseline: true }]],
			["二、怎么派活 §4b", [{ text: "判定条件（可当场核）：grep -n '角色槽位|在场总人数|原生名册行' team/BASELINE.md 三个词都要出现在这一段； 「停用腾的是角色槽位、腾不了在场总人数」这句要逐字在；且全篇不许再用\"名额\"这种不指明是哪一条的写法", inBaseline: true }]],
			["二、怎么派活 §4c0", [{ text: "角色与技能都分作用域：缺省写本工作区（角色 <工作区>/.dsh/team-ops/roles/、技能 <工作区>/.dsh/skills/，只影响这个项目）；", inBaseline: true }, { text: "显式 scope: \"user\" 才写全局（~/.dsh/…，所有工作区可见）", inBaseline: true }]],
			["二、怎么派活 §4c0", [{ text: "枚举顺序：工作区根 > 用户根 > 包内（同名高处赢）", inBaseline: true }]],
			["二、怎么派活 §4c", [{ text: "member_send 对空闲的队友会唤醒或冷恢复，所以\"它现在没在跑\"不是失败；", inBaseline: true }, { text: "真发不出去时先看原因（服务不在 / 目标名不对 / 队伍没成队），别急着新建一位 —— 同角色上限拦得住，", inBaseline: true }, { text: "但那是在浪费一个角色槽位", inBaseline: true }]],
			["二、怎么派活 §4c", [{ text: "原生名册没有\"归档 / 退役 / 删除\"这几档：不用的队友不再派活即可，", inBaseline: true }, { text: "名字在名册里永久占位（原生名册行谁也腾不了 —— 要一份干净名册只能开新会话", inBaseline: true }, { text: "，见 4b 那三个词）", inBaseline: false }]],
			["二、怎么派活 §5", [{ text: "执行权归角色：协调器只调度不代庖（不替角色写代码、不替角色下结论）；越界产物退回，不代表该角色结论", inBaseline: true }]],
			["二、怎么派活 §6", [{ text: "选型与设计先答\"不这么做会怎样\"：答不上来就别做（别为模式而模式、别为抽象而抽象）；答案是判断的，按 §四落 ADR 或决策包 —— 简单方案够用就用简单的", inBaseline: true }]],
			["三、什么时候必须问人 §1", [{ text: "命中任一即停手，由协调器用 ask_user_question 问；问题、依据、备选方案、推荐方案一起给", inBaseline: true }]],
			["三、什么时候必须问人 §1", [{ text: "提问分两类，形状不同： - 探索性提问（还不懂人要什么）⇒ 一条消息只留一个问题、句尾一个问句（见 §八「问问题也有形状」）； - 审批 / 确认清单（已经懂了、等人点头）⇒ 一条可多项，但必须逐项编号、每项一个待确认句、每项给推荐， 且只此一轮（§四 3b 的校验确认走这一档）", inBaseline: true }]],
			["三、什么时候必须问人 §1", [{ text: "判定条件（可当场核）：一条消息里出现两个以上问号、且不是逐项编号的清单 ⇒ 不合格（那既不是探索性、也不是审批清单）", inBaseline: true }]],
			["三、什么时候必须问人 §2", [{ text: "审批号 = 「人的话」里那一条 HD-<三位序号>（human_words_record 的返回值）—— 谁生成 / 什么格式 / 记在哪 / 没号怎么办，一次写全： - 谁生成：协调器（人答复后当场记录，再按答复执行）； - 什么格式：/^HD-d+$/（HD- + 序号，序号由工具给，不自造）； - 记在哪：.company-gate.human.json（本产品唯一记人判断的文件；human_words_list 现读）； - 没号怎么办：人答了但没记 ⇒ 当场记录再执行（不许\"没号也干\"，也不许拿别的号顶上）", inBaseline: true }]],
			["三、什么时候必须问人 §2", [{ text: "任何角色（含协调器）都不得替人决定这四类事；人没答之前不推进、不落不可逆结果，人答了按答复范围执行，超范围重新问", inBaseline: true }]],
			["三、什么时候必须问人 §3", [{ text: "人的答复要不要留痕由人定：说「记下这句」就用 human_words_record 记进「人的话」文件（本策略节的审批号是人的决定那一类，见上）", inBaseline: true }]],
			["三、什么时候必须问人 §4", [{ text: "争议在角色层收不住、或风险不可逆 ⇒ 暂停相关动作并问人", inBaseline: true }]],
			["三、什么时候必须问人 §5", [{ text: "问题本身模糊（要什么、判据是什么、算不算合格都说不清）⇒ 先问清再动，不要拿假设开工；问清之后按 §二 派活", inBaseline: true }]],
			["三、什么时候必须问人 §5b", [{ text: "反过来也成立：关键信息已经给足（要什么、改成什么样、怎么算成都说清了）⇒ 直接做 —— 不许再拿\"要不要这样\"\"是否确认\"去消耗人", inBaseline: true }]],
			["三、什么时候必须问人 §5b", [{ text: "\"人没说\"的（形状 / 控件类型 / 参数含义与默认值 / 命名）才要问，见 5d", inBaseline: false }]],
			["三、什么时候必须问人 §5c", [{ text: "动手前的闸门：人正式批准\"完整描述\"之前，不许启动开发 —— 不写业务代码、不建脚手架、不装依赖、不调实现类能力", inBaseline: true }]],
			["三、什么时候必须问人 §5c", [{ text: "合法的只有两件：只看与探索，以及人明确同意、且标注为\"可丢弃\"的快速验证原型（原型不进发布面、不写完整用例", inBaseline: true }, { text: "、不追求稳定； 要从原型继续往下做 ⇒ 当新需求重走本节闸门）", inBaseline: false }]],
			["三、什么时候必须问人 §5d", [{ text: "三类\"看起来小、改错了要返工\"的东西必须先问：界面形状 / 控件类型 / 参数含义（含改名与改默认值） —— 人没点头就等于没定，不许\"顺手\"改", inBaseline: true }]],
			["三、什么时候必须问人 §5d", [{ text: "四问（①–④）与 5c 的闸门不可豁免：人可以选\"跳过提问环节\"，跳过的只是提问，", inBaseline: true }, { text: "不是闸门；也不能因为\"人之前说这个想法不错\"就算批准 —— 口头认可只覆盖当时展示的内容", inBaseline: true }]],
			["四、验收、复核、放行 §1", [{ text: "qa 有验收权（可打回返工），质量争议以它为准；优先级冲突由 po 裁决；技术决策落 docs/adr/（ADR），未落 ADR 的技术方向视为未定", inBaseline: true }]],
			["四、验收、复核、放行 §1", [{ text: "打回 = 开一条新任务并关联原任务号（新任务里写清\"打回自 task-<原号>\"+ 不合格的判据）；原任务保持已完成， 不许把它改回进行中 —— 原生只有三态（待办 / 进行中 / 已完成），\"复核中 / 已打回\"是我们这一层的视图标签， 不是原生态", inBaseline: true }]],
			["四、验收、复核、放行 §1", [{ text: "判定条件（可当场核）：对一条已完成的任务跑 board_task action=reopen ⇒ 不该出现 \"原任务被重开、返工件事无新任务\"这种账；正确形态是：query 里多出一条新任务、旧条仍是已完成", inBaseline: true }]],
			["四、验收、复核、放行 §1b", [{ text: "出口准则里必须有一条\"能跑的动作\"：定出口准则的人写清用什么命令起、跑哪一条真实请求、看到什么算过；", inBaseline: true }, { text: "qa 验收时拿不到这条动作的原始输出就不放行", inBaseline: false }]],
			["四、验收、复核、放行 §1b", [{ text: "纯静态检查（lint、单测、类型检查）不能替代它 —— \"各自都完成、合起来跑不起来\"是这类项目最常见的翻车点，而它只有真跑一遍才看得见", inBaseline: false }]],
			["四、验收、复核、放行 §2", [{ text: "角色之间结论冲突 ⇒ 交协调器指派裁决角色，裁决结论落文件；执行角色把冲突原样写进未核实项，不阻塞其余部分", inBaseline: true }]],
			["四、验收、复核、放行 §3", [{ text: "高风险产物走独立复核：起一个独立成员（member_spawn role=reviewer，或按领域的 qa / security），把那笔复核作为看板上一笔独立的活登记与交付 —— 复核成员不得是执行它的同一个人", inBaseline: true }]],
			["四、验收、复核、放行 §3", [{ text: "值得复核的：安全 / 权限类设计与评审、ADR、发布放行门禁、测试计划与出口准则依赖的关键产物、AI 评测基线与合规产物", inBaseline: false }]],
			["四、验收、复核、放行 §4", [{ text: "发现不等于开工（现场教训：复核每轮都能找出东西，而\"每条都开一条任务\"会让待办自己长下去）： 只把改变行为或人可见结果的发现开成任务；维护性（同一判定有两处、重复正文）、措辞、 已知天花板类发现记进文档（验证记录里写清\"记录不做\"+判据），不改代码、不开条目", inBaseline: false }]],
			["四、验收、复核、放行 §4", [{ text: "判断句式：这条修的是\"人看到的东西会变\"，还是\"以后改起来省点事\"？只有前者值得开工", inBaseline: false }]],
			["四、验收、复核、放行 §4b", [{ text: "\"同一口径两处不一致\"算哪一类？ 只有一个判据：两处写法不同但判定相同 ⇒ 维护性，记档不开工； 两处判定不同、会让同一件事有两种合规做法 ⇒ 行为问题，必须开工对齐 —— 因为\"双合规\"会直接改变 谁被放行、什么被接受，它属于\"人看到的东西会变\"那一类", inBaseline: true }]],
			["四、验收、复核、放行 §4b", [{ text: "（§十.1\"不在规格里就不在产品里\"管的是新增功能， 不是口径对齐，两者不冲突", inBaseline: true }]],
			["四、验收、复核、放行 §4b", [{ text: "） 判定条件（可当场核）：拿同一份产物，按两处各自的判定条件各判一次 —— 结论不一致（一处放过、一处退回） 就是\"双合规\" ⇒ 按本条必须开工对齐（不许记档了事）；两处结论一致、只是措辞不同 ⇒ 维护性，记档", inBaseline: true }]],
			["四、验收、复核、放行 §4b", [{ text: "已消掉的一处实例：§五.4（代码那一档）与 §八之一（所有给人看的文档）适用范围互不重叠（见 §五.4 与 §八之一各自那句\"管什么/不管什么\"）", inBaseline: true }]],
			["四、验收、复核、放行 §3b", [{ text: "规格级的\"开发视角\"校验（与产物复核是两件事；与上面第 3 条\"高风险产物走独立复核\"不是同一道门 —— 这条只审设计文档、只在 §二 1b 的第 ③ 档做）：书面设计出完、交给人之前，", inBaseline: true }, { text: "先让一名没参与这份设计的成员站在\"资深开发\"的立场通读一遍", inBaseline: true }, { text: "，把问题分三类：① 已解答（对话或背景里已有答案 ⇒ 直接补进文档）； ② 次要细节（资深开发可自主决定、不影响成品 ⇒ 由校验者定，并在文档里标注\"这是独立决策\"）； ③ 必须人确认（只有人能答、且答案会改变成品形态）", inBaseline: false }]],
			["四、验收、复核、放行 §3b", [{ text: "③ 类按审批 / 确认清单那一档整理（§三.1）： 逐项编号、每项一个待确认句、每项给推荐、按重要性从高到低排，只此一轮； 这条清单由协调器发出（校验成员只提交问题包正文，不直接向人提问 —— 与 §一.2 同口径）", inBaseline: false }]],
			["四、验收、复核、放行 §3b", [{ text: "交付文档时附一份\"我自主决定的清单\"，让人一眼核对", inBaseline: false }]],
			["四、验收、复核、放行 §3b", [{ text: "没有可用的独立成员时，协调器自己站这个视角通读一遍", inBaseline: false }]],
			["四、验收、复核、放行 §5", [{ text: "放行 ≠ 干活：审查状态不进交付物正文 —— 它记在外部记录里：看板条目 / docs/team/tasks/T-<序号>.md / 复核记录", inBaseline: true }]],
			["四、验收、复核、放行 §5", [{ text: "取值就两种：未审（默认，正常状态，不因它判产物未完成）／已复核（见复核任务 <T-序号>）（只能由复核成员交付的记录产生，不许自判、不许自造号）", inBaseline: true }]],
			["四、验收、复核、放行 §5", [{ text: "为什么移出去：交付物正文有一条\"不写内部编号与状态自述\"的铁律（§八之一）， 审查状态是系统坐标，写进正文就与那条铁律直接打架 —— 两处只留一处说法：记在记录里", inBaseline: true }]],
			["四、验收、复核、放行 §5", [{ text: "判定条件（可当场核）：把交付物前十行摊开 —— 出现 未审 / 已复核 字样 ⇒ 不合格（判定面与 §八之一 同）", inBaseline: true }]],
			["四、验收、复核、放行 §6", [{ text: "动手前先审（与第 3 条的事后复核是两件事", inBaseline: true }, { text: "，别互相替代）：动手前写清四样 —— 改动面（碰哪些文件）/ 谁受影响（谁会因此改）/ 复用与重复（能不能用已有的，别写第二份）/ 代价（时间、体量、风险）", inBaseline: false }]],
			["五、看板纪律（登记 / 结账 / §1", [{ text: "条目最多 3 行、一句话 ≤60 字，写成果不写过程，且不熟悉这件事的人也读得懂（合格", inBaseline: true }, { text: "：「把上游原文移出发布面，包里只留最小文件」）", inBaseline: false }]],
			["五、看板纪律（登记 / 结账 / §2", [{ text: "活干完就结账（硬要求）：执行者 complete（原生只有 待办 / 进行中 / 已完成 三态）；要独立复核就另开一条任务派给复核的角色 —— 复核的结论写进回报或那条任务里，本任务照常 complete", inBaseline: true }]],
			["五、看板纪律（登记 / 结账 / §2", [{ text: "打回也一样：返工开新任务、关联原任务号，原任务保持已完成（§四.1）；\"复核中 / 已打回\"是视图标签，不落原生三态", inBaseline: true }]],
			["五、看板纪律（登记 / 结账 / §3", [{ text: "状态由机制推送（lib/ledger-digest.js 那行钩子在会话开局与每次提示词提交时注入四份文件的状态）⇒ 不需要\"每次发言前先读文件\"", inBaseline: true }]],
			["五、看板纪律（登记 / 结账 / §3", [{ text: "仍需自己做的两类：人问「现在到哪了」时现读一次并回一句话（team_status）；要写\"这条在谁手上 / 有没有卡住\"前，若距最近注入已过几轮就当场重读（board_task action=query），不许复用更早的读数", inBaseline: true }]],
			["五、看板纪律（登记 / 结账 / §4", [{ text: "交付物里只写它本身的事：过程编号（任务号 / 成员号 / 里程碑号）与过程叙述（\"这是哪一次改的\"）一律移出交付物，写进交付记录", inBaseline: true }]],
			["五、看板纪律（登记 / 结账 / §4", [{ text: "本条只管\"代码那一档\"：判定面 = team/、lib/、README.md 三处（那三处里的注释与代码正文照本条办）", inBaseline: true }]],
			["五、看板纪律（登记 / 结账 / §4", [{ text: "给人看的文档形态交付物（含 docs/team/）不归本条判 —— 归 §八之一（它覆盖所有给人看的文档形态交付物， 判定条件是\"前十行出现编号即不合格\"，不限路径）", inBaseline: true }]],
			["五、看板纪律（登记 / 结账 / §4", [{ text: "两套适用范围互不重叠： 代码 → 本条；文档（任何路径下的 docs/ 也算）→ §八之一", inBaseline: true }]],
			["五、看板纪律（登记 / 结账 / §4", [{ text: "判定条件（可当场核）：一份 docs/team/ 里的判断类文档出现过程编号 ⇒ 按 §八之一 判不合格 （不许拿\"它不在 team/、lib/、README.md 里\"来放过 —— 那不是本条的判定面）", inBaseline: true }]],
			["五、看板纪律（登记 / 结账 / §5", [{ text: "派活与登记时固定报三样（不加字段、不加工具，写进 description 就够）：规模档（§二 1b 的 ①/②/③）、规格状态（未批 / 已批 —— 未批即不许动手）、是否可丢弃原型", inBaseline: true }]],
			["五、看板纪律（登记 / 结账 / §5", [{ text: "档位限定：「规格状态」这一栏仅第③档适用（①② 档本来就没有规格文档 ⇒ 如实写\"不适用\"，不是\"未批\"）—— 别让\"未批即不许动手\"与 §二 1b ①②\"直接做\"打架", inBaseline: true }]],
			["五、看板纪律（登记 / 结账 / §6", [{ text: "同一文件被两人改：靠机制兜，不靠锁 —— 工具层（read/edit/write）走宿主 fs 服务，三层：", inBaseline: true }, { text: "原子写 + 按文件串行（同一文件的两次改动不交错，不会写花）；版本守卫（带上\"上次观察到的那一版\"， 文件在你观察之后被改过 ⇒ 拒，报 FS_STALE_VERSION）；edit 还要求字面量唯一匹配 （内容已变 ⇒ FS_EDIT_NOT_FOUND / FS_AMBIGUOUS_EDIT，不带版本守卫也拒）；另有 dsh-fs-observation-policy：没读过的文件不许覆盖", inBaseline: false }]],
			["五、看板纪律（登记 / 结账 / §6", [{ text: "被拒的正确动作是 重读 → 把改动重建在新内容上 → 再试（不要原样重写）", inBaseline: false }]],
			["五、看板纪律（登记 / 结账 / §6", [{ text: "它管不到：bash / 格式化器 / 代码生成器 / 脚本（绕过工具层 ⇒ 没有版本检查）⇒ 那一半靠纪律： 看板 write_scopes（写具体文件，别写目录；提示性、不是锁）+ 同一文件串行派活（用 blocked_by）+ 协调器看最终 diff 并跑测试 + git 显式列路径（git add -A 会把别人正在写的 WIP 一起提交 —— 现场教训）", inBaseline: false }]],
			["七、落盘与移交 §1", [{ text: "自己目录 = 该角色 ROLE.md 的「落点（产出与落盘）」那一段逐条写出的路径", inBaseline: true }]],
			["七、落盘与移交 §1", [{ text: "落盘前先把「以 X 的 <路径> 为准」在 X 的那一段里核到，核不到就不写", inBaseline: true }]],
			["七、落盘与移交 §2", [{ text: "合法移交只有两种（都不改自查句语义）：① 回传协调器转派", inBaseline: true }, { text: "（产物落自己目录，回报路径 + 一句话摘要）——适用于接收方不明确或要先验收；② 直接写入对方目录并同时回报协调器——只在对方目录属于该产物类型时可用，回报要带三项字段：移交路径 / 接收角色 / 一句话内容", inBaseline: false }]],
			["七、落盘与移交 §3", [{ text: "跨角色的目录边界：由涉事角色在自己的 ROLE.md「落点」段里各写自己那一侧", inBaseline: true }, { text: "（本文件不复述具体路径 —— 那属于角色作业程序）；两边说法冲突 ⇒ 按 §四.2 交协调器裁决", inBaseline: false }]],
			["七、落盘与移交 §4", [{ text: "同一题只许有一份正文：一件事同时落在两个角色的题面上时（谁定稿、谁先出），由协调器指派先出哪一份、另一份引它；涉及钱与对外承诺的定稿一律走 §三上呈，不落任何角色目录", inBaseline: false }]],
			["七、落盘与移交 §5", [{ text: "多个角色承接一件事：按「先出的在前」办（前者的产物是后者的输入），各落各自目录、不互相代写", inBaseline: true }]],
			["定了之后 §1", [{ text: "〔探索性〕一条消息只留一个问题，句尾就一个问句；不附示例清单 —— 对方说\"你随便猜\"\"你觉得怎么好就怎么来\"、或明显卡住时，才给一个短清单", inBaseline: false }]],
			["定了之后 §2", [{ text: "用对方的词，不用流程黑话；别铺垫流程本身（「我先说明一下我们的流程」这类删掉）", inBaseline: false }]],
			["定了之后 §3", [{ text: "问题带上依据与一个可被纠正的猜测（「我猜你要的是 X，因为 Y 一直麻烦你，对吗？」比\"你想要什么\"有效得多）", inBaseline: false }]],
			["定了之后 §4", [{ text: "复盘确认环：某一块理解到能写成 200–300 字 的程度，就先把这段复述发出来、再问下一块（整场对话里\"复述确认\"与\"提问探索\"交替进行）", inBaseline: false }]],
			["定了之后 §4", [{ text: "整段里每一句都要么标「人确认」要么标「我方推测」，结尾问\"哪里错了、漏了什么\"", inBaseline: false }]],
			["定了之后 §4", [{ text: "只有标「人确认」的才许当作已定的前提 —— 我方推测写进产物，等于\"把人没说过的话写成他说过的\"，按 §八之一 不合格处理", inBaseline: false }]],
			["八之一、交付物是什么、怎么写 §1", [{ text: "标题与正文之间不许插任何块（引用块 / 分隔线 / 声明 / 自述）", inBaseline: false }]],
			["八之一、交付物是什么、怎么写 §2", [{ text: "不写这四类（它们是系统坐标，不是内容）： - 内部编号：T- / MB- / M-、角色 id； - 协作坐标：承接谁、见哪一份、上一份的链接； - 流程引用：「见 T-0XX 的落地清单」这种（要引就引产物路径 + 定位）； - 适用范围与口径声明、方法论自述、状态自述（「本文只做两件事…」「状态：…」）—— 其中审查状态（未审 / 已复核） 按 §四.5 记在外部记录里，不进正文", inBaseline: false }]],
			["八之一、交付物是什么、怎么写 §3", [{ text: "确实必要的信息（来源 / 口径 / 不确定性 / 免责）⇒ 放文末一小节，标题写清它是什么；同一口径全文只写一处", inBaseline: false }]],
			["八之一、交付物是什么、怎么写 §4", [{ text: "长度按\"读者要做的那个判断\"给，不按\"我这轮干了多少\"给：删掉的是铺垫、过程与已经说过的内容，不是把句子砍短", inBaseline: false }]],
			["八之一、交付物是什么、怎么写 §5", [{ text: "交付文档不是记账页：过程与读数进交付记录（看板条目 / docs/team/tasks/T-<序号>.md），不进文档正文；看板编号是系统坐标，它属于回报，不属于产物", inBaseline: false }]],
			["八之一、交付物是什么、怎么写 §6", [{ text: "交付物里不许留临时修复：TODO / FIXME /「以后再说」/「后续优化」/「暂不处理」都不是交付 —— 要么找到根因彻底解决，要么在回报里明说\"这条不做、为什么\"（写进未核实项），别把它埋在产物里等人踩", inBaseline: false }]],
			["八之二、人指出一处之后怎么办 §1", [{ text: "是一类（同一套写法 / 同一个习惯在别处也会犯）⇒ 同类一起扫，并给出扫描口径：判定条件 + 现场命令 + 原始输出", inBaseline: true }, { text: "（例：LC_ALL=en_US.UTF-8 grep -rn '关联看板：' <产物目录>）；扫出来的实例一并处理 —— 别等人第二次说", inBaseline: false }]],
			["八之二、人指出一处之后怎么办 §1", [{ text: "适用范围：这一条管的是人已经指出来的那一类", inBaseline: true }, { text: "（人指了一处、同类一并处理）；人没点名的界面 / 控件 / 参数不在这条里 —— 那类只许报告、要改先问（§三 5d）", inBaseline: false }]],
			["八之二、人指出一处之后怎么办 §2", [{ text: "然后写成规则：落到一处正文（本基线或对应角色的 ROLE.md），并写清\"什么算合格\"的判定条件 —— 下一轮不看这次对话也不会再犯", inBaseline: false }]],
			["八之二、人指出一处之后怎么办 §3", [{ text: "是一处（确实只此一个实例）⇒ 当场改掉，一句话说明改了什么", inBaseline: false }]],
			["八之二、人指出一处之后怎么办 §4", [{ text: "不许做的两件：只修被指出的那一个实例、当成\"这一份的问题\"（不许）；把规则只写在对话里（下一个会话读不到）（不许）", inBaseline: false }]],
			["十、规格链（spec → 计划 §1", [{ text: "两条铁律：① 不在规格里就不在产品里 —— 没写进规格的功能不许顺手做；② 实现中发现 ⇒ 回写规格与计划，不在代码里做临时补丁 （回写顺序：先规格、再计划、再任务、最后代码）", inBaseline: true }]],
			["十、规格链（spec → 计划 §2", [{ text: "分层，各管各的（防\"一处两个说法\"）：规格（要什么、验收标准）与 ADR（为什么这么定）是需求与决策的真相源； 看板条目是协作状态（谁在做、到哪一步）的真相源；产物路径写进条目，同一口径全文只写一处", inBaseline: true }]],
			["十、规格链（spec → 计划 §3", [{ text: "按规模触发：只有 §二 1b 的第 ③ 档（需要书面设计的活）才落规格与计划；①② 档不落文档，但形状与边界仍要在派活消息里写清", inBaseline: true }]],
			["十、规格链（spec → 计划 §4", [{ text: "产物形状用现成的：需求侧 US-<模块>-<序号>（含验收标准）、测试侧 TC-…、技术决策 ADR-<序号> —— 校验器 check_artifact 认这三种，出完当场自查一次（它是门禁，不是可选）", inBaseline: true }]],
			["十、规格链（spec → 计划 §5", [{ text: "本基线即项目宪法：出计划时要对照本文件校验一遍（§一 作用域 / §三 闸门 / §四 复核 / §五 看板 / §八 说话）； 已被 AGENTS.md 点名覆盖的部分除外（那种情况以 AGENTS.md 为准、不必改基线 —— 覆盖关系按 §一.1 点名条号）； 与基线冲突的方案先改基线或先问人，不许\"先做了再说\"", inBaseline: true }]],
		]
		// 每条 = **本体的一句**，被切成若干净片段（跨层的句子按"语料里确实存在的最大片段"切）。
		// **判据（task-77 收紧，堵死"被 rules 副本救活"）**：**凡在正文里能匹配到的片段，一律只读正文** ——
		// 正文里有的本体**必须留在正文**，`rules/` 里的副本**不许顶替**；只匹配到 `rules/` 的片段，仍按"语料里在即可"核。
		// 这样"同一句话正文 + rules 都有 ⇒ 删正文不红"这一类整体堵住，不必逐条人肉列举。
		// **反斜杠也归一**：判定条件里那些转义（如 grep 的 `\|`）两侧一样处理，比较才稳。
		const flat = (text) => strip(text).replace(/\\/g, '').replace(/\s+/g, ' ').trim()
		const normalizedCorpus = flat(baselineCorpusOf())
		const normalizedBaseline = flat(readFileSync('team/BASELINE.md', 'utf8'))
		// **判据（task-77）**：片段带回 `inBaseline: true` 的 ⇒ **只许在正文里**（`rules/` 副本不许顶替）；
		// `false` 的 ⇒ 语料里在即可。片段是怎么定的：拿拆层前那句本体，**先在正文里找最长前缀**，
		// 找到的进正文判据、剩下的再看语料 —— 于是"正文里有的本体必须留在正文"这一类整体堵住。
		const missing = RULES.filter(([, frags]) =>
			frags.some((f) => {
				const needle = flat(f.text)
				return f.inBaseline ? !normalizedBaseline.includes(needle) : !normalizedCorpus.includes(needle)
			}),
		)
		assert.deepEqual(missing, [], '拆层后丢了的规则（正文里有的一律只读正文）：' + JSON.stringify(missing))
		// **六个 `rules/` 头句**：每个细则文件的头都必须写同一句 —— **要动手就必须读对应细则**
		// （上一版只改了文本、没把它钉住 ⇒ 复审把某个头句改成"读不读都行"时 0 红）。
		for (const name of readdirSync('team/rules').filter((n) => n.endsWith('.md'))) {
			const head = readFileSync('team/rules/' + name, 'utf8').split('\n').slice(0, 6).join('\n')
			assert.ok(head.includes('要动手就必须读对应细则'), `${name} 的头句要写清"要动手就必须读对应细则"`)
			assert.ok(head.includes('正文给入口与主规则；细则层给本体与细节'), `${name} 的头句要给两层分工`)
		}

		// **必须回正文的本体**：这些规则决定"产物落哪 / 能不能代写 / 缺件怎么算合格 / 闸门能不能跳 / 发不出去怎么办 / 同类怎么扫"，
		// 它们的本体**必须在 `team/BASELINE.md` 正文里**（不得只活在 rules/）⇒ 删正文那一处就必须红（rules 副本救不活）。
		const baselineOnly = readFileSync('team/BASELINE.md', 'utf8').replace(/\*\*/g, '').replace(/`/g, '').replace(/\\/g, '').replace(/\s+/g, ' ')
		const BODIES_IN_BASELINE = [
			['§七.1 自己目录', '自己目录 = 该角色 `ROLE.md` 的「落点（产出与落盘）」那一段逐条写出的路径'],
			['§七.2 合法移交只有两种', '合法移交只有两种（都不改自查句语义）'],
			['§七.3 跨角色的目录边界', '跨角色的目录边界：由**涉事角色在自己的 `ROLE.md`「落点」段里各写自己那一侧**'],
			['§七.4 同一题只许有一份正文', '同一题只许有一份正文：由**协调器指派先出哪一份**、另一份引它'],
			['§七.5 多个角色承接一件事', '多个角色承接一件事：按「**先出的在前**」办'],
			['§六 三条不许', '不许越界自己定义别人的产物**（缺件处写「未取得」，不就地补一套）'],
			['§六 四样', '必须同时给**四样** —— **缺什么**（产物名）/ **谁产**（角色 id）/ **取它的命令**（判定条件原文）/ **原始输出**'],
			['§三 5d 后半句', '人没点头就等于没定，不许"顺手"改'],
			['§三 5d 闸门不可豁免', '**四问（①–④）与 5c 的闸门不可豁免**'],
			['§三 5d 口头认可范围', '口头认可只覆盖当时展示的内容'],
			['§三 5c 豁免本体', '**合法的只有两件**：**只看与探索**，以及**人明确同意、且标注为"可丢弃"的快速验证原型**'],
			['§二 4c 本体（先看原因）', '真发不出去时先看原因（服务不在 / 目标名不对 / 队伍没成队），**别急着新建一位**'],
			['§二 4c 本体（没有归档那几档）', '原生名册没有"归档 / 退役 / 删除"这几档：不用的队友不再派活即可'],
			['§二 2 先登记再派人', '**先登记，再派人**：任务登记走 `board_task`'],
			['§二 3 拆单', '**拆单**：需求拆解（可交付节点 + 出口准则 + 依赖顺序）之后'],
			['§八之二 1 是一类', '**是一类**（同一套写法 / 同一个习惯在别处也会犯）⇒ **同类一起扫**'],
			['§十 2 分层', '**分层，各管各的**（防"一处两个说法"）'],
		]
		for (const [what, phrase] of BODIES_IN_BASELINE) {
			const flat = phrase.replace(/\*\*/g, '').replace(/`/g, '').replace(/\\/g, '').replace(/\s+/g, ' ')
			assert.ok(baselineOnly.includes(flat), `这条本体必须在正文里（删正文就必须红）：${what} —— ${phrase.slice(0, 40)}`)
		}

		// 两层结构：**按目录表结构核**（不是"文件名在 BASELINE 里出现过" —— 那样删掉目录表一行也照样过）
		const baseline = readFileSync('team/BASELINE.md', 'utf8')
		const tocStart = baseline.indexOf('## 目录')
		const tocEnd = baseline.indexOf('\n## ', tocStart)
		assert.ok(tocStart >= 0 && tocEnd > tocStart, '要有目录表')
		const toc = baseline.slice(tocStart, tocEnd)
		for (const file of readdirSync('team/rules').filter((name) => name.endsWith('.md'))) {
			assert.ok(toc.includes('team/rules/' + file), '目录表（**只有这一段**）必须点到这个细则文件：' + file)
		}
		// 目录表的每一行都要说清"讲什么"（表格行数 ≥8 节 + 细则层一行）
		const tocRows = toc.split('\n').filter((line) => line.trim().startsWith('|') && !line.includes(':--'))
		assert.ok(tocRows.length >= 9, '目录表要覆盖到每一节（行数不足）：' + tocRows.length)
		assert.ok(!baseline.includes('| 目标一句话 | 为什么做（依据路径） |'), '长表（5W2H 正表）应该在 rules 里，不在正文')
	})

	test('全仓不许出现 emoji / Unicode 表情装饰符号（HD-012 + HD-013 / task-82）：按**码点**扫，命中即红，报 文件:行:码点', () => {
		// **这条检查自己不许出现任何被禁字符**（否则它就是自己的反例）⇒ 一律**用码点**写。
		// **禁用集**（人两次口径合并）：emoji 区段 0x1F000–0x1FAFF、0x2600–0x26FF、**dingbats 0x2700–0x27BF**、
		//   VS16(0xFE0F) / ZWJ(0x200D)，以及 2700–27BF 之外零散的真 emoji 码点（下面 REAL_EMOJI 那些）。
		// **保留集（明确写清，免得以后有人当"符号"一起禁掉）**：箭头 0x2190–0x21FF（「重读 → 重建 → 再试」用的就是它）、
		//   常规排版标点（「」、·、—、（）、…、：）—— **不在禁用集内**。
		const REAL_EMOJI = new Set([
			0x2705, 0x274c, 0x274e, 0x2753, 0x2757, 0x2728, 0x2733, 0x2734, 0x2747, 0x2795, 0x2796, 0x2797, 0x2b50, 0x2b55,
		])
		const KEEP_RANGES = [[0x2190, 0x21ff]] // 箭头：**排版符号，按口径保留**
		const isBanned = (cp) => {
			if (KEEP_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) return false
			if (cp >= 0x1f000 && cp <= 0x1faff) return true
			if (cp >= 0x2600 && cp <= 0x26ff) return true
			if (cp >= 0x2700 && cp <= 0x27bf) return true // dingbats：重对勾 / 对勾 / 重叉 / 叉
			if (cp === 0xfe0f || cp === 0x200d) return true
			return REAL_EMOJI.has(cp)
		}
		// **扫描面 = tracked + 未跟踪但未被忽略**（task-83）：只扫 tracked 的话，**"刚写、还没入库"的新文件是盲区** ——
		// 而写文件的人（成员）在提交之前**正是处在这个状态里**（已复现：新建未入库文件塞 U+2713 ⇒ 旧检查不报）。
		// 两道过滤：① `--exclude-standard`（挡住 `node_modules` / `.git` 等忽略项）；
		// ② **只挑文本扩展名**（挡住图片 / 构建产物这类二进制，免得误报）。
		const TEXT_EXT = new Set([
			'.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.md', '.markdown', '.txt', '.yml', '.yaml',
			'.html', '.css', '.scss', '.sh', '.bash', '.py', '.toml', '.ini', '.cfg', '.conf', '.xml', '.csv', '.env',
		])
		const gitList = (...args) =>
			execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).split('\n').filter((f) => f !== '')
		// ③ **目录黑名单**：`--exclude-standard` 只认 `.gitignore` —— 本仓的 `node_modules` 没被忽略，
		// 所以再挡一道（依赖 / 构建产物 / 工具生成的本地状态**不是**"代码与文件"那一档）。
		const SKIP_DIRS = ['node_modules/', '.git/', 'dist/', 'build/', 'coverage/', '.cache/']
		const files = [
			...new Set([
				...gitList('ls-files'),
				...gitList('ls-files', '--others', '--exclude-standard'), // 未跟踪、且未被 .gitignore 忽略的新文件
			]),
		].filter(
			(f) =>
				!SKIP_DIRS.some((dir) => f.startsWith(dir)) &&
				!f.startsWith('.company-gate.') && // 工具生成的本地状态（派生物），不在"代码与文件"那一档
				(TEXT_EXT.has(f.slice(f.lastIndexOf('.')).toLowerCase()) || !f.includes('.')),
		)
		const hits = []
		for (const file of files) {
			let text
			try {
				text = readFileSync(file, 'utf8')
			} catch {
				continue // 读不了 / 二进制的跳过（上面两道过滤已经把二进制挡在外面）
			}
			if (text.includes('\u0000')) continue
			text.split('\n').forEach((line, index) => {
				for (const ch of line) {
					const cp = ch.codePointAt(0)
					if (isBanned(cp)) hits.push(`${file}:${index + 1}:U+${cp.toString(16).toUpperCase().padStart(4, '0')}`)
				}
			})
		}
		assert.deepEqual(hits, [], '这些位置有 emoji / 装饰符号（照 文件:行:码点 删掉，或换成中文词）：' + JSON.stringify(hits))
		// **规则要真在正文里**，且**保留集**也要写明（规则与检查一对一；本行自己不带被禁字符）
		const baseline = readFileSync('team/BASELINE.md', 'utf8')
		assert.ok(baseline.includes('**代码与文件里不许出现 emoji 或 Unicode 表情/装饰符号**'), 'BASELINE 正文要钉这条硬规则（HD-012 + HD-013）')
		assert.ok(baseline.includes('**dingbats `U+2700–27BF`**'), '要把 dingbat 区间写进规则')
		assert.ok(baseline.includes('**箭头（`U+2190–21FF`）与常规排版标点' ), '要把**保留集**写进规则（箭头与排版标点不在其内）')
		assert.ok(baseline.includes('**失败即红**') && baseline.includes('文件:行:码点'), '要指明检查在哪、失败长什么样')
	})


	test('"状态与事实分家"这一类（task-80）：A 凭据纪律 / B 同一事实两处必须配机械检查 —— 两处同口径', () => {
		// 人报的是**一类**问题（"总是出现"）：根因 = **同一事实存在两处，两处之间没有机械对齐** ⇒ 靠"人记得同步" ⇒ 必复发。
		// 修法 A/B 写进**注入策略段**与 `BASELINE` 协作纪律两处；C（派生读数）由 `lib/ledger-digest.js` 那条用例机械核。
		const policy = runtime.teamPolicyText()
		const baseline = baselineCorpusOf()
		const KEY = [
			['A 宣称状态必带凭据', '**凡宣称状态，必带凭据**'],
			['A 命令 + 输出', '**命令 + 输出**'],
			['A 带时间', '**带时间**'],
			['A 写不出凭据 = 不许宣称', '**写不出凭据 = 不许宣称**'],
			['B 同一事实不许两处并存', '**同一事实不许两处并存**'],
			['B 必须配一条机械检查', '**必须配一条机械检查**'],
			['B 删到一处或改派生', '**写不出这条检查 ⇒ 二选一：删到只剩一处，或把其中一处改成从另一处派生**'],
			['B 不许靠人同步', '**不许"两处都写、靠人同步"**'],
		]
		for (const [what, phrase] of KEY) {
			assert.ok(policy.includes(phrase), `策略段缺（${what}）：${phrase}`)
			assert.ok(baseline.includes(phrase), `BASELINE 缺（${what}）：${phrase}`)
		}
		// A 是 §五.7 那条的**推广**（那句"特例"要写出来，否则两条会打架）
		assert.ok(/是(这一|这)条的?特例/.test(policy) || policy.includes('是特例'), '要写清"任务号 + notified"是本条的特例：' + policy.slice(0, 0))
		// **C 的机械检查要真的在实现里**（不是只写在文档里）：交接快照必须带 快照@时刻 + 非实时 + 不印裸计数
		const digest = readFileSync('lib/ledger-digest.js', 'utf8')
		assert.ok(digest.includes('**快照@'), '交接快照块首要有 快照@<时刻>：' + digest.slice(0, 0))
		assert.ok(digest.includes('**非实时**'), '交接快照块首要有 非实时 标记')
		assert.ok(digest.includes('当时未完成'), '要写清列的是"当时未完成"的条目')
		assert.ok(!/进行中 \$\{inProgress\} 条/.test(digest), '派生读数里不许印裸计数')
	})

	test('回报默认落看板不落人（task-79 / HD-011）：两处同口径（不需要人裁决的不转述 + 需要裁决的一条说清）', () => {
		// 人的原话（HD-011）：「团队内同时多成员回复给 lead 时，如果不需要人裁决，不需要把消息再复述一遍到对话中，
		// 自行指派任务并把任务落到任务看板。只有需要人裁决时再让人决策，同时把问题简要描述清楚。」
		// ⇒ 协调器的**默认输出行为**：**回报的默认去处是看板，不是人**。
		const policy = runtime.teamPolicyText()
		const baseline = baselineCorpusOf()
		const KEY = [
			['回报默认落看板/不落人', '**回报默认落看板，不落人**'],
			['不需要人裁决的 ⇒ 不把人拉进来', '**不需要人裁决的** ⇒ **不把人拉进来**'],
			['不转述成员的话', '**不要转述成员的话**'],
			['只有需要人裁决的才上人', '**只有需要人裁决的**才上人'],
			['逐项编号', '**逐项编号**'],
			['不要把成员原文贴给人', '**不要把成员原文贴给人**'],
		]
		for (const [what, phrase] of KEY) {
			assert.ok(policy.includes(phrase), `策略段缺（${what}）：${phrase}`)
			assert.ok(baseline.includes(phrase), `BASELINE 缺（${what}）：${phrase}`)
		}
		// 给人那一行要短（三个字段，不是把成员的话搬过去）
		assert.ok(policy.includes('任务号 · 状态') || policy.includes('任务号 · 现状'), '给人最多一行：谁 · 任务号 · 现状')
		// **方向别混**：这条管"协调器 → 人"，「回报只放指针」那条管"成员 → 协调器"
		assert.ok(baseline.includes('管**协调器 → 人**'), 'BASELINE 要说清方向：协调器 → 人')
		assert.ok(baseline.includes('**成员 → 协调器**'), 'BASELINE 要说清另一条的方向：成员 → 协调器')
	})

	test('"说了没派"的机制修法（task-78）：顺序纪律 / 汇报凭据 / reassign 不能省 —— 两处同口径', () => {
		// 人报的跨会话故障（五次）：长回复里把"我打算派"写成了"我派了"，而**调用排在总结之后** ⇒ 总结写完回合就结束。
		// 我们的派活路径是**诚实**的（`sendToTeammate` 只有真 await 成功才 ok:true）⇒ 要改的是**序列 + 自述**，
		// 于是把"靠记性"换成**可核的凭据**：先调用后总结 + 说出"派了"必须带任务号与 `notified` + reassign 不能省。
		const policy = runtime.teamPolicyText()
		const baseline = baselineCorpusOf()
		const KEY = [
			['顺序纪律：只许写在工具调用之后', '**只许写在本回合的工具调用之后**'],
			['顺序纪律：不许用文字代替调用', '**不许用文字代替调用**'],
			['汇报凭据：任务号 + notified', '必须带 **任务号 + `notified`**'],
			['汇报凭据：写不出就是没派', '**写不出这两个，就是没派**'],
			['reassign 不能省', '**派活时 `reassign` 不能省**'],
			['漏发消息也不致空转', '漏发消息也不致空转'],
		]
		for (const [what, phrase] of KEY) {
			assert.ok(policy.includes(phrase), `策略段缺（${what}）：${phrase}`)
			assert.ok(baseline.includes(phrase), `BASELINE 缺（${what}）：${phrase}`)
		}
		// **顺序纪律**在正文里也要能读到"先调用、后总结"这个副标题（不然只剩半句）
		assert.ok(policy.includes('**先调用、后总结**'), '策略段要有"先调用、后总结"这个标题')
		assert.ok(baseline.includes('**先调用、后总结**'), 'BASELINE 要有"先调用、后总结"这个标题')
		// 兜底那一句要写清"它**同时**推进进行中并自动通知"（不然"不能省"缺理由）
		assert.ok(policy.includes('它推进「进行中」并**自动按门铃**'), '策略段要写清 reassign 的自动通知')
	})

	test('两层核：角色定位清单**不在提示词里**，但 `member_defaults` 一条不少（task-70）', async () => {
		// 人确认过：注入里那份「可叫的队友」19 条定位清单是**运行时从角色文件生成**的副本。
		// 本单的口径 = **只删提示词里那份副本**：清单改由 `member_defaults` 现枚举给。
		// ⇒ 两层都要核：① 注入侧不再有定位句；② 现枚举侧一条不少、每条都带定位（**"不在提示词里" ≠ "叫不到人"**）。
		const policy = runtime.teamPolicyText()
		// ① 注入侧：不含任何一条角色定位句（用角色清单的标志性形态核：`· \`<role>\`（…）：…`）
		const bulletLike = policy.split('\n').filter((line) => /^· `[a-z][a-z0-9-]*`（/.test(line))
		assert.deepEqual(bulletLike, [], '提示词里不该再有角色定位清单：' + JSON.stringify(bulletLike.slice(0, 3)))
		assert.ok(!policy.includes('可叫的队友'), '那一块整块不该在提示词里')
		// 正面：要有一行**指针**说清去哪儿看（口径与 task-69 同）
		assert.ok(policy.includes('**定位句不进提示词**'), '要留一行指针')
		assert.ok(policy.includes('`member_defaults`'), '指针要指向现枚举那件工具')
		// ② 现枚举侧：`member_defaults` 仍然给得出**每一条**（id / 显示名 / 分类 / 一句话定位）
		const env = install()
		try {
			const defaults = await call(env.host, 'member_defaults', {}, env.exec)
			assert.equal(defaults.ok, true, JSON.stringify(defaults).slice(0, 200))
			assert.equal(defaults.rows.length, 19, '默认清单仍是 19 条（本机 20 个角色减去被排掉的 ontology）：' + defaults.rows.length)
			for (const row of defaults.rows) {
				assert.match(String(row.role), /^[a-z][a-z0-9-]*$/, '每条要有 id：' + JSON.stringify(row).slice(0, 120))
				assert.ok(String(row.title).trim() !== '', '每条要有显示名：' + row.role)
				assert.ok(String(row.category).trim() !== '', '每条要有分类：' + row.role)
				assert.ok(String(row.positioning).trim().length >= 8, '每条要有一句话定位：' + row.role + ' → ' + row.positioning)
			}
			// 定位句**逐条不在提示词里**（不是"整体不在"，是每一条都不在）
			const leaked = defaults.rows.filter((row) => policy.includes(String(row.positioning)))
			assert.deepEqual(leaked.map((row) => row.role), [], '这些角色的定位句漏进提示词了')
		} finally {
			env.restore?.()
		}
	})

	test('**规则清单**（task-69 瘦身验收）：压缩后每一条规则都还在（42 条逐条核）', () => {
		// 这份清单是**压缩前**策略段里的规则要点，压缩后逐条仍在（按短语核，不依赖排版）。
		// 瘦身只许动"理由 / 重复 / 可由工具取回"的那些字，**规则本身一条不丢**。
		const policy = runtime.teamPolicyText()
		const RULES = [
			['R01 版本标记（派生）', '同口径：基线 v'],
			['R02 称呼三方对照 + 消解规则', '成员消解规则'],
			['R03 层级三档 + 默认宪法', '> 本基线 > 角色 `ROLE.md`'],
			['R04 角色根 + 枚举顺序', '枚举顺序：工作区根 > 用户根 > 包内'],
			['R05 团队规则全文指针', '团队规则全文'],
			['R06 协调器五步 + 版本号收口', 'expected_revision'],
			['R07 新工作区第一句话', '把它原样作为你的第一句话说给人'],
			['R08 点名规矩（多个 @ 各派一份）', '出现多个 `@` ⇒ 各派一份'],
			['R09 按需组建三条 + 以本段为准', '本预设以本段为准'],
			['R10 角色清单现场枚举 + 定位句不进提示词', '**定位句不进提示词**'],
			['R11 怎么叫一个人 / 加角色', '`npm run role:new -- <角色 id>`'],
			['R12 停用不占角色槽位', '**不占角色槽位**'],
			['R12b 停用照样占在场总人数', '**照样占着在场总人数**'],
			['R12c 原生名册行只增不减', '**原生名册行只增不减**'],
			['R13 编制归原生（引用 NO_REMOVAL_NOTE）', '成员状态只有 `provisioning`'],
			['R14 line_reason 越不过宿主硬上限', '**只能越过插件的软上限（角色槽位 3 位），越不过宿主的硬上限（在场总人数 24）**'],
			['R15 board_task 四档如实拒绝', '会如实拒绝并指出该用哪一档'],
			['R16 审批号定义', '**审批号 = 「人的话」里那一条 `HD-<三位序号>`**'],
			['R16b 没号怎么办', '**人答了但没记 ⇒ 当场记录再执行**'],
			['R17 能力沉淀：只有协调者能调', '**只有协调者能调**'],
			['R18 ③档判据（并集）', '**跨角色** / **跨轮** / **改口径** / **不可逆取舍**'],
			['R18b 多文件只是信号', '**「多个文件」只是信号，不单独触发 ③**'],
			['R18c 中途变大停下', '**规模在一单中途变大 ⇒ 立刻停下、报人、按新档位重走**'],
			['R18d 报三样', '**派活与登记固定报三样**'],
			['R19 闸门合法两件', '**只看与探索**'],
			['R20 提问一律由协调器发出', '**向人提问一律由协调器发出**'],
			['R20b 审批清单形状', '**逐项编号、每项一个待确认句、每项给推荐**'],
			['R21 复盘：只有人确认算前提', '**只有标「人确认」的才许当成已定的前提**'],
			['R22 边界三类（HD-009）', '**人没点名的界面**形状** / 控件**类型** / 参数含义（含改名与**改**默认值）不许动**'],
			['R22b 顺手核同类只许报告', '**只许报告、不许自己动手**'],
			['R23 write_scopes 写具体文件', '**写具体文件，别写目录**'],
			['R24 版本守卫码', '报 `FS_STALE_VERSION`'],
			['R24b 被拒的正确动作', '**重读 → 把改动重建在新内容上 → 再试**'],
			['R24c bash 那一半没有守卫', '**`bash` / 脚本 / 格式化器没有这层守卫**'],
			['R25 派活三件套（只有 reassign 推进）', '三步缺一不可：**只有 `reassign` 会把卡推进「进行中」**'],
			['R26 claim：别人的不许动', '**已被指派给别人的条目一律不许动**'],
			['R27 返工 = 开新任务关联原号', '**打回 / 返工 = 开一条新任务并关联原任务号**'],
			['R28 等成员', '没人在跑就 `member_send` 叫起来'],
			['R29 消息持久不重发', '**不要重发同一条**'],
			['R30 回报第一行是指针', '**回报的第一行就是那条指针**'],
			['R30b 指针不写进产物', '**指针放在回报里，不写进产物**'],
			['R31 对外输出层级', '对外输出按团队基线的默认层级走'],
		]
		const missing = RULES.filter(([, phrase]) => !policy.includes(phrase))
		assert.deepEqual(missing, [], '压缩后丢了的规则：' + JSON.stringify(missing))
		// 瘦身目标：≤5,000 字符（压缩前 7,860）
		assert.ok(policy.length <= 5000, `策略段要 ≤5000 字符（现在 ${policy.length}）`)
	})

	test('策略段版本标记（task-66）：两个版本号都是**派生**的（基线读 BASELINE.md、插件读 package.json）', () => {
		// **判据**：标记不是抄的 —— 把 BASELINE 的版本行临时改掉，策略段那行必须**跟着走**（断言仍绿）；
		// 手写成字符串常量的话，"跟着走"这条就不成立（自证见下）。
		const policy = runtime.teamPolicyText(runtime.roleCatalog(), runtime.defaultRosterOf())
		const first = String(policy).split('\n')[0]
		const baselineVersion = /\*\*版本\*\*：([0-9][0-9A-Za-z.\-]*)/.exec(readFileSync('team/BASELINE.md', 'utf8'))[1]
		const pluginVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
		// ① 策略段**开头**就是这一行，且两个号与两个源**逐字一致**
		assert.match(first, /^（本段与 `team\/BASELINE\.md` 同口径：基线 v[^ ｜]+ ｜ 插件 v[^）]+）$/, '开头要有版本标记：' + first)
		assert.ok(first.includes('基线 v' + baselineVersion), `策略段里的基线版本要等于 BASELINE.md 那一行（${baselineVersion}）：` + first)
		assert.ok(first.includes('插件 v' + pluginVersion), `策略段里的插件版本要等于 package.json 的 version（${pluginVersion}）：` + first)
		// ② 派生（不是常量）：读一次源、再算一次 —— 两边的值必须来自同一处
		assert.equal(runtime.baselineVersionOf(), baselineVersion, 'baselineVersionOf() 要解析 BASELINE.md 那一行')
		// ③ **把 BASELINE 临时改成 9.9.9 ⇒ 策略段那行跟着走**（真改文件、跑完还原；这一条是"它是读出来的"的证据）
		const backup = readFileSync('team/BASELINE.md', 'utf8')
		try {
			writeFileSync('team/BASELINE.md', backup.replace('**版本**：' + baselineVersion, '**版本**：9.9.9'), 'utf8')
			const moved = String(runtime.teamPolicyText(runtime.roleCatalog(), runtime.defaultRosterOf())).split('\n')[0]
			assert.ok(moved.includes('基线 v9.9.9'), 'BASELINE 改版本 ⇒ 策略段那行要跟着变（说明它是读出来的）：' + moved)
			assert.equal(runtime.baselineVersionOf(), '9.9.9', '派生函数也要跟着走')
		} finally {
			writeFileSync('team/BASELINE.md', backup, 'utf8')
		}
		// ④ 还原之后回到原值（没留下副作用）
		assert.equal(runtime.baselineVersionOf(), baselineVersion, '跑完要把 BASELINE 还原')
	})

	test('**同一文件被两人改**（task-63）：两处正文切段钉住（段间无缝，中段子句被换 ⇒ 红）', () => {
		// 人的问题：「多成员改一个文件，会造成相互覆盖，这个 DSH 怎么解决的？」
		// 查实是**三层机制**（不是锁）：原子写 + 按文件串行 / 版本守卫（`FS_STALE_VERSION`）/ `edit` 字面量唯一匹配；
		// 另有 `dsh-fs-observation-policy`：没读过的文件不许覆盖。工具层**管不到** bash / 脚本 / 格式化器 ⇒ 那一半靠纪律。
		const baseline = baselineCorpusOf()
		const policy = runtime.teamPolicyText(runtime.roleCatalog(), runtime.defaultRosterOf())
		// BASELINE：**切段平铺**（段间无缝 ⇒ 中段任一子句被换必打断相邻段）
		for (const fragment of [
			'同一文件被两人改：靠机制兜，不靠锁',
			'**原子写 + 按文件串行**（同一文件的两次改动不交错，不会写花）',
			'**版本守卫**（带上"上次观察到的那一版"，',
			'报 `FS_STALE_VERSION`）；**`edit` 还要求字面量唯一匹配**',
			'（内容已变 ⇒ `FS_EDIT_NOT_FOUND` / `FS_AMBIGUOUS_EDIT`，不带版本守卫也拒）',
			'**`dsh-fs-observation-policy`：没读过的文件不许覆盖**',
			'被拒的正确动作是 **重读 → 把改动重建在新内容上 → 再试**（**不要原样重写**）',
			'**它管不到**：`bash` / 格式化器 / 代码生成器 / 脚本',
			'看板 `write_scopes`（**写具体文件，别写目录**；提示性、不是锁）+ 同一文件**串行派活**（用 `blocked_by`）',
			'**协调器看最终 diff 并跑测试** + git **显式列路径**',
			'`git add -A` 会把别人正在写的 WIP 一起提交',
		]) {
			assert.ok(baseline.includes(fragment), 'BASELINE 缺了这一截：' + fragment.slice(0, 40))
		}
		// 策略段：同口径（**逐字一处**那些关键短语，两处都必须有）
		for (const fragment of [
			'同一文件被两人改',
			'**原子写 + 按文件串行 + 版本守卫**',
			'报 `FS_STALE_VERSION`',
			'**重读 → 把改动重建在新内容上 → 再试**（不要原样重写）',
			'`edit` 还要求字面量唯一匹配',
			'**`bash` / 脚本 / 格式化器没有这层守卫**',
			'**写具体文件**',
			'**协调器看最终 diff 并跑测试**',
			'git **显式列路径**',
		]) {
			assert.ok(policy.includes(fragment), '策略段缺了这一截：' + fragment.slice(0, 40))
		}
	})

	test('**整句级**钉住（task-59）：claim 那条与派活三件套那两句必须逐字在（中段被改也红）', () => {
		// 上一轮的缺口（协调者抽出来的）：那条断言"按句核了六句"，但**句子的中段**被换掉照样过 ——
		// 把「只许在它还没被指派（无 owner）时」改成「随时都能认领」⇒ 全绿。同族于上一轮那条"假绿"。
		// ⇒ 这里改成**整句逐字**钉（不是"含某两段短语"）：中段任何一个子句被换掉，整句就不再匹配。
		const policy = runtime.teamPolicyText(runtime.roleCatalog(), runtime.defaultRosterOf())
		const sentences = [
			// ① claim 那条**整句**（含两段约束：唯一点名 + 还没被指派；task-69 瘦身后的措辞）
			'· **成员可以 `claim`**：只许认领协调器点名给它的那一条，且**在它还没被指派（无 owner）时**；**已被指派给别人的条目一律不许动**（认领会把归属记成自己）。收口 `complete` 同理。',
			// ② 派活三件套那句**整句**（三步 + 只有 reassign 推进；task-69 瘦身后的措辞）
			'· **派活三件套（缺一就会"活干了卡没动"）**：**① `register`（建卡）→ ② `reassign`（带 owner）→ ③ `member_send`（把规格发给它）** —— 三步缺一不可：**只有 `reassign` 会把卡推进「进行中」**。**`board_task reassign` 只是记账，不等于叫它开工**。',
		]
		for (const sentence of sentences) {
			assert.ok(policy.includes(sentence), '整句必须逐字在（中段改了就该红）：' + sentence.slice(0, 60))
		}
		// ③ 工具描述里的两段（整段逐字）
		const desc = readFileSync('team/company-gate.js', 'utf8')
		for (const chunk of [
			'**claim 认领（成员可用：只认领协调器在消息里点到自己的那一条、且它还没被指派；原生把归属记成调用者本人）**',
			'**reassign 转派（仅协调者；它同时把状态推进「进行中」—— 这是与 `member_send` 分工的关键）**',
		]) {
			assert.ok(desc.includes(chunk), '描述里的整段必须逐字在：' + chunk.slice(0, 40))
		}
	})

	test('派活三件套与成员 claim 的口径（task-58）：五句按句核（策略段三句 + 描述两句）', () => {
		// 人的追问：member_send 派的活干完了、卡却没动 ⇒ 缝在流程：**只有 `reassign` 会把卡推进「进行中」**，
		// 而旧策略段写着"成员不会自己认领看板条目" ⇒ 成员被这句话挡着不会自纠。能力上一直没障碍（`claim` / `complete`
		// 都不在 `COORDINATOR_ONLY_TASK_ACTIONS` 里）。
		const policy = runtime.teamPolicyText(runtime.roleCatalog(), runtime.defaultRosterOf())
		const wanted = [
			['策略段：派活三件套', '**派活三件套（缺一就会"活干了卡没动"）**'],
			['策略段：三步缺一不可', '三步缺一不可'],
			['策略段：只有 reassign 推进进行中', '**只有 `reassign` 会把卡推进「进行中」**'],
			['策略段：成员可以 claim', '**成员可以 `claim`**'],
			['策略段：只认领点到自己的那条', '只许认领协调器点名给它的那一条'],
			['策略段：已被指派给别人的不许动', '**已被指派给别人的条目一律不许动**'],
		]
		for (const [what, phrase] of wanted) assert.ok(policy.includes(phrase), `${what}：${phrase}`)
		assert.ok(!policy.includes('成员**不会**自己认领看板条目'), '旧那句"成员不会自己认领"必须换掉')
		// 工具描述两句
		const desc = readFileSync('team/company-gate.js', 'utf8')
		for (const [what, phrase] of [
			['描述：claim 成员可用', '**claim 认领（成员可用：只认领协调器在消息里点到自己的那一条、且它还没被指派'],
			['描述：reassign 同时推进进行中', '它同时把状态推进「进行中」—— 这是与 `member_send` 分工的关键'],
			['描述：派活三件套', '**派活三件套（缺一就会"活干了卡没动"）**'],
		]) {
			assert.ok(desc.includes(phrase), `${what}：${phrase}`)
		}
	})

	test('「打断」只在 **running** 时才给 ok:true：无轮次 / 创建中 / 失败一律灰 + 给理由', async () => {
		// 现场（协调者真端点实测）：`POST /members/interrupt {name:"devops-1"}`（当时 `inactive`）回 `ok:true`
		// + `previousStatus:"inactive"` ⇒ **按钮可点、点了什么也没发生**。判据漏了"它现在到底有没有在跑的那一轮"。
		const { handleMembers } = await import('../lib/board-view.host.js')
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-interrupt-verbs-'))
		const lead = { id: 'sess-1' }
		const rowsOf = (status) => [
			{ id: 'sess-1', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
			{ id: 'child-1', name: 'qa-1', role: 'teammate', status, diagnostics: [] },
		]
		const read = async (status) => {
			const teamRows = rowsOf(status)
			const services = { agentTeams: { listMembers: () => teamRows }, agents: { get: (id) => (id === 'sess-1' ? lead : undefined) } }
			const ctx = { fs: makeFs(), get: (name) => services[name], logger: { warn() {} } }
			const { res, captured } = makeRes()
			await handleMembers(ctx, { method: 'GET', url: `/company-board/api/members?workspace=${encodeURIComponent(workspace)}&session=sess-1` }, res, null)
			const payload = JSON.parse(captured.body)
			return { status: captured.status, row: payload.merged.find((item) => item.name === 'qa-1') }
		}
		// ① 跑着 ⇒ 给打断
		const running = await read('running')
		assert.equal(running.status, 200)
		assert.equal(running.row.verbs.interrupt.ok, true, 'running ⇒ 可打断')
		assert.equal(running.row.verbs.interrupt.why, undefined, '能做就不给理由（空理由会印成悬停提示）')
		// ② 无轮次 ⇒ 灰 + 理由（措辞用面板同一套词）
		const idle = await read('inactive')
		assert.equal(idle.row.verbs.interrupt.ok, false, '**无轮次不许给 ok:true**（点了什么也不会发生）')
		assert.ok(String(idle.row.verbs.interrupt.why ?? '') !== '', '灰的必须给理由')
		assert.match(idle.row.verbs.interrupt.why, /无轮次/, '用面板同一套词（`inactive` = 无轮次）：' + idle.row.verbs.interrupt.why)
		// ③ 创建中 / 失败：另两句（分开说清）
		const provisioning = await read('provisioning')
		assert.equal(provisioning.row.verbs.interrupt.ok, false)
		assert.match(provisioning.row.verbs.interrupt.why, /创建中/)
		const failed = await read('failed')
		assert.equal(failed.row.verbs.interrupt.ok, false)
		assert.match(failed.row.verbs.interrupt.why, /失败/)
		// ④ 四个状态的 `why` 互不相同（"分开说清"这条按句子核）
		const whys = [idle, provisioning, failed].map((item) => item.row.verbs.interrupt.why)
		assert.equal(new Set(whys).size, 3, '三种状态的话不许共用一句：' + JSON.stringify(whys))
	})

	test('成员端点不再读旧名册文件：那份文件在不在、有没有行，都不影响载荷', async () => {
		// task-40（人的决定）：`.company-gate.members.json` 是旧账（看板/名册归原生后再没人写它），
		// 面板**不再读它** —— 文件还在不影响任何读数，字段（`established` / `total` / `rows` /
		// `annotations` / `markdown` / `file`）也一并撤掉了。这一条钉的就是"路径断开了"。
		const { handleMembers } = await import('../lib/board-view.host.js')
		const ctx = { fs: makeFs(), get: () => undefined, logger: { warn() {} } }
		const read = async (root) => {
			const { res, captured } = makeRes()
			await handleMembers(ctx, { method: 'GET', url: `/company-board/api/members?workspace=${encodeURIComponent(root)}` }, res, null)
			return { status: captured.status, payload: JSON.parse(captured.body) }
		}
		const absent = mkdtempSync(join(tmpdir(), 'team-ops-members-absent-'))
		const first = await read(absent)
		assert.equal(first.status, 200, JSON.stringify(first.payload))
		for (const key of ['established', 'total', 'rows', 'annotations', 'markdown', 'file', 'present', 'archived', 'retired', 'warnLine', 'overLine', 'reasonLine']) {
			assert.equal(first.payload[key], undefined, `旧名册派生的字段不许再出现在载荷里：${key}`)
		}
		// 文件**在、且有行**（故意造一份"有内容"的旧账）：载荷逐字一样 —— 没人读它
		const withRows = mkdtempSync(join(tmpdir(), 'team-ops-members-withrows-'))
		writeFileSync(
			join(withRows, '.company-gate.members.json'),
			JSON.stringify({ version: 1, seq: 9, members: [{ id: 'MB-001', name: 'revi-1', role: 'reviewer', status: '在场', prompt: 'x', persona: 'y', enabled: false }] }, null, 2),
		)
		const second = await read(withRows)
		assert.equal(second.status, 200)
		// 逐字比：只有那些**必然不同**的绝对路径（工作区自己的）先抹平
		const strip = (payload) => JSON.parse(JSON.stringify(payload).split(withRows).join('<WS>').split(absent).join('<WS>'))
		assert.deepEqual(strip(second.payload), strip(first.payload), '旧名册文件的内容对载荷**零影响**')
	})

	test('本会话的 agent 名册：与内置 list_agents 同源，缺的照实说读不到（不是"没有 agent"）', async () => {
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-team-roster-'))
		writeFileSync(
			join(workspace, '.company-gate.members.json'),
			JSON.stringify(
				{
					version: 1,
					seq: 2,
					members: [
						{ id: 'MB-001', name: 'revi-1', role: 'reviewer', description: '独立复核交付物', session: 'child-1', status: '在场', enabled: true },
						// 只在名册里的（它的会话已经不在队里了，或本来就是老成员）：join 之后必须**照旧列出**。
						{ id: 'MB-002', name: 'be-1', role: 'be-dev', description: '后端接口', session: 'child-9', status: '退役', retire_reason: '干完了', replaced_by: 'be-2', enabled: false },
					],
				},
				null,
				2,
			),
		)
		writeFileSync(join(workspace, '.company-gate.mailbox.json'), JSON.stringify({ version: 1, seq: 0, messages: [] }, null, 2))
		const lead = { id: 'sess-1' }
		const teamRows = [
			{ id: 'sess-1', name: 'lead', role: 'lead', status: 'running', model: 'deepseek-flash', diagnostics: [] },
			{ id: 'child-1', name: 'revi-1', role: 'teammate', status: 'inactive', description: '独立复核交付物', provider: 'deepseek', context: 'fresh', model: 'deepseek-flash', diagnostics: [] },
		]
		const calls = []
		const makeCtx = (services) => ({
			fs: makeFs(),
			get: (name) => services[name],
			logger: { warn() {} },
		})
		const read = async (ctx, session) => {
			const { res, captured } = makeRes()
			const { handleMembers } = await import('../lib/board-view.host.js')
			const url = `/company-board/api/members?workspace=${encodeURIComponent(workspace)}${session === '' ? '' : '&session=' + encodeURIComponent(session)}`
			await handleMembers(ctx, { method: 'GET', url }, res, null)
			return { status: captured.status, payload: JSON.parse(captured.body) }
		}

		// ① 有服务、会话活着：团队名册照给（协调者第一），并按**会话 id** join 上记录行。
		const live = await read(
			makeCtx({
				agentTeams: {
					listMembers(agent) {
						calls.push(agent)
						return teamRows
					},
				},
				agents: { get: (id) => (id === 'sess-1' ? lead : undefined) },
			}),
			'sess-1',
		)
		assert.equal(live.status, 200, JSON.stringify(live.payload))
		assert.equal(live.payload.team.available, true)
		assert.equal(live.payload.team.count, 2)
		assert.equal(live.payload.team.rows[0].role, 'lead')
		assert.equal(calls.length, 1)
		assert.equal(calls[0], lead, '拿本会话的 Lead 当凭据（`listMembers(agent)` 要的是活着的队内 agent）')
		const merged = live.payload.merged
		// task-40：不再 join 旧名册 ⇒ 只有团队那两种行（`ledger` 那一种没了）
		assert.deepEqual(merged.map((row) => row.kind), ['lead', 'teammate'], '只有原生名册的行（协调者在前）')
		assert.equal(merged[0].name, 'lead')
		assert.equal(merged[0].session, 'sess-1', '会话 id 是这一位的真源（旧名册的编号撤了）')
		assert.equal(merged[1].name, 'revi-1')
		assert.equal(merged[1].runtime, 'inactive')
		// **task-40**：不再有 `ledger` / `matchedBy` 这些"为旧名册而生"的字段，也不再 join 出第三行
		for (const row of merged) {
			assert.equal(row.ledger, undefined, '不许再有 ledger 那一格')
			assert.equal(row.matchedBy, undefined, '不许再有 matchedBy 那一格')
		}
		assert.equal(merged.length, 2, '名册就是团队那两位，没有"只在旧名册里"的第三行')

		// ② 服务不在：读不到**要说出来**（点名该装哪个包），且这一块如实说空（不再有"文件那些行照旧"）。
		const noService = await read(makeCtx({}), 'sess-1')
		assert.equal(noService.payload.team.available, false)
		assert.match(noService.payload.team.reason, /ctx\.agentTeams/)
		assert.ok(noService.payload.warnings.some((line) => line.includes('ctx.agentTeams')), '理由要进 warnings 才看得见')
		assert.deepEqual(noService.payload.merged, [], '团队读不到 ⇒ 行就是空的（旧名册那些行已经不属于这里）')

		// ③ 请求没带会话 / 那个会话不活着：读不到名册，理由说清是哪一种（不假称"没有队友"）。
		const noSession = await read(makeCtx({ agentTeams: { listMembers: () => teamRows }, agents: { get: () => lead } }), '')
		assert.equal(noSession.payload.team.available, false)
		assert.match(noSession.payload.team.reason, /没带会话 id/)
		const notLive = await read(makeCtx({ agentTeams: { listMembers: () => teamRows }, agents: { get: () => undefined } }), 'sess-404')
		assert.equal(notLive.payload.team.available, false)
		assert.match(notLive.payload.team.reason, /sess-404/)

		// ④ `listMembers` 抛错（这个会话还没成队）：原文透出，不当成"没有 agent"。
		const threw = await read(
			makeCtx({
				agentTeams: {
					listMembers() {
						throw new Error('TEAM_NOT_MEMBER: agent "sess-1" is not a member of an active Agent Team')
					},
				},
				agents: { get: () => lead },
			}),
			'sess-1',
		)
		assert.equal(threw.payload.team.available, false)
		assert.match(threw.payload.team.reason, /TEAM_NOT_MEMBER/)
		assert.equal(threw.payload.merged.length, 0, '读不到团队 ⇒ 一行都没有（旧名册那份不再兜底）')
	})

})

// ── 「任务看板」的团队那一半：本会话 Agent Teams 的共享任务 ──────────────────────

describe('团队任务板：本会话 Agent Teams 的共享任务（只读）', () => {
	const lead = { id: 'sess-1' }
	const VIEWS = [
		{ id: 'T-1', revision: 1, subject: '改 A', description: '把 A 改掉', status: 'pending', ready: true, blockedBy: [], writeScopes: ['src/a'], writeScopeWarnings: [] },
		{ id: 'T-2', revision: 3, subject: '改 B', description: '', status: 'in_progress', ownerName: 'revi-1', ready: false, blockedBy: ['T-1'], writeScopes: [], writeScopeWarnings: ['write scopes overlap with T-1'] },
		{ id: 'T-3', revision: 2, subject: '改 C', description: '', status: 'completed', ownerName: 'lead', ready: false, blockedBy: [], writeScopes: [], writeScopeWarnings: [] },
	]
	const call = async (ctx, url, method = 'GET') => {
		const { res, captured } = makeRes()
		const { handleTeamTasks } = await import('../lib/board-view.host.js')
		await handleTeamTasks(ctx, { method, url }, res, null)
		return { status: captured.status, payload: JSON.parse(captured.body) }
	}
	const makeCtx = (services) => ({ fs: makeFs(), get: (name) => services[name], logger: { warn() {} } })

	test('照原生的三档数 + 只留标量叶子；凭据是本会话活着的 Lead', async () => {
		const calls = []
		const ctx = makeCtx({
			agentTeams: {
				listTasks(caller) {
					calls.push(caller)
					return VIEWS
				},
			},
			agents: { get: (id) => (id === 'sess-1' ? lead : undefined) },
		})
		const out = await call(ctx, '/company-board/api/team-tasks?session=sess-1')
		assert.equal(out.status, 200, JSON.stringify(out.payload))
		assert.equal(out.payload.available, true)
		assert.equal(out.payload.total, 3)
		// 计数**照原生状态词**数（pending / in_progress / completed），本文件不把它映射进我们那五栏。
		assert.deepEqual(out.payload.counts, { pending: 1, in_progress: 1, completed: 1 })
		assert.equal(calls.length, 1)
		assert.equal(calls[0], lead, '拿会话 id 换来的那个活着的 Lead 当凭据')
		const first = out.payload.rows[0]
		assert.deepEqual(Object.keys(first).sort(), ['blockedBy', 'description', 'id', 'ownerName', 'ready', 'revision', 'status', 'subject', 'writeScopeWarnings', 'writeScopes'].sort())
		assert.deepEqual(out.payload.rows[1].blockedBy, ['T-1'])
		assert.deepEqual(out.payload.rows[1].writeScopeWarnings, ['write scopes overlap with T-1'])
		assert.equal(out.payload.rows[1].ownerName, 'revi-1')
		// 只读面：连 POST 的入口都不留。
		const posted = await call(ctx, '/company-board/api/team-tasks?session=sess-1', 'POST')
		assert.equal(posted.status, 405)
	})

	test('四种"读不到"各说各的话，且都**不假装"没有任务"**（status 仍是 200）', async () => {
		// ① 服务不在：点名该装哪个包。
		const noService = await call(makeCtx({}), '/company-board/api/team-tasks?session=sess-1')
		assert.equal(noService.status, 200)
		assert.equal(noService.payload.available, false)
		assert.equal(noService.payload.rows.length, 0)
		assert.match(noService.payload.reason, /ctx\.agentTeams/)
		assert.ok(noService.payload.warnings.some((line) => line.includes('ctx.agentTeams')))
		// ② 请求没带会话 id。
		const noSession = await call(makeCtx({ agentTeams: { listTasks: () => VIEWS }, agents: { get: () => lead } }), '/company-board/api/team-tasks')
		assert.equal(noSession.payload.available, false)
		assert.match(noSession.payload.reason, /没带会话 id/)
		// ③ 那个会话不活着。
		const notLive = await call(makeCtx({ agentTeams: { listTasks: () => VIEWS }, agents: { get: () => undefined } }), '/company-board/api/team-tasks?session=sess-404')
		assert.match(notLive.payload.reason, /sess-404/)
		// ④ 老服务没有 `listTasks`。
		const unsupported = await call(makeCtx({ agentTeams: {}, agents: { get: () => lead } }), '/company-board/api/team-tasks?session=sess-1')
		assert.equal(unsupported.payload.available, false)
		assert.match(unsupported.payload.reason, /listTasks/)
		// ⑤ 还没成队（`listTasks` 抛错）：原文透出。
		const threw = await call(
			makeCtx({
				agentTeams: {
					listTasks() {
						throw new Error('TEAM_NOT_MEMBER: agent "sess-1" is not a member of an active Agent Team')
					},
				},
				agents: { get: () => lead },
			}),
			'/company-board/api/team-tasks?session=sess-1',
		)
		assert.equal(threw.status, 200)
		assert.equal(threw.payload.available, false)
		assert.match(threw.payload.reason, /TEAM_NOT_MEMBER/, '原生服务的原文要照引（诊断要用）')
		// 措辞本身也是一档要钉住的东西：**先说这一档读的是什么、再说本会话为什么没有**，
		// 而不是写成"你的会话读不到…多半是它还没成队"（那读起来像会话出错了）。
		assert.match(threw.payload.reason, /这一档读的是 DSH \*\*原生\*\*/, '要说清这一档读的是什么：' + threw.payload.reason.slice(0, 160))
		assert.match(threw.payload.reason, /本插件不建原生队伍/, '要说清为什么本会话没有：' + threw.payload.reason.slice(0, 200))
		assert.match(threw.payload.reason, /本插件的看板就是面板那一档/, '要指出去哪看：' + threw.payload.reason.slice(0, 200))
	})
})

// ── 「技能」块：宿主技能注册表的两条只读面 ─────────────────────────────────────

describe('技能栏：宿主技能注册表的只读面', () => {
	/** 一个假技能注册表：与 `ctx.skills` 那两个方法同形（`snapshot` / `get`），并把调用记下来。 */
	const fakeRegistry = (calls, options = {}) => ({
		async snapshot(view) {
			calls.push({ kind: 'snapshot', view })
			return {
				skills: options.skills ?? [
					{
						name: 'code-review',
						description: '按检查表过一遍改动',
						whenToUse: '提交前',
						source: 'user-dsh',
						provider: 'filesystem',
						path: '/u/.dsh/skills/code-review/SKILL.md',
						invocation: { modelInvocable: true, userInvocable: true },
						// 下面这些**不该**出现在载荷里：整形只留前面那几个叶子。
						resourceBase: { kind: 'directory', path: '/u/.dsh/skills/code-review' },
						internal: { secret: 'x' },
					},
					{ name: 'hidden-one', description: '谁都不该看到', source: 'project-dsh', provider: 'filesystem', path: '/w/.dsh/skills/hidden/SKILL.md', invocation: { modelInvocable: false, userInvocable: false } },
				],
				complete: options.complete === undefined ? true : options.complete,
			}
		},
		async get(name, view) {
			calls.push({ kind: 'get', name, view })
			if (name !== 'code-review') return undefined
			return {
				name,
				description: '按检查表过一遍改动',
				whenToUse: '提交前',
				source: 'user-dsh',
				provider: 'filesystem',
				path: '/u/.dsh/skills/code-review/SKILL.md',
				invocation: { modelInvocable: true, userInvocable: true },
				content: options.content ?? '# 代码复核\n\n一步一步来。',
			}
		},
	})

	const callSkills = async (ctx, url, method = 'GET') => {
		const { res, captured } = makeRes()
		const { handleSkills } = await import('../lib/board-view.host.js')
		await handleSkills(ctx, { method, url }, res, null)
		return { status: captured.status, payload: JSON.parse(captured.body) }
	}
	const callDefinition = async (ctx, url, method = 'GET') => {
		const { res, captured } = makeRes()
		const { handleSkillDefinition } = await import('../lib/board-view.host.js')
		await handleSkillDefinition(ctx, { method, url }, res, null)
		return { status: captured.status, payload: JSON.parse(captured.body) }
	}

	test('清单：cwd 用当前工作区、只留标量叶子、调用面摊成两个布尔、截断与未完成要说出来', async () => {
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-skills-'))
		const calls = []
		const ctx = { fs: makeFs(), get: (name) => (name === 'skills' ? fakeRegistry(calls) : undefined), logger: { warn() {} } }
		const out = await callSkills(ctx, `/company-board/api/skills?workspace=${encodeURIComponent(workspace)}`)
		assert.equal(out.status, 200, JSON.stringify(out.payload))
		assert.equal(out.payload.complete, true)
		assert.equal(out.payload.total, 2)
		assert.deepEqual(out.payload.workspace, workspace)
		assert.equal(calls.length, 1)
		assert.deepEqual(calls[0].view, { cwd: workspace }, '项目级技能根跟工作区走')
		const [first, second] = out.payload.skills
		// `level` / `levelLabel`（task-38）：面板的筛档与卡上来源标都照这两格画 —— 新增字段要在这里点名
		assert.deepEqual(Object.keys(first).sort(), ['description', 'level', 'levelLabel', 'modelInvocable', 'name', 'path', 'provider', 'source', 'userInvocable', 'whenToUse'].sort())
		assert.equal(first.modelInvocable, true)
		assert.equal(first.userInvocable, true)
		// 两面都没开的技能**照列**（它在目录里就是在），两个布尔都是 false。
		assert.equal(second.name, 'hidden-one')
		assert.equal(second.modelInvocable, false)
		assert.equal(second.userInvocable, false)

		// `complete: false` ⇒ 载荷里照实说，面板据此印「本轮扫描未完成，可能还有」。
		const calls2 = []
		const ctx2 = { fs: makeFs(), get: (name) => (name === 'skills' ? fakeRegistry(calls2, { complete: false }) : undefined), logger: { warn() {} } }
		const partial = await callSkills(ctx2, `/company-board/api/skills?workspace=${encodeURIComponent(workspace)}`)
		assert.equal(partial.payload.complete, false)

		// 工作区取不到：**不硬失败**（技能清单不像名册那样依赖工作区：用户级技能根与它无关），
		// 但必须（a）不传 cwd、（b）在载荷里说清"这次是按宿主进程目录解析的"。
		const calls3 = []
		const ctx3 = { fs: makeFs(), get: (name) => (name === 'skills' ? fakeRegistry(calls3) : undefined), logger: { warn() {} } }
		const noWorkspace = await callSkills(ctx3, '/company-board/api/skills')
		assert.equal(noWorkspace.status, 200, JSON.stringify(noWorkspace.payload))
		assert.equal(noWorkspace.payload.workspace, null)
		assert.deepEqual(calls3[0].view, {}, '取不到工作区就不传 cwd，别拿进程目录冒充会话工作区')
		assert.ok(noWorkspace.payload.warnings.some((line) => line.includes('宿主进程目录')), '按进程目录解析这件事要说出来')
	})

	test('视图层：有活着的会话就按它那一层读（与模型同一份）；退了层要说清凭什么退', async () => {
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-skills-layer-'))
		const encoded = encodeURIComponent(workspace)
		const query = `?workspace=${encoded}&session=sess-1`
		const session = { id: 'sess-1' }
		const rootAgent = { id: 'root-1' }
		const calls = []
		const makeCtx = (agents) => ({
			fs: makeFs(),
			get: (name) => (name === 'skills' ? fakeRegistry(calls) : name === 'agents' ? agents : undefined),
			logger: { warn() {} },
		})

		// ① 请求带的会话活着：**就用那个 Agent 当视图作用域**（它就是该会话的作用域键），
		// 于是读到的是会话那一层 —— 与模型看到的同一份；这时**不该**有退层告警。
		const live = await callSkills(makeCtx({ get: (id) => (id === 'sess-1' ? session : undefined), roots: () => [rootAgent] }), `/company-board/api/skills${query}`)
		assert.equal(live.status, 200, JSON.stringify(live.payload))
		assert.equal(live.payload.layer, 'session')
		assert.equal(calls.at(-1).view.scope, session, '按会话那一层读')
		assert.deepEqual(calls.at(-1).view.cwd, workspace)
		assert.ok(!live.payload.warnings.some((line) => line.includes('作用域')), '按会话层读时不该有退层告警：' + JSON.stringify(live.payload.warnings))

		// ② 会话不活着、但有活着的根会话：退到根会话那一层，并说清凭什么退。
		const fallback = await callSkills(makeCtx({ get: () => undefined, roots: () => [rootAgent] }), `/company-board/api/skills${query}`)
		assert.equal(fallback.payload.layer, 'root-agent')
		assert.equal(calls.at(-1).view.scope, rootAgent)
		assert.ok(fallback.payload.warnings.some((line) => line.includes('按**当前活着的根会话**那一层读')), JSON.stringify(fallback.payload.warnings))

		// ③ 一个活着的 Agent 都没有（连 agents 服务都没有）：只读全局层 —— 要说清，且**不能**说成"没有技能"。
		const global = await callSkills(makeCtx(undefined), `/company-board/api/skills${query}`)
		assert.equal(global.payload.layer, 'global')
		assert.deepEqual(calls.at(-1).view, { cwd: workspace }, '全局层：不传 scope')
		assert.ok(global.payload.warnings.some((line) => line.includes('全局层')), JSON.stringify(global.payload.warnings))
		// 清单与正文**同一个查询串** ⇒ 落在同一层（正文也带上了那个会话）。
		const definition = await callDefinition(makeCtx({ get: (id) => (id === 'sess-1' ? session : undefined), roots: () => [rootAgent] }), `/company-board/api/skills/definition?name=code-review&${query.slice(1)}`)
		assert.equal(definition.payload.layer, 'session')
		assert.equal(calls.at(-1).view.scope, session)
	})

	test('服务不在是「读不到」：503 并点名该装哪个包 —— 不是「一个技能都没有」', async () => {
		const ctx = { fs: makeFs(), get: () => undefined, logger: { warn() {} } }
		const out = await callSkills(ctx, '/company-board/api/skills?workspace=/w')
		assert.equal(out.status, 503)
		assert.equal(out.payload.ok, false)
		assert.match(out.payload.error, /ctx\.skills/)
		assert.match(out.payload.error, /读不到不等于"一个技能都没有"/)
		const def = await callDefinition(ctx, '/company-board/api/skills/definition?name=code-review')
		assert.equal(def.status, 503)
		// 非 GET 一律 405（只读面：连 POST 的入口都不留）。
		const posted = await callSkills({ fs: makeFs(), get: (name) => (name === 'skills' ? fakeRegistry([]) : undefined) }, '/company-board/api/skills', 'POST')
		assert.equal(posted.status, 405)
	})

	test('正文：按 name 现读（cwd 一起带上）；缺 name 400；未知名字 404；超长截断并明说', async () => {
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-skills-def-'))
		const calls = []
		const ctx = { fs: makeFs(), get: (name) => (name === 'skills' ? fakeRegistry(calls) : undefined), logger: { warn() {} } }
		const out = await callDefinition(ctx, `/company-board/api/skills/definition?name=code-review&workspace=${encodeURIComponent(workspace)}`)
		assert.equal(out.status, 200, JSON.stringify(out.payload))
		assert.equal(out.payload.name, 'code-review')
		const body = '# 代码复核\n\n一步一步来。'
		assert.equal(out.payload.content, body)
		assert.equal(out.payload.chars, body.length, 'chars 是正文长度（与回传的那段逐字对得上）')
		assert.equal(out.payload.truncated, false)
		assert.equal(out.payload.modelInvocable, true)
		assert.deepEqual(calls[0], { kind: 'get', name: 'code-review', view: { cwd: workspace } })

		const noName = await callDefinition(ctx, '/company-board/api/skills/definition')
		assert.equal(noName.status, 400)
		assert.match(noName.payload.error, /name 必填/)
		const unknown = await callDefinition(ctx, '/company-board/api/skills/definition?name=nope')
		assert.equal(unknown.status, 404)
		assert.match(unknown.payload.error, /技能目录里没有 nope/)

		// 超长正文：截断 + `truncated` + 一条明说截断的告警（**不假装那就是全文**）。
		const big = 'x'.repeat(300 * 1024)
		const calls2 = []
		const ctx2 = { fs: makeFs(), get: (name) => (name === 'skills' ? fakeRegistry(calls2, { content: big }) : undefined), logger: { warn() {} } }
		const huge = await callDefinition(ctx2, `/company-board/api/skills/definition?name=code-review&workspace=${encodeURIComponent(workspace)}`)
		assert.equal(huge.status, 200)
		assert.equal(huge.payload.truncated, true)
		assert.equal(huge.payload.chars, big.length, 'chars 是**完整**长度（截断不改这个数）')
		assert.ok(huge.payload.content.length < big.length)
		assert.ok(huge.payload.warnings.some((line) => line.includes('已截断')), '截断要说出来')
	})
})


// ── 工具面 / 提示词 / 假件的契约一致（这批修复的回归面） ──────────────────────

describe('宿主契约：成员面三条路必须把调用方的 signal 透传到原生', () => {
	test('spawn / send / wait 都带 exec.signal；假件照宿主那三行原文校验', async () => {
		// 为什么这条断言非空洞：假件现在**照宿主原文**对 `request.signal` 做 `AbortSignal.any` /
		// `signal.throwIfAborted()`，插件不传就当场抛 —— 退回旧实现（一个都不传）时，
		// 下面的 ok 断言与 signal 断言会同时变红，而不是"看着成功、其实没送出去"。
		const env = install()
		const ctrl = new AbortController()
		const exec = { agent: env.lead, signal: ctrl.signal }
		const made = await call(env.host, 'member_spawn', { role: 'reviewer', prompt: '首活' }, exec)
		assert.equal(made.ok, true, JSON.stringify(made).slice(0, 200))
		assert.equal(env.native.calls.spawn[0].signal, ctrl.signal, '`spawnTeammate` 无条件组合 `request.signal`：不传就恒失败')
		const sent = await call(env.host, 'member_send', { target: 'reviewer-1', message: '接着干' }, exec)
		assert.equal(sent.ok, true, JSON.stringify(sent).slice(0, 200))
		assert.equal(env.native.calls.send[0].signal, ctrl.signal, '`mailbox.send` 同样无条件组合 `request.signal`')
		const waited = await call(env.host, 'member_wait', {}, exec)
		assert.equal(waited.ok, true, JSON.stringify(waited).slice(0, 200))
		assert.equal(env.native.calls.wait[0].signal, ctrl.signal, '`activity.wait` 第一句就是 `signal.throwIfAborted()`')
		assert.equal(env.native.calls.wait[0].timeoutMs, 30000, '工具描述承诺的缺省 30000 要在插件侧兑现（旧实现把 undefined 原样递过去）')
	})

	test('拿不到 signal 时不带这个键（不把"缺"伪装成"有"）', async () => {
		const layer = await import('../team/native-layer.js')
		const seen = []
		const service = {
			listMembers: () => [],
			async spawnTeammate(caller, request) {
				seen.push(request)
				return { name: request.name }
			},
			async sendMessage(caller, request) {
				seen.push(request)
				return { messageId: 'm-1' }
			},
		}
		const ctx = { get: (name) => (name === 'agentTeams' ? service : undefined) }
		const spawned = await layer.spawnOrReuseTeammate(ctx, { id: 'lead' }, { role: 'qa', roleIds: ['qa'], roleFile: 'x', baselineFile: 'y', description: 'd', prompt: 'p', provider: 'spawn' })
		assert.equal(spawned.ok, true, JSON.stringify(spawned))
		const sent = await layer.sendToTeammate(ctx, { id: 'lead' }, { target: 'qa-1', content: 'x' })
		assert.equal(sent.ok, true, JSON.stringify(sent))
		for (const request of seen) assert.equal(Object.hasOwn(request, 'signal'), false, '拿不到信号就别带这个键：' + JSON.stringify(Object.keys(request)))
	})
})

describe('宿主契约：队伍载荷必须是**内容块数组**（字符串会被整条日志回放拒掉）', () => {
	// 为什么这三条非空洞：假件照宿主 `team/message/queued` 那份 schema 校验形状
	// （`AT:1179` 的 `content: z.array(contentBlockSchema)`），形状不对就抛宿主那句
	// `persisted Agent Teams team/message/queued payload is invalid` —— 于是"把字符串当块数组传"
	// 在这是**调用当场失败**，而不是靠断言里补一句。退回旧实现时下面三条会一起红。
	const shapeOf = (blocks) => (Array.isArray(blocks) ? blocks.map((block) => ({ type: block.type, text: typeof block.text === 'string' })) : blocks)
	const BLOCKS = [{ type: 'text', text: true }]

	test('member_send：content 是块数组，正文本身不被包坏', async () => {
		const env = install()
		const sent = await call(env.host, 'member_send', { target: 'reviewer-1', message: '接着干' }, env.exec)
		assert.equal(sent.ok, true, JSON.stringify(sent).slice(0, 200))
		const content = env.native.calls.send[0]?.content
		assert.deepEqual(shapeOf(content), BLOCKS, '`content` 必须是 `[{ type: "text", text }]`：' + JSON.stringify(content))
		assert.equal(content[0].text, '接着干', '正文一个字都不许变')
	})

	test('member_spawn（复用分支）：经 sendToTeammate 派活也是块数组', async () => {
		const env = install()
		await call(env.host, 'member_spawn', { role: 'reviewer', prompt: '第一件活' }, env.exec)
		const again = await call(env.host, 'member_spawn', { role: 'reviewer', prompt: '第二件活' }, env.exec)
		assert.equal(again.action, 'reused', '这一档已经有能接活的就该复用：' + JSON.stringify(again).slice(0, 200))
		const content = env.native.calls.send[0]?.content
		assert.deepEqual(shapeOf(content), BLOCKS, '复用那条路的 `content` 也必须是块数组：' + JSON.stringify(content))
		assert.ok(content[0].text.endsWith('第二件活'), '首活在正文末尾：' + content[0].text.slice(-80))
		assert.ok(content[0].text.includes('available_skills'), '装备那一行在前（含目录那条路）：' + content[0].text.slice(0, 160))
	})

	test('member_spawn（新建分支）：spawnTeammate 的 prompt 是块数组', async () => {
		const env = install()
		const made = await call(env.host, 'member_spawn', { role: 'reviewer', prompt: '首活：复核 X' }, env.exec)
		assert.equal(made.action, 'spawned', JSON.stringify(made).slice(0, 200))
		const prompt = env.native.calls.spawn[0]?.prompt
		assert.deepEqual(shapeOf(prompt), BLOCKS, '`prompt` 必须是 `[{ type: "text", text }]`：' + JSON.stringify(prompt))
		assert.ok(prompt[0].text.includes('首活：复核 X'), '本职活接在身份段后面')
	})

	test('反面：假件自己**真的会拦**字符串形状（不这么做上面三条就是看着绿）', () => {
		for (const bad of ['字符串不是块数组', [{ type: 'text' }], [{ type: 'image', text: 'x' }], null]) {
			assert.throws(
				() => assertTeamPayloadShape(bad),
				/persisted Agent Teams team\/message\/queued payload is invalid/,
				'形状不对必须抛宿主那句话：' + JSON.stringify(bad),
			)
		}
	})
})

describe('提示词与工具面：策略段只许点名真存在的工具', () => {
	test('策略段与每条工具描述里出现的每个 `member_*` 名字都在注册表里', async () => {
		// **同类一起扫**：不是只看策略段 —— 工具描述同样是模型每轮读得到的运行时输入。
		// 判定条件：把策略段与每个注册工具的描述里的 `` `member_xxx` ``（含带参数的写法）全抽出来，
		// 逐个对着注册表核。删工具时忘了删句子，这条就会红。
		const env = install()
		const { teamPolicyText } = await import('../team/team-runtime.js')
		const texts = [['策略段', teamPolicyText()], ...[...env.host.registered].map(([name, definition]) => [`工具 ${name} 的描述`, definition.description])]
		const found = new Map()
		for (const [where, text] of texts) {
			for (const match of String(text).matchAll(/`(member_[a-z_]+)(?:[^`]*)`/g)) {
				if (!found.has(match[1])) found.set(match[1], where)
			}
		}
		assert.ok(found.size >= 3, '至少要真的点名几个成员面工具：' + [...found.keys()].join('、'))
		for (const [name, where] of found) {
			assert.ok(env.host.registered.has(name), `${where}教了不存在的工具 \`${name}\`（注册表里只有：${[...env.host.registered.keys()].join('、')}）`)
		}
	})

	test('不再教归档 / 退役 / 删除成员，也没有 MB-<序号> 那种编号', async () => {
		const { teamPolicyText } = await import('../team/team-runtime.js')
		const policy = teamPolicyText()
		for (const dead of ['member_touch', 'member_retire', 'member_remove', 'member_update', 'member_interrupt']) {
			assert.ok(!policy.includes(dead), '策略段不该再出现 ' + dead)
		}
		assert.ok(!policy.includes('MB-<序号>'), '`member_spawn` 返回的是原生名册行，没有 MB-<序号> 这个编号')
		// 措辞改准：不再说「没有归档 / 退役两态」，改成**为什么 + 怎么办**
		assert.ok(policy.includes('原生名册只增不减'), '要正面说清原生名册只增不减')
		assert.ok(policy.includes('没有移除成员的接口'), '要给出为什么（宿主没有移除接口）')
		assert.ok(policy.includes('要一份干净的名册就开新会话'), '要给出怎么办（干净的名册靠新会话）')
	})
})

describe('回执与声明：不印没生效的东西', () => {
	test('role_manage 回执不再印工具面 / 模型 / 专属技能（三项都已没有消费者）', async () => {
		const env = install()
		const listed = await call(env.host, 'role_manage', { action: 'list' }, env.exec)
		assert.equal(listed.ok, true, JSON.stringify(listed).slice(0, 200))
		const line = listed.rows[0]
		for (const dead of ['工具面', '专属技能', '｜模型 ']) assert.ok(!line.includes(dead), `回执还在印没生效的「${dead}」：` + line)
		assert.ok(line.includes('包内') || line.includes('用户根'), '该印的（来路）还在：' + line)
	})

	test('member_spawn schema：reuse 进了 schema，model / task 两个死参数删掉', async () => {
		const env = install()
		const props = env.host.registered.get('member_spawn').parameters.properties
		assert.equal(Object.hasOwn(props, 'model'), false, 'model 没有任何消费者（原生 request 没有它），schema 许了就是骗人')
		assert.equal(Object.hasOwn(props, 'task'), false, '原生名册没有"当前任务"这个字段')
		assert.ok(Object.hasOwn(props, 'reuse'), '描述要求"明确新建带 reuse: false"，schema 就必须收它 —— 否则那条路在工具面上是关着的')
	})

	test('死链已清：startMemberChild / toolFilterOf / COORDINATOR_ONLY_TOOLS / kickMember / providerOf 不再出现', () => {
		const source = readFileSync('team/team-runtime.js', 'utf8')
		// `providerOf` 的调用者随成员面一起撤掉（成员由原生建，不再由本引擎挑提供方）⇒ 本轮一并清掉。
		for (const dead of ['startMemberChild', 'toolFilterOf', 'COORDINATOR_ONLY_TOOLS', 'kickMember', 'providerOf']) {
			assert.ok(!source.includes(dead), '引擎里还有死链：' + dead)
		}
	})

	test('启动日志不再宣告从未生效的「自动续领 / 冷恢复 开」', async () => {
		const workspace = mkdtempSync(join(tmpdir(), 'team-ops-log-'))
		const host = makeHost(workspace)
		const lines = []
		host.ctx.logger = { info: (line) => lines.push(line), warn: () => {} }
		runtime.apply(host.ctx, { autoDispatch: true, coldRecovery: true })
		const startLine = lines.find((line) => line.includes('运行时已装载'))
		assert.ok(startLine, '要有一行启动日志（实际：' + JSON.stringify(lines) + '）')
		for (const claim of ['冷恢复', '自动续领']) {
			assert.ok(!startLine.includes(claim), `日志不许宣告从来没生效的「${claim} 开」：` + startLine)
		}
	})
})

describe('board_task 参数面：按原生重写（不生效的字段一个都不留）', () => {
	let env
	beforeEach(() => {
		env = install()
	})
	const board = (args) => call(env.host, 'board_task', args, env.exec)

	test('schema 只留原生真读的字段，编号形状写 task-<n>', () => {
		const props = env.host.registered.get('board_task').parameters.properties
		for (const dead of ['status', 'priority', 'artifact', 'note', 'phase', 'blocked_by', 'by', 'force', 'keep_assignee', 'check', 'attempt_id', 'filter_phase']) {
			assert.equal(Object.hasOwn(props, dead), false, `board_task 不读 ${dead}，留在 schema 里就是承诺不生效的能力`)
		}
		for (const live of ['action', 'id', 'expected_revision', 'subject', 'description', 'blocked_by_tasks', 'write_scopes', 'filter_status', 'filter_owner', 'ready', 'owner', 'assignee']) {
			assert.ok(Object.hasOwn(props, live), '该有的字段没了：' + live)
		}
		assert.ok(props.id.description.includes('task-<n>'), '编号形状要写明：' + props.id.description)
	})

	test('编号写错时回执指出正确形状（原生只说 not found）', async () => {
		const bad = await board({ action: 'get', id: 'T-002' })
		assert.equal(bad.ok, false)
		assert.match(bad.error, /task-<n>/, '要指出正确形状：' + bad.error)
		assert.match(bad.error, /not found/, '原生那句原因原样留着：' + bad.error)
	})

	test('filter_status 认中文那三档（映射到原生）；枚举外给可读说明而不是 0 条', async () => {
		await board({ action: 'register', subject: '一件小事', description: '细节' })
		const chinese = await board({ action: 'query', filter_status: '待办' })
		assert.equal(chinese.ok, true, JSON.stringify(chinese).slice(0, 200))
		assert.equal(chinese.count, 1, '「待办」要映射到原生的 pending，而不是拿中文去和原生三态比：' + JSON.stringify(chinese))
		const native = await board({ action: 'query', filter_status: 'pending' })
		assert.equal(native.count, 1)
		const refused = await board({ action: 'query', filter_status: '已打回' })
		assert.equal(refused.ok, false, '原生没有这一档 ⇒ 明确拒绝，不能安静地回 0 条（0 条会被读成"没有待办"）')
		assert.match(refused.error, /原生任务只有三档/)
	})

	test('filter_owner 按原生那一格 ownerName 筛；ready 用原生算好的那一格', async () => {
		const first = await board({ action: 'register', subject: 'a', description: 'a' })
		await board({ action: 'register', subject: 'b', description: 'b' })
		await board({ action: 'claim', id: first.task.id, expected_revision: 1 })
		const mine = await board({ action: 'query', filter_owner: 'lead' })
		assert.equal(mine.count, 1, '原生视图里负责人那一格是 ownerName（旧实现拿 row.owner 比，永远筛出空表）：' + JSON.stringify(mine.rows))
		assert.equal(mine.rows[0].id, first.task.id)
		const readyOnly = await board({ action: 'query', ready: true })
		assert.equal(readyOnly.count, 1, 'ready=true 只该剩那条待办（旧实现完全不读这个参数）：' + JSON.stringify(readyOnly.rows.map((row) => row.id)))
	})
})

describe('member_list 过滤器：status 真的过滤，roster 删掉（原生没有那两态）', () => {
	test('status 生效；枚举外取值给可读说明；schema 里没有 roster', async () => {
		const env = install()
		await call(env.host, 'member_spawn', { role: 'reviewer', prompt: 'x' }, env.exec)
		env.native.members.push({ id: 'gone', name: 'qa-9', role: 'teammate', status: 'failed' })
		const props = env.host.registered.get('member_list').parameters.properties
		assert.equal(Object.hasOwn(props, 'roster'), false, '原生名册没有归档 / 退役两态，roster 参数不该在')
		const running = await call(env.host, 'member_list', { status: 'running' }, env.exec)
		assert.equal(running.ok, true, JSON.stringify(running).slice(0, 200))
		assert.ok(running.rows.every((row) => row.status === 'running'), JSON.stringify(running.rows))
		assert.deepEqual(running.rows.map((row) => row.name), ['lead'], '只有协调者那一行是 running（旧实现把 args 整个忽略，会回全表）')
		const failed = await call(env.host, 'member_list', { status: 'failed' }, env.exec)
		assert.deepEqual(failed.rows.map((row) => row.name), ['qa-9'])
		const bad = await call(env.host, 'member_list', { status: '退役' }, env.exec)
		assert.equal(bad.ok, false, '枚举外的取值要给可读说明：' + JSON.stringify(bad))
		// 同一口径改准：说清「只增不减」与「没有已移除这一档」，
		// 不再借那两个已经删掉的档位（归档 / 退役）当解释
		assert.match(bad.error, /只增不减/)
	})
})

describe('README：只承诺实现里真的有的东西', () => {
	test('「团队是文件」收窄；退役留记录删掉；三份文件逐个点明真源 / 遗留', () => {
		const readme = readFileSync('README.md', 'utf8')
		assert.ok(!readme.includes('退役留记录'), '退役这条路现在没有工具，README 不许再承诺')
		assert.ok(!readme.includes('退役只是写状态、留记录占名字'), '同一处承诺的第二种写法也要删')
		assert.ok(!/看板、名册、邮箱、你说过的每一句判断都落在工作区里/.test(readme), '看板与邮箱已经归原生，不再落在工作区文件里')
		assert.ok(readme.includes('原生 Agent Teams'), '要看板 / 邮箱的真源写出来')
		assert.ok(readme.includes('遗留'), '不再更新的那几份要标成遗留')
		assert.ok(readme.includes('.company-gate.human.json') && readme.includes('.company-gate.roles.json'), '真源那两份要逐个点明')
	})
})

describe('成员写面整面撤掉：两条路由只剩可读拒绝，引擎侧能力已清空', () => {
	/** 真驱动一次成员写 handler：`writeJson` 只用到 `writeHead` / `end` 两件。 */
	const drive = async (action) => {
		const { handleMemberWrite } = await import('../lib/board-view.host.js')
		const seen = {}
		const res = {
			writeHead: (status, headers) => {
				seen.status = status
				seen.headers = headers
			},
			end: (body) => {
				seen.body = body
			},
		}
		await handleMemberWrite({}, { method: 'POST' }, res, '/tmp/ws', action)
		return { status: seen.status, payload: JSON.parse(seen.body) }
	}

	test('两条路由对直接 POST 仍回可读拒绝（这是拒绝面，不是写面）', async () => {
		const host = readFileSync('lib/board-view.host.js', 'utf8')
		assert.ok(host.includes("await handleMemberWrite(ctx, req, res, workspace, 'update')"), 'update 路由仍挂在同一个 handler 上')
		assert.ok(host.includes("await handleMemberWrite(ctx, req, res, workspace, 'delete')"), 'delete 路由仍挂在同一个 handler 上')
		const { MEMBER_UPDATE_PATH, MEMBER_DELETE_PATH } = await import('../lib/board-view.host.js')
		assert.match(MEMBER_UPDATE_PATH, /\/members\/update$/)
		assert.match(MEMBER_DELETE_PATH, /\/members\/delete$/)
		for (const [action, word] of [['update', '编辑'], ['delete', '删除']]) {
			const { status, payload } = await drive(action)
			assert.equal(status, 200, action + ' 仍要以 JSON 回执作答')
			assert.equal(payload.ok, false)
			assert.ok(payload.error.includes('不能'), '要说清这一档没有：' + payload.error)
			assert.ok(payload.error.includes(word) || payload.error.includes(action === 'delete' ? '删除成员' : '改成员记录'), '要说是哪种动作：' + payload.error)
			assert.ok(payload.error.includes('原生'), '要说清成员现在归谁：' + payload.error)
			// **HD-006 之后指路要指到真能做的三个动词上**（从前这里写的是内置 `interrupt_agent`）：
			for (const path of ['/members/disable', '/members/restore', '/members/interrupt']) {
				assert.ok(payload.error.includes(path), `要指路到 ${path}：` + payload.error)
			}
		}
	})

	test('撤面：引擎与转发都不再导出这六个名字，源码里也零命中', async () => {
		const runtime = await import('../team/team-runtime.js')
		const gateWrite = await import('../lib/gate-write.js')
		// 名字**拆开拼**：这段自检本身也要能在"全仓零命中"的判据下过（grep 这几个名字不该只剩历史注释）。
		const gone = (parts) => parts.join('')
		for (const name of [gone(['update', 'MemberRecord']), gone(['delete', 'MemberRecord']), gone(['patch', 'RosterRow']), gone(['redeliver', 'PromptOf'])]) {
			assert.equal(runtime[name], undefined, 'team-runtime 不该再导出 ' + name)
		}
		for (const name of [gone(['updateMember', 'InWorkspace']), gone(['deleteMember', 'InWorkspace'])]) {
			assert.equal(gateWrite[name], undefined, 'gate-write 不该再导出 ' + name)
		}
		// 源码面（这个测试文件自己要列这些名字，所以不扫它）。
		const dead = [
			gone(['updateMember', 'InWorkspace']),
			gone(['deleteMember', 'InWorkspace']),
			gone(['patch', 'RosterRow']),
			gone(['update', 'MemberRecord']),
			gone(['redeliver', 'PromptOf']),
			gone(['delete', 'MemberRecord']),
		]
		for (const file of ['lib/gate-write.js', 'lib/board-view.host.js', 'team/team-runtime.js']) {
			const text = readFileSync(file, 'utf8')
			for (const name of dead) assert.ok(!text.includes(name), file + ' 里还有 ' + name)
		}
		// 面板那条路只读不写：README 不许再说"这份文件是给面板编辑成员用的"
		const readme = readFileSync('README.md', 'utf8')
		assert.ok(!readme.includes('只在面板编辑成员时用到'), '撤面之后 README 要按实际读法改口')
		// **task-40 起连读都不读了**：README 必须说清"面板不再读它、文件还在也不影响任何读数"
		assert.ok(readme.includes('面板不再读它'), '要写清这份文件现在谁都不读（面板不再读它）')
		assert.ok(!readme.includes('面板「成员」块读的历史编制行'), '那句"面板在读它"的说法必须清掉')
	})

	test('旧那条"删除成员不再写冻结看板"的护栏仍在（releaseOpenAttemptsOf 不留）', () => {
		assert.ok(!readFileSync('team/team-runtime.js', 'utf8').includes('releaseOpenAttemptsOf'))
		assert.ok(!readFileSync('team/company-gate.js', 'utf8').includes('releaseOpenAttemptsOf'))
	})
})


// ── 行政面的门：调用方身份（成员只能干执行者的日常） ────────────────────────

describe('行政面的门：role_manage 与 board_task 的调用方身份', () => {
	let env
	beforeEach(() => {
		env = install()
	})
	/** 一个**成员身份**的调用方：会话带父会话（宿主 `tryMembership` 就是这么判 teammate 的）。 */
	const asMember = () => ({ agent: makeAgent(env.workspace, 'child-1', { parentSession: env.lead.id }), signal: env.exec.signal })

	test('协调者：两个行政面照旧可用（门不许挡错人）', async () => {
		const roles = await call(env.host, 'role_manage', { action: 'list' }, env.exec)
		assert.equal(roles.ok, true, JSON.stringify(roles).slice(0, 200))
		const made = await call(env.host, 'board_task', { action: 'register', subject: 'a', description: 'a' }, env.exec)
		assert.equal(made.ok, true, JSON.stringify(made).slice(0, 200))
	})

	test('成员身份：role_manage 拿到可读拒绝（说清为什么、该找谁），且不落文件', async () => {
		const refused = await call(env.host, 'role_manage', { action: 'list' }, asMember())
		assert.equal(refused.ok, false, JSON.stringify(refused))
		assert.match(refused.error, /团队成员/, refused.error)
		assert.match(refused.error, /协调者/, refused.error)
		assert.match(refused.error, /member_send/, '要指路：' + refused.error)
		assert.ok(!existsSync(join(env.workspace, '.company-gate.roles.json')), '拒绝之后不许落角色开关文件')
		// 停用也一样被挡（不是只有 list 被挡）
		const disabled = await call(env.host, 'role_manage', { action: 'disable', role: 'qa' }, asMember())
		assert.equal(disabled.ok, false, JSON.stringify(disabled))
		assert.ok(!existsSync(join(env.workspace, '.company-gate.roles.json')), '被挡的停用不许落盘')
	})

	test('成员身份：board_task 的登记与裁决全拒，执行面照旧', async () => {
		const created = await call(env.host, 'board_task', { action: 'register', subject: 'a', description: 'a' }, env.exec)
		assert.equal(created.ok, true, JSON.stringify(created).slice(0, 200))
		const id = created.task.id
		for (const args of [
			{ action: 'register', subject: 'b', description: 'b' },
			{ action: 'reassign', id, expected_revision: 1, owner: 'someone' },
			{ action: 'delete', id, expected_revision: 1 },
			{ action: 'set_dependencies', id, expected_revision: 1, blocked_by_tasks: [] },
			{ action: 'edit', id, expected_revision: 1, subject: 'x' },
			{ action: 'update', id, expected_revision: 1, subject: 'x' },
			{ action: 'reopen', id, expected_revision: 1 },
		]) {
			const refused = await call(env.host, 'board_task', args, asMember())
			assert.equal(refused.ok, false, args.action + ' 成员不该能做：' + JSON.stringify(refused))
			assert.match(refused.error, /团队成员/, args.action + ' 的拒绝要可读：' + refused.error)
			assert.match(refused.error, /协调者/, args.action + ' 要说清该找谁：' + refused.error)
		}
		// 执行者的日常：读 / 认领 / 收口，成员照旧
		const listed = await call(env.host, 'board_task', { action: 'query' }, asMember())
		assert.equal(listed.ok, true, JSON.stringify(listed).slice(0, 200))
		const got = await call(env.host, 'board_task', { action: 'get', id }, asMember())
		assert.equal(got.ok, true, JSON.stringify(got).slice(0, 200))
		const claimed = await call(env.host, 'board_task', { action: 'claim', id, expected_revision: 1 }, asMember())
		assert.equal(claimed.ok, true, JSON.stringify(claimed).slice(0, 200))
		const released = await call(env.host, 'board_task', { action: 'release', id, expected_revision: 2 }, asMember())
		assert.equal(released.ok, true, JSON.stringify(released).slice(0, 200))
		const claimedAgain = await call(env.host, 'board_task', { action: 'claim', id, expected_revision: 3 }, asMember())
		assert.equal(claimedAgain.ok, true, JSON.stringify(claimedAgain).slice(0, 200))
		const done = await call(env.host, 'board_task', { action: 'complete', id, expected_revision: 4 }, asMember())
		assert.equal(done.ok, true, JSON.stringify(done).slice(0, 200))
	})

	test('判据本身：宿主那一版优先，没有它时看父会话，判不出来宁拒不放', () => {
		const { coordinatorCheckOf } = gate
		const ctxWith = (service) => ({ get: (name) => (name === 'agentTeams' ? service : undefined) })
		const lead = makeAgent(env.workspace, 'sess-lead')
		const child = makeAgent(env.workspace, 'sess-child', { parentSession: 'sess-lead' })
		const ask = (ctx, agent) => coordinatorCheckOf(ctx, agent, { tool: 'x', why: 'y' })
		// ① 服务那一版没有 `tryMembership` ⇒ 回落看父会话
		assert.equal(ask(ctxWith({}), lead).ok, true, '没有父会话 ⇒ 协调者')
		assert.equal(ask(ctxWith({}), child).ok, false, '有父会话 ⇒ 成员')
		// ② 有 `tryMembership` 时**以它为准**（哪怕 session 上看得出来/看不出来）
		assert.equal(ask(ctxWith({ tryMembership: () => ({ role: 'teammate' }) }), lead).ok, false, '宿主说是成员就是成员')
		assert.equal(ask(ctxWith({ tryMembership: () => ({ role: 'lead' }) }), child).ok, true, '宿主说是协调者就是协调者')
		// ③ 宿主抛（不是活的队内成员）⇒ 回落那一层，不在这一层编答案
		const threw = { tryMembership: () => { throw new Error('TEAM_NOT_MEMBER') } }
		assert.equal(ask(ctxWith(threw), child).ok, false, '宿主抛 + 有父会话 ⇒ 成员')
		assert.equal(ask(ctxWith(threw), lead).ok, true, '宿主抛 + 没有父会话 ⇒ 协调者')
		// ④ 拿不到身份：**宁拒不放**
		assert.equal(ask(ctxWith({}), undefined).ok, false, '拿不到身份不许放行')
		assert.equal(ask(ctxWith({}), undefined).reason.includes('调用者身份'), true)
	})
})


// ── 旧文件看板引擎与死件（撤面之后不该再有第二个账本） ──────────────────────

describe('旧文件看板引擎与死件已清', () => {
	test('那批旧看板功能与死件在引擎源码里零命中', () => {
		// 判据：那一簇在两个调用点被清掉之后已经没有任何入口 —— 整簇删掉，
		// 名字也不许以"历史注释"的形式留在源码里（下一个读代码的人不该被它指去一个不存在的东西）。
		const gone = [
			'boardTaskAction', 'mutateBoardTask', 'registerTask', 'claimTask', 'releaseTask',
			'submitTask', 'acceptTask', 'rejectTask', 'completeTask', 'reopenTask', 'deleteTask',
			'reassignTask', 'setTaskDependencies', 'editBoardTask', 'queryBoard', 'viewBoard',
			'emptyBoard', 'optionalTaskIds', 'optionalWriteScopes', 'assertTaskRevision',
			'taskHistoryPush', 'dependencyWouldCycle', 'beginTaskAttempt', 'invalidateTaskAttempt',
			'taskReadyOf', 'taskViewOf', 'taskRevisionOf', 'boardStateOf', 'boardStatusOf',
			'normalizeBoardStatus', 'renderTasksMarkdown', 'renderBoardTable', 'boardViewHeader',
			'renderOwnerIndex', 'renderPhaseIndex', 'milestoneNamesOf', 'boardLineWarnings',
			'optionalPhase', 'optionalBoolean', 'writeTextAtomic',
			'assertCoordinator', 'discardStaleMail', 'rosterViews', 'rolesLedgerOf', 'renderInboxTable',
			'nextMemberId', 'nextMessageId', 'dirnameOfRoleFile', 'readRoster', 'readBoard',
			'transactMailbox', 'markMail', 'mailStateOf', 'mailRowOf', 'deliverableMail', 'staleMail',
			'trimMailbox', 'runtimeStatusOf', 'memberViewOf', 'liveStateOf',
			'agentRunning', 'callerOf', 'memberByName', 'nameTaken', 'createWaiters', 'pickTaskFor',
			'taskReadyOfSafe', 'openAttemptTaskOf', 'memberIntro', 'memberTaskWarnings', 'memberOf',
			'mailboxMessages', 'emptyMailbox',
		]
		for (const file of ['team/company-gate.js', 'team/team-runtime.js']) {
			const text = readFileSync(file, 'utf8')
			for (const name of gone) {
				// **`readRoster` 这一格现在有主了**：`lib/roster.js` 的**角色**名册（活代码 —— 交接快照用它
				// 把成员名反读成角色）。所以这一条收成"不许再有**本地定义**"：那才是死件复活的形态
				// （旧的那个是成员名册，它只能以"在这里实现一份"的方式回来）。
				if (name === 'readRoster') {
					assert.ok(!/function\s+readRoster\b/.test(text), file + ' 里又出现了本地定义的 readRoster')
					continue
				}
				assert.ok(!new RegExp('\\b' + name + '\\b').test(text), file + ' 里还有 ' + name)
			}
		}
	})

	test('全仓不再有写 `.company-gate.board.json` / `.company-gate.mailbox.json` 的路径', () => {
		// 判据不是"提没提这个名字"（注释里说明它们是遗留文件是**对的**），而是**写盘清单里还有没有它们**：
		// 引擎每一次落盘都按 `LEDGER_FILE` 取文件名，所以那张表里没有 = 没有写路径。
		// ① 引擎那两半的 `LEDGER_FILE` 不再登记 board / members / mailbox；
		// ② `lib/` 下唯一还提它们的是那条**只读**的摘要 hook（`ledger-digest.js`），其余一个都不许提。
		const gateSource = readFileSync('team/company-gate.js', 'utf8')
		const mapBody = gateSource.slice(gateSource.indexOf('const LEDGER_FILE = {'), gateSource.indexOf('const ID_PREFIX = {'))
		for (const legacy of ['board:', 'members:', 'mailbox:']) {
			assert.ok(!new RegExp('^\\s*' + legacy, 'm').test(mapBody), '写盘清单里不该再有 ' + legacy + '：' + mapBody)
		}
		const runtimeSource = readFileSync('team/team-runtime.js', 'utf8')
		for (const legacy of ['LEDGER_FILE.board', 'LEDGER_FILE.members', 'LEDGER_FILE.mailbox']) {
			assert.ok(!runtimeSource.includes(legacy), '运行时还在按名字取遗留文件：' + legacy)
		}
		// ③ **按行**判"提它"与"写它"不许同现：读它 / 在注释里说明它是可以的（面板那两档都只读），
		// 但任何一行同时出现遗留文件名与写盘原语，就是"还有人往那份冻结的账上写"。
		const writeCalls = ['writeFileSync(', 'writeText(', 'commitLedger(', 'transact(']
		const scan = ['team/company-gate.js', 'team/team-runtime.js', ...readdirSync('lib').filter((e) => e.endsWith('.js')).map((e) => join('lib', e))]
		for (const file of scan) {
			readFileSync(file, 'utf8')
				.split('\n')
				.forEach((line, index) => {
					if (!line.includes('.company-gate.board.json') && !line.includes('.company-gate.mailbox.json')) return
					for (const writeCall of writeCalls) {
						assert.ok(!line.includes(writeCall), `${file}:${index + 1} 在同一条语句里既提遗留文件又调写盘原语：` + line.trim().slice(0, 120))
					}
				})
		}
		// 摘要那一份是**只读**的：它只读文件、从不写（写盘函数名一个都不该出现在它里面）。
		const digest = readFileSync('lib/ledger-digest.js', 'utf8')
		for (const writer of ['writeFileSync', 'commitLedger', 'transact(']) {
			assert.ok(!digest.includes(writer), '摘要 hook 是只读的，不许出现写盘调用：' + writer)
		}
	})
})


// ── 人的话：记一条也归协调器（描述与实现对齐） ──────────────────────────────

describe('人的话：记一条也归协调器（描述与实现对齐）', () => {
	test('成员身份：拿到可读拒绝，且**不落文件**（在"谁都没写过"的空工作区上先打这一条）', async () => {
		const env = install()
		const member = { agent: makeAgent(env.workspace, 'child-1', { parentSession: env.lead.id }), signal: env.exec.signal }
		assert.ok(!existsSync(join(env.workspace, '.company-gate.human.json')), '前提：这个工作区谁都没写过人的话')
		const refused = await call(env.host, 'human_words_record', { text: '成员不许记这句', kind: 'goal' }, member)
		assert.equal(refused.ok, false, JSON.stringify(refused))
		assert.match(refused.error, /团队成员/, refused.error)
		assert.match(refused.error, /协调者/, refused.error)
		assert.match(refused.error, /member_send/, '要指路：' + refused.error)
		assert.ok(!existsSync(join(env.workspace, '.company-gate.human.json')), '被拒之后一个字节都不许落')
		// 只读那一面不受影响（它是"读"，不是"记"）
		const listed = await call(env.host, 'human_words_list', {}, member)
		assert.equal(listed.ok, true, JSON.stringify(listed).slice(0, 200))
	})

	test('协调者身份照常可用；描述里那句"只有协调器能做"与实现对得上', async () => {
		const env = install()
		const recorded = await call(env.host, 'human_words_record', { text: '人定的一句目标', kind: 'goal' }, env.exec)
		assert.equal(recorded.ok, true, JSON.stringify(recorded).slice(0, 200))
		assert.ok(existsSync(join(env.workspace, '.company-gate.human.json')), '协调者写要落盘')
		// 描述面：把这道门写进工具描述（否则又是"描述与实现各说各的"）
		const description = env.host.registered.get('human_words_record').description
		assert.ok(description.includes('只有协调器（主会话）能做'), '描述要写明这道门：' + description.slice(-200))
		// **同类一起扫**：成员面那两个工具的描述不许再说"只写 `.company-gate.members.json`" —— 它们一个文件都不写；
		// `role_manage` 也不该再借成员名册那条边界，它真写的是角色开关那一份。
		for (const name of ['member_spawn', 'member_send']) {
			const text = env.host.registered.get(name).description
			assert.ok(!text.includes('.company-gate.members.json'), name + ' 的描述不许再点名那份不再写的文件：' + text.slice(-200))
		}
		// **判据只许钉 `边界：` 那一行**：整段描述正文里本来就有 `.company-gate.roles.json`
		// （"停用状态记在当前工作区的 `.company-gate.roles.json`"）—— 拿整段去断，改不改边界都绿，
		// 就是一条钉不住的断言（现场验过一次：把边界退回借成员名册那条，它没红）。
		const roleDesc = env.host.registered.get('role_manage').description
		const roleBoundary = roleDesc.split('\n').find((line) => line.startsWith('边界：'))
		assert.ok(roleBoundary !== undefined, 'role_manage 的描述里要有一条「边界：」行：' + roleDesc.slice(-200))
		assert.ok(roleBoundary.includes('.company-gate.roles.json'), 'role_manage 的边界要说它真写的那份文件：' + roleBoundary)
		assert.ok(!roleBoundary.includes('.company-gate.members.json'), 'role_manage 不许再借成员名册那条边界：' + roleBoundary)
	})
})

// ── 对话建角色与建技能（能力沉淀：校验 → 组装 → 既有写入层 → 回读 → 回执） ──────

/**
 * 一件沙盒：`DSH_HOME` 指到临时目录 ⇒ 用户角色根（`$DSH_HOME/team-ops/roles`）与用户技能根
 * （`$DSH_HOME/skills`）都在临时目录里，**绝不写这台机器真正的用户根**。
 * 技能目录按面板同一条读法喂一个假注册表（`ctx.get('skills').snapshot`）。
 */
function defineEnv() {
	const home = mkdtempSync(join(tmpdir(), 'team-ops-define-'))
	const before = { home: process.env.DSH_HOME, roles: process.env.DSH_TEAM_OPS_ROLES }
	process.env.DSH_HOME = home
	delete process.env.DSH_TEAM_OPS_ROLES
	const env = install()
	const catalog = { names: ['perf-baseline', 'ui-styling'], calls: [] }
	const baseGet = env.host.ctx.get.bind(env.host.ctx)
	env.host.ctx.get = (name) =>
		name === 'skills'
			? {
					async snapshot(options) {
						catalog.calls.push(options)
						return { skills: catalog.names.map((skill) => ({ name: skill })), complete: true }
					},
				}
			: baseGet(name)
	const restore = () => {
		if (before.home === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = before.home
		if (before.roles === undefined) delete process.env.DSH_TEAM_OPS_ROLES
		else process.env.DSH_TEAM_OPS_ROLES = before.roles
	}
	const roleFile = (id) => join(home, 'team-ops', 'roles', id, 'ROLE.md')
	// **工作区角色根**（HD-008 之后 `role_define` 的缺省落点）：`<工作区>/.dsh/team-ops/roles/<id>/ROLE.md`。
	const workspaceRoleFile = (id) => join(env.workspace, '.dsh', 'team-ops', 'roles', id, 'ROLE.md')
	const skillFile = (name) => join(home, 'skills', name, 'SKILL.md')
	// **工作区技能根**（HD-008 之后 `skill_define` 的缺省落点）：`<工作区>/.dsh/skills/<name>/SKILL.md`。
	const workspaceSkillFile = (name) => join(env.workspace, '.dsh', 'skills', name, 'SKILL.md')
	return { ...env, home, catalog, restore, roleFile, workspaceRoleFile, skillFile, workspaceSkillFile }
}

/** 一份能过全部校验的角色入参（各用例只改自己那一格）。 */
const goodRole = {
	id: 'probe-role',
	title: '探针角色',
	category: '质量',
	positioning: '对探针的准与全负责。',
	when: '需要一次端到端探针时。',
	boundaries: ['不写别人的角色', '不派活、不改看板'],
	checklist: ['产物落成文件', '关键事实可核'],
	deliverables: ['docs/team/verify/探针.md'],
	skills: ['perf-baseline'],
}

describe('对话建角色：role_define', () => {
	test('建得出来 + 写盘后回读（front-matter / kind / 名册 / member_defaults / 这一档还没人）', async () => {
		const env = defineEnv()
		try {
			// **缺省 scope = workspace**（HD-008）：落本工作区的角色根，**不碰**用户根。
			const receipt = await call(env.host, 'role_define', goodRole, env.exec)
			assert.equal(receipt.ok, true, JSON.stringify(receipt))
			assert.equal(receipt.scope, 'workspace', '缺省作用域是 workspace：' + JSON.stringify(receipt.scope))
			assert.ok(String(receipt.file).includes(join('.dsh', 'team-ops', 'roles')), '落点是工作区的角色根：' + String(receipt.file))
			assert.match(String(receipt.scopeLine), /只有这个工作区看得见/, '回执要逐字说清可见范围：' + String(receipt.scopeLine))
			assert.ok(!existsSync(env.roleFile('probe-role')), '缺省**不许**写用户根（跨工作区可见的那一份）')
			const text = readFileSync(env.workspaceRoleFile('probe-role'), 'utf8')
			assert.match(text, /^kind: role$/m, 'front-matter 要写 kind: role')
			assert.match(text, /^name: probe-role$/m)
			assert.match(text, /^description: Use when 需要一次端到端探针时。$/m, 'when 进 front-matter 那句')
			assert.match(text, /^skills: perf-baseline$/m, '声明的技能写进 skills 行')
			assert.match(text, /^## 检查表$/m)
			assert.match(text, /^## 落点（产出与落盘）$/m)
			assert.match(text, /^## 边界（明确不做什么）$/m)
			assert.match(text, /对探针的准与全负责。/, '定位句在正文里（与 when 分开）')
			assert.ok(runtime.roleCatalog(undefined, env.workspace).includes('probe-role'), 'roleCatalog(工作区) 要枚举得到它')
			assert.ok(receipt.readBack.some((line) => line.includes('枚举得到它')), '回执照实说回读结果：' + JSON.stringify(receipt.readBack))
			assert.ok(receipt.readBack.some((line) => line.includes('这一档现在还没有成员')), '回执要说这一档现在有没有人')
			// **生效面与面板那三条写动作共用一对字段**（`roleWriteEffects`），且字段名不叫 `restartRequired`
			assert.equal(receipt.restartRequired, undefined, '不许再有把"能不能用"挂在重启上的字段名')
			assert.equal(receipt.promptRoster, 'stale', '要说清旧的是**注入清单那颗快照**')
			assert.match(receipt.promptRosterNote, /立刻可用/)
			assert.match(receipt.promptRosterNote, /现枚举/)
			assert.match(receipt.promptRosterNote, /装载时的快照/)
			assert.match(receipt.promptRosterNote, /不影响.*能不能叫人/)
			assert.ok(env.catalog.calls.length >= 1, '技能名核对走的是 ctx.get(\'skills\').snapshot（与面板同一条读法）')
		} finally {
			env.restore()
		}
	})

	test('工作区角色根不存在 ⇒ 那一层枚举为空、**不报错**；包内 19 份照旧在（顺序：工作区 → 用户 → 包内）', async () => {
		const runtime2 = await import('../team/team-runtime.js')
		const bare = mkdtempSync(join(tmpdir(), 'team-ops-nowsroot-'))
		assert.ok(!existsSync(join(bare, '.dsh', 'team-ops', 'roles')), '夹具前提：这个工作区没有角色根')
		// 不抛：只是那一层贡献 0 条
		const roots = runtime2.roleRootRecords(bare).map((entry) => entry.source)
		assert.ok(!roots.includes('workspace'), '不存在的根不列：' + JSON.stringify(roots))
		assert.ok(roots.includes('package'), '包内那层照旧在：' + JSON.stringify(roots))
		const catalog = runtime2.roleCatalog(undefined, bare)
		assert.ok(catalog.includes('architect') && catalog.includes('reviewer'), '包内那 19 份读得到：' + catalog.slice(0, 8).join('、'))
		assert.equal(runtime2.roleRecordsFor(bare).filter((record) => record.source === 'workspace').length, 0, '工作区那一层是空的')
		assert.deepEqual(runtime2.roleRecordsFor(undefined).filter((record) => record.source === 'workspace'), [], '不给工作区 ⇒ 同样没有工作区那一层')
	})

	test('枚举顺序的唯一正文在 `lib/roster.js`：工作区 > 用户 > 包内（同名高处赢）', async () => {
		const mod = await import('../lib/roster.js')
		const wsRoot = mod.workspaceRolesRoot('/w')
		assert.equal(wsRoot, join('/w', '.dsh', 'team-ops', 'roles'), '工作区角色根的路径形状')
		assert.equal(mod.workspaceRolesRoot(undefined), null, '没工作区 ⇒ null（调用方据此决定用不用）')
		assert.deepEqual(mod.ROLE_SCOPES, ['workspace', 'user'])
		assert.equal(mod.roleRootOf('workspace', '/w').root, wsRoot)
		assert.equal(mod.roleRootOf('user', '/w').root, mod.userRolesRoot())
		assert.equal(mod.roleRootOf('nope', '/w'), null, '作用域不认 ⇒ null')
		// **顺序**：造三个根，看 `rosterRoots` 的次序（工作区在前、包内在最后）
		const base = mkdtempSync(join(tmpdir(), 'team-ops-order-'))
		const ws = join(base, 'ws')
		mkdirSync(join(ws, '.dsh', 'team-ops', 'roles'), { recursive: true })
		const order = mod.rosterRoots([], { workspace: ws }).map((entry) => entry.source)
		// 存在的根才列（用户根可能还没建）—— 判据是**次序**，不是"三份都在"
		assert.ok(order.includes('workspace') && order.includes('package'), '工作区与包内都要在：' + JSON.stringify(order))
		assert.ok(order.indexOf('workspace') < order.indexOf('package'), '工作区在包内之前：' + JSON.stringify(order))
		if (order.includes('user')) {
			assert.ok(order.indexOf('workspace') < order.indexOf('user'), '工作区在用户之前：' + JSON.stringify(order))
			assert.ok(order.indexOf('user') < order.indexOf('package'), '用户在包内之前：' + JSON.stringify(order))
		}
	})

	test('`scope` 收到数组 ⇒ **明确拒**并指路 `boundaries`（不按形状认：一个参数不许两个意思）', async () => {
		const env = defineEnv()
		try {
			// 旧写法（`scope` = 职责边界）现在只有一个下场：**拒**，并告诉他该用哪个参数。
			const refused = await call(env.host, 'role_define', { ...goodRole, scope: ['不写别人的角色'] }, env.exec)
			assert.equal(refused.ok, false, '数组不许被静默当成职责边界：' + JSON.stringify(refused).slice(0, 200))
			assert.match(refused.error, /`scope` 现在指\*\*写到哪里\*\*/, refused.error)
			assert.match(refused.error, /`boundaries`/, '要指路到正确的参数：' + refused.error)
			assert.ok(!existsSync(env.workspaceRoleFile('probe-role')), '拒了就一个文件都不许落')
			// **`boundaries` 照旧**（数组 + 四段必备之一）：同一次调用换成新名就过
			const ok = await call(env.host, 'role_define', { ...goodRole, scope: 'workspace', boundaries: ['不写别人的角色', '不派活'] }, env.exec)
			assert.equal(ok.ok, true, JSON.stringify(ok).slice(0, 200))
			assert.match(readFileSync(env.workspaceRoleFile('probe-role'), 'utf8'), /^## 边界（明确不做什么）$/m)
			// 错误里不许再出现"旧写法照收"那类含糊话
			assert.ok(!/照收|仍可用|兼容/.test(String(ok.summary)), '回执里不许再提旧写法：' + String(ok.summary).slice(0, 200))
		} finally {
			env.restore()
		}
	})

	test('技能名写错 ⇒ 当场拒，逐个点名 + 列出可选，且**不落文件**', async () => {
		const env = defineEnv()
		try {
			const receipt = await call(env.host, 'role_define', { ...goodRole, skills: ['perf-baselin', 'ui-styling'] }, env.exec)
			assert.equal(receipt.ok, false, '写错的技能名不许放行')
			assert.match(receipt.error, /不在本机技能目录里：perf-baselin/)
			assert.match(receipt.error, /perf-baseline/, '要列出可选的名字')
			assert.ok(!existsSync(env.roleFile('probe-role')), '被拒时一个文件都不该落')
		} finally {
			env.restore()
		}
	})

	test('缺 checklist（四段缺一）⇒ 当场拒并点名缺的那一段', async () => {
		const env = defineEnv()
		try {
			const { checklist, ...withoutChecklist } = goodRole
			const receipt = await call(env.host, 'role_define', withoutChecklist, env.exec)
			assert.equal(receipt.ok, false, '四段缺一不许放行')
			assert.match(receipt.error, /checklist（检查表，逐条可核）/)
			assert.ok(!existsSync(env.roleFile('probe-role')))
		} finally {
			env.restore()
		}
	})

	test('重名不写 mode ⇒ 当场拒并说清改的是哪一份；带 mode=update 才覆盖，且留 .bak', async () => {
		const env = defineEnv()
		try {
			const first = await call(env.host, 'role_define', goodRole, env.exec)
			assert.equal(first.ok, true, JSON.stringify(first))
			const refused = await call(env.host, 'role_define', { ...goodRole, positioning: '换一句定位。' }, env.exec)
			assert.equal(refused.ok, false, '重名不写 mode 不许静默覆盖')
			assert.match(refused.error, /已经在本工作区的角色根里/, '要说清是哪一个根里已经有了：' + refused.error)
			assert.match(refused.error, /mode: update/)
			assert.match(refused.error, /本工作区的角色根|用户角色根|包内/, '要点明改的是哪一份：' + refused.error)
			const updated = await call(env.host, 'role_define', { ...goodRole, positioning: '换一句定位。', mode: 'update' }, env.exec)
			assert.equal(updated.ok, true, JSON.stringify(updated))
			// 缺省作用域 = 工作区（HD-008）：覆盖与 `.bak` 都在**工作区那个根**里
			assert.match(readFileSync(env.workspaceRoleFile('probe-role'), 'utf8'), /换一句定位。/)
			assert.match(readFileSync(join(env.workspace, '.dsh', 'team-ops', 'roles', 'probe-role', 'ROLE.md.bak'), 'utf8'), /对探针的准与全负责。/, '覆盖前要留 .bak')
			// **显式 `scope: 'user'` 才落用户根**（隔离 home ⇒ 不碰用户真目录），且两个作用域互不覆盖
			const globalOne = await call(env.host, 'role_define', { ...goodRole, scope: 'user', positioning: '全局那一份。' }, env.exec)
			assert.equal(globalOne.ok, true, JSON.stringify(globalOne))
			assert.equal(globalOne.scope, 'user')
			assert.match(String(globalOne.scopeLine), /所有工作区都看得见/, '回执要写清跨工作区可见：' + String(globalOne.scopeLine))
			assert.ok(existsSync(env.roleFile('probe-role')), '显式 user ⇒ 落用户根：' + env.roleFile('probe-role'))
			assert.match(readFileSync(env.workspaceRoleFile('probe-role'), 'utf8'), /换一句定位。/, '工作区那份仍在（互不覆盖）')
			// **同名时工作区那份赢**（枚举顺序：工作区 → 用户 → 包内）
			assert.match(readFileSync(env.workspaceRoleFile('probe-role'), 'utf8'), /换一句定位。/)
			const seen = (await import('../team/team-runtime.js')).roleRecordsFor(env.workspace).find((record) => record.id === 'probe-role')
			assert.equal(seen?.source, 'workspace', '同 id 时工作区那份赢：' + JSON.stringify(seen?.source))
		} finally {
			env.restore()
		}
	})

	test('落点越界（角色根里那一级是指向别处的软链）⇒ 拒，且不写根外那一边', async () => {
		const env = defineEnv()
		try {
			const outside = mkdtempSync(join(tmpdir(), 'team-ops-outside-'))
			// 缺省落点是**工作区角色根**（HD-008）⇒ 软链那一级要做在那个根里
			mkdirSync(join(env.workspace, '.dsh', 'team-ops', 'roles'), { recursive: true })
			symlinkSync(outside, join(env.workspace, '.dsh', 'team-ops', 'roles', 'probe-role'), 'dir')
			const receipt = await call(env.host, 'role_define', goodRole, env.exec)
			assert.equal(receipt.ok, false, '真实路径越出角色根 ⇒ 不许写')
			assert.match(receipt.error, /越界/)
			assert.ok(!existsSync(join(outside, 'ROLE.md')), '根外那一边一个文件都不该落')
		} finally {
			env.restore()
		}
	})

	test('成员身份调 ⇒ 可读拒绝（协调者专属，与角色清单同一道门）', async () => {
		const env = defineEnv()
		try {
			const asMember = { agent: makeAgent(env.workspace, 'child-1', { parentSession: env.lead.id }), signal: env.exec.signal }
			const receipt = await call(env.host, 'role_define', goodRole, asMember)
			assert.equal(receipt.ok, false)
			assert.match(receipt.error, /是\*\*团队成员\*\*，不是协调者/)
			assert.ok(!existsSync(env.roleFile('probe-role')))
		} finally {
			env.restore()
		}
	})

	test('坏 id 当场拒（大写 / 下划线 / 前导连字符 / 太长），且**一根目录都不建**', async () => {
		const env = defineEnv()
		try {
			// 断言的措辞是**工具这一层**组装的那一句（`角色 id 不合法：…`）—— 只判"被拒"会假绿：
			// 写入层也会拒形状不合法的 id，抽掉这里那道守卫照样绿（复核就是抽掉守卫验出来的）。
			const bad = [
				['Probe-Role', /角色 id 不合法：角色 id 必须是小写 kebab-case/],
				['probe_role', /角色 id 不合法：角色 id 必须是小写 kebab-case/],
				['-probe', /角色 id 不合法：角色 id 必须是小写 kebab-case/],
				['a'.repeat(70), /角色 id 不合法：角色 id 太长（70 字符，上限 60）/],
			]
			for (const [id, pattern] of bad) {
				const receipt = await call(env.host, 'role_define', { ...goodRole, id }, env.exec)
				assert.equal(receipt.ok, false, `坏 id "${id}" 不许放行`)
				assert.match(receipt.error, pattern)
				assert.ok(!existsSync(join(env.home, 'team-ops', 'roles', id)), `坏 id "${id}" 不该建目录`)
			}
			// 边界另一侧：恰好 60 个字符的形状合法 id 放行（上限是 60，不是 59）
			const okId = 'a'.repeat(60)
			assert.equal((await call(env.host, 'role_define', { ...goodRole, id: okId }, env.exec)).ok, true)
			// 根目录在**第一次成功写入之后**才存在（坏 id 那四条都没碰盘）
			assert.ok(existsSync(join(env.workspace, '.dsh', 'team-ops', 'roles', okId, 'ROLE.md')), '合法 id 落工作区根')
		} finally {
			env.restore()
		}
	})
})

describe('对话建技能：skill_define', () => {
	const goodSkill = { name: 'probe-skill', description: 'Use when 需要一次探针作业程序时。', body: '# 探针\n\n1. 做这一步。\n' }

	test('建得出来；回执照实说这一份现在在不在技能目录里', async () => {
		const env = defineEnv()
		try {
			// **缺省 scope = workspace**（HD-008）：落本工作区的技能根，**不碰**用户根。
			const receipt = await call(env.host, 'skill_define', goodSkill, env.exec)
			assert.equal(receipt.ok, true, JSON.stringify(receipt))
			assert.equal(receipt.scope, 'workspace', '缺省作用域是 workspace：' + JSON.stringify(receipt.scope))
			assert.equal(receipt.kind, 'project')
			assert.ok(receipt.root.includes(join('.dsh', 'skills')), '落点是工作区的技能根：' + String(receipt.root))
			assert.ok(!existsSync(env.skillFile('probe-skill')), '缺省**不许**写用户根（跨工作区可见的那一份）')
			assert.match(String(receipt.scopeLine), /只有这个工作区看得见/, '回执要逐字说清可见范围：' + String(receipt.scopeLine))
			const text = readFileSync(env.workspaceSkillFile('probe-skill'), 'utf8')
			assert.match(text, /^name: probe-skill$/m)
			assert.match(text, /^description: Use when 需要一次探针作业程序时。$/m)
			assert.match(text, /# 探针/)
			// 假注册表里没有这份新技能 ⇒ 如实说**这一次没读到**，并说清它按变更即时刷新（不是"要重启才出现"）
			assert.equal(receipt.inCatalog, false)
			assert.match(receipt.summary, /这一次没读到/)
			assert.match(receipt.summary, /读的那一刻/)
			assert.match(receipt.summary, /按变更即时刷新/)
			assert.match(receipt.summary, /下一次提示词就会带上它/)
			assert.equal(env.catalog.calls.length, 1, '回读走的还是同一处读法')
		} finally {
			env.restore()
		}
	})

	test('description 为空 ⇒ 当场拒（空描述等于建了个没人会用的技能）', async () => {
		const env = defineEnv()
		try {
			const receipt = await call(env.host, 'skill_define', { ...goodSkill, description: ' ' }, env.exec)
			assert.equal(receipt.ok, false)
			assert.match(receipt.error, /description 必填/)
			assert.ok(!existsSync(env.skillFile('probe-skill')), '被拒时不落文件')
		} finally {
			env.restore()
		}
	})

	test('body 为空 ⇒ 当场拒；重名不写 mode ⇒ 拒；带 mode=update 覆盖并留 .bak', async () => {
		const env = defineEnv()
		try {
			const empty = await call(env.host, 'skill_define', { ...goodSkill, body: '\n' }, env.exec)
			assert.equal(empty.ok, false)
			assert.match(empty.error, /body 必填/)
			assert.equal((await call(env.host, 'skill_define', goodSkill, env.exec)).ok, true)
			const refused = await call(env.host, 'skill_define', { ...goodSkill, body: '# 改过\n' }, env.exec)
			assert.equal(refused.ok, false)
			assert.match(refused.error, /mode: update/)
			const updated = await call(env.host, 'skill_define', { ...goodSkill, body: '# 改过\n', mode: 'update' }, env.exec)
			assert.equal(updated.ok, true, JSON.stringify(updated))
			// 缺省作用域 = 工作区（HD-008）：覆盖与 `.bak` 都发生在**工作区那个根**里
			assert.match(readFileSync(env.workspaceSkillFile('probe-skill'), 'utf8'), /# 改过/)
			assert.match(readFileSync(join(env.workspace, '.dsh', 'skills', 'probe-skill', 'SKILL.md.bak'), 'utf8'), /# 探针/, '覆盖前要留 .bak')
			// **显式 `scope: 'user'` 才落全局**（隔离 home ⇒ 不碰用户真目录）：那是另一份，与工作区那份互不覆盖
			const globalOne = await call(env.host, 'skill_define', { ...goodSkill, scope: 'user', description: 'Use when 跨项目复用。' }, env.exec)
			assert.equal(globalOne.ok, true, JSON.stringify(globalOne))
			assert.equal(globalOne.scope, 'user')
			assert.match(String(globalOne.scopeLine), /所有工作区都看得见/, '回执要写清跨工作区可见：' + String(globalOne.scopeLine))
			assert.ok(existsSync(env.skillFile('probe-skill')), '显式 user ⇒ 落用户根：' + env.skillFile('probe-skill'))
			// 两个作用域**互不覆盖**：各自一份都在
			assert.match(readFileSync(env.workspaceSkillFile('probe-skill'), 'utf8'), /# 改过/)
			assert.match(readFileSync(env.skillFile('probe-skill'), 'utf8'), /# 探针/)
		} finally {
			env.restore()
		}
	})

	test('技能注册表读不到 ⇒ 如实说读不到，不冒充"一个技能都没有"，也不放行写角色', async () => {
		const env = defineEnv()
		try {
			const baseGet = env.host.ctx.get.bind(env.host.ctx)
			env.host.ctx.get = (name) => (name === 'skills' ? undefined : baseGet(name))
			const receipt = await call(env.host, 'role_define', goodRole, env.exec)
			assert.equal(receipt.ok, false)
			assert.match(receipt.error, /读不到 ≠ 一个技能都没有/)
			assert.ok(!existsSync(env.roleFile('probe-role')))
		} finally {
			env.restore()
		}
	})

	test('两个工具的边界都写进描述：工作区外的用户根、不派活不改看板、不动别人的东西', () => {
		const env = defineEnv()
		try {
			const roleDesc = env.host.registered.get('role_define').description
			const skillDesc = env.host.registered.get('skill_define').description
			// **角色两个作用域**（task-34/task-36）：边界声明要写清缺省是**本工作区**、显式 user 才全局
			assert.match(roleDesc, /缺省写本工作区的角色根/)
			assert.match(roleDesc, /显式 `scope: "user"` 才写全局用户根/)
			assert.match(roleDesc, /所有工作区可见/)
			assert.ok(!/工作区之外\*\*的用户级角色根/.test(roleDesc), '那句"只写工作区之外的用户级角色根"已经写反了，要清干净：' + roleDesc.slice(0, 120))
			// **技能两个作用域**（HD-008）：描述里要写清缺省是工作区、显式 user 才全局
			assert.match(skillDesc, /缺省写本工作区的技能根/)
			assert.match(skillDesc, /显式 `scope: "user"` 才写全局用户根/)
			assert.match(skillDesc, /所有工作区可见/)
			for (const desc of [roleDesc, skillDesc]) {
				assert.match(desc, /不派活、不改看板、不改别人的角色或技能/)
				assert.match(desc, /不写工作区里的任何文件|工作区里只写/)
				assert.match(desc, /只有协调者能调/)
			}
			// 工具清单里也要有它们（策略段）
			const policy = runtime.teamPolicyText(runtime.roleCatalog(), runtime.defaultRosterOf())
			assert.match(policy, /role_define/)
			assert.match(policy, /skill_define/)
		} finally {
			env.restore()
		}
	})

	test('成员身份调 ⇒ 可读拒绝（与 role_define 同一道门；**权限门必须有断言**）', async () => {
		const env = defineEnv()
		try {
			const asMember = { agent: makeAgent(env.workspace, 'child-1', { parentSession: env.lead.id }), signal: env.exec.signal }
			const receipt = await call(env.host, 'skill_define', goodSkill, asMember)
			assert.equal(receipt.ok, false, '成员身份不许调 skill_define')
			assert.match(receipt.error, /是\*\*团队成员\*\*，不是协调者/)
			assert.match(receipt.error, /skill_define/)
			assert.ok(!existsSync(env.skillFile('probe-skill')), '被门挡下时一根文件都不该落')
		} finally {
			env.restore()
		}
	})
})

// ── 派活时的技能核对（只警告不拦：那一刻从前没人覆盖） ─────────────────────────

describe('派活时的技能核对（只警告不拦）', () => {
	/** 沙盒用户根里手写一份带 `skills:` 的角色（模拟包内那 19 份）。 */
	function writeRoleWithSkills(env, id, skills) {
		const dir = join(env.home, 'team-ops', 'roles', id)
		mkdirSync(dir, { recursive: true })
		writeFileSync(
			join(dir, 'ROLE.md'),
			[
				'---',
				'kind: role',
				`name: ${id}`,
				'version: 0.1.0',
				'category: 质量',
				'description: Use when 探针。',
				`skills: ${skills.join(', ')}`,
				'---',
				'',
				`# 探针（${id}）`,
				'',
				'对探针负责。',
				'',
			].join('\n'),
		)
	}

	test('声明的技能里本机目录没有的 ⇒ 逐条点名（含读到哪一层），这次派活照常', async () => {
		const env = defineEnv()
		try {
			writeRoleWithSkills(env, 'ghost-role', ['ghost-skill', 'perf-baseline'])
			const receipt = await call(env.host, 'member_spawn', { role: 'ghost-role', prompt: '到场。' }, env.exec)
			assert.equal(receipt.ok, true, JSON.stringify(receipt))
			const warning = (receipt.warnings ?? []).join('\n')
			assert.match(warning, /本机技能目录里没有：ghost-skill/, '不在目录里的技能名要点名：' + warning)
			assert.ok(!/本机技能目录里没有：[^\n]*perf-baseline/.test(warning), '在目录里的不该被点名：' + warning)
			// 读到哪一层由 `lib/skill-scope.js` 的退法定（假宿主里取不到活 Agent ⇒ global）：断言"要点名读到的那一层"，不写死层名
			assert.match(warning, /读到的是 (session|root-agent|global) 层/, '要说清是哪一层的目录里没有')
			assert.match(receipt.voice ?? '', /原生队友|没有新建/, '警告不拦：人照样派出去')
		} finally {
			env.restore()
		}
	})

	test('技能注册表取不到 ⇒ 如实说"没能替你核对"，不假装核过', async () => {
		const env = defineEnv()
		try {
			writeRoleWithSkills(env, 'ghost-role', ['ghost-skill'])
			const baseGet = env.host.ctx.get.bind(env.host.ctx)
			env.host.ctx.get = (name) => (name === 'skills' ? undefined : baseGet(name))
			const receipt = await call(env.host, 'member_spawn', { role: 'ghost-role', prompt: '到场。' }, env.exec)
			assert.equal(receipt.ok, true, JSON.stringify(receipt))
			const warning = (receipt.warnings ?? []).join('\n')
			assert.match(warning, /没能替你核对/)
			assert.match(warning, /读不到 ≠ 一个都没有/)
		} finally {
			env.restore()
		}
	})

	test('声明的技能全都在目录里 ⇒ 一句警告都不出（不拿噪音当核对）', async () => {
		const env = defineEnv()
		try {
			writeRoleWithSkills(env, 'ok-role', ['perf-baseline'])
			const receipt = await call(env.host, 'member_spawn', { role: 'ok-role', prompt: '到场。' }, env.exec)
			assert.equal(receipt.ok, true, JSON.stringify(receipt))
			assert.equal(receipt.warnings, undefined, '核过且都对 ⇒ 不回警告：' + JSON.stringify(receipt.warnings))
		} finally {
			env.restore()
		}
	})
})

// ── 生效面的话不许说过头（现场验收打回的那两句：按句核，不按关键词核） ──────────

describe('生效面：技能即时刷新、角色工具面即时可用（只有注入清单要重启）', () => {
	/** 把回执里所有字符串摊平（含嵌套对象与数组）。 */
	function stringsOf(value) {
		const out = []
		const walk = (item) => {
			if (typeof item === 'string') out.push(item)
			else if (Array.isArray(item)) item.forEach(walk)
			else if (item !== null && typeof item === 'object') Object.values(item).forEach(walk)
		}
		walk(value)
		return out
	}
	/** 按**句**切（`。；｜换行`）：判据是"这一句有没有说清范围"，不是"文里有没有某个词"。 */
	const sentencesOf = (text) => String(text).split(/[。；｜\n]/).map((line) => line.trim()).filter((line) => line !== '')
	const mentionsRestart = (line) => /重启|开新会话/.test(line)
	/** 说了范围才算合格：即时刷新 / 下一次提示词 / 装载时的快照 / 不影响 / 才更新（那一条只影响提示词）。 */
	const SCOPED = /(即时刷新|下一次提示词|装载时的快照|装载时快照|不影响|不需要重启|才更新)/
	/** 笼统话：把"能不能用"挂在重启上。 */
	const BLANKET = /(必须重启|重启才能用|重启才认|才会出现|才进目录|才能用|要重启 DSH 才认|重启才生效)/

	test('技能侧：说"按变更即时刷新 + 下一次提示词就带上它"，不说"要重启才会出现"', async () => {
		const env = defineEnv()
		try {
			const receipt = await call(env.host, 'skill_define', { name: 'probe-skill', description: 'Use when 探针。', body: '# 探针\n' }, env.exec)
			assert.equal(receipt.ok, true, JSON.stringify(receipt))
			const text = stringsOf(receipt).join('\n')
			assert.match(text, /按变更即时刷新/, '要把即时刷新这件事实说出来')
			assert.match(text, /下一次提示词就会带上它/)
			assert.ok(!/重启 DSH \/ 开新会话/.test(text), '旧那句"要重启 DSH / 开新会话才出现"要清干净')
			// 回读那一句也不许把"读的那一刻"说成"这份技能没生效"
			assert.match(text, /读的那一刻/)
			assert.ok(!/现在还不?在目录里[^。；]*重启/.test(text), '回读与重启不许挂在一句里')
		} finally {
			env.restore()
		}
	})

	test('角色侧：一句"立刻可用"、一句"注入清单是装载时快照"，字段名不叫 restartRequired', async () => {
		const env = defineEnv()
		try {
			const receipt = await call(env.host, 'role_define', {
				id: 'probe-role', positioning: '对探针负责。', when: '探针时。',
				boundaries: ['不派活'], checklist: ['落文件'], deliverables: ['docs/probe.md'],
			}, env.exec)
			assert.equal(receipt.ok, true, JSON.stringify(receipt))
			const text = stringsOf(receipt).join('\n')
			assert.match(text, /立刻可用/)
			assert.match(text, /装载时的快照|装载时快照/)
			assert.match(text, /不影响/)
			assert.ok(!/会话工具面要\*\*重启|才认这个角色/.test(text), '旧那句"会话工具面要重启才认"要清干净')
		} finally {
			env.restore()
		}
	})

	test('两个工具的描述：凡提重启/开新会话的**那一句**都必须说清范围（按句核）', () => {
		const env = defineEnv()
		try {
			const descriptions = ['role_define', 'skill_define'].map((name) => env.host.registered.get(name).description)
			for (const description of descriptions) {
				const restartSentences = sentencesOf(description).filter(mentionsRestart)
				assert.ok(restartSentences.length >= 1, '要说清"哪一部分要重启"，不能一句不说')
				for (const line of restartSentences) {
					assert.ok(SCOPED.test(line), `提到重启的那一句必须同时说清范围（不许笼统）：${line}`)
					assert.ok(!BLANKET.test(line), `不许把"能不能用"挂在重启上：${line}`)
				}
			}
			// 技能描述里必须有"即时刷新"那句事实
			const skillDesc = env.host.registered.get('skill_define').description
			assert.match(skillDesc, /按变更即时刷新/)
			assert.match(skillDesc, /不需要重启/)
			// 角色描述里必须有"立刻可用"与"装载时的快照"两句事实
			const roleDesc = env.host.registered.get('role_define').description
			assert.match(roleDesc, /工具面立刻可用/)
			assert.match(roleDesc, /装载时的快照/)
		} finally {
			env.restore()
		}
	})
})

// ── 说准话收尾：名册只增不减（为什么 + 怎么办）与残留的"要重启才能用" ──────────

describe('名册只增不减：策略段与 member_spawn 都要说清"为什么"和"怎么办"', () => {
	/** 按句切（`。；｜换行`）：判"这一句说了什么"，不判"全篇出现过这个词"。 */
	const sentencesOf = (text) => String(text).split(/[。；｜\n]/).map((line) => line.trim()).filter((line) => line !== '')
	/** 两句事实：① 名册只增不减（并给出为什么：宿主没有移除接口）；② 要一份干净的名册就开新会话。 */
	function assertNoRemovalSaid(label, text) {
		const sentences = sentencesOf(text)
		const growth = sentences.filter((line) => line.includes('只增不减'))
		assert.ok(growth.length >= 1, `${label} 要有"名册只增不减"那一句`)
		assert.ok(
			growth.some((line) => /没有移除.*接口|移除成员.*接口|宿主.*没有移除/.test(line)),
			`${label} 的"只增不减"要给出**为什么**（宿主没有移除成员的接口）：${growth.join(' / ')}`,
		)
		const clean = sentences.filter((line) => line.includes('开新会话'))
		assert.ok(clean.length >= 1, `${label} 要有"要一份干净的名册就开新会话"那一句`)
		assert.ok(clean.some((line) => /干净的名册/.test(line)), `${label} 的"开新会话"要挂在那句可照做的话上：${clean.join(' / ')}`)
	}

	test('策略段（注入给每个会话的那段）：编制那一行两句都在', () => {
		const policy = runtime.teamPolicyText(runtime.roleCatalog(), runtime.defaultRosterOf())
		assertNoRemovalSaid('策略段', policy)
	})

	test('member_spawn 的描述：建之前就想清楚（建出来收不回去）', () => {
		const env = defineEnv()
		try {
			const description = env.host.registered.get('member_spawn').description
			assertNoRemovalSaid('member_spawn 的描述', description)
			assert.match(description, /建出来就收不回去/, '要有一句直白的提醒')
		} finally {
			env.restore()
		}
	})

	test('成员面另外两处同一口径的话也一起改准（member_defaults / member_list）', () => {
		const env = defineEnv()
		try {
			for (const name of ['member_defaults', 'member_list']) {
				const description = env.host.registered.get(name).description
				assert.match(description, /只增不减/, `${name} 的描述要跟上同一口径`)
				assert.ok(!/没有"归档 \/ 退役"两态/.test(description), `${name} 里那句旧话要清干净`)
			}
		} finally {
			env.restore()
		}
	})
})

describe('残留的"要重启才能用"：面板与 CLI 那几处一起改准', () => {
	const read = (path) => readFileSync(path, 'utf8')

	test('面板「添加角色」的提示：工具面立刻可用 + 只有注入清单要重启', () => {
		const source = read('lib/board-view.client.js')
		assert.ok(!/重启 DSH 后\*\*会话工具/.test(source), '旧那句"重启 DSH 后会话工具才会认它"要清干净')
		const toast = source.split('\n').find((line) => line.includes('已添加角色'))
		assert.ok(toast !== undefined, '要找到"添加角色"那条提示')
		assert.match(toast, /工具面立刻可用/)
		assert.match(toast, /只有注入到系统提示里那份「可叫的队友」清单是装载时的快照/)
		assert.match(toast, /不影响/, '要说清那一条不影响能不能叫人')
	})

	test('CLI（npm run role:new）的下一步提示：不用重启就能用', () => {
		const source = read('tests/roster.mjs')
		assert.ok(!/③ 重启 DSH/.test(source), '旧的"③ 重启 DSH"要清干净')
		assert.match(source, /不用重启就能用/)
		assert.match(source, /「可叫的队友」清单是装载时的快照/)
	})

	test('宿主端点那句注释：`customizeRole` 写的是用户**角色**根，别再说成技能', () => {
		const source = read('lib/board-view.host.js')
		// 角色加了作用域（task-34）：那句注释现在要写清"缺省本工作区、显式 user 才是用户级角色根"，落点仍是 `roles/<id>/ROLE.md`
		assert.match(source, /roles\/<id>\/ROLE\.md/, '要写明落点是 ROLE.md')
		assert.match(source, /缺省[^\n]*<工作区>\/\.dsh\/team-ops\/roles/, '要写明缺省落点（本工作区）')
		assert.match(source, /用户级角色根/, '也要写明显式 user 那一档')
		assert.ok(!/要重启 DSH 才能加载这个新技能/.test(source), '旧那句（把角色说成技能、把工具面挂到重启上）要清干净')
		assert.match(source, /工具面立刻可用/)
	})
})

// ── 收尾三件：一段正文只许一份、字段名不许把"能不能用"挂在重启上 ──────────────

describe('一段正文只许一份：手抄的第二份就算没做到', () => {
	test('「名册只增不减」那段正文在源码里只出现一次，四个使用点逐字引用它', async () => {
		const { NO_REMOVAL_NOTE } = await import('../team/team-runtime.js')
		const source = readFileSync('team/team-runtime.js', 'utf8')
		// 记号计数：每次手抄一份，这些记号就多一次（复核抓到的就是 `member_list` 那处手抄）
		for (const marker of ['不用的队友不再派活即可', '要一份干净的名册就开新会话', '没有移除成员的接口', 'TeamId = SessionId']) {
			assert.equal(source.split(marker).length - 1, 1, `「${marker}」只许在常量里出现一次 —— 再多一次就是手抄的第二份正文`)
		}
		const env = defineEnv()
		try {
			const policy = runtime.teamPolicyText(runtime.roleCatalog(), runtime.defaultRosterOf())
			const surfaces = [
				['策略段（编制那一行）', policy],
				['member_spawn 的描述', env.host.registered.get('member_spawn').description],
				['member_defaults 的描述', env.host.registered.get('member_defaults').description],
				['member_list 的描述', env.host.registered.get('member_list').description],
			]
			for (const [label, text] of surfaces) {
				assert.ok(text.includes(NO_REMOVAL_NOTE), `${label} 要**逐字**带上那段正文（引用常量，不许手抄改字）`)
			}
			// 「怎么叫一个人」那句是**指针**：说清去哪儿看，而不是把正文再抄一遍
			const pointer = policy.split('\n').find((line) => line.includes('怎么叫一个人'))
			assert.ok(pointer !== undefined && pointer.includes('原生名册只增不减'), '指针要给出"只增不减"这个提示')
			assert.ok(!pointer.includes(NO_REMOVAL_NOTE), '指针不许把正文再抄一遍')
		} finally {
			env.restore()
		}
	})
})

describe('字段名不许把"能不能用"挂在重启上：restartRequired 已收成 promptRoster / promptRosterNote', () => {
	test('引擎、客户端、宿主三处都不再返回/引用 restartRequired: true', () => {
		for (const file of ['team/team-runtime.js', 'lib/board-view.client.js', 'lib/board-view.host.js']) {
			const source = readFileSync(file, 'utf8')
			assert.ok(!/restartRequired:\s*true/.test(source), `${file} 不许再返回 restartRequired: true`)
			assert.ok(!/payload\.restartRequired/.test(source), `${file} 不许再读 restartRequired（改名要两边一起改）`)
		}
		const engine = readFileSync('team/team-runtime.js', 'utf8')
		assert.match(engine, /function roleWriteEffects\(\)/, '生效面读数要有一处正文')
		assert.equal(engine.split("promptRoster: 'stale'").length - 1, 1, '`promptRoster: \'stale\'` 只许出现在 roleWriteEffects 里')
	})

	test('三条面板写动作与 role_define 回执都带上这对字段（两段话都说全）', async () => {
		const env = defineEnv()
		try {
			const receipt = await call(env.host, 'role_define', {
				id: 'probe-role', positioning: '对探针负责。', when: '探针时。',
				boundaries: ['不派活'], checklist: ['落文件'], deliverables: ['docs/probe.md'],
			}, env.exec)
			assert.equal(receipt.promptRoster, 'stale')
			assert.match(receipt.promptRosterNote, /立刻可用/)
			assert.match(receipt.promptRosterNote, /装载时的快照/)
			assert.match(receipt.promptRosterNote, /不影响/)
			// 面板文字那两段仍在（客户端里给人读的那句话）
			const client = readFileSync('lib/board-view.client.js', 'utf8')
			assert.match(client, /工具面立刻可用/)
			assert.match(client, /只有注入到系统提示里那份「可叫的队友」清单是装载时的快照/)
		} finally {
			env.restore()
		}
	})
})

describe('验证记录里不许留过时清单（下一个人会照着它再跑一遍）', () => {
	// 验证记录是内部文档，不进公开仓库 —— 公开副本里没有这份，这条就无从判起，如实跳过。
	const VERIFY_DOC = 'docs/team/verify/对话建角色与技能.md'
	test('§七 说的是"已在同一批收干净"并给出复扫口径，不再是"同类残留，本轮没动"', {
		skip: existsSync(VERIFY_DOC) ? false : `${VERIFY_DOC} 不在本副本里（内部文档，不进公开仓库）`,
	}, () => {
		const doc = readFileSync(VERIFY_DOC, 'utf8')
		assert.ok(!/\*\*不在本轮写盘面\*\*/.test(doc), '过时那句「不在本轮写盘面，本轮一个字没动」要清掉')
		assert.match(doc, /已在同一批收干净/, '要写明那几处已经收掉了')
		assert.match(doc, /复扫口径/, '要给出可复跑的扫描口径，而不是一份会过期的清单')
		assert.match(doc, /NO_REMOVAL_NOTE/, '要点名那段正文的落点（一段正文只许一份）')
	})
})

// ── 角色 id 的长度上限在写入层（三个入口一起受管，判定只有一处） ──────────────

describe('角色 id 的长度上限上收到写入层：三个建角色入口一起受管', () => {
	const tooLong = 'a'.repeat(70) // 形状合法、超长（上限 60）
	/** 这两个入口只用到 `ctx.get('sandboxPolicy')`（策略服务缺席时按后端默认裁定）。 */
	const makeCtx = () => ({ fs: makeFs(), get: () => undefined, logger: { warn() {} } })

	test('写入层那一处判定：形状 + 长度都在 `roleIdFindings`', async () => {
		const { roleIdFindings, ROLE_ID_MAX } = await import('../lib/roster.js')
		assert.equal(ROLE_ID_MAX, 60, '上限 60（原生队友名上限 64，留出序号那几位）')
		assert.deepEqual(roleIdFindings('a'.repeat(60)), [], '边界内放行')
		assert.deepEqual(roleIdFindings('content-ops'), [], '正常 id 放行')
		const findings = roleIdFindings(tooLong)
		assert.equal(findings.length, 1)
		assert.match(findings[0], /角色 id 太长（70 字符，上限 60）/)
		assert.match(findings[0], /原生上限 64 字符/, '要给出为什么是 60')
		assert.equal(roleIdFindings('Probe_Role').length, 1, '形状仍然判')
		// 「判定只有一处」由下面两条**够硬**的判据管（复核证过：原来的字面扫描只钉得住"照抄写法" ——
		// 换个写法（`id.length > 60`）或换个字符类（`[a-z\d]`）它就抓不到了）：
		// · 「行为判据」：每个入口拒绝坏 id 时，理由必须是写入层 `roleIdFindings` 的那句原文；
		// · 「结构化扫描」：全部引擎与 lib 文件里，"像 id 判定"的写法与白名单逐条对得上。
	})

	test('入口一 · 工具（role_define）：当场拒 + 不落目录', async () => {
		const env = defineEnv()
		try {
			const receipt = await call(env.host, 'role_define', { ...goodRole, id: tooLong }, env.exec)
			assert.equal(receipt.ok, false, '超长 id 不许放行')
			assert.match(receipt.error, /角色 id 太长（70 字符，上限 60）/)
			assert.ok(!existsSync(join(env.home, 'team-ops', 'roles', tooLong)), '不许落目录')
		} finally {
			env.restore()
		}
	})

	test('入口二 · 面板（createRoleInWorkspace）：当场拒 + 不落目录', async () => {
		const root = mkdtempSync(join(tmpdir(), 'team-ops-longid-'))
		const previous = process.env.DSH_TEAM_OPS_ROLES
		process.env.DSH_TEAM_OPS_ROLES = root
		try {
			const { createRoleInWorkspace } = await import('../lib/gate-write.js')
			const workspace = mkdtempSync(join(tmpdir(), 'team-ops-longid-ws-'))
			assert.throws(
				() => createRoleInWorkspace(makeCtx(), workspace, { id: tooLong, positioning: '对探针负责。' }),
				(error) => /角色 id 太长（70 字符，上限 60）/.test(error.message),
				'面板这条路也要当场拒',
			)
			assert.ok(!existsSync(join(root, tooLong)), '不许落目录')
		} finally {
			if (previous === undefined) delete process.env.DSH_TEAM_OPS_ROLES
			else process.env.DSH_TEAM_OPS_ROLES = previous
		}
	})

	test('入口三 · CLI（writeRoleScaffold，`npm run role:new` 那条路）：拒且不落目录', async () => {
		const root = mkdtempSync(join(tmpdir(), 'team-ops-longid-cli-'))
		try {
			const { writeRoleScaffold } = await import('../lib/roster.js')
			const written = writeRoleScaffold(tooLong, { root, title: '太长' })
			assert.equal(written.ok, false, '超长 id 不许生成骨架')
			assert.match(written.reason, /角色 id 太长（70 字符，上限 60）/)
			assert.ok(!existsSync(join(root, tooLong)), '不许落目录')
			// 边界另一侧：60 字符整好放行（上限是 60，不是 59）
			assert.equal(writeRoleScaffold('a'.repeat(60), { root, title: '边界' }).ok, true)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('「复制为自定义」也走同一处判定（复制出来的 id 同样不许超长）', async () => {
		const root = mkdtempSync(join(tmpdir(), 'team-ops-longid-custom-'))
		const previous = process.env.DSH_TEAM_OPS_ROLES
		process.env.DSH_TEAM_OPS_ROLES = root
		try {
			const { customizeRole } = await import('../team/team-runtime.js')
			assert.throws(
				() => customizeRole(makeCtx(), { workspace: mkdtempSync(join(tmpdir(), 'ws-')) }, { role: 'architect', id: tooLong }),
				(error) => /角色 id 太长（70 字符，上限 60）/.test(error.message),
			)
			assert.ok(!existsSync(join(root, tooLong)), '不许落目录')
		} finally {
			if (previous === undefined) delete process.env.DSH_TEAM_OPS_ROLES
			else process.env.DSH_TEAM_OPS_ROLES = previous
		}
	})
})

// ── 判定只有一处（够硬的判据：行为 + 结构化扫描） ──────────────────────────────

/**
 * 扫"像 id 判定"的两类写法。
 *
 * **先剥注释再扫**（复核提的"过宽"：注释里提一句 `ROLE_ID_MAX` 不该红），再按写法归一化：
 * · **正则** —— 锚定（`^`）且只含小写字母、数字与连字符的那类（角色 id / 技能名这种编号族的形状判定）；
 * 归一化把 `[a-z0-9]` / `[0-9a-z]` / `[a-z\d]` 收敛成同一个形状（类内字符排序 + `\d` → `0-9`），
 * 于是"换个字符类写法"的等价注入也躲不过去；
 * · **长度** —— `<id 类变量>.length` 与数字或常量比大小（`id.length > 60` / `value.length > ROLE_ID_MAX`）。
 * @param source - 文件全文。
 * @returns 逐条发现（同一写法出现两次就返回两条 —— **重复**本身就是"第二份判定"）。
 */
function idJudgmentFindings(source) {
	const stripped = String(source)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
	const normalize = (text) =>
		text
			.replace(/\s+/g, '')
			.replace(/\\d/g, '0-9')
			.replace(/\[([^\]]*)\]/g, (whole, body) => '[' + [...new Set(body.split(''))].sort().join('') + ']')
	const out = []
	const RE_LITERAL = /\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/g
	for (const match of stripped.matchAll(RE_LITERAL)) {
		const literal = match[0]
		const looksLikeIdShape = literal.startsWith('/^') && !/[A-Z]/.test(literal) && /\[a-z/.test(literal) && /(0-9|\\d)/.test(literal) && literal.includes('-')
		if (looksLikeIdShape) out.push(`正则 ${normalize(literal)}`)
	}
	for (const match of stripped.matchAll(/([A-Za-z_$][\w$]*)\.length\s*(>=?|<=?)\s*(\d+|[A-Z][A-Z0-9_]*)/g)) {
		if (/(?:^|[^a-z])(?:id|name|value)$/i.test(match[1])) out.push(`长度 ${normalize(match[0])}`)
	}
	return out
}

describe('判定只有一处（够硬的版本）：行为判据 + 结构化扫描', () => {
	/** 面板口与复制为自定义只用到 `ctx.get('sandboxPolicy')`（服务缺席时按后端默认裁定）。 */
	const makeCtx = () => ({ fs: makeFs(), get: () => undefined, logger: { warn() {} } })
	test('行为判据：每个入口拒绝坏 id 时，理由必须是写入层 `roleIdFindings` 的那句原文', async () => {
		const { roleIdFindings, writeRoleScaffold } = await import('../lib/roster.js')
		const shapeBad = 'Probe_Role'
		const lengthBad = 'a'.repeat(70)
		const env = defineEnv()
		try {
			// ① 工具口：形状 + 长度两种坏 id
			for (const bad of [shapeBad, lengthBad]) {
				const expected = roleIdFindings(bad).join('；')
				const receipt = await call(env.host, 'role_define', { ...goodRole, id: bad }, env.exec)
				assert.equal(receipt.ok, false)
				assert.ok(
					receipt.error.includes(expected),
					`工具口的拒绝理由里必须有写入层那句原文（有第二个判据在说话就露馅）：\n期望含：${expected}\n实际：${receipt.error}`,
				)
			}
			// ② 面板口
			{
				const expected = roleIdFindings(lengthBad).join('；')
				const { createRoleInWorkspace } = await import('../lib/gate-write.js')
				assert.throws(
					() => createRoleInWorkspace(makeCtx(), env.workspace, { id: lengthBad, positioning: '对探针负责。' }),
					(error) => error.message.includes(expected),
					`面板口的拒绝理由里必须有写入层那句原文：期望含 ${expected}`,
				)
			}
			// ③ CLI 口
			{
				const root = mkdtempSync(join(tmpdir(), 'team-ops-single-'))
				const expected = roleIdFindings(lengthBad).join('；')
				const written = writeRoleScaffold(lengthBad, { root, title: '太长的' })
				assert.equal(written.ok, false)
				assert.ok(written.reason.includes(expected), `CLI 口的拒绝理由里必须有写入层那句原文：期望含 ${expected}，实际 ${written.reason}`)
				rmSync(root, { recursive: true, force: true })
			}
			// ④ 复制为自定义
			{
				const root = mkdtempSync(join(tmpdir(), 'team-ops-single-custom-'))
				const previous = process.env.DSH_TEAM_OPS_ROLES
				process.env.DSH_TEAM_OPS_ROLES = root
				try {
					const { customizeRole } = await import('../team/team-runtime.js')
					const expected = roleIdFindings(lengthBad).join('；')
					assert.throws(
						() => customizeRole(makeCtx(), { workspace: env.workspace }, { role: 'architect', id: lengthBad }),
						(error) => error.message.includes(expected),
						`复制为自定义的拒绝理由里必须有写入层那句原文：期望含 ${expected}`,
					)
				} finally {
					if (previous === undefined) delete process.env.DSH_TEAM_OPS_ROLES
					else process.env.DSH_TEAM_OPS_ROLES = previous
					rmSync(root, { recursive: true, force: true })
				}
			}
		} finally {
			env.restore()
		}
	})

	test('结构化扫描：全部引擎与 lib 文件里，"像 id 判定"的写法与白名单逐条对得上', () => {
		const files = [
			...readdirSync('team').filter((name) => name.endsWith('.js')).map((name) => `team/${name}`),
			...readdirSync('lib').filter((name) => name.endsWith('.js')).map((name) => `lib/${name}`),
		]
		const found = []
		for (const file of files) for (const finding of idJudgmentFindings(readFileSync(file, 'utf8'))) found.push(`${file} ${finding}`)
		// 白名单（**归一化后**的写法；同一写法出现两次会得到两条 ⇒ 重复也算第二份判定）：
		// · 角色 id 的形状 + 长度：`lib/roster.js` 的 `roleIdFindings`（唯一正文）
		// · 技能名的形状 + 长度：`lib/skill-write.js`（**另一个编号族**，不是角色 id）
		const WHITELIST = [
			'lib/roster.js 正则 /^[-az][-09az]*(-[-09az]+)*$/',
			'lib/skill-write.js 正则 /^[-az][-09az]*(-[-09az]+)*$/',
			'lib/roster.js 长度 value.length>ROLE_ID_MAX',
			'lib/skill-write.js 长度 value.length>SKILL_ID_MAX',
		]
		assert.deepEqual(
			[...found].sort(),
			[...WHITELIST].sort(),
			'像 id 判定的写法与白名单对不上：多出来的那些就是第二份判定（换个写法 / 换个字符类都算）',
		)
	})

	test('注释里提到 `ROLE_ID_MAX` 不许红（先剥注释再扫）', () => {
		const sample = '// 这里提一句 ROLE_ID_MAX 与 [a-z0-9]，只是注释\nconst value = 1\n/* 块注释里也提 ROLE_ID_MAX */\n'
		assert.deepEqual(idJudgmentFindings(sample), [], '注释不许被当成判定')
	})
})

// ── "你"指谁：策略段（全局，成员也读到）与成员段各自说清 ──────────────────────

describe('称呼自明：三方对照 + 成员消解规则（宿主段没有作用域，只能靠文本）', () => {
	/** 按句切（`。；｜换行`）：判"这一句说了什么"，不判"全篇出现过某个词"。 */
	const sentencesOf = (text) => String(text).split(/[。；｜\n]/).map((line) => line.trim()).filter((line) => line !== '')
	const triangleOf = (sentences) => sentences.filter((line) => line.includes('**人**') && line.includes('**你**') && /成员/.test(line))

	test('策略段：一句三方对照 + 一句成员消解规则 + 只给协调器的句子有标记 + 不再用「用户」称呼第三方', () => {
		const policy = runtime.teamPolicyText(runtime.roleCatalog(), runtime.defaultRosterOf())
		const sentences = sentencesOf(policy)
		// ① 三方对照：一句里把 人 / 你（协调器）/ 成员 钉死
		const triangle = triangleOf(sentences)
		assert.ok(triangle.length >= 1, '要有一句（同一句里）同时钉死 人 / 你 / 成员：' + sentences.slice(0, 6).join('\n'))
		assert.ok(triangle.some((line) => line.includes('协调器')), '要写明"你 = 协调器"：' + triangle.join('\n'))
		// ② 成员消解规则：被派活的成员把"你"读作自己的协调器
		const rule = sentences.filter((line) => line.includes('成员消解规则'))
		assert.equal(rule.length, 1, '要有且只有一句成员消解规则')
		assert.ok(/被派活的成员/.test(rule[0]), '消解规则要指名"被派活的成员"这一种读者')
		assert.ok(/读作/.test(rule[0]) && /协调器/.test(rule[0]) && /lead/.test(rule[0]), '要说清"你"读作谁：' + rule[0])
		// ③ 「用户」不再当第三方称呼：**只放行领域复合词**（用户故事 / 用户根 这类），其余一律叫「人」
		const asThirdParty = policy.replace(/用户级角色根|用户角色根|用户根|用户故事|用户反馈|用户引导|用户体验/g, '')
		assert.ok(!asThirdParty.includes('用户'), '第三方一律叫「人」，不该再有「用户」：' + (asThirdParty.match(/.{0,12}用户.{0,12}/) ?? [''])[0])
		// ④ 只给协调器的那句要有标记（成员读到也知道该跳过）
		const opener = sentences.find((line) => line.includes('装完打开就能开工'))
		assert.ok(opener !== undefined, '要有"装完打开就能开工"那一句')
		assert.ok(/只对协调器|只有协调器/.test(opener), '只给协调器的句子必须自带标记：' + opener)
	})

	test('基线里第三方也一律叫「人」：同一个第三方不许有第二个名字（放行 `用户级角色根` / `用户根` 这类路径名）', () => {
		const baseline = baselineCorpusOf()
		const asThirdParty = baseline.replace(/用户级角色根|用户角色根|用户根/g, '')
		assert.ok(!asThirdParty.includes('用户'), '第三方一律叫「人」，不该再有「用户」：' + (asThirdParty.match(/.{0,14}用户.{0,14}/) ?? [''])[0])
		assert.ok(baseline.includes('改变行为或人可见结果'), '开不开工那条规则要写「人可见结果」')
		assert.ok(baseline.includes('人看到的东西会变'), '判断句式那句要写「人看到的东西」')
		assert.ok(!/用户可见|用户看到/.test(baseline), '旧写法不许回来')
	})

	test('成员身份段：成员视角的三方对照 + 「lead = 你的协调者」+ 点明策略段哪些是写给 lead 的', async () => {
		const { roleBrief } = await import('../team/native-layer.js')
		const brief = roleBrief({ role: 'reviewer', name: 'reviewer-1', title: '评审员', duty: '对产物内部质量负责。', roleFile: 'team/roles/reviewer/ROLE.md', baselineFile: 'team/BASELINE.md', skills: [] })
		const sentences = sentencesOf(brief)
		const triangle = sentences.filter((line) => line.includes('**人**') && line.includes('**lead**') && line.includes('**你**'))
		assert.ok(triangle.length >= 1, '成员段要有一句（同一句里）钉死 人 / lead / 你：' + sentences.slice(0, 4).join('\n'))
		assert.ok(/lead\*\*\s*=\s*\*\*你的协调者|lead.*你的协调者/.test(triangle[0]), '要写明"lead = 你的协调者"：' + triangle[0])
		assert.ok(triangle.some((line) => /写给\s*lead\s*的|写给 lead 的/.test(line)), '要点明策略段里那些句子是写给 lead 的：' + triangle.join('\n'))
		assert.ok(/评审员/.test(triangle[0]) && /reviewer-1/.test(triangle[0]), '要把"你"钉到具体角色与成员名上')
	})
})

// ── 跨会话续接：工作区级交接快照（派生物，不是第二本账） ──────────────────────

describe('策略段：四条纪律（规模 / 提问形状 / 复盘确认 / 边界）都在，且各是一块可抽掉的正文', () => {
	/** 按句切：判"这一句说了什么"，不判"全篇出现过某个词"。 */
	const sentencesOf = (text) => String(text).split(/[。；｜\n]/).map((line) => line.trim()).filter((line) => line !== '')
	const policyOf = () => runtime.teamPolicyText(runtime.roleCatalog(), runtime.defaultRosterOf())

	test('四块关键句按句核（每块都在同一段里说清）', () => {
		const policy = policyOf()
		const sentences = sentencesOf(policy)
		const want = (needle, what) => assert.ok(sentences.some((line) => line.includes(needle)), `${what}：${needle}`)
		// ① 规模判定：三档 + 升级
		want('规模判定', '要有"规模判定"这一块')
		want('小任务', '① 小任务')
		want('小改动', '② 小改动（自然语言说清做什么、改哪里）')
		want('先出设计文档，人批准后才动手', '③ 需要书面设计')
		want('规模在一单中途变大 ⇒ 立刻停下、报人、按新档位重走', '规模中途变大要停下、报人、按新档位重走（与基线同一句）')
		// ② 提问形状
		want('提问形状', '要有"提问形状"这一块')
		want('一条消息只留一个问题', '一问一条')
		want('句尾一个问句', '句尾一个问句')
		want('不附示例清单', '不附示例清单')
		want('不用流程黑话', '用对方的词、不用流程黑话')
		want('问题 + 依据 + 备选 + 一句话推荐', '决策包四件')
		// ③ 复盘确认
		want('复盘确认', '要有"复盘确认"这一块')
		want('能写成 200–300 字的程度', '篇幅口径与基线一致（不是 ≤ 与区间连用）')
		want('「人确认」', '标「人确认」')
		want('「我方推测」', '标「我方推测」')
		want('哪里错了、漏了什么', '结尾要问这一句')
		want('只有标「人确认」的才许当成已定的前提', '只有人确认才算前提')
		// ④ 边界（HD-009）
		want('HD-009', '要引 HD-009')
		want('控件**类型**', '边界那三类里的"控件**类型**"（HD-009 那个例子恰恰是类型：成员页按钮 vs 其余下拉）')
		want('参数含义（含改名与**改**默认值）', '参数含义含"改名"与"改默认值"')
		want('要改先问协调器', '要改先问协调器')
		want('只许报告、不许自己动手', '顺手核一遍同类只许报告')
	})

	test('复核点名的三处"判定条件"：每处都有一条可当场核的判据 + 断言（task-52 ⑥）', () => {
		const baseline = baselineCorpusOf()
		// 复核原话：这三处在测试里 **0 命中** ⇒ 逐条补断言（按句核）。
		const checks = [
			['§四 4b：双合规的判定条件', '拿同一份产物，按两处**各自**的判定条件各判一次'],
			['§四 4b：结论不一致就是双合规', '**结论不一致**（一处放过、一处退回）'],
			['§四 4b：必须开工对齐', '就是"双合规" ⇒ 按本条**必须开工对齐**'],
			['§二 4b：停用腾哪一条', '停用腾的是角色槽位、腾不了在场总人数'],
			['§五 4：§五.4 只管代码那一档', '**本条只管"代码那一档"**'],
			['§八之一：覆盖所有给人看的文档形态交付物', '**所有"给人看的文档形态交付物"**'],
			['§五 5：规格状态仅第③档适用', '**仅第③档适用**'],
			['§十 5：AGENTS.md 点名覆盖的除外', '**已被 `AGENTS.md` 点名覆盖的部分除外**'],
		]
		for (const [what, phrase] of checks) {
			assert.ok(baseline.includes(phrase), `缺了这条判定条件：${what} —— ${phrase}`)
		}
	})

	test('BASELINE 2.2.2 的 11 条裁决：每条的"裁决措辞"逐条在（抽掉哪条、哪条红）', () => {
		const baseline = baselineCorpusOf()
		// 每条一行：`[条号 + 名字, 该条的裁决措辞（抽掉它这条就该红）]`
		const rulings = [
			['① 审查状态不进交付物', '**审查状态不进交付物正文**'],
			['① 审查状态记在哪（外部记录）', '看板条目 / `docs/team/tasks/T-<序号>.md` / 复核记录'],
			['① 判定条件（前十行出现即不合格）', '出现**审查状态**（`未审` / `已复核`）⇒ **不合格**'],
			['② 角色槽位（停用腾它）', '**角色槽位** = 同一角色里**未停用**且非 `failed` 的人数，上限 **3** ⇒ **停用腾的是它**'],
			['② 在场总人数（停用腾不了）', '**在场总人数** = **名册行数**（**含 `failed`、含停用者**），上限 **24** ⇒ **停用腾不了它**'],
			['② 原生名册行（谁也腾不了）', '**原生名册行** = **只增不减**'],
			['② 停旧建新只对角色槽位有用', '**"停旧建新"只在角色槽位满时有用**'],
			['③ 提问两类', '**提问分两类，形状不同**'],
			['③ 审批清单口径', '**逐项编号**、**每项一个待确认句**、**每项给推荐**'],
			['④ 多文件只是信号', '**「多个文件」只是信号，不单独触发 ③**'],
			['④ ③档四条触发条件', '**跨角色** / **跨轮**（一次做不完、要分几段） /'],
			['⑤ 层级三档', '**工作区 `AGENTS.md` > 本基线 > 角色 `ROLE.md`**'],
			['⑤ 默认宪法 + 点名覆盖', '**默认宪法**'],
			['⑤ 判定条件（点名条号）', '`覆盖本基线` 字样并点名条号'],
			['⑥ 三个角色根', '包内 `<包>/team/roles/<id>/ROLE.md`'],
			// ⑥ 在 BASELINE 里**两处**都要有（§一之一 与 §二 4c0 各一份完整写法）⇒ 断言出现次数 ≥2
			['⑥ 枚举顺序（两处都写）', '**枚举顺序：工作区根 > 用户根 > 包内**'],
			['⑦ 提问一律由协调器发出', '**向人提问一律由协调器发出**'],
			['⑦ 成员只提交问题包正文', '**只提交"问题包 / 决策包正文"**'],
			['⑧ line_reason 越不过宿主', '**只能越过插件的软上限（角色槽位 3 位），越不过宿主的硬上限（在场总人数 24）**'],
			['⑨ 24 是独立硬上限', '24 是**独立硬上限**'],
			['⑨ 3×8 只是历史来源', '「3 位 × 8 角色」只是**历史来源**'],
			['⑩ 打回 = 开新任务', '**打回 = 开一条新任务并关联原任务号**'],
			['⑩ 原任务保持已完成', '**原任务保持已完成**'],
			['⑩ 视图标签不是原生态', '**"复核中 / 已打回"是我们这一层的视图标签**'],
			['⑪ 审批号定义', '**审批号 = 「人的话」里那一条 `HD-<三位序号>`**'],
			['⑪ 谁生成 / 格式 / 记在哪', '**协调器**（人答复后**当场**记录，再按答复执行）'],
			['⑪ 没号怎么办', '**人答了但没记 ⇒ 当场记录再执行**'],
		]
		for (const [what, phrase] of rulings) {
			assert.ok(baseline.includes(phrase), `BASELINE 2.2.2 缺了这条裁决措辞：${what} —— ${phrase}`)
		}
		// ⑥ 那一条是**两处**（§一之一 与 §二 4c0）：只留一处也算缺 ⇒ 单独核次数
		const orderPhrase = '**枚举顺序：工作区根 > 用户根 > 包内**'
		const orderCount = baseline.split(orderPhrase).length - 1
		assert.ok(orderCount >= 2, `「枚举顺序」那份完整写法在 BASELINE 里要出现**两处**（§一之一 + §二 4c0），实际 ${orderCount} 处`)
	})

	test('**两处一致性**：这些关键短语 BASELINE 与策略段**都含**（以后谁只改一边就红）', () => {
		// 复核对出来的 4 处口径不一致，修完之后钉住 —— 一处正文改、另一处忘改，这条当场红。
		const baseline = baselineCorpusOf()
		const policy = policyOf()
		// **肯定式 + 完整短语**（复核的硬发现：只写子串"控件"、或用否定式，都会被"控件形状"这种变异骗过）
		const both = [
			['③档触发条件（并集）', '**跨角色** / **跨轮**'],
			['③档-多文件只是信号', '「多个文件」只是信号，不单独触发'],
			['层级三档', '> 本基线 > 角色'],
			['名册-角色槽位', '角色槽位'],
			['名册-在场总人数', '在场总人数'],
			['名册-原生名册行', '原生名册行'],
			['名册-line_reason 越不过宿主', '越不过宿主的硬上限'],
			['提问-一律由协调器发出', '向人提问一律由协调器发出'],
			['提问-审批清单', '逐项编号'],
			['返工-开新任务关联原任务号', '开一条新任务并关联原任务号'],
			['审批号-HD 定义', 'HD-<三位序号>'],
			['路径-枚举顺序', '枚举顺序：工作区根 > 用户根 > 包内'],
			['并发写-机制三层', '原子写 + 按文件串行'],
			['并发写-版本守卫', 'FS_STALE_VERSION'],
			['并发写-重读再试', '重读 → 把改动重建在新内容上 → 再试'],
			['并发写-串行派活', '串行派活'],
			['③档实质-被批准的规格', '被批准的规格'],
			['③档实质-按它直接做', '按它直接做'],
		]
		// **只在基线侧成立的完整短语**（两边措辞不同、但都要"肯定式钉住"的那些）
		const baselineOnly = [
			['边界三类（完整句）', '界面形状 / 控件类型 / 参数含义（含改名与改默认值）'],
			['层级三档（完整句）', '> 本基线 > 角色 `ROLE.md`'],
			['24 独立硬上限', '24 是**独立硬上限**'],
			['角色槽位定义（停用腾它）', '**停用腾的是它**'],
			['在场总人数定义（停用腾不了）', '**停用腾不了它**'],
			['停旧建新只对角色槽位有用', '**"停旧建新"只在角色槽位满时有用**'],
			['判定条件：停用腾角色槽位、腾不了在场总人数', '停用腾的是角色槽位、腾不了在场总人数'],
			['规格状态仅第③档适用', '**仅第③档适用**'],
			['§四 4b 的判定条件（双合规必须开工）', '就是"双合规" ⇒ 按本条**必须开工对齐**'],
			['§五.4 只管代码那一档', '**本条只管"代码那一档"**'],
			['§八之一 覆盖所有给人看的文档形态交付物', '**所有"给人看的文档形态交付物"**'],
			// **这条是那处"双合规"消掉的关键实例化**（task-53 复核抽出来的：删掉它 ⇒ 双合规回来）
			['§八之一 明确含 docs/team/**', '**包括 `docs/team/**` 下的判断类文档**'],
			// 两句"不许拿对方放过"（两边各一句，缺任一边都会让"归哪一套"重新变成两说）
			['§五.4 不许拿"不在三处"放过', '来放过 —— 那不是本条的判定面'],
			['§八之一 不许拿 §五.4 的清单放过', '来放过它 —— 那份清单只管**代码那一档**'],
			['§十.5 豁免（AGENTS.md 点名覆盖）', '**已被 `AGENTS.md` 点名覆盖的部分除外**'],
			['§八之二 的分工一句（扫描范围那半句）', '**人指出来的**那一类，**扫描范围**按本节'],
			['§八之二 的分工一句（开工判据那半句）', '要不要动代码 / 开条目**按 §四.4'],
			['§三.2 审批号（完整句）', '**审批号 = 「人的话」里那一条 `HD-<三位序号>`**'],
			['§四.1 打回（完整句）', '**打回 = 开一条新任务并关联原任务号**'],
		]
		// **只在策略段侧成立的**（含它自己那套行内加粗写法）
		const policyOnly = [
			['边界三类（策略段写法）', '控件**类型**'],
			['边界-改名与改默认值', '改名与**改**默认值'],
			['名册-line_reason（策略段写法）', '越不过宿主的硬上限（在场总人数 24）'],
			['层级三档（策略段写法）', '**工作区 `AGENTS.md` > 本基线 > 角色 `ROLE.md`**'],
		]
		for (const [what, phrase] of both) {
			assert.ok(baseline.includes(phrase), `BASELINE 少了这条口径：${what}（${phrase}）`)
			assert.ok(policy.includes(phrase), `策略段少了这条口径：${what}（${phrase}）`)
		}
		for (const [what, phrase] of baselineOnly) {
			assert.ok(baseline.includes(phrase), `BASELINE 少了这条肯定式口径：${what}（${phrase}）`)
		}
		for (const [what, phrase] of policyOnly) {
			assert.ok(policy.includes(phrase), `策略段少了这条肯定式口径：${what}（${phrase}）`)
		}
		// 「控件类型」这个词只在两处出现（不是"控件形状"）
		assert.ok(baseline.includes('控件**类型**') === false, '（基线用行内加粗外的写法：控件类型）')
		assert.ok(policy.includes('控件形状') === false, '策略段不许再写"控件形状"')
		assert.ok(policy.includes('多个文件') === false || policy.includes('只是信号'), '策略段不许把"多文件"当判据')
		assert.ok(policy.includes('≤200–300 字') === false, '策略段不许再用 `≤` 与区间连用那种写法')
	})

	test('既有条款一处不许丢：点名规矩 / 按需组建 / 协作纪律那几句都还在', () => {
		const policy = policyOf()
		for (const keep of [
			'**成员消解规则**',
			'**点名规矩（面板插进来的 `@角色名`）**',
			'**按需组建',
			'**协作纪律**',
			'写具体文件，别写目录',
			'**回报的第一行就是那条指针**',
			'对外输出按团队基线的默认层级走',
		]) {
			assert.ok(policy.includes(keep), '既有条款不许丢：' + keep)
		}
	})

	// **逐块抽掉 ⇒ 各自红**：每块用一句独有的话当"存在性判据"，抽掉那一块它就没了。
	test('逐块可抽掉（四块各有一条独有句，且四句互不相同）', () => {
		const policy = policyOf()
		const anchors = [
			['规模', '规模在一单中途变大 ⇒ 立刻停下、报人、按新档位重走'],
			['提问', '不附示例清单'],
			['复盘', '只有标「人确认」的才许当成已定的前提'],
			['边界', '要改先问协调器'],
		]
		const seen = new Set()
		for (const [what, anchor] of anchors) {
			assert.ok(policy.includes(anchor), `${what} 那一块的独有句要在：${anchor}`)
			assert.ok(!seen.has(anchor), `${what} 的独有句不许与别块共用：${anchor}`)
			seen.add(anchor)
		}
	})
})

describe('交接快照：原生看板按会话，新会话靠它接得上', () => {
	/** 快照文件名（引擎 `LEDGER_FILE.handoff`）。 */
	const HANDOFF = '.company-gate.handoff.json'
	/** 跑一次注入摘要（`--text` 的纯文本形态）。 */
	const runDigest = (workspace) => {
		const result = spawnSync(process.execPath, ['lib/ledger-digest.js', '--workspace', workspace, '--text'], { cwd: process.cwd(), encoding: 'utf8' })
		assert.equal(result.status, 0, `摘要进程始终退 0（实际 ${result.status}）：${result.stderr ?? ''}`)
		return result.stdout ?? ''
	}

	test('① 每次成功改动之后，工作区里出现并更新快照（时刻 / 会话 id / 三态清单 / 角色）', async () => {
		const env = install()
		try {
			// 先让原生名册里有这一档（快照要记"该叫哪些角色"）
			await call(env.host, 'member_spawn', { role: 'reviewer', prompt: '到场。' }, env.exec)
			const created = await call(env.host, 'board_task', { action: 'register', subject: '把交接快照写出来', write_scopes: ['lib/ledger-digest.js'] }, env.exec)
			assert.equal(created.ok, true, JSON.stringify(created))
			const file = join(env.workspace, HANDOFF)
			assert.ok(existsSync(file), '登记之后工作区里就该有快照：' + JSON.stringify(created))
			assert.equal(created.handoff?.file, file, '回执里要给出快照落点')
			const first = JSON.parse(readFileSync(file, 'utf8'))
			assert.match(first.note, /不是实时看板/, '快照文件自带"它不是实时看板"那句（人直接打开也读得懂）')
			assert.match(String(first.at), /^\d{4}-\d{2}-\d{2}T/, '要记时刻')
			assert.equal(first.sessionId, env.lead.id, '要记是哪个会话留下的')
			assert.deepEqual(first.tasks.map((task) => [task.id, task.status]), [[created.task.id, 'pending']], '三态清单：编号 + 状态')
			assert.ok(first.roles.includes('reviewer'), '要记这一档当时用过哪些角色：' + JSON.stringify(first.roles))
			// 认领 → 收口：每一次成功改动都刷新（上下文到极限是**突然**发生的，不能指望"收工前记得写"）
			const claimed = await call(env.host, 'board_task', { action: 'claim', id: created.task.id, expected_revision: created.task.revision }, env.exec)
			assert.equal(claimed.ok, true, JSON.stringify(claimed))
			const done = await call(env.host, 'board_task', { action: 'complete', id: created.task.id, expected_revision: claimed.task.revision }, env.exec)
			assert.equal(done.ok, true, JSON.stringify(done))
			const second = JSON.parse(readFileSync(file, 'utf8'))
			assert.equal(second.seq, first.seq + 2, '认领与收口各写了一次（快照是版本号递增的）')
			assert.equal(second.tasks[0].status, 'completed', '三态清单跟着原生那一格变')
		} finally {
			env.restore?.()
		}
	})

	test('①-b 每一个**改状态**的 action 都刷新快照（漏一个就变成误导人的旧账）', async () => {
		const env = install()
		try {
			await call(env.host, 'member_spawn', { role: 'reviewer', prompt: '到场。' }, env.exec)
			const file = join(env.workspace, HANDOFF)
			const seqOf = () => JSON.parse(readFileSync(file, 'utf8')).seq
			const created = await call(env.host, 'board_task', { action: 'register', subject: '原题', write_scopes: ['a.js'] }, env.exec)
			assert.equal(created.ok, true, JSON.stringify(created))
			let revision = created.task.revision
			const id = created.task.id
			// 每一次成功的改动都该让 `seq` +1（`query` / `get` 是只读，不在此列）
			const steps = [
				['claim', {}],
				['edit', { subject: '改过的题' }],
				['set_dependencies', { blocked_by_tasks: [] }],
				['release', {}],
				['reassign', { owner: 'reviewer-1' }],
				['claim', {}],
				['complete', {}],
				['reopen', {}],
				['delete', {}],
			]
			let expected = seqOf()
			for (const [action, extra] of steps) {
				const receipt = await call(env.host, 'board_task', { action, id, expected_revision: revision, ...extra }, env.exec)
				assert.equal(receipt.ok, true, `${action} 该成功：${JSON.stringify(receipt)}`)
				revision = receipt.task.revision
				expected += 1
				assert.equal(seqOf(), expected, `action=${action} 之后快照没刷新（seq 应到 ${expected}）`)
			}
			const last = JSON.parse(readFileSync(file, 'utf8'))
			assert.equal(last.tasks.find((task) => task.id === id)?.status, 'deleted', '最后一次是删除：快照里那一格要跟着变')
		} finally {
			env.restore?.()
		}
	})

	test('①-c `reassign` 之后 owner 那一格写的是**角色**，不是成员名', async () => {
		// 快照的**唯一用途**就是"新会话按角色重新叫人"：写了成员名，下个会话就映射不回角色
		// （名册还是按会话的，旧名字在新会话里根本不存在）。
		const env = install()
		try {
			await call(env.host, 'member_spawn', { role: 'reviewer', prompt: '到场。' }, env.exec)
			const created = await call(env.host, 'board_task', { action: 'register', subject: '改派试试' }, env.exec)
			assert.equal(created.ok, true, JSON.stringify(created))
			const assigned = await call(
				env.host,
				'board_task',
				{ action: 'reassign', id: created.task.id, expected_revision: created.task.revision, owner: 'reviewer-1' },
				env.exec,
			)
			assert.equal(assigned.ok, true, JSON.stringify(assigned))
			const snapshot = JSON.parse(readFileSync(join(env.workspace, HANDOFF), 'utf8'))
			const task = snapshot.tasks.find((item) => item.id === created.task.id)
			assert.equal(task?.owner, 'reviewer', 'owner 那一格要写**角色**，不是成员名：' + JSON.stringify(task))
			assert.notEqual(task?.owner, 'reviewer-1', '不许把成员名写进 owner')
		} finally {
			env.restore?.()
		}
	})

	test('①-e **改派按门铃**：真换了归属 ⇒ 投一条最小通知；没换 ⇒ 不发；投递失败 ⇒ 改派仍算成功并如实写（task-48）', async () => {
		// 现场教训：`reassign` 之后承接人不会动 —— 宿主是刻意这么定的（"Task readiness never starts an owner"，
		// 唯一唤醒路径是消息），而工具面允许了"改了派却没人动"这个几乎总是错的状态 ⇒ 按缺陷治。
		const env = install()
		try {
			await call(env.host, 'member_spawn', { role: 'reviewer', prompt: '到场。' }, env.exec)
			const created = await call(env.host, 'board_task', { action: 'register', subject: '改派通知试试' }, env.exec)
			assert.equal(created.ok, true, JSON.stringify(created))
			const beforeSends = env.native.calls.send.length
			// ① 改派给**新**成员 ⇒ 真发了一条
			const reassigned = await call(
				env.host,
				'board_task',
				{ action: 'reassign', id: created.task.id, expected_revision: created.task.revision, owner: 'reviewer-1' },
				env.exec,
			)
			assert.equal(reassigned.ok, true, JSON.stringify(reassigned))
			assert.equal(env.native.calls.send.length, beforeSends + 1, '**改派要给新 owner 投一条**')
			const notice = env.native.calls.send[beforeSends]
			assert.equal(notice.target, 'reviewer-1', '收件人是新 owner：' + JSON.stringify(notice))
			const body = JSON.stringify(notice.content)
			assert.ok(body.includes(created.task.id), '通知里要有任务号：' + body)
			assert.ok(body.includes('改派通知试试'), '通知里要有一句话主题：' + body)
			assert.ok(body.includes('complete'), '要写清"做完 complete 回报"：' + body)
			assert.deepEqual(reassigned.notified, { target: 'reviewer-1', ok: true, sent: true }, '回执要如实写"门铃按过"：' + JSON.stringify(reassigned.notified))
			// ② 再改派给**同一个人** ⇒ 无操作、不发
			const again = await call(
				env.host,
				'board_task',
				{ action: 'reassign', id: created.task.id, expected_revision: reassigned.task.revision, owner: 'reviewer-1' },
				env.exec,
			)
			assert.equal(again.ok, true, JSON.stringify(again))
			assert.equal(env.native.calls.send.length, beforeSends + 1, '归属没变 ⇒ 不许再发一条')
			assert.equal(again.notified.sent, false, '回执要说清"没发"：' + JSON.stringify(again.notified))
			assert.match(String(again.notifyNote), /归属没变/)
			// ③ 投递失败 ⇒ **改派仍成功**，回执如实写原因
			const env2 = install()
			try {
				await call(env2.host, 'member_spawn', { role: 'qa', prompt: '到场。' }, env2.exec)
				env2.native.service.sendMessage = async () => {
					throw new Error('门铃坏了')
				}
				const made = await call(env2.host, 'board_task', { action: 'register', subject: '投递失败试试' }, env2.exec)
				const fallback = await call(
					env2.host,
					'board_task',
					{ action: 'reassign', id: made.task.id, expected_revision: made.task.revision, owner: 'qa-1' },
					env2.exec,
				)
				assert.equal(fallback.ok, true, '投递失败不许让改派失败：' + JSON.stringify(fallback))
				assert.equal(fallback.notified.ok, false, '回执要如实写没发出去：' + JSON.stringify(fallback.notified))
				assert.match(String(fallback.notified.reason), /门铃坏了/)
				assert.match(String(fallback.notifyNote), /通知没发出去/)
			} finally {
				env2.restore?.()
			}
		} finally {
			env.restore?.()
		}
	})

	test('①-d 失败的那次改动**不许**刷快照（快照不声称没发生的事）', async () => {
		const env = install()
		try {
			const created = await call(env.host, 'board_task', { action: 'register', subject: '原题' }, env.exec)
			assert.equal(created.ok, true, JSON.stringify(created))
			const file = join(env.workspace, HANDOFF)
			const before = JSON.parse(readFileSync(file, 'utf8'))
			// 版本号给错 ⇒ 原生按 CAS 拒（这一改没落地）
			const refused = await call(
				env.host,
				'board_task',
				{ action: 'edit', id: created.task.id, expected_revision: created.task.revision + 99, subject: '不该落下去' },
				env.exec,
			)
			assert.equal(refused.ok, false, '版本对不上要被拒：' + JSON.stringify(refused))
			const after = JSON.parse(readFileSync(file, 'utf8'))
			assert.equal(after.seq, before.seq, '被拒的那次改动不许刷快照（seq 应停在 ' + before.seq + '）')
			assert.equal(after.at, before.at, '时刻也不该被刷新')
			assert.equal(after.tasks.find((item) => item.id === created.task.id)?.subject, '原题', '快照里不许出现没落地的标题')
		} finally {
			env.restore?.()
		}
	})

	test('④ 装载时建立首份快照（干净工作区也有一份），note 如实写"还没有看板活动"', async () => {
		const env = install()
		try {
			// 装载钩子确实挂上了（挂在 `agent/created` 上）
			try {
				const again = await import('../team/team-runtime.js')
				again.apply(env.host.ctx)
				console.error('DEBUG2 listeners after manual apply:', JSON.stringify([...env.host.listeners.keys()]))
			} catch (error) {
				console.error('DEBUG2 apply threw:', error?.message)
			}
			assert.equal((env.host.handlers.get('agent/created') ?? []).length, 1, '装载时要挂上交接快照的钩子')
			const file = join(env.workspace, HANDOFF)
			assert.ok(!existsSync(file), '装载前干净工作区里不该有它')
			env.host.emit('agent/created', { agent: env.lead })
			await flush()
			assert.ok(existsSync(file), '装载（会话主 agent 出现）之后就该有一份')
			const first = JSON.parse(readFileSync(file, 'utf8'))
			assert.deepEqual(first.tasks, [], '首份快照没有看板活动')
			assert.deepEqual(first.roles, [])
			assert.equal(first.sessionId, env.lead.id, '记下是哪个会话建立的')
			assert.match(first.note, /还没有看板活动/, 'note 要如实写"还没有看板活动"：' + first.note)
			assert.match(first.note, /不是实时看板/, '那句诚实标注也照旧在')
		} finally {
			env.restore?.()
		}
	})

	test('④-b **文件已存在 ⇒ 装载绝不动它**（抽掉"存在就不写"⇒ 这条红；这是本轮的重点）', async () => {
		const env = install()
		try {
			const file = join(env.workspace, HANDOFF)
			// 先放一份**有内容**的快照（模拟上个会话的交接：正是唯一有价值的那份）
			const before = {
				version: 2,
				seq: 7,
				note: '上一份交接（有内容）',
				at: '2026-10-12T00:00:00.000Z',
				sessionId: 'session-old-9',
				tasks: [{ id: 'task-9', subject: '上一份里的活', status: 'in_progress', owner: 'architect' }],
				roles: ['architect'],
				members: [],
			}
			writeFileSync(file, JSON.stringify(before, null, 2) + '\n')
			const original = readFileSync(file, 'utf8')
			const outcome = await gate.ensureHandoffSnapshot(env.host.ctx, { agent: env.lead })
			assert.equal(outcome.ok, true, JSON.stringify(outcome))
			assert.equal(outcome.created, false, '已存在就不该再建立一份')
			assert.equal(readFileSync(file, 'utf8'), original, '**装载不许动已存在的那份**（字节级一致）')
			assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).tasks, before.tasks, '上次的交接还在')
		} finally {
			env.restore?.()
		}
	})

	test('④-c 空快照的注入如实说"刚开、还没有看板活动"，不冒充成有交接', () => {
		const dir = mkdtempSync(join(tmpdir(), 'team-ops-handoff-empty-'))
		writeFileSync(
			join(dir, HANDOFF),
			JSON.stringify({ version: 1, seq: 0, note: '本工作区第一次跑团队会话，还没有看板活动', at: '2026-10-12T10:15:48.463Z', sessionId: 's-new', tasks: [], roles: [] }),
		)
		const text = runDigest(dir)
		assert.match(text, /还没有看板活动/, '要如实说还没有看板活动：' + text)
		assert.match(text, /本工作区\*\*刚开\*\*/, '要说清这是刚开的工作区')
		assert.ok(!/上个会话.*留下的\*\*交接快照\*\*/.test(text), '空快照不许冒充成"上个会话留下了交接"')
		assert.ok(!/进行中 \d+ 条/.test(text), '没有任务就不许编计数')
		assert.match(text, /不是实时看板/, '诚实标注照旧在')
		assert.match(text, /团队状态：在 DSH 原生 Agent Teams/, 'team_status 那行照旧')
	})

	test('README 里也写了这一小节（用户可见的新能力不许只活在代码里）', () => {
		const readme = readFileSync('README.md', 'utf8')
		assert.match(readme, /跨会话续接/, 'README 要有这一节')
		assert.match(readme, /\.company-gate\.handoff\.json/, '要点名那一份文件')
		assert.match(readme, /\*\*不是\*\*实时看板/, '要写清它是快照、不是实时看板')
		assert.match(readme, /成员不能跨会话接手/, '要写清成员不能跨会话接手')
		assert.match(readme, /重新叫/, '要给出重新叫人的动作')
	})

	test('② 只有快照的工作区：注入里出现"交接快照"那一行，且不许把它说成实时看板', () => {
		const dir = mkdtempSync(join(tmpdir(), 'team-ops-handoff-'))
		writeFileSync(
			join(dir, HANDOFF),
			JSON.stringify({
				version: 1,
				seq: 3,
				note: '这是**交接快照**，不是实时看板：…',
				at: '2026-10-12T09:00:00.000Z',
				sessionId: 'session-old-1',
				tasks: [
					{ id: 'task-1', subject: '把快照写出来', status: 'in_progress', owner: 'architect' },
					{ id: 'task-2', subject: '复核那一条', status: 'pending', owner: '' },
				],
				roles: ['architect', 'reviewer'],
			}),
		)
		const text = runDigest(dir)
		// **task-80 的 C 条**：派生读数（快照）**不得当状态** ⇒
		// ① **块首**就标"快照@时刻"+"**非实时**"（不塞在末尾注解里）；② **不印裸计数**（"进行中 N 条"会被读成实时板面）；
		// ③ 列的是"**当时未完成**的条目"。三条一起核，缺一条就红。
		assert.match(text, /\*\*快照@2026-10-12T09:00:00\.000Z\*\*/, '块首要有 快照@<时刻>：' + text)
		assert.match(text, /session-old-1/, '要点名是哪个会话留下的')
		assert.match(text, /\*\*非实时\*\*/, '块首要有「非实时」标记：' + text)
		assert.ok(!/进行中 \d+ 条/.test(text), '派生读数里不许出现裸计数（会被读成实时板面）：' + text)
		assert.ok(!/待办 \d+ 条/.test(text), '同上：待办计数也不许印：' + text)
		assert.match(text, /当时未完成/, '要写清列的是"当时未完成"的条目：' + text)
		assert.match(text, /架构|task-1/, '要能看见快照里的任务')
		// **实时读数那一行仍在**（快照替代不了它）：
		assert.match(text, /团队状态：在 DSH 原生 Agent Teams（按会话）—— 成员与任务用 `member_list` \/ `team_status` 读/, 'team_status 那一行不许被快照顶掉')
		// **不许把它说成实时看板**：
		assert.match(text, /不是实时看板/, '要自带"这是快照、不是实时看板"')
		assert.match(text, /实时读数以 `team_status` \/ `board_task query` 为准/, '要把实时读数指出去')
		// 硬边界：成员不能跨会话接手
		assert.match(text, /成员不能跨会话接手/, '要写清成员不能跨会话接手')
		assert.match(text, /member_spawn role=<id>` 重新叫/, '要给出重新叫人的动作')
	})

	test('边界跟着改准：`board_task` 现在**真的**在工作区里写那一份快照', () => {
		const env = install()
		try {
			const description = env.host.registered.get('board_task').description
			assert.match(description, /交接快照/, '边界要说清它会写快照：' + description.slice(-160))
			assert.match(description, /\.company-gate\.handoff\.json/, '要点名那一份文件')
			assert.ok(!description.includes('不写本工作区的任何文件'), '旧那句（加了快照之后不成立）要清干净')
		} finally {
			env.restore?.()
		}
	})

	test('③ 文件在但读不成 ⇒ 如实说读不到（读不到 ≠ 没有快照）', () => {
		const dir = mkdtempSync(join(tmpdir(), 'team-ops-handoff-bad-'))
		writeFileSync(join(dir, HANDOFF), '{ 这不是 JSON')
		const text = runDigest(dir)
		assert.match(text, /上个会话的交接快照/, '要有一行说这件事')
		assert.match(text, /读不到 ≠ 没有过快照/, '读不到不等于没快照')
		assert.doesNotMatch(text, /进行中 \d+ 条/, '读不到时不许编出计数')
	})
})
