import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router"

import appCss from "@workspace/ui/globals.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "TanStack Start Starter",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  notFoundComponent: () => (
    <main className="container mx-auto p-4 pt-16">
      <h1>404</h1>
      <p>The requested page could not be found.</p>
    </main>
  ),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <BuildFooter />
        <Scripts />
      </body>
    </html>
  )
}

/**
 * Which deploy this is, on every page. The cheapest thing that improves a
 * bug report: "production at 3f2a1c9" says exactly what to look at.
 */
function BuildFooter() {
  const stage = import.meta.env.VITE_STAGE_NAME || "local"
  const sha = import.meta.env.VITE_GIT_SHA?.slice(0, 7) || "dev"
  return (
    <footer
      className="fixed right-3 bottom-3 font-mono text-muted-foreground text-xs"
      data-testid="build"
    >
      {stage} · {sha}
    </footer>
  )
}
