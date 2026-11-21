#!/usr/bin/env python3
"""Isolated deployment integration tests; no production services or credentials."""
import http.server
import json
import os
from pathlib import Path
import shutil
import sqlite3
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
        previous = base / "previous-rust"
        (previous / "bin").mkdir(parents=True)
        for service in ("server", "worker"):
            binary = previous / "bin" / f"sent-{service}"
            binary.write_text("#!/bin/sh\n")
            binary.chmod(0o700)
        root.mkdir()
        (root / "current").symlink_to(previous)
        (root / "data").mkdir()
        (root / "data" / "sent.sqlite").write_text("existing")
        tools = base / "tools" / "node" / "bin"
        tools.mkdir(parents=True)
        env_file = base / "shared.env"
        env_file.write_text("")
        bogus_migrations = base / "bogus-migrations"
        bogus_migrations.mkdir()
        with env_file.open("a") as shared:
            shared.write(f"MIGRATIONS_PATH={bogus_migrations}\n")
        work = base / "work"
        work.mkdir()
        run("git", "init", "-b", "master", str(work))
        run("git", "-C", str(work), "config", "user.email", "test@example.com")
        run("git", "-C", str(work), "config", "user.name", "Test")
        (work / "deploy").mkdir()
        shutil.copy(SOURCE, work / "deploy" / "deploy.sh")
        shutil.copy(SOURCE.parent / "sent-run", work / "deploy" / "sent-run")
        shutil.copy(SOURCE.parent / "sqlite-backup.sh", work / "deploy" / "sqlite-backup.sh")
        (work / "deploy" / "systemd").mkdir()
        (work / "deploy" / "systemd" / "sent-server.service").write_text("[Service]\n")
        for name in ("sent-sqlite-backup.service", "sent-sqlite-backup.timer"):
            shutil.copy(SOURCE.parent / "systemd" / name, work / "deploy" / "systemd" / name)
        (work / "web").mkdir()
        (work / "Cargo.toml").write_text("[workspace]\n")
        (work / "migrations").mkdir()
        (work / "migrations" / "0001.sql").write_text("select 1;\n")
        units = base / "units"
        calls = base / "calls"
        for name, body in {
            "pnpm": 'printf "pnpm %s\\n" "$*" >> "$TEST_CALLS"\nif [[ "$*" == "--dir web build" ]]; then\n  [[ "$NODE_ENV" == production ]]\n  mkdir -p web/dist && printf ok > web/dist/index.html\nfi\n',
            "cargo": 'printf "cargo %s\\n" "$*" >> "$TEST_CALLS"\n[[ "$CARGO_HOME" == "$SENT_DEPLOY_TOOLS/cargo" ]]\nfor arg; do case "$arg" in */cargo-target) target=$arg;; esac; done\nmkdir -p "$target/release"\nfor bin in sent-server sent-worker; do printf "#!/bin/sh\\n" > "$target/release/$bin"; chmod 700 "$target/release/$bin"; done\n',
            "systemctl": 'printf "systemctl %s\\n" "$*" >> "$TEST_CALLS"\nif [[ "$1" == show ]]; then if [[ -f "$TEST_LEGACY_UNITS" ]]; then echo loaded; else echo not-found; fi; fi\n',
            "sudo": 'printf "sudo %s\\n" "$*" >> "$TEST_CALLS"\nexit 1\n',
        }.items():
            path = tools / name
            path.write_text("#!/usr/bin/env bash\nset -eu\n" + body)
            path.chmod(0o700)
        sqlite = tools / "sqlite3"
        sqlite.write_text('#!/usr/bin/env python3\nimport os,sys,shlex\nfrom pathlib import Path\nwith open(os.environ["TEST_CALLS"], "a") as f: f.write("sqlite-backup\\n")\nPath(shlex.split(sys.argv[2])[1]).write_text("backup")\n')
        sqlite.chmod(0o700)
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
                    if state["sync"] and current != previous.name:
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
                   SENT_DEPLOY_ENV=str(env_file),
                   SENT_DEPLOY_TOOLS=str(tools.parent.parent), SENT_DEPLOY_HEALTH=url + "/health",
                   SENT_DEPLOY_CI_URL=url + "/ci", SENT_DEPLOY_TIMEOUT="1", SENT_DEPLOY_INTERVAL="0.1",
                   TEST_CALLS=str(calls), TEST_LEGACY_UNITS=str(base / "legacy-units"), SENT_DEPLOY_UNITS=str(units))

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
            assert (root / "current").resolve() == previous
            assert (root / "state" / f"failed-{bootstrap}").exists()
            print("PASS first-bootstrap failure -> healthy Rust rollback")
            state["bad"] = None
            calls.unlink()
            first = commit()
            output = deploy()
            assert (root / "current").resolve().name == first
            assert (root / "state" / "deployed").read_text().startswith(first)
            assert (root / "bin" / "deploy.sh").exists()
            assert len(list((root / "dumps").glob("*.sqlite"))) == 2
            text = calls.read_text()
            assert text.index("cargo build --release --locked") < text.index("sqlite-backup") < text.index("systemctl --user restart")
            release = root / "releases" / first
            assert (release / "bin" / "sent-server").exists() and (release / "bin" / "sent-worker").exists()
            assert (release / "runtime.env").read_text() == (
                f"WEB_DIST_PATH={release}/web/dist\nMIGRATIONS_PATH={release}/migrations\nSENT_DATABASE_PATH={root}/data/sent.sqlite\n")
            assert (root / "bin" / "sent-run").exists() and (units / "sent-server.service").exists()
            print("PASS success deploy (Rust build, SQLite backup before migrating restart, degraded health, self-update)")
            state["sync"] = True
            second = commit()
            state["bad"] = second
            output = deploy(1)
            assert "Previous release healthy" in output
            assert (root / "current").resolve().name == first
            assert (root / "state" / f"failed-{second}").exists()
            assert (root / "previous").resolve() == previous
            print("PASS health failure -> rollback verified healthy, failed SHA recorded")
            print("PASS failed deploy preserves earlier previous release")
            deploy(0, "rollback")
            assert (root / "current").resolve() == previous
            print("PASS fresh sync -> manual rollback to previous Rust release without sync block")
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
            for service in ("server", "worker"):
                binary = root / "current" / "bin" / f"sent-{service}"
                binary.write_text('#!/usr/bin/env bash\nset -eu\n[[ "$MIGRATIONS_PATH" == "$PWD/migrations" && "$SENT_DATABASE_PATH" == "$SENT_DEPLOY_ROOT/data/sent.sqlite" ]]\n')
                run("bash", str(SOURCE.parent / "sent-run"), service,
                    env=dict(env, MIGRATIONS_PATH=str(bogus_migrations)))
            print("PASS launcher exports release migration and SQLite paths")
            missing_binary = root / "current" / "bin" / "sent-server"
            missing_binary.unlink()
            result = subprocess.run(["bash", str(SOURCE.parent / "sent-run"), "server"], env=env, capture_output=True)
            assert result.returncode != 0
            missing_binary.write_text("#!/bin/sh\n")
            missing_binary.chmod(0o700)
            print("PASS launcher rejects a release without a Rust binary")
            marker = base / "legacy-units"
            marker.touch()
            cleanup = commit()
            start = len(calls.read_text())
            output = deploy()
            operations = calls.read_text()[start:]
            assert "WARNING: legacy sent-backup system units remain installed" in output
            assert "sudo systemctl disable --now sent-backup.timer && sudo systemctl stop sent-backup.service && sudo rm -f /etc/systemd/system/sent-backup.timer /etc/systemd/system/sent-backup.service && sudo systemctl daemon-reload" in output
            assert "sudo " not in operations and marker.exists()
            assert (root / "current").resolve().name == cleanup
            assert (units / "sent-sqlite-backup.timer").exists()
            assert "enable --now sent-sqlite-backup.timer" in operations
            print("PASS legacy system backup units warn with manual cleanup command without blocking deploy or invoking sudo")
            marker.unlink()
            later = commit()
            start = len(calls.read_text())
            output = deploy()
            operations = calls.read_text()[start:]
            assert "sudo " not in operations and "sqlite-backup" in operations
            assert "WARNING:" not in output
            assert (root / "current").resolve().name == later
            print("PASS absent legacy units are silent and deployment succeeds with SQLite backups enabled")
            database_path = root / "data" / "sent.sqlite"
            database_path.unlink()
            output = deploy(1, "force", cleanup)
            assert "Missing SQLite database" in output
            database_path.write_text("existing")
            print("PASS missing database refuses deployment rather than creating an empty mailbox")
            backup_root = base / "nightly"
            (backup_root / "data").mkdir(parents=True)
            (backup_root / "backups").mkdir()
            with sqlite3.connect(backup_root / "data" / "sent.sqlite") as database:
                database.execute("create table fixture(value text)")
                database.execute("insert into fixture values ('preserved')")
            expired = backup_root / "backups" / "expired.sqlite"
            expired.write_text("old")
            os.utime(expired, (time.time() - 15 * 86400,) * 2)
            nightly_env = dict(os.environ, SENT_DEPLOY_ROOT=str(backup_root))
            run("bash", str(SOURCE.parent / "sqlite-backup.sh"), env=nightly_env)
            assert not expired.exists()
            backups = list((backup_root / "backups").glob("*.sqlite"))
            assert len(backups) == 1
            with sqlite3.connect(backups[0]) as database:
                assert database.execute("select value from fixture").fetchone()[0] == "preserved"
            (backup_root / "data" / "sent.sqlite").write_text("not a database")
            failed_backup = subprocess.run(["bash", str(SOURCE.parent / "sqlite-backup.sh")], env=nightly_env, capture_output=True)
            assert failed_backup.returncode != 0 and not list((backup_root / "backups").glob("*.tmp"))
            print("PASS nightly SQLite backup is readable, expires old backups, and cleans up failures")
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
