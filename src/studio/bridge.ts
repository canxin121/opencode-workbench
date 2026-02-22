import os from "node:os"
import path from "node:path"
import { readdir, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"

const META = ".opencode-workbench.json"
const CONFIG_FILE = "workbench.toml"

type JsonPrimitive = string | number | boolean | null
type JsonObject = { [k: string]: JsonValue }
type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

type BridgeRequest = {
  action: string
  payload?: unknown
  context?: unknown
  plugin?: unknown
}

type BridgeSuccess = {
  ok: true
  data: JsonValue
}

type BridgeFailure = {
  ok: false
  error: {
    code: string
    message: string
    details: JsonValue | null
  }
}

type BridgeResponse = BridgeSuccess | BridgeFailure

type BridgeContext = {
  sessionId: string
  cwd?: string
}

type Meta = {
  version: 1
  id: string
  name: string
  branch?: string
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
  github?: {
    pr?: { url: string }
  }
  publish?: {
    time: number
    commit?: string
  }
  time: {
    created: number
    updated: number
  }
}

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
  prLabels?: string[]
  stage?: "all" | "tracked"
  commitBodyAuto?: boolean
  allowDirty?: boolean
  delete?: boolean
  lockTimeout?: number
}

type LoadedConfig = {
  path: string
  status: "missing" | "loaded" | "invalid"
  config: Config
  mtimeMs: number
}

type SandboxRow = {
  name: string
  dir: string
  branch?: string
  projectId: string
  projectWorktree: string
  sourceWorktree: string
  sessionId?: string
  prUrl?: string
  publishCommit?: string
  updatedAt: number
  createdAt: number
}

const DEFAULT_SESSION_ID = "studio"

async function main() {
  const response = await runBridge()
  process.stdout.write(JSON.stringify(response))
}

async function runBridge(): Promise<BridgeResponse> {
  try {
    const raw = await readStdinOnce()
    const request = parseRequest(raw)
    const context = resolveContext(request)
    const data = await dispatch(request.action, request.payload, context)
    return ok(data)
  } catch (error) {
    return fail(error)
  }
}

function parseRequest(raw: string): BridgeRequest {
  if (!raw.trim()) throw new Error("bridge request is empty")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`bridge request is not valid JSON: ${message}`)
  }
  const obj = asObject(parsed, "bridge request")
  const action = expectString(obj.action, "action")
  return {
    action,
    payload: obj.payload,
    context: obj.context,
    plugin: obj.plugin,
  }
}

function resolveContext(request: BridgeRequest): BridgeContext {
  const ctx = asObjectOptional(request.context)
  const plugin = asObjectOptional(request.plugin)
  const sessionId =
    readNonEmptyString(ctx?.sessionId) ?? readNonEmptyString(ctx?.sessionID) ?? DEFAULT_SESSION_ID
  const cwd =
    readNonEmptyString(ctx?.cwd) ??
    readNonEmptyString(ctx?.directory) ??
    readNonEmptyString(plugin?.rootPath) ??
    undefined
  return { sessionId, cwd }
}

async function dispatch(action: string, payload: unknown, context: BridgeContext): Promise<JsonValue> {
  if (action === "config.get") {
    return (await loadConfig(await resolveProjectRoot(context.cwd))) as unknown as JsonValue
  }
  if (action === "config.set") {
    const root = asObject(payload, "config.set payload")
    const raw = "config" in root ? (root.config as unknown) : payload
    const project = await resolveProjectRoot(context.cwd)
    const next = normalizeConfig(raw)
    const saved = await saveConfig(project, next)
    return saved as unknown as JsonValue
  }
  if (action === "workbench.snapshot") {
    return (await snapshot(context)) as unknown as JsonValue
  }
  if (action === "events.poll") {
    return (await eventsPoll(payload, context)) as unknown as JsonValue
  }
  throw new Error(`unknown action: ${action}`)
}

async function snapshot(context: BridgeContext) {
  const projectRoot = await resolveProjectRoot(context.cwd)
  const config = await loadConfig(projectRoot)
  const base = resolveWorkbenchBase()
  const sandboxes = await listSandboxes(base)
  const filtered = projectRoot
    ? sandboxes.filter((s) => path.resolve(s.projectWorktree) === path.resolve(projectRoot))
    : sandboxes

  const deps = {
    git: checkCmd("git"),
    gh: checkCmd("gh"),
    rsync: checkCmd("rsync"),
    tar: checkCmd("tar"),
  }

  const cursor = buildCursor(config, sandboxes)

  return {
    sessionId: context.sessionId,
    cwd: context.cwd ?? "",
    projectRoot,
    base,
    paths: {
      sandboxes: path.join(base, "sandboxes"),
      worktrees: path.join(base, "worktrees"),
      tmp: path.join(base, "tmp"),
      locks: path.join(base, "locks"),
    },
    config,
    deps,
    sandboxes: filtered,
    sandboxesAllCount: sandboxes.length,
    cursor,
    time: Date.now(),
  }
}

