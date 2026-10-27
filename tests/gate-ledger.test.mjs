#!/usr/bin/env node
/**
 * 门禁与读数诚实性自检（`node --test tests/gate-ledger.test.mjs`）。
 *
 * 为什么单独一份：这一批毛病**都不会崩、不会报错**，只会让读到的人做出错误判断 ——
 *   · 注入摘要把**已经停止更新的遗留文件**当现状说（任务板与名册现在在 DSH 原生 Agent Teams 里）；
 *   · `/status` 端点同一件事，且它读不出"现在读的是哪一种"；
 *   · `/team-tasks` 把 `blockedBy` / `writeScopes` 静默截到 16 条，而同一份载荷里行的截断却带告警；
 *   · 技能写入失败后把残骸留在技能根里，而下一次写入的守卫是"已存在就不许重试"。
 * 所以每条断言都对着"读的人会据此做什么"来写，而不是对着实现里的分支写。
 *
 * 假件照别处同一套：真文件系统之上的最小 `ctx.fs`，端点直接调导出函数（不经过 HTTP）。
 */

// **测试与用户真实目录隔离**：这一行必须在读取引擎之前 —— 见 `tests/isolate.mjs`（它设临时 `DSH_HOME` /
// `DSH_TEAM_OPS_ROLES`）。隔离只做这一处，不靠每条用例各自记得设。
import { ISOLATION_PREFIX, resetIsolatedHome } from './isolate.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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


const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = join(ROOT, 'lib', 'board-view.host.js')
const SKILL_WRITE_URL = pathToFileURL(join(ROOT, 'lib', 'skill-write.js')).href

/** 真文件系统之上的最小 `ctx.fs`（与其余自检同一套：方法名与宿主一一对应）。 */
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
		async writeText(target, data) {
			writeFileSync(pathOf(target), data)
		},
		processPath(target) {
			return pathOf(target)
		},
	}
}

/** 收一次端点回执（`writeJson` 走 `writeHead` + `end`）。 */
function makeRes() {
	const captured = { status: 0, body: '' }
	return {
		captured,
		res: {
			writeHead(status) {
				captured.status = status
			},
			end(body) {
				captured.body = body
			},
		},
	}
}

/** 调一个真端点：直接调导出的处理函数（与经 HTTP 走的是同一条读取与判定路径）。 */
async function call(handlerName, url, ctx, method = 'GET') {
	const host = await import(HOST)
	const { res, captured } = makeRes()
	await host[handlerName](ctx, { method, url }, res, null)
	return { status: captured.status, payload: captured.body === '' ? null : JSON.parse(captured.body) }
}

/** 一份最小 ctx：`fs` 是真文件系统桩，其余服务按需给。 */
function makeCtx(services = {}) {
	return { fs: makeFs(), get: (name) => services[name], logger: { warn() {}, info() {} } }
}

/** 跑一次注入摘要（`--text` 的纯文本形态，给人看与给自检看的是同一段）。 */
function runDigest(workspace) {
	const result = spawnSync(process.execPath, [join(ROOT, 'lib', 'ledger-digest.js'), '--workspace', workspace, '--text'], {
		cwd: ROOT,
		encoding: 'utf8',
	})
	assert.equal(result.status, 0, `摘要进程在任何情况下都退 0（实际 ${result.status}）：${result.stderr ?? ''}`)
	return result.stdout ?? ''
}

// ── 注入摘要：读得到也要说清来源 ─────────────────────────────────────────────

