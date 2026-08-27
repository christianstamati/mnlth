/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STAGE_NAME: string
  readonly VITE_CONVEX_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
