#!/usr/bin/env node
/**
 * 视图栏五块的**离线渲染自检**（不装 React，用一段"穷人的 React"真装载、真渲染）。
 *
 * 为什么要有这一条：client bundle 是**随包发布的产物**，它坏了不会有构建报错 —— 症状只有两种，
 * 而且都很远：① 视图栏那一栏空白；② factory 抛错顺着 loader 把整个 web shell 拖垮
 * （“entries did not activate”）。所以这一条把浏览器半边真的拉起来跑一遍：
 *
 *   1. 用 `window.__ModuleLoader__.load` 的真入口形态装载 `lib/board-view.client.js`；
 *   2. 用一小段 React（只认 createElement / useState / useEffect / useRef / useMemo，按组件实例存 hook 槽位、
 *      state 变了就整棵树重渲染）把「团队状态」那一栏渲染出来；
 *   3. 喂进去的是**真端点回算的载荷** —— 成员那份的文件是临时工作区里的真文件，payload 由
 *      `handleMembers` 自己算；技能那份由 `handleSkills` 配一个同形的假注册表算。于是
 *      "宿主回的字段名"与"页面读的字段名"对不上这类错，会在这一条里当场现形；
 *   4. 再模拟交互：切块（成员 → 技能）、点分档、开「查看正文」浮窗、点「复制路径」、
 *      点成员卡上的开关（要发出那条 POST）。
 *
 * 它**不**替代浏览器里的观感核对（那一栏仍然要人眼看），它只保证"这一栏画得出来、
 * 画的是端点给的那些数、点下去真的发那一条请求"。
 */

// **测试与用户真实目录隔离**：这一行必须在读取引擎之前 —— 见 `tests/isolate.mjs`（它设临时 `DSH_HOME` /
// `DSH_TEAM_OPS_ROLES`）。隔离只做这一处，不靠每条用例各自记得设。
import { ISOLATION_PREFIX, resetIsolatedHome } from './isolate.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

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


// ── 穷人的 React ─────────────────────────────────────────────────────────────
//
// 只实现这一栏用到的那四个 hook，并且**按组件（函数引用）各存一份 hook 槽位** ——
// 于是「容器组件渲染子组件」这条路是真的走过去了（块切换才测得出来）。
// state 的写入把全局"脏"标起来，由 `settle` 再渲染一遍整棵树；最多 8 轮，防跑飞。

function createRenderer() {
	const stores = new Map()
	let current = null
	let dirty = false
	const storeOf = (type) => {
		let store = stores.get(type)
		if (store === undefined) {
			store = { hooks: [], index: 0 }
			stores.set(type, store)
		}
		return store
	}
	const React = {
		createElement(type, props, ...children) {
			return { type, props: props === null || props === undefined ? {} : props, children }
		},
		useState(initial) {
			const at = current.index++
			if (current.hooks[at] === undefined) current.hooks[at] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
			const slot = current.hooks[at]
			return [
				slot.value,
				(next) => {
					slot.value = typeof next === 'function' ? next(slot.value) : next
					dirty = true
				},
			]
		},
		/** `useMemo`：按依赖数组当 key 缓存（客户端那一席用它挑名册 id）。 */
		useMemo(fn, deps) {
			const at = current.index++
			const slot = current.hooks[at]
			const same = slot !== undefined && slot.kind === 'memo' && Array.isArray(deps) && Array.isArray(slot.deps) && deps.length === slot.deps.length && deps.every((value, index) => Object.is(value, slot.deps[index]))
			if (same) return slot.value
			const value = fn()
			current.hooks[at] = { kind: 'memo', value, deps: deps }
			return value
		},
		useEffect(fn, deps) {
			const at = current.index++
			const previous = current.hooks[at]
			const changed =
				previous === undefined ||
				previous.deps === undefined ||
				deps === undefined ||
				deps.length !== previous.deps.length ||
				deps.some((value, index) => value !== previous.deps[index])
			current.hooks[at] = { kind: 'effect', deps, pending: changed ? fn : null }
		},
		useRef(initial) {
			const at = current.index++
			if (current.hooks[at] === undefined) current.hooks[at] = { kind: 'ref', value: { current: initial } }
			return current.hooks[at].value
		},
	}
	/** 渲染一个节点：函数组件就地求值（走它自己的 hook 槽位），宿主元素只递归它的孩子。 */
	const renderNode = (node) => {
		if (Array.isArray(node)) return node.map(renderNode)
		if (node === null || node === undefined || typeof node !== 'object') return node
		if (typeof node.type === 'function') {
			const store = storeOf(node.type)
			const previous = current
			store.index = 0
			current = store
			let out = null
			try {
				out = node.type({ ...node.props, children: node.children.length > 0 ? node.children : undefined })
			} finally {
				current = previous
			}
			return renderNode(out)
		}
		return { type: node.type, props: node.props, children: node.children.map(renderNode) }
	}
	return {
		React,
		render(type, props) {
			return renderNode({ type, props, children: [] })
		},
		/** 跑本轮所有"依赖变了"的 effect（每个组件各跑一次，顺序按组件首次渲染的顺序）。 */
		flushEffects() {
			const pending = []
			for (const store of stores.values()) {
				for (const slot of store.hooks) {
					if (slot !== undefined && slot.kind === 'effect' && slot.pending !== null) {
						pending.push(slot.pending)
						slot.pending = null
					}
				}
			}
			for (const fn of pending) fn()
		},
		takeDirty() {
			const was = dirty
			dirty = false
			return was
		},
	}
}

// ── 装载 client bundle（走真入口：window.__ModuleLoader__.load）─────────────────

/**
 * 装载 client bundle。
 * @param services - `ctx.get(name)` 那张表。
 * @param seeds - **额外的种子**（缺省只有 `react`）：真宿主还喂 `react-dom`，
 *   选择框靠它 `createPortal` 到 `document.body`；测试要验那条路时从这里塞一个假的。
 */
function loadClient(services = {}, seeds = {}) {
	const renderer = createRenderer()
	const seats = []
	let exported = null
	const listeners = { window: {}, document: {} }
	const fakeWindow = {
		// 真浏览器里那两样：客户端那一席在打开选择框时会按窗口尺寸算位置（Node 里没有 window）。
		innerHeight: 800,
		innerWidth: 1200,
		// 面板靠 `focus` 重读（那枚「刷新」按钮已经删掉）⇒ 这里要把监听**记下来**，测试才能真的触发它。
		addEventListener(type, fn) {
			listeners.window[type] = fn
		},
		removeEventListener(type) {
			delete listeners.window[type]
		},
		__ModuleLoader__: {
			load(entry) {
				exported = entry.factory((name) => {
					if (name === 'react') return renderer.React
					if (Object.hasOwn(seeds, name)) return seeds[name]
					throw new Error('未注册的种子：' + name)
				})
			},
		},
	}
	new Function('window', readFileSync('lib/board-view.client.js', 'utf8'))(fakeWindow)
	assert.ok(exported !== null, 'client bundle 没走 window.__ModuleLoader__.load 注册工厂')
	const slots = {
		inject(name, callback) {
			callback()
			return () => {}
		},
		register(options, component) {
			seats.push({ options, component })
			return () => {}
		},
	}
	exported.apply({ slots, effect: () => {}, get: (name) => services[name], logger: { warn() {}, info() {} } })
	return { renderer, seats, slots, listeners }
}

/**
 * 假 `document`：**只为验键盘**（客户端那半在 Node 里本没有 `document`；浮窗的 keydown 监听挂在它上面）。
 * `press()` 直接把事件喂给当前那一个监听 —— 于是"← → 是不是真的换了分栏"这件事能被真正按出来验。
 */
function fakeKeyboard() {
	const handlers = {}
	const doc = {
		visibilityState: 'visible',
		// `visibilitychange` 也记下来（面板重新可见时重读一次，靠的就是它）。
		addEventListener(type, fn, capture) {
			if (type === 'keydown') handlers.keydown = fn
			if (type === 'pointerdown') handlers.pointerdown = fn
			if (type === 'focusout') handlers.focusout = fn
			if (type === 'visibilitychange') handlers.visibilitychange = fn
		},
		removeEventListener(type, fn, capture) {
			if (type === 'keydown' && handlers.keydown === fn) handlers.keydown = undefined
			if (type === 'pointerdown' && handlers.pointerdown === fn) handlers.pointerdown = undefined
			if (type === 'focusout' && handlers.focusout === fn) handlers.focusout = undefined
			if (type === 'visibilitychange' && handlers.visibilitychange === fn) handlers.visibilitychange = undefined
		},
		querySelector: () => null,
		createElement: () => ({ style: {}, appendChild() {}, removeChild() {}, select() {} }),
		body: { appendChild() {}, removeChild() {} },
	}
	return {
		doc,
		/** 直接喂一个事件（面板的"重新可见就重读"靠它）。 */
		fire(type) {
			assert.ok(handlers[type] !== undefined, type + ' 监听应在')
			handlers[type]()
		},
		press(key, extra) {
			assert.ok(handlers.keydown !== undefined, '浮窗开着时 keydown 监听应在（要按 ' + key + '）')
			handlers.keydown({ key, preventDefault() {}, stopPropagation() {}, ...extra })
		},
		/** 喂一次"点在别处"（选择框的失去焦点关闭就是听它）。 */
		outsideDown(target = { contains: () => false }) {
			assert.ok(handlers.pointerdown !== undefined, '选择框开着时 pointerdown 监听应在（要验"失去焦点就关"）')
			handlers.pointerdown({ target: target })
		},
		/** 喂一次焦点移出。 */
		focusOut(relatedTarget = null) {
			assert.ok(handlers.focusout !== undefined, '选择框开着时 focusout 监听应在')
			handlers.focusout({ relatedTarget: relatedTarget })
		},
		installed: () => handlers.keydown !== undefined,
	}
}

/** 渲染 + 跑 effect + 等异步 state 落地，直到没有新的脏标记。 */
async function settle(harness, type, props) {
	let tree = null
	for (let pass = 0; pass < 8; pass++) {
		harness.renderer.takeDirty()
		tree = harness.renderer.render(type, props)
		harness.renderer.flushEffects()
		// 让 fetch 的 promise 链（含 .then 里的 setState）跑完再判脏。
		await new Promise((resolve) => setTimeout(resolve, 0))
		if (!harness.renderer.takeDirty()) break
	}
	return tree
}

async function act(harness, type, props, run) {
	run()
	return settle(harness, type, props)
}

// ── 树上的取数小工具 ─────────────────────────────────────────────────────────

function nodes(tree) {
	const out = []
	const walk = (node) => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item)
			return
		}
		if (node === null || node === undefined || typeof node !== 'object') return
		out.push(node)
		walk(node.children)
	}
	walk(tree)
	return out
}

const classOf = (node) => (typeof node.props.className === 'string' ? node.props.className : '')
const hasClass = (node, name) => classOf(node).split(' ').includes(name)
const textsOf = (tree) => {
	const out = []
	const walk = (node) => {
		if (typeof node === 'string' || typeof node === 'number') {
			out.push('' + node)
			return
		}
		if (Array.isArray(node)) {
			for (const item of node) walk(item)
			return
		}
		if (node === null || node === undefined || typeof node !== 'object') return
		for (const child of node.children) walk(child)
	}
	walk(tree)
	return out
}
const textOf = (tree) => textsOf(tree).join(' ')
const buttonWith = (tree, label) => nodes(tree).find((node) => node.type === 'button' && textsOf(node.children).join('').includes(label))
const cardsOf = (tree, name) => nodes(tree).filter((node) => hasClass(node, name))

// ── 假宿主（只用到 ctx.fs 那几个方法）+ 一个同形的假技能注册表 ──────────────────

function makeFs() {
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
	}
}

