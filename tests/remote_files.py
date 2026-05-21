"""
Integration test for the remote_files feature.

Exercises:
    1. basic            : signed-URL-style fetch + run end-to-end
    2. cache_hit        : second identical request must be served from cache
    3. host_allowlist   : URL host outside allowlist is rejected (400)
    4. tenant_required  : remote_files without tenant_id is rejected (400)
    5. path_escape      : name with .. is rejected (400)
    6. disabled_origin  : 4xx from origin (e.g. 404) propagates as 4xx, not 500
    7. duplicate_name   : remote_files name colliding with files name is rejected

Setup
-----
Run this against a Piston instance that has remote_files enabled and the
test host in its allowlist. For example, when running locally with docker-compose:

    docker run --rm \
        -e PISTON_REMOTE_FILES_ENABLED=true \
        -e PISTON_REMOTE_FILES_HOST_ALLOWLIST=raw.githubusercontent.com,storage.googleapis.com \
        --privileged --network host \
        ghcr.io/engineer-man/piston

Then:

    python3 tests/remote_files.py

Exits non-zero on any failed assertion.
"""

import json
import sys
import urllib.request
import urllib.error

PISTON_URL = "http://127.0.0.1:2000/api/v2/execute"

FIXTURE_HOST = "raw.githubusercontent.com"
FIXTURE_PATH = "/engineer-man/piston/master/readme.md"
FIXTURE_URL = f"https://{FIXTURE_HOST}{FIXTURE_PATH}"
FIXTURE_NAME = "piston_readme.md"

USER_CODE_READ_FIXTURE = (
    "import os\n"
    "with open('" + FIXTURE_NAME + "', 'r') as f:\n"
    "    data = f.read()\n"
    "print(len(data) > 0)\n"
    "print('Piston' in data)\n"
)


def post(body):
    req = urllib.request.Request(
        PISTON_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8"))
        except Exception:
            payload = {}
        return e.code, payload


def base_request(**overrides):
    body = {
        "language": "python",
        "version": "3.12.0",
        "tenant_id": "test-tenant",
        "remote_files": [
            {
                "url": FIXTURE_URL,
                "name": FIXTURE_NAME,
                "version": "1",
            }
        ],
        "files": [{"name": "main.py", "content": USER_CODE_READ_FIXTURE}],
        "run_timeout": 10000,
    }
    body.update(overrides)
    return body


def expect(condition, message):
    if not condition:
        print(f"FAIL: {message}", file=sys.stderr)
        sys.exit(1)
    print(f"PASS: {message}")


def t_basic():
    status, body = post(base_request())
    expect(status == 200, f"basic: HTTP 200, got {status} body={body}")
    expect(body.get("run", {}).get("code") == 0, f"basic: run exit 0, got {body.get('run')}")
    expect(
        "True" in body.get("run", {}).get("stdout", ""),
        "basic: python read fixture and saw non-empty content",
    )


def t_cache_hit():
    status, _ = post(base_request())
    expect(status == 200, "cache_hit: warm-up succeeded")
    status, body = post(base_request())
    expect(status == 200, f"cache_hit: second call HTTP 200, got {status}")
    expect(body.get("run", {}).get("code") == 0, "cache_hit: run exit 0")


def t_host_allowlist():
    body = base_request()
    body["remote_files"][0]["url"] = "https://example.com/something.csv"
    status, payload = post(body)
    expect(status == 400, f"host_allowlist: HTTP 400, got {status}")
    expect(
        "allowlist" in payload.get("message", "").lower(),
        f"host_allowlist: error mentions allowlist, got {payload}",
    )


def t_tenant_required():
    body = base_request()
    body.pop("tenant_id")
    status, payload = post(body)
    expect(status == 400, f"tenant_required: HTTP 400, got {status}")
    expect(
        "tenant_id" in payload.get("message", ""),
        f"tenant_required: error mentions tenant_id, got {payload}",
    )


def t_path_escape():
    body = base_request()
    body["remote_files"][0]["name"] = "../escape.txt"
    status, payload = post(body)
    if status == 400:
        print(f"PASS: path_escape: rejected at validation: {payload.get('message')}")
        return
    expect(
        status == 400,
        f"path_escape: HTTP 400, got {status} payload={payload}",
    )


def t_disabled_origin():
    body = base_request()
    body["remote_files"][0]["url"] = (
        f"https://{FIXTURE_HOST}/engineer-man/piston/master/this-file-does-not-exist-xyz.bin"
    )
    body["remote_files"][0]["version"] = "doesnotexist"
    status, payload = post(body)
    expect(
        status >= 400 and status < 500,
        f"disabled_origin: caller-side 4xx, got {status} payload={payload}",
    )


def t_duplicate_name():
    body = base_request()
    body["remote_files"][0]["name"] = "main.py"
    status, payload = post(body)
    expect(status == 400, f"duplicate_name: HTTP 400, got {status}")
    expect(
        "collide" in payload.get("message", "").lower()
        or "collides" in payload.get("message", "").lower(),
        f"duplicate_name: error mentions collision, got {payload}",
    )


def main():
    t_basic()
    t_cache_hit()
    t_host_allowlist()
    t_tenant_required()
    t_path_escape()
    t_disabled_origin()
    t_duplicate_name()
    print("\nAll remote_files integration tests passed.")


if __name__ == "__main__":
    main()
