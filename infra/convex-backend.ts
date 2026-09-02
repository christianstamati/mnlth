/// <reference path="../.sst/platform/config.d.ts" />

/**
 * A self-hosted Convex backend on one EC2 instance.
 *
 * What it builds, per stage:
 *
 *   - an arm64 Amazon Linux 2023 instance in a public subnet of the given VPC
 *   - three Route 53 A records, `<prefix>api.<domain>`, `<prefix>site.<domain>`
 *     and `<prefix>dashboard.<domain>`, pointing at the instance's public
 *     address or, with `elasticIp`, at an Elastic IP that survives replacement
 *   - a system-level Caddy that terminates TLS with one Let's Encrypt wildcard
 *     certificate for `*.<domain>` (DNS-01 via Route 53) and proxies each
 *     hostname to a loopback port. Caddy keeps the certificate in a shared S3
 *     bucket, so it is issued once and reused by every stage and every
 *     replacement instance; renewal happens once for all of them too.
 *   - the compose stack (`COMPOSE_FILE` below), embedded
 *     into userData so what boots on the box is what was tested locally
 *   - two SSM SecureString parameters: the instance secret (stable across
 *     host replacements, so admin keys keep working) and the admin key the
 *     backend mints for itself a few minutes into its first boot
 *   - optionally an RDS Postgres or MySQL database (`database`) and five S3
 *     buckets for files, modules, exports and search indexes (`storage`).
 *     With the defaults, SQLite and files live on the root volume and a
 *     replaced instance starts empty.
 *
 * Usage:
 *
 *   const convex = new ConvexBackend("Convex", {
 *     vpc,
 *     certificateBucket,
 *     domain: "fullstackaws.dev",
 *     prefix: "dev-",
 *     elasticIp: false,
 *     storage: "s3",
 *     database: { engine: "postgres", instance: "t4g.micro" },
 *   })
 *   // convex.url        -> https://dev-api.fullstackaws.dev
 *   // convex.adminKeyParameter -> SSM path of the admin key
 */

const COMPOSE_PLUGIN_VERSION = "v5.5.0"

