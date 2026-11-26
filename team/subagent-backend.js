/**
 * **新宿主（0.2.2+）的成员后端**：成员是 subagent，任务仍在 `agentTeams`。
 *
 * 出处（读自宿主源码）：
 *   · `@deepseek-ai/dsh-subagent` 的 `SubagentService`：`rootOf` / `listDescendants` /
 *     `resolveName` / `sendMessage` / `interrupt` / `startActivation` / `namesOf`；
 *   · `@deepseek-ai/dsh-tool-subagent-control` 的 `list_agents` / `send_message` /
 *     `interrupt_agent` 就是这么调的（本文件照同一条调用面）。
 *
 * 命名规则（`dsh-subagent/src/names.ts`）：每个孩子的名字在**创建者自己的孩子**里唯一，
 * 1–32 位小写字母/数字/连字符、以字母开头、不能叫 `lead`；成员全名是从根起用 `/` 连起来的路径。
 * 本插件的 `<角色>-<序号>` 天然满足。
 */

import { capabilityMissingOf, shapeMemberRows, textBlocks } from './member-shape.js'

/** 根成员名（宿主的 `ROOT_AGENT_NAME`）。 */
const ROOT_AGENT_NAME = 'lead'

/** 取消信号缺省：宿主 `startActivation` / `resolveName` / `sendMessage` 都要求一个真 signal。 */
function signalOf(signal) {
	return signal !== undefined && signal !== null ? signal : new AbortController().signal
}

function reasonOf(error) {
	return error !== null && error !== undefined && typeof error.message === 'string' ? error.message : String(error)
}

/**
 * 建一个 subagent 成员后端。
 * @param deps - `{ subagents, agents }`（都是可选服务；缺哪个就少哪一档能力）。
 */
export function createSubagentBackend({ subagents, agents }) {
	const has = (name) => subagents !== null && subagents !== undefined && typeof subagents[name] === 'function'
	const capabilities = {
		list: has('listDescendants') && has('rootOf') && typeof agents?.get === 'function',
		spawn: has('startActivation'),
		send: has('sendMessage') && has('resolveName'),
		interrupt: has('interrupt') && has('resolveName'),
	}
	const statusOf = (id) => {
		try {
			return agents?.get?.(id)?.status === 'running' ? 'running' : 'inactive'
		} catch {
			return 'inactive'
		}
	}

	return {
		id: 'subagent',
		capabilities,
		/** 读名册：根一行 + 可续聊的后代（与宿主 `list_agents` 同一条投影规则）。 */
		async list(caller, options = {}) {
			if (!capabilities.list) return { ok: false, reason: capabilityMissingOf('`subagents.listDescendants` / `agents.get`') }
			try {
				const root = subagents.rootOf(caller)
				const entries = await subagents.listDescendants(root.id, options.signal)
				const warnings = []
				const rows = [{ id: String(root.id ?? ''), name: ROOT_AGENT_NAME, role: 'lead', status: statusOf(root.id) }]
				for (const entry of Array.isArray(entries) ? entries : []) {
					if (entry === null || typeof entry !== 'object') continue
					if (entry.kind === 'diagnostic') {
						warnings.push(`名册里有一个分支读不到（${String(entry.reason ?? '未知')}）：${String(entry.id ?? '')}`)
						continue
					}
					// 一次性子代理不能续聊，模型侧也不列它们（同宿主 `list_agents` 的过滤）。
					if (entry.mode !== 'continuable') continue
					const name = typeof entry.path === 'string' && entry.path !== '' ? entry.path : String(entry.id ?? '')
					rows.push({
						id: String(entry.id ?? ''),
						name,
						role: 'teammate',
						status: statusOf(entry.id),
						...(typeof entry.label === 'string' && entry.label !== '' ? { description: entry.label } : {}),
					})
				}
				return { ok: true, rows: shapeMemberRows(rows), warnings }
			} catch (error) {
				return { ok: false, reason: reasonOf(error) }
			}
		},
		/** 建人：`startActivation` 一次起一个可续聊的子代理，名字就是成员名。 */
		async spawn(caller, request, signal) {
			if (!capabilities.spawn) return { ok: false, reason: capabilityMissingOf('`subagents.startActivation`') }
			try {
				const started = await subagents.startActivation({
					provider: String(request.provider ?? ''),
					label: String(request.label ?? ''),
					...(typeof request.name === 'string' && request.name !== '' ? { name: request.name } : {}),
					prompt: textBlocks(request.prompt),
					parent: caller,
					signal: signalOf(signal),
					delivery: 'parent',
				})
				return { ok: true, name: typeof started?.name === 'string' && started.name !== '' ? started.name : String(request.name ?? ''), row: started }
			} catch (error) {
				return { ok: false, reason: reasonOf(error) }
			}
		},
		/** 投递：名字先解析成会话 id，再发消息（与宿主 `send_message` 同一条路）。 */
		async send(caller, request, signal) {
			if (!capabilities.send) return { ok: false, reason: capabilityMissingOf('`subagents.sendMessage` / `resolveName`') }
			try {
				const targetId = await subagents.resolveName(caller, String(request.target ?? ''), signalOf(signal))
				const messageId = await subagents.sendMessage(caller, targetId, textBlocks(request.content), { signal: signalOf(signal) })
				return { ok: true, messageId }
			} catch (error) {
				return { ok: false, reason: reasonOf(error) }
			}
		},
		/** 打断：权威由宿主校验（只允许祖先打断后代）。 */
		async interrupt(caller, name, signal) {
			if (!capabilities.interrupt) return { ok: false, reason: capabilityMissingOf('`subagents.interrupt` / `resolveName`') }
			try {
				const targetId = await subagents.resolveName(caller, String(name ?? ''), signalOf(signal))
				subagents.interrupt(targetId, { kind: 'ancestor', agent: caller })
				return { ok: true, accepted: true }
			} catch (error) {
				return { ok: false, reason: reasonOf(error) }
			}
		},
	}
}
