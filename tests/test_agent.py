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
)
from mytradebot.agent.providers.codex import (
    _codex_tools_payload,
    _collect_response_stream_full,
    _messages_to_codex_input,
)


def _fake_jwt(claims: dict) -> str:
    """Build an unsigned JWT-like token for metadata parsing tests."""
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"{header}.{payload}.sig"


class AgentTests(unittest.TestCase):
    """Group tests for agent provider support."""

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

    def test_codex_tools_payload_replaces_local_web_search_with_hosted_tool(self) -> None:
        """Verify Codex uses the native hosted web_search tool instead of the local wrapper."""
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "web_search",
                    "description": "local search wrapper",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "web_fetch",
                    "description": "local fetch wrapper",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "get_quote",
                    "description": "market quote",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
        ]

        payload = _codex_tools_payload(tools)

        function_names = {
            item["name"]
            for item in payload
            if item.get("type") == "function"
        }
        hosted_tools = [item for item in payload if item.get("type") == "web_search"]
        self.assertNotIn("web_search", function_names)
        self.assertIn("web_fetch", function_names)
        self.assertIn("get_quote", function_names)
        self.assertEqual(hosted_tools, [{
            "type": "web_search",
            "external_web_access": True,
        }])

    def test_codex_tools_payload_respects_absent_local_web_search(self) -> None:
        """Verify Codex does not add hosted web_search when callers omit search tools."""
        self.assertEqual(_codex_tools_payload(None), [])
        self.assertEqual(_codex_tools_payload([]), [])

        payload = _codex_tools_payload([
            {
                "type": "function",
                "function": {
                    "name": "get_quote",
                    "description": "market quote",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
        ])

        self.assertEqual(payload, [{
            "type": "function",
            "name": "get_quote",
            "description": "market quote",
            "parameters": {"type": "object", "properties": {}},
        }])

    def test_codex_stream_parser_ignores_hosted_web_search_as_local_tool(self) -> None:
        """Verify hosted web_search calls do not get re-executed by the local loop."""

        class FakeResponse:
            async def aiter_lines(self):
                events = [
                    {
                        "type": "response.output_item.done",
                        "item": {
                            "type": "web_search_call",
                            "id": "ws_1",
                            "status": "completed",
                            "action": {
                                "type": "search",
                                "query": "AI agent news",
                            },
                        },
                    },
                    {
                        "type": "response.output_text.done",
                        "text": "Searched the web and found current agent news.",
                    },
                ]
                for event in events:
                    yield "data: " + json.dumps(event)

        response = asyncio.run(_collect_response_stream_full(FakeResponse()))

        self.assertEqual(response.content, "Searched the web and found current agent news.")
        self.assertEqual(response.tool_calls, [])

    def test_codex_history_replays_tool_calls_as_text_context(self) -> None:
        """Verify replayed tool calls avoid rejected Responses function_call input items."""
        messages = [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "Check BTC."},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "get_candles",
                            "arguments": "{\"instrument_key\":\"bitget:BTCUSDT\"}",
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": "[{\"close\": 65000}]",
            },
        ]

        codex_input = _messages_to_codex_input(messages)

        self.assertEqual(codex_input[0]["role"], "user")
        self.assertEqual(codex_input[1]["role"], "assistant")
        self.assertIn("Tool call requested: get_candles", codex_input[1]["content"][0]["text"])
        self.assertEqual(codex_input[2]["role"], "user")
        self.assertIn("Tool result for call_1", codex_input[2]["content"][0]["text"])
        content_types = [
            part["type"]
            for item in codex_input
            for part in item.get("content", [])
        ]
        self.assertNotIn("function_call", content_types)

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
                api_mode="codex_responses",
                reasoning_effort="medium",
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
                metadata={
                    "toolCalls": [{
                        "id": "call_1",
                        "name": "get_candles",
                        "arguments": {"interval": "5m"},
                    }],
                },
            )
            store.append_message(
                session_id=session.id,
                role="toolResult",
                content='{"candles":[]}',
                metadata={"toolCallId": "call_1", "toolName": "get_candles", "error": False},
            )

            reopened = AgentSessionStore(path)
            payload = reopened.active_session_payload("alpaca:AAPL")
            history = reopened.history_for_context(session.id, limit=4)
            refreshed_session = reopened.get_or_create_active_session(
                instrument_key="alpaca:AAPL",
                title="AAPL · AAPL",
                provider="codex",
                model="gpt-next",
                api_mode="codex_responses",
                reasoning_effort="high",
            )
            next_session = reopened.create_session(
                instrument_key="alpaca:AAPL",
                title="AAPL · AAPL",
                provider="codex",
                model="gpt-test",
                api_mode="codex_responses",
                reasoning_effort="medium",
            )
            previous_payload = reopened.session_payload(session.id)
            history_rows = reopened.list_sessions("alpaca:AAPL")
            resumed = reopened.activate_session(
                instrument_key="alpaca:AAPL",
                session_id=session.id,
            )
            active_after_delete = reopened.delete_session(
                instrument_key="alpaca:AAPL",
                session_id=session.id,
            )
            deleted_payload = reopened.session_payload(session.id)

        self.assertIsNotNone(payload)
        self.assertEqual(payload["session"]["id"], session.id)
        self.assertEqual(payload["session"]["apiMode"], "codex_responses")
        self.assertEqual(payload["session"]["reasoningEffort"], "medium")
        self.assertEqual([message["role"] for message in payload["messages"]], ["user", "assistant", "toolResult"])
        self.assertEqual(payload["messages"][1]["metadata"]["toolCalls"][0]["name"], "get_candles")
        self.assertEqual(history[-1]["role"], "tool")
        self.assertEqual(history[-1]["tool_call_id"], "call_1")
        self.assertEqual(refreshed_session.id, session.id)
        self.assertEqual(refreshed_session.model, "gpt-next")
        self.assertEqual(refreshed_session.reasoning_effort, "high")
        self.assertEqual(next_session.instrument_key, "alpaca:AAPL")
        self.assertFalse(previous_payload["session"]["active"])
        self.assertEqual(len(history_rows), 2)
        self.assertEqual(history_rows[1].preview, "How does this K-line window look?")
        self.assertEqual(history_rows[1].message_count, 3)
        self.assertEqual(resumed.id, session.id)
        self.assertEqual(active_after_delete.id, next_session.id)
        self.assertIsNone(deleted_payload)


if __name__ == "__main__":
    unittest.main()
