#!/usr/bin/env node
/**
 * 角色契约（阶段 2）：`ROLE.md`「落点」段 → 路径归属；同一路径被两个角色 owns ⇒ 冲突。
 */
import { beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resetIsolatedHome } from './isolate.mjs'
import { allRoleContracts, contractConflicts, normalizePath, roleContractOf } from '../lib/role-contract.js'

beforeEach(resetIsolatedHome)

describe('角色契约：解析与冲突检测', () => {
	test('包内角色解析出「落点」段里的路径', () => {
		const contract = roleContractOf('ai-engineer')
		assert.equal(contract.role, 'ai-engineer')
		assert.ok(contract.owns.some((entry) => entry.path === 'docs/ai'), '要做没有的路径：' + JSON.stringify(contract.owns))
		assert.ok(Array.isArray(contract.excludes), '排除项要是数组')
	})

	test('路径归一：尾斜杠与空白不影响归属', () => {
		assert.equal(normalizePath('docs/ai/'), 'docs/ai')
		assert.equal(normalizePath('  docs/ai  '), 'docs/ai')
	})

	test('同一路径被两个角色 owns ⇒ 报冲突（按路径排序）', () => {
		const conflicts = contractConflicts([
			{ role: 'a', owns: [{ path: 'docs/x' }] },
			{ role: 'b', owns: [{ path: 'docs/x/' }] },
			{ role: 'c', owns: [{ path: 'docs/y' }] },
		])
		assert.deepEqual(conflicts, [{ path: 'docs/x', roles: ['a', 'b'] }])
	})

	test('单角色与全量**同一份解析**：同一个角色的 owns / excludes 必须逐条相同', () => {
		// 判据是"同一事实只有一处实现"：从前 `roleContractOf` 与 `allRoleContracts` 各写一遍解析，
		// 改一处漏一处就会让"这个角色 owns 什么"出现两个答案（冲突数也成了两个数）。
		for (const contract of allRoleContracts()) {
			const single = roleContractOf(contract.role)
			assert.deepEqual(single.owns, contract.owns, contract.role + ' 的 owns 两个入口必须一致')
			assert.deepEqual(single.excludes, contract.excludes, contract.role + ' 的 excludes 两个入口必须一致')
		}
	})

	test('全量契约：每个角色都给出数组，冲突为 0（当前包内角色互不重叠）', () => {
		const contracts = allRoleContracts()
		assert.ok(contracts.length > 0, '要能枚举出现场角色')
		for (const contract of contracts) {
			assert.ok(Array.isArray(contract.owns), contract.role + ' owns 要是数组')
			assert.ok(Array.isArray(contract.excludes), contract.role + ' excludes 要是数组')
		}
		assert.deepEqual(contractConflicts(contracts), [], '包内角色路径不该重叠')
	})
})
