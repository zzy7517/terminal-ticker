"""Test LLM agent framework helpers."""
import base64
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from terminal_ticker.agent import (
    _codex_request_headers,
    _read_codex_cli_credentials,
    _result_from_text,
)


def _fake_jwt(claims: dict) -> str:
    """Build an unsigned JWT-like token for metadata parsing tests."""
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"{header}.{payload}.sig"


class AgentTests(unittest.TestCase):
    """Group tests for agent provider support."""

    def test_parse_agent_result_from_json_text(self) -> None:
        """Verify strict JSON agent output is normalized."""
        result = _result_from_text(
            json.dumps(
                {
                    "summary": "Breakout is developing.",
                    "bias": "bullish",
                    "confidence": 72,
                    "key_levels": [{"label": "support", "price": "198.5", "reason": "prior low"}],
                    "watch_plan": ["Watch retest."],
                    "invalidation": "Lose 198.5",
                    "risk_notes": ["Not financial advice."],
                }
            ),
            provider="codex",
            model="gpt-test",
        )

        self.assertTrue(result.available)
        self.assertEqual(result.bias, "bullish")
        self.assertEqual(result.confidence, 72)
        self.assertEqual(result.key_levels[0]["price"], 198.5)

    def test_invalid_agent_result_is_unavailable(self) -> None:
        """Verify non-JSON model output degrades safely."""
        result = _result_from_text("not json", provider="codex", model="gpt-test")

        self.assertFalse(result.available)
        self.assertIn("JSON", result.error)

    def test_read_codex_cli_credentials_from_codex_home(self) -> None:
        """Verify provider reads Codex CLI auth.json directly."""
        token = _fake_jwt({"exp": time.time() + 3600, "chatgpt_account_id": "acct-test"})
        with tempfile.TemporaryDirectory() as tmp_dir:
            auth_path = Path(tmp_dir) / "auth.json"
            auth_path.write_text(
                json.dumps(
                    {
                        "auth_mode": "chatgpt",
                        "tokens": {
                            "access_token": token,
                            "refresh_token": "refresh",
                            "account_id": "acct-from-file",
                        },
                    }
                )
            )
            with patch.dict("os.environ", {"CODEX_HOME": tmp_dir}, clear=False):
                creds = _read_codex_cli_credentials()

        self.assertEqual(creds["api_key"], token)
        self.assertEqual(creds["account_id"], "acct-from-file")

    def test_codex_headers_include_account_id(self) -> None:
        """Verify Codex-shaped headers include account routing."""
        headers = _codex_request_headers("bad-token", "acct-direct")

        self.assertEqual(headers["originator"], "codex_cli_rs")
        self.assertEqual(headers["ChatGPT-Account-ID"], "acct-direct")


if __name__ == "__main__":
    unittest.main()
