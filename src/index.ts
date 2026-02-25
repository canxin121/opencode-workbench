import { tool, type Plugin } from "@opencode-ai/plugin"
import { mkdir, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash, randomBytes } from "node:crypto"

const INJECTION = `Use workbench for concurrent branch/worktree tasks.

- workbench binds a worktree directory to a pinned OpenCode session and stores metadata for Studio.
- Use it when multiple tasks/branches run in parallel and you need clear per-worktree routing.

Help: workbench { action: "help" }`

const DESCRIPTION = INJECTION

const HELP = `opencode-workbench (tool: workbench)

Purpose
- Lightweight registry for binding git worktrees to OpenCode sessions.
- This tool does NOT create worktrees, remotes, or PRs. Use git directly for local branch/worktree delivery; use gh only as an optional GitHub integration.
- Requires a git repository/worktree; non-git directories are rejected.
- Records metadata (worktree path, branch, fork, PR URL) so OpenCode Studio UI can display it.
- Includes a task action for directory-aware subagent execution in bound worktrees.

Delivery modes
- git-only mode (baseline): core local parallel flow (worktree/commit/merge) runs with git only.
- git+gh mode (optional): add gh commands when you want GitHub PR/check/merge integration.
- GitHub-integrated PR/check/merge steps require gh to be installed and authenticated.

When to use
- Use workbench when multiple branches/worktrees are active in parallel and you need explicit task routing.

Common workflow
1) Ensure worktrees stay inside the repo directory:
   Add .workbench/ to the repo's .gitignore
2) Create a git worktree under .workbench/ (example):
   git worktree add .workbench/feature-x feature/x
3) Bind + open a pinned session:
   workbench { action: "open", dir: ".workbench/feature-x", name: "feature-x" }
4) Use workbench task when you want implementation work routed to a specific worktree session.
   workbench { action: "task", dir: ".workbench/feature-x", prompt: "Implement feature" }
   (task_id auto-routes when possible)
   (task always inherits the parent session agent)
5) Update GitHub metadata (optional):
   workbench { action: "bind", prUrl: "https://..." }
6) Before merge, ensure checks are green and ask user approval for merge.
   - In git-only mode, complete local integration with git commands (for example merge/rebase/cherry-pick).
   - In git+gh mode, ensure gh is installed/authenticated, then sync GitHub PR/CI status with gh.

Actions
- help: show this help text
- doctor: show tooling + detected repo identity
- list: list bindings (default: current session)
- info: show a binding (default: current session)
- bind: create/update a binding (default: current session)
  - validates upstream/fork as OWNER/REPO and prUrl as .../pull/<number>
  - supports clear="prUrl" or clear="github" (comma/space-separated)
- open: create/reuse a pinned child session for a binding
- task: run a prompt in a routed/pinned workbench session
  - inherits parent session agent for child-session prompts
  - auto-rejects child permission/question requests during relayed runs to avoid blocked tool calls
  (concurrent calls to the same target session are serialized to avoid response cross-talk)
  (output includes task_queue_ms/task_run_ms/task_queued)
  (output may include task_permission_auto_rejects/task_question_auto_rejects)
- remove: delete a binding (default: current session)

Scopes (for list)
- scope="session" (default): bindings attached to this session and its direct children
- scope="repo": bindings for the current git repo
- scope="all": bindings across all repos

Session targeting
- parentSessionId: optional parent/supervisor session id (defaults to current session id)
- sessionId: optional child/target session id; useful when parent and child both need visibility
- strict: for info, fail on ambiguous matches instead of choosing the latest

Role policy
- Role-specific workflow rules are injected automatically for supervisor and implementation sessions.
- Supervisor owns orchestration and can decide safe cache/artifact seeding for new worktrees when useful.
- Implementation sessions execute and verify inside their bound worktree, then report readiness and check status.

Storage
- Registry files live under: $XDG_STATE_HOME/opencode/workbench/entries/
  (fallback: ~/.local/state/opencode/workbench/entries/)`

const SUPERVISOR_HINT = `Workbench mode: this is a supervisor session.
- Own orchestration only: planning, routing, review, and user communication.
- MUST NOT edit child implementation files or run build/check/fmt/test/git for child-worktree changes in this session.
- Route child implementation changes (feature/code/file work) and verification commands to the target child session, and collect results there.
- For new/heavy worktrees, proactively decide language/tool-specific acceleration (for example seeding node_modules, cargo target, or other reusable caches) when safe for this repo.
- Distinguish delivery paths: git-only local integration uses git worktree + git merge/rebase/cherry-pick; GitHub-integrated delivery uses gh for PR/check/merge.
- If GitHub-integrated steps are requested, require gh installation + authentication (for example gh auth login) before continuing those steps.
- Unless user approval is already explicit/preapproved, ask before each next step; after each completed step, report outcome and ask whether to continue.`

const IMPLEMENTATION_HINT = `Workbench mode: this session is pinned to a workbench worktree.
- Execute all implementation and repo actions for this worktree (edits/build/check/fmt/test/git) only inside this path.
- For git-only local delivery, use git integration commands (for example merge/rebase/cherry-pick) in local worktrees; do not depend on gh.
- For GitHub-integrated delivery, use gh for PR/check/merge only after gh is installed and authenticated.
- Execute only the step requested by supervisor, and report readiness/check status before merge or final delivery.`

const TOOLING_MODE_HINT = `Workbench tooling policy (always apply):
- Git is the required baseline for local parallel development and merge workflow.
- gh is optional; use it only when the user wants GitHub-integrated PR/check/merge actions.
- If a GitHub-integrated step is requested and gh is missing, require installation + authentication (for example gh auth login) before continuing that step.
- If the user only wants local git delivery, continue with git-only flow without gh.`

type ToolingMode = "git+gh" | "git-only" | "no-git"

function toolingModeFrom(hasGit: boolean, hasGh: boolean): ToolingMode {
  if (!hasGit) return "no-git"
  if (hasGh) return "git+gh"
  return "git-only"
}

type Entry = {
  version: 1
  id: string
  name: string
  worktree: {
    path: string
    branch?: string
  }
  repo?: {
    commonDir?: string
    origin?: string
    root?: string
  }
  github?: {
    host?: string
    upstream?: string
    fork?: string
    prUrl?: string
  }
  session?: {
    id: string
    parent?: string
    title?: string
  }
  time: {
    created: number
    updated: number
  }
}

type Scope = "session" | "repo" | "all"

const unwrap = <T>(response: unknown): T => {
  if (response && typeof response === "object" && "data" in response) {
    const data = (response as { data?: T }).data
    if (data !== undefined) return data
  }
  return response as T
}

function taskText(response: unknown) {
  if (!response || typeof response !== "object") return ""
  const parts = (response as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return ""
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (!part || typeof part !== "object") continue
    const type = (part as Record<string, unknown>).type
    const text = (part as Record<string, unknown>).text
    if (type === "text" && typeof text === "string") return text
  }
  return ""
}

function messageAgent(response: unknown) {
  if (!response || typeof response !== "object") return ""
  const info = (response as { info?: unknown }).info
  if (!info || typeof info !== "object") return ""
  const record = info as Record<string, unknown>
  if (record.role !== "user") return ""
  if (typeof record.agent !== "string") return ""
  return record.agent.trim()
}

async function parentAgent(ctx: any, toolCtx: any, parentSessionId: string) {
  const direct = sessionArg(toolCtx?.agent)
  if (direct) return direct

  const parent = sessionArg(parentSessionId) || sessionArg(toolCtx?.sessionID)
  if (!parent) {
    throw new Error("workbench: cannot inherit agent because no parent session id is available")
  }

  const list = ctx?.client?.session?.messages
  if (typeof list !== "function") {
    throw new Error("workbench: cannot inherit agent because session messages API is unavailable")
  }

  const response = await list({ path: { id: parent }, query: { limit: 100 } }).catch(() => undefined)
  const messages = unwrap<any>(response ?? [])
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const match = messageAgent(messages[i])
      if (match) return match
    }
  }

  throw new Error(
    `workbench: cannot inherit agent from parent session ${JSON.stringify(parent)}. Send a parent message first, then retry.`,
  )
}

