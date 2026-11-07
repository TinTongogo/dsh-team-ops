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
 * 装载形状由 `cordis.patch.yml` 那唯一的宿主行决定：`lib/board-view.host.js` 在服务就绪后
 * 自己 apply 制度层与本层（见 `mountTeamEngines`），不新增指向本包的 loader entry。
 */


import { runtimeBridge as B } from './company-gate.js'
import { NO_REMOVAL_NOTE, baselinePath, baselineVersionOf, pluginVersionOf, positioningOfRole, roleDefinitionOf, rolePersonaOf, teamPolicyText } from '../lib/role-persona.js'

// 角色 persona / 基线 / 团队策略段仍是引擎对外的正文，这里 re-export 保留导出面。
export { NO_REMOVAL_NOTE, baselinePath, baselineVersionOf, positioningOfRole, roleDefinitionOf, rolePersonaOf, teamPolicyText }
import { ROLE_ORIGIN_FACET_LABEL, createRole, customizeRole, disabledRolesOf, editRole, emptyRolesLedger, emptyRosterLedger, hiddenRolesOf, removeRole, restoreRole, roleCatalog, roleDefinitionTextOf, roleRecords, roleRecordsFor, roleRootRecords, roleRosterLine, rolesViewOf, rosterLedgerOf, setRoleEnabled, userRolesRoot } from '../lib/role-store.js'
import { allRoleContracts, contractConflicts, roleContractOf } from '../lib/role-contract.js'
import { collabMetricsOf, recordHandoffNote, taskPackOf } from '../lib/collab.js'

// 角色枚举与写盘仍是引擎对外正文，这里 re-export 保留导出面。
export { ROLE_ORIGIN_FACET_LABEL, createRole, customizeRole, disabledRolesOf, editRole, emptyRolesLedger, emptyRosterLedger, hiddenRolesOf, removeRole, restoreRole, roleCatalog, roleDefinitionTextOf, roleRecords, roleRecordsFor, roleRootRecords, roleRosterLine, rolesViewOf, rosterLedgerOf, setRoleEnabled, userRolesRoot }
import { commaListOf, dutyOfSkillText, parseFrontMatter, patchRoleText, roleTextOf, titleOfSkillText, whenOfSkillDescription, withoutFrontMatter } from '../lib/role-text.js'

// 角色定义文本的构造/解析仍是引擎对外正文，这里 re-export 保留导出面。
export { commaListOf, dutyOfSkillText, parseFrontMatter, patchRoleText, roleTextOf, titleOfSkillText, whenOfSkillDescription, withoutFrontMatter }
import { AVATAR_FILE_NAMES, AVATAR_ICON_FALLBACK, AVATAR_TONES, ROLE_AVATAR_ICONS, ROLE_CATEGORY_BY_TONE, avatarFileIn, avatarOf, avatarToneOf } from '../lib/role-avatar.js'

// 头像/色调/分类回落仍是引擎对外的正文，这里 re-export 保留原有导出面。
export { AVATAR_FILE_NAMES, AVATAR_ICON_FALLBACK, AVATAR_TONES, ROLE_AVATAR_ICONS, ROLE_CATEGORY_BY_TONE, avatarFileIn, avatarOf, avatarToneOf }

import * as NL from './native-layer.js'
import { DEFAULT_MEMBER_PROVIDER, DEFAULT_ROSTER_EXCLUDED, RUNTIME_STATUSES, WAIT_DEFAULT_MS, WAIT_MAX_MS, WAIT_MIN_MS, defaultRosterOf, defaultRosterView, nativeDefaults, nativeListMembers, nativeSendMember, nativeSpawnMember, nativeWaitMember, nextMemberNameFor, pruneSkillFromRoles, setMemberDisabled } from '../lib/member-engine.js'

// 默认清单与成员工具仍是引擎对外的正文，这里 re-export 保留导出面。
export { DEFAULT_ROSTER_EXCLUDED, defaultRosterOf, defaultRosterView, nextMemberNameFor, pruneSkillFromRoles, setMemberDisabled }
import { WRITE_BOUNDARY_ROLE_DEFINE, WRITE_BOUNDARY_SKILL_DEFINE, roleDefine, skillDefine } from '../lib/role-skill-tools.js'

/** 幂等闸：**同一个 ctx 只挂一次**（`WeakSet`；见 `apply` 顶部）。 */
const teamRuntimeMounted = new WeakSet()

