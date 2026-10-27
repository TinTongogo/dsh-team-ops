#!/usr/bin/env node
/**
 * 只读文件摘要 —— 把四份文件的当前状态压成一段中文，交给 DSH 的 hook 桥接
 * 注进会话上下文。
 *
 * 四份 = 看板 / 人的话 / 名册 / 邮箱：前两份是制度状态，后两份是**团队状态**
 * （谁在场、谁在跑、谁的信还没被收下）—— 协调者据此决定要不要派人、要不要先读邮箱。
 *
 * 为什么要有它：文件是状态的唯一真相源，而引擎只写文件、**不会把变化推给任何会话**。
 * 人在两次发言之间点了批准，会话手里那份读数就已经过期，而且没有任何提示。本脚本把
 * 「当前文件长什么样」在**每次提示词提交**与**每个新会话开局**各注入一次，于是会话不必
 * 靠纪律去记得重读：状态自己进上下文。
 *
 * 接线：`lib/hooks.claude-code.json`（事件 `UserPromptSubmit` 与 `SessionStart`）
 *      → `team/agent.cordis.yml` 里的 hook 桥接那一行。
 *
 * 硬边界：
 *   · **只读**：不写任何文件、不改文件、不建目录、不动工作区。
 *   · **绝不拦提示词**：桥接把退出码 2 映射为阻塞，本脚本在任何路径上都退 0；
 *     内部异常一律吞掉、不输出上下文（宁可没有摘要，也不能让人一次发言被拦住）。
 *   · **读不到就说读不到**：文件缺失 / 读不成 / 解析失败一律如实写「读不到」，
 *     绝不写成「没有条目 / 看板为空」。
 *   · **读得到也要说清来源**：团队状态迁到 DSH 原生 Agent Teams 之后，看板与名册这两份文件
 *     不再承载实时状态 —— 那两行各自带一句「来源是遗留文件、可能已停止更新」并指向实时读数
 *     （`team_status` / `member_list`）。只写「读不到 ≠ 没有」是不够的：文件**在**而内容冻住时，
 *     读到的每一个数都长得像现状。
 *
 * 「人的话」那一行（人的决定与约束：目标 / 约束 / 偏好 / 否决理由）有一条**自己的行数口径**：
 *   · **没有内容时不占行**：状态文件不在（结构化「未找到」，即这个工作区还没记过任何一条 ——
 *     这份文件按需建立，没内容就是没有）或记过但一条都没有 ⇒ **一行都不出**。
 *     注入是每一轮都要重发的，空内容占一行就是纯噪音。
 *   · **有内容时只占一行**（远在 ≤5 行的上限之内），按类别分组列出；一次也没有到期的期限行
 *     那种「有才出现」的写法在这里不适用 —— 人说过的话是常驻约束，每轮都得在。
 *   · **读不成则不占行这条不成立**：文件在而读不成 / JSON 坏 / 顶层不是对象 / `words` 不是数组
 *     ⇒ **出一行如实说读不到**，并写明「这不等于人没说过」。两档不许互相顶替：
 *     「文件不在」是没内容，「读不到」是有内容却看不到。
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
 * 默认输出 hook 的 JSON（`hookSpecificOutput.additionalContext`，字段名以
 * `@deepseek-ai/dsh-hooks-claude-code` 的官方说明为准）；`--text` 输出同一段摘要的纯文本，
 * 给人看与给自检用。
 */

import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BOARD_STATUSES } from './board-status.js'

/** 文件的文件名：引擎写在**工作区根**下的固定名，写死在这里是因为引擎也写死这几份。 */
const LEDGERS = {
  human: '.company-gate.human.json',
  roles: '.company-gate.roles.json',
  roster: '.company-gate.roster.json',
  // **交接快照**：引擎在每次看板成功改动之后顺手写的**派生物**（原生看板按会话，新会话从零开始）。
  // 它**不是**实时看板 —— 渲染那一行时要把这件事写在句子里（见 `handoffLine`）。
  handoff: '.company-gate.handoff.json',
}

/**
 * **那三份遗留文件的文件名**：它们的内容**不再读、不再打印**（人的口径），但"文件在不在"仍要看一眼 ——
 * 只用来判断"这个工作区跑过团队会话没有"（否则一个只有旧账的工作区会被当成全新工作区，连实时那行都不出）。
 */
