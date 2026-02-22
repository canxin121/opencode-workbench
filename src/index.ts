import { tool, type Plugin } from "@opencode-ai/plugin"
import { mkdir, readdir, rm, rename, stat, open } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomBytes, createHash } from "node:crypto"

const META = ".opencode-workbench.json"

const DEFAULT_EXCLUDE = [".git", META, "node_modules", "dist", "build", ".next", ".turbo", "coverage", ".cache", "target", ".DS_Store"]

const DESCRIPTION = `Manage per-branch sandboxes (temporary directory copies) for parallel development.

Why: when running multiple OpenCode sessions across branches/worktrees, it's easy to accidentally edit files in the wrong folder.
This tool creates an isolated sandbox copy and pins the created child session to that sandbox directory.
`

type Meta = {
  version: 1
  id: string
  name: string
  branch?: string
  copy?: {
    mode: "archive" | "worktree"
    excludeMode?: "append" | "replace"
    exclude: string[]
  }
  github?: {
    host: string
    upstream?: string
    fork?: string
    protocol?: "ssh" | "https"
    defaultBranch?: string
    base?: string
    remotes?: {
      upstream: string
      fork: string
    }
    pr?: {
      url: string
    }
  }
  project: {
    id: string
    worktree: string
  }
  source: {
    worktree: string
  }
  sandbox: {
    path: string
  }
  session?: {
    id: string
    parent?: string
  }
  publish?: {
    time: number
    commit?: string
    pushed?: {
      remote: string
      branch: string
    }
  }
  time: {
    created: number
    updated: number
  }
}

const unwrap = <T>(response: unknown): T => {
  if (response && typeof response === "object" && "data" in response) {
    const data = (response as { data?: T }).data
    if (data !== undefined) return data
  }
  return response as T
}

const uniq = (list: string[]) => Array.from(new Set(list.map((x) => x.trim()).filter(Boolean)))

const clean = (input: string) =>
  input
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "")
    .slice(0, 120)

const hash = (input: string) => createHash("sha1").update(input).digest("hex").slice(0, 8)

const key = (input: string) => clean(input) || "x"

const isInside = (root: string, candidate: string) => {
  const rel = path.relative(root, candidate)
  if (!rel) return true
  if (rel.startsWith(".." + path.sep) || rel === "..") return false
  return !path.isAbsolute(rel)
}

const readMeta = async (dir: string) => {
  const file = Bun.file(path.join(dir, META))
  if (!(await file.exists())) return null
  const raw = await file.text().catch(() => "")
  if (!raw.trim()) return null
  const data = JSON.parse(raw) as Meta
  if (!data || typeof data !== "object") return null
  if (data.version !== 1) return null
  if (!data.sandbox?.path) return null
  return data
}

const writeMeta = async (dir: string, meta: Meta) => {
  const next: Meta = {
    ...meta,
    time: {
      ...meta.time,
      updated: Date.now(),
    },
  }
  await Bun.write(path.join(dir, META), JSON.stringify(next, null, 2) + "\n")
  return next
}

async function roots(ctx: any) {
  const info = await ctx.client.path.get({ query: { directory: ctx.directory } }).catch(() => null)
  const data = info ? unwrap<{ state?: string }>(info) : null
  const state = typeof data?.state === "string" && data.state.trim() ? data.state : path.join(os.tmpdir(), "opencode")
  const base = path.join(state, "workbench")
  return {
    base,
    sandboxes: path.join(base, "sandboxes"),
    worktrees: path.join(base, "worktrees"),
    tmp: path.join(base, "tmp"),
    locks: path.join(base, "locks"),
  }
}

const CONFIG_FILE = "workbench.toml"

type Config = {
  base?: string
  copyMode?: "archive" | "worktree"
  copyExclude?: string[]
  copyExcludeMode?: "append" | "replace"
  github?: boolean
  ghHost?: string
  repo?: string
  fork?: string
  forkRemote?: string
  upstreamRemote?: string
  protocol?: "auto" | "ssh" | "https"
  fetch?: boolean
  push?: boolean
  pr?: boolean
  draft?: boolean
  prBase?: string
  prTitle?: string
  prBody?: string
  prLabels?: string[]
  prReviewers?: string[]
  prAssignees?: string[]
  prProjects?: string[]
  prMilestone?: string
  prNoMaintainerEdit?: boolean
  delete?: boolean
  previewLines?: number
  commit?: boolean
  commitMessage?: string
  commitBody?: string
  commitBodyAuto?: boolean
  stage?: "all" | "tracked"
  noVerify?: boolean
  sign?: boolean
  allowDirty?: boolean
  cleanupSandbox?: boolean
  resetBackup?: boolean
  resetDelete?: boolean
  gcDays?: number
  gcKeepWithSession?: boolean
  lockTimeout?: number
}

type LoadedConfig = {
  path: string
  status: "missing" | "loaded" | "invalid"
  config: Config
}

function getBase(ctx: any) {
  const root = typeof ctx.worktree === "string" && ctx.worktree.trim() && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
  return path.resolve(root)
}

async function loadConfig(base: string): Promise<LoadedConfig> {
  const file = path.join(base, ".opencode", CONFIG_FILE)
  const src = Bun.file(file)
  if (!(await src.exists())) {
    return { path: file, status: "missing", config: {} }
  }

  const raw = await src.text().catch(() => "")
  if (!raw.trim()) {
    return { path: file, status: "invalid", config: {} }
  }

  const obj = (() => {
    try {
      const parsed = Bun.TOML.parse(raw)
      if (!parsed || typeof parsed !== "object") return null
      return parsed as Record<string, unknown>
    } catch {
      return null
    }
  })()
  if (!obj) return { path: file, status: "invalid", config: {} }

  const data = (() => {
    const scoped = obj.workbench
    if (scoped && typeof scoped === "object") return scoped as Record<string, unknown>
    return obj
  })()

  const one = <T extends string>(value: unknown, allowed: readonly T[]) =>
    typeof value === "string" && allowed.includes(value as T) ? (value as T) : undefined
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)
  const bool = (value: unknown) => (typeof value === "boolean" ? value : undefined)
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined

  const config: Config = {
    base: str(data.base),
    copyMode: one(data.copyMode, ["archive", "worktree"]),
    copyExclude: list(data.copyExclude),
    copyExcludeMode: one(data.copyExcludeMode, ["append", "replace"]),
    github: bool(data.github),
    ghHost: str(data.ghHost),
    repo: str(data.repo),
    fork: str(data.fork),
    forkRemote: str(data.forkRemote),
    upstreamRemote: str(data.upstreamRemote),
    protocol: one(data.protocol, ["auto", "ssh", "https"]),
    fetch: bool(data.fetch),
    push: bool(data.push),
    pr: bool(data.pr),
    draft: bool(data.draft),
    prBase: str(data.prBase),
    prTitle: str(data.prTitle),
    prBody: str(data.prBody),
    prLabels: list(data.prLabels),
    prReviewers: list(data.prReviewers),
    prAssignees: list(data.prAssignees),
    prProjects: list(data.prProjects),
    prMilestone: str(data.prMilestone),
    prNoMaintainerEdit: bool(data.prNoMaintainerEdit),
    delete: bool(data.delete),
    previewLines: num(data.previewLines),
    commit: bool(data.commit),
    commitMessage: str(data.commitMessage),
    commitBody: str(data.commitBody),
    commitBodyAuto: bool(data.commitBodyAuto),
    stage: one(data.stage, ["all", "tracked"]),
    noVerify: bool(data.noVerify),
    sign: bool(data.sign),
    allowDirty: bool(data.allowDirty),
    cleanupSandbox: bool(data.cleanupSandbox),
    resetBackup: bool(data.resetBackup),
    resetDelete: bool(data.resetDelete),
    gcDays: num(data.gcDays),
    gcKeepWithSession: bool(data.gcKeepWithSession),
    lockTimeout: num(data.lockTimeout),
  }

  return {
    path: file,
    status: "loaded",
    config,
  }
}

async function ensureGit(ctx: any) {
  const root = (ctx.worktree ?? "").trim()
  if (!root || root === "/") throw new Error("workbench: requires a git worktree (ctx.worktree not set)")

  const out = await ctx.$`git -C ${root} rev-parse --is-inside-work-tree`.nothrow().quiet()
  if (out.exitCode !== 0) throw new Error("workbench: current directory is not inside a git repository")
  return root
}

async function ensureGh(ctx: any, host: string, root: string) {
  const ok = await ctx.$.cwd(root)`gh --version`.env({ GH_HOST: host }).nothrow().quiet()
  if (ok.exitCode !== 0) {
    throw new Error("workbench: gh not found on PATH")
  }

  const auth = await ctx.$.cwd(root)`gh auth status -h ${host}`.env({ GH_HOST: host }).nothrow().quiet()
  if (auth.exitCode !== 0) {
    throw new Error(`workbench: gh is not authenticated for ${host} (run: gh auth login)`) 
  }
}

type GhRepo = {
  nameWithOwner: string
  isFork?: boolean
  parent?: {
    nameWithOwner?: string
  }
  sshUrl?: string
}

function httpsClone(host: string, repo: string) {
  return `https://${host}/${repo}.git`
}

function sshClone(host: string, sshUrl: string | undefined, repo: string) {
  if (sshUrl && sshUrl.trim()) return sshUrl.trim()
  return `git@${host}:${repo}.git`
}

async function ghDefaultBranch(ctx: any, root: string, host: string, repo: string) {
  const res = await ctx.$
    .cwd(root)`gh api repos/${repo} --hostname ${host} --jq .default_branch`
    .env({ GH_HOST: host })
    .nothrow()
    .quiet()
  if (res.exitCode !== 0) {
    throw new Error(`workbench: failed to resolve default branch for ${repo}: ${res.stderr.toString() || res.stdout.toString()}`)
  }
  const branch = res.text().trim()
  if (!branch) throw new Error(`workbench: failed to resolve default branch for ${repo}`)
  return branch
}

