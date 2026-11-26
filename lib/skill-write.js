/**
 * 技能的**写入口**（面板「技能」块那三个动作的唯一实现）。
 *
 * 为什么写这一层：技能注册表（`ctx.skills`）在本部署里是**只读**的 —— 它按作用域列出若干根
 * （`bundled` 随安装发布、`user-dsh` = `~/.dsh/skills`、`project-dsh` = `<workspace>/.dsh/skills`、
 * `user-agents` = `~/.agents/skills`）。要"管理技能"就得往**可写的那两类根**里落文件，
 * 而落文件这件事必须有一处判定（编号形状、防越界、防覆盖、体量与份数上限）——就是本文件。
 *
 * 三条规矩（与面板其余写入口同一套）：
 *   · **只写人在面板上明确点的那一下**：本模块不自己找活干，也不在启动时动任何文件；
 *   · **只在可写根内写、只增不改**：目标已存在一律**拒绝**（不覆盖别人的东西）；删除只删
 *     `<root>/<id>` 这一棵目录，且要求它整棵都在根内；
 *   · **读不到就说读不到**：每一步失败都返回一句可读原因，不猜、不吞。
 *
 * 技能的判定只有一条：**一个含 `SKILL.md`（或一个 `.md` 文件）的目录**。
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 技能的编号形状：与成员名同一条约束（lower-kebab-case）。 */
const SKILL_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
/** 编号长度上限（目录名、front-matter 的 name 都用它）。 */
const SKILL_ID_MAX = 60
/** 导入时的体量上限：单份技能的字节数与文件数（超过就**拒绝**并把数说出来，不悄悄截断）。 */
const IMPORT_MAX_BYTES = 4 * 1024 * 1024
const IMPORT_MAX_FILES = 500
/** 可写根的两种：用户级（跨项目）与项目级（跟着工作区走）。 */
const ROOT_KINDS = ['user', 'project']

/** 一个技能要落进哪一个根：绝对路径；kind 不认时给 null（调用方据此报 400）。 */
export function skillRootOf(kind, workspace) {
	if (!ROOT_KINDS.includes(kind)) return null
	const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
	if (kind === 'user') return join(home, 'skills')
	if (typeof workspace !== 'string' || workspace.trim() === '') return null
	return join(workspace.trim(), '.dsh', 'skills')
}

/**
 * 可写根的中文说法（回执与面板都用它，一处正文）。
 *
 * 路径那句**从 `skillRootOf` 派生**，不再手写一份：手写过的那一份把用户级根写死成
 * `~/.dsh/skills`，而 `skillRootOf` 是 `DSH_HOME` 优先 —— 于是面板上显示的那个路径
 * 与真正写入的路径可以是两个地方。
 */
export function skillRootLabel(kind) {
	const root = skillRootOf(kind, '<工作区>')
	if (root === null) return '不认识的技能根'
	return kind === 'user' ? `用户级技能根（${root}）` : `项目技能根（${root}）`
}

/**
 * 编号合法性与形状（**判定只有这一处**）。
 * @param id - 候选编号（目录名 = 技能名）。
 * @returns 空数组即合法；否则一行行原因。
 */
export function skillIdFindings(id) {
	if (typeof id !== 'string' || id.trim() === '') return ['技能名必填（lower-kebab-case，例如 my-playbook）']
	const value = id.trim()
	const parts = []
	if (value.length > SKILL_ID_MAX) parts.push(`技能名太长（${value.length} 字符，上限 ${SKILL_ID_MAX}）`)
	if (!SKILL_ID_RE.test(value)) parts.push(`技能名形状不对：${value}（要 lower-kebab-case：小写字母开头，只含小写字母、数字与单个连字符）`)
	return parts
}

/**
 * 一个目录/文件能不能当"一份技能"导入。
 * @param source - 用户给的来源路径（绝对或相对工作区）。
 * @param workspace - 工作区（相对路径按它解析）。
 * @returns `{ ok: true, kind: 'dir'|'file', path, id }` 或 `{ ok: false, reason }`。
 */
