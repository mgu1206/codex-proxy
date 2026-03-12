#!/usr/bin/env bun
/**
 * Codex Proxy CLI
 *
 * Usage:
 *   codex-proxy serve [options]     Start proxy + web console
 *   codex-proxy start [options]     Start proxy only (no web console)
 *   codex-proxy auth  [options]     Interactive CLI authentication
 *   codex-proxy version             Show version
 *   codex-proxy help                Show help
 */
import { readFile, writeFile, mkdir, rename } from "fs/promises"
import { join } from "path"
import { homedir } from "os"
import { spawn, type Subprocess } from "bun"
import { getAdminKey, setAdminKey, removeAdminKey, getToken, validateAdminKey } from "./auth"
import { startServer, type ProxyServer } from "./server"
import { startDeviceAuth, startHeadlessPKCE, submitCallbackUrl } from "./oauth"

const VERSION = "0.2.0"
const AUTH_DIR = join(homedir(), ".codex-proxy")
const PID_FILE = join(AUTH_DIR, "proxy.pid")
const LOG_FILE = join(AUTH_DIR, "proxy.log")

// ─── Arg Parsing ───

interface ParsedArgs {
  command: string
  port: number
  webPort: number
  hostname: string
  noOpen: boolean
  noWeb: boolean
  device: boolean
  help: boolean
  foreground: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2) // skip bun and script path
  const result: ParsedArgs = {
    command: args[0] ?? "help",
    port: 3456,
    webPort: 19880,
    hostname: "127.0.0.1",
    noOpen: false,
    noWeb: false,
    device: false,
    help: false,
    foreground: false,
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case "--port":
        result.port = parseInt(args[++i]) || result.port
        break
      case "--web-port":
        result.webPort = parseInt(args[++i]) || result.webPort
        break
      case "--hostname":
        result.hostname = args[++i] || result.hostname
        break
      case "--no-open":
        result.noOpen = true
        break
      case "--no-web":
        result.noWeb = true
        break
      case "--device":
        result.device = true
        break
      case "--foreground":
      case "-f":
        result.foreground = true
        break
      case "--help":
      case "-h":
        result.help = true
        break
    }
  }

  return result
}

// ─── Terminal I/O ───

function requireTTY() {
  if (!process.stdin.isTTY) {
    console.error("  [!!] Admin key not configured and stdin is not a terminal.")
    console.error("       Set admin key first: codex-proxy auth")
    console.error("       Or set CODEX_PROXY_ADMIN_KEY environment variable.")
    process.exit(1)
  }
}

function readLine(prompt: string): Promise<string> {
  requireTTY()
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    const onData = (buf: Buffer) => {
      process.stdin.removeListener("data", onData)
      process.stdin.pause()
      resolve(buf.toString().trim())
    }
    process.stdin.resume()
    process.stdin.once("data", onData)
  })
}

// ─── Admin Key ───

async function ensureAdminKey(): Promise<string> {
  const existing = await getAdminKey()
  if (existing) return existing

  console.log()
  console.log("  ================================================")
  console.log("  Admin key not configured.")
  console.log("  This key protects all API access to the proxy.")
  console.log("  ================================================")
  console.log()

  while (true) {
    const key = await readLine("  Enter admin key (min 8 chars): ")
    if (key.length < 8) {
      console.log("  [!!] Key must be at least 8 characters.")
      continue
    }
    const confirm = await readLine("  Confirm admin key: ")
    if (key !== confirm) {
      console.log("  [!!] Keys do not match. Try again.")
      continue
    }

    await setAdminKey(key)
    console.log("  [ok] Admin key saved.")
    console.log()
    return key
  }
}

async function cmdInit(argv: string[]): Promise<void> {
  const key = argv.slice(2).find((a) => !a.startsWith("-") && a !== "init")
  if (!key) {
    console.log("  Usage: codex-proxy init <admin-key>")
    process.exit(1)
  }
  if (key.length < 8) {
    console.log("  [!!] Key must be at least 8 characters.")
    process.exit(1)
  }
  const existing = await getAdminKey()
  if (existing) {
    console.log("  [!!] Admin key already configured.")
    console.log("  Run 'codex-proxy reset-key' first to remove it.")
    process.exit(1)
  }
  await setAdminKey(key)
  console.log("  [ok] Admin key configured.")
}

