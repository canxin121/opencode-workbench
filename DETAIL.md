# Workbench Details

Chinese version: [DETAIL.zh-CN.md](DETAIL.zh-CN.md)

This document contains the low-level contract for `opencode-workbench`.
For user-facing value, installation, and quick usage, see `README.md`.

## Tool Purpose

`workbench` binds git worktree directories to OpenCode sessions and routes prompts to the correct worker context.

Core design constraints:

- No sandbox creation or file sync logic.
- Metadata + routing only.
- Supervisor session owns `workbench` orchestration.
- Bound child worker sessions cannot invoke `workbench` directly.

## Action Surface

The plugin exposes one tool: `workbench`.

Primary actions:

- `help`: full usage help.
- `bind`: create/update binding metadata.
- `open`: create/reuse a pinned child session for a binding.
- `task`: route a prompt to a bound worker session.
- `list`: list bindings by scope.
- `info`: inspect one binding.
- `remove`: remove a binding.
- `doctor`: non-destructive environment and repo checks.

## Validation and Repository Requirements

- `bind`, `open`, and `task` require a real git repo/worktree.
- Non-git directories are rejected with guidance.
- `upstream` and `fork` must match `OWNER/REPO`.
- `prUrl` must match `https://<host>/<owner>/<repo>/pull/<number>`.
- Metadata cleanup is explicit via `clear: "prUrl"` or `clear: "github"`.

## Scopes and Lookup Rules

- Default scope is `session`.
- `session` scope includes current session and direct child-session bindings.
- `repo` scope lists bindings for the current repo (or `dir` target).
- `all` scope lists bindings across repos.

Name-only operations (`open/info/remove` with `name` but no `dir`) resolve in this order:

1. Session scope.
2. Repo/global scope when the name is unique.

## Session Targeting Parameters

Optional targeting fields:

- `parentSessionId`: override supervisor session id.
- `sessionId`: explicit child/target session id for lookup.
- `task_id`: explicit routed task session when dispatching.
- `strict`: for `info`, fail on ambiguity instead of selecting latest.

## Task Routing and Isolation Semantics

- `workbench { action: "task" }` routes by binding/session target.
- Calls targeting the same child session are serialized to prevent cross-talk.
- Use different `dir`/`task_id` targets for parallel execution.
- Telemetry includes queue/run timing (`task_queue_ms`, `task_run_ms`, `task_queued`).
- During relayed task runs, child permission/question requests are auto-rejected.

## Governance Pattern (Supervisor + Workers)

Recommended operational model:

- Run orchestration from a supervisor session in the main working copy.
- Keep worker implementation inside bound worktrees only.
- Supervisor owns routing, verification gates, and final integration.
- Workers own per-task implementation and local validation (`check`, `fmt`, `test`, plus project-required validators).
- Do not treat GitHub CI as the only child completion signal; use explicit readiness evidence.
- Never integrate when required verification evidence is missing/failing.

Integration policy:

- Git baseline: deterministic local integration after checks.
- GitHub-linked flow: require `gh` install/auth before PR/check/merge actions.

## State Storage

Bindings are persisted in state storage:

- `$XDG_STATE_HOME/opencode/workbench/entries/`
- fallback: `~/.local/state/opencode/workbench/entries/`

## Studio Integration Notes

- Manifest: `dist/studio.manifest.json`
- Bridge: `dist/studio-bridge.js`
- Web mount: `dist/studio-web/workbench-bar.js`

Studio panel surfaces binding/session metadata so supervisors can monitor routing state quickly.

## Advanced Usage Snippets

```text
workbench { action: "open", dir: ".workbench/feature-x", name: "feature-x" }
workbench { action: "task", dir: ".workbench/feature-x", prompt: "Implement feature" }
workbench { action: "bind", name: "my-thing", upstream: "org/repo", fork: "me/repo", prUrl: "https://github.com/org/repo/pull/123" }
workbench { action: "bind", name: "my-thing", clear: "github" }
workbench { action: "doctor" }
```
