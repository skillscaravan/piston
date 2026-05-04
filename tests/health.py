"""
Integration test for the /healthz and /readyz operational endpoints.

Exercises:
    1. /healthz responds 200 with the expected shape.
    2. /readyz responds 200 with ready=true once startup is complete.
    3. /readyz check structure includes runtimes_loaded, remote_files, not_shutting_down.
    4. unknown paths still return 404 (sanity that route ordering didn't break).

Run against a Piston instance that has finished starting up:

    python3 tests/health.py

Exits non-zero on any failed assertion.
"""

import json
import sys
import urllib.request
import urllib.error

BASE_URL = "http://127.0.0.1:2000"


def get(path):
    req = urllib.request.Request(f"{BASE_URL}{path}", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8"))
        except Exception:
            payload = {}
        return e.code, payload


def expect(condition, message):
    if not condition:
        print(f"FAIL: {message}", file=sys.stderr)
        sys.exit(1)
    print(f"PASS: {message}")


def t_healthz():
    status, body = get("/healthz")
    expect(status == 200, f"/healthz returns 200, got {status}")
    expect(body.get("status") == "ok", f"/healthz status='ok', got {body}")
    expect(isinstance(body.get("uptime_ms"), int), f"/healthz uptime_ms is int, got {body}")
    expect(isinstance(body.get("pid"), int), f"/healthz pid is int, got {body}")


def t_readyz_ready():
    status, body = get("/readyz")
    expect(status == 200, f"/readyz returns 200 once started, got {status} body={body}")
    expect(body.get("ready") is True, f"/readyz ready=true, got {body}")
    expect(body.get("status") == "ready", f"/readyz status='ready', got {body}")


def t_readyz_check_shape():
    _, body = get("/readyz")
    checks = body.get("checks", {})
    for key in ("runtimes_loaded", "remote_files", "not_shutting_down"):
        expect(
            key in checks,
            f"/readyz checks contains '{key}', got {checks}",
        )
        expect(
            isinstance(checks[key], bool),
            f"/readyz checks.{key} is bool, got {type(checks[key]).__name__}",
        )


def t_unknown_path_404():
    status, body = get("/this-path-does-not-exist-xyz")
    expect(status == 404, f"unknown path returns 404, got {status}")
    expect(
        "Not Found" in body.get("message", ""),
        f"unknown path message mentions Not Found, got {body}",
    )


def main():
    t_healthz()
    t_readyz_ready()
    t_readyz_check_shape()
    t_unknown_path_404()
    print("\nAll health endpoint tests passed.")


if __name__ == "__main__":
    main()
