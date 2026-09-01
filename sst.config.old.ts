/// <reference path="./.sst/platform/config.d.ts" />

/**
 * A TanStack Start frontend on CloudFront and a self-hosted Convex backend on
 * one EC2 instance behind Caddy, with RDS Postgres and S3. One instance and one
 * database per stage; production owns the shared VPC, so deploy that stage first.
 *
 *   bun sst deploy --stage production   ->  fullstackaws.dev, api.fullstackaws.dev
 *   bun sst deploy --stage dev          ->  dev.fullstackaws.dev, api.dev.fullstackaws.dev
 */

const BASE_DOMAIN = "fullstackaws.dev"
const REGION = "eu-central-1"
const CONVEX_LOCAL_URL = "http://127.0.0.1:3210"
const CONVEX_IMAGE_TAG = "c0cb7ae17f54e14846c243c5332a8a5e6d0e19d4" // = latest on 2026-08-28
const COMPOSE_PLUGIN_VERSION = "v5.5.0"
const SELF_HOSTED_CONVEX_REPO =
  "https://raw.githubusercontent.com/christianstamati/self-hosted-convex/main"

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
    const isProd = $app.stage === "production"
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

    // The VPC and the Postgres server are per-app: production builds both and
    // every other stage references them, since SST state is per-stage. RDS
    // takes ~10 minutes, so other stages fail fast below until it exists.

    // Which stage builds them is a constant, never a does-it-exist probe. A
    // probe finds the owning stage's own VPC on its second deploy, flips it to
    // `.get`, and Pulumi deletes the children that branch stops declaring.
    const sharedVpcName = `${$app.name}-vpc`
    const sharedDatabaseId = `${$app.name}-postgres`

    // SST only auto-names resources that carry no tags of their own. Name does
    // both jobs here: it keeps the stage out of shared names, and it is what
    // the lookup below matches. Merged, so Vpc.get still sees sst:ref-version.
    type Taggable = {
      tags?: $util.Input<Record<string, $util.Input<string>>>
    }

    const named =
      (name: string) =>
      (args: Taggable): undefined => {
        args.tags = {
          ...(args.tags as Record<string, string> | undefined),
          Name: name,
        }
      }

    // AWS does not enforce Name uniqueness, so two matches is an error, not a
    // coin flip. Only non-production stages ask; production reads nothing.
    const findSharedVpcId = async () => {
      const { ids } = await aws.ec2.getVpcs({
        filters: [{ name: "tag:Name", values: [sharedVpcName] }],
      })
      if (ids.length === 0)
        throw new Error(
          `No VPC named ${sharedVpcName} found. Deploy the production stage first.`
        )
      if (ids.length > 1)
        throw new Error(
          `${ids.length} VPCs are named ${sharedVpcName}: ${ids.join(", ")}. ` +
            `Delete the strays, or rename them, so the name points at one VPC.`
        )
      return ids[0]
    }

    // No NAT gateway: the backend sits in a public subnet with an Elastic IP.
    // Keep "Public"/"Private" capitalised. Vpc.get refinds subnets with a
    // case-sensitive `tag:Name = *Public*` filter, and lowercase finds none.
    const vpc = isProd
      ? new sst.aws.Vpc("Vpc", {
          transform: {
            vpc: named(sharedVpcName),
            internetGateway: named(`${sharedVpcName}-igw`),
            securityGroup: named(sharedVpcName),
            publicSubnet: named(`${sharedVpcName}-Public`),
            privateSubnet: named(`${sharedVpcName}-Private`),
            publicRouteTable: named(`${sharedVpcName}-Public`),
            privateRouteTable: named(`${sharedVpcName}-Private`),
          },
        })
      : sst.aws.Vpc.get("Vpc", await findSharedVpcId())

    // The Postgres component exposes no hook for its password secret, hence
    // the global transform. Naming it keeps the stage out of the one secret
    // every stage reads. A rename replaces it, so it needs an unprotected deploy.
    $transform(aws.secretsmanager.Secret, (args, _opts, name) => {
      if (name !== "DatabaseProxySecret" || !args) return
      args.name = `${sharedDatabaseId}-password`
    })

    // Plain rds.Instance, not Aurora. `database` only seeds the server;
    // bootstrap.sh creates the per-stage databases through `postgres`. Stages
    // reach it through the VPC default security group, open to 10.0.0.0/16.
    const database = isProd
      ? new sst.aws.Postgres("Database", {
          vpc,
          database: "shared",
          instance: "t4g.micro",
          storage: "20 GB",
          // Convex tests v17 only; 18 was verified by hand on this stack. The
          // failure to expect is TLS trust, handled by POSTGRES_CA_URL below.
          version: "18",
          transform: {
            // No retainOnDelete: `removal: "retain"` in app() already sets it.
            // deletionProtection is the AWS-side guard and lives on the
            // instance, so clearing it takes a deploy before a remove lands.
            instance: {
              identifier: sharedDatabaseId,
              deletionProtection: true,
            },
          },
        })
      : // The password comes back through the secret production tagged onto
        // the instance. "Couldn't find resource" means production is not up.
        sst.aws.Postgres.get("Database", { id: sharedDatabaseId })

    // No database name and no query params. The backend appends its own.
    const postgresUrl = $interpolate`postgresql://${database.username}:${database.password}@${database.host}:${database.port}`

    // Out of userData, which ec2:DescribeInstanceAttribute exposes, since this
    // is the master password. SecureString under the default aws/ssm key needs
    // no KMS grant. Per stage, so removing one takes only its own copy.
    const postgresUrlParameter = new aws.ssm.Parameter("ConvexPostgresUrl", {
      name: `/${$app.name}/${$app.stage}/convex/postgres-url`,
      type: "SecureString",
      value: postgresUrl,
    })

    // ---- object storage ---------------------------------------------------

    // These five move Convex snapshots, modules, user files and search indexes
    // off the container volume, which a replaced instance would carry away.
    // https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/s3_storage.md

    // Moving a deployment that already holds data between local and S3 is a
    // `convex export` then `convex import --replace-all`, not a restart.
    const storageBuckets = {
      S3_STORAGE_EXPORTS_BUCKET: new sst.aws.Bucket("ExportsBucket"),
      S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET: new sst.aws.Bucket(
        "SnapshotImportsBucket"
      ),
      S3_STORAGE_MODULES_BUCKET: new sst.aws.Bucket("ModulesBucket"),
      S3_STORAGE_FILES_BUCKET: new sst.aws.Bucket("FilesBucket"),
      S3_STORAGE_SEARCH_BUCKET: new sst.aws.Bucket("SearchBucket"),
    }

    // An access key, not the instance role: the hop limit of 1 set below cuts
    // the containers off from IMDS, which is the point, and costs them the
    // role. A user scoped to these five buckets is the smaller blast radius.
    const storageUser = new aws.iam.User("ConvexStorageUser")

    new aws.iam.UserPolicy("ConvexStorageUserPolicy", {
      user: storageUser.name,
      policy: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            // The backend reads, writes and deletes. s3:* over five buckets it
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

    // Two consumers: the deployed backend reads these from SSM at boot, and
    // the DevCommand below hands the same variables to the local stack.
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

    // Same reason as the connection string: the secret key stays out of
    // userData. Shaped as a shell fragment because the instance sources it,
    // and quoted because a base64 secret key can hold `+` and `/`.
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

    // Amazon Linux 2023 on arm64. Convex publishes linux/arm64 for both
    // containers, so Graviton is ~20% cheaper. AMI ids are per-region.
    const ami = aws.ec2.getAmiOutput({
      owners: ["amazon"],
      mostRecent: true,
      filters: [
        { name: "name", values: ["al2023-ami-2023.*-kernel-6.1-arm64"] },
        { name: "state", values: ["available"] },
      ],
    })

    // EC2 Instance Connect originates from AWS's own range, not your laptop.
    // The managed prefix list is that range, and AWS keeps it current.
    const instanceConnect = aws.ec2.getManagedPrefixListOutput({
      name: `com.amazonaws.${REGION}.ec2-instance-connect`,
    })

    // 3210/3211/6791 stay closed. Caddy proxies them from localhost; opening
    // them means an unencrypted backend and a public admin dashboard.
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

    // Dynamic, and inside run(), because SST rejects a top-level import in
    // this file outright.
    const { randomBytes } = await import("node:crypto")

    // The backend's identity, and what admin keys are cut from and checked
    // against, so a key only opens the INSTANCE_NAME it was minted for. Owned
    // here so keys outlive a host, which userDataReplaceOnChange replaces often.

    // ignoreChanges is what makes it stick: the value re-rolls on every
    // evaluation, so each deploy would otherwise push a new secret. Rotating
    // means deleting the parameter, which invalidates every key at once.
    const instanceSecretParameter = new aws.ssm.Parameter(
      "ConvexInstanceSecret",
      {
        name: `/${$app.name}/${$app.stage}/convex/instance-secret`,
        type: "SecureString",
        // 32 bytes hex is what the container generates for itself, and
        // generate_key rejects anything shorter.
        value: randomBytes(32).toString("hex"),
      },
      { ignoreChanges: ["value"] }
    )

    // Half of what `convex deploy` reads for a self-hosted push, published so
    // pushing does not mean opening a shell on the box. Plain String, since
    // this is the URL the browser uses and reading it needs no decrypt.
    new aws.ssm.Parameter("ConvexUrl", {
      name: `/${$app.name}/${$app.stage}/convex/url`,
      type: "String",
      value: `https://${convexDomain.api}`,
    })

    // The other half, and a root credential: read and write on every table
    // plus function push. Only the running backend can mint it, so
    // bootstrap.sh puts it here a few minutes into the first boot.

    // Declared here so it belongs to this stage's state and the policy below
    // names one ARN. The placeholder is written at create and the real key at
    // boot, and ignoreChanges stops the next deploy putting it back.
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

    // Also buys Session Manager: `aws ssm start-session` for a shell with no
    // inbound port, and port forwarding to reach Postgres from a local client.
    new aws.iam.RolePolicyAttachment("ConvexInstanceSsm", {
      role: role.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    })

    // Exactly the parameters userData fetches at boot. This is the instance's
    // own permission; the containers never reach SSM, they are handed values.
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

# Only bootstrap.sh is fetched; it pulls docker-compose.yaml through
# REPO_RAW_BASE. Both come from the repo unmodified, so what boots here is
# what was tested on a laptop. Only the environment below differs.
STACK_DIR=/home/ec2-user/convex-backend
mkdir -p "$STACK_DIR"
cd "$STACK_DIR"

curl -fsSL -o bootstrap.sh ${SELF_HOSTED_CONVEX_REPO}/bootstrap.sh
chmod +x bootstrap.sh

# The connection string lives in SSM, not here: userData is readable by
# anyone with ec2:DescribeInstanceAttribute. AL2023 ships the AWS CLI.
POSTGRES_URL="$(aws ssm get-parameter --name '${postgresUrlParameter.name}' \\
  --with-decryption --query Parameter.Value --output text --region ${REGION})"

# The backend's identity, same route. Constant across every host this stage
# runs, which is what keeps admin keys valid through a replacement.
INSTANCE_SECRET="$(aws ssm get-parameter --name '${instanceSecretParameter.name}' \\
  --with-decryption --query Parameter.Value --output text --region ${REGION})"

