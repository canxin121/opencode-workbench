/// <reference lib="dom" />

type JsonPrimitive = string | number | boolean | null
type JsonObject = { [k: string]: JsonValue }
type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

type HostApi = {
  invokeAction: (action: string, payload?: JsonValue, context?: JsonValue) => Promise<JsonValue>
  subscribeEvents: (handlers: {
    onEvent?: (evt: { type: string; data: JsonValue; lastEventId?: string }) => void
    onError?: (err: Event) => void
  }) => () => void
}

type LayoutApi = {
  setReservePx: (px: number) => void
}

export type StudioMountOptions = {
  pluginId: string
  surface: string
  title?: string
  context: Record<string, string>
  host: HostApi
  layout?: LayoutApi
}

type Snapshot = {
  sessionId: string
  cwd: string
  projectRoot: string
  base: string
  deps: {
    git: { ok: boolean; version: string }
    gh: { ok: boolean; version: string }
    rsync: { ok: boolean; version: string }
    tar: { ok: boolean; version: string }
  }
  config: {
    path: string
    status: "missing" | "loaded" | "invalid"
    config: Record<string, JsonValue>
  }
  sandboxes: Array<{
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
  }>
  sandboxesAllCount: number
}

type State = {
  sessionId: string
  collapsed: boolean
  loading: boolean
  busy: boolean
  error: string | null
  snapshot: Snapshot | null
  showAll: boolean
}

function asObject(value: JsonValue | undefined | null): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, JsonValue>
}

