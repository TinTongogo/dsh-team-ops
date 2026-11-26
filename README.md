# dsh-team-ops

> English overview: [README.en.md](README.en.md) — a condensed summary; this file stays canonical.

给 **DeepSeek Harness** 装一支**可叫、可查、可收口**的团队：19 个具名角色共享一块任务看板，你说一件事，协调器决定拆不拆、谁来干、什么时候问你。跟"多开几个对话框"的差别是**状态可读可追**：看板与邮箱在原生 Agent Teams 里，谁在干什么、卡在哪、谁接手，问一句就有答案。

## 装

```bash
# 装（profile 名自取；现有 profile：ls ~/.dsh/profiles/）
pnpm --dir ~/.dsh/profiles/desktop add 'git+https://github.com/TinTongogo/dsh-team-ops.git'

# 以后更新就这一条（push 完不 update，DSH 用的是旧那份）
pnpm --dir ~/.dsh/profiles/desktop update dsh-team-ops
```

确认 `~/.dsh/profiles/desktop/package.json` 里两处都有 `dsh-team-ops`：`dependencies` 与 `dsh.profile.bundles`。然后**重启 DSH**；只有前端改动的版本刷新页面即可。

<details>
<summary>本机调试：用本地 tarball 临时装（非安装方式）</summary>

正式安装与升级走上面的 git 源；这一节只是改包时不想先 push 的捷径：

```bash
npm pack --pack-destination ~/.dsh/team-ops   # 1) 打包
# 2) 把 profile 里 dsh-team-ops 的依赖临时指到 file:/…/dsh-team-ops-<版本>.tgz
# 3) 用 DSH 自带的 pnpm 11 安装（系统 pnpm 10 的 store 版本不匹配）
/Users/yao/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node \
  /Users/yao/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs \
  --dir ~/.dsh/profiles/desktop install
# 4) 重启 DSH
```

装出来的版本必须等于仓库 `package.json`：`node -e "console.log(require(process.env.HOME + '/.dsh/profiles/desktop/node_modules/dsh-team-ops/package.json').version)"`。固化脚本 `npm run release:local`（`--dry-run` 只打印计划）做同样四步。
</details>

## 装完你会看到什么

- 对话页多一栏 **「团队状态」**：成员 / 角色 / 技能 / 任务看板四块；
- 输入框左边多一枚 **「角色」** 按钮：选一个角色插进 `@角色名` 就是**点名**，那件事交给那个角色；
- 输入框右边多一枚 **「润色」**：一次**无工具**的模型调用，把草稿改写成更具体、可直接执行的请求（只改写、不替你作答，不注入项目上下文，与原文同语言、约 800 字符以内），**直接替换输入框文字**；按钮变成「撤回」，撤回后点润色会绕过 3 分钟缓存强制重写。失败弹按原因给文案的浮窗（可重试的给「重试」）；代码 / 链接 / 路径 / `@引用` 逐字保留；
- 团队工具（`member_*` / `board_task` / `team_status` / `human_words_*` …）出现在工具列表 ⇒ 宿主半边也起来了。

工作区根会按需出现 `.ops/`（纯文本、可读可备份）：

| 文件 | 是什么 |
| --- | --- |
| `.ops/human.json` | 你说过的判断（真源） |
| `.ops/roles.json` | 角色开关（真源） |
| `.ops/roster.json` | 角色下架（真源；下架后 `member_defaults` 不列、`member_spawn` 拒） |
| `.ops/member-flags.json` | 成员停用（真源） |
| `.ops/handoff.json` | 交接快照（派生物，见「跨会话续接」） |
| `.ops/checkpoints/` | 自动压缩的原始转储（派生、可删） |

看板、名册、邮箱的读数都归**原生 Agent Teams**。旧的 `board.json` / `members.json` 是**遗留**文件：本插件不再写；`members.json` **面板不再读它**，`board.json` 也不再被读（`/status` 只读原生任务板，读不到就如实说读不到）。两份都可以直接删。

## 怎么用

1. **要一件事**：直接说。协调器判断拆不拆、登记看板、按角色叫人，然后回结论。
2. **点名**：`@architect 看一下这个方案` ⇒ 派给架构师（多个 `@` 各派一份）。
3. **问进度**：「现在到哪了」⇒ 一句状态行 + 卡在哪。
4. **加角色**：`npm run role:new -- <角色 id>` 生成骨架，改完跑 `npm run roster:write`；面板「角色」也能加 / 改 / 下架；「专属技能」从技能目录多选（「(本机没有)」的会标出来）。
5. **加技能**：「技能」块上的 **导入技能** / **新建技能**；用户级技能给所有会话用，项目级只给这个工作区。
6. **管人**：成员卡上有 **停用 / 恢复 / 打断**。

