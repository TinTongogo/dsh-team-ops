// dsh-team-ops · 一人公司文件前端页 —— browser half（client bundle）
//
// 由 dsh-client-modules 以 `/plugins/??dsh-team-ops/client.js&rev=…` 组合投递，
// 在浏览器里经 cordis Loader 的 lazy-CJS 模块表执行：本文件是「调用
// window.__ModuleLoader__.load 注册一个 CJS 工厂」的形态，与官方 ui-* 包以及
// 第三方 dsh-dream-skin 的构建产物同一形状。工厂内只有平台种子词与已注册的
// client bundle 可以被 require。
//
// 席位（**两个**）：① conversation.view —— 对话窗视图栏里「对话」「轨迹」之后的那一栏（三块）；
//                  ② conversation.input.left —— 输入框工具行里那一枚「角色」按钮（选角色 ⇒ 让它去干）
// （「团队状态」）。内里**三块**，块序 = **成员 / 技能 / 任务看板**
// （成员最前，打开面板即落在成员上；角色那一块已按人的指令撤下 —— 角色启停仍走会话工具
// `role_manage`，对应的 host 端点也还在，只是界面不再调用）。
// 数据：GET /company-board/api（任务看板那份视图）
//       + /company-board/api/status（三行状态）
//       + /company-board/api/members（成员块：名册读数 + 运行时状态 + 未读邮箱 + 头像映射）
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
//   ④ 界面规格与配色         SPECS / BLOCKS / TONE_VAR（三块的名字与顺序就在这里）
//   ⑤ 样式表                 CSS 数组（所有 .cbv-* 类名与配色变量都只在这一处）
//   ⑥ 渲染原语与 Markdown    el / text / markdownNodes（浮窗里的表格也走它）
//   ⑦ 头像、分栏与卡片原语    AVATAR_ICONS / boardCard / CARD_SHELL_PROPS
//   ⑧ 会话、工作区与高度      订阅 sessions、取当前工作区/会话 id、量高度
//   ⑨ 词表与分栏规格         成员/技能的状态词与分档、团队任务板三栏
//   ⑩ 状态视图与任务板        StatusView / TaskBoardView（视图栏里那一栏的内容）
//   ⑪ 角色触发源与输入框席位   rosterCache / RoleComposerEntry（`@` 菜单与那枚「角色」按钮）
//   ⑫ 成员块                 MembersView（卡片、筛选、角色一节、只读动作「查看/复制提示词」；成员写面已撤）
//   ⑬ 技能块                 SkillsView（清单、正文浮窗、导入/新建/删除）
//   ⑭ 任务看板块              原生任务板三栏 + 详情浮窗（本插件看板那一档已撤：任务在原生那本账上）
//   ⑮ 装配与导出              insertStyles / apply / 席位导出
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
		// 块序（人的指令，改过三轮）：**成员最前**（打开即落在成员上）→ **技能** → **任务看板**；
		// 角色那一栏**去掉**（角色启停仍走会话工具 `role_manage`，只是界面上不再有那一块）。
		const PANE_MARK = 'f108-成员写面撤下（只读 + 一句指路）；任务看板：最小筛选、三条态、被截断的字段可见'
		// 量高余量：面板底边与容器底边之间留这么几像素，避免"刚好相等"时因为一个像素的取整误差撑出滚动条。
		const PANE_HEIGHT_MARGIN = 2
		/** 打开本地目录（与 host half 的 OPEN_PATH 必须一致）。 */
		const OPEN_ENDPOINT = API_PREFIX + '/open'

		// ── 「成员」块：端点与 host half 的成员读路径必须一致 ────────────────────────────
		//
		// **只有读**：读的是 `memberSnapshot` 的读数（与会话工具 `member_list` 同一份判定）。
		// 成员是**宿主原生的队友** —— 本插件不改、不删、不启停（那几条写路径连客户端常量都撤了；
		// host half 那两条路由保留为**防御性拒绝**，直接 POST 一样拿不到改动）。
		const MEMBERS_ENDPOINT = API_PREFIX + '/members'
		/** 「角色」那三条写路径（增删改）。端点常量与 host half 的常量逐字对齐（有自检）。 */
		const ROLES_UPDATE_ENDPOINT = API_PREFIX + '/roles/update'
		const ROLES_REMOVE_ENDPOINT = API_PREFIX + '/roles/remove'
		const ROLES_RESTORE_ENDPOINT = API_PREFIX + '/roles/restore'
		// 成员那三个动词（HD-006）：**服务端给动词、客户端不猜** —— 卡上给哪几个按钮看载荷里的 `verbs`。
		const MEMBERS_DISABLE_ENDPOINT = MEMBERS_ENDPOINT + '/disable'
		const MEMBERS_RESTORE_ENDPOINT = MEMBERS_ENDPOINT + '/restore'
		const MEMBERS_INTERRUPT_ENDPOINT = MEMBERS_ENDPOINT + '/interrupt'
		/** 团队服务那一层的查 / 开 / 关（与 host half 的 TEAM_SERVICE_PATH 逐字对齐）。 */
		const TEAM_SERVICE_ENDPOINT = API_PREFIX + '/team-service'

		// ── 「技能」块：端点与 host half 的 SKILLS_PATH / SKILL_DEFINITION_PATH 必须一致 ──
		//
		// 清单与正文都**不自己读盘**：host half 把请求转给宿主的**技能注册表**（`ctx.skills`）——
		// 那是"DSH 到底会加载哪些技能"的唯一一处正文（与会话里的技能工具同一份目录），
		// 面板只负责把结果摆出来。这一块**只读**（查看正文 / 复制正文 / 复制路径）。
		// 「任务看板」块里**团队那一半**：本会话 Agent Teams 的共享任务板（与 host half 的 TEAM_TASKS_PATH 必须一致）。
		// 与成员块同一套取法：带 `?session=`，宿主按它取本会话的 Lead 再问 `ctx.agentTeams.listTasks`。
		const TEAM_TASKS_ENDPOINT = API_PREFIX + '/team-tasks'

		const SKILLS_ENDPOINT = API_PREFIX + '/skills'
		const SKILL_DEFINITION_ENDPOINT = SKILLS_ENDPOINT + '/definition'
		// 技能块的三个**写入口**（导入 / 新建 / 删除）。判定与落盘全在宿主那侧（`lib/skill-write.js`），
		// 面板只做"取参数、POST、把回执原文摆出来"。
		const SKILLS_IMPORT_ENDPOINT = SKILLS_ENDPOINT + '/import'
		const SKILLS_CREATE_ENDPOINT = SKILLS_ENDPOINT + '/create'
		const SKILLS_REMOVE_ENDPOINT = SKILLS_ENDPOINT + '/remove'
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
		const paneCache = new Map()
		/** 让缓存失效（写动作之后、刷新 tick 时调）。 */
		const invalidatePanes = () => paneCache.clear()
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
						// **返回一个合成的 response，而不是原来那个**：原 response 的 body 已经被上面这一读
						// 消费掉了，再交给调用方读一次会抛（现场：`读不到成员名册：HTTP 200：响应不是 JSON`）。
						// 合成对象只实现调用方用到的那两样：`status` 与 `json()`。
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
		const skillsUrlOf = (workspace, sessionId) => SKILLS_ENDPOINT + paneQueryOf(workspace, sessionId)
		/**
		 * 「技能」块里那张清单的"是哪一版"标记（形态/观感换了就换这串字）。
		 * 只放 data 属性、不挂 title，核对时在 DOM 里看 `data-skills-mark` 即可。
		 */
		const SKILLS_MARK = 'f27-技能栏：清单（来源/提供者/两种可调用面）+ 查看正文·复制正文·复制路径'

		// ── 状态文件（看板那一份）在界面上的固定约定 ──────────────────────────────────
		// 看板条目的状态都落在同几个字段上，所以取数、筛选、分栏走同一套通用实现；
		// 差异只在「取值顺序 / 取值中文名 / 次要筛选字段 / 卡片长什么样」。

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
				endpoint: API_PREFIX,
				// 五档的**顺序**：唯一正文在 `lib/board-status.js`（客户端引不到那个文件 ——
				// 它是单文件懒加载模块、没有相对导入面 ⇒ 这一份是抄写，由自检钉住逐字一致）。
				// 顺序按流程：待办 → 进行中 → 待验收 → 已完成 → 已打回。
				statusOrder: ['待办', '进行中', '待验收', '已完成', '已打回'],
				statusLabel: (status) => status,
				tone: (status) => BOARD_TONE[status] || 'neutral',
				facetField: 'priority',
				facetAll: '优先级：全部',
				searchHint: '搜索编号 / 一句话 / owner / 产物',
			},
		]

		// ── 面板的块表：**成员 / 技能 / 任务看板**（块序 = 这里的顺序）──────────────────────────
		//
		// 块序是**人的指令**（改过三轮，这一版是第三轮）：**「成员」排在最前** —— `tab === 0`
		// 于是**默认落在成员块**上；「技能」紧随其后（当前这套系统到底带着哪些作业程序）；
		// 看板那一档（SPECS 本身）跟在最后，能力仍在 SPECS 里（statusOrder / 卡片 / 检索口径）。
		// 「有什么卡住」不由单独的块承担：写了 `blocked_by` 的**挂在它自己那张卡上**（`卡在：…`），
		// 被打回的在「已打回」那一栏 —— 人翻到那张卡就看见。
		//
		// 「成员」与「技能」两块**不是视图**（`spec` 为 null）：它们不是"三份门禁文件"之一 ——
		// 成员是**当前在场的人**（引擎 `memberSnapshot` 经 `/members` 给出），技能是**宿主的技能目录**
		// （`ctx.skills` 经 `/skills` 给出）。登记在同一张块表里，是为了"块切换 / 重读 / 工作区"
		// 这一行仍然只有一处实现。
		//
		// **「角色」那一块没有了**（人的指令）：角色清单与启停开关从界面上撤下，那件事仍走会话工具
		// `role_manage`（与引擎 `setRoleEnabled` 同一份判定），host half 的 `/roles` 那几个端点也还在
		// —— 只是这一栏不再调用它们（留着的理由与当年 `/members` 一样：工具面同源、有自检覆盖）。
		const MEMBERS_BLOCK = { ledger: 'members', label: '成员', spec: null }
		const SKILLS_BLOCK = { ledger: 'skills', label: '技能', spec: null }
		const BLOCKS = [MEMBERS_BLOCK, SKILLS_BLOCK].concat(SPECS.map((spec) => ({ ledger: spec.ledger, label: spec.label, spec })))

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
			// **面板要填满工作区**（现场来回打回几次：顶长主页面、列之间留空、底下留一大块空白，最后才定位到「猜常数」这个根因）。
			// 真正的填法是**量出来**（`usePaneHeight` → 行内 height），这条 CSS 只是**量不到时的兜底**
			// （无 DOM、或容器还没定尺寸）：`100vh − 210px` 是猜的常数，壳一改就在底下留一块空白。
			//   · 定高 = 面板撑满可用区，列随面板伸展、底下不留空；
			//   · 内容比面板高时由 board 那一层滚（控件行钉在最上面，不会被顶出屏幕）。
			// **面板自身永不出滚动条**（现场原话：「团队状态主体还是能滑动……影响体验」）：
			// 定高由量高给（`usePaneHeight`），这里 `overflow:hidden` 兜底 —— 万一量高了，宁可裁掉，
			// 也不让整块面板跟着页面滚（要滚的是列内那份清单，那是另一件事）。
			// ── 统一的中性透明度分档（人的指令：**不要颜色，只留透明度**）──────────────────
			// 一律用主题的**中性** label 色做底、只改百分比：深浅表达层次，色相交给主题。
			// **强调标签的墨色**（文字色）也在这里：色相与主题中性字色混 50% —— 浅色主题往深里走、深色主题
			// 往亮里走。为什么不直接用色相当文字色：实测浅色主题下 amber/green 在自己那层淡底上只有
			// 1.68 / 1.75:1（等于看不清）；混过之后 warn / ok / err 在**两套主题**下都是 4.9~7.6:1。
			// 于是面板在哪个主题下都是"半透明的一层层"，不再自带品牌色 / 状态色（那些色相会与
			// DSH 主题打架 —— 现场原话："感觉和主题 DSH 不太协调"）。
			//   a1 最淡（分栏分隔、标签底）→ a5 最重（选中态、已完成那类需要"实一点"的）
			'.cbv-root{--cbv-a1:color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);--cbv-a2:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);--cbv-a3:color-mix(in srgb, var(--dsw-alias-label-primary) 15%, transparent);--cbv-a4:color-mix(in srgb, var(--dsw-alias-label-primary) 21%, transparent);--cbv-a5:color-mix(in srgb, var(--dsw-alias-label-primary) 28%, transparent);--cbv-warn-ink:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 50%, var(--dsw-alias-label-primary));--cbv-ok-ink:color-mix(in srgb, var(--dsw-alias-state-success-primary) 50%, var(--dsw-alias-label-primary));--cbv-bad-ink:color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, var(--dsw-alias-label-primary));display:flex;flex-direction:column;gap:10px;width:100%;height:calc(100vh - 210px);min-height:160px;overflow:hidden;box-sizing:border-box;padding:4px 2px 0;color:var(--dsw-alias-label-primary);font-size:15px}',
			// 内嵌的那一份（首屏里的明细栏）：**不自己撑视口高**，按父容器剩下的空间铺满。
			// 它若也套上面那条定高，板子只占"视口 − 210px"那么高，而它上面还有控件行与搜索行
			// ⇒ 列底永远顶不到面板底（现场原话：「列元素底部没有顶到底」）。
			// 同权重、后写者胜：这条必须排在 `.cbv-root` 之后。
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

			// 输入框 / 下拉：与卡片**同一套 material**（中性透明度 + `border-l2`）。原来挂的是不透明的
			// `bg-layer-2` + `border-l1`：浅色主题下它与背景同值、深色主题下又比卡片亮一档 ——
			// 面板里就这样出现了"两套材质"（现场原话：输入框的风格也不兼容）。
			'.cbv-input,.cbv-select{background:var(--cbv-a1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:8px;height:26px;padding:0 8px;font-size:14px;font-family:inherit}',
			'.cbv-input:hover,.cbv-select:hover{border-color:var(--dsw-alias-label-tertiary)}',
			'.cbv-input{min-width:0;flex:1 1 180px}',
			// **一行五列，恒定**（现场原话：「任务看板是 1 行 5 列，无论怎么改变软件框大小都是 5 列。
			// 不会变成自适应行列数」）⇒ `flex-wrap:nowrap`：永不换行、也不因窄了改列数。
			// 横向一律 hidden（永不出横向条）：五列**等分**可用宽度，所以横向本来就没有可滚的东西。
			// 纵向只留这一条（列表超长时要能看下去）。
			// 滚动**发生在列内**（现场原话：「列里面超出列高度要能滑动」）⇒ 看板自己不再滚。
			// 板子 = **一栏一列横排、横向可滑**（人的指令）：栏宽固定（见下），放不下就往右滚；
			// 纵向不给板子滚（每一栏自己的卡片区各自纵向滚），免得出现两条纵向滚动条。
			'.cbv-board{display:flex;flex-wrap:nowrap;align-items:stretch;gap:10px;flex:1 1 auto;min-height:0;overflow-x:auto;overflow-y:hidden;padding:0 2px 6px;scroll-snap-type:x proximity;scrollbar-width:thin;scrollbar-gutter:stable}',
			// 横向滚动**要看得见**（人的指令：窄栏里第 4 栏被切断却没有提示）：macOS 的覆盖式滚动条
			// 默认不显示，所以显式给一条细的、用中性透明度描边（不给色相），并在版面里给它留位
			// （`scrollbar-gutter:stable` 免得滚动条一出现就顶动列宽）。
			'.cbv-board::-webkit-scrollbar{height:9px}',
			'.cbv-board::-webkit-scrollbar-track{background:var(--cbv-a1);border-radius:999px}',
			'.cbv-board::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:999px}',
			'.cbv-board::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-tertiary)}',
			// 列宽可收缩到底（min-width:0）：内容再长也压得住，由卡片自己断词换行。
			// **五列等分**：`flex:1 1 0`（基准 0 ⇒ 五列各拿 1/5，与内容多少无关）+ `min-width:0`
			// （能缩到底，卡片自己断词换行，于是永远不需要横向滚动）。
			// 一栏的宽度**固定**（不再 `flex:1 1 0` 等分）：等分在窄栏里会把每栏压到几十像素、
			// 卡片里的字全折成竖条（现场就是"看不出东西"）。`min(360px, 92%)` 让宽栏里并排几栏、
			// 窄栏里一栏几乎占满，剩下的往右滑。
			'.cbv-col{display:flex;flex-direction:column;flex:0 0 min(360px,92%);max-width:min(360px,92%);min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;min-height:0;scroll-snap-align:start}',
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
			// 看板卡：几何与其余三块同一条（`.cbv-box`），底色跟着**它所在的容器**走一格 ——
			// 它贴在 `layer-1` 的栏里，所以用 `layer-2`（其余三块的卡贴在面板底上，用 `layer-1`）。
			// 看板卡：底色**不再依赖 bg-layer-2**（浅色主题里它和栏底同值），改挂最淡的中性透明度，
			// 于是两种主题下卡片都从栏里"浮"出来一格。
			'.cbv-card{cursor:pointer}',
			// 静止态已经是 border-l2 ⇒ hover 不能只换描边（看不出来），改换底色。
			'.cbv-card:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.cbv-card-top{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
			// 时间那一行：比正文小一档、颜色最轻（它是"什么时候动的"，不是要读的内容）。
			'.cbv-sub--time{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
			'.cbv-id{font-family:var(--dsh-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:13px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
			'.cbv-chip{font-size:12px;line-height:16px;padding:0 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
			// 徽标的三档：都是中性底，靠**深浅 + 描边样式**区分（ok 最实、exception 虚线、bad 实线加粗）。
			'.cbv-chip--phase{background:var(--cbv-a2)}',
			// 优先级：**只给最高那两档上色**（P0 红 / P1 琥珀），P2 与 P3 保持中性 —— 满屏强调等于没有强调。
			'.cbv-chip--p0{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);color:var(--cbv-bad-ink);font-weight:600}',
			'.cbv-chip--p1{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);color:var(--cbv-warn-ink)}',
			'.cbv-chip--exception{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);border-style:dashed;color:var(--cbv-warn-ink)}',
			// 只有"可以动手 / 具备条件"这一类才用 `--ok`（团队任务板的「可认领」、技能卡的「模型可调用」）：给绿。
			'.cbv-chip--ok{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 42%, transparent);color:var(--cbv-ok-ink)}',
			'.cbv-note--warn{font-weight:600}',
			// 一句"要动作"的告警（"卡在：…"）：用错误色，但**只是字**（不填底）——
			// 卡片里最该被一眼看到的句子就是它。
			'.cbv-note--danger{color:var(--cbv-bad-ink);font-weight:600}',
			'.cbv-desc{font-size:14px;line-height:1.45;word-break:break-word}',
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
			'@media (prefers-reduced-motion:reduce){.cbv-overlay,.cbv-modal{animation:none}}',
			// 浮窗本体**与本体菜单/浮层同一层材质**（人的指令：「弹窗要透明，不然和其他栏的样式不协调」）：
			//   · 底 = `--dsw-specific-menu`（主题自己那个"浮层表面"：浅色 #f8f9fa94 / 深色 #43454a73，
			//     都是半透明）；取不到时退回 `bg-layer-1`，绝不至于没底；
			//   · `backdrop-filter` = `--dsw-menu-backdrop-filter`（主题给浮层的 `blur(40px) saturate(150%)`）
			//     —— 半透明而不糊字，靠的就是这一层模糊；取不到时给一个保守的 blur 兜底。
			// 于是浮窗与面板其余部分一样"是半透明的"，不再是一块不透明的黑板。
			'.cbv-modal{background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(1.4));border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.38);width:min(860px,94vw);max-height:86vh;display:flex;flex-direction:column;overflow:hidden;animation:cbv-pop .14s ease-out;outline:none}',
			'.cbv-modal-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}',
			// 浮窗里那句键盘提示：小字、次要色，靠右（`margin-left:auto`）、窄栏时允许换行，不跟按钮抢位置。
			// 这一行**必须是一行**（现场：窄浮窗里被折成两行，"`Esc` 关"掉到下一行）。
			// 于是 `nowrap` + 不再限宽到 52%；标题那一格自己有省略号，窄下来先瘦标题、不动这行提示。
			'.cbv-modal-keys{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin-left:auto;text-align:right;white-space:nowrap}',
			'.cbv-modal-title{flex:1 1 auto;min-width:0;font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			// 顶部锚定（overlay 用 flex-start + 固定 padding-top）而不是垂直居中：
			// 居中会让表头的 y 随内容长短浮动，翻页按钮就永远按不准。现在表头位置只由 padding-top 决定。
			'.cbv-modal-body{overscroll-behavior:contain}',
			'.cbv-modal-actions{display:flex;align-items:center;gap:8px;flex:none}',
			'.cbv-modal-body{overflow-y:auto;overflow-x:hidden;padding:12px;min-height:0}',
			'.cbv-modal-body .cbv-card{cursor:default}',
			// 文件三栏不是对话，那一对"调输入框边距"的拖拽条在这里没有意义：它们由壳渲染在滚动
			// 容器的后继兄弟上，带框架自己留的语义属性 data-width-handle。用我们自己的标记 + :has()
			// 限定为"本栏在场时才收"，卸载即恢复。纯 CSS：不动槽、不动布局状态，失败上限只是不生效。
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
			// 拖拽区（技能导入的"来源"）：虚线框 + 居中三行 + 两个文字按钮。
			// **默认就是天蓝色虚线**（人的指令）：用主题的输入强调色 `--dsw-alias-state-business-primary`
			// —— 那是面板里唯一允许用的非标签色相（与角色选择框的聚焦环同一个令牌），悬停时加深底色。
			// **只有边框打破例**（天蓝 = 主题的输入强调色）：底色仍走中性令牌，面板的"色相只在标签上"那条
			// 纪律只多这一处例外（见自检里那份例外清单）。
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
			'.cbv-modal-keys code,.cbv-pane-hint code,.cbv-mp-field-label code,.cbv-flt-bar code{font-family:var(--dsh-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;background:var(--cbv-a2);border:1px solid var(--dsw-alias-border-l2);border-radius:3px;padding:0 3px}',
			'.cbv-act-err{font-size:13px;color:var(--dsw-alias-label-primary);font-weight:600;flex-basis:100%}',
			// ── 「成员」块（卡片网格）────────────────────────────────────────────────
			// 面板是**窄栏**（宽度由壳的拖拽条决定、与视口无关）⇒ 列数交给 `auto-fill` 自己算，
			// 不写 `@media`、也不量宽：窄了自动落一列，卡片自己断词换行，永不出横向滚动条。

			// 住在视图栏里那一块：撑满剩余高度、清单自己滚（面板定高由量高那一套给，不在这里再猜一个高度）。
			// 一个块里有"顶部一行 + 一份可伸缩的视图"时用这一层（任务看板那两个来源就是这种）：
			// 它自己撑满并让里面的视图去滚（`.cbv-root--embed` / `.cbv-board` 都带 `flex:1 1 auto;min-height:0`）。
			// ── 三块共用的一套「块骨架」（成员 / 技能 / 任务看板看起来得是同一个东西）──────────
			//   `.cbv-view`   = 块的根：竖排、撑满、可伸缩（里面那一层才是滚动区）
			//   `.cbv-view-head` / `-title` = 头那一行（标题 + 读数 + 一句注解），三块同一套排版
			//   `.cbv-scroll` = **唯一的滚动区**（卡区 / 列表在它里面滚），三块同一套
			//   `.cbv-box`    = 卡片共用几何（圆角 / 描边 / 内边距 / 间距）；底色各块自己给（见下）
			'.cbv-view{display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0;color:var(--dsw-alias-label-primary);font-size:14px}',
			'.cbv-view-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;flex:none}',
			'.cbv-view-title{font-size:16px;font-weight:600}',
			// 三块共用的卡片几何（原来 `.cbv-mp-card` / `.cbv-sk-card` / `.cbv-roster-card` 各写一遍、
			// 看板那张 `.cbv-card` 又是另一套圆角与内边距 —— 于是"同一种卡"在三块里长得不一样）。
			// 边界用 `border-l2`（`.1` 黑 / `.12` 白），不用 `border-l1`（`.04` / `.06`）：宿主主题里
			// `bg-layer-1` 与 `bg-layer-2` 在**浅色主题下逐字同值**（都是 #fff），
			// 那时 `.04` 的描边只有 1.09:1 —— 卡片等于没画（深色主题才有两层底色之差）。
			// 底色**也在这条里**（四类卡共用）：原来只有看板卡挂 `--cbv-a1`、其余三类挂 `bg-layer-1`
			// —— 而 `bg-layer-1` 在浅色主题下就是 #fff（与背景同值），于是"看板卡改过来了、另外两个没改"。
			'.cbv-box{display:flex;flex-direction:column;gap:6px;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--cbv-a1)}',
			// 唯一的滚动区：卡区 / 列表在它里面滚（当年那次 bug 修的正是"滚动区一多，
			// 后半截就被挤出可视区"，现在把它做成三块共用的一条）。
			'.cbv-scroll{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;padding-right:2px}',
			// 状态标签（里程碑那一档打在卡上）：底色只分档，词面照引擎的状态取值。
			// **强调色只在这几个标签上**（人的指令：「任务看板里的标签加一些强调色，不然就是一片白的标签」）：
			// 用的是**主题自己的三个状态色 token**（`--dsw-alias-state-warn/success/error-primary` ——
			// 这套主题里带色相的 token 只有这三个；`brand-primary` 在这个主题里是黑 / 白，等于没色），
			// 底色是它们 16%~18% 的淡染，所以深浅仍跟着主题走、不是另造一套色板。
			// 其余材质（卡片 / 输入框 / 栏 / 按钮）保持中性 —— 强调只给"要一眼分出状态"的那几处。
			'.cbv-chip--st-todo{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
			// 五档状态标签，**一个色相都不用**：底深浅 + 描边样式 + 字重 + 删除线把它区分开
			//  待办 = 只有描边；进行中 = 淡底；待验收 = 淡底 + 虚线；已完成 = 实底 + 加粗；
			//  已打回 = 描边 + 加粗 + 划掉（"这条被打回了"这件事由划线说，不由红色说）。
			// 进行中：中性实底（"正在动"不报警，靠实一点与待办分开）
			'.cbv-chip--st-doing{background:var(--cbv-a4);color:var(--dsw-alias-label-primary);font-weight:600}',
			// 待验收：**琥珀**（"要人看一眼"）
			'.cbv-chip--st-verify{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);color:var(--cbv-warn-ink)}',
			// 已完成：**绿**
			'.cbv-chip--st-done{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent);color:var(--cbv-ok-ink);font-weight:600}',
			// 已打回：**红** + 划掉
			'.cbv-chip--st-rejected{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);color:var(--cbv-bad-ink);font-weight:600;text-decoration:line-through}',
			// 栏头下面那一句（出口准则 / 清单登记状态）：小字、不占满、最多两行。
			'.cbv-col-note{font-size:12px;line-height:1.45;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
			// 「角色」那一节：成员卡下面的一段（不占满高，跟着整块一起滚）。
			'.cbv-roster{display:flex;flex-direction:column;gap:8px;flex:0 0 auto}',

			'.cbv-roster-card{padding-bottom:0}',
			// 清单里的名字那一列：与成员卡同款（`.cbv-mp-nameblock`），只是里面装的是 id + 两枚 chip。
			'.cbv-roster-card .cbv-id{font-size:13px}',
			// 网格是**栏内滚动的那一层**：`min-height:0` 才压得住内容高，压得住才会滚。
			// （滚动区那一条见上面的 `.cbv-scroll`：三块共用 —— 卡区自己带 `overflow` 会把后面那节
			// 挤出可视区，那是现场打回过的一条，所以现在只有"块里一个滚动区"这一种写法。）
			'.cbv-scroll .cbv-mp-grid{flex:0 0 auto}',

			'.cbv-pane-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
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
			// 行内那句注解**不换行**（否则它一换行就把行撑高）：窄了就省略号，正文在 README 与块的 note 行里。
			'.cbv-flt-bar .cbv-pane-hint{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
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
			'.cbv-badge--ok{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 42%, transparent);color:var(--cbv-ok-ink)}',
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
			// **多行文本框只有这一条样式**（角色弹窗与成员弹窗共用）：
			// 圆角 / 描边 / 底与 `.cbv-input` 逐字一致；高度**由 `rows` 决定** ——
			// 千万不要让它挂 `.cbv-input`（那条有 `height:26px`，会把 rows=5 的正文压成一行输入框的样子，
			// 2026-10 现场就是这个问题："补充正文那一栏应该是文本框，不是输入框"）。
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
			// 指令文件路径：等宽、可断词（路径长，窄栏里必须能折行）。
			// 路径最长两行 + 省略号（**故意截**、看得出是截的）：整卡高度因此可预期。
			// 完整路径不会被丢掉 —— 「复制路径」拿的是清单里那一份全文，浮窗里也印着它。
			'.cbv-sk-path{font-family:var(--dsh-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
			'.cbv-sk-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
			'.cbv-modal--skills{max-width:min(860px,94vw)}',
			// **窄弹窗**（宽度只有这一处正文，几个短弹窗共用这一个类）：写入口（导入 / 新建技能）与
			// 角色弹窗（添加 / 修改 / 删除）都走它 ⇒ 宽度一致；内容多的两支（查看提示词 / 编辑提示词）
			// 不加这个类，仍走上面的 860px —— 它们要装长文本。
			'.cbv-modal--narrow{width:min(520px,92vw);max-width:min(520px,92vw)}',
		].join('\n')

		// ── ⑥ 渲染原语与 Markdown ──────────────────────────────────────────
		const el = (type, props, ...children) => React.createElement(type, props, ...children)

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
		//
		// 文件文本（条目描述、备注、验收意见）按 GFM 的一个
		// 子集渲染：标题、围栏代码块、引用、有序/无序列表、分隔线、段落，以及行内的行内代码、
		// 粗体、斜体、删除线、链接与裸 URL。
		//
		// 两条硬约束：① 一律构造 React 元素，**不用** dangerouslySetInnerHTML，因此文件里写
		// 尖括号只会原样显示成文本、注入不了标记；② 链接只认 http/https/mailto 与页内锚点，
		// 其余（javascript:、data: 等）按纯文本原样显示。

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
				// **GFM 管道表格**：`| a | b |` + 一行分隔（`|---|:--:|`）+ 若干行数据。
				// 认不出来的（只有一行带 `|`、或第二行不是分隔行）就照旧当段落 —— 别把"文本里有个竖线"
				// 误判成表格。单元格里的行内语法（粗体 / 行内码 / 链接）照旧走 `inlineNodes`。
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
			// 卡顶**只留"编号 + 优先级 + 状态标签"**：
			//   · 原来的「详情」两个字每张卡都印一遍、不带任何信息（整卡可点、光标已是手型），去掉；
			//   · 时间从卡顶挪到**描述下面**那一行（"这条什么时候动的"贴着它描述的对象，不跟标签抢第一行）。
			top.push(el('span', { className: 'cbv-spacer', key: 'spacer' }))
			const updatedAt = shortTime(task.updatedAt)

			// 运行时那几格（**照抄载荷**，面板不自己算）。三条口径（task-67）：
			//   · **版本号**：与**活卡**（`TaskBoardView`）那枚 `v<版本>` 徽标**同一形态**（`v3`）——
			//     同一件事在两个渲染器里形态一致优先（人已确认接受 `v3` 那个写法）；
			//   · **现在谁在干**（`assignee`）：卡上另有一行中文「归属：…」说的是 **owner**（该谁干）⇒ 这一格写成
			//     「**现在：…**」，两个事实各有各的说法，不撞名；
			//   · **执行代**（`attempt` / `attempt_id`）：**系统坐标**（开放凭据，工具面）⇒ **不印**。
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
				deps.length === 0 ? null : el('div', { className: 'cbv-sub', key: 'deps' }, '依赖：' + deps.join('、') + '（未完成不能认领）'),
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
				// **给人看的界面不印原生字段名、也不印系统坐标**（task-56 已批的口径）：这一支原来把六个字段原样摊开，
				// 现在按"**每个事实只用中文说一次**"办 —— 该留的留（用中文），已经说过的、以及只有工具用得上的就不印：
				//   · **产物**：卡上别处没有 ⇒ 留，写成中文「产物：…」；
				//   · **阶段**：卡顶那枚阶段徽标已经说了一次 ⇒ 这里不再重复；
				//   · **评级**：卡顶那枚「例外」徽标只说得出 exception ⇒ 其余取值在明细里用中文说一次（`exception` 不重复）；
				//   · **版本号**（改任务要带的 `revision` / CAS 前置条件）与**执行代**（`attempt` / `attempt_id`：开放凭据）
				//     都是**系统坐标**：要改任务时**工具回执**会给出该带什么 ⇒ 不在给人看的界面上印；
				//   · **现在谁在干**（`assignee`）：卡上那行中文「归属 …」已经说了一次 ⇒ 这里不再重复。
				const rows = [
					el('div', { className: 'cbv-sub', key: 'artifact' }, '产物：' + (text(task.artifact) === '' ? '—' : unquote(task.artifact))),
					text(task.grade) === '' || text(task.grade) === 'exception'
						? null
						: el('div', { className: 'cbv-sub', key: 'grade' }, '评级：' + text(task.grade)),
					el('div', { className: 'cbv-sub', key: 'deps' }, '依赖：' + (Array.isArray(task.blockedByTasks) && task.blockedByTasks.length > 0 ? task.blockedByTasks.join('、') + '（未完成不能认领）' : '无')),
					el('div', { className: 'cbv-sub', key: 'scopes' }, '写盘面：' + (Array.isArray(task.writeScopes) && task.writeScopes.length > 0 ? task.writeScopes.join('、') : '未声明（提示性，重叠只告警）')),
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
					const summary = id === '' ? undefined : byId[id]
					const cwd = summary === null || summary === undefined ? undefined : summary.cwd
					return typeof cwd === 'string' ? cwd : ''
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
		 * 读「当前是哪个会话」（同一个四级回落，见 `resolveCurrentSessionId`）并订阅它的变化。
		 *
		 * **只有技能那一块需要它**，而且不是拿来做显示的：技能目录是**按会话的层**解析的
		 * （同一个技能根，标准预设与团队预设看到的是不同的目录），所以面板要把它要看的那个会话
		 * 一并交给端点，否则读到的是"全局层"——那与模型看到的那份不是同一份。
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
				// **必须在滚动容器自己身上读**：壳是 `scroller.style.setProperty('--dsh-composer-height', …)`。
				// 从 `documentElement` 读是读不到的（CSS 变量只往下继承，祖先看不见后代设的值）——
				// 之前就是这么读到 0 的，于是正好少扣一个输入区高度，面板高出可用区、主体滑动。
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
			// 现场两次打回，这里定死两条（**别再合并成一个"最小基准"**）：
			//   ① 主体不许滑 —— 所以要留余量、且以视口为上界；
			//   ② 列要铺满面板高度 —— 所以**基准必须由壳决定**（容器 / 视口），
			//      **绝不能把父元素底边也算进来**：父元素是"跟着内容长高"的自动高度盒子，
			//      把它算进来 ⇒ 量出来的就是"当前内容多高" ⇒ 面板贴着内容缩、列也跟着缩（现场原话：
			//      「为什么分栏的高度也跟着变小了？」）。同一个坑踩过两次，所以写进注释钉住。
			const byViewport = fillHeightFrom(box.top, window.innerHeight, window.innerHeight)
			const byShell = container !== null && container !== undefined
				? paneHeightFrom(container, box.top, parentBottom, window.innerHeight)
				: fillHeightFrom(box.top, parentBottom, window.innerHeight)
			// **不再按"容器溢出多少"回退**：那个读数里混着别人撑出来的溢出（输入区、壳自己的底栏……），
			// 照减会把面板缩矮 —— 现场症状正是「主体不滑了，但列没铺满高度」。改成"占满容器内可视区"这一条口径：
			// 面板高度 = 容器内本栏以下的可视高 − 余量（并以视口为上界）。列随面板伸展，自然铺满。
			// 输入区（composer）是滚动容器的**子元素**（壳源码：`scroller.style.setProperty('--dsh-composer-height', seat.offsetHeight)`，
			// 而 `seat.parentElement` 就是滚动容器）⇒ 容器的 `clientHeight` **包含**输入区那块。
			// 所以扣掉它是**无条件**的，不是"贴底才扣"；扣的数一律用壳发布的那个实测值，扣不到就不扣（不猜）。
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
				// **别人改变输入区高度之后要重量**：现场报的是别的插件（`dsh-infinite-gen-4`）在
				// `conversation.input.dock` 上渲染一个小标签，输入区因此变高 ⇒ 可用区变小。
				// 壳自己是用 ResizeObserver 把结果写成 `--dsh-composer-height`（**写在滚动容器的 style 上**），
				// 所以这里盯两样：容器尺寸变化（ResizeObserver）+ 容器 style 属性变化（MutationObserver）。
				// 只量"挂载后 20 帧 + 窗口 resize"不够用：别人的标签是后来才出现的。
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
		 * 从前那两档「在册 / 未入册」的判据只是"这一位在不在我们的旧名册文件 `.company-gate.members.json` 里"
		 * —— 那份文件早没人写（人机器上 0 行）⇒ 「在册」空着、**所有成员统统落进「未入册」**，语义正好相反；
		 * 那份旧账连同这两档一起撤掉，面板**不再读那个文件**。
		 * `已停用` 读的是**我们自己的真源**：载荷里每行的 `disabled`（来自工作区文件 `.company-gate.member-flags.json`，
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
		 * 「任务看板」块的分档 chip：**从原生给的字段里选得出来的那几档**（都是筛选条件，不是划分）。
		 *
		 * 三个判据一律照抄原生载荷，面板不自己再算一遍：
		 *   · `可认领` 用原生的 `ready`（它自己算的"pending 且依赖都完成"）；
		 *   · `有依赖` 看 `blockedBy` 有没有内容；
		 *   · `写盘面重叠` 看原生给的 `writeScopeWarnings` 有没有内容（那是它的告警原文，不是我们算的重叠）。
		 * 原生载荷里**没有优先级、没有时间**（`/team-tasks` 返回的那几格就是全部）⇒ 卡上印不出来，
		 * 这件事写在块头那句注解里，不留白让人以为是没显示。
		 */
		const TEAM_TASK_STAGES = [
			{ key: 'all', label: '全部', match: () => true },
			{ key: 'ready', label: '可认领', match: (row) => row.ready === true },
			{ key: 'blocked', label: '有依赖', match: (row) => Array.isArray(row.blockedBy) && row.blockedBy.length > 0 },
			{ key: 'overlap', label: '写盘面重叠', match: (row) => Array.isArray(row.writeScopeWarnings) && row.writeScopeWarnings.length > 0 },
		]

		/**
		 * 运行时状态（**内置 Agent Teams 名册那一份**，与 `list_agents` 同源）的中文说法。
		 * `inactive` 也不等于"空闲可派"，所以词面用「无轮次」——与内置工具的回执同一套说法。
		 */
		const MEMBER_RUNTIME_WORDS = { running: '跑着', inactive: '无轮次', provisioning: '创建中', failed: '失败' }
		/**
		 * 「技能」块的分档 chip。
		 *
		 * 注意：这三档**不是一份划分**（一个技能可以既给模型用、也给人用），所以它们是**筛选条件**
		 * 而不是分栏：条数各算各的，加起来可以大于总数 —— 印出来的是事实，不是比例。
		 */
		const SKILL_STAGES = [
			{ key: 'all', label: '全部', match: () => true },
			{ key: 'model', label: '模型可调用', match: (skill) => skill.modelInvocable === true },
			{ key: 'user', label: '人可调用', match: (skill) => skill.userInvocable === true },
		]
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
		function StatusView(props) {
			useComposerHidden(props.slots === undefined ? null : props.slots)
			const store = props.sessions === undefined ? null : typeof props.sessions === 'function' ? props.sessions() : props.sessions
			const workspace = useCurrentWorkspace(store)
			const sessionId = useCurrentSessionId(store)
			// **拼参数用同一套**（`paneQueryOf`）：`/status` 在拿不到工作区时会**按会话**回落推断，缺 session 就少了那条路。
			const target = STATUS_ENDPOINT + paneQueryOf(workspace, sessionId)
			const [tick, setTick] = React.useState(0)
			const [snapshot, setSnapshot] = React.useState({ phase: 'loading' })
			// 明细**默认就展开**：人已经点进这一栏了，还要再点一下才看得到活儿就是白加一层
			//（现场原话：「为什么要把『任务看板』这些折叠起来？」）。这里不再有展开/收起。
			const [tab, setTab] = React.useState(0)
			const [notice, setNotice] = React.useState(null)
			const paneFill = usePaneHeight()

			/**
			 * **重读的触发**（这里没有「刷新」按钮了）。
			 *
			 * `tick` 就是各块取数的那个计数：切块 / 切工作区 / 重开面板都会重挂重取，而
			 * "停在同一屏上、想让它自己变新"这一件事，交给两条**更自然的触发**：
			 *   · **窗口重新获得焦点**（`focus`）—— 你切出去看别的、再回来；
			 *   · **面板重新可见**（`document` 的 `visibilitychange` 且状态是 visible）—— 标签页切回来。
			 * 两条都只 `+1`，不会重复取（取数在各块的 effect 里按 `reload` 依赖跑）。
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
			 *
			 * 现场：切会话后点「成员 / 技能 / 任务看板」都要等一下才出内容 —— 端点只要 1–4 ms，
			 * 慢的是"每次重挂才开始拉"。这里提前拉热（三个并发，`force` 绕开缓存），
			 * 于是点哪一块几乎瞬间就有内容；`getJsonCached` 那层 TTL 让接下来 3 秒内的重挂不再发请求。
			 * **里程碑那一档已撤**（任务在原生那本账上）⇒ 不再为它花一次请求。
			 */
			React.useEffect(() => {
				if (typeof fetch !== 'function' || workspace === '') return undefined
				const query = paneQueryOf(workspace, sessionId)
				for (const endpoint of [MEMBERS_ENDPOINT, SKILLS_ENDPOINT, TEAM_TASKS_ENDPOINT]) {
					try {
						void getJsonCached(endpoint + query, { force: true }).catch(() => null)
					} catch {
						/* 预取失败不影响任何东西：真正需要时各块自己会再拉一次 */
					}
				}
				return undefined
			}, [workspace, sessionId])

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
			const unfinished = data === null || !Array.isArray(data.unfinished) ? [] : data.unfinished

			// **面板不念那一行，也不念「卡住」那一行**（现场两轮的原话：「这一行根本没必要」、
			// 「『卡住：无』这个为什么要展示」）。口径：
			//   · 计数在**分栏表头**上，本来就写着每栏几条，复述一遍是重复；
			//   · 「卡住」不是一类要单独开辟一块的东西 —— 被打回的进「已打回」分栏，写了 `blocked_by`
			//     的**挂在它自己那张卡上**（`卡在：…`），人翻到那张卡就看见，不用先在顶上读一句汇总。
			// 端点仍然回那一行（`team_status` 与"人问状态"要用它），只是**面板一个字都不显示**。
			// 首屏这一行读失败时也给一枚「重读」：宿主刚重启那会儿它可恢复，
			// 而恢复动作从前只挂在窗口 `focus` / 面板重新可见两条触发上 —— 界面上看不见、也点不到。
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

			// **这份读数是哪本账**：端点给了 `source`（`native` = 原生 Agent Teams；`legacy` = 工作区里那份
			// 不再更新的遗留文件）⇒ 只有它不是原生时才印一句，免得把"历史遗留"读成现状。
			// 话术优先用端点自己给的 `sourceLine`（措辞只有它那一处正文），没有再退回一句常量。
			const statusSource = data === null ? '' : text(data.source)
			const sourceNote =
				statusSource === '' || statusSource === 'native'
					? null
					: el(
							'div',
							{ className: 'cbv-pane-note cbv-md', key: 'status-source', 'data-status-source': statusSource },
							markdownNodes(text(data.sourceLine) === '' ? '这一行状态读的是**遗留文件**（它自某个版本起不再更新）—— 现状以原生那本账为准（`team_status` / `member_list`）。' : text(data.sourceLine), 'status-source'),
						)

			// **一行到底，没有第二种状态**：三块切换 ｜ 工作区路径。
			//   · 不再有「展开明细 / 收起」—— 明细本来就在，多那一下是白加一层；
			//   · 「复制产物路径」换成**工作区按钮**（点它开本地目录，路径同时进剪贴板兜底）——
			//     复制一串产物路径的用处，远不如直接把那个目录打开；
			//   · 顺序上块切换在前、动作紧随、工作区路径压尾：这一行从"干什么"读到"在哪干"；
			//   · 标签就是**完整路径**、不再单独占一行：只印末段名字，多工作区并排时分不清是哪一个。
			const target_ = data === null ? '' : typeof data.docsPath === 'string' ? data.docsPath : typeof data.workspace === 'string' ? data.workspace : ''
			const projectLabel = target_ === '' ? '项目路径' : target_
			const projectTitle = target_ === '' ? '这个工作区的路径还没取到' : '点开：' + target_ + '（主进程开本地目录；开不了就只把路径复制给你）'
			// 点它**先请主进程开目录**，开不了才退回复制路径 —— 并且**直说是哪一种**：
			// 原来那句「路径已复制；若目录没打开，就把它粘进文件管理器」把判断推给了人，是句含糊话。
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
				{ style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 } },
				// 块表 = 成员 / 技能 / 任务看板；`tab === 0` 就是**默认落在成员块**上（第一块即默认那一块）。
				BLOCKS.map((block, index) =>
					el(
						'button',
						{
							key: block.ledger,
							className: 'cbv-btn',
							type: 'button',
							// 块名落在 `data-` 上（不挂 title）：核对/自检按 `data-pane-block` 找这几个按钮，
							// 不必靠按钮文案去猜（页面里还有别的按钮也带 `aria-pressed`，比如筛选 chip）。
							'data-pane-block': block.ledger,
							'aria-pressed': tab === index ? 'true' : 'false',

							// 选中的块：**中性实底 + 字重**（不给品牌色，与主题同一套灰阶）。
							style: tab === index ? { borderColor: 'transparent', background: 'var(--cbv-a3)', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } : undefined,
							onClick: () => setTab(index),
						},
						block.label,
					),
				),
				// 工作区按钮压在末尾：块切换在前、动作在后，最后才是"这是哪个工作区"。
				// **这里不再有「刷新」按钮**（人的判断：切块/重开面板本来就会重挂重取，多一枚按钮是重复入口）——
				// 重读改由**更自然的触发**负责：窗口回到前台、或面板重新可见时各重读一次（见下面那个 effect）。
				el(
					'button',
					{ className: 'cbv-btn', type: 'button', title: projectTitle, onClick: openProject },
					projectLabel,
				),
				notice === null ? null : el('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' } }, notice),
			)

			// 明细区按当前选中的那一块渲染：任务看板走视图
			// （`showHeader: false` ⇒ 内嵌形态、不重复画栏头）；「成员」「技能」两块各有自己的
			// 视图（不是视图：没有分栏与文件卡片）。
			const block = BLOCKS[tab] === undefined ? BLOCKS[0] : BLOCKS[tab]
			const detail = el(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: '8px', flex: '1 1 auto', minHeight: '0' } },
				// **把面板的重读计数传下去**：内嵌形态不自己画（`showHeader: false`），而各块的取数
				// 都靠这个计数（切块 / 切工作区 / 窗口回到前台 / 面板重新可见时 +1）。
				block.ledger === 'members'
					? el(MembersView, { key: block.ledger, sessions: props.sessions, reload: tick })
					: block.ledger === 'skills'
						? el(SkillsView, { key: block.ledger, sessions: props.sessions, reload: tick })
						: block.ledger === 'board'
							? el(TaskBoardView, { key: block.ledger, sessions: props.sessions, slots: props.slots, reload: tick })
							: el(LedgerView, { key: block.spec.ledger, spec: block.spec, sessions: props.sessions, slots: props.slots, hideComposer: false, showHeader: false, reload: tick }),
			)

			// 根元素带 `cbv-root` + `data-team-ops-pane`：那条"本栏在场才收掉拖拽条"的 CSS 靠它限定范围。
			// 高度**优先用量的**（`fillHeightFrom`）：CSS 里那个 `calc(100vh - 210px)` 只是量不到时的兜底 ——
			// 它是猜的数，壳一改就在底下留出一块空白（现场反复出现的那一条）。
			// `title` 上的这串是**布局标记**：这几轮反复出现"运行里的到底是哪一版"的争论，
			// 给一个悬停即可核对的标记 —— 换了布局就换这串字，人和 AI 都不必再猜。
			return el(
				'div',
				{
					className: 'cbv-root',
					'data-team-ops-pane': '',
					// 布局标记改走 **data 属性**：现场要的是"能核对运行里是哪一版"，而 `title` 会在鼠标经过时弹一大块提示
					// （现场原话：「鼠标放在看板区域不要展示鼠标悬浮提示，影响体验」）。属性在 DOM 里看得见、不干扰操作。
					'data-pane-mark': PANE_MARK,
					style: paneFill === null ? undefined : { height: paneFill + 'px' },
				},
				head,
				sourceNote,
				actions,
				detail,
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
			// **打开前焦点在哪**（= 触发它的那张卡）：关闭时还回去，键盘用户不必每关一次就从页头重新 Tab。
			// 只在"关着 → 打开"那一次记（翻页时 `detail` 变的是 id，焦点已经在我们自己的浮窗里了）。
			const restoreRef = React.useRef(null)
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
					// 这是人的指定：上下管"这一栏里的下一条"，左右管"换一栏"。
					else if (event.key === 'ArrowUp') handlers.current.onStep(-1)
					else if (event.key === 'ArrowDown') handlers.current.onStep(1)
					else if (event.key === 'ArrowLeft') (handlers.current.onColumnStep ?? handlers.current.onStep)(-1)
					else if (event.key === 'ArrowRight') (handlers.current.onColumnStep ?? handlers.current.onStep)(1)
					else if (event.key === 'Tab') trapTab(event, modalRef.current)
				}
				document.addEventListener('keydown', onKey)
				return () => document.removeEventListener('keydown', onKey)
			}, [detail])
			React.useEffect(() => {
				const node = modalRef.current
				if (detail === null) {
					// **关闭：把焦点还回去**。列表翻页/重读会重渲染，旧节点可能已经不在文档里 ——
					// 那就不要硬抢焦点（`isConnected === false` 时只清掉记录）。取不到 DOM 的环境安静跳过。
					const back = restoreRef.current
					restoreRef.current = null
					try {
						if (back !== null && back !== undefined && back.isConnected !== false && typeof back.focus === 'function') back.focus()
					} catch {}
					return
				}
				if (restoreRef.current === null) {
					try {
						const active = typeof document === 'undefined' || document === null ? null : document.activeElement
						if (active !== null && active !== undefined && active !== node) restoreRef.current = active
					} catch {
						/* 读不到 activeElement 就不记：关闭时不还焦点，比还错地方好 */
					}
				}
				if (node === null || node === undefined || typeof node.focus !== 'function') return
				try {
					node.focus()
				} catch {}
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
		 * 筛选**只从原生给的字段里选档**（可认领 / 有依赖 / 写盘面重叠 + 一栏搜索），
		 * 判据一律照抄原生载荷（`ready` / `blockedBy` / `writeScopeWarnings`），面板不自己再算一遍；
		 * 原生没有优先级与时间字段 ⇒ 卡上印不出来，这句话写在块头那句注解里。
		 *
		 * 这一档**只读**：认领 / 完成 / 改依赖 / 改归属都是 `team_task_*` 那套会话工具的活
		 * （CAS + 授权 + 留痕的完整事务），面板只把**同一份视图**摆出来。
		 * @param props - 与其余块一样：`sessions` / `slots` / `reload`（面板的重读计数）。
		 */
		function TaskBoardView(props) {
			const store = props.sessions === undefined ? null : typeof props.sessions === 'function' ? props.sessions() : props.sessions
			const workspace = useCurrentWorkspace(store)
			const sessionId = useCurrentSessionId(store)
			const [team, setTeam] = React.useState({ phase: 'loading' })
			// 本块自己的重读计数（错误态那枚「重读」用它；面板的 `props.reload` 仍是主触发）。
			const [localTick, setLocalTick] = React.useState(0)
			// 这一块的筛选：分档 chip（可认领 / 有依赖 / 写盘面重叠）+ 搜索（编号 / 主题 / owner / 依赖 / 写盘面）。
			// 任务过十条时，"先干哪条"要在这一屏上看出来 —— 肉眼看三栏不是筛选。
			const [stage, setStage] = React.useState('all')
			const [query, setQuery] = React.useState('')

			// 详情浮窗：`null` = 关着；否则 `{ id }`（**存 id 不存行** —— 重取之后浮窗里那份不会变成旧快照）。
			const [detail, setDetail] = React.useState(null)
			// 翻页要在 keydown 回调里读"当前这一份"，用 ref 承载（与 `LedgerView` 同一条做法）。
			const navRef = React.useRef({ ordered: [], index: -1 })
			// 键盘（← → **切换分栏**、Esc 关）与打开后聚焦走共用那一份；两个按钮仍在栏内翻。
			const modalRef = useDetailModal(detail, () => setDetail(null), (offset) => step(offset), (offset) => columnStep(offset))

			React.useEffect(() => {
				let cancelled = false
				if (typeof fetch !== 'function') {
					setTeam({ phase: 'error', error: '当前环境没有 fetch' })
					return () => {}
				}
				getJsonCached(teamTasksUrlOf(workspace, sessionId))
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						if (cancelled) return
						if (payload === null) {
							setTeam({ phase: 'error', error: 'HTTP ' + response.status + '：响应不是 JSON' })
							return
						}
						// 这一条端点**永远 200**（团队那半边读不到也算正常答），所以这里只认 `ok`。
						if (payload.ok === true) {
							setTeam({ phase: 'ready', data: payload })
							return
						}
						setTeam({ phase: 'error', error: typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status })
					})
					.catch((error) => {
						if (cancelled) return
						setTeam({ phase: 'error', error: '' + error })
					})
				return () => {
					cancelled = true
				}
			}, [props.reload, localTick, workspace, sessionId])

			// **本插件那份看板已经撤掉**：`.company-gate.board.json` 没有写入者了（任务在 DSH 原生
			// Agent Teams 那本账上）⇒ 这里不再为它发一次没人消费的请求，也不再算那套只给已撤视图看的
			// `phaseSpec` —— 一次白跑的取数 + 一段每次渲染都跑的 IIFE，正是"看起来还在跑"的那种壳。

			const teamData = team.phase === 'ready' ? team.data : null
			const teamRows = teamData !== null && Array.isArray(teamData.rows) ? teamData.rows : []
			const teamAvailable = teamData !== null && teamData.available === true
			const teamReason = teamData !== null && typeof teamData.reason === 'string' ? teamData.reason : team.phase === 'error' ? team.error : ''
			const teamWarnings = teamData !== null && Array.isArray(teamData.warnings) ? teamData.warnings : []
			// 原生按条数截断过的字段（载荷 `truncations`）：卡上逐条印"只列了前 N 条（共 M 条）"。
			const teamTruncations = teamData !== null && Array.isArray(teamData.truncations) ? teamData.truncations : []
			// **只有一档**：任务与成员都在 DSH 原生 Agent Teams 里（本插件那两份文件不再写入），
			// 所以这里不再有"两个来源"这件事 —— 从前那一档（按 `phase` 分栏的里程碑视图）读的文件
			// 已经没人写了，留着它只会让人以为"板子是空的"。
			const source = 'team'

			const stageSpec = TEAM_TASK_STAGES.find((item) => item.key === stage) ?? TEAM_TASK_STAGES[0]
			const needle = query.trim().toLowerCase()
			// 分档与搜索**都只看原生给的那几个字段**（不自己算"可认领"：`ready` 是原生算的）。
			const visibleRows = teamRows.filter(
				(row) => stageSpec.match(row) && (needle === '' || haystackOf(row).indexOf(needle) !== -1),
			)
			const stageCount = (item) => teamRows.filter((row) => item.match(row)).length
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
				// `ready` 是**原生算的**（pending 且依赖全完成）：照印，不自己按 blockedBy 再算一遍。
				const pendingState = status !== 'pending' ? null : row.ready === true ? el('span', { className: 'cbv-chip cbv-chip--ok', key: 'ready' }, '可认领') : el('span', { className: 'cbv-chip cbv-chip--exception', key: 'blocked' }, '等依赖')
				const kids = [
					el(
						'div',
						{ className: 'cbv-card-top', key: 'top' },
						el('span', { className: 'cbv-id', key: 'id' }, id === '' ? '(无编号)' : id),
						el('span', { className: 'cbv-chip', key: 'owner' }, text(row.ownerName) === '' ? '未指派' : text(row.ownerName)),
						pendingState,
						el('span', { className: 'cbv-chip', key: 'rev' }, 'v' + text(row.revision)),
						el('span', { className: 'cbv-spacer', key: 'spacer' }),
					),
					el('div', { className: 'cbv-desc', key: 'subject' }, subject === '' ? '（没有主题）' : subject),
					// **描述只印一次**：折叠卡上印成这一行 `.cbv-sub`；浮窗里印成下面那个块（`cbv-block`）。
					// 浮窗是"把卡整块再渲染一遍"的形态 ⇒ 这一行必须在这里让位，否则同一段文字会连着出现两遍
					// （现场：上面一行、下面一块，一模一样）。与 subject 同一段时同样不印（那已经印在上面了）。
					description === '' || descriptionIsDuplicate || isOpen ? null : el('div', { className: 'cbv-sub', key: 'desc' }, description),
					blockedBy.length === 0 ? null : el('div', { className: 'cbv-sub', key: 'blocked' }, '依赖 ' + blockedBy.join('、')),
					scopes.length === 0 ? null : el('div', { className: 'cbv-sub', key: 'scopes' }, '写盘面 ' + scopes.join('、')),
					// 原生的写盘面重叠告警：**原文**透出（措辞只有原生那一处正文）。
					scopeWarnings.map((line, at) => el('div', { className: 'cbv-note cbv-note--warn cbv-note--box', key: 'sw' + at }, line)),
					// 被截断的那几个数组：**逐条印出"只列了前 N 条（共 M 条）"** ——
					// 折叠卡与浮窗里都看得见（浮窗是"整块再渲染一遍"，所以这一处只写一次）。
					truncations.map((item, at) =>
						el(
							'div',
							{ className: 'cbv-note cbv-note--warn cbv-md', key: 'tr' + at, 'data-tt-truncated': text(item.field) },
							markdownNodes(`只列了前 ${text(item.shown)} 条（共 ${text(item.total)} 条）：原生把 \`${text(item.field)}\` 按条数截到 ${text(item.limit)} 条 —— 字段的判据仍按**全部**条目算。`, 'trunc' + at),
						),
					),
				]
				// 展开那一支（浮窗里）：**只补"卡上还没有的东西"，不再把原生字段摊一遍**。
				//
				// **原则（防回归）**：给人看的界面**不印原生字段名、也不印系统坐标** ——
				// 状态 / 负责人 / 版本号 / 可认领 / 依赖 / 写盘面这几件事，卡上已经用**中文各说了一次**
				// （`在办|待办|已完成` chip、owner chip、`v<版本>` chip、`可认领|等依赖` chip、「依赖 …」、「写盘面 …」）；
				// 浮窗是"把卡整块再渲染一遍"，若在这里再印一遍 `status：` / `revision：` / `ownerName：` /
				// `ready：` / `blockedBy：` / `writeScopes：`，同一件事就有两种说法、且后一种是**系统坐标**
				// ——与人看到的交付物口径（BASELINE §八之一：不写内部编号与状态自述）是同一件事。
				//
				// `revision`（改任务要带的版本号）与 `ready`（原生算的"可认领"）**只对工具有用**：
				// 要改任务时**工具回执**会给出该带什么，界面上不必印。
				if (isOpen) {
					const facts = []
					if (scopeWarnings.length > 0) facts.push(mdField('cbv-block', scopeWarnings.map((line) => '- ' + line).join('\n'), '', 'scope-warnings'))
					if (description !== '' && !descriptionIsDuplicate) facts.push(mdField('cbv-block', description, '', 'description'))
					if (facts.length > 0) kids.push(el('div', { className: 'cbv-detail', key: 'detail' }, facts))
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

			// 详情浮窗的**栏内翻页**：先认出这一条属于哪一栏，再只把那一栏的条目排进去
			// （跨栏不翻 —— 与看板同一条口径：顺序是屏幕上的栏内序，不是原生的编号序）。
			// **用筛过的那一份**（`visibleRows`）：屏幕上被筛掉的行不进翻页池，否则"下一条"会跳到看不见的条目上。
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
			const teamBoard = [
				team.phase === 'loading'
					? el('div', { className: 'cbv-pane-empty', key: 'teamLoading', 'data-team-phase': 'loading' }, '正在读取本会话的团队任务板…')
					: teamAvailable
						? teamEmpty
							? el(
									'div',
									{ className: 'cbv-pane-empty cbv-md', key: 'teamEmpty', 'data-team-phase': 'ready' },
									markdownNodes('这个会话还没有原生（Agent Teams）任务 —— 这一档读的是**本会话的共享任务板**（进程级、只读），别的会话里那些任务不在这里显示。', 'team-empty'),
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

				// 原生给的那几行告警（写盘面重叠之类的原文）：它自己写的就是 markdown ⇒ 走渲染，标记不上屏。
				...teamWarnings.map((line, index) => el('div', { className: 'cbv-pane-warn cbv-md', key: 'w' + index }, markdownNodes(line, 'tt-warn' + index))),
				overlay,
			]

			// 头那一行：与成员/技能**同形**（`.cbv-view-head` = 标题 + 一句注解）。
			const blockHead = el(
				'div',
				{ className: 'cbv-view-head', key: 'head' },
				el('span', { className: 'cbv-view-title', key: 'title' }, '任务看板'),
				// **头那一行只留标题 + 那句注解**（人的指令：计数不用在这里再印一遍 —— 筛选 chip 上写着真数）；
				// "原生没有优先级 / 时间"这件事写在这里：卡上印不出来是**原生没这格**，不是面板没显示。
				el('span', { className: 'cbv-pane-hint', key: 'hint' }, '本会话 Agent Teams 的共享任务板（原生三档，进程级；只读）；原生任务没有优先级 / 时间字段，卡上印不出来'),
			)

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
				el('span', { className: 'cbv-pane-hint', key: 'stage-hint' }, 'chip 是筛选条件，不是划分'),
				el('input', {
					className: 'cbv-input cbv-flt-search',
					key: 'query',
					type: 'text',
					value: query,
					placeholder: '搜索：编号 / 主题 / 描述 / owner / 依赖 / 写盘面…',
					'aria-label': '搜索本会话的团队任务',
					onChange: (event) => setQuery(event.target.value),
				}),
			)

			// "本栏只读"那一句**单独占一行**（它管的是这一档的操作边界，与筛选行不是一回事）：
			// 压在筛选行里会被挤成省略号，而这一栏的操作提示只此一处。
			const readOnlyNote = el(
				'div',
				{ className: 'cbv-pane-note', key: 'ro-note' },
				inlineNodes('本栏只读：认领 / 完成 / 改依赖走 `team_task_*` 那套工具（面板只把原生那份账画出来）', 'ro'),
			)

			return el(
				'div',
				{ className: 'cbv-view', key: 'board-block', ref: null, 'data-board-picked': source, 'data-board-mark': PANE_MARK, reload: props.reload },
				blockHead,
				toolbar,
				readOnlyNote,
				...teamBoard,
			)
		}

		/**
		 * 「成员」块（视图栏第一块，打开面板即落在这里）：**本会话现在有哪些 agent**。
		 *
		 * 这张表是**两个来源 join 出来的**（join 的判定在宿主那一处，见 `mergeRoster`）：
		 *   · **本会话的 Agent 团队名册** —— 宿主 `ctx.agentTeams`（与内置 `list_agents` 是同一处正文）：
		 *     协调者永远在最前，其后是队友（`running` / `inactive` / `provisioning` / `failed`）。
		 *     **本插件起没起过成员都不影响它** —— 所以这块再也不会"一个 agent 都不展示"。
		 *   · **旧名册那一份已经撤掉**（task-40）：面板不读 `.company-gate.members.json`，
		 *     也没有"在册 / 未入册"这两种身份了 —— 一位成员就是原生名册里的一行。
		 *     卡上只读的几格各自的真源：运行时状态（活着的 Agent）、**已停用**（`.company-gate.member-flags.json`）、
		 *     未读（邮箱文件）、头像与色调（引擎按角色给）。
		 *
		 * **整栏只读**（人的判断 A 方案）：成员是**宿主原生的队友**，本插件不改、不删、不启停 ——
		 * 从前的启用·停用 / 编辑 / 删除打的是 `/members/update|delete`，而那条路在 host 侧早已直接拒绝，
		 * 点了必失败。现在卡上只有**服务端给的那三个动词**（停用 / 恢复 / 打断，`row.verbs`；
		 * 「查看 / 复制提示词」随旧名册一起撤了）；整栏一句指路说清"不用的不再派活、
		 * 打断当前那一轮用内置 `interrupt_agent`"。
		 * 生成员仍然不在这里（那是 `member_spawn` 的事）。
		 *
		 * 三条硬口径：
		 *   · 「名册未建立」与「名册建立但里面没人」是**两件事**，两句话说清、不共用；
		 *   · 「读不到」不印成没有 —— 文件读数给 `null` 就印 `?`；团队名册读不到就印那一行理由原文，
		 *     并且**照旧列出只有文件的那些行**（不许因为团队读不到就把整个块变空）；
		 *   · 枚举外的编制状态照显原文、不归并。
		 * @param props - `sessions` 取当前会话（工作区跟着它、团队名册也按它拿）；
		 *   `reload` 是面板的重读计数（切块 / 窗口回到前台 / 面板重新可见时 +1；本块自己不发请求）。
		 */
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
			if (block === null || !Array.isArray(block.rows) || block.rows.length === 0) return null
			const hiddenRows = Array.isArray(block.hiddenRows) ? block.hiddenRows : []
			// **来源筛档**（task-38）：档位与中文标签都来自载荷（`originFacets`，服务端那一处正文）——
			// 前端**不硬编码**任何"哪个 origin 该显示什么"的判断，只按 key 过滤。
			const originFacets = Array.isArray(block.originFacets) ? block.originFacets : []
			// 档位从调用方传进来（`rosterSectionOf` 与 `MembersView` 是两个作用域，别直接读那边的 state）。
			const originFacet = text(act.rosterOriginFacet) === '' ? 'all' : text(act.rosterOriginFacet)
			const shownRows = originFacet === 'all' ? block.rows : block.rows.filter((row) => text(row.origin) === originFacet)
			// **这一节不印任何汇总读数**（人的口径：面板上的统计性描述都去掉）：上面那排筛选 chip 写着真数，
			// 每张角色卡自己带着编制状态；要机器核对看 `data-roster-count`（数据属性，不是给人读的一行字）。
			return el(
				'div',
				{ className: 'cbv-roster', key: 'roster', 'data-roster-count': '' + block.rows.length, 'data-roster-hidden': '' + hiddenRows.length, 'data-roster-established': block.established === true ? 'true' : 'false' },
				el(
					'div',
					{ className: 'cbv-view-head', key: 'roster-head' },
					// 标题就叫「角色」（人的指令：原来那个「角色」念着绕）——这一节本来就是包内 20 个角色名册。
					el('span', { className: 'cbv-view-title', key: 'roster-title' }, '角色'),

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
					// **添加**：新角色写在用户角色根（`$DSH_HOME/team-ops/roles/<id>/ROLE.md`）——
					// 那是"你自己的角色"，包内那份不受影响、升级也不会被刷掉。
					el('button', { className: 'cbv-btn', key: 'roster-add', type: 'button', 'data-roster-action': 'add', onClick: () => act.openRosterDialog({ kind: 'create' }) }, '＋ 添加角色'),
				),
				el(
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
							// 状态行**只在这一档真有人时印**（谁在场 / 谁归档 / 谁退役 / 删过谁）——
							// 绝大多数角色是空档，「未到场」印 18 遍不是信息。`data-roster-state` 照旧在，
							// 核对的人看属性；空档怎么叫、名字会取哪个，都在这一节的收尾说一次。
							text(row.state) === 'vacant' ? null : el('div', { className: 'cbv-sub', key: 'state' }, text(row.label)),
							// 两个写动作（改 / 删·下架）：**动作名按出处说准** —— 包内角色是发布面，
							// 它那两个动词是"改（在用户根写一份同名覆盖）"与"下架（可恢复）"，
							// 不是"删掉那个角色"。判据来自载荷的 `removal`（服务端算的，客户端不猜）。
							el(
								'div',
								{ className: 'cbv-cardbar', key: 'bar' },
								el('button', { className: 'cbv-cardbtn', key: 'edit', type: 'button', 'data-roster-action': 'edit', onClick: () => act.openRosterDialog({ kind: 'edit', entry: row }) }, '修改'),
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
							markdownNodes('名册文件还没建立 —— **一个人都还没叫过**（这不是「读不到」：没人叫过就不会有这个文件）。下面每一档的状态都按"还没叫过"回答。', 'roster-unestablished'),
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
				// 收尾那段"怎么叫人 / 名字怎么取 / 状态怎么变"**不再印在面板上**（人的指令：描述性文字太多）：
				// 叫法在**输入框那一枚「角色」按钮**与会话里的 `member_spawn` 里；卡上没有状态行就是"未到场"这一条
				// 由 `data-roster-state` 兜着（核对看属性）。
				null,
			)
		}

		/** 我们这一套 `@` 来源的稳定 id（引用对象的 `source` 必须与它逐字相等）。 */
		// ── ⑪ 角色触发源与输入框席位 ─────────────────────────────────────────────
		const ROLE_SOURCE_ID = 'team-ops:roles'

		/** 名册缓存：`@` 菜单随时可能被打开，别每敲一个字就打一次端点（短 TTL + 同一个工作区复用）。 */
		const rosterCache = new Map()
		/** **最后一次真读到的名册**（按 key 存）：热词典是**同步**函数，只能读这一份。 */
		const rosterKnown = new Map()
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
			for (const rows of rosterKnown.values()) {
				for (const row of rows === null || rows === undefined ? [] : rows) {
					const id = text(row?.role)
					if (id === '' || seen.has(id)) continue
					seen.add(id)
					const label = text(row?.category) === '' ? '未分类' : text(row.category)
					const group = groups.find((entry) => entry.label === label)
					if (group === undefined) groups.push({ key: label, label: label, rows: [row] })
					else group.rows.push(row)
				}
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
			for (const rows of rosterKnown.values()) {
				for (const row of rows === null || rows === undefined ? [] : rows) {
					const id = text(row?.role)
					if (id !== '') names.add(id)
				}
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
			const promise =
				typeof fetch !== 'function'
					? Promise.resolve([])
					: getJsonCached(MEMBERS_ENDPOINT + (workspace === '' && sessionId === '' ? '' : paneQueryOf(workspace, sessionId)))
							.then((response) => response.json())
							.then((payload) => {
								const rows = payload !== null && payload.defaults !== undefined && payload.defaults !== null && Array.isArray(payload.defaults.rows) ? payload.defaults.rows : []
								rememberRoster(key, rows)
								return rows
							})
							.catch(() => [])
			rosterCache.set(key, { at: Date.now(), promise: promise })
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
			if (triggers === null || triggers === undefined || typeof triggers.registerSource !== 'function') return () => {}
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
						const id = text(session?.sessionId)
						await rosterRowsOf(workspaceOfSession(sessions, id), id)
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
					// **热词典**：直接打 `@qa`（不必先开菜单）也算引用 —— 词典按组给（本体那边会合并）。
					lexicon: () => knownRoleNames().filter((name) => group.rows.some((row) => text(row?.role) === name)),
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
			const current = resolveCurrentSessionId()
			void rosterRowsOf(workspaceOfSession(sessions, current), current).then(() => sync())

			return () => {
				lexiconSubs.delete(sync)
				for (const dispose of registered.values()) dispose()
				registered.clear()
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
			// 草稿：本体自己的读法（`useInput((s) => s)`）—— 取不到就当空串（旧宿主没有这个 prop）。
			const inputState = typeof slotsProps.useInput === 'function' ? slotsProps.useInput((state) => state) : null
			const draft = inputState === null || inputState === undefined ? '' : text(inputState.draft)
			const setDraft = typeof slotsProps.inputActions === 'object' && slotsProps.inputActions !== null && typeof slotsProps.inputActions.setDraft === 'function' ? slotsProps.inputActions.setDraft : null
			// 工作区：与视图栏那一席同一处口径（会话清单里那一条的 cwd）。
			const workspace = typeof slotsProps.useSessions === 'function' ? text(slotsProps.useSessions((state) => (sessionId === '' || state === null || state === undefined || typeof state.byId !== 'object' || state.byId === null ? undefined : state.byId[sessionId]?.cwd))) : ''
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
			// 选择框浮在输入框**上方**：位置按按钮自己的位置算（`position:fixed`），
			// 免得被输入框那一带的任何 overflow 裁掉。拿不到 DOM（比如不在浏览器里）就退回一个保守位置。
			const [popAt, setPopAt] = React.useState({ left: 12, bottom: 64 })
			const buttonRef = React.useRef(null)
			const popRef = React.useRef(null)
			const [query, setQuery] = React.useState('')
			const [rows, setRows] = React.useState(null)
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
				rosterRowsOf(workspace, sessionId).then((list) => {
					if (alive) setRows(list)
				})
				return () => {
					alive = false
				}
			}, [needRoster, rows, workspace, sessionId])

			// 打开时量一次按钮位置（窗口尺寸变化时重算；关掉就不用管了）。
			React.useEffect(() => {
				if (!open) return undefined
				const place = () => {
					const node = buttonRef.current
					if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return
					const rect = node.getBoundingClientRect()
					const inner = typeof window === 'undefined' || typeof window.innerHeight !== 'number' ? 800 : window.innerHeight
					const left = Math.max(8, Math.min(rect.left, (typeof window === 'undefined' ? 1200 : window.innerWidth) - 428))
					setPopAt({ left: left, bottom: Math.max(8, inner - rect.top + 8) })
				}
				place()
				if (typeof window.addEventListener !== 'function') return undefined
				window.addEventListener('resize', place)
				return () => window.removeEventListener('resize', place)
			}, [open])

			// **失去焦点就关**（人的指令：「弹窗失去焦点后会主动关闭」）：
			// 点在按钮与选择框**之外**（任何地方：另一块面板、消息区、别处的输入框）就立刻收起。
			// 用 capture 阶段听 `pointerdown`：这样即使别的组件在冒泡阶段 `stopPropagation`，我们照样收得到。
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
					// **不 preventDefault**：Escape 在浏览器里本来没有默认动作，而我们是在 `document` 上听的 ——
					// `preventDefault` 会顺手改掉别的组件（以及宿主壳）对同一个按键的默认行为。
					// 我们只做自己那一件事：收起来。
					if (event.key === 'Escape') setOpen(false)
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
					// ① 先试**插引用**：与 `@` 菜单里选中同一种东西（一枚 chip，显示中文名、文本是 `@角色名`）。
					try {
						const reference = { source: sourceId, ref: name, label: label === '' ? name : label, appearance: 'session', clipboardText: markerText.trimEnd() + '\u00A0' }
						if (access.scope.bail(access.scope, 'slash/input-insert-reference', { reference: reference, span: span }) === true) return true
					} catch {
						// 旧宿主没有这条事件 ⇒ 落到下一级
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

			// **按钮永远叫「角色」**（人的指令：选中的角色**不要显示在按钮上** —— 否则没法再选别的、
			// 也没法取消）。选中的角色显示在它**旁边那一枚小片**上：点小片正文 = 让它去干，点 `×` = 取消；
			// 输入框里那段话被清空时也不作数（见下面那个 effect）。
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
						'data-composer-role': roles.join(' '),
						onClick: () => setOpen((value) => !value),
					},
					// 一枚图标（人的指令：「另外给角色配置一个图标」）：与头像用同一套描边几何。
					el('span', { className: 'cbv-composer-btn-icon', key: 'icon', 'aria-hidden': 'true' }, avatarIconOf('user')),
					'角色',
				),
				!open
					? null
					: el(
							'div',
							{
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
							el('div', { className: 'cbv-picker', key: 'list', role: 'listbox', 'data-composer-role-list': '' + matched.length },
								rows === null
									? el('div', { className: 'cbv-pane-empty', key: 'loading' }, '正在读角色名册…')
									: matched.length === 0
										? el('div', { className: 'cbv-pane-empty', key: 'none' }, '没有匹配的角色。')
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
															setOpen(false)
															if (!insertMarker(id, text(entry.category), text(entry.title))) setOpen(false)
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
						),
			)
		}

		// ── ⑫ 成员块 ─────────────────────────────────────────────────────
		function MembersView(props) {
			const store = props.sessions === undefined ? null : typeof props.sessions === 'function' ? props.sessions() : props.sessions
			const workspace = useCurrentWorkspace(store)
			// 会话 id 必须带上：团队名册是按**这个会话**拿的（`?session=`），少了它宿主只能报"读不到"。
			const sessionId = useCurrentSessionId(store)
			const target = membersUrlOf(workspace, sessionId)
			const [snapshot, setSnapshot] = React.useState({ phase: 'loading' })
			const [localTick, setLocalTick] = React.useState(0)
			// 团队服务那一层的开 / 关：**只有人点了那个按钮才动**（不静默改别人的 profile）。
			const [svcBusy, setSvcBusy] = React.useState(false)
			const [svcNote, setSvcNote] = React.useState(null)
			// 三个筛选：身份 chip（全部 / 协调者 / **已停用**（live flag））+ 运行时状态下拉 + 搜索。
			// **一排放一个 facet**（task-43，人的口径）：全部 / 协调者 / 已停用 / 各运行时值 **同级互斥** ——
			// 从前是"档位 ∧ 运行时值"两排叠加（能同时按两个维度筛），人看图后明确要**单选视图**；
			// 语义变化（不能再叠加）已写进验证记录。键形如 `lead` / `disabled` / `runtime:inactive`。
			const [memberFacet, setMemberFacet] = React.useState('all')
			const [query, setQuery] = React.useState('')
			// **只读这一块**（人的判断 A 方案）：成员是宿主原生的队友，本插件不改、不删、不启停。
			// 三个动作只剩**看**：查看提示词 / 复制提示词（都读同一份名册记录，不发任何写请求）。
			// task-40 起这一块**一只对话框都没有**（「查看 / 复制提示词」读的是旧名册里的 persona/prompt，随旧账撤掉）。
			const [dialog, setDialog] = React.useState(null)
			const [notice, setNotice] = React.useState(null)
			// 正在发的那个动词（`名字:动词`）—— 只用来禁用同一张卡上的按钮。
			const [memberBusy, setMemberBusy] = React.useState(null)
			// 「角色」那一节的**来源筛档**（null = 全部）：档位与标签都来自载荷。
			const [rosterOriginFacet, setRosterOriginFacet] = React.useState(null)
			// 「角色」那三个动作（添加 / 修改 / 删或下架）各自的形状：与成员那一个对话框**分开**两个
			// 状态机（两块在同一个滚动区里、可以先后开），但**同时只可能开一个**（打开时互相清掉）。
			const [rosterDialog, setRosterDialog] = React.useState(null)
			const [rosterDraft, setRosterDraft] = React.useState({ id: '', title: '', category: '', positioning: '', body: '', skills: '' })
			// 「专属技能」那个**多选下拉**是否展开（收起时也要看得出选了哪些 ⇒ 摘要那一行）
			const [skillsOpen, setSkillsOpen] = React.useState(false)
			const [rosterBusy, setRosterBusy] = React.useState(null)
			const [rosterNotice, setRosterNotice] = React.useState(null)

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
				// props.reload：面板的重读计数；localTick：本块那几个动作（团队服务开关 / 角色写）之后自己重取。
			}, [props.reload, localTick, target])

			/**
			 * **本块不发任何写请求**（人的判断 A 方案）：成员卡上从前那三个动作（启用·停用 / 编辑 / 删除）
			 * 打的是 `/members/update|delete`，而那条路在 host 侧早已直接回「本插件不再改成员…」——
			 * 点了必失败。整面撤掉之后这里只剩「查看提示词 / 复制提示词」：都读同一份名册记录。
			 */

			const data = snapshot.phase === 'ready' ? snapshot.data : null
			// **主表 = 原生名册那一份**（`merged`）：task-40 起这是**唯一**来源 —— 旧名册文件的读取路径
			// （`data.rows` / `ledger` / `matchedBy` / 历史编制行 / "未建立"那几句）全撤了。
			const rows = data !== null && Array.isArray(data.merged) ? data.merged : []
			const team = data !== null && data.team !== undefined && data.team !== null && typeof data.team === 'object' ? data.team : null
			const teamAvailable = team !== null && team.available === true
			const teamCount = team !== null && typeof team.count === 'number' ? team.count : 0
			const teammates = rows.filter((row) => row.kind === 'teammate').length
			const warnings = data !== null && Array.isArray(data.warnings) ? data.warnings : []

			/** 子会话 id 的**短显示**：只截长的（留尾部 12 位）；截的是显示，不是数据。 */
			const shortSession = (value) => {
				const full = text(value)
				if (full === '') return '—'
				return full.length <= 16 ? full : '…' + full.slice(-12)
			}
			const runtimeWordOf = (value) => MEMBER_RUNTIME_WORDS[value] ?? (value === '' ? '（未记）' : value)
			const runtimeValues = facetValuesOf(rows, 'runtime')
			// **一排放完**（task-43）：档位那几档（协调者 / 已停用）+ 各运行时值 **同级互斥**，只留一枚「全部」。
			// 每项带它**自己的**计数口径 —— 重叠的成员各自计入（一位"已停用且无轮次"的成员在这两档里都算：
			// "筛选条件不是划分"这件事没变，变的只是从前能叠加、现在是一排单选视图）。
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
			 * 与「角色」那三个动作同一套写法：服务端给动词（`row.verbs`），客户端只负责发与说结果。
			 * 回执里那句 `note` **原样印出来**（"它在原生名册里仍然在"这类话只有引擎说得准，客户端不复述）。
			 */
			const postMemberVerb = (url, name, verb) => {
				if (typeof fetch !== 'function') {
					setNotice({ tone: 'error', lines: ['当前环境没有 fetch'] })
					return
				}
				setMemberBusy(name + ':' + verb)
				setNotice(null)
				// **拼参数用同一套**（`paneQueryOf`：workspace + session 都带上）—— 这三条端点要**本会话的 Lead**
				// 当凭据，缺 `session` 就会被服务端如实拒（现场那条「请求里没带会话 id」就是这里漏的）。
				// 别在这单独手拼——手拼的那一版只带了 workspace，正是这个 bug。
				fetch(url + paneQueryOf(workspace, sessionId), {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ name }),
				})
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						setMemberBusy(null)
						if (payload !== null && payload.ok === true) {
							setNotice({ tone: 'ok', lines: [text(payload.note) === '' ? verb + '成功：' + name : text(payload.note)] })
							// **写完要失效缓存**：`/members` 是走 `getJsonCached` 的读端点，不失效就会拿到 TTL 内的旧载荷。
							invalidatePanes()
							setLocalTick((value) => value + 1)
							return
						}
						setNotice({ tone: 'error', lines: [payload !== null && text(payload.error) !== '' ? text(payload.error) : 'HTTP ' + String(response === undefined ? '' : response.status)] })
					})
					.catch((error) => {
						setMemberBusy(null)
						setNotice({ tone: 'error', lines: ['发不出去：' + String(error && error.message ? error.message : error)] })
					})
			}
			/** 「团队状态」那一档的计数行：`在场 N（已停用 M）/ 上限 X`（数全来自服务端；缺就不编）。 */
			const memberCountsText = (view) => {
				const counts = view !== null && view !== undefined && view.counts !== null && view.counts !== undefined ? view.counts : null
				if (counts === null || typeof counts.present !== 'number') return ''
				const max = typeof counts.max === 'number' ? counts.max : '—'
				const off = typeof counts.disabled === 'number' ? counts.disabled : 0
				return `在场 ${counts.present}（已停用 ${off}）/ 上限 ${max}`
			}

			/** 卡上那三个动词的按钮：**只看载荷给的 `verbs`**（服务端判过"现在能不能做"，客户端不猜）。 */
			const verbButtonsOf = (row, name) => {
				const verbs = row !== null && row !== undefined && row.verbs !== null && row.verbs !== undefined ? row.verbs : {}
				const busy = memberBusy !== null && String(memberBusy).indexOf(name + ':') === 0
				const buttonOf = (key, label, verb, url) => {
					const spec = verbs[verb]
					// **载荷没给这一格 ⇒ 不画**（那件事在这个上下文里不存在）。
					if (spec === null || spec === undefined) return null
					// **三个动词一律画**（task-41 定的口径）：不能做 ⇒ 禁用态 + 服务端 `why` 原样给到 title。
					// （「打断」从前是"能做才画"，于是"无轮次"的卡上干脆没有它 —— 那正是要避开的 UX 债：
					// 人看不到"为什么没有"，只看到一个空位。现在它与停用/恢复同一条判据。）
					// **载荷说不能做也画**（HD-006 的 UX 修正）：画成**禁用态**并把服务端的 `why` **原样**给出去
					// —— 藏起来等于让人猜"为什么这张卡上没有这个按钮"（人问过）。
					// **客户端不推断规则**：能不能做只看 `spec.ok`，理由只看 `spec.why`（措辞只有引擎一处正文）。
					const why = text(spec.why)
					return el(
						'button',
						{
							className: 'cbv-cardbtn' + (spec.ok === true ? '' : ' cbv-cardbtn--off'),
							key,
							type: 'button',
							disabled: busy || spec.ok !== true,
							'data-member-verb': verb,
							'data-member-name': name,
							'data-member-verb-ok': spec.ok === true ? 'true' : 'false',
							...(why === '' ? {} : { title: why }),
							onClick: () => postMemberVerb(url, name, label),
						},
						label,
					)
				}
				return [
					buttonOf('disable', '停用', 'disable', MEMBERS_DISABLE_ENDPOINT),
					buttonOf('restore', '恢复', 'restore', MEMBERS_RESTORE_ENDPOINT),
					buttonOf('interrupt', '打断', 'interrupt', MEMBERS_INTERRUPT_ENDPOINT),
				].filter((node) => node !== null)
			}

			/**
			 * 一张成员卡：**只读 live 字段**（task-40 起卡上不再有任何来自旧名册文件的东西）。
			 *
			 * 卡上那几格各自的真源：
			 *   · 名字 / 身份（`kind`）/ 描述 / 模型 / 提供者 / 上下文 —— 原生 Agent Teams 名册；
			 *   · 运行时状态 —— 活着的 Agent（`runtime`，读不到就一个徽标都不印）；
			 *   · **已停用** —— 本插件这一层的 `disabled`（工作区文件 `.company-gate.member-flags.json`）；
			 *   · 未读 —— 邮箱文件（`mailbox_unread`）；
			 *   · 头像与色调 —— 引擎按角色给的（`avatar` / `avatarTone`，映射的唯一正文在引擎）。
			 */
			const cardOf = (row, index) => {
				const name = text(row.name)
				const runtime = text(row.runtime)
				const runtimeTone = runtime === 'running' ? 'present' : runtime === 'failed' ? 'warn' : 'ok'
				const unread = typeof row.mailbox_unread === 'number' && row.mailbox_unread > 0 ? row.mailbox_unread : 0
				const disabled = row.disabled === true
				// 头像：`avatar` / `avatarTone` 都由引擎按角色给（未收录的角色也有一个确定的图标与色调，不是空白）。
				// 客户端**不写死 emoji**（写死的那两个 / 就是"成员项图标还是彩色的"那个 bug 的来源）。
				const avatar = text(row.avatar) === '' ? (row.kind === 'lead' ? 'target' : 'user') : text(row.avatar)
				const tone = text(row.avatarTone) === '' ? (row.kind === 'lead' ? 'exec' : 'eng') : text(row.avatarTone)
				const duty = text(row.description)
				const identity = row.kind === 'lead' ? '协调者' : '队友'
				return el(
					'div',
					{
						className: 'cbv-box cbv-mp-card' + (disabled ? ' cbv-mp-card--off' : ''),
						key: row.key === undefined ? 'mem' + index + '#' + name : row.key,
						// 形态与判定落在 `data-` 上（**不挂 title**）：核对的人不必展开 DOM 找文字。
						'data-mem-kind': text(row.kind),
						'data-mem-name': name,
						// 会话 id 就是这位成员的子会话（原来这一格读旧名册里的记录编号 ⇒ 换成真源）
						'data-mem-id': text(row.session),
						'data-mem-runtime': runtime === '' ? 'unknown' : runtime,
						// **已停用**：本插件这一层的真源（`.company-gate.member-flags.json`），不是旧名册里的历史字段
						'data-mem-disabled': disabled ? 'true' : 'false',
						'data-mem-unread': String(unread),
					},
					el(
						'div',
						{ className: 'cbv-mp-top', key: 'top' },
						el('span', { className: 'cbv-mp-avatar cbv-mp-avatar--' + tone, key: 'av' }, avatarIconOf(avatar)),
						el(
							'div',
							{ className: 'cbv-mp-nameblock', key: 'names' },
							// 徽标行**留在名字那一列里**（右移一层）：原来它是 top 那一行的兄弟，
							// 于是贴在卡片左边缘、落在头像底下 —— 与名字不对齐（现场截图看得很清楚）。
							el('div', { className: 'cbv-mp-name', key: 'name' }, name === '' ? '（无名）' : name),
							// 徽标行**在名字那一列里**（身份 → 运行时 → 编制态 → 未读 → 链接读数）：原来它是
							// `.cbv-mp-top` 的兄弟节点，于是贴在卡片左边缘、落在头像底下，与名字不对齐。
							el(
								'div',
								{ className: 'cbv-badges', key: 'badges' },
								el('span', { className: 'cbv-badge' + (row.kind === 'lead' ? ' cbv-badge--present' : ''), key: 'kind' }, identity),
								runtime === '' ? null : el('span', { className: 'cbv-badge cbv-badge--' + runtimeTone, key: 'runtime' }, runtimeWordOf(runtime)),
								// **已停用**：本插件这一层标成停用的那些（live flag；可恢复）
								disabled
									? el(
											'span',
											{
												className: 'cbv-badge cbv-badge--warn',
												key: 'disabled',
												'data-mem-disabled-badge': 'true',
												// 口径与拒绝文案 / 回执 / README 同句：**只在本插件生效**、宿主界面里仍可对话
												title: '本插件不再派活给它（不占角色槽位）；它在宿主原生界面里仍然可以打开对话',
											},
											'已停用',
										)
									: null,
								unread === 0 ? null : el('span', { className: 'cbv-badge cbv-badge--warn', key: 'unread' }, '未读 ' + unread),
							),
							el(
								'div',
								{ className: 'cbv-mp-sub', key: 'sub' },
								// 在册的印"编号 · 角色"；只在团队里的印"会话 id"。
								// 模型 / 提供者 / 上下文**两档都印**（原生给了就有）：`context` 是 `fresh` / `fork`，
								// `fork` 表示它继承了父会话的历史 —— 这一格值得一眼看到，不是装饰。
								'会话 ' + shortSession(row.session) +
									(text(row.model) === '' ? '' : ' · 模型 ' + text(row.model)) +
									(text(row.provider) === '' ? '' : ' · 提供者 ' + text(row.provider)) +
									(text(row.context) === '' ? '' : ' · 上下文 ' + text(row.context)),
							),
						),
						// **启停不在这里**（人的判断 A 方案）：成员是宿主原生的队友，本插件不给它开关。
						// 停用是**本插件这一层**的状态，由上面那枚「已停用」徽标说（真源 `.company-gate.member-flags.json`）；
						// 旧名册里那个 `enabled` 历史字段（只印"记录：已停用"那行）随旧账一起撤掉了。
					),
					el(
						'div',
						{ className: 'cbv-mp-duty', key: 'duty' },
						// 原生那边没给 description 时**照实说谁没给**（协调者那一行本来就没有）；协调者用一句固定身份，
						// 与"面板凭空编一段职责"是两回事 —— 协调者那句是常量，不随数据变。
						duty !== '' ? duty : row.kind === 'lead' ? '拆解 · 派发 · 把关 · 收口' : '（原生没给这一条的 description）',
					),
					// **子会话**：这一位成员的会话 id（live 字段）—— 从前行里还印"最后动笔"，那是旧名册的时间戳，
					// 那份账撤了，这一格也就只剩会话 id 本身（要看它跑不跑，上面那枚运行时徽标就是）。
					el(
						'div',
						{ className: 'cbv-mp-row', key: 'session' },
						el('span', { className: 'cbv-mp-key', key: 'k' }, '子会话 '),
						text(row.session) === '' ? '（原生没给会话 id）' : shortSession(row.session),
					),
					// **动作条**：三个动词由服务端给（`row.verbs`，HD-006）。
					// 「查看 / 复制提示词」那一对随旧名册撤掉了 —— 它们读的是旧名册记录里的 `persona` / `prompt`，
					// 那份账没人写（人机器上 0 行）⇒ 那两个按钮本来就从没出现过；留着一个读不到数据的入口不如没有。
					(() => {
						const actions = [...verbButtonsOf(row, name)]
						// **一个动作都没有就不画这一行**（空的动作条会让人以为"这里本来就没动作"）。
						return actions.length === 0 ? null : el('div', { className: 'cbv-cardbar', key: 'actions' }, ...actions)
					})(),
				)
			}

			/**
			 * 三个对话框共用的外壳：遮罩 + 标题 + 右上角动作区 + 正文。
			 *
			 * 复用详情浮窗那两个类名（`.cbv-overlay` / `.cbv-modal`）：观感与既有的详情窗一致，
			 * 语法上也只是"同一套标记的又一个用处"。**遮罩点一下即关**（与详情窗同一条），
			 * 但写动作的确认框里关闭 = 取消（不写任何东西）。
			 */
			const shellOf = (title, actions, bodyNode, { narrow = false } = {}) =>
				el(
					'div',
					{ className: 'cbv-overlay', key: 'overlay', onClick: () => setDialog(null) },
					el(
						'div',
						{ className: 'cbv-modal cbv-modal--members' + (narrow ? ' cbv-modal--narrow' : ''), onClick: (event) => event.stopPropagation(), role: 'dialog', 'aria-modal': 'true', 'aria-label': title, 'data-members-dialog': title },
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
			/**
			 * 开 / 关团队服务那一层（DSH 的可选 bundle）。
			 *
			 * 调的是 `pluginManager.setBundleEnabled`（与 GUI 那个开关同一个方法），结果是**原样回显**：
			 * 引擎说"启用了"就是启用了，说警告就照印警告。**只由人点按钮触发** —— 不静默改 profile。
			 * @param action - `enable` 或 `disable`。
			 */
			const postTeamService = (action) => {
				if (typeof fetch !== 'function') {
					setSvcNote({ tone: 'error', lines: ['当前环境没有 fetch'] })
					return
				}
				setSvcBusy(true)
				setSvcNote(null)
				fetch(TEAM_SERVICE_ENDPOINT, {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ action }),
				})
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						setSvcBusy(false)
						if (payload !== null && payload.ok === true) {
							const lines = []
							if (payload.bundle !== null && payload.bundle !== undefined && payload.bundle.enabled === true) lines.push('团队服务已启用（' + text(payload.bundle.name) + '）。')
							else if (payload.bundle !== null && payload.bundle !== undefined) lines.push('团队服务已关闭。')
							else lines.push('DSH 那边回了结果，但这一层没出现在可选能力清单里。')
							if (Array.isArray(payload.warnings)) lines.push(...payload.warnings.map((line) => text(line)))
							setSvcNote({ tone: 'ok', lines })
							// 这一层一开，团队名册立刻就该有了 ⇒ 重取一次（宿主的 reload 已经跑完）。
							invalidatePanes()
					invalidatePanes()
				setLocalTick((value) => value + 1)
							return
						}
						const lines = [payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status]
						if (payload !== null && Array.isArray(payload.warnings)) lines.push(...payload.warnings.map((line) => text(line)))
						setSvcNote({ tone: 'error', lines })
					})
					.catch((error) => {
						setSvcBusy(false)
						setSvcNote({ tone: 'error', lines: ['请求失败：' + (error === null || error === undefined ? '未知错误' : String(error.message ?? error))] })
					})
			}

			const postRoster = (url, body, after) => {
				if (typeof fetch !== 'function') {
					setRosterNotice({ tone: 'error', lines: ['当前环境没有 fetch'] })
					return
				}
				setRosterBusy(url)
				setRosterNotice(null)
				// **同一套拼法**（`paneQueryOf`）：宿主拿不到工作区时会**按会话**回落 —— 手拼那一版只带 workspace。
				fetch(url + paneQueryOf(workspace, sessionId), {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				})
					.then((response) => response.json().then((payload) => ({ response, payload }), () => ({ response, payload: null })))
					.then(({ response, payload }) => {
						setRosterBusy(null)
						if (payload !== null && payload.ok === true) {
							setRosterNotice({ tone: 'ok', lines: after(payload) })
							// 写完立刻重取（`localTick` 就是这一块自己的重取计数，与成员那几个动作同一处）。
							invalidatePanes()
					invalidatePanes()
				setLocalTick((value) => value + 1)
							return
						}
						setRosterNotice({ tone: 'error', lines: [payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status] })
					})
					.catch((error) => {
						setRosterBusy(null)
						setRosterNotice({ tone: 'error', lines: ['请求失败：' + (error === null || error === undefined ? '未知错误' : String(error.message ?? error))] })
					})
			}

			/** 恢复上架：一个动作，没有弹窗（不删任何东西，可再来一次）。 */
			const postRosterRestore = (entry) => {
				postRoster(ROLES_RESTORE_ENDPOINT, { role: text(entry.role) }, (payload) => [`已恢复上架：${text(entry.role)}`, ...(Array.isArray(payload.warnings) ? payload.warnings : [])])
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
				const submit = () => {
					if (kind === 'create') {
						postRoster(ROLES_UPDATE_ENDPOINT, { id: draft.id.trim(), title: draft.title.trim(), category: draft.category.trim(), positioning: draft.positioning.trim(), skills: draft.skills.trim(), scope: draft.scope, ...(draft.body.trim() === '' ? {} : { body: draft.body }) }, (payload) =>
							[`已添加角色 ${payload.role}：${payload.file}`, '这条角色定义写在**用户角色根**（你自己的那份，包内不受影响）。', '**工具面立刻可用**：`member_defaults` / `member_spawn` 每次现枚举角色名册（面板这一栏也是现枚举，已经能看到）。', '**只有注入到系统提示里那份「可叫的队友」清单是装载时的快照**，要重启 DSH 才更新 —— 那一条**不影响**能不能叫人。'],
						)
						setRosterDialog(null)
						return
					}
					if (kind === 'edit') {
						postRoster(ROLES_UPDATE_ENDPOINT, { role: text(rosterDialog.entry.role), title: draft.title.trim(), category: draft.category.trim(), positioning: draft.positioning.trim(), skills: draft.skills.trim(), scope: draft.scope, ...(draft.body.trim() === '' ? {} : { body: draft.body.trim() }) }, (payload) => [
							`已改 ${payload.role}：${payload.file}`,
							payload.shadowed === true ? '包内那份是发布面：这次改动落在**用户角色根**的同名文件上（用户根优先，所以从此以你这份为准）。' : '改的是用户根里那一份。',
							'角色定义正文（检查表 / 落点 / 产物形态）一个字没动。',
						])
						setRosterDialog(null)
						return
					}
					postRoster(ROLES_REMOVE_ENDPOINT, { role: text(rosterDialog.entry.role) }, (payload) =>
						payload.mode === 'hide'
							? [`已下架：${payload.role}（本工作区不上货架，可随时恢复）`, '包内那份是发布面，不能从面板上删掉 —— 下架只是"这一栏不列它"。']
							: payload.mode === 'revert'
								? [`已还原为包内那份：${payload.role}`, '删掉的是用户根里那份同名覆盖；包内角色定义还在。']
								: [`已删除：${payload.role}`, `删掉的是用户角色根里这个目录：${payload.file}`],
					)
					setRosterDialog(null)
				}
				return shellOf(
					head,
					[
						el('button', { className: 'cbv-btn', key: 'cancel', type: 'button', disabled: busyNow, onClick: () => setRosterDialog(null) }, '取消'),
						el('button', { className: 'cbv-btn ' + (kind === 'remove' ? 'cbv-btn--bad' : ''), key: 'go', type: 'button', disabled: busyNow, 'data-roster-submit': kind, onClick: submit }, busyNow ? '提交中…' : kind === 'create' ? '添加' : kind === 'edit' ? '保存' : '确认'),
					],
					kind === 'remove'
						? [
								note(text(rosterDialog.entry.removal) === 'hide' ? '**下架**：本工作区不再列它（写进 `.company-gate.roster.json` 的下架名单，可恢复）。包内那份角色定义不动 —— 它是发布面，升级时会被覆盖回来。' : text(rosterDialog.entry.removal) === 'revert' ? '**还原为包内那份**：删掉的是用户角色根里那份**同名覆盖**（你自己改出来的那份），包内的角色定义还在。' : '**真删**：删掉用户角色根里这个目录（`roles/<id>/`）—— 那是你自己加的角色，包内没有同名。'),
								note('**已经在场的成员不受影响**：它们是人，不是角色；角色的增减只影响"还能叫谁"。', 'who'),
							]
						: [
								// 六格**同形**：标签一行、控件一行、说明一行（说明走 `.cbv-mp-field-note` + markdown，
								// 与成员弹窗那两处同一套；`**` 不再被当字面量印出来）。
								kind === 'create'
									? el(
											'div',
											{ className: 'cbv-mp-field', key: 'id' },
											el('div', { className: 'cbv-mp-field-label' }, '角色 id'),
											el('input', { className: 'cbv-input', 'data-roster-field': 'id', value: draft.id, onChange: (event) => setRosterDraft((current) => ({ ...current, id: event.target.value })), placeholder: '例如 data-label' }),
											note('小写 kebab-case —— 就是 `member_spawn role=` 那个值', 'id-note'),
										)
									: null,
								el(
									'div',
									{ className: 'cbv-mp-field', key: 'title' },
									el('div', { className: 'cbv-mp-field-label' }, '显示名'),
									el('input', { className: 'cbv-input', 'data-roster-field': 'title', value: draft.title, onChange: (event) => setRosterDraft((current) => ({ ...current, title: event.target.value })), placeholder: kind === 'edit' ? '（空＝这一格不动）' : '例如 数据标注' }),
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
									note('**项目专属的角色**（只在这个项目里派活）⇒ 本工作区；**跨项目复用**的角色才选全局。同名时工作区那份赢。', 'scope-note'),
								),
								el(
									'div',
									{ className: 'cbv-mp-field', key: 'category' },
									el('div', { className: 'cbv-mp-field-label' }, '分类'),
									el('input', { className: 'cbv-input', 'data-roster-field': 'category', value: draft.category, onChange: (event) => setRosterDraft((current) => ({ ...current, category: event.target.value })), placeholder: kind === 'edit' ? '（空＝这一格不动）' : '例如 数据 / 研发 / 质量' }),
									note('看板上那一枚小字，任意词都行', 'category-note'),
								),
								el(
									'div',
									{ className: 'cbv-mp-field', key: 'skills' },
									el('div', { className: 'cbv-mp-field-label' }, '专属技能（可选，多选）'),
									// **多选**（HD-007）：候选 = 当前能真实载入的技能（载荷 `skillOptions`，会话作用域）
									// ∪ **这个角色已经声明的**（后者若本机没有，仍列出并标「(本机没有)」—— 目录按会话漂移，
									// 静默丢掉就是丢数据）。草稿里仍存**逗号分隔的字符串**：保存走同一个 `patchRoleText`。
									// **多选下拉**（人的追加要求）：收起时**看得出选了哪些**（摘要那一行），点开勾选。
									// 载荷候选 ∪ 已声明（本机此刻没有的仍列出并标「(本机没有)」，不静默丢 —— HD-007）；
									// 键盘可用（toggle 是真 button，勾选框是真 checkbox，Esc 收起）；可一键清空。
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
													skillChoices.length === 0 ? el('span', { className: 'cbv-mp-field-note' }, '这一格现在没有可选项：本进程读不到技能目录（见面板「技能」块那句说明）') : null,
												)
											: null,
									),
									note('这个角色**自己的**作业程序（可多选）。团队规则（`team/BASELINE.md`）是全体共用的，不用写在这里（每个成员都会被告知去读它）；带「(本机没有)」的是**这个角色声明了、但这台机器此刻载入不了的**名字 —— 换一个会话来它可能在。', 'skills-note'),
								),
								el(
									'div',
									{ className: 'cbv-mp-field', key: 'positioning' },
									el('div', { className: 'cbv-mp-field-label' }, '一句话定位'),
									el('textarea', { className: 'cbv-mp-textarea', 'data-roster-field': 'positioning', rows: 2, value: draft.positioning, onChange: (event) => setRosterDraft((current) => ({ ...current, positioning: event.target.value })), placeholder: kind === 'edit' ? '（空＝这一格不动）' : '例如 对标注质量与一致性负责。' }),
									note('"这个角色对什么负责" —— 会写进 front matter 的 `description: Use when …`', 'positioning-note'),
								),
								kind === 'create'
									? el(
											'div',
											{ className: 'cbv-mp-field', key: 'body' },
											el('div', { className: 'cbv-mp-field-label' }, '补充正文（可选）'),
											el('textarea', { className: 'cbv-mp-textarea', 'data-roster-field': 'body', rows: 5, value: draft.body, onChange: (event) => setRosterDraft((current) => ({ ...current, body: event.target.value })), placeholder: '检查表 / 落点 / 产物形态 —— 可以留空，之后直接编辑那个 ROLE.md 也行' }),
											note('成员动手前会读它；留空时这份文件只有身份与定位', 'body-note-text'),
										)
									: note('角色定义正文（检查表 / 落点 / 产物形态）**这一栏改不动** —— 要改去编辑那份 `ROLE.md`（面板只改显示名 / 分类 / 定位 / 技能这四格，正文一个字不碰）。', 'body-note'),
								note('写在哪：**用户角色根** `roles/<id>/ROLE.md`（你自己的那份；包内那份是发布面，升级不会盖掉你改的这份）。', 'where'),
							],
						{ narrow: true }
					)
			}

			// **落空与读失败都给人下一步**：前者清掉筛选（现在只有**一个** facet 状态 + 搜索），
			// 后者当场重读一次（`invalidatePanes()` 清 3 秒缓存，`localTick` 触发本块的取数 effect）。
			const clearFilters = () => {
				setMemberFacet('all')
				setQuery('')
			}
			const retry = () => {
				invalidatePanes()
				setLocalTick((value) => value + 1)
			}

			if (snapshot.phase === 'loading') {
				return el('div', { className: 'cbv-view cbv-mp cbv-mp--pane', 'data-members-phase': 'loading' }, el('div', { className: 'cbv-msg' }, '正在读取本会话的成员与 agent…'))
			}
			// 整块错误态：**只印那一行错误文案 + 一枚「重读」**，不渲染任何卡、任何条、任何数 ——
			// 「名册在而读不成」不等于「名册不存在」，更不等于 0；而"宿主刚起来"这种可恢复的读失败
			// 要在界面上留一个能再试一次的入口（从前恢复动作藏在窗口 focus 事件里）。
			if (snapshot.phase === 'error') {
				return el(
					'div',
					{ className: 'cbv-view cbv-mp cbv-mp--pane', 'data-members-phase': 'error' },
					el('div', { className: 'cbv-msg cbv-msg--error' }, '读不到成员名册：' + snapshot.error),
					el('button', { className: 'cbv-btn', key: 'retry', type: 'button', 'data-pane-retry': 'members', onClick: retry }, '重读'),
				)
			}

			// 筛选行**永远画**：主表里有团队那一份（协调者至少一行），所以不存在"未建立时画出来就是筛完剩 0 张卡"
			// 那个问题 —— 现在的空态只可能是"真的一个 agent 都没有 + 名册也空"。
			const toolbar = el(
				'div',
				{ className: 'cbv-flt-bar', key: 'toolbar' },
				// **一排放完**（task-43，人的口径）：「全部」「协调者」「已停用」「各运行时值」**同级按钮、互斥单选**。
				// 从前是两排（档位一排、运行时一排）各自带一个「全部」，读起来像 bug；现在只有一排、只有一个「全部」。
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
								// 键落在 data 上（核对时不必按文案猜；运行时那几档带 `runtime:` 前缀）
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
					value: query,
					placeholder: '搜索：名字 / 编号 / 角色 / 职责 / 会话 / 模型…',
					'aria-label': '搜索成员',
					onChange: (event) => setQuery(event.target.value),
				}),
				// 这几枚不是一份划分：各档各算各的，「已停用」本身就重叠在「全部」里 ⇒ 说一句，
				// 免得人拿 chip 之和去比「全部 N」（对不上会直接消耗信任）。
				el('span', { className: 'cbv-pane-hint', key: 'stage-hint' }, 'chip 是筛选条件，不是划分（「已停用」的人也在「全部」里）'),
			)

			const nothingAtAll = rows.length === 0
			const body = nothingAtAll
				? el(
						'div',
						{ className: 'cbv-pane-empty', key: 'empty' },
						teamAvailable
							? '本会话的 agent 名册是空的（连协调者都没有 —— 这不正常，重启一下会话看看）。'
							: '读不到本会话的 agent 名册 —— 见上面的告警。',
					)
				: visible.length === 0
					// 筛选/搜索落空 ⇒ 说清"没有匹配的条目"并给一枚「清除筛选」：
					// 什么都不印时，搜错一个名字看起来就像"数据没了"，而且没有任何下一步。
					? el(
							'div',
							{ className: 'cbv-pane-empty cbv-pane-empty--filters', key: 'nofilter' },
							el('span', { key: 'word' }, `没有匹配的条目（本会话共 ${rows.length} 条）。`),
							el('button', { className: 'cbv-btn', key: 'clear', type: 'button', 'data-filters-clear': 'members', onClick: clearFilters }, '清除筛选'),
						)
					: el('div', { className: 'cbv-mp-grid', key: 'grid' }, visible.map((row, index) => cardOf(row, index)))

			// **「角色」目录的块头入口**（锚点）：那一节挂在「成员」卡区下面，块行上看不到它 ⇒
			// 这里给一枚「角色（N）」，点一下滚到那一节。**不升成第四块**：块表 + 钉住块序的自检代价更大。
			const rosterRows = data !== null && data !== undefined && data.defaults !== null && data.defaults !== undefined && Array.isArray(data.defaults.rows) ? data.defaults.rows : []
			const goRoster = () => {
				try {
					if (typeof document === 'undefined' || document === null || typeof document.querySelector !== 'function') return
					const node = document.querySelector('.cbv-roster')
					if (node !== null && node !== undefined && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' })
				} catch {
					/* 拿不到 DOM（非浏览器环境）就算了：这一栏本身仍然照常渲染 */
				}
			}

			return el(
				'div',
				{
					className: 'cbv-view cbv-mp cbv-mp--pane',
					// 形态标记落在 data 上（不挂 title）：核对时在 DOM 里看 `data-members-mark` 即可。
					'data-members-mark': PANE_MARK,
					'data-members-phase': 'ready',
					'data-members-team': teamAvailable ? 'true' : 'false',
					// 「在册 / 未入册」那两档与它们的读数（`established` / `total`，旧名册派生的）随旧账撤掉：
					// 这里只留**原生名册**这一份的读数（行数 / 筛后可见数）。
					'data-members-rows': '' + rows.length,
					'data-members-visible': '' + visible.length,
				},
				el(
					'div',
					{ className: 'cbv-view-head', key: 'head' },
					el('span', { className: 'cbv-view-title', key: 'title' }, '成员'),
					// **成员与角色的关系**（人的指令：一句**简短**的话，说清关系即可，且**要和「成员」同一行**）：
					// 所以这句压到 26 个字 —— 头那一行是 flex + `flex-wrap`，句子一长就会被挤到第二行上去。
					el(
						'span',
						{ className: 'cbv-pane-hint', key: 'hint' },
						'角色是作业程序，成员是戴它干活的人；同一个角色可以叫多个成员。',
					),
					el('span', { className: 'cbv-spacer', key: 'spacer' }),
					rosterRows.length === 0
						? null
						: el('button', { className: 'cbv-cardbtn', key: 'roster-anchor', type: 'button', 'data-roster-anchor': '' + rosterRows.length, onClick: goRoster }, '角色（' + rosterRows.length + '）'),
					// **头那一行只留标题**（人的指令：描述性文字太多）：原来这里还有一长串
					// 「本会话 N 个 agent（协调者 + 队友 M）· 本插件名册：在场 0 · 归档 0 · 退役 0 · 共 0 · 告警线 4」
					// —— 那些数就在下面那条筛选行的 chip 上（全部 / 协调者 / 在册 / 未入册 / 记录已停用），这里是重复。
					// 状态**不对**时（名册未建立 / 读不到 / 有告警）另有 note 与 warn 行如实说，不靠这一行。
				),
				// **整栏只读这一句，只说一次**（人的判断 A 方案）：成员是**宿主原生的队友** —— 本插件
				// 不改、不删、也不启停（那几个动作从前打的是 `/members/update|delete`，host 侧早已直接拒绝）。
				// 要停一个就**不再给它派活**；要打断它**当前那一轮**用内置的 `interrupt_agent`。
				// 这一句放在头下面（不是在每张卡上重复）：一整栏只有一处操作边界。
				// **计数行**（`在场 N（已停用 M）/ 上限 24`）：数与上限都由服务端给 —— 上限是两条规则推出来的
				// 那个数（同角色 3 位 × 8 个角色）且与宿主 `maxMembers` 同值。**单独一行**（标题那一行有长度上限）。
				memberCountsText(data) === ''
					? null
					: el('div', { className: 'cbv-pane-note', key: 'counts', 'data-members-counts': memberCountsText(data) }, memberCountsText(data)),
				el(
					'div',
					{ className: 'cbv-pane-note cbv-md', key: 'ro-note', 'data-members-ro': 'true' },
					markdownNodes(
						'成员是宿主原生的队友：本插件**不改它的记录、也不删它**（原生名册没有这几种动作）。卡上那三个动词是**本插件这一层**的：' +
							'**停用**（**本插件不再派活给它**、不占角色槽位，随时可恢复）、**恢复**、**打断**（只断当前那一轮，收件箱保留、两条上限都不变；' +
							'同一件事也可以用内置的 `interrupt_agent`）。**「停用」只在本插件的调度层生效 —— 被停用的人在宿主原生界面里仍然可以打开对话**（宿主没有移除 / 停用成员的接口）；同一档**至少留 1 位**未停用。',
						'members-ro',
					),
				),
				// 引擎那几行带 markdown 标记（它自己写的就是那个口径）⇒ 走渲染，标记不上屏。
				warnings.map((line, index) => el('div', { className: 'cbv-pane-warn cbv-md', key: 'warn' + index }, markdownNodes(line, 'members-warn' + index))),
				// 团队服务**不在**时给一个显式动作（人的问题："装上插件不能自动打开团队服务吗？"）：
				// 技术上能（DSH 那个可选能力层有开关，GUI 调的是同一个方法），但**不静默改你的 profile** ——
				// 这里就是一个按钮，点了才动，结果原样回显；不想点就去 DSH 的能力设置里开，等价。
				!teamAvailable
					? el(
							'div',
							{ className: 'cbv-acts', key: 'team-service' },
							el(
								'button',
								{
									className: 'cbv-btn cbv-btn--primary',
									key: 'svc-enable',
									type: 'button',
									disabled: svcBusy,
									'data-team-service': 'enable',
									onClick: () => postTeamService('enable'),
								},
								svcBusy ? '正在打开…' : '启用团队服务',
							),
							// 一句说清"这一层是什么、开关在哪、可逆"（人的原话：这句话得让人敢点）。
							el('span', { className: 'cbv-pane-hint', key: 'svc-hint' }, 'DSH 自带的可选能力层，就是 GUI"插件 / 能力"里那个开关，随时可关回来'),
							svcNote === null
								? null
								: el(
										'div',
										{ className: 'cbv-notice cbv-notice--' + (svcNote.tone === 'ok' ? 'ok' : 'error'), key: 'svc-note' },
										...svcNote.lines.map((line, index) => el('div', { key: 'l' + index }, line)),
									),
						)
					: null,
				// **不再印"名册 <文件路径>"那一行**（task-40）：那说的是旧名册文件，面板已经不读它了。
				toolbar,
				// **一个滚动区装全部内容**：成员卡 + 下半那节「角色」+ 截断说明一起滚。
				// 之前是"卡区自己滚、清单挂在它下面" —— 清单就被挤到可视区外面（页面又不滚），
				// 于是那 20 张卡点不到也滚不到（现场：卡片不能滚动）。
				el(
					'div',
					{ className: 'cbv-scroll', key: 'scroll' },
					body,
					rosterSectionOf(data, {
						openRosterDialog: (next) => {
							setRosterNotice(null)
							setRosterDialog(next)
							// 每次开窗都**重置草稿**（免得上一次的输入留在格子里）。**编辑时四格都带现值** ——
							// 人报过："修改角色"里四个输入框全空、只看得到"留空＝不改" ⇒ 看不到现值等于不能用。
							// **保存语义（按实现，一处写准）**：显示名 / 分类 / 一句话定位 **空 = 这一格不动**
							// （引擎 `patchRoleText` 只在给了非空值时改那一格）；**专属技能 空 = 清掉 `skills:` 那一行**
							// （"这个角色没有专属技能"是个真实状态，所以它允许清空）。
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
								skills:
									entry === null || !Array.isArray(entry.skills)
										? ''
										: entry.skills.join(', '),
							})
						},
						restoreRole: postRosterRestore,
						setRosterOriginFacet,
						rosterOriginFacet,
					}),
					// 载荷有条数上限（宿主那侧）：**截断要说出来**，不能让人以为名册就这么长。
				),
				// 回执那一行（**成员这一栏已经不写任何东西**了）：现在只有「复制提示词」的成功/失败与
				// 团队服务开关的结果会走到这里；下一次动作覆盖它。
				notice === null
					? null
					: el(
							'div',
							{ className: 'cbv-notice cbv-notice--' + notice.tone, key: 'notice', 'data-members-notice': notice.tone },
							notice.lines.map((line, index) => el('div', { className: 'cbv-md', key: 'l' + index }, markdownNodes(line, 'members-notice' + index))),
						),
				// 角色那一节的写动作回执（与成员那份分开显示：两块的失败原因不是一回事）。
				// **这几行的来源串本身就带 `**` 与反引号**（引擎说辞的原文）⇒ 整批走渲染，不再逐行直出。
				rosterNotice === null
					? null
					: el(
							'div',
							{ className: 'cbv-notice cbv-notice--' + rosterNotice.tone, key: 'roster-notice', 'data-roster-notice': rosterNotice.tone },
							rosterNotice.lines.map((line, index) => el('div', { className: 'cbv-md', key: 'rl' + index }, markdownNodes(line, 'roster-notice' + index))),
						),
				rosterDialog === null ? null : rosterDialogOf(),
			)
		}


		/**
		 * 「技能」块：**当前这套系统带着哪些作业程序**（宿主的技能目录）。
		 *
		 * 与「成员」块是两件事，别混：成员是**人**（戴着角色上场），技能是**可复用的作业程序**；
		 * 角色在自己的 `skills:` 里引用技能（见 §七的"两层"）。这一块列的清单来自**宿主的技能
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
		// ── ⑬ 技能块 ─────────────────────────────────────────────────────
		function SkillsView(props) {
			const store = props.sessions === undefined ? null : typeof props.sessions === 'function' ? props.sessions() : props.sessions
			const workspace = useCurrentWorkspace(store)
			// **会话 id 也要带上**：技能目录是**按会话的层**解析的（同一个根，不同预设看到不同目录），
			// 不带它宿主只能读全局层 —— 那就与模型看到的那份不是同一份了（见主机那侧 `skillScopeOf`）。
			const sessionId = useCurrentSessionId(store)
			const target = skillsUrlOf(workspace, sessionId)
			const [snapshot, setSnapshot] = React.useState({ phase: 'loading' })
			const [localTick, setLocalTick] = React.useState(0)
			// 三个写动作（导入 / 新建 / 删除）共用一只浮窗：`{ mode, root, source, name, description, body, busy, error }`。
			const [writer, setWriter] = React.useState(null)
			// 写技能的**缺省档**：载荷说 `targetDefault` 是哪一档就用哪一档（缺省 project）。
			const [stage, setStage] = React.useState('all')
			const [sourceFacet, setSourceFacet] = React.useState('all')
			const [query, setQuery] = React.useState('')
			// 查看正文浮窗：`{ skill, definition }` 或 null；`definition` 单独取（清单里没有正文）。
			const [viewer, setViewer] = React.useState(null)
			const [busy, setBusy] = React.useState(null)
			const [notice, setNotice] = React.useState(null)

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
			}, [props.reload, localTick, target])

			/** 取一个技能的正文（宿主按 name 现读**当前**那一份，不缓存 —— 正文改过就拿到新的）。 */
			const loadDefinition = async (name) => {
				if (typeof fetch !== 'function') return null
				// 正文与清单必须**同一个视图层**：所以同样带上 session（少了它可能读到另一个层的那一条）。
				const url = SKILL_DEFINITION_ENDPOINT + '?name=' + encodeURIComponent(name) + paneQueryOf(workspace, sessionId)
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
					setNotice({ tone: 'error', lines: [`技能 ${skill.name} 的清单条目里没有指令文件路径（来源「${text(skill.source)}」没有提供）—— 这不是"路径是空的"。`] })
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
			const stageSpec = SKILL_STAGES.find((spec) => spec.key === stage) ?? SKILL_STAGES[0]
			const stageCount = (spec) => skills.filter((skill) => spec.match(skill)).length
			const needle = query.trim().toLowerCase()
			const visible = skills.filter(
				(skill) =>
					stageSpec.match(skill) &&
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
				const modelInvocable = skill.modelInvocable === true
				const userInvocable = skill.userInvocable === true
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
						'data-skill-level-label': text(skill.levelLabel),
						'data-skill-provider': text(skill.provider),
						'data-skill-model': modelInvocable ? 'true' : 'false',
						'data-skill-user': userInvocable ? 'true' : 'false',
					},
					el('div', { className: 'cbv-sk-name', key: 'name' }, name === '' ? '（无名）' : name),
					// **可调用面在前**（这是"能不能用它、谁能用"的关键），来源与提供者退成一行小字 ——
					// 四个徽标挤两行会把卡片撑高（现场那张截图就是这样），而来源不是每眼都要看的东西。
					el(
						'div',
						{ className: 'cbv-badges', key: 'badges' },
						modelInvocable ? el('span', { className: 'cbv-badge cbv-badge--ok', key: 'model' }, '模型可调用') : null,
						userInvocable ? el('span', { className: 'cbv-badge cbv-badge--present', key: 'user' }, '人可调用') : null,
						// 两面都没开（`disable-model-invocation` + `user-invocable: false`）：**照实说**
						// —— 这种技能在目录里、但两个面都不发布，不说的话看起来像"面板坏了"。
						modelInvocable || userInvocable ? null : el('span', { className: 'cbv-badge cbv-badge--warn', key: 'both' }, '两个面都没开'),
					),
					el(
						'div',
						{ className: 'cbv-sk-sub', key: 'origin' },
						// **层级在前**（`levelLabel` 来自载荷）；原始 source 只作旁注（读的人要查时用得上）
						(text(skill.levelLabel) === '' ? '' : text(skill.levelLabel) + ' · ') + '来源 ' + sourceWordOf(skill.source) + (text(skill.provider) === '' ? '' : ' · 提供者 ' + text(skill.provider)),
					),
					el('div', { className: 'cbv-sk-desc', key: 'desc' }, text(skill.description) === '' ? '（宿主没给这一条的 description）' : text(skill.description)),
					text(skill.whenToUse) === '' ? null : el('div', { className: 'cbv-sk-when', key: 'when' }, '什么时候用它：' + text(skill.whenToUse)),
					el('div', { className: 'cbv-sk-path', key: 'path' }, text(skill.path) === '' ? '（清单里没有指令文件路径）' : text(skill.path)),
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
						? `这批有 ${result.files.length} 个文件（上限 ${SKILL_IMPORT_MAX_FILES}）—— 技能是作业程序，不该这么大。`
						: bytes > SKILL_IMPORT_MAX_BYTES
							? `这批约 ${(bytes / 1024 / 1024).toFixed(1)} MB（上限 ${SKILL_IMPORT_MAX_BYTES / 1024 / 1024} MB）—— 只把技能要用的那几个文件拖进来。`
							: summary.hasSkill
								? ''
								: '这批里没有 SKILL.md —— 一份技能是一个含 SKILL.md 的文件夹（或那个文件本身）。'
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
					setWriter((current) => (current === null ? current : { ...current, error: '这个环境不给开文件选择框：把文件夹直接拖进上面那个区域。' }))
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
					setWriter({ ...writer, error: '还没收到文件：把技能文件夹（或 SKILL.md）拖进上面那个区域，或点「选择文件夹 / 选择文件」。' })
					return
				}
				if (writer.mode === 'import' && writer.error !== '') return
				const body =
					writer.mode === 'import'
						? { root: writer.root, name: writer.name, files: writer.files }
						: writer.mode === 'create'
							? { root: writer.root, name: writer.name, description: writer.description, body: writer.body }
							: { root: writer.root, name: writer.name }
				setWriter({ ...writer, busy: true, error: '' })
				try {
					const response = await fetch(endpoint + paneQueryOf(workspace, sessionId), {
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
					const word = writer.mode === 'import' ? '已导入' : writer.mode === 'create' ? '已新建' : '已删除'
					// **删技能时同步剪角色那一行**（HD-007）：回执里的 `skillPrune.note` **原样印出来** ——
					// 它逐字说清"改了哪几个用户根角色、还有哪几个包内角色仍声明它"（面板不复述、也不总结成"已同步"）。
					const pruneLines =
						payload.skillPrune !== null && payload.skillPrune !== undefined && text(payload.skillPrune.note) !== ''
							? [`专属技能同步：${text(payload.skillPrune.note)}`]
							: []
					setNotice({
						tone: 'ok',
						lines: [`${word}技能 \`${text(payload.id)}\`：${text(payload.path)}`, '新会话/下一次读目录时才看得到它（技能目录是按会话解析的）。', ...pruneLines],
					})
					setWriter(null)
					invalidatePanes()
					invalidatePanes()
				setLocalTick((value) => value + 1)
				} catch (error) {
					// `Failed to fetch` 这一类是连接层面的失败（宿主没回话）。把可能的原因写出来 ——
					// 但正常路径下不该走到这儿：体量在收集那一步就自检过了，宿主也会回一个能读的 413。
					const raw = String(error)
					setWriter({
						...writer,
						busy: false,
						error: /failed to fetch/i.test(raw)
							? '没能连上宿主（连接被中断）。多半是这一批太大 —— 只把技能要用的文件拖进来再试；若仍失败，重启一次 DSH。'
							: raw,
					})
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
						? el('div', { className: 'cbv-mp-field-note', key: 'no-targets' }, '这一格的可选项读不到（技能目录没读到）：写之前先让「技能」块读出目录。')
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
											'data-skill-drop': writer.files.length === 0 ? 'empty' : 'ready',
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
									{ className: 'cbv-btn', key: 'ok', type: 'button', disabled: writer.busy === true, onClick: () => void submitWriter() },
									writer.busy === true ? '正在提交…' : '确定',
								),
							),
						),
						el(
							'div',
							{ className: 'cbv-modal-body', key: 'body' },
							writer.mode === 'import'
								? el('div', { className: 'cbv-mp-field-note cbv-md', key: 'tip' }, markdownNodes('只认**可写的两类根**（用户级 / 项目级）；随包发布的技能与别的 agent 的根只读。目标已存在一律拒绝（只增不改）。', 'tip'))
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
						{ className: 'cbv-modal cbv-modal--skills', onClick: (event) => event.stopPropagation(), role: 'dialog', 'aria-modal': 'true', 'aria-label': viewer.skill.name + ' 技能正文', 'data-skill-dialog': viewer.skill.name },
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
								? el('div', { className: 'cbv-pane-warn cbv-md', key: 'trunc' }, markdownNodes('这份正文超长：上面那段是**截断后**的，复制走的也是这一段。完整原文请直接打开那个路径。', 'trunc'))
								: null,
							el('pre', { className: 'cbv-block cbv-pre', key: 'text' }, content === '' ? '（这份技能的文件里没有正文）' : content),
						),
					),
				)
			}

			// **落空与读失败都给人下一步**：前者清掉筛选（阶段 / 级别 / 搜索三个状态一起清），后者当场重读一次。
			// 重读就走本块自己的取数计数（`invalidatePanes()` 把 3 秒缓存清掉，`localTick` 触发 effect）。
			const clearFilters = () => {
				setStage('all')
				setSourceFacet('all')
				setQuery('')
			}
			const retry = () => {
				invalidatePanes()
				setLocalTick((value) => value + 1)
			}

			if (snapshot.phase === 'loading') {
				return el('div', { className: 'cbv-view cbv-sk', 'data-skills-phase': 'loading' }, el('div', { className: 'cbv-msg' }, '正在读取技能目录…'))
			}
			// 整块错误态：只印那一行原文 —— 「技能注册表读不到」不等于「一个技能都没有」；
			// 加一枚「重读」：宿主刚起来时读不到，界面上要有一个能再试一次的入口。
			if (snapshot.phase === 'error') {
				return el(
					'div',
					{ className: 'cbv-view cbv-sk', 'data-skills-phase': 'error' },
					el('div', { className: 'cbv-msg cbv-msg--error' }, '读不到技能目录：' + snapshot.error),
					el('button', { className: 'cbv-btn', key: 'retry', type: 'button', 'data-pane-retry': 'skills', onClick: retry }, '重读'),
				)
			}

			const toolbar = el(
				'div',
				{ className: 'cbv-flt-bar', key: 'toolbar' },
				// **阶段筛选：下拉**（人的口径：除成员页外都退回下拉）。它与右边那格**级别**是**两个独立
				// 下拉** ⇒ "阶段 ∧ 级别"的**叠加**语义保持不变（技能这边本来就是叠加，不是互斥视图）。
				el(
					'select',
					{
						className: 'cbv-select cbv-flt-select',
						key: 'stage',
						'data-skill-stage-facet': '',
						'aria-label': '按阶段筛选',
						value: stageSpec.key,
						onChange: (event) => setStage(event.target.value),
					},
					SKILL_STAGES.map((spec) => el('option', { value: spec.key, key: spec.key, 'data-skill-stage-option': spec.key }, `${spec.label}（${stageCount(spec)}）`)),
				),
				// **级别筛：下拉**（task-43 退回 task-42 之前那一版 —— 人原话：「没让你改技能中的下拉」；
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
					value: query,
					placeholder: '搜索：名称 / 描述 / 什么时候用它 / 路径 / 来源…',
					'aria-label': '搜索技能',
					onChange: (event) => setQuery(event.target.value),
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
						? el('div', { className: 'cbv-scroll', key: 'scroll' }, el('div', { className: 'cbv-pane-empty', key: 'empty' }, '技能目录里一个技能都没有 —— 这不是"读不到"：宿主注册表答了，只是它扫过的那些根下没有可用的技能。'))
						: el(
								'div',
								{ className: 'cbv-scroll', key: 'scroll' },
								el('div', { className: 'cbv-pane-empty cbv-md', key: 'empty' }, markdownNodes(`这次**没读到会话层的技能目录**（按「${layer}」读的，原因见上面的告警）—— 所以这里空着**不等于**"一个技能都没有"。`, 'degraded')),
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

			return el(
				'div',
				{
					className: 'cbv-view cbv-sk',
					// 形态标记落在 data 上（不挂 title）：核对时在 DOM 里看 `data-skills-mark` 即可。
					'data-skills-mark': SKILLS_MARK,
					'data-skills-phase': 'ready',
					'data-skills-layer': layer,
					'data-skills-total': '' + skills.length,
					'data-skills-visible': '' + visible.length,
				},
				el(
					'div',
					{ className: 'cbv-view-head', key: 'head' },
					el('span', { className: 'cbv-view-title', key: 'title' }, '技能'),
					// **这一句要与实现同义**：头一句写着"只读"而同一屏摆着三个写动作，是虚假的安全提示
					//（清单与正文只读；写动作写的是宿主的技能根，只对用户级 / 项目级可写 —— 判据 `WRITABLE_SKILL_SOURCES`）。
					el('span', { className: 'cbv-pane-hint', key: 'hint' }, '清单来自宿主的技能注册表（与模型侧那个技能源是同一份目录）；清单与正文只读 —— 导入 / 新建 / 删除写的是宿主的技能根，只对用户级 / 项目级可写'),
				),
				// 宿主自己那几行（工作区回落说明、扫描未完成的说明…）：原文透出，不换措辞。
				// 宿主那几句里带 `**` / 反引号（它写的就是 markdown）⇒ 走渲染，标记不上屏。
				warnings.map((line, index) => el('div', { className: 'cbv-pane-warn cbv-md', key: 'warn' + index }, markdownNodes(line, 'skills-warn' + index))),
				// 退层时在头上再点一次名（告警在下面，可能在视口外）：这一句只说"读的是哪一层"，
				// "为什么"仍然只有宿主那一行正文。
				layer === 'session' ? null : el('div', { className: 'cbv-pane-warn', key: 'layer' }, `本次技能清单读的是「${layer}」层 —— 不是你会话那一层，见下面的告警。`),
				// 项目级技能根**跟工作区走**：只在**状态不对**（有告警）时把这次解析用的工作区印出来
				// （正常时它是噪音；每张技能卡上已经印着它自己的来源与路径）。取不到时说清是按进程目录算的，
				// 那句在 `warnings` 里由宿主给出原文 —— 这里不另写一套措辞）。
				text(data.workspace) === ''
					? null
					: el('div', { className: 'cbv-pane-meta', key: 'meta' }, '项目级技能根按这个工作区解析：' + text(data.workspace)),
				toolbar,
				body,
				notice === null
					? null
					: el(
							'div',
							{ className: 'cbv-notice cbv-notice--' + notice.tone, key: 'notice', 'data-skills-notice': notice.tone },
							notice.lines.map((line, index) => el('div', { className: 'cbv-md', key: 'l' + index }, markdownNodes(line, 'skills-notice' + index))),
						),
				viewer === null ? null : viewerOverlay(),
				writer === null ? null : writerOverlay(),
			)
		}

		/** 一个视图 = 一份文件：同一套取数、筛选、分栏，只换卡片与界面约径。 */
		// ── ⑭ 任务看板块 ───────────────────────────────────────────────────
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

			// **这里不再有"栏头"那条分支**（`.cbv-head` + `.cbv-meta` + `metaParts` 整段删了）：
			// 本包只有"面板内嵌"这一种用法（两个调用点都传 `showHeader:false`），那条分支从来不会渲染 ——
			// 半死的代码会让人以后照着它改（"这里怎么没有栏头"）。块的读数只有一个落点：`.cbv-view-head` 那一行。
			// 内嵌时（`showHeader === false`）用 `--embed` 修饰类，并且**不挂面板标记**：
			// 面板标记是给"整栏"用的（拖拽条那条 CSS 与量高都以它为准），内嵌的一份挂上会打架。
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
					// 合成同一条 —— 三块都只有"一条筛选行"，不再有一块是另画的输入行。
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
		// ── ⑮ 装配与导出 ───────────────────────────────────────────────────
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
		 * 一栏三块（块序见 `BLOCKS`）：**成员 / 技能 / 任务看板**。
		 * 打开面板就是"现在到哪了"那一屏（三行状态 + 块切换 + 工作区），
		 * 五块共用同一份取数纪律：每条读数都来自引擎或宿主的**同一处判定**，本文件不另算一套。
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

			// 会话清单 store：用来把视图栏跟到「当前会话所在的工作区」。
			// `sessions` 在 inject 里点名 ⇒ cordis 等它就绪才跑 apply（一次性 `ctx.get`
			// 不等待，早一步就永远取不到 —— 三栏会一直停在配置值上）。
			// 这里仍按调用现取，并在视图里每次渲染重新调一次，作为兜底。
			const sessionsOf = () => sessionsListStore()

			// **一栏**（不是三栏）：打开就是"现在到哪了"那一屏 —— 三行状态 + 五个块。
			// 三块各自成组件（成员 / 技能 / 任务看板），在这一栏里按块切换（见本文件 StatusView）。
			ctx.slots.inject('conversation.view', () => {
				const dispose = ctx.slots.register(
					{ name: 'conversation.view', id: 'company-status', order: 20, label: '团队状态' },
					() => el(StatusView, { sessions: sessionsOf, slots: ctx.slots }),
				)
				return () => {
					if (typeof dispose === 'function') dispose()
				}
			})

			// ①′ **角色进本体的 `@` 菜单 + 热词典**（人的现场：「我输入 @ 根本看不到任何团队内的角色」）：
			// 与 `@michengai/dsh-agency-agents` 把「专家」放进菜单是同一条路（`inputTriggers.registerSource`）。
			// 这一条要在席位之外单独挂，并且随插件一起注销。
			const disposeRoleSource = registerRoleTriggerSource(ctx, ctx.sessions)
			if (typeof ctx.effect === 'function') {
				ctx.effect(() => () => disposeRoleSource(), 'team-ops: @ 菜单里的角色')
			}

			// **第二处席位**：输入框工具行左侧那一枚 **`角色`** 按钮（人的指令：「我的意思是在输入框添加一个
			// 「角色」按钮」）—— 选一个角色 + 在输入框写这件活 ⇒ 让那个角色去干。
			// 挂的是本体的 `conversation.input.left`（`kind: list`、`replaceRisk: none`、现场 occupants 为空
			// —— "composer 工具行左侧的紧凑控件"就是给这个用的），入口拿得到标准的 `useInput`（草稿）
			// 与 `inputActions`（`setDraft` / `submit`）。
			// 老版本宿主没有这个槽 ⇒ 静默跳过（只记一条 warn），不影响视图栏那一席。
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

		}

		exports.apply = apply
		// 硬依赖声明：cordis 的 Guard 拒绝未声明的服务属性访问；`sessions` 还必须在这里点名，
		// 否则 apply 可能早于它就绪，一次性取值会永远拿不到当前会话（见 apply 里的说明）。
		exports.inject = ['slots', 'sessions']
		return exports
	},
})
