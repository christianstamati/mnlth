# Convex self-hosted on EC2 — manual deployment

A by-hand walkthrough of what `infra/convex-backend.ts` automates: one EC2 instance
running the upstream Convex compose stack behind Caddy, with RDS Postgres and
Let's Encrypt TLS.

Differs from the older SST version in two ways: **Caddy replaces nginx +
certbot**, and Postgres TLS is verified against Amazon's CA rather than disabled.

> **Automated equivalent:** `sst.config.ts` now provisions all of this, one
> isolated copy per stage — `bun sst deploy --stage production`. This document is
> the walkthrough of what that config does and why each piece is there. Where the
> two differ, the config is the source of truth.

> **Replace `YOUR_DB_PASSWORD`** throughout. Don't commit this file with the
> password filled in.

**Status:** ran end to end on 2026-08-27. Verified from outside the VPC:

| Endpoint | Result |
|---|---|
| `https://api.fullstackaws.dev/version` | 200 |
| `https://site.fullstackaws.dev` | 404 — expected until functions are deployed |
| `https://dashboard.fullstackaws.dev` | 200 |
| `http://api.fullstackaws.dev` | 308 → https |

TLS certificate issued by Let's Encrypt (`CN=YE2`), 90-day validity, verifies
cleanly (`ssl_verify_result=0`). Caddy renews it automatically at ~60 days.

## Architecture

```mermaid
flowchart TB
    browser["🌐 Browser / Convex client"]
    dns["Route 53<br/><code>fullstackaws.dev</code><br/>api · site · dashboard"]
    le["Let's Encrypt<br/>HTTP-01 challenge"]

    subgraph vpc["VPC · vpc-0cdb45a4e9750a623 · 10.0.0.0/16"]
        direction TB

        subgraph pub["Public subnet · 10.0.0.0/20 · eu-central-1a"]
            direction TB
            eip(["Elastic IP<br/>63.181.74.46"])

            subgraph ec2["EC2 · t4g.small arm64 · 20 GiB gp3"]
                direction TB

                subgraph dkr["Docker Compose · shared network"]
                    direction TB
                    caddy["<b>caddy</b> :80 :443<br/>TLS termination<br/>reverse proxy · auto-renew"]
                    backend["<b>backend</b><br/>:3210 sync API<br/>:3211 HTTP actions"]
                    dash["<b>dashboard</b><br/>:6791"]
                end
            end
        end

        subgraph priv["Private subnets · 1a / 1b / 1c · no internet route"]
            rds[("<b>RDS PostgreSQL 18.3</b><br/>db.t4g.micro · 20 GiB<br/>:5432")]
        end
    end

    browser -->|1 · resolve| dns
    dns -->|A records| browser
    browser ==>|"2 · https :443"| eip
    le -.->|"cert validation :80"| eip
    eip ==>|convex-web-sg<br/>only 80 + 443| caddy

    caddy ==>|backend:3210| backend
    caddy ==>|backend:3211| backend
    caddy ==>|dashboard:6791| dash
    backend ==>|"convex-db-sg · TLS verified<br/>via PG_CA_FILE"| rds

    classDef ext fill:#f5f5f5,stroke:#999,color:#333
    classDef aws fill:#fff4e5,stroke:#e08a00,color:#333
    classDef svc fill:#e8f0fe,stroke:#3b78e7,color:#333
    classDef db  fill:#e6f4ea,stroke:#1e8e3e,color:#333
    class browser,le,dns ext
    class eip aws
    class caddy,backend,dash svc
    class rds db
```

**Reading it:** the only ways in from the internet are ports 80 and 443, enforced
by `convex-web-sg`. Caddy terminates TLS there and reaches the other two by
compose service name. `3210`, `3211` and `6791` are also published on the host by
the upstream compose file, but the security group never opens them, so they're
reachable only from the instance itself. Postgres sits in private subnets with no
internet route, reachable only from instances carrying the web security group —
and the connection to it is TLS-*verified* against Amazon's CA rather than merely
encrypted.

