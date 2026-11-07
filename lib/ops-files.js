/**
 * 插件状态文件的位置 —— **一个目录、无前缀**。
 *
 * 人的口径（2026-11-05）：`.company-gate.*` 这类文件全部放进工作区的 `.ops/`，
 * 并把 `.company-gate.` 前缀去掉：`human.json` / `roles.json` / `roster.json` /
 * `member-flags.json` / `handoff.json`，压缩检查点在 `.ops/checkpoints/`。
 *
 * 旧布局的迁移是**读时顺手做一次**（`migrateWorkspaceSync`）：
 *   · 新文件不在、旧文件在 ⇒ `rename` 过去（跨文件系统退化成 copy + unlink）；
 *   · 两边都在 ⇒ **不动旧的**（不替人删数据；新文件优先），由人自己清理。
 *
 * 只碰工作区里的这几个固定文件名；不删目录、不移动别的文件。
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** 状态目录（工作区相对）。 */
export const OPS_DIR = '.ops'

/** 新文件名（相对 `.ops/`）。 */
export const OPS_FILES = {
  human: 'human.json',
  roles: 'roles.json',
  roster: 'roster.json',
  memberFlags: 'member-flags.json',
  handoff: 'handoff.json',
  // 结构化交接单（阶段 3）：跨角色交接的 `{ artifact, path, need }`，与快照 `handoff.json` 不是一回事。
  handoffs: 'handoffs.json',
  // 历史遗留（**已废弃**：不读内容、不写；留在表里只为把那批带前缀的旧文件名迁移成新名字）
  board: 'board.json',
  members: 'members.json',
}

/** 旧文件名（工作区根，带前缀）。 */
export const LEGACY_FILES = {
  human: '.company-gate.human.json',
  roles: '.company-gate.roles.json',
  roster: '.company-gate.roster.json',
  memberFlags: '.company-gate.member-flags.json',
  handoff: '.company-gate.handoff.json',
  board: '.company-gate.board.json',
  members: '.company-gate.members.json',
}

/** 压缩检查点：旧目录 → 新目录。 */
export const LEGACY_CHECKPOINTS_DIR = '.company-gate.checkpoints'
export const OPS_CHECKPOINTS_DIR = '.ops/checkpoints'

/** 这个进程里已经迁过的工作区（避免每次读都 stat 一圈）；有上限，工作区多了不常驻名单。 */
const migrated = new Set()
const MIGRATED_MAX = 256

/** 状态目录绝对路径。 */
export function opsDirOf(workspace) {
	return join(workspace, OPS_DIR)
}

/**
 * 状态文件的**工作区相对路径**（`.ops/<文件名>`）：文件名只有 `OPS_FILES` 一份正文，
 * 目录前缀只有 `OPS_DIR` 一处。引擎、摘要 hook、面板与停用名单都从这里取，不许各自拼字符串。
 * @param key - `OPS_FILES` 的键；拼错了当场抛，不静默给一个不存在的路径。
 */
export function opsFileOf(key) {
	const name = OPS_FILES[key]
	if (typeof name !== 'string') throw new Error(`未知的状态文件：${String(key)}`)
	return `${OPS_DIR}/${name}`
}

/**
 * 一次性迁移（幂等；同步，读路径上也能调）。
 * @param workspace - 工作区绝对路径。
 */
export function migrateWorkspaceSync(workspace) {
  if (typeof workspace !== 'string' || workspace === '') return
  if (migrated.has(workspace)) return
  // 到顶整表清一次：只是下一次读多 stat 一圈，迁移本身幂等，不会漏做。
  if (migrated.size >= MIGRATED_MAX) migrated.clear()
  migrated.add(workspace)

  const dir = opsDirOf(workspace)
  const oldDir = join(workspace, LEGACY_CHECKPOINTS_DIR)
  let needed = existsSync(oldDir)
  if (!needed) {
    for (const oldName of Object.values(LEGACY_FILES)) {
      if (existsSync(join(workspace, oldName))) {
        needed = true
        break
      }
    }
  }
  // 没有旧文件：什么都不建（空工作区不该因为读一下多出一个目录）。
  if (!needed) return

  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return
  }

  for (const [key, oldName] of Object.entries(LEGACY_FILES)) {
    const from = join(workspace, oldName)
    const to = join(dir, OPS_FILES[key])
    if (!existsSync(from) || existsSync(to)) continue
    try {
      renameSync(from, to)
    } catch {
      // 跨文件系统 / 权限：退化成复制 + 删旧（失败就留旧文件，下次还能再试）。
      try {
        copyFileSync(from, to)
        unlinkSync(from)
      } catch {
        /* 留旧文件；读方按"新文件不在"处理 */
      }
    }
  }

  const newDir = join(workspace, OPS_CHECKPOINTS_DIR)
  if (existsSync(oldDir) && !existsSync(newDir)) {
    try {
      renameSync(oldDir, newDir)
    } catch {
      /* 目录迁移失败就不动它（旧目录下的压缩检查点仍可读） */
    }
  }
}
