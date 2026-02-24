# opencode-workbench

Lightweight bindings between git worktrees and OpenCode sessions for parallel development.

This plugin does **not** create sandboxes or sync files. Instead, it:

- injects a prompt that guides the AI to use `git` and `gh` directly
- records bindings (worktree dir, branch, session id, fork/upstream/PR metadata)
- auto-routes built-in Task `task_id` in workbench supervisor/implementation sessions when unambiguous
- provides a small Studio UI that shows your bindings (session-scoped by default)
- enforces git-only directories for bind/open/task (non-git dirs are rejected with guidance)

## Install

Add to your OpenCode config (`.opencode/opencode.jsonc`):

```jsonc
{
  "plugin": [
    "opencode-workbench"
  ]
}
```

Optionally pin a version:

```jsonc
{
  "plugin": [
    "opencode-workbench@0.1.0"
  ]
}
```

For local development, you can also load it via `file://` (point to a built JS file).

## Tools

The plugin exposes one tool:

- `workbench`: manage bindings/session metadata, open pinned sessions, and run directory-aware task prompts

Full help:

```text
workbench { action: "help" }
```

Use this tool when you need parallel work across branches/worktrees (git worktree, GitHub fork, multiple branches at once).

Note: `bind`, `open`, and `task` require a real git repository/worktree. If git is not detected, workbench returns an error that tells the AI/user to initialize or create a repo first (for example `git init`).

Actions:

- `help`: show full usage help.
- `bind`: create/update a binding (defaults to current session)
  - validates `upstream`/`fork` as `OWNER/REPO`
  - validates `prUrl` as `https://<host>/<owner>/<repo>/pull/<number>`
  - supports metadata clearing via `clear: "prUrl"` or `clear: "github"`
- `open`: create/reuse a pinned child session for a binding
- `task`: run a prompt in a routed workbench session (optionally by `dir` or `task_id`)
- `list`: list bindings (defaults to current session; use `scope: "repo"` for repo)
- `info`: show a binding (defaults to current session)
- `remove`: remove a binding (defaults to current session)
- `doctor`: check tooling and repo identity

Name-only operations (`open/info/remove` with `name` but no `dir`) can resolve from session scope first, then repo/global scope when the name is unique.

Scopes:

- Default is session-scoped (minimal/no noise).
- Session scope includes current session and direct child-session bindings (supervisor-friendly).
- Use `scope: "repo"` to list bindings for the current git repo (if you're not inside the repo, pass `dir: "path/to/repo"`).
- Use `scope: "all"` to list bindings across all repos.

Session targeting params (optional):

- `parentSessionId`: override supervisor session id (default: current session id)
- `sessionId`: explicit child/target session id for list/info/task lookups
- `strict`: for `info`, fail on ambiguity instead of auto-selecting the latest binding

Task isolation:

- Concurrent `workbench { action: "task" }` calls targeting the same session are serialized to avoid response cross-talk.
- Use different `dir`/`task_id` values when you want true parallel execution.
- Task output includes `task_queue_ms`, `task_run_ms`, and `task_queued` for queue observability.

Suggested governance workflow:

- Supervisor session focuses on orchestration; child sessions do implementation.
- Supervisor should not edit child implementation files directly; route file work to child sessions.
- Build/check/fmt/test should run in the target child worktree session (not supervisor) to avoid wrong-directory execution.
- If changes are in child worktrees, supervisor-local build/check/fmt/test is usually meaningless and should be skipped.
- Child sessions run their own `git commit`, `git push`, and `gh pr merge`.
- Child reports readiness with suggested next delivery steps; supervisor decides routing.
- For commit/push/PR/merge/cleanup milestones, supervisor should proactively confirm user approval and require green PR checks/GitHub Actions before merge; if checks fail, route fixes back to child.
- Unless user approval is already explicit/preapproved, supervisor should ask before each next delivery/cleanup step and, after each step result, ask whether to continue.
- User may preapprove those delivery actions; supervisor should restate the approval in the prompt flow.
- Prefer child-session reuse (`open/list/info` first) and only create new child sessions when necessary.
- For cleanup actions (binding removal, storage cleanup, remote branch cleanup), supervisor should confirm with the user first unless already requested.
- For cold-start heavy stacks, supervisor should decide and coordinate safe cache seeding into new worktrees (for example `node_modules`, `cargo target`, or other tool caches) when compatible.

## Configuration

No project config file is required.

Bindings are stored under your state directory:

- `$XDG_STATE_HOME/opencode/workbench/entries/`
- fallback: `~/.local/state/opencode/workbench/entries/`

## Publishing (npm)

Suggested checklist before `npm publish`:

- Update `package.json` version
- Run `bun run publish:check`
- Ensure `npm whoami` works and publish with the right access (scoped packages usually need `--access public`)

## Example

Keep worktrees inside the repo directory (recommended):

- Add `.workbench/` to the repo `.gitignore`
- Create worktrees under `.workbench/` (example): `git worktree add .workbench/feature-x feature/x`

Bind a worktree directory and open a pinned OpenCode session:

```text
workbench { action: "open", dir: ".workbench/feature-x", name: "feature-x" }
```

Suggested split:

- Keep the top-level session focused on orchestration (`git`, `gh`, `workbench`) when running parallel branches.
- Run implementation prompts with `workbench { action: "task", ... }` so routing stays worktree-aware.

```text
workbench { action: "task", dir: ".workbench/feature-x", prompt: "Implement feature", agent: "general" }
```

If you need explicit parent+child visibility in supervisor workflows:

```text
workbench { action: "list", scope: "session", parentSessionId: "ses_parent", sessionId: "ses_child" }
```

In workbench supervisor/implementation sessions, built-in `task` with `directory` is blocked; use `workbench { action: "task", ... }` instead.

If routing is ambiguous, get session id and pass `task_id` explicitly:

```text
workbench { action: "info" }
workbench { action: "task", task_id: "ses_xxx", prompt: "Implement feature" }
```

Record PR metadata so the Studio UI can show it:

```text
workbench { action: "bind", name: "my-thing", upstream: "org/repo", fork: "me/repo", prUrl: "https://github.com/org/repo/pull/123" }
```

Clear stale metadata explicitly when needed:

```text
workbench { action: "bind", name: "my-thing", clear: "prUrl" }
workbench { action: "bind", name: "my-thing", clear: "github" }
```

## Housekeeping

Doctor (non-destructive):

```text
workbench { action: "doctor" }
```

Remove a binding:

```text
workbench { action: "remove", name: "my-thing" }
```

## Notes

- `workbench` intentionally keeps file operations out of scope (metadata + binding only).
- Use `workbench { action: "task", ... }` for directory-aware implementation prompts in bound worktrees.
- Use `git worktree`, `git switch`, `git push`, and `gh pr create/edit` directly for git/GitHub workflows.
