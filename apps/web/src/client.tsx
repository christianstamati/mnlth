/**
 * Browser entry. TanStack Start picks `src/client.tsx` up by name; this is
 * its default entry (StrictMode, StartClient, hydrateRoot) plus Sentry.
 *
 * Sentry only initializes when a DSN is present, so a laptop and a stage
 * without one run exactly as before. Every event carries the stage and the
 * commit, so a report says which deploy it came from.
 */
import * as Sentry from "@sentry/tanstackstart-react"
import { StartClient } from "@tanstack/react-start/client"
import { StrictMode, startTransition } from "react"
import { hydrateRoot } from "react-dom/client"

const dsn = import.meta.env.VITE_SENTRY_DSN
const stage = import.meta.env.VITE_STAGE_NAME

if (dsn) {
  Sentry.init({
    dsn,
    environment: stage,
    release: import.meta.env.VITE_GIT_SHA,
    // Every trace on a preview, a sample of them in production.
    tracesSampleRate: stage === "production" ? 0.1 : 1,
    integrations: [
      Sentry.browserTracingIntegration(),
      // "Report a bug" in the corner of every page: description, screenshot,
      // and the breadcrumbs that led there. Sentry's Linear integration
      // turns each one into an issue.
      Sentry.feedbackIntegration({
        colorScheme: "system",
        showBranding: false,
      }),
    ],
  })
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>
  )
})
