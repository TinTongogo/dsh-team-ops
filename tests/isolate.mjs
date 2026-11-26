/**
 * **测试与"用户真实目录"的隔离**（一处正文，测试文件在顶层 `import` 它一次）。
 *
 * 为什么必须这样：引擎的"用户根"是从环境变量算出来的 —— `DSH_HOME`（缺省 `~/.dsh`）与
 * `DSH_TEAM_OPS_ROLES`（缺省 `$DSH_HOME/team-ops/roles`）；不设就落到**真实目录**
 * （`~/.dsh/team-ops/roles`、`~/.dsh/skills`）。于是**任何一条忘了把根指到临时目录的用例**
 * 都会往用户那儿写。现场真出过：一条边界用例（它只需要"边界放行"这个结论）顺路把测试夹具
 * `probe-role` 写进了用户的角色根 —— 面板「角色」与 `member_defaults` 平白多出一个**幽灵角色**，
 * 还把"本工作区角色全来自包内"那条断言变成了红（单跑绿、合起来红）。
 *
 * 所以隔离**只做一次、只在这一处**：测试文件在顶层 `import './isolate.mjs'` 一次即可，
 * **不靠每条用例各自记得设**（"各自记得"正是那次漏的成因）。
 *
 * 两条实现口径：
 *   · 每个**测试文件**拿到自己那个临时 home（同一文件内的用例共用），文件之间互不干扰；
 *   · 临时 home 前缀是固定的 `team-ops-test-home-`，落在系统临时目录下 —— 哨兵断言（各测试文件里
 *     那条「测试与用户真实目录隔离」）据此判"隔离在不在"，**去掉下面两行赋值 ⇒ 那条当场红**。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 隔离 home 的前缀（哨兵断言与自证都用它判"隔离在不在"）。 */
export const ISOLATION_PREFIX = join(tmpdir(), 'team-ops-test-home-')

/** 本测试文件专属的隔离 home。 */
export const ISOLATED_HOME = mkdtempSync(ISOLATION_PREFIX)

// **这两行就是隔离本身**（删掉它们 ⇒ 各测试文件里的哨兵断言当场红）。
process.env.DSH_HOME = ISOLATED_HOME
process.env.DSH_TEAM_OPS_ROLES = join(ISOLATED_HOME, 'team-ops', 'roles')

/**
 * 把隔离 home 清回"刚装好、用户根是空的"状态。
 *
 * 测试文件在顶层挂一次 `beforeEach(resetIsolatedHome)` 即可 —— 于是**用例之间不许互相看见对方
 * 写进用户根的东西**（那正是"单跑绿、合起来红"的第二个成因：一条边界用例顺手写了一个角色，
 * 后面那条"本工作区角色全来自包内"的断言就看见它了）。
 */
export function resetIsolatedHome() {
	rmSync(ISOLATED_HOME, { recursive: true, force: true })
	mkdirSync(ISOLATED_HOME, { recursive: true })
}
