/**
 * 成员域：默认队友清单、原生成员工具（spawn / list / send / wait / defaults）与停用、技能剪枝。
 *
 * 从 `team/team-runtime.js` 分出来之后，引擎只剩角色/技能工具的定义与 `apply`；
 * 这一层只经 `ctx` 与原生 Agent Teams 通信，写状态仍走 `runtimeBridge` 的 CAS 与队列。
 */
import { readFileSync } from 'node:fs'

import { runtimeBridge as B } from '../team/company-gate.js'
import * as NL from '../team/native-layer.js'
import { MEMBER_FLAGS_FILE, disableFindings, disabledNamesOf, emptyMemberFlags, readDisabledNames } from './member-flags.js'
import { ROLE_ORIGIN_FACET_LABEL, packagedRoleIds, roleCatalog, roleRecords, roleRecordsFor, roleRootRecords } from './role-store.js'
import { baselinePath, positioningOfRole, roleDefinitionOf, rolePersonaOf } from './role-persona.js'
import { patchRoleText } from './role-text.js'
import { invalidateRoleRecords } from './role-record-cache.js'
import { writeRoleDefinition } from './roster.js'
import { skillScopeOf, skillViewOptions } from './skill-scope.js'

/** 生成员用的默认提供方：`spawn`（不继承本会话历史）。`fork` 由 `context: 'fork'` 显式要。 */
export const DEFAULT_MEMBER_PROVIDER = 'spawn'
/** `context: 'fork'` 时用的提供方（新宿主按 provider 选后端；旧宿主也认 context）。 */
export const DEFAULT_MEMBER_FORK_PROVIDER = 'fork'

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
export const RUNTIME_RUNNING = 'running'
export const RUNTIME_INACTIVE = 'inactive'
export const RUNTIME_PROVISIONING = 'provisioning'
export const RUNTIME_FAILED = 'failed'
export const RUNTIME_STATUSES = [RUNTIME_RUNNING, RUNTIME_INACTIVE, RUNTIME_PROVISIONING, RUNTIME_FAILED]

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
export function takenNamesOf(membersValue) {
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

// `member_wait` 已退役：宿主 `wait_agent` 覆盖同一能力，这里不再保留自建的等待入口。

// ── 成员面：全部走 DSH 原生 Agent Teams（薄层那一处按角色办事） ────────────────
//
// 为什么换：原生队伍的成员真源是会话日志里的 `team/member` 事件，只有 `spawnTeammate` 写它；
// 我们自建名册的那套在原生眼里是**影子成员**（原生名册永远只有 lead，任务板也永远是空的）。
// 成员创建与投递本来就是宿主领域，所以这里把四个动作转给薄层：
//   派活/叫人 → `spawnOrReuseTeammate`（**同角色先复用**：这一档有能接活的就把活派给它）
//   读名册   → `listTeammates`（就是内置 `list_agents` 那一处正文）
//   发消息   → `sendToTeammate`（等变化用宿主的 `wait_agent`，本插件不再包一层）

/** 角色定义 → 薄层要的那几样（取名靠 id、身份段靠路径）。 */
export function roleBriefingOf(definition, role) {
	return {
		role,
		title: definition?.title,
		duty: definition?.positioning,
		roleFile: definition?.file,
		baselineFile: baselinePath(),
	}
}

/** 现场枚举出来的角色 id 列表（薄层按它认名字前缀）。 */
export function roleIdsOf(rosterSource) {
	const known = typeof rosterSource?.catalog === 'function' ? rosterSource.catalog() : []
	return (Array.isArray(known) ? known : []).filter((id) => typeof id === 'string' && id !== '')
}

/** `member_spawn`：同角色先复用，没有再新建（两条硬上限在薄层里判：同角色位数 + 在场总人数）。 */
export async function nativeSpawnMember(ctx, exec, args, rosterSource, config) {
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
	// **收口前的落点**（人的设计）：压缩会把细节压成摘要，检查点是「不丢 + 可读」的那一半。
	// 一句话跟着每次派活走，成员不必记得另外一条纪律。
	const checkpointRule = '【收口前】这条活有结论/产物时，收口前用 `team_checkpoint action=write task=<看板上的 task-N>` 落一份检查点（事实 / 决定 / 产物路径 / 未决 / 下一步）。'
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
		prompt: `${task}\n\n${checkpointRule}`,
		context: args.context === 'fork' ? 'fork' : 'fresh',
		// **provider 必填**：新宿主按它选后端（fresh → `memberProvider`，fork → `memberForkProvider`），
		// 旧宿主也要求非空。显式 `args.provider` 优先。
		provider:
			typeof args.provider === 'string' && args.provider !== ''
				? args.provider
				: args.context === 'fork'
					? config.memberForkProvider
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
		const content = `${NL.skillsLineOf(definition?.skills)}\n\n${task}\n\n${checkpointRule}`
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
export async function nativeListMembers(ctx, exec, args, rosterSource) {
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
export async function nativeSendMember(ctx, exec, args) {
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
 * 落在工作区的 `.ops/member-flags.json`（复用既有账本管道），回执里带 `note` 那句原话。
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
	if (changed.length > 0) invalidateRoleRecords()
	return { changed, packageRoles, scanned: records.length }
}

/** `member_defaults`：能叫谁（现场枚举的角色）+ **这一档现在有谁**（原生名册）。 */
export async function nativeDefaults(ctx, exec, rosterSource) {
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

/**
 * **技能目录的现读**（与面板「技能」栏**同一条读法**，不许另写一份）。
 *
 * 口径：`ctx.get('skills').snapshot(skillViewOptions(工作区, skillScopeOf(ctx, 会话 id)))` ——
 * 作用域那条退法（session → root-agent → global）的唯一正文在 `lib/skill-scope.js`。
 * 读不到要说**读不到**，不许说成"一个技能都没有"（那会让人以为技能名真的不存在）。
 * @returns `{ ok: true, names, layer, why }` 或 `{ ok: false, reason }`。
 */
export async function skillCatalogOf(ctx, exec) {
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
export function skillUnknownOf(names, catalog) {
	const unknown = names.filter((name) => !catalog.names.includes(name))
	if (unknown.length === 0) return null
	const options = catalog.names.slice(0, 20)
	return (
		`这些技能名不在本机技能目录里：${unknown.join('、')}。` +
		`目录里现在有（最多列 20 个）：${options.length === 0 ? '（空）' : options.join('、')} —— ` +
		'技能目录是**按会话作用域现读**的（这一层读到的是 ' + catalog.layer + '），要写就写 `available_skills` 里出现的名字。'
	)
}