export const inject = ['fs', 'tools', 'systemPrompt', 'subagents', 'agents']

// ── 常量 ─────────────────────────────────────────────────────────────────────


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
				'**收口前写检查点**：每次派活都会在提示词末尾带一句 `team_checkpoint`（压缩/收口前的落点）；有结论的活，收口前落一份，交接才不靠记忆。',
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
				'停用状态记在当前工作区的 `.ops/roles.json`（**缺省全部启用**，只记关掉了哪些）—— 于是新加的角色天生可用。',
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
				// **协调者专属**：角色清单是制度面，它写的是当前工作区的角色开关文件（`.ops/roles.json`）。
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
			name: 'role_contract',
			description: [
				'查角色的**职责契约**：从 `ROLE.md` 的「落点（产出与落盘）」段解析出它 owns 哪些产物路径、明确不碰哪些，并检测**路径归属冲突**（同一路径被两个角色 owns）。',
				'',
				'不传 `role` ⇒ 返回全量契约 + 冲突清单（**冲突数必须为 0**；有冲突先改 `ROLE.md` 再派活）。',
				'传 `role` ⇒ 只返回该角色的 `{ owns, excludes }`。',
				'',
				'**只读**：不改文件、不改角色。',
				'',
				B.READ_BOUNDARY,
			].join('\n'),
			parameters: {
				type: 'object',
				properties: {
					role: { type: 'string', description: '角色 id（可选）；不传返回全量契约与冲突。' },
				},
				additionalProperties: false,
			},
			run: async (args) => {
				try {
					const wanted = typeof args?.role === 'string' ? args.role.trim() : ''
					if (wanted !== '') {
						// 只回这一个角色：**不给 `conflicts`** —— 单角色的冲突集合恒为空，印出来会被读成"没冲突"。
						return { ok: true, contract: roleContractOf(wanted) }
					}
					const contracts = allRoleContracts()
					return { ok: true, contracts, conflicts: contractConflicts(contracts) }
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : String(error) }
				}
			},
		}),
	)

	ctx.tools.register(
		B.textTool({
			name: 'handoff',
			description: [
				'写一条**结构化交接单**（跨角色传递产物）：`to`（接收角色）、`artifact`（产物名）、`path`（落点）、`need`（要对方做什么）四项必填。',
				'',
				'**只传指针，不传长文**：对方读 `path`，不要求你再写一份"说明文档"；过程材料留在看板与交接单，不进 `docs/`。缺一项不接收（退回补全）。',
				'',
				'**写工作区文件**：`.ops/handoffs.json`（只增，保留最近 200 条）。',
				'',
				B.WRITE_BOUNDARY_ROLES.replace('roles.json', 'handoffs.json'),
			].join('\n'),
			parameters: {
				type: 'object',
				properties: {
					to: { type: 'string', description: '接收角色 id（现场枚举之一）。' },
					artifact: { type: 'string', description: '产物名（如「评测报告」「接口契约」）。' },
					path: { type: 'string', description: '产物落点（工作区相对路径或绝对路径）。' },
					need: { type: 'string', description: '要对方做什么（一句话，可核）。' },
					task: { type: 'string', description: '关联的任务编号（可选，形如 `task-3` / `T-3`）；面板按它把交接显示到对应任务卡上。' },
				},
				required: ['to', 'artifact', 'path', 'need'],
				additionalProperties: false,
			},
			run: async (args, exec) => {
				try {
					const outcome = await recordHandoffNote(ctx, exec, args)
					return { ok: true, note: outcome.note, file: outcome.file, total: outcome.total }
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : String(error) }
				}
			},
		}),
	)

	ctx.tools.register(
		B.textTool({
			name: 'team_metrics',
			description: [
				'协作效率度量：任务三态计数、交接单数与缺字段数、**路径归属冲突数**、**任务包缺格数**（`description` 里没有「产物形态」或「验收判据」）。',
				'',
				'**只读**。用法：复盘时看异常项（返工率高、缺格多、冲突非 0）⇒ 改 BASELINE/rules，不新增说明文档。',
				'',
				B.READ_BOUNDARY,
			].join('\n'),
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			run: async (_args, exec) => {
				try {
					return await collabMetricsOf(ctx, exec)
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : String(error) }
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
