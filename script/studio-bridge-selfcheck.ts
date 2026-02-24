import { spawnSync } from "node:child_process"
import path from "node:path"

function run(request: unknown) {
  const file = path.resolve("dist", "studio-bridge.js")
  const res = spawnSync("bun", [file], {
    input: JSON.stringify(request),
    encoding: "utf8",
  })
  if (res.error) throw res.error
  if (res.status !== 0) {
    throw new Error(`bridge exited with ${res.status}: ${res.stderr || res.stdout}`)
  }
  const out = String(res.stdout || "").trim()
  if (!out) throw new Error("bridge returned empty output")
  return JSON.parse(out) as any
}

const resp1 = run({ action: "workbench.snapshot", payload: null, context: { sessionId: "studio", cwd: process.cwd() } })
if (!resp1 || resp1.ok !== true) throw new Error(`snapshot failed: ${JSON.stringify(resp1)}`)
if (typeof resp1.data?.sessionId !== "string") throw new Error("snapshot missing sessionId")
if (typeof resp1.data?.parentSessionId !== "string") throw new Error("snapshot missing parentSessionId")

const resp2 = run({ action: "events.poll", payload: { cursor: "" }, context: { sessionId: "studio", cwd: process.cwd() } })
if (!resp2 || resp2.ok !== true) throw new Error(`events.poll failed: ${JSON.stringify(resp2)}`)

process.stdout.write("studio bridge selfcheck: ok\n")
