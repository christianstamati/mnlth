import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  messages: defineTable({
    user: v.string(),
    // Who wrote it, as typed in the page. Optional so rows written before
    // the field existed still validate; they render as "anonymous".
    username: v.optional(v.string()),
    body: v.string(),
  }),
})
