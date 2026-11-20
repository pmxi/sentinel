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

    def run_script(self, script, *args):
        return subprocess.run(["sh", str(SCRIPTS / script), *map(str, args)],
                              env=dict(os.environ, SENT_DATABASE_PATH=str(self.database),
                                       SENT_BACKUP_DIR=str(self.backups)), capture_output=True, text=True)

    def test_consistent_wal_backup_retention_and_explicit_restore(self):
        with sqlite3.connect(self.database) as connection:
            connection.execute("pragma journal_mode=wal")
            connection.execute("create table fixture(value text)")
            connection.execute("insert into fixture values ('committed')")
            connection.commit()
            self.backups.mkdir()
            expired = self.backups / "sent-expired.sqlite"
            expired.touch()
            os.utime(expired, (time.time() - 15 * 86400,) * 2)
            result = self.run_script("backup.sh")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(expired.exists())
            backup, = self.backups.glob("sent-*.sqlite")
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


if __name__ == "__main__":
    unittest.main()