const clean = (input: string) =>
  input
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "")
    .slice(0, 120)

const hash = (input: string) => createHash("sha1").update(input).digest("hex").slice(0, 10)

const key = (input: string) => (clean(input) || "x").toLowerCase()

function fileArg(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return ""
  const value = (args as Record<string, unknown>).filePath
  if (typeof value !== "string") return ""
  return value.trim()
}

function directoryArg(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return ""
  const value = (args as Record<string, unknown>).directory
  if (typeof value !== "string") return ""
  return value.trim()
}

function pathArg(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return ""
  const value = (args as Record<string, unknown>).path
  if (typeof value !== "string") return ""
  return value.trim()
}

function workdirArg(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return ""
  const value = (args as Record<string, unknown>).workdir
  if (typeof value !== "string") return ""
  return value.trim()
}

function isGitignore(filepath: string) {
  const value = filepath.trim()
  if (!value) return false
  if (value === ".gitignore") return true
  const normalized = value.replaceAll("\\", "/")
  return normalized.endsWith("/.gitignore")
}

function within(base: string, target: string) {
  const root = path.resolve(base)
  const file = path.resolve(target)
  const rel = path.relative(root, file)
  if (!rel) return true
  if (rel.startsWith("..")) return false
  return !path.isAbsolute(rel)
}

function resolvePath(base: string, raw: string) {
  const value = raw.trim()
  if (!value) return ""
  if (path.isAbsolute(value)) return path.resolve(value)
  return path.resolve(base, value)
}

function normalizeScope(raw: unknown, all?: boolean): Scope {
  if (all === true) return "all"
  const value = typeof raw === "string" ? raw.trim() : ""
  if (value === "session" || value === "repo" || value === "all") return value
  return "session"
}

function sessionArg(value: unknown) {
  if (typeof value !== "string") return ""
  return value.trim()
}

function clearSetArg(value: unknown) {
  const tokens: string[] = []
  if (typeof value === "string") tokens.push(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") continue
      tokens.push(item)
    }
  }
  const out = new Set<string>()
  for (const raw of tokens) {
    const parts = raw
      .split(/[\s,]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
    for (const key of parts) out.add(key)
  }
  return out
}

function hasClear(clearSet: Set<string>, name: string) {
  const keyName = name.trim().toLowerCase()
  if (!keyName) return false
  if (clearSet.has("all")) return true
  if (clearSet.has(keyName)) return true
  if (keyName === "ghhost" && clearSet.has("host")) return true
  if (keyName === "prurl" && clearSet.has("pr")) return true
  return false
}

function normalizeRepoRef(field: "upstream" | "fork", value: string) {
  const next = value.trim()
  if (!next) return ""
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(next)) {
    throw new Error(`workbench: ${field} must match OWNER/REPO (got ${JSON.stringify(value)})`)
  }
  return next
}

function normalizePrUrl(value: string) {
  const input = value.trim()
  if (!input) return ""

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(`workbench: prUrl must be a full URL (got ${JSON.stringify(value)})`)
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`workbench: prUrl must use http or https (got ${JSON.stringify(value)})`)
  }

  const parts = url.pathname.split("/").filter(Boolean)
  if (parts.length < 4 || parts[2] !== "pull" || !/^\d+$/.test(parts[3])) {
    throw new Error(
      `workbench: prUrl must look like https://<host>/<owner>/<repo>/pull/<number> (got ${JSON.stringify(value)})`,
    )
  }

  return `${url.protocol}//${url.host}/${parts[0]}/${parts[1]}/pull/${parts[3]}`
}

function mergeGithubMetadata(
  existing: Entry["github"] | undefined,
  args: {
    ghHost?: string
    upstream?: string
    fork?: string
    prUrl?: string
  },
  clearSet: Set<string>,
) {
  const clearGithub = hasClear(clearSet, "github")

  const host = (() => {
    if (clearGithub || hasClear(clearSet, "ghhost")) return ""
    return (args.ghHost ?? existing?.host ?? "").trim()
  })()

  const upstream = (() => {
    if (clearGithub || hasClear(clearSet, "upstream")) return ""
    if (args.upstream !== undefined) return normalizeRepoRef("upstream", String(args.upstream || "").trim())
    return String(existing?.upstream || "").trim()
  })()

  const fork = (() => {
    if (clearGithub || hasClear(clearSet, "fork")) return ""
    if (args.fork !== undefined) return normalizeRepoRef("fork", String(args.fork || "").trim())
    return String(existing?.fork || "").trim()
  })()

  const prUrl = (() => {
    if (clearGithub || hasClear(clearSet, "prurl")) return ""
    if (args.prUrl !== undefined) return normalizePrUrl(String(args.prUrl || "").trim())
    return String(existing?.prUrl || "").trim()
  })()

  const fromPrHost = (() => {
    if (!prUrl) return ""
    try {
      return new URL(prUrl).host
    } catch {
      return ""
    }
  })()

  const finalHost = (host || fromPrHost).trim()

  return {
    ...(finalHost ? { host: finalHost } : {}),
    ...(upstream ? { upstream } : {}),
    ...(fork ? { fork } : {}),
    ...(prUrl ? { prUrl } : {}),
  }
}

const relayTaskDepth = new Map<string, number>()
const relayTaskRejects = new Map<string, { permission: number; question: number }>()

function relayTaskEnter(sessionID: string) {
  const sid = sessionArg(sessionID)
  if (!sid) return
  relayTaskDepth.set(sid, (relayTaskDepth.get(sid) ?? 0) + 1)
}

function relayTaskLeave(sessionID: string) {
  const sid = sessionArg(sessionID)
  if (!sid) return
  const next = (relayTaskDepth.get(sid) ?? 0) - 1
  if (next > 0) {
    relayTaskDepth.set(sid, next)
    return
  }
  relayTaskDepth.delete(sid)
}

function relayTaskActive(sessionID: string) {
  const sid = sessionArg(sessionID)
  if (!sid) return false
  return (relayTaskDepth.get(sid) ?? 0) > 0
}

function relayTaskRejectSnapshot(sessionID: string) {
  const sid = sessionArg(sessionID)
  if (!sid) return { permission: 0, question: 0 }
  return relayTaskRejects.get(sid) ?? { permission: 0, question: 0 }
}

function relayTaskRejectBump(sessionID: string, kind: "permission" | "question") {
  const sid = sessionArg(sessionID)
  if (!sid) return
  const current = relayTaskRejects.get(sid) ?? { permission: 0, question: 0 }
  const next = {
    permission: current.permission + (kind === "permission" ? 1 : 0),
    question: current.question + (kind === "question" ? 1 : 0),
  }
  relayTaskRejects.set(sid, next)
}

async function relayTaskRejectPermission(ctx: any, sessionID: string, requestID: string) {
  const reject = ctx?.client?.postSessionIdPermissionsPermissionId
  if (typeof reject !== "function") return false
  await reject({
    path: {
      id: sessionID,
      permissionID: requestID,
    },
    body: {
      response: "reject",
    },
  }).catch(() => undefined)
  return true
}

async function relayTaskRejectQuestion(ctx: any, requestID: string) {
  const reject = ctx?.client?.question?.reject
  if (typeof reject === "function") {
    await reject({
      path: {
        requestID,
      },
    }).catch(() => undefined)
    return true
  }

  const raw = ctx?.client?._client?.post
  if (typeof raw !== "function") return false
  await raw({
    url: "/question/{requestID}/reject",
    path: {
      requestID,
    },
  }).catch(() => undefined)
  return true
}

