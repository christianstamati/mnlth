/**
 * Per-deployment settings that are not code: read from `sst.settings.json` at the
 * repo root. Kept out of `sst.config.ts` so the domain, region and per-stage
 * choices change without touching the stack. Only `domain` and `region` are
 * required; everything else falls back to `DEFAULTS`.
 */
import raw from "../sst.settings.json"

export type Removal = "remove" | "retain" | "retain-all"
export type Storage = "volume" | "s3"
export type Database = "sqlite" | "postgres" | "mysql"

/** One value for every stage, or a map keyed by stage with `*` as fallback. */
export type PerStage<T> = T | Record<string, T>

export interface SstSettings {
  /** Base domain every stage hangs off, e.g. `fullstackaws.dev`. */
  domain: string
  /** AWS region for every stage. */
  region: string
  /** Stages whose resources are protected from deletion. */
  protect: string[]
  /** What `sst remove` does with resources. */
  removal: PerStage<Removal>
  /** Where the Convex backend keeps files: the instance volume or S3. */
  storage: PerStage<Storage>
  /** Where the Convex backend keeps its tables: SQLite on the volume or RDS. */
  database: PerStage<Database>
}

/** What `sst.settings.json` gets for every key it leaves out. */
export const DEFAULTS: Omit<SstSettings, "domain" | "region"> = {
  protect: ["production"],
  removal: { production: "retain", "*": "remove" },
  storage: { production: "s3", "*": "volume" },
  database: { production: "mysql", "*": "sqlite" },
}

const REMOVALS: Removal[] = ["remove", "retain", "retain-all"]
const STORAGES: Storage[] = ["volume", "s3"]
const DATABASES: Database[] = ["sqlite", "postgres", "mysql"]

function check(data: unknown): SstSettings {
  const d = data as Partial<SstSettings>
  if (typeof d.domain !== "string" || !d.domain) fail("domain", "a hostname")
  if (typeof d.region !== "string" || !d.region) fail("region", "an AWS region")
  if (d.protect !== undefined && (!Array.isArray(d.protect) || d.protect.some((s) => typeof s !== "string")))
    fail("protect", "a list of stage names")
  checkPerStage("removal", d.removal, REMOVALS)
  checkPerStage("storage", d.storage, STORAGES)
  checkPerStage("database", d.database, DATABASES)
  return { ...DEFAULTS, ...d } as SstSettings
}

function checkPerStage<T extends string>(key: string, value: unknown, allowed: T[]) {
  const expected = allowed.join(" | ")
  if (value === undefined) return
  if (typeof value === "string") {
    if (!allowed.includes(value as T)) fail(key, expected)
  } else if (value && typeof value === "object") {
    for (const [stage, v] of Object.entries(value))
      if (!allowed.includes(v as T)) fail(`${key}.${stage}`, expected)
  } else {
    fail(key, `${expected} or a map of stage to one of those`)
  }
}

function fail(key: string, expected: string): never {
  throw new Error(`sst.settings.json: "${key}" must be ${expected}`)
}

export const settings = check(raw)

/** Resolve a per-stage setting: the stage's own entry, else `*`, else `fallback`. */
export function forStage<T>(value: PerStage<T>, stage: string, fallback: T): T {
  if (typeof value !== "object" || value === null) return value as T
  const map = value as Record<string, T>
  return map[stage] ?? map["*"] ?? fallback
}

/** Whether `stage` is protected from deletion. */
export function isProtected(stage: string): boolean {
  return settings.protect.includes(stage)
}

/** The removal policy for `stage`. */
export function removalFor(stage: string): Removal {
  return forStage(settings.removal, stage, "retain")
}

/** The Convex file storage for `stage`. */
export function storageFor(stage: string): Storage {
  return forStage(settings.storage, stage, "volume")
}

/** The Convex database engine for `stage`. */
export function databaseFor(stage: string): Database {
  return forStage(settings.database, stage, "sqlite")
}