## Resources

| Resource | Identifier |
|---|---|
| Region | `eu-central-1` |
| Hosted zone | `fullstackaws.dev` — `Z00598931F14VZJHMK8G4` |
| VPC | `vpc-0cdb45a4e9750a623` — `10.0.0.0/16` |
| Public subnets | `subnet-02069cff139115d4b` (1a), `subnet-0152584e1ea4f79f6` (1b), `subnet-0342f04903e0181b6` (1c) |
| Private subnets | `subnet-0cea2fb43f79ed3fe` (1a), `subnet-04e7828a0052ae156` (1b), `subnet-073812a3585625504` (1c) |
| Internet gateway | `igw-0218bba3f17381d7e` |
| Web security group | `sg-092f1375f9ddae81c` — `convex-web-sg` |
| DB security group | `sg-027d87d9628c9f5cf` — `convex-db-sg` |
| DB subnet group | `convex-db-subnet-group` |
| RDS endpoint | `convex-postgres.cnu4qcq02b6y.eu-central-1.rds.amazonaws.com:5432` |
| EC2 instance | `i-025a7df31b5cdcddb` — `t4g.small`, arm64, 20 GiB gp3 |
| Elastic IP | `63.181.74.46` — `eipalloc-020600d4d82816df9` |

---

## Phase 0 — VPC

**VPC console → Create VPC → "VPC and more"**

| Field | Value |
|---|---|
| Name tag auto-generation | `project` |
| IPv4 CIDR | `10.0.0.0/16` |
| Availability Zones | 2 (3 only if you want Multi-AZ DB *clusters*) |
| Public subnets | one per AZ |
| Private subnets | one per AZ |
| **NAT gateways** | **None** |
| VPC endpoints | None, or S3 Gateway (free) |
| DNS hostnames / resolution | Enabled |

Everything here is free **except NAT gateways** (~$32/mo each, and the wizard
defaults to one per AZ). You don't need them: the EC2 instance sits in a public
subnet and reaches the internet through the internet gateway directly.

## Phase 1 — Web security group

**EC2 → Security groups → Create security group**

Name `convex-web-sg`, VPC `vpc-0cdb45a4e9750a623`.

| Type | Port | Source |
|---|---|---|
| HTTP | 80 | `0.0.0.0/0` |
| HTTPS | 443 | `0.0.0.0/0` |
| SSH | 22 | depends — see below |

Port 22's source depends on how you connect:

| Method | Source |
|---|---|
| Browser console **Connect** button | `pl-03384955215625250` (AWS-managed prefix list) |
| `aws ec2-instance-connect ssh` (CLI) | **My IP** |
| Both | add both rules |

The browser terminal connects *from AWS's infrastructure*, so a "My IP" rule
won't match it. The CLI connects from your laptop, so the prefix list won't
match that.

**Deliberately not opened: 3210, 3211, 6791.** Caddy proxies those from
`localhost`. Exposing them would put an unencrypted backend and a public admin
dashboard on the internet.

## Phase 2 — Postgres

### 2a. DB security group

Name `convex-db-sg`, same VPC. One inbound rule:

| Type | Port | Source |
|---|---|---|
| PostgreSQL | 5432 | **Custom → `sg-092f1375f9ddae81c`** |

The source is the *web security group*, not a CIDR. This is the standard tiered
pattern — access follows the instance regardless of its IP, and nothing outside
the web tier can reach the database at all.

### 2b. DB subnet group

**RDS → Subnet groups → Create DB subnet group**

Name `convex-db-subnet-group`, VPC `vpc-0cdb45a4e9750a623`, and select the
**private** subnets only. RDS requires at least two AZs even for a single-AZ
database.

### 2c. Create the database

**RDS → Databases → Create database → Standard create**

