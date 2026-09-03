import { defineConfig } from "vitest/config"

// convex-test runs the functions in an edge-like runtime, which is what the
// backend gives them. `bun test` at the repo root covers scripts/ and clone/;
// this config covers convex/.
export default defineConfig({
  test: {
    include: ["convex/**/*.test.ts"],
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
})
