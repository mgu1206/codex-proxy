"""
Codex Proxy - serve command

Single entry point that:
  1. Prompts for admin key if not configured
  2. Starts the Bun proxy backend (OAuth + API proxy)
  3. Waits for it to be ready
  4. Starts the FastAPI web console
  5. Checks auth, opens browser if needed

Usage:
  python main.py                  # start everything
  python main.py --no-open        # don't auto-open browser
  python main.py --web-only       # skip Bun proxy (already running)
"""

import os
import sys
import signal
import asyncio
import subprocess
import shutil
import getpass
from pathlib import Path
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ─── Config ───

PROXY_PORT = int(os.environ.get("PROXY_PORT", "3456"))
PROXY_URL = os.environ.get("PROXY_URL", f"http://localhost:{PROXY_PORT}")
WEB_PORT = int(os.environ.get("WEB_PORT", "19880"))
AUTO_OPEN = "--no-open" not in sys.argv
WEB_ONLY = "--web-only" in sys.argv
PROJECT_ROOT = Path(__file__).parent.parent
BASE_DIR = Path(__file__).parent
ADMIN_KEY_FILE = Path.home() / ".codex-proxy" / "admin.key"

# ─── Admin Key Management ───

admin_key: str = ""


def load_admin_key() -> str:
    """Load admin key from environment, file, or prompt user."""
    global admin_key

    # 1. From environment (set by CLI parent process)
    env_key = os.environ.get("CODEX_PROXY_ADMIN_KEY", "").strip()
    if env_key:
        admin_key = env_key
        return env_key

    # 2. From file
    if ADMIN_KEY_FILE.exists():
        key = ADMIN_KEY_FILE.read_text().strip()
        if key:
            admin_key = key
            return key

    # 3. Prompt (standalone mode only)
    print()
    print("  ================================================")
    print("  Admin key not configured.")
    print("  This key protects all API access to the proxy.")
    print("  ================================================")
    print()

    while True:
        key = getpass.getpass("  Enter admin key (min 8 chars): ").strip()
        if len(key) < 8:
            print("  [!!] Key must be at least 8 characters.")
            continue
        confirm = getpass.getpass("  Confirm admin key: ").strip()
        if key != confirm:
            print("  [!!] Keys do not match. Try again.")
            continue
        break

    # Save with restrictive permissions
    ADMIN_KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    ADMIN_KEY_FILE.write_text(key)
    try:
        ADMIN_KEY_FILE.chmod(0o600)
        ADMIN_KEY_FILE.parent.chmod(0o700)
    except OSError:
        pass  # Windows doesn't support Unix permissions

    admin_key = key
    print("  [ok] Admin key saved.")
    print()
    return key


# ─── Bun Proxy Process Management ───

proxy_process: subprocess.Popen | None = None


