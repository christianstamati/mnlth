/// <reference path="./.sst/platform/config.d.ts" />

// The Route 53 public hosted zone for this domain must already exist — SST
// looks it up and never creates one. Point the registrar's nameservers at that
// zone, or ACM certificate validation will hang on the first deploy.
const DOMAIN = "fullstackaws.dev"

const PROTECT = true

export default $config({
  app(input) {
    return {
      name: "mnlth",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: PROTECT ? ["production"].includes(input?.stage) : false,
      home: "aws",
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

    const router = isProd
      ? new sst.aws.Router("Router", {
          domain: {
            name: DOMAIN,
            aliases: [`*.${DOMAIN}`],
          },
        })
      : sst.aws.Router.get("Router", await lookupDistribution())

    if (isProd) {
      new aws.ssm.Parameter("RouterDistributionID", {
        name,
        type: "String",
        value: router.distributionID,
      })
    }

    new sst.aws.TanStackStart("Web", {
      path: "apps/web",
      environment: {
        // VITE_ prefixed vars are inlined into the client bundle at build
        // time, so they are public. Never put secrets here.
        VITE_STAGE_NAME: $app.stage,
      },
      router: {
        instance: router,
        domain: isProd ? DOMAIN : `${$app.stage}.${DOMAIN}`,
      },
    })

    return {
      distribution: router.distributionID,
    }

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
