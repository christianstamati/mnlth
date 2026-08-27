import { createRouter as createTanStackRouter } from "@tanstack/react-router"
import { ConvexProvider, ConvexReactClient } from "convex/react"
import { routeTree } from "./routeTree.gen"

export function getRouter() {
  const convexUrl = import.meta.env.VITE_CONVEX_URL
  if (!convexUrl) {
    throw new Error(
      "Missing VITE_CONVEX_URL. Start the local stack with `bun sst dev`, which runs the self-hosted Convex backend on http://127.0.0.1:3210."
    )
  }

  const convex = new ConvexReactClient(convexUrl)

  const router = createTanStackRouter({
    routeTree,

    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    Wrap: ({ children }) => (
      <ConvexProvider client={convex}>{children}</ConvexProvider>
    ),
  })

  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
