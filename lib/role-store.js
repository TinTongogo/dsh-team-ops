/**
 * 角色域：现场枚举、角色开关、下架名单，以及面板/工具的角色写盘。
 *
 * 从 `team/team-runtime.js` 分出来：这一整段只认"角色根 + ROLE.md"，不碰名册/成员/技能；
 * 事务与路径原语走 `../team/company-gate.js` 的 `runtimeBridge`（与宿主同一套 CAS 与队列）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { runtimeBridge as B } from '../team/company-gate.js'
import { PACKAGED_ROLES_ROOT, roleIdFindings, roleRootOf, roleScopeLine, rosterRoots, writeRoleDefinition, writeRoleTextAtomically } from './roster.js'
import { ROLE_CATEGORY_BY_TONE, avatarFileIn, avatarOf, avatarToneOf } from './role-avatar.js'
import { commaListOf, dutyOfSkillText, parseFrontMatter, patchRoleText, roleTextOf, titleOfSkillText, whenOfSkillDescription, withoutFrontMatter } from './role-text.js'
import { invalidateRoleRecords, readRoleRecords } from './role-record-cache.js'

export const ROLE_ORIGIN_FACET_LABEL = { workspace: '项目级', user: '用户级', package: '包内' }

/** 角色来源的中文说法（回执与面板都用它，一处正文）。 */
const ROLE_SOURCE_LABEL = { workspace: '本工作区的角色根', user: '用户角色根', package: '包内（随插件发布）', explicit: '指定的角色根' }

export function roleCatalog(root, workspace) {
	// 显式给根时**只用它**（测试与特殊部署）；否则按"**工作区根 → 用户根 → 包内根**"的顺序看。
	const roots = root === undefined ? roleRootRecords(workspace) : [{ root, source: 'explicit' }]
	return roleRecords(roots)
		.filter((record) => record.kind === 'role')
		.map((record) => record.id)
		.sort()
}

/**
 * 角色根 + 来路标记（用户根排最前：同名时它胜）。
 *
 * **角色住 `roles/`**：`roles/<id>/ROLE.md` 是**角色定义**（身份、职责边界、检查表、落点、专属技能）。
 * 团队规则是包内那一份 `team/BASELINE.md`（一份文件，不在名册里）。
 */
export function roleRootRecords(workspace) {
	// **顺序不在这里写**：枚举顺序的唯一正文是 `lib/roster.js` 的 `rosterRoots`
	// （显式根 → 工作区根 → 用户根 → 包内根，同名高处赢）—— 这里只是把它转成记录层要的形状。
	return rosterRoots([], { workspace }).map((entry) => ({ root: entry.root, source: entry.source }))
}

/** 现场的角色记录（工作区根 > 用户根 > 包内根；`workspace` 给了才带上工作区那一层）。 */
export function roleRecordsFor(workspace) {
	return roleRecords(roleRootRecords(workspace))
}

/**
 * 现场读出的角色记录（**角色的唯一真相源**）：每个含 `ROLE.md` 的目录一条，
 * 同 id 时**先列的那个根胜**（`roleRootRecords` 的顺序：**工作区根 → 用户根 → 包内根**）。
 *
 * 每条带上"这一栏画卡片要用的全部信息"：显示名（`# 标题（id）` 的标题）、
 * 一句话职责（标题后第一段）、什么时候派它（front-matter `description` 去掉 `Use when`）、
 * 分类（front-matter `category`，缺省按色调回落）、来路、文件路径，以及**是否有头像文件**。
 *
 * **读缓存**：扫描与签名判定在 `lib/role-record-cache.js`，只有 ROLE.md 真变了才重读重解析；
 * 目录增删每轮现读，所以"现场枚举"的即时性不变。
 * @param roots - `[{root, source}]`；缺省取 {@link roleRootRecords}。
 * @returns 记录数组（未排序；调用方按需排序）。
 */
