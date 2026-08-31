/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Self-hosted Convex on one EC2 instance behind Caddy, backed by RDS
 * Postgres. One instance and one database per stage; production owns the
 * shared VPC and Postgres server, so deploy that stage first.
 *
 *   bun sst deploy --stage production   ->  api.fullstackaws.dev
 *   bun sst deploy --stage dev          ->  api.dev.fullstackaws.dev
 */

const BASE_DOMAIN = "fullstackaws.dev"
const REGION = "eu-central-1"

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
      // Both guards lift on the same escape hatch:
      //
      //   SST_UNPROTECT=1 bun sst deploy --stage production
      //   SST_UNPROTECT=1 bun sst remove --stage production
      //
      // Deploy first: the database also carries RDS-level deletionProtection
      // (see the Postgres transform), which has to be off in AWS before
      // anything can take the server away. Without the env var, production
      // refuses removal (`protect`), and even forced it would leave the
      // database, VPC and subnets behind, since `retain` drops them from
      // state without calling AWS. An env var rather than a code change, so
      // teardown is deliberate but needs no commit.
      removal:
        process.env.SST_UNPROTECT !== "1" && input?.stage === "production"
          ? "retain"
          : "remove",
      protect:
        process.env.SST_UNPROTECT !== "1" && input?.stage === "production",
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
    // infrastructure.
    //
    // Hence the order: production deploys first and is removed last. RDS
    // takes ~10 minutes; other stages fail fast below until it exists.
    const sharedName = $app.name
    const sharedDatabaseId = `${$app.name}-postgres`

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
          await aws.ec2
            .getVpcs({
              filters: [{ name: "tag:sst:shared", values: [sharedName] }],
            })
            .then(({ ids }) => {
              if (ids.length === 0)
                throw new Error(
                  `No VPC tagged sst:shared=${sharedName} found. Deploy the production stage first.`
                )
              return ids[0]
            })
        )

    // The Postgres component creates its password secret with no transform
    // hook of its own, hence the global transform. An explicit name beats
    // Pulumi's `<app>-<stage>-<logical>-<random>` autonaming and keeps the
    // stage out of the one secret every stage reads. Renaming replaces the
    // secret, and production protects its resources, so the rename lands via
    // an SST_UNPROTECT=1 deploy followed by a normal one.
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
            // Function form, because retainOnDelete is a resource option, not
            // an InstanceArgs field. Shared data outlives the stack twice
            // over: retainOnDelete keeps `sst remove` off the server, and
            // deletionProtection makes RDS itself refuse deletion. The latter
            // rides the same SST_UNPROTECT escape hatch but lives in AWS, so
            // a real teardown deploys once with the var set before removing.
            instance: (args, opts) => {
              args.identifier = sharedDatabaseId
              args.deletionProtection = process.env.SST_UNPROTECT !== "1"
              opts.retainOnDelete = true
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

    // ---- instance role ------------------------------------------------------

    // The admin key can only come from the running backend, so bootstrap.sh
    // mints it at boot and writes it to STACK_DIR/admin-key on the box.

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

    // Reads exactly one thing: the connection string userData fetches at boot.
    const postgresUrlPolicy = new aws.iam.RolePolicy(
      "ConvexInstancePostgresUrl",
      {
        role: role.name,
        policy: postgresUrlParameter.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Action: "ssm:GetParameter", Resource: arn },
            ],
          })
        ),
      }
    )

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
# CLI, and the instance role allows exactly this one parameter.
POSTGRES_URL="$(aws ssm get-parameter --name '${postgresUrlParameter.name}' \\
  --with-decryption --query Parameter.Value --output text --region ${REGION})"

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
POSTGRES_URL="$POSTGRES_URL" \\
CONVEX_API_DOMAIN=${convexDomain.api} \\
CONVEX_SITE_DOMAIN=${convexDomain.site} \\
CONVEX_DASHBOARD_DOMAIN=${convexDomain.dashboard} \\
USE_HTTPS=1 \\
POSTGRES_CA_URL=https://truststore.pki.rds.amazonaws.com/${REGION}/${REGION}-bundle.pem \\
CONVEX_IMAGE_TAG=${CONVEX_IMAGE_TAG} \\
REPO_RAW_BASE=${SELF_HOSTED_CONVEX_REPO} \\
  ./bootstrap.sh

# bootstrap.sh creates the database, brings the stack up, waits for the
# backend to report healthy, and writes the admin key to $STACK_DIR/admin-key.
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
      // The boot script's first AWS call is the parameter fetch; without this
      // the instance can boot before its permission exists.
      { dependsOn: [postgresUrlPolicy] }
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

    return {
      convexUrl: `https://${convexDomain.api}`,
      convexSiteUrl: `https://${convexDomain.site}`,
      convexDashboardUrl: `https://${convexDomain.dashboard}`,
      instanceId: instance.id,
      publicIp: eip.publicIp,
      postgresHost: database.host,
    }
  },
})
