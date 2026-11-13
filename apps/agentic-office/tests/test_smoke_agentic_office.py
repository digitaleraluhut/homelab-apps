import unittest

import os
import tempfile

from smoke_agentic_office import BAD_PUBLIC_KEY, classify, url_from_config


class Classify(unittest.TestCase):
    def test_unauthenticated_is_ok(self):
        body = b'{"code":"unauthenticated","message":"public key is not registered"}'
        self.assertIsNone(classify(401, body))

    def test_wrong_code_fails(self):
        self.assertIn("invalid_argument", classify(400, b'{"code":"invalid_argument"}'))

    def test_gateway_error_fails(self):
        self.assertIn("502", classify(502, b"<html>Bad Gateway</html>"))

    def test_code_with_wrong_status_fails(self):
        self.assertIsNotNone(classify(200, b'{"code":"unauthenticated"}'))

    def test_key_is_32_bytes(self):
        import base64

        self.assertEqual(len(base64.b64decode(BAD_PUBLIC_KEY)), 32)


class UrlFromConfig(unittest.TestCase):
    def read(self, text):
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
            f.write(text)
        try:
            return url_from_config(f.name)
        finally:
            os.unlink(f.name)

    def test_reads_public_url(self):
        self.assertEqual(
            self.read("config:\n  agentic-office:hubImage: x:1\n  agentic-office:publicUrl: https://office.example.org\n"),
            "https://office.example.org",
        )

    def test_quoted_and_comment(self):
        self.assertEqual(self.read("  agentic-office:publicUrl: 'https://o.example.org'  # note\n"), "https://o.example.org")

    def test_missing_key_or_file(self):
        self.assertIsNone(self.read("config:\n  agentic-office:hubImage: x:1\n"))
        self.assertIsNone(url_from_config("/nonexistent.yaml"))


if __name__ == "__main__":
    unittest.main()