| Field | Value |
|---|---|
| Engine | PostgreSQL |
| **Template** | **Dev/Test** |
| Availability | Single DB instance |
| DB identifier | `convex-postgres` |
| Master username | `postgres` |
| Credentials management | Self managed |
| Master password | save it; avoid `@ : / ?` |
| Instance class | `db.t4g.micro` |
| Storage type | gp3 |
| Allocated storage | 20 GiB |
| Storage autoscaling | **uncheck** |
| Public access | **No** |
| VPC security group | `convex-db-sg` — **remove `default`** |
| DB subnet group | `convex-db-subnet-group` |
| Enhanced monitoring | uncheck |
| **Initial database name** | **`convex_self_hosted`** |
| Backup retention | 7 days |
| Deletion protection | uncheck |

Traps on this page:

- **Template: Production** silently enables Multi-AZ *and* provisioned IOPS —
  roughly 10× the cost.
- **Storage autoscaling** defaults to a 1000 GiB ceiling and storage can never
  be shrunk once grown.
- **Initial database name** is collapsed under "Additional configuration". Leave
  it blank and you get a server with no database on it.

Takes 5–10 minutes.

**PostgreSQL 18 works.** Convex's docs only claim testing against v17, so this
was a real risk going in — but 18.3 ran clean through schema creation and normal
operation. The only Postgres-related failure we hit was TLS trust, not the engine
version.

**Storage type:** the console gave us **gp2** despite selecting gp3 — worth
double-checking on the review screen. At 20 GiB, gp2 caps at 100 baseline IOPS
versus gp3's 3000, and gp3 is usually slightly cheaper. Changeable later under
**Modify** with no downtime.

## Phase 3 — IAM role *(skipped)*

Only needed for SSM Session Manager. This build uses EC2 Instance Connect
instead, which needs no role.

<details>
<summary>If you want Session Manager instead of SSH</summary>

**IAM → Roles → Create role** → AWS service → EC2 →
`AmazonSSMManagedInstanceCore` → name it `ConvexInstanceRole`, then attach it in
the launch wizard's Advanced details. This is what `infra/convex-backend.ts:47`
does.
</details>

## Phase 4 — Elastic IP

**EC2 → Elastic IPs → Allocate Elastic IP address**

Auto-assigned public IPs change on every stop/start, which would silently break
your DNS records and Caddy's certificate renewal.

> Public IPv4 addresses bill ~$0.005/hr (~$3.60/mo) **whether attached or not**.
> Release it when tearing down.

## Phase 5 — Launch EC2

**EC2 → Instances → Launch instances**

| Field | Value |
|---|---|
| Name | `convex-backend` |
| AMI | Amazon Linux 2023 |
| **Architecture** | **64-bit (Arm)** |
| Instance type | `t4g.small` |
| Key pair | create one as a fallback |
| VPC | `vpc-0cdb45a4e9750a623` |
| Subnet | `subnet-02069cff139115d4b` (**public**) |
| **Auto-assign public IP** | **Enable** |
| Firewall | existing → `convex-web-sg` |
| Storage | **20 GiB** gp3 |
| IAM instance profile | none |

Traps:

- The architecture dropdown defaults to **x86**. With x86 selected, `t4g` doesn't
  appear in the instance type list at all.
- A **private** subnet leaves the instance with no internet route — `dnf install`
  hangs forever.
- **Auto-assign public IP is off by default** on wizard-created subnets.
- The **8 GiB** default disk fills up once Docker images land.
- A key pair **cannot be added to a running instance**. Create one even if you
  plan to use Instance Connect — it's your only fallback.

Then **EC2 → Elastic IPs → Actions → Associate Elastic IP address** → the
instance. The auto-assigned IP is released and replaced.

## Phase 6 — DNS

**Route53 → Hosted zones → `fullstackaws.dev` → Create record**

Three A records, simple routing, TTL 60, all pointing at `63.181.74.46`:
`api`, `site`, `dashboard`.

<details>
<summary>CLI equivalent</summary>

