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
        legacy = base / "legacy"
        legacy.mkdir()
        tools = base / "tools" / "node" / "bin"
        tools.mkdir(parents=True)
        env_file = base / "shared.env"
        env_file.write_text("DATABASE_URL=postgres://test:fake%40password@fake/test?sslmode=verify-full&sslrootcert=%2Ffake%2Froot.crt&sslcert=%2Ffake%2Fclient.crt&sslkey=%2Ffake%2Fclient.key\n")
        bogus_migrations = base / "bogus-postgres-migrations"
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
            "cargo": 'printf "cargo %s\\n" "$*" >> "$TEST_CALLS"\n[[ "$CARGO_HOME" == "$SENT_DEPLOY_TOOLS/cargo" ]]\nfor arg; do case "$arg" in */cargo-target) target=$arg;; esac; done\nmkdir -p "$target/release"\nfor bin in sent-server sent-worker; do printf "#!/bin/sh\\n" > "$target/release/$bin"; chmod 700 "$target/release/$bin"; done\nif [[ "$*" == *"--bin sent-import-postgres"* ]]; then cp test-importer "$target/release/sent-import-postgres"; chmod 700 "$target/release/sent-import-postgres"; fi\n',
            "pg_dump": '[[ "$PGPASSWORD" == "fake@password" && "$PGSSLMODE" == verify-full && "$PGSSLROOTCERT" == /fake/root.crt && "$PGSSLCERT" == /fake/client.crt && "$PGSSLKEY" == /fake/client.key ]]\nprintf "dump\\n" >> "$TEST_CALLS"\nfor arg; do case "$arg" in --file=*) printf fake > "${arg#--file=}";; esac; done\n',
            "systemctl": 'printf "systemctl %s\\n" "$*" >> "$TEST_CALLS"\n',
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
            state["sync"] = False
            (work / "server" / "src" / "bin").mkdir(parents=True)
            (work / "server" / "src" / "bin" / "sent-import-postgres.rs").write_text("// marker\n")
            (work / "test-importer").write_text('#!/usr/bin/env bash\nset -eu\nrelease=$(dirname "$(dirname "$0")")\n[[ -n "$DATABASE_URL" && "$MIGRATIONS_PATH" == "$release/migrations" && -f "$MIGRATIONS_PATH/0001.sql" ]]\nprintf "import\\n" >> "$TEST_CALLS"\nprintf imported > "$1"\n')
            failed_sqlite = commit()
            state["bad"] = failed_sqlite
            start = len(calls.read_text())
            deploy(1)
            operations = calls.read_text()[start:]
            assert operations.index("systemctl --user stop") < operations.index("dump") < operations.index("import\n") < operations.index("systemctl --user restart")
            assert not (root / "data" / "sent.sqlite").exists()
            assert len(list((root / "data").glob("sent.sqlite.failed-*"))) == 1
            assert (root / "current").resolve().name == f"{seventh}-rust"
            print("PASS first SQLite failure: stop -> pg_dump -> import -> restart; database moved aside, Postgres release restored")
            state["bad"] = None
            first_sqlite = commit()
            deploy()
            assert (root / "data" / "sent.sqlite").read_text() == "imported"
            assert f"SENT_DATABASE_PATH={root}/data/sent.sqlite\n" in (root / "current" / "runtime.env").read_text()
            assert (units / "sent-sqlite-backup.timer").exists()
            assert "enable --now sent-sqlite-backup.timer" in calls.read_text()
            print("PASS successful first SQLite deploy imports again and installs/enables nightly backups")
            deploy(0, "rollback")
            assert (root / "current").resolve().name == f"{seventh}-rust"
            assert "SENT_DATABASE_PATH" not in (root / "current" / "runtime.env").read_text()
            deploy(0, "rollback")
            assert (root / "current").resolve().name == first_sqlite
            for service in ("server", "worker"):
                binary = root / "current" / "bin" / f"sent-{service}"
                binary.write_text('#!/usr/bin/env bash\nset -eu\nexec node --env-file=.env -e \'if (process.env.MIGRATIONS_PATH !== process.cwd() + "/migrations") process.exit(1);\'\n')
                run("bash", str(SOURCE.parent / "sent-run"), service,
                    env=dict(env, MIGRATIONS_PATH=str(bogus_migrations)))
            print("PASS importer, server and worker use release migrations despite bogus shared/inherited MIGRATIONS_PATH")
            run("bash", str(SOURCE.parent / "sent-run"), "server", env=env)
            runtime = root / "current" / "runtime.env"
            saved_runtime = runtime.read_text()
            runtime.write_text("WEB_DIST_PATH=/unused\nMIGRATIONS_PATH=/unused\n")
            incomplete = subprocess.run(["bash", str(SOURCE.parent / "sent-run"), "server"], env=env, capture_output=True)
            assert incomplete.returncode != 0 and b"cutover is incomplete" in incomplete.stderr
            runtime.write_text(saved_runtime)
            print("PASS launcher exports SQLite runtime configuration and refuses an incomplete cutover")
            print("PASS rollback to Postgres release and back to SQLite without changing shared environment")
            later_sqlite = commit()
            start = len(calls.read_text())
            deploy()
            operations = calls.read_text()[start:]
            assert "sqlite-backup" in operations and "dump\n" not in operations and "import\n" not in operations
            assert len(list((root / "dumps").glob("*.sqlite"))) == 1
            assert (root / "current").resolve().name == later_sqlite
            print("PASS later SQLite deployment uses consistent SQLite backup, no pg_dump or import")
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
