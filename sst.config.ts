/// <reference path="./.sst/platform/config.d.ts" />

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
    const web = new sst.aws.TanStackStart("MyWeb", {
      path: "apps/web",
    })

    return {
      url: web.url,
    }
  },
})