/** 与 `ctx.skills` 同形的假注册表：清单两条（一条两面都开、一条两面都不开）+ 一条正文。 */
const SKILL_BODY = '# 代码复核\n\n一步一步来。'
function fakeRegistry(calls) {
	return {
		async snapshot(view) {
			calls.push({ kind: 'snapshot', view })
			return {
				skills: [
					{ name: 'code-review', description: '按检查表过一遍改动', whenToUse: '提交前', source: 'user-dsh', provider: 'filesystem', path: '/u/.dsh/skills/code-review/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
					{ name: 'hidden-one', description: '两个面都不开的技能', source: 'project-dsh', provider: 'filesystem', path: '/w/.dsh/skills/hidden-one/SKILL.md', invocation: { modelInvocable: false, userInvocable: false } },
				],
				complete: true,
			}
		},
		async get(name, view) {
			calls.push({ kind: 'get', name, view })
			if (name !== 'code-review') return undefined
			return { name, description: '按检查表过一遍改动', source: 'user-dsh', provider: 'filesystem', path: '/u/.dsh/skills/code-review/SKILL.md', invocation: { modelInvocable: true, userInvocable: true }, content: SKILL_BODY }
		},
	}
}

/**
 * 本会话的 agent 名册（假件）：与 `ctx.agentTeams.listMembers(agent)` 同形 —— 协调者一行 + 一个队友。
 * 队友那一行的 `id` 就是它的会话 id（内置那边 `agent.id === agent.session.id`），join 靠它。
 */
const LEAD_AGENT = { id: 'sess-1' }
const TEAM_ROWS = [
	{ id: 'sess-1', name: 'lead', role: 'lead', status: 'running', model: 'deepseek-flash', diagnostics: [] },
	{ id: 'child-1', name: 'revi-1', role: 'teammate', status: 'inactive', description: '独立复核交付物', provider: 'deepseek', context: 'fresh', model: 'deepseek-flash', diagnostics: [] },
]

/** 团队那一套假服务：`agentTeams`（名册）+ `agents`（按会话 id 取活着的 Lead）。 */
const teamServices = (lead = LEAD_AGENT, rows = TEAM_ROWS) => ({
	agentTeams: { listMembers: () => rows },
	agents: { get: (id) => (lead !== null && lead !== undefined && typeof lead.id === 'string' && id === lead.id ? lead : undefined) },
})

/** 宿主那两个半边共用的假 ctx（与 `loadClient` 里那个 `get` 同一套服务）。 */
const hostCtx = (services) => ({ fs: makeFs(), get: (name) => services[name], logger: { warn() {} } })

/** 一个真临时工作区：名册两个人（在场且开着执行代 / 退役），看板一条进行中。 */
function fixtureWorkspace() {
	const workspace = mkdtempSync(join(tmpdir(), 'team-ops-pane-'))
	mkdirSync(join(workspace, '.ops'), { recursive: true })
	writeFileSync(
		join(workspace, '.ops/members.json'),
		JSON.stringify(
			{
				version: 1,
				seq: 2,
				members: [
					{
						id: 'MB-001',
						name: 'revi-1',
						role: 'reviewer',
						description: '独立复核交付物',
						prompt: '复核 docs/plan.md 并产出 docs/review.md',
						persona: '你是复核员，只认证据。',
						task: '复核 T-001',
						session: 'sess-0000000000000001',
						status: '在场',
						last_active_at: '2026-10-07T02:00:00.000Z',
						enabled: true,
						runtime: 'inactive',
					},
					{ id: 'MB-002', name: 'be-1', role: 'be-dev', description: '后端接口与数据', status: '退役', retire_reason: '这一批活干完了', replaced_by: 'be-2', enabled: false },
				],
			},
			null,
			2,
		),
	)
	writeFileSync(
		join(workspace, '.ops/board.json'),
		JSON.stringify({ version: 1, seq: 3, tasks: [{ id: 'T-001', description: '复核', owner: 'reviewer', status: '进行中', revision: 1, assignee: 'revi-1', attempt: 1, attemptId: 'uuid-1', priority: 'P1' }], tombstones: [] }, null, 2),
	)
	mkdirSync(join(workspace, '.ops'), { recursive: true })
	return workspace
}

/** 调一个真端点拿载荷（**不手抄**一份：页面读的字段名与宿主回的字段名因此对得上）。 */
async function endpoint(handlerName, url, ctx) {
	const host = await import('../lib/board-view.host.js')
	const captured = { status: 0, body: '' }
	const res = {
		writeHead(status) {
			captured.status = status
		},
		end(body) {
			captured.body = body
		},
	}
	await host[handlerName](ctx, { method: 'GET', url }, res, null)
	assert.equal(captured.status, 200, captured.body)
	return JSON.parse(captured.body)
}

/**
 * 装一个假 fetch：按 URL 分派到四种载荷（状态 / 成员 / 技能清单 / 技能正文），
 * POST 记下来并回一条引擎形状的成功回执。**`/roles` 一律算意外**（那一栏已撤下）。
 */
const BOARD_PAYLOAD = { ok: true, file: '/w/.ops/board.json', items: [], counts: { 待办: 0 }, warnings: [], annotations: [], markdown: '' }

function stubFetch({
	status,
	members,
	skills,
	definition,
	board = BOARD_PAYLOAD,
	teamTasks = { ok: true, available: false, reason: '假件：没给团队任务', rows: [], counts: null, warnings: [] },
	milestones = { ok: true, path: '/w/docs/team/里程碑.md', exists: true, rows: [], warnings: [] },
	collab = null,
	post = null,
	teamService = null,
}) {
	const calls = []
	const original = globalThis.fetch
	globalThis.fetch = async (url, init) => {
		const target = '' + url
		calls.push({ url: target, method: init?.method ?? 'GET', body: init?.body })
		// 桩件照**真 Response** 的规矩：body 只能读一次（第二次读要抛）。
		// 现场踩过：缓存那层先读了一次又把原 response 交出去 ⇒ 调用方再读就抛，报成"响应不是 JSON"。
		// 桩件不模拟这件事的话，这条自检就抓不到它。
		const json = async (payload) => {
			let used = false
			return {
				status: 200,
				json: async () => {
					if (used) throw new Error('body 已读过了（桩件按真 Response 的规矩抛）')
					used = true
					return payload
				},
			}
		}
		// 面板**不再有派活端点**（那件事由协调者按"点名"规矩做）；桩件里留一条兜底，误发就当场炸。
		if (target.startsWith('/company-board/api/spawn')) throw new Error('面板不该自己派人：' + target)
		if (init?.method !== undefined && init.method !== 'GET') return json(post ?? { ok: true, name: JSON.parse(init.body).name, action: 'update', warnings: [] })
		if (target.startsWith('/company-board/api/skills/definition')) return json(definition)
		// 技能写入口（导入 / 新建 / 删除）：回一个真形状（面板只读 `ok` / `id` / `path`）。
		if (/^\/company-board\/api\/skills\/(import|create|remove)/.test(target)) {
			const body = init?.body === undefined ? {} : JSON.parse(init.body)
			return json({ ok: true, action: target.split('/').pop().split('?')[0], id: body.name ?? 'imported-one', root: '/u/.dsh/skills', path: '/u/.dsh/skills/' + (body.name ?? 'imported-one') })
		}
		// 角色包导出（GET）：面板只读 `ok` / `pack` / `fileName`，落盘下载在假 DOM 里不做。
		if (target.startsWith('/company-board/api/roles/export')) {
			return json({ ok: true, pack: { format: 'dsh-team-ops/roles', formatVersion: 1, roles: [] }, fileName: 'roles.dshroles.json' })
		}
		// 协作读数（面板「任务看板」块顶部那一行）：空账也回 ok，测试只关心它不挡板面。
		if (target.startsWith('/company-board/api/team-service')) {
			return json(teamService ?? { ok: true, service: true, enabled: false, reason: null, warnings: [] })
		}
		if (target.startsWith('/company-board/api/collab')) {
			return json(
				collab ?? {
					ok: true,
					metrics: { tasks: { total: 0, todo: 0, doing: 0, done: 0 }, handoffs: { total: 1, gaps: 0 }, conflicts: 0, packMissing: 0 },
					// `to` 照 `handoff` 工具的口径写**角色 id**（不是成员名）；`from` 是成员名。
					// `task` 把交接单关联到任务卡（工具 `handoff` 的可选字段）。
					handoffs: [{ from: 'qa', to: 'reviewer', artifact: '测试报告', path: 'docs/qa/report.md', need: '上线前看一遍', task: 'T-2' }],
				},
			)
		}
		if (target.startsWith('/company-board/api/team-tasks')) return json(teamTasks)
		if (target.startsWith('/company-board/api/milestones')) return json(milestones)
		if (target === '/company-board/api' || target.startsWith('/company-board/api?')) return json(board)
		if (target.startsWith('/company-board/api/skills')) return json(skills)
		if (target.startsWith('/company-board/api/members')) return json(members)
		if (target.startsWith('/company-board/api/status')) return json(status)
		throw new Error('这一栏不该请求这个端点：' + target)
	}
	return {
		calls,
		restore() {
			globalThis.fetch = original
		},
	}
}

const STATUS_PAYLOAD = { ok: true, workspace: '/w', docsPath: '/w/docs/team/tasks.md', counts: { 等你: 0 }, unfinished: [] }

/** 把「团队状态」那一席渲染出来（默认落在成员块上）。 */
async function mountPane({ members, skills, definition, status = STATUS_PAYLOAD, services = {}, board, teamTasks, milestones, collab = null, post = null, teamService = null }) {
	const harness = loadClient(services)
	const seat = harness.seats.find((entry) => entry.options.name === 'conversation.view')
	assert.ok(seat !== undefined, '没有注册 conversation.view 那一席')
	const element = seat.component({ sessions: undefined, slots: undefined })
	const fetchStub = stubFetch({ status, members, skills, definition, board, teamTasks, milestones, collab, post, teamService })
	const tree = await settle(harness, element.type, element.props)
	return { tree, harness, fetchStub, element, listeners: harness.listeners }
}

/**
 * 切到「角色」块 —— 角色目录已经**独立成一块**（人的指令：从「成员」里拆出来）。
 * 默认落的仍是成员块（tab 0），所以凡是要读角色目录的用例，都必须先真的点一下那一枚。
 */
async function onRolesTab(harness, element, tree) {
	const tab = buttonWith(tree, '角色')
	assert.ok(tab !== undefined, '块表里要有「角色」那一块')
	return act(harness, element.type, element.props, () => tab.props.onClick())
}

const SKILLS_DEFINITION_PAYLOAD = {
	ok: true,
	workspace: '/w',
	name: 'code-review',
	description: '按检查表过一遍改动',
	source: 'user-dsh',
	provider: 'filesystem',
	path: '/u/.dsh/skills/code-review/SKILL.md',
	modelInvocable: true,
	userInvocable: true,
	chars: SKILL_BODY.length,
	truncated: false,
	content: SKILL_BODY,
	warnings: [],
}

// ── 自检 ─────────────────────────────────────────────────────────────────────

test('席位：三处 —— 视图栏 + 输入框左侧「角色」+ 输入框右侧「润色」', () => {
	const harness = loadClient()
	assert.deepEqual(
		harness.seats.map((entry) => entry.options.name),
		['conversation.view', 'conversation.input.left', 'conversation.input.right'],
		'三席：视图栏（四块）+ 输入框左侧（角色按钮）+ 输入框右侧（润色按钮）；设置页那一席已按人的指令撤下',
	)
	assert.equal(harness.seats[0].options.label, '团队状态')
	// 输入框那一席：人的指令「在输入框添加一个「角色」按钮」（不是写在「成员」块里）。
	assert.equal(harness.seats[1].options.id, 'company-roles')
	assert.equal(harness.seats[1].options.label, '角色')
	assert.equal(typeof harness.seats[1].component, 'function')
	// 输入框右侧那一席（design-polish-001）：润色入口。
	assert.equal(harness.seats[2].options.id, 'company-polish')
	assert.equal(harness.seats[2].options.label, '润色')
	assert.equal(harness.seats[2].options.order, 100)
	assert.equal(typeof harness.seats[2].component, 'function')
})

test('`@` 菜单：角色按分类分组注册进本体的引用来源（候选 / 引用对象 / 热词典）', async () => {
	// 人的两条：「我输入 @ 根本看不到任何团队内的角色。」「@ 出来的角色，我们也要分组。」
	// 分组这件事照 `@michengai/dsh-agency-agents` 的做法：**一组一个来源**（它按 division 循环注册），
	// 组标题写在每个来源的 `section` 上。我们的组 = 角色的 `category`。
	const workspace = fixtureWorkspace()
	const roster = {
		defaults: {
			rows: [
				{ role: 'reviewer', title: '评审员', category: '质量', positioning: '对产物内部质量负责。', avatar: 'search', avatarTone: 'exec', state: 'absent' },
				{ role: 'qa', title: '测试工程师', category: '质量', positioning: '对质量结论负责。', avatar: 'shield', avatarTone: 'exec', state: 'present' },
				{ role: 'fe-dev', title: '前端开发', category: '研发', positioning: '实现界面侧能力。', avatar: 'browser', avatarTone: 'exec', state: 'absent' },
			],
		},
	}
	const asked = []
	const savedFetch = globalThis.fetch
	globalThis.fetch = async (url) => {
		asked.push('' + url)
		return { status: 200, json: async () => roster }
	}
	const sources = []
	const sessions = { list: { getSnapshot: () => ({ current: 'sess-1', byId: { 'sess-1': { id: 'sess-1', cwd: workspace } } }) } }
	try {
		loadClient({
			sessions: sessions,
			inputTriggers: {
				registerSource(source) {
					sources.push(source)
					return () => {}
				},
			},
		})
		// 注册是**预热之后**按组发生的（分组来自名册：分类是动态的，不能先写死）
		for (let pass = 0; pass < 6 && sources.length < 2; pass += 1) await new Promise((resolve) => setTimeout(resolve, 0))
		assert.deepEqual(
			sources.map((source) => source.name).sort(),
			['team-ops:roles:研发', 'team-ops:roles:质量'],
			'一个分类一个来源：' + sources.map((source) => source.name).join(' / '),
		)
		assert.ok(sources.every((source) => source.trigger === '@'), '都挂在 `@` 上')
		assert.ok(sources.every((source) => source.codec !== undefined && typeof source.codec.serialize === 'function'), '每个来源都要带 serializer（否则提交时报 no serializer）')
		assert.deepEqual(
			sources.map((source) => source.order).sort((a, b) => a - b),
			[120, 121],
			'顺序按分类在名册里出现的先后',
		)
		const quality = sources.find((source) => source.name === 'team-ops:roles:质量')
		const dev = sources.find((source) => source.name === 'team-ops:roles:研发')
		// ① 候选：只给本组的人，`section` = 组名（组标题）
		assert.deepEqual(await quality.candidates({ sessionId: 'sess-1' }, { query: '' }), [
			{ name: '评审员', hint: 'reviewer', section: '质量' },
			{ name: '测试工程师', hint: 'qa', section: '质量' },
		])
		assert.deepEqual(await dev.candidates({ sessionId: 'sess-1' }, { query: '' }), [
			{ name: '前端开发', hint: 'fe-dev', section: '研发' },
		])
		assert.ok(asked.some((url) => url.startsWith('/company-board/api/members')), '候选从本插件那个端点现取')
		// ② 选中 ⇒ 交回一枚 chip 的引用对象；`source` 指向**本组**那个来源
		assert.deepEqual(quality.onPick({ candidate: { name: '测试工程师', hint: 'qa' }, session: { sessionId: 'sess-1' }, span: { start: 0, end: 0, draftRev: 3 } }).insert, {
			source: 'team-ops:roles:质量',
			ref: 'qa',
			label: '测试工程师',
			appearance: 'session',
			clipboardText: '@qa\u00A0',
		})
		// ③ 热词典按组给（本体那边合并）：直接打 `@fe-dev` 也算引用
		assert.deepEqual(quality.lexicon().sort(), ['qa', 'reviewer'])
		assert.deepEqual(dev.lexicon(), ['fe-dev'])
		// ④ 订阅面在（名册变了要通知本体重扫）
		let pinged = 0
		const off = quality.subscribeLexicon(() => {
			pinged += 1
		})
		assert.equal(typeof off, 'function', 'subscribeLexicon 要能注销')
		off()
	} finally {
		globalThis.fetch = savedFetch
	}
})


test('@ 角色源：inputTriggers 晚到也会补注册（不再永远没有 serializer）', async () => {
	// 现场：插件装载时 `inputTriggers` 还没就绪 ⇒ 来源没注册 ⇒ 角色按钮插出的 chip 一提交就报
	// `slash: no serializer for reference source`。apply 里必须短轮询等它出现。
	const workspace = fixtureWorkspace()
	const sources = []
	const services = { sessions: { list: { getSnapshot: () => ({ current: 'sess-1', byId: { 'sess-1': { id: 'sess-1', cwd: workspace } } }) } } }
	const savedFetch = globalThis.fetch
	globalThis.fetch = async () => ({ status: 200, json: async () => ({ defaults: { rows: [{ role: 'qa', title: '测试工程师', category: '质量', positioning: 'x', state: 'absent' }] } }) })
	try {
		loadClient(services)
		// 装载时没有这个服务：apply 先拿不到，来源一个都没有。
		assert.equal(sources.length, 0)
		// 250ms 后服务出现，轮询应当把它装上。
		services.inputTriggers = { registerSource: (src) => { sources.push(src); return () => {} } }
		for (let pass = 0; pass < 20 && sources.length === 0; pass += 1) await new Promise((resolve) => setTimeout(resolve, 50))
		assert.ok(sources.length > 0, '晚到的 inputTriggers 也要注册角色来源')
		assert.ok(sources.every((source) => typeof source.codec?.serialize === 'function'), '注册出来的来源必须带 serializer')
	} finally {
		globalThis.fetch = savedFetch
	}
})

test('角色按钮：@ 来源没注册时退成纯文本（不插坏 chip）', async () => {
	// 防御面：`inputTriggers` 没就绪 ⇒ 没有 serializer 的 chip 一提交就报
	// `slash: no serializer for reference source`。这时按钮应当走纯文本，而不是插引用。
	const workspace = fixtureWorkspace()
	const harness = loadClient()
	const Entry = harness.seats.find((entry) => entry.options.name === 'conversation.input.left').component
	const rows = { defaults: { rows: [{ role: 'qa', title: '测试工程师', category: '质量', positioning: '对质量结论负责。', state: 'present' }] } }
	const savedFetch = globalThis.fetch
	globalThis.fetch = async () => ({ status: 200, json: async () => rows })
	const kb = fakeKeyboard()
	const savedDoc = globalThis.document
	globalThis.document = kb.doc
	const bailCalls = []
	const handle = { state: { getSnapshot: () => ({ draft: '', occurrences: [], draftRev: 1 }) } }
	const scope = { get: () => ({ input: { for: () => handle } }), bail: (target, event, request) => { bailCalls.push({ event, request }); return true } }
	const sessions = { scope: () => scope, list: { getSnapshot: () => ({ current: 'sess-1', byId: { 'sess-1': { id: 'sess-1', cwd: workspace } } }) } }
	const props = () => ({ sessionId: 'sess-1', sessions, useInput: (select) => select({ draft: '' }), inputActions: { setDraft: () => {} } })
	try {
		let tree = await act(harness, Entry, props(), () => {})
		const button = nodes(tree).find((node) => node.type === 'button' && hasClass(node, 'cbv-composer-btn'))
		tree = await act(harness, Entry, props(), () => button.props.onClick())
		const qaRow = nodes(tree).find((node) => node.props['data-composer-role-id'] === 'qa')
		tree = await act(harness, Entry, props(), () => qaRow.props.onClick())
		assert.deepEqual(bailCalls.map((call) => call.event), ['slash/input-insert-text'], '没有来源就走纯文本')
		assert.equal(bailCalls[0].request.text, '@qa ', '纯文本长成 @角色名')
		assert.equal(bailCalls[0].request.reference, undefined, '不许插引用 chip')
	} finally {
		globalThis.fetch = savedFetch
		globalThis.document = savedDoc
	}
})

test('@ 菜单：切工作区只认当前名册（热词典与候选都不串味）', async () => {
	const workspaceA = fixtureWorkspace()
	const workspaceB = fixtureWorkspace()
	const rosterA = { defaults: { rows: [
		{ role: 'reviewer', title: '评审员', category: '质量', positioning: 'x', state: 'absent' },
		{ role: 'qa', title: '测试工程师', category: '质量', positioning: 'x', state: 'present' },
	] } }
	const rosterB = { defaults: { rows: [
		{ role: 'qa2', title: '测试二', category: '质量', positioning: 'x', state: 'present' },
	] } }
	const savedFetch = globalThis.fetch
	globalThis.fetch = async (url) => {
		const textUrl = '' + url
		return { status: 200, json: async () => (textUrl.includes(encodeURIComponent(workspaceB)) ? rosterB : rosterA) }
	}
	let current = 'sess-1'
	const sessions = { list: { getSnapshot: () => ({ current, byId: { 'sess-1': { id: 'sess-1', cwd: workspaceA }, 'sess-2': { id: 'sess-2', cwd: workspaceB } } }) } }
	const sources = []
	try {
		loadClient({ sessions, inputTriggers: { registerSource: (src) => { sources.push(src); return () => {} } } })
		for (let pass = 0; pass < 10 && sources.length === 0; pass += 1) await new Promise((resolve) => setTimeout(resolve, 0))
		const quality = sources.find((source) => source.name === 'team-ops:roles:质量')
		assert.ok(quality, '要注册「质量」这一组')
		assert.deepEqual(quality.lexicon().sort(), ['qa', 'reviewer'])
		// 切到 B 工作区：候选与热词典都只该是 B 的人。
		current = 'sess-2'
		assert.deepEqual(await quality.candidates({ sessionId: 'sess-2' }, { query: '' }), [
			{ name: '测试二', hint: 'qa2', section: '质量' },
		])
		assert.deepEqual(quality.lexicon(), ['qa2'], '热词典不许把 A 的 reviewer/qa 串进来')
	} finally {
		globalThis.fetch = savedFetch
	}
})

test('子智能体对话里 `@` 角色源：名册按根会话取（子会话行没有 cwd）', async () => {
	// 现场：子对话里输入 `@`，菜单闪一下就关 —— 角色源拿**子会话**去取名册，子会话行没有 cwd
	// ⇒ 请求不带工作区，宿主只能失败 ⇒ 这一组候选为空 ⇒ 菜单自动收起。
	const workspace = fixtureWorkspace()
	const list = {
		getSnapshot: () => ({
			ids: ['root-1', 'child-1'],
			byId: {
				'root-1': { id: 'root-1', cwd: workspace },
				'child-1': { id: 'child-1', parentId: 'root-1', origin: 'subagent' },
			},
		}),
	}
	const sources = []
	const calls = []
	const savedFetch = globalThis.fetch
	globalThis.fetch = async (url) => {
		calls.push('' + url)
		return { status: 200, json: async () => ({ defaults: { rows: [{ role: 'qa', title: '测试工程师', category: '质量', positioning: '对质量结论负责。', state: 'absent' }] } }) }
	}
	try {
		loadClient({ sessions: { list }, inputTriggers: { registerSource: (src) => { sources.push(src); return () => {} } } })
		for (let i = 0; i < 10 && sources.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
		assert.ok(sources.length > 0, '角色源要注册进 `@` 菜单')
		const source = sources.find((entry) => entry.trigger === '@' && String(entry.name).startsWith('team-ops:roles:'))
		assert.ok(source !== undefined, '要有团队角色那一组：' + JSON.stringify(sources.map((s) => s.name)))
		const rows = await source.candidates({ sessionId: 'child-1' })
		assert.equal(rows.length, 1, '候选来自名册：' + JSON.stringify(rows))
		assert.ok(
			calls.some((url) => url.startsWith('/company-board/api/members') && url.includes('session=root-1') && url.includes('workspace=' + encodeURIComponent(workspace))),
			'按根会话 + 根工作区取名册：' + JSON.stringify(calls),
		)
	} finally {
		globalThis.fetch = savedFetch
	}
})

test('输入框工具行那一席：`@` 菜单已经够了，这一席只留「角色」 + 插标记', async () => {
	// 人的两条口径合起来定下了这一席的形状：
	//   「我的意思是在输入框添加一个「角色」按钮，不是让你写在「成员」里面。」
	//   「为什么还要在「角色」按钮旁边加一个「让xxx去做」，不多此一举吗？」
	// ⇒ 这一席**只有一枚按钮**（打开选择框 ⇒ 把 `@角色名` 追加进输入框），
	//    不再有第二枚动作按钮：本体的发送键就够了，那件事由协调者按"点名"规矩派下去。
	const workspace = fixtureWorkspace()
	const registeredSources = []
	const harness = loadClient({ inputTriggers: { registerSource: (src) => { registeredSources.push(src); return () => {} } } })
	// 角色引用只在**来源注册过**时才插（否则提交会报 no serializer）；等预热把来源注册出来。
	for (let pass = 0; pass < 10 && registeredSources.length === 0; pass += 1) await new Promise((resolve) => setTimeout(resolve, 0))
	const Entry = harness.seats.find((entry) => entry.options.name === 'conversation.input.left').component
	const rows = {
		defaults: {
			rows: [
				{ role: 'reviewer', title: '评审员', category: '质量', positioning: '对产物内部质量负责。', avatar: 'search', avatarTone: 'exec', state: 'absent' },
				{ role: 'qa', title: '测试工程师', category: '质量', positioning: '对质量结论负责。', avatar: 'shield', avatarTone: 'exec', state: 'present' },
				{ role: 'fe-dev', title: '前端开发', category: '研发', positioning: '实现界面侧能力。', avatar: 'browser', avatarTone: 'exec', state: 'absent' },
			],
		},
	}
	const calls = []
	const savedFetch = globalThis.fetch
	globalThis.fetch = async (url) => {
		calls.push('' + url)
		return { status: 200, json: async () => rows }
	}
	const kb = fakeKeyboard()
	const savedDoc = globalThis.document
	globalThis.document = kb.doc
	let draft = ''
	const bailCalls = []
	const scope = {
		get: (name) => (name === 'conversation' ? { input: { for: () => handle } } : undefined),
		bail: (target, event, request) => {
			bailCalls.push({ event: event, request: request })
			return true
		},
	}
	// 快照照本体的形状：`draft` 是**展开文本**（chip 展开成 `@qa\u00A0`），`occurrences` 给出那一段的位置。
	const handle = { state: { getSnapshot: () => ({ draft: draft, occurrences: occurrences, draftRev: 7 }) } }
	let occurrences = []
	const sessions = { scope: () => scope, list: { getSnapshot: () => ({ current: 'sess-1', byId: { 'sess-1': { id: 'sess-1', cwd: workspace } } }) } }
	const props = () => ({ sessionId: 'sess-1', sessions: sessions, useInput: (select) => select({ draft: draft }), inputActions: { setDraft: () => {} } })
	try {
		// ① **只有一枚按钮**（人的判断：旁边那枚"让 xxx 去做"是重复入口）
		draft = '@qa 把 docs/plan.md 改成三条判据'
		let tree = await act(harness, Entry, props(), () => {})
		const allButtons = nodes(tree).filter((node) => node.type === 'button' && hasClass(node, 'cbv-composer-btn'))
		assert.equal(allButtons.length, 1, '这一席只有一枚按钮，实际 ' + allButtons.length)
		assert.equal(nodes(tree).filter((node) => node.props['data-composer-role-go'] !== undefined).length, 0, '不再有第二枚动作按钮')
		assert.equal(textsOf(allButtons[0].children).join(''), '角色', '按钮文案恒为「角色」')
		assert.ok(nodes(allButtons[0].children).some((node) => hasClass(node, 'cbv-mp-avatar-svg')), '按钮上有一枚图标')
		// ② 点开 ⇒ 现取名册；浮层里只有组标题 + 角色名
		tree = await act(harness, Entry, props(), () => allButtons[0].props.onClick())
		assert.ok(calls.some((url) => url.startsWith('/company-board/api/members')), '打开时现取名册')
		const pop = nodes(tree).find((node) => hasClass(node, 'cbv-rolepick-pop'))
		assert.equal(textsOf(pop.children).join(''), '质量评审员测试工程师研发前端开发', '浮层文字 = 组标题 + 角色名')
		// ③ 选一个 ⇒ 把 `@名字` 插入输入框（先插引用；`span` 是 detect 坐标 + draftRev）
		draft = ''
		const qaRow = nodes(tree).find((node) => node.props['data-composer-role-id'] === 'qa')
		tree = await act(harness, Entry, props(), () => qaRow.props.onClick())
		assert.deepEqual(bailCalls.map((call) => call.event), ['slash/input-insert-reference'], '插入走本体那条事件面')
		assert.deepEqual(
			bailCalls[0].request.reference,
			{ source: 'team-ops:roles:质量', ref: 'qa', label: '测试工程师', appearance: 'session', clipboardText: '@qa\u00A0' },
			'交回的是本体那枚 chip 的引用对象（`source` 指向它那一组，label 是中文名）',
		)
		assert.deepEqual(bailCalls[0].request.span, { start: 0, end: 0, draftRev: 7 }, '插在最前面，带当前 draftRev')
		assert.equal(nodes(tree).find((node) => node.props['data-composer-role-list'] !== undefined), undefined, '选完就关窗')
		// ③′ **回归**：输入框里已经有一枚 chip 时，第二枚也要插得进去（曾经算错坐标 ⇒ 静默失败，
		//     现场就是"只显示第一个 @ 角色"）。detect 坐标下：那枚 chip 只算 1 个字符。
		draft = '@qa\u00A0把 X 改了'
		occurrences = [{ offset: 0, length: 4 }]
		tree = await act(harness, Entry, props(), () => nodes(tree).filter((node) => node.type === 'button' && hasClass(node, 'cbv-composer-btn'))[0].props.onClick())
		const secondRow = nodes(tree).find((node) => node.props['data-composer-role-id'] === 'fe-dev')
		tree = await act(harness, Entry, props(), () => secondRow.props.onClick())
		assert.equal(bailCalls.length, 2, '第二次也是一次真插入')
		assert.deepEqual(bailCalls[1].request.span, { start: 1, end: 1, draftRev: 7 }, '插入点在 detect 坐标下 = `\uFFFC` 之后（1），不是展开文本的 4')
		occurrences = []
		// ④ **可以连着选好几个**：已有标记时是追加（`@qa ` 之后），不替换
		draft = '@qa 把 X 改了'
		tree = await act(harness, Entry, props(), () => allButtons[0].props.onClick())
		const devRow = nodes(tree).find((node) => node.props['data-composer-role-id'] === 'fe-dev')
		const beforeFifth = bailCalls.length
		tree = await act(harness, Entry, props(), () => devRow.props.onClick())
		assert.equal(bailCalls.length, beforeFifth + 1, '第二次也是在插（不是替换）')
		const last = bailCalls[bailCalls.length - 1]
		assert.deepEqual(last.request.span, { start: 4, end: 4, draftRev: 7 }, '插在已有标记串之后（`@qa ` 之后）')
		assert.equal(last.request.reference.source, 'team-ops:roles:研发', '插的是**它那一组**的来源')
		// ⑤ 文本里已经点到的角色，在选择框里是"已选中"（可以好几个）
		draft = '@qa @fe-dev 把 X 改了'
		tree = await act(harness, Entry, props(), () => allButtons[0].props.onClick())
		assert.deepEqual(
			nodes(tree).filter((node) => node.props['data-composer-role-id'] !== undefined).map((node) => node.props['data-composer-role-id']),
			['reviewer', 'qa', 'fe-dev'],
			'三个都在（都还能点）',
		)
		assert.deepEqual(
			nodes(tree).filter((node) => hasClass(node, 'cbv-picker-row--on')).map((node) => node.props['data-composer-role-id']),
			['qa', 'fe-dev'],
			'已经点名的那两个是选中态',
		)
		// ⑥ **这一席不再发任何写请求**（派活是协调者的事）
		assert.equal(calls.filter((url) => url.includes('/spawn')).length, 0, '面板不该自己派人')
		// ⑦ 失去焦点 / Esc 关窗
		assert.ok(kb.installed(), '选择框开着时 keydown 监听应在')
		tree = await act(harness, Entry, props(), () => kb.outsideDown({ contains: () => false }))
		assert.equal(nodes(tree).find((node) => node.props['data-composer-role-list'] !== undefined), undefined, '点在别处 ⇒ 关掉')
		tree = await act(harness, Entry, props(), () => allButtons[0].props.onClick())
		kb.press('Escape')
		tree = await settle(harness, Entry, props())
		assert.equal(nodes(tree).find((node) => node.props['data-composer-role-list'] !== undefined), undefined, 'Esc ⇒ 关掉')
	} finally {
		globalThis.fetch = savedFetch
		globalThis.document = savedDoc
	}
})


test('角色选择框：portal 到 document.body（fixed 不再被输入框的包含块带偏）', async () => {
	// 现场：选择框（`position: fixed`）跟「角色」按钮**对不上** —— 整体右移，输入框那一片却没动。
	// 根因不是坐标算错，而是它**就地**渲染在宿主的 `conversation.input.left` 席位里：已激活会话下
	// 那一带的 `.composerSeat` 带 `will-change: transform`，给后代造了包含块 ⇒ `fixed` 相对那一层，
	// 不再相对视口（`bottom` 恰好还落在差不多的位置，所以只错横轴）。
	// 宿主自己的插槽契约把修法写死了：
	//   "fixed overlays must portal to the document body because the docked composer contains them"
	// 这一条钉两件事：① 有 `react-dom` 时**必须**走 createPortal 到 `document.body`（带的是选择框本体）；
	// ② 拿不到这个种子（离线自检那套"穷人的 React"）时退回就地渲染，**不许崩**。
	const workspace = fixtureWorkspace()
	const rows = { defaults: { rows: [{ role: 'qa', title: '测试工程师', category: '质量', positioning: '对质量结论负责。', state: 'absent' }] } }
	const savedFetch = globalThis.fetch
	globalThis.fetch = async () => ({ status: 200, json: async () => rows })
	const savedDoc = globalThis.document
	const kb = fakeKeyboard()
	globalThis.document = kb.doc
	const portals = []
	const reactDom = {
		createPortal(node, container, key) {
			portals.push({ node, container, key })
			return node
		},
	}
	const sessions = { list: { getSnapshot: () => ({ current: 'sess-1', byId: { 'sess-1': { id: 'sess-1', cwd: workspace } } }) } }
	const props = () => ({ sessionId: 'sess-1', sessions, useInput: (select) => select({ draft: '' }), inputActions: { setDraft: () => {} } })
	try {
		const harness = loadClient({}, { 'react-dom': reactDom })
		const Entry = harness.seats.find((entry) => entry.options.name === 'conversation.input.left').component
		let tree = await act(harness, Entry, props(), () => {})
		const button = nodes(tree).find((node) => node.type === 'button' && hasClass(node, 'cbv-composer-btn'))
		tree = await act(harness, Entry, props(), () => button.props.onClick())
		// 一开一关之间会重渲染好几次（名册回来一次、位置算好又一次）⇒ 每渲染一次就 portal 一次，
		// 断言的是"**每一次**都走同一条路"，不是次数。
		assert.ok(portals.length > 0, '打开选择框必须走 createPortal')
		assert.ok(portals.every((call) => call.container === kb.doc.body), '每一次 portal 的容器都是 document.body（fixed 从此以视口为准）')
		assert.ok(portals.every((call) => hasClass(call.node, 'cbv-rolepick-pop')), 'portal 出去的是选择框本体')
		assert.ok(nodes(tree).find((node) => hasClass(node, 'cbv-rolepick-pop')), '渲染树里仍然看得到它（位置照算）')

		// ② 没有 `react-dom`：退化成就地渲染 —— 位置受包含块影响（老样子），但**页面照常能用**。
		const bare = loadClient({})
		const BareEntry = bare.seats.find((entry) => entry.options.name === 'conversation.input.left').component
		let bareTree = await act(bare, BareEntry, props(), () => {})
		const bareButton = nodes(bareTree).find((node) => node.type === 'button' && hasClass(node, 'cbv-composer-btn'))
		bareTree = await act(bare, BareEntry, props(), () => bareButton.props.onClick())
		assert.ok(nodes(bareTree).find((node) => hasClass(node, 'cbv-rolepick-pop')), '拿不到 react-dom 时退回就地渲染，不许崩')
	} finally {
		globalThis.fetch = savedFetch
		globalThis.document = savedDoc
	}
})


test('默认落在成员块：按真端点载荷画卡片与读数，且整栏不碰 /roles', async () => {
	const workspace = fixtureWorkspace()
	const calls = []
	// 喂一个假会话清单：客户端要能看出**请求带上了 workspace 与 session**
	// （成员那块靠 session 拿本会话的 agent 名册；技能那块靠它读会话层的目录）。
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry(calls) }))
	const { tree, fetchStub, harness, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// 块表：四个按钮（人的指令：「角色」从成员块里拆出来、独立成一块），**按 `data-pane-block` 找**。
		const blockButtons = nodes(tree).filter((node) => node.type === 'button' && node.props['data-pane-block'] !== undefined)
		assert.deepEqual(
			blockButtons.map((node) => node.props['data-pane-block']),
			['members', 'roles', 'skills', 'board'],
		)
		const labels = blockButtons.map((node) => textsOf(node.children).join(''))
		assert.deepEqual(labels, ['成员', '角色', '技能', '任务看板'], '块序 = 成员 / 角色 / 技能 / 任务看板')
		// 默认仍落在成员（tab 0）：第一枚是唯一被选中的那一枚。
		// **tab 语义**（设计 3.5）：容器 `role=tablist`、按钮 `role=tab` + `aria-selected`（不再是 `aria-pressed`）。
		const tablist = nodes(tree).find((node) => node.props.role === 'tablist')
		assert.ok(tablist !== undefined, '块切换要有 tablist 容器')
		assert.equal(blockButtons[0].props.role, 'tab', '块按钮是 tab')
		assert.equal(blockButtons[0].props['aria-selected'], 'true', '默认落在成员块')
		assert.ok(blockButtons.slice(1).every((node) => node.props['aria-selected'] === 'false'), '其余三块都不在选中态')
		// roving tabindex：Tab 只停一次（选中项 0、其余 -1）。
		assert.deepEqual(blockButtons.map((node) => node.props.tabIndex), [0, -1, -1, -1], 'roving tabindex')
		assert.deepEqual(blockButtons.map((node) => node.props['aria-controls']), ['cbv-panel-members', 'cbv-panel-roles', 'cbv-panel-skills', 'cbv-panel-board'], 'aria-controls 指向对应面板')
		// **「在册」那枚 chip 数的是"名册里的成员"**（`ledger` 行），不是原生那一侧的 `kind === 'teammate'`：
		// 现场本会话原生只有协调者一个 agent，页面上摆着五位成员，chip 却报 0。
		// 它从前叫「队友」—— 而卡上那枚身份徽标写「队友」的判据是原生 `kind === 'teammate'`，
		// 于是点「队友 5」会看到卡上写着「只在名册里」：**判据不动（现场专门纠正过为什么是 0），把名字改准**。
		// **档位恰好三档**（task-40）：全部 / 协调者 / 已停用 —— 旧账那两档（在册 / 未入册）不许回来。
		// **一排放完**（task-43）：全部 / 协调者 / 已停用 / 各运行时值 **同级互斥**
		const facetChips = nodes(tree).filter((node) => node.props['data-members-facet'] !== undefined)
		assert.deepEqual(facetChips.map((node) => node.props['data-members-facet']), ['all', 'lead', 'disabled', 'runtime:inactive', 'runtime:running'], '一排档：' + JSON.stringify(facetChips.map((node) => node.props['data-members-facet'])))
		// **「全部」在一次筛选区内只许出现一次**（按 DOM 出现次数核，不看文案）
		assert.equal(nodes(tree).filter((node) => node.props['data-members-facet'] !== undefined && textOf(node).startsWith('全部')).length, 1, '「全部」只能有一枚')
		assert.ok(!facetChips.some((node) => /在册|未入册/.test(textOf(node))), '旧账那两档不许回来：' + JSON.stringify(facetChips.map((node) => textOf(node))))
		// 「已停用」那一档的数由 **live flag** 决定（载荷里每行的 `disabled`）：把一位标成停用 ⇒ chip 数跟着变。
		const disabledChipOf = (tree_) => nodes(tree_).find((node) => node.props['data-members-facet'] === 'disabled')
		assert.equal(textOf(disabledChipOf(tree)), '已停用 0', '没人停用时是 0：' + textOf(disabledChipOf(tree)))
		members.merged[1].disabled = true
		const stopped = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
		try {
			assert.equal(textOf(disabledChipOf(stopped.tree)), '已停用 1', '标成停用后落这一档：' + textOf(disabledChipOf(stopped.tree)))
			assert.ok(nodes(stopped.tree).some((node) => node.props['data-mem-disabled'] === 'true'), '卡上也要标出来')
		} finally {
			stopped.fetchStub.restore()
		}
		// 三个动词与徽标都只照载荷画：客户端**不推断规则**
		const teammateCard = cardsOf(tree, 'cbv-mp-card').find((card) => card.props['data-mem-kind'] === 'teammate')
		assert.ok(teammateCard !== undefined, '队友卡要在')
		assert.ok(nodes(teammateCard).some((node) => node.props['data-member-verb'] === 'disable'), '载荷给了 disable ⇒ 画出来')
		// **成员块不再印内页标题**（人的指令：tab 栏上已经有名字了，正文里不再重复）
		const membersHead = nodes(tree).find((node) => node.type === 'div' && typeof node.props.className === 'string' && node.props.className.includes('cbv-view-head') && textOf(node.children).includes('成员'))
		assert.equal(membersHead, undefined, '成员块不再有内页标题')
		assert.equal(nodes(tree).filter((node) => typeof node.props.className === 'string' && node.props.className.includes('cbv-view-title')).length, 0, '不再有内页标题节点')
		const memberPane = nodes(tree).find((node) => node.props['data-members-mark'] !== undefined)
		assert.ok(memberPane !== undefined, '成员块的根在')
		assert.ok(!textOf(memberPane).includes('角色是作业程序'), '那句关系不再展示')
		// **取数出口唯一**：客户端里每一处 `fetch(`，要么是那个缓存出口本身，要么是一处**写**（`method: 'POST'`）；
		// 每处写都要在附近失效缓存（否则写完读回来的是 TTL 内的旧数据）。
		// 曾经有三个读端点各自裸 fetch（团队任务板 / 里程碑 / 成员名册），缓存只覆盖一处、失效靠手工。
		const clientText = readFileSync('lib/board-view.client.js', 'utf8')
		const fetchLines = clientText.split('\n').map((line, index) => ({ line, no: index + 1 })).filter((row) => row.line.includes('fetch('))
		// 成员那一处写（`postMember`）已随成员写面整面撤掉 ⇒ 现在剩五处：缓存出口 + 开目录（豁免）+
		// 团队服务开关 + 角色写 + 技能写。这条数的下限跟着改，但"读必须走缓存出口"那条判定不动。
		assert.ok(fetchLines.length >= 5, '取数点要能扫出来：' + JSON.stringify(fetchLines.map((row) => row.no)))
		const cacheOutletLine = fetchLines[0].no
		for (const row of fetchLines) {
			const window = clientText.split('\n').slice(row.no - 1, row.no + 6).join('\n')
			const isCacheOutlet = row.no === cacheOutletLine
			const isWrite = window.includes("method: 'POST'")
			assert.ok(isCacheOutlet || isWrite, `第 ${row.no} 行既不是缓存出口也不是写动作（读端点必须走 getJsonCached）：` + row.line.trim().slice(0, 90))
			if (isWrite) {
				const after = clientText.split('\n').slice(row.no - 1, row.no + 30).join('\n')
				// **唯一豁免**：`OPEN_ENDPOINT`（让主进程在本机打开一个路径）—— 它不改任何一块读回的数据，
				// 所以没有可失效的东西。其余每一处写都必须在附近失效缓存，否则写完读回来是 TTL 内的旧数据。
				// 判定"是不是那一处"要看**上一行**：`const url = OPEN_ENDPOINT + …` 在 fetch 之前，fetch 那行只有 `url`。
				const before = clientText.split('\n').slice(Math.max(0, row.no - 13), row.no).join('\n')
				const opensExternally = after.includes('OPEN_ENDPOINT') || before.includes('OPEN_ENDPOINT') || row.line.includes('OPEN_ENDPOINT')
				// **第三处豁免**：输入框润色（`POLISH_ENDPOINT`）是一次模型调用，**不改任何一块读回的数据**
				// （不落盘、不写账本、不进面板缓存）—— 没有可失效的东西。
				const isPolishCall = after.includes('POLISH_ENDPOINT') || before.includes('POLISH_ENDPOINT') || row.line.includes('POLISH_ENDPOINT')
				// **第二处豁免**：角色包导入的**预览**是一个只读的 POST（`preview: true`）—— 它不落任何文件，
				// 没有可失效的东西；真正落盘的那一次（`submitPack`）自己会 `invalidatePanes()`。
				// 判据落在请求体那一行上，而不是"这个端点的所有 POST"：同一端点不带 preview 的调用照旧受管。
				const isReadOnlyPreview = after.includes('preview: true')
				if (!opensExternally && !isReadOnlyPreview && !isPolishCall) {
					assert.ok(after.includes('invalidatePanes()'), `第 ${row.no} 行是写动作，附近要失效缓存：` + row.line.trim().slice(0, 70))
				}
			}
		}

		// **旧账的最后一条读取路径也要断干净**（task-40）：客户端源码里不许再有 `ledger.` 取字段、
		// 也不许再提那份旧文件（`members.json`）—— 那一整条链（join、历史编制行、三态词表、查看提示词）都撤了。
		const clientSrc = readFileSync('lib/board-view.client.js', 'utf8')
		const ledgerReads = [...clientSrc.matchAll(/\bledger\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1])
		assert.deepEqual(ledgerReads, [], '客户端不许再读 ledger.*：' + ledgerReads.join('、'))
		// 旧文件名允许出现在**解释为什么撤掉**的注释里；但不许出现在任何**取数字**的地方
		const codeLines = clientSrc.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
		assert.ok(!codeLines.some((line) => line.includes('.ops/members.json')), '客户端代码不再提那份旧名册文件')
		// 「枚举外状态」那条检查（读旧名册的 `status` 原值）随旧账撤了 ⇒ 这里改成核它**真的没了**
		assert.ok(!clientSrc.includes('MEMBER_STATUS_WORDS'), '旧名册三态词表那套检查撤掉')

		// 人的指令：连内页标题也不再印（tab 栏上已经有「成员」）
		assert.equal(nodes(tree).filter((node) => typeof node.props.className === 'string' && node.props.className.includes('cbv-view-title')).length, 0, '不再有内页标题节点')
		assert.ok(!labels.some((label) => label.includes('审批') || label.includes('共识')), '审批与共识随制度一并撤下')
		// 默认那一块就是成员：**只有原生名册那一份**（协调者 + 队友）—— task-40 起不再有"只在名册里"的第三张卡。
		const cards = cardsOf(tree, 'cbv-mp-card')
		assert.equal(cards.length, 2)
		assert.deepEqual(cards.map((card) => card.props['data-mem-name']), ['lead', 'revi-1'])
		assert.deepEqual(cards.map((card) => card.props['data-mem-kind']), ['lead', 'teammate'])
		// 会话 id 就是这一位的真源（旧名册的编号 `MB-001` 撤了）。
		assert.equal(cards[1].props['data-mem-id'], 'child-1')
		assert.ok(cards.every((card) => !textOf(card).includes('已启用')), '卡上不再有"已启用"那半对开关态的词')
		// 「已停用」那一档与卡上的标都由 **live flag** 决定（同一条在档位那一处断言里已验过一次：
		// 把一位标成停用 ⇒ chip 从「已停用 0」变「已停用 1」、卡上出现那枚徽标）。
		assert.equal(cards[1].props['data-mem-disabled'], 'false', '没停用就是 false（档位与卡标都照这一格画）')
		// 协调者那一行：停用/恢复是**禁用态**（它不是可停用的队内成员）；「打断」照旧不画
		assert.equal(buttonWith(cards[0], '编辑'), undefined)
		assert.equal(buttonWith(cards[0], '删除'), undefined)
		assert.equal(buttonWith(cards[0], '查看提示词'), undefined)
		// **HD-006 的 UX 修正 + 设计 P-05**：协调者卡上停用 / 恢复是**不可用态**（它不是可停用的队内成员），
		// 「打断」照旧不画；判据：画了就 `aria-disabled="true"`（**不是**原生 disabled —— 它还要能被聚焦、
		// 读屏要靠 `aria-describedby` 拿到理由）且 title 非空。
		for (const button of nodes(cards[0]).filter((node) => node.props['data-member-verb'] !== undefined)) {
			assert.equal(button.props['aria-disabled'], 'true', `协调者卡上 ${button.props['data-member-verb']} 必须标成不可用（aria-disabled）`)
			assert.equal(button.props.disabled, false, '条件不允许用 aria-disabled，不用原生 disabled（仍可聚焦听理由）')
			assert.ok(String(button.props.title ?? '') !== '', `不可用态要把服务端的 why 原样给出来：${String(button.props['data-member-verb'])}`)
			assert.ok(String(button.props['aria-describedby'] ?? '') !== '', '不可用理由要能被 aria-describedby 指到')
		}
		assert.equal(nodes(cards[0]).find((node) => hasClass(node, 'cbv-switch')), undefined, '不给开关')
		assert.ok(textOf(cards[0]).includes('拆解 · 派发 · 把关 · 收口'), '协调者那一行用固定身份句（原生没给 description）')
		// 原生给的模型 / 提供者 / 上下文都要上卡（`context: fork` = 继承了父会话历史，值得一眼看到）。
		assert.ok(textOf(cards[0]).includes('模型 deepseek-flash'))
		assert.ok(textOf(cards[1]).includes('提供者 deepseek'))
		assert.ok(textOf(cards[1]).includes('上下文 fresh'))
		// 「为什么只读」那段长话**块头不再印**（人的指令：描述性文字太多）；现在那句说明**整栏只印一次**
		// （人的口径：别每张卡重复一遍），所以：① 没有那份长解释；② 块里有一次说明；③ 卡上没有它。
		assert.ok(!textOf(tree).includes('只在**原生 Agent Teams 名册**里'), '块头不再解释一遍')
		assert.ok(!textOf(tree).includes('有 1 个 agent'), '也不在块头报那个数')
		// 人的指令：整栏那行说明、计数行、块头的「角色（N）」都不展示（口径仍在「已停用」徽标的 title 上）
		assert.ok(!textOf(tree).includes('停用只停本插件派活'), '整栏不再印那句说明')
		assert.ok(!textOf(tree).includes('上限 24'), '不再印计数行')
		assert.ok(!textOf(tree).includes('角色（'), '块头不再印「角色（N）」')
		// 页头**只剩标题**（人的指令）：那些数在下面那条筛选行的 chip 上。
		assert.ok(!textOf(tree).includes('本会话 2 个 agent'), '页头不再印那串长读数')
		assert.ok(!textOf(tree).includes('本插件名册：在场'), '也不印那串长读数')
		assert.equal(textOf(nodes(tree).find((node) => node.props['data-members-facet'] === 'lead')), '协调者 1', '身份 chip 带数')
		// chip 上那个总数必须等于载荷的 `rows`（**一处口径**：数从哪里来、印出来就是那个，不许自己再算一遍）。
		const rowsAttr = nodes(tree).find((node) => node.props['data-members-rows'] !== undefined).props['data-members-rows']
		assert.ok(textOf(tree).includes('全部 ' + rowsAttr), `「全部」那个 chip 要等于 data-members-rows（实际 rows=${rowsAttr}）`)

		// 成员那一块在栏内是**自己滚**的那一层（面板窄，卡片多时要能滑下去看）。
		assert.ok(cardsOf(tree, 'cbv-mp-grid').length === 1)
		// **成员块不再渲染角色那一节**（人的指令：拆出去独立一块）—— 角色目录只属于「角色」块。
		assert.equal(nodes(tree).find((node) => node.props['data-roster-count'] !== undefined), undefined, '成员块里不再有角色目录')
		assert.equal(nodes(tree).find((node) => node.props['data-roles-mark'] !== undefined), undefined, '没切到「角色」块时不渲染它')
		// 默认那一屏只是读：`/roles` 那几个写端点一次都不该被打（角色块没挂载）。
		assert.ok(!fetchStub.calls.some((call) => call.url.includes('/roles')), '不该再请求 /roles')
		assert.ok(fetchStub.calls.some((call) => call.url.startsWith('/company-board/api/members')), '成员块的取数')
		// 切到技能块：那一块的取数要带 **workspace 与 session** 两个参数（清单与正文同一个查询串）。
		const skillsTab = buttonWith(tree, '技能')
		await act(harness, element.type, element.props, () => skillsTab.props.onClick())
		const skillsCall = fetchStub.calls.find((call) => call.url.startsWith('/company-board/api/skills?'))
		assert.ok(skillsCall !== undefined, '技能块的取数：' + JSON.stringify(fetchStub.calls.map((call) => call.url)))
		assert.ok(skillsCall.url.includes('workspace=' + encodeURIComponent(workspace)), skillsCall.url)
		assert.ok(skillsCall.url.includes('session=sess-1'), '技能目录按会话的作用域解析，必须带上 session：' + skillsCall.url)
	} finally {
		fetchStub.restore()
	}
})

test('切到新会话：三个读端点**并行预取**；随后切块命中缓存（不再等一个来回）', async () => {
	// 现场：切到新对话后点「成员 / 角色 / 技能 / 任务看板」都要等一下才出内容。端点本身只要 1–4 ms（量过），
	// 慢的是"每次重挂才开始拉" ⇒ 现在挂载即并行预取四块，并且 TTL 内重挂直接吃缓存。
	// （「角色」块与「成员」块读的是同一份 `/members` 载荷 ⇒ 它不需要第五个预取端点。）
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// ① 挂载（= 切到一个会话）就该把**还在用的**那几个读端点各拉一次 —— 不等人去点块。
		// 里程碑那一档已撤（任务在原生那本账上）⇒ 它不再出现在预取面上，也不该再被拉。
		const gets = () => fetchStub.calls.filter((call) => call.method === 'GET').map((call) => call.url.split('?')[0])
		const urls = gets()
		assert.ok(!urls.some((u) => u === '/company-board/api/milestones'), '里程碑那一档已撤 ⇒ 不该再拉它：' + JSON.stringify(urls))
		for (const ep of ['/company-board/api/members', '/company-board/api/skills', '/company-board/api/tasks', '/company-board/api/team-tasks']) {
			const hit = urls.some((u) => u === ep)
			if (ep === '/company-board/api/tasks') continue // 看板那一块在切过去时才挂载，不在预取面上
			assert.ok(hit, '预取里应有 ' + ep + '：' + JSON.stringify(urls))
		}
		// ② 切到「技能」块：命中缓存 ⇒ **不再多一次** GET /skills
		const before = fetchStub.calls.filter((call) => call.url.startsWith('/company-board/api/skills?')).length
		const tab = buttonWith(tree, '技能')
		await act(harness, element.type, element.props, () => tab.props.onClick())
		const after = fetchStub.calls.filter((call) => call.url.startsWith('/company-board/api/skills?')).length
		assert.equal(after, before, '技能块的内容来自缓存，不再多发一次请求')
	} finally {
		fetchStub.restore()
	}
})


test('面板不再有「刷新」按钮；重读交给"窗口回到前台 / 面板重新可见"两条触发', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	// 面板读 `document.visibilityState`（Node 里本没有 document）⇒ 先把假 document 装上，再挂载。
	const kb = fakeKeyboard()
	const savedDocument = globalThis.document
	globalThis.document = kb.doc
	const { tree, harness, fetchStub, element, listeners } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// ① 那枚按钮没了（人的判断：切块/重开面板本来就会重挂重取 —— 多一枚按钮是重复入口）
		assert.equal(buttonWith(tree, '刷新'), undefined, '工具行里不该再有「刷新」')
		// ② 两条触发都挂上了
		assert.equal(typeof listeners.window.focus, 'function', '窗口获得焦点要重读')
		assert.ok(kb.doc.visibilityState === 'visible', '假 document 的初始可见性')
		// ③ 真的触发一次：状态端点与当前块的清单各重取一遍（计数 +1 ⇒ 各块的 effect 再跑）
		const before = fetchStub.calls.filter((call) => call.url.startsWith('/company-board/api/status')).length
		await act(harness, element.type, element.props, () => listeners.window.focus())
		const afterFocus = fetchStub.calls.filter((call) => call.url.startsWith('/company-board/api/status')).length
		assert.equal(afterFocus, before + 1, '窗口回到前台 ⇒ 重读一次')
		// ④ 不可见时不重读（切出去那一下不该取数）；回到可见就重读一次。
		// 数"状态端点"那一路（计数 +1 ⇒ 各块的 effect 都再跑：状态一次 + 当前块清单一次）。
		const statusCalls = () => fetchStub.calls.filter((call) => call.url.startsWith('/company-board/api/status')).length
		kb.doc.visibilityState = 'hidden'
		await act(harness, element.type, element.props, () => kb.fire('visibilitychange'))
		assert.equal(statusCalls(), afterFocus, '面板不可见 ⇒ 不重读')
		kb.doc.visibilityState = 'visible'
		await act(harness, element.type, element.props, () => kb.fire('visibilitychange'))
		assert.equal(statusCalls(), afterFocus + 1, '面板回到可见 ⇒ 重读一次')
	} finally {
		fetchStub.restore()
		globalThis.document = savedDocument
	}
})

test('技能块：导入 / 新建两枚按钮、只对可写来源画删除、新建提交的 POST 形状', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const tab = buttonWith(tree, '技能')
		const onSkills = await act(harness, element.type, element.props, () => tab.props.onClick())
		// ① 工具行两枚写动作按钮
		const actions = nodes(onSkills).filter((node) => node.props['data-skill-action'] !== undefined)
		assert.deepEqual(actions.map((node) => node.props['data-skill-action']), ['import', 'create'], '导入 / 新建两枚')
		// ② **只对可写来源画删除**：夹具里两条都是可写来源（user-dsh / project-dsh）⇒ 两张卡各一个删除按钮
		const removes = nodes(onSkills).filter((node) => node.props['data-skill-remove'] !== undefined)
		assert.deepEqual(removes.map((node) => node.props['data-skill-remove']), ['code-review', 'hidden-one'])
		// ③ 导入：开浮窗 ⇒ 来源是**拖拽区**（不是输入框）⇒ 喂一批假文件 ⇒ 确定 ⇒ POST 的 body 里有 files
		const importOpened = await act(harness, element.type, element.props, () => actions[0].props.onClick())
		const importDialog = nodes(importOpened).find((node) => node.props['data-skill-dialog'] !== undefined)
		assert.equal(importDialog.props['data-skill-dialog'], 'import')
		const zone = nodes(importDialog).find((node) => node.props['data-skill-drop'] !== undefined)
		assert.ok(zone !== undefined, '拖拽区要在（来源不再是输入框）')
		assert.equal(zone.props['data-skill-drop'], 'empty')
		assert.equal(nodes(importDialog).find((node) => node.props['data-skill-field'] === 'source'), undefined, '路径输入框已经换掉')
		// 假的 DataTransfer：一个目录条目（`<folder>/SKILL.md`）
		const skillText = '---\nname: dropped-skill\ndescription: Use when 拖。\n---\n\n# 拖进来的\n'
		const fakeFile = { name: 'SKILL.md', arrayBuffer: async () => new TextEncoder().encode(skillText).buffer }
		const fakeEntry = {
			name: 'dropped-folder',
			isFile: false,
			isDirectory: true,
			createReader: () => ({ readEntries: (resolve) => resolve([{ name: 'SKILL.md', isFile: true, file: (resolve2) => resolve2(fakeFile) }]) }),
		}
		const fakeTransfer = { items: [{ kind: 'file', webkitGetAsEntry: () => fakeEntry }], files: [] }
		const dropped = await act(harness, element.type, element.props, () => zone.props.onDrop({ preventDefault() {}, dataTransfer: fakeTransfer }))
		const readyZone = nodes(dropped).find((node) => node.props['data-skill-drop'] !== undefined)
		assert.equal(readyZone.props['data-skill-drop'], 'ready', '收到文件后拖拽区变 ready')
		assert.ok(textOf(dropped).includes('已收 1 个文件'), '收文件数要说出来：' + textOf(dropped).slice(0, 120))
		// **「文件要求」写在拖拽区里面**（人的指令）：那三条讲的是"往这个区里放什么"。
		const zoneText = textOf(zone)
		for (const line of ['文件夹或单个', '必须含', '技能名优先取', '复制完整内容']) {
			assert.ok(zoneText.includes(line), '拖拽区里要有这条要求（' + line + '）：' + zoneText.slice(0, 160))
		}
		// 收完之后区下面那一行**只报读数**（不重复区里那三条要求）
		const pickedNote = nodes(dropped).find((node) => node.props['data-skill-picked'] !== undefined)
		assert.ok(pickedNote !== undefined, '收完之后要有那一行读数')
		assert.ok(!textOf(pickedNote).includes('复制完整内容'), '区外那一行不再复述要求：' + textOf(pickedNote))
		const importSubmit = nodes(dropped).find((node) => node.props['data-skill-dialog'] !== undefined)
		await act(harness, element.type, element.props, () => buttonWith(importSubmit, '确定').props.onClick())
		const imported = fetchStub.calls.filter((call) => call.method === 'POST' && call.url.startsWith('/company-board/api/skills/import'))
		assert.equal(imported.length, 1, '一次导入提交：' + JSON.stringify(fetchStub.calls.map((call) => call.url)))
		const importBody = JSON.parse(imported[0].body)
		// **缺省档 = 项目级**（task-38：写哪一级的缺省由载荷 `targetDefault` 给，缺省 project）
		assert.equal(importBody.root, 'project', '导入缺省落项目级（只这个工作区）：' + importBody.root)
		assert.equal(importBody.name, 'dropped-skill', '技能名从 SKILL.md 的 front-matter 读出来')
		assert.deepEqual(importBody.files.map((item) => item.path), ['dropped-folder/SKILL.md'])
		assert.equal(Buffer.from(importBody.files[0].dataBase64, 'base64').toString('utf8'), skillText, '内容逐字（base64 往返无损）')

		// ④ 新建：开浮窗 ⇒ 填三格 ⇒ 确定 ⇒ POST 到 /skills/create（body 逐字对）
		const opened = await act(harness, element.type, element.props, () => actions[1].props.onClick())
		const dialog = nodes(opened).find((node) => node.props['data-skill-dialog'] !== undefined)
		assert.equal(dialog.props['data-skill-dialog'], 'create')
		const field = (tree_, key) => nodes(tree_).find((node) => node.props['data-skill-field'] === key)
		const named = await act(harness, element.type, element.props, () => field(dialog, 'name').props.onChange({ target: { value: 'qa-playbook' } }))
		const described = await act(harness, element.type, element.props, () => field(named, 'description').props.onChange({ target: { value: 'Use when 测。' } }))
		const written = await act(harness, element.type, element.props, () => field(described, 'body').props.onChange({ target: { value: '# QA\n\n正文。' } }))
		const again = nodes(written).find((node) => node.props['data-skill-dialog'] !== undefined)
		await act(harness, element.type, element.props, () => buttonWith(again, '确定').props.onClick())
		const posted = fetchStub.calls.filter((call) => call.method === 'POST' && call.url.startsWith('/company-board/api/skills/create'))
		assert.equal(posted.length, 1, '一次提交：' + JSON.stringify(fetchStub.calls.map((call) => call.url)))
		// 缺省档 = 项目级（task-38）
		assert.deepEqual(JSON.parse(posted[0].body), { root: 'project', name: 'qa-playbook', description: 'Use when 测。', body: '# QA\n\n正文。' })
		// ④ 删除：走的是同一个端点族（这次只验参数形状：名称 + 根）
		const row = nodes(written).find((node) => node.props['data-skill-remove'] === 'hidden-one')
		const confirm = await act(harness, element.type, element.props, () => row.props.onClick())
		// 删除确认走**通用确认浮窗**（设计 6.2）：`data-confirm-dialog` 上标它属于哪一处。
		const removeDialog = nodes(confirm).find((node) => node.props['data-confirm-dialog'] === 'skills-remove')
		assert.ok(removeDialog !== undefined, '删除确认要开')
		assert.ok(textOf(removeDialog).includes('hidden-one'), '确认块里点名删哪一个')
		assert.ok(textOf(removeDialog).includes('不可撤销'), '说清不可撤销（设计 8.2 的最终措辞）')
		assert.equal(buttonWith(removeDialog, '删除技能') !== undefined, true, '主按钮动词化：删除技能')
	} finally {
		fetchStub.restore()
	}
})

