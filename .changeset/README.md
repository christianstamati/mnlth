# Changesets

Every pull request that changes what ships adds a file here:

```bash
bun changeset
```

Pick the bump (patch for a fix, minor for a feature, major for a break) and
write one sentence for the people who read release notes. Only `web` is
versioned; the two internal packages are ignored. The version lives in
`apps/web/package.json` and the changelog next to it.

CI refuses a pull request without a changeset unless it carries the
`no changeset` label.

On every push to `main`, `release.yml` keeps a "chore: release" pull request
up to date that consumes these files, bumps the version and writes
`CHANGELOG.md`. Merging it tags `web@<version>`, publishes a GitHub Release
and posts it to Slack.
