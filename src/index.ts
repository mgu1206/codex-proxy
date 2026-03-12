/**
 * Codex Proxy - Direct entry point (backward compat)
 *
 * For CLI usage, prefer: codex-proxy serve
 * This file exists for: bun run src/index.ts
 */
import { createApp } from "./app"

const PORT = parseInt(process.env.PORT || "3456")
const WEB_PORT = parseInt(process.env.WEB_PORT || "19880")

const app = createApp({ webPort: WEB_PORT })

console.log(`
  Codex Proxy (direct mode)
  =========================
  http://localhost:${PORT}

  For full experience, use: codex-proxy serve
`)

export default {
  port: PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
}