export function roleRecords(roots) {
	const list = roots ?? roleRootRecords()
	return readRoleRecords(list, ({ id, dir, file, root, source, text }) => {
		const meta = parseFrontMatter(text)
		return {
			id,
			// 名册里只有一类：**角色**。front-matter 的 `kind` 不参与分类（规则是 `team/BASELINE.md`，不在名册里）。
			kind: 'role',
			source,
			root,
			dir,
			file,
			title: titleOfSkillText(text) || id,
			duty: dutyOfSkillText(text),
			when: whenOfSkillDescription(meta.description),
			category: typeof meta.category === 'string' && meta.category !== '' ? meta.category : ROLE_CATEGORY_BY_TONE[avatarToneOf(id)] ?? '其他',
			version: typeof meta.version === 'string' ? meta.version : '',
			avatar: avatarOf(id),
			avatarTone: avatarToneOf(id),
			avatarFile: avatarFileIn(dir),
			chars: text.length,
			// **装备**只有一格：`skills` —— 这个角色引用的**专属作业程序**（逗号分隔；包内不再有技能层）。
			// 工具面档与模型/推理档**不在角色定义里**：成员由原生 `spawnTeammate` 建，它的 request 只有
			// `name` / `description` / `prompt` / `context` / `provider` / `signal` —— 插件这一层落不出闸，
			// 所以 `toolset` / `tools_extra` / `tools_off` / `model` / `reasoning` 五格已删
			// （声明了却没人读，读的人会以为它有效）。
			skills: commaListOf(meta.skills),
			// 角色定义的**正文**（去掉 front-matter）：这就是它的作业程序，会被原样注入成员的系统提示。
			body: withoutFrontMatter(text),
		}
	})
}

/**
 * 用户级角色根：`$DSH_TEAM_OPS_ROLES` → `$DSH_HOME/team-ops/roles` → `~/.dsh/team-ops/roles`。
 */
export function userRolesRoot() {
	const explicit = process.env.DSH_TEAM_OPS_ROLES
	if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
	const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
	return join(home, 'team-ops', 'roles')
}

// ── 角色管理（"当前团队有哪些角色在上场"） ───────────────────────────────────

/**
 * 角色开关文件的空形状：**只记"关掉了哪些"**（负向清单）。
 *
 * 为什么用负向清单：角色的**真相源是角色目录**（加一个目录就多一个角色）。若文件里存
 * "启用了哪些"，那么每加一个角色都要来改文件，两份清单迟早分叉；存"关掉了哪些"之后，
 * **新角色天生可用**、删掉的角色在文件里留一行无害的死项（缺项不当成"禁用"）。
 */
export function emptyRolesLedger() {
	return { version: B.LEDGER_VERSION, seq: 0, disabled: [] }
}

/** 文件里的停用名单（形状不符时按空数组读：手改坏的文件不该把插件炸掉）。 */
export function disabledRolesOf(value) {
	return Array.isArray(value?.disabled) ? value.disabled.filter((id) => typeof id === 'string' && id !== '') : []
}

/** 角色开关文件的绝对路径（按工作区；"当前团队"就是当前工作区）。 */
function rolesLedgerPath(ctx, exec) {
	return join(B.workspaceRootOf(exec), B.LEDGER_FILE.roles)
}

/**
 * 读当前团队的角色清单：**现场枚举的角色 + 每个角色的启用状态**。
 *
 * 与"名册"的分工：`roleCatalog()` 答"这台机器上有哪些角色"（角色目录决定的，全局），
 * 这里答"**当前团队**用哪些"（工作区文件里的停用名单决定的，可按团队不同）。
 * @param ctx - 上下文。
 * @param exec - 调用方（面板给 `exec.workspace`）。
 * @returns `{ roles, disabled, reference, file, workspace }`：`roles` 按分类 + id 排序的卡片数组。
 */