const LEGACY_LEDGERS = {
  board: '.company-gate.board.json',
  members: '.company-gate.members.json',
  mailbox: '.company-gate.mailbox.json',
}

/** 原生三态 → 本产品的分栏名（引擎那半边有一份反向的映射 `NATIVE_STATUS_FILTERS`；两边都在自己那一侧）。 */
const NATIVE_STATUS_LABEL = { pending: '待办', in_progress: '进行中', completed: '已完成' }

/** 成员编制的两个读数常量：与引擎同源（`MEMBER_WARN_LINE` / 在场状态）。 */
const MEMBER_WARN_LINE = 4
const MEMBER_PRESENT_STATUS = '在场'
/** 运行时状态四档的词面（名册里没有这个字段时**不印**，见 `rosterLine`）。 */
const RUNTIME_LABEL = { running: '跑着', inactive: '无轮次', provisioning: '创建中', failed: '失败' }

// 看板状态枚举：唯一正文在 `lib/board-status.js`；枚举外的取值单独列，不并入任何一档。

/** 任务编号形态：前缀加数字。前缀在这里拼出来，正文里不出现任何具体编号。 */
const TASK_ID_RE = new RegExp(`^${'T'}-(\\d+)$`)

/** 摘要的最大字符数：上下文是每一轮都要重发的，超了就截断并如实标注。 */
const SUMMARY_MAX_CHARS = 4000

/** 状态取值不在预期内时统一用这个文案，免得把「没读到」写成「没有」。 */
const UNREADABLE = '读不到'

/** 一个时间戳的可读形态；取不到就返回 undefined。 */
function stampOf(ms) {
  if (!Number.isFinite(ms)) return undefined
  try {
    return new Date(ms).toISOString()
  } catch {
    return undefined
  }
}

/** 计数字段的可读形态：非有限数一律标「未记录」，不当成 0。 */
function counted(value) {
  return Number.isFinite(value) ? String(value) : '未记录'
}

/** 读一份文件：始终尽力取 mtime，取不到内容就如实给出原因。 */
function readLedger(workspace, fileName) {
  const path = join(workspace, fileName)
  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
    // `missing` 单独标出来：调用方要区分「这个工作区还没有文件」（新工作区，正常）
    // 与「文件读不成」（异常）。只看 `why` 的字面去猜是不行的。
    return {
      ok: false,
      missing: code === 'ENOENT',
      why: code === 'ENOENT' ? `${UNREADABLE}（文件不存在）` : `${UNREADABLE}（${code === '' ? '取不到状态' : code}）`,
    }
  }
  const mtime = stampOf(stat.mtimeMs)
  if (!stat.isFile()) return { ok: false, why: `${UNREADABLE}（同名项不是常规文件）`, mtime }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
    return { ok: false, why: `${UNREADABLE}（${code === '' ? '读取失败' : code}）`, mtime }
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, why: `${UNREADABLE}（JSON 解析失败）`, mtime }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: `${UNREADABLE}（顶层不是对象）`, mtime }
  }
  return { ok: true, data, mtime }
}

/** 取文件里的条目数组；不是数组就返回 undefined（调用方据此写「读不到」）。 */
function itemsOf(reading, key) {
  if (!reading.ok) return undefined
  const value = reading.data[key]
  return Array.isArray(value) ? value : undefined
}

/** 一个条目的编号由 `humanWordText` 用 `shapedShown` 渲染（形状 + 压一行），这里不再另留一份取法。 */

/**
 * 看板与名册那两栏的**来源标注**（一处正文，两处引用）。
 *
 * 为什么每轮都要带这一句：任务板与名册都已迁到 DSH 原生 Agent Teams，这两份文件**不再承载
 * 实时状态**（可能已停止更新），而摘要是每个会话第一屏、每轮提示词都注入的东西 —— 不标来源，
 * 读的人（模型与人）就会把文件里的旧账当现状（曾出现"文件说全干完了、原生说还有待办"）。
 * 本脚本是**独立 hook 进程**，拿不到 `ctx.agentTeams` / 会话凭据，所以这里能做的只有诚实地
 * 标明来源并指向实时读数，不能自己去读原生。
 */