test('专属技能那一格是多选：真实载入的在列，**已声明但本机没有的仍列出并标「(本机没有)」**', async () => {
	// HD-007：那一格从自由文本改成"从技能里多选"。两个判据：
	//   ① 可选项来自**当前能真实载入的技能**（载荷 `skillOptions`，会话作用域 —— 与「技能」块同一处读法）；
	//   ② **这个角色已声明、但本机此刻载不到**的名字仍然列出来、标上「(本机没有)」——
	//      技能目录**按会话漂移**（本机这几轮就变过好几次），静默丢就是丢数据。
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices(), skills: fakeRegistry([]) }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	members.defaults = {
		available: true,
		excluded: ['ontology'],
		count: 1,
		established: true,
		rows: [
			{
				role: 'reviewer',
				title: '评审员',
				category: '质量',
				positioning: '对产物内部质量负责。',
				file: '/w/roles/reviewer/ROLE.md',
				origin: 'user',
				removal: 'delete',
				state: 'vacant',
				present: [],
				archived: [],
				retired: [],
				removed: [],
				nextName: 'reviewer-1',
				label: '未到场；可以叫一个：reviewer-1',
				skills: ['code-review', 'gone-in-this-session'],
			},
		],
	}
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// 角色目录已独立成一块 ⇒ 先切过去（默认落在成员块上）。
		const onRoles = await onRolesTab(harness, element, tree)
		// 载荷里那一格的可选项：`code-review` 在（fakeRegistry）、`gone-in-this-session` 不在
		assert.deepEqual(members.skillOptions.names, ['code-review', 'hidden-one'], '可选项来自会话作用域的技能目录：' + JSON.stringify(members.skillOptions))
		const section = nodes(onRoles).find((node) => node.props['data-roster-count'] !== undefined)
		const editButton = nodes(section).find((node) => node.props['data-roster-action'] === 'edit')
		const opened = await act(harness, element.type, element.props, () => editButton.props.onClick())
		const field = nodes(opened).find((node) => node.props['data-roster-field'] === 'skills')
		assert.ok(field !== undefined, '弹窗里要有「专属技能」那一格')
		assert.equal(field.type, 'div', '它是多选容器，不是单行输入')
		// **多选下拉**（人的追加要求）：收起时**不放**勾选框，只放摘要那一行；点开才展开选项。
		assert.equal(nodes(field).filter((node) => node.props['data-skill-choice'] !== undefined).length, 0, '收起时不该铺满选项')
		const summary = nodes(field).find((node) => node.props['data-skill-summary'] !== undefined)
		assert.ok(summary !== undefined, '收起时要有摘要那一行')
		assert.ok(textOf(summary).includes('code-review') && textOf(summary).includes('gone-in-this-session'), '**摘要里就要看得出选了哪些**：' + textOf(summary))
		const toggle = nodes(field).find((node) => node.props['data-skill-toggle'] !== undefined)
		assert.ok(toggle !== undefined, '要有展开那一枚按钮（真 button ⇒ 键盘可用）')
		const expanded = await act(harness, element.type, element.props, () => toggle.props.onClick())
		const expandedField = nodes(expanded).find((node) => node.props['data-roster-field'] === 'skills')
		const choices = nodes(expandedField).filter((node) => node.props['data-skill-choice'] !== undefined)
		const byName = (name) => choices.find((node) => node.props['data-skill-choice'] === name)
		// ① 真载入得到的：在列、且没有"(本机没有)"标记
		const present = byName('code-review')
		assert.ok(present !== undefined, '真实载入的技能要在列：' + choices.map((c) => c.props['data-skill-choice']).join('、'))
		assert.equal(present.props['data-skill-present'], 'true')
		assert.ok(!textOf(present).includes('本机没有'), '能载入的不许带缺失标记：' + textOf(present))
		// ② 已声明但本机没有的：**仍在列**，且标「(本机没有)」
		const missing = byName('gone-in-this-session')
		assert.ok(missing !== undefined, '已声明但本机没有的名字**不许被静默丢掉**')
		assert.equal(missing.props['data-skill-present'], 'false')
		assert.ok(textOf(missing).includes('（本机没有）'), '要标出"本机没有"：' + textOf(missing))
		// ③ 勾选状态与角色现值一致（两个都声明了 ⇒ 两个都勾上）
		for (const name of ['code-review', 'gone-in-this-session']) {
			const box = nodes(byName(name)).find((node) => node.type === 'input')
			assert.equal(box.props.checked, true, name + ' 是现值 ⇒ 要勾上')
		}
	} finally {
		fetchStub.restore()
	}
})

test('「修改」弹窗**四格都带现值**（人报的可用性缺陷：看不到现值等于不能用）+ 保存语义写准', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices(), skills: fakeRegistry([]) }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const CURRENT = { title: '客户支持', category: '客户', positioning: '对客户侧闭环负责：工单、FAQ、反馈回流。', skills: ['code-review'] }
	members.defaults = {
		available: true, excluded: ['ontology'], count: 1, established: true,
		// **样本必须是"预期值 ≠ 缺省值"的那种**（task-39 的反面例子）：这一条角色来自**用户根**，
		// 于是"作用域预选"的预期值是 `user`、而缺省是 `workspace` —— 实现被抽掉时它会红。
		// （第一版样本是 `origin: 'workspace'` ⇒ 预期值恰好等于缺省值 ⇒ 断言空转：把预选整段删掉也全绿。）
		rows: [
			{ role: 'cs', ...CURRENT, file: '/w/team-ops/roles/cs/ROLE.md', origin: 'user', originLabel: '用户级', removal: 'delete', state: 'vacant', present: [], archived: [], retired: [], removed: [], nextName: 'cs-1', label: '未到场' },
		],
	}
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// 角色目录已独立成一块 ⇒ 先切过去（默认落在成员块上）。
		const onRoles = await onRolesTab(harness, element, tree)
		const section = nodes(onRoles).find((node) => node.props['data-roster-count'] !== undefined)
		const editButton = nodes(section).find((node) => node.props['data-roster-action'] === 'edit')
		const opened = await act(harness, element.type, element.props, () => editButton.props.onClick())
		const valueOf = (field) => {
			const node = nodes(opened).find((item) => item.props['data-roster-field'] === field)
			assert.ok(node !== undefined, `弹窗里要有 ${field} 那一格`)
			return String(node.props.value)
		}
		// **判据：值等于这个角色的当前值**（不是只核占位文案）
		assert.equal(valueOf('title'), CURRENT.title, '显示名要带现值')
		assert.equal(valueOf('category'), CURRENT.category, '分类要带现值')
		assert.equal(valueOf('positioning'), CURRENT.positioning, '一句话定位要带现值')
		// 专属技能：摘要里看得出现在声明了哪些 + 展开后那几个是勾上的
		const skillsField = nodes(opened).find((item) => item.props['data-roster-field'] === 'skills')
		const summary = nodes(skillsField).find((item) => item.props['data-skill-summary'] !== undefined)
		assert.ok(textOf(summary).includes('code-review'), '技能摘要要写出**现在声明**的那几个：' + textOf(summary))
		const toggle = nodes(skillsField).find((item) => item.props['data-skill-toggle'] !== undefined)
		const expanded = await act(harness, element.type, element.props, () => toggle.props.onClick())
		const box = nodes(expanded).find((item) => item.props['data-skill-option'] === 'code-review')
		assert.equal(box.props.checked, true, '现值那个技能要勾上')
		// **可清空**（人的追加要求）：点「清空」⇒ 摘要变成"未选"，且 `skills` 那格归空（= 清掉那一行）
		const clearButton = nodes(expanded).find((item) => item.props['data-skill-clear'] !== undefined)
		assert.ok(clearButton !== undefined, '选了东西时要给「清空」那一枚')
		const cleared = await act(harness, element.type, element.props, () => clearButton.props.onClick())
		const clearedSummary = nodes(cleared).find((item) => item.props['data-skill-summary'] !== undefined)
		assert.ok(textOf(clearedSummary).includes('未选'), '清空之后摘要要说"未选"：' + textOf(clearedSummary))
		// **作用域那一格按来源预选** —— 判据必须是"预期值 ≠ 缺省值"，否则是空转：
		// 这个角色在**用户根**（`origin: 'user'`）⇒ 档位必须是 `user`；如果实现退化成永远给 `workspace`（缺省），这条就红。
		assert.equal(valueOf('scope'), 'user', '编辑用户根角色 ⇒ 作用域那格必须是 user（不是缺省 workspace）：' + valueOf('scope'))
		assert.notEqual(valueOf('scope'), 'workspace', '**不许**退化成缺省值（那样本条就成了空转断言）')
		// **占位语与保存语义一致**：不再说"留空＝不改"（那在这种语义下不成立）
		const placeholders = nodes(opened).filter((item) => item.props['data-roster-field'] !== undefined && typeof item.props.placeholder === 'string').map((item) => item.props.placeholder)
		assert.ok(placeholders.every((text) => !text.includes('留空＝不改')), '编辑弹窗不许再写"留空＝不改"：' + JSON.stringify(placeholders))
		assert.ok(placeholders.some((text) => text.includes('空＝这一格不动')), '要写清准确语义（空＝这一格不动）：' + JSON.stringify(placeholders))
	} finally {
		fetchStub.restore()
	}
})

test('作用域预选（**正向对照**：工作区根 ⇒ workspace）—— 这一条单独**不判别**，配上面那条才成对', async () => {
	// **这一条是"正向对照"，它自己不判别**：预期值 `workspace` 恰好等于缺省 ⇒ 实现抽掉也照样过（task-39 抓到的空转）。
	// 真正判别的是上面那条（`origin: 'user'` ⇒ 必须 `user`）。两条一起看：预选既不"永远 user"也不"永远 workspace"。
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices(), skills: fakeRegistry([]) }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	members.defaults = {
		available: true, excluded: ['ontology'], count: 1, established: true,
		rows: [
			{ role: 'cs-proj', title: '项目侧支持', category: '客户', positioning: '只服务这个项目。', skills: [], file: '/w/.dsh/team-ops/roles/cs-proj/ROLE.md', origin: 'workspace', originLabel: '项目级', removal: 'delete', state: 'vacant', present: [], archived: [], retired: [], removed: [], nextName: 'cs-proj-1', label: '未到场' },
		],
	}
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// 角色目录已独立成一块 ⇒ 先切过去（默认落在成员块上）。
		const onRoles = await onRolesTab(harness, element, tree)
		const section = nodes(onRoles).find((node) => node.props['data-roster-count'] !== undefined)
		const editButton = nodes(section).find((node) => node.props['data-roster-action'] === 'edit')
		const opened = await act(harness, element.type, element.props, () => editButton.props.onClick())
		const scopeSelect = nodes(opened).find((item) => item.props['data-roster-field'] === 'scope')
		assert.equal(String(scopeSelect.props.value), 'workspace', '工作区根角色 ⇒ 档位 = 本工作区（正向对照）')
	} finally {
		fetchStub.restore()
	}
})

test('除成员页外，筛选行都是**下拉**：角色来源 / 技能级别（task-44）—— 技能阶段筛已按人的指令撤掉', async () => {
	// 人的口径（HD-009）：「没点名的界面别动；**成员页那一排用同级按钮，其它筛选行都退回下拉**。」
	// 成员那排是**唯一**的例外（人明确要的同级按钮）。
	// 技能另外一条人的口径：「『模型可调用』下拉选择栏这个不需要」⇒ 阶段筛整格撤掉，只留级别筛。
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	// 角色那一节要**两档以上**才画那格（只有一档时不画）⇒ 造三档
	members.defaults = {
		available: true, excluded: ['ontology'], count: 3, established: true,
		originFacets: [
			{ key: 'workspace', label: '项目级', count: 1 },
			{ key: 'user', label: '用户级', count: 1 },
			{ key: 'package', label: '包内', count: 1 },
		],
		rows: [
			{ role: 'probe-ws', title: '项目角色', category: '质量', positioning: '探针。', file: '/w/.dsh/team-ops/roles/probe-ws/ROLE.md', origin: 'workspace', originLabel: '项目级', removal: 'delete', state: 'vacant', present: [], archived: [], retired: [], removed: [], nextName: 'probe-ws-1', label: '未到场' },
			{ role: 'probe-user', title: '用户角色', category: '质量', positioning: '探针。', file: '/u/team-ops/roles/probe-user/ROLE.md', origin: 'user', originLabel: '用户级', removal: 'delete', state: 'vacant', present: [], archived: [], retired: [], removed: [], nextName: 'probe-user-1', label: '未到场' },
			{ role: 'reviewer', title: '评审员', category: '质量', positioning: '探针。', file: '/p/roles/reviewer/ROLE.md', origin: 'package', originLabel: '包内', removal: 'hide', state: 'vacant', present: [], archived: [], retired: [], removed: [], nextName: 'reviewer-1', label: '未到场' },
		],
		hiddenRows: [],
	}
	const skills = {
		ok: true, workspace, layer: 'session', complete: true, total: 2, warnings: [],
		facets: [{ key: 'project', label: '项目级', count: 1 }, { key: 'user', label: '用户级', count: 1 }],
		targets: [], targetDefault: 'project',
		skills: [
			{ name: 'a-project', description: 'd', whenToUse: '', source: 'project-dsh', provider: 'p', path: '/w/.dsh/skills/a/SKILL.md', level: 'project', levelLabel: '项目级', modelInvocable: true, userInvocable: false },
			{ name: 'b-user', description: 'd', whenToUse: '', source: 'user-dsh', provider: 'p', path: '/u/.dsh/skills/b/SKILL.md', level: 'user', levelLabel: '用户级', modelInvocable: true, userInvocable: true },
		],
	}
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// ① 角色块（先切过去）：来源筛是下拉
		const onRoles = await onRolesTab(harness, element, tree)
		const rosterSelect = nodes(onRoles).find((node) => node.props['data-roster-origin-facet'] !== undefined)
		assert.equal(rosterSelect.type, 'select', '角色来源筛是下拉')
		// ② 技能块：**只留「级别」一格下拉**；「模型可调用 / 人可调用」那一格阶段筛按人的指令撤掉
		const skillsTab = buttonWith(onRoles, '技能')
		const onSkills = await act(harness, element.type, element.props, () => skillsTab.props.onClick())
		assert.equal(nodes(onSkills).find((node) => node.props['data-skill-stage-facet'] !== undefined), undefined, '技能阶段筛（模型可调用 / 人可调用）不再有')
		const levelSelect = nodes(onSkills).find((node) => node.props['data-skill-level-facet'] !== undefined)
		assert.equal(levelSelect.type, 'select', '技能级别筛是下拉（0.12.5 已定，别碰）')
		assert.ok(!nodes(onSkills).some((node) => node.props['data-skills-facets'] !== undefined), '技能块不再有 chip 排')
		// ③ 级别筛生效：选「用户级」⇒ 只剩 b-user
		const userOption = nodes(levelSelect).filter((node) => node.type === 'option').find((node) => textOf(node).startsWith('用户级'))
		const filtered = await act(harness, element.type, element.props, () => levelSelect.props.onChange({ target: { value: userOption.props.value } }))
		assert.deepEqual(
			cardsOf(filtered, 'cbv-sk-card').map((card) => card.props['data-skill-name']),
			['b-user'],
			'级别筛生效：' + JSON.stringify(cardsOf(filtered, 'cbv-sk-card').map((card) => card.props['data-skill-name'])),
		)
	} finally {
		fetchStub.restore()
	}
})

test('成员筛选是**一排互斥**的同级按钮（task-43）：一个「全部」、点一档只看那一档、两档不能同时选中', async () => {
	// 人的口径：「应该是「全部」「协调者」「已停用」「无轮次」这四个**同级**按钮，不是你这样的。」
	// （task-42 交出去的是"档位一排 + 运行时一排"，两排各自带一个「全部」⇒ 读起来像 bug。）
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// ① 一排：`data-members-facet` 全在**同一个容器**里，且都是真 button
		const chips = nodes(tree).filter((node) => node.props['data-members-facet'] !== undefined)
		assert.ok(chips.length >= 4, '一排放完（全部 + 协调者 + 已停用 + 各运行时值）：' + JSON.stringify(chips.map((node) => node.props['data-members-facet'])))
		assert.ok(chips.every((node) => node.type === 'button'), '都是真 button（键盘可用）')
		const containers = new Set(nodes(tree).filter((node) => node.props['data-members-facets'] !== undefined).map((node) => node))
		assert.equal(containers.size, 1, '只有**一排**容器')
		assert.equal(nodes(tree).filter((node) => node.props['data-members-facets'] !== undefined).length, 1)
		// ② **「全部」只出现一次**（按 DOM 次数核）
		assert.equal(chips.filter((node) => textOf(node).startsWith('全部')).length, 1, '「全部」只能有一枚：' + JSON.stringify(chips.map((node) => textOf(node))))
		// ③ 点「无轮次」⇒ 只剩那 N 位（沿用载荷里的运行时值算）
		const idleChip = chips.find((node) => node.props['data-members-facet'] === 'runtime:inactive')
		const afterIdle = await act(harness, element.type, element.props, () => idleChip.props.onClick())
		const idleCards = cardsOf(afterIdle, 'cbv-mp-card').map((card) => card.props['data-mem-name'])
		assert.deepEqual(idleCards, ['revi-1'], '点「无轮次」只剩那一位（集合与从前一致）：' + JSON.stringify(idleCards))
		// ④ **两档不能同时选中**：这时「无轮次」是 on、「协调者」不是
		const pressed = (tree_, key) => nodes(tree_).find((node) => node.props['data-members-facet'] === key).props['aria-pressed']
		assert.equal(pressed(afterIdle, 'runtime:inactive'), 'true', '选中的那枚标出来')
		assert.equal(pressed(afterIdle, 'lead'), 'false', '另一档**不许**同时选中（互斥）')
		// ⑤ 再点「已停用」⇒ 只剩停用者，且「无轮次」自动松开（单选）
		const stoppedChip = nodes(afterIdle).find((node) => node.props['data-members-facet'] === 'disabled')
		const afterStopped = await act(harness, element.type, element.props, () => stoppedChip.props.onClick())
		assert.equal(pressed(afterStopped, 'disabled'), 'true')
		assert.equal(pressed(afterStopped, 'runtime:inactive'), 'false', '单选：换一档，前一档自动松开')
	} finally {
		fetchStub.restore()
	}
})

test('现场那条：本插件没建过成员，原生名册里的 agent 照样列出来（只读：没有编辑 / 删除）', async () => {
	// 现场就是这样：会话里跑的是原生 Agent Teams 的队友，没人用过 `member_spawn`。
	// （task-40 起"在册 / 未入册"那一对随旧账撤了 —— 那两档的判据是旧名册文件里有没有行。）
	const workspace = mkdtempSync(join(tmpdir(), 'team-ops-members-teamonly-'))
	mkdirSync(join(workspace, '.ops'), { recursive: true })
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// 原生名册那两位都在（协调者 + 队友），一位都不许因为"本插件没建过"而消失
		assert.deepEqual(cardsOf(tree, 'cbv-mp-card').map((card) => card.props['data-mem-name']), ['lead', 'revi-1'])
		// 只读面：编辑 / 删除 一个都没有；三个动词由载荷给（停用/恢复一律画，打断按 ok）
		const teammate = cardsOf(tree, 'cbv-mp-card').find((card) => card.props['data-mem-kind'] === 'teammate')
		assert.equal(buttonWith(teammate, '编辑'), undefined, '没有「编辑」')
		assert.equal(buttonWith(teammate, '删除'), undefined, '没有「删除」')
		assert.ok(nodes(teammate).some((node) => node.props['data-member-verb'] === 'disable'), '队友卡上有「停用」')
		// **一排放完**（task-43）：全部 / 协调者 / 已停用 / 各运行时值；旧账那两档不许回来
		// 这一份桩件里两位成员：协调者 `running`、队友 `inactive` ⇒ 运行时的两档都在
		assert.deepEqual(
			nodes(tree).filter((node) => node.props['data-members-facet'] !== undefined).map((node) => node.props['data-members-facet']).sort(),
			['all', 'lead', 'disabled', 'runtime:running', 'runtime:inactive'].sort(),
			'一排档 = 全部 / 协调者 / 已停用 / 各运行时值',
		)
		assert.ok(!textOf(tree).includes('在册') || !nodes(tree).some((node) => node.props['data-members-facet'] !== undefined && textOf(node).includes('在册')), '「在册」不许回来')
	} finally {
		fetchStub.restore()
	}
})

test('团队任务板**可用但为空**时要说明一句（三栏空白不等于没有数据）', async () => {
	// 现场问过："团队状态 - 任务看板 - 团队任务看板为什么没有数据"。这一档读的是**本会话**的原生任务板，
	// 会话里没建过原生任务它就是空的 —— 那时屏幕上只有三栏空白，读者分不清"没任务"还是"读不到"。
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx({}))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const teamTasks = { ok: true, available: true, reason: null, total: 0, counts: { pending: 0, in_progress: 0, completed: 0 }, warnings: [], rows: [] }
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, teamTasks })
	try {
		const tab = buttonWith(tree, '任务看板')
		const onBoard = await act(harness, element.type, element.props, () => tab.props.onClick())
		// 只有一档了（任务在原生那一本账上），所以不再有"来源 chip"：直接看板正文。
		const text = textOf(onBoard)
		assert.ok(text.includes('本会话还没有原生任务'), '空的时候要说清是"没任务"而不是"读不到"：' + text.slice(0, 200))
		assert.equal(nodes(onBoard).filter((node) => node.props !== undefined && node.props['data-team-board'] === 'true').length, 0, '空的时候不画三栏空白')
		// **那句话只描述这一档**：从前它还写着"本插件的看板在「里程碑」那一档"，而面板上没有那一档 ——
		// 按那句话去找一个不存在的档，人就会认为"面板说的和它有的事不是一回事"。
		assert.ok(!text.includes('里程碑'), '空态不许把人指向一个已不存在的档：' + text.slice(0, 200))
	} finally {
		fetchStub.restore()
	}
})

test('任务看板：只有原生那一档（本插件看板已不再写入 ⇒ 界面上不再有来源分档）', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	// 本插件看板**是空的**（现场就是这样：活登记在原生那本账上），团队任务有三条、三栏各一条。
	const board = { ok: true, file: join(workspace, '.ops/board.json'), items: [], counts: { 待办: 0 }, warnings: [], annotations: [], markdown: '' }
	const teamTasks = {
		ok: true,
		available: true,
		reason: null,
		total: 3,
		counts: { pending: 1, in_progress: 1, completed: 1 },
		warnings: [],
		rows: [
			{ id: 'T-1', revision: 1, subject: '改 A', description: '把 A 改掉', status: 'pending', ownerName: '', ready: true, blockedBy: [], writeScopes: ['src/a'], writeScopeWarnings: [] },
			{ id: 'T-2', revision: 3, subject: '改 B', description: '', status: 'in_progress', ownerName: 'revi-1', ready: false, blockedBy: ['T-1'], writeScopes: [], writeScopeWarnings: ['write scopes overlap with T-1'] },
			{ id: 'T-3', revision: 2, subject: '改 C', description: '', status: 'completed', ownerName: 'lead', ready: false, blockedBy: [], writeScopes: [], writeScopeWarnings: [] },
		],
	}
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, board, teamTasks })
	try {
		const tab = buttonWith(tree, '任务看板')
		assert.ok(tab !== undefined, '块表里有「任务看板」')
		const onBoard = await act(harness, element.type, element.props, () => tab.props.onClick())
		// **只有一档了**：任务与成员都在 DSH 原生 Agent Teams 里，本插件那份看板文件不再写入 ⇒
		// 界面上不再有"来源分档"这件事（从前那两枚 chip 与里程碑视图已随功能删掉）。
		const boardRoot = nodes(onBoard).find((node) => node.props['data-board-picked'] !== undefined)
		assert.ok(boardRoot !== undefined, '看板块的根节点在')
		assert.equal(boardRoot.props['data-board-picked'], 'team', '只落在原生那一档')
		assert.ok(!textOf(onBoard).includes('里程碑 0'), '不许再出现那枚已停用的来源按钮：' + textOf(onBoard).slice(0, 120))
		// 汇总数字不上屏（完成看分栏即可）；交接/冲突改在卡片上打标签。
		assert.equal(nodes(onBoard).find((node) => node.props['data-collab-line'] !== undefined), undefined, '不再有独立的汇总行')
		const cardsWithTags = nodes(onBoard).filter((node) => node.props['data-tt-id'] !== undefined)
		assert.ok(textOf(cardsWithTags[0]).includes('T-1'), '卡片显示任务编号')
		assert.ok(textOf(cardsWithTags[1]).includes('revi-1'), '卡片显示处理成员')
		const handoffTag = nodes(onBoard).find((node) => node.props['data-tt-handoff'] !== undefined)
		assert.ok(handoffTag !== undefined, 'T-2 卡片上有交接标签')
		assert.ok(textOf(handoffTag.children).includes('qa → reviewer'), '标签写明谁交接给谁：' + textOf(handoffTag.children))
		const conflictTag = nodes(onBoard).find((node) => node.props['data-tt-conflict'] !== undefined)
		assert.ok(conflictTag !== undefined, '冲突任务编号要在卡片上')
		assert.equal(conflictTag.props['data-tt-conflict'], 'T-1', '冲突编号取自写盘面重叠告警原文')
		// 负责人与锁定状态：每张卡都要标，已分配的是「已锁定」，未指派的是「未锁定」。
		const lockTags = nodes(onBoard).filter((node) => node.props['data-tt-locked'] !== undefined)
		assert.equal(lockTags.length, 3, '每张卡都显示锁定状态')
		assert.ok(lockTags.some((node) => node.props['data-tt-locked'] === 'true'), 'T-2 已锁定')
		assert.ok(lockTags.some((node) => node.props['data-tt-locked'] === 'false'), 'T-1 未锁定')
		assert.ok(textOf(cardsWithTags[1]).includes('负责人 revi-1'), '卡片写明处理成员：' + textOf(cardsWithTags[1]).slice(0, 120))
		// **看板块不再印内页标题**（人的指令：tab 栏上已经有「任务看板」了）
		const boardHead = nodes(onBoard).find((node) => node.type === 'div' && typeof node.props.className === 'string' && node.props.className.includes('cbv-view-head') && textOf(node.children).includes('任务看板'))
		assert.equal(boardHead, undefined, '看板块不再有内页标题')
		const boardPane = nodes(onBoard).find((node) => node.props['data-board-picked'] !== undefined)
		assert.ok(!textOf(boardPane).includes('任务看板'), '看板正文里不再重复这一块的名字：' + textOf(boardPane).slice(0, 120))
		// 不再有来源 chip（只有一档），但**三栏与三张卡**都要在：数据来自原生那一次取数。
		const sourceChips = nodes(onBoard).filter((node) => node.props['data-board-source'] !== undefined)
		assert.deepEqual(sourceChips.map((node) => node.props['data-board-source']), [], '来源分档那几枚 chip 已撤')
		assert.ok(textOf(onBoard).includes('改 A') && textOf(onBoard).includes('改 C'), '原生任务要画出来：' + textOf(onBoard).slice(0, 160))
		// 原生的三栏，卡上只有原生给的字段（编号 / 主题 / 归属 / 版本 / 依赖 / 写盘面）。
		assert.deepEqual(
			nodes(onBoard).filter((node) => node.props['data-tt-col'] !== undefined).map((node) => node.props['data-tt-col']),
			['pending', 'in_progress', 'completed'],
		)
		const cards = nodes(onBoard).filter((node) => node.props['data-tt-id'] !== undefined)
		assert.deepEqual(cards.map((card) => card.props['data-tt-id']), ['T-1', 'T-2', 'T-3'])
		assert.equal(cards[0].props['data-tt-ready'], 'true')
		assert.equal(cards[1].props['data-tt-owner'], 'revi-1')
		assert.ok(textOf(cards[0]).includes('可认领'), 'ready 照原生的字段印')
		assert.ok(!textOf(cards[1]).includes('依赖 T-1'), '折叠卡不摊依赖（点开浮窗才有）')
		assert.ok(!textOf(cards[0]).includes('写盘面 src/a'), '折叠卡不摊写盘面')
		assert.ok(!textOf(onBoard).includes('write scopes overlap with T-1'), '折叠卡不摊告警原文')
		// **看板底部那一整行撤了**（人的指令：不要显示）：键位提示只在浮窗里（下面那条用例验）；
		// 块头那句「本会话 · 只读」也按人的指令撤掉（这一栏本来就没有写动作）。
		assert.ok(!textOf(onBoard).includes('点卡片看'), '底部那句整行撤了')
		assert.ok(!textOf(onBoard).includes('切换分栏'), '看板底部不写键位')
		assert.ok(!textOf(onBoard).includes('本会话 · 只读'), '块头那句注解不再展示')
		assert.ok(!textOf(onBoard).includes('team_task_*'), '不再用一整行讲工具名叫什么')

		// 从前这里还验"点「里程碑」切成按 phase 分栏那一份" —— 那一档已随本插件看板文件一起删掉，
		// 界面上只剩原生这一档（它没有可切的第二档，也就不存在"切走之后"）。
	} finally {
		fetchStub.restore()
	}
})

test('成员块只谈成员：卡上的「最近交接」按角色 id 匹配；团队级那行「交接：…」不在这里', async () => {
	// 现场（本轮复核发现）：这段 effect 曾被写进上一个 effect 回调的 `return` 之后 —— 成了死代码，
	// 于是成员卡上的「最近交接」行**永远不出现**，而当时没有任何用例覆盖它。
	// 人的判断（之后）：交接是**团队级**读数，归「任务看板」顶部那行 + 展开明细；成员块只谈成员
	// —— 所以块顶部那行「交接：最近三条」已撤，卡上这一行留（它是"这一位的收发"）。
	// `to` 写的是**角色 id**（`reviewer`），成员名是 `reviewer-1` ⇒ 接收方必须按 `row.roleId` 比。
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	// 真成员名照约定（`<角色 id>-<序号>`）：`revi-1` 这种简称反读不出角色，正是"接收方永远匹配不上"的另一个成因。
	const rows = [TEAM_ROWS[0], { ...TEAM_ROWS[1], name: 'reviewer-1' }]
	const services = { sessions: { list }, ...teamServices(LEAD_AGENT, rows) }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, fetchStub } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// 团队级那一行**必须不在**（人的判断：它会把读者引去找一个不在场的角色）
		assert.equal(nodes(tree).find((node) => node.props['data-handoff-line'] !== undefined), undefined, '成员块不画团队级的「交接：…」')
		const card = cardsOf(tree, 'cbv-mp-card').find((node) => node.props['data-mem-name'] === 'reviewer-1')
		assert.ok(card !== undefined, 'reviewer-1 那张卡在')
		assert.ok(textOf(card.children).includes('最近交接'), '接收方那张卡要标最近交接（to=reviewer ⇒ roleId 匹配）：' + textOf(card.children))
		assert.ok(textOf(card.children).includes('qa → reviewer：测试报告'), '卡上那一行要写清谁给谁：' + textOf(card.children))
	} finally {
		fetchStub.restore()
	}
})

test('协作读数：任务那一半读不到时印"任务读数读不到"，不许印成"完成 0/0"', async () => {
	// 零是一个读数，读不到是另一件事（契约《缺件怎么办》第 1 条）。`/collab` 在没有活着的会话 Agent 时
	// 给的是 `tasks: null` + `tasksReason` —— 面板必须照着说"读不到"。
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const collab = {
		ok: true,
		metrics: { tasks: null, tasksReason: '会话 sess-1 现在不活着', handoffs: { total: 0, gaps: 0 }, conflicts: 0, packMissing: 0 },
		handoffs: [],
	}
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, collab })
	try {
		const tab = buttonWith(tree, '任务看板')
		const onBoard = await act(harness, element.type, element.props, () => tab.props.onClick())
		// 任务读数不上屏（不在面板上把「读不到」印成一个数）；卡片照常渲染。
		assert.equal(nodes(onBoard).find((node) => node.props['data-collab-line'] !== undefined), undefined, '没有汇总行')
		assert.ok(!textOf(onBoard).includes('完成 0/0'), '不许把读不到印成零')
		assert.ok(nodes(onBoard).filter((node) => node.props['data-board-picked'] !== undefined).length > 0, '看板照常渲染')
	} finally {
		fetchStub.restore()
	}
})

test('浮窗里的 Markdown 表格真渲染成表格（不是一串竖线）', async () => {
	// 现场：原生任务的描述里有 GFM 管道表格，浮窗里原来只当段落印 ⇒ 一片 `| a | b |`。
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const board = { ok: true, file: join(workspace, '.ops/board.json'), items: [], counts: { 待办: 0 }, warnings: [], annotations: [], markdown: '' }
	const table = ['结论 | 依据 | 风险', '--- | :---: | ---:', '成立 | RDF 1.2 可直接映射（**粗体**） | 低', '存疑 | `SPARQL 1.2` 未定稿 | 中']
	// 最后那行只有一个竖线、且下一行不是分隔行 ⇒ **不许**当表格（防误判）。
	const description = ['逐条给结论：', '', ...table, '', '这不是表格：甲 | 乙', '', '表格后还有一段普通文字。'].join('\n')
	const teamTasks = {
		ok: true,
		available: true,
		reason: null,
		total: 1,
		counts: { pending: 0, in_progress: 1, completed: 0 },
		warnings: [],
		rows: [{ id: 'T-7', revision: 1, subject: '评审结论', description, status: 'in_progress', ownerName: 'architect-1', ready: false, blockedBy: [], writeScopes: [], writeScopeWarnings: [] }],
	}
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, board, teamTasks })
	try {
		const tab = buttonWith(tree, '任务看板')
		const onBoard = await act(harness, element.type, element.props, () => tab.props.onClick())
		const card = nodes(onBoard).filter((node) => node.props['data-tt-id'] === 'T-7')[0]
		const opened = await act(harness, element.type, element.props, () => card.props.onClick())
		const dialog = nodes(opened).find((node) => node.props['data-tt-dialog'] !== undefined)
		const tables = nodes(dialog).filter((node) => node.type === 'table' && node.props.className === 'cbv-md-table')
		assert.equal(tables.length, 1, '描述里那张表要渲染成一个 table（实际 ' + tables.length + ' 个）')
		const table1 = tables[0]
		const headerCells = nodes(table1).filter((node) => node.type === 'th')
		assert.deepEqual(headerCells.map((cell) => textOf(cell)), ['结论', '依据', '风险'], '表头三格')
		const bodyCells = nodes(table1).filter((node) => node.type === 'td')
		assert.equal(bodyCells.length, 6, '两行数据 × 三列')
		assert.ok(textOf(table1).includes('RDF 1.2'), '单元格文本在')
		// 对齐：分隔行 `:---:` 居中、`---:` 右对齐（左对齐不加类）。
		assert.equal(headerCells[1].props.className, 'cbv-md-cell cbv-md-cell--center')
		assert.equal(headerCells[2].props.className, 'cbv-md-cell cbv-md-cell--right')
		assert.equal(headerCells[0].props.className, 'cbv-md-cell')
		// 行内语法在单元格里照旧生效（粗体 / 行内码都被拆成自己的元素）。
		const strong = nodes(table1).filter((node) => node.type === 'strong')
		assert.equal(strong.length, 1, '单元格里的 **粗体** 生效')
		// 表格前后那两段普通文字仍然是段落（别把整段都吞进表格）。
		const paras = nodes(dialog).filter((node) => node.type === 'p').map((node) => textOf(node))
		assert.ok(paras.some((line) => line.includes('表格后还有一段普通文字')), '表格后面的段落还在')
		assert.ok(paras.some((line) => line.includes('逐条给结论')), '表格前面那句还在')
		// 竖线只该出现在表格里：那段文字里不该再有裸的 `| a | b |`。
		assert.ok(!paras.some((line) => line.includes('--- | :---:')), '分隔行不该以段落形式出现')
		// 防误判：只有一行带竖线 ⇒ 仍是段落，不是表格。
		assert.ok(paras.some((line) => line.includes('这不是表格：甲 | 乙')), '单个竖线不构成表格：' + paras.join(' / '))
	} finally {
		fetchStub.restore()
	}
})