export async function rolesViewOf(ctx, exec) {
	const absPath = rolesLedgerPath(ctx, exec)
	const snapshot = await B.readLedger(ctx, absPath, exec)
	const value = snapshot.kind === 'absent' ? emptyRolesLedger() : snapshot.value
	const disabled = disabledRolesOf(value)
	const records = roleRecordsFor(exec?.workspace)
	const roles = records
		.filter((record) => record.kind === 'role')
		.map((record) => ({
			id: record.id,
			title: record.title,
			category: record.category,
			duty: record.duty,
			when: record.when,
			source: record.source,
			avatar: record.avatar,
			avatarTone: record.avatarTone,
			hasAvatarFile: record.avatarFile !== null,
			definitionChars: record.chars,
			definitionPath: record.file,
			// **装备**：这一层是"角色 ≠ 技能"的实证（面板的卡片上就看得见）。
			skills: record.skills,
			enabled: !disabled.includes(record.id),
		}))
		.sort((left, right) => (left.category === right.category ? left.id.localeCompare(right.id) : left.category.localeCompare(right.category)))
	return {
		roles,
		disabled: disabled.filter((id) => roles.some((role) => role.id === id)),
		staleDisabled: disabled.filter((id) => !roles.some((role) => role.id === id)),
		reference: records.filter((record) => record.kind === 'reference').map((record) => ({ id: record.id, title: record.title, duty: record.duty })),
		file: absPath,
		workspace: B.workspaceRootOf(exec),
		roots: roleRootRecords(exec?.workspace).map((entry) => ({ root: entry.root, source: entry.source })),
	}
}

/**
 * 开 / 关一个角色（**当前团队**的编制开关）。
 *
 * 语义（三条，改这里即改判定）：
 *   · 停用状态**只写进 `.ops/roles.json`**：`role_manage action=list` 与角色卡据此显示「已停用」；
 *   · **`member_spawn` 不看这个开关**（现场枚举到的角色都叫得动）—— 这条开关没有接线，是**标注**不是闸；
 *   · **已在场的成员不受影响** —— 它们是"人"，不是"角色"：把角色关了，不等于把在干活的人裁了。
 * 角色必须**还在现场名册里**（角色目录存在）：给不存在的角色写开关是拼错名字，当场拒。
 * @param ctx - 上下文。
 * @param exec - 调用方（面板给 `exec.workspace`）。
 * @param args - `{ role, enabled, actor? }`。
 * @returns `{ role, enabled, disabled, file }`。
 */
export async function setRoleEnabled(ctx, exec, args) {
	const role = B.requireText(args.role, 'role')
	if (typeof args.enabled !== 'boolean') throw new Error(`enabled 必须是布尔值，收到 ${JSON.stringify(args.enabled)}。`)
	const known = roleCatalog(undefined, B.workspaceRootOf(exec))
	if (known.length > 0 && !known.includes(role)) {
		throw new Error(`角色 "${role}" 不在现场名册里（枚举顺序：**工作区根 → 用户根 → 包内根**）：现在是 ${roleRosterLine(known)}。`)
	}
	const absPath = rolesLedgerPath(ctx, exec)
	const outcome = await B.transact(ctx, absPath, exec, async () => {
		const snapshot = await B.readLedger(ctx, absPath, exec)
		const value = snapshot.kind === 'absent' ? emptyRolesLedger() : snapshot.value
		const disabled = disabledRolesOf(value)
		const next = args.enabled ? disabled.filter((id) => id !== role) : disabled.includes(role) ? disabled : [...disabled, role]
		const value2 = {
			...value,
			version: B.LEDGER_VERSION,
			seq: Number.isInteger(value.seq) ? value.seq + 1 : 1,
			writer: B.writerStamp(),
			disabled: next,
			updated_at: new Date().toISOString(),
		}
		// **必须真的落盘**：`transact` 只负责串行与 CAS 重试，写回得自己调 commitLedger
		// （漏掉这一句的形态很隐蔽：回执说成功、磁盘上什么都没有）。
		await B.commitLedger(ctx, absPath, snapshot, value2, exec)
		return { disabled: next, changed: next.length !== disabled.length, warnings: B.foreignWriterWarnings(value) }
	})
	return { role, enabled: args.enabled, disabled: disabledOf(outcome.disabled), file: absPath, changed: outcome.changed === true, warnings: outcome.warnings ?? [] }
}

/** 归一化一份停用名单（回执里用同一形状，免得调用方看到 undefined）。 */
function disabledOf(list) {
	return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id !== '') : []
}

/** 归一化一份下架名单（`hiddenRolesOf` 收的是**值对象**、这里收的是**数组**：两处别混）。 */
function hiddenOf(list) {
	return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id !== '') : []
}