function asArray(value: JsonValue | undefined | null): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function toStringValue(value: JsonValue | undefined, fallback = ""): string {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

function toNumber(value: JsonValue | undefined, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.trunc(value)
}

function htmlEscape(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function iconSvg(name: string, className: string): string {
  const common = `class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`
  if (name === "wrench") {
    return `<svg ${common}><path d="M14.7 6.3a4 4 0 0 0-5.6 5.6l-6.2 6.2a2 2 0 0 0 2.8 2.8l6.2-6.2a4 4 0 0 0 5.6-5.6l-2.1 2.1-2.8-2.8 2.1-2.1Z"/></svg>`
  }
  if (name === "refresh") {
    return `<svg ${common}><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`
  }
  if (name === "hide") {
    return `<svg ${common}><path d="M3 3l18 18"/><path d="M10.58 10.58A3 3 0 0 0 12 15a3 3 0 0 0 2.42-4.42"/><path d="M9.88 5.09A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a18 18 0 0 1-3.2 4.2"/><path d="M6.1 6.1A18.5 18.5 0 0 0 2 12s3 7 10 7a10.7 10.7 0 0 0 3.1-.4"/></svg>`
  }
  if (name === "list") {
    return `<svg ${common}><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>`
  }
  return ""
}

function parseSnapshot(value: JsonValue): Snapshot | null {
  const obj = asObject(value)
  const configObj = asObject(obj.config)
  const depsObj = asObject(obj.deps)

  const deps = {
    git: parseDep(depsObj.git),
    gh: parseDep(depsObj.gh),
    rsync: parseDep(depsObj.rsync),
    tar: parseDep(depsObj.tar),
  }

  const sandboxes = asArray(obj.sandboxes)
    .map((row) => {
      const r = asObject(row)
      const name = toStringValue(r.name)
      const dir = toStringValue(r.dir)
      const projectId = toStringValue(r.projectId)
      const projectWorktree = toStringValue(r.projectWorktree)
      const sourceWorktree = toStringValue(r.sourceWorktree)
      if (!name || !dir || !projectId || !projectWorktree) return null
      return {
        name,
        dir,
        branch: toStringValue(r.branch) || undefined,
        projectId,
        projectWorktree,
        sourceWorktree,
        sessionId: toStringValue(r.sessionId) || undefined,
        prUrl: toStringValue(r.prUrl) || undefined,
        publishCommit: toStringValue(r.publishCommit) || undefined,
        updatedAt: toNumber(r.updatedAt),
        createdAt: toNumber(r.createdAt),
      }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)

  return {
    sessionId: toStringValue(obj.sessionId),
    cwd: toStringValue(obj.cwd),
    projectRoot: toStringValue(obj.projectRoot),
    base: toStringValue(obj.base),
    deps,
    config: {
      path: toStringValue(configObj.path),
      status: toStringValue(configObj.status) === "loaded" ? "loaded" : toStringValue(configObj.status) === "invalid" ? "invalid" : "missing",
      config: asObject(configObj.config),
    },
    sandboxes,
    sandboxesAllCount: toNumber(obj.sandboxesAllCount),
  }
}

function parseDep(value: JsonValue | undefined): { ok: boolean; version: string } {
  const obj = asObject(value)
  return {
    ok: obj.ok === true,
    version: toStringValue(obj.version),
  }
}

function prId(url?: string): string {
  const u = String(url || "")
  const m = u.match(/\/pull\/(\d+)/)
  return m?.[1] ?? ""
}

function shortHash(hash?: string): string {
  const h = String(hash || "")
  return h.length >= 8 ? h.slice(0, 8) : h
}

export function mount(el: HTMLElement, opts: StudioMountOptions) {
  const sessionId = String(opts.context?.sessionId || "").trim()

  const state: State = {
    sessionId,
    collapsed: true,
    loading: false,
    busy: false,
    error: null,
    snapshot: null,
    showAll: false,
  }

  let refreshTimer: number | null = null
  let stopEvents: (() => void) | null = null
  let reserveObserver: ResizeObserver | null = null
  let reserveRaf = 0

  function setReservePx(px: number) {
    if (!opts.layout) return
    opts.layout.setReservePx(px)
  }

  function computeReserve(): number {
    const rect = el.getBoundingClientRect()
    if (!Number.isFinite(rect.height) || rect.height <= 0) return 0
    const bottomGap = 8
    return Math.max(0, Math.ceil(rect.height + bottomGap))
  }

  function scheduleReserveUpdate() {
    if (!opts.layout) return
    if (reserveRaf) return
    reserveRaf = window.requestAnimationFrame(() => {
      reserveRaf = 0
      if (!state.sessionId) {
        setReservePx(0)
        return
      }
      setReservePx(computeReserve())
    })
  }

  function isVisible(): boolean {
    return Boolean(state.sessionId)
  }

  async function invoke(action: string, payload: JsonValue = null): Promise<JsonValue> {
    return await opts.host.invokeAction(action, payload, null)
  }

  async function refreshAll() {
    if (!isVisible()) {
      state.snapshot = null
      state.error = null
      state.loading = false
      render()
      setReservePx(0)
      return
    }
    state.loading = true
    state.error = null
    render()
    scheduleReserveUpdate()
    try {
      const raw = await invoke("workbench.snapshot")
      const snap = parseSnapshot(raw)
      if (!snap) throw new Error("Snapshot is unavailable")
      state.snapshot = snap
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      state.snapshot = null
    } finally {
      state.loading = false
      render()
      scheduleReserveUpdate()
    }
  }

  function scheduleRefresh(delayMs = 120) {
    if (refreshTimer) window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null
      void refreshAll()
    }, Math.max(0, Math.floor(delayMs)))
  }

  function toggleCollapsed() {
    state.collapsed = !state.collapsed
    if (state.collapsed) {
      state.showAll = false
      render()
      scheduleReserveUpdate()
      return
    }
    void refreshAll()
  }

  function toggleAll() {
    state.showAll = !state.showAll
    render()
    scheduleReserveUpdate()
  }

  function renderCollapsedButton(): string {
    const count = state.snapshot?.sandboxes.length ?? 0
    const label = count ? `WB ${count}` : "WB"
    return `
      <div class="pointer-events-auto p-1">
        <button
          type="button"
          data-wb-action="toggle"
          class="h-9 px-3 rounded-full shadow-md border border-border/50 bg-background/80 backdrop-blur hover:bg-background transition-all inline-flex items-center gap-2"
          aria-label="Show workbench"
          title="Show workbench"
          ${state.busy ? "disabled" : ""}
        >
          ${iconSvg("wrench", "h-4 w-4 text-muted-foreground")}
          <span class="text-xs font-semibold text-foreground/90">${htmlEscape(label)}</span>
        </button>
      </div>
    `
  }

  function renderDeps(snap: Snapshot): string {
    const row = (name: string, ok: boolean, version: string) => {
      const badge = ok
        ? '<span class="text-[10px] px-1 rounded bg-emerald-500/15 text-emerald-700">OK</span>'
        : '<span class="text-[10px] px-1 rounded bg-rose-500/15 text-rose-700">Missing</span>'
      return `
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0 flex items-center gap-2">
            <span class="text-[11px] font-medium text-foreground/85">${htmlEscape(name)}</span>
            ${badge}
          </div>
          <span class="min-w-0 truncate text-[10px] text-muted-foreground" title="${htmlEscape(version)}">${htmlEscape(version)}</span>
        </div>
      `
    }
    return `
      <div class="grid gap-1">
        ${row("git", snap.deps.git.ok, snap.deps.git.version)}
        ${row("gh", snap.deps.gh.ok, snap.deps.gh.version)}
        ${row("rsync", snap.deps.rsync.ok, snap.deps.rsync.version)}
        ${row("tar", snap.deps.tar.ok, snap.deps.tar.version)}
      </div>
    `
  }

  function renderSandboxes(snap: Snapshot): string {
    const list = state.showAll ? snap.sandboxes : snap.sandboxes.slice(0, 6)
    if (!list.length) {
      return `<div class="px-2 py-2 text-center text-xs text-muted-foreground">No sandboxes found for this project.</div>`
    }
    const rows = list
      .map((s) => {
        const pr = prId(s.prUrl)
        const commit = shortHash(s.publishCommit)
        const suffix = [
          s.branch ? `branch=${s.branch}` : "",
          s.sessionId ? `session=${s.sessionId}` : "",
          pr ? `pr=${pr}` : "",
          commit ? `commit=${commit}` : "",
        ]
          .filter(Boolean)
          .join(" ")
        return `
          <div class="rounded-md border border-border/40 bg-muted/10 px-2 py-1.5">
            <div class="flex items-center gap-2">
              <div class="min-w-0 flex-1">
                <div class="text-[12px] font-semibold truncate" title="${htmlEscape(s.dir)}">${htmlEscape(s.name)}</div>
                <div class="text-[10px] text-muted-foreground truncate" title="${htmlEscape(suffix)}">${htmlEscape(suffix)}</div>
              </div>
              ${pr ? `<span class="text-[10px] px-1 rounded bg-primary/10 text-primary">#${htmlEscape(pr)}</span>` : ""}
            </div>
          </div>
        `
      })
      .join("")

    const more = snap.sandboxes.length > 6
      ? `<button type="button" data-wb-action="toggleAll" class="text-[11px] text-muted-foreground hover:text-foreground transition-colors">${state.showAll ? "Show less" : `Show all (${snap.sandboxes.length})`}</button>`
      : ""

    return `<div class="flex flex-col gap-1.5">${rows}${more ? `<div class="pt-0.5">${more}</div>` : ""}</div>`
  }

  function renderExpandedPanel(): string {
    const snap = state.snapshot
    const cfg = snap?.config
    const cfgBadge = !cfg
      ? ""
      : cfg.status === "loaded"
        ? '<span class="text-[10px] px-1 rounded bg-emerald-500/15 text-emerald-700">Config loaded</span>'
        : cfg.status === "invalid"
          ? '<span class="text-[10px] px-1 rounded bg-rose-500/15 text-rose-700">Config invalid</span>'
          : '<span class="text-[10px] px-1 rounded bg-muted text-muted-foreground">Config missing</span>'

    const errorBlock = state.error
      ? `<div class="rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive flex items-start gap-2"><span class="font-bold">Error:</span> ${htmlEscape(state.error)}</div>`
      : ""

    const header = `
      <div class="flex items-center border-b border-border/30 bg-muted/20 gap-2 px-2 py-1">
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <span class="truncate text-[11px] font-semibold text-foreground/90 select-none cursor-default" title="Workbench">Workbench</span>
          ${cfgBadge}
          ${state.loading ? '<span class="animate-pulse text-[10px] text-muted-foreground">Updating...</span>' : ""}
        </div>
        <div class="flex items-center gap-0.5">
          <button
            type="button"
            data-wb-action="refresh"
            class="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-muted/40"
            title="Refresh"
            aria-label="Refresh"
            ${state.busy ? "disabled" : ""}
          >
            ${iconSvg("refresh", "h-3.5 w-3.5 text-muted-foreground/70")}
          </button>
          <button
            type="button"
            data-wb-action="toggle"
            class="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-muted/40"
            title="Collapse"
            aria-label="Collapse"
          >
            ${iconSvg("hide", "h-3.5 w-3.5 text-muted-foreground/70")}
          </button>
        </div>
      </div>
    `

    const body = !snap
      ? `<div class="py-2 text-center text-xs text-muted-foreground italic leading-relaxed">${state.loading ? "Checking workbench..." : "No data yet."}</div>`
      : `
          <div class="flex flex-col gap-2">
            <div class="text-[11px] text-muted-foreground leading-snug">
              <div><span class="font-medium text-foreground/80">Project</span>: <span class="truncate" title="${htmlEscape(snap.projectRoot)}">${htmlEscape(snap.projectRoot || "(unknown)")}</span></div>
              <div><span class="font-medium text-foreground/80">Config</span>: <span class="truncate" title="${htmlEscape(snap.config.path)}">${htmlEscape(snap.config.path)}</span></div>
              <div><span class="font-medium text-foreground/80">Sandboxes</span>: ${snap.sandboxes.length}${snap.sandboxesAllCount !== snap.sandboxes.length ? ` (all=${snap.sandboxesAllCount})` : ""}</div>
            </div>
            <div class="rounded-md border border-border/40 bg-background/50 p-2">
              <div class="flex items-center gap-2 pb-1 text-[11px] font-semibold text-foreground/85">${iconSvg(
                "list",
                "h-4 w-4 text-muted-foreground/70",
              )}<span>Sandboxes</span></div>
              ${renderSandboxes(snap)}
            </div>
            <div class="rounded-md border border-border/40 bg-background/50 p-2">
              <div class="pb-1 text-[11px] font-semibold text-foreground/85">Tooling</div>
              ${renderDeps(snap)}
            </div>
          </div>
        `

    return `
      <section class="pointer-events-auto w-full rounded-lg border border-border/60 bg-background/95 shadow-xl backdrop-blur-md overflow-hidden transition-all duration-300 ease-in-out flex flex-col max-h-[50vh]">
        ${header}
        <div class="overflow-y-auto overscroll-contain flex-1 min-h-0 flex flex-col p-2 gap-2">
          ${body}
          ${errorBlock}
        </div>
      </section>
    `
  }

  function render() {
    if (!isVisible()) {
      el.innerHTML = ""
      setReservePx(0)
      return
    }
    const body = state.collapsed ? renderCollapsedButton() : renderExpandedPanel()
    el.innerHTML = `<div class="pointer-events-none w-full flex justify-end">${body}</div>`
  }

  function handleClick(event: MouseEvent) {
    const target = event.target as Element | null
    if (!target) return
    const actionEl = target.closest<HTMLElement>("[data-wb-action]")
    if (!actionEl) return
    const action = String(actionEl.dataset.wbAction || "").trim()
    if (action === "toggle") {
      toggleCollapsed()
      return
    }
    if (action === "refresh") {
      scheduleRefresh(0)
      return
    }
    if (action === "toggleAll") {
      toggleAll()
    }
  }

  function startEvents() {
    stopEvents?.()
    stopEvents = opts.host.subscribeEvents({
      onEvent: () => scheduleRefresh(120),
      onError: () => {
        // Host SSE will reconnect; keep UI stable.
      },
    })
  }

  el.addEventListener("click", handleClick)

  if (typeof ResizeObserver !== "undefined" && opts.layout) {
    reserveObserver = new ResizeObserver(() => scheduleReserveUpdate())
    reserveObserver.observe(el)
  }

  render()
  scheduleReserveUpdate()
  startEvents()
  void refreshAll()

  return {
    unmount() {
      stopEvents?.()
      stopEvents = null
      if (refreshTimer) {
        window.clearTimeout(refreshTimer)
        refreshTimer = null
      }
      reserveObserver?.disconnect()
      reserveObserver = null
      if (reserveRaf) {
        window.cancelAnimationFrame(reserveRaf)
        reserveRaf = 0
      }
      el.removeEventListener("click", handleClick)
      el.innerHTML = ""
      setReservePx(0)
    },
  }
}
