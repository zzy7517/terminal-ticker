"""Test agent model configuration resolution."""
import unittest

from mytradebot.config import AgentConfig
from mytradebot.config.agent_models import (
    ANTHROPIC_MESSAGES_API_MODE,
    CODEX_API_MODE,
    DEFAULT_ANTHROPIC_MODEL,
    DEFAULT_CODEX_MODEL,
    normalize_model,
    resolve_agent_model,
)


class LlmModelTests(unittest.TestCase):
    """Group tests for LLM model configuration."""

    def test_resolve_default_codex_profile(self) -> None:
        """Verify default agent config resolves to a Codex Responses profile."""
        profile = resolve_agent_model(AgentConfig())

        self.assertEqual(profile.provider, "codex")
        self.assertEqual(profile.api_mode, CODEX_API_MODE)
        self.assertEqual(profile.model, DEFAULT_CODEX_MODEL)
        self.assertTrue(profile.supports_reasoning)

    def test_resolve_configured_codex_profile(self) -> None:
        """Verify explicit model settings survive profile resolution."""
        profile = resolve_agent_model(
            AgentConfig(
                model="gpt-5.4",
                reasoning_effort="high",
            )
        )

        self.assertEqual(profile.model, "gpt-5.4")
        self.assertEqual(profile.reasoning_effort, "high")

    def test_codex_model_aliases(self) -> None:
        """Verify Codex aliases map to the default model."""
        self.assertEqual(normalize_model("codex", "default"), DEFAULT_CODEX_MODEL)
        self.assertEqual(normalize_model("codex", "fast"), DEFAULT_CODEX_MODEL)

    def test_resolve_anthropic_profile(self) -> None:
        """Verify Anthropic config resolves to a Messages profile."""
        profile = resolve_agent_model(
            AgentConfig(provider="anthropic", api_mode="anthropic_messages", model="")
        )

        self.assertEqual(profile.provider, "anthropic")
        self.assertEqual(profile.api_mode, ANTHROPIC_MESSAGES_API_MODE)
        self.assertEqual(profile.model, DEFAULT_ANTHROPIC_MODEL)
        self.assertFalse(profile.supports_reasoning)


if __name__ == "__main__":
    unittest.main()
