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
        tools = base / "tools" / "node" / "bin"
        tools.mkdir(parents=True)
        env_file = base / "shared.env"
        env_file.write_text("DATABASE_URL=postgres://test:fake%40password@fake/test?sslmode=verify-full&sslrootcert=%2Ffake%2Froot.crt&sslcert=%2Ffake%2Fclient.crt&sslkey=%2Ffake%2Fclient.key\n")
        work = base / "work"
        work.mkdir()
        run("git", "init", "-b", "master", str(work))
        run("git", "-C", str(work), "config", "user.email", "test@example.com")
        run("git", "-C", str(work), "config", "user.name", "Test")
        (work / "deploy").mkdir()
        shutil.copy(SOURCE, work / "deploy" / "deploy.sh")
        shutil.copy(SOURCE.parent / "sent-run", work / "deploy" / "sent-run")
        (work / "deploy" / "systemd").mkdir()
        (work / "deploy" / "systemd" / "sent-server.service").write_text("[Service]\n")
        (work / "web").mkdir()
        (work / "Cargo.toml").write_text("[workspace]\n")
        (work / "migrations").mkdir()
        (work / "migrations" / "0001.sql").write_text("select 1;\n")
        units = base / "units"
        calls = base / "calls"
        for name, body in {
            "pnpm": 'printf "pnpm %s\\n" "$*" >> "$TEST_CALLS"\nif [[ "$*" == "--dir web build" ]]; then\n  [[ "$NODE_ENV" == production ]]\n  mkdir -p web/dist && printf ok > web/dist/index.html\nfi\n',
            "cargo": 'printf "cargo %s\\n" "$*" >> "$TEST_CALLS"\n[[ "$CARGO_HOME" == "$SENT_DEPLOY_TOOLS/cargo" ]]\nfor arg; do case "$arg" in */cargo-target) target=$arg;; esac; done\nmkdir -p "$target/release"\nfor bin in sent-server sent-worker; do printf "#!/bin/sh\\n" > "$target/release/$bin"; chmod 700 "$target/release/$bin"; done\n',
            "pg_dump": '[[ "$PGPASSWORD" == "fake@password" && "$PGSSLMODE" == verify-full && "$PGSSLROOTCERT" == /fake/root.crt && "$PGSSLCERT" == /fake/client.crt && "$PGSSLKEY" == /fake/client.key ]]\nprintf "dump\\n" >> "$TEST_CALLS"\nfor arg; do case "$arg" in --file=*) printf fake > "${arg#--file=}";; esac; done\n',
            "systemctl": 'printf "systemctl %s\\n" "$*" >> "$TEST_CALLS"\n',
        }.items():
            path = tools / name
            path.write_text("#!/usr/bin/env bash\nset -eu\n" + body)
            path.chmod(0o700)
        state = {"ci": "success", "bad": None, "api": 0, "sync": False, "accounts": 1, "stale": None}

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.path.startswith("/ci/"):
                    state["api"] += 1
                    pending = state["ci"] == "pending"
                    data = {"total_count": 2, "check_runs": [{"name": name, "id": 1,
                            "app": {"slug": "github-actions"},
                            "status": "in_progress" if pending and name == "web" else "completed",
                            "conclusion": None if pending and name == "web" else state["ci"]}
                            for name in ("rust", "web")]}
                else:
                    current = (root / "current").resolve().name
                    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() + 1)) + ".999Z"
                    data = {"status": "degraded", "database": current != state["bad"], "workerHeartbeat": stamp}
                    if state["sync"] and current != legacy.name:
                        sync_stamp = "2000-01-01T00:00:00Z" if current == state["stale"] else stamp
                        data["sync"] = {"fresh": True, "accounts": state["accounts"],
                                        "oldestSuccessfulSyncAt": sync_stamp if state["accounts"] else None}
                body = json.dumps(data).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}"
        inherited = {k: v for k, v in os.environ.items() if k not in ("CARGO_HOME", "RUSTUP_HOME")}
        env = dict(inherited, SENT_DEPLOY_ROOT=str(root), SENT_DEPLOY_REPO=str(base / "repo.git"),
                   SENT_DEPLOY_ENV=str(env_file), SENT_DEPLOY_LEGACY=str(legacy),
                   SENT_DEPLOY_TOOLS=str(tools.parent.parent), SENT_DEPLOY_HEALTH=url + "/health",
                   SENT_DEPLOY_CI_URL=url + "/ci", SENT_DEPLOY_TIMEOUT="1", SENT_DEPLOY_INTERVAL="0.1",
                   TEST_CALLS=str(calls), SENT_DEPLOY_UNITS=str(units))

        def commit():
            run("git", "-C", str(work), "add", ".")
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
            return result.stdout + result.stderr

        try:
            bootstrap = commit()
            state["bad"] = bootstrap
            output = deploy(1)
            assert "Previous release healthy" in output, output
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
            text = calls.read_text()
            assert text.index("cargo build --release --locked") < text.index("dump") < text.index("systemctl --user restart")
            release = root / "releases" / first
            assert (release / "bin" / "sent-server").exists() and (release / "bin" / "sent-worker").exists()
            assert (release / "runtime.env").read_text() == (
                f"WEB_DIST_PATH={release}/web/dist\nMIGRATIONS_PATH={release}/migrations\n")
            assert (root / "bin" / "sent-run").exists() and (units / "sent-server.service").exists()
            print("PASS success deploy (legacy bootstrap, Rust build, dump before migrating restart, degraded health, self-update)")
            state["sync"] = True
            second = commit()
            state["bad"] = second
            output = deploy(1)
            assert "Previous release healthy" in output
            assert (root / "current").resolve().name == first
            assert (root / "state" / f"failed-{second}").exists()
            assert (root / "previous").resolve() == legacy
            print("PASS health failure -> rollback verified healthy, failed SHA recorded")
            print("PASS failed deploy preserves earlier previous release")
            deploy(0, "rollback")
            assert (root / "current").resolve() == legacy
            print("PASS fresh sync -> manual rollback to legacy without sync block")
            deploy(0, "rollback")
            assert (root / "current").resolve().name == first
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
            state["accounts"] = 0
            fifth = commit()
            deploy()
            assert (root / "current").resolve().name == fifth
            print("PASS fresh sync with zero accounts and null timestamp")
            state["accounts"] = 1
            sixth = commit()
            state["stale"] = sixth
            output = deploy(1)
            assert "Previous release healthy" in output
            assert (root / "current").resolve().name == fifth
            assert (root / "previous").resolve().name == fourth
            print("PASS fresh sync with accounts rejects pre-restart sync timestamp")
            state["stale"] = None
            seventh = commit()
            typescript = root / "releases" / seventh
            typescript.mkdir()
            (root / "current").unlink()
            (root / "current").symlink_to(typescript)
            (root / "state" / "deployed").write_text(f"{seventh} 2026-01-01T00:00:00Z\n")
            deploy()
            assert (root / "current").resolve().name == f"{seventh}-rust"
            assert (root / "previous").resolve() == typescript
            assert deploy() == ""
            assert "already current" in deploy(0, "force", seventh)
            assert (root / "current").resolve().name == f"{seventh}-rust"
            print("PASS cutover commit deployed as TypeScript by the old script -> rebuilt as Rust, TypeScript kept as previous")
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
