/**
 * dsh-team-ops 的启动自诊断：把这个包「装了但没生效」变成装包的人看得见的一条告警。
 *
 * 装载形状与同包的引擎文件一致：同步 `apply`，只导出 `inject` 与 `apply`。
 * 本插件只做诊断 —— 不注册工具或命令、不写任何文件、不改变任何行为；每项检查都自带
 * try/catch，失败只告警，绝不打断启动。
 *
 * **三项检查各自怎么读**（全部纯文件系统，apply 内同步完成）：
 *   · **名册** —— `team/roles/` 下每个含 `ROLE.md` 的目录就是一个角色；一个都没有 ⇒
 *     协调器谁也派不出来（`member_spawn` 的合法角色集是空的）。
 *   · **基线** —— `team/BASELINE.md` 就是团队规则全文（点名规矩、按需组建、记账与论据纪律、
 *     问人四问、独立复核）。**它不写角色名单**（名单只在 `team/roles/` 现场枚举）。角色 persona 与协调器都
 *     **按这个路径读它**（它不再注册进技能表）⇒ 文件不在，成员就只剩一句定位。
 *   · **两个半边** —— 制度层 `team/company-gate.js` 与运行时层 `team/team-runtime.js` 在包内，
 *     而且**那条唯一的宿主行**（`lib/board-view.host.js`）确实 import 了它们。它们**随插件装载**
 *     （与跑哪个预设无关）；文件丢了或 import 被删了，会话就**一个团队工具都没有**。
 *
 * 三者都是"少了它产品就是半个"的东西，不是"少个功能"—— 所以它们是启动诊断的项。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包根目录（引擎、名册、基线与宿主行都从这里算）。 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 团队数据与两个半边所在目录。 */
const TEAM_DIR = join(PACKAGE_ROOT, 'team')
/** 角色根（`roles/<id>/ROLE.md`）。 */
const ROLES_DIR = join(TEAM_DIR, 'roles')
/** 角色定义的标志文件（与运行时 `roleCatalog()` 同一个判定）。 */
const ROLE_FILE = 'ROLE.md'
/** 团队规则全文（persona 与协调器按这个相对路径读它）。 */
const BASELINE_REL = 'BASELINE.md'
/** 两个半边（引擎文件；由宿主行 import 并 apply，见 `engineHalfFindings`）。 */
const ENGINE_FILES = ['company-gate.js', 'team-runtime.js']
/** 装载那两个半边的宿主行模块。 */
const HOST_ENTRY = join('lib', 'board-view.host.js')

/**
 * 本插件不要求任何服务：服务缺一个也要照常跑起来，否则「读不到」本身就没法报告。
 */
export const inject = []

/**
 * 挂载诊断：三项检查都只读文件系统，逐项 try/catch，失败只告警。
 * @param ctx - 本行所在的 context。
 */
export function apply(ctx) {
	for (const check of [checkRoster, checkBaseline, checkEngines]) {
		try {
			check(ctx)
		} catch (error) {
			report(ctx, `启动自诊断的一项抛错（${error?.name ?? 'Error'}: ${error?.message ?? String(error)}）。这一项没能检查；插件其余部分不受影响。`)
		}
	}
}

/* ── 检查一：名册（`team/roles/` 现场枚举） ─────────────────────────────── */

/**
 * 角色根里有角色吗。
 *
 * 判定与运行时 `roleCatalog()` 同一套：**含 `ROLE.md` 的目录**才算一个角色（读不到目录、
 * 或目录里一个角色都没有，都照实说，不降级成"没有角色"这句话之外的意思）。
 * @param ctx - 用于告警的 context。
 */
function checkRoster(ctx) {
	const findings = rosterFindings(ROLES_DIR)
	if (findings.length === 0) return
	report(ctx, `${findings.join('；')}（角色根 ${ROLES_DIR}）。后果：\`member_spawn\` 的合法角色集是空的 —— 谁也派不出来。修法：重装本包（\`team/\` 随包一起发布）。`)
}

/**
 * 角色根的两类判定（导出是给自检用的：自检拿真目录与假目录走同一条判定）。
 * @param dir - 角色根目录。
 * @returns 一行行判定文本；齐备时返回空数组。
 */
