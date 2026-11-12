/**
 * 技能块的 HTTP 端点族：清单 / 正文 / 注册表失效 / 三个写动作。
 *
 * 与 `lib/role-pack-routes.js` 同一形状：宿主注入工作区解析（`openWorkspaceOf` /
 * `openWorkspaceSoftly`），其余依赖都是可 import 的纯模块；业务判定与落盘全在
 * `lib/skill-write.js`，作用域判定在 `lib/skill-scope.js`，宿主不另写一份。
 */
import { join } from 'node:path'
import { bodyError, messageOf, queryValue, readBody, writeJson } from './http-tools.js'
import { asScalar } from './panel-shaping.js'
import { skillScopeOf, skillViewOptions } from './skill-scope.js'
import { createSkill, importSkill, importSkillFiles, removeSkill, skillRootLabel } from './skill-write.js'
import { pruneSkillFromRoles } from '../team/team-runtime.js'

/** 单次回传的技能条数上限（超了要在载荷里说明"截断了"）。 */
const SKILL_ROWS_LIMIT = 400
/** 技能正文回传上限：超过就截断并**明说截断**。 */
const SKILL_CONTENT_LIMIT = 256 * 1024
/** 导入请求体上限：base64 会膨胀，比 `lib/skill-write.js` 的 4 MB 文件上限留足余量。 */
const SKILL_IMPORT_BODY_LIMIT = 8 * 1024 * 1024

/**
 * @param deps - `{ openWorkspaceOf, openWorkspaceSoftly }`（宿主的工作区解析）。
 * @returns `{ handleSkills, handleSkillDefinition, invalidateSkillCatalog, handleSkillWrite }`。
 */