describe('注入摘要：三份旧账（看板 / 名册 / 邮箱）从注入里彻底拿掉', () => {
	/**
	 * 一个"**三份**旧账都在"的工作区（还带一条任务号，专门用来查它会不会漏进来）。
	 *
	 * 名字里的份数就按现场数：工作区里出现过的 `.company-gate.*.json` 一共 7 个名字 ——
	 * **还在写的 4 个**（human / roles / roster / handoff）与**遗留的 3 个**（board / members / mailbox，见
	 * `lib/ledger-digest.js` 的 `LEGACY_LEDGERS`）。所以旧账是**三份**，不是四份；
	 * 夹具也照这个数造（给"遗留"多造一份不存在的文件，等于让用例去描述一个产品里没有的东西）。
	 */
	const legacyWorkspace = () => {
		const dir = mkdtempSync(join(tmpdir(), 'gate-digest-legacy-'))
		writeFileSync(
			join(dir, '.company-gate.board.json'),
			JSON.stringify({ version: 1, seq: 1, tasks: [{ id: 'T-004', status: '已完成' }] }),
		)
		writeFileSync(join(dir, '.company-gate.members.json'), JSON.stringify({ version: 1, seq: 1, members: [] }))
		writeFileSync(join(dir, '.company-gate.mailbox.json'), JSON.stringify({ version: 1, seq: 1, messages: [] }))
		return dir
	}

	test('三份旧账都在 ⇒ 注入里一行都不许出现（哪怕文件还在）；实时那一行仍在', () => {
		const out = runDigest(legacyWorkspace())
		// **人的口径（HD-003）**：这三行连着"冻结的旧账"那句注解一起拿掉 —— 一个都不再打印。
		for (const dead of ['看板：共', '名册：在场', '未读邮件', '冻结的旧账', '遗留文件', 'T-004']) {
			assert.ok(!out.includes(dead), `注入里不该再出现「${dead}」：${out.slice(0, 260)}`)
		}
		// mtime 那一行也不再列那三份（只留还在写的账）
		const mtimeLine = out.split('\n').find((line) => line.includes('状态文件 mtime')) ?? ''
		for (const dead of ['board ', 'members ', 'mailbox ']) {
			assert.ok(!mtimeLine.includes(dead), `mtime 那一行不该再列 ${dead}：${mtimeLine}`)
		}
		// **实时那一行必须在**（三行拿掉之后它是唯一指路）
		assert.match(out, /团队状态：在 DSH 原生 Agent Teams（按会话）—— 成员与任务用 `member_list` \/ `team_status` 读/)
	})

	test('文件在而读不成（同名目录）⇒ 照样一行都不出（不再读它们了）', () => {
		const dir = legacyWorkspace()
		// 把 board 换成"同名目录"（`statSync` 成功、不是常规文件）—— 从前的"真故障"那一档
		rmSync(join(dir, '.company-gate.board.json'), { recursive: true, force: true })
		mkdirSync(join(dir, '.company-gate.board.json'))
		const out = runDigest(dir)
		assert.ok(!out.includes('看板：'), '读不成也不印那一行：' + out.slice(0, 200))
		assert.ok(!out.includes('读不到'), '连"读不到"也不说了 —— 它已经不在读的清单里：' + out.slice(0, 200))
		assert.match(out, /团队状态：在 DSH 原生 Agent Teams/, '实时那一行照旧')
	})

	test('结构扫描：注入的组装里不许把"来自文件的对象字段"直接插值（尽力而为，边界写在下面）', () => {
		// 判据：`lib/ledger-digest.js` 的模板串里**不许出现** `${word.x}` / `${data.x}` / `${task.x}` / `${entry.x}`
		// 这类**直接插值**——它们是"来自磁盘文件的值"，必须经 `fileTextShown`（压一行 + 截断）或
		// `shapedShown`（形状校验 + 压一行）进来。
		//
		// **边界（写清，别装作全覆盖）**：这条只兜住**本文件里这几种写法**：
		//   · 兜得住：模板里直接 `${data.sessionId}`、`${word.id}`、`${task.subject}`；
		//   · 兜不住：先赋给局部变量再拼（`const x = data.sessionId; \`…${x}…\``）——那种写法要靠
		//     `tests/team-ops.test.mjs` 的行为扫查用例（把伪造串塞进每个字段，断言注入行数不变多）。
		// 两条一起用才叫"两道"：扫描管"新写的那一行是不是又直插了"，行为扫查管"插进去的东西真的被压住了"。
		const source = readFileSync(join(ROOT, 'lib', 'ledger-digest.js'), 'utf8')
		const risky = [...source.matchAll(/\$\{(?:word|data|task|entry)\??\.[A-Za-z_][^}]*\}/g)].map((match) => match[0])
		assert.deepEqual(risky, [], `这些插值没过单行化：${risky.join('、')}`)
	})

	test('人的话那一行照旧（它是真源，不在被拿掉的三份里）', () => {
		const dir = legacyWorkspace()
		writeFileSync(
			join(dir, '.company-gate.human.json'),
			JSON.stringify({ version: 1, seq: 1, words: [{ id: 'HD-001', kind: 'goal', text: '把这件事做掉', by: 'agent', at: '2026-10-12T00:00:00.000Z' }] }),
		)
		const out = runDigest(dir)
		assert.match(out, /人的话：共 1 条/, '人的话那一行要在：' + out.slice(0, 260))
		assert.ok(!out.includes('看板：'), '三份旧账照旧不出现')
	})
})

