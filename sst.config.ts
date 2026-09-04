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

// The scripts read the region from this line with `sed`; keep it on its own.
const region = "eu-central-1"

// Base domain every stage hangs off: the apex for production,
// `<stage>.<domain>` for the rest.
const domain = "fullstackaws.dev"

export default $config({
  app(input) {
    // Fail here, not minutes later inside Route 53: the stage becomes a
    // hostname label and a resource prefix. Kept synchronous and import-free
    // so the SST Console can evaluate this function on its own.
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(input.stage))
      throw new Error(
        `Stage "${input.stage}" must be lowercase letters, digits and hyphens, at most 24 characters.`
      )
    return {
      name: "mnlth",
      home: "aws",
      // Production keeps its resources on `sst remove`; other stages go away.
      removal: input.stage === "production" ? "retain" : "remove",
      protect: input.stage === "production",
      providers: { aws: { region } },
    }
  },

  async run() {
    // Infra files are imported dynamically, not at the top of the file: the
    // `$util` / `aws` / `$app` globals only exist once `run()` is called.
    const { ConvexBackend } = await import("./infra/convex-backend")
    const { publishSharedIds, readSharedIds } = await import("./infra/shared")

    const isProduction = $app.stage === "production"

    // ---- shared -----------------------------------------------------------

    // Production creates the VPC, the certificate bucket and the router, and
    // publishes their ids to SSM; every other stage reads them back from
    // there. See `infra/shared.ts`.
    let vpc: sst.aws.Vpc
    let certificateBucket: sst.aws.Bucket
    let router: sst.aws.Router

    if (isProduction) {
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
      certificateBucket = sst.aws.Bucket.get(
        "Certificates",
        shared.certificateBucket
      )
      router = sst.aws.Router.get("Router", shared.routerDistributionId)
    }

    // ---- convex -----------------------------------------------------------

    const convex = new ConvexBackend("Convex", {
      vpc,
      certificateBucket,
      domain,
      // Flat names, so one `*.<domain>` certificate covers every stage.
      prefix: isProduction ? "" : `${$app.stage}-`,
      // Every stage: the address is known before the instance launches, so
      // the DNS records (30s of Route 53 sync) run alongside the launch
      // instead of after it. An attached address costs the same either way.
      elasticIp: true,
      // No key pair: shell access is `aws ssm start-session` or EC2
      // Instance Connect (see the README). Setting `keyPairId` to an
      // existing pair installs it for ec2-user and opens port 22 to all.
      // Where the backend keeps files (`volume` | `s3`) and tables
      // (`sqlite` | `postgres` | `mysql`). Changing either replaces the
      // instance, which loses the data on a `volume` stage.
      storage: "volume",
      database: "sqlite",
      amiId: "ami-0e903f8d9d87a2073",
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
        domain: isProduction ? domain : `${$app.stage}.${domain}`,
      },
      environment: {
        VITE_CONVEX_URL: convex.url,
      },
      dev: { command: "bun run dev" },
    })

    // Flat keys: `deploy.yml` reads webUrl, convexUrl and
    // convexDashboardUrl from `.sst/outputs.json` with jq.
    return {
      webUrl: web.url,
      convexUrl: convex.url,
      convexSiteUrl: convex.siteUrl,
      convexDashboardUrl: convex.dashboardUrl,
      convexAdminKeyParameter: convex.adminKeyParameter,
      instanceId: convex.instanceId,
      publicIp: convex.publicIp,
      vpcId: vpc.id,
      routerDistributionId: router.distributionID,
    }
  },
})
