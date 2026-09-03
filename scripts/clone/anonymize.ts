#!/usr/bin/env bun
/**
 * Rewrite an unzipped Convex snapshot export in place so no personal data
 * survives. `scripts/convex-clone.ts` calls `anonymizeExport`; the CLI form
 * is for looking at an export by hand:
 *
 *   bun anonymize.ts <export-dir> --rules <rules.ts> [--include-file-storage]
 *
 * The export directory has one `<table>/documents.jsonl` per table, plus
 * `_tables/` (table numbers, kept) and `_storage/` (file metadata and the
 * files themselves, kept only with --include-file-storage). Each line is one
 * document; it is rewritten line by line, so memory stays flat whatever the
 * table size.
 *
 * Only Bun built-ins, so it runs anywhere bun does.
 */
import { createHmac, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, rename, rm, stat } from "node:fs/promises"
import { join, resolve } from "node:path"

export type Strategy =
  | "keep"
  | "hash"
  | "email"
  | "name"
  | "redact"
  | "remove"
  | "file"
export type TableRule = { drop: true } | { fields: Record<string, Strategy> }
export type Rules = Record<string, TableRule>

// Directories in an export that are not tables.
const SYSTEM_DIRS = new Set(["_tables", "_storage"])

const FIRST_NAMES = [
  "Alex",
  "Sam",
  "Jordan",
  "Taylor",
  "Casey",
  "Riley",
  "Morgan",
  "Jamie",
  "Robin",
  "Avery",
  "Quinn",
  "Drew",
  "Skyler",
  "Reese",
  "Emerson",
  "Rowan",
]
const LAST_NAMES = [
  "Rivera",
  "Okafor",
  "Nguyen",
  "Schmidt",
  "Haddad",
  "Kowalski",
  "Tanaka",
  "Moreau",
  "Silva",
  "Petrov",
  "Andersen",
  "Rossi",
  "Mbeki",
  "Larsen",
  "Iyer",
  "Costa",
]

export interface Options {
  includeFileStorage: boolean
  /** Fixed for tests; a fresh random one per run otherwise. */
  salt?: Buffer
}

/**
 * One salt per run: the same value maps to the same output inside a clone,
 * and to something else in the next one, so two snapshots cannot be joined.
 */
export class Anonymizer {
  private readonly salt: Buffer

  constructor(salt?: Buffer) {
    this.salt = salt ?? randomBytes(32)
  }

  private digest(value: unknown): Buffer {
    const input = typeof value === "string" ? value : JSON.stringify(value)
    return createHmac("sha256", this.salt).update(input).digest()
  }

  hash(value: unknown): string {
    return `anon_${this.digest(value).toString("hex").slice(0, 24)}`
  }

  email(value: unknown): string {
    return `${this.digest(value).toString("hex").slice(0, 16)}@example.com`
  }

  name(value: unknown): string {
    const d = this.digest(value)
    // Two bytes pick the names; 256 combinations is plenty to read as
    // distinct people and cheap enough to be obviously fake.
    return `${FIRST_NAMES[d[0] % FIRST_NAMES.length]} ${LAST_NAMES[d[1] % LAST_NAMES.length]}`
  }

  /** Apply one table's field rules to one document. Mutates and returns it. */
  document(
    doc: Record<string, unknown>,
    fields: Record<string, Strategy>,
    includeFileStorage: boolean
  ): Record<string, unknown> {
    for (const [path, strategy] of Object.entries(fields)) {
      if (path === "_id" || path === "_creationTime") {
        throw new Error(`Rule on ${path}: system fields cannot be rewritten`)
      }
      const keys = path.split(".")
      const last = keys.pop() as string
      let parent: unknown = doc
      for (const key of keys) {
        if (typeof parent !== "object" || parent === null) break
        parent = (parent as Record<string, unknown>)[key]
      }
      if (typeof parent !== "object" || parent === null) continue
      const holder = parent as Record<string, unknown>
      if (!(last in holder)) continue
      const value = holder[last]

      switch (strategy) {
        case "keep":
          break
        case "hash":
          holder[last] = this.hash(value)
          break
        case "email":
          holder[last] = this.email(value)
          break
        case "name":
          holder[last] = this.name(value)
          break
        case "redact":
          holder[last] = "[redacted]"
          break
        case "remove":
          delete holder[last]
          break
        case "file":
          if (!includeFileStorage) delete holder[last]
          break
        default: {
          const never: never = strategy
          throw new Error(`Unknown strategy ${String(never)}`)
        }
      }
    }
    return doc
  }
}

