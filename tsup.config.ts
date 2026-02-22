import fs from "fs/promises"
import path from "path"
import { defineConfig } from "tsup"
import packageJson from "./package.json"

const studioWebEntry = "studio-web/workbench-bar.js"

const studioManifest = {
  studioApiVersion: 1,
  id: "opencode-workbench",
  displayName: "Workbench",
  version: packageJson.version,
  bridge: {
    command: ["bun", "dist/studio-bridge.js"],
  },
  ui: {
    mode: "module",
    assetsDir: "dist",
    entry: studioWebEntry,
  },
  mounts: [
    {
      surface: "chat.overlay.bottom",
      title: "Workbench",
      entry: studioWebEntry,
      mode: "module",
    },
  ],
  capabilities: ["settings.panel", "events.poll"],
  events: {
    pollIntervalMs: 1500,
  },
  settingsSchema: {
    type: "object",
    properties: {
      base: {
        title: "Base branch",
        description: "Default base branch name for create when github=true (e.g. main/dev).",
        type: "string",
      },
      copyMode: {
        title: "Copy mode",
        description: "archive=git archive (tracked+committed), worktree=filesystem copy (includes local edits/untracked).",
        type: "string",
        enum: ["archive", "worktree"],
      },
      copyExcludeMode: {
        title: "Exclude mode",
        description: "append=DEFAULT_EXCLUDE + copyExclude, replace=only copyExclude.",
        type: "string",
        enum: ["append", "replace"],
      },
      copyExclude: {
        title: "Exclude patterns",
        description: "Exclude patterns for rsync sync/copy (basenames like node_modules).",
        type: "array",
        items: { type: "string" },
      },
      github: {
        title: "GitHub wiring",
        description: "Run gh fork/remotes wiring during create.",
        type: "boolean",
      },
      ghHost: {
        title: "GH host",
        description: "GitHub hostname (default github.com).",
        type: "string",
      },
      repo: {
        title: "Repo",
        description: "Override repo nameWithOwner for gh (e.g. org/repo).",
        type: "string",
      },
      fork: {
        title: "Fork",
        description: "Override fork nameWithOwner for gh (e.g. me/repo).",
        type: "string",
      },
      upstreamRemote: {
        title: "Upstream remote",
        description: "Remote name for upstream (default upstream).",
        type: "string",
      },
      forkRemote: {
        title: "Fork remote",
        description: "Remote name for fork (default fork).",
        type: "string",
      },
      protocol: {
        title: "Git protocol",
        description: "auto=from gh config, or force ssh/https.",
        type: "string",
        enum: ["auto", "ssh", "https"],
      },
      fetch: {
        title: "Fetch remotes",
        description: "Fetch after wiring remotes.",
        type: "boolean",
      },
      push: {
        title: "Auto push",
        description: "Push on create/publish when github=true.",
        type: "boolean",
      },
      pr: {
        title: "Auto PR",
        description: "Create/reuse PR on publish when github=true.",
        type: "boolean",
      },
      draft: {
        title: "Draft PR",
        description: "Create PR as draft.",
        type: "boolean",
      },
      prLabels: {
        title: "PR labels",
        description: "Labels to add on PR create/edit.",
        type: "array",
        items: { type: "string" },
      },
      stage: {
        title: "Git stage",
        description: "all=git add -A, tracked=git add -u.",
        type: "string",
        enum: ["all", "tracked"],
      },
      commitBodyAuto: {
        title: "Commit body auto",
        description: "If commitBody empty, auto-generate file list.",
        type: "boolean",
      },
      allowDirty: {
        title: "Allow dirty target",
        description: "Allow publish/sync when target worktree is dirty.",
        type: "boolean",
      },
      delete: {
        title: "Sync deletions",
        description: "Propagate deletions sandbox -> target (rsync).",
        type: "boolean",
      },
      lockTimeout: {
        title: "Lock TTL (s)",
        description: "Lock TTL seconds for sync/publish/reset.",
        type: "integer",
        minimum: 0,
      },
    },
    additionalProperties: false,
  },
}

async function writeStudioManifest() {
  const distDir = path.resolve("dist")
  const manifestPath = path.join(distDir, "studio.manifest.json")
  await fs.mkdir(distDir, { recursive: true })
  await fs.writeFile(manifestPath, `${JSON.stringify(studioManifest, null, 2)}\n`, "utf8")
}

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "studio-bridge": "src/studio/bridge.ts",
    "studio-web/workbench-bar": "src/studio-web/workbench-bar.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ["@opencode-ai/plugin"],
  onSuccess: async () => {
    await writeStudioManifest()
  },
})