/**
 * 一个角色的**定义原文**（面板的「查看 / 复制」读它）：`roles/<id>/ROLE.md` 全文。
 *
 * 只从**现场名册里那两条根**读（包内 + 用户级角色根）—— 不接受任意路径，
 * 于是"看别人的文件"这件事在这个端点上不成立。
 * @param ctx - 上下文。
 * @param exec - 调用方（面板给 `exec.workspace`）。
 * @param role - 角色 id。
 * @returns `{ role, title, category, source, path, text }`。
 */
export function roleDefinitionTextOf(ctx, exec, role) {
	const wanted = B.requireText(role, 'role')
	const workspaceOfRead = B.workspaceRootOf(exec)
	const record = roleRecordsFor(workspaceOfRead).find((item) => item.id === wanted)
	if (record === undefined) {
		throw new Error(`角色 "${wanted}" 不在现场名册里（枚举顺序：**工作区根 → 用户根 → 包内根**）：现在是 ${roleRosterLine(roleCatalog(undefined, workspaceOfRead))}。`)
	}
	const text = readFileSync(record.file, 'utf8')
	return { role: record.id, title: record.title, category: record.category, source: record.source, path: record.file, text, chars: text.length }
}

/**
 * 「复制为自定义」：把一个角色**复制进角色根**（缺省**本工作区**的 `<工作区>/.dsh/team-ops/roles/`，`scope: "user"` 才是用户级角色根）。
 *
 * 为什么要有这个动作：包内角色随包更新覆盖，直接改会被下一次安装刷掉；用户根那份是**你自己的**。
 * 复制的形态：同内容的 `ROLE.md`，`name` 换成新 id，另加一行 `derived_from: <原角色>`（说清它从哪来）。
 * 新 id 缺省 `<原角色>-custom`，重名就往后加序号（`-custom-2`…），**不覆盖任何已存在的目录**。
 * 注意：**这条动作与技能目录没有关系**（它复制的是角色定义，不是技能）—— 从前这里写着"新角色的技能要
 * 重启 DSH 才会被加载"，现场验下来那是**过头话**：技能目录按变更即时刷新，写盘后下一次提示词就带上它（见
 * `role_define` / `skill_define` 那一节；「技能」块读的是宿主 `ctx.skills` 的现场目录）。角色卡片则一向是
 * 立刻可见 —— 它读的是现场名册，每次请求现枚举。
 * @param ctx - 上下文。
 * @param exec - 调用方（面板给 `exec.workspace`）。
 * @param args - `{ role, id?, actor? }`。
 * @returns `{ id, file, derivedFrom, promptRoster, promptRosterNote }`（生效面两句话见 {@link roleWriteEffects}）。
 */
export function customizeRole(ctx, exec, args) {
	const source = roleDefinitionTextOf(ctx, exec, args.role)
	const base = B.optionalText(args.id, 'id') ?? `${source.role}-custom`
	// 与另外三个入口同一处判定（形状 + 长度都在写入层）：复制出来的 id 也不能超长。
	const baseFindings = roleIdFindings(base)
	if (baseFindings.length > 0) throw new Error(`${baseFindings.join('；')}。这一条是**复制为自定义**的目标 id（缺省 \`${source.role}-custom\`，给短一点的名字）。`)
	// **作用域**（与另外三个入口同一处判定）：缺省工作区根；不给人留"只能往全局塞"的路。
	const target = panelRoleTarget(exec, args)
	const root = target.root
	let id = base
	for (let index = 2; existsSync(join(root, id)); index += 1) id = `${base}-${index}`
	const dir = join(root, id)
	const text = source.text
		.replace(/^name:\s*.*$/m, `name: ${id}`)
		.replace(/^(version:\s*.*)$/m, `$1\nderived_from: ${source.role}`)
	if (!/^derived_from:/m.test(text)) throw new Error(`角色文件缺少 version 行，无法标注来源（${source.path}）。`)
	mkdirSync(dir, { recursive: true })
	// 角色定义的文件名是 `ROLE.md`（`roles/` 层的约定）；复制出来的是**角色**，不是技能。
	writeFileSync(join(dir, 'ROLE.md'), text)
	return { id, file: join(dir, 'ROLE.md'), root, scope: target.scope, scopeLine: roleScopeLine(target.scope), derivedFrom: source.role, ...roleWriteEffects() }
}


