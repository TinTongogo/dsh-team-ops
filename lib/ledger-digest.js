#!/usr/bin/env node
/**
 * 只读文件摘要 —— 把工作区里还在写的账压成**一行**中文，交给 DSH 的 hook 桥接
 * 注进会话上下文。
 *
 * 一行 = 团队指路 ｜（有才出）人的话计数 ｜（有才出）交接快照 ｜ 工作区。
 * 团队状态（成员 / 任务）在 DSH 原生 Agent Teams 里：这一段只指路
 * （`member_list` / `team_status`），不打印明细；逐条读数永远以工具面为准。
 *
 * 为什么要有它：文件是状态的唯一真相源，而引擎只写文件、**不会把变化推给任何会话**。
 * 人在两次发言之间点了批准，会话手里那份读数就已经过期，而且没有任何提示。本脚本把
 * 「当前文件长什么样」在**每次提示词提交**与**每个新会话开局**各注入一次，于是会话不必
 * 靠纪律去记得重读：状态自己进上下文。
 *
 * 状态：本脚本仍可供 `--text` / 自检直接调用，但 `cordis.patch.yml` **默认不再挂 hook 桥接** ——
 * 那一行（`team-ops-hooks`）会在 DSH boot 阶段让 web 服务认证失败，已永久摘掉。
 *
 * 性能口径：每次提交都是**一个新的短命进程**，进程内缓存命中率恒为 0。所以这里的优化只做一件
 * 事 —— **减少 syscall**：正常路径一份文件只读一次，遗留文件只判存在、"读不到"时才补一次 stat。
 *
 * 硬边界：
 *   · **只读**：不写任何文件、不改文件、不建目录、不动工作区。
 *   · **绝不拦提示词**：桥接把退出码 2 映射为阻塞，本脚本在任何路径上都退 0；
 *     内部异常一律吞掉、不输出上下文（宁可没有摘要，也不能让人一次发言被拦住）。
 *   · **读不到就说读不到**：文件缺失 / 读不成 / 解析失败一律如实写「读不到」，
 *     绝不写成「没有条目 / 看板为空」。
 *   · **不在任何情况下撑成多行**：人的要求是压成一行；来自文件的文本一律先压一行 + 截断
 *     （`fileTextShown` / `shapedShown`）—— 文件里放一个换行也伪造不出第二条读数。
 *   · **团队状态指路到原生**：成员 / 任务在 DSH 原生 Agent Teams 里（本脚本是独立 hook 进程，
 *     拿不到会话凭据，读不到原生），所以只写工具名，不印任何会过期的计数。
 *
 * 「人的话」那一段（人的决定与约束：目标 / 约束 / 偏好 / 否决理由）：
 *   · **没有内容时不占段**：状态文件不在（按需建立，没记过就是没有）或记过但一条都没有。
 *   · **有内容时只给计数 + 工具指路**（逐条正文不再展开：一行摘要放不下，`human_words_list`
 *     读到的才是同一份全文）。
 *   · **读不成时说读不到**：文件在而读不成 / JSON 坏 / `words` 不是数组 ⇒ 一句「读不到」，
 *     并写明这不等于人没说过。两档不许互相顶替。
 *
 * 用法：
 *   node ledger-digest.js [--text] [--workspace <目录>]
 *
 * 工作区解析顺序（前一个取到就用它）：
 *   1. 命令行 `--workspace <目录>`，或第一个不以 `-` 开头的参数；
 *   2. 环境变量 `DSH_TEAM_OPS_WORKSPACE`，其次 hook 桥接为每个 hook 进程设的
 *      `CLAUDE_PROJECT_DIR`（= 该会话的工作目录）；
 *   3. 当前工作目录 —— 桥接让 hook 在会话工作目录里跑，因此这就是工作区。
 *
 * 默认输出 hook 的 JSON（`hookSpecificOutput.additionalContext`，字段名沿用原 hook 桥接
 * 对外的形状；桥接已摘除，这份形状只保留给既有调用方与自检）；`--text` 输出同一段摘要的纯文本，
 * 给人看与给自检用。
 */

import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { migrateWorkspaceSync, opsFileOf } from './ops-files.js'

