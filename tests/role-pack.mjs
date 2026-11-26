#!/usr/bin/env node
/**
 * **角色包的命令行**：把本机自建的角色导出成一个文件，或把一个包导入回来。
 *
 * 用法（都在包根跑）：
 *
 *   npm run role:export -- --out <文件> [--scope all|workspace|user] [--role <id>]
 *   npm run role:import -- --in <文件> [--scope workspace|user] [--on-conflict skip|overwrite] [--dry-run]
 *   npm run role:list                 # 本机现在有哪些自建角色 / 自建技能
 *
 * 工作区缺省是当前目录（`--workspace` 可以另指）。判定全在 `lib/role-pack.js`，
 * 这里只做参数解析、读写文件、把回执印出来。
 *
 * 退出码：0 = 成功；1 = 判定没过（原因已印出）；2 = 用法错。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildRolePack, importRolePack, inspectRolePack, selfMadeRolesOf, serializeRolePack, suggestedPackName } from '../lib/role-pack.js'

const argv = process.argv.slice(2)

/** 取一个 `--flag value` 形式的值；没有就给 undefined。 */
function flagValue(name) {
	const at = argv.indexOf(name)
	if (at === -1) return undefined
	const next = argv[at + 1]
	return next === undefined || next.startsWith('--') ? undefined : next
}

function usage(message) {
	if (message !== undefined) console.error(`[role-pack] ${message}`)
	console.error(
		[
			'用法：',
			'  npm run role:export -- --out <文件> [--scope all|workspace|user] [--role <id>] [--workspace <目录>]',
			'  npm run role:import -- --in <文件> [--scope workspace|user] [--on-conflict skip|overwrite] [--dry-run] [--workspace <目录>]',
			'  npm run role:list [--workspace <目录>]',
		].join('\n'),
	)
	process.exit(2)
}

const workspace = flagValue('--workspace') ?? process.cwd()
const scope = flagValue('--scope') ?? 'all'

if (argv.includes('--list')) {
	const roles = selfMadeRolesOf(workspace, { scope: 'all' })
	if (roles.length === 0) {
		console.log('[role-pack] 没有自建角色（包内角色不参与导出）。用 `npm run role:new -- <角色 id>` 加一个。')
		process.exit(0)
	}
	console.log(`[role-pack] 自建角色 ${roles.length} 个：`)
	for (const role of roles) console.log(`  ${role.id.padEnd(20)} ${role.origin}${role.skills.length > 0 ? `  技能：${role.skills.join(', ')}` : ''}`)
	process.exit(0)
}

if (argv.includes('--export')) {
	const out = flagValue('--out')
	if (out === undefined) usage('--export 要带 --out <文件>')
	if (scope !== 'all' && scope !== 'workspace' && scope !== 'user') usage(`--scope 只支持 all / workspace / user（收到 ${scope}）`)
	const one = flagValue('--role')
	const built = buildRolePack({ workspace, scope, only: one === undefined ? [] : [one] })
	if (built.ok !== true) {
		console.error(`[role-pack]（未通过） ${built.reason}`)
		process.exit(1)
	}
	const file = resolve(out)
	writeFileSync(file, serializeRolePack(built.pack))
	const roles = built.pack.roles.map((role) => role.id)
	const skills = (built.pack.skills ?? []).map((skill) => skill.name)
	console.log(`[role-pack] 已导出 ${file}`)
	console.log(`[role-pack] 角色 ${roles.length} 个：${roles.join('、')}`)
	if (skills.length > 0) console.log(`[role-pack] 随包技能 ${skills.length} 个：${skills.join('、')}`)
	console.log(`[role-pack] 建议文件名：${suggestedPackName()}`)
	process.exit(0)
}

if (argv.includes('--import')) {
	const input = flagValue('--in')
	if (input === undefined) usage('--import 要带 --in <文件>')
	const importScope = flagValue('--scope') ?? 'workspace'
	if (importScope !== 'workspace' && importScope !== 'user') usage(`--scope 只支持 workspace / user（收到 ${importScope}）`)
	const onConflict = flagValue('--on-conflict') ?? 'skip'
	if (onConflict !== 'skip' && onConflict !== 'overwrite') usage(`--on-conflict 只支持 skip / overwrite（收到 ${onConflict}）`)
	let text
	try {
		text = readFileSync(resolve(input), 'utf8')
	} catch (error) {
		console.error(`[role-pack]（未通过） 读不到包：${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	}
	if (argv.includes('--dry-run')) {
		const inspected = inspectRolePack(text, { workspace, scope: importScope })
		if (inspected.ok !== true) {
			console.error(`[role-pack]（未通过） ${inspected.reason}`)
			process.exit(1)
		}
		const plan = inspected.plan
		console.log(`[role-pack] 预览（scope=${importScope}，落点 ${plan.roleRoot}）：`)
		for (const role of plan.roles) {
			const marks = [role.status === 'exists' ? '已存在' : '新', role.shadowsPackage ? '会遮蔽包内角色' : '', role.otherScopeExists ? '另一作用域已有同名' : ''].filter((x) => x !== '')
			console.log(`  角色 ${role.id.padEnd(20)} ${marks.join(' / ')}`)
		}
		for (const skill of plan.skills) console.log(`  技能 ${skill.name.padEnd(20)} ${skill.status === 'exists' ? '已存在' : '新'}`)
		process.exit(0)
	}
	const result = importRolePack(text, { workspace, scope: importScope, onConflict })
	if (result.ok !== true) {
		console.error(`[role-pack]（未通过） ${result.reason}`)
		process.exit(1)
	}
	const line = (list) => list.map((entry) => `${entry.kind === 'role' ? '角色' : '技能'} ${entry.id}`).join('、')
	console.log(`[role-pack] 落点：${result.roleRoot}（技能 ${result.skillRoot}）`)
	console.log(`[role-pack] 写入 ${result.imported.length}：${line(result.imported) || '（无）'}`)
	if (result.overwritten.length > 0) console.log(`[role-pack] 覆盖 ${result.overwritten.length}：${line(result.overwritten)}`)
	if (result.skipped.length > 0) {
		console.log(`[role-pack] 跳过 ${result.skipped.length}：`)
		for (const entry of result.skipped) console.log(`  ${entry.kind === 'role' ? '角色' : '技能'} ${entry.id} —— ${entry.reason}`)
	}
	process.exit(0)
}

usage('要指定动作：--list / --export / --import')
