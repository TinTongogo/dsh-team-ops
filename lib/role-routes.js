/**
 * 角色块的 HTTP 端点族：清单 / 正文 / 头像 / 开关 / 复制为自定义 / 增删改恢复。
 *
 * 与 `lib/skill-routes.js` 同一形状：宿主注入工作区解析与来源警告，其余依赖直接 import；
 * 角色判定、枚举与落盘分别在 `team/team-runtime.js` 与 `lib/gate-write.js`，宿主不另写一份。
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { bodyError, DECIDE_BODY_LIMIT, messageOf, queryValue, readBody, writeJson } from './http-tools.js'
import { createRoleInWorkspace, editRoleInWorkspace, policyForWorkspace, removeRoleInWorkspace, restoreRoleInWorkspace } from './gate-write.js'
import { customizeRole, roleDefinitionTextOf, roleRecords, rolesViewOf, setRoleEnabled } from '../team/team-runtime.js'

/** 角色写请求体：整段提示词可以很长（人设 + 首活），给 64 KB。 */
const ROLE_BODY_LIMIT = 64 * 1024
/** 角色自定义头像：认这几个扩展名（引擎那份 `AVATAR_FILE_NAMES` 决定命中哪个）。 */
const AVATAR_TYPES = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' }
/** 头像文件上限：它是给人看的贴图，不该有几 MB。 */
const AVATAR_SIZE_LIMIT = 512 * 1024

/**
 * @param deps - `{ openWorkspaceOf, openWorkspaceSoftly, workspaceSourceWarnings }`。
 * @returns 六个端点函数的引用。
 */
