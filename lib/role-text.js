/**
 * 角色定义的**文本层**：front-matter 解析、标题 / 定位句 / 触发语提取、
 * 角色定义全文的构造与补丁。
 *
 * 这一层不碰 ctx、不读文件 —— 从 `team/team-runtime.js` 分出来之后，
 * 引擎只保留"枚举、写盘与工具"；构造与解析的规则在宿主侧也能直接测。
 */

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

