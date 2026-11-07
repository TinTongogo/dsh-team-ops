/**
 * 成员写端点（停用 / 恢复 / 打断，以及旧客户端那两条**拒绝面**）。
 *
 * 成员实时名册归 DSH 原生 Agent Teams，本模块是「本插件这一层」的视图状态与拒绝回执：
 * 不写原生名册、不删成员；停用/恢复走引擎 `setMemberDisabled`，打断走原生 `interrupt`。
 * 宿主注入工作区解析、会话凭据解析与三条路由常量 —— 与其余端点族同一形状。
 */
import { bodyError, DECIDE_BODY_LIMIT, messageOf, readBody, writeJson } from './http-tools.js'
import { policyForWorkspace } from './gate-write.js'
import { setMemberDisabled } from '../team/team-runtime.js'

/**
 * @param deps - `{ openWorkspaceOf, teamCredentialOf, requestedSession, paths }`；
 *               `paths` 是 `{ disable, restore, interrupt }` 三条端点常量。
 * @returns `{ handleMemberWrite }`。
 */
export function createMemberWriteRoutes(injected) {
	const deps = injected
	/**
	 * 面板那两个成员写动作（编辑 / 删除）：**这是拒绝面，不是写面** —— 它一处文件都不写。
	 *
	 * 成员面已经整面撤掉：成员是 DSH 原生 Agent Teams 的队友，而原生名册只有"成员在不在"与 `failed`
	 * 两种事实（`TeamService` 只给 spawnTeammate / sendMessage / 任务那一组），没有"改提示词 /
	 * 删成员"这两种动作。所以两条路由**保留**下来只做一件事：对旧客户端、对直接 POST 的人，
	 * 如实拒绝并指路（"不用的队友不再派活即可；要打断当前那一轮用内置 `interrupt_agent`"）。
	 *
	 * 保留而不删路由的理由：**回执比 404 有用**。删掉路由，人拿到的是一句"没有这个端点"，
	 * 既不知道能力搬去哪了，也分不出"我拼错了"与"这个功能没了"。
	 *
	 * 仍然只接受 POST（与其余写端点同一条纪律：改状态的动作不接受 GET —— 免得被预取或图片标签
	 * 顺手触发）；参数 `ctx` / `req` / `fallback` 保留，因为路由那张表按同一个签名转发。
	 * @param ctx - 宿主 ctx（本函数不读，保留签名）。
	 * @param req - 请求（POST，JSON 体）。
	 * @param res - 响应。
	 * @param fallback - composition 行配的 workspace（可为 null）。
	 * @param action - `update` 改记录 / `delete` 删记录。
	 */
	async function handleMemberWrite(ctx, req, res, fallback, action) {
		// **四个动词分两类**（这一处是唯一正文）：
		//   · `disable` / `restore`：本插件这一层的**视图状态**（`.ops/member-flags.json`），
		//     走引擎的 `setMemberDisabled`（账本管道 + "同角色至少留 1 位"那道判定都在引擎里）；
		//   · `interrupt`：原生 `interrupt`，**只断当前那一轮**（收件箱保留、名册与两条上限不变）；
		//   · `update` / `delete`（老客户端的路由）：**如实拒绝并指路** —— 原生名册确实没有"改记录 / 删成员"，
		//     但这几句必须把**现在真能做的三个动词**说清楚，不能留一句和现实打架的话。
		if (req.method !== 'POST') {
			writeJson(res, 405, { ok: false, error: '这个动作只支持 POST' })
			return
		}
		if (action !== 'disable' && action !== 'restore' && action !== 'interrupt') {
			writeJson(res, 200, {
				ok: false,
				error:
					`本插件不能${action === 'delete' ? '删除成员' : '改成员记录'}：成员就是 DSH 原生 Agent Teams 的队友，原生名册没有这几种动作。` +
					'现在能做的三个动词是：**停用**（不再派活、**不占角色槽位**，可恢复）、**恢复**、**打断当前那一轮** —— ' +
					`面板「成员」每张卡上就有；直接调是 POST \`${deps.paths.disable}\` / \`${deps.paths.restore}\` / \`${deps.paths.interrupt}\`。`,
			})
			return
		}
		let body
		try {
			body = JSON.parse(await readBody(req, DECIDE_BODY_LIMIT))
		} catch (error) {
			bodyError(res, error, DECIDE_BODY_LIMIT)
			return
		}
		const name = typeof body?.name === 'string' ? body.name.trim() : ''
		if (name === '') {
			writeJson(res, 400, { ok: false, error: 'name 必填：要点名是哪一位成员。' })
			return
		}
		const opened = await deps.openWorkspaceOf(ctx, req, res, fallback, { writable: action !== 'interrupt' })
		if (opened === null) return
		const resolved = opened.resolved
		if (action === 'interrupt') {
			const credential = deps.teamCredentialOf(ctx, deps.requestedSession(req.url), ' 打断')
			if (!credential.ok) {
				writeJson(res, 503, { ok: false, error: credential.reason })
				return
			}
			if (typeof credential.teams.interrupt !== 'function') {
				writeJson(res, 503, { ok: false, error: '这个部署的原生团队服务没有 `interrupt`（打断）这一档。' })
				return
			}
			try {
				const done = credential.teams.interrupt(credential.lead, name)
				writeJson(res, 200, {
					ok: true,
					workspace: resolved.root,
					workspaceSource: resolved.source,
					name,
					previousStatus: done?.previousStatus ?? 'unknown',
					// **只断当前那一轮**：这三句要在回执里说全（收件箱 / 名册 / 两条上限都不动）。
					note: '只打断了它**当前那一轮**：收件箱里的消息保留、**原生名册行**与两条上限（角色槽位 ≤3、在场总人数 ≤24，含停用者与 `failed`）都不变 —— 下次 `member_send` 唤醒它照旧接着干。',
					actor: 'human',
				})
			} catch (error) {
				writeJson(res, 409, { ok: false, error: messageOf(error) })
			}
			return
		}
		// **凭据必须在这里解析**（与 `interrupt` 用同一个 `teamCredentialOf`，不另写判定）：
		// 这条端点路上没有 `exec.agent`（引擎那条路的 `exec` 来自会话工具调用），而原生 `listMembers`
		// 要的是"确切的活着的 Lead Agent" ⇒ 宿主解析好放进 `exec.lead` 再交给引擎。
		const credential = deps.teamCredentialOf(ctx, deps.requestedSession(req.url), ' 停用/恢复')
		if (!credential.ok) {
			writeJson(res, 503, { ok: false, error: credential.reason })
			return
		}
		try {
			const done = await setMemberDisabled(ctx, { workspace: resolved.root, sandboxPolicy: policyForWorkspace(ctx, resolved.root), lead: credential.lead }, { name, disabled: action === 'disable' })
			writeJson(res, 200, {
				ok: true,
				workspace: resolved.root,
				workspaceSource: resolved.source,
				...done,
				// **如实说**：停用是本插件这一层的视图状态，原生名册里那个人**仍然在**。
				note: done.disabled
					? '已标成**停用**（本插件的视图状态）：**本插件不再派活给它**（不占角色槽位、不被自动复用、`member_send` 会拒）；**它在宿主原生界面里仍然可以打开对话** —— 「停用」只在本插件的调度层生效，宿主没有移除 / 停用成员的接口。随时可以恢复。'
					: '已**恢复**：重新占这一档的角色槽位、也能重新接活（恢复不设任何上限）。',
				actor: 'human',
			})
		} catch (error) {
			writeJson(res, 409, { ok: false, error: messageOf(error) })
		}
	}

	return { handleMemberWrite }
}
