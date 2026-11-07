#!/usr/bin/env node
/**
 * 热路径基准：`node tests/bench.mjs`（或 `npm run bench`）。
 *
 * 只量两条**每次请求 / 每次发言都会走**的路径：
 *   1. 摘要 hook 的一次冷进程（提交提示词的关键路径，包含 Node 启动开销）；
 *   2. 角色名册的一次现场枚举（面板读端点、成员/角色工具每次都要用）。
 *
 * 不写成"性能断言"：机器负载与磁盘缓存会让绝对数字浮动，放进 npm test 只会制造假红。
 * 用法是重构前后各跑一次、对比同一台机器上的中位数；功能正确性由 npm test 负责。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { appendStructured, structuredPathOf } from '../lib/checkpoint.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WARMUP = 5
const RUNS = Number(process.env.BENCH_RUNS ?? 40)

/** 一份"典型工作区"：四份真源 + 两份遗留账（遗留账内容不小，正好量出读放大）。 */
function workspace() {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-team-ops-bench-'))
	mkdirSync(join(dir, '.ops'), { recursive: true })
	const ledger = { version: 1, seq: 1 }
	const rows = Array.from({ length: 60 }, (_, index) => ({ id: `T-${index}`, status: 'pending' }))
	const big = JSON.stringify({ ...ledger, tasks: rows })
	for (const name of ['human', 'roles', 'roster', 'handoff', 'board', 'members']) {
		writeFileSync(join(dir, '.ops', `${name}.json`), name === 'human' ? JSON.stringify({ ...ledger, words: [] }) : big)
	}
	return dir
}

function report(label, runs, samples) {
	samples.sort((a, b) => a - b)
	const mean = samples.reduce((sum, value) => sum + value, 0) / runs
	console.log(`${label}: mean=${mean.toFixed(3)}ms median=${samples[Math.floor(runs / 2)].toFixed(3)}ms (n=${runs})`)
}

function bench(label, runs, fn) {
	for (let index = 0; index < Math.min(WARMUP, runs); index += 1) fn()
	const samples = []
	for (let index = 0; index < runs; index += 1) {
		const at = performance.now()
		fn()
		samples.push(performance.now() - at)
	}
	report(label, runs, samples)
}

/** 异步路径（检查点写盘）：等这一笔真的落完再计时。 */
async function benchAsync(label, runs, fn) {
	for (let index = 0; index < Math.min(WARMUP, runs); index += 1) await fn()
	const samples = []
	for (let index = 0; index < runs; index += 1) {
		const at = performance.now()
		await fn()
		samples.push(performance.now() - at)
	}
	report(label, runs, samples)
}

const dir = workspace()
try {
	bench('digest CLI (cold process)', Math.min(RUNS, 20), () => {
		const result = spawnSync(process.execPath, [join(ROOT, 'lib', 'ledger-digest.js'), '--workspace', dir, '--text'], { encoding: 'utf8' })
		if (result.status !== 0) throw new Error(`摘要 hook 退出了 ${result.status}：${result.stderr}`)
	})

	const runtime = await import(join(ROOT, 'team', 'team-runtime.js'))
	// 显式给包内角色根：不让"这台机器装了几个自建角色"影响数字。
	const roots = [{ root: join(ROOT, 'team', 'roles'), source: 'package' }]
	bench('roleRecords(package roots)', RUNS, () => {
		const rows = runtime.roleRecords(roots)
		if (rows.length === 0) throw new Error('包内角色一个都没枚举到')
	})
	bench('roleRecordsFor(workspace)', RUNS, () => runtime.roleRecordsFor(dir))

	// 一份接近上限的检查点：量"再追加一节"的代价（旧实现会把整份读出来再全量重写）。
	const checkpointPath = structuredPathOf(dir, 'task-1')
	mkdirSync(join(dir, 'docs', 'team', 'checkpoints'), { recursive: true })
	writeFileSync(checkpointPath, `# task-1\n\n${'既有结论·'.repeat(20_000)}\n`, 'utf8')
	await benchAsync('appendStructured (~300KB checkpoint)', Math.min(RUNS, 20), () =>
		appendStructured(dir, 'task-1', { summary: '追加一节' }, { maxBytes: 8 * 1024 * 1024 }),
	)
} finally {
	rmSync(dir, { recursive: true, force: true })
}
