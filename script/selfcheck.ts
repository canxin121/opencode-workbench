import WorkbenchPlugin from "../src/index"
import { tool } from "@opencode-ai/plugin"
import path from "node:path"
import os from "node:os"
import { mkdir, rm } from "node:fs/promises"

async function cmd(cwd: string, command: string[]) {
  const res = await Bun.$`${command}`.cwd(cwd).nothrow().quiet()
  if (res.exitCode !== 0) {
    throw new Error(`command failed: ${command.join(" ")}\n${res.stderr.toString() || res.stdout.toString()}`)
  }
  return res.text().trim()
}

async function main() {
  const base = path.join(os.tmpdir(), `opencode-workbench-selfcheck-${Date.now()}`)
  const state = path.join(base, "state")
  const repo = path.join(base, "repo")
  await mkdir(base, { recursive: true })
  await mkdir(state, { recursive: true })
  await mkdir(repo, { recursive: true })

  await cmd(repo, ["git", "init", "-q"])
  await Bun.write(path.join(repo, "README.md"), "hello\n")
  await cmd(repo, ["git", "add", "README.md"])
  await cmd(repo, ["git", "-c", "user.name=demo", "-c", "user.email=demo@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "init", "-q"])
  await cmd(repo, ["git", "branch", "-M", "main"])
  await cmd(repo, ["git", "config", "user.name", "demo"])
  await cmd(repo, ["git", "config", "user.email", "demo@example.com"])
  await cmd(repo, ["git", "config", "commit.gpgsign", "false"])

  await mkdir(path.join(repo, ".opencode"), { recursive: true })
  await Bun.write(path.join(repo, ".opencode", "opencode.jsonc"), "{}\n")
  await Bun.write(
    path.join(repo, ".opencode", "workbench.toml"),
    [
      'copyMode = "worktree"',
      'commitBodyAuto = true',
      'stage = "tracked"',
      'lockTimeout = 60',
      '',
    ].join("\n"),
  )

  await cmd(repo, ["git", "add", ".opencode"])
  await cmd(repo, ["git", "commit", "--no-gpg-sign", "-m", "add workbench config", "-q"])

  await Bun.write(path.join(repo, "LOCAL.txt"), "local\n")

  const ctx: any = {
    directory: repo,
    worktree: repo,
    project: { id: "proj", worktree: repo, vcs: "git" },
    serverUrl: "http://localhost",
    $: Bun.$,
    client: {
      path: {
        get: async () => ({ data: { state } }),
      },
      vcs: {
        get: async () => ({ data: { branch: "main" } }),
      },
      app: {
        log: async () => ({ data: true }),
      },
      session: {
        create: async () => ({ data: { id: "ses_test" } }),
        promptAsync: async () => ({ data: undefined }),
      },
    },
  }

  const hooks: any = await WorkbenchPlugin(ctx)
  const def = hooks.tool.workbench
  const schema = tool.schema.object(def.args)
  const toolCtx: any = {
    sessionID: "ses_parent",
    messageID: "msg",
    agent: "test",
    directory: repo,
    worktree: repo,
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  }

  const name = "sbx"
  await def.execute(
    schema.parse({ action: "create", name, branch: "main", sourceWorktree: repo }),
    toolCtx,
  )

  const sandbox = path.join(state, "workbench", "sandboxes", "proj", name)
  const meta = path.join(sandbox, ".opencode-workbench.json")
  if (!(await Bun.file(meta).exists())) throw new Error("meta file not created")
  if (!(await Bun.file(path.join(sandbox, "LOCAL.txt")).exists())) throw new Error("copyMode config not applied")

  await rm(path.join(repo, "LOCAL.txt"), { force: true })

  await Bun.write(path.join(sandbox, "README.md"), "changed\n")
  await def.execute(schema.parse({ action: "preview", sandbox: name, targetWorktree: repo }), toolCtx)

  await def.execute(
    schema.parse({
      action: "publish",
      sandbox: name,
      targetWorktree: repo,
      commitMessage: "workbench: selfcheck",
    }),
    toolCtx,
  )

  const log = await cmd(repo, ["git", "log", "-1", "--pretty=%s"])
  if (!log.includes("workbench")) throw new Error("publish did not commit")

  const body = await cmd(repo, ["git", "log", "-1", "--pretty=%b"])
  if (!body.includes("Files:")) throw new Error("commitBodyAuto config not applied")

  await def.execute(schema.parse({ action: "checkpoint", sandbox: name, name: "sbx2" }), toolCtx)
  await def.execute(schema.parse({ action: "reset", sandbox: name, resetBackup: false, resetDelete: true }), toolCtx)
  await def.execute(schema.parse({ action: "rename", sandbox: name, renameTo: "sbx-renamed", force: true }), toolCtx)
  await def.execute(schema.parse({ action: "gc", gcDays: 0, gcApply: false }), toolCtx)

  await rm(base, { recursive: true, force: true })
  console.log("selfcheck ok")
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
