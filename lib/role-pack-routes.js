/**
 * 角色包的两个 HTTP 端点（导出 / 导入）。
 *
 * 包的格式、导入判定与落盘全在 `lib/role-pack.js`；这里只做参数校验、工作区解析与回执。
 * 宿主把 `openWorkspaceOf` / `openWorkspaceSoftly` 注入进来 —— 端点因此不依赖宿主内部状态，
 * 后续按端点族拆分可以照同一个形状复制。
 */
import { buildRolePack, importRolePack, inspectRolePack, packSummaryOf, suggestedPackName } from './role-pack.js'
import { bodyError, queryValue, readBody, writeJson } from './http-tools.js'

/** 导入请求体上限：整个角色包（base64 会膨胀），比 `lib/role-pack.js` 的 8 MB 包上限留足余量。 */
const ROLE_PACK_BODY_LIMIT = 12 * 1024 * 1024

/**
 * @param deps - `{ openWorkspaceOf, openWorkspaceSoftly }`（宿主的工作区解析，写侧边界在前者里）。
 * @returns `{ handleRoleExport, handleRoleImport }`。
 */
export function createRolePackRoutes({ openWorkspaceOf, openWorkspaceSoftly }) {
	/**
	 * **导出角色包**（GET）：把当前能看到的自建角色（以及它们引用的自建技能）打成一个包交回面板。
	 *
	 * 参数：`?scope=all|workspace|user`（缺省 all）、`?role=<id>`（单角色导出）。
	 * 一个自建角色都没有时回 409 并说明原因 —— **不产出空包**（空包导入时除了让人困惑没有别的作用）。
	 * @param ctx - 宿主 ctx。
	 * @param req - GET 请求。
	 * @param res - 响应。
	 * @param fallback - composition 行配的 workspace。
	 */
	async function handleRoleExport(ctx, req, res, fallback) {
		if (req.method !== 'GET') {
			writeJson(res, 405, { ok: false, error: '角色包导出只支持 GET' })
			return
		}
		const opened = await openWorkspaceSoftly(ctx, req, res, fallback)
		if (opened === null) return
		const scope = queryValue(req.url, 'scope') || 'all'
		if (scope !== 'all' && scope !== 'workspace' && scope !== 'user') {
			writeJson(res, 400, { ok: false, error: `scope 只支持 all / workspace / user（收到 ${scope}）` })
			return
		}
		const only = queryValue(req.url, 'role')
		const built = buildRolePack({ workspace: opened.root, scope, only: only === '' ? [] : [only] })
		if (built.ok !== true) {
			writeJson(res, 409, { ok: false, error: built.reason })
			return
		}
		writeJson(res, 200, {
			ok: true,
			fileName: suggestedPackName(),
			pack: built.pack,
			summary: packSummaryOf(built.pack),
			warnings: opened.warnings,
		})
	}

	/**
	 * **导入角色包**（POST）：把包落进目标作用域。请求体 `{ pack, scope, onConflict, preview }`。
	 *
	 * `preview: true` 只回预览（哪些是新的 / 已存在 / 会遮蔽包内角色），不落任何文件 ——
	 * 面板的「先预览、后落盘」就是分两次调它。
	 * 作用域 `workspace` 要过写侧边界；`user` 与 `role_define` 的 user 作用域同一条路（写用户根，不动工作区）。
	 * @param ctx - 宿主 ctx。
	 * @param req - POST 请求。
	 * @param res - 响应。
	 * @param fallback - composition 行配的 workspace。
	 */
	async function handleRoleImport(ctx, req, res, fallback) {
		if (req.method !== 'POST') {
			writeJson(res, 405, { ok: false, error: '角色包导入只支持 POST' })
			return
		}
		let body
		try {
			body = JSON.parse(await readBody(req, ROLE_PACK_BODY_LIMIT))
		} catch (error) {
			bodyError(res, error, ROLE_PACK_BODY_LIMIT)
			return
		}
		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			writeJson(res, 400, { ok: false, error: '请求体必须是一个对象' })
			return
		}
		const scope = typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'workspace'
		if (scope !== 'workspace' && scope !== 'user') {
			writeJson(res, 400, { ok: false, error: `scope 只支持 workspace / user（收到 ${scope}）` })
			return
		}
		const onConflict = typeof body.onConflict === 'string' && body.onConflict.trim() !== '' ? body.onConflict.trim() : 'skip'
		if (onConflict !== 'skip' && onConflict !== 'overwrite') {
			writeJson(res, 400, { ok: false, error: `onConflict 只支持 skip / overwrite（收到 ${onConflict}）` })
			return
		}
		if (body.pack === undefined || body.pack === null) {
			writeJson(res, 400, { ok: false, error: '请求体要带 pack（角色包本体：对象或 JSON 文本均可）' })
			return
		}
		// 项目级要过写侧边界（会真的往工作区里写）；用户级与 `role_define` 的 user 作用域同一条路。
		const opened = scope === 'workspace' ? await openWorkspaceOf(ctx, req, res, fallback, { writable: true }) : await openWorkspaceSoftly(ctx, req, res, fallback)
		if (opened === null) return
		const workspace = opened.root
		if (body.preview === true) {
			const inspected = inspectRolePack(body.pack, { workspace, scope })
			if (inspected.ok !== true) {
				writeJson(res, 409, { ok: false, error: inspected.reason })
				return
			}
			writeJson(res, 200, { ok: true, preview: true, plan: inspected.plan })
			return
		}
		const result = importRolePack(body.pack, { workspace, scope, onConflict })
		if (result.ok !== true) {
			writeJson(res, 409, { ok: false, error: result.reason })
			return
		}
		writeJson(res, 200, { ok: true, preview: false, workspaceSource: opened.source, ...result })
	}

	return { handleRoleExport, handleRoleImport }
}