// The compose stack the instance runs, written to /convex/docker-compose.yml
// at boot. `\${VAR:-default}` is Compose's own substitution, escaped here so
// the template literal leaves it alone. Runnable locally too: paste it into
// a docker-compose.yml and `docker compose up -d`.
const COMPOSE_FILE = `
services:
  backend:
    image: ghcr.io/get-convex/convex-backend:latest
    stop_grace_period: 10s
    stop_signal: SIGINT
    restart: unless-stopped
    ports:
      - "127.0.0.1:\${PORT:-3210}:3210"
      - "127.0.0.1:\${SITE_PROXY_PORT:-3211}:3211"
    volumes:
      - data:/convex/data
      # CA bundles for PG_CA_FILE, e.g. the RDS one. Empty locally.
      - ./certs:/convex/certs:ro
    environment:
      - V8_ACTION_USER_TIMEOUT_SECS
      - NODE_ACTION_USER_TIMEOUT_SECS
      - APPLICATION_MAX_CONCURRENT_MUTATIONS=\${APPLICATION_MAX_CONCURRENT_MUTATIONS:-16}
      - APPLICATION_MAX_CONCURRENT_NODE_ACTIONS=\${APPLICATION_MAX_CONCURRENT_NODE_ACTIONS:-16}
      - APPLICATION_MAX_CONCURRENT_QUERIES=\${APPLICATION_MAX_CONCURRENT_QUERIES:-16}
      - APPLICATION_MAX_CONCURRENT_V8_ACTIONS=\${APPLICATION_MAX_CONCURRENT_V8_ACTIONS:-16}
      - AWS_ACCESS_KEY_ID
      - AWS_REGION
      - AWS_S3_DISABLE_CHECKSUMS
      - AWS_S3_DISABLE_SSE
      - AWS_S3_FORCE_PATH_STYLE
      - AWS_SECRET_ACCESS_KEY
      - AWS_SESSION_TOKEN
      - CONVEX_CLOUD_ORIGIN=\${CONVEX_CLOUD_ORIGIN:-http://127.0.0.1:\${PORT:-3210}}
      - CONVEX_RELEASE_VERSION_DEV
      - CONVEX_SITE_ORIGIN=\${CONVEX_SITE_ORIGIN:-http://127.0.0.1:\${SITE_PROXY_PORT:-3211}}
      - DATABASE_URL
      - DISABLE_BEACON
      - DISABLE_METRICS_ENDPOINT=\${DISABLE_METRICS_ENDPOINT:-true} # Enable if you want prometheus compatible /metrics endpoint
      - DOCUMENT_RETENTION_DELAY=\${DOCUMENT_RETENTION_DELAY:-172800} # Lower default document retention to 2 days
      - DO_NOT_REQUIRE_SSL
      - HTTP_SERVER_TIMEOUT_SECONDS
      - INSTANCE_NAME
      - INSTANCE_SECRET
      - MYSQL_URL
      - PG_CA_FILE
      - POSTGRES_URL
      - REDACT_LOGS_TO_CLIENT
      - RUST_BACKTRACE
      - RUST_LOG=\${RUST_LOG:-info}
      - S3_ENDPOINT_URL
      - S3_STORAGE_EXPORTS_BUCKET
      - S3_STORAGE_FILES_BUCKET
      - S3_STORAGE_MODULES_BUCKET
      - S3_STORAGE_SEARCH_BUCKET
      - S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET
    healthcheck:
      test: curl -f http://localhost:3210/version
      interval: 5s
      start_period: 10s

  dashboard:
    image: ghcr.io/get-convex/convex-dashboard:latest
    stop_grace_period: 10s
    stop_signal: SIGINT
    restart: unless-stopped
    ports:
      - "127.0.0.1:\${DASHBOARD_PORT:-6791}:6791"
    environment:
      - NEXT_PUBLIC_DEPLOYMENT_URL=\${NEXT_PUBLIC_DEPLOYMENT_URL:-http://127.0.0.1:\${PORT:-3210}}
      - NEXT_PUBLIC_LOAD_MONACO_INTERNALLY
    depends_on:
      backend:
        condition: service_healthy

volumes:
  data:
`

// Caddy with plugins: Route 53 for the DNS-01 challenge and S3 for shared
// certificate storage. Caddy's download API compiles that on request, which
// took seven minutes per boot, so the build is published once as a release
// asset of https://github.com/christianstamati/caddy-linux-arm64 and the
// instance only downloads the latest one.
const CADDY_DOWNLOAD_URL =
  "https://github.com/christianstamati/caddy-linux-arm64/releases/latest/download/caddy-linux-arm64"

// Convex ports, all bound to loopback by the compose file.
const PORT = { api: 3210, site: 3211, dashboard: 6791 }

// What the parameters hold until the instance writes the real values.
const PENDING = "pending: written by the instance on first boot"

// The five buckets the backend moves off the container volume when `storage`
// is "s3", keyed by the environment variable the compose file forwards.
// https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/s3_storage.md
const STORAGE_BUCKETS = {
  S3_STORAGE_EXPORTS_BUCKET: "Exports",
  S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET: "SnapshotImports",
  S3_STORAGE_MODULES_BUCKET: "Modules",
  S3_STORAGE_FILES_BUCKET: "Files",
  S3_STORAGE_SEARCH_BUCKET: "Search",
} as const

export type ConvexDatabaseEngine = "sqlite" | "postgres" | "mysql"

/**
 * A managed database. The object form takes the arguments of the matching
 * SST component, minus `vpc` (the component's own) and `database` (the
 * backend requires the name to match its instance name).
 */
