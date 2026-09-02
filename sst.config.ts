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

// Production creates the VPC. Every other stage references it by this id,
// pinned by hand after the first production deploy (it is in that deploy's
// `vpcId` output). A constant, not a lookup: production's program never
// changes shape between deploys, and no stage can pick up a stray VPC.
const SHARED_VPC_ID = "vpc-0d792aa9449fef16d"

// Same pattern for the bucket Caddy keeps the wildcard certificate in. The
// name is in production's `certificateBucket` output.
const SHARED_CERTIFICATE_BUCKET = ""

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

    const isProd = $app.stage === "production"

    if (!isProd && !(SHARED_VPC_ID && SHARED_CERTIFICATE_BUCKET))
      throw new Error(
        "SHARED_VPC_ID or SHARED_CERTIFICATE_BUCKET is empty. Deploy the production stage first, then pin its vpcId and certificateBucket outputs in sst.config.ts."
      )

    // Defaults: two AZs, public and private subnets, no NAT gateway. Free.
    const vpc = isProd
      ? new sst.aws.Vpc("Vpc")
      : sst.aws.Vpc.get("Vpc", SHARED_VPC_ID)

    // Holds the `*.fullstackaws.dev` certificate and its private key. Not
    // public, encrypted at rest by default, and only the instance roles
    // touch it.
    const certificateBucket = isProd
      ? new sst.aws.Bucket("Certificates")
      : sst.aws.Bucket.get("Certificates", SHARED_CERTIFICATE_BUCKET)

    const convex = new ConvexBackend("Convex", {
      vpc,
      certificateBucket,
      domain: BASE_DOMAIN,
      // Flat names, so one `*.fullstackaws.dev` certificate covers every stage.
      prefix: isProd ? "" : `${$app.stage}-`,
      letsEncryptStaging: true,
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
