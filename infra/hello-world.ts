/// <reference path="../.sst/platform/config.d.ts" />

/**
 * A hello-world custom component.
 *
 * A component is just a Pulumi `ComponentResource`: a class that groups some
 * child resources under one node in the state tree. SST adds two conventions on
 * top of that — a `transform` arg so callers can reach into the children, and a
 * `getSSTLink()` method so the component can be passed to `link: [...]`.
 *
 * This one stores a greeting in SSM Parameter Store, which is free and instant,
 * so you can deploy it and watch the whole lifecycle without spending anything.
 */

export interface HelloWorldArgs {
  /**
   * Who to greet.
   * @default "world"
   */
  name?: $util.Input<string>
  /**
   * Escape hatch: override the args of the underlying resources. Built-in SST
   * components also accept a function here; that needs their internal
   * `transform()` helper, so this one takes a plain object of overrides.
   */
  transform?: {
    parameter?: Partial<aws.ssm.ParameterArgs>
  }
}

// Linking is structural: anything with a `getSSTLink()` method can be linked,
// so there is no interface to implement.
export class HelloWorld extends $util.ComponentResource {
  private readonly parameter: aws.ssm.Parameter

  constructor(
    name: string,
    args: HelloWorldArgs = {},
    opts: $util.ComponentResourceOptions = {}
  ) {
    // `<package>:<module>:<Type>`. The first segment names the *library* the
    // component ships in, not the app consuming it — the same way built-ins are
    // `sst:aws:Bucket` in every project. `workspace` matches the `@workspace/*`
    // scope this repo already uses for shared packages, so the file drops into
    // another project unchanged.
    //
    // Don't prefix it with `sst:`; that namespace is SST's, and it opts you
    // into engine behaviour meant for built-ins. The token is identity in
    // state, so changing it later replaces the resource.
    super("workspace:index:HelloWorld", name, args, opts)

    const greeting = $util
      .output(args.name ?? "world")
      .apply((who) => `Hello, ${who}!`)

    // Children take `{ parent: this }`. That is the whole trick: it is what
    // nests them under the component instead of the stack root.
    this.parameter = new aws.ssm.Parameter(
      `${name}Parameter`,
      {
        // Physical names are not auto-prefixed for custom components the way
        // they are for built-in ones, so scope it by app and stage yourself.
        name: `/${$app.name}/${$app.stage}/hello/${name}`,
        type: "String",
        value: greeting,
        ...args.transform?.parameter,
      },
      { parent: this }
    )

    // Tells the engine the component is done and declares what it exposes.
    this.registerOutputs({
      greeting,
      parameterName: this.parameter.name,
    })
  }

  /** The greeting text, e.g. `Hello, world!`. */
  get greeting(): $util.Output<string> {
    return this.parameter.value
  }

  /** The SSM parameter path the greeting is stored at. */
  get parameterName(): $util.Output<string> {
    return this.parameter.name
  }

  /**
   * The underlying resources, so callers can read anything this component does
   * not surface. Also an SST convention.
   */
  get nodes() {
    return { parameter: this.parameter }
  }

  /**
   * Makes the component usable in `link: [...]`. `properties` become
   * `Resource.<ComponentName>.<key>` at runtime; `include` grants IAM
   * permissions or bindings to whatever links to it.
   */
  getSSTLink() {
    return {
      properties: {
        greeting: this.greeting,
        parameterName: this.parameterName,
      },
      include: [
        sst.aws.permission({
          actions: ["ssm:GetParameter"],
          resources: [this.parameter.arn],
        }),
      ],
    }
  }
}
