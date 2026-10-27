/**
 * **成员的停用名单**（本插件这一层的视图状态，不是原生名册的一部分）。
 *
 * 为什么要有它：原生名册**只有**"成员在不在"与 `failed` 两种事实（`TeamService` 没有移除 / 停用的接口），
 * 而 HD-006 要的是"停用旧的、建新的换一个干净上下文"这条路。所以我们**自己**在工作区里记一份
 * "名单个成员算停用"，语义全在本文件与 `team/native-layer.js`：
 *   · 停用者**不占**同角色 ≤3 的**角色槽位**（于是"停一档里的一位 + 再建一位"能走通）；
 *   · 停用后**同角色至少留 1 位**未停用（把一档全停 ⇒ 拒）—— 判据 `disableFindings` 在下面；
 *   · **自动复用跳过**停用者、**`member_send` 给停用者拒绝**、**可恢复**（恢复不设任何上限）。
 *
 * **两件事要如实说**（面板与工具回执都不许含糊）：① 停用的成员**在原生名册里仍然在**（宿主没有移除接口）；
 * ② 这份文件是**本插件的视图状态**，不是原生名册的副本 —— 所以文件里自带 `note` 那句话。
 *
 * 读法：`readDisabledNames(workspace)` 走 Node 文件系统（与 `lib/roster.js` 读角色定义同一条路：
 * 文件是事实，读不到就是读不到，不编）。**写**不走这里 —— 写要过引擎那条账本管道（`transact` /
 * `commitLedger`），入口是 `team/team-runtime.js` 的 `setMemberDisabled`。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 账名（引擎的 `LEDGER_FILE.memberFlags` 与这里是同一个字符串；两处都写死是为了不互相 import）。 */
export const MEMBER_FLAGS_FILE = '.company-gate.member-flags.json'

/** 文件里自带的那句如实标注（人直接打开也读得懂）。 */
export const MEMBER_FLAGS_NOTE =
	'这是**本插件的视图状态**（哪些成员被停用），**不是** DSH 原生名册的一部分：原生名册只有"成员在不在"与 `failed`，' +
	'没有停用/移除接口 —— 所以被停用的人在**原生名册里仍然在**，只是本插件不再自动复用、不再给它派活，也不让它占同角色的**角色槽位**。'

/** 空名单。只在本文件确实不在时使用。 */
export function emptyMemberFlags() {
	return { version: 1, seq: 0, note: MEMBER_FLAGS_NOTE, disabled: [], updated_at: '' }
}

/** 归一化名单：只留非空字符串，去重（回执与判定都用同一形状）。 */
export function disabledNamesOf(value) {
	const raw = Array.isArray(value?.disabled) ? value.disabled : []
	const out = []
	for (const name of raw) {
		if (typeof name === 'string' && name !== '' && !out.includes(name)) out.push(name)
	}
	return out
}

/**
 * 读一份停用名单。
 * @param workspace - 工作区根。
 * @returns `string[]`；文件不在 / 读不成 / JSON 坏 ⇒ **空数组**（"读不到"在这里等于"一个都没停用"，
 *   因为这份名单是**降级安全**的：漏读最坏的结果是"多算一个角色槽位"，不会放行任何越界动作）。
 */
export function readDisabledNames(workspace) {
	if (typeof workspace !== 'string' || workspace === '') return []
	try {
		const text = readFileSync(join(workspace, MEMBER_FLAGS_FILE), 'utf8')
		return disabledNamesOf(JSON.parse(text))
	} catch {
		return []
	}
}

/** 名字 → 这一档（读不出角色时按名字各自算一档，与编制判定同一口径）。 */
function kindOf(name, roleOfName) {
	const role = roleOfName(name)
	return role !== '' ? role : `(名字读不出角色) ${name}`
}

/**
 * 停用一位成员前的判定（**一条**）：停用之后，同一档必须**至少还剩 1 位**未停用。
 *
 * 为什么是硬拒：把一档全停掉之后，那一档的活就没人接了 —— 而"停用"看起来像无害的开关，
 * 不拦的话人会在同一档里连点两次，然后困惑"为什么它不干活了"。
 * @param args - `{ name, members, disabledNames, roleOfName }`。
 * @returns `null` 放行；否则一句可读的拒绝理由。
 */
export function disableFindings({ name, members, disabledNames, roleOfName }) {
	const disabled = Array.isArray(disabledNames) ? disabledNames : []
	const live = (Array.isArray(members) ? members : []).filter((row) => row?.role === 'teammate' && row?.status !== 'failed' && !disabled.includes(row?.name))
	const mine = kindOf(name, roleOfName)
	const sameKind = live.filter((row) => kindOf(row?.name, roleOfName) === mine)
	if (sameKind.length <= 1) {
		const others = live.filter((row) => row?.name !== name).map((row) => row.name)
		return (
			`停用「${name}」之后，「${mine}」这一档就没有能干活的人了（**同角色至少留 1 位未停用**）。\n` +
			`要腾角色槽位就先给这一档**再建一位**（\`member_spawn role=…\` 或面板上的「新建」），或者停用别的角色的人。` +
			(others.length === 0 ? '' : `\n（现在还能干活的：${others.join('、')}）`)
		)
	}
	return null
}
