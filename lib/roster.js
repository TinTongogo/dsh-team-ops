/**
 * **角色的唯一真相源**：现场枚举 `roles/`，一个含 `ROLE.md` 的目录就是一个角色。
 *
 *   `roles/<id>/ROLE.md` —— **角色定义**（agent definition）：身份、职责边界、检查表、落点、专属技能。
 *
 * 团队规则不在这里：它是包内那一份 `team/BASELINE.md`（一份文件，按路径读，不在名册里）。
 * 本文件与运行时那半边的 `roleCatalog()`（`team/team-runtime.js`）是**同一判定的两份实现**：
 * 运行时按引擎自身位置枚举，文档侧按包根枚举 —— 两侧必须同结论，自检逐条比。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** 包内**角色根**（本文件在 `lib/` 下）。 */
export const PACKAGED_ROLES_ROOT = resolve(here, '..', 'team', 'roles')
/**
 * 名册只有**角色**一类 —— `roles/<id>/ROLE.md`。团队规则是包内 `team/BASELINE.md` 那一份文件，
 * 它**不在名册里**（不派活、不计入编制，也不写角色名单）。
 */
/** 角色定义的文件名：`roles/<id>/ROLE.md`（一个目录一个角色，没有第二种形态）。 */
const ROLE_FILE = 'ROLE.md'

/**
 * 用户级角色根：`$DSH_TEAM_OPS_ROLES` 优先，其次 `$DSH_HOME/team-ops/roles`，再其次 `~/.dsh/team-ops/roles`。
 * @returns 绝对路径（**不保证存在** —— 调用方按存在与否决定用不用）。
 */
export function userRolesRoot() {
	const explicit = process.env.DSH_TEAM_OPS_ROLES
	if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit.trim())
	const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
	return join(home, 'team-ops', 'roles')
}

/**
 * **工作区级角色根**：`<工作区>/.dsh/team-ops/roles`（照宿主 `.dsh/` 约定，与用户根同构）。
 *
 * 为什么要它：角色是**本插件的概念**（宿主不认识），所以"项目作用域"要我们自己定义 —— 人给的判据是
 * "项目内的东西只算工作区内的"（HD-008）。同名时**工作区那份赢**（与宿主技能根的 rank 方向一致：项目优先）。
 * @param workspace - 工作区绝对路径。
 * @returns 绝对路径；工作区不是字符串时返回 `null`（**不保证存在** —— 调用方按存在与否决定用不用）。
 */
export function workspaceRolesRoot(workspace) {
	if (typeof workspace !== 'string' || workspace.trim() === '') return null
	return join(resolve(workspace.trim()), '.dsh', 'team-ops', 'roles')
}

/** 角色的两个作用域（**唯一取值表**）：工作区（缺省）/ 用户（全局）。 */
export const ROLE_SCOPES = ['workspace', 'user']

/**
 * 作用域 → 角色根（**唯一映射**）。
 * @returns `{ root, scope }`；作用域不认 / 工作区作用域但没给工作区 ⇒ `null`。
 */
export function roleRootOf(scope, workspace) {
	if (scope === 'workspace') {
		const root = workspaceRolesRoot(workspace)
		return root === null ? null : { root, scope: 'workspace' }
	}
	if (scope === 'user') return { root: userRolesRoot(), scope: 'user' }
	return null
}

/** 作用域那句给人看的说明（回执与面板都用它，一处正文）。 */
export function roleScopeLine(scope) {
	return scope === 'user'
		? '作用域：**user（全局）** —— 写的是用户角色根（`~/.dsh/team-ops/roles/`）：**所有工作区都看得见**（跨项目复用才该选它）。'
		: '作用域：**workspace（本工作区，缺省）** —— 写的是本工作区的角色根（`<工作区>/.dsh/team-ops/roles/`）：**只有这个工作区看得见**（别的项目不受影响）。'
}

