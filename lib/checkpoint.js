/**
 * 检查点（checkpoint）—— 压缩/收口之前的**落点**。
 *
 * 两块用途，两块都只写工作区：
 *   1. **结构化检查点**：成员/协调者主动写的关键结论，落在
 *      `docs/team/checkpoints/<task>--<会话短标签>.md`（可提交、人可读；append-only，超过上限轮转）。
 *      **必须按会话隔离**：原生任务编号只在会话内唯一（`TeamId = SessionId`），只按 task 命名会让
 *      两个会话的 `task-1` 混进同一个文件（见 `docs/design/design-checkpoint-session-001.md`）。
 *   2. **压缩检查点**：DSH 自动压缩时由 `lib/session-watch.js` 落的原始转储，落在
 *      `.ops/checkpoints/compaction/<session>/<compaction>.md`（派生、可删、gitignore）。
 *
 * 硬边界：
 *   · 只写在给定工作区根下；任务编号先过形状（`task-<数字>`）再拼路径；
 *   · 路径必须 stay-inside：字面 `..` / 绝对路径先拒，写入前再用 `realpath` 查一次符号链接逃逸；
 *   · 同一条路径的读-改-写**串行**（同一毫秒并发不会丢节，也不会因 tmp 撞名 ENOENT）；
 *   · 上限按**字节**算（CJK 不会被字符 slice 放大）；首建与轮转走原子写（tmp + rename），
 *     日常追加走 `O_APPEND`（同一路径已串行，不会互相覆盖）。
 */
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** 结构化检查点的目录（工作区相对）：可提交、人可读。 */
export const CHECKPOINTS_DIR = join('docs', 'team', 'checkpoints')
/** 压缩检查点的目录（工作区相对）：派生、可删。 */
export const COMPACTION_DIR = join('.ops', 'checkpoints', 'compaction')

/** 单个检查点文件的上限；结构化文件轮转，压缩文件截断。 */
export const CHECKPOINT_MAX_BYTES = 512 * 1024
/** 结构化检查点保留几份轮转（`.md` + `.1.md` + `.2.md`）。 */
export const CHECKPOINT_ROTATIONS = 3
/** 每个会话保留几份压缩检查点。 */
export const COMPACTION_KEEP = 5
/** 列表字段最多几条（每条另有字符上限）。 */
const LIST_MAX_ITEMS = 20
/** 摘要上限（字符）。 */
const SUMMARY_MAX_CHARS = 200

/** 任务编号形状：原生给的是 `task-<数字>`。 */
const TASK_ID_RE = /^task-\d+$/
/** 会话短标签长度：session id 的 UUID 前 8 位；非 UUID 形态用 sha256 前 8 位。 */
const SESSION_TAG_LEN = 8
/** 结构化检查点文件名：`task-<数字>--<会话短标签>.md`（轮转副本不匹配）。 */
const STRUCTURED_NAME_RE = /^(task-\d+)--([0-9a-f]{8})\.md$/

/** 工作区必须是非空绝对路径。 */
function workspaceOf(workspace) {
  const text = typeof workspace === 'string' ? workspace.trim() : ''
  if (text === '' || !resolve(text).startsWith('/')) throw new Error('检查点需要一个绝对工作区路径')
  return resolve(text)
}

/** 一个路径必须在工作区里（防止 `..` 与绝对路径逃逸）。 */
function inside(workspace, path) {
  const rel = relative(workspace, resolve(path))
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('/')) throw new Error(`检查点路径越界：${path}`)
  return resolve(path)
}

/**
 * 写入前再查一次**真实路径**：目录被换成指向工作区外的符号链接时，字面 `inside()` 看不出来。
 * 只对目录做一次 realpath（文件本身用 rename 覆盖，不会顺着链接写出去）。
 */
async function assertRealInside(workspace, path) {
  const root = await realpath(workspace)
  // **先验最近的已存在祖先，再 mkdir**：父目录是指向外部的软链时，不能为了检查反而在外面建目录。
  let dir = dirname(path)
  while (true) {
    try {
      const real = await realpath(dir)
      if (real !== root && !real.startsWith(root + sep)) throw new Error(`检查点目录指向工作区外（符号链接？）：${path}`)
      break
    } catch (error) {
      if (!(error !== null && typeof error === 'object' && error.code === 'ENOENT')) throw error
      const parent = dirname(dir)
      if (parent === dir) throw new Error(`检查点目录不存在且无法解析：${path}`)
      dir = parent
    }
  }
  await mkdir(dirname(path), { recursive: true })
  const real = await realpath(dirname(path))
  if (real !== root && !real.startsWith(root + sep)) throw new Error(`检查点目录指向工作区外（符号链接？）：${path}`)
}

/** 任务编号校验：形状不对直接拒。 */
export function assertTaskId(task) {
  const text = typeof task === 'string' ? task.trim() : ''
  if (!TASK_ID_RE.test(text)) throw new Error(`检查点的任务编号要形如 task-<数字>（收到 ${JSON.stringify(task)}）`)
  return text
}

