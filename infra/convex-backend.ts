/// <reference path="../.sst/platform/config.d.ts" />

/**
 * A self-hosted Convex backend on one EC2 instance.
 *
 * What it builds, per stage:
 *
 *   - an arm64 Amazon Linux 2023 instance in a public subnet of the given VPC
 *   - an Elastic IP and three Route 53 A records pointing at it:
 *     `api.<domain>`, `site.<domain>`, `dashboard.<domain>`
 *   - a system-level Caddy that terminates TLS with Let's Encrypt (DNS-01 via
 *     Route 53) and proxies each hostname to a loopback port
 *   - the compose stack from `self-hosted-convex/docker-compose.yml`, embedded
 *     into userData so what boots on the box is what was tested locally
 *   - two SSM SecureString parameters: the instance secret (stable across
 *     host replacements, so admin keys keep working) and the admin key the
 *     backend mints for itself a few minutes into its first boot
 *
 * Data lives in SQLite inside the `data` docker volume on the root disk. No
 * Postgres, no S3: replacing the instance loses the deployment's data.
 *
 * Usage:
 *
 *   const convex = new ConvexBackend("Convex", {
 *     vpc,
 *     domain: "dev.fullstackaws.dev",
 *     zone: "fullstackaws.dev",
 *   })
 *   // convex.url        -> https://api.dev.fullstackaws.dev
 *   // convex.adminKeyParameter -> SSM path of the admin key
 */

import { readFileSync } from "node:fs"
import path from "node:path"

const COMPOSE_PLUGIN_VERSION = "v5.5.0"
const COMPOSE_FILE = "self-hosted-convex/docker-compose.yml"
const CADDY_DOWNLOAD_URL =
  "https://caddyserver.com/api/download?os=linux&arch=arm64&p=github.com/caddy-dns/route53"

// Convex ports, all bound to loopback by the compose file.
const PORT = { api: 3210, site: 3211, dashboard: 6791 }

// What the parameters hold until the instance writes the real values.
const PENDING = "pending: written by the instance on first boot"

export interface ConvexBackendArgs {
  /**
   * The VPC to launch the instance in. The instance lands in the first public
   * subnet, so the VPC needs at least one; no NAT gateway is required.
   */
  vpc: sst.aws.Vpc
  /**
   * The base domain. The backend answers on `api.`, `site.` and `dashboard.`
   * under it, e.g. `fullstackaws.dev` or `dev.fullstackaws.dev`.
   */
  domain: $util.Input<string>
  /**
   * The Route 53 hosted zone the records go in. Needed when `domain` is a
   * subdomain of the zone.
   * @default The `domain`.
   */
  zone?: $util.Input<string>
  /**
   * EC2 instance type. Must be arm64 (Graviton): the AMI is arm64 and Convex
   * publishes linux/arm64 images.
   * @default "t4g.small"
   */
  instanceType?: $util.Input<string>
  /**
   * Root volume size in GiB. Holds the Docker images and the Convex data.
   * @default 30
   */
  volumeSize?: $util.Input<number>
  /**
   * Issue certificates from Let's Encrypt's staging CA. Browsers reject those,
   * but the production CA allows only 5 duplicate certificates per hostname
   * per week, and every instance replacement issues three fresh ones.
   * @default false
   */
  letsEncryptStaging?: boolean
  /**
   * Escape hatch: override the args of the underlying resources.
   */
  transform?: {
    instance?: Partial<aws.ec2.InstanceArgs>
    securityGroup?: Partial<aws.ec2.SecurityGroupArgs>
  }
}

export class ConvexBackend extends $util.ComponentResource {
  private readonly _hosts: { api: $util.Output<string>; site: $util.Output<string>; dashboard: $util.Output<string> }
  private readonly instance: aws.ec2.Instance
  private readonly eip: aws.ec2.Eip
  private readonly securityGroup: aws.ec2.SecurityGroup
  private readonly role: aws.iam.Role
  private readonly instanceSecretParameter: aws.ssm.Parameter
  private readonly _adminKeyParameter: aws.ssm.Parameter
  private readonly _instanceName: string

