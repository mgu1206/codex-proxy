"""
Codex Proxy - CLI Authentication (headless)

Pure terminal auth flow, no browser needed on the server.

Usage:
  python web/auth_cli.py                     # auto-detect proxy
  python web/auth_cli.py --proxy-url http://host:3456
  python web/auth_cli.py --device            # skip to device code flow
"""

import os
import sys
import getpass
from pathlib import Path

import httpx

PROXY_URL = os.environ.get("PROXY_URL", "http://localhost:3456")
ADMIN_KEY_FILE = Path.home() / ".codex-proxy" / "admin.key"
DEVICE_ONLY = "--device" in sys.argv

# Parse args
for i, arg in enumerate(sys.argv[1:], 1):
    if arg == "--proxy-url" and i < len(sys.argv) - 1:
        PROXY_URL = sys.argv[i + 1]


def load_admin_key() -> str:
    """Load admin key from file or prompt."""
    if ADMIN_KEY_FILE.exists():
        key = ADMIN_KEY_FILE.read_text().strip()
        if key:
            return key

    print("  [!!] Admin key not found.")
    print("       Run 'python web/main.py' first to configure the admin key,")
    print("       or enter it now.")
    print()
    key = getpass.getpass("  Admin key: ").strip()
    if not key:
        print("  [!!] No key provided.")
        sys.exit(1)
    return key


def main():
    admin_key = load_admin_key()
    client = httpx.Client(
        base_url=PROXY_URL,
        timeout=10,
        headers={"x-admin-key": admin_key},
    )

    print()
    print("  Codex Proxy - CLI Authentication")
    print("  =================================")
    print(f"  Proxy: {PROXY_URL}")
    print()

    # Check status
    try:
        r = client.get("/auth/status")
        status = r.json()
    except httpx.ConnectError:
        print("  [!!] Cannot reach proxy. Start it first:")
        print("       bun run start")
        sys.exit(1)

    if status.get("error"):
        print(f"  [!!] Auth error: {status['error']}")
        sys.exit(1)

    if status.get("authenticated") and not status.get("expired"):
        print(f"  [ok] Already authenticated (account: {status.get('accountId', 'N/A')})")
        print()
        choice = input("  Re-authenticate? (y/N): ").strip().lower()
        if choice != "y":
            return

    if DEVICE_ONLY:
        device_auth(client)
        return

    # Choose method
    print("  Authentication methods:")
    print("    1) Device Code     - enter a code on any device (recommended)")
    print("    2) Headless OAuth  - open link, paste redirect URL back")
    print()
    choice = input("  Choose method (1/2): ").strip()

    if choice == "2":
        headless_auth(client)
    else:
        device_auth(client)


def headless_auth(client: httpx.Client):
    print()
    print("  [..] Starting headless OAuth...")

    r = client.post("/auth/headless")
    data = r.json()

    if not data.get("authUrl"):
        print(f"  [!!] Error: {data}")
        sys.exit(1)

    print()
    print("  Step 1: Open this URL in any browser:")
    print()
    print(f"  {data['authUrl']}")
    print()
    print("  Step 2: Sign in to your ChatGPT account.")
    print()
    print("  Step 3: After sign-in, the browser will try to redirect to")
    print(f"          {data['redirectUri']}...")
    print("          This will show an error page -- THIS IS EXPECTED.")
    print()
    print("  Step 4: Copy the FULL URL from your browser's address bar")
    print("          (it looks like: http://localhost:1455/auth/callback?code=...&state=...)")
    print()

    while True:
        callback_url = input("  Paste the callback URL here: ").strip()
        if not callback_url:
            continue

        r = client.post("/auth/headless/callback", json={"url": callback_url})
        result = r.json()

        if result.get("status") == "authenticated" or result.get("accountId"):
            print()
            print(f"  [ok] Authenticated! (account: {result.get('accountId', 'N/A')})")
            print()
            break
        else:
            print(f"  [!!] Error: {result.get('error', 'Unknown error')}")
            print("  Try again or Ctrl+C to cancel.")
            print()


def device_auth(client: httpx.Client):
    print()
    print("  [..] Starting device code auth...")

    r = client.post("/auth/device")
    data = r.json()

    if not data.get("code"):
        print(f"  [!!] Error: {data}")
        sys.exit(1)

    print()
    print(f"  Visit:  {data['url']}")
    print(f"  Code:   {data['code']}")
    print()
    print("  Waiting for authorization", end="", flush=True)

    import time
    max_attempts = 90  # ~4.5 minutes at 3s intervals
    for _ in range(max_attempts):
        time.sleep(3)
        print(".", end="", flush=True)

        r = client.get("/auth/status")
        status = r.json()
        if status.get("authenticated") and not status.get("expired"):
            print()
            print()
            print(f"  [ok] Authenticated! (account: {status.get('accountId', 'N/A')})")
            print()
            return

    print()
    print()
    print("  [!!] Timed out waiting for authorization. Try again.")
    sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n  Cancelled.")
        sys.exit(0)
