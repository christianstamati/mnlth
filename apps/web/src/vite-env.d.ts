/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STAGE_NAME: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
