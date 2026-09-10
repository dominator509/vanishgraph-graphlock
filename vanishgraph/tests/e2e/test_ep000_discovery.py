import unittest
import os
import subprocess

class TestEP000Discovery(unittest.TestCase):
    def test_discovery_entrypoint(self):
        # We expect a command line tool or a script that performs "discovery" (LIVE-FIRE-PROOF-01)
        # For now, it should fail since we haven't implemented it.
        # Happy path: running `python3 src/discovery.py --subject "John Doe"`
        script_path = "src/discovery.py"

        # Test boundary/failure case: no subject provided
        result = subprocess.run(["python3", script_path], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0, "Expected non-zero exit code when no subject is provided")
        self.assertIn("error", result.stderr.lower(), "Expected error message for missing subject")

        # Test happy path
        result = subprocess.run(["python3", script_path, "--subject", "John Doe"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, f"Expected zero exit code, got {result.returncode}. Stderr: {result.stderr}")
        self.assertIn("real sources with explainable match", result.stdout.lower(), "Expected to see discovery match output")

        # Test persistence read-back (mocking durable effect or similar if applicable)
        # We can write to a local log or DB and read it back
        log_file = "discovery_results.log"
        self.assertTrue(os.path.exists(log_file), "Expected durable effect (log file) to be created")
        with open(log_file, "r") as f:
            content = f.read()
            self.assertIn("John Doe", content, "Expected subject to be durably logged")

if __name__ == "__main__":
    unittest.main()
