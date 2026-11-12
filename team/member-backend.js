/**
 * **成员后端的选择器**：按宿主能力挑一套实现，制度层只认这一个入口。
 *
 * 两套实现：
 *   · `agent-team` —— 旧宿主（`agentTeams.spawnTeammate` / `listMembers` / `sendMessage` / `interrupt`）；
 *   · `subagent`   —— 新宿主（`subagents.startActivation` / `listDescendants` / `sendMessage` / `interrupt`）。
 *
 * 选择顺序：**旧接口在就优先旧接口**（它是宿主的真源，能写 `team/member` 事件）；否则用新接口。
 * 两套都没有 = `null`（调用方要如实说「这个部署没有成员后端」，不要冒充成「没有服务」）。
 */

import { MEMBER_BACKEND_MISSING } from './member-shape.js'
import { createAgentTeamBackend } from './agent-team-backend.js'
import { createSubagentBackend } from './subagent-backend.js'

/**
 * 取本进程的成员后端。
 * @param ctx - 宿主 ctx（`agentTeams` / `subagents` / `agents` 都是可选服务）。
 * @returns 后端对象或 `null`。
 */
export function memberBackendOf(ctx) {
	const get = (name) => (typeof ctx?.get === 'function' ? ctx.get(name) : undefined)
	const teams = get('agentTeams')
	const subagents = get('subagents')
	if (teams !== null && teams !== undefined && (typeof teams.spawnTeammate === 'function' || typeof teams.listMembers === 'function')) {
		return createAgentTeamBackend({ teams })
	}
	if (subagents !== null && subagents !== undefined) {
		return createSubagentBackend({ subagents, agents: get('agents') })
	}
	return null
}

export { MEMBER_BACKEND_MISSING }