  constructor(
    name: string,
    args: ConvexBackendArgs,
    opts: $util.ComponentResourceOptions = {}
  ) {
    super("workspace:index:ConvexBackend", name, args, opts)
    const parent = this

    const domain = $util.output(args.domain)
    const zoneName = $util.output(args.zone ?? args.domain)
    const region = aws.getRegionOutput().region

    // What the backend identifies itself as. Admin keys are minted from and
    // checked against this and the instance secret.
    this._instanceName = `${$app.name}-${$app.stage}`

    this._hosts = {
      api: $interpolate`api.${domain}`,
      site: $interpolate`site.${domain}`,
      dashboard: $interpolate`dashboard.${domain}`,
    }

    const zone = aws.route53.getZoneOutput({ name: zoneName, privateZone: false })

    // ---- network ----------------------------------------------------------

    // 3210/3211/6791 stay closed. Caddy proxies them from loopback; opening
    // them means an unencrypted backend and a public admin dashboard. No port
    // 22 either: shells go through SSM Session Manager.
    this.securityGroup = new aws.ec2.SecurityGroup(
      `${name}SecurityGroup`,
      {
        vpcId: args.vpc.id,
        description: "Convex self-hosted: HTTP/HTTPS via Caddy",
        ingress: [
          { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"], description: "HTTP: redirect to HTTPS" },
          { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"], description: "HTTPS" },
        ],
        egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
        ...args.transform?.securityGroup,
      },
      { parent }
    )

    // Allocated apart from the instance so the address survives a
    // replacement. The DNS records point here, not at the instance.
    this.eip = new aws.ec2.Eip(`${name}Eip`, { domain: "vpc" }, { parent })

    // ---- parameters -------------------------------------------------------

    // Both hold a placeholder at create and the real value once the instance
    // writes it, so no secret ever passes through Pulumi state or userData.
    // ignoreChanges stops the next deploy from putting the placeholder back.
    const parameterPrefix = `/${$app.name}/${$app.stage}/convex`

    // Constant across every host this stage runs: generated by the first
    // instance, read back by every replacement. Deleting it invalidates every
    // admin key at once.
    this.instanceSecretParameter = new aws.ssm.Parameter(
      `${name}InstanceSecret`,
      { name: `${parameterPrefix}/instance-secret`, type: "SecureString", value: PENDING },
      { parent, ignoreChanges: ["value"] }
    )

    // A root credential: read and write on every table plus function push.
    // Only the running backend can mint it, so userData publishes it once the
    // backend answers.
    this._adminKeyParameter = new aws.ssm.Parameter(
      `${name}AdminKey`,
      { name: `${parameterPrefix}/admin-key`, type: "SecureString", value: PENDING },
      { parent, ignoreChanges: ["value"] }
    )

    // ---- instance role ----------------------------------------------------

    this.role = new aws.iam.Role(
      `${name}Role`,
      {
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            { Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" },
          ],
        }),
      },
      { parent }
    )

    // Session Manager: `aws ssm start-session --target <instanceId>` for a
    // shell with no inbound port.
    new aws.iam.RolePolicyAttachment(
      `${name}SsmCore`,
      { role: this.role.name, policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" },
      { parent }
    )

    const policy = new aws.iam.RolePolicy(
      `${name}Policy`,
      {
        role: this.role.name,
        policy: {
          Version: "2012-10-17",
          Statement: [
            {
              // userData reads the instance secret and writes both parameters.
              Effect: "Allow",
              Action: ["ssm:GetParameter", "ssm:PutParameter"],
              Resource: [this.instanceSecretParameter.arn, this._adminKeyParameter.arn],
            },
            {
              // Caddy's route53 plugin solves the DNS-01 challenge by writing
              // TXT records into the zone.
              Effect: "Allow",
              Action: ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"],
              Resource: [$interpolate`arn:aws:route53:::hostedzone/${zone.zoneId}`],
            },
            {
              Effect: "Allow",
              Action: ["route53:ListHostedZones", "route53:ListHostedZonesByName", "route53:GetChange"],
              Resource: ["*"],
            },
          ],
        },
      },
      { parent }
    )

    const instanceProfile = new aws.iam.InstanceProfile(
      `${name}InstanceProfile`,
      { role: this.role.name },
      { parent }
    )

    // ---- boot script ------------------------------------------------------

    // Read at deploy time and embedded whole, so what boots on the box is the
    // file tested locally. Passed as a value, not inlined into the template,
    // so its `${PORT:-3210}` style defaults survive untouched.
    const composeFile = readFileSync(path.join($cli.paths.root, COMPOSE_FILE), "utf8")

    // wait_for_route53_sync holds the challenge until Route 53 reports the
    // TXT record on all four of its nameservers. Without it Caddy sees the
    // record on one and tells Let's Encrypt to check, whose multi-perspective
    // validation then hits a nameserver that does not have it yet and fails
    // with NXDOMAIN "during secondary validation". Seen on the first deploy.
    const caddyfile = $util
      .all([this._hosts.api, this._hosts.site, this._hosts.dashboard, zoneName, zone.zoneId])
      .apply(([api, site, dashboard, zone, zoneId]) =>
        [
          "{",
          `\temail admin@${zone}`,
          "\tacme_dns route53 {",
          `\t\thosted_zone_id ${zoneId}`,
          "\t\twait_for_route53_sync true",
          "\t}",
          ...(args.letsEncryptStaging
            ? ["\tacme_ca https://acme-staging-v02.api.letsencrypt.org/directory"]
            : []),
          "}",
          "",
          "(proxy) {",
          "\tencode zstd gzip",
          "\treverse_proxy {args[0]}",
          "}",
          "",
          `${api} {`,
          `\timport proxy 127.0.0.1:${PORT.api}`,
          "}",
          "",
          `${site} {`,
          `\timport proxy 127.0.0.1:${PORT.site}`,
          "}",
          "",
          `${dashboard} {`,
          `\timport proxy 127.0.0.1:${PORT.dashboard}`,
          "}",
          "",
        ].join("\n")
      )

    // Origins must be the public URLs Caddy serves, otherwise the backend and
    // dashboard generate 127.0.0.1 links. The secret is appended at boot.
    const composeEnv = $util
      .all([this._hosts.api, this._hosts.site])
      .apply(([api, site]) =>
        [
          `CONVEX_CLOUD_ORIGIN=https://${api}`,
          `CONVEX_SITE_ORIGIN=https://${site}`,
          `NEXT_PUBLIC_DEPLOYMENT_URL=https://${api}`,
          `INSTANCE_NAME=${this._instanceName}`,
        ].join("\n")
      )

    const userData = $interpolate`#!/bin/bash
# No -x: this script handles the instance secret and the admin key, and
# everything it echoes lands in the cloud-init log.
set -euo pipefail

export AWS_DEFAULT_REGION=${region}

# ---- docker ----

# The AMI lookup is mostRecent, so base packages start current. Patch by
# replacing the instance, not mutating it.
dnf install -y docker

# AL2023 ships the Docker engine in its repos but not the compose plugin.
install -m 0755 -d /usr/local/lib/docker/cli-plugins
curl -fsSL --retry 3 -o /usr/local/lib/docker/cli-plugins/docker-compose \\
  https://github.com/docker/compose/releases/download/${COMPOSE_PLUGIN_VERSION}/docker-compose-linux-aarch64
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

systemctl enable --now docker

# ---- caddy ----

# The download API builds Caddy with the route53 DNS plugin, so no Go
# toolchain is needed on the box.
curl -fsSL --retry 3 -o /usr/bin/caddy '${CADDY_DOWNLOAD_URL}'
chmod +x /usr/bin/caddy

groupadd --system caddy
useradd --system --gid caddy --home-dir /var/lib/caddy --create-home \\
  --shell /sbin/nologin caddy

install -m 0755 -d /etc/caddy
cat > /etc/caddy/Caddyfile <<'EOF'
${caddyfile}
EOF

# The upstream unit, plus the region the route53 plugin's AWS SDK needs.
# Credentials come from the instance profile through IMDS: Caddy runs on the
# host, so the hop limit below does not cut it off.
cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
Environment=AWS_REGION=${region}
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

# ---- convex ----

STACK_DIR=/opt/convex
install -m 0755 -d "$STACK_DIR"
cd "$STACK_DIR"

cat > docker-compose.yml <<'EOF'
${composeFile}
EOF

# The first host to boot generates the secret and publishes it; every host
# after that reads it back, which is what keeps admin keys valid through a
# replacement. It never touches userData, which anyone with
# ec2:DescribeInstanceAttribute can read.
INSTANCE_SECRET="$(aws ssm get-parameter --name '${this.instanceSecretParameter.name}' \\
  --with-decryption --query Parameter.Value --output text)"
if [ "$INSTANCE_SECRET" = '${PENDING}' ]; then
  INSTANCE_SECRET="$(openssl rand -hex 32)"
  aws ssm put-parameter --name '${this.instanceSecretParameter.name}' \\
    --type SecureString --overwrite --value "$INSTANCE_SECRET"
fi

umask 077
cat > .env <<'EOF'
${composeEnv}
EOF
echo "INSTANCE_SECRET=$INSTANCE_SECRET" >> .env
umask 022

docker compose up -d

# Caddy after the stack, so the proxy targets exist when it starts. Compose
# services carry restart: unless-stopped, so a reboot needs none of this.
systemctl daemon-reload
systemctl enable --now caddy

# ---- admin key ----

# The backend has to be up to mint it. The healthcheck in the compose file
# uses the same URL.
for _ in $(seq 1 60); do
  curl -sf http://127.0.0.1:${PORT.api}/version > /dev/null && break
  sleep 5
done

# generate_admin_key.sh prints a heading line and then the key.
ADMIN_KEY="$(docker compose exec -T backend ./generate_admin_key.sh | tail -n 1 | tr -d '[:space:]')"
aws ssm put-parameter --name '${this._adminKeyParameter.name}' \\
  --type SecureString --overwrite --value "$ADMIN_KEY"
`

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

    this.instance = new aws.ec2.Instance(
      `${name}Instance`,
      {
        ami: ami.id,
        instanceType: args.instanceType ?? "t4g.small",
        subnetId: args.vpc.publicSubnets.apply((subnets) => subnets[0]),
        vpcSecurityGroupIds: [this.securityGroup.id],
        iamInstanceProfile: instanceProfile.name,
        // Needed before the Elastic IP associates, or the instance has no
        // route out and every curl in userData hangs.
        associatePublicIpAddress: true,
        rootBlockDevice: {
          volumeSize: args.volumeSize ?? 30,
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
        ...args.transform?.instance,
      },
      // The boot script's first AWS calls are the parameter fetches; without
      // this the instance can boot before its permission exists.
      { parent, dependsOn: [policy] }
    )

    new aws.ec2.EipAssociation(
      `${name}EipAssociation`,
      { instanceId: this.instance.id, allocationId: this.eip.allocationId },
      { parent }
    )

    // ---- dns --------------------------------------------------------------

    // DNS-01 needs none of these to issue certificates, but clients do.
    for (const [key, host] of Object.entries(this._hosts)) {
      new aws.route53.Record(
        `${name}${key[0].toUpperCase()}${key.slice(1)}Record`,
        {
          zoneId: zone.zoneId,
          name: host,
          type: "A",
          ttl: 60,
          records: [this.eip.publicIp],
        },
        { parent }
      )
    }

    this.registerOutputs({
      url: this.url,
      siteUrl: this.siteUrl,
      dashboardUrl: this.dashboardUrl,
      publicIp: this.publicIp,
      instanceId: this.instanceId,
      adminKeyParameter: this._adminKeyParameter.name,
    })
  }

  /** The API URL clients connect to, e.g. `https://api.example.com`. */
  get url(): $util.Output<string> {
    return $interpolate`https://${this._hosts.api}`
  }

  /** Where HTTP actions are served. */
  get siteUrl(): $util.Output<string> {
    return $interpolate`https://${this._hosts.site}`
  }

  /** The Convex dashboard. Login needs the admin key. */
  get dashboardUrl(): $util.Output<string> {
    return $interpolate`https://${this._hosts.dashboard}`
  }

  /** The Elastic IP the hostnames resolve to. */
  get publicIp(): $util.Output<string> {
    return this.eip.publicIp
  }

  get instanceId(): $util.Output<string> {
    return this.instance.id
  }

  /** The INSTANCE_NAME the backend runs as, and the prefix of every admin key. */
  get instanceName(): string {
    return this._instanceName
  }

  /**
   * SSM path of the admin key. Holds a placeholder until the backend has
   * minted it, a few minutes after the first boot:
   *
   *   aws ssm get-parameter --with-decryption --query Parameter.Value \
   *     --output text --name <this>
   */
  get adminKeyParameter(): $util.Output<string> {
    return this._adminKeyParameter.name
  }

  /** The underlying resources. */
  get nodes() {
    return {
      instance: this.instance,
      eip: this.eip,
      securityGroup: this.securityGroup,
      role: this.role,
      instanceSecretParameter: this.instanceSecretParameter,
      adminKeyParameter: this._adminKeyParameter,
    }
  }

  /**
   * `link: [convex]` gives a function `Resource.<Name>.url` and
   * `.adminKeyParameter`, plus permission to read the key.
   */
  getSSTLink() {
    return {
      properties: {
        url: this.url,
        siteUrl: this.siteUrl,
        dashboardUrl: this.dashboardUrl,
        adminKeyParameter: this._adminKeyParameter.name,
      },
      include: [
        sst.aws.permission({
          actions: ["ssm:GetParameter"],
          resources: [this._adminKeyParameter.arn],
        }),
      ],
    }
  }
}
