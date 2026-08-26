/// <reference path="./.sst/platform/config.d.ts" />

// CloudFront distribution ID of the Router that the production stage creates.
// Other stages adopt it instead of provisioning their own, since creating a
// distribution costs several minutes. Deploy production first, then copy its
// `router` output here.
const DISTRIBUTION = "E1ZB3K2NLXU17L"

// The Route 53 public hosted zone for this domain must already exist — SST
// looks it up and never creates one. Point the registrar's nameservers at that
// zone, or ACM certificate validation will hang on the first deploy.
const DOMAIN = "fullstackaws.dev"

export default $config({
  app(input) {
    return {
      name: "mnlth",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
    }
  },
  async run() {
    const isProd = $app.stage === "production"

    const router = isProd
      ? new sst.aws.Router("Router", {
          domain: {
            name: DOMAIN,
            aliases: [`*.${DOMAIN}`],
          },
        })
      : sst.aws.Router.get("Router", DISTRIBUTION)

    const web = new sst.aws.TanStackStart("Web", {
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
      url: web.url,
      router: router.distributionID,
    }
  },
})