/**
 * 名册要看的根目录，**按优先级排列（后面的被前面的遮蔽）**：显式根 → **工作区根** → 用户根 → 包内根。
 *
 * **这一处是枚举顺序的唯一正文**（HD-008 / task-34 的口径）：同名时**高处赢** —— 与宿主技能根的
 * rank 方向一致（项目优先）。别在别处再写一份顺序（两份顺序迟早各漂一个样）。
 * 不存在的根**不列**（少一次无用枚举，也让"来源"只有真实存在的那些）。
 * @param extra - 额外根（CLI / 测试用）。
 * @param options - `includeUser`（默认 true）、`workspace`（给了就带上工作区根）。
 * @returns `[{ root, source }]`，`source ∈ extra / workspace / user / package`。
 */
export function rosterRoots(extra = [], { includeUser = true, workspace } = {}) {
	const roots = []
	// 显式给的根**排在最前**（调用方点名要看的那些，按角色层看待）；然后工作区 → 用户 → 包内。
	for (const dir of extra) if (typeof dir === 'string' && dir !== '') roots.push({ root: resolve(dir), source: 'extra', layer: 'roles' })
	const workspaceRoot = workspaceRolesRoot(workspace)
	if (workspaceRoot !== null && existsSync(workspaceRoot)) roots.push({ root: workspaceRoot, source: 'workspace', layer: 'roles' })
	if (includeUser) {
		const userRoles = userRolesRoot()
		if (existsSync(userRoles)) roots.push({ root: userRoles, source: 'user', layer: 'roles' })
	}
	roots.push({ root: PACKAGED_ROLES_ROOT, source: 'package', layer: 'roles' })
	return roots
}

/**
 * 只解析我们认识的那几个键（`name` / `version` / `description` / `category`），
 * 单行 `key: value`，不引第三方 YAML —— 这些文件由本包自己写，形状是固定的。
 * 遇到多行值（`|` / `>-`）就退回空串：不猜、不把散文当成键值。
 * @param text - `ROLE.md` 全文。
 * @returns 键值对象（缺键为 undefined）。
 */
