/**
 * **角色包**：把本机自建的角色（以及它们引用的自建技能）打成一个文件，再还原到另一台机器。
 *
 * 为什么要有这一层：角色的真相源是目录（`roles/<id>/ROLE.md`），包内那份是发布面、升级会整份替换。
 * 人自己建的角色只活在本机 —— 换机器、给同事、备份，全得手动拷目录。这一段把「拷目录」变成
 * 「一个文件」，并且把其中的判定收在一处：**包是不是包、id 合不合法、路径会不会越界、体量与份数、
 * 冲突怎么处理**。宿主的两个端点与命令行都只是它的调用方（面板不含判定）。
 *
 * 三条与包内其余写入路径一致的纪律：
 *   · **只写两个可写根**（工作区角色根 / 用户角色根及其同作用域的技能根）—— 包内根只读；
 *   · **默认不覆盖**：同名已存在就跳过；覆盖必须显式，且覆盖前留 `.bak`；
 *   · **先写暂存目录、再改名**：中途失败不在角色根里留半份角色。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readRoster, realInsideFindings, roleIdFindings, roleRootOf } from './roster.js'
import { skillIdFindings, skillRootOf } from './skill-write.js'

/** 包格式的**唯一标识与版本**（导出与导入都读这两格，别在别处再写一份）。 */
export const PACK_FORMAT = 'dsh-team-ops/role-pack'
export const PACK_FORMAT_VERSION = 1

/** 包体量上限（字节 / 角色数 / 每份角色的文件数）。超了一律拒绝并把实际数字说出来。 */
const PACK_MAX_BYTES = 8 * 1024 * 1024
const PACK_MAX_ROLES = 200
const PACK_MAX_FILES = 200

const ROLE_FILE = 'ROLE.md'
const SKILL_FILE = 'SKILL.md'
/** 角色目录里认的头像文件（与宿主 `AVATAR_TYPES` 同一批扩展名）。 */
const AVATAR_NAMES = ['avatar.svg', 'avatar.png', 'avatar.webp', 'avatar.jpg', 'avatar.jpeg']
/** 不随包走的文件：备份与暂存（它们是一次写入的残留，不是角色的一部分）。 */
const isBackupName = (name) => name.endsWith('.bak') || name.includes('.writing-') || name.startsWith('.importing-')

/** 插件版本（包里记一笔"谁打的包"）。读不到就不写 —— 不猜一个版本号出来。 */
function producerVersion() {
	try {
		const manifest = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
		return typeof manifest.version === 'string' ? manifest.version : ''
	} catch {
		return ''
	}
}

/** 来源（role 记录里的 `source`）→ 包里那一格能取的值。 */
function originOf(source) {
	return source === 'workspace' ? 'workspace' : 'user'
}

/**
 * 读一个角色目录里**该随包走**的文件：`ROLE.md` + 头像。
 * @returns `{ path, encoding, text|data }[]`，或 null（没有 ROLE.md）。
 */
function roleFilesOf(dir) {
	const out = []
	let text
	try {
		text = readFileSync(join(dir, ROLE_FILE), 'utf8')
	} catch {
		return null
	}
	out.push({ path: ROLE_FILE, encoding: 'utf8', text })
	for (const name of AVATAR_NAMES) {
		const file = join(dir, name)
		try {
			if (!statSync(file).isFile()) continue
			out.push({ path: name, encoding: 'base64', data: readFileSync(file).toString('base64') })
		} catch {
			continue
		}
	}
	return out
}