export function importSourceOf(source, workspace) {
	const raw = typeof source === 'string' ? source.trim() : ''
	if (raw === '') return { ok: false, reason: '来源路径必填（一个含 `SKILL.md` 的目录，或一个 `.md` 文件）' }
	const base = typeof workspace === 'string' && workspace.trim() !== '' ? workspace.trim() : process.cwd()
	const path = isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
	// **压缩包先判**（在"路径存在吗"之前）：这条话不该取决于文件在不在 —— 拿着一个 `.zip` 的路径过来，
	// 该听到的是"本入口不解压、请先解开"，而不是"读不到来源"（那会让人以为路径写错了）。
	const lowerName = extname(path).toLowerCase()
	if (lowerName === '.zip' || lowerName === '.tar' || lowerName === '.tgz' || lowerName === '.gz') {
		return { ok: false, reason: `${basename(path)} 是压缩包，本入口不解压：请先解开它，把里面的**技能目录**拖进来（或拖单个 .md 文件）` }
	}
	let stat
	try {
		stat = statSync(path)
	} catch {
		return { ok: false, reason: `读不到来源：${path}（不存在或没有权限）` }
	}
	if (stat.isDirectory()) {
		if (!existsSync(join(path, 'SKILL.md'))) {
			return { ok: false, reason: `${path} 里没有 SKILL.md —— 一份技能是一个含 SKILL.md 的目录` }
		}
		return { ok: true, kind: 'dir', path, id: basename(path) }
	}
	if (stat.isFile()) {
		if (lowerName !== '.md') return { ok: false, reason: `只认目录或 .md 文件，这个是：${basename(path)}` }
		return { ok: true, kind: 'file', path, id: basename(path, extname(path)) }
	}
	return { ok: false, reason: `只认目录或 .md 文件：${path}` }
}

/** 目标目录整棵在根内吗（防 `../` 越界：判定用**解析后的相对路径**）。 */
function insideOf(root, target) {
	const rel = relative(root, target)
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep + '..' + sep)
}

/** 这个路径**已存在的那一段**的真实路径（不存在的尾部原样拼回去）。判定写入落点要用它。 */
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

/** 这次写入的**信任根**（真实路径）：用户级根的上层是 `DSH_HOME`，项目级根的上层是工作区。 */
function trustedRootOf(kind, workspace) {
	const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
	if (kind === 'user') return realPathOfExisting(home)
	if (kind === 'project' && typeof workspace === 'string' && workspace.trim() !== '') return realPathOfExisting(resolve(workspace.trim()))
	return null
}

/**
 * **按真实路径**判定目标仍在信任根之内。
 *
 * 为什么必须再判一次：`insideOf` 只比字符串，挡得住 `../`，挡不住**符号链接**。现场实测过：
 * 把 `<工作区>/.dsh/skills` 做成一个指向别处的链接，写技能就会跟着链接落**到工作区之外**
 * （回执还写着 `workspace=<工作区>`，读的人无从知道）。这里的口径是：**写落点以真实路径为准，
 * 不许越出信任根**；根内部自己指来指去（真实路径仍在根内）照旧放行。
 * @returns `null` 放行；否则一句可读的拒绝理由。
 */
function realInsideFindings(kind, workspace, target) {
	const trusted = trustedRootOf(kind, workspace)
	if (trusted === null) return null
	const real = realPathOfExisting(target)
	const rel = relative(trusted, real)
	if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return null
	return `写落点越界：${target} 的真实路径是 ${real}，不在${kind === 'user' ? '用户级技能根所在目录' : '本工作区'}（${trusted}）之内 —— 中间某一级是不是符号链接指到了外面？`
}

/** 数一棵树的体量（文件数与字节数）：导入前先看，超限就拒绝而不是截断。 */
function weightOf(path) {
	let files = 0
	let bytes = 0
	const walk = (dir) => {
		let entries
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue
			const full = join(dir, entry.name)
			if (entry.isDirectory()) {
				walk(full)
				continue
			}
			if (!entry.isFile()) continue
			files += 1
			try {
				bytes += statSync(full).size
			} catch {
				/* 读不到大小就不计（不因此拒绝一份技能） */
			}
		}
	}
	walk(path)
	return { files, bytes }
}

/**
 * 把一份技能**导入**进可写根：复制（目录）或落成 `SKILL.md`（单个 `.md` 文件）。
 *
 * 目标已存在 ⇒ **拒绝**（只增不改：不覆盖别人写的东西）。越界、超限、形状不对一律拒绝并说明。
 * @param options - `{ kind, workspace, source }`。
 * @returns `{ ok: true, id, root, path }` 或 `{ ok: false, reason }`。
 */