// ── 默认队友清单的增删改（写角色根 + 下架记录） ─────────────────────────
//
// 三条动词各自落在**一处真相源**上，面板只是它的一个编辑面：
//   · **添加 / 修改** ⇒ 写**角色根**（缺省**本工作区**的 `<工作区>/.dsh/team-ops/roles/`；`scope: "user"` 才是用户根）
//     下的 `roles/<id>/ROLE.md`。包内那份是**发布面**（升级会覆盖），所以对包内角色的修改
//     一律是"在用户根写一份同名覆盖"—— 用户根优先（见 `roleRootRecords` 的顺序），改完立刻生效。
//   · **删除** ⇒ 用户根那份：删目录（若它在覆盖包内同名，那就是"回到包内那份"，`revert`）；
//     只有包内那份的角色：**下架**（写工作区文件 `.ops/roster.json` 的 `hidden`，可恢复）——
//     发布面不能从面板上删掉，那是包自己的东西。
//
// 两个生效面（现场验过，别写成一句"要重启才能用"）：**工具面立刻可用** —— `member_defaults` /
// `member_spawn` 现枚举这份名册，建完立刻派得出人；**只有注入到系统提示里那份「可叫的队友」清单是
// 装载时的快照**，要重启 DSH 才更新，而那一条不影响能不能叫人。回执用下面这对字段说这件事 ——
// **字段名本身不许把"能不能用"挂在重启上**（旧字段 `restartRequired` 就是这个毛病，已改名）。

/**
 * 面板那三条写动作（添加 / 修改 / 复制为自定义）共用的**生效面读数**（一处正文，三处共用）。
 *
 * 为什么不是 `restartRequired`：那个字段名读起来就是"不重启就不能用"，而事实正相反 ——
 * 工具面是现枚举的、立刻可用，要重启的只是**注入到系统提示里那份「可叫的队友」清单**这个快照。
 * 字段名说清楚"是哪一份东西旧了"，别让人从名字里读出一个不成立的结论。
 * @returns `{ promptRoster, promptRosterNote }`。
 */
export function roleWriteEffects() {
	return {
		promptRoster: 'stale',
		promptRosterNote:
			'改动**立刻可用**：`member_defaults` / `member_spawn` 现枚举这份名册（面板也每次现枚举）；' +
			'只有**注入到系统提示里那份「可叫的队友」清单**是装载时的快照，重启 DSH 才会更新它 —— 那一条不影响能不能叫人。',
	}
}

/** 空下架记录。只在本文件确实不在时使用。 */
export function emptyRosterLedger() {
	return { version: B.LEDGER_VERSION, seq: 0, hidden: [] }
}

/** 文件里的下架名单（形状不符时按空数组读）。 */
export function hiddenRolesOf(value) {
	return Array.isArray(value?.hidden) ? value.hidden.filter((id) => typeof id === 'string' && id !== '') : []
}

/** 下架记录的绝对路径（按工作区：团队就是工作区）。 */
function rosterLedgerPath(ctx, exec) {
	return join(B.workspaceRootOf(exec), B.LEDGER_FILE.roster)
}

/**
 * 读下架记录（文件不在 = 一个都没下架时的空形状）。
 * @param ctx - 上下文。
 * @param exec - 调用方。
 * @returns `{ hidden, file, established }`。
 */
export async function rosterLedgerOf(ctx, exec) {
	const absPath = rosterLedgerPath(ctx, exec)
	const snapshot = await B.readLedger(ctx, absPath, exec)
	const value = snapshot.kind === 'absent' ? emptyRosterLedger() : snapshot.value
	return { hidden: hiddenRolesOf(value), file: absPath, established: snapshot.kind !== 'absent' }
}

/** 一个角色的定义文件路径（用户根）。 */
function userRoleFileOf(id) {
	return join(userRolesRoot(), id, 'ROLE.md')
}

/**
 * **面板那几条角色写路径的作用域解析**（与 `role_define` 同一套口径，一处正文）：
 * 缺省 `workspace`（本工作区的角色根）、`user` 必须显式、非法值当场抛。
 * @returns `{ scope, root }`。
 */