```bash
cat > /tmp/rr.json <<'JSON'
{"Changes":[
 {"Action":"UPSERT","ResourceRecordSet":{"Name":"api.fullstackaws.dev","Type":"A","TTL":60,"ResourceRecords":[{"Value":"63.181.74.46"}]}},
 {"Action":"UPSERT","ResourceRecordSet":{"Name":"site.fullstackaws.dev","Type":"A","TTL":60,"ResourceRecords":[{"Value":"63.181.74.46"}]}},
 {"Action":"UPSERT","ResourceRecordSet":{"Name":"dashboard.fullstackaws.dev","Type":"A","TTL":60,"ResourceRecords":[{"Value":"63.181.74.46"}]}}
]}
JSON

aws route53 change-resource-record-sets \
  --hosted-zone-id Z00598931F14VZJHMK8G4 --change-batch file:///tmp/rr.json
```
</details>

These **must resolve before Phase 9** — Let's Encrypt validates by fetching
`http://api.fullstackaws.dev/.well-known/acme-challenge/...` by name.

```bash
dig +short api.fullstackaws.dev site.fullstackaws.dev dashboard.fullstackaws.dev
```

## Connecting to the instance

No `.pem` needed — this pushes an ephemeral key valid for 60 seconds:

```bash
aws ec2-instance-connect ssh --instance-id i-025a7df31b5cdcddb --os-user ec2-user
```

**Use the CLI, not the browser terminal.** The console's Connect button opens a
terminal whose clipboard handling is awkward enough to be unusable for anything
longer than a word or two. The CLI gives you a normal local terminal — working
paste, scrollback, your own shell config — and still needs no key pair.

Note the two connect methods come from *different source IPs*, which is what the
port 22 table in Phase 1 is about.

One-shot, without an interactive session:

```bash
aws ec2-instance-connect ssh --instance-id i-025a7df31b5cdcddb --os-user ec2-user \
  --command "docker compose -f /home/ec2-user/convex-backend/docker-compose.yml ps"
```

## Phase 7 — Docker

```bash
sudo dnf update -y
sudo dnf install -y docker

# AL2023 has the docker engine in its repos but NOT the compose plugin
sudo install -m 0755 -d /usr/libexec/docker/cli-plugins
sudo curl -fsSL -o /usr/libexec/docker/cli-plugins/docker-compose \
  https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64
sudo chmod +x /usr/libexec/docker/cli-plugins/docker-compose

sudo usermod -aG docker ec2-user
sudo systemctl enable --now docker
exit   # group membership is only read at login
```

Reconnect, then verify:

```bash
docker version && docker compose version
```

Nothing is preinstalled on AL2023 — not docker, and certainly not certbot, which
isn't packaged at all. We don't need `nginx`, `python3`, `python3-pip` or
`augeas-libs`; Caddy replaces all four.

## Phase 8 — Convex stack

### 8a. Prove the database path first

```bash
docker run --rm -it postgres:17 psql \
  "postgresql://postgres:YOUR_DB_PASSWORD@convex-postgres.cnu4qcq02b6y.eu-central-1.rds.amazonaws.com:5432/convex_self_hosted?sslmode=require" \
  -c "select version();"
```

| Symptom | Cause |
|---|---|
| hangs ~30s then times out | security group |
| `authentication failed` | password |
| version string returned | ✅ network, credentials and SSL all good |

### 8b. Fetch the stack

```bash
mkdir -p ~/convex-backend && cd ~/convex-backend

curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/get-convex/convex-backend/main/self-hosted/docker/docker-compose.yml
```

### 8c. Amazon RDS certificate authority

```bash
curl -fsSL -o rds-ca.pem \
  https://truststore.pki.rds.amazonaws.com/eu-central-1/eu-central-1-bundle.pem
```

Convex **verifies** the Postgres server certificate. Managed providers with
public CAs (Neon, PlanetScale) work out of the box; RDS is signed by Amazon's
private root CA, so without this you get:

```
error performing TLS handshake: invalid peer certificate: UnknownIssuer
```