async function cmdResetKey(): Promise<void> {
  await removeAdminKey()
  console.log()
  console.log("  [ok] Admin key removed.")
  console.log("  Next server start will prompt for a new key.")
  console.log()
}

// ─── Web Console Process ───

let webProcess: Subprocess | null = null

function startWebConsole(opts: {
  port: number
  proxyPort: number
  noOpen: boolean
  adminKey: string
}): Subprocess {
  const scriptPath = join(import.meta.dir, "..", "web", "main.py")

  const args = ["python", scriptPath]
  if (opts.noOpen) args.push("--no-open")
  args.push("--web-only") // proxy is already running in this process

  const proc = spawn(args, {
    env: {
      ...process.env,
      PROXY_PORT: String(opts.proxyPort),
      WEB_PORT: String(opts.port),
      PROXY_URL: `http://127.0.0.1:${opts.proxyPort}`,
      CODEX_PROXY_ADMIN_KEY: opts.adminKey,
    },
    stdout: "inherit",
    stderr: "inherit",
  })

  return proc
}

function stopWebConsole() {
  if (webProcess) {
    webProcess.kill()
    webProcess = null
  }
}

// ─── PID Management ───

async function writePid(): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true })
  await writeFile(PID_FILE, String(process.pid))
}

async function readPid(): Promise<number | null> {
  try {
    const content = await readFile(PID_FILE, "utf-8")
    return parseInt(content.trim()) || null
  } catch {
    return null
  }
}

async function removePid(): Promise<void> {
  try {
    const { unlink } = await import("fs/promises")
    await unlink(PID_FILE)
  } catch {}
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function daemonize(args: ParsedArgs): Promise<void> {
  // Admin key must be set before daemonizing (can't prompt in background)
  const adminKey = await getAdminKey()
  if (!adminKey) {
    console.log("  [!!] Admin key not configured. Set it first:")
    console.log("       codex-proxy serve -f   (foreground, will prompt)")
    console.log("       codex-proxy auth")
    process.exit(1)
  }

  // Check if already running
  const existingPid = await readPid()
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`  [!!] Already running (PID ${existingPid})`)
    console.log(`  Run 'codex-proxy stop' first.`)
    process.exit(1)
  }

  // Re-spawn self with --foreground flag
  const scriptPath = process.argv[1]
  const childArgs = ["bun", "run", scriptPath, args.command, "--foreground"]
  childArgs.push("--port", String(args.port))
  childArgs.push("--web-port", String(args.webPort))
  childArgs.push("--hostname", args.hostname)
  if (args.noOpen) childArgs.push("--no-open")
  if (args.noWeb) childArgs.push("--no-web")

  await mkdir(AUTH_DIR, { recursive: true })

  const child = spawn(childArgs.slice(1), {
    env: process.env,
    stdin: "ignore",
    stdout: Bun.file(LOG_FILE),
    stderr: Bun.file(LOG_FILE),
  })

  child.unref()

  // Wait briefly and check if the process started successfully
  await new Promise((r) => setTimeout(r, 500))

  if (child.exitCode !== null) {
    console.log(`  [!!] Failed to start. Check logs: ${LOG_FILE}`)
    process.exit(1)
  }

  console.log()
  console.log(`  Codex Proxy v${VERSION} started (PID ${child.pid})`)
  console.log(`  Proxy API:  http://${args.hostname}:${args.port}`)
  if (args.command === "serve" && !args.noWeb) {
    console.log(`  Web console: http://localhost:${args.webPort}`)
  }
  console.log(`  Logs:       ${LOG_FILE}`)
  console.log()
  console.log(`  Stop with:  codex-proxy stop`)
  console.log()
}

// ─── Commands ───

