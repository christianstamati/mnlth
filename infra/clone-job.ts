/// <reference path="../.sst/platform/config.d.ts" />

/**
 * The cloud half of `bun run convex:clone`, as a CodeBuild project in the
 * account: it clones the repository, runs `scripts/clone/cloud.ts` and either
 * imports into the target stage or drops the anonymized zip under
 * `snapshots/` in the assets bucket for the laptop to fetch. A stage's
 * raw data and admin key never leave AWS.
 *
 * What it builds, once, in production:
 *
 *   - a CodeConnections connection to GitHub. It is created PENDING and
 *     has to be authorized once by hand, in the Console under Developer
 *     Tools > Connections, before the first build can clone the repository
 *   - the project, `<app>-clone`, on a small arm64 Amazon Linux image, with
 *     an inline buildspec that installs bun and runs the script. The stage
 *     names arrive as environment overrides on `start-build`
 *   - the project's role: read every stage's Convex parameters in SSM,
 *     write the snapshots prefix, write its log group, use the connection.
 *     Nothing else; the certificate next door is out of reach
 *   - a managed policy for developers, `<app>-clone-developer`: start and
 *     watch the project, read its logs, get and delete snapshots. Attach it
 *     to a user or group by hand; it grants nothing on production itself
 *
 * `scripts/convex-clone.ts` finds the bucket, the prefix and the log group
 * from the project definition, so the only name it has to know is the
 * project's.
 */

export interface CloneJobArgs {
  /** `owner/name` on GitHub. */
  repository: $util.Input<string>
  /** The branch whose code and anonymization rules run. Default `main`. */
  branch?: $util.Input<string>
  /** The bun the buildspec installs, e.g. `1.4.0`. */
  bunVersion: $util.Input<string>
  /** The assets bucket, and the prefix in it the snapshots go under. */
  bucket: sst.aws.Bucket
  prefix: string
}

export class CloneJob extends $util.ComponentResource {
  public readonly project: aws.codebuild.Project
  public readonly connection: aws.codeconnections.Connection
  public readonly developerPolicy: aws.iam.Policy

