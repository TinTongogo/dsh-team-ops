#!/usr/bin/env node
/**
 * 角色名册的**命令行**：查漂移 / 刷新文档 / 加一个角色。
 *
 * 三条用法（都在包根跑）：
 *
 * npm run roster # 检查漂移：文档里的生成块 ≠ 现场枚举 ⇒ 非零退出
 * npm run roster:write # 把生成块刷新进团队基线与 README
 * npm run role:new -- <角色 id> [--title 显示名] [--when "什么时候派它"] [--package]
 * # 生成新角色骨架到**用户级角色根**（不加 --package 就不改包）
 *
 * 为什么默认落到用户级角色根（`$DSH_TEAM_OPS_ROLES`，缺省 `~/.dsh/team-ops/roles`）：
 * "一人公司"的编制是**用的人**的事 —— 不出包、不动源码、也不参与本包的 git 历史，
 * 重启后协调器就能按这个角色派人。要把它固化成团队默认编制，再抄进包内 `skills/`。
 *
 * 退出码：0 = 一致 / 已写入 / 已生成；1 = 有漂移或参数不合法；2 = 用法错。
 */

import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PACKAGED_ROLES_ROOT, checkRoster, readRoster, userRolesRoot, writeRoleScaffold, writeRoster } from '../lib/roster.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

/** 取一个 `--flag value` 形式的值；没有就给 undefined。 */
function flagValue(name) {
	const at = argv.indexOf(name)
	return at === -1 ? undefined : argv[at + 1]
}

function printRoster(roster) {
	console.log(`角色 ${roster.roles.length} 个（${[...new Set(roster.roles.map((role) => role.source))].join('/')}）：`)
	for (const role of roster.roles) console.log(` ${role.id.padEnd(14)} ${role.title} —— ${role.duty.slice(0, 40)}`)
	if (roster.shadowed.length > 0) {
		console.log(`被遮蔽的同名目录：${roster.shadowed.map((entry) => `${entry.id}（${entry.shadowedSource} 被 ${entry.winnerSource} 遮蔽）`).join('、')}`)
	}
}

if (argv.includes('--help') || argv.includes('-h')) {
	console.log('用法：node tests/roster.mjs [--check|--write|--list|--new <id> [--title T] [--when W] [--package]]')
	process.exit(2)
}

if (argv.includes('--list')) {
	// 全量（含用户级角色根）：这是"我这台机器上现在有哪些角色"的那个读数
	printRoster(readRoster())
	process.exit(0)
}

if (argv.includes('--write')) {
	const results = writeRoster(packageRoot)
	let failed = 0
	for (const result of results) {
		if (result.ok) console.log(`[roster] ${result.changed === false ? '已是最新' : '已刷新'} ${result.label}（${relative(packageRoot, result.path)}）`)
		else {
			failed += 1
			console.error(`[roster]（未通过） ${result.label}：${result.reason}`)
		}
	}
	process.exit(failed === 0 ? 0 : 1)
}

if (argv.includes('--new')) {
	const id = flagValue('--new')
	if (id === undefined || id.startsWith('--')) {
		console.error('[roster] --new 后面要给角色 id，例如：npm run role:new -- content-ops')
		process.exit(2)
	}
	const toPackage = argv.includes('--package')
	const root = toPackage ? PACKAGED_ROLES_ROOT : userRolesRoot()
	const written = writeRoleScaffold(id, {
		title: flagValue('--title') ?? id,
		when: flagValue('--when') ?? '（写什么时候该派这个角色）',
		root,
	})
	if (!written.ok) {
		console.error(`[roster]（未通过） 没生成：${written.reason}`)
		process.exit(1)
	}
	console.log(`[roster] 已生成角色定义骨架：${written.file}`)
	console.log('[roster] 下一步：① 把它写满（视角 / 检查表 / 落点 / 边界 四段，并补上 category / 装备字段）；② 跑 npm run roster:write 刷新生名册；③ **不用重启就能用**：`member_spawn role=' + id + '` 立刻派得出去（名册是现枚举的）；只有注入到系统提示里那份「可叫的队友」清单是装载时的快照，要重启 DSH 才更新。')
	process.exit(0)
}

// 默认 = 检查漂移
const roster = readRoster()
const drifted = checkRoster(packageRoot).filter((target) => !target.ok)
console.log(`[roster] 现场枚举：角色 ${roster.roles.length} 个${existsSync(userRolesRoot()) ? `（含用户级角色根 ${userRolesRoot()}）` : ''}`)
if (drifted.length === 0) {
	console.log('[roster] 文档里的生成块与现场一致。')
	process.exit(0)
}
for (const target of drifted) {
	console.error(`[roster]（未通过） ${target.label}（${relative(packageRoot, target.path)}）与现场不一致`)
}
console.error('[roster] 修法：npm run roster:write（它会按现场刷新这两段生成块）。')
process.exit(1)
