#!/usr/bin/env bun
/**
 * Copy one stage's Convex data into another stage or the local backend,
 * anonymized on the way, without the source's data or admin key ever
 * reaching this machine.
 *
 *   bun run convex:clone --from production --to <stage|local> [--include-file-storage]
 *
 * The export and the anonymization run in the account, in the CodeBuild
 * project `infra/clone-job.ts` defines (`scripts/clone/cloud.ts` is what
 * the build runs). This script only drives that with the AWS CLI, under
 * the `<app>-clone-developer` policy: start the project, read its log,
 * fetch a snapshot. No access to any stage's parameters.
 *
 *   1. read the bucket and log group from the project definition
 *   2. start a build with the stage names as environment overrides
 *   3. follow the build's log until it ends, printing every line
 *   4. for a stage target, stop here: the import happened in the cloud.
 *      For local, download the anonymized snapshot the build left in the
 *      bucket, import it with `convex import --replace-all` into the
 *      Docker backend, then delete it. Whatever is left expires in a day
 *
 * Production is never a target.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import { APP, convex, isStageName, resolveLocal } from "./lib/stage"

const USAGE =
  "usage: bun run convex:clone --from <stage> --to <stage|local> [--include-file-storage]"
const PROJECT = `${APP}-clone`
const POLL_SECONDS = 5

// ---- arguments ------------------------------------------------------------

const args = process.argv.slice(2)
function option(name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  return value && !value.startsWith("--") ? value : undefined
}
const from = option("--from")
const to = option("--to")
const includeFileStorage = args.includes("--include-file-storage")
if (!from || !to) {
  console.error(USAGE)
  process.exit(2)
}
if (to === "production") {
  console.error("Refusing to import into production.")
  process.exit(2)
}
if (!isStageName(from) || from === to || from === "local") {
  console.error("--from has to be a deployed stage other than --to.")
  process.exit(2)
}
if (to !== "local" && !isStageName(to)) {
  console.error(USAGE)
  process.exit(2)
}

function die(error: Error): never {
  console.error(error.message)
  process.exit(1)
}

function step(message: string) {
  console.log(`\n> ${message}`)
}

if (!Bun.which("aws")) die(new Error("aws is not installed."))

// The local backend before anything happens in the cloud, so a backend that
// is not running fails before a multi-minute export.
const target = to === "local" ? await resolveLocal().catch(die) : undefined

// ---- the project ------------------------------------------------------------

/** Run the AWS CLI and parse its JSON; throws with stderr on failure. */
async function aws<T>(...cliArgs: string[]): Promise<T> {
  const out = await $`aws ${cliArgs} --output json`.quiet().nothrow()
  if (out.exitCode !== 0) {
    throw new Error(
      `aws ${cliArgs.slice(0, 2).join(" ")} failed:\n${out.stderr.toString().trim()}`
    )
  }
  return JSON.parse(out.stdout.toString() || "null") as T
}

interface Project {
  environment: { environmentVariables: { name: string; value: string }[] }
  logsConfig: { cloudWatchLogs: { groupName: string } }
  source: { auth?: { resource?: string } }
}

step(`Resolving the ${PROJECT} project`)
const projects = await aws<{ projects: Project[] }>(
  "codebuild",
  "batch-get-projects",
  "--names",
  PROJECT
).catch(die)
const project = projects.projects[0]
if (!project) {
  die(
    new Error(
      `${PROJECT} does not exist. Has \`sst deploy --stage production\` run?`
    )
  )
}
const bucket = project.environment.environmentVariables.find(
  (v) => v.name === "SNAPSHOT_BUCKET"
)?.value
const logGroup = project.logsConfig.cloudWatchLogs.groupName
if (!bucket || !logGroup) {
  die(new Error(`${PROJECT} has no snapshot bucket or log group.`))
}

// The GitHub connection is created pending and authorized by hand once.
// Say so here rather than a minute into a build. Skipped when the caller
// may not read it.
const connectionArn = project.source.auth?.resource
if (connectionArn) {
  const connection = await aws<{ Connection: { ConnectionStatus: string } }>(
    "codeconnections",
    "get-connection",
    "--connection-arn",
    connectionArn
  ).catch(() => undefined)
  if (connection && connection.Connection.ConnectionStatus !== "AVAILABLE") {
    const region = connectionArn.split(":")[3]
    die(
      new Error(
        `The GitHub connection is ${connection.Connection.ConnectionStatus}, so the build cannot\n` +
          "clone the repository. Authorize it once, in the Console under Developer\n" +
          `Tools > Connections: https://${region}.console.aws.amazon.com/codesuite/settings/connections?region=${region}`
      )
    )
  }
}

