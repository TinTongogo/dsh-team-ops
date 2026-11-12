/**
 * **技能目录的"读哪一层"判定**（`ctx.skills` 是按作用域分层的；读错层会得出相反的结论）。
 *
 * 为什么单独一个文件：宿主半边要用它给面板列目录，运行时半边要用它核对"角色声明的常驻技能本机有没有"。
 * 两处各写一份的代价，现场已经付过一次 —— 运行时那份没带作用域 ⇒ 读到全局层 ⇒ 把**明明存在**的四个技能
 * 判成"本机没有"，回执当场报假警（假的比没有更坏：它会让人去改本来就对的角色定义）。
 *
 * 唯一的正文就是下面这两个函数，宿主与运行时都从这里引。
 */

/**
 * **读技能目录时的视图层**：技能注册表是 host + 按作用域分层的，而本部署里本地技能由
 * **预设那一层**提供（web-app 的 bundle 把宿主那行 `skill-filesystem` 关掉了，"presets own local discovery"）。
 * 于是"面板上有的"要等于"模型能加载的"，就必须带上**会话那一层的作用域**去读。
 *
 * 三层退法（每一层的理由都由 `why` 带着，面板只照印）：
 *   ① `session` —— 请求里的会话有活着的 Agent：用**那个 Agent**当视图作用域（它就是该会话的作用域键，
 *      `dsh-agent-loop` 用 `createScope(loopCtx, agent)` 铸的；预设那一层是它的祖先，链上取得到）；
 *   ② `root-agent` —— 那个会话不活着（或请求没带 session）：退用**当前活着的根会话**那一层；
 *   ③ `global` —— 一个活着的 Agent 都没有：只读全局层（本部署的全局层没有技能提供者 ⇒ 多半是空的
 *      —— 这时面板会说"没读到会话层"，**不会**说成"一个技能都没有"）。
 * @param ctx - 宿主 ctx（`agents` 是可选服务，不进 inject）。
 * @param sessionId - 请求里带的会话 id（可空）。
 * @returns `{ scope, layer, why }`；`scope` 为 `undefined` 表示按全局层读。
 */
export function skillScopeOf(ctx, sessionId) {
	const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
	if (agents === undefined || agents === null) {
		return { scope: undefined, layer: 'global', why: '本进程里取不到活着的 Agent 注册表（`ctx.agents` 没有），本次只读了**全局层**' }
	}
	const id = typeof sessionId === 'string' ? sessionId : ''
	if (id !== '' && typeof agents.get === 'function') {
		const live = agents.get(id)
		if (live !== undefined && live !== null) return { scope: live, layer: 'session', why: '' }
	}
	const roots = typeof agents.roots === 'function' ? agents.roots() : undefined
	const first = Array.isArray(roots) ? roots[0] : undefined
	if (first !== undefined && first !== null) {
		return {
			scope: first,
			layer: 'root-agent',
			why: id === '' ? '请求里没带会话 id（不知道你在哪个会话里），本次按**当前活着的根会话**那一层读' : `会话 ${id} 现在不活着（没有正在跑的 Agent），本次按**当前活着的根会话**那一层读`,
		}
	}
	return { scope: undefined, layer: 'global', why: '没有任何活着的 Agent（会话都没在跑），本次只读了**全局层**' }
}

/** 把"工作区 + 视图作用域"拼成注册表认的那个 options 形状（缺哪一项就不传哪一项）。 */
export function skillViewOptions(root, view) {
	const options = {}
	if (root !== null) options.cwd = root
	if (view !== null && view !== undefined && view.scope !== undefined) options.scope = view.scope
	return options
}
