#!/usr/bin/env node
/**
 * 一条命令跑完本包的验证：**语法（每个随包发布的 JS 文件都能被解析）+ 自检（域规则测试）**。
 *
 * 为什么要有它：这个包的发布面是一堆**预设本地插件**（`presets/` 下那几个 `.js` 由 DSH 的
 * 加载器在预设目录里装载），它们不经打包器、也不在 `lib/` 里 —— 谁改错一个字符，
 * 症状是"插件在预设里静默不生效"，而不是构建报错。所以验证要能在**装之前**在仓库里跑完。
 *
 * 三个判据，缺一不算过：
 * 1. `node --check`：**发布面里每一个 .js** 都能被解析（语法层，最便宜的那道）——
 * "发布面"从 `package.json` 的 `files` 推导，不是手抄一份目录名（这里原先写的是 `presets/**.js`，
 * 而那个目录早就不在包里了：自述与实现各说各的，谁也没拦住）；
 * 2. `node tests/roster.mjs`：名册漂移（文档里的生成块必须与现场枚举一致）；
 * 3. `node --test tests/*.test.mjs`：域规则自检（CAS / 依赖 / 执行代 / 邮箱 / 调度 / 打包齐备）。
 *
 * 用法：`npm run verify`。任何一项失败即以非零退出码结束，并把失败面逐个点名。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 发布面里那些**目录**：从 `package.json` 的 `files` 读（`README.md` 与 `*.yml` 不是 JS 目录）。
 *
 * 手抄一份目录名是"自述会烂"的常见成因：这里曾经写着 `presets/**.js`，而那个目录早已不在包里 ——
 * 注释与代码各说各的，语法检查照样"全绿"。从 `files` 推导之后，发布面变了这里自动跟着变。
 */
function publishedDirs() {
	const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
	const files = Array.isArray(manifest.files) ? manifest.files : []
	return files.filter((entry) => typeof entry === 'string' && entry !== 'README.md' && !entry.endsWith('.yml'))
}

/** 递归收集某目录下的 `.js` 文件（发布面就是这些，`.mjs` 只存在于 tests/）。 */
function collectJs(dir) {
	const out = []
	let entries = []
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return out
	}
	for (const entry of entries) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) out.push(...collectJs(full))
		else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full)
	}
	return out
}

const dirs = publishedDirs()
const missingDirs = dirs.filter((dir) => collectJs(join(packageRoot, dir)).length === 0)
const files = dirs.flatMap((dir) => collectJs(join(packageRoot, dir))).sort()
const syntaxFailures = []
for (const file of files) {
	const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
	if (result.status !== 0) syntaxFailures.push({ file, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() })
}

console.log(`[verify] 语法：发布面 ${dirs.join(' + ')} 共 ${files.length} 个 JS 文件，失败 ${syntaxFailures.length} 个`)
// **发布面里出现一个"一个 JS 都没收到"的目录** = 收集面漏了它（或发布面写错），要当场红，不许全绿。
for (const dir of missingDirs) console.error(`[verify]（未通过） 发布面里的 ${dir} 一个 JS 都没收集到（收集面漏了它，或 files 写错）`)
for (const failure of syntaxFailures) console.error(`[verify]（未通过） ${relative(packageRoot, failure.file)}\n${failure.output}`)

// 名册漂移：文档里的生成块必须与现场枚举一致（加/删了角色却没刷文档 = 红）
const rosterRun = spawnSync(process.execPath, ['tests/roster.mjs'], { cwd: packageRoot, stdio: 'inherit' })
console.log(`[verify] 名册：node tests/roster.mjs 退出码 ${rosterRun.status}`)

const testRun = spawnSync(process.execPath, ['--test', 'tests/*.test.mjs'], { cwd: packageRoot, stdio: 'inherit' })
console.log(`[verify] 自检：node --test 退出码 ${testRun.status}`)

if (syntaxFailures.length > 0 || missingDirs.length > 0 || rosterRun.status !== 0 || testRun.status !== 0) {
	console.error('[verify] 未通过：先修上面点名的文件或失败用例。')
	process.exit(1)
}
console.log('[verify] 通过：语法与自检全绿。')