// ---- start and follow -------------------------------------------------------

const key = `${from}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.zip`
const overrides = [
  { name: "CLONE_FROM", value: from },
  { name: "CLONE_TO", value: to },
  {
    name: "CLONE_FLAGS",
    value: includeFileStorage ? "--include-file-storage" : "",
  },
  { name: "SNAPSHOT_KEY", value: key },
].map((v) => ({ ...v, type: "PLAINTEXT" }))

interface Build {
  id: string
  buildStatus: string
  currentPhase: string
  logs: { streamName?: string; deepLink?: string }
}

step(`Starting a build: ${from} -> ${to}`)
const started = await aws<{ build: Build }>(
  "codebuild",
  "start-build",
  "--project-name",
  PROJECT,
  "--environment-variables-override",
  JSON.stringify(overrides)
).catch(die)
const buildId = started.build.id
console.log(`  ${buildId}`)

// Poll the build, and between polls print whatever the log has added.
// CodeBuild spends the first minute provisioning before there is a stream.
let build = started.build
let phase = ""
let nextToken: string | undefined
let logStarted = false
while (build.buildStatus === "IN_PROGRESS") {
  await Bun.sleep(POLL_SECONDS * 1000)
  const got = await aws<{ builds: Build[] }>(
    "codebuild",
    "batch-get-builds",
    "--ids",
    buildId
  ).catch(die)
  build = got.builds[0] ?? build
  if (build.currentPhase !== phase && !logStarted) {
    phase = build.currentPhase
    console.log(`  ${phase.toLowerCase()}`)
  }
  const stream = build.logs.streamName
  if (!stream) continue
  const events = await aws<{
    events: { message: string }[]
    nextForwardToken?: string
  }>(
    "logs",
    "get-log-events",
    "--log-group-name",
    logGroup,
    "--log-stream-name",
    stream,
    "--start-from-head",
    ...(nextToken ? ["--next-token", nextToken] : [])
  ).catch(() => undefined)
  if (!events) continue
  if (!logStarted && events.events.length > 0) {
    logStarted = true
    console.log("")
  }
  for (const event of events.events) {
    process.stdout.write(`  ${event.message.trimEnd()}\n`)
  }
  nextToken = events.nextForwardToken ?? nextToken
}

if (build.buildStatus !== "SUCCEEDED") {
  die(
    new Error(
      `The build ended with ${build.buildStatus}.` +
        (build.logs.deepLink ? `\n${build.logs.deepLink}` : "")
    )
  )
}

if (!target) {
  console.log(`\nCloned ${from} -> ${to}.`)
  process.exit(0)
}

// ---- download, import, delete -----------------------------------------------

const workDir = await mkdtemp(join(tmpdir(), "convex-clone-"))
const snapshotZip = join(workDir, "snapshot.zip")
const object = `s3://${bucket}/${key}`
let exitCode = 0
try {
  step("Downloading the anonymized snapshot")
  const copied = await $`aws s3 cp ${object} ${snapshotZip}`.quiet().nothrow()
  if (copied.exitCode !== 0) {
    throw new Error(`aws s3 cp failed:\n${copied.stderr.toString().trim()}`)
  }

  step(`Importing into local (${target.url})`)
  console.log(
    "  The import validates against the schema of the local backend. Run\n" +
      "  `bun dev` on the same commit as the source if they differ."
  )
  const imported = await convex(target, [
    "import",
    "--replace-all",
    "--yes",
    snapshotZip,
  ]).exited
  if (imported !== 0) throw new Error(`convex import exited with ${imported}.`)
  console.log(`\nCloned ${from} -> local.`)
} catch (error) {
  console.error((error as Error).message)
  exitCode = 1
} finally {
  await rm(workDir, { recursive: true, force: true })
  // Whatever happened, do not leave the snapshot around; it expires in a
  // day anyway if this fails.
  await $`aws s3 rm ${object}`.quiet().nothrow()
}
process.exit(exitCode)