async function cmdServe(args: ParsedArgs) {
  if (!args.foreground) {
    await daemonize(args)
    return
  }

  const adminKey = await ensureAdminKey()
  await writePid()

  console.log()
  console.log("  Codex Proxy v" + VERSION)
  console.log("  ====================")

  // Start the proxy server (in-process)
  const server = startServer({
    port: args.port,
    hostname: args.hostname,
    webPort: args.webPort,
  })
  console.log(`  Proxy API:    http://${server.hostname}:${server.port}`)

  // Start web console (child process)
  if (!args.noWeb) {
    console.log(`  Web console:  http://localhost:${args.webPort}`)
    console.log()

    webProcess = startWebConsole({
      port: args.webPort,
      proxyPort: server.port,
      noOpen: args.noOpen,
      adminKey,
    })
  } else {
    console.log()
    console.log("  (web console disabled)")
  }

  console.log()

  // Block until signal
  await waitForSignal(server)
  await removePid()
}

async function cmdStart(args: ParsedArgs) {
  if (!args.foreground) {
    args.noWeb = true
    await daemonize(args)
    return
  }

  const adminKey = await ensureAdminKey()
  await writePid()

  console.log()
  console.log("  Codex Proxy v" + VERSION + " (API only)")
  console.log("  ==================================")

  const server = startServer({
    port: args.port,
    hostname: args.hostname,
    webPort: args.webPort,
  })

  console.log(`  http://${server.hostname}:${server.port}`)
  console.log()

  // Check auth status
  const token = await getToken()
  if (token && token.expires > Date.now()) {
    console.log(`  [ok] Authenticated (account: ${token.accountId ?? "N/A"})`)
  } else {
    console.log(`  [!!] Not authenticated. Run: codex-proxy auth`)
  }

  console.log()
  await waitForSignal(server)
  await removePid()
}

async function cmdStop() {
  const pid = await readPid()
  if (!pid) {
    console.log("  [!!] No running proxy found.")
    return
  }
  if (!isProcessRunning(pid)) {
    console.log(`  [!!] Process ${pid} not running (stale PID file).`)
    await removePid()
    return
  }
  try {
    process.kill(pid, "SIGTERM")
    console.log(`  [ok] Stopped (PID ${pid})`)
  } catch (err: any) {
    console.log(`  [!!] Failed to stop: ${err.message}`)
  }
  await removePid()
}

async function cmdProcessStatus() {
  const pid = await readPid()
  if (!pid) {
    console.log("  [--] Not running.")
    return
  }
  if (isProcessRunning(pid)) {
    console.log(`  [ok] Running (PID ${pid})`)
  } else {
    console.log(`  [--] Not running (stale PID file).`)
    await removePid()
  }
}

async function cmdAuth(args: ParsedArgs) {
  const adminKey = await ensureAdminKey()

  console.log()
  console.log("  Codex Proxy - Authentication")
  console.log("  ============================")
  console.log()

  // Check current status
  const token = await getToken()
  if (token && token.expires > Date.now()) {
    console.log(`  [ok] Already authenticated (account: ${token.accountId ?? "N/A"})`)
    console.log()
    const choice = await readLine("  Re-authenticate? (y/N): ")
    if (choice.toLowerCase() !== "y") return
  }

  if (args.device) {
    await doDeviceAuth()
    return
  }

  // Choose method
  console.log("  Authentication methods:")
  console.log("    1) Device Code     - enter a code on any device (recommended)")
  console.log("    2) Headless OAuth  - open link, paste redirect URL back")
  console.log()
  const choice = await readLine("  Choose method (1/2): ")

  if (choice === "2") {
    await doHeadlessAuth()
  } else {
    await doDeviceAuth()
  }
}

async function doDeviceAuth() {
  console.log()
  console.log("  [..] Starting device code auth...")

  const { url, userCode, wait } = await startDeviceAuth()

  console.log()
  console.log(`  Visit:  ${url}`)
  console.log(`  Code:   ${userCode}`)
  console.log()
  process.stdout.write("  Waiting for authorization")

  const timeout = setTimeout(() => {
    console.log()
    console.log()
    console.log("  [!!] Timed out waiting for authorization.")
    process.exit(1)
  }, 5 * 60 * 1000)

  const dots = setInterval(() => process.stdout.write("."), 3000)

  try {
    const token = await wait()
    clearTimeout(timeout)
    clearInterval(dots)
    console.log()
    console.log()
    console.log(`  [ok] Authenticated! (account: ${token.accountId ?? "N/A"})`)
    console.log()
  } catch (err: any) {
    clearTimeout(timeout)
    clearInterval(dots)
    console.log()
    console.error(`  [!!] Auth failed: ${err.message}`)
    process.exit(1)
  }
}

