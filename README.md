# shadcn/ui monorepo template

This is a TanStack Start monorepo template with shadcn/ui.

## Adding components

To add components to your app, run the following command at the root of your `web` app:

```bash
pnpm dlx shadcn@latest add button -c apps/web
```

This will place the ui components in the `packages/ui/src/components` directory.

## Using components

To use the components in your app, import them from the `ui` package.

```tsx
import { Button } from "@workspace/ui/components/button";
```

## Local development (self-hosted Convex)

`bun sst:dev` is the only command needed. SST starts three things side by side:

| Process           | What it runs                                              |
| ----------------- | --------------------------------------------------------- |
| `convex stack`    | `docker compose up` — Postgres, the Convex backend, the dashboard |
| `convex dev`      | `scripts/convex-dev.ts` — pushes `packages/backend/convex` on save |
| `Web`             | Vite on http://localhost:3000                             |

- Backend: http://127.0.0.1:3210 (HTTP actions on `:3211`)
- Dashboard: http://127.0.0.1:6791
- Postgres: `localhost:5432` (`postgres` / `postgres`, database `convex_self_hosted`)

The backend mints its own admin key, so nothing is checked in. On the first run
`scripts/convex-dev.ts` waits for the container, calls `generate_admin_key.sh`,
and writes `packages/backend/.env.local`:

```bash
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210
CONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|<generated>
```

Delete that file to mint a fresh key. To wipe the deployment entirely,
`docker compose down -v` — the data lives in the `postgres-data` volume.

Backend functions live in `packages/backend/convex` and reach the web app as
generated types:

```tsx
import { api } from "@workspace/backend/convex/_generated/api"
import { useQuery } from "convex/react"

const messages = useQuery(api.chat.getMessages)
```

The client reads `VITE_CONVEX_URL`, which `sst.config.ts` sets to the local
backend in dev and to `https://api.<stage domain>` on a deployed stage. Running
`bun dev` (plain Vite, no SST) skips that injection, so export it yourself or
use `bun sst:dev`.

Local development also gets the stage's real S3 buckets for Convex storage, so
uploaded files land in S3 rather than in the container. The local and deployed
backends share buckets but not databases, which means they write past each other
rather than over each other.

## Deploying (SST)

Two things ship per stage, both under `fullstackaws.dev`:

| | Hostname | What runs |
| --- | --- | --- |
| `apps/web` | apex for production, `<stage>.` otherwise | TanStack Start on a streaming Lambda behind CloudFront |
| Convex | `api.` · `site.` · `dashboard.` | one EC2 instance behind Caddy, on RDS Postgres and S3 |

The frontend needs Nitro's `aws-lambda` preset, set in `apps/web/vite.config.ts`.

Production owns the shared VPC and the Postgres server, so it deploys first and
is removed last:

```bash
bun sst:dev                          # sst dev — app on http://localhost:3000
bunx sst deploy --stage production   # first run takes ~10 min; RDS is the slow part
bunx sst deploy --stage dev
bun sst:remove                       # tear down
```

### Deployment settings

`sst.settings.json` holds what varies per deployment but not per stage: the base
domain, the region, and per-stage choices. Only `domain` and `region` are
required; the rest default to what is shown here.

```json
{
  "domain": "fullstackaws.dev",
  "region": "eu-central-1",
  "protect": ["production"],
  "removal": { "production": "retain", "*": "remove" },
  "storage": { "production": "s3", "*": "volume" },
  "database": { "production": "mysql", "*": "sqlite" }
}
```

`protect` lists stages whose resources refuse deletion; a deploy that must
replace a resource on a protected stage fails, so leave it empty while a
stage's instance name or database is still changing. `removal` is what
`sst remove` does with resources: `remove`, `retain` (keeps the VPC, subnets
and any RDS instance) or `retain-all`, given as one policy or as a map keyed
by stage with `*` as the fallback. `storage` (`volume` | `s3`) and `database`
(`sqlite` | `postgres` | `mysql`) pick the Convex backend's file storage and
database engine the same way. `infra/settings.ts` validates the file at load
time.

### Convex functions

`sst deploy` brings the backend up but pushes nothing into it — the frontend
would query a deployment with an empty `api`. Pushing needs the two variables
the Convex CLI always needs for a self-hosted deployment:

```bash
CONVEX_SELF_HOSTED_URL
CONVEX_SELF_HOSTED_ADMIN_KEY
```

Locally `scripts/convex-dev.ts` mints the key from the container and caches it
in `packages/backend/.env.local`. On a deployed stage the key can only come from
the running backend, so `bootstrap.sh` publishes it to SSM once the backend
reports healthy, and `scripts/convex-deploy.ts` reads it back — the URL from
`/mnlth/<stage>/convex/url`, the key from `/mnlth/<stage>/convex/admin-key`:

```bash
bun convex:deploy --stage production
```

