#!/usr/bin/env node
/**
 * 本机调试发布（本地 tarball + profile 安装）—— README「附：本机调试用本地 tarball」四步的固化；
 * **不是正式安装方式**，正式安装与升级走 git 源。
 *
 * 为什么要有它：改包时想在本机先验当前工作树的改动、又不想先 push 到远端 —— 就把当前树打成 tarball
 * 临时装进 profile（依赖临时指向 `~/.dsh/team-ops/dsh-team-ops-<版本>.tgz`）；git push 只更新仓库，
 * 不会动这份本地副本。这个脚本按顺序做四步，并在最后核对安装副本的版本；验完把依赖改回 git 源。
 *
 * 用法（在仓库根跑）：
 *   npm run release:local -- --dry-run     # 只打印计划，不写任何文件
 *   npm run release:local                  # 打包 → 改 profile 依赖 → pnpm 11 安装 → 校验
 *
 * 可覆盖的路径：
 *   --profile <dir>      默认 ~/.dsh/profiles/desktop
 *   --tarball-dir <dir>  默认 ~/.dsh/team-ops
 *   --node <path>        DSH 自带的 node（默认 ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node）
 *   --pnpm <path>        DSH 自带的 pnpm.mjs（同上 dependencies/pnpm/bin/pnpm.mjs）
 *
 * 不改仓库版本号（版本读 package.json）；不打印令牌；失败即非零退出。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)

function flagValue(name) {
	const at = argv.indexOf(name)
	if (at === -1) return undefined
	const next = argv[at + 1]
	return next === undefined || next.startsWith('--') ? undefined : next
}

function usage(reason) {
	if (reason !== undefined) console.error('[release-local] ' + reason)
	console.error(
		[
			'用法：node scripts/release-local.mjs [--dry-run] [--profile <dir>] [--tarball-dir <dir>] [--node <path>] [--pnpm <path>]',
			'  默认：profile=~/.dsh/profiles/desktop，tarball-dir=~/.dsh/team-ops',
			'  先跑 --dry-run 看计划；它不写任何文件。',
		].join('\n'),
	)
	process.exit(reason === undefined ? 0 : 2)
}

if (argv.includes('--help') || argv.includes('-h')) usage()

const dryRun = argv.includes('--dry-run')
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = homedir()
const profileDir = resolve(flagValue('--profile') ?? join(home, '.dsh', 'profiles', 'desktop'))
const tarballDir = resolve(flagValue('--tarball-dir') ?? join(home, '.dsh', 'team-ops'))
const runtimeDeps = join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies')
const nodePath = resolve(flagValue('--node') ?? join(runtimeDeps, 'node', 'bin', 'node'))
const pnpmPath = resolve(flagValue('--pnpm') ?? join(runtimeDeps, 'pnpm', 'bin', 'pnpm.mjs'))

function fail(message) {
	console.error('[release-local] 失败：' + message)
	process.exit(1)
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch (error) {
		fail('读不了 ' + path + '：' + String(error?.message ?? error))
	}
}

const repoPackage = readJson(join(repoRoot, 'package.json'))
const version = typeof repoPackage.version === 'string' ? repoPackage.version : ''
if (version === '') fail('仓库 package.json 里没有 version')
const tarballName = 'dsh-team-ops-' + version + '.tgz'
const tarballPath = join(tarballDir, tarballName)
const profilePackagePath = join(profileDir, 'package.json')
const profilePackage = readJson(profilePackagePath)
const dependency = profilePackage?.dependencies?.['dsh-team-ops']
if (typeof dependency !== 'string' || dependency === '') {
	fail('profile 的 dependencies 里没有 dsh-team-ops：先按 README「装」一节装一次，再回来用这个脚本')
}

const cacheDir = join(tmpdir(), 'dsh-team-ops-npm-cache')
const logsDir = join(tmpdir(), 'dsh-team-ops-npm-logs')
const npmArgs = ['pack', '--pack-destination', tarballDir]
const pnpmArgs = [pnpmPath, 'install']

const plan = [
	'1) 打包：npm ' + npmArgs.join(' ') + '（cwd ' + repoRoot + '；缓存用 ' + cacheDir + '）',
	'2) 改依赖：' + profilePackagePath + ' 的 dsh-team-ops → file:' + tarballPath,
	'3) 安装：' + nodePath + ' ' + pnpmArgs.join(' ') + '（cwd ' + profileDir + '）',
	'4) 校验：' + join(profileDir, 'node_modules', 'dsh-team-ops', 'package.json') + ' 的 version == ' + version,
]

console.log('[release-local] 版本 ' + version)
console.log('[release-local] ' + (dryRun ? '计划（dry-run，不写文件）：' : '开始：'))
for (const line of plan) console.log('  ' + line)

if (dryRun) {
	for (const [label, path] of [['node', nodePath], ['pnpm', pnpmPath]]) {
		if (!existsSync(path)) console.log('[release-local] 提示：' + label + ' 不存在（真实执行会失败，可用 --' + label + ' 指定）：' + path)
	}
	if (!existsSync(tarballDir)) console.log('[release-local] 提示：tarball 目录不存在，真实执行会创建：' + tarballDir)
	console.log('[dry-run] 未写任何文件。')
	process.exit(0)
}

if (!existsSync(nodePath)) fail('DSH 自带的 node 不存在：' + nodePath + '（用 --node 指定）')
if (!existsSync(pnpmPath)) fail('DSH 自带的 pnpm.mjs 不存在：' + pnpmPath + '（用 --pnpm 指定）')

mkdirSync(tarballDir, { recursive: true })
mkdirSync(cacheDir, { recursive: true })
mkdirSync(logsDir, { recursive: true })
const packed = spawnSync('npm', npmArgs, {
	cwd: repoRoot,
	stdio: 'inherit',
	env: { ...process.env, npm_config_cache: cacheDir, npm_config_logs_dir: logsDir },
})
if (packed.status !== 0) fail('npm pack 退出码 ' + packed.status)
if (!existsSync(tarballPath)) fail('打包后没有找到 ' + tarballPath)

const packageText = readFileSync(profilePackagePath, 'utf8')
const dependencyPattern = /("dsh-team-ops"\s*:\s*)"[^"]*"/
if (!dependencyPattern.test(packageText)) fail('profile 的 package.json 里找不到 dsh-team-ops 依赖行：' + profilePackagePath)
const nextPackageText = packageText.replace(dependencyPattern, '$1"file:' + tarballPath + '"')
if (nextPackageText === packageText && !packageText.includes('"file:' + tarballPath + '"')) {
	fail('profile 依赖没有被改成 ' + tarballPath)
}
const tempPackagePath = profilePackagePath + '.tmp-release-local'
writeFileSync(tempPackagePath, nextPackageText, 'utf8')
renameSync(tempPackagePath, profilePackagePath)
console.log('[release-local] 已把 profile 依赖指向 ' + tarballPath)

const installed = spawnSync(nodePath, pnpmArgs, { cwd: profileDir, stdio: 'inherit', env: process.env })
if (installed.status !== 0) fail('pnpm install 退出码 ' + installed.status)

const installedPackagePath = join(profileDir, 'node_modules', 'dsh-team-ops', 'package.json')
const installedVersion = existsSync(installedPackagePath) ? readJson(installedPackagePath).version : ''
if (installedVersion !== version) {
	fail('安装副本版本 ' + JSON.stringify(installedVersion) + ' != 仓库版本 ' + version + '（检查 profile 依赖与 pnpm 输出）')
}
console.log('[release-local] 完成：安装副本版本 ' + installedVersion + ' 与仓库一致。')
console.log('[release-local] 下一步：重启 DSH（启动日志 / 注入段应显示新版本）。')
