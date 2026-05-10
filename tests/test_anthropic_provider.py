"""Test Anthropic provider request/response helpers."""
import unittest
from unittest.mock import patch

from mytradebot.agent.providers.anthropic import (
    DEFAULT_ANTHROPIC_BASE_URL,
    AnthropicProvider,
    _anthropic_headers,
    _anthropic_model_option,
    _models_endpoint,
    _messages_endpoint,
    _messages_to_anthropic,
    _parse_anthropic_response,
)
from mytradebot.config import AgentConfig, ProviderProfile


class AnthropicProviderTests(unittest.TestCase):
    """Group tests for Anthropic Messages provider support."""

    def test_default_endpoint_matches_official_messages_url(self) -> None:
        """Verify the default official base becomes /v1/messages."""
        self.assertEqual(
            _messages_endpoint(DEFAULT_ANTHROPIC_BASE_URL),
            "https://api.anthropic.com/v1/messages",
        )
        self.assertEqual(
            _models_endpoint(DEFAULT_ANTHROPIC_BASE_URL),
            "https://api.anthropic.com/v1/models",
        )

    def test_custom_endpoint_shapes(self) -> None:
        """Verify custom proxy base URLs still map to Anthropic-style paths."""
        self.assertEqual(
            _messages_endpoint("https://claude-proxy.p1.cn/api"),
            "https://claude-proxy.p1.cn/api/v1/messages",
        )
        self.assertEqual(
            _messages_endpoint("https://claude-proxy.p1.cn/api/v1"),
            "https://claude-proxy.p1.cn/api/v1/messages",
        )
        self.assertEqual(
            _messages_endpoint("https://claude-proxy.p1.cn/api/v1/messages"),
            "https://claude-proxy.p1.cn/api/v1/messages",
        )

    def test_headers_match_proxy_x_api_key_shape(self) -> None:
        """Verify proxy requests use x-api-key without forcing extra headers."""
        with patch.dict("os.environ", {}, clear=True):
            headers = _anthropic_headers("secret", "https://claude-proxy.p1.cn/api/v1/messages")

        self.assertEqual(headers["x-api-key"], "secret")
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertNotIn("anthropic-version", headers)

    def test_provider_uses_configured_connection_settings(self) -> None:
        """Verify provider profile credentials override defaults."""
        config = AgentConfig(
            provider="anthropic",
            api_mode="anthropic_messages",
            model="global.anthropic.claude-opus-4-6-v1",
            provider_profiles={
                "anthropic": ProviderProfile(
                    enabled=True,
                    models=("global.anthropic.claude-opus-4-6-v1",),
                    api_key="configured-secret",
                    base_url="https://example.test/anthropic/v1/",
                )
            },
        )

        provider = AnthropicProvider(config)

        self.assertEqual(provider._api_key, "configured-secret")
        self.assertEqual(provider._base_url, "https://example.test/anthropic/v1")

    def test_messages_convert_tool_loop_history(self) -> None:
        """Verify OpenAI-style loop history becomes Anthropic tool blocks."""
        system, messages = _messages_to_anthropic(
            [
                {"role": "system", "content": "system prompt"},
                {"role": "user", "content": "Check BTC."},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "toolu_1",
                            "type": "function",
                            "function": {
                                "name": "get_quote",
                                "arguments": "{\"instrument_key\":\"bitget:BTCUSDT\"}",
                            },
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": "toolu_1",
                    "content": "{\"price\":65000}",
                },
            ]
        )

        self.assertEqual(system, "system prompt")
        self.assertEqual(messages[0], {"role": "user", "content": "Check BTC."})
        self.assertEqual(messages[1]["role"], "assistant")
        self.assertEqual(messages[1]["content"][0]["type"], "tool_use")
        self.assertEqual(messages[1]["content"][0]["name"], "get_quote")
        self.assertEqual(messages[2]["role"], "user")
        self.assertEqual(messages[2]["content"][0]["type"], "tool_result")
        self.assertEqual(messages[2]["content"][0]["tool_use_id"], "toolu_1")

    def test_parse_response_extracts_text_and_tool_use(self) -> None:
        """Verify Anthropic message content maps into the shared ChatResponse."""
        response = _parse_anthropic_response(
            {
                "content": [
                    {"type": "text", "text": "Need data."},
                    {
                        "type": "tool_use",
                        "id": "toolu_2",
                        "name": "get_candles",
                        "input": {"instrument_key": "USDT-FUTURES:BTCUSDT"},
                    },
                ],
                "stop_reason": "tool_use",
                "usage": {"input_tokens": 10, "output_tokens": 5},
            }
        )

        self.assertEqual(response.content, "Need data.")
        self.assertEqual(response.finish_reason, "tool_use")
        self.assertEqual(response.tool_calls[0].id, "toolu_2")
        self.assertEqual(response.tool_calls[0].arguments["instrument_key"], "USDT-FUTURES:BTCUSDT")
        self.assertEqual(response.usage["prompt_tokens"], 10)
        self.assertEqual(response.usage["completion_tokens"], 5)

    def test_static_model_option_infers_context_window(self) -> None:
        """Verify fallback model metadata still exposes a usable context window."""
        opus = _anthropic_model_option("global.anthropic.claude-opus-4-6-v1")
        sonnet = _anthropic_model_option("global.anthropic.claude-sonnet-4-5-v1")

        self.assertEqual(opus["contextWindow"], 1_000_000)
        self.assertEqual(sonnet["contextWindow"], 200_000)


if __name__ == "__main__":
    unittest.main()