export type ConvexDatabaseArgs =
  | ConvexDatabaseEngine
  | ({ engine: "postgres" } & Omit<sst.aws.PostgresArgs, "vpc" | "database">)
  | ({ engine: "mysql" } & Omit<sst.aws.MysqlArgs, "vpc" | "database">)

export interface ConvexBackendArgs {
  /**
   * The VPC to launch the instance in. The instance lands in the first public
   * subnet, so the VPC needs at least one; no NAT gateway is required. A
   * managed database lands in the private subnets.
   */
  vpc: sst.aws.Vpc
  /**
   * Where Caddy stores certificates, keys and its ACME account. Shared by
   * every stage, so the wildcard certificate is obtained once and reused.
   * Holds the private key for `*.<domain>`: every stage's instance role can
   * read it, so a compromised box of any stage exposes production's key.
   */
  certificateBucket: sst.aws.Bucket
  /**
   * The Route 53 hosted zone the hostnames live in, e.g. `fullstackaws.dev`.
   * The certificate is a wildcard for `*.<domain>`, so the hostnames must sit
   * directly under it: one label, no nesting.
   */
  domain: $util.Input<string>
  /**
   * Prepended to each hostname, e.g. `dev-` gives `dev-api.<domain>`. Empty
   * for the apex names `api.<domain>`, `site.<domain>`, `dashboard.<domain>`.
   * @default ""
   */
  prefix?: $util.Input<string>
  /**
   * Allocate an Elastic IP and point the DNS records at it, so the address
   * survives an instance replacement. Without it the records follow the
   * instance's own public address, which changes on every replacement and
   * takes the records' 60 second TTL to settle.
   * @default false
   */
  elasticIp?: boolean
  /**
   * Where the backend keeps files, function modules, snapshot exports and
   * search indexes. `"volume"` is the docker volume on the root disk, lost
   * with the instance. `"s3"` provisions five buckets that outlive it.
   *
   * Switching an existing deployment is a `convex export` then a
   * `convex import --replace-all`, not a restart.
   * @default "volume"
   */
  storage?: "volume" | "s3"
  /**
   * Where the backend keeps its tables. `"sqlite"` is a file in the docker
   * volume on the root disk, lost with the instance. `"postgres"` or
   * `"mysql"` provisions an RDS instance in the VPC's private subnets, which
   * takes about ten minutes on first deploy. Pass an object to size it.
   *
   * Postgres connects over TLS, trusting the RDS certificate bundle. MySQL
   * connects in the clear inside the VPC: the backend has no way to trust a
   * custom CA for MySQL, and SST's parameter group does not require TLS.
   * @default "sqlite"
   */
  database?: ConvexDatabaseArgs
  /**
   * EC2 instance type. Must be arm64 (Graviton): the AMI is arm64 and Convex
   * publishes linux/arm64 images.
   * @default "t4g.small"
   */
  instanceType?: $util.Input<string>
  /**
   * Root volume size in GiB. Holds the Docker images and, with the default
   * `storage` and `database`, all of the backend's data.
   * @default 30
   */
  volumeSize?: $util.Input<number>
  /**
   * The id of an EC2 key pair (`key-...`) to install on the instance for
   * `ec2-user`. Assigned at launch: changing it replaces the instance. With a
   * key pair, port 22 is open to everyone; without one, only to EC2 Instance
   * Connect's addresses.
   */
  keyPairId?: $util.Input<string>
  /**
   * Issue certificates from Let's Encrypt's staging CA. Browsers reject those,
   * but the production CA allows only 5 duplicate certificates per hostname
   * per week. With the shared certificate bucket this matters only when the
   * bucket is empty or has been cleared.
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
  private readonly _hosts: {
    api: $util.Output<string>
    site: $util.Output<string>
    dashboard: $util.Output<string>
  }
  private readonly instance: aws.ec2.Instance
  private readonly eip?: aws.ec2.Eip
  private readonly securityGroup: aws.ec2.SecurityGroup
  private readonly role: aws.iam.Role
  private readonly instanceSecretParameter: aws.ssm.Parameter
  private readonly _adminKeyParameter: aws.ssm.Parameter
  private readonly _urlParameter: aws.ssm.Parameter
  private readonly database?: sst.aws.Postgres | sst.aws.Mysql
  private readonly storageBuckets?: Record<
    keyof typeof STORAGE_BUCKETS,
    sst.aws.Bucket
  >
  private readonly _instanceName: string

  constructor(
    name: string,
    args: ConvexBackendArgs,
    opts: $util.ComponentResourceOptions = {}
  ) {
    super("workspace:index:ConvexBackend", name, args, opts)
    const parent = this

    const domain = $util.output(args.domain)
    const prefix = $util.output(args.prefix ?? "")
    const region = aws.getRegionOutput().region

    // What the backend identifies itself as: the stage, so admin keys read
    // `<stage>|...`. Keys are minted from and checked against this and the
    // instance secret, and a managed database is named after it with `-`
    // swapped for `_`.
    this._instanceName = $app.stage
    const databaseName = this._instanceName.replace(/-/g, "_")

    this._hosts = {
      api: $interpolate`${prefix}api.${domain}`,
      site: $interpolate`${prefix}site.${domain}`,
      dashboard: $interpolate`${prefix}dashboard.${domain}`,
    }

    const zone = aws.route53.getZoneOutput({ name: domain, privateZone: false })

    // ---- network ----------------------------------------------------------

    // 3210/3211/6791 stay closed. Caddy proxies them from loopback; opening
    // them means an unencrypted backend and a public admin dashboard. Port 22
    // admits everyone when a key pair is installed (the key is the lock),
    // otherwise only EC2 Instance Connect's own addresses, which AWS
    // publishes as a managed prefix list per region. Shells otherwise go
    // through SSM Session Manager.
    const instanceConnect = aws.ec2.getManagedPrefixListOutput({
      name: $interpolate`com.amazonaws.${region}.ec2-instance-connect`,
    })
    const ssh = args.keyPairId
      ? {
          protocol: "tcp",
          fromPort: 22,
          toPort: 22,
          cidrBlocks: ["0.0.0.0/0"],
          description: "SSH: key pair",
        }
      : {
          protocol: "tcp",
          fromPort: 22,
          toPort: 22,
          prefixListIds: [instanceConnect.id],
          description: "SSH: EC2 Instance Connect",
        }

    this.securityGroup = new aws.ec2.SecurityGroup(
      `${name}SecurityGroup`,
      {
        vpcId: args.vpc.id,
        description: "Convex self-hosted: HTTP/HTTPS via Caddy",
        ingress: [
          {
            protocol: "tcp",
            fromPort: 80,
            toPort: 80,
            cidrBlocks: ["0.0.0.0/0"],
            description: "HTTP: redirect to HTTPS",
          },
          {
            protocol: "tcp",
            fromPort: 443,
            toPort: 443,
            cidrBlocks: ["0.0.0.0/0"],
            description: "HTTPS",
          },
          ssh,
        ],
        egress: [
          { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
        ],
        ...args.transform?.securityGroup,
      },
      { parent }
    )

    // Allocated apart from the instance so the address survives a
    // replacement. The DNS records point here, not at the instance.
    if (args.elasticIp) {
      this.eip = new aws.ec2.Eip(`${name}Eip`, { domain: "vpc" }, { parent })
    }

    // ---- parameters -------------------------------------------------------

    // The instance reads everything secret from SSM at boot, so no secret
    // passes through userData, which anyone with
    // ec2:DescribeInstanceAttribute can read.
    const parameterPrefix = `/${$app.name}/${$app.stage}/convex`

    // Both hold a placeholder at create and the real value once the instance
    // writes it, so these two never pass through Pulumi state either.
    // ignoreChanges stops the next deploy from putting the placeholder back.

    // Constant across every host this stage runs: generated by the first
    // instance, read back by every replacement. Deleting it invalidates every
    // admin key at once.
    this.instanceSecretParameter = new aws.ssm.Parameter(
      `${name}InstanceSecret`,
      {
        name: `${parameterPrefix}/instance-secret`,
        type: "SecureString",
        value: PENDING,
      },
      { parent, ignoreChanges: ["value"] }
    )

    // A root credential: read and write on every table plus function push.
    // Only the running backend can mint it, so userData publishes it once the
    // backend answers.
    this._adminKeyParameter = new aws.ssm.Parameter(
      `${name}AdminKey`,
      {
        name: `${parameterPrefix}/admin-key`,
        type: "SecureString",
        value: PENDING,
      },
      { parent, ignoreChanges: ["value"] }
    )

    // The API URL, so `scripts/convex-deploy.ts` can find the deployment
    // from the stage name alone.
    this._urlParameter = new aws.ssm.Parameter(
      `${name}Url`,
      { name: `${parameterPrefix}/url`, type: "String", value: this.url },
      { parent }
    )

    // ---- database ---------------------------------------------------------

    // Each holds a block of KEY=value lines the instance appends to the
    // compose .env at boot.
    const envParameters: aws.ssm.Parameter[] = []

    // The box lands in the first public subnet. A managed database is pinned
    // to the same availability zone: neither is replicated across zones, so
    // spreading them adds latency and cross-zone transfer fees for nothing.
    const instanceSubnetId = args.vpc.publicSubnets.apply(
      (subnets) => subnets[0]
    )
    const availabilityZone = aws.ec2.getSubnetOutput({
      id: instanceSubnetId,
    }).availabilityZone

    const database =
      typeof args.database === "string"
        ? { engine: args.database }
        : (args.database ?? { engine: "sqlite" as const })

    if (database.engine !== "sqlite") {
      const { engine, ...databaseArgs } = database
      // Both SST components take the same transform shape for the instance.
      type InstanceTransform = NonNullable<sst.aws.MysqlArgs["transform"]>
      const transform = (databaseArgs as { transform?: InstanceTransform })
        .transform
      const databaseTransform: InstanceTransform = {
        ...transform,
        instance: (instanceArgs, opts, resourceName) => {
          instanceArgs.availabilityZone = availabilityZone
          if (typeof transform?.instance === "function") {
            transform.instance(instanceArgs, opts, resourceName)
          } else if (transform?.instance) {
            Object.assign(instanceArgs, transform.instance)
          }
        },
      }

      // RDS creates the database at launch, so the box needs no SQL client.
      // The backend connects to the database named after INSTANCE_NAME.
      this.database =
        engine === "postgres"
          ? new sst.aws.Postgres(
              `${name}Database`,
              {
                ...databaseArgs,
                vpc: args.vpc,
                database: databaseName,
                transform: databaseTransform,
              },
              { parent }
            )
          : new sst.aws.Mysql(
              `${name}Database`,
              {
                // SST's default (8.0.40) is no longer offered by RDS.
                version: "8.4.11",
                ...databaseArgs,
                vpc: args.vpc,
                database: databaseName,
                transform: databaseTransform,
              },
              { parent }
            )

      // No database name and no query params: the backend appends its own.
      const url = $interpolate`${engine === "postgres" ? "postgresql" : "mysql"}://${this.database.username}:${this.database.password}@${this.database.host}:${this.database.port}`

      // Postgres verifies the server certificate against PG_CA_FILE, which
      // userData fills with the RDS bundle for this region. The MySQL client
      // has no such hook, and SST's parameter group turns
      // require_secure_transport off, so it connects in the clear.
      const lines =
        engine === "postgres"
          ? [
              $interpolate`POSTGRES_URL=${url}`,
              "PG_CA_FILE=/convex/certs/rds-ca.pem",
            ]
          : [$interpolate`MYSQL_URL=${url}`, "DO_NOT_REQUIRE_SSL=1"]

      envParameters.push(
        new aws.ssm.Parameter(
          `${name}DatabaseEnv`,
          {
            name: `${parameterPrefix}/database-env`,
            type: "SecureString",
            value: $util.all(lines).apply((lines) => lines.join("\n")),
          },
          { parent }
        )
      )
    }

    // ---- storage ----------------------------------------------------------

    if (args.storage === "s3") {
      this.storageBuckets = Object.fromEntries(
        Object.entries(STORAGE_BUCKETS).map(([variable, suffix]) => [
          variable,
          new sst.aws.Bucket(`${name}${suffix}Bucket`, {}, { parent }),
        ])
      ) as Record<keyof typeof STORAGE_BUCKETS, sst.aws.Bucket>

      // An access key, not the instance role: the hop limit on the instance
      // cuts the containers off from IMDS, which is the point, and costs
      // them the role. A user scoped to these five buckets is the smaller
      // blast radius.
      const storageUser = new aws.iam.User(`${name}StorageUser`, {}, { parent })

      new aws.iam.UserPolicy(
        `${name}StoragePolicy`,
        {
          user: storageUser.name,
          policy: {
            Version: "2012-10-17",
            Statement: [
              {
                // The backend reads, writes and deletes. s3:* over five
                // buckets it is the only principal for is narrower than it
                // looks.
                Effect: "Allow",
                Action: ["s3:*"],
                Resource: Object.values(this.storageBuckets).flatMap(
                  (bucket) => [bucket.arn, $interpolate`${bucket.arn}/*`]
                ),
              },
            ],
          },
        },
        { parent }
      )

      const accessKey = new aws.iam.AccessKey(
        `${name}StorageAccessKey`,
        { user: storageUser.name },
        { parent }
      )

      const lines = [
        $interpolate`AWS_REGION=${region}`,
        $interpolate`AWS_ACCESS_KEY_ID=${accessKey.id}`,
        $interpolate`AWS_SECRET_ACCESS_KEY=${accessKey.secret}`,
        ...Object.entries(this.storageBuckets).map(
          ([variable, bucket]) => $interpolate`${variable}=${bucket.name}`
        ),
      ]

      envParameters.push(
        new aws.ssm.Parameter(
          `${name}StorageEnv`,
          {
            name: `${parameterPrefix}/storage-env`,
            type: "SecureString",
            value: $util.all(lines).apply((lines) => lines.join("\n")),
          },
          { parent }
        )
      )
    }

    // ---- instance role ----------------------------------------------------

    this.role = new aws.iam.Role(
      `${name}Role`,
      {
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
      },
      { parent }
    )

    // Session Manager: `aws ssm start-session --target <instanceId>` for a
    // shell with no inbound port.
    new aws.iam.RolePolicyAttachment(
      `${name}SsmCore`,
      {
        role: this.role.name,
        policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
      },
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
              // Exactly the parameters userData reads at boot. This is the
              // instance's own permission; the containers never reach SSM,
              // they are handed values.
              Effect: "Allow",
              Action: ["ssm:GetParameter"],
              Resource: [
                this.instanceSecretParameter.arn,
                ...envParameters.map((parameter) => parameter.arn),
              ],
            },
            {
              // The two it writes: the secret it generates on the first boot
              // and the admin key it mints.
              Effect: "Allow",
              Action: ["ssm:PutParameter"],
              Resource: [
                this.instanceSecretParameter.arn,
                this._adminKeyParameter.arn,
              ],
            },
            {
              // Caddy's S3 storage: certificates, keys, account and the lock
              // it takes before issuing, so two stages never issue at once.
              Effect: "Allow",
              Action: ["s3:ListBucket", "s3:GetBucketLocation"],
              Resource: [args.certificateBucket.arn],
            },
            {
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
              Resource: [$interpolate`${args.certificateBucket.arn}/*`],
            },
            {
              // Caddy's route53 plugin solves the DNS-01 challenge by writing
              // TXT records into the zone.
              Effect: "Allow",
              Action: [
                "route53:ChangeResourceRecordSets",
                "route53:ListResourceRecordSets",
              ],
              Resource: [
                $interpolate`arn:aws:route53:::hostedzone/${zone.zoneId}`,
              ],
            },
            {
              Effect: "Allow",
              Action: [
                "route53:ListHostedZones",
                "route53:ListHostedZonesByName",
                "route53:GetChange",
              ],
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

    // One wildcard site block, so Caddy requests a single `*.<domain>`
    // certificate and routes on the Host header inside it. Anything under the
    // domain that is not one of the three hostnames gets the connection
    // dropped rather than a proxied response.
    //
    // wait_for_route53_sync holds the challenge until Route 53 reports the
    // TXT record on all four of its nameservers. Without it Caddy sees the
    // record on one and tells Let's Encrypt to check, whose multi-perspective
    // validation then hits a nameserver that does not have it yet and fails
    // with NXDOMAIN "during secondary validation". Seen on the first deploy.
    const caddyfile = $util
      .all([
        this._hosts.api,
        this._hosts.site,
        this._hosts.dashboard,
        domain,
        zone.zoneId,
        args.certificateBucket.name,
        region,
      ])
      .apply(([api, site, dashboard, domain, zoneId, bucket, region]) =>
        [
          "{",
          `\temail admin@${domain}`,
          // Credentials come from the instance role through IMDS.
          "\tstorage s3 {",
          `\t\thost s3.${region}.amazonaws.com`,
          `\t\tbucket ${bucket}`,
          "\t\tuse_iam_provider true",
          "\t\tprefix caddy",
          "\t}",
          "\tacme_dns route53 {",
          `\t\thosted_zone_id ${zoneId}`,
          "\t\twait_for_route53_sync true",
          "\t}",
          ...(args.letsEncryptStaging
            ? [
                "\tacme_ca https://acme-staging-v02.api.letsencrypt.org/directory",
              ]
            : []),
          "}",
          "",
          "(proxy) {",
          "\tencode zstd gzip",
          "\treverse_proxy {args[0]}",
          "}",
          "",
          `*.${domain} {`,
          `\t@api host ${api}`,
          `\thandle @api {`,
          `\t\timport proxy 127.0.0.1:${PORT.api}`,
          "\t}",
          "",
          `\t@site host ${site}`,
          `\thandle @site {`,
          `\t\timport proxy 127.0.0.1:${PORT.site}`,
          "\t}",
          "",
          `\t@dashboard host ${dashboard}`,
          `\thandle @dashboard {`,
          `\t\timport proxy 127.0.0.1:${PORT.dashboard}`,
          "\t}",
          "",
          "\thandle {",
          "\t\tabort",
          "\t}",
          "}",
          "",
        ].join("\n")
      )

    // Origins must be the public URLs Caddy serves, otherwise the backend and
    // dashboard generate 127.0.0.1 links. The secrets are appended at boot.
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

    // One fetch per parameter, each a block of lines for .env.
    const fetchEnvParameters = $util
      .all(envParameters.map((parameter) => parameter.name))
      .apply((names) =>
        names
          .map(
            (parameterName) =>
              `aws ssm get-parameter --name '${parameterName}' \\\n` +
              `  --with-decryption --query Parameter.Value --output text >> .env\n` +
              `echo >> .env`
          )
          .join("\n")
      )

    // RDS presents a private Amazon CA the backend otherwise rejects as
    // UnknownIssuer. The compose file mounts ./certs into the container.
    const fetchDatabaseCa =
      database.engine === "postgres"
        ? $interpolate`install -m 0755 -d certs
curl -fsSL --retry 3 -o certs/rds-ca.pem \\
  https://truststore.pki.rds.amazonaws.com/${region}/${region}-bundle.pem`
        : ""

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

# Prebuilt with the plugins above; see CADDY_DOWNLOAD_URL.
curl -fsSL --retry 3 -o /usr/bin/caddy '${CADDY_DOWNLOAD_URL}'
chmod +x /usr/bin/caddy

groupadd --system caddy
useradd --system --gid caddy --home-dir /var/lib/caddy --create-home \\
  --shell /sbin/nologin caddy

install -m 0755 -d /etc/caddy
cat > /etc/caddy/Caddyfile <<'EOF'
${caddyfile}
EOF

# The upstream unit, plus the region the AWS SDK in both plugins needs.
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
${COMPOSE_FILE.trim()}
EOF

${fetchDatabaseCa}

# The first host to boot generates the secret and publishes it; every host
# after that reads it back, which is what keeps admin keys valid through a
# replacement.
INSTANCE_SECRET="$(aws ssm get-parameter --name '${this.instanceSecretParameter.name}' \\
  --with-decryption --query Parameter.Value --output text)"
if [ "$INSTANCE_SECRET" = '${PENDING}' ]; then
  INSTANCE_SECRET="$(openssl rand -hex 32)"
  aws ssm put-parameter --name '${this.instanceSecretParameter.name}' \\
    --type SecureString --overwrite --value "$INSTANCE_SECRET"
fi

# Mode 600: from here on .env holds credentials.
umask 077
cat > .env <<'EOF'
${composeEnv}
EOF
echo "INSTANCE_SECRET=$INSTANCE_SECRET" >> .env
echo >> .env
${fetchEnvParameters}
umask 022

docker compose up -d

# Caddy after the stack, so the proxy targets exist when it starts. Compose
# services carry restart: unless-stopped, so a reboot needs none of this.
systemctl daemon-reload
systemctl enable --now caddy

# ---- admin key ----

# The backend has to be up to mint it. The healthcheck in the compose file
# uses the same URL. Generous, since a managed database adds a schema
# migration to the first start.
for _ in $(seq 1 120); do
  curl -sf http://127.0.0.1:${PORT.api}/version > /dev/null && break
  sleep 5
done

# generate_admin_key.sh prints a heading on stderr and the key on stdout.
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

    // The instance takes a key pair by name, not id.
    const keyName = args.keyPairId
      ? aws.ec2
          .getKeyPairOutput({ keyPairId: args.keyPairId })
          .apply((k) => k.keyName!)
      : undefined

    this.instance = new aws.ec2.Instance(
      `${name}Instance`,
      {
        ami: ami.id,
        instanceType: args.instanceType ?? "t4g.small",
        subnetId: instanceSubnetId,
        keyName,
        vpcSecurityGroupIds: [this.securityGroup.id],
        iamInstanceProfile: instanceProfile.name,
        // The route out during boot. With an Elastic IP it is replaced once
        // the association lands; without one it is the address DNS follows.
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
      // this the instance can boot before its permission, or a parameter
      // still waiting on RDS, exists.
      { parent, dependsOn: [policy, ...envParameters] }
    )

    if (this.eip) {
      new aws.ec2.EipAssociation(
        `${name}EipAssociation`,
        { instanceId: this.instance.id, allocationId: this.eip.allocationId },
        { parent }
      )
    }

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
          records: [this.publicIp],
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

  /**
   * The address the hostnames resolve to: the Elastic IP with `elasticIp`,
   * otherwise the instance's own public address.
   */
  get publicIp(): $util.Output<string> {
    return this.eip ? this.eip.publicIp : this.instance.publicIp
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

  /** The managed database's hostname, or undefined with SQLite. */
  get databaseHost(): $util.Output<string> | undefined {
    return this.database?.host
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
      database: this.database,
      storageBuckets: this.storageBuckets,
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