export function rosterFindings(dir) {
	let entries
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return [`读不到角色根：${dir} 不存在或读不成`]
	}
	const roles = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && existsSync(join(dir, entry.name, ROLE_FILE)))
	if (roles.length > 0) return []
	return [`角色根里没有角色：${dir} 下没有含 ${ROLE_FILE} 的目录`]
}

/* ── 检查二：团队基线全文 ─────────────────────────────────────────────── */

/**
 * 基线文件在不在（它就是团队宪法；member persona 与协调器都按这个路径读）。
 * @param ctx - 用于告警的 context。
 */
function checkBaseline(ctx) {
	const file = join(TEAM_DIR, BASELINE_REL)
	try {
		if (statSync(file).isFile()) return
	} catch {
		/* 落到下面那条告警 */
	}
	report(ctx, `读不到团队基线全文：${file}。后果：成员只剩一句角色定位（职责表、点名规矩、按需组建、记账纪律都在那份文件里）。修法：重装本包。`)
}

/* ── 检查三：两个半边都在（包内引擎目录 + 宿主行引用） ────────────────── */

/**
 * 两个半边在包内 `team/` 里，且**那条唯一的宿主行**确实 import 了它们并自己 apply。
 *
 * 它们现在**随插件装载**（宿主行自己 apply —— 不是 loader entry，那样会让本包出现多个
 * "客户端来源"而把 DSH 启崩），与跑哪个预设无关 ⇒ 只查包内这一份。
 * 两类判定分开给：**缺文件**（打包事故）与**宿主行没引用**（文件在但 import 被删了 = 那两个
 * 插件不会被装载）。
 * @param ctx - 用于告警的 context。
 */
function checkEngines(ctx) {
	const parts = engineHalfFindings(TEAM_DIR, join(PACKAGE_ROOT, HOST_ENTRY))
	if (parts.length === 0) return
	report(
		ctx,
		`本包的团队能力那一层不完整：${parts.join('；')}（引擎目录 ${TEAM_DIR}，宿主行 ${HOST_ENTRY}）。` +
			'后果：**任意会话**都不会有那九个团队工具与策略段（`member_spawn` 等一个都不在）—— 重装本包（这两个文件随包发布，宿主行会自己装载它们）。',
	)
}

/**
 * 两个半边是否齐备 —— **判定只有这一处**。
 * @param engineDir - 两个半边所在目录（包内 `team/`）。
 * @param hostEntryPath - 宿主行模块的**完整路径**（读它看有没有 import 那两个引擎）。
 * @param engineFiles - 半边文件名；缺省用本模块那份清单。
 * @returns 一行行判定文本；齐备时返回空数组。
 */
export function engineHalfFindings(engineDir, hostEntryPath, engineFiles = ENGINE_FILES) {
	const missing = engineFiles.filter((file) => !existsSync(join(engineDir, file)))
	const text = readIfPresent(hostEntryPath)
	const unreferenced = text === undefined ? engineFiles.slice() : engineFiles.filter((file) => !text.includes(file))
	const parts = []
	if (missing.length > 0) parts.push(`缺文件：${missing.join('、')}`)
	if (unreferenced.length > 0) parts.push(`宿主行（board-view.host.js）里没有引用：${unreferenced.join('、')}`)
	return parts
}

/** 读一个小文本文件，读不到返回 undefined（诊断用：任何读取失败都只告警，不抛）。 */
function readIfPresent(path) {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		return undefined
	}
}

/**
 * 一条告警：优先走宿主 logger，退到 stderr。它**绝不**抛 —— 诊断不该把这一行带崩。
 * @param ctx - 本行所在的 context。
 * @param text - 告警正文。
 */
function report(ctx, text) {
	try {
		ctx.logger.error(`[dsh-team-ops] ${text}`)
		return
	} catch {
		/* logger 不可用，退回 stderr */
	}
	try {
		process.stderr.write(`[dsh-team-ops] ${text}\n`)
	} catch {
		/* stderr 也写不进去就算了 */
	}
}
