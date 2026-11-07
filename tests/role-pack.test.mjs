/**
 * **角色包**的域规则自检：导出收谁、包里装什么、什么样的包算包、导入怎么落。
 *
 * 与其余测试文件同一套隔离（顶层 `import './isolate.mjs'`）：用户角色根与技能根都在临时 home 里，
 * 用例之间 `resetIsolatedHome()` —— 绝不碰真实的 `~/.dsh/team-ops/roles` 与 `~/.dsh/skills`。
 */

import './isolate.mjs'

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'

import {
	PACK_FORMAT,
	PACK_FORMAT_VERSION,
	buildRolePack,
	importRolePack,
	inspectRolePack,
	parseRolePack,
	selfMadeRolesOf,
	serializeRolePack,
} from '../lib/role-pack.js'
import { userRolesRoot, workspaceRolesRoot } from '../lib/roster.js'
import { skillRootOf } from '../lib/skill-write.js'
import { ISOLATED_HOME, ISOLATION_PREFIX, resetIsolatedHome } from './isolate.mjs'

beforeEach(resetIsolatedHome)

const AVATAR_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10])

/** 一个临时工作区。 */
function makeWorkspace() {
	return mkdtempSync(join(tmpdir(), 'role-pack-ws-'))
}

/** 在某个角色根里写一份角色目录（`ROLE.md` + 可选头像）。 */
function writeRole(root, id, { skills = '', avatar = false, body = '一句话职责。' } = {}) {
	const dir = join(root, id)
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'ROLE.md'), `---\nkind: role\nname: ${id}\ncategory: 研发\ndescription: Use when 需要它\n${skills === '' ? '' : `skills: ${skills}\n`}---\n\n# ${id}（${id}）\n\n${body}\n`)
	if (avatar) writeFileSync(join(dir, 'avatar.png'), AVATAR_BYTES)
	return dir
}