/** 类别的中文标签（与引擎 `HUMAN_KIND_LABEL` 同一张表）：枚举外的取值原样带回，不替引擎猜。 */
const HUMAN_KIND_LABEL = { goal: '目标', constraint: '约束', preference: '偏好', veto: '否决理由' }

/**
 * 逐条渲染时的类别顺序：**约束与否决理由在前**。理由是这两类管的是「不许做什么」——
 * 违反了是硬失败；目标与偏好是方向，读的人可以自己权衡。同类的条目按文件登记序。
 * 这个顺序只影响**同一行内**的读法，不影响谁进谁不进（一条都不丢）。
 */
const HUMAN_KIND_ORDER = ['constraint', 'veto', 'goal', 'preference']

/** 一条记录里每个字段在注入里显示多长；超出截到这么多字并带 `…`（截断可见，不静默丢弃）。 */
const HUMAN_TEXT_SHOWN = 60
const HUMAN_REASON_SHOWN = 40
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

/** 引擎写的 ISO 时刻的形状（`new Date().toISOString()`）；**人的话**编号的形状（`HD-<数字>`）。 */
const ISO_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const HUMAN_ID_RE = /^HD-\d+$/

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

/**
 * 「人的话」那一行的**单条读数**：类别 + 编号 + 那句话 + 理由 + 谁落的笔。
 *
 * 「谁落的笔」要印：`agent` 是 AI 代记（人说过、由 AI 转述），`human` 是人自己写的 ——
 * 两者在注入里长得一样时，读的人无从判断那句话是不是被改写过的。
 */
function humanWordText(word) {
  // 编号是**有形状**的值：`HD-<数字>`；形状不对 ⇒ 明说读不到，不把文件里的串照印进注入。
  const id = shapedShown(word?.id, HUMAN_ID_RE, 24, '编号')
  // 类别枚举外的取值原样带回（不替引擎猜），但照样过"压一行 + 截断"那条路。
  const kind = kindLabelShown(word?.kind)
  const text = typeof word?.text === 'string' && word.text !== '' ? word.text : '(无内容)'
  const shown = fileTextShown(text, HUMAN_TEXT_SHOWN)
  const reason = typeof word?.reason === 'string' && word.reason !== '' ? word.reason : undefined
  const reasonShown = reason === undefined ? '' : `（理由：${fileTextShown(reason, HUMAN_REASON_SHOWN)}）`
  const by = word?.by === 'human' ? '人亲录' : word?.by === 'agent' ? 'AI 代记' : '(未记记录人)'
  return `${kind} ${id}「${shown}」${reasonShown}［${by}］`
}

/**
 * 「人的话」那一行 —— 人的决定与约束（目标 / 约束 / 偏好 / 否决理由）。
 *
 * 判定条件（写死在这里，改这里即改判定条件）：
 *   · 状态文件**不在**（结构化「未找到」）⇒ 返回 `undefined`：**一行都不出**。
 *     这份文件按需建立，没内容就是没有 —— 这是「没有内容」，**不是「读不到」**，
 *     注入每一轮都要重发，空内容占一行就是纯噪音。
 *   · 文件在、`words` 是数组但 0 条 ⇒ 同样返回 `undefined`（没内容，不占行）。
 *   · 文件在、`words` 不是数组 ⇒ **出「读不到」那一行**（形状不符 = 读不成，不是没有）。
 *   · 文件在而读不成（`ok === false`，且不是「文件不在」）⇒ **出「读不到」那一行**，
 *     并写明「这不等于人没说过」：有内容却看不到与没有内容，是两回事，不许互相顶替。
 *   · 有内容 ⇒ **恰好一行**：`人的话：共 N 条（各类计数）；逐条 …`，按 `HUMAN_KIND_ORDER`
 *     分组、同类按登记序，一条都不丢。行数是 1，**远在 ≤5 行的上限之内**。
 */
