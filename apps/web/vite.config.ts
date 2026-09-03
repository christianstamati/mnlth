import { sentryVitePlugin } from "@sentry/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

// Source maps go to Sentry only when CI has the token; a laptop build and a
// stage without Sentry skip the upload and keep the plugin out entirely.
const sentryUpload = process.env.SENTRY_AUTH_TOKEN
  ? [
      sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        release: { name: process.env.VITE_GIT_SHA },
        telemetry: false,
      }),
    ]
  : []

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    nitro(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    ...sentryUpload,
  ],
  build: {
    // Uploaded to Sentry when the token is set; harmless otherwise, and
    // the Lambda bundle keeps readable stack traces in its own logs.
    sourcemap: true,
  },
  nitro: {
    preset: "aws-lambda",
    awsLambda: {
      streaming: true,
    },
  },
})

export default config
