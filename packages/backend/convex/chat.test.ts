/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"

// convex-test needs the function modules up front; Vite's glob does that.
const modules = import.meta.glob("./**/*.ts")

describe("chat", () => {
  test("a sent message comes back from getMessages", async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.chat.sendMessage, {
      user: "me",
      username: "  chris ",
      body: "hello",
    })
    const messages = await t.query(api.chat.getMessages, {})
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ username: "chris", body: "hello" })
  })

  test("a blank username is refused", async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.chat.sendMessage, { user: "me", username: " ", body: "x" })
    ).rejects.toThrow("username is required")
  })

  test("getMessages returns the latest 50, oldest first", async () => {
    const t = convexTest(schema, modules)
    for (let i = 0; i < 60; i++) {
      await t.mutation(api.chat.sendMessage, {
        user: "me",
        username: "u",
        body: `m${i}`,
      })
    }
    const messages = await t.query(api.chat.getMessages, {})
    expect(messages).toHaveLength(50)
    expect(messages[0]?.body).toBe("m10")
    expect(messages.at(-1)?.body).toBe("m59")
  })
})
