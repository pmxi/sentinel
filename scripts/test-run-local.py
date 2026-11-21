import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("run-local.sh")


class LocalRunnerArguments(unittest.TestCase):
    def run_script(self, *args, database="sent_benchmark"):
        env = {**os.environ, "SENT_LOCAL_DB": database, "SENT_LOCAL_PORT": "4000"}
        return subprocess.run(
            ["bash", str(SCRIPT), *args], env=env, capture_output=True, text=True
        )

    def test_help(self):
        result = self.run_script("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("3000 messages, port 4000", result.stdout)

    def test_accepts_empty_and_normal_mailbox_sizes(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ["cargo", "node", "pnpm", "curl"]:
                stub = Path(directory) / name
                stub.write_text("#!/bin/sh\necho reached-local-preflight\nexit 7\n")
                stub.chmod(0o755)
            env = {**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"], "SENT_LOCAL_DB": "sent_benchmark", "SENT_LOCAL_PORT": "4000"}
            for size in ["0", "37", "3000"]:
                with self.subTest(size=size):
                    result = subprocess.run(["bash", str(SCRIPT), "--messages", size], env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 7)
                    self.assertIn("reached-local-preflight", result.stdout)

    def test_missing_and_unknown_arguments(self):
        for args in [("--messages",), ("--port",), ("--unknown",)]:
            with self.subTest(args=args):
                self.assertNotEqual(self.run_script(*args).returncode, 0)

    def test_invalid_values_fail_before_any_dependencies_start(self):
        for option, values in [
            ("--messages", ["", "-1", "abc", "1.5", "01"]),
            ("--port", ["", "0", "65536", "999999999999999999999", "abc"]),
        ]:
            for value in values:
                with self.subTest(option=option, value=value):
                    result = self.run_script(option, value)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Error:", result.stderr)

    def test_refuses_shared_or_non_benchmark_databases(self):
        for database in ["sent", "production", "sent_benchmark;drop", "sent_benchmark_" + "x" * 64]:
            with self.subTest(database=database):
                result = self.run_script(database=database)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Database must be", result.stderr)


if __name__ == "__main__":
    unittest.main()
