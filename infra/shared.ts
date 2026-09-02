/// <reference path="../.sst/platform/config.d.ts" />

/**
 * The two resources production owns and every other stage borrows: the VPC
 * and the bucket Caddy keeps the wildcard certificate in.
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
  certificateBucket: string
}

const parameterNames = () => ({
  vpcId: `/${$app.name}/shared/vpc-id`,
  certificateBucket: `/${$app.name}/shared/certificate-bucket`,
})

/**
 * Publish the ids of the shared resources. Production only: any other stage
 * calling this would overwrite production's values with its own.
 */
export function publishSharedIds(ids: {
  vpcId: $util.Input<string>
  certificateBucket: $util.Input<string>
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

  new aws.ssm.Parameter("SharedCertificateBucket", {
    name: names.certificateBucket,
    description:
      "The bucket Caddy keeps the wildcard certificate in. Written by production.",
    type: "String",
    value: ids.certificateBucket,
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
  const [vpcId, certificateBucket] = await Promise.all([
    read(names.vpcId),
    read(names.certificateBucket),
  ])
  return { vpcId, certificateBucket }
}

async function read(name: string): Promise<string> {
  try {
    return (await aws.ssm.getParameter({ name })).value
  } catch (cause) {
    throw new Error(
      `Could not read ${name} from SSM. Deploy the production stage first: ` +
        "it creates the VPC and the certificate bucket, and publishes their " +
        "ids there for every other stage to read.",
      { cause }
    )
  }
}
