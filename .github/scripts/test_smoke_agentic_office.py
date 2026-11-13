import unittest

from smoke_agentic_office import BAD_PUBLIC_KEY, classify


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


if __name__ == "__main__":
    unittest.main()
