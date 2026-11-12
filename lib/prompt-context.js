/**
 * 提示词增强的**项目上下文组装**（L1 项目快照 / L1 进展待办 / L2 最近对话 / L3 代码线索）。
 *
 * 为什么需要它：人要把「润色」改成「提示词增强」——把模糊输入结合**当前项目的推进情况**补成
 * 具体、可执行的请求。只把输入框那一句发给模型，模型不知道"下一步"该往哪走；上下文必须由宿主
 * 组装好再交给模型。
 *
 * 边界（人的口径 + 隐私）：
 *   · 只读：不写工作区、不落盘、不改任何状态；
 *   · **不读文件正文**（git 只给路径/提交标题/改动清单），不读 `.env`、密钥、工具输出；
 *   · 最近对话只取 user / assistant 的**纯文本**，各截 300 字、最多 6 条，工具调用与结果一律丢；
 *   · 总预算 6KB 封顶，按行边界截断并如实标注"已截断"；
 *   · git 调用与文件读取可注入（自检用假实现，不依赖真实仓库）。
 */

import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 整个上下文文本的字符上限（≈3k tokens）。 */
export const CONTEXT_MAX_CHARS = 6000
/** 最近对话条数与每条截断字数。 */
const CONVERSATION_COUNT = 6
const CONVERSATION_ITEM_CHARS = 300
/** 最近检查点份数、每份「未决 / 下一步」各取几条。 */
const CHECKPOINT_COUNT = 5
const CHECKPOINT_ITEM_CHARS = 160
/** git 提交条数、工作区改动摘要行数、代码线索条数。 */
const COMMIT_COUNT = 5
const STATUS_LINES = 20
const FILE_HINTS = 10

/**
 * 真实 git 调用（异步、带超时；失败一律给空串 —— 上下文缺层不影响主流程）。
 * @param {string[]} args - git 参数。
 * @param {string} cwd - 工作目录。
 * @returns {Promise<string>} 标准输出（去首尾空白）。
 */
export async function runGitReal(args, cwd) {
	try {
		const result = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 2000, maxBuffer: 512 * 1024 })
		return typeof result.stdout === 'string' ? result.stdout.trim() : ''
	} catch {
		return ''
	}
}

/** 默认文件读取（读不到给空串）。 */
function readTextFile(path) {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		return ''
	}
}

/** 按字数截断，超长加省略号。 */
function clip(value, limit) {
	const source = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
	return source.length > limit ? source.slice(0, limit) + '…' : source
}

/**
 * 从一条会话事件里取纯文本（容忍几种消息形状；取不到给空串）。
 * @param {object} event - 会话事件。
 * @returns {string} 文本。
 */