async function doHeadlessAuth() {
  console.log()
  console.log("  [..] Starting headless OAuth...")

  const { authUrl, redirectUri } = await startHeadlessPKCE()

  console.log()
  console.log("  Step 1: Open this URL in any browser:")
  console.log()
  console.log(`  ${authUrl}`)
  console.log()
  console.log("  Step 2: Sign in to your ChatGPT account.")
  console.log()
  console.log("  Step 3: After sign-in, the browser will try to redirect to")
  console.log(`          ${redirectUri}...`)
  console.log("          This will show an error page -- THIS IS EXPECTED.")
  console.log()
  console.log("  Step 4: Copy the FULL URL from your browser's address bar")
  console.log("          (it looks like: http://localhost:1455/auth/callback?code=...&state=...)")
  console.log()

  while (true) {
    const callbackUrl = await readLine("  Paste the callback URL here: ")
    if (!callbackUrl) continue

    try {
      const token = await submitCallbackUrl(callbackUrl)
      console.log()
      console.log(`  [ok] Authenticated! (account: ${token.accountId ?? "N/A"})`)
      console.log()
      return
    } catch (err: any) {
      console.log(`  [!!] Error: ${err.message}`)
      console.log("  Try again or Ctrl+C to cancel.")
      console.log()
    }
  }
}

// ─── Signal Handling ───

async function waitForSignal(server: ProxyServer): Promise<void> {
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      console.log("\n  Shutting down...")
      stopWebConsole()
      server.stop()
      resolve()
    }

    process.on("SIGINT", cleanup)
    process.on("SIGTERM", cleanup)
  })
}

// ─── Help ───

function showHelp() {
  console.log(`
  codex-proxy v${VERSION}
  OAuth proxy for OpenAI Codex API

  Usage:
    codex-proxy <command> [options]

  Commands:
    init <key>         Set admin key (fails if already set)
    serve              Start proxy + web console (background)
    start              Start proxy only (background)
    stop               Stop running proxy
    status             Show proxy status
    auth               Interactive CLI authentication
    reset-key          Remove admin key
    version            Show version
    help               Show this help

  Options (serve/start):
    --port <n>         Proxy API port (default: 3456)
    --web-port <n>     Web console port (default: 19880)
    --hostname <host>  Bind address (default: 127.0.0.1)
    --no-open          Don't auto-open browser
    --no-web           Disable web console (serve only)
    -f, --foreground   Run in foreground (don't detach)

  Options (auth):
    --device           Skip method selection, use device code

  Examples:
    codex-proxy init my-secret-key
    codex-proxy serve
    codex-proxy serve --port 8080
    codex-proxy serve -f               # foreground mode
    codex-proxy stop
    codex-proxy auth --device
`)
}

// ─── Main ───

async function main() {
  const args = parseArgs(process.argv)

  if (args.help) {
    showHelp()
    return
  }

  switch (args.command) {
    case "serve":
      await cmdServe(args)
      break
    case "start":
      await cmdStart(args)
      break
    case "init":
      await cmdInit(process.argv)
      break
    case "auth":
      await cmdAuth(args)
      break
    case "stop":
      await cmdStop()
      break
    case "status":
      await cmdProcessStatus()
      break
    case "reset-key":
      await cmdResetKey()
      break
    case "version":
    case "--version":
    case "-v":
      console.log(`codex-proxy v${VERSION}`)
      break
    case "help":
    case "--help":
    case "-h":
      showHelp()
      break
    default:
      console.error(`  Unknown command: ${args.command}`)
      console.error(`  Run 'codex-proxy help' for usage.`)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