On a first deploy the key parameter holds a placeholder until the backend is
healthy, which is a few minutes after `sst deploy` returns; the script says so
rather than pushing at nothing.

The stage's `INSTANCE_SECRET` is generated once by `sst.config.ts` and kept in
SSM, so a key stays valid across instance replacements — without it the backend
invents an identity per data volume and every replacement silently invalidates
every key. It also means a key can be cut without the deployment running:

```bash
docker run --rm --entrypoint ./generate_key \
  ghcr.io/get-convex/convex-backend:<tag> <stage> "$(aws ssm get-parameter \
    --name /mnlth/<stage>/convex/instance-secret --with-decryption \
    --query Parameter.Value --output text)"
```

Keys are bound to the stage name as well as the secret, so a `dev` key does not
open `production`. Rotation is all-or-nothing: there is no per-key revocation.

That key is a root credential — full read and write on every table, plus
function push. It lives in SSM and in the one process that uses it. It is never
an environment variable on the frontend, and above all never a `VITE_` one:
those are inlined into the client bundle and served to every visitor.

### Convex storage

The backend keeps snapshots, function modules, user files and search indexes in
five per-stage S3 buckets rather than on the instance's volume, so replacing the
instance costs none of it. The bucket names and an access key scoped to those
five buckets reach the box through SSM, where userData sources them and
`bootstrap.sh` passes them on — nothing sensitive lands in userData itself,
which is readable by anyone holding `ec2:DescribeInstanceAttribute`.

The S3 variables are optional in the stack repo: unset, the backend keeps
everything on its volume, which is what a bare `docker compose up` gets.

Moving a deployment that already holds data between local and S3 storage is an
export and import, not a restart: the rows keep pointing at storage the new
backend cannot read.

```bash
npx convex export --path snapshot.zip
npx convex import --replace-all snapshot.zip
```

Link AWS resources to the frontend with `link: [...]` — linked resources are
read in the app via `import { Resource } from "sst"`.

### Shell access

Two ways onto the box, neither with a port open to the internet at large:

```bash
aws ssm start-session --target <instanceId>                       # Session Manager
aws ec2-instance-connect ssh --instance-id <instanceId> --os-user ec2-user
```

The second uses EC2 Instance Connect, which pushes a one-off key through the
AWS API and connects from AWS's own address range; without a key pair the
security group admits port 22 from that range only. Setting `keyPairId` in
`sst.config.ts` installs the key pair for `ec2-user` at launch and opens port
22 to everyone, so plain `ssh -i <key.pem> ec2-user@<publicIp>` works too.

### Convex database

The RDS instance sits in a private subnet with no route from the internet, in
the same availability zone as the backend. To reach it from a desktop client
such as DBeaver, forward a port through the EC2 box with Session Manager. The
instance role already carries `AmazonSSMManagedInstanceCore`, so this needs no
open port, key pair or bastion, and the service itself costs nothing.

One-time, on your own machine, install the plugin the AWS CLI shells out to.
The instance side needs nothing: Amazon Linux 2023 ships the SSM Agent running.

```bash
brew install --cask session-manager-plugin
```

The backend's connection string is kept in SSM. The first line is
`MYSQL_URL=mysql://<user>:<password>@<host>:3306` (or `POSTGRES_URL=` on
port 5432 when the stage runs Postgres):

```bash
aws ssm get-parameter --name /mnlth/<stage>/convex/database-env \
  --with-decryption --query Parameter.Value --output text
```

Open the tunnel with the instance id from the deploy outputs and the host from
that URL. Leave it running while you work:

```bash
aws ssm start-session --target <instanceId> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<host>"],"portNumber":["3306"],"localPortNumber":["3306"]}'
```

Then point the client at `localhost:3306` with the user and password from the
URL. The database is named after the stage, the same as the Convex instance.

Current production values (throwaway stage; remove before this repo is shared):

```bash
aws ssm start-session --target i-023ca372369f5bead \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["mnlth-production-convexdatabaseinstance-ozxbsfzt.cnu4qcq02b6y.eu-central-1.rds.amazonaws.com"],"portNumber":["3306"],"localPortNumber":["3306"]}'
```

| Field | Value |
| --- | --- |
| Host | localhost |
| Port | 3306 |
| Database | production |
| Username | root |
| Password | jbdNdq2ouWE2WDINYNIBwByiUn6LNIul |

The credentials are the backend's own, with full access to every table. Rows
are Convex's internal storage format, not the app's documents one to one, so
treat the connection as read-only for debugging; edit data through Convex
functions or the dashboard.

## Removing a stage

`production` is protected and retains its VPC, subnets and RDS instance;
every other stage removes cleanly. What survives a removal, what a half-done
teardown leaves behind, and the order that actually works are all in
[docs/deployment-removal.md](docs/deployment-removal.md).