export function importSkill({ kind, workspace, source } = {}) {
	const root = skillRootOf(kind, workspace)
	if (root === null) return { ok: false, reason: `技能根不认：${String(kind)}（只支持 user / project）` }
	const found = importSourceOf(source, workspace)
	if (!found.ok) return { ok: false, reason: found.reason }
	const findings = skillIdFindings(found.id)
	if (findings.length > 0) return { ok: false, reason: `这份技能的目录名不能当编号：${findings.join('；')}` }
	const target = join(root, found.id.trim())
	if (!insideOf(root, target)) return { ok: false, reason: '目标路径越界（技能名里不能带路径分隔符）' }
	const realFindings = realInsideFindings(kind, workspace, target)
	if (realFindings !== null) return { ok: false, reason: realFindings }
	if (existsSync(target)) return { ok: false, reason: `${target} 已存在 —— 本面板只增不改，要换一份请先删掉它` }

	if (found.kind === 'dir') {
		const weight = weightOf(found.path)
		if (weight.files > IMPORT_MAX_FILES) return { ok: false, reason: `这份技能有 ${weight.files} 个文件（上限 ${IMPORT_MAX_FILES}）—— 技能是作业程序，不该这么大` }
		if (weight.bytes > IMPORT_MAX_BYTES) return { ok: false, reason: `这份技能 ${Math.round(weight.bytes / 1024)} KB（上限 ${Math.round(IMPORT_MAX_BYTES / 1024)} KB）` }
	}
	const staging = `${target}.importing-${process.pid}`
	try {
		mkdirSync(root, { recursive: true })
		rmSync(staging, { recursive: true, force: true })
		mkdirSync(staging, { recursive: true })
		if (found.kind === 'dir') {
			cpSync(found.path, staging, { recursive: true, filter: (from) => !basename(from).startsWith('.') })
		} else {
			writeFileSync(join(staging, 'SKILL.md'), readFileSync(found.path))
		}
		// 先落到临时名、再改名成目标：中途失败不会留下半个技能（目标名只在这一刻出现）。
		renameInto(staging, target)
	} catch (error) {
		// **失败要清掉暂存目录**：留着它，技能根里就永久多一个 `.importing-<pid>`
		// （另一条写入路径 `importSkillFiles` 一直是清的 —— 这就是那处不对称）。
		discardStaging(staging)
		return { ok: false, reason: `复制失败：${error?.message ?? String(error)}` }
	}
	return { ok: true, id: found.id.trim(), root, path: target }
}

/**
 * **从浏览器拖进来（或选中的）一批文件**导入一份技能。
 *
 * 拖拽/选择给到浏览器的是**文件内容**，给不到绝对路径 —— 所以这条通道收的是
 * `files: [{ path, dataBase64 }]`（`path` 是相对那个技能文件夹的路径，例如 `my-skill/SKILL.md`），
 * 由宿主解码、校验、写进可写根。判定与落盘和"从路径导入"共用同一批规矩（编号形状、只增不改、
 * 防越界、体量与份数上限、先落临时名再改名）。
 *
 * 三个额外判定（拖拽这条通道独有）：
 *   · **必须带 `SKILL.md`**（技能的定义文件）—— 没有就拒绝，不猜；
 *   · **带进来的路径必须先被"去公共前缀"**：拖一个文件夹时每条路径都以那个文件夹名开头，
 *     去掉之后剩下的才是技能内部的相对路径（`SKILL.md` / `references/x.md`）；
 *   · 技能名优先取 `SKILL.md` 的 front-matter `name`（合法时），否则取文件夹名。
 * @param options - `{ kind, workspace, name, files }`。
 * @returns `{ ok: true, id, root, path, files }` 或 `{ ok: false, reason }`。
 */