async function relayTaskAbortSession(ctx: any, sessionID: string) {
  const abort = ctx?.client?.session?.abort
  if (typeof abort !== "function") return false
  await abort({
    path: {
      id: sessionID,
    },
  }).catch(() => undefined)
  return true
}

async function relayTaskHandleEvent(ctx: any, event: unknown) {
  if (!event || typeof event !== "object") return
  const record = event as Record<string, unknown>
  const type = typeof record.type === "string" ? record.type : ""
  if (!type) return
  const properties = record.properties
  if (!properties || typeof properties !== "object") return
  const props = properties as Record<string, unknown>
  const sessionID = sessionArg(props.sessionID)
  if (!sessionID || !relayTaskActive(sessionID)) return

  if (type === "permission.asked" || type === "permission.updated") {
    const requestID = sessionArg(props.id)
    if (!requestID) return
    const handled = await relayTaskRejectPermission(ctx, sessionID, requestID)
    if (!handled) {
      await relayTaskAbortSession(ctx, sessionID)
      return
    }
    relayTaskRejectBump(sessionID, "permission")
    return
  }

  if (type === "question.asked") {
    const requestID = sessionArg(props.id)
    if (!requestID) return
    const handled = await relayTaskRejectQuestion(ctx, requestID)
    if (!handled) {
      await relayTaskAbortSession(ctx, sessionID)
      return
    }
    relayTaskRejectBump(sessionID, "question")
  }
}

const sessionTaskTails = new Map<string, Promise<void>>()

async function runSessionTaskSerial<T>(sessionID: string, execute: () => Promise<T>) {
  const keyID = String(sessionID || "").trim()
  if (!keyID) {
    const started = Date.now()
    const value = await execute()
    return {
      value,
      queuedMs: 0,
      runMs: Math.max(0, Date.now() - started),
      queued: false,
    }
  }

  const queueStart = Date.now()
  const tail = sessionTaskTails.get(keyID) ?? Promise.resolve()
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const next = tail.catch(() => {}).then(() => gate)
  sessionTaskTails.set(keyID, next)

  await tail.catch(() => {})
  const queuedMs = Math.max(0, Date.now() - queueStart)
  const runStart = Date.now()
  try {
    const value = await execute()
    return {
      value,
      queuedMs,
      runMs: Math.max(0, Date.now() - runStart),
      queued: queuedMs > 0,
    }
  } finally {
    release()
    next.finally(() => {
      if (sessionTaskTails.get(keyID) === next) {
        sessionTaskTails.delete(keyID)
      }
    })
  }
}

function stateHome() {
  const state = process.env.XDG_STATE_HOME?.trim()
    ? process.env.XDG_STATE_HOME!.trim()
    : path.join(os.homedir(), ".local", "state")
  return path.join(state, "opencode", "workbench")
}

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true })
  return dir
}

async function gitCommonDir(ctx: any, dir: string): Promise<string> {
  const res = await ctx.$`git -C ${dir} rev-parse --git-common-dir`.nothrow().quiet()
  if (res.exitCode !== 0) return ""
  const out = res.text().trim()
  if (!out) return ""
  return path.resolve(dir, out)
}

async function gitBranch(ctx: any, dir: string): Promise<string> {
  const res = await ctx.$`git -C ${dir} rev-parse --abbrev-ref HEAD`.nothrow().quiet()
  if (res.exitCode !== 0) return ""
  const out = res.text().trim()
  if (!out || out === "HEAD") return ""
  return out
}

async function gitTopLevel(ctx: any, dir: string): Promise<string> {
  const res = await ctx.$`git -C ${dir} rev-parse --show-toplevel`.nothrow().quiet()
  if (res.exitCode !== 0) return ""
  return res.text().trim()
}

async function gitOrigin(ctx: any, dir: string): Promise<string> {
  const res = await ctx.$`git -C ${dir} config --get remote.origin.url`.nothrow().quiet()
  if (res.exitCode !== 0) return ""
  return res.text().trim()
}

async function gitRootCommit(ctx: any, dir: string): Promise<string> {
  const res = await ctx.$`git -C ${dir} rev-list --max-parents=0 HEAD`.nothrow().quiet()
  if (res.exitCode !== 0) return ""
  const out = res.text().trim()
  if (!out) return ""
  return out.split(/\s+/)[0] ?? ""
}

async function detectRepo(ctx: any, dir: string) {
  const commonDir = await gitCommonDir(ctx, dir)
  const origin = commonDir ? await gitOrigin(ctx, dir) : ""
  const root = commonDir ? await gitRootCommit(ctx, dir) : ""
  return {
    commonDir,
    origin,
    root,
  }
}

function requireGitRepo(commonDir: string, dir: string) {
  if (commonDir) return path.resolve(commonDir)
  throw new Error(
    `workbench: no git repository detected for ${JSON.stringify(path.resolve(dir))}. Create or initialize a git repository first (for example: git init), then retry workbench.`,
  )
}

function toRepoMeta(repo: { commonDir: string; origin?: string; root?: string }) {
  const commonDir = path.resolve(repo.commonDir)
  const origin = String(repo.origin || "").trim()
  const root = String(repo.root || "").trim()
  return {
    commonDir,
    ...(origin ? { origin } : {}),
    ...(root ? { root } : {}),
  }
}

function repoIdentityChanged(prev: Entry["repo"] | undefined, next: { commonDir: string; origin?: string; root?: string }) {
  const prevCommon = String(prev?.commonDir || "").trim()
  const prevOrigin = String(prev?.origin || "").trim()
  const prevRoot = String(prev?.root || "").trim()
  const nextCommon = String(next.commonDir || "").trim()
  const nextOrigin = String(next.origin || "").trim()
  const nextRoot = String(next.root || "").trim()

  if (prevCommon && path.resolve(prevCommon) !== path.resolve(nextCommon)) return true
  if (prevOrigin && prevOrigin !== nextOrigin) return true
  if (prevRoot && prevRoot !== nextRoot) return true
  return false
}

function repoMetaDiffers(prev: Entry["repo"] | undefined, next: { commonDir: string; origin?: string; root?: string }) {
  const prevCommon = String(prev?.commonDir || "").trim()
  const prevOrigin = String(prev?.origin || "").trim()
  const prevRoot = String(prev?.root || "").trim()
  const nextCommon = String(next.commonDir || "").trim()
  const nextOrigin = String(next.origin || "").trim()
  const nextRoot = String(next.root || "").trim()
  if (!prevCommon) return true
  if (path.resolve(prevCommon) !== path.resolve(nextCommon)) return true
  if (prevOrigin !== nextOrigin) return true
  if (prevRoot !== nextRoot) return true
  return false
}

