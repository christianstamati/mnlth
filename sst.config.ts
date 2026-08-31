/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Self-hosted Convex on a single EC2 instance, behind Caddy, backed by RDS
 * Postgres. One isolated copy per stage.
 *
 *   bun sst deploy --stage production   ->  api.fullstackaws.dev
 *   bun sst deploy --stage dev          ->  api.dev.fullstackaws.dev
 */

const BASE_DOMAIN = "fullstackaws.dev"
const REGION = "eu-central-1"

// Pinned rather than `latest`, so replacing the instance redeploys the same
// stack it was tested against instead of whatever shipped that morning. Bump
// these deliberately: the backend migrates the database in place on start, and
// there is no going back once it has.
// https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/upgrading.md
//
// Backend and dashboard are tagged with the commit they were built from and
// released together, so one tag covers both. What `latest` currently is:
//
//   docker buildx imagetools inspect ghcr.io/get-convex/convex-backend:latest \
//     --format '{{ json (index .Image "linux/arm64").Config.Labels }}'
//
// The tag is that output's org.opencontainers.image.revision. Note it does not
// match the repo's `precompiled-*` release tags; those are a different id.
const CONVEX_IMAGE_TAG = "c0cb7ae17f54e14846c243c5332a8a5e6d0e19d4" // = latest on 2026-08-28
const COMPOSE_PLUGIN_VERSION = "v5.5.0"

// The stack itself lives in its own repo. This instance fetches those two files
// at boot and runs bootstrap.sh, so what boots here is the same thing that runs
// on a laptop, and everything stage-specific is passed in as environment below.
// Two consequences worth knowing: the repo has to stay public, since the curls
// below carry no credentials, and a floating ref means a replaced instance
// picks up whatever main says at that moment. Pin REPO_REF to a commit SHA for
// a deployment that has to be reproducible.
// Caddy's image tag is pinned inside that repo's docker-compose.yaml.
const REPO = "christianstamati/self-hosted-convex"
const REPO_REF = "main"
const STACK_DIR = "/home/ec2-user/convex-backend"

