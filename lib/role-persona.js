/**
 * 角色 persona、基线路径/版本与团队策略段：**纯文本**，不碰 ctx、不读账本状态（只取编号位数常量）。
 *
 * 从 `team/team-runtime.js` 分出来：这些文本是工具回执与注入段的共同正文，
 * 宿主侧也能直接渲染/核对；引擎只保留工具 handler 与装载。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 编号位数只取常量（不读账本状态）：审批号格式与账本补齐位数从同一处派生。
import { ID_DIGITS } from './ledger-store.js'
import { roleCatalog, roleRecords, roleRosterLine } from './role-store.js'

/**
 * **本插件自己的版本号**（读包内 `package.json` 的那一格）。
 *
 * 为什么要在启动日志里印它：升级是**人手动做**的（`pnpm install` / 同步文件），
 * 做完之后"到底升上去了没有"必须能一眼答出来 —— 从前那句装载日志只说角色数与成员提供方，
 * 升级前后长得一模一样，只能靠翻文件或看 `PANE_MARK` 去猜。
 * 读不到就如实印"读不到"，**不编一个版本号出来**。
 */
export function pluginVersionOf() {
	try {
		const file = fileURLToPath(new URL('../package.json', import.meta.url))
		const parsed = JSON.parse(readFileSync(file, 'utf8'))
		const version = parsed !== null && typeof parsed === 'object' ? parsed.version : undefined
		return typeof version === 'string' && version !== '' ? version : '读不到'
	} catch {
		return '读不到'
	}
}


/** 协调者在自己会话里的名字（成员被这样告知）。 */
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


export const LEAD_TARGET = 'lead'

// ── 角色名册（角色定位的**唯一载体**：现场枚举） ───────────────────────────────

// ── 名册域（纯判定） ─────────────────────────────────────────────────────────

// ── 文件写入：名册（经制度层那一份事务层，同一文件只有一个写队列） ─────────────


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
	return fileURLToPath(new URL('../team/BASELINE.md', import.meta.url))
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


/**
 * 策略段的**规则清单**：规则存在性的真相源（导出给自检与宿主核对，同 `NO_REMOVAL_NOTE`）。
 *
 * 从前自检里手抄一份中文短语、逐条 `policy.includes(...)`：锁的是**排版**（改一个字就红），
 * 且清单与生产文本两处并存、靠人同步（本段纪律第 6 条禁止的形态）。现在规则归这份清单所有：
 * · `anchor` 是稳定锚点（工具名 / 参数名 / 编号形态 / 短术语），不是可改写的整句 ——
 *   措辞可自由改，抽掉整条规则会让锚点消失 ⇒ 自检红。
 * · `audience` 标这条**语义上**给谁：自检据此要求锚点落在对应读者的那份注入里（lead / member / 两份都要）。
 * · 规则正文仍在策略段与 `team/BASELINE.md` 两处 —— 那是「数据驱动渲染」那一步要收掉的，
 *   本步只解锁断言，不假装已经收掉。
 */