test('团队任务：`subject` 与 `description` 同一段时，卡与浮窗都只印一遍', async () => {
	// 现场那一张截图：浮窗里上下两块文本一模一样。根因是原生那边的两格同义
	// （`subject` 与 `description` 常常是同一段），而我们两块都印了。
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const board = { ok: true, file: join(workspace, '.ops/board.json'), items: [], counts: { 待办: 0 }, warnings: [], annotations: [], markdown: '' }
	const same = '评审域 A：本体与语义技术栈'
	const teamTasks = {
		ok: true,
		available: true,
		reason: null,
		total: 1,
		counts: { pending: 0, in_progress: 1, completed: 0 },
		warnings: [],
		rows: [{ id: 'T-9', revision: 3, subject: same, description: same, status: 'in_progress', ownerName: 'expert-ontology', ready: false, blockedBy: [], writeScopes: [], writeScopeWarnings: [] }],
	}
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, board, teamTasks })
	try {
		const tab = buttonWith(tree, '任务看板')
		const onBoard = await act(harness, element.type, element.props, () => tab.props.onClick())
		const card = nodes(onBoard).filter((node) => node.props['data-tt-id'] === 'T-9')[0]
		const dupCount = (haystack, needle) => haystack.split(needle).length - 1
		assert.equal(dupCount(textOf(card), same), 1, '卡上只印一遍：' + textOf(card).slice(0, 140))
		const opened = await act(harness, element.type, element.props, () => card.props.onClick())
		const dialog = nodes(opened).find((node) => node.props['data-tt-dialog'] !== undefined)
		assert.equal(dupCount(textOf(dialog), same), 1, '浮窗里也只印一遍（现场那块重复的就是这里）：' + textOf(dialog).slice(0, 160))
		// **浮窗里不许再印原生字段名 / 系统坐标**（task-56：人问"下面这些应该没必要写在详情里吧"）——
		// 卡上已经用中文各说了一次（在办 / owner chip / v<版本> / 可认领|等依赖 / 「依赖 …」/「写盘面 …」）。
		for (const raw of ['status：', 'revision：', 'ownerName：', 'ready：', 'blockedBy：', 'writeScopes：']) {
			assert.ok(!textOf(dialog).includes(raw), `浮窗里不许出现原生字段名：${raw}` + textOf(dialog).slice(0, 120))
		}
		// 卡上那些**中文事实**照旧在（去重去的是"第二遍的原生字段名"，不是事实本身）
		assert.ok(textOf(dialog).includes('expert-ontology'), 'owner 仍以 chip 说一次')
		assert.ok(textOf(dialog).includes('v3'), '版本号仍以 chip 说一次')
	} finally {
		fetchStub.restore()
	}
})

test('团队任务的详情：点卡片开浮窗（原生字段摊全）、栏内翻页、关闭', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const board = { ok: true, file: join(workspace, '.ops/board.json'), items: [], counts: { 待办: 0 }, warnings: [], annotations: [], markdown: '' }
	// 「进行中」那一栏放两条（才有的翻）：T-2 在前、T-4 在后。
	const teamTasks = {
		ok: true,
		available: true,
		reason: null,
		total: 2,
		counts: { pending: 0, in_progress: 2, completed: 0 },
		warnings: [],
		rows: [
			{ id: 'T-2', revision: 3, subject: '改 B', description: '把 B 改掉\n第二步是回归', status: 'in_progress', ownerName: 'revi-1', ready: false, blockedBy: ['T-1'], writeScopes: [], writeScopeWarnings: ['write scopes overlap with T-1'] },
			{ id: 'T-4', revision: 7, subject: '改 D', description: '', status: 'in_progress', ownerName: 'lead', ready: false, blockedBy: [], writeScopes: ['src/d'], writeScopeWarnings: [] },
		],
	}
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, board, teamTasks })
	try {
		const tab = buttonWith(tree, '任务看板')
		const onBoard = await act(harness, element.type, element.props, () => tab.props.onClick())
		const cards = nodes(onBoard).filter((node) => node.props['data-tt-id'] !== undefined)
		assert.deepEqual(cards.map((card) => card.props['data-tt-id']), ['T-2', 'T-4'])
		// 「详情」那句**去掉了**（人的指令）：整卡可点、光标已是手型，39 张卡每张印一遍等于没有信息。
		assert.ok(!textOf(cards[0]).includes('详情'), '卡顶不该再有"详情"两个字')
		assert.equal(cards[0].props.role, 'button', '能不能点，由 role 与键盘路径说（不是靠卡上那句字）')

		// 点卡片 ⇒ 开浮窗：正文是那张卡**摊开**的形态（原生那几个字段全在，原文照印）。
		const opened = await act(harness, element.type, element.props, () => cards[0].props.onClick())
		const dialog = nodes(opened).find((node) => node.props['data-tt-dialog'] !== undefined)
		assert.ok(dialog !== undefined, '浮窗要开')
		assert.equal(dialog.props['data-tt-dialog'], 'T-2')
		assert.equal(dialog.props.role, 'dialog')
		const inDialog = textOf(dialog)
		assert.ok(inDialog.includes('第 1 条'), '标题给栏内第几条：' + inDialog.slice(0, 80))
		// **键位提示写在浮窗里**（它只在这儿生效）。
		assert.ok(inDialog.includes('切换分栏'), '浮窗里给出 ← → 的作用')
		assert.ok(inDialog.includes('Esc'), '也说清 Esc 关')
		// **原生字段名一个都不印**（status / revision / ownerName / ready / blockedBy / writeScopes）——
		// 它们在卡上已经是中文事实（`在办` / `v3` / `revi-1` chip / `等依赖` chip /「依赖 T-1」/「写盘面 …」）。
		for (const raw of ['status：', 'revision：', 'ownerName：', 'ready：', 'blockedBy：', 'writeScopes：']) {
			assert.ok(!inDialog.includes(raw), `浮窗里不许出现原生字段名：${raw}` + inDialog.slice(0, 120))
		}
		// **「依赖」这一事实在整份详情里按 DOM 只说一次**（人问"一模一样的记录要写两次"就是它）
		const blockedCount = inDialog.split('依赖').length - 1
		assert.equal(blockedCount, 1, '「依赖」只出现一次（卡上那句），实际 ' + blockedCount + ' 次：' + inDialog.slice(0, 160))
		assert.ok(inDialog.includes('依赖 T-1'), '中文那句要在（不能因为去重把事实也去没了）')
		assert.ok(inDialog.includes('v3'), '版本号以 chip 形态说一次')
		// **原生原文的告警照旧逐条摊开**（那不是系统坐标，是原生给的话）
		assert.ok(inDialog.includes('write scopes overlap with T-1'), '写盘面重叠告警**逐条**摊开')
		// **描述只该出现一次**（现场：卡上那行 + 浮窗里那块，一模一样）—— 浮窗里以块的形式出现。
		const occurrences = (haystack, needle) => haystack.split(needle).length - 1
		assert.equal(occurrences(inDialog, '把 B 改掉'), 1, 'description 在浮窗里只该印一遍（块那一份）：' + inDialog.slice(0, 160))
		assert.equal(occurrences(inDialog, '第二步是回归'), 1, '多行描述也只印一遍')
		// **同一段文字不印两遍**（现场：浮窗里上下两块一模一样 —— 原生那边 `subject` 与 `description`
		// 常常是同一段）。这一段只在"两者不同"时才出现在浮窗里。
		const dupCount = (haystack, needle) => haystack.split(needle).length - 1
		assert.equal(dupCount(inDialog, '改 B'), 1, 'subject「改 B」只该出现一次：' + inDialog.slice(0, 120))
		assert.equal(buttonWith(dialog, '上一条').props.disabled, true, '栏内第一条：上一条不可点')
		assert.equal(buttonWith(dialog, '下一条').props.disabled, false)

		// 栏内翻页：下一条 ⇒ T-4（跨栏不翻）。
		const next = await act(harness, element.type, element.props, () => buttonWith(dialog, '下一条').props.onClick())
		const dialog2 = nodes(next).find((node) => node.props['data-tt-dialog'] !== undefined)
		assert.equal(dialog2.props['data-tt-dialog'], 'T-4')
		assert.ok(textOf(dialog2).includes('第 2 条'))
		assert.equal(buttonWith(dialog2, '下一条').props.disabled, true, '栏内最后一条：下一条不可点')
		assert.equal(buttonWith(dialog2, '上一条').props.disabled, false)

		// **← → 是"切换分栏"**（人的指令）：这一档只有一栏有活（in_progress 两条），
		// 所以按 → 往右找不到非空栏 ⇒ **原地不动**（到底了不绕回去）；这也顺带说明它不再栏内翻页。
		const kb = fakeKeyboard()
		const savedDocument = globalThis.document
		globalThis.document = kb.doc
		const reopened = await act(harness, element.type, element.props, () => cards[0].props.onClick())
		assert.ok(nodes(reopened).some((node) => node.props['data-tt-dialog'] === 'T-2'), '重新打开 T-2')
		// **↑ ↓ 才是本栏内翻页**（人的指定）：T-2 按 ↓ ⇒ T-4（同一栏第 2 条）。
		kb.press('ArrowDown')
		const down = await settle(harness, element.type, element.props)
		assert.equal(nodes(down).find((node) => node.props['data-tt-dialog'] !== undefined).props['data-tt-dialog'], 'T-4', '↓ = 栏内下一条')
		assert.ok(textOf(nodes(down).find((node) => node.props['data-tt-dialog'] !== undefined)).includes('第 2 条'))
		kb.press('ArrowUp')
		const up = await settle(harness, element.type, element.props)
		assert.equal(nodes(up).find((node) => node.props['data-tt-dialog'] !== undefined).props['data-tt-dialog'], 'T-2', '↑ = 栏内上一条')
		// 回到 T-2 再验 ← →：左右都没有非空栏 ⇒ 原地不动（说明它不是栏内翻页）。
		kb.press('ArrowRight')
		const stillRight = await settle(harness, element.type, element.props)
		assert.equal(nodes(stillRight).find((node) => node.props['data-tt-dialog'] !== undefined).props['data-tt-dialog'], 'T-2', '右边没有非空栏 ⇒ 原地不动（不栏内翻）')
		kb.press('ArrowLeft')
		const stillLeft = await settle(harness, element.type, element.props)
		assert.equal(nodes(stillLeft).find((node) => node.props['data-tt-dialog'] !== undefined).props['data-tt-dialog'], 'T-2', '左边也没有 ⇒ 原地不动')
		globalThis.document = savedDocument

		// 关闭：浮窗没了。
		const closed = await act(harness, element.type, element.props, () => buttonWith(dialog2, '关闭').props.onClick())
		assert.equal(nodes(closed).find((node) => node.props['data-tt-dialog'] !== undefined), undefined, '关掉之后浮窗不在')
		assert.equal(nodes(closed).filter((node) => node.props['data-tt-id'] !== undefined).length, 2, '卡片都还在')
	} finally {
		fetchStub.restore()
	}
})

test('「角色」块（独立 tab）：清单 + 状态 + 动作（面板只读，不建成员）', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	// 技能注册表也喂进来：**「专属技能」那一格的可选项**（载荷 `skillOptions`）就是从这里读的
	// —— 不喂它这一格就没有候选（面板会如实说"读不到目录"，不编）。
	const services = { sessions: { list }, ...teamServices(), skills: fakeRegistry([]) }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	// 载荷自带的清单（真端点算的）：这里换成一个可断言的小清单，验的是**渲染**而不是端点的判定。
	members.defaults = {
		available: true,
		excluded: ['ontology'],
		count: 3,
		established: true,
		rows: [
			{ role: 'reviewer', title: '评审员', category: '质量', positioning: '对产物内部质量负责：独立评审与门禁判定。', file: '/w/roles/reviewer/ROLE.md', origin: 'package', removal: 'hide', state: 'present', present: ['reviewer-1'], archived: [], retired: [], removed: [], nextName: 'reviewer-2', label: '在场 1：reviewer-1（下一个可用的名字：reviewer-2）' },
			{ role: 'qa', title: '测试', category: '质量', positioning: '对可测性与出口准则负责。', file: '/w/roles/qa/ROLE.md', origin: 'user', removal: 'delete', state: 'retired', present: [], archived: [], retired: ['qa-1'], removed: [], nextName: 'qa-2', label: '退役 1（名字占位）：qa-1（下一个可用的名字：qa-2）' },
			{ role: 'po', title: '产品', category: '产品', positioning: '对优先级与需求边界负责。', file: '/w/roles/po/ROLE.md', origin: 'user', removal: 'revert', state: 'vacant', present: [], archived: [], retired: [], removed: [], nextName: 'po-1', label: '未到场；可以叫一个：po-1' },
		],
	}
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const mounted = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	const { fetchStub, harness, element } = mounted
	try {
		// **角色目录现在独立成一块**（人的指令）：默认落的还是成员块 ⇒ 先点「角色」那一枚。
		const tree = await onRolesTab(harness, element, mounted.tree)
		const section = nodes(tree).find((node) => node.props['data-roster-count'] !== undefined)
		assert.ok(section !== undefined, '「角色」块里要有角色目录')
		assert.equal(section.props['data-roster-count'], '3')
		assert.equal(section.props['data-roster-established'], 'true')
		const cards = nodes(section).filter((node) => node.props['data-roster-role'] !== undefined)
		assert.deepEqual(cards.map((card) => card.props['data-roster-role']), ['reviewer', 'qa', 'po'])
		assert.deepEqual(cards.map((card) => card.props['data-roster-state']), ['present', 'retired', 'vacant'])
		assert.deepEqual(cards.map((card) => card.props['data-roster-next']), ['reviewer-2', 'qa-2', 'po-1'])
		// 每条只给定位 + 状态那句话；没到场/删过的多给一行叫法（怎么叫、名字会取哪个）。
		assert.ok(textOf(cards[0]).includes('对产物内部质量负责'))
		// 状态行**只在真有人的那一档印**（谁在场）；空档（未到场）一个字都不印 —— 那一节收尾写着
		// "卡上没有状态行的就是未到场"，20 张卡里 18 张不用各印一遍「未到场」。
		assert.ok(textOf(cards[0]).includes('在场 1：reviewer-1'))
		assert.ok(textOf(cards[1]).includes('退役 1（名字占位）：qa-1'), '退役那一档照给名字')
		// 未到场那张：卡上照样有头像 / id / 显示名 / 定位 / 两个动作，**但没有那一行状态**
		// （`.cbv-sub` 就那一行；空档不印它）。
		assert.equal(nodes(cards[2]).filter((node) => hasClass(node, 'cbv-sub')).length, 0, '未到场那张卡上不印状态行')
		assert.ok(textOf(cards[2]).includes('对优先级与需求边界负责。'), '定位句照印')
		// **这一节不再印"怎么叫人"**（人的指令：描述性文字太多）：卡上不印、块尾也不印 ——
		// 叫法在头上那个 `叫人开干` 里（这一节只回答"现在能叫谁、谁已经在了"）。
		assert.ok(cards.every((card) => !textOf(card).includes('member_spawn')), '不在每张卡上重复叫法')
		assert.ok(!textOf(section).includes('member_spawn'), '块尾也不再教一遍')
		assert.ok(!textOf(section).includes('卡上没有状态行的就是'), '那句解释也撤了')
		assert.ok(!textOf(section).includes('每条只给一句话定位'), '那句注解也撤了')
		assert.ok(!textOf(section).includes('未到场 3'), '计数只留"共几个"，不再汇总四档状态')
		// 每条都有一个**头像框**（与成员卡同一套 `.cbv-mp-avatar` + 引擎给的色调档）：
		// 没有它这一栏看着像设置项，不像"可叫的人"。
		const avatars = nodes(section).filter((node) => node.props['data-roster-avatar'] !== undefined)
		assert.deepEqual(avatars.map((node) => node.props['data-roster-avatar']), ['reviewer', 'qa', 'po'])
		assert.ok(avatars.every((node) => hasClass(node, 'cbv-mp-avatar')), '头像框那一格要用成员卡同款样式')
		assert.equal(avatars[0].props.className, 'cbv-mp-avatar cbv-mp-avatar--exec', '底色用引擎给的色调档')
		// **一块一个滚动区**：角色目录在它自己那一块的滚动区里（成员卡不再和它挤同一个）。
		// 保活渲染下成员块仍挂载着（`hidden`）⇒ 滚动区只在**角色这一块**里数。
		const rolesPanel = nodes(tree).find((node) => node.props['data-panel-block'] === 'roles')
		assert.ok(rolesPanel !== undefined, '角色面板要在')
		const scroll = nodes(rolesPanel).find((node) => hasClass(node, 'cbv-scroll'))
		assert.ok(scroll !== undefined, '角色块要有滚动区')
		const insideScroll = nodes(scroll).map((node) => node.props.className)
		assert.ok(insideScroll.includes('cbv-roster'), '角色目录在滚动区里')
		assert.ok(!insideScroll.includes('cbv-mp-grid'), '成员卡区不在这块里（已经拆开了）')
		assert.equal(nodes(rolesPanel).filter((node) => hasClass(node, 'cbv-scroll')).length, 1, '这块只有一个滚动区（四块共用同一个类）')
		// 标题就叫「角色」（人的指令：原来那个「可叫的角色」念着绕）。
		assert.ok(textOf(section).includes('角色'), '这一节的标题是「角色」')
		assert.ok(!textOf(section).includes('可叫的角色'), '旧名不再出现')
		// **这一节不再印任何汇总读数**（人的指令升级过一次：面板上的统计性描述都去掉）——
		// 上面那排筛选 chip 写着真数，状态在每张卡上；要机器核对看 `data-roster-count` 属性。
		assert.ok(!textOf(section).includes('未到场 1 · 在场 1'), '不汇总四档状态')
		assert.ok(!/\b3 个\b/.test(textOf(section)), '也不印"共几个"：' + textOf(section).slice(0, 120))
		// 那个计数格连同它的样式一起撤了：这四个块的头里都只剩标题（+ 一句注解）
		assert.ok(!/cbv-pane-counts/.test(readFileSync('lib/board-view.client.js', 'utf8')), '块头计数那个类不再存在（连同样式）')
		const sectionRoot = nodes(section).find((node) => node.props['data-roster-count'] !== undefined)
		assert.ok(sectionRoot !== undefined && sectionRoot.props['data-roster-count'] === '3', '数要留在数据属性上（现场核核对用）')
		// **这一节是可写的**（人的指令：角色可删除、可修改、可添加）：
		// 每张卡两个动作（修改 / 删或下架），另有一个添加入口 —— 动作**都落在角色定义文件上**，
		// 落点由载荷的 `origin` / `removal` 决定（客户端不许自己猜）。
		const actions = nodes(section).filter((node) => node.props['data-roster-action'] !== undefined).map((node) => node.props['data-roster-action'])
		assert.equal(actions.filter((name) => name === 'edit').length, 3, '每张卡一个「修改」')
		assert.equal(actions.filter((name) => name === 'remove').length, 3, '每张卡一个「删/下架」')
		assert.equal(actions.filter((name) => name === 'add').length, 1, '一个「＋ 添加角色」入口')
		const removes = nodes(section).filter((node) => node.props['data-roster-removal'] !== undefined)
		// **动词按出处说准**（`removal` 由服务端算，客户端照印）：
		// 包内角色只能"下架"（发布面）、用户根自己加的能"删除"、用户根那份在覆盖包内同名的叫"还原为包内"。
		assert.deepEqual(removes.map((node) => node.props['data-roster-removal']), ['hide', 'delete', 'revert'])
		assert.deepEqual(removes.map((node) => textOf(node)), ['下架', '删除', '还原为包内'])
		// **这一节不再有"叫人"入口**（人的更正：那一枚按钮在**输入框工具行**里，不在这里 ——
		// 见下一个用例：「输入框工具行那一席」）。卡上也不再逐张印叫法（原来每张都写着 `member_spawn role=<id>`）。
		assert.ok(!textOf(section).includes('member_spawn role=reviewer'), '在场的那张不印叫法')
		assert.equal(
			nodes(section).filter((node) => node.props['data-roster-action'] === 'spawn').length,
			0,
			'「角色」块里不该有叫人入口',
		)

		// 点「＋ 添加角色」⇒ 开弹窗（id / 显示名 / 分类 / 定位 / 可选正文），提交落在 `/roles/update`。
		const addButton = nodes(section).find((node) => node.props['data-roster-action'] === 'add')
		const opened = await act(harness, element.type, element.props, () => addButton.props.onClick())
		const dialog = nodes(opened).find((node) => node.props['data-roster-submit'] !== undefined)
		assert.ok(dialog !== undefined, '添加弹窗要开')
		assert.equal(dialog.props['data-roster-submit'], 'create')
		const fields = nodes(opened).filter((node) => node.props['data-roster-field'] !== undefined).map((node) => node.props['data-roster-field'])
		// 七格：id / 显示名 / **作用域** / 分类 / **专属技能** / 一句话定位 / 补充正文。
		// 「作用域」是 HD-008 之后补的（缺省"本工作区"）；专属技能那一格是上一轮补的。
		assert.deepEqual(fields, ['id', 'title', 'scope', 'category', 'skills', 'positioning', 'body'], '七格（作用域、技能与正文可选）')
		// **控件类型**：两个多行格必须是 `textarea`（原来挂 `.cbv-input`，被那一条 `height:26px` 压成单行 ——
		// 现场原话："补充正文那一栏应该是文本框，不是输入框"）；三个单行格是 `input`；
		// **专属技能那一格现在是多选**（HD-007）：它不是输入框，是一组复选框（容器带同一个 `data-roster-field`）。
		const byField = (name) => nodes(opened).find((node) => node.props['data-roster-field'] === name)
		for (const name of ['id', 'title', 'category']) assert.equal(byField(name).type, 'input', name + ' 是单行输入')
		// **作用域**那一格：缺省「本工作区」被选中（HD-008）
		const scopeField = byField('scope')
		// **下拉**（人的追加要求：圆点改列表）—— 选项与当前档都在 `<select>` 上
		assert.equal(scopeField.type, 'select', '「写在哪」是下拉，不是单选圆点')
		assert.deepEqual(
			nodes(scopeField).filter((node) => node.type === 'option').map((node) => node.props.value),
			['workspace', 'user'],
			'两个作用域都要在',
		)
		assert.ok(textOf(scopeField).includes('本工作区（缺省）') && textOf(scopeField).includes('所有工作区都看得见'), '选项文字沿用原来的：' + textOf(scopeField))
		const skillsField = byField('skills')
		assert.equal(skillsField.type, 'div', '专属技能那一格是多选容器（不是单行输入）')
		// **多选下拉**（人的追加要求）：收起时只给摘要 + 展开按钮；点开才给可选项
		assert.ok(nodes(skillsField).some((node) => node.props['data-skill-summary'] !== undefined), '收起时要有摘要那一行')
		const skillsToggle = nodes(skillsField).find((node) => node.props['data-skill-toggle'] !== undefined)
		assert.ok(skillsToggle !== undefined, '要有展开那一枚按钮')
		const skillsExpanded = await act(harness, element.type, element.props, () => skillsToggle.props.onClick())
		const expandedSkillsField = nodes(skillsExpanded).find((node) => node.props['data-roster-field'] === 'skills')
		assert.ok(
			nodes(expandedSkillsField).some((node) => node.props['data-skill-option'] !== undefined),
			'展开后要给出可选项（`data-skill-option`）',
		)
		for (const name of ['positioning', 'body']) {
			assert.equal(byField(name).type, 'textarea', name + ' 是多行文本框')
			assert.ok(!String(byField(name).props.className).includes('cbv-input'), name + ' 不许挂 .cbv-input（那条有 height:26px）')
			assert.ok(String(byField(name).props.className).includes('cbv-mp-textarea'), name + ' 走唯一的文本框样式')
		}
		// 说明那一类**只有一处实现**：弹窗里所有说明都带 `.cbv-mp-field-note`，且走 markdown（不再印 `**`）。
		const notes = nodes(opened).filter((node) => hasClass(node, 'cbv-mp-field-note'))
		assert.ok(notes.length >= 6, '六格各有一行说明（实际 ' + notes.length + '）')
		assert.ok(notes.every((node) => hasClass(node, 'cbv-md')), '说明走 markdown 渲染')
		// 形状校验（设计 4.2.1）：id 为空时「添加」不可提交 ⇒ 先填一个合法 id。
		const idField = nodes(opened).find((node) => node.props['data-roster-field'] === 'id')
		const filled = await act(harness, element.type, element.props, () => idField.props.onChange({ target: { value: 'probe-role' } }))
		const dialogReady = nodes(filled).find((node) => node.props['data-roster-submit'] === 'create')
		assert.equal(dialogReady.props.disabled, false, '填了合法 id 之后「添加」可提交')
		const before = fetchStub.calls.length
		const submitted = await act(harness, element.type, element.props, () => dialogReady.props.onClick())
		assert.equal(nodes(submitted).find((node) => node.props['data-roster-submit'] !== undefined), undefined, '提交后弹窗关掉')
		// 写的**就是那一条**（写完之后这一块还会自己重取一次，所以不去数总数）。
		const wrote = fetchStub.calls.slice(before).filter((call) => call.url.includes('/roles/update'))
		assert.equal(wrote.length, 1, JSON.stringify(fetchStub.calls.slice(before)))
		assert.equal(wrote[0].method, 'POST')
		assert.ok(wrote[0].url.includes('workspace='), '写请求要带 workspace')
		assert.ok(fetchStub.calls.slice(before).some((call) => call.url.includes('/members')), '写完立刻重取这一块')
		assert.match(textOf(submitted), /已添加角色/, '回执原样显示端点的结论')

		// 点「下架」⇒ **不再二次确认**（人的口径）：直接落 `/roles/remove`，回执说明已下架。
		const removeButton = nodes(section).find((node) => node.props['data-roster-action'] === 'remove')
		const beforeRemove = fetchStub.calls.length
		const removedNow = await act(harness, element.type, element.props, () => removeButton.props.onClick())
		assert.equal(nodes(removedNow).find((node) => node.props['data-confirm-dialog'] === 'roles-remove'), undefined, '下架不再弹确认浮窗')
		const posts = fetchStub.calls.slice(beforeRemove).filter((call) => call.url.includes('/roles/'))
		assert.equal(posts.length, 1, JSON.stringify(fetchStub.calls.slice(beforeRemove)))
		assert.ok(posts[0].url.includes('/roles/remove'), posts[0].url)
		assert.match(textOf(removedNow), /已下架/, '回执要说已下架：' + textOf(removedNow).slice(0, 200))
	} finally {
		fetchStub.restore()
	}

	// **已下架**的那些折成一行（可恢复）：把 fixture 补一个下架的，再渲染一次看那一行。
	const withHidden = { ...members, defaults: { ...members.defaults, hiddenRows: [{ role: 'ceo', title: '总经理', category: '管理', positioning: '对经营结果负责。', file: '/w/roles/ceo/ROLE.md', origin: 'package', removal: 'hide', state: 'vacant', present: [], archived: [], retired: [], removed: [], nextName: 'ceo-1', label: '未到场；可以叫一个：ceo-1' }] } }
	const third = await mountPane({ members: withHidden, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const thirdRoles = await onRolesTab(third.harness, third.element, third.tree)
		const restore = nodes(thirdRoles).find((node) => node.props['data-roster-action'] === 'restore')
		assert.ok(restore !== undefined, '已下架那一行给一个恢复按钮')
		const beforeRestore = third.fetchStub.calls.length
		await act(third.harness, third.element.type, third.element.props, () => restore.props.onClick())
		const posts = third.fetchStub.calls.slice(beforeRestore).filter((call) => call.url.includes('/roles/'))
		assert.equal(posts.length, 1, JSON.stringify(third.fetchStub.calls.slice(beforeRestore)))
		assert.ok(posts[0].url.includes('/roles/restore'), posts[0].url)
	} finally {
		third.fetchStub.restore()
	}

	// 载荷没有这一格（老宿主）⇒ 整节不渲染，而不是渲染一个空壳。
	const noRoster = { ...members }
	delete noRoster.defaults
	const second = await mountPane({ members: noRoster, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const secondRoles = await onRolesTab(second.harness, second.element, second.tree)
		assert.equal(nodes(secondRoles).find((node) => node.props['data-roster-count'] !== undefined), undefined, '没有这一格就不渲染角色目录')
		assert.ok(textOf(secondRoles).includes('这一版宿主没有返回角色目录'), '如实说一句，不留白屏：' + textOf(secondRoles).slice(0, 120))
	} finally {
		second.fetchStub.restore()
	}
})

test('技能端点：三个根恒显（空档也列 count 0）—— 真 handler 级断言（task-62 自证点）', async () => {
	const workspace = fixtureWorkspace()
	// 这一份假注册表里**只有用户级与包内**的技能 ⇒ 项目级那一档**恰好是空的**（人报的现场就是这个形态）。
	const registry = {
		async snapshot() {
			return {
				skills: [
					{ name: 'u-one', description: 'd', source: 'user-dsh', provider: 'filesystem', path: '/u/.dsh/skills/u-one/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
					{ name: 'p-one', description: 'd', source: 'package', provider: 'filesystem', path: '/p/p-one/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
					{ name: 'p-two', description: 'd', source: 'package', provider: 'filesystem', path: '/p/p-two/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
				],
				complete: true,
			}
		},
		async get() {
			return undefined
		},
	}
	const payload = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: registry }))
	assert.equal(payload.ok, true, JSON.stringify(payload).slice(0, 200))
	const keys = payload.facets.map((facet) => facet.key)
	// ① 三个根**恒显**（顺序固定：项目级 → 用户级 → 包内），空档也在，count 写 0
	assert.deepEqual(keys, ['project', 'user', 'package'], '三个根恒显（空档也列）：' + JSON.stringify(payload.facets))
	const project = payload.facets.find((facet) => facet.key === 'project')
	assert.equal(project.count, 0, '空档的计数是 0，但**这一档要在**：' + JSON.stringify(project))
	assert.equal(project.label, '项目级', '标签照常量：' + JSON.stringify(project))
	// ② `other` 不是"根" ⇒ 空着不占格
	assert.ok(!keys.includes('other'), '`other` 只在非空时出现：' + JSON.stringify(keys))
	// ③ 「全部」那个数 = 各档之和（这里 3 = 0 + 1 + 2）
	const sum = payload.facets.reduce((acc, facet) => acc + facet.count, 0)
	assert.equal(sum, payload.total, '各档之和要对上总数（含 0 档）：' + sum + ' vs ' + payload.total)
	assert.equal(payload.targetDefault, 'project', '缺省写入位置仍是项目级（所以这一档必须看得见）')
})

test('同一张卡上"该谁干"与"现在谁在干"不许撞名（task-68）：`task.assignee` 那行只能用「现在：」', () => {
	// **为什么**：`boardCard` 里 `owner`（= 该谁干，角色的名字）已经占了中文「归属：」⇒
	// 若 `assignee`（= 现在谁在干）也写「归属」，同一张卡上会出现两个「归属」说两件**不同**的事 ——
	// 那不是"多印一句"，是**让人读错**（撞名比多一句更糟）。所以一个用「归属：」，另一个用「现在：」。
	const source = readFileSync('lib/board-view.client.js', 'utf8')
	const code = source
		.split('\n')
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join('\n')
	// ① 正面：assignee 那行用「现在：」
	assert.ok(code.includes("'现在：' + text(task.assignee)"), 'assignee 那行要用「现在：」')
	// ② 反向：**没有任何一行**把 assignee 说成「归属」
	for (const bad of ["'归属：' + text(task.assignee)", "'归属 ' + text(task.assignee)", "'归属：' + task.assignee", "'归属 ' + task.assignee"]) {
		assert.ok(!code.includes(bad), 'assignee 不许再用「归属」这个词（撞名）：' + bad)
	}
	// ③ 逐行核：凡是提到 assignee 的那一行，只许出现「现在：」；凡是提到 owner 的那一行，才是「归属：」
	for (const line of code.split('\n')) {
		if (!line.includes('task.assignee')) continue
		assert.ok(line.includes('现在：'), '提到 assignee 的那一行要用「现在：」：' + line.trim())
		assert.ok(!line.includes('归属'), '提到 assignee 的那一行不许出现「归属」：' + line.trim())
	}
	for (const line of code.split('\n')) {
		if (!line.includes('task.owner')) continue
		assert.ok(line.includes('归属：'), '提到 owner 的那一行才是「归属：」：' + line.trim())
	}
})

test('boardCard 收尾（task-67）：`owner：`/`created：`/`updated：`/`执行代 #` 一个都不留，中文事实仍在', () => {
	// 协调者的探针：把 `owner：` 改成中文「归属：」⇒ **0 红** ⇒ 那几处还没被钉；这一条就是把它们钉上。
	const source = readFileSync('lib/board-view.client.js', 'utf8')
	const code = source
		.split('\n')
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join('\n')
	for (const raw of ['owner：', 'created：', 'updated：', '执行代 #']) {
		assert.ok(!code.includes(raw), `代码里不许再有这种原样形态：${raw}`)
	}
	// 正面：这三个事实**仍以中文在**（只换形态，不丢信息）
	for (const zh of ['归属：', '创建：']) {
		assert.ok(code.includes(zh), `中文事实要留着：${zh}`)
	}
	// 「更新」这件事在卡上那一行中文里（`'更新 ' + updatedAt`）—— 展开支**不重复**（同一事实只说一次）
	assert.ok(code.includes("'更新 ' + updatedAt"), '「更新 …」那一行还在（中文，卡上说一次）')
	assert.ok(!code.includes("key: 'updated' } , '更新：'"), '展开支不重复「更新」')
	// 版本号那格：与活卡同一形态 `v<N>`（不再写「第 N 版」），且**执行代那格整个没有了**
	assert.ok(code.includes("'v' + task.revision"), '版本号用 `v<N>` 形态（与活卡一致）')
	assert.ok(!code.includes("'第 ' + task.revision + ' 版'"), '不再写「第 N 版」')
	assert.ok(code.includes("'现在：' + text(task.assignee)"), 'assignee 那句改成「现在：…」（与 owner 的中文「归属：」不撞名）')
})

test('给人看的界面不印原生字段名（task-65）：六个别名一个都不许留（`artifact：`/`phase：`/`grade：`/`revision：`/`assignee：`/`执行代：#`）', () => {
	// **不是删渲染器**：协调者复核后确认 `boardCard` **可达**（`CARDS = { board: boardCard }` 注册进表 + 浮窗那条
	// `CARDS[ledger](…)` 取用）⇒ 它是**活路径**，一律不许删；要改的是**话**（task-56 已批口径）。
	const source = readFileSync('lib/board-view.client.js', 'utf8')
	// **注释行不算**：文件里正解释"为什么不再印"的那几行本来就会提到这些名字（口径与 task-56 那次同一个处理）。
	const code = source
		.split('\n')
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join('\n')
	for (const raw of ['artifact：', 'phase：', 'grade：', 'revision：', 'assignee：', '执行代：# ']) {
		assert.ok(!code.includes(raw), `给人看的界面不许印原生字段名：${raw}`)
	}
	// 该留的事实仍以**中文**在（不是把整块搬走）
	assert.ok(code.includes('产物：'), '产物这一事实仍以中文说一次')
	assert.ok(code.includes('评级：'), '评级这一事实仍以中文说一次（exception 由卡顶徽标说）')
	// 反向：这六个名字**只许出现在注释里**（解释口径用），代码里一处都不许有
	assert.ok(source.includes('revision：'), '口径说明那句还在注释里（它解释的是"为什么不印"）')
})
test('角色「来源」下拉：三个根恒显（空档也列 count 0）—— 与技能级别同口径（task-64）', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	// **真 handler 算出来的** `originFacets`：名册里所有角色都在包内根 ⇒ 项目级 / 用户级**都是空档**。
	// （老行为是"只列 count>0"，空档被整档省略；这台机器上正好把那一格**整个藏掉**了 —— 人看到的就是没有这一格。）
	const originKeys = members.defaults.originFacets.map((facet) => facet.key)
	assert.deepEqual(originKeys, ['workspace', 'user', 'package'], '三个角色根恒显（空档也列）：' + JSON.stringify(members.defaults.originFacets))
	assert.equal(members.defaults.originFacets[0].count, 0, '空档的计数写 0，但这一档要在：' + JSON.stringify(members.defaults.originFacets[0]))
	assert.equal(members.defaults.originFacets[0].label, '项目级', '标签照常量：' + JSON.stringify(members.defaults.originFacets[0]))
	// 各档之和 = 在场角色数（含 0 档时也对）
	const sum = members.defaults.originFacets.reduce((acc, facet) => acc + facet.count, 0)
	assert.equal(sum, members.defaults.count, '各档之和要对上在场数（含 0 档）：' + sum + ' vs ' + members.defaults.count)
	// ② DOM：那一格要**画出来**（`originFacets.length <= 1` 才不画 ⇒ 三个根恒显之后它恒在）
	const skills = { ok: true, workspace, layer: 'session', complete: true, total: 0, warnings: [], facets: [], targets: [], targetDefault: 'project', skills: [] }
	const mounted = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const tab = buttonWith(mounted.tree, '角色')
		const onRoles = await act(mounted.harness, mounted.element.type, mounted.element.props, () => tab.props.onClick())
		const select = nodes(onRoles).find((node) => node.props['data-roster-origin-facet'] !== undefined)
		assert.ok(select !== undefined, '角色那一格要画出来（空档也列之后它恒在）')
		const values = nodes(select).filter((node) => node.type === 'option').map((node) => node.props.value)
		assert.deepEqual(values, ['all', 'workspace', 'user', 'package'], '选项 = 全部 + 三个根（空档也列）：' + JSON.stringify(values))
		assert.ok(textOf(select).includes('项目级（0）'), '空档写 0 但仍占一格：' + textOf(select))
		assert.ok(String(textOf(select)).includes(`全部来源（${members.defaults.rows.length}）`), '「全部」那个数 = 在场角色数（= 各档之和）：' + textOf(select))
	} finally {
		mounted.fetchStub.restore()
	}
})