export default $config({
  app(input) {
    return {
      name: "mnlth",
      // Both guards lift together on the same escape hatch:
      //
      //   SST_UNPROTECT=1 bun sst remove --stage production
      //
      // Without it, production refuses removal outright (`protect`) and would
      // leave the database, VPC and subnets behind even if forced (`retain`
      // drops them from state without calling AWS). An env var rather than a
      // code change, so tearing down is deliberate but doesn't need a commit.
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
    // so stages never fight over the same records. Keyed on the stage rather
    // than on `$dev`, which would give every deployed stage the apex.
    const domain = isProd ? BASE_DOMAIN : `${$app.stage}.${BASE_DOMAIN}`

    // One hostname per port the Convex container group exposes.
    const convexDomain = {
      api: `api.${domain}`,
      site: `site.${domain}`,
      dashboard: `dashboard.${domain}`,
    }

    // Looked up rather than hardcoded, so this works in any account holding
    // the zone.
    const zone = aws.route53.getZoneOutput({
      name: BASE_DOMAIN,
      privateZone: false,
    })

    // ---- shared network and database ---------------------------------------

    // The VPC and the Postgres server are per-app, not per-stage: one server
    // holds every stage's database, since bootstrap.sh creates a database named
    // after INSTANCE_NAME inside whatever server it is pointed at. The first
    // deploy of any stage creates them, taking the ~10 minutes RDS needs; every
    // later stage finds them by name and only adds its database. Both are
    // looked up by their fixed names rather than passed between stages, because
    // SST state is per-stage and cannot reference another stage's resources.
    //
    // Consequence worth knowing: whichever stage deploys first owns them in its
    // state. The instance carries retainOnDelete so `sst remove` on that stage
    // leaves the data behind — the next deploy of any stage adopts it again —
    // but the VPC around it is not retained, so remove the owning stage last.
    // `pulumi stack --stack <stage>` shows which one holds them.
    const sharedName = $app.name
    const sharedDatabaseId = `${$app.name}-postgres`

    // getVpcs returns an empty list rather than throwing, so this is just a
    // presence check. No NAT gateway: the backend sits in a public subnet with
    // an Elastic IP, and nothing in the private subnets needs egress.
    const existingVpcs = await aws.ec2.getVpcs({
      filters: [{ name: "tag:sst:shared", values: [sharedName] }],
    })

    // SST names resources `<app>-<stage>-<resource>` through a Name tag, but
    // only when the resource carries no tags of its own. Setting tags here
    // therefore does both jobs at once: it marks the VPC as shared for the
    // lookup above, and it keeps the stage out of the name of something every
    // stage will use. Merged rather than replaced, so nothing SST set is lost.
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

    const vpc =
      existingVpcs.ids.length > 0
        ? sst.aws.Vpc.get("Vpc", existingVpcs.ids[0])
        : new sst.aws.Vpc("Vpc", {
            transform: {
              vpc: sharedTag(sharedName),
              internetGateway: sharedTag(`${sharedName}-igw`),
              securityGroup: sharedTag(sharedName),
              publicSubnet: sharedTag(`${sharedName}-public`),
              privateSubnet: sharedTag(`${sharedName}-private`),
              publicRouteTable: sharedTag(`${sharedName}-public`),
              privateRouteTable: sharedTag(`${sharedName}-private`),
            },
          })

    // getInstance throws when the identifier does not exist, which is the only
    // way to ask. Pulumi reports that as "couldn't find resource" rather than
    // surfacing the DBInstanceNotFound code, so match both. Anything else is a
    // real error — no credentials, no permission — and must not be swallowed
    // into silently building a second server.
    const existingDatabase = await aws.rds
      .getInstance({ dbInstanceIdentifier: sharedDatabaseId })
      .catch((err) => {
        const message = `${err}`
        if (
          message.includes("couldn't find resource") ||
          message.includes("DBInstanceNotFound")
        )
          return undefined
        throw err
      })

    // Plain rds.Instance, not Aurora. `database` is just what RDS initialises
    // the server with; the databases that matter are the per-stage ones
    // bootstrap.sh creates. It connects through the `postgres` maintenance
    // database, which RDS always has.
    //
    // Every stage's instance reaches this through the VPC's default security
    // group, which allows the whole 10.0.0.0/16 — the EC2 boxes carry their own
    // security group and are not otherwise members of it.
    const database = existingDatabase
      ? sst.aws.Postgres.get("Database", { id: sharedDatabaseId })
      : new sst.aws.Postgres("Database", {
          vpc,
          database: "shared",
          instance: "t4g.micro",
          storage: "20 GB",
          // Convex documents testing against v17 only, but 18 was verified
          // working by hand against this exact stack — schema creation and
          // normal operation both clean. The one Postgres-side failure to
          // expect is TLS trust, which POSTGRES_CA_URL in userData handles.
          version: "18",
          transform: {
            // Function form, because retainOnDelete is a resource option
            // rather than an InstanceArgs field. Shared data outlives the
            // stage that happened to create it.
            instance: (args, opts) => {
              args.identifier = sharedDatabaseId
              opts.retainOnDelete = true
            },
          },
        })

    // No database name and no query params — the backend appends its own.
    const postgresUrl = $interpolate`postgresql://${database.username}:${database.password}@${database.host}:${database.port}`

    // ---- instance ---------------------------------------------------------

    // Amazon Linux 2023 on arm64. Both convex-backend and convex-dashboard
    // publish linux/arm64 images, so Graviton is ~20% off for free. Looked up
    // because AMI ids are per-region.
    const ami = aws.ec2.getAmiOutput({
      owners: ["amazon"],
      mostRecent: true,
      filters: [
        { name: "name", values: ["al2023-ami-2023.*-kernel-6.1-arm64"] },
        { name: "state", values: ["available"] },
      ],
    })

    // Shell access is the console's Connect button / `aws ec2-instance-connect
    // ssh`, which originates from AWS's own range rather than from your laptop.
    // The managed prefix list is that range, and AWS keeps it current.
    const instanceConnect = aws.ec2.getManagedPrefixListOutput({
      name: `com.amazonaws.${REGION}.ec2-instance-connect`,
    })

    // 3210/3211/6791 are deliberately absent: Caddy proxies them from
    // localhost, so exposing them would mean an unencrypted backend and a
    // public admin dashboard.
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

    // Allocated separately from the instance so the address survives a
    // replacement — the DNS records below point here, not at the instance.
    const eip = new aws.ec2.Eip("ConvexEip", { domain: "vpc" })

    // ---- instance role ------------------------------------------------------

    // The admin key can only be produced by the running backend, so bootstrap.sh
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
    // shell with no inbound port, and AWS-StartPortForwardingSessionToRemoteHost
    // to reach Postgres from a local client.
    new aws.iam.RolePolicyAttachment("ConvexInstanceSsm", {
      role: role.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    })

    const instanceProfile = new aws.iam.InstanceProfile(
      "ConvexInstanceProfile",
      { role: role.name }
    )

    // The Postgres password is interpolated into userData, which anyone with
    // ec2:DescribeInstanceAttribute can read. Move it to SSM Parameter Store
    // and fetch it at boot if that matters.
    const rawBase = `https://raw.githubusercontent.com/${REPO}/${REPO_REF}`

    const userData = $interpolate`#!/bin/bash
# No -x: userData is echoed to the cloud-init log, and this passes the database
# password to bootstrap.sh.
set -euo pipefail

# The AMI lookup above is \`mostRecent\`, so base packages are already current at
# launch. Patch by replacing the instance rather than mutating it.
dnf install -y docker

# AL2023 ships the Docker engine in its repos but not the compose plugin.
install -m 0755 -d /usr/libexec/docker/cli-plugins
curl -fsSL -o /usr/libexec/docker/cli-plugins/docker-compose \\
  https://github.com/docker/compose/releases/download/${COMPOSE_PLUGIN_VERSION}/docker-compose-linux-aarch64
chmod +x /usr/libexec/docker/cli-plugins/docker-compose

usermod -aG docker ec2-user
systemctl enable --now docker

# ---- the stack ----
# Both files come from ${REPO} unmodified, so what boots here is what was tested
# on a laptop. Everything that differs between the two is the environment passed
# to bootstrap.sh below, which is what it writes into .env.
mkdir -p ${STACK_DIR}
cd ${STACK_DIR}

for f in bootstrap.sh docker-compose.yaml; do
  curl -fsSL -o "$f" ${rawBase}/"$f"
done
chmod +x bootstrap.sh

# USE_HTTPS because these are real hostnames with public DNS: Caddy takes a
# certificate from Let's Encrypt and redirects 80 to 443. A laptop run leaves it
# unset and gets plain HTTP on *.localhost.
#
# POSTGRES_CA_URL because RDS presents a certificate signed by a private Amazon
# CA that is in no public trust store. Without it the backend completes the TLS
# handshake and rejects the peer with "invalid peer certificate: UnknownIssuer",
# then crash-loops. DO_NOT_REQUIRE_SSL is not a substitute: it makes TLS
# optional, not unverified, so it only helps against a server offering none.
# The bundle is per-region, which is why it is a URL rather than committed.
#
# POSTGRES_URL is single-quoted: SST generates the password with special:false,
# so it is 32 alphanumerics and safe here. Passing an explicit \`password\` to
# the Postgres component above could reintroduce a quote and break this line.
INSTANCE_NAME=${$app.stage} \\
POSTGRES_URL='${postgresUrl}' \\
CONVEX_API_DOMAIN=${convexDomain.api} \\
CONVEX_SITE_DOMAIN=${convexDomain.site} \\
CONVEX_DASHBOARD_DOMAIN=${convexDomain.dashboard} \\
USE_HTTPS=1 \\
POSTGRES_CA_URL=https://truststore.pki.rds.amazonaws.com/${REGION}/${REGION}-bundle.pem \\
CONVEX_IMAGE_TAG=${CONVEX_IMAGE_TAG} \\
REPO_RAW_BASE=${rawBase} \\
  ./bootstrap.sh

# bootstrap.sh creates the database, brings the stack up, waits for the backend
# to report healthy, and writes the admin key to ${STACK_DIR}/admin-key.
chown -R ec2-user:ec2-user ${STACK_DIR}
`

    const instance = new aws.ec2.Instance("ConvexInstance", {
      ami: ami.id,
      instanceType: "t4g.small",
      // publicSubnets is an Output<string[]>; the first is enough for a
      // single-instance backend.
      subnetId: vpc.publicSubnets.apply((subnets) => subnets[0]),
      vpcSecurityGroupIds: [securityGroup.id],
      iamInstanceProfile: instanceProfile.name,
      // Needed before the Elastic IP is associated, or the instance has no
      // route out and every curl in userData hangs.
      associatePublicIpAddress: true,
      rootBlockDevice: {
        // The 8 GiB default fills up once the Convex images land.
        volumeSize: 20,
        volumeType: "gp3",
      },
      userData,
      // Editing userData should rebuild the box, not silently do nothing.
      userDataReplaceOnChange: true,
      tags: { Name: `${$app.name}-${$app.stage}-convex` },
    })

    new aws.ec2.EipAssociation("ConvexEipAssociation", {
      instanceId: instance.id,
      allocationId: eip.allocationId,
    })

    // ---- dns --------------------------------------------------------------

    // Caddy solves an HTTP-01 challenge, so these must exist and resolve
    // before it starts. Pointing at the Elastic IP rather than the instance
    // keeps them valid across a replacement.
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
      adminKeyPath: `${STACK_DIR}/admin-key`,
    }
  },
})
