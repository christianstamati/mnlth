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
  // The SST Console evaluates this function too, when a git push arrives,
  // in a sandbox that holds this file and nothing else: no other file can
  // be imported, and the return value is read without awaiting. So it is
  // synchronous and everything in it is a literal. `sst.settings.json`
  // (domain, storage, database) is only read in `run()`, which checks that
  // its region agrees with the one here.
  app(input) {
    // Fail here, not minutes later inside Route 53. The stage becomes a
    // hostname label and a resource prefix.
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(input.stage))
      throw new Error(
        `Stage "${input.stage}" must be lowercase letters, digits and hyphens, at most 24 characters.`
      )

    const isProd = input.stage === "production"
    return {
      name: "mnlth",
      // `removal` decides what `sst remove` keeps: "retain" leaves the VPC,
      // subnets and any RDS instance behind. `protect` refuses to delete
      // the stage's resources at all.
      removal: isProd ? "retain" : "remove",
      protect: isProd,
      home: "aws",
      providers: {
        aws: {
          region: "eu-central-1",
        },
      },
    }
  },

  console: {
    autodeploy: {
      // Which git events deploy, and to which stage. Branches map here
      // and are skipped when unmapped, so a typo cannot create a stage;
      // pull requests always get `pr-<number>` and are removed on close.
      // Tags never deploy. Manual deploys from the Console skip this.
      //
      // The map is inline, not read from `sst.settings.json`: the Console
      // evaluates `target` on its side from this file alone, before it has
      // a runner with the repo checked out.
      target(event) {
        const branches: Record<string, string> = { main: "production" }
        if (event.type === "branch") {
          // Deleting a branch never removes its stage; that is a decision
          // for a person, not a git event.
          if (event.action !== "pushed") return undefined
          const stage = branches[event.branch]
          return stage ? { stage } : undefined
        }
        if (event.type === "pull_request") {
          return { stage: `pr-${event.number}` }
        }
        return undefined
      },
      runner: {
        engine: "codebuild",
        compute: "medium",
        // node_modules is enough: the Convex images are baked into the AMI
        // and the web bundle is built inside the deploy.
        cache: { paths: ["node_modules"] },
      },
      // The default workflow only runs `sst deploy`. This app also needs the
      // Convex functions pushed once the stage's backend answers, which is
      // what `convex:deploy --wait` does. `SST_STAGE` is set by the runner.
      async workflow({ $, event }) {
        // sst.config.ts reads GITHUB_SHA for the page footer; the runner
        // clones shallowly, so hand it the commit rather than asking git.
        process.env.GITHUB_SHA = event.commit.id
        await $`bun install --frozen-lockfile`
        if (event.action === "removed" || event.action === "remove") {
          await $`bun sst remove`
          return
        }
        await $`bun sst deploy`
        await $`bun convex:deploy --stage ${process.env.SST_STAGE} --wait`
      },
    },
  },

  async run() {
    // Infra files are imported dynamically, not at the top of the file: the
    // `$util` / `aws` / `$app` globals only exist once `run()` is called.
    const { ConvexBackend } = await import("./infra/convex-backend")
    const { publishSharedIds, readSharedIds } = await import("./infra/shared")
    const { settings, storageFor, databaseFor } = await import(
      "./infra/settings"
    )

    const isProd = $app.stage === "production"
    const domain = settings.domain

    // The scripts read the region from `sst.settings.json`; `app()` above
    // has it as a literal. Refuse to deploy if the two drift apart.
    const region = await aws.getRegion().then((r) => r.name)
    if (settings.region !== region)
      throw new Error(
        `sst.settings.json says region "${settings.region}" but sst.config.ts deploys to "${region}"`
      )

    // The commit the bundle was built from, for the footer of every page. CI has it in the environment; a laptop asks git.
    const gitSha =
      process.env.GITHUB_SHA ??
      (await import("node:child_process"))
        .execSync("git rev-parse HEAD")
        .toString()
        .trim()

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
      prefix: isProd ? "" : `${$app.stage}-`,
      // Every stage: the address is known before the instance launches, so
      // the DNS records (30s of Route 53 sync) run alongside the launch
      // instead of after it. An attached address costs the same either way.
      elasticIp: true,
      // No key pair: shell access is `aws ssm start-session` or EC2
      // Instance Connect (see the README). Setting `keyPairId` to an
      // existing pair installs it for ec2-user and opens port 22 to all.
      // Per stage in sst.settings.json.
      storage: storageFor($app.stage),
      database: databaseFor($app.stage),
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
        domain: isProd ? domain : `${$app.stage}.${domain}`,
      },
      environment: {
        VITE_CONVEX_URL: convex.url,
        VITE_STAGE_NAME: $app.stage,
        VITE_GIT_SHA: gitSha,
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
