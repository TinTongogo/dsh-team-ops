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
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

function loadClient(services = {}) {
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
	agents: { get: (id) => (id === 'sess-1' ? lead : undefined) },
})

/** 宿主那两个半边共用的假 ctx（与 `loadClient` 里那个 `get` 同一套服务）。 */
const hostCtx = (services) => ({ fs: makeFs(), get: (name) => services[name], logger: { warn() {} } })

/** 一个真临时工作区：名册两个人（在场且开着执行代 / 退役），看板一条进行中。 */
function fixtureWorkspace() {
	const workspace = mkdtempSync(join(tmpdir(), 'team-ops-pane-'))
	writeFileSync(
		join(workspace, '.company-gate.members.json'),
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
		join(workspace, '.company-gate.board.json'),
		JSON.stringify({ version: 1, seq: 3, tasks: [{ id: 'T-001', description: '复核', owner: 'reviewer', status: '进行中', revision: 1, assignee: 'revi-1', attempt: 1, attemptId: 'uuid-1', priority: 'P1' }], tombstones: [] }, null, 2),
	)
	writeFileSync(join(workspace, '.company-gate.mailbox.json'), JSON.stringify({ version: 1, seq: 0, messages: [] }, null, 2))
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
const BOARD_PAYLOAD = { ok: true, file: '/w/.company-gate.board.json', items: [], counts: { 待办: 0 }, warnings: [], annotations: [], markdown: '' }

function stubFetch({
	status,
	members,
	skills,
	definition,
	board = BOARD_PAYLOAD,
	teamTasks = { ok: true, available: false, reason: '假件：没给团队任务', rows: [], counts: null, warnings: [] },
	milestones = { ok: true, path: '/w/docs/team/里程碑.md', exists: true, rows: [], warnings: [] },
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
		if (init?.method !== undefined && init.method !== 'GET') return json({ ok: true, name: JSON.parse(init.body).name, action: 'update', warnings: [] })
		if (target.startsWith('/company-board/api/skills/definition')) return json(definition)
		// 技能写入口（导入 / 新建 / 删除）：回一个真形状（面板只读 `ok` / `id` / `path`）。
		if (/^\/company-board\/api\/skills\/(import|create|remove)/.test(target)) {
			const body = init?.body === undefined ? {} : JSON.parse(init.body)
			return json({ ok: true, action: target.split('/').pop().split('?')[0], id: body.name ?? 'imported-one', root: '/u/.dsh/skills', path: '/u/.dsh/skills/' + (body.name ?? 'imported-one') })
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
async function mountPane({ members, skills, definition, status = STATUS_PAYLOAD, services = {}, board, teamTasks, milestones }) {
	const harness = loadClient(services)
	const seat = harness.seats.find((entry) => entry.options.name === 'conversation.view')
	assert.ok(seat !== undefined, '没有注册 conversation.view 那一席')
	const element = seat.component({ sessions: undefined, slots: undefined })
	const fetchStub = stubFetch({ status, members, skills, definition, board, teamTasks, milestones })
	const tree = await settle(harness, element.type, element.props)
	return { tree, harness, fetchStub, element, listeners: harness.listeners }
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

test('席位：两处 —— 视图栏那一栏 + 输入框工具行那一枚「角色」按钮', () => {
	const harness = loadClient()
	assert.deepEqual(
		harness.seats.map((entry) => entry.options.name),
		['conversation.view', 'conversation.input.left'],
		'两席：视图栏（三块）+ 输入框工具行（角色按钮）；设置页那一席已按人的指令撤下',
	)
	assert.equal(harness.seats[0].options.label, '团队状态')
	// 输入框那一席：人的指令「在输入框添加一个「角色」按钮」（不是写在「成员」块里）。
	assert.equal(harness.seats[1].options.id, 'company-roles')
	assert.equal(harness.seats[1].options.label, '角色')
	assert.equal(typeof harness.seats[1].component, 'function')
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


test('输入框工具行那一席：`@` 菜单已经够了，这一席只留「角色」 + 插标记', async () => {
	// 人的两条口径合起来定下了这一席的形状：
	//   「我的意思是在输入框添加一个「角色」按钮，不是让你写在「成员」里面。」
	//   「为什么还要在「角色」按钮旁边加一个「让xxx去做」，不多此一举吗？」
	// ⇒ 这一席**只有一枚按钮**（打开选择框 ⇒ 把 `@角色名` 追加进输入框），
	//    不再有第二枚动作按钮：本体的发送键就够了，那件事由协调者按"点名"规矩派下去。
	const workspace = fixtureWorkspace()
	const harness = loadClient()
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


test('默认落在成员块：按真端点载荷画卡片与读数，且整栏不碰 /roles', async () => {
	const workspace = fixtureWorkspace()
	const calls = []
	// 喂一个假会话清单：客户端要能看出**请求带上了 workspace 与 session**
	// （成员那块靠 session 拿本会话的 agent 名册；技能那块靠它读会话层的目录）。
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	// 邮箱正文形状不在这一条自检范围内：这里只验页面把那一格画出来。
	// task-40 起 `mailbox_unread` 就在**行自己**身上（不再挂在 `ledger` 上）。
	members.merged[1].mailbox_unread = 3
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry(calls) }))
	const { tree, fetchStub, harness, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		// 块表：五个按钮，**没有**「角色」（按 `data-pane-block` 找，不靠文案猜 —— 筛选 chip 也带 aria-pressed）。
		const blockButtons = nodes(tree).filter((node) => node.type === 'button' && node.props['data-pane-block'] !== undefined)
		assert.deepEqual(
			blockButtons.map((node) => node.props['data-pane-block']),
			['members', 'skills', 'board'],
		)
		const labels = blockButtons.map((node) => textsOf(node.children).join(''))
		assert.deepEqual(labels, ['成员', '技能', '任务看板'], '块序 = 成员 / 技能 / 任务看板')
		assert.ok(!labels.some((label) => label.includes('角色')), '「角色」那一块已经撤下')
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
		// **成员块头要有一句"成员与角色的关系"**（人的指令：与技能那块同一形态的解释）
		const membersHead = nodes(tree).find((node) => node.type === 'div' && typeof node.props.className === 'string' && node.props.className.includes('cbv-view-head') && textOf(node.children).includes('成员'))
		assert.ok(membersHead !== undefined, '成员块头要在')
		const mh = textOf(membersHead)
		assert.ok(mh.includes('角色是作业程序，成员是戴它干活的人'), '要一句话说清关系：' + mh)
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
				if (!opensExternally) {
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
		assert.ok(!codeLines.some((line) => line.includes('.company-gate.members.json')), '客户端代码不再提那份旧名册文件')
		// 「枚举外状态」那条检查（读旧名册的 `status` 原值）随旧账撤了 ⇒ 这里改成核它**真的没了**
		assert.ok(!clientSrc.includes('MEMBER_STATUS_WORDS'), '旧名册三态词表那套检查撤掉')

		// **这一行是纯文本，不渲染 Markdown**：写 `**粗体**` 会原样显示两个星号（现场截图里就是那样）。
		assert.ok(!mh.includes('**'), '注解里不许有 Markdown 记号（这一格不渲染）：' + mh)
		// 人的指令：**简短**（一长就会被挤到「成员」下面第二行去，而头那一行是 flex + flex-wrap）
		const hintText = textOf(membersHead.children.filter((c) => String(c?.props?.className ?? '').includes('cbv-pane-hint')))
		assert.ok(hintText.length <= 40, '这句要短（≤40 字符，实际 ' + hintText.length + '）：' + hintText)
		assert.ok(!hintText.includes('\n'), '不许有换行')
		assert.ok(hintText.includes('一个角色可以叫多个成员'), '要点出"一个角色可叫多人"这层：' + hintText)
		assert.ok(!labels.some((label) => label.includes('审批') || label.includes('共识')), '审批与共识随制度一并撤下')
		// 默认那一块就是成员：**只有原生名册那一份**（协调者 + 队友）—— task-40 起不再有"只在名册里"的第三张卡。
		const cards = cardsOf(tree, 'cbv-mp-card')
		assert.equal(cards.length, 2)
		assert.deepEqual(cards.map((card) => card.props['data-mem-name']), ['lead', 'revi-1'])
		assert.deepEqual(cards.map((card) => card.props['data-mem-kind']), ['lead', 'teammate'])
		// 会话 id 就是这一位的真源（旧名册的编号 `MB-001` 撤了）；未读那一格挂在**行自己**身上。
		assert.equal(cards[1].props['data-mem-id'], 'child-1')
		assert.ok(textOf(cards[1]).includes('未读 3'), '未读那一格要画出来')
		assert.ok(cards.every((card) => !textOf(card).includes('已启用')), '卡上不再有"已启用"那半对开关态的词')
		// 「已停用」那一档与卡上的标都由 **live flag** 决定（同一条在档位那一处断言里已验过一次：
		// 把一位标成停用 ⇒ chip 从「已停用 0」变「已停用 1」、卡上出现那枚徽标）。
		assert.equal(cards[1].props['data-mem-disabled'], 'false', '没停用就是 false（档位与卡标都照这一格画）')
		// 协调者那一行：停用/恢复是**禁用态**（它不是可停用的队内成员）；「打断」照旧不画
		assert.equal(buttonWith(cards[0], '编辑'), undefined)
		assert.equal(buttonWith(cards[0], '删除'), undefined)
		assert.equal(buttonWith(cards[0], '查看提示词'), undefined)
		// **HD-006 的 UX 修正**：协调者卡上停用 / 恢复是**禁用态**（它不是可停用的队内成员），
		// 「打断」照旧不画；判据：画了就都 `disabled` 且 title 非空。
		for (const button of nodes(cards[0]).filter((node) => node.props['data-member-verb'] !== undefined)) {
			assert.equal(button.props.disabled, true, `协调者卡上 ${button.props['data-member-verb']} 必须是禁用态`)
			assert.ok(String(button.props.title ?? '') !== '', `禁用态要把服务端的 why 原样给出来：${String(button.props['data-member-verb'])}`)
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
		assert.ok(textOf(tree).includes('本插件**不改它的记录、也不删它**') || textOf(tree).includes('不改它的记录'), '整栏要说清一次操作边界')
		// 页头**只剩标题**（人的指令）：那些数在下面那条筛选行的 chip 上。
		assert.ok(!textOf(tree).includes('本会话 2 个 agent'), '页头不再印那串长读数')
		assert.ok(!textOf(tree).includes('本插件名册：在场'), '也不印那串长读数')
		assert.equal(textOf(nodes(tree).find((node) => node.props['data-members-facet'] === 'lead')), '协调者 1', '身份 chip 带数')
		// chip 上那个总数必须等于载荷的 `rows`（**一处口径**：数从哪里来、印出来就是那个，不许自己再算一遍）。
		const rowsAttr = nodes(tree).find((node) => node.props['data-members-rows'] !== undefined).props['data-members-rows']
		assert.ok(textOf(tree).includes('全部 ' + rowsAttr), `「全部」那个 chip 要等于 data-members-rows（实际 rows=${rowsAttr}）`)
		// 成员那一块在栏内是**自己滚**的那一层（面板窄，卡片多时要能滑下去看）。
		assert.ok(cardsOf(tree, 'cbv-mp-grid').length === 1)
		// 撤下角色那一栏之后，整栏一次都不该请求 /roles。
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
	// 现场：切到新对话后点「成员 / 技能 / 任务看板」都要等一下才出内容。端点本身只要 1–4 ms（量过），
	// 慢的是"每次重挂才开始拉" ⇒ 现在挂载即并行预取四块，并且 TTL 内重挂直接吃缓存。
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
		const removeDialog = nodes(confirm).find((node) => node.props['data-skill-dialog'] !== undefined)
		assert.equal(removeDialog.props['data-skill-dialog'], 'remove')
		assert.ok(textOf(removeDialog).includes('hidden-one'), '确认块里点名删哪一个')
		assert.ok(textOf(removeDialog).includes('不可逆'), '说清不可逆')
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
		// 载荷里那一格的可选项：`code-review` 在（fakeRegistry）、`gone-in-this-session` 不在
		assert.deepEqual(members.skillOptions.names, ['code-review', 'hidden-one'], '可选项来自会话作用域的技能目录：' + JSON.stringify(members.skillOptions))
		const section = nodes(tree).find((node) => node.props['data-roster-count'] !== undefined)
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
		const section = nodes(tree).find((node) => node.props['data-roster-count'] !== undefined)
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
		const section = nodes(tree).find((node) => node.props['data-roster-count'] !== undefined)
		const editButton = nodes(section).find((node) => node.props['data-roster-action'] === 'edit')
		const opened = await act(harness, element.type, element.props, () => editButton.props.onClick())
		const scopeSelect = nodes(opened).find((item) => item.props['data-roster-field'] === 'scope')
		assert.equal(String(scopeSelect.props.value), 'workspace', '工作区根角色 ⇒ 档位 = 本工作区（正向对照）')
	} finally {
		fetchStub.restore()
	}
})

test('除成员页外，筛选行都是**下拉**：角色来源 / 技能阶段与级别（task-44）—— 且只换了控件形状', async () => {
	// 人的口径（HD-009）：「没点名的界面别动；**成员页那一排用同级按钮，其它筛选行都退回下拉**。」
	// 成员那排是**唯一**的例外（人明确要的同级按钮）。
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
		// ① 角色那一节：来源筛是下拉
		const rosterSelect = nodes(tree).find((node) => node.props['data-roster-origin-facet'] !== undefined)
		assert.equal(rosterSelect.type, 'select', '角色来源筛是下拉')
		// ② 技能块：**阶段与级别是两个独立下拉**（叠加语义保持：可以同时生效）
		const skillsTab = buttonWith(tree, '技能')
		const onSkills = await act(harness, element.type, element.props, () => skillsTab.props.onClick())
		const stageSelect = nodes(onSkills).find((node) => node.props['data-skill-stage-facet'] !== undefined)
		const levelSelect = nodes(onSkills).find((node) => node.props['data-skill-level-facet'] !== undefined)
		assert.equal(stageSelect.type, 'select', '技能阶段筛是下拉')
		assert.equal(levelSelect.type, 'select', '技能级别筛也是下拉（0.12.5 已定，别碰）')
		assert.ok(!nodes(onSkills).some((node) => node.props['data-skills-facets'] !== undefined), '技能块不再有 chip 排')
		// ③ **叠加**：阶段选「模型可调用」+ 级别选「用户级」⇒ 两条件同时生效（只剩 b-user）
		const modelOption = nodes(stageSelect).filter((node) => node.type === 'option').find((node) => textOf(node).startsWith('模型可调用'))
		const afterStage = await act(harness, element.type, element.props, () => stageSelect.props.onChange({ target: { value: modelOption.props.value } }))
		const levelInAfter = nodes(afterStage).find((node) => node.props['data-skill-level-facet'] !== undefined)
		const userOption = nodes(levelInAfter).filter((node) => node.type === 'option').find((node) => textOf(node).startsWith('用户级'))
		const both = await act(harness, element.type, element.props, () => levelInAfter.props.onChange({ target: { value: userOption.props.value } }))
		assert.deepEqual(
			cardsOf(both, 'cbv-sk-card').map((card) => card.props['data-skill-name']),
			['b-user'],
			'阶段 ∧ 级别 同时生效（叠加语义没变）：' + JSON.stringify(cardsOf(both, 'cbv-sk-card').map((card) => card.props['data-skill-name'])),
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
		assert.ok(text.includes('这个会话还没有原生'), '空的时候要说清是"没任务"而不是"读不到"：' + text.slice(0, 200))
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
	const board = { ok: true, file: join(workspace, '.company-gate.board.json'), items: [], counts: { 待办: 0 }, warnings: [], annotations: [], markdown: '' }
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
		// **看板块头不再印计数**（人的指令：下面那两枚 chip 已经体现了）——头那一行只留标题 + 注解。
		const boardHead = nodes(onBoard).find((node) => node.type === 'div' && typeof node.props.className === 'string' && node.props.className.includes('cbv-view-head') && textOf(node.children).includes('任务看板'))
		assert.ok(boardHead !== undefined, '看板块头要在')
		const bh = textOf(boardHead)
		assert.ok(!bh.includes('板上 ') && !bh.includes('个 ·') && !bh.includes('本会话团队任务板：'), '块头不再印计数：' + bh)
		assert.ok(bh.includes('任务看板'), '标题要在：' + bh)
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
		assert.ok(textOf(cards[1]).includes('依赖 T-1'))
		assert.ok(textOf(cards[0]).includes('写盘面 src/a'), '写盘面那一行（只有 T-1 有）')
		assert.ok(textOf(onBoard).includes('write scopes overlap with T-1'), '原生的写盘面告警原文透出')
		// **看板底部那一整行撤了**（人的指令：不要显示）：键位提示只在浮窗里（下面那条用例验），
		// "本栏只读"这件事挪在筛选行右侧那句里（它管的是这一档的操作边界，与那一行不是一回事）。
		assert.ok(!textOf(onBoard).includes('点卡片看'), '底部那句整行撤了')
		assert.ok(!textOf(onBoard).includes('切换分栏'), '看板底部不写键位')
		assert.ok(textOf(onBoard).includes('本栏只读'), '只读这件事仍在筛选行右侧说清')

		// 从前这里还验"点「里程碑」切成按 phase 分栏那一份" —— 那一档已随本插件看板文件一起删掉，
		// 界面上只剩原生这一档（它没有可切的第二档，也就不存在"切走之后"）。
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
	const board = { ok: true, file: join(workspace, '.company-gate.board.json'), items: [], counts: { 待办: 0 }, warnings: [], annotations: [], markdown: '' }
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
	const board = { ok: true, file: join(workspace, '.company-gate.board.json'), items: [], counts: { 待办: 0 }, warnings: [], annotations: [], markdown: '' }
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
	const board = { ok: true, file: join(workspace, '.company-gate.board.json'), items: [], counts: { 待办: 0 }, warnings: [], annotations: [], markdown: '' }
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

test('成员块里那一节「角色」：清单 + 状态 + 叫法（面板只读，不建成员）', async () => {
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
	const { tree, fetchStub, harness, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const section = nodes(tree).find((node) => node.props['data-roster-count'] !== undefined)
		assert.ok(section !== undefined, '成员块里要有「角色」那一节')
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
		// **一个滚动区装全部**：卡区与这一节是同一个滚动容器的兄弟节点（不然清单被挤到可视区外，
		// 页面本身又不滚 ⇒ 那 20 张卡滚不到也点不到）。
		const scroll = nodes(tree).find((node) => hasClass(node, 'cbv-scroll'))
		assert.ok(scroll !== undefined, '成员块要有那个唯一的滚动区')
		const insideScroll = nodes(scroll).map((node) => node.props.className)
		assert.ok(insideScroll.includes('cbv-mp-grid'), '成员卡区在滚动区里')
		assert.ok(insideScroll.includes('cbv-roster'), '可叫清单也在同一个滚动区里')
		assert.equal(nodes(tree).filter((node) => hasClass(node, 'cbv-scroll')).length, 1, '只有一个滚动区（三块共用同一个类）')
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
			'「成员」块里不该有叫人入口',
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
		const before = fetchStub.calls.length
		const submitted = await act(harness, element.type, element.props, () => dialog.props.onClick())
		assert.equal(nodes(submitted).find((node) => node.props['data-roster-submit'] !== undefined), undefined, '提交后弹窗关掉')
		// 写的**就是那一条**（写完之后这一块还会自己重取一次，所以不去数总数）。
		const wrote = fetchStub.calls.slice(before).filter((call) => call.url.includes('/roles/update'))
		assert.equal(wrote.length, 1, JSON.stringify(fetchStub.calls.slice(before)))
		assert.equal(wrote[0].method, 'POST')
		assert.ok(wrote[0].url.includes('workspace='), '写请求要带 workspace')
		assert.ok(fetchStub.calls.slice(before).some((call) => call.url.includes('/members')), '写完立刻重取这一块')
		assert.match(textOf(submitted), /已添加角色/, '回执原样显示端点的结论')

		// 点「下架」⇒ 开确认弹窗；确认后落在 `/roles/remove`（**动词由载荷的 removal 决定**）。
		const removeButton = nodes(section).find((node) => node.props['data-roster-action'] === 'remove')
		const openedRemove = await act(harness, element.type, element.props, () => removeButton.props.onClick())
		const confirm = nodes(openedRemove).find((node) => node.props['data-roster-submit'] === 'remove')
		assert.ok(confirm !== undefined, '下架确认弹窗要开')
		const beforeRemove = fetchStub.calls.length
		await act(harness, element.type, element.props, () => confirm.props.onClick())
		const posts = fetchStub.calls.slice(beforeRemove).filter((call) => call.url.includes('/roles/'))
		assert.equal(posts.length, 1, JSON.stringify(fetchStub.calls.slice(beforeRemove)))
		assert.ok(posts[0].url.includes('/roles/remove'), posts[0].url)
	} finally {
		fetchStub.restore()
	}

	// **已下架**的那些折成一行（可恢复）：把 fixture 补一个下架的，再渲染一次看那一行。
	const withHidden = { ...members, defaults: { ...members.defaults, hiddenRows: [{ role: 'ceo', title: '总经理', category: '管理', positioning: '对经营结果负责。', file: '/w/roles/ceo/ROLE.md', origin: 'package', removal: 'hide', state: 'vacant', present: [], archived: [], retired: [], removed: [], nextName: 'ceo-1', label: '未到场；可以叫一个：ceo-1' }] } }
	const third = await mountPane({ members: withHidden, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const restore = nodes(third.tree).find((node) => node.props['data-roster-action'] === 'restore')
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
		assert.equal(nodes(second.tree).find((node) => node.props['data-roster-count'] !== undefined), undefined, '没有这一格就不渲染')
		assert.ok(nodes(second.tree).length > 0, '其余部分照常渲染')
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
		assert.equal(cards[0].props['data-skill-model'], 'true')
		assert.ok(textOf(cards[0]).includes('模型可调用') && textOf(cards[0]).includes('人可调用'))
		// **技能块头只留那句注解**（人的指令：「共 11 个 · 模型可调用 11 · 人可调用 11」不要了）：
		// 计数在下面那条筛选行的 chip 上本来就有，块头重复一遍是噪音。
		const skillsHead = nodes(onSkills).find((node) => node.type === 'div' && typeof node.props.className === 'string' && node.props.className.includes('cbv-view-head') && textOf(node.children).includes('技能'))
		assert.ok(skillsHead !== undefined, '技能块头要在')
		const headText = textOf(skillsHead)
		assert.ok(!headText.includes('共 ') && !headText.includes('模型可调用 11'), '块头不再印计数：' + headText)
		assert.ok(headText.includes('清单来自宿主的技能注册表'), '那句注解要留着：' + headText)
		// 两面都没开的技能**照列**，并明说它两个面都没开（不然看起来像面板坏了）。
		assert.equal(cards[1].props['data-skill-model'], 'false')
		assert.ok(textOf(cards[1]).includes('两个面都没开'))
		assert.ok(textOf(onSkills).includes('/u/.dsh/skills/code-review/SKILL.md'), '指令文件路径')

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

		// **阶段筛是下拉**（task-44 口径：除成员页外都退回下拉）：「人可调用」那一档只剩一条。
		const stageSelect = nodes(copied).find((node) => node.props['data-skill-stage-facet'] !== undefined)
		assert.equal(stageSelect.type, 'select', '阶段筛是下拉，不是 chip 排')
		const userStage = nodes(stageSelect).filter((node) => node.type === 'option').find((node) => String(node.props.value).includes('人可调用') || textOf(node).startsWith('人可调用'))
		assert.ok(userStage !== undefined, '阶段那几档在选项里：' + textOf(stageSelect))
		const filtered = await act(harness, element.type, props, () => stageSelect.props.onChange({ target: { value: userStage.props.value } }))
		assert.deepEqual(
			cardsOf(filtered, 'cbv-sk-card').map((card) => card.props['data-skill-name']),
			['code-review'],
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
		assert.ok(!textOf(first.tree).includes('.company-gate.members.json'), '面板不再提那份旧文件')
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
		assert.ok(textOf(second.tree).includes('就是 GUI"插件 / 能力"里那个开关'), '说清它与 GUI 那个开关是同一件事')
		assert.ok(textOf(second.tree).includes('随时可关回来'), '说清可逆（人才敢点）')
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
	const mapEntries = entriesOf(/^\/\/   ([①-⑮]) (.+?)(?:\s{2,}|$)/, (matched) => `${matched[1]} ${matched[2].trim()}`)
	const banners = entriesOf(/^\t\t\/\/ ── ([①-⑮] .+?) ─+/, (matched) => matched[1].trim())
	assert.ok(mapEntries.length >= 10, '地图要够细（现在 ' + mapEntries.length + ' 条）')
	assert.deepEqual(banners, mapEntries, '地图与横幅必须逐条同名、同序')
	assert.equal(new Set(banners.map((item) => item.split(' ')[0])).size, banners.length, '分区编号不许重复')
})

test('回执不是 JSON 时：三块都要印出可读那行，不许白屏、不许画空清单', async () => {
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
		assert.equal(button.props.disabled, true, '不能做 ⇒ 禁用态')
		assert.equal(button.props['data-member-verb-ok'], 'false')
		// **理由原文不许丢**：title 就是服务端那句，一个字都不许改
		assert.equal(String(button.props.title), WHY, 'title 必须是服务端 why 的原文（不许自己复述）：' + String(button.props.title))
		// 「打断」照旧：载荷说不能做就不画
		// 「打断」也与停用/恢复同一条（task-41）：不能做也画出来、禁用 + 原样给理由
		const stopButton = nodes(tree).find((node) => node.props['data-member-verb'] === 'interrupt')
		assert.ok(stopButton !== undefined, '「打断」也画出来（藏起来等于让人猜为什么没有它）')
		assert.equal(stopButton.props.disabled, true, '不能打断 ⇒ 禁用态')
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
		// ① 角色那一节：**来源筛是下拉**（task-44 口径：除成员页外都退回下拉）+ 每张卡一枚来源标
		const facetSelect = nodes(tree).find((node) => node.props['data-roster-origin-facet'] !== undefined)
		assert.equal(facetSelect.type, 'select', '「按来源筛选」是下拉，不是 chip 排')
		assert.deepEqual(nodes(facetSelect).filter((node) => node.type === 'option').map((node) => node.props.value), ['all', 'workspace', 'user', 'package'], '选项 = 全部 + 载荷给的三档')
		assert.ok(textOf(facetSelect).includes('项目级（1）') && textOf(facetSelect).includes('用户级（1）') && textOf(facetSelect).includes('包内（1）'), '选项文案用载荷里的词与计数：' + textOf(facetSelect))
		const originChips = nodes(tree).filter((node) => node.props['data-roster-origin-chip'] !== undefined)
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
		// 点**成员卡上**每一个动词按钮（三处 POST 都要被验到）
		for (const verb of ['disable', 'restore', 'interrupt']) {
			const button = nodes(tree).find((node) => node.props['data-member-verb'] === verb)
			assert.ok(button !== undefined, `要能画出来 ${verb} 那一枚按钮（载荷说 ok:true）`)
			await act(harness, element.type, element.props, () => button.props.onClick())
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

test('成员块：三个动词按载荷给的 `verbs` 画，整栏一句说清边界（HD-006）', async () => {
	// 人的要求（HD-006）：面板「成员」每张卡加**停用 / 恢复 / 打断**；**服务端给动词、客户端不猜**
	// （沿用「角色」卡那套 `removal`）。这一条钉"客户端只照载荷画"这件事，动词的语义在引擎那一组用例里钉。
	const workspace = fixtureWorkspace()
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(teamServices()))
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
				assert.equal(button.props.disabled, spec.ok !== true, `${verb} 的禁用态要与 payload ok 一致`)
				if (spec.ok !== true) {
					assert.equal(String(button.props.title ?? ''), String(spec.why ?? ''), `${verb} 禁用时 title 必须是服务端的 why 原文（不许自己复述）`)
					assert.ok(String(button.props.title ?? '') !== '', `${verb} 禁用时必须给理由`)
				}
			}
		}
		// ③ 整栏那一句：说清"不改记录 / 不删"，并把三个动词的语义与"至少留 1 位"讲明白
		const roNote = nodes(tree).find((node) => node.props['data-members-ro'] === 'true')
		assert.ok(roNote !== undefined, '整栏要有一句边界声明')
		const noteText = textOf(roNote)
		assert.ok(noteText.includes('不改它的记录、也不删它'), '说清这一栏不改 / 不删成员：' + noteText)
		for (const word of ['停用', '恢复', '打断', '至少留 1 位', '本插件不再派活给它', '宿主原生界面里仍然可以打开对话']) {
			assert.ok(noteText.includes(word), `那一句要说清「${word}」：` + noteText)
		}
		assert.deepEqual(literalMarkerTexts(roNote), [], '那一句里的标记要渲染掉')
		// ④ 计数行：`在场 N（已停用 M）/ 上限 24`（数全来自载荷 `counts`）
		const countsNode = nodes(tree).find((node) => node.props['data-members-counts'] !== undefined)
		assert.ok(countsNode !== undefined, '要有计数行')
		assert.equal(
			textOf(countsNode),
			`在场 ${members.counts.present}（已停用 ${members.counts.disabled}）/ 上限 ${members.counts.max}`,
			'计数行要与载荷一致',
		)
		assert.match(textOf(countsNode), /\/ 上限 24$/, '上限那一格是 24（两条规则推出来的数、与宿主 maxMembers 同值）')
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
	const harness = loadClient()
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
		file: '/w/.company-gate.members.json',
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
		total: 3,
		counts: { pending: 1, in_progress: 1, completed: 1 },
		warnings: ['写盘面与别的任务重叠：**只告警不拦**（`writeScopes` 是提示性声明）。'],
		rows: [
			{ id: 'T-1', revision: 1, subject: '改 A', description: '把 A 改掉', status: 'pending', ownerName: '', ready: true, blockedBy: [], writeScopes: ['src/a'], writeScopeWarnings: [] },
			{ id: 'T-2', revision: 3, subject: '改 B', description: '', status: 'in_progress', ownerName: 'revi-1', ready: false, blockedBy: ['T-1'], writeScopes: [], writeScopeWarnings: ['write scopes overlap with T-1'] },
			{ id: 'T-3', revision: 2, subject: '改 C', description: '', status: 'completed', ownerName: 'lead', ready: false, blockedBy: [], writeScopes: [], writeScopeWarnings: [] },
		],
	}
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, teamTasks })
	const cardIds = (current) => nodes(current).filter((node) => node.props['data-tt-id'] !== undefined && node.props['data-tt-id'] !== '').map((node) => node.props['data-tt-id'])
	try {
		const onBoard = await act(harness, element.type, element.props, () => buttonWith(tree, '任务看板').props.onClick())
		// ① 分档 chip 在，计数照原生那几个字段算（可认领 = 原生 `ready`；有依赖 / 写盘面重叠同）
		const stageChips = nodes(onBoard).filter((node) => node.props['data-tt-stage'] !== undefined)
		assert.deepEqual(
			stageChips.map((node) => node.props['data-tt-stage']),
			['all', 'ready', 'blocked', 'overlap'],
		)
		assert.deepEqual(
			stageChips.map((node) => textOf(node)),
			['全部 3', '可认领 1', '有依赖 1', '写盘面重叠 1'],
		)
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
		assert.deepEqual(cardIds(cleared), ['T-1', 'T-2', 'T-3'], '清完筛选三张卡都回来')
		// ④ 原生没有优先级 / 时间：这件事要**写在明处**，不留白
		assert.ok(textOf(cleared).includes('原生任务没有优先级'), '块头要写明原生没有优先级 / 时间字段：' + textOf(cleared).slice(0, 200))
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

test('界面文案里的 markdown 标记真的渲染掉了：三块的文本子节点里没有 ** 或反引号', async () => {
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
		assert.ok(textOf(tree).includes('一个人都还没叫过'), '那句「还没叫过」要在（只是标记渲染掉了）')
		const onSkills = await act(harness, element.type, element.props, () => buttonWith(tree, '技能').props.onClick())
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
		const confirm = nodes(opened).find((node) => node.props['data-skill-dialog'] === 'remove')
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
		assert.ok(textOf(viewer).includes('截断后'), '截断这件事要说出来：' + textOf(viewer).slice(0, 200))
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
		assert.ok(textOf(marked[0]).includes('只列了前 16 条（共 20 条）'), '要说清只列了多少 / 一共多少：' + textOf(marked[0]))
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

test('状态块：端点说这份读数是遗留文件时，面板要说出来（原生时不印）', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace), hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const legacy = { ...STATUS_PAYLOAD, source: 'legacy', sourceLine: '这份读数是**遗留文件**（`board.json`）—— 现状以原生那本账为准。' }
	const first = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services, status: legacy })
	try {
		const note = nodes(first.tree).find((node) => node.props['data-status-source'] !== undefined)
		assert.ok(note !== undefined, '遗留读数要印一句来源')
		assert.equal(note.props['data-status-source'], 'legacy')
		assert.ok(textOf(note).includes('遗留文件'), '要用端点给的原文：' + textOf(note))
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

test('「角色」目录的入口在「成员」块头（锚点），不必先滚一屏成员卡', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace) + '&session=sess-1', hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, fetchStub } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const section = nodes(tree).find((node) => node.props['data-roster-count'] !== undefined)
		assert.ok(section !== undefined, '「角色」那一节在（挂在成员卡区下面）')
		const anchor = nodes(tree).find((node) => node.props['data-roster-anchor'] !== undefined)
		assert.ok(anchor !== undefined, '块头上要有一枚「角色（N）」锚点')
		assert.equal(anchor.props['data-roster-anchor'], section.props['data-roster-count'], '锚点上的数 = 那一节的条数')
		assert.ok(textOf(anchor).includes('角色（'), '文案：' + textOf(anchor))
		assert.equal(anchor.props.type, 'button', '锚点是一枚按钮（可点、可键盘）')
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

test('「技能」块头那句要与同屏的写动作同义（不再自称"本栏只读"）', async () => {
	const workspace = fixtureWorkspace()
	const list = { getSnapshot: () => ({ ids: ['sess-1'], byId: { 'sess-1': { id: 'sess-1', cwd: workspace, retainedBy: { mainView: 1 } } } }) }
	const services = { sessions: { list }, ...teamServices() }
	const members = await endpoint('handleMembers', '/company-board/api/members?workspace=' + encodeURIComponent(workspace), hostCtx(services))
	const skills = await endpoint('handleSkills', '/company-board/api/skills?workspace=' + encodeURIComponent(workspace), hostCtx({ skills: fakeRegistry([]) }))
	const { tree, harness, fetchStub, element } = await mountPane({ members, skills, definition: SKILLS_DEFINITION_PAYLOAD, services })
	try {
		const onSkills = await act(harness, element.type, element.props, () => buttonWith(tree, '技能').props.onClick())
		const head = nodes(onSkills).find((node) => node.type === 'div' && String(node.props.className).includes('cbv-view-head') && textOf(node.children).includes('技能'))
		const text = textOf(head)
		// 头说"只读"、同屏摆着导入 / 新建 / 删除，是最坏的一种描述（唯一的安全提示自己打架）
		assert.ok(!text.includes('本栏只读（查看'), '不许再自称"本栏只读"：' + text)
		assert.ok(text.includes('清单与正文只读'), '改成与实现同义的一句：' + text)
		assert.ok(text.includes('只对用户级 / 项目级可写'), '写动作的边界要说清（判据 WRITABLE_SKILL_SOURCES）：' + text)
		assert.ok(text.includes('导入 / 新建 / 删除'), '点名同屏那三个写动作：' + text)
		assert.ok(buttonWith(onSkills, '导入技能') !== undefined && buttonWith(onSkills, '新建技能') !== undefined, '同屏确实有写动作')
	} finally {
		fetchStub.restore()
	}
})
