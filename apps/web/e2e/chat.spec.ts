import { expect, test } from "@playwright/test"

// Read-only: safe against production.
test("renders and connects to Convex", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/")
  await expect(page.getByText("Project ready!")).toBeVisible()
  // The list shows this until the WebSocket subscription delivers.
  await expect(page.getByText("Connecting to Convex…")).toBeHidden({
    timeout: 15_000,
  })
})

// Read-only: the footer names the stage the bundle was built for. Against a
// deployed stage that must match the URL's subdomain.
test("shows the stage and commit", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/")
  const footer = page.getByTestId("build")
  await expect(footer).toBeVisible()
  await expect(footer).toHaveText(/^[a-z0-9-]+ · [0-9a-f]{7}$|^local · dev$/)
})

// Writes a row. Previews and the local backend only.
test("sends a message through Convex", async ({ page }) => {
  const body = `e2e ${Date.now()}`
  await page.goto("/")
  // The inputs are controlled: typing before React hydrates leaves its
  // state empty and the submit handler drops the message. The query
  // delivering is the signal that the client is hydrated and connected.
  await expect(page.getByText("Connecting to Convex…")).toBeHidden({
    timeout: 15_000,
  })
  await page.getByPlaceholder("Your name").fill("playwright")
  await page.getByPlaceholder("Say something to Convex").fill(body)
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText(body)).toBeVisible()
})
