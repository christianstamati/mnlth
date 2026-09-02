/// <reference path="./.sst/platform/config.d.ts" />

/**
 * A self-hosted Convex backend on one EC2 instance behind Caddy. One instance
 * per stage; production owns the VPC, so deploy that stage first.
 *
 *   bun sst deploy --stage production   ->  api.fullstackaws.dev
 *   bun sst deploy --stage dev          ->  api.dev.fullstackaws.dev
 */

const BASE_DOMAIN = "fullstackaws.dev"
const REGION = "eu-central-1"

// Production creates the VPC. Every other stage references it by this id,
// pinned by hand after the first production deploy (it is in that deploy's
// `vpcId` output). A constant, not a lookup: production's program never
// changes shape between deploys, and no stage can pick up a stray VPC.
const SHARED_VPC_ID = ""

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
    const domain = isProd ? BASE_DOMAIN : `${$app.stage}.${BASE_DOMAIN}`

    if (!isProd && !SHARED_VPC_ID)
      throw new Error(
        "SHARED_VPC_ID is empty. Deploy the production stage first, then pin its vpcId output in sst.config.ts."
      )

    // Defaults: two AZs, public and private subnets, no NAT gateway. Free.
    const vpc = isProd
      ? new sst.aws.Vpc("Vpc")
      : sst.aws.Vpc.get("Vpc", SHARED_VPC_ID)

    const convex = new ConvexBackend("Convex", {
      vpc,
      domain,
      zone: BASE_DOMAIN,
      letsEncryptStaging: true,
    })

    return {
      vpcId: vpc.id,
      convexUrl: convex.url,
      convexSiteUrl: convex.siteUrl,
      convexDashboardUrl: convex.dashboardUrl,
      convexAdminKeyParameter: convex.adminKeyParameter,
      instanceId: convex.instanceId,
      publicIp: convex.publicIp,
    }
  },
})
