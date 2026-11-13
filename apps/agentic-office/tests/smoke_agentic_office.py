#!/usr/bin/env python3
"""Smoke check of the agentic-office hub after a rollout (run by hand, not part of CI).

  smoke_agentic_office.py [<https-url>] [--wait SECONDS]

Without a URL the script uses `agentic-office:publicUrl` from apps/agentic-office/Pulumi.dev.yaml,
so the address is kept in one place only.

1. TLS handshake with the public name (certificate checked against the system roots).
2. Unauthenticated POST of GetChallenge with a public key that is not registered. A hub that
   is up answers HTTP 401 with the Connect error code `unauthenticated`. Anything else (a 502
   from the tunnel or Traefik, `invalid_argument`, a body that is no Connect error) fails.

No credentials, nothing is written on the hub. Standard library only.
Retries until --wait is over, because the tunnel and the new pod need a moment after the rollout.
"""

import argparse
import base64
import http.client
import json
import os
import re
import socket
import ssl
import sys
import time
from urllib.parse import urlsplit

PATH = "/office.identity.v1.IdentityService/GetChallenge"
# 32 raw bytes: a well-formed Ed25519 public key size, but registered on no hub.
BAD_PUBLIC_KEY = base64.b64encode(bytes([1]) * 32).decode()


CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "Pulumi.dev.yaml")


def url_from_config(path: str = CONFIG) -> str | None:
    """`agentic-office:publicUrl` of the Pulumi stack config, or None. No YAML library needed."""
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        return None
    m = re.search(r"^\s*agentic-office:publicUrl:\s*['\"]?(\S+?)['\"]?\s*(?:#.*)?$", text, re.M)
    return m.group(1) if m else None


def classify(status: int, body: bytes) -> str | None:
    """None when the answer is the expected `unauthenticated`, else the reason it is not."""
    try:
        code = json.loads(body).get("code")
    except (ValueError, AttributeError):
        return f"HTTP {status}, body is no Connect error: {body[:200]!r}"
    if status == 401 and code == "unauthenticated":
        return None
    return f"HTTP {status}, Connect code {code!r}, expected 401 unauthenticated"


def attempt(host: str, port: int, timeout: float) -> str | None:
    ctx = ssl.create_default_context()
    with socket.create_connection((host, port), timeout=timeout) as raw:
        with ctx.wrap_socket(raw, server_hostname=host) as tls:
            print(f"TLS handshake ok: {tls.version()}, certificate valid for {host}")
    conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=ctx)
    try:
        conn.request(
            "POST",
            PATH,
            body=json.dumps({"publicKey": BAD_PUBLIC_KEY}),
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        return classify(resp.status, resp.read())
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url", nargs="?", help=f"default: publicUrl from {CONFIG}")
    ap.add_argument("--wait", type=int, default=300)
    args = ap.parse_args()
    url = args.url or url_from_config()
    if not url:
        print(f"no URL given and no agentic-office:publicUrl in {CONFIG}", file=sys.stderr)
        return 2
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        print(f"expected an https URL, got {url!r}", file=sys.stderr)
        return 2
    deadline = time.monotonic() + args.wait
    while True:
        try:
            problem = attempt(parts.hostname, parts.port or 443, 10)
        except (OSError, ssl.SSLError) as e:
            problem = f"{type(e).__name__}: {e}"
        if problem is None:
            print("GetChallenge with an unregistered key answered unauthenticated: hub is up")
            return 0
        print(f"not yet: {problem}")
        if time.monotonic() >= deadline:
            print("smoke check failed", file=sys.stderr)
            return 1
        time.sleep(10)


if __name__ == "__main__":
    sys.exit(main())
