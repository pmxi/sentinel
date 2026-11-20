"""Compare the real TS and Rust HTTP servers on the same reset fixture database."""

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
RUST = ROOT / "sent-rs"
DATABASE = os.environ.get("SENT_TEST_DATABASE_URL", "")
URL = urllib.parse.urlparse(DATABASE)
if URL.hostname not in ("localhost", "127.0.0.1", "::1") or not URL.path.startswith("/sent_test_"):
    raise SystemExit("Set SENT_TEST_DATABASE_URL to a LOCAL database named sent_test_*")

SECRET = "sent-parity-local-session-secret-not-for-production"
PASSWORD = "sent-parity-fixture-password"
PASSWORD_HASH = subprocess.check_output(["node", "--input-type=module", "-e", "import argon2 from 'argon2'; console.log(await argon2.hash(process.argv[1]))", PASSWORD], cwd=ROOT, text=True).strip()


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


payload = {"iss": "sent", "sub": "owner", "role": "owner", "iat": int(time.time()), "exp": int(time.time()) + 3600}
token = b64(b'{"alg":"HS256"}') + "." + b64(json.dumps(payload).encode())
token += "." + b64(hmac.new(SECRET.encode(), token.encode(), hashlib.sha256).digest())
ENV = {**os.environ, "DATABASE_URL": DATABASE, "SENT_FAKE_PROVIDERS": "true", "SESSION_SECRET": SECRET,
       "SENT_PASSWORD_HASH": PASSWORD_HASH, "OPENAI_API_KEY": "", "HOST": "127.0.0.1",
       "SENT_PUBLIC_URL": "http://localhost:3197", "SENT_WEB_URL": "", "WEB_DIST_PATH": str(RUST / "missing-web-dist")}
LOGS = RUST / "parity-logs"
LOGS.mkdir(exist_ok=True)


