/**
 * 成员后端的**共用形状与措辞** —— 两个实现（subagent / agent-team）都从这里取，
 * 于是「正文怎么包块」「行怎么收敛」「缺能力怎么说」永远只有一处正文。
 */

/**
 * 正文 → 宿主 schema 要的**内容块数组**。
 *
 * 两条路都吃块数组，但形状不对的报错方式不同：消息路**立刻抛**（旧宿主队伍日志有 schema，
 * 坏事件一落库投影即 failure，之后每次 journal 读都抛 `persisted Agent Teams … payload is invalid`）；
 * 提示词路则把字符串按**字符**摊开、**静默变味**。所以两套后端一律包块，只换外壳、不动正文。
 */
export function textBlocks(text) {
	return [{ type: 'text', text: String(text ?? '') }]
}

/** 名册行的形状收敛：只留标量叶子（读不到就是读不到，不补行、不排序）。 */
export function shapeMemberRows(raw) {
	const out = []
	for (const row of Array.isArray(raw) ? raw : []) {
		if (row === null || typeof row !== 'object') continue
		out.push({
			id: typeof row.id === 'string' ? row.id : '',
			name: typeof row.name === 'string' ? row.name : '',
			role: typeof row.role === 'string' ? row.role : '',
			status: typeof row.status === 'string' ? row.status : '',
			...(typeof row.description === 'string' && row.description !== '' ? { description: row.description } : {}),
		})
	}
	return out
}

/** 两套成员能力都不在（不是「没有 Agent Teams 服务」，是整个成员 API 都不在）。 */
export const MEMBER_BACKEND_MISSING =
	'这个部署没有可用的成员后端：旧版的 `agentTeams.spawnTeammate` 与新版的 `subagents.startActivation` 都取不到。'

/** 服务在、但这一版宿主缺某一项成员能力（分档，不再冒充「没有服务」）。 */
export function capabilityMissingOf(what) {
	return `这个宿主版本的成员能力不完整（缺 ${what}）：面板与工具读不到对应的那一档。`
}
