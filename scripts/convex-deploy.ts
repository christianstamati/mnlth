#!/usr/bin/env bun
/**
 * Push `packages/backend/convex` to a deployed stage's Convex backend.
 *
 *   bun scripts/convex-deploy.ts --stage <stage> [--wait] [--dev]
 *
 * The URL and admin key come from SSM (see `scripts/lib/stage.ts`). `--wait`
 * polls for a freshly deployed stage instead of failing while its key or
 * its certificate is still on the way. `--dev` runs `convex dev` (watch and
 * push on save) instead of a one-shot `convex deploy`; `sst dev` uses that.
 */
import { convex, resolveStage } from "./lib/stage"

const args = process.argv.slice(2)
const stage = args[args.indexOf("--stage") + 1]
if (!args.includes("--stage") || !stage || stage.startsWith("--")) {
  console.error(
    "usage: bun scripts/convex-deploy.ts --stage <stage> [--wait] [--dev]"
  )
  process.exit(2)
}
const wait = args.includes("--wait")
const dev = args.includes("--dev")

const target = await resolveStage(stage, { wait }).catch((error: Error) => {
  console.error(error.message)
  process.exit(1)
})

console.log(
  `${dev ? "Watching" : "Deploying"} packages/backend/convex -> ${target.url}`
)
const proc = convex(target, dev ? ["dev"] : ["deploy", "--yes"])
process.exit(await proc.exited)
