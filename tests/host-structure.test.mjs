#!/usr/bin/env node
/**
 * 宿主装配面的**结构契约**（行为断言，不读源码文本）。
 *
 * 拆分之后 host 只剩 loader entry + 路由表 + 装配，这些契约用真实导出/真实表来核：
 *   · 每个 `*_PATH` 端点常量都登记在 `routeTable()` 里（新增端点漏登记会红）；
 *   · 路由表条目的路径在前缀下、handler 是函数、动作名在闭集内；
 *   · host 转出去的 `requestedWorkspace` / `ledgerKeyOf` / `readLedger` 与 `lib/workspace-io.js`
 *     是同一引用（拆分只挪位置，不改行为）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const ACTIONS = new Set([undefined, 'update', 'remove', 'restore', 'delete', 'disable', 'interrupt', 'import', 'create'])

test('routeTable：每条路径都在前缀下、handler 是函数、动作名在闭集内', async () => {
	const host = await import('../lib/board-view.host.js')
	const routes = host.routeTable()
	assert.ok(routes instanceof Map, 'routeTable() 要返回 Map')
	assert.ok(routes.size >= 26, '具名端点少了：' + routes.size)
	for (const [path, entry] of routes) {
		assert.ok(path.startsWith(host.ROUTE_PATH + '/'), `路径要在 ${host.ROUTE_PATH} 下：${path}`)
		assert.ok(Array.isArray(entry) && typeof entry[0] === 'function', `${path} 的 handler 要是函数`)
		assert.ok(ACTIONS.has(entry[1]), `${path} 的动作名不在闭集内：${entry[1]}`)
	}
})

test('所有 *_PATH 端点常量都登记在 routeTable 里（漏登记会红）', async () => {
	const host = await import('../lib/board-view.host.js')
	const routes = host.routeTable()
	const names = Object.keys(host).filter((name) => name.endsWith('_PATH') && name !== 'ROUTE_PATH')
	assert.ok(names.length >= 26, '端点常量数量异常：' + names.length)
	for (const name of names) {
		assert.ok(routes.has(host[name]), `${name}（${host[name]}）没登记在 routeTable 里`)
	}
})

test('host 的导出与 workspace-io 是同一引用（拆分只挪位置）', async () => {
	const host = await import('../lib/board-view.host.js')
	const io = await import('../lib/workspace-io.js')
	for (const name of ['requestedWorkspace', 'ledgerKeyOf', 'readLedger']) {
		assert.equal(typeof io[name], 'function', `workspace-io 要导出 ${name}`)
		assert.equal(host[name], io[name], `${name} 应是同一函数引用`)
	}
})
