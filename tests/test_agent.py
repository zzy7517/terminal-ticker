"""Test LLM agent framework helpers."""
import asyncio
import base64
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from mytradebot.agent import (
    AgentSessionStore,
    ToolCall,
    build_market_tools,
    _codex_request_headers,
    _read_codex_cli_credentials,
    _result_from_text,
)
from mytradebot.agent.providers.codex import _collect_response_stream_full


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

    def test_codex_stream_parser_uses_item_id_for_function_arguments(self) -> None:
        """Verify Responses function-call argument events merge with their output item."""

        class FakeResponse:
            async def aiter_lines(self):
                events = [
                    {
                        "type": "response.output_item.added",
                        "output_index": 0,
                        "item": {
                            "type": "function_call",
                            "id": "fc_1",
                            "call_id": "call_1",
                            "name": "get_quote",
                            "arguments": "",
                        },
                    },
                    {
                        "type": "response.function_call_arguments.delta",
                        "item_id": "fc_1",
                        "output_index": 0,
                        "delta": "{\"instrument_key\":",
                    },
                    {
                        "type": "response.function_call_arguments.delta",
                        "item_id": "fc_1",
                        "output_index": 0,
                        "delta": "\"alpaca:AAPL\"}",
                    },
                    {
                        "type": "response.function_call_arguments.done",
                        "item_id": "fc_1",
                        "output_index": 0,
                        "arguments": "{\"instrument_key\":\"alpaca:AAPL\"}",
                    },
                    {
                        "type": "response.output_item.done",
                        "output_index": 0,
                        "item": {
                            "type": "function_call",
                            "id": "fc_1",
                            "call_id": "call_1",
                            "name": "get_quote",
                            "arguments": "{\"instrument_key\":\"alpaca:AAPL\"}",
                        },
                    },
                ]
                for event in events:
                    yield "data: " + json.dumps(event)

        response = asyncio.run(_collect_response_stream_full(FakeResponse()))

        self.assertEqual(len(response.tool_calls), 1)
        self.assertEqual(response.tool_calls[0].id, "call_1")
        self.assertEqual(response.tool_calls[0].name, "get_quote")
        self.assertEqual(response.tool_calls[0].arguments, {"instrument_key": "alpaca:AAPL"})

    def test_get_candles_clamps_requested_count(self) -> None:
        """Verify candle tool never returns the whole history for zero or negative counts."""
        candles = tuple(
            SimpleNamespace(
                open_time_ms=1776846000000 + index * 60_000,
                open=index,
                high=index + 1,
                low=index - 1,
                close=index + 0.5,
                volume=index * 100,
            )
            for index in range(5)
        )
        quote = SimpleNamespace(candles=candles)
        context_provider = SimpleNamespace(
            get_quote=lambda instrument_key: quote if instrument_key == "alpaca:AAPL" else None,
            get_candles=lambda instrument_key, interval=None: candles if instrument_key == "alpaca:AAPL" else tuple(),
            list_instruments=lambda: tuple(),
        )
        tools = build_market_tools(context_provider)

        zero_result = asyncio.run(tools.execute(ToolCall(
            id="call_1",
            name="get_candles",
            arguments={"instrument_key": "alpaca:AAPL", "count": 0},
        )))
        large_result = asyncio.run(tools.execute(ToolCall(
            id="call_2",
            name="get_candles",
            arguments={"instrument_key": "alpaca:AAPL", "count": 100},
        )))

        self.assertFalse(zero_result.error)
        self.assertEqual(len(json.loads(zero_result.output)), 1)
        self.assertEqual(len(json.loads(large_result.output)), 5)
        self.assertEqual(tools.get("get_candles").parameters["properties"]["count"]["minimum"], 1)
        self.assertEqual(tools.get("get_candles").parameters["properties"]["count"]["maximum"], 50)
        self.assertIn("interval", tools.get("get_candles").parameters["properties"])

    def test_session_store_persists_active_conversation(self) -> None:
        """Verify local agent sessions survive store re-instantiation."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "agent.sqlite3"
            store = AgentSessionStore(path)
            session = store.get_or_create_active_session(
                instrument_key="alpaca:AAPL",
                title="AAPL · AAPL",
                provider="codex",
                model="gpt-test",
            )
            store.append_message(
                session_id=session.id,
                role="user",
                content="How does this K-line window look?",
            )
            store.append_message(
                session_id=session.id,
                role="assistant",
                content="Trend is constructive.",
                analysis={
                    "summary": "Trend is constructive.",
                    "bias": "bullish",
                    "confidence": 70,
                    "watchPlan": ["Wait for a pullback."],
                    "invalidation": "Lose 200.",
                },
            )

            reopened = AgentSessionStore(path)
            payload = reopened.active_session_payload("alpaca:AAPL")
            history = reopened.history_for_context(session.id, limit=4)
            refreshed_session = reopened.get_or_create_active_session(
                instrument_key="alpaca:AAPL",
                title="AAPL · AAPL",
                provider="codex",
                model="gpt-next",
            )
            next_session = reopened.create_session(
                instrument_key="alpaca:AAPL",
                title="AAPL · AAPL",
                provider="codex",
                model="gpt-test",
            )
            previous_payload = reopened.session_payload(session.id)

        self.assertIsNotNone(payload)
        self.assertEqual(payload["session"]["id"], session.id)
        self.assertEqual([message["role"] for message in payload["messages"]], ["user", "assistant"])
        self.assertEqual(payload["messages"][1]["analysis"]["summary"], "Trend is constructive.")
        self.assertEqual(history[-1]["analysis"]["watch_plan"], ["Wait for a pullback."])
        self.assertEqual(refreshed_session.id, session.id)
        self.assertEqual(refreshed_session.model, "gpt-next")
        self.assertEqual(next_session.instrument_key, "alpaca:AAPL")
        self.assertFalse(previous_payload["session"]["active"])


if __name__ == "__main__":
    unittest.main()