`psql` succeeded earlier because `sslmode=require` encrypts without verifying the
issuer.

### 8d. Compose override

```bash
cat > docker-compose.override.yml <<'EOF'
services:
  backend:
    volumes:
      - ./rds-ca.pem:/convex/rds-ca.pem:ro
    environment:
      - PG_CA_FILE
EOF
```

Two reasons this is a separate file rather than an edit:

- The upstream compose file's `environment:` block is an **allowlist**.
  `PG_CA_FILE` isn't in it, so setting it in `.env` alone would never reach the
  container.
- An override survives re-downloading `docker-compose.yml`.

> Don't patch the YAML with `sed -i '...a\   text'` — GNU sed strips leading
> whitespace after `a\` and silently destroys the indentation.

`PG_CA_FILE` is undocumented; see
[`crates/postgres/src/lib.rs:427`](https://github.com/get-convex/convex-backend/blob/main/crates/postgres/src/lib.rs).
It **appends** to the OS trust store rather than replacing it.

### 8e. Environment

```bash
cat > .env <<'EOF'
INSTANCE_NAME=convex-self-hosted
POSTGRES_URL=postgresql://postgres:YOUR_DB_PASSWORD@convex-postgres.cnu4qcq02b6y.eu-central-1.rds.amazonaws.com:5432
PG_CA_FILE=/convex/rds-ca.pem

CONVEX_CLOUD_ORIGIN=https://api.fullstackaws.dev
CONVEX_SITE_ORIGIN=https://site.fullstackaws.dev
NEXT_PUBLIC_DEPLOYMENT_URL=https://api.fullstackaws.dev

REDACT_LOGS_TO_CLIENT=true
DISABLE_BEACON=true
EOF

chmod 600 .env
```

- `POSTGRES_URL` ends at the **port** — no database name, no query params. Convex
  derives its database from `INSTANCE_NAME` (dashes → underscores).
- **No `DO_NOT_REQUIRE_SSL`**, unlike `infra/convex-backend.ts:127`. RDS on
  PG 15+ ships `rds.force_ssl=1`.
- The origins must be the **public HTTPS URLs** even before Caddy exists — the
  backend bakes them into the URLs and CORS headers it generates, and has no way
  to know a proxy sits in front of it.
- The quoted `<<'EOF'` prevents bash expanding anything `$`-shaped in the
  password.

### 8f. Start

```bash
docker compose config | grep -E "rds-ca|PG_CA_FILE"   # verify the merge first

docker compose up -d
docker compose logs -f backend        # look for: Connected to Postgres

curl -sS localhost:3210/version
curl -sS -o /dev/null -w '%{http_code}\n' localhost:6791
```

Expect `unknown` and `200`.

**`unknown` is the correct answer, not an error.** Self-hosted images aren't built
from a tagged release, so there's no version string to report. The backend
wouldn't be serving at all if the Postgres connection had failed — it exits on
startup rather than degrading.

<details>
<summary>Fallback if TLS still fails</summary>

Create an RDS parameter group for `postgres18` with `rds.force_ssl = 0`, apply it
to `convex-postgres`, reboot, then add `DO_NOT_REQUIRE_SSL=1` to both `.env` and
the override file's `environment:` list. Traffic is then unencrypted but never
leaves the VPC — this is what the SST config does.
</details>

## Phase 9 — Caddy

Replaces nginx + certbot + python3 + python3-pip + augeas-libs + a systemd
renewal timer, with automatic HTTPS and renewal built in.

**Run it as a container, not a host binary.** There's no package for it — AL2023
has no COPR plugin, and Caddy's RPM repo targets Fedora/EL. That leaves
downloading a binary at boot, which is fragile in a bootstrap script (see the
SIGPIPE gotcha below). The official image sidesteps all of it.

The Caddyfile proxies to **compose service names**, not `localhost` — the three
services share a network, so nothing but 80/443 is ever published to the host:

```bash
cd ~/convex-backend
cat > Caddyfile <<'EOF'
api.fullstackaws.dev {
	reverse_proxy backend:3210
}