export function parseFrontMatter(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
	if (match === null) return {}
	const out = {}
	for (const line of match[1].split(/\r?\n/)) {
		const pair = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
		if (pair === null) continue
		const value = pair[2].trim()
		if (value === '' || value === '|' || value === '>-' || value === '>') continue
		out[pair[1]] = value.replace(/^["']|["']$/g, '')
	}
	return out
}

/** `# 评审员（reviewer）` → `评审员`；没有括号就整行当标题；找不到标题返回空串。 */
export function titleOf(text) {
	const line = /\r?\n#\s+(.+)/.exec(text)
	if (line === null) return ''
	return line[1].replace(/[（(][^）)]*[）)]\s*$/, '').trim()
}

/** 标题之后的**第一段正文**当"一句话职责"（空行分隔；压成一行、截到 120 字）。 */
export function dutyOf(text) {
	const after = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
	const body = after.replace(/^[\s\S]*?\r?\n#\s+.+\r?\n/, '')
	for (const block of body.split(/\r?\n\s*\r?\n/)) {
		const line = block.replace(/\s+/g, ' ').trim()
		if (line === '' || line.startsWith('#') || line.startsWith('---')) continue
		return line.length > 120 ? `${line.slice(0, 120)}…` : line
	}
	return ''
}

/** front-matter 的 `description` 去掉 `Use when ` 前缀，当"什么时候派它"。 */
export function whenOf(description) {
	if (typeof description !== 'string' || description === '') return ''
	return description.replace(/^Use when\s*/i, '').trim()
}

/**
 * 读**一个角色目录**。
 * @param root - 角色根。
 * @param id - 目录名（= 角色 id）。
 * @param source - 这个目录的来路（`package` / `user` / `extra`）。
 * @returns 记录，或 null（没有 `ROLE.md` / 读不了 —— 那就不是角色目录，不猜）。
 */
export function readSkillDir(root, id, source, layer = 'skills') {
	const dir = join(root, id)
	const candidates = [ROLE_FILE]
	let file = null
	let text = ''
	for (const name of candidates) {
		const candidate = join(dir, name)
		try {
			if (!statSync(candidate).isFile()) continue
			text = readFileSync(candidate, 'utf8')
			file = candidate
			break
		} catch {
			continue
		}
	}
	if (file === null) return null
	const meta = parseFrontMatter(text)
	// **名册里只有一类：角色**（front-matter 里的 `kind` 不参与分类）。
	const kind = 'role'
	return {
		id,
		kind,
		layer,
		source,
		root,
		file,
		title: titleOf(text) || id,
		duty: dutyOf(text),
		when: whenOf(meta.description),
		version: typeof meta.version === 'string' ? meta.version : '',
		// 分类与**装备**（装备只有 `skills` 一格：工具面与模型由原生队伍那条路定，角色定义里不声明）：
		category: typeof meta.category === 'string' && meta.category !== '' ? meta.category : '',
		skills: (typeof meta.skills === 'string' ? meta.skills : '').split(',').map((x) => x.trim()).filter((x) => x !== ''),
	}
}

/**
 * 现场枚举名册。
 *
 * 判定条件（写死在这里，改这里即改判定条件）：
 *   · 名册 = **含 `ROLE.md` 的目录**（front-matter 的 `kind` 不参与分类）；
 *   · 同 id 出现在多个根时**先列的那个根胜**（`rosterRoots()` 的顺序），后被遮蔽的进 `shadowed`；
 *   · 目录里没有 `ROLE.md`、或不是目录 ⇒ 不进名册（也不报错：那不是角色目录）。
 * @param extraRoots - 额外角色根（CLI / 测试用）。
 * @returns `{ roles, shadowed, roots }`，各按 id 升序。
 */
export function readRoster(extraRoots = [], options = {}) {
	const roots = rosterRoots(extraRoots, options)
	const byKey = new Map()
	const shadowed = []
	for (const { root, source, layer } of roots) {
		let entries = []
		try {
			entries = readdirSync(root, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) continue
			const record = readSkillDir(root, entry.name, source, layer)
			if (record === null) continue
			// 同 id 才互相遮蔽：先列的那个根胜（用户根 → 包内根），被遮蔽的进 `shadowed`。
			const key = layer + '/' + entry.name
			if (byKey.has(key)) {
				shadowed.push({ id: entry.name, layer, shadowedSource: source, winnerSource: byKey.get(key).source })
				continue
			}
			byKey.set(key, record)
		}
	}
	const all = [...byKey.values()]
	const sortById = (left, right) => left.id.localeCompare(right.id)
	return {
		roles: all.filter((record) => record.kind === 'role').sort(sortById),
		shadowed: shadowed.sort(sortById),
		roots,
	}
}

/** 生成块的标记：两个文档里各放一对，块内一律由本文件生成。 */
export const ROSTER_MARKERS = {
	begin: '<!-- ROSTER:BEGIN —— 本段由 `lib/roster.js` 生成，别手改；改角色请加/删 `roles/<id>/ROLE.md` 再跑 `npm run roster:write` -->',
	end: '<!-- ROSTER:END -->',
}

/**
 * 把 `text` 里 `BEGIN..END` 之间的内容换成 `block`（标记本身保留）。
 * @param text - 目标文档全文。
 * @param block - 新的块内容（不含标记）。
 * @returns 新全文；找不到标记时**原样返回**（由调用方判定成失败，不静默写坏文档）。
 */
export function replaceRosterBlock(text, block) {
	const begin = text.indexOf(ROSTER_MARKERS.begin)
	const end = text.indexOf(ROSTER_MARKERS.end)
	if (begin === -1 || end === -1 || end < begin) return text
	const head = text.slice(0, begin + ROSTER_MARKERS.begin.length)
	const tail = text.slice(end)
	return `${head}\n${block.trim()}\n${tail}`
}

/** 取块内容（自检比对用）；没有标记返回 null。 */
export function extractRosterBlock(text) {
	const begin = text.indexOf(ROSTER_MARKERS.begin)
	const end = text.indexOf(ROSTER_MARKERS.end)
	if (begin === -1 || end === -1 || end < begin) return null
	return text.slice(begin + ROSTER_MARKERS.begin.length, end).trim()
}

/** 名册一行里"来源"那一格：用户/额外的根要标出来，包内的标包内。 */
function sourceCell(record) {
	if (record.source === 'user') return '用户根'
	if (record.source === 'extra') return '额外根'
	return '包内'
}


/**
 * README 里那个**精简**生成块：一行 id 清单 + 计数（README 不复述职责表，避免第二份散文名册）。
 * @param roster - {@link readRoster} 的结果。
 * @returns markdown 文本。
 */
export function renderRoleIdList(roster) {
	const ids = roster.roles.map((role) => `\`${role.id}\``).join(' · ')
	const extras = roster.roles.filter((role) => role.source !== 'package').map((role) => role.id)
	return [
		`共 **${roster.roles.length}** 个角色（现场枚举 \`roles/\` 下每个目录的 \`ROLE.md\`）：`,
		'',
		ids || '（还没有任何角色 —— 用 `npm run role:new -- <角色 id>` 加一个）',
		'',
		// **说清这一份的范围**：README 那块来自"包内发布面"（`readRoster([])`）；
		// 本机用户角色根里的角色不在这一份里 —— 面板「成员」块能看到全部（那份按运行时枚举）。
		// 所以不写"用户级角色根里没有额外角色"那种话：本机有也不该读成矛盾。
		extras.length === 0 ? '（这一份是**包内发布面**；本机用户角色根里的角色不列在这里 —— 面板「成员」块里能看到全部）' : `（另有 **${extras.length}** 个来自用户级角色根：${extras.map((id) => `\`${id}\``).join('、')}）`,
	].join('\n')
}

/** 生成块要写进哪个文档（相对包根）—— 现在只有 README 一处。 */
export const ROSTER_TARGETS = [
	{ path: 'README.md', render: renderRoleIdList, label: 'README 角色列表' },
]

/**
 * 漂移检查：每个目标文档里的块与现场枚举是否一致。
 * @param packageRoot - 包根（默认由本文件位置推出）。
 * @param extraRoots - 额外角色根。
 * @returns `[{ label, path, ok, expected }]`。
 */
export function checkRoster(packageRoot = resolve(here, '..'), extraRoots = []) {
	// **只按包内根生成**：文档讲的是"这个包发了哪些编制"。用户级角色根里的角色在运行时生效
	// （`roleCatalog()` 会把两个根合起来），但不该被写进包内文档 —— 否则每个人跑一次 write
	// 都会把**自己机器上**的编制提交进包。要看全量用 `npm run roster:list`。
	const roster = readRoster(extraRoots, { includeUser: false })
	return ROSTER_TARGETS.map((target) => {
		const file = join(packageRoot, target.path)
		let current = null
		try {
			current = extractRosterBlock(readFileSync(file, 'utf8'))
		} catch {
			current = null
		}
		const expected = target.render(roster).trim()
		return { label: target.label, path: file, ok: current === expected, expected, current }
	})
}

/** 把生成块写回两个文档；返回逐个结果（写不进去不静默）。 */
export function writeRoster(packageRoot = resolve(here, '..'), extraRoots = []) {
	const roster = readRoster(extraRoots, { includeUser: false })
	return ROSTER_TARGETS.map((target) => {
		const file = join(packageRoot, target.path)
		try {
			const text = readFileSync(file, 'utf8')
			// 先判"有没有标记"再判"要不要改"：混在一起时，"已经是最新"会被报成"找不到标记"
			// （现场就是这么被骗过一次的：write 报错但 check 说一致）。
			if (extractRosterBlock(text) === null) return { label: target.label, path: file, ok: false, reason: '找不到生成块标记（ROSTER:BEGIN/END），未改动' }
			const next = replaceRosterBlock(text, target.render(roster))
			if (next === text) return { label: target.label, path: file, ok: true, changed: false }
			writeFileSync(file, next)
			return { label: target.label, path: file, ok: true, changed: true }
		} catch (error) {
			return { label: target.label, path: file, ok: false, reason: error instanceof Error ? error.message : String(error) }
		}
	})
}

/** 角色骨架模板：与既有那些角色同形（front-matter + 标题 + 四段），新角色一出生就进得了同一条检查。 */
export function roleScaffold(id, title, when) {
	return `---
kind: role
name: ${id}
version: 0.1.0
category: （分类：研发 / 设计 / 质量 / 数据 / 业务 / 管理 …）
description: Use when ${when}
---

# ${title}（${id}）

（一句话职责：这个角色独有什么、别人为什么叫它。团队规则（\`team/BASELINE.md\`）是全体共用的，本文只写本角色独有的东西。）

	（可选装备：\`skills: <能力名>[, <能力名>]\` 声明这个角色**专属**的作业程序（团队规则不写在这里 ——
	那是全体共用的 \`team/BASELINE.md\`，每个成员都会被告知去读它）。
	**工具面与模型不在这里声明**：成员由原生 \`spawnTeammate\` 建，它的 request 里没有这两格 ——
	写了也没有闸看它。）

## 视角（别人不会问的问题）

- （这个角色开口前必须先自己回答的那个问题；写它能防住的那类错，不写口号）

## 检查表

- [ ] （交付前逐条能判真假的条件；宁可少而硬，不要多而虚）

## 落点（产出与落盘）

- 产物路径与字段（≤8 个字段）；产物编号族（如果这个角色自产编号）

## 边界（明确不做什么）

- （越界就交回协调器转派的两三件事）
`
}

/**
 * 角色 id 的长度上限。
 *
 * 为什么是这个数：队友名是 `<角色 id>-<序号>`，而原生宿主对成员名有 **64 字符**的硬上限
 * （`…/dsh-experimental-agent-team/lib/index.js:704`，取源命令见 `docs/team/native-teams.md` 文末）；
 * 留出序号那几位，取 60。**超长的 id 会让你在"派活那一刻"才撞上限** —— 那时人已经以为角色建好了，
 * 报的错离现场很远，所以这条判在这里（写入层），三个建角色的入口一起受管。
 */
export const ROLE_ID_MAX = 60

/**
 * 角色 id 的判定（**只有这一处**：形状 + 长度；整份定义、骨架、面板添加、复制为自定义四条写入都走它）。
 *
 * 判据两条：
 *   · **形状** —— lower-kebab-case（小写字母开头，只含小写字母、数字与单个连字符）；
 *   · **长度** —— ≤ {@link ROLE_ID_MAX} 个字符（理由见那个常量：原生的成员名上限）。
 * @param id - 候选 id。
 * @returns 空数组即合法；否则一行行可照做的原因。
 */
export function roleIdFindings(id) {
	if (typeof id !== 'string' || id.trim() === '') return ['角色 id 必填（lower-kebab-case，例如 content-ops）']
	const value = id.trim()
	const parts = []
	if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(value)) parts.push(`角色 id 必须是小写 kebab-case（例如 content-ops），收到 ${JSON.stringify(id)}`)
	if (value.length > ROLE_ID_MAX) {
		parts.push(`角色 id 太长（${value.length} 字符，上限 ${ROLE_ID_MAX}）：队友名是 \`<角色 id>-<序号>\` 且原生上限 64 字符 —— 再长这一档就永远起不了人`)
	}
	return parts
}