/** 在某个技能根里写一份技能目录。 */
function writeSkill(root, name) {
	const dir = join(root, name)
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 作业程序\n---\n\n步骤。\n`)
	return dir
}

describe('测试与用户真实目录隔离（哨兵）', () => {
	test('用户角色根落在临时 home 下，不是 ~/.dsh', () => {
		assert.ok(userRolesRoot().startsWith(ISOLATION_PREFIX), `用户角色根不在隔离 home 下：${userRolesRoot()}`)
		assert.ok(skillRootOf('user').startsWith(ISOLATION_PREFIX), `用户技能根不在隔离 home 下：${skillRootOf('user')}`)
	})
})

describe('导出：只收自建角色，包内那份不参与', () => {
	test('用户根里的角色进包；包内 19 个角色一个都不进', () => {
		const workspace = makeWorkspace()
		writeRole(userRolesRoot(), 'my-role')
		const built = buildRolePack({ workspace })
		assert.equal(built.ok, true, built.reason)
		assert.deepEqual(built.pack.roles.map((role) => role.id), ['my-role'])
		assert.equal(built.pack.format, PACK_FORMAT)
		assert.equal(built.pack.formatVersion, PACK_FORMAT_VERSION)
		assert.ok(!built.pack.roles.some((role) => role.id === 'reviewer'), '包内角色不许进包')
	})

	test('工作区根里的角色进包，origin 标 workspace', () => {
		const workspace = makeWorkspace()
		writeRole(workspaceRolesRoot(workspace), 'local-role')
		const built = buildRolePack({ workspace })
		assert.equal(built.ok, true, built.reason)
		assert.equal(built.pack.roles.length, 1)
		assert.equal(built.pack.roles[0].origin, 'workspace')
	})

	test('一个自建角色都没有 ⇒ 拒绝并说明（不产空包）', () => {
		const built = buildRolePack({ workspace: makeWorkspace() })
		assert.equal(built.ok, false)
		assert.match(built.reason, /没有可导出的自建角色/)
	})

	test('`--role` 点名的角色不在自建里 ⇒ 拒绝并点名', () => {
		const built = buildRolePack({ workspace: makeWorkspace(), only: ['reviewer'] })
		assert.equal(built.ok, false)
		assert.match(built.reason, /reviewer/)
	})

	test('scope=user 只收用户根，scope=workspace 只收工作区根', () => {
		const workspace = makeWorkspace()
		writeRole(userRolesRoot(), 'u-role')
		writeRole(workspaceRolesRoot(workspace), 'w-role')
		assert.deepEqual(buildRolePack({ workspace, scope: 'user' }).pack.roles.map((role) => role.id), ['u-role'])
		assert.deepEqual(buildRolePack({ workspace, scope: 'workspace' }).pack.roles.map((role) => role.id), ['w-role'])
		assert.deepEqual(buildRolePack({ workspace, scope: 'all' }).pack.roles.map((role) => role.id).sort(), ['u-role', 'w-role'])
	})
})

describe('包内容：技能与头像', () => {
	test('角色 skills: 指向的自建技能随包走；本机没有的引用不凭空造', () => {
		const workspace = makeWorkspace()
		writeRole(userRolesRoot(), 'my-role', { skills: 'mine, missing-skill' })
		writeSkill(skillRootOf('user'), 'mine')
		const built = buildRolePack({ workspace })
		assert.equal(built.ok, true, built.reason)
		assert.deepEqual(built.pack.skills.map((skill) => skill.name), ['mine'])
		assert.equal(built.pack.skills[0].files[0].path, 'SKILL.md')
	})

	test('没有自建技能时 skills 那一段不出现（不是空数组）', () => {
		const workspace = makeWorkspace()
		writeRole(userRolesRoot(), 'my-role')
		const built = buildRolePack({ workspace })
		assert.equal(built.pack.skills, undefined)
	})

	test('头像按 base64 进包，导入后字节一模一样', () => {
		const workspace = makeWorkspace()
		writeRole(userRolesRoot(), 'my-role', { avatar: true })
		const built = buildRolePack({ workspace })
		const avatar = built.pack.roles[0].files.find((file) => file.path === 'avatar.png')
		assert.equal(avatar.encoding, 'base64')
		const other = makeWorkspace()
		const result = importRolePack(serializeRolePack(built.pack), { workspace: other, scope: 'user' })
		assert.equal(result.ok, true, result.reason)
		const written = readFileSync(join(userRolesRoot(), 'my-role', 'avatar.png'))
		assert.ok(written.equals(AVATAR_BYTES), '头像字节被改动了')
	})
})

describe('校验：什么样的包不算包', () => {
	const good = () => {
		const workspace = makeWorkspace()
		writeRole(userRolesRoot(), 'my-role')
		return buildRolePack({ workspace }).pack
	}

	test('format 不对 ⇒ 拒绝', () => {
		const parsed = parseRolePack({ ...good(), format: 'something/else' })
		assert.equal(parsed.ok, false)
		assert.match(parsed.reason, /不是角色包/)
	})

	test('formatVersion 不认 ⇒ 拒绝且不猜', () => {
		const parsed = parseRolePack({ ...good(), formatVersion: 99 })
		assert.equal(parsed.ok, false)
		assert.match(parsed.reason, /版本认不出/)
	})

	test('roles 空 ⇒ 拒绝', () => {
		const parsed = parseRolePack({ ...good(), roles: [] })
		assert.equal(parsed.ok, false)
		assert.match(parsed.reason, /包里没有角色/)
	})

	test('路径穿越 / 绝对路径 / 隐藏文件 一律拒绝', () => {
		for (const path of ['../evil.md', '/etc/passwd', '.hidden.md', 'a/../../b.md']) {
			const pack = good()
			pack.roles[0].files.push({ path, encoding: 'utf8', text: 'x' })
			const parsed = parseRolePack(pack)
			assert.equal(parsed.ok, false, `这个路径该被拒：${path}`)
		}
	})

	test('角色里出现不认识的文件 ⇒ 拒绝（白名单只有 ROLE.md 与头像）', () => {
		const pack = good()
		pack.roles[0].files.push({ path: 'notes.md', encoding: 'utf8', text: 'x' })
		const parsed = parseRolePack(pack)
		assert.equal(parsed.ok, false)
		assert.match(parsed.reason, /不认识的文件/)
	})

	test('id 不合法（形状 / 超长）走角色那一处判定', () => {
		const pack = good()
		pack.roles[0].id = 'Bad_Id'
		assert.equal(parseRolePack(pack).ok, false)
		pack.roles[0].id = 'a'.repeat(70)
		const parsed = parseRolePack(pack)
		assert.equal(parsed.ok, false)
		assert.match(parsed.reason, /太长/)
	})

	test('同一个 id 出现两次 ⇒ 拒绝', () => {
		const pack = good()
		pack.roles.push({ ...pack.roles[0] })
		const parsed = parseRolePack(pack)
		assert.equal(parsed.ok, false)
		assert.match(parsed.reason, /出现了两次/)
	})

	test('不是 JSON / 不是对象 ⇒ 拒绝', () => {
		assert.equal(parseRolePack('{ not json').ok, false)
		assert.equal(parseRolePack('[]').ok, false)
		assert.equal(parseRolePack(null).ok, false)
	})
})

describe('预览：新的 / 已存在的 / 会遮蔽包内角色的', () => {
	test('目标根为空 ⇒ 全是新的；已存在 ⇒ exists；与包内同名 ⇒ shadowsPackage', () => {
		const workspace = makeWorkspace()
		writeRole(userRolesRoot(), 'my-role')
		const built = buildRolePack({ workspace })
		const text = serializeRolePack(built.pack)
		// 「新的」要在**另一个根**里看：那份角色在用户根里，所以换个工作区、导到项目根
		const fresh = inspectRolePack(text, { workspace: makeWorkspace(), scope: 'workspace' })
		assert.equal(fresh.ok, true, fresh.reason)
		assert.equal(fresh.plan.roles[0].status, 'new')
		assert.equal(fresh.plan.roles[0].shadowsPackage, false)

		const same = inspectRolePack(text, { workspace, scope: 'user' })
		assert.equal(same.plan.roles[0].status, 'exists')

		const pack = built.pack
		pack.roles[0].id = 'reviewer'
		const shadow = inspectRolePack(serializeRolePack(pack), { workspace: makeWorkspace(), scope: 'user' })
		assert.equal(shadow.plan.roles[0].shadowsPackage, true, '与包内同名要标出来')
	})

	test('预览不落任何文件', () => {
		const workspace = makeWorkspace()
		writeRole(userRolesRoot(), 'my-role')
		const text = serializeRolePack(buildRolePack({ workspace }).pack)
		const target = makeWorkspace()
		inspectRolePack(text, { workspace: target, scope: 'workspace' })
		assert.equal(existsSync(join(workspaceRolesRoot(target), 'my-role')), false, '预览之后目标根里不该有东西')
	})
})

describe('导入：默认不覆盖，覆盖留证', () => {
	const setup = () => {
		const workspace = makeWorkspace()
		writeRole(userRolesRoot(), 'my-role', { body: '原始那一份。' })
		const text = serializeRolePack(buildRolePack({ workspace }).pack)
		return { workspace, text }
	}

	test('默认跳过已存在的同名角色，并说明原因', () => {
		const { workspace, text } = setup()
		const result = importRolePack(text, { workspace, scope: 'user' })
		assert.equal(result.ok, true, result.reason)
		assert.equal(result.imported.length, 0)
		assert.equal(result.skipped.length, 1)
		assert.match(result.skipped[0].reason, /已存在/)
	})

	test('显式 overwrite 才覆盖，且原文件留 .bak', () => {
		const { workspace, text } = setup()
		const target = join(userRolesRoot(), 'my-role', 'ROLE.md')
		writeFileSync(target, '一份被改过的内容\n')
		const result = importRolePack(text, { workspace, scope: 'user', onConflict: 'overwrite' })
		assert.equal(result.ok, true, result.reason)
		assert.equal(result.overwritten.length, 1)
		assert.equal(readFileSync(join(userRolesRoot(), 'my-role', 'ROLE.md.bak'), 'utf8'), '一份被改过的内容\n')
		assert.match(readFileSync(target, 'utf8'), /原始那一份/, '包里的内容要盖回去')
	})

	test('冲突策略认不出 ⇒ 拒绝（不默认成某一种）', () => {
		const { workspace, text } = setup()
		const result = importRolePack(text, { workspace, scope: 'user', onConflict: 'whatever' })
		assert.equal(result.ok, false)
		assert.match(result.reason, /只认 skip \/ overwrite/)
	})

	test('作用域分流：workspace 落项目根，user 落用户根', () => {
		const workspace = makeWorkspace()
		writeRole(userRolesRoot(), 'my-role')
		const text = serializeRolePack(buildRolePack({ workspace }).pack)
		const target = makeWorkspace()
		importRolePack(text, { workspace: target, scope: 'workspace' })
		assert.equal(existsSync(join(workspaceRolesRoot(target), 'my-role', 'ROLE.md')), true)
		const other = makeWorkspace()
		importRolePack(text, { workspace: other, scope: 'user' })
		assert.equal(existsSync(join(userRolesRoot(), 'my-role', 'ROLE.md')), true)
	})

	test('导入之后现场枚举能看见它（不是只写了个文件）', () => {
		const workspace = makeWorkspace()
		writeRole(userRolesRoot(), 'my-role')
		const text = serializeRolePack(buildRolePack({ workspace }).pack)
		const target = makeWorkspace()
		importRolePack(text, { workspace: target, scope: 'workspace' })
		assert.deepEqual(selfMadeRolesOf(target).map((role) => role.id), ['my-role'])
	})
})

describe('边界：导入不写包内根', () => {
	test('包内角色根里的文件系统不动（导入只落可写根）', () => {
		const workspace = makeWorkspace()
		writeRole(userRolesRoot(), 'my-role')
		const text = serializeRolePack(buildRolePack({ workspace }).pack)
		const before = readFileSync('team/roles/qa/ROLE.md', 'utf8')
		importRolePack(text, { workspace, scope: 'workspace' })
		assert.equal(readFileSync('team/roles/qa/ROLE.md', 'utf8'), before)
	})
})

describe('README 也写了这一节（用户可见的能力不许只活在代码里）', () => {
	test('角色包那一节在，导出 / 导入 / 默认不覆盖 / 命令行都写到了', () => {
		const readme = readFileSync('README.md', 'utf8')
		assert.match(readme, /角色包/, 'README 要有角色包这一节')
		assert.match(readme, /role:export/, '要写命令行怎么导出')
		assert.match(readme, /role:import/, '要写命令行怎么导入')
		assert.match(readme, /默认不覆盖/, '要写清冲突的默认行为')
		assert.match(readme, /lib\/role-pack\.js/, '要指出判定在哪一处')
	})
})