export function messageTextOf(event) {
	const data = event !== null && typeof event === 'object' ? event.data : undefined
	const source = data !== null && typeof data === 'object' ? data : {}
	const message = source.message !== null && typeof source.message === 'object' ? source.message : source
	const content = message.content
	if (typeof content === 'string') return content.trim()
	if (Array.isArray(content)) {
		return content
			.filter((part) => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
			.map((part) => part.text)
			.join(' ')
			.trim()
	}
	if (typeof source.text === 'string') return source.text.trim()
	return ''
}

/**
 * 取最近几条 user / assistant 消息（只纯文本；工具输出不在 message 文本里）。
 * @param {object} session - 会话对象（`snapshotEvents` 可能不存在）。
 * @param {number} count - 取几条。
 * @returns {Array<{ role: string, text: string }>} 按时间正序。
 */
export function recentMessagesOf(session, count = CONVERSATION_COUNT) {
	let events = []
	try {
		events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
	} catch {
		events = []
	}
	if (!Array.isArray(events)) return []
	const picked = []
	for (let i = events.length - 1; i >= 0 && picked.length < count; i -= 1) {
		const event = events[i]
		const type = event !== null && typeof event === 'object' ? event.type : ''
		const role = type === 'user/message' ? '用户' : type === 'assistant/message' ? '助手' : ''
		if (role === '') continue
		const text = messageTextOf(event)
		if (text === '') continue
		picked.push({ role, text: clip(text, CONVERSATION_ITEM_CHARS) })
	}
	return picked.reverse()
}

/** 从 Markdown 里取某个二级标题下的列表项（`### 未决` / `### 下一步`）。 */
function listSectionOf(markdown, heading) {
	const lines = String(markdown ?? '').split('\n')
	const out = []
	let inside = false
	for (const line of lines) {
		if (/^#{2,4}\s/.test(line)) {
			inside = line.replace(/^#{2,4}\s+/, '').trim() === heading
			continue
		}
		if (!inside) continue
		const item = line.replace(/^\s*[-*]\s+/, '').trim()
		if (item !== '' && !/^#{2,4}\s/.test(line)) out.push(clip(item, CHECKPOINT_ITEM_CHARS))
	}
	return out
}

/**
 * 组装提示词增强的项目上下文。
 * @param {object} input - `{ workspace, input, session, runGit, readFile }`。
 * @returns {Promise<{ text: string, chars: number, layers: string[] }>} 上下文文本、字数、包含的层名。
 */
export async function buildPromptContext({ workspace, input, session, runGit = runGitReal, readFile = readTextFile } = {}) {
	const workspacePath = typeof workspace === 'string' && workspace.trim() !== '' ? resolve(workspace.trim()) : ''
	const layers = []
	const blocks = []
	const draft = String(input ?? '').trim()
	// 短草稿不塞项目快照：版本 / 分支 / 最近提交会压过一句「把面板改一下」，且大多与请求无关。
	const shortDraft = draft.length < 30
	// 「下一步」支只给任务标题 + 计数；把检查点的「未决 / 下一步」原文喂进去，模型会逐条抄成请求。
	const nextStepMode = /(?:下一步|接下来).{0,6}(?:做什么|怎么办|咋办|怎么走|如何|干嘛)|what(?:\s+is|\s*'s)?\s+next/i.test(draft)

	/* ── L1 项目快照 ── */
	if (workspacePath !== '' && !shortDraft) {
		// **不把绝对工作区路径写进上下文**：请求就在这个项目会话里发出，助手的工作目录已经是它；
		// 写进去只会被模型抄进改写结果（换机器/换会话就失效），不增加任何约束。
		const lines = []
		const manifest = readFile(join(workspacePath, 'package.json'))
		try {
			const version = manifest === '' ? '' : JSON.parse(manifest).version
			if (typeof version === 'string' && version !== '') lines.push(`版本：${version}`)
		} catch {
			/* package.json 不是 JSON：不装作有版本 */
		}
		const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], workspacePath)
		if (branch !== '') lines.push(`分支：${branch}`)
		const commits = await runGit(['log', '-5', '--pretty=format:%s'], workspacePath)
		if (commits !== '') lines.push('最近提交：' + commits.split('\n').slice(0, COMMIT_COUNT).map((line, index) => '\n  ' + (index + 1) + '. ' + clip(line, 100)).join(''))
		const status = await runGit(['status', '--porcelain', '-uall'], workspacePath)
		if (status !== '') {
			const rows = status.split('\n').filter((line) => line.trim() !== '')
			const shown = rows.slice(0, STATUS_LINES).map((line) => '  ' + clip(line, 120)).join('\n')
			lines.push(`工作区改动：${rows.length} 项${rows.length > STATUS_LINES ? '（只列前 ' + STATUS_LINES + ' 项）' : ''}\n${shown}`)
		}
		if (lines.length > 0) blocks.push({ layer: '项目', text: lines.join('\n') })
	}

	/* ── L1 进展：只给未完成任务；「下一步」支只给标题 + 计数 ── */
	if (workspacePath !== '') {
		const parts = []
		let tasks = []
		let asOf = ''
		try {
			const handoff = JSON.parse(readFile(join(workspacePath, '.ops', 'handoff.json')) || '{}')
			tasks = handoff !== null && typeof handoff === 'object' && Array.isArray(handoff.tasks) ? handoff.tasks : []
			asOf = typeof handoff?.at === 'string' && handoff.at !== '' ? handoff.at.slice(0, 16).replace('T', ' ') : ''
		} catch {
			/* 交接快照读不到：这一层不说"没有任务" */
		}
		const completedIds = new Set(tasks.filter((task) => task?.status === 'completed').map((task) => String(task?.id ?? '')))
		const active = tasks.filter((task) => task?.status !== 'completed')
		if (tasks.length > 0) {
			const head = '看板' + (asOf === '' ? '' : '（截至 ' + asOf + '）') + '：已完成 ' + completedIds.size + ' / 进行中 ' + active.length
			const lines = active.slice(0, 5).map((task) => {
				const id = clip(task?.id, 24)
				const status = clip(task?.status, 12)
				const subject = clip(task?.subject, 80)
				return '\n  - ' + id + ' [' + status + '] ' + subject
			})
			parts.push(head + lines.join(''))
		}
		if (!nextStepMode) {
			try {
				const dir = join(workspacePath, 'docs', 'team', 'checkpoints')
				const files = readdirSync(dir)
					.filter((name) => name.endsWith('.md'))
					.map((name) => {
						const path = join(dir, name)
						let mtime = 0
						try {
							mtime = statSync(path).mtimeMs
						} catch {
							mtime = 0
						}
						return { name, path, mtime }
					})
					.sort((left, right) => right.mtime - left.mtime)
					.slice(0, CHECKPOINT_COUNT)
				const entries = []
				for (const file of files) {
					const taskId = /^(task-\d+)--/.exec(file.name)?.[1] ?? ''
					if (taskId !== '' && completedIds.has(taskId)) continue
					const markdown = readFile(file.path)
					const open = listSectionOf(markdown, '未决')
					const next = listSectionOf(markdown, '下一步')
					if (open.length === 0 && next.length === 0) continue
					const date = file.mtime > 0 ? new Date(file.mtime).toISOString().slice(0, 10) : ''
					const lines = []
					if (open.length > 0) lines.push('  未决：' + open.slice(0, 3).join('；'))
					if (next.length > 0) lines.push('  下一步：' + next.slice(0, 3).join('；'))
					entries.push('\n- ' + file.name.replace(/\.md$/, '') + (date === '' ? '' : '（截至 ' + date + '）') + '\n' + lines.join('\n'))
				}
				if (entries.length > 0) parts.push('最近检查点：' + entries.join(''))
			} catch {
				/* 检查点目录不存在：正常（还没写过检查点） */
			}
		}
		if (parts.length > 0) blocks.push({ layer: '进展', text: parts.join('\n') })
	}

	/* ── L2 最近对话（只纯文本；L2 是"下一步"不脱线的关键） ── */
	const messages = recentMessagesOf(session)
	if (messages.length > 0) {
		blocks.push({ layer: '对话', text: '最近对话（由旧到新）：\n' + messages.map((item) => '- ' + item.role + '：' + item.text).join('\n') })
	}

	/* ── L3 代码线索：只在输入里出现具体名词时，给匹配到的路径（不给文件内容） ── */
	const tokens = [...new Set((String(input ?? '').match(/[A-Za-z][A-Za-z0-9_.-]{2,}|[\u4e00-\u9fa5]{2,4}/g) ?? []).slice(0, 8))]
	if (workspacePath !== '' && tokens.length > 0) {
		const listing = await runGit(['ls-files'], workspacePath)
		if (listing !== '') {
			const files = listing
				.split('\n')
				.filter((path) => {
					const lower = path.toLowerCase()
					return tokens.some((token) => lower.includes(token.toLowerCase()))
				})
				.slice(0, FILE_HINTS)
			if (files.length > 0) blocks.push({ layer: '代码线索', text: '可能相关的文件：\n' + files.map((path) => '- ' + path).join('\n') })
		}
	}

	const text = blocks.map((block) => '【' + block.layer + '】\n' + block.text).join('\n\n')
	let bounded = text
	if (bounded.length > CONTEXT_MAX_CHARS) {
		bounded = bounded.slice(0, CONTEXT_MAX_CHARS)
		const cut = bounded.lastIndexOf('\n')
		bounded = (cut > 0 ? bounded.slice(0, cut) : bounded) + '\n…（上下文已截断）'
	}
	return { text: bounded, chars: bounded.length, layers: blocks.map((block) => block.layer) }
}
