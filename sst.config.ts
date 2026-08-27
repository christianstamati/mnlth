/// <reference path="./.sst/platform/config.d.ts" />

// The Route 53 public hosted zone for this domain must already exist — SST
// looks it up and never creates one. Point the registrar's nameservers at that
// zone, or ACM certificate validation will hang on the first deploy.
const DOMAIN = "fullstackaws.dev"

// The self-hosted Convex backend, as published by docker-compose.yaml.
const CONVEX_LOCAL_URL = "http://127.0.0.1:3210"

export default $config({
  app(input) {
    return {
      name: "mnlth",
      removal: input?.stage === "production" ? "retain" : "remove",
      // Disarm for a single command with SST_UNPROTECT=1, e.g.
      // `SST_UNPROTECT=1 bun sst remove --stage production`. Deliberately an env
      // var rather than stored state: a guard you can persist is one you can
      // disarm and forget, and CI would inherit it. This re-arms by itself.
      protect:
        process.env.SST_UNPROTECT !== "1" && input?.stage === "production",
      home: "aws",
      providers: {
        aws: {
          region: "eu-central-1", // set to your desired region
          // profile: "<YOUR_AWS_PROFILE>", // set to your desired AWS profile
        },
      },
    }
  },
  async run() {
    const isProd = $app.stage === "production"

    // Production owns the Router and publishes its distribution ID here; every
    // other stage adopts that distribution instead of provisioning its own,
    // since creating one costs several minutes.
    //
    // Ownership stays pinned to production rather than going to whichever stage
    // deploys first: the owner's state holds the distribution, so a stage that
    // created it would destroy it on `sst remove` — and non-prod stages are
    // `removal: "remove"`. Branching on ownership rather than on whether the
    // parameter exists also keeps production stable, since an existence check
    // would send it down the adopt branch on its second deploy and delete the
    // distribution out from under every other stage.
    const path = `/sst/${$app.name}/shared-router`
    const name = `${path}/distribution-id`

    // `sst dev` serves the site from localhost, so no distribution is involved.
    // Skipping it there also keeps local development from depending on
    // production: the adopt branch throws when the parameter is missing.
    const router = $dev
      ? undefined
      : isProd
        ? new sst.aws.Router("Router", {
            domain: {
              name: DOMAIN,
              aliases: [`*.${DOMAIN}`],
            },
          })
        : sst.aws.Router.get("Router", await lookupDistribution())

    if (router && isProd) {
      new aws.ssm.Parameter("RouterDistributionID", {
        name,
        type: "String",
        value: router.distributionID,
      })
    }

    // Local development runs the whole Convex stack in Docker — Postgres, the
    // self-hosted backend, and the dashboard — so `sst dev` is the only command
    // needed to bring the environment up. Both are dev-only: SST skips
    // DevCommand entirely on `sst deploy`.
    const convex = new sst.x.DevCommand("Convex", {
      dev: {
        title: "convex backend",
        command: "docker compose up",
        autostart: true,
      },
    })

    // The CLI needs the backend answering before it can push functions, so this
    // goes through a script that waits and mints the admin key on first run.
    // dependsOn only orders the resources, not the processes.
    new sst.x.DevCommand(
      "ConvexFunctions",
      {
        dev: {
          title: "convex dev",
          command: "bun scripts/convex-dev.ts",
          autostart: true,
        },
      },
      { dependsOn: [convex] }
    )

    new sst.aws.TanStackStart("Web", {
      path: "apps/web",
      environment: {
        // VITE_ prefixed vars are inlined into the client bundle at build
        // time, so they are public. Never put secrets here.
        VITE_STAGE_NAME: $app.stage,
        // Only the local backend exists today — deploying Convex itself (EC2 +
        // a managed Postgres) is still out of scope, so deployed stages read the
        // URL from the environment rather than hardcoding one that isn't up.
        VITE_CONVEX_URL: $dev
          ? CONVEX_LOCAL_URL
          : (process.env.CONVEX_URL ?? ""),
      },
      router: router && {
        instance: router,
        domain: isProd ? DOMAIN : `${$app.stage}.${DOMAIN}`,
      },
    })

    return router ? { distribution: router.distributionID } : {}

    async function lookupDistribution() {
      // Query the parent path, not the parameter name — SSM returns nothing
      // when the path is an exact name. Unlike getParameter, this returns an
      // empty list rather than throwing, so a missing Router can't be confused
      // with a credentials failure.
      const { values } = await aws.ssm.getParametersByPath({ path })
      const id = values.at(0)
      if (!id) {
        throw new Error(
          `No shared Router at ${name}. Deploy production first: sst deploy --stage production`
        )
      }
      return id
    }
  },
})