async function gitRemoteHead(ctx: any, root: string, remote: string) {
  const res = await ctx.$`git -C ${root} symbolic-ref --quiet refs/remotes/${remote}/HEAD`.nothrow().quiet()
  if (res.exitCode !== 0) return ""
  const ref = res.text().trim()
  const parts = ref.split("/")
  return parts[parts.length - 1] ?? ""
}

async function gitHas(ctx: any, root: string, ref: string) {
  const res = await ctx.$`git -C ${root} show-ref --verify --quiet ${ref}`.nothrow().quiet()
  return res.exitCode === 0
}

function repoArg(host: string, nameWithOwner: string) {
  if (!nameWithOwner) return ""
  if (host && host !== "github.com") return `${host}/${nameWithOwner}`
  return nameWithOwner
}

async function prUrl(ctx: any, root: string, host: string, upstream: string, head: string) {
  const args = [
    "pr",
    "list",
    "-R",
    repoArg(host, upstream),
    "--head",
    head,
    "--state",
    "open",
    "--json",
    "url",
  ]
  const list = await ghJson(ctx, root, host, args).catch(() => null)
  if (!Array.isArray(list) || !list.length) return ""
  const url = (list[0] as any)?.url
  return typeof url === "string" ? url.trim() : ""
}

async function prCreate(ctx: any, root: string, host: string, upstream: string, input: {
  head: string
  base: string
  title: string
  body: string
  draft: boolean
  labels?: string[]
  reviewers?: string[]
  assignees?: string[]
  projects?: string[]
  milestone?: string
  noMaintainerEdit?: boolean
}) {
  const labels = (input.labels ?? []).map((x) => x.trim()).filter(Boolean)
  const reviewers = (input.reviewers ?? []).map((x) => x.trim()).filter(Boolean)
  const assignees = (input.assignees ?? []).map((x) => x.trim()).filter(Boolean)
  const projects = (input.projects ?? []).map((x) => x.trim()).filter(Boolean)
  const milestone = (input.milestone ?? "").trim()
  const args = [
    "pr",
    "create",
    "-R",
    repoArg(host, upstream),
    "--head",
    input.head,
    "--base",
    input.base,
    "--title",
    input.title,
    "--body",
    input.body,
    ...(labels.length ? ["--label", labels.join(",")] : []),
    ...(reviewers.length ? ["--reviewer", reviewers.join(",")] : []),
    ...(assignees.length ? ["--assignee", assignees.join(",")] : []),
    ...(projects.length ? ["--project", projects.join(",")] : []),
    ...(milestone ? ["--milestone", milestone] : []),
    ...(input.noMaintainerEdit ? ["--no-maintainer-edit"] : []),
    ...(input.draft ? ["--draft"] : []),
  ]
  const res = await ctx.$.cwd(root)`gh ${args}`.env({ GH_HOST: host }).nothrow().quiet()
  if (res.exitCode !== 0) {
    throw new Error(`workbench: gh pr create failed: ${res.stderr.toString() || res.stdout.toString()}`)
  }
  const text = res.text().trim()
  const match = text.match(/https?:\/\/\S+/)
  return match?.[0] ?? ""
}

async function prEdit(ctx: any, root: string, host: string, upstream: string, pr: string, input: {
  base?: string
  title?: string
  body?: string
  labels?: string[]
  reviewers?: string[]
  assignees?: string[]
  projects?: string[]
  milestone?: string
}) {
  const labels = (input.labels ?? []).map((x) => x.trim()).filter(Boolean)
  const reviewers = (input.reviewers ?? []).map((x) => x.trim()).filter(Boolean)
  const assignees = (input.assignees ?? []).map((x) => x.trim()).filter(Boolean)
  const projects = (input.projects ?? []).map((x) => x.trim()).filter(Boolean)
  const milestone = (input.milestone ?? "").trim()
  const base = (input.base ?? "").trim()

  const args = [
    "pr",
    "edit",
    pr,
    "-R",
    repoArg(host, upstream),
    ...(base ? ["--base", base] : []),
    ...(input.title !== undefined ? ["--title", input.title] : []),
    ...(input.body !== undefined ? ["--body", input.body] : []),
    ...(labels.length ? ["--add-label", labels.join(",")] : []),
    ...(reviewers.length ? ["--add-reviewer", reviewers.join(",")] : []),
    ...(assignees.length ? ["--add-assignee", assignees.join(",")] : []),
    ...(projects.length ? ["--add-project", projects.join(",")] : []),
    ...(milestone ? ["--milestone", milestone] : []),
  ]
  const res = await ctx.$.cwd(root)`gh ${args}`.env({ GH_HOST: host }).nothrow().quiet()
  if (res.exitCode !== 0) {
    throw new Error(`workbench: gh pr edit failed: ${res.stderr.toString() || res.stdout.toString()}`)
  }
}

async function ghJson(ctx: any, root: string, host: string, args: string[]) {
  const res = await ctx.$.cwd(root)`gh ${args}`.env({ GH_HOST: host }).nothrow().quiet()
  if (res.exitCode !== 0) {
    throw new Error(`workbench: gh failed: ${res.stderr.toString() || res.stdout.toString()}`)
  }
  const text = res.text().trim()
  if (!text) throw new Error("workbench: gh returned empty output")
  return JSON.parse(text)
}

async function ghRepoInfo(ctx: any, root: string, host: string, repo?: string): Promise<GhRepo> {
  const args = repo
    ? ["repo", "view", repo, "--json", "nameWithOwner,isFork,parent,sshUrl"]
    : ["repo", "view", "--json", "nameWithOwner,isFork,parent,sshUrl"]
  return (await ghJson(ctx, root, host, args)) as GhRepo
}

async function ghUser(ctx: any, root: string, host: string): Promise<string> {
  const res = await ctx.$.cwd(root)`gh api user --jq .login --hostname ${host}`.env({ GH_HOST: host }).nothrow().quiet()
  if (res.exitCode !== 0) {
    throw new Error(`workbench: gh api user failed: ${res.stderr.toString() || res.stdout.toString()}`)
  }
  const login = res.text().trim()
  if (!login) throw new Error("workbench: failed to resolve gh user login")
  return login
}

async function ghProtocol(ctx: any, root: string, host: string): Promise<"ssh" | "https" | ""> {
  const res = await ctx.$.cwd(root)`gh config get git_protocol -h ${host}`.env({ GH_HOST: host }).nothrow().quiet()
  if (res.exitCode !== 0) return ""
  const text = res.text().trim().toLowerCase()
  if (text === "ssh") return "ssh"
  if (text === "https") return "https"
  return ""
}

async function gitRemoteUrl(ctx: any, root: string, name: string) {
  const res = await ctx.$`git -C ${root} remote get-url ${name}`.nothrow().quiet()
  if (res.exitCode !== 0) return ""
  return res.text().trim()
}

async function gitSetRemote(ctx: any, root: string, name: string, url: string) {
  const existing = await gitRemoteUrl(ctx, root, name)
  if (!existing) {
    const add = await ctx.$`git -C ${root} remote add ${name} ${url}`.nothrow().quiet()
    if (add.exitCode !== 0) {
      throw new Error(`workbench: failed to add remote ${name}: ${add.stderr.toString() || add.stdout.toString()}`)
    }
    return
  }
  if (existing === url) return
  const set = await ctx.$`git -C ${root} remote set-url ${name} ${url}`.nothrow().quiet()
  if (set.exitCode !== 0) {
    throw new Error(`workbench: failed to set remote ${name}: ${set.stderr.toString() || set.stdout.toString()}`)
  }
}

function originProtocol(origin: string): "ssh" | "https" {
  if (origin.startsWith("http://") || origin.startsWith("https://")) return "https"
  if (origin.startsWith("ssh://") || origin.startsWith("git@")) return "ssh"
  return "https"
}

async function gitFetch(ctx: any, root: string, remote: string) {
  const res = await ctx.$`git -C ${root} fetch --prune ${remote}`.nothrow().quiet()
  if (res.exitCode !== 0) {
    throw new Error(`workbench: git fetch failed (${remote}): ${res.stderr.toString() || res.stdout.toString()}`)
  }
}

async function gitCommon(ctx: any, dir: string) {
  const res = await ctx.$`git -C ${dir} rev-parse --git-common-dir`.nothrow().quiet()
  if (res.exitCode !== 0) {
    throw new Error(`workbench: not a git worktree: ${dir}`)
  }
  const out = res.text().trim()
  if (!out) throw new Error(`workbench: failed to resolve git common dir: ${dir}`)
  return path.resolve(dir, out)
}

