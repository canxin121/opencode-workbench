import os from "node:os"
import path from "node:path"
import { readdir } from "node:fs/promises"

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
  parentSessionId?: string
  childSessionId?: string
  cwd?: string
}

type Scope = "session" | "repo" | "all"
type ToolingMode = "git+gh" | "git-only" | "no-git"

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

type BindingRow = {
  name: string
  dir: string
  branch?: string
  repoCommonDir?: string
  sessionId?: string
  parentSessionId?: string
  upstream?: string
  fork?: string
  prUrl?: string
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
  const parentSessionId =
    readNonEmptyString(ctx?.parentSessionId) ?? readNonEmptyString(ctx?.parentSessionID) ?? sessionId
  const childSessionId = readNonEmptyString(ctx?.childSessionId) ?? readNonEmptyString(ctx?.childSessionID) ?? undefined
  const cwd =
    readNonEmptyString(ctx?.cwd) ??
    readNonEmptyString(ctx?.directory) ??
    readNonEmptyString(plugin?.rootPath) ??
    undefined
  return { sessionId, parentSessionId, childSessionId, cwd }
}

async function dispatch(action: string, payload: unknown, context: BridgeContext): Promise<JsonValue> {
  if (action === "workbench.snapshot") {
    return (await snapshot(payload, context)) as unknown as JsonValue
  }
  if (action === "events.poll") {
    return (await eventsPoll(payload, context)) as unknown as JsonValue
  }
  throw new Error(`unknown action: ${action}`)
}

function resolveWorkbenchBase(): string {
  const state = process.env.XDG_STATE_HOME?.trim()
    ? process.env.XDG_STATE_HOME!.trim()
    : path.join(os.homedir(), ".local", "state")
  return path.join(state, "opencode", "workbench")
}

function runCmd(cmd: string[], cwd?: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    const res = Bun.spawnSync({
      cmd,
      cwd: cwd || undefined,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = Buffer.from(res.stdout).toString("utf8")
    const stderr = Buffer.from(res.stderr).toString("utf8")
    return { exitCode: res.exitCode ?? 1, stdout, stderr }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { exitCode: 1, stdout: "", stderr: message }
  }
}

function checkCmd(cmd: string): { ok: boolean; version: string } {
  const res = runCmd([cmd, "--version"])
  const ok = res.exitCode === 0
  const text = String(ok ? res.stdout : res.stderr).trim()
  return { ok, version: text.split("\n")[0] ?? "" }
}

function toolingModeFromDeps(deps: { git: { ok: boolean }; gh: { ok: boolean } }): ToolingMode {
  if (!deps.git.ok) return "no-git"
  if (deps.gh.ok) return "git+gh"
  return "git-only"
}

function gitShowTopLevel(cwd: string): string {
  const res = runCmd(["git", "-C", cwd, "rev-parse", "--show-toplevel"])
  if (res.exitCode !== 0) return ""
  return res.stdout.trim()
}

function gitCommonDir(cwd: string): string {
  const res = runCmd(["git", "-C", cwd, "rev-parse", "--git-common-dir"])
  if (res.exitCode !== 0) return ""
  const out = res.stdout.trim()
  if (!out) return ""
  return path.resolve(cwd, out)
}

function readScope(payload: unknown): Scope {
  const obj = asObjectOptional(payload)
  const raw = readNonEmptyString(obj?.scope)
  if (raw === "all" || raw === "repo" || raw === "session") return raw
  return "session"
}

function readSession(payload: unknown): string {
  const obj = asObjectOptional(payload)
  return readNonEmptyString(obj?.sessionId) ?? readNonEmptyString(obj?.sessionID) ?? ""
}

function readParentSession(payload: unknown): string {
  const obj = asObjectOptional(payload)
  return readNonEmptyString(obj?.parentSessionId) ?? readNonEmptyString(obj?.parentSessionID) ?? ""
}

function readChildSession(payload: unknown): string {
  const obj = asObjectOptional(payload)
  return readNonEmptyString(obj?.childSessionId) ?? readNonEmptyString(obj?.childSessionID) ?? ""
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

async function listAllEntries(base: string): Promise<Array<{ file: string; entry: Entry; mtimeMs: number }>> {
  const root = path.join(base, "entries")
  const groups = await readdir(root, { withFileTypes: true }).catch(() => [])
  const out: Array<{ file: string; entry: Entry; mtimeMs: number }> = []
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
      const st = await Bun.file(file).stat().catch(() => null)
      const mtimeMs = st?.mtime?.getTime?.() ? st.mtime.getTime() : 0
      out.push({ file, entry, mtimeMs })
    }
  }
  out.sort((a, b) => {
    const at = Math.max(Number(a.entry.time.updated || 0) || 0, a.mtimeMs || 0, Number(a.entry.time.created || 0) || 0)
    const bt = Math.max(Number(b.entry.time.updated || 0) || 0, b.mtimeMs || 0, Number(b.entry.time.created || 0) || 0)
    return bt - at
  })
  return out
}

