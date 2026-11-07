/**
 * **薄的角色感知层**：把 DSH 原生 Agent Teams 的成员与任务接口，包成"按角色办事"的那几个动作。
 *
 * 为什么要有这一层：原生队伍（`ctx.agentTeams`）只有三种身份 —— `lead` 和 `teammate`，
 * 成员行上**没有角色字段**，也没有任何"同一角色先复用"的判断。角色这套东西是本插件的资产
 * （19 份 `ROLE.md` 的职责边界、检查表、落点），所以由这一层来补：
 *
 *   · 取名约定 `<角色 id>-<序号>` —— 名字里带得出角色，原生名册因此**能被读成"哪一档有谁"**；
 *   · **复用优先**：派活前先看这一档有没有现成的成员，有就把活派给它（`sendMessage`，原生对空闲成员
 *     会唤醒或冷恢复），没有才 `spawnTeammate`；
 *   · **两条硬上限**：同角色 ≤ `MEMBER_ROLE_MAX` 位、**在场总人数** ≤ `MEMBER_PRESENT_MAX` 位（口径见 `company-gate.js`，
 *     这里只是按原生名册现算）；
 *   · **身份走提示词**：原生 `spawnTeammate` 的 request 只有 `name` / `description` / `prompt` /
 *     `context` / `provider`，**没有 `persona` 字段** —— 所以角色的身份与作业程序只能按路径写进首活提示词。
 *
 * 原生那边的接口（`TeamService`，读自宿主实现）：
 *   `spawnTeammate(caller, { name, description, prompt, context, provider, signal })`
 *   `sendMessage(caller, { target, content, signal })`
 *   `createTask(caller, request)` / `getTask(caller, id)` / `listTasks(caller)` / `updateTask(caller, request)`
 *   `listMembers(membership)`（面板读原生名册用的就是它）
 * 其中 `caller` 必须是**确切的活着的队内 agent**（主会话自己，即 Lead）。
 */

import { MEMBER_PRESENT_MAX, MEMBER_ROLE_MAX } from '../lib/team-limits.js'

/**
 * 把一段纯文本包成原生要的**内容块数组** —— 本层与原生之间唯一那道缝里的形状转换。
 *
 * **为什么必须是块**（两条路都吃块数组 —— 只是形状不对时报错方式不同：消息路**立刻抛**，提示词路**静默变味**）：
 *   · 读回放那一侧是**有 schema** 的：队伍日志里消息与首活提示词的内容都是
 *     `content: z.array(contentBlockSchema)`（宿主 `dsh-experimental-agent-team/lib/index.js:1179`；
 *     `contentBlockSchema` 是同文件 `:1121` 的 `z.union`，文本块的形状是 `{ type: 'text', text: string }`）。
 *   · **写路径不校验形状**：`mailbox.send` 先把字符串原样落进队伍日志（落库前只过 `structuredClone`
 *     与字节数上限，没有任何 schema 校验），但**坏事件一落库，投影立刻置 failure** —— `journal.state()`
 *     读到 `projection.failure` 就抛（`AT:129-132`），而投递那一步紧接着就要读一次日志状态
 *     （`AT:893`），于是**这次调用本身就会抛**：`parsePersisted` 把 schema 失败包成
 *     `persisted Agent Teams <事件类型> payload is invalid`（`AT:1239-1245`）。并且**此后每一次
 *     journal 读都在同一个地方抛这句**：队伍日志是**整条一起回放**的，投影把 failure 一直带着
 *     （`AT:1269-1283`），所以这一条坏事件污染的不是那一条消息，而是整条日志
 *     （现场症状：`member_send` 恒报 `persisted Agent Teams team/message/queued payload is invalid`）。
 *   · 宿主自己的两个工具就是这么传的：`spawn_teammate` 传 `prompt: [ …块 ]`（`dsh-experimental-tool-agent-team/lib/index.js:274`）、
 *     `send_message` 传 `content: [{ type: 'text', text: args.message }]`（同文件 `:314`）。
 *   · **提示词那条路的报错口径与消息路不同（但一样要包块）**：`spawnTeammate` 会把首活提示词再递一次
 *     `withContinuableReturnGuidance`（宿主 `dsh-subagent/lib/types/continuation-messages.js:36` 的函数声明，
 *     它拿 `[...prompt]` 展开 —— 同一文件 `:39`；调用点在 `dsh-subagent/lib/index.js:1738` 的那个三元）。
 *     字符串喂进去**不会**抛上面那句 schema 错，而是被按**字符**摊成单个字符块，提示词**静默变味** ——
 *     错得更安静，不是没错。所以这里对两条路用同一道包块处理；测试假件对提示词那条路也照同一句话拦，
 *     是**有意的更严**（宁可让"形状不对"只有一个认得出的红色信号，不要一条静默变味的路）。
 *
 * 所以这里**只换外壳形状，不动正文文本**（不加宿主那条 `system-reminder` 块：插件已经把自己的身份段
 * 写进首活提示词了，再叠一层只会多一份要跟着改的副本）。
 */