test('技能「级别」下拉：三个根恒显（空档也列 count 0）、`other` 只在非空时在、「全部」= 各档之和（task-62）', async () => {
	const workspace = fixtureWorkspace()
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(teamServices()))
	// **现场**：本工作区的项目级技能根**存在但是空的** ⇒ 载荷里 `project` 的 count 是 0。
	// 人报的是「技能的分级一栏缺少「项目级」一栏」—— 老行为是"只列 count>0 的档"，把空档整档省略。
	const skills = {
		ok: true, workspace, layer: 'session', complete: true, total: 3, warnings: [],
		facets: [
			{ key: 'project', label: '项目级', count: 0 },
			{ key: 'user', label: '用户级', count: 1 },
			{ key: 'package', label: '包内', count: 2 },
		],
		targets: [
			{ key: 'project', label: '项目级', path: '/w/.dsh/skills', note: '只这个工作区（**缺省**）' },
			{ key: 'user', label: '用户级', path: '~/.dsh/skills', note: '**跨项目**：所有工作区都看得见（要显式选）' },
		],
		targetDefault: 'project',
		skills: [
			{ name: 'b-user', description: 'd', whenToUse: '', source: 'user-dsh', provider: 'filesystem', path: '/u/.dsh/skills/b/SKILL.md', level: 'user', levelLabel: '用户级', modelInvocable: true, userInvocable: true },
			{ name: 'c-pkg1', description: 'd', whenToUse: '', source: 'package', provider: 'filesystem', path: '/p/c1/SKILL.md', level: 'package', levelLabel: '包内', modelInvocable: true, userInvocable: true },
			{ name: 'c-pkg2', description: 'd', whenToUse: '', source: 'package', provider: 'filesystem', path: '/p/c2/SKILL.md', level: 'package', levelLabel: '包内', modelInvocable: true, userInvocable: true },
		],
	}
	const { tree, harness, element, fetchStub } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services: { sessions: { list: { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) } } } })
	try {
		const tab = buttonWith(tree, '技能')
		const onSkills = await act(harness, element.type, element.props, () => tab.props.onClick())
		const levelSelect = nodes(onSkills).find((node) => node.props['data-skill-level-facet'] !== undefined)
		const options = nodes(levelSelect).filter((node) => node.type === 'option')
		const values = options.map((node) => node.props.value)
		// ① **三个根恒显**（含空档），顺序照载荷；② `other` 不在（它不是"根"，空着不占格）
		assert.deepEqual(values, ['all', 'project', 'user', 'package'], '三个根恒显（空档也列）：' + JSON.stringify(values))
		assert.ok(textOf(levelSelect).includes('项目级（0）'), '空档的计数写 0，但仍占一格：' + textOf(levelSelect))
		assert.ok(textOf(levelSelect).includes('用户级（1）') && textOf(levelSelect).includes('包内（2）'), '非空档照载荷：' + textOf(levelSelect))
		// ③ **「全部」那个数 = 各档之和**（含 0 档时也对 —— 3 = 0 + 1 + 2）
		const allLabel = textOf(options[0])
		assert.equal(allLabel, '全部级别（3）', '「全部」= 各档之和：' + allLabel)
		// ④ 切到空档不出错：筛出来 0 条，且下拉仍在（空档是"能选、选完是空列表"，不是"没有这一档"）
		const picked = await act(harness, element.type, element.props, () => levelSelect.props.onChange({ target: { value: 'project' } }))
		const afterSelect = nodes(picked).find((node) => node.props['data-skill-level-facet'] !== undefined)
		assert.ok(afterSelect !== undefined, '选了空档之后下拉还在')
		assert.equal(String(afterSelect.props.value), 'project', '选中的档位就是空档本身（不是被弹回 all）')
	} finally {
		fetchStub.restore()
	}
})

test('技能块：筛档与层级标来自载荷（项目级 / 用户级），写哪一级也按载荷说（task-38 B）', async () => {
	const workspace = fixtureWorkspace()
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(teamServices()))
	const skills = {
		ok: true, workspace, layer: 'session', complete: true, total: 2, warnings: [],
		facets: [{ key: 'project', label: '项目级', count: 1 }, { key: 'user', label: '用户级', count: 1 }],
		targets: [
			{ key: 'project', label: '项目级', path: '/w/.dsh/skills', note: '只这个工作区（**缺省**）' },
			{ key: 'user', label: '用户级', path: '~/.dsh/skills', note: '**跨项目**：所有工作区都看得见（要显式选）' },
		],
		targetDefault: 'project',
		skills: [
			{ name: 'a-project', description: 'd', whenToUse: '', source: 'project-dsh', provider: 'filesystem', path: '/w/.dsh/skills/a/SKILL.md', level: 'project', levelLabel: '项目级', modelInvocable: true, userInvocable: true },
			{ name: 'b-user', description: 'd', whenToUse: '', source: 'user-dsh', provider: 'filesystem', path: '/u/.dsh/skills/b/SKILL.md', level: 'user', levelLabel: '用户级', modelInvocable: true, userInvocable: true },
		],
	}
	const { tree, harness, element, fetchStub } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services: { sessions: { list: { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) } } } })
	try {
		// 切到技能块
		const tab = buttonWith(tree, '技能')
		const onSkills = await act(harness, element.type, element.props, () => tab.props.onClick())
		// **级别筛是下拉**（task-43 退回：人原话「没让你改技能中的下拉」）——
		// 档位与标签都来自载荷 `facets`；阶段那排 chip 不在这条里管。
		const levelSelect = nodes(onSkills).find((node) => node.props['data-skill-level-facet'] !== undefined)
		assert.equal(levelSelect.type, 'select', '「按级别筛选」是下拉（不是 chip 排）')
		assert.deepEqual(
			nodes(levelSelect).filter((node) => node.type === 'option').map((node) => node.props.value),
			['all', 'project', 'user'],
			'选项 = 全部 + 载荷 facets（顺序也照载荷）',
		)
		assert.ok(textOf(levelSelect).includes('项目级（1）') && textOf(levelSelect).includes('用户级（1）'), '选项文案用载荷里的词与计数：' + textOf(levelSelect))
		const levelLabels = nodes(onSkills).filter((node) => node.props['data-skill-level-label'] !== undefined).map((node) => node.props['data-skill-level-label'])
		assert.ok(levelLabels.includes('项目级') && levelLabels.includes('用户级'), '卡片带层级标：' + JSON.stringify(levelLabels))
		// **卡片只印层级标签**（人的口径：「卡片上展示『项目级』『用户级』『包内』标签」；
		// 「模型可调用 / 人可调用」那排标签不再展示）—— 判据取卡片文字，不只看 data。
		const cardTexts = cardsOf(onSkills, 'cbv-sk-card').map((card) => textOf(card))
		assert.ok(cardTexts.some((text) => text.includes('项目级')) && cardTexts.some((text) => text.includes('用户级')), '卡片上印层级标签：' + JSON.stringify(cardTexts.map((text) => text.slice(0, 40))))
		assert.ok(!cardTexts.some((text) => text.includes('模型可调用') || text.includes('人可调用') || text.includes('两个面都没开')), '可调用面标签不再展示：' + JSON.stringify(cardTexts.map((text) => text.slice(0, 40))))
		// **写哪一级**：新建浮窗的档位文案来自载荷 `targets`，缺省取 `targetDefault`（项目级）
		const createButton = buttonWith(onSkills, '新建技能')
		const dialog = await act(harness, element.type, element.props, () => createButton.props.onClick())
		const rootSelect = nodes(dialog).find((node) => node.props['data-skill-root'] !== undefined)
		assert.ok(rootSelect !== undefined, '新建浮窗要有"落到哪一级"那一格')
		assert.equal(rootSelect.props.value, 'project', '缺省档 = 载荷的 targetDefault（项目级）：' + String(rootSelect.props.value))
		assert.ok(textOf(rootSelect).includes('项目级') && textOf(rootSelect).includes('用户级'), '选项文案来自载荷 targets：' + textOf(rootSelect))
		assert.ok(textOf(rootSelect).includes('只这个工作区'), '缺省那一档要说清"只这个工作区"：' + textOf(rootSelect))
	} finally {
		fetchStub.restore()
	}
})

test('切到技能块：清单卡片 + 查看正文浮窗 + 复制路径（都是端点给的那份原文）', async () => {
	const workspace = fixtureWorkspace()
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(teamServices()))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), { fs: makeFs(), get: (name) => (name === 'skills' ? fakeRegistry([]) : undefined), logger: { warn() {} } })
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services: { sessions: { list } } })
	const clipboard = []
	const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
	Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (value) => clipboard.push(value) } }, configurable: true })
	try {
		const props = element.props
		const skillsTab = buttonWith(tree, '技能')
		assert.ok(skillsTab !== undefined, '块表里有「技能」')
		const onSkills = await act(harness, element.type, props, () => skillsTab.props.onClick())
		const cards = cardsOf(onSkills, 'cbv-sk-card')
		assert.deepEqual(
			cards.map((card) => card.props['data-skill-name']),
			['code-review', 'hidden-one'],
		)
		assert.equal(cards[0].props['data-skill-source'], 'user-dsh')
		// **卡片只印层级标签**（人的口径）：code-review 来自用户根 ⇒「用户级」；
		// 「模型可调用 / 人可调用」那排标签与它的 data 标记都清掉了。
		assert.equal(cards[0].props['data-skill-level-label'], '用户级')
		assert.ok(textOf(cards[0]).includes('用户级'), '卡片上印层级标签：' + textOf(cards[0]).slice(0, 80))
		assert.equal(cards[0].props['data-skill-model'], undefined, '可调用面的 data 标记已清掉')
		assert.ok(!textOf(cards[0]).includes('模型可调用') && !textOf(cards[0]).includes('人可调用'), '可调用面标签不再展示')
		// **提供者也做成标签**（人的口径）：「来源 … · 提供者 …」那行撤掉（来源与层级标签重复），
		// 提供者作为第二枚标签印在卡片上。
		assert.ok(textOf(cards[0]).includes('filesystem'), '提供者改成标签展示：' + textOf(cards[0]).slice(0, 120))
		assert.ok(!textOf(cards[0]).includes('来源 '), '「来源 …」那行不再展示（与层级标签重复）')
		assert.ok(!textOf(cards[0]).includes('提供者 '), '「提供者 …」不再是文字行，改成标签')
		// **技能块不再印内页标题**（人的指令：tab 栏上已经有「技能」了；计数在筛选行）
		const skillsHead = nodes(onSkills).find((node) => node.type === 'div' && typeof node.props.className === 'string' && node.props.className.includes('cbv-view-head') && textOf(node.children).includes('技能'))
		assert.equal(skillsHead, undefined, '技能块不再有内页标题')
		assert.ok(!textOf(onSkills).includes('清单与正文只读'), '那句注解不再展示')
		// hidden-one 来自项目根 ⇒ 卡片印「项目级」；可调用面标签不再展示（技能本身照列）。
		assert.equal(cards[1].props['data-skill-level-label'], '项目级')
		assert.ok(textOf(cards[1]).includes('项目级'), '卡片上印层级标签：' + textOf(cards[1]).slice(0, 80))
		assert.ok(!textOf(onSkills).includes('/u/.dsh/skills/code-review/SKILL.md'), '卡片不再显示技能路径')

		// 查看正文：浮窗里摊的是宿主按 name 现读回来的正文原文（清单里没有正文）。
		const view = buttonWith(cards[0], '查看正文')
		assert.ok(view !== undefined, '卡上有「查看正文」')
		const opened = await act(harness, element.type, props, () => view.props.onClick())
		const dialog = nodes(opened).find((node) => node.props['data-skill-dialog'] === 'code-review')
		assert.ok(dialog !== undefined, '正文浮窗要开')
		assert.ok(textOf(dialog).includes(SKILL_BODY.trim()), '浮窗里是正文原文')
		assert.ok(textOf(dialog).includes('来源：用户 ~/.dsh/skills'), '来源用中文标签，括号里留原文')
		// 正文的**取法**：页面按 name 去那条端点现取（不是把清单里的 description 当正文）。
		assert.ok(
			fetchStub.calls.some((call) => call.url.startsWith('/company-board/api/skills/definition?name=code-review')),
			'正文要按 name 现取：' + JSON.stringify(fetchStub.calls.map((call) => call.url)),
		)

		// 复制路径：清单里就有路径，不必再取正文。
		const copyPath = buttonWith(cards[0], '复制路径')
		const copied = await act(harness, element.type, props, () => copyPath.props.onClick())
		assert.deepEqual(clipboard, ['/u/.dsh/skills/code-review/SKILL.md'])
		assert.ok(textOf(copied).includes('已复制指令文件路径'), '回执')

		// **阶段筛已撤**（人的口径：「『模型可调用』下拉选择栏不需要」）；只留级别筛，按「项目级」筛只剩 hidden-one。
		assert.equal(nodes(copied).find((node) => node.props['data-skill-stage-facet'] !== undefined), undefined, '技能阶段筛不再有')
		const levelSelect = nodes(copied).find((node) => node.props['data-skill-level-facet'] !== undefined)
		const projectOption = nodes(levelSelect).filter((node) => node.type === 'option').find((node) => textOf(node).startsWith('项目级'))
		const filtered = await act(harness, element.type, props, () => levelSelect.props.onChange({ target: { value: projectOption.props.value } }))
		assert.deepEqual(
			cardsOf(filtered, 'cbv-sk-card').map((card) => card.props['data-skill-name']),
			['hidden-one'],
		)
		// 搜索落空与"目录为空"两句话不共用。
		const search = nodes(filtered).find((node) => node.type === 'input' && String(node.props.placeholder ?? '').startsWith('搜索'))
		const empty = await act(harness, element.type, props, () => search.props.onChange({ target: { value: 'zzz-查不到' } }))
		// **落空要说清并给下一步**：一句"没有匹配的条目" + 一枚「清除筛选」（从前落空什么都不印 ——
		// 搜错一个名字看起来就像"数据没了"，也没有任何下一步）；而且**不许**冒充"目录是空的"（两句话不共用）。
		assert.ok(textOf(empty).includes('没有匹配的条目'), '落空要说清没有匹配：' + textOf(empty).slice(0, 120))
		assert.ok(textOf(empty).includes('清除筛选'), '落空要给一枚清除动作')
		assert.ok(!textOf(empty).includes('技能目录里一个技能都没有'), '落空不许冒充"目录是空的"')
	} finally {
		fetchStub.restore()
		if (originalNavigator === undefined) delete globalThis.navigator
		else Object.defineProperty(globalThis, 'navigator', originalNavigator)
	}
})

test('成员块的空态：原生名册在（卡照列）/ 读不到（说明 + 显式启用动作）；技能块空态另说', async () => {
	// task-40：旧名册文件那两句（"名册未建立" / "已建立但空着"）随旧账一起撤了 ——
	// 这一块现在只有两种状态：**本会话的原生名册在**（照列卡）与**读不到**（说明 + 一个显式动作）。
	const emptySkills = { ok: true, workspace: '/w', layer: 'session', complete: true, total: 0, skills: [], warnings: [] }
	// ①a 原生名册在：协调者照旧是一张卡（不因为"工作区里没东西"而变空）
	const teamOn = {
		ok: true,
		workspace: '/w',
		counts: { present: 1, disabled: 0, max: 24 },
		team: { available: true, reason: null, count: 1, rows: [TEAM_ROWS[0]] },
		merged: [{ key: 'team:sess-1', kind: 'lead', name: 'lead', session: 'sess-1', runtime: 'running', model: 'deepseek-flash', provider: '', context: '', description: '', diagnostics: [] }],
		warnings: [],
	}
	const first = await mountPane({ members: teamOn, skills: emptySkills, definition: SKILLS_DEFINITION_PAYLOAD })
	try {
		assert.deepEqual(
			cardsOf(first.tree, 'cbv-mp-card').map((card) => card.props['data-mem-name']),
			['lead'],
			'原生名册在 ⇒ 卡照列',
		)
		// 旧账那些读数与说明一个都不许再印
		assert.ok(!textOf(first.tree).includes('名册未建立'), '不再有"名册未建立"这句话')
		assert.ok(!textOf(first.tree).includes('.ops/members.json'), '面板不再提那份旧文件')
	} finally {
		first.fetchStub.restore()
	}

	// ①b 原生名册**读不到**：如实说明，并给一个显式的「启用团队服务」按钮（人不点就不动 profile）
	const teamOff = {
		ok: true,
		workspace: '/w',
		counts: { present: 0, disabled: 0, max: 24 },
		team: { available: false, reason: '这个部署没有 Agent Teams 服务（`ctx.agentTeams` 取不到）', count: 0, rows: [] },
		merged: [],
		warnings: ['这个部署没有 Agent Teams 服务（`ctx.agentTeams` 取不到）'],
	}
	const second = await mountPane({ members: teamOff, skills: emptySkills, definition: SKILLS_DEFINITION_PAYLOAD })
	try {
		assert.ok(textOf(second.tree).includes('读不到本会话的 agent 名册'), '团队读不到时要说明')
		const enable = nodes(second.tree).find((node) => node.props['data-team-service'] === 'enable')
		assert.ok(enable !== undefined, '团队服务缺席时应有「启用团队服务」按钮')
		assert.equal(enable.props.disabled, false)
		// 人要求：按钮旁那句"DSH 自带的可选能力层…"也撤掉（按钮本身留着）
		assert.ok(!textOf(second.tree).includes('就是 GUI"插件 / 能力"里那个开关'), '按钮旁那句说明不再展示')
		assert.ok(!textOf(second.tree).includes('随时可关回来'), '那句说明整条撤掉')
	} finally {
		second.fetchStub.restore()
	}
})

test('客户端那 5000 多行有一份分区地图，而且地图不会烂掉', () => {
	// 这个文件是 lazy-CJS 单文件工厂形态（引不到自己的相对文件、也没有构建步骤），文件拆不了；
	// 能做的是"有一份可信的地图"。可信 = 地图里的每一条都有同名横幅、且顺序一致 ——
	// 插了新分区却不更新地图，这条会红。
	const lines = readFileSync('lib/board-view.client.js', 'utf8').split('\n')
	// 取**整条标题**（标题里会有空格，比如「取数缓存与 URL」），所以：
	// 地图那一行按"标题 + 两格以上空白 + 说明"切；横幅那一行按标题后的横幅线切。
	// 前缀也要紧：地图行是 `//` 后**恰好三个空格**（头部注释里那些缩进更深的 ②/③ 不算地图条目）。
	const entriesOf = (pattern, join) =>
		lines
			.map((line) => pattern.exec(line))
			.filter((matched) => matched !== null)
			.map((matched) => join(matched))
	const mapEntries = entriesOf(/^\/\/   ([①-⑯]) (.+?)(?:\s{2,}|$)/, (matched) => `${matched[1]} ${matched[2].trim()}`)
	const banners = entriesOf(/^\t\t\/\/ ── ([①-⑯] .+?) ─+/, (matched) => matched[1].trim())
	assert.ok(mapEntries.length >= 10, '地图要够细（现在 ' + mapEntries.length + ' 条）')
	assert.deepEqual(banners, mapEntries, '地图与横幅必须逐条同名、同序')
	assert.equal(new Set(banners.map((item) => item.split(' ')[0])).size, banners.length, '分区编号不许重复')
})

test('回执不是 JSON 时：四块都要印出可读那行，不许白屏、不许画空清单', async () => {
	// 这类分支在客户端里有十几处，此前只有成员块那一处被钉住。这里让**所有端点**都回"非 JSON 的 503"，
	// 然后逐块走一遍：每一块都得说清"读不到 + 为什么"，一块都不许静默。
	const harness = loadClient()
	const seat = harness.seats.find((entry) => entry.options.name === 'conversation.view')
	const element = seat.component({ sessions: undefined, slots: undefined })
	const saved = globalThis.fetch
	globalThis.fetch = async () => ({
		status: 503,
		json: async () => {
			throw new Error('Unexpected token < in JSON at position 0')
		},
	})
	try {
		let tree = await settle(harness, element.type, element.props)
		const walk = async (current, label) => {
			const shown = textOf(current)
			assert.ok(shown.includes('响应不是 JSON'), label + ' 要说清是回执本身不是 JSON：' + shown.slice(0, 200))
			assert.ok(shown.includes('503'), label + ' 要带状态码：' + shown.slice(0, 200))
			return shown
		}
		await walk(tree, '成员块')
		assert.equal(cardsOf(tree, 'cbv-mp-card').length, 0, '成员块：读不到就不画卡')
		// 「角色」块（独立 tab）：读不到也要留下可读那行 + 一枚「重读」，不许白屏。
		const rolesTab = buttonWith(tree, '角色')
		tree = await act(harness, element.type, element.props, () => rolesTab.props.onClick())
		await walk(tree, '角色块')
		assert.equal(nodes(tree).find((node) => node.props['data-roster-count'] !== undefined), undefined, '角色块：读不到就不画角色目录')
		const rolesRetry = nodes(tree).find((node) => node.props['data-pane-retry'] === 'roles')
		assert.ok(rolesRetry !== undefined, '角色块也要给一枚「重读」')
		const skillsTab = buttonWith(tree, '技能')
		tree = await act(harness, element.type, element.props, () => skillsTab.props.onClick())
		await walk(tree, '技能块')
		assert.equal(cardsOf(tree, 'cbv-sk-card').length, 0, '技能块：读不到就不画空清单')
		const boardTab = buttonWith(tree, '任务看板')
		tree = await act(harness, element.type, element.props, () => boardTab.props.onClick())
		await walk(tree, '任务看板')
	} finally {
		globalThis.fetch = saved
	}
})

/** 一个会话服务桩：给 `useCurrentSessionId` 认出 sess-1（`mountPane` 的 services 用它）。 */
function window_sessions_stub(workspace) {
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	return { sessions: { list } }
}

test('动词按钮：载荷说不能做**也画出来**（禁用态）+ **理由原文不许丢**（task-38 A）', async () => {
	// 人问过"为什么有些卡片只有打断没有停用"：服务端对"这一档只剩它一位能干活"的成员回
	// `disable:{ok:false, why:"…同角色至少留 1 位未停用…"}`，而客户端遇到 `ok:false` 就不画 ⇒ 看着像"少了一半按钮"。
	// 现在：停用 / 恢复**一律画**（不能做 ⇒ 禁用态 + 服务端 `why` **原样**给到 title）。
	const workspace = fixtureWorkspace()
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(teamServices()))
	const WHY = '这一档只剩它一位能干活：**同角色至少留 1 位未停用** —— 先给它建一位，或者停用别的角色的人。'
	for (const row of members.merged) {
		if (row.verbs === undefined) continue
		row.verbs.disable = { ok: false, why: WHY }
		row.verbs.restore = { ok: false, why: '它现在**没有**被停用 —— 不需要恢复' }
		row.verbs.interrupt = { ok: false, why: '原生名册里没有这一位' }
	}
	const skills = { ok: true, workspace, layer: 'session', complete: true, total: 0, skills: [], warnings: [] }
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const { tree, fetchStub } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services: { sessions: { list } } })
	try {
		const button = nodes(tree).find((node) => node.props['data-member-verb'] === 'disable')
		assert.ok(button !== undefined, '**载荷说 ok:false 也要画出来**（藏起来等于让人猜为什么这张卡没有它）')
		assert.equal(button.props['aria-disabled'], 'true', '不能做 ⇒ aria-disabled（仍可聚焦）')
		assert.equal(button.props.disabled, false, '条件不允许不用原生 disabled')
		assert.equal(button.props['data-member-verb-ok'], 'false')
		// **理由原文不许丢**：title 就是服务端那句，一个字都不许改；aria-describedby 指向同一句。
		assert.equal(String(button.props.title), WHY, 'title 必须是服务端 why 的原文（不许自己复述）：' + String(button.props.title))
		const whyNode = nodes(tree).find((node) => node.props.id === button.props['aria-describedby'])
		assert.ok(whyNode !== undefined, 'aria-describedby 要指向一枚真实存在的理由节点')
		assert.ok(textOf(whyNode).includes('同角色至少留 1 位未停用'), '理由节点里要有 why 的正文：' + textOf(whyNode))
		assert.ok(!textOf(whyNode).includes('**'), '理由节点里的 markdown 标记要渲染掉')
		// 「打断」照旧：载荷说不能做就不画
		// 「打断」也与停用/恢复同一条（task-41）：不能做也画出来、禁用 + 原样给理由
		const stopButton = nodes(tree).find((node) => node.props['data-member-verb'] === 'interrupt')
		assert.ok(stopButton !== undefined, '「打断」也画出来（藏起来等于让人猜为什么没有它）')
		assert.equal(stopButton.props['aria-disabled'], 'true', '不能打断 ⇒ aria-disabled')
		assert.ok(String(stopButton.props.title ?? '') !== '', '禁用就必须给理由')
	} finally {
		fetchStub.restore()
	}
})

test('作用域筛档与来源标**都来自载荷**（改载荷 ⇒ 界面跟着变；前端不硬编码判定）', async () => {
	const workspace = fixtureWorkspace()
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(teamServices()))
	// 造三档（项目级 / 用户级 / 包内）各一条，**档位表也照服务端的形状给**
	members.defaults = {
		available: true,
		excluded: ['ontology'],
		count: 3,
		established: true,
		originFacets: [
			{ key: 'workspace', label: '项目级', count: 1 },
			{ key: 'user', label: '用户级', count: 1 },
			{ key: 'package', label: '包内', count: 1 },
		],
		rows: [
			{ role: 'probe-ws', title: '项目角色', category: '质量', positioning: '探针。', file: '/w/.dsh/team-ops/roles/probe-ws/ROLE.md', origin: 'workspace', originLabel: '项目级', removal: 'delete', state: 'vacant', present: [], archived: [], retired: [], removed: [], nextName: 'probe-ws-1', label: '未到场' },
			{ role: 'probe-user', title: '用户角色', category: '质量', positioning: '探针。', file: '/u/team-ops/roles/probe-user/ROLE.md', origin: 'user', originLabel: '用户级', removal: 'delete', state: 'vacant', present: [], archived: [], retired: [], removed: [], nextName: 'probe-user-1', label: '未到场' },
			{ role: 'reviewer', title: '评审员', category: '质量', positioning: '探针。', file: '/p/roles/reviewer/ROLE.md', origin: 'package', originLabel: '包内', removal: 'hide', state: 'vacant', present: [], archived: [], retired: [], removed: [], nextName: 'reviewer-1', label: '未到场' },
		],
	}
	const skills = {
		ok: true, workspace, layer: 'session', complete: true, total: 3, warnings: [],
		facets: [{ key: 'project', label: '项目级', count: 1 }, { key: 'user', label: '用户级', count: 2 }],
		targets: [
			{ key: 'project', label: '项目级', path: '/w/.dsh/skills', note: '只这个工作区（**缺省**）' },
			{ key: 'user', label: '用户级', path: '~/.dsh/skills', note: '**跨项目**：所有工作区都看得见（要显式选）' },
		],
		targetDefault: 'project',
		skills: [
			{ name: 'a-project', description: 'd', whenToUse: '', source: 'project-dsh', provider: 'filesystem', path: '/w/.dsh/skills/a/SKILL.md', level: 'project', levelLabel: '项目级', modelInvocable: true, userInvocable: true },
			{ name: 'b-user', description: 'd', whenToUse: '', source: 'user-dsh', provider: 'filesystem', path: '/u/.dsh/skills/b/SKILL.md', level: 'user', levelLabel: '用户级', modelInvocable: true, userInvocable: true },
		],
	}
	const { tree, harness, element, fetchStub } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services: window_sessions_stub(workspace) })
	try {
		// ① 角色块（先切过去）：**来源筛是下拉**（task-44 口径：除成员页外都退回下拉）+ 每张卡一枚来源标
		const onRoles = await onRolesTab(harness, element, tree)
		const facetSelect = nodes(onRoles).find((node) => node.props['data-roster-origin-facet'] !== undefined)
		assert.equal(facetSelect.type, 'select', '「按来源筛选」是下拉，不是 chip 排')
		assert.deepEqual(nodes(facetSelect).filter((node) => node.type === 'option').map((node) => node.props.value), ['all', 'workspace', 'user', 'package'], '选项 = 全部 + 载荷给的三档')
		assert.ok(textOf(facetSelect).includes('项目级（1）') && textOf(facetSelect).includes('用户级（1）') && textOf(facetSelect).includes('包内（1）'), '选项文案用载荷里的词与计数：' + textOf(facetSelect))
		const originChips = nodes(onRoles).filter((node) => node.props['data-roster-origin-chip'] !== undefined)
		assert.deepEqual(originChips.map((node) => textOf(node)).sort(), ['包内', '用户级', '项目级'].sort(), '每张卡带来源标：' + JSON.stringify(originChips.map((node) => textOf(node))))
		// ② 选「项目级」⇒ 只剩项目级那张卡（筛选真的生效）
		const after = await act(harness, element.type, element.props, () => facetSelect.props.onChange({ target: { value: 'workspace' } }))
		const visibleRoles = nodes(after).filter((node) => node.props['data-roster-role'] !== undefined).map((node) => node.props['data-roster-role'])
		assert.deepEqual(visibleRoles, ['probe-ws'], '筛出项目级那一档：' + JSON.stringify(visibleRoles))
		// ③ 技能块：筛档来自载荷 `facets`（项目级 / 用户级），卡片带 `levelLabel`
		// ③ 技能那一栏的筛档在**切到技能块**之后才有（见「技能块」那两条用例）
	} finally {
		fetchStub.restore()
	}
})

test('三条成员动词的 POST **必须带 `session=`**（现场那条「请求里没带会话 id」的客户端根因）', async () => {
	// 这三条端点要**本会话的 Lead** 当凭据（宿主 `teamCredentialOf(ctx, requestedSession(url))`）；
	// 客户端从前手拼的 URL 只带 `workspace=` ⇒ 服务端如实拒「请求里没带会话 id」（人在面板上点「停用」就是这么报的）。
	const workspace = fixtureWorkspace()
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(teamServices()))
	// **载荷说三个动词都能做**（不然客户端不画按钮，就点不到）
	for (const row of members.merged) {
		if (row.verbs !== undefined) for (const verb of ['disable', 'restore', 'interrupt']) row.verbs[verb] = { ok: true }
	}
	const skills = { ok: true, workspace, layer: 'session', complete: true, total: 0, skills: [], warnings: [] }
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services: { sessions: { list } } })
	try {
		// 点**成员卡上**每一个动词按钮（三处 POST 都要被验到）。
		// 「打断」会中止当前一轮 ⇒ 先出确认浮窗（设计 6.2）：点确认才发请求。
		for (const verb of ['disable', 'restore', 'interrupt']) {
			const button = nodes(tree).find((node) => node.props['data-member-verb'] === verb)
			assert.ok(button !== undefined, `要能画出来 ${verb} 那一枚按钮（载荷说 ok:true）`)
			const afterClick = await act(harness, element.type, element.props, () => button.props.onClick())
			if (verb === 'interrupt') {
				const go = nodes(afterClick).find((node) => node.props['data-confirm-go'] !== undefined)
				assert.ok(go !== undefined, '打断要先出确认浮窗')
				assert.equal(String(button.props['data-member-verb']) !== '', true)
				await act(harness, element.type, element.props, () => go.props.onClick())
			}
		}
		const posted = fetchStub.calls.filter((call) => call.method === 'POST' && call.url.startsWith('/company-board/api/members/'))
		assert.ok(posted.length >= 3, '三个动词各发过一条：' + JSON.stringify(fetchStub.calls.map((call) => call.url)))
		for (const call of posted) {
			assert.match(call.url, /[?&]session=/, '**必须带 session=**（否则宿主拿不到本会话的 Lead）：' + call.url)
			assert.match(call.url, /[?&]workspace=/, '也要带 workspace=：' + call.url)
		}
	} finally {
		fetchStub.restore()
	}
})

test('成员块：三个动词按载荷给的 `verbs` 画（整栏不印说明与计数）', async () => {
	// 人的要求（HD-006）：面板「成员」每张卡加**停用 / 恢复 / 打断**；**服务端给动词、客户端不猜**
	// （沿用「角色」卡那套 `removal`）。这一条钉"客户端只照载荷画"这件事，动词的语义在引擎那一组用例里钉。
	const workspace = fixtureWorkspace()
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(teamServices()))
	// 这一段验的是"点下去真的发那一条 POST"：把载荷动词置成可做（否则按设计只显示理由、不发请求）。
	for (const row of members.merged) {
		if (row.verbs === undefined) continue
		for (const verb of ['disable', 'restore', 'interrupt']) if (row.verbs[verb] !== undefined) row.verbs[verb] = { ok: true }
	}
	const skills = { ok: true, workspace, layer: 'session', complete: true, total: 0, skills: [], warnings: [] }
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services: { sessions: { list } } })
	try {
		// ① 开关键一枚都不许有（那枚 `role="switch"` 早就撤了）
		assert.equal(nodes(tree).find((node) => hasClass(node, 'cbv-switch')), undefined, '成员卡上不再有启停开关')
		// ② 在册的卡：动作条上只有载荷动词 + 那两个只读动作；「编辑」「删除」不许回来
		// 「在册 / 未入册」那一对随旧账撤了（task-40）⇒ 现在按**原生名册**找一张队友卡
		const teammate = cardsOf(tree, 'cbv-mp-card').find((card) => card.props['data-mem-kind'] === 'teammate')
		assert.ok(teammate !== undefined, '夹具里有队友卡（原生名册那一位）')
		assert.equal(buttonWith(teammate, '编辑'), undefined, '不再有「编辑」')
		assert.equal(buttonWith(teammate, '删除'), undefined, '不再有「删除」')
		// 「查看 / 复制提示词」读的是旧名册里的 persona/prompt ⇒ 随旧账一起撤（那两个按钮本来就从未出现过）
		assert.equal(buttonWith(teammate, '查看提示词'), undefined, '旧名册的查看入口撤掉了')
		assert.equal(buttonWith(teammate, '复制提示词'), undefined, '旧名册的复制入口撤掉了')
		const registered = teammate
		// **判据（HD-006 的 UX 修正之后）**：客户端**不推断规则**，只照载荷画 ——
		//   · 「停用 / 恢复」：载荷给了这一格就**一律画**；不能做 ⇒ **禁用态**，且 title 就是服务端的 `why`（原样）；
		//   · 「打断」：**照旧**（载荷说 ok 才画）。
		const rowOf = (card) => members.merged.find((row) => row.name === card.props['data-mem-name'])
		for (const verb of ['disable', 'restore', 'interrupt']) {
			const button = nodes(registered).find((node) => node.props['data-member-verb'] === verb)
			const spec = rowOf(registered)?.verbs?.[verb]
			if (verb === 'interrupt') {
				assert.equal(button !== undefined, spec !== undefined, '「打断」的可见性也只由载荷有没有这一格决定')
				continue
			}
			assert.equal(button !== undefined, spec !== undefined, `${verb} 的可见性只由载荷有没有这一格决定`)
			if (button !== undefined && spec !== undefined) {
				assert.equal(button.props['aria-disabled'], spec.ok !== true ? 'true' : undefined, `${verb} 的不可用态要与 payload ok 一致`)
				assert.equal(button.props.disabled, false, `${verb} 条件不允许时不用原生 disabled`)
				if (spec.ok !== true) {
					assert.equal(String(button.props.title ?? ''), String(spec.why ?? ''), `${verb} 禁用时 title 必须是服务端的 why 原文（不许自己复述）`)
					assert.ok(String(button.props.title ?? '') !== '', `${verb} 禁用时必须给理由`)
				}
			}
		}
		// ③ 整栏**不印**操作边界那行、也不印计数行（人的指令：这几样都不展示）
		assert.equal(nodes(tree).find((node) => node.props['data-members-ro'] !== undefined), undefined, '整栏不再有一句边界声明')
		assert.equal(nodes(tree).find((node) => node.props['data-members-counts'] !== undefined), undefined, '不再印计数行')
		assert.ok(!textOf(tree).includes('上限 24'), '计数行连同"上限 24"一起撤掉：' + textOf(tree).slice(0, 160))
		// ⑤ 点「停用」⇒ 发一条 POST 到 `/members/disable`，且发完**失效缓存 + 重取**
		const disableButton = nodes(registered).find((node) => node.props['data-member-verb'] === 'disable')
		if (disableButton !== undefined) {
			const before = fetchStub.calls.length
			await act(harness, element.type, element.props, () => disableButton.props.onClick())
			const posted = fetchStub.calls.slice(before).filter((call) => call.method === 'POST' && call.url.startsWith('/company-board/api/members/disable'))
			assert.equal(posted.length, 1, '点「停用」要发一条到 /members/disable：' + JSON.stringify(fetchStub.calls.slice(before).map((call) => call.url)))
			assert.deepEqual(JSON.parse(posted[0].body), { name: registered.props['data-mem-name'] }, '请求体是 { name }')
		}
	} finally {
		fetchStub.restore()
	}
})

test('客户端的成员写面与死工具名：非注释行里零命中', async () => {
	// 判据的静态那一半：这两个路径不许再出现在**代码**里（注释里可以提，那是解释为什么撤）。
	// 五个死工具名（`member_retire` / `member_touch` / `member_remove` / `member_update` / `member_interrupt`）
	// 在整份客户端里零命中：它们从前被印在删除确认那段说明里，教人用不存在的工具。
	const lines = readFileSync('lib/board-view.client.js', 'utf8').split('\n')
	const code = lines.filter((line) => {
		const trimmed = line.trim()
		return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
	})
	const codeText = code.join('\n')
	assert.ok(!codeText.includes('/members/update') && !codeText.includes('/members/delete'), '代码里不再有成员写路径')
	assert.ok(!/MEMBER_UPDATE_ENDPOINT|MEMBER_DELETE_ENDPOINT/.test(codeText), '成员写端点那两个常量也撤了')
	assert.ok(!/\bmember_(retire|touch|remove|update|interrupt)\b/.test(readFileSync('lib/board-view.client.js', 'utf8')), '五个死工具名零命中')
	// 角色那一面**没有**被误伤：三条角色写路径与它们的按钮都还在（那是活的）
	assert.ok(/const ROLES_UPDATE_ENDPOINT = /.test(codeText) && /const ROLES_REMOVE_ENDPOINT = /.test(codeText) && /const ROLES_RESTORE_ENDPOINT = /.test(codeText), '角色那三条写路径要留着')
})


// ── 交互面这十条的钉住断言 ───────────────────────────────────────────────────