// ── /status：按现场能力取数，并说清是哪一种 ──────────────────────────────────

describe('/status 端点：能拿到活会话就读原生，拿不到才回落并标明来源', () => {
	/** 一份带文件的临时工作区（文件里 1 条已完成 —— 与原生那份读数刻意不同，用来分辨读的是哪一本账）。 */
	const workspaceWithFile = () => {
		const dir = mkdtempSync(join(tmpdir(), 'gate-status-'))
		writeFileSync(
			join(dir, '.company-gate.board.json'),
			JSON.stringify({ version: 1, seq: 3, tasks: [{ id: 'T-001', status: '已完成', revision: 2 }] }),
		)
		return dir
	}
	const NATIVE_ROWS = [
		{ id: 'task-1', status: 'pending' },
		{ id: 'task-2', status: 'pending' },
		{ id: 'task-3', status: 'completed' },
	]

	test('本会话活着 ⇒ 计数按原生三档词给，source = native', async () => {
		const dir = workspaceWithFile()
		const ctx = makeCtx({
			agentTeams: { listTasks: (caller) => (caller === 'lead-agent' ? NATIVE_ROWS : []) },
			agents: { get: (id) => (id === 'sess-1' ? 'lead-agent' : undefined) },
		})
		const out = await call('handleStatus', `/company-board/api/status?workspace=${encodeURIComponent(dir)}&session=sess-1`, ctx)
		assert.equal(out.status, 200, JSON.stringify(out.payload).slice(0, 200))
		assert.equal(out.payload.source, 'native', '要能一眼看出读的是原生那一本账')
		assert.deepEqual(out.payload.counts, { pending: 2, in_progress: 0, completed: 1 }, '计数照原生三档词：' + JSON.stringify(out.payload.counts))
		assert.equal(out.payload.markdown, '待办 2 · 进行中 0 · 已完成 1', '文本与 team_status 同源')
		assert.equal(out.payload.native.available, true)
		assert.match(out.payload.sourceLine, /原生 Agent Teams 任务板/, '那一句话要说清是原生：' + out.payload.sourceLine)
		assert.ok(!out.payload.sourceLine.includes('遗留文件'), '原生档不许说自己在读遗留文件：' + out.payload.sourceLine)
	})

	test('会话不在 / 服务缺席 ⇒ 回落读文件，但 source = legacy 且说清凭什么回落', async () => {
		const dir = workspaceWithFile()
		const ctx = makeCtx({}) // 没有 agentTeams 服务、没有活会话
		const out = await call('handleStatus', `/company-board/api/status?workspace=${encodeURIComponent(dir)}&session=sess-404`, ctx)
		assert.equal(out.status, 200, JSON.stringify(out.payload).slice(0, 200))
		assert.equal(out.payload.source, 'legacy')
		assert.equal(out.payload.counts['已完成'], 1, '回落时照旧读文件条目：' + JSON.stringify(out.payload.counts))
		assert.equal(out.payload.native.available, false)
		assert.ok(typeof out.payload.native.reason === 'string' && out.payload.native.reason !== '', '回落要给出原因')
		assert.match(out.payload.sourceLine, /不再承载实时状态/, '要说清这份文件不再是实时账：' + out.payload.sourceLine)
		assert.ok(out.payload.sourceLine.includes('team_status'), '要指向实时读数')
		assert.match(out.payload.sourceLine, /sess-404|agentTeams/, '回落原因要照原样带出来：' + out.payload.sourceLine)
		// 这一条与上面那条合起来就是判据：**同一份文件、同一时刻，两档说的是两件事**。
		assert.ok(out.payload.warnings.some((line) => line.includes('不再承载实时状态')), '告警里也要有这一句（只看 warnings 的消费者读得到）')
	})

	test('原生可用而文件还没建 ⇒ 仍读原生（absent 只说明那份遗留文件还没有）', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'gate-status-'))
		const ctx = makeCtx({
			agentTeams: { listTasks: () => [{ id: 'task-9', status: 'in_progress' }] },
			agents: { get: () => 'lead-agent' },
		})
		const out = await call('handleStatus', `/company-board/api/status?workspace=${encodeURIComponent(dir)}&session=sess-1`, ctx)
		assert.equal(out.status, 200, JSON.stringify(out.payload).slice(0, 200))
		assert.equal(out.payload.source, 'native')
		assert.equal(out.payload.counts.in_progress, 1)
		assert.equal(out.payload.absent, true, '文件确实还没建（这一格说的是文件，不是任务）')
	})
})

