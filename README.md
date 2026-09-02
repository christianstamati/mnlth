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

## Local development

```bash
bun sst dev --stage <stage>
```

`sst dev` deploys the stage (its EC2 backend included, so the first run takes
a few minutes) and then runs Vite on http://localhost:3000 with
`VITE_CONVEX_URL` set to the stage's backend. Nothing runs in Docker locally:
the app in the browser talks to the stage's deployed Convex backend, the same
one `bun sst deploy` serves at `<stage>.<domain>`. Push function changes with
`bun convex:deploy --stage <stage>` (see below), or run
`bun convex:deploy --stage <stage> --dev` alongside to push on every save.

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

Two things ship per stage, both under the domain in `sst.settings.json`:

| | Hostname | What runs |
| --- | --- | --- |
| `apps/web` | apex for production, `<stage>.` otherwise | TanStack Start on a streaming Lambda behind one shared CloudFront distribution |
| Convex | `api.` · `site.` · `dashboard.`, prefixed `<stage>-` off production | one EC2 instance behind Caddy; storage and database per `sst.settings.json` |

The frontend needs Nitro's `aws-lambda` preset, set in `apps/web/vite.config.ts`.

Production owns the shared VPC, the certificate bucket and the CloudFront
distribution (an `sst.aws.Router` with a `*.<domain>` alias, which is how every
other stage gets its own subdomain without a distribution of its own). It
publishes their ids to SSM, so it deploys first and is removed last:

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

The backend comes up empty; the functions in `packages/backend/convex` have
to be pushed into it. The Convex CLI needs two variables for a self-hosted
deployment, `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`, and
the key can only come from the running backend: the instance mints it and
publishes it to SSM a few minutes into its first boot.

`scripts/convex-deploy.ts` reads the URL from `/mnlth/<stage>/convex/url` and
the key from `/mnlth/<stage>/convex/admin-key` and runs `convex deploy`. Run
it after `sst deploy`, and again whenever `packages/backend/convex` changes:

```bash
bun convex:deploy --stage production          # fails fast if the key is not published yet
bun convex:deploy --stage production --wait   # polls for it, up to 15 minutes
```

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
five buckets reach the box through SSM, which userData reads at boot —
nothing sensitive lands in userData itself,
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