site.fullstackaws.dev {
	reverse_proxy backend:3211
}

dashboard.fullstackaws.dev {
	reverse_proxy dashboard:6791
}
EOF
```

That's the entire TLS configuration. Caddy handles **websocket upgrades
automatically**, so there's no equivalent of nginx's four `proxy_set_header`
lines — which matters, because Convex's sync protocol depends on them.

Then add it to the override file from Phase 8d:

```yaml
services:
  backend:
    restart: unless-stopped
    volumes:
      - ./rds-ca.pem:/convex/rds-ca.pem:ro
    environment:
      - PG_CA_FILE
  dashboard:
    restart: unless-stopped
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - backend
      - dashboard

volumes:
  caddy_data:
  caddy_config:
```

```bash
docker compose up -d
docker compose logs -f caddy    # look for: certificate obtained successfully
```

🔑 **`caddy_data` is load-bearing.** It holds `/data/caddy/certificates`. Without
it, every container recreate re-requests certificates and burns through Let's
Encrypt's limit of 5 duplicates per week. It's also why
`docker system prune --volumes` is dangerous here.

ℹ️ The upstream compose file still publishes `3210`, `3211` and `6791` to the
host, and a Compose override **concatenates** `ports` rather than replacing them
— so adding Caddy doesn't unpublish anything. `curl localhost:3210` on the box
keeps working. What keeps those ports off the internet is the **security group**,
which never opened them.

To bind them to loopback as defence-in-depth, Compose v2.24+ supports replacing
the list outright:

```yaml
  backend:
    ports: !override
      - "127.0.0.1:3210:3210"
      - "127.0.0.1:3211:3211"
  dashboard:
    ports: !override
      - "127.0.0.1:6791:6791"
```

Caddy reaches them by service name over the compose network either way, so this
costs nothing functionally.

Certificates arrive in 10–30 seconds — Caddy requests all three in parallel,
solving the HTTP-01 challenge on port 80.

> If it fails, **read the error rather than retrying in a loop.** Let's Encrypt
> rate-limits both duplicate certificates (5/week per hostname set) and failed
> validations.

Verify from your laptop:

```bash
curl -sS https://api.fullstackaws.dev/version
curl -sSI http://api.fullstackaws.dev        # expect 308 → https

# all three at once, with TLS verification
for u in https://api.fullstackaws.dev/version \
         https://site.fullstackaws.dev \
         https://dashboard.fullstackaws.dev; do
  printf "%-45s %s\n" "$u" \
    "$(curl -sS -o /dev/null -w '%{http_code} tls=%{ssl_verify_result}' --max-time 15 "$u")"
done

# inspect the certificate
echo | openssl s_client -connect api.fullstackaws.dev:443 \
  -servername api.fullstackaws.dev 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

`tls=0` means the certificate verified. **`site` returning 404 is expected** —
the HTTP actions proxy has nothing to route until you deploy functions.

## Phase 10 — Admin key and deploy

Only the running backend can mint the admin key, so it has to be generated on
the box:

```bash
cd ~/convex-backend
docker compose exec backend ./generate_admin_key.sh
```

Open `https://dashboard.fullstackaws.dev`, enter `https://api.fullstackaws.dev`
as the deployment URL and paste the key. Then from your app:

```bash
CONVEX_SELF_HOSTED_URL=https://api.fullstackaws.dev \
CONVEX_SELF_HOSTED_ADMIN_KEY=<key> \
npx convex deploy
```

🔐 The admin key is full control of the deployment. Keep it in `.env.local` or
your shell profile — never a committed file.

### Publishing it to Parameter Store

Needing a shell just to read a key is the one genuinely blocking reason to keep
SSH access. Writing it to SSM at boot removes that, and gives every stage its own
path. This is what `sst.config.ts` does:

```bash
ADMIN_KEY=$(docker compose exec -T backend ./generate_admin_key.sh 2>/dev/null \
  | grep -oE '[A-Za-z0-9_-]+\|[a-f0-9]+' | tail -1)

aws ssm put-parameter --region eu-central-1 \
  --name /mnlth/production/convex/admin-key \
  --type SecureString --overwrite --value "$ADMIN_KEY"
```

The instance needs `ssm:PutParameter` on that ARN plus `kms:Encrypt` (scoped by a
`kms:ViaService` condition) — `SecureString` encrypts under the AWS-managed
`aws/ssm` key and the caller needs permission on it.

Read it from anywhere with IAM access:

```bash
aws ssm get-parameter --region eu-central-1 --with-decryption \
  --query Parameter.Value --output text \
  --name /mnlth/production/convex/admin-key
```

⚠️ Omit `--with-decryption` and you get ciphertext back, which reads like a
corrupted key rather than an error.

Matching the key by **shape** (`<instance-name>|<hex>`) rather than by line
position matters — the script's output format isn't documented and may carry a
banner line.

⚠️ The key is regenerated on every instance replacement, so an AMI refresh or
userData edit invalidates whatever is in `.env.local` or CI. Re-read from SSM
after a rebuild. Setting `INSTANCE_SECRET` explicitly (already in the compose
allowlist) makes it stable, since Convex derives the key from it.

## Once it works — tighten up

The build leaves a few things loose for convenience. Close them while it's fresh:

- **Narrow port 22** in `convex-web-sg` from `0.0.0.0/0` to **My IP** (or the
  `pl-03384955215625250` prefix list if you use the browser terminal).
- **Rotate the RDS master password.** It passes through your terminal, your shell
  history and the `.env` in plaintext during setup.
- **`history -c`** on the instance — the Phase 8a `psql` test puts the password
  in bash history.
- **Consider gp3** for the RDS volume if the console gave you gp2.
- **Wire up S3** (`S3_STORAGE_*` vars) if you want search indexes and file
  storage off the instance's local Docker volumes.

## Operations and debugging

### Connect

```bash
aws ssm start-session --target <instance-id>                       # no inbound port
aws ec2-instance-connect ssh --instance-id <id> --os-user ec2-user # over SSH
```

### Resource usage

```bash
echo "── memory ──";     free -h
echo "── disk ──";       df -h /
echo "── docker ──";     docker system df
echo "── load ──";       uptime
echo "── containers ──"; docker stats --no-stream
```

What normal looks like on `t4g.small`:

| | Idle | Investigate above |
|---|---|---|
| Memory | ~500–600 MiB of 1.9 GiB | ~1.6 GiB |
| Root disk | ~5–7 GiB of 20 | 16 GiB |
| Load average | < 0.5 | sustained > 2 |

**EC2 publishes no memory or disk metrics** — the hypervisor can't see inside the
instance, so CloudWatch gives you CPU, network and EBS I/O only. And `t4g` is
**burstable**: a `CPUCreditBalance` trending toward zero means the box is
undersized, not momentarily busy.

### Containers

```bash
cd ~/convex-backend

docker compose ps                      # status + health of all three
docker compose logs --tail=100 backend
docker compose logs -f caddy
docker compose top
docker compose config                  # merged files; fails loudly on bad YAML
docker compose restart backend
docker compose pull && docker compose up -d    # upgrade images
docker compose down                    # stop, keep volumes
docker compose down -v                 # ⚠️ ALSO DELETES caddy_data — certs re-issue
```

### Convex

```bash
curl -sS localhost:3210/version                                 # expect: unknown
docker compose exec backend curl -sS localhost:3210/version     # if ports are !override'd
docker compose logs backend | grep -i "connected to postgres"
docker compose logs backend | grep -iE "error|panic|fatal" | tail -20
docker compose exec backend env | grep -E "POSTGRES_URL|PG_CA_FILE|ORIGIN"
```

That last one shows what the container **actually received**, which is how you
catch the allowlist problem — a variable set in `.env` that never reached it.

