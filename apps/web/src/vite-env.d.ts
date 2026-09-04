/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The SST stage this bundle was built for: `production`, `pr-42`, ... */
  readonly VITE_STAGE_NAME: string
  /** The commit the bundle was built from. */
  readonly VITE_GIT_SHA: string
  readonly VITE_CONVEX_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
