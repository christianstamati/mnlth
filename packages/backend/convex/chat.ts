import { v } from "convex/values"
import { mutation, query } from "./_generated/server"

export const sendMessage = mutation({
  args: { user: v.string(), username: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    console.log("sendMessage", args)
    const username = args.username.trim()
    if (!username) throw new Error("username is required")
    await ctx.db.insert("messages", {
      user: args.user,
      username,
      body: args.body,
    })
  },
})

export const getMessages = query({
  args: {},
  handler: async (ctx) => {
    const messages = await ctx.db.query("messages").order("desc").take(50)
    return messages.reverse()
  },
})
