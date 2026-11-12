#!/usr/bin/env node
/**
 * 成员后端端口的**契约测试**：两套实现（subagent / agent-team）各自照宿主调用面测一遍。
 *
 * 为什么单独测：`team-ops.test.mjs` 的假件是**旧宿主**（`agentTeams.spawnTeammate`），
 * 新宿主那条路（`subagents.startActivation`）没有覆盖；探针只证明方法在，不证明调用形状对。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { memberBackendOf } from '../team/member-backend.js'

const lead = { id: 'root-1' }
const child = { id: 'child-1' }

/** 新宿主的假件：形状照 `dsh-subagent` 与 `dsh-tool-subagent-control` 的调用面。 */
function subagentHost() {
	const calls = { list: [], spawn: [], send: [], interrupt: [] }
	const subagents = {
		rootOf: (agent) => {
			assert.equal(agent, lead)
			return lead
		},
		async listDescendants(rootId, signal) {
			calls.list.push({ rootId, signal })
			return [
				{ kind: 'child', id: 'child-1', mode: 'continuable', label: '独立复核交付物', path: 'reviewer-1', activity: 'inactive', hasChildren: false },
				{ kind: 'child', id: 'child-2', mode: 'one-shot', label: '一次性', activity: 'inactive', hasChildren: false },
				{ kind: 'diagnostic', id: 'child-3', reason: 'unavailable' },
			]
		},
		async startActivation(spec) {
			calls.spawn.push(spec)
			return { name: spec.name ?? 'agent-1', messageId: 'm-1' }
		},
		async resolveName(caller, name, signal) {
			calls.send.push({ kind: 'resolve', caller, name, signal })
			return 'child-1'
		},
		async sendMessage(sender, targetId, content, options) {
			calls.send.push({ kind: 'send', sender, targetId, content, options })
			return 'msg-1'
		},
		interrupt(targetId, authority) {
			calls.interrupt.push({ targetId, authority })
		},
	}
	return { subagents, agents: { get: (id) => (id === 'child-1' ? { id, status: 'running' } : undefined) }, calls }
}

test('选择器：旧接口在就选 agent-team；否则选 subagent', () => {
	const oldCtx = { get: (name) => (name === 'agentTeams' ? { listMembers: () => [], spawnTeammate: async () => ({}) } : undefined) }
	assert.equal(memberBackendOf(oldCtx).id, 'agent-team')
	const { subagents, agents } = subagentHost()
	const newCtx = { get: (name) => (name === 'agentTeams' ? { createTask() {}, listTasks() {} } : name === 'subagents' ? subagents : name === 'agents' ? agents : undefined) }
	assert.equal(memberBackendOf(newCtx).id, 'subagent')
	assert.equal(memberBackendOf({ get: () => undefined }), null)
})

test('subagent.list：根 + 可续聊后代；一次性跳过、诊断进告警', async () => {
	const { subagents, agents, calls } = subagentHost()
	const backend = memberBackendOf({ get: (name) => (name === 'subagents' ? subagents : name === 'agents' ? agents : undefined) })
	const signal = new AbortController().signal
	const listed = await backend.list(lead, { signal })
	assert.equal(listed.ok, true)
	assert.deepEqual(calls.list[0], { rootId: 'root-1', signal })
	assert.deepEqual(listed.rows.map((row) => [row.name, row.role, row.status]), [
		['lead', 'lead', 'inactive'],
		['reviewer-1', 'teammate', 'running'],
	])
	assert.equal(listed.rows[1].description, '独立复核交付物')
	assert.ok(listed.warnings.some((line) => line.includes('unavailable')), '诊断行要进告警：' + JSON.stringify(listed.warnings))
})

test('subagent.spawn：startActivation 收 provider/label/name/块数组/parent/signal/delivery', async () => {
	const { subagents, agents, calls } = subagentHost()
	const backend = memberBackendOf({ get: (name) => (name === 'subagents' ? subagents : name === 'agents' ? agents : undefined) })
	const signal = new AbortController().signal
	const made = await backend.spawn(lead, { name: 'reviewer-1', label: '独立复核交付物', prompt: '首活', context: 'fresh', provider: 'spawn' }, signal)
	assert.equal(made.ok, true)
	assert.equal(made.name, 'reviewer-1')
	const spec = calls.spawn[0]
	assert.equal(spec.provider, 'spawn')
	assert.equal(spec.label, '独立复核交付物')
	assert.equal(spec.name, 'reviewer-1')
	assert.equal(spec.parent, lead)
	assert.equal(spec.signal, signal)
	assert.equal(spec.delivery, 'parent')
	assert.deepEqual(spec.prompt, [{ type: 'text', text: '首活' }], '提示词必须是块数组')
})

test('subagent.send：先 resolveName 再 sendMessage（块数组）', async () => {
	const { subagents, agents, calls } = subagentHost()
	const backend = memberBackendOf({ get: (name) => (name === 'subagents' ? subagents : name === 'agents' ? agents : undefined) })
	const signal = new AbortController().signal
	const sent = await backend.send(lead, { target: 'reviewer-1', content: '接着干' }, signal)
	assert.equal(sent.ok, true)
	assert.equal(calls.send[0].kind, 'resolve')
	assert.equal(calls.send[0].name, 'reviewer-1')
	assert.equal(calls.send[1].kind, 'send')
	assert.equal(calls.send[1].targetId, 'child-1')
	assert.deepEqual(calls.send[1].content, [{ type: 'text', text: '接着干' }])
})

test('subagent.interrupt：resolveName 后按 ancestor 权威打断', async () => {
	const { subagents, agents, calls } = subagentHost()
	const backend = memberBackendOf({ get: (name) => (name === 'subagents' ? subagents : name === 'agents' ? agents : undefined) })
	const done = await backend.interrupt(lead, 'reviewer-1', new AbortController().signal)
	assert.equal(done.ok, true)
	assert.deepEqual(calls.interrupt[0], { targetId: 'child-1', authority: { kind: 'ancestor', agent: lead } })
})

test('subagent 缺能力：如实说缺什么，不假装可用', async () => {
	const backend = memberBackendOf({ get: (name) => (name === 'subagents' ? { rootOf: () => lead } : undefined) })
	assert.equal(backend.capabilities.list, false)
	const listed = await backend.list(lead, {})
	assert.equal(listed.ok, false)
	assert.match(listed.reason, /listDescendants|agents\.get/)
})