def request(port, path, method="GET", body=None, authenticated=True, protected=True):
    headers = {}
    if authenticated:
        headers["Authorization"] = "Bearer " + token
    if protected:
        headers["x-sent-request"] = "1"
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method, headers=headers,
                                 data=None if body is None else json.dumps(body).encode())
    try:
        response = urllib.request.urlopen(req, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read()
    return response.status, json.loads(raw)


def snapshot(port):
    records = {}

    def check(name, path, method="GET", body=None, **kwargs):
        status, result = request(port, path, method, body, **kwargs)
        records[name] = {"status": status, "body": result}
        return result

    check("health", "/api/health", authenticated=False)
    accounts = check("accounts", "/api/accounts")["accounts"]
    check("unauthorized", "/api/messages", authenticated=False)
    check("unknown-unauthorized", "/api/not-a-route", authenticated=False)
    check("unknown-authorized", "/api/not-a-route")
    check("request-protection", "/api/auth/logout", "POST", protected=False)
    for view in ["l1", "l2", "l3", "unclassified", "all", "sent", "trash"]:
        cursor = None
        page = 0
        while True:
            query = {"view": view, "limit": 47}
            if cursor:
                query["cursor"] = cursor
            value = check(f"messages-{view}-{page}", "/api/messages?" + urllib.parse.urlencode(query))
            cursor = value["nextCursor"]
            page += 1
            if not cursor:
                break
        check(f"account-filter-{view}", "/api/messages?" + urllib.parse.urlencode({"view": view, "accountId": accounts[0]["id"], "limit": 13}))
    all_messages = check("sample-all", "/api/messages?view=all&limit=100")["messages"]
    for i, message in enumerate(all_messages[:6]):
        check(f"detail-{i}", "/api/messages/" + message["id"])
        for trash in ("false", "true"):
            check(f"thread-{i}-{trash}", f'/api/threads/{message["threadId"]}?trash={trash}')
    for query in ["project", "newsletter", "notpresentanywhere", "Friday"]:
        check("search-" + query, "/api/search?" + urllib.parse.urlencode({"q": query, "limit": 37}))
    check("drafts-empty", "/api/drafts")
    selected = all_messages[0]["id"]
    for action in ("archive", "delete"):
        receipt = check("action-" + action, f"/api/messages/{selected}/action", "POST", {"action": action, "undoable": True})
        check("pending-" + action, "/api/messages/" + selected)
        check("undo-" + action, f'/api/mutations/{receipt["mutationId"]}/undo', "POST")
        check("restored-" + action, "/api/messages/" + selected)
        check("undo-again-" + action, f'/api/mutations/{receipt["mutationId"]}/undo', "POST")
    for tier in (3, None):
        check("tier-" + str(tier), f"/api/messages/{selected}/tier", "PUT", {"tier": tier})
        check("tier-detail-" + str(tier), "/api/messages/" + selected)
    source = {"accountId": accounts[0]["id"], "to": [{"name": "Recipient", "address": "recipient@example.test"}], "subject": "Parity draft", "body": "Initial body"}
    created = check("draft-create", "/api/drafts", "POST", source)
    draft_id = created["id"]
    check("draft-get", "/api/drafts/" + draft_id)
    source["body"] = "Updated body"
    check("draft-update", "/api/drafts/" + draft_id, "PUT", source)
    check("drafts-populated", "/api/drafts")
    check("draft-delete", "/api/drafts/" + draft_id, "DELETE")
    check("draft-get-missing", "/api/drafts/" + draft_id)
    check("drafts-final", "/api/drafts")
    for index, path in enumerate(["/api/messages/not-a-uuid", "/api/threads/bad", "/api/drafts/bad", "/api/messages?view=bad", "/api/messages?limit=0", "/api/messages?limit=101", "/api/messages?limit=no", "/api/messages?limit=1.5", "/api/search?q=", "/api/search?q=ok&tier=3", "/api/search?q=ok&after=bad", "/api/oauth/other/start"]):
        check(f"invalid-query-path-{index}", path)
    for index, body in enumerate([{}, {"tier": 4}, {"tier": "2"}]):
        check(f"invalid-tier-{index}", f"/api/messages/{selected}/tier", "PUT", body)
    for index, body in enumerate([{}, {"action": "bad"}, {"action": "archive", "undoable": "yes"}]):
        check(f"invalid-action-{index}", f"/api/messages/{selected}/action", "POST", body)
    for index, body in enumerate([{}, {"accountId": "bad"}, {"accountId": accounts[0]["id"], "to": [{"address": "bad"}]}, {"accountId": accounts[0]["id"], "subject": "x" * 999}]):
        check(f"invalid-draft-{index}", "/api/drafts", "POST", body)
    check("login-unicode", "/api/auth/login", "POST", {"password": "é" * 600}, authenticated=False)
    check("login-success", "/api/auth/login", "POST", {"password": PASSWORD}, authenticated=False)
    for attempt in range(8):
        check(f"login-wrong-{attempt}", "/api/auth/login", "POST", {"password": "wrong"}, authenticated=False)

    def normalize(value, key=""):
        if key in ("mutationId", "undoUntil", "createdAt", "updatedAt"):
            # Generated IDs and request-time dates are intentionally nondeterministic.
            return "<generated>" if value is not None else None
        if value == draft_id:
            return "<draft-id>"
        if isinstance(value, dict):
            return {k: normalize(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [normalize(v) for v in value]
        return value

    return normalize(records)


def run_side(name, command, port):
    subprocess.run([str(RUST / "target/release/sent-seed"), "--reset"], cwd=ROOT, env=ENV, check=True)
    with (LOGS / (name + ".log")).open("w") as log:
        process = subprocess.Popen(command, cwd=ROOT, env={**ENV, "PORT": str(port)}, stdout=log, stderr=log, start_new_session=True)
        try:
            for _ in range(200):
                if process.poll() is not None:
                    raise RuntimeError(f"{name} exited; see {log.name}")
                try:
                    request(port, "/api/health", authenticated=False)
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError(f"{name} did not become ready; see {log.name}")
            result = snapshot(port)
            (LOGS / (name + ".json")).write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
            return result
        finally:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


ts = run_side("typescript", ["pnpm", "exec", "tsx", "apps/server/src/index.ts"], 3197)
rust = run_side("rust", [str(RUST / "target/release/sent-server")], 3198)
diffs = [name for name in ts.keys() | rust.keys() if ts.get(name) != rust.get(name)]
for name in diffs:
    print("DIFF:", name)
print(f"Parity: {len(ts)} cases, {len(diffs)} diffs (snapshots: {LOGS})")
raise SystemExit(bool(diffs))
