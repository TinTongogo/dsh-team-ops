/**
 * 角色契约：从 `ROLE.md` 的「落点（产出与落盘）」段解析出**路径归属**，并检测跨角色冲突。
 *
 * 规则只在契约层（BASELINE《落盘与移交》第 6 条）：一个产物路径只许一个角色 owns。
 * 这里只负责把规则变成可查数据；不写文件、不改角色，冲突只报不修。
 */
import { roleDefinitionOf } from './role-persona.js'
import { roleRecords } from './role-store.js'

/** 落点段的路径条目：`- \`docs/ai/\` —— 说明`（破折号前后可有空格）。 */
const PATH_LINE = /^\s*-\s+`([^`]+)`\s*(?:——|—|--)?\s*(.*)$/

/** 排除 / 交接提示：不负责、不在别处再写、交给谁。 */
const EXCLUDE_HINT = /不在[^\n]*再写|不负责|不归本角色|不是交付物/

/**
 * 从角色正文里取「落点」段。
 * @param body - 去掉 front-matter 的正文。
 * @returns 段落文本；没有该段时为空串。
 */
export function placementSectionOf(body) {
	const text = typeof body === 'string' ? body : ''
	const matched = /^##\s*落点[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(text)
	return matched === null ? '' : matched[1]
}

/**
 * 「落点」段 → 路径归属 + 明确不碰的条目 + 说明行。**解析只有这一份实现**：
 * `roleContractOf`（单个角色，带 notes）与 `allRoleContracts`（全量）都走它 ——
 * 从前那两份各写一遍，改一处漏一处（判据就成了两个数）。
 * @param body - 去掉 front-matter 的正文。
 * @returns `{ owns, excludes, notes }`。
 */
export function contractEntriesOf(body) {
	const section = placementSectionOf(body)
	const owns = []
	const excludes = []
	const notes = []
	for (const raw of section.split('\n')) {
		const line = raw.trim()
		if (line === '') continue
		if (!line.startsWith('-')) {
			notes.push(line)
			continue
		}
		const matched = PATH_LINE.exec(line)
		if (matched === null) {
			if (EXCLUDE_HINT.test(line)) excludes.push(line.replace(/^-\s*/, ''))
			else notes.push(line.replace(/^-\s*/, ''))
			continue
		}
		const path = normalizePath(matched[1])
		// `docs/team/tasks/` 是记账，不是交付物（ROLE.md 自己写明）⇒ 不计入 owns。
		if (path.startsWith('docs/team/tasks/')) {
			notes.push(`${path}（记账，不是交付物）`)
			continue
		}
		owns.push({ path, note: matched[2].trim() })
	}
	return { owns, excludes, notes }
}

/**
 * 解析一个角色的契约。
 * @param role - 角色 id。
 * @returns `{ role, owns, excludes, notes }`；角色不在名册时抛错（沿用 roleDefinitionOf 的行为）。
 */
export function roleContractOf(role) {
	const record = roleDefinitionOf(role)
	const entries = contractEntriesOf(record.body)
	return { role: record.id, ...entries }
}

/** 全量契约（现场枚举的每一个角色）。 */
export function allRoleContracts() {
	return roleRecords()
		.filter((record) => record.kind === 'role')
		.map((record) => {
			const { owns, excludes } = contractEntriesOf(record.body)
			return { role: record.id, owns, excludes }
		})
}

/** 路径归一：去尾斜杠、去空白；保证 `docs/ai` 与 `docs/ai/` 算同一条。 */
export function normalizePath(path) {
	return String(path ?? '').trim().replace(/\/+$/, '')
}

/**
 * 路径归属冲突：同一路径出现在两个及以上角色的 owns 里。
 * @param contracts - `allRoleContracts()` 的结果。
 * @returns `[{ path, roles }]`（按路径排序）。
 */
export function contractConflicts(contracts) {
	const byPath = new Map()
	for (const contract of contracts) {
		for (const entry of contract.owns) {
			const path = normalizePath(entry.path)
			if (path === '') continue
			const list = byPath.get(path) ?? []
			if (!list.includes(contract.role)) list.push(contract.role)
			byPath.set(path, list)
		}
	}
	return [...byPath.entries()]
		.filter(([, roles]) => roles.length > 1)
		.map(([path, roles]) => ({ path, roles: roles.sort() }))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
