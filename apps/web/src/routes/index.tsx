import { createFileRoute } from "@tanstack/react-router"
import { api } from "@workspace/backend/convex/_generated/api"
import { Button } from "@workspace/ui/components/button"
import { useMutation, useQuery } from "convex/react"
import { useState } from "react"

export const Route = createFileRoute("/")({ component: App })

function App() {
  const messages = useQuery(api.chat.getMessages)
  const sendMessage = useMutation(api.chat.sendMessage)
  const [body, setBody] = useState("")

  return (
    <div className="flex min-h-svh p-6">
      <div className="flex min-w-0 max-w-md flex-col gap-4 text-sm leading-loose">
        <div>
          <h1 className="font-medium">Project ready!</h1>
          <p>You may now add components and start building.</p>
          <p>We&apos;ve already added the button component for you.</p>
          <p>
            Stage:{" "}
            <span className="font-mono">{import.meta.env.VITE_STAGE_NAME}</span>
          </p>
        </div>

        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!body.trim()) return
            void sendMessage({ user: "me", body })
            setBody("")
          }}
        >
          <input
            className="rounded-md border px-3 py-1"
            placeholder="Say something to Convex"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <Button type="submit">Send</Button>
        </form>

        <ul className="flex flex-col">
          {messages === undefined ? (
            <li className="text-muted-foreground">Connecting to Convex…</li>
          ) : (
            messages.map((message) => (
              <li key={message._id}>
                <span className="font-mono">{message.user}</span>:{" "}
                {message.body}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}