/**
 * 渲染树里**元素文本子节点**出现 markdown 标记即违规（`**` 与反引号都要渲染掉，不许原样上屏）。
 *
 * `pre` 子树**跳过**：那是"原文"（技能正文 / 提示词 / 代码块），里面的反引号本来就该原样留着。
 * @param tree - 渲染出来的节点树。
 * @returns 违规的文本片段（空数组 = 干净）。
 */
function literalMarkerTexts(tree) {
	const out = []
	const walk = (node) => {
		if (typeof node === 'string') {
			if (node.includes('**') || node.includes('`')) out.push(node)
			return
		}
		if (Array.isArray(node)) {
			for (const item of node) walk(item)
			return
		}
		if (node === null || node === undefined || typeof node !== 'object') return
		if (node.type === 'pre') return
		for (const child of node.children) walk(child)
	}
	walk(tree)
	return out
}

test('「角色」选择框的每一行都能用键盘走完：Enter / Space 选中，↑ ↓ 挪焦点', async () => {
	// 行是 `div role="option"`（浏览器对它没有内建的激活行为）⇒ 只绑 `onClick` 对纯键盘的人是死路：
	// 焦点能移到「QA 测试工程师」那一行，按 Enter 什么都不会发生。
	const registeredSources = []
	const harness = loadClient({ inputTriggers: { registerSource: (src) => { registeredSources.push(src); return () => {} } } })
	const Entry = harness.seats.find((entry) => entry.options.name === 'conversation.input.left').component
	const rows = {
		defaults: {
			rows: [
				{ role: 'reviewer', title: '评审员', category: '质量', positioning: '对产物内部质量负责。', avatar: 'search', avatarTone: 'exec', state: 'absent' },
				{ role: 'qa', title: '测试工程师', category: '质量', positioning: '对质量结论负责。', avatar: 'shield', avatarTone: 'exec', state: 'present' },
			],
		},
	}
	const savedFetch = globalThis.fetch
	globalThis.fetch = async () => ({ status: 200, json: async () => rows })
	const kb = fakeKeyboard()
	const savedDoc = globalThis.document
	globalThis.document = kb.doc
	const bailCalls = []
	const scope = {
		get: () => ({ input: { for: () => handle } }),
		bail: (target, event, request) => {
			bailCalls.push({ event, request })
			return true
		},
	}
	const handle = { state: { getSnapshot: () => ({ draft: '', occurrences: [], draftRev: 3 }) } }
	const sessions = { scope: () => scope, list: { getSnapshot: () => ({ current: 'sess-1', byId: { 'sess-1': { id: 'sess-1', cwd: '/w' } } }) } }
	const props = () => ({ sessionId: 'sess-1', sessions, useInput: (select) => select({ draft: '' }), inputActions: { setDraft: () => {} } })
	const openPicker = (tree) => nodes(tree).find((node) => node.type === 'button' && hasClass(node, 'cbv-composer-btn')).props.onClick()
	try {
		let tree = await act(harness, Entry, props(), () => {})
		tree = await act(harness, Entry, props(), () => openPicker(tree))
		const options = nodes(tree).filter((node) => node.props['data-composer-role-id'] !== undefined)
		assert.deepEqual(options.map((node) => node.props['data-composer-role-id']), ['reviewer', 'qa'])
		// ① 每一行都要有键盘处理（这一条就是"无 onKeyDown 的行即红"）
		for (const row of options) {
			assert.equal(typeof row.props.onKeyDown, 'function', '行 ' + row.props['data-composer-role-id'] + ' 要有 onKeyDown')
			assert.equal(row.props.role, 'option', '行仍然是 option（离屏可读）')
		}
		// ② Enter = 与 onClick **同一段**：插 `@qa`，并关窗
		tree = await act(harness, Entry, props(), () => options[1].props.onKeyDown({ key: 'Enter', preventDefault() {}, currentTarget: null }))
		assert.equal(bailCalls.length, 1, 'Enter 要真的把角色插进输入框')
		assert.equal(bailCalls[0].request.reference.ref, 'qa')
		assert.equal(nodes(tree).find((node) => node.props['data-composer-role-list'] !== undefined), undefined, '选完关窗')
		// ③ Space = 同一件事
		tree = await act(harness, Entry, props(), () => openPicker(tree))
		const again = nodes(tree).filter((node) => node.props['data-composer-role-id'] !== undefined)
		tree = await act(harness, Entry, props(), () => again[1].props.onKeyDown({ key: ' ', preventDefault() {}, currentTarget: null }))
		assert.equal(bailCalls.length, 2, 'Space 也要真的选中')
		// ④ ↑ ↓ 把焦点挪到相邻一行（拿得到 DOM 时）：拿一个假 DOM 按出来
		tree = await act(harness, Entry, props(), () => openPicker(tree))
		const rowNodes = nodes(tree).filter((node) => node.props['data-composer-role-id'] !== undefined)
		const focused = []
		const first = {
			focus() {
				focused.push('reviewer')
			},
			closest: () => list,
		}
		const second = {
			focus() {
				focused.push('qa')
			},
			closest: () => list,
		}
		const list = { querySelectorAll: () => [first, second] }
		rowNodes[0].props.onKeyDown({ key: 'ArrowDown', preventDefault() {}, currentTarget: first })
		assert.deepEqual(focused, ['qa'], '↓ 把焦点挪到下一行')
		rowNodes[1].props.onKeyDown({ key: 'ArrowUp', preventDefault() {}, currentTarget: second })
		assert.deepEqual(focused, ['qa', 'reviewer'], '↑ 挪回上一行')
		// ⑤ 拿不到 DOM（非浏览器环境 / 别的宿主）时安安静静，不许抛
		rowNodes[0].props.onKeyDown({ key: 'ArrowDown', preventDefault() {}, currentTarget: null })
		rowNodes[0].props.onKeyDown({ key: 'ArrowDown', preventDefault() {}, currentTarget: { closest: () => null } })
	} finally {
		globalThis.fetch = savedFetch
		globalThis.document = savedDoc
	}
})

test('任务看板：取数途中印「正在读取」，读失败才印「读不到」并给一枚「重读」', async () => {
	// 从前 `phase === 'loading'` 时 `teamReason` 是空的 ⇒ 落到兜底句"读不到本会话的团队任务板"，
	// 每次切到这一档都先闪一句失败文案。同屏另外两块各有 loading 分支，只有它说假话。
	const harness = loadClient()
	const seat = harness.seats.find((entry) => entry.options.name === 'conversation.view')
	const element = seat.component({ sessions: undefined, slots: undefined })
	const members = {
		ok: true,
		workspace: '/w',
		file: '/w/.ops/members.json',
		established: true,
		present: 0,
		archived: 0,
		retired: 0,
		total: 0,
		team: { available: false, reason: '假件：没有 Agent Teams 服务', count: 0, rows: [] },
		rows: [],
		merged: [],
		warnings: [],
		annotations: [],
		markdown: '',
	}
	const skills = { ok: true, workspace: '/w', layer: 'session', complete: true, total: 0, skills: [], warnings: [] }
	const saved = globalThis.fetch
	let teamCalls = 0
	let failing = false
	globalThis.fetch = async (url) => {
		const target = '' + url
		if (target.startsWith('/company-board/api/team-tasks')) {
			teamCalls += 1
			// 永不落地 ⇒ 停在 loading（模拟宿主慢：首次连接 / 主进程刚起）
			if (!failing) return { status: 200, json: async () => new Promise(() => {}) }
			return { status: 500, json: async () => ({ ok: false, error: '原生任务板取不到（假件）' }) }
		}
		if (target.startsWith('/company-board/api/status')) return { status: 200, json: async () => STATUS_PAYLOAD }
		if (target.startsWith('/company-board/api/skills')) return { status: 200, json: async () => skills }
		if (target.startsWith('/company-board/api/members')) return { status: 200, json: async () => members }
		if (target === '/company-board/api' || target.startsWith('/company-board/api?')) throw new Error('任务看板不该再请求已撤的自建看板：' + target)
		throw new Error('这一栏不该请求这个端点：' + target)
	}
	try {
		let tree = await settle(harness, element.type, element.props)
		const boardTab = buttonWith(tree, '任务看板')
		let onBoard = await act(harness, element.type, element.props, () => boardTab.props.onClick())
		assert.ok(textOf(onBoard).includes('正在读取本会话的团队任务板'), '取数途中要说"正在读"：' + textOf(onBoard).slice(0, 200))
		assert.ok(!textOf(onBoard).includes('读不到本会话的团队任务板'), '取数途中不许说"读不到"')
		assert.equal(nodes(onBoard).find((node) => node.props['data-team-phase'] === 'loading') !== undefined, true, 'loading 这件事落在 data 上')
		// 端点真答"读不到"时：那一行照印，并给一枚能点的「重读」
		failing = true
		// 先让这一屏重读一次（「窗口回到前台」是面板既有的那条触发）⇒ 这一回端点答"读不到"
		const failedBoard = await act(harness, element.type, element.props, () => harness.listeners.window.focus())
		assert.ok(textOf(failedBoard).includes('原生任务板取不到（假件）'), '读失败要印端点那一行原文：' + textOf(failedBoard).slice(0, 200))
		assert.ok(!textOf(failedBoard).includes('正在读取本会话的团队任务板'), '读失败时不再说"正在读"')
		const retry = nodes(failedBoard).find((node) => node.props['data-pane-retry'] === 'board')
		assert.ok(retry !== undefined, '读失败要给一枚「重读」')
		const callsBefore = teamCalls
		await act(harness, element.type, element.props, () => retry.props.onClick())
		assert.ok(teamCalls > callsBefore, '「重读」要真的再取一次：' + callsBefore + ' → ' + teamCalls)
	} finally {
		globalThis.fetch = saved
	}
})

test('任务看板的最小筛选：分档 chip + 搜索；落空给「清除筛选」；不再请求已撤的自建看板', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const teamTasks = {
		ok: true,
		available: true,
		reason: null,
		total: 4,
		counts: { pending: 1, in_progress: 1, completed: 2 },
		warnings: ['写盘面与别的任务重叠：**只告警不拦**（`writeScopes` 是提示性声明）。'],
		rows: [
			{ id: 'T-1', revision: 1, subject: '改 A', description: '把 A 改掉', status: 'pending', ownerName: '', ready: true, blockedBy: [], writeScopes: ['src/a'], writeScopeWarnings: [] },
			{ id: 'T-2', revision: 3, subject: '改 B', description: '', status: 'in_progress', ownerName: 'revi-1', ready: false, blockedBy: ['T-1'], writeScopes: [], writeScopeWarnings: ['write scopes overlap with T-1'] },
			{ id: 'T-3', revision: 2, subject: '改 C', description: '', status: 'completed', ownerName: 'lead', ready: false, blockedBy: [], writeScopes: [], writeScopeWarnings: [] },
			// **依赖是事实、阻塞是状态**（人的口径）：T-4 依赖**已完成**的 T-3 ⇒ 有依赖算它、被阻塞不算；
			// T-2 依赖还没完成的 T-1 ⇒ 两档都算。
			{ id: 'T-4', revision: 1, subject: '改 D', description: '', status: 'completed', ownerName: 'lead', ready: false, blockedBy: ['T-3'], writeScopes: [], writeScopeWarnings: [] },
		],
	}
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, teamTasks })
	const cardIds = (current) => nodes(current).filter((node) => node.props['data-tt-id'] !== undefined && node.props['data-tt-id'] !== '').map((node) => node.props['data-tt-id'])
	try {
		const onBoard = await act(harness, element.type, element.props, () => buttonWith(tree, '任务看板').props.onClick())
		// ① 分档 chip 在，计数照原生那几个字段算（可认领 = 原生 `ready`；被阻塞 = 依赖没完成；
		//    有依赖 = `blockedBy` 非空这个事实 —— 依赖已完成、任务已完成都仍然算）
		const stageChips = nodes(onBoard).filter((node) => node.props['data-tt-stage'] !== undefined)
		assert.deepEqual(
			stageChips.map((node) => node.props['data-tt-stage']),
			['all', 'ready', 'blocked', 'depends', 'overlap'],
		)
		assert.deepEqual(
			stageChips.map((node) => textOf(node)),
			['全部 4', '可认领 1', '被阻塞 1', '有依赖 2', '写盘面重叠 1'],
		)
		// ② 「有依赖」≠「被阻塞」：T-2（依赖未完成的 T-1）两档都在；T-4（依赖已完成的 T-3）只在「有依赖」
		const blockedChip = stageChips.find((node) => node.props['data-tt-stage'] === 'blocked')
		const dependsChip = stageChips.find((node) => node.props['data-tt-stage'] === 'depends')
		const onlyBlocked = await act(harness, element.type, element.props, () => blockedChip.props.onClick())
		assert.deepEqual(cardIds(onlyBlocked), ['T-2'], '被阻塞只筛"依赖没完成"的那条：' + JSON.stringify(cardIds(onlyBlocked)))
		assert.ok(textOf(onlyBlocked).includes('被阻塞'), '卡片上标"被阻塞"')
		const onlyDepends = await act(
			harness,
			element.type,
			element.props,
			() => nodes(onlyBlocked).find((node) => node.props['data-tt-stage'] === 'depends').props.onClick(),
		)
		assert.deepEqual(cardIds(onlyDepends), ['T-2', 'T-4'], '有依赖连"依赖已完成的已完成任务"也算：' + JSON.stringify(cardIds(onlyDepends)))
		// ② 点「可认领」⇒ 只剩它那一张（筛选真的作用在卡上）
		const readyChip = stageChips.find((node) => node.props['data-tt-stage'] === 'ready')
		const onlyReady = await act(harness, element.type, element.props, () => readyChip.props.onClick())
		assert.deepEqual(cardIds(onlyReady), ['T-1'])
		// ③ 搜索落空 ⇒ 说清 + 一枚「清除筛选」；点它把筛选清回去
		const search = nodes(onlyReady).find((node) => node.type === 'input' && node.props['aria-label'] === '搜索本会话的团队任务')
		const noHit = await act(harness, element.type, element.props, () => search.props.onChange({ target: { value: 'zzz-查不到' } }))
		assert.ok(textOf(noHit).includes('没有匹配的条目'), '落空要说清：' + textOf(noHit).slice(0, 160))
		const clear = nodes(noHit).find((node) => node.props['data-filters-clear'] === 'board')
		assert.ok(clear !== undefined, '落空要给一枚清除动作')
		const cleared = await act(harness, element.type, element.props, () => clear.props.onClick())
		assert.deepEqual(cardIds(cleared), ['T-1', 'T-2', 'T-3', 'T-4'], '清完筛选四张卡都回来')
		// ④ 看板块不再印内页标题（人的指令：tab 栏上已经有名字了）
		const clearedHead = nodes(cleared).find((node) => node.type === 'div' && String(node.props.className).includes('cbv-view-head') && textOf(node.children).includes('任务看板'))
		assert.equal(clearedHead, undefined, '看板块不再有内页标题')
		// ⑤ 已撤的自建看板不再发请求（stubFetch 那侧对这条 URL 直接抛，能到这儿就说明没发）
		assert.deepEqual(
			fetchStub.calls.filter((call) => call.url === '/company-board/api' || call.url.startsWith('/company-board/api?')).map((call) => call.url),
			[],
			'自建看板那一档已撤 ⇒ 不该再拉它',
		)
		assert.deepEqual(
			fetchStub.calls.filter((call) => call.url.startsWith('/company-board/api/milestones')).map((call) => call.url),
			[],
			'里程碑清单随那一档一起撤了 ⇒ 不该再拉它',
		)
	} finally {
		fetchStub.restore()
	}
})

test('详情浮窗：打开时记住触发它的那张卡，关掉之后把焦点还回去；Tab 圈在浮窗内', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const teamTasks = {
		ok: true,
		available: true,
		reason: null,
		total: 1,
		counts: { pending: 1, in_progress: 0, completed: 0 },
		warnings: [],
		rows: [{ id: 'T-1', revision: 1, subject: '改 A', description: '', status: 'pending', ownerName: '', ready: true, blockedBy: [], writeScopes: [], writeScopeWarnings: [] }],
	}
	const kb = fakeKeyboard()
	const savedDoc = globalThis.document
	globalThis.document = kb.doc
	// 「触发浮窗的那张卡」：真浏览器里点/回车一张 `tabIndex=0` 的卡会把它变成 activeElement。
	const focused = []
	const trigger = {
		focus() {
			focused.push('trigger')
		},
		isConnected: true,
	}
	kb.doc.activeElement = trigger
	const { harness, fetchStub, element } = await (async () => {
		const mounted = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, teamTasks })
		return mounted
	})()
	try {
		let tree = await settle(harness, element.type, element.props)
		const onBoard = await act(harness, element.type, element.props, () => buttonWith(tree, '任务看板').props.onClick())
		const card = nodes(onBoard).find((node) => node.props['data-tt-id'] === 'T-1')
		assert.ok(card !== undefined, '看板上有 T-1 那张卡')
		// ① 打开：焦点移进浮窗（这一步本来就有），同时把"这张卡"记下来
		let opened = await act(harness, element.type, element.props, () => card.props.onClick())
		const modal = nodes(opened).find((node) => hasClass(node, 'cbv-modal'))
		assert.ok(modal !== undefined, '详情浮窗要开')
		let modalFocused = 0
		modal.props.ref.current = {
			focus() {
				modalFocused += 1
			},
			contains: () => false,
			querySelectorAll: () => [],
		}
		// ② 关掉（Esc）：焦点要回到那张卡上（从前掉到 body，键盘用户每次都要从头 Tab 回来）
		opened = await act(harness, element.type, element.props, () => kb.press('Escape'))
		assert.deepEqual(focused, ['trigger'], '关闭后焦点还给触发它的那张卡')
		assert.equal(nodes(opened).find((node) => hasClass(node, 'cbv-modal')), undefined, 'Esc 关掉浮窗')
		// ③ Tab 圈在浮窗内：焦点在最后一个可聚焦元素上再按 Tab ⇒ 回第一个（Shift+Tab 反向）
		tree = await act(harness, element.type, element.props, () => card.props.onClick())
		const modal2 = nodes(tree).find((node) => hasClass(node, 'cbv-modal'))
		const first = {
			tabIndex: 0,
			focus() {
				focused.push('first')
			},
		}
		const last = {
			tabIndex: 0,
			focus() {
				focused.push('last')
			},
		}
		modal2.props.ref.current = {
			focus() {},
			contains: (node) => node === first || node === last,
			querySelectorAll: () => [first, last],
		}
		kb.doc.activeElement = last
		kb.press('Tab')
		assert.deepEqual(focused.slice(-1), ['first'], '在最后一个上按 Tab ⇒ 圈回第一个')
		kb.doc.activeElement = first
		kb.press('Tab', { shiftKey: true })
		assert.deepEqual(focused.slice(-1), ['last'], '在第一个上按 Shift+Tab ⇒ 圈回最后一个')
	} finally {
		fetchStub.restore()
		globalThis.document = savedDoc
	}
})

test('界面文案里的 markdown 标记真的渲染掉了：四块的文本子节点里没有 ** 或反引号', async () => {
	// 判定条件与报告第 13 条同一口径：**元素文本子节点**里出现 `**` 或反引号即红
	//（`pre` 里是原文 —— 技能正文 / 提示词 —— 按原样印，不算）。
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	// 「名册还没建立」那一句（带 `**`）只在未建立时印 ⇒ 这里把它按未建立喂进去。
	members.defaults.established = false
	// 引擎 / 宿主自己写的那几行告警本来就是 markdown（带 `**` 与反引号）⇒ 也要渲染掉
	members.warnings = ['名册文件读不到：**这一行带标记**（`members`）—— 它本来就是 markdown。']
	const skills = { ok: true, workspace: '/w', layer: 'global', complete: true, total: 0, skills: [], warnings: ['退层读到的是**全局层**（`session` 那一层没读到）。'] }
	const teamTasks = {
		ok: true,
		available: true,
		reason: null,
		total: 1,
		counts: { pending: 1, in_progress: 0, completed: 0 },
		warnings: ['写盘面重叠：**只告警不拦**（`writeScopes` 是提示性声明）。'],
		rows: [{ id: 'T-1', revision: 1, subject: '改 A', description: '', status: 'pending', ownerName: '', ready: true, blockedBy: [], writeScopes: [], writeScopeWarnings: [] }],
	}
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, teamTasks })
	try {
		assert.deepEqual(literalMarkerTexts(tree), [], '成员块的文本子节点里不许有字面量标记')
		// 「名册还没建立」那一句现在在「角色」块里（角色目录已独立成一块）。
		const onRoles = await onRolesTab(harness, element, tree)
		assert.deepEqual(literalMarkerTexts(onRoles), [], '角色块的文本子节点里不许有字面量标记')
		assert.ok(textOf(onRoles).includes('一个人都还没叫过'), '那句「还没叫过」要在（只是标记渲染掉了）')
		const onSkills = await act(harness, element.type, element.props, () => buttonWith(onRoles, '技能').props.onClick())
		assert.deepEqual(literalMarkerTexts(onSkills), [], '技能块的文本子节点里不许有字面量标记')
		assert.ok(textOf(onSkills).includes('全局层') && textOf(onSkills).includes('没读到会话层的技能目录'), '退层那两句要在（只是标记渲染掉了）')
		const onBoard = await act(harness, element.type, element.props, () => buttonWith(tree, '任务看板').props.onClick())
		assert.deepEqual(literalMarkerTexts(onBoard), [], '任务看板的文本子节点里不许有字面量标记')
		assert.ok(textOf(onBoard).includes('只告警不拦'), '原生那条告警要在（只是标记渲染掉了）')
	} finally {
		fetchStub.restore()
	}
})

test('弹窗与浮窗里同样不留字面量标记：技能导入 / 删除确认 / 超长正文 / 删除说明', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace), hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const definition = { ...SKILLS_DEFINITION_PAYLOAD, truncated: true }
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition, services })
	try {
		const onSkills = await act(harness, element.type, element.props, () => buttonWith(tree, '技能').props.onClick())
		const cards = cardsOf(onSkills, 'cbv-sk-card')
		const writable = cards.find((card) => card.props['data-skill-source'] === 'user-dsh')
		// ① 导入弹窗：三条文件要求（带反引号 / `**`）+ 收完文件那一行读数（技能名带反引号）
		let opened = await act(harness, element.type, element.props, () => buttonWith(onSkills, '导入技能').props.onClick())
		let dialog = nodes(opened).find((node) => node.props['data-skill-dialog'] === 'import')
		assert.ok(dialog !== undefined, '导入弹窗要开')
		assert.deepEqual(literalMarkerTexts(dialog), [], '导入弹窗里不许有字面量标记')
		const bytes = new TextEncoder().encode('---\nname: demo-skill\ndescription: Use when demo.\n---\n\n正文\n')
		const file = { name: 'SKILL.md', arrayBuffer: async () => bytes.buffer }
		const zone = nodes(dialog).find((node) => node.props['data-skill-drop'] !== undefined)
		opened = await act(harness, element.type, element.props, () => zone.props.onDrop({ preventDefault() {}, dataTransfer: { items: [], files: [file] } }))
		dialog = nodes(opened).find((node) => node.props['data-skill-dialog'] === 'import')
		assert.ok(textOf(dialog).includes('技能名 =') && textOf(dialog).includes('demo-skill'), '收完文件那一行读数要在：' + textOf(dialog).slice(0, 200))
		assert.deepEqual(literalMarkerTexts(dialog), [], '收完文件那一行读数不许留字面量标记')
		// 关掉导入弹窗
		opened = await act(harness, element.type, element.props, () => buttonWith(dialog, '取消').props.onClick())
		// ② 删除确认：那句「删掉 `<名字>`（用户级技能根）…」
		const remove = nodes(writable).find((node) => node.props['data-skill-remove'] !== undefined)
		assert.ok(remove !== undefined, '可写来源的卡上有「删除」')
		opened = await act(harness, element.type, element.props, () => remove.props.onClick())
		const confirm = nodes(opened).find((node) => node.props['data-confirm-dialog'] === 'skills-remove')
		assert.ok(confirm !== undefined, '删除确认要开')
		assert.ok(textOf(confirm).includes('code-review'), '要印出删的是哪一个')
		assert.deepEqual(literalMarkerTexts(confirm), [], '删除确认里不许有字面量标记')
		// ③ 超长正文浮窗：那句「**截断后**」+ 来源那行（带反引号）
		const afterCancel = await act(harness, element.type, element.props, () => buttonWith(confirm, '取消').props.onClick())
		const cards2 = cardsOf(afterCancel, 'cbv-sk-card')
		const view = buttonWith(cards2[0], '查看正文')
		const openedViewer = await act(harness, element.type, element.props, () => view.props.onClick())
		const viewer = nodes(openedViewer).find((node) => node.props['data-skill-dialog'] === 'code-review')
		assert.ok(viewer !== undefined, '正文浮窗要开')
		assert.ok(textOf(viewer).includes('已截断'), '截断这件事要说出来：' + textOf(viewer).slice(0, 200))
		assert.deepEqual(literalMarkerTexts(viewer), [], '正文浮窗里不许有字面量标记（`pre` 里的原文除外）')
	} finally {
		fetchStub.restore()
	}
})

test('被原生按条数截断的字段：卡上说清「只列了前 N 条（共 M 条）」', async () => {
	// `blockedBy` / `writeScopes` 被砍到 16 条而面板看不出来时，会出现"列出来的依赖都满足、但这条仍是等依赖"
	// 这种读不通的话（`ready` 是原生按**全部**依赖算的）。载荷 `truncations` 逐条给出被截的字段 ⇒ 卡上照印。
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace), hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const teamTasks = {
		ok: true,
		available: true,
		reason: null,
		total: 2,
		counts: { pending: 1, in_progress: 1, completed: 0 },
		warnings: ['这条载荷里的 `blockedBy` 按条数截断过。'],
		truncations: [{ id: 'T-2', field: 'blockedBy', shown: 16, total: 20, limit: 16 }],
		rows: [
			{ id: 'T-1', revision: 1, subject: '改 A', description: '', status: 'pending', ownerName: '', ready: true, blockedBy: [], writeScopes: [], writeScopeWarnings: [] },
			{ id: 'T-2', revision: 2, subject: '改 B', description: '', status: 'in_progress', ownerName: 'revi-1', ready: false, blockedBy: ['T-1'], writeScopes: [], writeScopeWarnings: [] },
		],
	}
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, teamTasks })
	try {
		const onBoard = await act(harness, element.type, element.props, () => buttonWith(tree, '任务看板').props.onClick())
		const marked = nodes(onBoard).filter((node) => node.props['data-tt-truncated'] !== undefined)
		assert.deepEqual(marked.map((node) => node.props['data-tt-truncated']), ['blockedBy'], '被截的字段逐条印出来')
		assert.ok(textOf(marked[0]).includes('截断 blockedBy'), '折叠卡用标签说清哪个字段被截：' + textOf(marked[0]))
		// 只有被截的那一条（T-2）带这句；没被截的卡上不许出现
		const cardOf1 = nodes(onBoard).find((node) => node.props['data-tt-id'] === 'T-1')
		assert.ok(!textOf(cardOf1).includes('只列了前'), '没被截的卡不许印这句')
		// 浮窗里（同一张卡摊开）也看得见
		const opened = await act(harness, element.type, element.props, () => nodes(onBoard).find((node) => node.props['data-tt-id'] === 'T-2').props.onClick())
		assert.ok(textOf(opened).includes('只列了前 16 条（共 20 条）'), '浮窗里也要看得见')
	} finally {
		fetchStub.restore()
	}
})

test('状态块：端点说读不到时，面板要说出来（原生时不印）', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace), hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const unavailable = { ...STATUS_PAYLOAD, source: 'unavailable', sourceLine: '读不到本会话的看板：原生的任务板要一个**活着的会话**。' }
	const first = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, status: unavailable })
	try {
		const note = nodes(first.tree).find((node) => node.props['data-status-source'] !== undefined)
		assert.ok(note !== undefined, '读不到时要印一句来源')
		assert.equal(note.props['data-status-source'], 'unavailable')
		assert.ok(textOf(note).includes('读不到本会话的看板'), '要用端点给的原文：' + textOf(note))
		assert.equal(literalMarkerTexts(note).length, 0, '那一句里的标记要渲染掉')
	} finally {
		first.fetchStub.restore()
	}
	const second = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, status: { ...STATUS_PAYLOAD, source: 'native' } })
	try {
		assert.equal(nodes(second.tree).find((node) => node.props['data-status-source'] !== undefined), undefined, '原生那一档不用印这句')
	} finally {
		second.fetchStub.restore()
	}
})

test('子智能体对话里点开面板：四块都按**根会话**读（技能也不再退层告警）', async () => {
	// 现场：lead 对话里看得到两位成员；切到 fe-dev-1 那个子对话再看团队状态，面板按**子会话 id**
	// 去取团队凭据 ⇒ 子会话没在跑 ⇒ "会话 … 现在不活着，读不到它的 agent 名册"。
	// 修法：团队成员 / 任务 / 状态沿 `parentId` 折到**根会话**；技能目录按会话的层解析，仍用当前会话。
	const workspace = fixtureWorkspace()
	const ROOT = 'root-1'
	const list = {
		getSnapshot: () => ({
			ids: [ROOT, 'child-1'],
			byId: {
				[ROOT]: { id: ROOT, cwd: workspace, retainedBy: { mainView: 0 } },
				'child-1': { id: 'child-1', parentId: ROOT, origin: 'subagent', retainedBy: { mainView: 0 } },
			},
		}),
	}
	const rows = [
		{ id: ROOT, name: 'lead', role: 'lead', status: 'running', model: 'deepseek-flash', diagnostics: [] },
		{ id: 'child-1', name: 'fe-dev-1', role: 'teammate', status: 'inactive', description: '前端开发', provider: 'spawn', context: 'fresh', model: 'deepseek-flash', diagnostics: [] },
	]
	const services = {
		sessions: { list },
		...teamServices({ id: ROOT }, rows),
		skills: fakeRegistry([]),
		// 客户端权威的"当前会话" = 那个**子会话**（面板就是在这里被点开的）。
		uiSession: { current: { getSnapshot: () => ({ key: 'child-1' }) } },
	}
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=' + ROOT, hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// 默认成员块：卡片照画（说明团队那一份读到了根会话，而不是空）
		assert.equal(cardsOf(tree, 'cbv-mp-card').length, 2, '成员卡按根会话的名册画出来')
		const urls = () => fetchStub.calls.map((call) => call.url)
		assert.ok(
			urls().some((url) => url.startsWith('/company-board/api/status') && url.includes('session=' + ROOT)),
			'状态端点要按根会话读：' + JSON.stringify(urls()),
		)
		assert.ok(
			urls().some((url) => url.startsWith('/company-board/api/members') && url.includes('session=' + ROOT) && url.includes('workspace=' + encodeURIComponent(workspace))),
			'成员端点要按根会话读、且带上工作区：' + JSON.stringify(urls()),
		)
		assert.ok(!urls().some((url) => url.includes('session=child-1') && url.startsWith('/company-board/api/members')), '不许再拿子会话去取团队名册')
		// 任务看板 / 角色块也用根会话
		const onBoard = await act(harness, element.type, element.props, () => buttonWith(tree, '任务看板').props.onClick())
		assert.ok(urls().some((url) => url.startsWith('/company-board/api/team-tasks') && url.includes('session=' + ROOT)), '团队任务按根会话读')
		const onRoles = await onRolesTab(harness, element, onBoard)
		assert.ok(urls().some((url) => url.startsWith('/company-board/api/members') && url.includes('session=' + ROOT)), '角色块也按根会话读')
		// 技能也按**根会话**读：子会话没在跑时按子会话读，宿主只能退层（root-agent）并告警。
		const onSkills = await act(harness, element.type, element.props, () => buttonWith(onRoles, '技能').props.onClick())
		assert.ok(
			urls().some((url) => url.startsWith('/company-board/api/skills') && url.includes('session=' + ROOT)),
			'技能清单也要按根会话读：' + JSON.stringify(urls()),
		)
		assert.ok(!urls().some((url) => url.includes('session=child-1')), '面板不再拿子会话去取任何一块：' + JSON.stringify(urls()))
	} finally {
		fetchStub.restore()
	}
})

test('初次挂载：当前会话还没 publish 时先不取数（不拿旧会话去问「不活着」）', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	let key = ''
	const listeners = []
	const uiSession = { current: { getSnapshot: () => ({ key }), subscribe: (fn) => { listeners.push(fn); return () => {} } } }
	const services = { sessions: { list }, ...teamServices(), uiSession }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const urls = () => fetchStub.calls.map((call) => call.url)
		assert.ok(!urls().some((url) => url.startsWith('/company-board/api/members')), '还没 publish 当前会话时，不许拿回落 id 去问名册：' + JSON.stringify(urls()))
		key = 'sess-1'
		for (const fn of listeners) fn()
		const after = await act(harness, element.type, element.props, () => {})
		assert.ok(urls().some((url) => url.startsWith('/company-board/api/members') && url.includes('session=sess-1')), 'publish 之后要按真实会话取数：' + JSON.stringify(urls()))
		assert.ok(cardsOf(after, 'cbv-mp-card').length >= 1, '拿到权威会话后名册要画出来')
	} finally {
		fetchStub.restore()
	}
})

test('「角色」是独立一块：成员块不再挂角色目录，角色块里也没有锚点', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// ① **默认的成员块**：角色目录不在这里（人的指令：整节搬去「角色」块）。
		assert.equal(nodes(tree).find((node) => node.props['data-roster-count'] !== undefined), undefined, '成员块里不再挂角色目录')
		assert.ok(cardsOf(tree, 'cbv-mp-card').length > 0, '成员卡照旧在')
		const head = nodes(tree).find((node) => node.type === 'div' && String(node.props.className ?? '').includes('cbv-view-head') && textOf(node.children).includes('成员'))
		assert.equal(head, undefined, '成员块不再有内页标题')
		assert.ok(!textOf(tree).includes('角色（'), '也不再印「角色（N）」')
		// ② **切到「角色」块**：角色目录在那里，且没有锚点、也不画成员卡。
		const onRoles = await onRolesTab(harness, element, tree)
		const section = nodes(onRoles).find((node) => node.props['data-roster-count'] !== undefined)
		assert.ok(section !== undefined, '「角色」块里要有角色目录')
		assert.equal(nodes(onRoles).find((node) => node.props['data-roster-anchor'] !== undefined), undefined, '角色块头不再有锚点')
		// 保活渲染：切到「角色」后成员块仍挂载着（`hidden`）—— 判据只看**角色这一块**。
		const rolesPanel = nodes(onRoles).find((node) => node.props['data-panel-block'] === 'roles')
		assert.ok(rolesPanel !== undefined, '角色面板要在')
		assert.equal(cardsOf(rolesPanel, 'cbv-mp-card').length, 0, '角色块里不画成员卡')
		assert.ok(nodes(onRoles).find((node) => node.props['data-roles-mark'] !== undefined) !== undefined, '角色块带自己的形态标记')
	} finally {
		fetchStub.restore()
	}
})

test('落空与读失败都给人下一步：成员块落空给「清除筛选」，三处错误态各给「重读」', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const first = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const search = nodes(first.tree).find((node) => node.props['aria-label'] === '搜索成员')
		const empty = await act(first.harness, first.element.type, first.element.props, () => search.props.onChange({ target: { value: 'zzz-查不到' } }))
		assert.ok(textOf(empty).includes('没有匹配的条目'), '落空要说清没有匹配：' + textOf(empty).slice(0, 160))
		const clear = nodes(empty).find((node) => node.props['data-filters-clear'] === 'members')
		assert.ok(clear !== undefined, '落空要给一枚清除动作')
		const cleared = await act(first.harness, first.element.type, first.element.props, () => clear.props.onClick())
		assert.ok(cardsOf(cleared, 'cbv-mp-card').length > 0, '清完筛选卡都回来')
	} finally {
		first.fetchStub.restore()
	}

	// 三处错误态：每个都要有一枚能点的「重读」（从前恢复动作只挂在窗口 focus / 面板重新可见两条触发上）
	const second = await mountPane({
		members: { ok: false, error: '工作区取不到（假件）' },
		skills: { ok: false, error: '这个部署没有技能注册表（假件）' },
		status: { ok: false, error: '状态端点读不到（假件）' },
		definition: SKILLS_DEFINITION_PAYLOAD,
		services,
	})
	try {
		assert.ok(textOf(second.tree).includes('读不到状态：状态端点读不到（假件）'), '首屏那一行错误要在')
		const retries = () => nodes(second.tree).filter((node) => node.props['data-pane-retry'] !== undefined).map((node) => node.props['data-pane-retry'])
		assert.deepEqual(retries(), ['status', 'members'], '首屏 + 成员块各一枚')
		const membersRetry = nodes(second.tree).find((node) => node.props['data-pane-retry'] === 'members')
		const beforeMembers = second.fetchStub.calls.filter((call) => call.url.startsWith('/company-board/api/members')).length
		await act(second.harness, second.element.type, second.element.props, () => membersRetry.props.onClick())
		assert.ok(
			second.fetchStub.calls.filter((call) => call.url.startsWith('/company-board/api/members')).length > beforeMembers,
			'成员块的「重读」要真的再取一次',
		)
		const onSkills = await act(second.harness, second.element.type, second.element.props, () => buttonWith(second.tree, '技能').props.onClick())
		assert.ok(textOf(onSkills).includes('读不到技能目录：'), '技能那块的错误原文')
		const skillsRetry = nodes(onSkills).find((node) => node.props['data-pane-retry'] === 'skills')
		assert.ok(skillsRetry !== undefined, '技能那块也要给一枚「重读」')
	} finally {
		second.fetchStub.restore()
	}
})

