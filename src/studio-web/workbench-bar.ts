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
  parentSessionId?: string
  childSessionId?: string
  cwd: string
  base: string
  scope: "session" | "repo" | "all"
  counts: {
    session: number
    repo: number
    all: number
  }
  deps: {
    git: { ok: boolean; version: string }
    gh: { ok: boolean; version: string }
  }
  projectRoot: string
  repo: {
    commonDir: string
  }
  bindings: Array<{
    name: string
    dir: string
    branch?: string
    sessionId?: string
    parentSessionId?: string
    upstream?: string
    fork?: string
    prUrl?: string
    updatedAt: number
    createdAt: number
  }>
  bindingsAllCount: number
  cursor: string
  time: number
}

type State = {
  sessionId: string
  parentSessionId: string
  childSessionId: string
  collapsed: boolean
  scope: "session" | "repo"
  infoOpen: boolean
  loading: boolean
  busy: boolean
  error: string | null
  snapshot: Snapshot | null
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
  if (name === "x") {
    return `<svg ${common}><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>`
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
  if (name === "help") {
    return `<svg ${common}><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 4.2 1.8c-.9.8-1.7 1.3-1.7 2.2"/><path d="M12 16h.01"/></svg>`
  }
  return ""
}

function parseSnapshot(value: JsonValue): Snapshot | null {
  const obj = asObject(value)
  const depsObj = asObject(obj.deps)
  const repoObj = asObject(obj.repo)
  const countsObj = asObject(obj.counts)
  const bindings = asArray(obj.bindings)
    .map((row) => {
      const r = asObject(row)
      const name = toStringValue(r.name)
      const dir = toStringValue(r.dir)
      if (!name || !dir) return null
      return {
        name,
        dir,
        branch: toStringValue(r.branch) || undefined,
        sessionId: toStringValue(r.sessionId) || undefined,
        parentSessionId: toStringValue(r.parentSessionId) || undefined,
        upstream: toStringValue(r.upstream) || undefined,
        fork: toStringValue(r.fork) || undefined,
        prUrl: toStringValue(r.prUrl) || undefined,
        updatedAt: toNumber(r.updatedAt),
        createdAt: toNumber(r.createdAt),
      }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)

  return {
    sessionId: toStringValue(obj.sessionId),
    parentSessionId: toStringValue(obj.parentSessionId) || undefined,
    childSessionId: toStringValue(obj.childSessionId) || undefined,
    cwd: toStringValue(obj.cwd),
    base: toStringValue(obj.base),
    scope:
      toStringValue(obj.scope) === "all" ? "all" : toStringValue(obj.scope) === "repo" ? "repo" : "session",
    counts: {
      session: toNumber(countsObj.session),
      repo: toNumber(countsObj.repo),
      all: toNumber(countsObj.all),
    },
    deps: {
      git: parseDep(depsObj.git),
      gh: parseDep(depsObj.gh),
    },
    projectRoot: toStringValue(obj.projectRoot),
    repo: {
      commonDir: toStringValue(repoObj.commonDir),
    },
    bindings,
    bindingsAllCount: toNumber(obj.bindingsAllCount),
    cursor: toStringValue(obj.cursor),
    time: toNumber(obj.time),
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

export function mount(el: HTMLElement, opts: StudioMountOptions) {
  const sessionId = String(opts.context?.sessionId || opts.context?.sessionID || "").trim()
  const parentSessionId = String(opts.context?.parentSessionId || opts.context?.parentSessionID || sessionId).trim()
  const childSessionId = String(opts.context?.childSessionId || opts.context?.childSessionID || "").trim()

  const state: State = {
    sessionId,
    parentSessionId,
    childSessionId,
    collapsed: true,
    scope: "session",
    infoOpen: false,
    loading: false,
    busy: false,
    error: null,
    snapshot: null,
  }

  let refreshTimer: number | null = null
  let stopEvents: (() => void) | null = null
  let reserveObserver: ResizeObserver | null = null
  let reserveRaf = 0
  let refreshSeq = 0

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
    const seq = ++refreshSeq
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
      const raw = await invoke("workbench.snapshot", {
        scope: state.scope,
        sessionId: state.sessionId,
        parentSessionId: state.parentSessionId,
        childSessionId: state.childSessionId,
      })
      const snap = parseSnapshot(raw)
      if (!snap) throw new Error("Snapshot is unavailable")
      if (seq !== refreshSeq) return
      state.snapshot = snap
      state.parentSessionId = String(snap.parentSessionId || state.parentSessionId || state.sessionId).trim()
      state.childSessionId = String(snap.childSessionId || state.childSessionId || "").trim()
    } catch (error) {
      if (seq !== refreshSeq) return
      state.error = error instanceof Error ? error.message : String(error)
      state.snapshot = null
    } finally {
      if (seq !== refreshSeq) return
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
      state.infoOpen = false
      render()
      scheduleReserveUpdate()
      return
    }
    void refreshAll()
  }

  function toggleScope() {
    state.scope = state.scope === "session" ? "repo" : "session"
    state.infoOpen = false
    void refreshAll()
  }

  function toggleInfo() {
    state.infoOpen = !state.infoOpen
    render()
    scheduleReserveUpdate()
  }

  function renderCollapsedButton(): string {
    const count = state.snapshot?.bindings.length ?? 0
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
      return `<div class="flex items-center gap-2 text-[11px]"><span class="font-medium text-foreground/90">${htmlEscape(
        name,
      )}</span>${badge}<span class="min-w-0 truncate text-[10px] text-muted-foreground" title="${htmlEscape(version)}">${htmlEscape(
        version,
      )}</span></div>`
    }
    return `<div class="grid gap-1">${row("git", snap.deps.git.ok, snap.deps.git.version)}${row("gh", snap.deps.gh.ok, snap.deps.gh.version)}</div>`
  }

  function renderInfo(snap: Snapshot): string {
    const meta = [
      snap.repo.commonDir ? `repo=${snap.repo.commonDir}` : "repo=(not detected)",
      `scope=${snap.scope}`,
      `session=${snap.sessionId || "(unknown)"}`,
      snap.parentSessionId ? `parent=${snap.parentSessionId}` : "",
      snap.childSessionId ? `child=${snap.childSessionId}` : "",
      `bindings session=${snap.counts.session} repo=${snap.counts.repo} all=${snap.counts.all}`,
    ]
      .filter(Boolean)
      .map((line) => `<div class="text-[11px] text-muted-foreground">${htmlEscape(line)}</div>`)
      .join("")
    return `<div class="flex flex-col gap-2">${renderDeps(snap)}<div class="grid gap-0.5">${meta}</div></div>`
  }

  function renderBindings(snap: Snapshot): string {
    if (!snap.bindings.length) {
      return snap.scope === "repo"
        ? `<div class="px-2 py-2 text-center text-xs text-muted-foreground">No bindings found for this repo.</div>`
        : `<div class="px-2 py-2 text-center text-xs text-muted-foreground">No binding found for this session.</div>`
    }

    const rows = snap.bindings
      .slice(0, 8)
      .map((b) => {
        const pr = prId(b.prUrl)
        const upstream = String(b.upstream || "").trim()
        const fork = String(b.fork || "").trim()
        const suffix = [
          b.branch ? `branch=${b.branch}` : "",
          b.sessionId ? `session=${b.sessionId}` : "",
          b.parentSessionId ? `parent=${b.parentSessionId}` : "",
          pr ? `pr=${pr}` : "",
          upstream ? `up=${upstream}` : "",
          fork ? `fork=${fork}` : "",
        ]
          .filter(Boolean)
          .join(" ")
        return `
          <div class="rounded-md border border-border/40 bg-muted/10 px-2 py-1.5">
            <div class="flex items-center gap-2">
              <div class="min-w-0 flex-1">
                <div class="text-[12px] font-semibold truncate" title="${htmlEscape(b.dir)}">${htmlEscape(b.name)}</div>
                <div class="text-[10px] text-muted-foreground truncate" title="${htmlEscape(suffix)}">${htmlEscape(suffix)}</div>
              </div>
              ${pr ? `<span class="text-[10px] px-1 rounded bg-primary/10 text-primary">#${htmlEscape(pr)}</span>` : ""}
            </div>
          </div>
        `
      })
      .join("")

    return `<div class="flex flex-col gap-1.5">${rows}</div>`
  }

  function renderExpandedPanel(): string {
    const snap = state.snapshot

    const errorBlock = state.error
      ? `<div class="rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive flex items-start gap-2"><span class="font-bold">Error:</span> ${htmlEscape(state.error)}</div>`
      : ""

    const header = `
      <div class="flex items-center border-b border-border/30 bg-muted/20 gap-2 px-2 py-1">
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <span class="truncate text-[11px] font-semibold text-foreground/90 select-none cursor-default" title="Workbench">Workbench</span>
          <span class="text-[10px] px-1 rounded bg-muted text-muted-foreground">${htmlEscape(
            state.scope === "repo" ? "repo" : "session",
          )}</span>
          ${state.loading ? '<span class="animate-pulse text-[10px] text-muted-foreground">Updating...</span>' : ""}
        </div>
        <div class="flex items-center gap-0.5">
          <button
            type="button"
            data-wb-action="scope"
            class="h-7 px-2 inline-flex items-center justify-center rounded border border-border/50 bg-background/50 hover:bg-background hover:border-border/70 transition-colors text-[10px] text-muted-foreground"
            title="Toggle scope"
            aria-label="Toggle scope"
          >
            ${htmlEscape(state.scope === "repo" ? "Session" : `Repo ${snap?.counts?.repo ? `(${snap.counts.repo})` : ""}`.trim())}
          </button>
          <button
            type="button"
            data-wb-action="info"
            class="h-7 w-7 inline-flex items-center justify-center rounded border transition-colors ${
              state.infoOpen
                ? "border-border/70 bg-muted/50 text-foreground shadow-inner"
                : "border-transparent text-muted-foreground hover:bg-muted/40"
            }"
            title="${state.infoOpen ? "Hide details" : "Show details"}"
            aria-label="${state.infoOpen ? "Hide details" : "Show details"}"
            aria-pressed="${state.infoOpen ? "true" : "false"}"
          >
            ${iconSvg("help", `h-3.5 w-3.5 ${state.infoOpen ? "text-foreground/90" : "text-muted-foreground/70"}`)}
          </button>
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
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 text-[11px] font-semibold text-foreground/85">
                ${iconSvg(state.infoOpen ? "help" : "list", "h-4 w-4 text-muted-foreground/70")}
                <span>${htmlEscape(state.infoOpen ? "Info" : "Bindings")}</span>
              </div>
              <span class="text-[10px] text-muted-foreground truncate">${htmlEscape(snap.repo.commonDir || "")}</span>
            </div>
            ${state.infoOpen ? renderInfo(snap) : renderBindings(snap)}
          </div>
        `

    return `
      <section
        class="pointer-events-auto relative w-full rounded-lg border border-border/60 bg-background/95 shadow-xl backdrop-blur-md overflow-hidden transition-all duration-300 ease-in-out flex flex-col"
        style="max-height: 50vh;"
      >
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
    if (action === "scope") {
      toggleScope()
      return
    }
    if (action === "info") {
      toggleInfo()
      return
    }
    if (action === "refresh") {
      scheduleRefresh(0)
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