function panelRoleTarget(exec, args) {
	const workspace = B.workspaceRootOf(exec)
	const raw = typeof args?.scope === 'string' ? args.scope : undefined
	const scope = raw === undefined || raw === 'workspace' ? 'workspace' : raw === 'user' ? 'user' : null
	if (scope === null) throw new Error(`scope 只能是 workspace（本工作区，缺省）/ user（全局，影响所有工作区），收到 ${JSON.stringify(args?.scope)}。`)
	const target = roleRootOf(scope, workspace)
	if (target === null) throw new Error('工作区取不到：缺省作用域要往本工作区的角色根写，而这次调用没带工作区（或显式给 `scope: "user"`）。')
	return { scope, root: target.root, workspace }
}

/** 角色 id 的形状（与 `member_spawn` 的成员名同一条：lower-kebab-case）。 */
function assertRoleId(id) {
	// **判定只有一处**：形状与长度都在 `lib/roster.js` 的 `roleIdFindings`（写入层）。这里从前自带一份
	// 正则 —— 那既是第二份形状判定，又漏了长度（超长 id 会一路过到派活那一刻才撞宿主 64 字符上限）。
	const findings = roleIdFindings(id)
	if (findings.length > 0) throw new Error(`${findings.join('；')}。角色 id 会变成目录名与队友名前缀 \`<id>-<序号>\`。`)
	return String(id ?? '').trim()
}

/**
 * 添一个角色：在**角色根**写下 `roles/<id>/ROLE.md`（最小定义：显示名 / 分类 / 一句话定位 / 可选正文；**缺省作用域是工作区**）。
 *
 * 不覆盖任何已存在的东西：现场名册里已经有这个 id（包内或用户根）就直接拒 —— 要改请用「修改」。
 * @param ctx - 上下文。
 * @param exec - 调用方。
 * @param args - `{ id, title, category, positioning, body?, skills?, actor? }`
 *   （`skills` 是**角色专属技能**的逗号分隔串；空串/不给 ⇒ 不写 `skills:` 那一行）。
 * @returns `{ ok, role, file, root, promptRoster, promptRosterNote }`（生效面两句话见 {@link roleWriteEffects}）。
 */
export function createRole(ctx, exec, args) {
	const id = assertRoleId(args?.id)
	// **作用域**（HD-008，缺省工作区）：同名不同作用域**互不覆盖** ⇒ 查重只看**落点那个根**。
	const target = panelRoleTarget(exec, args)
	const inSameRoot = roleCatalog(target.root).includes(id)
	if (inSameRoot) {
		throw new Error(`角色 "${id}" 已经在${target.scope === 'user' ? '用户角色根' : '本工作区的角色根'}里了；要改它请用「修改」，换个 id 再添加。`)
	}
	const positioning = B.requireText(args?.positioning, 'positioning')
	const title = B.optionalText(args?.title, 'title') ?? id
	const category = B.optionalText(args?.category, 'category') ?? '其他'
	const body = B.optionalText(args?.body, 'body') ?? ''
	// **专属技能也要传下去**：`roleTextOf` 一直在写 `skills:` 那一行，但调用点从前不带这个字段
	// ⇒ 面板「新建角色」填的专属技能被静默丢掉（回执照样 `ok: true`），自检也绿（只有纯函数那层喂过它）。
	const skills = B.optionalText(args?.skills, 'skills') ?? ''
	const root = target.root
	const dir = join(root, id)
	mkdirSync(dir, { recursive: true })
	const file = join(dir, 'ROLE.md')
	writeRoleTextAtomically(file, roleTextOf({ id, title, category, positioning, body, skills }))
	invalidateRoleRecords()
	return { ok: true, role: id, title, category, file, root, scope: target.scope, scopeLine: roleScopeLine(target.scope), ...roleWriteEffects() }
}

/**
 * 改一个角色的**定位那几格**（显示名 / 分类 / 一句话定位）+ **专属技能**：改的是**用户根**那一份 ——
 * 若这个角色本来只在包内，就先把它整份复制到用户根（同 id：用户根优先 ⇒ 从此以你这份为准），
 * 再改那几格；正文一字不动。
 *
 * `skills` 的口径（与 `patchRoleText` 一处）：**给了**才动这一行 —— 非空则写、空串则删掉那一行
 * （"这个角色没有专属技能"）、**不给就一个字不碰**（面板没带这一格时不许把人家声明的技能抹掉）。
 * @param ctx - 上下文。
 * @param exec - 调用方。
 * @param args - `{ role, title?, category?, positioning?, skills?, actor? }`（至少给一格）。
 * @returns `{ ok, role, file, root, shadowed, promptRoster, promptRosterNote }`（生效面两句话见 {@link roleWriteEffects}）。
 */