### 停用、打断与编制上限

- **「停用」只在本插件的调度层生效**：被停用的人在**宿主原生界面里仍然可以打开对话**（宿主没有移除 / 停用成员的接口，**原生名册行只增不减**）—— 要把一个人从会话里彻底隔离，只能**开新会话**。它只是**本插件不再派活给它**、**不占角色槽位**（同一档至少留 1 位未停用，随时可恢复）。
- **打断** = 只断它当前那一轮（收件箱保留）。
- **两条独立硬上限**：角色槽位 ≤3 位（同角色未停用且非 `failed`）；在场总人数 ≤24 位（名册行数，含 `failed` 与停用者）。

## 跨会话续接（上下文到极限之后）

原生队伍按会话（`TeamId = SessionId`），新会话的原生看板从零开始。插件因此在工作区留一份 `.ops/handoff.json`：由 `board_task` 改动与原生 `team/task` 事件自动更新（250ms 防抖），记时刻、来源会话、三态任务清单与用过的角色。新会话开局跑 `node lib/ledger-digest.js --text` 就能读到（形如 `快照@<时刻>（非实时）：…`）。插件**不自动注入**交接摘要。

**检查点**（压缩 / 收口前的落点）有两处：

- **结构化**：`team_checkpoint` 工具把「事实 / 决定 / 产物 / 未决 / 下一步」追加到 `docs/team/checkpoints/<task>--<会话短标签>.md`（append-only，收口前写一次；按会话隔离）；
- **自动**：压缩提交时 `lib/session-watch.js` 把摘要与被压原文写到 `.ops/checkpoints/compaction/`（派生、可删）。

两句必须记住：① 它是**快照**、**不是**实时看板，实时读数以 `team_status` / `board_task query` 为准；② **成员不能跨会话接手** —— 快照只记该叫哪些角色，新会话要**重新叫人**（`member_spawn role=<id>`）。

## 角色（现场枚举 `roles/`）

<!-- ROSTER:BEGIN —— 本段由 `lib/roster.js` 生成，别手改；改角色请加/删 `roles/<id>/ROLE.md` 再跑 `npm run roster:write` -->
共 **19** 个角色（现场枚举 `roles/` 下每个目录的 `ROLE.md`）：

`ai-engineer` · `analyst` · `architect` · `backend-engineer` · `ceo` · `content-editor` · `customer-success-manager` · `data-engineer` · `devops-engineer` · `finance` · `frontend-engineer` · `legal` · `marketer` · `product-owner` · `qa` · `reviewer` · `sales` · `security` · `ux-designer`

（这一份是**包内发布面**；本机用户角色根里的角色不列在这里 —— 面板「成员」块里能看到全部）
<!-- ROSTER:END -->

每个角色干什么，读它自己那份 `team/roles/<id>/ROLE.md`（唯一正文，这里不复述）。包内角色**不绑定技能**；要绑就在面板「角色」的编辑里多选（写进工作区 / 用户那份副本，包内只读）。

## 角色与技能写在哪

同名时**高处赢**：工作区根 > 用户根 > 包内（枚举顺序的唯一正文是 `lib/roster.js`）。

| 写的东西 | 缺省落点（只影响本项目） | 跨项目要显式 `scope: "user"` |
| --- | --- | --- |
| 技能 | `<项目根>/.dsh/skills` | `~/.dsh/skills`（所有工作区可见） |
| 角色 | `<工作区>/.dsh/team-ops/roles/<id>/ROLE.md` | `~/.dsh/team-ops/roles/<id>/ROLE.md` |

判据：**项目内的踩坑总结 / 行为约束 ⇒ 缺省**；**跨项目可复用的作业程序 / 角色 ⇒ 显式 `user`**。能写技能与角色的只有两条路：**面板**与协调器的 `skill_define` / `role_define`（插件不记录写入者，要查只能靠时间戳与 `.bak` 反推）。

## 角色包：把自建角色打成一个文件带走

包内角色随插件发布，能打包的是**你自己建的那部分**（工作区根 + 用户根）。

- **导出**：面板「成员 → 角色」节头的「导出」打包全部自建角色为 `.dshroles.json`（单卡「导出」只打这一个），一并带上它们 `skills:` 指向的**自建技能**；没有自建角色时不产空包。
- **导入**：先预览每个角色是新的、已存在、还是会遮蔽包内同名角色，再选本工作区 / 全局；**默认不覆盖**（同名跳过，要覆盖得在预览里显式勾，覆盖前留 `.bak`）。
- 命令行同一判定：

