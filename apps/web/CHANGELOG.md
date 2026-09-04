# web

## 1.2.0

### Minor Changes

- [`1ea86f1`](https://github.com/christianstamati/mnlth/commit/1ea86f14945351b49c54144d7bdd6312ceea183f) Thanks [@christianstamati](https://github.com/christianstamati)! - Deploys run from GitHub Actions again: branch-to-stage mapping moves to `deployments.json`, the settings file folds into `sst.config.ts`, and the build footer, Sentry client and monitoring go away.

## 1.1.0

### Minor Changes

- [#5](https://github.com/christianstamati/mnlth/pull/5) [`38c9428`](https://github.com/christianstamati/mnlth/commit/38c94280c2cc4f3e6436adb1166601e4ce7912b6) Thanks [@christianstamati](https://github.com/christianstamati)! - Delivery tooling: Changesets replace release-please, Renovate keeps dependencies current, Claude reviews pull requests, Playwright runs against previews and production, Sentry and CloudWatch alarms watch production and staging, and every page shows the stage and commit it was built from. Everything but Changesets was removed again in 269e5be; see the next release.
