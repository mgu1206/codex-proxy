/**
 * Codex Proxy - Hono application
 *
 * All routes and middleware. Exported as `app` for use by the server.
 */
import { Hono, type Context } from "hono"
import { getToken, removeToken, getAdminKey, setAdminKey, validateAdminKey } from "./auth"
import { startBrowserAuth, startDeviceAuth, startHeadlessPKCE, submitCallbackUrl } from "./oauth"
import { proxyHandler, sendToCodex, type CodexOptions } from "./proxy"
import {
  createSession,
  getSession,
  listSessions,
  updateSession,
  deleteSession,
  addMessage,
  getMessages,
  buildMessagesForAPI,
  needsCompaction,
  prepareCompaction,
  applyCompaction,
  type ChatMessage,
  MODEL_CONTEXT_LIMITS,
} from "./session"

export interface AppOptions {
  webPort: number
}

export function createApp(opts: AppOptions) {
  const app = new Hono()

  // ─── CORS Middleware ───

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin")
    const allowed = `http://localhost:${opts.webPort}`
    await next()
    c.header("x-content-type-options", "nosniff")
    if (origin === allowed || origin === `http://127.0.0.1:${opts.webPort}`) {
      c.header("access-control-allow-origin", origin)
      c.header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS")
      c.header("access-control-allow-headers", "content-type,x-admin-key")
    }
  })

  // CORS preflight
  app.options("*", () => new Response(null, { status: 204 }))

  // ─── Admin Key Auth Middleware ───

  let cachedAdminKey: string | null = null

  async function loadAdminKey(): Promise<string | null> {
    if (!cachedAdminKey) {
      cachedAdminKey = await getAdminKey()
    }
    return cachedAdminKey
  }

  app.use("*", async (c, next) => {
    // Health endpoint is public
    if (c.req.path === "/" && c.req.method === "GET") {
      return next()
    }

    // CORS preflight must pass without auth
    if (c.req.method === "OPTIONS") {
      return next()
    }

    const adminKey = await loadAdminKey()
    if (!adminKey) {
      return c.json({ error: "Server not initialized. Set admin key first." }, 503)
    }

    const provided =
      c.req.header("x-admin-key") ||
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "")

    if (!validateAdminKey(provided ?? null, adminKey)) {
      return c.json({ error: "Unauthorized. Provide valid admin key via X-Admin-Key header." }, 401)
    }

    return next()
  })

  // ─── Localhost Guard ───

  function isLocalhost(c: Context): boolean {
    const host = c.req.header("host") ?? ""
    return (
      host.startsWith("localhost:") ||
      host.startsWith("127.0.0.1:") ||
      host === "localhost" ||
      host === "127.0.0.1"
    )
  }

  // ─── Admin Key Routes (localhost only) ───

  app.post("/admin/setup", async (c) => {
    if (!isLocalhost(c)) {
      return c.json({ error: "Admin setup is only allowed from localhost." }, 403)
    }
    const existing = await getAdminKey()
    if (existing) {
      return c.json({ error: "Admin key already configured. Use PUT /admin/key to change." }, 409)
    }
    const body = await c.req.json<{ key: string }>()
    if (!body.key || body.key.length < 8) {
      return c.json({ error: "Key must be at least 8 characters." }, 400)
    }
    await setAdminKey(body.key)
    cachedAdminKey = body.key
    return c.json({ status: "ok", message: "Admin key configured." })
  })

  app.put("/admin/key", async (c) => {
    if (!isLocalhost(c)) {
      return c.json({ error: "Admin key change is only allowed from localhost." }, 403)
    }
    const existing = await getAdminKey()
    if (!existing) {
      return c.json({ error: "No admin key configured. Use POST /admin/setup first." }, 400)
    }
    const body = await c.req.json<{ current_key: string; new_key: string }>()
    if (!body.current_key || !validateAdminKey(body.current_key, existing)) {
      return c.json({ error: "Current key is incorrect." }, 401)
    }
    if (!body.new_key || body.new_key.length < 8) {
      return c.json({ error: "New key must be at least 8 characters." }, 400)
    }
    await setAdminKey(body.new_key)
    cachedAdminKey = body.new_key
    return c.json({ status: "ok", message: "Admin key updated." })
  })

  // ─── Auth Routes ───

  app.post("/auth/login", async (c) => {
    const existing = await getToken()
    if (existing && existing.expires > Date.now()) {
      return c.json({ status: "already_authenticated", expires: existing.expires })
    }
    const { url, wait } = await startBrowserAuth()
    wait().catch((err) => console.error("[auth] browser auth failed:", err.message))
    return c.json({ status: "pending", message: "Open this URL in your browser:", url })
  })

  app.post("/auth/headless", async (c) => {
    const existing = await getToken()
    if (existing && existing.expires > Date.now()) {
      return c.json({ status: "already_authenticated", expires: existing.expires })
    }
    const { authUrl, redirectUri } = await startHeadlessPKCE()
    return c.json({
      status: "pending",
      method: "headless",
      message: "Open this URL, authenticate, then paste the callback URL back.",
      authUrl,
      redirectUri,
    })
  })

  app.post("/auth/headless/callback", async (c) => {
    const body = await c.req.json<{ url: string }>()
    if (!body.url) return c.json({ error: "url is required" }, 400)
    try {
      const token = await submitCallbackUrl(body.url)
      return c.json({ status: "authenticated", accountId: token.accountId })
    } catch (err: any) {
      return c.json({ error: err.message }, 400)
    }
  })

  app.post("/auth/device", async (c) => {
    const existing = await getToken()
    if (existing && existing.expires > Date.now()) {
      return c.json({ status: "already_authenticated", expires: existing.expires })
    }
    const { url, userCode, wait } = await startDeviceAuth()
    wait().catch((err) => console.error("[auth] device auth failed:", err.message))
    return c.json({ status: "pending", message: "Visit the URL and enter the code:", url, code: userCode })
  })

  app.get("/auth/status", async (c) => {
    const token = await getToken()
    if (!token) return c.json({ authenticated: false })
    return c.json({
      authenticated: true,
      expires: token.expires,
      expired: token.expires < Date.now(),
      accountId: token.accountId ?? null,
    })
  })

  app.delete("/auth/logout", async (c) => {
    await removeToken()
    return c.json({ status: "logged_out" })
  })

  // ─── Session Routes ───

  app.post("/sessions", async (c) => {
    const raw: any = await c.req.json().catch(() => ({}))
    const body = {
      title: typeof raw?.title === "string" ? raw.title : undefined,
      model: typeof raw?.model === "string" ? raw.model : undefined,
      system_prompt: typeof raw?.system_prompt === "string" ? raw.system_prompt : undefined,
    }
    const session = createSession(body)
    return c.json(session, 201)
  })

  app.get("/sessions", (c) => {
    return c.json(listSessions())
  })

  app.get("/sessions/:id", (c) => {
    const session = getSession(c.req.param("id"))
    if (!session) return c.json({ error: "Session not found" }, 404)
    const messages = getMessages(session.id)
    return c.json({ ...session, messages })
  })

  app.patch("/sessions/:id", async (c) => {
    const id = c.req.param("id")
    if (!getSession(id)) return c.json({ error: "Session not found" }, 404)
    const raw: any = await c.req.json().catch(() => ({}))
    const body = {
      title: typeof raw?.title === "string" ? raw.title : undefined,
      model: typeof raw?.model === "string" ? raw.model : undefined,
      system_prompt: typeof raw?.system_prompt === "string" ? raw.system_prompt : undefined,
    }
    const updated = updateSession(id, body)
    return c.json(updated)
  })

  app.delete("/sessions/:id", (c) => {
    const deleted = deleteSession(c.req.param("id"))
    if (!deleted) return c.json({ error: "Session not found" }, 404)
    return c.json({ status: "deleted" })
  })

  // ─── Session Chat ───

  app.post("/sessions/:id/chat", async (c) => {
    let session = getSession(c.req.param("id"))
    if (!session) return c.json({ error: "Session not found" }, 404)

    const body = await c.req.json<any>()
    if (!body.content) return c.json({ error: "content is required" }, 400)

    const codexOpts = extractCodexOptions(body)

    // 1. Save user message
    addMessage(session.id, "user", body.content)

    // 2. Auto-compact if needed
    let compacted = false
    const check = needsCompaction(session)
    if (check.needed) {
      const prep = prepareCompaction(session)
      if (prep) {
        console.log(
          `[compact] session ${session.id}: ${prep.tokensBefore} tokens (~${Math.round((prep.tokensBefore / check.limit) * 100)}% of ${check.limit}), summarizing ${prep.messagesRemoved} messages...`,
        )
        try {
          const summaryResponse = await sendToCodex(prep.prompt, session.model, false)
          if (summaryResponse.ok) {
            const data = await summaryResponse.json()
            const summaryText = extractAssistantContent(data)
            if (summaryText) {
              applyCompaction(session.id, summaryText, prep.messagesToRemoveBefore)
              session = getSession(session.id)!
              compacted = true
              console.log(`[compact] done. summary: ${summaryText.length} chars`)
            }
          }
        } catch (err: any) {
          console.error(`[compact] failed, continuing without compaction:`, err.message)
        }
      }
    }

    // 3. Build full conversation history
    const messages = buildMessagesForAPI(session)

    // 4. Call Codex API (always stream internally, Codex requires it)
    const clientWantsStream = body.stream ?? false

    try {
      const upstream = await sendToCodex(messages, session.model, true, session.id, codexOpts)

      if (!upstream.ok) {
        const err = await upstream.text()
        return c.json({ error: "Codex API error", status: upstream.status, detail: err }, 502)
      }

      if (clientWantsStream) {
        // Client wants streaming: tee and forward
        const [forClient, forCollect] = upstream.body!.tee()
        collectStream(forCollect).then((text) => {
          if (text) addMessage(session.id, "assistant", text)
        })
        return new Response(forClient, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            ...(compacted && { "x-compacted": "true" }),
          },
        })
      }

      // Client wants non-streaming: collect full response internally
      const assistantContent = await collectStream(upstream.body!)
      if (assistantContent) {
        addMessage(session.id, "assistant", assistantContent)
      }

      return c.json({
        session_id: session.id,
        message: assistantContent,
        compacted,
      })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // ─── One-shot Chat (no persistent session) ───

  app.post("/chat", async (c) => {
    const body = await c.req.json<any>()
    if (!body.content) return c.json({ error: "content is required" }, 400)

    const model = typeof body.model === "string" ? body.model : "gpt-4o"
    const instructions = typeof body.instructions === "string" ? body.instructions : "You are a helpful assistant."
    const clientWantsStream = body.stream ?? false
    const codexOpts = extractCodexOptions(body)

    const messages: ChatMessage[] = [
      { role: "system", content: instructions },
      { role: "user", content: body.content },
    ]

    try {
      const upstream = await sendToCodex(messages, model, true, undefined, codexOpts)

      if (!upstream.ok) {
        const err = await upstream.text()
        return c.json({ error: "Codex API error", status: upstream.status, detail: err }, 502)
      }

      if (clientWantsStream) {
        return new Response(upstream.body, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        })
      }

      const assistantContent = await collectStream(upstream.body!)
      return c.json({ message: assistantContent })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  // ─── Raw Proxy (no session) ───

  app.post("/v1/responses", proxyHandler)
  app.post("/v1/chat/completions", proxyHandler)
  app.all("/v1/*", proxyHandler)

  // ─── Models ───

  app.get("/models", (c) => {
    const models = Object.entries(MODEL_CONTEXT_LIMITS).map(([id, context_window]) => ({
      id,
      context_window,
    }))
    return c.json(models)
  })

  // ─── Health ───

  app.get("/", (c) => {
    return c.json({
      name: "codex-proxy",
      version: "0.2.0",
      endpoints: {
        admin: [
          "POST /admin/setup (localhost only)",
          "PUT /admin/key (localhost only)",
        ],
        auth: [
          "POST /auth/login",
          "POST /auth/device",
          "GET /auth/status",
          "DELETE /auth/logout",
        ],
        models: [
          "GET /models",
        ],
        chat: [
          "POST /chat",
        ],
        sessions: [
          "POST /sessions",
          "GET /sessions",
          "GET /sessions/:id",
          "PATCH /sessions/:id",
          "DELETE /sessions/:id",
          "POST /sessions/:id/chat",
        ],
        proxy: [
          "POST /v1/responses",
          "POST /v1/chat/completions",
        ],
      },
    })
  })

  return app
}

// ─── Helpers ───

function extractAssistantContent(data: any): string | null {
  if (data?.choices?.[0]?.message?.content) {
    return data.choices[0].message.content
  }
  if (data?.output) {
    const textParts = data.output
      .filter((o: any) => o.type === "message")
      .flatMap((o: any) => o.content ?? [])
      .filter((c: any) => c.type === "output_text")
      .map((c: any) => c.text)
    if (textParts.length > 0) return textParts.join("")
  }
  return null
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let collected = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const payload = line.slice(6).trim()
        if (payload === "[DONE]") continue
        try {
          const chunk = JSON.parse(payload)
          const delta = chunk?.choices?.[0]?.delta?.content
          if (delta) collected += delta
          if (chunk?.type === "response.output_text.delta" && chunk?.delta) {
            collected += chunk.delta
          }
        } catch {}
      }
    }
  } catch {} finally {
    reader.releaseLock()
  }

  return collected || null
}

const CODEX_OPTION_KEYS = [
  "temperature", "top_p", "max_output_tokens", "truncation",
  "tool_choice", "tools", "parallel_tool_calls",
  "reasoning", "metadata",
] as const

function extractCodexOptions(body: any): CodexOptions | undefined {
  const opts: Record<string, unknown> = {}
  let hasAny = false
  for (const key of CODEX_OPTION_KEYS) {
    if (body[key] !== undefined) {
      opts[key] = body[key]
      hasAny = true
    }
  }
  return hasAny ? (opts as CodexOptions) : undefined
}