function buildCursor(input: {
  commonDir: string
  sessionId: string
  parentSessionId: string
  childSessionId: string
  all: BindingRow[]
  repo: BindingRow[]
  session: BindingRow[]
}) {
  const latest = (items: BindingRow[]) =>
    items.reduce((acc, x) => Math.max(acc, x.updatedAt || x.createdAt || 0), 0)
  const repoSig = input.commonDir ? input.commonDir : "(no-repo)"
  return [
    "v2",
    repoSig,
    input.sessionId,
    input.parentSessionId,
    input.childSessionId,
    latest(input.all),
    input.all.length,
    latest(input.repo),
    input.repo.length,
    latest(input.session),
    input.session.length,
  ].join(":")
}

async function snapshot(payload: unknown, context: BridgeContext) {
  const scope = readScope(payload)
  const payloadSession = readSession(payload)
  const payloadParentSession = readParentSession(payload)
  const payloadChildSession = readChildSession(payload)
  const cwd = (context.cwd ?? "").trim() ? path.resolve(context.cwd!) : process.cwd()
  const base = resolveWorkbenchBase()

  const deps = {
    git: checkCmd("git"),
    gh: checkCmd("gh"),
  }
  const workflowMode = toolingModeFromDeps(deps)

  const sessionId = payloadSession || String(context.sessionId || "").trim()
  const parentSessionId = payloadParentSession || String(context.parentSessionId || "").trim() || sessionId
  const childSessionId = payloadChildSession || String(context.childSessionId || "").trim()

  const projectRootDetected = deps.git.ok ? gitShowTopLevel(cwd) : ""
  const commonDirDetected = deps.git.ok ? gitCommonDir(cwd) : ""

  const all = await listAllEntries(base)
  const rows: BindingRow[] = all.flatMap(({ entry, mtimeMs }) => {
    const dir = String(entry.worktree?.path || "").trim()
    const name = String(entry.name || "").trim()
    if (!dir || !name) return []

    const branch = String(entry.worktree.branch || "").trim()
    const repoCommonDir = String(entry.repo?.commonDir || "").trim()
    const sessionId = String(entry.session?.id || "").trim()
    const parentSessionId = String(entry.session?.parent || "").trim()
    const upstream = String(entry.github?.upstream || "").trim()
    const fork = String(entry.github?.fork || "").trim()
    const prUrl = String(entry.github?.prUrl || "").trim()

    const updatedAt = Math.max(Number(entry.time?.updated || 0) || 0, Number(mtimeMs || 0) || 0)
    const createdAt = Math.max(Number(entry.time?.created || 0) || 0, 0)

    const row: BindingRow = {
      name,
      dir,
      ...(branch ? { branch } : {}),
      ...(repoCommonDir ? { repoCommonDir } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(upstream ? { upstream } : {}),
      ...(fork ? { fork } : {}),
      ...(prUrl ? { prUrl } : {}),
      updatedAt,
      createdAt,
    }

    return [row]
  })

  const sessionKeys = new Set([sessionId, parentSessionId, childSessionId].map((x) => String(x || "").trim()).filter(Boolean))
  const bySessionDirect = sessionKeys.size
    ? rows.filter((r) => {
        const sid = String(r.sessionId || "").trim()
        const pid = String(r.parentSessionId || "").trim()
        if (sid && sessionKeys.has(sid)) return true
        if (pid && sessionKeys.has(pid)) return true
        return false
      })
    : []

  const projectRoot = projectRootDetected || bySessionDirect[0]?.dir || ""
  const bySession = bySessionDirect.length
    ? bySessionDirect
    : projectRoot
      ? rows.filter((r) => path.resolve(r.dir) === path.resolve(projectRoot))
      : []

  const commonDir = commonDirDetected || bySession[0]?.repoCommonDir || ""
  const byRepo = commonDir
    ? rows.filter((r) => (r.repoCommonDir ? path.resolve(r.repoCommonDir) === path.resolve(commonDir) : false))
    : []

  const selected = scope === "all" ? rows : scope === "repo" ? byRepo : bySession

  const cursor = buildCursor({
    commonDir,
    sessionId,
    parentSessionId,
    childSessionId,
    all: rows,
    repo: byRepo,
    session: bySession,
  })

  return {
    sessionId,
    parentSessionId,
    childSessionId,
    cwd,
    base,
    deps,
    workflowMode,
    projectRoot,
    scope,
    counts: {
      session: bySession.length,
      repo: byRepo.length,
      all: rows.length,
    },
    repo: {
      commonDir,
    },
    bindings: selected,
    bindingsAllCount: rows.length,
    cursor,
    time: Date.now(),
  }
}

async function eventsPoll(payload: unknown, context: BridgeContext) {
  const input = asObjectOptional(payload)
  const prev = readNonEmptyString(input?.cursor) ?? ""
  const snap = await snapshot(
    {
      scope: "session",
      sessionId: readSession(payload),
      parentSessionId: readParentSession(payload),
      childSessionId: readChildSession(payload),
    },
    context,
  )
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
