/// <reference path="../.sst/platform/config.d.ts" />

/**
 * The one bucket production owns, `<app>-assets`, for what every stage and
 * every tool shares, one prefix each:
 *
 *   certificates/   Caddy's wildcard certificate, its private key, the ACME
 *                   account and the lock it takes before issuing. Every
 *                   stage's instance reads and writes it
 *   snapshots/      anonymized exports on their way to a laptop
 *                   (`bun run convex:clone`), expired after a day
 *
 * Each consumer gets IAM on its own prefix only: a box that can read the
 * certificate cannot read a snapshot, and the clone build cannot touch the
 * private key. Production publishes the bucket's name to SSM
 * (`infra/shared.ts`); the other stages read it back and attach to it.
 */

export const ASSETS = {
  certificates: "certificates",
  snapshots: "snapshots",
} as const

/** The bucket and its lifecycle. Production only; see `sst.config.ts`. */
export function createAssetsBucket(): sst.aws.Bucket {
  // Not public and encrypted at rest, the component's defaults.
  const bucket = new sst.aws.Bucket("Assets", {
    // A fixed, global name (`<app>-assets`) rather than the generated one.
    // After an `sst remove` that retained it, delete it by hand before the
    // next deploy, or the create fails on the name.
    transform: { bucket: { bucket: `${$app.name}-assets` } },
  })

  // Snapshots are for one download; nothing else in the bucket expires.
  new aws.s3.BucketLifecycleConfigurationV2("AssetsLifecycle", {
    bucket: bucket.name,
    rules: [
      {
        id: "expire-snapshots",
        status: "Enabled",
        filter: { prefix: `${ASSETS.snapshots}/` },
        expiration: { days: 1 },
        abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
      },
    ],
  })

  return bucket
}
