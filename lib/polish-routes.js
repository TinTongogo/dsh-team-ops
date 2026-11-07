/**
 * 输入框润色的 HTTP 端点：`POST /company-board/api/polish`。
 *
 * 约束（与其余端点族同一条纪律）：
 *   · 只接受 POST；读体上限 32KB；未命中写方法由宿主兜底回 405（见 `lib/board-view.host.js`）；
 *   · 同源 loopback 由宿主统一判（`isLoopbackSameOrigin`），这里不再自己判一次；
 *   · 每会话**并发 1**（正在润色时再点一次回 409 busy，不排队、不重复花钱）；
 *   · 每会话**每分钟 6 次**（429 rate-limited）；
 *   · 总超时 20s（504 timeout）；上游失败原文透出（502 upstream），不吞成"失败"。
 *
 * 错误契约：`{ ok:false, error:string, reason?: 'bad-request'|'no-route'|'busy'|'rate-limited'|'timeout'|'upstream' }`
 * —— 客户端按 `reason` 给不同的下一步（重试 / 先发消息 / 稍后再点）。
 */

import { bodyError, messageOf, readBody, writeJson } from './http-tools.js'
import { POLISH_BODY_LIMIT, POLISH_MAX_CHARS, POLISH_TIMEOUT_MS } from './polish.js'

/** 每会话每分钟最多几次润色。 */
const RATE_LIMIT = 6
const RATE_WINDOW_MS = 60 * 1000

/**
 * @param deps - `{ polish: { polish: Function } }`（见 `lib/polish.js`）。
 * @returns {{ handlePolish: Function }} 端点处理函数（与其余端点族同一装配形状）。
 */
export function createPolishRoutes(deps) {
	const service = deps === null || deps === undefined ? {} : deps.polish
	/** 正在润色的会话（并发 1）。 */
	const inflight = new Set()
	/** 每会话最近一分钟的调用时刻（限流）。 */
	const buckets = new Map()

	/**
	 * 限流判定：窗口内已有 6 次就拒；不抛错。
	 * @param {string} sessionId - 会话 id。
	 * @returns {boolean} 是否放行。
	 */
	const rateAllows = (sessionId) => {
		const now = Date.now()
		const recent = (buckets.get(sessionId) ?? []).filter((at) => now - at < RATE_WINDOW_MS)
		if (recent.length >= RATE_LIMIT) {
			buckets.set(sessionId, recent)
			return false
		}
		recent.push(now)
		buckets.set(sessionId, recent)
		// 会话数不设上限会无界增长：超过 64 个会话就按"最久没调用"淘汰。
		while (buckets.size > 64) buckets.delete(buckets.keys().next().value)
		return true
	}

	/**
	 * `POST /company-board/api/polish`：把一段草稿交给模型润色。
	 * @param {object} ctx - 宿主 ctx。
	 * @param {object} req - 请求。
	 * @param {object} res - 响应。
	 * @returns {Promise<void>}
	 */
	async function handlePolish(ctx, req, res) {
		const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET'
		if (method !== 'POST') {
			writeJson(res, 405, { ok: false, error: '润色只接受 POST（把 { session, text } 发过来）', reason: 'bad-request' })
			return
		}
		let raw = ''
		try {
			raw = await readBody(req, POLISH_BODY_LIMIT)
		} catch (error) {
			bodyError(res, error, POLISH_BODY_LIMIT)
			return
		}
		let body = null
		try {
			body = JSON.parse(raw)
		} catch {
			writeJson(res, 400, { ok: false, error: '请求体不是 JSON（要给 { session, text }）', reason: 'bad-request' })
			return
		}
		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			writeJson(res, 400, { ok: false, error: '请求体必须是对象：{ session, text }', reason: 'bad-request' })
			return
		}
		const sessionId = typeof body.session === 'string' ? body.session.trim() : ''
		const text = typeof body.text === 'string' ? body.text : ''
		if (sessionId === '') {
			writeJson(res, 400, { ok: false, error: '缺少 session：润色要指明给哪个会话借模型路由', reason: 'bad-request' })
			return
		}
		if (text.trim() === '') {
			writeJson(res, 400, { ok: false, error: '草稿为空：先输入内容再润色', reason: 'bad-request' })
			return
		}
		if (text.length > POLISH_MAX_CHARS) {
			writeJson(res, 400, {
				ok: false,
				error: `草稿 ${text.length} 字，超过 ${POLISH_MAX_CHARS} 字上限（截断会丢信息，所以拒绝）。`,
				reason: 'bad-request',
			})
			return
		}
		if (inflight.has(sessionId)) {
			writeJson(res, 409, { ok: false, error: '这个会话正在润色上一条：等它回来或关掉浮窗再试。', reason: 'busy' })
			return
		}
		if (!rateAllows(sessionId)) {
			writeJson(res, 429, { ok: false, error: '润色太频繁了（每分钟 6 次）：稍等一下再试。', reason: 'rate-limited' })
			return
		}
		if (typeof service?.polish !== 'function') {
			writeJson(res, 502, { ok: false, error: '润色服务没装配上（宿主缺少 polish 服务）。', reason: 'upstream' })
			return
		}

		inflight.add(sessionId)
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(Object.assign(new Error('润色超时（' + POLISH_TIMEOUT_MS / 1000 + ' 秒）'), { code: 'POLISH_TIMEOUT' })), POLISH_TIMEOUT_MS)
		try {
			const result = await service.polish({ ctx, sessionId, text, signal: controller.signal })
			writeJson(res, 200, { ok: true, ...result })
		} catch (error) {
			const code = error !== null && typeof error === 'object' ? error.code : undefined
			if (code === 'POLISH_TIMEOUT' || (controller.signal.aborted === true && code !== 'POLISH_UPSTREAM')) {
				writeJson(res, 504, { ok: false, error: '润色超时：模型没有在时限内回完，可以重试一次。', reason: 'timeout' })
				return
			}
			if (code === 'POLISH_NO_ROUTE') {
				writeJson(res, 409, {
					ok: false,
					error: '本会话还没有可用的模型路由：先发一条消息（让会话拿到 provider / model），再回来润色。',
					reason: 'no-route',
				})
				return
			}
			if (code === 'POLISH_EMPTY' || code === 'POLISH_TOO_LONG') {
				writeJson(res, 400, { ok: false, error: messageOf(error), reason: 'bad-request' })
				return
			}
			writeJson(res, 502, { ok: false, error: '润色失败：' + messageOf(error), reason: 'upstream' })
		} finally {
			clearTimeout(timer)
			inflight.delete(sessionId)
		}
	}

	return { handlePolish }
}