// ── /team-tasks：截断必须看得见 ──────────────────────────────────────────────

describe('/team-tasks：字段级的按条数截断必须在载荷里看得见', () => {
	const ctxWith = (rows) => ({
		fs: makeFs(),
		get: (name) =>
			name === 'agentTeams'
				? { listTasks: () => rows }
				: name === 'agents'
					? { get: () => (rows === null ? undefined : 'lead-agent') }
					: undefined,
		logger: { warn() {} },
	})

	test('20 条依赖只回前 16 条：truncations 带上 shown / total，告警里说清 ready 是按全部依赖算的', async () => {
		const blockedBy = Array.from({ length: 20 }, (unused, index) => `task-${index + 100}`)
		const out = await call('handleTeamTasks', '/company-board/api/team-tasks?session=sess-1', ctxWith([
			{ id: 'task-1', revision: 1, subject: '改 A', status: 'pending', ready: false, blockedBy, writeScopes: ['a'], writeScopeWarnings: [] },
		]))
		assert.equal(out.status, 200, JSON.stringify(out.payload).slice(0, 200))
		assert.equal(out.payload.available, true)
		const row = out.payload.rows[0]
		assert.equal(row.blockedBy.length, 16, '照旧只回前 16 条（载荷要有界）')
		// **行形状不许被这批读数改动**：截断读数走载荷（行形状另有自检逐字钉住）。
		assert.deepEqual(
			Object.keys(row).sort(),
			['blockedBy', 'description', 'id', 'ownerName', 'ready', 'revision', 'status', 'subject', 'writeScopeWarnings', 'writeScopes'],
			'行形状不变，截断读数走 truncations',
		)
		assert.deepEqual(
			out.payload.truncations,
			[{ id: 'task-1', field: 'blockedBy', shown: 16, total: 20, limit: 16 }],
			'逐行的 shown / total 要原样给：' + JSON.stringify(out.payload.truncations),
		)
		assert.ok(
			out.payload.warnings.some((line) => line.includes('按条数截断') && line.includes('truncations')),
			'同一份载荷里行的截断有告警，字段的截断也要有：' + JSON.stringify(out.payload.warnings),
		)
		assert.ok(
			out.payload.warnings.some((line) => line.includes('ready')),
			'要说清 ready 与可见依赖为什么可能读不通：' + JSON.stringify(out.payload.warnings),
		)
	})

	test('没有截断时 truncations 是空数组、也不加那条告警（不许拿它当常驻噪音）', async () => {
		const out = await call('handleTeamTasks', '/company-board/api/team-tasks?session=sess-1', ctxWith([
			{ id: 'task-2', revision: 1, subject: '改 B', status: 'pending', ready: true, blockedBy: ['task-1'], writeScopes: [], writeScopeWarnings: [] },
		]))
		assert.deepEqual(out.payload.truncations, [], '没截断就是空的：' + JSON.stringify(out.payload.truncations))
		assert.ok(!out.payload.warnings.some((line) => line.includes('按条数截断')), '不许无中生有一条告警')
	})

	test('非标量元素被整形丢掉也算"少了"：shown 要照实际回来的条数给', async () => {
		// `asScalarArray` 只留标量 ⇒ 元素里混一个对象时，回来的条数会比 total 少，但并没有碰到 16 条上限。
		const out = await call('handleTeamTasks', '/company-board/api/team-tasks?session=sess-1', ctxWith([
			{ id: 'task-3', revision: 1, subject: '改 C', status: 'pending', ready: true, blockedBy: ['task-1', { nested: true }], writeScopes: [], writeScopeWarnings: [] },
		]))
		assert.equal(out.payload.rows[0].blockedBy.length, 1)
		assert.deepEqual(
			out.payload.truncations,
			[{ id: 'task-3', field: 'blockedBy', shown: 1, total: 2, limit: 16 }],
			'少了就要说出来（不论是因为上限还是因为形状）：' + JSON.stringify(out.payload.truncations),
		)
	})
})

