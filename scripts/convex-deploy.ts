#!/usr/bin/env bun
/**
 * Push `packages/backend/convex` to a deployed stage's Convex backend.
 *
 *   bun scripts/convex-deploy.ts --stage <stage> [--wait] [--dev]
 *
 * The Convex CLI needs two things for a self-hosted deployment: the URL and
 * an admin key. Both live in SSM, written by the stack (`/<app>/<stage>/convex/url`)
 * and by the instance a few minutes into its first boot (`.../admin-key`).
 * `--wait` polls for the key instead of giving up while the placeholder is
 * still there, then for the backend to answer over TLS: the key lands in SSM
 * before Caddy has its certificate, so a push right after it fails on fetch. `--dev` runs `convex dev` (watch and push on save) instead of
 * a one-shot `convex deploy`; `sst dev` uses that.
 */
import { $ } from "bun"

const APP = "mnlth"
const BACKEND_DIR = new URL("../packages/backend", import.meta.url).pathname
const PENDING = "pending: written by the instance on first boot"
const WAIT_SECONDS = 15 * 60
const POLL_SECONDS = 15

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

const prefix = `/${APP}/${stage}/convex`

function die(error: Error): never {
  console.error(error.message)
  process.exit(1)
}

async function parameter(name: string): Promise<string> {
  const out =
    await $`aws ssm get-parameter --name ${name} --with-decryption --query Parameter.Value --output text`
      .quiet()
      .nothrow()
  if (out.exitCode !== 0) {
    throw new Error(
      `Could not read ${name}: ${out.stderr.toString().trim()}\n` +
        `Has \`sst deploy --stage ${stage}\` run?`
    )
  }
  return out.stdout.toString().trim()
}

const url = await parameter(`${prefix}/url`).catch(die)

let adminKey = await parameter(`${prefix}/admin-key`).catch(die)
if (adminKey === PENDING) {
  if (!wait) {
    console.error(
      `The admin key for ${stage} is not published yet: the backend mints it a few\n` +
        "minutes after its first boot. Retry shortly, or pass --wait."
    )
    process.exit(1)
  }
  const deadline = Date.now() + WAIT_SECONDS * 1000
  process.stderr.write(
    `Waiting for ${stage}'s backend to publish its admin key`
  )
  while (adminKey === PENDING) {
    if (Date.now() > deadline) {
      console.error(
        `\nGave up after ${WAIT_SECONDS / 60} minutes. Check the instance's cloud-init log.`
      )
      process.exit(1)
    }
    await Bun.sleep(POLL_SECONDS * 1000)
    process.stderr.write(".")
    adminKey = await parameter(`${prefix}/admin-key`).catch(die)
  }
  process.stderr.write("\n")
}

// The key can be published a minute or two before the box serves HTTPS:
// Caddy still has to finish the DNS-01 challenge and the records have to
// propagate. Same budget as the key.
async function ready(): Promise<boolean> {
  try {
    const res = await fetch(`${url}/version`, {
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok
  } catch {
    return false
  }
}

if (!(await ready())) {
  if (!wait) {
    console.error(`${url} is not answering yet. Retry shortly, or pass --wait.`)
    process.exit(1)
  }
  const deadline = Date.now() + WAIT_SECONDS * 1000
  process.stderr.write(`Waiting for ${url} to answer`)
  while (!(await ready())) {
    if (Date.now() > deadline) {
      console.error(
        `\nGave up after ${WAIT_SECONDS / 60} minutes. Check Caddy on the instance.`
      )
      process.exit(1)
    }
    await Bun.sleep(POLL_SECONDS * 1000)
    process.stderr.write(".")
  }
  process.stderr.write("\n")
}

console.error(
  `${dev ? "Watching" : "Deploying"} packages/backend/convex -> ${url}`
)

const env = {
  ...process.env,
  CONVEX_SELF_HOSTED_URL: url,
  CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
}
const proc = Bun.spawn(
  dev ? ["bunx", "convex", "dev"] : ["bunx", "convex", "deploy", "--yes"],
  { cwd: BACKEND_DIR, env, stdio: ["inherit", "inherit", "inherit"] }
)
process.exit(await proc.exited)