# Bucket names and credentials, same route. Exported rather than listed
# below, since which S3 variables matter is bootstrap.sh's business. Deleted
# once sourced, so the secret lives in one file, the .env at mode 600.
umask 077
aws ssm get-parameter --name '${storageEnvParameter.name}' \\
  --with-decryption --query Parameter.Value --output text --region ${REGION} \\
  > storage.env
set -a
. ./storage.env
set +a
rm -f storage.env
umask 022

# USE_HTTPS because these are real hostnames, so Caddy takes a Let's Encrypt
# certificate; a laptop run leaves it unset. POSTGRES_CA_URL because RDS
# presents a private Amazon CA the backend otherwise rejects as UnknownIssuer.

# Double quotes are enough around the password: SST generates 32
# alphanumerics with special:false.
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

# bootstrap.sh creates the database, brings the stack up, waits for health and
# puts the admin key in SSM. Unset, ADMIN_KEY_PARAMETER leaves it on disk.
chown -R ec2-user:ec2-user "$STACK_DIR"
`

    const instance = new aws.ec2.Instance(
      "ConvexInstance",
      {
        ami: ami.id,
        instanceType: "t4g.small",
        // publicSubnets is an Output<string[]>; one instance needs the first.
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
        // Convex actions run app code that can fetch any URL from this box,
        // and 169.254.169.254 would hand over the role. A hop limit of 1 cuts
        // the containers off; the docker bridge costs them the one hop.
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

    // Caddy solves an HTTP-01 challenge, so these must resolve before it
    // starts. They point at the Elastic IP, so they survive a replacement.
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

    // A streaming Lambda behind CloudFront on the same `domain` the Convex
    // hostnames hang off. Needs Nitro's `aws-lambda` preset from
    // apps/web/vite.config.ts. `sst dev` returns a placeholder instead.
    const web = new sst.aws.TanStackStart("Web", {
      path: "apps/web",
      domain,
      // VITE_ variables are inlined into the client bundle, so everything
      // here ships to the browser. Never put a secret in it.
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

    // `sst dev` runs the compose stack, `convex dev` and the Vite server, and
    // SST skips DevCommands on deploy. The local backend gets this stage's
    // real buckets: storage keys are rows, and the database is not shared.
    const convexStack = new sst.x.DevCommand("Convex", {
      dev: {
        title: "convex stack",
        command: "docker compose up",
        autostart: true,
      },
      environment: storageEnvironment,
    })

    // The CLI cannot push until the backend answers, so a script waits and
    // mints the key on the first run. dependsOn orders resources, not tasks.
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
