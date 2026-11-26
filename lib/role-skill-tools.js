/**
 * `role_define` / `skill_define` 两个能力沉淀工具：边界声明、入参组装与回执。
 *
 * 从 `team/team-runtime.js` 分出来之后，引擎只剩 `apply`（工具表 + 注入段）与装载；
 * 这两个工具只做「校验 → 组装 → 走既有写入层 → 回读 → 回执」，不另造写路径。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runtimeBridge as B } from '../team/company-gate.js'
import * as NL from '../team/native-layer.js'
import { defaultRosterOf, defaultRosterView, nativeDefaults, nextMemberNameFor, skillCatalogOf, skillUnknownOf } from './member-engine.js'
import { readDisabledNames } from './member-flags.js'
import { invalidateRoleRecords } from './role-record-cache.js'
import { createRole, roleCatalog, roleDefinitionTextOf, roleRecords, roleRecordsFor, roleRootRecords, roleWriteEffects } from './role-store.js'
import { positioningOfRole, roleDefinitionOf, rolePersonaOf } from './role-persona.js'
import { parseFrontMatter, patchRoleText, roleTextOf } from './role-text.js'
import { roleIdFindings, roleRootOf, roleScopeLine, writeRoleDefinition } from './roster.js'
import { createSkill, skillIdFindings, skillRootOf, updateSkill } from './skill-write.js'

/**
 * `role_define` 的边界声明（**两个作用域**；逐字点名它真写的那一份文件）。
 *
 * 从前这句写的是"只写**工作区之外**的用户级角色根" —— 角色加了作用域之后它**写反了**（缺省落**工作区内**）。
 */
export const WRITE_BOUNDARY_ROLE_DEFINE =
	'边界：只写**角色根**里的一份 `roles/<id>/ROLE.md` —— **缺省写本工作区的角色根**（`<工作区>/.dsh/team-ops/roles/`，' +
	'只影响这个工作区）；**显式 `scope: "user"` 才写全局用户根**（`$DSH_TEAM_OPS_ROLES`，缺省 `~/.dsh/team-ops/roles/`，**所有工作区可见**）。' +
	'同名已存在时必须显式 `mode: update`，覆盖前留一份 `ROLE.md.bak`。**不派活、不改看板、不改别人的角色或技能**；' +
	'除上面那一份角色文件之外不写别的文件（工作区里只写 `.dsh/team-ops/roles/` 这一处），不删文件，不移动文件。' +
	'写盘后**工具面立刻可用**：`member_defaults` / `member_spawn` 是现枚举这份名册的（本机现场验过：建完立刻列出它、立刻派得出人，成员的装备也对）；' +
	'**只有注入到系统提示里那份「可叫的队友」清单是装载时的快照，要重启 DSH 才更新** —— 那一条不影响能不能叫人。'

/** `skill_define` 的边界声明（**两个作用域**）。 */
export const WRITE_BOUNDARY_SKILL_DEFINE =
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
 * `role_define`：把一段对话里定下来的角色**沉淀成一份角色定义**。
 *
 * 五条校验（每条都能当场拒，并给出可照做的原文）：① id 形状；② 重名必须 `mode: update` 并点明改哪一份；
 * ③ `skills` 里每个名字必须真在本机技能目录里（读法与面板同一处）；④ 四段（positioning / scope /
 * checklist / deliverables）缺一段就拒；⑤ 写盘后回读（front-matter 可解析、`kind: role`、
 * `roleCatalog()` 枚举得到、`member_defaults` 里有它、这一档现在有没有成员）。
 */
export async function roleDefine(ctx, exec, args) {
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
	invalidateRoleRecords()

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
export async function skillDefine(ctx, exec, args) {
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

