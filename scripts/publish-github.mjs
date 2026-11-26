#!/usr/bin/env node
/**
 * **把「纯代码树」发布到 GitHub** —— 本机 `github.com:443` 反复间歇不通时的那条后路。
 *
 * 为什么需要它：本仓库有两条足迹。Gitea 是**全量**（含 `docs/` 内部文档与真实提交历史）；
 * GitHub 是**公开代码面** —— 只放插件本体、单条基线提交、历史里不带 `docs/`。
 * 平时用 `git push` 就够；但这条链路在本机实测反复出现 `Failed to connect ... 443` /
 * `HTTP2 framing layer`，而 `api.github.com` 一直是通的。于是这条脚本走 REST API：
 * 逐文件建 blob → 建树 → 建一条**无父提交** → 强制更新 `main`，效果与 `git push --force` 相同。
 *
 * 三条硬规矩：
 *   · **判定不另写一份**：排除哪些路径由 `EXCLUDED` 一处决定（当前只有 `docs/`），
 *     期望的树 SHA 用 `git read-tree` / `git write-tree` 在本地算出来，推送后与远端返回的树 SHA **必须相等**；
 *   · **令牌不进代码、不进输出**：从 `GITHUB_TOKEN` 或钥匙串（`git credential-osxkeychain`）取；
 *   · **默认不做事**：远端树已经是这棵就跳过（`--force` 才重发），`--dry-run` 一次网络请求都不发。
 *
 * 用法（在仓库根跑）：
 *
 *   npm run publish:github                 # 发布 HEAD（已是最新则跳过）
 *   npm run publish:github -- --dry-run    # 只算本地：要发哪些文件、树 SHA 是多少
 *   npm run publish:github -- --from <ref> --message "自定义提交说明"
 *   npm run publish:github -- --force      # 远端已是同一棵树也重发一条提交
 *
 * 退出码：0 = 已发布 / 已是最新 / 试运行；1 = 失败（原因已印出）；2 = 用法错。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 不进公开树的路径前缀（**唯一一处**：判定与展示都读它）。 */
const EXCLUDED = ['docs/']

const argv = process.argv.slice(2)

/** 取一个 `--flag value` 形式的值；没有就给 undefined。 */
function flagValue(name) {
	const at = argv.indexOf(name)
	if (at === -1) return undefined
	const next = argv[at + 1]
	return next === undefined || next.startsWith('--') ? undefined : next
}

function usage(reason) {
	if (reason !== undefined) console.error(`[publish-github] ${reason}`)
	console.error(
		[
			'用法：node scripts/publish-github.mjs [--from <ref>] [--repo <owner/name>] [--message <文本>] [--dry-run] [--force]',
			'  令牌：环境变量 GITHUB_TOKEN，或本机钥匙串里 github.com 那条（git credential-osxkeychain）',
		].join('\n'),
	)
	process.exit(2)
}

if (argv.includes('--help') || argv.includes('-h')) usage()

// **参数形状先判**：`--repo` 写错不该等到"算完树、发完请求"才报出来（试运行也要当场拒）。
if (flagValue('--repo') !== undefined) repoOf()

/** 跑一条 git 命令；失败就带着它的 stderr 退出（不吞错）。 */
function git(args, options = {}) {
	const result = spawnSync('git', args, { encoding: options.encoding ?? 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...(options.env ?? {}) } })
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} 失败：${(result.stderr ?? '').trim() || `退出码 ${result.status}`}`)
	}
	return result.stdout
}

/** `owner/name`：`--repo` 优先，其次远程 `github` 的 URL。 */
function repoOf() {
	const explicit = flagValue('--repo')
	if (explicit !== undefined) {
		const match = /^([^/\s]+)\/([^/\s]+)$/.exec(explicit.trim())
		if (match === null) usage(`--repo 要写成 owner/name（收到 ${explicit}）`)
		return { owner: match[1], name: match[2].replace(/\.git$/, '') }
	}
	let url = ''
	try {
		url = git(['remote', 'get-url', 'github']).trim()
	} catch {
		usage('没找到远程 `github`，也没给 --repo：先 `git remote add github https://github.com/<owner>/<name>.git`')
	}
	const match = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
	if (match === null) usage(`远程 github 的地址认不出：${url}（用 --repo owner/name 直接指定）`)
	return { owner: match[1], name: match[2] }
}

