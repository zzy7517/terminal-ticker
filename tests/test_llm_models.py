"""Test agent model configuration resolution."""
import unittest

from terminal_ticker.config import AgentConfig
from terminal_ticker.llm_models import (
    CODEX_API_MODE,
    DEFAULT_CODEX_BASE_URL,
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
        self.assertEqual(profile.base_url, DEFAULT_CODEX_BASE_URL)
        self.assertFalse(profile.base_url_configured)
        self.assertTrue(profile.supports_reasoning)

    def test_resolve_configured_codex_profile(self) -> None:
        """Verify explicit model settings survive profile resolution."""
        profile = resolve_agent_model(
            AgentConfig(
                model="gpt-5.4",
                base_url="https://example.test/codex/",
                reasoning_effort="high",
            )
        )

        self.assertEqual(profile.model, "gpt-5.4")
        self.assertEqual(profile.base_url, "https://example.test/codex")
        self.assertTrue(profile.base_url_configured)
        self.assertEqual(profile.reasoning_effort, "high")

    def test_codex_model_aliases(self) -> None:
        """Verify Codex aliases map to the default model."""
        self.assertEqual(normalize_model("codex", "default"), DEFAULT_CODEX_MODEL)
        self.assertEqual(normalize_model("codex", "fast"), DEFAULT_CODEX_MODEL)


if __name__ == "__main__":
    unittest.main()
