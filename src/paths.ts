/**
 * Centralized path resolution.
 *
 * When running as a compiled binary, all data files (auth, db, pid, log)
 * are stored next to the executable.  When running via `bun run`, they
 * fall back to ~/.codex-proxy for backwards compatibility.
 *
 * Override: set CODEX_PROXY_DATA_DIR env to force a specific directory.
 */
import { join, dirname } from "path"
import { homedir } from "os"

/**
 * Detect whether we're running as a Bun-compiled single-file executable.
 * In compiled mode `process.execPath` points at the binary itself and there
 * is no separate script file in argv[1].
 */
function isCompiledBinary(): boolean {
  // Bun compiled binaries: argv[1] is the same as execPath
  // or argv[1] is a virtual path like /bun-exec
  const exec = process.execPath
  const script = process.argv[1]
  if (!script) return true
  if (exec === script) return true
  if (script.startsWith("/bun-exec")) return true
  // Check if execPath does NOT end with "bun" — if so it's our binary
  const base = exec.split("/").pop() ?? ""
  return base !== "bun" && base !== "bun.exe"
}

function resolveDataDir(): string {
  // 1. Explicit env override
  if (process.env.CODEX_PROXY_DATA_DIR) {
    return process.env.CODEX_PROXY_DATA_DIR
  }

  // 2. Compiled binary → same directory as the executable
  if (isCompiledBinary()) {
    return dirname(process.execPath)
  }

  // 3. Development (bun run) → ~/.codex-proxy
  return join(homedir(), ".codex-proxy")
}

/** Root directory for all codex-proxy data files */
export const DATA_DIR = resolveDataDir()

/** Path helpers */
export const AUTH_FILE = join(DATA_DIR, "auth.json")
export const ADMIN_KEY_FILE = join(DATA_DIR, "admin.key")
export const SESSIONS_DB = join(DATA_DIR, "sessions.db")
export const PID_FILE = join(DATA_DIR, "proxy.pid")
export const LOG_FILE = join(DATA_DIR, "proxy.log")
