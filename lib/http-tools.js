/**
 * 面板 HTTP 的**编解码工具**：查询参数、请求体、统一 JSON 回执与错误措辞。
 *
 * 这些函数不认 ctx、不认工作区、不认业务字段，只做「请求 → 值 / 值 → 响应」。
 * 从 `board-view.host.js` 分出来之后，端点模块可以独立复用，宿主只负责装配与路由。
 */

/** 取查询串里的一个参数（缺省空串）——只用于 `?role=` 这类短参数。 */
/** 写动作的请求体上限（一条决定 / 一个开关 / 一次角色改动的字段都很少）：8 KB。 */
export const DECIDE_BODY_LIMIT = 8 * 1024

export function queryValue(url, name) {
	const query = typeof url === 'string' ? url.split('#')[0].split('?')[1] : undefined
	if (query === undefined || query.length === 0) return ''
	try {
		const raw = new URLSearchParams(query).get(name)
		return raw === null ? '' : raw.trim()
	} catch {
		return ''
	}
}

/**
 * 读请求体（带上限）。只给写入口用：读路径不需要 body。
 * @param req - Node 的 IncomingMessage。
 * @param limit - 字节上限。
 * @returns UTF-8 文本；超限抛错。
 */
export function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		if (typeof req.on !== 'function') {
			resolve('')
			return
		}
		let size = 0
		let exceeded = false
		const chunks = []
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > limit) {
				// **超限不掐连接**（`req.destroy()` 会让浏览器只看到 "TypeError: Failed to fetch"，
				// 人拿不到任何可读原因）。这里把剩下的读完、丢掉内容，最后回一个**正常的 413**。
				exceeded = true
				chunks.length = 0
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => {
			if (exceeded) {
				const error = new Error('请求体过大')
				error.code = 'BODY_TOO_LARGE'
				error.limit = limit
				error.size = size
				reject(error)
				return
			}
			resolve(Buffer.concat(chunks).toString('utf8'))
		})
		req.on('error', reject)
	})
}

/**
 * 读体失败时的统一回执：**超限给 413**（说清上限与收到多少 KB），其余给 400。
 * 只在这一处判定 —— 各端点不再各写一遍。
 */
export function bodyError(res, error, limit) {
	if (error !== null && typeof error === 'object' && error.code === 'BODY_TOO_LARGE') {
		const got = Math.round((typeof error.size === 'number' ? error.size : 0) / 1024)
		// **上限取读体时真正用的那个**（`readBody` 把它记在错误上）：调用方传错常量也不会说谎 ——
		// 现场踩过：某个端点用 8 KB 读体、回执却写「上限 64 KB」（3 处，已修）。
		const real = typeof error.limit === 'number' && error.limit > 0 ? error.limit : limit
		writeJson(res, 413, {
			ok: false,
			error: `请求体过大：收到约 ${got} KB，上限 ${Math.round(real / 1024)} KB。技能导入请分批，或改用「新建技能」手写正文。`,
		})
		return
	}
	writeJson(res, 400, { ok: false, error: '请求体不合法：' + messageOf(error) })
}

/** 写一个 JSON 响应；不缓存，不回显内部信息。 */
export function writeJson(res, status, value) {
	const body = JSON.stringify(value)
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
	res.end(body)
}

/** 出错时的统一措辞：只给可读原因，不给路径与堆栈。 */
export function messageOf(error) {
	if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
	return String(error)
}

