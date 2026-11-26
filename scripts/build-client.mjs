#!/usr/bin/env node
/**
 * 把 `client-src/*.part` 按文件名顺序拼回 `lib/board-view.client.js`。
 *
 * 为什么需要一层拼装：浏览器半边由 `dsh-client-modules` 以**单个 lazy-CJS 工厂**投递，
 * 工厂内只能 require 平台种子词，不能 require 兄弟文件（见 client 文件头）。
 * 于是源码按 16 个分区拆开维护，发布物仍是那一个文件 —— 加载方式、端点、测试读取路径
 * 以及 `package.json` 的 `exports["./client"]` 全都不变。
 *
 * 用法：
 *   node scripts/build-client.mjs            # 重新生成 lib/board-view.client.js
 *   node scripts/build-client.mjs --check    # 只比对，不改文件（自检用）
 *
 * 片段是**字节级**拼接的：不用模板串、不补换行，改一个空格都会反映到生成物里。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(ROOT, 'client-src')
const target = join(ROOT, 'lib', 'board-view.client.js')
const parts = readdirSync(src)
	.filter((name) => name.endsWith('.part'))
	.sort()
if (parts.length === 0) throw new Error(`client-src/ 下没有 .part 片段：${src}`)
const bundle = Buffer.concat(parts.map((name) => readFileSync(join(src, name))))

if (process.argv.includes('--check')) {
	const current = readFileSync(target)
	if (!current.equals(bundle)) {
		console.error(`[build:client] 不一致：生成物 ${current.length} 字节，片段拼出 ${bundle.length} 字节。改了片段就跑 npm run build:client。`)
		process.exit(1)
	}
	console.log(`[build:client] 一致：${parts.length} 个片段 = ${bundle.length} 字节`)
} else {
	writeFileSync(target, bundle)
	console.log(`[build:client] 已生成 lib/board-view.client.js（${parts.length} 个片段，${bundle.length} 字节）`)
}