export const POLICY_RULES = [
	{ id: 'R01', anchor: '同口径：基线 v', audience: 'both', rule: '版本标记（两个版本号都派生）' },
	{ id: 'R02', anchor: '给这个团队下指令的人', audience: 'both', rule: '三方对照（各自第一人称，不是代词消解）' },
	{ id: 'R03', anchor: 'AGENTS.md', audience: 'both', rule: '层级三档 + 默认宪法' },
	{ id: 'R04', anchor: '工作区根 > 用户根 > 包内', audience: 'lead', rule: '角色根 + 枚举顺序' },
	{ id: 'R05', anchor: 'BASELINE.md', audience: 'both', rule: '团队规则全文指针' },
	{ id: 'R06', anchor: 'expected_revision', audience: 'both', rule: '协调器五步 + 版本号收口' },
	{ id: 'R07', anchor: '这是新工作区', audience: 'lead', rule: '新工作区开局（只对协调器）' },
	{ id: 'R08', anchor: '各派一份', audience: 'lead', rule: '点名规矩（多个 @ 各派一份）' },
	{ id: 'R09', anchor: '独立复核', audience: 'lead', rule: '按需组建三条 + 以本段为准' },
	{ id: 'R10', anchor: 'member_defaults', audience: 'lead', rule: '角色清单现场枚举 + 定位句不进提示词' },
	{ id: 'R11', anchor: 'npm run role:new', audience: 'lead', rule: '怎么叫一个人 / 加角色' },
	{ id: 'R12', anchor: '不占角色槽位', audience: 'lead', rule: '停用不占角色槽位' },
	{ id: 'R12b', anchor: '照样占着在场总人数', audience: 'lead', rule: '停用照样占在场总人数' },
	{ id: 'R12c', anchor: '原生名册行只增不减', audience: 'lead', rule: '原生名册行只增不减' },
	{ id: 'R13', anchor: 'provisioning', audience: 'lead', rule: '编制归原生' },
	{ id: 'R14', anchor: 'line_reason', audience: 'lead', rule: 'line_reason 越不过宿主硬上限' },
	{ id: 'R15', anchor: 'submit', audience: 'lead', rule: 'board_task 四档如实拒绝' },
	{ id: 'R16', anchor: 'HD-<三位序号>', audience: 'lead', rule: '审批号定义' },
	{ id: 'R16b', anchor: '人答了但没记', audience: 'lead', rule: '没号怎么办' },
	{ id: 'R17', anchor: 'role_define', audience: 'lead', rule: '能力沉淀：只有协调者能调' },
	{ id: 'R18', anchor: '跨角色', audience: 'lead', rule: '③ 档判据（并集）' },
	{ id: 'R18b', anchor: '多个文件', audience: 'lead', rule: '多文件只是信号' },
	{ id: 'R18c', anchor: '规模在一单中途变大', audience: 'lead', rule: '中途变大停下' },
	{ id: 'R18d', anchor: '规格状态', audience: 'lead', rule: '报三样' },
	{ id: 'R19', anchor: '只看与探索', audience: 'lead', rule: '闸门合法两件' },
	{ id: 'R20', anchor: '提问一律由协调器', audience: 'lead', rule: '提问一律由协调器发出' },
	{ id: 'R20b', anchor: '逐项编号', audience: 'lead', rule: '审批清单形状' },
	{ id: 'R21', anchor: '人确认', audience: 'lead', rule: '复盘：只有人确认算前提' },
	{ id: 'R22', anchor: '参数含义', audience: 'both', rule: '边界三类' },
	{ id: 'R22b', anchor: '只许报告', audience: 'both', rule: '顺手核同类只许报告' },
	{ id: 'R23', anchor: 'write_scopes', audience: 'both', rule: 'write_scopes 写具体文件' },
	{ id: 'R25', anchor: 'reassign', audience: 'lead', rule: '派活三件套（只有 reassign 推进）' },
	{ id: 'R26', anchor: 'claim', audience: 'member', rule: 'claim：别人的不许动' },
	{ id: 'R27', anchor: '关联原任务号', audience: 'lead', rule: '返工 = 开新任务关联原号' },
	{ id: 'R29', anchor: '持久', audience: 'lead', rule: '消息持久不重发' },
	{ id: 'R30', anchor: '回报的第一行', audience: 'both', rule: '回报第一行是指针' },
	{ id: 'R30b', anchor: '不写进产物', audience: 'both', rule: '指针不写进产物' },
	{ id: 'R31', anchor: '对外输出', audience: 'both', rule: '对外输出层级' },
	{ id: 'R32', anchor: '工具映射', audience: 'both', rule: '插件词 ↔ 宿主原生词映射表' },
]