/** 还在写的四份：路径来源与引擎同一处（{@link opsFileOf}），不在这里另抄一份文件名。 */
const LEDGERS = {
  human: opsFileOf('human'),
  roles: opsFileOf('roles'),
  roster: opsFileOf('roster'),
  // **交接快照**：引擎在每次看板成功改动之后顺手写的**派生物**（原生看板按会话，新会话从零开始）。
  // 它**不是**实时看板 —— 渲染时要把"非实时"写在它那一段里（见 `handoffClause`）。
  handoff: opsFileOf('handoff'),
}

/** 原生三态 → 本产品的分栏名（引擎那半边有一份反向的映射 `NATIVE_STATUS_FILTERS`；两边都在自己那一侧）。 */
const NATIVE_STATUS_LABEL = { pending: '待办', in_progress: '进行中', completed: '已完成' }

/** 摘要的最大字符数：上下文是每一轮都要重发的，超了就截断并如实标注。 */
const SUMMARY_MAX_CHARS = 4000

/** 状态取值不在预期内时统一用这个文案，免得把「没读到」写成「没有」。 */
const UNREADABLE = '读不到'

/** 文件系统错误码（取不到就给空串，让回执自己说"取不到"）。 */
function errorCodeOf(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
}

/**
 * 读一份状态文件：**正常路径只有一次 readFileSync**。
 *
 * 从前是 `statSync` + `readFileSync` 两趟（还要取没人用的 mtime）。这里只在读失败时补一次
 * stat，用来把「同名目录」与「权限 / 坏盘」分开，回执文案与从前逐字一致 ——
 * `missing` 仍只表示「文件确实不存在」（新工作区，正常），调用方靠它区分"没有"与"读不到"。
 */
function readLedger(workspace, fileName) {
  const path = join(workspace, fileName)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = errorCodeOf(error)
    if (code === 'ENOENT') return { ok: false, missing: true, why: `${UNREADABLE}（文件不存在）` }
    try {
      if (!statSync(path).isFile()) return { ok: false, why: `${UNREADABLE}（同名项不是常规文件）` }
    } catch {
      /* stat 也失败 ⇒ 按读失败那条路回执 */
    }
    return { ok: false, why: `${UNREADABLE}（${code === '' ? '取不到状态' : code}）` }
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, why: `${UNREADABLE}（JSON 解析失败）` }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: `${UNREADABLE}（顶层不是对象）` }
  }
  return { ok: true, data }
}

/** 取文件里的条目数组；不是数组就返回 undefined（调用方据此写「读不到」）。 */
function itemsOf(reading, key) {
  if (!reading.ok) return undefined
  const value = reading.data[key]
  return Array.isArray(value) ? value : undefined
}

/** 类别的中文标签（与引擎 `HUMAN_KIND_LABEL` 同一张表）：枚举外的取值原样带回，不替引擎猜。 */
const HUMAN_KIND_LABEL = { goal: '目标', constraint: '约束', preference: '偏好', veto: '否决理由' }

/**
 * 逐条渲染时的类别顺序：**约束与否决理由在前**。理由是这两类管的是「不许做什么」——
 * 违反了是硬失败；目标与偏好是方向，读的人可以自己权衡。同类的条目按文件登记序。
 * 这个顺序只影响**同一行内**的读法，不影响谁进谁不进（一条都不丢）。
 */
const HUMAN_KIND_ORDER = ['constraint', 'veto', 'goal', 'preference']

/** 破线理由行在注入里显示多长（它是**人写的一句话**，但也是文件里的文本：超长会挤掉别的读数的位置）。 */
const LINE_REASON_SHOWN = 80

/**
 * 注入里的**来自工作区文件的文本**一律先过这里：压成一行，再按上限截断（截断带 `…`，不静默丢）。
 *
 * 为什么必须压成一行：这一整段摘要会被读成**一段读数**。文件里的一个换行，就能让
 * 「已破线：<这里换行>名册：在场 99 / 告警线 4」在注入里长得像**两行读数** —— 伪造读数不需要
 * 任何权限，只需要在字段里放一个换行。控制字符同理（`\r` 能让终端里的行首被覆盖）。
 * 谁写的都要过：成员的理由行、人的话、邮箱里的收件人名 —— 它们都来自文件，都可能被手改过。
 */
