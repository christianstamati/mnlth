import { defineConfig, devices } from "@playwright/test"

/**
 * Two ways to run the same specs:
 *
 *   bun e2e                                   # against Vite + the local Docker backend
 *   E2E_BASE_URL=https://pr-42.fullstackaws.dev bun e2e   # against a deployed stage
 *
 * With E2E_BASE_URL unset, Playwright starts Vite itself. The backend must
 * already be up: `bun dev` once, or `bun scripts/setup-dev.ts` in CI.
 *
 * Tests tagged @smoke never write data and are what runs against production
 * after a deploy (`--grep @smoke`). Everything else may write and runs
 * against previews, which are thrown away.
 */
const remote = process.env.E2E_BASE_URL

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: remote ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: remote
    ? undefined
    : {
        command: "bun run dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
})