  constructor(
    name: string,
    args: CloneJobArgs,
    opts: $util.ComponentResourceOptions = {}
  ) {
    super("workspace:index:CloneJob", name, args, opts)
    const parent = this

    const region = aws.getRegionOutput().region
    const accountId = aws.getCallerIdentityOutput().accountId
    const projectName = `${$app.name}-clone`

    // ---- github -----------------------------------------------------------

    this.connection = new aws.codeconnections.Connection(
      `${name}Connection`,
      { name: `${$app.name}-github`, providerType: "GitHub" },
      { parent }
    )

    // The snapshots, and nothing else in the bucket.
    const snapshots = $util.interpolate`${args.bucket.arn}/${args.prefix}/*`

    // ---- logs -------------------------------------------------------------

    const logGroup = new aws.cloudwatch.LogGroup(
      `${name}Logs`,
      { name: `/aws/codebuild/${projectName}`, retentionInDays: 14 },
      { parent }
    )

    // ---- role -------------------------------------------------------------

    const role = new aws.iam.Role(
      `${name}Role`,
      {
        assumeRolePolicy: aws.iam.getPolicyDocumentOutput({
          statements: [
            {
              actions: ["sts:AssumeRole"],
              principals: [
                { type: "Service", identifiers: ["codebuild.amazonaws.com"] },
              ],
            },
          ],
        }).json,
      },
      { parent }
    )

    new aws.iam.RolePolicy(
      `${name}RolePolicy`,
      {
        role: role.name,
        policy: aws.iam.getPolicyDocumentOutput({
          statements: [
            {
              sid: "ConvexParameters",
              actions: ["ssm:GetParameter"],
              resources: [
                $util.interpolate`arn:aws:ssm:${region}:${accountId}:parameter/${$app.name}/*/convex/*`,
              ],
            },
            {
              sid: "Snapshots",
              actions: ["s3:PutObject"],
              resources: [snapshots],
            },
            {
              sid: "Logs",
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [logGroup.arn, $util.interpolate`${logGroup.arn}:*`],
            },
            {
              // CodeBuild still uses the old namespace for some calls.
              sid: "Repository",
              actions: [
                "codeconnections:GetConnectionToken",
                "codeconnections:GetConnection",
                "codeconnections:UseConnection",
                "codestar-connections:GetConnectionToken",
                "codestar-connections:GetConnection",
                "codestar-connections:UseConnection",
              ],
              resources: [this.connection.arn],
            },
          ],
        }).json,
      },
      { parent }
    )

    // ---- project ----------------------------------------------------------

    // Installs bun, then hands over to the script. `CLONE_TO=local` means
    // "leave the zip for the laptop": the script refuses `local` itself.
    // The image boots Node 18 unless told otherwise; `bunx convex` follows
    // the CLI's shebang to node, and the CLI needs 20 or newer
    // (`engines` in package.json).
    const buildspec = $util.output(args.bunVersion).apply(
      (bun) => `version: 0.2
phases:
  install:
    runtime-versions:
      nodejs: 22
    commands:
      - curl -fsSL https://bun.sh/install | bash -s "bun-v${bun}"
      - export PATH="$HOME/.bun/bin:$PATH"
      - bun install --frozen-lockfile
  build:
    commands:
      - export PATH="$HOME/.bun/bin:$PATH"
      - |
        set -e
        if [ "$CLONE_TO" = local ]; then
          bun scripts/clone/cloud.ts --from "$CLONE_FROM" --to artifact \\
            --out /tmp/snapshot.zip $CLONE_FLAGS
          aws s3 cp /tmp/snapshot.zip "s3://$SNAPSHOT_BUCKET/$SNAPSHOT_KEY"
        else
          bun scripts/clone/cloud.ts --from "$CLONE_FROM" --to "$CLONE_TO" $CLONE_FLAGS
        fi
`
    )

    this.project = new aws.codebuild.Project(
      `${name}Project`,
      {
        name: projectName,
        description:
          "bun run convex:clone: export a stage, anonymize, import or publish a snapshot",
        serviceRole: role.arn,
        buildTimeout: 120,
        source: {
          type: "GITHUB",
          location: $util.interpolate`https://github.com/${args.repository}.git`,
          gitCloneDepth: 1,
          buildspec,
          auth: { type: "CODECONNECTIONS", resource: this.connection.arn },
        },
        sourceVersion: args.branch ?? "main",
        artifacts: { type: "NO_ARTIFACTS" },
        environment: {
          type: "ARM_CONTAINER",
          computeType: "BUILD_GENERAL1_SMALL",
          image: "aws/codebuild/amazonlinux-aarch64-standard:3.0",
          environmentVariables: [
            { name: "SNAPSHOT_BUCKET", value: args.bucket.name },
            { name: "SNAPSHOT_PREFIX", value: args.prefix },
            // Overridden per build by the laptop script.
            { name: "CLONE_FROM", value: "" },
            { name: "CLONE_TO", value: "" },
            { name: "CLONE_FLAGS", value: "" },
            { name: "SNAPSHOT_KEY", value: "" },
          ],
        },
        logsConfig: {
          cloudwatchLogs: { status: "ENABLED", groupName: logGroup.name },
        },
      },
      { parent, dependsOn: [logGroup] }
    )

    // ---- developers -------------------------------------------------------

    this.developerPolicy = new aws.iam.Policy(
      `${name}DeveloperPolicy`,
      {
        name: `${$app.name}-clone-developer`,
        description:
          "Run bun run convex:clone: start the clone project, read its logs, fetch snapshots.",
        policy: aws.iam.getPolicyDocumentOutput({
          statements: [
            {
              sid: "Project",
              actions: [
                "codebuild:StartBuild",
                "codebuild:BatchGetBuilds",
                "codebuild:BatchGetProjects",
              ],
              resources: [this.project.arn],
            },
            {
              sid: "Logs",
              actions: ["logs:GetLogEvents"],
              resources: [$util.interpolate`${logGroup.arn}:*`],
            },
            {
              // So the script can say "pending, authorize it" up front.
              sid: "Connection",
              actions: ["codeconnections:GetConnection"],
              resources: [this.connection.arn],
            },
            {
              sid: "Snapshots",
              actions: ["s3:GetObject", "s3:DeleteObject"],
              resources: [snapshots],
            },
          ],
        }).json,
      },
      { parent }
    )

    this.registerOutputs({
      project: this.project.name,
      connectionArn: this.connection.arn,
      developerPolicyArn: this.developerPolicy.arn,
    })
  }
}
