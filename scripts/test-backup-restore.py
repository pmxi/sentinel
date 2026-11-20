import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import unittest

SCRIPTS = Path(__file__).resolve().parent


class BackupRestoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="sent-backup-", dir=Path.home())
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "quoted ' directory"
        self.root.mkdir()
        self.database = self.root / "live.sqlite"
        self.backups = self.root / "backups"

    def run_script(self, script, *args, config=None, cwd=None):
        env = dict(os.environ, SENT_DATABASE_PATH=str(self.database),
                   SENT_BACKUP_DIR=str(self.backups),
                   SENT_SERVER_BIN=os.environ.get("SENT_SERVER_BIN", str(SCRIPTS.parent / "target/debug/sent-server")))
        env.update(config or {})
        return subprocess.run(["sh", str(SCRIPTS / script), *map(str, args)],
                              env={key: value for key, value in env.items() if value is not None},
                              cwd=cwd, capture_output=True, text=True)

    def test_consistent_wal_backup_retention_and_explicit_restore(self):
        with sqlite3.connect(self.database) as connection:
            connection.execute("pragma journal_mode=wal")
            connection.execute("create table fixture(value text)")
            connection.execute("insert into fixture values ('committed')")
            connection.commit()
            self.backups.mkdir()
            expired = self.backups / "sent-script-backup-expired.sqlite"
            expired.touch()
            os.utime(expired, (time.time() - 15 * 86400,) * 2)
            result = self.run_script("backup.sh")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(expired.exists())
            backup, = self.backups.glob("sent-script-backup-*.sqlite")
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
            with sqlite3.connect(backup) as copy:
                self.assertEqual(copy.execute("select value from fixture").fetchall(), [("committed",)])
            target = self.root / "restored private" / "new ' database.sqlite"
            restored = self.run_script("restore.sh", backup, target)
            self.assertEqual(restored.returncode, 0, restored.stderr)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)
            with sqlite3.connect(target) as copy:
                self.assertEqual(copy.execute("select value from fixture").fetchall(), [("committed",)])
            self.assertNotEqual(self.run_script("restore.sh", backup, target).returncode, 0)
            self.assertNotEqual(self.run_script("restore.sh", backup).returncode, 0)

    def test_missing_or_corrupt_sources_do_not_publish_files(self):
        self.assertNotEqual(self.run_script("backup.sh").returncode, 0)
        self.assertFalse(self.database.exists())
        self.database.write_text("not SQLite")
        self.assertNotEqual(self.run_script("backup.sh").returncode, 0)
        self.assertFalse(list(self.backups.glob("*.sqlite")))
        target = self.root / "new.sqlite"
        self.assertNotEqual(self.run_script("restore.sh", self.database, target).returncode, 0)
        self.assertFalse(target.exists())
        self.assertFalse(list(self.root.glob(".sent-restore-*")))

    def test_restore_refuses_stale_sidecars(self):
        with sqlite3.connect(self.database) as connection:
            connection.execute("create table fixture(value text)")
        target = self.root / "new.sqlite"
        Path(str(target) + "-wal").touch()
        self.assertNotEqual(self.run_script("restore.sh", self.database, target).returncode, 0)
        self.assertFalse(target.exists())

    def test_retention_preserves_source_and_unrelated_old_databases(self):
        self.backups.mkdir()
        source = self.backups / "sent-script-backup-live.sqlite"
        with sqlite3.connect(source) as connection:
            connection.execute("create table fixture(value text)")
        self.database.symlink_to(source)
        unrelated = self.backups / "sent-unrelated.sqlite"
        unrelated.touch()
        for path in (source, unrelated):
            os.utime(path, (time.time() - 15 * 86400,) * 2)
        result = self.run_script("backup.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(source.exists())
        self.assertTrue(unrelated.exists())

    def test_database_configuration_precedence_and_missing_configured_file(self):
        configured = self.root / "configured.sqlite"
        default = self.root / "data" / "sent.sqlite"
        default.parent.mkdir()
        for path, value in ((configured, "dotenv"), (default, "default"), (self.database, "environment")):
            with sqlite3.connect(path) as connection:
                connection.execute("create table fixture(value text)")
                connection.execute("insert into fixture values (?)", (value,))
        env_file = self.root / ".env"
        env_file.write_text(f'export SENT_DATABASE_PATH="{configured}" # quoted path\n')

        def check(expected, config, cwd):
            before = set(self.backups.glob("*.sqlite"))
            result = self.run_script("backup.sh", config=config, cwd=cwd)
            self.assertEqual(result.returncode, 0, result.stderr)
            created, = set(self.backups.glob("*.sqlite")) - before
            with sqlite3.connect(created) as connection:
                self.assertEqual(connection.execute("select value from fixture").fetchone(), (expected,))

        check("environment", {}, self.root)
        nested = self.root / "nested"
        nested.mkdir()
        check("dotenv", {"SENT_DATABASE_PATH": None}, nested)
        env_file.write_text(f'SENT_BACKUP_TEST_DIRECTORY="{self.root}"\n'
                            'SENT_DATABASE_PATH=${SENT_BACKUP_TEST_DIRECTORY}/configured.sqlite\n'
                            'SENT_DATABASE_PATH=missing-duplicate.sqlite\n')
        check("dotenv", {"SENT_DATABASE_PATH": None, "SENT_BACKUP_TEST_DIRECTORY": None}, nested)
        env_file.write_text('SENT_DATABASE_PATH="missing.sqlite"\n')
        self.assertNotEqual(self.run_script("backup.sh", config={"SENT_DATABASE_PATH": None}, cwd=self.root).returncode, 0)
        self.assertNotEqual(self.run_script("backup.sh", config={"SENT_DATABASE_PATH": ""}, cwd=self.root).returncode, 0)
        env_file.unlink()
        check("default", {"SENT_DATABASE_PATH": None}, self.root)

    def test_restore_refuses_the_configured_database_even_when_missing(self):
        with sqlite3.connect(self.database) as connection:
            connection.execute("create table fixture(value text)")
        target = self.root / "missing.sqlite"
        env_file = self.root / ".env"
        env_file.write_text(f'SENT_DATABASE_PATH="{target}"\n'
                            'SENT_DATABASE_PATH=other.sqlite\n')
        result = self.run_script("restore.sh", self.database, target,
                                 config={"SENT_DATABASE_PATH": None}, cwd=self.root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("configured application database", result.stderr)
        self.assertFalse(target.exists())

    def test_backup_and_restore_do_not_require_hard_links(self):
        tools = self.root / "tools"
        tools.mkdir()
        link = tools / "ln"
        link.write_text("#!/bin/sh\nexit 91\n")
        link.chmod(0o755)
        with sqlite3.connect(self.database) as connection:
            connection.execute("create table fixture(value text)")
        config = {"PATH": str(tools) + os.pathsep + os.environ["PATH"]}
        backed_up = self.run_script("backup.sh", config=config)
        self.assertEqual(backed_up.returncode, 0, backed_up.stderr)
        backup, = self.backups.glob("*.sqlite")
        restored = self.run_script("restore.sh", backup, self.root / "restored.sqlite", config=config)
        self.assertEqual(restored.returncode, 0, restored.stderr)


if __name__ == "__main__":
    unittest.main()