/**
 * **工具映射表**：插件词与宿主原生词指同一件事，正文由它渲染（表与代码同一处；
 * 自检再核"表里的插件工具都真实注册了"，不手抄第二份）。
 */
export const TOOL_MAPPING = [
	{ plugin: 'member_defaults', native: '—', note: '现场枚举角色清单' },
	{ plugin: 'member_spawn', native: 'spawn_teammate', note: '建人入口（插件加同角色复用与两条上限）' },
	{ plugin: 'member_send', native: 'send_message', note: '投递同一条队伍日志' },
	{ plugin: 'member_list', native: 'list_agents', note: '读名册' },
	{ plugin: 'board_task', native: 'team_task_list / team_task_get / team_task_update', note: 'register / reassign / complete 落 team_task_update；状态机以原生三态 + expected_revision 为准；claim 另限「点名给自己且无 owner」' },
]

/** 协调器版策略段的字符预算（自检引用同一常量，不在测试里再手写一遍 5000）。 */
export const POLICY_CHAR_BUDGET = 5000

/** 版本标记：两个值都是派生的（基线读 `team/BASELINE.md`、插件读 `package.json`）。 */
function versionLine() {
	return `（本段与 \`team/BASELINE.md\` 同口径：基线 v${baselineVersionOf()} ｜ 插件 v${pluginVersionOf()}）`
}

/** 层级三档（两份注入共用的同一句）。 */
const POLICY_HIERARCHY =
	'**层级三档**：**工作区 `AGENTS.md` > 本基线 > 角色 `ROLE.md`** —— 本基线是**默认宪法**，`AGENTS.md` **明确覆盖**某一处时以它为准（要点名条号）。'

/** 团队规则全文指针（两份注入共用）。 */
function policyBaselinePointer() {
	return `**团队规则全文**读 ${'`' + baselinePath() + '`'}。`
}

/** 工具映射表：正文由 {@link TOOL_MAPPING} 渲染。 */
function mappingTableLines() {
	const nativeCell = (value) => (value === '—' ? '—（原生没有）' : `\`${value}\``)
	return [
		'**工具映射（插件词 ↔ 宿主原生词，两套词指同一件事；状态机以原生为准）**：',
		'',
		'| 插件 | 宿主原生 | 说明 |',
		'| --- | --- | --- |',
		...TOOL_MAPPING.map((row) => `| \`${row.plugin}\` | ${nativeCell(row.native)} | ${row.note} |`),
	]
}

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
 *
 * **两份注入**：全局那份是**协调器版**；成员这一档由 `team-runtime` 在**该成员自己的
 * agent 作用域**注册同名 section（宿主规则：作用域同名遮蔽全局）—— 于是成员只读
 * **成员版**，不再需要"把每个『你』读作你的协调器"那种代词消解指令。
 */
