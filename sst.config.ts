/// <reference path="./.sst/platform/config.d.ts" />

/**
 * A self-hosted Convex backend on one EC2 instance behind Caddy. One instance
 * per stage; production owns the VPC, so deploy that stage first.
 *
 *   bun sst deploy --stage production   ->  api.fullstackaws.dev
 *   bun sst deploy --stage dev          ->  dev-api.fullstackaws.dev
 */

// Domain, region and the per-stage lifecycle policy live in `sst.settings.json`.
// This import is static because `app()` runs before the SST globals exist.
import { settings, isProtected, removalFor } from "./infra/settings"

export default $config({
  app(input) {
    return {
      name: "mnlth",
      // `removal` decides what `sst remove` keeps: SST's default "retain"
      // leaves the VPC, subnets and any RDS instance behind. `protect`
      // refuses to delete the stage's resources at all.
      removal: removalFor(input.stage),
      protect: isProtected(input.stage),
      home: "aws",
      providers: {
        aws: {
          region: settings.region,
        },
      },
    }
  },

  async run() {
    // Infra files are imported dynamically, not at the top of the file: the
    // `$util` / `aws` / `$app` globals only exist once `run()` is called.
    const { ConvexBackend } = await import("./infra/convex-backend")
    const { publishSharedIds, readSharedIds } = await import("./infra/shared")

    const isProd = $app.stage === "production"

    // Production creates the VPC and the certificate bucket and publishes
    // their ids to SSM; every other stage reads them back from there. See
    // `infra/shared.ts`.
    let vpc: sst.aws.Vpc
    let certificateBucket: sst.aws.Bucket

    if (isProd) {
      // Defaults: two AZs, public and private subnets, no NAT gateway. Free.
      vpc = new sst.aws.Vpc("Vpc")

      // Holds the `*.fullstackaws.dev` certificate and its private key. Not
      // public, encrypted at rest by default, and only the instance roles
      // touch it.
      certificateBucket = new sst.aws.Bucket("Certificates")

      publishSharedIds({
        vpcId: vpc.id,
        certificateBucket: certificateBucket.name,
      })
    } else {
      const shared = await readSharedIds()
      vpc = sst.aws.Vpc.get("Vpc", shared.vpcId)
      certificateBucket = sst.aws.Bucket.get(
        "Certificates",
        shared.certificateBucket
      )
    }

    const convex = new ConvexBackend("Convex", {
      vpc,
      certificateBucket,
      domain: settings.domain,
      // Flat names, so one `*.<domain>` certificate covers every stage.
      prefix: isProd ? "" : `${$app.stage}-`,
      // A stable address for production. Other stages follow the instance.
      elasticIp: isProd,
      storage: isProd ? "s3" : "volume",
      database: isProd ? "mysql" : "sqlite",
    })

    return {
      vpcId: vpc.id,
      certificateBucket: certificateBucket.name,
      convexUrl: convex.url,
      convexSiteUrl: convex.siteUrl,
      convexDashboardUrl: convex.dashboardUrl,
      convexAdminKeyParameter: convex.adminKeyParameter,
      instanceId: convex.instanceId,
      publicIp: convex.publicIp,
    }
  },
})
