#!/usr/bin/env node
/**
 * 交叉引用自检：`《节名》第 N 条` **必须能在 `team/BASELINE.md` 里解析到**。
 *
 * 为什么要有这一条：`BASELINE.md` 是契约层，条款编号会随重写整节重排；`team/rules/*.md`
 * 与角色文件的标题按编号回指契约（`## 《看板纪律》第 6 条：…`）。**编号是同一事实的两处写法** ——
 * 契约一处、细则标题一处 —— 一旦重排，细则就指向不存在或不对应的条款，而文档不会报错。
 * 契约重写把旧 §五 12 条压成新 §六 11 条，细则标题留着 `1b / 3b / 4b / 4c / 5b / 5c / 5d`
 * 与旧序号，**19 处**对不上，全部自检照绿（当时的守护已被换成 `includes(关键词)` 抽样）。
 *
 * 判据（可当场核）：
 *   ① `《X》第 N 条` 且 `X` 是 BASELINE 的某一节 ⇒ 该节必须真有第 N 条；
 *   ② `X` 是某个细则文件名（`《交付物怎么写》`）⇒ 只核文件存在，不核编号（文件内没有条号空间）；
 *   ③ `X` 既不是节名也不是细则文件名 ⇒ **报错**（挡住节名写错 / 节被改名）；
 *   ④ 指针一律用 `《》`，不许用 `「」` 写条款引用（那条写法绕不过本检查）。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'team', 'BASELINE.md')

/** 只认 `节名` 这种元语法示例（它说明"写成什么样"，不是一次真实引用）。 */
const META_NAMES = new Set(['节名'])

/** 枚举一个目录下的 `*.md`（跳过 Finder 的 `.DS_Store` 这类点开头的项）。 */
function markdownOf(dir) {
	return readdirSync(dir)
		.filter((name) => !name.startsWith('.') && name.endsWith('.md'))
		.map((name) => join(dir, name))
}

/** 要扫的文件：契约、细则、角色、README，以及 lib 里的注释（那里也回指条款）。 */
function corpusOf() {
	const files = [BASELINE, join(ROOT, 'team', 'README.md'), join(ROOT, 'README.md'), ...markdownOf(join(ROOT, 'team', 'rules'))]
	const rolesRoot = join(ROOT, 'team', 'roles')
	for (const name of readdirSync(rolesRoot)) {
		if (name.startsWith('.')) continue
		const file = join(rolesRoot, name, 'ROLE.md')
		try {
			if (statSync(file).isFile()) files.push(file)
		} catch {
			/* 没有 ROLE.md 的目录跳过 */
		}
	}
	for (const name of readdirSync(join(ROOT, 'lib'))) {
		if (name.endsWith('.js')) files.push(join(ROOT, 'lib', name))
	}
	return files
}

/** 契约层：`## 一、作用域与角色` → `{ 作用域与角色: Set<条号> }`。 */
function sectionsOf() {
	const sections = new Map()
	let current = null
	for (const line of readFileSync(BASELINE, 'utf8').split('\n')) {
		const head = /^##\s*[一二三四五六七八九十]+、\s*(.+?)\s*$/.exec(line)
		if (head !== null) {
			current = head[1]
			sections.set(current, new Set())
			continue
		}
		if (/^##\s/.test(line)) {
			current = null
			continue
		}
		if (current === null) continue
		const item = /^(\d+)\s*[.、]/.exec(line)
		if (item !== null) sections.get(current).add(item[1])
	}
	return sections
}

/** 细则文件名（`team/rules/交付物怎么写.md` → `交付物怎么写`）。 */
function ruleFileNames() {
	return new Set(markdownOf(join(ROOT, 'team', 'rules')).map((path) => path.split('/').pop().replace(/\.md$/, '')))
}

const POINTER = /《([^》]{1,40})》\s*第\s*([0-9]+[a-z]?)\s*条/g

test('契约层能被解析出节与条号（解析挂了，下面的检查就成了空转）', () => {
	const sections = sectionsOf()
	assert.ok(sections.size >= 8, '节太少，解析可能挂了：' + sections.size)
	for (const [name, numbers] of sections) assert.ok(numbers.size > 0, `第 ${name} 节没有解析出任何条号`)
	assert.ok(sections.has('看板纪律') && sections.has('验收、复核、放行') && sections.has('怎么派活'), '关键节名要能解析到：' + [...sections.keys()].join(' / '))
})

test('每一处《节名》第 N 条 都能在契约层解析到（编号重排后必须同步）', () => {
	const sections = sectionsOf()
	const rules = ruleFileNames()
	const broken = []
	let checked = 0
	for (const file of corpusOf()) {
		const lines = readFileSync(file, 'utf8').split('\n')
		lines.forEach((line, index) => {
			POINTER.lastIndex = 0
			let matched
			while ((matched = POINTER.exec(line)) !== null) {
				const [, name, number] = matched
				if (META_NAMES.has(name)) continue
				if (rules.has(name)) continue
				const numbers = sections.get(name)
				if (numbers === undefined) {
					broken.push(`${file.slice(ROOT.length + 1)}:${index + 1} 《${name}》第 ${number} 条 —— 契约层没有这一节`)
					continue
				}
				checked += 1
				if (!numbers.has(number)) {
					broken.push(`${file.slice(ROOT.length + 1)}:${index + 1} 《${name}》第 ${number} 条 —— 该节只有 ${[...numbers].join('/')}`)
				}
			}
		})
	}
	assert.ok(checked >= 20, '扫到的条款指针太少（检查可能失效）：' + checked)
	assert.deepEqual(broken, [], '这些回指对不上契约层：\n' + broken.join('\n'))
})

test('条款引用一律写《》，不许用「」绕过检查', () => {
	const broken = []
	for (const file of corpusOf()) {
		if (file.startsWith(join(ROOT, 'lib'))) continue
		readFileSync(file, 'utf8')
			.split('\n')
			.forEach((line, index) => {
				const matched = /「[^」]{1,20}」\s*第\s*[0-9]+\s*条/.exec(line)
				if (matched !== null) broken.push(`${file.slice(ROOT.length + 1)}:${index + 1} ${matched[0]}`)
			})
	}
	assert.deepEqual(broken, [], '这些条款引用用了「」，检查扫不到：\n' + broken.join('\n'))
})