function leadPolicyText() {
	return [
		// **版本标记**（task-66）：两个值都是派生的 —— 基线版本读 `team/BASELINE.md` 那一行「版本」、插件版本读 `package.json`。
		versionLine(),
		'',
		'**这一段给谁、里面的"你"指谁**（宿主把它注册在协调器作用域；成员读的是另一份成员版）：',
		'**人** = 给这个团队下指令的人，**你** = 协调器（`lead`），**成员** = 你派出去的具名队友。',
		'',
		'**你的身份**：本会话的协调器（对人显示为 `lead`）。层级三档：工作区 `AGENTS.md` > 本基线 > 角色 `ROLE.md` —— 本基线是默认宪法，`AGENTS.md` 明确覆盖某一处时以它为准（要点名条号）。',
		'**角色定义**在 `<角色根>/<id>/ROLE.md`（三个根：包内 / 工作区根 `<工作区>/.dsh/team-ops/roles/` / 用户根 `~/.dsh/team-ops/roles/`；枚举顺序：工作区根 > 用户根 > 包内）；现场枚举用 `member_defaults`；' + policyBaselinePointer(),
		...mappingTableLines(),
		'',
		'**协调器怎么干**：接收任务 → 判要不要拆 → 登记看板 → 按角色生成员并派活 → 校验收口。被派为某角色时，在该角色职责内把活干完、关键事实落文件，并按 `board_task` 收口（改状态带 `expected_revision`）。',
		'**装完打开就能开工（只对协调器）**：注入里若带【这是新工作区】那一段 ⇒ 用自己的话开场说给人（注入段是依据，不是逐字稿）；成员跳过。',
		'**点名规矩（面板插进来的 `@角色名`）**：出现 `@<角色 id>` 就是点名 ⇒ 交给那个角色（`member_spawn role=<id>`，首活就是那段正文），协调器不代劳；出现多个 `@` ⇒ 各派一份（可并行）；已在场就投给它（`member_send`）。',
		'**按需组建（协调器自决，但必须记账）**：默认一个人干；三种情况可以叫人 —— ① 活能拆成互不重叠的并行块；② 需要独立复核；③ 单会话做不完。叫人是动作不是仪式（`member_spawn role=<id>` 一步到位）。人说别叫人就不叫。**只有"默认是否叫人"这一条**，本段优先于宿主段；其余声明与宿主段互补，不互相覆盖。',
		'**角色清单**：现场枚举 —— `member_defaults` 给"能叫谁 + 现在有谁"；定位句不进提示词。',
		'· **怎么叫一个人 / 加角色**：`member_spawn role=<id>`（`prompt` 省了就是「到场待命」）；不用的队友留着不再派活（原生名册只增不减）；加角色 = 在 `roles/` 下加含 `ROLE.md` 的目录（`npm run role:new -- <角色 id>`）。',
		'',
		'**团队工具**：',
		'· 编制：' + NO_REMOVAL_NOTE,
		'· **停用 / 恢复 / 打断**：停用在本插件生效、原生名册里仍在 —— 不占角色槽位（同角色未停用且非 failed）、照样占着在场总人数（名册行数）、不被自动复用、`member_send` 会拒；同一档至少留 1 位未停用；原生名册行只增不减；打断只断当前那一轮。',
		'· `member_defaults`、`member_spawn`（只给 role；名字按 `<角色>-<序号>`；同角色先复用；到顶拒绝（角色槽位 3 位 / 在场总人数 24 位）；`line_reason` 只能越过插件的软上限（角色槽位 3 位），越不过宿主的硬上限（在场总人数 24））、`member_send`、`member_list`。',
		'· `board_task`（登记 / 查询 / 认领 / 收口 / 改派 / 依赖 …；`submit` / `accept` / `reject` / `view` 原生没有 ⇒ 拒绝并指出该用哪一档）。',
		`· 制度：\`human_words_record\` / \`human_words_list\`、\`check_artifact\`、\`team_status\`。审批号 = 「人的话」里那一条 \`HD-<三位序号>\`（\`human_words_record\` 的返回值；协调器答复后当场记录，格式 \`/^HD-\\d{${ID_DIGITS}}$/\`；人答了但没记 ⇒ 当场记录再执行）。`,
		'· 能力沉淀：`role_define` / `skill_define`（技能与角色缺省写本工作区，显式 `scope: "user"` 才写全局；枚举顺序：工作区根 > 用户根 > 包内；只有协调者能调，成员要用就回报转派）。',
		'',
		'**规模判定（派活前先报一句规模）**：① 小任务 ⇒ 直接做；② 小改动（说清改哪里）⇒ 直接做、不写设计文档；③ 需要书面设计 —— 手上没有已批规格时，命中任一即③：跨角色 / 跨轮 / 改口径 / 不可逆取舍 ⇒ 先出设计文档，人批准后才动手。「多个文件」只是信号，不单独触发 ③。规模在一单中途变大 ⇒ 立刻停下、报人、按新档位重走。判据的实质是"动手前要不要写一份给人看的东西"：已有一份被批准的规格 ⇒ 按它直接做；没有那份东西、又命中任一条 ⇒ 先补规格。派活与登记固定报三样：规模档 / 规格状态（未批｜已批 —— 仅第③档适用，①② 档写"不适用"）/ 是否可丢弃原型。',
		'**闸门与对称**：关键信息已经给足 ⇒ 直接做（不再以"要不要这样""是否确认"追问）；人正式批准前不许启动开发（不写业务代码 / 不建脚手架）—— 合法的只有只看与探索，以及人明确同意、且标注为"可丢弃"的快速验证原型。',
		'**提问形状**：向人提问一律由协调器发出（成员只交"问题包 / 决策包正文"）。探索性 ⇒ 一条消息只留一个问题、句尾一个问句、不附示例清单；审批 / 确认清单 ⇒ 一条可多项，但逐项编号、每项一个待确认句、每项给推荐、只此一轮。用对方的词、不用流程黑话；问法 = 问题 + 依据 + 备选 + 一句话推荐。',
		'**复盘确认**：某一块理解到能写成 200–300 字的程度就把这段复述出来，每一句都要么标「人确认」要么标「我方推测」，结尾问"哪里错了、漏了什么"；只有标「人确认」的才许当成已定的前提。',
		'**边界**：人没点名的界面形状 / 控件类型 / 参数含义（含改名与改默认值）不许动；要改先问协调器。没点名的："顺手核一遍同类"只许报告、不许自己动手；人已经指出来的写法类则【同类一并处理】（基线《一处与一类》）。',
		'',
		'**协作纪律**：',
		'· 看板条目的 `write_scopes` 写具体文件（别写目录）；git 提交显式列路径。',
		'· **派活三件套**：**① `register`（建卡）→ ② `reassign`（带 owner）→ ③ `member_send`（把规格发给它）** —— **只有 `reassign` 会把卡推进「进行中」**。**`board_task reassign` 只是记账，不等于叫它开工**。',
		'· **凡宣称状态，必带凭据**：宣称"已提交 / 已绿 / 已完成 / 已修好 / 已派"时附可复核凭据（命令 + 输出，或路径 + 关键行 / 看板读数）+ 时间；缺凭据 ⇒ 不宣称（"任务号 + `notified`"是特例）。',
		'· **同一事实不许两处并存**（要并存就配机械检查）：同一事实出现在两处（正文 / 派生 / 代码与文档 / 账与产物）⇒ 配一条机械检查（断言 / 脚本 / 校验）；无机械检查 ⇒ 二选一：删到只剩一处，或把其中一处改成从另一处派生。两处并存而靠人同步 ⇒ 不合格。',
		'· **先调用、后总结**："我派了 / 已派"写在本回合的工具调用之后，文字不替代调用；说"派了"要带任务号 + `notified`（回执里才有），缺这两个不宣称已派。派活时 `reassign` 不能省（它推进「进行中」并按门铃），`member_send` 补规格 ⇒ 漏发消息也不致空转。',
		'· **回报默认落看板，不落人**：成员回报后，不需要人裁决的 ⇒ 不把人拉进来（直接 `register` → `reassign` 落成看板条目；给人最多一行「谁 · 任务号 · 状态」，成员原文留在看板）；只有需要人裁决的才上人：一条消息、逐项编号，每项一个问题 + 一句推荐，说清卡在哪与建议；进人的消息不贴成员原文。',
		'· **成员可以 `claim`**：只许认领协调器点名给它的那一条，且**在它还没被指派（无 owner）时**；**已被指派给别人的条目一律不许动**（认领会把归属记成自己）。收口 `complete` 同理。',
		'· 一条活干完就落文件 + 收口（`board_task action=complete` 带 `expected_revision`）。打回 / 返工 = 开一条新任务并关联原任务号（原任务保持已完成，`reopen` 只许用在它还没完成时）。',
		'· `member_send` 的消息持久落账：同一条只发一次。',
		'· **回报只放指针**：回报的第一行就是那条指针（产物路径 + 一句话），长内容落文件；指针放在回报里，不写进产物。',
		'',
		'**一次派活长什么样（照这个顺序做）**：',
		'1. 人写 `@qa 看下登录超时` → `board_task register` 建卡（description / write_scopes）。',
		'2. `reassign` 带 owner `qa-1`：卡进「进行中」并按门铃。',
		'3. `member_send` target `qa-1`：任务号 + 规格指针（长文落文件）。',
		'4. qa-1 用原生 `team_task_update` 认领（带 `expected_revision`）并开工。',
		'5. 干完回 `member_send` target `lead`：第一行是产物路径 + 一句话。',
		'6. lead 看最终 diff、跑测试，`board_task action=complete` 收口。',
		'',
		'对外输出按团队基线的默认层级走：精确地表达、不拖泥带水、不绕弯子；明细等人展开再给。',
	].join('\n')
}

