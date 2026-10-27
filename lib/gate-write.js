/**
 * dsh-team-ops · 文件写入的单一接缝。
 *
 * 面板的 host 半边在**根作用域**，而文件写入内核（事务锁 / 原子发布 / 写入者标记 / 回读校验）
 * 在**引擎**里、随预设挂在会话作用域 —— 运行时够不着对方。本文件只做一件事：把引擎自己那份
 * 成员写动作原样转出去，并给出它认得的 `exec` 形状。
 *
 * **不复制任何写逻辑**：这里只允许是转发，不许重新实现幂等、留痕或校验规则 ——
 * 同一套语义只该有一份实现，否则两份迟早不一致。
 *
 * 写入范围（面板这几条写路径，全在这里点名）：
 *   · **角色增删改**：`createRole` / `editRole` / `removeRole` / `restoreRole` —— 写**角色根**
 *     下的 `roles/<id>/ROLE.md`（**缺省是本工作区的** `<工作区>/.dsh/team-ops/roles/`；`scope: "user"` 才是用户根），
 *     或写工作区文件里的**下架名单**（只在包内的角色不能从面板上删）。
 * 其余一律不经这里：建成员、建条目、改看板都只走会话里的工具。
 *
 * **成员那一档已经整面撤掉**（`update` / `delete` 两条成员端点只做拒绝，见 `board-view.host.js`）：
 * 成员是 DSH 原生 Agent Teams 的队友，原生名册没有"改提示词 / 删成员"这两种动作，
 * 所以这里**没有对应的转发** —— 面板不写 `.company-gate.members.json`。
 */

import { createRole, editRole, removeRole, restoreRole } from '../team/team-runtime.js'

/**
 * **角色的增删改**（面板「角色」那一节）。
 *
 * 四条都只是转发引擎自己那份实现（`createRole` / `editRole` / `removeRole` / `restoreRole`），
 * 本文件不重写任何判定（id 形状、同名拒绝、发布面不可删、下架记录的事务都在引擎里）。
 * 注意它们**缺省就写工作区里的角色根**（`<工作区>/.dsh/team-ops/roles/`）；显式 `scope: "user"` 才落
 * **用户角色根**（`$DSH_TEAM_OPS_ROLES`，缺省 `$DSH_HOME/team-ops/roles`）。
 * 删除只在下架那一支写工作区文件（`.company-gate.roster.json`）。
 */
export function createRoleInWorkspace(ctx, workspace, args) {
	return createRole(ctx, { workspace, sandboxPolicy: policyForWorkspace(ctx, workspace) }, { ...args, actor: 'human' })
}

/** 面板改一个角色的那三格（显示名 / 分类 / 一句话定位）：改用户根那一份，正文不动。 */
export function editRoleInWorkspace(ctx, workspace, args) {
	return editRole(ctx, { workspace, sandboxPolicy: policyForWorkspace(ctx, workspace) }, { ...args, actor: 'human' })
}

/** 面板删一个角色：用户根那份真删（覆盖包内同名的则是"回到包内"），只在包内的下架。 */
export async function removeRoleInWorkspace(ctx, workspace, args) {
	return removeRole(ctx, { workspace, sandboxPolicy: policyForWorkspace(ctx, workspace) }, { ...args, actor: 'human' })
}

/** 面板把下架的角色恢复上架。 */
export async function restoreRoleInWorkspace(ctx, workspace, args) {
	return restoreRole(ctx, { workspace, sandboxPolicy: policyForWorkspace(ctx, workspace) }, { ...args, actor: 'human' })
}

/**
 * 面板这次写入的沙箱策略：边界挪到请求的工作区，**不比部署默认更宽**。
 *
 * 面板无会话，而策略服务按"会话 cwd，否则部署默认根"定边界（`resolve()` 的实现），
 * 于是默认根落在别处、写工作区会被拒。这里显式给出 workspace 与 mode：
 * `mode` 一旦给出，`resolve()` 里的会话分支因 `??` 短路而不执行 —— 也就不去碰真会话才有的东西。
 * 部署默认是 read-only 时保持 read-only（不替人放宽）。
 * @param ctx - 宿主上下文。
 * @param workspace - 本次写入的工作区绝对路径。
 * @returns 策略对象，或 undefined（服务缺席时交给后端默认裁定）。
 */
export function policyForWorkspace(ctx, workspace) {
	const service = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined
	if (service === undefined || service === null || typeof service.resolve !== 'function') return undefined
	const base = service.resolve({})
	const mode = base !== null && base !== undefined && base.mode === 'read-only' ? 'read-only' : 'workspace-write'
	return service.resolve({ session: { header: { cwd: workspace } }, mode })
}
