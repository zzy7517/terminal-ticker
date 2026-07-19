# ADR-0003: Agent Context and Direct Chat identity

- Status: superseded
- Date: 2026-07-18
- Superseded-by: `0004-agent-context-and-direct-message-identity.md`
- Supersedes: the parts of ADR-0001 that treated a Session as the user-facing conversation identity

> **Superseded.** The multi Direct Chat / New Chat / `direct-chat` ChatTarget model below is historical.
> Follow ADR-0004 and `docs/raft-style-agent-team-design.md` instead.

## Decision (historical)

Tradex exposes one stable Direct Message Entry per Agent. A Human can create multiple Direct Chats under that entry, but only one Chat is active and writable. A Chat owns one or more Runtime Session generations; a Native Session remains a Runtime-private resume handle.

`AgentContextManager` is the trusted identity boundary for:

- ensuring the active Chat for an Agent;
- validating `agentId + chatId` ownership;
- creating New Chat only while the Agent is idle;
- binding and removing Runtime Session generations;
- indexing persisted Pi and Claude Sessions as imported Chats.

Channel-specific operations continue to use `channelId`. `ChatTarget` is not a replacement for Channel: it is used only when one generic feature must reference either `{ kind: "channel", channelId }` or `{ kind: "direct-chat", agentId, chatId }`. Phase 1 uses it for Chat events, Saved, and Pinned references; future Tasks must reuse the same boundary.

Shared Channel messages remain authoritative SQLite facts. They are never appended directly to another Agent's private Runtime Session.

## Consequences (historical)

- New Chat creates a clean product conversation without duplicating the Agent in the sidebar.
- Existing Session files are indexed, not migrated or rewritten.
- Historical Chats remain readable but are not reopened for writes.
- Runtime context rotation can add a Session generation without changing the Chat ID.
- Phase 2 Channel activation can reuse Agent Context without inventing a Channel-owned model context.
