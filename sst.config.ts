/// <reference path="./.sst/platform/config.d.ts" />

const BASE_DOMAIN = "fullstackaws.dev"
const REGION = "eu-central-1"

export default $config({
  app(input) {
    return {
      name: "mnlth",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: input?.stage === "production",
      home: "aws",
      providers: {
        aws: {
          region: REGION,
        },
      },
    }
  },

  async run() {
    return {}
  },
})
