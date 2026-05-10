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

from tradex.agent import (
    AgentLoop,
    AgentSessionStore,
    ChatResponse,
    ToolCall,
    ToolRegistry,
    build_market_tools,
    build_social_feed_tools,
    _codex_request_headers,
    _read_codex_cli_credentials,
)
from tradex.agent.providers.codex import (
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
                        "delta": "\"USDT-FUTURES:BTCUSDT\"}",
                    },
                    {
                        "type": "response.function_call_arguments.done",
                        "item_id": "fc_1",
                        "output_index": 0,
                        "arguments": "{\"instrument_key\":\"USDT-FUTURES:BTCUSDT\"}",
                    },
                    {
                        "type": "response.output_item.done",
                        "output_index": 0,
                        "item": {
                            "type": "function_call",
                            "id": "fc_1",
                            "call_id": "call_1",
                            "name": "get_quote",
                            "arguments": "{\"instrument_key\":\"USDT-FUTURES:BTCUSDT\"}",
                        },
                    },
                ]
                for event in events:
                    yield "data: " + json.dumps(event)

        response = asyncio.run(_collect_response_stream_full(FakeResponse()))

        self.assertEqual(len(response.tool_calls), 1)
        self.assertEqual(response.tool_calls[0].id, "call_1")
        self.assertEqual(response.tool_calls[0].name, "get_quote")
        self.assertEqual(response.tool_calls[0].arguments, {"instrument_key": "USDT-FUTURES:BTCUSDT"})

    def test_agent_loop_stream_updates_send_delta_only(self) -> None:
        """Verify live message updates carry deltas while final messages carry full text."""
        class StreamingProvider:
            name = "codex"
            model = "streaming"

            async def chat(self, messages, tools=None, on_delta=None):
                await on_delta("Hello")
                await on_delta(" world\n")
                return ChatResponse(content="Hello world\n")

        events = []
        loop = AgentLoop(provider=StreamingProvider(), tools=ToolRegistry())

        async def run_loop():
            await loop.run("Say hello", event_handler=lambda event: events.append(event))

        asyncio.run(run_loop())

        updates = [event for event in events if event["type"] == "message_update"]
        self.assertEqual([event["delta"] for event in updates], ["Hello", " world\n"])
        self.assertEqual([event["message"]["content"] for event in updates], ["", ""])
        final_message = next(event for event in events if event["type"] == "message_end")["message"]
        self.assertEqual(final_message["content"], "Hello world\n")
        final_event = next(event for event in events if event["type"] == "agent_end")
        self.assertNotIn("totalTokens", final_event)
        self.assertNotIn("promptTokens", final_event)

    def test_agent_loop_stores_usage_metadata_on_assistant_message(self) -> None:
        """Verify completed turns persist usage so history reload can show context usage."""
        class UsageProvider:
            name = "codex"
            model = "usage"

            async def chat(self, messages, tools=None):
                return ChatResponse(
                    content="Done.",
                    usage={"prompt_tokens": 1200, "completion_tokens": 80},
                )

        events = []
        loop = AgentLoop(provider=UsageProvider(), tools=ToolRegistry())
        result = asyncio.run(loop.run("Check usage", event_handler=lambda event: events.append(event)))

        self.assertEqual(result.prompt_tokens, 1200)
        self.assertEqual(result.total_tokens, 1280)
        usage = result.messages[-1].metadata["usage"]
        self.assertEqual(usage["promptTokens"], 1200)
        self.assertEqual(usage["completionTokens"], 80)
        self.assertEqual(usage["totalTokens"], 1280)
        self.assertEqual(usage["contextPromptTokens"], 1200)
        self.assertEqual(usage["runTotalTokens"], 1280)
        final_event = next(event for event in events if event["type"] == "agent_end")
        self.assertEqual(final_event["promptTokens"], 1200)
        self.assertEqual(final_event["totalTokens"], 1280)

    def test_session_store_context_usage_requires_persisted_usage(self) -> None:
        """Verify session context usage comes only from persisted provider usage."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "agent.sqlite3"
            store = AgentSessionStore(path)
            no_usage = store.create_session(
                title="No usage",
                provider="codex",
                model="gpt-test",
                api_mode="codex_responses",
                reasoning_effort="medium",
            )
            store.append_message(session_id=no_usage.id, role="user", content="Hello")
            store.append_message(session_id=no_usage.id, role="assistant", content="No usage metadata.")

            usage_session = store.create_session(
                title="Has usage",
                provider="codex",
                model="gpt-test",
                api_mode="codex_responses",
                reasoning_effort="medium",
            )
            usage = {
                "promptTokens": 1200,
                "completionTokens": 80,
                "totalTokens": 1280,
                "contextPromptTokens": 2400,
                "runTotalTokens": 2560,
            }
            store.append_message(session_id=usage_session.id, role="user", content="Check usage")
            store.append_message(
                session_id=usage_session.id,
                role="assistant",
                content="Done.",
                metadata={"usage": usage},
            )

            self.assertIsNone(store.session_payload(no_usage.id)["contextUsage"])
            payload = store.session_payload(usage_session.id)
            history_rows = store.list_all_sessions()

        expected_usage = {
            "promptTokens": 2400,
            "totalTokens": 2560,
        }
        self.assertEqual(payload["contextUsage"], expected_usage)
        row_by_id = {row.session.id: row for row in history_rows}
        self.assertEqual(row_by_id[usage_session.id].context_usage, expected_usage)

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
            get_quote=lambda instrument_key: quote if instrument_key == "USDT-FUTURES:BTCUSDT" else None,
            get_candles=lambda instrument_key, interval=None: candles if instrument_key == "USDT-FUTURES:BTCUSDT" else tuple(),
            list_instruments=lambda: tuple(),
        )
        tools = build_market_tools(context_provider)

        zero_result = asyncio.run(tools.execute(ToolCall(
            id="call_1",
            name="get_candles",
            arguments={"instrument_key": "USDT-FUTURES:BTCUSDT", "count": 0},
        )))
        large_result = asyncio.run(tools.execute(ToolCall(
            id="call_2",
            name="get_candles",
            arguments={"instrument_key": "USDT-FUTURES:BTCUSDT", "count": 100},
        )))

        self.assertFalse(zero_result.error)
        self.assertEqual(len(json.loads(zero_result.output)), 1)
        self.assertEqual(len(json.loads(large_result.output)), 5)
        self.assertEqual(tools.get("get_candles").parameters["properties"]["count"]["minimum"], 1)
        self.assertEqual(tools.get("get_candles").parameters["properties"]["count"]["maximum"], 50)
        self.assertIn("interval", tools.get("get_candles").parameters["properties"])

    def test_social_feed_tools_search_x_tweets(self) -> None:
        """Verify X search is exposed as a bounded social-feed tool."""
        item = SimpleNamespace(to_payload=lambda: {
            "source": "x_search",
            "externalId": "tweet-1",
            "url": "https://x.com/test/status/tweet-1",
            "author": {"handle": "test"},
            "text": "BTC update",
            "createdAt": "2026-05-10T00:00:00+00:00",
            "metrics": {"likes": 1},
            "urls": [],
            "isRepost": False,
            "repostedBy": None,
        })

        class FakeSocialFeedService:
            def __init__(self) -> None:
                self.calls = []

            async def search_x_tweets(self, *, query: str, count: int, product: str):
                self.calls.append({"query": query, "count": count, "product": product})
                return SimpleNamespace(status="ok", items=[item], error=None)

        service = FakeSocialFeedService()
        tools = build_social_feed_tools(service)
        definition = tools.get("search_x_tweets")

        self.assertIsNotNone(definition)
        self.assertEqual(definition.parameters["required"], ["query"])
        self.assertEqual(definition.parameters["properties"]["product"]["default"], "Latest")

        result = asyncio.run(tools.execute(ToolCall(
            id="call_1",
            name="search_x_tweets",
            arguments={"query": " BTC ", "count": 999, "product": "latest"},
        )))
        payload = json.loads(result.output)

        self.assertFalse(result.error)
        self.assertEqual(service.calls, [{"query": "BTC", "count": 100, "product": "Latest"}])
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["query"], "BTC")
        self.assertEqual(payload["product"], "Latest")
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["items"][0]["source"], "x_search")

    def test_session_store_persists_active_conversation(self) -> None:
        """Verify local agent sessions survive store re-instantiation."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "agent.sqlite3"
            store = AgentSessionStore(path)
            session = store.get_or_create_active_session(
                instrument_key="USDT-FUTURES:BTCUSDT",
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
            payload = reopened.active_session_payload("USDT-FUTURES:BTCUSDT")
            history = reopened.history_for_context(session.id, limit=4)
            refreshed_session = reopened.get_or_create_active_session(
                instrument_key="USDT-FUTURES:BTCUSDT",
                title="AAPL · AAPL",
                provider="codex",
                model="gpt-next",
                api_mode="codex_responses",
                reasoning_effort="high",
            )
            next_session = reopened.create_session(
                instrument_key="USDT-FUTURES:BTCUSDT",
                title="AAPL · AAPL",
                provider="codex",
                model="gpt-test",
                api_mode="codex_responses",
                reasoning_effort="medium",
            )
            previous_payload = reopened.session_payload(session.id)
            history_rows = reopened.list_sessions("USDT-FUTURES:BTCUSDT")
            resumed = reopened.activate_session(
                instrument_key="USDT-FUTURES:BTCUSDT",
                session_id=session.id,
            )
            active_after_delete = reopened.delete_session(
                instrument_key="USDT-FUTURES:BTCUSDT",
                session_id=session.id,
            )
            deleted_payload = reopened.session_payload(session.id)

        self.assertIsNotNone(payload)
        self.assertEqual(payload["session"]["id"], session.id)
        self.assertEqual(payload["session"]["apiMode"], "codex_responses")
        self.assertEqual(payload["session"]["reasoningEffort"], "medium")
        self.assertEqual([message["role"] for message in payload["messages"]], ["user", "assistant", "toolResult"])
        self.assertEqual(payload["messages"][1]["metadata"]["toolCalls"][0]["name"], "get_candles")
        self.assertIsNone(payload["contextUsage"])
        self.assertEqual(history[-1]["role"], "tool")
        self.assertEqual(history[-1]["tool_call_id"], "call_1")
        self.assertEqual(refreshed_session.id, session.id)
        self.assertEqual(refreshed_session.model, "gpt-next")
        self.assertEqual(refreshed_session.reasoning_effort, "high")
        self.assertEqual(next_session.instrument_key, "USDT-FUTURES:BTCUSDT")
        self.assertFalse(previous_payload["session"]["active"])
        self.assertEqual(len(history_rows), 2)
        self.assertEqual(history_rows[1].preview, "How does this K-line window look?")
        self.assertEqual(history_rows[1].message_count, 3)
        self.assertIsNone(history_rows[1].context_usage)
        self.assertEqual(resumed.id, session.id)
        self.assertEqual(active_after_delete.id, next_session.id)
        self.assertIsNone(deleted_payload)


if __name__ == "__main__":
    unittest.main()
