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
      titleI18n: {
        "en-US": "Workbench",
        "zh-CN": "工作台",
      },
      entry: studioWebEntry,
      mode: "module",
    },
  ],
  capabilities: ["events.poll"],
  events: {
    pollIntervalMs: 1500,
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