/** 递归收一份技能目录里的文件（跳过隐藏文件与备份/暂存残留）。 */
function skillFilesOf(dir) {
	const out = []
	const walk = (current, prefix) => {
		let entries = []
		try {
			entries = readdirSync(current, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.') || isBackupName(entry.name)) continue
			const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
			const full = join(current, entry.name)
			if (entry.isDirectory()) {
				walk(full, rel)
				continue
			}
			if (!entry.isFile()) continue
			if (out.length >= PACK_MAX_FILES) return
			const buffer = readFileSync(full)
			// 文本类按 utf8 存（可读、可 diff）；其它按 base64。判据是"能不能原样回写成同样的字节"。
			const decoded = buffer.toString('utf8')
			const roundTrip = Buffer.from(decoded, 'utf8')
			if (roundTrip.length === buffer.length && roundTrip.equals(buffer)) out.push({ path: rel, encoding: 'utf8', text: decoded })
			else out.push({ path: rel, encoding: 'base64', data: buffer.toString('base64') })
		}
	}
	walk(dir, '')
	if (!out.some((file) => file.path === SKILL_FILE)) return null
	return out
}

/**
 * 找出本机能看到的**自建角色**（来源不是包内），按既有枚举顺序去重。
 * @param workspace - 工作区绝对路径（项目级角色根要它）。
 * @param options - `{ scope: 'all'|'workspace'|'user', only: string[] }`。
 * @returns `[{ id, origin, dir, skills }]`。
 */
export function selfMadeRolesOf(workspace, { scope = 'all', only = [] } = {}) {
	const roster = readRoster([], { includeUser: true, workspace })
	const wanted = new Set(Array.isArray(only) ? only : [])
	return roster.roles
		.filter((role) => role.source === 'workspace' || role.source === 'user')
		.filter((role) => scope === 'all' || role.source === scope)
		.filter((role) => wanted.size === 0 || wanted.has(role.id))
		.map((role) => ({ id: role.id, origin: originOf(role.source), dir: join(role.root, role.id), skills: role.skills }))
}

/** 本机能看到的自建技能（两个可写技能根）。名字 → `{ dir, origin }`，同名时用户级优先（与角色枚举同向）。 */
function selfMadeSkillsOf(workspace) {
	const found = new Map()
	const roots = [
		{ root: skillRootOf('user'), origin: 'user' },
		{ root: skillRootOf('project', workspace), origin: 'workspace' },
	]
	for (const { root, origin } of roots) {
		if (root === null) continue
		let entries = []
		try {
			entries = readdirSync(root, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) continue
			if (found.has(entry.name)) continue
			if (!existsSync(join(root, entry.name, SKILL_FILE))) continue
			found.set(entry.name, { dir: join(root, entry.name), origin })
		}
	}
	return found
}

/**
 * **打包**：把当前能看到的自建角色（以及它们引用的自建技能）组成一个包对象。
 * @param options - `{ workspace, scope, only }`。
 * @returns `{ ok: true, pack }` 或 `{ ok: false, reason }`。
 */
export function buildRolePack({ workspace, scope = 'all', only = [] } = {}) {
	const roles = selfMadeRolesOf(workspace, { scope, only })
	if (roles.length === 0) {
		return {
			ok: false,
			reason:
				only.length > 0
					? `没有可导出的角色：${only.join('、')} 不在本机的自建角色里（包内角色不参与导出）。`
					: '没有可导出的自建角色：角色根里还没有你自己建的角色（包内角色不参与导出，它们随插件发布）。',
		}
	}
	if (roles.length > PACK_MAX_ROLES) {
		return { ok: false, reason: `一次最多导出 ${PACK_MAX_ROLES} 个角色，这次是 ${roles.length} 个 —— 分批导吧。` }
	}
	const availableSkills = selfMadeSkillsOf(workspace)
	const skillNames = new Set()
	const roleEntries = []
	for (const role of roles) {
		const files = roleFilesOf(role.dir)
		if (files === null) return { ok: false, reason: `角色 ${role.id} 的目录里读不到 ${ROLE_FILE}：${role.dir}` }
		for (const name of role.skills) if (availableSkills.has(name)) skillNames.add(name)
		roleEntries.push({ id: role.id, origin: role.origin, files })
	}
	const skillEntries = []
	for (const name of [...skillNames].sort()) {
		const found = availableSkills.get(name)
		const files = skillFilesOf(found.dir)
		if (files === null) continue
		skillEntries.push({ name, origin: originOf(found.origin), files })
	}
	const pack = {
		format: PACK_FORMAT,
		formatVersion: PACK_FORMAT_VERSION,
		createdAt: new Date().toISOString(),
		producer: { plugin: 'dsh-team-ops', version: producerVersion() },
		roles: roleEntries,
	}
	if (skillEntries.length > 0) pack.skills = skillEntries
	const text = serializeRolePack(pack)
	if (text.length > PACK_MAX_BYTES) {
		return { ok: false, reason: `这个包约 ${(text.length / 1024 / 1024).toFixed(1)} MB，超过 ${PACK_MAX_BYTES / 1024 / 1024} MB 上限 —— 去掉大文件或分批导出。` }
	}
	return { ok: true, pack }
}

/** 序列化（格式化，方便人看与 diff）。 */
export function serializeRolePack(pack) {
	return `${JSON.stringify(pack, null, 2)}\n`
}

/** 一条相对路径能不能安全落盘：不许绝对路径、不许 `..`、不许隐藏段、层级有上限。 */
function pathFindings(path) {
	if (typeof path !== 'string' || path.trim() === '') return ['文件路径为空']
	const pathText = path.trim()
	if (pathText.includes('\\')) return [`路径不许带反斜杠：${pathText}`]
	if (isAbsolute(pathText) || pathText.startsWith('/')) return [`路径不许是绝对路径：${pathText}`]
	const segments = pathText.split('/')
	const parts = []
	if (segments.length > 5) parts.push(`路径层级太深（${segments.length} 层，上限 5）：${pathText}`)
	for (const segment of segments) {
		if (segment === '' || segment === '.' || segment === '..') parts.push(`路径里有非法的一段（${JSON.stringify(segment)}）：${pathText}`)
		else if (segment.startsWith('.')) parts.push(`路径里不许有隐藏文件：${pathText}`)
	}
	if (pathText.length > 200) parts.push(`路径太长（${pathText.length} 字符）：${pathText}`)
	return parts
}

/** 一条文件记录的内容：`encoding` 只认 utf8 / base64。 */
function fileBodyFindings(file, where) {
	const parts = []
	if (file === null || typeof file !== 'object' || Array.isArray(file)) return [`${where} 的文件项不是一个对象`]
	parts.push(...pathFindings(file.path))
	if (file.encoding === 'utf8') {
		if (typeof file.text !== 'string') parts.push(`${where} 的 ${String(file.path)} 是 utf8，但 text 不是字符串`)
	} else if (file.encoding === 'base64') {
		if (typeof file.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) parts.push(`${where} 的 ${String(file.path)} 是 base64，但 data 不是合法 base64`)
	} else {
		parts.push(`${where} 的 ${String(file.path)} 的 encoding 认不出：${JSON.stringify(file.encoding)}（只认 utf8 / base64）`)
	}
	return parts
}

/**
 * 校验一个包对象（导出侧与导入侧共用同一套判据）。
 * @returns 空数组即合格；否则一行行可照做的原因。
 */
export function packFindings(pack) {
	if (pack === null || typeof pack !== 'object' || Array.isArray(pack)) return ['包不是一个 JSON 对象']
	const parts = []
	if (pack.format !== PACK_FORMAT) parts.push(`不是角色包：format 应为 ${JSON.stringify(PACK_FORMAT)}，收到 ${JSON.stringify(pack.format)}`)
	if (pack.formatVersion !== PACK_FORMAT_VERSION) {
		parts.push(`包格式版本认不出：这个版本只认 ${PACK_FORMAT_VERSION}，收到 ${JSON.stringify(pack.formatVersion)} —— 不猜、不降级导入`)
	}
	if (parts.length > 0) return parts
	if (!Array.isArray(pack.roles) || pack.roles.length === 0) parts.push('包里没有角色（roles 必须是至少一条的数组）')
	if (Array.isArray(pack.roles) && pack.roles.length > PACK_MAX_ROLES) parts.push(`包里角色太多：${pack.roles.length} 个（上限 ${PACK_MAX_ROLES}）`)
	if (pack.skills !== undefined && !Array.isArray(pack.skills)) parts.push('skills 给了就必须是数组')
	if (Array.isArray(pack.skills) && pack.skills.length > PACK_MAX_ROLES) parts.push(`包里技能太多：${pack.skills.length} 个（上限 ${PACK_MAX_ROLES}）`)

	const seen = new Set()
	for (const role of Array.isArray(pack.roles) ? pack.roles : []) {
		if (role === null || typeof role !== 'object' || Array.isArray(role)) {
			parts.push('roles 里有一项不是对象')
			continue
		}
		const id = typeof role.id === 'string' ? role.id.trim() : ''
		parts.push(...roleIdFindings(id).map((line) => `角色 ${JSON.stringify(role.id)}：${line}`))
		if (seen.has(id)) parts.push(`角色 ${id} 在包里出现了两次`)
		seen.add(id)
		if (role.origin !== undefined && role.origin !== 'user' && role.origin !== 'workspace') parts.push(`角色 ${id} 的 origin 认不出：${JSON.stringify(role.origin)}（只认 user / workspace）`)
		if (!Array.isArray(role.files) || role.files.length === 0) {
			parts.push(`角色 ${id} 没有文件`)
			continue
		}
		if (role.files.length > PACK_MAX_FILES) parts.push(`角色 ${id} 的文件太多：${role.files.length} 个（上限 ${PACK_MAX_FILES}）`)
		for (const file of role.files) parts.push(...fileBodyFindings(file, `角色 ${id}`))
		const paths = role.files.filter((file) => file !== null && typeof file === 'object').map((file) => file.path)
		if (!paths.includes(ROLE_FILE)) parts.push(`角色 ${id} 没有 ${ROLE_FILE}`)
		for (const path of paths) {
			if (typeof path === 'string' && path !== ROLE_FILE && !AVATAR_NAMES.includes(path)) {
				parts.push(`角色 ${id} 里有一个不认识的文件：${path}（角色目录只认 ${ROLE_FILE} 与头像 ${AVATAR_NAMES.join(' / ')}）`)
			}
		}
	}

	const seenSkills = new Set()
	for (const skill of Array.isArray(pack.skills) ? pack.skills : []) {
		if (skill === null || typeof skill !== 'object' || Array.isArray(skill)) {
			parts.push('skills 里有一项不是对象')
			continue
		}
		const name = typeof skill.name === 'string' ? skill.name.trim() : ''
		const nameFindings = skillIdFindings(name)
		parts.push(...nameFindings.map((line) => `技能 ${JSON.stringify(skill.name)}：${line}`))
		if (seenSkills.has(name)) parts.push(`技能 ${name} 在包里出现了两次`)
		seenSkills.add(name)
		if (skill.origin !== undefined && skill.origin !== 'user' && skill.origin !== 'workspace') parts.push(`技能 ${name} 的 origin 认不出：${JSON.stringify(skill.origin)}`)
		if (!Array.isArray(skill.files) || skill.files.length === 0) {
			parts.push(`技能 ${name} 没有文件`)
			continue
		}
		if (skill.files.length > PACK_MAX_FILES) parts.push(`技能 ${name} 的文件太多：${skill.files.length} 个（上限 ${PACK_MAX_FILES}）`)
		for (const file of skill.files) parts.push(...fileBodyFindings(file, `技能 ${name}`))
		const paths = skill.files.filter((file) => file !== null && typeof file === 'object').map((file) => file.path)
		if (!paths.includes(SKILL_FILE)) parts.push(`技能 ${name} 没有 ${SKILL_FILE}`)
	}
	return parts
}

/**
 * 解析包文本（也接受已经是对象的包）。
 * @returns `{ ok: true, pack }` 或 `{ ok: false, reason }`。
 */
export function parseRolePack(input) {
	let pack = input
	if (typeof input === 'string') {
		if (input.length > PACK_MAX_BYTES) return { ok: false, reason: `包太大：约 ${(input.length / 1024 / 1024).toFixed(1)} MB（上限 ${PACK_MAX_BYTES / 1024 / 1024} MB）` }
		try {
			pack = JSON.parse(input)
		} catch (error) {
			return { ok: false, reason: `不是合法的 JSON：${error instanceof Error ? error.message : String(error)}` }
		}
	}
	const findings = packFindings(pack)
	if (findings.length > 0) return { ok: false, reason: findings.slice(0, 8).join('；') }
	return { ok: true, pack }
}

/** 一个 id 在某个根里已经存在吗（只看我们认的那个定义文件）。 */
function existsIn(root, id, fileName) {
	return existsSync(join(root, id, fileName))
}

/**
 * **预览**：这个包落在目标作用域会变成什么 —— 哪些是新的、哪些已存在、哪些会遮蔽包内角色。
 * 不含任何写动作（面板先预览、后落盘就是调它）。
 * @param input - 包文本或对象。
 * @param options - `{ workspace, scope }`。
 * @returns `{ ok: true, plan }` 或 `{ ok: false, reason }`。
 */
export function inspectRolePack(input, { workspace, scope = 'workspace' } = {}) {
	const parsed = parseRolePack(input)
	if (!parsed.ok) return parsed
	const roleRoot = roleRootOf(scope, workspace)
	if (roleRoot === null) return { ok: false, reason: '作用域不认，或项目级作用域没给工作区' }
	const skillRoot = skillRootOf(scope === 'user' ? 'user' : 'project', workspace)
	if (skillRoot === null) return { ok: false, reason: '技能根取不到（项目级作用域需要工作区）' }
	const roster = readRoster([], { includeUser: true, workspace })
	const packageIds = new Set(roster.roles.filter((role) => role.source === 'package').map((role) => role.id))
	const otherScope = scope === 'user' ? 'workspace' : 'user'
	const otherRoleRoot = roleRootOf(otherScope, workspace)
	const otherSkillRoot = skillRootOf(otherScope === 'user' ? 'user' : 'project', workspace)

	const roles = parsed.pack.roles.map((role) => {
		const id = role.id.trim()
		const existsHere = existsIn(roleRoot.root, id, ROLE_FILE)
		const existsOther = otherRoleRoot !== null && existsIn(otherRoleRoot.root, id, ROLE_FILE)
		const shadowsPackage = packageIds.has(id)
		const status = existsHere ? 'exists' : 'new'
		return {
			id,
			origin: typeof role.origin === 'string' ? role.origin : 'user',
			status,
			shadowsPackage,
			otherScopeExists: existsOther,
			files: role.files.length,
		}
	})
	const skills = (parsed.pack.skills ?? []).map((skill) => {
		const name = skill.name.trim()
		return {
			name,
			origin: typeof skill.origin === 'string' ? skill.origin : 'user',
			status: existsIn(skillRoot, name, SKILL_FILE) ? 'exists' : 'new',
			otherScopeExists: otherSkillRoot !== null && existsIn(otherSkillRoot, name, SKILL_FILE),
			files: skill.files.length,
		}
	})
	return {
		ok: true,
		plan: {
			pack: { createdAt: parsed.pack.createdAt ?? '', producer: parsed.pack.producer ?? null },
			scope,
			roleRoot: roleRoot.root,
			skillRoot,
			roles,
			skills,
			counts: {
				roles: roles.length,
				rolesNew: roles.filter((role) => role.status === 'new').length,
				rolesExisting: roles.filter((role) => role.status === 'exists').length,
				rolesShadowingPackage: roles.filter((role) => role.shadowsPackage).length,
				skillsNew: skills.filter((skill) => skill.status === 'new').length,
				skillsExisting: skills.filter((skill) => skill.status === 'exists').length,
			},
		},
	}
}

/** 把一份文件清单写进 `<根>/<id>/`：新建走整目录改名；覆盖逐文件备份后写入。 */
function writeEntry(root, id, files, { overwrite, rootLabel = '角色根' }) {
	const dir = join(root, id)
	const outside = realInsideFindings(root, dir, rootLabel)
	if (outside !== null) return { ok: false, reason: outside }
	const exists = existsSync(dir)
	if (exists && !overwrite) return { ok: false, reason: `${dir} 已存在 —— 要覆盖请显式选「覆盖已存在的」` }
	if (files.length > PACK_MAX_FILES) return { ok: false, reason: `${id} 的文件太多：${files.length} 个（上限 ${PACK_MAX_FILES}）` }
	const staging = join(root, `.importing-${process.pid}-${id}`)
	const backups = []
	try {
		mkdirSync(root, { recursive: true })
		rmSync(staging, { recursive: true, force: true })
		mkdirSync(staging, { recursive: true })
		for (const file of files) {
			const target = join(staging, ...file.path.split('/'))
			mkdirSync(dirname(target), { recursive: true })
			writeFileSync(target, file.encoding === 'base64' ? Buffer.from(file.data, 'base64') : file.text)
		}
		if (!exists) {
			renameSync(staging, dir)
			return { ok: true }
		}
		// 覆盖：被替换的每个文件先留一份 `<名字>.bak`（与 `role_define` 的 mode=update 同一口径）；
		// 原来没有的文件（比如新增的头像）直接落进去。
		for (const file of files) {
			const target = join(dir, ...file.path.split('/'))
			const source = join(staging, ...file.path.split('/'))
			if (existsSync(target)) {
				const backup = `${target}.bak`
				cpSync(target, backup)
				backups.push(backup)
			}
			mkdirSync(dirname(target), { recursive: true })
			renameSync(source, target)
		}
		rmSync(staging, { recursive: true, force: true })
		return { ok: true, backups }
	} catch (error) {
		rmSync(staging, { recursive: true, force: true })
		return { ok: false, reason: `写入失败：${error instanceof Error ? error.message : String(error)}` }
	}
}

/**
 * **导入**：把包落进目标作用域。
 * @param input - 包文本或对象。
 * @param options - `{ workspace, scope, onConflict: 'skip'|'overwrite' }`。
 * @returns `{ ok: true, scope, roleRoot, skillRoot, imported, overwritten, skipped }` 或 `{ ok: false, reason }`。
 */
export function importRolePack(input, { workspace, scope = 'workspace', onConflict = 'skip' } = {}) {
	if (onConflict !== 'skip' && onConflict !== 'overwrite') return { ok: false, reason: `冲突策略认不出：${JSON.stringify(onConflict)}（只认 skip / overwrite）` }
	const inspected = inspectRolePack(input, { workspace, scope })
	if (!inspected.ok) return inspected
	const { plan } = inspected
	const pack = parseRolePack(input).pack
	const overwrite = onConflict === 'overwrite'
	const imported = []
	const skipped = []
	const overwritten = []
	const failures = {}
	const roleById = new Map(pack.roles.map((role) => [role.id.trim(), role]))
	for (const row of plan.roles) {
		const role = roleById.get(row.id)
		if (row.status === 'exists' && !overwrite) {
			skipped.push({ kind: 'role', id: row.id, reason: '目标根里已存在同名角色（默认不覆盖）' })
			continue
		}
		const written = writeEntry(plan.roleRoot, row.id, role.files, { overwrite: row.status === 'exists' && overwrite })
		if (!written.ok) {
			failures[row.id] = written.reason
			skipped.push({ kind: 'role', id: row.id, reason: written.reason })
			continue
		}
		if (row.status === 'exists') overwritten.push({ kind: 'role', id: row.id })
		else imported.push({ kind: 'role', id: row.id })
	}
	const skillByName = new Map((pack.skills ?? []).map((skill) => [skill.name.trim(), skill]))
	for (const row of plan.skills) {
		const skill = skillByName.get(row.name)
		if (row.status === 'exists' && !overwrite) {
			skipped.push({ kind: 'skill', id: row.name, reason: '目标技能根里已存在同名技能（默认不覆盖）' })
			continue
		}
		const written = writeEntry(plan.skillRoot, row.name, skill.files, { overwrite: row.status === 'exists' && overwrite, rootLabel: '技能根' })
		if (!written.ok) {
			skipped.push({ kind: 'skill', id: row.name, reason: written.reason })
			continue
		}
		if (row.status === 'exists') overwritten.push({ kind: 'skill', id: row.name })
		else imported.push({ kind: 'skill', id: row.name })
	}
	return {
		ok: true,
		scope,
		roleRoot: plan.roleRoot,
		skillRoot: plan.skillRoot,
		imported,
		overwritten,
		skipped,
		...(Object.keys(failures).length > 0 ? { failures } : {}),
	}
}

/** 建议的文件名：`roles-<日期>-<时分>.dshroles.json`（导出端点与命令行共用）。 */
export function suggestedPackName(now = new Date()) {
	const pad = (value) => String(value).padStart(2, '0')
	return `roles-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.dshroles.json`
}

/** 包内角色数（回执用；不解析整包）。 */
export function packSummaryOf(pack) {
	return {
		roles: Array.isArray(pack?.roles) ? pack.roles.length : 0,
		skills: Array.isArray(pack?.skills) ? pack.skills.length : 0,
		bytes: serializeRolePack(pack).length,
	}
}
