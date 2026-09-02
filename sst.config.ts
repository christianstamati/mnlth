/// <reference path="./.sst/platform/config.d.ts" />

/**
 * A self-hosted Convex backend on one EC2 instance behind Caddy. One instance
 * per stage; production owns the VPC, so deploy that stage first.
 *
 *   bun sst deploy --stage production   ->  api.fullstackaws.dev
 *   bun sst deploy --stage dev          ->  dev-api.fullstackaws.dev
 */

const BASE_DOMAIN = "fullstackaws.dev"
const REGION = "eu-central-1"

export default $config({
  app(input) {
    return {
      name: "mnlth",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
      providers: {
        aws: {
          region: REGION,
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
      domain: BASE_DOMAIN,
      // Flat names, so one `*.fullstackaws.dev` certificate covers every stage.
      prefix: isProd ? "" : `${$app.stage}-`,
      // A stable address for production. Other stages follow the instance.
      elasticIp: isProd,
      // Defaults: SQLite and files on the root volume. Options are
      // storage: "s3" and database: "postgres" | "mysql" | { engine, ... }.
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
