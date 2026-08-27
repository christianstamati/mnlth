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
backend in dev. Running `bun dev` (plain Vite, no SST) skips that injection, so
export it yourself or use `bun sst:dev`.

Deploying the Convex backend itself is not set up — only local development is.
Non-dev stages read `CONVEX_URL` from the environment.

## Deploying (SST)

`apps/web` deploys to AWS as a streaming Lambda behind CloudFront, via
`sst.aws.TanStackStart` in `sst.config.ts`:

```ts
async run() {
  const web = new sst.aws.TanStackStart("MyWeb", {
    path: "apps/web",
  })

  return { url: web.url }
}
```

The component requires Nitro's `aws-lambda` preset, set in
`apps/web/vite.config.ts`:

```ts
nitro: {
  preset: "aws-lambda",
  awsLambda: {
    streaming: true,
  },
}
```

```bash
bun sst:dev                        # sst dev — app on http://localhost:3000
bunx sst deploy --stage production # deploy
bun sst:remove                     # tear down
```

Add a custom domain with `domain: "example.com"`, and AWS resources with
`link: [...]` — linked resources are read in the app via
`import { Resource } from "sst"`.
