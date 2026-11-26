#!/usr/bin/env node
/**
 * `screenshots.json` 自检：市场按这份声明取图，图没了就是详情页开天窗 —— 而**没人会收到报错**。
 *
 * 老规矩（同一事实两处 ⇒ 配机械检查）：截图"哪些图、按什么顺序"记在 `screenshots.json` 里，
 * 图本身在 `imgs/` 里，两边靠人同步过一次就再也对不上。这里把判据钉成断言：
 *
 *   ① 文件能解析成 JSON 数组（或 `{ "screenshots": [...] }`，两种市场都认）；
 *   ② 1–8 张（市场规则）；
 *   ③ 每个路径：相对路径、不以 `/` 开头、不含 `..`（不能跳出插件目录）；
 *   ④ 每个路径指向的文件**真的在**，且是 png / jpg / jpeg / webp（市场只认位图，SVG 会被拒）；
 *   ⑤ 宽度 ≥ 1280（市场里并排显示，太窄会被放大糊掉）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(ROOT, 'screenshots.json')

/** PNG 头里的宽高；不是 PNG 返回 null。 */
function pngSize(buffer) {
	if (buffer.length < 24 || buffer.toString('latin1', 12, 16) !== 'IHDR') return null
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** 读声明；数组与 `{ screenshots: [...] }` 都收。 */
function declared() {
	const parsed = JSON.parse(readFileSync(FILE, 'utf8'))
	const list = Array.isArray(parsed) ? parsed : parsed?.screenshots
	assert.ok(Array.isArray(list), 'screenshots.json 要是数组，或 {"screenshots": [...]}')
	return list
}

test('screenshots.json：1–8 张、相对路径、文件真在、是位图', () => {
	const list = declared()
	assert.ok(list.length >= 1 && list.length <= 8, '市场要求 1–8 张，现在有 ' + list.length + ' 张')
	const bad = []
	for (const path of list) {
		if (typeof path !== 'string' || path === '') {
			bad.push(JSON.stringify(path) + '：不是非空字符串')
			continue
		}
		if (path.startsWith('/')) bad.push(path + '：不能以 / 开头')
		if (path.includes('..')) bad.push(path + '：不能含 ..')
		if (!/\.(png|jpe?g|webp)$/i.test(extname(path))) bad.push(path + '：只收 png / jpg / jpeg / webp（SVG 会被拒）')
		if (!existsSync(join(ROOT, path))) bad.push(path + '：文件不在')
	}
	assert.deepEqual(bad, [], '截图声明有问题：\n' + bad.join('\n'))
})

test('screenshots.json：每张图宽度 ≥ 1280（并排显示时不至于糊）', () => {
	const thin = []
	for (const path of declared()) {
		if (!/\.png$/i.test(path)) continue // 非 PNG 不去猜头，交给市场；这条只管 PNG
		const size = pngSize(readFileSync(join(ROOT, path)))
		assert.notEqual(size, null, path + '：PNG 头读不出宽高')
		if (size.width < 1280) thin.push(path + '：' + size.width + 'px 宽')
	}
	assert.deepEqual(thin, [], '这些图太窄：\n' + thin.join('\n'))
})