// ── 技能写入：三条路径同一条「先暂存再改名 + 失败清理」 ───────────────────────

describe('技能写入的回滚：失败之后目标目录不存在、残骸不留、重试不被自己挡住', () => {
	/** 注入一次 `writeFileSync` 失败：在子进程里先补 `node:fs`，再装载被测模块。 */
	const runWithWriteFailure = (script, env) => {
		const dir = mkdtempSync(join(tmpdir(), 'gate-skill-'))
		writeFileSync(
			join(dir, 'patch.cjs'),
			"const fs = require('node:fs')\nfs.writeFileSync = () => { throw new Error('注入的写失败') }\n",
		)
		writeFileSync(
			join(dir, 'run.mjs'),
			`import { createSkill, importSkill } from ${JSON.stringify(SKILL_WRITE_URL)}\n` +
				`const out = ${script}\n` +
				`process.stdout.write(JSON.stringify(out))\n`,
		)
		const result = spawnSync(process.execPath, ['--require', join(dir, 'patch.cjs'), join(dir, 'run.mjs')], {
			cwd: ROOT,
			encoding: 'utf8',
			env: { ...process.env, ...env },
		})
		assert.equal(result.status, 0, `子进程要正常退出：${result.stderr ?? ''}`)
		return JSON.parse(result.stdout)
	}
	const skillRootOf = (workspace) => join(workspace, '.dsh', 'skills')

	test('createSkill：写失败后目标目录**不存在**、暂存目录也被清掉，随后重试能成功', async () => {
		const { createSkill } = await import(SKILL_WRITE_URL)
		const ws = mkdtempSync(join(tmpdir(), 'gate-skill-ws-'))
		const failed = runWithWriteFailure(
			'createSkill({ kind: "project", workspace: process.env.GATE_FAIL_WS, name: "injected-fail", description: "d", body: "b" })',
			{ GATE_FAIL_WS: ws },
		)
		assert.equal(failed.ok, false, '写失败要如实报失败：' + JSON.stringify(failed))
		assert.match(failed.reason, /写文件失败/, '理由要说清是写失败：' + failed.reason)
		const root = skillRootOf(ws)
		const target = join(root, 'injected-fail')
		assert.equal(existsSync(target), false, '失败后目标目录**不许**留下（否则它会被"已存在"的守卫当成一份技能）')
		const leftovers = existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('injected-fail.')) : []
		assert.deepEqual(leftovers, [], '暂存目录也要清掉：' + JSON.stringify(leftovers))
		// 这一条是原症状：上一版的空目录留在原地，而下一行的守卫是"已存在就不许重试"。
		const retry = createSkill({ kind: 'project', workspace: ws, name: 'injected-fail', description: 'd', body: 'b' })
		assert.equal(retry.ok, true, '失败之后重试必须能过（不再被上一次的残骸挡住）：' + JSON.stringify(retry))
		assert.ok(readFileSync(join(target, 'SKILL.md'), 'utf8').includes('name: injected-fail'), '重试要真的落成一份技能')
	})

	test('importSkill（单个 .md）写失败后暂存目录也清掉，技能根里不留 `.importing-<pid>`', async () => {
		const ws = mkdtempSync(join(tmpdir(), 'gate-skill-ws-'))
		const source = join(ws, 'source-skill.md')
		writeFileSync(source, '# 一份技能\n')
		const failed = runWithWriteFailure(
			'importSkill({ kind: "project", workspace: process.env.GATE_FAIL_WS, source: process.env.GATE_FAIL_SRC })',
			{ GATE_FAIL_WS: ws, GATE_FAIL_SRC: source },
		)
		assert.equal(failed.ok, false, '写失败要如实报失败：' + JSON.stringify(failed))
		const root = skillRootOf(ws)
		const leftovers = existsSync(root) ? readdirSync(root).filter((name) => name.includes('.importing-')) : []
		assert.deepEqual(leftovers, [], '暂存目录要清掉（对照 importSkillFiles 一直是清的）：' + JSON.stringify(leftovers))
		assert.equal(existsSync(join(root, 'source-skill')), false, '目标目录不许留下')
	})

	test('skillRootLabel 从 skillRootOf 派生：显示的那个根就是真正写入的那个根', async () => {
		const { skillRootLabel, skillRootOf } = await import(SKILL_WRITE_URL)
		const previous = process.env.DSH_HOME
		try {
			process.env.DSH_HOME = '/tmp/gate-dsh-home-probe'
			assert.equal(skillRootOf('user'), '/tmp/gate-dsh-home-probe/skills')
			assert.match(skillRootLabel('user'), /\/tmp\/gate-dsh-home-probe\/skills/, '标签要带上真正那个根：' + skillRootLabel('user'))
			assert.ok(!skillRootLabel('user').includes('~/.dsh/skills'), '不许再硬编码 ~/.dsh/skills（DSH_HOME 优先）')
			assert.match(skillRootLabel('project'), /\.dsh\/skills/, '项目级根照旧：' + skillRootLabel('project'))
		} finally {
			if (previous === undefined) delete process.env.DSH_HOME
			else process.env.DSH_HOME = previous
		}
	})
})