### Caddy and TLS

```bash
docker compose logs caddy | grep -iE "certificate|error|obtain"
docker compose exec caddy ls -R /data/caddy/certificates
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
sudo ss -tlnp | grep -E ':80|:443'
```

### Out-of-memory kills

The most likely failure on a 2 GiB box. A container that vanished without an
error in its own logs was probably killed from outside:

```bash
sudo dmesg -T | grep -i -E "oom|killed process"
journalctl -k --since "1 hour ago" | grep -i oom
```

### Boot failures

Where to start when a **fresh** instance comes up wrong:

```bash
sudo tail -100 /var/log/cloud-init-output.log
cloud-init status --long
```

Because userData runs under `set -euo pipefail`, the script stops at the **first**
failure — the last lines of that log are the failure, and everything after it
never ran.

### Triage order

1. `docker compose ps` — what's actually running?
2. `docker compose logs --tail=50 <broken service>` — why did it stop?
3. `free -h` + `dmesg | grep -i oom` — killed, or crashed?
4. `df -h` — disk full?
5. `sudo tail -50 /var/log/cloud-init-output.log` — only for a fresh instance

## Teardown

In this order:

1. Terminate EC2 instance `i-025a7df31b5cdcddb`
2. **Release the Elastic IP** `eipalloc-020600d4d82816df9` — billed even unattached
3. Delete RDS `convex-postgres` (snapshot first if you want the data)
4. Delete DB subnet group `convex-db-subnet-group`
5. Delete security groups — `convex-db-sg` first, then `convex-web-sg`
6. Delete the three Route53 A records
7. Delete the VPC (takes subnets, route tables and internet gateway with it)

## Gotchas

- **Nothing is preinstalled on AL2023** — not docker, and the compose plugin
  isn't even in the repos. certbot isn't packaged at all, and there's no snap.
- **`t4g` requires an arm64 AMI.** The launch wizard defaults to x86.
- **Wizard-created subnets have auto-assign public IP off.**
- **Multi-AZ DB *cluster*** needs 3 AZs and doesn't support `t4g` classes at all
  — it requires `m5d`/`m6gd`/`r6gd`-class instances, roughly $500+/mo. Multi-AZ
  DB *instance* needs 2 AZs and simply doubles the cost.
- **Convex verifies the Postgres certificate.** RDS needs `PG_CA_FILE`. This was
  the only thing that actually blocked the build.
- **The compose `environment:` block is an allowlist.** An env var in `.env` that
  isn't named there never reaches the container.
- **Don't patch the compose YAML with `sed -i ... a\`.** GNU sed strips leading
  whitespace after `a\`, so inserted lines lose their indentation and the file
  silently becomes invalid — every later `docker compose` call then fails with
  `mapping values are not allowed in this context`, including `down`. Use
  `docker-compose.override.yml`.
- **`unknown` from `/version` is normal.** Self-hosted images carry no release
  tag.
- **`site.*` 404s until functions are deployed.** Not a proxy misconfiguration.
- **`producer | grep -m1` is fatal under `set -o pipefail`.** `grep -m1` exits at
  the first match, closing the pipe; the producer then dies of SIGPIPE, and
  `pipefail` + `set -e` kill the whole script. It's invisible interactively
  because your shell sets neither option — the same command "works" by hand and
  aborts a bootstrap script. Cost an entire debugging round here, where it killed
  userData at the Caddy install and left 80/443 closed while Convex ran happily
  on the compose network. Buffer first (`X=$(curl ...)`, then process `"$X"`), or
  avoid the early-exit read. Applies equally to `| head` and `| grep -q`.
- **Caddy has no AL2023 package.** No COPR plugin, and its RPM repo targets
  Fedora/EL. Run the official container image rather than fetching a binary at
  boot.
- **Data lives in RDS, but local Docker volumes hold search indexes and file
  storage.** `docker compose down -v` destroys those. Wire up the
  `S3_STORAGE_*` buckets to move that state off the instance.
