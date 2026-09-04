#!/usr/bin/env bun
/**
 * The cloud half of `convex:clone`: export one stage, anonymize, then
 * either import into another stage or leave the anonymized zip on disk for
 * the workflow to upload as an artifact. `.github/workflows/clone.yml` runs
 * this on a GitHub-hosted runner with the AWS role; the laptop never sees
 * the source's admin key or its raw export (`scripts/convex-clone.ts`).
 *
 *   bun scripts/clone/cloud.ts --from <stage> --to <stage> [--include-file-storage]
 *   bun scripts/clone/cloud.ts --from <stage> --to artifact --out <zip> [--include-file-storage]
 *
 * The steps, all in a temporary directory that is removed at the end
 * whatever happens:
 *
 *   1. `convex export` from the source, with the files in file storage
 *      only when asked
 *   2. unzip, rewrite every table per `packages/backend/clone/rules.ts`
 *      (`./anonymize.ts`), zip again. A table without a rule stops the
 *      clone before anything is imported
 *   3. `convex import --replace-all` into the target, so it ends up holding
 *      the source's tables and nothing else; or, with `--to artifact`, move
 *      the zip to `--out`
 *
 * Production is never a target. Both ends come from SSM (`../lib/stage.ts`).
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { $ } from "bun"
import type { Target } from "../lib/stage"
import { convex, isStageName, resolveStage } from "../lib/stage"
import { anonymizeExport } from "./anonymize"

const USAGE =
  "usage: bun scripts/clone/cloud.ts --from <stage> --to <stage|artifact> [--out <zip>] [--include-file-storage]"

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
const out = option("--out")
const includeFileStorage = args.includes("--include-file-storage")
if (!from || !to) {
  console.error(USAGE)
  process.exit(2)
}
if (to === "production") {
  console.error("Refusing to import into production.")
  process.exit(2)
}
if (!isStageName(from) || from === to) {
  console.error("--from has to be a deployed stage other than --to.")
  process.exit(2)
}
// "local" never reaches this script: the workflow maps it to "artifact".
if (to === "artifact" ? !out : !isStageName(to) || to === "local") {
  console.error(USAGE)
  process.exit(2)
}

function die(error: Error): never {
  console.error(error.message)
  process.exit(1)
}

// Progress goes to stdout; stderr is for failures only, so a terminal that
// colors stderr does not paint the normal run red.
function step(message: string) {
  console.log(`\n> ${message}`)
}

for (const tool of ["aws", "zip", "unzip"]) {
  if (!Bun.which(tool)) die(new Error(`${tool} is not installed.`))
}

// ---- resolve both ends first ------------------------------------------------

// The target before the source, so a target that is not up fails before a
// multi-minute export.
let target: Target | undefined
if (to !== "artifact") {
  step(`Resolving target ${to}`)
  target = await resolveStage(to).catch(die)
  console.log(`  ${target.url}`)
}

step(`Resolving source ${from}`)
const source = await resolveStage(from).catch(die)
console.log(`  ${source.url}`)

// ---- export, anonymize, import ----------------------------------------------

const workDir = await mkdtemp(join(tmpdir(), "convex-clone-"))
const rawZip = join(workDir, "raw.zip")
const rawDir = join(workDir, "raw")
const snapshotZip = join(workDir, "snapshot.zip")
let exitCode = 0

try {
  step(
    `Exporting from ${from}` +
      (includeFileStorage ? " (with file storage)" : "")
  )
  const exportArgs = ["export", "--path", rawZip]
  if (includeFileStorage) exportArgs.push("--include-file-storage")
  const exported = await convex(source, exportArgs).exited
  if (exported !== 0) throw new Error(`convex export exited with ${exported}.`)

  step("Anonymizing")
  // The backend writes zeroed timestamps into its zips; unzip extracts them
  // fine but exits 1 or 2 with warnings. The layout check right after is
  // what matters.
  const unzipped = await $`unzip -q ${rawZip} -d ${rawDir}`.quiet().nothrow()
  if (unzipped.exitCode > 2) {
    throw new Error(`unzip failed:\n${unzipped.stderr.toString().trim()}`)
  }
  if (!(await Bun.file(join(rawDir, "_tables", "documents.jsonl")).exists())) {
    throw new Error("The export does not look like a snapshot: no _tables.")
  }
  await rm(rawZip)

  const { rules } = await import("../../packages/backend/clone/rules")
  const report = await anonymizeExport(rawDir, rules, {
    includeFileStorage,
  })
  for (const [table, count] of Object.entries(report.rewritten)) {
    console.log(`  ${table}: ${count} documents`)
  }
  for (const table of report.dropped) console.log(`  ${table}: dropped`)
  console.log(`  file storage: ${report.fileStorage}`)

  const zipped = await $`zip -qr ${snapshotZip} .`.cwd(rawDir).quiet().nothrow()
  if (zipped.exitCode !== 0) {
    throw new Error(`zip failed:\n${zipped.stderr.toString().trim()}`)
  }
  await rm(rawDir, { recursive: true, force: true })

  if (target) {
    step(`Importing into ${to} (${target.url})`)
    console.log(
      "  The import validates against the schema deployed there. Push the same\n" +
        "  commit first if the two stages differ."
    )
    const imported = await convex(target, [
      "import",
      "--replace-all",
      "--yes",
      snapshotZip,
    ]).exited
    if (imported !== 0) {
      throw new Error(`convex import exited with ${imported}.`)
    }
    console.log(`\nCloned ${from} -> ${to}.`)
  } else {
    const outPath = resolve(out as string)
    step(`Writing anonymized snapshot to ${outPath}`)
    // A copy, not a rename: the temp dir may be on another filesystem.
    await Bun.write(outPath, Bun.file(snapshotZip))
    console.log(`\nExported ${from}, anonymized.`)
  }
} catch (error) {
  console.error((error as Error).message)
  exitCode = 1
} finally {
  await rm(workDir, { recursive: true, force: true })
}
process.exit(exitCode)