// ── 分发面：注释里引的路径必须真的存在 ───────────────────────────────────────

describe('分发面的引用：注释指的那份基线路径要真的在包里', () => {
	test('cordis.patch.yml 不再指 team/skills/...，指的 team/BASELINE.md 存在', () => {
		const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
		assert.ok(!patch.includes('team/skills/team-playbooks/references/TEAM-BASELINE.md'), '那条不存在的路径不许再出现')
		assert.ok(!existsSync(join(ROOT, 'team', 'skills')), '现场确实没有 team/skills（这条断言的依据）')
		assert.ok(patch.includes('team/BASELINE.md'), '要指向包内那份基线')
		assert.ok(existsSync(join(ROOT, 'team', 'BASELINE.md')), '指的那份文件要真的存在')
	})
})

// ── 路由兜底：未匹配的写请求不许抛 ───────────────────────────────────────────

describe('路由兜底：未匹配的 POST 要回一句可读的 405，而不是抛', () => {
	/**
	 * 把**真路由**挂起来：`apply` 会把前缀 handler 交给宿主（`webServer.register`），
	 * 这里把它截下来直接调 —— 于是测的是那条 route 上的真实分支，而不是某个复刻件。
	 */
	async function mountedRoute() {
		const { apply, ROUTE_PATH } = await import(HOST)
		const specs = []
		const services = {}
		const base = {
			get: (name) => services[name],
			effect: (fn) => {
				const disposer = typeof fn === 'function' ? fn() : undefined
				return () => {
					if (typeof disposer === 'function') disposer()
				}
			},
			inject: () => () => {},
			on: () => () => {},
			logger: { warn() {}, info() {} },
			webServer: {
				get: () => null,
				post: () => null,
				register: (spec) => {
					specs.push(spec)
					return () => {}
				},
			},
		}
		// 真的 cordis ctx 上 `inject` 里声明过的服务是属性、其余走 `ctx.get`：两种读法都支持。
		const ctx = new Proxy(base, {
			get: (target, key) => (typeof key === 'string' && !Reflect.has(target, key) ? services[key] : Reflect.get(target, key)),
		})
		apply(ctx, {})
		const spec = specs.find((entry) => entry.path === ROUTE_PATH)
		assert.ok(spec !== undefined, '前缀路由要挂上：' + specs.map((entry) => entry.path).join('、'))
		return spec
	}

	/** 打一条真请求进去；handler 抛出来的异常不许被这里吞掉（那正是"崩溃路径"的样子）。 */
	async function hit(handler, method, url) {
		const { res, captured } = makeRes()
		await handler({ method, url, headers: { host: '127.0.0.1:19387' } }, res)
		return { status: captured.status, payload: captured.body === '' ? null : JSON.parse(captured.body) }
	}

	test('POST 到未匹配的路径：可读的 405（退回旧实现会抛 ReferenceError ⇒ 这条红）', async () => {
		const spec = await mountedRoute()
		const out = await hit(spec.handler, 'POST', '/company-board/api/not-a-real-endpoint')
		assert.equal(out.status, 405, '要回 405（抛出去在宿主侧就是一次 500）：' + JSON.stringify(out.payload))
		assert.equal(out.payload.ok, false)
		assert.match(out.payload.error, /GET/, '理由要说出这条面收什么方法：' + out.payload.error)
		assert.ok(!String(out.payload.error).includes('DECIDE'), '文案里不许再拼那个不存在的标识符：' + out.payload.error)
		// 静态面一起钉：那句话不许再引用它（只钉行为的话，换一处再拼一次仍然绿）。
		assert.ok(!readFileSync(HOST, 'utf8').includes('DECIDE_PATH'), '源码里不许再有 DECIDE_PATH')
	})

	test('POST 到**存在**的那条只读路径：也是 405，绝不被当成一次读答成 200', async () => {
		// 这一条钉的是"别把兜底分支删掉了事"：删掉之后写方法会落进下面的读路径，
		// 于是 `POST /company-board/api/board` 会被当成一次读 —— 静默接受写方法比回错码更坏。
		const spec = await mountedRoute()
		for (const url of ['/company-board/api', '/company-board/api/board']) {
			const out = await hit(spec.handler, 'POST', url)
			assert.equal(out.status, 405, `${url} 上的写方法要回 405：` + JSON.stringify(out.payload))
		}
	})

	test('GET 照旧走读路径：兜底那一改不许动到只读面', async () => {
		// 无工作区参数 + 没有可回落的工作区 ⇒ 503（"没有可读的工作区"那一句），
		// 关键是它**没有**变成 405 —— 方法判定与读路径的先后关系没被改坏。
		const spec = await mountedRoute()
		const out = await hit(spec.handler, 'GET', '/company-board/api/status')
		assert.equal(out.status, 503, '读端点照旧走它自己那条：' + JSON.stringify(out.payload))
		assert.equal(out.payload.ok, false)
	})
})
