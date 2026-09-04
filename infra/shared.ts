/// <reference path="../.sst/platform/config.d.ts" />

/**
 * The resources production owns and every other stage borrows: the VPC, the
 * shared data bucket (`infra/shared-data.ts`: Caddy's wildcard certificate,
 * clone snapshots) and the CloudFront distribution (`sst.aws.Router`) every
 * stage's web app hangs off.
 *
 * Production publishes their ids to SSM as part of its own stack; the other
 * stages read them back when they deploy. Nothing is pinned by hand, so a
 * production deploy that replaces the VPC needs no follow-up edit, and a
 * teardown takes the parameters with it (`removal: "retain"` does not cover
 * SSM) — a stage deployed against a torn-down production then fails with the
 * message below, instead of resolving a VPC that no longer exists.
 */

/** What production publishes, and every other stage reads. */
export interface SharedIds {
  vpcId: string
  sharedDataBucket: string
  routerDistributionId: string
}

const parameterNames = () => ({
  vpcId: `/${$app.name}/shared/vpc-id`,
  sharedDataBucket: `/${$app.name}/shared/data-bucket`,
  routerDistributionId: `/${$app.name}/shared/router-distribution-id`,
})

/**
 * Publish the ids of the shared resources. Production only: any other stage
 * calling this would overwrite production's values with its own.
 */
export function publishSharedIds(ids: {
  vpcId: $util.Input<string>
  sharedDataBucket: $util.Input<string>
  routerDistributionId: $util.Input<string>
}) {
  const names = parameterNames()

  // `overwrite` so a parameter left behind by an earlier build — one that
  // this stage's state no longer knows about — is adopted rather than
  // failing the deploy with ParameterAlreadyExists.
  new aws.ssm.Parameter("SharedVpcId", {
    name: names.vpcId,
    description:
      "The VPC every stage of this app shares. Written by production.",
    type: "String",
    value: ids.vpcId,
    overwrite: true,
  })

  new aws.ssm.Parameter("SharedDataBucket", {
    name: names.sharedDataBucket,
    description:
      "The bucket every stage shares: Caddy's certificate, clone snapshots. Written by production.",
    type: "String",
    value: ids.sharedDataBucket,
    overwrite: true,
  })

  new aws.ssm.Parameter("SharedRouterDistributionId", {
    name: names.routerDistributionId,
    description:
      "The CloudFront distribution every stage's web app is routed through. Written by production.",
    type: "String",
    value: ids.routerDistributionId,
    overwrite: true,
  })
}

/**
 * Read the ids production published. Runs at deploy time, so it needs AWS
 * credentials for the app's region and a production stage that has been
 * deployed at least once.
 */
export async function readSharedIds(): Promise<SharedIds> {
  const names = parameterNames()
  const [vpcId, sharedDataBucket, routerDistributionId] = await Promise.all([
    read(names.vpcId),
    read(names.sharedDataBucket),
    read(names.routerDistributionId),
  ])
  return { vpcId, sharedDataBucket, routerDistributionId }
}

async function read(name: string): Promise<string> {
  try {
    return (await aws.ssm.getParameter({ name })).value
  } catch (cause) {
    throw new Error(
      `Could not read ${name} from SSM. Deploy the production stage first: ` +
        "it creates the VPC, the shared data bucket and the router, and " +
        "publishes their ids there for every other stage to read.",
      { cause }
    )
  }
}