export function editRole(ctx, exec, args) {
	const role = B.requireText(args?.role, 'role')
	const workspaceOfEdit = B.workspaceRootOf(exec)
	const record = roleRecordsFor(workspaceOfEdit).find((item) => item.id === role)
	if (record === undefined) throw new Error(`角色 "${role}" 不在现场名册里（枚举顺序：**工作区根 → 用户根 → 包内根**）：现在是 ${roleRosterLine(roleCatalog(undefined, workspaceOfEdit))}。`)
	const title = B.optionalText(args?.title, 'title')
	const category = B.optionalText(args?.category, 'category')
	const positioning = B.optionalText(args?.positioning, 'positioning')
	// `skills` 用**是否给过**来判（`''` 是有意义的取值：清掉那一行），所以不能拿 `optionalText` 的
	// undefined 当"没给"—— 空串与没给是两件事。
	const skillsProvided = typeof args?.skills === 'string'
	if (title === undefined && category === undefined && positioning === undefined && !skillsProvided) {
		throw new Error('修改至少要给一格：title（显示名）/ category（分类）/ positioning（一句话定位）/ skills（专属技能，逗号分隔；给空串＝清空这一行）。')
	}
	// **落点**：我们自己的那两份（工作区 / 用户根）**就地改**；包内那份先在**目标作用域根**写一份
	// 同名覆盖（带 `derived_from`）—— 目标作用域缺省工作区（HD-008），`scope: "user"` 才是全局。
	const isOurs = record.source === 'user' || record.source === 'workspace'
	const target = panelRoleTarget(exec, args)
	const root = isOurs ? record.root : target.root
	const file = isOurs ? record.file : join(target.root, role, 'ROLE.md')
	if (!isOurs) {
		// 包内那份整份复制到用户根（同 id）：front-matter 加一行 `derived_from` 说清来路，正文原样。
		const text = readFileSync(record.file, 'utf8')
		const withSource = /^derived_from:/m.test(text) ? text : text.replace(/^(version:\s*.*)$/m, `$1\nderived_from: ${role}`)
		mkdirSync(join(root, role), { recursive: true })
		writeRoleTextAtomically(file, withSource)
	}
	const current = readFileSync(file, 'utf8')
	writeRoleTextAtomically(file, patchRoleText(current, { id: role, title, category, positioning, ...(skillsProvided ? { skills: args.skills } : {}) }))
	invalidateRoleRecords()
	return { ok: true, role, file, root, shadowed: !isOurs, scope: isOurs ? (record.source === 'workspace' ? 'workspace' : 'user') : target.scope, scopeLine: roleScopeLine(isOurs ? (record.source === 'workspace' ? 'workspace' : 'user') : target.scope), ...roleWriteEffects() }
}

/**
 * 删一个角色（面板上的"删除"）：按**出处**分三种，回执里说清是哪一种（`mode`）。
 *
 *   · `delete` —— 用户根自己加的（包内没有同名）⇒ **真删那个目录**；
 *   · `revert` —— 用户根那份在覆盖包内同名 ⇒ 删掉覆盖，**回到包内那份**（不是"角色没了"）；
 *   · `hide`   —— 只有包内那份 ⇒ **下架**（写工作区文件，可恢复；发布面不能从面板上删）。
 * @param ctx - 上下文。
 * @param exec - 调用方。
 * @param args - `{ role, actor? }`。
 * @returns `{ ok, role, mode, file?, hidden, warnings }`。
 */
