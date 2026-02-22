# opencode-workbench

Create isolated per-branch sandboxes for parallel development with OpenCode.

This plugin is designed for workflows where you use `git worktree` / GitHub forks to develop in parallel,
but you still want each OpenCode sub-session to operate in its own temporary copy (sandbox) to avoid
editing the wrong branch directory.

## Install

Add to your OpenCode config (`.opencode/opencode.jsonc`):

```jsonc
{
  "plugin": [
    "opencode-workbench@0.1.0"
  ]
}
```

For local development, you can also load it via `file://` (point to a built JS file).

## Tool

The plugin exposes a single tool: `workbench`.

Actions:

- `create`: create a git worktree (optional), build a sandbox copy, and create a child session pinned to that sandbox.
- `create` with `github=true`: also runs `gh` + local `git` remote wiring (ensure fork exists, add/repair fork+upstream remotes) in the same invocation.
- `list`: list known sandboxes.
- `info`: show sandbox metadata (paths, session id, PR url).
- `doctor`: check git/gh/rsync/tar availability and repo wiring.
- `preview`: show a dry-run sync plan (rsync-based).
- `sync`: copy sandbox contents back to its recorded source worktree.
- `publish`: sync + commit + push + PR (optional flags, defaults to push/PR when GitHub context exists).
- `checkpoint`: create a copy of a sandbox as a new sandbox.
- `reset`: rebuild sandbox contents from the recorded source worktree.
- `rename`: rename a managed sandbox directory.
- `gc`: garbage-collect old/orphan sandboxes (dry-run by default).
- `cleanup`: remove sandbox and optionally its managed worktree.

## Configuration

`opencode-workbench` reads a dedicated project config file (not `opencode.json`) from:

- `.opencode/workbench.toml`

This file lives in the same folder as `.opencode/opencode.json*`.
All keys are optional; when omitted, safe defaults apply.

Example `.opencode/workbench.toml`:

```toml
# Defaults for the workbench tool
copyMode = "worktree"
copyExcludeMode = "append"
copyExclude = ["node_modules", "dist", "build"]

# GitHub wiring
github = true
ghHost = "github.com"
upstreamRemote = "upstream"
forkRemote = "fork"
protocol = "auto"
fetch = true

# PR defaults
pr = true
draft = true
prLabels = ["workbench"]
prReviewers = ["myorg/team"]

# Publish defaults
stage = "tracked"
commitBodyAuto = true
lockTimeout = 3600
```

## One-command fork + sandbox

Example: create a sandbox for a feature branch, and ensure your GitHub fork remotes exist.

```text
workbench { action: "create", github: true, branch: "feature/my-thing" }
```

If you want the sandbox to include local edits and untracked files (instead of only committed tracked files), use `copyMode: "worktree"`:

```text
workbench { action: "create", github: true, branch: "feature/my-thing", copyMode: "worktree" }
```

By default, `copyMode: "worktree"` excludes large/common build artifacts (like `node_modules`).
If you want to fully control the exclude list, set `copyExcludeMode: "replace"`.

If you also want to push the branch to your fork automatically:

```text
workbench { action: "create", github: true, branch: "feature/my-thing", push: true }
```

If the branch does not exist locally yet, `create` will (by default) create it from the upstream default branch.
You can override this with `base`:

```text
workbench { action: "create", github: true, branch: "feature/my-thing", base: "dev" }
```

## One-command PR

Create (or reuse) an upstream PR for this fork branch in the same invocation:

```text
workbench { action: "create", github: true, branch: "feature/my-thing", pr: true }
```

## One-command publish

After you finished editing inside the sandbox, publish the changes back to the source worktree:

```text
workbench { action: "publish", sandbox: "<sandbox-name>" }
```

This will:

- sync sandbox -> worktree
- require a clean target worktree (unless `allowDirty: true`)
- `git add -A` + `git commit`
- `git push -u fork <branch>` and create/update PR when GitHub context exists

You can change staging behavior:

```text
workbench { action: "publish", sandbox: "<sandbox-name>", stage: "tracked" }
```

And generate a commit body with a file list:

```text
workbench { action: "publish", sandbox: "<sandbox-name>", commitBodyAuto: true }
```

Preview what would sync (no files are changed):

```text
workbench { action: "preview", sandbox: "<sandbox-name>" }
```

Propagate deletions from sandbox to target (dangerous; requires a clean target by default):

```text
workbench { action: "publish", sandbox: "<sandbox-name>", delete: true }
```

## Housekeeping

Doctor (non-destructive):

```text
workbench { action: "doctor" }
```

Checkpoint a sandbox (create a copy):

```text
workbench { action: "checkpoint", sandbox: "<sandbox-name>", name: "<new-name>" }
```

Reset a sandbox back to the source worktree (by default makes a checkpoint backup first):

```text
workbench { action: "reset", sandbox: "<sandbox-name>" }
```

Rename a sandbox (if it has a session, use `force: true`). Note: OpenCode session directory is not updated; continue with `--dir`:

```text
workbench { action: "rename", sandbox: "<sandbox-name>", renameTo: "<new-name>", force: true }
```

Garbage collect (dry-run):

```text
workbench { action: "gc", gcDays: 30 }
```

Apply deletions:

```text
workbench { action: "gc", gcDays: 30, gcApply: true }
```

Draft PR with custom title/body:

```text
workbench {
  action: "create",
  github: true,
  branch: "feature/my-thing",
  pr: true,
  draft: true,
  prTitle: "feat: my thing",
  prBody: "What changed and why"
}
```

Add labels/reviewers/assignees in the same invocation:

```text
workbench {
  action: "create",
  github: true,
  branch: "feature/my-thing",
  pr: true,
  prLabels: ["workbench", "enhancement"],
  prReviewers: ["myorg/team"],
  prAssignees: ["@me"]
}
```

## Notes

- Sandboxes are stored under OpenCode's state directory (see `/path` API) in `workbench/`.
- Sandbox content is created via `git archive` (tracked files only) to avoid copying `.git/` and bulky artifacts.
