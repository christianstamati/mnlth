/// <reference path="./.sst/platform/config.d.ts" />

/**
 * A TanStack Start frontend on CloudFront and a self-hosted Convex backend on
 * one EC2 instance behind Caddy, backed by RDS Postgres and S3. One instance
 * and one database per stage; production owns the shared VPC and Postgres
 * server, so deploy that stage first.
 *
 *   bun sst deploy --stage production   ->  fullstackaws.dev, api.fullstackaws.dev
 *   bun sst deploy --stage dev          ->  dev.fullstackaws.dev, api.dev.fullstackaws.dev
 */

const BASE_DOMAIN = "fullstackaws.dev"
const REGION = "eu-central-1"

// The backend as docker-compose.yaml at the repo root publishes it on a
// laptop. `sst dev` runs that stack rather than the deployed one, so the
// frontend points here instead of at the instance.
const CONVEX_LOCAL_URL = "http://127.0.0.1:3210"

// Pinned so a replaced instance runs the stack it was tested against, not
// whatever shipped that morning. Bump with care: the backend migrates the
// database in place on start, and there is no going back once it has.
// https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/upgrading.md
//
// Backend and dashboard are released together, so one tag covers both. The
// current `latest` is the org.opencontainers.image.revision label from:
//
//   docker buildx imagetools inspect ghcr.io/get-convex/convex-backend:latest \
//     --format '{{ json (index .Image "linux/arm64").Config.Labels }}'
//
// Not the same id as the repo's `precompiled-*` release tags.
const CONVEX_IMAGE_TAG = "c0cb7ae17f54e14846c243c5332a8a5e6d0e19d4" // = latest on 2026-08-28
const COMPOSE_PLUGIN_VERSION = "v5.5.0"

// The stack lives in its own repo; this points at its raw content on `main`.
// The instance fetches bootstrap.sh and docker-compose.yaml from here at
// boot, so it runs the same stack as a laptop; everything stage-specific is
// passed as environment below. The repo has to stay public, since the curls
// carry no credentials, and the `main` ref means a replaced instance picks
// up current main. Swap in a commit SHA when a deployment has to be
// reproducible. Caddy's image tag is pinned in the repo's
// docker-compose.yaml.
const SELF_HOSTED_CONVEX_REPO =
  "https://raw.githubusercontent.com/christianstamati/self-hosted-convex/main"

