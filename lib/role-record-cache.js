/**
 * 现场角色枚举的**读缓存** —— 按 ROLE.md 的文件签名复用解析结果。
 *
 * 为什么单独一层：名册是"现场枚举"（加一个目录就多一个角色），但一次枚举要读遍所有
 * ROLE.md、解析 front-matter、截正文、再看头像文件。面板一次请求、一次工具调用里往往还要
 * 枚举两三遍，代价全花在没变过的文件上。这里把它变成：
 *   · 目录列表每轮现读 ⇒ **增删角色立刻可见**；
 *   · 文件内容按 mtimeNs / ctimeNs / size / ino 判定 ⇒ **改了立刻可见**；
 *   · 目录签名一起判 ⇒ 角色目录里**新增自定义头像**也立刻可见（否则要等 ROLE.md 改动）；
 *   · 命中就复用上一次解析好的记录，连头像文件的 stat 都不再做。
 *
 * 一致性边界：进程内、按 `{root, source, id}` 缓存；写盘方可以调 {@link invalidateRoleRecords}
 * 显式清一次（不调也会在下一轮被签名自愈）。返回的记录是副本，调用方改动不污染缓存。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 角色定义只有这一个形态（与 lib/roster.js 的 ROLE_FILE 同一约定）。 */
const ROLE_FILE = 'ROLE.md'

/** 缓存条数上限：工作区多了也不会无界增长；到顶整表清一次，只是下一轮多读一遍。 */
const CACHE_MAX = 512

/** `${root}\0${source}\0${id}` → `{ stamp, record }`。 */
const cache = new Map()

/**
 * 一份 ROLE.md 的签名。用纳秒级 mtime + ctime + 尺寸 + inode，
 * 而不是只看 mtimeMs：同一毫秒内改同尺寸的文件也必须能看出来。
 * @returns {string|null} null = 文件不在或 stat 不成（和原来的"跳过这个目录"同义）。
 */
function stampOf(file) {
	try {
		const stat = statSync(file, { bigint: true })
		return `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.ino}`
	} catch {
		return null
	}
}

/** 清掉缓存。角色定义写盘后调用；不调用也能靠签名自愈。 */
export function invalidateRoleRecords() {
	cache.clear()
}

/**
 * 枚举 `[{root, source}]` 里的角色记录；同 id 时**先列的根胜**。
 * @param roots - 角色根列表，按优先级排列。
 * @param build - `({ id, dir, file, root, source, text }) => record`，只在缓存未命中时调。
 * @returns 记录数组的副本（调用方可安全修改）。
 */
export function readRoleRecords(roots, build) {
	const byId = new Map()
	for (const { root, source } of roots) {
		let entries
		try {
			entries = readdirSync(root, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.') || byId.has(entry.name)) continue
			const dir = join(root, entry.name)
			const file = join(dir, ROLE_FILE)
			const fileStamp = stampOf(file)
			if (fileStamp === null) continue
			const stamp = `${fileStamp}|${stampOf(dir)}`
			const key = `${root}\0${source}\0${entry.name}`
			let hit = cache.get(key)
			if (hit === undefined || hit.stamp !== stamp) {
				let text
				try {
					text = readFileSync(file, 'utf8')
				} catch {
					continue
				}
				if (cache.size >= CACHE_MAX) cache.clear()
				hit = { stamp, record: build({ id: entry.name, dir, file, root, source, text }) }
				cache.set(key, hit)
			}
			// 浅拷贝 + 数组另起一份：调用方改记录 / 改 skills 都不会改到缓存里那份。
			byId.set(entry.name, { ...hit.record, skills: [...hit.record.skills] })
		}
	}
	return [...byId.values()]
}
