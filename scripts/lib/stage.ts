/**
 * How the scripts find a deployed stage's Convex backend, or the local one.
 *
 * A deployed stage's URL and admin key live in SSM, written by the stack
 * (`/<app>/<stage>/convex/url`) and by the instance a few minutes into its
 * first boot (`.../admin-key`). The local backend's live in
 * `packages/backend/.env.local`, written by `scripts/setup-dev.ts`.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { $ } from "bun"

export const APP = "mnlth"
export const ROOT = fileURLToPath(new URL("../..", import.meta.url))
export const BACKEND_DIR = join(ROOT, "packages", "backend")

/** What the stack writes until the instance publishes the real value. */
export const PENDING = "pending: written by the instance on first boot"

const WAIT_SECONDS = 15 * 60
const POLL_SECONDS = 15

export interface Target {
  url: string
  adminKey: string
}

/** The rule from CLAUDE.md: lowercase, digits and hyphens, at most 24 characters. */
export function isStageName(value: string): boolean {
  return /^[a-z0-9-]{1,24}$/.test(value)
}

export function parameterName(stage: string, key: string): string {
  return `/${APP}/${stage}/convex/${key}`
}

/** Read one SSM parameter, with a hint about the usual cause when missing. */
export async function parameter(name: string): Promise<string> {
  const out =
    await $`aws ssm get-parameter --name ${name} --with-decryption --query Parameter.Value --output text`
      .quiet()
      .nothrow()
  if (out.exitCode !== 0) {
    const stage = name.split("/")[2]
    throw new Error(
      `Could not read ${name}: ${out.stderr.toString().trim()}\n` +
        `Has \`sst deploy --stage ${stage}\` run?`
    )
  }
  return out.stdout.toString().trim()
}

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/version`, {
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Retry `check` until it passes or the budget runs out, with a dotted line. */
async function until(
  check: () => Promise<boolean>,
  waiting: string,
  gaveUp: string
): Promise<void> {
  const deadline = Date.now() + WAIT_SECONDS * 1000
  process.stdout.write(waiting)
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`\nGave up after ${WAIT_SECONDS / 60} minutes. ${gaveUp}`)
    }
    await Bun.sleep(POLL_SECONDS * 1000)
    process.stdout.write(".")
  }
  process.stdout.write("\n")
}

/**
 * A deployed stage's URL and admin key. With `wait`, polls for the key
 * instead of giving up while the placeholder is still there, then for the
 * backend to answer over TLS: the key lands in SSM before Caddy has its
 * certificate, so a push right after it fails on fetch.
 */
export async function resolveStage(
  stage: string,
  options: { wait?: boolean } = {}
): Promise<Target> {
  const url = await parameter(parameterName(stage, "url"))
  const keyName = parameterName(stage, "admin-key")

  let adminKey = await parameter(keyName)
  if (adminKey === PENDING) {
    if (!options.wait) {
      throw new Error(
        `The admin key for ${stage} is not published yet: the backend mints it a few\n` +
          "minutes after its first boot. Retry shortly, or pass --wait."
      )
    }
    await until(
      async () => {
        adminKey = await parameter(keyName)
        return adminKey !== PENDING
      },
      `Waiting for ${stage}'s backend to publish its admin key`,
      "Check the instance's cloud-init log."
    )
  }

  if (!(await answers(url))) {
    if (!options.wait) {
      throw new Error(
        `${url} is not answering yet. Retry shortly, or pass --wait.`
      )
    }
    await until(
      () => answers(url),
      `Waiting for ${url} to answer`,
      "Check Caddy on the instance."
    )
  }

  return { url, adminKey }
}

/** The local Docker backend, as `bun dev` set it up. */
export async function resolveLocal(): Promise<Target> {
  const envFile = join(BACKEND_DIR, ".env.local")
  if (!existsSync(envFile)) {
    throw new Error(
      `${envFile} does not exist. Run \`bun dev\` once to start the local backend.`
    )
  }
  const text = await Bun.file(envFile).text()
  const url = /^CONVEX_SELF_HOSTED_URL=(.+)$/m.exec(text)?.[1]?.trim()
  const adminKey = /^CONVEX_SELF_HOSTED_ADMIN_KEY=(.+)$/m
    .exec(text)?.[1]
    ?.trim()
  if (!url || !adminKey) {
    throw new Error(`${envFile} is missing the self-hosted URL or admin key.`)
  }
  if (!(await answers(url))) {
    throw new Error(
      `${url} is not answering. Is the local backend running? (\`bun dev\`)`
    )
  }
  return { url, adminKey }
}

/** Run the Convex CLI in packages/backend against a target. */
export function convex(target: Target, args: string[]) {
  return Bun.spawn(["bunx", "convex", ...args], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      CONVEX_SELF_HOSTED_URL: target.url,
      CONVEX_SELF_HOSTED_ADMIN_KEY: target.adminKey,
    },
    stdio: ["inherit", "inherit", "inherit"],
  })
}