async function eventsPoll(payload: unknown, context: BridgeContext) {
  const input = asObjectOptional(payload)
  const prev = readNonEmptyString(input?.cursor) ?? ""
  const snap = await snapshot(context)
  if (prev === snap.cursor) {
    return { cursor: snap.cursor, events: [] }
  }
  return {
    cursor: snap.cursor,
    events: [
      {
        event: "workbench.runtime.changed",
        id: snap.cursor,
        data: snap,
      },
    ],
  }
}

function resolveWorkbenchBase(): string {
  const state = process.env.XDG_STATE_HOME?.trim()
    ? process.env.XDG_STATE_HOME!.trim()
    : path.join(os.homedir(), ".local", "state")
  return path.join(state, "opencode", "workbench")
}

async function resolveProjectRoot(cwd?: string): Promise<string> {
  const dir = (cwd ?? "").trim()
  if (!dir) return ""
  const sandbox = findSandboxRoot(dir)
  if (sandbox) {
    const meta = await readMeta(sandbox)
    const root = meta?.project?.worktree
    if (root && root.trim()) return path.resolve(root.trim())
  }
  const gitRoot = findGitRoot(dir)
  return gitRoot ? path.resolve(gitRoot) : path.resolve(dir)
}

function findGitRoot(start: string): string {
  let dir = path.resolve(start)
  for (;;) {
    const probe = path.join(dir, ".git")
    try {
      // git worktrees often have .git as a file; exists() is enough.
      if (existsSync(probe)) return dir
    } catch {}
    const next = path.dirname(dir)
    if (next === dir) return ""
    dir = next
  }
}

function findSandboxRoot(start: string): string {
  let dir = path.resolve(start)
  for (;;) {
    const meta = path.join(dir, META)
    try {
      if (existsSync(meta)) return dir
    } catch {}
    const next = path.dirname(dir)
    if (next === dir) return ""
    dir = next
  }
}

async function readMeta(dir: string): Promise<Meta | null> {
  const file = Bun.file(path.join(dir, META))
  if (!(await file.exists())) return null
  const raw = await file.text().catch(() => "")
  if (!raw.trim()) return null
  try {
    const data = JSON.parse(raw) as Meta
    if (!data || typeof data !== "object") return null
    if (data.version !== 1) return null
    if (!data.sandbox?.path) return null
    return data
  } catch {
    return null
  }
}

async function listSandboxes(base: string): Promise<SandboxRow[]> {
  const root = path.join(base, "sandboxes")
  const projs = await readdir(root, { withFileTypes: true }).catch(() => [])
  const out: SandboxRow[] = []
  for (const p of projs) {
    if (!p.isDirectory()) continue
    const proj = path.join(root, p.name)
    const dirs = await readdir(proj, { withFileTypes: true }).catch(() => [])
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const dir = path.join(proj, d.name)
      const meta = await readMeta(dir)
      if (!meta) continue
      out.push({
        name: meta.name,
        dir,
        branch: meta.branch,
        projectId: meta.project.id,
        projectWorktree: meta.project.worktree,
        sourceWorktree: meta.source.worktree,
        sessionId: meta.session?.id,
        prUrl: meta.github?.pr?.url,
        publishCommit: meta.publish?.commit,
        updatedAt: meta.time.updated,
        createdAt: meta.time.created,
      })
    }
  }
  return out.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
}

function buildCursor(config: LoadedConfig, sandboxes: SandboxRow[]): string {
  const latestSandbox = sandboxes.reduce((acc, s) => Math.max(acc, s.updatedAt || s.createdAt || 0), 0)
  const count = sandboxes.length
  const cfg = config.mtimeMs
  return [cfg, latestSandbox, count].join(":")
}