/**
 * 会话短标签：同一个会话 id 永远得到同一个 8 位 hex（确定性、无索引文件）。
 * `session-<uuid>` 取 uuid 前 8 位；其它形态用 sha256 前 8 位兜底；空串落到 `unknown-session`。
 */
export function sessionTagOf(sessionId) {
  const text = typeof sessionId === 'string' ? sessionId.trim() : ''
  const bare = text.startsWith('session-') ? text.slice('session-'.length) : text
  // **UUID 形态取前 8 位**（形如 `09299ab6-4f2b-…`）：只看 8 位 hex 后面紧跟 `-` 或结尾。
  // 不能写成 `/^[0-9a-f]{8,}$/` —— uuid 带连字符，那样会全部落到哈希兜底，文件名就不再是「会话 id 前 8 位」。
  const uuid = /^([0-9a-fA-F]{8})(?:$|-)/.exec(bare)
  if (uuid !== null) return uuid[1].toLowerCase()
  return createHash('sha256').update(text === '' ? 'unknown-session' : text).digest('hex').slice(0, SESSION_TAG_LEN)
}

/** 结构化检查点的绝对路径：`<task>--<会话短标签>.md`。 */
export function structuredPathOf(workspace, sessionId, task) {
  const root = workspaceOf(workspace)
  return inside(root, join(root, CHECKPOINTS_DIR, `${assertTaskId(task)}--${sessionTagOf(sessionId)}.md`))
}

/** 压缩检查点的绝对路径。 */
export function compactionPathOf(workspace, sessionId, compactionId) {
  const root = workspaceOf(workspace)
  const session = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'unknown-session'
  const id = typeof compactionId === 'string' && compactionId !== '' ? compactionId : 'unknown-compaction'
  // 两个 id 都来自宿主事件；压成安全文件名（只留字母数字与 ._-）。
  const safe = (value) => value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)
  return inside(root, join(root, COMPACTION_DIR, safe(session), `${safe(id)}.md`))
}

/** 一个文件在不在（不存在返回 false；其它错误照抛）。 */
export async function fileExists(path) {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return false
    throw error
  }
}

/** 读一个检查点（读不到就是读不到，不编）。 */
export async function readCheckpoint(path) {
  // **不读穿软链**：文件是指向别处的链接时，读到的是工作区外的内容（与边界声明矛盾）。
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error(`检查点文件是指向别处的符号链接，拒绝读取：${path}`)
  return await readFile(path, 'utf8')
}

/** 结构化检查点是否存在（只认当前会话那一份）。 */
export async function structuredExists(workspace, sessionId, task) {
  return await fileExists(structuredPathOf(workspace, sessionId, task))
}

/** 列表：`docs/team/checkpoints/` 下**当前会话**的检查点（按 task 升序；轮转副本不单列）。 */
export async function listStructured(workspace, sessionId) {
  const root = workspaceOf(workspace)
  const tag = sessionTagOf(sessionId)
  const dir = join(root, CHECKPOINTS_DIR)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = STRUCTURED_NAME_RE.exec(entry.name)
    if (match === null || match[2] !== tag) continue
    const path = inside(root, join(dir, entry.name))
    const info = await stat(path)
    rows.push({ task: match[1], session: tag, path, bytes: info.size, at: info.mtime.toISOString() })
  }
  return rows.sort((left, right) => left.task.localeCompare(right.task))
}

/** 原子写：tmp + rename（tmp 名带随机段，同一毫秒并发不会撞名）。 */
async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

/** 按字节上限截断一条文本（末尾保留截断标注；不静默丢）。 */
export function clampToBytes(text, limit = CHECKPOINT_MAX_BYTES) {
  const value = typeof text === 'string' ? text : String(text)
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= limit) return value
  const head = bytes.subarray(0, Math.max(0, limit - 96)).toString('utf8').replace(/\uFFFD+$/, '')
  return head + '\n\n…（超出上限，已截断）\n'
}

/** 旧名（压缩正文用）；保留一处实现，避免两套截断口径。 */
function clamp(text, limit = CHECKPOINT_MAX_BYTES) {
  return clampToBytes(text, limit)
}

/** 规格化一条列表字段：字符串数组、去空、逐条截断、条数封顶。 */
function linesOf(value, max = 120, maxItems = LIST_MAX_ITEMS) {
  if (!Array.isArray(value)) return []
  const items = value.filter((item) => typeof item === 'string' && item.trim() !== '')
  const kept = items.slice(0, maxItems).map((item) => item.trim().slice(0, max))
  // **不静默丢**：超出条数就落一行可见的省略标注。
  if (items.length > maxItems) kept.push(`…（只列前 ${maxItems} 条，共 ${items.length} 条）`)
  return kept
}

/** 按路径串行的读-改-写队列（进程内；同一毫秒并发也不会丢节）。 */
const queues = new Map()
function withQueue(key, operation) {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  const tail = next.then(() => undefined, () => undefined)
  queues.set(key, tail)
  // 排到队尾就撤掉这一条：检查点路径可以很多，队列本身不该常驻一份名单。
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return next
}