function humanLine(reading) {
  if (!reading.ok) {
    // `missing === true`（文件不在）是「没内容」，不是「读不到」——两档分开走。
    if (reading.missing === true) return undefined
    return `人的话：${UNREADABLE} —— ${LEDGERS.human} ${reading.why}；因此**无法判定人说过什么**（这不等于「人没说过」）`
  }
  const words = itemsOf(reading, 'words')
  if (words === undefined) {
    return `人的话：${UNREADABLE} —— ${LEDGERS.human} 里没有 words 数组；因此**无法判定人说过什么**（这不等于「人没说过」）`
  }
  if (words.length === 0) return undefined
  const counts = new Map()
  for (const word of words) {
    const key = typeof word?.kind === 'string' && word.kind !== '' ? word.kind : '(无类别)'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const order = [...HUMAN_KIND_ORDER.filter((kind) => counts.has(kind)), ...[...counts.keys()].filter((kind) => !HUMAN_KIND_ORDER.includes(kind))]
  // **同一处纪律**：枚举外的类别在这里（计数行）也要过"压一行 + 截断" —— 这一行同样是来自文件的文本
  // （复核凿出来的：`kind` 有两个出口，单改"逐条"那一个，计数行照样能伪造出第二行读数）。
  const tally = order.map((kind) => `${HUMAN_KIND_LABEL[kind] ?? kindLabelShown(kind)} ${counts.get(kind)}`).join('、')
  const sorted = order.flatMap((kind) => words.filter((word) => (typeof word?.kind === 'string' && word.kind !== '' ? word.kind : '(无类别)') === kind))
  return `人的话：共 ${words.length} 条，${tally}；逐条 ${sorted.map(humanWordText).join('；')}`
}

/**
 * 「人的话」那一份在新鲜度行里的读数。
 *
 * 三档分开写，因为这三件事**在读的人眼里是不同的事**：`未建立`（文件不在 —— 这份文件按需建立，
 * 没记过任何一条时它本来就不存在，是正常状态）、`读不到`（文件在而读不成 / 解析失败 —— 异常）、
 * 一个时间戳（读到过）。它是唯一一处会提到「人的话」而不出「人的话」那一行的地方：
 * 不写清楚，读的人会把「没人说过话」当成「文件坏了」。别处那三份文件照旧。
 */
function humanFreshness(reading) {
  if (reading.ok) return reading.mtime ?? UNREADABLE
  return reading.missing === true ? '未建立' : UNREADABLE
}

/** 文件新鲜度那一行：各份文件的 mtime 各自如实给，取不到就写读不到。 */
function freshnessLine(workspace, readings, now) {
  // **只列还在写的账**：看板 / 名册 / 邮箱那三份是遗留文件（本插件不再写它们），
  // 从注入里**彻底拿掉**（人的口径）—— 连着 mtime 也不列，免得"有个文件在那儿"再把人引偏一次。
  const parts = [
    `human ${humanFreshness(readings.human)}`,
    `roles ${humanFreshness(readings.roles)}`,
    `roster ${humanFreshness(readings.roster)}`,
    // 交接快照的 mtime 也印出来：它的**全部意义**就是"什么时候的快照" —— 新鲜度是它的关键属性。
    `handoff ${humanFreshness(readings.handoff)}`,
  ]
  return `状态文件 mtime（现场读）：${parts.join('、')}｜摘要生成时间 ${now}｜工作区 ${workspace}`
}


/** 把一段文本截到上限，截断就标出来（不静默丢弃）。 */
function clipped(text) {
  if (text.length <= SUMMARY_MAX_CHARS) return text
  return `${text.slice(0, SUMMARY_MAX_CHARS)}…（摘要超上限已截断）`
}

/**
 * 「装完打开就能开工」那一段：**只在工作区还没有看板文件时**出现。
 *
 * 判据（写死在这里，改这里即改判定条件）：看板文件 `missing === true`（ENOENT，即这个工作区
 * 还没跑过任何一单）。文件读不成（权限 / JSON 坏）**不算**新工作区 —— 那是异常，照 §八第 6 条
 * 如实写「读不到」，不许用开局提示把它盖过去。
 *
 * 为什么用这一段而不是让人读文档：一人公司装完插件打开会话时，**人看到的应该是"说一句话就能开始"**，
 * 而不是一份使用手册。它是注入里的第一块，会话第一句话就该把它说给用户（接线见预设 persona）。
 */
function kickoffLines(reading, event) {
  if (reading?.missing !== true) return []
  // **只在会话开始那一次说**（人的钩子现在随插件装载、每个会话都会跑；如果每次提示词都喷这四行，
  // 在"还没用团队"的工作区里就是噪声 —— 谁也没建看板文件，它会一直重复）。
  if (event !== 'SessionStart') return []
  return [
    '【这是新工作区】本工作区还没有团队账（没有人的话、也没有交接快照）—— **说一句话就能开始**。',
    '· 直接说你要什么就行，例如：「把这件事拆开做掉」「这周该做什么」「帮我判断这个方案能不能上」。',
    '· 我会走完整路径，第一条回执不超过 5 行；要状态就说「现在到哪了」，要明细再说。',
    '· 这一段只因为本工作区还没有团队账才出现；第一件事开起来之后它就不再出现。',
  ]
}

/**
 * 「上个会话留下的**交接快照**」那一行（`board_task` 每次成功改动之后顺手写的那份派生物）。
 *
 * 三档判据（与其余几份文件同一条口径）：
 *   · **文件不在** ⇒ 一行不出（没跑过带看板改动的会话 = 没有快照，正常状态）；
 *   · **文件在但读不成** ⇒ 出一行如实说读不到（读不到 ≠ 没有）；
 *   · **文件在且能读** ⇒ 出行，且**句子里必须说清它是快照不是实时看板** —— 否则读的人会把
 *     "上个会话那一刻"当成现状（这一句是这份文件的全部意义所在：它是跨会话的，但**不新鲜**）。
 *
 * 它**替代不了** `team_status`：那条实时读数照旧另出一行（这条只是"接着干"的入口）。
 * @param {object} reading - `readLedger` 的读数。
 * @returns {string[]} 要注入的行（可能为空）。
 */
function handoffLine(reading) {
  if (reading?.missing === true) return []
  if (reading.ok !== true) return [`**上个会话的交接快照**：${reading.why} —— 读不到 ≠ 没有过快照；实时读数仍看 \`team_status\`。`]
  const data = reading.data
  // 时刻是**有形状**的值（引擎写 ISO）：形状不对 ⇒ 明说读不到，不照印；会话 id 走"压一行 + 截断"。
  const at = shapedShown(data.at, ISO_STAMP_RE, 40, '时刻')
  const sessionId = fileTextShown(data.sessionId, 64) || '（未记会话）'
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  const roles = Array.isArray(data.roles) ? data.roles : []
  // **派生读数不得当状态**（task-80 的 C 条）：快照是**当时**的派生读数 ⇒
  // ① **不印裸计数**（"进行中 N 条 / 待办 N 条"会被当成实时板面读 —— 板面其实是空的）；
  // ② 改成"当时**未完成**的条目"清单；③ "**非实时**"标在**块首**，不塞在末尾注解里。
  const unfinished = tasks.filter((task) => task?.status !== 'completed')
  // **空快照不许冒充交接**：装载时会先落一份 `tasks: []` 的首份快照（让每个跑过团队会话的工作区都有这个文件），
  // 那时它只说明"这个工作区刚开、还没有看板活动"——说成"上个会话留下了交接"是编事实。
  if (tasks.length === 0) {
    return [
      `本工作区**刚开**（会话 \`${sessionId}\`，首份交接快照 ${at}）：**还没有看板活动** —— ` +
        '原生看板是**会话级**的，第一次登记任务之后这里才有交接信息。',
      '（**这是快照，不是实时看板**：实时读数以 `team_status` / `board_task query` 为准。）',
    ]
  }
  const lines = [
    `**快照@${at}**（\`${sessionId}\`）：以下为**当时**未完成的条目（**非实时**；实时读数以 \`team_status\` / \`board_task query\` 为准）—— ` +
      '原生看板是**会话级**的（`TeamId = SessionId`），新会话从零开始；要接着干，按这些任务与它们指向的产物文件接手。',
  ]
  if (unfinished.length > 0) {
    // **来自文件的文本一律先压成一行**（`fileTextShown`）：快照是引擎写的，但它记的标题来自任务、
    // 一样可能被手改过带换行 —— 一个换行就能在注入里伪造出"第二行读数"（这条纪律对谁都一样）。
    const shown = unfinished.slice(0, 8).map((task) => {
      const id = fileTextShown(task?.id, 24) || '(无编号)'
      const status = typeof task?.status === 'string' ? NATIVE_STATUS_LABEL[task.status] ?? fileTextShown(task.status, 16) : '未记状态'
      const owner = fileTextShown(task?.owner, 32) || '未认领'
      const subject = fileTextShown(task?.subject, 40) || '(无标题)'
      return `${id} ${status} · ${owner} · ${subject}`
    })
    lines.push(`· 当时未完成（最多列 8 条）：${shown.join('；')}${unfinished.length > shown.length ? ` ……共 ${unfinished.length} 条` : ''}`)
  } else {
    lines.push('· **当时没有未完成的条目**（快照里的都已完成）—— 要接着干，先看实时读物。')
  }
  if (roles.length > 0) {
    lines.push(
      `· 快照里这一档用过这些角色：${roles.map((role) => '`' + fileTextShown(role, 32) + '`').join('、')} —— ` +
        '**成员不能跨会话接手**（名册按会话）：新会话要 `member_spawn role=<id>` 重新叫，名字会是 `<角色>-1` 这种，**不是**沿用旧名字。',
    )
  }
  lines.push('（**这是快照，不是实时看板**：实时读数以 `team_status` / `board_task query` 为准。）')
  return lines
}

/** 生成摘要（多行中文文本）。只读：除了 statSync / readFileSync 之外不碰文件系统。 */
function digest(workspace, now, event) {
  const readings = {
    human: readLedger(workspace, LEDGERS.human),
    roles: readLedger(workspace, LEDGERS.roles),
    roster: readLedger(workspace, LEDGERS.roster),
    handoff: readLedger(workspace, LEDGERS.handoff),
  }
  // 「人的话」那一行由 `humanLine` 自己决定出不出（没内容就不占行）。
  // **一份团队账都没有的工作区**：只在会话开始时给那几句"说一句话就能开始"，
  // 平时提示词**不注入任何东西**（钩子随插件装载 ⇒ 它会在每个会话里跑，不能到处喷读数）。
  // 交接快照也算一份"跑过团队"的证据：只有它存在的会话**不该**被当成全新工作区（那样就看不见它了）。
  // 全新工作区 = 还在写的四份都没有，**并且**那三份遗留文件也都不在（只有旧账的工作区不算全新：
  // 它跑过团队会话，实时那一行必须出）。
  const anyLegacy = Object.values(LEGACY_LEDGERS).some((name) => !readLedger(workspace, name).missing)
  const fresh = ['human', 'roles', 'roster', 'handoff'].every((key) => readings[key]?.missing === true) && !anyLegacy
  if (fresh) return event === 'SessionStart' ? kickoffLines(readings.handoff, event).join('\n') : ''
  const human = humanLine(readings.human)
  // **看板 / 名册 / 邮箱那三行从注入里彻底拿掉了**（人的口径：哪怕文件还在也不再打印 —— 它们已被引偏两次）。
  // 实时读数只有一条路：原生队伍（`member_list` / `team_status`），所以这里只留那一行指路；
  // 三份遗留 json 是人的数据，文件留着，只是不再被读、被打印。
  const teamLines = ['团队状态：在 DSH 原生 Agent Teams（按会话）—— 成员与任务用 `member_list` / `team_status` 读']
  return clipped(
    [
      '【门禁文件摘要】以下状态读自工作区里的文件（只读注入，非本会话的记忆）',
      ...kickoffLines(readings.handoff, event),
      ...teamLines,
      // 交接快照紧跟在"团队状态"那行后面：它是"接着干"的入口，而实时读数就在它上面一行。
      ...handoffLine(readings.handoff),
      ...(human === undefined ? [] : [human]),
      freshnessLine(workspace, readings, now),
    ].join('\n'),
  )
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
  const now = new Date().toISOString()
  // 事件要**先**知道（摘要要按事件分档：新工作区只在 SessionStart 那一次说话）。
  const payload = args.text ? {} : readPayload()
  const event = KNOWN_EVENTS.has(payload.hook_event_name) ? payload.hook_event_name : 'UserPromptSubmit'
  const summary = digest(workspace, now, event)
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
