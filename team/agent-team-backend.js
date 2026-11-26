/**
 * **旧宿主（`agentTeams.spawnTeammate` 那一套）的成员后端** —— 只做最小实现，供还在旧宿主上的
 * profile 继续跑；新宿主走 `team/subagent-backend.js`。
 *
 * 旧接口（读自宿主实现）：`spawnTeammate(caller, { name, description, prompt, context, provider, signal })`、
 * `sendMessage(caller, { target, content, signal })`、`listMembers(caller)`、`interrupt(caller, name)`。
 */

import { capabilityMissingOf, textBlocks } from './member-shape.js'

function reasonOf(error) {
	return error !== null && error !== undefined && typeof error.message === 'string' ? error.message : String(error)
}

/**
 * 建一个旧宿主的成员后端。
 * @param deps - `{ teams }`（`agentTeams` 服务）。
 */
export function createAgentTeamBackend({ teams }) {
	const has = (name) => teams !== null && teams !== undefined && typeof teams[name] === 'function'
	const capabilities = {
		list: has('listMembers'),
		spawn: has('spawnTeammate'),
		send: has('sendMessage'),
		interrupt: has('interrupt'),
	}
	return {
		id: 'agent-team',
		capabilities,
		async list(caller) {
			if (!capabilities.list) return { ok: false, reason: capabilityMissingOf('`agentTeams.listMembers`') }
			try {
				const rows = teams.listMembers(caller)
				// **原样返回**：面板还要读 `model` / `provider` / `context` / `diagnostics`，
				// 工具面那边再按 `shapeMemberRows` 收敛，两处不互相削。
				return { ok: true, rows: Array.isArray(rows) ? rows : Array.isArray(rows?.value) ? rows.value : [] }
			} catch (error) {
				return { ok: false, reason: reasonOf(error) }
			}
		},
		async spawn(caller, request, signal) {
			if (!capabilities.spawn) return { ok: false, reason: capabilityMissingOf('`agentTeams.spawnTeammate`') }
			try {
				const row = await teams.spawnTeammate(caller, {
					name: String(request.name ?? ''),
					description: String(request.label ?? ''),
					prompt: textBlocks(request.prompt),
					context: request.context === 'fork' ? 'fork' : 'fresh',
					provider: String(request.provider ?? ''),
					...(signal === undefined || signal === null ? {} : { signal }),
				})
				return { ok: true, name: String(request.name ?? ''), row }
			} catch (error) {
				return { ok: false, reason: reasonOf(error) }
			}
		},
		async send(caller, request, signal) {
			if (!capabilities.send) return { ok: false, reason: capabilityMissingOf('`agentTeams.sendMessage`') }
			try {
				const outcome = await teams.sendMessage(caller, {
					target: String(request.target ?? ''),
					content: textBlocks(request.content),
					...(signal === undefined || signal === null ? {} : { signal }),
				})
				return { ok: true, outcome }
			} catch (error) {
				return { ok: false, reason: reasonOf(error) }
			}
		},
		async interrupt(caller, name) {
			if (!capabilities.interrupt) return { ok: false, reason: capabilityMissingOf('`agentTeams.interrupt`') }
			try {
				const done = teams.interrupt(caller, String(name ?? ''))
				return { ok: true, accepted: true, ...(done !== null && done !== undefined && typeof done === 'object' ? { previousStatus: done.previousStatus } : {}) }
			} catch (error) {
				return { ok: false, reason: reasonOf(error) }
			}
		},
	}
}
