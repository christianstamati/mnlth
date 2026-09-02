#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
/**
 * The whole app on this machine, no AWS: the self-hosted Convex backend and
 * dashboard in Docker, then `turbo dev` for the functions push on save and
 * Vite on :3000, one TUI pane each.
 *
 *   bun dev            # start everything
 *   bun dev --reset    # wipe the local database and files first
 *   bun dev --down     # stop the containers and exit
 *
 * `docker/docker-compose.yml` is the same stack the EC2 instances run.
 * Locally it gets `docker/.env` (written here, gitignored) and keeps its
 * data in the `data` volume. The admin key the CLI needs is minted by the
 * container from INSTANCE_SECRET, which is generated once and kept in that
 * same .env, so the key survives `docker compose down`.
 */
import { $ } from "bun"

// fileURLToPath, not URL.pathname: on Windows the latter is "/C:/..." and
// neither Docker nor Bun accept it.
const ROOT = fileURLToPath(new URL("..", import.meta.url))
const DOCKER_DIR = join(ROOT, "docker")
const COMPOSE = join(DOCKER_DIR, "docker-compose.yml")
const COMPOSE_ENV = join(DOCKER_DIR, ".env")
const BACKEND_DIR = join(ROOT, "packages", "backend")
const URL_API = "http://127.0.0.1:3210"

const args = process.argv.slice(2)
const compose = (...rest: string[]) =>
  $`docker compose -f ${COMPOSE} --env-file ${COMPOSE_ENV} ${rest}`.cwd(
    DOCKER_DIR
  )

if (args.includes("--down")) {
  await compose("down")
  process.exit(0)
}
if (args.includes("--reset")) {
  await compose("down", "-v")
}

// ---- compose .env ---------------------------------------------------------

if (!existsSync(COMPOSE_ENV)) {
  const secret = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  await Bun.write(
    COMPOSE_ENV,
    [
      "# Written by scripts/dev.ts. Local only; deployed stages keep theirs in SSM.",
      "INSTANCE_NAME=local",
      `INSTANCE_SECRET=${secret}`,
      "DISABLE_BEACON=true",
      "",
    ].join("\n")
  )
}

// ---- backend --------------------------------------------------------------

console.error("Starting the Convex backend and dashboard")
await compose("up", "-d", "--wait")

// generate_admin_key.sh reads INSTANCE_NAME and INSTANCE_SECRET from the
// container's environment. Its last line is the key.
const out = await compose(
  "exec",
  "-T",
  "backend",
  "./generate_admin_key.sh"
).text()
const adminKey = out.trim().split("\n").at(-1) ?? ""
if (!adminKey.includes("|")) {
  console.error(`Unexpected output from generate_admin_key.sh:\n${out}`)
  process.exit(1)
}

// The Convex CLI reads these from .env.local in the project it runs in.
await Bun.write(
  join(BACKEND_DIR, ".env.local"),
  [
    "# Written by scripts/dev.ts. Local backend; never a deployed one.",
    `CONVEX_SELF_HOSTED_URL=${URL_API}`,
    `CONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}`,
    "",
  ].join("\n")
)

console.error(`Backend    ${URL_API}`)
console.error(
  "Dashboard  http://127.0.0.1:6791  (paste the admin key from packages/backend/.env.local)"
)
console.error("Web        http://localhost:3000")

// ---- functions + web ------------------------------------------------------

// Turbo runs both `dev` tasks, `convex dev` in packages/backend and Vite in
// apps/web, in its TUI: one pane each, switch with the arrow keys. It passes
// VITE_CONVEX_URL through (turbo.json globalPassThroughEnv).
const turbo = Bun.spawn(["bunx", "turbo", "dev"], {
  cwd: ROOT,
  env: { ...process.env, VITE_CONVEX_URL: URL_API },
  stdio: ["inherit", "inherit", "inherit"],
})
const stop = () => turbo.kill()
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
process.exit(await turbo.exited)