async function resolveDirectoryPath(ctx: any, cwd: string, raw: string) {
  const dir = raw.trim()
  if (!dir) return ""
  const top = await gitTopLevel(ctx, cwd)
  const rel = dir.replace(/^\.\//, "")
  if (!top && (rel === ".workbench" || rel.startsWith(".workbench/"))) return ""
  if (path.isAbsolute(dir)) return path.resolve(dir)
  if (rel === ".workbench" || rel.startsWith(".workbench/")) return path.resolve(top || cwd, dir)
  return path.resolve(cwd, dir)
}

function repoGroup(commonDir: string, worktreeDir: string) {
  const seed = commonDir || path.resolve(worktreeDir)
  const label = commonDir ? path.basename(path.dirname(commonDir)) : path.basename(path.resolve(worktreeDir))
  const group = `${key(label)}-${hash(seed)}`
  return {
    group,
    seed,
  }
}

function entryPath(base: string, group: string, name: string) {
  const file = `${key(name)}.json`
  return path.join(base, "entries", group, file)
}

async function readEntry(file: string): Promise<Entry | null> {
  const src = Bun.file(file)
  if (!(await src.exists())) return null
  const raw = await src.text().catch(() => "")
  if (!raw.trim()) return null
  try {
    const data = JSON.parse(raw) as Entry
    if (!data || typeof data !== "object") return null
    if (data.version !== 1) return null
    if (!data.name || !data.worktree?.path) return null
    return data
  } catch {
    return null
  }
}

async function writeEntry(file: string, entry: Entry) {
  const now = Date.now()
  const prev = Number(entry.time?.updated || 0) || 0
  const updated = now > prev ? now : prev + 1
  const next: Entry = {
    ...entry,
    time: {
      ...entry.time,
      updated,
    },
  }
  await ensureDir(path.dirname(file))
  await Bun.write(file, JSON.stringify(next, null, 2) + "\n")
  return next
}

async function removeEntryFile(file: string) {
  if (!(await Bun.file(file).exists())) return false
  await rm(file, { force: true }).catch(() => {})
  return !(await Bun.file(file).exists())
}

async function syncEntryRepo(file: string, entry: Entry, repo: { commonDir: string; origin?: string; root?: string }) {
  const nextRepo = toRepoMeta(repo)
  const changed = repoIdentityChanged(entry.repo, nextRepo)
  const differs = repoMetaDiffers(entry.repo, nextRepo)
  if (!changed && !differs) return entry

  return await writeEntry(file, {
    ...entry,
    repo: nextRepo,
    ...(changed ? { github: {}, session: undefined } : {}),
    time: entry.time,
  })
}

async function listAllEntries(base: string) {
  const root = path.join(base, "entries")
  const groups = await readdir(root, { withFileTypes: true }).catch(() => [])
  const out: Array<{ file: string; entry: Entry }> = []
  for (const g of groups) {
    if (!g.isDirectory()) continue
    const dir = path.join(root, g.name)
    const files = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const f of files) {
      if (!f.isFile()) continue
      if (!f.name.endsWith(".json")) continue
      const file = path.join(dir, f.name)
      const entry = await readEntry(file)
      if (!entry) continue
      out.push({ file, entry })
    }
  }
  return out.sort((a, b) => (b.entry.time.updated || b.entry.time.created) - (a.entry.time.updated || a.entry.time.created))
}

async function listAllLiveEntries(base: string) {
  const all = await listAllEntries(base)
  const live: Array<{ file: string; entry: Entry }> = []
  for (const item of all) {
    const st = await stat(item.entry.worktree.path).catch(() => null)
    if (!st || !st.isDirectory()) {
      await removeEntryFile(item.file)
      continue
    }
    live.push(item)
  }
  return live
}

function formatList(items: Array<{ file: string; entry: Entry }>) {
  if (!items.length) return "workbench: no bindings"
  return items
    .map(({ entry }) => {
      const parts = [
        entry.name,
        entry.worktree.branch ? `branch=${entry.worktree.branch}` : "",
        entry.session?.id ? `session=${entry.session.id}` : "",
        entry.github?.prUrl ? `pr=${(entry.github.prUrl.match(/\/pull\/(\d+)/)?.[1] ?? "")}` : "",
        `dir=${entry.worktree.path}`,
      ].filter(Boolean)
      return parts.join(" ")
    })
    .join("\n")
}

async function resolveEntryByDir(base: string, dir: string) {
  const target = path.resolve(dir)
  const matches = (await listAllLiveEntries(base)).filter(({ entry }) => path.resolve(entry.worktree.path) === target)
  if (!matches.length) return null
  if (matches.length > 1) {
    for (const dup of matches.slice(1)) {
      await removeEntryFile(dup.file)
    }
  }
  return matches[0]
}

async function dedupeDirEntries(base: string, dir: string, keepFile: string) {
  const target = path.resolve(dir)
  const all = await listAllEntries(base)
  for (const item of all) {
    if (item.file === keepFile) continue
    if (path.resolve(item.entry.worktree.path) !== target) continue
    await removeEntryFile(item.file)
  }
}

async function listRepoEntries(base: string, ctx: any, commonDir: string) {
  const wanted = path.resolve(commonDir)
  const all = await listAllLiveEntries(base)
  const out: Array<{ file: string; entry: Entry }> = []
  const seenDir = new Set<string>()
  for (const item of all) {
    const dir = path.resolve(item.entry.worktree.path)

    const repo = await detectRepo(ctx, dir)
    if (!repo.commonDir) {
      await removeEntryFile(item.file)
      continue
    }

    const normalized = toRepoMeta(repo as { commonDir: string; origin?: string; root?: string })
    if (normalized.commonDir !== wanted) continue

    const synced = await syncEntryRepo(item.file, item.entry, normalized)

    if (seenDir.has(dir)) {
      await removeEntryFile(item.file)
      continue
    }
    seenDir.add(dir)
    out.push({ file: item.file, entry: synced })
  }
  out.sort((a, b) => (b.entry.time.updated || b.entry.time.created) - (a.entry.time.updated || a.entry.time.created))
  return out
}

async function resolveCurrentBinding(base: string, ctx: any, toolCtx: any, parentSessionId = "", childSessionId = "") {
  const parent = parentSessionId.trim() || String(toolCtx?.sessionID || "").trim()
  const child = childSessionId.trim()
  const cwd = path.resolve(String(toolCtx?.directory || ctx.directory || "").trim() || process.cwd())

  const live = await listAllLiveEntries(base)
  if (child) {
    const hit = live.find(({ entry }) => entry.session?.id === child)
    if (hit) return hit
  }

  if (parent) {
    const hit = live.find(({ entry }) => entry.session?.id === parent)
    if (hit) return hit
    const childHit = live.find(({ entry }) => entry.session?.parent === parent)
    if (childHit) return childHit
  }

  const top = await gitTopLevel(ctx, cwd)
  const target = top ? path.resolve(top) : cwd
  const hit = live.find(({ entry }) => path.resolve(entry.worktree.path) === target)
  if (hit) return hit

  return null
}

async function listSessionBindings(base: string, ctx: any, toolCtx: any, parentSessionId = "", childSessionId = "") {
  const parent = parentSessionId.trim() || String(toolCtx?.sessionID || "").trim()
  const child = childSessionId.trim()
  const cwd = path.resolve(String(toolCtx?.directory || ctx.directory || "").trim() || process.cwd())
  const live = await listAllLiveEntries(base)

  const ids = new Set<string>()
  if (parent) ids.add(parent)
  if (child) ids.add(child)

  if (ids.size) {
    const scoped = live.filter(({ entry }) => {
      const sid = String(entry.session?.id || "").trim()
      const pid = String(entry.session?.parent || "").trim()
      if (!sid && !pid) return false
      if (sid && ids.has(sid)) return true
      if (pid && ids.has(pid)) return true
      return false
    })
    if (scoped.length) return scoped
  }

  const top = await gitTopLevel(ctx, cwd)
  const target = top ? path.resolve(top) : cwd
  const hit = live.find(({ entry }) => path.resolve(entry.worktree.path) === target)
  if (!hit) return []
  return [hit]
}

