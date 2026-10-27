/**
 * 一人公司团队 —— **运行时层**：把 DSH 内置「智能体团队」(Agent Teams) 的机制搬进本产品的文件。
 *
 * 与 `company-gate.js`（制度层）的分工：本文件只管**谁在跑、怎么被叫起来、活怎么从板上到人手上**，
 * 所有文件读写都经 `runtimeBridge` 走那一份事务层（同一模块单例 ⇒ 同一文件只有一个写队列）。
 *
 * 对齐清单（内置 Agent Teams → 本插件，**语义对齐、名字自持**）：
 *   spawn_teammate        → member_spawn       具名、可续聊的成员；本产品多一个 `role`（现场枚举的角色之一）
 *   send_message          → member_send        持久邮箱 + 立即投递（运行中在最近步边界 steer，空闲即唤醒）
 *   list_agents           → member_list        名册 + 运行时状态（running / inactive / provisioning / failed）
 *   wait_agent            → member_wait        等下一次团队变化；没有在跑的人时立刻 noProgress
 *   team_task_*           → board_task         共享任务板（三态 + CAS 版本号 + 依赖门禁，见 company-gate.js）
 *   本产品独有的几个        → member_defaults / role_manage / team_status / human_words_* / check_artifact
 *
 * **本文件没有实现这三件**（别照旧注释去找）：`member_interrupt`（打断人）、成员空闲自动续领、
 * 冷恢复 —— 它们当年建立在本插件自建的邮箱 / 名册 / 文件看板之上，那半边已经删掉；成员的排队、
 * 唤醒与恢复由宿主原生那一层负责。
 *
 * 为什么名字不一样：内置那九个工具注册在**每个 agent 自己的作用域**（它的 `tryMembership` 把每个
 * 普通会话都判成 Lead），而作用域解析里「自己的层永远赢」；预设层的重名工具会被静默遮蔽，
 * 于是重名只会得到一个"看起来装了、其实没生效"的插件。所以本插件的工具自持一名，
 * 但**形状与语义逐条对齐**（`member_list` 的行形状就是 `list_agents` 的行形状）。
 *
 * 三条纪律（与内置同一条）：
 *   1. **生人与转派活只有协调者能做**（`member_spawn`；转派走 `board_task action=reassign`）——
 *      成员之间可以互相发消息、可以抢活，但不能凭空造人。
 *   2. **名字不重用**：成员名按 `<角色 id>-<序号>` 现算，已用过的号不再给下一位。
 *   3. **进程内保证**：重试 + 去重，never 跨进程 exactly-once；多进程同时操作同一团队不受支持。
 *
 * 装载形状由预设 `agent.cordis.yml` 的一行 `name: './team-runtime.js'` 决定；本文件与制度层同在
 * 预设目录下，因此能相对 import 兄弟模块（不 import 任何**包**）。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runtimeBridge as B } from './company-gate.js'

/**
 * **本插件自己的版本号**（读包内 `package.json` 的那一格）。
 *
 * 为什么要在启动日志里印它：升级是**人手动做**的（`pnpm install` / 同步文件），
 * 做完之后"到底升上去了没有"必须能一眼答出来 —— 从前那句装载日志只说角色数与成员提供方，
 * 升级前后长得一模一样，只能靠翻文件或看 `PANE_MARK` 去猜。
 * 读不到就如实印"读不到"，**不编一个版本号出来**。
 */
function pluginVersionOf() {
	try {
		const file = fileURLToPath(new URL('../package.json', import.meta.url))
		const parsed = JSON.parse(readFileSync(file, 'utf8'))
		const version = parsed !== null && typeof parsed === 'object' ? parsed.version : undefined
		return typeof version === 'string' && version !== '' ? version : '读不到'
	} catch {
		return '读不到'
	}
}

import * as NL from './native-layer.js'
import { skillScopeOf, skillViewOptions } from '../lib/skill-scope.js'
import { createSkill, skillIdFindings, skillRootOf, updateSkill } from '../lib/skill-write.js'
import { ROLE_SCOPES, roleIdFindings, roleRootOf, roleScopeLine, rosterRoots, workspaceRolesRoot, writeRoleDefinition } from '../lib/roster.js'
import { MEMBER_FLAGS_FILE, disableFindings, disabledNamesOf, emptyMemberFlags, readDisabledNames } from '../lib/member-flags.js'

/** 幂等闸：**同一个 ctx 只挂一次**（`WeakSet`；见 `apply` 顶部）。 */
const teamRuntimeMounted = new WeakSet()

export const inject = ['fs', 'tools', 'systemPrompt', 'subagents', 'agents']

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** 生成员用的默认提供方：`spawn`（不继承本会话历史）。`fork` 由 `context: 'fork'` 显式要。 */
const DEFAULT_MEMBER_PROVIDER = 'spawn'
/** `member_wait` 的时长边界与默认值（与内置一致：10 秒 ~ 1 小时，默认 30 秒）。 */
const WAIT_MIN_MS = 10_000
const WAIT_MAX_MS = 3_600_000
const WAIT_DEFAULT_MS = 30_000

/**
 * **「名册只增不减」那一句的唯一正文**（策略段与四个成员面工具的描述共用同一句 —— 两处各写一份迟早分叉，
 * 而"手抄的第二份"正是复核抓出来的）。来路是**人的一问**：「`probe-role-1` 成员为什么没有移除？
 * 按道理应该移除的。」
 *
 * 答案是**宿主没有这个能力**，不是我们漏接：`TeamService` 的公开方法只有 `spawnTeammate` /
 * `sendMessage` / 任务那一组加 `interrupt` / `recoverFor` 等；`removeTeammate` / `removeMember` /
 * `deleteMember` / `dropMember` 在宿主包里**全仓 0 命中**；工具面里含 teammate 的只有 `spawn_teammate`
 * 一个；成员状态只有 `provisioning` / `active` / `failed`（`…/dsh-experimental-agent-team/lib/index.js`
 * 的 `teamMemberSnapshotSchema.phase`）—— 没有"已移除"这一档。本插件当初删掉 `member_remove` /
 * `member_retire` / `member_touch` 三个工具也是因为这个。
 *
 * **导出是给自检用的**：自检拿它逐字比对各处的文本（手抄的第二份会因为措辞漂移当场露出来），
 * 再对源码里几个记号计数（只许常量里出现一次）。
 */
export const NO_REMOVAL_NOTE =
	'**原生名册只增不减**：宿主**没有移除成员的接口**（`removeTeammate` / `removeMember` / ' +
	'`deleteMember` / `dropMember` 0 命中；成员状态只有 `provisioning` / `active` / `failed`）—— 不用的队友不再派活即可；' +
	'**要一份干净的名册就开新会话**（队伍按会话，`TeamId = SessionId`）。'

/**
 * **默认队友清单里排掉的角色**（人的指令）：`ontology` 是本机那批上游规范材料的角色，**还没打磨好**。
 *
 * 本机现状（2026-10-11）：整份定义已按人的选择**归档到角色根之外**
 * （`~/.dsh/team-ops/_parked/ontology/`，含 `notes/`，另有一份 tar 备份在 `~/.dsh/team-ops/backups/`）
 * ⇒ **它已经不在名册里**（名册 20 → 19）。这一行仍留着，是因为**别的机器**的用户角色根里可能还有它 ——
 * 那里它照样不进默认货架、显式 `member_spawn role=ontology` 仍派得动。要请回来只需把目录移回 `roles/` 下。
 */
export const DEFAULT_ROSTER_EXCLUDED = ['ontology']

/** 运行时状态四档（与内置 `list_agents` 的状态枚举逐字相同）。 */
const RUNTIME_RUNNING = 'running'
const RUNTIME_INACTIVE = 'inactive'
const RUNTIME_PROVISIONING = 'provisioning'
const RUNTIME_FAILED = 'failed'
const RUNTIME_STATUSES = [RUNTIME_RUNNING, RUNTIME_INACTIVE, RUNTIME_PROVISIONING, RUNTIME_FAILED]

/** 协调者在自己会话里的名字（成员被这样告知）。 */
const LEAD_TARGET = 'lead'

// ── 角色名册（角色定位的**唯一载体**：现场枚举） ───────────────────────────────

/**
 * 一个角色目录的 front-matter 里认 `name` / `version` / `category`：只认单行 `key: value`，
 * 不引第三方 YAML（这些文件由本包与用户自己写，形状固定）；多行值退回空串，不猜。
 * @param text - `ROLE.md` 全文。
 * @returns 键值对象。
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

/**
 * **角色名册 = 现场枚举**：`roles/` 下**含 `ROLE.md` 的目录**，一个目录一个角色。
 *
 * 这是本插件里**唯一一处**定义"有哪些角色"的地方：`member_spawn` 的 `role` 参数按它校验，
 * 提示词段按它列出名册，团队基线的名册段由 `lib/roster.js` 从同一现场生成。
 * 于是**加一个角色 = 加一个目录**（`npm run role:new -- <id>`），删一个角色 = 删一个目录：
 * 不改这个文件、不改提示词、也不需要动基线。
 *
 * 两处细节：
 *   · **多个根一起看**（先列者胜）：用户级角色根（`$DSH_TEAM_OPS_ROLES`，或 `$DSH_HOME/team-ops/skills`）
 *     → 预设自带技能根。用户根因此**不出包也能加角色**，同名时以用户那份为准（与 DSH 预设根"前者胜"同一取向）。
 *   · 目录读不到、或没有 `ROLE.md` ⇒ 不进名册（**不抛**：名册读不到不该拦住整个插件装载）。
 * @param root - 显式技能根（测试 / 特殊部署用）；给了就**只用它**。
 * @returns 角色 id 升序数组。
 */
/**
 * **角色来源 → 面板上的筛档与卡片标**（一处正文）：`workspace` = 项目级 / `user` = 用户级 / `package` = 包内。
 * 面板照这份画 chip 与来源标，**不自己判**（这三轮反复栽在"同一处两个说法"上）。
 */
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
 * @param roots - `[{root, source}]`；缺省取 {@link roleRootRecords}。
 * @returns 记录数组（未排序；调用方按需排序）。
 */
export function roleRecords(roots) {
	const list = roots ?? roleRootRecords()
	const byId = new Map()
	for (const { root, source } of list) {
		let entries = []
		try {
			entries = readdirSync(root, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) continue
			if (byId.has(entry.name)) continue
			const dir = join(root, entry.name)
			// 角色定义只有一个形态：`roles/<id>/ROLE.md`。
			const file = join(dir, 'ROLE.md')
			if (!existsSync(file)) continue
			let text = ''
			try {
				text = readFileSync(file, 'utf8')
			} catch {
				continue
			}
			const meta = parseFrontMatter(text)
			// 名册里只有一类：**角色**。front-matter 的 `kind` 不参与分类（规则是 `team/BASELINE.md`，不在名册里）。
			const kind = 'role'
			byId.set(entry.name, {
				id: entry.name,
				kind,
				source,
				root,
				dir,
				file,
				title: titleOfSkillText(text) || entry.name,
				duty: dutyOfSkillText(text),
				when: whenOfSkillDescription(meta.description),
				category: typeof meta.category === 'string' && meta.category !== '' ? meta.category : ROLE_CATEGORY_BY_TONE[avatarToneOf(entry.name)] ?? '其他',
				version: typeof meta.version === 'string' ? meta.version : '',
				avatar: avatarOf(entry.name),
				avatarTone: avatarToneOf(entry.name),
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
			})
		}
	}
	return [...byId.values()]
}

/** 逗号分隔的一串名字（front-matter 里那种扁平写法）；空值给空数组。 */
export function commaListOf(value) {
	if (typeof value !== 'string' || value.trim() === '') return []
	return value
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item !== '')
}

