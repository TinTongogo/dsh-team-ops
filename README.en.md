# dsh-team-ops

> A condensed English overview. The Chinese [README.md](README.md) is the full document and stays
> canonical — installation details, upgrade notes and the full tables live there.

Installs a named role team into **DeepSeek Harness**: built-in roles (architect, frontend / backend
engineer, QA, reviewer, marketing, legal, finance, …), a shared task board backed by the host's own
Agent Teams, and tools to spawn, message and inspect teammates. A member is not removed when its work
is done — it simply stops getting work; the human only approves or vetoes.

What separates it from "open a few more chats": team state is readable and traceable. The board and the
roster are the host's own objects (panel and tools read the same source); the role catalogue, every
decision the human recorded and the per-role switches are plain files inside the workspace, so the next
session still reads them. Who is doing what, what is blocked, who picks it up — one question, one answer.

## Requirements

- DSH `^0.2.2-rc.2`, declared as `engines.dsh`. Older hosts lack `subagents.startActivation`; the member
  layer then reports the capability as incomplete instead of pretending it works.
- Node `^22.19.0 || >=24.0.0`.
- Installs as a bundle: `package.json` declares `dsh.bundle` and ships the `cordis.patch.yml` next to it.

## Install

```bash
pnpm --dir ~/.dsh/profiles/desktop add 'git+https://github.com/TinTongogo/dsh-team-ops.git'
```

Then restart DSH. A client-only change needs a page reload instead of a restart. Updating follows the
same path (`pnpm update dsh-team-ops`); pushing to the repository without updating keeps the copy the
profile already has, which is the most common "my change did not land". DSH's own plugin manager can
install it as well (`dsh plugin add <git spec>`).

Uninstall: remove the dependency from the profile and drop `dsh-team-ops` from `dsh.profile.bundles`.

## What appears in the UI

- A **Team status** panel in the conversation page with four tabs: **Members / Roles / Skills / Task board**.
- A **Role** button at the left of the composer: pick a role, it inserts `@role` into the draft. That
  mention is a directive — the work is handed to that role.
- A **Polish** button next to send: one tool-less model call rewrites the current draft into a more
  concrete, directly actionable request (same language as the draft, about 800 characters at most, code,
  links, paths and `@mentions` kept verbatim) and replaces the draft in place. One click undoes it.
- Task cards show the owner and lock state, handoffs (who → who), and risk tags: blocked dependencies,
  overlapping write scopes, absent member, parallel load.

## Tools (16)

| Tool | What it does |
| --- | --- |
| `member_defaults` | The only entry point for "who can I call": every role with a one-line positioning, its definition path, and who is on stage for that role. Delisted roles are not listed; they come back in a separate `hidden` field. |
| `member_spawn` | Spawn a named teammate for a role, or hand the work to one already on stage. |
| `member_send` | Durable message to a teammate (or to `lead`). |
| `member_list` | Read the host's native roster. |
| `board_task` | Register, query, claim, complete, reassign tasks on the native team board (three states). |
| `team_status` | "Where are we" in two lines: the three counters plus what is blocked. |
| `team_metrics` | Collaboration readout: handoffs with missing fields, path-ownership conflicts, package gaps. |
| `team_checkpoint` | Append a structured checkpoint (facts, decisions, artifacts, open questions, next steps) for a task before compaction or close. |
| `human_words_record` | Record something the human said — a goal, a constraint, a preference, a veto. Returns an approval id. |
| `human_words_list` | Read back what the human has decided, so nobody asks the same question twice. |
| `handoff` | Structured handoff pointer between roles: task, artifact, path, what the receiver must do. |
| `role_contract` | Parse which artifact paths a role owns and which it must not touch, and detect two roles owning the same path. |
| `role_define` | Create or update a role definition, in the workspace or in the user role root. |
| `role_manage` | List roles, and enable or disable one. |
| `skill_define` | Create or update a skill, in the workspace or in the user skill root. |
| `check_artifact` | Validate an artifact file (user story, test case, ADR, generic) — unique id, traceability, required sections. |

## Roles

<!-- ROSTER:BEGIN —— 本段由 `lib/roster.js` 生成，别手改；改角色请加/删 `roles/<id>/ROLE.md` 再跑 `npm run roster:write` -->
**19** roles ship with the package (enumerated from `team/roles/*/ROLE.md`):

