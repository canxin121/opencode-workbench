# opencode-workbench

Chinese version: [README.zh-CN.md](README.zh-CN.md)

opencode-workbench is built for concurrent delivery: it maps git worktrees to OpenCode sessions so multiple tasks can run in parallel with clear routing, ownership, and integration flow.

## Why Teams Use Workbench

- Run many tasks concurrently across isolated branches/worktrees without collisions.
- Fan out parallel task execution from one supervisor workflow with deterministic routing.
- Keep per-session execution safe while maintaining high overall concurrency.
- Track branch/fork/PR metadata per binding to coordinate fast parallel delivery.
- Enforce supervisor/worker boundaries for reliable, scalable multi-task execution.

## Installation

Add the plugin to your OpenCode config file `opencode.json`:

- Unix/macOS: `~/.config/opencode/opencode.json`
- Windows: `%USERPROFILE%\\.config\\opencode\\opencode.json` (for example: `C:\\Users\\<your-user>\\.config\\opencode\\opencode.json`)

```jsonc
{
  "plugin": ["opencode-workbench"]
}
```

Optional version pin:

```jsonc
{
  "plugin": ["opencode-workbench@0.3.2"]
}
```

## Quick Start with Natural Language

Example prompts:

```text
1. Use workbench for parallel work. Task list: 1. ** 2. **
2. Use workbench for high-concurrency parallel work, use gh, and take the workflow all the way through PR creation and merge without follow-up confirmation. Task list: 1. ** 2. **
```

## OpenCode Studio Experience

Workbench includes OpenCode Studio integration so concurrent branch/task orchestration is visible at a glance:

- Learn more: [opencode-studio](https://github.com/canxin121/opencode-studio)

- Session binding overview in Studio (worktree, branch, session linkage).
- Metadata visibility (fork/upstream/PR) for faster coordination.
- Better supervisor control when dispatching and reviewing multiple child sessions.

For teams running multi-branch development daily, OpenCode Studio is the recommended control center to monitor workers, keep routing clean, and reduce context switching.

## Details

Detailed action contracts, parameter-level behavior, scope/session targeting rules, and governance guidance are documented in `DETAIL.md`.

## License

MIT