async function prepareGithub(
  ctx: any,
  root: string,
  input: {
    host: string
    repo?: string
    fork?: string
    protocol: "auto" | "ssh" | "https"
    upstreamRemote: string
    forkRemote: string
    fetch: boolean
  },
  log: (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, any>) => void,
) {
  await ensureGh(ctx, input.host, root)

  const current = await ghRepoInfo(ctx, root, input.host, input.repo)
  const upstream = current.isFork ? (current.parent?.nameWithOwner ?? "") : current.nameWithOwner
  if (!upstream) throw new Error("workbench: failed to resolve upstream repo (try passing repo=OWNER/REPO)")

  const upstreamInfo = await ghRepoInfo(ctx, root, input.host, upstream)
  const origin = await gitRemoteUrl(ctx, root, "origin")
  const protocol =
    input.protocol === "auto"
      ? ((await ghProtocol(ctx, root, input.host)) || originProtocol(origin))
      : input.protocol
  const upstreamUrl =
    protocol === "https" ? httpsClone(input.host, upstreamInfo.nameWithOwner) : sshClone(input.host, upstreamInfo.sshUrl, upstreamInfo.nameWithOwner)
  if (!upstreamUrl) throw new Error("workbench: failed to resolve upstream repo URL")

  const repoName = upstream.split("/")[1] ?? ""
  if (!repoName) throw new Error("workbench: invalid upstream repo")

  const fork = (() => {
    if (input.fork && input.fork.includes("/")) return input.fork
    if (current.isFork) return current.nameWithOwner
    return ""
  })()

  const forkName = fork || `${await ghUser(ctx, root, input.host)}/${repoName}`

  const forkCmd = await ctx.$.cwd(root)`gh repo fork ${upstream} --clone=false --remote --remote-name ${input.forkRemote}`
    .env({ GH_HOST: input.host })
    .nothrow()
    .quiet()
  if (forkCmd.exitCode !== 0) {
    log("warn", "gh repo fork failed (continuing to validate via repo view)", {
      upstream,
      forkRemote: input.forkRemote,
      stderr: forkCmd.stderr.toString(),
      stdout: forkCmd.stdout.toString(),
    })
  }

  const forkInfo = await (async () => {
    const delays = [0, 500, 1000, 2000, 4000]
    for (const delay of delays) {
      if (delay) await new Promise((r) => setTimeout(r, delay))
      const info = await ghRepoInfo(ctx, root, input.host, forkName).catch(() => null)
      if (info?.nameWithOwner) return info
    }
    return null
  })()
  if (!forkInfo?.nameWithOwner) {
    throw new Error(`workbench: fork repo not accessible: ${forkName}`)
  }
  const forkUrl = protocol === "https" ? httpsClone(input.host, forkInfo.nameWithOwner) : sshClone(input.host, forkInfo.sshUrl, forkInfo.nameWithOwner)
  if (!forkUrl) throw new Error("workbench: failed to resolve fork repo URL")

  await gitSetRemote(ctx, root, input.upstreamRemote, upstreamUrl)
  await gitSetRemote(ctx, root, input.forkRemote, forkUrl)

  const defaultBranch = await ghDefaultBranch(ctx, root, input.host, upstream)
    .catch(async (err) => {
      log("warn", "failed to resolve default branch via gh api", {
        upstream,
        error: err instanceof Error ? err.message : String(err),
      })
      return ""
    })

  if (input.fetch) {
    const remotes = [input.upstreamRemote, input.forkRemote]
    for (const remote of Array.from(new Set(remotes))) {
      await gitFetch(ctx, root, remote)
    }
  }

  const fallback = defaultBranch || (await gitRemoteHead(ctx, root, input.upstreamRemote).catch(() => ""))
  const resolved = fallback || "main"
  if (!fallback) {
    log("warn", "default branch fallback in effect", {
      upstream,
      picked: resolved,
      reason: "gh api + remote HEAD unavailable",
    })
  }

  return {
    upstream,
    fork: forkInfo.nameWithOwner,
    protocol,
    defaultBranch: resolved,
    remotes: {
      upstream: input.upstreamRemote,
      fork: input.forkRemote,
    },
  }
}

async function branch(ctx: any, fallbackRoot: string) {
  const info = await ctx.client.vcs.get({ query: { directory: ctx.directory } }).catch(() => null)
  const data = info ? unwrap<{ branch?: string }>(info) : null
  const b = typeof data?.branch === "string" ? data.branch.trim() : ""
  if (b) return b

  const out = await ctx.$`git -C ${fallbackRoot} rev-parse --short HEAD`.nothrow().quiet()
  const sha = out.exitCode === 0 ? out.text().trim() : "unknown"
  return `detached-${sha || "unknown"}`
}

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true })
  return dir
}

function lockname(input: string) {
  return `${key(input)}-${hash(input)}`
}

async function withLock<R>(
  file: string,
  input: {
    timeoutMs: number
    force: boolean
    info: Record<string, unknown>
  },
  fn: () => Promise<R>,
): Promise<R> {
  await ensureDir(path.dirname(file))
  const now = Date.now()

  async function acquire() {
    const handle = await open(file, "wx").catch((error) => {
      const err = error as { code?: string }
      if (err?.code === "EEXIST") return null
      throw error
    })
    if (!handle) return false
    await handle.writeFile(JSON.stringify({ ...input.info, pid: process.pid, time: now }, null, 2) + "\n")
    await handle.close()
    return true
  }

  for (let i = 0; i < 2; i++) {
    if (await acquire()) {
      try {
        return await fn()
      } finally {
        await rm(file, { force: true }).catch(() => {})
      }
    }

    const st = await stat(file).catch(() => null)
    if (!st) continue
    const age = now - st.mtimeMs
    if (input.force || (input.timeoutMs > 0 && age > input.timeoutMs)) {
      await rm(file, { force: true }).catch(() => {})
      continue
    }

    const detail = await Bun.file(file)
      .text()
      .then((x) => x.trim())
      .catch(() => "")
    throw new Error(`workbench: locked (${Math.ceil(age / 1000)}s old) ${detail ? "\n" + detail : ""}`)
  }

  throw new Error("workbench: failed to acquire lock")
}

async function makeWorktree(ctx: any, root: string, outDir: string, b: string, from?: string) {
  await ensureDir(path.dirname(outDir))
  const exists = await Bun.file(outDir).exists().catch(() => false)
  if (exists) {
    const head = await ctx.$`git -C ${outDir} rev-parse --abbrev-ref HEAD`.nothrow().quiet()
    if (head.exitCode !== 0) {
      throw new Error(`workbench: worktree dir exists but is not a git worktree: ${outDir}`)
    }
    const current = head.text().trim()
    if (current !== b) {
      throw new Error(`workbench: worktree dir exists but is on '${current}', expected '${b}': ${outDir}`)
    }
    return outDir
  }

  const ref = (from ?? "").trim()
  const check = await ctx.$`git -C ${root} show-ref --verify --quiet refs/heads/${b}`.nothrow().quiet()
  const cmd =
    check.exitCode === 0
      ? ctx.$`git -C ${root} worktree add ${outDir} ${b}`
      : ctx.$`git -C ${root} worktree add -b ${b} ${outDir} ${ref || "HEAD"}`
  const res = await cmd.nothrow()
  if (res.exitCode !== 0) {
    throw new Error(`workbench: failed to create worktree for ${b}: ${res.stderr.toString() || res.stdout.toString()}`)
  }
  return outDir
}

async function archive(ctx: any, src: string, dst: string, tmp: string) {
  await ensureDir(dst)
  await ensureDir(tmp)
  const tar = path.join(tmp, `archive-${Date.now()}-${randomBytes(4).toString("hex")}.tar`)
  const create = await ctx.$`git -C ${src} archive --format=tar -o ${tar} HEAD`.nothrow().quiet()
  if (create.exitCode !== 0) {
    throw new Error(`workbench: git archive failed: ${create.stderr.toString() || create.stdout.toString()}`)
  }
  const extract = await ctx.$`tar -xf ${tar} -C ${dst}`.nothrow().quiet()
  await rm(tar, { force: true }).catch(() => {})
  if (extract.exitCode !== 0) {
    throw new Error(`workbench: tar extract failed: ${extract.stderr.toString() || extract.stdout.toString()}`)
  }
}

function rule(args: any, meta?: Meta) {
  const mode = (args.copyExcludeMode ?? meta?.copy?.excludeMode ?? "append") as "append" | "replace"
  if (args.copyExclude !== undefined) {
    const list = uniq((Array.isArray(args.copyExclude) ? (args.copyExclude as unknown[]) : []).map((x: unknown) => String(x)))
    return {
      mode,
      exclude: mode === "replace" ? list : uniq([...DEFAULT_EXCLUDE, ...list]),
    }
  }
  if (meta?.copy?.exclude) {
    return {
      mode: (meta.copy.excludeMode ?? "append") as "append" | "replace",
      exclude: uniq(meta.copy.exclude.map((x) => String(x))),
    }
  }
  return {
    mode: "append" as const,
    exclude: uniq(DEFAULT_EXCLUDE),
  }
}

async function planFiles(ctx: any, src: string, dst: string, exclude: string[], input?: { delete?: boolean }) {
  const rsync = Bun.which("rsync")
  if (!rsync) throw new Error("workbench: preview requires rsync")

  const list = uniq([...exclude, ".git", META])
  const from = src.endsWith(path.sep) ? src : src + path.sep
  const to = dst.endsWith(path.sep) ? dst : dst + path.sep
  const args = ["-ani", ...(input?.delete ? ["--delete"] : []), ...list.flatMap((p) => ["--exclude", p]), from, to]
  const res = await ctx.$`${rsync} ${args}`.nothrow().quiet()
  if (res.exitCode !== 0) {
    throw new Error(`workbench: rsync preview failed: ${res.stderr.toString() || res.stdout.toString()}`)
  }
  return String(res.text())
    .split("\n")
    .map((x: string) => x.trimEnd())
    .filter(Boolean)
}

async function syncFiles(ctx: any, src: string, dst: string, tmp: string, exclude: string[], input?: { delete?: boolean }) {
  const list = uniq([...exclude, ".git", META])
  const rsync = Bun.which("rsync")
  if (rsync) {
    const from = src.endsWith(path.sep) ? src : src + path.sep
    const to = dst.endsWith(path.sep) ? dst : dst + path.sep
    const args = ["-a", ...(input?.delete ? ["--delete"] : []), ...list.flatMap((p) => ["--exclude", p]), from, to]
    const res = await ctx.$`${rsync} ${args}`.nothrow().quiet()
    if (res.exitCode !== 0) {
      throw new Error(`workbench: rsync failed: ${res.stderr.toString() || res.stdout.toString()}`)
    }
    return
  }

  if (input?.delete) {
    throw new Error("workbench: delete=true requires rsync")
  }

  await ensureDir(tmp)
  const tar = path.join(tmp, `sync-${Date.now()}-${randomBytes(4).toString("hex")}.tar`)
  const tarEx = list.flatMap((p) => ["--exclude", p, "--exclude", "./" + p, "--exclude", "*/" + p, "--exclude", "./*/" + p])
  const create = await ctx.$`tar -C ${src} ${tarEx} -cf ${tar} .`.nothrow().quiet()
  if (create.exitCode !== 0) {
    throw new Error(`workbench: tar pack failed: ${create.stderr.toString() || create.stdout.toString()}`)
  }
  const extract = await ctx.$`tar -C ${dst} -xf ${tar}`.nothrow().quiet()
  await rm(tar, { force: true }).catch(() => {})
  if (extract.exitCode !== 0) {
    throw new Error(`workbench: tar unpack failed: ${extract.stderr.toString() || extract.stdout.toString()}`)
  }
}