test('「技能」块头只留标题（不再有与写动作打架的只读声明）', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace), hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const onSkills = await act(harness, element.type, element.props, () => buttonWith(tree, '技能').props.onClick())
		const head = nodes(onSkills).find((node) => node.type === 'div' && String(node.props.className).includes('cbv-view-head') && textOf(node.children).includes('技能'))
		// 人的指令：连内页标题也不印了（tab 栏上已经有「技能」）—— 于是既不自称"本栏只读"，也不重复块名
		assert.equal(head, undefined, '技能块不再有内页标题')
		assert.ok(!textOf(onSkills).includes('本栏只读（查看'), '不许再自称"本栏只读"')
		assert.ok(!textOf(onSkills).includes('清单与正文只读'), '那句注解也撤了')
		assert.ok(buttonWith(onSkills, '导入技能') !== undefined && buttonWith(onSkills, '新建技能') !== undefined, '同屏确实有写动作')
	} finally {
		fetchStub.restore()
	}
})

// ── 角色包：面板上的两个入口 + 常量对齐 + 先预览后落盘 ────────────────────────────

test('角色包：导出 / 导入在「角色」节头排，每张卡另有「导出这一个」', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices(), skills: fakeRegistry([]) }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	members.defaults = {
		available: true,
		excluded: [],
		count: 1,
		established: true,
		originFacets: [],
		rows: [
			{ role: 'cs', title: '客户支持', category: '客户', positioning: '对客户侧闭环负责。', skills: [], file: '/w/team-ops/roles/cs/ROLE.md', origin: 'workspace', originLabel: '项目级', removal: 'delete', state: 'vacant', present: [], archived: [], retired: [], removed: [], nextName: 'cs-1', label: '未到场' },
		],
	}
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// 角色目录已独立成一块 ⇒ 先切过去（默认落在成员块上）。
		const onRoles = await onRolesTab(harness, element, tree)
		const section = nodes(onRoles).find((node) => node.props['data-roster-count'] !== undefined)
		assert.ok(section !== undefined, '「角色」那一块要能定位')
		const actions = nodes(section)
			.filter((node) => node.props['data-roster-action'] !== undefined)
			.map((node) => node.props['data-roster-action'])
		assert.ok(actions.includes('export'), '头排要有「导出」：' + actions.join('、'))
		assert.ok(actions.includes('import'), '头排要有「导入」：' + actions.join('、'))
		assert.ok(actions.includes('export-one'), '每张角色卡要有「导出这一个」：' + actions.join('、'))
	} finally {
		fetchStub.restore()
	}
})

test('角色包：导出端点与宿主对齐（真按钮）；导入先预览、后落盘', async () => {
	const client = readFileSync('lib/board-view.client.js', 'utf8')
	// 宿主侧读**真实导出值**，不再扫源码里的常量声明写法。
	const { ROUTE_PATH, ROLES_EXPORT_PATH, ROLES_IMPORT_PATH } = await import('../lib/board-view.host.js')
	assert.equal(ROLES_EXPORT_PATH, ROUTE_PATH + '/roles/export', '宿主导出端点的路径要对齐前缀')
	assert.equal(ROLES_IMPORT_PATH, ROUTE_PATH + '/roles/import', '宿主导入端点的路径要对齐前缀')

	// **导出**：真点按钮，断言它把请求发到宿主导出的那个路径（不再扫客户端常量字面量）。
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices(), skills: fakeRegistry([]) }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	members.defaults = {
		available: true,
		excluded: [],
		count: 1,
		established: true,
		originFacets: [],
		rows: [
			{ role: 'cs', title: '客户支持', category: '客户', positioning: '对客户侧闭环负责。', skills: [], file: '/w/team-ops/roles/cs/ROLE.md', origin: 'workspace', originLabel: '项目级', removal: 'delete', state: 'vacant', present: [], archived: [], retired: [], removed: [], nextName: 'cs-1', label: '未到场' },
		],
	}
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const mounted = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const onRoles = await onRolesTab(mounted.harness, mounted.element, mounted.tree)
		const exportButton = nodes(onRoles).find((node) => node.props['data-roster-action'] === 'export')
		assert.ok(exportButton !== undefined, '「导出」按钮在')
		try {
			await act(mounted.harness, mounted.element.type, mounted.element.props, () => exportButton.props.onClick())
		} catch {
			// 假 DOM 没有下载链接（`savePack` 那一步）；请求在它之前已经发出，不影响下面的断言。
		}
		const exported = mounted.fetchStub.calls.find((call) => call.url.startsWith('/company-board/api/roles/export'))
		assert.ok(exported !== undefined, '导出按钮要真的请求导出端点：' + JSON.stringify(mounted.fetchStub.calls.map((call) => call.url)))
		assert.equal(exported.url.split('?')[0], ROLES_EXPORT_PATH, '客户端发的路径要与宿主导出路径一致')
	} finally {
		mounted.fetchStub.restore()
	}

	// 导入端点：客户端是单文件工厂、没有导出面，文件选择框也无法在假 DOM 里驱动 ⇒ 保留字面量对齐。
	assert.match(client, /const ROLES_IMPORT_ENDPOINT = API_PREFIX \+ '\/roles\/import'/, '客户端导入常量与宿主逐字对齐')
	// **先预览后落盘**：两个请求都发往同一个端点，区别就在请求体里那两格。
	const previewAt = client.indexOf('preview: true')
	const writeAt = client.indexOf('body: JSON.stringify({ pack: packDialog.text')
	assert.ok(previewAt > 0, '导入要先发一次预览（preview: true）')
	assert.ok(writeAt > previewAt, '落盘那一次必须在预览之后 —— 不预览不写')
	// 预览带作用域与冲突策略，落盘也带（人改的那两个选择要真的发上去）
	const previewBlock = client.slice(previewAt - 200, previewAt + 200)
	assert.ok(previewBlock.includes('scope: nextScope') && previewBlock.includes('onConflict: nextConflict'), '预览请求要带作用域与冲突策略')
})

// ── 交互改造（task-4）：保活 / tab 语义 / 四态 / 回执 / 确认 / 客户端自检 ─────────────

/** 造一份"三个动词都能做"的成员载荷（点下去真发请求那种）。 */
async function membersWithVerbs(workspace, services) {
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	for (const row of members.merged) {
		if (row.verbs === undefined) continue
		for (const verb of ['disable', 'restore', 'interrupt']) if (row.verbs[verb] !== undefined) row.verbs[verb] = { ok: true }
	}
	return members
}

const emptySkills = (workspace = '/w') => ({ ok: true, workspace, layer: 'session', complete: true, total: 0, skills: [], warnings: [] })

test('切块不丢上下文（设计 P-01 / 3.3）：保活渲染 + 搜索值保持 + 块壳状态标记', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	const searchOf = (current) => nodes(current).find((node) => node.props['aria-label'] === '搜索成员')
	const rootOf = (current) => nodes(current).find((node) => node.props['data-panel-tab'] !== undefined)
	try {
		// ① 块壳的机器可核标记（设计 5.4）
		const root = rootOf(tree)
		assert.equal(root.props['data-panel-tab'], 'members', '默认落成员')
		assert.equal(root.props['data-panel-scope'], workspace + '|sess-1', 'scope = 工作区 + 根会话')
		assert.deepEqual(root.props['data-panel-visiting'], 'members', '只挂载过成员块')
		// ② 在成员搜索框里输入 ⇒ 切到角色 ⇒ 切回来：输入值还在（块没被卸载）
		const typed = await act(harness, element.type, element.props, () => searchOf(tree).props.onChange({ target: { value: 'qa' } }))
		assert.equal(searchOf(typed).props.value, 'qa')
		const onRoles = await onRolesTab(harness, element, typed)
		const back = await act(harness, element.type, element.props, () => buttonWith(onRoles, '成员').props.onClick())
		assert.equal(searchOf(back).props.value, 'qa', '切回来输入框里仍是 qa（列表卸载过就会丢）')
		assert.equal(rootOf(back).props['data-panel-tab'], 'members')
		assert.ok(rootOf(back).props['data-panel-visiting'].split(' ').includes('roles'), '角色块已挂载过')
		assert.equal(rootOf(back).props['data-panel-visiting'], 'members roles', '已挂载块列表按首次激活顺序')
		// ③ 保活：两个 tabpanel 都在 DOM 里；非当前那一个 `hidden`
		const panels = nodes(back).filter((node) => node.props['data-panel-block'] !== undefined)
		assert.deepEqual(panels.map((panel) => panel.props['data-panel-block']), ['members', 'roles'])
		assert.equal(panels[0].props.role, 'tabpanel')
		assert.equal(panels[0].props.hidden, undefined, '当前块不 hidden')
		assert.equal(panels[1].props.hidden, true, '非当前块 hidden（不可聚焦）')
	} finally {
		fetchStub.restore()
	}
})

test('块切换的键盘路径（设计 A-06）：←/→ 循环、Home/End 到首尾，焦点留在 tab 上', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	const tabOf = (current, ledger) => nodes(current).find((node) => node.props['data-pane-block'] === ledger && node.props.role === 'tab')
	const key = (current, ledger, name) => act(harness, element.type, element.props, () => tabOf(current, ledger).props.onKeyDown({ key: name, preventDefault() {} }))
	try {
		let current = await key(tree, 'members', 'ArrowRight')
		assert.equal(nodes(current).find((node) => node.props['data-panel-tab'] !== undefined).props['data-panel-tab'], 'roles', '→ 下一块')
		current = await key(current, 'roles', 'End')
		assert.equal(nodes(current).find((node) => node.props['data-panel-tab'] !== undefined).props['data-panel-tab'], 'board', 'End 到末块')
		current = await key(current, 'board', 'ArrowRight')
		assert.equal(nodes(current).find((node) => node.props['data-panel-tab'] !== undefined).props['data-panel-tab'], 'members', '→ 循环回第一块')
		current = await key(current, 'members', 'ArrowLeft')
		assert.equal(nodes(current).find((node) => node.props['data-panel-tab'] !== undefined).props['data-panel-tab'], 'board', '← 循环到末块')
		current = await key(current, 'board', 'Home')
		assert.equal(nodes(current).find((node) => node.props['data-panel-tab'] !== undefined).props['data-panel-tab'], 'members', 'Home 到第一块')
		// roving tabindex：只有当前 tab 的 tabIndex = 0
		assert.deepEqual(nodes(current).filter((node) => node.props.role === 'tab').map((node) => node.props.tabIndex), [0, -1, -1, -1])
	} finally {
		fetchStub.restore()
	}
})

test('面板重开后恢复最后一块（设计 A-05）：sessionStorage 的键值与静默回落', async () => {
	const saved = globalThis.sessionStorage
	const store = new Map()
	globalThis.sessionStorage = {
		getItem: (key) => (store.has(key) ? store.get(key) : null),
		setItem: (key, value) => store.set(key, String(value)),
		removeItem: (key) => store.delete(key),
	}
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const first = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// ① 没有记录 ⇒ 成员块
		assert.equal(nodes(first.tree).find((node) => node.props['data-panel-tab'] !== undefined).props['data-panel-tab'], 'members')
		// ② 切到技能 ⇒ 记录写进 `dsh-team-ops:panel-tab`（scope = workspace|sess-1）
		const onSkills = await act(first.harness, first.element.type, first.element.props, () => buttonWith(first.tree, '技能').props.onClick())
		const savedMap = JSON.parse(store.get('dsh-team-ops:panel-tab'))
		assert.equal(savedMap[workspace + '|sess-1'], 'skills', '最后一块要落盘：' + JSON.stringify(savedMap))
		// ③ 重开面板（新装一次客户端）⇒ 恢复到技能块
		const second = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
		try {
			assert.equal(nodes(second.tree).find((node) => node.props['data-panel-tab'] !== undefined).props['data-panel-tab'], 'skills', '重开面板恢复最后一块')
			assert.equal(nodes(onSkills).filter((node) => node.props['data-panel-block'] !== undefined).length >= 1, true)
		} finally {
			second.fetchStub.restore()
		}
	} finally {
		first.fetchStub.restore()
		globalThis.sessionStorage = saved
	}
})

test('禁用动词的理由可在块顶回执里看到，且零请求（设计 P-05 / A-12）', async () => {
	const workspace = fixtureWorkspace()
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(teamServices()))
	const WHY = '这一档只剩它一位能干活：**同角色至少留 1 位未停用**'
	members.merged[1].verbs.disable = { ok: false, why: WHY }
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills: emptySkills(workspace), definition: SKILLS_DEFINITION_PAYLOAD, services: { sessions: { list } } })
	try {
		const button = nodes(tree).find((node) => node.props['data-member-verb'] === 'disable' && node.props['data-member-name'] === 'revi-1' && node.props['data-member-verb-ok'] === 'false')
		assert.ok(button !== undefined, '不可用的动词也要画出来')
		const before = fetchStub.calls.length
		const after = await act(harness, element.type, element.props, () => button.props.onClick())
		assert.equal(fetchStub.calls.length, before, '点不可用的动词**不发请求**')
		const notice = nodes(after).find((node) => node.props['data-notice-slot'] === 'members')
		assert.ok(notice !== undefined, '理由要进块顶回执')
		assert.equal(notice.props.role, 'status', '理由不是失败，用 status 播报')
		assert.ok(textOf(notice).includes('同角色至少留 1 位未停用'), '回执里是 why 原文（标记渲染掉）：' + textOf(notice))
	} finally {
		fetchStub.restore()
	}
})

test('写动作回执：失败 role=alert、保留旧数据、可重试；双击只发一次（设计 P-02 / A-09 / A-11）', async () => {
	const workspace = fixtureWorkspace()
	const members = await membersWithVerbs(workspace, teamServices())
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const { tree, harness, fetchStub, element } = await mountPane({
		members,
		skills: emptySkills(workspace),
		definition: SKILLS_DEFINITION_PAYLOAD,
		services: { sessions: { list } },
		post: { ok: false, error: '停用失败（假件）：服务端拒绝了。' },
	})
	try {
		const button = nodes(tree).find((node) => node.props['data-member-verb'] === 'disable')
		const before = fetchStub.calls.filter((call) => call.method === 'POST').length
		// 双击（同一轮里两次）⇒ 只发一次
		const after = await act(harness, element.type, element.props, () => {
			button.props.onClick()
			button.props.onClick()
		})
		const posts = fetchStub.calls.filter((call) => call.method === 'POST' && call.url.includes('/members/disable'))
		assert.equal(posts.length, before + 1, '双击只发一次 POST：' + JSON.stringify(fetchStub.calls.map((call) => call.url)))
		// 失败：alert + 原文 + 重试；列表与徽标不变（不做乐观更新）
		const notice = nodes(after).find((node) => node.props['data-notice-slot'] === 'members')
		assert.ok(notice !== undefined, '失败要有回执')
		assert.equal(notice.props.role, 'alert')
		assert.equal(notice.props['data-notice-tone'], 'error')
		assert.ok(textOf(notice).includes('停用失败（假件）：服务端拒绝了。'), '回执里是服务端原文：' + textOf(notice))
		assert.ok(nodes(notice).some((node) => node.props['data-notice-retry'] !== undefined), '失败给「重试」')
		assert.equal(cardsOf(after, 'cbv-mp-card').length, 2, '失败不改变列表')
		assert.equal(nodes(after).some((node) => node.props['data-mem-disabled'] === 'true'), false, '失败不改徽标')
		// 回执位置：工具栏之后、列表滚动区之前（同屏可见）
		const flat = nodes(after)
		const toolbarAt = flat.findIndex((node) => hasClass(node, 'cbv-flt-bar'))
		const noticeAt = flat.indexOf(notice)
		const scrollAt = flat.findIndex((node) => hasClass(node, 'cbv-scroll'))
		assert.ok(toolbarAt >= 0 && noticeAt > toolbarAt && noticeAt < scrollAt, `回执要夹在工具栏与列表之间（toolbar=${toolbarAt} notice=${noticeAt} scroll=${scrollAt}）`)
		// 重试：真的再发一次
		const retry = nodes(notice).find((node) => node.props['data-notice-retry'] !== undefined)
		await act(harness, element.type, element.props, () => retry.props.onClick())
		assert.equal(fetchStub.calls.filter((call) => call.method === 'POST' && call.url.includes('/members/disable')).length, before + 2, '「重试」再发一次')
	} finally {
		fetchStub.restore()
	}
})

test('打断要先确认：取消零 POST、Esc 可关（设计 P-03 / A-08）', async () => {
	const workspace = fixtureWorkspace()
	const members = await membersWithVerbs(workspace, teamServices())
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const kb = fakeKeyboard()
	const savedDoc = globalThis.document
	globalThis.document = kb.doc
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills: emptySkills(workspace), definition: SKILLS_DEFINITION_PAYLOAD, services: { sessions: { list } } })
	try {
		const button = nodes(tree).find((node) => node.props['data-member-verb'] === 'interrupt')
		const opened = await act(harness, element.type, element.props, () => button.props.onClick())
		const dialog = nodes(opened).find((node) => node.props['data-confirm-dialog'] === 'interrupt')
		assert.ok(dialog !== undefined, '打断要先出确认浮窗')
		assert.ok(textOf(dialog).includes('收件箱'), '确认正文说清收件箱保留')
		const cancel = nodes(dialog).find((node) => node.props['data-confirm-cancel'] !== undefined)
		assert.equal(cancel.props['data-autofocus'], '', '默认焦点在「取消」')
		const canceled = await act(harness, element.type, element.props, () => cancel.props.onClick())
		assert.equal(nodes(canceled).find((node) => node.props['data-confirm-dialog'] !== undefined), undefined, '取消即关窗')
		assert.equal(fetchStub.calls.filter((call) => call.method === 'POST' && call.url.includes('/members/interrupt')).length, 0, '取消 ⇒ 零 POST')
		// Esc 关
		await act(harness, element.type, element.props, () => button.props.onClick())
		const reopened = await settle(harness, element.type, element.props)
		assert.ok(nodes(reopened).find((node) => node.props['data-confirm-dialog'] === 'interrupt') !== undefined)
		kb.press('Escape')
		const closed = await settle(harness, element.type, element.props)
		assert.equal(nodes(closed).find((node) => node.props['data-confirm-dialog'] !== undefined), undefined, 'Esc 关确认浮窗')
		assert.equal(fetchStub.calls.filter((call) => call.method === 'POST' && call.url.includes('/members/interrupt')).length, 0, 'Esc ⇒ 零 POST')
	} finally {
		fetchStub.restore()
		globalThis.document = savedDoc
	}
})

test('智能体团队开关：GET 读本会话的团队模式（isEnabled），不再读 profile bundle', async () => {
	const lead = { id: 'sess-1' }
	const services = {
		agentTeams: { isEnabled: (agent) => agent === lead },
		agents: { get: (id) => (id === 'sess-1' ? lead : undefined) },
	}
	const payload = await endpoint('handleTeamService', '/company-board/api/team-service?session=sess-1', hostCtx(services))
	assert.equal(payload.ok, true)
	assert.equal(payload.service, true)
	assert.equal(payload.enabled, true, '开着时 enabled=true')
	assert.equal(payload.manager, undefined, '不再回 pluginManager 那一格')
	assert.equal(payload.bundle, undefined, '不再回 profile bundle 那一格')
})

test('智能体团队开关：POST 调 agentTeams.setEnabled(root, enabled)', async () => {
	const lead = { id: 'sess-1' }
	const calls = []
	const services = {
		agentTeams: {
			isEnabled: () => false,
			setEnabled: async (agent, enabled) => {
				calls.push({ agent, enabled })
			},
		},
		agents: { get: (id) => (id === 'sess-1' ? lead : undefined) },
	}
	const host = await import('../lib/board-view.host.js')
	const captured = { status: 0, body: '' }
	const res = { writeHead(status) { captured.status = status }, end(body) { captured.body = body } }
	const req = {
		method: 'POST',
		url: '/company-board/api/team-service?session=sess-1',
		on(event, handler) {
			if (event === 'data') queueMicrotask(() => handler(Buffer.from(JSON.stringify({ action: 'enable' }))))
			if (event === 'end') queueMicrotask(() => handler())
			return req
		},
	}
	await host.handleTeamService(hostCtx(services), req, res, null)
	assert.equal(captured.status, 200)
	const payload = JSON.parse(captured.body)
	assert.equal(payload.ok, true)
	assert.equal(payload.changed, true)
	assert.deepEqual(calls.map((call) => call.enabled), [true], '调的是 root + enable')
	assert.equal(calls[0].agent, lead, '传的是活着的 root Session')
})

test('智能体团队开关：服务不在时不冒充能开（回原因，不调 setEnabled）', async () => {
	const services = { agents: { get: () => undefined } }
	const host = await import('../lib/board-view.host.js')
	const captured = { status: 0, body: '' }
	const res = { writeHead(status) { captured.status = status }, end(body) { captured.body = body } }
	const req = {
		method: 'POST',
		url: '/company-board/api/team-service?session=sess-1',
		on(event, handler) {
			if (event === 'data') queueMicrotask(() => handler(Buffer.from(JSON.stringify({ action: 'enable' }))))
			if (event === 'end') queueMicrotask(() => handler())
			return req
		},
	}
	await host.handleTeamService(hostCtx(services), req, res, null)
	const payload = JSON.parse(captured.body)
	assert.equal(payload.ok, false)
	assert.equal(payload.service, false)
	assert.equal(payload.error, 'TEAM_SERVICE_MISSING')
	assert.ok(Array.isArray(payload.warnings) && payload.warnings.length > 0, '要把原因说出来')
})

test('团队服务开关：不再二次确认，点击直接 POST（人的口径）', async () => {
	const workspace = fixtureWorkspace()
	const teamOff = {
		ok: true,
		workspace,
		team: { available: false, reason: '这个部署没有 Agent Teams 服务', count: 0, rows: [] },
		merged: [],
		warnings: [],
	}
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const { tree, harness, fetchStub, element } = await mountPane({ members: teamOff, skills: emptySkills(workspace), definition: SKILLS_DEFINITION_PAYLOAD, services: { sessions: { list } }, teamService: { ok: true, service: true, enabled: false } })
	try {
		const enable = nodes(tree).find((node) => node.props['data-team-service'] === 'enable')
		assert.ok(enable !== undefined, '服务未启用时给启用入口')
		const postsOf = () => fetchStub.calls.filter((call) => call.method === 'POST' && call.url.includes('/team-service')).length
		const before = postsOf()
		const after = await act(harness, element.type, element.props, () => enable.props.onClick())
		assert.equal(postsOf(), before + 1, '点击即发请求（不再先弹确认）')
		assert.equal(nodes(after).find((node) => node.props['data-confirm-dialog'] !== undefined), undefined, '不弹确认浮窗')
	} finally {
		fetchStub.restore()
	}
})

test('智能体团队：名册读得到、模式关着 ⇒ 仍要给「启用」入口（现场：只有关闭、没有开启）', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	assert.equal(members.team.available, true, '前提：名册读得到（成员层迁 subagent 后，团队模式关着也可能读得到）')
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, fetchStub } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, teamService: { ok: true, service: true, enabled: false } })
	try {
		const enable = nodes(tree).find((node) => node.props['data-team-service'] === 'enable')
		assert.ok(enable !== undefined, '模式关着时要能开（不能因为名册读得到就只画关闭）')
		assert.ok(textOf(enable).includes('启用智能体团队'))
		assert.equal(nodes(tree).find((node) => node.props['data-team-service'] === 'disable'), undefined, '关着时不画关闭入口')
	} finally {
		fetchStub.restore()
	}
})

test('角色空态三分 + 导出前置禁用（设计 P-07 / P-12 / A-16 / A-22）', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices(), skills: fakeRegistry([]) }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	// ① 真空（有 `defaults`、0 个角色）⇒ 空态 + 添加入口；不得说成「宿主没有返回角色目录」。
	members.defaults = { available: true, excluded: [], count: 0, established: true, originFacets: [], rows: [] }
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const first = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const onRoles = await onRolesTab(first.harness, first.element, first.tree)
		const root = nodes(onRoles).find((node) => node.props['data-roles-mark'] !== undefined)
		assert.equal(root.props['data-roles-state'], 'empty')
		assert.ok(textOf(root).includes('角色目录里还没有角色。'), '空态说清"本来就没有"')
		assert.ok(!textOf(root).includes('这一版宿主没有返回角色目录'), '不得复用"没有返回角色目录"')
		assert.ok(nodes(root).some((node) => node.props['data-roster-action'] === 'add-empty'), '空态给「＋ 添加角色」')
		// 导出：没有自建角色 ⇒ aria-disabled + 一句原因；点击零 GET
		const exportButton = nodes(root).find((node) => node.props['data-roster-action'] === 'export')
		assert.equal(exportButton.props['aria-disabled'], 'true')
		const hint = nodes(root).find((node) => node.props['data-roles-export-hint'] !== undefined)
		assert.ok(hint !== undefined && textOf(hint).includes('没有可导出的自建角色（包内角色不随包走）'))
		const before = first.fetchStub.calls.filter((call) => call.url.includes('/roles/export')).length
		const afterClick = await act(first.harness, first.element.type, first.element.props, () => exportButton.props.onClick())
		assert.equal(first.fetchStub.calls.filter((call) => call.url.includes('/roles/export')).length, before, '前置禁用 ⇒ 零 GET')
		assert.ok(textOf(afterClick).includes('没有可导出的自建角色'), '点了要把原因说出来')
	} finally {
		first.fetchStub.restore()
	}

	// ② 没有 `defaults`（老宿主）⇒ unsupported，与 empty 分开。
	const noDefaults = { ...members }
	delete noDefaults.defaults
	const second = await mountPane({ members: noDefaults, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const onRoles = await onRolesTab(second.harness, second.element, second.tree)
		const root = nodes(onRoles).find((node) => node.props['data-roles-mark'] !== undefined)
		assert.equal(root.props['data-roles-state'], 'unsupported')
		assert.ok(textOf(root).includes('这一版宿主没有返回角色目录'))
	} finally {
		second.fetchStub.restore()
	}
})

test('四块的状态标记与骨架（设计 P-08 / P-06 / A-21 / A-22）', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// 成员块：phase=ready、state=ok、筛后 / 总数
		const memberRoot = nodes(tree).find((node) => node.props['data-members-mark'] !== undefined)
		assert.equal(memberRoot.props['data-members-phase'], 'ready')
		assert.equal(memberRoot.props['data-members-state'], 'ok')
		assert.equal(memberRoot.props['data-members-visible'], memberRoot.props['data-members-total'])
		// 搜索落空 ⇒ state=filtered
		const search = nodes(tree).find((node) => node.props['aria-label'] === '搜索成员')
		const filtered = await act(harness, element.type, element.props, () => search.props.onChange({ target: { value: 'zzz-不存在' } }))
		assert.equal(nodes(filtered).find((node) => node.props['data-members-mark'] !== undefined).props['data-members-state'], 'filtered')
		// 角色块 / 技能块 / 看板块：各自的 phase/state
		let current = await onRolesTab(harness, element, filtered)
		assert.equal(nodes(current).find((node) => node.props['data-roles-mark'] !== undefined).props['data-roles-state'], 'ok')
		current = await act(harness, element.type, element.props, () => buttonWith(current, '技能').props.onClick())
		const skillsState = nodes(current).find((node) => node.props['data-skills-mark'] !== undefined).props['data-skills-state']
		// 会话层 0 条 ⇒ empty；退层（global / root-agent）⇒ degraded（设计 5.2）。
		assert.equal(skillsState, skills.layer === 'session' ? 'empty' : 'degraded', '技能空态按读到的那一层分：' + String(skills.layer))
		current = await act(harness, element.type, element.props, () => buttonWith(current, '任务看板').props.onClick())
		const boardRoot = nodes(current).find((node) => node.props['data-board-mark'] !== undefined)
		assert.equal(boardRoot.props['data-board-phase'], 'ready')
		assert.equal(boardRoot.props['data-team-phase'], 'ready', '旧属性再留一个版本')
		assert.equal(boardRoot.props['data-board-state'], 'degraded', '假件没有团队服务 ⇒ degraded')
	} finally {
		fetchStub.restore()
	}
})

test('骨架延迟出现、数量固定（设计 5.3 / A-21）：加载中工具栏在、3 张卡骨架', async () => {
	const harness = loadClient()
	const seat = harness.seats.find((entry) => entry.options.name === 'conversation.view')
	const element = seat.component({ sessions: undefined, slots: undefined })
	const saved = globalThis.fetch
	// 成员端点**永不落地** ⇒ 停在 loading；技能 / 状态照常答。
	globalThis.fetch = async (url) => {
		const target = '' + url
		if (target.startsWith('/company-board/api/members')) return { status: 200, json: async () => new Promise(() => {}) }
		if (target.startsWith('/company-board/api/status')) return { status: 200, json: async () => STATUS_PAYLOAD }
		if (target.startsWith('/company-board/api/skills')) return { status: 200, json: async () => emptySkills('/w') }
		if (target.startsWith('/company-board/api/team-tasks')) return { status: 200, json: async () => ({ ok: true, available: false, reason: '假件', rows: [], warnings: [] }) }
		if (target.startsWith('/company-board/api/collab')) return { status: 200, json: async () => ({ ok: true, handoffs: [] }) }
		throw new Error('不该请求：' + target)
	}
	try {
		let tree = await settle(harness, element.type, element.props)
		const root = nodes(tree).find((node) => node.props['data-members-phase'] === 'loading')
		assert.ok(root !== undefined, '加载态落在 data 上')
		assert.equal(root.props['data-members-state'], 'ok')
		assert.ok(nodes(tree).some((node) => hasClass(node, 'cbv-flt-bar')), '加载中工具栏也在（位置不跳）')
		// 骨架延迟 120ms：等它出现
		await new Promise((resolve) => setTimeout(resolve, 160))
		tree = await settle(harness, element.type, element.props)
		const skeleton = nodes(tree).find((node) => node.props['data-skeleton'] === 'members')
		assert.ok(skeleton !== undefined, '120ms 后出现骨架')
		assert.equal(skeleton.props['aria-busy'], 'true')
		assert.equal(nodes(skeleton).filter((node) => hasClass(node, 'cbv-skel')).length, 3, '骨架固定 3 张')
	} finally {
		globalThis.fetch = saved
	}
})

test('「角色」选择框四态（设计 A-19）：加载骨架 / 空 / 筛空 / 错误（可重试）', async () => {
	const savedDoc = globalThis.document
	globalThis.document = fakeKeyboard().doc
	const list = { getSnapshot: () => ({ current: 'sess-1', byId: { 'sess-1': { id: 'sess-1', cwd: '/w', retainedBy: { mainView: 1 } } } }) }
	const props = () => ({ sessionId: 'sess-1', sessions: { list }, useInput: (select) => select({ draft: '' }), inputActions: { setDraft: () => {} } })
	const openPicker = async (payload, { pending = false } = {}) => {
		const harness = loadClient()
		const Entry = harness.seats.find((entry) => entry.options.name === 'conversation.input.left').component
		const saved = globalThis.fetch
		globalThis.fetch = async () => (pending ? { status: 200, json: async () => new Promise(() => {}) } : { status: 200, json: async () => payload })
		try {
			let tree = await act(harness, Entry, props(), () => {})
			const button = nodes(tree).find((node) => node.type === 'button' && hasClass(node, 'cbv-composer-btn'))
			tree = await act(harness, Entry, props(), () => button.props.onClick())
			return { tree, harness }
		} finally {
			globalThis.fetch = saved
		}
	}
	// ① 加载：3 行骨架，`aria-busy`，不显示「没有匹配」
	{
		const { tree } = await openPicker(null, { pending: true })
		const picker = nodes(tree).find((node) => node.props['data-composer-role-list'] !== undefined)
		assert.equal(picker.props['data-composer-phase'], 'loading')
		assert.equal(nodes(picker).filter((node) => hasClass(node, 'cbv-picker-skel-row')).length, 3)
		assert.ok(!textOf(picker).includes('没有匹配'))
	}
	// ② 空：读到且 0 个角色 ⇒ 与"读不到"分开，给下一步说明
	{
		const { tree } = await openPicker({ defaults: { rows: [] } })
		const picker = nodes(tree).find((node) => node.props['data-composer-role-list'] !== undefined)
		assert.equal(picker.props['data-composer-phase'], 'empty')
		assert.ok(textOf(picker).includes('角色目录里还没有角色。'))
		assert.ok(textOf(picker).includes('在「角色」块添加后'), '给一句下一步')
	}
	// ③ 筛空：有角色但搜不到 ⇒ 没有匹配 + 清除搜索（自建 harness，组件与渲染器必须是同一份）
	{
		const harness = loadClient()
		const Entry = harness.seats.find((entry) => entry.options.name === 'conversation.input.left').component
		const savedFetch = globalThis.fetch
		globalThis.fetch = async () => ({ status: 200, json: async () => ({ defaults: { rows: [{ role: 'qa', title: '测试', category: '质量' }] } }) })
		try {
			let tree = await act(harness, Entry, props(), () => {})
			const button = nodes(tree).find((node) => node.type === 'button' && hasClass(node, 'cbv-composer-btn'))
			tree = await act(harness, Entry, props(), () => button.props.onClick())
			const picker = nodes(tree).find((node) => node.props['data-composer-role-list'] !== undefined)
			assert.equal(picker.props['data-composer-phase'], 'ready')
			const search = nodes(tree).find((node) => node.props['data-composer-role-field'] === 'search')
			const typed = await act(harness, Entry, props(), () => search.props.onChange({ target: { value: 'zzz' } }))
			const filtered = nodes(typed).find((node) => node.props['data-composer-role-list'] !== undefined)
			assert.equal(filtered.props['data-composer-phase'], 'filtered')
			assert.ok(textOf(filtered).includes('没有匹配的角色。'))
			assert.ok(nodes(filtered).some((node) => node.props['data-composer-clear-search'] !== undefined), '给「清除搜索」')
		} finally {
			globalThis.fetch = savedFetch
		}
	}
	// ④ 错误：读不到 ⇒ 原文 + 重试（不显示成空）
	{
		const { tree } = await openPicker({ ok: false, error: '名册读不到（假件）' })
		const picker = nodes(tree).find((node) => node.props['data-composer-role-list'] !== undefined)
		assert.equal(picker.props['data-composer-phase'], 'error')
		assert.ok(textOf(picker).includes('读不到角色名册：名册读不到（假件）'))
		assert.ok(nodes(picker).some((node) => node.props['data-composer-retry'] !== undefined), '给「重试」')
	}
	globalThis.document = savedDoc
})

test('插入失败不关窗、给可复制提示（设计 A-20）', async () => {
	const harness = loadClient()
	const Entry = harness.seats.find((entry) => entry.options.name === 'conversation.input.left').component
	const savedDoc = globalThis.document
	const kb = fakeKeyboard()
	globalThis.document = kb.doc
	const savedFetch = globalThis.fetch
	globalThis.fetch = async () => ({ status: 200, json: async () => ({ defaults: { rows: [{ role: 'qa', title: '测试', category: '质量' }] } }) })
	const draft = '@qa 已经有一枚 chip'
	const list = { getSnapshot: () => ({ current: 'sess-1', byId: { 'sess-1': { id: 'sess-1', cwd: '/w', retainedBy: { mainView: 1 } } } }) }
	const scope = {
		get: (name) => (name === 'conversation' ? { input: { for: () => ({ state: { getSnapshot: () => ({ draft, occurrences: [{ offset: 0, length: 4 }], draftRev: 3 }) } }) } } : undefined),
		// 旧宿主：插引用 / 插文本都插不进去
		bail: () => false,
	}
	const props = () => ({ sessionId: 'sess-1', sessions: { list, scope: () => scope }, useInput: (select) => select({ draft }), inputActions: { setDraft: () => {} } })
	try {
		let tree = await act(harness, Entry, props(), () => {})
		const button = nodes(tree).find((node) => node.type === 'button' && hasClass(node, 'cbv-composer-btn'))
		tree = await act(harness, Entry, props(), () => button.props.onClick())
		const row = nodes(tree).find((node) => node.props['data-composer-role-id'] === 'qa')
		const after = await act(harness, Entry, props(), () => row.props.onClick())
		assert.ok(nodes(after).some((node) => node.props['data-composer-role-list'] !== undefined), '插入失败 ⇒ 选择框不关')
		const error = nodes(after).find((node) => node.props['data-composer-insert-error'] === 'qa')
		assert.ok(error !== undefined, '给可执行提示')
		assert.ok(textOf(error).includes('自己在输入框打 @qa'), textOf(error))
		assert.ok(nodes(error).some((node) => node.props['data-composer-copy-marker'] === 'qa'), '给「复制 @qa」')
	} finally {
		globalThis.fetch = savedFetch
		globalThis.document = savedDoc
	}
})

test('技能导入的客户端自检（设计 A-17）：501 文件 / 超 4MB / 无 SKILL.md 都先拦下', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	const skillsTab = await act(harness, element.type, element.props, () => buttonWith(tree, '技能').props.onClick())
	const tiny = () => { const bytes = new TextEncoder().encode('x'); return { name: 'a.md', webkitRelativePath: 'a/a.md', arrayBuffer: async () => bytes.buffer } }
	const drop = async (files) => {
		const opened = await act(harness, element.type, element.props, () => buttonWith(skillsTab, '导入技能').props.onClick())
		const zone = nodes(opened).find((node) => node.props['data-skill-drop'] !== undefined)
		const dropped = await act(harness, element.type, element.props, () => zone.props.onDrop({ preventDefault() {}, dataTransfer: { items: [], files } }))
		return { opened, dropped }
	}
	const dialogOf = (current) => nodes(current).find((node) => node.props['data-skill-dialog'] === 'import')
	try {
		// ① 没有 SKILL.md
		{
			const { dropped } = await drop([tiny()])
			const dialog = dialogOf(dropped)
			assert.ok(textOf(dialog).includes('这批里没有 SKILL.md。'), '缺 SKILL.md 要就地拦下：' + textOf(dialog))
			assert.equal(buttonWith(dialog, '确定').props.disabled, true, '自检不过 ⇒ 提交禁用')
			const cancel = buttonWith(dialog, '取消')
			await act(harness, element.type, element.props, () => cancel.props.onClick())
		}
		// ② 文件数 501 > 500
		{
			const files = Array.from({ length: 501 }, () => tiny())
			const { dropped } = await drop(files)
			const dialog = dialogOf(dropped)
			assert.ok(textOf(dialog).includes('上限 500'), '文件数超限要说明：' + textOf(dialog).slice(0, 200))
			assert.equal(buttonWith(dialog, '确定').props.disabled, true)
			await act(harness, element.type, element.props, () => buttonWith(dialog, '取消').props.onClick())
		}
		// ③ 字节数 > 4MB
		{
			const big = new Uint8Array(4 * 1024 * 1024 + 16)
			const files = [{ name: 'SKILL.md', webkitRelativePath: 'demo/SKILL.md', arrayBuffer: async () => big.buffer }]
			const { dropped } = await drop(files)
			const dialog = dialogOf(dropped)
			assert.ok(textOf(dialog).includes('上限 4 MB'), '体量超限要说明：' + textOf(dialog).slice(0, 200))
			assert.equal(buttonWith(dialog, '确定').props.disabled, true)
		}
	} finally {
		fetchStub.restore()
	}
})