`ai-engineer` · `analyst` · `architect` · `backend-engineer` · `ceo` · `content-editor` · `customer-success-manager` · `data-engineer` · `devops-engineer` · `finance` · `frontend-engineer` · `legal` · `marketer` · `product-owner` · `qa` · `reviewer` · `sales` · `security` · `ux-designer`

(Package release surface only. Roles in your user root are not listed here — the panel's Members tab shows all of them.)
<!-- ROSTER:END -->

Each role's instructions live in its own `team/roles/<id>/ROLE.md` — that file is the single source of
truth, this page does not restate it. Built-in roles ship without bound skills; binding is done in the
panel's Roles tab, which writes a copy into the workspace or user role root (the bundled files stay
read-only).

Where custom roles are read from, highest priority first (same id ⇒ the higher root wins):

| Root | Path | Scope |
| --- | --- | --- |
| workspace | `<workspace>/.dsh/team-ops/roles/<id>/ROLE.md` | this project only |
| user | `~/.dsh/team-ops/roles/<id>/ROLE.md` | all workspaces |
| package | the plugin's own `team/roles/` | shipped with the plugin, replaced on upgrade |

## State on disk

The workspace grows an `.ops/` directory; every file there is plain text.

| Path | Kind |
| --- | --- |
| `.ops/human.json` | source of truth — what the human said (goals / constraints / preferences / vetoes) |
| `.ops/roles.json` | source of truth — role enable/disable switches |
| `.ops/roster.json` | source of truth — delisted roles (hidden from `member_defaults`, rejected by `member_spawn`) |
| `.ops/member-flags.json` | source of truth — disabled members |
| `.ops/handoff.json` | derived snapshot — board handoff for the next session |
| `.ops/checkpoints/` | derived — raw dumps written when the host compacts a session (safe to delete) |
| `docs/team/checkpoints/<task>--<session>.md` | structured checkpoints written by `team_checkpoint` (append-only, meant to be committed) |

The board, the roster and the mailbox are **not** stored here: they belong to the host's Agent Teams.
`.ops/board.json` and `.ops/members.json` are deprecated leftovers from older versions; this plugin no
longer writes them, and neither is read.

## Cross-session continuity

The native board is per session (`TeamId = SessionId`), so a new session starts with an empty board. The
plugin therefore keeps a handoff snapshot at `.ops/handoff.json`, updated whenever the board changes
(including native `team_task_*` events). A new session can read it with
`node lib/ledger-digest.js --text`; the summary is never injected automatically.

Members do not carry across sessions either: the snapshot remembers which roles were used, and the new
session has to `member_spawn` them again (names are assigned as `<role>-<n>` from the host roster).

## Limits and what it does not do

- **Member slots**: at most 3 per role (not disabled, not `failed`), and at most 24 on stage in total —
  the latter matches the host's own `maxMembers` and counts failed and disabled members too.
- **Disabling** takes effect in this plugin's scheduling layer only: the host can still open that member's
  conversation, the native roster only grows, and this plugin has no tool to remove a member. To isolate
  someone completely, start a new session.
- **Reassignment** is checked: `board_task reassign` needs an assignee and an `expected_revision`, and a
  task that already has an owner is blocked unless it is an explicit `handover: true`.
- It does **not** register agent presets and does not add anything to the skill registry — team capability
  follows the plugin, whichever preset runs.
- It does **not** touch the host or other plugins; every write stays inside this package and the workspace.
- It does **not** decide for the human: external commitments, spending or receiving money, anything with
  legal effect, and changing an agreed direction all stop and ask.
- It does **not** destroy sessions, and it does not record who created a skill or a role.

## Where the details are

| Looking for | Where |
| --- | --- |
| Full documentation (Chinese) | [README.md](README.md) |
| Team rules: how work is dispatched, when to ask the human, what counts as done | `team/BASELINE.md` |
| A single role's duties and procedure | `team/roles/<id>/ROLE.md` |
| Whether something actually works | `npm test` — assertions, not prose |
| Why it is built this way | comments in `lib/*.js` and `team/*.js` |
| What changed and when | `git log` |

## License

MIT — see [LICENSE](LICENSE).