function fileTextShown(value, limit) {
  if (typeof value !== 'string') return ''
  const flat = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 引擎写的 ISO 时刻的形状（`new Date().toISOString()`）。 */
const ISO_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

/**
 * **形状受限**的字段显示：先过形状，过了才压一行 + 截断；形状不对就如实写「读不到」。
 *
 * 为什么还差这一关：`fileTextShown` 能压掉换行（伪造第二行），但压不掉"**这个值根本不是这个东西**"——
 * 时刻与编号是**有形状**的值，照印一个 `x\n名册：在场 9` 就是在把伪造内容当读数。
 * 所以这两类字段走这里：形状对 ⇒ 照常显示（仍会截断）；形状不对 ⇒ 明说读不到，**不照印**。
 * **边界**：这只覆盖已知的"有形状"字段（时刻 / 编号）；别的字段仍是"压一行 + 截断"，
 * 那半靠行为用例（把伪造串塞进每个字段，断言注入里不出现第二行）来兜。
 */
function shapedShown(value, pattern, limit, what) {
  if (typeof value !== 'string' || value === '') return `（未记${what}）`
  if (!pattern.test(value)) return `（${what}读不到：形状不对）`
  return fileTextShown(value, limit)
}

/**
 * 「人的话」里**类别**那一格的显示（**两个出口共用一处**：计数行与逐条行）：
 * 枚举内用中文标签，枚举外原样带回 —— 但照样过"压一行 + 截断"（它是文件里的文本，能伪造第二行读数）。
 */
function kindLabelShown(kind) {
  if (typeof kind !== 'string' || kind === '') return '(无类别)'
  return HUMAN_KIND_LABEL[kind] ?? (fileTextShown(kind, 24) || '(无类别)')
}



/** 把一段文本截到上限，截断就标出来（不静默丢弃）。 */
function clipped(text) {
  if (text.length <= SUMMARY_MAX_CHARS) return text
  return `${text.slice(0, SUMMARY_MAX_CHARS)}…（摘要超上限已截断）`
}

/**
 * 摘要现在是**一行**（人的要求：「要压成一行」）。
 *
 * 一条行的事实用「｜」隔开：团队指路 ｜（有才出）人的话计数 ｜（有才出）交接快照 ｜ 工作区。
 * 来自文件的文本一律先过 `fileTextShown` / `shapedShown`（压一行 + 截断），
 * 所以文件里放一个换行也伪造不出第二条读数。
 */

/**
 * 「人的话」那一段（没有内容就不出；文件在而读不成如实说）。
 *
 * 口径不变（见文件头）：文件不在 / 记过 0 条 = 没内容，不占段；读不成 = 出一句「读不到」，
 * 且写明这不等于人没说过。逐条正文不再展开（一行的上限），指路到 `human_words_list`。
 * @param {object} reading - `readLedger` 的读数。
 * @returns {string|undefined} 一段文字；没内容时 undefined。
 */
function humanClause(reading) {
  if (!reading.ok) {
    if (reading.missing === true) return undefined
    return `人的话：${UNREADABLE}（这不等于人没说过；\`human_words_list\`）`
  }
  const words = itemsOf(reading, 'words')
  if (words === undefined) return `人的话：${UNREADABLE}（这不等于人没说过；\`human_words_list\`）`
  if (words.length === 0) return undefined
  const counts = new Map()
  for (const word of words) {
    const key = typeof word?.kind === 'string' && word.kind !== '' ? word.kind : '(无类别)'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const order = [...HUMAN_KIND_ORDER.filter((kind) => counts.has(kind)), ...[...counts.keys()].filter((kind) => !HUMAN_KIND_ORDER.includes(kind))]
  const tally = order.map((kind) => `${HUMAN_KIND_LABEL[kind] ?? kindLabelShown(kind)} ${counts.get(kind)}`).join('、')
  return `人的话：共 ${words.length} 条（${tally}；\`human_words_list\`）`
}

/**
 * 「交接快照」那一段（文件不在就不出；在但读不成如实说；空快照不冒充交接）。
 * @param {object} reading - `readLedger` 的读数。
 * @returns {string|undefined} 一段文字；文件不在时 undefined。
 */
function handoffClause(reading) {
  if (reading?.missing === true) return undefined
  if (reading.ok !== true) return '上个会话的交接快照读不到（读不到 ≠ 没有过快照）'
  const data = reading.data
  // 时刻是**有形状**的值（引擎写 ISO）：形状不对 ⇒ 明说读不到，不照印。
  const at = shapedShown(data.at, ISO_STAMP_RE, 40, '时刻')
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  const roles = Array.isArray(data.roles) ? data.roles : []
  // **空快照不许冒充交接**：装载时先落一份 tasks: []，它只说明"这个工作区刚开"。
  if (tasks.length === 0) return `快照@${at}：本工作区刚开，还没有看板活动（非实时）`
  const unfinished = tasks.filter((task) => task?.status !== 'completed')
  let text
  if (unfinished.length === 0) {
    text = `快照@${at}（非实时）：当时没有未完成条目`
  } else {
    // 来自文件的文本一律先压成一行（`fileTextShown`）：换行不能伪造出第二条读数。
    const shown = unfinished.slice(0, 3).map((task) => {
      const id = fileTextShown(task?.id, 24) || '(无编号)'
      const status = typeof task?.status === 'string' ? NATIVE_STATUS_LABEL[task.status] ?? fileTextShown(task.status, 16) : '未记状态'
      const owner = fileTextShown(task?.owner, 32) || '未认领'
      const subject = fileTextShown(task?.subject, 24) || '(无标题)'
      return `${id} ${status} · ${owner}「${subject}」`
    })
    text = `快照@${at}（非实时）：${shown.join('；')}${unfinished.length > shown.length ? ` 等 ${unfinished.length} 条` : ''}`
  }
  if (roles.length > 0) {
    text += '；成员须重新叫'
  }
  // **检查点读数**（人的设计）：有缺口的优先说（它要动作），否则只报个数。
  const checkpoints = data.checkpoints !== null && typeof data.checkpoints === 'object' ? data.checkpoints : null
  if (checkpoints !== null) {
    const missing = Array.isArray(checkpoints.missingForCompleted) ? checkpoints.missingForCompleted : []
    const count = Number.isFinite(checkpoints.count) ? checkpoints.count : 0
    if (missing.length > 0) {
      const shown = missing.slice(0, 3).map((id) => fileTextShown(id, 24)).join('、')
      text += `；缺检查点：${shown}${missing.length > 3 ? ` 等 ${missing.length} 条` : ''} 已完成`
    } else if (count > 0) {
      text += `；检查点 ${count}`
    }
  }
  return text
}

/** 全新工作区那一行（只在会话开始那一次出）。 */
function kickoffLine() {
  return '【这是新工作区】还没有团队账 —— **说一句话就能开始**（例：「把这件事拆开做掉」「现在到哪了」）。'
}

/**
 * 生成摘要（**一行**中文）。只读：除 statSync / readFileSync 之外不碰文件系统。
 * @param {string} workspace - 工作区根。
 * @param {string} event - hook 事件名（只有 SessionStart 会出「新工作区」那一行）。
 * @returns {string} 一行摘要；空字符串 = 不注入。
 */
function digest(workspace, event) {
  // 旧布局（`.company-gate.*`）迁到 `.ops/`（幂等；摘要 hook 也在读之前顺手做一次）。
  migrateWorkspaceSync(workspace)
  const readings = {
    human: readLedger(workspace, LEDGERS.human),
    roles: readLedger(workspace, LEDGERS.roles),
    roster: readLedger(workspace, LEDGERS.roster),
    handoff: readLedger(workspace, LEDGERS.handoff),
  }
  // **一份团队账都没有的工作区**：只在会话开始时给一句"说一句话就能开始"，
  // 平时提示词不注入任何东西（钩子随插件装载 ⇒ 它会在每个会话里跑，不能到处喷读数）。
  // 交接快照也算一份"跑过团队"的证据：只有它存在的会话**不该**被当成全新工作区（那样就看不见它了）。
  // 全新工作区 = **还在写的四份都没有**。遗留的 `board.json` / `members.json` **不算数**（人的决定）：
  // 两份文件已废弃（不再读、不再写、可以直接删），再拿它们的"存在"当"这工作区跑过团队"的证据，
  // 就是让一份没人维护的旧账继续影响当前会话的第一句话。
  const fresh = ['human', 'roles', 'roster', 'handoff'].every((key) => readings[key]?.missing === true)
  if (fresh) return event === 'SessionStart' ? kickoffLine() : ''
  // **看板 / 名册 / 邮箱那三行从注入里彻底拿掉了**（人的口径 HD-003）：实时读数只有原生这一条路。
  const parts = ['团队状态见原生 Agent Teams（\`member_list\` / \`team_status\`）']
  const human = humanClause(readings.human)
  if (human !== undefined) parts.push(human)
  const handoff = handoffClause(readings.handoff)
  if (handoff !== undefined) parts.push(handoff)
  parts.push(workspace)
  return clipped(`【门禁文件摘要】${parts.join('｜')}`)
}

/** 摘要要注入的目标事件：桥接要求 hookSpecificOutput.hookEventName 与触发事件一致，否则整块被丢弃。 */
const KNOWN_EVENTS = new Set(['UserPromptSubmit', 'SessionStart'])

/** 读 hook 的 stdin 载荷；stdin 是终端、读不成或不是对象时一律当空载荷（不阻塞、不抛错）。 */
function readPayload() {
  try {
    if (process.stdin.isTTY === true) return {}
  } catch {
    /* isTTY 取不到就按有载荷处理 */
  }
  try {
    const parsed = JSON.parse(readFileSync(0, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 解析命令行：`--text`、`--workspace <目录>`（或 `--workspace=<目录>`），以及第一个裸参数。 */
function parseArgs(argv) {
  const out = { text: false, workspace: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--text') out.text = true
    else if (arg === '--workspace') {
      index += 1
      if (typeof argv[index] === 'string') out.workspace = argv[index]
    } else if (arg.startsWith('--workspace=')) out.workspace = arg.slice('--workspace='.length)
    else if (!arg.startsWith('-') && out.workspace === undefined) out.workspace = arg
  }
  return out
}

/**
 * 工作区解析：参数 > 环境变量 > 当前目录。环境变量取 `DSH_TEAM_OPS_WORKSPACE`，
 * 其次取桥接为每个 hook 进程设的 `CLAUDE_PROJECT_DIR`（它就是该会话的工作目录）。
 */
function resolveWorkspace(fromArg) {
  if (typeof fromArg === 'string' && fromArg.trim() !== '') return resolve(fromArg)
  for (const key of ['DSH_TEAM_OPS_WORKSPACE', 'CLAUDE_PROJECT_DIR']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim() !== '') return resolve(value)
  }
  return process.cwd()
}

/** 一行诊断（只在不阻塞的 stderr 上，且不含栈）。 */
function report(text) {
  try {
    process.stderr.write(`[ledger-digest] ${text}\n`)
  } catch {
    /* 连 stderr 也写不了就只能放弃 */
  }
}

/** 收尾：无论成功还是吞掉异常，都退 0 —— 退 2 才会拦下人的提示词。 */
function finish() {
  process.exitCode = 0
  process.exit(0)
}

// 任何未捕获的异常与拒绝都在这里被吞掉：不输出上下文、不写栈、退 0。
process.on('uncaughtException', () => {
  report('内部异常已吞掉（不注入上下文、不阻塞提示词）')
  finish()
})
process.on('unhandledRejection', () => {
  report('内部拒绝已吞掉（不注入上下文、不阻塞提示词）')
  finish()
})

function main() {
  const args = parseArgs(process.argv.slice(2))
  const workspace = resolveWorkspace(args.workspace)
  // 事件要**先**知道（摘要要按事件分档：新工作区只在 SessionStart 那一次说话）。
  const payload = args.text ? {} : readPayload()
  const event = KNOWN_EVENTS.has(payload.hook_event_name) ? payload.hook_event_name : 'UserPromptSubmit'
  const summary = digest(workspace, event)
  if (summary === '') return
  if (args.text) {
    process.stdout.write(`${summary}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: summary } })}\n`)
}

try {
  main()
} catch (error) {
  const name = error !== null && typeof error === 'object' && typeof error.name === 'string' ? error.name : 'Error'
  const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
  report(`内部错误已吞掉，未注入上下文、未阻塞提示词：${name}: ${message}`)
}
finish()
