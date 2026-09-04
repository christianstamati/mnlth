# mnlth

Full-stack TypeScript on one AWS account: TanStack Start on Lambda, a
self-hosted Convex backend on EC2, one CloudFront in front, all in SST. The
README explains how it works; this file is what a reviewer or an agent needs
in one screen.

## Layout

- `apps/web` TanStack Start app. `src/routes` is file-based routing;
  `src/routeTree.gen.ts` is generated, never edited.
- `packages/backend/convex` Convex schema and functions. `_generated` is
  generated. Every table needs an entry in `packages/backend/clone/rules.ts`.
- `packages/ui` shadcn components on Base UI. The `Button` render prop needs
  `nativeButton={false}`.
- `infra/` SST components. `convex-backend.ts` builds the instance; editing
  its userData replaces every box on the next deploy, which loses data on
  stages with `storage: volume`.
- `.github/workflows` one reusable `deploy.yml`; the others only pick a stage.

## Commands

```bash
bun dev            # local: Convex in Docker, Vite on :3000
bun run check      # biome, writes fixes
bun run typecheck
bun test           # bun test for scripts/ and clone/, vitest for convex/
```

## Rules

- Stage names are lowercase, digits and hyphens, at most 24 characters.
  Production owns the VPC, router and certificate; deploy it first.
- The Convex admin key is a root credential. It lives in SSM and in the one
  process using it. Never an environment variable on the frontend and never a
  `VITE_` one: those are inlined into the client bundle.
- `VITE_` variables are public. Never put a token in one.
- Biome owns formatting and lint (`biome.json`). Do not argue style in review.
- Conventional commit subjects, with the Linear key at the end when there is
  one: `feat(chat): add timestamps (MNL-42)`. The PR title becomes the squash
  subject.
- Branches from Linear: `<you>/mnl-42-short-title`. Pushing one moves the
  issue to In Progress, the PR to In Review, the merge to Done.
- Tests: `*.test.ts` under `scripts/` and `packages/backend/clone` run with
  `bun test`; `packages/backend/convex/*.test.ts` run with vitest and
  convex-test.

## Review focus

- Anything in `infra/` or `sst.config.ts`: what gets replaced, what gets
  deleted, what a non-production stage could reach in production.
- Convex functions: argument validators on every function, no unbounded
  `.collect()`, indexes for new query shapes, auth checks where data is
  per-user.
- Workflows: permissions granted to a called workflow, secrets exposed to
  fork PRs, stage names reaching `sst` unchecked.