function textBlocks(text) {
	return [{ type: 'text', text: String(text ?? '') }]
}

/** 原生服务是否可用（`spawnTeammate` 在才算数 —— 只有只读半边不算）。 */
export function nativeTeamOf(ctx) {
	const service = typeof ctx?.get === 'function' ? ctx.get('agentTeams') : undefined
	if (service === undefined || service === null) return null
	return typeof service.spawnTeammate === 'function' ? service : null
}

/**
 * 从成员名里读出角色 id（取名约定 `<角色 id>-<序号>`；不认的返回空串，**不猜**）。
 * 按最长前缀匹配：`data-eng-2` 要读成 `data-eng`，不能被 `data` 前缀骗到。
 * @param name - 成员名。
 * @param roleIds - 现场枚举出来的角色 id 列表。
 */
export function roleOfName(name, roleIds) {
	const value = typeof name === 'string' ? name : ''
	let best = ''
	for (const id of Array.isArray(roleIds) ? roleIds : []) {
		const prefix = `${id}-`
		if (!value.startsWith(prefix)) continue
		const tail = value.slice(prefix.length)
		if (!/^\d+$/.test(tail)) continue
		if (id.length > best.length) best = id
	}
	return best
}

/** 名册里这一档已经用过的号（**用过的号不复用** —— 名字与人对得上，是追责的前提）。 */
export function takenNumbersOf(role, names) {
	const used = new Set()
	const prefix = `${role}-`
	for (const name of Array.isArray(names) ? names : []) {
		if (typeof name !== 'string' || !name.startsWith(prefix)) continue
		const tail = name.slice(prefix.length)
		if (/^\d+$/.test(tail)) used.add(Number(tail))
	}
	return used
}

/** 下一个可用名字：`<角色 id>-<序号>`。 */
export function nextMemberNameFor(role, names) {
	const used = takenNumbersOf(role, names)
	let n = 1
	while (used.has(n)) n += 1
	return `${role}-${n}`
}

/**
 * 这一档**现在还有谁**（按名字约定读原生名册）。
 * @returns `{ all, usable, disabled }`：`all` 是这一档的全部成员名；`usable` 是"**还能接活**"的那些
 *   （原生里 `failed` 的不能；**被本插件停用的也不算** —— 停用者不占**角色槽位**、也不被自动复用，见 `lib/member-flags.js`）；
 *   `disabled` 是被停用的那些（它们在原生名册里**仍然在**，所以单列出来给面板说清）。
 * @param disabledNames - 本插件这一层的停用名单（可选）。
 */
export function teammatesOfRole(role, members, roleIds, disabledNames = []) {
	const disabledSet = new Set(Array.isArray(disabledNames) ? disabledNames : [])
	const all = []
	const usable = []
	const disabled = []
	for (const row of Array.isArray(members) ? members : []) {
		if (row === null || typeof row !== 'object') continue
		if (row.role !== 'teammate') continue
		if (roleOfName(row.name, roleIds) !== role) continue
		all.push(row.name)
		if (disabledSet.has(row.name)) disabled.push(row.name)
		if (row.status !== 'failed' && !disabledSet.has(row.name)) usable.push(row.name)
	}
	return { all, usable, disabled }
}

