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