async function resolveBindingByName(
  base: string,
  ctx: any,
  toolCtx: any,
  name: string,
  dirArg: string,
  parentSessionId: string,
  childSessionId: string,
) {
  const targetName = key(name)
  const cwd = path.resolve(String(toolCtx?.directory || ctx.directory || "").trim() || process.cwd())
  const rawDir = dirArg.trim()

  if (rawDir) {
    const target = path.isAbsolute(rawDir) ? path.resolve(rawDir) : path.resolve(cwd, rawDir)
    const repo = await detectRepo(ctx, target)
    const commonDir = requireGitRepo(repo.commonDir, target)
    return (await listRepoEntries(base, ctx, commonDir)).find(({ entry }) => key(entry.name) === targetName) ?? null
  }

  const scoped = (await listSessionBindings(base, ctx, toolCtx, parentSessionId, childSessionId)).filter(
    ({ entry }) => key(entry.name) === targetName,
  )
  if (scoped.length === 1) return scoped[0]
  if (scoped.length > 1) {
    throw new Error(`workbench: binding name is ambiguous in this session scope: ${name}. Pass dir to disambiguate.`)
  }

  const current = await resolveCurrentBinding(base, ctx, toolCtx, parentSessionId, childSessionId)
  if (current?.entry.repo?.commonDir) {
    const repoScoped = (await listRepoEntries(base, ctx, current.entry.repo.commonDir)).find(
      ({ entry }) => key(entry.name) === targetName,
    )
    if (repoScoped) return repoScoped
  }

  const all = (await listAllLiveEntries(base)).filter(({ entry }) => key(entry.name) === targetName)
  if (all.length === 1) return all[0]
  if (all.length > 1) {
    throw new Error(`workbench: binding name is ambiguous: ${name}. Pass dir to disambiguate.`)
  }
  return null
}

async function resolveTaskTargetSession(base: string, ctx: any, sessionID: string) {
  const sid = String(sessionID || "").trim()
  if (!sid) return ""

  const all = await listAllLiveEntries(base)
  const direct = all.find(({ entry }) => entry.session?.id === sid)
  if (direct?.entry.session?.id) return direct.entry.session.id

  const children = all.filter(({ entry }) => entry.session?.parent === sid && entry.session?.id)
  if (children.length === 1) return children[0].entry.session!.id
  if (!children.length) return ""

  const repo = await detectRepo(ctx, path.resolve(ctx.directory))
  if (!repo.commonDir) return ""
  const scoped = children.filter(({ entry }) => entry.repo?.commonDir && path.resolve(entry.repo.commonDir) === path.resolve(repo.commonDir!))
  if (scoped.length === 1) return scoped[0].entry.session!.id

  return ""
}

async function findEntryBySession(base: string, sessionID: string) {
  const sid = String(sessionID || "").trim()
  if (!sid) return null
  const all = await listAllLiveEntries(base)
  return all.find(({ entry }) => entry.session?.id === sid) ?? null
}

async function ensureTaskSessionForEntry(base: string, ctx: any, parentID: string, file: string, entry: Entry) {
  const parent = String(parentID || "").trim()
  if (entry.session?.id) {
    if (!parent || entry.session.parent === parent) return entry.session.id
  }

  const title = `WB: ${entry.worktree.branch || entry.name}`
  const created = await ctx.client.session.create({
    query: { directory: entry.worktree.path },
    body: {
      ...(parent ? { parentID: parent } : {}),
      title,
    },
  })
  const session = unwrap<any>(created)
  if (!session?.id) return ""

  await writeEntry(file, {
    ...entry,
    session: {
      id: session.id,
      ...(parent ? { parent } : {}),
      title,
    },
    time: entry.time,
  })

  return session.id
}

async function resolveTaskTargetByDirectory(base: string, ctx: any, sessionID: string, cwd: string, raw: string) {
  const target = await resolveDirectoryPath(ctx, cwd, raw)
  if (!target) return ""

  const st = await stat(target).catch(() => null)
  if (!st || !st.isDirectory()) return ""

  const repo = await detectRepo(ctx, target)
  const commonDir = requireGitRepo(repo.commonDir, target)
  const repoMeta = toRepoMeta({ commonDir, origin: repo.origin, root: repo.root })

  const all = await listAllLiveEntries(base)
  const hit = all.find(({ entry }) => path.resolve(entry.worktree.path) === target)
  if (hit) {
    const entry = await syncEntryRepo(hit.file, hit.entry, repoMeta)
    await dedupeDirEntries(base, target, hit.file)
    return await ensureTaskSessionForEntry(base, ctx, sessionID, hit.file, entry)
  }

  const branch = await gitBranch(ctx, target)
  const nameBase = (branch || path.basename(target) || "workbench").trim()
  const group = repoGroup(commonDir, target).group

  let suffix = 0
  while (suffix < 1000) {
    const candidate = suffix === 0 ? nameBase : `${nameBase}-${suffix + 1}`
    const name = clean(candidate) || `workbench-${randomBytes(3).toString("hex")}`
    const file = entryPath(base, group, name)
    const existing = await readEntry(file)
    if (existing && path.resolve(existing.worktree.path) !== target) {
      suffix++
      continue
    }

    const now = Date.now()
    const entry: Entry = existing ?? {
      version: 1,
      id: randomBytes(8).toString("hex"),
      name,
      worktree: {
        path: target,
        ...(branch ? { branch } : {}),
      },
      repo: repoMeta,
      github: {},
      time: {
        created: now,
        updated: now,
      },
    }

    const saved = await writeEntry(file, entry)
    await dedupeDirEntries(base, target, file)
    return await ensureTaskSessionForEntry(base, ctx, sessionID, file, saved)
  }

  return ""
}

async function resolveSessionMode(base: string, sessionID?: string) {
  const sid = String(sessionID || "").trim()
  if (!sid) return "default" as const

  const all = await listAllLiveEntries(base)
  if (all.some(({ entry }) => entry.session?.id === sid)) return "implementation" as const
  if (all.some(({ entry }) => entry.session?.parent === sid)) return "supervisor" as const
  return "default" as const
}

