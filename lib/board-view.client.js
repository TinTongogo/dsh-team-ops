// dsh-team-ops · 一人公司文件前端页 —— browser half（client bundle）
//
// 由 dsh-client-modules 以 `/plugins/??dsh-team-ops/client.js&rev=…` 组合投递，
// 在浏览器里经 cordis Loader 的 lazy-CJS 模块表执行：本文件是「调用
// window.__ModuleLoader__.load 注册一个 CJS 工厂」的形态，与官方 ui-* 包以及
// 第三方 dsh-dream-skin 的构建产物同一形状。工厂内只有平台种子词与已注册的
// client bundle 可以被 require。
//
// 席位（**两个**）：① conversation.view —— 对话窗视图栏里「对话」「轨迹」之后的那一栏（四块）；
//                  ② conversation.input.left —— 输入框工具行里那一枚「角色」按钮（选角色 ⇒ 让它去干）
// （「团队状态」）。内里**四块**，块序 = **成员 / 角色 / 技能 / 任务看板**
// （成员最前，打开面板即落在成员上；「角色」那一整节从成员块里搬出来、独立成一块 —— 来源筛选、
// 角色卡、导出 / 导入、添加 / 修改 / 下架 / 删除 / 恢复与角色包弹窗全在这一块）。
// 数据：GET /company-board/api（任务看板那份视图）
//       + /company-board/api/status（三行状态）
//       + /company-board/api/members（成员块与角色块：名册读数 + 运行时状态 + 头像映射
//         + 角色目录 `defaults` —— 两块读同一份载荷，各画各的那一半）
//       + /company-board/api/skills{,/definition}（技能块：宿主技能注册表 `ctx.skills` 的目录与正文），
//       由本包 host half（lib/board-view.host.js）提供。两个文件里的 API_PREFIX 必须一致。
// 工作区：这一栏按会话渲染，订阅 `sessions.list`，把**当前会话的工作目录**作为
//       `?workspace=` 传给端点 ⇒ 切换会话/工作区时跟着变，而不是只认 composition 行里
//       配的那一个常量（那是取不到会话时的回落值）。
//
// 分区地图（**这份地图与下面各分区的横幅是一对**：横幅写作 `// ── <编号> <名字>`；
// 自检按"地图里列出的每一条都有同名横幅、且顺序一致"钉住 —— 插了新分区不更新地图会红）：
//   ① 种子、席位与防御      requireSeed / React / clientCtx（工厂抛异常会拖垮整个 web shell，见头注）
//   ② 端点与常量            所有 HTTP 端点、上限常量、PANE_MARK
//   ③ 取数缓存与 URL         paneCache / getJsonCached / 三个 URL 拼装
//   ④ 界面规格与配色         SPECS / BLOCKS / TONE_VAR（四块的名字与顺序就在这里）
//   ⑤ 样式表                 CSS 数组（所有 .cbv-* 类名与配色变量都只在这一处）
//   ⑥ 渲染原语与 Markdown    el / text / markdownNodes（浮窗里的表格也走它）
//   ⑦ 头像、分栏与卡片原语    AVATAR_ICONS / boardCard / CARD_SHELL_PROPS
//   ⑧ 会话、工作区与高度      订阅 sessions、取当前工作区/会话 id、量高度
//   ⑨ 词表与分栏规格         成员/技能的状态词与分档、团队任务板三栏
//   ⑩ 状态视图与任务板        StatusView / TaskBoardView（视图栏里那一栏的内容）
//   ⑪ 角色触发源与输入框席位   rosterCache / RoleComposerEntry（`@` 菜单与那枚「角色」按钮）
//   ⑫ 成员块                 MembersView（卡片、筛选、只读动作「查看/复制提示词」；成员写面已撤）
//   ⑬ 角色块                 RolesView + rosterSectionOf（来源筛选、角色卡增删改、导出导入、角色包弹窗）
//   ⑭ 技能块                 SkillsView（清单、正文浮窗、导入/新建/删除）
//   ⑮ 任务看板块              原生任务板三栏 + 详情浮窗（本插件看板那一档已撤：任务在原生那本账上）
//   ⑯ 装配与导出              insertStyles / apply / 席位导出
//
// 防御约定（照 dsh-dream-skin 的教训）：loader 不隔离各入口工厂，一个抛出的
// 工厂会被聚合成 “entries did not activate” 并把整个 web shell 拖垮。因此
// 种子解析全部包在 try 里，失败时导出一个「哑模块」——插件隐身，页面安然。

window.__ModuleLoader__.load({
	id: 'dsh-team-ops',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		// ── ① 种子、席位与防御 ────────────────────────────────────────────────
		const seedError = { last: null }
		const requireSeed = (name) => {
			try {
				return require(name)
			} catch (error) {
				seedError.last = error
				return null
			}
		}

		const React = requireSeed('react')

		if (React === null) {
			try {
				console.warn('[dsh-team-ops] react 种子不可用，文件前端页已禁用：', seedError.last && seedError.last.message)
			} catch {}
			exports.apply = () => {}
			return module.exports
		}

		/**
		 * `react-dom` 种子 —— **只为一件事**：把输入框那一枚「角色」按钮的选择框 portal 到 `document.body`
		 * （见下面 `portalOf`）。
		 *
		 * 为什么非它不可：选择框用 `position: fixed`，而它挂在宿主的 `conversation.input.left` 席位里，
		 * 那一片在**已激活的会话**下会被本体自己的 `.composerSeat` 罩住 —— 那一层带
		 * `will-change: transform`，于是给后代造了一个**包含块**：`fixed` 不再是"相对视口"，而是相对
		 * 那层输入框。实测症状就是选择框整体右移、跟按钮对不上（`bottom` 恰好还落在差不多的位置，
		 * 所以只错横轴，最容易看成"随机错位"）。宿主那份插槽契约里把这件事写死了：
		 * `conversation.input.left` 的摘要原文是
		 * "Compact controls at the left of the composer tool row; **fixed overlays must portal to the
		 * document body because the docked composer contains them**." ⇒ 修法就是照它说的：portal 到 body。
		 *
		 * 拿不到这个种子（离线自检那套"穷人的 React"只喂 `react`）时返回 `null`，`portalOf` 会退化成就地
		 * 渲染 —— 位置照算，只是照旧受包含块影响；**不许因此抛错**（工厂一抛会把整个 web shell 拖垮）。
		 */
		const ReactDOM = requireSeed('react-dom')

		/**
		 * 本插件的客户端 ctx —— `apply` 一进来就装在这里。
		 *
		 * 为什么要有这一格：取值帮手（`sessionsListStore` / `resolveCurrentSessionId` /
		 * `subscribeCurrentSession`）与视图组件都定义在 `apply` **之外**（与本函数同级），
		 * 而 `ctx` 只作为 `apply` 的形参存在。少了这一格，帮手里的 `ctx` 就是个**未声明变量**：
		 * 读成 `undefined`、`.get` 抛错、被各自的兜底 catch 吞掉 —— 症状是**静默退化成"取不到会话"**
		 * （面板不再跟当前会话的工作区/会话走），而且不报错、日志里一个字都没有。
		 */
		let clientCtx = null
		/** 统一的服务取值：拿不到（还没 apply、或该服务不在）一律 `undefined`，不抛。 */
		const serviceOf = (name) => {
			try {
				return clientCtx === null || typeof clientCtx.get !== 'function' ? undefined : clientCtx.get(name)
			} catch {
				return undefined
			}
		}

		/** 与 host half 的 ROUTE_PATH 必须一致。 */
		// ── ② 端点与常量 ───────────────────────────────────────────────────
		const API_PREFIX = '/company-board/api'
		/** 首屏那三行的端点（与 host half 的 STATUS_PATH 必须一致）。口径同源在引擎的 statusSnapshot。 */
		const STATUS_ENDPOINT = API_PREFIX + '/status'
		// 面板的"是哪一版"标记：**只放 data 属性，不挂 title**（挂 title 会在鼠标经过时弹提示，现场明确不要）。
		// 改形态/观感就换这串字；核对时在 DOM 里看 `data-pane-mark` 即可。
		// 块序（人的指令，改过四轮，这一版是第四轮）：**成员最前**（打开即落在成员上）→ **角色**
		// （角色目录从成员块里拆出来，独立成一块）→ **技能** → **任务看板**。
		const PANE_MARK = 'f114-「角色」选择框 portal 到 body：不再吃输入框那个包含块（修现场错位）'
		// 量高余量：面板底边与容器底边之间留这么几像素，避免"刚好相等"时因为一个像素的取整误差撑出滚动条。
		const PANE_HEIGHT_MARGIN = 2
		/** 打开本地目录（与 host half 的 OPEN_PATH 必须一致）。 */
		const OPEN_ENDPOINT = API_PREFIX + '/open'

		// ── 「成员」块：与 host 的成员读路径一致 ────────────────────────────────────────
		// 只有读：成员栏与会话工具 `member_list` 同一份判定；成员是宿主原生的队友，本插件不改 / 不删 / 不启停
		// （host 那两条写路由保留为防御性拒绝，直接 POST 也拿不到改动）。
		const MEMBERS_ENDPOINT = API_PREFIX + '/members'
		/** 「角色」那三条写路径（增删改）。端点常量与 host half 的常量逐字对齐（有自检）。 */
		const ROLES_UPDATE_ENDPOINT = API_PREFIX + '/roles/update'
		const ROLES_REMOVE_ENDPOINT = API_PREFIX + '/roles/remove'
		const ROLES_RESTORE_ENDPOINT = API_PREFIX + '/roles/restore'
		/** 角色包两条路：导出（GET）/ 导入（POST，先 preview 再落盘）。与 host half 的常量逐字对齐（有自检）。 */
		const ROLES_EXPORT_ENDPOINT = API_PREFIX + '/roles/export'
		const ROLES_IMPORT_ENDPOINT = API_PREFIX + '/roles/import'
		// 成员那三个动词（HD-006）：**服务端给动词、客户端不猜** —— 卡上给哪几个按钮看载荷里的 `verbs`。
		const MEMBERS_DISABLE_ENDPOINT = MEMBERS_ENDPOINT + '/disable'
		const MEMBERS_RESTORE_ENDPOINT = MEMBERS_ENDPOINT + '/restore'
		const MEMBERS_INTERRUPT_ENDPOINT = MEMBERS_ENDPOINT + '/interrupt'
		/** 团队服务那一层的查 / 开 / 关（与 host half 的 TEAM_SERVICE_PATH 逐字对齐）。 */
		const TEAM_SERVICE_ENDPOINT = API_PREFIX + '/team-service'

		// ── 「技能」块：与 host 的 SKILLS_PATH / SKILL_DEFINITION_PATH 一致 ──────────────
		// 清单与正文不自己读盘：host 转发给宿主技能注册表（`ctx.skills`，DSH 会加载哪些技能的唯一正文）；只读。
		const TEAM_TASKS_ENDPOINT = API_PREFIX + '/team-tasks'
		// 协作读数（任务三态 / 交接单 / 冲突 / 任务包缺格）；只读，面板「任务看板」块顶部那一行。
		const COLLAB_ENDPOINT = API_PREFIX + '/collab'

		const SKILLS_ENDPOINT = API_PREFIX + '/skills'
		const SKILL_DEFINITION_ENDPOINT = SKILLS_ENDPOINT + '/definition'
		// 技能块的三个**写入口**（导入 / 新建 / 删除）。判定与落盘全在宿主那侧（`lib/skill-write.js`），
		// 面板只做"取参数、POST、把回执原文摆出来"。
		const SKILLS_IMPORT_ENDPOINT = SKILLS_ENDPOINT + '/import'
		const SKILLS_CREATE_ENDPOINT = SKILLS_ENDPOINT + '/create'
		const SKILLS_REMOVE_ENDPOINT = SKILLS_ENDPOINT + '/remove'
		/**
		 * 输入框润色（design-polish-001）：**POST**，body `{ session, text }`。
		 * 与 host half 的 `POLISH_PATH` 逐字对齐（`/company-board/api/polish`）；
		 * 200 回 `{ ok:true, polished, language, scenario, changes, confidence, checks, route, elapsedMs, cached }`，
		 * 非 200 回 `{ ok:false, error, reason? }`（400/409/429/502/504）。
		 */
		const POLISH_ENDPOINT = API_PREFIX + '/polish'
		/**
		 * 哪几类来源**可写**（键 = 宿主给的 `source`，值 = 写入口的 `root`）。
		 *
		 * 只认这两类：`user-dsh`（`~/.dsh/skills`）与 `project-dsh`（`<工作区>/.dsh/skills`）。
		 * `bundled`（随安装发布）与 `user-agents` / `project-agents`（别的 agent 的根）**只读** ——
		 * 面板对它们不画写动作，写入口那侧也会拒（两处同一口径）。
		 */
		const WRITABLE_SKILL_SOURCES = { 'user-dsh': 'user', 'project-dsh': 'project' }
		// 导入的两条上限，与宿主 `lib/skill-write.js` 里那两条**同一套**（面板先自检，别让人看到网络错误）：
		// 文件总数 500、内容总量 4 MB（base64 上传会膨胀约三分之一，宿主那条请求体上限是 8 MB）。
		const SKILL_IMPORT_MAX_FILES = 500
		const SKILL_IMPORT_MAX_BYTES = 4 * 1024 * 1024
		/**
		 * 视图栏那几个读端点共用的查询串：`workspace`（**哪个工作区**）与 `session`（**哪个会话**）。
		 *
		 * `session` 不是可选的装饰：
		 *   · 成员那一块要靠它拿**本会话的 agent 名册**（`ctx.agentTeams.listMembers` 要一个活着的队内
		 *     agent 当凭据，而"这个会话的 Lead"只能按会话 id 取）；
		 *   · 技能那一块要靠它读**会话那一层**的目录（不带就只能读全局层，那不是模型看到的那份）。
		 * 缺哪个就不带哪个 —— 宿主那边会把"没带"说成"读不到"，而不是猜一个。
		 */
		/**
		 * 面板几个读端点的**短 TTL 缓存**。
		 *
		 * 为什么需要：端点本身只要 1–4 ms（现场量过），但组件是**按会话 / 按块重挂**的 ⇒
		 * 每次重挂都重新发一遍请求，人就得等一个来回（切会话时还得先等会话 id 落定）。这一层做到两件事：
		 *   · 同一个 key 在 TTL 内只发一次 ⇒ **切块几乎瞬间出内容**；
		 *   · 配合下面的 `prefetchPanes()`（切会话时并行预取四个端点）⇒ 切过去那一刻就已经在拉了。
		 * 写动作（加成员 / 删角色 / 导入技能…）与刷新 tick 之后**必须失效**（见 `invalidatePanes()`），
		 * 否则人点完看到的还是旧的。
		 */
		// ── ③ 取数缓存与 URL ───────────────────────────────────────────────
		const PANE_TTL_MS = 3000
		/** 缓存里最多留几份载荷：切会话会不断生成新 key，不设上限就常驻整份面板数据。 */
		const PANE_CACHE_MAX = 32
		const paneCache = new Map()
		/** 让缓存失效（写动作之后、刷新 tick 时调）。 */
		const invalidatePanes = () => paneCache.clear()
		/** 写入时顺手清掉过期的，再按插入顺序把最老的挤出去；不额外起定时器。 */
		const prunePaneCache = () => {
			const now = Date.now()
			for (const [key, value] of paneCache) {
				if (now - value.at >= PANE_TTL_MS) paneCache.delete(key)
			}
			while (paneCache.size > PANE_CACHE_MAX) paneCache.delete(paneCache.keys().next().value)
		}
		/**
		 * 取一个读端点的 JSON：命中未过期的缓存就直接给，否则真发一次并记下来。
		 * 返回的形状与 `fetch` 一样（调用方要用 `response.status`），失败照常 reject（调用方自己兜）。
		 */
		const getJsonCached = (url, { force = false, headers } = {}) => {
			const hit = paneCache.get(url)
			if (force !== true && hit !== undefined && Date.now() - hit.at < PANE_TTL_MS) {
				return Promise.resolve({ ok: hit.status < 400, status: hit.status, fromCache: true, json: async () => hit.payload })
			}
			return fetch(url, { headers: headers === undefined ? { accept: 'application/json' } : headers, credentials: 'same-origin' }).then((response) =>
				response.json().then(
					(payload) => {
						paneCache.set(url, { at: Date.now(), status: response.status, payload })
						prunePaneCache()
						// 返回合成的 response（原 response 的 body 已被消费，再读会抛）；合成对象只实现 `status` 与 `json()`。
						return { ok: response.status < 400, status: response.status, fromCache: false, json: async () => payload }
					},
					() => response,
				),
			)
		}

		const paneQueryOf = (workspace, sessionId) => {
			const parts = []
			if (workspace !== '') parts.push('workspace=' + encodeURIComponent(workspace))
			if (sessionId !== '') parts.push('session=' + encodeURIComponent(sessionId))
			return parts.length === 0 ? '' : '?' + parts.join('&')
		}
		const membersUrlOf = (workspace, sessionId) => MEMBERS_ENDPOINT + paneQueryOf(workspace, sessionId)
		const teamTasksUrlOf = (workspace, sessionId) => TEAM_TASKS_ENDPOINT + paneQueryOf(workspace, sessionId)
		const collabUrlOf = (workspace, sessionId) => COLLAB_ENDPOINT + paneQueryOf(workspace, sessionId)
		const skillsUrlOf = (workspace, sessionId) => SKILLS_ENDPOINT + paneQueryOf(workspace, sessionId)
		/**
		 * 「技能」块里那张清单的"是哪一版"标记（形态/观感换了就换这串字）。
		 * 只放 data 属性、不挂 title，核对时在 DOM 里看 `data-skills-mark` 即可。
		 */
		const SKILLS_MARK = 'f30-技能栏：清单（层级标签 项目级·用户级·包内 + 提供者标签）+ 查看正文·复制正文·复制路径；卡片不印来源行与路径'

			// ── 状态文件（看板那份）在界面上的固定约定 ──────────────────────────────────
			// 状态落在同几个字段上 ⇒ 取数 / 筛选 / 分栏走同一套；差异只在取值顺序、中文名、次要筛选字段、卡片长相。

		// ── ④ 界面规格与配色 ─────────────────────────────────────────────────
		const BOARD_TONE = {
			待办: 'neutral',
			进行中: 'brand',
			待验收: 'warn',
			已完成: 'success',
			已打回: 'error',
		}

		const SPECS = [
			{
				ledger: 'board',
				label: '任务看板',
				panelId: 'cbv-panel-board',
				endpoint: API_PREFIX,
				// 五档顺序的唯一正文在 `lib/board-status.js`（客户端单文件模块引不到，这一份是抄写，由自检钉住逐字一致）：
				// 待办 → 进行中 → 待验收 → 已完成 → 已打回。
				statusOrder: ['待办', '进行中', '待验收', '已完成', '已打回'],
				statusLabel: (status) => status,
				tone: (status) => BOARD_TONE[status] || 'neutral',
				facetField: 'priority',
				facetAll: '优先级：全部',
				searchHint: '搜索编号 / 一句话 / owner / 产物',
			},
		]

		// ── 面板的块表：成员 / 角色 / 技能 / 任务看板（块序 = 这里的顺序）────────────────
		// 块序是人的指令：成员最前（默认落成员块）→ 角色（从成员块拆出）→ 技能 → 看板。
		// 「成员」「角色」「技能」三块不是视图（spec 为 null）：成员=在场的人、角色=现场角色目录、技能=宿主技能目录。
		// `panelId`：块切换那一排 tab 的 `aria-controls` 要指向对应面板的 id（设计 ⑩ `BLOCKS` 一项）。
		const MEMBERS_BLOCK = { ledger: 'members', label: '成员', spec: null, panelId: 'cbv-panel-members' }
		const ROLES_BLOCK = { ledger: 'roles', label: '角色', spec: null, panelId: 'cbv-panel-roles' }
		const SKILLS_BLOCK = { ledger: 'skills', label: '技能', spec: null, panelId: 'cbv-panel-skills' }
		const BLOCKS = [MEMBERS_BLOCK, ROLES_BLOCK, SKILLS_BLOCK].concat(SPECS.map((spec) => ({ ledger: spec.ledger, label: spec.label, spec, panelId: spec.panelId })))

		/**
		 * 复制一段文本到剪贴板：`navigator.clipboard` 优先，取不到就退回复查（临时 textarea + `execCommand`）。
		 * 两条都失败时**如实回报失败原因**（不假装复制成功：现场那句含糊话已经被打回过一次）。
		 * @param value - 要复制的文本。
		 * @returns `{ ok: true }` 或 `{ ok: false, reason }`。
		 */
		async function copyText(value) {
			const text = typeof value === 'string' ? value : String(value ?? '')
			try {
				if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
					await navigator.clipboard.writeText(text)
					return { ok: true }
				}
			} catch {
				/* 落到兜底那条 */
			}
			try {
				const area = document.createElement('textarea')
				area.value = text
				area.setAttribute('readonly', 'readonly')
				area.style.position = 'fixed'
				area.style.opacity = '0'
				document.body.appendChild(area)
				area.select()
				const copied = document.execCommand !== undefined && document.execCommand('copy')
				document.body.removeChild(area)
				return copied ? { ok: true } : { ok: false, reason: '这个环境不允许剪贴板写入（可以手动全选文本复制）' }
			} catch (error) {
				return { ok: false, reason: String(error) }
			}
		}

		/**
		 * 客户端**只做形状预检**（设计 4.2.1 / 4.3.2）：角色 id 与技能名都要求小写 kebab-case。
		 *
		 * 这只是"别让人点了才收到服务端拒绝"的前置检查；**合法性的唯一正文仍在服务端**
		 * （`lib/roster.js` 的 `roleIdFindings` / `lib/skill-write.js`），面板不据此下最终结论。
		 * @param value - 待检查的 id。
		 * @returns 形状是否可能是合法的。
		 */
		const idShapeOk = (value) => /^[a-z][a-z0-9-]*$/.test(text(value).trim())

		const TONE_VAR = {
			neutral: 'var(--dsw-alias-label-tertiary)',
			// 圆点那几档：**只给深浅**，不给色相（`a5` 最实 = "这条已经到位"，`a2` 最淡）。
			brand: 'var(--cbv-a4)',
			warn: 'var(--cbv-a3)',
			success: 'var(--cbv-a5)',
			error: 'var(--cbv-a2)',
		}

		// ── ⑤ 样式表 ─────────────────────────────────────────────────────
		const CSS = [
			// 面板要填满可用区：定高由 `usePaneHeight` 量出来（行内 height），`100vh − 210px` 只是量不到时的兜底。
			// 面板自身永不出滚动条（`overflow:hidden`）；内容超长时滚的是列内清单，不是整块面板。
			'.cbv-root{--cbv-font-xs:11px;--cbv-font-sm:12px;--cbv-font-md:13px;--cbv-font-base:14px;--cbv-font-lg:15px;--cbv-leading-tight:1.35;--cbv-leading-normal:1.5;--cbv-weight-regular:400;--cbv-weight-strong:600;--cbv-font-mono:var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);--cbv-space-2xs:2px;--cbv-space-xs:4px;--cbv-space-sm:6px;--cbv-space-md:8px;--cbv-space-lg:10px;--cbv-space-xl:12px;--cbv-space-2xl:16px;--cbv-space-3xl:24px;--cbv-radius-sm:5px;--cbv-radius-md:6px;--cbv-radius-lg:8px;--cbv-radius-xl:10px;--cbv-radius-2xl:12px;--cbv-radius-pill:999px;--cbv-control-xs:24px;--cbv-control-sm:26px;--cbv-control-md:28px;--cbv-control-lg:32px;--cbv-touch-target:44px;--cbv-touch-target-lg:48px;--cbv-disabled-opacity:.5;--cbv-dur-fast:120ms;--cbv-dur-base:140ms;--cbv-dur-slow:200ms;--cbv-ease:ease-out;--cbv-z-overlay:60;--cbv-z-picker:80;--cbv-breakpoint-sm:480px;--cbv-breakpoint-xs:420px;--cbv-overlay-inset:8px;--cbv-modal-inset:16px;--cbv-board-col-min:220px;--cbv-grid-min:min(250px,100%);--cbv-picker-max-h:min(50vh,360px);--cbv-skeleton-delay:120ms;--cbv-skeleton-intrinsic:120px;--cbv-a1:color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);--cbv-a2:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);--cbv-a3:color-mix(in srgb, var(--dsw-alias-label-primary) 15%, transparent);--cbv-a4:color-mix(in srgb, var(--dsw-alias-label-primary) 21%, transparent);--cbv-a5:color-mix(in srgb, var(--dsw-alias-label-primary) 28%, transparent);--cbv-warn-ink:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 50%, var(--dsw-alias-label-primary));--cbv-ok-ink:color-mix(in srgb, var(--dsw-alias-state-success-primary) 50%, var(--dsw-alias-label-primary));--cbv-bad-ink:color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, var(--dsw-alias-label-primary));display:flex;flex-direction:column;gap:10px;width:100%;height:calc(100vh - 210px);min-height:160px;overflow:hidden;box-sizing:border-box;padding:4px 2px 0;color:var(--dsw-alias-label-primary);font-size:15px}',
			// 内嵌那一份不自己撑视口高（否则上面还有控件行与搜索行，列底永远顶不到面板底）；
			// 同权重后写者胜 ⇒ 必须排在 `.cbv-root` 之后。
			'.cbv-root--embed{height:auto;flex:1 1 auto;min-height:0}',
			// 告警那一句：**不加色相**，靠**加粗 + 词面**（"读不到"/"打回"）把意思说清。
			'.cbv-note{color:var(--dsw-alias-label-primary);font-weight:600;font-size:13px}',
			'.cbv-spacer{flex:1 1 auto}',
			'.cbv-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			// 键盘用户必须看得见焦点落在哪；DSH 自己的组件也是这套 focus-visible 写法。
			'.cbv-btn:focus-visible,.cbv-note:focus-visible,.cbv-card:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}',
			// 输入框的聚焦环**照本体的输入语言**（主题那个强调色）：面板里所有输入框一处判断，
			// 与选择框里那个搜索框同一长相。这是本面板唯一一处破"不上色相"的地方 —— 理由是它属于
			// **本体的输入语言**（现场那张图里那道青色环就是它），不是我加的装饰。
			'.cbv-input:focus-visible,.cbv-select:focus-visible,.cbv-mp-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',

			// 输入框 / 下拉与卡片同一套材质（中性透明度 + `border-l2`）：用不透明的 layer 色会在
			// 浅色主题下与背景同值、深色主题下比卡片亮一档，出现"两套材质"。
			'.cbv-input,.cbv-select{background:var(--cbv-a1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:8px;height:26px;padding:0 8px;font-size:14px;font-family:inherit}',
			'.cbv-input:hover,.cbv-select:hover{border-color:var(--dsw-alias-label-tertiary)}',
			'.cbv-input{min-width:0;flex:1 1 180px}',
			// 看板分栏**随面板宽度自适应**（人的指令：分栏要做成响应式的）：
			// `auto-fit + minmax(下限,1fr)` ⇒ 宽面板三栏等分、中等两栏、窄面板一栏，**不再靠横向滚动**
			// （横向滚动把放不下的栏藏起来，窄栏里既看不见也滑不到）。`min(下限,100%)` 保证窄于下限时也不溢出。
			// 行高 `minmax(0,1fr)`：每栏等高并填满看板；换行后每行均分高度，卡片多时在**栏内**各自滚。
			'.cbv-board{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(var(--cbv-board-col-min),100%),1fr));grid-auto-rows:minmax(0,1fr);gap:10px;flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto;padding:0 2px 6px;scrollbar-width:thin;scrollbar-gutter:stable}',
			// 滚动条要看得见：macOS 覆盖式默认不显示 ⇒ 显式给细条（两轴都写，纵向兜底）。
			'.cbv-board::-webkit-scrollbar{width:9px;height:9px}',
			'.cbv-board::-webkit-scrollbar-track{background:var(--cbv-a1);border-radius:999px}',
			'.cbv-board::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:999px}',
			'.cbv-board::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-tertiary)}',
			// 一栏：宽度由网格决定（不再写死）；`min-width:0` 让卡片自己断词换行，`overflow:hidden` 让栏内正文去滚。
			'.cbv-col{display:flex;flex-direction:column;min-width:0;min-height:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}',
			'.cbv-col-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
			'.cbv-col-name{font-weight:600;font-size:14px}',
			'.cbv-col-count{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:13px;font-variant-numeric:tabular-nums}',
			'.cbv-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}',
			// 列内不再各自滚动：滚动条从每列一条收成整块一条，列高由内容决定。
			// 列的正文区：**自己滚**（卡片多过列高时在列内滑，列高不撑破面板）。
			// `flex:1 1 auto` + `min-height:0` 是让它能被压到比内容矮、从而触发滚动的两个必要条件。
			// 两轴都写清楚：只写 `overflow-y:auto` 时按 CSS Overflow 3，x 轴（visible）会被算成 auto
			// ⇒ 任何一行不换行的内容都会在栏里挤出一条横向滚动条。
			'.cbv-col-body{display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-height:0;overflow:hidden auto;padding:8px}',
			// 看板卡与其余几块共用几何（`.cbv-box`），底色用最淡的中性透明度，两种主题下都能从栏里浮出来。
			'.cbv-card{cursor:pointer}',
			// 静止态已经是 border-l2 ⇒ hover 不能只换描边（看不出来），改换底色。
			'.cbv-card:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.cbv-card-top{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
			// 时间那一行：比正文小一档、颜色最轻（它是"什么时候动的"，不是要读的内容）。
			'.cbv-sub--time{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
			'.cbv-id{font-family:var(--dsh-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:13px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
			'.cbv-chip{font-size:12px;line-height:16px;padding:0 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
			// 徽标三档都用中性底，靠深浅 + 描边样式区分（ok 最实、exception 虚线、bad 实线加粗）。
			'.cbv-chip--phase{background:var(--cbv-a2)}',
			// 优先级只给最高两档上色（P0 红 / P1 琥珀），P2/P3 保持中性 —— 满屏强调等于没有强调。
			'.cbv-chip--p0{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);color:var(--cbv-bad-ink);font-weight:600}',
			'.cbv-chip--p1{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);color:var(--cbv-warn-ink)}',
			'.cbv-chip--exception{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);border-style:dashed;color:var(--cbv-warn-ink)}',
			// 只有"可以动手 / 具备条件"这一类才用 `--ok`（团队任务板的「可认领」）：给绿。
			'.cbv-chip--ok{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 42%, transparent);color:var(--cbv-ok-ink)}',
			'.cbv-note--warn{font-weight:600}',
			// 一句"要动作"的告警（"卡在：…"）：用错误色，但**只是字**（不填底）——
			// 卡片里最该被一眼看到的句子就是它。
			'.cbv-note--danger{color:var(--cbv-bad-ink);font-weight:600}',
			'.cbv-desc{font-size:14px;line-height:1.45;word-break:break-word}',
			// 折叠卡的任务描述只露两行；点卡片开的浮窗里印全文（不加这个类）。
			'.cbv-clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
			'.cbv-sub{font-size:13px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
			'.cbv-detail{margin-top:2px;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:5px;display:flex;flex-direction:column;gap:5px}',
			// 明细块不再自带上限与滚动条：它长就让它长，滚动交给外层。
			'.cbv-block{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;background:var(--cbv-a1);border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:6px 7px}',
			'.cbv-label{font-size:12px;color:var(--dsw-alias-label-tertiary);letter-spacing:.04em}',
			'.cbv-msg{padding:12px 2px;color:var(--dsw-alias-label-tertiary);font-size:14px}',
			'.cbv-empty{padding:10px 2px;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center}',
			'.cbv-overlay{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding:6vh 24px 24px;animation:cbv-fade .12s ease-out}',
			'@keyframes cbv-fade{from{opacity:0}to{opacity:1}}',
			'@keyframes cbv-pop{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
			'@media (prefers-reduced-motion:reduce){.cbv-overlay,.cbv-modal{animation:none}.cbv-drop--on,.cbv-btn,.cbv-cardbtn,.cbv-tab,.cbv-flt-chip{transition:none}}',
			// 浮窗与本体菜单同一层材质：底取 `--dsw-specific-menu`（取不到退回 bg-layer-1），
			// 模糊取 `--dsw-menu-backdrop-filter`（取不到给保守 blur）—— 半透明而不糊字。
			'.cbv-modal{background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(1.4));border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.38);width:min(860px,94vw);max-height:86vh;display:flex;flex-direction:column;overflow:hidden;animation:cbv-pop .14s ease-out;outline:none}',
			'.cbv-modal-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}',
			// 浮窗里那句键盘提示：小字、次要色，靠右（`margin-left:auto`）、窄栏时允许换行，不跟按钮抢位置。
			// 这一行**必须是一行**（现场：窄浮窗里被折成两行，"`Esc` 关"掉到下一行）。
			// 于是 `nowrap` + 不再限宽到 52%；标题那一格自己有省略号，窄下来先瘦标题、不动这行提示。
			'.cbv-modal-keys{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin-left:auto;text-align:right;white-space:nowrap}',
			'.cbv-modal-title{flex:1 1 auto;min-width:0;font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			// 顶部锚定（overlay 用 flex-start + 固定 padding-top）：垂直居中会让表头 y 随内容浮动，翻页按钮按不准。
			'.cbv-modal-body{overscroll-behavior:contain}',
			'.cbv-modal-actions{display:flex;align-items:center;gap:8px;flex:none}',
			'.cbv-modal-body{overflow-y:auto;overflow-x:hidden;padding:12px;min-height:0}',
			'.cbv-modal-body .cbv-card{cursor:default}',
			// 文件三栏不是对话：用 `:has()` 在本栏在场时收起那对宽度拖拽条（卸载即恢复，纯 CSS）。
			'[data-conversation-scroll]:has([data-team-ops-pane]) ~ [data-width-handle]{display:none}',
			'.cbv-msg--error{color:var(--dsw-alias-label-primary);font-weight:600}',
			// iOS 那种滑块：一个按钮 + 一个 knob；`aria-checked` 表达状态（键盘与读屏都认）。
			// 成员卡的开关（`.cbv-switch*`）已随成员写面整面撤掉：那一栏现在只读，卡上只留状态词。
			// 职责：**截断在 CSS**（-webkit-line-clamp）—— 不在 JS 里切字符串，于是"复制"拿到的仍是全文。
			'.cbv-btn:disabled{opacity:.5;cursor:default}',
			// 同一类毛病（浮窗里的第二条滚动条）：这块（成员提示词 / 技能正文）**在浮窗主体里**，
			// 主体已经在滚（`.cbv-modal-body{overflow-y:auto}`）⇒ 这里不再自己限高、自己滚。
			// 规矩只有一条：**滚动发生在包含头部的那一层**，里面任何块都不自己滚。
			'.cbv-pre{margin:0;font-family:var(--dsh-font-mono,ui-monospace,Menlo,monospace);font-size:12.5px;white-space:pre-wrap;word-break:break-word}',
			// ── 输入框工具行那一枚「角色」按钮 + 它的选择框（人的指令：按钮放在**输入框**里；
			//     结构照本体那个「专家」选择框：搜索 + 按分类分组 + 头像行；材质全取主题的 token）──
			// 按钮：与本体工具行那枚「+」同形同料（28px 药丸、`--dsw-specific-selector` 的底、圆角 999px）
			'.cbv-rolepick{position:relative;display:inline-flex;align-items:center}',
			// **无底色**（人的指令：「「角色」按钮不要背景色，鼠标移上去显示背景色」）：平时是透明的字，
			// 悬停才浮出那一层交互底 —— 与「工作区内修改」那种"一直有底"的控件区分开。
			'.cbv-composer-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;background:0 0;color:var(--dsw-alias-label-primary);border:none;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit;line-height:1;white-space:nowrap}',
			'.cbv-composer-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--cbv-a2))}',
			// 按钮上的图标：与头像用同一套描边几何（`currentColor`，14px）。
			'.cbv-composer-btn .cbv-mp-avatar-svg{width:14px;height:14px;flex:none}',
			'.cbv-composer-btn:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:1px}',
			'.cbv-composer-btn:disabled{opacity:.4;cursor:default}',
			// 选择框：浮在输入框**上方**（fixed 定位 + 打开时按按钮位置算，免得被任何祖先的 overflow 裁掉），
			// 底与模糊用本体菜单那一层材质（与浮窗同一套）。
			// **这层必须 portal 到 `document.body`**（渲染处见 `RoleComposerEntry` 的 `portalOf(...)`）：
			// 输入框那一片在已激活会话下带 `will-change: transform`（宿主的 `.composerSeat`），
			// 会给 fixed 后代造包含块 ⇒ 不 portal 就会"跟着输入框走"，与按钮错位。
			'.cbv-rolepick-pop{position:fixed;z-index:80;width:min(300px,70vw);max-height:min(46vh,360px);overflow-y:auto;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(1.4));border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.32);padding:6px}',
			// 选择框里那个搜索框**照本体的搜索框**：透明底、`.5px` 透明描边、聚焦时描边走主题自己的
			// `--dsw-alias-state-business-primary`（现场那张图里那道青色环就是它 —— 这是**本体的输入语言**，
			// 不是我们加的装饰；本面板只在这一处破例，别再往别处搬）。
			'.cbv-rolepick-head{position:sticky;top:0;z-index:1;margin:-6px -6px 2px;padding:6px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(1.4));border-radius:12px 12px 0 0}',
			// **吸顶**（人的指令）：列表再长，搜索框也钉在浮层顶部；负外边距把浮层的 6px 内边距也盖住，
			// 免得行从上面那条缝里透出来。高度抬到 32px（原来靠 padding 撑着，偏矮），边框 **2px**。
			'.cbv-rolepick-search{width:100%;height:32px;box-sizing:border-box;background:0 0;border:2px solid transparent;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;padding:0 8px;margin:0;outline:none;font-family:inherit}',
			'.cbv-rolepick-search::placeholder{color:var(--dsw-alias-label-tertiary)}',
			'.cbv-rolepick-search:hover{border-color:var(--dsw-alias-border-l2)}',
			'.cbv-rolepick-search:focus{border-color:var(--dsw-alias-state-business-primary)}',
			// ── 输入框那一枚「角色」按钮的选择框里那些行（搜索 + 按分类分组 + 头像行；与本体那个
			//     「专家」选择框同形）：这些 `cbv-picker-*` 只服务输入框那一席 ──
			// 列表本身只做"选中"，不填色相：选中态用中性实底（与面板其余部分同一套材质）。
			// 列表**摊平**（本体那个选择框就是不分内层盒子的）：不描边、不铺底，直接排在浮层上。
			// **只留一条滚动条**（人的现场）：滚动容器是**外层浮层** `.cbv-rolepick-pop`，这一层
			// **不**再自己滚 —— 那会变成"浮层一根 + 列表一根"两条，而且吸顶的搜索框会跟着内层滚走。
			// 搜索框要吸顶，滚动就必须发生在**包含它的那一层**（sticky 相对最近的滚动祖先）。
			'.cbv-picker{margin-top:2px}',
			'.cbv-picker-group{margin-top:2px}',
			// 组标题的参数照本体（`groupTitle`：11px / padding 6px 8px / 次要色）。
			'.cbv-picker-head{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);padding:4px 6px}',
			'.cbv-picker-row{display:flex;align-items:center;gap:7px;padding:4px 6px;border-radius:6px;cursor:pointer}',
			'.cbv-picker-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.cbv-picker-row--on{background:var(--cbv-a4)}',
			'.cbv-picker-row:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}',
			// 行里的头像：**圆形**、比成员卡小一号（照本体那个选择框；成员卡那边仍是圆角方 —— 两个场景两种形态）。
			'.cbv-picker-row .cbv-mp-avatar{width:26px;height:26px;border-radius:50%}',
			'.cbv-picker-row .cbv-mp-avatar-svg{width:15px;height:15px}',
			'.cbv-picker-text{display:flex;flex-direction:column;gap:1px;min-width:0}',
			'.cbv-picker-name{font-size:13px;color:var(--dsw-alias-label-primary)}',

			// 一个动作 + 一句注解 + 结果回执的那一行（团队的"启用服务"按钮用它；模块化成一个可复用的行）。
			'.cbv-acts{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none}',
			// 拖拽区：虚线框 + 居中三行 + 两个文字按钮；边框用主题的输入强调色（面板唯一允许的非标签色相）。
			'.cbv-drop{border:1.5px dashed var(--dsw-alias-state-business-primary);border-radius:8px;background:var(--cbv-a1);padding:24px 16px;text-align:center;display:flex;flex-direction:column;justify-content:center;min-height:176px;box-sizing:border-box}',
			'.cbv-drop--on{transition:border-color .12s ease-out}',
			'.cbv-drop--on:hover{background:var(--cbv-a2)}',
			'.cbv-drop-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.cbv-drop-note{margin-top:4px;font-size:13px;color:var(--dsw-alias-label-tertiary)}',
			'.cbv-drop-acts{margin-top:6px;font-size:13px}',
			'.cbv-drop-link{background:0 0;border:0;padding:0 2px;font:inherit;color:var(--dsw-alias-label-primary);text-decoration:underline;cursor:pointer}',
			'.cbv-drop-link:hover{color:var(--dsw-alias-label-primary)}',
			'.cbv-drop-sep{color:var(--dsw-alias-label-tertiary)}',
			// 区里那三条"文件要求"：左对齐的小字（贴着拖拽区下缘，读的人先看区里的内容再看它）。
			'.cbv-drop-req{margin:12px auto 0;max-width:340px;text-align:left;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary)}',
			'.cbv-notice{margin-top:8px;border-radius:8px;padding:6px 8px;font-size:13px;border:1px solid var(--dsw-alias-border-l2);background:var(--cbv-a1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
			'.cbv-notice--ok{border-color:var(--dsw-alias-border-l2);background:var(--cbv-a1)}',
			'.cbv-notice--error{border-color:var(--dsw-alias-border-l2);background:var(--cbv-a2);font-weight:600}',
			// 按钮只有这一条基样式（原来两条同名规则，靠数组顺序定胜负）：外观 + 尺寸 + 光标都在这。
			'.cbv-btn{appearance:none;flex:none;font-family:inherit;font-size:13px;line-height:22px;padding:0 10px;border-radius:5px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary)}',
			// 按钮三档：都不给色相 —— primary 实一点、bad 描边加粗（"这是要动手的那个"靠层次说）。
			'.cbv-btn--primary{border-color:transparent;background:var(--cbv-a4);color:var(--dsw-alias-label-primary);font-weight:600}',
			'.cbv-btn--bad{border-color:var(--dsw-alias-border-l2);background:var(--cbv-a1);font-weight:600}',
			'.cbv-btn[disabled]{opacity:.5;cursor:default}',
			// 「贴了底的框」那一版**改名**（原来也叫 `.cbv-note`，把上面那条文字样式整个盖掉了）：
			'.cbv-note--box{min-width:120px;padding:3px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:var(--cbv-a1)}',
			// 文件文本的 Markdown 渲染：容器关掉 pre-wrap（换行由块结构表达），块与行内元素各给最小样式。
			'.cbv-md{white-space:normal}',
			'.cbv-md>:first-child{margin-top:0}',
			'.cbv-md>:last-child{margin-bottom:0}',
			'.cbv-md-p{margin:0 0 5px}',
			'.cbv-md-h{margin:6px 0 4px;line-height:1.35;font-size:14px}',
			'.cbv-md-list{margin:0 0 5px;padding-left:18px}',
			'.cbv-md-list li{margin:1px 0}',
			'.cbv-md-quote{margin:0 0 5px;padding:1px 0 1px 8px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}',
			// 代码块换行而不是横向滚（长行一滚就是一条横向滑动栏）。
			'.cbv-md-table-wrap{margin:0 0 5px;overflow-x:auto}',
			'.cbv-md-table{border-collapse:collapse;font-size:13px;line-height:1.4}',
			'.cbv-md-table th,.cbv-md-table td{border:1px solid var(--dsw-alias-border-l2);padding:3px 7px;text-align:left;vertical-align:top}',
			'.cbv-md-table th{background:var(--cbv-a1);font-weight:600}',
			'.cbv-md-cell--right{text-align:right}',
			'.cbv-md-cell--center{text-align:center}',
			'.cbv-md-pre{margin:0 0 5px;padding:5px 7px;background:var(--cbv-a1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;white-space:pre-wrap;word-break:break-word}',
			'.cbv-md-pre code{background:transparent;border:0;padding:0}',
			'.cbv-md-hr{border:0;border-top:1px solid var(--dsw-alias-border-l2);margin:6px 0}',
			'.cbv-md a{color:var(--dsw-alias-label-primary);text-decoration:underline;word-break:break-all}',
			'.cbv-md code{font-family:var(--dsh-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:13px;background:var(--cbv-a2);border:1px solid var(--dsw-alias-border-l2);border-radius:3px;padding:0 3px}',
			// 这几个位置只做**行内**渲染（`inlineNodes`），外层不挂 `.cbv-md`（挂了会改掉它们的 white-space），
			// 所以行内代码/粗体的样式在这里单独给一份 —— 与 `.cbv-md code` 同一套观感。
			'.cbv-modal-keys code,.cbv-mp-field-label code,.cbv-flt-bar code{font-family:var(--dsh-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;background:var(--cbv-a2);border:1px solid var(--dsw-alias-border-l2);border-radius:3px;padding:0 3px}',
			'.cbv-act-err{font-size:13px;color:var(--dsw-alias-label-primary);font-weight:600;flex-basis:100%}',
			// ── 「成员」块（卡片网格）────────────────────────────────────────────────
			// 面板是**窄栏**（宽度由壳的拖拽条决定、与视口无关）⇒ 列数交给 `auto-fill` 自己算，
			// 不写 `@media`、也不量宽：窄了自动落一列，卡片自己断词换行，永不出横向滚动条。

			// 住在视图栏里那一块：撑满剩余高度、清单自己滚（面板定高由量高那一套给，不在这里再猜一个高度）。
			// 一个块里有"顶部一行 + 一份可伸缩的视图"时用这一层（任务看板那两个来源就是这种）：
			// 它自己撑满并让里面的视图去滚（`.cbv-root--embed` / `.cbv-board` 都带 `flex:1 1 auto;min-height:0`）。
			// ── 四块共用的一套「块骨架」──────────────────────────────────────────────
			//   `.cbv-view` = 块根（竖排、撑满、可伸缩）；`.cbv-view-head` = 块头那一行（内页标题已撤）；
			//   `.cbv-scroll` = 唯一滚动区；`.cbv-box` = 卡片共用几何（底色各块自己给）。
			'.cbv-view{display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0;color:var(--dsw-alias-label-primary);font-size:14px}',
			'.cbv-view-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;flex:none}',
			// 四块共用卡片几何：描边用 `border-l2`（`border-l1` 在浅色主题下只有 1.09:1，卡片等于没画）；
			// 底色也在这条里（`--cbv-a1`），避免"看板卡改过来了、另外两块没改"。
			'.cbv-box{display:flex;flex-direction:column;gap:6px;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--cbv-a1)}',
			// 唯一滚动区：卡区 / 列表在它里面滚（滚动区一多，后半截会被挤出可视区）。
			'.cbv-scroll{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;padding-right:2px}',
			// 状态标签：底只分档，词面照引擎取值；强调色只用主题三个状态 token 的 16%~18% 淡染。
			'.cbv-chip--st-todo{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
			// 五档状态标签不用色相：底深浅 + 描边样式 + 字重 + 删除线区分；
			// 待办=描边、进行中=淡底、待验收=淡底+虚线、已完成=实底+加粗、已打回=描边+加粗+划线。
			'.cbv-chip--st-doing{background:var(--cbv-a4);color:var(--dsw-alias-label-primary);font-weight:600}',
			// 待验收：**琥珀**（"要人看一眼"）
			'.cbv-chip--st-verify{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);color:var(--cbv-warn-ink)}',
			// 已完成：**绿**
			'.cbv-chip--st-done{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent);color:var(--cbv-ok-ink);font-weight:600}',
			// 已打回：**红** + 划掉
			'.cbv-chip--st-rejected{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);color:var(--cbv-bad-ink);font-weight:600;text-decoration:line-through}',
			// 栏头下面那一句（出口准则 / 清单登记状态）：小字、不占满、最多两行。
			'.cbv-col-note{font-size:12px;line-height:1.45;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
			// 「角色」块里那一段（来源筛选 + 角色卡 + 角色包入口；整块自己滚）。
			'.cbv-roster{display:flex;flex-direction:column;gap:8px;flex:0 0 auto}',

			'.cbv-roster-card{padding-bottom:0}',
			// 清单里的名字那一列：与成员卡同款（`.cbv-mp-nameblock`），只是里面装的是 id + 两枚 chip。
			'.cbv-roster-card .cbv-id{font-size:13px}',
			// 网格是**栏内滚动的那一层**：`min-height:0` 才压得住内容高，压得住才会滚。
			// （滚动区那一条见上面的 `.cbv-scroll`：四块共用 —— 卡区自己带 `overflow` 会把后面那节
			// 挤出可视区，那是现场打回过的一条，所以现在只有"块里一个滚动区"这一种写法。）
			'.cbv-scroll .cbv-mp-grid{flex:0 0 auto}',

			// 引擎那一轮自己的告警（看板读不到、编号查不到…）：原文透出，**只读**，不换措辞。
			'.cbv-pane-warn{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);font-weight:600;overflow-wrap:anywhere;min-width:100%}',
			// **状态行一律占满整行**（`min-width:100%`）：它们与块标题是同级的读数列 —— 父级是列时本来就各占一行（当前如此）；
			// 父级若变成 flex 行，这一条保证它们**不会并到标题那一行**。
			// **不用 `flex-basis:100%`**：在列方向那等于"占满高度"，会把整块撑出一大片空白（现场已踩）。
			'.cbv-pane-note{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;min-width:100%}',
			// **定高一行**：原来高度由内容撑（`padding:8px 0` + 换行），而两档的内容不一样
			// （团队那一档只有 chip，里程碑那一档多一个下拉 + 一个搜索框）⇒ 切换时整行高度变几个像素，
			// chip 看起来"上下浮动"（现场原话）。现在行高固定、子项居中，栏里放不下就这一行自己横向滚。
			// `flex:none` 是必须的：它在 `.cbv-view` 那条 flex 列里，`height` 不是硬下限 —— 面板一矮就会被
			// 下面 `flex:1 1 auto` 的看板挤成 1–2px（现场：团队那一档只看得到 chip 底部一两个像素）。
			'.cbv-flt-bar{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;flex:none;height:34px;padding:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;border-top:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2)}',
			// 分档 chip：`aria-pressed` 表达选中（键盘与读屏都认），选中态同时改边色。
			'.cbv-flt-chip{appearance:none;flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;height:24px;padding:0 10px;font-size:12px;line-height:22px;font-family:inherit;cursor:pointer;white-space:nowrap}',
			'.cbv-flt-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.cbv-flt-chip--on{border-color:transparent;background:var(--cbv-a3);color:var(--dsw-alias-label-primary);font-weight:600}',
			'.cbv-flt-chip:disabled{opacity:.5;cursor:default}',
			'.cbv-flt-search{min-width:60px;flex:1 1 180px}',
			'.cbv-flt-select{flex:0 0 auto;max-width:190px}',
			// 两列的算术：设置面板固定 800px − 左侧导航 188px − 内容区左右各 24px = 564px，
			// 于是 `minmax(250px,1fr)` 恰好落两列（2×250 + 10 的缝 = 510 ≤ 564）；再宽才可能三列。
			// 卡区：成员 / 技能 / 角色 / 另一处清单共用同一套网格（同一断点、同一间距）。
			// 下限写 `min(250px,100%)`：面板宽度是拖拽条给的、与视口无关，`@media` 兜不住窄栏 ——
			// 轨道有 250px 硬下限时，栏一拖窄就横向溢出。
			'.cbv-mp-grid,.cbv-sk-grid,.cbv-roster-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(250px,100%),1fr));gap:10px;align-content:start}',
			// **卡内不许裁任何一行**（现场：底排那三个按钮被卡边裁掉半截）：所以卡片**不设** `overflow:hidden`，
			// 靠"卡是 flex 列 + 动作条 `margin-top:auto`"把动作条钉在卡底，圆角由动作条自己那一条兜住。
			// 成员卡：底色 `layer-1`（贴在面板底上）+ 底下留 0（动作条自己贴到卡底）；几何在 `.cbv-box` 里。
			'.cbv-mp-card{padding-bottom:0}',
			// 停用卡**不压整卡透明度**（那会把名字/职责/按钮一起压到 2.53:1）：底淡一格、动作条压一点。
			'.cbv-mp-card--off{background:var(--cbv-a1)}',
			'.cbv-mp-card--off .cbv-cardbar{opacity:.7}',
			'.cbv-mp-top{display:flex;align-items:flex-start;gap:9px}',
			'.cbv-mp-avatar{flex:0 0 auto;width:44px;height:44px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:24px;line-height:1;background:var(--cbv-a2);border:1px solid var(--dsw-alias-border-l2)}',
			// 头像底色按**色调档**（引擎给的 `avatarTone`，六档；自定义角色也落在其中一档）：
			// 一层中性透明度的色块，图标本身**只描边、不上色**（`currentColor`，颜色由主题给）。
			// 图标是 18px 的描边 SVG（`.cbv-mp-avatar-svg`），字面量兜底（`.cbv-mp-avatar-text`）才用字号。
			'.cbv-mp-avatar-svg{display:block;overflow:visible}',
			'.cbv-mp-avatar-text{font-size:20px;line-height:1}',
			'.cbv-mp-avatar--eng{background:var(--cbv-a3)}',
			'.cbv-mp-avatar--design{background:var(--cbv-a2)}',
			'.cbv-mp-avatar--data{background:var(--cbv-a4)}',
			'.cbv-mp-avatar--biz{background:var(--cbv-a1)}',
			'.cbv-mp-avatar--ops{background:var(--cbv-a5)}',
			'.cbv-mp-avatar--exec{background:var(--cbv-a3)}',
			'.cbv-mp-nameblock{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
			'.cbv-mp-name{font-size:15px;font-weight:600;overflow-wrap:anywhere}',
			'.cbv-mp-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
			'.cbv-mp-state{font-size:12px;color:var(--dsw-alias-label-tertiary);align-self:flex-start;margin-top:2px;flex:0 0 auto}',
			'.cbv-badges{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center}',
			// 筛选行里的那一簇 chip（来源分档就是它）：**不许被压缩**（窄面板时被挤成 0 宽 = "看不到"），也不许内部折行。
			'.cbv-flt-bar > .cbv-badges{flex:0 0 auto;flex-wrap:nowrap}',
			'.cbv-badge{font-size:11px;line-height:17px;padding:0 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
			'.cbv-badge--present{background:var(--cbv-a2)}',
			'.cbv-badge--archived{border-color:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-label-tertiary)}',
			'.cbv-badge--retired{border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-secondary)}',
			'.cbv-badge--warn{background:var(--cbv-a1);font-weight:600}',
			// 职责：**截断在 CSS**（`-webkit-line-clamp`）—— 不在 JS 里切字符串，于是"复制"拿到的仍是全文。
			'.cbv-mp-duty{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
			'.cbv-mp-row{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
			'.cbv-mp-key{color:var(--dsw-alias-label-secondary)}',
			// 底排动作：与角色卡同一套"平分一条通栏"的形态（卡内不再放浮起的主按钮）。
			// `margin-top:auto`：同一行里各卡内容长短不齐时，动作条一律落在**卡底**（不会被内容顶出卡外）。
			// 底部圆角与 `overflow:hidden` 从卡片挪到这一条上 —— 卡片已经不裁了，扣角的活由它自己干。
			'.cbv-cardbar{display:flex;margin:auto -12px 0;border-top:1px solid var(--dsw-alias-border-l2);border-radius:0 0 10px 10px;overflow:hidden}',
			'.cbv-cardbtn{flex:1 1 0;appearance:none;border:0;border-right:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;font-family:inherit;padding:7px 4px;cursor:pointer;white-space:nowrap}',
			'.cbv-cardbtn:last-child{border-right:0}',
			'.cbv-cardbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.cbv-cardbtn:disabled{opacity:.5;cursor:default}',
			'.cbv-cardbtn:focus-visible,.cbv-flt-chip:focus-visible,.cbv-mp-textarea:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}',
			'.cbv-pane-empty{padding:14px 2px;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}',
			'.cbv-pane-meta{font-size:12px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;min-width:100%}',
			// 对话框里的字段（复用 `.cbv-overlay` / `.cbv-modal` 外壳，只补表单那几行）。
			'.cbv-modal--members{max-width:min(760px,94vw)}',
			'.cbv-mp-field{display:flex;flex-direction:column;gap:3px;margin-top:8px}',
			// 浮窗里的输入框：`.cbv-input` 那条 `flex:1 1 180px` 是给**行内**排布写的 —— 在这里的
			// 列排布里它会变成"高度 180px 起"，所以就地收回成不伸缩、占满一行。
			'.cbv-mp-field .cbv-input,.cbv-mp-field .cbv-mp-textarea{flex:0 0 auto;width:100%;box-sizing:border-box}',
			'.cbv-mp-field-label{font-size:12px;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}',
			// 字段下面那一行说明（`.cbv-mp-field-note`）：**一类**，弹窗里所有说明都走它。
			'.cbv-mp-field-note{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
			'.cbv-mp-field-note+.cbv-mp-field{margin-top:10px}',
			'.cbv-mp-field-empty{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary);border:1px dashed var(--dsw-alias-border-l2);border-radius:5px;padding:6px 7px;overflow-wrap:anywhere}',
			// 多行文本框只此一条（角色 / 成员弹窗共用）：圆角描边底与 `.cbv-input` 一致，高度由 `rows` 决定；
			// 千万不要挂 `.cbv-input`（`height:26px` 会把 rows=5 的正文压成一行）。
			'.cbv-mp-textarea{width:100%;box-sizing:border-box;background:var(--cbv-a1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 8px;font-size:13px;line-height:1.5;font-family:inherit;resize:vertical;min-height:40px}',
			// 成员编辑弹窗撤下之后，`.cbv-mp-check`（那一对复选框）没有使用者了 ⇒ 规则一并删掉。
			// 极窄视口兜底：列数本来由 `auto-fill` 自己算（面板宽度由壳给），这一条只是不让卡片挤成窄条。
			'@media (max-width:420px){.cbv-mp-grid,.cbv-sk-grid{grid-template-columns:1fr}}',

			// ── 「技能」块（清单卡片；与成员块共用过滤条 / 徽标 / 底排按钮那几套）────────────────
			// 这一块是**只读**的：看清单 → 看正文 → 复制。增删启停不在这一栏（那件事有它自己的
			// 管理面，本插件不造第二份真相：`ctx.skills` 是只读目录，写技能文件是别人家的地盘）。


			// 同成员卡：**不裁内容**（卡边永远不能切掉一整行），动作条钉在卡底。
			'.cbv-sk-card{padding-bottom:0}',
			'.cbv-sk-name{font-size:15px;font-weight:600;overflow-wrap:anywhere}',
			// 描述与"什么时候用它"是**两句不同的话**，各占一行、不糊成一段。
			'.cbv-sk-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
			'.cbv-sk-when{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
			'.cbv-modal--skills{max-width:min(860px,94vw)}',
			// **窄弹窗**（宽度只有这一处正文，几个短弹窗共用这一个类）：写入口（导入 / 新建技能）与
			// 角色弹窗（添加 / 修改 / 删除）都走它 ⇒ 宽度一致；内容多的两支（查看提示词 / 编辑提示词）
			// 不加这个类，仍走上面的 860px —— 它们要装长文本。
			'.cbv-modal--narrow{width:min(520px,92vw);max-width:min(520px,92vw)}',

			// ── 交互改造（task-4）：块壳 / tab / 回执 / 确认 / 骨架 / 小屏与触摸 ─────────────
			// 一条视觉隐藏：读屏能读到、视觉不占位（加载播报、禁用理由都靠它）。
			'.cbv-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
			// 保活渲染：非当前块用 `hidden` 隐藏（`display:none` 同时让它不可聚焦）。
			'.cbv-block-panel{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}',
			'.cbv-block-panel[hidden]{display:none!important}',
			// 块切换的 tablist：窄栏横向滚、不换行。
			'.cbv-tabs{display:inline-flex;align-items:center;gap:4px;flex-wrap:nowrap;min-width:0;max-width:100%;overflow-x:auto;scrollbar-width:thin}',
			'.cbv-tab{flex:0 0 auto}',
			'.cbv-tab[aria-selected="true"]{font-weight:600}',
			// 块顶回执：成功 / 失败同形不同角色（`role` 与 `data-notice-tone` 见 NoticeBar）。
			'.cbv-notice--slot{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;flex:none;margin-top:0}',
			'.cbv-notice-body{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:2px}',
			'.cbv-notice-btn{align-self:flex-start}',
			// 确认浮窗：标题 + 正文 + 底部动作区（默认焦点在「取消」）。
			'.cbv-modal--confirm{width:min(520px,92vw);max-width:min(520px,92vw)}',
			'.cbv-confirm-title{font-size:15px;font-weight:600;line-height:1.35}',
			'.cbv-confirm-line{margin-top:8px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
			'.cbv-confirm-actions{padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;flex-wrap:wrap}',
			// 骨架：静态灰块（**不做 shimmer**，与 reduced-motion 无冲突），几何尽量贴真实卡。
			'.cbv-skel-block{display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0}',
			'.cbv-skel{pointer-events:none}',
			'.cbv-skel-top{display:flex;align-items:flex-start;gap:9px}',
			'.cbv-skel-avatar{display:block;flex:0 0 auto;width:44px;height:44px;border-radius:10px;background:var(--cbv-a2)}',
			'.cbv-skel-lines{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px}',
			'.cbv-skel-line{display:block;height:10px;border-radius:var(--cbv-radius-sm);background:var(--cbv-a2)}',
			'.cbv-skel-line--title{width:45%;height:14px}',
			'.cbv-skel-line--body{width:85%}',
			'.cbv-skel-line--bar{margin-top:6px;width:100%;height:20px;border-radius:var(--cbv-radius-sm)}',
			'.cbv-skel-chip{display:inline-block;flex:0 0 auto;width:64px;height:20px;border-radius:var(--cbv-radius-pill);background:var(--cbv-a2)}',
			'.cbv-skel-chip--wide{width:110px}',
			'.cbv-skel-search{flex:1 1 180px;max-width:240px;height:22px;border-radius:var(--cbv-radius-sm);background:var(--cbv-a2)}',
			'.cbv-picker-skel{display:flex;flex-direction:column;gap:4px;padding:4px 6px}',
			'.cbv-picker-skel-row{display:flex;align-items:center;gap:7px}',
			'.cbv-picker-skel-row .cbv-skel-avatar{width:26px;height:26px;border-radius:50%}',
			'.cbv-picker-skel-row .cbv-skel-line{flex:1 1 auto}',
			'.cbv-picker-insert-error{margin-top:6px;padding:8px;display:flex;flex-direction:column;gap:6px;text-align:left}',
			// 条件不允许（`aria-disabled`）与临时 busy（原生 disabled）在视觉上一致，语义不同。
			'.cbv-cardbtn[aria-disabled="true"]{opacity:var(--cbv-disabled-opacity);cursor:default}',
			'.cbv-btn[aria-disabled="true"]{opacity:var(--cbv-disabled-opacity);cursor:default}',
			// 小屏（视口 ≤ 480px，**不假设面板宽度**）：工具栏换行、浮窗内缩、tab 单行横滚、看板栏宽用令牌。
			'@media (max-width:480px){.cbv-overlay{align-items:stretch;padding:var(--cbv-overlay-inset)}.cbv-modal,.cbv-modal--members,.cbv-modal--skills,.cbv-modal--narrow,.cbv-modal--confirm{width:calc(100vw - var(--cbv-modal-inset));max-width:calc(100vw - var(--cbv-modal-inset));max-height:calc(100dvh - var(--cbv-modal-inset))}.cbv-flt-bar{flex-wrap:wrap;height:auto;min-height:34px;row-gap:6px;padding:4px 0}.cbv-flt-bar>.cbv-badges{flex-wrap:wrap}.cbv-flt-search{flex:1 1 100%}.cbv-tabs{width:100%}.cbv-mp-grid,.cbv-sk-grid,.cbv-roster-grid{grid-template-columns:1fr}.cbv-rolepick-pop{width:min(300px,calc(100vw - var(--cbv-modal-inset)));max-height:var(--cbv-picker-max-h)}}',
			// 触摸（`pointer: coarse`）：主要按钮 / 卡片动作 / 选择行 44px，输入框 40px，chip 32px。
			'@media (pointer:coarse){.cbv-btn,.cbv-cardbtn,.cbv-picker-row,.cbv-tab{min-height:var(--cbv-touch-target)}.cbv-input,.cbv-select{min-height:40px;height:auto}.cbv-flt-chip{min-height:32px}}',
			// ── 输入框「润色」（design-polish-001）：入口按钮 + 对比浮窗 ─────────────────────
			// 浮窗是 portal 到 `document.body` 的（composer 那片 `will-change: transform` 会给
			// `position:fixed` 造包含块）⇒ **不在 `.cbv-root` 作用域里**，所以这里不引用 `--cbv-a*`
			// 那组中性格；底色只用 `--dsw-*` 的中性语义变量，**色相一律复用既有标签类**（见组件里的
			// `cbv-chip--st-rejected` / `--st-done` / `--st-verify` / `--p0`）—— 与"强调只给标签"那条口径一致。
			'.cbv-polish{position:relative;display:inline-flex;align-items:center}',
			'.cbv-polish-btn{padding:0 6px}',
			'.cbv-polish-icon{display:block;width:16px;height:16px;flex:none}',
			'.cbv-polish-btn[aria-disabled="true"]{opacity:var(--cbv-disabled-opacity,.5);cursor:default}',
			'.cbv-polish-btn--busy .cbv-polish-icon{animation:cbv-polish-spin .9s linear infinite}',
			'@keyframes cbv-polish-spin{to{transform:rotate(360deg)}}',
			// 就地提示：贴在按钮上方的一个小气泡（不打开浮窗，`aria-describedby` 指过来）。
			'.cbv-polish-overlay{align-items:center;padding:24px}',
			'.cbv-polish-modal{width:min(760px,94vw)}',
			'.cbv-polish-sub{flex:0 1 auto;min-width:0;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.cbv-polish-body{display:flex;flex-direction:column;gap:10px}',
			'.cbv-polish-section{display:flex;flex-direction:column;gap:4px;min-width:0}',
			'.cbv-polish-label{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
			'.cbv-polish-count{margin-left:auto;font-variant-numeric:tabular-nums}',
			// 两段只读区：**都可滚、都可复制**；浮窗内再滚一层，避免长文把按钮顶出视口。
			'.cbv-polish-text{font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;max-height:30vh;overflow-y:auto;overscroll-behavior:contain;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px}',
			'.cbv-polish-text:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}',
			'.cbv-polish-mark{border-radius:3px;padding:0 1px}',
			'.cbv-polish-mark--del{text-decoration:line-through}',
			'.cbv-polish-mark--add{text-decoration:none}',
			'.cbv-polish-loading{display:flex;flex-direction:column;gap:6px;padding:10px;background:transparent;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}',
			'.cbv-polish-skel{display:block;height:10px;border-radius:5px;background:var(--dsw-alias-border-l2)}',
			'.cbv-polish-loading-word{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
			'.cbv-polish-error{padding:8px 10px;border-width:1px;border-style:solid;border-radius:8px;font-size:13px;line-height:1.5}',
			'.cbv-polish-reason{margin-top:4px;font-weight:400;color:var(--dsw-alias-label-secondary)}',
			'.cbv-polish-warn{padding:8px 10px;border-width:1px;border-style:solid;border-radius:8px;font-size:12px;line-height:1.5}',
			'.cbv-polish-warn-title{font-weight:600}',
			'.cbv-polish-warn-line{margin-top:2px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
			'.cbv-polish-summary{font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.cbv-polish-copied{font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.cbv-polish-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l2);flex:none}',
			// 小屏：浮窗内缩到视口内（`--cbv-modal-inset` 不在 `.cbv-root` 里，给 16px 兜底）。
			'@media (max-width:480px){.cbv-polish-modal{width:calc(100vw - var(--cbv-modal-inset, 16px));max-width:calc(100vw - var(--cbv-modal-inset, 16px))}.cbv-polish-text{max-height:26vh}}',
			'@media (prefers-reduced-motion:reduce){.cbv-polish-btn--busy .cbv-polish-icon{animation:none}}',
		].join('\n')

		// ── ⑥ 渲染原语与 Markdown ──────────────────────────────────────────
		const el = (type, props, ...children) => React.createElement(type, props, ...children)

		/**
		 * 把一个**定高定位的浮层** portal 到 `document.body`：`position: fixed` 从此真的以视口为准。
		 *
		 * 为什么要有它：宿主的输入框一带（`.composerSeat`，已激活会话下带 `will-change: transform`）
		 * 会给后代造一个包含块，挂在里面的 `fixed` 浮层会**跟着那一层走**而不是跟着视口走 —— 表现就是
		 * 选择框跟按钮对不上（宿主插槽契约对此的原话见 `react-dom` 种子上面那段注释）。
		 * 本插件只有这一处浮层长在输入框里，所以只有这一处要 portal。视图栏那几块里的浮窗/弹窗**不在这条
		 * 契约的点名范围里**（宿主只对 `conversation.input.left` 提了这条要求）⇒ 别顺手改它们：改了就要
		 * 重新验它们的层级、关闭与键盘路径，而现场并没有报那几处错位。
		 *
		 * 三级退化，一级比一级保守（**任何一级都不许抛**）：
		 *   ① 有 `react-dom` 的 `createPortal` ⇒ portal 到 `document.body`（正路）；
		 *   ② 没有这个种子 / 没有 `createPortal`（离线自检那套"穷人的 React"）⇒ 原样返回，就地渲染；
		 *   ③ `createPortal` 自己抛（老版本签名）⇒ 同样原样返回。
		 * @param node - 浮层元素（`null` / `undefined` 原样返回，调用方不用先判）。
		 * @returns 包好的 portal，或原样的节点。
		 */
		const portalOf = (node) => {
			if (node === null || node === undefined) return node
			if (ReactDOM === null || typeof ReactDOM.createPortal !== 'function') return node
			if (typeof document === 'undefined' || document.body === null || document.body === undefined) return node
			try {
				return ReactDOM.createPortal(node, document.body)
			} catch {
				return node
			}
		}

		const text = (value) => (value === null || value === undefined ? '' : '' + value)

		const unquote = (value) => {
			if (typeof value !== 'string') return ''
			const trimmed = value.trim()
			if (trimmed.length > 1 && trimmed.charAt(0) === '`' && trimmed.charAt(trimmed.length - 1) === '`') {
				return trimmed.slice(1, trimmed.length - 1)
			}
			return trimmed
		}

		const shortTime = (value) => {
			if (typeof value !== 'string' || value.length === 0) return '—'
			return value.replace('T', ' ').slice(0, 16)
		}

		// ── Markdown 渲染 ────────────────────────────────────────────────────
		// 文件文本按 GFM 子集渲染（标题 / 围栏代码 / 引用 / 列表 / 分隔线 / 段落 + 行内代码、粗斜体、删除线、链接）。
		// 两条硬约束：① 只构造 React 元素，不用 dangerouslySetInnerHTML（尖括号原样显示，注入不了标记）；
		// ② 链接只认 http/https/mailto 与页内锚点，其余（javascript:、data: 等）按纯文本显示。

		/** 可以安全放进 href 的协议前缀。 */
		const SAFE_HREF = /^(https?:\/\/|mailto:|#|\/)/i
		/** 行内标记的扫描式：每一项都从当前位置找最早出现的那一个。 */
		const MD_SPAN = [
			{ re: /`([^`\n]+)`/, make: (m, key) => el('code', { key }, m[1]) },
			{ re: /\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/, make: (m, key) => el('strong', { key }, m[1]) },
			{ re: /__(?!\s)([\s\S]+?)(?<!\s)__/, make: (m, key) => el('strong', { key }, m[1]) },
			{ re: /~~(?!\s)([\s\S]+?)(?<!\s)~~/, make: (m, key) => el('del', { key }, m[1]) },
			{ re: /\*(?!\s)([^*\n]+?)(?<!\s)\*/, make: (m, key) => el('em', { key }, m[1]) },
			// 词内下划线不算强调（GFM 同款）：两侧都要是非单词字符或边界。
			{ re: /(?<![\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w])/, make: (m, key) => el('em', { key }, m[1]) },
			{
				re: /\[([^\]\n]+)\]\(([^)\s]+)\)/,
				make: (m, key) => (SAFE_HREF.test(m[2]) ? el('a', { key, href: m[2], target: '_blank', rel: 'noreferrer noopener' }, m[1]) : m[0]),
			},
			{
				re: /(https?:\/\/[^\s<>()]+)/,
				make: (m, key) => el('a', { key, href: m[1], target: '_blank', rel: 'noreferrer noopener' }, m[1]),
			},
		]

		/**
		 * 把一段文本切成 React 节点数组：普通文字原样（由 React 转义），标记段落成元素。
		 * @param source - 待渲染文本。
		 * @param prefix - 生成 key 的前缀，保证同一段里各节点 key 唯一。
		 * @returns 节点数组。
		 */
		const inlineNodes = (source, prefix) => {
			const out = []
			let rest = '' + source
			let n = 0
			while (rest.length > 0) {
				let best = null
				for (const span of MD_SPAN) {
					const match = span.re.exec(rest)
					if (match === null) continue
					if (best === null || match.index < best.match.index) best = { span, match }
				}
				if (best === null) {
					out.push(rest)
					break
				}
				if (best.match.index > 0) out.push(rest.slice(0, best.match.index))
				out.push(best.span.make(best.match, prefix + '-i' + n++))
				rest = rest.slice(best.match.index + best.match[0].length)
			}
			return out
		}

		/** 一个段落里的换行：行尾两个空格或反斜杠是硬换行，其余按空格连接。 */
		const paragraphNodes = (source, prefix) => {
			const out = []
			const lines = ('' + source).split('\n')
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]
				const hard = /( {2,|\\)$/.test(line)
				const body = hard ? line.replace(/( {2,}|\\)$/, '') : line
				out.push(...inlineNodes(body, prefix + '-l' + i))
				if (i < lines.length - 1) out.push(hard ? el('br', { key: prefix + '-br' + i }) : ' ')
			}
			return out
		}

		/**
		 * 把一段文本切成块：围栏代码块、标题、引用、列表、分隔线、段落。
		 * @param source - 待渲染文本。
		 * @returns 块数组。
		 */
		/** 一行像不像表格行：至少有一个 `|`，且去掉首尾竖线后至少有一格非空。 */
		const isTableRow = (line) => typeof line === 'string' && line.includes('|') && line.trim() !== ''

		/** 分隔行：`|---|:--:|` 这种（每格至少两个短横，允许首尾对齐冒号）。 */
		const isTableDivider = (line) => {
			if (typeof line !== 'string') return false
			const trimmed = line.trim()
			if (!trimmed.includes('-')) return false
			if (!/^\|?[\s:-]*(\|[\s:-]*)*\|?$/.test(trimmed)) return false
			return trimmed
				.replace(/^\|/, '')
				.replace(/\|$/, '')
				.split('|')
				.every((cell) => /^\s*:?-{2,}:?\s*$/.test(cell))
		}

		/** 拆一行表格：去掉首尾竖线，按 `|` 切（`\|` 不当分隔），每格 trim。 */
		const splitRow = (line) => {
			const body = ('' + line).trim().replace(/^\|/, '').replace(/\|$/, '')
			const cells = []
			let cell = ''
			for (let at = 0; at < body.length; at += 1) {
				const ch = body.charAt(at)
				if (ch === '\\' && body.charAt(at + 1) === '|') {
					cell += '|'
					at += 1
					continue
				}
				if (ch === '|') {
					cells.push(cell.trim())
					cell = ''
					continue
				}
				cell += ch
			}
			cells.push(cell.trim())
			return cells
		}

		const mdBlocks = (source) => {
			const lines = ('' + source).replace(/\r\n?/g, '\n').split('\n')
			const blocks = []
			const FENCE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9+#-]*)\s*$/
			const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
			const QUOTE = /^\s{0,3}>\s?/
			const BULLET = /^\s*[-*+]\s+(.*)$/
			const NUMBERED = /^\s*\d{1,9}[.)]\s+(.*)$/
			const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
			const startsBlock = (line) => FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || BULLET.test(line) || NUMBERED.test(line) || HR.test(line)
			let i = 0
			while (i < lines.length) {
				const line = lines[i]
				if (/^\s*$/.test(line)) {
					i += 1
					continue
				}
				const fence = FENCE.exec(line)
				if (fence !== null) {
					const bar = fence[1].charAt(0)
					const close = new RegExp('^\\s*' + (bar === '`' ? '`' : '~') + '{' + fence[1].length + ',}\\s*$')
					const body = []
					i += 1
					while (i < lines.length && !close.test(lines[i])) {
						body.push(lines[i])
						i += 1
					}
					if (i < lines.length) i += 1
					blocks.push({ type: 'code', lang: fence[2], text: body.join('\n') })
					continue
				}
				const heading = HEADING.exec(line)
				if (heading !== null) {
					blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
					i += 1
					continue
				}
				if (HR.test(line) && !BULLET.test(line)) {
					blocks.push({ type: 'hr' })
					i += 1
					continue
				}
				if (QUOTE.test(line)) {
					const body = []
					while (i < lines.length && QUOTE.test(lines[i])) {
						body.push(lines[i].replace(QUOTE, ''))
						i += 1
					}
					blocks.push({ type: 'quote', text: body.join('\n') })
					continue
				}
				// GFM 管道表格：`| a | b |` + 一行分隔 + 若干数据行；只有一行带 `|` 或第二行不是分隔行就照旧当段落，
				// 单元格内的行内语法照旧走 `inlineNodes`。
				if (isTableRow(line) && isTableDivider(lines[i + 1])) {
					const header = splitRow(line)
					const align = splitRow(lines[i + 1]).map((cell) => {
						const left = cell.startsWith(':')
						const right = cell.endsWith(':')
						return left && right ? 'center' : right ? 'right' : left ? 'left' : ''
					})
					i += 2
					const rows = []
					while (i < lines.length && isTableRow(lines[i]) && !/^\s*$/.test(lines[i])) {
						rows.push(splitRow(lines[i]))
						i += 1
					}
					blocks.push({ type: 'table', header, align, rows })
					continue
				}
				if (BULLET.test(line) || NUMBERED.test(line)) {
					const ordered = NUMBERED.test(line)
					const items = []
					while (i < lines.length) {
						const match = ordered ? NUMBERED.exec(lines[i]) : BULLET.exec(lines[i])
						if (match === null) break
						items.push(match[1])
						i += 1
					}
					blocks.push({ type: 'list', ordered, items })
					continue
				}
				const body = []
				while (
					i < lines.length &&
					!/^\s*$/.test(lines[i]) &&
					!startsBlock(lines[i]) &&
					!(isTableRow(lines[i]) && isTableDivider(lines[i + 1]))
				) {
					body.push(lines[i])
					i += 1
				}
				if (body.length === 0) {
					// 起止条件互相咬住时兜底前进一行，避免死循环。
					body.push(lines[i])
					i += 1
				}
				blocks.push({ type: 'para', text: body.join('\n') })
			}
			return blocks
		}

		/** 把一个块渲染成元素。 */
		const mdBlockNode = (block, key) => {
			if (block.type === 'code') {
				return el('pre', { className: 'cbv-md-pre', key }, el('code', {}, block.text))
			}
			if (block.type === 'heading') {
				const level = Math.min(6, Math.max(1, block.level))
				return el('h' + level, { className: 'cbv-md-h', key }, inlineNodes(block.text, key + 'h'))
			}
			if (block.type === 'hr') return el('hr', { className: 'cbv-md-hr', key })
			if (block.type === 'table') {
				// 宽表格要能横着看：外面套一层可滚容器（窄表格看不出差别，宽表格不至于撑破浮窗）。
				const cell = (value, index, tag) =>
					el(
						tag,
						{ className: 'cbv-md-cell' + (block.align[index] === '' ? '' : ' cbv-md-cell--' + block.align[index]), key: key + tag + index },
						inlineNodes(value, key + tag + index),
					)
				return el(
					'div',
					{ className: 'cbv-md-table-wrap', key },
					el(
						'table',
						{ className: 'cbv-md-table' },
						el('thead', {}, el('tr', {}, block.header.map((value, index) => cell(value, index, 'th')))),
						el('tbody', {}, block.rows.map((row, r) => el('tr', { key: key + 'r' + r }, block.header.map((_, c) => cell(row[c] === undefined ? '' : row[c], c, 'td'))))),
					),
				)
			}
			if (block.type === 'quote') return el('blockquote', { className: 'cbv-md-quote', key }, paragraphNodes(block.text, key + 'q'))
			if (block.type === 'list') {
				return el(
					block.ordered ? 'ol' : 'ul',
					{ className: 'cbv-md-list', key },
					block.items.map((item, index) => el('li', { key: key + 'li' + index }, paragraphNodes(item, key + 'li' + index))),
				)
			}
			return el('p', { className: 'cbv-md-p', key }, paragraphNodes(block.text, key + 'p'))
		}

		/**
		 * 一段文件文本 → 渲染好的块元素数组。
		 * @param source - 待渲染文本。
		 * @param prefix - key 前缀。
		 * @returns 元素数组。
		 */
		const markdownNodes = (source, prefix) => mdBlocks(source).map((block, index) => mdBlockNode(block, prefix + '-b' + index))

		/**
		 * 文件文本字段的统一出口：空值给占位文案，非空按 Markdown 渲染。
		 * @param className - 外层类名（会自动追加 cbv-md 标记）。
		 * @param value - 字段值。
		 * @param placeholder - 空值时的占位文案（可为空串，表示不给占位）。
		 * @param key - React key。
		 * @returns 元素。
		 */
		const mdField = (className, value, placeholder, key) => {
			const source = text(value)
			if (source.trim() === '') return el('div', { className, key }, placeholder)
			return el('div', { className: className + ' cbv-md', key }, markdownNodes(source, key))
		}

		/** 条目的全部标量叶子拼成一个可搜字符串（嵌套对象与数组一并纳入）。 */
		const haystackOf = (item) => {
			const parts = []
			const keys = Object.keys(item)
			for (let i = 0; i < keys.length; i++) {
				const value = item[keys[i]]
				if (typeof value === 'string') parts.push(value)
				else if (typeof value === 'number' || typeof value === 'boolean') parts.push('' + value)
				else if (Array.isArray(value)) {
					for (let j = 0; j < value.length; j++) {
						const nested = value[j]
						if (typeof nested === 'string') parts.push(nested)
						else if (nested !== null && typeof nested === 'object') parts.push(haystackOf(nested))
					}
				}
			}
			return parts.join(' ').toLowerCase()
		}

		/** 某字段出现的全部取值，升序。 */
		const facetValuesOf = (items, field) => {
			const seen = {}
			const out = []
			for (let i = 0; i < items.length; i++) {
				const value = items[i][field]
				if (value === null || value === undefined) continue
				const key = '' + value
				if (seen[key] === true) continue
				seen[key] = true
				out.push(key)
			}
			out.sort()
			return out
		}

		/** 按状态分栏：先按 spec.statusOrder，再把枚举外的取值单列在后。 */
		/**
		 * 头像图标的几何：**一条 24×24 的描边 SVG**（人的指令：emoji 头像改成不带色彩的图标）。
		 *
		 * 几件要说清的事：
		 *   · 引擎只给**图标名**（`ROLE_AVATAR_ICONS`），几何在这一处 —— 表现层的事不塞进引擎；
		 *   · **不上色**：整条 SVG 只用 `currentColor` 描边，深浅由卡上那五档中性透明度给，
		 *     于是面板里那 20 来个头像不再是"一片彩色 emoji"；
		 *   · 命名与网格按 Lucide / Feather 那套 24×24 描边图标来（**几何是照规范自己画的**，
		 *     不是它们的原版路径 —— 本机取不到原版，所以不主张原样搬运）；
		 *   · 认不出名字时不画空白：回落到**首字母**（`avatarOf` 之外的手写角色名也能看）。
		 */
		// ── ⑦ 头像、分栏与卡片原语 ──────────────────────────────────────────────
		const AVATAR_ICONS = (() => {
			// 齿轮的 8 颗齿按角度算出来（手写 16 个坐标容易错一位）；半径 6.6 → 8.6。
			const teeth = []
			for (let index = 0; index < 8; index += 1) {
				const angle = (index * Math.PI) / 4
				const inner = 6.6
				const outer = 8.6
				teeth.push(['line', {
					x1: 12 + Math.cos(angle) * inner,
					y1: 12 + Math.sin(angle) * inner,
					x2: 12 + Math.cos(angle) * outer,
					y2: 12 + Math.sin(angle) * outer,
				}])
			}
			return {
				target: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['circle', { cx: 12, cy: 12, r: 4.5 }], ['circle', { cx: 12, cy: 12, r: 1 }]],
				crown: [['path', { d: 'M3 17.5V7l4.5 4L12 5.5l4.5 5.5L21 7v10.5z' }], ['line', { x1: 3, y1: 20, x2: 21, y2: 20 }]],
				clipboard: [['rect', { x: 5.5, y: 4.5, width: 13, height: 16.5, rx: 2 }], ['rect', { x: 9.5, y: 2.5, width: 5, height: 3.5, rx: 1 }], ['line', { x1: 9, y1: 11, x2: 15, y2: 11 }], ['line', { x1: 9, y1: 15, x2: 15, y2: 15 }]],
				trend: [['polyline', { points: '3,17 9,11 12.5,14.5 21,6.5' }], ['polyline', { points: '15.5,6.5 21,6.5 21,12' }]],
				landmark: [['path', { d: 'M3.5 9.5 12 3.5l8.5 6z' }], ['line', { x1: 3.5, y1: 9.5, x2: 20.5, y2: 9.5 }], ['line', { x1: 6.5, y1: 10.5, x2: 6.5, y2: 17 }], ['line', { x1: 10.5, y1: 10.5, x2: 10.5, y2: 17 }], ['line', { x1: 13.5, y1: 10.5, x2: 13.5, y2: 17 }], ['line', { x1: 17.5, y1: 10.5, x2: 17.5, y2: 17 }], ['line', { x1: 4.5, y1: 17.5, x2: 19.5, y2: 17.5 }], ['line', { x1: 3, y1: 20.5, x2: 21, y2: 20.5 }]],
				cog: [['circle', { cx: 12, cy: 12, r: 3.2 }], ['circle', { cx: 12, cy: 12, r: 6.6 }], ...teeth],
				// 前端：一扇**浏览器窗口**（顶栏 + 三个点）—— 比"</>"更贴前端，也不与 `be-dev` 的齿轮撞。
				browser: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['line', { x1: 3, y1: 9, x2: 21, y2: 9 }], ['circle', { cx: 6, cy: 6.5, r: 0.9 }], ['circle', { cx: 9, cy: 6.5, r: 0.9 }], ['circle', { cx: 12, cy: 6.5, r: 0.9 }]],
				terminal: [['rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2 }], ['polyline', { points: '7,10 10,12.5 7,15' }], ['line', { x1: 12.5, y1: 15, x2: 17, y2: 15 }]],
				shield: [['path', { d: 'M12 3.5 20 6.5v5.8c0 4.7-3.4 7.7-8 8.7-4.6-1-8-4-8-8.7V6.5z' }], ['polyline', { points: '8.8,12 11,14.2 15.4,9.8' }]],
				// 体验设计：一支**竖着的铅笔**（笔身 + 笔尖 + 笔箍那一道）—— 比"画框"更像"在画东西"。
				pencil: [['rect', { x: 7.5, y: 3.5, width: 9, height: 10, rx: 1 }], ['path', { d: 'M7.5 13.5h9L12 20.5z' }], ['line', { x1: 7.5, y1: 7.5, x2: 16.5, y2: 7.5 }]],
				bot: [['rect', { x: 4.5, y: 8, width: 15, height: 11, rx: 3 }], ['line', { x1: 12, y1: 4.6, x2: 12, y2: 8 }], ['circle', { cx: 12, cy: 3.3, r: 1.3 }], ['circle', { cx: 9.5, cy: 13, r: 1.1 }], ['circle', { cx: 14.5, cy: 13, r: 1.1 }]],
				database: [['ellipse', { cx: 12, cy: 6.5, rx: 7, ry: 3 }], ['path', { d: 'M5 6.5v11c0 1.7 3.1 3 7 3s7-1.3 7-3v-11' }], ['path', { d: 'M5 11.5c0 1.7 3.1 3 7 3s7-1.3 7-3' }]],
				network: [['circle', { cx: 12, cy: 4.5, r: 2.2 }], ['circle', { cx: 4.5, cy: 19, r: 2.2 }], ['circle', { cx: 19.5, cy: 19, r: 2.2 }], ['line', { x1: 11, y1: 6.5, x2: 5.5, y2: 17 }], ['line', { x1: 13, y1: 6.5, x2: 18.5, y2: 17 }], ['line', { x1: 6.7, y1: 19, x2: 17.3, y2: 19 }]],
				search: [['circle', { cx: 10.5, cy: 10.5, r: 6.5 }], ['line', { x1: 15.3, y1: 15.3, x2: 20.5, y2: 20.5 }], ['polyline', { points: '7.8,10.6 9.8,12.6 13.4,8.6' }]],
				flask: [['path', { d: 'M9.5 3h5' }], ['path', { d: 'M10.5 3v6L5.5 18.5h13L13.5 9V3' }], ['line', { x1: 7.8, y1: 15, x2: 16.2, y2: 15 }]],
				speaker: [['path', { d: 'M11 5 6 9H3.5v6H6l5 4z' }], ['path', { d: 'M15 9.2a4.2 4.2 0 0 1 0 5.6' }], ['path', { d: 'M18 6.5a8 8 0 0 1 0 11' }]],
				document: [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14,3 14,8 19,8' }], ['line', { x1: 9, y1: 13, x2: 15, y2: 13 }], ['line', { x1: 9, y1: 17, x2: 13, y2: 17 }]],
				// 销售：一枚**圆形的"$"**（成交 / 报价那条语义最直）—— 原来那枚"%"读起来像"折扣"。
				// 两个"钩"用相对圆弧写（与 Feather 的 dollar-sign 同一套写法），比手写贝塞尔稳。
				dollar: [
					['circle', { cx: 12, cy: 12, r: 8.5 }],
					['line', { x1: 12, y1: 5.8, x2: 12, y2: 18.2 }],
					['path', { d: 'M15.4 8.6H10a2.6 2.6 0 0 0 0 5.2h4a2.6 2.6 0 0 1 0 5.2H8.6' }],
				],
				message: [['path', { d: 'M4 5.5h16v11H11l-5.5 4V16.5H4z' }], ['line', { x1: 8.5, y1: 9.5, x2: 15.5, y2: 9.5 }], ['line', { x1: 8.5, y1: 13, x2: 13, y2: 13 }]],
				coins: [['circle', { cx: 9.5, cy: 9.5, r: 5.5 }], ['path', { d: 'M14.4 5.2a5.5 5.5 0 0 1 0 11' }]],
				scale: [['line', { x1: 12, y1: 3.5, x2: 12, y2: 20.5 }], ['line', { x1: 6, y1: 7, x2: 18, y2: 7 }], ['path', { d: 'M6 7 3 13a3 3 0 0 0 6 0z' }], ['path', { d: 'M18 7l-3 6a3 3 0 0 0 6 0z' }], ['line', { x1: 8.5, y1: 20.5, x2: 15.5, y2: 20.5 }]],
				user: [['circle', { cx: 12, cy: 8.5, r: 4 }], ['path', { d: 'M4.5 20.5a7.5 7.5 0 0 1 15 0' }]],
			}
		})()

		/**
		 * 一个头像值画成什么（**认名字优先，认不出就当字面量画**）。
		 *
		 * 这条"认不出就照字面画"是刻意的：头像那格是个**开放字段**（宿主那一半要重启才带
		 * 新映射），那时载荷里的 `avatar` 还是 emoji —— 照字面画仍是"一个头像"，不空白也不报错。
		 * @param value - 载荷里的 `avatar`（图标名；认不出的值照字面画）。
		 * @returns React 节点。
		 */
		const avatarIconOf = (value) => {
			const name = text(value)
			const shape = AVATAR_ICONS[name]
			if (shape === undefined) {
				// 不认名字 ⇒ 当字面量画（首字母 / 短文本）。空值给一个中性兜底字符。
				return el('span', { className: 'cbv-mp-avatar-text', key: 'text' }, name === '' ? '·' : name)
			}
			return el(
				'svg',
				{
					key: 'svg',
					className: 'cbv-mp-avatar-svg',
					viewBox: '0 0 24 24',
					width: '18',
					height: '18',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: '1.8',
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
					'data-avatar-icon': name,
				},
				shape.map(([tag, attrs], index) => el(tag, { ...attrs, key: tag + index })),
			)
		}

		/**
		 * 状态标签的底色档（**表现层映射**：键是引擎的状态词，值只是给它一个色）。
		 * 枚举外的取值一律 `cbv-chip--exception`（不吞、不改写，也不并入任何一档）。
		 */
		const BOARD_TAG_CLASS = { 待办: 'cbv-chip--st-todo', 进行中: 'cbv-chip--st-doing', 待验收: 'cbv-chip--st-verify', 已完成: 'cbv-chip--st-done', 已打回: 'cbv-chip--st-rejected' }
		const boardTagClassOf = (status) => BOARD_TAG_CLASS[status] ?? 'cbv-chip--exception'

		/**
		 * 优先级的分档（**只给最高两档**上强调色：P0 红 / P1 琥珀；P2 / P3 / `—` 与枚举外的取值一律中性）。
		 * 依据取自引擎那份 `BOARD_PRIORITIES = ['P0','P1','P2','P3','—']`。
		 */
		const BOARD_PRIORITY_CLASS = { P0: 'cbv-chip--p0', P1: 'cbv-chip--p1' }
		const boardPriorityClassOf = (priority) => BOARD_PRIORITY_CLASS[text(priority)] ?? ''

		const bucketsOf = (items, spec) => {
			const buckets = {}
			const extras = []
			for (let i = 0; i < items.length; i++) {
				const key = items[i].status === null || items[i].status === undefined ? '(无状态)' : '' + items[i].status
				if (buckets[key] === undefined) {
					buckets[key] = []
					if (spec.statusOrder.indexOf(key) === -1) extras.push(key)
				}
				buckets[key].push(items[i])
			}
			const ordered = []
			// 规范状态**逐栏恒定出现**（没有内容也给空栏）：栏位本身就是这张表的骨架，
			// 缺栏会让"这一档没有"和"这一档没展示"分不清。
			for (let i = 0; i < spec.statusOrder.length; i++) {
				const name = spec.statusOrder[i]
				ordered.push({ name, items: buckets[name] === undefined ? [] : buckets[name], canonical: true })
			}
			for (let i = 0; i < extras.length; i++) {
				ordered.push({ name: extras[i], items: buckets[extras[i]], canonical: false })
			}
			return ordered
		}

		// ── 卡片渲染（看板那一份）──────────────────────────────────────────────

		/**
		 * 一条看板条目的卡。
		 *
		 * `options` 是**同一张卡的两种摆法**（不另写一张卡）：
		 *   · 默认（按状态分栏时）：栏名已经说明了状态，卡上**不印状态标签**、印 `phase` 徽标；
		 *   · `{ statusTag: true, showPhase: false }`（按 `phase` 分栏时，里程碑那一档）：
		 *     phase 由**栏名**给，状态改在卡上**打一个标签** —— 这正是"phase 横向、task 打标签"那条口径。
		 * @param task - 看板条目（端点整形后的）。
		 * @param isOpen - 展开形态（详情浮窗里用）。
		 * @param onToggle - 点卡片（开详情）。
		 * @param cardKey - React key。
		 * @param options - `{ statusTag?, showPhase? }`。
		 */
		const boardCard = (task, isOpen, onToggle, cardKey, options) => {
			const opts = options === undefined || options === null ? {} : options
			const top = [el('span', { className: 'cbv-id', key: 'id' }, text(task.id) || '(无编号)')]
			if (task.priority !== null && task.priority !== undefined) {
				// P0 / P1 上强调色（`BOARD_PRIORITY_CLASS`），其余中性；枚举外的取值照印、不上色。
				top.push(el('span', { className: 'cbv-chip ' + boardPriorityClassOf(task.priority), key: 'priority' }, text(task.priority)))
			}
			// 状态标签：**照印引擎给的取值**（词面与分栏名一致），底色只是给它一个档；
			// 枚举外的取值照样印出来并标成 `exception`（不吞、不改写）。
			if (opts.statusTag === true) {
				const status = text(task.status)
				top.push(el('span', { className: 'cbv-chip ' + boardTagClassOf(status), key: 'status', 'data-tag-status': status }, status === '' ? '（无状态）' : status))
			}
			if (opts.showPhase === false) {
				// 按 phase 分栏时不印 phase 徽标（栏名已经说了）——避免同一件事写两遍。
			} else if (task.phase !== null && task.phase !== undefined) top.push(el('span', { className: 'cbv-chip cbv-chip--phase', key: 'phase' }, text(task.phase)))
			if (task.grade === 'exception') top.push(el('span', { className: 'cbv-chip cbv-chip--exception', key: 'grade' }, '例外'))
			// 卡顶只留"编号 + 优先级 + 状态标签"（不带信息的「详情」与时间挪到描述下面那一行）。
			top.push(el('span', { className: 'cbv-spacer', key: 'spacer' }))
			const updatedAt = shortTime(task.updatedAt)

			// 运行时几格照抄载荷：版本号与活卡同形态（`v3`）；`assignee` 写成「现在：…」与卡上「归属：…」（owner）区分；
			// 执行代（`attempt` / `attempt_id`）是系统坐标，不印。
			const runtimeBits = []
			if (typeof task.revision === 'number') runtimeBits.push('v' + task.revision)
			if (text(task.assignee) !== '') runtimeBits.push('现在：' + text(task.assignee))
			const deps = Array.isArray(task.blockedByTasks) ? task.blockedByTasks : []
			const scopes = Array.isArray(task.writeScopes) ? task.writeScopes : []
			const scopeWarnings = Array.isArray(task.writeScopeWarnings) ? task.writeScopeWarnings : []
			const kids = [
				el('div', { className: 'cbv-card-top', key: 'top' }, top),
				mdField('cbv-desc', task.description, '(无描述)', 'desc'),
				updatedAt === '' ? null : el('div', { className: 'cbv-sub cbv-sub--time', key: 'updated' }, '更新 ' + updatedAt),
				el('div', { className: 'cbv-sub', key: 'owner' }, '归属：' + (text(task.owner) || '—')),
				runtimeBits.length === 0 ? null : el('div', { className: 'cbv-sub', key: 'runtime' }, runtimeBits.join(' · ')),
				deps.length === 0 ? null : el('div', { className: 'cbv-sub', key: 'deps' }, '依赖：' + deps.join('、')),
				scopes.length === 0 ? null : el('div', { className: 'cbv-sub', key: 'scopes' }, '写盘面：' + scopes.join('、')),
			].filter((node) => node !== null)
			// 卡在哪儿**挂在卡上**（不折叠也看得见）：这是"这张卡要动作"的信号，不是面板顶上的汇总数字。
			// 「卡在：」= 这张卡要动作的信号：**红字**（与"已打回"同一套语义色），不填底、不抢卡片。
			if (text(task.blockedBy) !== '') kids.push(el('div', { className: 'cbv-note cbv-note--danger', key: 'blocked' }, '卡在：' + text(task.blockedBy)))
			// 写盘面重叠：**提示**不是锁（引擎口径），所以用 warn 语气、且只印第一句免得把卡撑爆；
			// 完整几条在展开的明细里。这一格的判定来自引擎，面板只照印。
			if (scopeWarnings.length > 0) kids.push(el('div', { className: 'cbv-note cbv-note--warn', key: 'scope-warn' }, scopeWarnings[0]))
			if (isOpen) {
				const acceptance = task.acceptance === null || task.acceptance === undefined || typeof task.acceptance !== 'object' ? null : task.acceptance
				// 给人看的界面不印原生字段名与系统坐标：产物用中文「产物：…」留；阶段/评级/归属卡上已说过的不重复；
				// `revision` 与执行代只对工具回执有用，不印。
				const rows = [
					el('div', { className: 'cbv-sub', key: 'artifact' }, '产物：' + (text(task.artifact) === '' ? '—' : unquote(task.artifact))),
					text(task.grade) === '' || text(task.grade) === 'exception'
						? null
						: el('div', { className: 'cbv-sub', key: 'grade' }, '评级：' + text(task.grade)),
					el('div', { className: 'cbv-sub', key: 'deps' }, '依赖：' + (Array.isArray(task.blockedByTasks) && task.blockedByTasks.length > 0 ? task.blockedByTasks.join('、') : '无')),
					el('div', { className: 'cbv-sub', key: 'scopes' }, '写盘面：' + (Array.isArray(task.writeScopes) && task.writeScopes.length > 0 ? task.writeScopes.join('、') : '未声明')),
					acceptance === null ? null : el('div', { className: 'cbv-sub', key: 'acceptance' }, '验收：' + [text(acceptance.verdict) || '—', text(acceptance.by) || '—', shortTime(acceptance.at)].filter((part) => part !== '').join(' · ')),
					el('div', { className: 'cbv-sub', key: 'created' }, '创建：' + shortTime(task.createdAt)),
					// **「更新」这一格不在这里重复**：卡上那一行中文「更新 <时间>」已经说了一次（`isOpen` 时两者会同时画出来）
					// —— 口径与 task-65 删掉 `phase：` 那一行同一个道理：**每个事实只说一次**。
				].filter((node) => node !== null)
				if (Array.isArray(task.writeScopeWarnings) && task.writeScopeWarnings.length > 0) {
					rows.push(mdField('cbv-block', task.writeScopeWarnings.map((line) => '- ' + line).join('\n'), '', 'scope-warnings'))
				}
				if (text(task.note) !== '') rows.push(mdField('cbv-block', task.note, '', 'note'))
				kids.push(el('div', { className: 'cbv-detail', key: 'detail' }, rows))
			}
			return el('div', CARD_SHELL_PROPS(cardKey, onToggle), kids)
		}

				const CARDS = { board: boardCard }

		/**
		 * 卡片外壳的属性：整张卡可点，因此也必须可聚焦、可用键盘打开 ——
		 * 只绑 onClick 的 div 对键盘用户等于不可点。
		 * @param cardKey - React key。
		 * @param onToggle - 打开详情。
		 * @returns 传入 createElement 的属性对象。
		 */
		const CARD_SHELL_PROPS = (cardKey, onToggle) => ({
			className: 'cbv-card',
			key: cardKey,
			onClick: onToggle,
			tabIndex: 0,
			role: 'button',
			onKeyDown: (event) => {
				if (event === null || event === undefined) return
				if (event.key !== 'Enter' && event.key !== ' ') return
				event.preventDefault()
				onToggle()
			},
		})

		// ── 通用视图 ──────────────────────────────────────────────────────

		/** 会话清单 store（`sessions.list`）：取不到会话服务时返回 null。 */
		// ── ⑧ 会话、工作区与高度 ───────────────────────────────────────────────
		function sessionsListStore() {
			try {
				const service = serviceOf('sessions')
				if (service === null || service === undefined) return null
				return service.list === null || service.list === undefined ? null : service.list
			} catch {
				return null
			}
		}

		/**
		 * 当前会话 id 的**四级回落**。
		 *
		 * 为什么不能只读一个字段：宿主 0.2.x 的会话清单 store 里**没有 `current`**
		 * （现场报的「请求里没带 workspace 参数」就是按老形态读 `snapshot.current` 读出来的空串），
		 * "当前是哪个会话"这件事在客户端由 `uiSession` 的**主绑定**持有。四级按权威度排：
		 *   ① `uiSession.current`（客户端权威：主视图正在显示的那个会话）；
		 *   ② 清单里 `retainedBy.mainView > 0` 的第一行（与宿主 `uiSession.publishMain` 同一条判定）；
		 *   ③ 老形态 `snapshot.current`（宿主 store 自己带它时）；
		 *   ④ 清单里**只有一个**会话时才用它 —— 多于一个**不猜**（猜错工作区比报错更坏）。
		 * @returns 会话 id；取不到时为空串。
		 */
		function resolveCurrentSessionId() {
			let snapshot = null
			const list = sessionsListStore()
			try {
				if (list !== null && typeof list.getSnapshot === 'function') snapshot = list.getSnapshot()
			} catch {
				snapshot = null
			}
			const byId = snapshot !== null && typeof snapshot === 'object' && snapshot.byId !== null && typeof snapshot.byId === 'object' ? snapshot.byId : {}
			try {
				const key = serviceOf('uiSession')?.current?.getSnapshot?.()?.key
				if (typeof key === 'string' && key !== '') return key
			} catch {
				/* 取不到就往下走：它不是硬依赖 */
			}
			const retained = Object.values(byId).find((row) => row !== null && typeof row === 'object' && (row.retainedBy?.mainView ?? 0) > 0)
			if (retained !== undefined && typeof retained.id === 'string' && retained.id !== '') return retained.id
			if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.current === 'string' && snapshot.current !== '') return snapshot.current
			const ids = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(byId)
			return ids.length === 1 ? ids[0] : ''
		}

		/**
		 * 订阅「当前会话」的变化：**清单 store 与 `uiSession.current` 都要订**。
		 * 只订前者时，切会话不会让这一栏跟着变（当前会话这件事不在清单里）；只订后者时，
		 * 会话列表自己刷新（例如新会话登记进来）也不会重读。两个都订，任一变化都重读一次。
		 * @param listener - 变化回调。
		 * @returns 释放函数（逐个吞掉异常，卸载时不因为一个订阅失败而漏掉其它）。
		 */
		function subscribeCurrentSession(listener) {
			const disposers = []
			const store = sessionsListStore()
			if (store !== null && typeof store.subscribe === 'function') {
				try {
					const dispose = store.subscribe(listener)
					if (typeof dispose === 'function') disposers.push(dispose)
				} catch {
					/* 订阅失败就退化成"只在挂载时读一次"，不影响其它两栏 */
				}
			}
			try {
				const source = serviceOf('uiSession')?.current
				if (source !== null && source !== undefined && typeof source.subscribe === 'function') {
					const dispose = source.subscribe(listener)
					if (typeof dispose === 'function') disposers.push(dispose)
				}
			} catch {
				/* 同上：`uiSession` 是可选的 */
			}
			return () => {
				for (const dispose of disposers) {
					try {
						dispose()
					} catch {
						/* 释放失败不声张 */
					}
				}
			}
		}

		/**
		 * 读「当前会话的工作目录」并订阅它的变化。
		 *
		 * 视图栏是按会话渲染的：切到别的工作区的会话时，这里必须跟着变，所以订阅"当前会话"这件事
		 * （见 `subscribeCurrentSession`）而不是取一次。取不到会话服务、或该会话没有 cwd 时返回空串，
		 * 此时端点回落到 composition 行配的 workspace（宿主还有一级"唯一工作区"回落并在载荷里说明）。
		 * @param store - 会话清单 store（`ctx.sessions.list`），或 null。
		 * @returns 当前会话的工作目录；取不到时为空串。
		 */
		function useCurrentWorkspace(store) {
			const read = () => {
				try {
					if (store === null || store === undefined || typeof store.getSnapshot !== 'function') return ''
					const snapshot = store.getSnapshot()
					const byId = snapshot !== null && typeof snapshot === 'object' && snapshot.byId !== null && typeof snapshot.byId === 'object' ? snapshot.byId : {}
					const id = resolveCurrentSessionId()
					// **子智能体的会话行没有 cwd**（它只有 parentId）：沿父链找第一个带 cwd 的行 ——
					// 团队面板折到根会话之后，工作区也从根会话那一行拿，少让宿主去猜。
					const cwdOf = (start) => {
						let row = start === '' ? undefined : byId[start]
						const seen = new Set()
						for (let depth = 0; depth < 16; depth += 1) {
							if (row === null || row === undefined || typeof row !== 'object') return ''
							if (typeof row.cwd === 'string' && row.cwd !== '') return row.cwd
							const parent = typeof row.parentId === 'string' ? row.parentId : ''
							if (parent === '' || seen.has(parent)) return ''
							seen.add(parent)
							row = byId[parent]
						}
						return ''
					}
					return cwdOf(id)
				} catch {
					return ''
				}
			}
			const [value, setValue] = React.useState(read)
			React.useEffect(() => {
				const sync = () => setValue(read())
				sync()
				return subscribeCurrentSession(sync)
			}, [store])
			return value
		}

		/**
		 * **团队面板按根会话读**：子智能体会话（清单里 `origin: 'subagent'`、带 `parentId`）
		 * 不是团队会话 —— 它的父链顶端才是领队那个会话，成员 / 任务 / 状态都挂在那儿。
		 *
		 * 现场：在 lead 对话里看得到两位成员；切到 fe-dev-1 那个子对话再看，面板按**子会话 id**
		 * 去取凭据，子会话没在跑 ⇒ 报"会话 … 现在不活着，读不到名册"；技能那一块则退层并告警
		 * （"清单读的是 root-agent 层"）。所以面板的取数一律沿 `parentId` 走到根；
		 * 走不到（普通会话 / 清单里没有这一行 / 成环）就用原 id。
		 * @param store - 会话清单 store（`ctx.sessions.list`），或 null。
		 * @param sessionId - 当前会话 id。
		 * @returns 团队会话 id（根）；取不到根时原样返回。
		 */
		function teamSessionIdOf(store, sessionId) {
			if (sessionId === '') return ''
			let snapshot = null
			try {
				snapshot = store !== null && store !== undefined && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null
			} catch {
				snapshot = null
			}
			const byId = snapshot !== null && typeof snapshot === 'object' && snapshot.byId !== null && typeof snapshot.byId === 'object' ? snapshot.byId : {}
			let id = sessionId
			const seen = new Set()
			// 深度上限与环检测：父链是数据，坏了也不许把面板挂死。
			for (let depth = 0; depth < 16; depth += 1) {
				if (seen.has(id)) break
				seen.add(id)
				const row = byId[id]
				const parent = row !== null && typeof row === 'object' && typeof row.parentId === 'string' ? row.parentId : ''
				if (parent === '' || parent === id) break
				id = parent
			}
			return id
		}

		/**
		 * 读「当前是哪个会话」（同一个四级回落，见 `resolveCurrentSessionId`）并订阅它的变化。
		 *
		 * **四块都用 `teamSessionIdOf()` 折到根会话**（成员 / 角色 / 技能 / 看板 / 状态）——
		 * 团队与技能目录都挂在领队那个会话上；子会话没在跑时按子会话读只会退层告警。
		 * @param store - 会话清单 store（`ctx.sessions.list`），或 null。
		 * @returns 当前会话 id；取不到时为空串。
		 */
		function useCurrentSessionId(store) {
			const read = () => {
				try {
					if (store === null || store === undefined || typeof store.getSnapshot !== 'function') return ''
					return resolveCurrentSessionId()
				} catch {
					return ''
				}
			}
			const [value, setValue] = React.useState(read)
			React.useEffect(() => {
				const sync = () => setValue(read())
				sync()
				return subscribeCurrentSession(sync)
			}, [store])
			return value
		}

		/**
		 * 状态页不该出现对话输入框：本视图挂载期间占住输入框那个槽并渲染空。
		 *
		 * 该槽是 single 且按 priority 升序取第一个 ⇒ 注册一个 `-1` 的占用者即压过壳自己的注册
		 * （它用默认 0）。这比"在视图选中/取消时推一个标志"稳妥：槽的注册与释放会通知该槽的
		 * outlet 自己重渲染，不依赖壳这一轮 render 的先后。卸载即释放 ⇒ 换回对话就恢复。
		 * @param slots - 客户端 slots 服务。
		 */
		function useComposerHidden(slots) {
			React.useEffect(() => {
				if (slots === null || slots === undefined || typeof slots.register !== 'function') return () => {}
				let dispose = null
				try {
					dispose = slots.register({ name: 'conversation.composer.bar', id: 'company-ledger-composer-void', priority: -1 }, () => null)
				} catch {
					return () => {}
				}
				return () => {
					if (typeof dispose === 'function') dispose()
				}
			}, [slots])
		}

		/**
		 * 面板首屏：**三行状态 + 三个动作**。
		 *
		 * 三条口径（定了就不许含糊）：
		 *   · 那几行**不由前端算** —— 端点 `/company-board/api/status` 把看板文件交给引擎的
		 *     `statusSnapshot`，也就是会话工具 `team_status` 用的同一份实现 ⇒ 面板与工具不会各说各话；
		 *   · **明细就地展开**：现有三栏 + 成员栏的内容一个都不删，只是不再默认占屏（「不做多页」指的是默认别铺开）；
		 *   · 缺文件时照端点给的如实陈述走（那个数写 `?`），前端**不替它补 0**。
		 */
		/**
		 * **该占的高度 = 自己这块的顶边到容器底边**（不是"猜壳占了多少像素"）。
		 *
		 * 壳给视图的高度是 auto（百分比高度算不出确定值），所以只能用视口高减一个猜的常数 ——
		 * 那个常数**壳一改就错**：留多了底下就是一大块空白（现场就是这么来的），留少了主页面被顶长。
		 * 这里改成**量**：顶边到容器底边的距离；量不到时返回 null，外层退回 CSS 里的兜底高度。
		 *
		 * @param top - 自己这块的顶边（视口坐标）
		 * @param parentBottom - 容器的底边（视口坐标）
		 * @param viewport - 视口高度（上界，防容器底边报出一个超出屏幕的值）
		 * @returns 像素数；算出比 320 还小（或读数是 NaN）时取 320，免得被压成一条。
		 */
		function fillHeightFrom(top, parentBottom, viewport) {
			const ceiling = Math.min(parentBottom, viewport)
			const next = Math.round(ceiling - top)
			return Number.isFinite(next) && next >= 320 ? next : 320
		}

		/**
		 * 可用高度：**优先按壳自己的滚动容器量**（`[data-conversation-scroll]`，那条收拖拽条的 CSS 用的同一个）。
		 *
		 * 为什么不用父元素：父元素是"跟着我们长"的自动高度盒子 —— 拿它当基准，可用高度会被锁死在
		 * **我们当前这一坨的高度**上，于是面板永远是"内容多高就多高"，底下那一块空白永远补不上。
		 * 壳的滚动容器尺寸由壳决定，不随我们内容变，这才是一个不会自己锁死自己的基准。
		 *
		 * @param container - 壳滚动容器的盒子（`{ top, height }`），量不到时传 null
		 * @param top - 本栏的顶边（视口坐标）
		 * @param parentBottom - 兜底基准：父元素底边
		 * @param viewport - 兜底基准：视口高度
		 */
		function paneHeightFrom(container, top, parentBottom, viewport) {
			if (container !== null && container !== undefined && Number.isFinite(container.top) && Number.isFinite(container.height)) {
				// 容器内、本栏顶边以下还剩多少：滚动位置不影响它（用相对偏移算），并夹在容器高度之内。
				const room = container.height - (top - container.top)
				return Math.round(Math.min(Math.max(room, 320), container.height))
			}
			return fillHeightFrom(top, parentBottom, viewport)
		}

		/** 从 DOM 量出该占的高度；读不到（无 DOM / 没本栏标记 / 拿不到盒子）返回 null。 */
		/**
		 * 输入区（composer）占掉的高度 —— 从**壳自己发布的 CSS 变量**读：`--dsh-composer-height`。
		 * 壳内部就靠它给"回到底部"按钮让位（`bottom: calc(var(--dsh-composer-height,152px) + 16px)`），
		 * 也就是说：**滚动容器的可视区一直延伸到输入区底下**，这块空间不扣掉，面板就会高出可用区（主体滑动）。
		 * 读不到就返回 0（宁可不扣，也不瞎扣）。
		 */
		function shellComposerHeight(scroller) {
			if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 0
			if (scroller === null || scroller === undefined) return 0
			try {
				// 必须在滚动容器自己身上读 `--dsh-composer-height`（CSS 变量只往下继承，`documentElement` 读不到）；
				// 从祖先读会得到 0，正好少扣一个输入区高度，面板高出可用区、主体滑动。
				const style = window.getComputedStyle(scroller)
				const value = Number.parseFloat(style === null || style === undefined || typeof style.getPropertyValue !== 'function' ? '' : style.getPropertyValue('--dsh-composer-height'))
				return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
			} catch (error) {
				return 0
			}
		}

		function measuredPaneHeight() {
			if (typeof document === 'undefined' || typeof document.querySelector !== 'function' || typeof window === 'undefined') return null
			let node = null
			try {
				node = document.querySelector('[data-team-ops-pane]')
			} catch (error) {
				return null
			}
			if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return null
			const box = node.getBoundingClientRect()
			if (box === null || box === undefined) return null
			const parent = node.parentElement
			const parentBottom =
				parent === null || parent === undefined || typeof parent.getBoundingClientRect !== 'function'
					? window.innerHeight
					: parent.getBoundingClientRect().bottom
			let container = null
			let scrollerNode = null
			try {
				const scroller = document.querySelector('[data-conversation-scroll]')
				scrollerNode = scroller
				if (scroller !== null && scroller !== undefined && typeof scroller.getBoundingClientRect === 'function') {
					const scrollBox = scroller.getBoundingClientRect()
					// **用滚动容器的内高（clientHeight），不用它的外框高**：外框高在某些主题/缩放含 padding 或边框，
					// 而 `clientHeight` 就是"能看见的那块高度"（也不含横向滚动条）。面板占的正是这块。
					const inner = typeof scroller.clientHeight === 'number' && scroller.clientHeight > 0 ? scroller.clientHeight : null
					if (scrollBox !== null && scrollBox !== undefined) {
						container = { top: scrollBox.top, height: inner === null ? scrollBox.height : inner }
					}
				}
			} catch (error) {
				container = null
			}
			// 两条定死的规矩：① 主体不许滑（留余量、以视口为上界）；② 列要铺满面板高度（基准必须由壳决定）。
			// 绝不把父元素底边算进来：父元素跟着内容长高，算进来量到的就是"当前内容多高"，面板会贴着内容缩。
			const byViewport = fillHeightFrom(box.top, window.innerHeight, window.innerHeight)
			const byShell = container !== null && container !== undefined
				? paneHeightFrom(container, box.top, parentBottom, window.innerHeight)
				: fillHeightFrom(box.top, parentBottom, window.innerHeight)
			// 不按"容器溢出多少"回退（那个读数混着别人撑出的溢出，照减会把面板缩矮）；
			// 口径：面板高度 = 容器内本栏以下可视高 − 余量（视口为上界）。输入区是滚动容器的子元素、`clientHeight` 包含它 ⇒ 无条件扣，用壳实测值。
			const composer = shellComposerHeight(scrollerNode)
			const candidate = Math.min(byShell, byViewport) - PANE_HEIGHT_MARGIN - composer
			return Math.max(160, Math.round(candidate))
		}

		/**
		 * 量到的面板高度（null = 量不到 ⇒ 走 CSS 里的兜底高度）。
		 * 挂载后量一次并逐帧补量几轮（容器可能比本栏晚定尺寸），之后跟窗口 resize。
		 */
		function usePaneHeight() {
			const [height, setHeight] = React.useState(null)
			React.useEffect(() => {
				let frame = 0
				let tries = 0
				const measure = () => {
					const next = measuredPaneHeight()
					setHeight((previous) => (previous === next ? previous : next))
				}
				measure()
				if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
					const tick = () => {
						frame = 0
						tries += 1
						measure()
						if (tries < 20) frame = window.requestAnimationFrame(tick)
					}
					frame = window.requestAnimationFrame(tick)
				}
				if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('resize', measure)
				// 别人改变输入区高度后要重量：壳用 ResizeObserver 把结果写进 `--dsh-composer-height`（写在滚动容器 style 上），
				// 所以这里盯两样：容器尺寸变化 + 容器 style 属性变化（只量"挂载后 20 帧 + resize"不够）。
				let resizeObserver = null
				let mutationObserver = null
				try {
					const scrollerNode = typeof document === 'undefined' || typeof document.querySelector !== 'function' ? null : document.querySelector('[data-conversation-scroll]')
					if (scrollerNode !== null && scrollerNode !== undefined) {
						if (typeof window.ResizeObserver === 'function') {
							resizeObserver = new window.ResizeObserver(measure)
							resizeObserver.observe(scrollerNode)
						}
						if (typeof window.MutationObserver === 'function') {
							mutationObserver = new window.MutationObserver(measure)
							mutationObserver.observe(scrollerNode, { attributes: true, attributeFilter: ['style'] })
						}
					}
				} catch (error) {
					// 观测不上也不许把面板搞崩：量高退回"挂载后量一次 + 窗口 resize"。
					resizeObserver = null
					mutationObserver = null
				}
				return () => {
					if (frame !== 0 && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
					if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('resize', measure)
					if (resizeObserver !== null && typeof resizeObserver.disconnect === 'function') resizeObserver.disconnect()
					if (mutationObserver !== null && typeof mutationObserver.disconnect === 'function') mutationObserver.disconnect()
				}
			}, [])
			return height
		}

		/**
		 * 成员卡的**编制三态词**：`member.status` 与这三个词逐字相等才认（设计 §2.1）。
		 * 枚举外的值**照显原文、不归并** —— 归并会把"文件里出现了一个没人认识的状态"这件事抹掉。
		 */
		// ── ⑨ 词表与分栏规格 ─────────────────────────────────────────────────
		/**
		 * 「成员」块的分档 chip：这样几枚**是筛选条件，不是一份划分** —— 各档条数各算各的，
		 * 加起来可以大于「全部」（一枚 chip 上的数只回答"按这一档筛能筛出几条"）。
		 *
		 * **只有三档**（task-40，人的决定）：`全部` / `协调者` / `已停用`。
		 * 从前那两档「在册 / 未入册」的判据只是"这一位在不在我们的旧名册文件 `.ops/members.json` 里"
		 * —— 那份文件早没人写（人机器上 0 行）⇒ 「在册」空着、**所有成员统统落进「未入册」**，语义正好相反；
		 * 那份旧账连同这两档一起撤掉，面板**不再读那个文件**。
		 * `已停用` 读的是**我们自己的真源**：载荷里每行的 `disabled`（来自工作区文件 `.ops/member-flags.json`，
		 * 就是「停用」那三个动词用的同一份），**不是**旧名册里的 `enabled` 历史字段。
		 */
		const MEMBER_STAGES = [
			{ key: 'all', label: '全部', match: () => true },
			{ key: 'lead', label: '协调者', match: (row) => text(row.kind) === 'lead' },
			{ key: 'disabled', label: '已停用', match: (row) => row.disabled === true },
		]
		/**
		 * 本会话团队任务板的**三栏**（原生 `task.status` 原样映射，不是把它的状态折进我们那五栏）。
		 *
		 * 两套制度的长相不一样，这里不发明映射表：原生是 `pending / in_progress / completed`
		 * （`deleted` 是墓碑，`listTasks` 不返回），我们是 待办 / 进行中 / 待验收 / 已完成 / 已打回。
		 * 所以这一栏顶部有"来源分档"：各按各的栏看，谁也不装作对方。
		 */
		const TEAM_TASK_COLUMNS = [
			{ key: 'pending', label: '待办' },
			{ key: 'in_progress', label: '进行中' },
			{ key: 'completed', label: '已完成' },
		]

		/**
		 * 「被阻塞」的判据：**自己还没完成，且至少一个依赖任务还没完成**。
		 *
		 * 与「有依赖」是**两件事**（人的口径：依赖是事实，阻塞是状态）：
		 *   · 有依赖 = `blockedBy` 非空 —— 声明过就是事实，依赖完成、任务完成都不会让它消失；
		 *   · 被阻塞 = 此刻依赖没完成 —— 依赖都完成后就不再是"被阻塞"。
		 * 原生只给了 `ready`（pending 且依赖全完成），没有单独的 blocked 字段 ⇒ 这里用同一份原生字段
		 * （`blockedBy` + 各条的 `status`）推一次；**只在这一处推**（筛选 chip、卡片 chip、浮窗共用）。
		 * 依赖的任务不在载荷里（被删 / 被截断 / 还没读到）⇒ 按"没完成"算（不假装已解除）。
		 * @param row - 原生任务行。
		 * @param statusById - 同载荷全部行的 `id → status`。
		 * @returns 是否被未完成的依赖卡住。
		 */
		const dependencyBlockedOf = (row, statusById) => {
			const blockedBy = Array.isArray(row.blockedBy) ? row.blockedBy : []
			if (blockedBy.length === 0) return false
			if (typeof row.status === 'string' && row.status === 'completed') return false
			const lookup = statusById !== null && statusById !== undefined && typeof statusById.get === 'function' ? statusById : null
			return blockedBy.some((id) => {
				const key = typeof id === 'string' ? id : String(id ?? '')
				const status = lookup === null ? undefined : lookup.get(key)
				return status !== 'completed'
			})
		}

		/**
		 * 「任务看板」块的分档 chip：**从原生给的字段里选得出来的那几档**（都是筛选条件，不是划分）。
		 *
		 * 判据来源：
		 *   · `可认领` 用原生的 `ready`（它自己算的"pending 且依赖都完成"）；
		 *   · `被阻塞` 用 `blockedBy` + 各条 `status` 推（见 `dependencyBlockedOf`，与「有依赖」区分）；
		 *   · `有依赖` 看 `blockedBy` 有没有内容（**事实**，与是否被卡住无关）；
		 *   · `写盘面重叠` 看原生给的 `writeScopeWarnings` 有没有内容（那是它的告警原文，不是我们算的重叠）。
		 * 原生载荷里**没有优先级、没有时间**（`/team-tasks` 返回的那几格就是全部）⇒ 卡上印不出来，
		 * 这件事写在块头那句注解里，不留白让人以为是没显示。
		 */
		const TEAM_TASK_STAGES = [
			{ key: 'all', label: '全部', match: () => true },
			{ key: 'ready', label: '可认领', match: (row) => row.ready === true },
			{ key: 'blocked', label: '被阻塞', match: (row, statusById) => dependencyBlockedOf(row, statusById) },
			{ key: 'depends', label: '有依赖', match: (row) => Array.isArray(row.blockedBy) && row.blockedBy.length > 0 },
			{ key: 'overlap', label: '写盘面重叠', match: (row) => Array.isArray(row.writeScopeWarnings) && row.writeScopeWarnings.length > 0 },
		]

		/**
		 * 运行时状态（**内置 Agent Teams 名册那一份**，与 `list_agents` 同源）的中文说法。
		 * `inactive` 也不等于"空闲可派"，所以词面用「无轮次」——与内置工具的回执同一套说法。
		 */
		const MEMBER_RUNTIME_WORDS = { running: '跑着', inactive: '无轮次', provisioning: '创建中', failed: '失败' }
		/**
		 * 技能来源（宿主注册表给的 `source` 键）的中文说法。
		 *
		 * **这只是给人看的标签**：判定与分组一律用端点原样给的 `source`（卡片上还留着
		 * `data-skill-source` 与浮窗里的原文），所以这份表即使将来少一档，也只是回落成原文、
		 * 不会把两种来源混成一种。
		 */
		const SKILL_SOURCE_WORDS = {
			'project-dsh': '项目 .dsh/skills',
			'project-agents': '项目 .agents/skills',
			custom: '自定义目录',
			'user-dsh': '用户 ~/.dsh/skills',
			'user-agents': '用户 ~/.agents/skills',
			bundled: '随包目录',
			runtime: '运行时注册',
		}

		// ── ⑩ 状态视图与任务板 ────────────────────────────────────────────────
		/**
		 * 面板的「最后在哪一块」记录（设计 3.1）。存储不可用（隐私模式 / 自检环境）时**静默回落成员块**。
		 * 键 = `dsh-team-ops:panel-tab`，值 = `{ [scope]: ledger }`，按最近使用保留最多 8 个 scope。
		 */
		const PANEL_TAB_KEY = 'dsh-team-ops:panel-tab'
		const PANEL_TAB_MAX = 8
		const panelStorageOf = () => {
			try {
				return typeof sessionStorage === 'undefined' || sessionStorage === null ? null : sessionStorage
			} catch {
				return null
			}
		}
		const panelTabLedgers = () => BLOCKS.map((block) => block.ledger)
		const readPanelTabs = () => {
			const storage = panelStorageOf()
			if (storage === null) return {}
			try {
				const raw = storage.getItem(PANEL_TAB_KEY)
				if (typeof raw !== 'string' || raw === '') return {}
				const parsed = JSON.parse(raw)
				return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
			} catch {
				return {}
			}
		}
		const writePanelTab = (scope, ledger) => {
			const storage = panelStorageOf()
			if (storage === null) return
			try {
				const map = readPanelTabs()
				delete map[scope]
				map[scope] = ledger
				// 淘汰按"最久没用过的那个 scope"：对象键序就是插入序，删最前面那个即可。
				const keys = Object.keys(map)
				while (keys.length > PANEL_TAB_MAX) delete map[keys.shift()]
				storage.setItem(PANEL_TAB_KEY, JSON.stringify(map))
			} catch {
				/* 存不进去只影响"下次打开恢复上次块"，不影响这一次 */
			}
		}
		/**
		 * 当前块 + 恢复逻辑：`scope` = `workspace + '|' + teamSessionId`（换会话 / 换工作区就换 scope）。
		 * @param scope - 作用域串。
		 * @returns `[ledger, setLedger]`。
		 */
		function usePanelTab(scope) {
			const [ledger, setLedgerState] = React.useState(() => {
				const saved = readPanelTabs()[scope]
				return panelTabLedgers().includes(saved) ? saved : BLOCKS[0].ledger
			})
			/**
			 * 切块：**先写记录再改 state**（写失败也不拦着切）。
			 * @param next - 目标块的 ledger。
			 */
			const setLedger = (next) => {
				const target = panelTabLedgers().includes(next) ? next : BLOCKS[0].ledger
				writePanelTab(scope, target)
				setLedgerState(target)
			}
			return [ledger, setLedger]
		}

		/**
		 * 浮窗可达性的**唯一一份**：Esc 关、Tab 圈闭、打开时聚焦（优先 `[data-autofocus]`）、关闭后把焦点还给触发者。
		 *
		 * `useDetailModal` 是它的薄封装：详情浮窗自带 ↑↓←→，那套 keydown 仍留在 `useDetailModal`
		 * （`keyboard:false`）—— 两份 keydown 会互相盖掉（自检的假 document 只有一个槽位，真浏览器里也会重复处理）。
		 * @param open - 开着吗。
		 * @param onClose - 关它。
		 * @param options - `{ keyboard: false }` = 键盘监听不在这里装（详情浮窗用）。
		 * @returns 浮窗元素的 ref（元素自己 `tabIndex=-1`，因而可编程聚焦）。
		 */
		function useModalA11y(open, onClose, options) {
			const keyboard = options === undefined || options === null || options.keyboard !== false
			const modalRef = React.useRef(null)
			const restoreRef = React.useRef(null)
			// 回调每次渲染都换新函数 ⇒ 放进 ref 里用"当前那一份"。
			const closeRef = React.useRef(onClose)
			closeRef.current = onClose
			React.useEffect(() => {
				if (open !== true) {
					const back = restoreRef.current
					restoreRef.current = null
					try {
						if (back !== null && back !== undefined && back.isConnected !== false && typeof back.focus === 'function') back.focus()
					} catch {}
					return
				}
				// **打开前焦点在哪**（= 触发它的那个控件）：关闭时还回去。
				if (restoreRef.current === null) {
					try {
						const active = typeof document === 'undefined' || document === null ? null : document.activeElement
						if (active !== null && active !== undefined && active !== modalRef.current) restoreRef.current = active
					} catch {
						/* 读不到 activeElement 就不记：关闭时不还焦点，比还错地方好 */
					}
				}
				const node = modalRef.current
				if (node === null || node === undefined) return
				let target = node
				try {
					const preferred = typeof node.querySelector === 'function' ? node.querySelector('[data-autofocus]') : null
					if (preferred !== null && preferred !== undefined) target = preferred
				} catch {}
				try {
					if (typeof target.focus === 'function') target.focus()
				} catch {}
			}, [open])
			React.useEffect(() => {
				if (open !== true || keyboard !== true) return () => {}
				if (typeof document === 'undefined' || document === null || typeof document.addEventListener !== 'function') return () => {}
				const onKey = (event) => {
					if (event === null || event === undefined) return
					if (event.key === 'Escape') {
						if (typeof event.preventDefault === 'function') event.preventDefault()
						try {
							closeRef.current?.()
						} catch {
							/* 关闭回调自己抛也不许把键盘路径搞坏 */
						}
						return
					}
					if (event.key === 'Tab') trapTab(event, modalRef.current)
				}
				document.addEventListener('keydown', onKey)
				return () => document.removeEventListener('keydown', onKey)
			}, [open, keyboard])
			return modalRef
		}

		/**
		 * 统一回执条（设计 ⑥.1 / ⑩）：成功 `role="status"`、失败 `role="alert"`，并带
		 * `data-notice-slot` / `data-notice-tone`（qa 用同一套选择器判）。**失败可手动关闭**。
		 * @param props - `{ slot, tone, lines, onRetry, onClose }`；`tone` 为 null 时不渲染。
		 * @returns 节点或 null。
		 */
		function NoticeBar(props) {
			if (props.tone === null || props.tone === undefined) return null
			const isError = props.tone === 'error'
			const lines = Array.isArray(props.lines) ? props.lines : []
			return el(
				'div',
				{
					className: 'cbv-notice cbv-notice--' + (isError ? 'error' : 'ok') + ' cbv-notice--slot',
					role: isError ? 'alert' : 'status',
					'aria-live': isError ? 'assertive' : 'polite',
					'aria-atomic': 'true',
					'data-notice-slot': props.slot,
					'data-notice-tone': isError ? 'error' : 'ok',
				},
				el(
					'div',
					{ className: 'cbv-notice-body', key: 'lines' },
					lines.map((line, index) => el('div', { className: 'cbv-md', key: 'l' + index }, markdownNodes(line, props.slot + '-notice' + index))),
				),
				typeof props.onRetry === 'function'
					? el('button', { className: 'cbv-btn cbv-notice-btn', key: 'retry', type: 'button', 'data-notice-retry': '', onClick: () => props.onRetry() }, '重试')
					: null,
				typeof props.onClearFilters === 'function'
					? el('button', { className: 'cbv-btn cbv-notice-btn', key: 'clear', type: 'button', 'data-notice-clear': '', onClick: () => props.onClearFilters() }, '清除筛选')
					: null,
				isError && typeof props.onClose === 'function'
					? el('button', { className: 'cbv-btn cbv-notice-btn', key: 'close', type: 'button', 'data-notice-close': '', onClick: () => props.onClose() }, '关闭')
					: null,
			)
		}

		/**
		 * 通用确认浮窗（设计 ⑥.2）：标题 + 正文 + 动词主按钮；默认焦点在「取消」，Esc 关。
		 * **只在确认后由调用方发请求** —— 取消不产生任何网络动作。
		 * @param props - `{ open, slot, title, lines, confirmLabel, danger, busy, error, onConfirm, onCancel }`。
		 * @returns 节点或 null。
		 */
		function ConfirmDialog(props) {
			const open = props.open === true
			const busy = props.busy === true
			const cancel = () => {
				if (busy) return
				if (typeof props.onCancel === 'function') props.onCancel()
			}
			const modalRef = useModalA11y(open, cancel)
			if (!open) return null
			const lines = Array.isArray(props.lines) ? props.lines : []
			return el(
				'div',
				{ className: 'cbv-overlay', key: 'confirm-overlay', onClick: cancel },
				el(
					'div',
					{
						className: 'cbv-modal cbv-modal--confirm' + (props.danger === true ? ' cbv-modal--danger' : ''),
						key: 'confirm-modal',
						onClick: (event) => event.stopPropagation(),
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': props.title,
						ref: modalRef,
						tabIndex: -1,
						'data-confirm-dialog': props.slot,
					},
					el(
						'div',
						{ className: 'cbv-modal-body', key: 'body' },
						el('div', { className: 'cbv-confirm-title', key: 'title' }, props.title),
						lines.map((line, index) => el('div', { className: 'cbv-confirm-line cbv-md', key: 'l' + index }, markdownNodes(line, 'confirm-' + index))),
						props.error === undefined || props.error === null || props.error === ''
							? null
							: el('div', { className: 'cbv-note cbv-note--danger', key: 'error', 'data-confirm-error': '' }, props.error),
					),
					el(
						'div',
						{ className: 'cbv-modal-actions cbv-confirm-actions', key: 'actions' },
						el('button', { className: 'cbv-btn', key: 'cancel', type: 'button', 'data-autofocus': '', 'data-confirm-cancel': '', disabled: busy, onClick: cancel }, '取消'),
						el(
							'button',
							{
								// 与「取消」同一套底样式；破坏性动作才加 `--bad`（上一轮人的口径：弹窗按钮不搞主按钮强调）。
								className: 'cbv-btn' + (props.danger === true ? ' cbv-btn--bad' : ''),
								key: 'go',
								type: 'button',
								'data-confirm-go': '',
								disabled: busy,
								onClick: () => {
									if (busy) return
									if (typeof props.onConfirm === 'function') props.onConfirm()
								},
							},
							busy ? (props.busyLabel === undefined ? '处理中…' : props.busyLabel) : props.confirmLabel,
						),
					),
				),
			)
		}

		/** 骨架卡（静态灰块，不做 shimmer；`aria-hidden`，读屏只听容器里那句「正在读取…」）。 */
		const skeletonCardsOf = (count) =>
			Array.from({ length: count }, (_, index) =>
				el(
					'div',
					{ className: 'cbv-box cbv-skel', key: 'sk' + index, 'aria-hidden': 'true' },
					el(
						'div',
						{ className: 'cbv-skel-top', key: 'top' },
						el('span', { className: 'cbv-skel-avatar', key: 'av' }),
						el(
							'div',
							{ className: 'cbv-skel-lines', key: 'lines' },
							el('span', { className: 'cbv-skel-line cbv-skel-line--title', key: 't' }),
							el('span', { className: 'cbv-skel-line', key: 's' }),
						),
					),
					el('span', { className: 'cbv-skel-line cbv-skel-line--body', key: 'body' }),
					el('span', { className: 'cbv-skel-line cbv-skel-line--bar', key: 'bar' }),
				),
			)
		/**
		 * 列表块的骨架（成员 / 角色 / 技能共用）：固定 3 张，外层 `aria-busy`。
		 * @param props - `{ kind, label, count }`。
		 * @returns 节点。
		 */
		function SkeletonList(props) {
			const count = typeof props.count === 'number' ? props.count : 3
			return el(
				'div',
				{ className: 'cbv-skel-block', 'data-skeleton': props.kind, 'aria-busy': 'true' },
				el('span', { className: 'cbv-sr-only', key: 'say' }, props.label),
				el('div', { className: 'cbv-mp-grid', key: 'grid' }, skeletonCardsOf(count)),
			)
		}
		/**
		 * 骨架延迟出现（设计 5.3：120ms 内完成就直接出内容，避免一闪）。
		 * @param active - 是否处于加载态。
		 * @returns 是否该画骨架。
		 */
		function useSkeletonVisible(active) {
			const [visible, setVisible] = React.useState(false)
			React.useEffect(() => {
				if (active !== true) {
					setVisible(false)
					return () => {}
				}
				const timer = setTimeout(() => setVisible(true), 120)
				return () => clearTimeout(timer)
			}, [active])
			return active === true && visible === true
		}

		/**
		 * 块切换那一排（设计 3.5 / ⑩ `PanelTabs`）：`role="tablist"` + `role="tab"` + `aria-selected`，
		 * roving `tabIndex`（选中项 0、其余 -1），`←/→` 循环、`Home/End` 到首尾。
		 * `data-pane-block` 保持不变（qa 的选择器不受影响）。
		 * @param props - `{ active, onSelect }`。
		 * @returns 节点。
		 */
		function PanelTabs(props) {
			const focusTab = (ledger) => {
				try {
					if (typeof document === 'undefined' || document === null || typeof document.querySelector !== 'function') return
					const button = document.querySelector('[data-pane-block="' + ledger + '"]')
					if (button !== null && button !== undefined && typeof button.focus === 'function') button.focus()
				} catch {}
			}
			const onKeyDown = (event, index) => {
				if (event === null || event === undefined) return
				const key = event.key
				let next = -1
				if (key === 'ArrowRight') next = (index + 1) % BLOCKS.length
				else if (key === 'ArrowLeft') next = (index - 1 + BLOCKS.length) % BLOCKS.length
				else if (key === 'Home') next = 0
				else if (key === 'End') next = BLOCKS.length - 1
				if (next < 0) return
				if (typeof event.preventDefault === 'function') event.preventDefault()
				const block = BLOCKS[next]
				props.onSelect(block.ledger)
				focusTab(block.ledger)
			}
			return el(
				'span',
				{ className: 'cbv-tabs', key: 'tabs', role: 'tablist', 'aria-label': '团队状态分块' },
				BLOCKS.map((block, index) =>
					el(
						'button',
						{
							key: block.ledger,
							id: 'cbv-tab-' + block.ledger,
							className: 'cbv-btn cbv-tab' + (props.active === block.ledger ? ' cbv-tab--on' : ''),
							type: 'button',
							role: 'tab',
							'aria-selected': props.active === block.ledger ? 'true' : 'false',
							'aria-controls': block.panelId,
							// roving tabindex：Tab 只停一次（停在当前选中的那一枚）。
							tabIndex: props.active === block.ledger ? 0 : -1,
							// 块名落在 `data-` 上（不挂 title）：核对/自检按 `data-pane-block` 找这几个按钮。
							'data-pane-block': block.ledger,
							style:
								props.active === block.ledger
									? { borderColor: 'transparent', background: 'var(--cbv-a3)', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 }
									: undefined,
							onClick: () => props.onSelect(block.ledger),
							onKeyDown: (event) => onKeyDown(event, index),
						},
						block.label,
					),
				),
			)
		}

		/**
		 * 「团队状态」那一栏的外壳：**只负责作用域**（工作区 + 根会话）。
		 *
		 * `key={scope}` 包一层 `PanelBody`：换会话 / 换工作区时整块重挂（筛选、滚动、弹窗归零），
		 * 同一 scope 内切块则**不重挂**（看的是同一批数据、人停在同一个上下文里）。
		 * @param props - 席位 props（`sessions` / `slots`）。
		 * @returns 面板。
		 */
		function StatusView(props) {
			useComposerHidden(props.slots === undefined ? null : props.slots)
			const store = props.sessions === undefined ? null : typeof props.sessions === 'function' ? props.sessions() : props.sessions
			const workspace = useCurrentWorkspace(store)
			const sessionId = useCurrentSessionId(store)
			// 团队状态挂在**根会话**上（子智能体对话里点开面板也要读得到领队那一份）。
			const teamSessionId = teamSessionIdOf(store, sessionId)
			const scope = workspace + '|' + teamSessionId
			return el(PanelBody, { key: scope, sessions: props.sessions, slots: props.slots, workspace, sessionId, teamSessionId, scope })
		}

		/**
		 * 面板本体：块切换 + 首屏状态 + **保活渲染**（设计 3.3）。
		 *
		 * 首次激活某块才挂载；挂载后**不卸载**，用 `hidden` 隐藏（非当前块 `aria-hidden` 不是必须 —— `hidden` 已足够）。
		 * 只有当前块 `active=true`，各块取数 effect 只在 `active` 为真时跑 ⇒ 非当前块不因窗口 focus 重复取数。
		 * @param props - `{ sessions, slots, workspace, sessionId, teamSessionId, scope }`（由 `StatusView` 给）。
		 * @returns 面板。
		 */
		function PanelBody(props) {
			const workspace = props.workspace
			const teamSessionId = props.teamSessionId
			const scope = props.scope
			// **拼参数用同一套**（`paneQueryOf`）：`/status` 在拿不到工作区时会**按会话**回落推断。
			const target = STATUS_ENDPOINT + paneQueryOf(workspace, teamSessionId)
			const [tab, setTab] = usePanelTab(scope)
			// 已挂载（保活）的块：首次激活才加入，之后不删。
			const [visited, setVisited] = React.useState(() => [tab])
			const [tick, setTick] = React.useState(0)
			const [snapshot, setSnapshot] = React.useState({ phase: 'loading' })
			const [notice, setNotice] = React.useState(null)
			const paneFill = usePaneHeight()
			/** 切块：**块本身不卸载**，只换哪一块 active。 */
			const selectTab = (ledger) => {
				setTab(ledger)
				setVisited((list) => (list.includes(ledger) ? list : [...list, ledger]))
			}
			// 从存储恢复出来的块也要进 visited（首帧就渲染它）。
			React.useEffect(() => {
				setVisited((list) => (list.includes(tab) ? list : [...list, tab]))
			}, [tab])

			/**
			 * **重读的触发**（这里没有「刷新」按钮）：窗口重新获得焦点、面板重新可见，两条都只 `+1`。
			 */
			React.useEffect(() => {
				const bump = () => {
					invalidatePanes()
					setTick((value) => value + 1)
				}
				const onVisible = () => {
					try {
						if (typeof document !== 'undefined' && document !== null && document.visibilityState !== undefined && document.visibilityState !== 'visible') return
					} catch {
						/* 读不到可见性就当它可见（宁可多取一次） */
					}
					bump()
				}
				const offs = []
				try {
					if (typeof window !== 'undefined' && window !== null && typeof window.addEventListener === 'function') {
						window.addEventListener('focus', bump)
						offs.push(() => window.removeEventListener('focus', bump))
					}
					if (typeof document !== 'undefined' && document !== null && typeof document.addEventListener === 'function') {
						document.addEventListener('visibilitychange', onVisible)
						offs.push(() => document.removeEventListener('visibilitychange', onVisible))
					}
				} catch {
					/* 环境不认这两个事件就算（面板其余部分照常） */
				}
				return () => {
					for (const off of offs) {
						try {
							off()
						} catch {
							/* 卸载时的失败不影响别的 */
						}
					}
				}
			}, [])

			/**
			 * **切到新会话/新工作区时并行预取**三个读端点（成员 / 技能 / 任务看板）。
			 */
			React.useEffect(() => {
				if (typeof fetch !== 'function' || workspace === '') return undefined
				const teamQuery = paneQueryOf(workspace, teamSessionId)
				for (const endpoint of [MEMBERS_ENDPOINT, SKILLS_ENDPOINT, TEAM_TASKS_ENDPOINT]) {
					try {
						void getJsonCached(endpoint + teamQuery, { force: true }).catch(() => null)
					} catch {
						/* 预取失败不影响任何东西：真正需要时各块自己会再拉一次 */
					}
				}
				return undefined
			}, [workspace, teamSessionId])

			React.useEffect(() => {
				let cancelled = false
				if (typeof fetch !== 'function') {
					setSnapshot({ phase: 'error', error: '当前环境没有 fetch' })
					return () => {}
				}
				getJsonCached(target)
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						if (cancelled) return
						if (payload === null) {
							setSnapshot({ phase: 'error', error: 'HTTP ' + response.status + '：响应不是 JSON' })
							return
						}
						if (payload.ok === true) {
							setSnapshot({ phase: 'ready', data: payload })
							return
						}
						setSnapshot({ phase: 'error', error: typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status })
					})
					.catch((error) => {
						if (cancelled) return
						setSnapshot({ phase: 'error', error: '' + error })
					})
				return () => {
					cancelled = true
				}
			}, [tick, target])

			const data = snapshot.phase === 'ready' ? snapshot.data : null
			// 首屏读失败时给一枚「重读」（宿主刚重启那会儿可恢复）。
			const head =
				snapshot.phase === 'error'
					? el(
							'div',
							{ style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, fontSize: '14px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
							'读不到状态：' + snapshot.error,
							el(
								'button',
								{ className: 'cbv-btn', key: 'retry', type: 'button', 'data-pane-retry': 'status', onClick: () => { invalidatePanes(); setTick((value) => value + 1) } },
								'重读',
							),
						)
					: null

			const statusSource = data === null ? '' : text(data.source)
			const sourceNote =
				statusSource === '' || statusSource === 'native'
					? null
					: el(
							'div',
							{ className: 'cbv-pane-note cbv-md', key: 'status-source', 'data-status-source': statusSource },
							markdownNodes(text(data.sourceLine) === '' ? '状态读的是遗留文件，以原生账为准。' : text(data.sourceLine), 'status-source'),
						)

			// 顶栏一行到底：块切换 | 动作 | 工作区完整路径（不单独占行）。
			const target_ = data === null ? '' : typeof data.docsPath === 'string' ? data.docsPath : typeof data.workspace === 'string' ? data.workspace : ''
			const projectLabel = target_ === '' ? '项目路径' : target_
			const projectTitle = target_ === '' ? '这个工作区的路径还没取到' : '点开：' + target_ + '（主进程开本地目录；开不了就只把路径复制给你）'
			const openProject = () => {
				if (target_ === '') {
					setNotice('还没取到项目路径')
					return
				}
				const copy = () => {
					try {
						const nav = typeof navigator === 'undefined' ? undefined : navigator
						if (nav !== undefined && nav.clipboard !== undefined && typeof nav.clipboard.writeText === 'function') {
							nav.clipboard.writeText(target_).then(
								() => setNotice('已复制路径：' + target_),
								() => setNotice('路径：' + target_),
							)
							return
						}
					} catch {}
					setNotice('路径：' + target_)
				}
				if (typeof fetch !== 'function') {
					copy()
					return
				}
				const url = OPEN_ENDPOINT + (workspace === '' ? '' : '?workspace=' + encodeURIComponent(workspace))
				fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({ path: target_ }),
				})
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ payload }) => {
						if (payload !== null && payload.ok === true) {
							setNotice('已在本机打开：' + target_)
							return
						}
						const why = payload === null || typeof payload.error !== 'string' ? '主进程没能打开' : payload.error
						setNotice(why + ' —— 已复制路径')
						copy()
					})
					.catch(() => {
						setNotice('主进程没能打开 —— 已复制路径')
						copy()
					})
			}
			const actions = el(
				'div',
				{ className: 'cbv-toolbar-main', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', flex: 'none' } },
				el(PanelTabs, { active: tab, onSelect: selectTab }),
				// 工作区按钮压尾（块切换 → 动作 → 工作区）。
				el('button', { className: 'cbv-btn', type: 'button', title: projectTitle, onClick: openProject }, projectLabel),
				notice === null ? null : el('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' } }, notice),
			)

			/** 某一块的节点（只有当前块 `active`；其余保持挂载但 hidden）。 */
			const contentOf = (block) => {
				const active = block.ledger === tab
				if (block.ledger === 'members') return el(MembersView, { sessions: props.sessions, reload: tick, active })
				if (block.ledger === 'roles') return el(RolesView, { sessions: props.sessions, reload: tick, active })
				if (block.ledger === 'skills') return el(SkillsView, { sessions: props.sessions, reload: tick, active })
				if (block.ledger === 'board') return el(TaskBoardView, { sessions: props.sessions, slots: props.slots, reload: tick, active })
				return el(LedgerView, { spec: block.spec, sessions: props.sessions, slots: props.slots, hideComposer: false, showHeader: false, reload: tick, active })
			}
			const panelOf = (block) => {
				const active = block.ledger === tab
				return el(
					'div',
					{
						key: block.ledger,
						id: block.panelId,
						className: 'cbv-block-panel',
						role: 'tabpanel',
						'aria-labelledby': 'cbv-tab-' + block.ledger,
						tabIndex: active ? 0 : -1,
						// `hidden` 负责"看不见也 Tab 不到"；CSS 里还有一条 `[hidden]{display:none}` 兜底。
						hidden: active ? undefined : true,
						'data-panel-block': block.ledger,
						'data-panel-active': active ? 'true' : 'false',
					},
					contentOf(block),
				)
			}
			// `visited` 存的是 ledger 字符串；渲染时要换回块对象（保持"已挂载顺序"）。
			const mountedLedgers = visited.includes(tab) ? visited : [...visited, tab]
			const mountedBlocks = mountedLedgers.map((ledger) => BLOCKS.find((block) => block.ledger === ledger)).filter((block) => block !== undefined)

			return el(
				'div',
				{
					className: 'cbv-root',
					'data-team-ops-pane': '',
					'data-pane-mark': PANE_MARK,
					// 块壳的机器可核标记（设计 5.4）：当前块 / 作用域 / 已挂载块列表。
					'data-panel-tab': tab,
					'data-panel-scope': scope,
					'data-panel-visiting': mountedLedgers.join(' '),
					style: paneFill === null ? undefined : { height: paneFill + 'px' },
				},
				head,
				sourceNote,
				actions,
				el('div', { className: 'cbv-panels', key: 'panels', style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: '0' } }, mountedBlocks.map(panelOf)),
			)
		}

		/**
		 * 一条条目**属于哪一栏**（浮窗标题用）：按 `field`（缺省 `phase`）在分栏表里找它那一栏的标签。
		 *
		 * 为什么要印在浮窗标题里：`← →` 是"切换分栏"，而浮窗正文只有那一张卡 —— 不写栏名的话，
		 * "换了一栏"与"栏内翻了一条"看起来一模一样（现场就是这么把它误判成翻页的）。
		 * @param columns - 分栏表（`{ key, label, items }`）。
		 * @param item - 当前那一条。
		 * @param field - 分栏键取自条目的哪个字段（缺省 `phase`；团队那一档是 `status`）。
		 * @returns 栏名；认不出返回空串（那就只印编号，不臆造）。
		 */
		const labelOfColumn = (columns, item, field) => {
			if (!Array.isArray(columns) || item === null || item === undefined) return ''
			const key = text(item[field === undefined ? 'phase' : field])
			for (const column of columns) {
				if (text(column.key) === key) return text(column.label)
			}
			return ''
		}

		/**
		 * 详情浮窗的键盘 / 焦点行为 —— 三块文件**共用同一份**：
		 * Esc 关、**↑ ↓ 在本栏内翻页**（与那两个按钮同一件事）、**← → 切换分栏**（人的指定：
		 * 上下管"这一栏里的下一条"，左右管"换一栏"）、打开后焦点移进浮窗（键盘用户不必从头 Tab）、
		 * **关掉之后把焦点还给打开它的那张卡**、**Tab 圈在浮窗内**（浮窗是 `aria-modal` 的，
		 * 焦点跑到遮罩后面的列表上就等于"用键盘摸到了一屏看不见的东西"）。
		 * @param detail - 当前打开的条目（null = 关着）。
		 * @param onClose - 关闭（Esc）。
		 * @param onStep - 栏内翻页 ±1（两个按钮用）。
		 * @param onColumnStep - **切换分栏** ±1（← → 用）；不给就退回 `onStep`，行为与从前一致。
		 * @returns 浮窗元素要挂的 ref（元素自己 `tabIndex=-1`，因而可编程聚焦）。
		 */
		function useDetailModal(detail, onClose, onStep, onColumnStep) {
			const modalRef = React.useRef(null)
			// 焦点圈闭 / Esc 归还焦点：与其余浮窗**共用同一份**（`useModalA11y`）。
			// 键盘监听仍在这一处装（详情浮窗自带 ↑↓←→，`keyboard:false` 避免两份 keydown 打架）。
			const a11yRef = useModalA11y(detail !== null, onClose, { keyboard: false })
			modalRef.current = a11yRef.current
			// 回调每次渲染都换新函数 ⇒ 放进 ref 里用"当前那一份"，免得把它们写进依赖后每轮都重挂监听。
			const handlers = React.useRef({ onStep, onClose, onColumnStep })
			handlers.current = { onStep, onClose, onColumnStep }
			React.useEffect(() => {
				if (detail === null) return () => {}
				if (typeof document === 'undefined' || document === null || typeof document.addEventListener !== 'function') return () => {}
				const onKey = (event) => {
					if (event === null || event === undefined) return
					if (event.key === 'Escape') handlers.current.onClose()
					// **↑ ↓ = 本栏内翻页**（与那两个按钮同一件事），**← → = 切换分栏**（跨栏走一格）。
					else if (event.key === 'ArrowUp') handlers.current.onStep(-1)
					else if (event.key === 'ArrowDown') handlers.current.onStep(1)
					else if (event.key === 'ArrowLeft') (handlers.current.onColumnStep ?? handlers.current.onStep)(-1)
					else if (event.key === 'ArrowRight') (handlers.current.onColumnStep ?? handlers.current.onStep)(1)
					else if (event.key === 'Tab') trapTab(event, modalRef.current)
				}
				document.addEventListener('keydown', onKey)
				return () => document.removeEventListener('keydown', onKey)
			}, [detail])
			return modalRef
		}

		/**
		 * 把 Tab 圈在浮窗内：焦点在**最后一个**可聚焦元素上再按 Tab ⇒ 回第一个（Shift+Tab 反向同理）。
		 *
		 * 为什么要自己圈：浮窗是 `aria-modal="true"` 的，而遮罩后面的列表没有被 `inert` 掉 ——
		 * 不圈的话 Tab 会跑到看不见的卡片上。可聚焦元素按浮窗当前那一份 DOM 现查（浮窗里翻页会换内容）。
		 * @param event - `keydown` 事件（可能带 `shiftKey`）。
		 * @param node - 浮窗元素（`modalRef.current`）；不是元素时什么都不做。
		 */
		const trapTab = (event, node) => {
			try {
				if (node === null || node === undefined || typeof node.querySelectorAll !== 'function') return
				const all = Array.from(node.querySelectorAll('button,[href],input,select,textarea,[tabindex]'))
				const focusables = all.filter((el) => el.tabIndex >= 0 && el.disabled !== true)
				if (focusables.length === 0) return
				const first = focusables[0]
				const last = focusables[focusables.length - 1]
				const active = typeof document === 'undefined' || document === null ? null : document.activeElement
				const inside = active !== null && active !== undefined && typeof node.contains === 'function' && node.contains(active)
				if (event.shiftKey === true) {
					if (!inside || active === first) {
						event.preventDefault()
						last.focus()
					}
					return
				}
				if (!inside || active === last) {
					event.preventDefault()
					first.focus()
				}
			} catch {
				/* 圈不住也不许把浮窗搞坏：按键照原样走 */
			}
		}

		/**
		 * 详情浮窗本体 —— 三块文件**共用同一份**（同一套遮罩、表头、翻页与正文渲染）。
		 *
		 * 写成**普通函数**（不是组件）是有意的：调用方把它内联进自己的渲染树，产出的节点与
		 * "各写一遍这段 markup"完全一致，而实现只有一处。
		 * @param spec - 这一条属于哪份文件（决定正文用哪张卡片）。
		 * @param item - 正在看的那一条。
		 * @param pool - 可翻页的那一组（= 该项所在那一栏，不跨栏）。
		 * @param index - 这一条在 pool 里的下标（-1 = 不在其中，两个翻页按钮都不可点）。
		 * @param onStep - 翻页 ±1。
		 * @param onClose - 关闭。
		 * @param modalRef - 浮窗元素的 ref（见 useDetailModal）。
		 * @returns 浮窗节点。
		 */
		const detailOverlayOf = (spec, item, pool, index, onStep, onClose, modalRef, groupLabel) => {
			const ledger = spec === undefined || spec === null ? '' : spec.ledger
			const ordered = Array.isArray(pool) ? pool : []
			return el(
				'div',
				{ className: 'cbv-overlay', key: 'overlay', onClick: onClose },
				el(
					'div',
					{
						className: 'cbv-modal',
						onClick: (event) => event.stopPropagation(),
						ref: modalRef,
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': (text(item.id) || '条目') + ' 详情',
						tabIndex: -1,
					},
					el(
						'div',
						{ className: 'cbv-modal-head', key: 'head' },
						// 标题占满左侧，三个操作按钮聚在右上角：翻页与关闭在同一处，手不用来回找。
						el(
							'span',
							{ className: 'cbv-modal-title', key: 'title' },
							// **带上"是哪一栏"**（换栏这件事得看得见 —— 否则 ← → 看起来跟翻页一样），
							// 再给「栏内第几条」。不给总数：翻页不跨栏，递一个跨栏总数会误导成还有别处可翻。
							(groupLabel === undefined || groupLabel === '' ? '' : groupLabel + '　·　') +
								(text(item.id) || '(无编号)') +
								(index < 0 ? '' : '　第 ' + (index + 1) + ' 条'),
						),
						el(
							'div',
							{ className: 'cbv-modal-actions', key: 'actions' },
							// 键盘只在**浮窗开着**时生效（人的指令：这句原来写在看板底部，而那儿按了没反应）⇒
							// 提示就写在浮窗里、紧挨着那几个按钮，看板底部不再重复。
							el('span', { className: 'cbv-modal-keys', key: 'keys' }, inlineNodes('`↑ ↓` 本栏内翻页 · `← →` 切换分栏 · `Esc` 关', 'keys')),
							el('button', { className: 'cbv-btn', key: 'prev', type: 'button', disabled: index <= 0, onClick: () => onStep(-1) }, '上一条'),
							el('button', { className: 'cbv-btn', key: 'next', type: 'button', disabled: index < 0 || index >= ordered.length - 1, onClick: () => onStep(1) }, '下一条'),
							el('button', { className: 'cbv-btn', key: 'close', type: 'button', onClick: onClose }, '关闭'),
						),
					),
					el('div', { className: 'cbv-modal-body', key: 'body' }, CARDS[ledger](item, true, () => {}, 'modal#' + text(item.id))),
				),
			)
		}


		/**
		 * 「任务看板」块：**只有一档** —— 本会话 Agent Teams 的共享任务板（原生三栏）。
		 *
		 * 这一块从前有两个来源（本插件那份工作区看板 + 原生任务板），界面上靠"来源分档"切；
		 * 本插件那份看板文件**没有写入者了**（任务在原生那本账上），所以分档与那一档的视图
		 * （按 `phase` 的里程碑视图）都已撤掉 —— 留一半会让人以为"板子是空的"。
		 * **本文件不发明映射表**：原生是 `pending / in_progress / completed`，面板照它的三档画，
		 * 不把 `in_progress` 折成我们的"待验收"。
		 *
		 * 筛选**只从原生给的字段里选档**（可认领 / 被阻塞 / 有依赖 / 写盘面重叠 + 一栏搜索）。
		 * 「被阻塞」与「有依赖」是**两件事**（人的口径）：有依赖是事实（`blockedBy` 非空，完成也在），
		 * 被阻塞是状态（依赖没完成）；原生只给 `ready`、没有 blocked 字段 ⇒ 用同一份原生字段推一次，
		 * 判定只住 `dependencyBlockedOf` 一处（见 09-words）。原生没有优先级与时间字段 ⇒ 卡上印不出来。
		 *
		 * 这一档**只读**：认领 / 完成 / 改依赖 / 改归属都是 `team_task_*` 那套会话工具的活
		 * （CAS + 授权 + 留痕的完整事务），面板只把**同一份视图**摆出来。
		 * @param props - 与其余块一样：`sessions` / `slots` / `reload`（面板的重读计数）。
		 */
		function TaskBoardView(props) {
			const active = props.active !== false
			const store = props.sessions === undefined ? null : typeof props.sessions === 'function' ? props.sessions() : props.sessions
			const workspace = useCurrentWorkspace(store)
			const sessionId = useCurrentSessionId(store)
			// 团队任务按**根会话**取（子智能体对话里点开面板也要看得到领队那一份）。
			const teamSessionId = teamSessionIdOf(store, sessionId)
			const [team, setTeam] = React.useState({ phase: 'loading' })
			// 协作读数（可选）：拿不到就不显示那一行，不占位、不报错（它是辅助信息，不挡板面）。
			const [collab, setCollab] = React.useState({ phase: 'loading' })
			// 本块自己的重读计数（错误态那枚「重读」用它；面板的 `props.reload` 仍是主触发）。
			const [localTick, setLocalTick] = React.useState(0)
			// 这一块的筛选：分档 chip（可认领 / 被阻塞 / 有依赖 / 写盘面重叠）+ 搜索（编号 / 主题 / owner / 依赖 / 写盘面）。
			// 任务过十条时，"先干哪条"要在这一屏上看出来 —— 肉眼看三栏不是筛选。
			const [stage, setStage] = React.useState('all')
			const [query, setQuery] = React.useState('')
			const showSkeleton = useSkeletonVisible(team.phase === 'loading')

			// 详情浮窗：`null` = 关着；否则 `{ id }`（**存 id 不存行** —— 重取之后浮窗里那份不会变成旧快照）。
			const [detail, setDetail] = React.useState(null)
			// 翻页要在 keydown 回调里读"当前这一份"，用 ref 承载（与 `LedgerView` 同一条做法）。
			const navRef = React.useRef({ ordered: [], index: -1 })
			// 键盘（← → **切换分栏**、Esc 关）与打开后聚焦走共用那一份；两个按钮仍在栏内翻。
			const modalRef = useDetailModal(detail, () => setDetail(null), (offset) => step(offset), (offset) => columnStep(offset))

			React.useEffect(() => {
				if (!active) return () => {}
				let cancelled = false
				if (typeof fetch !== 'function') {
					setTeam({ phase: 'error', error: '当前环境没有 fetch' })
					return () => {}
				}
				getJsonCached(teamTasksUrlOf(workspace, teamSessionId))
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						if (cancelled) return
						if (payload === null) {
							setTeam((current) => (current.phase === 'ready' ? { phase: 'ready', data: current.data, stale: true } : { phase: 'error', error: 'HTTP ' + response.status + '：响应不是 JSON' }))
							return
						}
						// 这一条端点**永远 200**（团队那半边读不到也算正常答），所以这里只认 `ok`。
						if (payload.ok === true) {
							setTeam({ phase: 'ready', data: payload })
							return
						}
						setTeam((current) => (current.phase === 'ready' ? { phase: 'ready', data: current.data, stale: true } : { phase: 'error', error: typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status }))
					})
					.catch((error) => {
						if (cancelled) return
						setTeam((current) => (current.phase === 'ready' ? { phase: 'ready', data: current.data, stale: true } : { phase: 'error', error: '' + error }))
					})
				return () => {
					cancelled = true
				}
			}, [props.reload, localTick, workspace, sessionId, active])

			// 协作读数：与任务板并行取；失败静默（辅助信息，不挡板面）。
			React.useEffect(() => {
				if (!active) return () => {}
				let cancelled = false
				if (typeof fetch !== 'function') return () => {}
				getJsonCached(collabUrlOf(workspace, teamSessionId))
					.then((response) => response.json().then((payload) => payload, () => null))
					.then((payload) => {
						if (cancelled) return
						if (payload === null || payload.ok !== true) {
							setCollab({ phase: 'error' })
							return
						}
						setCollab({ phase: 'ready', data: payload })
					})
					.catch(() => {
						if (!cancelled) setCollab({ phase: 'error' })
					})
				return () => {
					cancelled = true
				}
			}, [props.reload, workspace, teamSessionId, active])

			// 本插件看板已撤（`.ops/board.json` 无写入者）：不再发无人消费的请求，也不再算只给已撤视图用的 `phaseSpec`。

			const teamData = team.phase === 'ready' ? team.data : null
			const teamRows = teamData !== null && Array.isArray(teamData.rows) ? teamData.rows : []
			const teamAvailable = teamData !== null && teamData.available === true
			const teamReason = teamData !== null && typeof teamData.reason === 'string' ? teamData.reason : team.phase === 'error' ? team.error : ''
			const teamWarnings = teamData !== null && Array.isArray(teamData.warnings) ? teamData.warnings : []
			// 原生按条数截断过的字段（载荷 `truncations`）：卡上逐条印"只列了前 N 条（共 M 条）"。
			const teamTruncations = teamData !== null && Array.isArray(teamData.truncations) ? teamData.truncations : []
			// 任务与成员只在原生 Agent Teams 一档；不再有"两个来源"，旧里程碑档已无写入者。
			const source = 'team'

			const stageSpec = TEAM_TASK_STAGES.find((item) => item.key === stage) ?? TEAM_TASK_STAGES[0]
			const needle = query.trim().toLowerCase()
			// 「被阻塞」要拿**同一份载荷里其他任务的状态**才能推（原生没有 blocked 字段）——
			// 这张表就是那份索引；不在表里的依赖按"没完成"算（见 `dependencyBlockedOf`）。
			const taskStatusById = new Map(teamRows.map((row) => [text(row.id), text(row.status)]))
			// 分档与搜索**都只看原生给的那几个字段**（不自己算"可认领"：`ready` 是原生算的）。
			const visibleRows = teamRows.filter(
				(row) => stageSpec.match(row, taskStatusById) && (needle === '' || haystackOf(row).indexOf(needle) !== -1),
			)
			const stageCount = (item) => teamRows.filter((row) => item.match(row, taskStatusById)).length
			const clearFilters = () => {
				setStage('all')
				setQuery('')
			}
			const retry = () => {
				invalidatePanes()
				setLocalTick((value) => value + 1)
			}

			/** 团队那一半：三栏（照原生状态），卡上只印原生给的那几个字段。 */
			const columnOf = (column) => {
				const items = visibleRows.filter((row) => text(row.status) === column.key)
				return el(
					'div',
					{ className: 'cbv-col', key: column.key, 'data-tt-col': column.key },
					el(
						'div',
						{ className: 'cbv-col-head', key: 'head' },
						el('span', { className: 'cbv-col-name', key: 'name' }, column.label),
						el('span', { className: 'cbv-col-count', key: 'count' }, '' + items.length),
					),
					el(
						'div',
						{ className: 'cbv-col-body', key: 'body' },
						items.length === 0
							? el('div', { className: 'cbv-empty', key: 'none' }, '这一栏没有')
							: items.map((row, index) => teamTaskCard(row, index, false, () => setDetail({ id: text(row.id) }))),
					),
				)
			}

			/**
			 * 团队任务的**详情浮窗**：外壳与看板那一份（`detailOverlayOf`）同形 —— 标题给"栏内第几条"、
			 * 右上角 `上一条 / 下一条 / 关闭`、正文是那张卡摊开的形态（`isOpen = true`）。
			 * @param row - 当前这一条。
			 * @param pool - 它所在那一栏的条目（翻页只在这几条里走）。
			 * @param index - 在当前那一栏里的位置（0 起；-1 = 找不到）。
			 * @param onStep - 翻页（±1）。
			 * @param onClose - 关闭。
			 * @param modalRef - 浮窗元素的 ref（见 `useDetailModal`）。
			 */
			const teamTaskOverlayOf = (row, pool, index, onStep, onClose, modalRef, groupLabel) => {
				const ordered = Array.isArray(pool) ? pool : []
				const id = text(row.id)
				return el(
					'div',
					{ className: 'cbv-overlay', key: 'tt-overlay', onClick: onClose },
					el(
						'div',
						{
							className: 'cbv-modal',
							onClick: (event) => event.stopPropagation(),
							ref: modalRef,
							role: 'dialog',
							'aria-modal': 'true',
							'aria-label': (id || '团队任务') + ' 详情',
							tabIndex: -1,
							'data-tt-dialog': id,
						},
						el(
							'div',
							{ className: 'cbv-modal-head', key: 'head' },
							el(
								'span',
								{ className: 'cbv-modal-title', key: 'title' },
								// 同一口径：**栏名 + 栏内第几条**（"换栏"看得见）。
								(groupLabel === undefined || groupLabel === '' ? '' : groupLabel + '　·　') +
									(id || '(无编号)') +
									(index < 0 ? '' : '　第 ' + (index + 1) + ' 条'),
							),
							el(
								'div',
								{ className: 'cbv-modal-actions', key: 'actions' },
								// 同一句话（这一支的头也是同一套排版）。
								el('span', { className: 'cbv-modal-keys', key: 'keys' }, inlineNodes('`↑ ↓` 本栏内翻页 · `← →` 切换分栏 · `Esc` 关', 'keys')),
								el('button', { className: 'cbv-btn', key: 'prev', type: 'button', disabled: index <= 0, onClick: () => onStep(-1) }, '上一条'),
								el('button', { className: 'cbv-btn', key: 'next', type: 'button', disabled: index < 0 || index >= ordered.length - 1, onClick: () => onStep(1) }, '下一条'),
								el('button', { className: 'cbv-btn', key: 'close', type: 'button', onClick: onClose }, '关闭'),
							),
						),
						el('div', { className: 'cbv-modal-body', key: 'body' }, teamTaskCard(row, index, true, () => {})),
					),
				)
			}

			/**
			 * 一张团队任务卡：编号 / 主题 / 归属 / 依赖与就绪 / 写盘面 / 版本；**全是原生给的字段**。
			 *
			 * 与看板那张卡同一条规矩：**整张卡可点**（`CARD_SHELL_PROPS` 给 `role=button` / `tabIndex` /
			 * Enter·Space），点开是**详情浮窗**（`上一条 / 下一条` 在该条所在那一栏内走，← → 切换分栏、Esc 关）
			 * —— 与「工作区看板」那一半的操作完全一致。`isOpen` 那一支是**浮窗里**用的形态：
			 * 把原生那几个字段摊全（status 原文 / revision / ownerName / ready / blockedBy / writeScopes /
			 * 写盘面重叠告警逐条 / description 原文（**与 subject 同一段时不重复印**）），卡本身不再可点。
			 */
			// 交接单按任务号关联（工具 `handoff` 的可选 `task` 字段）；同一任务多条取最近一条。
			const handoffByTask = (() => {
				const map = new Map()
				if (collab.phase === 'ready' && collab.data !== null && Array.isArray(collab.data.handoffs)) {
					for (const note of collab.data.handoffs) {
						const key = text(note.task)
						if (key !== '') map.set(key, note)
					}
				}
				return map
			})()
			// 冲突任务编号：写盘面重叠告警原文里的 `task-N` / `T-N`（不自己编号）。
			const conflictIdsOf = (row) => {
				const source = Array.isArray(row.writeScopeWarnings) ? row.writeScopeWarnings.join(' ') : ''
				return [...new Set([...source.matchAll(/(?:task-|T-)\d+/g)].map((match) => match[0]))]
			}

			const teamTaskCard = (row, index, isOpen, onToggle) => {
				const id = text(row.id)
				const status = text(row.status)
				const blockedBy = Array.isArray(row.blockedBy) ? row.blockedBy.filter((value) => text(value) !== '') : []
				const scopes = Array.isArray(row.writeScopes) ? row.writeScopes.filter((value) => text(value) !== '') : []
				const scopeWarnings = Array.isArray(row.writeScopeWarnings) ? row.writeScopeWarnings.filter((value) => text(value) !== '') : []
				// 原生按**条数**截断过哪几个数组（载荷 `truncations` 逐条给）⇒ 卡上要说出来：
				// 不说的话会出现"列出来的依赖都满足、可这条仍是等依赖"这种读不通的话（`ready` 是按**全部**依赖算的）。
				const truncations = teamTruncations.filter((item) => text(item.id) === id)
				// **原生那边 `subject` 与 `description` 是同一段文字**（Agent Teams 的两格同义）：
				// 卡上已经用 `cbv-desc` 印了 subject ⇒ 同一段就别再印一遍（现场：浮窗里上下两块一模一样）。
				const subject = text(row.subject)
				const description = text(row.description)
				const descriptionIsDuplicate = description !== '' && description.trim() === subject.trim()
				// 「被阻塞」是状态（与「有依赖」这个事实分开）：依赖没完成才叫被阻塞；依赖都完成就不算。
				// `ready` 是**原生算的**（pending 且依赖全完成）：可认领那一档照印，不自己再算一遍。
				const blockedNow = dependencyBlockedOf(row, taskStatusById)
				const pendingState = status === 'completed'
					? null
					: blockedNow
						? el('span', { className: 'cbv-chip cbv-chip--exception', key: 'blocked' }, '被阻塞')
						: row.ready === true
							? el('span', { className: 'cbv-chip cbv-chip--ok', key: 'ready' }, '可认领')
							: null
				// 折叠卡**只印任务描述**：编号 / 归属 / 版本 / 依赖 / 写盘面 / 检查点 / 告警都是详细内容，
				// 点卡片开浮窗才展示（人的指令：卡片不要摊详细内容）。
				const handoff = handoffByTask.get(id)
				const conflicts = conflictIdsOf(row)
				// 有负责人 = 已分配并锁定（派发守卫会阻止他人再派）；没有 = 待认领。
				const ownerName = text(row.ownerName)
				const locked = ownerName !== ''
				const ownerChip = (key) => el('span', { className: 'cbv-chip', key }, locked ? '负责人 ' + ownerName : '待认领')
				const lockChip = (key) => el('span', { className: 'cbv-chip', key, 'data-tt-locked': locked ? 'true' : 'false' }, locked ? '已锁定' : '未锁定')
				const kids = [
					// 折叠卡：任务编号 + 处理成员（弹窗里这两格已在 facts-top，不重复印）。
					isOpen
						? null
						: el(
							'div',
							{ className: 'cbv-card-top', key: 'head' },
							el('span', { className: 'cbv-id', key: 'id' }, id === '' ? '(无编号)' : id),
							ownerChip('owner'),
							lockChip('lock'),
						),
					// 标签：交接（谁 → 谁 / 谁派发）、冲突任务编号、原生状态与截断提示。
					isOpen || (pendingState === null && handoff === undefined && conflicts.length === 0 && truncations.length === 0)
						? null
						: el(
							'div',
							{ className: 'cbv-card-top', key: 'tags' },
							pendingState,
							handoff === undefined
								? null
								: el(
									'span',
									{ className: 'cbv-chip', key: 'handoff', 'data-tt-handoff': text(handoff.task) },
									text(handoff.to) === '' ? '派发 ' + text(handoff.from) : text(handoff.from) + ' → ' + text(handoff.to),
								),
							conflicts.map((other) => el('span', { className: 'cbv-chip cbv-chip--p1', key: 'cf-' + other, 'data-tt-conflict': other }, '冲突 ' + other)),
							truncations.map((item, at) =>
								el('span', { className: 'cbv-chip cbv-chip--exception', key: 'tr' + at, 'data-tt-truncated': text(item.field) }, '截断 ' + text(item.field)),
							),
						),
					el('div', { className: 'cbv-desc' + (isOpen ? '' : ' cbv-clamp-2'), key: 'subject' }, subject === '' ? '（没有主题）' : subject),
					description === '' || descriptionIsDuplicate || isOpen ? null : el('div', { className: 'cbv-sub cbv-clamp-2', key: 'desc' }, description),
				]
				// 浮窗只补"卡上还没有的东西"：不印原生字段名与系统坐标（`status：` / `revision：` /
				// `ownerName：` / `ready：` / `blockedBy：` / `writeScopes：`），那些卡上已用中文说了一次。
				if (isOpen) {
					const facts = [
						el(
							'div',
							{ className: 'cbv-card-top', key: 'facts-top' },
							el('span', { className: 'cbv-id', key: 'id' }, id === '' ? '(无编号)' : id),
							ownerChip('owner'),
							lockChip('lock'),
							pendingState,
							el('span', { className: 'cbv-chip', key: 'rev' }, 'v' + text(row.revision)),
						),
					]
					if (description !== '' && !descriptionIsDuplicate) facts.push(mdField('cbv-block', description, '', 'description'))
					if (blockedBy.length > 0) facts.push(mdField('cbv-block', '依赖 ' + blockedBy.join('、'), '', 'blocked'))
					if (blockedNow) {
						// 「有依赖」是事实（上一行照印，完成也在）；这一行只回答"被谁卡着"。
						const unmet = blockedBy.filter((id) => taskStatusById.get(typeof id === 'string' ? id : String(id ?? '')) !== 'completed')
						facts.push(mdField('cbv-block', '被阻塞：' + (unmet.length === 0 ? '依赖未完成' : unmet.join('、') + ' 未完成'), '', 'blocked-now'))
					}
					if (scopes.length > 0) facts.push(mdField('cbv-block', '写盘面 ' + scopes.join('、'), '', 'scopes'))
					if (status === 'completed' && row.checkpoint !== null && typeof row.checkpoint === 'object') {
						facts.push(mdField('cbv-block', row.checkpoint.present === true ? '检查点：有' : row.checkpoint.present === null ? '检查点：读不到（读不到 ≠ 没有）' : '检查点：无（收口前补一份）', '', 'checkpoint'))
					}
					if (scopeWarnings.length > 0) facts.push(mdField('cbv-block', scopeWarnings.map((line) => '- ' + line).join('\n'), '', 'scope-warnings'))
					for (const [at, item] of truncations.entries()) {
						facts.push(mdField('cbv-block', `只列了前 ${text(item.shown)} 条（共 ${text(item.total)} 条）：原生把 \`${text(item.field)}\` 按条数截到 ${text(item.limit)} 条 —— 字段的判据仍按**全部**条目算。`, '', 'trunc' + at))
					}
					kids.push(el('div', { className: 'cbv-detail', key: 'detail' }, facts))
				}
				return el(
					'div',
					{
						...CARD_SHELL_PROPS('tt' + index + '#' + id, onToggle),
						'data-tt-id': id,
						'data-tt-status': status,
						'data-tt-ready': row.ready === true ? 'true' : 'false',
						'data-tt-owner': text(row.ownerName),
					},
					kids,
				)
			}

			// 浮窗栏内翻页：先认出条目属于哪一栏、只在该栏内翻（跨栏不翻）；用 `visibleRows`，被筛掉的行不进翻页池。
			const orderedItems = []
			if (detail !== null) {
				for (const column of TEAM_TASK_COLUMNS) {
					const inColumn = visibleRows.filter((row) => text(row.status) === column.key)
					if (inColumn.some((row) => text(row.id) === detail.id)) {
						orderedItems.push(...inColumn)
						break
					}
				}
			}
			const detailIndex = detail === null ? -1 : orderedItems.findIndex((row) => text(row.id) === detail.id)
			navRef.current = { ordered: orderedItems, index: detailIndex }
			const step = (offset) => {
				const current = navRef.current
				const at = current.index + offset
				if (at < 0 || at >= current.ordered.length) return
				setDetail({ id: text(current.ordered[at].id) })
			}
			/**
			 * **切换分栏**（← → 用的那一步）：从当前项所在栏往 `offset` 方向走，遇到空栏跳过，
			 * 落在那一栏里**同一个位置**（不够就落在它最后一个）；到底了就不动。
			 * 判据与 `orderedItems` 同一份数据（`TEAM_TASK_COLUMNS` + `visibleRows`），不另算一套。
			 */
			const columnStep = (offset) => {
				const at = TEAM_TASK_COLUMNS.findIndex((column) => visibleRows.some((row) => text(row.id) === detail.id && text(row.status) === column.key))
				if (at < 0) return
				const mineAt = visibleRows.filter((row) => text(row.status) === TEAM_TASK_COLUMNS[at].key).findIndex((row) => text(row.id) === detail.id)
				for (let i = at + offset; i >= 0 && i < TEAM_TASK_COLUMNS.length; i += offset) {
					const list = visibleRows.filter((row) => text(row.status) === TEAM_TASK_COLUMNS[i].key)
					if (list.length === 0) continue
					const target = list[Math.min(Math.max(mineAt, 0), list.length - 1)]
					setDetail({ id: text(target.id) })
					return
				}
			}
			const detailRow = detailIndex < 0 ? null : orderedItems[detailIndex]
			const overlay =
				detailRow === null || detailRow === undefined
					? null
					: teamTaskOverlayOf(detailRow, orderedItems, detailIndex, step, () => setDetail(null), modalRef, labelOfColumn(TEAM_TASK_COLUMNS, detailRow, 'status'))

			// **可用但为空**、**筛选落空**、**读不到**是三件不同的事，各说各的；读不到还要给一枚「重读」
			//（宿主刚起来时它可恢复 —— 恢复动作不该只藏在窗口 focus 事件里）。
			const teamEmpty = teamAvailable && teamRows.length === 0
			const filteredOut = teamAvailable && teamRows.length > 0 && visibleRows.length === 0
			// 三栏骨架（每栏 2 张，设计 5.3）：加载中不再换成一整行文本，栏头与栏位先在，结构不跳。
			const boardSkeleton = el(
				'div',
				{ className: 'cbv-board', key: 'boardSkeleton', 'data-skeleton': 'board', 'aria-hidden': 'true' },
				TEAM_TASK_COLUMNS.map((column) =>
					el(
						'div',
						{ className: 'cbv-col', key: column.key },
						el('div', { className: 'cbv-col-head', key: 'head' }, el('span', { className: 'cbv-skel-line cbv-skel-line--title', key: 'title' })),
						el('div', { className: 'cbv-col-body', key: 'body' }, skeletonCardsOf(2)),
					),
				),
			)
			const boardState = teamAvailable ? (teamEmpty ? 'empty' : filteredOut ? 'filtered' : teamWarnings.length > 0 || teamTruncations.length > 0 || team.stale === true ? 'degraded' : 'ok') : 'degraded'
			const teamBoard = [
				team.phase === 'loading'
					? el(
							'div',
							{ className: 'cbv-skel-block', key: 'teamLoading', 'data-team-phase': 'loading', 'aria-busy': 'true' },
							el('span', { className: 'cbv-sr-only', key: 'say' }, '正在读取本会话的团队任务板…'),
							showSkeleton ? boardSkeleton : null,
						)
					: teamAvailable
						? teamEmpty
							? el(
									'div',
									{ className: 'cbv-pane-empty cbv-md', key: 'teamEmpty', 'data-team-phase': 'ready' },
									markdownNodes('本会话还没有原生任务。', 'team-empty'),
								)
							: filteredOut
								? el(
										'div',
										{ className: 'cbv-pane-empty cbv-pane-empty--filters', key: 'ttNoFilter', 'data-team-phase': 'ready' },
										el('span', { key: 'word' }, `没有匹配的条目（本会话共 ${teamRows.length} 条）。`),
										el('button', { className: 'cbv-btn', key: 'clear', type: 'button', 'data-filters-clear': 'board', onClick: clearFilters }, '清除筛选'),
									)
								: el('div', { className: 'cbv-board', key: 'board', 'data-team-board': 'true' }, TEAM_TASK_COLUMNS.map((column) => columnOf(column)))
						: el(
								'div',
								{ className: 'cbv-pane-empty', key: 'noTeam', 'data-team-phase': team.phase },
								teamReason === '' ? '读不到本会话的团队任务板。' : teamReason,
								el('button', { className: 'cbv-btn', key: 'retry', type: 'button', 'data-pane-retry': 'board', onClick: retry }, '重读'),
							),

				// 重取失败但手里有旧读数：保留内容 + 说清"这是上一次读数"（设计 3.3）。
				team.stale === true
					? el(
							'div',
							{ className: 'cbv-pane-warn cbv-md', key: 'stale' },
							markdownNodes('显示的是上一次读数（这一次没读到最新的）。', 'tt-stale'),
							el('button', { className: 'cbv-btn', key: 'stale-retry', type: 'button', 'data-stale-retry': 'board', onClick: retry }, '重读'),
						)
					: null,
				// 原生给的那几行告警（写盘面重叠之类的原文）：它自己写的就是 markdown ⇒ 走渲染，标记不上屏。
				...teamWarnings.map((line, index) => el('div', { className: 'cbv-pane-warn cbv-md', key: 'w' + index }, markdownNodes(line, 'tt-warn' + index))),
				overlay,
			]

			// 人要求：看板块**不再印内页标题**（tab 栏上已经有「任务看板」了）。

			// 最小筛选（分档 chip + 搜索）：任务过十条时，"先干哪条"要在这一屏看出来。
			// 计数一律照 `TEAM_TASK_STAGES` 的判据算（与原生的 `ready` / `blockedBy` / `writeScopeWarnings` 同一份数据）。
			const chips = el(
				'span',
				{ className: 'cbv-badges', key: 'chips' },
				TEAM_TASK_STAGES.map((item) =>
					el(
						'button',
						{
							className: 'cbv-flt-chip' + (item.key === stageSpec.key ? ' cbv-flt-chip--on' : ''),
							key: item.key,
							type: 'button',
							'aria-pressed': item.key === stageSpec.key ? 'true' : 'false',
							'data-tt-stage': item.key,
							onClick: () => setStage(item.key),
						},
						item.label + ' ' + stageCount(item),
					),
				),
			)
			// 这几枚同样是**筛选条件，不是划分**（一条任务可以既"可认领"又"写盘面重叠"）。
			const toolbar = el(
				'div',
				{ className: 'cbv-flt-bar', key: 'team-bar' },
				chips,
				el('span', { className: 'cbv-spacer', key: 'spacer' }),
				el('input', {
					className: 'cbv-input cbv-flt-search',
					key: 'query',
					type: 'text',
					value: query,
					placeholder: '搜索：编号 / 主题 / 描述 / owner / 依赖 / 写盘面…',
					'aria-label': '搜索本会话的团队任务',
					onChange: (event) => setQuery(event.target.value),
					onKeyDown: (event) => {
						// Esc 清空搜索并保持焦点（设计 7.1）。
						if (event !== null && event !== undefined && event.key === 'Escape') {
							event.preventDefault()
							setQuery('')
						}
					},
				}),
			)

			return el(
				'div',
				{
					className: 'cbv-view',
					key: 'board-block',
					ref: null,
					'data-board-picked': source,
					'data-board-mark': PANE_MARK,
					// 统一状态标记（设计 5.4）：`data-board-phase/state` 是正名，`data-team-phase` 再留一个版本。
					'data-board-phase': team.phase,
					'data-board-state': boardState,
					'data-team-phase': team.phase,
					'data-board-total': '' + teamRows.length,
					'data-board-visible': '' + visibleRows.length,
				},
				toolbar,
				...teamBoard,
			)
		}

		/**
		 * **默认队友清单**那一节：角色 + 每个角色现在的编制状态（只读）。
		 *
		 * 数据来自端点载荷的 `defaults`（宿主调的是引擎 `defaultRosterOf` / `defaultRosterView` ——
		 * 与会话工具 `member_defaults` **同一个函数**），所以面板上印的清单与工具回执逐条一样。
		 * **这一节只管两件事**：把名册印出来（清单 + 编制状态）、以及在卡上增删改角色定义。
		 * **"叫人干活"不在这里**：那是**输入框工具行那一枚「角色」按钮**的事（人的更正：「我的意思是在
		 * 输入框添加一个「角色」按钮，不是让你写在「成员」里面」）—— 见 `RoleComposerEntry`。
		 * @param data - 成员端点载荷。
		 * @returns 一节节点；载荷没有这一格时返回 null（老版本宿主）。
		 */
		const rosterSectionOf = (data, actions) => {
			const block = data === null || data.defaults === undefined || data.defaults === null ? null : data.defaults
			const act = actions === undefined || actions === null ? {} : actions
			// **没有 `defaults` 这一格**（老宿主）才整节不渲染；`rows` 为空是「角色目录里还没有角色」
			// —— 那是**空态**，要连「＋ 添加角色」一起给（设计 P-07 / 4.2.4）。
			if (block === null || !Array.isArray(block.rows)) return null
			const hiddenRows = Array.isArray(block.hiddenRows) ? block.hiddenRows : []
			// **来源筛档**（task-38）：档位与中文标签都来自载荷（`originFacets`，服务端那一处正文）——
			// 前端**不硬编码**任何"哪个 origin 该显示什么"的判断，只按 key 过滤。
			const originFacets = Array.isArray(block.originFacets) ? block.originFacets : []
			// **导出前置条件**（设计 P-12）：没有任何 `origin !== 'package'` 的角色时不发请求。
			const customCount = block.rows.filter((row) => text(row.origin) !== 'package').length
			const exportDisabled = customCount === 0
			// 档位从调用方传进来（`rosterSectionOf` 与 `RolesView` 是两个作用域，别直接读那边的 state）。
			const originFacet = text(act.rosterOriginFacet) === '' ? 'all' : text(act.rosterOriginFacet)
			const shownRows = originFacet === 'all' ? block.rows : block.rows.filter((row) => text(row.origin) === originFacet)
			// **这一节不印任何汇总读数**（人的口径：面板上的统计性描述都去掉）：上面那排筛选 chip 写着真数，
			// 每张角色卡自己带着编制状态；要机器核对看 `data-roster-count`（数据属性，不是给人读的一行字）。
			return el(
				'div',
				{ className: 'cbv-roster', key: 'roster', 'data-roster-count': '' + block.rows.length, 'data-roster-visible': '' + shownRows.length, 'data-roster-hidden': '' + hiddenRows.length, 'data-roster-established': block.established === true ? 'true' : 'false' },
				el(
					'div',
					{ className: 'cbv-view-head', key: 'roster-head' },
					// 人要求：这一节不再印「角色」标题 —— tab 栏上已经有「角色」了，这里只留筛选与动作。

					// **来源筛选：下拉**（人的口径：**除成员页外，其它筛选行都退回下拉**）——档位来自载荷
					// `originFacets`；一档都不显示时不画（省得占地方）。单选的语义与从前的 chip 排**一样**。
					originFacets.length <= 1
						? null
						: el(
								'select',
								{
									className: 'cbv-select cbv-flt-select',
									key: 'origin-facet',
									'data-roster-origin-facet': '',
									'aria-label': '按来源筛选',
									value: originFacet,
									onChange: (event) => act.setRosterOriginFacet(event.target.value),
								},
								el('option', { value: 'all', key: 'all' }, `全部来源（${block.rows.length}）`),
								originFacets.map((facet) => el('option', { value: facet.key, key: facet.key, 'data-roster-origin-option': facet.key }, `${text(facet.label)}（${facet.count}）`)),
							),
					el('span', { className: 'cbv-spacer', key: 'roster-spacer' }),
					// **角色包**：导出把当前自建角色打成一个文件带走；导入先预览再落盘（判定全在宿主）。
					// 两个动作都不影响包内角色 —— 那一份是发布面，随插件升级整份替换。
					el(
						'button',
						{
							className: 'cbv-btn',
							key: 'roster-export',
							type: 'button',
							'data-roster-action': 'export',
							// 前置禁用：没有自建角色时点了也只会收到 409（设计 P-12 / A-16）。
							'aria-disabled': exportDisabled ? 'true' : undefined,
							onClick: () => {
								if (exportDisabled) {
									// 不发请求，只把原因说清（与按钮下方那句同一句话）。
									if (typeof act.showNote === 'function') act.showNote('没有可导出的自建角色（包内角色不随包走）。')
									return
								}
								act.exportRoles()
							},
						},
						'导出',
					),
					el('button', { className: 'cbv-btn', key: 'roster-import', type: 'button', 'data-roster-action': 'import', onClick: () => act.importRoles() }, '导入'),
					// **添加**：新角色写在用户角色根（`$DSH_HOME/team-ops/roles/<id>/ROLE.md`）——
					// 那是"你自己的角色"，包内那份不受影响、升级也不会被刷掉。
					el('button', { className: 'cbv-btn', key: 'roster-add', type: 'button', 'data-roster-action': 'add', onClick: () => act.openRosterDialog({ kind: 'create' }) }, '＋ 添加角色'),
				),
				// 回执紧贴工具行下方（设计 P-14）；成功 `role=status`、失败 `role=alert`。
				act.notice === undefined || act.notice === null ? null : act.notice,
				exportDisabled
					? el(
							'div',
							{ className: 'cbv-pane-note', key: 'roster-export-hint', 'data-roles-export-hint': '' },
							'没有可导出的自建角色（包内角色不随包走）。',
						)
					: null,
				// 空态：**不是**「这一版宿主没有返回角色目录」（那是 `roster === null` 那一支）。
				block.rows.length === 0
					? el(
							'div',
							{ className: 'cbv-pane-empty', key: 'roster-empty', 'data-roles-empty': '' },
							'角色目录里还没有角色。',
							el('button', { className: 'cbv-btn', key: 'add-empty', type: 'button', 'data-roster-action': 'add-empty', onClick: () => act.openRosterDialog({ kind: 'create' }) }, '＋ 添加角色'),
						)
					: shownRows.length === 0
						? // 筛空（设计 5.2：来源筛选落空 +「清除筛选」）——与"目录真的空"分开说。
							el(
								'div',
								{ className: 'cbv-pane-empty cbv-pane-empty--filters', key: 'roster-filtered', 'data-roles-filtered': '' },
								el('span', { key: 'word' }, `没有匹配的条目（共 ${block.rows.length} 条）。`),
								el('button', { className: 'cbv-btn', key: 'clear', type: 'button', 'data-filters-clear': 'roles', onClick: () => act.setRosterOriginFacet('all') }, '清除筛选'),
							)
						: el(
					'div',
					{ className: 'cbv-roster-grid', key: 'roster-grid' },
					shownRows.map((row, index) =>
						el(
							'div',
							{
								className: 'cbv-box cbv-roster-card',
								key: 'r' + index,
								'data-roster-role': text(row.role),
								'data-roster-state': text(row.state),
								'data-roster-next': text(row.nextName),
								// **来源标**（来自载荷 `originLabel`；服务端那张表是唯一的词源）
								'data-roster-origin': text(row.origin),
								'data-roster-origin-label': text(row.originLabel),
							},
							el(
								'div',
								{ className: 'cbv-mp-top', key: 'top' },
								// 头像框与成员卡同款（同一套 `.cbv-mp-avatar` + 引擎给的色调档）：清单里每一条
								// 也是"一个人"，没有头像框时这一栏看着像设置项，不像"可叫的人"。
								el(
									'span',
									{
										className: 'cbv-mp-avatar cbv-mp-avatar--' + (text(row.avatarTone) === '' ? 'exec' : text(row.avatarTone)),
										key: 'av',
										'data-roster-avatar': text(row.role),
										'aria-hidden': 'true',
									},
									avatarIconOf(row.avatar),
								),
								el(
									'div',
									{ className: 'cbv-mp-nameblock', key: 'namebox' },
									el('span', { className: 'cbv-id', key: 'role' }, text(row.role)),
									el(
										'div',
										{ className: 'cbv-badges', key: 'chips' },
										el('span', { className: 'cbv-chip', key: 'title' }, text(row.title)),
										text(row.category) === '' ? null : el('span', { className: 'cbv-chip', key: 'cat' }, text(row.category)),
										// **来源那一枚**：项目级 / 用户级 / 包内（`originLabel` 由服务端给）
										text(row.originLabel) === '' ? null : el('span', { className: 'cbv-chip cbv-chip--origin', key: 'origin', 'data-roster-origin-chip': text(row.origin) }, text(row.originLabel)),
									),
								),
							),
							el('div', { className: 'cbv-desc', key: 'pos' }, text(row.positioning)),
							// 状态行只在真有人时印（空档"未到场"印 18 遍不是信息）；`data-roster-state` 照旧在。
							text(row.state) === 'vacant' ? null : el('div', { className: 'cbv-sub', key: 'state' }, text(row.label)),
							// 动作名按出处说准：包内角色的两个动词是"改（写覆盖）"与"下架（可恢复）"，不是"删掉"；判据来自载荷的 `removal`。
							el(
								'div',
								{ className: 'cbv-cardbar', key: 'bar' },
								el('button', { className: 'cbv-cardbtn', key: 'edit', type: 'button', 'data-roster-action': 'edit', onClick: () => act.openRosterDialog({ kind: 'edit', entry: row }) }, '修改'),
								// **导出这一个**：只打包这个角色（与它引用的自建技能），给"分享一个角色"用。
								el('button', { className: 'cbv-cardbtn', key: 'export', type: 'button', 'data-roster-action': 'export-one', onClick: () => act.exportOneRole(row) }, '导出'),
								el(
									'button',
									{ className: 'cbv-cardbtn', key: 'remove', type: 'button', 'data-roster-action': 'remove', 'data-roster-removal': text(row.removal), onClick: () => act.openRosterDialog({ kind: 'remove', entry: row }) },
									text(row.removal) === 'hide' ? '下架' : text(row.removal) === 'revert' ? '还原为包内' : '删除',
								),
							),
						),
					),
				),
				block.established === true
					? null
					: el(
							'div',
							{ className: 'cbv-pane-note cbv-md', key: 'roster-unestablished' },
							markdownNodes('名册文件还没建立 —— 一个人都还没叫过。', 'roster-unestablished'),
						),
				// 已下架的那些折一行（**可恢复**）：它们是包内角色，"删除"在这里的形态就是不上货架。
				hiddenRows.length === 0
					? null
					: el(
							'div',
							{ className: 'cbv-pane-note', key: 'roster-hidden', 'data-roster-hidden-row': '' + hiddenRows.length },
							'已下架（本工作区不上货架，可恢复）：',
							...hiddenRows.map((row, index) => [
								index === 0 ? null : '、',
								el('button', { className: 'cbv-cardbtn', key: 'h' + index, type: 'button', 'data-roster-action': 'restore', onClick: () => act.restoreRole(row) }, `恢复 ${text(row.role)}`),
							]),
						),
				// 收尾的"怎么叫人 / 名字怎么取 / 状态怎么变"不再印在面板上（描述性文字太多）。
				null,
			)
		}

		/** 我们这一套 `@` 来源的稳定 id（引用对象的 `source` 必须与它逐字相等）。 */
		// ── ⑪ 角色触发源与输入框席位 ─────────────────────────────────────────────
		const ROLE_SOURCE_ID = 'team-ops:roles'
		// 本插件注册的来源名（`team-ops:roles:<分类>`）；引用 chip 只有来源注册过才插得进去（否则提交时报
		// `slash: no serializer for reference source`）—— 这一格就是「能不能插引用」的闸。
		const roleSourceState = { installed: false, names: new Set() }

		/** 名册缓存：`@` 菜单随时可能被打开，别每敲一个字就打一次端点（短 TTL + 同一个工作区复用）。 */
		const rosterCache = new Map()
		/** **最后一次真读到的名册**（按 key 存）：热词典是**同步**函数，只能读这一份。 */
		const rosterKnown = new Map()
		// 当前 UI 正在看的（工作区|会话）名册 key：只从这一份算分组与热词典，
		// 否则切到 B 工作区后，A 的角色还会从 `rosterKnown` 里漏进 @ 菜单。
		let activeRosterKey = ''
		/** 热词典的订阅者（名册变了要通知本体重新扫一遍纯文本引用）。 */
		const lexiconSubs = new Set()

		/**
		 * 名册读回来之后：记下这一份 + 通知订阅者（热词典变了）。
		 * @param key - 缓存 key。
		 * @param rows - 名册行。
		 * @returns {void}
		 */
		function rememberRoster(key, rows) {
			rosterKnown.set(key, rows)
			activeRosterKey = key
			for (const emit of [...lexiconSubs]) {
				try {
					emit()
				} catch {
					// 订阅者自己抛异常不该影响取数
				}
			}
		}

		/**
		 * **按 `category` 把已知名册分成几组**（人的口径：「@ 出来的角色，我们也要分组」）。
		 *
		 * 组的顺序 = 分类在名册里**第一次出现**的顺序（与面板那一节的选择框、卡片同序），不排序。
		 * 没写分类的归到「未分类」。
		 * @returns `[{ key, label, rows }]`：`key` 是来源标识用的稳定键（分类原文），`label` 是显示名。
		 */
		function roleGroupsOf() {
			const groups = []
			const seen = new Set()
			// **只算当前名册**：`rosterKnown` 按工作区/会话累积，切走之后旧 key 不能继续漏进来。
			const rows = rosterKnown.get(activeRosterKey) ?? []
			for (const row of rows) {
				const id = text(row?.role)
				if (id === '' || seen.has(id)) continue
				seen.add(id)
				const label = text(row?.category) === '' ? '未分类' : text(row.category)
				const group = groups.find((entry) => entry.label === label)
				if (group === undefined) groups.push({ key: label, label: label, rows: [row] })
				else group.rows.push(row)
			}
			return groups
		}

		/**
		 * **热词典**要的那串名字：所有已知名册里的角色 id（去重）。
		 * 同步、便宜（每敲一个字都会被问一次），读的是最近一次真读到的名册。
		 * @returns 角色 id 数组（还没读到任何名册时是空数组）。
		 */
		function knownRoleNames() {
			const names = new Set()
			const rows = rosterKnown.get(activeRosterKey) ?? []
			for (const row of rows) {
				const id = text(row?.role)
				if (id !== '') names.add(id)
			}
			return [...names]
		}
		/**
		 * 取一份角色名册（现场枚举，来自本插件那个 `/members` 端点的 `defaults.rows`）。
		 * @param workspace - 工作区绝对路径（从会话清单里读）。
		 * @param sessionId - 会话 id（端点按它查本会话的 agent 名册）。
		 * @returns `Promise<Array<object>>`：读不到就给空数组（菜单里就是"没有候选"，不编造）。
		 */
		function rosterRowsOf(workspace, sessionId) {
			const key = workspace + '|' + sessionId
			const hit = rosterCache.get(key)
			if (hit !== undefined && Date.now() - hit.at < 5000) return hit.promise
			// 返回 `{ rows, error }`：**读失败不再被吞成空数组**（设计 ⑩ `rosterRowsOf`）——
			// 选择框要能把「没有角色」与「读不到名册」分开说。
			const promise =
				typeof fetch !== 'function'
					? Promise.resolve({ rows: [], error: '当前环境没有 fetch' })
					: getJsonCached(MEMBERS_ENDPOINT + (workspace === '' && sessionId === '' ? '' : paneQueryOf(workspace, sessionId)))
							.then((response) =>
								response.json().then(
									(payload) => {
										// **只认明确的失败**（`ok:false`）与"不是 JSON"：`ok` 缺省时按成功读
										// —— 老宿主 / 自检桩件不一定带这一格，但 `defaults` 是这一条的正文。
										if (payload === null || payload.ok === false) {
											return { rows: [], error: payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status }
										}
										const rows = payload.defaults !== undefined && payload.defaults !== null && Array.isArray(payload.defaults.rows) ? payload.defaults.rows : []
										rememberRoster(key, rows)
										return { rows, error: '' }
									},
									() => ({ rows: [], error: 'HTTP ' + response.status + '：响应不是 JSON' }),
								),
							)
							.catch((error) => ({ rows: [], error: '读不到角色名册：' + String(error) }))
			rosterCache.set(key, { at: Date.now(), promise: promise })
			// 失败不留在 5 秒缓存里：否则「重试」会被缓存直接挡回去。
			void promise.then((result) => {
				if (result.error !== '') rosterCache.delete(key)
			})
			return promise
		}

		/**
		 * 从**会话清单**里读那个会话的工作区（与视图栏那一席同一处口径；这里是纯函数版，供 `@` 菜单用）。
		 * @param sessions - `sessions` 服务。
		 * @param sessionId - 会话 id。
		 * @returns 工作区绝对路径；读不到给空串。
		 */
		function workspaceOfSession(sessions, sessionId) {
			try {
				const snapshot = sessions?.list?.getSnapshot?.()
				const entry = snapshot !== null && typeof snapshot === 'object' && snapshot.byId !== null && typeof snapshot.byId === 'object' ? snapshot.byId[sessionId] : undefined
				const cwd = entry === null || entry === undefined ? undefined : entry.cwd
				return typeof cwd === 'string' ? cwd : ''
			} catch {
				return ''
			}
		}

		/**
		 * **把角色加进本体的 `@` 菜单与热词典**（人的现场："我输入 @ 根本看不到任何团队内的角色"）。
		 *
		 * 这条路的出处同样是 `@michengai/dsh-agency-agents`（它就是这么把「专家」放进 `@` 菜单的）：
		 * `ctx.inputTriggers.registerSource({ trigger, name, order, candidates, onPick, lexicon, codec })`。
		 *   · `candidates(session, { query })` ⇒ `[{ name, hint, section }]`：菜单里的每一行；
		 *   · `onPick({ candidate, session, span })` ⇒ `{ insert: <引用对象> }`：选中之后插一枚 chip；
		 *   · `lexicon()` ⇒ 名字数组：**热词典**，直接打 `@qa` 也会被认成引用（不必先开菜单）；
		 *   · `codec.clipboardText` / `serialize`：那枚 chip 在消息里长什么样（我们让它长成 `@角色名`）。
		 * 拿不到 `inputTriggers` 服务（老宿主）就整段跳过：面板那一枚「角色」按钮照旧能用。
		 * @param ctx - 客户端插件 ctx。
		 * @param sessions - `sessions` 服务。
		 * @returns 注销函数（没注册成功就是 no-op）。
		 */
		function registerRoleTriggerSource(ctx, sessions) {
			const triggers = serviceOf('inputTriggers')
			if (triggers === null || triggers === undefined || typeof triggers.registerSource !== 'function') return null
			// `ctx.sessions` 在某些宿主 / 测试里不一定挂在这一格上 ⇒ 退到服务取值（老宿主没有它就是 undefined，
			// 那时行为与从前一致：不折根会话）。
			const sessionsService = sessions === undefined || sessions === null ? serviceOf('sessions') : sessions
			/** 已经注册出去的来源：`分组 key → 注销函数`。 */
			const registered = new Map()
			/** 分组 key → 该组的来源 id（引用对象里的 `source` 必须与它逐字相等）。 */
			const sourceIdOf = (key) => ROLE_SOURCE_ID + ':' + key
			let warning = null

			/** 一个分组的来源（照 dsh-agency-agents 的形状：**一组一个来源**，组标题写在 `section` 上）。 */
			const sourceOf = (group) =>
				({
					trigger: '@',
					name: sourceIdOf(group.key),
					order: 120 + group.order,
					showGroupTitle: false,
					candidates: async (session) => {
						// 子智能体对话里折到**根会话**：名册挂在领队那个会话上，子会话行连 cwd 都没有
						// （不带工作区去取，宿主只能失败 —— 菜单就会"闪一下关掉"）。
						const id = teamSessionIdOf(sessionsService?.list, text(session?.sessionId))
						await rosterRowsOf(workspaceOfSession(sessionsService, id), id)
						// 现取之后**按这一组过滤**（名册可能刚变过：不是这一组的就不出现在这里）。
						const fresh = roleGroupsOf().find((entry) => entry.key === group.key)
						return (fresh === undefined ? [] : fresh.rows).map((row) => ({
							name: text(row.title) === '' ? text(row.role) : text(row.title),
							hint: text(row.role),
							section: group.label,
						}))
					},
					onPick: ({ candidate }) => {
						const id = text(candidate?.hint)
						return {
							insert: {
								source: sourceIdOf(group.key),
								ref: id,
								label: text(candidate?.name),
								appearance: 'session',
								clipboardText: '@' + id + '\u00A0',
							},
						}
					},
					// 热词典：直接打 `@qa` 也算引用；必须**现取当前组**（闭包里的 `group.rows` 是注册时快照，同分类后加的角色会认不出）。
					lexicon: () => {
						const fresh = roleGroupsOf().find((entry) => entry.key === group.key)
						return (fresh?.rows ?? []).map((row) => text(row?.role)).filter((name) => name !== '')
					},
					subscribeLexicon: (emit) => {
						lexiconSubs.add(emit)
						return () => lexiconSubs.delete(emit)
					},
					codec: {
						clipboardText: (ref) => '@' + text(ref) + '\u00A0',
						serialize: async (ref) => '@' + text(ref) + '\u00A0',
					},
				})

			/** 名册读到哪一组就补哪一组（分类后来才出现的组，下一次名册变化时补上）。 */
			const sync = () => {
				for (const group of roleGroupsOf()) {
					if (registered.has(group.key)) continue
					try {
						const dispose = triggers.registerSource(sourceOf({ ...group, order: registered.size }))
						registered.set(group.key, typeof dispose === 'function' ? dispose : () => {})
						roleSourceState.installed = true
						roleSourceState.names.add(sourceIdOf(group.key))
					} catch (error) {
						if (warning === null) {
							warning = 'team-ops：角色进不了 `@` 菜单（' + String(error === null || error === undefined ? '未知错误' : error.message ?? error) + '）—— 面板那枚「角色」按钮仍可用。'
							ctx?.logger?.warn?.(warning)
						}
					}
				}
			}

			// 名册变化 ⇒ 一是补新组，二是通知本体重扫热词典。
			lexiconSubs.add(sync)
			// 先预热一份：分组与热词典都读"最近一次真读到的名册"，没人开过菜单时也得有一份。
			const current = teamSessionIdOf(sessionsService?.list, resolveCurrentSessionId())
			void rosterRowsOf(workspaceOfSession(sessionsService, current), current).then(() => sync())

			return () => {
				lexiconSubs.delete(sync)
				for (const dispose of registered.values()) dispose()
				registered.clear()
				roleSourceState.installed = false
				roleSourceState.names.clear()
			}
		}

		/**
		 * **把草稿折成 detect 投影**（chip 各算一个 `U+FFFC`）。
		 *
		 * 本体的插入 API（`insertReference` / `insertText` 的 `span`）吃的是**这套坐标**，不是"chip 展开了
		 * 的那种文本"的偏移：快照里的 `draft` 是**展开文本**（一枚 chip 展开成 `@qa␣`），而 `occurrences`
		 * 给出每一枚 chip 在那份文本里的 `{ offset, length }`。照 `dsh-agency-agents` 的 `mO()` 折一遍，
		 * 偏移才对得上（**这一处曾经算错坐标 ⇒ 选第二个角色时插入静默失败、输入框里只有第一个**）。
		 * @param draftText - 快照里的 `draft`（展开文本）。
		 * @param occurrences - 快照里的 `occurrences`（chip 的位置与长度）。
		 * @returns detect 文本。
		 */
		function detectTextOf(draftText, occurrences) {
			let out = text(draftText)
			const list = Array.isArray(occurrences) ? occurrences : []
			// 从后往前替换，前面的偏移才不受影响。
			const sorted = [...list].sort((a, b) => ((b?.offset ?? 0) - (a?.offset ?? 0)))
			for (const item of sorted) {
				const offset = item?.offset
				const length = item?.length ?? 1
				if (typeof offset !== 'number' || offset < 0 || length < 1 || offset + length > out.length) continue
				out = out.slice(0, offset) + '\uFFFC' + out.slice(offset + length)
			}
			return out
		}

		/**
		 * **输入框那个把手**（插字 / 插引用 / 通知的唯一入口）。
		 *
		 * 这条路的出处：`@michengai/dsh-agency-agents` 的客户端就是这么把「专家」插进输入框的 ——
		 * 它从**会话作用域**里取 `conversation` 服务，再 `.input.for(scope)` 拿到一个把手：
		 *   · `handle.state.getSnapshot()` ⇒ `{ draft, draftRev, occurrences }`（detect 坐标，chip 各算一个字符）；
		 *   · `handle.insertText(text, span)` / `handle.insertReference(ref, span)` / `handle.notify(level, text)`；
		 *   · 或者走事件面：`scope.bail(scope, 'slash/input-insert-text', { text, span, continue? })`。
		 * **它就是"改草稿"的正路**：不像 `inputActions.setDraft` 那样整份替换（那会把已经插进来的 chip 冲掉）。
		 * @param sessions - `sessions` 服务（客户端插件 ctx 上那个，`inject` 里已点名）。
		 * @param sessionId - 会话 id。
		 * @returns `{ scope, handle, scopeId }`；拿不到时 `scope` 为 null。
		 */
		function composerAccessOf(sessions, sessionId) {
			const none = { scope: null, handle: null }
			try {
				if (sessions === null || sessions === undefined || sessionId === '') return none
				const id =
					typeof sessions.list?.getSnapshot === 'function'
						? (() => {
								const snapshot = sessions.list.getSnapshot()
								const byId = snapshot === null || typeof snapshot !== 'object' ? undefined : snapshot.byId
								if (typeof snapshot?.current === 'string' && snapshot.current !== '') return snapshot.current
								if (byId !== null && typeof byId === 'object') {
									const hit = Object.entries(byId).find(([, entry]) => ((entry?.retainedBy?.mainView ?? 0) > 0))
									if (hit !== undefined) return hit[1]?.id ?? hit[0]
								}
								return sessionId
							})()
						: sessionId
				const scope = typeof sessions.scope === 'function' ? sessions.scope(id) : typeof sessions.binding === 'function' ? sessions.binding(id)?.ctx : undefined
				if (scope === undefined || scope === null) return none
				const handle = typeof scope.get === 'function' ? scope.get('conversation')?.input?.for?.(scope) : undefined
				return { scope: scope, handle: handle === undefined || handle === null ? null : handle }
			} catch {
				return none
			}
		}

		/**
		 * 「角色」选择框里把焦点挪到相邻一行（↑ ↓ 用）。
		 *
		 * 为什么要自己挪：行是 `div role="option"`（不是原生 `<select>`），浏览器不会替我们移动焦点。
		 * 从**事件目标**往上找 `[data-composer-role-list]` 那一层，再在它里面按 `data-composer-role-id`
		 * 取全部行 —— 不依赖 `document` 查询；拿不到 DOM（非浏览器环境）时安静地不动。
		 * @param from - 当前聚焦的那一行（事件的 `currentTarget`）。
		 * @param step - `+1` 下一行 / `-1` 上一行。
		 */
		const movePickerFocus = (from, step) => {
			try {
				if (from === null || from === undefined || typeof from.closest !== 'function') return
				const list = from.closest('[data-composer-role-list]')
				if (list === null || list === undefined || typeof list.querySelectorAll !== 'function') return
				const options = Array.from(list.querySelectorAll('[data-composer-role-id]'))
				const at = options.indexOf(from)
				if (at < 0) return
				const next = options[at + step]
				if (next !== undefined && next !== null && typeof next.focus === 'function') next.focus()
			} catch {
				/* 拿不到 DOM 就算了：键盘这一步失败不该影响别的 */
			}
		}

		/**
		 * 「角色」选择框的落点（**视口坐标**，单位 px）—— 纯函数，DOM 由调用方量。
		 *
		 * 一行算式各管一件事：
		 *   · `left` = 按钮左边缘（选择框与按钮**左对齐**）；右边放不下就往左收，
		 *     收的程度按选择框**真实外框**算：`min(300px, 70vw)` 的内容宽 + 左右内边距 12 + 边框 2 = 314
		 *     （这层是 content-box，见 `.cbv-rolepick-pop` 那条样式）。原来的 428 是 420px 宽那一版的
		 *     遗产，选择框收窄到 300 之后这个数就没再生效过，还留着一并按真实宽度改掉。
		 *   · `bottom` = 视口底到按钮上边缘再抬 8px ⇒ 选择框**浮在输入框上方**，不压住输入框那一行。
		 * 两种情形都至少离视口边 8px：窗口再窄也不贴边。
		 * @param rect - 按钮的 `getBoundingClientRect()` 读数（只要 `left` / `top`）。
		 * @param viewport - `{ width, height }`（`window.innerWidth` / `innerHeight`）。
		 * @returns `{ left, bottom }`，直接进 `style`。
		 */
		const rolePickerPlacement = (rect, viewport) => {
			const width = Math.min(300, viewport.width * 0.7) + 14
			const left = Math.max(8, Math.min(rect.left, viewport.width - width - 8))
			const bottom = Math.max(8, viewport.height - rect.top + 8)
			return { left: Math.round(left), bottom: Math.round(bottom) }
		}

		/**
		 * **输入框工具行里那一枚「角色」按钮**（席位 `conversation.input.left`）。
		 *
		 * 人的口径：「我的意思是在输入框添加一个「角色」按钮」「**角色就长在输入框文本里，只需要输入框
		 * `@+对应角色名` 就可以了**」「在输入框直接清除内容就可以取消角色生效了」。
		 * 于是这里只有两步，没有第三步：
		 *   ① 点「角色」⇒ 一个选择框（搜索 + 按分类分组 + 头像行，与本体那个「专家」选择框同形）；
		 *   ② 选中一个角色 ⇒ 把 **`@<角色名>` 追加进输入框**（已有标记时不替换，所以可以连着点几个）（走本体那条 `slash/input-insert-text` 事件面，
		 *      与 `@michengai/dsh-agency-agents` 插「专家」是同一个把手）；在输入框接着写这件活，
		 *      **按发送**就行 —— 消息里那个 `@角色名` 就是"点名"，协调者会按规矩把这件事交给那个角色
		 *      （`member_spawn` / `member_send`）。面板**自己不发任何派活请求**（人的判断：本体的发送键
		 *      就够了，再挂一枚"让它去干"是重复入口）。
		 * **角色不是一份状态，而是草稿的函数**：文本里那个 `@<名册里认得的角色名>` 在，角色就在；
		 * 删掉那段文本（或者把输入框清空）角色自动不作数 —— 这正好就是"取消"。
		 *
		 * 三条不肯猜的地方：
		 *   · **草稿从标准 prop `useInput` 读**（`s.draft`，本体自己也是这么读的），**清空走 `inputActions.setDraft('')`**
		 *     —— 不自己抓 DOM、不伪造一份草稿状态。
		 *   · **工作区从会话读**（`useSessions(s => s.byId[sessionId]?.cwd)`，与视图栏那一席同一处口径）。
		 *   · **能不能叫、叫什么名字、记哪一行**全由引擎说了算：端点拒了就把那句话原样显示在选择框里，
		 *     按钮留在"让 <角色> 去做"上，改一改再来。
		 *
		 * @param props - 槽给的标准 props：`useInput` / `inputActions` / `sessionId` / `useSessions`（都可能有旧版本）。
		 * @returns 一枚按钮 + 展开时的选择框。
		 */
		function RoleComposerEntry(props) {
			const slotsProps = props === null || props === undefined ? {} : props
			// `sessions`：插件 ctx 上那个服务（席位注册时塞进来 —— 会话作用域里的 `conversation` 把手要它）。
			const sessionsService = slotsProps.sessions === undefined || slotsProps.sessions === null ? serviceOf('sessions') : slotsProps.sessions
			const sessionId = typeof slotsProps.sessionId === 'string' ? slotsProps.sessionId : resolveCurrentSessionId()
			// 子智能体对话里折到**根会话**（名册与角色源都挂在领队那个会话上）。
			const teamSessionId = teamSessionIdOf(sessionsService?.list, sessionId)
			// 草稿：本体自己的读法（`useInput((s) => s)`）—— 取不到就当空串（旧宿主没有这个 prop）。
			const inputState = typeof slotsProps.useInput === 'function' ? slotsProps.useInput((state) => state) : null
			const draft = inputState === null || inputState === undefined ? '' : text(inputState.draft)
			const setDraft = typeof slotsProps.inputActions === 'object' && slotsProps.inputActions !== null && typeof slotsProps.inputActions.setDraft === 'function' ? slotsProps.inputActions.setDraft : null
			// 工作区：与视图栏那一席同一处口径（会话清单里**团队会话那一条**的 cwd）。
			const workspace = typeof slotsProps.useSessions === 'function' ? text(slotsProps.useSessions((state) => (teamSessionId === '' || state === null || state === undefined || typeof state.byId !== 'object' || state.byId === null ? undefined : state.byId[teamSessionId]?.cwd))) : ''
			// 没有 `useSessions` 的旧宿主：从会话清单直接读（同样是团队会话那一行）。
			const workspaceNow = workspace !== '' ? workspace : workspaceOfSession(sessionsService, teamSessionId)
			/**
			 * **从草稿里读角色**（人的口径：「角色就长在输入框文本里只需要输入框「@+对应角色名」就可以了」）。
			 *
			 * 于是角色不是一份独立状态，而是**草稿的函数**：输入框里有几个 `@<角色名>` 就有几个角色
			 * （**可以同时 @ 好几个**），删掉那几段（或者整份清空）就自动没有 —— 这正好也是"取消"。
			 * 只在**名册里认识这个名字**时才算数（`rosterIds`）：`@某文档` 那种写法不会被当成角色。
			 * @param text_ - 草稿（detect 投影，chip 各占一个 U+FFFC）。
			 * @param ids - 名册里的角色 id（还没读到名册时为空 ⇒ 先不认，读到之后自动生效）。
			 * @returns `{ roles, task, lastEnd }`：点到的角色 id（按出现顺序、去重）、去掉全部标记之后的
			 *   那件事、以及最后一个标记的结束位置（面板那枚按钮要"追加"在它之后）。
			 */
			const rolesInDraftOf = (text_, ids) => {
				const source = text(text_)
				const roles = []
				const cuts = []
				const pattern = /(^|\s)@([a-z][a-z0-9-]*)/g
				let match = pattern.exec(source)
				while (match !== null) {
					const name = match[2]
					if (ids.includes(name) && !roles.includes(name)) {
						const start = match.index + match[1].length
						const end = start + name.length + 1
						// 标记后面若紧跟一个空白（chip 自带一个不换行空格），一起吃掉 —— 免得任务开头留空。
						const tail = /^\s/.test(source.slice(end, end + 1)) ? 1 : 0
						roles.push(name)
						cuts.push({ start: start, end: end + tail })
					}
					match = pattern.exec(source)
				}
				if (roles.length === 0) return { roles: [], task: source.trim(), lastEnd: 0 }
				let task = ''
				let at = 0
				for (const cut of cuts) {
					task += source.slice(at, cut.start)
					at = cut.end
				}
				task += source.slice(at)
				return { roles: roles, task: task.trim(), lastEnd: cuts[cuts.length - 1].end }
			}

			const [open, setOpen] = React.useState(false)
			// 选择框浮在输入框上方：`position:fixed` + portal 到 body ⇒ 这两个数是视口坐标；拿不到 DOM 时退回保守位置。
			const [popAt, setPopAt] = React.useState({ left: 12, bottom: 64 })
			const buttonRef = React.useRef(null)
			const popRef = React.useRef(null)
			const [query, setQuery] = React.useState('')
			const [rows, setRows] = React.useState(null)
			// 名册读失败的原因（与"读到且 0 个角色"分开，设计 4.5）；插入失败时也**不关窗**，给可复制提示。
			const [rosterError, setRosterError] = React.useState('')
			const [insertError, setInsertError] = React.useState(null)
			// 名册里的角色 id（认得 `@名字` 的那些）—— 读到名册之前是空的：先不认，读到之后自动生效。
			const rosterIds = React.useMemo(() => (rows ?? []).map((entry) => text(entry.role)).filter((id) => id !== ''), [rows])
			const marker = rolesInDraftOf(draft, rosterIds)
			/** 文本里点到的角色（**可以多个**：`@qa @fe-dev 一起看看`）。 */
			const roles = marker.roles

			// 打开时（以及打开着的时候换会话）现取一次名册：**现场枚举**，面板上刚加的角色马上叫得动。
			const needRoster = open || /(^|\s)@[a-z]/.test(draft)
			React.useEffect(() => {
				if (!needRoster || rows !== null) return undefined
				let alive = true
				// 与 `@` 菜单、热词典共用同一份带缓存的取数（同一处口径，也省一次往返）。
				rosterRowsOf(workspaceNow, teamSessionId).then((result) => {
					if (!alive) return
					setRows(result.rows)
					setRosterError(text(result.error))
				})
				return () => {
					alive = false
				}
			}, [needRoster, rows, workspaceNow, teamSessionId])

			// 打开时量一次按钮位置（窗口尺寸变化重算）；量的是按钮、改的是视口坐标，不会被 `.composerSeat` 的包含块带偏。
			React.useEffect(() => {
				if (!open) return undefined
				const place = () => {
					const node = buttonRef.current
					if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return
					const rect = node.getBoundingClientRect()
					const inn = typeof window === 'undefined' ? null : window
					const viewport = {
						width: typeof inn?.innerWidth === 'number' ? inn.innerWidth : 1200,
						height: typeof inn?.innerHeight === 'number' ? inn.innerHeight : 800,
					}
					setPopAt(rolePickerPlacement(rect, viewport))
				}
				place()
				if (typeof window.addEventListener !== 'function') return undefined
				window.addEventListener('resize', place)
				return () => window.removeEventListener('resize', place)
			}, [open])

			// 失去焦点就关：点在按钮与选择框之外立刻收起；用 capture 阶段听 `pointerdown`，别的组件 stopPropagation 也收得到。
			React.useEffect(() => {
				if (!open) return undefined
				const inside = (node) => {
					if (node === null || node === undefined) return false
					const pop = popRef.current
					const button = buttonRef.current
					for (const target of [pop, button]) {
						if (target !== null && target !== undefined && typeof target.contains === 'function' && target.contains(node)) return true
					}
					return false
				}
				const onDown = (event) => {
					if (inside(event.target)) return
					setOpen(false)
				}
				document.addEventListener('pointerdown', onDown, true)
				return () => document.removeEventListener('pointerdown', onDown, true)
			}, [open])

			// Esc 关选择框（集中在输入框这一处，不打扰别处）。
			React.useEffect(() => {
				if (!open) return undefined
				const onKey = (event) => {
					// 不 preventDefault：Escape 在浏览器里没有默认动作，`preventDefault` 会改掉别的组件对同一按键的行为；只收起自己。
					if (event.key !== 'Escape') return
					setOpen(false)
					// Esc 关闭后把焦点还给「角色」按钮（设计 4.5 / A-07）。
					try {
						const node = buttonRef.current
						if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
					} catch {}
				}
				document.addEventListener('keydown', onKey)
				return () => document.removeEventListener('keydown', onKey)
			}, [open])

			// 键盘之外还有一条"失焦"：焦点移到选择框与按钮之外（Tab 走掉、点进别的输入）⇒ 同样收起。
			React.useEffect(() => {
				if (!open) return undefined
				const onFocusOut = (event) => {
					const next = event.relatedTarget
					const pop = popRef.current
					const button = buttonRef.current
					for (const target of [pop, button]) {
						if (target !== null && target !== undefined && typeof target.contains === 'function' && (next === null || next === undefined || target.contains(next))) return
					}
					setOpen(false)
				}
				document.addEventListener('focusout', onFocusOut)
				return () => document.removeEventListener('focusout', onFocusOut)
			}, [open])

			// 「清空输入框 = 取消角色」现在**是结构上的事实**：角色就是草稿里的 `@角色名`，
			// 文本没了角色就没了 —— 不需要额外一条状态去同步（原来那条 effect 撤掉了）。

			/**
			 * **把 `@<角色名>` 插进输入框**（人的口径：角色就长在输入框文本里）。
			 *
			 * 三级回落，一级比一级保守：
			 *   ① 会话作用域里的 `conversation` 把手 ⇒ `scope.bail(scope, 'slash/input-insert-text', { text, span })`
			 *      （**正路**，与本体自己插字同一条；离光标最近的插入点 = 我们算的那个 span）；
			 *   ② 退而用把手自己的 `insertText`（同一件事的直调形式）；
			 *   ③ 都没有 ⇒ **只有在草稿是空的时候**才用 `inputActions.setDraft`（空草稿没有 chip 可被冲掉）。
			 * 三者都不行就返回 false：调用方照实提示"请自己打 `@角色名`"（不假装插进去了）。
			 * @param name - 角色 id。
			 * @returns 真的插进去了吗。
			 */
			const insertMarker = (name, category, label) => {
				const markerText = '@' + name + ' '
				// 引用对象的 `source` 必须与**那一组注册出去的来源**逐字相等（分组：一组一个来源）。
				const sourceId = ROLE_SOURCE_ID + ':' + (text(category) === '' ? '未分类' : text(category))
				const access = composerAccessOf(sessionsService, sessionId)
				const snapshot = typeof access.handle?.state?.getSnapshot === 'function' ? access.handle.state.getSnapshot() : null
				const draftRev = snapshot === null || snapshot === undefined ? undefined : snapshot.draftRev
				const source = snapshot === null || snapshot === undefined ? '' : text(snapshot.draft)
				// **插入点按 detect 坐标算**（chip = 一个 `U+FFFC`）：开头那一串"已有的点名"之后。
				// 已有的点名有两种形态：本体插的 chip（detect 里是 `U+FFFC`）与我们退而插的纯文本（`@名字`）。
				const detect = detectTextOf(source, snapshot === null || snapshot === undefined ? null : snapshot.occurrences)
				const opener = /^(?:\s*(?:\uFFFC|@[a-z][a-z0-9-]*)\s*)*/u.exec(detect)
				const at = opener === null ? { start: 0, end: 0 } : { start: opener[0].length, end: opener[0].length }
				const span = draftRev === undefined ? null : { start: at.start, end: at.end, draftRev: draftRev }
				if (span !== null && access.scope !== null && typeof access.scope.bail === 'function') {
					// ① 先试插引用（chip 显示中文名、文本 `@角色名`）；来源没注册过就退成纯文本，绝不把坏 chip 塞进草稿。
					if (roleSourceState.names.has(sourceId)) {
						try {
							const reference = { source: sourceId, ref: name, label: label === '' ? name : label, appearance: 'session', clipboardText: markerText.trimEnd() + '\u00A0' }
							if (access.scope.bail(access.scope, 'slash/input-insert-reference', { reference: reference, span: span }) === true) return true
						} catch {
							// 旧宿主没有这条事件 ⇒ 落到下一级
						}
					}
					// ② 退一步：插**纯文本**（同一处把手，同样不冲掉别人的 chip）。
					try {
						if (access.scope.bail(access.scope, 'slash/input-insert-text', { text: markerText, span: span }) === true) return true
					} catch {
						// 同上
					}
				}
				if (span !== null && typeof access.handle?.insertText === 'function') {
					try {
						if (access.handle.insertText(markerText, span) === true) return true
					} catch {
						// 同上
					}
				}
				if (detect.trim() === '' && setDraft !== null) {
					setDraft(markerText)
					return true
				}
				// 三级都不行：**说一句**（本体的通知面；静默失败会让人以为"选了没反应"）。
				// 这句走的是**宿主的通知面**（纯文本，没有 markdown 渲染）⇒ 不写反引号，直接给那串该打的东西。
				try {
					access.handle?.notify?.('error', '这个会话插不进输入框：自己在输入框打 @' + name + ' 也一样。')
				} catch {
					// 通知面也没有（更老的宿主）⇒ 只能作罢
				}
				return false
			}

			// **不再有"让它去干"那枚动作**（人的判断：本体的发送键就够了 —— `@角色名` 是一枚真 chip，
			// 会原样进消息，那件事由协调者按"点名"那条规矩派下去；再挂一枚按钮就是重复入口）。

			const entries = rows ?? []
			const needle = query.trim().toLowerCase()
			const matched = entries.filter((entry) =>
				needle === '' ? true : [text(entry.role), text(entry.title), text(entry.category), text(entry.positioning)].map((value) => value.toLowerCase()).some((value) => value.includes(needle)),
			)
			const groups = []
			for (const entry of matched) {
				const key = text(entry.category) === '' ? '（未分类）' : text(entry.category)
				const group = groups.find((bucket) => bucket.key === key)
				if (group === undefined) groups.push({ key: key, rows: [entry] })
				else group.rows.push(entry)
			}

			// 按钮永远叫「角色」（选中角色不显示在按钮上，否则没法再选/取消）；选中的显示在旁边小片上：
			// 点正文 = 让它去干，点 `×` = 取消；输入框被清空时也不作数。
			return el(
				'div',
				{ className: 'cbv-rolepick', key: 'rolepick' },
				el(
					'button',
					{
						className: 'cbv-composer-btn',
						key: 'pick',
						type: 'button',
						ref: buttonRef,
						'aria-expanded': open ? 'true' : 'false',
						'aria-controls': 'cbv-rolepick-pop',
						'data-composer-role': roles.join(' '),
						onClick: () => setOpen((value) => !value),
					},
					// 一枚图标（人的指令：「另外给角色配置一个图标」）：与头像用同一套描边几何。
					el('span', { className: 'cbv-composer-btn-icon', key: 'icon', 'aria-hidden': 'true' }, avatarIconOf('user')),
					'角色',
				),
				!open
					? null
					// portal 到 `document.body`：就地渲染会落在宿主输入框的包含块里，`fixed` 被带偏（现场"选择框右移、跟按钮对不上"）。
					: portalOf(el(
							'div',
							{
								id: 'cbv-rolepick-pop',
								className: 'cbv-rolepick-pop',
								key: 'pop',
								role: 'dialog',
								'aria-label': '选一个角色',
								ref: popRef,
								style: { left: popAt.left + 'px', bottom: popAt.bottom + 'px' },
							},
						el(
							'div',
							{ className: 'cbv-rolepick-head', key: 'head' },
							el('input', {
									className: 'cbv-rolepick-search',
									key: 'search',
									type: 'text',
									'data-composer-role-field': 'search',
									value: query,
									placeholder: '搜索角色名称、分类或关键词',
									autoFocus: true,
									onChange: (event) => setQuery(event.target.value),
							}),
						),
							el(
								'div',
								{
									className: 'cbv-picker',
									key: 'list',
									role: 'listbox',
									'data-composer-role-list': '' + matched.length,
									'data-composer-phase': rows === null ? 'loading' : rosterError !== '' ? 'error' : rows.length === 0 ? 'empty' : matched.length === 0 ? 'filtered' : 'ready',
								},
								rows === null
									? // 加载：3 行骨架（头像圆 + 一行短条），`aria-busy`；不显示「没有匹配」。
										el(
											'div',
											{ className: 'cbv-picker-skel', key: 'loading', 'aria-busy': 'true' },
											el('span', { className: 'cbv-sr-only', key: 'say' }, '正在读取角色名册…'),
											[0, 1, 2].map((index) =>
												el(
													'span',
													{ className: 'cbv-picker-skel-row', key: 'r' + index, 'aria-hidden': 'true' },
													el('span', { className: 'cbv-skel-avatar', key: 'av' }),
													el('span', { className: 'cbv-skel-line', key: 'line' }),
												),
											),
										)
									: rosterError !== ''
										? el(
												'div',
												{ className: 'cbv-pane-empty', key: 'error', 'data-composer-error': '' },
												'读不到角色名册：' + rosterError,
												el(
													'button',
													{
														className: 'cbv-btn',
														key: 'retry',
														type: 'button',
														'data-composer-retry': '',
														onClick: () => {
															setRosterError('')
															setRows(null)
														},
													},
													'重试',
												),
											)
										: rows.length === 0
											? el(
													'div',
													{ className: 'cbv-pane-empty', key: 'empty', 'data-composer-empty': '' },
													el('div', { key: 'say1' }, '角色目录里还没有角色。'),
													el('div', { key: 'say2', className: 'cbv-mp-field-note' }, '在「角色」块添加后，这里立刻能选。'),
												)
											: matched.length === 0
												? el(
														'div',
														{ className: 'cbv-pane-empty', key: 'none' },
														'没有匹配的角色。',
														el('button', { className: 'cbv-btn', key: 'clear', type: 'button', 'data-composer-clear-search': '', onClick: () => setQuery('') }, '清除搜索'),
													)
										: groups.map((group) =>
												el(
													'div',
													{ className: 'cbv-picker-group', key: group.key },
													el('div', { className: 'cbv-picker-head', key: 'head' }, group.key),
													group.rows.map((entry) => {
														const id = text(entry.role)
														/**
														 * 选中一行：把 `@角色名` 写进输入框 —— 角色从此长在文本里，改/删都由你。
														 * 插不进去（旧宿主没有本体那套输入服务）就**照实说**：关窗，提示自己打 `@角色名`
														 * —— 不假装插进去了。`onClick` 与键盘 Enter / Space 走**同一段**。
														 */
														const activate = () => {
															// **插入成功才关窗**（设计 4.5 / A-20）：失败时选择框留着，行下方给可复制的提示。
															const inserted = insertMarker(id, text(entry.category), text(entry.title))
															if (inserted) {
																setInsertError(null)
																setOpen(false)
																return
															}
															setInsertError(id)
														}
														return el(
															'div',
															{
																className: 'cbv-picker-row' + (roles.includes(id) ? ' cbv-picker-row--on' : ''),
																key: id,
																role: 'option',
																tabIndex: 0,
																'aria-selected': roles.includes(id) ? 'true' : 'false',
																'data-composer-role-id': id,
																onClick: activate,
																// 行是 `div`（浏览器对它没有内建的激活行为）⇒ 只绑 `onClick` 对纯键盘的人是死路。
																// Enter / Space = 选中；↑ ↓ = 把焦点挪到相邻一行。
																onKeyDown: (event) => {
																	if (event === null || event === undefined) return
																	if (event.key === 'Enter' || event.key === ' ') {
																		event.preventDefault()
																		activate()
																		return
																	}
																	if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
																	event.preventDefault()
																	movePickerFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)
																},
															},
															el('span', { className: 'cbv-mp-avatar cbv-mp-avatar--' + (text(entry.avatarTone) === '' ? 'exec' : text(entry.avatarTone)), key: 'av', 'aria-hidden': 'true' }, avatarIconOf(entry.avatar)),
															// **只留角色图标 + 角色名**（人的指令）：分类由上面的组标题给，
															// id / 定位句 / "已在场"这些都不印 —— 一行一角色，扫得快。
															el('span', { className: 'cbv-picker-text', key: 'text' }, el('span', { className: 'cbv-picker-name', key: 'name' }, text(entry.title) === '' ? text(entry.role) : text(entry.title))),
														)
													}),
												),
											),
							),
							// 插入失败：**不关窗**、给可复制的同一串（设计 4.5 / A-20）。
							insertError === null
								? null
								: el(
										'div',
										{ className: 'cbv-pane-empty cbv-picker-insert-error', key: 'insert-error', 'data-composer-insert-error': insertError },
										el('div', { key: 'say' }, '这个会话插不进输入框：自己在输入框打 @' + insertError + ' 也一样。'),
										el(
											'button',
											{
												className: 'cbv-btn',
												key: 'copy',
												type: 'button',
												'data-composer-copy-marker': insertError,
												onClick: () => {
													void copyText('@' + insertError + ' ')
												},
											},
											'复制 @' + insertError,
										),
									),
						)),
			)
		}

		// ── ⑫ 成员块 ─────────────────────────────────────────────────────
		/**
		 * 「成员」块（视图栏第一块，打开面板即落在这里）：**本会话现在有哪些 agent**。
		 *
		 * 数据**只有一个来源**：本会话的 Agent 团队名册（宿主 `ctx.agentTeams`，与内置 `list_agents`
		 * 同一处正文）—— 协调者永远在最前，其后是队友（`running` / `inactive` / `provisioning` / `failed`）。
		 * **本插件起没起过成员都不影响它** ⇒ 这块不会"一个 agent 都不展示"。
		 * 旧名册文件（`.ops/members.json`）已撤（task-40）：面板不读它，也没有"在册 / 未入册"了。
		 * 卡上只读的几格各自的真源：运行时状态（活着的 Agent）、**已停用**（`.ops/member-flags.json`）、
		 * 未读（邮箱文件）、头像与色调（引擎按角色给）。
		 *
		 * **这一块只读**：成员是**宿主原生的队友**，本插件不改、不删、不启停；卡上只有服务端给的那三个动词
		 * （停用 / 恢复 / 打断，`row.verbs`），停用与打断的口径挂在各自按钮的 title 上（服务端 `why` 原文）。
		 * **角色目录不在这里** —— 它是「角色」块（⑬ `RolesView`）；生成员也不在这里（那是 `member_spawn`）。
		 * @param props - `sessions` 取当前会话（工作区与团队名册都按它拿）；
		 *   `reload` 是面板的重读计数（切块 / 窗口回到前台 / 面板重新可见时 +1）；读失败时本块给一枚「重读」。
		 */
		function MembersView(props) {
			const active = props.active !== false
			const store = props.sessions === undefined ? null : typeof props.sessions === 'function' ? props.sessions() : props.sessions
			const workspace = useCurrentWorkspace(store)
			// 会话 id 必须带上：团队名册是按**这个会话**拿的（`?session=`），少了它宿主只能报"读不到"。
			// 子智能体对话里点开面板时，折到**根会话**（团队挂在领队那个会话上）。
			const sessionId = useCurrentSessionId(store)
			const teamSessionId = teamSessionIdOf(store, sessionId)
			const target = membersUrlOf(workspace, teamSessionId)
			const [snapshot, setSnapshot] = React.useState({ phase: 'loading' })
			const [localTick, setLocalTick] = React.useState(0)
			// 团队服务那一层的开 / 关：**只有人点了那个按钮、并在确认浮窗里点过确认才动**。
			const [svcBusy, setSvcBusy] = React.useState(false)
			// 服务未启用时用现有 `GET /team-service` 读一次 `bundle.enabled`，据此决定画「启用」还是「关闭」。
			const [serviceInfo, setServiceInfo] = React.useState(null)
			// 三个筛选：身份 chip（全部 / 协调者 / 已停用）+ 运行时状态下拉 + 搜索；
			// 一排只放一个 facet、同级互斥（不能再叠加），键形如 `lead` / `disabled` / `runtime:inactive`。
			const [memberFacet, setMemberFacet] = React.useState('all')
			const [query, setQuery] = React.useState('')
			// 块顶回执（设计 ⑥.1）：`{ tone, lines, retry? }`；**下一次同块动作开始时先清旧的**。
			const [notice, setNotice] = React.useState(null)
			// 正在发的那个动词（`名字:动词`）—— 只用来禁用同一张卡上的按钮。
			const [memberBusy, setMemberBusy] = React.useState(null)
			// 确认浮窗（打断 / 团队服务开关）：`null` = 没开；开着时带 `{ kind, name, busy, error }`。
			const [confirm, setConfirm] = React.useState(null)
			// 防重复提交的**同步**闸：两次点击落在同一轮里时 state 还没更新，只有 ref 顶得住。
			const busyRef = React.useRef(false)
			const svcBusyRef = React.useRef(false)
			const serviceProbe = React.useRef(false)
			// 最近的跨角色交接单（`/collab`，只读辅助信息；拿不到就不显示那一行）。
			const [handoffNotes, setHandoffNotes] = React.useState([])
			const showSkeleton = useSkeletonVisible(snapshot.phase === 'loading')

			React.useEffect(() => {
				if (!active) return () => {}
				let cancelled = false
				if (typeof fetch !== 'function') {
					setSnapshot({ phase: 'error', error: '当前环境没有 fetch' })
					return () => {}
				}
				// **重取失败不覆盖旧数据**（设计 ⑥.3）：手里已有读数时保留它，只标 `stale`。
				getJsonCached(target)
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						if (cancelled) return
						if (payload === null) {
							setSnapshot((current) => (current.phase === 'ready' ? { phase: 'ready', data: current.data, stale: true } : { phase: 'error', error: 'HTTP ' + response.status + '：响应不是 JSON' }))
							return
						}
						if (payload.ok === true) {
							setSnapshot({ phase: 'ready', data: payload })
							return
						}
						setSnapshot((current) => (current.phase === 'ready' ? { phase: 'ready', data: current.data, stale: true } : { phase: 'error', error: typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status }))
					})
					.catch((error) => {
						if (cancelled) return
						setSnapshot((current) => (current.phase === 'ready' ? { phase: 'ready', data: current.data, stale: true } : { phase: 'error', error: '' + error }))
					})
				return () => {
					cancelled = true
				}
				// props.reload：面板的重读计数；localTick：本块那几个动作之后自己重取；active：只有当前块取数。
			}, [props.reload, localTick, target, active])

			// 最近交接：与名册并行取；失败静默（辅助信息，不挡成员卡）。
			React.useEffect(() => {
				if (!active) return () => {}
				let cancelled = false
				if (typeof fetch !== 'function') return () => {}
				getJsonCached(collabUrlOf(workspace, teamSessionId))
					.then((response) => response.json().then((payload) => payload, () => null))
					.then((payload) => {
						if (cancelled) return
						setHandoffNotes(payload !== null && payload.ok === true && Array.isArray(payload.handoffs) ? payload.handoffs : [])
					})
					.catch(() => {
						if (!cancelled) setHandoffNotes([])
					})
				return () => {
					cancelled = true
				}
			}, [props.reload, localTick, workspace, teamSessionId, active])

			const data = snapshot.phase === 'ready' ? snapshot.data : null
			// **主表 = 原生名册那一份**（`merged`）：task-40 起这是**唯一**来源。
			const rows = data !== null && Array.isArray(data.merged) ? data.merged : []
			const team = data !== null && data.team !== undefined && data.team !== null && typeof data.team === 'object' ? data.team : null
			const teamAvailable = team !== null && team.available === true
			const warnings = data !== null && Array.isArray(data.warnings) ? data.warnings : []

			// 团队服务「关了还是开着」：只在**服务当前不可用**时读一次（不新增端点、不轮询）。
			React.useEffect(() => {
				if (!active || snapshot.phase !== 'ready' || teamAvailable || serviceProbe.current === true) return
				serviceProbe.current = true
				if (typeof fetch !== 'function') return
				// 读端点照规矩走**唯一的取数出口**（`getJsonCached`）：它不改任何东西，也不需要绕缓存。
				getJsonCached(TEAM_SERVICE_ENDPOINT)
					.then((response) => response.json().then((payload) => payload, () => null))
					.then((payload) => {
						if (payload !== null && payload.ok === true && payload.bundle !== null && payload.bundle !== undefined) {
							setServiceInfo({ enabled: payload.bundle.enabled === true, name: text(payload.bundle.name) })
						}
					})
					.catch(() => {
						/* 读不到就当未知：仍给「启用团队服务」那一枚（点了才知道结果） */
					})
			}, [active, snapshot.phase, teamAvailable])

			/** 子会话 id 的**短显示**：只截长的（留尾部 12 位）；截的是显示，不是数据。 */
			const shortSession = (value) => {
				const full = text(value)
				if (full === '') return '—'
				return full.length <= 16 ? full : '…' + full.slice(-12)
			}
			const runtimeWordOf = (value) => MEMBER_RUNTIME_WORDS[value] ?? (value === '' ? '（未记）' : value)
			const runtimeValues = facetValuesOf(rows, 'runtime')
			// 身份与运行时值同级互斥、只留一枚「全部」；每项带自己的计数口径（重叠成员各自计入）。
			const memberFacets = [
				{ key: 'all', label: '全部', match: () => true },
				...MEMBER_STAGES.filter((spec) => spec.key !== 'all').map((spec) => ({ key: spec.key, label: spec.label, match: spec.match })),
				...runtimeValues.map((value) => ({
					key: 'runtime:' + (value === '' ? 'none' : value),
					label: runtimeWordOf(value),
					match: (row) => text(row.runtime) === value,
				})),
			]
			const memberFacetSpec = memberFacets.find((spec) => spec.key === memberFacet) ?? memberFacets[0]
			const memberFacetCount = (spec) => rows.filter((row) => spec.match(row)).length
			const needle = query.trim().toLowerCase()
			const visible = rows.filter((row) => memberFacetSpec.match(row) && (needle === '' || haystackOf(row).indexOf(needle) !== -1))

			/**
			 * 成员那三个动词的发送器（**停用 / 恢复 / 打断**）：POST 之后重取这一块（`localTick`）。
			 *
			 * 服务端给动词（`row.verbs`），客户端只负责发与说结果；回执里 `note` **原样**印出来。
			 * 失败时**不动列表 / 徽标**（设计 ⑥.3：不做乐观更新），给「重试」；`opts.onFailure`
			 * 用来把失败留在**确认浮窗内**（打断那条：浮窗失败时不关）。
			 * @param url - 端点。
			 * @param name - 成员名。
			 * @param verb - 中文动词（回执兜底文案用）。
			 * @param opts - `{ onSuccess, onFailure }`。
			 */
			const postMemberVerb = (url, name, verb, opts) => {
				const options = opts === undefined || opts === null ? {} : opts
				if (busyRef.current) return
				busyRef.current = true
				if (typeof fetch !== 'function') {
					busyRef.current = false
					setNotice({ tone: 'error', lines: ['当前环境没有 fetch'] })
					return
				}
				setMemberBusy(name + ':' + verb)
				setNotice(null)
				fetch(url + paneQueryOf(workspace, teamSessionId), {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ name }),
				})
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						busyRef.current = false
						setMemberBusy(null)
						if (payload !== null && payload.ok === true) {
							setNotice({ tone: 'ok', lines: [text(payload.note) === '' ? verb + '成功：' + name : text(payload.note)] })
							invalidatePanes()
							setLocalTick((value) => value + 1)
							if (typeof options.onSuccess === 'function') options.onSuccess(payload)
							return
						}
						const line = payload !== null && text(payload.error) !== '' ? text(payload.error) : 'HTTP ' + String(response === undefined ? '' : response.status)
						if (typeof options.onFailure === 'function') {
							options.onFailure(line)
							return
						}
						setNotice({ tone: 'error', lines: [line], retry: () => postMemberVerb(url, name, verb, options) })
					})
					.catch((error) => {
						busyRef.current = false
						setMemberBusy(null)
						const line = '发不出去：' + String(error && error.message ? error.message : error)
						if (typeof options.onFailure === 'function') {
							options.onFailure(line)
							return
						}
						setNotice({ tone: 'error', lines: [line], retry: () => postMemberVerb(url, name, verb, options) })
					})
			}
			/**
			 * 卡上那三个动词的按钮：**只看载荷给的 `verbs`**（服务端判过"现在能不能做"，客户端不猜）。
			 *
			 * 不能做（`spec.ok !== true`）时**不用原生 `disabled`**：改用 `aria-disabled` + `aria-describedby`
			 * 指向一枚视觉隐藏的理由（`spec.why` 原文），点击只把理由送进块顶回执、**不发请求**
			 * （设计 P-05：键盘与触摸都拿得到理由，title 不再是唯一入口）。
			 * @param row - 成员行。
			 * @param name - 成员名。
			 * @returns 节点数组（按钮 + 视觉隐藏的理由）。
			 */
			const verbButtonsOf = (row, name) => {
				const verbs = row !== null && row !== undefined && row.verbs !== null && row.verbs !== undefined ? row.verbs : {}
				const busy = memberBusy !== null && String(memberBusy).indexOf(name + ':') === 0
				const buttonOf = (key, label, verb, url) => {
					const spec = verbs[verb]
					// **载荷没给这一格 ⇒ 不画**（那件事在这个上下文里不存在）。
					if (spec === null || spec === undefined) return null
					const why = text(spec.why)
					const unavailable = spec.ok !== true
					const whyId = 'cbv-mem-why-' + String(name).replace(/[^A-Za-z0-9_-]/g, '-') + '-' + verb
					const button = el(
						'button',
						{
							className: 'cbv-cardbtn' + (unavailable ? ' cbv-cardbtn--off' : ''),
							key,
							type: 'button',
							// 临时不可用（正在执行）仍用原生 disabled；条件不允许用 aria-disabled（还能聚焦、能听见理由）。
							disabled: busy,
							'aria-disabled': unavailable ? 'true' : undefined,
							'aria-describedby': unavailable && why !== '' ? whyId : undefined,
							'data-member-verb': verb,
							'data-member-name': name,
							'data-member-verb-ok': unavailable ? 'false' : 'true',
							...(why === '' ? {} : { title: why }),
							onClick: () => {
								if (busyRef.current) return
								if (unavailable) {
									setNotice({ tone: 'ok', lines: [why === '' ? '这个动作现在不可用。' : why] })
									return
								}
								// **打断**会中止当前一轮 ⇒ 先进确认浮窗（取消则零 POST）。
								if (verb === 'interrupt') {
									setNotice(null)
									setConfirm({ kind: 'interrupt', name, busy: false, error: '' })
									return
								}
								postMemberVerb(url, name, label)
							},
						},
						label,
					)
					// 理由单独一根节点（`aria-describedby` 指过来）；不塞进按钮内部，免得重复进可访问名。
					// 理由节点走 markdown 渲染：`spec.why` 原文里带 `**` / 反引号，直接当文本印会在界面上露出标记。
					const whyNode = unavailable && why !== '' ? el('span', { className: 'cbv-sr-only', id: whyId, key: whyId }, markdownNodes(why, whyId)) : null
					return [button, whyNode]
				}
				return [
					buttonOf('disable', '停用', 'disable', MEMBERS_DISABLE_ENDPOINT),
					buttonOf('restore', '恢复', 'restore', MEMBERS_RESTORE_ENDPOINT),
					buttonOf('interrupt', '打断', 'interrupt', MEMBERS_INTERRUPT_ENDPOINT),
				].flat()
			}

			/**
			 * 开 / 关团队服务那一层（DSH 的可选 bundle）。
			 *
			 * 调的是 `pluginManager.setBundleEnabled`（与 GUI 那个开关同一个方法），结果是**原样回显**。
			 * **只由人点按钮 + 确认浮窗确认后才动** —— 不静默改 profile。
			 * @param action - `enable` 或 `disable`。
			 * @param opts - `{ onFailure }`（留在确认浮窗里）。
			 */
			const postTeamService = (action, opts) => {
				const options = opts === undefined || opts === null ? {} : opts
				if (svcBusyRef.current) return
				svcBusyRef.current = true
				if (typeof fetch !== 'function') {
					svcBusyRef.current = false
					setNotice({ tone: 'error', lines: ['当前环境没有 fetch'] })
					return
				}
				setSvcBusy(true)
				setNotice(null)
				fetch(TEAM_SERVICE_ENDPOINT, {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ action }),
				})
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						svcBusyRef.current = false
						setSvcBusy(false)
						if (payload !== null && payload.ok === true) {
							const lines = []
							if (payload.bundle !== null && payload.bundle !== undefined && payload.bundle.enabled === true) lines.push('团队服务已启用（' + text(payload.bundle.name) + '）。')
							else if (payload.bundle !== null && payload.bundle !== undefined) lines.push('团队服务已关闭。')
							else lines.push('DSH 那边回了结果，但这一层没出现在可选能力清单里。')
							if (Array.isArray(payload.warnings)) lines.push(...payload.warnings.map((line) => text(line)))
							setNotice({ tone: 'ok', lines })
							setServiceInfo({ enabled: action === 'enable', name: '' })
							invalidatePanes()
							setLocalTick((value) => value + 1)
							setConfirm(null)
							return
						}
						const lines = [payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status]
						if (payload !== null && Array.isArray(payload.warnings)) lines.push(...payload.warnings.map((line) => text(line)))
						if (typeof options.onFailure === 'function') {
							options.onFailure(lines.join('；'))
							return
						}
						setNotice({ tone: 'error', lines, retry: () => postTeamService(action, options) })
					})
					.catch((error) => {
						svcBusyRef.current = false
						setSvcBusy(false)
						const line = '请求失败：' + (error === null || error === undefined ? '未知错误' : String(error.message ?? error))
						if (typeof options.onFailure === 'function') {
							options.onFailure(line)
							return
						}
						setNotice({ tone: 'error', lines: [line], retry: () => postTeamService(action, options) })
					})
			}

			/** 确认浮窗「确认」：**只有走到这里才发请求**。 */
			const runConfirm = () => {
				if (confirm === null || confirm.busy === true) return
				const current = confirm
				if (current.kind === 'interrupt') {
					setConfirm({ ...current, busy: true, error: '' })
					postMemberVerb(MEMBERS_INTERRUPT_ENDPOINT, current.name, '打断', {
						onSuccess: () => setConfirm(null),
						onFailure: (line) => setConfirm((now) => (now === null ? now : { ...now, busy: false, error: line })),
					})
					return
				}
				const action = current.kind === 'svc-enable' ? 'enable' : 'disable'
				setConfirm({ ...current, busy: true, error: '' })
				postTeamService(action, {
					onFailure: (line) => setConfirm((now) => (now === null ? now : { ...now, busy: false, error: line })),
				})
			}
			const confirmSpecOf = () => {
				if (confirm === null) return { open: false }
				if (confirm.kind === 'interrupt') {
					return {
						open: true,
						title: '打断 ' + confirm.name + ' 当前这一轮？',
						lines: ['只打断它当前这一轮。收件箱里的消息保留；原生名册与两条上限不变；下次 `member_send` 唤醒它照旧接着干。'],
						confirmLabel: '打断',
						busyLabel: '打断中…',
						danger: false,
						busy: confirm.busy === true,
						error: confirm.error,
					}
				}
				if (confirm.kind === 'svc-enable') {
					return {
						open: true,
						title: '启用团队服务？',
						lines: ['会为当前 DSH profile 启用团队服务，所有会话可见。只有你点确认才会执行。'],
						confirmLabel: '启用团队服务',
						busyLabel: '正在打开…',
						danger: false,
						busy: svcBusy,
						error: confirm.error,
					}
				}
				return {
					open: true,
					title: '关闭团队服务？',
					lines: ['关闭后，团队名册与原生任务板会读不到；已产生的任务与成员不删。'],
					confirmLabel: '关闭团队服务',
					busyLabel: '正在关闭…',
					danger: true,
					busy: svcBusy,
					error: confirm.error,
				}
			}

			/**
			 * 一张成员卡：**只读 live 字段**（卡上不再有任何来自旧名册文件的东西）。
			 */
			const cardOf = (row, index) => {
				const name = text(row.name)
				const runtime = text(row.runtime)
				const runtimeTone = runtime === 'running' ? 'present' : runtime === 'failed' ? 'warn' : 'ok'
				const disabled = row.disabled === true
				const avatar = text(row.avatar) === '' ? (row.kind === 'lead' ? 'target' : 'user') : text(row.avatar)
				const tone = text(row.avatarTone) === '' ? (row.kind === 'lead' ? 'exec' : 'eng') : text(row.avatarTone)
				const duty = text(row.description)
				const identity = row.kind === 'lead' ? '协调者' : '队友'
				return el(
					'div',
					{
						className: 'cbv-box cbv-mp-card' + (disabled ? ' cbv-mp-card--off' : ''),
						key: row.key === undefined ? 'mem' + index + '#' + name : row.key,
						'data-mem-kind': text(row.kind),
						'data-mem-name': name,
						'data-mem-id': text(row.session),
						'data-mem-runtime': runtime === '' ? 'unknown' : runtime,
						'data-mem-disabled': disabled ? 'true' : 'false',
					},
					el(
						'div',
						{ className: 'cbv-mp-top', key: 'top' },
						el('span', { className: 'cbv-mp-avatar cbv-mp-avatar--' + tone, key: 'av' }, avatarIconOf(avatar)),
						el(
							'div',
							{ className: 'cbv-mp-nameblock', key: 'names' },
							el('div', { className: 'cbv-mp-name', key: 'name' }, name === '' ? '（无名）' : name),
							el(
								'div',
								{ className: 'cbv-badges', key: 'badges' },
								el('span', { className: 'cbv-badge' + (row.kind === 'lead' ? ' cbv-badge--present' : ''), key: 'kind' }, identity),
								runtime === '' ? null : el('span', { className: 'cbv-badge cbv-badge--' + runtimeTone, key: 'runtime' }, runtimeWordOf(runtime)),
								disabled
									? el(
											'span',
											{
												className: 'cbv-badge cbv-badge--warn',
												key: 'disabled',
												'data-mem-disabled-badge': 'true',
												title: '本插件不再派活给它（不占角色槽位）；它在宿主原生界面里仍然可以打开对话',
											},
											'已停用',
										)
									: null,
							),
							el(
								'div',
								{ className: 'cbv-mp-sub', key: 'sub' },
								'会话 ' + shortSession(row.session) +
									(text(row.model) === '' ? '' : ' · 模型 ' + text(row.model)) +
									(text(row.provider) === '' ? '' : ' · 提供者 ' + text(row.provider)) +
									(text(row.context) === '' ? '' : ' · 上下文 ' + text(row.context)),
							),
						),
					),
					el(
						'div',
						{ className: 'cbv-mp-duty', key: 'duty' },
						duty !== '' ? duty : row.kind === 'lead' ? '拆解 · 派发 · 把关 · 收口' : '（原生没给这一条的 description）',
					),
					el(
						'div',
						{ className: 'cbv-mp-row', key: 'session' },
						el('span', { className: 'cbv-mp-key', key: 'k' }, '子会话 '),
						text(row.session) === '' ? '（原生没给会话 id）' : shortSession(row.session),
					),
					// 最近交接：这一位最近一次作为接收方（`to`）或发出方（`from`）；没有就不画这一行。
					(() => {
						const roleId = text(row.roleId)
						const note = handoffNotes
							.slice()
							.reverse()
							.find((item) => text(item.to) === name || (roleId !== '' && text(item.to) === roleId) || text(item.from) === name)
						if (note === undefined) return null
						return el(
							'div',
							{ className: 'cbv-mp-row', key: 'handoff' },
							el('span', { className: 'cbv-mp-key', key: 'k' }, '最近交接 '),
							`${text(note.from)} → ${text(note.to)}：${text(note.artifact)}`,
						)
					})(),
					// 动作条：三个动词由服务端给（`row.verbs`）；不能做的也画出来（`aria-disabled` + 理由）。
					(() => {
						const actions = verbButtonsOf(row, name).filter((node) => node !== null && node !== undefined)
						return actions.length === 0 ? null : el('div', { className: 'cbv-cardbar', key: 'actions' }, ...actions)
					})(),
				)
			}

			// **落空与读失败都给人下一步**：前者清掉筛选，后者当场重读一次。
			const clearFilters = () => {
				setMemberFacet('all')
				setQuery('')
			}
			const retry = () => {
				invalidatePanes()
				setLocalTick((value) => value + 1)
			}

			// 加载态：**工具栏位置不动**（骨架与内容同一外层高度），3 张卡骨架（设计 5.3）。
			if (snapshot.phase === 'loading') {
				return el(
					'div',
					{ className: 'cbv-view cbv-mp cbv-mp--pane', 'data-members-phase': 'loading', 'data-members-state': 'ok', 'data-members-mark': PANE_MARK },
					el(
						'div',
						{ className: 'cbv-flt-bar', key: 'skeleton-toolbar', 'aria-hidden': 'true' },
						el('span', { className: 'cbv-skel-chip cbv-skel-chip--wide', key: 'c0' }),
						el('span', { className: 'cbv-skel-chip', key: 'c1' }),
						el('span', { className: 'cbv-skel-search', key: 's' }),
					),
					el('span', { className: 'cbv-sr-only', key: 'say' }, '正在读取本会话的成员与 agent…'),
					showSkeleton ? el(SkeletonList, { kind: 'members', label: '正在读取本会话的成员与 agent…' }) : null,
				)
			}
			// 整块错误态：只印那一行错误 + 一枚「重读」，不渲染卡 / 条 / 数 —— "读不成"不等于"不存在"。
			if (snapshot.phase === 'error') {
				return el(
					'div',
					{ className: 'cbv-view cbv-mp cbv-mp--pane', 'data-members-phase': 'error', 'data-members-state': 'degraded', 'data-members-mark': PANE_MARK },
					el('div', { className: 'cbv-msg cbv-msg--error' }, '读不到成员名册：' + snapshot.error),
					el('button', { className: 'cbv-btn', key: 'retry', type: 'button', 'data-pane-retry': 'members', onClick: retry }, '重读'),
				)
			}

			// 筛选行**永远画**：主表里有团队那一份（协调者至少一行），所以不存在"未建立时画出来就是筛完剩 0 张卡"。
			const toolbar = el(
				'div',
				{ className: 'cbv-flt-bar', key: 'toolbar' },
				el(
					'span',
					{ className: 'cbv-badges', key: 'facets', 'data-members-facets': '' + memberFacets.length },
					memberFacets.map((spec) =>
						el(
							'button',
							{
								className: 'cbv-flt-chip' + (spec.key === memberFacetSpec.key ? ' cbv-flt-chip--on' : ''),
								key: spec.key,
								type: 'button',
								'data-members-facet': spec.key,
								'aria-pressed': spec.key === memberFacetSpec.key ? 'true' : 'false',
								onClick: () => setMemberFacet(spec.key),
							},
							spec.label + ' ' + memberFacetCount(spec),
						),
					),
				),
				el('input', {
					className: 'cbv-input cbv-flt-search',
					key: 'query',
					type: 'search',
					value: query,
					placeholder: '搜索：名字 / 编号 / 角色 / 职责 / 会话 / 模型…',
					'aria-label': '搜索成员',
					onChange: (event) => setQuery(event.target.value),
					onKeyDown: (event) => {
						// Esc 清空搜索并**保持焦点**（设计 4.1）。
						if (event !== null && event !== undefined && event.key === 'Escape') {
							event.preventDefault()
							setQuery('')
						}
					},
				}),
				// 「关闭团队服务」只在已启用时出现（设计 4.1：关闭入口只在已启用时出现）。
				teamAvailable
					? el('button', { className: 'cbv-btn cbv-btn--mini', key: 'svc-disable', type: 'button', 'data-team-service': 'disable', disabled: svcBusy, onClick: () => { setNotice(null); setConfirm({ kind: 'svc-disable', busy: false, error: '' }) } }, '关闭团队服务')
					: null,
			)

			const nothingAtAll = rows.length === 0
			const filteredOut = rows.length > 0 && visible.length === 0
			const state = nothingAtAll ? 'empty' : filteredOut ? 'filtered' : warnings.length > 0 || !teamAvailable || snapshot.stale === true ? 'degraded' : 'ok'
			const body = nothingAtAll
				? el(
						'div',
						{ className: 'cbv-pane-empty', key: 'empty' },
						teamAvailable
							? '本会话的 agent 名册是空的（连协调者都没有 —— 这不正常，重启一下会话看看）。'
							: '读不到本会话的 agent 名册 —— 见上面的告警。',
						el('button', { className: 'cbv-btn', key: 'reload', type: 'button', 'data-empty-action': 'members-retry', onClick: retry }, '重读'),
					)
				: visible.length === 0
					? el(
							'div',
							{ className: 'cbv-pane-empty cbv-pane-empty--filters', key: 'nofilter' },
							el('span', { key: 'word' }, `没有匹配的条目（本会话共 ${rows.length} 条）。`),
							el('button', { className: 'cbv-btn', key: 'clear', type: 'button', 'data-filters-clear': 'members', onClick: clearFilters }, '清除筛选'),
						)
					: el('div', { className: 'cbv-mp-grid', key: 'grid' }, visible.map((row, index) => cardOf(row, index)))

			return el(
				'div',
				{
					className: 'cbv-view cbv-mp cbv-mp--pane',
					'data-members-mark': PANE_MARK,
					'data-members-phase': 'ready',
					'data-members-state': state,
					'data-members-team': teamAvailable ? 'true' : 'false',
					'data-members-rows': '' + rows.length,
					'data-members-total': '' + rows.length,
					'data-members-visible': '' + visible.length,
				},
				warnings.map((line, index) => el('div', { className: 'cbv-pane-warn cbv-md', key: 'warn' + index }, markdownNodes(line, 'members-warn' + index))),
				snapshot.stale === true
					? el(
							'div',
							{ className: 'cbv-pane-warn cbv-md', key: 'stale' },
							markdownNodes('显示的是上一次读数（这一次没读到最新的）。', 'members-stale'),
							el('button', { className: 'cbv-btn', key: 'stale-retry', type: 'button', 'data-stale-retry': 'members', onClick: retry }, '重读'),
						)
					: null,
				// 团队服务不在时给一个显式按钮（不静默改 profile）：点了先确认、确认后才动，结果原样回显。
				!teamAvailable
					? el(
							'div',
							{ className: 'cbv-acts', key: 'team-service' },
							el(
								'button',
								{
									className: 'cbv-btn cbv-btn--primary',
									key: 'svc-toggle',
									type: 'button',
									disabled: svcBusy,
									'data-team-service': serviceInfo !== null && serviceInfo.enabled === true ? 'disable' : 'enable',
									onClick: () => {
										setNotice(null)
										setConfirm({ kind: serviceInfo !== null && serviceInfo.enabled === true ? 'svc-disable' : 'svc-enable', busy: false, error: '' })
									},
								},
								serviceInfo !== null && serviceInfo.enabled === true ? '关闭团队服务' : '启用团队服务',
							),
						)
					: null,
				toolbar,
				// 回执紧贴工具栏下方（设计 P-14）：成功 `role=status`、失败 `role=alert`。
				el(NoticeBar, {
					slot: 'members',
					tone: notice === null ? null : notice.tone,
					lines: notice === null ? [] : notice.lines,
					onRetry: notice === null ? undefined : notice.retry,
					onClose: () => setNotice(null),
				}),
				el('div', { className: 'cbv-scroll', key: 'scroll' }, body),
				el(
					ConfirmDialog,
					{
						...confirmSpecOf(),
						slot: confirm === null ? 'members' : confirm.kind,
						onConfirm: runConfirm,
						onCancel: () => {
							if (confirm !== null && confirm.busy === true) return
							setConfirm(null)
						},
					},
				),
			)
		}


		// ── ⑬ 角色块 ─────────────────────────────────────────────────────
		/**
		 * 「角色」块：本机现场枚举的角色目录（包内 / 用户根 / 项目根）。
		 *
		 * 人的指令：原来挂在「成员」卡区下面那一整节**拆出来独立成一块** —— 这一块只画角色目录：
		 * 来源筛选、角色卡（修改 / 导出这一个 / 下架 · 删除 · 恢复）、
		 * 「导出」「导入」「＋ 添加角色」、未建立提示、已下架行、添加 / 修改弹窗与角色包弹窗。
		 * **成员是另一块**（成员卡、筛选、那三个动词），两块不再挤在同一个滚动区里。
		 *
		 * 数据与「成员」块**同一份**：`/members` 载荷里的 `defaults`（引擎 `defaultRosterOf` ——
		 * 与会话工具 `member_defaults` 同一个函数），读取走同一个缓存出口（`getJsonCached`，
		 * 两块共用 TTL）⇒ 切块不会为同一份载荷多付一次等待；`skillOptions` 也在同一份载荷里
		 * （专属技能多选的候选）。
		 * @param props - `sessions` 取当前会话（工作区与角色根都跟着它）；
		 *   `reload` 是面板的重读计数（切块 / 窗口回到前台 / 面板重新可见时 +1）。
		 */
		function RolesView(props) {
			const store = props.sessions === undefined ? null : typeof props.sessions === 'function' ? props.sessions() : props.sessions
			const workspace = useCurrentWorkspace(store)
			// 会话 id 必须带上：角色根按会话解析（`?session=`），少了它宿主只能按全局层回落。
			// 子智能体对话里点开面板时，折到**根会话**（角色目录与技能候选跟着领队那一份）。
			const sessionId = useCurrentSessionId(store)
			const teamSessionId = teamSessionIdOf(store, sessionId)
			const target = membersUrlOf(workspace, teamSessionId)
			const [snapshot, setSnapshot] = React.useState({ phase: 'loading' })
			// 本块自己的重读计数：角色那几类写动作（增删改 / 恢复 / 导入）之后重取这一块。
			const [localTick, setLocalTick] = React.useState(0)
			// 「角色」这一块的**来源筛档**（null = 全部）：档位与标签都来自载荷。
			const [rosterOriginFacet, setRosterOriginFacet] = React.useState(null)
			// 那三个动作（添加 / 修改 / 删或下架）各自的形状：**同时只可能开一个**。
			const [rosterDialog, setRosterDialog] = React.useState(null)
			const [rosterDraft, setRosterDraft] = React.useState({ id: '', title: '', category: '', positioning: '', body: '', skills: '' })
			// 「专属技能」那个**多选下拉**是否展开（收起时也要看得出选了哪些 ⇒ 摘要那一行）
			const [skillsOpen, setSkillsOpen] = React.useState(false)
			const [rosterBusy, setRosterBusy] = React.useState(null)
			const [rosterNotice, setRosterNotice] = React.useState(null)
			/** 角色包导入的预览窗：`null` = 没开；开着时带包文本、预览结论与两个选择。 */
			const [packDialog, setPackDialog] = React.useState(null)
			// 浮窗内的错误（设计 ⑥.3：失败时浮窗不关，错误显示在浮窗内）：角色表单 / 删除确认各一条。
			const [rosterError, setRosterError] = React.useState('')
			// 防重复提交的同步闸（state 在同一轮里还没更新，只有 ref 顶得住两次点击）。
			const busyRef = React.useRef(false)
			const showSkeleton = useSkeletonVisible(snapshot.phase === 'loading')
			// 浮窗可达性：Esc 关、Tab 圈闭、打开时聚焦、关闭归还焦点（与详情浮窗共用 `useModalA11y`）。
			const rosterModalRef = useModalA11y(rosterDialog !== null && text(rosterDialog.kind) !== 'remove', () => {
				if (rosterBusy === null) setRosterDialog(null)
			})
			const packModalRef = useModalA11y(packDialog !== null, () => setPackDialog(null))
			const active = props.active !== false

			React.useEffect(() => {
				if (!active) return () => {}
				let cancelled = false
				if (typeof fetch !== 'function') {
					setSnapshot({ phase: 'error', error: '当前环境没有 fetch' })
					return () => {}
				}
				getJsonCached(target)
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						if (cancelled) return
						if (payload === null) {
							setSnapshot((current) => (current.phase === 'ready' ? { phase: 'ready', data: current.data, stale: true } : { phase: 'error', error: 'HTTP ' + response.status + '：响应不是 JSON' }))
							return
						}
						if (payload.ok === true) {
							setSnapshot({ phase: 'ready', data: payload })
							return
						}
						setSnapshot((current) => (current.phase === 'ready' ? { phase: 'ready', data: current.data, stale: true } : { phase: 'error', error: typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status }))
					})
					.catch((error) => {
						if (cancelled) return
						setSnapshot((current) => (current.phase === 'ready' ? { phase: 'ready', data: current.data, stale: true } : { phase: 'error', error: '' + error }))
					})
				return () => {
					cancelled = true
				}
				// props.reload：面板的重读计数；localTick：角色那几个写动作之后自己重取；active：只有当前块取数。
			}, [props.reload, localTick, target, active])

			const data = snapshot.phase === 'ready' ? snapshot.data : null

			/** 读失败时那一枚「重读」（与成员块同一条口径：可恢复的失败要有个能再试的入口）。 */
			const retry = () => {
				invalidatePanes()
				setLocalTick((value) => value + 1)
			}

			/**
			 * 角色这几只弹窗共用的外壳：遮罩 + 标题 + 右上角动作区 + 正文。
			 *
			 * 复用详情浮窗那两个类名（`.cbv-overlay` / `.cbv-modal`）：观感与既有的详情窗一致，
			 * 语法上也只是"同一套标记的又一个用处"。
			 * **遮罩点击沿用搬移前的实际行为：不关** —— 搬移前它清的是「成员」弹窗那格 state，
			 * 而成员弹窗早已随成员写面撤掉（点它等于什么也没发生）。这里把这件事写明，
			 * 不再借别人那格 state 表达；关窗仍然只有「取消 / 提交」。
			 */
			const shellOf = (title, actions, bodyNode, { narrow = false, onOverlay = () => {}, modalRef = null } = {}) =>
				el(
					'div',
					{ className: 'cbv-overlay', key: 'overlay', onClick: onOverlay },
					el(
						'div',
						{ className: 'cbv-modal cbv-modal--members' + (narrow ? ' cbv-modal--narrow' : ''), onClick: (event) => event.stopPropagation(), role: 'dialog', 'aria-modal': 'true', 'aria-label': title, ref: modalRef, tabIndex: -1, 'data-members-dialog': title, 'data-roles-dialog': title },
						el(
							'div',
							{ className: 'cbv-modal-head', key: 'head' },
							el('span', { className: 'cbv-modal-title', key: 'title' }, title),
							el('div', { className: 'cbv-modal-actions', key: 'actions' }, actions),
						),
						el('div', { className: 'cbv-modal-body', key: 'body' }, bodyNode),
					),
				)

			/**
			 * 「角色」那三个动作的**写流程**（POST → 原样显示引擎的结论 → 重取）。
			 *
			 * 端点三条（与 host half 常量逐字对齐，有自检）：`/roles/update`（添加 / 修改）、
			 * `/roles/remove`（删或下架）、`/roles/restore`（恢复上架）。
			 * **不猜语义**：回执里那几句（`mode` / `promptRoster` / `promptRosterNote` / 引擎的拒绝理由）
			 * 原样转达 —— "包内角色只能下架"由引擎说，面板不另写一份说辞。引擎那两个字段说的是
			 * **注入到系统提示里那份「可叫的队友」清单**这颗快照旧了（`'stale'`），**不是**工具面不能用：
			 * `member_defaults` / `member_spawn` 现枚举，建完立刻能用。（字段从前叫 `restartRequired`，
			 * 名字本身把"能不能用"挂在重启上，已改名。）
			 * **角色这一面是活的**（人的判断只撤成员那一面）：`handleRoleWrite` 真写用户角色根。
			 */

			const postRoster = (url, body, after, opts) => {
				const options = opts === undefined || opts === null ? {} : opts
				if (busyRef.current) return
				busyRef.current = true
				if (typeof fetch !== 'function') {
					busyRef.current = false
					if (typeof options.onFailure === 'function') options.onFailure('当前环境没有 fetch')
					else setRosterNotice({ tone: 'error', lines: ['当前环境没有 fetch'] })
					return
				}
				setRosterBusy(url)
				setRosterError('')
				setRosterNotice(null)
				// **同一套拼法**（`paneQueryOf`）：宿主拿不到工作区时会**按会话**回落 —— 手拼那一版只带 workspace。
				fetch(url + paneQueryOf(workspace, teamSessionId), {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				})
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						busyRef.current = false
						setRosterBusy(null)
						if (payload !== null && payload.ok === true) {
							setRosterNotice({ tone: 'ok', lines: after(payload) })
							// 写完立刻重取（`localTick` 就是这一块自己的重取计数，与成员那几个动作同一处）。
							invalidatePanes()
							setLocalTick((value) => value + 1)
							if (typeof options.onSuccess === 'function') options.onSuccess(payload)
							return
						}
						const line = payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status
						// **失败不关窗**（设计 ⑥.3）：浮窗类错误留在浮窗内；块内动作给块顶回执 + 重试。
						if (typeof options.onFailure === 'function') {
							options.onFailure(line)
							return
						}
						setRosterNotice({ tone: 'error', lines: [line], retry: () => postRoster(url, body, after, options) })
					})
					.catch((error) => {
						busyRef.current = false
						setRosterBusy(null)
						const line = '请求失败：' + (error === null || error === undefined ? '未知错误' : String(error.message ?? error))
						if (typeof options.onFailure === 'function') {
							options.onFailure(line)
							return
						}
						setRosterNotice({ tone: 'error', lines: [line], retry: () => postRoster(url, body, after, options) })
					})
			}

			/** 恢复上架：一个动作，没有弹窗（不删任何东西，可再来一次）。 */
			const postRosterRestore = (entry) => {
				postRoster(
					ROLES_RESTORE_ENDPOINT,
					{ role: text(entry.role) },
					(payload) => [`已恢复上架：${text(entry.role)}`, ...(Array.isArray(payload.warnings) ? payload.warnings : [])],
					{ onFailure: (line) => setRosterNotice({ tone: 'error', lines: [line], retry: () => postRosterRestore(entry) }) },
				)
			}

			/**
			 * 浮窗里的一行说明（`.cbv-mp-field-note` + markdown）：**一处实现**，
			 * 免得每个说明各写一遍 `el('div', …)`；带 `**` 的说明也不会再被当字面量印出来。
			 * @param value - 说明文本（可含 markdown 的行内标记）。
			 * @param key - React key。
			 * @returns 节点。
			 */
			const note = (value, key) =>
				el('div', { className: 'cbv-mp-field-note cbv-md', key: key }, markdownNodes(value, 'note-' + key))

			/** 三个动作共用的弹窗（形态与成员那两个弹窗同款）。 */
			/** 那一格存的是**逗号分隔的字符串**（与 `patchRoleText` 的契约一致）：拆/拼都只有这一处。 */
			/** 多选下拉**收起时**那一行摘要（空则写「未选」；多了就报个数 + 前几个名字）。 */
			const skillSummaryOf = (names) => (names.length === 0 ? '未选（这个角色没有专属技能）' : names.length <= 3 ? `已选 ${names.length}：${names.join('、')}` : `已选 ${names.length}：${names.slice(0, 3).join('、')} 等`)
			const skillSelected = (value) =>
				text(value)
					.split(',')
					.map((name) => name.trim())
					.filter((name) => name !== '')
			const skillToggle = (value, name) => {
				const now = skillSelected(value)
				const next = now.indexOf(name) === -1 ? [...now, name] : now.filter((item) => item !== name)
				return next.join(', ')
			}
			// ── 角色包：导出 / 导入 ────────────────────────────────────────────────────────
			// 判定全在宿主（`lib/role-pack.js`）：包格式、id、越界、冲突；面板只负责存文件、请求预览、发作用域/冲突、摆回执。
			/** 导出回执（两个入口共用）：把回执印在「角色」那一节的回执行里。 */
			const savePack = (fileName, pack) => {
				try {
					const blob = new Blob([JSON.stringify(pack, null, 2) + '\n'], { type: 'application/json' })
					const url = URL.createObjectURL(blob)
					const anchor = document.createElement('a')
					anchor.href = url
					anchor.download = fileName
					document.body.appendChild(anchor)
					anchor.click()
					document.body.removeChild(anchor)
					// 立刻 revoke 会让部分浏览器取消下载：等一会儿再回收。
					setTimeout(() => URL.revokeObjectURL(url), 4000)
					const roles = Array.isArray(pack?.roles) ? pack.roles.map((role) => text(role.id)) : []
					const skills = Array.isArray(pack?.skills) ? pack.skills.map((skill) => text(skill.name)) : []
					setRosterNotice({
						tone: 'ok',
						lines: [
							`已导出 ${roles.length} 个角色：${roles.join('、')}${skills.length > 0 ? `（随包技能 ${skills.length} 个：${skills.join('、')}）` : ''}`,
							`文件名：${fileName}`,
						],
					})
				} catch (error) {
					setRosterNotice({ tone: 'error', lines: ['导出失败：' + String(error !== null && typeof error === 'object' ? (error.message ?? error) : error)] })
				}
			}
			/** 导出：`role` 给了就是"导出这一个"，不给就是"全部自建角色"。 */
			const exportRoles = (role) => {
				if (typeof fetch !== 'function') {
					setRosterNotice({ tone: 'error', lines: ['当前环境没有 fetch'] })
					return
				}
				setRosterNotice(null)
				const extra = paneQueryOf(workspace, teamSessionId)
				const query = '?scope=all' + (text(role) === '' ? '' : '&role=' + encodeURIComponent(text(role))) + (extra === '' ? '' : '&' + extra.slice(1))
				// 读端点一律走那个**唯一的取数出口**（`getJsonCached`）：导出每次都要最新的现场，
				// 所以带 `force: true` —— 走同一个出口，只是不吃缓存。
				getJsonCached(ROLES_EXPORT_ENDPOINT + query, { force: true })
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						if (payload !== null && payload.ok === true && payload.pack !== undefined) {
							savePack(text(payload.fileName) === '' ? 'roles.dshroles.json' : text(payload.fileName), payload.pack)
							return
						}
						setRosterNotice({ tone: 'error', lines: [payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status] })
					})
					.catch((error) => setRosterNotice({ tone: 'error', lines: ['请求失败：' + String(error !== null && typeof error === 'object' ? (error.message ?? error) : error)] }))
			}
			/** 导入第一步（预览）：把包文本发上去，宿主回"哪些是新的 / 已存在 / 会遮蔽包内角色"。 */
			const previewPack = (textValue, fileName, scope, onConflict) => {
				const nextScope = scope === 'user' ? 'user' : 'workspace'
				const nextConflict = onConflict === 'overwrite' ? 'overwrite' : 'skip'
				setRosterNotice(null)
				setPackDialog({ text: textValue, fileName, scope: nextScope, onConflict: nextConflict, plan: null, busy: true, error: '' })
				if (typeof fetch !== 'function') {
					setPackDialog((current) => (current === null ? current : { ...current, busy: false, error: '当前环境没有 fetch' }))
					return
				}
				fetch(ROLES_IMPORT_ENDPOINT + paneQueryOf(workspace, teamSessionId), {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ pack: textValue, scope: nextScope, onConflict: nextConflict, preview: true }),
				})
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						if (payload !== null && payload.ok === true) {
							setPackDialog((current) => (current === null ? current : { ...current, busy: false, plan: payload.plan, error: '' }))
							return
						}
						setPackDialog((current) => (current === null ? current : { ...current, busy: false, plan: null, error: payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status }))
					})
					.catch((error) => setPackDialog((current) => (current === null ? current : { ...current, busy: false, error: '请求失败：' + String(error !== null && typeof error === 'object' ? (error.message ?? error) : error) })))
			}
			/** 导入入口：开一个文件选择框（只收 JSON）。 */
			const pickPackForImport = () => {
				if (typeof document === 'undefined' || document === null || typeof document.createElement !== 'function') {
					setRosterNotice({ tone: 'error', lines: ['这个环境不给开文件选择框；请把包内容贴进会话。'] })
					return
				}
				try {
					const input = document.createElement('input')
					input.type = 'file'
					input.accept = '.json,application/json'
					input.onchange = () => {
						const file = input.files === null || input.files === undefined ? undefined : input.files[0]
						if (file === undefined) return
						// 客户端先做**大小检查**（与服务端 12 MB 上限同一套）：> 12 MB 直接拒绝并说明，不发请求。
						if (typeof file.size === 'number' && file.size > 12 * 1024 * 1024) {
							setRosterNotice({ tone: 'error', lines: ['这个包超过 12 MB（服务端上限），没有读取。拆成两个包再导入。'] })
							return
						}
						void file.text().then((content) => previewPack(content, file.name, 'workspace', 'skip'))
					}
					input.click()
				} catch (error) {
					setRosterNotice({ tone: 'error', lines: ['开不了文件选择框：' + String(error !== null && typeof error === 'object' ? (error.message ?? error) : error)] })
				}
			}
			/** 导入第二步（落盘）：按预览时选的作用域与冲突策略提交。 */
			const submitPack = () => {
				if (packDialog === null || packDialog.busy === true) return
				setPackDialog((current) => (current === null ? current : { ...current, busy: true, error: '' }))
				fetch(ROLES_IMPORT_ENDPOINT + paneQueryOf(workspace, teamSessionId), {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ pack: packDialog.text, scope: packDialog.scope, onConflict: packDialog.onConflict }),
				})
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						if (payload !== null && payload.ok === true) {
							const line = (list) => list.map((entry) => `${entry.kind === 'role' ? '角色' : '技能'} ${entry.id}`).join('、')
							const lines = [
								`已导入到${payload.scope === 'user' ? '用户级' : '项目级'}：${payload.roleRoot}`,
								`写入 ${payload.imported.length}：${line(payload.imported) || '（无）'}`,
							]
							if (payload.overwritten.length > 0) lines.push(`覆盖 ${payload.overwritten.length}：${line(payload.overwritten)}（原文件已留 .bak）`)
							if (payload.skipped.length > 0) lines.push(`跳过 ${payload.skipped.length}：` + payload.skipped.map((entry) => `${entry.id}（${entry.reason}）`).join('；'))
							setRosterNotice({ tone: 'ok', lines })
							setPackDialog(null)
							invalidatePanes()
							setLocalTick((value) => value + 1)
							return
						}
						setPackDialog((current) => (current === null ? current : { ...current, busy: false, error: payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status }))
					})
					.catch((error) => setPackDialog((current) => (current === null ? current : { ...current, busy: false, error: '请求失败：' + String(error !== null && typeof error === 'object' ? (error.message ?? error) : error) })))
			}
			/** 导入预览窗（先看清单与冲突，再点导入）。 */
			const packDialogOf = () => {
				const plan = packDialog.plan
				const busyNow = packDialog.busy === true
				const marked = (planRole) =>
					[planRole.status === 'exists' ? '目标根里已存在' : '新', planRole.shadowsPackage === true ? '**会遮蔽包内同名角色**' : '', planRole.otherScopeExists === true ? '另一作用域已有同名' : '']
						.filter((value) => value !== '')
						.join(' · ')
				return shellOf(
					'导入角色包',
					[
						el('button', { className: 'cbv-btn', key: 'cancel', type: 'button', 'data-autofocus': '', disabled: busyNow, onClick: () => setPackDialog(null) }, '取消'),
						el('button', { className: 'cbv-btn', key: 'go', type: 'button', disabled: busyNow || plan === null, 'data-pack-submit': '', onClick: submitPack }, busyNow ? '处理中…' : '导入'),
					],
					[
						note(`包：${packDialog.fileName}`, 'pack-file'),
						el(
							'div',
							{ className: 'cbv-mp-field', key: 'scope' },
							el('div', { className: 'cbv-mp-field-label' }, '导入到'),
							el(
								'select',
								{
									className: 'cbv-select',
									'data-pack-field': 'scope',
									value: packDialog.scope,
									disabled: busyNow,
									onChange: (event) => previewPack(packDialog.text, packDialog.fileName, event.target.value, packDialog.onConflict),
								},
								el('option', { value: 'workspace', key: 'workspace' }, '本工作区（缺省）'),
								el('option', { value: 'user', key: 'user' }, '全局（所有工作区都看得见）'),
							),
							note('角色与它引用的技能落在同一作用域。', 'pack-scope-note'),
						),
						el(
							'label',
							{ className: 'cbv-skill-choice', key: 'overwrite', 'data-pack-field': 'overwrite' },
							el('input', {
								type: 'checkbox',
								checked: packDialog.onConflict === 'overwrite',
								disabled: busyNow,
								onChange: (event) => previewPack(packDialog.text, packDialog.fileName, packDialog.scope, event.target.checked ? 'overwrite' : 'skip'),
							}),
							'覆盖已存在的同名角色/技能（覆盖前留一份 .bak）',
						),
						packDialog.error === ''
							? null
							: el('div', { className: 'cbv-mp-field-note', key: 'pack-error' }, packDialog.error),
						busyNow && plan === null
							? el('div', { className: 'cbv-mp-field-note', key: 'pack-busy' }, '正在读这个包…')
							: null,
						plan === null
							? null
							: el(
									'div',
									{ key: 'plan', 'data-pack-plan': '' },
									note(`角色 ${plan.counts.roles} 个（新 ${plan.counts.rolesNew} / 已存在 ${plan.counts.rolesExisting}${plan.counts.rolesShadowingPackage > 0 ? ` / 会遮蔽包内 ${plan.counts.rolesShadowingPackage}` : ''}）；技能 ${plan.skills.length} 个`, 'pack-counts'),
									...plan.roles.map((planRole) => el('div', { className: 'cbv-sub', key: 'r-' + planRole.id, 'data-pack-role': planRole.id }, `${planRole.id} —— ${marked(planRole)}`)),
									...plan.skills.map((planSkill) => el('div', { className: 'cbv-sub', key: 's-' + planSkill.name, 'data-pack-skill': planSkill.name }, `技能 ${planSkill.name} —— ${planSkill.status === 'exists' ? '目标根里已存在' : '新'}`)),
								),
					],
					{ modalRef: packModalRef },
				)
			}
			const rosterDialogOf = () => {
				const kind = rosterDialog.kind
				const draft = rosterDraft
				// **多选那一格的候选**：当前能真实载入的（载荷 `skillOptions`，会话作用域）
				// ∪ 这个角色**已声明的**（本机此刻没有的仍列出来、标「(本机没有)」—— 会话目录会漂移，静默丢就是丢数据）。
				const skillChoices = (() => {
					const listed =
						data !== null && data !== undefined && data.skillOptions !== null && data.skillOptions !== undefined && Array.isArray(data.skillOptions.names)
							? data.skillOptions.names.map((name) => text(name))
							: []
					const out = listed.filter((name) => name !== '').map((name) => ({ name, present: true }))
					for (const name of skillSelected(draft.skills)) {
						if (name !== '' && !out.some((choice) => choice.name === name)) out.push({ name, present: false })
					}
					return out
				})()
				const head = kind === 'create' ? '添加角色' : kind === 'edit' ? `修改角色：${text(rosterDialog.entry.role)}` : text(rosterDialog.entry.removal) === 'hide' ? `下架角色：${text(rosterDialog.entry.role)}` : text(rosterDialog.entry.removal) === 'revert' ? `还原为包内：${text(rosterDialog.entry.role)}` : `删除角色：${text(rosterDialog.entry.role)}`
				const busyNow = rosterBusy !== null
				// 只做**形状预检**（设计 4.2.1）：合法性仍由服务端判（共用 `idShapeOk`）。
				const canSubmit = kind === 'remove' ? true : kind === 'create' ? idShapeOk(draft.id) : true
				const submit = () => {
					if (kind === 'create' || kind === 'edit') {
						if (kind === 'create' && !idShapeOk(draft.id)) {
							setRosterError('角色 id 要匹配 ^[a-z][a-z0-9-]*$（小写字母开头，只含小写字母、数字与单个连字符）。')
							return
						}
						// 修改：空字段 = 不动（服务端语义）；专属技能清空 = 删除 `skills:` 行（允许）。
						const body = {
							...(kind === 'create' ? { id: draft.id.trim() } : { role: text(rosterDialog.entry.role) }),
							title: draft.title.trim(),
							category: draft.category.trim(),
							positioning: draft.positioning.trim(),
							skills: draft.skills.trim(),
							scope: draft.scope,
							...(draft.body.trim() === '' ? {} : { body: draft.body }),
						}
						postRoster(
							ROLES_UPDATE_ENDPOINT,
							body,
							(payload) =>
								kind === 'create'
									? [`已添加角色 ${payload.role}：${payload.file}`, '工具面立刻可用；系统提示里那份队友清单要重启才更新（不影响叫人）。']
									: [`已改 ${payload.role}：${payload.file}`],
							{ onSuccess: () => setRosterDialog(null), onFailure: (line) => setRosterError(line) },
						)
						return
					}
					// 下架 / 删除 / 还原：确认浮窗里点完才走到这里（`runRemoveConfirm`）。
				}
				return shellOf(
					head,
					[
						el('button', { className: 'cbv-btn', key: 'cancel', type: 'button', disabled: busyNow, onClick: () => setRosterDialog(null) }, '取消'),
						el(
							'button',
							{
								className: 'cbv-btn ' + (kind === 'remove' ? 'cbv-btn--bad' : ''),
								key: 'go',
								type: 'button',
								disabled: busyNow || canSubmit !== true,
								// 动词化（设计 6.2）：主按钮写清会发生什么，不用「确定」。
								'data-roster-submit': kind,
								onClick: submit,
							},
							busyNow ? '提交中…' : kind === 'create' ? '添加' : kind === 'edit' ? '保存' : text(rosterDialog.entry.removal) === 'hide' ? '下架' : text(rosterDialog.entry.removal) === 'revert' ? '还原' : '删除角色',
						),
					],
					kind === 'remove'
						? [
								note(text(rosterDialog.entry.removal) === 'hide' ? '下架：本工作区不再列它，可恢复。' : text(rosterDialog.entry.removal) === 'revert' ? '还原：删掉用户根里的同名覆盖。' : '真删：删除用户角色根里这个目录。'),
							]
						: [
								// 六格**同形**：标签一行、控件一行、说明一行（说明走 `.cbv-mp-field-note` + markdown，
								// 与成员弹窗那两处同一套；`**` 不再被当字面量印出来）。
								kind === 'create'
									? el(
											'div',
											{ className: 'cbv-mp-field', key: 'id' },
											el('div', { className: 'cbv-mp-field-label' }, '角色 id'),
											el('input', { className: 'cbv-input', 'data-autofocus': '', 'data-roster-field': 'id', value: draft.id, onChange: (event) => setRosterDraft((current) => ({ ...current, id: event.target.value })), placeholder: '例如 data-label' }),
											note('小写 kebab-case。', 'id-note'),
										)
									: null,
								el(
									'div',
									{ className: 'cbv-mp-field', key: 'title' },
									el('div', { className: 'cbv-mp-field-label' }, '显示名'),
									el('input', { className: 'cbv-input', ...(kind === 'edit' ? { 'data-autofocus': '' } : {}), 'data-roster-field': 'title', value: draft.title, onChange: (event) => setRosterDraft((current) => ({ ...current, title: event.target.value })), placeholder: kind === 'edit' ? '（空＝这一格不动）' : '例如 数据标注' }),
									note('清单上那一格', 'title-note'),
								),
								// **作用域**（HD-008）：缺省"本工作区"；"全局"必须人显式点 —— 判据写在下面那行说明里。
								el(
									'div',
									{ className: 'cbv-mp-field', key: 'scope' },
									el('div', { className: 'cbv-mp-field-label' }, '写在哪'),
									// **下拉**（人的追加要求：圆点改列表；选项文字与说明沿用）
									el(
										'select',
										{
											className: 'cbv-select',
											'data-roster-field': 'scope',
											value: draft.scope,
											onChange: (event) => setRosterDraft((current) => ({ ...current, scope: event.target.value })),
										},
										el('option', { value: 'workspace', key: 'workspace' }, '本工作区（缺省）'),
										el('option', { value: 'user', key: 'user' }, '全局（所有工作区都看得见）'),
									),
									note('项目专属选本工作区；跨项目复用才选全局。', 'scope-note'),
								),
								el(
									'div',
									{ className: 'cbv-mp-field', key: 'category' },
									el('div', { className: 'cbv-mp-field-label' }, '分类'),
									el('input', { className: 'cbv-input', 'data-roster-field': 'category', value: draft.category, onChange: (event) => setRosterDraft((current) => ({ ...current, category: event.target.value })), placeholder: kind === 'edit' ? '（空＝这一格不动）' : '例如 数据 / 研发 / 质量' }),
									note('看板上那一枚小字，任意词。', 'category-note'),
								),
								el(
									'div',
									{ className: 'cbv-mp-field', key: 'skills' },
									el('div', { className: 'cbv-mp-field-label' }, '专属技能（可选，多选）'),
									// 多选（HD-007）：候选 = 当前能载入的技能 ∪ 角色已声明的（本机此刻没有的仍列出并标「(本机没有)」，不静默丢）；
									// 草稿仍存逗号分隔串（保存走同一个 `patchRoleText`）；收起时摘要看得出选了哪些，键盘可用、可一键清空。
									el(
										'div',
										{ className: 'cbv-skills-picker', 'data-roster-field': 'skills', 'data-skill-picker': '' },
										el(
											'div',
											{ className: 'cbv-skill-picker-row', key: 'row' },
											el(
												'button',
												{
													className: 'cbv-input cbv-skill-toggle',
													key: 'toggle',
													type: 'button',
													'data-skill-toggle': '',
													'aria-expanded': skillsOpen ? 'true' : 'false',
													onClick: () => setSkillsOpen((value) => !value),
													onKeyDown: (event) => {
														if (event.key === 'Escape') setSkillsOpen(false)
													},
												},
												// **摘要**：收起也看得出选了哪些（没有就写"未选"）
												el('span', { className: 'cbv-skill-summary', 'data-skill-summary': '' }, skillSummaryOf(skillSelected(draft.skills))),
												el('span', { className: 'cbv-skill-caret', 'aria-hidden': 'true' }, skillsOpen ? '▴' : '▾'),
											),
											skillSelected(draft.skills).length === 0
												? null
												: el('button', { className: 'cbv-btn cbv-btn--mini', key: 'clear', type: 'button', 'data-skill-clear': '', onClick: () => setRosterDraft((current) => ({ ...current, skills: '' })) }, '清空'),
										),
										skillsOpen
											? el(
													'div',
													{ className: 'cbv-skill-menu', key: 'menu', 'data-skill-menu': '' },
													...skillChoices.map((choice) =>
														el(
															'label',
															{ className: 'cbv-skill-choice', key: choice.name, 'data-skill-choice': choice.name, 'data-skill-present': choice.present ? 'true' : 'false' },
															el('input', {
																type: 'checkbox',
																'data-skill-option': choice.name,
																checked: skillSelected(draft.skills).indexOf(choice.name) !== -1,
																onChange: () => setRosterDraft((current) => ({ ...current, skills: skillToggle(current.skills, choice.name) })),
															}),
															el('span', {}, choice.name + (choice.present ? '' : '（本机没有）')),
														),
													),
													skillChoices.length === 0 ? el('span', { className: 'cbv-mp-field-note' }, '读不到技能目录。') : null,
												)
											: null,
									),
									note('这个角色自己的作业程序；「(本机没有)」= 此刻载入不了。', 'skills-note'),
								),
								el(
									'div',
									{ className: 'cbv-mp-field', key: 'positioning' },
									el('div', { className: 'cbv-mp-field-label' }, '一句话定位'),
									el('textarea', { className: 'cbv-mp-textarea', 'data-roster-field': 'positioning', rows: 2, value: draft.positioning, onChange: (event) => setRosterDraft((current) => ({ ...current, positioning: event.target.value })), placeholder: kind === 'edit' ? '（空＝这一格不动）' : '例如 对标注质量与一致性负责。' }),
									note('会写进 front matter 的 `description`。', 'positioning-note'),
								),
								kind === 'create'
									? el(
											'div',
											{ className: 'cbv-mp-field', key: 'body' },
											el('div', { className: 'cbv-mp-field-label' }, '补充正文（可选）'),
											el('textarea', { className: 'cbv-mp-textarea', 'data-roster-field': 'body', rows: 5, value: draft.body, onChange: (event) => setRosterDraft((current) => ({ ...current, body: event.target.value })), placeholder: '检查表 / 落点 / 产物形态 —— 可以留空，之后直接编辑那个 ROLE.md 也行' }),
											note('成员动手前会读它。', 'body-note-text'),
										)
									: note('正文改不动，直接编辑 ROLE.md。', 'body-note'),
								rosterError === ''
									? null
									: el('div', { className: 'cbv-note cbv-note--danger', key: 'roster-error', 'data-roles-error': '' }, rosterError),
							],
						{ narrow: true, modalRef: rosterModalRef }
					)
			}


			// 加载态：工具栏 / 骨架位置固定（骨架 3 张角色卡，工具栏保留 —— 设计 5.3 / P-06）。
			if (snapshot.phase === 'loading') {
				return el(
					'div',
					{ className: 'cbv-view cbv-mp cbv-mp--pane', 'data-roles-phase': 'loading', 'data-roles-state': 'ok', 'data-roles-mark': PANE_MARK },
					el(
						'div',
						{ className: 'cbv-flt-bar', key: 'skeleton-toolbar', 'aria-hidden': 'true' },
						el('span', { className: 'cbv-skel-chip cbv-skel-chip--wide', key: 'c0' }),
						el('span', { className: 'cbv-skel-chip', key: 'c1' }),
						el('span', { className: 'cbv-skel-search', key: 's' }),
					),
					el('span', { className: 'cbv-sr-only', key: 'say' }, '正在读取角色目录…'),
					showSkeleton ? el(SkeletonList, { kind: 'roles', label: '正在读取角色目录…' }) : null,
				)
			}
			// 整块错误态：只印那一行错误文案 + 一枚「重读」—— 读不到不等于没有角色。
			if (snapshot.phase === 'error') {
				return el(
					'div',
					{ className: 'cbv-view cbv-mp cbv-mp--pane', 'data-roles-phase': 'error', 'data-roles-state': 'degraded', 'data-roles-mark': PANE_MARK },
					el('div', { className: 'cbv-msg cbv-msg--error' }, '读不到角色目录：' + snapshot.error),
					el('button', { className: 'cbv-btn', key: 'retry', type: 'button', 'data-pane-retry': 'roles', onClick: retry }, '重读'),
				)
			}

			// 回执紧贴工具栏下方（设计 P-14）：由 `rosterSectionOf` 插在工具行之后。
			const noticeNode = el(NoticeBar, {
				slot: 'roles',
				tone: rosterNotice === null ? null : rosterNotice.tone,
				lines: rosterNotice === null ? [] : rosterNotice.lines,
				onRetry: rosterNotice === null ? undefined : rosterNotice.retry,
				onClose: () => setRosterNotice(null),
			})

			// 那一整套 render 原样搬过来（来源筛选 / 角色卡 / 导出导入 / 未建立 / 已下架）。
			const roster = rosterSectionOf(data, {
				notice: noticeNode,
				// 「导出」前置禁用时点它：不发请求，只把原因说明白（与按钮下方那句同一句话）。
				showNote: (message) => setRosterNotice({ tone: 'ok', lines: [message] }),
				openRosterDialog: (next) => {
					setRosterNotice(null)
					setRosterError('')
					setRosterDialog(next)
					// 每次开窗重置草稿；编辑时四格都带现值（看不到现值等于不能用）。
					// 保存语义：显示名 / 分类 / 定位 空 = 不动；专属技能 空 = 清掉 `skills:` 那一行（允许清空）。
					const entry = next !== null && next.kind === 'edit' ? next.entry : null
					setRosterDraft({
						id: '',
						title: entry === null ? '' : text(entry.title),
						category: entry === null ? '' : text(entry.category),
						positioning: entry === null ? '' : text(entry.positioning),
						body: '',
						// **作用域**（HD-008）：缺省本工作区；全局要人显式选。编辑时按那一份**真实来源**预选
						// （不然打开就是"本工作区"，改一个用户根角色会把作用域悄悄改错）。
						scope: entry !== null && (text(entry.origin) === 'user' || text(entry.origin) === 'workspace') ? text(entry.origin) : 'workspace',
						skills: entry === null || !Array.isArray(entry.skills) ? '' : entry.skills.join(', '),
					})
				},
				restoreRole: postRosterRestore,
				setRosterOriginFacet,
				rosterOriginFacet,
				// 角色包：全部导出 / 导入 / 单个导出（三个动作都只是把参数发给宿主）。
				exportRoles: () => exportRoles(),
				importRoles: pickPackForImport,
				exportOneRole: (entry) => exportRoles(entry === null || entry === undefined ? '' : text(entry.role)),
			})

			// 下架 / 删除 / 还原：确认浮窗里**点确认才发请求**（取消 = 零 POST）。
			const removeEntry = rosterDialog !== null && text(rosterDialog.kind) === 'remove' ? rosterDialog.entry : null
			const removal = removeEntry === null ? '' : text(removeEntry.removal)
			const removeTitle = removeEntry === null ? '' : (removal === 'hide' ? '下架角色：' : removal === 'revert' ? '还原为包内：' : '删除角色：') + text(removeEntry.role)
			const removeLines =
				removeEntry === null
					? []
					: removal === 'hide'
						? ['本工作区不再列出它；不删角色文件；随时可以恢复。']
						: removal === 'revert'
							? ['删掉用户根里的同名覆盖，回到包内那份。不可撤销。']
							: ['删除该角色所在根里 `roles/<id>/` 整个目录（按来源：本工作区根 / 用户根）。不可撤销。']
			const removeLabel = removal === 'hide' ? '下架' : removal === 'revert' ? '还原' : '删除角色'
			const runRemoveConfirm = () => {
				if (removeEntry === null || rosterBusy !== null) return
				postRoster(
					ROLES_REMOVE_ENDPOINT,
					{ role: text(removeEntry.role) },
					(payload) =>
						payload.mode === 'hide'
							? [`已下架：${payload.role}`]
							: payload.mode === 'revert'
								? [`已还原为包内那份：${payload.role}`]
								: [`已删除：${payload.role}`, `删掉的是用户角色根里这个目录：${payload.file}`],
					{ onSuccess: () => setRosterDialog(null), onFailure: (line) => setRosterError(line) },
				)
			}

			// 空态三分（设计 P-07）：真空 / 无 `defaults` / 读不到各有各的话；`data-roles-state` 可区分。
			const block = data !== null && data.defaults !== undefined && data.defaults !== null ? data.defaults : null
			const rowsCount = block !== null && Array.isArray(block.rows) ? block.rows.length : 0
			const facetNow = text(rosterOriginFacet) === '' ? 'all' : text(rosterOriginFacet)
			const shownCount = block === null || !Array.isArray(block.rows) ? 0 : facetNow === 'all' ? rowsCount : block.rows.filter((entry) => text(entry.origin) === facetNow).length
			const state =
				block === null ? 'unsupported' : rowsCount === 0 ? 'empty' : shownCount === 0 ? 'filtered' : snapshot.stale === true ? 'degraded' : 'ok'

			return el(
				'div',
				{
					className: 'cbv-view cbv-mp cbv-mp--pane',
					// 形态标记落在 data 上（不挂 title）：核对时在 DOM 里看 `data-roles-mark` 即可。
					'data-roles-mark': PANE_MARK,
					'data-roles-phase': 'ready',
					'data-roles-state': state,
					'data-roles-total': '' + rowsCount,
					'data-roles-visible': '' + shownCount,
				},
				snapshot.stale === true
					? el(
							'div',
							{ className: 'cbv-pane-warn cbv-md', key: 'stale' },
							markdownNodes('显示的是上一次读数（这一次没读到最新的）。', 'roles-stale'),
							el('button', { className: 'cbv-btn', key: 'stale-retry', type: 'button', 'data-stale-retry': 'roles', onClick: retry }, '重读'),
						)
					: null,
				el(
					'div',
					{ className: 'cbv-scroll', key: 'scroll' },
					// 老宿主没有 `defaults` 这一格 ⇒ 如实说一句，不留一整块空白。
					roster === null
						? [noticeNode, el('div', { className: 'cbv-pane-empty', key: 'empty' }, '这一版宿主没有返回角色目录。')]
						: roster,
				),
				rosterDialog === null || text(rosterDialog.kind) === 'remove' ? null : rosterDialogOf(),
				packDialog === null ? null : packDialogOf(),
				el(ConfirmDialog, {
					open: removeEntry !== null,
					slot: 'roles-remove',
					title: removeTitle,
					lines: removeLines,
					confirmLabel: removeLabel,
					busyLabel: removeLabel + '中…',
					danger: removal !== 'hide',
					busy: rosterBusy !== null,
					error: rosterError,
					onConfirm: runRemoveConfirm,
					onCancel: () => {
						if (rosterBusy !== null) return
						setRosterDialog(null)
						setRosterError('')
					},
				}),
			)
		}

		/**
		 * 「技能」块：**当前这套系统带着哪些作业程序**（宿主的技能目录）。
		 *
		 * 与「成员」块是两件事，别混：成员是**人**（戴着角色上场），技能是**可复用的作业程序**；
		 * 角色在自己的 `skills:` 里引用技能（见 《落盘与移交》的"两层"）。这一块列的清单来自**宿主的技能
		 * 注册表**（`ctx.skills`）—— 与会话里技能工具（`skill` / `/斜杠` 那个源）用的是**同一份目录**，
		 * 所以"面板上有的"与"模型能加载的"对得上是结构上的，不是"两边都照约定写"。
		 *
		 * **只读**：查看正文（`/skills/definition`，正文由宿主按 name 现读）、复制正文、复制路径。
		 * 新建 / 删除 / 启停技能**不在这一栏**：那是改盘上的技能文件（别人家的地盘），
		 * 本插件只把宿主已经认下的目录摆出来 —— 不造第二份真相。
		 *
		 * 三条口径照旧：读不到（端点 503）只印那一行**原文**、不假装是空目录；目录真的空、
		 * 与"筛选落空"两句话不共用；`invocation` 那两格缺一档就按"不可调用"画（读不到不印成可用）。
		 * @param props - `sessions` 取当前会话的工作目录（技能有项目级根，跟会话走）；
		 *   `reload` 是面板的重读计数（本块自己不发请求）。
		 */
		// ── ⑭ 技能块 ─────────────────────────────────────────────────────
		function SkillsView(props) {
			const store = props.sessions === undefined ? null : typeof props.sessions === 'function' ? props.sessions() : props.sessions
			const workspace = useCurrentWorkspace(store)
			// 会话 id 必须带上：技能目录按会话层解析（同一根、不同预设不同目录），不带只能读全局层；
			// 子智能体对话折到根会话（子会话没在跑时宿主只能退层并告警）。
			const sessionId = useCurrentSessionId(store)
			const teamSessionId = teamSessionIdOf(store, sessionId)
			const target = skillsUrlOf(workspace, teamSessionId)
			const [snapshot, setSnapshot] = React.useState({ phase: 'loading' })
			const [localTick, setLocalTick] = React.useState(0)
			// 三个写动作（导入 / 新建 / 删除）共用一只浮窗：`{ mode, root, source, name, description, body, busy, error }`。
			const [writer, setWriter] = React.useState(null)
			const [sourceFacet, setSourceFacet] = React.useState('all')
			const [query, setQuery] = React.useState('')
			// 查看正文浮窗：`{ skill, definition }` 或 null；`definition` 单独取（清单里没有正文）。
			const [viewer, setViewer] = React.useState(null)
			const [busy, setBusy] = React.useState(null)
			// 块顶回执（设计 ⑥.1）：`{ tone, lines, retry? }`。
			const [notice, setNotice] = React.useState(null)
			const active = props.active !== false
			const showSkeleton = useSkeletonVisible(snapshot.phase === 'loading')
			// 防重复提交的同步闸（两次点击落在同一轮里时 state 还没更新）。
			const busyRef = React.useRef(false)
			// 浮窗可达性：Esc 关 / Tab 圈闭 / 关闭归还焦点。删除确认走 `ConfirmDialog`（它自己那一套）。
			const writerModalRef = useModalA11y(writer !== null && text(writer.mode) !== 'remove', () => {
				if (writer !== null && writer.busy === true) return
				setWriter(null)
			})
			const viewerModalRef = useModalA11y(viewer !== null, () => setViewer(null))

			React.useEffect(() => {
				if (!active) return () => {}
				let cancelled = false
				if (typeof fetch !== 'function') {
					setSnapshot({ phase: 'error', error: '当前环境没有 fetch' })
					return () => {}
				}
				getJsonCached(target)
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						if (cancelled) return
						if (payload === null) {
							setSnapshot((current) => (current.phase === 'ready' ? { phase: 'ready', data: current.data, stale: true } : { phase: 'error', error: 'HTTP ' + response.status + '：响应不是 JSON' }))
							return
						}
						if (payload.ok === true) {
							setSnapshot({ phase: 'ready', data: payload })
							return
						}
						setSnapshot((current) => (current.phase === 'ready' ? { phase: 'ready', data: current.data, stale: true } : { phase: 'error', error: typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status }))
					})
					.catch((error) => {
						if (cancelled) return
						setSnapshot((current) => (current.phase === 'ready' ? { phase: 'ready', data: current.data, stale: true } : { phase: 'error', error: '' + error }))
					})
				return () => {
					cancelled = true
				}
			}, [props.reload, localTick, target, active])

			/** 取一个技能的正文（宿主按 name 现读**当前**那一份，不缓存 —— 正文改过就拿到新的）。 */
			const loadDefinition = async (name) => {
				if (typeof fetch !== 'function') return null
				// 正文与清单必须**同一个视图层**：所以同样带上 session（少了它可能读到另一个层的那一条）。
				const url = SKILL_DEFINITION_ENDPOINT + '?name=' + encodeURIComponent(name) + paneQueryOf(workspace, teamSessionId)
				const response = await getJsonCached(url)
				const payload = await response.json().catch(() => null)
				if (payload === null || payload.ok !== true) {
					const why = payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status
					setNotice({ tone: 'error', lines: ['读不到技能正文：' + why] })
					return null
				}
				return payload
			}

			const openViewer = async (skill) => {
				setNotice(null)
				setBusy('正在读取正文…')
				try {
					const definition = await loadDefinition(skill.name)
					if (definition !== null) setViewer({ skill, definition })
				} catch (error) {
					setNotice({ tone: 'error', lines: ['读不到技能正文：' + error] })
				} finally {
					setBusy(null)
				}
			}

			/** 「复制正文」：正文不在清单里，所以要现取一次（与浮窗里那个复制按钮同一份文本）。 */
			const copyBody = async (skill) => {
				setNotice(null)
				setBusy('正在读取正文…')
				try {
					const definition = await loadDefinition(skill.name)
					if (definition === null) return
					const copied = await copyText(definition.content)
					setNotice(
						copied.ok
							? { tone: 'ok', lines: [`已复制 ${skill.name} 的正文（${definition.chars} 字）。`, definition.truncated === true ? '注意：宿主那边正文超长，返回的是截断后的一段（详情见浮窗里的那一行）。' : ''].filter((line) => line !== '') }
							: { tone: 'error', lines: ['复制失败：' + copied.reason] },
					)
				} catch (error) {
					setNotice({ tone: 'error', lines: ['读不到技能正文：' + error] })
				} finally {
					setBusy(null)
				}
			}

			/** 「复制路径」：清单里就有（`path`），不用再取一次；没有路径就**如实说没有**。 */
			const copyPath = async (skill) => {
				const path = text(skill.path)
				if (path === '') {
					setNotice({ tone: 'error', lines: [`技能 ${skill.name} 没有指令文件路径（来源「${text(skill.source)}」没给）。`] })
					return
				}
				const copied = await copyText(path)
				setNotice(copied.ok ? { tone: 'ok', lines: ['已复制指令文件路径：' + path] } : { tone: 'error', lines: ['复制失败：' + copied.reason] })
			}

			const data = snapshot.phase === 'ready' ? snapshot.data : null
			const skills = data !== null && Array.isArray(data.skills) ? data.skills : []
			const warnings = data !== null && Array.isArray(data.warnings) ? data.warnings : []

			// **层级筛档**：来自载荷（`facets`）；载荷没给就不画（不自己编档）
			const skillFacets = data !== null && data !== undefined && Array.isArray(data.facets) ? data.facets : []
			const needle = query.trim().toLowerCase()
			const visible = skills.filter(
				(skill) =>
					// **按层级筛**（task-38）：层级由服务端给（`skill.level`），前端不按原始 source 自己判。
					(sourceFacet === 'all' || text(skill.level) === sourceFacet) &&
					(needle === '' || haystackOf(skill).indexOf(needle) !== -1),
			)
			const sourceWordOf = (source) => {
				const key = text(source)
				return key === '' ? '（未标来源）' : SKILL_SOURCE_WORDS[key] ?? key
			}

			const cardOf = (skill, index) => {
				const name = text(skill.name)
				// **两枚标签**（人的口径）：层级（项目级 / 用户级 / 包内，词取载荷 `levelLabel`）+
				// 提供者（载荷 `provider` 原文）。原来那行「来源 … · 提供者 …」不再印 ——
				// 「来源」与层级标签说的是同一件事（随包目录 ≈ 包内），重复。
				const levelLabel = text(skill.levelLabel)
				const provider = text(skill.provider)
				return el(
					'div',
					{
						className: 'cbv-box cbv-sk-card',
						key: 'skill' + index + '#' + name,
						// 形态与判定落在 `data-` 上（不挂 title）：核对的人不必展开 DOM 找文字。
						'data-skill-name': name,
						'data-skill-source': text(skill.source),
						// **层级**（task-38）：`level` / `levelLabel` 都来自载荷
						'data-skill-level': text(skill.level),
						'data-skill-level-label': levelLabel,
						'data-skill-provider': provider,
					},
					el('div', { className: 'cbv-sk-name', key: 'name' }, name === '' ? '（无名）' : name),
					// 层级与提供者都做成标签；两格都没有就不画这一行（不印空行占位）。
					levelLabel === '' && provider === ''
						? null
						: el(
								'div',
								{ className: 'cbv-badges', key: 'badges' },
								levelLabel === '' ? null : el('span', { className: 'cbv-badge', key: 'lvl' }, levelLabel),
								provider === '' ? null : el('span', { className: 'cbv-badge', key: 'prov' }, provider),
							),
					el('div', { className: 'cbv-sk-desc', key: 'desc' }, text(skill.description) === '' ? '（宿主没给这一条的 description）' : text(skill.description)),
					text(skill.whenToUse) === '' ? null : el('div', { className: 'cbv-sk-when', key: 'when' }, '什么时候用它：' + text(skill.whenToUse)),
					el(
						'div',
						{ className: 'cbv-cardbar', key: 'actions' },
						el('button', { className: 'cbv-cardbtn', key: 'view', type: 'button', disabled: busy !== null, onClick: () => openViewer(skill) }, '查看正文'),
						el('button', { className: 'cbv-cardbtn', key: 'copy', type: 'button', disabled: busy !== null, onClick: () => copyBody(skill) }, '复制正文'),
						el('button', { className: 'cbv-cardbtn', key: 'path', type: 'button', onClick: () => copyPath(skill) }, '复制路径'),
						// **只对可写来源画删除**：随包发布的（`bundled`）与别的 agent 的根（`*-agents`）只读
						// —— 写入口那侧同样会拒，两处同一口径（`WRITABLE_SKILL_SOURCES`）。
						WRITABLE_SKILL_SOURCES[text(skill.source)] === undefined
							? null
							: el(
									'button',
									{
										className: 'cbv-cardbtn',
										key: 'remove',
										type: 'button',
										'data-skill-remove': name,
										disabled: busy !== null,
										onClick: () => openWriter({ mode: 'remove', root: WRITABLE_SKILL_SOURCES[text(skill.source)], name }),
									},
									'删除',
								),
					),
				)
			}

			/**
			 * 把拖进来的东西收成 `[{ path, dataBase64 }]`。
			 *
			 * 浏览器只给**文件内容**（拿不到绝对路径），所以走"上传"这条：`webkitGetAsEntry()` 拿到目录条目
			 * 再递归读；`path` 用相对路径（拖一个文件夹时每条都以它开头，宿主那侧会去掉公共前缀）。
			 * 读不到的条目**跳过并计数**（不静默丢，收完在界面上说清）。
			 */
			const collectDropped = async (dataTransfer) => {
				const out = []
				let skipped = 0
				const readFile = async (file, path) => {
					try {
						const buffer = await file.arrayBuffer()
						let binary = ''
						const bytes = new Uint8Array(buffer)
						for (let at = 0; at < bytes.length; at += 1) binary += String.fromCharCode(bytes[at])
						out.push({ path, dataBase64: btoa(binary) })
					} catch {
						skipped += 1
					}
				}
				const walk = async (entry, prefix) => {
					if (entry === null || entry === undefined) return
					const path = prefix === '' ? entry.name : prefix + '/' + entry.name
					if (entry.isFile === true) {
						const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)))
						if (file === null) {
							skipped += 1
							return
						}
						await readFile(file, path)
						return
					}
					if (entry.isDirectory !== true) return
					const reader = entry.createReader()
					const entries = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])))
					for (const child of entries) await walk(child, path)
				}
				const items = dataTransfer === null || dataTransfer === undefined ? [] : Array.from(dataTransfer.items ?? [])
				const entries = items.filter((item) => item.kind === 'file' && typeof item.webkitGetAsEntry === 'function').map((item) => item.webkitGetAsEntry())
				if (entries.length > 0) {
					for (const entry of entries) await walk(entry, '')
					return { files: out, skipped }
				}
				// 退一档：拿不到 entry（老环境）时用 `files`，路径就是文件名本身。
				for (const file of Array.from(dataTransfer?.files ?? [])) await readFile(file, file.name)
				return { files: out, skipped }
			}

			/** 与拖拽同一件事的"手选"路：`<input type=file>` 选完给的是 `File` 清单（`webkitRelativePath` 带目录）。 */
			const collectPicked = async (fileList) => {
				const out = []
				let skipped = 0
				for (const file of Array.from(fileList ?? [])) {
					try {
						const buffer = await file.arrayBuffer()
						let binary = ''
						const bytes = new Uint8Array(buffer)
						for (let at = 0; at < bytes.length; at += 1) binary += String.fromCharCode(bytes[at])
						out.push({ path: text(file.webkitRelativePath) === '' ? file.name : text(file.webkitRelativePath), dataBase64: btoa(binary) })
					} catch {
						skipped += 1
					}
				}
				return { files: out, skipped }
			}

			/** 这一批的实际字节数（base64 逆向估：长度 × 3/4，够用且不解析内容）。 */
			const weightOfFiles = (files) => files.reduce((sum, item) => sum + Math.floor((item.dataBase64.length * 3) / 4), 0)

			/** 收到一批（拖进来或选进来）之后统一落库：文件清单 + 跳过计数 + 体量 + 算出来的技能名。 */
			const takeFiles = (result) => {
				const summary = droppedSummaryOf(result.files)
				const bytes = weightOfFiles(result.files)
				// **先自检，别让请求把连接撑爆**（宿主读到超限会回 413；面板这一步是让人早一步看到原因）。
				const why =
					result.files.length > SKILL_IMPORT_MAX_FILES
						? `这批有 ${result.files.length} 个文件（上限 ${SKILL_IMPORT_MAX_FILES}）。`
						: bytes > SKILL_IMPORT_MAX_BYTES
							? `这批约 ${(bytes / 1024 / 1024).toFixed(1)} MB（上限 ${SKILL_IMPORT_MAX_BYTES / 1024 / 1024} MB）。`
							: summary.hasSkill
								? ''
								: '这批里没有 SKILL.md。'
				setWriter((current) => (current === null ? current : { ...current, files: result.files, skipped: result.skipped, bytes, name: summary.name, error: why }))
			}

			const takeDropped = async (dataTransfer) => {
				if (writer === null) return
				const result = await collectDropped(dataTransfer)
				takeFiles(result)
			}

			/**
			 * 手选：开一个隐藏的 `<input type=file>` 点一下（拖拽的等价路）。
			 * 目录用 `webkitdirectory`（选完每条带 `webkitRelativePath`），文件用 `multiple` + `.md` 过滤。
			 */
			const pickInto = (kind) => {
				if (typeof document === 'undefined' || document === null || typeof document.createElement !== 'function') return
				try {
					const input = document.createElement('input')
					input.type = 'file'
					if (kind === 'dir') input.webkitdirectory = true
					else {
						input.multiple = true
						input.accept = '.md,text/markdown'
					}
					input.onchange = () => void collectPicked(input.files).then((result) => takeFiles(result))
					input.click()
				} catch {
					setWriter((current) => (current === null ? current : { ...current, error: '这个环境不给开文件选择框，请直接拖入。' }))
				}
			}

			/** 收完那一批之后：算一下"这份技能叫什么、几个文件"，摆在拖拽区下面（人就看得见要不要按确定）。 */
			const droppedSummaryOf = (files) => {
				const skillFile = files.find((item) => item.path === 'SKILL.md' || item.path.endsWith('/SKILL.md'))
				if (skillFile === undefined) return { name: '', count: files.length, hasSkill: false }
				const prefix = skillFile.path === 'SKILL.md' ? '' : skillFile.path.slice(0, skillFile.path.length - 'SKILL.md'.length).replace(/\/$/, '')
				const first = prefix === '' ? '' : prefix.split('/')[0]
				const declared = declaredNameIn(skillFile.dataBase64)
				return { name: declared !== '' ? declared : first, count: files.length, hasSkill: true }
			}

			/** 从 base64 的 `SKILL.md` 里读 front-matter 的 `name:`（读不出就给空串）。 */
			const declaredNameIn = (dataBase64) => {
				try {
					const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(atob(dataBase64))
					if (match === null) return ''
					const line = /^\s*name\s*:\s*(.+?)\s*$/m.exec(match[1])
					return line === null ? '' : line[1].replace(/^["']|["']$/g, '').trim()
				} catch {
					return ''
				}
			}

			/** 打开写动作浮窗（三个动作共用）。 */
			const openWriter = (next) => {
				setNotice(null)
				setWriter({ busy: false, error: '', ...next })
			}

			/**
			 * 提交一个写动作（POST 到宿主那三个端点）。
			 *
			 * 判定与落盘在宿主（`lib/skill-write.js`）—— 面板只把回执**原文**摆出来：
			 * 成功印一行"已导入/已新建/已删除 + 名称 + 落在哪个根"，失败印宿主给的那句原因。
			 */
			const submitWriter = async () => {
				if (writer === null || typeof fetch !== 'function') return
				const endpoint =
					writer.mode === 'import' ? SKILLS_IMPORT_ENDPOINT : writer.mode === 'create' ? SKILLS_CREATE_ENDPOINT : SKILLS_REMOVE_ENDPOINT
				if (writer.mode === 'import' && writer.files.length === 0) {
					setWriter({ ...writer, error: '还没收到文件。' })
					return
				}
				if (writer.mode === 'import' && writer.error !== '') return
				// 防重复提交：入口再判一次（state 在同一轮里还是旧的，所以再加一道同步闸）。
				if (busyRef.current || writer.busy === true) return
				busyRef.current = true
				const body =
					writer.mode === 'import'
						? { root: writer.root, name: writer.name, files: writer.files }
						: writer.mode === 'create'
							? { root: writer.root, name: writer.name, description: writer.description, body: writer.body }
							: { root: writer.root, name: writer.name }
				setWriter({ ...writer, busy: true, error: '' })
				try {
					const response = await fetch(endpoint + paneQueryOf(workspace, teamSessionId), {
						method: 'POST',
						headers: { 'content-type': 'application/json', accept: 'application/json' },
						credentials: 'same-origin',
						body: JSON.stringify(body),
					})
					const payload = await response.json().catch(() => null)
					if (payload === null || payload.ok !== true) {
						const why = payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status
						setWriter({ ...writer, busy: false, error: why })
						return
					}
					// 写成功 ⇒ **先清缓存**（这一块自己的重取由下面的 `localTick` 触发）。
					// 放在这里而不是收尾处：面板那条"写动作附近必须失效缓存"的扫描按行距离判，收尾太远会判成漏失效。
					invalidatePanes()
					const word = writer.mode === 'import' ? '已导入' : writer.mode === 'create' ? '已新建' : '已删除'
					// **删技能时同步剪角色那一行**（HD-007）：回执里的 `skillPrune.note` **原样印出来** ——
					// 它逐字说清"改了哪几个用户根角色、还有哪几个包内角色仍声明它"（面板不复述、也不总结成"已同步"）。
					const pruneLines =
						payload.skillPrune !== null && payload.skillPrune !== undefined && text(payload.skillPrune.note) !== ''
							? [`专属技能同步：${text(payload.skillPrune.note)}`]
							: []
					// **这一栏会不会立刻刷新**取决于宿主用上了哪一档失效（`skillCatalog`）：
					// 有失效入口 ⇒ 清单当场重取；一档都没有 ⇒ 如实说"要重启/新会话"。
					const catalogState = text(payload.skillCatalog)
					const refreshLine =
						catalogState === '' || catalogState === 'none' || catalogState === 'no-service'
							? '注册表没有失效入口：重启 DSH 或开新会话才刷新。'
							: '技能目录已失效，正在重取。'
					// **新建了却看不见**（设计 4.3.2）：当前筛选非缺省时补一句；筛选条件由人自己清。
					const filteredNow = sourceFacet !== 'all' || query.trim() !== ''
					const filterLines = filteredNow ? ['它被当前筛选排除了。'] : []
					setNotice({
						tone: 'ok',
						lines: [`${word}技能 \`${text(payload.id)}\`：${text(payload.path)}`, refreshLine, ...pruneLines, ...filterLines],
						...(filteredNow ? { onClearFilters: () => clearFilters() } : {}),
					})
					setWriter(null)
					setLocalTick((value) => value + 1)
				} catch (error) {
					// `Failed to fetch` 这一类是连接层面的失败（宿主没回话）。把可能的原因写出来 ——
					// 但正常路径下不该走到这儿：体量在收集那一步就自检过了，宿主也会回一个能读的 413。
					const raw = String(error)
					setWriter({
						...writer,
						busy: false,
						error: /failed to fetch/i.test(raw)
							? '没能连上宿主（连接被中断）：把技能要用的文件拖进来再试；仍失败就重启 DSH。'
							: raw,
					})
				} finally {
					busyRef.current = false
				}
			}

			/** 写动作浮窗：导入 / 新建 / 删除三态（同一只浮窗，按 `mode` 换字段）。 */
			const writerOverlay = () => {
				const row = (label, node, note) =>
					el(
						'div',
						{ className: 'cbv-mp-field', key: label },
						el('div', { className: 'cbv-mp-field-label', key: 'label' }, label),
						node,
						note === undefined ? null : el('div', { className: 'cbv-mp-field-note', key: 'note' }, note),
					)
				// **写哪一级**（task-38）：选项与文案**都来自载荷** `targets`（服务端那一处正文），
				// 缺省取载荷给的 `targetDefault`（= 项目级）；措辞与「角色」弹窗那一格一致。
				const skillTargets = data !== null && data !== undefined && Array.isArray(data.targets) ? data.targets : []
				const rootPicker = row(
					'落到哪一级',
					skillTargets.length === 0
						? el('div', { className: 'cbv-mp-field-note', key: 'no-targets' }, '读不到技能目录。')
						: el(
								'select',
								{
									className: 'cbv-select',
									'data-skill-root': '',
									value: writer.root,
									onChange: (event) => setWriter({ ...writer, root: event.target.value, error: '' }),
								},
								skillTargets.map((target) =>
									el('option', { value: target.key, key: target.key }, `${text(target.label)} ${text(target.path)}（${'note' in target ? text(target.note).replace(/\*\*/g, '') : ''}）`),
								),
							),
				)
				const fields =
					writer.mode === 'import'
						? [
								rootPicker,
								el(
									'div',
									{ className: 'cbv-mp-field', key: 'drop' },
									el('div', { className: 'cbv-mp-field-label', key: 'label' }, '来源'),
									el(
										'div',
										{
											className: 'cbv-drop' + (writer.busy === true ? '' : ' cbv-drop--on'),
											key: 'zone',
											// 拖拽只是快捷方式：**键盘等价路径**在区上（Enter / Space 打开文件夹选择）。
											tabIndex: 0,
											role: 'group',
											'aria-label': '拖拽技能到此处，或按回车选择文件夹',
											'data-autofocus': '',
											'data-skill-drop': writer.files.length === 0 ? 'empty' : 'ready',
											onKeyDown: (event) => {
												if (event === null || event === undefined) return
												if (event.key === 'Enter' || event.key === ' ') {
													event.preventDefault()
													if (writer.busy !== true) pickInto('dir')
												}
											},
											onDragOver: (event) => {
												event.preventDefault()
											},
											onDrop: (event) => {
												event.preventDefault()
												void takeDropped(event.dataTransfer)
											},
										},
										el('div', { className: 'cbv-drop-title', key: 't' }, '拖拽技能到此处'),
										el('div', { className: 'cbv-drop-note', key: 'n' }, '支持技能文件夹，或单个 SKILL.md'),
										el(
											'div',
											{ className: 'cbv-drop-acts', key: 'a' },
											el('button', { className: 'cbv-drop-link', key: 'dir', type: 'button', 'data-skill-pick': 'dir', onClick: () => pickInto('dir') }, '选择文件夹'),
											el('span', { className: 'cbv-drop-sep', key: 'sep' }, '／'),
											el('button', { className: 'cbv-drop-link', key: 'file', type: 'button', 'data-skill-pick': 'file', onClick: () => pickInto('file') }, '选择文件'),
										),
										// **文件要求写在拖拽区里面**（人的指令）—— 它讲的就是"往这个区里放什么"。
										el(
											'div',
											{ className: 'cbv-drop-req', key: 'req' },
											el('div', { key: 'r1' }, inlineNodes('· 文件夹或单个 `.md`，且必须含 `SKILL.md`', 'req1')),
											el('div', { key: 'r2' }, inlineNodes('· 技能名优先取 `SKILL.md` 里 front-matter 的 `name`，否则取文件夹名', 'req2')),
											el('div', { key: 'r3' }, inlineNodes('· 导入时**复制完整内容**，不动原始来源', 'req3')),
										),
									),
									// 区下面只留**收完之后的那一行读数**（没收东西时不必重复区里那三条）。
									writer.files.length === 0
										? null
										: el(
												'div',
												{
													className: 'cbv-mp-field-note cbv-md',
													key: 'picked',
													'data-skill-picked': '' + writer.files.length,
												},
												markdownNodes(
													`已收 ${writer.files.length} 个文件 · 约 ${(Number(writer.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB${writer.skipped === 0 ? '' : `（${writer.skipped} 个读不到，已跳过）`}；技能名 = ${text(writer.name) === '' ? '（要从 SKILL.md 里读）' : '`' + text(writer.name) + '`'}`,
													'picked',
												),
											),
								),
							]
						: writer.mode === 'create'
							? [
									rootPicker,
									row(
										'技能名',
										el('input', {
											className: 'cbv-input',
											'data-autofocus': '',
											'data-skill-field': 'name',
											value: writer.name,
											placeholder: 'lower-kebab-case，例如 qa-playbook',
											onChange: (event) => setWriter({ ...writer, name: event.target.value, error: '' }),
										}),
									),
									row(
										'一句话说明',
										el('input', {
											className: 'cbv-input',
											'data-skill-field': 'description',
											value: writer.description,
											placeholder: 'Use when …（写清什么时候该用它）',
											onChange: (event) => setWriter({ ...writer, description: event.target.value, error: '' }),
										}),
									),
									row(
										'正文',
										el('textarea', {
											className: 'cbv-mp-textarea',
											'data-skill-field': 'body',
											rows: 8,
											value: writer.body,
											placeholder: '这份技能的作业程序：怎么做、检查什么、产出什么',
											onChange: (event) => setWriter({ ...writer, body: event.target.value, error: '' }),
										}),
									),
								]
							: [
									el(
										'div',
										{ className: 'cbv-mp-field', key: 'confirm' },
										el('div', { className: 'cbv-mp-field-label' }, '确认删除'),
										el(
											'div',
											{ className: 'cbv-note cbv-note--danger cbv-md', 'data-skill-confirm': writer.name },
											markdownNodes(`删掉 \`${writer.name}\`（${skillRootWordOf(writer.root)}）：整棵目录都会没了，这是不可逆的。`, 'confirm'),
										),
									),
								]
				const title = writer.mode === 'import' ? '导入技能' : writer.mode === 'create' ? '新建技能' : '删除技能'
				return el(
					'div',
					{ className: 'cbv-overlay', key: 'overlay', onClick: () => setWriter(null) },
					el(
						'div',
						{
							className: 'cbv-modal cbv-modal--skills cbv-modal--narrow',
							key: 'modal',
							role: 'dialog',
							'aria-modal': 'true',
							'aria-label': title,
							ref: writerModalRef,
							tabIndex: -1,
							'data-skill-dialog': writer.mode,
							onClick: (event) => event.stopPropagation(),
						},
						el(
							'div',
							{ className: 'cbv-modal-head', key: 'head' },
							el('span', { className: 'cbv-modal-title', key: 'title' }, title),
							el(
								'div',
								{ className: 'cbv-modal-actions', key: 'actions' },
								el('button', { className: 'cbv-btn', key: 'cancel', type: 'button', onClick: () => setWriter(null) }, '取消'),
								el(
									'button',
									{
										className: 'cbv-btn',
										key: 'ok',
										type: 'button',
										disabled:
											writer.busy === true ||
											(writer.mode === 'import' && (writer.files.length === 0 || writer.error !== '')) ||
											(writer.mode === 'create' && idShapeOk(writer.name) !== true),
										onClick: () => void submitWriter(),
									},
									writer.busy === true ? '正在提交…' : '确定',
								),
							),
						),
						el(
							'div',
							{ className: 'cbv-modal-body', key: 'body' },
							writer.mode === 'import'
								? el('div', { className: 'cbv-mp-field-note cbv-md', key: 'tip' }, markdownNodes('只写用户级 / 项目级；同名一律拒绝。', 'tip'))
								: null,
							...fields,
							writer.error === '' ? null : el('div', { className: 'cbv-note cbv-note--danger', key: 'error', 'data-skill-error': '' }, writer.error),
						),
					),
				)
			}

			/** 写入口的根名（回执里那一句用；与浮窗里选项的措辞一致）。 */
			const skillRootWordOf = (kind) => (kind === 'project' ? '项目级技能根' : '用户级技能根')

			/** 正文浮窗：`<pre>` 原样摊开（不渲染 Markdown —— 这是一份要**原样**带走/核对的正文）。 */
			const viewerOverlay = () => {
				const definition = viewer.definition
				const content = text(definition.content)
				return el(
					'div',
					{ className: 'cbv-overlay', key: 'overlay', onClick: () => setViewer(null) },
					el(
						'div',
						{ className: 'cbv-modal cbv-modal--skills', onClick: (event) => event.stopPropagation(), role: 'dialog', 'aria-modal': 'true', 'aria-label': viewer.skill.name + ' 技能正文', ref: viewerModalRef, tabIndex: -1, 'data-skill-dialog': viewer.skill.name },
						el(
							'div',
							{ className: 'cbv-modal-head', key: 'head' },
							el('span', { className: 'cbv-modal-title', key: 'title' }, viewer.skill.name),
							el(
								'div',
								{ className: 'cbv-modal-actions', key: 'actions' },
								el(
									'button',
									{
										className: 'cbv-btn',
										key: 'copy',
										type: 'button',
										onClick: async () => {
											const copied = await copyText(content)
											setNotice(copied.ok ? { tone: 'ok', lines: [`已复制 ${viewer.skill.name} 的正文。`] } : { tone: 'error', lines: ['复制失败：' + copied.reason] })
										},
									},
									'复制',
								),
								el('button', { className: 'cbv-btn', key: 'close', type: 'button', onClick: () => setViewer(null) }, '关闭'),
							),
						),
						el(
							'div',
							{ className: 'cbv-modal-body', key: 'body' },
							el(
								'div',
								{ className: 'cbv-pane-note cbv-md', key: 'meta' },
								markdownNodes(
									'来源：' + sourceWordOf(definition.source) + '（`' + text(definition.source) + '`）　提供者：' + (text(definition.provider) === '' ? '（未标）' : text(definition.provider)) + '　路径：' + (text(definition.path) === '' ? '（没给）' : text(definition.path)) + '　' + definition.chars + ' 字',
									'viewer-meta',
								),
							),
							// 宿主那边超长会截断：**截断要说出来**，不能让人以为技能正文就这么短。
							definition.truncated === true
								? el('div', { className: 'cbv-pane-warn cbv-md', key: 'trunc' }, markdownNodes('正文超长，已截断（复制的是截断版）。', 'trunc'))
								: null,
							el('pre', { className: 'cbv-block cbv-pre', key: 'text' }, content === '' ? '（这份技能的文件里没有正文）' : content),
						),
					),
				)
			}

			// **落空与读失败都给人下一步**：前者清掉筛选（级别 / 搜索两个状态一起清），后者当场重读一次。
			// 重读就走本块自己的取数计数（`invalidatePanes()` 把 3 秒缓存清掉，`localTick` 触发 effect）。
			const clearFilters = () => {
				setSourceFacet('all')
				setQuery('')
			}
			const retry = () => {
				invalidatePanes()
				setLocalTick((value) => value + 1)
			}

			// 加载态：工具栏 / 骨架位置固定（骨架 3 张技能卡，工具栏保留 —— 设计 5.3 / P-06）。
			if (snapshot.phase === 'loading') {
				return el(
					'div',
					{ className: 'cbv-view cbv-sk', 'data-skills-phase': 'loading', 'data-skills-state': 'ok', 'data-skills-mark': SKILLS_MARK },
					el(
						'div',
						{ className: 'cbv-flt-bar', key: 'skeleton-toolbar', 'aria-hidden': 'true' },
						el('span', { className: 'cbv-skel-chip cbv-skel-chip--wide', key: 'c0' }),
						el('span', { className: 'cbv-skel-search', key: 's' }),
					),
					el('span', { className: 'cbv-sr-only', key: 'say' }, '正在读取技能目录…'),
					showSkeleton ? el(SkeletonList, { kind: 'skills', label: '正在读取技能目录…' }) : null,
				)
			}
			// 整块错误态：只印那一行原文 —— 「技能注册表读不到」不等于「一个技能都没有」；
			// 加一枚「重读」：宿主刚起来时读不到，界面上要有一个能再试一次的入口。
			if (snapshot.phase === 'error') {
				return el(
					'div',
					{ className: 'cbv-view cbv-sk', 'data-skills-phase': 'error', 'data-skills-state': 'degraded', 'data-skills-mark': SKILLS_MARK },
					el('div', { className: 'cbv-msg cbv-msg--error' }, '读不到技能目录：' + snapshot.error),
					el('button', { className: 'cbv-btn', key: 'retry', type: 'button', 'data-pane-retry': 'skills', onClick: retry }, '重读'),
				)
			}

			const toolbar = el(
				'div',
				{ className: 'cbv-flt-bar', key: 'toolbar' },
				// **级别筛：下拉**（人的口径：技能这块只留这一格下拉 —— 「模型可调用」那排阶段筛已按人的指令撤掉；
				// 档位与标签都来自载荷 `facets`，服务端那一处正文）。
				el(
					'select',
					{ className: 'cbv-select cbv-flt-select', key: 'source', value: sourceFacet, 'aria-label': '按级别筛选', 'data-skill-level-facet': '', onChange: (event) => setSourceFacet(event.target.value) },
					el('option', { value: 'all', key: 'all' }, `全部级别（${skills.length}）`),
					skillFacets.map((facet) => el('option', { value: facet.key, key: facet.key }, `${text(facet.label)}（${facet.count}）`)),
				),
				el('input', {
					className: 'cbv-input cbv-flt-search',
					key: 'query',
					type: 'search',
					value: query,
					placeholder: '搜索：名称 / 描述 / 什么时候用它 / 路径 / 来源…',
					'aria-label': '搜索技能',
					onChange: (event) => setQuery(event.target.value),
					onKeyDown: (event) => {
						// Esc 清空搜索并保持焦点（设计 7.1）。
						if (event !== null && event !== undefined && event.key === 'Escape') {
							event.preventDefault()
							setQuery('')
						}
					},
				}),
				el(
					'span',
					{ className: 'cbv-badges', key: 'manage' },
					el(
						'button',
						{
							className: 'cbv-flt-chip',
							key: 'import',
							type: 'button',
							'data-skill-action': 'import',
							disabled: busy !== null,
							onClick: () => openWriter({ mode: 'import', root: text(data?.targetDefault) === '' ? 'project' : text(data.targetDefault), files: [], skipped: 0, name: '' }),
						},
						'导入技能',
					),
					el(
						'button',
						{
							className: 'cbv-flt-chip',
							key: 'create',
							type: 'button',
							'data-skill-action': 'create',
							disabled: busy !== null,
							onClick: () => openWriter({ mode: 'create', root: text(data?.targetDefault) === '' ? 'project' : text(data.targetDefault), name: '', description: '', body: '' }),
						},
						'新建技能',
					),
				),
			)

			// **这一份是哪一层读到的**：`session` 才是"与模型同一份"；`root-agent` / `global` 是退而求其次
			// （宿主会把"为什么退"写进 `warnings`，这里只决定空态那句话怎么说不许骗人）。
			const layer = text(data.layer) === '' ? 'global' : text(data.layer)
			const body =
				skills.length === 0
					? layer === 'session'
						? el('div', { className: 'cbv-scroll', key: 'scroll' }, el('div', { className: 'cbv-pane-empty', key: 'empty' }, '技能目录是空的。'))
						: el(
								'div',
								{ className: 'cbv-scroll', key: 'scroll' },
								el('div', { className: 'cbv-pane-empty cbv-md', key: 'empty' }, markdownNodes(`没读到会话层的技能目录（按「${layer}」读的，见上面的告警）。`, 'degraded')),
							)
					: visible.length === 0
						// 筛选/搜索落空 ⇒ 说清"没有匹配的条目"并给一枚「清除筛选」：
						// 搜错一个名字就整份清单消失、又没有任何下一步，人会以为数据没了。
						? el(
								'div',
								{ className: 'cbv-scroll', key: 'scroll' },
								el(
									'div',
									{ className: 'cbv-pane-empty cbv-pane-empty--filters', key: 'nofilter' },
									el('span', { key: 'word' }, `没有匹配的条目（共 ${skills.length} 个技能）。`),
									el('button', { className: 'cbv-btn', key: 'clear', type: 'button', 'data-filters-clear': 'skills', onClick: clearFilters }, '清除筛选'),
								),
							)
						: el('div', { className: 'cbv-scroll', key: 'scroll' }, el('div', { className: 'cbv-sk-grid', key: 'grid' }, visible.map((skill, index) => cardOf(skill, index))))

			// 空态三分（设计 P-07 / 5.2）：真空（会话层）/ 退层空 / 筛空 / 读不到，各有各的话。
			const state = skills.length === 0 ? (layer === 'session' ? 'empty' : 'degraded') : visible.length === 0 ? 'filtered' : warnings.length > 0 || snapshot.stale === true ? 'degraded' : 'ok'
			const removeWriter = writer !== null && text(writer.mode) === 'remove' ? writer : null
			const removeError = removeWriter !== null && text(removeWriter.error) !== '' ? text(removeWriter.error) : ''

			return el(
				'div',
				{
					className: 'cbv-view cbv-sk',
					// 形态标记落在 data 上（不挂 title）：核对时在 DOM 里看 `data-skills-mark` 即可。
					'data-skills-mark': SKILLS_MARK,
					'data-skills-phase': 'ready',
					'data-skills-state': state,
					'data-skills-layer': layer,
					'data-skills-total': '' + skills.length,
					'data-skills-visible': '' + visible.length,
				},
				// 技能块不再印内页标题（tab 栏已有「技能」）；宿主那几行原文透出、走渲染（标记不上屏）。
				warnings.map((line, index) => el('div', { className: 'cbv-pane-warn cbv-md', key: 'warn' + index }, markdownNodes(line, 'skills-warn' + index))),
				// 退层时在头上再点一次名（告警可能在视口外）：只说读的是哪一层，"为什么"看下面那行原文。
				layer === 'session' ? null : el('div', { className: 'cbv-pane-warn', key: 'layer' }, `清单读的是「${layer}」层（见下面告警）。`),
				snapshot.stale === true
					? el(
							'div',
							{ className: 'cbv-pane-warn cbv-md', key: 'stale' },
							markdownNodes('显示的是上一次读数（这一次没读到最新的）。', 'skills-stale'),
							el('button', { className: 'cbv-btn', key: 'stale-retry', type: 'button', 'data-stale-retry': 'skills', onClick: retry }, '重读'),
						)
					: null,
				toolbar,
				// 回执紧贴工具栏下方（设计 P-14）：成功 `role=status`、失败 `role=alert`。
				el(NoticeBar, {
					slot: 'skills',
					tone: notice === null ? null : notice.tone,
					lines: notice === null ? [] : notice.lines,
					onRetry: notice === null ? undefined : notice.retry,
					onClearFilters: notice === null ? undefined : notice.onClearFilters,
					onClose: () => setNotice(null),
				}),
				body,
				viewer === null ? null : viewerOverlay(),
				writer === null || removeWriter !== null ? null : writerOverlay(),
				// 删除技能：确认浮窗（动词化 + 危险级 + 默认焦点取消）；取消 = 零写入。
				el(ConfirmDialog, {
					open: removeWriter !== null,
					slot: 'skills-remove',
					title: removeWriter === null ? '' : '删除技能：' + text(removeWriter.name),
					lines:
						removeWriter === null
							? []
							: [`删除${text(removeWriter.root) === 'user' ? '用户级' : '项目级'}技能根里 \`${text(removeWriter.name)}/\` 整个目录。不可撤销。`],
					confirmLabel: '删除技能',
					busyLabel: '删除中…',
					danger: true,
					busy: removeWriter !== null && removeWriter.busy === true,
					error: removeError,
					onConfirm: () => void submitWriter(),
					onCancel: () => {
						if (removeWriter !== null && removeWriter.busy === true) return
						setWriter(null)
					},
				}),
			)
		}

		/** 一个视图 = 一份文件：同一套取数、筛选、分栏，只换卡片与界面约径。 */
		// ── ⑮ 任务看板块 ───────────────────────────────────────────────────
		function LedgerView(props) {
			const spec = props.spec
			// 作为首屏的「展开明细」内嵌时不重复占输入框槽：同一个槽 id 注册两次，谁压谁不好说。
			useComposerHidden(props.hideComposer === false ? null : props.slots === undefined ? null : props.slots)
			// 每次渲染现取一次：服务迟到时也能在下一轮渲染接上（同一服务的引用是稳定的，
			// 所以下面那句 useEffect 的依赖不会来回变）。
			const store = props.sessions === undefined ? null : typeof props.sessions === 'function' ? props.sessions() : props.sessions
			const workspace = useCurrentWorkspace(store)
			// **同一套拼法**：宿主拿不到工作区时会按会话回落 —— 手拼只带 workspace 的那一版少了那条路。
			const sessionId = useCurrentSessionId(store)
			const target = spec.endpoint + paneQueryOf(workspace, sessionId)
			const [snapshot, setSnapshot] = React.useState({ phase: 'loading' })
			const [query, setQuery] = React.useState('')
			const [facet, setFacet] = React.useState('all')
			// 详情浮窗：null = 关着；否则是正在看的那一条的编号（按编号从当前数据里取，保证数据是新的）。
			const [detail, setDetail] = React.useState(null)
			// 批准 / 驳回的确认流与详情浮窗都走**共用**那一份（详情浮窗里也是同一套）。

			React.useEffect(() => {
				let cancelled = false
				if (typeof fetch !== 'function') {
					setSnapshot({ phase: 'error', error: '当前环境没有 fetch' })
					return () => {}
				}
				getJsonCached(target)
					.then((response) =>
						response.json().then(
							(payload) => ({ response, payload }),
							() => ({ response, payload: null }),
						),
					)
					.then(({ response, payload }) => {
						if (cancelled) return
						if (payload === null) {
							setSnapshot({ phase: 'error', error: 'HTTP ' + response.status + '：响应不是 JSON' })
							return
						}
						if (payload.ok === true) {
							setSnapshot({ phase: 'ready', data: payload })
							return
						}
						const detail = typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status
						setSnapshot({ phase: 'error', error: detail })
					})
					.catch((error) => {
						if (cancelled) return
						setSnapshot({ phase: 'error', error: '' + error })
					})
				return () => {
					cancelled = true
				}
			// props.reload：面板的重读计数（切块 / 窗口回到前台 / 面板重新可见时 +1）。
			}, [props.reload, target])

			// 浮窗的键盘 / 焦点行为（Esc 关、← → **切换分栏**、打开后聚焦）走共用那一份。
			const navRef = React.useRef({ ordered: [], index: -1 })
			const modalRef = useDetailModal(detail, () => setDetail(null), (offset) => step(offset), (offset) => columnStep(offset))

			const data = snapshot.phase === 'ready' ? snapshot.data : null
			const absent = data !== null && data.absent === true
			const items = data !== null && Array.isArray(data.items) ? data.items : []
			const facetValues = facetValuesOf(items, spec.facetField)

			const needle = query.trim().toLowerCase()
			const filtered = []
			for (let i = 0; i < items.length; i++) {
				const item = items[i]
				if (facet !== 'all' && '' + item[spec.facetField] !== facet) continue
				if (needle.length > 0 && haystackOf(item).indexOf(needle) === -1) continue
				filtered.push(item)
			}
			// 栏从哪来：默认按 `status` 分（`bucketsOf`）；`spec.columnsOf` 给了就听它的 ——
			// 里程碑那一档就是这样把栏换成 `phase`（同一套取数 / 筛选 / 详情翻页，只换分栏轴）。
			const customColumns = typeof spec.columnsOf === 'function'
			const rawColumns = customColumns ? spec.columnsOf(filtered, spec) : bucketsOf(filtered, spec)
			const columns = rawColumns.map((column) => ({
				key: column.key ?? column.name,
				label: column.label ?? spec.statusLabel(column.name),
				tone: column.tone ?? spec.tone(column.name),
				note: column.note,
				flagged: column.flagged === true,
				// 「枚举外的状态」这一档**只在默认（按状态分栏）时有意义**：按 `phase` 分栏时，
				// "没登记的阶段"另有栏上那个标记说（两件事不混成一句）。
				canonical: column.canonical !== false,
				// 空栏那句话可以由 `spec.columnsOf` 给（"这一批还没有条目" vs "清单里已登记但还没活"）。
				emptyText: column.emptyText,
				items: column.items,
			}))
			// 浮窗里翻页只在"当前这一项所属的那一栏"内走动，不跨栏：顺序 = 该栏在屏幕上的栏内序，不是状态文件里的顺序。
			const orderedItems = []
			if (detail !== null) {
				for (let i = 0; i < columns.length; i++) {
					// 先认出这一项属于哪一栏，再只把那一栏的条目放进来；认不出（例如被筛选挡掉）就留空，两个按钮都不可点。
					let mine = false
					for (let j = 0; j < columns[i].items.length && !mine; j++) mine = text(columns[i].items[j].id) === detail.id
					if (mine) {
						for (let j = 0; j < columns[i].items.length; j++) orderedItems.push(columns[i].items[j])
						break
					}
				}
			}
			const detailIndex = detail === null ? -1 : orderedItems.findIndex((entry) => text(entry.id) === detail.id)
			// 键盘翻页要在 keydown 回调里读"当前这一份"：用 ref 承载，免得把每次渲染都变的数组写进依赖。
			navRef.current = { ordered: orderedItems, index: detailIndex }
			const step = (offset) => {
				const current = navRef.current
				const at = current.index + offset
				if (at < 0 || at >= current.ordered.length) return
				setDetail({ id: text(current.ordered[at].id) })
			}

			/**
			 * **切换分栏**（← → 用的那一步）：从当前项所在栏往 `offset` 方向走，遇到空栏跳过，
			 * 落在那一栏里**同一个位置**（不够就落在它最后一个）；到底了就不动。
			 */
			const columnStep = (offset) => {
				const at = columns.findIndex((column) => column.items.some((entry) => text(entry.id) === detail.id))
				if (at < 0) return
				const mineAt = columns[at].items.findIndex((entry) => text(entry.id) === detail.id)
				for (let i = at + offset; i >= 0 && i < columns.length; i += offset) {
					const list = columns[i].items
					if (list.length === 0) continue
					const target = list[Math.min(Math.max(mineAt, 0), list.length - 1)]
					setDetail({ id: text(target.id) })
					return
				}
			}

			const nonCanonical = []
			if (!customColumns) {
				for (let i = 0; i < columns.length; i++) {
					if (!columns[i].canonical) nonCanonical.push(columns[i].label + '(' + columns[i].items.length + ')')
				}
			}

			let body = null
			if (snapshot.phase === 'loading') {
				body = el('div', { className: 'cbv-msg', key: 'body' }, '正在读取文件…')
			} else if (snapshot.phase === 'error') {
				body = el('div', { className: 'cbv-msg cbv-msg--error', key: 'body' }, '读取失败：' + snapshot.error)
			} else if (absent) {
				body = el(
					'div',
					{ className: 'cbv-pane-empty', key: 'body' },
					'这个工作区还没有这份文件：' + (typeof data.path === 'string' ? data.path : '') + '（有内容后自动出现，无需刷新。）',
				)
			} else if (columns.length === 0) {
				body = el('div', { className: 'cbv-pane-empty', key: 'body' }, '没有匹配的条目（文件共 ' + (data === null ? 0 : data.total) + ' 条）。')
			} else {
				const card = CARDS[spec.ledger]
				body = el(
					'div',
					{ className: 'cbv-board', key: 'body' },
					columns.map((column) =>
						el(
							'div',
							{ className: 'cbv-col', key: column.key, 'data-col-key': column.key, ...(column.flagged ? { 'data-col-flagged': 'true' } : {}) },
							el(
								'div',
								{ className: 'cbv-col-head', key: 'head' },
								el('span', { className: 'cbv-dot', key: 'dot', style: { backgroundColor: TONE_VAR[column.tone] } }),
								el('span', { className: 'cbv-col-name', key: 'name' }, column.label),
								el('span', { className: 'cbv-col-count', key: 'count' }, '' + column.items.length),
								column.flagged ? el('span', { className: 'cbv-chip cbv-chip--exception', key: 'flag' }, '未登记进里程碑清单') : null,
							),
							// 栏头下面那一句（里程碑那一档用来印出口准则 / 清单登记状态）；没有就不占行。
							column.note === undefined || column.note === null || column.note === ''
								? null
								: el('div', { className: 'cbv-col-note', key: 'note' }, column.note),
							el(
								'div',
								{ className: 'cbv-col-body', key: 'body' },
								column.items.length === 0
									? el('div', { className: 'cbv-empty', key: 'empty' }, column.emptyText ?? '暂无')
									: column.items.map((item, index) => {
											const cardKey = column.key + '#' + index + '#' + text(item.id)
											return card(item, false, () => setDetail({ id: text(item.id) }), cardKey, spec.cardOptions)
										}),
							),
						),
					),
				)
			}

			// 不再有"栏头"分支（本包只有面板内嵌这一种用法，`showHeader:false`）；半死代码会误导后续改动。
			const embedded = props.showHeader === false
			return el(
				'div',
				{ className: embedded ? 'cbv-root cbv-root--embed' : 'cbv-root', ...(embedded ? {} : { 'data-team-ops-pane': '' }) },
				nonCanonical.length > 0
					? el('div', { className: 'cbv-note', key: 'warn' }, '文件里存在不属于引擎枚举的状态，已单列显示：' + nonCanonical.join('、'))
					: null,
				el(
					'div',
					{ className: 'cbv-flt-bar', key: 'filters' },
					// 调用方塞进来的**前置 chip**（看板块的来源分档就是它）：与成员/技能那一条筛选行
					// 合成同一条 —— 四块都只有"一条筛选行"，不再有一块是另画的输入行。
					props.leadingFilter === undefined || props.leadingFilter === null ? null : props.leadingFilter,
					el('span', { className: 'cbv-spacer', key: 'spacer' }),
					el(
						'select',
						{ className: 'cbv-flt-select cbv-select', key: 'facet', value: facet, 'aria-label': spec.facetAll, onChange: (event) => setFacet(event.target.value) },
						el('option', { value: 'all' }, spec.facetAll),
						facetValues.map((value) => el('option', { key: value, value }, value)),
					),
					el('input', {
						className: 'cbv-flt-search cbv-input',
						key: 'query',
						type: 'text',
						placeholder: spec.searchHint,
						'aria-label': '搜索',
						value: query,
						onChange: (event) => setQuery(event.target.value),
					}),
				),
				body,
				detail === null
					? null
					: (() => {
							const current = items.filter((entry) => text(entry.id) === detail.id)[0]
							if (current === undefined) return null
							// 浮窗本体走共用那一份（detailOverlayOf）：翻页在**该条所在那一栏**内走。
							return detailOverlayOf(spec, current, orderedItems, detailIndex, step, () => setDetail(null), modalRef, labelOfColumn(columns, current))
						})(),
			)
		}

		/** 插入本插件自己的样式表；随 Plugin 一起销毁。 */
		// ── ⑯ 装配与导出 ───────────────────────────────────────────────────
		const insertStyles = () => {
			if (typeof document === 'undefined' || document === null) return () => {}
			const style = document.createElement('style')
			style.setAttribute('data-dsh-team-ops', 'ledger-views')
			style.textContent = CSS
			;(document.head || document.body).appendChild(style)
			return () => {
				try {
					if (style.parentNode !== null) style.parentNode.removeChild(style)
				} catch {}
			}
		}

		/**
		 * 客户端插件体：注册**一个席位** —— 对话窗视图栏里那一栏（「团队状态」）。
		 *
		 * 一栏四块（块序见 `BLOCKS`）：**成员 / 角色 / 技能 / 任务看板**。
		 * 打开面板就是"现在到哪了"那一屏（三行状态 + 块切换 + 工作区），
		 * 四块共用同一份取数纪律：每条读数都来自引擎或宿主的**同一处判定**，本文件不另算一套。
		 * @param ctx - 客户端 cordis 上下文。
		 */
		function apply(ctx) {
			// **第一件事**：把 ctx 装进那一格 —— 视图组件与取值帮手都在本函数之外，靠它拿服务
			// （`sessions` / `uiSession`）。晚于第一次渲染装进去，第一帧就会读到"取不到会话"。
			clientCtx = ctx
			try {
				if (typeof ctx.effect === 'function') ctx.effect(insertStyles, 'dsh-team-ops: ledger view styles')
			} catch (error) {
				try {
					console.warn('[dsh-team-ops] 样式插入失败，视图仍可渲染：', error && error.message)
				} catch {}
			}

			if (ctx.slots === undefined || typeof ctx.slots.inject !== 'function') {
				try {
					console.warn('[dsh-team-ops] 客户端无 slots 服务，视图未注册')
				} catch {}
				return
			}

			// 会话清单 store：`sessions` 在 inject 里点名 ⇒ cordis 等它就绪才跑 apply（一次性 ctx.get 不等待）；
			// 这里仍按调用现取，视图每次渲染再取一次作兜底。
			const sessionsOf = () => sessionsListStore()

			// **一栏**（不是多栏）：打开就是"现在到哪了"那一屏 —— 三行状态 + 四个块。
			// 四块各自成组件（成员 / 角色 / 技能 / 任务看板），在这一栏里按块切换（见本文件 StatusView）。
			ctx.slots.inject('conversation.view', () => {
				const dispose = ctx.slots.register(
					{ name: 'conversation.view', id: 'company-status', order: 20, label: '团队状态' },
					() => el(StatusView, { sessions: sessionsOf, slots: ctx.slots }),
				)
				return () => {
					if (typeof dispose === 'function') dispose()
				}
			})

			// ①′ 角色进本体的 `@` 菜单 + 热词典（与专家进菜单同一条路：`inputTriggers.registerSource`）；
			// 在席位之外单独挂，随插件一起注销。
			let disposeRoleSource = registerRoleTriggerSource(ctx, ctx.sessions)
			let roleSourceRetry = null
			// `inputTriggers` 不在 inject 里（老宿主可能没有这个服务）⇒ `ctx.get` 可能早一步取不到。
			// 取不到就**短轮询等它出现**（最多约 10 秒），不能就此永远没有 `@` 菜单。
			if (disposeRoleSource === null) {
				let tries = 0
				roleSourceRetry = setInterval(() => {
					tries += 1
					const dispose = registerRoleTriggerSource(ctx, ctx.sessions)
					if (dispose !== null) {
						disposeRoleSource = dispose
						clearInterval(roleSourceRetry)
						roleSourceRetry = null
					} else if (tries >= 40) {
						clearInterval(roleSourceRetry)
						roleSourceRetry = null
					}
				}, 250)
				try {
					if (typeof roleSourceRetry?.unref === 'function') roleSourceRetry.unref()
				} catch {
					/* 浏览器计时器没有 unref */
				}
			}
			if (typeof ctx.effect === 'function') {
				ctx.effect(() => () => {
					if (roleSourceRetry !== null) clearInterval(roleSourceRetry)
					if (typeof disposeRoleSource === 'function') disposeRoleSource()
				}, 'team-ops: @ 菜单里的角色')
			}

			// 第二处席位：输入框工具行左侧的「角色」按钮（`conversation.input.left`，list / replaceRisk: none）；
			// 入口拿得到 `useInput`（草稿）与 `inputActions`（setDraft / submit）；老宿主没这个槽就静默跳过。
			if (typeof ctx.slots.inject === 'function') {
				try {
					ctx.slots.inject('conversation.input.left', () => {
						const dispose = ctx.slots.register(
							{ name: 'conversation.input.left', id: 'company-roles', order: 200, label: '角色' },
							// 席位那套标准 props 之外再塞一个 `sessions`（会话作用域里的 `conversation` 把手要用它）。
							// `ctx.sessions` 拿不到时**不动**席位给的那一份（旧宿主 / 测试里都可能是这样）。
							(seatProps) => el(RoleComposerEntry, {
								...(seatProps === null || seatProps === undefined ? {} : seatProps),
								...(ctx.sessions === undefined || ctx.sessions === null ? {} : { sessions: ctx.sessions }),
							}),
						)
						return () => {
							if (typeof dispose === 'function') dispose()
						}
					})
				} catch (error) {
					ctx.logger?.warn?.('team-ops：输入框那条槽挂不上（' + (error === null || error === undefined ? '未知错误' : String(error.message ?? error)) + '），「角色」按钮这一处跳过。')
				}
			}

			// 第三处席位：输入框右侧的「润色」入口（`conversation.input.right`，渲染位置在模型选择器 / 发送键之前）。
			// 与左侧那枚「角色」按钮同一套注册形状：标准 props 之外把 `ctx.sessions` 塞进去
			// （判「草稿里有没有 @ 引用」要用会话作用域里的 `conversation` 把手）。
			// 老宿主没有这个槽位时静默跳过（`inject` 自己抛就只 warn）——润色是增强，不该拖垮输入框。
			if (typeof ctx.slots.inject === 'function') {
				try {
					ctx.slots.inject('conversation.input.right', () => {
						const dispose = ctx.slots.register(
							{ name: 'conversation.input.right', id: 'company-polish', order: 100, label: '润色' },
							(seatProps) => el(PolishEntry, {
								...(seatProps === null || seatProps === undefined ? {} : seatProps),
								...(ctx.sessions === undefined || ctx.sessions === null ? {} : { sessions: ctx.sessions }),
							}),
						)
						return () => {
							if (typeof dispose === 'function') dispose()
						}
					})
				} catch (error) {
					ctx.logger?.warn?.('team-ops：输入框右侧那条槽挂不上（' + (error === null || error === undefined ? '未知错误' : String(error.message ?? error)) + '），「润色」这一处跳过。')
				}
			}

		}

		exports.apply = apply
		// 硬依赖声明：cordis 的 Guard 拒绝未声明的服务属性访问；`sessions` 还必须在这里点名，
		// 否则 apply 可能早于它就绪，一次性取值会永远拿不到当前会话（见 apply 里的说明）。
		exports.inject = ['slots', 'sessions']
		return exports
		// **注意**：工厂与 `load({...})` 的闭合括号在 `17-polish.part` 末尾 —— ⑰ 排在本片段之后，
		// 而它必须仍在工厂函数体内（函数声明会被提升，`return` 之后也能被 `apply` 用到）。
		// ── ⑰ 输入框润色 ─────────────────────────────────────────────────────
		// **本片段排在 ⑯ 之后，而 ⑯ 末尾已经 `return exports`** —— 所以这一片里**只能出现函数声明**：
		// function 声明在函数体入口就被提升（可以放心被 ⑯ 的 `apply` 引用），而 `const` / `let`
		// 的初始化语句在 `return` 之后永远不执行，写成 const 会在渲染时抛 TDZ。
		// 新增常量请放进函数体内；`tests/panel-blocks.test.mjs` 钉着"这一片不许有顶层 const/let"。

		/** 润色草稿的字数上限（与服务端契约同一条；**不截断**——截断会丢意图）。 */
		function polishMaxChars() {
			return 4000
		}

		/**
		 * 一枚内联 SVG（描边、`currentColor`；与 ⑦ 的头像同一套几何风格）。**不用 emoji。**
		 * @returns 节点。
		 */
		function polishIconOf() {
			return el(
				'svg',
				{
					className: 'cbv-polish-icon',
					viewBox: '0 0 24 24',
					width: '16',
					height: '16',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: '1.8',
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
					'data-polish-icon': '',
				},
				// 一颗四角星 + 一颗小星：语义是"打磨一下措辞"，不是"魔法棒"那种夸张图形。
				el('path', { key: 'star', d: 'M12 3.2l1.9 4.9 4.9 1.9-4.9 1.9L12 16.8l-1.9-4.9L5.2 10l4.9-1.9z' }),
				el('path', { key: 'spark', d: 'M18.4 15.1l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z' }),
			)
		}

		/**
		 * 字数：按**码点**数（中文一个字算 1，不按 UTF-16 长度算成 2）。
		 * @param value - 文本。
		 * @returns 字数。
		 */
		function polishCharsOf(value) {
			let count = 0
			for (const unused of text(value)) count += 1
			return count
		}

		/**
		 * 把一段文本切成可拼回原文的 token：中文按字、英文/数字/标识符按连续段、空白与标点各自成段。
		 * 分词只服务 diff 的**粒度**；每个 token 原样拼回去逐字等于原文（行尾空格不会丢）。
		 * @param value - 原文或结果。
		 * @returns token 数组。
		 */
		function polishTokensOf(value) {
			const WORD = /[A-Za-z0-9_@#%&+*=/\\:.-]/
			const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/
			const SPACE = /\s/
			const out = []
			let buffer = ''
			let kind = ''
			const flush = () => {
				if (buffer !== '') {
					out.push(buffer)
					buffer = ''
					kind = ''
				}
			}
			for (const ch of text(value)) {
				let next
				if (CJK.test(ch)) next = 'cjk'
				else if (WORD.test(ch)) next = 'word'
				else if (SPACE.test(ch)) next = 'space'
				else next = 'punct'
				if (next === 'cjk') {
					flush()
					out.push(ch)
					continue
				}
				if (next !== kind) {
					flush()
					kind = next
				}
				buffer += ch
			}
			flush()
			return out
		}

		/**
		 * 词级 diff 的编辑脚本。先剥掉公共前后缀（润色通常只动几处，这一步把中间段压到很小），
		 * 再做 LCS；中间段过大时不做 O(n·m)（4000 字上限下极端仍是千万格），整段按"删除 + 新增"呈现
		 * —— 视觉上仍说清"这片改了"，不假装精确。
		 * @param left - 原文 token 的中间段。
		 * @param right - 结果 token 的中间段。
		 * @returns `[{ kind: 'same'|'del'|'add', text }]`。
		 */
		function polishDiffOpsOf(left, right) {
			const n = left.length
			const m = right.length
			if (n * m > 120000) {
				const ops = []
				for (const token of left) ops.push({ kind: 'del', text: token })
				for (const token of right) ops.push({ kind: 'add', text: token })
				return ops
			}
			const width = m + 1
			const table = new Uint32Array((n + 1) * width)
			for (let i = n - 1; i >= 0; i -= 1) {
				for (let j = m - 1; j >= 0; j -= 1) {
					table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
				}
			}
			const ops = []
			let i = 0
			let j = 0
			while (i < n && j < m) {
				if (left[i] === right[j]) {
					ops.push({ kind: 'same', text: left[i] })
					i += 1
					j += 1
				} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
					ops.push({ kind: 'del', text: left[i] })
					i += 1
				} else {
					ops.push({ kind: 'add', text: right[j] })
					j += 1
				}
			}
			while (i < n) {
				ops.push({ kind: 'del', text: left[i] })
				i += 1
			}
			while (j < m) {
				ops.push({ kind: 'add', text: right[j] })
				j += 1
			}
			return ops
		}

		/** 把相邻同类的 token 并成一段（渲染时少一堆节点；拼回去仍逐字等于原文）。 */
		function polishRunsOf(parts) {
			const out = []
			for (const part of parts) {
				if (part.text === '') continue
				const last = out[out.length - 1]
				if (last !== undefined && last.kind === part.kind) last.text += part.text
				else out.push({ text: part.text, kind: part.kind })
			}
			return out
		}

		/**
		 * 本地词级 diff（**高亮以本地为准**：服务端 `changes` 只用于摘要行）。
		 * @param before - 原文。
		 * @param after - 润色结果。
		 * @returns `{ before, after, changed }`：两个渲染段 + 是否有改动。
		 */
		function polishDiffOf(before, after) {
			const left = polishTokensOf(before)
			const right = polishTokensOf(after)
			const beforeParts = []
			const afterParts = []
			let start = 0
			while (start < left.length && start < right.length && left[start] === right[start]) start += 1
			let endLeft = left.length
			let endRight = right.length
			while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
				endLeft -= 1
				endRight -= 1
			}
			for (let i = 0; i < start; i += 1) {
				beforeParts.push({ text: left[i], kind: 'same' })
				afterParts.push({ text: left[i], kind: 'same' })
			}
			const ops = polishDiffOpsOf(left.slice(start, endLeft), right.slice(start, endRight))
			for (const op of ops) {
				if (op.kind === 'same') {
					beforeParts.push({ text: op.text, kind: 'same' })
					afterParts.push({ text: op.text, kind: 'same' })
				} else if (op.kind === 'del') beforeParts.push({ text: op.text, kind: 'del' })
				else afterParts.push({ text: op.text, kind: 'add' })
			}
			for (let i = endLeft; i < left.length; i += 1) {
				beforeParts.push({ text: left[i], kind: 'same' })
				afterParts.push({ text: left[i], kind: 'same' })
			}
			const beforeRuns = polishRunsOf(beforeParts)
			const afterRuns = polishRunsOf(afterParts)
			return {
				before: beforeRuns,
				after: afterRuns,
				changed: beforeRuns.some((run) => run.kind === 'del') || afterRuns.some((run) => run.kind === 'add'),
			}
		}

		/**
		 * 摘要行：**只显示类别与数量**（服务端 `changes` 归类；没有就退回本地 diff 的处数）。
		 * @param payload - 200 载荷。
		 * @param diff - 本地 diff。
		 * @returns 一行文案（空串 = 不印）。
		 */
		function polishSummaryOf(payload, diff) {
			const changes = payload !== null && payload !== undefined && Array.isArray(payload.changes) ? payload.changes : []
			if (changes.length > 0) {
				const order = []
				const counts = new Map()
				for (const change of changes) {
					const raw = change !== null && change !== undefined && typeof change === 'object' ? text(change.kind) : ''
					const kind = raw === '' ? '用词' : raw
					if (!counts.has(kind)) {
						counts.set(kind, 0)
						order.push(kind)
					}
					counts.set(kind, counts.get(kind) + 1)
				}
				return '改动：' + order.map((kind) => kind + ' ' + counts.get(kind)).join(' · ')
			}
			const changed = diff === null || diff === undefined ? 0 : diff.before.filter((run) => run.kind === 'del').length
			return changed === 0 ? '' : '改动：' + changed + ' 处'
		}

		/**
		 * 失败原因 → 一句人话（设计 §7 的最终措辞；`error` 原文永远照印，这一句只是补"为什么 / 下一步"）。
		 * @param reason - 载荷里的 `reason`。
		 * @returns 一句说明；认不出返回空串。
		 */
		function polishReasonWordOf(reason) {
			const key = text(reason)
			if (key === 'no-route') return '本会话还没有可用的模型路由：先发一条消息，或在本插件配置里指定 provider / model。'
			if (key === 'timeout') return '润色超时了（模型在时限内没回完），可以重试一次。'
			if (key === 'rate-limited') return '润色太频繁了：每分钟最多 6 次，等一会儿再试。'
			if (key === 'busy') return '同一会话同时只跑一个润色：上一轮还没结束。'
			if (key === 'bad-request') return '请求不合法：草稿可能为空、超长或会话不对。'
			if (key === 'upstream') return '上游模型报错，稍后重试。'
			return ''
		}

		/**
		 * 一段差异渲染：`same` 原样、`del` 删除线 + 红底、`add` 绿底；
		 * 删除 / 新增各自带 `aria-label`（不只靠颜色传达，设计 §4 无障碍）。
		 * @param runs - `[{ text, kind }]`。
		 * @param role - `source` / `result`（也用作 data 属性）。
		 * @param label - 这一段的 `aria-label`（原文（只读）/ 润色后）。
		 * @returns 节点。
		 */
		function polishTextOf(runs, role, label) {
			const children = []
			runs.forEach((run, index) => {
				if (run.kind === 'same') {
					children.push(run.text)
					return
				}
				const tag = run.kind === 'del' ? 'del' : 'ins'
				children.push(
					el(
						tag,
						{
							// 色相复用既有**标签类**（删除=已打回红 / 新增=已完成绿）：portal 不在 `.cbv-root` 作用域里，
						// 又不能让"强调只给标签"的口径破掉 —— 这两个类只提供底 / 描边 / 字重，不改布局。
						className: 'cbv-polish-mark cbv-polish-mark--' + run.kind + (run.kind === 'del' ? ' cbv-chip--st-rejected' : ' cbv-chip--st-done'),
							key: role + '-' + index,
							'data-polish-mark': run.kind,
							'aria-label': (run.kind === 'del' ? '删除：' : '新增：') + run.text,
						},
						run.text,
					),
				)
			})
			return el(
				'div',
				{ className: 'cbv-polish-text cbv-polish-text--' + role, key: role, tabIndex: 0, 'data-polish-text': role, 'aria-label': label },
				children.length === 0 ? (role === 'source' ? '（草稿是空的）' : '（结果为空）') : children,
			)
		}

		/**
		 * 输入框右侧那一枚「润色」按钮 + 对比浮窗（design-polish-001 的 P0）。
		 *
		 * 三件不肯猜的事：
		 *   · **草稿是标准 prop**（`useInput`）⇒ 覆盖走 `inputActions.setDraft`，与本体同一处；
		 *   · **含 @ 引用就拒绝**（引用 chip 是结构化对象，整份覆盖会拍平）——判据来自会话作用域的
		 *     `conversation` 把手（`composerAccessOf` 的 `occurrences`），不靠正则猜文本；
		 *   · **采纳只在人点第二次（若草稿已变）之后发生**，浮窗失败不自动关、重试只发一次请求。
		 * @param props - 席位标准 props（`useInput` / `inputActions` / `sessionId`）+ 外部塞进来的 `sessions`。
		 * @returns 节点。
		 */
		function PolishEntry(props) {
			const slotsProps = props === null || props === undefined ? {} : props
			const sessionsService = slotsProps.sessions === undefined || slotsProps.sessions === null ? serviceOf('sessions') : slotsProps.sessions
			const sessionId = typeof slotsProps.sessionId === 'string' ? slotsProps.sessionId : resolveCurrentSessionId()
			const inputState = typeof slotsProps.useInput === 'function' ? slotsProps.useInput((state) => state) : null
			const draft = inputState === null || inputState === undefined ? '' : text(inputState.draft)
			const setDraft =
				typeof slotsProps.inputActions === 'object' && slotsProps.inputActions !== null && typeof slotsProps.inputActions.setDraft === 'function'
					? slotsProps.inputActions.setDraft
					: null
			const [open, setOpen] = React.useState(false)
			// idle / requesting / ready / error —— 与设计 §2 的状态机同一套词。
			const [phase, setPhase] = React.useState('idle')
			const [payload, setPayload] = React.useState(null)
			const [failure, setFailure] = React.useState({ error: '', reason: '' })
			// **发起时的草稿**：采纳时要拿它判"草稿在请求期间有没有被改动"。
			const [source, setSource] = React.useState('')
			const [hint, setHint] = React.useState('')
			const [hintTone, setHintTone] = React.useState('error')
			// 二次确认：`armed` 为真时按钮写「仍要覆盖？」，两次点击才真的覆盖。
			const [armed, setArmed] = React.useState(false)
			const [copied, setCopied] = React.useState('')
			const requestNo = React.useRef(0)
			const abortRef = React.useRef(null)
			const busyRef = React.useRef(false)
			const buttonRef = React.useRef(null)
			const sessionRef = React.useRef(sessionId)
			const modalRef = useModalA11y(open, () => polishClose())

			// **提示条要自己消失**（现场：点一下空草稿，提示一直挂在那儿还挡住按钮）。
			// 规则：2 秒后自动收起（人的口径：4 秒还是太久）—— 它只解释"刚才为什么没动"，
			// 不是常驻状态（成功/失败的结果在浮窗里，不靠这条提示承载）。
			React.useEffect(() => {
				if (hint === '') return undefined
				const timer = setTimeout(() => setHint(''), 2000)
				return () => clearTimeout(timer)
			}, [hint])
			/** 取消在途请求（关浮窗 / 换会话 / 卸载都走它）。 */
			function polishAbort() {
				requestNo.current += 1
				busyRef.current = false
				const controller = abortRef.current
				abortRef.current = null
				if (controller !== null && controller !== undefined && typeof controller.abort === 'function') {
					try {
						controller.abort()
					} catch {
						/* 已经结束的请求再 abort 也不该抛 */
					}
				}
			}

			/**
			 * 关浮窗：取消请求、清结果；`note` 给了就在按钮旁显示一句（成功采纳 / 失败原因）。
			 * @param note - 可选的提示文案。
			 */
			function polishClose(note) {
				polishAbort()
				setOpen(false)
				setPhase('idle')
				setPayload(null)
				setFailure({ error: '', reason: '' })
				setArmed(false)
				setCopied('')
				if (typeof note === 'string' && note !== '') {
					setHint(note)
					setHintTone('ok')
				}
			}

			/**
			 * 点按钮前的**本地校验**（零请求的三条：空 / 超长 / 含引用）。
			 * @returns 不通过时的原因；通过返回空串。
			 */
			function polishCheck() {
				const chars = polishCharsOf(draft)
				if (chars === 0) return '草稿是空的，先写点什么再润色。'
				if (chars > polishMaxChars()) return '草稿 ' + chars + ' 字，超过 ' + polishMaxChars() + ' 字上限（截断会丢信息，所以拒绝）。'
				const access = composerAccessOf(sessionsService, sessionId)
				const handle = access !== null && access !== undefined && access.handle !== null && access.handle !== undefined ? access.handle : null
				const snapshot = handle !== null && typeof handle.state?.getSnapshot === 'function' ? handle.state.getSnapshot() : null
				const occurrences = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.occurrences) ? snapshot.occurrences : []
				if (occurrences.length > 0) return '草稿里含 @ 引用，润色会覆盖成纯文本——先复制文本再润色，或去掉引用。'
				return ''
			}

			/**
			 * 发一次润色请求。`polishRun(source, { retry: true })` 是失败后的重试（同一文本重发，只发一次）。
			 * @param textValue - 要润色的文本。
			 * @param options - `{ retry }`。
			 */
			function polishRun(textValue, options) {
				if (busyRef.current) return
				const retrying = options !== undefined && options !== null && options.retry === true
				if (!retrying) {
					const why = polishCheck()
					if (why !== '') {
						setHint(why)
						setHintTone('error')
						return
					}
				}
				if (typeof fetch !== 'function') {
					setHint('当前环境没有 fetch')
					setHintTone('error')
					return
				}
				const textValueNow = text(textValue)
				busyRef.current = true
				const id = requestNo.current + 1
				requestNo.current = id
				setHint('')
				setHintTone('error')
				setSource(textValueNow)
				setPayload(null)
				setFailure({ error: '', reason: '' })
				setArmed(false)
				setCopied('')
				setPhase('requesting')
				setOpen(true)
				const controller = typeof AbortController === 'function' ? new AbortController() : null
				abortRef.current = controller
				// 这一条 **不改任何一块读回的数据**（不落盘、不写账本、不进缓存）⇒ 没有可失效的东西；
				// 面板那条"写动作附近必须 invalidatePanes"的扫描按 `POLISH_ENDPOINT` 认这一处豁免。
				fetch(POLISH_ENDPOINT, {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ session: sessionId, text: textValueNow }),
					...(controller === null ? {} : { signal: controller.signal }),
				})
					.then((response) => response.json().then((data) => ({ response, data }), () => ({ response, data: null })))
					.then(({ response, data }) => {
						// 关窗 / 换会话之后迟到的响应一律丢弃（不让旧结果写回新状态）。
						if (requestNo.current !== id) return
						busyRef.current = false
						abortRef.current = null
						if (data !== null && data !== undefined && data.ok === true && typeof data.polished === 'string') {
							setPayload(data)
							setPhase('ready')
							return
						}
						const error = data !== null && data !== undefined && typeof data.error === 'string' && data.error !== '' ? data.error : 'HTTP ' + response.status + '：润色没成功'
						const reason = data !== null && data !== undefined && typeof data.reason === 'string' ? data.reason : ''
						setFailure({ error, reason })
						setPhase('error')
					})
					.catch((error) => {
						if (requestNo.current !== id) return
						busyRef.current = false
						abortRef.current = null
						const message = String(error !== null && error !== undefined && typeof error === 'object' && 'message' in error ? error.message : error)
						// abort 是"人关掉了浮窗"，不是失败：不写错误态。
						if (/abort/i.test(message)) return
						setFailure({ error: '发不出去：' + message, reason: '' })
						setPhase('error')
					})
			}

			/** 采纳：草稿没变就直接覆盖；变了就先亮「仍要覆盖？」，第二次点击才执行。 */
			function polishAdopt() {
				if (payload === null || payload === undefined || typeof payload.polished !== 'string') return
				if (draft !== source && armed !== true) {
					setArmed(true)
					return
				}
				if (setDraft === null) {
					setHint('这个会话插不进输入框：自己复制润色后的文本。')
					setHintTone('error')
					return
				}
				try {
					setDraft(payload.polished)
				} catch (error) {
					setHint('覆盖草稿失败：' + String(error !== null && error !== undefined && typeof error === 'object' && 'message' in error ? error.message : error))
					setHintTone('error')
					return
				}
				// 人的口径（HD-014）：采纳就是**直接替换输入框文字**，不再弹「已采纳」提示条。
				polishClose()
			}

			/**
			 * 复制一段文本（原文那枚按钮用）：成功 / 失败都如实说。
			 * @param value - 要复制的文本。
			 */
			function polishCopy(value) {
				void copyText(value).then((result) => {
					if (result !== null && result !== undefined && result.ok === true) {
						setCopied('已复制原文。')
						return
					}
					const reason = result !== null && result !== undefined && typeof result.reason === 'string' && result.reason !== '' ? result.reason : '这个环境不允许剪贴板写入'
					setCopied('复制失败：' + reason)
				})
			}

			// 换会话：在途请求 abort、浮窗关闭（设计 §2.9）。故意不依赖 `sessionId` 的首次渲染。
			React.useEffect(() => {
				if (sessionRef.current === sessionId) return
				sessionRef.current = sessionId
				polishAbort()
				setOpen(false)
				setPhase('idle')
				setPayload(null)
				setFailure({ error: '', reason: '' })
			}, [sessionId])
			// 卸载：abort（组件被摘掉之后迟到的响应没有意义）。
			React.useEffect(() => () => polishAbort(), [])

			const chars = polishCharsOf(draft)
			const empty = chars === 0
			// 超长也**视觉上置灰**（不弹提示条）：点了没反应会让人以为坏了，所以先把「不可用」画出来。
			const tooLong = chars > polishMaxChars()
			const requesting = phase === 'requesting' && open
			const hintId = 'cbv-polish-hint'

			/** 对比浮窗本体（portal 到 `document.body`：composer 那片 `will-change` 会给 fixed 造包含块）。 */
			function polishOverlayOf() {
				const ready = phase === 'ready' && payload !== null && payload !== undefined
				const polished = ready ? text(payload.polished) : ''
				const diff = ready ? polishDiffOf(source, polished) : null
				const scenario = ready ? text(payload.scenario) : ''
				const language = ready ? text(payload.language) : ''
				const subtitle = ready && scenario !== '' ? '识别：' + scenario + ' / ' + (language === '' ? '—' : language) : '识别：…'
				const checks = ready && payload.checks !== null && payload.checks !== undefined && payload.checks.ok === false ? payload.checks : null
				const findings = checks !== null && Array.isArray(checks.findings) ? checks.findings : []
				const summary = ready ? polishSummaryOf(payload, diff) : ''
				const sourceRuns = diff === null ? [{ text: source, kind: 'same' }] : diff.before
				const resultRuns = diff === null ? [] : diff.after
				const resultChars = ready ? polishCharsOf(polished) : 0
				return el(
					'div',
					{ className: 'cbv-overlay cbv-polish-overlay', key: 'polish-overlay', onClick: () => polishClose() },
					el(
						'div',
						{
							className: 'cbv-modal cbv-polish-modal',
							key: 'polish-modal',
							role: 'dialog',
							'aria-modal': 'true',
							'aria-label': '润色',
							ref: modalRef,
							tabIndex: -1,
							'data-polish-dialog': phase,
							onClick: (event) => event.stopPropagation(),
						},
						el(
							'div',
							{ className: 'cbv-modal-head', key: 'head' },
							el('span', { className: 'cbv-modal-title', key: 'title' }, '润色'),
							el('span', { className: 'cbv-polish-sub', key: 'sub', 'data-polish-sub': '' }, subtitle),
							el(
								'div',
								{ className: 'cbv-modal-actions', key: 'actions' },
								el('button', { className: 'cbv-btn', key: 'copy', type: 'button', 'data-polish-copy': '', onClick: () => polishCopy(source) }, '复制原文'),
								el('button', { className: 'cbv-btn', key: 'close', type: 'button', 'data-polish-close': '', onClick: () => polishClose() }, '关闭'),
							),
						),
						el(
							'div',
							{ className: 'cbv-modal-body cbv-polish-body', key: 'body' },
							copied === ''
								? null
								: el('div', { className: 'cbv-polish-copied', key: 'copied', role: 'status' }, copied),
							checks === null
								? null
								: el(
										'div',
										{ className: 'cbv-polish-warn cbv-chip--st-verify', key: 'checks', role: 'status', 'data-polish-warn': '' },
										el('div', { className: 'cbv-polish-warn-title', key: 'title' }, '机械校验提示（仍可采纳，请逐句确认）：'),
										findings.map((line, index) => el('div', { className: 'cbv-polish-warn-line', key: 'finding-' + index }, text(line))),
									),
							el(
								'div',
								{ className: 'cbv-polish-section', key: 'source' },
								el(
									'div',
									{ className: 'cbv-polish-label', key: 'label' },
									'原文（只读）',
									el('span', { className: 'cbv-polish-count', key: 'count' }, polishCharsOf(source) + ' 字'),
								),
								polishTextOf(sourceRuns, 'source', '原文（只读）'),
							),
							el(
								'div',
								{ className: 'cbv-polish-section', key: 'result' },
								el(
									'div',
									{ className: 'cbv-polish-label', key: 'label' },
									'润色后',
									ready ? el('span', { className: 'cbv-polish-count', key: 'count' }, resultChars + ' 字') : null,
								),
								phase === 'requesting'
									? el(
											'div',
											{ className: 'cbv-polish-loading', key: 'loading', 'aria-busy': 'true' },
											el('span', { className: 'cbv-sr-only', key: 'say' }, '正在润色…'),
											el('span', { className: 'cbv-polish-skel', key: 'line-1' }),
											el('span', { className: 'cbv-polish-skel', key: 'line-2' }),
											el('span', { className: 'cbv-polish-skel', key: 'line-3' }),
											el('div', { className: 'cbv-polish-loading-word', key: 'word' }, '正在润色…'),
										)
									: phase === 'error'
										? el(
												'div',
												{ className: 'cbv-polish-error cbv-chip--p0', key: 'error', role: 'alert', 'data-polish-error': '' },
												el('div', { key: 'main' }, '润色失败：' + failure.error),
												polishReasonWordOf(failure.reason) === ''
													? null
													: el('div', { className: 'cbv-polish-reason', key: 'reason' }, polishReasonWordOf(failure.reason)),
											)
										: ready
											? polishTextOf(resultRuns, 'result', '润色后')
											: null,
							),
							ready ? el('div', { className: 'cbv-polish-summary', key: 'summary', 'data-polish-summary': '' }, summary === '' ? '原文已经足够清晰，未做改动。' : summary) : null,
						),
						el(
							'div',
							{ className: 'cbv-polish-foot', key: 'foot' },
							phase === 'error'
								? el('button', { className: 'cbv-btn', key: 'retry', type: 'button', 'data-polish-retry': '', onClick: () => polishRun(source, { retry: true }) }, '重试')
								: null,
							el('button', { className: 'cbv-btn', key: 'cancel', type: 'button', 'data-polish-cancel': '', onClick: () => polishClose() }, '取消'),
							el(
								'button',
								{
									className: 'cbv-btn',
									key: 'adopt',
									type: 'button',
									disabled: phase !== 'ready',
									'data-polish-adopt': armed ? 'armed' : '',
									onClick: polishAdopt,
								},
								armed ? '仍要覆盖？' : '采纳',
							),
						),
					),
				)
			}

			return el(
				'div',
				{ className: 'cbv-polish', key: 'polish' },
				el(
					'button',
					{
						key: 'polish-button',
						ref: buttonRef,
						className: 'cbv-composer-btn cbv-polish-btn' + (requesting ? ' cbv-polish-btn--busy' : ''),
						type: 'button',
						'aria-label': '润色草稿',
						'aria-describedby': hint === '' ? undefined : hintId,
						'aria-disabled': empty || tooLong ? 'true' : undefined,
						disabled: requesting,
						title: '润色草稿',
						'data-polish-button': '',
						onClick: () => {
							if (requesting) return
							// 人的口径（HD-014）：空草稿 / 超长**不响应** —— 不弹提示条、不发请求（按钮已置灰）。
							if (empty || tooLong) return
							polishRun(draft)
						},
					},
					polishIconOf(),
				),
				// 人的口径（HD-014）：**不要视觉提示条**（多余）。拒绝原因只进**读屏**（`cbv-sr-only`），
				// 视觉上点一下没反应就是「现在不能润色」；空草稿直接不响应（连读屏也不必播报）。
				hint === ''
					? null
					: el('span', { key: 'hint', id: hintId, className: 'cbv-sr-only', role: 'status', 'data-polish-hint': hintTone }, hint),
				open ? portalOf(polishOverlayOf()) : null,
			)
		}
		// 工厂与模块注册的闭合括号（⑯ 的尾部让位给本节：⑰ 必须仍在工厂函数体内）。
	},
})
