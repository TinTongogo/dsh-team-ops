/**
 * 任务派发的**分配校验与冲突检测**（纯函数，不碰 ctx / 账本）。
 *
 * 真相源是原生 Agent Teams 任务板；这里只根据"改归属前读到的那一条"、全部任务与在场成员做判断。
 * 阻断项返回 `conflict`，可继续但要注意的返回 `risks` —— 两者都进 `board_task` 回执。
 */

/** 写盘面是否重叠（前缀互相包含即算，与原生 `writeScopes` 的口径一致）。 */
function scopesOverlap(left, right) {
	const a = Array.isArray(left) ? left.filter((x) => typeof x === 'string' && x !== '') : []
	const b = Array.isArray(right) ? right.filter((x) => typeof x === 'string' && x !== '') : []
	return a.some((x) => b.some((y) => x.startsWith(y) || y.startsWith(x)))
}

/**
 * @param object - `{ task, targetOwner, expectedRevision, handover, allTasks, members, id }`
 *   task = 改归属前 `get` 到的那一条；allTasks = `list` 的全部任务；members = 在场成员名数组（读不到传 null）。
 * @returns `{ ok, assignment?, conflict?, risks }`。
 */
export function assignmentGuardOf({ task, targetOwner, expectedRevision, handover = false, allTasks = [], members = null, id = '' }) {
	const risks = []
	const blocked = (code, message) => ({ ok: false, conflict: { code, message }, risks })
	const target = typeof targetOwner === 'string' ? targetOwner.trim() : ''
	if (target === '') return blocked('missing_owner', '派活必须写明执行人（`assignee` / `owner`）—— 没有负责人的任务不许推进')
	if (expectedRevision === undefined || expectedRevision === null) {
		return blocked('missing_revision', '派活前先 `get` / `query` 读一次并带 `expected_revision`：版本对不上说明有人先改过，重读再派')
	}
	if (task === null || typeof task !== 'object') return blocked('task_unreadable', '读不到任务本体，不能确认当前归属 —— 不盲改')
	if (String(task.status ?? '') === 'completed') return blocked('completed_task', '任务已完成，不能再派；要返工开一条新任务并关联原任务号')

	const previousOwner = typeof task.ownerName === 'string' ? task.ownerName.trim() : ''
	if (previousOwner !== '') {
		if (previousOwner === target) {
			return blocked('duplicate_assignment', `任务已分配给 ${target}，重复分配被阻止（不会重复通知、不会重复推进状态）`)
		}
		if (handover !== true) {
			return blocked('locked_by_other', `任务已由 ${previousOwner} 锁定，他人不得再派；确需转派请带 \`handover: true\`，并确认原负责人手上的进度已落盘`)
		}
		risks.push({ code: 'handover_risk', message: `从 ${previousOwner} 转派给 ${target}：确认原负责人已停手并落盘，避免两人同时改同一批文件` })
	}

	const tasks = Array.isArray(allTasks) ? allTasks : []
	const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : []
	if (blockedBy.length > 0) risks.push({ code: 'blocked_dependency', message: `依赖未解除：${blockedBy.join('、')}` })

	const overlapping = tasks
		.filter((other) => other !== null && typeof other === 'object' && String(other.id ?? '') !== String(id))
		.filter((other) => String(other.status ?? '') !== 'completed')
		.filter((other) => scopesOverlap(task.writeScopes, other.writeScopes))
		.map((other) => String(other.id ?? ''))
	if (overlapping.length > 0) {
		risks.push({ code: 'write_scope_overlap', message: `写盘面与进行中任务重叠：${overlapping.join('、')} —— 并行改同一文件有冲突风险` })
	}

	if (Array.isArray(members) && members.length > 0 && !members.includes(target)) {
		risks.push({ code: 'assignee_absent', message: `${target} 不在当前在场成员里：先 \`member_spawn\`，或确认名字写对` })
	}
	const owned = tasks.filter((other) => other !== null && typeof other === 'object'
		&& String(other.ownerName ?? '').trim() === target && String(other.status ?? '') === 'in_progress').length
	if (owned >= 3) risks.push({ code: 'owner_overload', message: `${target} 已有 ${owned} 条进行中任务，并行过多会拖慢收口` })

	return {
		ok: true,
		assignment: { owner: target, locked: true, previousOwner, handover: handover === true },
		risks,
	}
}