/** 原生名册的形状收敛：只留标量叶子（与面板同一条纪律：读不到就是读不到，不补行、不排序）。 */
export function shapeTeammateRows(raw) {
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

/**
 * 两条硬上限的判定（口径与 `company-gate.js` 的常量一处）：到顶就拒绝，除非调用方写了 `line_reason`。
 *
 * **历史**：HD-004 那条"在场角色种类 ≤ 8"已在 HD-005 里删掉（它会在"种类满 8、总数远不到 24"时卡住新角色）；
 * 现在管住总数就够了 —— **同角色 ≤3 位 + 在场总数 ≤24 位**。
 * @returns `null` 放行；否则一句可读的拒绝理由。
 */
export function memberCapFindings({ role, members, roleIds, lineReason, disabledNames }) {
	if (typeof lineReason === 'string' && lineReason.trim() !== '') return null
	const same = teammatesOfRole(role, members, roleIds, disabledNames)
	if (same.usable.length >= MEMBER_ROLE_MAX) {
		return (
			`这一档已经有 ${same.usable.length} 位成员（上限 ${MEMBER_ROLE_MAX}）：${same.usable.join('、')}。` +
			`（**停用者不算这 ${MEMBER_ROLE_MAX} 位的角色槽位** —— 要腾角色槽位就把旧的那位停用，再建一位换干净上下文。）\n` +
			`要干活先派给现有的那几位（member_send({ target: "<名字>", message })）—— 复用不付冷启动，它上下文里还有这个工作区的来龙去脉。` +
			`确实需要下一位，就在这次调用里带 line_reason 写清为什么。`
		)
	}
	// 第二条：**在场总人数**——**数全部名册行（含 `failed`）**。
	//
	// **为什么含 failed**（复核凿出来的真错）：宿主那道硬拒是
	// `if (state.members.length >= this.maxMembers) throw new TeamError('Team member limit … reached', 'TEAM_MEMBER_LIMIT')`
	// —— `state.members` 是**全部名册行、不按 phase 过滤**。我们若把 `failed` 排除在外，就会出现
	// "23 位在用 + 1 位 failed（宿主眼里 24 行）"时**插件放行、宿主抛 `TEAM_MEMBER_LIMIT`** 的分叉：
	// 人看到的是宿主那句生硬报错，而不是我们这条能照做的拒绝。两层**值同、成员范围也同**才叫真的对齐。
	//
	// 与**上面那条**的区别（别把两条改成一个口径）：同角色 ≤ `MEMBER_ROLE_MAX` 是"**这一档还能不能干活**"
	// （`failed` 的不算人），这条是"**宿主那堵墙还放不放得下**"（`failed` 也占一行）。被停用的成员两条都数。
	const rows = (Array.isArray(members) ? members : []).filter((row) => row?.role === 'teammate')
	const failedCount = rows.filter((row) => row?.status === 'failed').length
	if (rows.length + 1 > MEMBER_PRESENT_MAX) {
		return (
			`在场已经有 ${rows.length} 位（**在场总人数上限 ${MEMBER_PRESENT_MAX}，含已失败的成员**` +
			`${failedCount > 0 ? `，其中 ${failedCount} 位是 failed` : ''}）：先把不用的收掉（面板上可以**停用**它们），` +
			`或者给这次调用带上 line_reason 说明为什么还要加人。\n` +
			`（同角色的活优先交给同一位成员；**上限算法**：同角色 ≤ ${MEMBER_ROLE_MAX} 位 × 8 个角色 = ${MEMBER_PRESENT_MAX} 位 —— ` +
			`这个数与宿主那份 maxMembers 同值，**数的也是同一批成员**。）`
		)
	}
	return null
}

/**
 * **身份段**（原生没有 `persona` 字段，所以这段要写在首活提示词的最前面）。
 *
 * 只给**路径**与**动作**，不搬 `ROLE.md` 正文：文件是真相源，成员动手前自己去读
 * （搬进来就会与文件分叉，而且 19 份正文加起来两万多字）。
 */
/**
 * **装备那一行**（角色定义 front-matter 的 `skills:`）。两处用它，所以只有一处措辞：
 *   · 建成员时进身份段（`roleBrief`）；
 *   · **复用派活时跟着消息再教一遍** —— 原生成员的提示词是出生时写进队伍日志的（没有"改成员"的接口），
 *     所以在这处修复之前建出来的成员身份段里没有这一行；每次派活带上它，它们也能重新知道自己的装备。
 * 空的那一支也要说话：只写"没有专属技能"会被读成"没技能可用"（现场踩过）。
 */
export function skillsLineOf(skills) {
	const exclusive = (Array.isArray(skills) ? skills : [])
		.map((item) => String(item ?? '').trim())
		.filter((item) => item !== '')
	return exclusive.length === 0
		? '- 本角色**没有常驻的专属技能**；但会话里那份技能目录（`<available_skills>`）照常可用 —— ' +
				'任务对得上其中任何一项时，**动手之前先调 `skill` 载入它**，按它写的做法做（不是可选参考）。'
		: '- 本角色常驻的作业程序：' +
				exclusive.join('、') +
				'。**做属于这些能力的事之前，先调 `skill` 把它们载入，按它写的做法做**（这些是角色专属的作业程序，' +
				'不是可选参考；读不到就如实说读不到，别凭印象编一套）。会话里那份技能目录（`<available_skills>`）' +
				'里的其他技能同样可以按需载入。'
}

export function roleBrief({ role, name, title, duty, roleFile, baselineFile, skills }) {
	// **装备那一行**（角色定义 front-matter 的 `skills:`）：迁移到原生那条路时漏过一次 ——
	// 成员的会话里本来就有一份技能目录（宿主按 agent 注入 `<available_skills>`），所以这里要说两件事：
	// 哪些是**常驻**的（做这类事之前先载入）、以及目录里的其他技能**也能按需载入**。
	// 只写「本角色没有专属技能」会被读成「没技能可用」（现场踩过），所以空的那一支也要把目录指出来。
	const skillsLine = skillsLineOf(skills)
	return [
		`你是这个团队的「${title ?? role}」角色成员（角色 id \`${role}\`，成员名 \`${name}\`）。`,
		// **先把称呼钉死**（成员视角的三方对照）：协调者那段团队策略段注册在**全局**系统提示里，
		// **逐字也出现在你的提示词里** —— 现场发生过"成员读到'你的身份：协调器'以为说的是自己"
		// （靠点名规矩那句才没认错）。所以这里把 人 / lead / 你 钉到具体的人身上，并说清那段里
		// 哪些句子**不是写给你的**。
		'**先把称呼钉死**（这段与协调者那段团队策略段会同时出现在你的系统提示里）：'
			+ `**人** = 给这个团队下指令的人，**lead** = **你的协调者**（派活给你、你向它回报），`
			+ `**你** = 这个团队的「${title ?? role}」角色成员（成员名 \`${name}\`）—— 策略段里"你的身份：协调器"`
			+ '和那些命令句是**写给 lead 的**，不是写给你的，你按自己那份角色定义干活。',
		duty === undefined || duty === '' ? '' : `你的角色定位：${duty}`,
		'',
		'**动手前先读你的作业程序**（身份、职责边界、检查表、落点、产物形态都在那儿；文件是真相源）：',
		`\`${roleFile}\``,
		'读不到就**如实说读不到**、把这一条写进回报，不要按印象编一份出来。',
		'',
		skillsLine,
		'',
		'## 协作纪律',
		'',
		'- 你只在自己的角色职责内下结论；跨角色的事回给 lead（`send_message` target 填 `lead`）转派。',
		'- 交付要落成文件，关键事实可核；没核实的部分点名说没核实。',
		'- 共享任务板：`team_task_get` 读、`team_task_update` 收口（认领与收口都要带 `expected_revision`）—— 版本对不上就是"有人先改过"，重读再改。',
		'- 团队规则读这个文件：' + `\`${baselineFile}\`` + '。',
	].join('\n')
}

/**
 * **复用优先的派活**：这一档已经有能接活的成员时，把活派给它；否则才新建一位。
 *
 * 为什么复用要写在这一层：原生没有角色概念、也没有"先看看有没有人"的动作，而现场反复证明
 * （同一个角色叫到第 7 位、第 14 位）光靠提示拦不住。这里是**代码保证**。
 *
 * @param ctx - 宿主 ctx（`agentTeams` 可选服务）。
 * @param caller - 确切的活着的 Lead agent（主会话自己）。
 * @param request - `{ role, roleIds, name?, title?, duty?, roleFile, baselineFile, description, prompt, context?, provider?, lineReason?, reuse, signal? }`
 *   `reuse` 为 `true` 时才复用现有成员；缺省 `false` 表示"这次要新起一位"（仍会做上限判定并给出提示）。
 *   `signal` 是调用方的取消信号：**必须原样转给原生**（见下面的"signal 契约"）。
 * @returns `{ ok, action: 'reused' | 'spawned', name, reason?, row? }`。
 *
 * **signal 契约（三条路同一条）**：原生那几个入口**无条件**解引用 `request.signal`
 * （`AbortSignal.any([request.signal, lifecycle.signal])` / `signal.throwIfAborted()`），
 * 收到 `undefined` 当场抛 —— 所以调用方拿得到信号就必须传下来；拿不到时**不传这个键**
 * （传 `undefined` 与不传在原生那一侧是同一件事，但少一个键至少不会把"缺信号"伪装成"有信号"）。
 */
export async function spawnOrReuseTeammate(ctx, caller, request) {
	const service = nativeTeamOf(ctx)
	if (service === null) return { ok: false, action: 'unavailable', name: '', reason: '这个部署没有原生 Agent Teams 服务（`ctx.agentTeams` 取不到）：成员与任务走不了原生那条路。' }
	const role = String(request?.role ?? '')
	if (role === '') return { ok: false, action: 'bad-request', name: '', reason: 'role 必填：先确定这件事该由哪一档角色承接。' }
	let members = []
	try {
		members = shapeTeammateRows(service.listMembers(caller))
	} catch (error) {
		return { ok: false, action: 'unavailable', name: '', reason: `读不到原生名册：${error?.message ?? String(error)}` }
	}
	const same = teammatesOfRole(role, members, request.roleIds, request.disabledNames)
	// **自动复用跳过停用者**（HD-006）：`usable` 里已经没有它们了（`teammatesOfRole` 那一处是唯一正文）。
	if (request.reuse === true && same.usable.length > 0) {
		return { ok: true, action: 'reused', name: same.usable[0], members: same.usable }
	}
	const findings = memberCapFindings({ role, members, roleIds: request.roleIds, lineReason: request.lineReason, disabledNames: request.disabledNames })
	if (findings !== null) return { ok: false, action: 'over-cap', name: '', reason: findings }
	// 原生把 `provider` 当**必填**（`requiredText`），缺了会抛一句与真因无关的 TypeError ⇒ 这里先拦，
	// 给一句能照做的：provider 是"用哪个子代理提供方起这个人"，由调用方（引擎）从配置里取。
	if (typeof request.provider !== 'string' || request.provider === '') {
		return { ok: false, action: 'bad-request', name: '', reason: 'provider 必填：原生队伍的成员记录要求它（缺省取配置里那一档，调用方要传下来）。' }
	}
	const name = typeof request.name === 'string' && request.name !== '' ? request.name : nextMemberNameFor(role, members.map((row) => row.name))
	const brief = roleBrief({
		role,
		name,
		title: request.title,
		duty: request.duty,
		roleFile: request.roleFile,
		baselineFile: request.baselineFile,
		// **这一跳不能漏**：运行时把角色声明的常驻技能放在 `request.skills` 里传过来，
		// 忘了往下给 ⇒ 身份段里那一行就成了空的那一支（现场就是这么又漏了一次）。
		skills: request.skills,
	})
	try {
		const row = await service.spawnTeammate(caller, {
			name,
			description: typeof request.description === 'string' && request.description !== '' ? request.description : (request.duty ?? role),
			// 首活提示词走**块数组**（见 `textBlocks` 上面那段）：字符串在这条路上不抛 schema 错，
			// 而是被宿主 `[...prompt]`（`dsh-subagent/lib/types/continuation-messages.js:39`）摊成单个字符，静默变味。
			prompt: textBlocks(`${brief}\n\n---\n\n${String(request.prompt ?? '')}`),
			context: request.context === 'fork' ? 'fork' : 'fresh',
			provider: request.provider,
			...(request.signal === undefined ? {} : { signal: request.signal }),
		})
		return { ok: true, action: 'spawned', name, row }
	} catch (error) {
		return { ok: false, action: 'spawn-failed', name, reason: error?.message ?? String(error) }
	}
}

/**
 * 给某个成员发一条消息（原生的持久点对点消息 + 立即投递尝试）。`request.signal` 按上面的 signal 契约转给原生。
 *
 * **调用面只收字符串正文**（`request.content`）：块的形状是本层的事 —— 调用方（`team-runtime.js`
 * 的 `member_send` / 复用分支的派活）传文本，这里包成宿主 schema 要的块数组（见 `textBlocks`）。
 */
export async function sendToTeammate(ctx, caller, request) {
	const service = nativeTeamOf(ctx)
	if (service === null) return { ok: false, reason: '这个部署没有原生 Agent Teams 服务（`ctx.agentTeams` 取不到）。' }
	if (typeof service.sendMessage !== 'function') return { ok: false, reason: '原生服务没有 sendMessage。' }
	try {
		const outcome = await service.sendMessage(caller, {
			target: String(request?.target ?? ''),
			// 正文必须是块数组：宿主 `send_message` 传的正是 `[{ type: 'text', text: args.message }]`，
			// 写路径不校验，但坏事件一落库投影即失败，这次调用与之后每次 journal 读都会抛
			// `persisted Agent Teams team/message/queued payload is invalid`（口径见 `textBlocks` 上面那段）。
			content: textBlocks(request?.content),
			...(request?.signal === undefined ? {} : { signal: request.signal }),
		})
		return { ok: true, outcome }
	} catch (error) {
		return { ok: false, reason: error?.message ?? String(error) }
	}
}

/** 读原生名册（就是 `list_agents` 那一处正文）。 */
export async function listTeammates(ctx, caller) {
	const service = nativeTeamOf(ctx)
	if (service === null) return { ok: false, reason: '服务不在' }
	try {
		return { ok: true, rows: shapeTeammateRows(service.listMembers(caller)) }
	} catch (error) {
		return { ok: false, reason: error?.message ?? String(error) }
	}
}

/**
 * 任务板：把四个动作转给原生（CAS 由原生的 `expected_revision` 负责，本层不另做一套）。
 * @param action - `create` / `get` / `list` / `update`。
 */
export async function boardCall(ctx, caller, action, fields = {}) {
	const service = nativeTeamOf(ctx)
	if (service === null) return { ok: false, reason: '这个部署没有原生 Agent Teams 服务（`ctx.agentTeams` 取不到）。' }
	try {
		if (action === 'create') return { ok: true, value: await service.createTask(caller, fields) }
		if (action === 'get') return { ok: true, value: service.getTask(caller, fields.id) }
		if (action === 'list') return { ok: true, value: service.listTasks(caller) }
		if (action === 'update') return { ok: true, value: await service.updateTask(caller, fields) }
		return { ok: false, reason: `不认的动作：${String(action)}（只支持 create / get / list / update）` }
	} catch (error) {
		return { ok: false, reason: error?.message ?? String(error) }
	}
}

/**
 * 等一次原生队伍域的变化（成员状态边、消息、任务）。
 * @param timeoutMs - 等待时长（原生只收 10000 ~ 3600000 的整数；缺省由调用方补）。
 * @param signal - 调用方的取消信号，**必须传**（原生 `activity.wait` 第一件事就是 `signal.throwIfAborted()`）。
 */
export async function waitForTeammates(ctx, caller, timeoutMs, signal) {
	const service = nativeTeamOf(ctx)
	if (service === null) return { ok: false, reason: '这个部署没有原生 Agent Teams 服务（`ctx.agentTeams` 取不到）。' }
	if (typeof service.waitForChange !== 'function') return { ok: false, reason: '原生服务没有 waitForChange。' }
	try {
		return { ok: true, value: await service.waitForChange(caller, timeoutMs, signal) }
	} catch (error) {
		return { ok: false, reason: error?.message ?? String(error) }
	}
}

/** 这一档现在有谁（薄层的对外读数：`member_defaults` 用）。 */
export async function roleStaffing(ctx, caller, roleIds, disabledNames = []) {
	const listed = await listTeammates(ctx, caller)
	if (listed.ok !== true) return listed
	const disabled = new Set(Array.isArray(disabledNames) ? disabledNames : [])
	const byRole = new Map()
	for (const row of listed.rows) {
		const role = roleOfName(row.name, roleIds)
		if (role === '') continue
		const bucket = byRole.get(role) ?? []
		// **停用者不在这一档的"能接活"清单里**（HD-006）——`roleStaffing` 与 `teammatesOfRole`
		// 是同一件事的两个读法，两处都得让停用者出局（否则 `member_defaults` 会说"这一档有人"）。
		if (row.status !== 'failed' && !disabled.has(row.name)) bucket.push({ name: row.name, status: row.status })
		byRole.set(role, bucket)
	}
	return { ok: true, byRole }
}
