/**
 * 「打开本地目录」端点：平台命令兜底（Electron / 宿主服务 / xdg-open），只开工作区之内的目录。
 * `nativeOpenSpec` 是纯函数，自检直接测它；宿主只注入工作区解析。
 */
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { bodyError, DECIDE_BODY_LIMIT, messageOf, readBody, writeJson } from './http-tools.js'

/** @param deps - `{ openWorkspaceOf }` */
export function createOpenRoutes(deps) {
	/**
	 * 一个平台"打开目录"的命令规格（**纯函数**，自检直接测它）。
	 *
	 * 为什么用平台命令而不是 Electron 的 `shell`：**DSH 自己就是这么开的** ——
	 * `@deepseek-ai/dsh-native-command` 在 macOS 走 `open`、Linux 走 `xdg-open`、
	 * Windows 交给 Explorer（它自己的注释写了理由：Windows 那边只有 Explorer 的双击
	 * 关联解析是可靠的）。而宿主半边是 profile 平面上的普通 Node 模块，
	 * `import('electron')` 在这里取不到 —— 现场实测就是 409「取不到 Electron 的 shell」。
	 * @param target - 要打开的绝对路径（目录）。
	 * @param platform - `process.platform`；测试用参数。
	 * @returns `{ command, args }`。
	 */
	function nativeOpenSpec(target, platform = process.platform) {
		if (platform === 'darwin') return { command: 'open', args: [target] }
		if (platform === 'win32') return { command: 'explorer.exe', args: [target] }
		return { command: 'xdg-open', args: [target] }
	}

	/**
	 * 打开一个本地目录：**官方接缝优先 → 平台命令兜底 → Electron 殿后**，三级都失败才报错。
	 *
	 * 三级各自留下失败原因、一起写进回执：现场看到的是"哪几条都试过、各为什么不行"，
	 * 而不是一句"打不开"。spawn 走 detached + unref —— 打开这个动作是**交给系统**的，
	 * 本进程不等它、也不因它退出而受影响。
	 * @param ctx - 宿主 ctx（`sessionController` 走 `ctx.get`，不进 `inject`）。
	 * @param target - 已校验过（在工作区内、存在且是目录）的绝对路径。
	 * @returns `{ ok: true, via }` 或 `{ ok: false, failures }`。
	 */
	async function openDirectory(ctx, target) {
		const failures = []
		// ① DSH 自己的宿主服务（存在就用它）：`@deepseek-ai/dsh-api-session-controller` 的 openPath，
		//    它内部已经处理了平台差异与 WSL 的路径翻译。
		try {
			const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
			if (controller !== undefined && typeof controller.openPath === 'function') {
				await controller.openPath(target)
				return { ok: true, via: 'sessionController.openPath' }
			}
		} catch (error) {
			failures.push(`sessionController.openPath 失败：${messageOf(error)}`)
		}
		// ② 平台命令（与 DSH 自己那条路一致）。
		const spec = nativeOpenSpec(target)
		try {
			await new Promise((resolve, reject) => {
				const child = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore' })
				child.once('error', reject)
				child.once('spawn', () => {
					child.unref()
					resolve(undefined)
				})
			})
			return { ok: true, via: spec.command }
		} catch (error) {
			failures.push(`${spec.command} 失败：${messageOf(error)}`)
		}
		// ③ Electron 的 shell（某些形态下这条路通；失败只记一行，不声张）。
		try {
			const electron = await import('electron')
			const shell = electron.shell ?? (electron.default === undefined ? undefined : electron.default.shell)
			if (shell !== undefined && typeof shell.openPath === 'function') {
				const failure = await shell.openPath(target)
				if (typeof failure !== 'string' || failure === '') return { ok: true, via: 'electron.shell.openPath' }
				failures.push(`electron.shell.openPath 失败：${failure}`)
			} else {
				failures.push('electron.shell.openPath 不可用（这个运行形态取不到 Electron 的 shell）')
			}
		} catch (error) {
			failures.push(`electron 取不到：${messageOf(error)}`)
		}
		return { ok: false, failures }
	}

	async function handleOpen(ctx, req, res, fallback) {
		if (req.method !== 'POST') {
			writeJson(res, 405, { ok: false, error: '打开目录只支持 POST' })
			return
		}
		const opened = await deps.openWorkspaceOf(ctx, req, res, fallback)
		if (opened === null) return
		const root = opened.root
		const resolved = opened.resolved
		let body
		try {
			body = JSON.parse(await readBody(req, DECIDE_BODY_LIMIT))
		} catch (error) {
			bodyError(res, error, DECIDE_BODY_LIMIT)
			return
		}
		const target = body === null || typeof body !== 'object' || typeof body.path !== 'string' ? '' : body.path.trim()
		if (target === '' || target.indexOf('\0') !== -1 || !target.startsWith('/')) {
			writeJson(res, 400, { ok: false, error: 'path 必须是绝对路径' })
			return
		}
		// 只开工作区之内的目录：等于根，或在 `根/` 之下。越界一律拒（不做"猜你要开哪个"）。
		if (target !== root && !target.startsWith(root.endsWith('/') ? root : root + '/')) {
			writeJson(res, 403, { ok: false, error: '只能打开当前工作区之内的目录' })
			return
		}
		try {
			const info = await ctx.fs.stat(await ctx.fs.resolve(target))
			if (info === undefined) {
				writeJson(res, 404, { ok: false, error: '目录不存在：' + target })
				return
			}
			if (info.type !== 'directory') {
				writeJson(res, 400, { ok: false, error: '不是目录：' + target })
				return
			}
			const opened = await openDirectory(ctx, target)
			if (!opened.ok) {
				writeJson(res, 409, { ok: false, error: `主进程没能打开这个目录：${opened.failures.join('；')}。请改用复制路径。` })
				return
			}
			writeJson(res, 200, { ok: true, path: target, via: opened.via })
		} catch (error) {
			console.error('[dsh-team-ops] 打开目录异常:', error)
			writeJson(res, 500, { ok: false, error: '内部错误' })
		}
	}

	return { nativeOpenSpec, handleOpen }
}