function checkCmd(cmd: string): { ok: boolean; version: string } {
  try {
    const res = Bun.spawnSync({ cmd: [cmd, "--version"], stdout: "pipe", stderr: "pipe" })
    const ok = res.exitCode === 0
    const text = Buffer.from(ok ? res.stdout : res.stderr).toString("utf8").trim()
    return { ok, version: text.split("\n")[0] ?? "" }
  } catch {
    return { ok: false, version: "" }
  }
}

async function loadConfig(projectRoot: string): Promise<LoadedConfig> {
  const file = path.join(projectRoot || process.cwd(), ".opencode", CONFIG_FILE)
  const src = Bun.file(file)
  if (!(await src.exists())) {
    return { path: file, status: "missing", config: {}, mtimeMs: 0 }
  }
  const raw = await src.text().catch(() => "")
  const stat = await src.stat().catch(() => null)
  const mtimeMs = stat?.mtime?.getTime?.() ? stat.mtime.getTime() : 0
  if (!raw.trim()) return { path: file, status: "invalid", config: {}, mtimeMs }

  const obj = (() => {
    try {
      const parsed = Bun.TOML.parse(raw)
      if (!parsed || typeof parsed !== "object") return null
      return parsed as Record<string, unknown>
    } catch {
      return null
    }
  })()
  if (!obj) return { path: file, status: "invalid", config: {}, mtimeMs }

  const data = (() => {
    const scoped = (obj as any).workbench
    if (scoped && typeof scoped === "object") return scoped as Record<string, unknown>
    return obj
  })()

  return { path: file, status: "loaded", config: normalizeConfig(data), mtimeMs }
}

function normalizeConfig(raw: unknown): Config {
  const data = asObjectOptional(raw) ?? {}
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

  return {
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
    prLabels: list(data.prLabels),
    stage: one(data.stage, ["all", "tracked"]),
    commitBodyAuto: bool(data.commitBodyAuto),
    allowDirty: bool(data.allowDirty),
    delete: bool(data.delete),
    lockTimeout: num(data.lockTimeout),
  }
}

async function saveConfig(projectRoot: string, config: Config) {
  const base = projectRoot || process.cwd()
  const file = path.join(base, ".opencode", CONFIG_FILE)
  await mkdir(path.dirname(file), { recursive: true })

  const src = Bun.file(file)
  const raw = (await src.exists()) ? await src.text().catch(() => "") : ""
  const next = patchWorkbenchSection(raw, config)
  await Bun.write(file, next)
  const loaded = await loadConfig(base)
  return { path: file, config: loaded.config, status: loaded.status }
}

function patchWorkbenchSection(raw: string, config: Config): string {
  const lines = String(raw || "").replace(/\r\n/g, "\n").split("\n")
  const section = renderWorkbenchSection(config)
  if (!section.trim()) {
    return raw.trimEnd() ? raw.trimEnd() + "\n" : ""
  }

  const start = lines.findIndex((l) => l.trim() === "[workbench]")
  if (start === -1) {
    const head = raw.trimEnd()
    return `${head ? head + "\n\n" : ""}${section.trimEnd()}\n`
  }

  let end = start + 1
  for (; end < lines.length; end++) {
    const t = lines[end].trim()
    if (t.startsWith("[") && t.endsWith("]")) break
  }
  const before = lines.slice(0, start)
  const after = lines.slice(end)
  const merged = [...before, ...section.trimEnd().split("\n"), ...after]
  return merged.join("\n").trimEnd() + "\n"
}

function renderWorkbenchSection(config: Config): string {
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && !v.length) continue
    cleaned[k] = v
  }
  const keys = Object.keys(cleaned)
  if (!keys.length) return ""

  const lines: string[] = ["[workbench]"]
  const serialize = (value: unknown): string => {
    if (typeof value === "string") return JSON.stringify(value)
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    if (Array.isArray(value)) return `[${value.map((x) => serialize(x)).join(", ")}]`
    return ""
  }

  for (const key of keys.sort()) {
    const value = cleaned[key]
    const encoded = serialize(value)
    if (!encoded) continue
    lines.push(`${key} = ${encoded}`)
  }
  lines.push("")
  return lines.join("\n")
}

function ok(data: JsonValue): BridgeSuccess {
  return { ok: true, data }
}

function fail(error: unknown): BridgeFailure {
  const message = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: {
      code: "bridge_error",
      message,
      details: null,
    },
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function asObjectOptional(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function expectString(value: unknown, label: string): string {
  const parsed = readNonEmptyString(value)
  if (!parsed) throw new Error(`${label} is required`)
  return parsed
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

async function readStdinOnce(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString("utf8")
}

void main()