export function importSkillFiles({ kind, workspace, name, files } = {}) {
	const root = skillRootOf(kind, workspace)
	if (root === null) return { ok: false, reason: `技能根不认：${String(kind)}（只支持 user / project）` }
	if (!Array.isArray(files) || files.length === 0) return { ok: false, reason: '没拿到文件：把技能文件夹或 SKILL.md 拖进来（或点「选择文件夹 / 选择文件」）' }
	if (files.length > IMPORT_MAX_FILES) return { ok: false, reason: `一次拖进来 ${files.length} 个文件（上限 ${IMPORT_MAX_FILES}）—— 技能是作业程序，不该这么大` }
	// 拖进来的是一整个压缩包（浏览器给的是一批文件，里面第一个就是那个 `.zip`）：同样不解压，但要说清原因，
	// 不能让它掉进"没有 SKILL.md"那句里 —— 那样读者会去翻文件夹结构，而真正该做的是先解开压缩包。
	const archived = files.find((entry) => {
		const rel = entry !== null && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path.toLowerCase() : ''
		return rel.endsWith('.zip') || rel.endsWith('.tar') || rel.endsWith('.tgz') || rel.endsWith('.tar.gz')
	})
	if (archived !== undefined) {
		return { ok: false, reason: `${archived.path} 是压缩包，本入口不解压：请先解开它，把里面的**技能目录**拖进来（或拖单个 SKILL.md）` }
	}

	// ① 解码 + 形状校验（相对路径不许带 `..`、不许绝对路径）
	const decoded = []
	for (const entry of files) {
		if (entry === null || typeof entry !== 'object') return { ok: false, reason: '文件清单里有一项不是对象' }
		const rel = typeof entry.path === 'string' ? entry.path.replace(/\\/g, '/').replace(/^\.\//, '') : ''
		if (rel === '') return { ok: false, reason: '有一项没给路径' }
		if (rel.startsWith('/') || rel.includes('../') || rel === '..') return { ok: false, reason: `路径越界：${rel}` }
		const base64 = typeof entry.dataBase64 === 'string' ? entry.dataBase64 : ''
		if (base64 === '') return { ok: false, reason: `有一项没给内容：${rel}` }
		let data
		try {
			data = Buffer.from(base64, 'base64')
		} catch (error) {
			return { ok: false, reason: `有一项解不开（base64）：${rel} —— ${error?.message ?? String(error)}` }
		}
		decoded.push({ rel, data })
	}
	const bytes = decoded.reduce((sum, item) => sum + item.data.byteLength, 0)
	if (bytes > IMPORT_MAX_BYTES) return { ok: false, reason: `这一批共 ${Math.round(bytes / 1024)} KB（上限 ${Math.round(IMPORT_MAX_BYTES / 1024)} KB）` }

	// ② 去公共前缀（拖一个文件夹时每条路都以它开头）；只留一个前缀时也去掉（`<id>/SKILL.md` ⇒ `SKILL.md`）
	const parts = decoded.map((item) => item.rel.split('/'))
	const first = parts[0][0]
	const shareFirst = parts.every((seg) => seg.length > 1 && seg[0] === first)
	const inner = decoded.map((item, index) => ({ ...item, rel: shareFirst ? parts[index].slice(1).join('/') : item.rel }))

	// ③ 必须有 SKILL.md（技能的定义文件）
	const skillFile = inner.find((item) => item.rel === 'SKILL.md')
	if (skillFile === undefined) {
		return { ok: false, reason: '这一批里没有 SKILL.md —— 一份技能是一个含 SKILL.md 的文件夹（或那个文件本身）' }
	}

	// ④ 技能名：front-matter 的 `name` 优先（那个名字是技能自己的），否则用给进来的名字/目录名
	const declared = declaredSkillName(skillFile.data.toString('utf8'))
	const wanted = declared !== undefined ? declared : typeof name === 'string' ? name.trim() : ''
	const findings = skillIdFindings(wanted)
	if (findings.length > 0) {
		return { ok: false, reason: `技能名用不了：${findings.join('；')}（要么把它拖成 <技能名>/SKILL.md，要么在 SKILL.md 的 front-matter 里写 name）` }
	}
	const id = wanted
	const target = join(root, id)
	if (!insideOf(root, target)) return { ok: false, reason: '目标路径越界（技能名里不能带路径分隔符）' }
	const realFindings = realInsideFindings(kind, workspace, target)
	if (realFindings !== null) return { ok: false, reason: realFindings }
	if (existsSync(target)) return { ok: false, reason: `${target} 已存在 —— 本面板只增不改，要换一份请先删掉它` }

	// ⑤ 落盘：先写到临时目录，再改名成目标（中途失败不留半个技能）
	const staging = `${target}.importing-${process.pid}`
	try {
		mkdirSync(root, { recursive: true })
		rmSync(staging, { recursive: true, force: true })
		mkdirSync(staging, { recursive: true })
		for (const item of inner) {
			const dir = dirname(join(staging, item.rel))
			mkdirSync(dir, { recursive: true })
			writeFileSync(join(staging, item.rel), item.data)
		}
		renameInto(staging, target)
	} catch (error) {
		discardStaging(staging)
		return { ok: false, reason: `写文件失败：${error?.message ?? String(error)}` }
	}
	return { ok: true, id, root, path: target, files: inner.length }
}

/** `SKILL.md` front-matter 里那行 `name:`（没有 / 形状不对 ⇒ undefined，交给调用方回落）。 */
function declaredSkillName(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
	if (match === null) return undefined
	const line = /^\s*name\s*:\s*(.+?)\s*$/m.exec(match[1])
	if (line === null) return undefined
	const value = line[1].replace(/^["']|["']$/g, '').trim()
	return skillIdFindings(value).length === 0 ? value : undefined
}

/** 失败路径上的清理：清不掉不影响报错（要报的是原来那个错）。 */
function discardStaging(staging) {
	try {
		rmSync(staging, { recursive: true, force: true })
	} catch {
		/* 清理失败不影响报错 */
	}
}

/**
 * 落定：`rename` 在跨设备时可能失败，退回"复制完再删"。
 *
 * 两条不许：
 *   · **暂存目录不在 ⇒ 抛**，不许静默返回 —— 那会让调用方报 `ok: true`，而目标根本没落地
 *     （"成功"了却什么都没写，比失败更难查）；
 *   · **目标名一旦出现过就要么完整、要么不存在**：退回复制那条路中途失败时把目标清掉，
 *     留着半个目标下次会被自己的守卫（"已存在"）挡在门外，而它并不是一份技能。
 */
function renameInto(staging, target) {
	try {
		lstatSync(staging)
	} catch {
		throw new Error(`暂存目录不见了：${staging}`)
	}
	try {
		renameSync(staging, target)
	} catch {
		try {
			cpSync(staging, target, { recursive: true })
		} catch (error) {
			discardStaging(target)
			throw error
		}
		rmSync(staging, { recursive: true, force: true })
	}
}

/**
 * **新建**一份技能：写 `<root>/<name>/SKILL.md`（带 front-matter）。
 * @param options - `{ kind, workspace, name, description, body }`。
 * @returns `{ ok: true, id, root, path }` 或 `{ ok: false, reason }`。
 */
export function createSkill({ kind, workspace, name, description, body } = {}) {
	const spot = skillTargetOf(kind, workspace, name)
	if (spot.ok !== true) return { ok: false, reason: spot.reason }
	const { root, id, target } = spot
	if (existsSync(target)) return { ok: false, reason: `${target} 已存在 —— 本面板只增不改，要改就编辑那份文件` }
	const desc = typeof description === 'string' ? description.trim() : ''
	const text = typeof body === 'string' ? body.trim() : ''
	if (text === '') return { ok: false, reason: '正文必填：技能就是那份作业程序，空的不算一份技能' }
	// 与另外两条写入路径同一条路：**先落暂存名、再改名成目标**。
	// 直接建目标目录写文件的话，写失败会在技能根里留一个空目录，而下一行的守卫是"已存在就不许重试"
	// ⇒ 重试被自己上一次的残骸挡住，只能先去手工删那个目录。
	const staging = `${target}.creating-${process.pid}`
	try {
		mkdirSync(root, { recursive: true })
		rmSync(staging, { recursive: true, force: true })
		mkdirSync(staging, { recursive: true })
		writeFileSync(join(staging, 'SKILL.md'), frontMatterOf(id, desc) + text + '\n')
		renameInto(staging, target)
	} catch (error) {
		discardStaging(staging)
		return { ok: false, reason: `写文件失败：${error?.message ?? String(error)}` }
	}
	return { ok: true, id, root, path: target }
}

/** 新技能的 front-matter（一份形状，别处不重复写）。 */
function frontMatterOf(id, description) {
	return ['---', `name: ${id}`, 'version: 1.0.0', `description: ${description === '' ? 'Use when ' : description}`, '---', '', ''].join('\n')
}

/** 一份技能的目录名与 `SKILL.md`（两条写路径共用这几处判定）。 */
function skillTargetOf(kind, workspace, name) {
	const root = skillRootOf(kind, workspace)
	if (root === null) return { ok: false, reason: `技能根不认：${String(kind)}（只支持 user / project）` }
	const findings = skillIdFindings(name)
	if (findings.length > 0) return { ok: false, reason: findings.join('；') }
	const id = name.trim()
	const target = join(root, id)
	if (!insideOf(root, target)) return { ok: false, reason: '目标路径越界（技能名里不能带路径分隔符）' }
	const realFindings = realInsideFindings(kind, workspace, target)
	if (realFindings !== null) return { ok: false, reason: realFindings }
	return { ok: true, root, id, target, file: join(target, 'SKILL.md') }
}

/**
 * **改写**一份已存在的技能（`<root>/<name>/SKILL.md`）。
 *
 * 与 {@link createSkill} 的两点差别，都写在回执里：
 *   · 目标**必须已存在**（不存在就拒，让人显式走新建那条路）；
 *   · 覆盖前把原文件留一份 `SKILL.md.bak`（**放在技能目录里**：它不以 `.md` 结尾，技能注册表不会
 *     把它当成第二个技能文件，也不会像"同级 `<name>.bak` 目录"那样凭空多出一份技能）。
 * @param options - `{ kind, workspace, name, description, body }`。
 * @returns `{ ok: true, id, root, path, backup }` 或 `{ ok: false, reason }`。
 */
export function updateSkill({ kind, workspace, name, description, body } = {}) {
	const spot = skillTargetOf(kind, workspace, name)
	if (spot.ok !== true) return { ok: false, reason: spot.reason }
	const { root, id, target, file } = spot
	if (!existsSync(target)) return { ok: false, reason: `${target} 不存在 —— 这是"改一份已有的技能"，新建请用 mode=create` }
	if (!existsSync(file)) return { ok: false, reason: `${file} 不存在：这个目录不是一份技能（技能 = 一个含 \`SKILL.md\` 的目录）` }
	const desc = typeof description === 'string' ? description.trim() : ''
	const text = typeof body === 'string' ? body.trim() : ''
	if (text === '') return { ok: false, reason: '正文必填：技能就是那份作业程序，空的不算一份技能' }
	const backup = join(target, 'SKILL.md.bak')
	try {
		writeFileSync(backup, readFileSync(file, 'utf8'))
		// 与新建同一条路：先写暂存文件、再改名成目标 —— 写失败不会把已存在的那一份写坏。
		const staging = join(target, `SKILL.md.writing-${process.pid}`)
		writeFileSync(staging, frontMatterOf(id, desc) + text + '\n')
		renameInto(staging, file)
	} catch (error) {
		return { ok: false, reason: `写文件失败：${error?.message ?? String(error)}` }
	}
	return { ok: true, id, root, path: target, backup }
}

/**
 * **删除**一份技能：只删 `<root>/<id>` 这一棵目录，且要求它在可写根内。
 *
 * 拒绝删除的三种：根不认（`bundled` / `user-agents` 之类只读根）、目标不存在、目标整棵不在根内。
 * @param options - `{ kind, workspace, name }`。
 * @returns `{ ok: true, id, root, path }` 或 `{ ok: false, reason }`。
 */
export function removeSkill({ kind, workspace, name } = {}) {
	const root = skillRootOf(kind, workspace)
	if (root === null) return { ok: false, reason: `技能根不认：${String(kind)}（只支持 user / project；随包发布的技能不许删）` }
	const findings = skillIdFindings(name)
	if (findings.length > 0) return { ok: false, reason: findings.join('；') }
	const id = name.trim()
	const target = join(root, id)
	if (!insideOf(root, target)) return { ok: false, reason: '目标路径越界（技能名里不能带路径分隔符）' }
	const realFindings = realInsideFindings(kind, workspace, target)
	if (realFindings !== null) return { ok: false, reason: realFindings }
	if (!existsSync(target)) return { ok: false, reason: `${target} 不存在（可能已经被删掉了）` }
	try {
		rmSync(target, { recursive: true, force: true })
	} catch (error) {
		return { ok: false, reason: `删除失败：${error?.message ?? String(error)}` }
	}
	return { ok: true, id, root, path: target }
}
