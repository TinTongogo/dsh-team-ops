/**
 * 协作读数端点（阶段 5 的 UI 数据源）：`GET <前缀>/collab`。
 *
 * 只读：任务三态、交接单（最近 10 条）、路径归属冲突数、任务包缺格数。
 * 面板的「任务看板」块用它显示一行效率读数 —— 不给它单独的文档，也不新增写面。
 */
import { writeJson } from './http-tools.js'
import { collabMetricsOf, listHandoffNotes } from './collab.js'

/**
 * @param injected - `{ openWorkspaceOf, teamCredentialOf, requestedSession }`：与其余端点**同一条**工作区解析
 *   （请求带的 `?workspace=` 优先，其次会话工作目录，最后才是 composition 行配置的那一个）。
 *   **不许直接用 `fallback`**：那一格多数部署是 `null`，于是 `workspaceRootOf` 会退到
 *   `process.cwd()` —— 读的是 DSH 服务进程的目录，不是人在看的那个工作区（现场：面板上的交接单永远是空的）。
 */
export function createCollabRoutes(injected) {
	const deps = injected
	/**
	 * @param ctx - 宿主上下文（`agentTeams` 与 `fs` 由它给）。
	 * @param req - HTTP 请求（工作区从它的 `?workspace=` 解析）。
	 * @param res - HTTP 响应。
	 * @param fallback - composition 行配置的工作区（可为 null）。
	 */
	async function handleCollab(ctx, req, res, fallback) {
		const opened = await deps.openWorkspaceOf(ctx, req, res, fallback)
		if (opened === null) return
		// 任务那一半要一个**活着的本会话 Agent** 当凭据（原生 `listTasks(caller)` 就吃它）：
		// 与 `/team-tasks` 用**同一个** `teamCredentialOf`，不另写一份"哪算活着"的判定。
		const credential = deps.teamCredentialOf(ctx, deps.requestedSession(req.url), '团队任务')
		const exec = credential.ok === true ? { workspace: opened.root, agent: credential.lead } : { workspace: opened.root }
		try {
			// **只读一次**：读数与明细用同一份（分成两次读，等于每次面板刷新把文件读两遍）。
			const handoffs = await listHandoffNotes(ctx, exec)
			const metrics = await collabMetricsOf(ctx, exec, { handoffs, reason: credential.ok === true ? undefined : credential.reason })
			writeJson(res, 200, { ok: true, metrics, handoffs: handoffs.notes.slice(-10) })
		} catch (error) {
			writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
		}
	}
	return { handleCollab }
}