async function gitPorcelain(ctx: any, dir: string) {
  const res = await ctx.$`git -C ${dir} status --porcelain --untracked-files=all`.nothrow().quiet()
  if (res.exitCode !== 0) {
    throw new Error(`workbench: git status failed: ${res.stderr.toString() || res.stdout.toString()}`)
  }
  return String(res.text()).trim()
}

async function gitBranch(ctx: any, dir: string) {
  const res = await ctx.$`git -C ${dir} rev-parse --abbrev-ref HEAD`.nothrow().quiet()
  if (res.exitCode !== 0) return ""
  return String(res.text()).trim()
}

async function gitStage(ctx: any, dir: string, mode: "all" | "tracked") {
  const res =
    mode === "tracked" ? await ctx.$`git -C ${dir} add -u`.nothrow() : await ctx.$`git -C ${dir} add -A`.nothrow()
  if (res.exitCode !== 0) {
    throw new Error(`workbench: git add failed: ${res.stderr.toString() || res.stdout.toString()}`)
  }
}

async function gitStaged(ctx: any, dir: string) {
  const res = await ctx.$`git -C ${dir} diff --cached --name-only`.nothrow().quiet()
  if (res.exitCode !== 0) {
    throw new Error(`workbench: git diff --cached failed: ${res.stderr.toString() || res.stdout.toString()}`)
  }
  return String(res.text()).trim()
}

async function gitCommit(
  ctx: any,
  dir: string,
  title: string,
  input?: {
    body?: string
    noVerify?: boolean
    sign?: boolean
  },
) {
  const body = (input?.body ?? "").trim()
  const args = [
    "-C",
    dir,
    "commit",
    ...(input?.noVerify ? ["--no-verify"] : []),
    ...(input?.sign ? [] : ["--no-gpg-sign"]),
    "-m",
    title,
    ...(body ? ["-m", body] : []),
  ]
  const res = await ctx.$`git ${args}`.nothrow()
  if (res.exitCode !== 0) {
    const out = (res.stderr.toString() || res.stdout.toString()).trim()
    throw new Error(`workbench: git commit failed${out ? `: ${out}` : ""}`)
  }
}

async function gitPush(ctx: any, dir: string, remote: string, branch: string) {
  const res = await ctx.$`git -C ${dir} push -u ${remote} ${branch}`.nothrow()
  if (res.exitCode !== 0) {
    throw new Error(`workbench: git push failed: ${res.stderr.toString() || res.stdout.toString()}`)
  }
}

async function allSandboxes(base: string) {
  const out: Array<{ dir: string; meta: Meta }> = []
  const sandboxes = path.join(base, "sandboxes")
  const projs = await readdir(sandboxes, { withFileTypes: true }).catch(() => [])
  for (const p of projs) {
    if (!p.isDirectory()) continue
    const proj = path.join(sandboxes, p.name)
    const dirs = await readdir(proj, { withFileTypes: true }).catch(() => [])
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const dir = path.join(proj, d.name)
      const meta = await readMeta(dir).catch(() => null)
      if (!meta) continue
      out.push({ dir, meta })
    }
  }
  return out
}

function formatList(items: Array<{ dir: string; meta: Meta }>) {
  if (!items.length) return "workbench: no sandboxes"
  const lines: string[] = []
  for (const item of items.sort((a, b) => b.meta.time.created - a.meta.time.created)) {
    const pr = item.meta.github?.pr?.url
    const prid = pr ? pr.match(/\/pull\/(\d+)/)?.[1] : ""
    const commit = item.meta.publish?.commit ? item.meta.publish.commit.slice(0, 8) : ""
    lines.push(
      [
        item.meta.name,
        item.meta.branch ? `branch=${item.meta.branch}` : undefined,
        item.meta.copy?.mode ? `copy=${item.meta.copy.mode}` : undefined,
        item.meta.session?.id ? `session=${item.meta.session.id}` : undefined,
        prid ? `pr=${prid}` : undefined,
        commit ? `commit=${commit}` : undefined,
        `sandbox=${item.meta.sandbox.path}`,
        `source=${item.meta.source.worktree}`,
      ]
        .filter(Boolean)
        .join(" "),
    )
  }
  return lines.join("\n")
}

async function resolveSandbox(ctx: any, nameOrPath: string) {
  const input = (nameOrPath ?? "").trim()
  if (!input) throw new Error("workbench: sandbox is required")

  if (path.isAbsolute(input)) {
    const meta = await readMeta(input)
    if (!meta) throw new Error("workbench: sandbox metadata not found")
    return { dir: input, meta }
  }

  const r = await roots(ctx)
  const base = path.join(r.sandboxes, clean(ctx.project.id))
  const dir = path.join(base, clean(input))
  const meta = await readMeta(dir)
  if (meta) return { dir, meta }

  const items = await allSandboxes(r.base)
  const hit = items.find((x) => x.meta.name === input)
  if (hit) return hit
  throw new Error("workbench: sandbox not found")
}

