#!/usr/bin/env node
/**
 * 任务派发守卫：明确执行人、阻止重复分配、派发前校验、输出冲突风险。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assignmentGuardOf } from '../lib/assignment.js'

const base = (over = {}) => ({
	task: { id: 'task-1', status: 'pending', ownerName: '', blockedBy: [], writeScopes: [] },
	targetOwner: 'dev-1',
	expectedRevision: 1,
	handover: false,
	allTasks: [],
	members: ['dev-1'],
	id: 'task-1',
	...over,
})

describe('派发守卫：阻断项', () => {
	test('首次分配明确标记执行人与锁定状态', () => {
		const result = assignmentGuardOf(base())
		assert.equal(result.ok, true)
		assert.deepEqual(result.assignment, { owner: 'dev-1', locked: true, previousOwner: '', handover: false })
		assert.deepEqual(result.risks, [])
	})

	test('不写执行人 ⇒ 阻止', () => {
		assert.equal(assignmentGuardOf(base({ targetOwner: '' })).conflict.code, 'missing_owner')
	})

	test('不带 expected_revision ⇒ 阻止（防并发改派）', () => {
		assert.equal(assignmentGuardOf(base({ expectedRevision: undefined })).conflict.code, 'missing_revision')
	})

	test('读不到任务本体 ⇒ 阻止，不盲改', () => {
		assert.equal(assignmentGuardOf(base({ task: null })).conflict.code, 'task_unreadable')
	})

	test('已完成的任务 ⇒ 阻止，提示开新任务', () => {
		const result = assignmentGuardOf(base({ task: { ...base().task, status: 'completed' } }))
		assert.equal(result.conflict.code, 'completed_task')
		assert.match(result.conflict.message, /新任务/)
	})

	test('重复分配给同一人 ⇒ 阻止', () => {
		const result = assignmentGuardOf(base({ task: { ...base().task, ownerName: 'dev-1', status: 'in_progress' } }))
		assert.equal(result.conflict.code, 'duplicate_assignment')
		assert.match(result.conflict.message, /dev-1/)
	})

	test('他人误派已被锁定的任务 ⇒ 阻止', () => {
		const result = assignmentGuardOf(base({ task: { ...base().task, ownerName: 'qa-1', status: 'in_progress' } }))
		assert.equal(result.conflict.code, 'locked_by_other')
		assert.match(result.conflict.message, /qa-1/)
		assert.match(result.conflict.message, /handover/)
	})

	test('显式 handover ⇒ 允许转派，并给出转派风险', () => {
		const result = assignmentGuardOf(base({
			task: { ...base().task, ownerName: 'qa-1', status: 'in_progress' },
			handover: true,
		}))
		assert.equal(result.ok, true)
		assert.equal(result.assignment.handover, true)
		assert.ok(result.risks.some((risk) => risk.code === 'handover_risk'))
	})
})

describe('派发守卫：潜在风险提示（不阻断）', () => {
	test('依赖未解除 ⇒ 提示', () => {
		const result = assignmentGuardOf(base({ task: { ...base().task, blockedBy: ['task-0'] } }))
		assert.equal(result.ok, true)
		assert.ok(result.risks.some((risk) => risk.code === 'blocked_dependency' && risk.message.includes('task-0')))
	})

	test('写盘面与其它进行中任务重叠 ⇒ 提示冲突任务号', () => {
		const result = assignmentGuardOf(base({
			task: { ...base().task, writeScopes: ['src/app.ts'] },
			allTasks: [{ id: 'task-9', status: 'in_progress', writeScopes: ['src/'] }],
		}))
		assert.ok(result.risks.some((risk) => risk.code === 'write_scope_overlap' && risk.message.includes('task-9')))
	})

	test('已完成任务的写盘面不算重叠', () => {
		const result = assignmentGuardOf(base({
			task: { ...base().task, writeScopes: ['src/app.ts'] },
			allTasks: [{ id: 'task-9', status: 'completed', writeScopes: ['src/'] }],
		}))
		assert.ok(!result.risks.some((risk) => risk.code === 'write_scope_overlap'))
	})

	test('目标成员不在场 ⇒ 提示', () => {
		const result = assignmentGuardOf(base({ members: ['qa-1'] }))
		assert.ok(result.risks.some((risk) => risk.code === 'assignee_absent' && risk.message.includes('dev-1')))
	})

	test('同一执行人已有 3 条进行中 ⇒ 提示负载', () => {
		const tasks = [1, 2, 3].map((n) => ({ id: 'task-' + n, status: 'in_progress', ownerName: 'dev-1', writeScopes: [] }))
		const result = assignmentGuardOf(base({ allTasks: tasks }))
		assert.ok(result.risks.some((risk) => risk.code === 'owner_overload'))
	})
})
