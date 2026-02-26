# opencode-workbench

Lightweight bindings between git worktrees and OpenCode sessions for parallel development.

This plugin does **not** create sandboxes or sync files. Instead, it:

- injects only a minimal global workbench reminder, plus a worker-session role hint for bound child sessions
- records bindings (worktree dir, branch, session id, fork/upstream/PR metadata)
- routes `workbench { action: "task" }` by worktree/session and keeps child-session execution serialized per target session
- keeps `workbench` tool usage supervisor-only (bound child worker sessions cannot invoke `workbench` directly)
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

Use this tool when you need parallel work across branches/worktrees (git worktree, optional GitHub fork, multiple branches at once).

Note: `bind`, `open`, and `task` require a real git repository/worktree. If git is not detected, workbench returns an error that tells the AI/user to initialize or create a repo first (for example `git init`).

Actions:

- `help`: show full usage help.
- `bind`: create/update a binding (defaults to current session)
  - validates `upstream`/`fork` as `OWNER/REPO`
  - validates `prUrl` as `https://<host>/<owner>/<repo>/pull/<number>`
  - supports metadata clearing via `clear: "prUrl"` or `clear: "github"`
- `open`: create/reuse a pinned child session for a binding
- `task`: run a prompt in a routed workbench session (optionally by `dir` or `task_id`); child prompt agent is inherited from the parent session and child permission/question requests are auto-rejected during relayed runs
- note: bound child worker sessions cannot run `workbench` actions directly; use the supervisor session
- `list`: list bindings (defaults to current session; use `scope: "repo"` for repo)
- `info`: show a binding (defaults to current session)
- `remove`: remove a binding (defaults to current session)
- `doctor`: check tooling and repo identity

Name-only operations (`open/info/remove` with `name` but no `dir`) can resolve from session scope first, then repo/global scope when the name is unique.

Scopes:

- Default is session-scoped (minimal/no noise).
- Session scope includes current session and direct child-session bindings (supervisor + workers).
- Use `scope: "repo"` to list bindings for the current git repo (if you're not inside the repo, pass `dir: "path/to/repo"`).
- Use `scope: "all"` to list bindings across all repos.

Session targeting params (optional):

- `parentSessionId`: override supervisor/parent session id (default: current session id)
- `sessionId`: explicit child/target session id for list/info/task lookups
- `strict`: for `info`, fail on ambiguity instead of auto-selecting the latest binding

Task isolation:

- Concurrent `workbench { action: "task" }` calls targeting the same session are serialized to avoid response cross-talk.
- Use different `dir`/`task_id` values when you want true parallel execution.
- Task output includes `task_queue_ms`, `task_run_ms`, and `task_queued` for queue observability.

Suggested governance workflow:

- Mandatory rule: once you use `workbench`, follow `workbench { action: "help" }` workflow, role boundaries, and verification gates.
- Run workbench orchestration actions from the main repository working copy on the base branch, not from child worktree directories.
- Supervisor session owns workflow-level orchestration (routing, review, merge order, verification gates, final integration).
- If the supervisor creates a plan (including plan-tool output), plan steps should map to supervisor workflow stages only.
- Supervisor plans should not include per-task implementation details or per-child content-summary steps.
- Child worker sessions own detailed per-task planning/implementation and run required `check`/`fmt`/`test` (plus project-required validators) in their bound worktree.
- When dispatching child tasks, explicitly require those local checks to pass in the child worktree before readiness handoff.
- Do not use GitHub CI status as a child-task completion gate; CI gates belong to supervisor merge decisions.
- Supervisor should not directly edit/read/build inside child-owned worktree paths; dispatch via `workbench { action: "task", ... }`.
- Before merge, enforce verification gates: with `gh`, required PR/CI checks must be green; without `gh`, required local checks must be green.
- Never merge/integrate when verification evidence is missing or failing.
- Child sessions should sync with target base, resolve conflicts in the child branch, and report readiness evidence.
- Child sessions should not perform final integration into the supervisor base branch.
- Supervisor performs final integration with git (baseline) or gh (optional) after approvals/checks.
- For git-only delivery, prefer deterministic integration (`git pull --ff-only`, then approved merge strategy).
- For GitHub-linked delivery, require `gh` installation/authentication before PR/check/merge steps.
- Prefer child-session reuse (`open/list/info` first) and create new child sessions only when necessary.
- Keep cleanup actions (binding removal, worktree deletion, `.workbench/<name>` subdirectory removal, remote branch pruning) explicit and user-approved.

Optional GitHub CLI modes:

- git-only baseline: keep the full local parallel->merge flow in git.
- With `gh`: optionally route GitHub PR creation/status/merge checks through `gh` in child sessions.
- Without `gh` (for GitHub-linked work): pause those GitHub milestones and install/authenticate `gh` first.

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

- Keep the top-level session as supervisor (`git`, optional `gh`, `workbench`) when running parallel branches.
- Dispatch implementation prompts with `workbench { action: "task", ... }` so routing stays worktree-aware.

```text
workbench { action: "task", dir: ".workbench/feature-x", prompt: "Implement feature" }
```

If you need explicit parent+child visibility in supervisor workflows:

```text
workbench { action: "list", scope: "session", parentSessionId: "ses_parent", sessionId: "ses_child" }
```

In workbench child worker sessions, `workbench` is blocked and built-in `task` is blocked to prevent nested delegation loops; use the parent supervisor session to dispatch additional work.

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
- Use `git worktree`, `git switch`, and `git push` directly for local flow; if needed, use `gh pr create/edit` as optional GitHub integration.
