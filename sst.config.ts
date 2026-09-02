/// <reference path="./.sst/platform/config.d.ts" />

/**
 * A self-hosted Convex backend on one EC2 instance behind Caddy, and a
 * TanStack Start app on Lambda behind one shared CloudFront distribution.
 * One of each per stage; production owns the shared pieces, so deploy that
 * stage first.
 *
 *   bun sst deploy --stage production   ->  fullstackaws.dev, api.fullstackaws.dev
 *   bun sst deploy --stage dev          ->  dev.fullstackaws.dev, dev-api.fullstackaws.dev
 */

export default $config({
  async app(input) {
    // Domain, region and the per-stage lifecycle policy live in
    // `sst.settings.json`. SST forbids top-level imports in this file.
    const { isProtected, removalFor, settings } = await import("./infra/settings")

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
    const { settings, storageFor, databaseFor } = await import("./infra/settings")

    const isProd = $app.stage === "production"
    const domain = settings.domain

    // ---- shared -----------------------------------------------------------

    // Production creates the VPC, the certificate bucket and the router, and
    // publishes their ids to SSM; every other stage reads them back from
    // there. See `infra/shared.ts`.
    let vpc: sst.aws.Vpc
    let certificateBucket: sst.aws.Bucket
    let router: sst.aws.Router

    if (isProd) {
      // Defaults: two AZs, public and private subnets, no NAT gateway. Free.
      vpc = new sst.aws.Vpc("Vpc")

      // Holds the `*.<domain>` certificate and its private key. Not public,
      // encrypted at rest by default, and only the instance roles touch it.
      certificateBucket = new sst.aws.Bucket("Certificates")

      // One CloudFront distribution for every stage's web app: the apex for
      // production, `<stage>.<domain>` for the rest. The wildcard alias is
      // what lets other stages attach without touching the distribution.
      // Convex's `api.`/`site.`/`dashboard.` hosts are explicit Route 53
      // records, which win over the wildcard.
      router = new sst.aws.Router("Router", {
        domain: { name: domain, aliases: [`*.${domain}`] },
      })

      publishSharedIds({
        vpcId: vpc.id,
        certificateBucket: certificateBucket.name,
        routerDistributionId: router.distributionID,
      })
    } else {
      const shared = await readSharedIds()
      vpc = sst.aws.Vpc.get("Vpc", shared.vpcId)
      certificateBucket = sst.aws.Bucket.get("Certificates", shared.certificateBucket)
      router = sst.aws.Router.get("Router", shared.routerDistributionId)
    }

    // ---- convex -----------------------------------------------------------

    const convex = new ConvexBackend("Convex", {
      vpc,
      certificateBucket,
      domain,
      // Flat names, so one `*.<domain>` certificate covers every stage.
      prefix: isProd ? "" : `${$app.stage}-`,
      // A stable address for production. Other stages follow the instance.
      elasticIp: isProd,
      // Installed for ec2-user at launch and opens port 22 to everyone.
      // Without it, SSH is admitted from EC2 Instance Connect only.
      keyPairId: "key-07ece9db1f187d7dd",
      // Per stage in sst.settings.json.
      storage: storageFor($app.stage),
      database: databaseFor($app.stage),
    })

    // `sst deploy` brings the backend up empty; push the functions by hand
    // with `bun convex:deploy --stage <stage>`.

    // ---- web --------------------------------------------------------------

    // TanStack Start on a streaming Lambda (Nitro's `aws-lambda` preset in
    // apps/web/vite.config.ts), served through the shared router. `sst dev`
    // runs Vite locally instead, with the same environment, so the local app
    // talks to this stage's deployed backend.
    const web = new sst.aws.TanStackStart("Web", {
      path: "apps/web",
      router: {
        instance: router,
        domain: isProd ? domain : `${$app.stage}.${domain}`,
      },
      environment: {
        VITE_CONVEX_URL: convex.url,
      },
      dev: { command: "bun run dev" },
    })

    return {
      vpcId: vpc.id,
      certificateBucket: certificateBucket.name,
      routerDistributionId: router.distributionID,
      webUrl: web.url,
      convexUrl: convex.url,
      convexSiteUrl: convex.siteUrl,
      convexDashboardUrl: convex.dashboardUrl,
      convexAdminKeyParameter: convex.adminKeyParameter,
      instanceId: convex.instanceId,
      publicIp: convex.publicIp,
    }
  },
})
