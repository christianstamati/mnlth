/**
 * Per-deployment settings that are not code: read from `sst.settings.json` at the
 * repo root. Kept out of `sst.config.ts` so the domain, region and lifecycle
 * policy change without touching the stack.
 */
import raw from "../sst.settings.json"

export type Removal = "remove" | "retain" | "retain-all"

export interface SstSettings {
  /** Base domain every stage hangs off, e.g. `fullstackaws.dev`. */
  domain: string
  /** AWS region for every stage. */
  region: string
  /** Stages whose resources are protected from deletion. */
  protect: string[]
  /**
   * What `sst remove` does with resources, either one policy for every stage
   * or a map keyed by stage, with `*` as the fallback.
   */
  removal: Removal | Record<string, Removal>
}

const REMOVALS: Removal[] = ["remove", "retain", "retain-all"]

function check(data: unknown): SstSettings {
  const d = data as Partial<SstSettings>
  if (typeof d.domain !== "string" || !d.domain) fail("domain", "a hostname")
  if (typeof d.region !== "string" || !d.region) fail("region", "an AWS region")
  if (!Array.isArray(d.protect) || d.protect.some((s) => typeof s !== "string"))
    fail("protect", "a list of stage names")
  if (typeof d.removal === "string") {
    if (!REMOVALS.includes(d.removal)) fail("removal", REMOVALS.join(" | "))
  } else if (d.removal && typeof d.removal === "object") {
    for (const [stage, value] of Object.entries(d.removal))
      if (!REMOVALS.includes(value)) fail(`removal.${stage}`, REMOVALS.join(" | "))
  } else {
    fail("removal", `${REMOVALS.join(" | ")} or a map of stage to one of those`)
  }
  return d as SstSettings
}

function fail(key: string, expected: string): never {
  throw new Error(`sst.settings.json: "${key}" must be ${expected}`)
}

export const settings = check(raw)

/** Whether `stage` is protected from deletion. */
export function isProtected(stage: string): boolean {
  return settings.protect.includes(stage)
}

/** The removal policy for `stage`. */
export function removalFor(stage: string): Removal {
  if (typeof settings.removal === "string") return settings.removal
  return settings.removal[stage] ?? settings.removal["*"] ?? "retain"
}
