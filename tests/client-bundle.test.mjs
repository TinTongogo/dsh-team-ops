#!/usr/bin/env node
/**
 * 浏览器半边的**拼装一致性**自检。
 *
 * `lib/board-view.client.js` 是发布物（单文件 lazy-CJS 工厂），源在 `client-src/*.part`。
 * 这条把「片段拼出来的字节」与「发布物」逐字节比：手改了生成物却没同步片段，或改了片段
 * 没跑 `npm run build:client`，都会在这里红 —— 不允许两边悄悄分叉。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(ROOT, 'client-src')

function partsOf() {
	return readdirSync(src)
		.filter((name) => name.endsWith('.part'))
		.sort()
}

test('client 发布物 = client-src/*.part 逐字节拼接', () => {
	const parts = partsOf()
	assert.ok(parts.length >= 17, '片段少了：' + parts.join('、'))
	const bundle = Buffer.concat(parts.map((name) => readFileSync(join(src, name))))
	const published = readFileSync(join(ROOT, 'lib', 'board-view.client.js'))
	assert.ok(
		published.equals(bundle),
		`发布物与片段不一致（${published.length} vs ${bundle.length} 字节）：改了片段请跑 npm run build:client`,
	)
})

test('16 个分区横幅各占一个片段，顺序与编号一致', () => {
	const numbers = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯'
	const banners = []
	for (const name of partsOf()) {
		for (const line of readFileSync(join(src, name), 'utf8').split('\n')) {
			const trimmed = line.trimStart()
			if (!trimmed.startsWith('// ── ')) continue
			const number = trimmed.slice(6, 7)
			if (numbers.includes(number)) banners.push(number)
		}
	}
	assert.deepEqual(banners, [...numbers], '分区横幅要按 ①→⑯ 各出现一次')
})