export const WorkbenchPlugin: Plugin = async (ctx) => {
  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, any>) => {
    void Promise.resolve()
      .then(() =>
        ctx.client.app.log({
          query: { directory: ctx.directory },
          body: { service: "opencode-workbench", level, message, extra },
        }),
      )
      .catch(() => {})
  }

  return {
    tool: {
      workbench: tool({
        description: DESCRIPTION,
        args: {
          action: tool.schema.enum([
            "create",
            "open",
            "list",
            "info",
            "doctor",
            "preview",
            "sync",
            "publish",
            "checkpoint",
            "reset",
            "rename",
            "gc",
            "cleanup",
          ]),
          branch: tool.schema.string().optional().describe("git branch name (default: current branch)"),
          from: tool.schema.string().optional().describe("start point when creating a new branch worktree"),
          base: tool.schema
            .string()
            .optional()
            .describe("base branch name when creating a new branch (default: auto via upstream default branch when github=true)"),
          copyMode: tool.schema
            .enum(["archive", "worktree"])
            .optional()
            .describe("how to snapshot source into sandbox: archive=git archive (tracked+committed), worktree=filesystem copy (includes local edits/untracked)"),
          copyExclude: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("exclude patterns for copyMode=worktree and sync/publish (rsync-style basenames, e.g. node_modules)"),
          copyExcludeMode: tool.schema
            .enum(["append", "replace"])
            .optional()
            .describe("how copyExclude is applied: append=DEFAULT+copyExclude, replace=only copyExclude"),
          name: tool.schema.string().optional().describe("sandbox name (default: derived from branch + time)"),
          sandbox: tool.schema
            .string()
            .optional()
            .describe("sandbox name (as created) or absolute path to the sandbox directory"),
          renameTo: tool.schema.string().optional().describe("when action=rename, new sandbox name"),
          gcApply: tool.schema.boolean().optional().describe("when action=gc, actually delete (default: dry-run)"),
          gcDays: tool.schema
            .number()
            .optional()
            .describe("when action=gc, remove sandboxes older than N days"),
          gcKeepWithSession: tool.schema
            .boolean()
            .optional()
            .describe("when action=gc, keep sandboxes that have a recorded session id"),
          resetBackup: tool.schema
            .boolean()
            .optional()
            .describe("when action=reset, create a checkpoint backup first"),
          resetDelete: tool.schema
            .boolean()
            .optional()
            .describe("when action=reset, delete extra files in sandbox (mirror source)"),
          lockTimeout: tool.schema
            .number()
            .optional()
            .describe("lock TTL seconds for sync/publish/reset (0 disables stale breaking)"),
          force: tool.schema
            .boolean()
            .optional()
            .describe("force operation (break locks, rename with session, etc.)"),
          sourceWorktree: tool.schema
            .string()
            .optional()
            .describe("existing worktree directory to archive from (skip managed git worktree creation)"),
          targetWorktree: tool.schema
            .string()
            .optional()
            .describe("target directory to sync into (default: recorded source worktree)"),
          delete: tool.schema
            .boolean()
            .optional()
            .describe("when syncing, propagate deletions from sandbox to target (requires rsync)"),
          previewLines: tool.schema
            .number()
            .optional()
            .describe("when action=preview, max lines to show"),
          github: tool.schema
            .boolean()
            .optional()
            .describe("run GitHub fork/remote wiring via gh before creating sandbox"),
          ghHost: tool.schema.string().optional().describe("gh host (default: github.com)"),
          repo: tool.schema
            .string()
            .optional()
            .describe("upstream repo in OWNER/REPO form (default: inferred by gh from current dir)"),
          fork: tool.schema
            .string()
            .optional()
            .describe("fork repo in OWNER/REPO form (default: inferred; usually YOURLOGIN/REPO)"),
          forkRemote: tool.schema.string().optional().describe("git remote name for fork"),
          upstreamRemote: tool.schema.string().optional().describe("git remote name for upstream"),
          protocol: tool.schema
            .enum(["auto", "ssh", "https"])
            .optional()
            .describe("remote URL protocol used by gh wiring"),
          fetch: tool.schema
            .boolean()
            .optional()
            .describe("when github=true, fetch upstream/fork remotes to ensure refs exist"),
          push: tool.schema
            .boolean()
            .optional()
            .describe("push branch to fork remote after worktree creation"),
          pr: tool.schema
            .boolean()
            .optional()
            .describe("when github=true, create (or reuse) a PR on upstream for this branch"),
          draft: tool.schema
            .boolean()
            .optional()
            .describe("when pr=true, create PR as draft"),
          prBase: tool.schema
            .string()
            .optional()
            .describe("PR base branch (default: base/auto -> upstream default branch)"),
          prTitle: tool.schema.string().optional().describe("PR title (default: branch name)"),
          prBody: tool.schema.string().optional().describe("PR body (default: empty)"),
          prLabels: tool.schema.array(tool.schema.string()).optional().describe("PR labels to add"),
          prReviewers: tool.schema.array(tool.schema.string()).optional().describe("PR reviewers to request"),
          prAssignees: tool.schema.array(tool.schema.string()).optional().describe("PR assignees"),
          prProjects: tool.schema.array(tool.schema.string()).optional().describe("PR projects to add"),
          prMilestone: tool.schema.string().optional().describe("PR milestone name"),
          prNoMaintainerEdit: tool.schema
            .boolean()
            .optional()
            .describe("when pr=true, disable maintainer edits"),
          commit: tool.schema
            .boolean()
            .optional()
            .describe("when action=publish, create a commit (default: true)"),
          commitMessage: tool.schema.string().optional().describe("when action=publish, commit title"),
          commitBody: tool.schema.string().optional().describe("when action=publish, commit body"),
          commitBodyAuto: tool.schema
            .boolean()
            .optional()
            .describe("when action=publish and commitBody is empty, generate a file list body"),
          stage: tool.schema
            .enum(["all", "tracked"])
            .optional()
            .describe("when action=publish, stage changes: all=git add -A, tracked=git add -u"),
          noVerify: tool.schema.boolean().optional().describe("when action=publish, pass --no-verify to git commit"),
          sign: tool.schema
            .boolean()
            .optional()
            .describe("when action=publish, keep git commit signing enabled (default: false -> use --no-gpg-sign)"),
          allowDirty: tool.schema
            .boolean()
            .optional()
            .describe("when action=publish, allow non-clean target worktree before sync"),
          cleanupSandbox: tool.schema
            .boolean()
            .optional()
            .describe("when action=publish, remove the sandbox after successful publish"),
          title: tool.schema.string().optional().describe("title for the created session"),
          prompt: tool.schema.string().optional().describe("optional initial message to send to the created session"),
          removeWorktree: tool.schema
            .boolean()
            .optional()
            .describe("when action=cleanup, also remove the managed worktree directory"),
        },
        async execute(args, toolCtx) {
          const r = await roots(ctx)
          await ensureDir(r.sandboxes)
          await ensureDir(r.worktrees)
          await ensureDir(r.tmp)
          await ensureDir(r.locks)

          const conf0 = await loadConfig(getBase(ctx))
          const opt0 = { ...conf0.config, ...args } as any

          if (args.action === "list") {
            const items = await allSandboxes(r.base)
            return formatList(items)
          }

          if (args.action === "info") {
            const ref = await resolveSandbox(ctx, args.sandbox ?? "")
            const lines: string[] = []
            lines.push("workbench: info")
            lines.push(`- name: ${ref.meta.name}`)
            if (ref.meta.branch) lines.push(`- branch: ${ref.meta.branch}`)
            if (ref.meta.copy?.mode) lines.push(`- copy: ${ref.meta.copy.mode}`)
            lines.push(`- sandbox: ${ref.meta.sandbox.path}`)
            lines.push(`- source worktree: ${ref.meta.source.worktree}`)
            if (ref.meta.session?.id) {
              lines.push(`- session: ${ref.meta.session.id}`)
              lines.push(`Try: opencode run --session ${ref.meta.session.id} --dir ${JSON.stringify(ref.meta.sandbox.path)}`)
            } else {
              lines.push(`Try: workbench { action: "open", sandbox: ${JSON.stringify(ref.meta.name)} }`)
            }
            if (ref.meta.github?.upstream) {
              const gh = ref.meta.github
              lines.push(
                `- github: upstream=${gh.upstream}${gh.fork ? ` fork=${gh.fork}` : ""}${gh.base ? ` base=${gh.base}` : ""}${gh.defaultBranch ? ` default=${gh.defaultBranch}` : ""}`,
              )
              if (gh.pr?.url) lines.push(`- pr: ${gh.pr.url}`)
            }
            if (ref.meta.publish?.time) {
              lines.push(`- published: ${new Date(ref.meta.publish.time).toISOString()}`)
              if (ref.meta.publish.commit) lines.push(`- commit: ${ref.meta.publish.commit}`)
              if (ref.meta.publish.pushed) lines.push(`- pushed: ${ref.meta.publish.pushed.remote}/${ref.meta.publish.pushed.branch}`)
            }
            return lines.join("\n")
          }

          if (args.action === "doctor") {
            const lines: string[] = []
            lines.push("workbench: doctor")

            lines.push(`- config: ${conf0.path} (${conf0.status})`)

            const git = Bun.which("git")
            const gh = Bun.which("gh")
            const rsync = Bun.which("rsync")
            const tar = Bun.which("tar")
            lines.push(`- tools: git=${git ? "ok" : "missing"} gh=${gh ? "ok" : "missing"} rsync=${rsync ? "ok" : "missing"} tar=${tar ? "ok" : "missing"}`)

            const root = await ensureGit(ctx).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err)
              lines.push(`- git: ${msg}`)
              return ""
            })
            if (!root) return lines.join("\n")
            lines.push(`- repo: ${root}`)

            const b = await gitBranch(ctx, root).catch(() => "")
            if (b) lines.push(`- branch: ${b}`)

            const remotes = await ctx.$`git -C ${root} remote -v`.nothrow().quiet()
            if (remotes.exitCode === 0) {
              const text = String(remotes.text()).trim()
              if (text) lines.push(`- remotes:\n${text}`)
            }

            if (gh) {
              const host = (opt0.ghHost ?? "github.com").trim() || "github.com"
              const auth = await ctx.$.cwd(root)`gh auth status -h ${host}`.env({ GH_HOST: host }).nothrow().quiet()
              lines.push(`- gh auth (${host}): ${auth.exitCode === 0 ? "ok" : "missing"}`)
              const info = await ghRepoInfo(ctx, root, host, opt0.repo).catch(() => null)
              if (info?.nameWithOwner) lines.push(`- gh repo: ${info.nameWithOwner}${info.isFork ? " (fork)" : ""}`)
            }

            return lines.join("\n")
          }

          if (args.action === "preview") {
            const ref = await resolveSandbox(ctx, args.sandbox ?? "")
            const conf = await loadConfig(path.resolve(ref.meta.project.worktree))
            const opt = { ...conf.config, ...args } as any
            const dst = (args.targetWorktree ?? ref.meta.source.worktree).trim()
            if (!dst) throw new Error("workbench: targetWorktree is required")

            const expected = await gitCommon(ctx, ref.meta.project.worktree)
            const actual = await gitCommon(ctx, dst)
            if (expected !== actual) {
              throw new Error("workbench: targetWorktree belongs to a different git repository")
            }

            const delFlag = opt.delete === true
            const dirty = opt.allowDirty === true
            if (delFlag && !dirty) {
              const before = await gitPorcelain(ctx, dst)
              if (before) {
                throw new Error(
                  "workbench: targetWorktree is not clean; commit/stash changes before preview with delete=true (or set allowDirty=true)",
                )
              }
            }

            const copy = rule(opt, ref.meta)
            const plan = await planFiles(ctx, ref.meta.sandbox.path, dst, copy.exclude, { delete: delFlag })

            let add = 0
            let mod = 0
            let del = 0
            const shown: string[] = []
            for (const line of plan) {
              if (line.startsWith("*deleting")) {
                del++
                shown.push(line)
                continue
              }
              const m = line.match(/^(\S+)\s+(.*)$/)
              if (!m) {
                mod++
                shown.push(line)
                continue
              }
              const code = m[1]
              const name = m[2]
              if (code?.[1] === "d" || name === "./" || name.endsWith("/")) continue
              if (code.includes("+++++++++")) add++
              else mod++
              shown.push(line)
            }

            const limit = Math.max(0, Number(opt.previewLines ?? 200))
            const output = shown.slice(0, limit)

            return [
              `workbench: preview`,
              `- sandbox: ${ref.meta.sandbox.path}`,
              `- target: ${dst}`,
              `- delete: ${delFlag}`,
              `- changes: add=${add} modify=${mod} delete=${del}`,
              ...(output.length ? ["", ...output] : []),
              ...(shown.length > limit ? ["", `... truncated (${shown.length - limit} more lines)`] : []),
            ].join("\n")
          }

          if (args.action === "checkpoint") {
            const ref = await resolveSandbox(ctx, args.sandbox ?? "")
            const conf = await loadConfig(path.resolve(ref.meta.project.worktree))
            const opt = { ...conf.config, ...args } as any
            const r = await roots(ctx)
            if (!isInside(r.sandboxes, ref.dir)) {
              throw new Error("workbench: checkpoint only supports managed sandboxes")
            }

            const base = path.dirname(ref.dir)
            const name = clean(args.name ?? `${ref.meta.name}-checkpoint-${Math.floor(Date.now() / 1000)}`) || `checkpoint-${Date.now()}`
            const dst = path.join(base, name)
            const existing = await readdir(dst).catch(() => null)
            if (existing) throw new Error(`workbench: checkpoint destination exists: ${name}`)
            await ensureDir(dst)

            const copy = rule(opt, ref.meta)
            await syncFiles(ctx, ref.meta.sandbox.path, dst, r.tmp, copy.exclude)

            const id = randomBytes(8).toString("hex")
            await writeMeta(dst, {
              version: 1,
              id,
              name,
              branch: ref.meta.branch,
              copy: {
                mode: ref.meta.copy?.mode ?? "archive",
                excludeMode: copy.mode,
                exclude: copy.exclude,
              },
              github: ref.meta.github,
              project: ref.meta.project,
              source: ref.meta.source,
              sandbox: {
                path: dst,
              },
              time: {
                created: Date.now(),
                updated: Date.now(),
              },
            })

            return [
              `workbench: checkpoint created`,
              `- from: ${ref.meta.sandbox.path}`,
              `- to: ${dst}`,
              `- name: ${name}`,
            ].join("\n")
          }

          if (args.action === "reset") {
            const ref = await resolveSandbox(ctx, args.sandbox ?? "")
            const conf = await loadConfig(path.resolve(ref.meta.project.worktree))
            const opt = { ...conf.config, ...args } as any
            const src = path.resolve(args.sourceWorktree ?? ref.meta.source.worktree)
            const dst = ref.meta.sandbox.path

            const expected = await gitCommon(ctx, ref.meta.project.worktree)
            const actual = await gitCommon(ctx, src)
            if (expected !== actual) {
              throw new Error("workbench: sourceWorktree belongs to a different git repository")
            }

            const file = path.join(r.locks, clean(ref.meta.project.id), lockname(dst) + ".lock")
            return await withLock(
              file,
              {
                timeoutMs: Math.max(0, Number(opt.lockTimeout ?? 3600)) * 1000,
                force: args.force === true,
                info: { action: "reset", sandbox: ref.meta.name, path: dst },
              },
              async () => {
                const mode = (opt.copyMode ?? ref.meta.copy?.mode ?? "archive") as "archive" | "worktree"
                const copy = rule(opt, ref.meta)
                const backup = opt.resetBackup !== false
                const del = opt.resetDelete !== false
                if (backup) {
                  const base = path.dirname(ref.dir)
                  const name = clean(`${ref.meta.name}-backup-${Math.floor(Date.now() / 1000)}`) || `backup-${Date.now()}`
                  const backup = path.join(base, name)
                  await ensureDir(backup)
                  await syncFiles(ctx, dst, backup, r.tmp, copy.exclude)
                  await writeMeta(backup, {
                    ...ref.meta,
                    id: randomBytes(8).toString("hex"),
                    name,
                    sandbox: { path: backup },
                    session: undefined,
                    publish: undefined,
                    time: { created: Date.now(), updated: Date.now() },
                  })
                }

                if (mode === "worktree") {
                  await syncFiles(ctx, src, dst, r.tmp, copy.exclude, { delete: del })
                } else {
                  const tmp = path.join(r.tmp, `reset-${Date.now()}-${randomBytes(4).toString("hex")}`)
                  await rm(tmp, { recursive: true, force: true }).catch(() => {})
                  await ensureDir(tmp)
                  await archive(ctx, src, tmp, r.tmp)
                  await syncFiles(ctx, tmp, dst, r.tmp, copy.exclude, { delete: del })
                  await rm(tmp, { recursive: true, force: true }).catch(() => {})
                }

                await writeMeta(ref.dir, {
                  ...ref.meta,
                  copy: {
                    mode,
                    excludeMode: copy.mode,
                    exclude: copy.exclude,
                  },
                  time: ref.meta.time,
                })

                return [
                  `workbench: reset`,
                  `- sandbox: ${dst}`,
                  `- source: ${src}`,
                  `- mode: ${mode}`,
                  `- delete: ${del}`,
                  ...(backup ? [`- backup: created`] : []),
                ].join("\n")
              },
            )
          }

          if (args.action === "rename") {
            const ref = await resolveSandbox(ctx, args.sandbox ?? "")
            const to = clean(args.renameTo ?? "")
            if (!to) throw new Error("workbench: renameTo is required")
            if (ref.meta.session?.id && !args.force) {
              throw new Error("workbench: sandbox has a session; use force=true to rename")
            }

            const r = await roots(ctx)
            if (!isInside(r.sandboxes, ref.dir)) {
              throw new Error("workbench: rename only supports managed sandboxes")
            }

            const next = path.join(path.dirname(ref.dir), to)
            const exists = await readdir(next).catch(() => null)
            if (exists) throw new Error("workbench: rename target already exists")

            await rename(ref.dir, next)
            await writeMeta(next, {
              ...ref.meta,
              name: to,
              sandbox: {
                path: next,
              },
              time: ref.meta.time,
            })

            return [
              `workbench: renamed`,
              `- from: ${ref.dir}`,
              `- to: ${next}`,
              ...(ref.meta.session?.id ? [`Note: session directory is not updated; run with --dir ${JSON.stringify(next)}`] : []),
            ].join("\n")
          }

          if (args.action === "gc") {
            const keep = opt0.gcKeepWithSession !== false
            const days = Math.max(0, Number(opt0.gcDays ?? 30))
            const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
            const items = await allSandboxes(r.base)
            const candidates = await Promise.all(
              items.map(async (item) => {
                const exists = await Bun.file(item.meta.source.worktree).exists().catch(() => false)
                const missing = !exists
                const old = item.meta.time.updated < cutoff
                const hasSession = !!item.meta.session?.id
                if (keep && hasSession) return null
                if (!old && !missing) return null
                const reason = [old ? `age>${days}d` : "", missing ? "missing-source" : ""].filter(Boolean).join(",")
                return { ...item, reason }
              }),
            )
              .then((x) => x.filter((y): y is NonNullable<typeof y> => !!y))

            if (!(args.gcApply === true)) {
              return [
                `workbench: gc (dry-run)`,
                `- days: ${days}`,
                `- candidates: ${candidates.length}`,
                ...candidates.slice(0, 50).map((x) => `- ${x.meta.name} (${x.reason}) ${x.meta.sandbox.path}`),
                ...(candidates.length > 50 ? [`... truncated (${candidates.length - 50} more)`] : []),
              ].join("\n")
            }

            let removed = 0
            for (const item of candidates) {
              if (!isInside(r.sandboxes, item.dir)) continue
              await rm(item.dir, { recursive: true, force: true }).catch(() => {})
              removed++
            }

            return [
              `workbench: gc`,
              `- days: ${days}`,
              `- removed: ${removed}`,
            ].join("\n")
          }

          if (args.action === "create") {
            const root = await ensureGit(ctx)

            const opt = opt0
            const host = (opt.ghHost ?? "github.com").trim() || "github.com"
            const upstreamRemote = (opt.upstreamRemote ?? "upstream").trim() || "upstream"
            const forkRemote = (opt.forkRemote ?? "fork").trim() || "fork"
            const protocol = (opt.protocol ?? "auto") as "auto" | "ssh" | "https"
            const fetch = opt.fetch !== false
            const github = opt.github === true
            const wantPr = opt.pr === true
            const wantPush = opt.push === true

            if (github && upstreamRemote === forkRemote) {
              throw new Error("workbench: upstreamRemote and forkRemote must be different")
            }

            if (wantPr && !github) {
              throw new Error("workbench: pr=true requires github=true")
            }

            const gh = github
              ? await prepareGithub(
                  ctx,
                  root,
                  {
                    host,
                    repo: opt.repo,
                    fork: opt.fork,
                    protocol,
                    upstreamRemote,
                    forkRemote,
                    fetch,
                  },
                  log,
                )
              : null

            const b = (
                  args.branch ??
                  (args.sourceWorktree
                    ? await (async () => {
                    const src = path.resolve(args.sourceWorktree!)
                    const head = await ctx.$`git -C ${src} rev-parse --abbrev-ref HEAD`.nothrow().quiet()
                    const name = head.exitCode === 0 ? head.text().trim() : ""
                    if (name && name !== "HEAD") return name
                    return branch(ctx, root)
                  })()
                : await branch(ctx, root))
            ).trim()
            if (!b) throw new Error("workbench: branch is required")

            const base = (() => {
              const base = (opt.base ?? "auto").trim()
              if (!gh) return base
              if (!base || base === "auto") return gh.defaultBranch
              if (base.startsWith(gh.remotes.upstream + "/")) return base.slice(gh.remotes.upstream.length + 1)
              return base
            })()

            const proj = clean(ctx.project.id)
            const wname = `${key(b)}-${hash(b)}`
            const local = await gitHas(ctx, root, `refs/heads/${b}`)
            const from = await (async () => {
              if (args.from) return args.from
              if (!gh) {
                const base = (opt.base ?? "auto").trim()
                if (base && base !== "auto") return base
                return undefined
              }
              if (local) return undefined

              const forkRef = `refs/remotes/${gh.remotes.fork}/${b}`
              if (await gitHas(ctx, root, forkRef)) return `${gh.remotes.fork}/${b}`

              const upstreamRef = `refs/remotes/${gh.remotes.upstream}/${b}`
              if (await gitHas(ctx, root, upstreamRef)) return `${gh.remotes.upstream}/${b}`

              const base = (() => {
                const input = (opt.base ?? "auto").trim()
                if (!input || input === "auto") return gh.defaultBranch
                if (input.startsWith(gh.remotes.upstream + "/")) return input.slice(gh.remotes.upstream.length + 1)
                return input
              })()
              return `${gh.remotes.upstream}/${base}`
            })()
            const wdir = (args.sourceWorktree ?? "").trim()
              ? path.resolve(args.sourceWorktree!)
              : await makeWorktree(ctx, root, path.join(r.worktrees, proj, wname), b, from)

            const copy = rule(opt)
            const exclude = copy.exclude

            if (!local && from && gh && (from === `${gh.remotes.fork}/${b}` || from === `${gh.remotes.upstream}/${b}`)) {
              const res = await ctx.$`git -C ${wdir} branch --set-upstream-to=${from} ${b}`.nothrow().quiet()
              if (res.exitCode !== 0) {
                await log("warn", "failed to set upstream tracking", {
                  branch: b,
                  upstream: from,
                  stderr: res.stderr.toString(),
                })
              }
            }

            const name = clean(args.name ?? `${wname}-${Math.floor(Date.now() / 1000)}`) || `sandbox-${Date.now()}`
            const sdir = path.join(r.sandboxes, proj, name)
            const existing = await readdir(sdir).catch(() => null)
            if (existing && existing.length) {
              const hasMeta = await Bun.file(path.join(sdir, META)).exists().catch(() => false)
              if (hasMeta) throw new Error(`workbench: sandbox already exists: ${name}`)
              throw new Error(`workbench: sandbox directory is not empty: ${sdir}`)
            }
            await ensureDir(sdir)

            const mode = (opt.copyMode ?? "archive") as "archive" | "worktree"
            if (mode === "worktree") {
              await syncFiles(ctx, wdir, sdir, r.tmp, exclude)
            } else {
              await archive(ctx, wdir, sdir, r.tmp)
            }

            const needPush = Boolean(gh && (wantPush || wantPr))
            if (needPush && gh) {
              const res = await ctx.$`git -C ${wdir} push -u ${gh.remotes.fork} ${b}`.nothrow()
              if (res.exitCode !== 0) {
                throw new Error(`workbench: git push failed: ${res.stderr.toString() || res.stdout.toString()}`)
              }
            }

            const id = randomBytes(8).toString("hex")
            const meta: Meta = {
              version: 1,
              id,
              name,
              branch: b,
              copy: {
                mode,
                excludeMode: copy.mode,
                exclude,
              },
              github: gh
                ? {
                    host,
                    upstream: gh.upstream,
                    fork: gh.fork,
                    protocol: gh.protocol,
                    defaultBranch: gh.defaultBranch,
                    base,
                    remotes: gh.remotes,
                  }
                : undefined,
              project: {
                id: ctx.project.id,
                worktree: root,
              },
              source: {
                worktree: wdir,
              },
              sandbox: {
                path: sdir,
              },
              time: {
                created: Date.now(),
                updated: Date.now(),
              },
            }

            const title = (args.title ?? "").trim() || `WB: ${b}`
            const created = await ctx.client.session.create({
              query: { directory: sdir },
              body: {
                parentID: toolCtx.sessionID,
                title,
              },
            })
            const session = unwrap<any>(created)
            if (!session?.id) throw new Error("workbench: failed to create session")

            const next = await writeMeta(sdir, {
              ...meta,
              session: {
                id: session.id,
                parent: toolCtx.sessionID,
              },
            })

            const pr = await (async () => {
              if (!wantPr || !gh) return ""
              const upstream = gh.upstream
              const forkOwner = gh.fork.split("/")[0] ?? ""
              if (!forkOwner) throw new Error("workbench: failed to resolve fork owner")

              const base = (() => {
                const explicit = (opt.prBase ?? "auto").trim()
                if (explicit && explicit !== "auto") return explicit.startsWith(gh.remotes.upstream + "/") ? explicit.slice(gh.remotes.upstream.length + 1) : explicit
                const base = (opt.base ?? "auto").trim()
                if (base && base !== "auto") return base.startsWith(gh.remotes.upstream + "/") ? base.slice(gh.remotes.upstream.length + 1) : base
                return gh.defaultBranch
              })()

              const pr = {
                title: opt.prTitle,
                body: opt.prBody,
                labels: opt.prLabels ?? [],
                reviewers: opt.prReviewers ?? [],
                assignees: opt.prAssignees ?? [],
                projects: opt.prProjects ?? [],
                milestone: opt.prMilestone,
                noMaintainerEdit: opt.prNoMaintainerEdit === true,
              }

              const head = `${forkOwner}:${b}`
              const existing = await prUrl(ctx, root, host, upstream, head)
              if (existing) {
                const baseEdit = (() => {
                  const explicit = (opt.prBase ?? "auto").trim()
                  if (explicit && explicit !== "auto") return base
                  return undefined
                })()
                await prEdit(ctx, root, host, upstream, existing, {
                  base: baseEdit,
                  title: pr.title,
                  body: pr.body,
                  labels: pr.labels,
                  reviewers: pr.reviewers,
                  assignees: pr.assignees,
                  projects: pr.projects,
                  milestone: pr.milestone,
                }).catch(async (err) => {
                  await log("warn", "failed to edit existing PR", {
                    pr: existing,
                    error: err instanceof Error ? err.message : String(err),
                  })
                })
                return existing
              }

              const title = pr.title || b
              const body = pr.body ?? ""
              const url = await prCreate(ctx, root, host, upstream, {
                head,
                base,
                title,
                body,
                draft: opt.draft === true,
                labels: pr.labels,
                reviewers: pr.reviewers,
                assignees: pr.assignees,
                projects: pr.projects,
                milestone: pr.milestone,
                noMaintainerEdit: pr.noMaintainerEdit,
              })
              return url
            })().catch(async (err) => {
              await log("warn", "failed to create PR", {
                error: err instanceof Error ? err.message : String(err),
                branch: b,
              })
              return ""
            })

            if (pr && gh) {
              await writeMeta(sdir, {
                ...next,
                github: {
                  ...(next.github ?? {
                    host,
                    upstream: gh.upstream,
                    fork: gh.fork,
                    protocol: gh.protocol,
                    defaultBranch: gh.defaultBranch,
                    base,
                    remotes: gh.remotes,
                  }),
                  pr: {
                    url: pr,
                  },
                },
              })
            }

            if ((args.prompt ?? "").trim()) {
              await ctx.client.session.promptAsync({
                path: { id: session.id },
                query: { directory: sdir },
                body: {
                  parts: [{ type: "text", text: args.prompt!.trim() }],
                },
              })
            }

            await log("info", "sandbox created", {
              sessionID: next.session?.id,
              sandbox: sdir,
              source: wdir,
              branch: b,
            })

            return [
              `workbench: created`,
              `- branch: ${b}`,
              `- source worktree: ${wdir}`,
              `- sandbox: ${sdir}`,
              `- session: ${session.id}`,
              ...(pr ? [`- pr: ${pr}`] : []),
              `Try: opencode run --session ${session.id} --dir ${JSON.stringify(sdir)}`,
            ].join("\n")
          }

          if (args.action === "open") {
            const ref = await resolveSandbox(ctx, args.sandbox ?? "")
            if (ref.meta.session?.id) return `workbench: already opened session=${ref.meta.session.id}`

            const title = (args.title ?? "").trim() || `WB: ${ref.meta.branch ?? ref.meta.name}`
            const created = await ctx.client.session.create({
              query: { directory: ref.meta.sandbox.path },
              body: {
                parentID: toolCtx.sessionID,
                title,
              },
            })
            const session = unwrap<any>(created)
            if (!session?.id) throw new Error("workbench: failed to create session")

            await writeMeta(ref.dir, {
              ...ref.meta,
              session: {
                id: session.id,
                parent: toolCtx.sessionID,
              },
            })
            return [
              `workbench: opened`,
              `- sandbox: ${ref.meta.sandbox.path}`,
              `- session: ${session.id}`,
              `Try: opencode run --session ${session.id} --dir ${JSON.stringify(ref.meta.sandbox.path)}`,
            ].join("\n")
          }

          if (args.action === "sync") {
            const ref = await resolveSandbox(ctx, args.sandbox ?? "")
            const conf = await loadConfig(path.resolve(ref.meta.project.worktree))
            const opt = { ...conf.config, ...args } as any
            const dst = (args.targetWorktree ?? ref.meta.source.worktree).trim()
            if (!dst) throw new Error("workbench: targetWorktree is required")

            const expected = await gitCommon(ctx, ref.meta.project.worktree)
            const actual = await gitCommon(ctx, dst)
            if (expected !== actual) {
              throw new Error("workbench: targetWorktree belongs to a different git repository")
            }

            const del = opt.delete === true
            const dirty = opt.allowDirty === true

            const file = path.join(r.locks, clean(ref.meta.project.id), lockname(dst) + ".lock")
            return await withLock(
              file,
              {
                timeoutMs: Math.max(0, Number(opt.lockTimeout ?? 3600)) * 1000,
                force: args.force === true,
                info: { action: "sync", sandbox: ref.meta.name, target: dst, delete: del },
              },
              async () => {
                if (del && !dirty) {
                  const before = await gitPorcelain(ctx, dst)
                  if (before) {
                    throw new Error(
                      "workbench: targetWorktree is not clean; commit/stash changes before sync with delete=true (or set allowDirty=true)",
                    )
                  }
                }

                const copy = rule(opt, ref.meta)
                await syncFiles(ctx, ref.meta.sandbox.path, dst, r.tmp, copy.exclude, { delete: del })
                await writeMeta(ref.dir, {
                  ...ref.meta,
                  time: ref.meta.time,
                })
                await log("info", "sandbox synced", {
                  sandbox: ref.meta.sandbox.path,
                  target: dst,
                  name: ref.meta.name,
                })
                return [
                  `workbench: synced`,
                  `- sandbox: ${ref.meta.sandbox.path}`,
                  `- target: ${dst}`,
                  `- delete: ${del}`,
                  `Note: use git to review changes in target.`,
                ].join("\n")
              },
            )
          }

          if (args.action === "publish") {
            const ref = await resolveSandbox(ctx, args.sandbox ?? "")
            const conf = await loadConfig(path.resolve(ref.meta.project.worktree))
            const opt = { ...conf.config, ...args } as any
            const dst = (args.targetWorktree ?? ref.meta.source.worktree).trim()
            if (!dst) throw new Error("workbench: targetWorktree is required")

            const expected = await gitCommon(ctx, ref.meta.project.worktree)
            const actual = await gitCommon(ctx, dst)
            if (expected !== actual) {
              throw new Error("workbench: targetWorktree belongs to a different git repository")
            }

            const current = await gitBranch(ctx, dst)
            if (!current || current === "HEAD") {
              throw new Error("workbench: targetWorktree is not on a branch")
            }
            if (ref.meta.branch && current !== ref.meta.branch) {
              throw new Error(`workbench: targetWorktree is on '${current}', expected '${ref.meta.branch}'`)
            }
            const b = (ref.meta.branch ?? current).trim()
            if (!b) throw new Error("workbench: branch not resolved")

            const host = (ref.meta.github?.host ?? opt.ghHost ?? "github.com").trim() || "github.com"
            const del = opt.delete === true
            const dirty = opt.allowDirty === true

            const file = path.join(r.locks, clean(ref.meta.project.id), lockname(dst) + ".lock")
            return await withLock(
              file,
              {
                timeoutMs: Math.max(0, Number(opt.lockTimeout ?? 3600)) * 1000,
                force: args.force === true,
                info: { action: "publish", sandbox: ref.meta.name, target: dst, branch: b, delete: del },
              },
              async () => {
                if (!dirty) {
                  const before = await gitPorcelain(ctx, dst)
                  if (before) {
                    throw new Error(
                      "workbench: targetWorktree is not clean; commit/stash changes before publish (or set allowDirty=true)",
                    )
                  }
                }

                const copy = rule(opt, ref.meta)
                await syncFiles(ctx, ref.meta.sandbox.path, dst, r.tmp, copy.exclude, { delete: del })

                const after = await gitPorcelain(ctx, dst)
                if (!after) {
                  await writeMeta(ref.dir, { ...ref.meta, time: ref.meta.time })
                  return [
                    `workbench: publish (no changes)`,
                    `- branch: ${b}`,
                    `- sandbox: ${ref.meta.sandbox.path}`,
                    `- target: ${dst}`,
                  ].join("\n")
                }

                const wantCommit = opt.commit !== false
                if (!wantCommit) {
                  await writeMeta(ref.dir, { ...ref.meta, time: ref.meta.time })
                  return [
                    `workbench: publish (synced, not committed)`,
                    `- branch: ${b}`,
                    `- sandbox: ${ref.meta.sandbox.path}`,
                    `- target: ${dst}`,
                    `- status:`,
                    after,
                  ].join("\n")
                }

                await gitStage(ctx, dst, (opt.stage ?? "all") as "all" | "tracked")
                const staged = await gitStaged(ctx, dst)
                if (!staged) {
                  await writeMeta(ref.dir, { ...ref.meta, time: ref.meta.time })
                  return [
                    `workbench: publish (no staged changes)`,
                    `- branch: ${b}`,
                    `- sandbox: ${ref.meta.sandbox.path}`,
                    `- target: ${dst}`,
                  ].join("\n")
                }

                const files = staged
                  .split("\n")
                  .map((x) => x.trim())
                  .filter(Boolean)
                const title = (opt.commitMessage ?? "").trim() || `workbench: publish ${b} (${files.length} files)`
                const body =
                  (opt.commitBody ?? "").trim() ||
                  (!opt.commitBodyAuto
                    ? ""
                    : [
                        `Sandbox: ${ref.meta.name}`,
                        ...(ref.meta.session?.id ? [`Session: ${ref.meta.session.id}`] : []),
                        "",
                        "Files:",
                        ...files.slice(0, 30).map((x) => `- ${x}`),
                        ...(files.length > 30 ? [`- ...and ${files.length - 30} more`] : []),
                      ].join("\n"))
                await gitCommit(ctx, dst, title, {
                  body,
                  noVerify: opt.noVerify === true,
                  sign: opt.sign === true,
                })

                const head = await ctx.$`git -C ${dst} rev-parse HEAD`.nothrow().quiet()
                const sha = head.exitCode === 0 ? head.text().trim() : ""

                const ghWanted = Boolean(opt.github || ref.meta.github)
                const wantPush = opt.push === undefined ? ghWanted : opt.push === true
                const wantPr = opt.pr === undefined ? ghWanted : opt.pr === true

                const protocol = (opt.protocol ?? "auto") as "auto" | "ssh" | "https"
                const fetch = opt.fetch !== false
                const upstreamRemote = (ref.meta.github?.remotes?.upstream ?? opt.upstreamRemote ?? "upstream").trim() || "upstream"
                const forkRemote = (ref.meta.github?.remotes?.fork ?? opt.forkRemote ?? "fork").trim() || "fork"

                const gh = wantPush || wantPr ? (
                  await prepareGithub(
                    ctx,
                    ref.meta.project.worktree,
                    {
                      host,
                      repo: opt.repo ?? ref.meta.github?.upstream,
                      fork: opt.fork ?? ref.meta.github?.fork,
                      protocol,
                      upstreamRemote,
                      forkRemote,
                      fetch,
                    },
                    log,
                  )
                ) : null

                if (wantPush && gh) {
                  await gitPush(ctx, dst, gh.remotes.fork, b)
                }

                const pr = await (async () => {
                  if (!wantPr || !gh) return ""
                  const upstream = gh.upstream
                  const forkOwner = gh.fork.split("/")[0] ?? ""
                  if (!forkOwner) throw new Error("workbench: failed to resolve fork owner")

                  const base = (() => {
                    const explicit = (opt.prBase ?? "auto").trim()
                    if (explicit && explicit !== "auto")
                      return explicit.startsWith(gh.remotes.upstream + "/")
                        ? explicit.slice(gh.remotes.upstream.length + 1)
                        : explicit
                    const base = (opt.base ?? "auto").trim()
                    if (base && base !== "auto")
                      return base.startsWith(gh.remotes.upstream + "/") ? base.slice(gh.remotes.upstream.length + 1) : base
                    return gh.defaultBranch
                  })()

                  const prMeta = {
                    title: opt.prTitle,
                    body: opt.prBody,
                    labels: opt.prLabels ?? [],
                    reviewers: opt.prReviewers ?? [],
                    assignees: opt.prAssignees ?? [],
                    projects: opt.prProjects ?? [],
                    milestone: opt.prMilestone,
                    noMaintainerEdit: opt.prNoMaintainerEdit === true,
                  }

                  const head = `${forkOwner}:${b}`
                  const existing = await prUrl(ctx, ref.meta.project.worktree, host, upstream, head)
                  if (existing) {
                    await prEdit(ctx, ref.meta.project.worktree, host, upstream, existing, {
                      title: prMeta.title,
                      body: prMeta.body,
                      labels: prMeta.labels,
                      reviewers: prMeta.reviewers,
                      assignees: prMeta.assignees,
                      projects: prMeta.projects,
                      milestone: prMeta.milestone,
                    }).catch(async (err) => {
                      await log("warn", "failed to edit existing PR", {
                        pr: existing,
                        error: err instanceof Error ? err.message : String(err),
                      })
                    })
                    return existing
                  }

                  const title = prMeta.title || b
                  const body = prMeta.body ?? ""
                  return prCreate(ctx, ref.meta.project.worktree, host, upstream, {
                    head,
                    base,
                    title,
                    body,
                    draft: opt.draft === true,
                    labels: prMeta.labels,
                    reviewers: prMeta.reviewers,
                    assignees: prMeta.assignees,
                    projects: prMeta.projects,
                    milestone: prMeta.milestone,
                    noMaintainerEdit: prMeta.noMaintainerEdit,
                  })
                })().catch(async (err) => {
                  await log("warn", "failed to create PR", {
                    error: err instanceof Error ? err.message : String(err),
                    branch: b,
                  })
                  return ""
                })

                const next = await writeMeta(ref.dir, {
                  ...ref.meta,
                  github: gh
                    ? {
                        ...(ref.meta.github ?? {
                          host,
                          upstream: gh.upstream,
                          fork: gh.fork,
                          protocol: gh.protocol,
                          defaultBranch: gh.defaultBranch,
                          remotes: gh.remotes,
                        }),
                        ...(pr ? { pr: { url: pr } } : {}),
                      }
                    : ref.meta.github,
                  publish: {
                    time: Date.now(),
                    commit: sha || undefined,
                    pushed: wantPush && gh ? { remote: gh.remotes.fork, branch: b } : undefined,
                  },
                  time: ref.meta.time,
                })

                if (opt.cleanupSandbox === true) {
                  await rm(next.sandbox.path, { recursive: true, force: true })
                }

                return [
                  `workbench: published`,
                  `- branch: ${b}`,
                  `- sandbox: ${ref.meta.sandbox.path}`,
                  `- target: ${dst}`,
                  ...(wantPush && gh ? [`- pushed: ${gh.remotes.fork}/${b}`] : []),
                  ...(pr ? [`- pr: ${pr}`] : []),
                  ...(sha ? [`- commit: ${sha}`] : []),
                ].join("\n")
              },
            )
          }

          if (args.action === "cleanup") {
            const ref = await resolveSandbox(ctx, args.sandbox ?? "")
            const managed = path.join(r.worktrees, clean(ref.meta.project.id))
            const rmWorktree = args.removeWorktree === true
            if (rmWorktree && ref.meta.source.worktree && isInside(managed, ref.meta.source.worktree)) {
              const root = ref.meta.project.worktree
              const res = await ctx.$`git -C ${root} worktree remove --force ${ref.meta.source.worktree}`.nothrow().quiet()
              if (res.exitCode !== 0) {
                await log("warn", "git worktree remove failed, falling back to rm", {
                  stderr: res.stderr.toString(),
                  stdout: res.stdout.toString(),
                })
                await rm(ref.meta.source.worktree, { recursive: true, force: true }).catch(() => {})
              }
            }

            await rm(ref.meta.sandbox.path, { recursive: true, force: true })
            await log("info", "sandbox cleaned", { sandbox: ref.meta.sandbox.path, name: ref.meta.name })
            return `workbench: cleaned sandbox=${ref.meta.sandbox.path}`
          }

          throw new Error("workbench: unsupported action")
        },
      }),
    },
  }
}

export default WorkbenchPlugin
