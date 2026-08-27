/// <reference path="./.sst/platform/config.d.ts" />

// The Route 53 hosted zone must already exist — SST looks it up, never creates it.
const DOMAIN = "fullstackaws.dev"

// The self-hosted Convex backend, as published by docker-compose.yaml.
const CONVEX_LOCAL_URL = "http://127.0.0.1:3210"

export default $config({
  app(input) {
    return {
      name: "mnlth",
      removal: input?.stage === "production" ? "retain" : "remove",
      // Disarm for a single command, e.g.
      // `SST_UNPROTECT=1 bun sst remove --stage production`. An env var, not
      // stored state, so it re-arms by itself.
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

    // Production owns the Router and publishes its distribution ID here; other
    // stages adopt it instead of paying minutes to create their own. Ownership
    // is pinned to production rather than to the first deployer or to whether
    // the parameter exists — either would let a stage delete the distribution
    // out from under the others.
    const path = `/sst/${$app.name}/shared-router`
    const name = `${path}/distribution-id`

    // `sst dev` serves from localhost, so there is no distribution — and the
    // adopt branch would throw when the parameter is missing.
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

    // The whole Convex stack (Postgres, backend, dashboard) runs in Docker, so
    // `sst dev` alone brings the environment up. DevCommands are skipped on deploy.
    const convex = new sst.x.DevCommand("Convex", {
      dev: {
        title: "convex backend",
        command: "docker compose up",
        autostart: true,
      },
    })

    // The CLI needs the backend answering before it can push functions, so this
    // script waits and mints the admin key. dependsOn orders resources, not processes.
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

    new sst.aws.TanStackStart("Frontend", {
      path: "apps/web",
      environment: {
        // VITE_ vars are inlined into the client bundle. Never put secrets here.
        VITE_STAGE_NAME: $app.stage,
        // Deploying Convex itself is still out of scope, so deployed stages read
        // the URL from the environment.
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
      // Query the parent path, not the name — SSM returns nothing for an exact
      // name, and unlike getParameter this returns [] instead of throwing.
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