/** 令牌：环境变量优先，其次钥匙串。**只在这个进程里用，不打印**。 */
function tokenOf() {
	const fromEnv = typeof process.env.GITHUB_TOKEN === 'string' ? process.env.GITHUB_TOKEN.trim() : ''
	if (fromEnv !== '') return fromEnv
	const result = spawnSync('git', ['credential-osxkeychain', 'get'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
	const line = (result.stdout ?? '').split('\n').find((entry) => entry.startsWith('password='))
	if (line === undefined) usage('取不到 GitHub 令牌：设 GITHUB_TOKEN，或让钥匙串里存一条 github.com 的凭据')
	return line.slice('password='.length)
}

/**
 * 在本地算出**要发布的那棵树**：`HEAD` 读进临时索引、删掉 `EXCLUDED`、写出树对象。
 *
 * 为什么在本地算：推完之后要拿它跟远端返回的树 SHA 比 —— 只比"接口回 200"是证明不了内容一致的。
 * @param from - 提交 / 引用。
 * @returns `{ treeSha, files }`，`files` 是 `{ path, mode, sha }`。
 */
function publishedTreeOf(from) {
	const commit = git(['rev-parse', '--verify', `${from}^{commit}`]).trim()
	const index = join(mkdtempSync(join(tmpdir(), 'publish-github-index-')), 'index')
	const env = { GIT_INDEX_FILE: index }
	try {
		git(['read-tree', commit], { env })
		for (const prefix of EXCLUDED) git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', prefix], { env })
		const treeSha = git(['write-tree'], { env }).trim()
		const listing = git(['ls-tree', '-r', treeSha])
			.trim()
			.split('\n')
			.filter((line) => line !== '')
			.map((line) => {
				const [meta, path] = line.split('\t')
				const [mode, , sha] = meta.split(' ')
				return { path, mode, sha }
			})
		return { commit, treeSha, files: listing }
	} finally {
		rmSync(index, { force: true })
	}
}

/** 一次 REST 调用；网络或 5xx 重试三次，4xx 直接报出可读原因。 */
async function call(method, url, token, payload) {
	let lastError = ''
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			const response = await fetch(url, {
				method,
				headers: {
					authorization: `token ${token}`,
					accept: 'application/vnd.github+json',
					'content-type': 'application/json',
					'user-agent': 'dsh-team-ops-publish',
				},
				body: payload === undefined ? undefined : JSON.stringify(payload),
				signal: AbortSignal.timeout(60_000),
			})
			const text = await response.text()
			const body = text.trim() === '' ? {} : JSON.parse(text)
			if (response.ok) return body
			if (response.status >= 500 && attempt < 3) {
				lastError = `${response.status} ${text.slice(0, 200)}`
			} else {
				throw new Error(`${method} ${url} → ${response.status}：${text.slice(0, 300)}`)
			}
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error)
			if (!(error instanceof Error) || !/fetch failed|timeout|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(error.message) || attempt === 3) throw error
		}
		await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
	}
	throw new Error(lastError)
}

const from = flagValue('--from') ?? 'HEAD'
const dryRun = argv.includes('--dry-run')
const force = argv.includes('--force')

let published
try {
	published = publishedTreeOf(from)
} catch (error) {
	console.error(`[publish-github]（未通过） ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
}

const included = published.files
console.log(`[publish-github] 来源 ${published.commit.slice(0, 7)}：发布 ${included.length} 个文件，排除 ${EXCLUDED.join('、')}`)
console.log(`[publish-github] 期望树 SHA：${published.treeSha}`)
if (included.some((file) => EXCLUDED.some((prefix) => file.path.startsWith(prefix)))) {
	console.error('[publish-github]（未通过） 发布面里仍含被排除的路径 —— 判定漏了，停下来')
	process.exit(1)
}

if (dryRun) {
	for (const file of included) console.log(`  ${file.path}`)
	console.log('[publish-github] 试运行：没有发出任何网络请求。')
	process.exit(0)
}

const { owner, name } = repoOf()
const token = tokenOf()
const base = `https://api.github.com/repos/${owner}/${name}`

try {
	// 远端已经是这棵树 ⇒ 默认什么都不做（`--force` 才重发一条）。
	const ref = await call('GET', `${base}/git/ref/heads/main`, token).catch(() => null)
	if (ref !== null && ref.object?.sha !== undefined) {
		const remoteCommit = await call('GET', `${base}/git/commits/${ref.object.sha}`, token)
		if (remoteCommit.tree?.sha === published.treeSha && !force) {
			console.log(`[publish-github] 远端已经是这棵树（${published.treeSha.slice(0, 7)}），跳过。要重发加 --force。`)
			process.exit(0)
		}
	}

	const entries = []
	for (const file of included) {
		const content = spawnSync('git', ['cat-file', '-p', file.sha], { maxBuffer: 64 * 1024 * 1024 }).stdout
		const blob = await call('POST', `${base}/git/blobs`, token, { content: content.toString('base64'), encoding: 'base64' })
		entries.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha })
	}
	console.log(`[publish-github] 已上传 ${entries.length} 个 blob`)

	const tree = await call('POST', `${base}/git/trees`, token, { tree: entries })
	if (tree.sha !== published.treeSha) {
		throw new Error(`远端树 SHA 与本地算的不一致：远端 ${tree.sha}，本地 ${published.treeSha} —— 内容对不上，已停在改 ref 之前`)
	}
	console.log(`[publish-github] 远端树与本地一致：${tree.sha}`)

	const message = flagValue('--message') ?? git(['log', '-1', '--format=%B', published.commit]).trim()
	const commit = await call('POST', `${base}/git/commits`, token, {
		message,
		tree: tree.sha,
		parents: [],
		author: { name: 'YaoYC', email: 'tinton@msn.cn' },
		committer: { name: 'YaoYC', email: 'tinton@msn.cn' },
	})
	console.log(`[publish-github] 新提交：${commit.sha}`)

	const updated = await call('PATCH', `${base}/git/refs/heads/main`, token, { sha: commit.sha, force: true })
	const final = updated.object?.sha ?? commit.sha
	console.log(`[publish-github] 已更新 main → ${final}`)
	console.log('[publish-github] 完成：GitHub 侧仍是「纯代码、单条基线」，内容与本地发布树逐字节一致。')
} catch (error) {
	console.error(`[publish-github]（未通过） ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
}
