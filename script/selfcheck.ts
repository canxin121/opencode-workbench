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
  const nonGitDir = path.join(base, "non-git")
  const reuseRepo = path.join(base, "reuse-repo")
  process.env.XDG_STATE_HOME = state
  await mkdir(base, { recursive: true })
  await mkdir(state, { recursive: true })
  await mkdir(repo, { recursive: true })
  await mkdir(nonGitDir, { recursive: true })
  await mkdir(reuseRepo, { recursive: true })

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

  await cmd(repo, ["git", "add", ".opencode"])
  await cmd(repo, ["git", "commit", "--no-gpg-sign", "-m", "init opencode config", "-q"])

  await Bun.write(path.join(repo, "LOCAL.txt"), "local\n")

  await cmd(reuseRepo, ["git", "init", "-q"])
  await Bun.write(path.join(reuseRepo, "README.md"), "reuse\n")
  await cmd(reuseRepo, ["git", "add", "README.md"])
  await cmd(reuseRepo, ["git", "-c", "user.name=demo", "-c", "user.email=demo@example.com", "commit", "-m", "init", "-q"])

  const createdSessions: string[] = []
  const promptCalls: any[] = []
  const permissionReplies: any[] = []
  const questionRejects: any[] = []
  const activePromptSessions = new Set<string>()
  const overlappedPromptSessions = new Set<string>()
  let hooks: any

  const ctx: any = {
    directory: repo,
    worktree: repo,
    project: { id: "proj", worktree: repo, vcs: "git" },
    serverUrl: "http://localhost",
    $: Bun.$,
    client: {
      postSessionIdPermissionsPermissionId: async (input: any) => {
        permissionReplies.push(input)
        return { data: true }
      },
      _client: {
        post: async (input: any) => {
          if (input?.url === "/question/{requestID}/reject") {
            questionRejects.push(input)
          }
          return { data: true }
        },
      },
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
        create: async () => {
          const id = `ses_test_${createdSessions.length + 1}`
          createdSessions.push(id)
          return { data: { id } }
        },
        promptAsync: async () => ({ data: undefined }),
        prompt: async (input: any) => {
          promptCalls.push(input)
          const sessionID = String(input?.path?.id || "").trim()
          const bodyText = String(input?.body?.parts?.[0]?.text || "")
          if (bodyText.includes("needs-permission")) {
            await hooks?.event?.({
              event: {
                type: "permission.asked",
                properties: {
                  id: `perm_${promptCalls.length}`,
                  sessionID,
                  permission: "bash",
                  patterns: ["*"],
                  always: ["*"],
                  metadata: {},
                },
              },
            })
          }
          if (bodyText.includes("needs-question")) {
            await hooks?.event?.({
              event: {
                type: "question.asked",
                properties: {
                  id: `question_${promptCalls.length}`,
                  sessionID,
                  questions: [],
                },
              },
            })
          }
          if (sessionID && activePromptSessions.has(sessionID)) {
            overlappedPromptSessions.add(sessionID)
          }
          if (sessionID) activePromptSessions.add(sessionID)
          try {
            await Bun.sleep(bodyText.includes("slow") ? 40 : 5)
          } finally {
            if (sessionID) activePromptSessions.delete(sessionID)
          }
          return {
            data: {
              info: { id: "msg_worker" },
              parts: [{ type: "text", text: `worker done: ${bodyText}` }],
            },
          }
        },
      },
    },
  }

  hooks = await WorkbenchPlugin(ctx)
  const systemTransform = hooks["experimental.chat.system.transform"] as
    | ((input: { sessionID: string }, output: { system: string[] }) => Promise<void>)
    | undefined
  if (!systemTransform) throw new Error("system transform hook missing")

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

  const defaultSystem = { system: [] as string[] }
  await systemTransform({ sessionID: "ses_plain" }, defaultSystem)
  const defaultSystemText = defaultSystem.system.join("\n")
  if (!defaultSystemText.includes("Use workbench when you need to supervise parallel work across branches/worktrees.")) {
    throw new Error("default sessions should receive the base workbench injection")
  }
  if (defaultSystemText.includes("Workbench mode: your role is a workbench child worker.")) {
    throw new Error("default sessions should not receive worker delivery guidance")
  }

  const helpText = await def.execute(schema.parse({ action: "help" }), toolCtx)
  if (!String(helpText).includes("Purpose")) {
    throw new Error("help should document purpose")
  }
  if (!String(helpText).includes("Principles")) {
    throw new Error("help should document principles")
  }
  if (!String(helpText).includes("Your role (supervisor)")) {
    throw new Error("help should document supervisor role")
  }
  if (!String(helpText).includes("main repository working copy on the base branch")) {
    throw new Error("help should require running bind/open/task from main repository base branch context")
  }
  if (!String(helpText).includes("Leave detailed per-task planning to child sessions.")) {
    throw new Error("help should make child sessions responsible for per-task detailed planning")
  }
  if (!String(helpText).includes("Supervisor should not directly edit/read/build inside child-owned worktree directories")) {
    throw new Error("help should define supervisor non-implementation boundary for child worktrees")
  }
  if (!String(helpText).includes("Supervisor workflow")) {
    throw new Error("help should document supervisor workflow")
  }
  if (!String(helpText).includes("Child sessions perform per-task detailed planning")) {
    throw new Error("help should document that child sessions handle per-task detailed planning")
  }
  if (String(helpText).includes("Child worker contract") || String(helpText).includes("Coordinator-only access policy")) {
    throw new Error("help should not include child-session instruction sections")
  }
  if (!String(helpText).includes("Delivery modes")) {
    throw new Error("help should document delivery mode policy")
  }
  if (!String(helpText).includes("Optional cleanup (ask user first)")) {
    throw new Error("help should document optional cleanup with user approval")
  }
  if (!String(helpText).includes(".workbench/<name> subdirectories")) {
    throw new Error("help should include optional cleanup guidance for .workbench subdirectories")
  }

  const name = "sbx"
  await def.execute(schema.parse({ action: "open", name, dir: repo }), toolCtx)
  const workerSession = createdSessions[0]
  if (!workerSession) throw new Error("open did not create worker session")

  const parentSystem = { system: [] as string[] }
  await systemTransform({ sessionID: "ses_parent" }, parentSystem)
  const parentSystemText = parentSystem.system.join("\n")
  if (parentSystemText.includes("Workbench mode: your role is a workbench child worker.")) {
    throw new Error("supervisor sessions should not receive worker delivery guidance")
  }

  const workerSystem = { system: [] as string[] }
  await systemTransform({ sessionID: workerSession }, workerSystem)
  const workerSystemText = workerSystem.system.join("\n")
  if (!workerSystemText.includes("Workbench mode: your role is a workbench child worker.")) {
    throw new Error("worker sessions should receive worker delivery guidance")
  }

  const listRepo = await def.execute(schema.parse({ action: "list", scope: "repo" }), toolCtx)
  if (!String(listRepo).includes(name)) throw new Error("repo list did not include binding")
  const listParent = await def.execute(schema.parse({ action: "list" }), toolCtx)
  if (!String(listParent).includes(name)) throw new Error("parent session list did not include child binding")
  const infoSupervisorDefault = await def.execute(schema.parse({ action: "info" }), toolCtx)
  if (!String(infoSupervisorDefault).includes(name)) throw new Error("info default should follow session-scoped binding resolution")

  await def.execute(schema.parse({ action: "bind", dir: repo, ghHost: "github.com" }), toolCtx)
  const listRepoAfterMerge = await def.execute(schema.parse({ action: "list", scope: "repo" }), toolCtx)
  const repoRowsAfterMerge = String(listRepoAfterMerge)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (repoRowsAfterMerge.length !== 1) throw new Error("bind dir upsert should not create duplicate bindings")
  if (!repoRowsAfterMerge[0]?.includes(name)) throw new Error("bind dir upsert should preserve existing binding name")

  const info = await def.execute(schema.parse({ action: "info", name }), toolCtx)
  if (!String(info).includes(repo)) throw new Error("info did not include dir")

  let invalidPrRejected = false
  await def.execute(schema.parse({ action: "bind", name, prUrl: "not-a-url" }), toolCtx).catch(() => {
    invalidPrRejected = true
  })
  if (!invalidPrRejected) throw new Error("bind should reject invalid prUrl")

  let invalidUpstreamRejected = false
  await def.execute(schema.parse({ action: "bind", name, upstream: "bad-format" }), toolCtx).catch(() => {
    invalidUpstreamRejected = true
  })
  if (!invalidUpstreamRejected) throw new Error("bind should reject invalid upstream format")

  let invalidForkRejected = false
  await def.execute(schema.parse({ action: "bind", name, fork: "bad-format" }), toolCtx).catch(() => {
    invalidForkRejected = true
  })
  if (!invalidForkRejected) throw new Error("bind should reject invalid fork format")

  await def.execute(
    schema.parse({ action: "bind", name, upstream: "org/repo", fork: "me/repo", prUrl: "https://github.com/org/repo/pull/12" }),
    toolCtx,
  )
  const infoWithMeta = await def.execute(schema.parse({ action: "info", name }), toolCtx)
  if (!String(infoWithMeta).includes("pull/12")) throw new Error("bind should record valid prUrl")

  await def.execute(schema.parse({ action: "bind", name, clear: "prUrl" }), toolCtx)
  const infoPrCleared = await def.execute(schema.parse({ action: "info", name }), toolCtx)
  if (String(infoPrCleared).includes("pull/12")) throw new Error("clear=prUrl should remove prUrl metadata")

  await def.execute(schema.parse({ action: "bind", name, clear: "github" }), toolCtx)
  const infoGithubCleared = await def.execute(schema.parse({ action: "info", name }), toolCtx)
  if (String(infoGithubCleared).includes("github:")) throw new Error("clear=github should remove github metadata")

  await def.execute(schema.parse({ action: "open", name: "reuse", dir: reuseRepo }), toolCtx)
  await def.execute(schema.parse({ action: "bind", name: "reuse", dir: reuseRepo, prUrl: "https://github.com/old/repo/pull/9" }), toolCtx)
  const reuseInfoBefore = await def.execute(schema.parse({ action: "info", name: "reuse", dir: reuseRepo }), toolCtx)
  if (!String(reuseInfoBefore).includes("pull/9")) throw new Error("reuse repo should store initial PR metadata")
  await rm(path.join(reuseRepo, ".git"), { recursive: true, force: true })
  await cmd(reuseRepo, ["git", "init", "-q"])
  await Bun.write(path.join(reuseRepo, "README.md"), "reuse-new\n")
  await cmd(reuseRepo, ["git", "add", "README.md"])
  await cmd(reuseRepo, ["git", "-c", "user.name=demo", "-c", "user.email=demo@example.com", "commit", "-m", "reinit", "-q"])
  await def.execute(schema.parse({ action: "bind", name: "reuse", dir: reuseRepo }), toolCtx)
  const reuseInfoAfter = await def.execute(schema.parse({ action: "info", name: "reuse", dir: reuseRepo }), toolCtx)
  if (String(reuseInfoAfter).includes("pull/9")) throw new Error("repo identity change should clear stale PR metadata")

  const toolCtxNonGit = { ...toolCtx, directory: nonGitDir, worktree: nonGitDir }
  const infoByNameNonGit = await def.execute(schema.parse({ action: "info", name }), toolCtxNonGit)
  if (!String(infoByNameNonGit).includes(repo)) throw new Error("name-only info should resolve outside git cwd when unique")
  const openByNameNonGit = await def.execute(schema.parse({ action: "open", name }), toolCtxNonGit)
  if (!String(openByNameNonGit).includes(name)) throw new Error("name-only open should resolve outside git cwd when unique")

  const toolCtxChild = { ...toolCtx, sessionID: workerSession }
  let childWorkbenchBlocked = false
  await def.execute(schema.parse({ action: "help" }), toolCtxChild).catch(() => {
    childWorkbenchBlocked = true
  })
  if (!childWorkbenchBlocked) throw new Error("child worker session should not be able to call workbench")

  const before = hooks["tool.execute.before"] as
    | ((input: { tool: string; sessionID: string; callID: string }, output: { args: Record<string, unknown> }) => Promise<void>)
    | undefined
  if (!before) throw new Error("tool.execute.before hook missing")

  const workbenchChildCall = { args: { action: "help" } as Record<string, unknown> }
  let childWorkbenchBeforeBlocked = false
  await before({ tool: "workbench", sessionID: workerSession, callID: "c_workbench_child" }, workbenchChildCall).catch(() => {
    childWorkbenchBeforeBlocked = true
  })
  if (!childWorkbenchBeforeBlocked) throw new Error("tool hook should block workbench calls in child worker sessions")

  let nonGitBindBlocked = false
  await def.execute(schema.parse({ action: "bind", name: "bad-bind", dir: nonGitDir }), toolCtx).catch(() => {
    nonGitBindBlocked = true
  })
  if (!nonGitBindBlocked) throw new Error("bind should reject non-git directories")

  let nonGitOpenBlocked = false
  await def.execute(schema.parse({ action: "open", name: "bad-open", dir: nonGitDir }), toolCtx).catch(() => {
    nonGitOpenBlocked = true
  })
  if (!nonGitOpenBlocked) throw new Error("open should reject non-git directories")

  let nonGitTaskBlocked = false
  await def.execute(schema.parse({ action: "task", prompt: "x", dir: nonGitDir }), toolCtx).catch(() => {
    nonGitTaskBlocked = true
  })
  if (!nonGitTaskBlocked) throw new Error("task should reject non-git directories")

  const taskDefault = { args: { directory: ".workbench/w2" } as Record<string, unknown> }
  await before({ tool: "task", sessionID: "ses_default", callID: "c_task_default" }, taskDefault)
  if (taskDefault.args.task_id) throw new Error("default task mode should not auto-route task_id")

  const taskParent = { args: { prompt: "p" } as Record<string, unknown> }
  await before({ tool: "task", sessionID: "ses_parent", callID: "c_task_parent" }, taskParent)
  if (taskParent.args.task_id) throw new Error("task hook should not auto-route task_id in parent session")

  const taskChild = { args: { prompt: "p" } as Record<string, unknown> }
  let childTaskBlocked = false
  await before({ tool: "task", sessionID: workerSession, callID: "c_task_child" }, taskChild).catch(() => {
    childTaskBlocked = true
  })
  if (!childTaskBlocked) throw new Error("built-in task should be blocked in worker session")

  const taskByDirAllowed = {
    args: {
      directory: ".workbench/w2",
    } as Record<string, unknown>,
  }
  await before({ tool: "task", sessionID: "ses_parent", callID: "c_task_dir" }, taskByDirAllowed)

  const workbenchDir = path.join(repo, ".workbench", "w2")
  await cmd(repo, ["git", "worktree", "add", ".workbench/w2", "-b", "w2", "-q"])
  const taskOut = await def.execute(
    schema.parse({
      action: "task",
      prompt: "do work",
      agent: "general",
      dir: ".workbench/w2",
    }),
    toolCtx,
  )
  if (!String(taskOut).includes("task_id:")) throw new Error("workbench task output missing task_id")
  if (!String(taskOut).includes("task_queue_ms:")) throw new Error("workbench task output missing queue timing")
  if (!String(taskOut).includes("task_run_ms:")) throw new Error("workbench task output missing run timing")
  if (!String(taskOut).includes("worker done")) throw new Error("workbench task output missing worker text")
  const worktreeSession = String(taskOut).match(/task_id:\s+([^\s]+)/)?.[1]
  if (!worktreeSession) throw new Error("workbench task output missing routed session id")
  const promptCall = promptCalls.at(-1)
  if (!promptCall || promptCall?.query?.directory !== workbenchDir) throw new Error("workbench task did not pin directory")
  if (!promptCall || promptCall?.body?.agent !== toolCtx.agent) {
    throw new Error("workbench task should inherit parent agent for child-session prompt")
  }
  const promptText = String(promptCall?.body?.parts?.[0]?.text || "")
  if (promptText.trim() !== "do work") {
    throw new Error("workbench task should forward assigned prompt text without contract wrapping")
  }

  const toolCtxParent2 = { ...toolCtx, sessionID: "ses_parent_2" }
  const taskOut2 = await def.execute(
    schema.parse({
      action: "task",
      prompt: "do work again",
      agent: "general",
      dir: ".workbench/w2",
    }),
    toolCtxParent2,
  )
  const worktreeSession2 = String(taskOut2).match(/task_id:\s+([^\s]+)/)?.[1]
  if (!worktreeSession2) throw new Error("workbench task should return a parent-local child session when parent changes")
  if (!String(taskOut2).includes(`task_id: ${worktreeSession2}`)) {
    throw new Error("workbench task should return the re-parented session id")
  }
  const promptCall2 = promptCalls.at(-1)
  if (!promptCall2 || promptCall2?.path?.id !== worktreeSession2) throw new Error("workbench task should prompt in the re-parented session")
  if (!promptCall2 || promptCall2?.query?.directory !== workbenchDir) throw new Error("workbench task should keep the bound worktree directory")
  if (!promptCall2 || promptCall2?.body?.agent !== toolCtxParent2.agent) {
    throw new Error("workbench task should keep inheriting agent after re-parenting")
  }

  const taskWithPermissionAsk = await def.execute(
    schema.parse({
      action: "task",
      prompt: "needs-permission",
      dir: ".workbench/w2",
    }),
    toolCtxParent2,
  )
  if (!String(taskWithPermissionAsk).includes("task_permission_auto_rejects: 1")) {
    throw new Error("workbench task should auto-reject child permission asks to avoid blocking")
  }
  const permissionReply = permissionReplies.at(-1)
  if (!permissionReply || permissionReply?.path?.id !== worktreeSession2) {
    throw new Error("auto-rejected permission should target the active child session")
  }

  const taskWithQuestionAsk = await def.execute(
    schema.parse({
      action: "task",
      prompt: "needs-question",
      dir: ".workbench/w2",
    }),
    toolCtxParent2,
  )
  if (!String(taskWithQuestionAsk).includes("task_question_auto_rejects: 1")) {
    throw new Error("workbench task should auto-reject child questions to avoid blocking")
  }
  const questionReject = questionRejects.at(-1)
  if (!questionReject || typeof questionReject?.path?.requestID !== "string") {
    throw new Error("auto-rejected question should call question reject endpoint")
  }
  if (!questionReject.path.requestID.startsWith("question_")) {
    throw new Error("auto-rejected question should call question reject endpoint")
  }

  const taskParent2 = { args: { prompt: "p" } as Record<string, unknown> }
  await before({ tool: "task", sessionID: "ses_parent_2", callID: "c_task_parent2" }, taskParent2)
  if (taskParent2.args.task_id) throw new Error("task hook should not auto-route task_id after re-parenting")

  const [slowTask, fastTask] = await Promise.all([
    def.execute(
      schema.parse({ action: "task", task_id: worktreeSession2, prompt: "slow-task-a", agent: "general" }),
      toolCtxParent2,
    ),
    def.execute(
      schema.parse({ action: "task", task_id: worktreeSession2, prompt: "fast-task-b", agent: "general" }),
      toolCtxParent2,
    ),
  ])
  if (!String(slowTask).includes("slow-task-a")) throw new Error("serialized task output mismatch for first concurrent task")
  if (!String(fastTask).includes("fast-task-b")) throw new Error("serialized task output mismatch for second concurrent task")
  if (!String(slowTask).includes("task_queue_ms:") || !String(fastTask).includes("task_queue_ms:")) {
    throw new Error("serialized task outputs should include queue timing")
  }
  if (!String(slowTask).includes("task_queued: yes") && !String(fastTask).includes("task_queued: yes")) {
    throw new Error("at least one concurrent task should report queued execution")
  }
  if (overlappedPromptSessions.has(worktreeSession2)) {
    throw new Error("tasks targeting the same session should be serialized")
  }

  const listByParentChild = await def.execute(
    schema.parse({ action: "list", scope: "session", parentSessionId: "ses_parent_2", sessionId: worktreeSession2 }),
    toolCtx,
  )
  if (!String(listByParentChild).includes("w2")) throw new Error("session list should honor parentSessionId+sessionId targeting")

  const infoByParentChild = await def.execute(
    schema.parse({ action: "info", parentSessionId: "ses_parent_2", sessionId: worktreeSession2 }),
    toolCtx,
  )
  if (!String(infoByParentChild).includes(workbenchDir)) throw new Error("info should honor parentSessionId+sessionId targeting")

  let strictInfoBlocked = false
  await def
    .execute(schema.parse({ action: "info", parentSessionId: "ses_parent_2", sessionId: "ses_parent", strict: true }), toolCtx)
    .catch(() => {
      strictInfoBlocked = true
    })
  if (!strictInfoBlocked) throw new Error("strict info should fail when multiple bindings match")

  const activeWorktreeSession = worktreeSession2
  const outsideAllowed = { args: { filePath: path.join(repo, "README.md") } as Record<string, unknown> }
  await before({ tool: "edit", sessionID: activeWorktreeSession, callID: "c_edit_worker_out" }, outsideAllowed)

  const insideAllowed = { args: { filePath: path.join(workbenchDir, "README.md") } as Record<string, unknown> }
  await before({ tool: "edit", sessionID: activeWorktreeSession, callID: "c_edit_worker_in" }, insideAllowed)

  const infoByDir = await def.execute(schema.parse({ action: "info", name: "w2", dir: repo }), toolCtx)
  if (!String(infoByDir).includes(workbenchDir)) throw new Error("directory task did not create/update binding")

  const infoDirOnly = await def.execute(schema.parse({ action: "info", dir: workbenchDir }), toolCtx)
  if (!String(infoDirOnly).includes(workbenchDir)) throw new Error("info with dir only should resolve binding")

  const removeMissing = await def.execute(schema.parse({ action: "remove", name: "missing", dir: repo }), toolCtx)
  if (!String(removeMissing).includes("binding not found")) throw new Error("remove missing binding should be explicit")

  const parentReadAllowedArgs = { args: { filePath: path.join(repo, "README.md") } as Record<string, unknown> }
  await before({ tool: "read", sessionID: "ses_parent", callID: "c_read_parent" }, parentReadAllowedArgs)

  const parentEditAllowedArgs = { args: { filePath: path.join(repo, ".gitignore") } as Record<string, unknown> }
  await before({ tool: "edit", sessionID: "ses_parent", callID: "c_edit_parent" }, parentEditAllowedArgs)

  const parentBashAllowedArgs = { args: { command: "git status" } as Record<string, unknown> }
  await before({ tool: "bash", sessionID: "ses_parent", callID: "c_bash_parent" }, parentBashAllowedArgs)

  await def.execute(schema.parse({ action: "bind", name, prUrl: "https://github.com/org/repo/pull/1" }), toolCtx)
  const infoSession = await def.execute(schema.parse({ action: "info", name }), toolCtx)
  if (!String(infoSession).includes("pull/1")) throw new Error("bind by name did not update prUrl")

  await def.execute(schema.parse({ action: "bind", name: "tmp", dir: repo }), toolCtx)
  const removeByNameNonGit = await def.execute(schema.parse({ action: "remove", name: "tmp" }), toolCtxNonGit)
  if (!String(removeByNameNonGit).includes("removed tmp")) throw new Error("name-only remove should resolve outside git cwd when unique")

  await def.execute(schema.parse({ action: "remove", name }), toolCtx)
  const listRepo2 = await def.execute(schema.parse({ action: "list", scope: "repo" }), toolCtx)
  if (String(listRepo2).includes(name)) throw new Error("remove did not delete binding")

  await rm(workbenchDir, { recursive: true, force: true })
  const listRepoPruned = await def.execute(schema.parse({ action: "list", scope: "repo" }), toolCtx)
  if (String(listRepoPruned).includes("w2")) throw new Error("repo list should prune stale bindings with missing directories")

  await rm(base, { recursive: true, force: true })
  console.log("selfcheck ok")
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
