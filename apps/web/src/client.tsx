/**
 * Browser entry. TanStack Start picks `src/client.tsx` up by name; this is
 * its default entry: StrictMode, StartClient, hydrateRoot.
 */
import { StartClient } from "@tanstack/react-start/client"
import { StrictMode, startTransition } from "react"
import { hydrateRoot } from "react-dom/client"

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>
  )
})
