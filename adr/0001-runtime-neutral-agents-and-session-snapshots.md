# Keep Agents runtime-neutral and snapshot them into Sessions

Tradex stores each Agent as a runtime-tagged configuration independent of Pi SDK, even though `pi` is initially the only Runtime, so future Claude Code or Codex execution backends do not require redefining Agent identity. A Session is kept in memory until its first user message, then persists an immutable snapshot of the selected Agent alongside the conversation; later Agent edits affect new Sessions only, preserving reproducible behavior within existing conversations.

## Consequences

The built-in Default Agent remains available without local configuration and may be overridden but not removed. Existing Sessions without Agent metadata belong to the Default Agent, and model changes made inside a Session remain Session-local.