/** 路径**已存在的那一段**的真实路径（不存在的尾部原样拼回去）。越界判定要用它。 */
function realPathOfExisting(path) {
	let current = resolve(path)
	const rest = []
	for (;;) {
		try {
			return join(realpathSync(current), ...rest.reverse())
		} catch {
			const parent = dirname(current)
			if (parent === current) return resolve(path)
			rest.push(basename(current))
			current = parent
		}
	}
}

/**
 * 落点守卫：写角色定义前，按**真实路径**判它仍在角色根之内。
 *
 * 与 `lib/skill-write.js` 的 `realInsideFindings` 同一口径（同一类风险只写一次判定，两处各写一份会分叉）：
 * 字符串比对挡得住 `../`，挡不住**符号链接** —— 角色根里某一级是指向别处的链接时，写会落到根外去。
 * @param root - 信任根（用户角色根）。
 * @param target - 本次要写的文件路径。
 * @returns `null` 放行；否则一句可读的拒绝理由。
 */
function realInsideFindings(root, target) {
	const trusted = realPathOfExisting(root)
	const rel = relative(trusted, realPathOfExisting(target))
	if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return null
	return `写落点越界：${target} 的真实路径不在角色根（${trusted}）之内 —— 中间某一级是不是符号链接指到了外面？`
}

