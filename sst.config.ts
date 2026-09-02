/// <reference path="./.sst/platform/config.d.ts" />

const BASE_DOMAIN = "fullstackaws.dev"
const REGION = "eu-central-1"

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
    // `$util` / `aws` / `$app` globals only exist once `run()` is called, and
    // `class HelloWorld extends $util.ComponentResource` reads one of them the
    // moment the module is evaluated.
    const { HelloWorld } = await import("./infra/hello-world")

    const hello = new HelloWorld("Hello", { name: $app.stage })

    return {
      greeting: hello.greeting,
      parameter: hello.parameterName,
    }
  },
})
