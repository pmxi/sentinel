#!/usr/bin/env python3
"""Isolated deployment integration tests; no production services or credentials."""
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time


SOURCE = Path(__file__).resolve().parent / "deploy.sh"


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def main():
    with tempfile.TemporaryDirectory(prefix="sent-deploy-", dir=Path.home()) as directory:
        base = Path(directory)
        root = base / "sent"
        legacy = base / "legacy"
        legacy.mkdir()
        tools = base / "tools" / "bin"
        tools.mkdir(parents=True)
        env_file = base / "shared.env"
        env_file.write_text("DATABASE_URL=postgres://fake/test\n")
        work = base / "work"
        work.mkdir()
        run("git", "init", "-b", "master", str(work))
        run("git", "-C", str(work), "config", "user.email", "test@example.com")
        run("git", "-C", str(work), "config", "user.name", "Test")
        (work / "deploy").mkdir()
        shutil.copy(SOURCE, work / "deploy" / "deploy.sh")
        calls = base / "calls"
        for name, body in {
            "pnpm": 'printf "pnpm %s\\n" "$*" >> "$TEST_CALLS"\n',
            "pg_dump": 'printf "dump\\n" >> "$TEST_CALLS"\nfor arg; do case "$arg" in --file=*) printf fake > "${arg#--file=}";; esac; done\n',
            "systemctl": 'printf "systemctl %s\\n" "$*" >> "$TEST_CALLS"\n',
        }.items():
            path = tools / name
            path.write_text("#!/usr/bin/env bash\nset -eu\n" + body)
            path.chmod(0o700)
        state = {"ci": "success", "bad": None, "api": 0, "sync": False}

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.path.startswith("/ci/"):
                    state["api"] += 1
                    pending = state["ci"] == "pending"
                    data = {"total_count": 1, "check_runs": [{"name": "check", "id": 1,
                            "app": {"slug": "github-actions"},
                            "status": "in_progress" if pending else "completed",
                            "conclusion": None if pending else state["ci"]}]}
                else:
                    current = (root / "current").resolve().name
                    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() + 1)) + ".999Z"
                    data = {"status": "degraded", "database": current != state["bad"], "workerHeartbeat": stamp}
                    if state["sync"]:
                        data["sync"] = {"fresh": True, "oldestSuccessfulSyncAt": stamp}
                body = json.dumps(data).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}"
        env = dict(os.environ, SENT_DEPLOY_ROOT=str(root), SENT_DEPLOY_REPO=str(base / "repo.git"),
                   SENT_DEPLOY_ENV=str(env_file), SENT_DEPLOY_LEGACY=str(legacy),
                   SENT_DEPLOY_TOOLS=str(tools.parent), SENT_DEPLOY_HEALTH=url + "/health",
                   SENT_DEPLOY_CI_URL=url + "/ci", SENT_DEPLOY_TIMEOUT="1", SENT_DEPLOY_INTERVAL="0.1",
                   TEST_CALLS=str(calls))

        def commit():
            run("git", "-C", str(work), "add", "deploy/deploy.sh")
            run("git", "-C", str(work), "commit", "--allow-empty", "-m", "test")
            sha = run("git", "-C", str(work), "rev-parse", "HEAD")
            if (base / "repo.git").exists():
                run("git", "-C", str(work), "push", str(base / "repo.git"), "master")
            else:
                run("git", "clone", "--bare", str(work), str(base / "repo.git"))
            return sha

        def deploy(code=0, *args):
            result = subprocess.run(["bash", str(SOURCE), *args], env=env, text=True, capture_output=True)
            assert result.returncode == code, result.stdout + result.stderr
            return result.stdout

        try:
            bootstrap = commit()
            state["bad"] = bootstrap
            output = deploy(1)
            assert "Previous release healthy" in output
            assert (root / "current").resolve() == legacy
            assert (root / "releases" / "legacy-328f56f").resolve() == legacy
            assert (root / "state" / f"failed-{bootstrap}").exists()
            print("PASS first-bootstrap failure -> healthy legacy rollback")
            state["bad"] = None
            shutil.rmtree(root)
            calls.unlink()
            first = commit()
            output = deploy()
            assert (root / "current").resolve().name == first
            assert (root / "state" / "deployed").read_text().startswith(first)
            assert (root / "bin" / "deploy.sh").exists()
            assert len(list((root / "dumps").glob("*.dump"))) == 1
            assert calls.read_text().index("dump") < calls.read_text().index("db:migrate")
            print("PASS success deploy (legacy bootstrap, dump before migrate, degraded health, self-update)")
            state["sync"] = True
            second = commit()
            state["bad"] = second
            output = deploy(1)
            assert "Previous release healthy" in output
            assert (root / "current").resolve().name == first
            assert (root / "state" / f"failed-{second}").exists()
            print("PASS health failure -> rollback verified healthy, failed SHA recorded")
            api = state["api"]
            deploy()
            assert state["api"] == api
            print("PASS failed SHA -> no-op without CI request")
            third = commit()
            state["ci"] = "pending"
            before = calls.read_text()
            deploy()
            assert calls.read_text() == before
            assert (root / "current").resolve().name == first
            print("PASS CI pending -> no build or restart")
            state["ci"] = "failure"
            deploy()
            assert (root / "state" / f"skipped-{third}").exists()
            print("PASS CI failure -> skipped SHA recorded")
            fourth = commit()
            state["ci"] = "success"
            deploy()
            api = state["api"]
            before = calls.read_text()
            assert deploy() == ""
            assert state["api"] == api and calls.read_text() == before
            print("PASS already-deployed -> quiet no-op without CI request")
            deploy(0, "rollback")
            assert (root / "current").resolve().name == first
            print("PASS manual rollback")
            deploy(0, "force", fourth)
            assert (root / "current").resolve().name == fourth
            print("PASS force deploy")
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