/**
 * **写一份角色定义**（`roles/<id>/ROLE.md`）—— 角色侧唯一的写入接缝。
 *
 * 三条判定都在这里，调用方只组装文本：
 *   · id 形状（`roleIdFindings`）；
 *   · 落点不许越界（字符串 + 真实路径两道）；
 *   · 已存在时**必须显式 `mode: 'update'`**，且覆盖前把原文件留一份 `ROLE.md.bak`（不许静默覆盖）。
 * 写法与技能侧同一条路：**先落暂存名、再改名** —— 写失败不会在角色根里留半份文件。
 * @param id - 角色 id。
 * @param text - 完整角色定义文本（front-matter + 正文）。
 * @param options - `{ root, mode }`：`root` 缺省用户级角色根；`mode` 为 `create`（缺省）/ `update`。
 * @returns `{ ok: true, file, root, backup, created }` 或 `{ ok: false, reason }`。
 */
export function writeRoleDefinition(id, text, { root = userRolesRoot(), mode = 'create' } = {}) {
	const findings = roleIdFindings(id)
	if (findings.length > 0) return { ok: false, reason: findings.join('；') }
	const value = id.trim()
	const dir = join(root, value)
	const file = join(dir, ROLE_FILE)
	const rel = relative(resolve(root), resolve(file))
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, reason: `落点越界：${file} 不在角色根 ${root} 之内` }
	const outside = realInsideFindings(root, file)
	if (outside !== null) return { ok: false, reason: outside }
	const exists = existsSync(file)
	if (exists && mode !== 'update') {
		return { ok: false, reason: `已经存在：${file}（要覆盖请带 mode=update —— 覆盖前会留一份 ${ROLE_FILE}.bak，不许静默覆盖）` }
	}
	if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: '角色定义文本为空：没有内容的定义不算一份定义' }
	let backup = null
	try {
		mkdirSync(dir, { recursive: true })
		if (exists) {
			backup = join(dir, `${ROLE_FILE}.bak`)
			writeFileSync(backup, readFileSync(file, 'utf8'))
		}
		const staging = join(dir, `${ROLE_FILE}.writing-${process.pid}`)
		writeFileSync(staging, text)
		renameSync(staging, file)
	} catch (error) {
		return { ok: false, reason: `写文件失败：${error instanceof Error ? error.message : String(error)}` }
	}
	return { ok: true, file, root, backup, created: !exists }
}

/** 写一个新角色骨架（`npm run role:new` 与它那条路）。`root` 缺省为用户级**角色**根（不改包）。 */
export function writeRoleScaffold(id, { title = id, when = '（写什么时候该派这个角色）', root = userRolesRoot(), mode = 'create' } = {}) {
	const findings = roleIdFindings(id)
	if (findings.length > 0) return { ok: false, reason: findings.join('；') }
	const written = writeRoleDefinition(id, roleScaffold(id.trim(), title, when), { root, mode })
	if (written.ok !== true) return { ok: false, reason: written.reason }
	return { ok: true, file: written.file, root: written.root }
}