test('角色表单失败不关窗、已填内容保留（设计 P-0x / A-14）', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices(), skills: fakeRegistry([]) }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({
		members,
		skills,
		definition: SKILLS_DEFINITION_PAYLOAD,
		services,
		post: { ok: false, error: '角色 id 已存在（假件）。' },
	})
	try {
		const onRoles = await onRolesTab(harness, element, tree)
		const add = nodes(onRoles).find((node) => node.props['data-roster-action'] === 'add')
		const opened = await act(harness, element.type, element.props, () => add.props.onClick())
		const idField = nodes(opened).find((node) => node.props['data-roster-field'] === 'id')
		const filled = await act(harness, element.type, element.props, () => idField.props.onChange({ target: { value: 'probe-role' } }))
		const titleField = nodes(filled).find((node) => node.props['data-roster-field'] === 'title')
		const titled = await act(harness, element.type, element.props, () => titleField.props.onChange({ target: { value: '探针角色' } }))
		const go = nodes(titled).find((node) => node.props['data-roster-submit'] === 'create')
		const failed = await act(harness, element.type, element.props, () => go.props.onClick())
		// 浮窗不关、错误在浮窗内、已填内容还在
		const dialog = nodes(failed).find((node) => node.props['data-roster-submit'] === 'create')
		assert.ok(dialog !== undefined, '失败时浮窗不关')
		assert.equal(nodes(failed).find((node) => node.props['data-roles-error'] !== undefined) !== undefined, true, '浮窗内显示服务端原文')
		assert.ok(textOf(failed).includes('角色 id 已存在（假件）。'))
		assert.equal(nodes(failed).find((node) => node.props['data-roster-field'] === 'id').props.value, 'probe-role', '已填内容保留')
		assert.equal(nodes(failed).find((node) => node.props['data-roster-field'] === 'title').props.value, '探针角色')
	} finally {
		fetchStub.restore()
	}
})

test('角色来源筛选落空：state=filtered + 清除筛选（设计 A-22）', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices(), skills: fakeRegistry([]) }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	members.defaults = {
		available: true,
		excluded: [],
		count: 1,
		established: true,
		originFacets: [
			{ key: 'workspace', label: '项目级', count: 1 },
			{ key: 'user', label: '用户级', count: 0 },
		],
		rows: [{ role: 'probe-ws', title: '项目角色', category: '质量', positioning: '探针。', file: '/w/roles/probe-ws/ROLE.md', origin: 'workspace', originLabel: '项目级', removal: 'delete', state: 'vacant', present: [], archived: [], retired: [], removed: [], nextName: 'probe-ws-1', label: '未到场' }],
	}
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const onRoles = await onRolesTab(harness, element, tree)
		const facet = nodes(onRoles).find((node) => node.props['data-roster-origin-facet'] !== undefined)
		const filtered = await act(harness, element.type, element.props, () => facet.props.onChange({ target: { value: 'user' } }))
		const root = nodes(filtered).find((node) => node.props['data-roles-mark'] !== undefined)
		assert.equal(root.props['data-roles-state'], 'filtered')
		assert.equal(root.props['data-roles-visible'], '0')
		assert.ok(textOf(filtered).includes('没有匹配的条目（共 1 条）。'))
		const clear = nodes(filtered).find((node) => node.props['data-filters-clear'] === 'roles')
		assert.ok(clear !== undefined, '给「清除筛选」')
		const cleared = await act(harness, element.type, element.props, () => clear.props.onClick())
		assert.equal(nodes(cleared).find((node) => node.props['data-roles-mark'] !== undefined).props['data-roles-state'], 'ok')
		assert.equal(nodes(cleared).find((node) => node.props['data-roster-role'] !== undefined).props['data-roster-role'], 'probe-ws')
	} finally {
		fetchStub.restore()
	}
})

// ── 输入框提示词增强（task-7）：点击直接替换 + 按钮变撤回，没有浮窗 ──────────────

/** 渲染 `conversation.input.right` 那一席，并给出可控的草稿 / setDraft。 */
function polishRig(options) {
	const config = options === undefined || options === null ? {} : options
	const harness = loadClient(config.services === undefined ? {} : config.services, config.seeds === undefined ? {} : config.seeds)
	const seat = harness.seats.find((entry) => entry.options.name === 'conversation.input.right')
	assert.ok(seat !== undefined, '没有注册 conversation.input.right 那一席')
	const state = { draft: config.draft === undefined ? '' : config.draft, setDraftCalls: [] }
	const props = () => ({
		sessionId: 'sess-1',
		...(config.sessions === undefined ? {} : { sessions: config.sessions }),
		...(config.useSessions === undefined ? {} : { useSessions: config.useSessions }),
		useInput: (select) => select({ draft: state.draft, draftRev: 1 }),
		inputActions: {
			setDraft: (next) => {
				state.setDraftCalls.push(next)
				state.draft = next
			},
		},
	})
	return { harness, seat, state, props }
}

/** 装一个立即回话的 fetch 桩（`payload` 可以直接给对象或函数）。 */
function polishFetchStub(reply) {
	const calls = []
	const original = globalThis.fetch
	globalThis.fetch = async (url, init) => {
		calls.push({ url: '' + url, method: init?.method, body: init?.body, signal: init?.signal, headers: init?.headers })
		return {
			status: reply.status === undefined ? 200 : reply.status,
			json: async () => (typeof reply.payload === 'function' ? reply.payload() : reply.payload),
		}
	}
	return {
		calls,
		restore() {
			globalThis.fetch = original
		},
	}
}

function polishButtonOf(tree) {
	return nodes(tree).find((node) => node.props['data-polish-button'] !== undefined)
}

const POLISH_ENHANCED_PAYLOAD = {
	ok: true,
	enhanced: '把 docs/plan.md 里的三条验收判据补成可执行的命令。',
	context: { chars: 3, layers: ['team', 'docs'] },
	checks: { ok: true, findings: [] },
	route: { provider: 'probe', model: 'm' },
	elapsedMs: 12,
	cached: false,
}

test('提示词增强：源码级契约（直接替换 / 撤回态 / 失败弹 ConfirmDialog / 旧浮窗与 diff 删除）', () => {
	const client = readFileSync('lib/board-view.client.js', 'utf8')
	const part = readFileSync('client-src/17-polish.part', 'utf8')
	// 端点与席位
	assert.match(client, /const POLISH_ENDPOINT = API_PREFIX \+ '\/polish'/, '端点常量要与宿主路径一致')
	assert.match(client, /ctx\.slots\.inject\('conversation\.input\.right'/, '席位注册在输入框右侧')
	assert.match(client, /name: 'conversation\.input\.right', id: 'company-polish', order: 100, label: '润色'/, '席位 id / order / label')
	// 新交互：成功直接 setDraft(enhanced)；按钮两态；撤回写回原文
	assert.match(part, /function PolishEntry\(props\)/, '组件入口')
	assert.match(part, /useInput/, '草稿来自标准 prop')
	assert.match(part, /setDraft\(data\.enhanced\)/, '成功后直接替换输入框')
	assert.match(part, /'data-polish-state': buttonState/, '按钮状态落在 data 上')
	assert.match(part, /canUndo \? '撤回润色' : errored \? '增强失败，点击重试' : '润色草稿'/, '三态的可访问名（润色 / 撤回 / 失败可重试）')
	assert.match(part, /setDraft\(original\)/, '撤回把增强前的原文写回')
	// 撤回后再点润色 = 重新生成一次：带 refresh:true 绕宿主结果缓存，且只生效一次。
	assert.match(part, /const refreshNext = React\.useRef\(false\)/, '记住"下一次要绕缓存"')
	assert.match(part, /if \(refreshNext\.current === true\) \{\s*refreshNext\.current = false\s*body\.refresh = true/, '下一次请求带 refresh:true 并复位')
	// 失败可见性：按钮进失败态（兜底），**并弹复用 ⑩ 的 ConfirmDialog**（文案按服务端 reason 映射）。
	assert.match(part, /function polishErrorIconOf\(\)/, '失败图标')
	assert.match(part, /polishErrorIconOf\(\) : polishIconOf\(\)/, '失败态换图标')
	assert.match(part, /'data-polish-state': buttonState/, '失败态落在 data 上')
	assert.match(part, /可以重试|点击重试/, '失败按钮的可访问名要说明可重试')
	assert.match(part, /setTimeout\(\(\) => \{\s*setPhase\('idle'\)\s*setErrorText\(''\)\s*\}, 4000\)/, '失败态 4 秒后自动收回')
	assert.match(part, /const body = \{ session: sessionId, text: textNow \}/, '请求体是 {session,text}')
	assert.match(part, /body\.workspace = workspace/, 'workspace 非空时随请求带上')
	assert.match(part, /'aria-label': label/, '按钮有 aria-label')
	assert.match(part, /className: 'cbv-sr-only'[\s\S]{0,80}role: 'status'/, '失败给一个 sr-only 读屏节点')
	assert.match(part, /console\.warn\('\[dsh-team-ops\] 提示词增强失败：' \+ message\)/, '失败写 console.warn')
	// 失败弹窗：按 reason 映射文案，复用通用 ConfirmDialog（slot=polish）。
	assert.match(part, /function polishFailureSpecOf\(status, data\)/, '失败原因 → 弹窗文案的映射函数')
	for (const reason of ['bad-request', 'too-vague', 'no-route', 'busy', 'rate-limited', 'timeout', 'upstream']) {
		assert.ok(part.includes("reason === '" + reason + "'"), '要覆盖服务端 reason：' + reason)
	}
	assert.match(part, /portalOf\(el\(ConfirmDialog, \{[\s\S]{0,320}slot: 'polish'/, '失败弹窗复用通用 ConfirmDialog，并 portal 到 body（fixed 才以视口为准）')
	assert.match(part, /open: failure !== null/, '弹窗开关由 failure 状态控制')
	assert.match(part, /data-polish-status/, '读屏节点保留')
	assert.match(part, /signal: controller\.signal/, '可 abort')
	assert.match(part, /sessionRef\.current === sessionId/, '切会话要 abort')
	// **删除**：浮窗 / diff / 采纳取消 / 重试 / 撤销按钮
	for (const gone of ['data-polish-dialog', 'data-polish-mark', 'data-polish-adopt', 'data-polish-cancel', 'data-polish-retry', 'data-polish-again', 'data-polish-undo', 'useModalA11y(', 'polishDiffOf', 'isTableRow']) {
		assert.ok(!part.includes(gone), '17-polish.part 不该再有旧 UI 残留：' + gone)
	}
	assert.ok(!/\.cbv-polish-(overlay|modal|text|mark|summary|foot)\b/.test(client), '旧浮窗 / diff 样式要删干净')
	// 单文件约束
	assert.ok(!/#[0-9a-fA-F]{3,8}/.test(part), '17-polish.part 不许有裸 hex')
	assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(part), '17-polish.part 不许有 emoji')
	assert.ok(!/\brequire\s*\(/.test(part), '不许 require 兄弟文件')
	// **17 排在 16 的 `return exports` 之后**：这一片只能有函数声明。
	assert.ok(!/^\t\t(?:const|let) /m.test(part), '17-polish.part 只许出现函数声明（它在 16 的 return 之后）')
})

test('提示词增强：空草稿不响应（零请求、零提示）', async () => {
	const rig = polishRig({ draft: '' })
	const stub = polishFetchStub({ payload: POLISH_ENHANCED_PAYLOAD })
	try {
		let tree = await act(rig.harness, rig.seat.component, rig.props(), () => {})
		const button = polishButtonOf(tree)
		assert.ok(button !== undefined, '按钮要在')
		assert.equal(button.props['aria-label'], '润色草稿')
		assert.equal(button.props.type, 'button')
		assert.equal(button.props['aria-disabled'], 'true', '空草稿视觉禁用')
		assert.equal(button.props['data-polish-state'], 'idle')
		tree = await act(rig.harness, rig.seat.component, rig.props(), () => button.props.onClick())
		assert.equal(stub.calls.length, 0, '空草稿点击零请求')
		assert.equal(rig.state.setDraftCalls.length, 0, '空草稿不碰草稿')
		assert.equal(textOf(tree).trim(), '', '空草稿点击不弹任何提示：' + JSON.stringify(textOf(tree)))
	} finally {
		stub.restore()
	}
})

test('提示词增强：成功后直接替换草稿；按钮变「撤回」且撤回写回原文', async () => {
	const rig = polishRig({ draft: '把那个啥弄一下' })
	const stub = polishFetchStub({ payload: POLISH_ENHANCED_PAYLOAD })
	try {
		let tree = await act(rig.harness, rig.seat.component, rig.props(), () => {})
		const clicked = await act(rig.harness, rig.seat.component, rig.props(), () => polishButtonOf(tree).props.onClick())
		// 请求形状：一次 POST、body 是 {session,text}
		assert.equal(stub.calls.length, 1)
		assert.equal(stub.calls[0].url, '/company-board/api/polish')
		assert.equal(stub.calls[0].method, 'POST')
		assert.deepEqual(JSON.parse(stub.calls[0].body), { session: 'sess-1', text: '把那个啥弄一下' })
		assert.ok(stub.calls[0].signal !== undefined && stub.calls[0].signal !== null, '要能 abort（带 signal）')
		// **不弹浮窗**：直接替换草稿
		assert.deepEqual(rig.state.setDraftCalls, [POLISH_ENHANCED_PAYLOAD.enhanced], '成功即 setDraft(enhanced)')
		assert.equal(nodes(clicked).find((node) => node.props['data-polish-dialog'] !== undefined), undefined, '不再有浮窗')
		const undoButton = polishButtonOf(clicked)
		assert.equal(undoButton.props['aria-label'], '撤回润色', '按钮变撤回')
		assert.equal(undoButton.props['data-polish-state'], 'enhanced')
		assert.equal(undoButton.props.type, 'button')
		// 撤回：把增强前的原文写回去
		const undone = await act(rig.harness, rig.seat.component, rig.props(), () => undoButton.props.onClick())
		assert.deepEqual(rig.state.setDraftCalls, [POLISH_ENHANCED_PAYLOAD.enhanced, '把那个啥弄一下'], '撤回 = 写回原文')
		const back = polishButtonOf(undone)
		assert.equal(back.props['aria-label'], '润色草稿', '撤回后按钮回润色态')
		assert.equal(back.props['data-polish-state'], 'idle')
		// 撤回后再点润色 ⇒ 第二次请求要带 refresh:true（真的重新生成，而不是命中 3 分钟缓存）。
		await act(rig.harness, rig.seat.component, rig.props(), () => back.props.onClick())
		assert.equal(stub.calls.length, 2, '撤回后再点要再发一次请求')
		assert.equal(JSON.parse(stub.calls[1].body).refresh, true, '第二次请求要带 refresh:true')
	} finally {
		stub.restore()
	}
})

test('提示词增强：草稿被手动改动后撤回失效，按钮回润色态', async () => {
	const rig = polishRig({ draft: '把那个啥弄一下' })
	const stub = polishFetchStub({ payload: POLISH_ENHANCED_PAYLOAD })
	try {
		let tree = await act(rig.harness, rig.seat.component, rig.props(), () => {})
		tree = await act(rig.harness, rig.seat.component, rig.props(), () => polishButtonOf(tree).props.onClick())
		assert.equal(polishButtonOf(tree).props['aria-label'], '撤回润色')
		// 人在这期间手动改了草稿
		rig.state.draft = '我自己又写了一句'
		const edited = await act(rig.harness, rig.seat.component, rig.props(), () => {})
		const button = polishButtonOf(edited)
		assert.equal(button.props['aria-label'], '润色草稿', '手动改动 ⇒ 撤回失效')
		assert.equal(button.props['data-polish-state'], 'idle')
		// 再点就是**重新增强当前草稿**，不是撤回
		const stub2 = stub
		await act(rig.harness, rig.seat.component, rig.props(), () => button.props.onClick())
		assert.equal(stub2.calls.length, 2, '撤回失效后点击重新发请求')
		assert.deepEqual(JSON.parse(stub2.calls[1].body), { session: 'sess-1', text: '我自己又写了一句' })
	} finally {
		stub.restore()
	}
})

test('提示词增强：标签草稿的 too-vague 也弹 ConfirmDialog（知道了，不重试）', async () => {
	const rig = polishRig({ draft: '英文需求：' })
	const stub = polishFetchStub({ status: 400, payload: { ok: false, error: '草稿只有标签，没有可改写的具体内容：先写清要改什么。', reason: 'too-vague' } })
	try {
		let tree = await act(rig.harness, rig.seat.component, rig.props(), () => {})
		tree = await act(rig.harness, rig.seat.component, rig.props(), () => polishButtonOf(tree).props.onClick())
		assert.equal(stub.calls.length, 1, '客户端只发一次请求；服务端 400 后不再发')
		const dialog = nodes(tree).find((node) => node.props['data-confirm-dialog'] === 'polish')
		assert.ok(dialog !== undefined, 'too-vague 要弹 ConfirmDialog')
		assert.ok(textOf(tree).includes('草稿太短'), '标题按 too-vague 映射：' + textOf(tree))
		assert.ok(textOf(tree).includes('先写清要改什么'), '正文给出下一步')
		const go = nodes(tree).find((node) => node.props['data-confirm-go'] !== undefined)
		assert.equal(textOf(go), '知道了', '配置 / 输入类问题不给重试')
		const closed = await act(rig.harness, rig.seat.component, rig.props(), () => go.props.onClick())
		assert.equal(nodes(closed).find((node) => node.props['data-confirm-dialog'] === 'polish'), undefined, '点知道了关闭')
		assert.equal(stub.calls.length, 1, '「知道了」不重发')
	} finally {
		stub.restore()
	}
})

test('提示词增强：失败弹 ConfirmDialog（文案按 reason），按钮失败态与读屏保留', async () => {
	const rig = polishRig({ draft: '把那个啥弄一下' })
	const stub = polishFetchStub({ status: 409, payload: { ok: false, error: '没有可用路由（假件）', reason: 'no-route' } })
	const warns = []
	const originalWarn = console.warn
	console.warn = (...args) => warns.push(args.map((item) => '' + item).join(' '))
	try {
		let tree = await act(rig.harness, rig.seat.component, rig.props(), () => {})
		tree = await act(rig.harness, rig.seat.component, rig.props(), () => polishButtonOf(tree).props.onClick())
		assert.equal(stub.calls.length, 1)
		assert.equal(rig.state.setDraftCalls.length, 0, '失败不碰草稿')
		// 按钮失败态保留（兜底 + 4 秒后收回），但失败原因不再只藏在这里。
		const button = polishButtonOf(tree)
		assert.equal(button.props['data-polish-state'], 'error', '失败态要画在按钮上')
		assert.equal(button.props['aria-label'], '增强失败，点击重试', '失败按钮说明可重试')
		assert.ok(String(button.props.title).includes('没有可用路由（假件）'), '原生 title 里要有原因原文：' + button.props.title)
		assert.ok(hasClass(button, 'cbv-polish-btn--error'), '失败态有错误配色类')
		// 弹窗：复用通用 ConfirmDialog，标题/正文按 reason 映射。
		const dialog = nodes(tree).find((node) => node.props['data-confirm-dialog'] === 'polish')
		assert.ok(dialog !== undefined, '失败要弹 ConfirmDialog（data-confirm-dialog=polish）')
		assert.ok(textOf(tree).includes('还没有可用的模型路由'), '标题按 no-route 映射：' + textOf(tree))
		assert.ok(textOf(tree).includes('没有可用路由（假件）'), '正文用服务端 error 原文：' + textOf(tree))
		assert.ok(textOf(tree).includes('先在本会话发一条消息'), '正文给出下一步')
		const go = nodes(tree).find((node) => node.props['data-confirm-go'] !== undefined)
		assert.ok(go !== undefined, '弹窗要有主按钮')
		assert.equal(textOf(go), '知道了', 'no-route 不值得重试 ⇒ 主按钮是「知道了」')
		// 「知道了」只关弹窗、不重发请求。
		const closed = await act(rig.harness, rig.seat.component, rig.props(), () => go.props.onClick())
		assert.equal(nodes(closed).find((node) => node.props['data-confirm-dialog'] === 'polish'), undefined, '点知道了关闭弹窗')
		assert.equal(stub.calls.length, 1, '「知道了」不重发请求')
		// 旧的提示条 / 就地提示仍然不许复活。
		assert.equal(nodes(tree).filter((node) => hasClass(node, 'cbv-notice')).length, 0, '失败不弹提示条')
		assert.equal(nodes(tree).filter((node) => hasClass(node, 'cbv-polish-hint')).length, 0, '失败不弹就地提示')
		assert.equal(warns.length, 1, '失败只 warn 一次：' + JSON.stringify(warns))
		assert.ok(warns[0].startsWith('[dsh-team-ops] 提示词增强失败：'), warns[0])
		const live = nodes(tree).find((node) => node.props.role === 'status' && node.props.className === 'cbv-sr-only')
		assert.ok(live !== undefined, '要有一个 sr-only role=status 节点')
		assert.ok(textOf(live).includes('没有可用路由（假件）'), '读屏节点里是原因原文：' + textOf(live))
		// 失败态按钮仍可点击重试：再点一次要真的再发一次请求，并再次弹窗。
		const retried = await act(rig.harness, rig.seat.component, rig.props(), () => polishButtonOf(closed).props.onClick())
		assert.equal(stub.calls.length, 2, '失败态点击 = 重试')
		assert.ok(nodes(retried).find((node) => node.props['data-confirm-dialog'] === 'polish') !== undefined, '重试再失败 ⇒ 弹窗再次出现')
	} finally {
		stub.restore()
		console.warn = originalWarn
	}
})

test('提示词增强：失败弹窗 portal 到 document.body（fixed 不再被输入框包含块带偏）', async () => {
	// 现场：弹窗贴着输入框、不跟整体框架对齐 —— 这一席在宿主的 `conversation.input.right` 里，
	// 已激活会话的 `.composerSeat` 带 `will-change: transform`（给后代造包含块），`position:fixed`
	// 的遮罩不再相对视口。修法与「角色」选择框同一条：`portalOf` 到 `document.body`。
	const savedDoc = globalThis.document
	const fakeDoc = { body: { appendChild() {}, removeChild() {} } }
	globalThis.document = fakeDoc
	const portals = []
	const reactDom = {
		createPortal(node, container, key) {
			portals.push({ node, container, key })
			return node
		},
	}
	const stub = polishFetchStub({ status: 409, payload: { ok: false, error: '没有可用路由（假件）', reason: 'no-route' } })
	try {
		const rig = polishRig({ draft: '把那个啥弄一下', seeds: { 'react-dom': reactDom } })
		let tree = await act(rig.harness, rig.seat.component, rig.props(), () => {})
		tree = await act(rig.harness, rig.seat.component, rig.props(), () => polishButtonOf(tree).props.onClick())
		assert.ok(portals.length > 0, '失败弹窗必须走 createPortal')
		assert.ok(portals.every((call) => call.container === fakeDoc.body), '每一次 portal 的容器都是 document.body（fixed 从此以视口为准）')
		assert.ok(
			portals.every((call) => call.node !== null && typeof call.node === 'object' && call.node.props !== undefined && call.node.props.slot === 'polish'),
			'portal 出去的是 ConfirmDialog（slot=polish）',
		)
		assert.ok(nodes(tree).find((node) => node.props['data-confirm-dialog'] === 'polish') !== undefined, '渲染树里仍然看得到弹窗（fake createPortal 原样返回）')
	} finally {
		stub.restore()
		globalThis.document = savedDoc
	}
})

test('提示词增强：可重试的失败（timeout）主按钮是「重试」，点它真的再发一次', async () => {
	const rig = polishRig({ draft: '把那个啥弄一下' })
	const calls = []
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (url, init) => {
		calls.push({ url: '' + url, init })
		return { status: 504, json: async () => ({ ok: false, error: '润色超时：模型没有在时限内回完，可以重试一次。', reason: 'timeout' }) }
	}
	try {
		let tree = await act(rig.harness, rig.seat.component, rig.props(), () => {})
		tree = await act(rig.harness, rig.seat.component, rig.props(), () => polishButtonOf(tree).props.onClick())
		assert.equal(calls.length, 1)
		assert.ok(textOf(tree).includes('润色超时'), '标题按 timeout 映射：' + textOf(tree))
		assert.ok(textOf(tree).includes('可以重试一次'), '正文用服务端 error 原文')
		const go = nodes(tree).find((node) => node.props['data-confirm-go'] !== undefined)
		assert.equal(textOf(go), '重试', 'timeout 值得重试')
		const again = await act(rig.harness, rig.seat.component, rig.props(), () => go.props.onClick())
		assert.equal(calls.length, 2, '点「重试」要真的再发一次')
		assert.ok(nodes(again).find((node) => node.props['data-confirm-dialog'] === 'polish') !== undefined, '再次失败 ⇒ 弹窗还在')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('提示词增强：请求中重复点击不重发；成功前按钮禁用', async () => {
	const rig = polishRig({ draft: '把那个啥弄一下' })
	const originalFetch = globalThis.fetch
	const calls = []
	let finish = null
	globalThis.fetch = (url, init) => {
		calls.push({ url: '' + url, init })
		return new Promise((resolve) => {
			finish = () => resolve({ status: 200, json: async () => POLISH_ENHANCED_PAYLOAD })
		})
	}
	try {
		let tree = await act(rig.harness, rig.seat.component, rig.props(), () => {})
		const button = polishButtonOf(tree)
		const pending = await act(rig.harness, rig.seat.component, rig.props(), () => {
			button.props.onClick()
			button.props.onClick()
		})
		assert.equal(calls.length, 1, '同一轮里点两次只发一次')
		const busyButton = polishButtonOf(pending)
		assert.equal(busyButton.props.disabled, true, '请求中按钮禁用')
		assert.equal(busyButton.props['data-polish-state'], 'requesting')
		finish()
		const done = await settle(rig.harness, rig.seat.component, rig.props())
		assert.equal(polishButtonOf(done).props['aria-label'], '撤回润色', '完成后变撤回态')
		assert.deepEqual(rig.state.setDraftCalls, [POLISH_ENHANCED_PAYLOAD.enhanced])
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('提示词增强：workspace 来自 useSessions 并随请求带给宿主', async () => {
	const rig = polishRig({
		draft: '把那个啥弄一下',
		useSessions: (select) => select({ byId: { 'sess-1': { id: 'sess-1', cwd: '/Volumes/ME/probe' } } }),
	})
	const stub = polishFetchStub({ payload: POLISH_ENHANCED_PAYLOAD })
	try {
		const tree = await act(rig.harness, rig.seat.component, rig.props(), () => {})
		await act(rig.harness, rig.seat.component, rig.props(), () => polishButtonOf(tree).props.onClick())
		assert.deepEqual(JSON.parse(stub.calls[0].body), { session: 'sess-1', text: '把那个啥弄一下', workspace: '/Volumes/ME/probe' }, 'workspace 要随请求带上')
	} finally {
		stub.restore()
	}
})

// ── 顶栏提示（打开项目 / 复制路径 的回执）：2 秒自动隐藏 + 悬停暂停 ─────────────
// 人报的问题：团队状态栏里那条提示出现后一直不消失（`notice` 只在下一次动作时被覆盖）。

test('顶栏提示：源码级契约（2 秒自动隐藏 / 悬停暂停 / 移开续计）', () => {
	const part = readFileSync('client-src/10-status.part', 'utf8')
	assert.match(part, /const NOTICE_AUTO_HIDE_MS = 2000/, '自动隐藏 2000ms')
	assert.match(part, /noticeArmTimer\(NOTICE_AUTO_HIDE_MS\)/, '提示出现即起倒计时')
	assert.match(part, /if \(noticeHoverRef\.current === true\) return\s*\n\s*setNotice\(null\)/, '悬停期间到点也不藏')
	assert.match(part, /onMouseEnter: noticePause/, '悬停暂停计时')
	assert.match(part, /onMouseLeave: noticeResume/, '移开继续计时')
	assert.match(part, /'data-panel-notice': ''/, '提示节点有稳定选择器')
})

test('顶栏提示：出现后 2 秒自动隐藏；悬停时暂停、移开后从剩余时间继续', async () => {
	const { tree, harness, element } = await mountPane({ members: null, skills: null, definition: null })
	// 挂载用的是真实计时器（settle 依赖 setTimeout(0)）；到这一步换成一个**手摇时钟**验倒计时。
	const realSetTimeout = globalThis.setTimeout
	const realClearTimeout = globalThis.clearTimeout
	let fakeNow = 0
	let timerSeq = 0
	const fakeTimers = new Map()
	globalThis.setTimeout = (fn, delay, ...args) => {
		timerSeq += 1
		fakeTimers.set(timerSeq, { fn, args, at: fakeNow + Number(delay ?? 0) })
		return timerSeq
	}
	globalThis.clearTimeout = (id) => {
		fakeTimers.delete(id)
	}
	const tick = (ms) => {
		fakeNow += ms
		for (const [id, timer] of [...fakeTimers.entries()].sort((left, right) => left[1].at - right[1].at)) {
			if (timer.at > fakeNow) continue
			fakeTimers.delete(id)
			timer.fn(...timer.args)
		}
	}
	try {
		const flushMicro = async () => {
			for (let i = 0; i < 8; i += 1) await Promise.resolve()
		}
		const renderNow = () => {
			harness.renderer.takeDirty()
			const next = harness.renderer.render(element.type, element.props)
			harness.renderer.flushEffects()
			return next
		}
		const projectButtonOf = (node) =>
			nodes(node).find((entry) => typeof entry.props.title === 'string' && entry.props.title.startsWith('点开：'))
		const noticeOf = (node) => nodes(node).find((entry) => entry.props['data-panel-notice'] !== undefined)

		// ① 点项目按钮 → 顶栏出现提示
		const button = projectButtonOf(tree)
		assert.ok(button !== undefined, '顶栏要有开着项目路径的那枚按钮')
		button.props.onClick()
		await flushMicro()
		let current = renderNow()
		const shown = noticeOf(current)
		assert.ok(shown !== undefined, '动作后应出现顶栏提示')
		assert.ok(textOf(shown).includes('已在本机打开：'), '提示内容：' + textOf(shown))

		// ② 1999ms 还在，2000ms 自动隐藏
		tick(1999)
		current = renderNow()
		assert.ok(noticeOf(current) !== undefined, '不到 2 秒不许消失')
		tick(1)
		current = renderNow()
		assert.equal(noticeOf(current), undefined, '满 2 秒要自动隐藏')

		// ③ 悬停暂停：再次触发 → 悬停 → 过 5 秒也不消失；移开后 2 秒内消失
		projectButtonOf(current).props.onClick()
		await flushMicro()
		current = renderNow()
		const again = noticeOf(current)
		assert.ok(again !== undefined, '第二次动作也要出现提示')
		again.props.onMouseEnter()
		tick(5000)
		current = renderNow()
		assert.ok(noticeOf(current) !== undefined, '悬停期间暂停计时，不许消失')
		noticeOf(current).props.onMouseLeave()
		tick(2100)
		current = renderNow()
		assert.equal(noticeOf(current), undefined, '移开后从剩余时间继续计时并隐藏')
	} finally {
		globalThis.setTimeout = realSetTimeout
		globalThis.clearTimeout = realClearTimeout
	}
})

// ── 成员块回执：成功类 2 秒自动隐藏（悬停暂停、移开续计）────────────────────────
// 人的现场：「团队服务已启用（@deepseek-ai/…）。」那一行提示显示后一直不消失。
// 实现放在共用回执条 `NoticeBar` 的可选 `autoHideMs` 上；**只有成员块的成功回执开启**，
// 失败回执（带重试）与角色 / 技能块的回执保持原行为。

test('回执条自动隐藏：NoticeBar 支持 autoHideMs（悬停暂停）；成员 / 角色 / 技能块成功回执都开启', () => {
	const status = readFileSync('client-src/10-status.part', 'utf8')
	const members = readFileSync('client-src/12-members.part', 'utf8')
	const roles = readFileSync('client-src/13-roles.part', 'utf8')
	const skills = readFileSync('client-src/14-skills.part', 'utf8')
	assert.match(status, /const autoHideMs = typeof props\.autoHideMs === 'number'/, 'NoticeBar 接受可选的 autoHideMs')
	assert.match(status, /autoHideArm\(autoHideMs\)/, '回执出现即起倒计时')
	assert.match(status, /onMouseEnter: autoHidePause/, '悬停暂停计时')
	assert.match(status, /onMouseLeave: autoHideResume/, '移开从剩余时间继续')
	assert.match(members, /autoHideMs: notice !== null && notice\.tone === 'ok' \? 2000 : 0/, '成员块成功回执开启（失败回执带重试，不自动隐藏）')
	assert.match(roles, /autoHideMs: rosterNotice !== null && rosterNotice\.tone === 'ok' \? 2000 : 0/, '角色块成功回执也开启自动隐藏')
	assert.match(skills, /autoHideMs: notice !== null && notice\.tone === 'ok' \? 2000 : 0/, '技能块成功回执也开启自动隐藏')
})

test('成员块成功回执：2 秒自动隐藏；悬停时暂停、移开后从剩余时间继续', async () => {
	const workspace = fixtureWorkspace()
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(teamServices()))
	const WHY = '这一档只剩它一位能干活：**同角色至少留 1 位未停用**'
	members.merged[1].verbs.disable = { ok: false, why: WHY }
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills: emptySkills(workspace), definition: SKILLS_DEFINITION_PAYLOAD, services: { sessions: { list } } })
	const buttonOf = (node) => nodes(node).find((entry) => entry.props['data-member-verb'] === 'disable' && entry.props['data-member-name'] === 'revi-1' && entry.props['data-member-verb-ok'] === 'false')
	const noticeOf = (node) => nodes(node).find((entry) => entry.props['data-notice-slot'] === 'members')
	// 挂载用真实计时器（settle 依赖 setTimeout(0)）；到这一步换成手摇时钟验倒计时。
	const realSetTimeout = globalThis.setTimeout
	const realClearTimeout = globalThis.clearTimeout
	let fakeNow = 0
	let timerSeq = 0
	const fakeTimers = new Map()
	globalThis.setTimeout = (fn, delay, ...args) => {
		timerSeq += 1
		fakeTimers.set(timerSeq, { fn, args, at: fakeNow + Number(delay ?? 0) })
		return timerSeq
	}
	globalThis.clearTimeout = (id) => {
		fakeTimers.delete(id)
	}
	const tick = (ms) => {
		fakeNow += ms
		for (const [id, timer] of [...fakeTimers.entries()].sort((left, right) => left[1].at - right[1].at)) {
			if (timer.at > fakeNow) continue
			fakeTimers.delete(id)
			timer.fn(...timer.args)
		}
	}
	try {
		const flushMicro = async () => {
			for (let i = 0; i < 8; i += 1) await Promise.resolve()
		}
		const renderNow = () => {
			harness.renderer.takeDirty()
			const next = harness.renderer.render(element.type, element.props)
			harness.renderer.flushEffects()
			return next
		}

		// ① 点一个"有理由但不可用"的动词 → 成功类回执出现（零请求，回执 tone=ok）
		let current = tree
		buttonOf(current).props.onClick()
		await flushMicro()
		current = renderNow()
		const shown = noticeOf(current)
		assert.ok(shown !== undefined, '动作后应出现块顶回执')
		assert.equal(shown.props['data-notice-tone'], 'ok')
		assert.ok(textOf(shown).includes('同角色至少留 1 位未停用'), '回执原文：' + textOf(shown))
		assert.equal(shown.props['data-notice-auto-hide'], 'true', '成员块成功回执要开自动隐藏')

		// ② 1999ms 还在、2000ms 自动隐藏
		tick(1999)
		current = renderNow()
		assert.ok(noticeOf(current) !== undefined, '不到 2 秒不许消失')
		tick(1)
		current = renderNow()
		assert.equal(noticeOf(current), undefined, '满 2 秒要自动隐藏')

		// ③ 悬停暂停：再触发 → 悬停 5 秒不消失；移开后从剩余时间继续并隐藏
		buttonOf(current).props.onClick()
		await flushMicro()
		current = renderNow()
		const again = noticeOf(current)
		assert.ok(again !== undefined, '第二次动作也要出现回执')
		again.props.onMouseEnter()
		tick(5000)
		current = renderNow()
		assert.ok(noticeOf(current) !== undefined, '悬停期间暂停计时，不许消失')
		noticeOf(current).props.onMouseLeave()
		tick(2100)
		current = renderNow()
		assert.equal(noticeOf(current), undefined, '移开后从剩余时间继续计数并隐藏')
	} finally {
		globalThis.setTimeout = realSetTimeout
		globalThis.clearTimeout = realClearTimeout
		fetchStub.restore()
	}
})
