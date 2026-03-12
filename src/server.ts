/**
 * Codex Proxy - Server lifecycle
 *
 * Creates and manages the Bun HTTP server instance.
 */
import { createApp } from "./app"

export interface ServerOptions {
  port: number
  hostname: string
  webPort: number
}

export interface ProxyServer {
  port: number
  hostname: string
  stop: () => void
}

export function startServer(opts: ServerOptions): ProxyServer {
  const app = createApp({ webPort: opts.webPort })

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    fetch: app.fetch,
  })

  return {
    port: server.port ?? opts.port,
    hostname: server.hostname ?? opts.hostname,
    stop: () => server.stop(),
  }
}
