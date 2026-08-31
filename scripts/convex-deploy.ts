#!/usr/bin/env bun
// Pushes packages/backend/convex to a deployed stage's self-hosted backend.
//
// `convex deploy` wants CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY.
// Locally scripts/convex-dev.ts mints the key from the container and caches it
// in packages/backend/.env.local; on a deployed stage bootstrap.sh publishes it
// to SSM at boot and this reads it back, so pushing functions never means
// opening a shell on the box.
//
//   bun scripts/convex-deploy.ts --stage production
//
// Without --stage it uses .sst/stage, the personal stage `sst dev` writes.
// Nothing is cached: the key stays in this process and its child.

import { spawn, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const backendDir = join(root, "packages", "backend")

// The app name comes from the same package.json SST reads it from, so the
// parameter paths cannot drift from the ones sst.config.ts writes.
const app = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  .name as string

function personalStage() {
  try {
    return readFileSync(join(root, ".sst", "stage"), "utf8").trim()
  } catch {
    return ""
  }
}

// Everything that is not --stage is handed to `convex deploy` untouched.
const argv = process.argv.slice(2)
const stageFlag = argv.indexOf("--stage")
const stage = stageFlag === -1 ? personalStage() : argv[stageFlag + 1]
const rest =
  stageFlag === -1
    ? argv
    : [...argv.slice(0, stageFlag), ...argv.slice(stageFlag + 2)]

if (!stage) {
  console.error(
    "No stage. Pass --stage <name>, or run `sst dev` once to set a personal one."
  )
  process.exit(1)
}

// The AWS CLI rather than an SDK dependency: deploying this repo already means
// having it configured, and it is what the instance itself uses.
function parameter(name: string, decrypt: boolean) {
  const result = spawnSync(
    "aws",
    [
      "ssm",
      "get-parameter",
      "--name",
      `/${app}/${stage}/convex/${name}`,
      ...(decrypt ? ["--with-decryption"] : []),
      "--query",
      "Parameter.Value",
      "--output",
      "text",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  )
  if (result.error) {
    throw new Error(
      `Could not run the AWS CLI: ${result.error.message}. It is how this script reads the deployment's credentials.`
    )
  }
  if (result.status !== 0) {
    throw new Error(
      `No /${app}/${stage}/convex/${name} in SSM. Deploy the stage first: bunx sst deploy --stage ${stage}\n${result.stderr.trim()}`
    )
  }
  return result.stdout.trim()
}

// Stands in for `exec`: hand the terminal to `convex deploy`, forward the
// signals used to shut it down, and exit with whatever it exits with. The two
// variables go in the child's environment rather than a file — the CLI reads
// .env.local with dotenv's default, which does not overwrite what is already
// set, so these win over the local deployment cached there.
function runConvexDeploy(url: string, adminKey: string) {
  const child = spawn("bun", ["run", "--cwd", backendDir, "deploy", ...rest], {
    stdio: "inherit",
    env: {
      ...process.env,
      CONVEX_SELF_HOSTED_URL: url,
      CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
    },
  })
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
  const url = parameter("url", false)
  const adminKey = parameter("admin-key", true)

  // The placeholder sst.config.ts creates the parameter with. The real key only
  // lands once the backend reports healthy, which on a first boot is minutes
  // after the deploy returned — longer while it pulls the images.
  if (adminKey.startsWith("pending:")) {
    throw new Error(
      `The admin key for ${stage} has not been published yet. bootstrap.sh writes it once the backend reports healthy.`
    )
  }

  console.log(`Deploying packages/backend/convex to ${url}`)
  runConvexDeploy(url, adminKey)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