export async function removeRole(ctx, exec, args) {
	const role = B.requireText(args?.role, 'role')
	const workspaceForRole = B.workspaceRootOf(exec)
	const record = roleRecordsFor(workspaceForRole).find((item) => item.id === role)
	if (record === undefined) throw new Error(`角色 "${role}" 不在现场名册里（枚举顺序：**工作区根 → 用户根 → 包内根**）：现在是 ${roleRosterLine(roleCatalog(undefined, workspaceForRole))}。`)
	// **工作区 / 用户根那两份都是"我们自己的"** ⇒ 真删目录；只有包内那份才是"下架"。
	const isOurs = record.source === 'user' || record.source === 'workspace'
	if (!isOurs) {
		const outcome = await setRoleHidden(ctx, exec, { role, hidden: true })
		return { ok: true, role, mode: 'hide', hidden: outcome.hidden, file: outcome.file, warnings: outcome.warnings }
	}
	const shadowsPackaged = packagedRoleIds().includes(role)
	// 真删目录：**只删这一个角色的目录**（它所在那个根下 `<id>/`），路径在这里现算、不接受外部给的目录。
	const dir = join(record.root, role)
	rmSync(dir, { recursive: true, force: true })
	invalidateRoleRecords()
	// 下架名单只是**回执里的附带读数**（真正要动的那个目录已经删了）：读不到就如实写 null，
	// 不让一次读失败把"已经删掉了"这个事实弄成一条失败回执。
	let hidden = null
	try {
		hidden = (await rosterLedgerOf(ctx, exec)).hidden
	} catch {
		hidden = null
	}
	return { ok: true, role, mode: shadowsPackaged ? 'revert' : 'delete', file: record.file, hidden, warnings: [] }
}

/**
 * 把一个**下架**的角色恢复上架（从工作区文件的 `hidden` 里去掉）。
 * @param ctx - 上下文。
 * @param exec - 调用方。
 * @param args - `{ role, actor? }`。
 * @returns `{ ok, role, hidden, file, changed, warnings }`。
 */
export async function restoreRole(ctx, exec, args) {
	const role = B.requireText(args?.role, 'role')
	const outcome = await setRoleHidden(ctx, exec, { role, hidden: false })
	return { ok: true, role, mode: 'restore', hidden: outcome.hidden, file: outcome.file, changed: outcome.changed, warnings: outcome.warnings }
}

/** 下架 / 恢复：写工作区文件 `.ops/roster.json` 的 `hidden`（只读时不动它）。 */
async function setRoleHidden(ctx, exec, { role, hidden }) {
	const absPath = rosterLedgerPath(ctx, exec)
	const outcome = await B.transact(ctx, absPath, exec, async () => {
		const snapshot = await B.readLedger(ctx, absPath, exec)
		const value = snapshot.kind === 'absent' ? emptyRosterLedger() : snapshot.value
		const before = hiddenRolesOf(value)
		const next = hidden ? (before.includes(role) ? before : [...before, role]) : before.filter((id) => id !== role)
		const value2 = {
			...value,
			version: B.LEDGER_VERSION,
			seq: Number.isInteger(value.seq) ? value.seq + 1 : 1,
			writer: B.writerStamp(),
			hidden: next,
			updated_at: new Date().toISOString(),
		}
		await B.commitLedger(ctx, absPath, snapshot, value2, exec)
		return { hidden: next, changed: next.length !== before.length, warnings: B.foreignWriterWarnings(value) }
	})
	// `outcome.hidden` 是**数组**（事务回调已经取过值对象了）——别再套一层 `hiddenRolesOf`
	// （那会读 `undefined.hidden` ⇒ 回执永远空，而盘上其实写对了：现场最难查的一种错法）。
	return { hidden: hiddenOf(outcome.hidden), file: absPath, changed: outcome.changed === true, warnings: outcome.warnings ?? [] }
}

/** 角色名册的 Markdown 一行（提示词段与工具回执共用同一处，免得两处各列一份）。 */
export function roleRosterLine(roles) {
	return roles.length === 0
		? '（角色根读不到：名册为空 —— 检查包内 `team/roles/` 是否随包装载，或用 `npm run role:new -- <角色 id>` 加一个）'
		: roles.join(' · ')
}

/** 包内那份角色根里有哪些 id（判"用户根这份是不是在覆盖包内同名"）。 */
export function packagedRoleIds() {
	const root = PACKAGED_ROLES_ROOT
	return roleRecords([{ root, source: 'package' }])
		.filter((record) => record.kind === 'role')
		.map((record) => record.id)
}