```bash
npm run role:list
npm run role:export -- --out roles.dshroles.json
npm run role:import -- --in roles.dshroles.json --dry-run
npm run role:import -- --in roles.dshroles.json --scope user
```

格式、白名单与导入判定都在 `lib/role-pack.js`（面板与命令行只是两个调用方）。

## 它不做什么

- **不注册预设、不往技能注册表里加东西**：团队能力随插件装载，跑哪个预设都一样。
- **不碰 DSH 本体，也不动别人的插件**：落盘都在本包与工作区范围内。
- **不替人做决定**：对外承诺 / 花钱收钱 / 涉及法律效力 / 改变既定方向 —— 一律停下来问人。
- **不销毁任何会话**：原生名册只增不减，不用的**不再派活**即可，宿主侧那个子会话仍在。

## 卸载

```bash
pnpm --dir ~/.dsh/profiles/desktop remove dsh-team-ops   # 再从 dsh.profile.bundles 去掉那一行
```

`.ops/` 里四份真源（`human.json` / `roles.json` / `roster.json` / `member-flags.json`）删了会丢状态；`.ops/board.json` / `.ops/members.json` 是遗留文件（见上，可直接删）；`handoff.json` 与 `checkpoints/` 是派生物，删了不影响实时读数。

## 版本与宿主兼容

按 `package.json` 的 `engines.dsh` 判断：

| 插件版本 | 宿主版本 | 状态 |
|---|---|---|
| ≤ 0.26.5 | ≤ 0.2.1 | 旧成员 API |
| 0.26.6 | ≥ 0.2.2-rc.2 | 新 subagent 体系，成员层完整 |
| 更高版本 | 以各自 `engines.dsh` 为准 | — |

宿主启动时**禁用**不满足的插件行，安装时回 `incompatible-version`；可按「插件名@版本 + 精确宿主版本」申请豁免。

## 升级

插件按 **git 依赖**安装（不钉 sha），升级 = 让 pnpm 重新解析：

```bash
cd ~/.dsh/profiles/desktop
NODE_TLS_REJECT_UNAUTHORIZED=0 pnpm update dsh-team-ops --config.strict-ssl=false --config.minimumReleaseAge=0
# 卡在别家包元数据（自签证书代理下常见）时：先把 pnpm-lock.yaml 与 node_modules/.modules.yaml 里
# dsh-team-ops 的 commit 号换成新 HEAD，再
NODE_TLS_REJECT_UNAUTHORIZED=0 pnpm install --frozen-lockfile --config.strict-ssl=false --config.minimumReleaseAge=0
```

启动日志会印版本号（`team-ops 运行时已装载（v0.27.5）…`；读不到会如实印"读不到"）。**升级后要重启 DSH**：工具与注入策略段是装载时装配的。

## 代码结构与维护

给改这个包的人看的地图：

- **宿主半边**：`lib/board-view.host.js` 是 `cordis.patch.yml` 里唯一的 loader entry（路由常量表、`routeTable()`、两个引擎的 `apply`）；端点按族住在 `lib/*-routes.js`，写侧边界与工作区解析在 `lib/workspace-io.js`，共享正文在 `lib/http-tools.js` / `lib/ledger-store.js` / `lib/panel-shaping.js` 等；润色、检查点、会话事件、交接摘要分别在 `lib/polish.js`、`lib/checkpoint.js`、`lib/session-watch.js`、`lib/ledger-digest.js`。
- **引擎半边**：`team/company-gate.js`（制度层）与 `team/team-runtime.js`（成员 / 角色 / 技能工具与注入段），由宿主行自己 apply。
- **浏览器半边**：源码按分区在 `client-src/*.part`（18 段），`scripts/build-client.mjs` 字节级拼成发布物；**改界面要改片段再 `npm run build:client`**，`npm test` 钉住两者逐字节一致。
- **常用命令**：`npm test`（全部行为断言）/ `npm run verify`（语法 + 名册 + 自检）/ `npm run build:client` / `npm run bench` / `npm run publish:github`（发纯代码树到 GitHub `main`）/ `npm run release:local`（本机调试安装）。

## 细则在哪

| 想看什么 | 去哪 |
| --- | --- |
| 团队规则（怎么派活 / 什么时候问人 / 记账 / 交付物） | `team/BASELINE.md` |
| 某个角色的职责与作业程序 | `team/roles/<id>/ROLE.md` |
| 端点 / 状态文件 / 浏览器半边住在哪 | 上面的「代码结构与维护」 |
| 为什么这么实现 | `lib/*.js` 与 `team/*.js` 的注释 |
| 什么算合格 | `npm test`（判据是可执行断言） |
