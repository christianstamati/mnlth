#!/usr/bin/env bun
// Runs `convex dev` against the self-hosted backend that docker compose starts.
//
// The backend mints its own admin key, so there is nothing to check in: wait
// for the container to answer, generate the key on the first run, and cache it
// in packages/backend/.env.local, which is where the Convex CLI looks for it.
//
// TypeScript rather than shell so the same path works on Windows: fetch instead
// of curl, a regex instead of grep, and every child process is spawned without
// a shell so nothing depends on POSIX quoting.

import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const backendDir = join(root, "packages", "backend")
const envFile = join(backendDir, ".env.local")
const url = process.env.CONVEX_SELF_HOSTED_URL ?? "http://127.0.0.1:3210"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The container is still booting Postgres and running migrations when SST
// starts us, so poll rather than fail fast. No timeout on purpose: the first
// run also has to pull the images, which can take minutes.
async function waitForBackend() {
  process.stdout.write(`Waiting for the Convex backend at ${url}`)
  for (;;) {
    try {
      const response = await fetch(`${url}/version`, {
        signal: AbortSignal.timeout(2000),
      })
      await response.body?.cancel()
      if (response.ok) break
    } catch {
      // Not listening yet, or still refusing connections.
    }
    process.stdout.write(".")
    await sleep(1000)
  }
  process.stdout.write(" ready\n")
}

function readEnvFile() {
  try {
    return readFileSync(envFile, "utf8")
  } catch {
    return ""
  }
}

function generateAdminKey() {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-directory",
      root,
      "exec",
      "-T",
      "backend",
      "./generate_admin_key.sh",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  )
  if (result.error) throw result.error
  // The script prints a banner around the key, so pick the last thing shaped
  // like `<instance name>|<hex>`.
  const keys = result.stdout?.match(/[A-Za-z0-9_-]+\|[A-Za-z0-9]+/g)
  const key = keys?.at(-1)
  if (!key) {
    throw new Error("Could not read an admin key from generate_admin_key.sh")
  }
  return key
}

function ensureAdminKey() {
  const contents = readEnvFile()
  if (/^CONVEX_SELF_HOSTED_ADMIN_KEY=/m.test(contents)) return

  console.log("Generating an admin key for the local deployment")
  const key = generateAdminKey()
  const lines = []
  if (contents && !contents.endsWith("\n")) lines.push("")
  if (!/^CONVEX_SELF_HOSTED_URL=/m.test(contents)) {
    lines.push(`CONVEX_SELF_HOSTED_URL=${url}`)
  }
  lines.push(`CONVEX_SELF_HOSTED_ADMIN_KEY=${key}`, "")
  appendFileSync(envFile, lines.join("\n"))
}

// Stands in for `exec`: hand the terminal to `convex dev`, forward the signals
// SST uses to shut the process tree down, and exit with whatever it exits with.
function runConvexDev() {
  const child = spawn(
    "bun",
    ["run", "--cwd", backendDir, "dev", ...process.argv.slice(2)],
    { stdio: "inherit" }
  )
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal))
  }
  child.on("error", (error) => {
    console.error(error.message)
    process.exit(1)
  })
  child.on("exit", (code, signal) => {
    process.exit(signal ? 1 : (code ?? 1))
  })
}

try {
  await waitForBackend()
  ensureAdminKey()
  runConvexDev()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