export const WorkbenchPlugin: Plugin = async (ctx) => {
  return {
    event: async (input) => {
      await relayTaskHandleEvent(ctx, input.event)
    },
    "experimental.chat.system.transform": async (input, output) => {
      const sessionMode = await resolveSessionMode(stateHome(), input.sessionID)
      output.system.push(INJECTION)
      output.system.push(TOOLING_MODE_HINT)
      if (sessionMode === "supervisor") output.system.push(SUPERVISOR_HINT)
      if (sessionMode === "implementation") output.system.push(IMPLEMENTATION_HINT)
    },
    "experimental.session.compacting": async (input, output) => {
      const sessionMode = await resolveSessionMode(stateHome(), input.sessionID)
      output.context.push(INJECTION)
      output.context.push(TOOLING_MODE_HINT)
      if (sessionMode === "supervisor") output.context.push(SUPERVISOR_HINT)
      if (sessionMode === "implementation") output.context.push(IMPLEMENTATION_HINT)
    },
    "tool.definition": async (input, output) => {
      if (input.toolID !== "task") return
      output.description = `${output.description}\n\n${INJECTION}`
    },
    "tool.execute.before": async (input, output) => {
      const base = stateHome()

      if (input.tool === "task") {
        if (!output.args || typeof output.args !== "object" || Array.isArray(output.args)) return
        const args = output.args as Record<string, unknown>

        const mode = await resolveSessionMode(base, input.sessionID)
        if (mode === "default") return
        if (mode === "implementation") {
          throw new Error(
            'workbench: built-in task is disabled in child implementation sessions. Execute work directly in this child session, or delegate from the supervisor via workbench { action: "task", dir: ".workbench/<name>", prompt: "..." }.',
          )
        }

        const raw = directoryArg(args)
        if (raw) {
          throw new Error(
            'workbench: built-in task directory is disabled in supervisor mode. Use workbench { action: "task", dir: ".workbench/<name>", prompt: "..." }.',
          )
        }

        const existing = typeof args.task_id === "string" ? args.task_id.trim() : ""
        if (existing) return
        const routed = await resolveTaskTargetSession(base, ctx, input.sessionID)
        if (routed) args.task_id = routed
        return
      }

      const sid = String(input.sessionID || "").trim()
      if (!sid) return

      const all = await listAllLiveEntries(base)

      const worker = all.find(({ entry }) => entry.session?.id === sid)
      if (worker) {
        const root = path.resolve(worker.entry.worktree.path)

        if (input.tool === "read" || input.tool === "edit" || input.tool === "write") {
          const target = resolvePath(root, fileArg(output.args))
          if (target && !within(root, target)) {
            throw new Error(
              `workbench: ${input.tool} is restricted to ${JSON.stringify(root)} for this workbench session (got ${JSON.stringify(target)}).`,
            )
          }
        }

        if (input.tool === "glob" || input.tool === "grep") {
          const target = resolvePath(root, pathArg(output.args))
          if (target && !within(root, target)) {
            throw new Error(
              `workbench: ${input.tool} path is restricted to ${JSON.stringify(root)} for this workbench session (got ${JSON.stringify(target)}).`,
            )
          }
        }

        if (input.tool === "bash") {
          const target = resolvePath(root, workdirArg(output.args))
          if (target && !within(root, target)) {
            throw new Error(
              `workbench: bash workdir is restricted to ${JSON.stringify(root)} for this workbench session (got ${JSON.stringify(target)}).`,
            )
          }
        }

        return
      }

      const isSupervisor = all.some(({ entry }) => entry.session?.parent === sid)
      if (!isSupervisor) return

      if (input.tool !== "edit" && input.tool !== "write") return

      const target = fileArg(output.args)
      if (isGitignore(target)) return

      throw new Error(
        'workbench: supervisor sessions MUST NOT edit child implementation files. Route edits via workbench { action: "task", dir: ".workbench/<name>", prompt: "..." }; only .gitignore setup edits are allowed here.',
      )
    },
    tool: {
      workbench: tool({
        description: DESCRIPTION,
        args: {
          action: tool.schema.enum(["help", "doctor", "list", "info", "bind", "open", "task", "remove"]),
          scope: tool.schema.enum(["session", "repo", "all"]).optional().describe("when action=list, scope to show (default: session)"),
          all: tool.schema.boolean().optional().describe("when action=list, alias for scope=all"),
          name: tool.schema.string().optional().describe("binding name (defaults to branch or directory name)"),
          dir: tool.schema
            .string()
            .optional()
            .describe(
              "directory (bind/open/task: worktree dir; list/info/remove/doctor: anchor dir; default: current directory)",
            ),
          branch: tool.schema.string().optional().describe("branch name (optional; auto-detected when possible)"),
          ghHost: tool.schema.string().optional().describe("GitHub host (e.g. github.com)"),
          upstream: tool.schema.string().optional().describe("upstream repo OWNER/REPO"),
          fork: tool.schema.string().optional().describe("fork repo OWNER/REPO"),
          prUrl: tool.schema.string().optional().describe("PR url to record"),
          clear: tool
            .schema
            .string()
            .optional()
            .describe("comma/space-separated fields to clear on bind (supported: github, ghHost, upstream, fork, prUrl)"),
          title: tool.schema.string().optional().describe("when action=open, session title"),
          prompt: tool
            .schema
            .string()
            .optional()
            .describe("when action=open, initial message; when action=task, required prompt to run"),
          task_id: tool
            .schema
            .string()
            .optional()
            .describe("when action=task, optional target session id (otherwise auto-routes when possible)"),
          sessionId: tool
            .schema
            .string()
            .optional()
            .describe("optional child/target session id for session-scoped list/info/task routing"),
          parentSessionId: tool
            .schema
            .string()
            .optional()
            .describe("optional parent session id (defaults to current tool session id) for session-scoped lookups"),
          strict: tool
            .schema
            .boolean()
            .optional()
            .describe("when action=info and multiple bindings match, throw instead of auto-picking the latest"),
          agent: tool
            .schema
            .string()
            .optional()
            .describe("when action=task, compatibility field; effective agent is inherited from the parent session"),
          command: tool.schema.string().optional().describe("when action=task, optional command trigger text"),
          force: tool.schema.boolean().optional().describe("when action=open, always create a new session"),
        },
        async execute(args, toolCtx) {
          const base = stateHome()
          await ensureDir(path.join(base, "entries"))
          const childSessionId = sessionArg(args.sessionId)
          const parentSessionId = sessionArg(args.parentSessionId) || String(toolCtx?.sessionID || "").trim()
          const clearSet = clearSetArg(args.clear)

          if (args.action === "help") return HELP

          if (args.action === "task") {
            const promptText = (args.prompt ?? "").trim()
            if (!promptText) {
              throw new Error("workbench: action=task requires a non-empty prompt")
            }

            const sessionID = parentSessionId
            const inheritedAgent = await parentAgent(ctx, toolCtx, sessionID)
            const cwd = path.resolve(String(toolCtx?.directory || ctx.directory || "").trim() || process.cwd())
            const byDirInput = (args.dir ?? "").trim()

            const byDir = byDirInput ? await resolveTaskTargetByDirectory(base, ctx, sessionID, cwd, byDirInput) : ""
            if (byDirInput && !byDir) {
              throw new Error(
                `workbench: cannot route task for dir ${JSON.stringify(args.dir)}. Ensure the path exists and is a git worktree (prefer .workbench/<name>).`,
              )
            }

            const byTask = (args.task_id ?? "").trim() || childSessionId
            if (byTask && byDir && byTask !== byDir) {
              throw new Error("workbench: action=task task_id conflicts with dir routing; use either task_id or a matching dir")
            }

            const routed = byTask || byDir || (await resolveTaskTargetSession(base, ctx, sessionID))
            if (!routed) {
              throw new Error(
                'workbench: no target session resolved. Open a workbench session first or pass dir=".workbench/<name>".',
              )
            }

            const entry = await findEntryBySession(base, routed)
            const byPath = await resolveDirectoryPath(ctx, cwd, byDirInput)
            const dir = entry?.entry.worktree.path || byPath
            if (!dir) {
              throw new Error(
                'workbench: target session has no bound worktree directory. Re-open via workbench { action: "open", dir: ".workbench/<name>" }.',
              )
            }
            const dirRepo = await detectRepo(ctx, dir)
            requireGitRepo(dirRepo.commonDir || entry?.entry.repo?.commonDir || "", dir)

            const prompt = (args.command ?? "").trim()
              ? `[command trigger]\n${(args.command ?? "").trim()}\n\n${promptText}`
              : promptText
            const rejectBefore = relayTaskRejectSnapshot(routed)

            const taskRun = await runSessionTaskSerial(routed, async () =>
              await (async () => {
                relayTaskEnter(routed)
                try {
                  return await ctx.client.session.prompt({
                    path: { id: routed },
                    query: { directory: dir },
                    body: {
                      agent: inheritedAgent,
                      parts: [{ type: "text", text: prompt }],
                    },
                  })
                } finally {
                  relayTaskLeave(routed)
                }
              })(),
            )
            const data = unwrap<any>(taskRun.value)
            const text = taskText(data)
            const rejectAfter = relayTaskRejectSnapshot(routed)
            const permissionRejects = Math.max(0, rejectAfter.permission - rejectBefore.permission)
            const questionRejects = Math.max(0, rejectAfter.question - rejectBefore.question)

            return [
              `task_id: ${routed} (for resuming this workbench task if needed)`,
              `agent: ${inheritedAgent} (inherited from parent session)`,
              `task_queue_ms: ${taskRun.queuedMs}`,
              `task_run_ms: ${taskRun.runMs}`,
              `task_queued: ${taskRun.queued ? "yes" : "no"}`,
              ...(permissionRejects > 0 ? [`task_permission_auto_rejects: ${permissionRejects}`] : []),
              ...(questionRejects > 0 ? [`task_question_auto_rejects: ${questionRejects}`] : []),
              "",
              "<task_result>",
              text,
              "</task_result>",
            ].join("\n")
          }

          if (args.action === "doctor") {
            const git = Bun.which("git")
            const gh = Bun.which("gh")
            const mode = toolingModeFrom(Boolean(git), Boolean(gh))
            const cwd = path.resolve(String(toolCtx?.directory || ctx.directory || "").trim() || process.cwd())
            const dir = (args.dir ?? "").trim()
            const target = dir
              ? path.isAbsolute(dir)
                ? path.resolve(dir)
                : path.resolve(cwd, dir)
              : cwd
            return [
              "workbench: doctor",
              `- base: ${base}`,
              `- tools: git=${git ? "ok" : "missing"} gh=${gh ? "ok" : "missing"}`,
              `- workflow mode: ${mode}`,
              ...(mode === "git-only"
                ? ["- mode note: gh is optional for local git-only flow. For GitHub-linked PR/check/merge steps, install + authenticate gh (for example gh auth login)."]
                : mode === "no-git"
                  ? ["- mode note: git is missing; install git before bind/open/task actions can work."]
                  : []),
              `- session: ${String(toolCtx?.sessionID || "").trim() || "(unknown)"}`,
              `- cwd: ${target}`,
              `- git common dir: ${(await detectRepo(ctx, target)).commonDir || "(not detected)"}`,
            ].join("\n")
          }

          if (args.action === "list") {
            const scope = normalizeScope(args.scope, args.all)
            if (scope === "all") {
              const items = await listAllLiveEntries(base)
              return formatList(items)
            }

            if (scope === "repo") {
              const cwd = path.resolve(String(toolCtx?.directory || ctx.directory || "").trim() || process.cwd())
              const dir = (args.dir ?? "").trim()
              const target = dir
                ? path.isAbsolute(dir)
                  ? path.resolve(dir)
                  : path.resolve(cwd, dir)
                : cwd

              const repo = await detectRepo(ctx, target)
              const current = await resolveCurrentBinding(base, ctx, toolCtx, parentSessionId, childSessionId)
              const commonDir = dir
                ? requireGitRepo(repo.commonDir, target)
                : requireGitRepo(repo.commonDir || current?.entry.repo?.commonDir || "", target)
              const items = await listRepoEntries(base, ctx, commonDir)
              return formatList(items)
            }

            // scope=session
            const items = await listSessionBindings(base, ctx, toolCtx, parentSessionId, childSessionId)
            if (!items.length) {
              return "workbench: no binding for this session (use scope=repo and optionally dir=...; or use scope=all)"
            }
            return formatList(items)
          }

          if (args.action === "info") {
            const name = (args.name ?? "").trim()
            const cwd = path.resolve(String(toolCtx?.directory || ctx.directory || "").trim() || process.cwd())
            const dirArg = (args.dir ?? "").trim()
            const sessionMatches = !name && !dirArg ? await listSessionBindings(base, ctx, toolCtx, parentSessionId, childSessionId) : []
            const strictInfo = args.strict === true
            const entry = await (async (): Promise<Entry | null> => {
              if (name) {
                const hit = await resolveBindingByName(base, ctx, toolCtx, name, dirArg, parentSessionId, childSessionId)
                return hit?.entry ?? null
              }
              if (dirArg) {
                const target = path.isAbsolute(dirArg) ? path.resolve(dirArg) : path.resolve(cwd, dirArg)
                const repo = await detectRepo(ctx, target)
                requireGitRepo(repo.commonDir, target)
                const hit = await resolveEntryByDir(base, target)
                return hit?.entry ?? null
              }
              if (strictInfo && sessionMatches.length > 1) {
                const names = sessionMatches.map(({ entry }) => entry.name).join(", ")
                throw new Error(`workbench: multiple bindings match this session scope (${names}). Pass name or dir.`)
              }
              if (sessionMatches.length) return sessionMatches[0].entry
              const current = await resolveCurrentBinding(base, ctx, toolCtx, parentSessionId, childSessionId)
              return current?.entry ?? null
            })()

            if (!entry) {
              return name
                ? "workbench: binding not found"
                : "workbench: no binding for this session (try: workbench { action: \"open\" })"
            }
            const lines: string[] = []
            lines.push("workbench: info")
            lines.push(`- name: ${entry.name}`)
            lines.push(`- dir: ${entry.worktree.path}`)
            if (entry.worktree.branch) lines.push(`- branch: ${entry.worktree.branch}`)
            if (entry.repo?.commonDir) lines.push(`- git common dir: ${entry.repo.commonDir}`)
            if (entry.repo?.origin) lines.push(`- git origin: ${entry.repo.origin}`)
            if (entry.repo?.root) lines.push(`- git root: ${entry.repo.root}`)
            if (entry.github?.upstream || entry.github?.fork || entry.github?.prUrl) {
              lines.push(
                `- github: host=${entry.github?.host || ""}${entry.github?.upstream ? ` upstream=${entry.github.upstream}` : ""}${entry.github?.fork ? ` fork=${entry.github.fork}` : ""}`,
              )
              if (entry.github?.prUrl) lines.push(`- pr: ${entry.github.prUrl}`)
            }
            if (entry.session?.id) {
              lines.push(`- session: ${entry.session.id}`)
              lines.push(`Try: opencode run --session ${entry.session.id} --dir ${JSON.stringify(entry.worktree.path)}`)
              lines.push(
                `Task tip: from the supervisor session, call workbench { action: "task", dir: ".workbench/<name>", prompt: "..." }, or pass task_id=${entry.session.id} when routing is ambiguous`,
              )
            } else {
              lines.push(`Try: workbench { action: "open", name: ${JSON.stringify(entry.name)} }`)
            }
            if (sessionMatches.length > 1 && !name && !dirArg) {
              lines.push(
                `- note: multiple bindings matched this session context; showing the most recently updated (${entry.name}). Pass name to inspect another binding.`,
              )
            }
            return lines.join("\n")
          }

          if (args.action === "remove") {
            const name = (args.name ?? "").trim()
            if (!name) {
              const current = await resolveCurrentBinding(base, ctx, toolCtx, parentSessionId, childSessionId)
              if (!current) return "workbench: no binding for this session"
              const removed = await removeEntryFile(current.file)
              if (!removed) throw new Error(`workbench: failed to remove binding ${JSON.stringify(current.entry.name)}`)
              return `workbench: removed ${current.entry.name}`
            }

            const dir = (args.dir ?? "").trim()
            const hit = await resolveBindingByName(base, ctx, toolCtx, name, dir, parentSessionId, childSessionId)
            if (!hit) return `workbench: binding not found: ${name}`
            const removed = await removeEntryFile(hit.file)
            if (!removed) throw new Error(`workbench: failed to remove binding ${JSON.stringify(hit.entry.name)}`)
            return `workbench: removed ${hit.entry.name}`
          }

          if (args.action === "bind" || args.action === "open") {
            const nameArg = (args.name ?? "").trim()
            const dirArg = (args.dir ?? "").trim()

            const defaultCwd = path.resolve(String(toolCtx?.directory || ctx.directory || "").trim() || process.cwd())

            const formatBound = (saved: Entry) =>
              [
                "workbench: bound",
                `- name: ${saved.name}`,
                `- dir: ${saved.worktree.path}`,
                ...(saved.worktree.branch ? [`- branch: ${saved.worktree.branch}`] : []),
              ].join("\n")

            const patchExisting = async (file: string, existing: Entry) => {
              const branchInput = (args.branch ?? "").trim()
              const github = mergeGithubMetadata(
                existing.github,
                {
                  ghHost: args.ghHost,
                  upstream: args.upstream,
                  fork: args.fork,
                  prUrl: args.prUrl,
                },
                clearSet,
              )
              return await writeEntry(file, {
                ...existing,
                worktree: {
                  ...existing.worktree,
                  ...(branchInput ? { branch: branchInput } : {}),
                },
                github,
                time: existing.time,
              })
            }

            const openFrom = async (file: string, saved: Entry) => {
              const repo = await detectRepo(ctx, saved.worktree.path)
              const commonDir = requireGitRepo(repo.commonDir || saved.repo?.commonDir || "", saved.worktree.path)
              const entry = await syncEntryRepo(file, saved, toRepoMeta({ commonDir, origin: repo.origin, root: repo.root }))

              const parent = parentSessionId
              if (entry.session?.id && args.force !== true && (!parent || entry.session.parent === parent)) {
                return [
                  "workbench: already opened",
                  `- name: ${entry.name}`,
                  `- dir: ${entry.worktree.path}`,
                  `- session: ${entry.session.id}`,
                  `Try: opencode run --session ${entry.session.id} --dir ${JSON.stringify(entry.worktree.path)}`,
                  'Task tip: run workbench { action: "task", dir: ".workbench/<name>", prompt: "..." } from the supervisor session',
                ].join("\n")
              }

              const title = (args.title ?? "").trim() || `WB: ${entry.worktree.branch || entry.name}`
              const created = await ctx.client.session.create({
                query: { directory: entry.worktree.path },
                body: {
                  ...(parent ? { parentID: parent } : {}),
                  title,
                },
              })
              const session = unwrap<any>(created)
              if (!session?.id) throw new Error("workbench: failed to create session")

              const updated = await writeEntry(file, {
                ...entry,
                session: {
                  id: session.id,
                  ...(parent ? { parent } : {}),
                  title,
                },
                time: entry.time,
              })

              if ((args.prompt ?? "").trim()) {
                const inheritedAgent = await parentAgent(ctx, toolCtx, parentSessionId)
                await ctx.client.session.promptAsync({
                  path: { id: session.id },
                  query: { directory: updated.worktree.path },
                  body: {
                    agent: inheritedAgent,
                    parts: [{ type: "text", text: args.prompt!.trim() }],
                  },
                })
              }

              return [
                "workbench: opened",
                `- name: ${updated.name}`,
                `- dir: ${updated.worktree.path}`,
                ...(updated.worktree.branch ? [`- branch: ${updated.worktree.branch}`] : []),
                `- session: ${session.id}`,
                `Try: opencode run --session ${session.id} --dir ${JSON.stringify(updated.worktree.path)}`,
                'Task tip: run workbench { action: "task", dir: ".workbench/<name>", prompt: "..." } from the supervisor session',
              ].join("\n")
            }

            const bindOrOpenExisting = async (file: string, existing: Entry) => {
              const repo = await detectRepo(ctx, existing.worktree.path)
              const commonDir = requireGitRepo(repo.commonDir || existing.repo?.commonDir || "", existing.worktree.path)
              const scoped = await syncEntryRepo(
                file,
                existing,
                toRepoMeta({ commonDir, origin: repo.origin, root: repo.root }),
              )
              const saved = await patchExisting(file, scoped)
              if (args.action === "bind") return formatBound(saved)
              return await openFrom(file, saved)
            }

            // Default to the current session binding if neither name nor dir is provided.
            if (!nameArg && !dirArg) {
              const current = await resolveCurrentBinding(base, ctx, toolCtx, parentSessionId, childSessionId)
              if (current) {
                return await bindOrOpenExisting(current.file, current.entry)
              }
            }

            // Name-only operations update/open an existing binding without changing its directory.
            if (!dirArg && nameArg) {
              const existing = await resolveBindingByName(base, ctx, toolCtx, nameArg, "", parentSessionId, childSessionId)
              if (!existing) {
                throw new Error(`workbench: binding not found: ${nameArg} (pass dir to create it, or create/open from a git repo directory)`)
              }

              return await bindOrOpenExisting(existing.file, existing.entry)
            }

            // Dir-based operations create/update a binding for that directory.
            const input = (dirArg || defaultCwd).trim() || defaultCwd
            const top = await gitTopLevel(ctx, defaultCwd)
            const rel = input.replace(/^\.\//, "")
            if (!top && (rel === ".workbench" || rel.startsWith(".workbench/"))) {
              throw new Error(
                "workbench: .workbench paths must be resolved from inside a git repo; pass dir as <repo>/.workbench/<name> or use an absolute path",
              )
            }
            const root = top || defaultCwd
            const dir = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input)
            const st = await stat(dir).catch(() => null)
            if (!st || !st.isDirectory()) throw new Error(`workbench: dir not found: ${dir}`)

            const repo = await detectRepo(ctx, dir)
            const commonDir = requireGitRepo(repo.commonDir, dir)
            const repoMeta = toRepoMeta({ commonDir, origin: repo.origin, root: repo.root })
            const branch = (args.branch ?? "").trim() || (await gitBranch(ctx, dir))
            const existingByDir = await resolveEntryByDir(base, dir)
            if (existingByDir) {
              const scopedExisting = await syncEntryRepo(existingByDir.file, existingByDir.entry, repoMeta)
              const mergedName = (nameArg || scopedExisting.name || branch || path.basename(dir)).trim()
              if (!mergedName) throw new Error("workbench: name is required")
              const mergedBranch = branch || scopedExisting.worktree.branch || ""
              const github = mergeGithubMetadata(
                scopedExisting.github,
                {
                  ghHost: args.ghHost,
                  upstream: args.upstream,
                  fork: args.fork,
                  prUrl: args.prUrl,
                },
                clearSet,
              )
              const merged = await writeEntry(existingByDir.file, {
                ...scopedExisting,
                name: clean(mergedName) || mergedName,
                worktree: {
                  path: dir,
                  ...(mergedBranch ? { branch: mergedBranch } : {}),
                },
                repo: repoMeta,
                github,
                time: scopedExisting.time,
              })
              await dedupeDirEntries(base, dir, existingByDir.file)
              if (args.action === "bind") return formatBound(merged)
              return await openFrom(existingByDir.file, merged)
            }

            const name = (nameArg || branch || path.basename(dir)).trim()
            if (!name) throw new Error("workbench: name is required")

            const group = repoGroup(commonDir, dir).group
            const file = entryPath(base, group, name)
            const existing = await readEntry(file)
            if (existing && path.resolve(existing.worktree.path) !== dir) {
              throw new Error(
                `workbench: binding name already exists (${existing.name}) for ${JSON.stringify(existing.worktree.path)}. Use another name or reuse the existing dir binding.`,
              )
            }
            const scopedExisting = existing ? await syncEntryRepo(file, existing, repoMeta) : null

            const now = Date.now()
            const next: Entry = {
              version: 1,
              id: scopedExisting?.id ?? randomBytes(8).toString("hex"),
              name: clean(name) || name,
              worktree: {
                path: dir,
                ...(branch ? { branch } : {}),
              },
              repo: repoMeta,
              github: mergeGithubMetadata(
                scopedExisting?.github,
                {
                  ghHost: args.ghHost,
                  upstream: args.upstream,
                  fork: args.fork,
                  prUrl: args.prUrl,
                },
                clearSet,
              ),
              session: scopedExisting?.session,
              time: {
                created: scopedExisting?.time?.created ?? now,
                updated: now,
              },
            }

            const saved = await writeEntry(file, next)
            await dedupeDirEntries(base, dir, file)

            if (args.action === "bind") return formatBound(saved)
            return await openFrom(file, saved)
          }

          throw new Error("workbench: unsupported action")
        },
      }),
    },
  }
}

export default WorkbenchPlugin