async function rewriteTable(
  dir: string,
  fields: Record<string, Strategy>,
  anonymizer: Anonymizer,
  includeFileStorage: boolean
): Promise<number> {
  const source = join(dir, "documents.jsonl")
  if (!existsSync(source)) return 0
  const target = `${source}.tmp`
  const writer = Bun.file(target).writer()
  let count = 0
  // Bun.file().text() would load the whole table; stream and split on
  // newlines ourselves so a large table costs one line of memory.
  let pending = ""
  const decoder = new TextDecoder()
  for await (const chunk of Bun.file(source).stream()) {
    pending += decoder.decode(chunk, { stream: true })
    let newline = pending.indexOf("\n")
    while (newline !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line.trim()) {
        const doc = anonymizer.document(
          JSON.parse(line),
          fields,
          includeFileStorage
        )
        writer.write(`${JSON.stringify(doc)}\n`)
        count++
      }
      newline = pending.indexOf("\n")
    }
  }
  if (pending.trim()) {
    const doc = anonymizer.document(
      JSON.parse(pending),
      fields,
      includeFileStorage
    )
    writer.write(`${JSON.stringify(doc)}\n`)
    count++
  }
  await writer.end()
  await rename(target, source)
  return count
}

export interface Report {
  rewritten: Record<string, number>
  dropped: string[]
  fileStorage: "kept" | "dropped" | "absent"
}

export async function anonymizeExport(
  exportDir: string,
  rules: Rules,
  options: Options
): Promise<Report> {
  const anonymizer = new Anonymizer(options.salt)
  const report: Report = { rewritten: {}, dropped: [], fileStorage: "absent" }

  const entries = await readdir(exportDir)
  const tables: string[] = []
  for (const entry of entries) {
    if (SYSTEM_DIRS.has(entry)) continue
    if ((await stat(join(exportDir, entry))).isDirectory()) tables.push(entry)
  }

  // Refuse before touching anything: a half-rewritten export is worse than
  // none, and the fix (add a rule) is the same either way.
  const unknown = tables.filter((table) => !(table in rules))
  if (unknown.length > 0) {
    throw new Error(
      `No clone rule for table(s): ${unknown.join(", ")}. ` +
        "Add an entry to packages/backend/clone/rules.ts."
    )
  }

  for (const table of tables) {
    const rule = rules[table]
    const dir = join(exportDir, table)
    if ("drop" in rule) {
      await rm(dir, { recursive: true, force: true })
      report.dropped.push(table)
    } else {
      report.rewritten[table] = await rewriteTable(
        dir,
        rule.fields,
        anonymizer,
        options.includeFileStorage
      )
    }
  }

  const storageDir = join(exportDir, "_storage")
  if (existsSync(storageDir)) {
    if (options.includeFileStorage) {
      report.fileStorage = "kept"
    } else {
      await rm(storageDir, { recursive: true, force: true })
      report.fileStorage = "dropped"
    }
  }

  return report
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const exportDir = args.find((a) => !a.startsWith("--"))
  const rulesIndex = args.indexOf("--rules")
  const rulesPath = rulesIndex === -1 ? undefined : args[rulesIndex + 1]
  if (!exportDir || !rulesPath) {
    console.error(
      "usage: bun anonymize.ts <export-dir> --rules <rules.ts> [--include-file-storage]"
    )
    process.exit(2)
  }
  const { rules } = (await import(resolve(rulesPath))) as { rules: Rules }
  const report = await anonymizeExport(resolve(exportDir), rules, {
    includeFileStorage: args.includes("--include-file-storage"),
  })
  for (const [table, count] of Object.entries(report.rewritten)) {
    console.log(`rewrote ${table}: ${count} documents`)
  }
  for (const table of report.dropped) console.log(`dropped ${table}`)
  console.log(`file storage: ${report.fileStorage}`)
}
