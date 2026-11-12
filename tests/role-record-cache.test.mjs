#!/usr/bin/env node
/**
 * 角色记录读缓存的**一致性**自检：加了缓存之后，现场枚举该立刻看见的仍然要立刻看见。
 *
 * 判据全部对着"人改了文件之后下一次枚举看到什么"，不对着缓存实现里的分支：
 * 改正文 / 改 front-matter / 增删角色 / 增删头像 / 同名高处赢 / 调用方改了返回值。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { invalidateRoleRecords } from '../lib/role-record-cache.js'
import { roleRecords } from '../team/team-runtime.js'

const made = []

function roleRoot() {
	const root = mkdtempSync(join(tmpdir(), 'role-record-cache-'))
	made.push(root)
	return root
}

function roleText(id, title, skills = '') {
	return `---\nname: ${id}\nversion: 1\ncategory: 研发\n${skills === '' ? '' : `skills: ${skills}\n`}---\n\n# ${title}（${id}）\n\n一句职责。\n`
}

function addRole(root, id, title, skills = '') {
	const dir = join(root, id)
	mkdirSync(dir, { recursive: true })
	const file = join(dir, 'ROLE.md')
	writeFileSync(file, roleText(id, title, skills))
	return { dir, file }
}

function recordsOf(roots) {
	return roleRecords(roots.map((root) => ({ root, source: 'explicit' })))
}

afterEach(() => {
	invalidateRoleRecords()
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('角色记录读缓存：现场枚举的即时性不许被缓存吃掉', () => {
	test('重复枚举结果一致；命中缓存不重读 ROLE.md', () => {
		const root = roleRoot()
		addRole(root, 'architect', '架构师', 'ddd, review')
		const first = recordsOf([root])
		const second = recordsOf([root])
		assert.equal(first.length, 1)
		assert.equal(first[0].title, '架构师')
		assert.deepEqual(first[0].skills, ['ddd', 'review'])
		assert.deepEqual(second, first, '第二次枚举必须与第一次逐字一致')
	})

	test('改 ROLE.md（含同长度改动）⇒ 下一轮立刻看到新正文与 skills', () => {
		const root = roleRoot()
		const { file } = addRole(root, 'reviewer', '评审员', 'review')
		assert.equal(recordsOf([root])[0].title, '评审员')
		writeFileSync(file, roleText('reviewer', '复核员', 'gate'))
		const changed = recordsOf([root])[0]
		assert.equal(changed.title, '复核员', '同长度改动也要看得见（签名不能只看 mtimeMs + size）')
		assert.deepEqual(changed.skills, ['gate'])
		assert.match(changed.body, /一句职责/)
	})

	test('增删角色目录 ⇒ 下一轮立刻增减，不需要重启或手动失效', () => {
		const root = roleRoot()
		addRole(root, 'qa', '测试')
		assert.deepEqual(recordsOf([root]).map((row) => row.id), ['qa'])
		addRole(root, 'legal', '法务')
		assert.deepEqual(recordsOf([root]).map((row) => row.id).sort(), ['legal', 'qa'])
		rmSync(join(root, 'qa'), { recursive: true, force: true })
		assert.deepEqual(recordsOf([root]).map((row) => row.id), ['legal'])
	})

	test('角色目录里新增 / 删掉头像 ⇒ avatarFile 立刻跟着变', () => {
		const root = roleRoot()
		const { dir } = addRole(root, 'security', '安全')
		assert.equal(recordsOf([root])[0].avatarFile, null)
		const avatar = join(dir, 'avatar.svg')
		writeFileSync(avatar, '<svg/>')
		assert.equal(recordsOf([root])[0].avatarFile, 'avatar.svg')
		rmSync(avatar)
		assert.equal(recordsOf([root])[0].avatarFile, null)
	})

	test('同 id 时先列的根赢；同一个根换来源标记不串味', () => {
		const high = roleRoot()
		const low = roleRoot()
		addRole(high, 'architect', '工作区那份')
		addRole(low, 'architect', '包内那份')
		const rows = roleRecords([
			{ root: high, source: 'workspace' },
			{ root: low, source: 'package' },
		])
		assert.equal(rows.length, 1)
		assert.equal(rows[0].title, '工作区那份')
		assert.equal(rows[0].source, 'workspace')
		const relabelled = roleRecords([{ root: high, source: 'package' }])
		assert.equal(relabelled[0].source, 'package', '同一 root 换了来源，记录要跟着换')
		assert.equal(relabelled[0].title, '工作区那份')
	})

	test('返回的是副本：调用方改记录 / 改 skills 都不污染缓存', () => {
		const root = roleRoot()
		addRole(root, 'analyst', '分析师', 'data')
		const first = recordsOf([root])[0]
		first.title = '被人改过'
		first.skills.push('extra')
		const again = recordsOf([root])[0]
		assert.equal(again.title, '分析师')
		assert.deepEqual(again.skills, ['data'])
	})

	test('ROLE.md 读不成（同名目录）⇒ 跳过这一个、不抛，其余角色照旧', () => {
		const root = roleRoot()
		addRole(root, 'dev', '开发')
		rmSync(join(root, 'dev', 'ROLE.md'))
		mkdirSync(join(root, 'dev', 'ROLE.md'))
		addRole(root, 'ops', '运维')
		assert.deepEqual(recordsOf([root]).map((row) => row.id), ['ops'])
	})

	test('缺 ROLE.md 的目录不算角色；显式失效后仍能正常枚举', () => {
		const root = roleRoot()
		mkdirSync(join(root, 'not-a-role'), { recursive: true })
		addRole(root, 'qa', '测试')
		assert.deepEqual(recordsOf([root]).map((row) => row.id), ['qa'])
		invalidateRoleRecords()
		assert.equal(existsSync(join(root, 'qa', 'ROLE.md')), true)
		assert.deepEqual(recordsOf([root]).map((row) => row.id), ['qa'])
	})
})