def start_proxy() -> subprocess.Popen:
    """Start the Bun proxy as a child process."""
    env = {
        **os.environ,
        "PORT": str(PROXY_PORT),
        "WEB_PORT": str(WEB_PORT),
    }
    proc = subprocess.Popen(
        ["bun", "run", "src/index.ts"],
        cwd=str(PROJECT_ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return proc


def stop_proxy():
    """Gracefully stop the Bun proxy."""
    global proxy_process
    if proxy_process and proxy_process.poll() is None:
        proxy_process.terminate()
        try:
            proxy_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proxy_process.kill()
        proxy_process = None


async def wait_for_proxy(timeout: float = 10) -> bool:
    """Poll until proxy is responding."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        try:
            async with httpx.AsyncClient() as client:
                r = await client.get(f"{PROXY_URL}/", timeout=2)
                if r.status_code == 200:
                    return True
        except (httpx.ConnectError, httpx.ReadError):
            pass
        await asyncio.sleep(0.3)
    return False


# ─── Persistent Proxy Client ───

_http_client: httpx.AsyncClient | None = None


def _auth_headers() -> dict[str, str]:
    """Headers to authenticate with the Bun proxy."""
    return {"x-admin-key": admin_key}


async def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            base_url=PROXY_URL,
            headers=_auth_headers(),
            timeout=10,
        )
    return _http_client


async def close_http_client():
    global _http_client
    if _http_client and not _http_client.is_closed:
        await _http_client.aclose()
        _http_client = None


async def proxy_get(path: str) -> dict | None:
    client = await get_http_client()
    try:
        r = await client.get(path, timeout=5)
        return r.json() if r.status_code == 200 else None
    except (httpx.ConnectError, httpx.ReadError):
        return None


async def proxy_post(path: str, json: dict | None = None) -> dict | None:
    client = await get_http_client()
    try:
        r = await client.post(path, json=json, timeout=10)
        return r.json()
    except (httpx.ConnectError, httpx.ReadError):
        return None


async def proxy_delete(path: str) -> dict | None:
    client = await get_http_client()
    try:
        r = await client.delete(path, timeout=5)
        return r.json()
    except (httpx.ConnectError, httpx.ReadError):
        return None


# ─── Headless Detection ───

def is_headless() -> bool:
    """Detect if running in a headless environment."""
    if sys.platform == "win32":
        return False
    if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        return False
    if shutil.which("xdg-open") and os.environ.get("XDG_CURRENT_DESKTOP"):
        return False
    return True


def try_open_browser(url: str):
    """Open browser if possible, otherwise just print the URL."""
    print(f"  ================================================")
    print(f"  Open: {url}")
    print(f"  ================================================")
    if not is_headless():
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception:
            pass


# ─── App Lifespan ───

@asynccontextmanager
async def lifespan(app: FastAPI):
    global proxy_process

    # 1. Start proxy
    if not WEB_ONLY:
        print(f"  [..] Starting proxy backend on :{PROXY_PORT}...")
        proxy_process = start_proxy()

        if await wait_for_proxy():
            print(f"  [ok] Proxy backend ready")
        else:
            print(f"  [!!] Proxy failed to start. Check bun installation.")
            stop_proxy()
    else:
        print(f"  [--] Web-only mode, proxy expected at {PROXY_URL}")

    # 2. Check auth
    status = await proxy_get("/auth/status")
    if status is None:
        print(f"  [!!] Cannot reach proxy at {PROXY_URL}")
    elif not status.get("authenticated") or status.get("expired"):
        print(f"  [!!] Not authenticated")
        if AUTO_OPEN:
            try_open_browser(f"http://localhost:{WEB_PORT}/auth")
    else:
        print(f"  [ok] Authenticated (account: {status.get('accountId', 'N/A')})")
        if AUTO_OPEN:
            try_open_browser(f"http://localhost:{WEB_PORT}")

    print()

    try:
        yield
    finally:
        await close_http_client()
        stop_proxy()


# ─── FastAPI App ───

app = FastAPI(title="Codex Proxy Console", lifespan=lifespan)

static_dir = BASE_DIR / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

templates = Jinja2Templates(directory=BASE_DIR / "templates")


# ─── Pages ───

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    status = await proxy_get("/auth/status")
    sessions = await proxy_get("/sessions") or []
    return templates.TemplateResponse("index.html", {
        "request": request,
        "status": status,
        "sessions": sessions if isinstance(sessions, list) else [],
    })


@app.get("/auth", response_class=HTMLResponse)
async def auth_page(request: Request):
    status = await proxy_get("/auth/status")
    return templates.TemplateResponse("auth.html", {
        "request": request,
        "status": status,
    })


@app.post("/auth/browser")
async def auth_browser():
    result = await proxy_post("/auth/login")
    if result and result.get("url"):
        return JSONResponse({"status": "ok", "url": result["url"]})
    return JSONResponse({"status": "error", "detail": result}, status_code=400)


@app.post("/auth/headless")
async def auth_headless():
    result = await proxy_post("/auth/headless")
    if result and result.get("authUrl"):
        return JSONResponse({
            "status": "ok",
            "authUrl": result["authUrl"],
            "redirectUri": result["redirectUri"],
        })
    return JSONResponse({"status": "error", "detail": result}, status_code=400)


@app.post("/auth/headless/callback")
async def auth_headless_callback(request: Request):
    body = await request.json()
    result = await proxy_post("/auth/headless/callback", json=body)
    return JSONResponse(result or {"error": "proxy unreachable"})


@app.post("/auth/device")
async def auth_device():
    result = await proxy_post("/auth/device")
    if result and result.get("code"):
        return JSONResponse({
            "status": "ok",
            "url": result["url"],
            "code": result["code"],
        })
    return JSONResponse({"status": "error", "detail": result}, status_code=400)


@app.get("/auth/status")
async def auth_status():
    status = await proxy_get("/auth/status")
    return JSONResponse(status or {"authenticated": False, "proxy_error": True})


@app.post("/auth/logout")
async def auth_logout():
    result = await proxy_delete("/auth/logout")
    return JSONResponse(result or {"error": "proxy unreachable"})


@app.websocket("/ws/auth-poll")
async def auth_poll_ws(websocket: WebSocket):
    """WebSocket that polls auth status until authenticated."""
    await websocket.accept()
    try:
        max_polls = 180  # 6 minutes max (180 * 2s)
        for _ in range(max_polls):
            status = await proxy_get("/auth/status")
            if status and status.get("authenticated") and not status.get("expired"):
                await websocket.send_json({"authenticated": True})
                break
            await websocket.send_json({"authenticated": False})
            await asyncio.sleep(2)
        else:
            await websocket.send_json({"authenticated": False, "timeout": True})
    except WebSocketDisconnect:
        pass


# ─── Session Management ───

@app.post("/sessions/create")
async def session_create(request: Request):
    body = await request.json()
    result = await proxy_post("/sessions", json=body)
    return JSONResponse(result or {"error": "proxy unreachable"})


@app.get("/sessions/{session_id}", response_class=HTMLResponse)
async def session_detail(request: Request, session_id: str):
    # Auth guard: redirect to /auth if not authenticated
    status = await proxy_get("/auth/status")
    if not status or not status.get("authenticated") or status.get("expired"):
        return RedirectResponse("/auth")

    client = await get_http_client()
    try:
        r = await client.get(f"/sessions/{session_id}", timeout=5)
        session_data = r.json() if r.status_code == 200 else None
    except (httpx.ConnectError, httpx.ReadError):
        session_data = None

    if not session_data:
        return RedirectResponse("/")
    return templates.TemplateResponse("session.html", {
        "request": request,
        "session": session_data,
    })


@app.post("/sessions/{session_id}/chat")
async def session_chat(request: Request, session_id: str):
    """Proxy chat requests to Bun backend."""
    body = await request.json()
    client = await get_http_client()
    try:
        r = await client.post(
            f"/sessions/{session_id}/chat",
            json=body,
            timeout=120,  # LLM calls can be slow
        )
        return JSONResponse(r.json(), status_code=r.status_code)
    except (httpx.ConnectError, httpx.ReadError):
        return JSONResponse({"error": "proxy unreachable"}, status_code=502)


@app.delete("/sessions/{session_id}")
async def session_delete(session_id: str):
    result = await proxy_delete(f"/sessions/{session_id}")
    return JSONResponse(result or {"error": "proxy unreachable"})


# ─── Entry Point ───

def main():
    import uvicorn

    # 0. Admin key check (blocks until key is set)
    load_admin_key()

    print()
    print("  Codex Proxy")
    print("  ===========")
    print(f"  Web console:  http://localhost:{WEB_PORT}")
    print(f"  Proxy API:    {PROXY_URL}")
    print()

    # Handle Ctrl+C gracefully
    def on_signal(sig, frame):
        print("\n  Shutting down...")
        stop_proxy()
        sys.exit(0)

    signal.signal(signal.SIGINT, on_signal)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, on_signal)

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=WEB_PORT,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