export default $config({
  app(input) {
    return {
      name: "mnlth",
      // SST's stock pattern. `protect` refuses `sst remove --stage
      // production` outright. `retain` covers the resources that hold data
      // or that other stages share, meaning the VPC, its subnets, and the
      // RDS instance, subnet group and parameter group.
      //
      // Tearing production down is therefore a deliberate edit rather than a
      // flag. Set both to false here, deploy once so the new policy and the
      // RDS deletionProtection below reach state and AWS, then remove. That
      // deploy is the step worth not skipping. `retain` drops resources from
      // state without calling AWS, so a removal without it reports success
      // and leaves a VPC and a live database behind, and the shared-VPC
      // guard in run() then refuses to deploy past the wreckage.
      // docs/deployment-removal.md has the full list of what survives.
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
    const isProd = $app.stage === "production"

    // Production takes the apex; every other stage nests under its own name,
    // so records never collide. Keyed on the stage, not `$dev`, which would
    // give every deployed stage the apex.
    const domain = isProd ? BASE_DOMAIN : `${$app.stage}.${BASE_DOMAIN}`

    // One hostname per port the Convex container group exposes.
    const convexDomain = {
      api: `api.${domain}`,
      site: `site.${domain}`,
      dashboard: `dashboard.${domain}`,
    }

    // Looked up, not hardcoded, so this works in any account holding the zone.
    const zone = aws.route53.getZoneOutput({
      name: BASE_DOMAIN,
      privateZone: false,
    })

    // ---- shared network and database ---------------------------------------

    // The VPC and the Postgres server are per-app, not per-stage: bootstrap.sh
    // creates a database named after INSTANCE_NAME in whatever server it is
    // pointed at, so one server holds every stage. Production always
    // constructs both; every other stage only references them, because SST
    // state is per-stage and cannot share resources directly.
    //
    // Ownership is fixed by stage, not probed at deploy time. A does-it-exist
    // probe flips the owning stage from `new` to `.get` on its own second
    // deploy, and the two branches do not line up child-for-child: the ref
    // branch names the internet gateway differently, declares no route-table
    // associations, and drops the Secrets Manager secret every stage reads
    // the database password from. Pulumi would start deleting live shared
    // infrastructure. What production does instead is refuse to deploy when
    // it finds shared infrastructure it does not own. See the guard below.
    //
    // Hence the order: production deploys first and is removed last. RDS
    // takes ~10 minutes; other stages fail fast below until it exists.
    const sharedName = $app.name
    const sharedDatabaseId = `${$app.name}-postgres`

    // The one record of which VPC production owns, and the only thing that
    // separates a live shared VPC from a carcass. `retain` leaves the VPC
    // and its subnets in AWS but drops them from state, tags and all. SSM
    // parameters are not on the retain list, so the marker goes with the
    // state, and its absence next to a tagged VPC is exactly the
    // "state lost, resources kept" case.
    const sharedVpcIdParameter = `/${$app.name}/shared/vpc-id`

    // SST names resources `<app>-<stage>-<resource>` through a Name tag, but
    // only when the resource has no tags of its own. These tags do both jobs:
    // mark the VPC as shared for the lookup below, and keep the stage out of
    // names every stage will use. Merged rather than replaced, and Vpc.get
    // refuses a VPC whose `sst:ref-version` tag went missing.
    type Taggable = {
      tags?: $util.Input<Record<string, $util.Input<string>>>
    }

    const sharedTag =
      (name: string) =>
      (args: Taggable): undefined => {
        args.tags = {
          ...(args.tags as Record<string, string> | undefined),
          "sst:shared": sharedName,
          Name: name,
        }
      }

    // Every stage resolves the shared VPC through the same tag, and both
    // branches below treat more than one match as an error rather than
    // picking arbitrarily.
    const [taggedVpcIds, ownedVpcId] = await Promise.all([
      aws.ec2
        .getVpcs({
          filters: [{ name: "tag:sst:shared", values: [sharedName] }],
        })
        .then(({ ids }) => ids),
      aws.ssm
        .getParameter({ name: sharedVpcIdParameter })
        .then(({ value }) => value)
        .catch(() => undefined),
    ])

    // Production cannot answer "one already exists" by switching to Vpc.get:
    // the probe would find its own VPC on the very next deploy, flip the
    // branch, and hand Pulumi a program that no longer declares the subnets
    // and route tables it is managing. So it refuses instead. A tag alone
    // cannot say who owns what, since a carcass carries the same tags the
    // live VPC does; the marker can.
    if (isProd) {
      const strays = taggedVpcIds.filter((id) => id !== ownedVpcId)
      if (strays.length > 0)
        throw new Error(
          `Found ${strays.length} VPC(s) tagged sst:shared=${sharedName} that this stage does not own: ${strays.join(", ")}. ` +
            (ownedVpcId
              ? `Production owns ${ownedVpcId}.`
              : `${sharedVpcIdParameter} is missing, so production's state owns no VPC at all: a teardown dropped it from state and left it in AWS.`) +
            ` Deploying now would add yet another VPC with the same tags. Delete the stray VPC(s) and their subnets, or import them into this stage's state, then deploy again.`
        )
    }

    // No NAT gateway: the backend sits in a public subnet with an Elastic IP,
    // and nothing in the private subnets needs egress.
    //
    // Keep "Public"/"Private" capitalised in the subnet and route-table
    // Names. Vpc.get refinds the subnets with a case-sensitive
    // `tag:Name = *Public*` filter, so a lowercase rename hands every
    // non-production stage an empty subnet list.
    const vpc = isProd
      ? new sst.aws.Vpc("Vpc", {
          transform: {
            vpc: sharedTag(sharedName),
            internetGateway: sharedTag(`${sharedName}-igw`),
            securityGroup: sharedTag(sharedName),
            publicSubnet: sharedTag(`${sharedName}-Public`),
            privateSubnet: sharedTag(`${sharedName}-Private`),
            publicRouteTable: sharedTag(`${sharedName}-Public`),
            privateRouteTable: sharedTag(`${sharedName}-Private`),
          },
        })
      : sst.aws.Vpc.get(
          "Vpc",
          (() => {
            if (taggedVpcIds.length === 0)
              throw new Error(
                `No VPC tagged sst:shared=${sharedName} found. Deploy the production stage first.`
              )
            if (taggedVpcIds.length > 1)
              throw new Error(
                `${taggedVpcIds.length} VPCs are tagged sst:shared=${sharedName}: ${taggedVpcIds.join(", ")}. Deploy the production stage to find out which one it owns.`
              )
            return taggedVpcIds[0]
          })()
        )

    // Written only by the stage that owns the VPC, and read by the guard
    // above on the next deploy. `overwrite` so a marker seeded by hand, to
    // adopt a VPC that predates this guard, is taken over rather than
    // colliding.
    if (isProd)
      new aws.ssm.Parameter("SharedVpcId", {
        name: sharedVpcIdParameter,
        type: "String",
        value: vpc.id,
        overwrite: true,
      })

    // The Postgres component creates its password secret with no transform
    // hook of its own, hence the global transform. An explicit name beats
    // Pulumi's `<app>-<stage>-<logical>-<random>` autonaming and keeps the
    // stage out of the one secret every stage reads. Renaming replaces the
    // secret, which `protect` will not allow, so a rename means relaxing
    // `protect` in app() for the one deploy that lands it.
    $transform(aws.secretsmanager.Secret, (args, _opts, name) => {
      if (name !== "DatabaseProxySecret" || !args) return
      args.name = `${sharedDatabaseId}-password`
    })

    // Plain rds.Instance, not Aurora. `database` only seeds the server; the
    // databases that matter are the per-stage ones bootstrap.sh creates,
    // connecting through the `postgres` maintenance database RDS always has.
    //
    // Every stage's instance reaches this through the VPC's default security
    // group, which allows the whole 10.0.0.0/16. The EC2 boxes carry their
    // own group and are not otherwise members of it.
    //
    // The `.get` side recovers the password through the Secrets Manager
    // secret production tagged onto the instance. Pulumi's "couldn't find
    // resource" here means production has not been deployed yet.
    const database = isProd
      ? new sst.aws.Postgres("Database", {
          vpc,
          database: "shared",
          instance: "t4g.micro",
          storage: "20 GB",
          // Convex documents testing against v17 only, but 18 was verified by
          // hand against this exact stack. The one Postgres-side failure to
          // expect is TLS trust, which POSTGRES_CA_URL in userData handles.
          version: "18",
          transform: {
            // No retainOnDelete here. `removal: "retain"` in app() already
            // sets it on aws:rds/instance:Instance, and a second copy would
            // only drift. deletionProtection is the AWS-side guard on top,
            // and the slow one to undo. It lives on the instance, so
            // clearing it takes a deploy before any remove can land.
            instance: {
              identifier: sharedDatabaseId,
              deletionProtection: true,
            },
          },
        })
      : sst.aws.Postgres.get("Database", { id: sharedDatabaseId })

    // No database name and no query params. The backend appends its own.
    const postgresUrl = $interpolate`postgresql://${database.username}:${database.password}@${database.host}:${database.port}`

    // Never in userData, which anyone with ec2:DescribeInstanceAttribute can
    // read, and this is the master password to every stage's data. It sits in
    // SSM and the instance fetches it at boot. SecureString under the default
    // aws/ssm key, which SSM decrypts for any principal allowed
    // ssm:GetParameter, so no KMS grant is needed. Per-stage parameter even
    // though the value is identical, so removing a stage only takes its own
    // copy.
    const postgresUrlParameter = new aws.ssm.Parameter("ConvexPostgresUrl", {
      name: `/${$app.name}/${$app.stage}/convex/postgres-url`,
      type: "SecureString",
      value: postgresUrl,
    })

    // ---- object storage ---------------------------------------------------

    // Convex keeps snapshots, function modules, user files and search indexes
    // on the container's volume by default, which a replaced instance carries
    // away with it. These five move all of it to S3. The variable names are
    // the backend's, one bucket each, and the set is fixed:
    // https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/s3_storage.md
    //
    // Per stage, like the database. Production retains its buckets on removal
    // through `removal: "retain"` in app(); every other stage's are emptied and
    // deleted, since SST sets forceDestroy on every bucket it makes.
    //
    // Switching a deployment that already holds data between local and S3
    // storage is a `convex export` and `convex import --replace-all`, not a
    // restart: the rows keep pointing at storage the new backend cannot read.
    const storageBuckets = {
      S3_STORAGE_EXPORTS_BUCKET: new sst.aws.Bucket("ExportsBucket"),
      S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET: new sst.aws.Bucket(
        "SnapshotImportsBucket"
      ),
      S3_STORAGE_MODULES_BUCKET: new sst.aws.Bucket("ModulesBucket"),
      S3_STORAGE_FILES_BUCKET: new sst.aws.Bucket("FilesBucket"),
      S3_STORAGE_SEARCH_BUCKET: new sst.aws.Bucket("SearchBucket"),
    }

    // A long-lived access key rather than the instance role, because the
    // containers cannot reach IMDS: the hop limit of 1 set on the instance
    // below is exactly what keeps Convex actions from reading the role's
    // credentials, and it costs the backend its own. A user scoped to these
    // five buckets is the smaller of the two blast radii.
    const storageUser = new aws.iam.User("ConvexStorageUser")

    new aws.iam.UserPolicy("ConvexStorageUserPolicy", {
      user: storageUser.name,
      policy: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            // The backend reads, writes and deletes; s3:* over five buckets it
            // is the only principal for is narrower than it looks.
            Action: ["s3:*"],
            Resource: Object.values(storageBuckets).flatMap((bucket) => [
              bucket.arn,
              $interpolate`${bucket.arn}/*`,
            ]),
          },
        ],
      },
    })

    const storageAccessKey = new aws.iam.AccessKey("ConvexStorageAccessKey", {
      user: storageUser.name,
    })

    // One record, two consumers: the deployed backend reads it out of SSM at
    // boot, and the DevCommand at the bottom hands the same variables to the
    // local compose stack.
    const storageEnvironment = {
      AWS_REGION: REGION,
      AWS_ACCESS_KEY_ID: storageAccessKey.id,
      AWS_SECRET_ACCESS_KEY: storageAccessKey.secret,
      ...Object.fromEntries(
        Object.entries(storageBuckets).map(([variable, bucket]) => [
          variable,
          bucket.name,
        ])
      ),
    }

    // Same reasoning as the connection string above: the secret access key must
    // not go anywhere near userData. Shaped as a shell fragment because that is
    // what the instance does with it — sources it, so bootstrap.sh sees the
    // variables the way a laptop run would. Values are quoted because they are
    // sourced rather than parsed; a secret access key is base64, and `+` and
    // `/` in an unquoted assignment only happen to be safe.
    const storageEnvParameter = new aws.ssm.Parameter("ConvexStorageEnv", {
      name: `/${$app.name}/${$app.stage}/convex/storage-env`,
      type: "SecureString",
      value: $resolve(storageEnvironment).apply((environment) =>
        Object.entries(environment)
          .map(([variable, value]) => `${variable}='${value}'`)
          .join("\n")
      ),
    })

    // ---- instance ---------------------------------------------------------

    // Amazon Linux 2023 on arm64. Convex publishes linux/arm64 images for
    // both containers, so Graviton is ~20% off for free. Looked up because
    // AMI ids are per-region.
    const ami = aws.ec2.getAmiOutput({
      owners: ["amazon"],
      mostRecent: true,
      filters: [
        { name: "name", values: ["al2023-ami-2023.*-kernel-6.1-arm64"] },
        { name: "state", values: ["available"] },
      ],
    })

    // Shell access is the console's Connect button or `aws
    // ec2-instance-connect ssh`, which originates from AWS's own range, not
    // your laptop. The managed prefix list is that range, and AWS keeps it
    // current.
    const instanceConnect = aws.ec2.getManagedPrefixListOutput({
      name: `com.amazonaws.${REGION}.ec2-instance-connect`,
    })

    // 3210/3211/6791 stay closed on purpose. Caddy proxies them from
    // localhost; exposing them would mean an unencrypted backend and a public
    // admin dashboard.
    const securityGroup = new aws.ec2.SecurityGroup("ConvexSecurityGroup", {
      vpcId: vpc.id,
      description: "Convex self-hosted: HTTP/HTTPS via Caddy",
      ingress: [
        {
          protocol: "tcp",
          fromPort: 80,
          toPort: 80,
          cidrBlocks: ["0.0.0.0/0"],
          description: "HTTP: ACME challenge and the redirect to HTTPS",
        },
        {
          protocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrBlocks: ["0.0.0.0/0"],
          description: "HTTPS",
        },
        {
          protocol: "tcp",
          fromPort: 22,
          toPort: 22,
          prefixListIds: [instanceConnect.id],
          description: "SSH via EC2 Instance Connect only",
        },
      ],
      egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
      ],
    })

    // Allocated apart from the instance so the address survives a
    // replacement. The DNS records below point here, not at the instance.
    const eip = new aws.ec2.Eip("ConvexEip", { domain: "vpc" })

    // ---- the deployment's own credentials ----------------------------------

    // Dynamic, and inside run(), because SST rejects a top-level import in this
    // file outright: "Move imports inside the function they are used and do a
    // dynamic import".
    const { randomBytes } = await import("node:crypto")

    // The backend's identity. It mints admin keys from this and validates them
    // against it, so a key is only ever good for the instance secret and the
    // INSTANCE_NAME it was cut from — `production|...` does not open `dev`.
    //
    // Left unset, the container generates one on first start and keeps it on
    // its data volume, so a replaced host is a new deployment and every key
    // minted against the old one starts answering 401. Since
    // userDataReplaceOnChange means editing the script below replaces the host,
    // that would happen quietly and often. Owning the value here instead makes
    // keys outlive the host, and lets one be cut without the host existing:
    //
    //   docker run --rm --entrypoint ./generate_key \
    //     ghcr.io/get-convex/convex-backend:${CONVEX_IMAGE_TAG} <stage> <secret>
    //
    // ignoreChanges is what makes it stick. The value below is re-rolled on
    // every evaluation of this config, so without it each deploy would push a
    // new secret and undo the whole point; with it, only the first deploy's
    // value is ever written. Rotating is therefore deliberate: delete the
    // parameter, or `pulumi state` it out. That invalidates every key at once,
    // since there is no per-key revocation to reach for.
    const instanceSecretParameter = new aws.ssm.Parameter(
      "ConvexInstanceSecret",
      {
        name: `/${$app.name}/${$app.stage}/convex/instance-secret`,
        type: "SecureString",
        // 32 bytes hex is what the container generates for itself
        // (`openssl rand -hex 32`), and generate_key rejects anything shorter.
        value: randomBytes(32).toString("hex"),
      },
      { ignoreChanges: ["value"] }
    )

    // The two variables the Convex CLI reads for a self-hosted deployment.
    // Together they are what `convex deploy` needs to push this repo's
    // functions at a stage, and they are published rather than kept on the box
    // so that pushing does not mean opening a shell on it.
    //
    // The URL is the same one the browser uses and is not a secret, so it is a
    // plain String: reading it needs no decrypt permission.
    new aws.ssm.Parameter("ConvexUrl", {
      name: `/${$app.name}/${$app.stage}/convex/url`,
      type: "String",
      value: `https://${convexDomain.api}`,
    })

    // The admin key is a different thing entirely — full read and write on
    // every table plus function push, so a root credential for the deployment.
    // It can only come from the running backend, so bootstrap.sh mints it a few
    // minutes into the first boot and puts it here.
    //
    // Declared rather than left to bootstrap's put-parameter so it belongs to
    // this stage's state and goes when the stage goes, and so the policy below
    // names one ARN instead of a path wildcard. That means the value is written
    // twice: this placeholder at create, then the real key at boot.
    // ignoreChanges is what stops the next deploy putting the placeholder back.
    const adminKeyParameter = new aws.ssm.Parameter(
      "ConvexAdminKey",
      {
        name: `/${$app.name}/${$app.stage}/convex/admin-key`,
        type: "SecureString",
        value: "pending: bootstrap.sh writes this on first boot",
      },
      { ignoreChanges: ["value"] }
    )

    // ---- instance role ------------------------------------------------------

    const role = new aws.iam.Role("ConvexInstanceRole", {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    })

    // Also buys Session Manager: `aws ssm start-session --target <id>` for a
    // shell with no inbound port, and
    // AWS-StartPortForwardingSessionToRemoteHost to reach Postgres from a
    // local client.
    new aws.iam.RolePolicyAttachment("ConvexInstanceSsm", {
      role: role.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    })

    // Reads exactly the two parameters userData fetches at boot, and nothing
    // else. Note this is the instance's own permission: the backend containers
    // never reach SSM, they are handed the values as environment.
    const parameterPolicy = new aws.iam.RolePolicy("ConvexInstanceParameters", {
      role: role.name,
      policy: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "ssm:GetParameter",
            Resource: [
              postgresUrlParameter.arn,
              storageEnvParameter.arn,
              instanceSecretParameter.arn,
            ],
          },
          {
            // Write, and to the one parameter: the instance publishes the
            // admin key it mints and never reads one back.
            Effect: "Allow",
            Action: "ssm:PutParameter",
            Resource: adminKeyParameter.arn,
          },
        ],
      },
    })

    const instanceProfile = new aws.iam.InstanceProfile(
      "ConvexInstanceProfile",
      { role: role.name }
    )

    const userData = $interpolate`#!/bin/bash
# No -x: this script handles the database password, and userData plus
# everything it echoes lands in the cloud-init log.
set -euo pipefail

# The AMI lookup above is \`mostRecent\`, so base packages start current.
# Patch by replacing the instance, not mutating it.
dnf install -y docker

# AL2023 ships the Docker engine in its repos but not the compose plugin.
install -m 0755 -d /usr/libexec/docker/cli-plugins
curl -fsSL -o /usr/libexec/docker/cli-plugins/docker-compose \\
  https://github.com/docker/compose/releases/download/${COMPOSE_PLUGIN_VERSION}/docker-compose-linux-aarch64
chmod +x /usr/libexec/docker/cli-plugins/docker-compose

usermod -aG docker ec2-user
systemctl enable --now docker

# ---- the stack ----
# Only the script is fetched here; it pulls docker-compose.yaml itself
# through REPO_RAW_BASE. Both come from the repo unmodified, so what boots
# here is what was tested on a laptop; only the environment passed to
# bootstrap.sh below differs.
STACK_DIR=/home/ec2-user/convex-backend
mkdir -p "$STACK_DIR"
cd "$STACK_DIR"

curl -fsSL -o bootstrap.sh ${SELF_HOSTED_CONVEX_REPO}/bootstrap.sh
chmod +x bootstrap.sh

# The connection string lives in SSM, not in this script, since userData is
# readable by anyone with ec2:DescribeInstanceAttribute. AL2023 ships the AWS
# CLI, and the instance role allows exactly the three parameters read here.
POSTGRES_URL="$(aws ssm get-parameter --name '${postgresUrlParameter.name}' \\
  --with-decryption --query Parameter.Value --output text --region ${REGION})"

# The backend's identity, by the same route and for the same reason. Constant
# across every host this stage ever runs, which is what keeps admin keys valid
# through a replacement.
INSTANCE_SECRET="$(aws ssm get-parameter --name '${instanceSecretParameter.name}' \\
  --with-decryption --query Parameter.Value --output text --region ${REGION})"

# The S3 bucket names and credentials, for the same reason and by the same
# route. Exported rather than listed on the command line below: bootstrap.sh
# passes through whichever of its S3 variables are set, and which ones those
# are is its business, not this script's. Removed once sourced, so the secret
# is in one place on the box — the .env bootstrap.sh writes, mode 600.
umask 077
aws ssm get-parameter --name '${storageEnvParameter.name}' \\
  --with-decryption --query Parameter.Value --output text --region ${REGION} \\
  > storage.env
set -a
. ./storage.env
set +a
rm -f storage.env
umask 022

# USE_HTTPS because these are real hostnames with public DNS. Caddy takes a
# Let's Encrypt certificate and redirects 80 to 443; a laptop run leaves it
# unset and gets plain HTTP on *.localhost.
#
# POSTGRES_CA_URL because RDS presents a certificate signed by a private
# Amazon CA in no public trust store. Without it the backend rejects the peer
# with "invalid peer certificate: UnknownIssuer" and crash-loops.
# DO_NOT_REQUIRE_SSL is no substitute; it makes TLS optional, not unverified.
# The bundle is per-region, hence a URL rather than a committed file.
#
# Double quotes around POSTGRES_URL are enough: SST generates the password
# with special:false, 32 alphanumerics. An explicit \`password\` on the
# Postgres component could reintroduce characters that need more care.
INSTANCE_NAME=${$app.stage} \\
INSTANCE_SECRET="$INSTANCE_SECRET" \\
POSTGRES_URL="$POSTGRES_URL" \\
CONVEX_API_DOMAIN=${convexDomain.api} \\
CONVEX_SITE_DOMAIN=${convexDomain.site} \\
CONVEX_DASHBOARD_DOMAIN=${convexDomain.dashboard} \\
USE_HTTPS=1 \\
POSTGRES_CA_URL=https://truststore.pki.rds.amazonaws.com/${REGION}/${REGION}-bundle.pem \\
CONVEX_IMAGE_TAG=${CONVEX_IMAGE_TAG} \\
REPO_RAW_BASE=${SELF_HOSTED_CONVEX_REPO} \\
REGION=${REGION} \\
ADMIN_KEY_PARAMETER=${adminKeyParameter.name} \\
  ./bootstrap.sh

# bootstrap.sh creates the database, brings the stack up, waits for the backend
# to report healthy, and puts the admin key in SSM. ADMIN_KEY_PARAMETER is what
# keeps it off the disk: unset, bootstrap.sh falls back to $STACK_DIR/admin-key.
chown -R ec2-user:ec2-user "$STACK_DIR"
`

    const instance = new aws.ec2.Instance(
      "ConvexInstance",
      {
        ami: ami.id,
        instanceType: "t4g.small",
        // publicSubnets is an Output<string[]>; the first is enough for a
        // single instance.
        subnetId: vpc.publicSubnets.apply((subnets) => subnets[0]),
        vpcSecurityGroupIds: [securityGroup.id],
        iamInstanceProfile: instanceProfile.name,
        // Needed before the Elastic IP associates, or the instance has no
        // route out and every curl in userData hangs.
        associatePublicIpAddress: true,
        rootBlockDevice: {
          // The 8 GiB default fills once the Convex images land.
          volumeSize: 20,
          volumeType: "gp3",
        },
        userData,
        // Editing userData should rebuild the box, not silently do nothing.
        userDataReplaceOnChange: true,
        // Convex actions run app code that can fetch arbitrary URLs from this
        // box, and 169.254.169.254 would hand over the role's credentials.
        // IMDSv2 with a hop limit of 1 cuts the containers off, since the
        // docker bridge costs them the one allowed hop. The host itself, the
        // aws CLI call above included, still reaches IMDS.
        metadataOptions: {
          httpTokens: "required",
          httpPutResponseHopLimit: 1,
        },
        tags: { Name: `${$app.name}-${$app.stage}-convex` },
      },
      // The boot script's first AWS calls are the parameter fetches; without
      // this the instance can boot before its permission exists.
      { dependsOn: [parameterPolicy] }
    )

    new aws.ec2.EipAssociation("ConvexEipAssociation", {
      instanceId: instance.id,
      allocationId: eip.allocationId,
    })

    // ---- dns --------------------------------------------------------------

    // Caddy solves an HTTP-01 challenge, so these must exist and resolve
    // before it starts. They point at the Elastic IP, not the instance, and
    // stay valid across a replacement.
    for (const [key, host] of Object.entries(convexDomain)) {
      new aws.route53.Record(
        `Convex${key[0].toUpperCase()}${key.slice(1)}Record`,
        {
          zoneId: zone.zoneId,
          name: host,
          type: "A",
          ttl: 60,
          records: [eip.publicIp],
        }
      )
    }

    // ---- frontend ---------------------------------------------------------

    // A streaming Lambda behind its own CloudFront distribution, on the apex
    // for production and on the stage's subdomain otherwise — the same `domain`
    // the Convex hostnames hang off. SST takes the ACM certificate in us-east-1
    // and writes the alias record into the zone above.
    //
    // Needs Nitro's `aws-lambda` preset, which apps/web/vite.config.ts sets.
    // `sst dev` never gets this far: the component returns a placeholder and
    // runs the dev server below instead, so no distribution exists locally.
    const web = new sst.aws.TanStackStart("Web", {
      path: "apps/web",
      domain,
      // VITE_ variables are inlined into the client bundle at build time, so
      // everything here ships to the browser. The Convex URL has to: the
      // client opens the websocket itself. Never put a secret here.
      environment: {
        VITE_STAGE_NAME: $app.stage,
        VITE_CONVEX_URL: $dev
          ? CONVEX_LOCAL_URL
          : `https://${convexDomain.api}`,
      },
      dev: {
        title: "web",
        command: "bun run dev",
        url: "http://localhost:3000",
      },
    })

    // ---- local development -------------------------------------------------

    // `sst dev` is the whole environment: the compose stack at the repo root,
    // `convex dev` pushing functions into it, and the Vite server above. SST
    // skips DevCommands entirely on deploy.
    //
    // The local backend is given this stage's real buckets rather than a second
    // set. Storage keys are rows in each backend's own Postgres, so the two
    // write past each other rather than over each other; what they must not
    // share is the database, and they do not — this one runs against the
    // Postgres container.
    const convexStack = new sst.x.DevCommand("Convex", {
      dev: {
        title: "convex stack",
        command: "docker compose up",
        autostart: true,
      },
      environment: storageEnvironment,
    })

    // The CLI cannot push until the backend answers, so this goes through a
    // script that waits and mints the admin key on the first run. dependsOn
    // orders the resources, not the processes.
    new sst.x.DevCommand(
      "ConvexFunctions",
      {
        dev: {
          title: "convex dev",
          command: "bun scripts/convex-dev.ts",
          autostart: true,
        },
      },
      { dependsOn: [convexStack] }
    )

    return {
      webUrl: web.url,
      convexUrl: `https://${convexDomain.api}`,
      convexSiteUrl: `https://${convexDomain.site}`,
      convexDashboardUrl: `https://${convexDomain.dashboard}`,
      convexAdminKeyParameter: adminKeyParameter.name,
      instanceId: instance.id,
      publicIp: eip.publicIp,
      postgresHost: database.host,
    }
  },
})
