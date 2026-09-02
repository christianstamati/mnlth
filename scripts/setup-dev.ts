#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
/**
 * Start the local Convex backend and dashboard in Docker and hand the
 * clients what they need to reach it. Runs as the `setup-dev` task of
 * packages/backend, which every `dev` task depends on (turbo.json), so
 * `bun dev` is enough.
 *
 * `docker/docker-compose.yml` is the same stack the EC2 instances run.
 * Locally it gets `docker/.env` (written here, gitignored) and keeps its
 * data in the `convex-backend_data` volume. The admin key the CLI needs is
 * minted by the container from INSTANCE_SECRET, which is generated once and
 * kept in that same .env, so the key survives `docker compose down`.
 *
 * Writes:
 *   packages/backend/.env.local   CONVEX_SELF_HOSTED_URL, CONVEX_SELF_HOSTED_ADMIN_KEY
 *   apps/web/.env.local           VITE_CONVEX_URL
 *   docker/.env                   NEXT_PUBLIC_ADMIN_KEY, so the dashboard signs in by itself
 *
 * Vite gives real environment variables precedence over .env files, so
 * `sst dev`, which sets VITE_CONVEX_URL to a cloud stage, still wins.
 */
import { $ } from "bun"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const DOCKER_DIR = join(ROOT, "docker")
const COMPOSE = join(DOCKER_DIR, "docker-compose.yml")
const COMPOSE_ENV = join(DOCKER_DIR, ".env")
const URL_API = "http://127.0.0.1:3210"
const BACKEND_ENV = join(ROOT, "packages", "backend", ".env.local")
const WEB_ENV = join(ROOT, "apps", "web", ".env.local")

const compose = (...rest: string[]) =>
  $`docker compose -f ${COMPOSE} --env-file ${COMPOSE_ENV} ${rest}`.cwd(
    DOCKER_DIR
  )

// A new secret invalidates every key minted from the old one.
let freshSecret = false
if (!existsSync(COMPOSE_ENV)) {
  freshSecret = true
  const secret = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  await Bun.write(
    COMPOSE_ENV,
    [
      "# Written by scripts/setup-dev.ts. Local only; deployed stages keep theirs in SSM.",
      "INSTANCE_NAME=local",
      `INSTANCE_SECRET=${secret}`,
      "DISABLE_BEACON=true",
      "",
    ].join("\n")
  )
}

await compose("up", "-d", "--wait")

// Every call to generate_admin_key.sh mints a different key, and every key
// minted from the same secret stays valid, so keep the one already on disk
// unless the secret changed or the file is gone.
const existingKey = existsSync(BACKEND_ENV)
  ? /^CONVEX_SELF_HOSTED_ADMIN_KEY=(.+)$/m.exec(
      await Bun.file(BACKEND_ENV).text()
    )?.[1]
  : undefined

let adminKey = existingKey
if (freshSecret || !adminKey) {
  // The script reads INSTANCE_NAME and INSTANCE_SECRET from the container's
  // environment. Its last line is the key.
  const out = await compose(
    "exec",
    "-T",
    "backend",
    "./generate_admin_key.sh"
  ).text()
  adminKey = out.trim().split("\n").at(-1) ?? ""
  if (!adminKey.includes("|")) {
    console.error(`Unexpected output from generate_admin_key.sh:\n${out}`)
    process.exit(1)
  }
  await Bun.write(
    BACKEND_ENV,
    [
      "# Written by scripts/setup-dev.ts. Local backend; never a deployed one.",
      `CONVEX_SELF_HOSTED_URL=${URL_API}`,
      `CONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}`,
      "",
    ].join("\n")
  )
}

// The dashboard signs in with NEXT_PUBLIC_ADMIN_KEY from its environment.
// Put the key in the compose .env once; the second `up` recreates only the
// dashboard container, and only when that line changed.
const composeEnv = await Bun.file(COMPOSE_ENV).text()
const keyLine = `NEXT_PUBLIC_ADMIN_KEY=${adminKey}`
if (!composeEnv.split("\n").includes(keyLine)) {
  const kept = composeEnv
    .split("\n")
    .filter((line) => !line.startsWith("NEXT_PUBLIC_ADMIN_KEY="))
    .join("\n")
    .replace(/\n*$/, "\n")
  await Bun.write(COMPOSE_ENV, `${kept}${keyLine}\n`)
  await compose("up", "-d", "--wait")
}

await Bun.write(
  WEB_ENV,
  [
    "# Written by scripts/setup-dev.ts. `sst dev` overrides this with a cloud stage.",
    `VITE_CONVEX_URL=${URL_API}`,
    "",
  ].join("\n")
)

console.log(`Backend    ${URL_API}`)
console.log("Dashboard  http://127.0.0.1:6791")