export function createRoleRoutes(injected) {
	const deps = injected
	/**
	 * 角色清单（**读**）：当前团队有哪些角色、各自启用与否。
	 *
	 * 角色的真相源是角色目录（引擎现场枚举），启用状态在当前工作区的 `.ops/roles.json`。
	 * 这个端点比成员端点简单：**不需要工作区**就能读清单（角色是全局的），但"哪些启用"是**按工作区**的
	 * —— 所以工作区取不到时也照答，只是把 `workspaceSource` 与警告一并给出（面板据此说明"读的是哪个团队的开关"）。
	 * @param ctx - 宿主 ctx。
	 * @param req - 请求（GET）。
	 * @param res - 响应。
	 * @param fallback - composition 行配的 workspace。
	 */
	async function handleRoles(ctx, req, res, fallback) {
		if (req.method !== 'GET') {
			writeJson(res, 405, { ok: false, error: '角色清单只支持 GET' })
			return
		}
		const opened = await deps.openWorkspaceSoftly(ctx, req, res, fallback)
		if (opened === null) return
		const resolved = opened.resolved
		try {
			// 工作区定不下来时用配置值/进程工作区兜底读"停用名单"（读不到就按"一个都没停用"，
			// 并在 warnings 里如实说 —— 不假装这是某个团队的开关）。
			const exec = resolved.root === null ? { workspace: fallback ?? undefined } : { workspace: resolved.root }
			const view = await rolesViewOf(ctx, exec)
			const warnings = deps.workspaceSourceWarnings(resolved)
			writeJson(res, 200, {
				ok: true,
				workspace: resolved.root,
				workspaceSource: resolved.source,
				counts: { all: view.roles.length, enabled: view.roles.filter((role) => role.enabled).length, disabled: view.disabled.length },
				roles: view.roles,
				references: view.reference,
				staleDisabled: view.staleDisabled,
				roots: view.roots,
				file: view.file,
				warnings,
			})
		} catch (error) {
			writeJson(res, 503, { ok: false, error: messageOf(error) })
		}
	}

	/**
	 * 一个角色的技能原文（**读**）：面板的「查看 / 复制」用它。
	 *
	 * 只从现场名册那两条根里读（引擎的 `roleDefinitionTextOf` 里面判），**不接受任意路径** ——
	 * 于是这个端点不可能被用来读工作区之外的任何文件。
	 * @param ctx - 宿主 ctx。
	 * @param req - 请求（GET，`?role=<id>`）。
	 * @param res - 响应。
	 * @param fallback - composition 行配的 workspace。
	 */
	async function handleRoleDefinition(ctx, req, res, fallback) {
		if (req.method !== 'GET') {
			writeJson(res, 405, { ok: false, error: '角色技能原文只支持 GET' })
			return
		}
		const wanted = queryValue(req.url, 'role')
		if (wanted === '') {
			writeJson(res, 400, { ok: false, error: 'role 必填：要看哪个角色的技能原文' })
			return
		}
		try {
			writeJson(res, 200, { ok: true, ...roleDefinitionTextOf(ctx, { workspace: typeof fallback === 'string' ? fallback : undefined }, wanted) })
		} catch (error) {
			writeJson(res, 404, { ok: false, error: messageOf(error) })
		}
	}

	/**
	 * 一个角色的自定义头像文件（**读**）：角色目录里的 `avatar.svg|png|webp|jpg|jpeg`。
	 *
	 * 只认现场名册里那条记录所在目录下的那五个文件名（`roleRecords` 已经把命中文件名记下了），
	 * 路径不由请求拼出来 —— 请求里只有角色 id。读不到就 404（面板退回 emoji 圆底，不报错）。
	 * @param ctx - 宿主 ctx。
	 * @param req - 请求（GET，`?role=<id>`）。
	 * @param res - 响应。
	 */
	async function handleRoleAvatar(ctx, req, res) {
		if (req.method !== 'GET') {
			writeJson(res, 405, { ok: false, error: '头像只支持 GET' })
			return
		}
		const wanted = queryValue(req.url, 'role')
		if (wanted === '') {
			writeJson(res, 400, { ok: false, error: 'role 必填' })
			return
		}
		try {
			const record = roleRecords().find((item) => item.id === wanted && item.avatarFile !== null)
			if (record === undefined) {
				writeJson(res, 404, { ok: false, error: `角色 ${wanted} 没有自定义头像文件（角色目录里放 avatar.png/svg/webp/jpg 即可）` })
				return
			}
			const file = join(record.dir, record.avatarFile)
			// 路径**不是**从请求拼出来的：请求里只有角色 id，文件名来自引擎那次的现场枚举。
			// 读文件用 `node:fs`（不经 `ctx.fs` 的读契约）：读的是本插件自己的用户根/包内技能目录。
			const info = statSync(file)
			if (!info.isFile()) {
				writeJson(res, 404, { ok: false, error: '头像文件读不到' })
				return
			}
			if (info.size > AVATAR_SIZE_LIMIT) {
				writeJson(res, 413, { ok: false, error: `头像文件超过 ${Math.round(AVATAR_SIZE_LIMIT / 1024)} KB，请压一下` })
				return
			}
			const bytes = readFileSync(file)
			res.writeHead(200, { 'content-type': AVATAR_TYPES[record.avatarFile.split('.').pop().toLowerCase()] ?? 'application/octet-stream', 'content-length': String(bytes.length), 'cache-control': 'no-store' })
			res.end(bytes)
		} catch (error) {
			writeJson(res, 404, { ok: false, error: messageOf(error) })
		}
	}

	/**
	 * 开 / 关一个角色（**写**）：`POST { role, enabled }`。语义全在引擎那份 `setRoleEnabled` 里
	 * （停用 = 不能派新成员 + 不参与自动续领；已在场的成员不受影响）。
	 * @param ctx - 宿主 ctx。
	 * @param req - 请求（POST，JSON 体 `{ role, enabled }`）。
	 * @param res - 响应。
	 * @param fallback - composition 行配的 workspace。
	 */
	async function handleRoleToggle(ctx, req, res, fallback) {
		if (req.method !== 'POST') {
			writeJson(res, 405, { ok: false, error: '角色开关只支持 POST' })
			return
		}
		const opened = await deps.openWorkspaceOf(ctx, req, res, fallback, { writable: true })
		if (opened === null) return
		const resolved = opened.resolved
		let body
		try {
			body = JSON.parse(await readBody(req, DECIDE_BODY_LIMIT))
		} catch (error) {
			bodyError(res, error, DECIDE_BODY_LIMIT)
			return
		}
		try {
			const done = await setRoleEnabled(ctx, { workspace: resolved.root, sandboxPolicy: policyForWorkspace(ctx, resolved.root) }, { role: body?.role, enabled: body?.enabled === true })
			writeJson(res, 200, { ok: true, workspace: resolved.root, workspaceSource: resolved.source, ...done, actor: 'human' })
		} catch (error) {
			writeJson(res, 409, { ok: false, error: messageOf(error) })
		}
	}

	/**
	 * 「复制为自定义」（**写**）：把包内角色复制进**角色根**（缺省本工作区；`scope: "user"` 才是用户级角色根），供人自由改。
	 *
	 * 这一步写的是本插件自己的**角色根**（缺省 `<工作区>/.dsh/team-ops/roles/<id>/ROLE.md`，`scope: "user"` 才是 `~/.dsh/team-ops/roles/`），
	 * 不是工作区文件 —— 所以它不走 `gate-write.js`，而是直接转发引擎那份 `customizeRole`（判定仍在引擎里：
	 * id 形状、重名往后加序号、不覆盖任何既有目录）。回执里那对字段（`promptRoster: 'stale'` +
	 * `promptRosterNote`）要按事实读：**工具面立刻可用**（`member_defaults` / `member_spawn` 现枚举），
	 * 旧了的只是**注入到系统提示里那份「可叫的队友」清单**这颗快照。
	 * @param ctx - 宿主 ctx。
	 * @param req - 请求（POST，JSON 体 `{ role, id? }`）。
	 * @param res - 响应。
	 * @param fallback - composition 行配的 workspace。
	 */
	async function handleRoleCustomize(ctx, req, res, fallback) {
		if (req.method !== 'POST') {
			writeJson(res, 405, { ok: false, error: '复制为自定义只支持 POST' })
			return
		}
		let body
		try {
			body = JSON.parse(await readBody(req, DECIDE_BODY_LIMIT))
		} catch (error) {
			bodyError(res, error, DECIDE_BODY_LIMIT)
			return
		}
		// 工作区**按请求给**（与其余角色端点同一条：`?workspace=` 优先、其次 composition 行的 fallback）——
		// 作用域缺省就是"本工作区"，解析不到工作区时那一支会如实拒绝（而不是悄悄落到 `process.cwd()`）。
		const opened = await deps.openWorkspaceOf(ctx, req, res, fallback)
		if (opened === null) return
		try {
			const done = customizeRole(
				ctx,
				{ workspace: opened.root },
				// 复制为自定义也认作用域（缺省工作区根）：不给人留一条"只能往全局塞"的路。
				{ role: body?.role, id: body?.id, ...(Object.hasOwn(body ?? {}, 'scope') ? { scope: body.scope } : {}) },
			)
			writeJson(res, 200, { ok: true, ...done, actor: 'human' })
		} catch (error) {
			writeJson(res, 409, { ok: false, error: messageOf(error) })
		}
	}

	/**
	 * 「角色」那三条写路径的实现：翻译请求体 → 转发引擎 → 原样转达结论。
	 *
	 * 字段白名单（与成员那两条同一条纪律：只点名接受那几个字段，其余一概不看）：
	 *   · `update`（添加 / 修改）：`role` 缺 = **添加**（`id` / `title` / `category` / `positioning` /
	 *     `body`）；给了 `role` = **修改**（`title` / `category` / `positioning`，至少一格）；
	 *   · `remove`：`role`（要删/要下架哪一个）；
	 *   · `restore`：`role`（把下架的恢复上架）。
	 * @param ctx - 宿主上下文。
	 * @param req - 请求。
	 * @param res - 响应。
	 * @param fallback - 请求未带 workspace 时用的 composition 行配置值。
	 * @param action - `'update' | 'remove' | 'restore'`。
	 */
	async function handleRoleWrite(ctx, req, res, fallback, action) {
		if (req.method !== 'POST') {
			writeJson(res, 405, { ok: false, error: `角色增删改只支持 POST（${action}）` })
			return
		}
		const opened = await deps.openWorkspaceOf(ctx, req, res, fallback, { writable: true })
		if (opened === null) return
		const root = opened.root
		const resolved = opened.resolved
		let body
		try {
			body = JSON.parse(await readBody(req, ROLE_BODY_LIMIT))
		} catch (error) {
			bodyError(res, error, ROLE_BODY_LIMIT)
			return
		}
		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			writeJson(res, 400, { ok: false, error: '请求体必须是一个对象' })
			return
		}
		const role = typeof body.role === 'string' ? body.role.trim() : ''
		if (action === 'update' && role === '' && (typeof body.id !== 'string' || body.id.trim() === '')) {
			writeJson(res, 400, { ok: false, error: '添加角色要 id（lower-kebab-case）；改一个已有角色要 role。' })
			return
		}
		if (action !== 'update' && role === '') {
			writeJson(res, 400, { ok: false, error: 'role 必填：要点名删/恢复哪一个角色' })
			return
		}
		try {
			const result =
				action === 'remove'
					? await removeRoleInWorkspace(ctx, root, { role })
					: action === 'restore'
						? await restoreRoleInWorkspace(ctx, root, { role })
						: role === ''
							? createRoleInWorkspace(ctx, root, {
									id: body.id,
									// **作用域**（HD-008）：缺省工作区根；`user` 必须显式给（引擎里那些判定与措辞都在一处）。
									...(Object.hasOwn(body, 'scope') ? { scope: body.scope } : {}),
									...(Object.hasOwn(body, 'title') ? { title: body.title } : {}),
									...(Object.hasOwn(body, 'category') ? { category: body.category } : {}),
									positioning: body.positioning,
									...(Object.hasOwn(body, 'body') ? { body: body.body } : {}),
									// **专属技能**（可选，逗号分隔）：给了就写进 `skills:` 那一行；空串表示"没有专属技能"。
									...(Object.hasOwn(body, 'skills') ? { skills: body.skills } : {}),
								})
							: await editRoleInWorkspace(ctx, root, {
									role,
									...(Object.hasOwn(body, 'scope') ? { scope: body.scope } : {}),
									...(Object.hasOwn(body, 'title') ? { title: body.title } : {}),
									...(Object.hasOwn(body, 'category') ? { category: body.category } : {}),
									...(Object.hasOwn(body, 'positioning') ? { positioning: body.positioning } : {}),
									...(Object.hasOwn(body, 'skills') ? { skills: body.skills } : {}),
								})
			writeJson(res, 200, { ok: true, workspace: root, workspaceSource: resolved.source, action, ...result })
		} catch (error) {
			// 引擎的拒绝（id 形状不对 / 同名已存在 / 要改的角色不在名册里 / 改的那一格全空）是
			// **调用方能改的错**，原样回 409 并把引擎给的说明带给操作者。
			writeJson(res, 409, { ok: false, error: messageOf(error) })
		}
	}

	return { handleRoles, handleRoleDefinition, handleRoleAvatar, handleRoleToggle, handleRoleCustomize, handleRoleWrite }
}
