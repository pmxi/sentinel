"""Local-only seeded Rust server/worker smoke check. Requires release binaries."""

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
RUST = ROOT
DIRECTORY = tempfile.TemporaryDirectory(prefix="sent-worker-smoke-")
DATABASE = str(Path(DIRECTORY.name) / "sent.sqlite")
SECRET = "sent-worker-smoke-local-session-secret-only"
ENV = {**os.environ, "SENT_DATABASE_PATH": DATABASE, "SENT_FAKE_PROVIDERS": "true", "OPENAI_API_KEY": "",
       "SESSION_SECRET": SECRET, "SENT_PASSWORD_HASH": "unused-with-test-bearer", "HOST": "127.0.0.1", "PORT": "3199"}
LOGS = RUST / "parity-logs"
LOGS.mkdir(exist_ok=True)


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


token = b64(b'{"alg":"HS256"}') + "." + b64(json.dumps({"iss": "sent", "sub": "owner", "role": "owner", "iat": int(time.time()), "exp": int(time.time()) + 3600}).encode())
token += "." + b64(hmac.new(SECRET.encode(), token.encode(), hashlib.sha256).digest())


def request(path, method="GET", body=None):
    headers = {"Authorization": "Bearer " + token, "x-sent-request": "1"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request("http://127.0.0.1:3199" + path, method=method, headers=headers,
                                 data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)


def sql(query, args=None):
    with sqlite3.connect(DATABASE) as connection:
        connection.row_factory = sqlite3.Row
        return [dict(row) for row in connection.execute(query, args or [])]


def until(check, seconds=45):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except OSError:
            pass
        time.sleep(0.3)
    raise AssertionError("Timed out waiting for worker state")


subprocess.run([str(RUST / "target/release/sent-seed"), "--reset"], cwd=ROOT, env=ENV, check=True)
processes = []
handles = []
try:
    for binary in ("sent-server", "sent-worker"):
        handle = (LOGS / (binary + "-smoke.log")).open("w")
        handles.append(handle)
        processes.append(subprocess.Popen([str(RUST / "target/release" / binary)], cwd=ROOT, env=ENV, stdout=handle, stderr=handle))
    health = until(lambda: (value if (value := request("/api/health"))["status"] == "ok" and value["sync"]["fresh"] else None))
    age = time.time() - __import__("datetime").datetime.fromisoformat(health["workerHeartbeat"].replace("Z", "+00:00")).timestamp()
    assert age < 35
    print("HEALTH", json.dumps(health, sort_keys=True))
    selected = request("/api/messages?view=l1&limit=100")["messages"][0]
    receipt = request(f'/api/messages/{selected["id"]}/action', "POST", {"action": "archive", "undoable": True})
    until(lambda: sql("select status from mutation_outbox where id=$1", [receipt["mutationId"]])[0]["status"] == "complete")
    row = sql("select o.status, m.archived, json_extract(o.payload,'$.undoUntil') < strftime('%Y-%m-%dT%H:%M:%f000Z','now') as undo_elapsed from mutation_outbox o join messages m on m.id=o.message_id where o.id=$1", [receipt["mutationId"]])[0]
    assert row == {"status": "complete", "archived": True, "undo_elapsed": True}
    page = request("/api/messages?view=l1&limit=100")
    while True:
        assert all(message["id"] != selected["id"] for message in page["messages"])
        if not page["nextCursor"]:
            break
        page = request("/api/messages?view=l1&limit=100&cursor=" + urllib.parse.quote(page["nextCursor"]))
    print("ARCHIVE", json.dumps({**row, "absentFromL1": True}, sort_keys=True))
    draft = request("/api/drafts", "POST", {"accountId": selected["account"]["id"], "to": [{"name": "Recipient", "address": "recipient@example.test"}], "subject": "Rust worker smoke send", "body": "Local fixture delivery only."})
    sent = request(f'/api/drafts/{draft["id"]}/send?undoable=true', "POST")
    until(lambda: sql("select status from mutation_outbox where id=$1", [sent["mutationId"]])[0]["status"] == "complete")
    messages = request("/api/messages?view=sent&limit=100")["messages"]
    delivered = next(message for message in messages if message["subject"] == draft["subject"])
    assert delivered["direction"] == "outbound" and not delivered["syncPending"]
    print("SEND", json.dumps({"status": "complete", "inSentView": True, "direction": delivered["direction"], "syncPending": delivered["syncPending"]}, sort_keys=True))
    health = request("/api/health")
    assert health["status"] == "ok" and health["sync"]["fresh"]
    print("HEALTH_FINAL", json.dumps(health, sort_keys=True))
finally:
    for index, process in enumerate(processes):
        process.send_signal(signal.SIGTERM if index else signal.SIGINT)
    for process in processes:
        try:
            process.wait(timeout=35)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    for handle in handles:
        handle.close()
assert all(process.returncode == 0 for process in processes), [p.returncode for p in processes]
print("SHUTDOWN worker SIGTERM and server SIGINT exited cleanly")