/** 去掉 front-matter 的正文（角色定义注入系统提示时用它）。 */
export function withoutFrontMatter(text) {
	return String(text ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

/** 色调 → 分类的回落（角色没写 `category` 时用；写了就以它为准）。 */
export const ROLE_CATEGORY_BY_TONE = { eng: '研发', design: '设计', data: '数据', biz: '业务', ops: '运维', exec: '管理' }

/** 角色自定义头像的文件名（放角色目录里即可；卡片优先用它，没有再退回 emoji 圆底）。 */
export const AVATAR_FILE_NAMES = ['avatar.svg', 'avatar.png', 'avatar.webp', 'avatar.jpg', 'avatar.jpeg']

/**
 * 角色目录里有没有自定义头像文件。
 * @param dir - 角色目录绝对路径。
 * @returns 命中文件名，或 null。
 */
export function avatarFileIn(dir) {
	for (const name of AVATAR_FILE_NAMES) {
		try {
			if (statSync(join(dir, name)).isFile()) return name
		} catch {
			continue
		}
	}
	return null
}

/** `# 评审员（reviewer）` → `评审员`（没有括号就整行；找不到标题给空串）。 */
export function titleOfSkillText(text) {
	const line = /\r?\n#\s+(.+)/.exec(text)
	if (line === null) return ''
	return line[1].replace(/[（(][^）)]*[）)]\s*$/, '').trim()
}

/** 标题之后的**第一段正文**（空行分隔，压成一行，截到 160 字）—— 卡片上那句"一句话职责"。 */
export function dutyOfSkillText(text) {
	const after = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
	const body = after.replace(/^[\s\S]*?\r?\n#\s+.+\r?\n/, '')
	for (const block of body.split(/\r?\n\s*\r?\n/)) {
		const line = block.replace(/\s+/g, ' ').trim()
		if (line === '' || line.startsWith('#') || line.startsWith('---')) continue
		return line.length > 160 ? `${line.slice(0, 160)}…` : line
	}
	return ''
}

/** front-matter 的 `description` 去掉 `Use when ` 前缀（"什么时候派它"）。 */
export function whenOfSkillDescription(description) {
	if (typeof description !== 'string' || description === '') return ''
	return description.replace(/^Use when\s*/i, '').trim()
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

/**
 * 角色头像：**图标名 + 色调**，一处正文（面板的卡片、工具回执都读它，免得两处各画一套）。
 *
 * **值不再是 emoji，而是图标名**（人的指令：「emoji 头像能否改成不带色彩的开源图标」）：
 *   · 引擎这一处只给**名字**（`target` / `crown` / `cog` …），几何在浏览器那一半 —— 那是表现层的事，
 *     引擎不该内嵌 SVG 字符串（同一份名字还要给工具回执用，那里根本没有 SVG）。
 *   · 名表按 Lucide / Feather 那套 24×24 描边图标的命名与规范取的（**几何是照规范自己画的**，
 *     不是它们的原版路径 —— 本机取不到原版，所以不主张原样搬运；风格一致、且一律 `currentColor`）。
 *   · 色相由浏览器那一半的五档中性透明度给（面板里不许有颜色），所以图标只描边、不上色。
 *
 * 为什么按角色而不是按成员：同一角色的成员看起来该像"同一类人"，而自定义角色（用户自己
 * 加进 `roles/` 的）也必须有个**确定的**头像 —— 所以未收录的角色回落到通用图标（`user`），
 * 色调按 id 取模到一个固定的少数几档（同一 id 永远同一色，不随成员增减而变）。
 */
export const ROLE_AVATAR_ICONS = {
	ceo: 'crown',
	po: 'clipboard',
	analyst: 'trend',
	architect: 'landmark',
	'be-dev': 'cog',
	'fe-dev': 'browser',
	devops: 'terminal',
	security: 'shield',
	'ux-designer': 'pencil',
	'ai-algo': 'bot',
	'data-eng': 'database',
	ontology: 'network',
	reviewer: 'search',
	qa: 'flask',
	marketer: 'speaker',
	content: 'document',
	sales: 'dollar',
	cs: 'message',
	finance: 'coins',
	legal: 'scale',
}

/** 未收录角色回落到的那一个图标名（不是空白）。 */
export const AVATAR_ICON_FALLBACK = 'user'

/** 头像色调的档位（前端只认这几个类名）；未收录的角色按 id 稳定取一档。 */
export const AVATAR_TONES = ['eng', 'design', 'data', 'biz', 'ops', 'exec']
/** 已收录角色的色调归属。 */
const ROLE_TONES = {
	ceo: 'exec',
	po: 'biz',
	analyst: 'data',
	architect: 'eng',
	'be-dev': 'eng',
	'fe-dev': 'eng',
	devops: 'ops',
	security: 'ops',
	'ai-algo': 'data',
	'data-eng': 'data',
	ontology: 'data',
	qa: 'ops',
	reviewer: 'ops',
	'ux-designer': 'design',
	marketer: 'biz',
	content: 'design',
	sales: 'biz',
	cs: 'biz',
	finance: 'biz',
	legal: 'biz',
}

/**
 * 一个角色的头像图标名。
 * @param role - 角色 id（自定义角色也认）。
 * @returns 图标名（在浏览器那一半的 `AVATAR_ICONS` 里找几何）；未收录的回落 `user`。
 */
export function avatarOf(role) {
	const key = typeof role === 'string' ? role : ''
	return ROLE_AVATAR_ICONS[key] ?? AVATAR_ICON_FALLBACK
}

/**
 * 一个角色的头像色调：收录过的按归属，未收录的按 id 稳定取模（**同一 id 永远同一档**）。
 * @param role - 角色 id。
 * @returns `eng` / `design` / `data` / `biz` / `ops` / `exec` 之一。
 */
export function avatarToneOf(role) {
	const key = typeof role === 'string' ? role : ''
	if (ROLE_TONES[key] !== undefined) return ROLE_TONES[key]
	let hash = 0
	for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) % 1000003
	return AVATAR_TONES[hash % AVATAR_TONES.length]
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
 *   · 停用状态**只写进 `.company-gate.roles.json`**：`role_manage action=list` 与角色卡据此显示「已停用」；
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
 * `role_define` / `skill_define` 那一节与 `docs/team/verify/对话建角色与技能.md`）。角色卡片则一向是
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
//     只有包内那份的角色：**下架**（写工作区文件 `.company-gate.roster.json` 的 `hidden`，可恢复）——
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
function roleWriteEffects() {
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
 * 生成一份角色定义文本（「添加」用；「修改」只改其中那三格，见 {@link patchRoleText}）。
 *
 * 形态与包内角色一致（front-matter + `# 显示名（id）` + 定位段 + 可选正文），因为下游读的就是这几处：
 * `titleOfSkillText` 取标题、`dutyOfSkillText` 取标题后第一段当定位句、front-matter 给分类与触发语。
 * @param role - `{ id, title, category, positioning, body?, skills? }`（`skills` 逗号分隔；空/不给 ⇒ 不写那一行）。
 * @returns ROLE.md 全文。
 */
export function roleTextOf(role) {
	const id = String(role?.id ?? '').trim()
	const title = String(role?.title ?? '').trim() || id
	const category = String(role?.category ?? '').trim() || '其他'
	const positioning = String(role?.positioning ?? '').trim()
	const body = String(role?.body ?? '').trim()
	// front-matter 那句 `Use when …` 的正文：**给 `when` 就用它**（"什么时候该派它"），
	// 不给才回落到定位句（包内那些角色的写法）。两者混为一谈会丢信息：定位句讲"对什么负责"，
	// 触发语讲"什么时候叫它"，`role_define` 两个都要收。
	const when = String(role?.when ?? '').trim() || positioning
	// 角色**专属**技能（可空）：逗号分隔的名字列表。
	const exclusiveSkills = String(role?.skills ?? '')
		.split(',')
		.map((name) => name.trim())
		.filter((name) => name !== '')
	return [
		'---',
		'kind: role',
		`name: ${id}`,
		'version: 1.0.0',
		`category: ${category}`,
		`description: Use when ${when}`,
		// **不写 `skills:`**：那个字段是**角色专属技能**（角色自己那套作业程序，可多份、逗号分隔）——
		// 没有专属技能就不写这一行（写了等于把基线当成角色技能，2026-10 现场就是这么错的）。
		...(exclusiveSkills.length === 0 ? [] : [`skills: ${exclusiveSkills.join(', ')}`]),
		'---',
		'',
		`# ${title}（${id}）`,
		'',
		positioning,
		...(body === '' ? [] : ['', body]),
		'',
	].join('\n')
}

/**
 * 在**现有**角色定义文本上只改那三格（显示名 / 分类 / 定位句）—— 正文（检查表 / 落点 / 产物形态）
 * **一字不动**。
 *
 * 为什么不整份重写：包内角色的正文是它的作业程序（`qa` 的检查表、`devops` 的放行门禁…），
 * 用模板重写等于把它们冲掉 —— 那是"改个显示名，顺手删掉人家的检查表"。
 * 改动点只有四处：`category:` 行、`description:` 行、`# 标题（id）` 行、标题后第一段（定位句）。
 * 缺哪一处就补哪一处（新写进来的文件可能没有 category）。
 * @param text - 现有 ROLE.md 全文。
 * @param role - `{ id, title?, category?, positioning? }`（只改给出来的那几格）。
 * @returns 新的全文。
 */
export function patchRoleText(text, role) {
	const id = String(role?.id ?? '').trim()
	let out = String(text ?? '')
	const has = (value) => typeof value === 'string' && value.trim() !== ''
	// front-matter 里的两行：有就换、没有就补在第一行 `---` 之后。
	const setFrontMatter = (key, value) => {
		const line = `${key}: ${value}`
		const re = new RegExp(`^${key}:.*$`, 'm')
		if (re.test(out)) out = out.replace(re, line)
		else out = out.replace(/^---\r?\n/, (head) => `${head}${line}\n`)
	}
	if (has(role?.category)) setFrontMatter('category', String(role.category).trim())
	// **专属技能**：`role.skills` 给了才动这一行 —— 给了且非空则写，
	// 给了但是空的字符串则**删掉那一行**（"这个角色没有专属技能"）；不给（undefined）就一个字不碰。
	if (typeof role?.skills === 'string') {
		const names = role.skills
			.split(',')
			.map((name) => name.trim())
			.filter((name) => name !== '')
		const re = /^skills:.*\r?\n?/m
		if (names.length === 0) out = out.replace(re, '')
		else if (re.test(out)) out = out.replace(re, `skills: ${names.join(', ')}\n`)
		else {
			// 锚放在 **front-matter 的收尾 `---`** 上：不依赖任何一个具体键。
			// （从前锚在 `toolset:` 那一行上 —— 那一格随五格声明一起删了；锚在别的键上会随那个键的存废断掉。）
			const fm = /^---(\r?\n)([\s\S]*?)\r?\n---/
			out = fm.test(out)
				? out.replace(fm, (match, eol, body) => `---${eol}${body}${eol}skills: ${names.join(', ')}${eol}---`)
				: `---\nskills: ${names.join(', ')}\n---\n\n${out}`
		}
	}
	if (has(role?.positioning)) setFrontMatter('description', `Use when ${String(role.positioning).trim()}`)
	if (has(role?.title)) {
		const head = `# ${String(role.title).trim()}（${id}）`
		out = /^#\s.*$/m.test(out) ? out.replace(/^#\s.*$/m, head) : `${out.replace(/\s*$/, '\n\n')}${head}\n`
	}
	if (has(role?.positioning)) {
		// 定位段 = front-matter 之后、第一个标题之后、直到下一个空行或下一个标题的那一段。
		// 剥掉 front-matter 之后，正文**开头可能还有一个空行**（`---` 与标题之间那一个），
		// 所以标题那一行的匹配要容得下前导空白 —— 不容纳的话定位句会被插到标题前面去。
		const afterHead = out.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
		const headMatch = /^\s*#\s[^\n]*\r?\n/.exec(afterHead)
		const paraStart = headMatch === null ? 0 : headMatch[0].length
		const rest = afterHead.slice(paraStart)
		const paraEnd = (() => {
			const blank = rest.indexOf('\n\n')
			const nextHead = rest.search(/\n#/)
			const candidates = [blank, nextHead].filter((at) => at >= 0)
			return candidates.length === 0 ? rest.length : Math.min(...candidates)
		})()
		// 标题与定位段之间留一个空行（markdown 里那是两个块；贴在一起时渲染出来是同一段）。
		const headPart = afterHead.slice(0, paraStart).replace(/\s*$/, '')
		const replaced = (headPart === '' ? '' : headPart + '\n\n') + String(role.positioning).trim() + rest.slice(paraEnd)
		// 在**原文**里换掉那一段（front-matter 与其余正文都留着）：`afterHead` 是从 `out` 里剥掉
		// front-matter 之后的原文，所以这里必须 replace 回 `out`，不能把 `out` 换成剥掉的那一份
		// （那会把 front-matter 整段弄丢 —— 第一版就是这么错的）。
		out = out.replace(afterHead, replaced)
	}
	return out
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
	writeFileSync(file, roleTextOf({ id, title, category, positioning, body, skills }))
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
		writeFileSync(file, withSource)
	}
	const current = readFileSync(file, 'utf8')
	writeFileSync(file, patchRoleText(current, { id: role, title, category, positioning, ...(skillsProvided ? { skills: args.skills } : {}) }))
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

/** 下架 / 恢复：写工作区文件 `.company-gate.roster.json` 的 `hidden`（只读时不动它）。 */
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

// ── 邮箱域（纯判定） ─────────────────────────────────────────────────────────

/** 收件箱：发给某个成员的消息，按写入顺序（文件顺序即队列顺序）。 */
export function inboxOf(messages, target) {
	return messages.filter((message) => message?.to === target)
}

/**
 * **仍是当前代**的判定：消息带着 `taskId` + `attemptId` 时，只有任务当前凭据还对得上才算数。
 * 换人接手或重开之后，上一代的消息会变成陈旧邮件：**保留（审计），但不再唤醒任何人**。
 * 没有 `attemptId` 的消息（协调者给成员的自由消息）永远算当前代。
 */
export function isCurrentMail(message, tasks) {
	const attemptId = message?.attemptId
	if (typeof attemptId !== 'string' || attemptId === '') return true
	const taskId = message?.taskId
	if (typeof taskId !== 'string' || taskId === '') return true
	const task = (tasks ?? []).find((candidate) => candidate?.id === taskId)
	if (task === undefined) return false
	return B.taskAttemptIdOf(task) === attemptId
}

/**
 * 未读计数：**还没被读过**的消息（`readAt` 没写），丢弃的不算。
 *
 * 与"还没投出去"是两件事，这里刻意取更严的那个口径：
 *   · 投递被宿主接受（`deliveredAt`）只说明**目标的收件箱收下了**，不等于目标看过 ——
 *     收件人离线很久时，只按投递状态数会显示「未读 0」而其实有信在路上（现场最容易误读的一格）；
 *   · 真正让这个数落下去的是 `readAt`：目标会话里出现了这条消息（`session/event` 回执）
 *     或有人用 `member_inbox` 读走了它。
 * `tasks` 给了就**再排掉陈旧代**（换人接手/重开之后那条消息已经不唤醒任何人；
 * 把它继续算作未读，会让人以为收件人迟早会看到一条根本不会被投的信）。
 * `tasks === undefined`（调用方拿不到看板）时不判代 —— 保守，不猜。
 */
export function unreadCount(messages, tasks) {
	return messages.filter((message) => {
		if (message?.readAt !== undefined && message?.readAt !== null) return false
		if (message?.discardedAt !== undefined && message?.discardedAt !== null) return false
		if (tasks === undefined) return true
		return isCurrentMail(message, tasks)
	}).length
}

// ── 名册域（纯判定） ─────────────────────────────────────────────────────────

// ── 文件写入：名册与邮箱（都经制度层那一份事务层，同一文件只有一个写队列） ──────


// ── 名册写动作 ───────────────────────────────────────────────────────────────



// ── 邮箱写动作 ───────────────────────────────────────────────────────────────


// ── 对子代理的接缝（宿主能力的唯一使用处） ───────────────────────────────────

/**
 * 一个角色的**定位句**（只用这一句，不碰 ROLE.md 正文）：优先角色定义标题后那一段
 * （`duty`），没有就回落 front-matter 的 `description`（去掉 `Use when`）。
 *
 * **为什么单独抽出来**：默认队友清单、成员的职责默认值、面板上的那一行都印同一句 ——
 * 一处算、三处用，免得"清单上写的是 A、成员 persona 里写的是 B"。
 * @param role - {@link roleDefinitionOf} / {@link roleRecords} 的一条记录。
 * @returns 一句话定位；取不到给空串（调用方自己决定怎么如实说）。
 */
export function positioningOfRole(role) {
	const duty = typeof role?.duty === 'string' ? role.duty.trim() : ''
	if (duty !== '') return duty
	const when = typeof role?.when === 'string' ? role.when.trim() : ''
	return when
}

/**
 * **默认队友清单**：现场枚举 `roles/`（用户根优先）里除 {@link DEFAULT_ROSTER_EXCLUDED} 之外的
 * 每一个角色一条，**只带定位**（显示名 / 分类 / 一句话定位 / 定义文件路径 / 引用的技能）。
 *
 * 两条口径写死在这里：
 *   · **现场枚举，不留第二份**：清单不落文件、不写进包 —— 与角色名册同一处真相源，
 *     加一个角色目录它就多一条，删一个就少一条（`lib/roster.js` 与提示词段也读同一处）。
 *   · **只给定位，不搬 ROLE.md 文案**（人的指令）：20 份角色定义正文合计两万多字符，
 *     塞进清单或每个成员的系统提示都是白占，而且迟早与文件分叉。要正文本人自己去读 `file`。
 * @param root - 显式的角色根（测试用）；不给就按"用户根 → 包内根"。
 * @returns 按角色 id 升序的条目数组。
 */
export function defaultRosterOf(root, workspace) {
	const roots = root === undefined ? roleRootRecords(workspace) : [{ root, source: 'explicit' }]
	return roleRecords(roots)
		.filter((record) => record.kind === 'role' && !DEFAULT_ROSTER_EXCLUDED.includes(record.id))
		.map((record) => ({
			role: record.id,
			title: record.title,
			category: record.category,
			positioning: positioningOfRole(record),
			file: record.file,
			// **出处**（三种，面板据此决定给哪些动作）：
			//   · `workspace` = 本工作区的角色根那一份（**缺省落这里**；可改、可真删）；
			//   · `user` = 用户角色根那一份（所有工作区可见；可改、可真删）；
			//   · `package` = 随包发的那一份（发布面：改它等于在目标作用域写一份同名覆盖，删它等于"下架"）。
			origin: record.source === 'workspace' ? 'workspace' : record.source === 'user' ? 'user' : 'package',
			// 面板上那一枚来源标（与服务端给的筛档同一张表）
			originLabel: ROLE_ORIGIN_FACET_LABEL[record.source] ?? ROLE_ORIGIN_FACET_LABEL.package,
			skills: record.skills,
			// 头像与色调档：与成员卡上那个框**同一处判定**（引擎的 `avatarOf` / `avatarToneOf`），
			// 面板只负责印 —— 于是"可叫的人"与"已经到场的人"画的是同一套头像。
			avatar: record.avatar,
			avatarTone: record.avatarTone,
		}))
		.sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0))
}

/** 名册里已被占用的名字：在场的、归档的、退役的都算（退役的名字**永久占位**）。 */
function takenNamesOf(membersValue) {
	const taken = new Set()
	const collect = (list) => {
		if (!Array.isArray(list)) return
		for (const row of list) if (typeof row?.name === 'string' && row.name !== '') taken.add(row.name)
	}
	collect(membersValue?.members)
	collect(membersValue?.removed)
	return taken
}

/**
 * 一个角色**下一个可用的默认成员名**：`<角色 id>-<序号>`。
 *
 * 规则（与"名字永久占位、不复用"同一条）：把名册里（含 `removed` 留痕）形如 `<角色>-<n>` 的
 * 名字全读一遍，取**最大的 n + 1**，再跳过已被占用的号。于是"退役一个、再叫一个"拿到的是
 * 新号（老号永远指得回那个人），"删掉再叫"也不会撞上留痕里的号。
 * @param role - 角色 id。
 * @param membersValue - 名册文件的值（`{ members, removed }`）。
 * @returns 一个当前没被占用的名字。
 */
export function nextMemberNameFor(role, membersValue) {
	const taken = takenNamesOf(membersValue)
	const prefix = `${role}-`
	let max = 0
	for (const name of taken) {
		if (!name.startsWith(prefix)) continue
		const tail = name.slice(prefix.length)
		if (!/^\d+$/.test(tail)) continue
		const n = Number(tail)
		if (n > max) max = n
	}
	let n = max + 1
	while (taken.has(`${prefix}${n}`)) n += 1
	return `${prefix}${n}`
}

/**
 * 默认队友清单 + **当前编制状态**（把清单与名册 join 起来；面板与 `member_defaults` 读同一份）。
 *
 * 状态是**主读数**：在场 > 归档 > 退役 > 删过 > 未到场（一个人可能同时有"两个在场 + 一个退役"，
 * 所以四个名字数组都照给，主读数只回答"这一档现在叫得动谁"）。
 * `label` 是给人看的一句话（**读不到就说读不到**，不把"没有这一角色的记录"说成"零个成员"）。
 * @param entries - {@link defaultRosterOf} 的结果。
 * @param membersValue - 名册文件的值（`{ members, removed }`）。
 * @returns 每条带上 `state` / 四个名字数组 / `nextName` / `label`。
 */
export function defaultRosterView(entries, membersValue, hiddenRoles) {
	const hidden = Array.isArray(hiddenRoles) ? hiddenRoles.filter((id) => typeof id === 'string' && id !== '') : []
	const members = Array.isArray(membersValue?.members) ? membersValue.members : []
	const removed = Array.isArray(membersValue?.removed) ? membersValue.removed : []
	const namesIn = (list, role, status) =>
		list
			.filter((row) => {
				if (row?.role !== role) return false
				if (status !== undefined && row?.status !== status) return false
				// **创建失败不算"在场"**：失败的行是为了留痕才留在名册里（runtime=failed + 诊断），
				// 那个人从来没到场过 —— 算进去会让「在场 N / 告警线 4」报出一批不存在的成员（现场踩过）。
				if (status === B.MEMBER_PRESENT_STATUS && row?.runtime === RUNTIME_FAILED) return false
				return true
			})
			.map((row) => (typeof row?.name === 'string' && row.name !== '' ? row.name : '（无名）'))
	return (Array.isArray(entries) ? entries : []).map((entry) => {
		const present = namesIn(members, entry.role, B.MEMBER_PRESENT_STATUS)
		const archived = namesIn(members, entry.role, '归档')
		const retired = namesIn(members, entry.role, B.MEMBER_RETIRED_STATUS)
		const removedNames = namesIn(removed, entry.role)
		const state = present.length > 0 ? 'present' : archived.length > 0 ? 'archived' : retired.length > 0 ? 'retired' : removedNames.length > 0 ? 'removed' : 'vacant'
		const parts = []
		if (present.length > 0) parts.push(`在场 ${present.length}：${present.join('、')}`)
		if (archived.length > 0) parts.push(`归档 ${archived.length}：${archived.join('、')}`)
		if (retired.length > 0) parts.push(`退役 ${retired.length}（名字占位）：${retired.join('、')}`)
		if (removedNames.length > 0) parts.push(`删除过 ${removedNames.length}（名字可复用）：${removedNames.join('、')}`)
		const nextName = nextMemberNameFor(entry.role, membersValue)
		// `label` 是**这一档现在的样子**，不是一段操作指引：没有人在这一档时就是「未到场」三个字
		// （"可以叫一个：X"与"名字会自动取 X"是同一条规矩，**说一次就够** —— 面板写在那一节的收尾，
		// 每张卡各印一遍是把 20 张卡变成 20 遍同样的话）。下一个可用名照旧给在 `nextName` 里。
		const label = parts.length === 0 ? '未到场' : parts.join(' · ')
		// 「下架」是**清单这一栏**的事（不上货架 ≠ 角色没了、也 ≠ 停用）：照样给全每一格，
		// 只多一个 `hidden` 标记，由调用方决定是折起来还是过滤掉。
		const isHidden = hidden.includes(entry.role)
		// **删除那个动作会做什么**：三种，写在这里（客户端不许自己猜，也不许把三种说成一种）。
		//   delete = 用户根自己加的 ⇒ 真删那个目录；revert = 用户根那份在覆盖包内同名 ⇒ 删掉覆盖、回到包内那份；
		//   hide   = 只有包内那份 ⇒ 下架（可恢复）。
		// 工作区那份：真删（它只属于这个工作区）；用户根那份：覆盖包内同名 ⇒ `revert`，否则真删；
		// 只有包内那份 ⇒ `hide`（下架，发布面不能从面板上删）。
		const removal = entry.origin === 'workspace' ? 'delete' : entry.origin === 'user' ? (packagedRoleIds().includes(entry.role) ? 'revert' : 'delete') : 'hide'
		return { ...entry, state, present, archived, retired, removed: removedNames, nextName, label, hidden: isHidden, removal }
	})
}

/** 包内那份角色根里有哪些 id（判"用户根这份是不是在覆盖包内同名"）。 */
function packagedRoleIds() {
	const root = fileURLToPath(new URL('roles/', import.meta.url))
	return roleRecords([{ root, source: 'package' }])
		.filter((record) => record.kind === 'role')
		.map((record) => record.id)
}

/**
 * 取一个角色的定义（`roles/<id>/ROLE.md`；枚举顺序 **工作区根 > 用户根 > 包内**，同名高处赢）。
 * @param role - 角色 id。
 * @returns 记录（含 `body` 正文与 `skills`）。
 * @throws 角色不在现场名册里时抛出（错误里列出全部角色 id）。
 */
export function roleDefinitionOf(role) {
	const wanted = typeof role === 'string' ? role.trim() : ''
	const record = roleRecords().find((item) => item.id === wanted && item.kind === 'role')
	if (record === undefined) {
		throw new Error(`角色 "${wanted}" 不在角色名册里（枚举顺序：**工作区根 > 用户根 > 包内**）：现在是 ${roleRosterLine(roleCatalog())}。角色定义是 \`roles/<id>/ROLE.md\`（技能在 \`skills/\`，不是角色）。`)
	}
	return record
}

/**
 * 团队基线全文的**绝对路径**（按引擎自身位置算）。
 *
 * 它**不注册进技能表**（人的口径：都插件化了，不用再包一层技能）⇒ 成员与协调器照**路径直接读**。
 * 这份文件就是宪法全文：角色职责表、点名规矩、按需组建、记账与论据纪律、问人四问。
 */
export function baselinePath() {
	return fileURLToPath(new URL('BASELINE.md', import.meta.url))
}

/**
 * `team/BASELINE.md` 那一行「**版本**：X」里的 **X**（衍生值，不手写常量）。
 *
 * 为什么派生：注入策略段要带一行"这是哪一版纪律"的标记 —— 手写成字符串常量就等于**又一处要人记得同步的数字**
 * （插件版本已经在 `pluginVersionOf()` 里派生过一次，同一套判据）。**读不到就如实印"读不到"，不编一个版本号。**
 */
export function baselineVersionOf() {
	try {
		const text = readFileSync(baselinePath(), 'utf8')
		const matched = /\*\*版本\*\*：([0-9][0-9A-Za-z.\-]*)/.exec(text)
		return matched === null ? '读不到' : matched[1]
	} catch {
		return '读不到'
	}
}

/**
 * 成员的**身份段文本**：角色定位（显示名 / 分类 / 一句话职责）+ 角色定义**文件路径** + 协作纪律。
 *
 * **这条路径现在没有接线**：成员由原生 `spawnTeammate` 建，而它的 request 只有
 * `name` / `description` / `prompt` / `context` / `provider` / `signal` —— **没有 `persona` 字段**，
 * 所以成员拿到的身份段是 `native-layer.js` 的 `roleBrief()`（按路径写进首活提示词的那一段）。
 * 本函数保留下来是**同一段文字的参照实现**（自检拿它钉"技能那句不许读成『你没有技能可用』"），
 * 别再把它当成"成员的系统提示"来读。
 *
 * **只给定位，不搬角色定义正文**（人的指令）：两个理由 ——
 *   ① 20 份角色定义正文合计两万多字符，每个成员的系统提示里塞一份是白占（而且成员常常只要其中几段）；
 *   ② 正文一旦复制进 persona 就会**与文件分叉** —— 文件改了、冻在旧会话里的副本不会跟着改。
 * @param role - {@link roleDefinitionOf} 的结果。
 * @param options - `{ name, description, leadName }`。
 * @returns 身份段文本。
 */
export function rolePersonaOf(role, { name, description, leadName = LEAD_TARGET } = {}) {
	// **只印专属技能**（角色自己声明的那些）；基线不在其中 —— 它是团队规则，不是某个角色的技能。原注释：的技能"。
	const exclusive = (Array.isArray(role?.skills) ? role.skills : []).filter((name) => String(name ?? '').trim() !== '')
	// **基线按路径读**（它是一份文件，不是技能、也不写角色名单）：这一句给的就是绝对路径，
	// 成员用读文件的工具打开它。角色清单**只在现场**（`member_defaults` 现读 `team/roles/`）。
	const baseline = `\`${baselinePath()}\``
	// 这一行只说**归属**，**绝不能读成"你没有技能可用"**：技能池是按 agent 注入的（宿主 `agent/pre-step` 里
	// `ctx.tools.get(skillTool.name, agent) === skillTool` 就给整份目录），成员带着 `skill` 工具、也就带着那份目录。
	// 从前这里写「本角色**没有专属技能**」—— 一句真话，但读起来像"没技能可用"，于是技能池里的东西没人碰。
	const skillsLine =
		exclusive.length === 0
			? `- 本角色**没有常驻的专属技能**；但会话里那份技能目录（\`<available_skills>\`）照常可用 ——` +
				`任务对得上其中任何一项时，**动手之前先调 \`skill\` 载入它**，按它写的做法做（技能目录里那些不是可选参考）。` +
				`团队规则（点名规矩、按需组建、记账与论据纪律、问人四问、独立复核）读这个文件：${baseline}。`
			: `- 本角色常驻的作业程序：${exclusive.join('、')}。**做属于这些能力的事之前，先调 \`skill\` 把它们载入，按它写的做法做**` +
				`（这些是角色专属的作业程序，不是可选参考；读不到就如实说读不到，别凭印象编一套）。` +
				`会话里那份技能目录（\`<available_skills>\`）里的其他技能同样可以按需载入。团队规则读这个文件：${baseline}。`
	const positioning = positioningOfRole(role)
	const lines = [
		`你是一人公司团队的「${role?.title ?? role?.id}」角色成员（角色 id \`${role?.id}\`${role?.category === undefined || role.category === '' ? '' : `，分类 ${role.category}`}），团队里你的成员名是 "${name}"。`,
		positioning === '' ? '' : `你的角色定位：${positioning}`,
		description === undefined || description === '' ? '' : `本次交办给你的职责：${description}。`,
		'',
		'**你就是这个角色，不是在扮演它。你的作业程序在下面这个文件里 —— 动手前先读它**（身份、职责边界、检查表、落点、产物形态都在那儿；**文件是真相源**）：',
		`\`${role?.file ?? 'roles/<id>/ROLE.md'}\``,
		'读不到就**如实说读不到**、把这一条写进回报，**不要按印象编一份出来**（本段只给定位，不给正文，就是为了不让"编一份"变成好走的路）。',
		'',
		'## 协作纪律',
		'',
		`- 你只在自己的角色职责内下结论；跨角色的事回给协调者（\`member_send\` target "${leadName}"）转派，不替别的角色定案。`,
		'- 交付要落成文件（产物路径写进回报；任务说明写进看板条目的 `description`），关键事实可核；没核实的部分点名说没核实。',
		'- 共享任务板就是 DSH 原生那一本：`team_task_list` / `team_task_get` 读、`team_task_update` 收口（认领与收口都带 `expected_revision` —— 对不上就是有人先改过，重读再改）。',
		skillsLine,
	]
	// 空行是**段落分隔**（`## 协作纪律` 不能贴在上一条消息上）：只把连续空行收成一个，不整段删掉。
	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ── 提示词段：团队策略（遮蔽内置那条 `team:policy`） ───────────────────────────

/**
 * 团队策略段（`company:policy`，次序取宿主登记表里的 `TEAM_POLICY`）。
 *
 * **为什么不叫 `team:policy`（那个名字属于宿主内置的 Agent Teams）**：内置那一段注册在
 * **每个 agent 自己的作用域**里，而分段是按名解析、**离调用者最近的层赢** —— 预设层用同一个名字
 * 注册，会被内置那一段**静默遮蔽**（看起来装了、其实一个字都不生效）。同名同层还会直接抛
 * `prompt section "team:policy" is already registered`。
 *
 * 所以这里换一个名字，并把"本会话里团队协作只走本产品这套工具"写成**显式的禁令**
 * （正文里点名了内置那几个工具）：两个 profile 形态都成立 ——
 * 装了实验包时是"两段话 + 一条明确的取舍"，没装时这一段就是唯一的团队策略。
 */
export function teamPolicyText() {
	return [
		// **版本标记**（task-66）：两个值都是派生的 —— 基线版本读 `team/BASELINE.md` 那一行「版本」、插件版本读 `package.json`。
		`（本段与 \`team/BASELINE.md\` 同口径：基线 v${baselineVersionOf()} ｜ 插件 v${pluginVersionOf()}）`,
		'',
		'**这一段谁能看到、里面的"你"指谁**（宿主把它注册成全局：协调器与每个成员都会读到，所以先把称呼钉死）：',
		'**人** = 给这个团队下指令的人，**你** = 协调器（`lead`），**成员** = 你派出去的具名队友。',
		'**成员消解规则**：这一段的主体读者是**协调器**，若你是**被派活的成员**，下面每个"你"一律**读作"你的协调器（`lead`）"** —— 你的身份以首活消息里那段为准。',
		'',
		'**你的身份**：本会话的协调器（对人显示为 `lead`）。**层级三档**：**工作区 `AGENTS.md` > 本基线 > 角色 `ROLE.md`** —— 本基线是**默认宪法**，`AGENTS.md` **明确覆盖**某一处时以它为准（要点名条号）。'
			+ '**角色定义**在 `<角色根>/<id>/ROLE.md`（三个根：包内 / 工作区根 `<工作区>/.dsh/team-ops/roles/` / 用户根 `~/.dsh/team-ops/roles/`；**枚举顺序：工作区根 > 用户根 > 包内**）；'
			+ `现场枚举用 \`member_defaults\`；**团队规则全文**读 ${'`' + baselinePath() + '`'} —— 本段只给动作，不复述细则。`,
		'**协调器怎么干**：接收任务 → 判要不要拆 → 登记看板 → 按角色生成员并派活 → 校验收口。执行权归角色：被派为某角色时，就在该角色职责内把活干完、把关键事实落文件，并按 `board_task` 的版本号纪律收口（改状态带 `expected_revision`）。',
		'**装完打开就能开工（只对协调器）**：注入里若带【这是新工作区】那一段，**把它原样作为你的第一句话说给人**；成员跳过。',
		'**点名规矩（面板插进来的 `@角色名`）**：出现 `@<角色 id>` 就是**点名** —— 交给那个角色（`member_spawn role=<id>`，首活就是那段正文），**不要自己代劳**；出现多个 `@` ⇒ 各派一份（可并行）；已在场就投给它（`member_send`）。',
		'**按需组建（协调器自决，但必须记账）**：默认一个人干；三种情况可以叫人 —— ① 活能拆成**互不重叠的并行块**；② 需要**独立复核**；③ **单会话做不完**。叫人是**动作**不是仪式（`member_spawn role=<id>` 一步到位）。**人说别叫人就不叫**。'
			+ '（宿主内置那段更保守 —— **本预设以本段为准**。）',
		`**角色清单**：**现场枚举** —— \`member_defaults\` 给"能叫谁 + 现在有谁"；**定位句不进提示词**。`,
		'· **怎么叫一个人 / 加角色**：`member_spawn role=<id>`（`prompt` 省了就是「到场待命」）；不用的队友**不再派活**即可（**原生名册只增不减**）；加角色 = 在 `roles/` 下加含 `ROLE.md` 的目录（`npm run role:new -- <角色 id>`）。',
		'',
		'**团队工具**：',
		'· 编制：' + NO_REMOVAL_NOTE,
		'· **停用 / 恢复 / 打断**：**停用**在本插件生效、原生名册里仍在 —— **不占角色槽位**（同角色未停用且非 failed）、**照样占着在场总人数**（名册行数）、**不被自动复用**、`member_send` 会拒；**同一档至少留 1 位未停用**；**原生名册行只增不减**；**打断**只断当前那一轮。',
		'· `member_defaults`、`member_spawn`（**只给 role**；名字按 `<角色>-<序号>`；**同角色先复用**；到顶拒绝（**角色槽位 3 位** / **在场总人数 24 位**）；`line_reason` **只能越过插件的软上限（角色槽位 3 位），越不过宿主的硬上限（在场总人数 24）**）、`member_send`、`member_list`、`member_wait`。',
		'· `board_task`（登记 / 查询 / 认领 / 收口 / 改派 / 依赖 …；`submit` / `accept` / `reject` / `view` 原生没有，**会如实拒绝并指出该用哪一档**）。',
		'· 制度：`human_words_record` / `human_words_list`、`check_artifact`、`team_status`。**审批号 = 「人的话」里那一条 `HD-<三位序号>`**（`human_words_record` 的返回值；**协调器**答复后当场记录，格式 `/^HD-\d+$/`；**人答了但没记 ⇒ 当场记录再执行**）。',
		'· 能力沉淀：`role_define` / `skill_define`（技能与角色**缺省写本工作区**，显式 `scope: "user"` 才写全局；**枚举顺序：工作区根 > 用户根 > 包内**；**只有协调者能调**，成员要用就回报转派）。',
		'',
		'**规模判定（派活前先报一句规模）**：① **小任务** ⇒ 直接做；② **小改动**（说清改哪里）⇒ 直接做、不写设计文档；③ **需要书面设计** —— **手上没有已批规格**时，命中任一即③：**跨角色** / **跨轮** / **改口径** / **不可逆取舍** ⇒ **先出设计文档，人批准后才动手**。**「多个文件」只是信号，不单独触发 ③**。**规模在一单中途变大 ⇒ 立刻停下、报人、按新档位重走**。'
			+ '**判据的实质是"动手前要不要写一份给人看的东西"**：**已有一份被批准的规格** ⇒ **按它直接做**；**没有那份东西**、又命中任一条 ⇒ 先补规格。**派活与登记固定报三样**：**规模档** / **规格状态**（未批｜已批 —— 仅第③档适用，①② 档写"不适用"）/ **是否可丢弃原型**。',
		'**闸门与对称**：关键信息**已经给足** ⇒ **直接做**，不许再拿"要不要这样""是否确认"去消耗人；**人正式批准前不许启动开发**（不写业务代码 / 不建脚手架）—— 合法的只有**只看与探索**，以及**人明确同意、且标注为"可丢弃"的快速验证原型**。',
		'**提问形状**：**向人提问一律由协调器发出**（成员只交"问题包 / 决策包正文"）。**探索性** ⇒ **一条消息只留一个问题**、句尾一个问句、**不附示例清单**；**审批 / 确认清单** ⇒ 一条可多项，但**逐项编号、每项一个待确认句、每项给推荐**、**只此一轮**。用**对方的词**、不用流程黑话；问法 = 问题 + 依据 + 备选 + 一句话推荐。',
		'**复盘确认**：某一块理解到**能写成 200–300 字的程度**就把这段复述出来，**每一句都要么标「人确认」要么标「我方推测」**，结尾问"哪里错了、漏了什么"；**只有标「人确认」的才许当成已定的前提**。',
		'**边界（HD-009）**：**人没点名的界面**形状** / 控件**类型** / 参数含义（含改名与**改**默认值）不许动**；要改先问协调器。**没点名**的："顺手核一遍同类"**只许报告、不许自己动手**；人**已经指出来**的写法类则【同类一并处理】（基线 §八之二）。',
		'',
		'**协作纪律**：',
		'· 把写盘拆成互不重叠的范围，在看板条目上写 `write_scopes`（**写具体文件，别写目录**）。重叠**只是提示**（靠协调器盯最终 diff）。',
		'· **同一文件被两人改**：工具层有宿主 fs 的 **原子写 + 按文件串行 + 版本守卫**（被改过 ⇒ 拒，报 `FS_STALE_VERSION`）⇒ 正确动作是 **重读 → 把改动重建在新内容上 → 再试**（不要原样重写）；`edit` 还要求字面量唯一匹配。**`bash` / 脚本 / 格式化器没有这层守卫** ⇒ 那一半靠 `write_scopes`（**写具体文件**）、同一文件**串行派活**、**协调器看最终 diff 并跑测试**、git **显式列路径**。',
		'· **派活三件套（缺一就会"活干了卡没动"）**：**① `register`（建卡）→ ② `reassign`（带 owner）→ ③ `member_send`（把规格发给它）** —— 三步缺一不可：**只有 `reassign` 会把卡推进「进行中」**。**`board_task reassign` 只是记账，不等于叫它开工**。',
		'· **凡宣称状态，必带凭据**：说"已提交 / 已绿 / 已完成 / 已修好 / 已派"**必须附可复核凭据**（**命令 + 输出**，或路径 + 关键行 / 看板读数）且**带时间**；**写不出凭据 = 不许宣称**（"任务号 + `notified`"是特例）。',
		'· **同一事实不许两处并存**（要并存就配机械检查）：同一事实出现在**两处**（正文 / 派生 / 代码与文档 / 账与产物）⇒ **必须配一条机械检查**（断言 / 脚本 / 校验）；**写不出这条检查 ⇒ 二选一：删到只剩一处，或把其中一处改成从另一处派生**。**不许"两处都写、靠人同步"**。',
		'· **先调用、后总结**：任何"我派了 / 已派"这类说法**只许写在本回合的工具调用之后**，**不许用文字代替调用**；凡说"派了"必须带 **任务号 + `notified`**（回执里才有）—— **写不出这两个，就是没派**。**派活时 `reassign` 不能省**（它推进「进行中」并**自动按门铃**），`member_send` 补规格 ⇒ 漏发消息也不致空转。',
		'· **回报默认落看板，不落人**：成员回报后，**不需要人裁决的** ⇒ **不把人拉进来**（直接 `register` → `reassign` 落成看板条目；**不要转述成员的话**，给人最多一行「谁 · 任务号 · 状态」）；**只有需要人裁决的**才上人：**一条**消息、**逐项编号**、每项一个问题 + 一句推荐，说清卡在哪与建议；**不要把成员原文贴给人**。',
		'· **成员可以 `claim`**：只许认领协调器点名给它的那一条，且**在它还没被指派（无 owner）时**；**已被指派给别人的条目一律不许动**（认领会把归属记成自己）。收口 `complete` 同理。',
		'· 一条活干完就落文件 + 收口（`board_task action=complete` 带 `expected_revision`）。**打回 / 返工 = 开一条新任务并关联原任务号**（原任务**保持已完成**，`reopen` 只许用在它还没完成时）。',
		'· 等成员前先 `member_list` 确认有人在跑；没人在跑就 `member_send` 叫起来。消息（`member_send`）**持久**：**不要重发同一条**。',
		'· 结论前等齐所有必需的成员；**回报只放指针**（**回报的第一行就是那条指针**：产物路径 + 一句话），长内容落文件；**指针放在回报里，不写进产物**。',
		'',
		'对外输出按团队基线的默认层级走：精确地表达、不拖泥带水、不绕弯子；明细等人展开再给。',
	].join('\n')
}

// ── 工具实现 ─────────────────────────────────────────────────────────────────

/** `member_wait`：等一次原生队伍域的变化（不再等我们自己的 waiter）。 */
async function nativeWaitMember(ctx, exec, args) {
	const caller = exec?.agent
	// **缺省补在插件这一侧**：原生只收整数，`undefined` 原样递过去会得到一句
	// `timeoutMs must be an integer from 10000 through 3600000` —— 而工具描述承诺的缺省是
	// `WAIT_DEFAULT_MS`，这个承诺必须在这里兑现，不是在文档里。
	const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : WAIT_DEFAULT_MS
	// signal 同样必须透传：原生 `activity.wait` 第一句就是 `signal.throwIfAborted()`。
	const waited = await NL.waitForTeammates(ctx, caller, timeoutMs, exec?.signal)
	if (waited.ok !== true) return { ok: false, error: waited.reason }
	return { ok: true, change: waited.value }
}

// ── 成员面：全部走 DSH 原生 Agent Teams（薄层那一处按角色办事） ────────────────
//
// 为什么换：原生队伍的成员真源是会话日志里的 `team/member` 事件，只有 `spawnTeammate` 写它；
// 我们自建名册的那套在原生眼里是**影子成员**（原生名册永远只有 lead，任务板也永远是空的）。
// 成员创建与投递本来就是宿主领域，所以这里把四个动作转给薄层：
//   派活/叫人 → `spawnOrReuseTeammate`（**同角色先复用**：这一档有能接活的就把活派给它）
//   读名册   → `listTeammates`（就是内置 `list_agents` 那一处正文）
//   发消息   → `sendToTeammate`
//   等变化   → `waitForChange`

/** 角色定义 → 薄层要的那几样（取名靠 id、身份段靠路径）。 */
function roleBriefingOf(definition, role) {
	return {
		role,
		title: definition?.title,
		duty: definition?.positioning,
		roleFile: definition?.file,
		baselineFile: baselinePath(),
	}
}

/** 现场枚举出来的角色 id 列表（薄层按它认名字前缀）。 */
function roleIdsOf(rosterSource) {
	const known = typeof rosterSource?.catalog === 'function' ? rosterSource.catalog() : []
	return (Array.isArray(known) ? known : []).filter((id) => typeof id === 'string' && id !== '')
}

/** `member_spawn`：同角色先复用，没有再新建（两条硬上限在薄层里判：同角色位数 + 在场总人数）。 */
async function nativeSpawnMember(ctx, exec, args, rosterSource, config) {
	const caller = exec?.agent
	const role = B.requireText(args.role, 'role')
	const roleIds = roleIdsOf(rosterSource)
	// 名册为空时**不拦**（现场枚举不到就不假装"角色不存在"）：与旧那条路同一条宽松口径。
	if (roleIds.length > 0 && !roleIds.includes(role)) {
		throw new Error(`角色名册里没有 "${role}"：用 member_defaults 看现场枚举出来的角色（${roleIds.join(' / ')}）。`)
	}
	const records = typeof rosterSource?.roster === 'function' ? rosterSource.roster() : []
	const definition = (Array.isArray(records) ? records : []).find((item) => item?.role === role)
	const brief = { ...roleBriefingOf(definition, role), skills: definition?.skills }
	const task = typeof args.prompt === 'string' && args.prompt.trim() !== '' ? args.prompt.trim() : '到场待命：等你派活，先不要把工作区里的东西改起来。'
	const outcome = await NL.spawnOrReuseTeammate(ctx, caller, {
		...brief,
		roleIds,
		// **停用名单**：薄层据此算**角色槽位**、并跳过停用者做自动复用（HD-006）。
		disabledNames: readDisabledNames(B.workspaceRootOf(exec)),
		name: typeof args.name === 'string' && args.name !== '' ? args.name : undefined,
		// 描述取「显示名 + 定位句」。**记录里的字段是 `positioning`**（不是 `duty`）——
		// 从前这里读 `definition.duty` ⇒ 定位句恒为空，描述成了「评审员：」（冒号后面空着）。
		description:
			typeof args.description === 'string' && args.description !== ''
				? args.description
				: (definition?.positioning ?? '') === ''
					? String(definition?.title ?? role)
					: `${definition?.title ?? role}：${definition.positioning}`,
		prompt: task,
		context: args.context === 'fork' ? 'fork' : 'fresh',
		// **provider 必填**：原生队伍的成员记录里 `provider: requiredText(request.provider, "provider", 200)`
		// —— 省略它时宿主会拿 undefined 去 `.trim()` 并抛一句与现场无关的 TypeError（真机上就是这么恒失败的）。
		// 缺省取配置里那一档（与旧实现同一条：fresh → `memberProvider`）。
		provider:
			typeof args.provider === 'string' && args.provider !== ''
				? args.provider
				: config.memberProvider,
		lineReason: typeof args.line_reason === 'string' ? args.line_reason : undefined,
		reuse: args.reuse !== false,
		// 调用方的取消信号原样转给原生（它无条件解引用 `request.signal`）；拿不到就不带这个键。
		signal: exec?.signal,
	})
	if (outcome.ok !== true) return { ok: false, action: outcome.action, error: outcome.reason }
	if (outcome.action === 'reused') {
		// 复用 = 把活派给已经存在的那位（原生对空闲成员会唤醒/冷恢复）。
		// **装备那一行跟着消息再教一遍**：原生成员的提示词是出生时写进队伍日志的，没有"改成员"的接口 ⇒
		// 在补上这一行之前建出来的成员，身份段里没有它。每次派活带上，它们也能重新知道自己的装备
		// （以及"会话里那份技能目录也能按需载入"）。
		const content = `${NL.skillsLineOf(definition?.skills)}\n\n${task}`
		const sent = await NL.sendToTeammate(ctx, caller, { target: outcome.name, content, signal: exec?.signal })
		if (sent.ok !== true) return { ok: false, action: 'reuse-send-failed', error: `复用了 ${outcome.name}，但派活没送出去：${sent.reason}` }
	}
	// **派活时的技能核对（只警告不拦）**：把"成员动手那一刻才发现技能名载入不了"提前到派活这一刻。
	// 读法与 `role_define` 第 ③ 条**同一处**（下面那个 `skillCatalogOf`，作用域退法在 `lib/skill-scope.js`）。
	// 之所以是警告不是闸：这一档可能是**包内角色**（手写的 `skills:`，不该因为本机少装一个插件就派不出人），
	// 也可能只是想先把人叫起来 —— 拦下来会挡掉本来能干活的活。
	const declaredSkills = Array.isArray(definition?.skills) ? definition.skills : []
	let skillWarning = null
	if (declaredSkills.length > 0) {
		const catalog = await skillCatalogOf(ctx, exec)
		if (catalog.ok !== true) {
			skillWarning = `这一档声明了 ${declaredSkills.join('、')}，但**没能替你核对**它们在本机在不在：${catalog.reason}（读不到 ≠ 一个都没有 —— 别把它读成"技能不存在"）。`
		} else {
			const unknown = declaredSkills.filter((name) => !catalog.names.includes(name))
			if (unknown.length > 0) {
				skillWarning =
					`这一档声明的技能里，本机技能目录里没有：${unknown.join('、')}（读到的是 ${catalog.layer} 层）—— ` +
					'成员动手时调 `skill` 载入它们会失败。要么改角色定义的 `skills:` 那一行，要么在这台机器上装上提供它的插件；这次派活照常。'
			}
		}
	}
	return {
		ok: true,
		action: outcome.action,
		name: outcome.name,
		voice: outcome.action === 'reused'
			? `没有新建：这一档已经有 ${outcome.name}（原生名册里读到的），活已经派给它 —— 复用不付冷启动，它上下文里还有这个工作区的来龙去脉。`
			: `新建了一位原生队友 ${outcome.name}（角色 ${role}）。`,
		...(outcome.action === 'reused' ? {} : { row: outcome.row }),
		...(skillWarning === null ? {} : { warnings: [skillWarning] }),
	}
}

/** `member_list`：直接读原生名册（与内置 `list_agents` 同源），角色按名字约定反读；`status` 是**真的过滤**。 */
async function nativeListMembers(ctx, exec, args, rosterSource) {
	const caller = exec?.agent
	const listed = await NL.listTeammates(ctx, caller)
	if (listed.ok !== true) return { ok: false, error: listed.reason }
	// 枚举外的取值给一句可读的说明，而不是安静地回一份没过滤的表。
	const wantStatus = B.optionalText(args.status, 'status')
	if (wantStatus !== undefined && !RUNTIME_STATUSES.includes(wantStatus)) {
		return {
			ok: false,
			error: `status 只认这几个取值：${RUNTIME_STATUSES.join(' / ')}（收到 ${JSON.stringify(wantStatus)}）。原生名册**只增不减**（宿主没有移除接口；没有"已移除"这一档），所以本工具也没有对应的过滤器。`,
		}
	}
	const roleIds = roleIdsOf(rosterSource)
	// **停用标注**（HD-006）：停用的成员在原生名册里**仍然在**，所以这一格是"本插件的视图状态"，
	// 名字就叫 `disabled`，回执里同时给一句 `disabledNote`（免得读的人以为原生有"停用"这回事）。
	// **判定条件（可当场核）**：凡出现"停用"的地方，**必须同时说明**它**只在本插件生效**、**宿主原生界面里仍可对话** ——
	// `grep -rn "不再接活" team/ lib/ README.md` 应当 **0 命中**（一律换成上面那种完整句）。
	const disabled = readDisabledNames(B.workspaceRootOf(exec))
	const rows = listed.rows.map((row) => {
		const role = row.role === 'lead' ? 'lead' : NL.roleOfName(row.name, roleIds)
		return {
			...row,
			roleId: role === 'lead' ? '' : role,
			...(disabled.includes(row.name) ? { disabled: true, disabledNote: '本插件已把它标成停用：**本插件不再派活给它**（不占角色槽位、不被自动复用、`member_send` 会拒）；**它在宿主原生界面里仍然可以打开对话**；面板上可恢复' } : {}),
			...(role === '' ? { note: '名字不符合 <角色 id>-<序号> 约定：读不出角色，不猜' } : {}),
		}
	})
	const filtered = wantStatus === undefined ? rows : rows.filter((row) => row.status === wantStatus)
	return {
		ok: true,
		count: filtered.length,
		rows: filtered,
		source: 'DSH 原生 Agent Teams 名册（`ctx.agentTeams.listMembers`）',
		...(wantStatus === undefined ? {} : { filteredBy: { status: wantStatus } }),
	}
}

/** `member_send`：原生的持久点对点消息 + 立即投递尝试。 */
async function nativeSendMember(ctx, exec, args) {
	const caller = exec?.agent
	const target = B.requireText(args.target, 'target')
	const message = B.requireText(args.message, 'message')
	// **停用者不收活**（HD-006）：拒并指路（先恢复再派活）。它是本插件这一层的状态，
	// 不是原生拒绝 —— 所以措辞里要把这件事说清，别让人以为是宿主的问题。
	const disabled = readDisabledNames(B.workspaceRootOf(exec))
	if (disabled.includes(target)) {
		return {
			ok: false,
			error: `「${target}」已被**停用**（本插件的视图状态）：**本插件不再派活给它**（不占角色槽位、不被自动复用）；**它在宿主原生界面里仍然可以打开对话** —— 「停用」只在本插件的调度层生效，不是把这个人从原生名册里拿掉。先恢复再派活：面板「成员」那一张卡上的「恢复」，或 POST \`/company-board/api/members/restore\`。`,
		}
	}
	const sent = await NL.sendToTeammate(ctx, caller, { target, content: message, signal: exec?.signal })
	if (sent.ok !== true) return { ok: false, error: sent.reason }
	return { ok: true, to: target, outcome: sent.outcome }
}

/**
 * **停用 / 恢复一位成员**（HD-006 的写入口：面板那三个动词里的前两个，也供会话工具日后复用）。
 *
 * 语义（四条，判定全在下面与 `lib/member-flags.js`）：
 *   · 停用者**不占**同角色 ≤3 的**角色槽位**（`team/native-layer.js` 的 `teammatesOfRole` 是那一处正文）；
 *   · 停用后**同角色至少留 1 位**未停用（`disableFindings`）；
 *   · **自动复用跳过**停用者、**`member_send` 给停用者拒绝**（各自那里判）；
 *   · **恢复不设任何上限**。
 * **如实说**：停用的成员在**原生名册里仍然在**（宿主没有移除接口）—— 这是本插件这一层的视图状态，
 * 落在工作区的 `.company-gate.member-flags.json`（复用既有账本管道），回执里带 `note` 那句原话。
 * @param ctx - 上下文。
 * @param exec - 调用方（面板给 `exec.workspace`）。
 * @param args - `{ name, disabled }`。
 * @returns `{ name, disabled, disabledNames, file, note }`。
 */
export async function setMemberDisabled(ctx, exec, args) {
	const name = B.requireText(args.name, 'name')
	if (typeof args.disabled !== 'boolean') throw new Error(`disabled 必须是布尔值，收到 ${JSON.stringify(args.disabled)}。`)
	const roleIds = roleCatalog(undefined, B.workspaceRootOf(exec))
	// **凭据：本会话的 Lead**（`exec.lead`，宿主那条端点路负责解析好传进来）。
	// 为什么**不读 `exec.agent`**：这条路从 HTTP 端点可达，而那条路上 `exec.agent` 是 `undefined`
	// ⇒ 宿主 `listMembers(undefined)` 去读 `undefined.id`，人看到的是 `Cannot read properties of
	// undefined (reading 'id')`（现场就是这样崩的）。缺凭据时给一句能照做的，不把内层 TypeError 漏出去。
	const caller = exec?.lead
	if (caller === undefined || caller === null) {
		throw new Error(
			'停用/恢复要"**本会话的 Lead**"这个凭据（宿主那条端点路负责解析它并放进 `exec.lead`）—— 没有它读不到原生名册。',
		)
	}
	const members = await NL.listTeammates(ctx, caller)
	if (members.ok !== true) throw new Error(`读不到原生名册，停用/恢复无从判定：${members.reason}`)
	const rows = Array.isArray(members.rows) ? members.rows : []
	if (!rows.some((row) => row?.name === name)) {
		const names = rows.filter((row) => row?.role !== 'lead').map((row) => row.name)
		throw new Error(`原生名册里没有「${name}」：这一档现在有的人是 ${names.length === 0 ? '（一个都没有）' : names.join('、')}。停用只能针对真实存在的成员。`)
	}
	const workspace = B.workspaceRootOf(exec)
	const absPath = B.ledgerPath(workspace, B.LEDGER_FILE.memberFlags)
	const already = readDisabledNames(workspace)
	// **停用前必须过"至少留 1 位"那道**（恢复不受限）。
	if (args.disabled === true && !already.includes(name)) {
		const finding = disableFindings({
			name,
			members: rows,
			disabledNames: already,
			roleOfName: (value) => NL.roleOfName(value, roleIds),
		})
		if (finding !== null) throw new Error(finding)
	}
	const outcome = await B.transact(ctx, absPath, exec, async () => {
		const snapshot = await B.readLedger(ctx, absPath, exec)
		const value = snapshot.kind === 'absent' ? emptyMemberFlags() : snapshot.value
		const current = disabledNamesOf(value)
		const next = args.disabled ? (current.includes(name) ? current : [...current, name]) : current.filter((item) => item !== name)
		const nextValue = {
			...value,
			version: B.LEDGER_VERSION,
			seq: Number.isInteger(value.seq) ? value.seq + 1 : 1,
			writer: B.writerStamp(),
			note: emptyMemberFlags().note,
			disabled: next,
			updated_at: new Date().toISOString(),
		}
		// 必须真落盘：`transact` 只串行 + CAS，写回得自己调 `commitLedger`（漏了就是"回执说成功、盘上什么都没有"）。
		await B.commitLedger(ctx, absPath, snapshot, nextValue, exec)
		return { disabledNames: next, changed: next.length !== current.length, warnings: B.foreignWriterWarnings(value) }
	})
	return {
		name,
		disabled: args.disabled,
		disabledNames: outcome.disabledNames,
		changed: outcome.changed === true,
		file: absPath,
		fileNote: MEMBER_FLAGS_FILE + '：本插件的视图状态（不是原生名册）',
		warnings: outcome.warnings ?? [],
	}
}

/**
 * **删掉一个技能之后，把它从受影响角色的 `skills:` 行里剪掉**（HD-007 的第二件）。
 *
 * 两条边界（写死在判定里，不靠调用方记得）：
 *   · **用户根角色**（`~/.dsh/team-ops/roles/…`）：直接剪 —— 走同一个 `patchRoleText`（只动那一行，正文一字不动）
 *     与 `writeRoleDefinition`（留 `.bak` + 原子替换）；
 *   · **包内角色**：**只读，绝不改发布面** —— 只在回执里**点名列出**，并提示"面板「改」一份到用户根就能去掉"。
 *
 * **绝不按"本会话目录里没有"来删**（人点的坑，写进验收）：技能目录**按会话变**，拿"此刻读不到"当"删掉了"
 * 会在别的会话里剪掉本来有用的声明。所以这个函数只由**人主动删技能**这个动作调用，参数就是要删的名字。
 * @param ctx - 上下文。
 * @param exec - `{ workspace }`（用不上原生，只为与其余写入口同形）。
 * @param name - 被删掉的技能名。
 * @returns `{ changed, packageRoles, scanned }`：改了哪些用户根角色、哪些包内角色仍声明它、扫了几个角色。
 */
export async function pruneSkillFromRoles(ctx, exec, name) {
	const wanted = B.requireText(name, 'name')
	// **三个根都扫**（工作区 / 用户 / 包内）：工作区与用户那两份能被剪，包内那份只进名单。
	const records = roleRecordsFor(B.workspaceRootOf(exec))
	const changed = []
	const packageRoles = []
	for (const record of records) {
		const skills = Array.isArray(record.skills) ? record.skills : []
		if (!skills.includes(wanted)) continue
		if (record.source !== 'user' && record.source !== 'workspace') {
			packageRoles.push({ role: record.id, file: record.file })
			continue
		}
		const current = readFileSync(record.file, 'utf8')
		const next = patchRoleText(current, { id: record.id, skills: skills.filter((skill) => skill !== wanted).join(', ') })
		if (next === current) continue
		writeRoleDefinition(record.id, next, { root: record.root, mode: 'update' })
		// **带上真实来源**：回执要按来源说"哪个根"（工作区根 / 用户根）—— 从前那一层把两种都叫"用户根"，
		// 现场就报错过一次（工作区根里的角色被说成了用户根）。判定就在这条记录上，不另算一份。
		changed.push({ role: record.id, file: record.file, source: record.source })
	}
	return { changed, packageRoles, scanned: records.length }
}

/** `member_defaults`：能叫谁（现场枚举的角色）+ **这一档现在有谁**（原生名册）。 */
async function nativeDefaults(ctx, exec, rosterSource) {
	const roleIds = roleIdsOf(rosterSource)
	const records = typeof rosterSource?.roster === 'function' ? rosterSource.roster() : []
	const staffing = await NL.roleStaffing(ctx, exec?.agent, roleIds, readDisabledNames(B.workspaceRootOf(exec)))
	const rows = (Array.isArray(records) ? records : []).map((record) => {
		const teammates = staffing.ok === true ? (staffing.byRole.get(record.role) ?? []) : []
		return {
			role: record.role,
			title: record.title,
			category: record.category,
			positioning: record.positioning,
			file: record.file,
			teammates,
			note: teammates.length > 0 ? '这一档已经有成员：先派给它们（member_send），别再新建' : '这一档还没有成员',
		}
	})
	return {
		ok: true,
		count: rows.length,
		rows,
		source: staffing.ok === true ? 'DSH 原生 Agent Teams 名册（`ctx.agentTeams.listMembers`）' : `读不到原生名册：${staffing.reason}`,
	}
}

// ── 对话建角色 / 建技能（能力沉淀） ──────────────────────────────────────────
//
// 人的口径（2026-10）：「能力沉淀，不用每次都临时生成」。在这两个工具之前，"通过对话加角色"
// 是协调者拿 Bash + Write 做**文件手术**：没有校验、没有门禁、没有备份，写工作区外还要逐次授权；
// 技能侧同理（面板有导入/新建，但 agent 手上没有工具）。
//
// 这两个工具把同一件事变成**插件的能力**，流程固定五步：**校验 → 组装入参 → 走既有写入层 →
// 回读 → 回执**。原则只有一条：**不另造一条写路径** —— 角色经 `lib/roster.js` 的
// `writeRoleDefinition`（`writeRoleScaffold` 也走它），技能经 `lib/skill-write.js` 的
// `createSkill` / `updateSkill`（real-path 越界防护在那边）。这一层只做校验、组装与回执。
//
// 两个都是**协调器专属**：判据的唯一正文是 `company-gate.js` 的 `coordinatorCheckOf`（与角色
// 清单/人的话同一道门），成员要用就回报给协调者转派。它们**不派活、不改看板、不碰别人的角色/技能**。


/**
 * `role_define` 的边界声明（**两个作用域**；逐字点名它真写的那一份文件）。
 *
 * 从前这句写的是"只写**工作区之外**的用户级角色根" —— 角色加了作用域之后它**写反了**（缺省落**工作区内**）。
 */
const WRITE_BOUNDARY_ROLE_DEFINE =
	'边界：只写**角色根**里的一份 `roles/<id>/ROLE.md` —— **缺省写本工作区的角色根**（`<工作区>/.dsh/team-ops/roles/`，' +
	'只影响这个工作区）；**显式 `scope: "user"` 才写全局用户根**（`$DSH_TEAM_OPS_ROLES`，缺省 `~/.dsh/team-ops/roles/`，**所有工作区可见**）。' +
	'同名已存在时必须显式 `mode: update`，覆盖前留一份 `ROLE.md.bak`。**不派活、不改看板、不改别人的角色或技能**；' +
	'除上面那一份角色文件之外不写别的文件（工作区里只写 `.dsh/team-ops/roles/` 这一处），不删文件，不移动文件。' +
	'写盘后**工具面立刻可用**：`member_defaults` / `member_spawn` 是现枚举这份名册的（本机现场验过：建完立刻列出它、立刻派得出人，成员的装备也对）；' +
	'**只有注入到系统提示里那份「可叫的队友」清单是装载时的快照，要重启 DSH 才更新** —— 那一条不影响能不能叫人。'

/** `skill_define` 的边界声明（**两个作用域**）。 */
const WRITE_BOUNDARY_SKILL_DEFINE =
	'边界：只写**技能根**里的一份 `<name>/SKILL.md` —— **缺省写本工作区的技能根**（`<工作区>/.dsh/skills/`，' +
	'只影响这个工作区）；**显式 `scope: "user"` 才写全局用户根**（`$DSH_HOME/skills/`，缺省 `~/.dsh/skills/`，**所有工作区可见**）。' +
	'同名已存在时必须显式 `mode: update`，覆盖前留一份 `SKILL.md.bak`。**不派活、不改看板、不改别人的角色或技能**；' +
	'除上面那一份技能文件之外不写别的文件（工作区里只写 `.dsh/skills/` 这一处），不删文件，不移动文件；' +
	'**不解压、不导入**（那两条是面板「技能」块的路）。' +
	'技能目录**按变更即时刷新**：写盘后**下一次提示词**就会带上它（本机现场验过两遍：建了立刻出现、删了立刻消失）—— 不需要重启。'

/** 一串条目：数组直接用，字符串按换行拆；空项剔掉。 */
function lineListOf(value) {
	const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : []
	return raw.map((item) => String(item ?? '').trim()).filter((item) => item !== '')
}

/** 名字列表：数组，或逗号/换行分隔的字符串（front-matter 里 `skills:` 就是逗号那种写法）。 */
function nameListOf(value) {
	const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\r\n]/) : []
	return raw.map((item) => String(item ?? '').trim()).filter((item) => item !== '')
}

/** 角色正文的三段（检查表 / 落点 / 边界）：形状与包内角色一致，`role_define` 组装用。 */
function roleBodyOf({ checklist, deliverables, scope }) {
	const block = (title, lines, bullet) => [`## ${title}`, '', ...lines.map((line) => `${bullet}${line}`), ''].join('\n')
	return [block('检查表', checklist, '- [ ] '), block('落点（产出与落盘）', deliverables, '- '), block('边界（明确不做什么）', scope, '- ')].join('\n')
}

/**
 * **技能目录的现读**（与面板「技能」栏**同一条读法**，不许另写一份）。
 *
 * 口径：`ctx.get('skills').snapshot(skillViewOptions(工作区, skillScopeOf(ctx, 会话 id)))` ——
 * 作用域那条退法（session → root-agent → global）的唯一正文在 `lib/skill-scope.js`。
 * 读不到要说**读不到**，不许说成"一个技能都没有"（那会让人以为技能名真的不存在）。
 * @returns `{ ok: true, names, layer, why }` 或 `{ ok: false, reason }`。
 */
async function skillCatalogOf(ctx, exec) {
	const service = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
	if (service === undefined || service === null || typeof service.snapshot !== 'function') {
		return { ok: false, reason: '这个部署没有技能注册表（`ctx.get(\'skills\')` 取不到）—— **读不到 ≠ 一个技能都没有**，技能名没法核对，这次不写。修法：确认该 profile 里装了 `@deepseek-ai/dsh-skill` 与 `@deepseek-ai/dsh-skill-filesystem`。' }
	}
	const view = skillScopeOf(ctx, exec?.agent?.id)
	try {
		const snapshot = await service.snapshot(skillViewOptions(B.workspaceRootOf(exec), view))
		const names = (Array.isArray(snapshot?.skills) ? snapshot.skills : [])
			.map((item) => String(item?.name ?? '').trim())
			.filter((name) => name !== '')
		return { ok: true, names, layer: view.layer, why: view.why }
	} catch (error) {
		return { ok: false, reason: `读技能目录失败：${error instanceof Error ? error.message : String(error)}` }
	}
}

/** 技能名核对：不在目录里的逐个点名 + 列出可选（这一条把"名字写错"提前到定义这一刻）。 */
function skillUnknownOf(names, catalog) {
	const unknown = names.filter((name) => !catalog.names.includes(name))
	if (unknown.length === 0) return null
	const options = catalog.names.slice(0, 20)
	return (
		`这些技能名不在本机技能目录里：${unknown.join('、')}。` +
		`目录里现在有（最多列 20 个）：${options.length === 0 ? '（空）' : options.join('、')} —— ` +
		'技能目录是**按会话作用域现读**的（这一层读到的是 ' + catalog.layer + '），要写就写 `available_skills` 里出现的名字。'
	)
}

/**
 * `role_define`：把一段对话里定下来的角色**沉淀成一份角色定义**。
 *
 * 五条校验（每条都能当场拒，并给出可照做的原文）：① id 形状；② 重名必须 `mode: update` 并点明改哪一份；
 * ③ `skills` 里每个名字必须真在本机技能目录里（读法与面板同一处）；④ 四段（positioning / scope /
 * checklist / deliverables）缺一段就拒；⑤ 写盘后回读（front-matter 可解析、`kind: role`、
 * `roleCatalog()` 枚举得到、`member_defaults` 里有它、这一档现在有没有成员）。
 */
async function roleDefine(ctx, exec, args) {
	const identity = B.coordinatorCheckOf(ctx, exec?.agent, {
		tool: 'role_define',
		why: '角色定义是团队的能力沉淀；它会写进角色根（缺省是本工作区的那个根，显式 user 才是全局根）',
	})
	if (identity.ok !== true) return { ok: false, error: identity.reason }

	// ① id：**判定只有一处** —— 形状与长度都在写入层（`lib/roster.js` 的 `roleIdFindings`，
	// 面板与 CLI 那两个入口也走它）。这一层**不自己判**，只把结论渲染成回执：多留一份判定，
	// 两个入口就会各自漂一个样（上一批复核抽掉这里那道守卫时，冒出来的正是写入层那句 —— 分得清是谁拒的，
	// 靠的只是措辞不同，那不算"只有一处"）。
	const idFindings = roleIdFindings(args?.id)
	const id = String(args?.id ?? '').trim()
	if (idFindings.length > 0) {
		return {
			ok: false,
			error: `角色 id 不合法：${idFindings.join('；')}。id 会变成目录名与队友名前缀 \`<id>-<序号>\`，取一个能念出来的短名字。`,
		}
	}
	const mode = args?.mode === undefined || args?.mode === 'create' ? 'create' : args?.mode === 'update' ? 'update' : null
	if (mode === null) return { ok: false, error: `mode 只能是 create（新建）/ update（覆盖），收到 ${JSON.stringify(args?.mode)}。` }

	// **作用域**（HD-008 的同一判据，落到角色上）：缺省 `workspace`（落本工作区的角色根，
	// **只有这个工作区看得见**）；`user` 必须显式（落用户根，**所有工作区都看得见**）。
	const workspace = B.workspaceRootOf(exec)
	// `scope` 只认字符串（数组在更前面已经**明确拒**并指路 `boundaries`）。
	const rawScope = typeof args?.scope === 'string' ? args.scope : undefined
	const scope = rawScope === undefined || rawScope === 'workspace' ? 'workspace' : rawScope === 'user' ? 'user' : null
	if (scope === null) {
		return { ok: false, error: `scope 只能是 workspace（本工作区，缺省）/ user（全局，影响所有工作区），收到 ${JSON.stringify(args?.scope)}。` }
	}
	const target = roleRootOf(scope, workspace)
	if (target === null) {
		return {
			ok: false,
			error:
				scope === 'workspace'
					? '工作区取不到：`scope: workspace`（缺省）要往本工作区的角色根写，而这次调用没带工作区。'
					: '作用域不认（只支持 workspace / user）。',
		}
	}

	// ② 重名：**按作用域判**（两个作用域互不覆盖 ⇒ 同名各有一份是正常的）。
	//   · 落点那个根里已经有了 ⇒ `create` 拒、必须显式 `update`；
	//   · 落点那个根里没有（哪怕别的根有同名）⇒ `update` 拒（要改的是哪一份，说清）。
	const sameRoot = roleRecords([{ root: target.root, source: scope }]).find((record) => record.id === id)
	const shadowed = roleRecordsFor(workspace).find((record) => record.id === id && record.source !== scope)
	const rootWord = scope === 'user' ? '用户角色根' : '本工作区的角色根'
	if (mode === 'create' && sameRoot !== undefined) {
		return {
			ok: false,
			error:
				`角色 "${id}" 已经在${rootWord}里：${sameRoot.file} —— ` +
				'要改它请带 `mode: update`（原文件留 `.bak`），不许静默覆盖。' +
				(shadowed === undefined ? '' : `（同名的那一份在 ${ROLE_SOURCE_LABEL[shadowed.source] ?? shadowed.source}，它不受这次写入影响。）`),
		}
	}
	if (mode === 'update' && sameRoot === undefined) {
		return {
			ok: false,
			error:
				`角色 "${id}" 不在${rootWord}里（${target.root}）—— 新建请带 \`mode: create\`；` +
				(shadowed === undefined
					? `现场名册里也没有它（枚举顺序：**工作区根 → 用户根 → 包内根**）：现在是 ${roleRosterLine(roleCatalog(undefined, workspace))}。`
					: `你要改的可能是另一份：它现在在 ${ROLE_SOURCE_LABEL[shadowed.source] ?? shadowed.source} ${shadowed.file} —— 带上对应的 \`scope\` 再试。`),
		}
	}

	// ④ 四段必备齐（缺哪段就点名哪段）
	const positioning = B.optionalText(args?.positioning, 'positioning')
	const when = B.optionalText(args?.when, 'when')
	const checklist = lineListOf(args?.checklist)
	const deliverables = lineListOf(args?.deliverables)
	// **`scope` 现在只有一个意思：写到哪里**（`workspace` / `user`）。它从前是"职责边界"那个参数的名字 ——
	// 收到**数组**时说明调用方用着旧写法，这里**明确拒并指路**（不按形状认：同一个参数两种意思会让读的人含糊，
	// 本仓库反复栽在"一处两个说法"上）。职责边界用 **`boundaries`**。
	if (Array.isArray(args?.scope)) {
		return {
			ok: false,
			error: '`scope` 现在指**写到哪里**（`workspace` / `user`）；职责边界请用 **`boundaries`**（数组）。',
		}
	}
	const scopeLines = lineListOf(args?.boundaries)
	const missing = []
	// `optionalText` 把空白串也压成 `''` —— "给了个空格"与"没给"在这一层是同一件事，都算缺段。
	if (positioning === undefined || positioning === '') missing.push('positioning（一句话定位：这个角色对什么负责）')
	if (checklist.length === 0) missing.push('checklist（检查表，逐条可核）')
	if (deliverables.length === 0) missing.push('deliverables（落点：产出与落盘）')
	if (scopeLines.length === 0) missing.push('scope（职责边界，含"不做什么"）')
	if (missing.length > 0) {
		return { ok: false, error: `缺了 ${missing.length} 段 —— 缺一段都不算一份能派活的定义：${missing.map((item) => `\n· ${item}`).join('')}` }
	}

	// ③ 技能名核对（**最值钱的一条**：成员动手那一刻才会发现的名字错，在这一刻就挡下）
	const skills = nameListOf(args?.skills)
	if (skills.length > 0) {
		const catalog = await skillCatalogOf(ctx, exec)
		if (catalog.ok !== true) return { ok: false, error: catalog.reason }
		const unknown = skillUnknownOf(skills, catalog)
		if (unknown !== null) return { ok: false, error: unknown }
	}

	const title = B.optionalText(args?.title, 'title') || id
	const category = B.optionalText(args?.category, 'category') || '其他'
	const text = roleTextOf({
		id,
		title,
		category,
		positioning,
		when,
		skills: skills.join(', '),
		body: roleBodyOf({ checklist, deliverables, scope: scopeLines }),
	})
	const written = writeRoleDefinition(id, text, { root: target.root, mode })
	if (written.ok !== true) return { ok: false, error: written.reason }

	// ⑤ 回读：写进去的那一份现在是什么样（不拿"我以为写进去的"当结论）
	const meta = parseFrontMatter(readFileSync(written.file, 'utf8'))
	const record = roleRecordsFor(workspace).find((item) => item.id === id)
	const inDefaults = defaultRosterOf(undefined, workspace).some((entry) => entry.role === id)
	const staffing = await NL.roleStaffing(ctx, exec?.agent, roleCatalog(undefined, workspace), readDisabledNames(workspace))
	const members = staffing.ok === true ? staffing.byRole.get(id) ?? [] : null
	const readBack = [
		`front-matter ${typeof meta.name === 'string' && meta.name !== '' ? '可解析' : '**读不出 `name:`**'}`,
		`kind: ${String(meta.kind ?? '（缺）')}${meta.kind === 'role' ? '' : '（**不是 role**）'}`,
		`roleCatalog() ${record === undefined ? '**没枚举到它**' : '枚举得到它'}`,
		`member_defaults ${inDefaults ? '里现在有它' : `**里没有它**（${DEFAULT_ROSTER_EXCLUDED.includes(id) ? '它在这份清单被排掉的那几个里' : '现场枚举没读到'}）`}`,
		members === null ? '成员数**读不到**（原生名册读不到，如实报）' : members.length === 0 ? '这一档现在还没有成员' : `这一档现在有 ${members.length} 位成员：${members.map((item) => item.name).join('、')}`,
	]
	// **作用域那句逐字进回执**（与 `skill_define` 同一套）：写进哪个根、是否跨工作区可见。
	const scopeLine = roleScopeLine(scope)
	return {
		ok: true,
		role: id,
		mode,
		scope,
		file: written.file,
		root: written.root,
		...(written.backup === null ? {} : { backup: written.backup }),
		readBack,
		scopeLine,
		// **生效面读数与面板那三条写动作共用一处正文**（`roleWriteEffects`）—— 工具回执与面板回执
		// 说的是同一件事，就别各写一份；字段名也不叫 `restartRequired`（那个名字把"能不能用"挂在重启上）。
		...roleWriteEffects(),
		summary: `角色 ${id}（${record?.title ?? title}）已${mode === 'update' ? '覆盖' : '写入'} ${written.file}｜${scopeLine}${written.backup === null ? '' : `（原文件留了一份 ${written.backup}）`}｜${readBack.join('｜')}｜工具面立刻可用（member_defaults / member_spawn 现枚举）；只有注入到系统提示的那份「可叫的队友」清单是装载时快照、要重启 DSH 才更新`,
	}
}

/**
 * `skill_define`：把一段对话里定下来的**能力**沉淀成一份技能（`<name>/SKILL.md`）。
 *
 * **作用域（HD-008）**：缺省 `scope: workspace`（落本工作区的技能根），显式 `scope: user` 才落全局用户根。
 * 校验：name 形状；description 与 body 都非空（目录里那一句决定它会不会被载入 ⇒ 空描述等于
 * 建了个没人会用的技能）；重名必须 `mode: update`；写盘后回读 `ctx.get('skills').snapshot()`
 * 并**如实说那一次读到了什么** —— 技能目录**按变更即时刷新**（本机验过：建了下一次提示词就有、
 * 删了下次就没），所以"回读没读到"只是**读的那一刻**的读数，不是"要重启才会出现"。
 */
async function skillDefine(ctx, exec, args) {
	const identity = B.coordinatorCheckOf(ctx, exec?.agent, {
		tool: 'skill_define',
		why: '技能是团队的能力沉淀；它会写进技能根（缺省是本工作区的那个根，显式 user 才是全局根）',
	})
	if (identity.ok !== true) return { ok: false, error: identity.reason }

	const nameFindings = skillIdFindings(args?.name)
	if (nameFindings.length > 0) return { ok: false, error: nameFindings.join('；') }
	const name = String(args.name).trim()
	const mode = args?.mode === undefined || args?.mode === 'create' ? 'create' : args?.mode === 'update' ? 'update' : null
	if (mode === null) return { ok: false, error: `mode 只能是 create（新建）/ update（覆盖），收到 ${JSON.stringify(args?.mode)}。` }

	// **作用域**（HD-008，默认 `workspace`）：项目内的**踩坑总结 / 行为约束**只该影响这个工作区 ⇒
	// 缺省落 `<工作区>/.dsh/skills`；**跨项目可复用**的作业程序才显式 `scope: 'user'`（落 `~/.dsh/skills`，
	// **所有工作区都看得见**）。宿主侧本来就认这两个根（`lib/skill-write.js` 的 `skillTargetOf`），
	// 从前这里把 `kind` 写死成 `'user'` —— 于是任何会话沉淀的东西都进了全局根（现场就是这么出去的）。
	const scope = args?.scope === undefined || args?.scope === 'workspace' ? 'workspace' : args?.scope === 'user' ? 'user' : null
	if (scope === null) {
		return { ok: false, error: `scope 只能是 workspace（本工作区，缺省）/ user（全局，影响所有工作区），收到 ${JSON.stringify(args?.scope)}。` }
	}
	const kind = scope === 'user' ? 'user' : 'project'
	const workspace = B.workspaceRootOf(exec)
	const root = skillRootOf(kind, workspace)
	if (root === null) {
		return {
			ok: false,
			error:
				scope === 'workspace'
					? '工作区取不到：`scope: workspace`（缺省）要往本工作区的技能根写，而这次调用没带工作区。'
					: '技能根不认（只支持用户级 / 项目级）。',
		}
	}
	const target = join(root, name)
	const file = join(target, 'SKILL.md')
	const exists = existsSync(file)
	if (mode === 'create' && exists) {
		return { ok: false, error: `技能 "${name}" 已经存在：${file} —— 要改它请带 \`mode: update\`（覆盖前留一份 \`SKILL.md.bak\`），不许静默覆盖。` }
	}
	if (mode === 'update' && !exists) {
		return {
			ok: false,
			error: `技能 "${name}" 不在${scope === 'user' ? '用户技能根' : '本工作区的技能根'}里（${target}）—— 新建请带 \`mode: create\`；若你要找的是另一个作用域的那一份，请带上对应的 \`scope\`。`,
		}
	}

	const description = B.optionalText(args?.description, 'description')
	if (description === undefined || description === '') {
		return { ok: false, error: 'description 必填：这一句会被印进技能目录、决定"什么时候该载入它" —— 空描述等于建了一个没人会用的技能。' }
	}
	const body = typeof args?.body === 'string' ? args.body.trim() : ''
	if (body === '') return { ok: false, error: 'body 必填：技能就是那份作业程序，空的不算一份技能。' }

	const written = mode === 'create' ? createSkill({ kind, workspace, name, description, body }) : updateSkill({ kind, workspace, name, description, body })
	if (written.ok !== true) return { ok: false, error: written.reason }

	// 回读：**按会话作用域现读**技能目录，如实说**这一次读到了什么**（不是"这份技能生效了没有"）
	const catalog = await skillCatalogOf(ctx, exec)
	const inCatalog = catalog.ok === true && catalog.names.includes(name)
	// **别说过头话**（现场验收打回过）：技能目录是**按变更即时刷新**的 —— 建了，「下一次提示词」里就有它；
	// 删了，下一次提示词里就没了（本机两遍都没重启）。所以「回读没读到」只能读成"**读的那一刻**没读到"，
	// 不能写成"要重启才会出现"。
	const catalogLine =
		catalog.ok !== true
			? `回读技能目录：**这一次没读到**（${catalog.reason}）—— 那是**读的那一刻**的读数，不代表这份技能没写进去`
			: inCatalog
				? `回读技能目录：这一份**这一次已读到**（读到的是 ${catalog.layer} 层）`
				: `回读技能目录：这一份**这一次没读到**（读到的是 ${catalog.layer} 层）—— 那是**读的那一刻**的读数；技能目录**按变更即时刷新**，下一次提示词就会带上它（本机现场验过两遍：建了立刻出现、删了立刻消失）`
	// **作用域那句逐字进回执**（HD-008）：写进了哪个根、是否跨工作区可见 —— 读的人不必自己去推断。
	const scopeLine =
		scope === 'user'
			? '作用域：**user（全局）** —— 写的是用户技能根（`~/.dsh/skills`）：**所有工作区都看得见**（跨项目复用才该选它）。'
			: '作用域：**workspace（本工作区，缺省）** —— 写的是本工作区的技能根（`<工作区>/.dsh/skills`）：**只有这个工作区看得见**（别的项目不受影响；宿主那条 project 作用域优先级最高）。'
	return {
		ok: true,
		skill: name,
		mode,
		scope,
		kind,
		file: written.path === undefined ? file : join(written.path, 'SKILL.md'),
		root: written.root,
		...(written.backup === undefined ? {} : { backup: written.backup }),
		catalogLayer: catalog.ok === true ? catalog.layer : null,
		inCatalog,
		scopeLine,
		summary: `技能 ${name} 已${mode === 'update' ? '覆盖' : '写入'} ${written.path === undefined ? file : join(written.path, 'SKILL.md')}｜${scopeLine}｜${catalogLine}`,
	}
}

// ── 工具装配 + 钩子安装 ──────────────────────────────────────────────────────

/** 插件配置的解析结果（缺省值写在一处）。 */
function resolveConfig(config) {
	return {
		memberProvider: typeof config.memberProvider === 'string' && config.memberProvider !== '' ? config.memberProvider : DEFAULT_MEMBER_PROVIDER,
		executionPrompt: typeof config.executionPrompt === 'string' ? config.executionPrompt : '',
		skillsRoot: typeof config.skillsRoot === 'string' && config.skillsRoot !== '' ? config.skillsRoot : undefined,
	}
}

/**
 * 装配：成员面 / 任务面 / 制度那几个工具 + 一段团队策略。
 *
 * 与内置一样，**工具对每个团队成员可见**（协调者与成员同一套 schema）。为什么不做成"只给协调者
 * 注册"：成员得能互相发消息、能抢活、能等变化；把工具面按身份劈开，会让成员在需要协作时连话都说不出。
 * **门按工具分档**（判据的唯一正文是 `company-gate.js` 的 `coordinatorCheckOf`）：生人本来就由原生挡着
 * （`spawnTeammate` 对成员身份回 `only the Team Lead can create teammates`）；另外几条行政/写盘面的
 * 工具（`role_manage` / `board_task` 的登记与裁决那几档 / `human_words_record` / `role_define` /
 * `skill_define`）在各自的 handler 里就地判调用者身份 —— 成员身份拿到的是**可读拒绝**，不是静默放行。
 */
export function apply(ctx, config = {}) {
	// **一进程只挂一次**（幂等）：两个半边现在由插件那条宿主行装载（`lib/board-view.host.js`），
	// 而用户预设根里那份**旧副本**可能还声明着它们 ⇒ 重挂会让同一批工具名注册两遍。
	// 第二次调用直接返回（并说明是谁赢了：先挂的那个）。
	try {
		// 幂等键取 `ctx.root`：同一运行时里**所有子 ctx 共用一个 root**，于是"宿主行挂一次 +
		// 用户预设根里那份旧副本又挂一次"这条路也会被挡住（工具名不会注册两遍）。
		const key = ctx?.root ?? ctx
		if (teamRuntimeMounted.has(key)) {
			ctx.logger?.info?.('team-ops 运行时：这个运行时里已经挂过一次，跳过（幂等）。')
			return
		}
		teamRuntimeMounted.add(key)
	} catch {
		// ctx 不是对象（测试里的极端假件）⇒ 照挂，不做幂等
	}

	const resolved = resolveConfig(config)
	// **装载时建立首份交接快照**（没有那份文件才写）：快照原先是"看板改动之后才写"，
	// 于是只开过会话、只问过事的工作区**永远没有这个文件**（现场：人新开一个工作区，那里什么都没有）。
	// 钩在 `agent/created` 上：每个会话的主 agent 一出来就把这个工作区认下来；装载时已经在跑的也扫一遍。
	// **已存在就绝不动它**（判定与写入都在 `B.ensureHandoffSnapshot` 里那条事务队列内）。
	const ensureHandoff = (agent) => {
		if (agent === undefined || agent === null) return
		Promise.resolve(B.ensureHandoffSnapshot(ctx, { agent })).catch(() => undefined)
	}
	try {
		if (typeof ctx.on === 'function') ctx.on('agent/created', ({ agent }) => ensureHandoff(agent))
		const live = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
		const listed = live !== undefined && live !== null && typeof live.list === 'function' ? live.list() : []
		for (const agent of Array.isArray(listed) ? listed : []) ensureHandoff(agent)
	} catch {
		// 钩子挂不上不该影响装载（拿不到 agent 列表的嵌入形态就是这一支）——快照退化成"看板改动后才有"。
		ctx.logger?.warn?.('team-ops 运行时：交接快照的装载钩子没挂上，快照将只在看板改动后写。')
	}
	const roles = roleCatalog(resolved.skillsRoot)
	// **默认队友清单**（现场枚举，只给定位）：提示词段、`member_defaults` 与面板读的是同一份。
	// 提示词段是**装载时的快照**（系统提示一装配就定稿）；工具那两条路（`member_defaults` /
	// `member_spawn` 的角色校验）用 `rosterSource` **每次现枚举** —— 面板上刚加的角色因此马上叫得动。
	const defaultRoster = defaultRosterOf(resolved.skillsRoot)
	const rosterSource = { catalog: () => roleCatalog(resolved.skillsRoot), roster: () => defaultRosterOf(resolved.skillsRoot) }

	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: 'company:policy',
				order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),
				text: teamPolicyText(roles, defaultRoster),
			}),
		'team-ops.policy()',
	)

	ctx.tools.register(
		B.textTool({
			name: 'member_defaults',
			description: [
				'列出**默认队友清单**：现场枚举 `roles/`（**工作区角色根 > 用户级角色根 > 包内**）里除 ' + DEFAULT_ROSTER_EXCLUDED.map((id) => `\`${id}\``).join(' / ') + ' 外的每一个角色，**每条只给一句话定位**（显示名 / 分类 / 定位句 / 角色定义文件路径），外加**这一档现在有谁**（直接读原生名册：名字 + 运行时状态 `running` / `inactive` / `provisioning` / `failed`）。',
				'',
				'**这是"能叫谁"的唯一入口**：角色定义正文不在这里（也不在提示词里）—— 要正文本人动手前自己去读它自己那个文件（清单给了现场根，逐条给路径）。',
				'**怎么叫人**：`member_spawn role=<某个 id>` —— 名字按 `<角色>-<序号>` 现算、**同角色先复用**（这一档有能接活的就把活派给它）、`prompt` 省了就是「到场待命」。',
				// 引用**唯一正文**，不手抄（复核抓到的就是这里的第二份）
				NO_REMOVAL_NOTE,
				'**只读**：不改文件、不叫人。',
				'',
				B.READ_BOUNDARY,
			].join('\n'),
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			run: (_args, exec) => nativeDefaults(ctx, exec, rosterSource),
		}),
	)

	ctx.tools.register(
		B.textTool({
			name: 'member_spawn',
			description: [
				'生一个具名、可续聊、戴角色的队友 —— **建在 DSH 原生 Agent Teams 里**（`ctx.agentTeams.spawnTeammate`），因此原生名册与 `list_agents` 都看得到它。**只有协调者能调**。',
				'',
				'`role` 必填，取值是现场枚举出来的角色 id（用 `member_defaults` 查）。名字按 `<角色>-<序号>` 自动取（原生名册里已用的号不重用）、职责取角色定位句、`prompt` 省了就是"到场待命"。',
				'',
				'**同角色先复用**：这一档已经有能接活的成员时，本工具**不新建**，而是把 `prompt` 当活派给那一位（原生的持久消息）—— 复用不付冷启动，它上下文里还有这个工作区的来龙去脉。要**明确**新建一位才带 `reuse: false`。',
				`**两条硬上限**：同一角色最多 ${B.MEMBER_ROLE_MAX} 位（failed 的不算这一档的人）、**在场总人数最多 ${B.MEMBER_PRESENT_MAX} 位**（**含已失败的成员**）。到顶就拒，除非带 \`line_reason\` 写清为什么（理由会留在回执里）。上限就是这两个数（**两个独立硬上限**）：**角色槽位** ≤ 同角色 3 位（未停用且非 failed）、**在场总人数** ≤ 24（名册行数，含 failed 含停用者）。「3 位 × 8 个角色 = 24」只是**历史来源**一句话，**不再当判据**（角色种类现场枚举、可增可减）。`,
				'',
				'**身份怎么给**：原生 `spawnTeammate` 没有 persona 字段，所以角色的身份与作业程序是**按路径写进首活提示词**的（角色定义文件 + 基线 + 协作纪律），成员动手前自己去读 —— 文件是真相源。',
				'',
				`**建出来就收不回去**：${NO_REMOVAL_NOTE}`,
				'',
				B.WRITE_BOUNDARY_MEMBERS,
			].join('\n'),
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: '成员名，lower-kebab-case（例如 reviewer-1）；**省了按角色派生**：`<角色 id>-<下一个可用序号>`（原生名册里已用的号不重用）。' },
					role: { type: 'string', description: `角色名册里的一个：${roleRosterLine(roles)}。` },
					description: { type: 'string', description: '一句话职责（写进成员身份段，也作为名册上的说明）；**省了取角色的定位句**（与 member_defaults 上印的是同一句）。' },
					prompt: { type: 'string', description: '首活：自包含的完整任务（目标、背景、产物落点、验收判据）；**省了＝到场待命**（只交代它在场、怎么被派活、动手前别开工）。' },
					context: { type: 'string', enum: ['fresh', 'fork'], description: 'fresh 不继承本会话历史（缺省）；fork 继承已完成的轮次。' },
					reuse: { type: 'boolean', description: '缺省 `true` = **同角色先复用**（这一档有能接活的就把 `prompt` 当活派给它）；要**明确新建一位**才传 `false`（此时仍走两条硬上限判定）。' },
					provider: { type: 'string', description: '子代理提供方（可选）；缺省取配置里的 memberProvider —— fork 与否由原生的 context 决定，插件这一层不再分两档。' },
					line_reason: { type: 'string', description: `在场人数破告警线（${B.MEMBER_WARN_LINE}）时留下的那一行「为什么需要第 N+1 个」。` },
				},
				required: ['role'],
				additionalProperties: false,
			},
			run: (args, exec) => nativeSpawnMember(ctx, exec, args, rosterSource, resolved),
		}),
	)

	ctx.tools.register(
		B.textTool({
			name: 'member_send',
			description: [
				'给团队里的某位成员发一条**持久**消息（走 DSH 原生 Agent Teams 的 `ctx.agentTeams.sendMessage`：先落队伍日志、再尝试立即投递）。',
				'对方在跑就在最近的步边界收到；空闲会被唤醒或冷恢复；不在则下次唤醒时读到。**落盘即成功，不要重发**。',
				'',
				'消息正文要自包含（长内容落文件，这里只放指针）。收件人是成员名（`member_list` 里可查）或 `lead`。',
				'',
				B.WRITE_BOUNDARY_MEMBERS,
			].join('\n'),
			parameters: {
				type: 'object',
				properties: {
					target: { type: 'string', description: '收件人：成员名（member_list 里可查）或 `lead`（协调者）。' },
					message: { type: 'string', description: '自包含的消息正文；长内容落文件，这里只放指针。' },
				},
				required: ['target', 'message'],
				additionalProperties: false,
			},
			run: (args, exec) => nativeSendMember(ctx, exec, args),
		}),
	)

	ctx.tools.register(
		B.textTool({
			name: 'member_list',
			description: [
				'列出团队成员 —— 读的是 **DSH 原生名册**（`ctx.agentTeams.listMembers`，与内置 `list_agents` 同一处正文；协调者那一行也在里面，`role: lead`）。',
				'',
				'每一行的 `roleId` 是**按名字约定**（`<角色 id>-<序号>`）反读出来的；名字不合约定时 `roleId` 为空并给一句 `note` —— **不猜**。',
				// 同上：引用唯一正文（`member_defaults` / `member_list` 都不许手抄一份）
				NO_REMOVAL_NOTE,
				'',
				B.READ_BOUNDARY,
			].join('\n'),
			parameters: {
				type: 'object',
				properties: {
					status: { type: 'string', enum: RUNTIME_STATUSES, description: '按运行时状态筛行（可选）：running / inactive / provisioning / failed。枚举外的取值会被拒并说明取值域。' },
				},
				additionalProperties: false,
			},
			run: (args, exec) => nativeListMembers(ctx, exec, args, rosterSource),
		}),
	)

	ctx.tools.register(
		B.textTool({
			name: 'role_manage',
			description: [
				'管理**当前团队的角色清单**（角色卡上那个开关的工具面）。三个动作：',
				'· `action: list` —— 列出全部角色（id / 显示名 / 分类 / 一句话职责 / 启用状态 / 来路），按分类排序；',
				'· `action: disable` + `role` —— 把角色标成**停用**（记进当前工作区的状态文件，`action: list` 与角色卡据此显示 ）；',
				'· `action: enable` + `role` —— 重新启用。',
				'',
				'角色从哪来：**现场枚举**（**工作区角色根** `<工作区>/.dsh/team-ops/roles/` + 用户级角色根 `~/.dsh/team-ops/roles` + 包内 `team/roles/`，同名高处赢），front-matter 写 `kind: reference` 的不是角色。',
				'停用状态记在当前工作区的 `.company-gate.roles.json`（**缺省全部启用**，只记关掉了哪些）—— 于是新加的角色天生可用。',
				'**停用只改这一份状态文件**：`member_spawn` 不看这个开关（现场枚举到的角色都叫得动），**已在场的成员也不受影响** —— 关角色 ≠ 裁人，要让它不再出场就**不再派活**。',
				'',
				'参数：action（list / enable / disable，必填）、role（enable / disable 时必填）。',
				'',
				B.WRITE_BOUNDARY_ROLES,
			].join('\n'),
			parameters: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['list', 'enable', 'disable'], description: '要做的事。' },
					role: { type: 'string', description: '角色 id（enable / disable 必填）。' },
				},
				required: ['action'],
				additionalProperties: false,
			},
			async run(args, exec) {
				// **协调者专属**：角色清单是制度面，它写的是当前工作区的角色开关文件（`.company-gate.roles.json`）。
				// 成员身份从前能直接改这个开关 —— 判据的唯一正文在 `company-gate.js` 的 `coordinatorCheckOf`。
				const identity = B.coordinatorCheckOf(ctx, exec?.agent, {
					tool: 'role_manage',
					why: '角色清单是制度面，它写的是这个工作区的角色开关文件',
				})
				if (identity.ok !== true) return { ok: false, error: identity.reason }
				const action = B.requireText(args.action, 'action')
				if (action === 'list') {
					const view = await rolesViewOf(ctx, exec)
					return {
						summary: `角色 ${view.roles.length} 个（停用 ${view.disabled.length} 个）｜文件 ${view.file}`,
						rows: view.roles.map(
						(role) =>
							`${role.id}（${role.title}·${role.category}·${role.source === 'package' ? '包内' : '用户根'}${role.enabled ? '' : '，已停用'}）：${role.duty}`,
					),
						...(view.staleDisabled.length === 0 ? {} : { warnings: [`文件里这些停用项已经没有对应目录了（无害，可忽略）：${view.staleDisabled.join('、')}`] }),
					}
				}
				if (action !== 'enable' && action !== 'disable') throw new Error(`action 只能是 list / enable / disable，收到 ${JSON.stringify(action)}。`)
				const done = await setRoleEnabled(ctx, exec, { role: args.role, enabled: action === 'enable' })
				return {
					summary: `角色 ${done.role} 已${action === 'enable' ? '启用' : '停用'}${done.changed ? '' : '（原本就是这个状态）'}｜当前停用名单：${done.disabled.length === 0 ? '（空）' : done.disabled.join('、')}`,
					file: done.file,
				}
			},
		}),
	)




	ctx.tools.register(
		B.textTool({
			name: 'role_define',
			description: [
				'把一段对话里定下来的角色**沉淀成一份角色定义**（`<角色根>/<id>/ROLE.md`）—— 能力沉淀，不用每次临时生成。**只有协调者能调**。',
				'',
				'五条校验，每条都能当场拒并给出可照做的原文：',
				'· ① **id 形状**：lower-kebab-case（小写字母开头，只含小写字母、数字与单个连字符）；',
				'· ② **重名**：包内或用户根已有这个名字 ⇒ **必须带 `mode: update`**，回执会点明改的是哪一份（包内 / 用户根），不许静默覆盖；',
				'· ③ **`skills` 里每个名字必须真在本机技能目录里**：读法与面板同一条（`ctx.get(\'skills\').snapshot` + 会话作用域），不在就逐个点名并列出可选 —— 把"技能名写错"从"成员动手那一刻"提前到"定义角色这一刻"；',
				'· ④ **四段必备齐**：positioning / scope / checklist / deliverables 缺一段就拒并点名；',
				'· ⑤ **写盘后回读**：front-matter 可解析、`kind: role`、`roleCatalog()` 枚举得到、`member_defaults` 里有它，回执还带"这一档现在有没有成员"。',
				'',
				'**作用域（先选这个）**：`scope: "workspace"`（**缺省**）= 写**本工作区**的角色根 `<工作区>/.dsh/team-ops/roles/`，**只影响这个工作区**；`scope: "user"`（**必须显式**）= 写全局用户根 `~/.dsh/team-ops/roles/`，**所有工作区都看得见**。同名时**工作区那份赢**（与宿主技能根的项目优先一致）。',
			'判据：**项目专属的角色（只在这个项目里派活）⇒ 缺省 `workspace`**；**跨项目复用的角色 ⇒ 显式 `user`**。',
			'',
			'入参：id / title / category / positioning（一句话定位）/ when（什么时候该派它，写进 `description: Use when …`）/ **boundaries（职责边界，含"不做什么"，数组）** / checklist（检查表，逐条可核，数组）/ deliverables（落点，数组）/ skills（专属技能名，数组）/ scope（workspace（缺省）| user）/ mode（create | update）。',
			'（**两个参数别混**：`scope` = **写到哪里**，取 `workspace`（缺省）/ `user`；`boundaries` = **职责边界**（数组，四段之一）。`scope` 从前是职责边界那个名字 —— 现在收到**数组**会当场拒并提示改用 `boundaries`。）',
				'',
				WRITE_BOUNDARY_ROLE_DEFINE,
			].join('\n'),
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '角色 id：lower-kebab-case（例如 content-ops）。' },
					mode: { type: 'string', enum: ['create', 'update'], description: 'create 新建（缺省）；同名已存在时必须显式 update（覆盖前留 ROLE.md.bak）。' },
					title: { type: 'string', description: '显示名（缺省取 id）。' },
					category: { type: 'string', description: '分类（研发 / 设计 / 质量 / 数据 / 业务 / 管理 / 客户 …；缺省「其他」）。' },
					positioning: { type: 'string', description: '一句话定位：这个角色对什么负责（必填）。' },
					when: { type: 'string', description: '什么时候该派它 —— 写进 front-matter 的 `description: Use when …`；不给就回落到 positioning。' },
					scope: {
						type: 'string',
						enum: ['workspace', 'user'],
						description: '写哪个角色根：workspace（缺省，本工作区的 `<工作区>/.dsh/team-ops/roles/`，只影响这个工作区）/ user（全局 `~/.dsh/team-ops/roles/`，**所有工作区都看得见**，跨项目复用才选）。',
					},
					boundaries: { type: 'array', items: { type: 'string' }, description: '职责边界，逐条（含"不做什么"）；必填、至少一条。（这个名字从前叫 `scope` —— 现在 `scope` 指**写到哪里**；用旧那套 `scope: [...]` 会当场被拒并提示改用本参数。）' },
					checklist: { type: 'array', items: { type: 'string' }, description: '检查表，逐条可核；必填、至少一条。' },
					deliverables: { type: 'array', items: { type: 'string' }, description: '落点：产出与落盘（产物路径与字段）；必填、至少一条。' },
					skills: { type: 'array', items: { type: 'string' }, description: '这个角色专属的作业程序（技能名，必须在 `available_skills` 里）；不给就不写 `skills:` 那一行。' },
				},
				// **`boundaries` 必填**（职责边界）；`scope` 是作用域、可选（缺省 workspace）。
				// `scope` 收到数组会被 handler **明确拒**（并指路 `boundaries`）—— schema 层不能两可，所以 required 只列新名。
				required: ['id', 'positioning', 'boundaries', 'checklist', 'deliverables'],
				additionalProperties: false,
			},
			run: (args, exec) => roleDefine(ctx, exec, args),
		}),
	)

	ctx.tools.register(
		B.textTool({
			name: 'skill_define',
			description: [
				'把一段对话里定下来的**能力**沉淀成一份技能（`<技能根>/<name>/SKILL.md`）—— 能力沉淀，不用每次临时生成。**只有协调者能调**。',
				'',
				'**作用域（先选这个）**：`scope: "workspace"`（**缺省**）= 写**本工作区**的技能根 `<工作区>/.dsh/skills/`，**只影响这个工作区**；`scope: "user"`（**必须显式**）= 写全局用户根 `~/.dsh/skills/`，**所有工作区都看得见**。',
				'判据：**项目内的踩坑总结 / 行为约束 ⇒ 缺省 `workspace`**（那些只算这个项目的东西）；**跨项目可复用的作业程序 ⇒ 显式 `user`**。',
				'',
				'校验：**name 形状**（lower-kebab-case）；**description 与 body 都非空**（目录里那一句决定它会不会被载入 ⇒ 空描述等于建了个没人会用的技能）；**重名必须 `mode: update`**（覆盖前留一份 `SKILL.md.bak`）；写盘后**回读** `ctx.get(\'skills\').snapshot()` 并如实说**那一次读到了什么** —— 「回读没读到」是**读的那一刻**的读数；技能目录**按变更即时刷新**，下一次提示词就会带上它（本机现场验过两遍：建了立刻出现、删了立刻消失），**不需要重启**。',
				'',
				'入参：name / description（这句会被印进技能目录，写清"什么时候该载入"）/ body（正文，Markdown，就是那份作业程序）/ scope（workspace（缺省）| user）/ mode（create | update）。',
				'',
				WRITE_BOUNDARY_SKILL_DEFINE,
			].join('\n'),
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: '技能名：lower-kebab-case（例如 perf-baseline），也就是目录名。' },
					mode: { type: 'string', enum: ['create', 'update'], description: 'create 新建（缺省）；同名已存在时必须显式 update（覆盖前留 SKILL.md.bak）。' },
					description: { type: 'string', description: '目录里印的那一句（什么时候该载入这个技能）；必填。' },
					body: { type: 'string', description: '技能正文（Markdown）：做法、步骤、判据；必填。' },
					scope: {
						type: 'string',
						enum: ['workspace', 'user'],
						description: '写哪个技能根：workspace（缺省，本工作区的 `<工作区>/.dsh/skills/`，只影响这个工作区）/ user（全局 `~/.dsh/skills/`，**所有工作区都看得见**，跨项目复用才选）。',
					},
				},
				required: ['name', 'description', 'body'],
				additionalProperties: false,
			},
			run: (args, exec) => skillDefine(ctx, exec, args),
		}),
	)


	ctx.tools.register(
		B.textTool({
			name: 'member_wait',
			description: [
				'等**下一次团队变化**（名册、邮箱、共享任务、成员状态边）—— 只报告有没有超时，醒来/超时之后自己重新读状态，不要靠轮询猜。',
				'',
				'**它不唤醒任何人**：等之前先用 member_list 确认还有别人在跑或正在创建；没有的话它立刻返回 `noProgress`（reason = no-active-peer），那时要 member_send 把该醒的人叫起来，然后再等。',
				'`inactive` 的成员不会自己动 —— 等它不如叫它。',
				'',
				'参数：timeout_ms（可选，10000 到 3600000 毫秒，缺省 30000）。',
				'只读：等待本身不写任何文件。',
			].join('\n'),
			parameters: {
				type: 'object',
				properties: {
					timeout_ms: { type: 'integer', description: `等待时长（毫秒），${WAIT_MIN_MS} 到 ${WAIT_MAX_MS}，缺省 ${WAIT_DEFAULT_MS}。` },
				},
				additionalProperties: false,
			},
			run: (args, exec) => nativeWaitMember(ctx, exec, args),
		}),
	)


	// **旧的调度钩子已经摘掉**：成员与任务都在 DSH 原生 Agent Teams 里（排队、唤醒、冷恢复由宿主负责）。
	// 这些钩子当年是为「本插件自建的名册 / 邮箱 / 任务板」服务的，留着只会在每次状态边白白读盘。
	// 这一层现在只做两件事：注册工具（成员面 / 任务面 / 制度）与往系统提示里放策略段。


	// **没有"冷恢复 / 自动续领"这两条**：它们当年建立在本插件自建的名册 / 邮箱 / 文件看板之上，
	// 而那半边已经删了（成员与任务都在 DSH 原生 Agent Teams 里，排队、唤醒、冷恢复由宿主负责）。
	// 这条路径原先调用了一个**全仓没有定义的函数**（调用处还在 try/catch 里，失败只进 logger），
	// 而启动日志照样宣告"冷恢复 开" —— 一个默认开启、日志说开着、实际从未生效的功能比没有它更贵，
	// 所以整条栈连同那句日志一起删掉：日志只说这一层真做了的事。
	ctx.logger?.info?.(
		`team-ops 运行时已装载（v${pluginVersionOf()}）：角色名册 ${roles.length} 个（${roleRosterLine(roles)}）；成员提供方 ${resolved.memberProvider}。`
	)
}