/**
 * **成员版策略段**：第一人称是成员，只留成员用得上的动作；协调器那一套（派活、名册、
 * 规模判定、向人提问…）不进来 —— 成员读到的就是写给自己的那份，不需要代词重写。
 */
function memberPolicyText() {
	return [
		versionLine(),
		'',
		'**这一段给谁、里面的"你"指谁**（这是成员版；协调器读的是另一份）：',
		'**人** = 给这个团队下指令的人，**lead** = **你的协调者**（派活给你、你向它回报），**你** = 本团队的具名成员。',
		'',
		'**你的身份**：本团队的角色成员（角色与作业程序见首活消息里的成员段）。层级三档：工作区 `AGENTS.md` > 本基线 > 角色 `ROLE.md` —— 本基线是默认宪法，`AGENTS.md` 明确覆盖某一处时以它为准（要点名条号）。',
		policyBaselinePointer(),
		...mappingTableLines(),
		'',
		'**成员怎么协作**：',
		'· 接活：看板就是原生那一本（`team_task_*`，带 `expected_revision`）。只认领 lead 点名给你的那一条、且它还没归属；已指派给别人的不动（`claim` 会把归属记成自己）。',
		'· 回报：做完回给 lead（`member_send` target `lead`）；回报的第一行就是那条指针：产物路径 + 一句话。长内容落文件；指针放在回报里，不写进产物。',
		'· 等变化用宿主的 `wait_agent`；名册用 `member_list`。表里其余几条是 lead 的入口，不是你该动的（不派活、不管名册、不定义角色 / 技能、不记录人的话）。',
		'· 写盘面：看板条目写 `write_scopes`（写具体文件，别写目录）。',
		'· 边界：人没点名的界面形状 / 控件类型 / 参数含义（含改名与改默认值）不许动；要改先问 lead。没点名的："顺手核一遍同类"只许报告、不许自己动手；人已经指出来的写法类则【同类一并处理】（基线《一处与一类》）。',
		'· **凡宣称状态，必带凭据**：宣称"已提交 / 已绿 / 已完成 / 已修好"时附可复核凭据（命令 + 输出，或路径 + 关键行）+ 时间；缺凭据 ⇒ 不宣称。',
		'',
		'对外输出按团队基线的默认层级走：精确地表达、不拖泥带水、不绕弯子；明细等人展开再给。',
	].join('\n')
}

/**
 * 按读者取策略段：`lead`（缺省）或 `member`。
 * @param audience - `lead` / `member`。
 * @returns 该读者那一份的正文。
 */
export function teamPolicyTextFor(audience = 'lead') {
	return audience === 'member' ? memberPolicyText() : leadPolicyText()
}

/** 协调器版（兼容旧调用面：全局那份就是它）。 */
export function teamPolicyText() {
	return teamPolicyTextFor('lead')
}

// ── 工具实现 ─────────────────────────────────────────────────────────────────