export function createSkillRoutes(injected) {
	const deps = injected
	/** 这一批被剪掉的角色来自哪个根（全同就点名那个根；两个根都有就说"非包内"）。 */
	function pruneRootLabelOf(changed) {
		const sources = [...new Set((Array.isArray(changed) ? changed : []).map((item) => item.source))]
		if (sources.length === 1 && sources[0] === 'workspace') return '**本工作区根**'
		if (sources.length === 1 && sources[0] === 'user') return '**用户根**'
		return '**非包内**'
	}

	/**
	 * 「技能」块的两条只读端点：清单（`/skills`）与某一条的正文（`/skills/definition`）。
	 *
	 * 口径三条：
	 *   · **不自己扫盘**：技能从哪些根来、同名怎么裁决，全是宿主技能注册表（`ctx.skills`）的事，
	 *     本文件只把它的答案整形回传 —— 于是"面板列着的"与"模型能加载的"必然同源。
	 *   · **服务不在 = 读不到**（503 + 点名该装哪个包），**不是**"一个技能都没有"：
	 *     面板据此只印那一行错误，而不是画一个空目录。
	 *   · 项目级技能根**跟工作区走**（`cwd`）：工作区取不到时不硬失败，但要在载荷里说清
	 *     "这次是按宿主进程目录解析的"，免得把别人的项目技能看成本会话的。
	 * @param ctx - 宿主 ctx（`ctx.get('skills')` 是可选服务：不在 inject 里点名）。
	 * @param req - 请求（GET）。
	 * @param res - 响应。
	 * @param fallback - composition 行配的 workspace。
	 */
	async function handleSkills(ctx, req, res, fallback) {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			writeJson(res, 405, { ok: false, error: '技能目录只支持 GET（本栏只读）' })
			return
		}
		const service = skillsServiceOf(ctx)
		if (service === null) {
			writeJson(res, 503, { ok: false, error: SKILLS_SERVICE_MISSING })
			return
		}
		const opened = await deps.openWorkspaceSoftly(ctx, req, res, fallback)
		if (opened === null) return
		const resolved = opened.resolved
		const root = opened.root
		const warnings = opened.warnings
		if (root === null) {
			warnings.push('工作区取不到：本次技能清单按**宿主进程目录**解析项目级技能根（`.dsh/skills` / `.agents/skills`），可能不是你会话的工作区；用户级技能根不受影响。')
		}
		// **读哪一层**：技能目录是 host + 按作用域分层的 —— 本部署里本地技能由**预设那一层**提供
		// （web-app 把宿主那行 `skill-filesystem` 关了），所以要看会话那一层才与模型看到的一致。
		const view = skillScopeOf(ctx, queryValue(req.url, 'session'))
		if (view.layer !== 'session') warnings.push(view.why + '（技能目录是**按会话的作用域**解析的：退层读到的那份可能与你会话里模型看到的不同源。）')
		try {
			const snapshot = await service.snapshot(skillViewOptions(root, view))
			const raw = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.skills) ? snapshot.skills : []
			const rows = []
			for (let i = 0; i < raw.length && rows.length < SKILL_ROWS_LIMIT; i++) {
				const shaped = shapeSkillSummary(raw[i])
				if (shaped !== null) rows.push(shaped)
			}
			// 截断要说出来：不能让人以为目录就这么长。
			if (raw.length > rows.length) warnings.push(`技能目录里共 ${raw.length} 条，这里只回了前 ${rows.length} 条（回传上限 ${SKILL_ROWS_LIMIT}）。`)
			writeJson(res, 200, {
				ok: true,
				workspace: root,
				workspaceSource: resolved.source,
				// **这份清单是从哪一层读到的**：`session` = 与模型同一份；`root-agent` / `global` = 退层读的
				// （面板据此决定空态那句话怎么说 —— 退层空着**不许**说成"一个技能都没有"）。
				layer: view.layer,
				// **本轮扫描是否完成**（宿主注册表自己的 `complete`）：没完成就说"可能还有"，
				// 不把一次没扫完的目录当成最终答案。
				complete: snapshot !== null && typeof snapshot === 'object' && snapshot.complete === true,
				total: raw.length,
				skills: rows,
				// **筛档**：**三个根恒显**（项目级 → 用户级 → 包内，空档也列、`count` 写 0），`other` **只在非空时**出现
				// —— `other` 不是"根"，它是"读到的东西落不进这三个根"那一档，空着就不该占一格。
				//
				// **为什么空档也要列**：① **项目级正是 `skill_define` 缺省写入的位置**，藏起来人就没法从界面上回答
				// "我新建的技能会落到哪"；② 同一页的「角色来源」筛一直是三档恒显（含空档）⇒ 两处口径必须一致；
				// ③ 「全部 (N)」与可见档位的关系要**一眼可核**（空档被藏起来会让人以为"没有项目级这回事"）。
				facets: ['project', 'user', 'package', 'other']
					.map((key) => ({ key, label: SKILL_LEVEL_LABEL[key], count: rows.filter((row) => row.level === key).length }))
					.filter((facet) => facet.key !== 'other' || facet.count > 0),
				// **写哪一级**（新建 / 导入那只浮窗照这份画，缺省 `project`）：标签与路径都从这一处出。
				targets: [
					// 工作区取不到时**不编路径**：给一个如实占位（面板照印；真写的时候那条会自己拒）。
					{ key: 'project', label: '项目级', path: root === null ? '<工作区>/.dsh/skills' : join(root, '.dsh', 'skills'), note: '只这个工作区（**缺省**）' },
					{ key: 'user', label: '用户级', path: skillRootLabel('user'), note: '**跨项目**：所有工作区都看得见（要显式选）' },
				],
				targetDefault: 'project',
				warnings,
			})
		} catch (error) {
			// 注册表自己抛错与"服务不在"分开报：前者是它读不成，后者是这个部署没装。
			writeJson(res, 503, { ok: false, error: '技能目录读不成：' + messageOf(error) })
		}
	}

	/**
	 * 一条技能的**正文**（只读）：按名字现读当前那一份。
	 *
	 * 「现读」是有意的：技能正文改一个字，下一次打开浮窗就该看到新的 —— 面板不缓存正文，
	 * 也不拿清单里的 description 冒充正文。超长会截断，并在 `truncated` 与 `warnings` 里**明说**。
	 * @param ctx - 宿主 ctx。
	 * @param req - 请求（GET，`?name=` 必填）。
	 * @param res - 响应。
	 * @param fallback - composition 行配的 workspace。
	 */
	async function handleSkillDefinition(ctx, req, res, fallback) {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			writeJson(res, 405, { ok: false, error: '技能正文只支持 GET（本栏只读）' })
			return
		}
		const service = skillsServiceOf(ctx)
		if (service === null) {
			writeJson(res, 503, { ok: false, error: SKILLS_SERVICE_MISSING })
			return
		}
		const name = queryValue(req.url, 'name')
		if (name === '') {
			writeJson(res, 400, { ok: false, error: 'name 必填（技能名，形如 `code-review`）' })
			return
		}
		const opened = await deps.openWorkspaceSoftly(ctx, req, res, fallback)
		if (opened === null) return
		const resolved = opened.resolved
		const root = opened.root
		const warnings = opened.warnings
		if (root === null) {
			warnings.push('工作区取不到：本次按**宿主进程目录**解析项目级技能根，可能不是你会话里的那份技能。')
		}
		// 正文与清单必须落在**同一个视图层**上（否则可能读到另一个同名技能的那一份）。
		const view = skillScopeOf(ctx, queryValue(req.url, 'session'))
		if (view.layer !== 'session') warnings.push(view.why + '（正文是按这一层解析到的；与清单用同一个查询串即可保证两边同一层。）')
		try {
			const definition = await service.get(name, skillViewOptions(root, view))
			if (definition === undefined || definition === null) {
				writeJson(res, 404, { ok: false, error: `技能目录里没有 ${name}：它没被发现（名字拼错？它所在的那个根没被扫到？）。可用名字见技能清单。` })
				return
			}
			const content = typeof definition.content === 'string' ? definition.content : ''
			const truncated = content.length > SKILL_CONTENT_LIMIT
			if (truncated) warnings.push(`这份技能正文共 ${content.length} 字，超过回传上限 ${SKILL_CONTENT_LIMIT}，已截断 —— 完整原文请直接打开那个路径。`)
			const invocation = definition.invocation !== null && typeof definition.invocation === 'object' ? definition.invocation : {}
			writeJson(res, 200, {
				ok: true,
				workspace: root,
				workspaceSource: resolved.source,
				layer: view.layer,
				name: asScalar(definition.name) ?? name,
				description: asScalar(definition.description),
				whenToUse: asScalar(definition.whenToUse),
				source: asScalar(definition.source),
				provider: asScalar(definition.provider),
				path: asScalar(definition.path),
				modelInvocable: invocation.modelInvocable === true,
				userInvocable: invocation.userInvocable === true,
				chars: content.length,
				truncated,
				content: truncated ? content.slice(0, SKILL_CONTENT_LIMIT) : content,
				warnings,
			})
		} catch (error) {
			writeJson(res, 503, { ok: false, error: '技能正文读不成：' + messageOf(error) })
		}
	}

	/**
	 * 技能注册表服务（`ctx.skills`）：这是**可选服务** —— 本部署没装技能支持时取不到。
	 * 取不到一律返回 null，由调用方判 503 并点名该装哪个包（**不许**把它当成"技能是空的"）。
	 * @param ctx - 宿主 ctx。
	 * @returns 注册表服务，或 null。
	 */
	function skillsServiceOf(ctx) {
		const service = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
		if (service === undefined || service === null) return null
		if (typeof service.snapshot !== 'function' || typeof service.get !== 'function') return null
		return service
	}

	/**
	 * 宿主**直接写盘**之后，通知技能注册表「目录变了」。
	 *
	 * 为什么需要这一句：DSH 自己那条写路（写/编辑工具）会把改动告诉技能提供方
	 * （`provider.observeHostMutation(path)`）；而本插件的三个写动作是直接 `fs` 落盘，
	 * 注册表不知道有人动过目录，它的 collectCache 会继续供旧清单 —— 症状就是
	 * **在面板上删掉一个技能，列表还留着它**（重启或换个会话才消失）。
	 *
	 * 这里补同一步，按可用的公开面依次尝试，全部失败也不影响写入本身：
	 *   ① `invalidateCache()`（注册表公开方法：递增 revision + 清 collectCache + 通知订阅方）；
	 *   ② 退一步 `notifyChange()`；
	 *   ③ 再退一步：按 provider 逐个通知（旧版只有 provider 那一层的 `observeHostMutation`）。
	 * @param ctx - 宿主 ctx。
	 * @param paths - 这次写到/删掉的路径（provider 那条路要它判"是不是我的根"）。
	 * @returns 用上了哪一档；三档都不可用时返回 `'none'`（调用方只做记录，不报错）。
	 */
	function invalidateSkillCatalog(ctx, paths = []) {
		const service = skillsServiceOf(ctx)
		if (service === null) return 'no-service'
		try {
			if (typeof service.invalidateCache === 'function') {
				service.invalidateCache()
				return 'invalidateCache'
			}
		} catch {
			/* 落到下一档 */
		}
		try {
			if (typeof service.notifyChange === 'function') {
				service.notifyChange()
				return 'notifyChange'
			}
		} catch {
			/* 落到下一档 */
		}
		try {
			const layers = service.layers
			const list = layers !== undefined && layers !== null && typeof layers.values === 'function' ? [...layers.values()] : []
			let notified = 0
			for (const layer of list) {
				const providers = layer !== null && typeof layer === 'object' ? layer.providers : undefined
				const entries = providers !== undefined && providers !== null && typeof providers.values === 'function' ? [...providers.values()] : []
				for (const entry of entries) {
					const provider = entry !== null && typeof entry === 'object' ? entry.provider : undefined
					if (typeof provider?.observeHostMutation !== 'function') continue
					for (const path of paths) {
						try {
							provider.observeHostMutation(path)
							notified += 1
						} catch {
							/* 单个 provider 失败不影响其余 */
						}
					}
				}
			}
			if (notified > 0) return 'providers'
		} catch {
			/* 三档都不行：如实回落，不改写入结果 */
		}
		return 'none'
	}


	/** 注册表缺席时那一行**唯一的**措辞（两条端点共用同一句，免得两处各写一份）。 */
	const SKILLS_SERVICE_MISSING =
		'这个部署没有技能注册表（`ctx.skills` 取不到）：技能栏读不到目录 —— **读不到不等于"一个技能都没有"**。修法：确认该 profile 里装了 `@deepseek-ai/dsh-skill` 与 `@deepseek-ai/dsh-skill-filesystem`。'

	/**
	 * 技能清单条目**整形**：只留标量叶子；调用面那两格摊成同级的两个布尔
	 * （前端不必再判一遍 `invocation` 的形状；缺那一格按"不可调用"算 —— **读不到不印成可用**）。
	 * @param raw - 注册表给的 skill summary。
	 * @returns 扁平记录，或 null（非对象）。
	 */
	/**
	 * **技能来源 → 层级**（唯一正文）：面板的筛档、卡上的来源标、写入时那句"写哪一级"都从这一处出，
	 * 客户端**不自己判**（这三轮反复栽在"同一处两个说法"上）。
	 * 层级：`project`（项目级 `<工作区>/.dsh/skills`）/ `user`（用户级 `~/.dsh/skills`）/ `package`（随包）/ `other`。
	 */
	const SKILL_LEVEL_LABEL = { project: '项目级', user: '用户级', package: '包内', other: '其他来源' }
	function skillLevelOf(source) {
		const value = typeof source === 'string' ? source : ''
		if (value.startsWith('project')) return 'project'
		if (value.startsWith('user')) return 'user'
		if (value === 'bundled' || value.startsWith('package')) return 'package'
		return 'other'
	}

	function shapeSkillSummary(raw) {
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
		const invocation = raw.invocation !== null && typeof raw.invocation === 'object' ? raw.invocation : {}
		const source = asScalar(raw.source)
		const level = skillLevelOf(source)
		return {
			name: asScalar(raw.name),
			description: asScalar(raw.description),
			whenToUse: asScalar(raw.whenToUse),
			source,
			// **层级与它的中文标签**（面板筛档与卡上那一枚标都照这两格画，不自己判）
			level,
			levelLabel: SKILL_LEVEL_LABEL[level] ?? level,
			provider: asScalar(raw.provider),
			path: asScalar(raw.path),
			modelInvocable: invocation.modelInvocable === true,
			userInvocable: invocation.userInvocable === true,
		}
	}

	/**
	 * 技能的三个写动作（人在面板上点的那一下）：
	 *   · `import`：`root`（`user` / `project`，缺省 `user`）+ **两种输入形状之一**：
	 *     `source`（本机路径：一个含 `SKILL.md` 的目录，或一个 `.md` 文件；相对路径按当前工作区解析）
	 *     或 `files`（`[{path, dataBase64}]`：浏览器拖进来/选中的那批文件，面板的拖拽区走这条）⇒ 写进那个根；
	 *   · `create`：`root` + `name` + `description` + `body` ⇒ 新建 `<root>/<name>/SKILL.md`；
	 *   · `remove`：`root` + `name` ⇒ 删掉 `<root>/<name>` 那一棵目录。
	 *
	 * **只增不改**：目标已存在一律拒绝（不覆盖别人的东西）。判定与 fs 都在 `lib/skill-write.js`
	 * （唯一实现）—— 本函数只做"取参数、转发、把结论原样回显"。
	 * `project` 根需要工作区；`user` 根不需要（所以缺工作区只在 project 那一支报错）。
	 * @param req - 请求。
	 * @param res - 响应。
	 * @param fallback - 请求未带 workspace 时用的 composition 行配置值。
	 * @param action - `'import' | 'create' | 'remove'`。
	 */
	async function handleSkillWrite(ctx, req, res, fallback, action) {
		if (req.method !== 'POST') {
			writeJson(res, 405, { ok: false, error: `技能写入口只支持 POST（${action}）` })
			return
		}
		let body
		try {
			body = JSON.parse(await readBody(req, SKILL_IMPORT_BODY_LIMIT))
		} catch (error) {
			bodyError(res, error, SKILL_IMPORT_BODY_LIMIT)
			return
		}
		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			writeJson(res, 400, { ok: false, error: '请求体必须是一个对象' })
			return
		}
		const root = typeof body.root === 'string' && body.root.trim() !== '' ? body.root.trim() : 'user'
		if (root !== 'user' && root !== 'project') {
			writeJson(res, 400, { ok: false, error: `root 只支持 user / project（收到 ${root}）；随包发布的技能与别的 agent 的根只读` })
			return
		}
		// `project` 根要工作区：请求带的优先，其次 composition 行的配置值。
		let workspace = null
		if (root === 'project') {
			const opened = await deps.openWorkspaceOf(ctx, req, res, fallback, {
				writable: true,
				missing: '项目级技能根要工作区：请求里带 ?workspace=<绝对路径>，或在 composition 行里配 workspace。',
			})
			if (opened === null) return
			workspace = opened.root
		}
		const outcome =
			action === 'import'
				? // 两条输入形状（同一套判定与落盘）：`source` = 本机路径（宿主侧复制），
					// `files` = 浏览器拖进来/选中的那批文件（`{path, dataBase64}`，面板的拖拽区走这条）。
					Array.isArray(body.files)
					? importSkillFiles({ kind: root, workspace, name: typeof body.name === 'string' ? body.name : '', files: body.files })
					: importSkill({ kind: root, workspace, source: typeof body.source === 'string' ? body.source : '' })
				: action === 'create'
					? createSkill({ kind: root, workspace, name: typeof body.name === 'string' ? body.name : '', description: typeof body.description === 'string' ? body.description : '', body: typeof body.body === 'string' ? body.body : '' })
					: removeSkill({ kind: root, workspace, name: typeof body.name === 'string' ? body.name : '' })
		if (outcome.ok !== true) {
			writeJson(res, 400, { ok: false, error: outcome.reason })
			return
		}
		// **写盘成功之后立刻让技能注册表失效**（删了还在、导入后不出现，都是漏了这一句）：
		// 与 DSH 自己那条工具写入通知同一效果，失败也不影响这次写入的结果。
		const skillCatalog = invalidateSkillCatalog(ctx, typeof outcome.path === 'string' && outcome.path !== '' ? [outcome.path] : [])
		// **删技能时同步剪角色那一行**（HD-007 的第二件）：只在**人主动删掉一个技能**这个动作之后做，
		// 且**只按这个名字**剪 —— 绝不按"本会话目录里没有"来删（技能目录按会话变，那样会剪掉别的会话里还有用的声明）。
		let skillPrune = null
		if (action === 'remove') {
			try {
				const pruned = await pruneSkillFromRoles(ctx, { workspace }, typeof body.name === 'string' ? body.name : '')
				skillPrune = {
					changed: pruned.changed,
					packageRoles: pruned.packageRoles,
					scanned: pruned.scanned,
					// 一句给人看的话：**改了哪几个、还有哪几个包内的仍声明它**（不许只回一句"已同步"）。
					note:
						pruned.changed.length === 0 && pruned.packageRoles.length === 0
							? '没有角色声明这个技能：一个文件都没动。'
							: [
									// **按真实来源说是哪个根**（工作区根 / 用户根）—— 从前这里把两种一律叫"用户根"，
									// 现场报错过一次：工作区根里的角色被说成了用户根（改动逻辑没变，只是标签错了）。
									pruned.changed.length === 0
										? '工作区根与用户根里都没有角色声明它（没改任何文件）'
										: `已从这些${pruneRootLabelOf(pruned.changed)}角色里剪掉：${pruned.changed.map((item) => `${item.role}（${item.source === 'workspace' ? '本工作区根' : '用户根'}）`).join('、')}`,
									pruned.packageRoles.length === 0
										? '包内角色里也没有人声明它'
										: `**包内角色仍声明它**（包内只读、不改发布面）：${pruned.packageRoles.map((item) => item.role).join('、')} —— 想连它们一起去掉，就在面板上「改」一份到用户根再删那一行`,
								].join('；'),
				}
			} catch (error) {
				// 剪不动不该把"技能已经删掉了"说成失败：如实附一条说明。
				skillPrune = { changed: [], packageRoles: [], scanned: 0, error: messageOf(error) }
			}
		}
		writeJson(res, 200, {
			ok: true,
			action,
			id: outcome.id,
			root: outcome.root,
			path: outcome.path,
			rootLabel: skillRootLabel(root),
			// **技能目录失效用了哪一档**（`invalidateCache` / `notifyChange` / `providers` / `none`）：
			// 面板据此说明"清单是否立刻刷新"——`none` 时下一句要提示"重启或新会话才看得到"。
			skillCatalog,
			...(skillPrune === null ? {} : { skillPrune }),
		})
	}

	return { handleSkills, handleSkillDefinition, invalidateSkillCatalog, handleSkillWrite }
}