/** 结构化检查点的一节（append-only）。 */
function structuredSection({ role, task, summary, facts, decisions, artifacts, open, next }) {
  const at = new Date().toISOString()
  const list = (items) => (items.length === 0 ? '（无）' : items.map((item) => `- ${item}`).join('\n'))
  return [
    `## ${at} · ${role === '' ? '（未记角色）' : role}`,
    '',
    `- 任务：${task}`,
    `- 摘要：${summary === '' ? '（未写）' : summary}`,
    '',
    '### 事实',
    list(facts),
    '',
    '### 决定',
    list(decisions),
    '',
    '### 产物',
    list(artifacts),
    '',
    '### 未决',
    list(open),
    '',
    '### 下一步',
    list(next),
    '',
  ].join('\n')
}

/**
 * 写结构化检查点（append-only；同一路径串行）。
 *
 * 超过上限时：`.md` → `.1.md`，`.1.md` → `.2.md`（最旧的被删）；单节本身超限时先按字节截断。
 * @returns 写入后的路径。
 */
export async function appendStructured(workspace, sessionId, task, values, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : CHECKPOINT_MAX_BYTES
  const rotations = Number.isInteger(options.rotations) && options.rotations >= 1 ? options.rotations : CHECKPOINT_ROTATIONS
  const path = structuredPathOf(workspace, sessionId, task)
  return await withQueue(path, async () => {
    const role = typeof values?.role === 'string' ? values.role : ''
    const section = clamp(
      structuredSection({
        role,
        task,
        summary: typeof values?.summary === 'string' ? values.summary.trim().slice(0, SUMMARY_MAX_CHARS) : '',
        facts: linesOf(values?.facts),
        decisions: linesOf(values?.decisions),
        artifacts: linesOf(values?.artifacts, 300),
        open: linesOf(values?.open),
        next: linesOf(values?.next),
      }),
      maxBytes,
    )
    // **真追加**：只 stat 现有点大小，不再把整份（≤512KB）读出来拼一遍又全量重写。
    // 文件不存在 / 是空文件 ⇒ 这一笔要带上标题；已有内容就只追加新的一节。
    let size = 0
    try {
      size = (await stat(path)).size
    } catch (error) {
      if (!(error !== null && typeof error === 'object' && error.code === 'ENOENT')) throw error
    }
    const addition = (size === 0 ? `# ${task}\n\n` : '') + section
    await assertRealInside(workspace, path)
    if (size + Buffer.byteLength(addition, 'utf8') <= maxBytes) {
      await appendFile(path, addition, 'utf8')
      return path
    }
    // 轮转：删除最旧，再依次前移。
    for (let index = rotations - 1; index >= 1; index -= 1) {
      const from = index === 1 ? path : `${path.replace(/\.md$/, '')}.${index - 1}.md`
      const to = `${path.replace(/\.md$/, '')}.${index}.md`
      try {
        await rename(from, to)
      } catch (error) {
        if (!(error !== null && typeof error === 'object' && error.code === 'ENOENT')) throw error
      }
    }
    await writeAtomic(path, `# ${task}\n\n` + section)
    return path
  })
}

/** 压缩检查点的正文（摘要 + 被压事件的渲染）。 */
export function compactionDocument({ sessionId, role, at, summary, provider, model, shadowedRange, tokens, rendered }) {
  return clamp(
    [
      '# 自动压缩检查点',
      '',
      `- 会话：${sessionId}`,
      `- 角色：${role === '' ? '（未记）' : role}`,
      `- 时刻：${at}`,
      `- 路由：${provider === '' ? '?' : provider}/${model === '' ? '?' : model}`,
      `- 被压区间：seq ${shadowedRange?.start ?? '?'} – ${shadowedRange?.end ?? '?'}（约 ${tokens ?? '?'} tokens）`,
      '',
      '## 压缩摘要',
      '',
      summary === '' ? '（事件里没有摘要正文）' : summary,
      '',
      '## 被压掉的事件（原文）',
      '',
      clamp(rendered === '' ? '（没有可渲染的事件）' : rendered),
      '',
    ].join('\n'),
  )
}


/** 写一份压缩检查点，并按保留策略删最旧。 */
export async function writeCompactionCheckpoint(workspace, values) {
  const path = compactionPathOf(workspace, values.sessionId, values.compactionId)
  return await withQueue(path, async () => {
    await assertRealInside(workspace, path)
    await writeAtomic(path, compactionDocument(values))
    const dir = dirname(path)
    let entries = []
    try {
      entries = await readdir(dir)
    } catch (error) {
      if (!(error !== null && typeof error === 'object' && error.code === 'ENOENT')) throw error
    }
    const files = []
    for (const name of entries) {
      if (!name.endsWith('.md')) continue
      const info = await stat(join(dir, name))
      files.push({ path: join(dir, name), at: info.mtimeMs })
    }
    files.sort((left, right) => right.at - left.at)
    for (const extra of files.slice(COMPACTION_KEEP)) {
      try {
        await rm(extra.path, { force: true })
      } catch {
        /* 删失败只影响体量，不影响本次写入 */
      }
    }
    return path
  })
}
